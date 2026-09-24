/**
 * `candle pnl [--profile <name>] [--json]` (Ember Phase 3 R7, P3-ED-9 and P3-ED-10; BE-316).
 *
 * Two reads, and which one runs is decided by whether `--profile` was typed on THIS invocation:
 *
 * - **No `--profile`: the account's books**, `GET /api/v1/agent/books`. That read is the account's
 *   own `activity` ledger joined to the agent trade rows on (signature, mint, type), so it carries
 *   web-only trades beside CLI and agent fills, each once, and it is the same fill set and replay
 *   the web P&L chart reads (P3-ED-9, BE-264). It is whole-account, so the server admits a Privy
 *   session or a key holding `account:read`, and nothing narrower. The CLI sends the active
 *   profile's key and does not widen `/books` to anything it did not already accept (P3-ED-10).
 * - **`--profile <name>`: that profile's own P&L**, `GET /api/v1/agent/keys/:prefix/pnl`, the
 *   existing per-key route, authenticated as that profile's key and naming that key's prefix. A key
 *   reading its own profile is the narrowest read there is.
 *
 * `--profile` is the CLI's global flag, so `<name>` is a profile on this machine, and a CLI profile
 * holds exactly one agent key: the flag already names the key whose P&L is asked for. `CANDLE_PROFILE`
 * picks the credentials without asking for the per-key read, because it is a standing selection
 * rather than a request made on this line.
 *
 * Both answers carry realized net, fees, unrealized and their total, then open positions with
 * average entry, mark and unrealized. An unpriced position is shown as unpriced and left out of
 * unrealized, never valued at zero, and a truncated history says so.
 *
 * ── LP (E2, BE-323) ──────────────────────────────────────────────────────────────────────────
 *
 * When the API serves LP (`LP_ENABLED`) either answer carries an `lp` section beside the token
 * figures, computed server-side from the same `activity` ledger (the rows LP `/confirm` wrote)
 * and the LP routes' pool read: realized (withdrawals against the cost basis at the add, plus
 * claimed fees), unrealized (open positions at their share of the pool plus unclaimed fees, at
 * current marks, against that basis), and vs holding (what the deposited tokens would be worth
 * held). The total then covers tokens and LP. A position that is unpriced, unreadable, or closed
 * outside the ledger (a sweep close writes no confirmation) is shown as such and never valued.
 * Without an `lp` section the output is exactly what it was.
 */
import { parseArgs } from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveApiKey } from "../deps"
import { apiKeyPrefix, printIdentity } from "../profiles"
import { renderTable, terminalText, writeFailure, writeLocalFailure, writeUsageFailure } from "../render"
import { formatPrice, formatQuantity, formatUsd, shortAddress } from "../usd"

interface Position {
  mint: string
  symbol?: string | null
  book?: string | null
  quantity: number
  avgEntryUsd: number
  costBasisUsd: number
  markPriceUsd?: number
  marketValueUsd?: number
  unrealizedUsd?: number
}

interface Summary {
  realizedNetUsd: number
  realizedGrossUsd: number
  feesUsd: number
  unrealizedUsd: number
  unmarked: number
  unvalued: number
  unresolved?: number
  counted: number
}

interface LpPosition {
  position: string
  pool: string
  wallet: string
  book: string | null
  status: "valued" | "unpriced" | "unreadable" | "closed-outside-ledger"
  costBasisUsd: number
  claimedFeesUsd: number
  realizedUsd: number
  valueUsd?: number
  unrealizedUsd?: number
  holdValueUsd?: number
  vsHoldingUsd?: number
}

/** The LP section of either answer, when the API serves LP (BE-323). */
type LpSection =
  | {
      read: true
      realizedUsd: number
      withdrawnUsd: number
      realizedBasisUsd: number
      claimedFeesUsd: number
      unrealizedUsd: number
      valueUsd: number
      costBasisUsd: number
      holdValueUsd: number
      vsHoldingUsd: number
      vsHoldingPositions: number
      openPositions: number
      valued: number
      unpriced: number
      unreadable: number
      closedOutsideLedger: number
      closedPositions: number
      unvalued: number
      basisIncomplete: number
      complete: boolean
      lookback: number
      truncated: boolean
      positions: LpPosition[]
    }
  | { read: false; reason: string }

interface BooksBody {
  all: Summary & { totalUsd: number }
  positions: Position[]
  lookback: number
  truncated: boolean
  oldestMarkAt?: number
  lp?: LpSection
}

interface ProfileBody {
  keyPrefix: string
  pnl: {
    realizedNetUsd: number
    realizedGrossUsd: number
    feesUsd: number
    unrealizedUsd: number
    unmarkedPositions: number
    unvalued: number
    counted: number
    openPositions: Position[]
    lookback: number
    truncated: boolean
    oldestMarkAt?: number
  }
  lp?: LpSection
}

const NO_API_KEY = {
  code: "NO_API_KEY",
  message: "No API key for this profile.",
  suggestion: "Set CANDLE_API_KEY, or run `candle auth login` to store one.",
}

export async function pnl(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, {})
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}. Usage: candle pnl [--profile <name>]`, json)
    return 2
  }

  const apiKey = await resolveApiKey(deps, ctx.profile)
  if (!apiKey) {
    writeLocalFailure(deps, NO_API_KEY, json)
    return 1
  }

  const perProfile = ctx.profileFlag !== undefined
  let keyPrefix: string | undefined
  if (perProfile) {
    keyPrefix = apiKeyPrefix(apiKey)
    if (keyPrefix === undefined) {
      writeLocalFailure(
        deps,
        {
          code: "BAD_REQUEST",
          message: `The API key for profile ${ctx.profileFlag} is not a Candle agent key, so it names no profile to read.`,
          suggestion: "Run `candle auth login --profile <name>` to store a key for that profile.",
        },
        json,
      )
      return 1
    }
  }

  await printIdentity(ctx)
  const path = perProfile ? `/api/v1/agent/keys/${encodeURIComponent(keyPrefix as string)}/pnl` : "/api/v1/agent/books"
  const result = await apiRequest(path, {
    auth: "key",
    credentials: { apiKey },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
  })
  if (!result.ok) {
    if (!perProfile && result.code === "SCOPE_MISSING") {
      writeLocalFailure(
        deps,
        {
          code: "SCOPE_MISSING",
          message: "The account's P&L needs a key with the Read scope (account:read); this profile's key has none.",
          suggestion: "Log in with a Read or Read:Write key, or read this key's own P&L: candle pnl --profile <name>",
        },
        json,
      )
      return 1
    }
    writeFailure(deps, result, { apiUrl, authType: "key" }, json)
    return 1
  }

  const body = result.body as Record<string, unknown>
  if (json) {
    const { success: _success, ...rest } = body
    deps.stdout.write(`${JSON.stringify({ ok: true, scope: perProfile ? "profile" : "account", ...rest })}\n`)
    return 0
  }

  if (perProfile) {
    const { pnl: p, lp } = body as unknown as ProfileBody
    deps.stdout.write(`P&L for profile ${ctx.profileFlag} (key ${keyPrefix}): this key's own fills\n\n`)
    writeSummary(ctx, {
      realizedNetUsd: p.realizedNetUsd,
      realizedGrossUsd: p.realizedGrossUsd,
      feesUsd: p.feesUsd,
      unrealizedUsd: p.unrealizedUsd,
      unmarked: p.unmarkedPositions,
      unvalued: p.unvalued,
      counted: p.counted,
      positions: p.openPositions.length,
      truncated: p.truncated,
      lookback: p.lookback,
      lookbackUnit: "trades",
      oldestMarkAt: p.oldestMarkAt,
      lp,
    })
    writePositions(ctx, p.openPositions, false)
    writeLpPositions(ctx, lp, false)
    return 0
  }

  const books = body as unknown as BooksBody
  deps.stdout.write("P&L for the account: every profile, the web app and the CLI, one ledger\n\n")
  writeSummary(ctx, {
    ...books.all,
    positions: books.positions.length,
    truncated: books.truncated,
    lookback: books.lookback,
    lookbackUnit: "ledger rows",
    oldestMarkAt: books.oldestMarkAt,
    lp: books.lp,
  })
  writePositions(ctx, books.positions, true)
  writeLpPositions(ctx, books.lp, true)
  return 0
}

function writeSummary(
  ctx: CommandContext,
  s: Summary & {
    positions: number
    truncated: boolean
    lookback: number
    lookbackUnit: string
    oldestMarkAt?: number
    lp?: LpSection
  },
): void {
  const marked = s.positions - s.unmarked
  const lines = [
    [
      "Realized net",
      formatUsd(s.realizedNetUsd),
      `gross ${formatUsd(s.realizedGrossUsd)}, fees ${formatUsd(s.feesUsd)}`,
    ],
    [
      "Unrealized",
      formatUsd(s.unrealizedUsd),
      `${marked} of ${s.positions} open ${s.positions === 1 ? "position" : "positions"} marked${s.unmarked > 0 ? `; ${s.unmarked} unpriced, not counted` : ""}`,
    ],
  ]
  const lp = s.lp
  if (lp?.read) {
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
    lines.push(
      [
        "LP realized",
        formatUsd(lp.realizedUsd),
        `withdrawn ${formatUsd(lp.withdrawnUsd)} against ${formatUsd(lp.realizedBasisUsd)} of cost basis, plus ${formatUsd(lp.claimedFeesUsd)} claimed fees`,
      ],
      [
        "LP unrealized",
        formatUsd(lp.unrealizedUsd),
        `${lp.valued} of ${plural(lp.openPositions, "open LP position", "open LP positions")} valued${lp.unpriced > 0 ? `; ${lp.unpriced} unpriced, not counted` : ""}${lp.unreadable > 0 ? `; ${lp.unreadable} not read, not counted` : ""}${lp.closedOutsideLedger > 0 ? `; ${lp.closedOutsideLedger} closed outside the ledger, not counted` : ""}`,
      ],
      [
        "LP vs holding",
        lp.vsHoldingPositions > 0 ? formatUsd(lp.vsHoldingUsd) : "-",
        lp.vsHoldingPositions > 0
          ? `${lp.vsHoldingPositions} of ${lp.valued} valued, against holding the deposited tokens (now ${formatUsd(lp.holdValueUsd)})`
          : "no valued LP position with every deposit priced",
      ],
      [
        "Total",
        formatUsd(s.realizedNetUsd + s.unrealizedUsd + lp.realizedUsd + lp.unrealizedUsd),
        "realized net plus unrealized, tokens and LP",
      ],
    )
  } else if (lp) {
    lines.push(
      ["LP", "not read", `${terminalText(lp.reason)}; not in the total`],
      ["Total", formatUsd(s.realizedNetUsd + s.unrealizedUsd), "realized net plus unrealized, tokens only"],
    )
  } else {
    lines.push(["Total", formatUsd(s.realizedNetUsd + s.unrealizedUsd), "realized net plus unrealized"])
  }
  const width = Math.max(...lines.map(([label]) => (label as string).length))
  const valueWidth = Math.max(...lines.map(([, value]) => (value as string).length))
  for (const [label, value, note] of lines) {
    ctx.deps.stdout.write(`${(label as string).padEnd(width)}  ${(value as string).padStart(valueWidth)}  (${note})\n`)
  }
  if (s.oldestMarkAt !== undefined) {
    ctx.deps.stdout.write(`Marks as old as ${new Date(s.oldestMarkAt).toISOString()}.\n`)
  }
  if (s.unvalued > 0 || (s.unresolved ?? 0) > 0) {
    ctx.deps.stdout.write(
      `${s.unvalued} ${s.unvalued === 1 ? "fill" : "fills"} could not be valued and are not in these figures.\n`,
    )
  }
  if (s.truncated) {
    ctx.deps.stdout.write(
      `History is truncated: this covers the most recent ${s.lookback} ${s.lookbackUnit}, not the account's lifetime.\n`,
    )
  }
  if (lp?.read) {
    if (lp.unvalued > 0) {
      ctx.deps.stdout.write(
        `${lp.unvalued} LP ledger ${lp.unvalued === 1 ? "leg" : "legs"} could not be valued and ${lp.unvalued === 1 ? "is" : "are"} not in these figures.\n`,
      )
    }
    if (lp.closedOutsideLedger > 0) {
      ctx.deps.stdout.write(
        `${lp.closedOutsideLedger} LP ${lp.closedOutsideLedger === 1 ? "position was" : "positions were"} closed outside the ledger (a sweep close writes no confirmation), so ${lp.closedOutsideLedger === 1 ? "its" : "their"} result is unknown and not in these figures.\n`,
      )
    }
    if (lp.truncated) {
      ctx.deps.stdout.write(
        `LP history is truncated: this covers the most recent ${lp.lookback} LP operations, not the account's lifetime.\n`,
      )
    }
  }
}

function writeLpPositions(ctx: CommandContext, lp: LpSection | undefined, withBook: boolean): void {
  if (!lp?.read || lp.positions.length === 0) return
  const headers = ["POSITION", "POOL", "WALLET", "VALUE", "COST BASIS", "UNREALIZED", "VS HOLDING"]
  if (withBook) headers.push("BOOK")
  const value = (p: LpPosition) =>
    p.status === "valued" && p.valueUsd !== undefined
      ? formatUsd(p.valueUsd)
      : p.status === "unpriced"
        ? "unpriced"
        : p.status === "unreadable"
          ? "not read"
          : "closed outside the ledger"
  const rows = lp.positions.map((p) => {
    const row = [
      shortAddress(p.position),
      shortAddress(p.pool),
      shortAddress(p.wallet),
      value(p),
      formatUsd(p.costBasisUsd),
      p.unrealizedUsd !== undefined ? formatUsd(p.unrealizedUsd) : "-",
      p.vsHoldingUsd !== undefined ? formatUsd(p.vsHoldingUsd) : "-",
    ]
    if (withBook) row.push(p.book ?? "-")
    return row
  })
  ctx.deps.stdout.write(
    `\nOpen LP positions\n${renderTable(
      headers,
      rows.map((row) => row.map(terminalText)),
    )}\n`,
  )
}

function writePositions(ctx: CommandContext, positions: Position[], withBook: boolean): void {
  if (positions.length === 0) {
    ctx.deps.stdout.write("\nNo open positions.\n")
    return
  }
  const headers = ["TOKEN", "QUANTITY", "AVG ENTRY", "MARK", "UNREALIZED"]
  if (withBook) headers.push("BOOK")
  const rows = positions.map((p) => {
    const row = [
      p.symbol?.trim() || shortAddress(p.mint),
      formatQuantity(p.quantity),
      formatPrice(p.avgEntryUsd),
      p.markPriceUsd !== undefined ? formatPrice(p.markPriceUsd) : "unpriced",
      p.unrealizedUsd !== undefined ? formatUsd(p.unrealizedUsd) : "-",
    ]
    if (withBook) row.push(p.book ?? "-")
    return row
  })
  ctx.deps.stdout.write(
    `\nOpen positions\n${renderTable(
      headers,
      rows.map((row) => row.map(terminalText)),
    )}\n`,
  )
}
