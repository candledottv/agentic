/**
 * `candle quant terms [--terms-version <YYYY-MM-DD>] [--yes] [--json]` (spec 7.3, 10.1): shows Quant's
 * terms and records this account's acceptance through the key route
 * `POST /api/v1/agent/quant/terms/accept` (BE-1874). Quant per use needs it: a paid turn without
 * accepted terms is refused 403 `TERMS_REQUIRED` before any 402, so no one pays for a turn Quant
 * would refuse.
 *
 * Quant accepts only its current terms version and answers any other `terms_version_mismatch`.
 * The version sent by default is the one this release was built against, the same date the web
 * app sends (`TERMS_VERSION`, `apps/frontend/src/utils/social-links.ts`); `--terms-version` sends another.
 */

import { parseArgs } from "../args"
import { apiRequest } from "../client"
import { type CommandContext, resolveApiKey } from "../deps"
import { writeFields, writeSuccess } from "../human-output"
import {
  writeScreenFailure as writeFailure,
  writeScreenLocalFailure as writeLocalFailure,
  writeScreenUsageFailure as writeUsageFailure,
} from "./key-output"

export const QUANT_TERMS_VERSION = "2026-10-25"
export const QUANT_TERMS_URL = "https://docs.candle.tv/terms"
export const QUANT_PRIVACY_URL = "https://docs.candle.tv/privacy"

export async function quantTerms(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--terms-version"], booleanFlags: ["--yes"] })
  const version = "error" in parsed ? "" : (parsed.values["--terms-version"] ?? QUANT_TERMS_VERSION)
  if ("error" in parsed || parsed.positionals.length !== 0 || !/^\d{4}-\d{2}-\d{2}$/.test(version)) {
    writeUsageFailure(ctx.deps, "Usage: candle quant terms [--terms-version <YYYY-MM-DD>] [--yes] [--json]", ctx.json)
    return 2
  }
  const apiKey = await resolveApiKey(ctx.deps, ctx.profile)
  if (!apiKey) {
    writeLocalFailure(
      ctx.deps,
      {
        code: "NO_API_KEY",
        message: "Quant's terms are accepted per account, through an API key, and this profile has none.",
        suggestion: "Run: candle auth login",
      },
      ctx.json,
    )
    return 1
  }
  if (ctx.json) {
    writeFields(ctx.deps, "stderr", [
      ["Quant terms version", version],
      ["Terms", QUANT_TERMS_URL],
      ["Privacy policy", QUANT_PRIVACY_URL],
    ])
  } else {
    writeFields(
      ctx.deps,
      "stdout",
      [
        ["Version", version],
        ["Terms", QUANT_TERMS_URL],
        ["Privacy Policy", QUANT_PRIVACY_URL],
      ],
      "Quant terms",
    )
  }
  if (!parsed.booleans.has("--yes")) {
    if (!ctx.deps.isTTY.stdin) {
      writeUsageFailure(ctx.deps, "Accepting needs a terminal to confirm at, or --yes.", ctx.json)
      return 2
    }
    const answer = await ctx.deps.promptLine(`Type accept to accept Quant's terms ${version}: `)
    if (answer.trim().toLowerCase() !== "accept") {
      writeLocalFailure(
        ctx.deps,
        { code: "TERMS_NOT_ACCEPTED", message: "Not accepted; nothing was recorded." },
        ctx.json,
      )
      return 1
    }
  }
  const result = await apiRequest("/api/v1/agent/quant/terms/accept", {
    method: "POST",
    body: { version },
    apiUrl: ctx.apiUrl,
    auth: "key",
    credentials: { apiKey },
    env: ctx.deps.env,
    fetch: ctx.deps.fetch,
  })
  if (result.ok) {
    if (ctx.json) ctx.deps.stdout.write(`${JSON.stringify({ ok: true, version })}\n`)
    else writeSuccess(ctx.deps, "stdout", `Accepted Quant's terms ${version}.`)
    return 0
  }
  // Quant's own refusals are `{ code }` (the relay shape); the key middleware's are the envelope.
  const relayCode = (result.raw as { code?: unknown } | null)?.code
  const code = typeof relayCode === "string" ? relayCode : result.code
  if (code === "terms_version_mismatch") {
    writeLocalFailure(
      ctx.deps,
      {
        code: "TERMS_VERSION_MISMATCH",
        message: `Quant's current terms are not version ${version}; nothing was recorded.`,
        suggestion: "Read the terms and pass the current version with --terms-version <YYYY-MM-DD>.",
      },
      ctx.json,
    )
    return 1
  }
  if (result.status === 404) {
    writeLocalFailure(
      ctx.deps,
      { code: "QUANT_TERMS_UNAVAILABLE", message: "This API does not take Quant's terms over a key yet." },
      ctx.json,
    )
    return 1
  }
  writeFailure(
    ctx.deps,
    { ...result, ...(typeof code === "string" ? { code } : {}) },
    { apiUrl: ctx.apiUrl, authType: "key" },
    ctx.json,
  )
  return 1
}
