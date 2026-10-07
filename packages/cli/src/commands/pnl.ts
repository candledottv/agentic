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
 *
 * ── Both chains (Ember Phase 4d, 4d-ED-8 to 4d-ED-10) ────────────────────────────────────────
 *
 * Each answer splits its figures by chain, and the table says which chain each row is on:
 *
 * - **Account scope** reads `/books`' `solana` and `hood` summaries: a block for each, then the
 *   combined figure (`all`) with LP, as before. Positions carry `chain`, shown in a CHAIN column.
 * - **Key scope** reads `pnlByKey`'s `byChain` pair the same way, and its `byWallet` rows become a
 *   by-wallet table with a CHAIN column.
 *
 * An answer without the split (an older API) prints exactly what it did, with `-` for a chain it
 * did not name. A 4c bridge is not a trade: it opens no lot and realizes nothing, so it moves value
 * between chains in `candle portfolio` and changes nothing here; bridge and Relay costs are not
 * netted from these figures. `--json` passes the API's body through, chain fields included.
 *
 * ── One engine (P&L spec 2026-10-02, R4, rollout A4) ─────────────────────────────────────────
 *
 * Since A2 both reads are slices of the account's one P&L run, the same run the console reads, so
 * this command prints the console's figures to the cent for the same moment:
 *
 * - **Total** is the server's `totalUsd` (realized net plus unrealized), the console's Total. An
 *   older API that sends no `totalUsd` gets the sum computed here, as before. LP is not in the
 *   console's Total, so with an `lp` section the token Total stays as it is and a separate "Total
 *   with LP" line adds LP.
 * - **Positions live in wallets** (PNL-ED-2), so one token held in two wallets is two rows, and a
 *   WALLET column appears when the API names the wallet. A position worth under one cent is
 *   marked dust and still listed (PNL-AD-7, PNL-ED-9).
 * - **Closed positions** (PNL-ED-8): money made, minus money lost, plus partial sells, equals
 *   realized net, from the server's `closed` summary.
 * - **Account scope** adds the "By agent" table (`byAgent`: every key, then Manual, with an
 *   account total that matches the rows), and the counts of `costUnknown` and `movedOutUntracked`.
 * - **Key scope** is the key's share of the account (PNL-ED-6): realized on the sales it made, and
 *   the open positions that belong to it (the wallet's bound key, else the key whose buy opened
 *   them). The by-wallet rows sum to the total, and the history bound is the account's activity
 *   rows, not 500 of the key's trades. An older API (no `totalUsd` on `pnl`) keeps the old wording,
 *   because its figures still mean the old thing.
 */

import { parseArgs } from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveApiKey } from "../deps"
import type { HyperliquidPnlSection } from "../hyperliquid-pnl"
import { apiKeyPrefix, printIdentity } from "../profiles"
import { renderTable, terminalText, writeFailure, writeLocalFailure, writeUsageFailure } from "../render"
import { formatPrice, formatQuantity, formatUsd, shortAddress } from "../usd"
import { writeHyperliquidPnl } from "./pnl-hyperliquid"

type Chain = "solana" | "hood"
const CHAINS: readonly Chain[] = ["solana", "hood"]
const CHAIN_TITLES: Record<Chain, string> = { solana: "Solana", hood: "Hood" }

interface Position {
  /** Additive transfer provenance; omitted by an older server or for a position bought by trade. */
  transferredIn?: boolean
  basisSource?: "candle-wallet" | "chain" | "transfer-price" | "before-window" | "unknown" | "pending" | "mixed"
  basisComplete?: boolean
  movedInFromWallet?: string
  basisCoveragePct?: number

  mint: string
  /** The chain the position was traded on (4d-ED-1). Absent from an API that predates 4d. */
  chain?: Chain
  symbol?: string | null
  book?: string | null
  quantity: number
  avgEntryUsd: number
  costBasisUsd: number
  markPriceUsd?: number
  marketValueUsd?: number
  unrealizedUsd?: number
  /**
   * The wallet holding it (PNL-ED-2). `/books` omits it for a leg no record places in a wallet;
   * `/keys/{prefix}/pnl` names that pool `unknown:<chain>`. Absent from an API that predates A2.
   */
  wallet?: string
  /** Worth under one cent at its mark (PNL-ED-9): still listed, and marked. */
  dust?: true
}

/** Closed positions as money made, minus money lost, plus partial sells (PNL-ED-8). */
interface ClosedSummary {
  closed: number
  madeUsd: number
  lostUsd: number
  partialSellsUsd: number
  wins: number
  losses: number
  costUnknown: number
}

/** Fields A2 added to every scope. Each is absent from an API that predates it. */
interface EngineFields {
  /** Realized net plus unrealized: the console's Total. */
  totalUsd?: number
  openPositionsExDust?: number
  closed?: ClosedSummary
}

interface Summary extends EngineFields {
  /** Closed positions in this scope. Absent from an API older than 2026-09-21. */
  closedRounds?: number
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

/** One chain's share of either answer, without the position list (4d-ED-8, 4d-ED-9). */
interface ChainSummary extends EngineFields {
  realizedNetUsd: number
  realizedGrossUsd: number
  feesUsd: number
  unrealizedUsd: number
  /** Open positions on this chain: a count in both answers. */
  openPositions: number
  /** `/books` names it `unmarked`, `pnlByKey` names it `unmarkedPositions`. */
  unmarked?: number
  unmarkedPositions?: number
  unvalued: number
}

/** One wallet's share of a profile's P&L (`pnlByKey.byWallet`, 4d-ED-9). */
interface WalletRow extends EngineFields {
  wallet: string
  payerType: "main" | "linked"
  chain?: Chain
  label?: string | null
  realizedNetUsd: number
  unrealizedUsd: number
  unmarkedPositions: number
  openPositions: Position[]
  tradesConsidered: number
}

/** One row of the "By agent" split (`byAgent`): a key, or Manual when `keyPrefix` is null. */
interface AgentRow {
  keyPrefix: string | null
  label: string | null
  realizedNetUsd: number
  unrealizedUsd: number
  totalUsd: number
  openPositions: number
  closedRounds: number
  unmarked: number
}

interface BooksBody {
  all: Summary & { totalUsd: number; openPositions: number }
  solana?: ChainSummary
  hood?: ChainSummary
  positions: Position[]
  /** Every key with anything on the account, then Manual; sums to `all` (PNL-ED-6). */
  byAgent?: AgentRow[]
  /** Tokens that arrived with no cost anyone can state (PNL-ED-4). */
  costUnknown?: unknown[]
  /** Tokens that left a wallet for somewhere Candle does not follow, at cost (PNL-ED-5). */
  movedOutUntracked?: unknown[]
  lookback: number
  truncated: boolean
  oldestMarkAt?: number
  lp?: LpSection
}

interface ProfileBody {
  hyperliquid?: HyperliquidPnlSection
  keyPrefix: string
  pnl: EngineFields & {
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
    byChain?: Partial<Record<Chain, ChainSummary>>
    byWallet?: WalletRow[]
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
          suggestion: "Log in with a Read or Write key, or read this key's own P&L: candle pnl --profile <name>",
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
    const { pnl: p, lp, hyperliquid } = body as unknown as ProfileBody
    // A2's engine sends `totalUsd` on every key scope; an older API does not, and its figures still
    // mean the old thing (one pool across the key's wallets, its last 500 trades).
    const engine = typeof p.totalUsd === "number"
    deps.stdout.write(
      engine
        ? `P&L for profile ${ctx.profileFlag} (key ${keyPrefix}): this key's share of the account's P&L\n\n`
        : `P&L for profile ${ctx.profileFlag} (key ${keyPrefix}): this key's own fills\n\n`,
    )
    writeChainBlocks(ctx, p.byChain)
    writeSummary(ctx, {
      realizedNetUsd: p.realizedNetUsd,
      realizedGrossUsd: p.realizedGrossUsd,
      feesUsd: p.feesUsd,
      unrealizedUsd: p.unrealizedUsd,
      unmarked: p.unmarkedPositions,
      unvalued: p.unvalued,
      counted: p.counted,
      totalUsd: p.totalUsd,
      openPositionsExDust: p.openPositionsExDust,
      closed: p.closed,
      positions: p.openPositions.length,
      truncated: p.truncated,
      lookback: p.lookback,
      lookbackUnit: engine ? "of the account's ledger rows" : "trades",
      oldestMarkAt: p.oldestMarkAt,
      lp,
    })
    writePositions(ctx, p.openPositions, false)
    writeWallets(ctx, p.byWallet, engine)
    writeLpPositions(ctx, lp, false)
    writeHyperliquidPnl(ctx, hyperliquid)
    return 0
  }

  const books = body as unknown as BooksBody
  deps.stdout.write("P&L for the account: every profile, the web app and the CLI, one ledger\n\n")
  writeChainBlocks(ctx, { solana: books.solana, hood: books.hood })
  writeSummary(ctx, {
    ...books.all,
    positions: books.positions.length,
    truncated: books.truncated,
    lookback: books.lookback,
    lookbackUnit: "ledger rows",
    oldestMarkAt: books.oldestMarkAt,
    lp: books.lp,
  })
  writeWalletEvents(ctx, books)
  writeAgents(ctx, books.byAgent, books.all)
  writePositions(ctx, books.positions, true)
  writeLpPositions(ctx, books.lp, true)
  return 0
}

/** A summary carries real figures, not an empty placeholder some older answers send. */
function isChainSummary(value: unknown): value is ChainSummary {
  return typeof value === "object" && value !== null && typeof (value as ChainSummary).realizedNetUsd === "number"
}

/**
 * One block per chain, then a heading for the combined figure that follows (4d-ED-8, 4d-ED-9).
 * Nothing when the answer does not split by chain: an older API reads exactly as it did.
 */
function writeChainBlocks(ctx: CommandContext, byChain: Partial<Record<Chain, unknown>> | undefined): void {
  const blocks = CHAINS.flatMap((chain) => {
    const summary = byChain?.[chain]
    return isChainSummary(summary) ? [[chain, summary] as const] : []
  })
  if (blocks.length === 0) return
  for (const [chain, s] of blocks) {
    const unmarked = s.unmarked ?? s.unmarkedPositions ?? 0
    const marked = s.openPositions - unmarked
    ctx.deps.stdout.write(`${CHAIN_TITLES[chain]}\n`)
    writeLines(ctx, [
      [
        "Realized net",
        formatUsd(s.realizedNetUsd),
        `gross ${formatUsd(s.realizedGrossUsd)}, fees ${formatUsd(s.feesUsd)}`,
      ],
      [
        "Unrealized",
        formatUsd(s.unrealizedUsd),
        `${marked} of ${s.openPositions} open ${s.openPositions === 1 ? "position" : "positions"} marked${unmarked > 0 ? `; ${unmarked} unpriced, not counted` : ""}`,
      ],
      ["Total", formatUsd(totalOf(s)), "realized net plus unrealized"],
    ])
    if (s.unvalued > 0) {
      ctx.deps.stdout.write(
        `${s.unvalued} ${s.unvalued === 1 ? "fill" : "fills"} could not be valued and are not in these figures.\n`,
      )
    }
    ctx.deps.stdout.write("\n")
  }
  ctx.deps.stdout.write("All chains\n")
}

/** The server's `totalUsd`, the console's Total; summed here only for an API that sends none. */
function totalOf(s: { realizedNetUsd: number; unrealizedUsd: number; totalUsd?: number }): number {
  return typeof s.totalUsd === "number" ? s.totalUsd : s.realizedNetUsd + s.unrealizedUsd
}

/** The pool `/keys/{prefix}/pnl` names for legs no record places in a wallet: not an address. */
function isUnplacedWallet(wallet: string): boolean {
  return wallet.startsWith("unknown:")
}

function writeLines(ctx: CommandContext, lines: string[][]): void {
  const width = Math.max(...lines.map(([label]) => (label as string).length))
  const valueWidth = Math.max(...lines.map(([, value]) => (value as string).length))
  for (const [label, value, note] of lines) {
    ctx.deps.stdout.write(`${(label as string).padEnd(width)}  ${(value as string).padStart(valueWidth)}  (${note})\n`)
  }
}

/**
 * Key scope's by-wallet rows (#1501), with the chain each wallet is on (4d-ED-9). Each row is that
 * wallet's own average-cost pool. Since A2 the key's total is the sum of its wallets, so the rows
 * add up to it; an older API pooled the key's wallets, and its rows need not.
 */
function writeWallets(ctx: CommandContext, wallets: WalletRow[] | undefined, engine: boolean): void {
  if (!wallets || wallets.length === 0) return
  const rows = wallets.map((w) => [
    isUnplacedWallet(w.wallet)
      ? "not placed in a wallet"
      : `${w.label?.trim() ? `${w.label.trim()} ` : w.payerType === "main" ? "main " : ""}(${shortAddress(w.wallet)})`,
    w.chain ?? "-",
    String(w.tradesConsidered),
    formatUsd(w.realizedNetUsd),
    formatUsd(w.unrealizedUsd),
    `${w.openPositions.length}${w.unmarkedPositions > 0 ? ` (${w.unmarkedPositions} unpriced)` : ""}`,
  ])
  const heading = engine
    ? "By wallet (each its own cost basis; the rows sum to the total)"
    : "By wallet (each its own cost basis, so the rows need not sum to the total)"
  ctx.deps.stdout.write(
    `\n${heading}\n${renderTable(
      ["WALLET", "CHAIN", "TRADES", "REALIZED NET", "UNREALIZED", "OPEN"],
      rows.map((row) => row.map(terminalText)),
    )}\n`,
  )
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
  const total = totalOf(s)
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
      ["Total", formatUsd(total), "realized net plus unrealized, tokens only, as the console shows it"],
      [
        "Total with LP",
        formatUsd(total + lp.realizedUsd + lp.unrealizedUsd),
        "the total plus LP realized and unrealized",
      ],
    )
  } else if (lp) {
    lines.push(
      ["LP", "not read", `${terminalText(lp.reason)}; not in the total`],
      ["Total", formatUsd(total), "realized net plus unrealized, tokens only"],
    )
  } else {
    lines.push(["Total", formatUsd(total), "realized net plus unrealized"])
  }
  writeLines(ctx, lines)
  if (s.closed) writeClosed(ctx, s.closed)
  const dust = s.openPositionsExDust !== undefined ? s.positions - s.openPositionsExDust : 0
  if (dust > 0) {
    ctx.deps.stdout.write(
      `${dust} open ${dust === 1 ? "position is" : "positions are"} dust (worth under one cent): listed and marked, and counted in the figures.\n`,
    )
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

/**
 * The closed-position equation (PNL-ED-8): money made, minus money lost, plus partial sells, is
 * the realized net. `lostUsd` is zero or negative, so the three figures add up as printed.
 */
function writeClosed(ctx: CommandContext, c: ClosedSummary): void {
  const counts = [`${c.wins} won`, `${c.losses} lost`]
  if (c.costUnknown > 0) counts.push(`${c.costUnknown} with unknown cost`)
  ctx.deps.stdout.write(
    `Closed: ${c.closed} ${c.closed === 1 ? "position" : "positions"} (${counts.join(", ")}). Money made ${formatUsd(c.madeUsd)}, money lost ${formatUsd(c.lostUsd)} and partial sells ${formatUsd(c.partialSellsUsd)} add up to the realized net.\n`,
  )
}

/** Account scope: tokens with no cost anyone can state, and moves Candle does not follow. */
function writeWalletEvents(ctx: CommandContext, books: BooksBody): void {
  const unknown = books.costUnknown?.length ?? 0
  if (unknown > 0) {
    ctx.deps.stdout.write(
      `${unknown} ${unknown === 1 ? "arrival" : "arrivals"} of tokens came with no cost anyone can state: selling them realizes nothing (--json lists them).\n`,
    )
  }
  const out = books.movedOutUntracked?.length ?? 0
  if (out > 0) {
    ctx.deps.stdout.write(
      `${out} ${out === 1 ? "move" : "moves"} out of a wallet went where Candle does not follow: the tokens left at cost, not as a sale (--json lists them).\n`,
    )
  }
}

/**
 * Account scope's "By agent" table (PNL-AD-6, PNL-ED-6): every key with anything on the account,
 * then Manual (web-app trades), then the account total. The rows partition the account, so they
 * sum to the total row, which is the summary's figure.
 */
function writeAgents(ctx: CommandContext, agents: AgentRow[] | undefined, all: BooksBody["all"]): void {
  if (!agents || agents.length === 0) return
  const open = (count: number, unmarked: number) => `${count}${unmarked > 0 ? ` (${unmarked} unpriced)` : ""}`
  const rows = agents.map((a) => [
    a.keyPrefix === null
      ? "Manual (web app)"
      : a.label && a.label !== a.keyPrefix
        ? `${a.label} (${a.keyPrefix})`
        : a.keyPrefix,
    formatUsd(a.realizedNetUsd),
    formatUsd(a.unrealizedUsd),
    formatUsd(totalOf(a)),
    open(a.openPositions, a.unmarked),
    String(a.closedRounds),
  ])
  rows.push([
    "Account total",
    formatUsd(all.realizedNetUsd),
    formatUsd(all.unrealizedUsd),
    formatUsd(totalOf(all)),
    open(all.openPositions, all.unmarked),
    all.closedRounds !== undefined ? String(all.closedRounds) : "-",
  ])
  ctx.deps.stdout.write(
    `\nBy agent (each key, then Manual; the rows sum to the account total)\n${renderTable(
      ["AGENT", "REALIZED NET", "UNREALIZED", "TOTAL", "OPEN", "CLOSED"],
      rows.map((row) => row.map(terminalText)),
    )}\n`,
  )
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
  // Positions live in wallets (PNL-ED-2): name the wallet whenever the API does.
  const withWallet = positions.some((p) => p.wallet !== undefined)
  const withBasis = positions.some((p) => p.transferredIn === true)
  const headers = ["TOKEN", "CHAIN", ...(withWallet ? ["WALLET"] : []), "QUANTITY", "AVG ENTRY", "MARK", "UNREALIZED"]
  if (withBook) headers.push("BOOK")
  if (withBasis) headers.push("COST SOURCE")
  const wallet = (w: string | undefined) => (w === undefined || isUnplacedWallet(w) ? "-" : shortAddress(w))
  const rows = positions.map((p) => {
    const row = [
      `${p.symbol?.trim() || shortAddress(p.mint)}${p.dust === true ? " (dust)" : ""}`,
      p.chain ?? "-",
      ...(withWallet ? [wallet(p.wallet)] : []),
      formatQuantity(p.quantity),
      formatPrice(p.avgEntryUsd),
      p.markPriceUsd !== undefined ? formatPrice(p.markPriceUsd) : "unpriced",
      p.unrealizedUsd !== undefined ? formatUsd(p.unrealizedUsd) : "-",
    ]
    if (withBook) row.push(p.book ?? "-")
    if (withBasis)
      row.push(
        p.transferredIn
          ? `Moved in${p.movedInFromWallet ? ` from ${shortAddress(p.movedInFromWallet)}` : ""}: ${p.basisSource ?? "unknown"}${p.basisComplete === false ? " (partial)" : ""}`
          : "-",
      )
    return row
  })
  ctx.deps.stdout.write(
    `\nOpen positions\n${renderTable(
      headers,
      rows.map((row) => row.map(terminalText)),
    )}\n`,
  )
}
