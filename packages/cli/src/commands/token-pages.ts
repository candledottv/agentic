/**
 * Token page About (2026-10-25 token pages spec, sections 7-9): the first general write client.
 * `about` and `history` are public reads and send no key. `about --capabilities` is the private
 * eligibility read (`token-pages:read`). `claim`, `section set|restore` and `flag` act as the
 * profile's key (`token-pages:write`, owner-granted through `keys create --scopes`); the key's
 * account must hold its own current 0.5% of supply, and Candle decides that on every write.
 *
 * A creator proof is a message, never a transaction: `claim --creator --challenge` prints the
 * exact bytes Candle issued, the creator signs them on their own machine (`candle sign message`
 * or any wallet's message signer), and `claim --creator --challenge-id --signature` sends only the
 * signature. Nothing here asks for a private key or hands a signature request to Candle.
 *
 * Every write sends an `Idempotency-Key`. A connection failure is retried once with the same key
 * and body; if that also gets no answer the outcome is unknown (exit 3) and the key is printed so
 * a rerun with `--idempotency-key` returns the first result instead of writing twice. Section text
 * comes from a file that this command only reads, so a revision conflict (exit 4) leaves the draft
 * exactly where it was. Request bodies and credentials are never printed.
 *
 * Exit codes: 0 done, 1 refused or failed (the server's code), 2 usage or a local input refusal
 * (nothing was sent), 3 outcome unknown, 4 revision conflict.
 */
import { createHash, randomUUID } from "node:crypto"
import { base58, base64 } from "@scure/base"
import { parseArgs } from "../args"
import { type ApiResult, apiRequest } from "../client"
import { type CommandContext, resolveApiKey } from "../deps"
import { writeFields, writeHeading } from "../human-output"
import { notice } from "../presentation"
import { terminalText, writeFailure, writeLocalFailure, writeUsageFailure } from "../render"

export const EXIT_OUTCOME_UNKNOWN = 3
export const EXIT_REVISION_CONFLICT = 4

/** Mirrors the API's limits (apps/api token-pages `text.ts`); `token-pages.drift.test.ts` pins them. */
export const TOKEN_PAGE_LIMITS = { thesis: 280, tokenomics: 5000, lore: 5000, update: 1000, comment: 500 } as const
export const TOKEN_PAGE_BODY_CAP_BYTES = 32 * 1024
export const TOKEN_PAGE_SECTIONS = ["thesis", "tokenomics", "lore"] as const
export const FLAG_REASONS = ["spam", "scam", "abuse", "misleading", "unsafe_link", "other"] as const
const FLAG_DETAIL_LIMIT = 500
type Section = (typeof TOKEN_PAGE_SECTIONS)[number]

const USAGE = {
  about: "Usage: candle token about <address> [--chain solana|hood] [--capabilities]",
  claim:
    "Usage: candle token claim <address> [--chain solana|hood] [--creator [--challenge [--message-out <path>] | --challenge-id <id> --signature <sig>]] [--idempotency-key <key>]",
  section:
    "Usage: candle token section set <address> <thesis|tokenomics|lore> --file <path> --base-revision <n> [--clear] [--chain solana|hood] [--idempotency-key <key>]\n       candle token section restore <address> <thesis|tokenomics|lore> --version-id <id> --base-revision <n> [--chain solana|hood] [--idempotency-key <key>]",
  history:
    "Usage: candle token history <address> <thesis|tokenomics|lore> [--chain solana|hood] [--limit <n>] [--cursor <c>]",
  flag: "Usage: candle token flag <address> --content <id> --reason <spam|scam|abuse|misleading|unsafe_link|other> [--detail <text>] [--chain solana|hood] [--idempotency-key <key>]",
} as const

/** Plain sentences for the API's token page refusal codes. The code itself is what `--json` carries. */
const REFUSALS: Record<string, string> = {
  feature_off: "This token page action is switched off on this Candle server. Nothing was written.",
  not_found: "No such token page, item or version here, or token pages are switched off on this Candle server.",
  insufficient_holding:
    "This account's Candle-known wallets hold less than 0.5% of the token's current supply (any positive balance is enough to flag). Nothing was written.",
  eligibility_unavailable:
    "Candle could not read complete, fresh wallet and supply evidence for this account just now. Nothing was written; try again shortly.",
  restricted: "This account is restricted from writing on this token page.",
  revision_conflict: "The section changed since the base revision you gave.",
  idempotency_conflict: "This idempotency key was already used for a different request. Nothing was written.",
  idempotency_key_required: "The request carried no usable Idempotency-Key.",
  challenge_used: "That creator challenge was already used, or the creator evidence changed. Request a new one.",
  invalid_signature:
    "The signature does not verify for that challenge, or the challenge expired (5 minutes). Request a new one.",
  creator_unknown: "Candle has no verified creator for this token, so there is nothing to prove.",
  creator_proof_unsupported:
    "The verified creator cannot sign a message (a contract or multisig), so creator proof is not available.",
  invalid_text: "Candle refused the text: too long, empty, or holding invalid Unicode or control characters.",
  invalid_body: "Candle refused the request body.",
  invalid_token: "That is not a valid address on that chain.",
  invalid_section: "Sections are thesis, tokenomics and lore.",
  invalid_query: "Candle refused the query (limit is 1-50; the cursor must come from this list).",
  no_identity_wallet: "This key's account has no wallet Candle can use as its identity.",
  rate_limited: "Too many token page requests; wait a minute and try again.",
  unavailable: "Token pages are unavailable on this Candle server just now.",
  measurements_unavailable: "Measurements are unavailable just now; try again shortly.",
}

const SECTION_SUGGESTION =
  "Your file was not changed. Read the newer text with candle token history, merge, then rerun with --base-revision set to the latest revision."

type Chain = "solana" | "hood"
type Usage = (message?: string) => number
type Refusal = { status: number; code: string; extra: Record<string, unknown> }

function usageFor(ctx: CommandContext, line: string): Usage {
  return (message) => {
    writeUsageFailure(ctx.deps, message ? `${message}\n${line}` : line, ctx.json)
    return 2
  }
}

function chainOf(values: Record<string, string>): Chain | undefined {
  const chain = values["--chain"] ?? "solana"
  return chain === "solana" || chain === "hood" ? chain : undefined
}

function pagePath(chain: Chain, address: string, rest = ""): string {
  return `/api/v1/token-pages/${chain}/${encodeURIComponent(address)}${rest}`
}

/** A token page refusal is `{ success: false, error: "<code>", ...extra }`; anything else is not. */
function refusalOf(result: ApiResult): Refusal | null {
  if (result.ok) return null
  const raw = result.raw
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const { success, error, ...extra } = raw as Record<string, unknown>
  if (success !== false || typeof error !== "string") return null
  return { status: result.status, code: error, extra }
}

function writeRefusal(ctx: CommandContext, refusal: Refusal, suggestion?: string): void {
  const message = REFUSALS[refusal.code] ?? `Candle refused the request (${refusal.code}).`
  if (ctx.json) {
    ctx.deps.stdout.write(
      `${JSON.stringify({ ok: false, code: refusal.code, status: refusal.status, message, ...refusal.extra, ...(suggestion ? { suggestion } : {}) })}\n`,
    )
    return
  }
  ctx.deps.stderr.write(`${suggestion ? `${message} ${suggestion}` : message}\n`)
}

/** Any non-2xx answer: the token page refusal envelope, else the CLI's ordinary error rendering. */
function writeApiFailure(ctx: CommandContext, result: ApiResult, authType: "key" | "none"): number {
  const refusal = refusalOf(result)
  if (refusal) {
    writeRefusal(ctx, refusal)
    return 1
  }
  writeFailure(ctx.deps, result as Extract<ApiResult, { ok: false }>, { apiUrl: ctx.apiUrl, authType }, ctx.json)
  return 1
}

function dataOf(result: ApiResult): unknown {
  const body = result.ok ? (result.body as { data?: unknown } | null) : null
  return body && typeof body === "object" && "data" in body ? body.data : body
}

async function read(ctx: CommandContext, path: string, apiKey?: string): Promise<ApiResult> {
  return apiRequest(path, {
    apiUrl: ctx.apiUrl,
    ...(apiKey ? { auth: "key" as const, credentials: { apiKey } } : { auth: "none" as const, credentials: {} }),
    fetch: ctx.deps.fetch,
    env: ctx.deps.env,
  })
}

async function requireKey(ctx: CommandContext): Promise<string | undefined> {
  const key = await resolveApiKey(ctx.deps, ctx.profile)
  if (key) return key
  writeLocalFailure(
    ctx.deps,
    {
      code: "API_KEY_REQUIRED",
      message: "This needs an API key with the token-pages scopes.",
      suggestion: "Create one with: candle keys create --scopes token-pages:read,token-pages:write",
    },
    ctx.json,
  )
  return undefined
}

/**
 * One keyed write. A connection failure (status 0, no answer) is retried once with the SAME key and
 * body, which the API answers with the first result if the first attempt did land.
 */
async function write(
  ctx: CommandContext,
  input: { method: "POST" | "PUT"; path: string; body: unknown; apiKey: string; idempotencyKey: string },
): Promise<ApiResult | "unknown"> {
  // A body that disconnects after the headers arrive makes apiRequest reject; that is still "no
  // answer", so it takes the same retry-then-unknown path as a refused connection.
  const send = async (): Promise<ApiResult> => {
    try {
      return await apiRequest(input.path, {
        apiUrl: ctx.apiUrl,
        method: input.method,
        body: input.body,
        auth: "key",
        credentials: { apiKey: input.apiKey },
        headers: { "Idempotency-Key": input.idempotencyKey },
        fetch: ctx.deps.fetch,
        env: ctx.deps.env,
      })
    } catch {
      return { ok: false, status: 0, message: "The response was cut off before it finished.", raw: undefined }
    }
  }
  const first = await send()
  if (first.ok || first.status !== 0 || first.code) return first
  const second = await send()
  if (second.ok || second.status !== 0 || second.code) return second
  return "unknown"
}

function writeUnknown(ctx: CommandContext, idempotencyKey: string): number {
  writeLocalFailure(
    ctx.deps,
    {
      code: "OUTCOME_UNKNOWN",
      message: "Candle did not answer, twice, so whether this write landed is not known.",
      suggestion: `Rerun the same command with --idempotency-key ${idempotencyKey}: Candle returns the first result instead of writing twice.`,
      details: { idempotencyKey },
    },
    ctx.json,
  )
  return EXIT_OUTCOME_UNKNOWN
}

function idempotencyKeyOf(values: Record<string, string>, usage: Usage): string | number {
  const given = values["--idempotency-key"]
  if (given === undefined) return randomUUID()
  if (given.length < 1 || given.length > 128) return usage("--idempotency-key must be 1 to 128 characters.")
  return given
}

function sectionOf(value: string | undefined): Section | undefined {
  return (TOKEN_PAGE_SECTIONS as readonly string[]).includes(value ?? "") ? (value as Section) : undefined
}

const REVISION = /^(0|[1-9][0-9]{0,18})$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Basis points as a percent, exactly: "62" -> "0.62%". */
export function bpsPercent(bps: string | null | undefined): string | undefined {
  if (bps === null || bps === undefined || !/^\d+$/.test(bps)) return undefined
  const n = BigInt(bps)
  return `${n / 100n}.${(n % 100n).toString().padStart(2, "0")}%`
}

type Identity =
  | { kind: "candle" }
  | { kind: "account"; name: string | null; account: string }
  | { kind: "agent"; name: string | null }
function identity(who: Identity | null | undefined): string | undefined {
  if (!who) return undefined
  if (who.kind === "candle") return "Candle"
  if (who.kind === "agent") return terminalText(who.name ?? "Agent")
  return terminalText(who.name ?? who.account)
}

/**
 * The local text gate, before anything is sent: valid UTF-8, the byte cap, no control character
 * other than newline and tab, and the section's code-point limit after CRLF normalization. The
 * same rules the API applies, so a refusal here is one the server would also give.
 */
export function sectionText(bytes: Uint8Array, section: Section): { text: string } | { error: string } {
  if (bytes.length > TOKEN_PAGE_BODY_CAP_BYTES) return { error: `The file is over ${TOKEN_PAGE_BODY_CAP_BYTES} bytes.` }
  let decoded: string
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return { error: "The file is not valid UTF-8." }
  }
  const text = decoded.replace(/\r\n?/g, "\n")
  for (const char of text) {
    const c = char.codePointAt(0) ?? 0
    if ((c < 32 && c !== 10 && c !== 9) || c === 127 || (c >= 0x80 && c < 0xa0) || (c >= 0xd800 && c <= 0xdfff))
      return { error: `The file holds a control character (U+${c.toString(16).toUpperCase().padStart(4, "0")}).` }
  }
  const length = [...text].length
  const limit = TOKEN_PAGE_LIMITS[section]
  if (length > limit) return { error: `${section} is at most ${limit} characters; the file has ${length}.` }
  return { text }
}

/**
 * A Solana signature may be given as `candle sign message` prints it (base58) or base64; Candle
 * takes base64. A Hood signature is 0x hex (65 bytes), sent as given.
 */
export function signatureFor(chain: Chain, given: string): string | undefined {
  const value = given.trim()
  if (chain === "hood") return /^0x[0-9a-fA-F]{130}$/.test(value) ? value : undefined
  try {
    const bytes = value.endsWith("=") || /[+/]/.test(value) ? base64.decode(value) : base58.decode(value)
    return bytes.length === 64 ? base64.encode(bytes) : undefined
  } catch {
    return undefined
  }
}

// ── about ──────────────────────────────────────────────────────────────────────────────────────

type SectionVersion = {
  id: string
  revision: string
  text: string
  author: Identity
  dev: boolean
  shareBps: string | null
  source: string
  createdAt: string
  linksWithheld: boolean
  newerAwaitingReview: boolean
}
type About = {
  token: { chain: Chain; address: string }
  revision: string
  claim: { state: string; lead: Identity | null; eligibleAccounts: number | null; measuredAt: string | null }
  sections: Partial<Record<Section, SectionVersion>>
  facts: {
    metric: string
    status: string
    raw?: string
    decimals?: number
    unit: string
    measuredAt: string | null
    source: string
    coverage: string
  }[]
  features: Record<string, boolean>
}

function factValue(fact: About["facts"][number]): string {
  if (fact.raw === undefined) return fact.status
  const value = fact.decimals ? rawUnits(fact.raw, fact.decimals) : fact.raw
  return `${value}${fact.unit === "token" ? "" : ` ${fact.unit}`} (${fact.status}, ${fact.coverage}, ${terminalText(fact.source)}${fact.measuredAt ? `, ${fact.measuredAt}` : ""})`
}

/** A raw integer amount at `decimals`, exactly, trailing zeros trimmed. */
export function rawUnits(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw)) return raw
  const padded = raw.padStart(decimals + 1, "0")
  const whole = padded.slice(0, padded.length - decimals)
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "")
  return fraction ? `${whole}.${fraction}` : whole
}

function writeAbout(ctx: CommandContext, about: About): void {
  const claim = about.claim
  writeFields(
    ctx.deps,
    "stdout",
    [
      ["Token", `${about.token.chain} ${about.token.address}`],
      ["Revision", about.revision],
      [
        "Claim",
        claim.state === "unclaimed" ? "unclaimed" : `claimed by ${claim.state === "dev" ? "dev" : "community"}`,
      ],
      ["Lead", identity(claim.lead) ?? "no current eligible lead"],
      ["Eligible", claim.eligibleAccounts === null ? "refreshing" : String(claim.eligibleAccounts)],
      [
        "Switches",
        Object.entries(about.features)
          .map(([name, on]) => `${name} ${on ? "on" : "off"}`)
          .join(", "),
      ],
    ],
    "About",
  )
  for (const section of TOKEN_PAGE_SECTIONS) {
    const v = about.sections[section]
    if (!v) continue
    writeHeading(ctx.deps, "stdout", `${section} (revision ${v.revision})`)
    writeFields(ctx.deps, "stdout", [
      ["Written by", `${identity(v.author)}${v.dev ? " (dev)" : ""}`],
      ["Share then", bpsPercent(v.shareBps)],
      ["At", v.createdAt],
      ["Version", v.id],
    ])
    if (v.newerAwaitingReview) notice(ctx.deps, "stdout", "note", "A newer version is hidden pending review.")
    if (v.linksWithheld) notice(ctx.deps, "stdout", "note", "Links are withheld pending review.")
    ctx.deps.stdout.write(`\n${terminalTextKeepingLines(v.text)}\n`)
  }
  writeHeading(ctx.deps, "stdout", "Supply, measured by Candle")
  const facts = about.facts.filter((f) => f.status === "known" || f.status === "stale")
  if (!facts.length) ctx.deps.stdout.write("  Measurements unavailable\n")
  else
    writeFields(
      ctx.deps,
      "stdout",
      facts.map((f) => [terminalText(f.metric), factValue(f)] as const),
    )
}

/** Holder text with its line breaks and tabs kept and every other control character dropped. */
function terminalTextKeepingLines(text: string): string {
  return text
    .split("\n")
    .map((line) => terminalText(line.replace(/\t/g, "    ")))
    .join("\n")
}

export async function tokenAbout(args: string[], ctx: CommandContext): Promise<number> {
  const usage = usageFor(ctx, USAGE.about)
  const parsed = parseArgs(args, { valueFlags: ["--chain"], booleanFlags: ["--capabilities"] })
  if ("error" in parsed) return usage(parsed.error)
  const chain = chainOf(parsed.values)
  const address = parsed.positionals[0]
  if (parsed.positionals.length !== 1 || !address) return usage()
  if (!chain) return usage("--chain must be solana or hood.")
  const withCapabilities = parsed.booleans.has("--capabilities")
  const apiKey = withCapabilities ? await requireKey(ctx) : undefined
  if (withCapabilities && !apiKey) return 1

  const summary = await read(ctx, pagePath(chain, address))
  if (!summary.ok) return writeApiFailure(ctx, summary, "none")
  let capabilities: unknown
  if (apiKey) {
    const own = await read(ctx, pagePath(chain, address, "/capabilities"), apiKey)
    if (!own.ok) return writeApiFailure(ctx, own, "key")
    capabilities = dataOf(own)
  }
  const about = dataOf(summary) as About
  if (ctx.json) {
    ctx.deps.stdout.write(`${JSON.stringify({ ok: true, data: about, ...(apiKey ? { capabilities } : {}) })}\n`)
    return 0
  }
  writeAbout(ctx, about)
  if (apiKey) {
    const c = capabilities as {
      canClaim: boolean
      canEdit: boolean
      canFlag: boolean
      creatorProven: boolean
      shareBps: string | null
      observedAt: string | null
      refusal: string | null
    }
    writeFields(
      ctx.deps,
      "stdout",
      [
        ["Can claim", c.canClaim ? "yes" : "no"],
        ["Can edit", c.canEdit ? "yes" : "no"],
        ["Can flag", c.canFlag ? "yes" : "no"],
        ["Creator", c.creatorProven ? "proven" : "not proven"],
        ["Share now", bpsPercent(c.shareBps)],
        ["Observed", c.observedAt],
        ["Why not", c.refusal ? (REFUSALS[c.refusal] ?? c.refusal) : undefined],
      ],
      "This account",
    )
  }
  return 0
}

// ── claim ──────────────────────────────────────────────────────────────────────────────────────

export async function tokenClaim(args: string[], ctx: CommandContext): Promise<number> {
  const usage = usageFor(ctx, USAGE.claim)
  const parsed = parseArgs(args, {
    valueFlags: ["--chain", "--challenge-id", "--signature", "--message-out", "--idempotency-key"],
    booleanFlags: ["--creator", "--challenge"],
    pathFlags: ["--message-out"],
  })
  if ("error" in parsed) return usage(parsed.error)
  const { values, booleans } = parsed
  const chain = chainOf(values)
  const address = parsed.positionals[0]
  if (parsed.positionals.length !== 1 || !address) return usage()
  if (!chain) return usage("--chain must be solana or hood.")
  const creator = booleans.has("--creator")
  const challenge = booleans.has("--challenge")
  const challengeId = values["--challenge-id"]
  const given = values["--signature"]
  if ((challenge || challengeId !== undefined || given !== undefined) && !creator)
    return usage("--challenge, --challenge-id and --signature are for --creator.")
  if (challenge && (challengeId !== undefined || given !== undefined))
    return usage("--challenge asks for a new challenge; send the signature in a second run.")
  if ((challengeId === undefined) !== (given === undefined)) return usage("--challenge-id and --signature go together.")
  if (values["--message-out"] !== undefined && !challenge) return usage("--message-out goes with --challenge.")
  if (challengeId !== undefined && !UUID.test(challengeId))
    return usage("--challenge-id is the id the challenge printed.")
  let signature: string | undefined
  if (given !== undefined) {
    signature = signatureFor(chain, given)
    if (!signature)
      return usage(
        chain === "hood"
          ? "--signature must be the 0x-hex message signature (65 bytes)."
          : "--signature must be the 64-byte Ed25519 signature, base58 or base64.",
      )
  }
  const idempotencyKey = idempotencyKeyOf(values, usage)
  if (typeof idempotencyKey === "number") return idempotencyKey
  const apiKey = await requireKey(ctx)
  if (!apiKey) return 1

  if (challenge) return creatorChallenge(ctx, chain, address, apiKey, values["--message-out"])

  const body = { kind: creator ? "creator" : "holder", ...(challengeId ? { challengeId, signature } : {}) }
  const result = await write(ctx, {
    method: "POST",
    path: pagePath(chain, address, "/claims"),
    body,
    apiKey,
    idempotencyKey,
  })
  if (result === "unknown") return writeUnknown(ctx, idempotencyKey)
  if (!result.ok) {
    const refusal = refusalOf(result)
    if (refusal?.code === "invalid_signature" && creator && !challengeId) {
      writeRefusal(
        ctx,
        refusal,
        `This account's known wallets do not include the verified creator, so the claim needs a signed challenge: candle token claim ${address} --chain ${chain} --creator --challenge`,
      )
      return 1
    }
    return writeApiFailure(ctx, result, "key")
  }
  const data = dataOf(result) as { state: string; kind: string; creatorProven: boolean; revision: string }
  if (ctx.json) ctx.deps.stdout.write(`${JSON.stringify({ ok: true, data, idempotencyKey })}\n`)
  else
    writeFields(
      ctx.deps,
      "stdout",
      [
        ["Kind", data.kind],
        ["Creator", data.creatorProven ? "proven" : "not proven"],
        ["Revision", data.revision],
      ],
      "Claimed",
    )
  return 0
}

async function creatorChallenge(
  ctx: CommandContext,
  chain: Chain,
  address: string,
  apiKey: string,
  messageOut: string | undefined,
): Promise<number> {
  // A challenge is not idempotent by design: each call is a fresh single-use nonce. One attempt.
  const result = await apiRequest(pagePath(chain, address, "/creator-challenges"), {
    apiUrl: ctx.apiUrl,
    method: "POST",
    body: {},
    auth: "key",
    credentials: { apiKey },
    fetch: ctx.deps.fetch,
    env: ctx.deps.env,
  })
  if (!result.ok) return writeApiFailure(ctx, result, "key")
  const data = dataOf(result) as { challengeId: string; message: string; expiresAt: string }
  const bytes = new TextEncoder().encode(data.message)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  if (messageOut !== undefined) {
    try {
      await ctx.deps.writeFile(messageOut, data.message)
    } catch (error) {
      writeLocalFailure(
        ctx.deps,
        {
          code: "MESSAGE_OUT_FAILED",
          message: `The challenge could not be written to ${messageOut}: ${error instanceof Error ? error.message : error}.`,
          details: { challengeId: data.challengeId },
        },
        ctx.json,
      )
      return 1
    }
  }
  const next = `candle token claim ${address} --chain ${chain} --creator --challenge-id ${data.challengeId} --signature <signature>`
  if (ctx.json) {
    ctx.deps.stdout.write(
      `${JSON.stringify({ ok: true, data, byteLength: bytes.length, sha256, ...(messageOut ? { messageOut } : {}), next })}\n`,
    )
    return 0
  }
  writeFields(
    ctx.deps,
    "stdout",
    [
      ["Challenge", data.challengeId],
      ["Expires", data.expiresAt],
      ["Bytes", String(bytes.length)],
      ["sha256", sha256],
      ["Written to", messageOut],
    ],
    "Creator challenge (a message, not a transaction)",
  )
  ctx.deps.stdout.write(
    `\nSign exactly these UTF-8 bytes (between the lines, no trailing newline) with the creator wallet:\n-----\n${data.message}\n-----\n`,
  )
  notice(
    ctx.deps,
    "stdout",
    "note",
    `Sign it on your own machine, for example candle sign message --wallet <external> --file ${messageOut ?? "<file holding exactly these bytes>"}, then run: ${next}`,
  )
  return 0
}

// ── section set | restore ──────────────────────────────────────────────────────────────────────

const SECTION_FLAGS = {
  set: { valueFlags: ["--chain", "--file", "--base-revision", "--idempotency-key"], booleanFlags: ["--clear"] },
  restore: { valueFlags: ["--chain", "--version-id", "--base-revision", "--idempotency-key"], booleanFlags: [] },
} as const

export async function tokenSection(args: string[], ctx: CommandContext): Promise<number> {
  const usage = usageFor(ctx, USAGE.section)
  const action = args[0]
  if (action !== "set" && action !== "restore") return usage()
  const spec = SECTION_FLAGS[action]
  const parsed = parseArgs(args.slice(1), {
    valueFlags: [...spec.valueFlags],
    booleanFlags: [...spec.booleanFlags],
    ...(action === "set" ? { pathFlags: ["--file"] } : {}),
  })
  if ("error" in parsed) return usage(parsed.error)
  const { values } = parsed
  const chain = chainOf(values)
  const [address, sectionName] = parsed.positionals
  if (parsed.positionals.length !== 2 || !address) return usage()
  if (!chain) return usage("--chain must be solana or hood.")
  const section = sectionOf(sectionName)
  if (!section) return usage("The section is thesis, tokenomics or lore.")
  const base = values["--base-revision"]
  if (base === undefined || !REVISION.test(base))
    return usage("--base-revision is the section's current revision (0 for a first write), from candle token about.")
  const idempotencyKey = idempotencyKeyOf(values, usage)
  if (typeof idempotencyKey === "number") return idempotencyKey

  let body: Record<string, string>
  let path: string
  let method: "PUT" | "POST"
  if (action === "set") {
    const file = values["--file"]
    if (file === undefined) return usage("--file is required: the section text comes from a file.")
    let bytes: Uint8Array
    try {
      bytes = await ctx.deps.readBytes(file)
    } catch (error) {
      writeLocalFailure(
        ctx.deps,
        {
          code: "FILE_UNREADABLE",
          message: `${file} could not be read: ${error instanceof Error ? error.message : error}.`,
        },
        ctx.json,
      )
      return 2
    }
    const checked = sectionText(bytes, section)
    if ("error" in checked) {
      writeLocalFailure(ctx.deps, { code: "TEXT_REFUSED", message: `${checked.error} Nothing was sent.` }, ctx.json)
      return 2
    }
    const empty = checked.text.trim().length === 0
    if (empty && !parsed.booleans.has("--clear"))
      return usage("The file is empty. An empty write clears the section; pass --clear to mean that.")
    if (!empty && parsed.booleans.has("--clear")) return usage("--clear is for an empty file.")
    body = { text: checked.text, baseRevision: base }
    path = pagePath(chain, address, `/sections/${section}`)
    method = "PUT"
  } else {
    const versionId = values["--version-id"]
    if (versionId === undefined || !UUID.test(versionId))
      return usage("--version-id is a version id from candle token history.")
    body = { versionId, baseRevision: base }
    path = pagePath(chain, address, `/sections/${section}/restore`)
    method = "POST"
  }
  const apiKey = await requireKey(ctx)
  if (!apiKey) return 1

  const result = await write(ctx, { method, path, body, apiKey, idempotencyKey })
  if (result === "unknown") return writeUnknown(ctx, idempotencyKey)
  if (!result.ok) {
    const refusal = refusalOf(result)
    if (refusal?.code === "revision_conflict") {
      const latest = refusal.extra.latest as { revision?: string } | undefined
      writeRefusal(
        ctx,
        refusal,
        `${latest?.revision !== undefined ? `The latest is revision ${latest.revision}. ` : ""}${action === "set" ? SECTION_SUGGESTION : "Rerun with --base-revision set to the latest revision."}`,
      )
      return EXIT_REVISION_CONFLICT
    }
    return writeApiFailure(ctx, result, "key")
  }
  const data = dataOf(result) as { id: string; revision: string }
  if (ctx.json) ctx.deps.stdout.write(`${JSON.stringify({ ok: true, data, idempotencyKey })}\n`)
  else
    writeFields(
      ctx.deps,
      "stdout",
      [
        ["Revision", data.revision],
        ["Version", data.id],
      ],
      action === "set" ? `${section} saved` : `${section} restored as a new version`,
    )
  return 0
}

// ── history ────────────────────────────────────────────────────────────────────────────────────

type HistoryItem = {
  id: string
  revision: string
  text: string | null
  author: Identity
  dev: boolean
  shareBps: string | null
  source: string
  createdAt: string
  restoredFrom: string | null
  tombstone: "hidden" | "removed" | null
}

export async function tokenHistory(args: string[], ctx: CommandContext): Promise<number> {
  const usage = usageFor(ctx, USAGE.history)
  const parsed = parseArgs(args, { valueFlags: ["--chain", "--limit", "--cursor"] })
  if ("error" in parsed) return usage(parsed.error)
  const { values } = parsed
  const chain = chainOf(values)
  const [address, sectionName] = parsed.positionals
  if (parsed.positionals.length !== 2 || !address) return usage()
  if (!chain) return usage("--chain must be solana or hood.")
  const section = sectionOf(sectionName)
  if (!section) return usage("The section is thesis, tokenomics or lore.")
  const limit = values["--limit"]
  if (limit !== undefined && (!/^[1-9]\d?$/.test(limit) || Number(limit) > 50))
    return usage("--limit is a whole number from 1 to 50.")
  const query = new URLSearchParams({
    ...(limit !== undefined ? { limit } : {}),
    ...(values["--cursor"] !== undefined ? { cursor: values["--cursor"] } : {}),
  })
  const result = await read(
    ctx,
    pagePath(chain, address, `/sections/${section}/history${query.size ? `?${query}` : ""}`),
  )
  if (!result.ok) return writeApiFailure(ctx, result, "none")
  const data = dataOf(result) as { items: HistoryItem[]; nextCursor: string | null }
  if (ctx.json) {
    ctx.deps.stdout.write(`${JSON.stringify({ ok: true, data })}\n`)
    return 0
  }
  if (!data.items.length) ctx.deps.stdout.write(`No ${section} versions.\n`)
  for (const item of data.items) {
    writeHeading(ctx.deps, "stdout", `revision ${item.revision}`)
    writeFields(ctx.deps, "stdout", [
      ["Version", item.id],
      ["Written by", `${identity(item.author)}${item.dev ? " (dev)" : ""}`],
      ["Share then", bpsPercent(item.shareBps)],
      ["At", item.createdAt],
      ["Restored from", item.restoredFrom ?? undefined],
      ["State", item.tombstone ?? "visible"],
    ])
    if (item.text !== null) ctx.deps.stdout.write(`\n${terminalTextKeepingLines(item.text)}\n`)
  }
  if (data.nextCursor) ctx.deps.stdout.write(`\nMore: --cursor ${data.nextCursor}\n`)
  return 0
}

// ── flag ───────────────────────────────────────────────────────────────────────────────────────

export async function tokenFlag(args: string[], ctx: CommandContext): Promise<number> {
  const usage = usageFor(ctx, USAGE.flag)
  const parsed = parseArgs(args, { valueFlags: ["--chain", "--content", "--reason", "--detail", "--idempotency-key"] })
  if ("error" in parsed) return usage(parsed.error)
  const { values } = parsed
  const chain = chainOf(values)
  const address = parsed.positionals[0]
  if (parsed.positionals.length !== 1 || !address) return usage()
  if (!chain) return usage("--chain must be solana or hood.")
  const contentId = values["--content"]
  if (contentId === undefined || !UUID.test(contentId))
    return usage("--content is the exact version id being reported (candle token about or history).")
  const reason = values["--reason"]
  if (!reason || !(FLAG_REASONS as readonly string[]).includes(reason))
    return usage(`--reason is one of ${FLAG_REASONS.join(", ")}.`)
  const detail = values["--detail"]
  if (detail !== undefined && [...detail].length > FLAG_DETAIL_LIMIT)
    return usage(`--detail is at most ${FLAG_DETAIL_LIMIT} characters.`)
  const idempotencyKey = idempotencyKeyOf(values, usage)
  if (typeof idempotencyKey === "number") return idempotencyKey
  const apiKey = await requireKey(ctx)
  if (!apiKey) return 1

  const body = { contentId, reason, ...(detail !== undefined ? { detail } : {}) }
  const result = await write(ctx, {
    method: "POST",
    path: pagePath(chain, address, "/flags"),
    body,
    apiKey,
    idempotencyKey,
  })
  if (result === "unknown") return writeUnknown(ctx, idempotencyKey)
  if (!result.ok) return writeApiFailure(ctx, result, "key")
  const data = dataOf(result) as { contentId: string; hidden: boolean }
  if (ctx.json) ctx.deps.stdout.write(`${JSON.stringify({ ok: true, data, idempotencyKey })}\n`)
  else
    writeFields(
      ctx.deps,
      "stdout",
      [
        ["Content", data.contentId],
        ["Hidden", data.hidden ? "yes, pending Candle review" : "no"],
      ],
      "Reported",
    )
  return 0
}
