/**
 * Typed client for the Candle agent rail REST surface (docs/headless-launch.md and
 * docs/agent-trading.md are the authoritative endpoint references; apps/api/src/routes/{launch,
 * launch-headless,markets,verify,activity,users,uploads,agent,trade-agent,trade-agent-shared,
 * trade-agent-confirm}.ts are the implementations these types mirror).
 *
 * Design rules:
 * - Near-zero runtime dependencies: global `fetch` (injectable for tests), global `crypto` for
 *   the generated idempotency id and (via `importWallet`) for HPKE. Works on Bun and Node 18+.
 *   The SDK's only three package dependencies, `@hpke/core`, `@hpke/chacha20poly1305`, and
 *   `@scure/base` (wallet-import.ts), exist solely to serve `importWallet` below.
 * - The REST API is the authoritative validator (same stance as packages/mcp): request types
 *   describe the wire shape for autocomplete, they do not re-implement server validation.
 * - Every non-2xx response throws `CandleApiError` (see errors.ts). Methods that unwrap a
 *   payload (`getQuotePairs`, `getPresets`, `getMarket`, `getLaunchJob`, `getAgentProfile`)
 *   return the useful inner object; methods whose top-level body IS the useful object
 *   (`launch`, `dryRunLaunch`, `getQuote`, `getFeed`, `verify`) return the parsed body.
 * - `x-api-key` is attached to EVERY request when the client has a key. The write/keyed
 *   endpoints (launch, dry run, jobs, activity, uploads) refuse to fetch at all without one,
 *   throwing a plain `Error` that names the missing option, so a misconfigured agent fails
 *   fast and locally instead of with a server 401.
 * - Idempotent launch retries: `launch()` fills in `clientLaunchId` ("sdk-" + UUID) when the
 *   caller omits one and re-sends the SAME id on network errors, non-envelope 5xx responses,
 *   retryable envelopes with 5xx status, and the retryable in-flight 409. It never retries a
 *   non-retryable envelope (IDEMPOTENCY_CONFLICT with a different body, LAUNCH_DISABLED, every
 *   validation error). Backoff is 250ms * 2^n, jittered to 50-100% of that, capped at 8s,
 *   bounded by `maxRetries` (default 3 retries after the initial attempt).
 */

import { buildPrivyAuthorizationSignature } from "./authorization-signature"
import { CandleApiError, candleApiErrorFromResponse, JsonRpcError } from "./errors"
import {
  assembleEvmTx,
  decimalToHexQuantity,
  type EvmRpc,
  estimateGas,
  fetchChainId,
  fetchFeeData,
  fetchNonce,
  waitForReceipt,
} from "./evm-tx"
import type { SecretStore } from "./secret-store"
import { encryptWalletKeyForImport, type WalletChain } from "./wallet-import"

export type Chain = "solana" | "hood"
/**
 * The two shipped tiers plus their low-threshold TEST twins (~1/80 economics, same identity and
 * NFT gate; see docs/superpowers/specs/2026-08-04-test-curve-configs-design.md). Test tiers are
 * creatable only where the API's ENABLE_TEST_CURVES flag is on; the server refuses them
 * otherwise, so client code needs no gate of its own.
 */
export type LaunchTier = "open" | "exclusive" | "test-open" | "test-exclusive"
export type FeedBucket = "new" | "graduated" | "onfire" | "bluechip"

export interface CandleClientOptions {
  /** Base URL of the Candle API, e.g. "https://api.candle.tv". Trailing slashes are trimmed. */
  apiUrl: string
  /** Agent API key (cndl_live_... / cndl_test_...). Required for launch, jobs, activity, uploads. */
  apiKey?: string
  /** Injectable fetch for tests; defaults to the global. */
  fetch?: typeof fetch
  /** Max launch() retries after the initial attempt. Default 3. */
  maxRetries?: number
  /**
   * Privy's app id: a PUBLIC identifier, the same value a frontend exposes as
   * NEXT_PUBLIC_PRIVY_APP_ID, NOT a secret. Required by signLinkedTransaction() (and therefore by
   * the linked-wallet paths of trade() and selfLaunch()): the sign relay authenticates to Privy
   * under Candle's own server-side PRIVY_APP_ID, and the authorization signature this client
   * computes locally covers that exact app id, so this option must be set to the SAME app id the
   * relay uses or Privy rejects the forwarded signature as SIGNER_MISMATCH.
   */
  privyAppId?: string
  /**
   * Where an agent's own P-256 signer private-key PEM lives, keyed by linkedWalletId (see
   * secret-store.ts). Required by signLinkedTransaction() and the linked-wallet paths of trade()
   * and selfLaunch(); Candle's servers never see this key, whichever SecretStore implementation
   * holds it. That cuts both ways: if the caller loses this key, its linked wallet can no longer
   * be signed for through this SDK, by design. There is no Candle-side recovery, since Candle
   * never held a copy to recover; the only way back is revoking that linked wallet and
   * re-importing it with a new signer key (see "Self-signed launches" in docs/headless-launch.md).
   */
  secretStore?: SecretStore
  /** Solana JSON-RPC endpoint used by broadcastSignedTransaction() and the Solana linked-wallet one-shots (trade()/selfLaunch()). */
  solanaRpcUrl?: string
  /**
   * EVM JSON-RPC endpoint used by broadcastSignedTransaction() and the Hood linked-wallet
   * one-shots (trade()/selfLaunch()): fetching chain id, nonce, and fee data, and estimating gas
   * for each leg (via packages/sdk/src/evm-tx.ts's helpers) all read from this endpoint. Required
   * for a Hood linked payer; trade()/selfLaunch() throw a clear error naming this option when it
   * is unset, before any signing.
   */
  evmRpcUrl?: string
}

// ---------------------------------------------------------------------------
// Wire types (mirroring docs/headless-launch.md; kept local so the SDK stays
// dependency-free rather than importing @candle/shared)
// ---------------------------------------------------------------------------

/** The bonding-curve terms of one (chain, quote asset, tier) cell. */
export interface CurveTerms {
  symbol: string
  /** Migration threshold in the quote asset's smallest unit, as a decimal string. */
  thresholdRaw: string
  raise: number
  startFdv: number
  bondingFdv: number
  supplySoldPct: number
}

/** One quote asset a launch can be denominated in, with its per-tier terms. */
export interface QuotePair {
  chain: Chain
  /** Stable lowercase id; what a launch request sends as `quoteAsset`. */
  id: string
  symbol: string
  address: string
  decimals: number
  isNative: boolean
  /** Web-launcher dev-buy flag; agents should read `headlessDevBuy` instead once present. */
  supportsDevBuy: boolean
  /** Whether a headless launch can bundle a dev buy in this asset (ships in Phase 2 wave 3). */
  headlessDevBuy?: boolean
  tiers: Partial<Record<LaunchTier, CurveTerms>>
}

/** GET /api/v1/launch/quote-pairs, unwrapped from its `payload` envelope. */
export interface QuotePairsPayload {
  matrixVersion: number
  pairs: Partial<Record<Chain, QuotePair[]>>
  /** What each chain gets when a launch names no quote asset. */
  defaults: Partial<Record<Chain, string>>
}

/** One first-party preset, joined with the live tier terms. */
export interface LaunchPreset {
  name: string
  description: string
  chain: Chain
  quoteAsset: string
  mode: LaunchTier
  dexVersion?: "v3" | "v4"
  stakerAllocationBps: number
  terms: CurveTerms
}

/** GET /api/v1/launch/presets, unwrapped from its `payload` envelope. */
export interface PresetsPayload {
  matrixVersion: number
  presets: LaunchPreset[]
}

/** POST /api/v1/launch/headless request body. The server is the authoritative validator. */
export interface LaunchRequest {
  /** Idempotency key, unique per account. launch() generates "sdk-" + UUID when absent. */
  clientLaunchId?: string
  chain?: Chain
  quoteAsset?: string
  mode?: LaunchTier
  stakerAllocationBps?: number
  /** Hood only, required there: which Uniswap version the curve graduates through. */
  dexVersion?: "v3" | "v4"
  /** Initial dev buy. Solana: JSON number in the pair's base units. Hood: decimal string in wei. */
  buyAmount?: number | string
  name: string
  symbol: string
  /** Roughly SQUARE (at most 1.5:1): this is the avatar. Wider is rejected as IMAGE_WRONG_SHAPE. */
  imageUrl: string
  /**
   * Optional WIDE artwork (wider than 1.5:1, e.g. 1200x630) for the token page's banner strip.
   * Where a share card or OG image belongs; a square image here is rejected as
   * BANNER_WRONG_SHAPE. Omitted, the strip falls back to `imageUrl`.
   */
  bannerUrl?: string
  description?: string
  socials?: { twitter?: string; telegram?: string; website?: string; discord?: string }
  /*
    No streamerAddress. Who earns a token's streamer share is decided by the platform from
    whoever is live when the launch is submitted, not named by the caller. Sending the field is a
    type error rather than a value the API quietly drops.
  */
  visibility?: "production" | "test" | "local" | "hidden"
}

/** POST /api/v1/launch/self/build request body. Extends LaunchRequest with linkedWalletId. */
export interface BuildSelfLaunchRequest extends LaunchRequest {
  linkedWalletId: string
}

/** POST /api/v1/launch/self/build response for Solana (unsigned transaction). */
export interface BuildSelfLaunchSolanaResult {
  success: true
  transaction: string
  mint: string
  pool: string
  clientLaunchId: string
  expiresAt: number
}

/** POST /api/v1/launch/self/build response for Hood (calldata). */
export interface BuildSelfLaunchHoodResult {
  success: true
  transaction: { to: string; data: string }
  curveAddress: string
  clientLaunchId: string
  expiresAt: number
  /** The linked payer's own checksummed EVM address: the transaction `from`, and the nonce query subject. */
  walletAddress: string
  /** Present only when a platform fee applies; the companion transfer to send AFTER the createCurve tx. */
  feeTransfer?: { to: string; data: string; value: string }
  /** Present only when a platform fee applies; itemizes what feeTransfer above actually moves. */
  fee?: TradeFee
}

/** POST /api/v1/launch/self/build response. */
export type BuildSelfLaunchResult = BuildSelfLaunchSolanaResult | BuildSelfLaunchHoodResult

/** POST /api/v1/launch/self/confirm request body. */
export interface ConfirmSelfLaunchRequest {
  clientLaunchId: string
  signature: string
  devBuySignature?: string
  /** Hood only: the fee-transfer leg's own transaction hash, required whenever the build carried a `feeTransfer` leg. */
  feeTxHash?: string
}

/** POST /api/v1/launch/self/confirm response. Mirrors LaunchResult. */
export interface ConfirmSelfLaunchResult extends LaunchResult {
  // Same shape as LaunchResult returned from successResponse
}

/** POST /api/v1/launch/headless/dry-run response. */
export interface DryRunResult {
  success: true
  dryRun: true
  resolved: {
    chain: Chain
    quoteAsset: string
    mode: LaunchTier
    stakerAllocationBps: number
    dexVersion: "v3" | "v4" | null
    visibility: string
    buyAmount: string
  }
  checks: { image: string; exclusiveEligible: boolean }
  matrixVersion: number
}

/** POST /api/v1/launch/headless blocking (or replayed) success response. */
export interface LaunchResult {
  success: true
  chain: Chain
  mint: string
  pool: string | null
  signature: string
  quoteAsset: string
  mode: LaunchTier
  stakerAllocationBps: number
  matrixVersion: number
  links: { candle: string; explorer?: string }
  nextBuy: { market: string; quoteAsset: string; marketStateUrl: string }
  devBuy?: { signature: string }
}

/** The 202 body of an `async: true` launch. */
export interface AcceptedJob {
  success: true
  accepted: true
  clientLaunchId: string
  status: "submitted"
  jobUrl: string
}

/** One idempotency-ledger attempt, from GET /api/v1/launch/headless/jobs/:clientLaunchId. */
export interface LaunchJob {
  clientLaunchId: string
  chain: Chain
  status: "submitted" | "confirming" | "confirmed" | "failed"
  mint?: string
  pool?: string
  signature?: string
  devBuy?: { signature: string }
  errorCode?: string
  createdAt: number
  updatedAt: number
}

export interface MigrationStatus {
  status: "not_started" | "in_progress" | "completed" | "delayed"
  migratedAt?: number
  attempts?: number
  nextAttemptAt?: number
  gaveUpAt?: number
}

/** GET /api/v1/markets/:chain/:mint, unwrapped from `{ success, market }`. */
export interface MarketState {
  chain: Chain
  mint: string
  lifecycle: "trading" | "completed" | "migrated" | "recovery"
  buysOpen: boolean
  sellsOpen: boolean
  curveAddress: string | null
  poolAddress: string | null
  quoteMint: string | null
  feeBps: number
  graduationVenue: string
  tier: string | null
  crossingModel: "full-fill-surplus" | "capped-refund"
  migration: MigrationStatus
}

/** All amounts are decimal strings in the relevant asset's smallest unit. */
export interface QuoteBreakdown {
  amountOut: string
  fee: string
  minAmountOut: string
  /** Buys only: whether this buy crosses the graduation threshold. */
  crossesGraduation?: boolean
  /** Hood crossing buys only: quote refunded past the capped fill. */
  refund?: string
  /** Hood crossing buys only: quote actually consumed (amountIn minus refund). */
  quoteConsumed?: string
}

/** GET /api/v1/markets/:chain/:mint/quote response. */
export interface QuoteResult {
  success: true
  chain: Chain
  mint: string
  side: "buy" | "sell"
  amountIn: string
  crossingModel: "full-fill-surplus" | "capped-refund"
  quote: QuoteBreakdown
}

/** One feed row. The stats columns vary by bucket, hence the open index signature. */
export interface FeedToken {
  chain: Chain
  address?: string
  name?: string
  symbol?: string
  image?: string
  /** True for a Candle-origin launch created via an agent key. */
  isAgent?: boolean
  [key: string]: unknown
}

/** GET /api/v1/markets/feed response. */
export interface FeedResult {
  success: true
  bucket: FeedBucket
  tokens: FeedToken[]
}

/** GET /api/v1/verify/:chain/:mint. Branch on `candleLaunched`; unknown mints are not 404s. */
export type VerifyResult =
  | { success: true; candleLaunched: false; chain: Chain; mint: string }
  | {
      success: true
      candleLaunched: true
      chain: Chain
      mint: string
      tier: string | null
      quoteMint: string | null
      graduated: boolean
      pool: string | null
      createdAt: number
      creator: string | null
      viaAgentKey: boolean
      /** Hood only: curve/factory/configHash/dexVersion, re-verifiable against the registry. */
      provenance?: Record<string, string>
      /** Solana only: the program and attribution signer indexers re-verify against. */
      attribution?: { program: string; signer?: string }
    }

/** GET /api/v1/users/:idOrWallet/agent, unwrapped from `{ success, agent }`. */
export interface AgentProfile {
  enabled: boolean
  address: string
  username: string | null
  launches: number
  launchesViaApi: number
}

/**
 * GET /api/v1/agent/tier response, returned whole (same convention as `verify()`: the top-level
 * body IS the useful object, no envelope to unwrap). Dual auth: an agent key works here, and so
 * does a Privy session cookie, which is how the `/dev/agent` dashboard's tier strip fetches this
 * same endpoint directly rather than through this SDK. `feeTotals[].feeRawSum` is a raw-unit
 * BigInt string (lamports, wei, etc.); never coerce it with `Number()`.
 */
export interface AgentTierInfo {
  success: true
  /** Display tier: max > pro > believer > free. */
  tier: "free" | "believer" | "pro" | "max"
  /** Live-evaluated tier, independent of the Believer key-issuance label. */
  liveTier: "free" | "pro" | "max"
  stakedCndl: number
  heldCndl: number
  thresholds: { minStakedCndl: number; minHeldCndl: number; graceMs: number }
  /** `startedAt` is null unless `active` (see the endpoint's own doc for why). */
  grace: { active: boolean; startedAt: number | null }
  maxTierExpiresAt: number | null
  /** The account's resolved platform fee, in bps, on API-built value-moving transactions. */
  feeBps: number
  feeTotals: Array<{ chain: Chain; quoteAsset: string; feeRawSum: string; count: number }>
}

/**
 * One per-transaction spend cap, mirroring `SpendLimit` in `apps/api/src/lib/agent-policy.ts`
 * and what `PUT /api/v1/agent/keys/{prefix}/limits` reads and writes (per-key only, 2026-08-23:
 * the account-wide limits are retired). `asset` is `"sol" | "usdc" | "cndl"` on Solana or `"eth" | "usdg"` on Hood/EVM; `maxPerTxRaw` is
 * a positive base-10 integer string of the asset's raw base-unit amount (same raw-string
 * convention as `CurveTerms.thresholdRaw` above). Defined locally, not imported from
 * `@candle/shared`, per this file's near-zero-dependency design rule.
 */
export interface SpendLimit {
  asset: string
  maxPerTxRaw: string
}

/**
 * `GET /api/v1/agent/keys/self/limits` response (roadmap C, Task 5): the CALLING key's own
 * spend-limit configuration, exactly as the server-side gate resolves it
 * (`apps/api/src/lib/spend-limit-gate.ts`'s `checkSpendAgainstLimits`). Per-key only
 * (2026-08-23): `keyLimits` is the whole answer -- an asset the key does not mention is
 * uncapped, with no account fallback. Resolve a cap as
 * `keyLimits?.find((l) => l.asset === asset)?.maxPerTxRaw` (undefined means unlimited).
 */
export interface SpendLimitsResult {
  success: true
  keyLimits: SpendLimit[] | null
}

/** POST /api/v1/agent/wallets/import/submit response: the linked-wallet row summary. */
export interface ImportWalletResult {
  success: true
  id: string
  address: string
  chain: WalletChain
  privyWalletId: string
}

/**
 * One row of `GET /api/v1/agent/wallets`'s `page` array: the linkedWallets Convex row minus
 * internal bookkeeping fields (userAddress/addressLower/privyWalletId/verifiedAt) a caller has
 * no use for. `privyPolicyId` present is what makes a row spend-capable (the import flow); its
 * absence means attribution-only (link-existing). `revokedAt` set means the row is a
 * tombstone -- `listWallets()` excludes these by default; pass `includeRevoked: true` to see
 * them.
 */
export interface LinkedWalletRow {
  _id: string
  chain: WalletChain
  address: string
  label?: string
  privyPolicyId?: string
  signerQuorumId?: string
  revokedAt?: number
  addedVia: "agent" | "session"
}

/** GET /api/v1/agent/wallets response: one page of the account's linked wallets. */
export interface ListWalletsResult {
  success: true
  page: LinkedWalletRow[]
  isDone: boolean
  continueCursor: string | null
}

// ---------------------------------------------------------------------------
// Agent trade API (docs/agent-trading.md): POST /api/v1/trade/agent/{build,confirm}
// ---------------------------------------------------------------------------

export type TradeSide = "buy" | "sell"

/** Who pays for a trade: the account's own delegated wallet ("main"), or an imported linked wallet. */
export type TradePayer = { type: "main" } | { type: "linked"; linkedWalletId: string }

/** POST /api/v1/trade/agent/build request body. */
export interface BuildTradeRequest {
  /** Idempotency key, unique per account; shared with the matching confirmTrade() call. */
  clientTradeId: string
  mint: string
  side: TradeSide
  /** Buy: quote-asset raw units to spend. Sell: base-token raw units to sell. */
  amountRaw: string
  payer: TradePayer
  /** Bps, 0-10000. Server defaults to 100 (1%) when omitted. */
  maxSlippageBps?: number
  /**
   * Which asset to quote this trade in. Applies only when trading a non-Candle-launched token
   * (Pro/Max); ignored for a Candle token, whose curve/pool quote asset is fixed. The server
   * defaults it when omitted.
   */
  quoteAsset?: "sol" | "usdc" | "cndl"
}

/** The platform fee actually itemized on this trade. `treasury` is null only when the fee is disabled server-side (unset AGENT_FEE_TREASURY_*). */
export interface TradeFee {
  bps: number
  feeRaw: string
  treasury: string | null
}

/** Solana "built" artifacts: one unsigned transaction, the fee (if any) already embedded inside it. */
export interface SolanaTradeArtifacts {
  venue: "curve" | "jupiter"
  transactionBase64: string
  quoteAsset: string
  quoteMint: string
  quoteDecimals: number
}

/**
 * Hood "built" artifacts: up to three calldata legs. Send order matters and is fixed: `approval`
 * (present only when the payer's existing ERC-20 allowance is insufficient), then `trade`, then
 * `feeTransfer` (present only when a fee applies). Hood cannot batch calls the way one Solana
 * transaction can carry multiple instructions, so each leg is its own transaction.
 */
export interface HoodTradeArtifacts {
  venue: "curve"
  trade: { to: string; data: string; value: string }
  approval?: { to: string; data: string }
  feeTransfer?: { to: string; data: string; value: string }
  quoteAsset: string
  quoteDecimals: number
}

/**
 * POST /api/v1/trade/agent/build response for a LINKED payer: an unsigned artifact for the agent
 * to sign and broadcast itself, then report to confirmTrade(). `chain` discriminates `artifacts`.
 */
export type BuildTradeBuiltResult =
  | {
      success: true
      status: "built"
      clientTradeId: string
      chain: "solana"
      artifacts: SolanaTradeArtifacts
      fee: TradeFee
      expectedOutRaw: string
      minOutRaw: string
      expiresAt: number
    }
  | {
      success: true
      status: "built"
      clientTradeId: string
      chain: "hood"
      artifacts: HoodTradeArtifacts
      fee: TradeFee
      expectedOutRaw: string
      minOutRaw: string
      expiresAt: number
      /** The linked payer's own checksummed EVM address: the transaction `from`, and the nonce query subject. */
      walletAddress: string
    }

/**
 * A trade that has already run: a MAIN payer's inline execution (buildTrade()'s own response, no
 * confirmTrade() call needed at all) or a linked payer's verified confirmTrade() result (including
 * an idempotent replay of a trade already confirmed). `signature` is a Solana transaction
 * signature or a Hood transaction hash, matching `chain`.
 */
export interface ExecutedTradeResult {
  success: true
  status: "executed"
  clientTradeId: string
  chain: Chain
  signature: string
  /**
   * The fee-bearing signature, when tracked separately from `signature`. Solana: absent for a
   * main payer (the fee rides inside the same transaction `signature` already covers); always
   * equal to `signature` for a confirmed linked payer (confirmTrade() claims the broadcast
   * signature itself as its anti-reuse guard, fee or not). Hood: the fee transfer's own tx hash,
   * present only when a fee actually landed.
   */
  feeSignature?: string
  fee: TradeFee
  amounts: { amountRaw: string; expectedOutRaw: string; minOutRaw: string; quoteAsset: string }
}

/** POST /api/v1/trade/agent/build response: "built" for a linked payer, "executed" for a main payer (or an idempotent replay of an already-confirmed trade under the same clientTradeId). */
export type BuildTradeResult = BuildTradeBuiltResult | ExecutedTradeResult

/**
 * POST /api/v1/trade/agent/confirm request body. Solana reports its transaction signature; Hood
 * reports its trade transaction hash and, ONLY when the matching build's `fee.feeRaw` was
 * non-zero, the fee transfer's own transaction hash (omitting it there is refused
 * `FEE_LEG_MISSING`).
 */
export type ConfirmTradeRequest =
  | { clientTradeId: string; signature: string }
  | { clientTradeId: string; tradeTxHash: string; feeTxHash?: string }

/** POST /api/v1/trade/agent/confirm response. Always "executed": confirm only ever verifies and records a trade that already happened on-chain. */
export type ConfirmTradeResult = ExecutedTradeResult

/**
 * POST /api/v1/trade/agent/submit request body. `signedTransactions` is the ordered signed legs:
 * one for Solana; one to three for Hood in the fixed approval, trade, feeTransfer order (omitting
 * a leg that was not built). The server broadcasts them itself and confirms inline, so there is no
 * separate confirmTrade() call after this one.
 */
export interface SubmitTradeRequest {
  clientTradeId: string
  signedTransactions: string[]
}

// ---------------------------------------------------------------------------
// Linked-wallet signing relay + one-shot flows (Agent Pilot Phase 3, Task 4)
// ---------------------------------------------------------------------------

/**
 * The exact fields Privy's `eth_signTransaction` RPC expects under `params.transaction`. The
 * caller assembles these (nonce via eth_getTransactionCount, fee fields via
 * eth_maxPriorityFeePerGas/the latest block's base fee, gas_limit via eth_estimateGas, chain_id
 * via eth_chainId) -- signLinkedTransaction() only forwards them, it does not fetch or compute
 * any of them itself.
 */
export interface EvmSignTransactionParams {
  from: string
  to: string
  nonce: number
  chain_id: number
  data: string
  value: string
  type: number
  gas_limit: string
  max_fee_per_gas: string
  max_priority_fee_per_gas: string
}

/** `swapFromLinked()` request: SOL on the linked wallet into ETH/USDG on Hood. */
export interface LinkedSwapRequest {
  from: "SOL"
  to: "ETH" | "USDG"
  /** Lamports, as a decimal string. */
  amountRaw: string
  /** The linked Solana wallet funding the swap. */
  payer: { linkedWalletId: string; privyWalletId: string }
  /** The account's OWN linked EVM wallet to receive the output; omitted = the owner's embedded Hood wallet. */
  toWalletId?: string
  maxSlippageBps?: number
}

/** `swapFromLinked()` result. `hashes` is the Solana deposit; poll `statusChecks` for the fill. */
export interface LinkedSwapResult {
  hashes: string[]
  expectedOutRaw: string
  outDecimals: number
  statusChecks: string[]
  recipient: string
}

export interface SignLinkedTransactionParams {
  /** The linked wallet's row id: keys the secretStore lookup AND is the relay's :id path segment. */
  linkedWalletId: string
  /** The SAME wallet's Privy wallet id (from importWallet()'s result), the authorization signature's URL target. */
  privyWalletId: string
  chain: WalletChain
  /** Solana only: the unsigned transaction to sign, base64-encoded. */
  unsignedTransactionBase64?: string
  /** EVM only: the fully-assembled transaction to sign. */
  evmTxParams?: EvmSignTransactionParams
}

export interface SignLinkedTransactionResult {
  /** Base64-encoded (Solana) or RLP-encoded (EVM), per `encoding`. */
  signedTransaction: string
  encoding: string
}

/**
 * The base assets `swap()` converts between. Inlined rather than imported from `@candle/shared`'s
 * `BaseAssetKey`, for the same reason `packages/mcp` inlines its curve constants: this SDK is
 * published standalone and must not depend on a monorepo-internal package.
 *
 * SOL, USDC and CNDL are Solana-side; ETH and USDG are Hood-side. A pair that spans the two sides
 * is a cross-chain swap and settles as more than one transaction.
 */
export type BaseAssetKey = "SOL" | "USDC" | "CNDL" | "ETH" | "USDG"

/** swap()'s request body: `POST /api/v1/agent/swap`. */
export interface SwapRequest {
  from: BaseAssetKey
  /** Must differ from `from`; the API rejects a same-asset pair. */
  to: BaseAssetKey
  /** Raw base units of `from` to spend, as a positive integer string. */
  amountRaw: string
  /** Bps, 0-10000. Server defaults to 100 (1%) when omitted. */
  maxSlippageBps?: number
  /** Optional in-flight dedup key. See swap()'s jsdoc for what it does and does not guarantee. */
  clientSwapId?: string
}

/** swap()'s unwrapped `payload`. */
export interface SwapResult {
  /** One hash per executed leg, in execution order. A cross-chain swap reports more than one. */
  hashes: string[]
  expectedOutRaw: string
  outDecimals: number
  venueCostUsd?: number
  /** URLs to poll a cross-chain fill's status, so a caller need not re-derive them from a quote. */
  statusChecks: string[]
}

/** trade()'s one-call request: mirrors BuildTradeRequest minus clientTradeId/payer, plus who signs. */
export interface TradeRequest {
  mint: string
  side: TradeSide
  /** Buy: quote-asset raw units to spend. Sell: base-token raw units to sell. */
  amountRaw: string
  /** "main": the account's own delegated wallet, executed inline. A linked wallet: signed and broadcast by the caller via the sign relay. */
  from: "main" | { linkedWalletId: string; privyWalletId: string }
  /** Bps, 0-10000. Server defaults to 100 (1%) when omitted. */
  maxSlippageBps?: number
  /**
   * Which asset to quote this trade in. Applies only when trading a non-Candle-launched token
   * (Pro/Max); ignored for a Candle token, whose curve/pool quote asset is fixed. The server
   * defaults it when omitted.
   */
  quoteAsset?: "sol" | "usdc" | "cndl"
  /** Idempotency key shared by the build and confirm calls; generated ("sdk-" + UUID) when omitted. */
  clientTradeId?: string
}

/** selfLaunch()'s one-call request: BuildSelfLaunchRequest plus the linked wallet's Privy wallet id. */
export type SelfLaunchRequest = BuildSelfLaunchRequest & {
  /** The linked wallet's Privy wallet id (from importWallet()'s result). */
  privyWalletId: string
}

// ---------------------------------------------------------------------------
// Atomic launch (a Solana launch plus 1-4 first buys, landed as one Jito bundle). See "Atomic
// launch with first buys" in docs/headless-launch.md for the full model; this section mirrors
// apps/api/src/routes/launch-atomic.ts's request/response shapes exactly.
// ---------------------------------------------------------------------------

/** Who pays for one leg of an atomic bundle (the launch, or one first buy): the account's own delegated wallet ("main"), or an imported linked wallet. Mirrors TradePayer. */
export type AtomicLaunchPayer = { type: "main" } | { type: "linked"; linkedWalletId: string }

/** One first-buy leg of an atomic launch request. */
export interface AtomicFirstBuyRequest {
  payer: AtomicLaunchPayer
  /** Quote-asset raw units this leg spends. */
  amountRaw: string
}

/**
 * POST /api/v1/launch/atomic/build request body: LaunchRequest without `buyAmount` (atomic
 * launches never bundle a dev buy into the launch transaction itself -- give the creator a first
 * buy via `firstBuys` instead, so it lands as bundle leg 1 against a still-virgin curve) plus the
 * creator's own payer and 1-4 first-buy legs.
 */
export interface BuildAtomicLaunchRequest extends Omit<LaunchRequest, "buyAmount"> {
  payer: AtomicLaunchPayer
  /** 1 to 4 buy legs, sharing the launch transaction's own recent blockhash and landing atomically with it (Jito's 5-transaction bundle cap: 1 launch + up to 4 buys). */
  firstBuys: AtomicFirstBuyRequest[]
}

export type AtomicBundleLegRole = "launch" | "buy"
export type AtomicBundleLegSigner = "server" | "client"

/**
 * One leg of a built atomic bundle, in bundle order (index 0 is always the launch; 1..N are the
 * first buys, in request order). `unsignedTxBase64` is present only for a "client" signer leg (a
 * "server" leg -- a "main" payer -- is signed by Candle itself at submit time and never leaves the
 * server). `expectedFill` is present only on a "buy" leg the pricing ladder could compute: it is
 * an ADVISORY fill, not a slippage guarantee -- every buy leg's own on-chain `minAmountOut` is
 * always "0" inside the bundle (see "Atomic launch with first buys" in docs/headless-launch.md for
 * why that is safe here and what `expectedFill` is for instead).
 */
export interface AtomicBundleResponseLeg {
  index: number
  role: AtomicBundleLegRole
  signer: AtomicBundleLegSigner
  unsignedTxBase64?: string
  expectedFill?: { amountOutRaw: string }
}

/** POST /api/v1/launch/atomic/build response. */
export interface BuildAtomicLaunchResult {
  bundleId: string
  legs: AtomicBundleResponseLeg[]
  expiresAt: number
}

/**
 * POST /api/v1/launch/atomic/submit request body: EXACTLY the client-signer legs
 * `BuildAtomicLaunchResult.legs` named (`signer: "client"`), in leg order -- omit every "server"
 * leg entirely, never pad the array.
 */
export interface SubmitAtomicLaunchRequest {
  bundleId: string
  signedTxsBase64: string[]
}

/**
 * POST /api/v1/launch/atomic/submit response. `"landed"` is the 200 body; `"failed"`/`"timeout"`
 * are the 502 body -- all three are NORMAL, expected outcomes of submitting a Jito bundle that
 * this route documents as part of its own response surface, so `submitAtomicLaunch()`/
 * `launchAtomic()` return them here rather than throwing `CandleApiError` (every OTHER non-2xx
 * status still throws, same as every other method). `retryable` is always `false` for `"failed"`;
 * for `"timeout"` it is `true` only when the bundle's shared blockhash was proven to have expired
 * with no confirmation -- `false` means the resolution window simply ran out with no definitive
 * answer and the bundle MIGHT STILL LAND, so the caller should wait rather than immediately
 * rebuild under a fresh `clientLaunchId`. In every case, `bundleId` itself is dead once this
 * response arrives: it is consumed on the first `/submit` call regardless of outcome, so recovery
 * is always a fresh `buildAtomicLaunch()`/`launchAtomic()` call, never a retried `submit` with the
 * same id. See "Atomic launch with first buys" in docs/headless-launch.md for the full model.
 */
export type SubmitAtomicLaunchResult =
  | { status: "landed"; bundleId: string; mint: string; signatures: string[] }
  | { status: "failed"; bundleId: string; retryable: false }
  | { status: "timeout"; bundleId: string; retryable: boolean }

/** Who pays for one leg of launchAtomic()'s one-call request. Mirrors AtomicLaunchPayer, but a "linked" payer also carries the privyWalletId signLinkedTransaction() needs to sign that leg -- mirrors TradeRequest's `from` field. */
export type LaunchAtomicPayer = { type: "main" } | { type: "linked"; linkedWalletId: string; privyWalletId: string }

export interface LaunchAtomicFirstBuyRequest {
  payer: LaunchAtomicPayer
  amountRaw: string
}

/** launchAtomic()'s one-call request: BuildAtomicLaunchRequest's fields, but `payer`/`firstBuys[].payer` use LaunchAtomicPayer (carrying privyWalletId for any linked leg). */
export type LaunchAtomicRequest = Omit<BuildAtomicLaunchRequest, "payer" | "firstBuys"> & {
  payer: LaunchAtomicPayer
  firstBuys: LaunchAtomicFirstBuyRequest[]
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

const BACKOFF_BASE_MS = 250
const BACKOFF_CAP_MS = 8_000

/** Jittered exponential backoff: 50-100% of min(250ms * 2^retry, 8s). */
function retryDelayMs(retry: number): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** retry, BACKOFF_CAP_MS)
  return base / 2 + Math.random() * (base / 2)
}

/**
 * Whether launch() may re-send the same clientLaunchId after this failure.
 * - Anything that is not a CandleApiError is a transport failure (fetch threw, body did not
 *   parse): retry, the idempotency ledger makes the re-send safe.
 * - A non-envelope HTTP error (code "HTTP_<status>") retries only on 5xx.
 * - An envelope retries only when the server says `retryable: true` AND the status is a 5xx or
 *   the in-flight 409; a retryable 429 (rate limit, daily cap) is the caller's decision, not a
 *   tight-loop retry.
 */
function isRetryableLaunchFailure(error: unknown): boolean {
  if (!(error instanceof CandleApiError)) return true
  if (error.code.startsWith("HTTP_")) return error.status >= 500
  if (!error.retryable) return false
  return error.status >= 500 || error.status === 409
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Blockhash-expiry retry (Solana linked one-shots only)
// ---------------------------------------------------------------------------

/**
 * How many times `trade({ from: <linked> })` and `selfLaunch()`'s SOLANA branches will rebuild
 * (fresh blockhash) and retry a broadcast that failed on an expired blockhash, on top of the
 * first attempt -- so 3 broadcast attempts total. Hood/EVM one-shots use nonces, not blockhashes,
 * so this constant does not apply there.
 */
const MAX_BLOCKHASH_REBUILDS = 2

/**
 * Whether `error` signals a Solana blockhash that expired between build and broadcast (the trade
 * or launch itself was valid; only the transaction's blockhash aged out before it landed). Scoped
 * to `JsonRpcError` ONLY -- a plain `Error` (e.g. `CandleApiError` from `confirmTrade()`/
 * `confirmSelfLaunch()`, or any other non-RPC failure) can never trigger a rebuild, no matter what
 * its message says. True when either: `.data.err` is the bare string `"BlockhashNotFound"` (the
 * shape a Solana `sendTransaction` simulation failure reports it in -- a near-miss shape like
 * `data.err` being an OBJECT, e.g. `{ InstructionError: [...] }`, is a different on-chain failure
 * and must NOT match), or the `JsonRpcError`'s own message matches
 * `/blockhash not found|block height exceeded/i` (covers RPC providers that surface the same
 * condition as a plain message instead of structured `data`).
 */
function isBlockhashExpiry(error: unknown): error is JsonRpcError {
  if (!(error instanceof JsonRpcError)) return false
  const data = error.data
  if (
    typeof data === "object" &&
    data !== null &&
    "err" in data &&
    (data as { err: unknown }).err === "BlockhashNotFound"
  ) {
    return true
  }
  return /blockhash not found|block height exceeded/i.test(error.message)
}

/**
 * Wraps a blockhash-expiry JsonRpcError that survived every rebuild with a hint naming the usual
 * root cause (a lagging or rate-limited Solana RPC) and the fix (a fast endpoint such as Helius).
 * Preserves the original `code` and `data` so programmatic callers still see the structured cause.
 * Only ever called on an isBlockhashExpiry() error, which is always a JsonRpcError.
 */
function withRpcLagHint(error: JsonRpcError): JsonRpcError {
  return new JsonRpcError({
    code: error.code,
    message:
      `${error.message} -- this transaction was rebuilt with a fresh blockhash ${MAX_BLOCKHASH_REBUILDS} times ` +
      "and still failed at broadcast, which usually means the configured Solana RPC is lagging or " +
      "rate-limited. Point solanaRpcUrl at a fast endpoint (for example Helius).",
    data: error.data,
  })
}

/**
 * Builds the message for a JSON-RPC `error` envelope, inlining the underlying Solana cause
 * (`data.err` and the first few `logs`) so a bare `-32002` is self-explaining without the caller
 * having to inspect `.data`. The original RPC `message` is preserved verbatim (so
 * isBlockhashExpiry's message regex still matches the provider's own phrasing), and the structured
 * `data` is still attached to the thrown JsonRpcError unchanged. Logs are capped at the first
 * three so a large simulation log cannot bloat the message.
 */
function formatJsonRpcErrorMessage(
  method: string,
  url: string,
  rpcError: { code: number; message: string; data?: unknown },
): string {
  const base = `JSON-RPC ${method} against ${url} was rejected (code ${rpcError.code}): ${rpcError.message}`
  const data = rpcError.data
  if (typeof data !== "object" || data === null) return base
  const d = data as { err?: unknown; logs?: unknown }
  const parts: string[] = []
  if (d.err !== undefined) {
    parts.push(`err: ${typeof d.err === "string" ? d.err : JSON.stringify(d.err)}`)
  }
  if (Array.isArray(d.logs) && d.logs.length > 0) {
    parts.push(`logs: ${d.logs.slice(0, 3).join(" | ")}`)
  }
  return parts.length > 0 ? `${base} [${parts.join("; ")}]` : base
}

// ---------------------------------------------------------------------------
// Atomic launch plumbing
// ---------------------------------------------------------------------------

/** Strips a LaunchAtomicPayer down to the wire shape (no privyWalletId -- the server never needs it, only launchAtomic()'s own local signing step does). */
function toAtomicWirePayer(payer: LaunchAtomicPayer): AtomicLaunchPayer {
  return payer.type === "main" ? { type: "main" } : { type: "linked", linkedWalletId: payer.linkedWalletId }
}

/**
 * Whether `value` is a SubmitAtomicLaunchResult ("landed"/"failed"/"timeout" with a `bundleId`).
 * Used to parse POST /launch/atomic/submit's response BEFORE deciding whether to throw: the
 * "failed"/"timeout" 502 body is not a Candle error envelope (no `success` field), so routing it
 * through parseResponse()/candleApiErrorFromResponse() would flatten it into an opaque `HTTP_502`
 * CandleApiError and lose `status`/`retryable` -- this lets submitAtomicLaunch() recognize and
 * return that shape directly instead.
 *
 * Checks every field the discriminated union actually declares, not just `status`/`bundleId`: a
 * `"failed"`/`"timeout"` body must carry a boolean `retryable`, and a `"landed"` body must carry a
 * string `mint` and a `signatures` array of strings. A body that satisfies only the loose
 * status/bundleId check (e.g. a `"landed"` reply missing `signatures`, or a `"timeout"` reply with
 * `retryable: "yes"`) is REJECTED here -- it falls through to submitAtomicLaunch()'s own
 * genuine-non-2xx/unexpected-200 handling instead of being silently trusted and returned as a
 * fully-typed result the caller cannot actually rely on.
 */
function isAtomicSubmitOutcome(value: unknown): value is SubmitAtomicLaunchResult {
  if (typeof value !== "object" || value === null) return false
  const v = value as {
    status?: unknown
    bundleId?: unknown
    retryable?: unknown
    mint?: unknown
    signatures?: unknown
  }
  if (typeof v.bundleId !== "string") return false
  if (v.status === "failed" || v.status === "timeout") return typeof v.retryable === "boolean"
  if (v.status === "landed") {
    return typeof v.mint === "string" && Array.isArray(v.signatures) && v.signatures.every((s) => typeof s === "string")
  }
  return false
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_POLL_MS = 2_000
const DEFAULT_WAIT_TIMEOUT_MS = 180_000

export class CandleClient {
  private readonly apiUrl: string
  private readonly apiKey?: string
  private readonly fetchImpl: typeof fetch
  private readonly maxRetries: number
  private readonly privyAppId?: string
  private readonly secretStore?: SecretStore
  private readonly solanaRpcUrl?: string
  private readonly evmRpcUrl?: string

  constructor(opts: CandleClientOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "")
    if (opts.apiKey !== undefined) this.apiKey = opts.apiKey
    this.fetchImpl = opts.fetch ?? fetch
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
    if (opts.privyAppId !== undefined) this.privyAppId = opts.privyAppId
    if (opts.secretStore !== undefined) this.secretStore = opts.secretStore
    if (opts.solanaRpcUrl !== undefined) this.solanaRpcUrl = opts.solanaRpcUrl
    if (opts.evmRpcUrl !== undefined) this.evmRpcUrl = opts.evmRpcUrl
  }

  // -- reads ----------------------------------------------------------------

  async getQuotePairs(chain?: Chain): Promise<QuotePairsPayload> {
    const query = chain ? `?chain=${chain}` : ""
    const body = await this.requestJson<{ payload: QuotePairsPayload }>("GET", `/api/v1/launch/quote-pairs${query}`)
    return body.payload
  }

  async getPresets(): Promise<PresetsPayload> {
    const body = await this.requestJson<{ payload: PresetsPayload }>("GET", "/api/v1/launch/presets")
    return body.payload
  }

  /**
   * LOCAL preset expansion, no fetch: merges a preset from an already-fetched `getPresets()`
   * payload with the caller's overrides into a launch body. Overrides win. Throws a plain
   * `Error` on an unknown preset name. The result still needs `name`/`symbol`/`imageUrl`
   * (typically supplied via `overrides`); the server remains the authoritative validator.
   */
  expandPreset(presets: PresetsPayload, name: string, overrides: Partial<LaunchRequest> = {}): LaunchRequest {
    const preset = presets.presets.find((p) => p.name === name)
    if (!preset) {
      const known = presets.presets.map((p) => p.name).join(", ")
      throw new Error(`Unknown preset "${name}". Known presets: ${known}`)
    }
    return {
      chain: preset.chain,
      quoteAsset: preset.quoteAsset,
      mode: preset.mode,
      stakerAllocationBps: preset.stakerAllocationBps,
      ...(preset.dexVersion ? { dexVersion: preset.dexVersion } : {}),
      ...overrides,
      // The cast covers name/symbol/imageUrl, which a preset never carries; the launch
      // endpoint rejects a body that still lacks them.
    } as LaunchRequest
  }

  async getMarket(chain: Chain, mint: string): Promise<MarketState> {
    const body = await this.requestJson<{ success: true; market: MarketState }>(
      "GET",
      `/api/v1/markets/${chain}/${encodeURIComponent(mint)}`,
    )
    return body.market
  }

  async getQuote(
    chain: Chain,
    mint: string,
    q: { side: "buy" | "sell"; amountIn: string; slippageBps?: number },
  ): Promise<QuoteResult> {
    const params = new URLSearchParams({ side: q.side, amountIn: q.amountIn })
    if (q.slippageBps !== undefined) params.set("slippageBps", String(q.slippageBps))
    return this.requestJson<QuoteResult>(
      "GET",
      `/api/v1/markets/${chain}/${encodeURIComponent(mint)}/quote?${params.toString()}`,
    )
  }

  async getFeed(bucket: FeedBucket, chain?: Chain): Promise<FeedResult> {
    const params = new URLSearchParams({ bucket, ...(chain ? { chain } : {}) })
    return this.requestJson<FeedResult>("GET", `/api/v1/markets/feed?${params.toString()}`)
  }

  async verify(chain: Chain, mint: string): Promise<VerifyResult> {
    return this.requestJson<VerifyResult>("GET", `/api/v1/verify/${chain}/${encodeURIComponent(mint)}`)
  }

  async getAgentProfile(idOrWallet: string): Promise<AgentProfile> {
    const body = await this.requestJson<{ success: true; agent: AgentProfile }>(
      "GET",
      `/api/v1/users/${encodeURIComponent(idOrWallet)}/agent`,
    )
    return body.agent
  }

  /**
   * The calling account's tier snapshot: display/live tier, staked/held CNDL, qualification
   * thresholds, grace window state, resolved fee bps, and lifetime fee totals by chain/asset.
   * Not a "keyed endpoint" in the `requireKey()` sense below: the server accepts either an agent
   * key or a Privy session, so this method sends whatever `x-api-key` the client was constructed
   * with (possibly none) and lets the server's own auth middleware decide.
   */
  async getAgentTier(): Promise<AgentTierInfo> {
    return this.requestJson<AgentTierInfo>("GET", "/api/v1/agent/tier")
  }

  // -- keyed endpoints ------------------------------------------------------

  async dryRunLaunch(req: LaunchRequest): Promise<DryRunResult> {
    this.requireKey("dryRunLaunch()")
    return this.requestJson<DryRunResult>("POST", "/api/v1/launch/headless/dry-run", req)
  }

  /**
   * Blocking launch with idempotent retries. Generates `clientLaunchId` when absent and
   * re-sends the SAME id on retryable failures; see the module doc for the exact policy.
   */
  async launch(req: LaunchRequest): Promise<LaunchResult> {
    this.requireKey("launch()")
    const body: LaunchRequest = { ...req, clientLaunchId: req.clientLaunchId ?? generateClientLaunchId() }
    let lastError: unknown
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(retryDelayMs(attempt - 1))
      try {
        return await this.requestJson<LaunchResult>("POST", "/api/v1/launch/headless", body)
      } catch (error) {
        if (!isRetryableLaunchFailure(error)) throw error
        lastError = error
      }
    }
    throw lastError
  }

  /**
   * Fire-and-poll launch: sends `async: true`, returns the 202 body. Single attempt (poll
   * `waitForLaunch` instead of retrying the POST). Generates `clientLaunchId` like `launch()`
   * so the returned body always carries the id to poll.
   */
  async launchAsync(req: LaunchRequest): Promise<AcceptedJob> {
    this.requireKey("launchAsync()")
    const body = { ...req, clientLaunchId: req.clientLaunchId ?? generateClientLaunchId(), async: true }
    return this.requestJson<AcceptedJob>("POST", "/api/v1/launch/headless", body)
  }

  async getLaunchJob(clientLaunchId: string): Promise<LaunchJob> {
    this.requireKey("getLaunchJob()")
    const body = await this.requestJson<{ success: true; job: LaunchJob }>(
      "GET",
      `/api/v1/launch/headless/jobs/${encodeURIComponent(clientLaunchId)}`,
    )
    return body.job
  }

  /**
   * Polls the jobs endpoint until the attempt is terminal (`confirmed` or `failed`; the caller
   * branches on `status`). Throws a plain `Error` once `timeoutMs` (default 3 minutes) passes
   * without a terminal status; the launch itself keeps running server-side, so on timeout poll
   * again or verify on-chain before starting over under a NEW clientLaunchId.
   */
  async waitForLaunch(clientLaunchId: string, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<LaunchJob> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
    const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const job = await this.getLaunchJob(clientLaunchId)
      if (job.status === "confirmed" || job.status === "failed") return job
      if (Date.now() >= deadline) {
        throw new Error(
          `waitForLaunch("${clientLaunchId}") timed out after ${timeoutMs}ms (last status: ${job.status})`,
        )
      }
      await sleep(pollMs)
    }
  }

  async reportActivity(chain: Chain, signature: string): Promise<unknown> {
    this.requireKey("reportActivity()")
    return this.requestJson<unknown>("POST", "/api/v1/activity/report", { chain, signature })
  }

  /**
   * Uploads raw image bytes to POST /api/v1/uploads/agent-image (ships in Phase 2 wave 3) and
   * returns the hosted URL, immediately usable as a launch body's `imageUrl`.
   */
  async uploadImage(bytes: Uint8Array, contentType: string): Promise<{ imageUrl: string }> {
    this.requireKey("uploadImage()")
    const res = await this.fetchImpl(`${this.apiUrl}/api/v1/uploads/agent-image`, {
      method: "POST",
      headers: this.headers({ contentType }),
      body: bytes as BodyInit,
    })
    const body = await this.parseResponse<{ success: true; imageUrl: string }>(res)
    return { imageUrl: body.imageUrl }
  }

  /**
   * Lists this account's linked wallets (GET /api/v1/agent/wallets), active rows first.
   * Active-only by default (Agent Pilot Phase 1, Task 2): pass `includeRevoked: true` to also
   * see revoked (tombstoned) rows. The query string stays clean when `includeRevoked` is
   * omitted/false -- `?includeRevoked=true` is appended only when the caller asks for it.
   */
  async listWallets(opts: { includeRevoked?: boolean } = {}): Promise<ListWalletsResult> {
    this.requireKey("listWallets()")
    const query = opts.includeRevoked === true ? "?includeRevoked=true" : ""
    return this.requestJson<ListWalletsResult>("GET", `/api/v1/agent/wallets${query}`)
  }

  /**
   * Reads this key's own effective spend limits (roadmap C, Task 5), so an agent can self-throttle
   * before a trade or launch ever hits `SPEND_LIMIT_EXCEEDED`. Read-only: raising a cap always
   * requires a Privy session (the portal), never this SDK -- see `SpendLimitsResult` for how to
   * resolve `keyLimits` into the cap that applies to a given trade.
   */
  async getSpendLimits(): Promise<SpendLimitsResult> {
    this.requireKey("getSpendLimits()")
    return this.requestJson<SpendLimitsResult>("GET", "/api/v1/agent/keys/self/limits")
  }

  /**
   * One-shot base-asset conversion through the account's own embedded wallets: quote and execute
   * in a single call. A pair that spans the Solana and Hood sides routes through the bridge, which
   * makes this the only agent-facing way to move value between them, and therefore how a Hood
   * wallet gets funded before a Hood launch or trade.
   *
   * MOVES REAL FUNDS on every call. Test-environment keys are refused outright with
   * `TEST_ENVIRONMENT_FORBIDDEN`: no leg of this rail has a non-production equivalent, since every
   * one settles on a live venue.
   *
   * `clientSwapId` is a coalescing key, NOT a durable idempotency ledger. A duplicate arriving
   * while the first request is still in flight is handed that same result; one arriving after it
   * settled executes a second swap. Omitting it never coalesces at all. This method therefore
   * never retries on its own, unlike `launch()`: a retried funding call that already landed would
   * silently move the funds twice.
   */
  async swap(req: SwapRequest): Promise<SwapResult> {
    this.requireKey("swap()")
    const body = await this.requestJson<{ success: true; payload: SwapResult }>("POST", "/api/v1/agent/swap", req)
    return body.payload
  }

  /**
   * Imports an existing wallet via Candle's ciphertext-only flow (PR3): calls
   * `/agent/wallets/import/init` for Privy's HPKE receiver public key, encrypts `privateKey`
   * locally with `encryptWalletKeyForImport` (wallet-import.ts) -- which decodes it to raw bytes
   * per `chain` (hex for "evm", base58 for "solana") before sealing, matching Privy's own import
   * reference -- then posts the ciphertext to `/agent/wallets/import/submit`. `privateKey` exists
   * in memory only inside this function: it is read here, consumed by the local encrypt call, and
   * never appears in a request body; only `ciphertext`/`encapsulatedKey` are sent over the wire.
   *
   * `signerPublicKey` is the base64 DER public half of a P-256 keypair (see
   * `generateSignerKeypair()` in wallet-import.ts, or any equivalent key the caller manages) that
   * Privy registers as the wallet's signer; its private half is never sent here or anywhere else
   * in this call.
   */
  async importWallet(params: {
    chain: WalletChain
    address: string
    privateKey: string
    signerPublicKey: string
    label?: string
  }): Promise<ImportWalletResult> {
    this.requireKey("importWallet()")
    const init = await this.requestJson<{ success: true; encryptionPublicKey: string }>(
      "POST",
      "/api/v1/agent/wallets/import/init",
      { chain: params.chain, address: params.address },
    )
    const { ciphertext, encapsulatedKey } = await encryptWalletKeyForImport({
      chain: params.chain,
      privateKey: params.privateKey,
      encryptionPublicKey: init.encryptionPublicKey,
    })
    return this.requestJson<ImportWalletResult>("POST", "/api/v1/agent/wallets/import/submit", {
      chain: params.chain,
      address: params.address,
      ciphertext,
      encapsulatedKey,
      signerPublicKey: params.signerPublicKey,
      ...(params.label !== undefined ? { label: params.label } : {}),
    })
  }

  /**
   * Self-signed launch build: returns an unsigned transaction for the agent to sign and
   * broadcast itself. Candle never signs and never holds the signer key. Signing a linked wallet
   * still needs an app-authenticated call to Privy that an external agent cannot make alone:
   * Privy requires both the agent's own P-256 authorization signature over the exact transaction
   * AND app-level auth that only Candle's server secret satisfies. That call goes through the
   * Candle sign relay (POST /api/v1/agent/wallets/:id/sign) -- the agent authorizes locally with
   * its own key, and Candle authenticates the app and forwards the already-authorized request,
   * unable to substitute a different wallet or transaction. selfLaunch() below runs this whole
   * round trip (build -> sign -> broadcast -> confirm) in one call for both Solana and Hood; call
   * this method directly only to drive the steps yourself. See "Self-signed launches" in
   * docs/headless-launch.md.
   */
  async buildSelfLaunch(req: BuildSelfLaunchRequest): Promise<BuildSelfLaunchResult> {
    this.requireKey("buildSelfLaunch()")
    return this.requestJson<BuildSelfLaunchResult>("POST", "/api/v1/launch/self/build", req)
  }

  /**
   * Self-signed launch confirm: verifies the agent's own broadcast on-chain, then records the
   * launch identically to the headless path. Signature is the transaction hash from the agent's
   * own broadcast. devBuySignature (Hood only) is the optional follow-up dev-buy transaction. See
   * selfLaunch() below for the one-call version of this whole flow (Solana).
   */
  async confirmSelfLaunch(req: ConfirmSelfLaunchRequest): Promise<ConfirmSelfLaunchResult> {
    this.requireKey("confirmSelfLaunch()")
    return this.requestJson<ConfirmSelfLaunchResult>("POST", "/api/v1/launch/self/confirm", req)
  }

  /**
   * Build (or, for a main payer, build-and-execute) one buy/sell trade against an existing
   * market. See docs/agent-trading.md for the full fee model, spend gate, and error reference.
   *
   * - **Main payer**: the trade executes immediately, INLINE, through the account's own
   *   delegated wallet (the same server-signs-via-Privy model `launch()` uses) -- the response is
   *   `status: "executed"` outright, and there is nothing left to sign or confirm.
   * - **Linked payer**: the response is `status: "built"`, an unsigned artifact for the agent to
   *   sign ITSELF -- Candle never signs a linked payer's trade and never holds its signer key.
   *   Signing goes through the Candle sign relay (the same one self-signed launches depend on; see
   *   buildSelfLaunch()'s jsdoc): Solana signs `artifacts.transactionBase64` via the linked
   *   wallet's own Privy signer quorum. Hood signs `artifacts.approval` (if present), then
   *   `artifacts.trade`, then `artifacts.feeTransfer` (if present) -- in that exact order. From
   *   there, trade() below's default differs by chain: Solana hands the already-signed bytes to
   *   `submit({ clientTradeId, signedTransactions })`, which broadcasts and confirms them
   *   server-side in one call; Hood stays on the client-broadcast sequence -- broadcast each signed
   *   leg with `broadcastSignedTransaction`, awaiting each leg's own receipt before assembling the
   *   next (its `trade` leg's gas estimate depends on the `approval` leg already being mined), then
   *   `confirmTrade({ clientTradeId, tradeTxHash, feeTxHash })`, where `feeTxHash` is REQUIRED
   *   whenever `artifacts.feeTransfer` was present (a confirm that omits it is refused
   *   `FEE_LEG_MISSING`). Solana's lower-level opt-in path
   *   (`broadcastSignedTransaction`/`confirmTrade({ clientTradeId, signature })` instead of
   *   `submit()`) and Hood's `submit()` opt-in (skipping the per-leg broadcast/confirm) both stay
   *   available too, for callers who want the other of the two.
   *
   * Requires an agent key with the `swap:write` scope -- opt-in, omitted by default when a key is
   * issued; pass `scopes: [..., "swap:write"]` to `POST /api/v1/agent/keys` to grant it.
   */
  async buildTrade(req: BuildTradeRequest): Promise<BuildTradeResult> {
    this.requireKey("buildTrade()")
    return this.requestJson<BuildTradeResult>("POST", "/api/v1/trade/agent/build", req)
  }

  /**
   * Confirm a LINKED payer's own broadcast trade: Candle verifies it landed on-chain, that it was
   * actually signed/sent by the declared linked wallet, that it moved this trade's own mint in
   * the right direction, and -- when the build carried a fee -- that the fee transfer landed too,
   * BEFORE recording anything. A main payer's trade never reaches this call: it already completed
   * inline at `buildTrade()`, and confirming it is rejected `VALIDATION_FAILED`. Idempotent:
   * confirming an already-confirmed `clientTradeId` replays the stored result without
   * re-verifying anything on-chain.
   */
  async confirmTrade(req: ConfirmTradeRequest): Promise<ConfirmTradeResult> {
    this.requireKey("confirmTrade()")
    return this.requestJson<ConfirmTradeResult>("POST", "/api/v1/trade/agent/confirm", req)
  }

  /**
   * Server-side alternative to the sign-then-confirmTrade() round trip above: hand the server the
   * already-signed legs (produced by signLinkedTransaction(), still unbroadcast) and it broadcasts
   * them itself, then confirms inline. One call instead of two; no client-side broadcast, no
   * separate confirmTrade() call.
   */
  async submit(req: SubmitTradeRequest): Promise<ExecutedTradeResult> {
    this.requireKey("submit()")
    return this.requestJson<ExecutedTradeResult>("POST", "/api/v1/trade/agent/submit", req)
  }

  // -- linked-wallet signing relay + one-shot flows --------------------------

  /**
   * Signs an unsigned transaction (or, for EVM, an already-assembled transaction) with a linked
   * wallet's OWN Privy signer, without Candle ever holding the key: loads the agent's P-256
   * signer PEM from `secretStore` (keyed by `linkedWalletId`), computes the Privy authorization
   * signature over the exact RPC body locally (`buildPrivyAuthorizationSignature`), then calls
   * the Candle sign relay (`POST /api/v1/agent/wallets/:id/sign`), which forwards the
   * already-authorized request to Privy unchanged. Requires `privyAppId` in
   * `CandleClientOptions` -- the SAME Privy app id the relay's server authenticates under, since
   * the authorization signature covers that app id -- and an `apiKey` with the `swap:write`
   * scope. Throws a clear error naming the missing option/key when `privyAppId`, `secretStore`,
   * or a stored PEM for `linkedWalletId` is missing.
   */
  async signLinkedTransaction(params: SignLinkedTransactionParams): Promise<SignLinkedTransactionResult> {
    this.requireKey("signLinkedTransaction()")
    if (!this.privyAppId) {
      throw new Error(
        "signLinkedTransaction() requires privyAppId: pass one in CandleClientOptions " +
          "(new CandleClient({ privyAppId })) -- the same Privy app id the sign relay authenticates under",
      )
    }
    if (!this.secretStore) {
      throw new Error(
        "signLinkedTransaction() requires a secretStore: pass one in CandleClientOptions " +
          "(new CandleClient({ secretStore }))",
      )
    }
    if (params.chain === "solana" && !params.unsignedTransactionBase64) {
      throw new Error('signLinkedTransaction() for chain "solana" requires unsignedTransactionBase64')
    }
    if (params.chain === "evm" && !params.evmTxParams) {
      throw new Error('signLinkedTransaction() for chain "evm" requires evmTxParams')
    }

    const privateKeyPem = await this.secretStore.get(params.linkedWalletId)
    if (!privateKeyPem) {
      throw new Error(
        `signLinkedTransaction(): no signer key stored for linked wallet "${params.linkedWalletId}" -- ` +
          "import or set one in the configured secretStore first",
      )
    }

    const body =
      params.chain === "solana"
        ? { method: "signTransaction", params: { transaction: params.unsignedTransactionBase64, encoding: "base64" } }
        : { method: "eth_signTransaction", params: { transaction: params.evmTxParams } }

    const authorizationSignature = await buildPrivyAuthorizationSignature({
      privateKeyPem,
      privyWalletId: params.privyWalletId,
      appId: this.privyAppId,
      body,
    })

    const res = await this.requestJson<{ success: true; signedTransaction: string; encoding: string }>(
      "POST",
      `/api/v1/agent/wallets/${encodeURIComponent(params.linkedWalletId)}/sign`,
      { authorizationSignature, body },
    )
    return { signedTransaction: res.signedTransaction, encoding: res.encoding }
  }

  /**
   * Broadcasts an already-signed transaction (from `signLinkedTransaction()`) via minimal
   * fetch-based JSON-RPC -- no web3.js/viem/ethers. Solana: `sendTransaction` against
   * `solanaRpcUrl`, returns the transaction signature. EVM: `eth_sendRawTransaction` against
   * `evmRpcUrl`, returns the transaction hash. Throws a clear error naming the missing option
   * when the relevant RPC URL is not configured. When the RPC itself rejects the broadcast (a
   * JSON-RPC `error` envelope), the underlying `JsonRpcError` propagates unchanged -- it is not
   * caught and flattened into a plain message -- so callers can inspect `.code` and `.data`
   * (`.err`/`.logs` on Solana) for the real on-chain cause, e.g. a Solana `-32002` whose
   * `data.err` is `"BlockhashNotFound"`.
   */
  async broadcastSignedTransaction(chain: WalletChain, signedTransaction: string, encoding: string): Promise<string> {
    if (chain === "solana") {
      if (!this.solanaRpcUrl) {
        throw new Error(
          'broadcastSignedTransaction() for chain "solana" requires solanaRpcUrl: pass one in ' +
            "CandleClientOptions (new CandleClient({ solanaRpcUrl }))",
        )
      }
      return this.jsonRpcCall(this.solanaRpcUrl, "sendTransaction", [signedTransaction, { encoding }])
    }
    if (!this.evmRpcUrl) {
      throw new Error(
        'broadcastSignedTransaction() for chain "evm" requires evmRpcUrl: pass one in CandleClientOptions ' +
          "(new CandleClient({ evmRpcUrl }))",
      )
    }
    return this.jsonRpcCall(this.evmRpcUrl, "eth_sendRawTransaction", [signedTransaction])
  }

  /**
   * Cross-chain base-asset swap FROM A LINKED WALLET: SOL on the linked Solana wallet into
   * ETH/USDG on Hood, without Candle ever holding a key. Three steps in one call, mirroring
   * `trade()`'s linked flow: `POST /api/v1/agent/swap/build` (the server quotes the bridge and
   * compiles the unsigned deposit transaction with the linked wallet as payer, stamping its
   * bytes for the sign relay), `signLinkedTransaction()` per returned transaction, and
   * `POST /api/v1/agent/swap/submit` (server-side broadcast -- no solanaRpcUrl needed).
   *
   * The output lands on the account's OWN wallets only: pass `toWalletId` (a linked EVM wallet
   * of the same account) or omit it for the owner's embedded Hood wallet. The bridge fill is
   * asynchronous -- poll the returned `statusChecks` URLs to observe it complete; `hashes` only
   * proves the Solana deposit landed. Sign promptly after building: the deposit transaction
   * carries a recent blockhash and expires in about a minute.
   *
   * v1 supports `from: "SOL"` only. Same-chain conversions (SOL/USDC/CNDL) are `trade()` with a
   * base-asset mint (free, every tier); USDC/CNDL origins convert to SOL that way first.
   */
  async swapFromLinked(req: LinkedSwapRequest): Promise<LinkedSwapResult> {
    this.requireKey("swapFromLinked()")
    const build = await this.requestJson<{
      success: true
      payload: { swapId: string; transactionsBase64: string[] }
    }>("POST", "/api/v1/agent/swap/build", {
      from: req.from,
      to: req.to,
      amountRaw: req.amountRaw,
      ...(req.maxSlippageBps !== undefined ? { maxSlippageBps: req.maxSlippageBps } : {}),
      payer: { type: "linked", linkedWalletId: req.payer.linkedWalletId },
      ...(req.toWalletId !== undefined ? { toWalletId: req.toWalletId } : {}),
    })

    const signed: string[] = []
    for (const unsignedTransactionBase64 of build.payload.transactionsBase64) {
      const result = await this.signLinkedTransaction({
        chain: "solana",
        linkedWalletId: req.payer.linkedWalletId,
        privyWalletId: req.payer.privyWalletId,
        unsignedTransactionBase64,
      })
      signed.push(result.signedTransaction)
    }

    const submit = await this.requestJson<{ success: true; payload: LinkedSwapResult }>(
      "POST",
      "/api/v1/agent/swap/submit",
      { swapId: build.payload.swapId, signedTransactionsBase64: signed },
    )
    return submit.payload
  }

  /**
   * One-call trade. A MAIN payer delegates unchanged to the existing inline
   * `buildTrade({ payer: { type: "main" } })` path -- it never touches the sign relay or a
   * secretStore, and returns that call's own `status: "executed"` result directly.
   *
   * A LINKED payer's default differs by chain -- Solana defaults to server-side submit, Hood
   * stays on client-side broadcast, because Hood's per-leg gas estimation genuinely needs an
   * earlier leg mined on-chain before the next is even assembled (see the Hood paragraph below).
   * Candle only ever handles already-signed bytes either way -- it never signs a linked payer's
   * trade and never holds its signer key.
   *
   * - **Solana**: `buildTrade` -> `signLinkedTransaction` -> `submit({ clientTradeId,
   *   signedTransactions: [signed.signedTransaction] })`, returning the executed result the
   *   server's own broadcast-and-confirm produced. The build response carries the FULL unsigned
   *   transaction, blockhash included (`artifacts.transactionBase64`), so signing needs no RPC
   *   read at all -- `solanaRpcUrl` is unused on this path, and there is no client-side
   *   blockhash-rebuild loop; the server controls broadcast and its own blockhash freshness now.
   *   The lower-level `buildTrade`/`signLinkedTransaction`/`broadcastSignedTransaction`/
   *   `confirmTrade` sequence (with its own blockhash-rebuild loop) stays available, unchanged,
   *   for callers who want to broadcast client-side instead -- see those methods' own jsdoc.
   * - **Hood/EVM**: unchanged from before -- `artifacts.approval` (when present), then
   *   `artifacts.trade`, then `artifacts.feeTransfer` (when present) -- in that exact order, EACH
   *   leg's receipt awaited (`waitForReceipt`) before the next leg is even assembled, then
   *   `confirmTrade({ clientTradeId, tradeTxHash, feeTxHash })`. This ordering is load-bearing,
   *   not a style choice: the `trade` leg's `eth_estimateGas` reverts if it runs before the
   *   `approval` leg is mined, since the on-chain allowance is not yet set -- so Hood stays off
   *   `submit()` by default (submit() is still available as an explicit opt-in for a caller that
   *   has already confirmed no approval leg is needed). Requires `evmRpcUrl`; throws a clear error
   *   naming it when unset, before any RPC read or signing.
   */
  async trade(req: TradeRequest): Promise<ExecutedTradeResult> {
    const clientTradeId = req.clientTradeId ?? generateClientTradeId()
    const buildReq: BuildTradeRequest = {
      clientTradeId,
      mint: req.mint,
      side: req.side,
      amountRaw: req.amountRaw,
      payer: req.from === "main" ? { type: "main" } : { type: "linked", linkedWalletId: req.from.linkedWalletId },
      ...(req.maxSlippageBps !== undefined ? { maxSlippageBps: req.maxSlippageBps } : {}),
      ...(req.quoteAsset !== undefined ? { quoteAsset: req.quoteAsset } : {}),
    }

    if (req.from === "main") {
      const result = await this.buildTrade(buildReq)
      if (result.status !== "executed") {
        throw new Error(`trade({ from: "main" }) expected an executed result but got status "${result.status}"`)
      }
      return result
    }

    const { linkedWalletId, privyWalletId } = req.from
    const built = await this.buildTrade(buildReq)
    if (built.status !== "built") {
      // Idempotent replay of an already-confirmed trade: buildTrade already returned it executed.
      return built
    }

    if (built.chain === "solana") {
      // The build response already carries the full unsigned transaction, blockhash included --
      // no RPC read is needed to sign it, and the server (submit()'s target) now owns broadcast
      // and its own blockhash freshness, so there is no rebuild-on-expiry loop here. That loop
      // still exists, unchanged, on the lower-level opt-in broadcast path (see
      // signLinkedTransaction()/broadcastSignedTransaction()/confirmTrade()'s own jsdoc) and on
      // selfLaunch()'s Solana branch below.
      const signed = await this.signLinkedTransaction({
        linkedWalletId,
        privyWalletId,
        chain: "solana",
        unsignedTransactionBase64: built.artifacts.transactionBase64,
      })
      return this.submit({ clientTradeId: built.clientTradeId, signedTransactions: [signed.signedTransaction] })
    }

    // Hood (built.chain === "hood"): each leg is its own transaction (see this method's jsdoc for
    // why the order and per-leg receipt wait are load-bearing). Stays on the client-broadcast path
    // (NOT submit()): the trade leg's eth_estimateGas needs the approval leg already mined, which
    // only holds when each leg is broadcast and its receipt awaited before the next is assembled.
    if (!this.evmRpcUrl) {
      throw new Error(
        'trade({ from: <linked> }) on chain "hood" requires evmRpcUrl, because hood is an EVM chain: ' +
          "pass one in CandleClientOptions (new CandleClient({ evmRpcUrl }))",
      )
    }
    const rpc = this.evmRpc()
    const from = built.walletAddress
    const chainId = await fetchChainId(rpc)
    const baseNonce = await fetchNonce(rpc, from)
    const feeData = await fetchFeeData(rpc)

    const legs: Array<{ kind: "approval" | "trade" | "feeTransfer"; to: string; data: string; value: string }> = []
    if (built.artifacts.approval) {
      legs.push({ kind: "approval", to: built.artifacts.approval.to, data: built.artifacts.approval.data, value: "0" })
    }
    legs.push({ kind: "trade", ...built.artifacts.trade })
    if (built.artifacts.feeTransfer) {
      legs.push({ kind: "feeTransfer", ...built.artifacts.feeTransfer })
    }

    let tradeTxHash: string | undefined
    let feeTxHash: string | undefined
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i]
      if (!leg) continue
      // Sequential by design, not a missed Promise.all: each leg must be mined before the next
      // leg's estimateGas runs (see this method's jsdoc).
      const txHash = await this.signBroadcastAndWaitEvmLeg({
        rpc,
        from,
        to: leg.to,
        data: leg.data,
        valueDecimal: leg.value,
        nonce: baseNonce + i,
        chainId,
        feeData,
        linkedWalletId,
        privyWalletId,
      })
      if (leg.kind === "trade") tradeTxHash = txHash
      if (leg.kind === "feeTransfer") feeTxHash = txHash
    }
    if (!tradeTxHash) {
      // Unreachable: `legs` always includes exactly one "trade" entry, pushed unconditionally above.
      throw new Error("trade(): Hood leg sequence completed without a trade leg")
    }

    return this.confirmTrade({
      clientTradeId: built.clientTradeId,
      tradeTxHash,
      ...(feeTxHash ? { feeTxHash } : {}),
    })
  }

  /**
   * One-call self-signed launch. Solana: `buildSelfLaunch` -> `signLinkedTransaction` ->
   * `broadcastSignedTransaction` -> `confirmSelfLaunch` (`built.transaction` is a base64 unsigned
   * transaction). Fills in `clientLaunchId` (like `launch()`) when the caller omits one.
   *
   * Hood: `built.transaction` is `{ to, data }` calldata for the createCurve tx, no approval leg.
   * Signs, broadcasts, and waits for its receipt, then -- when the build carried a `feeTransfer`
   * leg (a platform fee applies) -- does that leg next at `nonce + 1` and captures `feeTxHash`.
   * Requires `evmRpcUrl`; throws a clear error naming it when unset, before any signing. Does NOT
   * send a dev buy: a Hood self-launch's dev buy runs out-of-band, server-side, after confirm --
   * the build response never includes a dev-buy leg, and this method does not assemble one.
   */
  async selfLaunch(req: SelfLaunchRequest): Promise<ConfirmSelfLaunchResult> {
    const { privyWalletId, ...launchReq } = req
    const body: BuildSelfLaunchRequest = {
      ...launchReq,
      clientLaunchId: launchReq.clientLaunchId ?? generateClientLaunchId(),
    }
    const built = await this.buildSelfLaunch(body)

    if (typeof built.transaction === "string") {
      // Same bounded rebuild-on-blockhash-expiry loop as trade()'s Solana branch above; see its
      // comment for the full rationale. Tracked as plain fields (not the whole `built` object)
      // because `typeof built.transaction === "string"` narrows that one property, not the full
      // BuildSelfLaunchResult union (see the Hood branch's cast below for the same caveat).
      let unsignedTransactionBase64 = built.transaction
      let clientLaunchId = built.clientLaunchId
      for (let attempt = 0; attempt <= MAX_BLOCKHASH_REBUILDS; attempt++) {
        const signed = await this.signLinkedTransaction({
          linkedWalletId: body.linkedWalletId,
          privyWalletId,
          chain: "solana",
          unsignedTransactionBase64,
        })
        try {
          const signature = await this.broadcastSignedTransaction("solana", signed.signedTransaction, signed.encoding)
          return this.confirmSelfLaunch({ clientLaunchId, signature })
        } catch (error) {
          if (!isBlockhashExpiry(error)) throw error
          if (attempt === MAX_BLOCKHASH_REBUILDS) throw withRpcLagHint(error)
          // Unlike buildTrade() (which returns a 200 "executed" success shape on an idempotent
          // replay of an already-confirmed clientTradeId), apps/api/src/routes/launch-self.ts's
          // /build handler refuses an already-confirmed clientLaunchId outright with a 409
          // IDEMPOTENCY_CONFLICT (`begin.kind === "replay" && begin.row.status === "confirmed"`)
          // -- there is no "already executed" SUCCESS shape it could return instead. So a
          // buildSelfLaunch() call that lands on an already-confirmed row throws a CandleApiError
          // here, uncaught, and propagates out of this loop as-is (never flattened into the stale
          // blockhash error below); no explicit "return the replay" branch is needed on this path.
          const rebuilt = await this.buildSelfLaunch(body)
          if (typeof rebuilt.transaction !== "string") throw error
          unsignedTransactionBase64 = rebuilt.transaction
          clientLaunchId = rebuilt.clientLaunchId
        }
      }
      // Unreachable: every loop iteration above either returns or throws.
      throw new Error("selfLaunch(): blockhash-rebuild loop exited without returning or throwing")
    }

    // Hood: built.transaction is { to, data }. TS only narrows the `built.transaction` property
    // itself from the typeof check above (its type differs across the union but is not a
    // literal, so it is not a full discriminant) -- this cast reflects what that check already
    // proved about the whole object at runtime.
    const hoodBuilt = built as BuildSelfLaunchHoodResult
    if (!this.evmRpcUrl) {
      throw new Error(
        'selfLaunch() on chain "hood" requires evmRpcUrl, because hood is an EVM chain: ' +
          "pass one in CandleClientOptions (new CandleClient({ evmRpcUrl }))",
      )
    }
    const rpc = this.evmRpc()
    const from = hoodBuilt.walletAddress
    const chainId = await fetchChainId(rpc)
    const baseNonce = await fetchNonce(rpc, from)
    const feeData = await fetchFeeData(rpc)

    const createCurveTxHash = await this.signBroadcastAndWaitEvmLeg({
      rpc,
      from,
      to: built.transaction.to,
      data: built.transaction.data,
      valueDecimal: "0",
      nonce: baseNonce,
      chainId,
      feeData,
      linkedWalletId: body.linkedWalletId,
      privyWalletId,
    })

    let feeTxHash: string | undefined
    if (hoodBuilt.feeTransfer) {
      feeTxHash = await this.signBroadcastAndWaitEvmLeg({
        rpc,
        from,
        to: hoodBuilt.feeTransfer.to,
        data: hoodBuilt.feeTransfer.data,
        valueDecimal: hoodBuilt.feeTransfer.value,
        nonce: baseNonce + 1,
        chainId,
        feeData,
        linkedWalletId: body.linkedWalletId,
        privyWalletId,
      })
    }

    return this.confirmSelfLaunch({
      clientLaunchId: built.clientLaunchId,
      signature: createCurveTxHash,
      ...(feeTxHash ? { feeTxHash } : {}),
    })
  }

  // -- atomic launch (a launch plus 1-4 first buys, landed as one Jito bundle) ----------------

  /**
   * Builds an atomic launch bundle: a Solana launch transaction plus 1-4 first-buy transactions,
   * all sharing one recent blockhash so Jito lands them together or not at all. Returns the
   * UNSIGNED bytes for every "client" signer leg (a "main" payer leg is signed by Candle itself at
   * submit time and is never returned). Fills in `clientLaunchId` (like `launch()`) when the
   * caller omits one. Call `submitAtomicLaunch()` next -- or drive both calls plus signing in one
   * shot with `launchAtomic()`. See "Atomic launch with first buys" in docs/headless-launch.md for
   * the full model: Pro/Max tier, `launch:write` + `swap:write` scopes, Solana only, the 1-4 buy
   * cap (Jito's 5-transaction bundle limit), and why every buy leg's own on-chain `minAmountOut` is
   * "0" inside the bundle (`expectedFill` on the returned legs is the real consent surface).
   */
  async buildAtomicLaunch(req: BuildAtomicLaunchRequest): Promise<BuildAtomicLaunchResult> {
    this.requireKey("buildAtomicLaunch()")
    const body: BuildAtomicLaunchRequest = { ...req, clientLaunchId: req.clientLaunchId ?? generateClientLaunchId() }
    return this.requestJson<BuildAtomicLaunchResult>("POST", "/api/v1/launch/atomic/build", body)
  }

  /**
   * Submits an already-built bundle's client-signer legs (EXACTLY the ones
   * `BuildAtomicLaunchResult.legs` named `signer: "client"`, in leg order -- omit every "server"
   * leg entirely, never pad the array) and relays the whole bundle to Jito as one atomic unit.
   * `bundleId` is single-use regardless of outcome: it is consumed on this call even before any
   * verification, so a rejected call (tampered bytes, wrong leg count) can only be corrected by
   * calling `buildAtomicLaunch()` again, never by retrying `submitAtomicLaunch()` with the same
   * `bundleId`.
   *
   * Unlike every other keyed method here, a `"failed"` or `"timeout"` outcome (HTTP 502) is
   * returned in this SAME result, not thrown as a `CandleApiError` -- both are normal, expected
   * outcomes of submitting a Jito bundle, not malformed requests or server malfunctions. Every
   * other non-2xx status (400/403/404/501/503 -- scope/tier/validation failures, an unknown or
   * expired `bundleId`, tampered signature bytes) still throws `CandleApiError` as usual.
   *
   * A `"timeout"` response can take meaningfully longer to arrive than a typical API call -- up to
   * roughly 150-160s in the worst case (Jito's own ~60s poll budget plus a further ~90s resolution
   * phase), since Candle checks the launch signature's own on-chain status before answering. Set a
   * client-side timeout no shorter than ~160s (or none) for this call, or you risk abandoning a
   * request that was about to return a normal, if late, response.
   */
  async submitAtomicLaunch(req: SubmitAtomicLaunchRequest): Promise<SubmitAtomicLaunchResult> {
    this.requireKey("submitAtomicLaunch()")
    const res = await this.fetchImpl(`${this.apiUrl}/api/v1/launch/atomic/submit`, {
      method: "POST",
      headers: this.headers({ json: true }),
      body: JSON.stringify(req),
    })
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
    if (isAtomicSubmitOutcome(parsed)) return parsed
    if (!res.ok) throw candleApiErrorFromResponse(res.status, text)
    throw new Error(`submitAtomicLaunch(): unexpected 200 response shape: ${text}`)
  }

  /**
   * One-call atomic launch: `buildAtomicLaunch()` -> `signLinkedTransaction()` for every "client"
   * signer leg, IN LEG ORDER -> `submitAtomicLaunch()`. A "main" payer leg needs no client-side
   * signing at all (Candle signs it server-side at submit, the same delegated-wallet path
   * `launch()`/`trade()`'s main-payer branch uses); a "linked" payer leg is signed HERE, through
   * the same sign relay `trade()`'s linked branch uses -- requires `privyAppId` and a
   * `secretStore` holding that leg's own `linkedWalletId`'s signer key (see
   * `signLinkedTransaction()`'s own jsdoc for the exact errors thrown when either is missing). A
   * bundle with no linked payer at all (every leg "main") skips the signing round entirely and
   * goes straight from build to submit.
   *
   * Returns `submitAtomicLaunch()`'s own result untouched -- see that method's jsdoc for why
   * `"failed"`/`"timeout"` are returned here rather than thrown, and for the recommended
   * client-side timeout.
   */
  async launchAtomic(req: LaunchAtomicRequest): Promise<SubmitAtomicLaunchResult> {
    const { payer, firstBuys, ...launchFields } = req
    const buildReq: BuildAtomicLaunchRequest = {
      ...launchFields,
      clientLaunchId: launchFields.clientLaunchId ?? generateClientLaunchId(),
      payer: toAtomicWirePayer(payer),
      firstBuys: firstBuys.map((leg) => ({ payer: toAtomicWirePayer(leg.payer), amountRaw: leg.amountRaw })),
    }
    const built = await this.buildAtomicLaunch(buildReq)

    const signedTxsBase64: string[] = []
    for (const leg of built.legs) {
      if (leg.signer !== "client") continue
      if (!leg.unsignedTxBase64) {
        throw new Error(
          `launchAtomic(): build response's leg ${leg.index} is signer "client" but omitted unsignedTxBase64`,
        )
      }
      const legPayer = leg.index === 0 ? payer : firstBuys[leg.index - 1]?.payer
      if (!legPayer || legPayer.type !== "linked") {
        throw new Error(
          `launchAtomic(): build response's leg ${leg.index} is signer "client" but this request's own leg ${leg.index} is not a linked payer`,
        )
      }
      const signed = await this.signLinkedTransaction({
        linkedWalletId: legPayer.linkedWalletId,
        privyWalletId: legPayer.privyWalletId,
        chain: "solana",
        unsignedTransactionBase64: leg.unsignedTxBase64,
      })
      signedTxsBase64.push(signed.signedTransaction)
    }

    return this.submitAtomicLaunch({ bundleId: built.bundleId, signedTxsBase64 })
  }

  // -- Hood/EVM one-shot plumbing ---------------------------------------------

  /**
   * The `EvmRpc` seam packages/sdk/src/evm-tx.ts's helpers are built against, built from this
   * client's own `jsonRpcCall`/`jsonRpcCallRaw` closed over `evmRpcUrl`. Callers must have already
   * checked `evmRpcUrl` is set (trade()/selfLaunch() do, with a clear error naming it, before
   * calling this).
   */
  private evmRpc(): EvmRpc {
    const url = this.evmRpcUrl
    if (!url) {
      throw new Error("evmRpc(): evmRpcUrl is unset -- callers must check this first")
    }
    return {
      call: (method, params) => this.jsonRpcCall(url, method, params),
      callRaw: (method, params) => this.jsonRpcCallRaw(url, method, params),
    }
  }

  /**
   * Assembles, signs, broadcasts, and waits for the mined receipt of ONE Hood leg, returning its
   * transaction hash. Shared by trade()'s and selfLaunch()'s Hood branches, both of which must run
   * their legs strictly sequentially -- see trade()'s jsdoc for why a later leg's `estimateGas`
   * depends on an earlier leg already being mined.
   */
  private async signBroadcastAndWaitEvmLeg(params: {
    rpc: EvmRpc
    from: string
    to: string
    data: string
    /** Decimal wei string, as a build leg's `value` field ships it (see evm-tx.ts's assembleEvmTx doc). */
    valueDecimal: string
    nonce: number
    chainId: number
    feeData: { maxFeePerGasHex: string; maxPriorityFeePerGasHex: string }
    linkedWalletId: string
    privyWalletId: string
  }): Promise<string> {
    const gasLimitHex = await estimateGas(params.rpc, {
      from: params.from,
      to: params.to,
      data: params.data,
      value: decimalToHexQuantity(params.valueDecimal),
    })
    const evmTxParams = assembleEvmTx({
      from: params.from,
      to: params.to,
      data: params.data,
      valueDecimal: params.valueDecimal,
      nonce: params.nonce,
      chainId: params.chainId,
      gasLimitHex,
      feeData: params.feeData,
    })
    const signed = await this.signLinkedTransaction({
      linkedWalletId: params.linkedWalletId,
      privyWalletId: params.privyWalletId,
      chain: "evm",
      evmTxParams,
    })
    const txHash = await this.broadcastSignedTransaction("evm", signed.signedTransaction, signed.encoding)
    await waitForReceipt(params.rpc, txHash)
    return txHash
  }

  // -- plumbing -------------------------------------------------------------

  private requireKey(method: string): void {
    if (!this.apiKey) {
      throw new Error(`${method} requires an apiKey: pass one in CandleClientOptions (new CandleClient({ apiKey }))`)
    }
  }

  private headers(opts: { json?: boolean; contentType?: string } = {}): Record<string, string> {
    const headers: Record<string, string> = {}
    if (opts.json) headers["content-type"] = "application/json"
    if (opts.contentType) headers["content-type"] = opts.contentType
    if (this.apiKey) headers["x-api-key"] = this.apiKey
    return headers
  }

  private async requestJson<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method,
      headers: this.headers({ json: body !== undefined }),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return this.parseResponse<T>(res)
  }

  private async parseResponse<T>(res: Response): Promise<T> {
    const text = await res.text()
    if (!res.ok) throw candleApiErrorFromResponse(res.status, text)
    return JSON.parse(text) as T
  }

  /**
   * Minimal fetch-based JSON-RPC 2.0 call, used only by broadcastSignedTransaction(). Both
   * current callers (Solana's sendTransaction, EVM's eth_sendRawTransaction) expect a string
   * result (a signature or tx hash), so this validates that shape here rather than letting a
   * malformed or missing `result` flow out as an unchecked cast at the call site. A JSON-RPC
   * `error` envelope throws a structured `JsonRpcError` (code + the full `data` field, e.g. a
   * Solana `-32002`'s `{ err, logs }`) rather than a plain `Error`, so callers -- notably
   * broadcastSignedTransaction()'s callers deciding whether a broadcast failure is a
   * blockhash-expiry worth rebuilding and retrying -- can inspect the real cause instead of only
   * a flattened message string.
   */
  private async jsonRpcCall(url: string, method: string, params: unknown[]): Promise<string> {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`JSON-RPC ${method} against ${url} failed: HTTP ${res.status}: ${text}`)
    }
    const parsed = JSON.parse(text) as { result?: unknown; error?: { code: number; message: string; data?: unknown } }
    if (parsed.error) {
      throw new JsonRpcError({
        code: parsed.error.code,
        message: formatJsonRpcErrorMessage(method, url, parsed.error),
        data: parsed.error.data,
      })
    }
    if (typeof parsed.result !== "string") {
      throw new Error(
        `JSON-RPC ${method} against ${url} returned a non-string result: ${JSON.stringify(parsed.result)}`,
      )
    }
    return parsed.result
  }

  /**
   * Same POST as jsonRpcCall() above, for RPC methods whose `result` is an OBJECT or `null`
   * rather than a string -- eth_getBlockByNumber (a block) and eth_getTransactionReceipt (a
   * receipt, or null before it is mined). Skips jsonRpcCall()'s string guard, since a non-string
   * (including null) result is the normal, valid shape here. This is the `rpc.callRaw` seam
   * packages/sdk/src/evm-tx.ts's helpers are built against, wired up via evmRpc() above. Throws
   * the same structured `JsonRpcError` as jsonRpcCall() on a JSON-RPC `error` envelope.
   */
  private async jsonRpcCallRaw(url: string, method: string, params: unknown[]): Promise<unknown> {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`JSON-RPC ${method} against ${url} failed: HTTP ${res.status}: ${text}`)
    }
    const parsed = JSON.parse(text) as { result?: unknown; error?: { code: number; message: string; data?: unknown } }
    if (parsed.error) {
      throw new JsonRpcError({
        code: parsed.error.code,
        message: formatJsonRpcErrorMessage(method, url, parsed.error),
        data: parsed.error.data,
      })
    }
    return parsed.result
  }
}

/** Shared `sdk-<uuid>` id generator behind generateClientLaunchId()/generateClientTradeId() below. */
function generateSdkId(): string {
  return `sdk-${crypto.randomUUID()}`
}

function generateClientLaunchId(): string {
  return generateSdkId()
}

function generateClientTradeId(): string {
  return generateSdkId()
}
