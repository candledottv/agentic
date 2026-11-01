import { parseArgs } from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { formatTime, renderTable, terminalText, writeFailure, writeLocalFailure, writeUsageFailure } from "../render"
import { formatPrice, formatQuantity, formatUsd } from "../usd"
import { tradingFailure } from "./swap"

const USAGE = "Usage: candle agent positions <profile-id|slug> [--kind spot|perp] [--json]"
const PROFILE_ID = /^prof_[0-9a-f]{16}$/
/** The public slug shape (`AGENT_PUBLIC_SLUG`, packages/shared); the server checks it again. */
const SLUG = /^[a-z0-9][a-z0-9_-]{2,29}$/

interface SpotRow {
  kind: "spot"
  mint: string
  symbol: string | null
  quantity: number
  valueUsd: number
  unrealizedUsd?: number
  unrealizedPct?: number
}
interface PerpRow {
  kind: "perp"
  coin: string
  side: "long" | "short"
  size: string
  leverage: { value: number; type: string }
  markPx: string | null
  positionValueUsd: string
  marginUsedUsd: string
  unrealizedPnlUsd: string
  returnOnEquity: string
  liquidationPx: string | null
  liquidationDistance: number | null
  fundingNetUsd: string
}
interface Positions {
  asOfMs: number | null
  perpsPartial: boolean
  perpsUnavailable?: true
  portfolioValueUsd: number | null
  portfolioPartial: boolean
  hiddenDust: number
  unpriced: number
  positions: (SpotRow | PerpRow)[]
}

const pct = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`

/** One table row per position; perps read Fomo's way: "10x Short", margin, value, P&L and ROE. */
function rowOf(p: SpotRow | PerpRow): string[] {
  if (p.kind === "spot") {
    const pnl =
      p.unrealizedUsd === undefined
        ? "–"
        : `${formatUsd(p.unrealizedUsd, { signed: true })}${p.unrealizedPct === undefined ? "" : ` (${pct(p.unrealizedPct)})`}`
    return ["token", p.symbol ?? p.mint, formatQuantity(p.quantity), formatUsd(p.valueUsd), pnl, "–"]
  }
  const side = p.side === "long" ? "Long" : "Short"
  const pnl =
    p.markPx === null
      ? "no mark"
      : `${formatUsd(Number(p.unrealizedPnlUsd), { signed: true })} (${pct(Number(p.returnOnEquity) * 100)} ROE)`
  const funding = Number(p.fundingNetUsd)
  const liquidation =
    p.liquidationPx === null
      ? "no liquidation price"
      : `liq ${formatPrice(Number(p.liquidationPx))}${p.liquidationDistance === null ? "" : ` (${(p.liquidationDistance * 100).toFixed(1)}% away)`}`
  return [
    `perp ${p.leverage.value}x ${side} ${p.leverage.type}`,
    p.coin,
    p.size,
    `${formatUsd(Number(p.positionValueUsd))} (margin ${formatUsd(Number(p.marginUsedUsd))})`,
    pnl,
    `${liquidation}; funding ${funding < 0 ? "paid" : "earned"} ${formatUsd(Math.abs(funding))}`,
  ]
}

function render(body: Positions, now: number): string {
  const lines: string[] = []
  const value =
    body.portfolioValueUsd === null
      ? body.perpsUnavailable
        ? "unavailable (perps not reconciled yet)"
        : "unknown"
      : formatUsd(body.portfolioValueUsd)
  lines.push(`Portfolio ${value}${body.portfolioPartial && body.portfolioValueUsd !== null ? " (partial)" : ""}`)
  lines.push(
    `Updated ${formatTime(body.asOfMs, { now, missing: "never" })}${body.perpsPartial ? "; perps partial" : ""}`,
  )
  lines.push("")
  if (body.positions.length)
    // Symbols, coins and sizes come from market data anyone can influence: each cell is made safe.
    lines.push(
      renderTable(
        ["Kind", "Position", "Amount", "Value", "P&L", "Details"],
        body.positions.map((p) => rowOf(p).map(terminalText)),
      ),
    )
  else lines.push("No open positions.")
  const notes = [
    body.hiddenDust ? `${body.hiddenDust} small position${body.hiddenDust === 1 ? "" : "s"} under $1 hidden` : "",
    body.unpriced ? `${body.unpriced} position${body.unpriced === 1 ? "" : "s"} without a price` : "",
  ].filter(Boolean)
  if (notes.length) lines.push("", notes.join("; "))
  return lines.join("\n")
}

/**
 * `candle agent positions`: one published agent's open positions, spot and Hyperliquid perps, from
 * the public positions read (`GET /api/v1/agent/records/:profileId/positions`). Public: no key is
 * read or sent. A slug is resolved through the public slug read first. `--json` prints the route
 * body, including `publishedBuildId` (the board generation) and `seq` (the push resume cursor).
 */
export async function agentPositions(args: string[], ctx: CommandContext): Promise<number> {
  const usage = (message = USAGE) => {
    writeUsageFailure(ctx.deps, message, ctx.json)
    return 2
  }
  const parsed = parseArgs(args, { valueFlags: ["--kind"] })
  if ("error" in parsed) return usage(`${parsed.error}\n${USAGE}`)
  const { values, positionals } = parsed
  const named = positionals[0]?.toLowerCase()
  if (positionals.length !== 1 || !named || (!PROFILE_ID.test(named) && !SLUG.test(named))) return usage()
  const kind = values["--kind"]
  if (kind !== undefined && kind !== "spot" && kind !== "perp") return usage(`--kind must be spot or perp\n${USAGE}`)

  const request = (path: string) =>
    apiRequest(path, {
      apiUrl: ctx.apiUrl,
      credentials: {},
      auth: "none",
      fetch: ctx.deps.fetch,
      env: ctx.deps.env,
    })
  try {
    let profileId = named
    if (!PROFILE_ID.test(named)) {
      const resolved = await request(`/api/v1/agent/slug/${encodeURIComponent(named)}`)
      if (!resolved.ok) {
        writeFailure(ctx.deps, resolved, { apiUrl: ctx.apiUrl, authType: "none" }, ctx.json)
        return 1
      }
      const found = (resolved.body as { resolved?: { profileId?: unknown } | null }).resolved?.profileId
      if (typeof found !== "string") {
        writeLocalFailure(
          ctx.deps,
          { code: "RECORD_NOT_FOUND", message: `No published agent has the slug ${named}.` },
          ctx.json,
        )
        return 1
      }
      profileId = found
    }
    const query = kind === undefined ? "" : `?kind=${kind}`
    const result = await request(`/api/v1/agent/records/${encodeURIComponent(profileId)}/positions${query}`)
    if (!result.ok) {
      writeFailure(ctx.deps, result, { apiUrl: ctx.apiUrl, authType: "none" }, ctx.json)
      return 1
    }
    if (ctx.json) ctx.deps.stdout.write(`${JSON.stringify(result.body)}\n`)
    else ctx.deps.stdout.write(`${render(result.body as Positions, ctx.deps.now())}\n`)
    return 0
  } catch (err) {
    return tradingFailure(ctx, err)
  }
}
