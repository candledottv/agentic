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
import { type ImageFs, imageRefusalBody, resolveLaunchImage, uploadedFields } from "./image"
import { socialsRefusal } from "./launch-schema"
import { noteVersionHeaders, updateAvailable } from "./update-notice"

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
 *
 * Exported for candle_swap (tools.ts), which sends its own request and needs the same envelope.
 */
export function transportError(
  idKey: "clientTradeId" | "clientLaunchId" | "clientSwapId",
  id: string,
  thrown: unknown,
): ToolText {
  const detail = thrown instanceof Error ? thrown.message : String(thrown)
  const second = idKey === "clientSwapId" ? "swap" : "trade or launch"
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
          `${second}.`,
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
  external?: boolean
  candleLaunched?: boolean
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
): Promise<{ market: MarketRead } | { status: number; err: ToolText; reason?: string }> {
  const res = await doFetch(`${base(cfg)}/api/v1/markets/${chainForMint(mint)}/${encodeURIComponent(mint)}`, {
    method: "GET",
    headers: headers(),
  })
  const text = await res.text()
  if (!res.ok) {
    let reason: string | undefined
    try {
      reason = JSON.parse(text)?.error?.routing?.reason
    } catch {
      /* relay the original body */
    }
    return { status: res.status, err: relayRead(text, extra), reason }
  }
  return { market: (JSON.parse(text) as { market?: MarketRead }).market ?? {} }
}

interface PaperInventoryPosition {
  mint: string
  amountRaw: string
  tokenDecimals?: number
}

/**
 * MCP hosts and models pass `paper` as a boolean, the string "true", or 1. Only `=== true`
 * treated those last two as live, so a paper sell then read the embedded wallet (always empty
 * after a paper buy) and returned MCP_VALIDATION instead of closing the paper book.
 */
export function isPaperFlag(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1"
}

function heldPaperPosition(
  positions: readonly PaperInventoryPosition[],
  mint: string,
): PaperInventoryPosition | undefined {
  // EVM checksum casing is not identity; Solana base58 is case-sensitive.
  const key = (value: string) => {
    const trimmed = value.trim()
    return /^0x[0-9a-fA-F]{40}$/.test(trimmed) ? trimmed.toLowerCase() : trimmed
  }
  return positions.find((p) => key(p.mint) === key(mint) && p.amountRaw !== "0")
}

/**
 * GET /api/v1/trade/agent/paper/inventory -- this key's paper book. Used to convert a paper
 * amount sell of an external mint (no Candle market, so no decimals on the market read) and
 * documented so an agent can inspect what a later percent sell will close.
 */
async function readPaperInventory(
  cfg: RequestConfig,
  doFetch: FetchLike,
  extra: Record<string, unknown>,
): Promise<{ positions: PaperInventoryPosition[] } | { err: ToolText }> {
  const res = await doFetch(`${base(cfg)}/api/v1/trade/agent/paper/inventory`, {
    method: "GET",
    headers: headers(cfg.apiKey),
  })
  const text = await res.text()
  if (!res.ok) return { err: relayRead(text, extra) }
  const body = JSON.parse(text) as { positions?: PaperInventoryPosition[] }
  return { positions: body.positions ?? [] }
}

export interface TradeArgs {
  mint: string
  side: "buy" | "sell"
  amount?: string
  percent?: number
  quoteAsset?: string
  maxSlippageBps?: number
  clientTradeId?: string
  /** Rehearse: run every admission rule, record the quote, broadcast nothing. */
  paper?: unknown
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
  let amountRaw: string | undefined
  // Assigned on every path that reaches the /build POST. Initialized so tsc (target-aware
  // definite-assignment) does not treat the wallet-empty → paper-inventory branch as unassigned.
  let resolved: Record<string, unknown> = {}
  // Set when the caller asked for paper, or when a sell that looked live has no on-chain
  // holding but this key does have a paper position for the mint (Cented / SOLCAT: the sell
  // omitted `paper: true` after a paper buy, then MCP checked the wallet and 404'd the market).
  let paper = isPaperFlag(args.paper)
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
      if ("market" in read && (read.market.external === true || read.market.candleLaunched === false)) {
        const q = quoteIdDecimals(args.quoteAsset, chainForMint(args.mint), { clientTradeId })
        if ("err" in q) return q.err
        decimals = q.decimals
      } else if ("market" in read) {
        const quoteDecimals = read.market.quoteDecimals
        if (typeof quoteDecimals !== "number") {
          return errText(
            `could not resolve the quote decimals for mint ${args.mint}; a buy is denominated in that token's own quote asset and this market does not report its scale. Read the market with candle_get_market, then trade a raw amount via the SDK instead`,
            { clientTradeId },
          )
        }
        decimals = quoteDecimals
      } else if (read.status === 404 && read.reason !== "chain_mismatch") {
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
      let decimals: number
      if ("market" in read) {
        // A sell is denominated in TOKENS, so this side reads the token's own decimals.
        if (typeof read.market.decimals !== "number") {
          return errText(
            `could not resolve decimals for mint ${args.mint}; pass a raw-ready amount via the SDK instead`,
            { clientTradeId },
          )
        }
        decimals = read.market.decimals
      } else if (read.status === 404 && read.reason !== "chain_mismatch") {
        // No Candle market. Live used to stop here (MARKET_NOT_FOUND). A paper buy of a
        // Jupiter / pump.fun mint leaves a position on the paper book, so consult that
        // before giving up -- including when the caller forgot `paper: true` on the exit.
        const inventory = await readPaperInventory(cfg, doFetch, { clientTradeId })
        if ("err" in inventory) {
          return paper ? inventory.err : read.err
        }
        const held = heldPaperPosition(inventory.positions, args.mint)
        if (typeof held?.tokenDecimals !== "number") {
          if (paper) {
            return errText(
              `could not resolve decimals for mint ${args.mint}; no Candle market and no paper position with a known scale. Buy it in paper first, or pass a raw amount via the SDK`,
              { clientTradeId },
            )
          }
          return read.err
        }
        decimals = held.tokenDecimals
        paper = true
      } else {
        return read.err
      }
      const converted = rawOrError(args.amount, decimals, { clientTradeId })
      if ("err" in converted) return converted.err
      amountRaw = converted.raw
      resolved = { amountDecimal: args.amount, decimals, amountRaw }
    } else if (paper) {
      // Paper percent: the API sizes against paper inventory. Do not read the live wallet --
      // paper never credits it, so that path always looks empty after a paper buy.
      resolved = { percent: args.percent }
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
      let walletEmpty: ToolText | undefined
      if (!address) {
        walletEmpty = errText(
          `percent sells need an embedded ${chain === "hood" ? "EVM" : "Solana"} wallet, and this account has none`,
          { clientTradeId },
        )
      } else {
        const balRes = await doFetch(
          `${base(cfg)}/api/v1/tokens/${encodeURIComponent(args.mint)}/balance/${encodeURIComponent(address)}`,
          {
            method: "GET",
            headers: headers(),
          },
        )
        const balText = await balRes.text()
        if (!balRes.ok) return relayRead(balText, { clientTradeId })
        const balBody = JSON.parse(balText) as { payload?: { balance: string } | null }
        const balance = balBody.payload?.balance
        if (balance) {
          amountRaw = percentOfBalance(balance, percent)
          resolved = { percent, balanceRaw: balance, amountRaw }
        } else {
          walletEmpty = errText(`the embedded wallet ${address} holds no ${args.mint}; nothing to sell`, {
            clientTradeId,
          })
        }
      }
      if (walletEmpty) {
        // On-chain is empty (the paper-buy case). Close the paper book instead of blocking.
        const inventory = await readPaperInventory(cfg, doFetch, { clientTradeId })
        if (!("err" in inventory) && heldPaperPosition(inventory.positions, args.mint)) {
          paper = true
          resolved = { percent }
        } else {
          return walletEmpty
        }
      }
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
      ...(amountRaw !== undefined ? { amountRaw } : { percent: args.percent }),
      payer: { type: "main" },
      ...(args.quoteAsset !== undefined ? { quoteAsset: args.quoteAsset } : {}),
      ...(args.maxSlippageBps !== undefined ? { maxSlippageBps: args.maxSlippageBps } : {}),
      // Forwarded only when the caller actually asked for it. Sending `paper: false` explicitly
      // would be identical in effect but would put the word "paper" in the body of every live
      // trade, which is exactly the string someone greps for when working out whether real money
      // moved.
      ...(paper ? { paper: true } : {}),
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
  /** Required by the API. Optional here only where `imagePath` may stand in for it (image.ts). */
  imageUrl?: string
  /** Never forwarded: uploaded first, and the launch is made with the URL that comes back. */
  imagePath?: string
  /** Optional https URL to wide banner artwork. Not combined with `bannerPath`. */
  bannerUrl?: string
  /** Never forwarded: uploaded first (`kind=banner`), and the launch is made with the `bannerUrl` that comes back. */
  bannerPath?: string
  chain?: string
  quoteAsset?: string
  mode?: string
  stakerAllocationBps?: number
  /** Solana only; forwarded as given. See `launchTokenShape.poolFee`. */
  poolFee?: { tier: 25 | 50 | 100 } | { startBps: number; endBps: 25 | 50 | 100; minutes: number }
  poolOpen?: "legacy" | "curve_price"
  expPoolShape?: "floor" | "full_range"
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
  /** The operator's CANDLE_IMAGE_DIR, when this registration has one. Undefined offers no imagePath. */
  imageDir?: string,
  imageFs?: ImageFs,
  /** `headlessSeed`: the hosted server's (ToolSubsetOptions.headlessSeed), which keeps every seed on the headless route. */
  opts: { headlessSeed?: boolean } = {},
): Promise<ToolText> {
  const apiKey = requireApiKey(cfg)
  const clientLaunchId = args.clientLaunchId ?? randomUUID()
  const socialsProblem = socialsRefusal(args.socials)
  if (socialsProblem) return { text: imageRefusalBody(socialsProblem, { clientLaunchId }), isError: true }
  // buyAmount is destructured off and never forwarded: see LaunchAndSeedArgs.buyAmount.
  const { devBuy, dryRun, buyAmount: _rawBuyAmount, ...imageFields } = args

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
  // BE-1849: on Solana a seed is the first buy of an atomic launch (launch plus first buy as one
  // Jito bundle), because a launch with a dev buy in its own transaction never fits Solana's
  // packet size (BE-1847). Hood keeps its follow-up dev buy on the headless route.
  const atomic = buyAmount !== undefined && (args.chain ?? "solana") === "solana" && !opts.headlessSeed
  if (atomic) {
    const refused = seedCeilingRefusal(args.quoteAsset ?? "sol", args.mode, buyAmount as string, clientLaunchId)
    if (refused) return refused
  }

  // After every refusal this tool can decide for itself, and before the launch: an upload is a
  // publication that cannot be taken back, so a bad devBuy must not cost one.
  const image = await resolveLaunchImage(imageFields, imageDir, cfg, doFetch, imageFs)
  if ("refused" in image) return { text: imageRefusalBody(image.refused, { clientLaunchId }), isError: true }
  if ("uploadFailed" in image) {
    let api: unknown
    try {
      api = JSON.parse(image.uploadFailed)
    } catch {
      api = image.uploadFailed
    }
    return { text: JSON.stringify({ clientLaunchId, api }), isError: true }
  }
  // Once a file was uploaded, every result says where, the failures included: it is public either way.
  const uploaded = uploadedFields(image)

  const transportFailure = (thrown: unknown): ToolText => {
    const failed = transportError("clientLaunchId", clientLaunchId, thrown)
    return Object.keys(uploaded).length === 0
      ? failed
      : { ...failed, text: JSON.stringify({ ...JSON.parse(failed.text), ...uploaded }) }
  }
  if (atomic)
    return launchAndSeedAtomic(
      { ...image.args, clientLaunchId },
      buyAmount as string,
      { clientLaunchId, uploaded, dryRun: dryRun === true, transportFailure },
      cfg,
      doFetch,
    )

  const path = dryRun ? "/api/v1/launch/headless/dry-run" : "/api/v1/launch/headless"
  const posted = await postJson(
    `${base(cfg)}${path}`,
    apiKey,
    {
      ...image.args,
      clientLaunchId,
      ...(buyAmount !== undefined ? { buyAmount } : {}),
    },
    doFetch,
  )
  if ("thrown" in posted) return transportFailure(posted.thrown)
  if (!posted.ok) {
    return { text: JSON.stringify({ clientLaunchId, ...uploaded, api: posted.body }), isError: true }
  }
  if (dryRun) {
    return { text: JSON.stringify({ clientLaunchId, dryRun: true, ...uploaded, api: posted.body }) }
  }

  const launch = posted.body as { chain?: string; mint?: string }
  const { market, note } = await readLaunchedMarket(launch.chain ?? "solana", launch.mint, cfg, doFetch)
  return {
    text: JSON.stringify({ clientLaunchId, ...uploaded, launch, market, ...(note ? { note } : {}) }),
  }
}

/**
 * The fresh market after a confirmed launch. The read is best-effort context. The launch is REAL
 * and already confirmed; a transient failure here must never turn a successful launch into a tool
 * error the caller might retry into a duplicate.
 */
async function readLaunchedMarket(
  chain: string,
  mint: string | undefined,
  cfg: RequestConfig,
  doFetch: FetchLike,
): Promise<{ market: unknown; note?: string }> {
  const note = "launch confirmed; the follow-up market read failed, read it via candle_get_market"
  try {
    // No mint means there is no market to read. Interpolating it unchecked used to request
    // `/markets/<chain>/undefined` and rely on that 404ing into the note below; asking for the
    // mint we actually have, or not asking at all, says the same thing without the round trip.
    if (mint === undefined) throw new Error("the launch response carried no mint")
    const marketRes = await doFetch(
      `${base(cfg)}/api/v1/markets/${encodeURIComponent(chain)}/${encodeURIComponent(mint)}`,
      {
        method: "GET",
        headers: headers(),
      },
    )
    if (!marketRes.ok) return { market: null, note }
    return { market: (JSON.parse(await marketRes.text()) as { market?: unknown }).market ?? null }
  } catch {
    return { market: null, note }
  }
}

/**
 * The API's per-launch dev-buy ceilings on Solana, raw (DEV_BUY_MAX_* in the API's
 * headless-validation.ts), and the experimental presets' own creator-buy caps
 * (EXP_CURVE_DEV_BUY_MAX_RAW in @candle/shared): on an exp- preset the effective cap is
 * min(10% of G, the ordinary ceiling), as the server's `devBuyCeiling()` computes it. The server
 * holds the creator's own first-buy leg to the effective ceiling on the atomic route (BE-1849
 * review), env overrides included; this local refusal is the early, no-upload answer in the API's
 * words, not the authority -- a tighter server ceiling is refused by the dry run and the build,
 * and nothing is sent. Inlined: this package builds without @candle/shared. An `exp-custom`
 * curve's own cap is 10% of its G, which only the server can see; the server guard holds that leg.
 */
const SOLANA_SEED_CEILINGS: Record<string, { raw: bigint; unit: string; expRaw?: bigint }> = {
  sol: { raw: 500_000_000n, unit: "lamports", expRaw: 500_000_000n },
  usdc: { raw: 500_000_000n, unit: "USDC raw units" },
  cndl: { raw: 2_000_000_000_000n, unit: "CNDL raw units", expRaw: 33_000_000_000n },
}

/** A Solana seed over the effective dev-buy ceiling, refused in the API's words before any upload or request. */
function seedCeilingRefusal(
  quoteAsset: string,
  mode: string | undefined,
  buyAmount: string,
  clientLaunchId: string,
): ToolText | undefined {
  const quote = quoteAsset.toLowerCase()
  const ceiling = SOLANA_SEED_CEILINGS[quote]
  if (!ceiling) return undefined
  const expCap = ceiling.expRaw
  const preset = mode === "exp-a" || mode === "exp-b" || mode === "exp-c"
  const effective = preset && expCap !== undefined && expCap < ceiling.raw ? expCap : ceiling.raw
  if (BigInt(buyAmount) <= effective) return undefined
  if (preset && expCap !== undefined) {
    return {
      text: JSON.stringify({
        clientLaunchId,
        success: false,
        error: {
          code: "DEV_BUY_TOO_HIGH",
          message: `buyAmount exceeds this launch's dev-buy ceiling of ${effective} ${ceiling.unit}: at most ${ceiling.raw} ${ceiling.unit}, or 10% of the threshold when that is lower`,
          field: "devBuy",
          retryable: false,
        },
      }),
      isError: true,
    }
  }
  return {
    text: JSON.stringify({
      clientLaunchId,
      success: false,
      error: {
        code: "DEV_BUY_TOO_HIGH",
        message: `buyAmount exceeds the per-launch dev-buy ceiling of ${effective} ${ceiling.unit} for ${quote} on solana`,
        field: "devBuy",
        retryable: false,
      },
    }),
    isError: true,
  }
}

/** The embedded wallet pays for both legs of an atomic launch, and Candle signs both at /submit. */
const MAIN_PAYER = { type: "main" } as const

/**
 * BE-1849: a Solana launch and its seed as one atomic launch, on the route `candle launch --buy`
 * takes. The embedded wallet is the creator and the only first buyer. A dry run goes to
 * `/launch/atomic/dry-run`, which writes nothing. A launch is `/launch/atomic/build`, then one
 * `/launch/atomic/submit` with no client legs: Candle signs both and relays them to Jito, so the
 * launch and the seed land together or not at all. Pro or Max only, and the key needs swap:write.
 */
async function launchAndSeedAtomic(
  launchBody: Record<string, unknown>,
  buyAmount: string,
  ctx: {
    clientLaunchId: string
    uploaded: Record<string, unknown>
    dryRun: boolean
    transportFailure: (thrown: unknown) => ToolText
  },
  cfg: RequestConfig,
  doFetch: FetchLike,
): Promise<ToolText> {
  const apiKey = requireApiKey(cfg)
  const { clientLaunchId, uploaded } = ctx
  const failed = (api: unknown, extra: Record<string, unknown> = {}): ToolText => ({
    text: JSON.stringify({ clientLaunchId, ...uploaded, ...extra, api }),
    isError: true,
  })
  const body = { ...launchBody, payer: MAIN_PAYER, firstBuys: [{ payer: MAIN_PAYER, amountRaw: buyAmount }] }
  const built = await postJson(
    `${base(cfg)}/api/v1/launch/atomic/${ctx.dryRun ? "dry-run" : "build"}`,
    apiKey,
    body,
    doFetch,
  )
  if ("thrown" in built) return ctx.transportFailure(built.thrown)
  if (!built.ok) return failed(built.body)
  if (ctx.dryRun) return { text: JSON.stringify({ clientLaunchId, dryRun: true, ...uploaded, api: built.body }) }

  const bundle = built.body as { bundleId?: unknown; legs?: Array<{ signer?: unknown }> }
  // Every leg is the embedded wallet's, so Candle signs every one. A bundle that hands this tool a
  // leg to sign is not this launch: nothing is sent, and the build expires unsent.
  if (
    typeof bundle.bundleId !== "string" ||
    !Array.isArray(bundle.legs) ||
    bundle.legs.length !== 2 ||
    bundle.legs.some((leg) => leg?.signer !== "server")
  )
    return failed(built.body, {
      success: false,
      error: {
        code: "MCP_INVALID_RESPONSE",
        message:
          "Candle did not build this launch and its seed as two legs it signs from the embedded wallet; nothing was sent. Retry with the same clientLaunchId to build it again.",
      },
    })
  const bundleId = bundle.bundleId
  const submitted = await postJson(
    `${base(cfg)}/api/v1/launch/atomic/submit`,
    apiKey,
    { bundleId, signedTxsBase64: [] },
    doFetch,
  )
  if ("thrown" in submitted) return ctx.transportFailure(submitted.thrown)
  const outcome = submitted.body as { status?: string; mint?: string }
  if (!submitted.ok || outcome.status !== "landed") {
    const next =
      outcome.status === "failed"
        ? "Neither the launch nor the seed is on chain. Retry with the same clientLaunchId: Candle starts a clean attempt under it."
        : outcome.status === "timeout"
          ? "The bundle is unresolved and may still land. Call candle_get_operation with this clientLaunchId and kind launch; never relaunch under a new id, which would be a second token."
          : undefined
    return failed(submitted.body, { bundleId, ...(next ? { next } : {}) })
  }
  const { market, note } = await readLaunchedMarket("solana", outcome.mint, cfg, doFetch)
  return {
    text: JSON.stringify({
      clientLaunchId,
      bundleId,
      ...uploaded,
      launch: submitted.body,
      market,
      ...(note ? { note } : {}),
    }),
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

/**
 * candle_resolve_token: a contract address in, the token's market out.
 *
 * The chain is not asked for and not guessed. `chainForMint` reads it off the address's own shape,
 * which is the same rule the API applies, and it is deterministic rather than a heuristic in the
 * risky sense: an EVM address is 0x-prefixed and a Solana mint is base58, so the two cannot be
 * confused. An agent handed a bare CA by a human therefore does not have to ask which chain it is
 * on, which is the whole point of the tool.
 *
 * The market body is relayed as-is, 404 included: "Candle has no market for this mint" is a real
 * answer an agent must be able to act on, and turning it into a guess about the token would be
 * worse than returning nothing.
 */
export interface ResolveTokenArgs {
  mint: string
}

export async function resolveToken(args: ResolveTokenArgs, cfg: RequestConfig, doFetch: FetchLike): Promise<ToolText> {
  const chain = chainForMint(args.mint)
  const read = await readMarket(args.mint, cfg, doFetch, { mint: args.mint, chain })
  if ("err" in read) return read.err
  return { text: JSON.stringify({ success: true, chain, mint: args.mint, market: read.market }, null, 2) }
}

/**
 * candle_execution_status: one call answering "can this key trade right now, and if not, what is
 * missing".
 *
 * Three reads that an agent would otherwise have to know to make separately and in the right
 * order: the embedded wallets it executes with, the tier that decides what it may trade, and the
 * calling key's own spend limits.
 *
 * Each read is reported as it came back. A failing read is NOT flattened into "not ready": a 500
 * on the tier endpoint and a key that genuinely lacks a tier are different situations, and an
 * agent told "not ready" for the first one would go and re-run setup that was never broken. The
 * `ready` flag is therefore only ever false because a read SUCCEEDED and said so.
 */
export async function executionStatus(cfg: RequestConfig, doFetch: FetchLike): Promise<ToolText> {
  const apiKey = requireApiKey(cfg)
  const get = async (path: string) => {
    const res = await doFetch(`${base(cfg)}${path}`, { method: "GET", headers: headers(apiKey) })
    noteVersionHeaders(res)
    const text = await res.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    return { ok: res.ok, status: res.status, body }
  }

  const [wallets, tier, limits] = await Promise.all([
    get("/api/v1/agent/wallets/embedded"),
    get("/api/v1/agent/tier"),
    get("/api/v1/agent/keys/self/limits"),
  ])

  const unreadable = [
    ["wallets", wallets],
    ["tier", tier],
    ["limits", limits],
  ].filter(([, r]) => !(r as { ok: boolean }).ok)

  const tierBody = tier.ok
    ? (tier.body as { maxExpired?: boolean; maxExpiredNotice?: string; feeBps?: number })
    : undefined

  return {
    text: JSON.stringify(
      {
        success: true,
        // Undefined rather than false when a read failed: the honest answer is "not known", and a
        // false here would read as "authorized: no" to a model that cannot see the reads.
        ready: unreadable.length === 0 ? true : undefined,
        // Surfaced at the TOP of the context, not buried in tier.body, because it changes what a
        // trading agent should do next: an account whose Max lapsed pays a per-trade platform fee
        // it may be assuming is zero. The sentence is the server's own copy, so the agent relays
        // the same words the CLI and the refusal messages use.
        notice: tierBody?.maxExpired ? tierBody.maxExpiredNotice : undefined,
        // Structured so an agent can act (relay it, or run the command); null-when-current is
        // omitted entirely rather than sent as noise.
        updateAvailable: updateAvailable() ?? undefined,
        unreadable: unreadable.length > 0 ? unreadable.map(([name]) => name) : undefined,
        wallets: wallets.body,
        tier: tier.body,
        limits: limits.body,
      },
      null,
      2,
    ),
    ...(unreadable.length > 0 ? { isError: true } : {}),
  }
}
