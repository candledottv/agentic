/**
 * Hyperliquid withdrawals W1 (BE-1573, spec 2026-10-17-hyperliquid-withdrawals-design.md):
 * `candle perps withdraw <amount> --to solana|hood` and `candle perps withdraw status <id>`.
 *
 * USDC leaves the key's Hyperliquid account (its EVM TEE wallet's own address) through Relay and
 * lands on the same key's own Solana or Hood TEE wallet. Candle builds both signatures; this
 * machine checks each before the relay signs it (`hyperliquid-withdraw.ts`), and posts the signed
 * SendAsset to Hyperliquid itself.
 *
 * The owner gate (HW-ED-7) follows `vault transfer`'s one-verification rule: the decoded
 * withdrawal (amount, fees, net, and the destination chain and address grouped on its own line),
 * then one vault unlock whose prompt names the withdrawal, then one typed `confirm`. There is no
 * `--yes`, and a terminal is required. The key signer is a local file, not a vault key, so the
 * server cannot see that this gate ran: what bounds a holder of the key and its signer is the
 * scope, the destination (the key's own wallets) and the amount cap.
 *
 * Needs `perps:withdraw` (owner-granted, separate from `perps:write`). This release ships the
 * withdrawal pins V-A recorded; `CANDLE_PERPS_WITHDRAW_PINS` (JSON) replaces them for this machine,
 * and with neither every withdrawal would be refused before anything is built.
 */
import { randomUUID } from "node:crypto"
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { writeFields } from "../human-output"
import { HYPERLIQUID_EXCHANGE_URLS, type HyperliquidTypedData, hyperliquidExchangeBody } from "../hyperliquid"
import {
  CANDLE_PERPS_WITHDRAW_PINS,
  formatWithdrawAmount,
  type PerpsWithdrawAuthorization,
  type PerpsWithdrawBuild,
  type PerpsWithdrawPins,
  parseWithdrawAmount,
  verifyWithdrawMapping,
  verifyWithdrawSendAsset,
} from "../hyperliquid-withdraw"
import { notice } from "../presentation"
import { writeUsageFailure } from "../render"
import { type Json, listTradingWallets, safeText, TradingError, tradingKey } from "../trading"
import { isVaultError } from "../vault/errors"
import { closeVault } from "../vault/store"
import { perpsRequest, perpsWallet, typedDataAuthorization, venueRefusal } from "./perps"
import { printTradingResult, tradingFailure } from "./swap"
import {
  groupAddress,
  refuseEnvPassphrase,
  requireTty,
  requireVaultRaw,
  unlockInteractively,
  vaultPathFor,
  writeVaultFailure,
} from "./vault-support"

const WITHDRAW_SCOPE = "perps:withdraw"
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
const USAGE =
  "Usage: candle perps withdraw <amount> --to solana|hood [--wallet <evm tee>] [--id <id>] [--keystore <path>] | candle perps withdraw status <id>"
/** How long the command follows a withdrawal before it hands back the id and the status command. */
export const WITHDRAW_POLL_MS = 10 * 60 * 1000
export const WITHDRAW_POLL_INTERVAL_MS = 5_000
const TERMINAL = new Set(["settled", "refunded", "failed"])

function usage(ctx: CommandContext, line: string): number {
  writeUsageFailure(ctx.deps, line, ctx.json)
  return 2
}

/** This release's pins, or the operator's `CANDLE_PERPS_WITHDRAW_PINS`; null when neither exists. */
export function withdrawPins(env: Record<string, string | undefined>): PerpsWithdrawPins | null {
  const raw = env.CANDLE_PERPS_WITHDRAW_PINS
  if (raw === undefined || raw.trim() === "") return CANDLE_PERPS_WITHDRAW_PINS
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new TradingError("INVALID_PINS", "CANDLE_PERPS_WITHDRAW_PINS is not JSON.")
  }
  const p = parsed as Partial<PerpsWithdrawPins>
  if (
    typeof p !== "object" ||
    p === null ||
    typeof p.token !== "string" ||
    typeof p.destinationDex !== "string" ||
    !Array.isArray(p.depositories) ||
    p.depositories.length === 0 ||
    !p.depositories.every((d) => typeof d === "string" && /^0x[0-9a-fA-F]{40}$/.test(d)) ||
    (p.amountForm !== "canonical" && p.amountForm !== "fixed6")
  ) {
    throw new TradingError(
      "INVALID_PINS",
      "CANDLE_PERPS_WITHDRAW_PINS must be {token, destinationDex, depositories: [0x...], amountForm: canonical|fixed6}.",
    )
  }
  return {
    token: p.token,
    destinationDex: p.destinationDex,
    depositories: p.depositories.map((d) => d.toLowerCase()),
    amountForm: p.amountForm,
  }
}

async function withdrawStatus(ctx: CommandContext, id: string): Promise<number> {
  const key = await tradingKey(ctx)
  const result = await perpsRequest(ctx, key, `/api/v1/agent/perps/withdraw/${encodeURIComponent(id)}`)
  if (ctx.json) return printTradingResult(ctx, result)
  const to = (result.to ?? {}) as Record<string, unknown>
  const relay = result.relay as { status?: unknown } | null | undefined
  writeFields(ctx.deps, "stdout", [
    ["Withdrawal", safeText(id)],
    ["Status", safeText(result.status)],
    ["Amount", `${safeText(result.amountUsdc)} USDC`],
    ["To", safeText(to.address)],
    ["Chain", safeText(to.chain)],
    ["Fees", `${safeText(result.feesUsdc)} USDC`],
    ["Failure", result.failureReason ? safeText(result.failureReason) : undefined],
    ["Relay", relay ? safeText(relay.status) : undefined],
  ])
  return 0
}

export async function perpsWithdraw(args: string[], ctx: CommandContext): Promise<number> {
  if (args[0] === "status") {
    if (args.length !== 2 || !ID_RE.test(args[1] as string)) return usage(ctx, USAGE)
    try {
      return await withdrawStatus(ctx, args[1] as string)
    } catch (error) {
      return tradingFailure(ctx, error)
    }
  }
  if (args.includes("--yes") || args.includes("-y")) {
    return usage(ctx, "candle perps withdraw has no --yes: every withdrawal is confirmed at the terminal.")
  }
  const parsed = parseArgs(args, {
    valueFlags: ["--to", "--wallet", "--id", "--keystore"],
    pathFlags: ["--keystore"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [amount] = parsed.positionals
  const to = parsed.values["--to"]
  if (parsed.positionals.length !== 1 || !amount || (to !== "solana" && to !== "hood")) return usage(ctx, USAGE)
  const amountMicros = parseWithdrawAmount(amount)
  if (amountMicros === null) return usage(ctx, "The amount must be a positive USDC decimal with at most 6 decimals.")
  const id = parsed.values["--id"] ?? `withdraw-${randomUUID()}`
  if (!ID_RE.test(id)) return usage(ctx, "--id must be 1 to 128 letters, digits, '.', '_', ':' or '-'.")
  // HW-ED-7: a terminal, and no passphrase from the environment, before anything is read.
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "perps withdraw")) return 1
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)

  try {
    const pins = withdrawPins(ctx.deps.env)
    if (pins === null) {
      throw new TradingError(
        "PERPS_WITHDRAW_UNVERIFIED",
        "Hyperliquid withdrawals wait on a recorded verification of Relay's quote shape in this release. Nothing was built.",
      )
    }
    const key = await tradingKey(ctx)
    const { wallet } = await perpsWallet(ctx, key, parsed.values["--wallet"], WITHDRAW_SCOPE)
    if (!wallet) throw new TradingError("TEE_WALLET_REQUIRED", "No EVM TEE wallet resolved.")
    // The destinations this key owns on the chain asked for: the build must land on one of them.
    const { rows } = await listTradingWallets(ctx, key)
    const ownDestinations =
      to === "hood" ? [wallet.address] : rows.filter((row) => row.chain === "solana").map((row) => row.address)
    if (ownDestinations.length === 0)
      throw new TradingError(
        "TEE_WALLET_REQUIRED",
        "This key has no Solana TEE wallet, so --to solana has nowhere to land. Withdraw --to hood instead.",
      )

    writeFields(ctx.deps, "stderr", [["Withdrawal", id]])
    const build = (await perpsRequest(ctx, key, "/api/v1/agent/perps/withdraw", {
      clientWithdrawalId: id,
      amountUsdc: amount,
      to,
      wallet: wallet.id,
    })) as unknown as PerpsWithdrawBuild
    // The id already names a withdrawal past its quote: report it and sign nothing again.
    if (build.status !== "quoted") return printTradingResult(ctx, build as unknown as Json)
    const refused = (problem: string) =>
      new TradingError("PERPS_BUILD_REFUSED", `Refused to sign this withdrawal: ${problem}. Nothing was signed.`)
    const mapping = verifyWithdrawMapping(build, {
      id,
      account: wallet.address,
      to,
      amountMicros,
      ownDestinations,
      pins,
    })
    if (!mapping.ok) throw refused(mapping.reason)

    // The decoded withdrawal, then one unlock that names it, then one typed confirm.
    writeFields(ctx.deps, ctx.json ? "stderr" : "stdout", [
      ["Withdraw", `${formatWithdrawAmount(amountMicros)} USDC`],
      ["Hyperliquid account", safeText(wallet.address)],
      ["Route", "Relay"],
      ["Relay fees", `${safeText(build.feesUsdc)} USDC`],
      ["Estimated received", `${safeText(build.netUsdc)} USDC`],
      ["Minimum received", `${safeText(build.minimumOutUsdc)} USDC`],
      ["Destination", `this key's ${to === "hood" ? "Hood" : "Solana"} TEE wallet`],
      ["To", groupAddress(build.to.address)],
    ])

    const positions = await perpsRequest(
      ctx,
      key,
      `/api/v1/agent/perps/positions?walletId=${encodeURIComponent(wallet.id)}`,
    ).catch(() => null)
    if (Array.isArray(positions?.positions) && positions.positions.length > 0)
      notice(
        ctx.deps,
        ctx.json ? "stderr" : "stdout",
        "warning",
        "This account has open positions: withdrawing margin raises their liquidation risk.\n".trim(),
      )

    const raw = await requireVaultRaw(ctx, resolvedVault)
    const opened = await unlockInteractively(ctx, resolvedVault.path, raw, {
      promptText: "Vault passphrase (input hidden): ",
      reason: `withdraw ${formatWithdrawAmount(amountMicros)} USDC to ${build.to.address}`,
    })
    closeVault(opened.vault)
    const typed = await ctx.deps.promptLine(
      `Type confirm to withdraw ${formatWithdrawAmount(amountMicros)} USDC to ${build.to.address}: `,
    )
    if (typed.trim().toLowerCase() !== "confirm")
      throw new TradingError("CANCELLED", "The withdrawal was not confirmed; nothing was signed.")
    if (typeof build.expiresAt !== "number" || build.expiresAt <= ctx.deps.now())
      throw new TradingError("QUOTE_EXPIRED", "The quote expired before signing. Start again with a new --id.")

    // 1. The NonceMapping, through the relay; Candle posts it to Relay.
    const mappingSignature = await relaySignature(ctx, key, wallet, build.typedData as HyperliquidTypedData)
    const authorization = (await perpsRequest(ctx, key, "/api/v1/agent/perps/withdraw/authorize", {
      clientWithdrawalId: id,
      signature: mappingSignature,
    })) as unknown as PerpsWithdrawAuthorization
    // 2. The SendAsset, checked, through the relay; this machine posts it to Hyperliquid.
    const send = verifyWithdrawSendAsset(authorization, { mappingNonce: build.nonce, amountMicros, pins })
    if (!send.ok)
      throw new TradingError(
        "PERPS_BUILD_REFUSED",
        `Refused to sign the transfer: ${send.reason}. The nonce mapping was posted; nothing can move without this signature.`,
      )
    const signature = await relaySignature(ctx, key, wallet, authorization.typedData as HyperliquidTypedData)
    const exchangeBody = hyperliquidExchangeBody(authorization.action, authorization.nonce, signature)
    let exchange: unknown
    try {
      const res = await ctx.deps.fetch(HYPERLIQUID_EXCHANGE_URLS.mainnet, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(exchangeBody),
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      exchange = JSON.parse(text)
    } catch (error) {
      throw new TradingError(
        "PERPS_SUBMIT_FAILED",
        `Signed, but the submit to Hyperliquid failed (${error instanceof Error ? error.message : "unknown"}). The signed transfer is in details.exchangeBody and stays valid for two days; check candle perps withdraw status ${id} before resubmitting.`,
        { exitCode: 3, details: { clientWithdrawalId: id, exchangeBody } },
      )
    }
    // Informational: the status read is the source of truth.
    await perpsRequest(ctx, key, "/api/v1/agent/perps/withdraw/submitted", {
      clientWithdrawalId: id,
      exchangeResponse: exchange as Json,
    }).catch(() => null)
    const refusal = venueRefusal(exchange)
    if (refusal)
      throw new TradingError("PERPS_VENUE_REFUSED", refusal, { details: { clientWithdrawalId: id, exchange } })

    notice(ctx.deps, "stderr", "note", "Submitted to Hyperliquid; following Relay's fill.\n".trim())
    const deadline = ctx.deps.now() + WITHDRAW_POLL_MS
    let status: Json = await perpsRequest(ctx, key, `/api/v1/agent/perps/withdraw/${encodeURIComponent(id)}`)
    while (!TERMINAL.has(String(status.status)) && ctx.deps.now() < deadline) {
      await ctx.deps.sleep(WITHDRAW_POLL_INTERVAL_MS)
      status = await perpsRequest(ctx, key, `/api/v1/agent/perps/withdraw/${encodeURIComponent(id)}`)
    }
    if (!TERMINAL.has(String(status.status)))
      notice(
        ctx.deps,
        "stderr",
        "note",
        `Still ${safeText(status.status)} after 10 minutes. Check it with candle perps withdraw status ${id}.\n`.trim(),
      )
    return printTradingResult(ctx, { ...status, signature, exchange } as Json)
  } catch (error) {
    if (isVaultError(error)) return writeVaultFailure(ctx, error)
    return tradingFailure(ctx, error)
  }
}

async function relaySignature(
  ctx: CommandContext,
  key: string,
  wallet: Parameters<typeof typedDataAuthorization>[0],
  typedData: HyperliquidTypedData,
): Promise<string> {
  const relay = await perpsRequest(
    ctx,
    key,
    `/api/v1/agent/wallets/${encodeURIComponent(wallet.id)}/sign`,
    typedDataAuthorization(wallet, typedData) as unknown as Json,
  )
  if (typeof relay.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(relay.signature))
    throw new TradingError("INVALID_RESPONSE", "The relay did not return a signature.")
  return relay.signature
}
