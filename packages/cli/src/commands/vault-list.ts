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
 *
 * Phase 4a (BE-350, D3, D7): EVM rows are read too, over their OWN endpoint: `--evm-rpc-url`, else
 * `CANDLE_EVM_RPC_URL`, else the built-in Hood RPC. A Solana `--rpc-url` is never sent an EVM
 * address, and the EVM read prints its host on stderr before the first request, the same rule as
 * the Solana line. The read is `eth_chainId`, then `eth_getBalance` per address, then, on chain id
 * 4663 only, USDG's `balanceOf` per address.
 *
 * BE-355 (D1 to D3): the Solana read resolves through `solana-endpoint.ts` (`--rpc-url`, else
 * `CANDLE_SOLANA_RPC_URL`, else the profile's `rpcUrl`, else the public endpoint), prints the host
 * line (and, once per machine, the public-endpoint notice) before the first request, and stops
 * sending chunks after one is still rate-limited after the client's retry: those addresses read
 * `?`, exit 3, and the stderr line carries `RPC_RATE_LIMITED` and the fix.
 */
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import {
  createEvmRpc,
  DEFAULT_HOOD_RPC_URL,
  EVM_RPC_URL_ENV,
  formatUnits,
  HOOD_CHAIN_ID,
  HOOD_USDG_ADDRESS,
  HOOD_USDG_DECIMALS,
  NATIVE_DECIMALS,
  resolveEvmRpcUrl,
  rpcHostOf,
} from "../evm-lite"
import { renderTable } from "../render"
import { describeRpcFailure, openSolanaClient, rateLimitedReadFailure, type SolanaClient } from "../solana-endpoint"
import { isRateLimited } from "../solana-lite"
import type { KeyEntry } from "../vault/format"
import { readVaultRaw } from "../vault/store"
import {
  describeEntry,
  missingVault,
  refuseEnvPassphrase,
  requirePromptStreams,
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
 * an HTTP failure or an RPC error, so a throw discards every chunk that call had already fetched.
 * `list` therefore cuts the set up itself: a throw costs that chunk only, and the chunks after it
 * are still issued, so the request count is `ceil(N / 100)` at the call site rather than a second
 * counter here. The one exception (BE-355, D3): a chunk that is still rate-limited after the
 * client's own single retry stops the read, because pounding a rate-limited endpoint only
 * lengthens the wait; the remaining addresses join `unavailable` without a request, and the
 * failure names `RPC_RATE_LIMITED` and the fix.
 */
async function readLamports(
  addresses: string[],
  solana: SolanaClient,
  ctx: CommandContext,
): Promise<{ lamports: Map<string, bigint>; unavailable: string[]; failure?: string }> {
  const { rpc } = solana
  const lamports = new Map<string, bigint>()
  const unavailable: string[] = []
  let failure: string | undefined
  let rateLimited = false
  for (let at = 0; at < addresses.length; at += CHUNK) {
    const chunk = addresses.slice(at, at + CHUNK)
    if (rateLimited) {
      unavailable.push(...chunk)
      continue
    }
    try {
      const accounts = await rpc.getMultipleAccounts(chunk)
      // A never-funded address comes back null, which is zero.
      for (const [i, address] of chunk.entries()) lamports.set(address, accounts[i]?.lamports ?? 0n)
    } catch (error) {
      unavailable.push(...chunk)
      if (isRateLimited(error)) {
        rateLimited = true
        failure ??= rateLimitedReadFailure(ctx, error)
      } else failure ??= describeRpcFailure(error)
    }
  }
  return { lamports, unavailable, ...(failure === undefined ? {} : { failure }) }
}

interface EvmRead {
  host: string
  chainId: bigint | undefined
  requests: number
  wei: Map<string, bigint>
  usdg: Map<string, bigint>
  unavailable: string[]
  failure?: string
}

/**
 * The EVM read (Phase 4a, D7): the chain id first, then the native balance per address, then, when
 * the chain is Hood, USDG per address. A failed call marks that address unavailable and the read
 * goes on; a chain id that cannot be read makes every row unavailable, since nothing else is asked.
 */
async function readEvmBalances(addresses: string[], rpcUrl: string, fetchFn: typeof fetch): Promise<EvmRead> {
  const rpc = createEvmRpc(rpcUrl, fetchFn)
  const read: EvmRead = {
    host: rpcHostOf(rpcUrl),
    chainId: undefined,
    requests: 0,
    wei: new Map(),
    usdg: new Map(),
    unavailable: [],
  }
  try {
    read.requests += 1
    read.chainId = await rpc.chainId()
  } catch (error) {
    read.unavailable.push(...addresses)
    read.failure = error instanceof Error ? error.message : String(error)
    return read
  }
  const hood = read.chainId === BigInt(HOOD_CHAIN_ID)
  for (const address of addresses) {
    try {
      read.requests += 1
      read.wei.set(address, await rpc.getBalance(address))
      if (hood) {
        read.requests += 1
        read.usdg.set(address, await rpc.erc20BalanceOf(HOOD_USDG_ADDRESS, address))
      }
    } catch (error) {
      read.wei.delete(address)
      read.usdg.delete(address)
      read.unavailable.push(address)
      read.failure ??= error instanceof Error ? error.message : String(error)
    }
  }
  return read
}

/** How many requests the EVM read will make, said before the first one: 1 + N, or 1 + 2N on Hood. */
function evmRequestsPlanned(count: number): string {
  return `${1 + count} to ${1 + 2 * count}`
}

export async function vaultList(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--keystore", "--rpc-url", "--evm-rpc-url"],
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
  if (!balances && parsed.values["--evm-rpc-url"] !== undefined) {
    return usage(ctx, "--evm-rpc-url has no effect without --balances; vault list is offline by default.")
  }
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const path = resolvedVault.path

  // BE-355 (D1): --rpc-url, else CANDLE_SOLANA_RPC_URL, else the profile's rpcUrl, else the public
  // endpoint, resolved and validated before the prompt. The vault list spec's D5 item 2 is amended
  // to allow the default; the disclosure before the first request (D2) is what mitigates it.
  let solanaClient: SolanaClient | undefined
  if (balances) {
    const resolved = await openSolanaClient(ctx, parsed.values["--rpc-url"])
    if ("error" in resolved) return usage(ctx, resolved.error)
    solanaClient = resolved
  }
  // Phase 4a (D3): the EVM endpoint, with the built-in Hood RPC as the one default this command
  // has. `--evm-rpc-url`, else `CANDLE_EVM_RPC_URL`, else Hood; the Solana `--rpc-url` is never it.
  // A blank value is unset. Checked before unlock, the same way the flag was.
  const evmRpc = resolveEvmRpcUrl(parsed.values["--evm-rpc-url"], deps.env[EVM_RPC_URL_ENV], "--evm-rpc-url")
  if (balances && "error" in evmRpc) return usage(ctx, evmRpc.error)
  const evmRpcUrl = "url" in evmRpc ? evmRpc.url : DEFAULT_HOOD_RPC_URL
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
    const rpcHost = solanaClient?.endpoint.host
    if (balances && solana.length > 0 && solanaClient !== undefined) {
      // D2's host line (and the notice, once) first, then this command's own sentence.
      await solanaClient.disclose()
      // The host, never the URL: a provider URL can carry an API key in its path or query. On
      // stderr in both modes, so `--json` stdout stays exactly one JSON value.
      deps.stderr.write(
        `Reading SOL for ${solana.length} addresses from ${rpcHost}, in ${requests} ${requests === 1 ? "request" : "requests"}. That endpoint sees all ${solana.length} together.\n`,
      )
    }

    let lamports = new Map<string, bigint>()
    let unavailable: string[] = []
    let failure: string | undefined
    if (balances && solana.length > 0 && solanaClient !== undefined) {
      const outcome = await readLamports(
        solana.map((entry) => entry.address),
        solanaClient,
        ctx,
      )
      lamports = outcome.lamports
      unavailable = outcome.unavailable
      failure = outcome.failure
    }
    const solanaComplete = unavailable.length === 0
    const totalLamports = [...lamports.values()].reduce((sum, value) => sum + value, 0n)
    // D11: the RPC's own message, on stderr in both modes. `--json` stdout stays one JSON value,
    // and an agent that exits 3 can still tell a rate limit from an outage.
    if (!solanaComplete) {
      deps.stderr.write(
        `${unavailable.length} ${unavailable.length === 1 ? "address" : "addresses"} could not be read: ${failure ?? "the RPC did not answer"}. Narrow with a filter, or use your own endpoint with --rpc-url.\n`,
      )
    }

    // Phase 4a: the EVM rows, over the EVM endpoint only, after the Solana read so the two stderr
    // lines appear in the order the reads happen.
    const evm = balances ? matched.filter((entry) => entry.chain === "evm") : []
    let evmRead: EvmRead | undefined
    if (evm.length > 0) {
      const host = rpcHostOf(evmRpcUrl)
      deps.stderr.write(
        `Reading ETH (and USDG when the chain is Hood) for ${evm.length} EVM ${evm.length === 1 ? "address" : "addresses"} from ${host}, in ${evmRequestsPlanned(evm.length)} requests. That endpoint sees all ${evm.length} together.\n`,
      )
      evmRead = await readEvmBalances(
        evm.map((entry) => entry.address),
        evmRpcUrl,
        deps.fetch,
      )
      if (evmRead.unavailable.length > 0) {
        deps.stderr.write(
          `${evmRead.unavailable.length} EVM ${evmRead.unavailable.length === 1 ? "address" : "addresses"} could not be read: ${evmRead.failure ?? "the RPC did not answer"}. Narrow with a filter, or use your own endpoint with --evm-rpc-url.\n`,
        )
      }
    }
    const hood = evmRead?.chainId === BigInt(HOOD_CHAIN_ID)
    const complete = solanaComplete && (evmRead === undefined || evmRead.unavailable.length === 0)

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
            // Phase 4a: additive and optional, only under --balances, only on an EVM entry. `wei`
            // is the native balance as a string; `usdgRaw` is present only when the chain id
            // answered was Hood's. `null` means the address's read failed.
            ...(balances && entry.chain === "evm"
              ? {
                  wei: evmRead?.wei.get(entry.address)?.toString() ?? null,
                  ...(hood ? { usdgRaw: evmRead?.usdg.get(entry.address)?.toString() ?? null } : {}),
                }
              : {}),
          }
        }),
        ...(balances && rpcHost !== undefined
          ? {
              balances: {
                rpcHost,
                requests,
                complete: solanaComplete,
                totalLamports: totalLamports.toString(),
                unavailable,
              },
            }
          : {}),
        ...(evmRead !== undefined
          ? {
              evmBalances: {
                rpcHost: evmRead.host,
                chainId: evmRead.chainId === undefined ? null : Number(evmRead.chainId),
                requests: evmRead.requests,
                complete: evmRead.unavailable.length === 0,
                unavailable: evmRead.unavailable,
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
    // Phase 4a: an ETH column when an EVM row was read, named by the chain when it is not Hood so
    // ETH on another chain is not mistaken for Hood ETH (D1), and a USDG column on Hood only.
    const evmColumns = evmRead !== undefined
    const nativeHeader = hood || evmRead?.chainId === undefined ? "ETH" : `ETH@${evmRead.chainId}`
    if (evmColumns) headers.push(nativeHeader)
    if (evmColumns && hood) headers.push("USDG")
    const rows = matched.map((entry) => {
      const row = [entry.address, entry.label || "(none)", entry.role, entry.derivation?.path ?? "-"]
      if (balances) {
        const held = lamports.get(entry.address)
        // `-` for a non-Solana entry, which was never in the batch; `?` for a Solana address whose
        // chunk threw. The two are different facts and read differently.
        row.push(entry.chain !== "solana" ? "-" : held === undefined ? "?" : formatSol(held))
      }
      if (evmColumns) {
        const wei = evmRead?.wei.get(entry.address)
        row.push(entry.chain !== "evm" ? "-" : wei === undefined ? "?" : formatUnits(wei, NATIVE_DECIMALS))
        if (hood) {
          const usdg = evmRead?.usdg.get(entry.address)
          row.push(entry.chain !== "evm" ? "-" : usdg === undefined ? "?" : formatUnits(usdg, HOOD_USDG_DECIMALS))
        }
      }
      return row
    })
    deps.stdout.write(`\n${renderTable(headers, rows)}\n`)

    if (balances) {
      // The count is Solana keys: an `evm` match is in the match line above and not in this one.
      deps.stdout.write(
        solanaComplete
          ? `\ntotal  ${formatSol(totalLamports)} SOL across ${solana.length} keys\n`
          : `\ntotal  ${formatSol(totalLamports)} SOL across ${solana.length - unavailable.length} of ${solana.length} keys read\n`,
      )
    }
    if (evmRead !== undefined) {
      const totalWei = [...evmRead.wei.values()].reduce((sum, value) => sum + value, 0n)
      const readCount = evm.length - evmRead.unavailable.length
      const chain = evmRead.chainId === undefined ? "an unread chain" : hood ? "Hood" : `chain id ${evmRead.chainId}`
      deps.stdout.write(
        `total  ${formatUnits(totalWei, NATIVE_DECIMALS)} ${nativeHeader} across ${readCount}${readCount === evm.length ? "" : ` of ${evm.length}`} EVM keys${readCount === evm.length ? "" : " read"} on ${chain}\n`,
      )
      if (hood) {
        const totalUsdg = [...evmRead.usdg.values()].reduce((sum, value) => sum + value, 0n)
        deps.stdout.write(`total  ${formatUnits(totalUsdg, HOOD_USDG_DECIMALS)} USDG across those keys\n`)
      }
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
