/**
 * Ember Phase 2 PR C (ED-10, CC-08): `candle vault transfer`.
 *
 * Vault keys build and sign only the two transfer shapes, decoded and displayed before the factor
 * prompt, with the destination confirmed by typing its last six characters.
 */
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { wipe } from "../vault/hygiene"
import { findVaultRoleEntry } from "../vault/promote-support"
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

export async function vaultTransfer(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--amount", "--asset", "--from", "--rpc-url", "--keystore"],
    booleanFlags: ["--accept-older-copy"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [to, extra] = parsed.positionals
  if (!to || extra !== undefined) {
    return usage(
      ctx,
      "Usage: candle vault transfer <to> --amount <n> --asset SOL|<mint> --from <label> --rpc-url <url>",
    )
  }
  const amount = parsed.values["--amount"]
  const asset = parsed.values["--asset"]
  const fromLabel = parsed.values["--from"]
  const rpcUrl = parsed.values["--rpc-url"]
  if (!amount) return usage(ctx, "--amount <n> is required.")
  if (!asset) return usage(ctx, "--asset SOL|<mint> is required.")
  if (!fromLabel) return usage(ctx, "--from <label> is required.")
  if (!rpcUrl) return usage(ctx, "--rpc-url <url> is required.")
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "vault transfer")) return 1

  const path = vaultPathFor(ctx, parsed)
  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await requireVaultRaw(path)
    const opened = await unlockInteractively(ctx, path, raw, {
      acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
      promptText: "Vault passphrase (input hidden): ",
    })
    const vault = hold(opened.vault)
    const fromEntry = findVaultRoleEntry(vault.index, fromLabel)
    if (fromEntry === undefined) {
      return usage(ctx, `No vault key matches --from ${fromLabel}.`)
    }
    assertVaultSigner(fromEntry)

    const plan = await planTransfer({
      from: fromEntry.address,
      to,
      amount,
      asset,
      rpcUrl,
      fetch: ctx.deps.fetch,
    })
    const feeQuote = await quoteTransferFee(rpcUrl, ctx.deps.fetch, plan.from, plan.instructions)
    displayTransferPlan(ctx, plan, feeQuote)
    await confirmLastSix(ctx, to, "the destination")

    // The factor a second time before anything is signed: the passphrase typed again, or the
    // security key touched again. A mismatch refuses without signing; the vault is already open.
    await opened.confirm(`sign transfer of ${plan.amount} ${plan.asset} to ${to}`)

    const secret = await decryptKey(vault, fromEntry.id)
    try {
      const result = await signAndBroadcastTransfer({ ctx, rpcUrl, secret64: secret, plan })
      if (ctx.json) {
        writeJson(ctx.deps, {
          ok: result.finalized,
          signature: result.signature,
          from: plan.from,
          to: plan.to,
          amount: plan.amount,
          asset: plan.asset,
          amountRaw: plan.amountRaw.toString(),
          finalized: result.finalized,
        })
      } else {
        ctx.deps.stdout.write(
          result.finalized
            ? `Transferred ${plan.amount} ${plan.asset} to ${to}: ${result.signature}\n`
            : `Submitted ${result.signature}; finality is not yet confirmed.\n`,
        )
      }
      return result.finalized ? 0 : 3
    } finally {
      wipe(secret)
    }
  })
}
