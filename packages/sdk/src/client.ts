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
 *   validation error), and it never retries a launch whose stage is `executed` or `unconfirmed`
 *   or whose error already names a mint. Backoff is 250ms * 2^n, jittered to 50-100% of that,
 *   capped at 8s, bounded by `maxRetries` (default 3 retries after the initial attempt).
 */

import { keccak_256 } from "@noble/hashes/sha3"
import { buildPrivyAuthorizationSignature } from "./authorization-signature"
import { CandleApiError, candleApiErrorFromResponse, JsonRpcError, TradeLandedFeeLegError } from "./errors"
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
import {
  CANDLE_HYPERLIQUID_BUILDER_ADDRESS,
  HYPERLIQUID_EXCHANGE_URLS,
  type HyperliquidNetwork,
  type HyperliquidTypedData,
  hyperliquidCloseOrder,
  hyperliquidExchangeBody,
  hyperliquidRelayBody,
  verifyPerpsBuild,
} from "./hyperliquid"
import type { HyperliquidPnlSection } from "./hyperliquid-pnl"
import { fromBase64 } from "./internal/encoding"
import { describeRpcEndpoint } from "./internal/rpc-endpoint"
import type { AgentPlansResult, PlanPrice, PlanTable } from "./plans"
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
  /** Base URL of the Candle API, e.g. "https://api.alpha.candle.tv" (the alpha deployment). Trailing slashes are trimmed. */
  apiUrl: string
  /** Agent API key (cndl_live_... / cndl_test_...). Required for launch, jobs, activity, uploads. */
  apiKey?: string
  /** Injectable fetch for tests; defaults to the global. */
  fetch?: typeof fetch
  /**
   * Allow an `http://` {@link apiUrl} pointing at a NON-loopback host. Off by default: this client
   * attaches `x-api-key` to every authenticated call, so cleartext hands the key to anything on the
   * path, and a redirect to HTTPS is too late to help. Loopback (`localhost`, `127.0.0.0/8`, `::1`)
   * is always allowed and needs no flag. Set this only for a trusted local endpoint that is not
   * loopback, such as a devcontainer reaching its host.
   */
  allowInsecureHttp?: boolean
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
  /**
   * Candle's Hyperliquid builder address, pinned by the caller. Every perps build is checked
   * against it before signing: an order must name exactly this builder (or none, on a Max order),
   * and setup must approve exactly it. Unset, the client uses `CANDLE_HYPERLIQUID_BUILDER_ADDRESS`
   * when this release carries one, and otherwise trusts the builder `GET /agent/perps/config`
   * reports the first time and holds every later build to that same address.
   */
  hyperliquidBuilder?: string
  /** The Hyperliquid network this client trades on. Default mainnet; a build for another is refused. */
  hyperliquidNetwork?: HyperliquidNetwork
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
  /** Wallet the real launch pays from; null when no wallet is available for the resolved chain. */
  launchWallet: string | null
  resolved: {
    chain: Chain
    quoteAsset: string
    mode: LaunchTier
    stakerAllocationBps: number
    dexVersion: "v3" | "v4" | null
    visibility: string
    buyAmount: string
  }
  checks: {
    image: string
    /** `"ok"` when a `bannerUrl` was sent and checked; absent otherwise. */
    banner?: string
    /**
     * Present only for an exclusive (or test-exclusive) mode, the modes that run the Believer
     * check, and then `true`: an ineligible account gets EXCLUSIVE_NOT_ELIGIBLE instead. Absent in
     * any other mode, where nothing was checked.
     */
    exclusiveEligible?: boolean
  }
  matrixVersion: number
  /**
   * Solana only: the assembled launch transaction's size. Absent on Hood, and when the size
   * computation itself failed transiently. A body that would not fit fails the dry run with
   * TRANSACTION_TOO_LARGE instead, so `fits` is always true when present.
   */
  size?: { txBytes: number; limit: number; maxNameBytes: number; fits: boolean }
}

/**
 * POST /api/v1/launch/self/dry-run response: the headless dry run's shape, with `launchWallet` the
 * linked or TEE wallet `buildSelfLaunch()` would pay from, and `launchWalletId` its id. Never
 * checks that wallet's balance.
 */
export interface SelfLaunchDryRunResult extends Omit<DryRunResult, "launchWallet"> {
  launchWallet: string
  launchWalletId: string
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
  /**
   * Set when a headless attempt has broadcast evidence and is not yet confirmed.
   * `executed` / `unconfirmed` means this id is reserved; a later POST resumes it.
   */
  stage?: "executed" | "unconfirmed"
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
  /** Additive Release A fields are optional when connected to an older API. */
  candleLaunched?: boolean
  launchpad?: string | null
  venue?: "candle-curve" | "jupiter" | "dex" | "hood-dex" | null
  trade?: { endpoint: "POST /api/v1/trade/agent/quote"; routable: boolean; reason?: string }
  /** Legacy lifecycle/curve/fee fields are non-authoritative for external tokens. */
  external?: boolean
  decimals?: number
  quoteDecimals?: number
  jupiterOk?: boolean
  externalTradeable?: boolean
  paperDiscoveryOk?: boolean
  organic0LiveOk?: boolean
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
  /**
   * Display tier: max > pro > believer > free. From the three-plan launch the server sends only
   * `free`, `pro` or `max`; `believer` stays in this type for one release after it, then goes.
   */
  tier: "free" | "believer" | "pro" | "max"
  /** Live-evaluated tier, independent of the Believer key-issuance label. */
  liveTier: "free" | "pro" | "max"
  stakedCndl: number
  heldCndl: number
  /** `graceMs` is 0 from the three-plan launch: Pro through CNDL then has no grace window. */
  thresholds: { minStakedCndl: number; minHeldCndl: number; graceMs: number }
  /**
   * `startedAt` is null unless `active` (see the endpoint's own doc for why). `endsAt` is the
   * server's deadline for an open window; absent from an older server. Never active from the
   * three-plan launch.
   */
  grace: { active: boolean; startedAt: number | null; endsAt?: number | null }
  maxTierExpiresAt: number | null
  /**
   * True when this account HAD Max and it lapsed. False both for an active Max and for an
   * account that never subscribed, which otherwise read identically (`tier: "free"`), and
   * which is exactly the confusion this flag exists to end: the fee below silently became
   * nonzero the moment the plan expired.
   */
  maxExpired: boolean
  /** When the lapsed grant ended (ms). Present only when `maxExpired`. */
  maxExpiredAt?: number
  /**
   * Which kind of grant lapsed. Present only when `maxExpired`. `"promo"` is the Max that came free
   * with a first Pro purchase; while the account still pays for Pro, that lapse is not reported.
   * Treat an unknown value as a generic Max expiry.
   */
  maxExpiredSource?: "subscription" | "trial" | "team" | "promo"
  /**
   * The server's own sentence about the lapse, dated, with the renewal link. Relay it verbatim:
   * it is the same copy the CLI doctor row, the MCP notice, and the tier refusals use, so every
   * surface tells the operator one story. Present only when `maxExpired`.
   */
  maxExpiredNotice?: string
  /** Where to renew. Present only when `maxExpired`. */
  renewalUrl?: string
  /** The account's resolved platform fee, in bps, on API-built value-moving transactions. */
  feeBps: number
  feeTotals: Array<{ chain: Chain; quoteAsset: string; feeRawSum: string; count: number }>
  /** The live tier's cap floors. Absent from an older server. */
  tierCaps?: { rateLimitPerMin: number; dailyLaunchCap: number; uploadsPerMin: number; linkedWallets: number }
  /** When the tier was evaluated (ms), so a caller can say how fresh it is. Absent from an older server. */
  checkedAt?: number
  /** Max's price. Kept beside `planTable` for compatibility; read `planTable` for every plan. */
  maxPricing?: PlanPrice
  /** Pro's price, null while Pro is not sold. Absent from a server before the plan table. */
  proPricing?: PlanPrice | null
  /** The plan table in force, the same one `getPlans()` returns. Absent from an older server. */
  planTable?: PlanTable
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
 * What a linked wallet can do, decided by the server (BE-860): `tee`, a TEE wallet bound to one
 * key; `imported`, a spend-capable wallet from the import flow; `linked`, attribution-only, which
 * cannot sign. Not `SelfWallet.kind`, whose `linked` covers both of the last two.
 */
export type WalletKind = "tee" | "imported" | "linked"

/**
 * One row of `GET /api/v1/agent/wallets`'s `page` array. The server returns the whole linkedWallets
 * row, so a page also carries fields this type does not name (`userAddress`, `addressLower`,
 * `verifiedAt` and others); the type names the ones a caller acts on. Branch on `walletKind` for
 * what a row can do. `revokedAt` set means the row is a tombstone -- `listWallets()` excludes these
 * by default; pass `includeRevoked: true` to see them.
 */
export interface LinkedWalletRow {
  _id: string
  chain: WalletChain
  address: string
  /** The wallet's Privy id: what `selfLaunch()`, `trade()` and `launchAtomic()` sign a linked leg with. */
  privyWalletId: string
  label?: string
  privyPolicyId?: string
  signerQuorumId?: string
  revokedAt?: number
  addedVia: "agent" | "session"
  /**
   * What this wallet can do: `tee`, `imported` (spend-capable) or `linked` (attribution-only).
   * Stable; derived by the server. Absent only from an API that predates it (before 2026-10), where
   * `privyPolicyId` present meant spend-capable and its absence attribution-only.
   */
  walletKind?: WalletKind
  /**
   * Served, but its values are internal code names and not promised (today `"ember-tee"`, or the
   * legacy `"ember-hot"`, on a TEE wallet; absent on every other row). Use `walletKind`.
   */
  profile?: "ember-tee" | "ember-hot"
  /**
   * TEE wallets only: whether the account owner has allowed this wallet to pay for a launch.
   * Absent reads as false. Only the owner can change it (`PUT /api/v1/agent/wallets/:id/capabilities`
   * with a device token or session; the CLI's `candle wallets allow-launch`).
   */
  allowLaunch?: boolean
}

/** GET /api/v1/agent/wallets response: one page of the account's linked wallets. */
export interface ListWalletsResult {
  success: true
  page: LinkedWalletRow[]
  isDone: boolean
  continueCursor: string | null
}

/**
 * Whether an agent profile spends from every wallet on its account, or only the ones assigned
 * to it.
 *
 * A profile with no explicit scope reads as `"all"` -- that is what every key issued before
 * profiles existed does, and the API resolves the default server-side so a client never has to
 * infer it.
 */
export type ProfileWalletScope = "all" | "selected"

/** One wallet assigned to a profile, as `GET /api/v1/agent/keys/{prefix}/wallets` reports it. */
export interface ProfileWalletRow {
  linkedWalletId: string
  assignedAt: number
  chain: WalletChain
  address: string
  label?: string
  /**
   * False for an attribution-only wallet. Such a wallet can be assigned, but it can never sign,
   * so a trade naming it as payer fails regardless of the assignment.
   */
  spendCapable: boolean
}

/** One position a profile still holds, for the caller to mark against a current price. */
export interface ProfileOpenPosition {
  /** Additive transfer provenance; omitted by an older server or for a position bought by trade. */
  transferredIn?: boolean
  basisSource?:
    | "candle-wallet"
    | "chain"
    | "transfer-price"
    | "before-window"
    | "unknown"
    | "pending"
    | "mixed"
    | "zero-cost"
  basisComplete?: boolean
  movedInFromWallet?: string
  basisCoveragePct?: number
  /** Moved-in quantity carried at $0, no purchase found (Solana CNDL). Absent with none or on an older server. */
  zeroCostQuantity?: number

  mint: string
  quantity: number
  avgEntryUsd: number
  costBasisUsd: number
  /** The price used to value this position. Absent when no mark was available for the token. */
  markPriceUsd?: number
  /** When that price was last refreshed. */
  markedAt?: number
  marketValueUsd?: number
  /** `marketValueUsd - costBasisUsd`. Absent when unmarked — which is not the same as zero. */
  unrealizedUsd?: number
  /** The chain this position was traded on. Optional: a server that predates it omits it. */
  chain?: Chain
  /**
   * The wallet holding it: positions live in wallets, so one token held in two wallets is two
   * positions. `unknown:solana` or `unknown:hood` names the pool for fills no record places in a
   * wallet, which is not an address. Optional: a server that predates 2026-10-02 omits it.
   */
  wallet?: string
  /**
   * The key this position belongs to, by prefix: the wallet's bound key, else the key whose buy
   * opened it; null for Manual (web-app trades). Optional: a server that predates 2026-10-02 omits it.
   */
  agent?: string | null
  /** When the round behind this position opened, epoch ms. Optional, as `wallet`. */
  openedTs?: number
  /** Why there is no mark. Present exactly when `markPriceUsd` is absent, on a server that sends it. */
  unpricedReason?: "no-market-row" | "unusable-price"
  /**
   * Worth under one cent at its mark. Still listed and still counted; `openPositionsExDust` leaves it
   * out. An unpriced position is never dust. Optional: a server that predates 2026-10-02 omits it.
   */
  dust?: true
}

/** One fully closed private position, with optional recorded-arrival provenance. */
export interface ProfileClosedPosition
  extends Pick<
    ProfileOpenPosition,
    | "mint"
    | "wallet"
    | "agent"
    | "transferredIn"
    | "basisSource"
    | "basisComplete"
    | "movedInFromWallet"
    | "basisCoveragePct"
    | "zeroCostQuantity"
  > {
  openedTs: number
  closedTs: number
  quantity: number
  transferredInQuantity?: number
  soldQuantity: number
  costBasisUsd: number
  proceedsUsd: number
  realizedNetUsd: number
}

/**
 * Closed positions as one equation (P&L spec PNL-ED-8): `madeUsd + lostUsd + partialSellsUsd`
 * equals the scope's `realizedNetUsd`. A position is closed when its wallet's quantity returns to
 * zero through a sale.
 */
export interface ProfileClosedSummary {
  /** Closed positions, those with unknown cost included. */
  closed: number
  /** Sum of the closed positions that made money, USD. */
  madeUsd: number
  /** Sum of the closed positions that lost money, USD: zero or negative. */
  lostUsd: number
  /**
   * The rest of the realized net: partial sells of positions still open, and fees not in a closed
   * position (a buy fee on an open position, a sell with nothing open).
   */
  partialSellsUsd: number
  /** Closed positions won and lost, leaving out those with unknown cost. */
  wins: number
  losses: number
  /** Closed positions with unknown cost: listed in `closed`, left out of `wins` and `losses`. */
  costUnknown: number
}

/**
 * Fields every scope of `ProfilePnlResult` gained on 2026-10-02 (the total, each `byChain` entry
 * and each `byWallet` row). Each is optional: a server that predates it omits it.
 */
export interface ProfilePnlEngineFields {
  /** Public moved-in realized share, already included in realizedNetUsd and ranking. */
  realizedFromTransfersUsd?: number
  /** Public moved-in unrealized share, already included in unrealizedUsd and total P&L. */
  unrealizedFromTransfersUsd?: number
  /** Realized net plus unrealized: the figure the console labels P&L, to the cent. */
  totalUsd?: number
  /** Open positions that are not dust. */
  openPositionsExDust?: number
  /** Closed positions this scope's sales closed. */
  closedRounds?: number
  /** Money made, minus money lost, plus partial sells, equals `realizedNetUsd`. */
  closed?: ProfileClosedSummary
}

/**
 * One chain's share of a profile's P&L (`ProfilePnlResult.pnl.byChain`): the total's figures over
 * that chain's fills alone. `openPositions` is a COUNT here; the positions themselves are in
 * `pnl.openPositions`, each carrying its `chain`.
 */
export interface ProfileChainPnl extends ProfilePnlEngineFields {
  realizedGrossUsd: number
  feesUsd: number
  realizedNetUsd: number
  /** Open positions on this chain. */
  openPositions: number
  unrealizedUsd: number
  unmarkedPositions: number
  oldestMarkAt?: number
  counted: number
  unvalued: number
  /** Fills held out because their token has a fill of unknown size. Part of `unvalued`. */
  unresolved: number
  unresolvedMints: string[]
  friction: {
    feesUsd: number
    slippageUsd: number
    slippageBpsAvg?: number
    measured: number
    unmeasured: number
  }
  /** This key's ledger fills on this chain in the window. */
  tradesConsidered: number
}

/**
 * `GET /api/v1/agent/keys/{prefix}/pnl` response.
 *
 * Realized AND marked. Each open position carries Candle's current mark where one exists
 * (`markPriceUsd`, `marketValueUsd`, `unrealizedUsd`), and `pnl.unrealizedUsd` sums the positions
 * that could be marked. A position with no price is counted in `unmarkedPositions` rather than
 * valued at zero, and `oldestMarkAt` says how old the marks are, so a stale figure is visible.
 * Deposits and withdrawals are excluded entirely: funding a wallet is not trading profit.
 *
 * Since 2026-10-02 (P&L spec R2) the figures are this key's share of the account's one P&L read,
 * the read the console, the dashboard, `/books` and `/keys/pnl` share, so they agree with the
 * console to the cent for the same moment:
 * - realized and fees are on the fills this key placed; an open position belongs to the wallet's
 *   bound key, else to the key whose buy opened it; a closed position to the key whose sale closed it;
 * - each wallet is its own average-cost pool, and the total is the sum of `byWallet`
 *   (it used to pool every wallet of the key);
 * - a recorded move between two of the account's wallets carries its cost and realizes nothing;
 *   tokens that arrive with no cost anyone can state realize nothing when sold;
 * - `openPositions` counts one per wallet and token, dust included;
 * - `tradesConsidered` counts this key's ledger fills, and `lookback` / `truncated` are the
 *   account's activity bound, not 500 of this key's trades.
 * Every account's realized figure can move on the day a server ships this.
 */
export interface ProfilePnlResult {
  /** Optional while Hyperliquid is enabled; separate from spot totals. */
  hyperliquid?: HyperliquidPnlSection
  success: true
  keyPrefix: string
  pnl: ProfilePnlEngineFields & {
    realizedGrossUsd: number
    /** Candle fees over the counted fills. Reported separately, netted only into realizedNetUsd. */
    feesUsd: number
    realizedNetUsd: number
    closedPositions?: ProfileClosedPosition[]
    openPositions: ProfileOpenPosition[]
    /**
     * Unrealized across the positions that could be marked. Read it WITH `unmarkedPositions` and
     * `oldestMarkAt`: a total is only as meaningful as its coverage and the age of the prices
     * behind it.
     */
    unrealizedUsd: number
    /** Positions with no price available, excluded from `unrealizedUsd` rather than valued at zero. */
    unmarkedPositions: number
    /** The oldest mark used, epoch ms. Absent when nothing could be marked. */
    oldestMarkAt?: number
    /** Fills counted, and fills that had no trusted USD price and so were left out entirely. */
    counted: number
    unvalued: number
    /** Fills held out because their token has a fill of unknown size. Part of `unvalued`. Optional. */
    unresolved?: number
    /** The tokens those fills belong to: their P&L is unknown, not zero. Optional. */
    unresolvedMints?: string[]
    /** Fees and measured slippage, reported and never netted a second time. Optional. */
    friction?: {
      feesUsd: number
      slippageUsd: number
      slippageBpsAvg?: number
      measured: number
      unmeasured: number
    }
    /** This key's ledger fills in the window. */
    tradesConsidered: number
    /** The account's activity bound, shared by every private P&L read (it was 500 of this key's trades). */
    lookback: number
    /** True when the lookback window was full, so this is not a lifetime figure. */
    truncated: boolean
    /**
     * The same figures divided by wallet, ordered by `tradesConsidered` then address. Optional: a
     * server that predates it omits it.
     *
     * Each wallet is its own average-cost pool, and the total above is the sum of its wallets: A
     * buying 100 X for $100, B buying 100 X for $200 and A selling 100 X for $300 realizes $200.
     * (Before 2026-10-02 the total pooled every wallet and realized $150 here.) A token moved
     * between two of the account's wallets carries its cost once the move is recorded; until then
     * the buyer still holds it and the seller's sale realizes nothing.
     */
    byWallet?: ProfileWalletPnl[]
    /**
     * The same figures split by chain, both chains always present. A token lives on one chain, so
     * the two sum to the total above. Optional: a server that predates it omits it.
     */
    byChain?: Record<Chain, ProfileChainPnl>
  }
}

/**
 * One row of `ProfilePnlResult.pnl.byWallet`: one wallet's share of a profile's P&L. A wallet two
 * keys trade carries this key's share only.
 */
export interface ProfileWalletPnl extends ProfilePnlEngineFields {
  /**
   * The wallet's address as stored: base58, or EIP-55 on Hood. `unknown:solana` or `unknown:hood`
   * is the pool for fills no record places in a wallet: a row, not an address.
   */
  wallet: string
  payerType: "main" | "linked"
  /**
   * The chain this wallet paid on, from its trades: an address belongs to one chain. Optional: a
   * server that predates it omits it.
   */
  chain?: Chain
  /** Present only for a linked wallet. */
  linkedWalletId?: string
  /** The linked wallet's own label; null for the main wallet or an unlabelled one. */
  label: string | null
  realizedGrossUsd: number
  feesUsd: number
  realizedNetUsd: number
  openPositions: ProfileOpenPosition[]
  unrealizedUsd: number
  unmarkedPositions: number
  oldestMarkAt?: number
  /** Fills counted, and fills left out of every USD figure (includes `unresolved`). */
  counted: number
  unvalued: number
  /** Fills held out because their token has a fill of unknown size. Part of `unvalued`. */
  unresolved: number
  /** The tokens those fills belong to: their P&L is unknown, not zero. */
  unresolvedMints: string[]
  /** Fees and measured slippage over this wallet's fills, reported and never netted a second time. */
  friction: {
    feesUsd: number
    slippageUsd: number
    slippageBpsAvg?: number
    measured: number
    unmeasured: number
  }
  /** This key's ledger fills in the window from this wallet. */
  tradesConsidered: number
}

/**
 * Why a Hood asset in `PortfolioResult.prices` has no price. Never rendered as zero.
 *
 * - `no-market-row`: Candle has never marked this token.
 * - `unusable-price`: a mark exists and is not a price (zero, negative, not finite).
 * - `stale-mark`: the mark is older than six hours.
 * - `source-unavailable`: the price source did not answer.
 */
export type PortfolioUnpricedReason = "no-market-row" | "unusable-price" | "stale-mark" | "source-unavailable"

/**
 * One entry of `PortfolioResult.prices`. An unpriced entry is `priceUsd: null`, never 0: "worth
 * nothing" and "nobody priced it" are different answers.
 */
export interface PortfolioPrice {
  priceUsd: number | null
  /**
   * `market` is Candle's own mark, the price P&L marks with; `jupiter` covers Solana tokens Candle
   * does not index; `reference` is a Hood base asset (ETH from Hood's WETH/USDG pools, USDG at its
   * peg).
   */
  source: "market" | "jupiter" | "reference" | null
  /** When a `market` price was last refreshed, epoch ms. Kept on a stale Hood mark too. */
  updatedAt?: number
  symbol?: string
  name?: string
  /** Why a Hood entry has no price. Set on Hood entries only. */
  unpricedReason?: PortfolioUnpricedReason
}

/** One SPL token a Solana wallet holds, summed over its accounts under one token program. */
export interface PortfolioSolanaToken {
  /** Optional: a server that predates Hood in the portfolio omits it. */
  chain?: "solana"
  mint: string
  /** Raw base units as a string. */
  amountRaw: string
  decimals: number
  program: "token" | "token-2022"
}

/** A Solana wallet's balances. A failed half is null, never zero, and the address is in `unavailable`. */
export interface PortfolioSolanaWallet {
  /** Optional: a server that predates Hood in the portfolio omits it. */
  chain?: "solana"
  address: string
  /** Lamports as a string (a u64 does not survive `Number`); null when the SOL read failed. */
  lamports: string | null
  /** Non-zero token balances; null when the token read failed. */
  tokens: PortfolioSolanaToken[] | null
}

/** A TEE wallet: its linked-wallet id, label, and whether its remote authority is verified-active. */
export interface PortfolioSolanaTeeWallet extends PortfolioSolanaWallet {
  id: string
  label?: string
  active: boolean
}

/** One ERC-20 a Hood wallet holds. */
export interface PortfolioHoodToken {
  chain: "hood"
  /** The token contract, EIP-55. Price it under `hood:<mint lowercased>`. */
  mint: string
  /** Raw base units as a string. */
  amountRaw: string
  decimals: number
  symbol?: string
  name?: string
}

/** A Hood wallet's balances. A failed read is null, never zero, and the address is in `hood.unavailable`. */
export interface PortfolioHoodWallet {
  chain: "hood"
  address: string
  /** Native ETH in wei, as a string; null when the read failed. */
  wei: string | null
  /** Non-zero ERC-20 balances, USDG among them; null when the read failed. */
  tokens: PortfolioHoodToken[] | null
  /** Present when the wallet holds more tokens than Candle lists (200). */
  truncated?: true
}

/** A Hood TEE wallet: its linked-wallet id, label, and whether its remote authority is verified-active. */
export interface PortfolioHoodTeeWallet extends PortfolioHoodWallet {
  id: string
  label?: string
  active: boolean
}

/** `PortfolioResult.hood`: the account's Hood wallet and its Hood TEE wallets. */
export interface PortfolioHoodSection {
  /** The account's own Hood wallet, when it has one. */
  embedded: PortfolioHoodWallet[]
  tee: PortfolioHoodTeeWallet[]
  /** Hood addresses whose read failed. */
  unavailable: string[]
  /** Hood holdings with no price: ETH where held, and every token. */
  unpriced: number
  /** The same count, by why. */
  unpricedByReason: Partial<Record<PortfolioUnpricedReason, number>>
}

/**
 * `GET /api/v1/agent/portfolio` response: what the account holds in the wallets Candle already
 * knows, on both chains, with prices.
 *
 * Solana wallets are in `embedded` and `tee`; Hood wallets are in `hood`, never in those two
 * arrays. Vault and external wallets are not here: Candle does not know their addresses, and the
 * CLI reads them over the operator's own RPC.
 *
 * `prices` keys a Solana mint by its address, Hood native ETH as `hood:native`, and a Hood token
 * as `hood:<lowercased contract>`, so lowercase a Hood `mint` before the lookup. Read `complete`
 * before quoting a total: it is false when the wallet list was cut off, any wallet's read failed
 * on either chain, or an LP position could not be read. `walletsComplete` is the list on its own.
 * Absent on a server that predates it, in which case `complete: false` may be either cause.
 *
 * Not typed here: the `lp` section a deployment with LP enabled adds.
 */
export interface PortfolioResult {
  success: true
  embedded: PortfolioSolanaWallet[]
  tee: PortfolioSolanaTeeWallet[]
  /** Optional: a server that predates Hood in the portfolio omits it. */
  hood?: PortfolioHoodSection
  prices: Record<string, PortfolioPrice>
  /** Solana addresses whose read failed. Hood's are in `hood.unavailable`. */
  unavailable: string[]
  complete: boolean
  /**
   * Whether every wallet Candle knows was listed. False only when that list was cut off.
   * Independent of `complete`. Absent on a server that predates the field.
   */
  walletsComplete?: boolean
}

/**
 * One row of a profile's trade history: what was ordered, what actually filled, what it cost,
 * and the hash to verify it against a chain explorer.
 *
 * `filledAmount` and `usdValue` are absent for a trade that never confirmed, and `usdValue` is
 * also absent when the quote asset had no trusted USD price — absence means "not known", never
 * zero.
 */
export interface ProfileTradeRow {
  clientTradeId: string
  createdAt: number
  status: "built" | "confirmed" | "failed"
  chain: "solana" | "hood"
  side: "buy" | "sell"
  mint: string
  quoteAsset: string
  /** What was asked for, raw base units. */
  amountRaw: string
  /** What actually filled, in base tokens. */
  filledAmount?: number
  usdValue?: number
  feeBps: number
  /**
   * An estimate from the trade's size and rate, scaled by collected over planned fee. 0 when no fee
   * was collected, including when the plan forgoes it.
   */
  feeUsd?: number
  /**
   * The fee the build planned, in raw units of `quoteAsset`: every venue pays its fee in the quote
   * asset. Absent on a server before 2026-10-05.
   */
  feeRaw?: string
  /**
   * What the treasury received, in raw units of `quoteAsset`. Confirmed rows only. Equal to
   * `feeRaw` unless it was measured otherwise.
   */
  feeCollectedRaw?: string
  /**
   * True for a `built` row that holds a signature: the trade is on chain but was not booked.
   * `errorCode` says why. Absent on a server before 2026-10-05.
   */
  landedUnconfirmed?: boolean
  payerWallet: string
  venue?: "curve" | "jupiter" | "dex"
  signature?: string
  errorCode?: string
}

/** `GET /api/v1/agent/keys/{prefix}/trades` response. */
export interface ProfileTradesResult {
  success: true
  keyPrefix: string
  trades: ProfileTradeRow[]
  /**
   * Pass back as `cursor` for the next, older page. Present whenever the page read a full `limit`,
   * so a short or even empty page can still have one: only its absence means the end.
   */
  nextCursor?: string
}

/** Options for `getProfileTrades`. */
export interface ProfileTradesOptions {
  /** Rows to read, 1 to 1,000. Default 200. */
  limit?: number
  /** Inclusive lower bound on `createdAt`: an ISO 8601 string, epoch milliseconds, or a `Date`. */
  since?: string | number | Date
  /** Exclusive upper bound on `createdAt`, in the same forms as `since`. */
  until?: string | number | Date
  /** A previous page's `nextCursor`, verbatim. */
  cursor?: string
}

function historyTime(value: string | number | Date): string {
  return value instanceof Date ? String(value.getTime()) : String(value)
}

/** `GET /api/v1/agent/keys/{prefix}/wallets` response. */
export interface ProfileWalletsResult {
  keyPrefix: string
  /** The profile's stable public id, or null for a key minted before profile ids existed. */
  profileId: string | null
  walletScope: ProfileWalletScope
  /**
   * The assigned wallets. Under scope `"all"` this list does NOT bound what the profile can
   * spend from -- it can use every wallet on the account regardless of what appears here.
   */
  wallets: ProfileWalletRow[]
}

// ---------------------------------------------------------------------------
// Agent trade API (docs/agent-trading.md): POST /api/v1/trade/agent/{build,confirm}
// ---------------------------------------------------------------------------

export type TradeSide = "buy" | "sell"

/** Who pays for a trade: the account's own delegated wallet ("main"), or an imported linked wallet. */
export type TradePayer = { type: "main" } | { type: "linked"; linkedWalletId: string }

/**
 * The Jupiter/DFlow race one Solana `jupiter`-venue build ran. Raw amounts and lamports are decimal
 * strings. Present only while DFlow is enabled on the deployment, and never on paper or a replay.
 */
export interface TradeRace {
  jupiterOutRaw: string
  /** DFlow's quoted output, when it gave an accepted quote. */
  dflowOutRaw?: string
  /**
   * Why DFlow did not build the transaction: `quote:<reason>`, `build:<reason>` (including
   * `build:priority_fee_over_cap`), or `net:fee_exceeds_edge` when its larger output did not
   * cover its larger priority fee.
   */
  dflowRefusal?: string
  /** The priority-fee ceiling both builds were given, in lamports. Absent from an older server. */
  priorityFeeCapLamports?: string
  /** The priority fee decoded from Jupiter's built transaction. Absent when Jupiter built none. */
  jupiterPriorityFeeLamports?: string
  /** The priority fee decoded from DFlow's built transaction. Absent when DFlow returned none. */
  dflowPriorityFeeLamports?: string
}

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
   * The most this build may bid as a Solana priority fee, in lamports: an integer from 0 to
   * 10,000,000. Replaces the default ceiling of 25 bps of the trade's SOL leg (floored at 100,000,
   * capped at 10,000,000), so it can raise the ceiling for a small trade that has to land as well
   * as lower it. `0` asks for no priority fee, and is not the same as omitting the field.
   *
   * Applies to Solana `jupiter`-venue builds and is ignored everywhere else (Hood, the curve
   * venue, paper). A hard limit on DFlow; a requested limit on Jupiter, whose paid figure is
   * `race.jupiterPriorityFeeLamports` when the response carries `race`. A very low value may not
   * land before its blockhash expires.
   */
  maxPriorityFeeLamports?: number
  /**
   * What the wallet spends on a buy, or receives on a sell. Safe to pass straight through from a
   * `POST /trade/agent/quote` response: the two endpoints take the same ids.
   *
   * Solana (`sol` | `usdc` | `cndl`): applies only when trading a non-Candle-launched token
   * (Pro/Max), and is ignored for a Candle token whose curve pair is fixed. A Hood id on a
   * Solana mint is refused.
   *
   * Hood (`eth` | `usdg`): the settlement asset of a DEX trade. **A USDG buy spends an ERC-20,
   * so the build carries an `approval` leg that an ETH buy does not** -- one extra transaction
   * for a main payer, one extra artifact to sign for a linked one.
   *
   * This is not the route. The cheapest path to the asset is raced independently, so a fill can
   * report `amounts.quoteAsset: "eth"` alongside `route.kind: "usdg"`. Both are true.
   *
   * Requires a server carrying the widened validator; older hosts accept only the Solana ids.
   * The server defaults it when omitted, which is `sol` on Solana and ETH settlement on Hood.
   */
  quoteAsset?: "sol" | "usdc" | "cndl" | "eth" | "usdg"
}

/**
 * The platform fee actually itemized on this trade.
 *
 * WHICH SIDE IT COMES FROM, because it is not symmetric and cost-basis math depends on it.
 * The fee is always denominated in the QUOTE asset, on both chains and both sides. What differs
 * is the amount it is charged on:
 *
 * - **Buy**: charged on what you SPEND. `feeRaw = amountRaw * bps / 10000`, and it is an
 *   ADDITIONAL transfer -- the full `amountRaw` still enters the swap. So the wallet parts with
 *   `amountRaw + feeRaw`, and `expectedOutRaw`/`minOutRaw` (the token you receive) are
 *   unaffected by the fee entirely.
 * - **Sell**: charged on what you RECEIVE. `feeRaw = expectedOutRaw * bps / 10000`, drawn from
 *   the swap's own output in the same transaction. So `expectedOutRaw` and `minOutRaw` are
 *   **gross**, and the wallet nets `expectedOutRaw - feeRaw`.
 *
 * A caller computing realised PnL therefore subtracts the fee on a buy from the cost side, and
 * on a sell from the proceeds -- never from the token amount on either.
 *
 * `treasury` is null only when the fee is disabled server-side (unset AGENT_FEE_TREASURY_*), in
 * which case `feeRaw` is "0" and `bps` is 0; the pair is never a nonzero rate with a zero amount.
 */
export interface TradeFee {
  bps: number
  /** Base units of the QUOTE asset. Never the token being traded, on either side. */
  feeRaw: string
  treasury: string | null
}

/** Solana "built" artifacts: one unsigned transaction, the fee (if any) already embedded inside it. */
export interface SolanaTradeArtifacts {
  venue: "curve" | "jupiter"
  /**
   * Which quoter built the transaction. On the `jupiter` venue Candle also asks DFlow for a quote and
   * uses it only when its output is strictly larger: net of each venue's priority fee when a leg is
   * SOL, raw otherwise. Otherwise this is `jupiter`. `curve` on the curve venue.
   */
  quoteSource?: "curve" | "jupiter" | "dflow"
  /**
   * The Jupiter/DFlow race on a `jupiter` venue build: Jupiter's quoted output, DFlow's when it gave an
   * accepted quote, and why DFlow did not build the transaction when it did not. Absent on the curve venue.
   */
  race?: TradeRace
  transactionBase64: string
  quoteAsset: string
  quoteMint: string
  quoteDecimals: number
}

/** One leg of a route: which venue, which pair, and how much of the order went through it. */
export interface TradeRouteHop {
  exchange: string
  tokenIn: string
  tokenOut: string
  sharePct: number
  pool?: string
  /** The pool's STATIC fee tier. A v4 hook can charge on top of it; see `roundTripBps`. */
  fee?: number
}

/**
 * The path a fill actually took, mirroring the API's `TradeRoute`.
 *
 * Read this to verify a receipt: `hops` and `kind` say which routers and pools the transaction
 * should touch. Do NOT read it for cost basis -- `amounts.quoteAsset` is what the wallet paid,
 * and the two differ routinely (a trade settled in ETH can cross USDG, giving
 * `kind: "usdg"`).
 *
 * `priceImpactBps` is a depth statistic, not a cost: it compares two sizes on the same route, so
 * a proportional fee cancels out of it entirely.
 */
export interface TradeRoute {
  source: "kyber" | "uniswap"
  hops: TradeRouteHop[]
  /** `weth`, `usdg`, `usdg-direct`, `usdg-hop`, `v4`, `bridged-v4`, `v2`. Absent on some aggregator routes, which let `hops` speak. */
  kind?: string
  priceImpactBps?: number
  usd?: { in?: number; out?: number; gas?: number }
  hinted?: boolean
  surplusToVendor?: boolean
}

/**
 * Hood "built" artifacts: up to four calldata legs. Send order matters and is fixed: `approval`
 * (present only when the payer's existing ERC-20 allowance is insufficient), then
 * `permit2Approval` (present only when the Universal Router pulls the input through Permit2),
 * then `trade`, then `feeTransfer` (present only when a fee applies). Hood cannot batch calls the
 * way one Solana transaction can carry multiple instructions, so each leg is its own transaction.
 */
export interface HoodTradeArtifacts {
  /** `"dex"` since the server grew the Uniswap venue; `"curve"` for a live bonding curve. */
  venue: "curve" | "dex"
  trade: { to: string; data: string; value: string }
  approval?: { to: string; data: string }
  /**
   * Permit2 allowance leg, on v4 sells and on any trade whose input is an ERC-20 the Universal
   * Router pulls through Permit2. Sign it in the documented order, after `approval`.
   */
  permit2Approval?: { to: string; data: string }
  feeTransfer?: { to: string; data: string; value: string }
  quoteAsset: string
  quoteDecimals: number
  /** The route this build was planned against. Present on the DEX venue. */
  route?: TradeRoute
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
      /** The linked payer's own base58 address: the wallet that must sign this build. */
      walletAddress: string
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
  amounts: {
    amountRaw: string
    expectedOutRaw: string
    minOutRaw: string
    quoteAsset: string
    /**
     * What the trade ACTUALLY delivered, in the output asset's raw units.
     *
     * `expectedOutRaw` beside it is the quote taken at BUILD time -- what you agreed to, not what
     * arrived. The difference between them is your realised slippage, and it is the number a
     * position ledger needs: without this you had to re-read the transaction the server had
     * already read to confirm it.
     *
     * Present on SOLANA confirmations, where the server derives the payer's own balance delta
     * for the mint as the gate that proves the trade happened and moved the right way, so the
     * figure is decoded truth rather than an estimate. Absent on Hood, whose confirm verifies a
     * fee receipt and decodes no balance delta -- absent rather than a guess or a zero, so
     * `"actualOutRaw" in result.amounts` is a truthful test.
     */
    actualOutRaw?: string
  }
  /**
   * The route the fill actually took, on a Hood DEX trade.
   *
   * A main payer never sees `artifacts`, so without this a typed client could not tell which
   * router or pools its own executed trade went through, and had to re-read the transaction the
   * server had already read. Present on the executed response since 2026-09-04.
   */
  route?: TradeRoute
  /**
   * Solana `jupiter` venue only: which quoter built the transaction that executed (`jupiter` or `dflow`),
   * and the Jupiter/DFlow race behind it. Absent on the curve venue, on Hood, and on an idempotent replay.
   */
  quoteSource?: "jupiter" | "dflow"
  race?: TradeRace
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
 * one for Solana; one to four for Hood in the fixed approval, permit2Approval, trade, feeTransfer
 * order (omitting a leg that was not built). The server broadcasts them itself and confirms
 * inline, so there is no separate confirmTrade() call after this one.
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

/**
 * `swapFromLinked()` request: SOL on the linked wallet into ETH/USDG on Hood.
 *
 * A TEE payer (Ember Phase 4c) may also start from USDC, and needs `clientTradeId`: the server
 * then resolves the destination to this key's own TEE wallet on Hood (`toWalletId` names one when
 * the key has several), requires a raw cap on the origin asset, and charges no fee. That bridge is
 * gated by the server's `TEE_BRIDGE_ENABLED`; with it off the build answers `PAIR_UNSUPPORTED`.
 * A Hood-origin bridge signs one leg at a time and is not this call; `candle swap` runs it.
 */
export interface LinkedSwapRequest {
  from: "SOL" | "USDC"
  to: "ETH" | "USDG"
  /** Raw base units of `from` (lamports for SOL), as a decimal string. */
  amountRaw: string
  /** The linked Solana wallet funding the swap. */
  payer: { linkedWalletId: string; privyWalletId: string }
  /**
   * The account's OWN linked EVM wallet to receive the output; omitted = the owner's embedded Hood
   * wallet. For a TEE payer: this key's TEE wallet on Hood, omitted when it has exactly one.
   */
  toWalletId?: string
  maxSlippageBps?: number
  /**
   * Required for a TEE payer's bridge, and sent on both calls: the durable idempotency key, and the
   * id `GET /api/v1/agent/swap/jobs/{clientTradeId}` reads the bridge's settlement and open state by.
   */
  clientTradeId?: string
}

/** `swapFromLinked()` result. `hashes` is the Solana deposit; poll `statusChecks` for the fill. */
export interface LinkedSwapResult {
  hashes: string[]
  expectedOutRaw: string
  outDecimals: number
  statusChecks: string[]
  recipient: string
  /**
   * What the swap settled, measured from chain (see `SwapSettlement`). Absent on an older API,
   * which means "not measured". A cross-chain swap stays `pending` until the destination fill is
   * observed. This call sends no `clientTradeId`, so it has no job to re-read: poll
   * `statusChecks` for the fill.
   */
  settlement?: SwapSettlement
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

// -- Hyperliquid perps (spec 2026-10-01-hyperliquid-perps-tee-design.md) ---------------------

/** The EVM TEE wallet a perps action signs from: its row id and its Privy wallet id. */
export interface PerpsWalletRef {
  /** The linked wallet's row id (the relay's :id, and the secretStore key). */
  walletId: string
  /** The same wallet's Privy wallet id, the authorization signature's URL target. */
  privyWalletId: string
  /** Sign and submit (default), or stop after the build and its check and return the build. */
  submit?: boolean
}

export type PerpsSide = "long" | "short"

export interface PerpsOpenParams extends PerpsWalletRef {
  coin: string
  side: PerpsSide
  /** Size in the coin, a decimal string. */
  size: string
  /** `market` (IOC at the mid moved by the slippage) or `limit`. Default: limit when `price` is set. */
  type?: "market" | "limit"
  price?: string
  tif?: "Gtc" | "Alo" | "Ioc"
  slippageBps?: number
  /** Optional reduce-only take-profit trigger price. */
  takeProfit?: string
  /** Optional reduce-only stop-loss trigger price. */
  stopLoss?: string
}

export interface PerpsCloseParams extends PerpsWalletRef {
  coin: string
  /** Part of the position to close; the whole position when omitted. */
  size?: string
  slippageBps?: number
}

export interface PerpsCancelParams extends PerpsWalletRef {
  /** The cloid of an order Candle built (an open, or one of its take-profit / stop-loss legs). */
  cloid: string
}

export interface PerpsModifyParams extends PerpsWalletRef {
  cloid: string
  price?: string
  size?: string
  slippageBps?: number
}

export interface PerpsLeverageParams extends PerpsWalletRef {
  coin: string
  leverage: number
  mode?: "cross" | "isolated"
}

export interface PerpsMarginParams extends PerpsWalletRef {
  coin: string
  /** USD, up to 6 decimals; negative removes isolated margin. */
  amount: string
}

/** What a perps build route returns: the plaintext action, its nonce, and the stamped typed data. */
export interface PerpsBuild {
  success: true
  perpOrderId: string
  kind: "open" | "close" | "modify" | "cancel" | "leverage" | "margin" | "setup"
  network: HyperliquidNetwork
  walletId: string
  address: string
  nonce: number
  action: Record<string, unknown>
  typedData: HyperliquidTypedData
  claimHash: string
  cloid?: string
  childCloids?: string[]
  targetCloid?: string
  notionalUsdMicros: number | null
  reservedUsdMicros: number
  windowKey: string | null
  builder: { address: string; feeTenthsBps: number } | null
  exchangeUrl: string
  preview: Record<string, unknown>
}

/**
 * The outcome of one perps action. `signature` is present once the relay signed; it stays valid
 * for resubmission until the nonce leaves Hyperliquid's two-day window, so a failed submit keeps
 * it. `exchange` is Hyperliquid's own answer, unchanged (`status: "ok"` or `"err"`, and per-order
 * statuses for an order).
 */
export interface PerpsActionResult {
  build: PerpsBuild
  signature: string | null
  submitted: boolean
  exchange: unknown | null
  submitError?: string
}

export interface PerpsAccountStatus {
  walletId: string
  address: string
  network: HyperliquidNetwork
  mode: string
  standardMode: boolean
  accountValue: string
  withdrawable: string
  builder: string
  approvedFeeTenthsBps: number
}

/** `ready: true` when the builder approval is already on Hyperliquid; otherwise the setup action's outcome. */
export type PerpsSetupResult = PerpsAccountStatus & { ready: boolean; action?: PerpsActionResult }

export interface PerpsConfig {
  success: true
  network: HyperliquidNetwork
  exchangeUrl: string
  builder: string | null
  builderFeeTenthsBps: number
  maxBuilderFeeRate: string
  allowedActionTypes: string[]
  limits: Record<string, unknown>
}

export interface PerpsPositions {
  success: true
  walletId: string
  address: string
  network: HyperliquidNetwork
  mode: string
  standardMode: boolean
  account: Record<string, string>
  withdrawable: string
  positions: Record<string, unknown>[]
}

export interface PerpsOrderRecord {
  perpOrderId: string
  kind: PerpsBuild["kind"]
  actionType: string
  coin: string | null
  nonce: number
  cloid: string | null
  childCloids: string[]
  targetCloid: string | null
  status: string
  venueStatus: string | null
  filledSz: string | null
  notionalUsdMicros: number | null
  reservedUsdMicros: number
  releasedUsdMicros: number
  windowKey: string | null
  builtAt: number
  settledAt: number | null
}

export interface PerpsOrders {
  success: true
  walletId: string
  address: string
  network: HyperliquidNetwork
  /** Hyperliquid's open orders for the wallet's address. */
  open: Record<string, unknown>[]
  /** Candle's record of every action it built for this wallet, newest first. */
  recorded: PerpsOrderRecord[]
  settled: { perpOrderId: string; status: string; releasedUsdMicros: number }[]
}

/**
 * Perps C (BE-647, HL-ED-8): `perpsDeposit()`. Relay moves funds from the key's Hood or Solana TEE
 * wallet onto Hyperliquid perps USDC at the key's EVM TEE wallet's own address. The asset decides
 * the paying chain: SOL or USDC from the Solana TEE wallet, ETH or USDG from the Hood one. Needs
 * `swap:write` and a raw cap on the asset. There is no withdrawal yet.
 */
export interface PerpsDepositParams {
  /** Idempotency id, 1 to 128 of `A-Za-z0-9._:-`. Rebuilding under the same id answers its job. */
  clientDepositId: string
  asset: "SOL" | "USDC" | "ETH" | "USDG"
  /** Raw base units of `asset`, as a decimal string. */
  amountRaw: string
  /** The paying TEE wallet's row id (the relay's :id, and the secretStore key). */
  walletId: string
  /** The paying wallet's Privy wallet id. */
  privyWalletId: string
  /** The Hyperliquid account: the EVM TEE wallet's address. The build is refused if it names another. */
  account: string
  /** From Solana only: the EVM TEE wallet whose Hyperliquid account receives. Omit from Hood. */
  perpsWalletId?: string
  /** Relay slippage, 1 to 1000 bps (default 100). */
  maxSlippageBps?: number
  /** Sign and submit (default), or stop after the build and its check. */
  submit?: boolean
}

/** What `POST /agent/perps/deposit` builds. A Hood build also carries the first sequenced leg. */
export interface PerpsDepositBuild {
  success: true
  status: "built"
  clientDepositId: string
  depositId: string
  chain: "solana" | "hood"
  venue: "relay"
  network: HyperliquidNetwork
  asset: PerpsDepositParams["asset"]
  amountRaw: string
  walletId: string
  walletAddress: string
  destination: { walletId: string; address: string; chainId: number; currency: string }
  firstDeposit: boolean
  expectedOutRaw: string
  minimumOutRaw: string
  outDecimals: number
  floorUsdcMicros: string
  minimumCreditUsdcMicros: string
  fee: { bps: number; feeRaw: string }
  statusChecks: string[]
  requestId: string | null
  expiresAt: number
  /** Solana: the one unsigned deposit. */
  transactionsBase64?: string[]
  /** Hood: the sequenced leg protocol's first body. */
  mode?: "sequenced"
  operationId?: string
  legKind?: string
  plannedLegCount?: number
  nextLeg?: {
    chainId: number
    nonce: number
    gas: string
    maxFeePerGas: string
    maxPriorityFeePerGas: string
    to: string
    data: string
    value: string
  }
}

export interface PerpsDepositResult {
  build: PerpsDepositBuild
  submitted: boolean
  /** `/perps/deposit/submit`'s final answer: `status: "submitted"` and the chain hashes. */
  result: Record<string, unknown> | null
}

/** Relay's chain and currency for Hyperliquid perps USDC. */
const HYPERLIQUID_RELAY_CHAIN_ID = 1337
const HYPERLIQUID_RELAY_USDC = "0x00000000000000000000000000000000"

/** Why a deposit build must not be signed, or null. */
export function perpsDepositProblem(build: PerpsDepositBuild, params: PerpsDepositParams): string | null {
  const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase()
  if (build.walletId !== params.walletId) return "the build names another paying wallet"
  if (build.asset !== params.asset || build.amountRaw !== params.amountRaw) return "the build is for another amount"
  if (build.destination?.chainId !== HYPERLIQUID_RELAY_CHAIN_ID) return "the build does not land on Hyperliquid"
  if (build.destination.currency !== HYPERLIQUID_RELAY_USDC) return "the build does not deliver Hyperliquid USDC"
  if (!same(build.destination.address, params.account)) return "the build lands on another account"
  if (build.fee?.bps !== 0 || build.fee.feeRaw !== "0") return "the build carries a Candle fee"
  const hood = params.asset === "ETH" || params.asset === "USDG"
  if (hood !== (build.chain === "hood")) return "the build pays from the wrong chain"
  if (hood && !same(build.walletAddress, params.account))
    return "a Hood deposit lands only on the paying wallet's own account"
  if (!hood && build.transactionsBase64?.length !== 1) return "the build is not one Solana deposit"
  return null
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
  /** Durable idempotency key. Same id + same body, including effective slippage, replays; a different body is refused. */
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
  /**
   * What the swap settled, measured from chain. Absent on an older API, which means "not
   * measured", never a zero. When `state` is `pending` or `uncertain`, or to re-read a `settled`
   * one later, call `wallets.swapReceipt(hash)` with any of `hashes`, on the same key.
   */
  settlement?: SwapSettlement
  /**
   * `false` when the server could not store the receipt: the swap landed, and
   * `wallets.swapReceipt(hash)` will 404 `RECEIPT_NOT_FOUND`. Absent on an older API.
   */
  receiptStored?: boolean
}

/** `SwapSettlement.state`. */
export type SwapSettlementState = "settled" | "pending" | "failed" | "uncertain"

/** One broadcast leg of a settled swap. */
export interface SwapSettlementLeg {
  chain: "solana" | "hood"
  hash: string
  status: "confirmed" | "failed" | "pending"
}

/**
 * What a base-asset swap settled, measured from chain rather than quoted. Carried by `swap()`'s
 * result, by `swapFromLinked()`'s result, and by `wallets.swapReceipt()`.
 *
 * - `settled`: every leg confirmed and the recipient's delta measured into `settledOutRaw`.
 * - `pending`: a leg is not yet observed, or a cross-chain swap has not filled on the destination.
 * - `failed`: a leg failed, or the bridge failed or refunded.
 * - `uncertain`: the legs landed but the delta could not be attributed. Reconcile from chain; the
 *   server never guesses the amount.
 *
 * A swap from `POST /agent/swap/submit` built with a `clientTradeId` is re-read with
 * `GET /api/v1/agent/swap/jobs/{clientTradeId}` (`job.settlement`), never the receipt route.
 */
export interface SwapSettlement {
  state: SwapSettlementState
  legs: SwapSettlementLeg[]
  /** What was sent. */
  in: { asset: string; raw: string }
  /** The build-time quote. */
  expectedOutRaw: string
  /** The recipient's measured delta of the out asset. Omitted, never zeroed, when not measured. */
  settledOutRaw?: string
  settledOutSource?: "tx_balance_delta" | "bridge_fill"
  /** The slot (Solana) or block (Hood) of the measurement. Present with `settledOutRaw`. */
  measuredAt?: { slot?: number; blockNumber?: number }
}

/** One balance of one wallet in `wallets.selfBalances()`. */
export interface SelfWalletBalance {
  /** Set for a base asset. */
  asset?: BaseAssetKey
  /** The mint or token contract. */
  mint: string
  amountRaw: string
  decimals?: number
  /** The Solana slot the balance was read at. */
  slot?: number
  /** The Hood block the balance was read at. */
  blockNumber?: number
}

/** One wallet this key may spend from, with its balances. */
export interface SelfWallet {
  kind: "embedded" | "tee" | "linked"
  chain: WalletChain
  address: string
  /** The linked wallet id; absent on an embedded wallet. */
  id?: string
  label?: string
  balances: SelfWalletBalance[]
  /** Mints whose read failed: unknown, not zero. Absent when every read succeeded. */
  unavailable?: string[]
}

/** `wallets.selfBalances()` options. */
export interface SelfBalancesOptions {
  /** Extra mints (Solana) or 0x token contracts (Hood) beyond the base assets, at most 10. */
  mints?: string[]
  /** The previous page's `continueCursor`. */
  cursor?: string
}

/** `GET /api/v1/agent/wallets/self/balances` response: one page of this key's spendable wallets. */
export interface SelfBalancesResult {
  success: true
  keyPrefix: string
  page: SelfWallet[]
  isDone: boolean
  continueCursor: string | null
  /** `false` when the account's wallet list was cut off. Absent on a key with no spend scope. */
  complete?: boolean
}

/** `client.wallets`: reads scoped to what this key may spend. */
export interface CandleWallets {
  /**
   * Re-reads a one-shot `swap()`'s settlement (GET /api/v1/agent/swap/receipts/{hash}),
   * remeasured from chain on every call. `hash` is any of that result's `hashes`, sent by the key
   * that made the swap. Another key's hash and an unknown hash both throw `RECEIPT_NOT_FOUND`
   * (404), as does a swap whose result said `receiptStored: false`. A swap from
   * `/agent/swap/submit` is re-read with its job instead. Needs `swap:write`.
   */
  swapReceipt(hash: string): Promise<SwapSettlement>
  /**
   * Balances of the wallets this key may spend from, and no others
   * (GET /api/v1/agent/wallets/self/balances). Needs no `account:read`; a key with no spend scope
   * gets an empty page. Base assets always, plus up to 10 `mints`; 50 wallets a page. A balance
   * whose read failed is listed in `unavailable`, never as zero.
   */
  selfBalances(opts?: SelfBalancesOptions): Promise<SelfBalancesResult>
}

/** One token account a close would reclaim (BE-418). `lamports` is its rent, returned to the wallet. */
export interface EmptyTokenAccount {
  account: string
  mint: string
  tokenProgram: "spl-token" | "token-2022"
  lamports: string
}

/**
 * Why an empty account is left open: a mint the caller kept, wrapped SOL, an account the wallet
 * does not own or cannot close, a frozen account, or Token-2022 state CloseAccount refuses.
 */
export type EmptyTokenAccountSkipReason =
  | "kept"
  | "wrapped_sol"
  | "not_owner"
  | "close_authority"
  | "frozen"
  | "withheld_transfer_fees"
  | "confidential_transfer"

export interface SkippedEmptyTokenAccount extends EmptyTokenAccount {
  reason: EmptyTokenAccountSkipReason
}

export interface PreviewCloseEmptyAccountsRequest {
  /** Mints whose empty accounts stay open, e.g. the pair token a held holder-reward coin pays in. */
  keep?: string[]
}

/** previewCloseEmptyAccounts()'s result. Nothing was built, signed or written to produce it. */
export interface CloseEmptyAccountsPreview {
  success: true
  wallet: string
  keep: string[]
  accounts: EmptyTokenAccount[]
  accountCount: number
  totalLamports: string
  totalSol: string
  /** Transactions a close would send, at `closesPerTransaction` each. */
  transactions: number
  estimatedFeeLamports: string
  netLamports: string
  netSol: string
  skipped: SkippedEmptyTokenAccount[]
  /** Token accounts whose bytes did not decode. Never closed. */
  undecodable: string[]
  closesPerTransaction: number
  /** The most accounts one closeEmptyAccounts() call closes; `remaining` counts the rest. */
  maxAccountsPerCall: number
}

export interface CloseEmptyAccountsRequest {
  /** Required and durable: the same id replays its stored report and never closes twice. */
  clientTradeId: string
  keep?: string[]
  /** The preview's `accounts[].account`, to close only what was shown. Omit to close every qualifying account. */
  accounts?: string[]
}

/** A close transaction that landed. */
export interface CloseEmptyAccountsBatch {
  signature: string
  accounts: string[]
  lamports: string
}

/**
 * A close transaction that did not land. `CLOSE_REFUSED` was refused in simulation (no fee);
 * `CLOSE_REVERTED` landed and reverted (fee only); `CLOSE_UNCONFIRMED` may still land, so
 * re-preview before re-running.
 */
export interface CloseEmptyAccountsFailure {
  accounts: string[]
  code: string
  message: string
  signature?: string
}

/** closeEmptyAccounts()'s result. A run in which nothing landed throws a CandleApiError instead. */
export interface CloseEmptyAccountsResult {
  success: true
  /** `partial`: some batch failed, or more accounts remain than one call closes. */
  status: "completed" | "partial" | "nothing_to_close"
  clientTradeId: string
  wallet: string
  keep: string[]
  closed: EmptyTokenAccount[]
  transactions: CloseEmptyAccountsBatch[]
  signatures: string[]
  lamportsRecovered: string
  solRecovered: string
  /** The base network fee of the transactions that landed, reverted ones included, 5,000 lamports each. */
  feeLamports: string
  netLamports: string
  netSol: string
  failed: CloseEmptyAccountsFailure[]
  /** Accounts in batches never sent, after a failure that stops the run. */
  unattempted: string[]
  /** Accounts named in `accounts` that no longer qualify. */
  notClosed: { account: string; reason: string }[]
  skipped: SkippedEmptyTokenAccount[]
  remaining: number
  /** Present when this is the stored report of an earlier call under the same id. */
  replayed?: true
}

export interface CloseEmptyAccountsJob {
  clientTradeId: string
  kind: "close-empty"
  status: "running" | "completed" | "failed"
  createdAt: number
  finishedAt?: number
  httpStatus?: number
  /** The report the close call returned, once it finished. */
  result?: CloseEmptyAccountsResult | Record<string, unknown>
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
   * What the wallet spends on a buy, or receives on a sell. Safe to pass straight through from a
   * `POST /trade/agent/quote` response: the two endpoints take the same ids.
   *
   * Solana (`sol` | `usdc` | `cndl`): applies only when trading a non-Candle-launched token
   * (Pro/Max), and is ignored for a Candle token whose curve pair is fixed. A Hood id on a
   * Solana mint is refused.
   *
   * Hood (`eth` | `usdg`): the settlement asset of a DEX trade. **A USDG buy spends an ERC-20,
   * so the build carries an `approval` leg that an ETH buy does not** -- one extra transaction
   * for a main payer, one extra artifact to sign for a linked one.
   *
   * This is not the route. The cheapest path to the asset is raced independently, so a fill can
   * report `amounts.quoteAsset: "eth"` alongside `route.kind: "usdg"`. Both are true.
   *
   * Requires a server carrying the widened validator; older hosts accept only the Solana ids.
   * The server defaults it when omitted, which is `sol` on Solana and ETH settlement on Hood.
   */
  quoteAsset?: "sol" | "usdc" | "cndl" | "eth" | "usdg"
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
 * - `stage: "executed"` or `"unconfirmed"`, or an error that already names a mint, is not retried
 *   even when `retryable` is true. That attempt may already be on chain.
 */
function isRetryableLaunchFailure(error: unknown): boolean {
  if (!(error instanceof CandleApiError)) return true
  if (error.stage === "executed" || error.stage === "unconfirmed" || error.mint !== undefined) return false
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
  const base = `JSON-RPC ${method} against ${describeRpcEndpoint(url)} was rejected (code ${rpcError.code}): ${rpcError.message}`
  const data = rpcError.data
  if (typeof data !== "object" || data === null) return base
  const d = data as { err?: unknown; logs?: unknown }
  const parts: string[] = []
  if (d.err !== undefined) {
    parts.push(`err: ${typeof d.err === "string" ? d.err : JSON.stringify(d.err)}`)
  }
  if (Array.isArray(d.logs) && d.logs.length > 0) {
    /*
      The TAIL, not the head. An aggregator-built Solana transaction opens with ComputeBudget
      frames every time, so `slice(0, 3)` reliably spent the whole preview on boilerplate and
      cut off the frame that failed. The last lines are where the failing program and its error
      actually are.

      The full array is still on `JsonRpcError.data.logs`, untruncated. This is a preview for
      whoever logs `error.message` -- which is most callers -- not a replacement for reading it.
    */
    const logs = d.logs.filter((line): line is string => typeof line === "string")
    parts.push(`logs: ${logs.slice(-3).join(" | ")}`)
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

/** Loopback, where cleartext never leaves the machine. Brackets because `URL.hostname` keeps them
 * on IPv6 literals; the whole 127.0.0.0/8 block counts, not just 127.0.0.1. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === "localhost" || host.endsWith(".localhost")) return true
  if (host === "::1" || host === "[::1]") return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/**
 * Refuse an `apiUrl` that would put this client's credentials on the wire in the clear.
 *
 * Every authenticated call attaches `x-api-key`, so an `http://` base URL leaks the key to anything
 * on the path. A redirect to HTTPS does not help: the first request has already been sent. This
 * used to be unchecked entirely -- the constructor only trimmed trailing slashes -- so a typo or a
 * copied config silently downgraded every request the client would ever make.
 *
 * Loopback is allowed with no ceremony, since the bytes never leave the host. Anything else needs
 * `allowInsecureHttp: true`, an explicit argument at the construction site rather than an ambient
 * environment variable: a library should not have its transport security flipped by something the
 * calling process cannot see in its own source.
 *
 * Throws rather than returning a fault, matching how this constructor treats other caller mistakes.
 */
/**
 * Whether `hostname` is on a private network, i.e. somewhere cleartext stays inside a LAN or a
 * container host instead of crossing the public internet.
 *
 * This is what BOUNDS the insecure-HTTP escape hatch rather than merely describing it. The hatch
 * exists for one shape, a devcontainer reaching its host (`http://host.docker.internal:3000`), and
 * that shape is always private. Letting the same opt-in also cover a public address is what turns
 * a dev convenience into an API key read off the wire by anyone on the path, so the flag no longer
 * reaches those at all: a cleartext public URL is refused with or without it.
 *
 * Names as well as literals, because the documented case IS a name: `host.docker.internal` never
 * appears as an IP in the URL. A single-label host is included for the same reason it cannot be a
 * public FQDN.
 *
 * Deliberately excluded: 100.64.0.0/10 (carrier-grade NAT) is not "your network" in any sense a
 * developer controls, so it gets no more trust than the public internet.
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  // A single-label name has no public DNS answer, so it can only be resolved locally.
  if (!host.includes(".") && !host.includes(":")) return true
  if (/\.(local|internal|home\.arpa)$/.test(host)) return true
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true
  return /^fe[89ab][0-9a-f]:/.test(host)
}

function assertTransportSecurity(apiUrl: string, allowInsecureHttp: boolean): void {
  let parsed: URL
  try {
    parsed = new URL(apiUrl)
  } catch {
    throw new Error(`CandleClient: apiUrl is not a valid URL: ${JSON.stringify(apiUrl)}`)
  }
  if (parsed.protocol === "https:") return
  if (parsed.protocol !== "http:") {
    throw new Error(`CandleClient: apiUrl must be http or https, got ${parsed.protocol.replace(":", "")}`)
  }
  if (isLoopbackHost(parsed.hostname)) return
  if (allowInsecureHttp && isPrivateHost(parsed.hostname)) return
  throw new Error(
    `CandleClient: refusing to send credentials in the clear to ${parsed.origin}. Use https://.` +
      (isPrivateHost(parsed.hostname)
        ? " Pass allowInsecureHttp: true if this really is a trusted local endpoint."
        : " allowInsecureHttp does not apply here: it covers private networks only, and this is a" +
          " public address."),
  )
}

export class CandleClient {
  private readonly apiUrl: string
  private readonly apiKey?: string
  private readonly fetchImpl: typeof fetch
  private readonly maxRetries: number
  private readonly privyAppId?: string
  private readonly secretStore?: SecretStore
  private readonly solanaRpcUrl?: string
  private readonly evmRpcUrl?: string
  private readonly hyperliquidNetwork: HyperliquidNetwork
  private hyperliquidBuilder?: string

  /** Reads scoped to what this key may spend: a one-shot swap's receipt, and spendable balances. */
  readonly wallets: CandleWallets = {
    swapReceipt: async (hash) => {
      this.requireKey("wallets.swapReceipt()")
      const body = await this.requestJson<{ success: true; settlement: SwapSettlement }>(
        "GET",
        `/api/v1/agent/swap/receipts/${encodeURIComponent(hash)}`,
      )
      return body.settlement
    },
    selfBalances: async (opts = {}) => {
      this.requireKey("wallets.selfBalances()")
      const params = new URLSearchParams()
      if (opts.mints?.length) params.set("mints", opts.mints.join(","))
      if (opts.cursor !== undefined) params.set("cursor", opts.cursor)
      const query = params.size ? `?${params}` : ""
      return this.requestJson<SelfBalancesResult>("GET", `/api/v1/agent/wallets/self/balances${query}`)
    },
  }

  constructor(opts: CandleClientOptions) {
    assertTransportSecurity(opts.apiUrl, opts.allowInsecureHttp === true)
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "")
    if (opts.apiKey !== undefined) this.apiKey = opts.apiKey
    this.fetchImpl = opts.fetch ?? fetch
    // Validated rather than trusted: the retry loop is `attempt <= maxRetries`, so a negative
    // value runs zero attempts and falls through to `throw lastError` before any error exists,
    // surfacing as a confusing TypeError instead of the caller's actual mistake.
    if (opts.maxRetries !== undefined && (!Number.isInteger(opts.maxRetries) || opts.maxRetries < 0)) {
      throw new Error(`CandleClient: maxRetries must be a non-negative integer, got ${opts.maxRetries}`)
    }
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
    if (opts.privyAppId !== undefined) this.privyAppId = opts.privyAppId
    if (opts.secretStore !== undefined) this.secretStore = opts.secretStore
    if (opts.solanaRpcUrl !== undefined) this.solanaRpcUrl = opts.solanaRpcUrl
    if (opts.evmRpcUrl !== undefined) this.evmRpcUrl = opts.evmRpcUrl
    this.hyperliquidNetwork = opts.hyperliquidNetwork ?? "mainnet"
    const builder = opts.hyperliquidBuilder ?? CANDLE_HYPERLIQUID_BUILDER_ADDRESS
    if (builder) this.hyperliquidBuilder = builder.toLowerCase()
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

  /**
   * The plan table in force on this deployment (`GET /api/v1/agent/plans`, no credential): each
   * plan's price, agent fee, perps builder fee, the limits a new key gets, what it can do
   * (`capabilities`), and `promoMaxDays`. Quote prices and fees from here rather than hard-coding
   * them: they differ by deployment and change at the three-plan launch. `planTableRows()` renders
   * it. A server that predates the table answers 404 (`CandleApiError`).
   */
  async getPlans(): Promise<AgentPlansResult> {
    return this.requestJson<AgentPlansResult>("GET", "/api/v1/agent/plans")
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
   * Reads which wallets an agent profile may spend from
   * (GET /api/v1/agent/keys/{prefix}/wallets).
   *
   * Read `walletScope` before drawing conclusions from `wallets`: an empty list means "every
   * wallet on the account" under `"all"` and "none at all" under `"selected"`.
   */
  async getProfileWallets(keyPrefix: string): Promise<ProfileWalletsResult> {
    this.requireKey("getProfileWallets()")
    return this.requestJson<ProfileWalletsResult>("GET", `/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}/wallets`)
  }

  /**
   * One profile's trade history (GET /api/v1/agent/keys/{prefix}/trades).
   *
   * Includes FAILED trades, deliberately: a record that dropped them would misrepresent what the
   * agent did, and `errorCode` is how you find out why one did not go through. For a spreadsheet
   * instead of JSON, request the same path with `?format=csv`.
   *
   * Newest first. Narrow by `since` / `until` and page by passing `nextCursor` back as `cursor`
   * until it is absent; a short page is not the end.
   */
  async getProfileTrades(keyPrefix: string, opts: ProfileTradesOptions = {}): Promise<ProfileTradesResult> {
    this.requireKey("getProfileTrades()")
    const params = new URLSearchParams()
    if (opts.limit !== undefined) params.set("limit", String(opts.limit))
    if (opts.since !== undefined) params.set("since", historyTime(opts.since))
    if (opts.until !== undefined) params.set("until", historyTime(opts.until))
    if (opts.cursor !== undefined) params.set("cursor", opts.cursor)
    const query = params.toString() === "" ? "" : `?${params.toString()}`
    return this.requestJson<ProfileTradesResult>(
      "GET",
      `/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}/trades${query}`,
    )
  }

  /**
   * One profile's realized P&L, fees, and open positions marked at current prices
   * (GET /api/v1/agent/keys/{prefix}/pnl). Read `unrealizedUsd` with `unmarkedPositions` and
   * `oldestMarkAt`: an unpriced position is counted there, never valued at zero.
   *
   * The figures are the key's share of the account's one P&L read, the console's figures to the
   * cent (`pnl.totalUsd` is the console's P&L). Since 2026-10-02 the total is the sum of the key's
   * wallets, not one pool across them, and `lookback` is the account's activity bound; see
   * `ProfilePnlResult` for every meaning that changed.
   *
   * Check `unvalued` and `truncated` before quoting the number: the first counts fills that had
   * no trusted USD price and were left out rather than counted as zero, the second says the
   * lookback window was full and this is not a lifetime figure.
   */
  async getProfilePnl(keyPrefix: string): Promise<ProfilePnlResult> {
    this.requireKey("getProfilePnl()")
    return this.requestJson<ProfilePnlResult>("GET", `/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}/pnl`)
  }

  /**
   * What the account holds in the wallets Candle knows, on Solana and Hood, with prices
   * (GET /api/v1/agent/portfolio): the embedded wallet and every TEE wallet on each chain. Hood
   * wallets are in `hood`; see `PortfolioResult` for how Hood prices are keyed.
   *
   * Needs a key with the `account:read` scope (a whole-account inventory), or the server answers
   * `SCOPE_MISSING`. Vault and external wallets are not included: Candle does not know their
   * addresses. Check `complete` before quoting a total.
   */
  async getPortfolio(): Promise<PortfolioResult> {
    this.requireKey("getPortfolio()")
    return this.requestJson<PortfolioResult>("GET", "/api/v1/agent/portfolio")
  }

  /**
   * Replaces the wallets an agent profile may spend from
   * (PUT /api/v1/agent/keys/{prefix}/wallets).
   *
   * A REPLACE, not a merge: the array passed becomes the profile's entire set, so omitting a
   * wallet revokes its access. Pass `[]` to leave a scoped profile with no wallets at all.
   *
   * NARROWING ONLY from an API key. A key may remove wallets from its OWN profile — so reining an
   * agent in from code never needs a browser — but naming a wallet the profile does not already
   * hold is a grant, and grants require a Privy session (`LOOSEN_REQUIRES_SESSION`). Editing a
   * DIFFERENT profile needs a session too, since otherwise the narrowest key on an account could
   * rewrite the reach of the widest one.
   *
   * Only takes effect while the profile's scope is `"selected"` -- assignments are stored either
   * way, but an unscoped profile can reach every wallet regardless. Use `setProfileWalletScope`
   * to scope it.
   */
  async setProfileWallets(keyPrefix: string, walletIds: string[]): Promise<{ success: true; count: number }> {
    this.requireKey("setProfileWallets()")
    return this.requestJson<{ success: true; count: number }>(
      "PUT",
      `/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}/wallets`,
      { walletIds },
    )
  }

  /**
   * Switches a profile between all-wallets and assigned-only
   * (PUT /api/v1/agent/keys/{prefix}/wallet-scope).
   *
   * TIGHTENING ONLY from an agent key. Widening a profile back to `"all"` requires a Privy
   * session (the portal) and fails here with `LOOSEN_REQUIRES_SESSION`, for the same reason
   * raising a spend limit does: a leaked key must not be able to extend its own reach.
   */
  async setProfileWalletScope(
    keyPrefix: string,
    scope: ProfileWalletScope,
  ): Promise<{ success: true; scope: ProfileWalletScope }> {
    this.requireKey("setProfileWalletScope()")
    return this.requestJson<{ success: true; scope: ProfileWalletScope }>(
      "PUT",
      `/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}/wallet-scope`,
      { scope },
    )
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
   * `clientSwapId` is a durable idempotency key. The same id with the same `from`/`to`/`amountRaw`
   * and effective `maxSlippageBps` (omitted means 100) replays the original result and does not
   * sign or broadcast again. The same id with a different body, including a different slippage,
   * is `IDEMPOTENCY_CONFLICT`. While no outcome is stored yet, a replay is `IDEMPOTENCY_CONFLICT`
   * with `retryable: true`. A timeout is unknown until you replay the same id: the replay returns
   * the stored result. An indeterminate first leg comes back as `SWAP_FAILED` with
   * `retryable: false` and the signature in the message -- verify it on-chain before a new id.
   * A confirmed first leg whose later leg did not finish is replayed with that leg's hash and
   * `retryable: false`, and is not executed again. `retryable: true` on the first `LEG2_FAILED`
   * means send leg 2 as a new request. Omitting `clientSwapId` never coalesces and never writes
   * a ledger row. This method still never retries on its own.
   */
  async swap(req: SwapRequest): Promise<SwapResult> {
    this.requireKey("swap()")
    const body = await this.requestJson<{ success: true; payload: SwapResult }>("POST", "/api/v1/agent/swap", req)
    return body.payload
  }

  /**
   * Lists the embedded Solana wallet's empty token accounts that a close would reclaim, on both
   * token programs, and the SOL their rent returns (BE-418). Read-only: nothing is built, signed or
   * written, and any key scope may call it.
   */
  async previewCloseEmptyAccounts(req: PreviewCloseEmptyAccountsRequest = {}): Promise<CloseEmptyAccountsPreview> {
    this.requireKey("previewCloseEmptyAccounts()")
    return this.requestJson<CloseEmptyAccountsPreview>(
      "POST",
      "/api/v1/agent/wallets/embedded/close-empty/preview",
      req,
    )
  }

  /**
   * Closes the embedded Solana wallet's empty token accounts and returns their rent to that same
   * wallet (BE-418). Needs `transfer:write`. Batches up to 20 closes per transaction and at most
   * ten transactions per call; `remaining` counts what is left for another call.
   *
   * SIGNS ON CHAIN with the embedded wallet. The only lamports that move come back into it, less
   * 5,000 per transaction. `clientTradeId` is a durable ledger key: a repeat of a finished call
   * returns its stored report (`replayed: true`), a repeat while it runs throws CLOSE_IN_PROGRESS,
   * and the same id with a different request throws IDEMPOTENCY_CONFLICT. So a retry under the
   * same id is safe, and this method still never retries on its own.
   */
  async closeEmptyAccounts(req: CloseEmptyAccountsRequest): Promise<CloseEmptyAccountsResult> {
    this.requireKey("closeEmptyAccounts()")
    return this.requestJson<CloseEmptyAccountsResult>("POST", "/api/v1/agent/wallets/embedded/close-empty", req)
  }

  /** Reads a closeEmptyAccounts() run by its clientTradeId, without sending anything (BE-418). */
  async getCloseEmptyAccountsJob(clientTradeId: string): Promise<CloseEmptyAccountsJob> {
    this.requireKey("getCloseEmptyAccountsJob()")
    const body = await this.requestJson<{ success: true; job: CloseEmptyAccountsJob }>(
      "GET",
      `/api/v1/agent/wallets/embedded/close-empty/jobs/${encodeURIComponent(clientTradeId)}`,
    )
    return body.job
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
   * Self-signed launch dry run: the same body as `buildSelfLaunch()`, the same checks (payer and
   * TEE rules, plan, the key's caps), and the same refusals, without building, reserving or
   * recording anything; the `clientLaunchId` stays unused. Does not check the payer's balance, the
   * day cap, a `clientLaunchId` already used with another body or payer, or a Solana TEE wallet's
   * USD spend window; `buildSelfLaunch()` can still refuse for those.
   */
  async dryRunSelfLaunch(req: BuildSelfLaunchRequest): Promise<SelfLaunchDryRunResult> {
    this.requireKey("dryRunSelfLaunch()")
    return this.requestJson<SelfLaunchDryRunResult>("POST", "/api/v1/launch/self/dry-run", req)
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
   *   `artifacts.permit2Approval` (if present), then `artifacts.trade`, then
   *   `artifacts.feeTransfer` (if present), in that exact order. From there, trade() below's
   *   default differs by chain: Solana hands the already-signed bytes to
   *   `submit({ clientTradeId, signedTransactions })`, which broadcasts and confirms them
   *   server-side in one call; Hood stays on the client-broadcast sequence -- broadcast each signed
   *   leg with `broadcastSignedTransaction`, awaiting each leg's own receipt before assembling the
   *   next (its `trade` leg's gas estimate depends on the `approval` and `permit2Approval` legs
   *   already being mined), then
   *   `confirmTrade({ clientTradeId, tradeTxHash, feeTxHash })`, where `feeTxHash` is REQUIRED
   *   whenever `artifacts.feeTransfer` was present (a confirm that omits it is refused
   *   `FEE_LEG_MISSING`). Solana's lower-level opt-in path
   *   (`broadcastSignedTransaction`/`confirmTrade({ clientTradeId, signature })` instead of
   *   `submit()`) and Hood's `submit()` opt-in (skipping the per-leg broadcast/confirm) both stay
   *   available too, for callers who want the other of the two.
   *
   * Requires an agent key with the `swap:write` scope -- opt-in, omitted by default when a key is
   * issued; pass `scopes: [..., "swap:write"]` to `POST /api/v1/agent/keys` to grant it.
   *
   * ## Rebuilding an UNCONFIRMED `clientTradeId`
   *
   * The idempotency notes elsewhere on this rail describe the CONFIRMED case (you get the
   * original result back). The unconfirmed case, which a caller hits whenever a build expires
   * before it is signed, was undocumented until an integrator asked on 2026-08-27:
   *
   * - **It re-quotes, and does NOT create a second intent.** There is one row per
   *   `(account, clientTradeId)`, and a rebuild patches it in place with a fresh plan. That is
   *   deliberate rather than incidental: a Solana blockhash dies in about 90 seconds, so a
   *   replayed build MUST re-plan or it would hand back an artifact that can no longer land.
   * - **The request body is conflict-checked on every build**, not only after confirmation. A
   *   differing body under the same id is refused with `IDEMPOTENCY_CONFLICT`, exactly as the
   *   launch rail does -- so an id cannot be reused for a different trade.
   * - **A `failed` row is reset to `built`** by a matching rebuild, so one id survives a failed
   *   attempt and stays the anti-double-spend key across the retry.
   * - Beyond `BuildTradeBuiltResult.expiresAt`, the server-side states are
   *   `built | confirmed | failed`.
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
   * v1 supports `from: "SOL"` only from a linked wallet. Same-chain conversions (SOL/USDC/CNDL)
   * are `trade()` with a base-asset mint (free, every tier); USDC/CNDL origins convert to SOL that
   * way first. A TEE payer (Ember Phase 4c) may bridge SOL or USDC directly with `clientTradeId`;
   * see `LinkedSwapRequest`. Its errors add `BRIDGE_DESTINATION_MISSING` and `RELAY_STEP_REFUSED`
   * (`BRIDGE_ERROR_CODES`).
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
      ...(req.clientTradeId !== undefined ? { clientTradeId: req.clientTradeId } : {}),
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
      {
        swapId: build.payload.swapId,
        signedTransactionsBase64: signed,
        ...(req.clientTradeId !== undefined ? { clientTradeId: req.clientTradeId } : {}),
      },
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
   *   `confirmTrade` sequence stays available for callers who want to broadcast client-side.
   *   **That path has NO blockhash-rebuild loop, and never did.**
   *   `broadcastSignedTransaction` is a single unretried JSON-RPC send, so a caller who takes it
   *   owns expiry themselves: a Solana blockhash dies in about 90 seconds, and a send that
   *   arrives after that fails with no recovery unless the caller rebuilds. This doc previously
   *   said the opposite, which was the worst possible way to be wrong -- a caller who trusted it
   *   would lose transactions and have no reason to look for the retry that was not there.
   *   Reported by an integrator on 2026-08-27.
   * - **Hood/EVM**: `artifacts.approval` (when present), then `artifacts.permit2Approval` (when
   *   present), then `artifacts.trade`, then `artifacts.feeTransfer` (when present), in that
   *   exact order. EACH leg's receipt is awaited (`waitForReceipt`) before the next leg is even
   *   assembled, then `confirmTrade({ clientTradeId, tradeTxHash, feeTxHash })`. This ordering is
   *   load-bearing, not a style choice: the `trade` leg's `eth_estimateGas` reverts if it runs
   *   before the `approval` and `permit2Approval` legs are mined, since neither allowance is set
   *   yet. So Hood stays off `submit()` by default. submit() is still available as an explicit
   *   opt-in, but only for a caller that has already confirmed the build carries neither an
   *   `approval` nor a `permit2Approval` leg. Requires `evmRpcUrl`; throws a clear error
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
      /*
        The build response already carries the full unsigned transaction, blockhash included, so
        signing needs no RPC read, and the server (submit()'s target) owns broadcast and its own
        blockhash freshness. There is deliberately no rebuild-on-expiry loop here.

        This comment used to add that the loop "still exists on the lower-level opt-in broadcast
        path". It does not: `broadcastSignedTransaction` is a single unretried `jsonRpcCall`. The
        only client-side rebuild loop in this file is selfLaunch()'s Solana branch below, which
        still signs and broadcasts itself.
      */
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

    const legs: Array<{
      kind: "approval" | "permit2Approval" | "trade" | "feeTransfer"
      to: string
      data: string
      value: string
    }> = []
    if (built.artifacts.approval) {
      legs.push({ kind: "approval", to: built.artifacts.approval.to, data: built.artifacts.approval.data, value: "0" })
    }
    // Permit2 grants the Universal Router its allowance inside Permit2. Like `approval`, it must be
    // mined before the trade leg's estimateGas runs. SDK 0.4.0 and earlier skipped this leg.
    if (built.artifacts.permit2Approval) {
      legs.push({
        kind: "permit2Approval",
        to: built.artifacts.permit2Approval.to,
        data: built.artifacts.permit2Approval.data,
        value: "0",
      })
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
      let txHash: string
      try {
        txHash = await this.signBroadcastAndWaitEvmLeg(
          {
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
          },
          // Only the fee leg keeps a hash whose broadcast or receipt is unknown. Other legs
          // still throw the original error.
          { surfaceLegOutcome: leg.kind === "feeTransfer" },
        )
      } catch (err) {
        // The fee transfer comes after the trade leg. If it throws, the trade is already on chain:
        // say so, with its hash, instead of an error that reads as "nothing happened". A fee hash
        // that is already known stays on the error, and an unknown broadcast or receipt says not
        // to pay that fee a second time.
        if (leg.kind === "feeTransfer" && tradeTxHash) {
          throw tradeLandedFeeLegError({ clientTradeId: built.clientTradeId, tradeTxHash, err })
        }
        throw err
      }
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
   * send a dev buy: a Hood self-launch's dev buy is a separate transaction the caller sends itself
   * and reports to `confirmSelfLaunch` as `devBuySignature`. The build response never includes a
   * dev-buy leg, and this method does not assemble one.
   */
  async selfLaunch(req: SelfLaunchRequest): Promise<ConfirmSelfLaunchResult> {
    const { privyWalletId, ...launchReq } = req
    const body: BuildSelfLaunchRequest = {
      ...launchReq,
      clientLaunchId: launchReq.clientLaunchId ?? generateClientLaunchId(),
    }
    const built = await this.buildSelfLaunch(body)

    if (typeof built.transaction === "string") {
      // The one client-side rebuild-on-blockhash-expiry loop left in this file. It used to say
      // "same loop as trade()'s Solana branch above", which stopped being true when trade()
      // handed broadcast to the server: selfLaunch still signs and broadcasts here, so it still
      // owns expiry. Tracked as plain fields (not the whole `built` object)
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
    // Shape BEFORE status, deliberately. A `failed` or `timeout` outcome arrives with a 502 and is
    // still the answer: it carries the bundleId and the retryable flag the caller needs, and
    // throwing a generic API error would discard exactly that. Two tests pin it ("a 502 failed
    // outcome is RETURNED, not thrown"). An audit read this ordering as a status-gate bypass; it
    // is not, because isAtomicSubmitOutcome is strict enough that no error body satisfies it: it
    // requires a string bundleId AND either failed/timeout with a boolean retryable, or landed
    // with a mint and a signatures array.
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
   *
   * `surfaceLegOutcome` is the fee leg only. A receipt revert, a receipt read that fails, a
   * receipt timeout, or a broadcast whose result is ambiguous then throws `EvmLegOutcome` with
   * the hash once it is known. Every other caller gets the original error.
   */
  private async signBroadcastAndWaitEvmLeg(
    params: {
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
    },
    opts: { surfaceLegOutcome?: boolean } = {},
  ): Promise<string> {
    try {
      return await this.broadcastAndWaitEvmLeg(params)
    } catch (err) {
      if (opts.surfaceLegOutcome || !(err instanceof EvmLegOutcome)) throw err
      throw err.cause
    }
  }

  private async broadcastAndWaitEvmLeg(params: {
    rpc: EvmRpc
    from: string
    to: string
    data: string
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
    // Hash the signed bytes before the send. A lost response still names the transaction.
    const predicted = evmSignedTxHash(signed.signedTransaction, signed.encoding)
    let txHash: string
    try {
      txHash = await this.broadcastSignedTransaction("evm", signed.signedTransaction, signed.encoding)
    } catch (err) {
      if (!isDefiniteBroadcastRejection(err)) {
        throw new EvmLegOutcome({ kind: "unknown", txHash: predicted, cause: err })
      }
      throw err
    }
    try {
      await waitForReceipt(params.rpc, txHash, evmReceiptWaitForTest ?? {})
    } catch (err) {
      if (isRevertedReceipt(err)) throw new EvmLegOutcome({ kind: "reverted", txHash, cause: err })
      throw new EvmLegOutcome({ kind: "unknown", txHash, cause: err })
    }
    return txHash
  }

  // -- Hyperliquid perps (spec 2026-10-01-hyperliquid-perps-tee-design.md) ---

  /** The server's perps settings: network, Candle's builder, this key's fee, and its limits. */
  async perpsConfig(): Promise<PerpsConfig> {
    this.requireKey("perpsConfig()")
    return this.requestJson<PerpsConfig>("GET", "/api/v1/agent/perps/config")
  }

  /**
   * One-time setup (R1): approves Candle's builder fee at 0.1% unless Hyperliquid already shows
   * it, and reports the account's mode and balance. Idempotent.
   */
  async perpsSetup(params: PerpsWalletRef): Promise<PerpsSetupResult> {
    this.requireKey("perpsSetup()")
    const res = await this.requestJson<PerpsAccountStatus & { ready: boolean } & Partial<PerpsBuild>>(
      "POST",
      "/api/v1/agent/perps/setup",
      { walletId: params.walletId },
    )
    const status: PerpsAccountStatus & { ready: boolean } = {
      walletId: res.walletId as string,
      address: res.address as string,
      network: res.network as HyperliquidNetwork,
      mode: res.mode,
      standardMode: res.standardMode,
      accountValue: res.accountValue,
      withdrawable: res.withdrawable,
      builder: res.builder as unknown as string,
      approvedFeeTenthsBps: res.approvedFeeTenthsBps,
      ready: res.ready,
    }
    if (res.ready) return status
    return { ...status, action: await this.perpsComplete(res as PerpsBuild, params, "setup") }
  }

  /** Open (or add to) a position: build, check, sign through the relay, submit to Hyperliquid. */
  async perpsOpen(params: PerpsOpenParams): Promise<PerpsActionResult> {
    this.requireKey("perpsOpen()")
    const { walletId, privyWalletId: _p, submit: _s, ...order } = params
    const build = await this.requestJson<PerpsBuild>("POST", "/api/v1/agent/perps/open", { walletId, ...order })
    return this.perpsComplete(build, params, "open")
  }

  /** Close all or part of a position with a reduce-only IOC order. Reserves nothing. */
  async perpsClose(params: PerpsCloseParams): Promise<PerpsActionResult> {
    this.requireKey("perpsClose()")
    const { walletId, privyWalletId: _p, submit: _s, ...close } = params
    const build = await this.requestJson<PerpsBuild>("POST", "/api/v1/agent/perps/close", { walletId, ...close })
    return this.perpsComplete(build, params, "close")
  }

  /** Cancel an order Candle built, by its cloid. */
  async perpsCancel(params: PerpsCancelParams): Promise<PerpsActionResult> {
    this.requireKey("perpsCancel()")
    const build = await this.requestJson<PerpsBuild>("POST", "/api/v1/agent/perps/cancel", {
      walletId: params.walletId,
      cloid: params.cloid,
    })
    return this.perpsComplete(build, params, "cancel")
  }

  /** Change a resting order's price or size. The replacement gets a new cloid. */
  async perpsModify(params: PerpsModifyParams): Promise<PerpsActionResult> {
    this.requireKey("perpsModify()")
    const { walletId, privyWalletId: _p, submit: _s, ...modify } = params
    const build = await this.requestJson<PerpsBuild>("POST", "/api/v1/agent/perps/modify", { walletId, ...modify })
    return this.perpsComplete(build, params, "modify")
  }

  /** Set a market's leverage and margin mode on the account, within the key's maxLeverage. */
  async perpsLeverage(params: PerpsLeverageParams): Promise<PerpsActionResult> {
    this.requireKey("perpsLeverage()")
    const { walletId, privyWalletId: _p, submit: _s, ...leverage } = params
    const build = await this.requestJson<PerpsBuild>("POST", "/api/v1/agent/perps/leverage", { walletId, ...leverage })
    return this.perpsComplete(build, params, "leverage")
  }

  /** Add (positive) or remove (negative) isolated margin on an isolated position. */
  async perpsMargin(params: PerpsMarginParams): Promise<PerpsActionResult> {
    this.requireKey("perpsMargin()")
    const build = await this.requestJson<PerpsBuild>("POST", "/api/v1/agent/perps/margin", {
      walletId: params.walletId,
      coin: params.coin,
      amount: params.amount,
    })
    return this.perpsComplete(build, params, "margin")
  }

  /** Positions and account value, read live from Hyperliquid by the wallet's address. */
  async perpsPositions(walletId: string): Promise<PerpsPositions> {
    this.requireKey("perpsPositions()")
    return this.requestJson<PerpsPositions>(
      "GET",
      `/api/v1/agent/perps/positions?walletId=${encodeURIComponent(walletId)}`,
    )
  }

  /** Open orders on Hyperliquid, and Candle's record of every action it built, settled first. */
  async perpsOrders(walletId: string, opts: { limit?: number } = {}): Promise<PerpsOrders> {
    this.requireKey("perpsOrders()")
    const params = new URLSearchParams({ walletId })
    if (opts.limit !== undefined) params.set("limit", String(opts.limit))
    return this.requestJson<PerpsOrders>("GET", `/api/v1/agent/perps/orders?${params}`)
  }

  /** Fills, read live from Hyperliquid by the wallet's address. */
  async perpsFills(walletId: string): Promise<{ success: true; fills: Record<string, unknown>[] }> {
    this.requireKey("perpsFills()")
    return this.requestJson("GET", `/api/v1/agent/perps/fills?walletId=${encodeURIComponent(walletId)}`)
  }

  /** Funding payments since `startTime` (epoch ms; default the last 7 days). */
  async perpsFunding(
    walletId: string,
    startTime?: number,
  ): Promise<{ success: true; startTime: number; funding: Record<string, unknown>[] }> {
    this.requireKey("perpsFunding()")
    const params = new URLSearchParams({ walletId })
    if (startTime !== undefined) params.set("startTime", String(startTime))
    return this.requestJson("GET", `/api/v1/agent/perps/funding?${params}`)
  }

  /**
   * Deposit onto the key's Hyperliquid account through Relay (Perps C, HL-ED-8): build, check the
   * build names `account` on chain 1337 with no Candle fee, then sign through the relay and submit.
   * From Solana that is one deposit transaction; from Hood each sequenced leg (approve, then the
   * deposit) is signed and submitted in turn. The fill is Relay's, after the deposit lands: read it
   * with `perpsDepositStatus()`. Candle checks Relay's steps before it stamps them; `candle perps
   * deposit` additionally decodes them on the caller's machine.
   */
  async perpsDeposit(params: PerpsDepositParams): Promise<PerpsDepositResult> {
    this.requireKey("perpsDeposit()")
    const build = await this.requestJson<PerpsDepositBuild & { job?: unknown }>("POST", "/api/v1/agent/perps/deposit", {
      clientDepositId: params.clientDepositId,
      walletId: params.walletId,
      asset: params.asset,
      amountRaw: params.amountRaw,
      ...(params.perpsWalletId !== undefined ? { perpsWalletId: params.perpsWalletId } : {}),
      ...(params.maxSlippageBps !== undefined ? { maxSlippageBps: params.maxSlippageBps } : {}),
    })
    if (build.job !== undefined)
      throw new Error(
        `perpsDeposit(): ${params.clientDepositId} already names a deposit; read it with perpsDepositStatus()`,
      )
    const problem = perpsDepositProblem(build, params)
    if (problem) throw new Error(`perps: refused to sign this deposit: ${problem}`)
    if (params.submit === false) return { build, submitted: false, result: null }
    const submitPath = "/api/v1/agent/perps/deposit/submit"
    const ids = { clientDepositId: params.clientDepositId, depositId: build.depositId }

    if (build.chain === "solana") {
      const signed = await this.signLinkedTransaction({
        chain: "solana",
        linkedWalletId: params.walletId,
        privyWalletId: params.privyWalletId,
        unsignedTransactionBase64: (build.transactionsBase64 as string[])[0] as string,
      })
      const result = await this.requestJson<Record<string, unknown>>("POST", submitPath, {
        ...ids,
        signedTransactionsBase64: [signed.signedTransaction],
      })
      return { build, submitted: true, result }
    }

    const allowed = params.asset === "USDG" ? ["approval", "bridgeDeposit"] : ["bridgeDeposit"]
    const planned = build.plannedLegCount ?? 0
    const hex = (value: string) => `0x${BigInt(value).toString(16)}`
    let body: Record<string, unknown> = build as unknown as Record<string, unknown>
    const signedKinds = new Set<string>()
    while (body.mode === "sequenced") {
      const leg = body.nextLeg as PerpsDepositBuild["nextLeg"]
      const kind = String(body.legKind)
      if (
        !leg ||
        body.operationId !== build.operationId ||
        body.plannedLegCount !== planned ||
        planned > allowed.length ||
        !allowed.includes(kind) ||
        signedKinds.has(kind) ||
        leg.chainId !== 4663
      ) {
        throw new Error(`perps: refused to sign deposit leg ${kind}: it is not the plan this deposit was built with`)
      }
      signedKinds.add(kind)
      const signed = await this.signLinkedTransaction({
        chain: "evm",
        linkedWalletId: params.walletId,
        privyWalletId: params.privyWalletId,
        evmTxParams: {
          chain_id: leg.chainId,
          data: leg.data,
          from: build.walletAddress,
          gas_limit: hex(leg.gas),
          max_fee_per_gas: hex(leg.maxFeePerGas),
          max_priority_fee_per_gas: hex(leg.maxPriorityFeePerGas),
          nonce: leg.nonce,
          to: leg.to,
          type: 2,
          value: hex(leg.value),
        },
      })
      body = await this.requestJson<Record<string, unknown>>("POST", submitPath, {
        ...ids,
        operationId: build.operationId,
        signedTransaction: signed.signedTransaction,
      })
    }
    return { build, submitted: true, result: body }
  }

  /** A deposit's job: what was built and submitted, the Hood operation, and Relay's fill status. */
  async perpsDepositStatus(clientDepositId: string): Promise<{ success: true; job: Record<string, unknown> }> {
    this.requireKey("perpsDepositStatus()")
    return this.requestJson("GET", `/api/v1/agent/perps/deposit/${encodeURIComponent(clientDepositId)}`)
  }

  /** The builder every perps build is checked against (see `hyperliquidBuilder` in the options). */
  private async perpsBuilder(): Promise<string> {
    if (this.hyperliquidBuilder) return this.hyperliquidBuilder
    const config = await this.perpsConfig()
    if (!config.builder) throw new Error("perps: the server reports no Hyperliquid builder address")
    this.hyperliquidBuilder = config.builder.toLowerCase()
    return this.hyperliquidBuilder
  }

  /**
   * Check, sign, submit (HL-ED-2, HL-ED-5). The check runs before the relay is called; a build
   * that fails it is refused with nothing signed.
   */
  private async perpsComplete(
    build: PerpsBuild,
    ref: PerpsWalletRef,
    method: "setup" | "open" | "close" | "cancel" | "modify" | "leverage" | "margin",
  ): Promise<PerpsActionResult> {
    const check = verifyPerpsBuild(build, {
      builder: await this.perpsBuilder(),
      network: this.hyperliquidNetwork,
      intent: { method, params: ref as unknown as Record<string, unknown> },
    })
    if (!check.ok) throw new Error(`perps: refused to sign this build: ${check.reason}`)
    if (method === "close") {
      const closeOrder = await hyperliquidCloseOrder(
        this.fetchImpl,
        this.hyperliquidNetwork,
        build.address,
        ref as unknown as Record<string, unknown>,
      )
      const closeCheck = verifyPerpsBuild(build, {
        builder: await this.perpsBuilder(),
        network: this.hyperliquidNetwork,
        intent: { method, params: ref as unknown as Record<string, unknown> },
        closeOrder,
      })
      if (!closeCheck.ok) throw new Error(`perps: refused to sign this build: ${closeCheck.reason}`)
    }
    if (ref.submit === false) return { build, signature: null, submitted: false, exchange: null }
    const signature = await this.signLinkedTypedData({
      linkedWalletId: ref.walletId,
      privyWalletId: ref.privyWalletId,
      typedData: build.typedData,
    })
    try {
      const res = await this.fetchImpl(HYPERLIQUID_EXCHANGE_URLS[this.hyperliquidNetwork], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(hyperliquidExchangeBody(build.action, build.nonce, signature)),
      })
      const text = await res.text()
      if (!res.ok) {
        return { build, signature, submitted: false, exchange: null, submitError: `HTTP ${res.status}: ${text}` }
      }
      return { build, signature, submitted: true, exchange: JSON.parse(text) as unknown }
    } catch (err) {
      return {
        build,
        signature,
        submitted: false,
        exchange: null,
        submitError: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /**
   * Sign EIP-712 typed data with a linked EVM TEE wallet through the relay
   * (`eth_signTypedData_v4`). The relay signs only typed data a perps build stamped.
   */
  private async signLinkedTypedData(params: {
    linkedWalletId: string
    privyWalletId: string
    typedData: HyperliquidTypedData
  }): Promise<string> {
    if (!this.privyAppId) {
      throw new Error("perps signing requires privyAppId in CandleClientOptions (the relay's Privy app id)")
    }
    if (!this.secretStore) throw new Error("perps signing requires a secretStore in CandleClientOptions")
    const privateKeyPem = await this.secretStore.get(params.linkedWalletId)
    if (!privateKeyPem) {
      throw new Error(`perps: no signer key stored for linked wallet "${params.linkedWalletId}"`)
    }
    const body = hyperliquidRelayBody(params.typedData)
    const authorizationSignature = await buildPrivyAuthorizationSignature({
      privateKeyPem,
      privyWalletId: params.privyWalletId,
      appId: this.privyAppId,
      body,
    })
    const res = await this.requestJson<{ success: true; signature: string }>(
      "POST",
      `/api/v1/agent/wallets/${encodeURIComponent(params.linkedWalletId)}/sign`,
      { authorizationSignature, body },
    )
    if (typeof res.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(res.signature)) {
      throw new Error("perps: the relay returned no signature")
    }
    return res.signature
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

  // PUT joins GET/POST for the profile-wallet routes, which are replace-semantics writes. The
  // verb is passed straight to fetch and nothing below branches on it, so this widening is a
  // type change only.
  private async requestJson<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method,
      headers: this.headers({ json: body !== undefined }),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return this.parseResponse<T>(res)
  }

  private async parseResponse<T>(res: Response): Promise<T> {
    noteLatestSdkVersion(res.headers?.get?.("x-candle-sdk-latest") ?? null)
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
      throw new Error(`JSON-RPC ${method} against ${describeRpcEndpoint(url)} failed: HTTP ${res.status}: ${text}`)
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
        `JSON-RPC ${method} against ${describeRpcEndpoint(url)} returned a non-string result: ${JSON.stringify(parsed.result)}`,
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
      throw new Error(`JSON-RPC ${method} against ${describeRpcEndpoint(url)} failed: HTTP ${res.status}: ${text}`)
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

/**
 * A Hood leg whose broadcast was attempted or whose receipt did not come back clean.
 * `unknown` means the fee may already be in flight. `reverted` means the receipt said it was not.
 */
class EvmLegOutcome extends Error {
  readonly kind: "unknown" | "reverted"
  readonly txHash?: string
  override readonly cause: unknown

  constructor(args: { kind: "unknown" | "reverted"; txHash?: string; cause: unknown }) {
    super(args.cause instanceof Error ? args.cause.message : String(args.cause), { cause: args.cause })
    this.name = "EvmLegOutcome"
    this.kind = args.kind
    this.txHash = args.txHash
    this.cause = args.cause
  }
}

/** Receipt wait used by tests. Production leaves this null and waitForReceipt keeps its own defaults. */
let evmReceiptWaitForTest: { timeoutMs?: number; pollMs?: number } | null = null

/** Test-only. Pass null to restore the production receipt wait. */
export function __setEvmReceiptWaitForTest(opts: { timeoutMs?: number; pollMs?: number } | null): void {
  evmReceiptWaitForTest = opts
}

function tradeLandedFeeLegError(args: {
  clientTradeId: string
  tradeTxHash: string
  err: unknown
}): TradeLandedFeeLegError {
  if (args.err instanceof EvmLegOutcome) {
    return new TradeLandedFeeLegError({
      clientTradeId: args.clientTradeId,
      tradeTxHash: args.tradeTxHash,
      cause: args.err.cause,
      feeOutcome: args.err.kind,
      ...(args.err.txHash !== undefined ? { feeTxHash: args.err.txHash } : {}),
    })
  }
  return new TradeLandedFeeLegError({
    clientTradeId: args.clientTradeId,
    tradeTxHash: args.tradeTxHash,
    cause: args.err,
    feeOutcome: "not-broadcast",
  })
}

/** keccak256 of a signed EVM transaction, the hash eth_sendRawTransaction would return. */
function evmSignedTxHash(signedTransaction: string, encoding: string): string | undefined {
  const enc = encoding.toLowerCase()
  let bytes: Uint8Array | undefined
  if (enc === "base64") {
    bytes = fromBase64(signedTransaction)
  } else if (enc === "hex" || enc === "rlp" || signedTransaction.startsWith("0x")) {
    const hex = signedTransaction.startsWith("0x") ? signedTransaction.slice(2) : signedTransaction
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return undefined
    bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  if (!bytes || bytes.length === 0) return undefined
  let hex = ""
  for (const b of keccak_256(bytes)) hex += b.toString(16).padStart(2, "0")
  return `0x${hex}`
}

/**
 * Only an explicit node validation rejection proves the transaction was not accepted. A generic
 * JSON-RPC server/internal/proxy error is an unknown outcome, just like a lost transport response.
 * Match the complete RPC message, not a phrase mentioned in a proxy's error. Unrecognised variants
 * stay unknown. "Already known" and "nonce too low" may mean this exact transaction already mined.
 */
function isDefiniteBroadcastRejection(err: unknown): boolean {
  if (!(err instanceof JsonRpcError)) return false
  const rpcMessage = err.message.match(/\(code -?\d+\): (.*)$/)?.[1]?.toLowerCase()
  return (
    rpcMessage === "insufficient funds for gas * price + value" ||
    rpcMessage === "intrinsic gas too low" ||
    rpcMessage === "invalid sender"
  )
}

function isRevertedReceipt(err: unknown): boolean {
  return err instanceof Error && err.message.includes("transaction reverted (receipt status 0x0)")
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

// ── Update notice ───────────────────────────────────────────────────────────────────────────
//
// The API stamps x-candle-sdk-latest on every response (its client-versions middleware), so an
// SDK process learns a newer release exists from requests it was already making: no registry
// call, no startup cost, nothing for serverless cold starts to pay. The single console.warn
// per process is the whole surface -- a library that prints more than once, or on a channel a
// host cannot filter, is a library that gets muted wholesale. Silence it entirely with
// CANDLE_NO_UPDATE_NOTICE=1.

/** This build's own version. Kept in lockstep with package.json by the release-bump CI guard. */
export const SDK_VERSION = "0.4.8"

let sdkUpdateWarned = false

function noteLatestSdkVersion(value: string | null): void {
  if (sdkUpdateWarned || !value || !/^\d+\.\d+\.\d+$/.test(value)) return
  const [a1 = 0, a2 = 0, a3 = 0] = value.split(".").map(Number)
  const [b1 = 0, b2 = 0, b3 = 0] = SDK_VERSION.split(".").map(Number)
  const isNewer = a1 !== b1 ? a1 > b1 : a2 !== b2 ? a2 > b2 : a3 > b3
  if (!isNewer) return
  if (typeof process !== "undefined" && process.env?.CANDLE_NO_UPDATE_NOTICE) return
  sdkUpdateWarned = true
  console.warn(
    `@candledottv/agent-sdk ${value} is available (running ${SDK_VERSION}). Update: npm install @candledottv/agent-sdk@latest (set CANDLE_NO_UPDATE_NOTICE=1 to silence)`,
  )
}

/** Test seam: the once-per-process latch would otherwise weld the suite's first case to the rest. */
export function __resetSdkUpdateNoticeForTest(): void {
  sdkUpdateWarned = false
}
