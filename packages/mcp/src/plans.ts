/**
 * The served plan table (Plans v2, PL-ED-1 and PL-ED-14): its types and one way to render it.
 *
 * `GET /api/v1/agent/plans` (no credential) and the `planTable` field of `GET /api/v1/agent/tier`
 * return the table in force on the deployment that answered: each plan's price, agent fee, perps
 * builder fee, the limits a new key gets, and what the plan can do. A client quotes these numbers
 * rather than numbers it bundled, so it never shows a price or a fee the server is not charging.
 *
 * Dependency-free on purpose. The CLI and the MCP server carry byte-identical copies
 * (`plans.drift.test.ts` in each), and the repo's docs freshness gate renders the docs plan table
 * through this file, so the CLI, the MCP text and the docs say the same thing in the same words.
 * Copy any change verbatim: `cp packages/sdk/src/plans.ts packages/cli/src/plans.ts` and the same
 * for `packages/mcp/src/plans.ts`.
 */

/**
 * A plan name. `believer` is served only by a deployment that has not switched to the three plans
 * (Free, Pro, Max); it is accepted here for one release after that launch, then removed.
 */
export type PlanName = "free" | "pro" | "max" | "believer"

/** A sold plan's price, in the shape the tier response's `maxPricing` has always had. */
export interface PlanPrice {
  pricePerMonthUsd: number
  currency: string
  approval: string
}

/** What a freshly issued key on the plan gets. Enforcement never lowers a key set higher by hand. */
export interface PlanLimits {
  rateLimitPerMin: number
  dailyLaunchCap: number
  uploadsPerMin: number
  /** Linked wallets the account may have active at once. */
  linkedWallets: number
}

/** What a plan can do, one flag per gate the API enforces (PL-ED-14). */
export interface PlanCapabilities {
  /** Buy a token that was not launched on Candle and is not a base asset. */
  buyExternalTokens: boolean
  /** Sell such a token. True on every plan, so losing a plan never traps a position. */
  sellExternalTokens: boolean
  tradeBaseAssets: boolean
  tradeCandleTokens: boolean
  selfLaunch: boolean
  atomicLaunch: boolean
  createLinkedWallets: boolean
  importLinkedWallets: boolean
  /** Plan eligibility only: whether perps are open on the deployment is its own switch, and trading needs the wallet and scopes. */
  hyperliquidPerps: boolean
  limitOrders: boolean
  /** The quant bot on Telegram. */
  quant: boolean
  /** Base-pair swaps and base-asset bridges between the key's own wallets carry no Candle fee. A bridge also needs its own deployment switch. */
  freeBaseTransfers: boolean
}

export interface PlanTableEntry {
  plan: PlanName
  /**
   * Absent from a deployment that predates the capability table. A newer deployment may add a
   * capability this release does not name; `planTableRows` shows it under its own key.
   */
  capabilities?: PlanCapabilities
  /** The agent platform fee this deployment charges, in basis points, overrides included. */
  feeBps: number
  /** The Hyperliquid perps builder fee, in basis points. */
  perpFeeBps: number
  /** Null when the plan is not sold: Free, Believer, and Pro before the three-plan launch. */
  price: PlanPrice | null
  limits: PlanLimits
}

export interface PlanTable {
  plans: PlanTableEntry[]
  /** Days of Max a first Pro purchase grants. 0 when there is no promotion. */
  promoMaxDays: number
}

/** `GET /api/v1/agent/plans`. */
export interface AgentPlansResult extends PlanTable {
  success: true
}

/**
 * What a capability "yes" means. It is the plan's eligibility, not a statement that the deployment has
 * the feature switched on, so perps and own-wallet bridges say "when enabled" in their labels.
 */
export const PLAN_CAPABILITY_NOTE =
  "A capability marked yes is what the plan allows. It is subject to the deployment's own switches (perps and own-wallet bridges each have one) and to the wallet, scopes and setup the feature needs. Every plan can launch a token from its embedded wallet, with an optional dev buy (same transaction on Solana; best-effort follow-up on Hood), through the headless launch; the two launch rows are additional routes, not the only ones."

/** The row label for each capability, in the order the rows are shown. */
export const PLAN_CAPABILITY_LABELS: Record<keyof PlanCapabilities, string> = {
  tradeCandleTokens: "Trade Candle-launched tokens",
  tradeBaseAssets: "Trade base assets",
  freeBaseTransfers: "Base-pair swaps and own-wallet bridges (when enabled), no Candle fee",
  sellExternalTokens: "Sell tokens not launched on Candle",
  buyExternalTokens: "Buy tokens not launched on Candle",
  hyperliquidPerps: "Hyperliquid perps (when enabled)",
  selfLaunch: "Launch from a linked or TEE wallet (self-signed)",
  atomicLaunch: "Atomic launch: launch + 1–4 first buys in one bundle",
  createLinkedWallets: "Create linked wallets",
  importLinkedWallets: "Import linked wallets",
  limitOrders: "Limit orders",
  quant: "Quant on Telegram",
}

const PLAN_LABELS: Record<PlanName, string> = { free: "Free", believer: "Believer", pro: "Pro", max: "Max" }

/** "Free", "Pro", "Max", "Believer"; an unknown name as served. */
export function planLabel(plan: string): string {
  return Object.hasOwn(PLAN_LABELS, plan) ? PLAN_LABELS[plan as PlanName] : plan
}

/** Basis points as a percentage: 100 is "1%", 25 is "0.25%", 0 is "none". */
export function formatPlanBps(bps: number): string {
  return bps === 0 ? "none" : `${Number((bps / 100).toFixed(4))}%`
}

function count(n: number): string {
  return n.toLocaleString("en-US")
}

function priceCell(entry: PlanTableEntry): string {
  if (entry.price) return `$${count(entry.price.pricePerMonthUsd)} a month`
  return entry.plan === "free" ? "free" : "not sold"
}

/**
 * The table as rows of text cells: a header row of plan names, then price, fees, limits and one
 * row per capability. The CLI prints it as a terminal table and the docs as a Markdown table.
 * Capabilities this release does not name are appended under their own key, so a newer server's
 * additions are shown rather than dropped.
 */
export function planTableRows(table: PlanTable): { headers: string[]; rows: string[][] } {
  const plans = table.plans
  const row = (label: string, cell: (entry: PlanTableEntry) => string) => [label, ...plans.map(cell)]
  const rows: string[][] = [
    row("Price", priceCell),
    row("Agent trade fee", (e) => formatPlanBps(e.feeBps)),
    row("Perps builder fee", (e) => formatPlanBps(e.perpFeeBps)),
    row("Requests per minute", (e) => count(e.limits.rateLimitPerMin)),
    row("Launches per day", (e) => count(e.limits.dailyLaunchCap)),
    row("Uploads per minute", (e) => count(e.limits.uploadsPerMin)),
    row("Linked wallets", (e) => count(e.limits.linkedWallets)),
  ]
  const known = Object.keys(PLAN_CAPABILITY_LABELS) as Array<keyof PlanCapabilities>
  const served = new Set<string>()
  for (const entry of plans) for (const key of Object.keys(entry.capabilities ?? {})) served.add(key)
  const keys: string[] = [
    ...known.filter((k) => served.has(k)),
    ...[...served].filter((k) => !Object.hasOwn(PLAN_CAPABILITY_LABELS, k)),
  ]
  for (const key of keys) {
    const label = Object.hasOwn(PLAN_CAPABILITY_LABELS, key)
      ? PLAN_CAPABILITY_LABELS[key as keyof PlanCapabilities]
      : key
    rows.push(
      row(label, (e) => {
        const value = (e.capabilities as Record<string, unknown> | undefined)?.[key]
        return value === true ? "yes" : value === false ? "no" : "-"
      }),
    )
  }
  return { headers: ["", ...plans.map((e) => planLabel(e.plan))], rows }
}

/** The promotion as a sentence, or null when there is none. */
export function planPromotionLine(table: PlanTable): string | null {
  if (!(table.promoMaxDays > 0)) return null
  const days = table.promoMaxDays === 1 ? "1 day" : `${table.promoMaxDays} days`
  return `A first Pro purchase includes Max for its first ${days}, then continues on Pro.`
}

/** The table as Markdown: what the MCP tool returns beside the JSON, and what the docs embed. */
export function planTableMarkdown(table: PlanTable): string {
  const { headers, rows } = planTableRows(table)
  const line = (cells: string[]) => `| ${cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n")
}
