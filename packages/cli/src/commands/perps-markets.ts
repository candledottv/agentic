/**
 * Spec B: key-required public market reads. No wallet or signer is opened.
 *
 * `--json` is the reader's result object, unchanged, and the same object `candle_perps_markets`,
 * `candle_perps_market`, `candle_perps_book` and `candle_perps_candles` return. Each command has
 * one shape (`markets`, `market`, `book` or `candles` on the shared envelope). Human text below
 * is only the `markets` screen.
 */

import { ApiKeyFileError } from "../../../mcp/src/api-key-file"
import { parseArgs } from "../args"
import { apiRequest } from "../client"
import { type CommandContext, resolveApiKey } from "../deps"
import {
  PerpsMarketError,
  PerpsMarketReader,
  type PerpsMarketRow,
  type PerpsMarketSort,
  type PerpsMarketsResult,
} from "../hyperliquid-markets"
import { notice, symbols, terminalStyle } from "../presentation"
import { formatTime, renderTable, writeFailure, writeLocalFailure, writeUsageFailure } from "../render"
import { terminalLines } from "../terminal-text"
import { safeText } from "../trading"
import { formatUsd } from "../usd"
import { perpsRequest } from "./perps"
import { tradingFailure } from "./swap"

function marketUsd(value: string | null, missing: string, compact: boolean): string {
  if (value === null) return missing
  const n = Number(value)
  return Number.isFinite(n) ? formatUsd(n, { compact }) : missing
}

/** `change24hPct` is already a percent. Zero stays unsigned; a gain keeps its plus. */
function changeCell(value: string | null, missing: string): string {
  if (value === null) return missing
  const n = Number(value)
  if (!Number.isFinite(n)) return safeText(value)
  const body = `${Math.abs(n).toFixed(1)}%`
  if (n > 0) return `+${body}`
  if (n < 0) return `-${body}`
  return body
}

function fundingCell(rate: string | null, missing: string): string {
  if (rate === null) return missing
  const n = Number(rate) * 100
  return Number.isFinite(n) ? `${n.toFixed(4)}%` : missing
}

function flagCell(row: PerpsMarketRow): string {
  return [
    row.onlyIsolated ? "iso" : "",
    row.atOpenInterestCap ? "cap" : "",
    // BE-3755: a builder market whose fee is above 2x the main exchange's.
    row.terms?.feeWarning ? `fee:${row.terms.feeMultiplier}x` : "",
    row.candle.tradeable === false
      ? `x:${row.candle.reason}`
      : row.candle.tradeable === null
        ? "?:networkMismatch"
        : "",
  ]
    .filter(Boolean)
    .join(",")
}

/** The markets screen (CLI legibility audit 4.6). Book, candles and one market stay as they are. */
function writeMarkets(ctx: CommandContext, result: PerpsMarketsResult): void {
  const style = terminalStyle(ctx.deps, "stdout")
  const missing = symbols(style).missing
  const rows = result.markets.map((row) => [
    safeText(row.coin),
    marketUsd(row.markPx, missing, false),
    changeCell(row.change24hPct, missing),
    fundingCell(row.fundingRate, missing),
    row.fundingAprPct === null ? missing : `${row.fundingAprPct}%`,
    marketUsd(row.openInterestUsd, missing, true),
    marketUsd(row.dayNotionalVolumeUsd, missing, true),
    `${row.maxLeverage}x`,
    flagCell(row),
  ])
  ctx.deps.stdout.write(
    `${renderTable(["COIN", "MARK", "24H", "FUNDING/H", "APR", "OI", "24H VOL", "LEV", "FLAGS"], rows, {
      style,
      width: style.width,
      indent: 2,
      columns: [
        { id: true },
        {},
        { signed: true, priority: 4 },
        { priority: 3 },
        { priority: 5 },
        {},
        { priority: 2 },
        {},
        { priority: 1 },
      ],
    })}\n`,
  )
  notice(
    ctx.deps,
    "stdout",
    "note",
    `Hyperliquid ${result.network}. OI floor ${formatUsd(result.gate.minOpenInterestUsd, { compact: true })} (${result.gate.source}). Tradeable now is Candle's build gate at read time, not a promise. OI caps may still refuse an order.`,
  )
  // BE-3755: `--dex` lists the builder dexes it covered: who deployed each, who sets its oracle,
  // its collateral, and whether Candle trades it now.
  for (const dex of result.dexes ?? [])
    notice(
      ctx.deps,
      "stdout",
      "note",
      safeText(
        `Builder dex ${dex.name} (${dex.fullName}): deployer ${dex.deployer}; oracle set by ${dex.oracleSetters.join(", ")}; collateral ${dex.collateral ?? "unknown"}; ${dex.tradeable === true ? "tradeable" : dex.tradeable === false ? "not tradeable on Candle" : "unavailable"}.`,
      ),
    )
}

/** BE-3755: the terms shown before an order on one market (dex, oracle, deployer, margin, fee). */
function termsLine(market: PerpsMarketRow): string {
  const t = market.terms
  const venue = t.dex
    ? `builder dex ${t.dex}${t.dexName ? ` (${t.dexName})` : ""}, deployer ${t.deployer}, oracle set by ${t.oracleSetters.join(", ")}`
    : "Hyperliquid main exchange, validator oracle"
  return safeText(
    `${market.coin}: ${venue}; ${t.marginMode === "isolated" ? "isolated margin only" : "cross or isolated margin"}; max ${market.maxLeverage}x; collateral ${t.collateral}; fee ${t.feeMultiplier}x the main exchange's (taker ${t.takerFeePct}%, maker ${t.makerFeePct}% at the base tier, before Candle's builder fee).`,
  )
}

interface MarketAgentsAnswer {
  market: {
    coin: string
    dex: string | null
    dexName: string | null
    deployer: string | null
    oracleSource: string
    markPx: string | null
    change24hPct: string | null
    fundingRate: string | null
    fundingAprPct: string | null
    openInterestUsd: string | null
    dayNotionalVolumeUsd: string | null
  }
  readAt: number
  agents: {
    long: number
    short: number
    netSize: string
    positions: {
      agent: { name: string | null; slug: string | null; profileId: string }
      label: string
      size: string
      entryPx: string
      markPx: string | null
      unrealizedPnlUsd: string
      returnOnEquity: string
      asOfMs: number | null
    }[]
    rounds: {
      agent: { name: string | null; slug: string | null; profileId: string }
      roundId: string | null
      side: string
      pnlUsd: number
      closedMs: number
    }[]
  } | null
}
const agentName = (a: { name: string | null; slug: string | null; profileId: string }) =>
  safeText(a.name ?? a.slug ?? a.profileId)
const roe = (fraction: string) => {
  const n = Number(fraction) * 100
  return Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(1)}%` : "-"
}

/**
 * `candle perps market <coin> --agents` (BE-3777): the public market read, which needs no key. The
 * market figures and the published agents long and short in it, from `GET /api/v1/agent/perps-markets/:coin`.
 */
async function marketAgents(ctx: CommandContext, coin: string): Promise<number> {
  try {
    const result = await apiRequest(`/api/v1/agent/perps-markets/${encodeURIComponent(coin)}`, {
      apiUrl: ctx.apiUrl,
      credentials: {},
      auth: "none",
      fetch: ctx.deps.fetch,
      env: ctx.deps.env,
    })
    if (!result.ok) {
      writeFailure(ctx.deps, result, { apiUrl: ctx.apiUrl, authType: "none" }, ctx.json)
      return 1
    }
    if (ctx.json) {
      ctx.deps.stdout.write(`${JSON.stringify(result.body)}\n`)
      return 0
    }
    const body = result.body as unknown as MarketAgentsAnswer
    const m = body.market
    const now = ctx.deps.now()
    const out = (line: string) => ctx.deps.stdout.write(`${terminalLines(line)}\n`)
    const dash = "-"
    out(
      safeText(
        `${m.coin}${m.dex ? ` (builder dex ${m.dex}, deployer ${m.deployer ?? "unknown"}, oracle set by the ${m.oracleSource})` : ""}: mark ${marketUsd(m.markPx, dash, false)}, 24h ${changeCell(m.change24hPct, dash)}, funding/h ${fundingCell(m.fundingRate, dash)}, open interest ${marketUsd(m.openInterestUsd, dash, true)}, 24h volume ${marketUsd(m.dayNotionalVolumeUsd, dash, true)}; as of ${formatTime(body.readAt, { now })}`,
      ),
    )
    const a = body.agents
    if (!a) {
      out("Candle agents: unavailable right now (the board has no complete build).")
      return 0
    }
    out(`Candle agents in ${safeText(m.coin)}: ${a.long} long, ${a.short} short, net size ${a.netSize}`)
    if (a.positions.length === 0) out("No public Candle agent holds an open position in this market.")
    else
      out(
        renderTable(
          ["Agent", "Position", "Size", "Entry", "Mark", "P&L (ROE)", "As of"],
          a.positions.map((p) =>
            [
              agentName(p.agent),
              p.label,
              p.size,
              p.entryPx,
              p.markPx ?? dash,
              `${formatUsd(Number(p.unrealizedPnlUsd), { signed: true })} (${roe(p.returnOnEquity)})`,
              formatTime(p.asOfMs, { now, missing: "unknown" }),
            ].map(safeText),
          ),
        ),
      )
    if (a.rounds.length) {
      out("")
      out("Recent closed rounds")
      out(
        renderTable(
          ["Agent", "Side", "P&L", "Closed", "Round"],
          a.rounds.map((r) =>
            [
              agentName(r.agent),
              r.side,
              formatUsd(r.pnlUsd, { signed: true }),
              formatTime(r.closedMs, { now }),
              r.roundId ?? dash,
            ].map(safeText),
          ),
        ),
      )
    }
    out("Measured record, not a forecast. Past results do not predict future results.")
    return 0
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}

type Command = "markets" | "market" | "book" | "candles"
const flags = {
  markets: ["--sort", "--limit", "--dex"],
  market: [],
  book: ["--depth", "--sig-figs"],
  candles: ["--interval", "--count", "--end"],
}
async function read(ctx: CommandContext, argv: string[], command: Command): Promise<number> {
  const parsed = parseArgs(argv, {
    valueFlags: flags[command],
    booleanFlags: command === "markets" ? ["--all"] : command === "market" ? ["--agents"] : [],
  })
  if ("error" in parsed) {
    writeUsageFailure(ctx.deps, parsed.error, ctx.json)
    return 2
  }
  if (parsed.positionals.length !== (command === "markets" ? 0 : 1)) {
    writeUsageFailure(
      ctx.deps,
      `Usage: candle perps ${command}${command === "markets" ? "" : " <coin>"} [flags]`,
      ctx.json,
    )
    return 2
  }
  if (command === "market" && parsed.booleans.has("--agents")) return marketAgents(ctx, parsed.positionals[0] ?? "")
  const values = parsed.values
  const number = (flag: string) => (values[flag] === undefined ? undefined : Number(values[flag]))
  try {
    const key = await resolveApiKey(ctx.deps, ctx.profile)
    const reader = new PerpsMarketReader({
      apiKey: key,
      network: ctx.deps.env.CANDLE_HYPERLIQUID_NETWORK === "testnet" ? "testnet" : "mainnet",
      fetcher: ctx.deps.fetch,
      now: ctx.deps.now,
      cacheMs: 0,
      readConfig: async () => perpsRequest(ctx, key as string, "/api/v1/agent/perps/config"),
    })
    const coin = parsed.positionals[0] ?? ""
    const result =
      command === "markets"
        ? await reader.markets({
            sort: values["--sort"] as PerpsMarketSort | undefined,
            limit: number("--limit"),
            all: parsed.booleans.has("--all"),
            dex: values["--dex"],
          })
        : command === "market"
          ? await reader.market(coin)
          : command === "book"
            ? await reader.book(coin, { depth: number("--depth"), sigFigs: number("--sig-figs") })
            : await reader.candles(coin, {
                interval: values["--interval"],
                count: number("--count"),
                end: values["--end"],
              })
    if (ctx.json) {
      ctx.deps.stdout.write(`${JSON.stringify(result)}\n`)
      return 0
    }
    if ("markets" in result) {
      for (const warning of result.warnings) notice(ctx.deps, "stderr", "warning", safeText(warning))
      writeMarkets(ctx, result)
      return 0
    }
    for (const warning of result.warnings) notice(ctx.deps, "stderr", "note", `${safeText(warning)}\n`.trim())
    const out = (line: string) => ctx.deps.stdout.write(`${terminalLines(line)}\n`)
    out(
      `Hyperliquid ${result.network}; OI floor $${result.gate.minOpenInterestUsd} (${result.gate.source}). Tradeability is Candle's build gate at read time, not a promise. OI caps may still refuse an order.`,
    )
    if ("market" in result) {
      out(termsLine(result.market))
      if (result.market.terms.feeWarning)
        notice(ctx.deps, "stdout", "warning", safeText(result.market.terms.feeWarning))
      out(JSON.stringify({ ...result.market, coin: safeText(result.market.coin) }, null, 2))
    } else if ("bids" in result) {
      out(`${safeText(result.coin)}: BID PX / SIZE / ORDERS | ASK PX / SIZE / ORDERS`)
      for (let i = 0; i < Math.max(result.bids.length, result.asks.length); i++) {
        const b = result.bids[i]
        const a = result.asks[i]
        out(`${b ? `${b.px} / ${b.sz} / ${b.n}` : "-"} | ${a ? `${a.px} / ${a.sz} / ${a.n}` : "-"}`)
      }
      out(`Spread ${result.spreadPx ?? "-"} (${result.spreadBps ?? "-"} bps); mid ${result.midPx ?? "-"}`)
    } else {
      out(`${safeText(result.coin)} ${result.interval}: TIME  OPEN  HIGH  LOW  CLOSE  BASE VOLUME  TRADES`)
      for (const c of result.candles)
        out(`${new Date(c.t).toISOString()}  ${c.o}  ${c.h}  ${c.l}  ${c.c}  ${c.v}  ${c.n}`)
    }
    return 0
  } catch (error) {
    if (error instanceof ApiKeyFileError) {
      writeLocalFailure(ctx.deps, { code: error.code, message: error.message }, ctx.json)
      return 1
    }
    if (error instanceof PerpsMarketError) {
      if (error.code === "PERPS_USAGE") {
        writeUsageFailure(ctx.deps, error.message, ctx.json)
        return 2
      }
      const failure = { code: error.code, message: error.message, retryable: error.retryable }
      writeLocalFailure(ctx.deps, failure, ctx.json)
      return 1
    }
    return tradingFailure(ctx, error)
  }
}
export const perpsMarkets = (argv: string[], ctx: CommandContext) => read(ctx, argv, "markets")
export const perpsMarket = (argv: string[], ctx: CommandContext) => read(ctx, argv, "market")
export const perpsBook = (argv: string[], ctx: CommandContext) => read(ctx, argv, "book")
export const perpsCandles = (argv: string[], ctx: CommandContext) => read(ctx, argv, "candles")
