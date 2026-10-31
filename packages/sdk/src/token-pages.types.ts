// Wire DTOs mirror packages/shared/src/token-pages.ts; token-pages.contract.test.ts checks drift.
/** Public About contract. No wallet sets, actor accounts or personalized capabilities. */
export type AboutToken = { chain: "solana" | "hood"; address: string }
export type AboutSection = "thesis" | "tokenomics" | "lore"
export type AboutFeatures = {
  read: boolean
  edit: boolean
  flags: boolean
  updates: boolean
  comments: boolean
  hoodHolderEdit: boolean
}
export type SupplyFact = {
  metric: string
  status: "known" | "stale" | "unsupported" | "unavailable"
  raw?: string
  denominatorRaw?: string
  decimals?: number
  unit: "token" | "ratio" | "lp"
  measuredAt: string | null
  source: string
  evidence: string[]
  coverage: "complete" | "lower_bound" | "unknown"
  block?: string
}
/**
 * Public identity of an author. Published agents carry their public name; a private agent is the
 * neutral `agent` form and never names the member behind it.
 */
export type PublicIdentity =
  | { kind: "candle"; name: "Candle" }
  | { kind: "account"; name: string | null; account: string }
  | { kind: "agent"; name: string | null }
export type AboutSectionVersion = {
  id: string
  section: AboutSection
  revision: string
  text: string
  author: PublicIdentity
  /** The author held a verified creator wallet when this was written (a proven creator label). */
  dev: boolean
  /** Included share of total supply at the time of writing, in basis points; null for Candle rows. */
  shareBps: string | null
  source: "candle_seed" | "editor"
  createdAt: string
  /** Links not yet cleared by the link policy are replaced in `text` by a placeholder. */
  linksWithheld: boolean
  /** A newer version exists that is hidden pending review; this one is the latest safe predecessor. */
  newerAwaitingReview: boolean
}
export type AboutCapabilities = {
  canClaim: boolean
  canEdit: boolean
  canFlag: boolean
  creatorProven: boolean
  shareBps: string | null
  observedAt: string | null
  refusal: string | null
}
export type AboutHistoryItem = {
  kind: "version"
  id: string
  revision: string
  text: string | null
  author: PublicIdentity
  dev: boolean
  shareBps: string | null
  source: "candle_seed" | "editor"
  createdAt: string
  restoredFrom: string | null
  /** Set when the body is hidden or removed; the body is then null and never recoverable here. */
  tombstone: "hidden" | "removed" | null
}
export type AboutHistory = {
  token: AboutToken
  section: AboutSection
  items: AboutHistoryItem[]
  nextCursor: string | null
}
export type CreatorChallenge = { challengeId: string; message: string; expiresAt: string }
export type ClaimResult = {
  state: "claimed"
  kind: "creator" | "holder"
  creatorProven: boolean
  revision: string
}
export type FlagReason = "spam" | "scam" | "abuse" | "misleading" | "unsafe_link" | "other"
export type FlagResult = { contentId: string; flagged: true; hidden: boolean }
export type TokenAbout = {
  token: AboutToken
  revision: string
  claim: {
    state: "unclaimed" | "dev" | "community"
    lead: PublicIdentity | null
    eligibleAccounts: number | null
    measuredAt: string | null
  }
  sections: Partial<Record<AboutSection, AboutSectionVersion>>
  facts: SupplyFact[]
  latestVisibleUpdate: string | null
  features: AboutFeatures
}
export type AboutBurnHistory = {
  token: AboutToken
  subtotal: SupplyFact
  items: { signature: string; amountRaw: string; completedAt: string | null; explorerUrl: string }[]
  nextCursor: string | null
}

export type AboutPost = {
  id: string
  sequence: string
  text: string | null
  author: PublicIdentity
  dev: boolean
  shareBps: string | null
  source: "editor" | "candle_seed"
  createdAt: string
  tombstone: "hidden" | "removed" | null
  linksWithheld: boolean
}
export type AboutUpdates = { token: AboutToken; items: AboutPost[]; nextCursor: string | null }
export type AboutSeen = { sequence: string; latestVisibleUpdate: string | null; unread: boolean }
