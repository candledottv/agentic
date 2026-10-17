/**
 * Hyperliquid risk and visibility (BE-1582, spec 2026-10-17-hyperliquid-phase1-a-risk-visibility-design.md
 * A-12): `candle_perps_account`, `candle_perps_risk`, `candle_perps_thresholds` and
 * `candle_perps_set_thresholds`, the additions to `candle_perps_positions`, and the Hyperliquid
 * section of the local `candle_get_portfolio`. Results have the shapes `candle perps ... --json`
 * prints.
 *
 * Every venue read goes from this server straight to Hyperliquid's public `/info` through the one
 * engine, `hyperliquid-risk.ts` (the SDK's file byte for byte). Candle is asked only for the key's
 * EVM TEE wallet and its thresholds. Nothing here signs, so none of these tools needs
 * `CANDLE_KEY_SIGNER_PEM_FILE`. An MCP server holds the agent key, so it may only tighten
 * thresholds (`PUT /keys/self/perps-risk`); the owner loosens from the CLI or a session.
 *
 * There is no watch tool: a tool call is one-shot. Poll `candle_perps_risk`.
 */
import { z } from "zod"
import type { RequestConfig } from "./client"
import {
  type HyperliquidInfoFetcher,
  HyperliquidReadError,
  type HyperliquidRiskNetwork,
  PERPS_RECENT_MAX_MS,
  type PerpsAccountLine,
  type PerpsPortfolioSection,
  type PerpsPositionRow,
  type PerpsRiskReport,
  type PerpsRiskThresholdsReport,
  perpsAccountReport,
  perpsPortfolioSection,
  perpsRiskFromLimits,
  readPerpsRecent,
  readPerpsRisk,
  unknownRiskReport,
} from "./hyperliquid-risk"
import type { FetchLike, ToolText } from "./orchestrate"
import { call, fail, type PerpsRiskToolName, Refusal, walletFor } from "./perps"

const wallet = z
  .string()
  .optional()
  .describe("The EVM TEE wallet by id, address or label. Omit when the key has exactly one.")
const bps = (what: string) => z.number().int().nullable().optional().describe(`${what}, in bps; null clears it`)

export const perpsRiskShapes = {
  candle_perps_account: {
    wallet,
    since: z
      .string()
      .optional()
      .describe(
        "The recent window: a duration back from now (30m, 24h, 7d) or an ISO time; default 24h, at most 30 days",
      ),
  },
  candle_perps_risk: { wallet },
  candle_perps_thresholds: {},
  candle_perps_set_thresholds: {
    warnDistanceBps: bps("Warn when a position is closer to liquidation than this (default 1500, 15%)"),
    criticalDistanceBps: bps("Critical when closer than this (default 700, 7%)"),
    warnMarginRatioBps: bps("Warn when the cross margin ratio is above this (default 6000, 0.6)"),
    criticalMarginRatioBps: bps("Critical when above this (default 8000, 0.8)"),
    clearBandBps: bps("How far past a threshold a watched level must move to clear (default 200)"),
    clear: z.boolean().optional().describe("true clears every stored threshold (refused when that would loosen)"),
  },
} as const

const network = (env: Record<string, string | undefined>): HyperliquidRiskNetwork =>
  env.CANDLE_HYPERLIQUID_NETWORK === "testnet" ? "testnet" : "mainnet"

const fetcherOf = (fetch: FetchLike) => fetch as unknown as HyperliquidInfoFetcher

async function thresholds(cfg: RequestConfig, fetch: FetchLike): Promise<PerpsRiskThresholdsReport> {
  try {
    return perpsRiskFromLimits(await call(cfg, fetch, "GET", "/api/v1/agent/keys/self/limits")).thresholds
  } catch {
    // E6: a failed thresholds read is never a refusal.
    return perpsRiskFromLimits(null).thresholds
  }
}

function sinceStart(value: unknown, now: number): number | string {
  if (value === undefined) return now - 24 * 3_600_000
  if (typeof value !== "string") return "since must be a string"
  const duration = /^([1-9][0-9]*)(m|h|d)$/.exec(value)
  const start = duration
    ? now - Number(duration[1]) * (duration[2] === "m" ? 60_000 : duration[2] === "h" ? 3_600_000 : 86_400_000)
    : Date.parse(value)
  if (!Number.isFinite(start)) return "since takes a duration (30m, 24h, 7d) or an ISO time"
  if (start >= now) return "since must be in the past"
  if (now - start > PERPS_RECENT_MAX_MS) return "since reaches back 30 days at most"
  return start
}

/** Run one risk tool. Warn and critical are results (`isError` false); unknown and failures are errors. */
export async function executePerpsRisk(
  tool: PerpsRiskToolName,
  args: Record<string, unknown>,
  cfg: RequestConfig,
  env: Record<string, string | undefined>,
  fetch: FetchLike,
): Promise<ToolText> {
  try {
    if (tool === "candle_perps_thresholds") {
      const { thresholds: report, stored } = perpsRiskFromLimits(
        await call(cfg, fetch, "GET", "/api/v1/agent/keys/self/limits"),
      )
      const { source, ...effective } = report
      return { text: JSON.stringify({ stored, effective, source }) }
    }
    if (tool === "candle_perps_set_thresholds") {
      const { clear, ...rest } = args
      const fields = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined))
      if (clear === true && Object.keys(fields).length > 0)
        return fail("MCP_VALIDATION", "Pass clear: true alone, or the thresholds to set; not both.")
      if (clear !== true && Object.keys(fields).length === 0)
        return fail("MCP_VALIDATION", "Name at least one threshold, or pass clear: true.")
      const answer = await call(cfg, fetch, "PUT", "/api/v1/agent/keys/self/perps-risk", {
        perpsRisk: clear === true ? null : fields,
      })
      return { text: JSON.stringify(answer) }
    }
    const name = typeof args.wallet === "string" ? args.wallet : undefined
    const { row } = await walletFor(cfg, fetch, name)
    const now = Date.now()
    const start = tool === "candle_perps_account" ? sinceStart(args.since, now) : now
    if (typeof start === "string") return fail("MCP_VALIDATION", start)
    const net = network(env)
    const report = readPerpsRisk({
      fetcher: fetcherOf(fetch),
      network: net,
      walletId: row.id,
      address: row.address,
      thresholds: await thresholds(cfg, fetch),
      now: Date.now,
    })
    if (tool === "candle_perps_account") {
      const [risk, recent] = await Promise.all([
        report,
        readPerpsRecent(fetcherOf(fetch), net, row.address, { startTime: start, endTime: now }),
      ])
      return { text: JSON.stringify(perpsAccountReport(risk, recent)) }
    }
    const risk = await report
    if (risk.level === "unknown")
      return fail(risk.reason ?? "PERPS_READ_FAILED", "No level was computed.", { report: risk })
    return { text: JSON.stringify(risk) }
  } catch (error) {
    if (error instanceof Refusal) return error.tool
    if (error instanceof HyperliquidReadError)
      return fail("PERPS_READ_FAILED", `${error.message}. No level was computed.`)
    return fail("PERPS_READ_FAILED", error instanceof Error ? error.message : "Hyperliquid read failed")
  }
}

/** `candle_perps_positions`'s additions (A-3); a failed direct read is `risk.level: "unknown"`, never a failed tool. */
export async function positionsAdditions(
  cfg: RequestConfig,
  fetch: FetchLike,
  env: Record<string, string | undefined>,
  row: { id: string; address: string },
): Promise<{
  rows: PerpsPositionRow[]
  accountLine: PerpsAccountLine | null
  risk: Omit<PerpsRiskReport, "positions">
}> {
  const t = await thresholds(cfg, fetch)
  const identity = { walletId: row.id, address: row.address, network: network(env) }
  let report: PerpsRiskReport
  try {
    report = await readPerpsRisk({ ...identity, fetcher: fetcherOf(fetch), thresholds: t, now: Date.now })
  } catch {
    report = unknownRiskReport(identity, t, "PERPS_READ_FAILED", Date.now())
  }
  const { positions, ...risk } = report
  return { rows: positions, accountLine: report.account, risk }
}

/**
 * The local `candle_get_portfolio`'s `hyperliquid` section (A-11, D6): each EVM TEE wallet in the
 * answer's `hood.tee`, read on Hyperliquid at the default thresholds. Added to a successful JSON
 * answer only; every existing field is untouched and the section is never in any total.
 */
export async function withPortfolioSection(
  text: string,
  fetch: FetchLike,
  env: Record<string, string | undefined>,
): Promise<string> {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return text
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return text
  const hood = (body as { hood?: { tee?: { id?: string; address?: string; label?: string }[] } }).hood
  const accounts = (hood?.tee ?? [])
    .filter((row) => typeof row.address === "string")
    .map((row) => ({
      address: row.address as string,
      ...(typeof row.label === "string" ? { label: row.label } : {}),
      ...(typeof row.id === "string" ? { walletId: row.id } : {}),
    }))
  const section: PerpsPortfolioSection = await perpsPortfolioSection(fetcherOf(fetch), network(env), accounts)
  return JSON.stringify({ ...(body as Record<string, unknown>), hyperliquid: section })
}
