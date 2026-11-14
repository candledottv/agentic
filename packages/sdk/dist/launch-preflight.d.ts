export interface LaunchCheckRequest {
    check: true;
    quote?: string;
    chain?: "solana" | "hood";
    mode?: "open" | "exclusive";
    stakerAllocationBps?: number;
    dexVersion?: "v3" | "v4";
    /** Omitted checks all available paths, as CLI --check does. */
    wallet?: string;
    dryRun?: false;
    quoteAsset?: string;
}
export interface LaunchQuoteCheck {
    requested: string;
    ok: boolean;
    chain?: "solana" | "hood";
    address?: string;
    symbol?: string;
    decimals?: number;
    classification?: "ordinary" | "featured" | "trusted" | "stock";
    checks: {
        check: string;
        status: "pass" | "skip" | "refuse";
        code?: string;
        message: string;
    }[];
    economics?: {
        kind: "fixed" | "derived";
        economicsDigest: string;
        thresholdRaw: string;
        startFdv: number;
        bondingFdv: number;
        curve: Record<string, string>;
        priceUsd?: number;
        raiseUsd?: number;
    };
    disclosure: string | null;
    executionEnabled: boolean;
}
export interface LaunchPreflight {
    success: true;
    key: {
        keyPrefix: string;
        scopes: string[];
        tier: string;
        selfLaunch: boolean;
        embeddedWalletPermission: "allowed" | "denied";
    };
    switches: {
        headlessLaunch: boolean;
        agentTrading: boolean;
        teeLaunchBuys: boolean;
    };
    embedded?: {
        solana?: {
            address: string;
            delegated?: boolean;
        } | null;
        evm?: {
            address: string;
            delegated?: boolean;
        } | null;
    };
    wallets: {
        id: string;
        address: string;
        chain: string;
        label: string | null;
        allowLaunch: boolean;
        active: boolean;
    }[];
    quote?: LaunchQuoteCheck;
}
export interface LaunchCheckResult extends LaunchPreflight {
    check: true;
    works: boolean;
    walletWorks: boolean;
}
export declare class LaunchCheckError extends Error {
    code: string;
    field?: string | undefined;
    constructor(code: string, message: string, field?: string | undefined);
}
/** Resolve only the existing fixed pairs. New quotes must never reach today's launch builders. */
export declare function fixedLaunchQuote(input: {
    quote?: string;
    quoteAsset?: string;
    chain?: string;
}): string | undefined;
/** Only selection fields go on this read. Never forward images, observations or receiver addresses. */
export declare function launchCheckPath(input: LaunchCheckRequest): string;
/** Match CLI's quote schema and bind the answer to the requested selection, including old servers. */
export declare function readLaunchCheck(value: unknown, input: LaunchCheckRequest): LaunchCheckResult;
//# sourceMappingURL=launch-preflight.d.ts.map