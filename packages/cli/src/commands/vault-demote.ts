/**
 * Ember Phase 2 PR C (CC-06, CC-10): `candle vault demote`.
 *
 * Disable then sweep against the vault entry, through the Phase 1 adapter rules: never the
 * never-enabled shortcut, emergency sweep when the grant is unresolved, and no local-only
 * retirement without a verified disable.
 */
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { writeLocalFailure } from "../render"
import { openSolanaClient } from "../solana-endpoint"
import { VaultError } from "../vault/errors"
import { assertColdVaultDestination } from "../vault/promote-support"
import { requireTeeDestination } from "../vault/reconcile-grant"
import {
  applyVault,
  commitVaultTeeEntry,
  maybeReconcileVaultTee,
  releaseResolvedTee,
  resolveTeeAddress,
} from "../vault/tee-resolve"
import { type DemoteStep, nothingLeftToSweep, teeDisable, teeSweep } from "./tee"
import { namesEvmWallet, vaultDemoteEvm } from "./tee-evm"
import { assertNotOlderCopy, refuseEnvPassphrase, requireTty, usage, vaultPathFor } from "./vault-support"

export async function vaultDemote(args: string[], ctx: CommandContext): Promise<number> {
  // Phase 4b (BE-391, D1): a Hood TEE wallet is demoted by `tee-evm.ts` (disable, then sweep).
  if (namesEvmWallet(args)) return vaultDemoteEvm(args, ctx)
  const parsed = parseArgs(args, {
    valueFlags: ["--rpc-url", "--sweep-to", "--keystore"],
    booleanFlags: ["--emergency", "--accept-older-copy"],
    pathFlags: ["--keystore"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [address, extra] = parsed.positionals
  if (!address || extra !== undefined) {
    return usage(ctx, "Usage: candle vault demote <tee-address> [--rpc-url <url>] [--emergency] [--sweep-to <label>]")
  }
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "vault demote")) return 1

  const resolvedVault = vaultPathFor(ctx, parsed)

  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)

  const path = resolvedVault.path
  const emergency = parsed.booleans.has("--emergency")
  const sweepTo = parsed.values["--sweep-to"]
  // BE-355 / BE-981: one client for the whole demote, resolved from --rpc-url when given and
  // otherwise exactly as `tee sweep` would. Building it makes no request, so a bad --rpc-url is
  // refused before the unlock, and the host line prints once, on the first read.
  const solana = await openSolanaClient(ctx, parsed.values["--rpc-url"])
  if ("error" in solana) return usage(ctx, solana.error)

  // BE-981: the only unlock in a Solana demote. The disable and the sweep below run against this
  // open vault, and it is closed once, in the finally block.
  const resolved = await resolveTeeAddress(ctx, parsed, address, async () => ({
    ok: false as const,
    code: 1,
  }))
  if (!resolved.ok) {
    // A refusal the resolver already wrote (an unlock failure, or Phase 4a's EVM-key refusal) is
    // the answer; a second envelope over it would hide the code an agent switches on.
    if (resolved.reported) return resolved.code
    writeLocalFailure(
      ctx.deps,
      {
        code: "TEE_WALLET_UNKNOWN",
        message: `${address} is not a TEE wallet in the vault.`,
        suggestion: "Demote only addresses this vault holds as role:tee-wallet.",
      },
      ctx.json,
    )
    return 1
  }
  if (resolved.resolved.source !== "vault") {
    releaseResolvedTee(resolved.resolved)
    writeLocalFailure(
      ctx.deps,
      {
        code: "TEE_WALLET_UNKNOWN",
        message: `${address} is not in the vault; use candle tee disable / tee sweep for the Phase 1 store.`,
      },
      ctx.json,
    )
    return 1
  }

  const vaultResolved = resolved.resolved
  try {
    // CC-10 demote column: unresolved / unreadable / strand-final continue into adapter recovery.
    const reconciled = await maybeReconcileVaultTee(ctx, vaultResolved, "demote")
    if (reconciled.code !== null) return reconciled.code
    const entry = reconciled.entry
    const step: DemoteStep = { resolved: vaultResolved, solana }

    if (entry.tee?.vaultDestination === undefined) {
      if (sweepTo === undefined) {
        throw new VaultError("GRANT_DESTINATION_UNRESOLVED", `${address} has no pinned vault destination.`, {
          suggestion:
            "Pass --sweep-to <vault-key-label> (subject to the recovery destination rule), or adopt the server's pin.",
        })
      }
      // ED-6: pinning the destination writes the vault, and an older copy of the file is refused
      // for that write unless --accept-older-copy, as the separate unlock for it used to refuse.
      await assertNotOlderCopy(ctx, path, vaultResolved.vault.raw, parsed.booleans.has("--accept-older-copy"))
      const destination = assertColdVaultDestination(vaultResolved.vault.index, sweepTo, {})
      const next = await commitVaultTeeEntry(ctx, vaultResolved.vault, entry.id, (target) => {
        target.tee = {
          ...(target.tee ?? { network: "solana-mainnet", lifecycle: "local-candidate" }),
          vaultDestination: destination.address,
        }
      })
      applyVault(vaultResolved, next)
      return await demoteWithAdapter(ctx, step, address, parsed.values["--rpc-url"], true)
    }

    requireTeeDestination(entry)
    // Unresolved, strand-final, and unreadable all recover under the emergency sweep path when
    // the grant is not identified (no linkedWalletId) or the entry is stranded.
    const needsEmergency = emergency || entry.linkedWalletId === undefined || entry.tee?.lifecycle === "stranded"
    return await demoteWithAdapter(ctx, step, address, parsed.values["--rpc-url"], needsEmergency)
  } catch (error) {
    if (error instanceof VaultError) {
      writeLocalFailure(
        ctx.deps,
        {
          code: error.code,
          message: error.message,
          ...(error.suggestion ? { suggestion: error.suggestion } : {}),
        },
        ctx.json,
      )
      return error.exitCode
    }
    throw error
  } finally {
    releaseResolvedTee(vaultResolved)
  }
}

/**
 * CC-10 adapter: call disable only when linkedWalletId is known; otherwise emergency sweep without
 * claiming a stop, and never print "never enabled". Both steps run inside demote's one unlock
 * (BE-981), and a wallet the chain shows empty is not swept at all.
 */
async function demoteWithAdapter(
  ctx: CommandContext,
  step: DemoteStep,
  address: string,
  rpcUrl: string | undefined,
  emergency: boolean,
): Promise<number> {
  const linkedWalletId = step.resolved.entry.linkedWalletId
  let disableCode: number | null = null
  if (linkedWalletId !== undefined) {
    disableCode = await teeDisable([address], ctx, step)
    if (disableCode !== 0 && disableCode !== 3 && !emergency) return disableCode
  } else {
    ctx.deps.stdout.write(
      `No linkedWalletId is recorded for ${address}; the grant could not be identified, so disable was not called and remote authority stays unknown.\n`,
    )
  }

  const destination = step.resolved.entry.tee?.vaultDestination
  if (await nothingLeftToSweep(step.solana, step.resolved.entry)) {
    // Not a retirement: the entry keeps its lifecycle, as a sweep with no receipts would leave it.
    // Exit 0 only when the disable was verified; otherwise remote authority is still open.
    const code = disableCode === 0 ? 0 : 3
    if (ctx.json) {
      ctx.deps.stdout.write(
        `${JSON.stringify({ address, vaultDestination: destination, swept: false, nothingToSweep: true, lamports: "0", tokenAccounts: 0 })}\n`,
      )
    } else {
      ctx.deps.stdout.write("Nothing to sweep: 0 SOL, 0 token accounts.\n")
    }
    return code
  }

  if (!ctx.json) ctx.deps.stdout.write(`Sweeping remaining funds to ${destination}...\n`)
  const sweepArgs = rpcUrl === undefined ? [address] : [address, "--rpc-url", rpcUrl]
  if (emergency || linkedWalletId === undefined) sweepArgs.push("--emergency")
  return teeSweep(sweepArgs, ctx, step)
}
