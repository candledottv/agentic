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
import { VaultError } from "../vault/errors"
import { assertColdVaultDestination } from "../vault/promote-support"
import { requireTeeDestination } from "../vault/reconcile-grant"
import { commitVault } from "../vault/store"
import { maybeReconcileVaultTee, releaseResolvedTee, resolveTeeAddress } from "../vault/tee-resolve"
import { teeDisable, teeSweep } from "./tee"
import {
  refuseEnvPassphrase,
  requireTty,
  requireVaultRaw,
  runVaultCommand,
  unlockInteractively,
  usage,
  vaultPathFor,
} from "./vault-support"

export async function vaultDemote(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--rpc-url", "--sweep-to", "--keystore"],
    booleanFlags: ["--emergency", "--accept-older-copy"],
    pathFlags: ["--keystore"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [address, extra] = parsed.positionals
  if (!address || extra !== undefined) {
    return usage(ctx, "Usage: candle vault demote <tee-address> --rpc-url <url> [--emergency] [--sweep-to <label>]")
  }
  const rpcUrl = parsed.values["--rpc-url"]
  if (!rpcUrl) return usage(ctx, "--rpc-url <url> is required.")
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "vault demote")) return 1

  const resolvedVault = vaultPathFor(ctx, parsed)

  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)

  const path = resolvedVault.path
  const emergency = parsed.booleans.has("--emergency")
  const sweepTo = parsed.values["--sweep-to"]

  const resolved = await resolveTeeAddress(ctx, parsed, address, async () => ({
    ok: false as const,
    code: 1,
  }))
  if (!resolved.ok) {
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

  let released = false
  try {
    const vaultResolved = resolved.resolved
    // CC-10 demote column: unresolved / unreadable / strand-final continue into adapter recovery.
    const reconciled = await maybeReconcileVaultTee(ctx, vaultResolved, "demote")
    if (reconciled.code !== null) return reconciled.code
    const entry = reconciled.entry

    if (entry.tee?.vaultDestination === undefined) {
      if (sweepTo === undefined) {
        throw new VaultError("GRANT_DESTINATION_UNRESOLVED", `${address} has no pinned vault destination.`, {
          suggestion:
            "Pass --sweep-to <vault-key-label> (subject to the recovery destination rule), or adopt the server's pin.",
        })
      }
      releaseResolvedTee(resolved.resolved)
      released = true
      return await runVaultCommand(ctx, async ({ hold }) => {
        const raw = await requireVaultRaw(ctx, resolvedVault)
        const opened = await unlockInteractively(ctx, path, raw, {
          acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
        })
        const vault = hold(opened.vault)
        const destination = assertColdVaultDestination(vault.index, sweepTo, {})
        await commitVault(
          vault,
          {
            index: {
              hd: vault.index.hd,
              entries: vault.index.entries.map((e) =>
                e.address === address
                  ? {
                      ...e,
                      tee: {
                        ...(e.tee ?? { network: "solana-mainnet", lifecycle: "local-candidate" }),
                        vaultDestination: destination.address,
                      },
                    }
                  : e,
              ),
            },
          },
          ctx.deps,
        )
        return demoteWithAdapter(ctx, { linkedWalletId: entry.linkedWalletId }, address, rpcUrl, true)
      })
    }

    requireTeeDestination(entry)
    // Unresolved, strand-final, and unreadable all recover under the emergency sweep path when
    // the grant is not identified (no linkedWalletId) or the entry is stranded.
    const needsEmergency = emergency || entry.linkedWalletId === undefined || entry.tee?.lifecycle === "stranded"
    const snapshot = { linkedWalletId: entry.linkedWalletId }
    releaseResolvedTee(resolved.resolved)
    released = true
    return demoteWithAdapter(ctx, snapshot, address, rpcUrl, needsEmergency)
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
    if (!released) releaseResolvedTee(resolved.resolved)
  }
}

/**
 * CC-10 adapter: call disable only when linkedWalletId is known; otherwise emergency sweep without
 * claiming a stop, and never print "never enabled".
 */
async function demoteWithAdapter(
  ctx: CommandContext,
  entry: { linkedWalletId?: string },
  address: string,
  rpcUrl: string,
  emergency: boolean,
): Promise<number> {
  if (entry.linkedWalletId !== undefined) {
    const disableCode = await teeDisable([address], ctx)
    if (disableCode !== 0 && disableCode !== 3 && !emergency) return disableCode
  } else {
    ctx.deps.stdout.write(
      `No linkedWalletId is recorded for ${address}; the grant could not be identified, so disable was not called and remote authority stays unknown.\n`,
    )
  }

  const sweepArgs = [address, "--rpc-url", rpcUrl]
  if (emergency || entry.linkedWalletId === undefined) sweepArgs.push("--emergency")
  return teeSweep(sweepArgs, ctx)
}
