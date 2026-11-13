/**
 * hacc's scorecard and signal records as MCP tools (BE-3411, hacc north-star CL1): the
 * `candle_signal_scorecard`, `candle_signal_records` and `candle_signal_record` entries of hacc's
 * generated `docs/generated/mcp-tools.json` (wallet-track C2, 321723e5). Names, titles, input
 * schemas (strict, as the catalog's `additionalProperties: false`) and annotations are the
 * catalog's; the descriptions are the catalog's with the key requirement appended.
 *
 * Read with the configured production key through `./signal-records`, the byte-identical copy of
 * the CLI's client that `candle signals` also uses. Three GETs; nothing written, traded or moved.
 *
 * Stdio only, as the strategy lab tools are: the hosted server never registers these, since it
 * would make Candle's API call hacc for the member (apps/api/src/mcp/hosted.ts).
 *
 * Every result, success or error, is one JSON text carrying `measure: "Measured record, not a
 * forecast."`: hacc's body as sent (the fixed line set if it was missing) on success; on a refusal
 * `{ error, code, status?, body?, measure }`.
 */
import { z } from "zod"
import type { RequestConfig } from "./client"
import type { FetchLike } from "./orchestrate"
import {
  createSignalRecordsClient,
  MEASURE,
  RECORD_SOURCES,
  RECORDS_LIMIT_MAX,
  type RecordSource,
  type SignalRecordsAnswer,
  type SignalRecordsClient,
  SOURCE_ID_MAX,
} from "./signal-records"

export type SignalRecordToolName = "candle_signal_scorecard" | "candle_signal_records" | "candle_signal_record"

export interface SignalRecordToolResult {
  text: string
  isError: boolean
}

/** The same sentence `candle signals` prints. */
export const SIGNAL_RECORDS_PRODUCTION_KEY_MESSAGE =
  "Signal records need a production agent key. Create one with `candle keys create`."

/** The catalog's annotations for all three, unchanged. */
export const SIGNAL_RECORD_ANNOTATIONS = { readOnlyHint: true, openWorldHint: true } as const

/** The catalog's titles. */
export const SIGNAL_RECORD_TITLES: Record<SignalRecordToolName, string> = {
  candle_signal_scorecard: "hacc signal scorecard",
  candle_signal_records: "hacc signal records",
  candle_signal_record: "hacc signal record",
}

/**
 * The SDK rejects invalid input before invoking the handler, then returns a thrown Error's
 * message as tool-result text. Throw the measured JSON refusal from Zod's error map so that
 * schema failures have the same envelope as handler failures. Apply this only to these tools,
 * on both the object and its fields; validation and the advertised catalog schema stay strict.
 */
export const signalRecordValidationErrorMap: z.ZodErrorMap = (issue, ctx) => {
  const detail = z.defaultErrorMap(issue, ctx).message
  const path = issue.path.length ? `${issue.path.join(".")}: ` : ""
  throw new Error(refusal("SIGNAL_RECORDS_INVALID_ARGUMENTS", `Invalid arguments: ${path}${detail}`).text)
}
const validationParams: z.RawCreateParams = {
  errorMap: (issue, ctx) => {
    // JSON Schema generation probes each field with bare undefined via isOptional(). Let that
    // probe return a normal Zod failure so required fields stay advertised as required. During
    // object validation a missing field has its field name in issue.path and is measured below.
    if (ctx.data === undefined && issue.path.length === 0) return z.defaultErrorMap(issue, ctx)
    return signalRecordValidationErrorMap(issue, ctx)
  },
}
const source = z.enum(RECORD_SOURCES as unknown as [RecordSource, ...RecordSource[]], validationParams)

export const signalRecordShapes = {
  candle_signal_scorecard: {
    date: z.string(validationParams).date().optional().describe("YYYY-MM-DD; absent is the latest."),
  },
  candle_signal_records: {
    source: source.optional(),
    before: z.number(validationParams).int().min(1).optional().describe("The previous page's next_before."),
    limit: z.number(validationParams).int().min(1).max(RECORDS_LIMIT_MAX).default(50),
  },
  candle_signal_record: {
    source,
    source_id: z
      .string(validationParams)
      .min(1)
      .max(SOURCE_ID_MAX)
      .describe("The source's own id: the signal id for pattern, chain:mint for launch_read."),
  },
} satisfies Record<SignalRecordToolName, z.ZodRawShape>

const FIXED_LINE_NOTE =
  ' Every response carries measure: "Measured record, not a forecast." Quote that line with any figure you take from ' +
  "it. A record is a fact, never a forecast or advice."
const KEY_NOTE =
  " Needs a production agent key (cndl_live_), sent to hacc as a Bearer; read-only. Optional CANDLE_HACC_URL " +
  "overrides https://api.hacc.fun (https only)."

/** The catalog's descriptions, word for word, then the key requirement. */
export const SIGNAL_RECORD_DESCRIPTIONS: Record<SignalRecordToolName, string> = {
  candle_signal_scorecard:
    "The daily hacc scorecard's signal aggregates: signal lift against the matched baseline, and per source, rule " +
    `and horizon counts, mean net returns, tails and delay.${FIXED_LINE_NOTE}${KEY_NOTE}`,
  candle_signal_records:
    "Per-signal measured records, newest first: marks, conservative and priced net returns, the 24 h path and the " +
    `matched baseline.${FIXED_LINE_NOTE}${KEY_NOTE}`,
  candle_signal_record: `One signal's measured record.${FIXED_LINE_NOTE}${KEY_NOTE}`,
}

function refusal(code: string, error: string): SignalRecordToolResult {
  return { text: JSON.stringify({ error, code, measure: MEASURE }), isError: true }
}

function answerText(answer: SignalRecordsAnswer): SignalRecordToolResult {
  if (answer.ok) return { text: JSON.stringify(answer.body), isError: false }
  const { status, code, message, body } = answer.refusal
  return {
    text: JSON.stringify({ error: message, code, ...(status ? { status, body } : {}), measure: MEASURE }),
    isError: true,
  }
}

export async function executeSignalRecordTool(
  name: SignalRecordToolName,
  args: Record<string, unknown>,
  cfg: RequestConfig,
  env: Record<string, string | undefined>,
  doFetch: FetchLike,
): Promise<SignalRecordToolResult> {
  const apiKey = cfg.apiKey
  if (!apiKey?.startsWith("cndl_live_")) {
    return refusal("SIGNAL_RECORDS_PRODUCTION_KEY_REQUIRED", SIGNAL_RECORDS_PRODUCTION_KEY_MESSAGE)
  }
  let hacc: SignalRecordsClient
  try {
    hacc = createSignalRecordsClient({
      apiKey,
      apiUrl: env.CANDLE_HACC_URL?.trim() || undefined,
      fetch: doFetch as unknown as typeof fetch,
    })
  } catch {
    return refusal(
      "SIGNAL_RECORDS_URL_INVALID",
      "Signal records need a valid HTTPS CANDLE_HACC_URL without credentials, query or fragment.",
    )
  }
  switch (name) {
    case "candle_signal_scorecard":
      return answerText(await hacc.scorecard((args as { date?: string }).date))
    case "candle_signal_records": {
      const a = args as { source?: RecordSource; before?: number; limit?: number }
      return answerText(await hacc.records({ source: a.source, before: a.before, limit: a.limit }))
    }
    case "candle_signal_record": {
      const a = args as { source: RecordSource; source_id: string }
      return answerText(await hacc.record(a.source, a.source_id))
    }
  }
}
