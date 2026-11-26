import { parseArgs } from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { terminalText, writeFailure, writeUsageFailure } from "../render"
import { formatUsd } from "../usd"
import { tradingFailure } from "./swap"

// Wire types are mirrored here so the standalone CLI needs no SDK runtime dependency.
/** A certified, closed Hyperliquid round. Coin names preserve builder dex prefixes. */
export interface AgentPerpRound {
  kind: "perp_round"
  coin: string
  side: "long" | "short"
  leverage: { value: number; type: string } | null
  leverageSource?: "order" | "snapshot" | null
  pnlUsd: number
  liquidated: boolean
  openedMs: number | null
  closedMs: number
  hash: string | null
  size?: string | null
  entryPx?: number | null
  exitPx?: number | null
  initialMarginUsd?: number | null
  returnPct?: number | null
  fundingUsd?: number
  feesUsd?: number
  durationMs?: number | null
}

export interface AgentRecordTrade {
  kind?: "trade"
  signature: string
  signatures?: string[]
  side: "buy" | "sell"
  mint: string
  chain?: string
  symbol?: string
  timestampMs: number
  firstTimestampMs?: number
  lastTimestampMs?: number
  counted: boolean
  sells?: number
  usdAmount?: number
  realizedNetUsd?: number
  returnPct?: number
  [key: string]: unknown
}

export interface AgentPerpsFigures {
  perpsRealizedUsd?: number
  perpsFundingUsd?: number
  perpsFeesUsd?: number
  perpsUnrealizedUsd?: number
  perpsNetUsd?: number
  perpsAsOfMs?: number
  perpsCoverageFromMs?: number
  perpsSnapshotId?: string
  perpsUnavailable?: boolean
  perpsPartial?: boolean
}

/**
 * BE-4221: the Hyperliquid spot part of the record's Spot bucket (all time on the record). It is already
 * inside the spot totals; the block shows that part on its own. Absent on an older API and for an agent
 * with no Hyperliquid spot activity.
 */
export interface AgentHyperliquidSpotFigures {
  realizedUsd: number
  unrealizedUsd: number
  feesUsd: number
  volumeUsd: number
  trades: number
  unpriced: number
  untrackedSoldCoins: number
  partial: boolean
  partialReasons?: string[]
}

interface AgentPublicRecord extends AgentPerpsFigures {
  name: string
  rows?: (AgentRecordTrade | AgentPerpRound)[]
  rowsCursor?: string | null
  sharpeDaily?: number | null
  sharpeDays?: number
  sharpePartialDays?: number
  spotTopCloses?: AgentRecordTrade[]
  perpTopCloses?: AgentPerpRound[]
  hyperliquidSpot?: AgentHyperliquidSpotFigures
  totals?: { hyperliquidSpot?: AgentHyperliquidSpotFigures }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * One line for the Hyperliquid spot part of the Spot P&L, or null when the answer has none (an older API,
 * or an agent with no Hyperliquid spot activity), so those answers print exactly as before. A partial
 * figure is a floor and says so; it is never shown as zero.
 */
export function renderHyperliquidSpot(h: AgentHyperliquidSpotFigures | undefined): string | null {
  if (!h || typeof h.realizedUsd !== "number" || typeof h.unrealizedUsd !== "number") return null
  const notes = [
    h.unpriced > 0 ? `${h.unpriced} unpriced` : "",
    h.untrackedSoldCoins > 0 ? `${plural(h.untrackedSoldCoins, "coin")} sold beyond the tracked quantity` : "",
    h.partial
      ? `partial, a floor${h.partialReasons?.length ? ` (${h.partialReasons.map(terminalText).join(", ")})` : ""}`
      : "",
  ].filter(Boolean)
  return [
    `Spot P&L includes Hyperliquid spot: realized ${formatUsd(h.realizedUsd, { signed: true })}, unrealized ${formatUsd(h.unrealizedUsd, { signed: true })}`,
    `fees ${formatUsd(h.feesUsd)}, volume ${formatUsd(h.volumeUsd)}, ${plural(h.trades, "trade")}`,
    ...notes,
  ].join(" · ")
}

export function renderRound(r: AgentPerpRound): string {
  const label = `${r.side === "long" ? "Long" : "Short"} ${r.coin} ${r.leverage ? `${r.leverage.value}x` : "leverage not recorded"}`
  return [
    label,
    `size ${r.size ?? "unknown"}`,
    `entry ${r.entryPx ?? "unknown"}`,
    `exit ${r.exitPx ?? "unknown"}`,
    formatUsd(r.pnlUsd, { signed: true }),
    r.returnPct == null ? "ROE unknown" : `${r.returnPct.toFixed(1)}% ROE`,
    `funding ${r.fundingUsd ?? "unknown"}`,
    `fees ${r.feesUsd ?? "unknown"}`,
    `duration ${r.durationMs == null ? "unknown" : `${r.durationMs / 1000}s`}`,
    r.liquidated ? "LIQUIDATED" : "",
    r.hash ? `https://app.hyperliquid.xyz/explorer/tx/${encodeURIComponent(r.hash)}` : "",
  ]
    .filter(Boolean)
    .map(terminalText)
    .join(" · ")
}

/** Public, credential-free, newest first. The cursor pins both spot and perps snapshots. */
export async function agentRecord(args: string[], ctx: CommandContext): Promise<number> {
  const usage = "Usage: candle agent record <profile-id> [--cursor cursor] [--json]"
  const parsed = parseArgs(args, { valueFlags: ["--cursor"] })
  if (
    "error" in parsed ||
    parsed.positionals.length !== 1 ||
    !/^prof_[0-9a-f]{16}$/.test(parsed.positionals[0] ?? "")
  ) {
    writeUsageFailure(ctx.deps, usage, ctx.json)
    return 2
  }
  const params = new URLSearchParams({ rows: "all" })
  if (parsed.values["--cursor"] !== undefined) params.set("cursor", parsed.values["--cursor"])
  try {
    const result = await apiRequest(
      `/api/v1/agent/records/${encodeURIComponent(parsed.positionals[0] ?? "")}?${params}`,
      {
        apiUrl: ctx.apiUrl,
        credentials: {},
        auth: "none",
        fetch: ctx.deps.fetch,
        env: ctx.deps.env,
      },
    )
    if (!result.ok) {
      writeFailure(ctx.deps, result, { apiUrl: ctx.apiUrl, authType: "none" }, ctx.json)
      return 1
    }
    if (ctx.json) ctx.deps.stdout.write(`${JSON.stringify(result.body)}\n`)
    else {
      const r = (result.body as { record: AgentPublicRecord }).record
      const stamp = r.perpsAsOfMs === undefined ? "not recorded" : new Date(r.perpsAsOfMs).toISOString()
      const lines = [
        terminalText(r.name),
        `Perps as of ${stamp}${r.perpsUnavailable ? " (unavailable)" : r.perpsPartial ? " (partial)" : ""}`,
      ]
      const hyperliquidSpot = renderHyperliquidSpot(r.hyperliquidSpot ?? r.totals?.hyperliquidSpot)
      if (hyperliquidSpot) lines.push(hyperliquidSpot)
      for (const row of r.rows ?? [])
        lines.push(
          row.kind === "perp_round"
            ? renderRound(row)
            : terminalText(`${row.side} ${row.symbol ?? row.mint} ${row.usdAmount ?? ""}`),
        )
      if (r.rowsCursor) lines.push(`Next page: --cursor ${terminalText(r.rowsCursor)}`)
      ctx.deps.stdout.write(`${lines.join("\n")}\n`)
    }
    return 0
  } catch (err) {
    return tradingFailure(ctx, err)
  }
}
