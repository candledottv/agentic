import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import type { RequestConfig } from "./client"
import type { FetchLike } from "./orchestrate"
import { noteVersionHeaders } from "./update-notice"

const token = { chain: z.enum(["solana", "hood"]), address: z.string().min(1) }
const section = z.enum(["thesis", "tokenomics", "lore"])
const pagination = { cursor: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }
const revision = z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
const write = {
  idempotencyKey: z.string().min(1).max(128).describe("Persist one key and body before sending; reuse both on retry"),
}
export const tokenPageShapes = {
  candle_token_page_about: token,
  candle_token_page_capabilities: token,
  candle_token_page_burns: { ...token, ...pagination },
  candle_token_page_history: { ...token, section, ...pagination },
  candle_token_page_creator_challenge: token,
  candle_token_page_claim: {
    ...token,
    ...write,
    kind: z.enum(["holder", "creator"]),
    challengeId: z.string().uuid().optional(),
    signature: z.string().max(400).optional(),
  },
  candle_token_page_section_set: { ...token, ...write, section, text: z.string(), baseRevision: revision },
  candle_token_page_section_restore: {
    ...token,
    ...write,
    section,
    versionId: z.string().uuid(),
    baseRevision: revision,
  },
  candle_token_page_flag: {
    ...token,
    ...write,
    contentId: z.string().uuid(),
    reason: z.enum(["spam", "scam", "abuse", "misleading", "unsafe_link", "other"]),
    detail: z.string().max(500).optional(),
  },
}
export type TokenPageToolName = keyof typeof tokenPageShapes
export function isTokenPageTool(name: string): name is TokenPageToolName {
  return Object.hasOwn(tokenPageShapes, name)
}

/** Only route parameters and client options are removed; the strict schemas own the wire DTO. */
export function buildTokenPageRequest(name: TokenPageToolName, args: Record<string, unknown>, cfg: RequestConfig) {
  const { chain, address, section: sectionName, cursor, limit, idempotencyKey, ...body } = args
  const publicRead =
    name === "candle_token_page_about" || name === "candle_token_page_burns" || name === "candle_token_page_history"
  if (!publicRead && !cfg.apiKey)
    throw new Error("CANDLE_AGENT_API_KEY with token-pages scopes is required for this tool.")
  const suffix: Record<TokenPageToolName, string> = {
    candle_token_page_about: "",
    candle_token_page_capabilities: "/capabilities",
    candle_token_page_burns: "/burns",
    candle_token_page_history: `/sections/${encodeURIComponent(String(sectionName))}/history`,
    candle_token_page_creator_challenge: "/creator-challenges",
    candle_token_page_claim: "/claims",
    candle_token_page_section_set: `/sections/${encodeURIComponent(String(sectionName))}`,
    candle_token_page_section_restore: `/sections/${encodeURIComponent(String(sectionName))}/restore`,
    candle_token_page_flag: "/flags",
  }
  const read = publicRead || name === "candle_token_page_capabilities"
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (!publicRead && cfg.apiKey) headers["x-api-key"] = cfg.apiKey
  if (idempotencyKey !== undefined) headers["Idempotency-Key"] = String(idempotencyKey)
  const query = new URLSearchParams()
  if (cursor !== undefined) query.set("cursor", String(cursor))
  if (limit !== undefined) query.set("limit", String(limit))
  return {
    url: `${cfg.apiUrl.replace(/\/$/, "")}/api/v1/token-pages/${encodeURIComponent(String(chain))}/${encodeURIComponent(String(address))}${suffix[name]}${query.size ? `?${query}` : ""}`,
    init: {
      method: read ? "GET" : name === "candle_token_page_section_set" ? "PUT" : "POST",
      headers,
      cache: "no-store",
      ...(read ? {} : { body: JSON.stringify(body) }),
    } satisfies RequestInit,
  }
}

/** Relay the API DTO unchanged; transport context is a separate block, never content or credentials. */
export async function tokenPageRelay(
  name: TokenPageToolName,
  args: Record<string, unknown>,
  cfg: RequestConfig,
  doFetch: FetchLike,
): Promise<CallToolResult> {
  let request: ReturnType<typeof buildTokenPageRequest>
  try {
    request = buildTokenPageRequest(name, args, cfg)
  } catch {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ success: false, error: "API_KEY_REQUIRED" }) }],
    }
  }
  const key = typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined
  const attempts = key ? 2 : 1
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response: Awaited<ReturnType<FetchLike>>
    let text: string
    try {
      response = await doFetch(request.url, request.init)
      text = await response.text()
    } catch {
      if (attempt + 1 < attempts) continue
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: key ? "OUTCOME_UNKNOWN" : "NETWORK_ERROR",
              ...(key ? { idempotencyKey: key } : {}),
            }),
          },
        ],
      }
    }
    noteVersionHeaders(response)
    if (response.ok) {
      let valid = false
      try {
        const envelope = JSON.parse(text)
        valid = envelope?.success === true && typeof envelope === "object" && "data" in envelope
      } catch {
        /* A malformed success may still have committed. */
      }
      if (!valid)
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: key ? "OUTCOME_UNKNOWN" : "BAD_RESPONSE",
                status: response.status,
                ...(key ? { idempotencyKey: key } : {}),
              }),
            },
          ],
        }
    }
    const retryAfter =
      (response as { headers?: { get(name: string): string | null } }).headers?.get("retry-after") ?? null
    return {
      ...(response.ok ? {} : { isError: true }),
      content: [
        { type: "text", text },
        {
          type: "text",
          text: JSON.stringify({ status: response.status, retryAfter, ...(key ? { idempotencyKey: key } : {}) }),
        },
      ],
    }
  }
  throw new Error("Unreachable")
}
