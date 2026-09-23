/**
 * BE-274 (D4 to D11): `candle vault list`.
 *
 * One line per key -- address, label, role, derivation -- against `vault status --unlock`'s five
 * lines each, which is about 1,500 lines for a 304-key vault. `status` is the report about the
 * vault FILE (envelopes, factors, generation, the sidecar, the backup nag); the keys belong here
 * (D9). `status` keeps printing them in this slice and gains one line pointing at this command.
 *
 * It opens the vault and closes it. No `commitVault`, no advisory lock, no key blob, no root: an
 * ordinary open decrypts the index and nothing else, and the index is the whole of what a listing
 * needs.
 *
 * Offline by default. `--balances` adds SOL and only SOL, over the matched set only, through
 * `getMultipleAccounts` and no other RPC method (D8). That is an invariant rather than a default:
 * tokens are `getTokenAccountsByOwner`, one request per owner per token program, which is 608
 * requests for the same vault the SOL read does in four.
 */
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { renderTable } from "../render"
import { createSolanaRpc } from "../solana-lite"
import type { KeyEntry } from "../vault/format"
import { readVaultRaw } from "../vault/store"
import {
  describeEntry,
  missingVault,
  refuseEnvPassphrase,
  requirePromptStreams,
  rpcUrlFrom,
  runVaultCommand,
  unlockInteractively,
  usage,
  vaultPathFor,
  writeJson,
} from "./vault-support"

/** The RPC caps one `getMultipleAccounts` request at 100 addresses, so one chunk is one request. */
const CHUNK = 100

const LAMPORTS_PER_SOL = 1_000_000_000n

/**
 * Lamports as SOL: the nine-decimal quotient in integer arithmetic, trimmed of trailing zeros, and
 * `0` exactly rather than `0.000000000`. Never through a float -- a `u64` of lamports does not
 * survive `Number` -- which is also why `--json` carries `lamports` as a string.
 *
 * Exported so the four cells §4.3 pins can be asserted without a vault or an RPC.
 */
export function formatSol(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL
  const fraction = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "")
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`
}

/**
 * The SOL read, one `getMultipleAccounts` call per chunk of 100 (D11).
 *
 * `getMultipleAccounts` loops over 100-address chunks INSIDE the client and `call()` throws on
 * HTTP 429 or an RPC error, so a throw discards every chunk that call had already fetched. `list`
 * therefore cuts the set up itself: a throw costs that chunk only, is not retried -- the chunk
 * failed because an endpoint rate-limited a burst, and an immediate retry is the burst again --
 * and the chunks after it are still issued. Every chunk is issued, so the request count is
 * `ceil(N / 100)` at the call site rather than a second counter here.
 */
async function readLamports(
  addresses: string[],
  rpcUrl: string,
  fetchFn: typeof fetch,
): Promise<{ lamports: Map<string, bigint>; unavailable: string[]; failure?: string }> {
  const rpc = createSolanaRpc(rpcUrl, fetchFn)
  const lamports = new Map<string, bigint>()
  const unavailable: string[] = []
  let failure: string | undefined
  for (let at = 0; at < addresses.length; at += CHUNK) {
    const chunk = addresses.slice(at, at + CHUNK)
    try {
      const accounts = await rpc.getMultipleAccounts(chunk)
      // A never-funded address comes back null, which is zero.
      for (const [i, address] of chunk.entries()) lamports.set(address, accounts[i]?.lamports ?? 0n)
    } catch (error) {
      unavailable.push(...chunk)
      failure ??= error instanceof Error ? error.message : String(error)
    }
  }
  return { lamports, unavailable, ...(failure === undefined ? {} : { failure }) }
}

export async function vaultList(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--keystore", "--rpc-url"],
    booleanFlags: ["--balances", "--accept-older-copy"],
    pathFlags: ["--keystore"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length > 1) return usage(ctx, `Unexpected argument: ${parsed.positionals[1]}`)
  if (!refuseEnvPassphrase(ctx)) return 1

  const { deps } = ctx
  const filter = parsed.positionals[0]
  const balances = parsed.booleans.has("--balances")
  // A flag that costs nothing here is a flag whose owner misunderstood the command, so it is said
  // rather than ignored: `list` makes no network call without `--balances`.
  if (!balances && parsed.values["--rpc-url"] !== undefined) {
    return usage(ctx, "--rpc-url has no effect without --balances; vault list is offline by default.")
  }
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const path = resolvedVault.path

  // The operator's own endpoint or nothing: --rpc-url, else CANDLE_SOLANA_RPC_URL, else a usage
  // refusal (D5). No default endpoint is added, because a default endpoint is a default recipient.
  let rpcUrl: string | undefined
  if (balances) {
    const resolved = rpcUrlFrom(ctx, parsed)
    if (typeof resolved !== "string") return usage(ctx, resolved.error)
    rpcUrl = resolved
  }
  // D7: the prompt reads stdin and writes stderr, so those are the two streams that must be a
  // terminal. stdout is the payload channel and may be a file.
  if (!requirePromptStreams(ctx, "vault list")) return 1

  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await readVaultRaw(path)
    if (raw === null) throw missingVault(ctx, resolvedVault)
    const vault = hold(
      (await unlockInteractively(ctx, path, raw, { acceptOlderCopy: parsed.booleans.has("--accept-older-copy") }))
        .vault,
    )
    const all = vault.index.entries
    const matched = filter === undefined ? all : all.filter((entry) => matches(entry, filter))

    // The batch is the MATCHED Solana set, in index order: an address the filter did not keep is
    // never sent, which is what makes a filtered read the smaller disclosure as well as the
    // cheaper one (D5). An `evm` entry is not a Solana address and is not in it (D8, §4.4).
    const solana = balances ? matched.filter((entry) => entry.chain === "solana") : []
    const requests = Math.ceil(solana.length / CHUNK)
    const rpcHost = rpcUrl === undefined ? undefined : new URL(rpcUrl).host
    if (balances && solana.length > 0 && rpcHost !== undefined) {
      // The host, never the URL: a provider URL can carry an API key in its path or query. On
      // stderr in both modes, so `--json` stdout stays exactly one JSON value.
      deps.stderr.write(
        `Reading SOL for ${solana.length} addresses from ${rpcHost}, in ${requests} ${requests === 1 ? "request" : "requests"}. That endpoint sees all ${solana.length} together.\n`,
      )
    }

    let lamports = new Map<string, bigint>()
    let unavailable: string[] = []
    let failure: string | undefined
    if (balances && solana.length > 0 && rpcUrl !== undefined) {
      const outcome = await readLamports(
        solana.map((entry) => entry.address),
        rpcUrl,
        deps.fetch,
      )
      lamports = outcome.lamports
      unavailable = outcome.unavailable
      failure = outcome.failure
    }
    const complete = unavailable.length === 0
    const totalLamports = [...lamports.values()].reduce((sum, value) => sum + value, 0n)
    // D11: the RPC's own message, on stderr in both modes. `--json` stdout stays one JSON value,
    // and an agent that exits 3 can still tell a rate limit from an outage.
    if (!complete) {
      deps.stderr.write(
        `${unavailable.length} ${unavailable.length === 1 ? "address" : "addresses"} could not be read: ${failure ?? "the RPC did not answer"}. Narrow with a filter, or use your own endpoint with --rpc-url.\n`,
      )
    }

    if (ctx.json) {
      writeJson(deps, {
        ok: true,
        path,
        total: all.length,
        matched: matched.length,
        ...(filter === undefined ? {} : { filter }),
        entries: matched.map((entry) => {
          const held = lamports.get(entry.address)
          return {
            ...describeEntry(entry),
            // Additive and optional: only under --balances, only on a Solana entry. A string,
            // because lamports exceed Number.MAX_SAFE_INTEGER and the `--json` contract has one shot
            // at this. `null` means one thing: a Solana address whose chunk failed.
            ...(balances && entry.chain === "solana" ? { lamports: held === undefined ? null : held.toString() } : {}),
          }
        }),
        ...(balances && rpcHost !== undefined
          ? {
              balances: {
                rpcHost,
                requests,
                complete,
                totalLamports: totalLamports.toString(),
                unavailable,
              },
            }
          : {}),
      })
      return complete ? 0 : 3
    }

    if (matched.length === 0 && filter !== undefined) {
      // Exit 0: an empty result is an answer, not a refusal. `if candle vault list foo` must not
      // come to mean "the vault is broken" in a script that meant "is there a key called foo".
      deps.stdout.write(
        `No key matches "${filter}". ${all.length} keys in this vault; candle vault list with no filter lists them.\n`,
      )
      return 0
    }

    deps.stdout.write(
      filter === undefined
        ? `${all.length} keys in ${path}\n`
        : `${matched.length} of ${all.length} keys match "${filter}" in ${path}\n`,
    )
    const headers = ["ADDRESS", "LABEL", "ROLE", "DERIVATION"]
    if (balances) headers.push("SOL")
    const rows = matched.map((entry) => {
      const row = [entry.address, entry.label || "(none)", entry.role, entry.derivation?.path ?? "-"]
      if (balances) {
        const held = lamports.get(entry.address)
        // `-` for a non-Solana entry, which was never in the batch; `?` for a Solana address whose
        // chunk threw. The two are different facts and read differently.
        row.push(entry.chain !== "solana" ? "-" : held === undefined ? "?" : formatSol(held))
      }
      return row
    })
    deps.stdout.write(`\n${renderTable(headers, rows)}\n`)

    if (balances) {
      // The count is Solana keys: an `evm` match is in the match line above and not in this one.
      deps.stdout.write(
        complete
          ? `\ntotal  ${formatSol(totalLamports)} SOL across ${solana.length} keys\n`
          : `\ntotal  ${formatSol(totalLamports)} SOL across ${solana.length - unavailable.length} of ${solana.length} keys read\n`,
      )
    }
    // Exit 3 is the shipped meaning of "pending or partial" (`vault/errors.ts`; `wallets revoke`
    // already exits 3 with a success-shaped document on stdout). The listing succeeded; part of an
    // optional read did not, and that is not a refusal and mints no new error code.
    return complete ? 0 : 3
  })
}

/**
 * D10's filter: a case-insensitive substring over label and address. No globbing and no regex -- a
 * regex over a list of addresses is a footgun with no use case here, and a glob would make `*`
 * shell-dependent. Label and address together because an operator who types a label prefix and one
 * who pastes the first eight characters of an address are asking the same question.
 */
function matches(entry: KeyEntry, filter: string): boolean {
  const needle = filter.toLowerCase()
  return entry.label.toLowerCase().includes(needle) || entry.address.toLowerCase().includes(needle)
}
