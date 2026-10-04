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
export type PlanName = "free" | "pro" | "max" | "believer";
/** A sold plan's price, in the shape the tier response's `maxPricing` has always had. */
export interface PlanPrice {
    pricePerMonthUsd: number;
    currency: string;
    approval: string;
}
/** What a freshly issued key on the plan gets. Enforcement never lowers a key set higher by hand. */
export interface PlanLimits {
    rateLimitPerMin: number;
    dailyLaunchCap: number;
    uploadsPerMin: number;
    /** Linked wallets the account may have active at once. */
    linkedWallets: number;
}
/** What a plan can do, one flag per gate the API enforces (PL-ED-14). */
export interface PlanCapabilities {
    /** Buy a token that was not launched on Candle and is not a base asset. */
    buyExternalTokens: boolean;
    /** Sell such a token. True on every plan, so losing a plan never traps a position. */
    sellExternalTokens: boolean;
    tradeBaseAssets: boolean;
    tradeCandleTokens: boolean;
    selfLaunch: boolean;
    atomicLaunch: boolean;
    createLinkedWallets: boolean;
    importLinkedWallets: boolean;
    /** Plan eligibility only: whether perps are open on the deployment is its own switch, and trading needs the wallet and scopes. */
    hyperliquidPerps: boolean;
    limitOrders: boolean;
    /** The quant bot on Telegram. */
    quant: boolean;
    /** Base-pair swaps and base-asset bridges between the key's own wallets carry no Candle fee. A bridge also needs its own deployment switch. */
    freeBaseTransfers: boolean;
}
export interface PlanTableEntry {
    plan: PlanName;
    /**
     * Absent from a deployment that predates the capability table. A newer deployment may add a
     * capability this release does not name; `planTableRows` shows it under its own key.
     */
    capabilities?: PlanCapabilities;
    /** The agent platform fee this deployment charges, in basis points, overrides included. */
    feeBps: number;
    /** The Hyperliquid perps builder fee, in basis points. */
    perpFeeBps: number;
    /** Null when the plan is not sold: Free, Believer, and Pro before the three-plan launch. */
    price: PlanPrice | null;
    limits: PlanLimits;
}
export interface PlanTable {
    plans: PlanTableEntry[];
    /** Days of Max a first Pro purchase grants. 0 when there is no promotion. */
    promoMaxDays: number;
}
/** `GET /api/v1/agent/plans`. */
export interface AgentPlansResult extends PlanTable {
    success: true;
}
/**
 * What a capability "yes" means. It is the plan's eligibility, not a statement that the deployment has
 * the feature switched on, so perps and own-wallet bridges say "when enabled" in their labels.
 */
export declare const PLAN_CAPABILITY_NOTE = "A capability marked yes is what the plan allows. It is subject to the deployment's own switches (perps and own-wallet bridges each have one) and to the wallet, scopes and setup the feature needs. Every plan can launch a token from its embedded wallet, with an optional dev buy (same transaction on Solana; best-effort follow-up on Hood), through the headless launch; the two launch rows are additional routes, not the only ones.";
/** The row label for each capability, in the order the rows are shown. */
export declare const PLAN_CAPABILITY_LABELS: Record<keyof PlanCapabilities, string>;
/** "Free", "Pro", "Max", "Believer"; an unknown name as served. */
export declare function planLabel(plan: string): string;
/** Basis points as a percentage: 100 is "1%", 25 is "0.25%", 0 is "none". */
export declare function formatPlanBps(bps: number): string;
/**
 * The table as rows of text cells: a header row of plan names, then price, fees, limits and one
 * row per capability. The CLI prints it as a terminal table and the docs as a Markdown table.
 * Capabilities this release does not name are appended under their own key, so a newer server's
 * additions are shown rather than dropped.
 */
export declare function planTableRows(table: PlanTable): {
    headers: string[];
    rows: string[][];
};
/** The promotion as a sentence, or null when there is none. */
export declare function planPromotionLine(table: PlanTable): string | null;
/** The table as Markdown: what the MCP tool returns beside the JSON, and what the docs embed. */
export declare function planTableMarkdown(table: PlanTable): string;
//# sourceMappingURL=plans.d.ts.map