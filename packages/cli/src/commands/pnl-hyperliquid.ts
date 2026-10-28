import type { CommandContext } from "../deps"
import type { HyperliquidPerpsPosition, HyperliquidPnlSection } from "../hyperliquid-pnl"
import { fields, notice, symbols, terminalStyle } from "../presentation"
import { formatTime, terminalText } from "../render"
import { formatUsd } from "../usd"
import { financialHeading, writeFinancialLines } from "./financial-output"

/** R7 as amended (agent-page perps §8.2): a separate heading and net, also counted in the total. */
export function writeHyperliquidPnl(ctx: CommandContext, section: HyperliquidPnlSection | undefined): void {
  if (!section) return
  const out = ctx.deps.stdout
  const style = terminalStyle(ctx.deps, "stdout")
  const time = (ms: number) => formatTime(ms, { now: ctx.deps.now() })
  out.write(`\n${financialHeading("Hyperliquid", style)}\n`)
  if (!section.read) {
    notice(ctx.deps, "stdout", "warning", `Unavailable: ${terminalText(section.reason)}`)
    return
  }
  out.write(`${fields([["Network", section.network]], style).join("\n")}\n`)
  const usd = (value: number) => formatUsd(value, { signed: true })
  const rows = [
    ["Realized gross", usd(section.realizedGrossUsd), ""],
    ["Funding", usd(section.fundingUsd), "received positive, paid negative"],
    ["Fees", formatUsd(section.feesUsd), "includes builder fees"],
    ["Realized net", usd(section.realizedNetUsd), "gross + funding - fees"],
  ]
  // A server from before perps were counted sends no net: its figures are realized only.
  const realizedOnly = typeof section.netUsd !== "string" || typeof section.unrealizedUsd !== "string"
  const wallets = Array.isArray(section.byWallet) ? section.byWallet : []
  if (!realizedOnly) {
    const live = wallets.some((w) => w.reconciliation === "live")
    const markedAt = typeof section.markedAt === "number" ? ` at ${time(section.markedAt)}` : ""
    rows.push(
      ["Unrealized", usd(Number(section.unrealizedUsd)), `open positions${markedAt}`],
      [
        "Net",
        usd(Number(section.netUsd)),
        `realized net + unrealized; in the total${live ? "; live, not yet settled" : ""}`,
      ],
    )
  }
  writeFinancialLines(ctx, rows)
  out.write(
    `${fields(
      [
        ["Fills", section.fills],
        ["Funding payments", section.fundingPayments],
      ],
      style,
    ).join("\n")}\n`,
  )
  if (realizedOnly) {
    notice(
      ctx.deps,
      "stdout",
      "warning",
      "This server reports realized perps only, for the current binding, outside the total.",
    )
    return
  }
  notice(ctx.deps, "stdout", "note", "Coverage: every EVM TEE wallet bound to this profile, per binding period.")
  for (const wallet of wallets) {
    const to = wallet.toMs === null ? "now" : time(wallet.toMs)
    const state =
      wallet.reconciliation === "live"
        ? `live to ${time(wallet.observationCutoffMs)}, not yet settled`
        : `settled to ${time(wallet.observationCutoffMs)}`
    // This is a field the user can copy, not a dense table: keep the complete address.
    out.write(
      `${fields(
        [
          ["Wallet", terminalText(wallet.address)],
          ["Binding", `${time(wallet.fromMs)} to ${to}`],
          ["Reconciliation", state],
        ],
        style,
      ).join("\n")}\n\n`,
    )
  }
  const positions = Array.isArray(section.positions) ? section.positions : []
  if (positions.length) {
    out.write(`${financialHeading("Open perps", style)}\n`)
    for (const position of positions) writePosition(ctx, position)
  }
  if (section.historyPartial) {
    const reasons = Array.isArray(section.partialReasons) ? section.partialReasons.map(terminalText).join(", ") : ""
    notice(ctx.deps, "stdout", "warning", `These figures are partial${reasons ? ` (${reasons})` : ""}.`)
  }
}

/** Funding reads earned or paid: `fundingNetUsd` is positive when earned (I8). */
function writePosition(ctx: CommandContext, p: HyperliquidPerpsPosition): void {
  const style = terminalStyle(ctx.deps, "stdout")
  const funding = Number(p.fundingNetUsd)
  ctx.deps.stdout.write(
    `${fields(
      [
        [
          "Position",
          `${terminalText(p.coin)} ${p.leverage.value}x ${p.side === "long" ? "Long" : "Short"} ${terminalText(p.size)}`,
        ],
        ["Entry", terminalText(p.entryPx)],
        ["Mark", p.markPx === null ? symbols(style).missing : terminalText(p.markPx)],
        ["Liquidation", p.liquidationPx === null ? "no liquidation price" : terminalText(p.liquidationPx)],
      ],
      style,
    ).join("\n")}\n`,
  )
  writeFinancialLines(ctx, [
    [
      "Unrealized",
      p.markPx === null ? symbols(style).missing : formatUsd(Number(p.unrealizedPnlUsd), { signed: true }),
      p.markPx === null ? "no mark; not counted" : "",
    ],
    [
      "Funding",
      formatUsd(funding, { signed: true }),
      `${funding < 0 ? "paid" : "earned"} ${formatUsd(Math.abs(funding))} funding`,
    ],
  ])
  ctx.deps.stdout.write("\n")
}
