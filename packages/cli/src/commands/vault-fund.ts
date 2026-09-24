/**
 * Ember Phase 2 PR C (CC-06, ED-10): `candle vault fund`.
 *
 * Ember Phase 3 PR F (BE-226, R6, P3-AD-13): the destination may also be an EXTERNAL wallet, by
 * label or address. That path is the Phase 2 ED-10 amendment's `role: "vault"` clause verbatim: a
 * vault-signed local transfer, decoded and displayed, with the operator typing the last six
 * characters of the destination external address before anything is signed. There is no `--yes`
 * (the shared parser refuses the flag): funding is the single place an external wallet's balance is
 * set, and that balance is the whole bound on `candle sign --yes`, so an unattended path here would
 * remove the bound that one depends on. The source is `--from <vault-label>`, or the vault's only
 * receive key when it has exactly one; with several, none is chosen silently.
 *
 * Phase 4a (BE-350, D3): Solana-only. The single-key default sees Solana vault keys only, so a vault
 * with one Solana vault key and one EVM vault key still auto-selects the Solana key; an EVM entry
 * named by `--from` or by the positional refuses with `SOLANA_COMMAND_EVM_KEY`.
 */
import { type ParsedArgs, parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { writeLocalFailure } from "../render"
import { VaultError } from "../vault/errors"
import type { KeyEntry } from "../vault/format"
import { type FundingReceipt, reconcileFundingReceipts, saveFundingReceipt } from "../vault/funding-receipts"
import { wipe } from "../vault/hygiene"
import { assertNotEvmEntry } from "../vault/promote-support"
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
  findExternalEntry,
  type OpenedVault,
  refuseEnvPassphrase,
  requireTty,
  requireVaultRaw,
  runVaultCommand,
  unlockInteractively,
  usage,
  vaultPathFor,
  writeJson,
} from "./vault-support"

/**
 * R6: fund an external wallet from a vault receive key. The `role: "vault"` clause of the Phase 2
 * ED-10 amendment, unchanged: decoded, displayed, the destination's last six typed, the factor
 * presented again, then signed locally. No funding receipt is kept (an external entry has no `tee`
 * record to hold one); an uncertain send reports its signature and exits 3.
 */
async function fundExternal(
  ctx: CommandContext,
  opened: OpenedVault,
  vault: OpenedVault["vault"],
  external: KeyEntry,
  input: { amount: string; asset: string; rpcUrl: string; parsed: ParsedArgs },
): Promise<number> {
  // D3 (Phase 4a): Solana vault keys only. An EVM vault key is never the single-key default.
  const vaultKeys = vault.index.entries.filter((entry) => entry.role === "vault" && entry.chain === "solana")
  const fromFlag = input.parsed.values["--from"]
  let fromEntry: KeyEntry | undefined
  if (fromFlag !== undefined) {
    assertNotEvmEntry(vault.index, fromFlag, "vault fund")
    fromEntry =
      vaultKeys.find((entry) => entry.label === fromFlag) ?? vaultKeys.find((entry) => entry.address === fromFlag)
    if (fromEntry === undefined) return usage(ctx, `No vault key matches --from ${fromFlag}.`)
  } else if (vaultKeys.length === 1) {
    fromEntry = vaultKeys[0]
  } else if (vaultKeys.length === 0) {
    return usage(
      ctx,
      "This vault has no vault receive key to fund from; create one: candle vault new-key --chain solana",
    )
  } else {
    return usage(
      ctx,
      `This vault has ${vaultKeys.length} vault keys; name the source with --from <label>: ${vaultKeys.map((entry) => entry.label).join(", ")}`,
    )
  }
  if (fromEntry === undefined) return usage(ctx, "No source vault key.")
  assertVaultSigner(fromEntry)
  const reconciled = await reconcileFundingReceipts(vault, [fromEntry.address, external.address], input.rpcUrl, ctx)
  if (reconciled !== null) return reconciled

  ctx.deps.stdout.write(
    `Funding external wallet ${external.label} (${external.address}) from vault key ${fromEntry.label}. What this wallet holds is what candle sign can spend; fund a session, not a float.\n`,
  )
  const plan = await planTransfer({
    from: fromEntry.address,
    to: external.address,
    amount: input.amount,
    asset: input.asset,
    rpcUrl: input.rpcUrl,
    fetch: ctx.deps.fetch,
  })
  const feeQuote = await quoteTransferFee(input.rpcUrl, ctx.deps.fetch, plan.from, plan.instructions)
  displayTransferPlan(ctx, plan, feeQuote)
  await confirmLastSix(ctx, external.address, "the external wallet destination")
  await opened.confirm(`fund ${plan.amount} ${plan.asset} to external wallet ${external.label}`)

  const secret = await decryptKey(vault, fromEntry.id)
  try {
    const result = await signAndBroadcastTransfer({ ctx, rpcUrl: input.rpcUrl, secret64: secret, plan })
    if (ctx.json) {
      writeJson(ctx.deps, {
        ok: result.finalized,
        signature: result.signature,
        external: external.address,
        externalLabel: external.label,
        from: plan.from,
        amount: plan.amount,
        asset: plan.asset,
        finalized: result.finalized,
      })
    } else {
      ctx.deps.stdout.write(
        result.finalized
          ? `Funded ${external.label} (${external.address}) with ${plan.amount} ${plan.asset}: ${result.signature}\n`
          : `Submitted ${result.signature}; finality is not yet confirmed.\n`,
      )
    }
    return result.finalized ? 0 : 3
  } finally {
    wipe(secret)
  }
}

export async function vaultFund(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--amount", "--asset", "--rpc-url", "--keystore", "--from"],
    booleanFlags: ["--accept-older-copy"],
    pathFlags: ["--keystore"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [teeAddress, extra] = parsed.positionals
  if (!teeAddress || extra !== undefined) {
    return usage(
      ctx,
      "Usage: candle vault fund <tee-address | external-label> --amount <n> --asset SOL|USDC --rpc-url <url> [--from <vault-label>]",
    )
  }
  const amount = parsed.values["--amount"]
  const asset = (parsed.values["--asset"] ?? "SOL").toUpperCase()
  const rpcUrl = parsed.values["--rpc-url"]
  if (!amount) return usage(ctx, "--amount <n> is required.")
  if (asset !== "SOL" && asset !== "USDC") return usage(ctx, "--asset must be SOL or USDC.")
  if (!rpcUrl) return usage(ctx, "--rpc-url <url> is required.")
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "vault fund")) return 1

  const resolvedVault = vaultPathFor(ctx, parsed)

  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)

  const path = resolvedVault.path
  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await requireVaultRaw(ctx, resolvedVault)
    const opened = await unlockInteractively(ctx, path, raw, {
      acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
    })
    const vault = hold(opened.vault)

    // D3 (Phase 4a): an EVM entry named as the destination, or as the source, is refused by name.
    assertNotEvmEntry(vault.index, teeAddress, "vault fund")
    if (parsed.values["--from"] !== undefined) assertNotEvmEntry(vault.index, parsed.values["--from"], "vault fund")
    const teeEntry = vault.index.entries.find((entry) => entry.address === teeAddress && entry.role === "tee-wallet")
    if (teeEntry === undefined) {
      const external = findExternalEntry(vault.index, teeAddress)
      if (external !== undefined) return fundExternal(ctx, opened, vault, external, { amount, asset, rpcUrl, parsed })
      writeLocalFailure(
        ctx.deps,
        {
          code: "TEE_WALLET_UNKNOWN",
          message: `${teeAddress} is neither a TEE wallet nor an external wallet in this vault.`,
          suggestion:
            "Promote a TEE wallet with candle vault promote --from <vault-key-label>, or create an external wallet with candle external new.",
        },
        ctx.json,
      )
      return 1
    }
    if (parsed.values["--from"] !== undefined) {
      return usage(ctx, "--from applies to an external wallet only; a TEE wallet is funded from its pinned vault key.")
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
        {
          suggestion:
            "Nothing was signed. Name the source key with --from <label>, or pin one: candle tee enable <address> --vault <address>",
        },
      )
    }
    const fromEntry = vault.index.entries.find(
      (entry) => entry.address === destination && entry.role === "vault" && entry.chain === "solana",
    )
    if (fromEntry === undefined) {
      throw new VaultError(
        "GRANT_DESTINATION_UNRESOLVED",
        `Pinned destination ${destination} is not a vault key in this vault.`,
        {
          suggestion:
            "Nothing was signed. Name the source key with --from <label>; candle vault status lists this vault's keys.",
        },
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
