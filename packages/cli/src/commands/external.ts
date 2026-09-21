/**
 * Ember Phase 3 PR F (BE-226, R6, P3-AD-13): `candle external new | list | sweep`.
 *
 * An external wallet is a vault-derived key on its own branch (`m/44'/501'/n'/2'`, counter
 * `hd.nextIndex.solanaExternal`), never delegated to Privy and never registered with Candle. It is
 * the key `candle sign` signs with for outside tools, so the vault stays cold (P3-AD-2) and TEE
 * wallets stay on Candle's rails. It is funded from the vault by `candle vault fund <external>` and
 * swept back by `candle external sweep <external> --to <vault>`, both local, both decoded and
 * displayed, both confirmed by the typed last six of the DESTINATION.
 *
 * `external new` is an ALLOCATION (CC-11), so it refuses in a restored vault with the same code as
 * `vault new-key` and names the same exit. Recovered external keys keep working for everything that
 * is not allocation, because moving funds off a key of unknown history is the correct move.
 *
 * The first external allocation is also what moves a `version: 2` vault to `version: 3` (R6): the
 * commit below carries an external entry, and `commitVault` writes the version the index needs.
 */
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { createSolanaRpc } from "../solana-lite"
import { assertRecoverableFactorExists } from "../vault/domains"
import { VaultError } from "../vault/errors"
import type { KeyEntry } from "../vault/format"
import { DERIVATION_SCHEME, deriveSolanaKey, solanaExternalPath } from "../vault/hd"
import { wipe } from "../vault/hygiene"
import { sweepEverythingTo } from "../vault/local-sweep"
import { findVaultRoleEntry } from "../vault/promote-support"
import { commitVault, decryptKey, decryptRoot, freshKeyId, sealKeyBlob } from "../vault/store"
import { nextAllocatableIndex, verifyWritten } from "./vault-new-key"
import {
  confirmLastSix,
  describeRole,
  findExternalEntry,
  refuseEnvPassphrase,
  requireTty,
  requireVaultRaw,
  rpcUrlFrom,
  runVaultCommand,
  unlockInteractively,
  usage,
  vaultPathFor,
  writeJson,
} from "./vault-support"

/** The refusal every external command gives when the named entry is not an external wallet. */
export function requireExternalEntry(index: Parameters<typeof findExternalEntry>[0], named: string): KeyEntry {
  const entry = findExternalEntry(index, named)
  if (entry !== undefined) return entry
  const other = index.entries.find((candidate) => candidate.label === named || candidate.address === named)
  throw new VaultError(
    "VAULT_INDEX_INVALID",
    other === undefined
      ? `No external wallet in this vault matches ${named}.`
      : `${named} is ${describeRole(other)}, not an external wallet.`,
    { suggestion: "List them: candle external list. Create one: candle external new --label <name>", exitCode: 2 },
  )
}

export async function externalNew(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--keystore", "--label"],
    booleanFlags: ["--accept-older-copy"],
    pathFlags: ["--keystore"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length > 0) return usage(ctx, `Unexpected argument: ${parsed.positionals[0]}`)
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "external new")) return 1

  const { deps } = ctx
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const path = resolvedVault.path

  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await requireVaultRaw(ctx, resolvedVault)
    const opened = await unlockInteractively(ctx, path, raw, {
      acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
    })
    const vault = hold(opened.vault)

    assertRecoverableFactorExists(vault.file.envelopes)

    // CC-11: allocation claims an index as new, and a restored vault cannot know its boundary. The
    // same code and the same exit as `vault new-key` and `vault promote --from`.
    if (vault.index.hd.discovery !== undefined) {
      throw new VaultError(
        "VAULT_ALLOCATION_BOUNDARY_UNKNOWN",
        "This vault was built by `vault restore --phrase`, so the highest index its root ever allocated was never established and claiming a new external index could re-derive an address that is already in use elsewhere.",
        {
          suggestion:
            "Create a second vault with a fresh root (`candle vault init`) and move the funds across with `candle vault transfer`. Recovered external keys still fund, sweep and sign here; only allocation is refused.",
        },
      )
    }

    const index = nextAllocatableIndex(
      vault.index.hd.nextIndex.solanaExternal,
      vault.index.hd.exposedIndexes.solanaExternal,
    )
    const derivationPath = solanaExternalPath(index)
    const label = parsed.values["--label"] ?? `external-${index}`
    if (vault.index.entries.some((entry) => entry.label === label)) {
      return usage(ctx, `A key labelled ${label} already exists in this vault; choose another --label.`)
    }

    const root = await decryptRoot(vault)
    let address: string
    let keyId: string
    let blob: Awaited<ReturnType<typeof sealKeyBlob>>
    try {
      const derived = await deriveSolanaKey(root, derivationPath)
      try {
        address = derived.address
        keyId = freshKeyId()
        blob = await sealKeyBlob(vault, keyId, derived.secret64)
      } finally {
        wipe(derived.secret64)
      }
    } finally {
      wipe(root)
    }

    const entry: KeyEntry = {
      id: keyId,
      chain: "solana",
      curve: "ed25519",
      address,
      label,
      createdAt: new Date(deps.now()).toISOString(),
      role: "external",
      origin: "derived",
      derivation: { scheme: DERIVATION_SCHEME, path: derivationPath },
      exposure: { everRemoteExposed: false, everExported: false },
    }
    const wasVersion2 = vault.file.version === 2
    const written = await commitVault(
      vault,
      {
        index: {
          hd: { ...vault.index.hd, nextIndex: { ...vault.index.hd.nextIndex, solanaExternal: index + 1 } },
          entries: [...vault.index.entries, entry],
        },
        addKeys: [blob],
      },
      deps,
    )
    await verifyWritten(path, address, keyId, opened.reopen, ctx)

    if (ctx.json) {
      writeJson(deps, {
        ok: true,
        address,
        label,
        path: derivationPath,
        index,
        keyId,
        role: "external",
        vaultVersion: written.file.version,
      })
      return 0
    }
    deps.stdout.write(`${address}\n`)
    deps.stdout.write(`  label       ${label}\n`)
    deps.stdout.write(`  derivation  ${derivationPath}\n`)
    deps.stdout.write(`  role        external: signs only through candle sign and candle external sweep\n`)
    deps.stdout.write(`  verified    re-read from the vault and re-derived from its root\n`)
    if (wasVersion2) {
      deps.stdout.write(
        `  format      the vault is now version 3 (the external branch); a CLI before 0.12 refuses to open it\n`,
      )
    }
    deps.stdout.write(`Fund it from the vault with: candle vault fund ${label} --amount <n> --rpc-url <url>\n`)
    return 0
  })
}

export async function externalList(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--keystore"],
    booleanFlags: ["--accept-older-copy"],
    pathFlags: ["--keystore"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length > 0) return usage(ctx, `Unexpected argument: ${parsed.positionals[0]}`)
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "external list")) return 1

  const { deps } = ctx
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const path = resolvedVault.path
  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await requireVaultRaw(ctx, resolvedVault)
    const vault = hold(
      (await unlockInteractively(ctx, path, raw, { acceptOlderCopy: parsed.booleans.has("--accept-older-copy") }))
        .vault,
    )
    const externals = vault.index.entries.filter((entry) => entry.role === "external")
    const rows = externals.map((entry) => ({
      address: entry.address,
      label: entry.label,
      derivation: entry.derivation?.path,
      exposureUnknown: entry.exposure.exposureUnknown === true,
    }))
    if (ctx.json) {
      writeJson(deps, { ok: true, wallets: rows, vaultVersion: vault.file.version })
      return 0
    }
    if (rows.length === 0) {
      deps.stdout.write("No external wallets. Create one: candle external new --label <name>\n")
      return 0
    }
    for (const row of rows) {
      deps.stdout.write(`${row.address}\n`)
      deps.stdout.write(`  label       ${row.label || "(none)"}\n`)
      if (row.derivation) deps.stdout.write(`  derivation  ${row.derivation}\n`)
      if (row.exposureUnknown) deps.stdout.write(`  history     unknown (restored from the phrase)\n`)
    }
    deps.stdout.write(
      `External wallets are never delegated to Privy and never registered with Candle. Balances are read over your own RPC; Candle is not in their transactions.\n`,
    )
    return 0
  })
}

export async function externalSweep(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--to", "--rpc-url", "--keystore"],
    booleanFlags: ["--accept-older-copy"],
    pathFlags: ["--keystore"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [source, extra] = parsed.positionals
  if (!source || extra !== undefined) {
    return usage(ctx, "Usage: candle external sweep <external> --to <vault> --rpc-url <url>")
  }
  // Both entries are named on the command (R6): there is no default destination, and a vault with
  // several receive keys never silently chooses one.
  const to = parsed.values["--to"]
  if (!to) return usage(ctx, "--to <vault> is required: the vault receive key everything is sent to (never inferred).")
  const rpcUrl = rpcUrlFrom(ctx, parsed)
  if (typeof rpcUrl !== "string") return usage(ctx, rpcUrl.error)
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "external sweep")) return 1

  const { deps } = ctx
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const path = resolvedVault.path
  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await requireVaultRaw(ctx, resolvedVault)
    const opened = await unlockInteractively(ctx, path, raw, {
      acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
    })
    const vault = hold(opened.vault)

    // The source is a `role: "external"` entry and only that; the destination a `role: "vault"`
    // entry and only that. Naming them the other way round is refused, not reinterpreted.
    const sourceEntry = requireExternalEntry(vault.index, source)
    const destination = findVaultRoleEntry(vault.index, to)
    if (destination === undefined || destination.role !== "vault") {
      const other = vault.index.entries.find((candidate) => candidate.label === to || candidate.address === to)
      throw new VaultError(
        "VAULT_INDEX_INVALID",
        other === undefined
          ? `No vault key matches --to ${to}.`
          : `--to ${to} is ${describeRole(other)}; a sweep goes to a role:vault receive key only.`,
        { suggestion: "Name a vault key by label or address: candle vault status --unlock", exitCode: 2 },
      )
    }
    if (destination.address === sourceEntry.address) {
      return usage(ctx, "The source and the destination are the same address.")
    }

    // The source is displayed separately, by label and full address, ABOVE the destination, so a
    // sweep of the wrong wallet is visible without being what the operator confirms (R6).
    if (!ctx.json) {
      deps.stdout.write(`Sweep everything from external wallet:\n`)
      deps.stdout.write(`  source      ${sourceEntry.label}  ${sourceEntry.address}\n`)
      deps.stdout.write(`to vault receive key:\n`)
      deps.stdout.write(`  destination ${destination.label}  ${destination.address}\n`)
      deps.stdout.write(`SOL, classic SPL and Token-2022 balances move, signed locally with the external key.\n`)
    }
    await confirmLastSix(ctx, destination.address, "the vault destination")
    await opened.confirm(`sweep ${sourceEntry.label} to ${destination.address}`)

    const secret = await decryptKey(vault, sourceEntry.id)
    try {
      const rpc = createSolanaRpc(rpcUrl, deps.fetch)
      const outcome = await sweepEverythingTo({
        rpc,
        deps,
        secret64: secret,
        owner: sourceEntry.address,
        destination: destination.address,
        say: ctx.json ? () => {} : (line) => deps.stdout.write(`${line}\n`),
      })
      const complete = outcome.leftovers.length === 0
      if (ctx.json) {
        writeJson(deps, {
          ok: complete,
          source: sourceEntry.address,
          sourceLabel: sourceEntry.label,
          destination: destination.address,
          receipts: outcome.receipts,
          leftovers: outcome.leftovers,
        })
        return complete ? 0 : 3
      }
      if (outcome.receipts.length === 0 && outcome.leftovers.length === 0) {
        deps.stdout.write("Nothing to sweep: no balances found.\n")
        return 0
      }
      if (complete) {
        deps.stdout.write(`Swept: ${outcome.receipts.length} transaction(s) finalized.\n`)
        return 0
      }
      deps.stdout.write(`Sweep incomplete: ${outcome.leftovers.length} leftover(s).\n`)
      for (const l of outcome.leftovers) {
        deps.stdout.write(
          `  - ${l.kind}${l.mint ? ` ${l.mint}` : ""}${l.amountRaw ? ` (${l.amountRaw} raw)` : ""}: ${l.detail}\n`,
        )
      }
      deps.stdout.write("Re-run this sweep once the leftovers are resolved.\n")
      return 3
    } finally {
      wipe(secret)
    }
  })
}
