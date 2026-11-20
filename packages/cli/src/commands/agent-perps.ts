import { parseArgs } from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { formatTime, renderTable, terminalText, writeFailure, writeLocalFailure, writeUsageFailure } from "../render"
import { formatUsd } from "../usd"
import { PROFILE_ID, SLUG } from "./agent-positions"
import { tradingFailure } from "./swap"

const USAGE = "Usage: candle agent <profile-id|slug> --perps [--window all|24h|7d|30d] [--json]"
const WINDOWS = ["all", "24h", "7d", "30d"] as const
type Window = (typeof WINDOWS)[number]

// Wire types are mirrored here so the standalone CLI needs no SDK runtime dependency.
/** BE-3775: `GET /api/v1/agent/records/:profileId/perps`'s summary. Null figures are unknown, never zero. */
export interface AgentPerpsSummaryFigures {
  available: true
  window: Window
  asOfMs: number | null
  coverageFromMs: number | null
  partial: boolean
  netUsd: number
  realizedUsd: number
  unrealizedUsd: number
  fundingUsd: number
  feesUsd: number
  volumeUsd: number | null
  builderDexVolumeUsd: number | null
  volumeUnpricedFills: number
  feesToVolumePct: number | null
  roundsClosed: number
  wins: number
  losses: number
  winRatePct: number | null
  largestWinUsd: number | null
  largestLossUsd: number | null
  highestLeverage: number | null
  averageLeverage: number | null
  leverageNotRecordedRounds: number | null
  liquidations: number | null
  maxDrawdownUsd: number | null
  perpsProvisional?: true
  perpsCertifiedAsOfMs?: number
}
type Summary = AgentPerpsSummaryFigures | { available: false; window: Window; asOfMs: number | null; partial: true }
interface Answer {
  window: Window
  summary: Summary | null
}

const WINDOW_LABEL: Record<Window, string> = { all: "all time", "24h": "24h", "7d": "7d", "30d": "30d" }
const unknown = "unknown"
const usd = (n: number | null, signed = false) => (n === null ? unknown : formatUsd(n, { signed }))
const lev = (n: number | null) => (n === null ? "not recorded" : `${Number(n.toFixed(2))}x`)

/** The summary as label / value / formula rows: what each figure is, as the page's tooltip says it. */
export function summaryRows(s: AgentPerpsSummaryFigures): string[][] {
  const notRecorded = s.leverageNotRecordedRounds
    ? ` (${s.leverageNotRecordedRounds} round${s.leverageNotRecordedRounds === 1 ? "" : "s"} with leverage not recorded left out)`
    : ""
  return [
    ["Perps P&L", usd(s.netUsd, true), "realized + funding - fees + unrealized change"],
    ["Realized", usd(s.realizedUsd, true), "closed P&L of the fills in the window"],
    ["Unrealized", usd(s.unrealizedUsd, true), s.window === "all" ? "open positions now" : "change over the window"],
    ["Funding", usd(s.fundingUsd, true), "positive when received"],
    ["Fees", usd(s.feesUsd), "Hyperliquid fees, Candle's builder fee included"],
    [
      "Volume",
      `${usd(s.volumeUsd)}${s.volumeUnpricedFills ? ` (${s.volumeUnpricedFills} fills without a price left out)` : ""}`,
      `sum of price x size per fill${s.builderDexVolumeUsd ? `, ${formatUsd(s.builderDexVolumeUsd)} on builder dexes` : ""}`,
    ],
    [
      "Fees to volume",
      s.feesToVolumePct === null ? unknown : `${s.feesToVolumePct.toFixed(4)}%`,
      "fees / main-exchange volume",
    ],
    ["Rounds closed", String(s.roundsClosed), "open to flat, counted at the close"],
    [
      "Win rate",
      s.winRatePct === null ? "-" : `${s.winRatePct.toFixed(1)}% (${s.wins}W ${s.losses}L)`,
      "wins / (wins + losses)",
    ],
    ["Largest win", s.largestWinUsd === null ? "-" : usd(s.largestWinUsd, true), "best round above zero"],
    ["Largest loss", s.largestLossUsd === null ? "-" : usd(s.largestLossUsd, true), "worst round below zero"],
    ["Highest leverage", lev(s.highestLeverage), `rounds closed in the window${notRecorded}`],
    ["Average leverage", lev(s.averageLeverage), `mean over those rounds${notRecorded}`],
    ["Liquidations", s.liquidations === null ? unknown : String(s.liquidations), "rounds closed by a liquidation"],
    [
      "Max drawdown",
      s.maxDrawdownUsd === null ? unknown : formatUsd(s.maxDrawdownUsd),
      "peak to trough of cumulative perps P&L",
    ],
  ]
}

function render(answer: Answer, now: number): string {
  const s = answer.summary
  const label = WINDOW_LABEL[answer.window]
  if (s === null) return `No perps history (${label}).`
  if (!s.available) return `Perps delayed since ${formatTime(s.asOfMs, { now, missing: "never" })}; no summary now.`
  const lines = [
    `Perps summary, ${label}${s.partial ? " (partial)" : ""}`,
    `As of ${formatTime(s.asOfMs, { now, missing: "never" })}${
      s.perpsProvisional ? `; certified ${formatTime(s.perpsCertifiedAsOfMs ?? null, { now, missing: "never" })}` : ""
    }`,
  ]
  if (s.coverageFromMs !== null) lines.push(`Recorded since ${new Date(s.coverageFromMs).toISOString().slice(0, 10)}`)
  lines.push(
    "",
    renderTable(
      ["Figure", "Value", "How"],
      summaryRows(s).map((r) => r.map(terminalText)),
    ),
  )
  return lines.join("\n")
}

/**
 * `candle agent <profile-id|slug> --perps`: one published agent's Hyperliquid perps summary for a
 * window, from the public read (`GET /api/v1/agent/records/:profileId/perps`), the same figures as its
 * agent page. Public: no key is read or sent. A slug is resolved through the public slug read first.
 * `--json` prints the route body.
 */
export async function agentPerps(args: string[], ctx: CommandContext): Promise<number> {
  const usage = (message = USAGE) => {
    writeUsageFailure(ctx.deps, message, ctx.json)
    return 2
  }
  const parsed = parseArgs(args, { valueFlags: ["--window"], booleanFlags: ["--perps"] })
  if ("error" in parsed) return usage(`${parsed.error}\n${USAGE}`)
  const named = parsed.positionals[0]?.toLowerCase()
  if (!parsed.booleans.has("--perps")) return usage()
  if (parsed.positionals.length !== 1 || !named || (!PROFILE_ID.test(named) && !SLUG.test(named))) return usage()
  const window = parsed.values["--window"] ?? "all"
  if (!(WINDOWS as readonly string[]).includes(window)) return usage(`--window must be all, 24h, 7d or 30d\n${USAGE}`)

  const request = (path: string) =>
    apiRequest(path, { apiUrl: ctx.apiUrl, credentials: {}, auth: "none", fetch: ctx.deps.fetch, env: ctx.deps.env })
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
    const result = await request(`/api/v1/agent/records/${encodeURIComponent(profileId)}/perps?window=${window}`)
    if (!result.ok) {
      writeFailure(ctx.deps, result, { apiUrl: ctx.apiUrl, authType: "none" }, ctx.json)
      return 1
    }
    if (ctx.json) ctx.deps.stdout.write(`${JSON.stringify(result.body)}\n`)
    else ctx.deps.stdout.write(`${render(result.body as Answer, Date.now())}\n`)
    return 0
  } catch (err) {
    return tradingFailure(ctx, err)
  }
}
