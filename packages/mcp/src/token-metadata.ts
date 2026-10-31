/**
 * BE-2140: `candle_token_edit` and `candle_token_history`, the MCP face of the creator metadata
 * edit (spec docs/superpowers/specs/2026-10-28-creator-metadata-edit-design.md, section 6, MCP).
 * The input is built from the generated launch definition copy: the same `description` and four
 * `socials` fields, with the same help, as the CLI's `candle token edit` and the SDK's
 * `editTokenMetadata()`. An unknown socials key is refused here, before any request.
 */
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { launchFieldHelp, SOCIAL_KEYS } from "./launch-schema"

/** Mirrors the API's edit-only caps (packages/shared launch-definition.ts, D3); the API is the authority. */
export const METADATA_EDIT_DESCRIPTION_MAX_CHARS = 500
export const METADATA_EDIT_URL_MAX_CHARS = 200

function editSocialsSchema() {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const key of SOCIAL_KEYS) {
    shape[key] = z
      .string()
      .nullable()
      .optional()
      .describe(`${launchFieldHelp(`socials.${key}`)} "" or null removes it.`)
  }
  // Passthrough keeps an unknown key so the handler refuses it with VALIDATION_FAILED, as the
  // launch tools do; strict() would fail inside the MCP SDK before that envelope exists.
  return z
    .object(shape)
    .passthrough()
    .optional()
    .describe(`Any of ${SOCIAL_KEYS.join(", ")}; a key left out keeps its link.`)
}

export const tokenEditShape = {
  chain: z.enum(["solana", "hood"]).describe('"solana" or "hood"'),
  mint: z.string().describe("Token mint (solana) or contract address (hood)"),
  description: z
    .string()
    .optional()
    .describe(
      `${launchFieldHelp("description")} At most ${METADATA_EDIT_DESCRIPTION_MAX_CHARS} characters; "" clears it.`,
    ),
  socials: editSocialsSchema(),
  idempotencyKey: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe("Reuse the same key and body to retry without editing twice; a fresh one is sent when absent"),
}

export const tokenHistoryShape = {
  chain: z.enum(["solana", "hood"]).describe('"solana" or "hood"'),
  mint: z.string().describe("Token mint (solana) or contract address (hood)"),
  cursor: z.string().optional().describe("nextCursor from an earlier page"),
  limit: z.number().int().min(1).max(50).optional().describe("How many edits, 1 to 50 (default 20)"),
}

export type EditRefusal = { code: "VALIDATION_FAILED"; message: string; field: string }

/** The PATCH body: only the fields given. Refuses an unknown socials key or a non-URL link locally. */
export function tokenEditBody(
  args: Record<string, unknown>,
): { body: Record<string, unknown> } | { refusal: EditRefusal } {
  const body: Record<string, unknown> = {}
  if (args.description !== undefined) body.description = args.description
  if (args.socials !== undefined) {
    const socials = args.socials
    if (!socials || typeof socials !== "object" || Array.isArray(socials)) {
      return {
        refusal: { code: "VALIDATION_FAILED", message: "socials must be an object of links.", field: "socials" },
      }
    }
    for (const [key, value] of Object.entries(socials)) {
      if (!SOCIAL_KEYS.includes(key)) {
        return {
          refusal: {
            code: "VALIDATION_FAILED",
            message: `socials accepts only ${SOCIAL_KEYS.join(", ")}.`,
            field: `socials.${key}`,
          },
        }
      }
      if (value === null || value === undefined || value === "") continue
      let ok = false
      try {
        ok = typeof value === "string" && ["http:", "https:"].includes(new URL(value.trim()).protocol)
      } catch {
        ok = false
      }
      if (!ok) {
        return {
          refusal: { code: "VALIDATION_FAILED", message: `${key} must be an http(s) URL.`, field: `socials.${key}` },
        }
      }
    }
    body.socials = socials
  }
  if (body.description === undefined && body.socials === undefined) {
    return { refusal: { code: "VALIDATION_FAILED", message: "Send description, socials, or both.", field: "body" } }
  }
  return { body }
}

export function tokenEditRequest(
  base: string,
  apiKey: string,
  args: Record<string, unknown>,
  body: Record<string, unknown>,
): { url: string; init: RequestInit } {
  const key = typeof args.idempotencyKey === "string" && args.idempotencyKey ? args.idempotencyKey : randomUUID()
  return {
    url: `${base}/api/v1/tokens/${encodeURIComponent(String(args.chain))}/${encodeURIComponent(String(args.mint))}/metadata`,
    init: {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "Idempotency-Key": key },
      body: JSON.stringify(body),
    },
  }
}

export function tokenHistoryRequest(base: string, args: Record<string, unknown>): { url: string; init: RequestInit } {
  const params = new URLSearchParams()
  if (args.limit !== undefined) params.set("limit", String(args.limit))
  if (typeof args.cursor === "string" && args.cursor) params.set("cursor", args.cursor)
  return {
    url: `${base}/api/v1/tokens/${encodeURIComponent(String(args.chain))}/${encodeURIComponent(String(args.mint))}/metadata/history${params.size ? `?${params}` : ""}`,
    init: { method: "GET", headers: { "Content-Type": "application/json" } },
  }
}

export const TOKEN_EDIT_DESCRIPTION =
  "Edit Candle's copy of a token's description and links (website, twitter for X, telegram, discord), as the token's creator. Needs CANDLE_AGENT_API_KEY with launch:write from the account that launched the token; any other account is refused NOT_TOKEN_CREATOR. Name, symbol and image cannot be changed. A field left out keeps its value; a link set to \"\" or null is removed. Nothing is written on chain: Candle's token page and API change at once, wallets reading on-chain metadata do not. A Hood token that carries its metadata on chain is refused ONCHAIN_METADATA_TOKEN (edit it on chain instead), and a TEE-launched Hood token TEE_LAUNCHED_HOOD_TOKEN. Re-sending the current values returns changed:false and adds no version. Retry with the SAME idempotencyKey after no answer or a retryable UNKNOWN: it returns the first result and never edits twice. Off on a deployment until it switches TOKEN_METADATA_EDIT on: off, the call answers 503 METADATA_EDIT_DISABLED (retryable: false), the server's answer, not a broken tool."

export const TOKEN_HISTORY_DESCRIPTION =
  "A token's metadata edits, newest first: each version's description and links, what they were before, which fields changed, when, and the author as a published agent name or the neutral Agent (never an account or key). Public; no key needed and none is sent. An empty list means the token was never edited. Page with nextCursor until it is null."
