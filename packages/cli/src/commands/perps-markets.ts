/** Spec B: key-required public market reads. No wallet or signer is opened. */
import { parseArgs } from "../args"
import { type CommandContext, resolveApiKey } from "../deps"
import { PerpsMarketError, PerpsMarketReader, type PerpsMarketSort } from "../hyperliquid-markets"
import { writeLocalFailure, writeUsageFailure } from "../render"
import { safeText } from "../trading"
import { perpsRequest } from "./perps"
import { tradingFailure } from "./swap"

type Command = "markets" | "market" | "book" | "candles"
const flags = {
  markets: ["--sort", "--limit"],
  market: [],
  book: ["--depth", "--sig-figs"],
  candles: ["--interval", "--count", "--end"],
}
async function read(ctx: CommandContext, argv: string[], command: Command): Promise<number> {
  const parsed = parseArgs(argv, { valueFlags: flags[command], booleanFlags: command === "markets" ? ["--all"] : [] })
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
    for (const warning of result.warnings) ctx.deps.stderr.write(`${safeText(warning)}\n`)
    const out = (line: string) => ctx.deps.stdout.write(`${line}\n`)
    out(
      `Hyperliquid ${result.network}; OI floor $${result.gate.minOpenInterestUsd} (${result.gate.source}). Tradeability is Candle's build gate at read time, not a promise. OI caps may still refuse an order.`,
    )
    const money = (n: string | null) => (n === null ? "-" : Number(n).toFixed(2))
    if ("markets" in result) {
      out("COIN  MARK USD  24H %  FUNDING %/h  APR %  OI USD  24H VOLUME USD  LEVERAGE  FLAGS")
      for (const row of result.markets)
        out(
          [
            safeText(row.coin),
            money(row.markPx),
            row.change24hPct ?? "-",
            row.fundingRate === null ? "-" : (Number(row.fundingRate) * 100).toFixed(4),
            row.fundingAprPct ?? "-",
            row.openInterestUsd ?? "-",
            money(row.dayNotionalVolumeUsd),
            `${row.maxLeverage}x`,
            [
              row.onlyIsolated ? "iso" : "",
              row.atOpenInterestCap ? "cap" : "",
              row.candle.tradeable === false
                ? `x:${row.candle.reason}`
                : row.candle.tradeable === null
                  ? "?:networkMismatch"
                  : "",
            ]
              .filter(Boolean)
              .join(","),
          ].join("  "),
        )
    } else if ("market" in result) {
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
