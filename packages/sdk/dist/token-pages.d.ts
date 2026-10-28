import { CandleApiError } from "./errors";
import type { AboutBurnHistory, AboutCapabilities, AboutHistory, AboutSection, AboutToken, ClaimResult, CreatorChallenge, FlagReason, FlagResult, TokenAbout } from "./token-pages.types";
export type TokenPageClaim = {
    kind: "holder" | "creator";
    challengeId?: string;
    signature?: string;
};
export type TokenPageSectionEdit = {
    text: string;
    baseRevision: string;
};
export type TokenPageRestore = {
    versionId: string;
    baseRevision: string;
};
export type TokenPageFlag = {
    contentId: string;
    reason: FlagReason;
    detail?: string;
};
export type TokenPagePagination = {
    cursor?: string;
    limit?: number;
};
export type TokenPageWriteOptions = {
    idempotencyKey?: string;
};
export type TokenPageWritten = {
    id: string;
    revision: string;
};
export type TokenPageWriteResult<T> = {
    data: T;
    idempotencyKey: string;
};
/** A refusal retains its code/status; an unanswered write retains its key for explicit replay. */
export declare class TokenPageError extends CandleApiError {
    readonly idempotencyKey?: string;
    readonly latest?: {
        revision: string;
        versionId: string | null;
    };
    readonly retryAfterHeader: string | null;
    constructor(error: CandleApiError, options?: {
        idempotencyKey?: string;
        latest?: {
            revision: string;
            versionId: string | null;
        };
        retryAfterHeader?: string | null;
    });
}
/** The API remains the authoritative validator, including strict bodies and fresh eligibility. */
export interface CandleTokenPages {
    about(token: AboutToken): Promise<TokenAbout>;
    capabilities(token: AboutToken): Promise<AboutCapabilities>;
    burns(token: AboutToken, options?: TokenPagePagination): Promise<AboutBurnHistory>;
    history(token: AboutToken, section: AboutSection, options?: TokenPagePagination): Promise<AboutHistory>;
    /** One fresh message-only challenge. Sign its exact UTF-8 bytes locally; this never signs. */
    creatorChallenge(token: AboutToken): Promise<CreatorChallenge>;
    claim(token: AboutToken, body: TokenPageClaim, options?: TokenPageWriteOptions): Promise<TokenPageWriteResult<ClaimResult>>;
    setSection(token: AboutToken, section: AboutSection, body: TokenPageSectionEdit, options?: TokenPageWriteOptions): Promise<TokenPageWriteResult<TokenPageWritten>>;
    restoreSection(token: AboutToken, section: AboutSection, body: TokenPageRestore, options?: TokenPageWriteOptions): Promise<TokenPageWriteResult<TokenPageWritten>>;
    flag(token: AboutToken, body: TokenPageFlag, options?: TokenPageWriteOptions): Promise<TokenPageWriteResult<FlagResult>>;
}
/** @internal CandleClient supplies its guarded transport and SDK headers. */
export declare function createTokenPagesClient(io: {
    fetch: (input: string, init: RequestInit) => Promise<Response>;
    apiUrl(): string;
    headers(authenticated: boolean): Record<string, string>;
}): CandleTokenPages;
//# sourceMappingURL=token-pages.d.ts.map