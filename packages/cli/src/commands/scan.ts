/**
 * `candle scan <ca>` (BE-2119, Quant in groups design 6.8): the token card a group gets when a
 * contract is pasted, printed in the terminal through the output kit. It reads the public card
 * route from BE-2118 (`GET /api/v1/tokens/:chain/:mint/card`), which is free for every tier and the
 * same for every caller, so no key is read and none is sent.
 *
 * Facts, never a verdict: no score and no "safe". Every figure is the route's; a field the route
 * has no source for prints the kit's missing mark, never a guess, and the Sources block names
 * where each block came from. --chain names the network. Without it an EVM address uses the
 * registry's documented default (Hood); base58 keeps the Solana path.
 */

import { parseArgs } from "../args"
import { getChain, listChains } from "../chains"
import { type ApiResult, apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { writeFields } from "../human-output"
import { type FieldValue, symbols, terminalStyle } from "../presentation"
import { formatTime, writeFailure, writeUsageFailure } from "../render"
import { requestAddressChain } from "../request-chain"
import { formatPrice, formatUsd, shortAddress } from "../usd"

type Chain = string

/** One hacc card fact (BE-2117): `display` is the producer's text, an en dash unless `state` is ok. */
type CardFact = { value: number | null; display: string; state: "ok" | "pending" | "unavailable" }

type SameNameCandidate = { ticker: string | null; name: string | null; venue: string | null }

type SameName =
  | {
      state: "found" | "none" | "unavailable"
      display: string
      leader: SameNameCandidate | null
      trailing: boolean | null
    }
  | { state: "off" }

type Card = {
  chain: Chain
  mint: string
  generatedAt: number
  identity: { name: string | null; symbol: string | null; launchpad: string | null; isCandle: boolean | null }
  market: {
    priceUsd: number | null
    marketCapUsd: number | null
    liquidityUsd: number | null
    change5mPct: number | null
    volume5mUsd: number | null
    buys5m: number | null
    sells5m: number | null
    updatedAt: number | null
  }
  ath: { marketCapUsd: number; at: number; precision: "day"; basis: string } | null
  forensics: { state: "ok" | "not_covered" | "unavailable" }
  events:
    | {
        state: "ok"
        windowMinutes: number
        trackedBuys: number
        trackedSells: number
        signals: number
        callouts: number
        names: string[]
      }
    | { state: "off" | "unavailable" }
  hacc:
    | {
        state: "ok"
        facts: {
          fields: Partial<
            Record<"bundles" | "snipers" | "insiders" | "fresh_1d" | "fresh_7d" | "avg_wallet_age", CardFact>
          >
        }
      }
    | { state: "off" | "unavailable" }
  sameName: SameName
  sources: Record<string, string>
  links: { token: string }
}

const usage = () =>
  `Usage: candle scan <contract address> [--chain ${listChains({ enabledOnly: true })
    .map((c) => c.slug)
    .join("|")}] [--json]`
const OTHER_CHAIN = "Candle trades Solana and Hood today; that is not a Solana or Hood contract address."

/** Request-edge default only; an explicit network is never replaced by the default. */
export function chainOfAddress(address: string, chain?: string): Chain | null {
  return requestAddressChain(address, chain)
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object"

/** A card the screen can render, or null for an answer that is not one. */
function readCard(body: unknown): Card | null {
  if (!isObject(body) || body.success !== true || !isObject(body.card)) return null
  const card = body.card
  const blocks = ["identity", "market", "forensics", "events", "hacc", "sameName", "sources", "links"]
  if (typeof card.mint !== "string" || typeof card.chain !== "string" || !getChain(card.chain)) return null
  if (!blocks.every((block) => isObject(card[block]))) return null
  return card as unknown as Card
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null)

function usd(value: unknown): string | null {
  const n = num(value)
  return n === null ? null : formatUsd(n, { compact: true })
}

function percentChange(value: unknown): string | null {
  const n = num(value)
  if (n === null) return null
  const rounded = Number(n.toFixed(1))
  return `${rounded > 0 ? "+" : ""}${rounded}%`
}

/** The heading line: ticker, name, chain, launchpad. A token with no ticker shows its short address. */
function title(card: Card): string {
  const { symbol, name, launchpad, isCandle } = card.identity
  const parts = [
    symbol || shortAddress(card.mint),
    name && name !== symbol ? name : null,
    card.chain === "hood" ? "Hood" : (getChain(card.chain)?.displayName ?? card.chain),
    launchpad,
    isCandle === true ? "launched on Candle" : null,
  ]
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" · ")
}

function fact(card: Card, key: keyof Extract<Card["hacc"], { state: "ok" }>["facts"]["fields"]): string | null {
  if (card.hacc.state !== "ok") return null
  const field = card.hacc.facts.fields?.[key]
  return field?.state === "ok" && field.display ? field.display : null
}

function pair(a: string | null, b: string | null, missing: string): string | null {
  return a === null && b === null ? null : `${a ?? missing} / ${b ?? missing}`
}

function eventsLine(card: Card, missing: string): string {
  const events = card.events
  if (events.state !== "ok") return `${missing} (${events.state})`
  const parts = [
    `${events.trackedBuys} bought, ${events.trackedSells} sold`,
    `${events.signals} signal${events.signals === 1 ? "" : "s"}`,
    `${events.callouts} callout${events.callouts === 1 ? "" : "s"}`,
  ]
  const names = Array.isArray(events.names) && events.names.length > 0 ? ` (${events.names.join(", ")})` : ""
  return `${parts.join(" · ")}${names}`
}

function sameNameLine(card: Card, missing: string): string {
  const same = card.sameName
  if (same.state === "off" || same.state === "unavailable") return `${missing} (${same.state})`
  if (same.state === "none") return "none found"
  const display = same.display && same.display !== "–" ? same.display : missing
  return same.trailing === true ? `${display} (this token trails)` : display
}

function forensicsLine(card: Card, missing: string): string {
  switch (card.forensics.state) {
    case "ok":
      return `read; the full report is candle token forensics ${card.mint}${card.chain === "hood" ? " --chain hood" : ""}`
    case "not_covered":
      return "not covered for this token (bundles, snipers and insiders are unknown, not clean)"
    default:
      return `${missing} (unavailable)`
  }
}

function athLine(card: Card): string | null {
  const ath = card.ath
  if (!ath || num(ath.marketCapUsd) === null) return null
  return `${formatUsd(ath.marketCapUsd, { compact: true })} on ${formatTime(ath.at, { date: true, now: card.generatedAt })} (daily high, FDV)`
}

export async function scan(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--chain"] })
  if ("error" in parsed) {
    writeUsageFailure(ctx.deps, parsed.error, ctx.json)
    return 2
  }
  const named = parsed.values["--chain"]
  if (parsed.positionals.length !== 1) {
    writeUsageFailure(ctx.deps, usage(), ctx.json)
    return 2
  }
  const address = (parsed.positionals[0] as string).trim()
  let chain: string | null
  try {
    chain = chainOfAddress(address, named)
  } catch (error) {
    writeUsageFailure(ctx.deps, `${error instanceof Error ? error.message : String(error)}\n${usage()}`, ctx.json)
    return 2
  }
  if (chain === null) {
    writeUsageFailure(ctx.deps, `${OTHER_CHAIN}\n${usage()}`, ctx.json)
    return 2
  }

  const result: ApiResult = await apiRequest(`/api/v1/tokens/${chain}/${encodeURIComponent(address)}/card`, {
    apiUrl: ctx.apiUrl,
    auth: "none",
    credentials: {},
    env: ctx.deps.env,
    fetch: ctx.deps.fetch,
  })
  if (!result.ok) {
    writeFailure(ctx.deps, result, { apiUrl: ctx.apiUrl, authType: "none" }, ctx.json)
    return 1
  }
  const card = readCard(result.body)
  if (!card || card.chain !== chain) {
    writeFailure(
      ctx.deps,
      {
        ok: false,
        status: result.status,
        code: "BAD_RESPONSE",
        message: "The card answer was not readable.",
        raw: result.body,
      },
      { apiUrl: ctx.apiUrl, authType: "none" },
      ctx.json,
    )
    return 1
  }
  if (ctx.json) {
    ctx.deps.stdout.write(`${JSON.stringify({ ok: true, data: { card } })}\n`)
    return 0
  }

  const missing = symbols(terminalStyle(ctx.deps, "stdout")).missing
  const m = card.market
  const buys = num(m.buys5m)
  const sells = num(m.sells5m)
  const rows: Array<readonly [string, FieldValue]> = [
    ["Contract", card.mint],
    ["Price", num(m.priceUsd) === null ? null : formatPrice(m.priceUsd as number)],
    ["Market cap", usd(m.marketCapUsd)],
    ["All-time high", athLine(card)],
    ["5m change", percentChange(m.change5mPct)],
    ["Liquidity", usd(m.liquidityUsd)],
    ["Volume 5m", usd(m.volume5mUsd)],
    ["Buys / sells 5m", pair(buys === null ? null : String(buys), sells === null ? null : String(sells), missing)],
    ["Bundles", fact(card, "bundles")],
    ["Snipers", fact(card, "snipers")],
    ["Insiders", fact(card, "insiders")],
    ["Fresh 1d / 7d", pair(fact(card, "fresh_1d"), fact(card, "fresh_7d"), missing)],
    ["Mean wallet age", fact(card, "avg_wallet_age")],
    ["Tracked, 1h", eventsLine(card, missing)],
    ["Same name", sameNameLine(card, missing)],
    ["Forensics", forensicsLine(card, missing)],
    ["Market as of", num(m.updatedAt) === null ? null : formatTime(m.updatedAt, { now: card.generatedAt })],
    ["Candle page", card.links.token],
  ]
  writeFields(ctx.deps, "stdout", rows, title(card))
  const sources = Object.entries(card.sources).filter(([, text]) => typeof text === "string")
  if (sources.length > 0) {
    ctx.deps.stdout.write("\n")
    writeFields(ctx.deps, "stdout", sources, "Sources")
  }
  return 0
}
