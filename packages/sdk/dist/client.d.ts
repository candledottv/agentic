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
 * - `x-api-key` is attached when the client has a key, except on public tokenPages reads. The write/keyed
 *   endpoints (launch, dry run, jobs, activity, uploads) refuse to fetch at all without one,
 *   throwing a plain `Error` that names the missing option, so a misconfigured agent fails
 *   fast and locally instead of with a server 401.
 * - Embedded launch retries: `launch()` fills in `clientLaunchId` ("sdk-" + UUID) when the
 *   caller omits one and re-sends the SAME id on network errors, non-envelope 5xx responses,
 *   retryable envelopes with 5xx status, and the retryable in-flight 409. It never retries a
 *   non-retryable envelope (IDEMPOTENCY_CONFLICT with a different body, LAUNCH_DISABLED, every
 *   validation error), and it never retries a launch whose stage is `executed` or `unconfirmed`
 *   or whose error already names a mint. Backoff is 250ms * 2^n, jittered to 50-100% of that,
 *   capped at 8s, bounded by `maxRetries` (default 3 retries after the initial attempt).
 * - The id on every outcome. The six one-call write methods (`trade()`, `launch()`,
 *   `launchAsync()`, `selfLaunch()`, `buildAtomicLaunch()`, `launchAtomic()`) send one idempotency
 *   id per call, the caller's or a generated one, and once the first request carrying it has been
 *   sent, every exit exposes that id: on the returned value, and on the thrown error
 *   (`operationIds(error)`). A `CandleApiError` or `JsonRpcError` keeps its class and gains the id;
 *   anything else (a rejected fetch, a 2xx body that is not JSON, a plain Error from one of the
 *   method's own steps) is wrapped once, at the outermost method, in a `CandleOperationError` with
 *   the original as `cause`. An error raised before anything was sent (no API key) carries no id
 *   and is not wrapped. The SDK never reuses an id between calls and adds no retry of its own: a
 *   call that passes no id is a new operation. The retry is the caller's, with the id passed back.
 *   The README's "Retrying a write that failed or timed out" is the caller-facing procedure.
 */
import { type SignedTradeLeg } from "./errors";
import { type HyperliquidNetwork, type HyperliquidSubmitOutcome, type HyperliquidTypedData } from "./hyperliquid";
import { type PerpsTpslParams, type PerpsWorkflowResult } from "./hyperliquid-manage";
import { type PerpsBookOptions, type PerpsBookResult, type PerpsCandlesOptions, type PerpsCandlesResult, type PerpsMarketResult, type PerpsMarketsOptions, type PerpsMarketsResult } from "./hyperliquid-markets";
import type { HyperliquidPnlSection } from "./hyperliquid-pnl";
import { type PerpsAccountLine, type PerpsAccountReport, type PerpsPortfolioSection, type PerpsPositionRow, type PerpsRiskReport, type PerpsRiskSettings, type PerpsRiskThresholds, type PerpsRiskThresholdsReport, type PerpsWatchEvent } from "./hyperliquid-risk";
import { type PerpsWithdrawAuthorization, type PerpsWithdrawBuild, type PerpsWithdrawPins } from "./hyperliquid-withdraw";
import type { GeneratedLaunchFields } from "./launch-definition";
import { type PerpsFillsPage, type PerpsFundingPage, type PerpsHistoryOptions } from "./perps-history";
import type { AgentPlansResult, PlanPrice, PlanTable } from "./plans";
import type { SecretStore } from "./secret-store";
import type { CandleStaking } from "./staking";
import { type ClusterResult } from "./token-clusters";
import { type WalletChain } from "./wallet-import";
export type Chain = "solana" | "hood";
/**
 * The two shipped tiers plus their low-threshold TEST twins (~1/80 economics, same identity and
 * NFT gate; see docs/superpowers/specs/2026-08-04-test-curve-configs-design.md). Test tiers are
 * creatable only where the API's ENABLE_TEST_CURVES flag is on; the server refuses them
 * otherwise, so client code needs no gate of its own.
 *
 * Then the experimental fast curves (Solana, SOL or CNDL): the presets `exp-a`, `exp-b` and
 * `exp-c`, and `exp-custom`, which takes the launcher's own V and G in `curve`. `exp-custom` is
 * creatable only where the API has EXP_CUSTOM_CURVES on; elsewhere it is refused as an unknown mode.
 */
export type LaunchTier = "open" | "exclusive" | "test-open" | "test-exclusive" | "exp-a" | "exp-b" | "exp-c" | "exp-custom";
/**
 * `finalstretch`: pump.fun tokens at 50% or more of their bonding curve, most complete first; no delta, read the whole list.
 * It exists only where the API has it switched on; elsewhere it is refused like an unknown bucket.
 * `bluechip` is deprecated and will be removed.
 */
export type FeedBucket = "new" | "graduated" | "onfire" | "bluechip" | "finalstretch";
export interface CandleClientOptions {
    /** Base URL of the Candle API, e.g. "https://api.alpha.candle.tv" (the alpha deployment). Trailing slashes are trimmed. */
    apiUrl: string;
    /** Agent API key (cndl_live_... / cndl_test_...). Required for launch, jobs, activity, uploads. */
    apiKey?: string;
    /** Injectable fetch for tests; defaults to the global. */
    fetch?: typeof fetch;
    /**
     * Allow an `http://` {@link apiUrl} pointing at a NON-loopback host. Off by default: this client
     * attaches `x-api-key` to every authenticated call, so cleartext hands the key to anything on the
     * path, and a redirect to HTTPS is too late to help. Loopback (`localhost`, `127.0.0.0/8`, `::1`)
     * is always allowed and needs no flag. Set this only for a trusted local endpoint that is not
     * loopback, such as a devcontainer reaching its host.
     */
    allowInsecureHttp?: boolean;
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
    /**
     * Candle's Hyperliquid builder address, pinned by the caller. Every perps build is checked
     * against it before signing: an order must name exactly this builder (or none, on a Max order),
     * and setup must approve exactly it. This deliberately replaces the release trust anchor and
     * is shown as `preview.builderTrust.source: "override"`. Must be a nonzero EVM address; an
     * invalid override refuses setup/signing. Unset uses the release pin, never `/perps/config`.
     */
    hyperliquidBuilder?: string;
    /** The Hyperliquid network this client trades on. Default mainnet; a build for another is refused. */
    hyperliquidNetwork?: HyperliquidNetwork;
    /**
     * The withdrawal pins every withdrawal is checked against before anything is signed: the
     * perps-USDC `token`, `destinationDex`, Relay's depository allow-list and the amount's string
     * form. Unset, this release's `CANDLE_PERPS_WITHDRAW_PINS` applies (the values V-A recorded on
     * 2026-10-18). Pins of null would refuse every withdrawal with nothing signed.
     */
    perpsWithdrawPins?: PerpsWithdrawPins;
    /**
     * The header-capable WebSocket constructor {@link CandleClient.perpsStream} opens through.
     * Default resolution: the global WebSocket (Bun, Node 22+), then undici's WebSocket (this
     * package's runtime dependency, covering Node 18 and 20, which ship no global one), then a
     * clear error. Inject one only to route through your own implementation or a pinned undici.
     */
    perpsStreamWebSocket?: new (url: string, options: PerpsStreamSocketOptions) => PerpsStreamWebSocket;
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
/**
 * Solana pool fee at graduation: a flat tier in bps, or an anti-snipe fall from `startBps` (at most
 * 2500) to `endBps` over `minutes` (at most 30). Omitted, the pool keeps today's flat 50 bps.
 */
export type PoolFee = {
    tier: 25 | 50 | 100;
} | {
    startBps: number;
    endBps: 25 | 50 | 100;
    minutes: number;
};
/**
 * The `graduation` block of a dry run, present only when the launch chose a non-default pool fee or
 * shape. Estimates are at the graduation threshold; the final burn follows the frozen on-chain price.
 */
export interface LaunchGraduationPreview {
    /** The chosen schedule; absent when the launch kept the flat 50 bps pool. */
    poolFeeSchedule?: PoolFee;
    poolOpen?: "curve_price";
    expPoolShape?: "full_range";
    /** Base burned at the threshold, raw. */
    estimatedBurnRaw?: string;
    /** Base seeded into the pool at the threshold, raw. */
    estimatedSeedRaw?: string;
    /** curve_price only: the most bps the staker carve plus the team allocation can add up to on this tier. */
    maxStakerCarveBps?: number;
    /** The fee at pool open (a falling schedule's start). */
    startBps?: number;
    /** Where a falling schedule settles. */
    endBps?: number;
    shape?: "curve_price" | "legacy" | "full_range" | "floor";
    burnsRemainder?: boolean;
}
/**
 * `mode: "exp-custom"` only, and required there: the launcher-chosen curve, in WHOLE units of the
 * quote asset (sol or cndl) as decimal strings, never raw units. `"12"` is 12 SOL.
 */
export interface LaunchCurve {
    /** V: the virtual quote the curve starts with. */
    virtualQuote: string;
    /** G: the quote the curve raises before it graduates. */
    threshold: string;
}
/** Shared launch fields, plus SDK wallet identifiers and the legacy raw first buy. */
export interface LaunchRequest extends Omit<GeneratedLaunchFields, "wallet" | "dryRun"> {
    /** Omitted means embedded. A TEE wallet may be named by label, address or id. */
    wallet?: string | {
        linkedWalletId: string;
        privyWalletId: string;
    };
    /** @deprecated Use buy, a decimal string in whole quote units, for one release. */
    buyAmount?: number | string;
}
/** POST /api/v1/launch/self/build request body. Extends LaunchRequest with linkedWalletId. */
export interface BuildSelfLaunchRequest extends Omit<LaunchRequest, "wallet" | "buy"> {
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
export interface BuildSelfLaunchAtomicResult extends BuildAtomicLaunchResult {
    mint: string;
    pool: string;
    /** Positive Solana creator buys use the atomic submitter, never individual RPC broadcasts. */
    transaction?: never;
}
export type BuildSelfLaunchResult = BuildSelfLaunchSolanaResult | BuildSelfLaunchHoodResult | BuildSelfLaunchAtomicResult;
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
/**
 * An `exp-` launch's curve terms, on every launch response of those modes. Display figures from the
 * closed form, before fees.
 */
export interface LaunchCurveTerms extends CurveTerms {
    /** V in the quote's raw units. */
    virtualQuoteRaw?: string;
    /** The first buy `firstBuySupplyPct` prices, raw. */
    firstBuyRaw?: string;
    /** That buy's share of the whole supply, before fees, as a percentage. */
    firstBuySupplyPct?: number;
}
/** One venue's fee on a trade of one whole quote unit, in whole quote units. */
export interface LaunchPreviewFeeLine {
    feeBps: number;
    fee: number;
    /** What the token's earning slot receives: half the base fee, and any extra creator fee in full. */
    creatorShare: number;
    /** What the platform receives: the other half of the base fee. */
    platformShare: number;
}
/**
 * The launch preview a dry run returns as `curveTerms`, on every mode, from servers that have it.
 * `firstBuyRaw` is the request's own `buyAmount` (a reference buy when it is 0) and
 * `firstBuySupplyPct` that buy's share before fees.
 */
export interface LaunchPreviewTerms extends LaunchCurveTerms {
    firstBuyRaw: string;
    firstBuySupplyPct: number;
    /** The same buy as the curve program fills it from an empty curve. */
    firstBuy: {
        basis: "buyAmount" | "reference";
        amountRaw: string;
        curveFeeRaw: string;
        /** Tokens received after the curve fee, raw. */
        tokensOutRaw: string;
        supplyPct: number;
    };
    fees: {
        curve: LaunchPreviewFeeLine;
        pool: LaunchPreviewFeeLine;
    };
    migration: {
        venue: "meteora_damm_v2" | "uniswap_v3" | "uniswap_v4";
        poolFeeBps: number;
        /** `floor`: the pool's lower bound is the curve's start price (exp- modes). */
        poolShape: "full_range" | "floor";
        /** The pool's opening price against the curve's last price, percent; negative opens below it. */
        openingPriceStepPct: number;
        lpLock: "permanent";
    };
}
/** The request as a dry run resolved and validated it. */
export interface ResolvedLaunch {
    chain: Chain;
    quoteAsset: string;
    mode: LaunchTier;
    stakerAllocationBps: number;
    /** Present only when the launch has an extra creator fee. */
    creatorFeeBps?: 100 | 200;
    /** `exp-custom` only: the curve as validated and hashed, in the quote's raw units. */
    curve?: {
        virtualQuoteRaw: string;
        thresholdRaw: string;
    };
    dexVersion: "v3" | "v4" | null;
    visibility: string;
    buyAmount: string;
}
/** POST /api/v1/launch/headless/dry-run response. */
export interface DryRunResult {
    success: true;
    dryRun: true;
    /** Wallet the real launch pays from; null when no wallet is available for the resolved chain. */
    launchWallet: string | null;
    resolved: ResolvedLaunch;
    /**
     * The launch preview: the curve's terms, the first buy priced on this request's own buyAmount,
     * the fee lines and the migration terms. Every mode, from servers that have it; an older server
     * sends it on exp- modes only, as `LaunchCurveTerms`.
     */
    curveTerms?: LaunchPreviewTerms;
    /**
     * The dev-buy ceiling this launch is held to, in buyAmount's base units: on an exp- curve the
     * lower of 10% of the threshold and the ordinary ceiling. null for a pair with no dev buy; absent
     * from older servers.
     */
    devBuyMax?: string | null;
    checks: {
        image: string;
        /** `"ok"` when a `bannerUrl` was sent and checked; absent otherwise. */
        banner?: string;
        /**
         * Present only for an exclusive (or test-exclusive) mode, the modes that run the Believer
         * check, and then `true`: an ineligible account gets EXCLUSIVE_NOT_ELIGIBLE instead. Absent in
         * any other mode, where nothing was checked.
         */
        exclusiveEligible?: boolean;
    };
    matrixVersion: number;
    /**
     * Solana only: the assembled launch transaction's size. Absent on Hood, and when the size
     * computation itself failed transiently. A body that would not fit fails the dry run with
     * TRANSACTION_TOO_LARGE instead, so `fits` is always true when present.
     */
    size?: {
        txBytes: number;
        limit: number;
        maxNameBytes: number;
        fits: boolean;
    };
    /** Present only when the launch chose a non-default pool fee or shape. */
    graduation?: LaunchGraduationPreview;
}
/**
 * POST /api/v1/launch/self/dry-run response: the headless dry run's shape, with `launchWallet` the
 * linked or TEE wallet `buildSelfLaunch()` would pay from, and `launchWalletId` its id. Never
 * checks that wallet's balance.
 */
export interface SelfLaunchDryRunResult extends Omit<DryRunResult, "launchWallet"> {
    launchWallet: string;
    launchWalletId: string;
}
/**
 * POST /api/v1/launch/headless blocking (or replayed) success response, plus `clientLaunchId`.
 * The server's body does not carry the id: `launch()`, `selfLaunch()` and `confirmSelfLaunch()`
 * set it from the request they sent, so a caller who let the SDK generate it still has it.
 */
export interface LaunchResult {
    success: true;
    /** The idempotency id this launch was sent under, the caller's or the generated one. */
    clientLaunchId: string;
    chain: Chain;
    mint: string;
    pool: string | null;
    signature: string;
    quoteAsset: string;
    mode: LaunchTier;
    stakerAllocationBps: number;
    /** Present only when the launch has an extra creator fee. */
    creatorFeeBps?: 100 | 200;
    /** An exp- launch's curve terms; absent on every other mode. */
    curveTerms?: LaunchCurveTerms;
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
    /**
     * Set when a headless attempt has broadcast evidence and is not yet confirmed.
     * `executed` / `unconfirmed` means this id is reserved; a later POST resumes it.
     */
    stage?: "executed" | "unconfirmed";
}
export interface MigrationStatus {
    status: "not_started" | "in_progress" | "completed" | "delayed" | "cancelled";
    migratedAt?: number;
    attempts?: number;
    nextAttemptAt?: number;
    gaveUpAt?: number;
}
/** GET /api/v1/tokens/:chain/:mint/events (BE-2094). The three event kinds one list returns. */
export type TokenEventKind = "trade" | "signal" | "callout";
export type TokenEventGroupVisibility = "public" | "pro" | "max" | "internal";
export interface TokenEventGroup {
    name: string;
    visibility: TokenEventGroupVisibility;
}
export interface TokenEventWallet {
    /** Display text (first4…last4) for free/keyless reads; full address for Pro/Max keys. */
    address: string;
    name: string | null;
    walletKind: "dev" | "kol" | "smart" | "agent" | "tracked";
    groups: TokenEventGroup[];
    image: string | null;
    isDev: boolean;
}
export type TokenEvent = {
    id: string;
    chain: Chain;
    mint: string;
    at: number;
    wallet: TokenEventWallet | null;
} & ({
    kind: "trade";
    side: "buy" | "sell";
    usd: number | null;
    tokenAmount: number;
    priceUsd: number | null;
    marketCapUsd: number | null;
    tx: string;
    /** `W` or `L` on a sell whose outcome is known; omitted on buys and unknown sells. */
    result?: "W" | "L" | null;
} | {
    kind: "signal";
    pattern: string;
    summary: string;
    tx: string | null;
} | {
    kind: "callout";
    caller: {
        handle: string | null;
        name: string | null;
        rank: number | null;
    };
    size: number | null;
    marketCapUsd: number | null;
    tx: string;
    status: string;
});
/** One page of a token's events, newest first. `nextCursor` continues it via `before`. */
export interface TokenEventsPage {
    events: TokenEvent[];
    nextCursor: string | null;
}
/**
 * One hacc card fact (BE-2117 `/v1/tokens/:mint/card-facts`, carried whole by the card route).
 * `state: "ok"` has a `value`, `source`, `as_of` and `basis`; anything else has `value: null` and
 * `display: "–"`. A percent fact's `value` is 0 to 100.
 */
export interface TokenCardFact {
    value: number | null;
    display: string;
    state: "ok" | "pending" | "unavailable";
    source: string | null;
    as_of: string | null;
    basis: string | null;
    note: string | null;
}
/** A same-name candidate: another token on a venue whose ticker or name matches. */
export interface TokenCardSameNameCandidate {
    mint: string;
    chain: Chain;
    ticker: string | null;
    name: string | null;
    venue: string | null;
    market_cap_usd: number | null;
    liquidity_usd: number | null;
    pair_created_at: string | null;
    match: "ticker" | "name" | "both" | "self";
    found_by: "dexscreener" | "hacc" | "both";
}
/** hacc's same-name block: which same-name token leads on live market cap, then liquidity. */
export interface TokenCardSameName {
    state: "found" | "none" | "unavailable";
    source: string;
    display: string;
    leader: TokenCardSameNameCandidate | null;
    subject: (TokenCardSameNameCandidate & {
        rank: number | null;
    }) | null;
    trailing: boolean | null;
    others: TokenCardSameNameCandidate[];
    detail: string | null;
}
/** hacc's card facts for one token, as `GET /v1/tokens/:mint/card-facts` answers them (BE-2117). */
export interface TokenCardFacts {
    mint: string;
    chain: Chain;
    as_of: string;
    cache_s: number;
    fields: Record<"bundles" | "snipers" | "insiders" | "fresh_1d" | "fresh_7d" | "avg_wallet_age", TokenCardFact>;
    launch: {
        state: "ok" | "pending" | "failed" | "not_read";
        source: string | null;
        computed_at: string | null;
        deployer: string | null;
        first_buy_at: string | null;
        rows_read: number | null;
        covered_s: number | null;
        truncated: boolean | null;
        detail: string | null;
    };
    holders: {
        source: string | null;
        sampled: number;
        known_age: number;
        detail: string | null;
    };
    same_name: TokenCardSameName;
    ath: {
        source: string;
        stored_usd: number | null;
        stored_at: string | null;
        usable_usd: number | null;
        check: "confirmed" | "unconfirmed" | "over_ceiling" | "below_live" | "unverifiable" | "none";
    };
    vendor_reads: Record<"dexscreener" | "helius" | "cvc" | "blockscout" | "birdeye" | "other", number>;
    cached: boolean;
}
/**
 * GET /api/v1/tokens/:chain/:mint/card (BE-2118): the data behind a token card, the same for every
 * caller and every plan. Facts only, never a score. A field with no source is `null` (show an en
 * dash), and `sources` names where each block came from.
 */
export interface TokenCard {
    chain: Chain;
    mint: string;
    generatedAt: number;
    identity: {
        name: string | null;
        symbol: string | null;
        launchpad: string | null;
        isCandle: boolean | null;
    };
    market: {
        priceUsd: number | null;
        marketCapUsd: number | null;
        liquidityUsd: number | null;
        change5mPct: number | null;
        volume5mUsd: number | null;
        buys5m: number | null;
        sells5m: number | null;
        updatedAt: number | null;
    };
    /** The highest daily price since launch times current supply; null when no source covers it. */
    ath: {
        marketCapUsd: number;
        at: number;
        precision: "day";
        basis: "price times current supply (FDV)";
    } | null;
    /** The forensics route's report, or why there is none (`not_covered` carries its coverage). */
    forensics: {
        state: "ok";
        report: unknown;
    } | {
        state: "not_covered";
        coverage: unknown;
    } | {
        state: "unavailable";
    };
    /** Tracked-wallet trades, signals and callouts in the last hour, at the free tier. */
    events: {
        state: "ok";
        windowMinutes: 60;
        trackedBuys: number;
        trackedSells: number;
        signals: number;
        callouts: number;
        names: string[];
    } | {
        state: "off" | "unavailable";
    };
    hacc: {
        state: "ok";
        facts: TokenCardFacts;
    } | {
        state: "off" | "unavailable";
    };
    sameName: TokenCardSameName | {
        state: "off" | "unavailable";
    };
    sources: Record<"identity" | "market" | "ath" | "forensics" | "events" | "sameName" | "hacc", string>;
    /** Candle's token page, carrying the card source tag when one was given. */
    links: {
        token: string;
    };
}
/** GET /api/v1/markets/:chain/:mint, unwrapped from `{ success, market }`. */
export interface MarketState {
    /** Additive Release A fields are optional when connected to an older API. */
    candleLaunched?: boolean;
    launchpad?: string | null;
    venue?: "candle-curve" | "jupiter" | "dex" | "hood-dex" | null;
    trade?: {
        endpoint: "POST /api/v1/trade/agent/quote";
        routable: boolean;
        reason?: string;
    };
    /** Legacy lifecycle/curve/fee fields are non-authoritative for external tokens. */
    external?: boolean;
    decimals?: number;
    quoteDecimals?: number;
    jupiterOk?: boolean;
    externalTradeable?: boolean;
    paperDiscoveryOk?: boolean;
    organic0LiveOk?: boolean;
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
    recovery?: {
        curve: string;
        quoteToken: string;
        reserveSnapshotRaw: string;
        eligibleSupplyRaw: string;
        surrenderedRaw: string;
        method: "claimRecovery(uint256)";
        requiresApprovalTo: string;
    };
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
    cursor?: string;
    matched?: number;
    scanned?: number;
    warming?: boolean;
    /** True on every `finalstretch` read: replace what you hold, there is no delta. */
    reset?: boolean;
    /** `finalstretch` only. When the list was read; null before the first read. */
    asOf?: string | null;
    /** `finalstretch` only. True when the list is old: an empty `tokens` then means nothing is known. */
    stale?: boolean;
    /** `finalstretch` only. An empty `tokens` means "nothing qualifies" only while `feed.ok`, `exact.ok` and `!stale`. */
    feed?: {
        ok: boolean;
        lastCurveTradeAt: string | null;
        ageS: number | null;
    };
    exact?: {
        ok: boolean;
        lastReadAt: string | null;
    };
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
/** Fields an eligible agent key may edit. Name, slug and visibility stay owner-only. */
export interface OwnAgentProfilePatch {
    publicAvatar?: string | null;
    publicBanner?: string | null;
    publicThesis?: string | null;
    publicStrategy?: string | null;
    publicStrategyNote?: string | null;
    publicModel?: string | null;
    publicModels?: string[] | null;
    publicLinks?: {
        website?: string | null;
        x?: string | null;
    } | null;
}
export interface OwnAgentProfile {
    success: true;
    profileId: string;
    keyPrefix: string;
    profileSelfEdit: "allowed" | "denied";
    canEdit: boolean;
    agentEditsLocked: boolean;
    display: {
        name: string | null;
        avatarUrl: string | null;
        bannerUrl: string | null;
        thesis: string | null;
        strategy: string | null;
        strategyNote: string | null;
        model: string | null;
        models: string[];
        links: {
            website: string | null;
            x: string | null;
        };
    };
}
/** The token a post names: a token Candle shows publicly. The agent need not have traded or launched it. */
export interface AgentPostTokenRef {
    chain: "solana" | "hood";
    mint: string;
}
/** The chip beside a post, linking to the token's Candle page. */
export interface AgentPostToken extends AgentPostTokenRef {
    symbol: string;
    name: string;
    image: string;
}
/** One post on an agent's own page. Tied to no trade or launch. */
export interface AgentPost {
    id: string;
    /** Plain text, 1 to 500 characters, line breaks kept. Render it as text: never as HTML, and a URL in it is not a link. */
    text: string;
    /** Server time, unix ms. */
    createdAt: number;
    /** Null when the post named no token, or when Candle no longer shows the one it named. */
    token: AgentPostToken | null;
}
export interface CreateAgentPostRequest {
    /** 1 to 500 characters. Line breaks are kept; any other control character and bidi characters are refused. */
    text: string;
    token?: AgentPostTokenRef;
}
/** One page of an agent's posts, newest first. `cursor` is null on the last page. */
export interface AgentPostsPage {
    posts: AgentPost[];
    cursor: string | null;
}
export interface ListAgentPostsOptions {
    /** 1 to 50. Default 20. */
    limit?: number;
    /** The previous page's `cursor`. */
    cursor?: string;
}
/** GET /api/v1/users/:idOrWallet/agent, unwrapped from `{ success, agent }`. */
export interface AgentProfile {
    enabled: boolean;
    address: string;
    username: string | null;
    launches: number;
    launchesViaApi: number;
}
/** Claimed fee income on public board entries and records. Older snapshots omit these fields. */
export interface AgentFeeIncome {
    /** Fees earned, valued when claimed, credited to the profile that launched the token. */
    creatorFeesUsd?: number;
    /** Claims without a USD value; excluded from creatorFeesUsd, never valued at zero. */
    feeClaimsUnvalued?: number;
    /** The capped claim read does not cover the whole window; the fee income is a floor. */
    feeClaimsPartial?: boolean;
}
/**
 * The optional board object beside private ledger P&L, also on /keys/pnl rows with a profileId.
 * Rows without a profileId and combined stay ledger-only.
 */
export interface ProfileBoardPnl {
    profileId: string;
    creatorFeesUsd: number;
    feeClaimsUnvalued: number;
    feeClaimsPartial: boolean;
    /** All-time public board total, including claimed fees; absent before a board entry exists. */
    totalPnlUsd?: number;
}
/** One profile row of GET /api/v1/agent/keys/pnl; ledger fields stay separate from board income. */
export interface ProfilePnlSummaryRow {
    profileId: string | null;
    board?: ProfileBoardPnl;
    [key: string]: unknown;
}
/** Public realized figures. feesUsd is fees paid; creatorFeesUsd is separate income. */
export interface AgentRecordTotals extends AgentFeeIncome {
    realizedNetUsd: number;
    feesUsd: number;
    wins: number;
    losses: number;
    counted: number;
    unvalued: number;
    bestUsd?: number;
    worstUsd?: number;
    unrealizedUsd?: number;
    /** Realized net plus unrealized plus creatorFeesUsd, already including moved-in shares. */
    totalPnlUsd?: number;
    realizedFromTransfersUsd?: number;
    unrealizedFromTransfersUsd?: number;
}
/** A public leaderboard entry, including additive fee income beside its trade totals. */
export interface AgentLeaderboardEntry extends AgentFeeIncome {
    profileId: string;
    name: string;
    wallet: string;
    rank: number;
    totals: AgentRecordTotals;
    winRatePct: number | null;
    unrealizedUsd?: number;
    totalPnlUsd?: number;
    totalRank?: number;
    markedAt?: number;
    unrealizedPartial?: boolean;
    windowComplete?: boolean;
    openWins?: number;
    openLosses?: number;
    /** Other identity and coverage fields are preserved by the API. */
    [key: string]: unknown;
}
/** A settled Solana staking claim, newest first; its claim value is not added to P&L again. */
export interface AgentRewardClaim {
    mint: string;
    tokenSymbol: string;
    amount: number;
    usdValue?: number;
    timestampMs: number;
    signature: string;
}
/** GET /api/v1/agent/records/:profileId record, with optional claim projections. */
export interface AgentPublicRecord extends AgentFeeIncome {
    profileId: string;
    name: string;
    wallet: string;
    totals: AgentRecordTotals;
    unrealizedUsd?: number;
    totalPnlUsd?: number;
    rewardClaims?: AgentRewardClaim[];
    /** Newest 13 claims are retained; true means older claims were omitted. */
    rewardClaimsPartial?: boolean;
    /** Existing row, series, identity and coverage fields. */
    [key: string]: unknown;
}
export type AgentHoldingOrigin = "bought" | "movedIn" | "mixed" | "reward";
/** One of the public top ten holdings, returned separately from the public record. */
export interface AgentPublicHolding {
    mint: string;
    chain: Chain;
    symbol?: string;
    valueUsd: number;
    unrealizedUsd?: number;
    origin?: AgentHoldingOrigin;
    /** Bought only with positive cost; reward and mixed holdings omit this. */
    unrealizedPct?: number;
}
/** How `listAgents` orders the directory, each largest first. */
export type AgentDirectorySort = "newest" | "active" | "pnl";
/** One published agent, as `listAgents` returns it. Identity and three aggregates: no wallet, no position. */
export interface AgentDirectoryEntry {
    /** The stable id, `prof_` and 16 hex. `GET /api/v1/agent/records/:profileId` reads its record. */
    profileId: string;
    /** The short address of the agent's page, `/agents/profile/<slug>`, or null. */
    slug: string | null;
    name: string;
    avatarUrl: string | null;
    bio: string | null;
    owner: {
        username: string | null;
    };
    strategy: string | null;
    /** What the owner declared the agent runs on. Shown only: the directory has no model filter. */
    models: string[];
    /** Unix ms. */
    publishedAt: number;
    /** The newest trade, launch or post, unix ms. Null for an agent that has none. */
    lastActiveAt: number | null;
    /** All-time realized plus unrealized plus claimed creator fees, USD, refreshed about every ten minutes. Null until first computed. */
    totalPnlUsd: number | null;
    tradeCount: number;
    launchCount: number;
    /** More launches exist than `launchCount` counted. */
    launchesCapped: boolean;
}
/** One page of the directory. `cursor` is null on the last page, and always for a search. */
export interface AgentDirectoryPage {
    entries: AgentDirectoryEntry[];
    cursor: string | null;
}
export interface ListAgentsOptions {
    /** `newest` (default), `active` or `pnl`. */
    sort?: AgentDirectorySort;
    /** Keep one strategy category, such as `momentum`. An unknown one is refused with 400. */
    strategy?: string;
    /** Match the name, the slug or the owner's handle. At most 25 agents, unpaged. */
    query?: string;
    /** Agents per page, 1 to 48. Default 24. */
    limit?: number;
    /** The previous page's `cursor`. */
    cursor?: string;
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
    /**
     * Display tier: max > pro > believer > free. From the three-plan launch the server sends only
     * `free`, `pro` or `max`; `believer` stays in this type for one release after it, then goes.
     */
    tier: "free" | "believer" | "pro" | "max";
    /** Live-evaluated tier, independent of the Believer key-issuance label. */
    liveTier: "free" | "pro" | "max";
    stakedCndl: number;
    heldCndl: number;
    /** `graceMs` is 0 from the three-plan launch: Pro through CNDL then has no grace window. */
    thresholds: {
        minStakedCndl: number;
        minHeldCndl: number;
        graceMs: number;
    };
    /**
     * `startedAt` is null unless `active` (see the endpoint's own doc for why). `endsAt` is the
     * server's deadline for an open window; absent from an older server. Never active from the
     * three-plan launch.
     */
    grace: {
        active: boolean;
        startedAt: number | null;
        endsAt?: number | null;
    };
    maxTierExpiresAt: number | null;
    /**
     * True when this account HAD Max and it lapsed. False both for an active Max and for an
     * account that never subscribed, which otherwise read identically (`tier: "free"`), and
     * which is exactly the confusion this flag exists to end: the fee below silently became
     * nonzero the moment the plan expired.
     */
    maxExpired: boolean;
    /** When the lapsed grant ended (ms). Present only when `maxExpired`. */
    maxExpiredAt?: number;
    /**
     * Which kind of grant lapsed. Present only when `maxExpired`. `"promo"` is the Max that came free
     * with a first Pro purchase; while the account still pays for Pro, that lapse is not reported.
     * Treat an unknown value as a generic Max expiry.
     */
    maxExpiredSource?: "subscription" | "trial" | "team" | "promo";
    /**
     * The server's own sentence about the lapse, dated, with the renewal link. Relay it verbatim:
     * it is the same copy the CLI doctor row, the MCP notice, and the tier refusals use, so every
     * surface tells the operator one story. Present only when `maxExpired`.
     */
    maxExpiredNotice?: string;
    /** Where to renew. Present only when `maxExpired`. */
    renewalUrl?: string;
    /** The account's resolved platform fee, in bps, on API-built value-moving transactions. */
    feeBps: number;
    feeTotals: Array<{
        chain: Chain;
        quoteAsset: string;
        feeRawSum: string;
        count: number;
    }>;
    /** The live tier's cap floors. Absent from an older server. */
    tierCaps?: {
        rateLimitPerMin: number;
        dailyLaunchCap: number;
        uploadsPerMin: number;
        linkedWallets: number;
    };
    /** When the tier was evaluated (ms), so a caller can say how fresh it is. Absent from an older server. */
    checkedAt?: number;
    /** Max's price. Kept beside `planTable` for compatibility; read `planTable` for every plan. */
    maxPricing?: PlanPrice;
    /** Pro's price, null while Pro is not sold. Absent from a server before the plan table. */
    proPricing?: PlanPrice | null;
    /** The plan table in force, the same one `getPlans()` returns. Absent from an older server. */
    planTable?: PlanTable;
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
    asset: string;
    maxPerTxRaw: string;
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
    success: true;
    keyLimits: SpendLimit[] | null;
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
 * What a linked wallet can do, decided by the server (BE-860): `tee`, a TEE wallet bound to one
 * key; `imported`, a spend-capable wallet from the import flow; `linked`, attribution-only, which
 * cannot sign. Not `SelfWallet.kind`, whose `linked` covers both of the last two.
 */
export type WalletKind = "tee" | "imported" | "linked";
/**
 * One row of `GET /api/v1/agent/wallets`'s `page` array. The server returns the whole linkedWallets
 * row, so a page also carries fields this type does not name (`userAddress`, `addressLower`,
 * `verifiedAt` and others); the type names the ones a caller acts on. Branch on `walletKind` for
 * what a row can do. `revokedAt` set means the row is a tombstone -- `listWallets()` excludes these
 * by default; pass `includeRevoked: true` to see them.
 */
export interface LinkedWalletRow {
    _id: string;
    chain: WalletChain;
    address: string;
    /** The wallet's Privy id: what `selfLaunch()`, `trade()` and `launchAtomic()` sign a linked leg with. */
    privyWalletId: string;
    label?: string;
    privyPolicyId?: string;
    signerQuorumId?: string;
    revokedAt?: number;
    addedVia: "agent" | "session";
    /**
     * What this wallet can do: `tee`, `imported` (spend-capable) or `linked` (attribution-only).
     * Stable; derived by the server. Absent only from an API that predates it (before 2026-10), where
     * `privyPolicyId` present meant spend-capable and its absence attribution-only.
     */
    walletKind?: WalletKind;
    /**
     * Served, but its values are internal code names and not promised (today `"ember-tee"`, or the
     * legacy `"ember-hot"`, on a TEE wallet; absent on every other row). Use `walletKind`.
     */
    profile?: "ember-tee" | "ember-hot";
    /**
     * TEE wallets only: whether the account owner has allowed this wallet to pay for a launch.
     * Absent reads as false. Only the owner can change it (`PUT /api/v1/agent/wallets/:id/capabilities`
     * with a device token or session; the CLI's `candle wallets allow-launch`).
     */
    allowLaunch?: boolean;
}
/** GET /api/v1/agent/wallets response: one page of the account's linked wallets. */
export interface ListWalletsResult {
    success: true;
    page: LinkedWalletRow[];
    isDone: boolean;
    continueCursor: string | null;
}
/**
 * Whether an agent profile spends from every wallet on its account, or only the ones assigned
 * to it.
 *
 * A profile with no explicit scope reads as `"all"` -- that is what every key issued before
 * profiles existed does, and the API resolves the default server-side so a client never has to
 * infer it.
 */
export type ProfileWalletScope = "all" | "selected";
/** One wallet assigned to a profile, as `GET /api/v1/agent/keys/{prefix}/wallets` reports it. */
export interface ProfileWalletRow {
    linkedWalletId: string;
    assignedAt: number;
    chain: WalletChain;
    address: string;
    label?: string;
    /**
     * False for an attribution-only wallet. Such a wallet can be assigned, but it can never sign,
     * so a trade naming it as payer fails regardless of the assignment.
     */
    spendCapable: boolean;
}
/** One position a profile still holds, for the caller to mark against a current price. */
export interface ProfileOpenPosition {
    /** Additive transfer provenance; omitted by an older server or for a position bought by trade. */
    transferredIn?: boolean;
    basisSource?: "candle-wallet" | "chain" | "transfer-price" | "before-window" | "unknown" | "pending" | "mixed" | "zero-cost";
    basisComplete?: boolean;
    movedInFromWallet?: string;
    basisCoveragePct?: number;
    /** Moved-in quantity carried at $0, no purchase found (Solana CNDL). Absent with none or on an older server. */
    zeroCostQuantity?: number;
    mint: string;
    quantity: number;
    avgEntryUsd: number;
    costBasisUsd: number;
    /** The price used to value this position. Absent when no mark was available for the token. */
    markPriceUsd?: number;
    /** When that price was last refreshed. */
    markedAt?: number;
    marketValueUsd?: number;
    /** `marketValueUsd - costBasisUsd`. Absent when unmarked — which is not the same as zero. */
    unrealizedUsd?: number;
    /** The chain this position was traded on. Optional: a server that predates it omits it. */
    chain?: Chain;
    /**
     * The wallet holding it: positions live in wallets, so one token held in two wallets is two
     * positions. `unknown:solana` or `unknown:hood` names the pool for fills no record places in a
     * wallet, which is not an address. Optional: a server that predates 2026-10-02 omits it.
     */
    wallet?: string;
    /**
     * The key this position belongs to, by prefix: the wallet's bound key, else the key whose buy
     * opened it; null for Manual (web-app trades). Optional: a server that predates 2026-10-02 omits it.
     */
    agent?: string | null;
    /** When the round behind this position opened, epoch ms. Optional, as `wallet`. */
    openedTs?: number;
    /** Why there is no mark. Present exactly when `markPriceUsd` is absent, on a server that sends it. */
    unpricedReason?: "no-market-row" | "unusable-price";
    /**
     * Worth under one cent at its mark. Still listed and still counted; `openPositionsExDust` leaves it
     * out. An unpriced position is never dust. Optional: a server that predates 2026-10-02 omits it.
     */
    dust?: true;
}
/** One fully closed private position, with optional recorded-arrival provenance. */
export interface ProfileClosedPosition extends Pick<ProfileOpenPosition, "mint" | "wallet" | "agent" | "transferredIn" | "basisSource" | "basisComplete" | "movedInFromWallet" | "basisCoveragePct" | "zeroCostQuantity"> {
    openedTs: number;
    closedTs: number;
    quantity: number;
    transferredInQuantity?: number;
    soldQuantity: number;
    costBasisUsd: number;
    proceedsUsd: number;
    realizedNetUsd: number;
}
/**
 * Closed positions as one equation (P&L spec PNL-ED-8): `madeUsd + lostUsd + partialSellsUsd`
 * equals the scope's `realizedNetUsd`. A position is closed when its wallet's quantity returns to
 * zero through a sale.
 */
export interface ProfileClosedSummary {
    /** Closed positions, those with unknown cost included. */
    closed: number;
    /** Sum of the closed positions that made money, USD. */
    madeUsd: number;
    /** Sum of the closed positions that lost money, USD: zero or negative. */
    lostUsd: number;
    /**
     * The rest of the realized net: partial sells of positions still open, and fees not in a closed
     * position (a buy fee on an open position, a sell with nothing open).
     */
    partialSellsUsd: number;
    /** Closed positions won and lost, leaving out those with unknown cost. */
    wins: number;
    losses: number;
    /** Closed positions with unknown cost: listed in `closed`, left out of `wins` and `losses`. */
    costUnknown: number;
}
/**
 * Fields every scope of `ProfilePnlResult` gained on 2026-10-02 (the total, each `byChain` entry
 * and each `byWallet` row). Each is optional: a server that predates it omits it.
 */
export interface ProfilePnlEngineFields {
    /** Public moved-in realized share, already included in realizedNetUsd and ranking. */
    realizedFromTransfersUsd?: number;
    /** Public moved-in unrealized share, already included in unrealizedUsd and total P&L. */
    unrealizedFromTransfersUsd?: number;
    /** Realized net plus unrealized: the figure the console labels P&L, to the cent. */
    totalUsd?: number;
    /** Open positions that are not dust. */
    openPositionsExDust?: number;
    /** Closed positions this scope's sales closed. */
    closedRounds?: number;
    /** Money made, minus money lost, plus partial sells, equals `realizedNetUsd`. */
    closed?: ProfileClosedSummary;
}
/**
 * One chain's share of a profile's P&L (`ProfilePnlResult.pnl.byChain`): the total's figures over
 * that chain's fills alone. `openPositions` is a COUNT here; the positions themselves are in
 * `pnl.openPositions`, each carrying its `chain`.
 */
export interface ProfileChainPnl extends ProfilePnlEngineFields {
    realizedGrossUsd: number;
    feesUsd: number;
    realizedNetUsd: number;
    /** Open positions on this chain. */
    openPositions: number;
    unrealizedUsd: number;
    unmarkedPositions: number;
    oldestMarkAt?: number;
    counted: number;
    unvalued: number;
    /** Fills held out because their token has a fill of unknown size. Part of `unvalued`. */
    unresolved: number;
    unresolvedMints: string[];
    friction: {
        feesUsd: number;
        slippageUsd: number;
        slippageBpsAvg?: number;
        measured: number;
        unmeasured: number;
    };
    /** This key's ledger fills on this chain in the window. */
    tradesConsidered: number;
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
    /** Public board figures including fee income; independent of pnl.totalUsd and its coverage. */
    board?: ProfileBoardPnl;
    /**
     * The key's profile on Hyperliquid, every binding period: its own heading and net, also counted
     * in `pnl.totalUsd` when `read` is true (see `perpsInTotal`). Unrealized is at each wallet's live
     * cutoff, and facts stop at that same cutoff. A `read: false` section is never a zero.
     */
    hyperliquid?: HyperliquidPnlSection;
    /**
     * True when `pnl.totalUsd` includes `hyperliquid.netUsd`. False when the section was not read,
     * and then `pnl.totalUsd` is the spot total. Absent from servers that predate it: their
     * `pnl.totalUsd` never included perps.
     */
    perpsInTotal?: boolean;
    success: true;
    keyPrefix: string;
    pnl: ProfilePnlEngineFields & {
        realizedGrossUsd: number;
        /** Candle fees over the counted fills. Reported separately, netted only into realizedNetUsd. */
        feesUsd: number;
        realizedNetUsd: number;
        closedPositions?: ProfileClosedPosition[];
        openPositions: ProfileOpenPosition[];
        /**
         * Unrealized across the positions that could be marked. Read it WITH `unmarkedPositions` and
         * `oldestMarkAt`: a total is only as meaningful as its coverage and the age of the prices
         * behind it.
         */
        unrealizedUsd: number;
        /** Positions with no price available, excluded from `unrealizedUsd` rather than valued at zero. */
        unmarkedPositions: number;
        /** The oldest mark used, epoch ms. Absent when nothing could be marked. */
        oldestMarkAt?: number;
        /** Fills counted, and fills that had no trusted USD price and so were left out entirely. */
        counted: number;
        unvalued: number;
        /** Fills held out because their token has a fill of unknown size. Part of `unvalued`. Optional. */
        unresolved?: number;
        /** The tokens those fills belong to: their P&L is unknown, not zero. Optional. */
        unresolvedMints?: string[];
        /** Fees and measured slippage, reported and never netted a second time. Optional. */
        friction?: {
            feesUsd: number;
            slippageUsd: number;
            slippageBpsAvg?: number;
            measured: number;
            unmeasured: number;
        };
        /** This key's ledger fills in the window. */
        tradesConsidered: number;
        /** The account's activity bound, shared by every private P&L read (it was 500 of this key's trades). */
        lookback: number;
        /** True when the lookback window was full, so this is not a lifetime figure. */
        truncated: boolean;
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
        byWallet?: ProfileWalletPnl[];
        /**
         * The same figures split by chain, both chains always present. A token lives on one chain, so
         * the two sum to the total above. Optional: a server that predates it omits it.
         */
        byChain?: Record<Chain, ProfileChainPnl>;
    };
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
    wallet: string;
    payerType: "main" | "linked";
    /**
     * The chain this wallet paid on, from its trades: an address belongs to one chain. Optional: a
     * server that predates it omits it.
     */
    chain?: Chain;
    /** Present only for a linked wallet. */
    linkedWalletId?: string;
    /** The linked wallet's own label; null for the main wallet or an unlabelled one. */
    label: string | null;
    realizedGrossUsd: number;
    feesUsd: number;
    realizedNetUsd: number;
    openPositions: ProfileOpenPosition[];
    unrealizedUsd: number;
    unmarkedPositions: number;
    oldestMarkAt?: number;
    /** Fills counted, and fills left out of every USD figure (includes `unresolved`). */
    counted: number;
    unvalued: number;
    /** Fills held out because their token has a fill of unknown size. Part of `unvalued`. */
    unresolved: number;
    /** The tokens those fills belong to: their P&L is unknown, not zero. */
    unresolvedMints: string[];
    /** Fees and measured slippage over this wallet's fills, reported and never netted a second time. */
    friction: {
        feesUsd: number;
        slippageUsd: number;
        slippageBpsAvg?: number;
        measured: number;
        unmeasured: number;
    };
    /** This key's ledger fills in the window from this wallet. */
    tradesConsidered: number;
}
/**
 * Why a Hood asset in `PortfolioResult.prices` has no price. Never rendered as zero.
 *
 * - `no-market-row`: Candle has never marked this token.
 * - `unusable-price`: a mark exists and is not a price (zero, negative, not finite).
 * - `stale-mark`: the mark is older than six hours.
 * - `source-unavailable`: the price source did not answer.
 */
export type PortfolioUnpricedReason = "no-market-row" | "unusable-price" | "stale-mark" | "source-unavailable";
/**
 * One entry of `PortfolioResult.prices`. An unpriced entry is `priceUsd: null`, never 0: "worth
 * nothing" and "nobody priced it" are different answers.
 */
export interface PortfolioPrice {
    priceUsd: number | null;
    /**
     * `market` is Candle's own mark, the price P&L marks with; `jupiter` covers Solana tokens Candle
     * does not index; `reference` is a Hood base asset (ETH from Hood's WETH/USDG pools, USDG at its
     * peg).
     */
    source: "market" | "jupiter" | "reference" | null;
    /** When a `market` price was last refreshed, epoch ms. Kept on a stale Hood mark too. */
    updatedAt?: number;
    symbol?: string;
    name?: string;
    /** Why a Hood entry has no price. Set on Hood entries only. */
    unpricedReason?: PortfolioUnpricedReason;
}
/** One SPL token a Solana wallet holds, summed over its accounts under one token program. */
export interface PortfolioSolanaToken {
    /** Optional: a server that predates Hood in the portfolio omits it. */
    chain?: "solana";
    mint: string;
    /** Raw base units as a string. */
    amountRaw: string;
    decimals: number;
    program: "token" | "token-2022";
}
/** A Solana wallet's balances. A failed half is null, never zero, and the address is in `unavailable`. */
export interface PortfolioSolanaWallet {
    /** Optional: a server that predates Hood in the portfolio omits it. */
    chain?: "solana";
    address: string;
    /** Lamports as a string (a u64 does not survive `Number`); null when the SOL read failed. */
    lamports: string | null;
    /** Non-zero token balances; null when the token read failed. */
    tokens: PortfolioSolanaToken[] | null;
}
/** A TEE wallet: its linked-wallet id, label, and whether its remote authority is verified-active. */
export interface PortfolioSolanaTeeWallet extends PortfolioSolanaWallet {
    id: string;
    label?: string;
    active: boolean;
}
/** One ERC-20 a Hood wallet holds. */
export interface PortfolioHoodToken {
    chain: "hood";
    /** The token contract, EIP-55. Price it under `hood:<mint lowercased>`. */
    mint: string;
    /** Raw base units as a string. */
    amountRaw: string;
    decimals: number;
    symbol?: string;
    name?: string;
}
/** A Hood wallet's balances. A failed read is null, never zero, and the address is in `hood.unavailable`. */
export interface PortfolioHoodWallet {
    chain: "hood";
    address: string;
    /** Native ETH in wei, as a string; null when the read failed. */
    wei: string | null;
    /** Non-zero ERC-20 balances, USDG among them; null when the read failed. */
    tokens: PortfolioHoodToken[] | null;
    /** Present when the wallet holds more tokens than Candle lists (200). */
    truncated?: true;
}
/** A Hood TEE wallet: its linked-wallet id, label, and whether its remote authority is verified-active. */
export interface PortfolioHoodTeeWallet extends PortfolioHoodWallet {
    id: string;
    label?: string;
    active: boolean;
}
/** `PortfolioResult.hood`: the account's Hood wallet and its Hood TEE wallets. */
export interface PortfolioHoodSection {
    /** The account's own Hood wallet, when it has one. */
    embedded: PortfolioHoodWallet[];
    tee: PortfolioHoodTeeWallet[];
    /** Hood addresses whose read failed. */
    unavailable: string[];
    /** Hood holdings with no price: ETH where held, and every token. */
    unpriced: number;
    /** The same count, by why. */
    unpricedByReason: Partial<Record<PortfolioUnpricedReason, number>>;
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
    success: true;
    embedded: PortfolioSolanaWallet[];
    tee: PortfolioSolanaTeeWallet[];
    /** Optional: a server that predates Hood in the portfolio omits it. */
    hood?: PortfolioHoodSection;
    prices: Record<string, PortfolioPrice>;
    /** Solana addresses whose read failed. Hood's are in `hood.unavailable`. */
    unavailable: string[];
    complete: boolean;
    /**
     * Whether every wallet Candle knows was listed. False only when that list was cut off.
     * Independent of `complete`. Absent on a server that predates the field.
     */
    walletsComplete?: boolean;
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
    clientTradeId: string;
    createdAt: number;
    status: "built" | "confirmed" | "failed";
    chain: "solana" | "hood";
    side: "buy" | "sell";
    mint: string;
    quoteAsset: string;
    /** What was asked for, raw base units. */
    amountRaw: string;
    /** What actually filled, in base tokens. */
    filledAmount?: number;
    usdValue?: number;
    feeBps: number;
    /**
     * An estimate from the trade's size and rate, scaled by collected over planned fee. 0 when no fee
     * was collected, including when the plan forgoes it.
     */
    feeUsd?: number;
    /**
     * The fee the build planned, in raw units of `quoteAsset`: every venue pays its fee in the quote
     * asset. Absent on a server before 2026-10-05.
     */
    feeRaw?: string;
    /**
     * What the treasury received, in raw units of `quoteAsset`. Confirmed rows only. Equal to
     * `feeRaw` unless it was measured otherwise.
     */
    feeCollectedRaw?: string;
    /**
     * True for a `built` row that holds a signature: the trade is on chain but was not booked.
     * `errorCode` says why. Absent on a server before 2026-10-05.
     */
    landedUnconfirmed?: boolean;
    payerWallet: string;
    venue?: "curve" | "jupiter" | "dex";
    signature?: string;
    errorCode?: string;
}
/** `GET /api/v1/agent/keys/{prefix}/trades` response. */
export interface ProfileTradesResult {
    success: true;
    keyPrefix: string;
    trades: ProfileTradeRow[];
    /**
     * Pass back as `cursor` for the next, older page. Present whenever the page read a full `limit`,
     * so a short or even empty page can still have one: only its absence means the end.
     */
    nextCursor?: string;
}
/** Options for `getProfileTrades`. */
export interface ProfileTradesOptions {
    /** Rows to read, 1 to 1,000. Default 200. */
    limit?: number;
    /** Inclusive lower bound on `createdAt`: an ISO 8601 string, epoch milliseconds, or a `Date`. */
    since?: string | number | Date;
    /** Exclusive upper bound on `createdAt`, in the same forms as `since`. */
    until?: string | number | Date;
    /** A previous page's `nextCursor`, verbatim. */
    cursor?: string;
}
/** `GET /api/v1/agent/keys/{prefix}/wallets` response. */
export interface ProfileWalletsResult {
    keyPrefix: string;
    /** The profile's stable public id, or null for a key minted before profile ids existed. */
    profileId: string | null;
    walletScope: ProfileWalletScope;
    /**
     * The assigned wallets. Under scope `"all"` this list does NOT bound what the profile can
     * spend from -- it can use every wallet on the account regardless of what appears here.
     */
    wallets: ProfileWalletRow[];
}
export type TradeSide = "buy" | "sell";
/** Who pays for a trade: the account's own delegated wallet ("main"), or an imported linked wallet. */
export type TradePayer = {
    type: "main";
} | {
    type: "linked";
    linkedWalletId: string;
};
/**
 * The Jupiter/DFlow race one Solana `jupiter`-venue build ran. Raw amounts and lamports are decimal
 * strings. Present only while DFlow is enabled on the deployment, and never on paper or a replay.
 */
export interface TradeRace {
    jupiterOutRaw: string;
    /** DFlow's quoted output, when it gave an accepted quote. */
    dflowOutRaw?: string;
    /**
     * Why DFlow did not build the transaction: `quote:<reason>`, `build:<reason>` (including
     * `build:priority_fee_over_cap`), or `net:fee_exceeds_edge` when its larger output did not
     * cover its larger priority fee.
     */
    dflowRefusal?: string;
    /** The priority-fee ceiling both builds were given, in lamports. Absent from an older server. */
    priorityFeeCapLamports?: string;
    /** The priority fee decoded from Jupiter's built transaction. Absent when Jupiter built none. */
    jupiterPriorityFeeLamports?: string;
    /** The priority fee decoded from DFlow's built transaction. Absent when DFlow returned none. */
    dflowPriorityFeeLamports?: string;
}
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
    maxPriorityFeeLamports?: number;
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
    quoteAsset?: "sol" | "usdc" | "cndl" | "eth" | "usdg";
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
    bps: number;
    /** Base units of the QUOTE asset. Never the token being traded, on either side. */
    feeRaw: string;
    treasury: string | null;
}
/** Solana "built" artifacts: one unsigned transaction, the fee (if any) already embedded inside it. */
export interface SolanaTradeArtifacts {
    venue: "curve" | "jupiter";
    /**
     * Which quoter built the transaction. On the `jupiter` venue Candle also asks DFlow for a quote and
     * uses it only when its output is strictly larger: net of each venue's priority fee when a leg is
     * SOL, raw otherwise. Otherwise this is `jupiter`. `curve` on the curve venue.
     */
    quoteSource?: "curve" | "jupiter" | "dflow";
    /**
     * The Jupiter/DFlow race on a `jupiter` venue build: Jupiter's quoted output, DFlow's when it gave an
     * accepted quote, and why DFlow did not build the transaction when it did not. Absent on the curve venue.
     */
    race?: TradeRace;
    transactionBase64: string;
    quoteAsset: string;
    quoteMint: string;
    quoteDecimals: number;
}
/** One leg of a route: which venue, which pair, and how much of the order went through it. */
export interface TradeRouteHop {
    exchange: string;
    tokenIn: string;
    tokenOut: string;
    sharePct: number;
    pool?: string;
    /** The pool's STATIC fee tier. A v4 hook can charge on top of it; see `roundTripBps`. */
    fee?: number;
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
    source: "kyber" | "uniswap";
    hops: TradeRouteHop[];
    /** `weth`, `usdg`, `usdg-direct`, `usdg-hop`, `v4`, `bridged-v4`, `v2`. Absent on some aggregator routes, which let `hops` speak. */
    kind?: string;
    priceImpactBps?: number;
    usd?: {
        in?: number;
        out?: number;
        gas?: number;
    };
    hinted?: boolean;
    surplusToVendor?: boolean;
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
    venue: "curve" | "dex";
    trade: {
        to: string;
        data: string;
        value: string;
    };
    approval?: {
        to: string;
        data: string;
    };
    /**
     * Permit2 allowance leg, on v4 sells and on any trade whose input is an ERC-20 the Universal
     * Router pulls through Permit2. Sign it in the documented order, after `approval`.
     */
    permit2Approval?: {
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
    /** The route this build was planned against. Present on the DEX venue. */
    route?: TradeRoute;
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
    /** The linked payer's own base58 address: the wallet that must sign this build. */
    walletAddress: string;
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
        actualOutRaw?: string;
    };
    /**
     * The route the fill actually took, on a Hood DEX trade.
     *
     * A main payer never sees `artifacts`, so without this a typed client could not tell which
     * router or pools its own executed trade went through, and had to re-read the transaction the
     * server had already read. Present on the executed response since 2026-09-04.
     */
    route?: TradeRoute;
    /**
     * Solana `jupiter` venue only: which quoter built the transaction that executed (`jupiter` or `dflow`),
     * and the Jupiter/DFlow race behind it. Absent on the curve venue, on Hood, and on an idempotent replay.
     */
    quoteSource?: "jupiter" | "dflow";
    race?: TradeRace;
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
 * One trade from the idempotency ledger, from GET /api/v1/trade/agent/jobs/:clientTradeId
 * (`getTradeJob()`). `amountRaw` is raw units: the quote asset's on a buy, the token's on a sell.
 * `status` is `built` (in flight, or built and never confirmed), `confirmed` (landed; `signature`
 * is set) or `failed` (`errorCode` says why; `TRADE_REVERTED` means it landed and reverted).
 */
export interface TradeJob {
    signedLegs?: SignedTradeLeg[];
    clientTradeId: string;
    chain: Chain;
    side: TradeSide;
    mint: string;
    quoteAsset: string;
    amountRaw: string;
    status: "built" | "confirmed" | "failed";
    signature?: string;
    errorCode?: string;
    createdAt: number;
    updatedAt: number;
    /** A Hood TEE trade only: its sequenced operation, leg by leg. `kind` and `status` are open strings. */
    operation?: {
        operationId: string;
        kind: string;
        status: string;
        plannedLegCount: number;
        currentLegIndex: number;
        legs: Array<{
            kind: string;
            status: string;
            hash?: string;
            nonce?: number;
        }>;
        expiresAt: number;
        /** The fee a trade that landed after its lock expired still owes, once the read has recorded it. */
        feeOwed?: Record<string, unknown>;
    };
}
/**
 * POST /api/v1/trade/agent/submit request body. `signedTransactions` is the ordered signed legs:
 * one for Solana; one to four for Hood in the fixed approval, permit2Approval, trade, feeTransfer
 * order (omitting a leg that was not built). The server broadcasts them itself and confirms
 * inline, so there is no separate confirmTrade() call after this one.
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
/**
 * `swapFromLinked()` request: SOL on the linked wallet into ETH/USDG on Hood.
 *
 * A TEE payer (Ember Phase 4c) may also start from USDC, and needs `clientTradeId`: the server
 * then resolves the destination to this key's own TEE wallet on Hood (`toWalletId` names one when
 * the key has several), honours any cap on the origin asset (none is required), and charges no fee. That bridge is
 * gated by the server's `TEE_BRIDGE_ENABLED`; with it off the build answers `PAIR_UNSUPPORTED`.
 * A Hood-origin bridge signs one leg at a time and is not this call; `candle swap` runs it.
 */
export interface LinkedSwapRequest {
    from: "SOL" | "USDC";
    to: "ETH" | "USDG";
    /** Raw base units of `from` (lamports for SOL), as a decimal string. */
    amountRaw: string;
    /** The linked Solana wallet funding the swap. */
    payer: {
        linkedWalletId: string;
        privyWalletId: string;
    };
    /**
     * The account's OWN linked EVM wallet to receive the output; omitted = the owner's embedded Hood
     * wallet. For a TEE payer: this key's TEE wallet on Hood, omitted when it has exactly one.
     */
    toWalletId?: string;
    maxSlippageBps?: number;
    /**
     * Required for a TEE payer's bridge, and sent on both calls: the durable idempotency key, and the
     * id `GET /api/v1/agent/swap/jobs/{clientTradeId}` reads the bridge's settlement and open state by.
     */
    clientTradeId?: string;
}
/** `swapFromLinked()` result. `hashes` is the Solana deposit; poll `statusChecks` for the fill. */
export interface LinkedSwapResult {
    hashes: string[];
    expectedOutRaw: string;
    outDecimals: number;
    statusChecks: string[];
    recipient: string;
    /**
     * What the swap settled, measured from chain (see `SwapSettlement`). Absent on an older API,
     * which means "not measured". A cross-chain swap stays `pending` until the destination fill is
     * observed. This call sends no `clientTradeId`, so it has no job to re-read: poll
     * `statusChecks` for the fill.
     */
    settlement?: SwapSettlement;
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
/** The EVM TEE wallet a perps action signs from: its row id and its Privy wallet id. */
export interface PerpsWalletRef {
    /** The linked wallet's row id (the relay's :id, and the secretStore key). */
    walletId: string;
    /** The same wallet's Privy wallet id, the authorization signature's URL target. */
    privyWalletId: string;
    /** Sign and submit (default), or stop after the build and its check and return the build. */
    submit?: boolean;
}
export type PerpsSide = "long" | "short";
export interface PerpsOpenParams extends PerpsWalletRef {
    coin: string;
    side: PerpsSide;
    /** Size in the coin, a decimal string. */
    size: string;
    /** `market` (IOC at the mid moved by the slippage) or `limit`. Default: limit when `price` is set. */
    type?: "market" | "limit";
    price?: string;
    tif?: "Gtc" | "Alo" | "Ioc";
    slippageBps?: number;
    /** Optional reduce-only take-profit trigger price. */
    takeProfit?: string;
    /** Optional reduce-only stop-loss trigger price. */
    stopLoss?: string;
    /**
     * Optional client order id: `0x` and 32 hex digits, chosen by the caller and used as the order's
     * cloid. A retry with the same id and the same request returns the original operation
     * (`replayed: true`) instead of placing another order; the same id with a different request is
     * refused (`PERPS_CLIENT_ID_CONFLICT`). It deduplicates, it does not resume: a retry never signs or
     * submits, so a build-only first call stays unsubmitted. Use a new id for a genuinely new order.
     */
    clientId?: string;
}
export interface PerpsCloseParams extends PerpsWalletRef {
    coin: string;
    /** Part of the position to close; the whole position when omitted. */
    size?: string;
    /**
     * Phase 1 D (spec 2026-10-17 D, section 8): a percentage of the position instead of a size, a
     * decimal string above 0 and at most 100 with at most four decimals. Sized by both the server and
     * this client from a direct position read: `floor(|szi| * pct / 100)` at the market's size step,
     * never rounded up. Exclusive with `size`.
     */
    pct?: string;
    slippageBps?: number;
    /** Optional client order id, as on `PerpsOpenParams.clientId`. */
    clientId?: string;
}
export interface PerpsCancelParams extends PerpsWalletRef {
    /** The cloid of an order Candle built (an open, or one of its take-profit / stop-loss legs). */
    cloid: string;
}
export interface PerpsModifyParams extends PerpsWalletRef {
    cloid: string;
    price?: string;
    size?: string;
    slippageBps?: number;
}
export interface PerpsLeverageParams extends PerpsWalletRef {
    coin: string;
    /**
     * Whole-number leverage. Phase 1 D (spec D, section 5): may be omitted when `mode` is named, and
     * then the account's current leverage is kept (read from Hyperliquid), never defaulted to 1. A
     * mode change needs no position and no resting order in the coin.
     */
    leverage?: number;
    mode?: "cross" | "isolated";
}
export interface PerpsMarginParams extends PerpsWalletRef {
    coin: string;
    /** USD, up to 6 decimals; negative removes isolated margin. */
    amount: string;
}
/** BE-1584: a scheduled cancel (spec D, section 7). `seconds` sets the venue's timer; `clear` disarms it. */
export type PerpsScheduleCancelParams = PerpsWalletRef & ({
    seconds: number;
    clear?: undefined;
} | {
    clear: true;
    seconds?: undefined;
});
/** What a perps build route returns: the plaintext action, its nonce, and the stamped typed data. */
export interface PerpsBuild {
    success: true;
    perpOrderId: string;
    kind: "open" | "close" | "modify" | "cancel" | "leverage" | "margin" | "setup" | "tpsl" | "scheduleCancel";
    network: HyperliquidNetwork;
    walletId: string;
    address: string;
    nonce: number;
    action: Record<string, unknown>;
    typedData: HyperliquidTypedData;
    claimHash: string;
    cloid?: string;
    childCloids?: string[];
    targetCloid?: string;
    notionalUsdMicros: number | null;
    reservedUsdMicros: number;
    windowKey: string | null;
    builder: {
        address: string;
        feeTenthsBps: number;
    } | null;
    exchangeUrl: string;
    /** BE-1584: the key's reduce-only setting and policy version this build was judged under. Absent from an older API. */
    perpsReduceOnly?: boolean;
    perpsPolicyVersion?: number;
    preview: Record<string, unknown>;
}
/**
 * The outcome of one perps action. `signature` is present once the relay signed; it stays valid
 * for resubmission until the nonce leaves Hyperliquid's two-day window, so a failed submit keeps
 * it. `exchange` is Hyperliquid's own answer, unchanged (`status: "ok"` or `"err"`, and per-order
 * statuses for an order).
 */
export interface PerpsActionResult {
    replayed?: false;
    build: PerpsBuild;
    signature: string | null;
    submitted: boolean;
    exchange: unknown | null;
    submitError?: string;
    /**
     * BE-1584 (spec D, section 3): Hyperliquid's answer judged per leg. `confirmed` only when the venue
     * said ok and no leg carries an error; HTTP 200 alone is not confirmation. Absent when nothing was
     * submitted.
     */
    outcome?: HyperliquidSubmitOutcome;
    /** A scheduled cancel: Candle recorded the venue's acknowledgement (not proof the timer will fire). */
    acknowledged?: boolean;
    /** A margin-mode change: the mode asked for, and the one Hyperliquid shows after the submit (null when unread). */
    requestedMode?: "cross" | "isolated";
    confirmedMode?: "cross" | "isolated" | null;
}
/** BE-1584 (spec D, section 9): the key's reduce-only setting. */
export interface PerpsReduceOnlyResult {
    success: true;
    keyPrefix: string;
    perpsReduceOnly: boolean;
    perpsPolicyVersion: number;
    changed?: boolean;
    /** On enabling: what the setting does not do (no cancel, no revocation of signed actions, no other keys). */
    limits?: string[];
}
/**
 * The original operation a client order id already names, as `POST /perps/open` or `/perps/close`
 * returns it for a retry (spec 2026-10-17 C, section 8). Nothing signable: `status` is Candle's
 * record (`building` / `built` mean not yet seen on the venue), `venueStatus` what reconcile observed.
 */
export interface PerpsReplay {
    success: true;
    replayed: true;
    perpOrderId: string;
    kind: "open" | "close";
    network: HyperliquidNetwork;
    walletId: string;
    address: string;
    clientId: string;
    cloid: string;
    childCloids: string[];
    nonce: number;
    status: string;
    venueStatus: string | null;
    filledSz: string | null;
    notionalUsdMicros: number | null;
    builtAt: number;
    settledAt: number | null;
    preview: Record<string, unknown> | null;
}
/** A retry under a client order id: the original operation, and nothing signed, submitted or charged. */
export interface PerpsReplayResult {
    replayed: true;
    replay: PerpsReplay;
    build: null;
    signature: null;
    submitted: false;
    exchange: null;
}
/** `POST /agent/perps/withdraw`: a quote for a withdrawal to this key's own Solana or Hood TEE wallet. */
export interface PerpsWithdrawBuildRequest {
    clientWithdrawalId: string;
    /**
     * USDC, a decimal string with at most 6 decimals, at least 10 USDC. The server refuses
     * `PERPS_WITHDRAW_BELOW_MINIMUM` under 10 USDC (`limit: "minimumAmount"`), and when Relay guarantees
     * under 5 USDC or its fees are above 5% of the amount (`limit: "minimum"`); Hyperliquid's one-time
     * 1 USDC activation fee on the account's first withdrawal or transfer does not count toward the 5%.
     */
    amountUsdc: string;
    to: "solana" | "hood";
    /** The key's EVM TEE wallet row id; the key's only one when omitted. */
    wallet?: string;
}
/** One withdrawal as the server records it, with Relay's live status on a read. */
export interface PerpsWithdrawStatus {
    success: true;
    id: string;
    status: "quoted" | "authorized" | "submitted" | "settled" | "refunded" | "failed";
    from: {
        walletId: string;
        address: string;
        network: string;
    };
    to: {
        chain: "solana" | "hood";
        walletId: string;
        address: string;
    };
    amountUsdc: string;
    feesUsdc: string;
    netUsdc: string;
    minimumOutUsdc: string;
    relayRequestId: string;
    /** Relay `protocol.v2.orderId`, when the quote stored one. Status reads still use `relayRequestId`. */
    relayOrderId?: string;
    nonce: number;
    failureReason: string | null;
    relay?: {
        status: string | null;
        txHashes: string[];
    } | null;
    [key: string]: unknown;
}
/** The four withdraw routes, one call each. No check runs here: `perpsWithdraw()` runs them. */
export interface CandlePerpsWithdraw {
    build(request: PerpsWithdrawBuildRequest): Promise<PerpsWithdrawBuild>;
    authorize(request: {
        clientWithdrawalId: string;
        signature: string;
    }): Promise<PerpsWithdrawAuthorization>;
    reportSubmitted(request: {
        clientWithdrawalId: string;
        exchangeResponse: unknown;
    }): Promise<PerpsWithdrawStatus>;
    get(clientWithdrawalId: string): Promise<PerpsWithdrawStatus>;
}
export interface CandlePerps {
    withdraw: CandlePerpsWithdraw;
}
export interface PerpsWithdrawParams extends Omit<PerpsWalletRef, "submit"> {
    amountUsdc: string;
    to: "solana" | "hood";
    /** Reuse on retry. A new id is generated when omitted. */
    clientWithdrawalId?: string;
    /** This key's EVM TEE wallet address: the HyperCore account the USDC leaves. */
    account: string;
    /**
     * This key's own wallet addresses on the chain asked for: its Solana TEE wallet for `solana`,
     * the EVM TEE wallet itself for `hood`. A build landing anywhere else is refused.
     */
    ownDestinations: string[];
}
/**
 * The outcome of `perpsWithdraw()`. `signature` is the SendAsset's, valid for resubmission until
 * its nonce leaves Hyperliquid's two-day window; a failed submit keeps it.
 */
export interface PerpsWithdrawResult {
    build: PerpsWithdrawBuild;
    authorization: PerpsWithdrawAuthorization;
    signature: string;
    submitted: boolean;
    exchange: unknown | null;
    submitError?: string;
}
export interface PerpsAccountStatus {
    walletId: string;
    address: string;
    network: HyperliquidNetwork;
    mode: string;
    standardMode: boolean;
    accountValue: string;
    withdrawable: string;
    builder: string;
    approvedFeeTenthsBps: number;
}
/** `ready: true` when the builder approval is already on Hyperliquid; otherwise the setup action's outcome. */
export type PerpsSetupResult = PerpsAccountStatus & {
    ready: boolean;
    action?: PerpsActionResult;
    preview?: Record<string, unknown>;
};
export interface PerpsConfig {
    success: true;
    network: HyperliquidNetwork;
    exchangeUrl: string;
    builder: string | null;
    builderFeeTenthsBps: number;
    maxBuilderFeeRate: string;
    allowedActionTypes: string[];
    limits: Record<string, unknown>;
}
/**
 * One frame of the private perps stream (Hyperliquid phase 3, P3-7): `{type, seq, at, ...}` with
 * `seq` per connection. `snapshot` carries the account line, positions, open orders, the risk
 * report, the monitor block and `ordersSource: "push" | "poll"`; `positions` and `risk` follow
 * the server monitor's reads (`risk.reason` instead of `risk` when the level went unknown); `order`
 * and `fill` carry the venue's own rows (a poll-source vanished order has `status: "gone"`);
 * `heartbeat` repeats the level with the monitor block; `error` carries a `PERPS_*` code.
 */
export interface PerpsStreamFrame {
    type: "snapshot" | "positions" | "risk" | "order" | "fill" | "heartbeat" | "error";
    seq: number;
    at: string;
    [field: string]: unknown;
}
/**
 * The header-capable WebSocket surface {@link CandleClient.perpsStream} needs. The global
 * WebSocket satisfies it on Bun and Node 22+; on Node 18/20 the SDK falls back to undici's
 * (a runtime dependency), which is also the shape to pass as
 * {@link CandleClientOptions.perpsStreamWebSocket} when a caller wants to supply its own.
 */
export interface PerpsStreamWebSocket {
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    onmessage: ((event: {
        data: unknown;
    }) => void) | null;
    onclose: ((event: {
        code: number;
        reason: string;
    }) => void) | null;
    onerror: ((event: unknown) => void) | null;
}
export interface PerpsStreamSocketOptions {
    headers: Record<string, string>;
}
export interface PerpsPositions {
    success: true;
    walletId: string;
    address: string;
    network: HyperliquidNetwork;
    mode: string;
    standardMode: boolean;
    account: Record<string, string>;
    withdrawable: string;
    positions: Record<string, unknown>[];
    /**
     * BE-1582 (spec A-3): the section 4 table, account line and risk report, from a direct read of
     * Hyperliquid on this machine (the fields above are Candle's server read, unchanged). `rows` is
     * empty and `accountLine` null when that read failed or no level could be computed, and `risk`
     * then says why (`level: "unknown"`).
     */
    rows: PerpsPositionRow[];
    accountLine: PerpsAccountLine | null;
    risk: Omit<PerpsRiskReport, "positions">;
}
/** `GET /keys/self/limits`'s risk thresholds for the calling key (BE-1582, spec A-4). */
export interface PerpsRiskSettingsResult {
    /** What the key stores, or null. */
    perpsRisk: PerpsRiskSettings | null;
    /** What the engine applies, and where it came from (`defaults (server did not report)` on an older API). */
    effective: PerpsRiskThresholdsReport;
}
/** `PUT /keys/self/perps-risk` or `/keys/:prefix/perps-risk`. */
export interface PerpsRiskWriteResult {
    success: true;
    keyPrefix: string;
    perpsRisk: PerpsRiskSettings | null;
    effective: PerpsRiskThresholds;
}
/** A threshold write: each named field set (`null` clears that field), or `null` to clear them all. */
export type PerpsRiskWrite = {
    [K in keyof PerpsRiskThresholds]?: number | null;
} | null;
export interface PerpsOrderRecord {
    perpOrderId: string;
    kind: PerpsBuild["kind"];
    actionType: string;
    coin: string | null;
    nonce: number;
    cloid: string | null;
    /** The caller's client order id, on rows built with one (absent from an older API). */
    clientId?: string | null;
    childCloids: string[];
    targetCloid: string | null;
    status: string;
    venueStatus: string | null;
    filledSz: string | null;
    notionalUsdMicros: number | null;
    reservedUsdMicros: number;
    releasedUsdMicros: number;
    windowKey: string | null;
    builtAt: number;
    settledAt: number | null;
}
export interface PerpsOrders {
    success: true;
    walletId: string;
    address: string;
    network: HyperliquidNetwork;
    /** Hyperliquid's open orders for the wallet's address. */
    open: Record<string, unknown>[];
    /** Candle's record of every action it built for this wallet, newest first. */
    recorded: PerpsOrderRecord[];
    settled: {
        perpOrderId: string;
        status: string;
        releasedUsdMicros: number;
    }[];
}
/**
 * Perps C (BE-647, HL-ED-8): `perpsDeposit()`. Relay moves funds from the key's Hood or Solana TEE
 * wallet onto Hyperliquid perps USDC at the key's EVM TEE wallet's own address. The asset decides
 * the paying chain: SOL or USDC from the Solana TEE wallet, ETH or USDG from the Hood one. Needs
 * `swap:write`; any cap on the asset still applies. There is no withdrawal yet.
 */
export interface PerpsDepositParams {
    /** Idempotency id, 1 to 128 of `A-Za-z0-9._:-`. Rebuilding under the same id answers its job. */
    clientDepositId: string;
    asset: "SOL" | "USDC" | "ETH" | "USDG";
    /** Raw base units of `asset`, as a decimal string. */
    amountRaw: string;
    /** The paying TEE wallet's row id (the relay's :id, and the secretStore key). */
    walletId: string;
    /** The paying wallet's Privy wallet id. */
    privyWalletId: string;
    /** The Hyperliquid account: the EVM TEE wallet's address. The build is refused if it names another. */
    account: string;
    /** From Solana only: the EVM TEE wallet whose Hyperliquid account receives. Omit from Hood. */
    perpsWalletId?: string;
    /** Relay slippage, 1 to 1000 bps (default 100). */
    maxSlippageBps?: number;
    /**
     * Sign and submit (default), or `false` for a dry run: the API previews the deposit (`preview:
     * true`), locking no wallet, reserving no USD window and recording no id, and nothing is signed.
     */
    submit?: boolean;
}
/**
 * What `POST /agent/perps/deposit` builds. A Hood build also carries the first sequenced leg. A
 * preview (`status: "preview"`, from `submit: false`) has no `depositId`, `expiresAt` or sequenced
 * leg; from Hood it carries `plannedLegs` instead.
 */
export interface PerpsDepositBuild {
    success: true;
    status: "built" | "preview";
    /** A dry run: nothing is held, and the same id still builds a new deposit. */
    preview?: true;
    clientDepositId: string;
    /** Absent on a preview. */
    depositId?: string;
    chain: "solana" | "hood";
    venue: "relay";
    network: HyperliquidNetwork;
    asset: PerpsDepositParams["asset"];
    amountRaw: string;
    walletId: string;
    walletAddress: string;
    destination: {
        walletId: string;
        address: string;
        chainId: number;
        currency: string;
    };
    firstDeposit: boolean;
    expectedOutRaw: string;
    minimumOutRaw: string;
    outDecimals: number;
    floorUsdcMicros: string;
    minimumCreditUsdcMicros: string;
    fee: {
        bps: number;
        feeRaw: string;
    };
    statusChecks: string[];
    requestId: string | null;
    /** Absent on a preview. */
    expiresAt?: number;
    /** Solana: the one unsigned deposit. */
    transactionsBase64?: string[];
    /** A Hood preview: the legs' calldata, nothing sequenced. */
    plannedLegs?: Array<{
        kind: string;
        to: string;
        data: string;
        value: string;
    }>;
    /** Hood: the sequenced leg protocol's first body. */
    mode?: "sequenced";
    operationId?: string;
    legKind?: string;
    plannedLegCount?: number;
    nextLeg?: {
        chainId: number;
        nonce: number;
        gas: string;
        maxFeePerGas: string;
        maxPriorityFeePerGas: string;
        to: string;
        data: string;
        value: string;
    };
}
export interface PerpsDepositResult {
    build: PerpsDepositBuild;
    submitted: boolean;
    /** `/perps/deposit/submit`'s final answer: `status: "submitted"` and the chain hashes. */
    result: Record<string, unknown> | null;
}
export declare function perpsDepositProblem(build: PerpsDepositBuild, params: PerpsDepositParams): string | null;
/**
 * The base assets `swap()` converts between. Inlined rather than imported from `@candle/shared`'s
 * `BaseAssetKey`, for the same reason `packages/mcp` inlines its curve constants: this SDK is
 * published standalone and must not depend on a monorepo-internal package.
 *
 * SOL, USDC and CNDL are Solana-side; ETH and USDG are Hood-side. A pair that spans the two sides
 * is a cross-chain swap and settles as more than one transaction.
 */
export type BaseAssetKey = "SOL" | "USDC" | "CNDL" | "ETH" | "USDG";
/** swap()'s request body: `POST /api/v1/agent/swap`. */
export interface SwapRequest {
    from: BaseAssetKey;
    /** Must differ from `from`; the API rejects a same-asset pair. */
    to: BaseAssetKey;
    /** Raw base units of `from` to spend, as a positive integer string. */
    amountRaw: string;
    /** Bps, 0-10000. Server defaults to 100 (1%) when omitted. */
    maxSlippageBps?: number;
    /** Durable idempotency key. Same id + same body, including effective slippage, replays; a different body is refused. */
    clientSwapId?: string;
}
/** swap()'s unwrapped `payload`. */
export interface SwapResult {
    /** One hash per executed leg, in execution order. A cross-chain swap reports more than one. */
    hashes: string[];
    expectedOutRaw: string;
    outDecimals: number;
    venueCostUsd?: number;
    /** URLs to poll a cross-chain fill's status, so a caller need not re-derive them from a quote. */
    statusChecks: string[];
    /**
     * What the swap settled, measured from chain. Absent on an older API, which means "not
     * measured", never a zero. When `state` is `pending` or `uncertain`, or to re-read a `settled`
     * one later, call `wallets.swapReceipt(hash)` with any of `hashes`, on the same key.
     */
    settlement?: SwapSettlement;
    /**
     * `false` when the server could not store the receipt: the swap landed, and
     * `wallets.swapReceipt(hash)` will 404 `RECEIPT_NOT_FOUND`. Absent on an older API.
     */
    receiptStored?: boolean;
}
/** `SwapSettlement.state`. */
export type SwapSettlementState = "settled" | "pending" | "failed" | "uncertain";
/** One broadcast leg of a settled swap. */
export interface SwapSettlementLeg {
    chain: "solana" | "hood";
    hash: string;
    status: "confirmed" | "failed" | "pending";
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
    state: SwapSettlementState;
    legs: SwapSettlementLeg[];
    /** What was sent. */
    in: {
        asset: string;
        raw: string;
    };
    /** The build-time quote. */
    expectedOutRaw: string;
    /** The recipient's measured delta of the out asset. Omitted, never zeroed, when not measured. */
    settledOutRaw?: string;
    settledOutSource?: "tx_balance_delta" | "bridge_fill";
    /** The slot (Solana) or block (Hood) of the measurement. Present with `settledOutRaw`. */
    measuredAt?: {
        slot?: number;
        blockNumber?: number;
    };
}
/** One balance of one wallet in `wallets.selfBalances()`. */
export interface SelfWalletBalance {
    /** Set for a base asset. */
    asset?: BaseAssetKey;
    /** The mint or token contract. */
    mint: string;
    amountRaw: string;
    decimals?: number;
    /** The Solana slot the balance was read at. */
    slot?: number;
    /** The Hood block the balance was read at. */
    blockNumber?: number;
}
/** One wallet this key may spend from, with its balances. */
export interface SelfWallet {
    kind: "embedded" | "tee" | "linked";
    chain: WalletChain;
    address: string;
    /** The linked wallet id; absent on an embedded wallet. */
    id?: string;
    label?: string;
    balances: SelfWalletBalance[];
    /** Mints whose read failed: unknown, not zero. Absent when every read succeeded. */
    unavailable?: string[];
}
/** `wallets.selfBalances()` options. */
export interface SelfBalancesOptions {
    /** Extra mints (Solana) or 0x token contracts (Hood) beyond the base assets, at most 10. */
    mints?: string[];
    /** The previous page's `continueCursor`. */
    cursor?: string;
}
/** `GET /api/v1/agent/wallets/self/balances` response: one page of this key's spendable wallets. */
export interface SelfBalancesResult {
    success: true;
    keyPrefix: string;
    page: SelfWallet[];
    isDone: boolean;
    continueCursor: string | null;
    /** `false` when the account's wallet list was cut off. Absent on a key with no spend scope. */
    complete?: boolean;
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
    swapReceipt(hash: string): Promise<SwapSettlement>;
    /**
     * Balances of the wallets this key may spend from, and no others
     * (GET /api/v1/agent/wallets/self/balances). Needs no `account:read`; a key with no spend scope
     * gets an empty page. Base assets always, plus up to 10 `mints`; 50 wallets a page. A balance
     * whose read failed is listed in `unavailable`, never as zero.
     */
    selfBalances(opts?: SelfBalancesOptions): Promise<SelfBalancesResult>;
}
/** Why a token's creator fees are not claimable by this key (FE-438; `GET /agent/fees`). */
export type AgentFeeReason = "below_dust" | "wallet_not_signable" | "delegation_off" | "embedded_wallet_not_permitted" | "not_recipient" | "insufficient_gas";
/** One asset's raw amount, from direct chain reads. `symbol` is empty when nothing names the asset. */
export interface AgentFeeAmount {
    symbol: string;
    mint: string;
    decimals: number;
    amountRaw: string;
}
/** One launched token in `fees.list()`. No earned or paid-out totals: those are not on this route. */
export interface AgentFeeToken {
    mint: string;
    chain: "solana" | "hood";
    symbol?: string | null;
    name?: string | null;
    /** The wallet fixed at launch. Null when the token has no vault or splitter. */
    recipient: string | null;
    claimableAmounts: AgentFeeAmount[];
    claimable: boolean;
    reason?: AgentFeeReason;
    /** The chain read for this token failed; its amounts are unknown, not zero. */
    unreadable?: true;
}
export interface AgentFeesOptions {
    /** The previous page's `continueCursor`, verbatim. */
    cursor?: string;
    /** Tokens per page, 1 to 50 (default 20). Each one costs chain reads. */
    limit?: number;
}
/** `GET /api/v1/agent/fees` response: one page of the account's launched tokens. */
export interface AgentFeesPage {
    success: true;
    page: AgentFeeToken[];
    isDone: boolean;
    continueCursor: string | null;
}
export interface AgentFeeClaimOptions {
    /** Run every check and read the amounts, but send nothing and write nothing. */
    dryRun?: boolean;
}
/** `POST /api/v1/agent/fees/{mint}/claim` response. */
export interface AgentFeeClaimResult {
    success: true;
    mint: string;
    chain: "solana" | "hood";
    dryRun: boolean;
    /** The wallet fixed at launch. The request has no destination field. */
    recipient: string;
    /** What was claimed; under `dryRun`, what would be, with `txHash: null`. */
    claimed: (AgentFeeAmount & {
        txHash: string | null;
    })[];
    /** What is still claimable, in the same shape as `fees.list()`. */
    remaining: AgentFeeAmount[];
    /** `dryRun` only. */
    claimable?: boolean;
    /** `dryRun` only: why a real claim would be refused. */
    reason?: AgentFeeReason;
    /** A real claim only: any leg or collect that failed. A 200 can be partial. */
    warnings?: string[];
}
/** `client.fees`: the creator fees this account's launched tokens can pay (FE-438). */
export interface CandleFees {
    /**
     * Lists the tokens launched by the account's own wallets, with what each could pay now
     * (GET /api/v1/agent/fees). Needs `account:read` (an older key reads with `launch:write`).
     * Amounts are raw units from direct chain reads. A token that cannot be claimed carries a `reason`.
     */
    list(opts?: AgentFeesOptions): Promise<AgentFeesPage>;
    /**
     * Claims one token's creator fees to the wallet fixed at launch
     * (POST /api/v1/agent/fees/{mint}/claim). Needs `launch:write`. There is no destination
     * argument: the money goes to the recipient the token named at launch. Candle signs with the
     * embedded wallet, which pays the network fee.
     * `dryRun: true` sends nothing.
     */
    claim(mint: string, opts?: AgentFeeClaimOptions): Promise<AgentFeeClaimResult>;
}
/** One token account a close would reclaim (BE-418). `lamports` is its rent, returned to the wallet. */
export interface EmptyTokenAccount {
    account: string;
    mint: string;
    tokenProgram: "spl-token" | "token-2022";
    lamports: string;
}
/**
 * Why an empty account is left open: a mint the caller kept, wrapped SOL, an account the wallet
 * does not own or cannot close, a frozen account, or Token-2022 state CloseAccount refuses.
 */
export type EmptyTokenAccountSkipReason = "kept" | "wrapped_sol" | "not_owner" | "close_authority" | "frozen" | "withheld_transfer_fees" | "confidential_transfer";
export interface SkippedEmptyTokenAccount extends EmptyTokenAccount {
    reason: EmptyTokenAccountSkipReason;
}
export interface PreviewCloseEmptyAccountsRequest {
    /** Mints whose empty accounts stay open, e.g. the pair token a held holder-reward coin pays in. */
    keep?: string[];
    /**
     * A Solana TEE wallet's linked-wallet id, to preview that wallet instead of the embedded one
     * (BE-1687). Any key bound to the wallet may preview it.
     */
    wallet?: string;
}
/** previewCloseEmptyAccounts()'s result. Nothing was built, signed or written to produce it. */
export interface CloseEmptyAccountsPreview {
    success: true;
    wallet: string;
    /** The TEE wallet's linked-wallet id, on a TEE wallet's preview. */
    linkedWalletId?: string;
    keep: string[];
    accounts: EmptyTokenAccount[];
    accountCount: number;
    totalLamports: string;
    totalSol: string;
    /** Transactions a close would send, at `closesPerTransaction` each. */
    transactions: number;
    estimatedFeeLamports: string;
    netLamports: string;
    netSol: string;
    skipped: SkippedEmptyTokenAccount[];
    /** Token accounts whose bytes did not decode. Never closed. */
    undecodable: string[];
    closesPerTransaction: number;
    /** The most accounts one closeEmptyAccounts() call closes; `remaining` counts the rest. */
    maxAccountsPerCall: number;
}
export interface CloseEmptyAccountsRequest {
    /** Required and durable: the same id replays its stored report and never closes twice. */
    clientTradeId: string;
    keep?: string[];
    /** The preview's `accounts[].account`, to close only what was shown. Omit to close every qualifying account. */
    accounts?: string[];
    /**
     * A Solana TEE wallet's linked-wallet id, to close that wallet's accounts instead of the embedded
     * wallet's (BE-1687). Needs `swap:write`, `privyWalletId`, and the wallet's signer in `secretStore`.
     */
    wallet?: string;
    /** The TEE wallet's Privy wallet id, which signLinkedTransaction() signs for. Required with `wallet`. */
    privyWalletId?: string;
}
/** A close transaction that landed. */
export interface CloseEmptyAccountsBatch {
    /** The transaction's place in a TEE wallet's built batch. */
    index?: number;
    signature: string;
    accounts: string[];
    lamports: string;
}
/**
 * A close transaction that did not land. `CLOSE_REFUSED` was refused in simulation (no fee);
 * `CLOSE_REVERTED` landed and reverted (fee only); `CLOSE_UNCONFIRMED` may still land, so
 * re-preview before re-running.
 */
export interface CloseEmptyAccountsFailure {
    /** The transaction's place in a TEE wallet's built batch. */
    index?: number;
    accounts: string[];
    code: string;
    message: string;
    signature?: string;
}
/**
 * A TEE wallet's close transaction the chain has not settled yet (BE-1687). Its rent is not counted,
 * and the operation stays `recovering` until every one is settled.
 */
export interface CloseEmptyAccountsUnresolved {
    index: number;
    accounts: string[];
    /** Known once the transaction was signed and recorded. */
    signature?: string;
    reason: string;
}
/** closeEmptyAccounts()'s result. A run in which nothing landed throws a CandleApiError instead. */
export interface CloseEmptyAccountsResult {
    success: true;
    /**
     * `partial`: some batch failed, or more accounts remain than one call closes. `recovering`, a TEE
     * wallet's close only: a transaction may still land. Nothing is sent again; read
     * getCloseEmptyAccountsJob(clientTradeId, { wallet }) until it settles.
     */
    status: "completed" | "partial" | "nothing_to_close" | "recovering";
    clientTradeId: string;
    wallet: string;
    /** The TEE wallet's linked-wallet id, on a TEE wallet's close. */
    linkedWalletId?: string;
    keep: string[];
    closed: EmptyTokenAccount[];
    transactions: CloseEmptyAccountsBatch[];
    signatures: string[];
    lamportsRecovered: string;
    solRecovered: string;
    /** The base network fee of the transactions that landed, reverted ones included, 5,000 lamports each. */
    feeLamports: string;
    /** Absent while `status` is `recovering`: no net is final until every transaction settles. */
    netLamports?: string;
    netSol?: string;
    /** A TEE close that landed before its fee could be read: `feeLamports` does not count it yet. */
    feeUnresolved?: true;
    failed: CloseEmptyAccountsFailure[];
    /** Accounts in batches never sent, after a failure that stops the run. */
    unattempted: string[];
    /** Accounts named in `accounts` that no longer qualify. */
    notClosed: {
        account: string;
        reason: string;
    }[];
    skipped: SkippedEmptyTokenAccount[];
    remaining: number;
    /** Present when this is the stored report of an earlier call under the same id. */
    replayed?: true;
    /** `recovering` only: what the server says to do next. */
    message?: string;
    /** `recovering` only: the TEE close transactions not settled yet. */
    unresolved?: CloseEmptyAccountsUnresolved[];
}
/** Which wallet getCloseEmptyAccountsJob() reads: the embedded wallet's runs, or a TEE wallet's. */
export interface CloseEmptyAccountsJobOptions {
    /** A Solana TEE wallet's linked-wallet id (BE-1687). Omit for the embedded wallet. */
    wallet?: string;
}
export interface CloseEmptyAccountsJob {
    clientTradeId: string;
    kind: "close-empty";
    /** `built`, a TEE wallet's only: the transactions await their signatures, or are being sent or recovered. */
    status: "running" | "built" | "completed" | "failed";
    /** On a TEE wallet's job. */
    walletKind?: "tee";
    linkedWalletId?: string;
    /** A TEE wallet's send state: `idle` before submit, then `submitting`, `recovering` or `done`. */
    submitState?: "idle" | "submitting" | "recovering" | "done";
    /** On a TEE wallet's job: whether this read reconciled the row against the chain. */
    reconciled?: boolean;
    createdAt: number;
    finishedAt?: number;
    httpStatus?: number;
    /**
     * The report the close call returned, once it finished. On a TEE wallet's job, the build while
     * its signatures are awaited, the report (`recovering` until the chain settles), or the stored error.
     */
    result?: CloseEmptyAccountsResult | Record<string, unknown>;
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
    quoteAsset?: "sol" | "usdc" | "cndl" | "eth" | "usdg";
    /**
     * Idempotency key shared by the build and confirm calls; generated ("sdk-" + UUID) when omitted.
     * Pass your own for anything that moves funds and store it before the call: see `trade()`.
     */
    clientTradeId?: string;
}
/** selfLaunch()'s one-call request: BuildSelfLaunchRequest plus the linked wallet's Privy wallet id. */
export type SelfLaunchRequest = BuildSelfLaunchRequest & {
    /** The linked wallet's Privy wallet id (from importWallet()'s result). */
    privyWalletId: string;
};
/** Who pays for one leg of an atomic bundle (the launch, or one first buy): the account's own delegated wallet ("main"), or an imported linked wallet. Mirrors TradePayer. */
export type AtomicLaunchPayer = {
    type: "main";
} | {
    type: "linked";
    linkedWalletId: string;
};
/** One first-buy leg of an atomic launch request. */
export interface AtomicFirstBuyRequest {
    payer: AtomicLaunchPayer;
    /** Quote-asset raw units this leg spends. */
    amountRaw: string;
}
/**
 * POST /api/v1/launch/atomic/build request body: LaunchRequest without `buyAmount` (atomic
 * launches never bundle a dev buy into the launch transaction itself -- give the creator a first
 * buy via `firstBuys` instead, so it lands as bundle leg 1 against a still-virgin curve) plus the
 * creator's own payer and 1-4 first-buy legs.
 */
export interface BuildAtomicLaunchRequest extends Omit<LaunchRequest, "buyAmount" | "buy" | "wallet"> {
    payer: AtomicLaunchPayer;
    /** 1 to 4 buy legs, sharing the launch transaction's own recent blockhash and landing atomically with it (Jito's 5-transaction bundle cap: 1 launch + up to 4 buys). */
    firstBuys: AtomicFirstBuyRequest[];
}
export type AtomicBundleLegRole = "launch" | "buy";
export type AtomicBundleLegSigner = "server" | "client";
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
    index: number;
    role: AtomicBundleLegRole;
    signer: AtomicBundleLegSigner;
    unsignedTxBase64?: string;
    expectedFill?: {
        amountOutRaw: string;
    };
}
/**
 * POST /api/v1/launch/atomic/build response, plus `clientLaunchId`. The server's body does not
 * carry the id: `buildAtomicLaunch()` sets it from the request it sent. It is the launch's
 * identity (`bundleId` is single-use), so a caller driving build and submit by hand keeps it.
 */
export interface BuildAtomicLaunchResult {
    /** The idempotency id this build was sent under, the caller's or the generated one. */
    clientLaunchId: string;
    bundleId: string;
    legs: AtomicBundleResponseLeg[];
    expiresAt: number;
}
/** One first buy in an atomic dry run, as `/build` would floor it. */
export interface AtomicDryRunFill {
    /** The leg's index in the bundle, 1 to 4. */
    index: number;
    signer: AtomicBundleLegSigner;
    payerType: "main" | "linked";
    wallet: string;
    amountRaw: string;
    /** The agent-tier fee `/build` appends to this leg, raw. */
    feeRaw: string;
    /** What `/build`'s leg would carry: the ladder fill, and the floor it signs at. */
    expectedFill: {
        amountOutRaw: string;
        minAmountOutRaw: string;
    };
    supplyPct: number;
}
/** POST /api/v1/launch/atomic/dry-run response. */
export interface AtomicDryRunResult {
    success: true;
    dryRun: true;
    /** The wallet that pays for the launch leg. Never checked for balance. */
    launchWallet: string;
    launchSigner: AtomicBundleLegSigner;
    resolved: Omit<ResolvedLaunch, "dexVersion" | "buyAmount">;
    curveTerms?: LaunchPreviewTerms;
    /** Present only when the launch chose a non-default pool fee or shape. */
    graduation?: LaunchGraduationPreview;
    fills: AtomicDryRunFill[];
    /** Whether the first buys alone take the new curve to its threshold inside the bundle. */
    graduatesInBundle: boolean;
    checks: {
        exclusiveEligible?: boolean;
    };
    matrixVersion: number;
}
/**
 * POST /api/v1/launch/atomic/submit request body: EXACTLY the client-signer legs
 * `BuildAtomicLaunchResult.legs` named (`signer: "client"`), in leg order -- omit every "server"
 * leg entirely, never pad the array.
 */
export interface SubmitAtomicLaunchRequest {
    bundleId: string;
    signedTxsBase64: string[];
}
/**
 * POST /api/v1/launch/atomic/submit response. `"landed"` is the 200 body; `"failed"`/`"timeout"`
 * are the 502 body -- all three are NORMAL, expected outcomes of submitting a Jito bundle that
 * this route documents as part of its own response surface, so `submitAtomicLaunch()`/
 * `launchAtomic()` return them here rather than throwing `CandleApiError` (every OTHER non-2xx
 * status still throws, same as every other method).
 *
 * `retryable` is `false` on every `"failed"` and on every `"timeout"` the server returns today.
 * It is not permission to relaunch, whatever its value: a `"timeout"` means the resolution window
 * ran out with no definitive answer and the bundle MIGHT STILL LAND. Treat every `"timeout"` as
 * unresolved and never rebuild under a new `clientLaunchId` because of one: that is a second
 * token. (This comment used to describe a `true` case meaning "the blockhash expired, relaunch".
 * No server path returns it.)
 *
 * `bundleId` itself is dead once this response arrives: it is consumed on the first `/submit`
 * call regardless of outcome and is never resubmitted. The launch's identity is the
 * `clientLaunchId` the build was sent under, and recovery goes through it: read
 * `getLaunchJob(clientLaunchId)`, then call `launchAtomic()` again with the SAME id when the job
 * says to (the steps are on `launchAtomic()`). See "Atomic launch with first buys" in
 * docs/headless-launch.md for the full model.
 */
export type SubmitAtomicLaunchResult = {
    status: "landed";
    bundleId: string;
    mint: string;
    pool?: string;
    signatures: string[];
    launch?: Omit<LaunchResult, "clientLaunchId">;
} | {
    status: "failed";
    bundleId: string;
    retryable: false;
    revertedSignature?: string;
} | {
    status: "timeout";
    bundleId: string;
    retryable: boolean;
};
/**
 * What `launchAtomic()` returns: `submitAtomicLaunch()`'s outcome plus the `clientLaunchId` the
 * launch was sent under, on all three of `landed`, `failed` and `timeout`. `submitAtomicLaunch()`
 * itself is given only a `bundleId` and cannot know the launch id.
 */
export type LaunchAtomicResult = SubmitAtomicLaunchResult & {
    clientLaunchId: string;
};
/** Who pays for one leg of launchAtomic()'s one-call request. Mirrors AtomicLaunchPayer, but a "linked" payer also carries the privyWalletId signLinkedTransaction() needs to sign that leg -- mirrors TradeRequest's `from` field. */
export type LaunchAtomicPayer = {
    type: "main";
} | {
    type: "linked";
    linkedWalletId: string;
    privyWalletId: string;
};
export interface LaunchAtomicFirstBuyRequest {
    payer: LaunchAtomicPayer;
    amountRaw: string;
}
/** launchAtomic()'s one-call request: BuildAtomicLaunchRequest's fields, but `payer`/`firstBuys[].payer` use LaunchAtomicPayer (carrying privyWalletId for any linked leg). */
export type LaunchAtomicRequest = Omit<BuildAtomicLaunchRequest, "payer" | "firstBuys"> & {
    payer: LaunchAtomicPayer;
    firstBuys: LaunchAtomicFirstBuyRequest[];
};
/** A keyed request was redirected to another origin; the key was not sent there. */
export declare class CrossOriginRedirectError extends Error {
    readonly from: string;
    readonly to: string;
    constructor(from: string, to: string);
}
/**
 * Wraps the client's fetch so a request that carries `x-api-key` never follows a redirect off its
 * own origin. fetch's own redirect handling forwards custom headers such as `x-api-key` to
 * wherever a Location points, another host included, so a redirect from the API (or anything
 * between it and the caller) would hand the key to a third party. A keyed request goes out with
 * `redirect: "manual"`: a Location on the same origin is re-issued with the same headers (the
 * API's legacy routes redirect that way), and any other origin throws
 * {@link CrossOriginRedirectError} without a request being made to it. 303, and 301/302 after a
 * POST, continue as a body-less GET, as fetch would. Requests without the key pass through.
 */
export declare function keyedRedirectGuard(doFetch: typeof fetch): typeof fetch;
export declare class CandleClient {
    /** About reads and scoped writes. No implicit signing, claiming or conflict resolution. */
    readonly tokenPages: import("./token-pages").CandleTokenPages;
    private readonly apiUrl;
    private readonly apiKey?;
    private readonly fetchImpl;
    private readonly maxRetries;
    private readonly privyAppId?;
    private readonly secretStore?;
    private readonly solanaRpcUrl?;
    private readonly evmRpcUrl?;
    private readonly hyperliquidNetwork;
    private perpsMarketReader?;
    private hyperliquidBuilder?;
    private readonly perpsWithdrawPins;
    private readonly perpsStreamWebSocket?;
    /**
     * Hyperliquid withdrawals (spec 2026-10-17-hyperliquid-withdrawals-design.md): the routes, one call
     * each. Needs `perps:withdraw` on the key. `perpsWithdraw()` is the checked flow.
     */
    readonly perps: CandlePerps;
    /** Reads scoped to what this key may spend: a one-shot swap's receipt, and spendable balances. */
    readonly wallets: CandleWallets;
    /** The creator fees this account's launched tokens can pay, and the claim (FE-438). */
    readonly fees: CandleFees;
    /** Solana staking. The server supplies the pool wait and wallet eligibility notes. */
    readonly staking: CandleStaking;
    private stakingBuild;
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
    /**
     * One page of one token's events: every signal, callout and tracked-wallet trade the deployment
     * has, plus Candle's own trades, newest first (`GET /api/v1/tokens/:chain/:mint/events`).
     * Needs no key; a configured key changes only the wallets' `groups` and the rate limit. The
     * route is off until the deployment sets `TOKEN_EVENTS_ENABLED` on; off it answers
     * 503 `TOKEN_EVENTS_DISABLED`.
     *
     * `since` (inclusive ISO 8601) and `limit` (1 to 1000, default 200) go to the route. `kind`
     * filters THIS page locally -- the route has no kind parameter -- so a filtered page can be
     * shorter than `limit` while older events of other kinds remain: keep paging with the returned
     * `nextCursor` as `before` until it is null.
     */
    getTokenEvents(chain: Chain, mint: string, opts?: {
        kind?: TokenEventKind;
        since?: string;
        limit?: number;
        before?: string;
    }): Promise<TokenEventsPage>;
    /**
     * The token card for one token (`GET /api/v1/tokens/:chain/:mint/card`): market, the all-time
     * high since launch, forensics coverage, hacc's safety and same-name facts, and tracked wallets
     * in the last hour. Free for every plan and the same for every caller; no key is needed. `tag`
     * is a card source tag (`v1.<group>.<poster>.<card>`) carried on `links.token` for counting card
     * arrivals; it credits nobody, and the route ignores a malformed one. The route is off until the
     * deployment sets `TOKEN_CARD_ENABLED` on; off it answers 503 `TOKEN_CARD_DISABLED`.
     */
    getTokenCard(chain: Chain, mint: string, opts?: {
        tag?: string;
    }): Promise<TokenCard>;
    verify(chain: Chain, mint: string): Promise<VerifyResult>;
    /**
     * BE-2006: optional third-party cluster analysis for a Solana token. Resolves the same
     * `ClusterResult` union as the API and `candle token clusters`, and never throws for an
     * unavailable analysis: unavailable is a normal result with a `reason`, not zero clustered supply.
     * A request that fails, times out or returns an unusable body resolves reason `transport_error`.
     * One request, no retry, no key sent, nothing cached here. Hood resolves `unsupported_chain`.
     */
    getTokenClusters(mint: string, opts?: {
        chain?: Chain;
    }): Promise<ClusterResult>;
    getOwnProfile(): Promise<OwnAgentProfile>;
    updateOwnProfile(patch: OwnAgentProfilePatch): Promise<{
        success: true;
        profileId: string;
    }>;
    /** The server counts, audits and saves this image without a subsequent PATCH. */
    uploadProfileImage(kind: "avatar" | "banner", bytes: Uint8Array, contentType: string): Promise<{
        imageUrl: string;
        profileId: string;
    }>;
    /**
     * Publish one post on this agent's own page (`POST /api/v1/agent/posts`). Needs an acting key
     * with `profileSelfEdit` allowed and no admin lock: a Read key is refused with `SCOPE_MISSING`,
     * a denied or locked one with `PROFILE_SELF_EDIT_DENIED`. 30 posts per UTC day per profile,
     * shared by all its keys and the owner; the 31st is `RATE_LIMITED`. A post is tied to no trade
     * or launch and is shown only on the agent's page.
     */
    createPost(req: CreateAgentPostRequest): Promise<{
        success: true;
        profileId: string;
        post: AgentPost;
    }>;
    /**
     * Delete one post of this agent's own profile, whoever wrote it (`DELETE /api/v1/agent/posts/:id`).
     * The same key requirements as `createPost()`. Deleting does not give the day's place back. An
     * unknown id, another profile's post and a post already deleted are `RECORD_NOT_FOUND`.
     */
    deletePost(postId: string): Promise<{
        success: true;
        profileId: string;
        postId: string;
    }>;
    /**
     * One published agent's posts, newest first (`GET /api/v1/agent/records/:profileId/posts`, no
     * credential). Pass the returned `cursor` to read the next older page. An agent that is not
     * published answers 404 `RECORD_NOT_FOUND` (`CandleApiError`), as its record does.
     */
    listAgentPosts(profileId: string, options?: ListAgentPostsOptions): Promise<AgentPostsPage>;
    getAgentProfile(idOrWallet: string): Promise<AgentProfile>;
    /**
     * The agent directory (`GET /api/v1/agent/directory`, no credential): every agent its owner
     * published, one page at a time, including one that has never traded. Pass the returned
     * `cursor` to read the next page; a page can be shorter than `limit` and still carry one. A
     * server that predates the directory answers 404 (`CandleApiError`).
     */
    listAgents(options?: ListAgentsOptions): Promise<AgentDirectoryPage>;
    /**
     * The calling account's tier snapshot: display/live tier, staked/held CNDL, qualification
     * thresholds, grace window state, resolved fee bps, and lifetime fee totals by chain/asset.
     * Not a "keyed endpoint" in the `requireKey()` sense below: the server accepts either an agent
     * key or a Privy session, so this method sends whatever `x-api-key` the client was constructed
     * with (possibly none) and lets the server's own auth middleware decide.
     */
    getAgentTier(): Promise<AgentTierInfo>;
    /**
     * The plan table in force on this deployment (`GET /api/v1/agent/plans`, no credential): each
     * plan's price, agent fee, perps builder fee, the limits a new key gets, what it can do
     * (`capabilities`), and `promoMaxDays`. Quote prices and fees from here rather than hard-coding
     * them: they differ by deployment and change at the three-plan launch. `planTableRows()` renders
     * it. A server that predates the table answers 404 (`CandleApiError`).
     */
    getPlans(): Promise<AgentPlansResult>;
    dryRunLaunch(req: LaunchRequest): Promise<DryRunResult | SelfLaunchDryRunResult>;
    /** Resolve only wallets explicitly named by this caller; server gates remain authoritative. */
    private prepareLaunch;
    /**
     * Launch from the named wallet (embedded by default), optionally with a whole-unit `buy`.
     * TEE wallets use selfLaunch()'s signing and recovery flow, including SelfLaunchOutcomeError
     * on Hood. Embedded launches use the idempotent retries described below.
     * Generates `clientLaunchId` when absent and
     * re-sends the SAME id on retryable failures; see the module doc for the exact policy.
     *
     * The id this call sent, yours or the generated one, is on the result
     * (`result.clientLaunchId`) and on every error thrown after the first request was sent
     * (`operationIds(error).clientLaunchId`), including the one thrown when the retries run out.
     * The built-in retries are safe only inside this one call. To retry after it throws, call
     * `launch()` again with that SAME id and the same body, or read `getLaunchJob(id)`. Never retry
     * without the id: a call with no id, or a new one, is a second launch. Pass your own id and
     * store it before the call when you can: an error can carry the id only if the process is
     * still running to catch it.
     */
    launch(req: LaunchRequest): Promise<LaunchResult>;
    /**
     * Fire-and-poll launch: sends `async: true`, returns the 202 body. Single attempt (poll
     * `waitForLaunch` instead of retrying the POST). Generates `clientLaunchId` like `launch()`
     * so the returned body always carries the id to poll.
     *
     * An error thrown after the request was sent carries that id too
     * (`operationIds(error).clientLaunchId`): the launch may have been accepted. Poll
     * `getLaunchJob(id)` / `waitForLaunch(id)`, or call again with the SAME id and body. Never
     * retry without the id: a call with no id, or a new one, is a second launch. Pass your own id
     * and store it before the call when you can.
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
     * Reads which wallets an agent profile may spend from
     * (GET /api/v1/agent/keys/{prefix}/wallets).
     *
     * Read `walletScope` before drawing conclusions from `wallets`: an empty list means "every
     * wallet on the account" under `"all"` and "none at all" under `"selected"`.
     */
    getProfileWallets(keyPrefix: string): Promise<ProfileWalletsResult>;
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
    getProfileTrades(keyPrefix: string, opts?: ProfileTradesOptions): Promise<ProfileTradesResult>;
    /**
     * One profile's realized P&L, fees, and open positions marked at current prices
     * (GET /api/v1/agent/keys/{prefix}/pnl). Read `unrealizedUsd` with `unmarkedPositions` and
     * `oldestMarkAt`: an unpriced position is counted there, never valued at zero.
     *
     * The figures are the key's share of the account's one P&L read, the console's figures to the
     * cent (`pnl.totalUsd` is the console's P&L, plus the Hyperliquid net when `perpsInTotal`).
     * Since 2026-10-02 the total is the sum of the key's wallets, not one pool across them, and
     * `lookback` is the account's activity bound; see `ProfilePnlResult` for every meaning that
     * changed.
     *
     * Check `unvalued` and `truncated` before quoting the number: the first counts fills that had
     * no trusted USD price and were left out rather than counted as zero, the second says the
     * lookback window was full and this is not a lifetime figure.
     */
    getProfilePnl(keyPrefix: string): Promise<ProfilePnlResult>;
    /**
     * What the account holds in the wallets Candle knows, on Solana and Hood, with prices
     * (GET /api/v1/agent/portfolio): the embedded wallet and every TEE wallet on each chain. Hood
     * wallets are in `hood`; see `PortfolioResult` for how Hood prices are keyed.
     *
     * Needs a key with the `account:read` scope (a whole-account inventory), or the server answers
     * `SCOPE_MISSING`. Vault and external wallets are not included: Candle does not know their
     * addresses. Check `complete` before quoting a total.
     */
    getPortfolio(): Promise<PortfolioResult>;
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
    setProfileWallets(keyPrefix: string, walletIds: string[]): Promise<{
        success: true;
        count: number;
    }>;
    /**
     * Switches a profile between all-wallets and assigned-only
     * (PUT /api/v1/agent/keys/{prefix}/wallet-scope).
     *
     * TIGHTENING ONLY from an agent key. Widening a profile back to `"all"` requires a Privy
     * session (the portal) and fails here with `LOOSEN_REQUIRES_SESSION`, for the same reason
     * raising a spend limit does: a leaked key must not be able to extend its own reach.
     */
    setProfileWalletScope(keyPrefix: string, scope: ProfileWalletScope): Promise<{
        success: true;
        scope: ProfileWalletScope;
    }>;
    /**
     * Reads this key's own effective spend limits (roadmap C, Task 5), so an agent can self-throttle
     * before a trade or launch ever hits `SPEND_LIMIT_EXCEEDED`. Read-only: raising a cap always
     * requires a Privy session (the portal), never this SDK -- see `SpendLimitsResult` for how to
     * resolve `keyLimits` into the cap that applies to a given trade.
     */
    getSpendLimits(): Promise<SpendLimitsResult>;
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
    swap(req: SwapRequest): Promise<SwapResult>;
    /**
     * Lists the embedded Solana wallet's empty token accounts that a close would reclaim, on both
     * token programs, and the SOL their rent returns (BE-418). Read-only: nothing is built, signed or
     * written, and any key scope may call it.
     *
     * With `wallet` (a Solana TEE wallet's linked-wallet id, BE-1687), the same preview for that TEE
     * wallet, by any key bound to it. Off on a deployment until it is enabled
     * (`AGENT_TEE_CLOSE_EMPTY_ENABLED`): until then it throws LAUNCH_DISABLED.
     */
    previewCloseEmptyAccounts(req?: PreviewCloseEmptyAccountsRequest): Promise<CloseEmptyAccountsPreview>;
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
     *
     * With `wallet` (a Solana TEE wallet's linked-wallet id bound to this key, BE-1687), the TEE
     * wallet's close instead. Needs `swap:write`, `privyWalletId`, and that wallet's signer in
     * `secretStore`. Three steps: `POST /agent/wallets/:id/close-empty/build` (the server builds
     * the close transactions, every one CloseAccount with the TEE wallet as fee payer, rent
     * destination and owner, and stamps them for the relay), `signLinkedTransaction()` per
     * transaction, then `POST .../close-empty/submit` with the whole signed batch, which the server
     * checks against the build before it sends anything. A build with nothing to close returns
     * `nothing_to_close` without signing. A `recovering` result means a transaction may still land:
     * nothing is sent again, and getCloseEmptyAccountsJob(clientTradeId, { wallet }) reads it until
     * it settles. A TEE wallet's build is signable once: after a lost answer, read the job rather
     * than calling this again. Off on a deployment until it is enabled
     * (`AGENT_TEE_CLOSE_EMPTY_ENABLED`): until then it throws LAUNCH_DISABLED.
     */
    closeEmptyAccounts(req: CloseEmptyAccountsRequest): Promise<CloseEmptyAccountsResult>;
    /**
     * Reads a closeEmptyAccounts() run by its clientTradeId, without sending anything (BE-418). With
     * `wallet`, a TEE wallet's run (BE-1687, `swap:write`): that read also reconciles the run against
     * the chain, so a `recovering` close settles by reading it again. It never signs or sends.
     */
    getCloseEmptyAccountsJob(clientTradeId: string, opts?: CloseEmptyAccountsJobOptions): Promise<CloseEmptyAccountsJob>;
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
    importWallet(params: {
        chain: WalletChain;
        address: string;
        privateKey: string;
        signerPublicKey: string;
        label?: string;
    }): Promise<ImportWalletResult>;
    /**
     * Self-signed launch dry run: the same body as `buildSelfLaunch()`, the same checks (payer and
     * TEE rules, plan, the key's caps), and the same refusals, without building, reserving or
     * recording anything; the `clientLaunchId` stays unused. Does not check the payer's balance, the
     * day cap, a `clientLaunchId` already used with another body or payer, or a Solana TEE wallet's
     * USD spend window; `buildSelfLaunch()` can still refuse for those.
     *
     * @deprecated Use dryRunLaunch({ ...fields, wallet }) for one release.
     */
    dryRunSelfLaunch(req: BuildSelfLaunchRequest): Promise<SelfLaunchDryRunResult>;
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
     *
     * @deprecated Use launch({ ...fields, wallet }) for one release.
     */
    buildSelfLaunch(req: BuildSelfLaunchRequest): Promise<BuildSelfLaunchResult>;
    /** buildSelfLaunch()'s request; selfLaunch() passes its `op` so its exits can expose the id. */
    private postSelfLaunchBuild;
    /**
     * Self-signed launch confirm: verifies the agent's own broadcast on-chain, then records the
     * launch identically to the headless path. Signature is the transaction hash from the agent's
     * own broadcast. devBuySignature (Hood only) is the optional follow-up dev-buy transaction. See
     * selfLaunch() below for the one-call version of this whole flow (Solana). The result carries
     * the `clientLaunchId` from the request (the server's body does not).
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
    buildTrade(req: BuildTradeRequest): Promise<BuildTradeResult>;
    /** buildTrade()'s request; trade() passes its `op` so its exits can expose the id. */
    private postTradeBuild;
    /**
     * Reads one trade from the idempotency ledger by its `clientTradeId`, without sending
     * anything: the read to make after a `trade()` that threw or timed out, before deciding whether
     * to send again. Needs `swap:write` (the scope the trade itself needed) and answers during a
     * kill switch.
     *
     * - 404 `JOB_NOT_FOUND` (a thrown `CandleApiError`): the write never began. Call again with the
     *   same id.
     * - `confirmed`: the trade landed; `signature` is on the job. A same-id `trade()` replays it.
     * - `failed` with `errorCode: "TRADE_REVERTED"`: it landed and reverted. A new trade needs a
     *   new id.
     * - `failed`, other: not confirmed. A row with broadcast evidence may still be on chain; a
     *   same-id `trade()` is the check, and answers `IDEMPOTENCY_CONFLICT` with
     *   `stage: "unconfirmed"` for it.
     * - `built`: in flight or unresolved. A same-id `trade()` answers `IDEMPOTENCY_CONFLICT`; if it
     *   carries `stage: "unconfirmed"` and `retryable: false`, check its `signature` on chain and
     *   do not retry.
     *
     * Non-TEE Hood linked jobs include signedLegs and resolve receipts on read. A landed trade
     * on a built row can be recorded with confirmTrade using the trade and fee hashes; on a failed
     * row it cannot: do not retry or rebuild. A reverted leg beside an unsettled one is not a
     * settled id. Approval-only new-id advice is obtained on build only, after claim retirement.
     *
     * For a linked payer, also check the wallet's recent transactions before sending again: see
     * `trade()`.
     */
    getTradeJob(clientTradeId: string): Promise<TradeJob>;
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
     * v1 supports `from: "SOL"` only from a linked wallet. Same-chain conversions (SOL/USDC/CNDL)
     * are `trade()` with a base-asset mint (free, every tier); USDC/CNDL origins convert to SOL that
     * way first. A TEE payer (Ember Phase 4c) may bridge SOL or USDC directly with `clientTradeId`;
     * see `LinkedSwapRequest`. Its errors add `BRIDGE_DESTINATION_MISSING` and `RELAY_STEP_REFUSED`
     * (`BRIDGE_ERROR_CODES`).
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
     *
     * ## The id, and retrying
     *
     * The `clientTradeId` this call sent, yours or the generated one, is on the result and on every
     * error thrown after the build request was sent (`operationIds(error).clientTradeId`): a
     * `CandleApiError` or `JsonRpcError` gains it, and a lost response or any other failure is a
     * `CandleOperationError` carrying it, with the original as `cause`. Pass your own id for
     * anything that moves funds and store it before the call: an error can carry the id only if
     * the process is still running to catch it. Never retry without the id: a call with no id, or a
     * new one, is a second, independent trade. This method does not retry on its own.
     *
     * - **Main payer** (`from: "main"`): the trade executes inside the build call, so a lost
     *   response can sit on a trade that already moved funds. With the id, read `getTradeJob(id)`
     *   or call `trade()` again with the same id and body. Both are safe: the same-id call is a
     *   replay, not a second trade. `getTradeJob()`'s jsdoc says what each job state means.
     * - **Linked Hood payer**: once any leg is signed, the server refuses a same-id build.
     *   TradeLegOutcomeError keeps the failing leg's txHash and earlier landedLegs. Inspect those
     *   hashes, then read getTradeJob(id) or call trade() with the same id and body for Candle's
     *   view. Never retry a retryable:false answer. A built prior_attempt_on_chain can be recorded
     *   with confirmTrade using signature as tradeTxHash and the fee hash from legs (pay a missing
     *   fee first, following TradeLandedFeeLegError). A failed row cannot be recorded with /confirm:
     *   retain the hashes and do not retry or rebuild. Approval-only new-id advice follows committed
     *   retirement and repeats unchanged. Reverted beside an unsettled leg never advises a new id.
     *   TradeLandedUnconfirmedError means all legs landed but booking failed: read the job first.
     * - **Linked Solana payer**: read getTradeJob(id) and check the wallet before sending again.
     */
    trade(req: TradeRequest): Promise<ExecutedTradeResult>;
    /** trade()'s steps. Every error leaves through trade()'s runOperation(), which adds the id. */
    private tradeSteps;
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
     *
     * ## The id, and retrying
     *
     * The `clientLaunchId` this call sent, yours or the generated one, is on the result and on every
     * error thrown after the build request was sent (`operationIds(error).clientLaunchId`). Pass
     * your own id and store it before the call when you can. Never retry without the id: a call
     * with no id, or a new one, is a second, independent launch.
     *
     * This method signs and broadcasts on the caller's side, so an error after the broadcast may
     * sit on a launch transaction that landed. Read `getLaunchJob(id)` first.
     *
     * On Solana the id is enough to keep a second launch from being built. One id has one build
     * at a time: `buildSelfLaunch()` under the same id returns the SAME transaction while the
     * earlier one can still land, refuses with `IDEMPOTENCY_CONFLICT` and
     * `reason: "prior_attempt_on_chain"` once it has landed, and builds a new transaction only
     * after the chain proves the earlier one expired. A launch that landed is recorded with
     * `confirmSelfLaunch({ clientLaunchId, signature })`, which keeps working after the build's
     * 30-minute `expiresAt`. Inside this call, a blockhash error from your Solana RPC is retried
     * with the bytes already signed: they are signed once, and signed again only when the server
     * returns a different transaction. Calling `selfLaunch()` again under the same id while the
     * earlier build is still live is refused by the sign relay, because that transaction's sign
     * claim is already spent: broadcast what was signed, or wait for it to expire.
     *
     * On Hood the id is necessary and NOT sufficient: a rebuild under the same id builds a new
     * curve, so calling `selfLaunch()` again can create and broadcast a second one. If the job is
     * not `confirmed`, check the wallet's recent transactions before sending again.
     *
     * ## Hood: a failure after the curve landed
     *
     * Once the create-curve transaction is mined successfully, a failure of the fee transfer or of
     * the confirm call throws a `SelfLaunchOutcomeError`, not a `CandleOperationError` or a bare
     * `CandleApiError`. It carries `clientLaunchId`, `createCurveTxHash`, `step`
     * (`"feeTransfer"` or `"confirm"`), `feeOutcome` and every fee hash this call learned
     * (`feeTxHash`); the original error is its `cause`. The curve exists: never call `selfLaunch()`
     * or `buildSelfLaunch()` again for that attempt, under the same id or a new one. Recover with
     * `confirmSelfLaunch({ clientLaunchId, signature: createCurveTxHash, feeTxHash? })` as the
     * error's doc describes for each `feeOutcome`. This method sends nothing a second time and
     * does not pay a fee again. An error from before the create-curve receipt is unchanged,
     * including a create-curve broadcast whose answer was lost: that case keeps no hash.
     *
     * @deprecated Use launch({ ...fields, wallet }) for one release.
     */
    selfLaunch(req: SelfLaunchRequest): Promise<ConfirmSelfLaunchResult>;
    /** selfLaunch()'s steps. Every error leaves through selfLaunch()'s runOperation(), which adds the id. */
    private selfLaunchSteps;
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
     *
     * The result carries the `clientLaunchId` the build was sent under (the server's body does
     * not), and so does every error thrown after the request was sent
     * (`operationIds(error).clientLaunchId`). Keep it: `bundleId` is single-use, and the launch's
     * identity for any later read or retry is the `clientLaunchId`. Retry a failed build with the
     * SAME id and body, or read `getLaunchJob(id)`; a call with no id, or a new one, is a second
     * launch. After a submit, follow the steps on `launchAtomic()`. Pass your own id and store it
     * before the call when you can.
     */
    buildAtomicLaunch(req: BuildAtomicLaunchRequest): Promise<BuildAtomicLaunchResult>;
    /**
     * Atomic launch dry run: the same body as `buildAtomicLaunch()`, the same checks (payers, plan,
     * the Believer check, each leg's fee and spend limits, the key's transaction cap) and the same
     * refusals, plus the launch preview and one fill per first buy. Records, reserves and draws
     * nothing: no day-cap slot, no vanity mint, no spend reservation, and the `clientLaunchId` stays
     * unused. Does not check balances, the day cap, a `clientLaunchId` already used with another body,
     * a TEE leg's USD spend window or the transaction's size; `buildAtomicLaunch()` can still refuse
     * for those. Sends the body as given, like `dryRunLaunch()`: name a `clientLaunchId`.
     */
    dryRunAtomicLaunch(req: BuildAtomicLaunchRequest): Promise<AtomicDryRunResult>;
    /**
     * The atomic build request itself. Sets `clientLaunchId` on the result from the request, since
     * the server's body omits it. Shared by buildAtomicLaunch() and launchAtomic(), each of which
     * runs it inside its OWN runOperation(), so an error is wrapped once, by the outermost method.
     */
    private postAtomicBuild;
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
     * request that was about to return a normal, if late, response. A same-id
     * `buildAtomicLaunch()`/`launchAtomic()` after a send can itself take up to about 95 seconds to
     * answer, because the server resolves the first attempt against the chain before doing anything
     * new: allow for that too.
     *
     * This method is given only a `bundleId`, so its result cannot carry the launch's
     * `clientLaunchId`. Keep the one `buildAtomicLaunch()` returned: after a `"failed"` or
     * `"timeout"`, recovery goes through it (the steps are on `launchAtomic()`), never through
     * this `bundleId` and never through a new id.
     */
    submitAtomicLaunch(req: SubmitAtomicLaunchRequest): Promise<SubmitAtomicLaunchResult>;
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
     * Returns `submitAtomicLaunch()`'s outcome plus the `clientLaunchId` the launch was sent under
     * (`LaunchAtomicResult`), on `"landed"`, `"failed"` and `"timeout"` alike -- see that method's
     * jsdoc for why `"failed"`/`"timeout"` are returned here rather than thrown, and for the
     * recommended client-side timeout. A thrown error carries `clientLaunchId` too, and `bundleId`
     * once the build has answered (`operationIds(error)`). Pass your own id and store it before the
     * call when you can: an error can carry the id only if the process is still running to catch it.
     *
     * ## After a `timeout`, a `failed`, or an error that carries `clientLaunchId`
     *
     * `bundleId` is dead once `/submit` has been called and is never resubmitted; it is for log
     * correlation only. The launch's identity is `clientLaunchId`:
     *
     * 1. Read `getLaunchJob(clientLaunchId)`. It needs `launch:read` on the key; a key whose scopes
     *    were named by hand holds it only if it was named. A scope refusal is not "not found".
     * 2. `confirmed`: the bundle landed. The mint is on the job. Stop.
     * 3. 404 `JOB_NOT_FOUND`: the build never began. Call `launchAtomic()` again with the same id.
     * 4. `failed`: the bundle did not land. Call `launchAtomic()` again with the SAME id; the server
     *    starts a clean attempt under it.
     * 5. Any other status: the bundle may still land. Wait, then read the job again or call
     *    `launchAtomic()` again with the SAME id and the same body. The server resolves the first
     *    attempt before doing anything new. It answers 409 `IDEMPOTENCY_CONFLICT` while the first
     *    attempt is unresolved or has just been found landed, so on that 409 read the job again. It
     *    builds a fresh bundle only when the first is proven reverted. This same-id call can take
     *    about 95 seconds to answer, because the server waits on the chain.
     * 6. Never send a new id while the job is not `failed`: that is a second token. This includes
     *    the 409 whose message says "use a new clientLaunchId to launch again": read the job first,
     *    because that message is also what a caller sees for a launch it does not yet know landed.
     * 7. One state has no terminal answer today. The same-id call keeps answering 409 "This launch
     *    was sent; its original attempt must be resolved" and the job is neither `confirmed` nor
     *    `failed`, still, a few minutes after the submit (a blockhash lives about 90 seconds and the
     *    rebuild itself can take about 95). Stop: do not send a new id on a timer, and report the
     *    `clientLaunchId` and `bundleId` to whoever operates the key.
     * 8. Treat every `timeout` as unresolved. `retryable` is `false` on every one the server returns
     *    today, and it is never permission to relaunch under a new id.
     */
    launchAtomic(req: LaunchAtomicRequest): Promise<LaunchAtomicResult>;
    /** launchAtomic()'s steps. Every error leaves through launchAtomic()'s runOperation(), which adds the ids. */
    private launchAtomicSteps;
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
     *
     * `surfaceLegOutcome` is every Hood trade leg and selfLaunch()'s fee leg. A receipt revert, a
     * receipt read that fails, a receipt timeout, or a broadcast that was refused or whose result
     * is ambiguous then throws `EvmLegOutcome` with the hash once it is known. Every other caller
     * (selfLaunch()'s create-curve leg) gets the original error.
     */
    private signBroadcastAndWaitEvmLeg;
    private broadcastAndWaitEvmLeg;
    /** Public Hyperliquid reads on this machine. A Candle key of any scope is required.
     * The only Candle call is perpsConfig(), once per client; market data is cached for 5 seconds.
     */
    private marketReader;
    perpsMarkets(opts?: PerpsMarketsOptions): Promise<PerpsMarketsResult>;
    perpsMarket(coin: string): Promise<PerpsMarketResult>;
    perpsBook(coin: string, opts?: PerpsBookOptions): Promise<PerpsBookResult>;
    perpsCandles(coin: string, opts?: PerpsCandlesOptions): Promise<PerpsCandlesResult>;
    /** The server's perps settings: network, Candle's builder, this key's fee, and its limits. */
    perpsConfig(): Promise<PerpsConfig>;
    /**
     * One-time setup (R1): approves Candle's builder fee at 0.1% unless Hyperliquid already shows
     * it, and reports the account's mode and balance. Idempotent.
     */
    perpsSetup(params: PerpsWalletRef): Promise<PerpsSetupResult>;
    /**
     * Open (or add to) a position: build, check, sign through the relay, submit to Hyperliquid. With
     * `clientId`, a retry of the same request returns the original operation (`replayed: true`).
     */
    perpsOpen(params: PerpsOpenParams & {
        clientId?: undefined;
    }): Promise<PerpsActionResult>;
    perpsOpen(params: PerpsOpenParams): Promise<PerpsActionResult | PerpsReplayResult>;
    /** Close all or part of a position with a reduce-only IOC order. Reserves nothing. Takes `clientId` as open does. */
    perpsClose(params: PerpsCloseParams & {
        clientId?: undefined;
    }): Promise<PerpsActionResult>;
    perpsClose(params: PerpsCloseParams): Promise<PerpsActionResult | PerpsReplayResult>;
    /** Cancel an order Candle built, by its cloid. */
    perpsCancel(params: PerpsCancelParams): Promise<PerpsActionResult>;
    /** Change a resting order's price or size. The replacement gets a new cloid. */
    perpsModify(params: PerpsModifyParams): Promise<PerpsActionResult>;
    /**
     * Set a market's leverage and margin mode on the account, within the key's maxLeverage. With
     * `mode` and no `leverage`, the current leverage is kept (spec D, section 5); a mode change needs
     * no position and no resting order in the coin. The answer reports the mode asked for and the one
     * Hyperliquid shows after the submit, separately.
     */
    perpsLeverage(params: PerpsLeverageParams): Promise<PerpsActionResult>;
    /** Add (positive) or remove (negative) isolated margin on an isolated position. */
    perpsMargin(params: PerpsMarginParams): Promise<PerpsActionResult>;
    /**
     * Positions and account value, read live from Hyperliquid by the wallet's address. The server's
     * fields are unchanged; `rows`, `accountLine` and `risk` (BE-1582, spec A-3) come from a direct
     * read on this machine at the key's thresholds.
     */
    perpsPositions(walletId: string): Promise<PerpsPositions>;
    /** Open orders on Hyperliquid, and Candle's record of every action it built, settled first. */
    perpsOrders(walletId: string, opts?: {
        limit?: number;
    }): Promise<PerpsOrders>;
    /**
     * One page of the wallet's fills, read directly from Hyperliquid's `/info` (spec 2026-10-17 C,
     * sections 3 and 4). Candle resolves only the wallet's address; no Candle credential reaches
     * Hyperliquid, and a read-capable key is enough. Default window: the last seven days, fixed on the
     * first page; pass `nextCursor` back as `cursor` for the next one. Live venue data for this wallet,
     * not Candle's ledger and not an all-time total: Hyperliquid serves only the 10,000 most recent
     * fills. `closedPnl` is gross and `fee` already includes `builderFee`. Throws `PerpsHistoryError`.
     */
    perpsFillsPage(walletId: string, options?: PerpsHistoryOptions): Promise<PerpsFillsPage>;
    /** One page of the wallet's funding payments, as `perpsFillsPage()` reads fills. `delta.usdc` is signed: negative was paid. */
    perpsFundingPage(walletId: string, options?: PerpsHistoryOptions): Promise<PerpsFundingPage>;
    private perpsHistoryPage;
    /** The address of an EVM TEE wallet bound to this key, from Candle's own list of the key's wallets. */
    private perpsWalletAddress;
    /** Fills, read live from Hyperliquid by the wallet's address. */
    perpsFills(walletId: string): Promise<{
        success: true;
        fills: Record<string, unknown>[];
    }>;
    /** Funding payments since `startTime` (epoch ms; default the last 7 days). */
    perpsFunding(walletId: string, startTime?: number): Promise<{
        success: true;
        startTime: number;
        funding: Record<string, unknown>[];
    }>;
    /** The key's risk thresholds: stored and effective. An older API reports none: the defaults, sourced so. */
    getPerpsRisk(): Promise<PerpsRiskSettingsResult>;
    /**
     * Tighten the calling key's own thresholds (`PUT /keys/self/perps-risk`). Anything looser than
     * the effective set, including clearing a field stored stricter than its default, is refused with
     * 403 LOOSEN_REQUIRES_SESSION: the owner loosens with `setKeyPerpsRisk()`.
     */
    setPerpsRisk(fields: PerpsRiskWrite): Promise<PerpsRiskWriteResult>;
    /**
     * The owner's write on any of the account's keys (`PUT /keys/:prefix/perps-risk`): may loosen or
     * clear. Needs an owner credential, the CLI's device token or a Privy session token, sent as a
     * bearer token; the client's API key is not sent and would be refused.
     */
    setKeyPerpsRisk(keyPrefix: string, fields: PerpsRiskWrite, owner: {
        bearerToken: string;
    }): Promise<PerpsRiskWriteResult>;
    /**
     * One-shot risk (spec A-8): `ok`, `warn` or `critical` with its drivers, from a direct read of
     * Hyperliquid at the key's thresholds. `unknown` for a non-standard account mode or a stale read.
     * A failed venue read throws `HyperliquidReadError` (`code: "PERPS_READ_FAILED"`). Stateless: no
     * hysteresis (that is `watchPerpsRisk()`).
     */
    perpsRisk(params: {
        walletId: string;
        address?: string;
    }): Promise<PerpsRiskReport>;
    /**
     * The account line (spec A-10): account value, margin, free margin, withdrawable, the margin
     * ratio, and realized P&L, fees and funding over a recent window (`since`, epoch ms; default the
     * last 24 hours, at most 30 days).
     */
    perpsAccount(params: {
        walletId: string;
        address?: string;
        since?: number;
    }): Promise<PerpsAccountReport>;
    /**
     * The loop `candle perps watch` runs (spec A-9): polls Hyperliquid every `intervalMs` (default
     * 10 s), calls `onEvent` with a start event, one event per level change (rising immediately,
     * falling past the clear band), heartbeats and errors, and resolves with the last level when
     * `signal` aborts. Candle is asked for thresholds at start and every 5 minutes only.
     */
    watchPerpsRisk(params: {
        walletId: string;
        address?: string;
        intervalMs?: number;
        heartbeatMs?: number;
        signal?: AbortSignal;
        onceLevelChange?: boolean;
        onEvent: (event: PerpsWatchEvent) => void | Promise<void>;
    }): Promise<{
        level: PerpsRiskReport["level"];
    }>;
    /**
     * The portfolio's Hyperliquid section (spec A-11) for EVM TEE addresses: account value, unrealized
     * P&L, positions and level at the default thresholds per account, and a subtotal. Live from
     * Hyperliquid and never part of any portfolio total.
     */
    perpsPortfolioSection(wallets: readonly {
        address: string;
        label?: string;
        walletId?: string;
    }[]): Promise<PerpsPortfolioSection>;
    /**
     * The private per-key stream (Hyperliquid phase 3, P3-7): opens Candle's
     * `GET /api/v1/agent/perps/stream?walletId=` WebSocket with this client's key on the upgrade
     * headers. Header-capable WebSocket required, so browsers are out of this surface (E14): Bun
     * and Node 22+ use their global WebSocket, Node 18 and 20 fall back to undici's (this
     * package's runtime dependency), and CandleClientOptions.perpsStreamWebSocket overrides both.
     * Requires the server's risk monitor (`HYPERLIQUID_MONITOR` shadow or on): with it off the
     * upgrade is refused 503 and the socket closes with that refusal.
     *
     * `onMessage` receives every frame as parsed JSON: `snapshot` on connect (the account line,
     * positions, open orders, the risk report, the monitor block and `ordersSource` "push" or
     * "poll"), `positions`, `risk`, `order`, `fill` and `heartbeat` every 30 s, and `error` when a
     * source read failed. A revoked, paused or expired key is closed with code 4401; a slow
     * consumer with 1013. Nothing is replayed on reconnect: a reconnect gets a fresh `snapshot`,
     * and fills missed while disconnected are read from `perpsFills()` (`GET /perps/fills`).
     *
     * Returns the handle; `close()` ends it (a close before the connection opens is applied the
     * moment it does), and an aborted `signal` closes it too.
     */
    perpsStream(params: {
        walletId: string;
        onMessage: (frame: PerpsStreamFrame) => void;
        /** How the socket ended, once: its close code and reason (4401 key stopped, 1013 slow consumer). */
        onClose?: (close: {
            code: number;
            reason: string;
        }) => void;
        signal?: AbortSignal;
    }): {
        close(): void;
    };
    private perpsThresholdsOrDefaults;
    /**
     * Deposit onto the key's Hyperliquid account through Relay (Perps C, HL-ED-8): build, check the
     * build names `account` on chain 1337 with no Candle fee, then sign through the relay and submit.
     * From Solana that is one deposit transaction; from Hood each sequenced leg (approve, then the
     * deposit) is signed and submitted in turn. The fill is Relay's, after the deposit lands: read it
     * with `perpsDepositStatus()`. Candle checks Relay's steps before it stamps them; `candle perps
     * deposit` additionally decodes them on the caller's machine.
     */
    perpsDeposit(params: PerpsDepositParams): Promise<PerpsDepositResult>;
    /** A deposit's job: what was built and submitted, the Hood operation, and Relay's fill status. */
    perpsDepositStatus(clientDepositId: string): Promise<{
        success: true;
        job: Record<string, unknown>;
    }>;
    /** The builder every perps build is checked against (see `hyperliquidBuilder` in the options). */
    private perpsBuilder;
    private perpsBuilderTrust;
    /**
     * Check, sign, submit (HL-ED-2, HL-ED-5). The check runs before the relay is called; a build
     * that fails it is refused with nothing signed. BE-1584: every method is checked against this
     * machine's own read of Hyperliquid (`verifyPerpsBuildAgainstVenue`), and the venue's answer is
     * judged per leg (`outcome`).
     */
    private perpsComplete;
    /**
     * Schedule Hyperliquid's cancel-all timer `seconds` from now (at least 5), or clear it. The timer
     * is wallet-wide: it cancels every open order on the account, protection included, and no
     * positions. Candle fixes the time at build and this client refuses to sign one less than five
     * seconds ahead. An acknowledged set is recorded on Candle (`acknowledged`); no public read can
     * confirm the timer, and Hyperliquid's 10 triggers per UTC day are never counted here.
     */
    perpsScheduleCancel(params: PerpsScheduleCancelParams): Promise<PerpsActionResult>;
    /**
     * Attach, change or remove the position's take-profit and stop-loss (spec D, section 6): each leg
     * a reducing market trigger sized to the position now. A change cancels the old leg first (a
     * protection gap, named in `warnings`), confirms it gone, re-reads, then places the new one; a
     * partial result is reported as `complete: false`. Legs Candle did not build are listed in
     * `unowned` and never touched. Calling this is the caller's intent; there is no prompt.
     */
    perpsTpsl(params: PerpsWalletRef & PerpsTpslParams): Promise<PerpsWorkflowResult>;
    /**
     * Cancel every open main-perp order on the wallet, then close every main-perp position (spec D,
     * section 8). At most 100 signed steps per call; `complete` only when a final read shows nothing
     * left. Spot, HIP-3 and vault exposure is out of scope (`scope: "main-perps"`).
     */
    perpsFlatten(params: PerpsWalletRef): Promise<PerpsWorkflowResult>;
    private perpsWorkflowIo;
    /** The calling key's perps reduce-only setting (`GET /keys/self/perps-reduce-only`). Throws on a failed read. */
    getPerpsReduceOnly(): Promise<PerpsReduceOnlyResult>;
    /**
     * Turn the calling key's perps reduce-only on (`PUT /keys/self/perps-reduce-only`). The key can
     * never turn it off (403 LOOSEN_REQUIRES_SESSION): the owner does that with `setKeyPerpsReduceOnly()`.
     * It constrains future Candle builds only: resting orders stay, signed actions stay valid.
     */
    setPerpsReduceOnly(perpsReduceOnly: true): Promise<PerpsReduceOnlyResult>;
    /**
     * The owner's write on any of the account's keys (`PUT /keys/:prefix/perps-reduce-only`): on or
     * off. Needs an owner credential (the CLI's device token or a Privy session token), sent as a
     * bearer token; the client's API key is not sent and would be refused.
     */
    setKeyPerpsReduceOnly(keyPrefix: string, perpsReduceOnly: boolean, owner: {
        bearerToken: string;
    }): Promise<PerpsReduceOnlyResult>;
    /**
     * Withdraw USDC from the key's Hyperliquid account to the same key's own Solana or Hood TEE wallet
     * through Relay (spec 2026-10-17, route A). MOVES REAL FUNDS. Needs `perps:withdraw`.
     *
     * Every signature is checked first, and a mismatch throws with nothing signed: the NonceMapping
     * names this key's account and the build's Relay order id (`relayOrderId`, never the step
     * `relayRequestId`), and the build lands on one of `ownDestinations` (the recipient check: Relay's
     * own record of the request is not read, BE-1777); then the SendAsset carries the mapping's nonce,
     * the exact amount asked for, and the pinned token, dex and depository. The client posts the
     * SendAsset to Hyperliquid itself and reports the answer. There is no confirmation gate here: the
     * CLI has one (`candle perps withdraw`).
     */
    perpsWithdraw(params: PerpsWithdrawParams): Promise<PerpsWithdrawResult>;
    /**
     * Sign EIP-712 typed data with a linked EVM TEE wallet through the relay
     * (`eth_signTypedData_v4`). The relay signs only typed data a perps build stamped.
     */
    private signLinkedTypedData;
    private requireKey;
    private headers;
    /**
     * Runs a one-call write method's steps so that every exit exposes the idempotency id it sent
     * (see the module doc, "The id on every outcome"). The steps pass `op` to the request that
     * carries the id. Until that request is handed to fetch, an error leaves unchanged: nothing
     * reached the server, so there is nothing to replay. After it, `withOperationIds()` puts the
     * ids on a `CandleApiError`/`JsonRpcError` and wraps anything else in a `CandleOperationError`.
     *
     * Called once per public method, never nested: an inner step that is itself a one-call method
     * (launchAtomic()'s build) runs its plain request, so the error is wrapped once, here.
     */
    private runOperation;
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
/** Test-only. Pass null to restore the production receipt wait. */
export declare function __setEvmReceiptWaitForTest(opts: {
    timeoutMs?: number;
    pollMs?: number;
} | null): void;
/** This build's own version. Kept in lockstep with package.json by the release-bump CI guard. */
export declare const SDK_VERSION = "0.6.10";
/** Test seam: the once-per-process latch would otherwise weld the suite's first case to the rest. */
export declare function __resetSdkUpdateNoticeForTest(): void;
//# sourceMappingURL=client.d.ts.map