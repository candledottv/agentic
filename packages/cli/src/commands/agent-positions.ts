import { parseArgs } from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { formatTime, renderTable, terminalText, writeFailure, writeLocalFailure, writeUsageFailure } from "../render"
import { formatPrice, formatQuantity, formatUsd } from "../usd"
import { tradingFailure } from "./swap"

const USAGE = "Usage: candle agent positions <profile-id|slug> [--kind spot|perp] [--orders] [--json]"
export const PROFILE_ID = /^prof_[0-9a-f]{16}$/
/** The public slug shape (`AGENT_PUBLIC_SLUG`, packages/shared); the server checks it again. */
export const SLUG = /^[a-z0-9][a-z0-9_-]{2,29}$/

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

interface OpenOrder {
  coin: string
  kind: "limit" | "take_profit" | "stop_loss" | "trigger"
  side: "buy" | "sell"
  limitPx: string | null
  triggerPx: string | null
  size: string
  reduceOnly: boolean
}
interface OpenOrders {
  orders: OpenOrder[]
  readAt: number | null
  stale: boolean
}

const KIND_LABEL: Record<OpenOrder["kind"], string> = {
  limit: "limit",
  take_profit: "take profit",
  stop_loss: "stop",
  trigger: "trigger",
}

/** The agent's open orders, public on Hyperliquid; nothing is printed for an agent with none. */
export function renderOpenOrders(body: OpenOrders, now: number): string[] {
  if (!body.orders.length) return []
  const lines = [
    "",
    `Open orders (as of ${formatTime(body.readAt, { now, missing: "unknown" })}${body.stale ? ", stale" : ""})`,
  ]
  lines.push(
    renderTable(
      ["Market", "Order", "Side", "Price", "Size"],
      body.orders.map((o) =>
        [
          o.coin,
          `${KIND_LABEL[o.kind]}${o.reduceOnly ? " (reduce only)" : ""}`,
          o.side,
          o.triggerPx !== null
            ? `trigger ${formatPrice(Number(o.triggerPx))}`
            : o.limitPx !== null
              ? formatPrice(Number(o.limitPx))
              : "market",
          o.size,
        ].map(terminalText),
      ),
    ),
  )
  return lines
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
  const parsed = parseArgs(args, { valueFlags: ["--kind"], booleanFlags: ["--orders"] })
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
    // BE-3756: an agent's open limit and take-profit / stop orders ride beside its perps. They are shown
    // when it holds a perp (or with --orders); a failed orders read never hides the positions.
    const positions = result.body as Positions
    const wantOrders =
      parsed.booleans.has("--orders") || (!ctx.json && positions.positions.some((p) => p.kind === "perp"))
    let orders: OpenOrders | null = null
    if (wantOrders) {
      const read = await request(`/api/v1/agent/records/${encodeURIComponent(profileId)}/open-orders`)
      if (!read.ok) {
        if (ctx.json) {
          writeFailure(ctx.deps, read, { apiUrl: ctx.apiUrl, authType: "none" }, ctx.json)
          return 1
        }
      } else if (Array.isArray((read.body as Partial<OpenOrders>).orders)) orders = read.body as OpenOrders
    }
    if (ctx.json)
      ctx.deps.stdout.write(
        `${JSON.stringify(orders ? { ...(positions as object), openOrders: orders } : positions)}\n`,
      )
    else {
      const now = ctx.deps.now()
      const extra = orders
        ? renderOpenOrders(orders, now)
        : wantOrders
          ? ["", "Open orders unavailable right now."]
          : []
      ctx.deps.stdout.write(`${[render(positions, now), ...extra].join("\n")}\n`)
    }
    return 0
  } catch (err) {
    return tradingFailure(ctx, err)
  }
}
