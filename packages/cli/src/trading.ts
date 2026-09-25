/** Remote trading only: the P-256 authorization key approves a Candle-built relay request.
 * This module never opens a vault or handles a Solana or EVM private key. */
import { createHash, sign } from "node:crypto"
import { type FileHandle, mkdir, open, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { keccak_256 } from "@noble/hashes/sha3"
import { base58 } from "@scure/base"
import { z } from "zod"
import { apiRequest } from "./client"
import type { CommandContext } from "./deps"
import { resolveApiKey } from "./deps"
import {
  checkEvmAddress,
  type EvmTransaction,
  HOOD_CHAIN_ID,
  HOOD_USDG_ADDRESS,
  HOOD_USDG_DECIMALS,
  HOOD_WETH_ADDRESS,
  hexToBytes,
  NATIVE_DECIMALS,
  quantity,
  sameEvmAddress,
  signedTransactionCovers,
} from "./evm-lite"
import { storedSignerToPem, walletSignerRef } from "./secret-store"
import { openSolanaClient, rateLimitedMessage, rateLimitedSuggestion, type SolanaClient } from "./solana-endpoint"
import type { SolanaRpcError } from "./solana-lite"

export class TradingError extends Error {
  /** A fix the failure envelope carries beside the message, when there is one (BE-355, D3, D4). */
  readonly suggestion?: string
  /**
   * 1 for every refusal, as always. 3 for the one uncertain outcome a trading command has: a rate
   * limit after a signature (BE-355, D4), where the transaction may still land and nothing is
   * re-sent. `tradingFailure` returns it.
   */
  readonly exitCode: 1 | 3
  /**
   * Facts the `--json` envelope carries beside the message (Phase 4b, D4): the sequenced
   * operation's id, the legs that landed, and an uncertain leg's hash. The message says the same.
   */
  readonly details?: Record<string, unknown>
  constructor(
    public code: string,
    message: string,
    opts: { suggestion?: string; exitCode?: 1 | 3; details?: Record<string, unknown> } = {},
  ) {
    super(message)
    this.suggestion = opts.suggestion
    this.exitCode = opts.exitCode ?? 1
    this.details = opts.details
  }
}
export type Json = Record<string, unknown>
const feeSchema = z.object({ bps: z.number().finite().nonnegative(), feeRaw: z.string().regex(/^\d+$/) }).passthrough()
const risksSchema = z.array(z.object({ mint: z.string(), message: z.string() }).passthrough())
const artifactSchema = z.object({
  venue: z.string(),
  quoteSource: z.string().optional(),
  priceImpactPct: z.string().nullable().optional(),
  tokenRisks: risksSchema.default([]),
  transactionBase64: z.string().optional(),
  quoteAsset: z.string().optional(),
})
export const swapBuildSchema = z.object({
  status: z.literal("built"),
  minOutRaw: z.string().regex(/^\d+$/),
  fee: feeSchema,
  expiresAt: z.number().finite(),
  artifacts: artifactSchema.optional(),
  venue: z.string().optional(),
  priceImpactPct: z.string().nullable().optional(),
  tokenRisks: risksSchema.default([]),
  transactionsBase64: z.array(z.string()).optional(),
  swapId: z.string().optional(),
  recipient: z.string().optional(),
})
export const launchBuildSchema = z.object({
  transaction: z.string().min(1),
  maxDebitLamports: z.string().regex(/^\d+$/),
  expiresAt: z.number().finite(),
  fee: feeSchema.optional(),
})
const walletSchema = z.object({
  id: z.string(),
  address: z.string(),
  label: z.string().optional(),
  chain: z.string(),
  active: z.boolean(),
  allowLaunch: z.boolean(),
  privyWalletId: z.string().optional(),
})
const walletPageSchema = z.object({
  scopes: z.array(z.string()),
  privyAppId: z.string().nullable(),
  page: z.array(walletSchema),
  isDone: z.boolean(),
  continueCursor: z.string().nullable().optional(),
})
/** `GET /wallets/embedded`: the account's own launch wallets, per chain (`evm` is the Hood one, Phase 4b D6). */
const embeddedSchema = z
  .object({
    wallets: z
      .object({
        solana: z.object({ address: z.string() }).passthrough().nullable().optional(),
        evm: z.object({ address: z.string() }).passthrough().nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
export const operationSchema = z.object({ job: z.object({ status: z.string() }).passthrough() }).passthrough()
/** Ember Phase 3 PR D (BE-315, R4): the LP build routes' response, `POST /agent/lp/{add,remove,claim}/build`. */
const lpAmountSchema = z.object({ mint: z.string(), raw: z.string().regex(/^\d+$/), decimals: z.number().int() })
export const lpBuildSchema = z.object({
  build: z
    .object({
      action: z.enum(["add", "remove", "claim"]),
      pool: z.string(),
      position: z.string(),
      transaction: z.string().min(1),
      walletAddress: z.string(),
      signature: z.string().optional(),
    })
    .passthrough(),
  preview: z
    .object({
      amounts: z.array(lpAmountSchema).default([]),
      tokenRisks: risksSchema.default([]),
      warnings: z.array(z.string()).default([]),
      candleFeeBps: z.number().optional(),
    })
    .passthrough()
    .nullable(),
  replay: z.boolean().optional(),
})
export const lpPositionsSchema = z.object({
  positions: z.array(
    z
      .object({
        position: z.string(),
        pool: z.string(),
        tokens: z.array(
          z
            .object({
              mint: z.string(),
              decimals: z.number().int(),
              amountRaw: z.string(),
              unclaimedFeesRaw: z.string(),
              valueUsd: z.number().nullable().optional(),
            })
            .passthrough(),
        ),
        poolShare: z.number().optional(),
        valueUsd: z.number().nullable().optional(),
      })
      .passthrough(),
  ),
})
export const lpPoolsSchema = z.object({
  page: z.number().int(),
  pages: z.number().int(),
  pools: z.array(
    z
      .object({
        pool: z.string(),
        tokens: z.array(z.string()),
        liquidityUsd: z.number().nullable().optional(),
        baseFeePercent: z.number().nullable().optional(),
        volume24hUsd: z.number().nullable().optional(),
        estimatedAprPercent: z.number().nullable().optional(),
      })
      .passthrough(),
  ),
})
export interface QuoteDisplay {
  intent?: string
  wallet?: string
  venue?: string
  priceImpactPct?: string | null
  fee: z.infer<typeof feeSchema>
  minimumReceived: string
  maxDebitLamports?: string
  tokenRisks: z.infer<typeof risksSchema>
  /** Phase 4b (D6): a Hood TEE quote names every leg, the gas estimate and the reserve before confirmation. */
  legs?: string[]
  gas?: string
  reserve?: string
}
export const BASES: Record<string, { mint: string; decimals: number }> = {
  SOL: { mint: "So11111111111111111111111111111111111111112", decimals: 9 },
  USDC: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  CNDL: { mint: "9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL", decimals: 6 },
}
export function baseAsset(value: string): string | undefined {
  return Object.keys(BASES).find((key) => key === value.toUpperCase() || BASES[key]?.mint === value)
}
export function solanaAsset(value: string): string {
  const base = baseAsset(value)
  if (base) return base
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))
    throw new TradingError(
      "PAIR_UNSUPPORTED",
      "Use SOL, USDC, CNDL or a Solana mint on Solana, or ETH, USDG or a 0x token address on Hood.",
    )
  return value
}

/** Hood's base assets (Phase 4b, D6). ETH is native; USDG is an ERC-20 and also answers by address. */
export const HOOD_BASES: Record<string, { address: string | null; decimals: number }> = {
  ETH: { address: null, decimals: NATIVE_DECIMALS },
  USDG: { address: HOOD_USDG_ADDRESS, decimals: HOOD_USDG_DECIMALS },
}
export type TradeChain = "solana" | "hood"
/** One side of `candle swap`, with the chain it names. `asset` is a base symbol, a Solana mint, or a checksummed 0x token. */
export interface TradeAsset {
  chain: TradeChain
  asset: string
  base?: string
}

/**
 * D6: the assets decide the chain. A `0x...` address, `ETH` or `USDG` is Hood; a base58 mint,
 * `SOL`, `USDC` or `CNDL` is Solana. USDG named by its address is the base asset, not a token.
 */
export function classifyAsset(value: string): TradeAsset {
  const upper = value.toUpperCase()
  if (HOOD_BASES[upper]) return { chain: "hood", asset: upper, base: upper }
  if (/^0x/i.test(value)) {
    const checked = checkEvmAddress(value)
    if (!checked.ok)
      throw new TradingError("PAIR_UNSUPPORTED", `${safeText(value)} is not a Hood token: ${checked.reason}.`)
    if (sameEvmAddress(checked.address, HOOD_USDG_ADDRESS)) return { chain: "hood", asset: "USDG", base: "USDG" }
    return { chain: "hood", asset: checked.address }
  }
  const asset = solanaAsset(value)
  const base = baseAsset(asset)
  return { chain: "solana", asset, ...(base ? { base } : {}) }
}

/** Both sides on one chain, or `CHAIN_MISMATCH` before anything is requested (D6, H7). */
export function pairChain(from: TradeAsset, to: TradeAsset): TradeChain {
  if (from.chain !== to.chain)
    throw new TradingError(
      "CHAIN_MISMATCH",
      `${safeText(from.asset)} is on ${chainName(from.chain)} and ${safeText(to.asset)} is on ${chainName(to.chain)}; a swap stays on one chain. Nothing was built.`,
    )
  return from.chain
}

export function chainName(chain: TradeChain): string {
  return chain === "hood" ? "Hood" : "Solana"
}

/**
 * The chain a `--wallet` value names by its shape alone, when that is certain: a 0x address is a
 * Hood wallet. Anything else says nothing before the listing, because a wallet id can look like a
 * base58 address.
 */
export function walletNameChain(name: string): TradeChain | undefined {
  return /^0x[0-9a-fA-F]{40}$/.test(name) ? "hood" : undefined
}

/** A wallet row's chain as the trade rails name it: the server's `evm` rows are Hood wallets. */
function rowChain(row: { chain: string }): TradeChain | undefined {
  return row.chain === "solana" ? "solana" : row.chain === "evm" ? "hood" : undefined
}

export function chainMismatch(what: string, walletChain: TradeChain | undefined, chain: TradeChain): TradingError {
  return new TradingError(
    "CHAIN_MISMATCH",
    `${what} is a ${walletChain ? chainName(walletChain) : "non-trading-chain"} wallet and this operation is on ${chainName(chain)}. The wallet decides the chain: name ${chain === "hood" ? "ETH, USDG or a 0x token" : "SOL, USDC, CNDL or a Solana mint"}, or a ${chainName(chain)} wallet. Nothing was built.`,
  )
}
export function rawAmount(value: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || !/^\d+(\.\d+)?$/.test(value))
    throw new TradingError("INVALID_AMOUNT", "Use a positive decimal amount without exponent notation.")
  const [whole = "", fraction = ""] = value.split(".")
  if (fraction.length > decimals)
    throw new TradingError("INVALID_AMOUNT", `This asset supports ${decimals} decimal places.`)
  const raw = BigInt(whole + fraction.padEnd(decimals, "0"))
  if (raw <= 0n) throw new TradingError("INVALID_AMOUNT", "Amount must be greater than zero.")
  return raw.toString()
}
export function decimalAmount(raw: string, decimals: number): string {
  const digits = BigInt(raw)
    .toString()
    .padStart(decimals + 1, "0")
  return decimals ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}` : digits
}
export async function tradingKey(ctx: CommandContext): Promise<string> {
  const key = await resolveApiKey(ctx.deps, ctx.profile)
  if (!key)
    throw new TradingError(
      "API_KEY_REQUIRED",
      "Select the profile holding this TEE wallet's bound API key. A device/session cannot pay.",
    )
  return key
}
export async function request(ctx: CommandContext, key: string, path: string, body?: Json): Promise<Json> {
  const result = await apiRequest(path, {
    apiUrl: ctx.apiUrl,
    credentials: { apiKey: key },
    auth: "key",
    method: body ? "POST" : "GET",
    body,
    fetch: ctx.deps.fetch,
    env: ctx.deps.env,
  })
  if (!result.ok) throw new TradingError(result.code ?? "REQUEST_FAILED", result.message)
  if (!result.body || typeof result.body !== "object")
    throw new TradingError("INVALID_RESPONSE", "Candle returned an invalid response.")
  return result.body as Json
}
export interface TradingWallet {
  id: string
  address: string
  privyWalletId: string
  appId: string
  signer: string
  /** The server's row chain. An `evm` wallet signs only sequenced Hood legs (Phase 4b, D4). */
  chain: "solana" | "evm"
}
type WalletRow = z.infer<typeof walletSchema>

/**
 * Every page of `/wallets/trading`, kept whole rather than filtered down to the caller's match.
 *
 * Keeping the full list is the point. The refusals below name what IS usable on this account, and
 * that answer cannot be assembled from a match that did not happen -- which is the same family of
 * problem as BE-242's truncated listing: the CLI knew and did not say.
 */
export type TradingWalletRow = WalletRow
export async function listTradingWallets(
  ctx: CommandContext,
  key: string,
  /** A scope the bound key must carry; omitted for a read that `requireAgentKey("any")` admits. */
  scope?: string,
): Promise<{ rows: WalletRow[]; appId: string; scopes: string[] }> {
  let cursor: string | undefined
  const rows: WalletRow[] = []
  const cursors = new Set<string>()
  let appId = ""
  let scopes: string[] = []
  for (;;) {
    const response = walletPageSchema.parse(
      await request(ctx, key, `/api/v1/agent/wallets/trading${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
    )
    if (scope !== undefined && !response.scopes?.includes(scope))
      throw new TradingError("SCOPE_MISSING", `The bound key needs ${scope}.`)
    appId = response.privyAppId ?? ""
    scopes = response.scopes
    if (!Array.isArray(response.page))
      throw new TradingError("INVALID_RESPONSE", "Wallet discovery did not return a page.")
    rows.push(...response.page)
    if (response.isDone === true) break
    cursor = response.continueCursor ?? undefined
    if (!cursor || cursors.has(cursor)) throw new TradingError("INVALID_RESPONSE", "Wallet discovery did not complete.")
    cursors.add(cursor)
  }
  return { rows, appId, scopes }
}

function matchesName(row: WalletRow, name: string): boolean {
  return row.id === name || sameAddress(row.address, name) || row.label === name
}

/** How a TEE wallet is named back to someone who has to pick one: label first, then id and address. */
function describeWallet(row: WalletRow): string {
  return `${row.label ? `${row.label} ` : ""}(${row.id}, ${row.address})`
}

function teeWalletList(rows: WalletRow[]): string {
  return rows.map(describeWallet).join("; ")
}

/**
 * `chain` is the operation's chain (D6). A wallet on another chain is refused as `CHAIN_MISMATCH`,
 * and that is the only chain refusal: an EVM TEE wallet is a payer for a Hood operation. Callers
 * that are Solana-only in 4b-1 (launch, LP, transfer) keep the default.
 */
export async function completeTradingWallet(
  ctx: CommandContext,
  row: WalletRow,
  appId: string,
  scope: string,
  chain: TradeChain = "solana",
): Promise<TradingWallet> {
  if (rowChain(row) !== chain) throw chainMismatch(`TEE wallet ${describeWallet(row)}`, rowChain(row), chain)
  if (!row.active)
    throw new TradingError("TEE_WALLET_INACTIVE", `The payer must be a verified-active ${chainName(chain)} TEE wallet.`)
  if (scope === "launch:write" && row.allowLaunch !== true)
    throw new TradingError(
      "LAUNCH_NOT_ALLOWED",
      `The operator must enable allowLaunch for wallet ${row.id} through PUT /api/v1/agent/wallets/${row.id}/capabilities using device/session authentication.`,
    )
  if (!appId || !row.privyWalletId)
    throw new TradingError("SIGNER_UNAVAILABLE", "The server did not return its relay public identifiers.")
  const signer = await ctx.deps.store.get(walletSignerRef(row.id))
  if (!signer)
    throw new TradingError(
      "SIGNER_UNAVAILABLE",
      "This machine does not hold the wallet's relay authorization key. Use the machine that enabled it.",
    )
  return {
    id: row.id,
    address: row.address,
    privyWalletId: row.privyWalletId,
    appId,
    signer: storedSignerToPem(signer),
    chain: row.chain === "evm" ? "evm" : "solana",
  }
}
/**
 * Resolve one TEE wallet by id, address or label. The launch rail's resolver: a launch pays from a
 * TEE wallet with `allowLaunch`, and nothing else, so it stays narrow on purpose.
 *
 * Only its REFUSALS changed with BE-249. "Name exactly one TEE wallet" answered a question nobody
 * asked -- the caller knew they had to name one, they did not know which names existed. Both
 * refusals below now say.
 */
export async function tradingWallet(
  ctx: CommandContext,
  key: string,
  name: string,
  scope: string,
): Promise<TradingWallet> {
  const { rows, appId } = await listTradingWallets(ctx, key, scope)
  const matches = rows.filter((row) => matchesName(row, name))
  if (matches.length !== 1) {
    throw new TradingError(
      "TEE_WALLET_REQUIRED",
      matches.length > 1
        ? `"${name}" matches ${matches.length} TEE wallets on this key: ${teeWalletList(matches)}. Name one by id or address.`
        : rows.length === 0
          ? "This key has no TEE wallets bound to it. Enrol one, or select the profile whose key holds it."
          : `No TEE wallet on this key is called "${name}". Bound to this key: ${teeWalletList(rows)}.`,
    )
  }
  return await completeTradingWallet(ctx, matches[0] as WalletRow, appId, scope)
}

/**
 * Who will pay for a `candle swap`, resolved across BOTH payer kinds the trade API accepts.
 *
 * The bug BE-249 is about lived here: this command only ever looked at `/wallets/trading`, which
 * is TEE-only by construction, so the account's embedded wallet -- which the API has always
 * accepted as `payer.type: "main"`, and which launches and one-shot swaps already use -- could not
 * be named at all, and the refusal insisted a TEE wallet was the only possible answer.
 *
 * `name` is optional. Omitted, this resolves when the account has exactly ONE payer of any kind:
 * a single-wallet account should not have to name the only wallet it has. With more than one, it
 * refuses and lists them, because guessing which wallet spends someone's money is not a default
 * worth having.
 */
export type SwapPayer =
  | { kind: "tee"; wallet: TradingWallet; scopes: string[] }
  /** The account's own embedded (main) wallet on the operation's chain. Candle holds its delegation and signs server-side. */
  | { kind: "embedded"; address: string; scopes: string[] }

/**
 * `scope` is what the bound key must carry for the rail the caller is on: `swap:write` for a swap
 * (the default), `transfer:write` for `candle transfer`. The key's whole scope list rides back on
 * the payer, so a caller can refuse a wallet its key cannot act on before anything is built.
 *
 * `chain` is the operation's chain (Phase 4b, D6). Without a name, the payer is the key's single
 * wallet ON THAT CHAIN: its TEE wallets there (EVM TEE wallets for Hood) and the account's
 * embedded wallet there. A named wallet is matched across every chain, so that naming a wallet on
 * the other chain answers `CHAIN_MISMATCH` rather than "not a wallet this account can pay from".
 */
export async function tradingPayer(
  ctx: CommandContext,
  key: string,
  name: string | undefined,
  scope = "swap:write",
  chain: TradeChain = "solana",
): Promise<SwapPayer> {
  const { rows, appId, scopes } = await listTradingWallets(ctx, key, scope)
  // Read even when a name was given: it is what lets a miss say "here is what you could have
  // meant" instead of naming only half the account.
  const wallets = embeddedSchema.parse(await request(ctx, key, "/api/v1/agent/wallets/embedded")).wallets
  const embeddedOn: Record<TradeChain, string | undefined> = {
    solana: wallets?.solana?.address,
    hood: wallets?.evm?.address,
  }
  const embedded = embeddedOn[chain]
  const onChain = rows.filter((row) => rowChain(row) === chain)
  const asEmbedded = (): SwapPayer => ({ kind: "embedded", address: embedded as string, scopes })
  const options = [
    ...onChain.map((row) => `TEE ${describeWallet(row)}`),
    ...(embedded ? [`embedded (${embedded})`] : []),
  ].join("; ")

  if (name === undefined) {
    if (onChain.length === 1 && !embedded)
      return {
        kind: "tee",
        wallet: await completeTradingWallet(ctx, onChain[0] as WalletRow, appId, scope, chain),
        scopes,
      }
    if (onChain.length === 0 && embedded) return asEmbedded()
    throw new TradingError(
      "PAYER_REQUIRED",
      options.length === 0
        ? `This account has no ${chainName(chain)} wallet that can pay for this. Enrol a ${chainName(chain)} TEE wallet, or create an embedded wallet in the app.`
        : `Name the payer with --wallet. On ${chainName(chain)} this account can pay from: ${options}.`,
    )
  }

  const matches = rows.filter((row) => matchesName(row, name))
  if (matches.length === 1)
    return {
      kind: "tee",
      wallet: await completeTradingWallet(ctx, matches[0] as WalletRow, appId, scope, chain),
      scopes,
    }
  if (matches.length === 0) {
    if (embedded !== undefined && sameAddress(embedded, name)) return asEmbedded()
    for (const other of Object.keys(embeddedOn) as TradeChain[]) {
      const address = embeddedOn[other]
      if (other !== chain && address !== undefined && sameAddress(address, name))
        throw chainMismatch(`The embedded wallet ${address}`, other, chain)
    }
  }
  throw new TradingError(
    "TEE_WALLET_REQUIRED",
    matches.length > 1
      ? `"${name}" matches ${matches.length} TEE wallets on this key: ${teeWalletList(matches)}. Name one by id or address.`
      : options.length === 0
        ? `"${name}" is not a wallet this account can pay from, and it has none on ${chainName(chain)}: enrol a TEE wallet, or create an embedded wallet in the app.`
        : `"${name}" is not a wallet this account can pay from. On ${chainName(chain)} it can pay from: ${options}.`,
  )
}

/** An EVM address matches in either spelling; a Solana address only exactly. */
function sameAddress(a: string, b: string): boolean {
  return a === b || (/^0x/i.test(a) && /^0x/i.test(b) && sameEvmAddress(a, b))
}

export function authorizationSignature(
  wallet: Pick<TradingWallet, "appId" | "privyWalletId" | "signer">,
  transaction: string,
): { authorizationSignature: string; body: Json } {
  // All payload leaves are strings or the fixed integer 1. Insertion order below is RFC 8785
  // lexical order at every object level; tests compare these bytes to the existing SDK.
  const body = { method: "signTransaction", params: { encoding: "base64", transaction } }
  const payload = JSON.stringify({
    body,
    headers: { "privy-app-id": wallet.appId },
    method: "POST",
    url: `https://api.privy.io/v1/wallets/${wallet.privyWalletId}/rpc`,
    version: 1,
  })
  return { body, authorizationSignature: sign("sha256", Buffer.from(payload), wallet.signer).toString("base64") }
}
export async function relaySign(
  ctx: CommandContext,
  key: string,
  wallet: TradingWallet,
  transaction: string,
): Promise<string> {
  if (!transaction) throw new TradingError("INVALID_RESPONSE", "Candle returned no transaction to sign.")
  const result = await request(
    ctx,
    key,
    `/api/v1/agent/wallets/${encodeURIComponent(wallet.id)}/sign`,
    authorizationSignature(wallet, transaction),
  )
  if (typeof result.signedTransaction !== "string" || result.encoding !== "base64")
    throw new TradingError("INVALID_RESPONSE", "The relay did not return a base64 signed transaction.")
  return result.signedTransaction
}
// ── Phase 4b (D4): EVM TEE legs, one at a time ────────────────────────────────────────────────

/** The `nextLeg` a sequenced build returns (D4): the server's nonce, gas and type-2 fees, signed as-is. */
const sequencedLegSchema = z.object({
  chainId: z.number().int(),
  nonce: z.number().int().nonnegative(),
  gas: z.string().regex(/^\d+$/),
  maxFeePerGas: z.string().regex(/^\d+$/),
  maxPriorityFeePerGas: z.string().regex(/^\d+$/),
  to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  data: z.string().regex(/^0x([0-9a-fA-F]{2})*$/),
  value: z.string().regex(/^\d+$/),
})
export type SequencedLeg = z.infer<typeof sequencedLegSchema>
const legKindSchema = z.enum(["approval", "permit2Approval", "trade", "feeTransfer"])
export type LegKind = z.infer<typeof legKindSchema>
const landedLegSchema = z.object({ kind: z.string(), hash: z.string() }).passthrough()
export type LandedLeg = { kind: string; hash: string }
/** D4's envelope, under the discriminator the all-legs client never reads. */
export const sequencedSchema = z
  .object({
    mode: z.literal("sequenced"),
    operationId: z.string().min(1),
    legKind: legKindSchema,
    plannedLegCount: z.number().int().positive(),
    nextLeg: sequencedLegSchema,
    landedLegs: z.array(landedLegSchema).default([]),
    expiresAt: z.number().finite(),
  })
  .passthrough()
export type SequencedBody = z.infer<typeof sequencedSchema>

/**
 * `nextLeg` in Privy's `eth_signTransaction` wire shape (D4): the mapped fields, `type: 2` and
 * `from` set to the wallet, and no other key. Integers the wire carries as quantities go as hex
 * quantities, the SDK's encoding; the relay's claim hash normalizes them through `BigInt`, so a
 * hex quantity and the server's decimal string hash the same. Keys are in RFC 8785 lexical order,
 * which is the order `JSON.stringify` writes and Privy canonicalizes to.
 */
export function evmLegWire(wallet: Pick<TradingWallet, "address">, leg: SequencedLeg): Json {
  return {
    chain_id: leg.chainId,
    data: leg.data,
    from: wallet.address,
    gas_limit: quantity(BigInt(leg.gas)),
    max_fee_per_gas: quantity(BigInt(leg.maxFeePerGas)),
    max_priority_fee_per_gas: quantity(BigInt(leg.maxPriorityFeePerGas)),
    nonce: leg.nonce,
    to: leg.to,
    type: 2,
    value: quantity(BigInt(leg.value)),
  }
}

/**
 * The relay authorization for one EVM TEE leg. Same payload as `authorizationSignature`, with the
 * real method: the body names `eth_signTransaction`, never Solana's `signTransaction` (D6).
 */
export function evmAuthorizationSignature(
  wallet: TradingWallet,
  leg: SequencedLeg,
): { authorizationSignature: string; body: Json } {
  const body = { method: "eth_signTransaction", params: { transaction: evmLegWire(wallet, leg) } }
  const payload = JSON.stringify({
    body,
    headers: { "privy-app-id": wallet.appId },
    method: "POST",
    url: `https://api.privy.io/v1/wallets/${wallet.privyWalletId}/rpc`,
    version: 1,
  })
  return { body, authorizationSignature: sign("sha256", Buffer.from(payload), wallet.signer).toString("base64") }
}

function legTransaction(leg: SequencedLeg): EvmTransaction {
  return {
    chainId: BigInt(leg.chainId),
    nonce: BigInt(leg.nonce),
    maxPriorityFeePerGas: BigInt(leg.maxPriorityFeePerGas),
    maxFeePerGas: BigInt(leg.maxFeePerGas),
    gas: BigInt(leg.gas),
    to: leg.to,
    value: BigInt(leg.value),
    data: hexToBytes(leg.data),
  }
}

/**
 * Relay-sign one sequenced leg. The answer must be a raw type-2 transaction over exactly this leg
 * (`signedTransactionCovers`); anything else is refused before it is posted anywhere.
 */
export async function relaySignEvmLeg(
  ctx: CommandContext,
  key: string,
  wallet: TradingWallet,
  leg: SequencedLeg,
): Promise<{ raw: string; hash: string }> {
  const result = await request(
    ctx,
    key,
    `/api/v1/agent/wallets/${encodeURIComponent(wallet.id)}/sign`,
    evmAuthorizationSignature(wallet, leg),
  )
  const raw = result.signedTransaction
  if (typeof raw !== "string" || !/^0x02([0-9a-fA-F]{2})+$/.test(raw))
    throw new TradingError("INVALID_RESPONSE", "The relay did not return a raw signed type-2 transaction.")
  const bytes = hexToBytes(raw)
  if (!signedTransactionCovers(bytes, legTransaction(leg)))
    throw new TradingError(
      "INVALID_RESPONSE",
      "The relay returned a signature over a different transaction than the leg Candle built; nothing was sent.",
    )
  return { raw, hash: bytesToHexHash(bytes) }
}

function bytesToHexHash(raw: Uint8Array): string {
  return `0x${Buffer.from(keccak_256(raw)).toString("hex")}`
}

/**
 * The planned legs by kind, in send order (`approval?`, `permit2Approval?`, `trade`,
 * `feeTransfer?`), from what a sequenced build reveals: the first leg's kind, the planned count,
 * and whether a fee is owed. Undefined when those do not fit that order.
 */
export function plannedLegKinds(first: LegKind, count: number, hasFee: boolean): LegKind[] | undefined {
  const tail: LegKind[] = hasFee ? ["trade", "feeTransfer"] : ["trade"]
  const head = count - tail.length
  const candidates: LegKind[][] = [[], ["approval"], ["permit2Approval"], ["approval", "permit2Approval"]]
  const legs = candidates.filter((prefix) => prefix.length === head).map((prefix) => [...prefix, ...tail])
  return legs.find((plan) => plan[0] === first)
}

/** D5's reserve, mirrored from `apps/api/src/lib/hood-gas-reserve.ts` (a drift test holds the two together). */
export const ERC20_TRANSFER_GAS = 65_000n
export const ETH_TRANSFER_GAS = 21_000n
export const RESERVE_FEE_MULTIPLIER = 2n
export const RESERVE_EXTRA_ERC20_TRANSFERS = 1

/**
 * The sweep-home reserve at `maxFeePerGas`: USDG, WETH and `tokens` (deduped) plus one extra
 * ERC-20 transfer, then the final ETH transfer, at twice the fee. The server also counts its own
 * traded-token list, which the CLI cannot read, so this is the reserve's floor, never its ceiling.
 */
export function sweepReserveFloor(
  maxFeePerGas: bigint,
  tokens: readonly string[] = [],
): {
  wei: bigint
  erc20Transfers: number
} {
  const set = new Set([HOOD_USDG_ADDRESS, HOOD_WETH_ADDRESS, ...tokens].map((token) => token.toLowerCase()))
  const erc20Transfers = set.size + RESERVE_EXTRA_ERC20_TRANSFERS
  const gas = ERC20_TRANSFER_GAS * BigInt(erc20Transfers) + ETH_TRANSFER_GAS
  return { wei: gas * maxFeePerGas * RESERVE_FEE_MULTIPLIER, erc20Transfers }
}

export interface SequencedRun {
  /** The terminal response body: the route's own final result. */
  final: Json
  landed: LandedLeg[]
}

/**
 * THE LEG LOOP (D4, D6), entered only for a response with `mode: "sequenced"`: take `nextLeg`,
 * relay-sign it with `eth_signTransaction`, post `{ operationId, signedTransaction }`, read the
 * server's receipt (it answers only after the leg's receipt), repeat. Every leg is re-checked
 * before it is signed: Hood's chain id, the wallet's operation, and never a fee leg before the
 * trade leg has landed (invariant 3).
 *
 * Failure: a leg the server refused, or one that reverted, ends the operation with exit 1 and the
 * legs that landed. An uncertain leg (the server saw no receipt, or the submit itself got no
 * answer) exits 3 with that leg's hash, known before it was posted; `candle swap status <id>`
 * reads the operation without resending.
 */
export async function runSequencedLegs(
  ctx: CommandContext,
  key: string,
  opts: {
    wallet: TradingWallet
    first: SequencedBody
    /** `/api/v1/trade/agent/submit` or `/api/v1/agent/swap/submit`. */
    submitPath: string
    /** Route fields sent with every leg (`clientTradeId`, `swapId`). */
    submitFields: Json
    /** The next sequenced body, or the final result, out of one submit's answer. */
    unwrap: (body: Json) => Json
    clientId: string
    kind: OperationKind
    /** Runs once per leg that landed, in order. It must not throw. */
    onLanded: (leg: LandedLeg) => Promise<void>
  },
): Promise<SequencedRun> {
  let current = opts.first
  const landed: LandedLeg[] = []
  const noteLanded = async (legs: LandedLeg[]) => {
    for (const leg of legs.slice(landed.length)) {
      landed.push({ kind: leg.kind, hash: leg.hash })
      await opts.onLanded(leg)
    }
  }
  const failWith = (code: string, message: string, exitCode: 1 | 3, extra: Record<string, unknown> = {}) =>
    new TradingError(code, `${message}${describeLanded(landed)}`, {
      exitCode,
      details: { operationId: current.operationId, landedLegs: landed, ...extra },
    })
  for (;;) {
    await noteLanded(current.landedLegs)
    const leg = current.nextLeg
    if (leg.chainId !== HOOD_CHAIN_ID)
      throw failWith(
        "INVALID_RESPONSE",
        `The ${current.legKind} leg names chain ${leg.chainId}, not Hood; nothing was signed.`,
        1,
      )
    if (current.legKind === "feeTransfer" && !landed.some((done) => done.kind === "trade"))
      throw failWith(
        "INVALID_RESPONSE",
        "Candle offered the fee leg before the trade leg landed; nothing was signed.",
        1,
      )
    if (!Number.isFinite(current.expiresAt) || current.expiresAt <= ctx.deps.now())
      throw failWith(
        "QUOTE_EXPIRED",
        `Operation ${current.operationId}'s window closed before the ${current.legKind} leg was signed.`,
        1,
      )
    const signed = await relaySignEvmLeg(ctx, key, opts.wallet, leg)
    // Before the post, as the Solana rail saves its payer signature: a restart can read this hash.
    await saveOperationHash(ctx, key, opts.clientId, opts.kind, signed.hash, current.operationId)
    const posted = await apiRequest(opts.submitPath, {
      apiUrl: ctx.apiUrl,
      credentials: { apiKey: key },
      auth: "key",
      method: "POST",
      body: { ...opts.submitFields, operationId: current.operationId, signedTransaction: signed.raw },
      fetch: ctx.deps.fetch,
      env: ctx.deps.env,
    })
    if (!posted.ok) {
      const error = errorObject(posted.raw)
      await noteLanded(landedFrom(posted.raw, error))
      if (posted.status === 0 || error.stage === "unconfirmed") {
        const hash = typeof error.signature === "string" ? error.signature : signed.hash
        throw failWith(
          "LEG_UNCONFIRMED",
          `The ${current.legKind} leg ${hash} was posted and its receipt was not seen; it may still land. Nothing was re-sent.`,
          3,
          { hash, legKind: current.legKind },
        )
      }
      throw failWith(
        posted.code ?? "REQUEST_FAILED",
        `The ${current.legKind} leg failed: ${posted.message}`,
        1,
        typeof error.signature === "string"
          ? { hash: error.signature, legKind: current.legKind }
          : { legKind: current.legKind },
      )
    }
    const answer = opts.unwrap((posted.body ?? {}) as Json)
    if (answer.mode === "sequenced") {
      const next = sequencedSchema.safeParse(answer)
      if (!next.success || next.data.operationId !== current.operationId)
        throw failWith(
          "INVALID_RESPONSE",
          "Candle answered the leg with an unreadable next leg; nothing more was signed.",
          1,
        )
      current = next.data
      continue
    }
    // The last leg landed: the route answers its final result, and only after a status-1 receipt.
    const finalLanded = landedFrom(answer, {})
    await noteLanded(
      finalLanded.length > landed.length ? finalLanded : [...landed, { kind: current.legKind, hash: signed.hash }],
    )
    return { final: answer, landed }
  }
}

function describeLanded(landed: LandedLeg[]): string {
  return landed.length === 0
    ? " No leg landed."
    : ` Landed: ${landed.map((leg) => `${leg.kind} ${safeText(leg.hash)}`).join(", ")}.`
}

function errorObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {}
  const error = (raw as Json).error
  return error && typeof error === "object" ? (error as Record<string, unknown>) : {}
}

/** `landedLegs` rides on the error (swap rail) or beside it (trade rail); either is read. */
function landedFrom(raw: unknown, error: Record<string, unknown>): LandedLeg[] {
  const top = raw && typeof raw === "object" ? (raw as Json).landedLegs : undefined
  const list = Array.isArray(top) ? top : Array.isArray(error.landedLegs) ? error.landedLegs : []
  const parsed = z.array(landedLegSchema).safeParse(list)
  return parsed.success ? parsed.data.map((leg) => ({ kind: leg.kind, hash: leg.hash })) : []
}

/**
 * BE-355 (D1, D3): the Solana client a trading command reads and broadcasts over. Resolved by the
 * shared rule (`--rpc-url`, else `CANDLE_SOLANA_RPC_URL`, else the profile's, else the public
 * endpoint); a value that fails validation is a usage refusal, exit 2, thrown as `TradingUsage`
 * so the command's catch writes the `USAGE` envelope. `trading.ts`'s own looser `rpcUrl()` rule
 * (any `^https?://`) and its `rpc()` helper, which parsed the body before looking at the status,
 * are gone: the client detects and retries a rate limit the same way every other command does.
 */
export async function tradingSolanaClient(ctx: CommandContext, flag?: string): Promise<SolanaClient> {
  const client = await openSolanaClient(ctx, flag)
  if ("error" in client) throw new TradingUsage(client.error)
  return client
}
/** A usage refusal decided inside a trading command's `try`: exit 2 and the `USAGE` envelope. */
export class TradingUsage extends Error {}
/**
 * D3's refusal for a rate limit before any signature, as the trading commands throw it: the same
 * code, message and suggestion a vault command's `RPC_RATE_LIMITED` carries, exit 1.
 */
export function tradingRateLimited(ctx: CommandContext, host: string, error: SolanaRpcError): TradingError {
  return new TradingError("RPC_RATE_LIMITED", rateLimitedMessage(host, error), {
    suggestion: rateLimitedSuggestion(ctx),
  })
}
export type OperationKind = "trade" | "swap" | "launch" | "lp"
/** The kinds with a jobs route. An LP operation is looked up by its build's replay instead (lp.ts). */
export type JobKind = Exclude<OperationKind, "lp">
export function jobPath(kind: JobKind, id: string): string {
  const rail = kind === "launch" ? "launch/headless" : kind === "swap" ? "agent/swap" : "trade/agent"
  return `/api/v1/${rail}/jobs/${encodeURIComponent(id)}`
}
function operationPath(ctx: CommandContext, key: string, id: string): string {
  const dir = ctx.deps.env.CANDLE_CONFIG_DIR || join(ctx.deps.env.HOME || homedir(), ".config", "candle")
  const hash = createHash("sha256")
    .update(JSON.stringify([ctx.apiUrl, key, id]))
    .digest("hex")
  return join(dir, "operations", `${hash}.json`)
}
export async function savedOperation(
  ctx: CommandContext,
  key: string,
  id: string,
): Promise<{ kind: OperationKind; signature?: string } | null> {
  try {
    return JSON.parse(await readFile(operationPath(ctx, key, id), "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null
    throw error
  }
}
export async function claimOperation(
  ctx: CommandContext,
  key: string,
  id: string,
  kind: OperationKind,
): Promise<boolean> {
  const path = operationPath(ctx, key, id)
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 })
  let file: FileHandle
  try {
    file = await open(path, "wx", 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
    throw error
  }
  try {
    await file.writeFile(JSON.stringify({ id, kind }))
    await file.sync()
  } finally {
    await file.close()
  }
  return true
}
export function safeText(value: unknown): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: server-supplied text must not control the terminal.
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
}
export async function confirmQuote(ctx: CommandContext, quote: QuoteDisplay, yes: boolean): Promise<boolean> {
  const output = ctx.json ? ctx.deps.stderr : ctx.deps.stdout
  if (quote.intent) output.write(`${safeText(quote.intent)}\n`)
  if (quote.wallet) output.write(`Payer: ${safeText(quote.wallet)}\n`)
  output.write(
    `Venue: ${safeText(quote.venue)}\nPrice impact: ${quote.priceImpactPct == null ? "unavailable" : `${safeText(quote.priceImpactPct)}%`}\nTier fee: ${safeText(quote.fee.bps)} bps (${safeText(quote.fee.feeRaw)} raw)\nMinimum received: ${safeText(quote.minimumReceived)}\n`,
  )
  if (quote.maxDebitLamports) output.write(`Maximum launch debit: ${safeText(quote.maxDebitLamports)} lamports\n`)
  if (quote.legs) output.write(`Legs, signed one at a time: ${quote.legs.map(safeText).join(", ")}\n`)
  if (quote.gas) output.write(`Gas: ${safeText(quote.gas)}\n`)
  if (quote.reserve) output.write(`Gas reserve: ${safeText(quote.reserve)}\n`)
  for (const risk of quote.tokenRisks ?? [])
    output.write(`Warning (${safeText(risk.mint)}): ${safeText(risk.message)}\n`)
  if (yes) return true
  if (!ctx.deps.isTTY.stdin)
    throw new TradingError(
      "CONFIRMATION_REQUIRED",
      "Run interactively to confirm, or use --yes for an ordinary trade prompt.",
    )
  return (await ctx.deps.promptLine("Proceed? [y/N] ")).trim().toLowerCase() === "y"
}

/** Phase 4b (D4): save a Hood leg's hash, known from its signed bytes, before the leg is posted. */
export async function saveOperationHash(
  ctx: CommandContext,
  key: string,
  id: string,
  kind: OperationKind,
  hash: string,
  operationId: string,
): Promise<void> {
  const path = operationPath(ctx, key, id)
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify({ id, kind, signature: hash, operationId }), { mode: 0o600 })
  const file = await open(temporary, "r")
  try {
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(temporary, path)
}

/** Save the payer signature before broadcast for confirmation-only recovery after a restart.
 * No transaction bytes or keys are persisted in this operation record. */
export async function saveOperationSignature(
  ctx: CommandContext,
  key: string,
  id: string,
  kind: OperationKind,
  transaction: string,
): Promise<string> {
  const bytes = Buffer.from(transaction, "base64")
  let offset = 0
  let count = 0
  for (let shift = 0; shift <= 14; shift += 7) {
    const byte = bytes[offset++]
    if (byte === undefined) throw new TradingError("INVALID_RESPONSE", "Truncated signed transaction.")
    count |= (byte & 127) << shift
    if (!(byte & 128)) break
  }
  if (!count || bytes.length < offset + count * 64 || bytes.subarray(offset, offset + 64).every((byte) => byte === 0))
    throw new TradingError("INVALID_RESPONSE", "Missing payer signature.")
  const signature = base58.encode(bytes.subarray(offset, offset + 64))
  const path = operationPath(ctx, key, id)
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify({ id, kind, signature }), { mode: 0o600 })
  const file = await open(temporary, "r")
  try {
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(temporary, path)
  return signature
}
