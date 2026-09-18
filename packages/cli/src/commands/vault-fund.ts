/**
 * Ember Phase 2 PR C (CC-06, ED-10): `candle vault fund`.
 */
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { writeLocalFailure } from "../render"
import { VaultError } from "../vault/errors"
import { type FundingReceipt, reconcileFundingReceipts, saveFundingReceipt } from "../vault/funding-receipts"
import { wipe } from "../vault/hygiene"
import { decryptKey } from "../vault/store"
import {
  assertVaultSigner,
  displayTransferPlan,
  planTransfer,
  quoteTransferFee,
  signAndBroadcastTransfer,
} from "../vault/vault-transfer-sign"
import {
  confirmLastSix,
  refuseEnvPassphrase,
  requireTty,
  requireVaultRaw,
  runVaultCommand,
  unlockInteractively,
  usage,
  vaultPathFor,
  writeJson,
} from "./vault-support"

export async function vaultFund(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--amount", "--asset", "--rpc-url", "--keystore"],
    booleanFlags: ["--accept-older-copy"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [teeAddress, extra] = parsed.positionals
  if (!teeAddress || extra !== undefined) {
    return usage(ctx, "Usage: candle vault fund <tee-address> --amount <n> --asset SOL|USDC --rpc-url <url>")
  }
  const amount = parsed.values["--amount"]
  const asset = (parsed.values["--asset"] ?? "SOL").toUpperCase()
  const rpcUrl = parsed.values["--rpc-url"]
  if (!amount) return usage(ctx, "--amount <n> is required.")
  if (asset !== "SOL" && asset !== "USDC") return usage(ctx, "--asset must be SOL or USDC.")
  if (!rpcUrl) return usage(ctx, "--rpc-url <url> is required.")
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "vault fund")) return 1

  const path = vaultPathFor(ctx, parsed)
  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await requireVaultRaw(path)
    const opened = await unlockInteractively(ctx, path, raw, {
      acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
    })
    const vault = hold(opened.vault)

    const teeEntry = vault.index.entries.find((entry) => entry.address === teeAddress && entry.role === "tee-wallet")
    if (teeEntry === undefined) {
      writeLocalFailure(
        ctx.deps,
        {
          code: "TEE_WALLET_UNKNOWN",
          message: `${teeAddress} is not a TEE wallet in this vault.`,
          suggestion: "Promote one with candle vault promote --from <vault-key-label>.",
        },
        ctx.json,
      )
      return 1
    }
    const reconciled = await reconcileFundingReceipts(
      vault,
      [teeAddress, ...(teeEntry.tee?.vaultDestination ? [teeEntry.tee.vaultDestination] : [])],
      rpcUrl,
      ctx,
    )
    if (reconciled !== null) return reconciled
    if (teeEntry.tee?.remoteAuthority !== "verified-active" || teeEntry.tee.stopRequestedAt !== undefined) {
      writeLocalFailure(
        ctx.deps,
        {
          code: "TEE_WALLET_NOT_VERIFIED",
          message: `${teeAddress} is not an enabled TEE wallet with verified remote authority; do not fund it.`,
        },
        ctx.json,
      )
      return 1
    }
    const destination = teeEntry.tee.vaultDestination
    if (destination === undefined) {
      throw new VaultError(
        "GRANT_DESTINATION_UNRESOLVED",
        `${teeAddress} has no pinned vault destination to fund from.`,
      )
    }
    const fromEntry = vault.index.entries.find((entry) => entry.address === destination && entry.role === "vault")
    if (fromEntry === undefined) {
      throw new VaultError(
        "GRANT_DESTINATION_UNRESOLVED",
        `Pinned destination ${destination} is not a vault key in this vault.`,
      )
    }
    assertVaultSigner(fromEntry)

    ctx.deps.stdout.write(
      `Every funded unit adds to the TEE wallet exposure; the initial float is not a maximum loss.\n`,
    )

    const plan = await planTransfer({
      from: fromEntry.address,
      to: teeAddress,
      amount,
      asset,
      rpcUrl,
      fetch: ctx.deps.fetch,
    })
    const feeQuote = await quoteTransferFee(rpcUrl, ctx.deps.fetch, plan.from, plan.instructions)
    displayTransferPlan(ctx, plan, feeQuote)
    await confirmLastSix(ctx, teeAddress, "the TEE wallet destination")

    // The factor a second time before anything is signed (passphrase re-typed, or key re-touched).
    await opened.confirm(`fund ${plan.amount} ${plan.asset} to ${teeAddress}`)

    const secret = await decryptKey(vault, fromEntry.id)
    try {
      let receipt: FundingReceipt | undefined
      const result = await signAndBroadcastTransfer({
        ctx,
        rpcUrl,
        secret64: secret,
        plan,
        beforeBroadcast: async ({ signature, blockhash }) => {
          receipt = {
            signature,
            blockhash,
            from: plan.from,
            amount: plan.amount,
            asset: plan.asset,
            amountRaw: plan.amountRaw.toString(),
            at: new Date(ctx.deps.now()).toISOString(),
            finalized: false,
          }
          await saveFundingReceipt(vault, teeEntry.id, receipt, ctx)
        },
      })
      if (result.finalized && receipt) {
        await saveFundingReceipt(vault, teeEntry.id, { ...receipt, finalized: true }, ctx)
      }

      if (ctx.json) {
        writeJson(ctx.deps, {
          ok: result.finalized,
          signature: result.signature,
          tee: teeAddress,
          from: plan.from,
          amount: plan.amount,
          asset: plan.asset,
          finalized: result.finalized,
        })
      } else {
        ctx.deps.stdout.write(
          result.finalized
            ? `Funded ${teeAddress} with ${plan.amount} ${plan.asset}: ${result.signature}\n`
            : `Submitted ${result.signature}; finality is not yet confirmed. Receipt recorded.\n`,
        )
      }
      return result.finalized ? 0 : 3
    } finally {
      wipe(secret)
    }
  })
}
