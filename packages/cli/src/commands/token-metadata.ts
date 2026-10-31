/**
 * `candle token edit <mint>` and `candle token history <mint>` (BE-2140; spec
 * docs/superpowers/specs/2026-10-28-creator-metadata-edit-design.md, section 6, CLI).
 *
 * `edit` sets Candle's copy of a token's description and four links, as the token's creator:
 * `PATCH /api/v1/tokens/:chain/:mint/metadata` with the profile's key (launch:write). Name, symbol
 * and image cannot be changed. The five flags and their help come from the shared launch
 * definition (`--x` is `socials.twitter`); `--clear <field>` sends `""`, which removes it. It
 * acts as the profile's account, so dispatch runs the account guard for it (index.ts).
 *
 * `history <mint>` with no section is the token's edit history, newest first, public and keyless.
 * `history <mint> <section>` stays the About page's section history (token-pages.ts).
 *
 * Every edit sends an Idempotency-Key. A connection failure is retried once with the same key and
 * body; with no answer twice the outcome is unknown (exit 3) and the key is printed so a rerun with
 * `--idempotency-key` returns the first result instead of editing twice.
 *
 * Exit codes: 0 done, 1 refused or failed (the server's code), 2 usage or local input refused
 * (nothing was sent), 3 outcome unknown.
 */
import { randomUUID } from "node:crypto"
import { parseArgs } from "../args"
import { type ApiResult, apiRequest } from "../client"
import { type CommandContext, resolveApiKey } from "../deps"
import { writeFields, writeHeading } from "../human-output"
import { launchFlagFields } from "../launch-options"
import { errorEnvelope, terminalText, writeFailure, writeLocalFailure, writeUsageFailure } from "../render"
import { tokenHistory as tokenPageHistory } from "./token-pages"

export const EXIT_OUTCOME_UNKNOWN = 3

/** The launch definition's description and socials fields, the only ones an edit may change. */
export const EDIT_FIELDS = launchFlagFields.filter(
  (field) => field.key === "description" || field.key.startsWith("socials."),
)
/** `--clear` names: the flag without its dashes (`x` for `socials.twitter`). */
const CLEAR_NAMES = new Map(EDIT_FIELDS.map((field) => [field.cli.flag.slice(2), field.key]))

const EDIT_USAGE = `Usage: candle token edit <mint> [--chain solana|hood] ${EDIT_FIELDS.map(
  (field) => `[${field.cli.flag} ${"value" in field.cli ? field.cli.value : "<value>"}]`,
).join(" ")} [--clear <${[...CLEAR_NAMES.keys()].join("|")}>]... [--idempotency-key <key>] [--json]`
const HISTORY_USAGE = "Usage: candle token history <mint> [--chain solana|hood] [--limit <n>] [--cursor <c>] [--json]"

type Chain = "solana" | "hood"
type Usage = (message?: string) => number

function usageFor(ctx: CommandContext, line: string): Usage {
  return (message) => {
    writeUsageFailure(ctx.deps, message ? `${message}\n${line}` : line, ctx.json)
    return 2
  }
}

/** `--chain`, else the mint's shape: `0x` is Hood. */
export function chainFor(mint: string, given: string | undefined): Chain | undefined {
  const chain = given ?? (mint.startsWith("0x") ? "hood" : "solana")
  return chain === "solana" || chain === "hood" ? chain : undefined
}

function metadataPath(chain: Chain, mint: string, rest = ""): string {
  return `/api/v1/tokens/${chain}/${encodeURIComponent(mint)}/metadata${rest}`
}

/** Every `--clear <name>` (repeatable), and the arguments without them. */
function splitClears(args: string[]): { rest: string[]; clears: string[] } | { error: string } {
  const rest: string[] = []
  const clears: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--clear") {
      rest.push(args[i] as string)
      continue
    }
    const name = args[i + 1]
    if (name === undefined || name.startsWith("--")) return { error: "--clear needs a field name." }
    clears.push(name)
    i++
  }
  return { rest, clears }
}

export type EditBody = { description?: string; socials?: Record<string, string> }

/** The PATCH body for these flags: a flag's value sets its field, `--clear` sends `""`. */
export function editBodyOf(values: Record<string, string>, clears: string[]): EditBody | { error: string } {
  const body: EditBody = {}
  const socials: Record<string, string> = {}
  const set = (key: string, value: string) => {
    if (key === "description") body.description = value
    else socials[key.slice("socials.".length)] = value
  }
  for (const field of EDIT_FIELDS) {
    const value = values[field.cli.flag]
    if (value !== undefined) set(field.key, value)
  }
  for (const name of clears) {
    const key = CLEAR_NAMES.get(name)
    if (!key) return { error: `--clear takes ${[...CLEAR_NAMES.keys()].join(", ")}.` }
    const flag = `--${name}`
    if (values[flag] !== undefined) return { error: `${flag} and --clear ${name} cannot both be given.` }
    set(key, "")
  }
  if (Object.keys(socials).length) body.socials = socials
  if (body.description === undefined && body.socials === undefined) {
    return { error: "Name at least one field to change." }
  }
  return body
}

type EditPayload = {
  chain: Chain
  mint: string
  changed: boolean
  version: number | null
  description: string
  socials: Record<string, string>
  chainState: string
  chainTx: string | null
}

function payloadOf(result: ApiResult): unknown {
  const body = result.ok ? (result.body as { payload?: unknown } | null) : null
  return body && typeof body === "object" && "payload" in body ? body.payload : undefined
}

const LINK_LABELS: Record<string, string> = {
  website: "Website",
  twitter: "X",
  telegram: "Telegram",
  discord: "Discord",
}

function linkRows(socials: Record<string, string>): Array<[string, string]> {
  return Object.keys(LINK_LABELS).map((key) => [LINK_LABELS[key] as string, socials[key] ?? "-"])
}

async function patchOnce(
  ctx: CommandContext,
  path: string,
  body: EditBody,
  apiKey: string,
  idempotencyKey: string,
): Promise<ApiResult> {
  try {
    return await apiRequest(path, {
      apiUrl: ctx.apiUrl,
      method: "PATCH",
      body,
      auth: "key",
      credentials: { apiKey },
      headers: { "Idempotency-Key": idempotencyKey },
      fetch: ctx.deps.fetch,
      env: ctx.deps.env,
    })
  } catch {
    // A body cut off after the headers is still no answer: the same retry-then-unknown path.
    return { ok: false, status: 0, message: "The response was cut off before it finished.", raw: undefined }
  }
}

/** An answer that leaves it open whether the edit landed: no answer at all, or a retryable server fault. */
function mayHaveCommitted(result: ApiResult): boolean {
  if (result.ok) return false
  if (result.status === 0 && !result.code) return true
  return result.retryable === true || (result.status >= 500 && result.retryable !== false)
}

export async function tokenEdit(args: string[], ctx: CommandContext): Promise<number> {
  const usage = usageFor(ctx, EDIT_USAGE)
  const split = splitClears(args)
  if ("error" in split) return usage(split.error)
  const parsed = parseArgs(split.rest, {
    valueFlags: ["--chain", "--idempotency-key", ...EDIT_FIELDS.map((field) => field.cli.flag)],
  })
  if ("error" in parsed) return usage(parsed.error)
  const [mint] = parsed.positionals
  if (parsed.positionals.length !== 1 || !mint) return usage()
  const chain = chainFor(mint, parsed.values["--chain"])
  if (!chain) return usage("--chain must be solana or hood.")
  const body = editBodyOf(parsed.values, split.clears)
  if ("error" in body) return usage(body.error)
  const given = parsed.values["--idempotency-key"]
  if (given !== undefined && (given.length < 1 || given.length > 128)) {
    return usage("--idempotency-key must be 1 to 128 characters.")
  }
  const idempotencyKey = given ?? randomUUID()

  const apiKey = await resolveApiKey(ctx.deps, ctx.profile)
  if (!apiKey) {
    writeLocalFailure(
      ctx.deps,
      {
        code: "API_KEY_REQUIRED",
        message: "Editing a token's metadata needs an API key with launch:write, from the account that launched it.",
        suggestion: "Log in with: candle login",
      },
      ctx.json,
    )
    return 1
  }

  const path = metadataPath(chain, mint)
  let result = await patchOnce(ctx, path, body, apiKey, idempotencyKey)
  // An attempt that may have committed is settled only by a later successful answer. A later
  // refusal — the switch turned off, a quota — says nothing about whether the first attempt
  // landed, so the key stays exposed until a success resolves the operation.
  const unsettledCommit = mayHaveCommitted(result)
  if (unsettledCommit) result = await patchOnce(ctx, path, body, apiKey, idempotencyKey)
  if (!result.ok && result.status === 0 && !result.code) {
    writeLocalFailure(
      ctx.deps,
      {
        code: "OUTCOME_UNKNOWN",
        message: "Candle did not answer, twice, so whether this edit landed is not known.",
        suggestion: `Rerun the same command with --idempotency-key ${idempotencyKey}: Candle returns the first result instead of editing twice.`,
        details: { idempotencyKey },
      },
      ctx.json,
    )
    return EXIT_OUTCOME_UNKNOWN
  }
  if (!result.ok) {
    const failure = { apiUrl: ctx.apiUrl, authType: "key" } as const
    if (!unsettledCommit && !mayHaveCommitted(result)) {
      writeFailure(ctx.deps, result, failure, ctx.json)
      return 1
    }
    // The API commits the receipt before it projects, so an attempt here can be an edit that
    // landed: the key is the only way to replay it rather than re-merge this patch over a newer
    // edit. This holds even when the last answer is itself a plain refusal.
    const retry = `Rerun the same command with --idempotency-key ${idempotencyKey}: Candle returns the first result instead of editing twice.`
    if (ctx.json) {
      ctx.deps.stdout.write(
        `${JSON.stringify({ ...errorEnvelope(result, failure), idempotencyKey, details: { idempotencyKey }, retryCommand: retry })}\n`,
      )
    } else {
      writeFailure(ctx.deps, result, failure, false)
      ctx.deps.stderr.write(`Idempotency key: ${idempotencyKey}\n${retry}\n`)
    }
    return 1
  }
  const payload = payloadOf(result) as EditPayload | undefined
  if (!payload || typeof payload.changed !== "boolean") {
    writeLocalFailure(ctx.deps, { code: "BAD_RESPONSE", message: "Candle's answer was not an edit result." }, ctx.json)
    return 1
  }
  if (ctx.json) {
    ctx.deps.stdout.write(`${JSON.stringify({ ok: true, data: payload })}\n`)
    return 0
  }
  writeFields(ctx.deps, "stdout", [
    ["Result", payload.changed ? "edited" : "nothing changed"],
    ["Version", payload.version === null ? "-" : String(payload.version)],
    ...(payload.changed ? [["Changed", changedOf(body)] as [string, string]] : []),
    ["Description", payload.description ? terminalText(payload.description) : "-"],
    ...linkRows(payload.socials),
  ])
  return 0
}

/** The fields this edit named, in the definition's order, as the CLI spells them. */
function changedOf(body: EditBody): string {
  const named = EDIT_FIELDS.filter((field) =>
    field.key === "description"
      ? body.description !== undefined
      : body.socials?.[field.key.slice("socials.".length)] !== undefined,
  )
  return named.map((field) => field.cli.flag.slice(2)).join(", ")
}

type HistoryItem = {
  version: number
  createdAt: string
  changedFields: string[]
  description: string
  socials: Record<string, string>
  prevDescription: string
  prevSocials: Record<string, string>
  chainState: string
  chainTx: string | null
  author: { kind: string; name: string | null }
}

/** `history <mint>` is the edit history; `history <mint> <section>` is the About section history. */
export async function tokenHistory(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--chain", "--limit", "--cursor"] })
  if ("error" in parsed || parsed.positionals.length !== 1) return tokenPageHistory(args, ctx)
  const usage = usageFor(ctx, HISTORY_USAGE)
  const mint = parsed.positionals[0] as string
  const chain = chainFor(mint, parsed.values["--chain"])
  if (!chain) return usage("--chain must be solana or hood.")
  const limit = parsed.values["--limit"]
  if (limit !== undefined && (!/^[1-9]\d?$/.test(limit) || Number(limit) > 50)) {
    return usage("--limit is a whole number from 1 to 50.")
  }
  const query = new URLSearchParams({
    ...(limit !== undefined ? { limit } : {}),
    ...(parsed.values["--cursor"] !== undefined ? { cursor: parsed.values["--cursor"] } : {}),
  })
  const result = await apiRequest(metadataPath(chain, mint, `/history${query.size ? `?${query}` : ""}`), {
    apiUrl: ctx.apiUrl,
    auth: "none",
    credentials: {},
    fetch: ctx.deps.fetch,
    env: ctx.deps.env,
  })
  if (!result.ok) {
    writeFailure(ctx.deps, result, { apiUrl: ctx.apiUrl, authType: "none" }, ctx.json)
    return 1
  }
  const data = payloadOf(result) as { items?: HistoryItem[]; nextCursor?: string | null } | undefined
  if (!data || !Array.isArray(data.items)) {
    writeLocalFailure(ctx.deps, { code: "BAD_RESPONSE", message: "Candle's answer was not an edit history." }, ctx.json)
    return 1
  }
  if (ctx.json) {
    ctx.deps.stdout.write(`${JSON.stringify({ ok: true, data })}\n`)
    return 0
  }
  if (!data.items.length) ctx.deps.stdout.write("No edits.\n")
  for (const item of data.items) {
    writeHeading(ctx.deps, "stdout", `version ${item.version}`)
    writeFields(ctx.deps, "stdout", [
      ["At", item.createdAt],
      ["By", item.author?.name ? terminalText(item.author.name) : "Agent"],
      ["Changed", item.changedFields.join(", ")],
      ...item.changedFields.map((field): [string, string] => {
        const now = field === "description" ? item.description : item.socials[field.slice("socials.".length)]
        const was = field === "description" ? item.prevDescription : item.prevSocials[field.slice("socials.".length)]
        return [field, `${was ? terminalText(was) : "-"} -> ${now ? terminalText(now) : "-"}`]
      }),
    ])
  }
  if (data.nextCursor) ctx.deps.stdout.write(`\nMore: --cursor ${data.nextCursor}\n`)
  return 0
}
