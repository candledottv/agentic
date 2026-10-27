/**
 * Optional per-key section from getProfilePnl (agent-page perps §8.2; Hyperliquid spec R7 as
 * amended): a separate heading and net, also counted in the total. When `read` is true,
 * `pnl.totalUsd` includes `netUsd` and the answer's `perpsInTotal` is true.
 */
export interface HyperliquidPnlFigures {
  realizedGrossUsd: number
  /** Venue fee, already inclusive of builder fees; negative fees are rebates. */
  feesUsd: number
  /** Positive is received, negative is paid. */
  fundingUsd: number
  /** realizedGrossUsd + fundingUsd - feesUsd. */
  realizedNetUsd: number
  /** Main-perp fills and funding payments counted, over every binding period of the profile. */
  fills: number
  fundingPayments: number
}

/** One open main-perp position at the live cutoff. No wallet address, no account value. */
export interface HyperliquidPerpsPosition {
  kind: "perp"
  coin: string
  side: "long" | "short"
  size: string
  leverage: { value: number; type: string }
  entryPx: string
  /** Null when the coin has no mark; its unrealized is then excluded and the figures partial. */
  markPx: string | null
  positionValueUsd: string
  marginUsedUsd: string
  unrealizedPnlUsd: string
  returnOnEquity: string
  liquidationPx: string | null
  liquidationDistance: number | null
  /** Funding since the position opened. Positive when earned, negative when paid. */
  fundingNetUsd: string
  level: "ok" | "warn" | "critical" | "none"
}

/** One binding period of an EVM TEE wallet to the key's profile. */
export interface HyperliquidWalletPnl {
  address: string
  fromMs: number
  /** Null while the wallet is still bound to the profile. */
  toMs: number | null
  /** Same as `fromMs`. Kept for older CLIs. */
  startTime: number
  /** The wallet's effective cutoff: facts and unrealized both stop here. Epoch milliseconds. */
  observationCutoffMs: number
  completeThroughMs: number
  /**
   * `settled`: the figures stop at the wallet's last certified snapshot cutoff. `live`: they use
   * this request's live cutoff, reconciled on one read without a settle-interval repeat.
   */
  reconciliation: "settled" | "live"
}

export type HyperliquidPnlUnavailableCode =
  | "hyperliquid_unavailable"
  | "ingest_incomplete"
  /** Cannot fit this request's fixed budget without a certified snapshot; retries alone cannot help. */
  | "live_budget_exceeded"
  | "cutoff_unreconciled"
  | "account_mode"
  | "no_profile"
  | "test_key"
  | "too_many_wallets"

export type HyperliquidPnlSection =
  | (HyperliquidPnlFigures & {
      read: true
      network: "mainnet" | "testnet"
      /** Every EVM TEE wallet bound to the key's profile, per binding period. */
      coverage: "profile"
      /** Unrealized at each wallet's effective cutoff, a USD decimal string. */
      unrealizedUsd: string
      /** realizedNetUsd + unrealizedUsd, a USD decimal string. Inside `pnl.totalUsd`. */
      netUsd: string
      /** The oldest effective wallet cutoff, not the response time. Null with no wallet. */
      markedAt: number | null
      /** Opaque identity of the wallet cutoff vector. Null with no wallet. */
      perpsSnapshotId: string | null
      /** The lowest wallet completeness watermark. Null with no wallet. */
      completeThroughMs: number | null
      positions: HyperliquidPerpsPosition[]
      byWallet: HyperliquidWalletPnl[]
      /** Part of the history is not covered (see `partialReasons`). Replaces `truncated`. */
      historyPartial: boolean
      partialReasons: string[]
      /** Kept for older CLIs: equals `historyPartial`. */
      truncated: boolean
      /** Kept for older CLIs: the page sizes and the wallet cap. */
      fillsLimit: number
      fundingLimit: number
      walletsLimit: number
    })
  | { read: false; code: HyperliquidPnlUnavailableCode; reason: string }
