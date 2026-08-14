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
import type { SecretStore } from "./secret-store";
import { type WalletChain } from "./wallet-import";
export type Chain = "solana" | "hood";
/**
 * The two shipped tiers plus their low-threshold TEST twins (~1/80 economics, same identity and
 * NFT gate; see docs/superpowers/specs/2026-08-04-test-curve-configs-design.md). Test tiers are
 * creatable only where the API's ENABLE_TEST_CURVES flag is on; the server refuses them
 * otherwise, so client code needs no gate of its own.
 */
export type LaunchTier = "open" | "exclusive" | "test-open" | "test-exclusive";
export type FeedBucket = "new" | "graduated" | "onfire" | "bluechip";
export interface CandleClientOptions {
    /** Base URL of the Candle API, e.g. "https://api.candle.tv". Trailing slashes are trimmed. */
    apiUrl: string;
    /** Agent API key (cndl_live_... / cndl_test_...). Required for launch, jobs, activity, uploads. */
    apiKey?: string;
    /** Injectable fetch for tests; defaults to the global. */
    fetch?: typeof fetch;
    /** Max launch() retries after the initial attempt. Default 3. */
    maxRetries?: number;
    /**
     * Privy's app id: a PUBLIC identifier, the same value a frontend exposes as
     * NEXT_PUBLIC_PRIVY_APP_ID, NOT a secret. Required by signLinkedTransaction() (and therefore by
     * the linked-wallet paths of trade() and selfLaunch()): the sign relay authenticates to Privy
     * under Candle's own server-side PRIVY_APP_ID, and the authorization signature this client
     * computes locally covers that exact app id, so this option must be set to the SAME app id the
     * relay uses or Privy rejects the forwarded signature as SIGNER_MISMATCH.
     */
    privyAppId?: string;
    /**
     * Where an agent's own P-256 signer private-key PEM lives, keyed by linkedWalletId (see
     * secret-store.ts). Required by signLinkedTransaction() and the linked-wallet paths of trade()
     * and selfLaunch(); Candle's servers never see this key, whichever SecretStore implementation
     * holds it. That cuts both ways: if the caller loses this key, its linked wallet can no longer
     * be signed for through this SDK, by design. There is no Candle-side recovery, since Candle
     * never held a copy to recover; the only way back is revoking that linked wallet and
     * re-importing it with a new signer key (see "Self-signed launches" in docs/headless-launch.md).
     */
    secretStore?: SecretStore;
    /** Solana JSON-RPC endpoint used by broadcastSignedTransaction() and the Solana linked-wallet one-shots (trade()/selfLaunch()). */
    solanaRpcUrl?: string;
    /**
     * EVM JSON-RPC endpoint used by broadcastSignedTransaction() and the Hood linked-wallet
     * one-shots (trade()/selfLaunch()): fetching chain id, nonce, and fee data, and estimating gas
     * for each leg (via packages/sdk/src/evm-tx.ts's helpers) all read from this endpoint. Required
     * for a Hood linked payer; trade()/selfLaunch() throw a clear error naming this option when it
     * is unset, before any signing.
     */
    evmRpcUrl?: string;
}
/** The bonding-curve terms of one (chain, quote asset, tier) cell. */
export interface CurveTerms {
    symbol: string;
    /** Migration threshold in the quote asset's smallest unit, as a decimal string. */
    thresholdRaw: string;
    raise: number;
    startFdv: number;
    bondingFdv: number;
    supplySoldPct: number;
}
/** One quote asset a launch can be denominated in, with its per-tier terms. */
export interface QuotePair {
    chain: Chain;
    /** Stable lowercase id; what a launch request sends as `quoteAsset`. */
    id: string;
    symbol: string;
    address: string;
    decimals: number;
    isNative: boolean;
    /** Web-launcher dev-buy flag; agents should read `headlessDevBuy` instead once present. */
    supportsDevBuy: boolean;
    /** Whether a headless launch can bundle a dev buy in this asset (ships in Phase 2 wave 3). */
    headlessDevBuy?: boolean;
    tiers: Partial<Record<LaunchTier, CurveTerms>>;
}
/** GET /api/v1/launch/quote-pairs, unwrapped from its `payload` envelope. */
export interface QuotePairsPayload {
    matrixVersion: number;
    pairs: Partial<Record<Chain, QuotePair[]>>;
    /** What each chain gets when a launch names no quote asset. */
    defaults: Partial<Record<Chain, string>>;
}
/** One first-party preset, joined with the live tier terms. */
export interface LaunchPreset {
    name: string;
    description: string;
    chain: Chain;
    quoteAsset: string;
    mode: LaunchTier;
    dexVersion?: "v3" | "v4";
    stakerAllocationBps: number;
    terms: CurveTerms;
}
/** GET /api/v1/launch/presets, unwrapped from its `payload` envelope. */
export interface PresetsPayload {
    matrixVersion: number;
    presets: LaunchPreset[];
}
/** POST /api/v1/launch/headless request body. The server is the authoritative validator. */
export interface LaunchRequest {
    /** Idempotency key, unique per account. launch() generates "sdk-" + UUID when absent. */
    clientLaunchId?: string;
    chain?: Chain;
    quoteAsset?: string;
    mode?: LaunchTier;
    stakerAllocationBps?: number;
    /** Hood only, required there: which Uniswap version the curve graduates through. */
    dexVersion?: "v3" | "v4";
    /** Initial dev buy. Solana: JSON number in the pair's base units. Hood: decimal string in wei. */
    buyAmount?: number | string;
    name: string;
    symbol: string;
    imageUrl: string;
    description?: string;
    socials?: {
        twitter?: string;
        telegram?: string;
        website?: string;
        discord?: string;
    };
    visibility?: "production" | "test" | "local" | "hidden";
}
/** POST /api/v1/launch/self/build request body. Extends LaunchRequest with linkedWalletId. */
export interface BuildSelfLaunchRequest extends LaunchRequest {
    linkedWalletId: string;
}
/** POST /api/v1/launch/self/build response for Solana (unsigned transaction). */
export interface BuildSelfLaunchSolanaResult {
    success: true;
    transaction: string;
    mint: string;
    pool: string;
    clientLaunchId: string;
    expiresAt: number;
}
/** POST /api/v1/launch/self/build response for Hood (calldata). */
export interface BuildSelfLaunchHoodResult {
    success: true;
    transaction: {
        to: string;
        data: string;
    };
    curveAddress: string;
    clientLaunchId: string;
    expiresAt: number;
    /** The linked payer's own checksummed EVM address: the transaction `from`, and the nonce query subject. */
    walletAddress: string;
    /** Present only when a platform fee applies; the companion transfer to send AFTER the createCurve tx. */
    feeTransfer?: {
        to: string;
        data: string;
        value: string;
    };
    /** Present only when a platform fee applies; itemizes what feeTransfer above actually moves. */
    fee?: TradeFee;
}
/** POST /api/v1/launch/self/build response. */
export type BuildSelfLaunchResult = BuildSelfLaunchSolanaResult | BuildSelfLaunchHoodResult;
/** POST /api/v1/launch/self/confirm request body. */
export interface ConfirmSelfLaunchRequest {
    clientLaunchId: string;
    signature: string;
    devBuySignature?: string;
    /** Hood only: the fee-transfer leg's own transaction hash, required whenever the build carried a `feeTransfer` leg. */
    feeTxHash?: string;
}
/** POST /api/v1/launch/self/confirm response. Mirrors LaunchResult. */
export interface ConfirmSelfLaunchResult extends LaunchResult {
}
/** POST /api/v1/launch/headless/dry-run response. */
export interface DryRunResult {
    success: true;
    dryRun: true;
    resolved: {
        chain: Chain;
        quoteAsset: string;
        mode: LaunchTier;
        stakerAllocationBps: number;
        dexVersion: "v3" | "v4" | null;
        visibility: string;
        buyAmount: string;
    };
    checks: {
        image: string;
        exclusiveEligible: boolean;
    };
    matrixVersion: number;
}
/** POST /api/v1/launch/headless blocking (or replayed) success response. */
export interface LaunchResult {
    success: true;
    chain: Chain;
    mint: string;
    pool: string | null;
    signature: string;
    quoteAsset: string;
    mode: LaunchTier;
    stakerAllocationBps: number;
    matrixVersion: number;
    links: {
        candle: string;
        explorer?: string;
    };
    nextBuy: {
        market: string;
        quoteAsset: string;
        marketStateUrl: string;
    };
    devBuy?: {
        signature: string;
    };
}
/** The 202 body of an `async: true` launch. */
export interface AcceptedJob {
    success: true;
    accepted: true;
    clientLaunchId: string;
    status: "submitted";
    jobUrl: string;
}
/** One idempotency-ledger attempt, from GET /api/v1/launch/headless/jobs/:clientLaunchId. */
export interface LaunchJob {
    clientLaunchId: string;
    chain: Chain;
    status: "submitted" | "confirming" | "confirmed" | "failed";
    mint?: string;
    pool?: string;
    signature?: string;
    devBuy?: {
        signature: string;
    };
    errorCode?: string;
    createdAt: number;
    updatedAt: number;
}
export interface MigrationStatus {
    status: "not_started" | "in_progress" | "completed" | "delayed";
    migratedAt?: number;
    attempts?: number;
    nextAttemptAt?: number;
    gaveUpAt?: number;
}
/** GET /api/v1/markets/:chain/:mint, unwrapped from `{ success, market }`. */
export interface MarketState {
    chain: Chain;
    mint: string;
    lifecycle: "trading" | "completed" | "migrated" | "recovery";
    buysOpen: boolean;
    sellsOpen: boolean;
    curveAddress: string | null;
    poolAddress: string | null;
    quoteMint: string | null;
    feeBps: number;
    graduationVenue: string;
    tier: string | null;
    crossingModel: "full-fill-surplus" | "capped-refund";
    migration: MigrationStatus;
}
/** All amounts are decimal strings in the relevant asset's smallest unit. */
export interface QuoteBreakdown {
    amountOut: string;
    fee: string;
    minAmountOut: string;
    /** Buys only: whether this buy crosses the graduation threshold. */
    crossesGraduation?: boolean;
    /** Hood crossing buys only: quote refunded past the capped fill. */
    refund?: string;
    /** Hood crossing buys only: quote actually consumed (amountIn minus refund). */
    quoteConsumed?: string;
}
/** GET /api/v1/markets/:chain/:mint/quote response. */
export interface QuoteResult {
    success: true;
    chain: Chain;
    mint: string;
    side: "buy" | "sell";
    amountIn: string;
    crossingModel: "full-fill-surplus" | "capped-refund";
    quote: QuoteBreakdown;
}
/** One feed row. The stats columns vary by bucket, hence the open index signature. */
export interface FeedToken {
    chain: Chain;
    address?: string;
    name?: string;
    symbol?: string;
    image?: string;
    /** True for a Candle-origin launch created via an agent key. */
    isAgent?: boolean;
    [key: string]: unknown;
}
/** GET /api/v1/markets/feed response. */
export interface FeedResult {
    success: true;
    bucket: FeedBucket;
    tokens: FeedToken[];
}
/** GET /api/v1/verify/:chain/:mint. Branch on `candleLaunched`; unknown mints are not 404s. */
export type VerifyResult = {
    success: true;
    candleLaunched: false;
    chain: Chain;
    mint: string;
} | {
    success: true;
    candleLaunched: true;
    chain: Chain;
    mint: string;
    tier: string | null;
    quoteMint: string | null;
    graduated: boolean;
    pool: string | null;
    createdAt: number;
    creator: string | null;
    viaAgentKey: boolean;
    /** Hood only: curve/factory/configHash/dexVersion, re-verifiable against the registry. */
    provenance?: Record<string, string>;
    /** Solana only: the program and attribution signer indexers re-verify against. */
    attribution?: {
        program: string;
        signer?: string;
    };
};
/** GET /api/v1/users/:idOrWallet/agent, unwrapped from `{ success, agent }`. */
export interface AgentProfile {
    enabled: boolean;
    address: string;
    username: string | null;
    launches: number;
    launchesViaApi: number;
}
/**
 * GET /api/v1/agent/tier response, returned whole (same convention as `verify()`: the top-level
 * body IS the useful object, no envelope to unwrap). Dual auth: an agent key works here, and so
 * does a Privy session cookie, which is how the `/dev/agent` dashboard's tier strip fetches this
 * same endpoint directly rather than through this SDK. `feeTotals[].feeRawSum` is a raw-unit
 * BigInt string (lamports, wei, etc.); never coerce it with `Number()`.
 */
export interface AgentTierInfo {
    success: true;
    /** Display tier: max > pro > believer > free. */
    tier: "free" | "believer" | "pro" | "max";
    /** Live-evaluated tier, independent of the Believer key-issuance label. */
    liveTier: "free" | "pro" | "max";
    stakedCndl: number;
    heldCndl: number;
    thresholds: {
        minStakedCndl: number;
        minHeldCndl: number;
        graceMs: number;
    };
    /** `startedAt` is null unless `active` (see the endpoint's own doc for why). */
    grace: {
        active: boolean;
        startedAt: number | null;
    };
    maxTierExpiresAt: number | null;
    /** The account's resolved platform fee, in bps, on API-built value-moving transactions. */
    feeBps: number;
    feeTotals: Array<{
        chain: Chain;
        quoteAsset: string;
        feeRawSum: string;
        count: number;
    }>;
}
/**
 * One user-set per-transaction spend cap, mirroring `SpendLimit` in
 * `apps/api/src/lib/agent-policy.ts` and what `GET`/`PUT /api/v1/agent/limits` read and write.
 * `asset` is `"sol" | "usdc" | "cndl"` on Solana or `"eth" | "usdg"` on Hood/EVM; `maxPerTxRaw` is
 * a positive base-10 integer string of the asset's raw base-unit amount (same raw-string
 * convention as `CurveTerms.thresholdRaw` above). Defined locally, not imported from
 * `@candle/shared`, per this file's near-zero-dependency design rule.
 */
export interface SpendLimit {
    asset: string;
    maxPerTxRaw: string;
}
/**
 * `GET /api/v1/agent/keys/self/limits` response (roadmap C, Task 5): the CALLING key's own
 * spend-limit configuration, exactly as the server-side gate resolves it
 * (`apps/api/src/lib/spend-limit-gate.ts`'s `checkSpendAgainstLimits`) -- a per-key cap REPLACES
 * the account cap for any asset it mentions; an asset the key does not mention falls through to
 * the account's cap for whichever wallet pays (`main` or `linked`).
 *
 * Deliberately the RAW inputs, not a single collapsed "effective cap per asset": when the key has
 * no cap for an asset and `accountLimits.main`/`accountLimits.linked` differ, there is no one
 * number to report -- it depends on which wallet the trade pays from. Resolve it the same way the
 * gate does: `keyLimits?.find((l) => l.asset === asset)?.maxPerTxRaw ??
 * accountLimits[scope]?.find((l) => l.asset === asset)?.maxPerTxRaw` (undefined means unlimited).
 */
export interface SpendLimitsResult {
    success: true;
    keyLimits: SpendLimit[] | null;
    accountLimits: {
        main: SpendLimit[] | null;
        linked: SpendLimit[] | null;
    };
}
/** POST /api/v1/agent/wallets/import/submit response: the linked-wallet row summary. */
export interface ImportWalletResult {
    success: true;
    id: string;
    address: string;
    chain: WalletChain;
    privyWalletId: string;
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
    _id: string;
    chain: WalletChain;
    address: string;
    label?: string;
    privyPolicyId?: string;
    signerQuorumId?: string;
    revokedAt?: number;
    addedVia: "agent" | "session";
}
/** GET /api/v1/agent/wallets response: one page of the account's linked wallets. */
export interface ListWalletsResult {
    success: true;
    page: LinkedWalletRow[];
    isDone: boolean;
    continueCursor: string | null;
}
export type TradeSide = "buy" | "sell";
/** Who pays for a trade: the account's own delegated wallet ("main"), or an imported linked wallet. */
export type TradePayer = {
    type: "main";
} | {
    type: "linked";
    linkedWalletId: string;
};
/** POST /api/v1/trade/agent/build request body. */
export interface BuildTradeRequest {
    /** Idempotency key, unique per account; shared with the matching confirmTrade() call. */
    clientTradeId: string;
    mint: string;
    side: TradeSide;
    /** Buy: quote-asset raw units to spend. Sell: base-token raw units to sell. */
    amountRaw: string;
    payer: TradePayer;
    /** Bps, 0-10000. Server defaults to 100 (1%) when omitted. */
    maxSlippageBps?: number;
    /**
     * Which asset to quote this trade in. Applies only when trading a non-Candle-launched token
     * (Pro/Max); ignored for a Candle token, whose curve/pool quote asset is fixed. The server
     * defaults it when omitted.
     */
    quoteAsset?: "sol" | "usdc" | "cndl";
}
/** The platform fee actually itemized on this trade. `treasury` is null only when the fee is disabled server-side (unset AGENT_FEE_TREASURY_*). */
export interface TradeFee {
    bps: number;
    feeRaw: string;
    treasury: string | null;
}
/** Solana "built" artifacts: one unsigned transaction, the fee (if any) already embedded inside it. */
export interface SolanaTradeArtifacts {
    venue: "curve" | "jupiter";
    transactionBase64: string;
    quoteAsset: string;
    quoteMint: string;
    quoteDecimals: number;
}
/**
 * Hood "built" artifacts: up to three calldata legs. Send order matters and is fixed: `approval`
 * (present only when the payer's existing ERC-20 allowance is insufficient), then `trade`, then
 * `feeTransfer` (present only when a fee applies). Hood cannot batch calls the way one Solana
 * transaction can carry multiple instructions, so each leg is its own transaction.
 */
export interface HoodTradeArtifacts {
    venue: "curve";
    trade: {
        to: string;
        data: string;
        value: string;
    };
    approval?: {
        to: string;
        data: string;
    };
    feeTransfer?: {
        to: string;
        data: string;
        value: string;
    };
    quoteAsset: string;
    quoteDecimals: number;
}
/**
 * POST /api/v1/trade/agent/build response for a LINKED payer: an unsigned artifact for the agent
 * to sign and broadcast itself, then report to confirmTrade(). `chain` discriminates `artifacts`.
 */
export type BuildTradeBuiltResult = {
    success: true;
    status: "built";
    clientTradeId: string;
    chain: "solana";
    artifacts: SolanaTradeArtifacts;
    fee: TradeFee;
    expectedOutRaw: string;
    minOutRaw: string;
    expiresAt: number;
} | {
    success: true;
    status: "built";
    clientTradeId: string;
    chain: "hood";
    artifacts: HoodTradeArtifacts;
    fee: TradeFee;
    expectedOutRaw: string;
    minOutRaw: string;
    expiresAt: number;
    /** The linked payer's own checksummed EVM address: the transaction `from`, and the nonce query subject. */
    walletAddress: string;
};
/**
 * A trade that has already run: a MAIN payer's inline execution (buildTrade()'s own response, no
 * confirmTrade() call needed at all) or a linked payer's verified confirmTrade() result (including
 * an idempotent replay of a trade already confirmed). `signature` is a Solana transaction
 * signature or a Hood transaction hash, matching `chain`.
 */
export interface ExecutedTradeResult {
    success: true;
    status: "executed";
    clientTradeId: string;
    chain: Chain;
    signature: string;
    /**
     * The fee-bearing signature, when tracked separately from `signature`. Solana: absent for a
     * main payer (the fee rides inside the same transaction `signature` already covers); always
     * equal to `signature` for a confirmed linked payer (confirmTrade() claims the broadcast
     * signature itself as its anti-reuse guard, fee or not). Hood: the fee transfer's own tx hash,
     * present only when a fee actually landed.
     */
    feeSignature?: string;
    fee: TradeFee;
    amounts: {
        amountRaw: string;
        expectedOutRaw: string;
        minOutRaw: string;
        quoteAsset: string;
    };
}
/** POST /api/v1/trade/agent/build response: "built" for a linked payer, "executed" for a main payer (or an idempotent replay of an already-confirmed trade under the same clientTradeId). */
export type BuildTradeResult = BuildTradeBuiltResult | ExecutedTradeResult;
/**
 * POST /api/v1/trade/agent/confirm request body. Solana reports its transaction signature; Hood
 * reports its trade transaction hash and, ONLY when the matching build's `fee.feeRaw` was
 * non-zero, the fee transfer's own transaction hash (omitting it there is refused
 * `FEE_LEG_MISSING`).
 */
export type ConfirmTradeRequest = {
    clientTradeId: string;
    signature: string;
} | {
    clientTradeId: string;
    tradeTxHash: string;
    feeTxHash?: string;
};
/** POST /api/v1/trade/agent/confirm response. Always "executed": confirm only ever verifies and records a trade that already happened on-chain. */
export type ConfirmTradeResult = ExecutedTradeResult;
/**
 * POST /api/v1/trade/agent/submit request body. `signedTransactions` is the ordered signed legs:
 * one for Solana; one to three for Hood in the fixed approval, trade, feeTransfer order (omitting
 * a leg that was not built). The server broadcasts them itself and confirms inline, so there is no
 * separate confirmTrade() call after this one.
 */
export interface SubmitTradeRequest {
    clientTradeId: string;
    signedTransactions: string[];
}
/**
 * The exact fields Privy's `eth_signTransaction` RPC expects under `params.transaction`. The
 * caller assembles these (nonce via eth_getTransactionCount, fee fields via
 * eth_maxPriorityFeePerGas/the latest block's base fee, gas_limit via eth_estimateGas, chain_id
 * via eth_chainId) -- signLinkedTransaction() only forwards them, it does not fetch or compute
 * any of them itself.
 */
export interface EvmSignTransactionParams {
    from: string;
    to: string;
    nonce: number;
    chain_id: number;
    data: string;
    value: string;
    type: number;
    gas_limit: string;
    max_fee_per_gas: string;
    max_priority_fee_per_gas: string;
}
/** `swapFromLinked()` request: SOL on the linked wallet into ETH/USDG on Hood. */
export interface LinkedSwapRequest {
    from: "SOL";
    to: "ETH" | "USDG";
    /** Lamports, as a decimal string. */
    amountRaw: string;
    /** The linked Solana wallet funding the swap. */
    payer: {
        linkedWalletId: string;
        privyWalletId: string;
    };
    /** The account's OWN linked EVM wallet to receive the output; omitted = the owner's embedded Hood wallet. */
    toWalletId?: string;
    maxSlippageBps?: number;
}
/** `swapFromLinked()` result. `hashes` is the Solana deposit; poll `statusChecks` for the fill. */
export interface LinkedSwapResult {
    hashes: string[];
    expectedOutRaw: string;
    outDecimals: number;
    statusChecks: string[];
    recipient: string;
}
export interface SignLinkedTransactionParams {
    /** The linked wallet's row id: keys the secretStore lookup AND is the relay's :id path segment. */
    linkedWalletId: string;
    /** The SAME wallet's Privy wallet id (from importWallet()'s result), the authorization signature's URL target. */
    privyWalletId: string;
    chain: WalletChain;
    /** Solana only: the unsigned transaction to sign, base64-encoded. */
    unsignedTransactionBase64?: string;
    /** EVM only: the fully-assembled transaction to sign. */
    evmTxParams?: EvmSignTransactionParams;
}
export interface SignLinkedTransactionResult {
    /** Base64-encoded (Solana) or RLP-encoded (EVM), per `encoding`. */
    signedTransaction: string;
    encoding: string;
}
/** trade()'s one-call request: mirrors BuildTradeRequest minus clientTradeId/payer, plus who signs. */
export interface TradeRequest {
    mint: string;
    side: TradeSide;
    /** Buy: quote-asset raw units to spend. Sell: base-token raw units to sell. */
    amountRaw: string;
    /** "main": the account's own delegated wallet, executed inline. A linked wallet: signed and broadcast by the caller via the sign relay. */
    from: "main" | {
        linkedWalletId: string;
        privyWalletId: string;
    };
    /** Bps, 0-10000. Server defaults to 100 (1%) when omitted. */
    maxSlippageBps?: number;
    /**
     * Which asset to quote this trade in. Applies only when trading a non-Candle-launched token
     * (Pro/Max); ignored for a Candle token, whose curve/pool quote asset is fixed. The server
     * defaults it when omitted.
     */
    quoteAsset?: "sol" | "usdc" | "cndl";
    /** Idempotency key shared by the build and confirm calls; generated ("sdk-" + UUID) when omitted. */
    clientTradeId?: string;
}
/** selfLaunch()'s one-call request: BuildSelfLaunchRequest plus the linked wallet's Privy wallet id. */
export type SelfLaunchRequest = BuildSelfLaunchRequest & {
    /** The linked wallet's Privy wallet id (from importWallet()'s result). */
    privyWalletId: string;
};
export declare class CandleClient {
    private readonly apiUrl;
    private readonly apiKey?;
    private readonly fetchImpl;
    private readonly maxRetries;
    private readonly privyAppId?;
    private readonly secretStore?;
    private readonly solanaRpcUrl?;
    private readonly evmRpcUrl?;
    constructor(opts: CandleClientOptions);
    getQuotePairs(chain?: Chain): Promise<QuotePairsPayload>;
    getPresets(): Promise<PresetsPayload>;
    /**
     * LOCAL preset expansion, no fetch: merges a preset from an already-fetched `getPresets()`
     * payload with the caller's overrides into a launch body. Overrides win. Throws a plain
     * `Error` on an unknown preset name. The result still needs `name`/`symbol`/`imageUrl`
     * (typically supplied via `overrides`); the server remains the authoritative validator.
     */
    expandPreset(presets: PresetsPayload, name: string, overrides?: Partial<LaunchRequest>): LaunchRequest;
    getMarket(chain: Chain, mint: string): Promise<MarketState>;
    getQuote(chain: Chain, mint: string, q: {
        side: "buy" | "sell";
        amountIn: string;
        slippageBps?: number;
    }): Promise<QuoteResult>;
    getFeed(bucket: FeedBucket, chain?: Chain): Promise<FeedResult>;
    verify(chain: Chain, mint: string): Promise<VerifyResult>;
    getAgentProfile(idOrWallet: string): Promise<AgentProfile>;
    /**
     * The calling account's tier snapshot: display/live tier, staked/held CNDL, qualification
     * thresholds, grace window state, resolved fee bps, and lifetime fee totals by chain/asset.
     * Not a "keyed endpoint" in the `requireKey()` sense below: the server accepts either an agent
     * key or a Privy session, so this method sends whatever `x-api-key` the client was constructed
     * with (possibly none) and lets the server's own auth middleware decide.
     */
    getAgentTier(): Promise<AgentTierInfo>;
    dryRunLaunch(req: LaunchRequest): Promise<DryRunResult>;
    /**
     * Blocking launch with idempotent retries. Generates `clientLaunchId` when absent and
     * re-sends the SAME id on retryable failures; see the module doc for the exact policy.
     */
    launch(req: LaunchRequest): Promise<LaunchResult>;
    /**
     * Fire-and-poll launch: sends `async: true`, returns the 202 body. Single attempt (poll
     * `waitForLaunch` instead of retrying the POST). Generates `clientLaunchId` like `launch()`
     * so the returned body always carries the id to poll.
     */
    launchAsync(req: LaunchRequest): Promise<AcceptedJob>;
    getLaunchJob(clientLaunchId: string): Promise<LaunchJob>;
    /**
     * Polls the jobs endpoint until the attempt is terminal (`confirmed` or `failed`; the caller
     * branches on `status`). Throws a plain `Error` once `timeoutMs` (default 3 minutes) passes
     * without a terminal status; the launch itself keeps running server-side, so on timeout poll
     * again or verify on-chain before starting over under a NEW clientLaunchId.
     */
    waitForLaunch(clientLaunchId: string, opts?: {
        timeoutMs?: number;
        pollMs?: number;
    }): Promise<LaunchJob>;
    reportActivity(chain: Chain, signature: string): Promise<unknown>;
    /**
     * Uploads raw image bytes to POST /api/v1/uploads/agent-image (ships in Phase 2 wave 3) and
     * returns the hosted URL, immediately usable as a launch body's `imageUrl`.
     */
    uploadImage(bytes: Uint8Array, contentType: string): Promise<{
        imageUrl: string;
    }>;
    /**
     * Lists this account's linked wallets (GET /api/v1/agent/wallets), active rows first.
     * Active-only by default (Agent Pilot Phase 1, Task 2): pass `includeRevoked: true` to also
     * see revoked (tombstoned) rows. The query string stays clean when `includeRevoked` is
     * omitted/false -- `?includeRevoked=true` is appended only when the caller asks for it.
     */
    listWallets(opts?: {
        includeRevoked?: boolean;
    }): Promise<ListWalletsResult>;
    /**
     * Reads this key's own effective spend limits (roadmap C, Task 5), so an agent can self-throttle
     * before a trade or launch ever hits `SPEND_LIMIT_EXCEEDED`. Read-only: raising a cap always
     * requires a Privy session (the portal), never this SDK -- see `SpendLimitsResult` for how to
     * resolve the raw `keyLimits`/`accountLimits` into the cap that applies to a given trade.
     */
    getSpendLimits(): Promise<SpendLimitsResult>;
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
     *
     * `initialSpendLimits` (Agent Pilot Phase 1, Task 4), sent as `initialLinkedLimits` in the
     * submit body, lets the FIRST import also seed the account's `linked` spend-limit scope in one
     * call, instead of a separate `PUT /api/v1/agent/limits` afterward. It only takes effect when
     * the account's linked scope is currently unset -- that scope is account-wide, shared by every
     * linked wallet, not per-wallet -- so it is silently ignored on any later import once a linked
     * cap already exists. Omit it entirely to leave the account's linked scope exactly as it is
     * (unlimited by default); this is opt-in only, never a forced default. See "Account spend
     * limits" in docs/headless-launch.md for the full model, including what a cap does and does not
     * bound.
     */
    importWallet(params: {
        chain: WalletChain;
        address: string;
        privateKey: string;
        signerPublicKey: string;
        label?: string;
        initialSpendLimits?: SpendLimit[];
    }): Promise<ImportWalletResult>;
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
    buildSelfLaunch(req: BuildSelfLaunchRequest): Promise<BuildSelfLaunchResult>;
    /**
     * Self-signed launch confirm: verifies the agent's own broadcast on-chain, then records the
     * launch identically to the headless path. Signature is the transaction hash from the agent's
     * own broadcast. devBuySignature (Hood only) is the optional follow-up dev-buy transaction. See
     * selfLaunch() below for the one-call version of this whole flow (Solana).
     */
    confirmSelfLaunch(req: ConfirmSelfLaunchRequest): Promise<ConfirmSelfLaunchResult>;
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
    buildTrade(req: BuildTradeRequest): Promise<BuildTradeResult>;
    /**
     * Confirm a LINKED payer's own broadcast trade: Candle verifies it landed on-chain, that it was
     * actually signed/sent by the declared linked wallet, that it moved this trade's own mint in
     * the right direction, and -- when the build carried a fee -- that the fee transfer landed too,
     * BEFORE recording anything. A main payer's trade never reaches this call: it already completed
     * inline at `buildTrade()`, and confirming it is rejected `VALIDATION_FAILED`. Idempotent:
     * confirming an already-confirmed `clientTradeId` replays the stored result without
     * re-verifying anything on-chain.
     */
    confirmTrade(req: ConfirmTradeRequest): Promise<ConfirmTradeResult>;
    /**
     * Server-side alternative to the sign-then-confirmTrade() round trip above: hand the server the
     * already-signed legs (produced by signLinkedTransaction(), still unbroadcast) and it broadcasts
     * them itself, then confirms inline. One call instead of two; no client-side broadcast, no
     * separate confirmTrade() call.
     */
    submit(req: SubmitTradeRequest): Promise<ExecutedTradeResult>;
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
    signLinkedTransaction(params: SignLinkedTransactionParams): Promise<SignLinkedTransactionResult>;
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
    broadcastSignedTransaction(chain: WalletChain, signedTransaction: string, encoding: string): Promise<string>;
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
    swapFromLinked(req: LinkedSwapRequest): Promise<LinkedSwapResult>;
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
    trade(req: TradeRequest): Promise<ExecutedTradeResult>;
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
    selfLaunch(req: SelfLaunchRequest): Promise<ConfirmSelfLaunchResult>;
    /**
     * The `EvmRpc` seam packages/sdk/src/evm-tx.ts's helpers are built against, built from this
     * client's own `jsonRpcCall`/`jsonRpcCallRaw` closed over `evmRpcUrl`. Callers must have already
     * checked `evmRpcUrl` is set (trade()/selfLaunch() do, with a clear error naming it, before
     * calling this).
     */
    private evmRpc;
    /**
     * Assembles, signs, broadcasts, and waits for the mined receipt of ONE Hood leg, returning its
     * transaction hash. Shared by trade()'s and selfLaunch()'s Hood branches, both of which must run
     * their legs strictly sequentially -- see trade()'s jsdoc for why a later leg's `estimateGas`
     * depends on an earlier leg already being mined.
     */
    private signBroadcastAndWaitEvmLeg;
    private requireKey;
    private headers;
    private requestJson;
    private parseResponse;
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
    private jsonRpcCall;
    /**
     * Same POST as jsonRpcCall() above, for RPC methods whose `result` is an OBJECT or `null`
     * rather than a string -- eth_getBlockByNumber (a block) and eth_getTransactionReceipt (a
     * receipt, or null before it is mined). Skips jsonRpcCall()'s string guard, since a non-string
     * (including null) result is the normal, valid shape here. This is the `rpc.callRaw` seam
     * packages/sdk/src/evm-tx.ts's helpers are built against, wired up via evmRpc() above. Throws
     * the same structured `JsonRpcError` as jsonRpcCall() on a JSON-RPC `error` envelope.
     */
    private jsonRpcCallRaw;
}
//# sourceMappingURL=client.d.ts.map