/**
 * What needs an approval card (BE-1665, spec K-1), per MCP tool, and the id field each card's
 * operation id rides in (K-2).
 *
 * Every name in `packages/mcp/src/tools.ts`'s `TOOL_NAMES` is classified here. `classify.drift.test.ts`
 * (T-1) keeps the two equal, so a new MCP tool fails CI until someone decides what it is. At run
 * time, a name this table does not know is refused with `TOOL_NOT_CLASSIFIED`: a new tool is never
 * silently treated as a read.
 *
 * No card: every read, every paper trade (`candle_trade` with `paper: true`), every launch dry run
 * (`dryRun: true` on the two launch tools). Those are decided by {@link classifyCall} from the
 * arguments, never from the proposer's say-so.
 */

export type CardKind = "trade" | "swap" | "launch" | "stake" | "claim" | "perps" | "profile" | "keyaccess" | "transfer"

/** The id field a tool already has, or `coreOpId` for a tool with none (the core keeps the id). */
export type IdKey =
  | "clientTradeId"
  | "clientSwapId"
  | "clientLaunchId"
  | "clientStakeId"
  | "rewardId"
  | "clientId"
  | "clientDepositId"
  | "coreOpId"

export type ToolClass = { class: "read" } | { class: "card"; kind: CardKind; idKey: IdKey }

const READ: ToolClass = { class: "read" }
const card = (kind: CardKind, idKey: IdKey = "coreOpId"): ToolClass => ({ class: "card", kind, idKey })

export const TOOL_CLASSES: Readonly<Record<string, ToolClass>> = {
  // Reads.
  candle_get_market: READ,
  candle_get_feed: READ,
  candle_vamp_candidates: READ,
  candle_token_forensics: READ,
  candle_get_agent_profile: READ,
  candle_list_agents: READ,
  candle_list_agent_posts: READ,
  candle_get_plans: READ,
  candle_get_wallets: READ,
  candle_get_profile_wallets: READ,
  candle_get_profile_pnl: READ,
  candle_get_profile_trades: READ,
  candle_get_portfolio: READ,
  candle_resolve_token: READ,
  candle_execution_status: READ,
  candle_get_operation: READ,
  candle_get_fees: READ,
  candle_get_staking: READ,
  candle_perps_markets: READ,
  candle_perps_market: READ,
  candle_perps_book: READ,
  candle_perps_candles: READ,
  candle_perps_orders: READ,
  candle_perps_positions: READ,
  candle_perps_fills: READ,
  candle_perps_funding: READ,
  candle_perps_account: READ,
  candle_perps_risk: READ,
  candle_perps_thresholds: READ,
  // Money writes (K-1).
  candle_trade: card("trade", "clientTradeId"),
  candle_swap: card("swap", "clientSwapId"),
  candle_launch_token: card("launch", "clientLaunchId"),
  candle_launch_and_seed: card("launch", "clientLaunchId"),
  candle_stake: card("stake", "clientStakeId"),
  candle_unstake: card("stake", "clientStakeId"),
  candle_finish_unstake: card("stake", "clientStakeId"),
  candle_claim_fees: card("claim"),
  // `rewardId` names the server's reward, so it is the operation's id as given, never minted (V-5).
  candle_claim_staking_reward: card("claim", "rewardId"),
  candle_perps_setup: card("perps"),
  candle_perps_open: card("perps", "clientId"),
  candle_perps_close: card("perps", "clientId"),
  candle_perps_cancel: card("perps"),
  candle_perps_leverage: card("perps"),
  candle_perps_modify: card("perps"),
  candle_perps_margin: card("perps"),
  candle_perps_tpsl: card("perps"),
  candle_perps_schedule_cancel: card("perps"),
  candle_perps_flatten: card("perps"),
  candle_perps_reduce_only: card("perps"),
  candle_perps_deposit: card("perps", "clientDepositId"),
  candle_perps_set_thresholds: card("perps"),
  // Public writes under the user's agent: a card, no factor (D4 default A).
  candle_update_profile: card("profile"),
  candle_create_post: card("profile"),
  candle_delete_post: card("profile"),
  candle_report_activity: card("profile"),
  // Changes which wallets the key may spend from: a card with a factor, never a timed window.
  candle_set_profile_wallets: card("keyaccess"),
  // User-started only (K-3).
  candle_transfer: card("transfer"),
  candle_sweep: card("transfer"),
}

/** Kinds whose approval needs the vault factor (K-1's Factor column). */
export const FACTOR_KINDS: ReadonlySet<CardKind> = new Set([
  "trade",
  "swap",
  "launch",
  "stake",
  "claim",
  "perps",
  "keyaccess",
  "transfer",
])

/** Kinds a timed window (K-6) never approves: each needs a fresh factor. */
export const FRESH_FACTOR_KINDS: ReadonlySet<CardKind> = new Set(["transfer", "launch", "keyaccess"])

/** K-8: a quote goes stale in a minute; everything else waits ten. */
export function cardLifetimeMs(kind: CardKind): number {
  return kind === "trade" || kind === "swap" || kind === "perps" ? 60_000 : 10 * 60_000
}

export type CallClass =
  | { class: "read" }
  | { class: "paper" }
  | { class: "dry_run" }
  | { class: "card"; kind: CardKind; idKey: IdKey }
  | { class: "unclassified" }

/** How one call of `tool` with `args` is treated. */
export function classifyCall(tool: string, args: Record<string, unknown>): CallClass {
  const known = Object.hasOwn(TOOL_CLASSES, tool) ? TOOL_CLASSES[tool] : undefined
  if (known === undefined) return { class: "unclassified" }
  if (known.class === "read") return { class: "read" }
  if (tool === "candle_trade" && args.paper === true) return { class: "paper" }
  if ((tool === "candle_launch_token" || tool === "candle_launch_and_seed") && args.dryRun === true) {
    return { class: "dry_run" }
  }
  return known
}
