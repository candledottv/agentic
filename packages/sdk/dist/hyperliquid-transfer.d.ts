/** BE-3765: local trust anchors and plaintext/type/action equality before signing a same-wallet move.
 * Copied byte for byte to SDK and MCP; never trust an exchange URL or token supplied by a build.
 */
export interface OwnTransferBuild {
    id: string;
    status: string;
    mode: "toDex" | "fromDex" | "toSpot" | "fromSpot";
    dex?: string;
    nonce?: number;
    typedData?: {
        domain: Record<string, unknown>;
        types: Record<string, unknown>;
        primary_type: string;
        message: Record<string, unknown>;
    };
    action?: Record<string, unknown>;
}
export declare function transferAmountMicros(value: unknown): bigint | null;
export declare function verifyOwnTransferBuild(build: OwnTransferBuild, expect: {
    id: string;
    account: string;
    mode: OwnTransferBuild["mode"];
    dex?: string;
    amountMicros: bigint | null;
}): string | null;
//# sourceMappingURL=hyperliquid-transfer.d.ts.map