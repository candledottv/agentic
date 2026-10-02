/** Optional per-key section from getProfilePnl (Hyperliquid spec R7). Separate from spot totals. */
export interface HyperliquidPnlFigures {
  realizedGrossUsd: number
  /** Venue fee, already inclusive of builder fees; negative fees are rebates. */
  feesUsd: number
  /** Positive is received, negative is paid. */
  fundingUsd: number
  /** realizedGrossUsd + fundingUsd - feesUsd; excludes unrealized PnL. */
  realizedNetUsd: number
  fills: number
  fundingPayments: number
}

export interface HyperliquidWalletPnl extends HyperliquidPnlFigures {
  walletId: string
  address: string
  /** Current TEE binding starts here; previous bindings are excluded. Epoch milliseconds. */
  startTime: number
  fillsTruncated: boolean
  fundingTruncated: boolean
}

export type HyperliquidPnlSection =
  | (HyperliquidPnlFigures & {
      read: true
      network: "mainnet" | "testnet"
      /** Per-wallet venue response limits, before filtering to main perps and this binding. */
      fillsLimit: number
      fundingLimit: number
      walletsLimit: number
      truncated: boolean
      byWallet: HyperliquidWalletPnl[]
    })
  | { read: false; reason: string }
