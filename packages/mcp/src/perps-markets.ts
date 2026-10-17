/** Spec B: local-only tools. No signer; any configured Candle agent key suffices. */
import { z } from "zod"
import type { RequestConfig } from "./client"
import {
  PERPS_CANDLE_INTERVALS,
  type PerpsBookOptions,
  type PerpsCandlesOptions,
  PerpsMarketError,
  PerpsMarketReader,
  type PerpsMarketsOptions,
} from "./hyperliquid-markets"
import type { FetchLike, ToolText } from "./orchestrate"

export const PERPS_MARKET_TOOL_NAMES = [
  "candle_perps_markets",
  "candle_perps_market",
  "candle_perps_book",
  "candle_perps_candles",
] as const
export type PerpsMarketToolName = (typeof PERPS_MARKET_TOOL_NAMES)[number]
export const perpsMarketShapes = {
  candle_perps_markets: {
    sort: z.enum(["volume", "oi", "funding", "change", "name"]).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    all: z.boolean().optional(),
  },
  candle_perps_market: { coin: z.string() },
  candle_perps_book: {
    coin: z.string(),
    depth: z.number().int().min(1).max(20).optional(),
    sigFigs: z.number().int().min(2).max(5).optional(),
  },
  candle_perps_candles: {
    coin: z.string(),
    interval: z.enum(PERPS_CANDLE_INTERVALS).optional(),
    count: z.number().int().min(1).max(5000).optional(),
    end: z.union([z.string(), z.number()]).optional(),
  },
}
export function createPerpsMarketExecutor(
  getConfig: () => RequestConfig,
  env: Record<string, string | undefined>,
  fetcher: FetchLike,
  now = Date.now,
) {
  let previous: RequestConfig | undefined
  let reader: PerpsMarketReader | undefined
  return async (tool: PerpsMarketToolName, args: Record<string, unknown>): Promise<ToolText> => {
    try {
      const cfg = getConfig()
      if (!reader || previous?.apiUrl !== cfg.apiUrl || previous?.apiKey !== cfg.apiKey) {
        previous = { ...cfg }
        reader = new PerpsMarketReader({
          apiKey: cfg.apiKey,
          network: env.CANDLE_HYPERLIQUID_NETWORK === "testnet" ? "testnet" : "mainnet",
          fetcher,
          now,
          readConfig: async () => {
            const response = await fetcher(`${cfg.apiUrl.replace(/\/+$/, "")}/api/v1/agent/perps/config`, {
              method: "GET",
              headers: { "x-api-key": cfg.apiKey as string },
              signal: AbortSignal.timeout(5000),
              redirect: "error",
            })
            if (!response.ok) throw new Error("config unavailable")
            return JSON.parse(await response.text())
          },
        })
      }
      if (!cfg.apiKey?.trim())
        throw new PerpsMarketError(
          "PERPS_KEY_REQUIRED",
          "Configure a Candle agent key (any scope) to read perps markets.",
        )
      const parsed = z.object(perpsMarketShapes[tool]).strict().safeParse(args)
      if (!parsed.success)
        return {
          text: JSON.stringify({ success: false, error: { code: "MCP_VALIDATION", message: parsed.error.message } }),
          isError: true,
        }
      const result =
        tool === "candle_perps_markets"
          ? await reader.markets(parsed.data as PerpsMarketsOptions)
          : tool === "candle_perps_market"
            ? await reader.market(args.coin as string)
            : tool === "candle_perps_book"
              ? await reader.book(args.coin as string, parsed.data as PerpsBookOptions)
              : await reader.candles(args.coin as string, parsed.data as PerpsCandlesOptions)
      return { text: JSON.stringify(result) }
    } catch (error) {
      return {
        text: JSON.stringify({
          success: false,
          error: {
            code: error instanceof PerpsMarketError ? error.code : "PERPS_UNAVAILABLE",
            message: error instanceof Error ? error.message : "Market read failed.",
            retryable: error instanceof PerpsMarketError ? error.retryable : true,
          },
        }),
        isError: true,
      }
    }
  }
}
