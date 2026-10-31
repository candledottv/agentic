import { parseArgs } from "../args"
import { apiRequest } from "../client"
import { type CommandContext, resolveApiKey } from "../deps"
import { writeFields, writeTable } from "../human-output"
import { createLabClient, type LabAnswer, type LabClient, type LabRecord, type LabReplayInput } from "../lab"
import { notice } from "../presentation"
import { terminalText, writeLocalFailure, writeUsageFailure } from "../render"

const PRODUCTION_KEY_MESSAGE = "The lab needs a production agent key. Create one with `candle keys create`."
const REPLAY_USAGE =
  "Usage: candle lab replay --definition <file|-> --from <iso> --to <iso> [--asset-ids a,b] [--fee-bps n] [--slippage-bps n] [--no-wait]"

function object(value: unknown): LabRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as LabRecord) : {}
}

function text(value: unknown): string {
  return value === undefined || value === null ? "—" : terminalText(String(value))
}

function usage(ctx: CommandContext, message: string): number {
  writeUsageFailure(ctx.deps, message, ctx.json)
  return 2
}

async function client(ctx: CommandContext): Promise<{ lab: LabClient; apiKey: string } | undefined> {
  const apiKey = await resolveApiKey(ctx.deps, ctx.profile)
  if (!apiKey?.startsWith("cndl_live_")) {
    writeLocalFailure(ctx.deps, { code: "LAB_PRODUCTION_KEY_REQUIRED", message: PRODUCTION_KEY_MESSAGE }, ctx.json)
    return
  }
  try {
    return {
      apiKey,
      lab: createLabClient({
        apiKey,
        apiUrl: ctx.deps.env.CANDLE_HACC_URL?.trim() || undefined,
        fetch: ctx.deps.fetch,
        now: ctx.deps.now,
        sleep: ctx.deps.sleep,
      }),
    }
  } catch {
    writeLocalFailure(
      ctx.deps,
      {
        code: "LAB_URL_INVALID",
        message: "The lab needs a valid HTTPS CANDLE_HACC_URL without credentials, query or fragment.",
      },
      ctx.json,
    )
  }
}

function failure(answer: Extract<LabAnswer<unknown>, { ok: false }>, ctx: CommandContext, statusRoute = false): number {
  const { refusal } = answer
  if (ctx.json && refusal.body !== undefined) ctx.deps.stdout.write(`${JSON.stringify(refusal.body)}\n`)
  else {
    const body = object(refusal.body)
    const message =
      statusRoute && refusal.status === 404
        ? "the lab on this server predates `candle lab status`"
        : `${refusal.message}${refusal.status === 429 && body.resets_at ? ` Resets at ${text(body.resets_at)}.` : ""}`
    writeLocalFailure(ctx.deps, { code: refusal.code, message: terminalText(message) }, ctx.json)
  }
  return 1
}

function replayOutput(body: LabRecord, ctx: CommandContext): number {
  if (ctx.json) ctx.deps.stdout.write(`${JSON.stringify(body)}\n`)
  else {
    const result = object(body.result)
    const lead = object(result.lead_card)
    if (Object.keys(lead).length) {
      const control = object(lead.control)
      const breakEven = object(lead.break_even)
      writeFields(
        ctx.deps,
        "stdout",
        [
          [
            "Control",
            control.unavailable
              ? text(control.unavailable)
              : `Beat ${text(control.strategy_beats_arms)} of ${text(control.arms)} random arms`,
          ],
          [
            "Break-even",
            `${text(breakEven.cost_bps_per_side)} bps per side; ${text(breakEven.round_trip_pct)}% round trip`,
          ],
          ["Regime", text(object(lead.regime).label)],
          ["Summary", text(lead.summary)],
        ],
        "Lead card",
      )
      if (lead.insufficient === true) ctx.deps.stdout.write("Insufficient evidence: fewer than five trades.\n")
      for (const line of Array.isArray(lead.evidence_limitations) ? lead.evidence_limitations : []) {
        ctx.deps.stdout.write(`${text(line)}\n`)
      }
      notice(ctx.deps, "stdout", "note", "Backtests are a model of the past. The lab never trades.")
      ctx.deps.stdout.write("\n")
    }
    writeFields(
      ctx.deps,
      "stdout",
      [
        ["Job", text(body.job_id)],
        ["Status", text(body.status)],
        ...(body.error ? [["Error", text(body.error)] as const] : []),
        ...(Object.keys(result).length
          ? [
              ["Verdict", text(result.verdict)] as const,
              ["Trades", text(result.trade_count)] as const,
              ["PnL USD", text(result.pnl_usd)] as const,
              ["Max drawdown %", text(result.max_drawdown_pct)] as const,
            ]
          : []),
      ],
      "Replay",
    )
  }
  return ["failed", "cancelled", "timed_out"].includes(String(body.status)) ? 1 : 0
}

export async function labStatus(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {})
  if ("error" in parsed || parsed.positionals.length) return usage(ctx, "Usage: candle lab status")
  const connected = await client(ctx)
  if (!connected) return 1
  const answer = await connected.lab.status()
  if (!answer.ok) return failure(answer, ctx, true)
  if (ctx.json) ctx.deps.stdout.write(`${JSON.stringify(answer.body)}\n`)
  else
    writeFields(
      ctx.deps,
      "stdout",
      [
        ["Plan", text(answer.body.plan)],
        ["Allowed", answer.body.allowed ? "yes" : "no"],
        ["Replays", `${text(answer.body.replays.used)} of ${text(answer.body.replays.cap)}`],
        ["Resets at", text(answer.body.replays.resets_at)],
        ["Active job", text(answer.body.active_job_id)],
      ],
      "Lab status",
    )
  return 0
}

function numberFlag(value: string | undefined, min: number, max: number, integer = false): number | undefined {
  if (value === undefined) return undefined
  const n = value.trim() === "" ? Number.NaN : Number(value)
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new Error("Invalid number")
  return n
}

async function memberFee(ctx: CommandContext, apiKey: string): Promise<number | undefined> {
  const answer = await apiRequest("/api/v1/agent/tier", {
    apiUrl: ctx.apiUrl,
    auth: "key",
    credentials: { apiKey },
    env: ctx.deps.env,
    fetch: ((input, init) => ctx.deps.fetch(input, { ...init, signal: AbortSignal.timeout(10_000) })) as typeof fetch,
  })
  const fee = answer.ok ? object(answer.body).feeBps : undefined
  return typeof fee === "number" && Number.isInteger(fee) && fee >= 0 && fee <= 1_000 ? fee : undefined
}

export async function labReplay(args: string[], ctx: CommandContext): Promise<number> {
  if (args[0] === "get" || args[0] === "cancel") {
    const action = args[0]
    const parsed = parseArgs(args.slice(1), {})
    if ("error" in parsed || parsed.positionals.length !== 1)
      return usage(ctx, `Usage: candle lab replay ${action} <job-id>`)
    const connected = await client(ctx)
    if (!connected) return 1
    const id = parsed.positionals[0] as string
    const answer = action === "get" ? await connected.lab.replayGet(id) : await connected.lab.replayCancel(id)
    if (!answer.ok) return failure(answer, ctx)
    if (action === "get") return replayOutput(answer.body, ctx)
    if (ctx.json) ctx.deps.stdout.write(`${JSON.stringify(answer.body)}\n`)
    else
      writeFields(ctx.deps, "stdout", [
        ["Job", text(id)],
        ["Cancelled", text(answer.body.cancelled)],
      ])
    return 0
  }
  // The shared parser refuses values beginning with '-'. This command alone accepts a literal
  // '-' as a file source; normalize that token for parsing, then read stdin through Deps.
  const stdin = args[args.lastIndexOf("--definition") + 1] === "-"
  const parsed = parseArgs(
    args.map((arg, i) => (arg === "-" && args[i - 1] === "--definition" ? "<stdin>" : arg)),
    {
      valueFlags: ["--definition", "--from", "--to", "--asset-ids", "--fee-bps", "--slippage-bps"],
      booleanFlags: ["--no-wait"],
      pathFlags: ["--definition"],
    },
  )
  if ("error" in parsed) return usage(ctx, `${parsed.error}\n${REPLAY_USAGE}`)
  const v = parsed.values
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
  if (
    parsed.positionals.length ||
    !v["--definition"] ||
    !v["--from"] ||
    !v["--to"] ||
    !iso.test(v["--from"]) ||
    !iso.test(v["--to"]) ||
    !Number.isFinite(Date.parse(v["--from"])) ||
    !Number.isFinite(Date.parse(v["--to"])) ||
    Date.parse(v["--to"]) <= Date.parse(v["--from"])
  )
    return usage(ctx, REPLAY_USAGE)
  let fee: number | undefined
  let slippage: number | undefined
  let assetIds: number[] | undefined
  try {
    fee = numberFlag(v["--fee-bps"], 0, 1_000, true)
    slippage = numberFlag(v["--slippage-bps"], 0, 1_000, true)
    if (v["--asset-ids"] !== undefined) {
      const ids = v["--asset-ids"].split(",")
      if (!ids.length || ids.length > 50) throw new Error("Invalid asset ids")
      assetIds = ids.map((id) => numberFlag(id, 1, Number.MAX_SAFE_INTEGER, true) as number)
    }
  } catch {
    return usage(
      ctx,
      `Costs must be integers from 0 to 1000 bps; asset ids must be 1–50 positive integers.\n${REPLAY_USAGE}`,
    )
  }
  let definition: LabRecord
  try {
    const source = stdin
      ? new TextDecoder().decode(await ctx.deps.readStdin())
      : await ctx.deps.readFile(v["--definition"])
    const value: unknown = JSON.parse(source)
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid definition")
    definition = value as LabRecord
  } catch {
    return usage(ctx, "--definition must name a readable JSON object file, or - for JSON on stdin.")
  }
  const connected = await client(ctx)
  if (!connected) return 1
  if (fee === undefined) fee = await memberFee(ctx, connected.apiKey)
  const body: LabReplayInput = {
    definition,
    from: v["--from"],
    to: v["--to"],
    ...(assetIds ? { asset_ids: assetIds } : {}),
    ...(fee !== undefined
      ? { cost: { fee_bps_per_side: fee, ...(slippage !== undefined ? { slippage_bps_per_side: slippage } : {}) } }
      : {}),
  }
  const started = await connected.lab.replay(body)
  if (!started.ok) return failure(started, ctx)
  if (parsed.booleans.has("--no-wait")) {
    if (ctx.json) ctx.deps.stdout.write(`${JSON.stringify(started.body)}\n`)
    else writeFields(ctx.deps, "stdout", [["Job", text(started.body.job_id)]])
    return 0
  }
  const result = await connected.lab.waitForReplay(started.body.job_id)
  return result.ok ? replayOutput(result.body, ctx) : failure(result, ctx)
}

async function report(args: string[], ctx: CommandContext, kind: "runners" | "edges"): Promise<number> {
  const flags = kind === "runners" ? ["--hours", "--min-wallets"] : ["--days", "--min-n"]
  const parsed = parseArgs(args, { valueFlags: flags })
  const help = `Usage: candle lab ${kind} ${kind === "runners" ? "[--hours n] [--min-wallets n]" : "[--days n] [--min-n n]"}`
  if ("error" in parsed || parsed.positionals.length) return usage(ctx, help)
  let q: Record<string, number | undefined>
  try {
    q =
      kind === "runners"
        ? {
            hours: numberFlag(parsed.values["--hours"], 1, 48, true),
            min_wallets: numberFlag(parsed.values["--min-wallets"], 1, 50, true),
          }
        : {
            days: numberFlag(parsed.values["--days"], 1, 30, true),
            min_n: numberFlag(parsed.values["--min-n"], 1, 1_000, true),
          }
  } catch {
    return usage(ctx, help)
  }
  const connected = await client(ctx)
  if (!connected) return 1
  const answer = kind === "runners" ? await connected.lab.runners(q) : await connected.lab.edges(q)
  if (!answer.ok) return failure(answer, ctx)
  if (ctx.json) ctx.deps.stdout.write(`${JSON.stringify(answer.body)}\n`)
  else {
    const body = answer.body
    const list = kind === "runners" ? body.leaderboard : body.edges
    const columns =
      kind === "runners"
        ? ["asset_id", "symbol", "peak_gain_pct", "now_gain_pct", "wallets"]
        : [
            "pattern",
            "group_name",
            "age_bucket",
            "mcap_bucket",
            "held_bucket",
            "n",
            "net_med_1h_pct",
            "net_med_24h_pct",
          ]
    const labels =
      kind === "runners"
        ? ["Asset", "Symbol", "Peak gain %", "Current gain %", "Wallets"]
        : ["Pattern", "Group", "Age", "Market cap", "Held", "Samples", "Net median 1h %", "Net median 24h %"]
    if (kind === "edges")
      ctx.deps.stdout.write(`Edges net of ${text(body.cost_pct)}% round-trip cost (server's table).\n`)
    const rows = Array.isArray(list) ? list.map((row) => columns.map((column) => text(object(row)[column]))) : []
    if (!rows.length) ctx.deps.stdout.write(`No ${kind} in this window.\n`)
    else
      writeTable(
        ctx.deps,
        "stdout",
        labels,
        rows,
        columns.map(() => ({})),
      )
  }
  return 0
}

export const labRunners = (args: string[], ctx: CommandContext) => report(args, ctx, "runners")
export const labEdges = (args: string[], ctx: CommandContext) => report(args, ctx, "edges")
