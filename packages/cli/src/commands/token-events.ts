/**
 * `candle token events <mint>` (BE-2095, design 6.6): the per-token event list behind
 * `GET /api/v1/tokens/:chain/:mint/events` (BE-2094) as one line per event -- time, kind, name or
 * short address, action, size. Needs no key; a configured key selects wallet address/group
 * visibility for its tier. `--kind` filters the fetched page here because the route has no kind
 * parameter: a filtered page still reports the route's `nextCursor`, so `--before` continues the
 * same mixed page whatever the filter.
 */
import { parseArgs } from "../args"
import { type ApiResult, apiRequest } from "../client"
import { type CommandContext, resolveApiKey } from "../deps"
import { writeFields } from "../human-output"
import { formatTime, writeFailure, writeUsageFailure } from "../render"
import { formatPrice, formatUsd, shortAddress } from "../usd"

const KINDS = ["trade", "signal", "callout"] as const
type EventKind = (typeof KINDS)[number]

type EventsWallet = {
  /** Display text (first4…last4) on free/keyless reads, full on Pro/Max. */
  address: string
  name: string | null
  walletKind: "dev" | "kol" | "smart" | "agent" | "tracked"
}

type TokenEventRow = {
  id: string
  at: number
  kind: EventKind
  wallet: EventsWallet | null
} & (
  | {
      kind: "trade"
      side: "buy" | "sell"
      usd: number | null
      tokenAmount: number
      priceUsd: number | null
      result?: "W" | "L" | null
    }
  | { kind: "signal"; pattern: string; summary: string }
  | {
      kind: "callout"
      caller: { handle: string | null; name: string | null; rank: number | null }
      size: number | null
      marketCapUsd: number | null
    }
)

type EventsBody = { success: true; events: TokenEventRow[]; nextCursor: string | null }

const USAGE =
  "Usage: candle token events <mint> [--chain solana|hood] [--kind trade|signal|callout] [--since <iso-8601>] [--limit <n>] [--before <cursor>] [--json]"

/** Reads an answer that parses as events, or a screen-readable refusal. */
function readEventsBody(body: unknown): EventsBody | null {
  if (body === null || typeof body !== "object" || !Array.isArray((body as EventsBody).events)) return null
  const typed = body as EventsBody
  const cursor: unknown = typed.nextCursor
  return typed.success === true && (cursor === null || typeof cursor === "string") ? typed : null
}

function who(event: TokenEventRow): string {
  if (event.kind === "callout") {
    const caller = event.caller.handle ?? event.caller.name ?? "unknown"
    return event.caller.rank === null ? caller : `${caller} (rank ${event.caller.rank})`
  }
  const wallet = event.wallet
  if (!wallet) return "unattributed"
  return `${wallet.name ?? shortAddress(wallet.address)} (${wallet.walletKind})`
}

function action(event: TokenEventRow): { doing: string; detail: string } {
  switch (event.kind) {
    case "trade": {
      const doing = event.side === "buy" ? "bought" : "sold"
      const size = event.usd === null ? "size not known" : formatUsd(event.usd)
      const at = event.priceUsd === null || event.priceUsd === undefined ? "" : ` at ${formatPrice(event.priceUsd)}`
      const outcome = event.side === "sell" && event.result ? `, ${event.result}` : ""
      return { doing, detail: `${size}${at}${outcome}` }
    }
    case "signal":
      return { doing: event.pattern, detail: event.summary }
    case "callout": {
      const size = event.size === null ? "size not known" : formatUsd(event.size)
      const cap =
        event.marketCapUsd === null || event.marketCapUsd === undefined
          ? ""
          : ` at ${formatUsd(event.marketCapUsd, { compact: true })} MC`
      return { doing: "called out", detail: `${size}${cap}` }
    }
  }
}

function eventLine(event: TokenEventRow, widths: { time: number; kind: number; who: number }): string {
  const { doing, detail } = action(event)
  return [
    formatTime(event.at).padEnd(widths.time),
    event.kind.padEnd(widths.kind),
    who(event).padEnd(widths.who),
    doing,
    detail,
  ]
    .filter((cell) => cell.trim().length > 0)
    .join("  ")
    .trimEnd()
}

export async function tokenEvents(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--chain", "--kind", "--since", "--limit", "--before"] })
  if ("error" in parsed) {
    writeUsageFailure(ctx.deps, parsed.error, ctx.json)
    return 2
  }
  const chain = parsed.values["--chain"] ?? "solana"
  const kind = parsed.values["--kind"]
  const limit = parsed.values["--limit"]
  const since = parsed.values["--since"]
  const before = parsed.values["--before"]
  if (parsed.positionals.length !== 1 || (chain !== "solana" && chain !== "hood")) {
    writeUsageFailure(ctx.deps, USAGE, ctx.json)
    return 2
  }
  if (kind !== undefined && !KINDS.includes(kind as EventKind)) {
    writeUsageFailure(ctx.deps, USAGE, ctx.json)
    return 2
  }
  if ((limit !== undefined && !/^[1-9][0-9]{0,3}$/.test(limit)) || Number(limit) > 1000) {
    writeUsageFailure(ctx.deps, "Usage: --limit is an integer from 1 to 1000", ctx.json)
    return 2
  }
  if (since !== undefined && !Number.isFinite(Date.parse(since))) {
    writeUsageFailure(ctx.deps, "Usage: --since is an ISO 8601 time, e.g. 2026-10-28T00:00:00Z", ctx.json)
    return 2
  }
  const mint = parsed.positionals[0] as string

  const query = new URLSearchParams()
  if (limit !== undefined) query.set("limit", limit)
  if (since !== undefined) query.set("since", since)
  if (before !== undefined) query.set("before", before)
  const search = query.toString()
  const apiKey = await resolveApiKey(ctx.deps, ctx.profile)
  const result: ApiResult = await apiRequest(
    `/api/v1/tokens/${chain}/${encodeURIComponent(mint)}/events${search ? `?${search}` : ""}`,
    {
      apiUrl: ctx.apiUrl,
      auth: apiKey ? "key" : "none",
      credentials: apiKey ? { apiKey } : {},
      env: ctx.deps.env,
      fetch: ctx.deps.fetch,
    },
  )
  if (!result.ok) {
    writeFailure(ctx.deps, result, { apiUrl: ctx.apiUrl, authType: apiKey ? "key" : "none" }, ctx.json)
    return 1
  }
  const body = readEventsBody(result.body)
  if (!body) {
    writeFailure(
      ctx.deps,
      {
        ok: false,
        status: result.status,
        code: "BAD_RESPONSE",
        message: "The events answer was not readable.",
        raw: result.body,
      },
      { apiUrl: ctx.apiUrl, authType: apiKey ? "key" : "none" },
      ctx.json,
    )
    return 1
  }
  const events = kind === undefined ? body.events : body.events.filter((event) => event.kind === kind)
  if (ctx.json) {
    ctx.deps.stdout.write(`${JSON.stringify({ ok: true, data: { events, nextCursor: body.nextCursor } })}\n`)
    return 0
  }
  const out = ctx.deps.stdout
  writeFields(ctx.deps, "stdout", [
    ["Token", mint],
    ["Chain", chain],
    ["Events", `${events.length}${kind !== undefined ? ` (${kind} only)` : ""}`],
  ])
  if (events.length === 0) out.write("No events on this page.\n")
  else {
    const widths = {
      time: Math.max(...events.map((event) => formatTime(event.at).length)),
      kind: Math.max(...events.map((event) => event.kind.length)),
      who: Math.max(...events.map((event) => who(event).length)),
    }
    for (const event of events) out.write(`${eventLine(event, widths)}\n`)
  }
  if (body.nextCursor !== null) writeFields(ctx.deps, "stdout", [["Next page", `--before ${body.nextCursor}`]])
  return 0
}
