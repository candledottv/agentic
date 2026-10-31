import { CandleApiError, candleApiErrorFromResponse } from "./errors"
import type {
  AboutBurnHistory,
  AboutCapabilities,
  AboutHistory,
  AboutSection,
  AboutSeen,
  AboutToken,
  AboutUpdates,
  ClaimResult,
  CreatorChallenge,
  FlagReason,
  FlagResult,
  TokenAbout,
} from "./token-pages.types"

export type TokenPageClaim = { kind: "holder" | "creator"; challengeId?: string; signature?: string }
export type TokenPageSectionEdit = { text: string; baseRevision: string }
export type TokenPageRestore = { versionId: string; baseRevision: string }
export type TokenPageFlag = { contentId: string; reason: FlagReason; detail?: string }
export type TokenPagePagination = { cursor?: string; limit?: number }
export type TokenPageWriteOptions = { idempotencyKey?: string }
export type TokenPageWritten = { id: string; revision: string }
export type TokenPageWriteResult<T> = { data: T; idempotencyKey: string }

/** A refusal retains its code/status; an unanswered write retains its key for explicit replay. */
export class TokenPageError extends CandleApiError {
  readonly idempotencyKey?: string
  readonly latest?: { revision: string; versionId: string | null }
  readonly retryAfterHeader: string | null

  constructor(
    error: CandleApiError,
    options: {
      idempotencyKey?: string
      latest?: { revision: string; versionId: string | null }
      retryAfterHeader?: string | null
    } = {},
  ) {
    super(error)
    this.name = "TokenPageError"
    this.idempotencyKey = options.idempotencyKey
    this.latest = options.latest
    this.retryAfterHeader = options.retryAfterHeader ?? null
  }
}

/** The API remains the authoritative validator, including strict bodies and fresh eligibility. */
export interface CandleTokenPages {
  updates(token: AboutToken, options?: TokenPagePagination): Promise<AboutUpdates>
  postUpdate(
    token: AboutToken,
    body: { text: string },
    options?: TokenPageWriteOptions,
  ): Promise<TokenPageWriteResult<{ id: string; sequence: string }>>
  deletePost(
    token: AboutToken,
    id: string,
    options?: TokenPageWriteOptions,
  ): Promise<TokenPageWriteResult<{ id: string; deleted: true }>>
  seen(token: AboutToken): Promise<AboutSeen>
  markSeen(
    token: AboutToken,
    visibleUpdateSequence: string,
    options?: TokenPageWriteOptions,
  ): Promise<TokenPageWriteResult<AboutSeen>>
  about(token: AboutToken): Promise<TokenAbout>
  capabilities(token: AboutToken): Promise<AboutCapabilities>
  burns(token: AboutToken, options?: TokenPagePagination): Promise<AboutBurnHistory>
  history(token: AboutToken, section: AboutSection, options?: TokenPagePagination): Promise<AboutHistory>
  /** One fresh message-only challenge. Sign its exact UTF-8 bytes locally; this never signs. */
  creatorChallenge(token: AboutToken): Promise<CreatorChallenge>
  claim(
    token: AboutToken,
    body: TokenPageClaim,
    options?: TokenPageWriteOptions,
  ): Promise<TokenPageWriteResult<ClaimResult>>
  setSection(
    token: AboutToken,
    section: AboutSection,
    body: TokenPageSectionEdit,
    options?: TokenPageWriteOptions,
  ): Promise<TokenPageWriteResult<TokenPageWritten>>
  restoreSection(
    token: AboutToken,
    section: AboutSection,
    body: TokenPageRestore,
    options?: TokenPageWriteOptions,
  ): Promise<TokenPageWriteResult<TokenPageWritten>>
  flag(
    token: AboutToken,
    body: TokenPageFlag,
    options?: TokenPageWriteOptions,
  ): Promise<TokenPageWriteResult<FlagResult>>
}

/** @internal CandleClient supplies its guarded transport and SDK headers. */
export function createTokenPagesClient(io: {
  fetch: (input: string, init: RequestInit) => Promise<Response>
  apiUrl(): string
  headers(authenticated: boolean): Record<string, string>
}): CandleTokenPages {
  function path(token: AboutToken, suffix = "") {
    return `/api/v1/token-pages/${encodeURIComponent(token.chain)}/${encodeURIComponent(token.address)}${suffix}`
  }
  function query(options: TokenPagePagination = {}) {
    const params = new URLSearchParams()
    if (options.limit !== undefined) params.set("limit", String(options.limit))
    if (options.cursor !== undefined) params.set("cursor", options.cursor)
    return params.size ? `?${params}` : ""
  }
  async function request<T>(
    method: string,
    url: string,
    authenticated: boolean,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const headers = io.headers(authenticated)
    if (body !== undefined) headers["content-type"] = "application/json"
    if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey
    // Serialize once: even a caller changing its draft during a retry cannot change the wire body.
    const init: RequestInit = {
      method,
      headers,
      redirect: "error",
      cache: "no-store",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }
    const attempts = idempotencyKey === undefined ? 1 : 2
    for (let attempt = 0; attempt < attempts; attempt++) {
      let response: Response
      let text: string
      try {
        response = await io.fetch(`${io.apiUrl()}${url}`, init)
        text = await response.text()
      } catch {
        if (attempt + 1 < attempts) continue
        throw new TokenPageError(
          new CandleApiError({
            code: idempotencyKey ? "OUTCOME_UNKNOWN" : "NETWORK_ERROR",
            status: 0,
            message: idempotencyKey
              ? "No complete answer; replay the same body with this idempotency key."
              : "No complete answer from Candle.",
            retryable: true,
          }),
          { idempotencyKey },
        )
      }
      if (!response.ok) {
        let refusal: { success?: unknown; error?: unknown; latest?: { revision: string; versionId: string | null } } =
          {}
        try {
          refusal = JSON.parse(text)
        } catch {
          /* Proxy or old API response. */
        }
        const error =
          refusal?.success === false && typeof refusal.error === "string"
            ? new CandleApiError({
                code: refusal.error,
                message: `Token page request refused (${refusal.error}).`,
                status: response.status,
                retryable: false,
              })
            : candleApiErrorFromResponse(response.status, text)
        throw new TokenPageError(error, {
          idempotencyKey,
          latest: refusal?.latest,
          retryAfterHeader: response.headers.get("retry-after"),
        })
      }
      try {
        const envelope = JSON.parse(text)
        if (envelope?.success !== true || !("data" in envelope)) throw new Error()
        return envelope.data as T
      } catch {
        // A malformed success may still have committed. Never generate a replacement write.
        throw new TokenPageError(
          new CandleApiError({
            code: idempotencyKey ? "OUTCOME_UNKNOWN" : "BAD_RESPONSE",
            message: "Candle returned an invalid response.",
            status: response.status,
            retryable: false,
          }),
          { idempotencyKey },
        )
      }
    }
    throw new Error("Unreachable")
  }
  async function write<T>(
    method: string,
    url: string,
    body: unknown,
    options: TokenPageWriteOptions = {},
  ): Promise<TokenPageWriteResult<T>> {
    const idempotencyKey = options.idempotencyKey ?? crypto.randomUUID()
    if (!idempotencyKey.length || idempotencyKey.length > 128)
      throw new Error("idempotencyKey must be 1 to 128 characters")
    return { data: await request<T>(method, url, true, body, idempotencyKey), idempotencyKey }
  }
  const sectionPath = (section: AboutSection) => `/sections/${encodeURIComponent(section)}`
  return {
    updates: (token, options) => request("GET", path(token, `/updates${query(options)}`), false),
    postUpdate: (token, body, options) => write("POST", path(token, "/updates"), body, options),
    deletePost: (token, id, options) => write("DELETE", path(token, `/posts/${encodeURIComponent(id)}`), {}, options),
    seen: (token) => request("GET", path(token, "/seen"), true),
    markSeen: (token, visibleUpdateSequence, options) =>
      write("POST", path(token, "/seen"), { visibleUpdateSequence }, options),
    about: (token) => request("GET", path(token), false),
    capabilities: (token) => request("GET", path(token, "/capabilities"), true),
    burns: (token, options) => request("GET", path(token, `/burns${query(options)}`), false),
    history: (token, section, options) =>
      request("GET", path(token, `${sectionPath(section)}/history${query(options)}`), false),
    creatorChallenge: (token) => request("POST", path(token, "/creator-challenges"), true, {}),
    claim: (token, body, options) => write("POST", path(token, "/claims"), body, options),
    setSection: (token, section, body, options) => write("PUT", path(token, sectionPath(section)), body, options),
    restoreSection: (token, section, body, options) =>
      write("POST", path(token, `${sectionPath(section)}/restore`), body, options),
    flag: (token, body, options) => write("POST", path(token, "/flags"), body, options),
  }
}
