/**
 * The strategy lab tools (BE-2039, strategy lab spec R25): hacc's lab at `api.hacc.fun`, read with
 * the configured agent key through `./lab`, the byte-identical copy of the SDK's lab client that
 * the CLI's `candle lab` also uses.
 *
 * Stdio only. The hosted server never registers these: it would make Candle's API call hacc for
 * the member, which is a proxy Candle does not run (spec 1, non-goals).
 *
 * `candle_lab_replay` submits and returns the job id at once; it never waits out a replay of up to
 * ten minutes inside a tool call. `candle_lab_replay_result` reads the job once. Every success
 * body is hacc's own, lead card included, unchanged. A refusal is hacc's `error` and machine
 * `code` (`lab_plan`, `lab_quota`, `lab_active`, `lab_busy`, `lab_window`) with its HTTP status
 * and complete body. Nothing here has a switch: who may use the lab, and its caps, are hacc's.
 */
import { z } from "zod"
import type { RequestConfig } from "./client"
import { createLabClient, type LabAnswer, type LabClient, type LabRecord, type LabReplayInput } from "./lab"
import type { FetchLike } from "./orchestrate"

export type LabToolName =
  | "candle_lab_status"
  | "candle_lab_replay"
  | "candle_lab_replay_result"
  | "candle_lab_runners"
  | "candle_lab_edges"

export interface LabToolResult {
  text: string
  isError: boolean
}

/** The same sentence `candle lab` prints (spec R22). */
export const LAB_PRODUCTION_KEY_MESSAGE = "The lab needs a production agent key. Create one with `candle keys create`."

/** Said by every lab tool: the lab models the past and moves nothing. */
export const LAB_DISCLOSURE = "Backtests are a model of the past. The lab never trades."

const LAB_KEY =
  " Needs a production agent key (cndl_live_); hacc decides from the key's plan whether the lab is open to it and " +
  "refuses with code lab_plan when it is not. Optional CANDLE_HACC_URL overrides https://api.hacc.fun (https only)."

const costBps = z.number().int().min(0).max(1000)

export const labShapes = {
  candle_lab_status: {},
  candle_lab_replay: {
    definition: z
      .record(z.unknown())
      .describe("The strategy definition as a JSON object, the same one `candle lab replay --definition` reads"),
    from: z.string().min(1).describe("Window start, ISO 8601 with a zone, e.g. 2026-10-20T00:00:00Z"),
    to: z.string().min(1).describe("Window end, ISO 8601 with a zone, after from; at most 14 days after it"),
    asset_ids: z
      .array(z.number().int().positive())
      .min(1)
      .max(50)
      .optional()
      .describe("Up to 50 asset ids to overlay on the replay"),
    fee_bps_per_side: costBps
      .optional()
      .describe(
        "Assumed fee in bps a side for the lead card's net. Omitted: your Candle plan fee, else hacc's default",
      ),
    slippage_bps_per_side: costBps
      .optional()
      .describe("Assumed slippage in bps a side for the lead card's net. Omitted: hacc's default"),
  },
  candle_lab_replay_result: {
    job_id: z
      .union([z.string().min(1).max(128), z.number().int().positive()])
      .describe("The job_id candle_lab_replay returned"),
  },
  candle_lab_runners: {
    hours: z.number().int().min(1).max(48).optional().describe("Look-back in hours"),
    min_wallets: z.number().int().min(1).max(50).optional().describe("Fewest tracked wallets a runner needs"),
  },
  candle_lab_edges: {
    days: z.number().int().min(1).max(30).optional().describe("Look-back in days"),
    min_n: z.number().int().min(1).max(1000).optional().describe("Fewest samples a row needs"),
  },
} satisfies Record<LabToolName, z.ZodRawShape>

export const LAB_DESCRIPTIONS: Record<LabToolName, string> = {
  candle_lab_status:
    "Your strategy lab access: plan, allowed, replays used of today's cap and when it resets (00:00 UTC), the " +
    "active job, the longest window. Call it first. allowed false means this key's plan does not include the " +
    `lab (yet); that is the answer, not a fault.${LAB_KEY}`,
  candle_lab_replay:
    "Submit a strategy replay (backtest) over a window of at most 14 days and return its job_id at once; it " +
    "never waits. A replay runs up to ten minutes: read it with candle_lab_replay_result, no more often than " +
    "every 5 seconds. Every submission counts against today's cap whatever becomes of it, and one job runs at a " +
    "time (lab_active names it). lab_quota carries resets_at; lab_busy carries retry_after_s. " +
    `${LAB_DISCLOSURE} Nothing is promoted to paper or live.${LAB_KEY}`,
  candle_lab_replay_result:
    "Read one replay job once: status pending, running, done or failed, and when done the result. Read " +
    "result.lead_card first when present: did the strategy beat the random-entry control arms, then is " +
    "break_even.cost_bps_per_side above your real cost a side, then the regime label (context only). Report its " +
    "evidence_limitations with any figure. An older result has no lead card; read the summary. " +
    `${LAB_DISCLOSURE}${LAB_KEY}`,
  candle_lab_runners: `The lab's runners table: tokens tracked wallets bought that ran, with peak and current gain.${LAB_KEY}`,
  candle_lab_edges:
    "The lab's edges table: entry patterns with sample counts and median returns, already net of the round-trip " +
    `cost the table states (cost_pct).${LAB_KEY}`,
}

function refusal(code: string, error: string): LabToolResult {
  return { text: JSON.stringify({ error, code }), isError: true }
}

function answerText<T extends LabRecord>(answer: LabAnswer<T>, statusRoute = false): LabToolResult {
  if (answer.ok) return { text: JSON.stringify(answer.body), isError: false }
  const { status, code, message, body } = answer.refusal
  const error = statusRoute && status === 404 ? "The lab on this server predates candle_lab_status." : message
  return { text: JSON.stringify({ error, code, status, ...(body !== undefined ? { body } : {}) }), isError: true }
}

/** The member's Candle fee in bps (spec R21), or undefined when it cannot be read. */
async function memberFeeBps(cfg: RequestConfig, apiKey: string, doFetch: FetchLike): Promise<number | undefined> {
  try {
    const res = await doFetch(`${cfg.apiUrl.replace(/\/$/, "")}/api/v1/agent/tier`, {
      method: "GET",
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return undefined
    const fee = (JSON.parse(await res.text()) as { feeBps?: unknown } | null)?.feeBps
    return typeof fee === "number" && Number.isInteger(fee) && fee >= 0 && fee <= 1_000 ? fee : undefined
  } catch {
    return undefined
  }
}

export async function executeLabTool(
  name: LabToolName,
  args: Record<string, unknown>,
  cfg: RequestConfig,
  env: Record<string, string | undefined>,
  doFetch: FetchLike,
): Promise<LabToolResult> {
  const apiKey = cfg.apiKey
  if (!apiKey?.startsWith("cndl_live_")) return refusal("LAB_PRODUCTION_KEY_REQUIRED", LAB_PRODUCTION_KEY_MESSAGE)
  let lab: LabClient
  try {
    lab = createLabClient({
      apiKey,
      apiUrl: env.CANDLE_HACC_URL?.trim() || undefined,
      fetch: doFetch as unknown as typeof fetch,
    })
  } catch {
    return refusal(
      "LAB_URL_INVALID",
      "The lab needs a valid HTTPS CANDLE_HACC_URL without credentials, query or fragment.",
    )
  }
  switch (name) {
    case "candle_lab_status":
      return answerText(await lab.status(), true)
    case "candle_lab_replay": {
      const a = args as z.infer<z.ZodObject<typeof labShapes.candle_lab_replay>>
      const fee = a.fee_bps_per_side ?? (await memberFeeBps(cfg, apiKey, doFetch))
      const cost = {
        ...(fee !== undefined ? { fee_bps_per_side: fee } : {}),
        ...(a.slippage_bps_per_side !== undefined ? { slippage_bps_per_side: a.slippage_bps_per_side } : {}),
      }
      const body: LabReplayInput = {
        definition: a.definition,
        from: a.from,
        to: a.to,
        ...(a.asset_ids ? { asset_ids: a.asset_ids } : {}),
        ...(Object.keys(cost).length ? { cost } : {}),
      }
      return answerText(await lab.replay(body))
    }
    case "candle_lab_replay_result":
      return answerText(await lab.replayGet((args as { job_id: string | number }).job_id))
    case "candle_lab_runners": {
      const { hours, min_wallets } = args as { hours?: number; min_wallets?: number }
      return answerText(await lab.runners({ hours, min_wallets }))
    }
    case "candle_lab_edges": {
      const { days, min_n } = args as { days?: number; min_n?: number }
      return answerText(await lab.edges({ days, min_n }))
    }
  }
}
