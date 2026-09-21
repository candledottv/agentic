/** Remote trading only: the P-256 authorization key approves a Candle-built relay request.
 * This module never opens a vault or handles a Solana private key. */
import { createHash, sign } from "node:crypto"
import { type FileHandle, mkdir, open, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { base58 } from "@scure/base"
import { z } from "zod"
import { apiRequest } from "./client"
import type { CommandContext } from "./deps"
import { resolveApiKey } from "./deps"
import { storedSignerToPem, walletSignerRef } from "./secret-store"

export class TradingError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
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
/** `GET /wallets/embedded`: the account's own launch wallets, per chain. Solana is the only one `candle swap` can pay from. */
const embeddedSchema = z
  .object({
    wallets: z
      .object({ solana: z.object({ address: z.string() }).passthrough().nullable().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough()
export const operationSchema = z.object({ job: z.object({ status: z.string() }).passthrough() }).passthrough()
export interface QuoteDisplay {
  intent?: string
  wallet?: string
  venue?: string
  priceImpactPct?: string | null
  fee: z.infer<typeof feeSchema>
  minimumReceived: string
  maxDebitLamports?: string
  tokenRisks: z.infer<typeof risksSchema>
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
      "Phase 3 supports Solana only; cross-chain pairs and EVM assets are refused. Use SOL, USDC, CNDL or a Solana mint.",
    )
  return value
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
}
type WalletRow = z.infer<typeof walletSchema>

/**
 * Every page of `/wallets/trading`, kept whole rather than filtered down to the caller's match.
 *
 * Keeping the full list is the point. The refusals below name what IS usable on this account, and
 * that answer cannot be assembled from a match that did not happen -- which is the same family of
 * problem as BE-242's truncated listing: the CLI knew and did not say.
 */
async function teeWallets(
  ctx: CommandContext,
  key: string,
  scope: string,
): Promise<{ rows: WalletRow[]; appId: string }> {
  let cursor: string | undefined
  const rows: WalletRow[] = []
  const cursors = new Set<string>()
  let appId = ""
  for (;;) {
    const response = walletPageSchema.parse(
      await request(ctx, key, `/api/v1/agent/wallets/trading${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
    )
    if (!response.scopes?.includes(scope)) throw new TradingError("SCOPE_MISSING", `The bound key needs ${scope}.`)
    appId = response.privyAppId ?? ""
    if (!Array.isArray(response.page))
      throw new TradingError("INVALID_RESPONSE", "Wallet discovery did not return a page.")
    rows.push(...response.page)
    if (response.isDone === true) break
    cursor = response.continueCursor ?? undefined
    if (!cursor || cursors.has(cursor)) throw new TradingError("INVALID_RESPONSE", "Wallet discovery did not complete.")
    cursors.add(cursor)
  }
  return { rows, appId }
}

function matchesName(row: WalletRow, name: string): boolean {
  return row.id === name || row.address === name || row.label === name
}

/** How a TEE wallet is named back to someone who has to pick one: label first, then id and address. */
function describeWallet(row: WalletRow): string {
  return `${row.label ? `${row.label} ` : ""}(${row.id}, ${row.address})`
}

function teeWalletList(rows: WalletRow[]): string {
  return rows.map(describeWallet).join("; ")
}

async function completeTradingWallet(
  ctx: CommandContext,
  row: WalletRow,
  appId: string,
  scope: string,
): Promise<TradingWallet> {
  if (!row.active || row.chain !== "solana")
    throw new TradingError("TEE_WALLET_INACTIVE", "The payer must be a verified-active Solana TEE wallet.")
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
  const { rows, appId } = await teeWallets(ctx, key, scope)
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
  | { kind: "tee"; wallet: TradingWallet }
  /** The account's own embedded (main) Solana wallet. Candle holds its delegation and signs server-side. */
  | { kind: "embedded"; address: string }

export async function tradingPayer(ctx: CommandContext, key: string, name: string | undefined): Promise<SwapPayer> {
  const scope = "swap:write"
  const { rows, appId } = await teeWallets(ctx, key, scope)
  // Read even when a name was given: it is what lets a miss say "here is what you could have
  // meant" instead of naming only half the account.
  const embedded = embeddedSchema.parse(await request(ctx, key, "/api/v1/agent/wallets/embedded")).wallets?.solana
    ?.address
  const asEmbedded = (): SwapPayer => ({ kind: "embedded", address: embedded as string })
  const options = [
    ...rows.map((row) => `TEE ${describeWallet(row)}`),
    ...(embedded ? [`embedded (${embedded})`] : []),
  ].join("; ")

  if (name === undefined) {
    if (rows.length === 1 && !embedded)
      return { kind: "tee", wallet: await completeTradingWallet(ctx, rows[0] as WalletRow, appId, scope) }
    if (rows.length === 0 && embedded) return asEmbedded()
    throw new TradingError(
      "PAYER_REQUIRED",
      options.length === 0
        ? "This account has no wallet that can pay for a swap. Enrol a TEE wallet, or create an embedded wallet in the app."
        : `Name the payer with --wallet. This account can pay from: ${options}.`,
    )
  }

  const matches = rows.filter((row) => matchesName(row, name))
  if (matches.length === 1)
    return { kind: "tee", wallet: await completeTradingWallet(ctx, matches[0] as WalletRow, appId, scope) }
  if (matches.length === 0 && embedded === name) return asEmbedded()
  throw new TradingError(
    "TEE_WALLET_REQUIRED",
    matches.length > 1
      ? `"${name}" matches ${matches.length} TEE wallets on this key: ${teeWalletList(matches)}. Name one by id or address.`
      : options.length === 0
        ? `"${name}" is not a wallet this account can pay from, and it has none: enrol a TEE wallet, or create an embedded wallet in the app.`
        : `"${name}" is not a wallet this account can pay from. It can pay from: ${options}.`,
  )
}

export function authorizationSignature(
  wallet: TradingWallet,
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
export function rpcUrl(ctx: CommandContext, flag?: string): string {
  const value = flag ?? ctx.deps.env.CANDLE_SOLANA_RPC_URL
  if (!value || !/^https?:\/\//.test(value))
    throw new TradingError(
      "RPC_REQUIRED",
      "Provide --rpc-url or CANDLE_SOLANA_RPC_URL for mint/balance reads or launch broadcast.",
    )
  return value
}
export async function rpc(ctx: CommandContext, url: string, method: string, params: unknown[]): Promise<Json> {
  const response = await ctx.deps.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const body = (await response.json()) as Json
  if (!response.ok || body.error || body.result === undefined)
    throw new TradingError("RPC_FAILED", `Solana ${method} failed; no automatic retry was sent.`)
  if (!body.result || typeof body.result !== "object" || Array.isArray(body.result))
    throw new TradingError("RPC_FAILED", "RPC returned an invalid object.")
  return body.result as Json
}
export type OperationKind = "trade" | "swap" | "launch"
export function jobPath(kind: OperationKind, id: string): string {
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

/** Save the payer signature before broadcast for confirmation-only recovery after a restart.
 * No transaction bytes or keys are persisted in this operation record. */
export async function saveLaunchSignature(
  ctx: CommandContext,
  key: string,
  id: string,
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
  await writeFile(temporary, JSON.stringify({ id, kind: "launch", signature }), { mode: 0o600 })
  const file = await open(temporary, "r")
  try {
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(temporary, path)
  return signature
}
