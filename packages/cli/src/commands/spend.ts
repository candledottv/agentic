/**
 * `candle spend`: the local x402 payment log and the spending limits (spec 10.1, 10.3, 10.4;
 * decision A9). Every limit here is this machine's own, read before any per-use payment is signed;
 * the server knows nothing of them.
 *
 *   candle spend [--days N] [--json]       the log, today's total against the limit, the credit balance
 *   candle spend limit [<usd>]             show or set the daily per-use limit (default $5)
 *   candle spend max-per-call [<usd>]      show or set the per-call ceiling (default $1)
 *   candle spend pause | resume            stop or allow every per-use payment
 *
 * The credit balance is the server's (`GET /api/v1/agent/x402/credits`), read with the profile's
 * API key; without one it is not shown. Stale `unknown` payments are first resolved against
 * `GET /api/v1/agent/x402/payments` with that key (10.4).
 */
import { parseArgs } from "../args"
import { apiRequest } from "../client"
import { type CommandContext, resolveApiKey } from "../deps"
import { writeFields, writeSuccess, writeTable } from "../human-output"
import { notice, symbols, terminalStyle } from "../presentation"
import { formatTime, terminalText, writeLocalFailure, writeUsageFailure } from "../render"
import { readServerPayments, reconcileUnknown } from "../x402/reconcile"
import { usdcText } from "../x402/select"
import {
  foldSpendLog,
  readLimits,
  readSpendLog,
  type SpendLimits,
  type SpendPaths,
  spendPaths,
  spentOn,
  usdText,
  utcDay,
  writeLimits,
} from "../x402/spend-log"

const DAY_MS = 86_400_000

function pathsOf(ctx: CommandContext): SpendPaths | null {
  try {
    return spendPaths(ctx.deps.env, ctx.deps.homedir(), ctx.profile)
  } catch (error) {
    writeUsageFailure(ctx.deps, error instanceof Error ? error.message : String(error), ctx.json)
    return null
  }
}

function limitsView(limits: SpendLimits) {
  return {
    dailyLimitUsd: usdText(limits.dailyLimitUsdMicros),
    maxPerCallUsd: usdText(limits.maxPerCallUsdMicros),
    paused: limits.paused,
  }
}

/** A dollar amount a person typed, in micro-USD: "5", "$5", "0.25". Zero is allowed (nothing passes). */
function parseUsd(raw: string): bigint | null {
  const cleaned = raw.trim().replace(/^\$/, "")
  const match = /^([0-9]{1,9})(?:\.([0-9]{1,6}))?$/.exec(cleaned)
  if (!match) return null
  return BigInt(match[1] as string) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0") || "0")
}

type CreditRead = { balanceUsdMicros: string } | { unavailable: string }

async function readCredit(ctx: CommandContext, apiKey: string | undefined): Promise<CreditRead> {
  if (!apiKey) return { unavailable: "no API key on this profile" }
  const result = await apiRequest("/api/v1/agent/x402/credits", {
    apiUrl: ctx.apiUrl,
    auth: "key",
    credentials: { apiKey },
    env: ctx.deps.env,
    fetch: ctx.deps.fetch,
  })
  if (result.ok) {
    const balance = (result.body as { balanceUsdMicros?: unknown } | null)?.balanceUsdMicros
    if (typeof balance === "string" && /^-?[0-9]+$/.test(balance)) return { balanceUsdMicros: balance }
    return { unavailable: "the API's answer was unreadable" }
  }
  if (result.status === 404) return { unavailable: "x402 is off on this API" }
  return { unavailable: result.message }
}

export async function spendShow(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--days"] })
  const daysText = "error" in parsed ? undefined : (parsed.values["--days"] ?? "7")
  if ("error" in parsed || parsed.positionals.length !== 0 || !/^[1-9][0-9]{0,3}$/.test(daysText ?? "")) {
    writeUsageFailure(ctx.deps, "Usage: candle spend [--days <1-9999>] [--json]", ctx.json)
    return 2
  }
  const days = Number(daysText)
  const paths = pathsOf(ctx)
  if (!paths) return 2
  const now = ctx.deps.now()
  const apiKey = await resolveApiKey(ctx.deps, ctx.profile)
  if (apiKey) {
    await reconcileUnknown(paths, now, async () => {
      const result = await apiRequest("/api/v1/agent/x402/payments?limit=100", {
        apiUrl: ctx.apiUrl,
        auth: "key",
        credentials: { apiKey },
        env: ctx.deps.env,
        fetch: ctx.deps.fetch,
      })
      return result.ok ? readServerPayments(result.body) : null
    })
  }
  const limits = await readLimits(paths)
  const entries = foldSpendLog(await readSpendLog(paths))
  const today = utcDay(now)
  const spentToday = spentOn(entries, today)
  const since = now - days * DAY_MS
  const shown = entries
    .filter((e) => Date.parse(e.startedAt) >= since)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
  const credit = await readCredit(ctx, apiKey)

  if (ctx.json) {
    ctx.deps.stdout.write(
      `${JSON.stringify({
        ok: true,
        limits: limitsView(limits),
        today: { day: today, spentUsd: usdText(spentToday), limitUsd: usdText(limits.dailyLimitUsdMicros) },
        credit:
          "balanceUsdMicros" in credit
            ? { balanceUsd: usdcText(BigInt(credit.balanceUsdMicros)) }
            : { unavailable: credit.unavailable },
        payments: shown.map((e) => ({
          id: e.id,
          at: e.startedAt,
          kind: e.kind,
          route: e.route,
          network: e.network,
          amountUsdc: usdcText(e.amountRaw),
          state: e.state,
          payer: e.payer,
          payTo: e.payTo,
          ...(e.signature ? { signature: e.signature } : {}),
          ...(e.reason ? { reason: e.reason } : {}),
        })),
      })}\n`,
    )
    return 0
  }

  writeFields(
    ctx.deps,
    "stdout",
    [
      ["Today (UTC)", today],
      ["Spent", `$${usdText(spentToday)}`],
      ["Daily per-use limit", `$${usdText(limits.dailyLimitUsdMicros)}`],
      ["Per call at most", `$${usdText(limits.maxPerCallUsdMicros)}`],
      ["Payments", limits.paused ? "PAUSED" : "enabled"],
    ],
    "Per-use spend",
  )
  writeFields(ctx.deps, "stdout", [
    ["Candle credit", "balanceUsdMicros" in credit ? `${usdcText(BigInt(credit.balanceUsdMicros))} USDC` : undefined],
  ])
  if ("unavailable" in credit)
    notice(ctx.deps, "stdout", "note", `Candle credit not shown: ${terminalText(credit.unavailable)}`)
  if (shown.length === 0) {
    notice(ctx.deps, "stdout", "note", `No x402 payments in the last ${days} day${days === 1 ? "" : "s"}.`)
    return 0
  }
  writeTable(
    ctx.deps,
    "stdout",
    ["WHEN (UTC)", "KIND", "USDC", "STATE", "SIGNATURE"],
    shown.map((e) => [
      formatTime(e.startedAt),
      terminalText(e.kind),
      usdcText(e.amountRaw),
      e.state,
      e.signature ? terminalText(e.signature) : symbols(terminalStyle(ctx.deps, "stdout")).missing,
    ]),
    [{ priority: 2 }, { priority: 1 }, { align: "right" }, {}, { id: true, priority: 3 }],
  )
  return 0
}

async function showOrSet(
  args: string[],
  ctx: CommandContext,
  field: "dailyLimitUsdMicros" | "maxPerCallUsdMicros",
  word: string,
): Promise<number> {
  const parsed = parseArgs(args, {})
  if ("error" in parsed || parsed.positionals.length > 1) {
    writeUsageFailure(ctx.deps, `Usage: candle spend ${word} [<usd>]`, ctx.json)
    return 2
  }
  const paths = pathsOf(ctx)
  if (!paths) return 2
  const limits = await readLimits(paths)
  const raw = parsed.positionals[0]
  if (raw !== undefined) {
    const value = parseUsd(raw)
    if (value === null) {
      writeUsageFailure(ctx.deps, `Not a dollar amount: ${raw}. Use a number such as 5 or 0.25.`, ctx.json)
      return 2
    }
    limits[field] = value
    await writeLimits(paths, limits)
  }
  if (ctx.json) ctx.deps.stdout.write(`${JSON.stringify({ ok: true, limits: limitsView(limits) })}\n`)
  else {
    const label = field === "dailyLimitUsdMicros" ? "Daily per-use limit" : "Per-call ceiling"
    writeFields(ctx.deps, "stdout", [[label, `$${usdText(limits[field])}${raw !== undefined ? " (saved)" : ""}`]])
  }
  return 0
}

export function spendLimit(args: string[], ctx: CommandContext): Promise<number> {
  return showOrSet(args, ctx, "dailyLimitUsdMicros", "limit")
}

export function spendMaxPerCall(args: string[], ctx: CommandContext): Promise<number> {
  return showOrSet(args, ctx, "maxPerCallUsdMicros", "max-per-call")
}

async function setPaused(args: string[], ctx: CommandContext, paused: boolean): Promise<number> {
  if (args.length !== 0) {
    writeUsageFailure(ctx.deps, `Usage: candle spend ${paused ? "pause" : "resume"}`, ctx.json)
    return 2
  }
  const paths = pathsOf(ctx)
  if (!paths) return 2
  try {
    const limits = await readLimits(paths)
    limits.paused = paused
    await writeLimits(paths, limits)
    if (ctx.json) ctx.deps.stdout.write(`${JSON.stringify({ ok: true, limits: limitsView(limits) })}\n`)
    else
      writeSuccess(ctx.deps, "stdout", (paused ? "Per-use payments paused.\n" : "Per-use payments resumed.\n").trim())
    return 0
  } catch (error) {
    writeLocalFailure(
      ctx.deps,
      { code: "SPEND_WRITE_FAILED", message: error instanceof Error ? error.message : String(error) },
      ctx.json,
    )
    return 1
  }
}

export function spendPause(args: string[], ctx: CommandContext): Promise<number> {
  return setPaused(args, ctx, true)
}

export function spendResume(args: string[], ctx: CommandContext): Promise<number> {
  return setPaused(args, ctx, false)
}
