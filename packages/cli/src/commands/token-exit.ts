/**
 * `candle token exit <token>` (BE-3794, card E of the BE-3630 design,
 * `docs/superpowers/specs/2026-11-18-hood-gen2-holder-exits-design.md` section 6.2): where a holder
 * of a Candle Hood launch stands if the launch does not migrate, and the exit itself.
 *
 *   GET  /api/v1/markets/hood/{token}                     -> the token's curve and decimals
 *   GET  /api/v1/hood/curves/{curve}/holder-exit?account= -> the holder-exit read (public)
 *   POST /api/v1/agent/hood/holder-exit/{curve}           -> the exit, signed by Candle (agent key)
 *
 * The read needs no key. Its wallet is `--wallet <0x address>`, else (with a key) the account's
 * embedded Hood wallet, else none (the curve's figures only). The actions run on the agent route:
 * `--recover` (claim_recovery: approve the exact amount, then redeem), `--enter-recovery` and
 * `--claim-team`. Candle signs with the embedded Hood wallet; `--wallet` names another of the
 * account's wallets, which the API then accepts or refuses by name (a linked wallet signs for
 * itself through the API's `linkedSigning`, which this command does not do).
 *
 * Nothing is derived here. The state, the actions and `disclosure` are the API's, the disclosure is
 * printed verbatim before every action and beside every refusal, and no calldata is encoded on this
 * machine. A real action runs the API's dry run first, shows it, and asks (or takes `--yes`).
 *
 * `--json` is the API's body as sent: the read's `{ payload: { curve, token, holderExit } }`, the
 * agent route's result. A refusal is the usual failure envelope with the API's code and, in
 * `details`, the disclosure and (for a sequence that started) `outcome`, `calls` and `warnings`.
 * Exit 3 when a call's outcome is not known (`indeterminate`): read again before running it again.
 */
import { parseArgs } from "../args"
import { apiRequest } from "../client"
import { type CommandContext, resolveApiKey } from "../deps"
import { writeFields } from "../human-output"
import { notice } from "../presentation"
import { writeUsageFailure } from "../render"
import { CANCELLED_EXIT, decimalAmount, type Json, rawAmount, request, safeText, TradingError } from "../trading"
import { printTradingResult, tradingFailure } from "./swap"

export const TOKEN_EXIT_USAGE =
  "Usage: candle token exit <token> [--wallet <0x address|main>] [--recover [--amount <tokens>] | --enter-recovery | --claim-team] [--dry-run] [--yes] [--json]"

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

const ACTIONS = {
  "--recover": "claim_recovery",
  "--enter-recovery": "enter_recovery",
  "--claim-team": "claim_team",
} as const
type ExitAction = (typeof ACTIONS)[keyof typeof ACTIONS]

const ACTION_WORDS: Record<ExitAction, string> = {
  claim_recovery: "Redeem at the Recovery rate",
  enter_recovery: "Open Recovery",
  claim_team: "Claim vested team tokens",
}

const STATE_WORDS: Record<string, string> = {
  none: "none: ordinary trading, nothing to exit",
  awaiting_migration: "awaiting migration",
  recovery_open: "Recovery can be opened",
  recovery: "Recovery: redeem at a fixed rate",
  rescue_pending: "rescue pending: buying is closed",
  rescued: "rescued: no on-chain claim",
}

const OUTCOME_WORDS: Record<string, string> = {
  complete: "complete",
  partial: "partial: a call landed and a later one did not; run the exit again for the rest",
  indeterminate: "unknown: a call was sent and its result is not known yet; read before running it again",
  failed: "failed: the transaction reverted",
  not_started: "nothing was sent",
}

interface HolderExitView {
  state?: string
  lifecycle?: string
  disclosure?: string
  actions?: string[]
  recoveryWindow?: { creatorMayEnterAt?: string; anyoneMayEnterAt?: string } | null
  recovery?: {
    quoteToken?: string
    quoteDecimals?: number
    ratePerTokenRaw?: string
    remainingRaw?: string
    eligibleSupplyRaw?: string
  } | null
  rescue?: { to?: string; executableAt?: string; valid?: boolean; voidReason?: string | null } | null
  team?: {
    recipient?: string
    amountRaw?: string
    vestedRaw?: string
    claimedRaw?: string
    claimableRaw?: string
    cliffTime?: string
    status?: string
  } | null
  account?: { address?: string; baseBalanceRaw?: string; recoveryQuoteOutRaw?: string; isTeamRecipient?: boolean }
}

const isRaw = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value)

function amount(raw: unknown, decimals: number, unit = ""): string | undefined {
  if (!isRaw(raw)) return undefined
  const text = decimalAmount(raw, decimals)
  const trimmed = text.includes(".") ? text.replace(/\.?0+$/, "") : text
  return `${trimmed}${unit ? ` ${unit}` : ""}`
}

function when(seconds: unknown): string | undefined {
  if (!isRaw(seconds)) return undefined
  const ms = Number(seconds) * 1000
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

/** A failure from the public reads (`{ error: true, code?, payload }`) or the agent envelope. */
function readFailure(result: { status: number; code?: string; message: string; raw?: unknown }): TradingError {
  const raw = (result.raw ?? null) as { code?: unknown; payload?: unknown } | null
  const code = typeof raw?.code === "string" ? raw.code : (result.code ?? `HTTP_${result.status}`)
  const message = typeof raw?.payload === "string" ? raw.payload : result.message
  return new TradingError(code, message)
}

export async function tokenExit(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--wallet", "--amount"],
    booleanFlags: ["--recover", "--enter-recovery", "--claim-team", "--dry-run", "--yes"],
  })
  if ("error" in parsed) {
    writeUsageFailure(ctx.deps, parsed.error, ctx.json)
    return 2
  }
  const { values, positionals, booleans } = parsed
  const token = positionals[0]
  const chosen = (Object.keys(ACTIONS) as (keyof typeof ACTIONS)[]).filter((flag) => booleans.has(flag))
  const action: ExitAction | undefined = chosen[0] ? ACTIONS[chosen[0]] : undefined
  const wallet = values["--wallet"]
  if (
    positionals.length !== 1 ||
    !token ||
    !ADDRESS.test(token) ||
    chosen.length > 1 ||
    (values["--amount"] !== undefined && action !== "claim_recovery") ||
    ((booleans.has("--dry-run") || booleans.has("--yes")) && action === undefined) ||
    (wallet !== undefined && wallet !== "main" && wallet !== "embedded" && !ADDRESS.test(wallet))
  ) {
    writeUsageFailure(ctx.deps, TOKEN_EXIT_USAGE, ctx.json)
    return 2
  }

  try {
    const apiKey = await resolveApiKey(ctx.deps, ctx.profile)
    const send = (path: string) =>
      apiRequest(path, {
        apiUrl: ctx.apiUrl,
        auth: apiKey ? "key" : "none",
        credentials: apiKey ? { apiKey } : {},
        env: ctx.deps.env,
        fetch: ctx.deps.fetch,
      })

    // The curve and the token's decimals, from the token's market.
    const marketRead = await send(`/api/v1/markets/hood/${encodeURIComponent(token)}`)
    if (!marketRead.ok) throw readFailure(marketRead)
    const market = ((marketRead.body as Json | undefined)?.market ?? {}) as Json
    const curve =
      typeof market.curveAddress === "string" && ADDRESS.test(market.curveAddress) ? market.curveAddress : null
    if (!curve)
      throw new TradingError("NO_HOOD_CURVE", "This token has no Candle Hood curve, so it has no holder exit.")
    const baseDecimals = typeof market.decimals === "number" && Number.isInteger(market.decimals) ? market.decimals : 18

    // The wallet the read is for: named, else the account's embedded Hood wallet, else none.
    let account: string | undefined = wallet !== undefined && ADDRESS.test(wallet) ? wallet : undefined
    if (account === undefined && (wallet !== undefined || apiKey)) {
      if (!apiKey)
        throw new TradingError("API_KEY_REQUIRED", "--wallet main reads the account's embedded wallet: select a key.")
      const embedded = await request(ctx, apiKey, "/api/v1/agent/wallets/embedded")
      const evm = ((embedded.wallets as Json | undefined)?.evm as Json | null | undefined)?.address
      if (typeof evm === "string") account = evm
      else if (wallet !== undefined || action !== undefined)
        throw new TradingError(
          "NO_EMBEDDED_WALLET",
          "This account has no embedded Hood wallet. Name one with --wallet.",
        )
    }

    const readPath = `/api/v1/hood/curves/${encodeURIComponent(curve)}/holder-exit${account ? `?account=${encodeURIComponent(account)}` : ""}`
    const read = await send(readPath)
    if (!read.ok) throw readFailure(read)
    const readBody = (read.body ?? {}) as Json
    const view = ((readBody.payload as Json | undefined)?.holderExit ?? {}) as HolderExitView
    const disclosure = typeof view.disclosure === "string" ? view.disclosure : ""

    if (action === undefined) {
      if (ctx.json) return printTradingResult(ctx, readBody)
      printView(ctx, token, curve, view, baseDecimals)
      return 0
    }

    // The action: the API's dry run, shown with the disclosure, then (unless --dry-run) the real one.
    const key = apiKey
    if (!key) throw new TradingError("API_KEY_REQUIRED", "An exit runs on an agent key. Select a profile with one.")
    const amountRaw = values["--amount"] !== undefined ? rawAmount(values["--amount"], baseDecimals) : undefined
    const body: Json = {
      action,
      ...(amountRaw !== undefined ? { amountRaw } : {}),
      ...(wallet !== undefined && ADDRESS.test(wallet) ? { wallet } : {}),
    }
    const agentPath = `/api/v1/agent/hood/holder-exit/${encodeURIComponent(curve)}`
    const run = async (dryRun: boolean): Promise<Json> => {
      const result = await apiRequest(agentPath, {
        apiUrl: ctx.apiUrl,
        auth: "key",
        credentials: { apiKey: key },
        method: "POST",
        body: { ...body, dryRun },
        env: ctx.deps.env,
        fetch: ctx.deps.fetch,
      })
      if (result.ok) return (result.body ?? {}) as Json
      const raw = (result.raw ?? {}) as Json
      const error = (raw.error ?? {}) as Json
      const outcome = typeof raw.outcome === "string" ? raw.outcome : undefined
      throw new TradingError(result.code ?? `HTTP_${result.status}`, result.message, {
        details: {
          ...(disclosure ? { disclosure } : {}),
          ...(typeof error.stage === "string" ? { stage: error.stage } : {}),
          ...(error.details && typeof error.details === "object" ? { refusal: error.details } : {}),
          ...(typeof error.reason === "string" ? { reason: error.reason } : {}),
          ...(outcome ? { outcome } : {}),
          ...(Array.isArray(raw.calls) ? { calls: raw.calls } : {}),
          ...(Array.isArray(raw.warnings) ? { warnings: raw.warnings } : {}),
        },
        ...(outcome === "indeterminate" || error.stage === "unconfirmed" ? { exitCode: 3 as const } : {}),
      })
    }

    const out = ctx.json ? "stderr" : "stdout"
    if (disclosure) notice(ctx.deps, out, "note", safeText(disclosure))
    const preview = await run(true)
    if (booleans.has("--dry-run")) {
      if (ctx.json) return printTradingResult(ctx, preview)
      printAgentResult(ctx, action, preview, baseDecimals)
      return 0
    }
    if (!ctx.json) printAgentResult(ctx, action, preview, baseDecimals)
    if (preview.signable === false)
      throw new TradingError(
        "HOOD_EXIT_WALLET_NOT_SIGNABLE",
        `Candle cannot sign this exit for that wallet${typeof preview.reason === "string" ? ` (${safeText(preview.reason)})` : ""}. Nothing was sent.`,
        { details: { ...(disclosure ? { disclosure } : {}), stage: "not_broadcast" } },
      )
    if (!booleans.has("--yes")) {
      if (!ctx.deps.isTTY.stdin)
        throw new TradingError(
          "CONFIRMATION_REQUIRED",
          "Run interactively to confirm, or pass --yes. Nothing was sent.",
        )
      const answer = (await ctx.deps.promptLine(`${ACTION_WORDS[action]} now? [y/N] `)).trim().toLowerCase()
      if (answer !== "y") {
        notice(ctx.deps, out, "note", "Cancelled. Nothing was sent.")
        return CANCELLED_EXIT
      }
    }
    const done = await run(false)
    if (ctx.json) return printTradingResult(ctx, done)
    printAgentResult(ctx, action, done, baseDecimals)
    return 0
  } catch (error) {
    // A refusal prints the API's code and the disclosure (spec 6.2). --json carries the code in the
    // envelope and the disclosure in `details`; the human rendering shows neither, so say both here.
    if (!ctx.json && error instanceof TradingError && typeof error.details?.disclosure === "string") {
      notice(ctx.deps, "stderr", "note", safeText(error.details.disclosure))
      return tradingFailure(
        ctx,
        new TradingError(error.code, `${error.code}: ${error.message}`, {
          details: error.details,
          exitCode: error.exitCode,
          ...(error.suggestion ? { suggestion: error.suggestion } : {}),
        }),
      )
    }
    return tradingFailure(ctx, error)
  }
}

function printView(ctx: CommandContext, token: string, curve: string, view: HolderExitView, baseDecimals: number) {
  const quoteDecimals = view.recovery?.quoteDecimals ?? 18
  const quote = view.recovery?.quoteToken ? safeText(view.recovery.quoteToken) : ""
  writeFields(ctx.deps, "stdout", [
    ["Token", safeText(token)],
    ["Curve", safeText(curve)],
    ["State", view.state ? (STATE_WORDS[view.state] ?? safeText(view.state)) : undefined],
    ["Lifecycle", view.lifecycle ? safeText(view.lifecycle) : undefined],
  ])
  if (view.disclosure) notice(ctx.deps, "stdout", "note", safeText(view.disclosure))
  const rows: [string, string | undefined][] = []
  if (view.recoveryWindow) {
    rows.push(["Creator may open Recovery", when(view.recoveryWindow.creatorMayEnterAt)])
    rows.push(["Anyone may open Recovery", when(view.recoveryWindow.anyoneMayEnterAt)])
  }
  if (view.recovery) {
    rows.push(["Recovery rate", amount(view.recovery.ratePerTokenRaw, quoteDecimals, `${quote} per token`.trim())])
    rows.push(["Recovery left", amount(view.recovery.remainingRaw, baseDecimals, "tokens")])
  }
  if (view.rescue) {
    rows.push(["Rescue to", view.rescue.to ? safeText(view.rescue.to) : undefined])
    rows.push(["Rescue executes", when(view.rescue.executableAt)])
    if (view.rescue.valid === false)
      rows.push(["Rescue request", `void${view.rescue.voidReason ? ` (${safeText(view.rescue.voidReason)})` : ""}`])
  }
  if (view.team) {
    rows.push(["Team recipient", view.team.recipient ? safeText(view.team.recipient) : undefined])
    rows.push(["Team allocation", amount(view.team.amountRaw, baseDecimals, "tokens")])
    rows.push(["Team vested", amount(view.team.vestedRaw, baseDecimals, "tokens")])
    rows.push(["Team claimed", amount(view.team.claimedRaw, baseDecimals, "tokens")])
    rows.push(["Team claimable", amount(view.team.claimableRaw, baseDecimals, "tokens")])
    rows.push(["Team status", view.team.status ? safeText(view.team.status) : undefined])
  }
  if (view.account) {
    rows.push(["Wallet", view.account.address ? safeText(view.account.address) : undefined])
    rows.push(["Balance", amount(view.account.baseBalanceRaw, baseDecimals, "tokens")])
    if (view.state === "recovery" || view.state === "rescue_pending")
      rows.push(["Recovery would pay", amount(view.account.recoveryQuoteOutRaw, quoteDecimals, quote)])
  }
  const shown = rows.filter(([, value]) => value !== undefined)
  if (shown.length) writeFields(ctx.deps, "stdout", shown)
  const actions = Array.isArray(view.actions) ? view.actions : []
  const flags: Record<string, string> = {
    enter_recovery: "--enter-recovery",
    claim_recovery: "--recover",
    claim_team: "--claim-team",
  }
  for (const a of actions)
    if (flags[a]) notice(ctx.deps, "stdout", "note", `Available now: candle token exit ${safeText(token)} ${flags[a]}`)
}

function printAgentResult(ctx: CommandContext, action: ExitAction, result: Json, baseDecimals: number) {
  const build = (result.build ?? {}) as Json
  const quoteDecimals = typeof build.quoteDecimals === "number" ? build.quoteDecimals : 18
  const calls = Array.isArray(result.calls) ? (result.calls as Json[]) : []
  const dryRun = result.dryRun === true
  writeFields(
    ctx.deps,
    "stdout",
    [
      ["Action", ACTION_WORDS[action]],
      ["Wallet", typeof result.wallet === "string" ? safeText(result.wallet) : undefined],
      ["Redeems", amount(build.amountRaw, baseDecimals, "tokens")],
      [
        dryRun ? "Would pay" : "Pays",
        amount(build.expectedQuoteOutRaw, quoteDecimals, typeof build.quoteToken === "string" ? build.quoteToken : ""),
      ],
      ["Releases", amount(build.expectedBaseOutRaw, baseDecimals, "tokens")],
      ["To", typeof build.recipient === "string" ? safeText(build.recipient) : undefined],
      [
        "Calls",
        calls.length
          ? calls
              .map(
                (c) =>
                  `${safeText(String(c.kind))} ${safeText(String(c.status))}${c.txHash ? ` ${safeText(String(c.txHash))}` : ""}`,
              )
              .join(", ")
          : undefined,
      ],
      ["Outcome", dryRun ? undefined : (OUTCOME_WORDS[String(result.outcome)] ?? safeText(String(result.outcome)))],
    ],
    dryRun ? "Dry run" : "Exit",
  )
  if (dryRun && result.signable === false)
    notice(
      ctx.deps,
      "stdout",
      "warning",
      `A real run would be refused: ${typeof result.reason === "string" ? safeText(result.reason) : "this wallet is not signable here"}.`,
    )
  if (dryRun) notice(ctx.deps, "stdout", "note", "Nothing was sent.")
  if (Array.isArray(result.warnings))
    for (const warning of result.warnings) notice(ctx.deps, "stderr", "warning", safeText(String(warning)))
}
