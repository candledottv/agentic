/**
 * `candle signals scorecard|records|record` (BE-3411, hacc north-star CL1): hacc's public
 * scorecard and per-signal measured records, read with this profile's production agent key.
 * Read-only: three GETs to `api.hacc.fun/v1/public/...` and nothing else.
 *
 * Every output carries the fixed line "Measured record, not a forecast." exactly: the last line of
 * a human answer (stdout on success, stderr on a refusal), and `measure` in every `--json` value,
 * success, empty page, 404, usage error and transport failure alike. The command never adds a
 * verdict, a ranking or advice: it prints what hacc measured.
 */
import { parseArgs } from "../args"
import { type CommandContext, resolveApiKey } from "../deps"
import { writeFields, writeTable } from "../human-output"
import { terminalText } from "../render"
import {
  createSignalRecordsClient,
  isRecordSource,
  isScorecardDate,
  MEASURE,
  type MeasuredBody,
  RECORD_SOURCES,
  RECORDS_LIMIT_MAX,
  type SignalRecordsAnswer,
  type SignalRecordsClient,
} from "../signal-records"
import { terminalLines } from "../terminal-text"

const PRODUCTION_KEY_MESSAGE = "Signal records need a production agent key. Create one with `candle keys create`."
const SCORECARD_USAGE = "Usage: candle signals scorecard [--date YYYY-MM-DD]"
const RECORDS_USAGE = `Usage: candle signals records [--source ${RECORD_SOURCES.join("|")}] [--before <id>] [--limit 1-${RECORDS_LIMIT_MAX}]`
const RECORD_USAGE = `Usage: candle signals record <${RECORD_SOURCES.join("|")}> <source-id>`
const HORIZONS = ["15m", "1h", "4h", "24h"] as const

type Row = Record<string, unknown>

function object(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {}
}

function text(value: unknown): string {
  return value === undefined || value === null || value === "" ? "—" : terminalText(String(value))
}

/** A fraction as a percent, signed for a return. hacc serves fractions (0.0123 is 1.23%). */
function percent(value: unknown, signed = false): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—"
  const shown = (value * 100).toFixed(2)
  return `${signed && value > 0 ? "+" : ""}${shown}%`
}

function bool(value: unknown): string {
  return value === true ? "yes" : value === false ? "no" : "—"
}

function measureLine(ctx: CommandContext, stream: "stdout" | "stderr"): void {
  ctx.deps[stream].write(`\n${MEASURE}\n`)
}

function usage(ctx: CommandContext, message: string): number {
  if (ctx.json) ctx.deps.stdout.write(`${JSON.stringify({ ok: false, code: "USAGE", message, measure: MEASURE })}\n`)
  else {
    ctx.deps.stderr.write(`${terminalLines(message)}\n`)
    measureLine(ctx, "stderr")
  }
  return 2
}

function refuse(ctx: CommandContext, code: string, message: string, details?: Row): number {
  if (ctx.json) {
    ctx.deps.stdout.write(
      `${JSON.stringify({ ok: false, code, message, ...(details ? { details } : {}), measure: MEASURE })}\n`,
    )
  } else {
    ctx.deps.stderr.write(`${terminalLines(message)}\n`)
    measureLine(ctx, "stderr")
  }
  return 1
}

async function client(ctx: CommandContext): Promise<SignalRecordsClient | undefined> {
  const apiKey = await resolveApiKey(ctx.deps, ctx.profile)
  if (!apiKey?.startsWith("cndl_live_")) {
    refuse(ctx, "SIGNAL_RECORDS_PRODUCTION_KEY_REQUIRED", PRODUCTION_KEY_MESSAGE)
    return
  }
  try {
    return createSignalRecordsClient({
      apiKey,
      apiUrl: ctx.deps.env.CANDLE_HACC_URL?.trim() || undefined,
      fetch: ctx.deps.fetch,
    })
  } catch {
    refuse(
      ctx,
      "SIGNAL_RECORDS_URL_INVALID",
      "Signal records need a valid HTTPS CANDLE_HACC_URL without credentials, query or fragment.",
    )
  }
}

/** Success: the body (with `measure`) under --json, else the rendering and then the fixed line. */
function answer(ctx: CommandContext, result: SignalRecordsAnswer, render: (body: MeasuredBody) => void): number {
  if (!result.ok) {
    const { status, code, message, body } = result.refusal
    return refuse(ctx, code, message, status ? { status, body } : undefined)
  }
  if (ctx.json) ctx.deps.stdout.write(`${JSON.stringify(result.body)}\n`)
  else {
    render(result.body)
    measureLine(ctx, "stdout")
  }
  return 0
}

export async function signalsScorecard(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--date"] })
  if ("error" in parsed) return usage(ctx, `${parsed.error}\n${SCORECARD_USAGE}`)
  const date = parsed.values["--date"]
  if (parsed.positionals.length || (date !== undefined && !isScorecardDate(date))) return usage(ctx, SCORECARD_USAGE)
  const hacc = await client(ctx)
  if (!hacc) return 1
  return answer(ctx, await hacc.scorecard(date), (body) => {
    const window = object(body.window)
    const universes = Array.isArray(body.baseline_universes) ? body.baseline_universes.map(text).join(", ") : "—"
    writeFields(
      ctx.deps,
      "stdout",
      [
        ["Date", text(body.date)],
        ["As of", text(body.as_of)],
        ["Window", `${text(window.from)} to ${text(window.to)}`],
        ["Signal lift (24h)", percent(body.signal_lift, true)],
        ["Signal pairs", text(body.signal_pairs)],
        ["Pending 24h", text(body.pending_24h)],
        ["Baselines", universes || "—"],
      ],
      "hacc scorecard",
    )
    const rows = Array.isArray(body.rows) ? body.rows.map(object) : []
    ctx.deps.stdout.write("\n")
    if (!rows.length) {
      ctx.deps.stdout.write("No scorecard rows for this day.\n")
      return
    }
    writeTable(
      ctx.deps,
      "stdout",
      [
        "Source",
        "Rule",
        "Variant",
        "Horizon",
        "Count",
        "Coverage",
        "Mean (conservative)",
        "Mean (priced)",
        "Baseline",
        "Lift",
        "2x/5x/20x",
        "Delay p50/p95 s",
        "Marked",
      ],
      rows.map((row) => [
        text(row.source),
        text(row.rule_id),
        text(row.variant),
        text(row.horizon),
        text(row.count),
        percent(row.coverage),
        percent(row.mean_conservative, true),
        percent(row.mean_priced, true),
        percent(row.baseline_mean, true),
        percent(row.lift, true),
        `${text(row.tail_2x)}/${text(row.tail_5x)}/${text(row.tail_20x)}`,
        `${text(row.delay_p50_s)}/${text(row.delay_p95_s)}`,
        [row.shadow === true ? "shadow" : "", row.backfilled === true ? "backfilled" : ""].filter(Boolean).join(", ") ||
          "—",
      ]),
      [
        {},
        { priority: 6 },
        { priority: 5 },
        {},
        {},
        {},
        {},
        { priority: 3 },
        {},
        {},
        { priority: 4 },
        { priority: 1 },
        {},
      ],
    )
  })
}

function integerFlag(value: string | undefined, min: number, max: number): number | undefined | null {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null
}

export async function signalsRecords(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--source", "--before", "--limit"] })
  if ("error" in parsed) return usage(ctx, `${parsed.error}\n${RECORDS_USAGE}`)
  const v = parsed.values
  const source = v["--source"]
  const before = integerFlag(v["--before"], 1, Number.MAX_SAFE_INTEGER)
  const limit = integerFlag(v["--limit"], 1, RECORDS_LIMIT_MAX)
  if (
    parsed.positionals.length ||
    (source !== undefined && !isRecordSource(source)) ||
    before === null ||
    limit === null
  )
    return usage(ctx, RECORDS_USAGE)
  const hacc = await client(ctx)
  if (!hacc) return 1
  const query = {
    ...(source !== undefined && isRecordSource(source) ? { source } : {}),
    ...(before !== undefined ? { before } : {}),
    ...(limit !== undefined ? { limit } : {}),
  }
  return answer(ctx, await hacc.records(query), (body) => {
    const records = Array.isArray(body.records) ? body.records.map(object) : []
    if (!records.length) ctx.deps.stdout.write("No signal records on this page.\n")
    else
      writeTable(
        ctx.deps,
        "stdout",
        [
          "Source",
          "Id",
          "Variant",
          "Chain",
          "Emitted",
          "Entry",
          "24h status",
          "Net 24h (conservative)",
          "Net 24h (priced)",
          "Max multiple",
          "Baseline 24h",
          "Backfilled",
        ],
        records.map((record) => [
          text(record.source),
          text(record.source_id),
          text(record.variant),
          text(record.chain),
          text(record.emitted_at),
          text(record.entry_status),
          text(object(record.outcome_status)["24h"]),
          percent(object(record.net_return_conservative)["24h"], true),
          percent(object(record.net_return_priced)["24h"], true),
          text(object(record.path_24h).max_multiple),
          percent(object(object(record.baseline).net_return_conservative)["24h"], true),
          bool(record.backfilled),
        ]),
        [
          { id: true },
          { id: true },
          { priority: 3 },
          { priority: 4 },
          { priority: 6 },
          { priority: 2 },
          { priority: 5 },
          {},
          { priority: 1 },
          { priority: 2 },
          { priority: 5 },
          {},
        ],
      )
    if (typeof body.next_before === "number") {
      ctx.deps.stdout.write(
        `\nNext page: candle signals records --before ${body.next_before}${source ? ` --source ${source}` : ""}\n`,
      )
    }
  })
}

export async function signalsRecord(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {})
  if ("error" in parsed) return usage(ctx, `${parsed.error}\n${RECORD_USAGE}`)
  const [source, sourceId] = parsed.positionals
  if (parsed.positionals.length !== 2 || !isRecordSource(source) || !sourceId || sourceId.length > 128)
    return usage(ctx, RECORD_USAGE)
  const hacc = await client(ctx)
  if (!hacc) return 1
  return answer(ctx, await hacc.record(source, sourceId), (record) => {
    const path = object(record.path_24h)
    const baseline = object(record.baseline)
    writeFields(
      ctx.deps,
      "stdout",
      [
        ["Source", text(record.source)],
        ["Id", text(record.source_id)],
        ["Variant", text(record.variant)],
        ["Chain", text(record.chain)],
        ["Emitted", text(record.emitted_at)],
        ["Backfilled", bool(record.backfilled)],
        ["Entry", text(record.entry_status)],
      ],
      "hacc signal record",
    )
    ctx.deps.stdout.write("\n")
    const status = object(record.outcome_status)
    const conservative = object(record.net_return_conservative)
    const priced = object(record.net_return_priced)
    const baselineNet = object(baseline.net_return_conservative)
    writeTable(
      ctx.deps,
      "stdout",
      ["Horizon", "Status", "Net (conservative)", "Net (priced)", "Baseline (conservative)"],
      HORIZONS.map((h) => [
        h,
        text(status[h]),
        percent(conservative[h], true),
        percent(priced[h], true),
        percent(baselineNet[h], true),
      ]),
      Array.from({ length: 5 }, () => ({})),
    )
    ctx.deps.stdout.write("\n")
    writeFields(ctx.deps, "stdout", [
      ["Max multiple (24h)", text(path.max_multiple)],
      ["Reached 2x/5x/20x", `${bool(path.hit_2x)}/${bool(path.hit_5x)}/${bool(path.hit_20x)}`],
      ["Drawdown before 2x", percent(path.drawdown_before_2x, true)],
      ["24h path settled", bool(path.settled)],
      [
        "Baseline",
        Object.keys(baseline).length ? `${text(baseline.match)} (${text(baseline.universe)})` : "none matched",
      ],
    ])
  })
}
