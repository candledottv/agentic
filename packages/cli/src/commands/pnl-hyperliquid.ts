import type { CommandContext } from "../deps"
import type { HyperliquidPnlSection } from "../hyperliquid-pnl"
import { terminalText } from "../render"
import { formatUsd } from "../usd"

/** R7: a separate heading and net, never added to the spot/LP total. */
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
  out.write(`${section.fills} fills; ${section.fundingPayments} funding payments. Unrealized perps are excluded.\n`)
  out.write("Coverage: currently bound EVM TEE wallets since the current TEE binding; previous bindings excluded.\n")
  for (const wallet of section.byWallet) {
    out.write(`${terminalText(wallet.address)} since ${new Date(wallet.startTime).toISOString()}\n`)
  }
  if (section.truncated) {
    out.write(
      `History is truncated: at most ${section.fillsLimit} recent fills and ${section.fundingLimit} funding rows per wallet, ${section.walletsLimit} wallets. This is a partial figure.\n`,
    )
  }
}
