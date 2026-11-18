import { parseArgs } from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { formatTime, renderTable, terminalText, writeFailure, writeLocalFailure, writeUsageFailure } from "../render"
import { formatPrice, formatUsd } from "../usd"
import { PROFILE_ID, SLUG } from "./agent-positions"
import { tradingFailure } from "./swap"

const USAGE = "Usage: candle agent round <profile-id|slug> <round-id|open:COIN> [--json]"
const ROUND_ID = /^(?:rnd_[0-9a-f]{16}|open:(?:[A-Za-z0-9]{1,12}:)?[A-Za-z0-9]{1,20})$/

interface Round {
  id: string
  coin: string
  side: "long" | "short"
  outcome: "open" | "won" | "lost" | "liquidated"
  leverage: { value: number; type: string } | null
  openedMs: number
  closedMs: number | null
  durationMs: number
  size: { peak: string; current: string }
  entryAvgPx: string | null
  exitAvgPx: string | null
  markPx: string | null
  liquidationPx: string | null
  initialMarginUsd: number | null
  returnOnMargin: number | null
  realizedUsd: number
  unrealizedUsd: number | null
  fundingUsd: number
  hyperliquidFeesUsd: number
  builderFeesUsd: number
  pnlUsd: number
  fills: {
    time: number
    side: string
    role: string
    px: string
    sz: string
    feeUsd: number
    closedPnlUsd: number
    liquidated: boolean
    hash: string
  }[]
  funding: { time: number; usd: number; rate: string; hash: string }[]
  complete: boolean
  asOfMs: number | null
}

const pct = (fraction: number) => `${fraction >= 0 ? "+" : ""}${(fraction * 100).toFixed(1)}%`
const duration = (ms: number) => {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 120) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

/** "Long BTC 20x": the label every position carries (Andrew B1); "leverage not recorded" when unknown. */
export function roundLabel(r: Pick<Round, "side" | "coin" | "leverage">): string {
  const side = r.side === "long" ? "Long" : "Short"
  return `${side} ${r.coin} ${r.leverage ? `${r.leverage.value}x` : "(leverage not recorded)"}`
}

function render(r: Round, now: number): string {
  const lines: string[] = []
  lines.push(`${roundLabel(r)}: ${r.outcome}`)
  lines.push(
    `Opened ${formatTime(r.openedMs, { now })}${r.closedMs === null ? ", still open" : `, closed ${formatTime(r.closedMs, { now })}`} (${duration(r.durationMs)})`,
  )
  const px = (v: string | null) => (v === null ? "–" : formatPrice(Number(v)))
  lines.push(
    `Size ${r.size.peak} at most${r.closedMs === null ? `, ${r.size.current} now` : ""}; entry ${px(r.entryAvgPx)}; ${
      r.closedMs === null ? `mark ${px(r.markPx)}; liquidation ${px(r.liquidationPx)}` : `exit ${px(r.exitAvgPx)}`
    }`,
  )
  const roe =
    r.returnOnMargin === null
      ? "return on margin unknown (leverage not recorded)"
      : `${pct(r.returnOnMargin)} on ${formatUsd(r.initialMarginUsd ?? 0)} initial margin`
  lines.push(`P&L ${formatUsd(r.pnlUsd, { signed: true })}, ${roe}`)
  lines.push(
    `Realized ${formatUsd(r.realizedUsd, { signed: true })}${r.unrealizedUsd === null ? "" : `, unrealized ${formatUsd(r.unrealizedUsd, { signed: true })}`}; funding ${formatUsd(r.fundingUsd, { signed: true })}; fees ${formatUsd(r.hyperliquidFeesUsd)} Hyperliquid + ${formatUsd(r.builderFeesUsd)} Candle builder fee`,
  )
  lines.push("", "Fills")
  lines.push(
    renderTable(
      ["Time", "Fill", "Side", "Price", "Size", "Fee", "Closed P&L", "Hash"],
      r.fills.map((f) =>
        [
          formatTime(f.time, { now }),
          f.liquidated ? `${f.role} (liquidated)` : f.role,
          f.side,
          formatPrice(Number(f.px)),
          f.sz,
          formatUsd(f.feeUsd),
          formatUsd(f.closedPnlUsd, { signed: true }),
          f.hash,
        ].map(terminalText),
      ),
    ),
  )
  if (r.funding.length) {
    lines.push("", `Funding (${formatUsd(r.fundingUsd, { signed: true })} in total)`)
    lines.push(
      renderTable(
        ["Time", "Amount", "Rate"],
        r.funding.map((f) =>
          [formatTime(f.time, { now }), formatUsd(f.usd, { signed: true }), f.rate].map(terminalText),
        ),
      ),
    )
  }
  lines.push(
    "",
    `As of ${formatTime(r.asOfMs, { now, missing: "unknown" })}${r.complete ? "" : "; the record of this round is incomplete"}`,
  )
  return lines.join("\n")
}

/**
 * `candle agent round`: one perp round of a published agent, from the public round read
 * (`GET /api/v1/agent/records/:profileId/perps/rounds/:roundId`). Public: no key is read or sent. For
 * an open round the agent's open limit and take-profit / stop orders on that coin follow.
 */
export async function agentRound(args: string[], ctx: CommandContext): Promise<number> {
  const usage = (message = USAGE) => {
    writeUsageFailure(ctx.deps, message, ctx.json)
    return 2
  }
  const parsed = parseArgs(args, {})
  if ("error" in parsed) return usage(`${parsed.error}\n${USAGE}`)
  const named = parsed.positionals[0]?.toLowerCase()
  const roundId = parsed.positionals[1]
  if (
    parsed.positionals.length !== 2 ||
    !named ||
    (!PROFILE_ID.test(named) && !SLUG.test(named)) ||
    !roundId ||
    !ROUND_ID.test(roundId)
  )
    return usage()
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
    const result = await request(
      `/api/v1/agent/records/${encodeURIComponent(profileId)}/perps/rounds/${encodeURIComponent(roundId)}`,
    )
    if (!result.ok) {
      writeFailure(ctx.deps, result, { apiUrl: ctx.apiUrl, authType: "none" }, ctx.json)
      return 1
    }
    const round = (result.body as { round: Round }).round
    // An open round shows the agent's open orders on its coin (public on-chain); a failed read never hides the round.
    let orders: unknown[] | null = null
    if (round.outcome === "open") {
      const read = await request(`/api/v1/agent/records/${encodeURIComponent(profileId)}/open-orders`)
      if (read.ok)
        orders = ((read.body as { orders: { coin: string }[] }).orders ?? []).filter((o) => o.coin === round.coin)
    }
    if (ctx.json) {
      ctx.deps.stdout.write(
        `${JSON.stringify(orders ? { ...(result.body as object), openOrders: orders } : result.body)}\n`,
      )
      return 0
    }
    const { renderOpenOrders } = await import("./agent-positions")
    const tail = orders
      ? renderOpenOrders({ orders: orders as never, readAt: ctx.deps.now(), stale: false }, ctx.deps.now())
      : []
    ctx.deps.stdout.write(`${[render(round, ctx.deps.now()), ...tail].join("\n")}\n`)
    return 0
  } catch (err) {
    return tradingFailure(ctx, err)
  }
}
