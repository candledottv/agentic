/**
 * Orchestration for the two multi-call tools (candle_trade, candle_launch_and_seed). The five
 * original tools stay pure one-request mappings in tools.ts's buildRequest; these two need
 * pre-request reads (decimals, wallet address, balance) or a follow-up read, so they live here,
 * behind an injectable fetch (FetchLike) so every path is unit-tested without a server.
 *
 * Same relay discipline as tools.ts: API response bodies (success or error envelope) pass
 * through verbatim; this module only ADDS context (the echoed idempotency id, the resolved
 * raw amount) and never reinterprets an error. That holds for the PRE-request reads too: a
 * non-ok wallet/market/balance read is relayed as-is rather than turned into a guess about what
 * it meant (`relayRead`).
 *
 * Two rules about amounts are worth stating once, because getting either wrong moves the wrong
 * amount of money:
 *   - A BUY is denominated in the token's OWN quote asset, read from its market
 *     (`market.quoteDecimals`), never from the caller's `quoteAsset` field: the trade rail infers
 *     a Candle-launched token's quote from the token row and ignores that field there.
 *   - A LAUNCH dev buy is denominated in the quote the caller is choosing for the new token, so
 *     the field is authoritative, defaulted per chain (sol on Solana, eth on Hood).
 *
 * And one about failures: once a write request is in flight, no throw may escape without the
 * idempotency id attached (`transportError`, code MCP_TRANSPORT), because that id is what makes
 * the retry a replay instead of a second trade or a second launch.
 */
import { randomUUID } from "node:crypto"
import type { RequestConfig } from "./client"
import { decimalToRaw, defaultQuoteId, percentOfBalance, QUOTE_DECIMALS } from "./convert"

export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export interface ToolText {
  text: string
  isError?: boolean
}

function requireApiKey(cfg: RequestConfig): string {
  if (!cfg.apiKey) {
    throw new Error("CANDLE_AGENT_API_KEY is required for this tool. Set it in the environment or MCP client config.")
  }
  return cfg.apiKey
}

function headers(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" }
  if (apiKey) h["x-api-key"] = apiKey
  return h
}

function base(cfg: RequestConfig): string {
  return cfg.apiUrl.replace(/\/$/, "")
}

// `extra` is opaque here (never inspects its keys) so the same helper serves any caller's
// echoed id: `{ clientTradeId }` for candle_trade, `{ clientLaunchId }` for
// candle_launch_and_seed, spread at the top level alongside the error envelope.
function errText(message: string, extra?: Record<string, unknown>): ToolText {
  return {
    text: JSON.stringify({ ...extra, success: false, error: { code: "MCP_VALIDATION", message } }),
    isError: true,
  }
}

/**
 * A PRE-request read (wallet, market, balance) that came back non-ok. Its body is relayed
 * verbatim under `api` rather than reinterpreted: a 401 on the wallet read is an expired key, not
 * "you have no embedded wallet", and a 500 on the market read is not "this token has no
 * decimals". MCP_VALIDATION stays reserved for bad arguments and for data genuinely absent from
 * an OK response. A body that is not JSON rides along as a string so nothing is ever swallowed.
 */
function relayRead(body: string, extra: Record<string, unknown>): ToolText {
  let api: unknown
  try {
    api = JSON.parse(body)
  } catch {
    api = body
  }
  return { text: JSON.stringify({ ...extra, success: false, api }), isError: true }
}

/**
 * ANY throw once the write request is in flight: a rejected fetch (transport timeout, exactly
 * when a retry matters most) or a body that is not JSON. The idempotency id MUST survive it,
 * because that id is the only thing that makes the retry safe, and for the composite a throw here
 * can sit on top of a real, confirmed launch.
 */
function transportError(idKey: "clientTradeId" | "clientLaunchId", id: string, thrown: unknown): ToolText {
  const detail = thrown instanceof Error ? thrown.message : String(thrown)
  return {
    text: JSON.stringify({
      [idKey]: id,
      success: false,
      error: {
        code: "MCP_TRANSPORT",
        message:
          `The request failed in transit (${detail}). It may or may not have reached Candle. ` +
          `Retry with THIS SAME ${idKey} ("${id}") and the same body: the same id replays the ` +
          "original result instead of executing a second time, while a NEW id is a second, independent " +
          "trade or launch.",
        retryable: true,
      },
    }),
    isError: true,
  }
}

/** Chain from the mint's own shape, the same heuristic the API applies to arbitrary mints. */
function chainForMint(mint: string): "hood" | "solana" {
  return mint.startsWith("0x") ? "hood" : "solana"
}

/**
 * Decimals for a NAMED quote asset id, defaulted PER CHAIN the way the API defaults it. Shared by
 * the launch dev buy (where the caller's quoteAsset genuinely picks the new token's quote pair)
 * and by the one buy case that still honors the field (an arbitrary mint with no Candle market).
 */
function quoteIdDecimals(
  quoteAsset: string | undefined,
  chain: string | undefined,
  extra: Record<string, unknown>,
): { decimals: number } | { err: ToolText } {
  const quote = quoteAsset ?? defaultQuoteId(chain)
  const decimals = QUOTE_DECIMALS[quote]
  if (decimals === undefined) {
    return {
      err: errText(`unknown quoteAsset "${quote}"; expected one of ${Object.keys(QUOTE_DECIMALS).join(", ")}`, extra),
    }
  }
  return { decimals }
}

/** decimalToRaw with this module's error envelope, so a bad amount never throws out of a tool. */
function rawOrError(
  amount: string,
  decimals: number,
  extra: Record<string, unknown>,
): { raw: string } | { err: ToolText } {
  try {
    return { raw: decimalToRaw(amount, decimals) }
  } catch (err) {
    return { err: errText(err instanceof Error ? err.message : String(err), extra) }
  }
}

/**
 * POST + read + parse with EVERY failure folded into a returned value instead of a throw: the
 * idempotency id lives at the call site, and an exception escaping from here would strand it.
 */
async function postJson(
  url: string,
  apiKey: string,
  payload: unknown,
  doFetch: FetchLike,
): Promise<{ ok: boolean; body: unknown } | { thrown: unknown }> {
  try {
    const res = await doFetch(url, { method: "POST", headers: headers(apiKey), body: JSON.stringify(payload) })
    return { ok: res.ok, body: JSON.parse(await res.text()) }
  } catch (thrown) {
    return { thrown }
  }
}

/** The market fields this module reads: the token's own scale, and its quote asset's scale. */
interface MarketRead {
  decimals?: number
  quoteDecimals?: number
}

/**
 * GET /api/v1/markets/:chain/:mint, with a non-ok response relayed verbatim rather than
 * reinterpreted. The status rides along so a caller can tell "no Candle market for this mint"
 * (404) apart from "the read itself failed".
 */
async function readMarket(
  mint: string,
  cfg: RequestConfig,
  doFetch: FetchLike,
  extra: Record<string, unknown>,
): Promise<{ market: MarketRead } | { status: number; err: ToolText }> {
  const res = await doFetch(`${base(cfg)}/api/v1/markets/${chainForMint(mint)}/${mint}`, {
    method: "GET",
    headers: headers(),
  })
  const text = await res.text()
  if (!res.ok) return { status: res.status, err: relayRead(text, extra) }
  return { market: (JSON.parse(text) as { market?: MarketRead }).market ?? {} }
}

export interface TradeArgs {
  mint: string
  side: "buy" | "sell"
  amount?: string
  percent?: number
  quoteAsset?: string
  maxSlippageBps?: number
  clientTradeId?: string
}

export async function executeTrade(args: TradeArgs, cfg: RequestConfig, doFetch: FetchLike): Promise<ToolText> {
  const apiKey = requireApiKey(cfg)
  const clientTradeId = args.clientTradeId ?? randomUUID()

  if (args.amount !== undefined && args.percent !== undefined) {
    return errText("pass exactly one of amount or percent, not both", { clientTradeId })
  }
  if (args.amount === undefined && args.percent === undefined) {
    return errText("pass exactly one of amount or percent", { clientTradeId })
  }
  if (args.percent !== undefined && args.side !== "sell") {
    return errText("percent is only valid on sells; buys take a quote-asset amount", { clientTradeId })
  }
  let amountRaw: string
  let resolved: Record<string, unknown>
  try {
    if (args.side === "buy") {
      const amount = args.amount as string
      // A buy is denominated in the TOKEN'S OWN quote asset. For any Candle-launched token the
      // trade rail infers that quote from the token row itself
      // (apps/api/src/services/candle/token-trade.ts's findLaunchQuotePair on token.quoteMint)
      // and IGNORES the caller's quoteAsset field, so converting against that field would send
      // 1000x on a USDC- or CNDL-quoted token bought with the "sol" default. Decimals therefore
      // come from the market read, never from the caller.
      const read = await readMarket(args.mint, cfg, doFetch, { clientTradeId })
      let decimals: number
      if ("market" in read) {
        const quoteDecimals = read.market.quoteDecimals
        if (typeof quoteDecimals !== "number") {
          return errText(
            `could not resolve the quote decimals for mint ${args.mint}; a buy is denominated in that token's own quote asset and this market does not report its scale. Read the market with candle_get_market, then trade a raw amount via the SDK instead`,
            { clientTradeId },
          )
        }
        decimals = quoteDecimals
      } else if (read.status === 404) {
        // No Candle market for this mint at all: a Pro/Max key trading an arbitrary token through
        // Jupiter. That is the one path where the API does honor the caller's quoteAsset
        // (token-trade.ts's planArbitrarySolanaJupiterTrade: `req.quoteAsset ?? "sol"`), so the
        // named quote is authoritative here for exactly the same reason it is ignored above.
        const q = quoteIdDecimals(args.quoteAsset, chainForMint(args.mint), { clientTradeId })
        if ("err" in q) return q.err
        decimals = q.decimals
      } else {
        return read.err
      }
      const converted = rawOrError(amount, decimals, { clientTradeId })
      if ("err" in converted) return converted.err
      amountRaw = converted.raw
      resolved = { amountDecimal: amount, decimals, amountRaw }
    } else if (args.amount !== undefined) {
      const read = await readMarket(args.mint, cfg, doFetch, { clientTradeId })
      if (!("market" in read)) return read.err
      // A sell is denominated in TOKENS, so this side reads the token's own decimals.
      const decimals = read.market.decimals
      if (typeof decimals !== "number") {
        return errText(
          `could not resolve decimals for mint ${args.mint}; pass a raw-ready amount via the SDK instead`,
          { clientTradeId },
        )
      }
      const converted = rawOrError(args.amount, decimals, { clientTradeId })
      if ("err" in converted) return converted.err
      amountRaw = converted.raw
      resolved = { amountDecimal: args.amount, decimals, amountRaw }
    } else {
      const percent = args.percent as number
      const walletsRes = await doFetch(`${base(cfg)}/api/v1/agent/wallets/embedded`, {
        method: "GET",
        headers: headers(apiKey),
      })
      const walletsText = await walletsRes.text()
      if (!walletsRes.ok) return relayRead(walletsText, { clientTradeId })
      const walletsBody = JSON.parse(walletsText) as {
        wallets?: { solana?: { address: string } | null; evm?: { address: string } | null }
      }
      // A hood token is held by the embedded EVM wallet, not the Solana one. These are the two
      // different chain axes the wallets table names as "Wallet" and "Launches on"; see
      // docs/reference/chain-vocabulary.md.
      const chain = chainForMint(args.mint)
      const address = chain === "hood" ? walletsBody.wallets?.evm?.address : walletsBody.wallets?.solana?.address
      if (!address) {
        return errText(
          `percent sells need an embedded ${chain === "hood" ? "EVM" : "Solana"} wallet, and this account has none`,
          { clientTradeId },
        )
      }
      const balRes = await doFetch(`${base(cfg)}/api/v1/tokens/${args.mint}/balance/${address}`, {
        method: "GET",
        headers: headers(),
      })
      const balText = await balRes.text()
      if (!balRes.ok) return relayRead(balText, { clientTradeId })
      const balBody = JSON.parse(balText) as { payload?: { balance: string } | null }
      const balance = balBody.payload?.balance
      if (!balance) {
        return errText(`the embedded wallet ${address} holds no ${args.mint}; nothing to sell`, { clientTradeId })
      }
      amountRaw = percentOfBalance(balance, percent)
      resolved = { percent, balanceRaw: balance, amountRaw }
    }
  } catch (err) {
    return errText(err instanceof Error ? err.message : String(err), { clientTradeId })
  }

  // The caller's quoteAsset still rides along untouched: the API validates it and uses it where
  // it applies (an arbitrary mint with no `tokens` row). It just never drives the conversion.
  const posted = await postJson(
    `${base(cfg)}/api/v1/trade/agent/build`,
    apiKey,
    {
      clientTradeId,
      mint: args.mint,
      side: args.side,
      amountRaw,
      payer: { type: "main" },
      ...(args.quoteAsset !== undefined ? { quoteAsset: args.quoteAsset } : {}),
      ...(args.maxSlippageBps !== undefined ? { maxSlippageBps: args.maxSlippageBps } : {}),
    },
    doFetch,
  )
  if ("thrown" in posted) return transportError("clientTradeId", clientTradeId, posted.thrown)
  // One JSON document: clientTradeId and resolved at the top level (so an agent reading even
  // truncated output sees the retry id first), the API body verbatim under `api`, identical
  // shape on success and error paths.
  const wrapped = JSON.stringify({ clientTradeId, resolved, api: posted.body })
  return posted.ok ? { text: wrapped } : { text: wrapped, isError: true }
}

export interface LaunchAndSeedArgs {
  clientLaunchId?: string
  name: string
  symbol: string
  imageUrl: string
  chain?: string
  quoteAsset?: string
  mode?: string
  stakerAllocationBps?: number
  dexVersion?: string | null
  description?: string
  socials?: Record<string, string>
  visibility?: string
  devBuy?: string
  dryRun?: boolean
  /**
   * Accepted only to be STRIPPED. This tool's seed input is `devBuy`, in decimal quote units;
   * forwarding a caller-supplied raw `buyAmount` would seed in units the tool never converted or
   * validated, and would silently win over `devBuy` on the API side.
   */
  buyAmount?: unknown
}

export async function executeLaunchAndSeed(
  args: LaunchAndSeedArgs,
  cfg: RequestConfig,
  doFetch: FetchLike,
): Promise<ToolText> {
  const apiKey = requireApiKey(cfg)
  const clientLaunchId = args.clientLaunchId ?? randomUUID()
  // buyAmount is destructured off and never forwarded: see LaunchAndSeedArgs.buyAmount.
  const { devBuy, dryRun, buyAmount: _rawBuyAmount, ...launchFields } = args

  let buyAmount: string | undefined
  if (devBuy !== undefined) {
    // Unlike a trade, the caller's quoteAsset here genuinely picks the NEW token's quote pair, so
    // the id lookup is the right resolution; only the default was wrong. The API defaults per
    // chain, sol on Solana and eth on Hood, so a Hood dev buy converts at 18 decimals.
    const q = quoteIdDecimals(args.quoteAsset, args.chain, { clientLaunchId })
    if ("err" in q) return q.err
    const converted = rawOrError(devBuy, q.decimals, { clientLaunchId })
    if ("err" in converted) return converted.err
    buyAmount = converted.raw
  }

  const path = dryRun ? "/api/v1/launch/headless/dry-run" : "/api/v1/launch/headless"
  const posted = await postJson(
    `${base(cfg)}${path}`,
    apiKey,
    {
      ...launchFields,
      clientLaunchId,
      ...(buyAmount !== undefined ? { buyAmount } : {}),
    },
    doFetch,
  )
  if ("thrown" in posted) return transportError("clientLaunchId", clientLaunchId, posted.thrown)
  if (!posted.ok) {
    return { text: JSON.stringify({ clientLaunchId, api: posted.body }), isError: true }
  }
  if (dryRun) {
    return { text: JSON.stringify({ clientLaunchId, dryRun: true, api: posted.body }) }
  }

  const launch = posted.body as { chain?: string; mint?: string }

  // The market read is best-effort context. The launch above is REAL and already confirmed; a
  // transient failure here must never turn a successful launch into a tool error the caller
  // might retry into a duplicate.
  let market: unknown = null
  let note: string | undefined
  try {
    const marketRes = await doFetch(`${base(cfg)}/api/v1/markets/${launch.chain ?? "solana"}/${launch.mint}`, {
      method: "GET",
      headers: headers(),
    })
    if (marketRes.ok) {
      market = (JSON.parse(await marketRes.text()) as { market?: unknown }).market ?? null
    } else {
      note = "launch confirmed; the follow-up market read failed, read it via candle_get_market"
    }
  } catch {
    note = "launch confirmed; the follow-up market read failed, read it via candle_get_market"
  }

  return {
    text: JSON.stringify({ clientLaunchId, launch, market, ...(note ? { note } : {}) }),
  }
}

// ---------------------------------------------------------------------------------------------
// candle_sweep (agent transfers spec, slice 3)
// ---------------------------------------------------------------------------------------------

/** Sweep order is deliberate: tokens FIRST, the chain's native asset LAST. The native asset
 * pays every transfer's fee (and any destination-ATA rent on Solana), so sweeping it first
 * would strand the tokens behind an empty fee wallet. */
const SWEEP_BASE_ASSETS: Record<"solana" | "hood", string[]> = {
  solana: ["USDC", "CNDL", "SOL"],
  hood: ["USDG", "ETH"],
}

export interface SweepArgs {
  chain: "solana" | "hood"
  to: string
  mints?: string[]
}

interface SweepResult {
  asset: string
  status: "transferred" | "empty" | "error"
  amountRaw?: string
  signature?: string
  error?: unknown
}

/**
 * One transfer per asset with amountRaw "max", the transfer rail's sweep primitive: the chain's
 * base assets (plus any explicitly named mints), tokens before the native asset. An asset with
 * nothing spendable (TRANSFER_AMOUNT_UNAVAILABLE) reports "empty", not an error, and a failed
 * asset never stops the rest -- the launch-and-seed partial-failure discipline. isError is set
 * only when NOTHING transferred and at least one asset genuinely failed.
 */
export async function executeSweep(args: SweepArgs, cfg: RequestConfig, doFetch: FetchLike): Promise<ToolText> {
  const apiKey = cfg.apiKey
  if (!apiKey) {
    throw new Error("CANDLE_AGENT_API_KEY is required for this tool. Set it in the environment or MCP client config.")
  }
  const base = cfg.apiUrl.replace(/\/$/, "")
  const baseAssets = SWEEP_BASE_ASSETS[args.chain]
  const targets: { field: "asset" | "mint"; value: string }[] = [
    // Extra mints sweep before the native asset too, for the same fee reason.
    ...baseAssets.slice(0, -1).map((value) => ({ field: "asset" as const, value })),
    ...(args.mints ?? []).map((value) => ({ field: "mint" as const, value })),
    { field: "asset" as const, value: baseAssets[baseAssets.length - 1] as string },
  ]

  const results: SweepResult[] = []
  for (const target of targets) {
    let body: unknown
    let ok = false
    try {
      const res = await doFetch(`${base}/api/v1/agent/transfer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({
          chain: args.chain,
          [target.field]: target.value,
          amountRaw: "max",
          to: args.to,
        }),
      })
      ok = res.ok
      // FetchLike exposes text(), not json() -- parse defensively like relayRead does.
      const text = await res.text()
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    } catch (err) {
      results.push({ asset: target.value, status: "error", error: String(err) })
      continue
    }
    if (ok) {
      const payload = body as { amountRaw?: string; signature?: string }
      results.push({
        asset: target.value,
        status: "transferred",
        amountRaw: payload.amountRaw,
        signature: payload.signature,
      })
      continue
    }
    const code = ((body as { error?: { code?: string } } | null)?.error?.code ?? "") as string
    if (code === "TRANSFER_AMOUNT_UNAVAILABLE") {
      results.push({ asset: target.value, status: "empty" })
    } else {
      results.push({ asset: target.value, status: "error", error: body })
    }
  }

  const transferred = results.filter((r) => r.status === "transferred").length
  const failed = results.filter((r) => r.status === "error").length
  return {
    text: JSON.stringify({ chain: args.chain, to: args.to, transferred, failed, results }),
    ...(transferred === 0 && failed > 0 ? { isError: true } : {}),
  }
}
