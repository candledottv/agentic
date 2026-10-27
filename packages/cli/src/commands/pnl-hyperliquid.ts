import type { CommandContext } from "../deps"
import type { HyperliquidPerpsPosition, HyperliquidPnlSection } from "../hyperliquid-pnl"
import { terminalText } from "../render"
import { formatUsd } from "../usd"

/** R7 as amended (agent-page perps §8.2): a separate heading and net, also counted in the total. */
export function writeHyperliquidPnl(ctx: CommandContext, section: HyperliquidPnlSection | undefined): void {
  if (!section) return
  const out = ctx.deps.stdout
  out.write("\nHyperliquid\n")
  if (!section.read) {
    out.write(`Unavailable: ${terminalText(section.reason)}\n`)
    return
  }
  out.write(`Network: ${section.network}\n`)
  out.write(`Realized gross  ${formatUsd(section.realizedGrossUsd)}\n`)
  out.write(`Funding         ${formatUsd(section.fundingUsd)} (received positive, paid negative)\n`)
  out.write(`Fees            ${formatUsd(section.feesUsd)} (includes builder fees)\n`)
  out.write(`Realized net    ${formatUsd(section.realizedNetUsd)} (gross + funding - fees)\n`)
  // A server from before perps were counted sends no net: its figures are realized only.
  if (typeof section.netUsd !== "string" || typeof section.unrealizedUsd !== "string") {
    out.write(`${section.fills} fills; ${section.fundingPayments} funding payments.\n`)
    out.write("This server reports realized perps only, for the current binding, outside the total.\n")
    return
  }
  const wallets = Array.isArray(section.byWallet) ? section.byWallet : []
  const live = wallets.some((w) => w.reconciliation === "live")
  const markedAt = typeof section.markedAt === "number" ? ` at ${new Date(section.markedAt).toISOString()}` : ""
  out.write(`Unrealized      ${formatUsd(Number(section.unrealizedUsd))} (open positions${markedAt})\n`)
  out.write(
    `Net             ${formatUsd(Number(section.netUsd))} (realized net + unrealized; in the total)${live ? " (live, not yet settled)" : ""}\n`,
  )
  out.write(`${section.fills} fills; ${section.fundingPayments} funding payments.\n`)
  out.write("Coverage: every EVM TEE wallet bound to this profile, per binding period.\n")
  for (const wallet of wallets) {
    const to = wallet.toMs === null ? "now" : new Date(wallet.toMs).toISOString()
    const state =
      wallet.reconciliation === "live"
        ? `live to ${new Date(wallet.observationCutoffMs).toISOString()}, not yet settled`
        : `settled to ${new Date(wallet.observationCutoffMs).toISOString()}`
    out.write(`${terminalText(wallet.address)} ${new Date(wallet.fromMs).toISOString()} to ${to} (${state})\n`)
  }
  const positions = Array.isArray(section.positions) ? section.positions : []
  if (positions.length) {
    out.write("Open perps:\n")
    for (const position of positions) out.write(`${positionLine(position)}\n`)
  }
  if (section.historyPartial) {
    const reasons = Array.isArray(section.partialReasons) ? section.partialReasons.map(terminalText).join(", ") : ""
    out.write(`These figures are partial${reasons ? ` (${reasons})` : ""}.\n`)
  }
}

/** Funding reads earned or paid: `fundingNetUsd` is positive when earned (I8). */
function positionLine(p: HyperliquidPerpsPosition): string {
  const funding = Number(p.fundingNetUsd)
  const fundingText = `${funding < 0 ? "paid" : "earned"} ${formatUsd(Math.abs(funding))} funding`
  const pnl = p.markPx === null ? "no mark" : `${formatUsd(Number(p.unrealizedPnlUsd))} unrealized`
  const liquidation = p.liquidationPx === null ? "no liquidation price" : `liquidation ${terminalText(p.liquidationPx)}`
  return `  ${terminalText(p.coin)} ${p.leverage.value}x ${p.side === "long" ? "Long" : "Short"} ${terminalText(p.size)}: entry ${terminalText(p.entryPx)}, mark ${p.markPx === null ? "-" : terminalText(p.markPx)}, ${pnl}, ${fundingText}, ${liquidation}`
}
