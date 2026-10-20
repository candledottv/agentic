/**
 * The core's executor (BE-1665, spec K-7): runs one approved card's tool call with the Write key,
 * through the exact tool code `candle mcp` runs (`packages/mcp/src/tools.ts`), in this process.
 *
 * For each call it registers that one tool with the Write key for this call alone, validates the
 * card's `params` against the tool's own schema, and runs the tool's handler with them unchanged
 * (the operation id already in its id field). No key outlives the call here, and no harness ever
 * sees one: the harness proposed the card, the core runs it.
 *
 * Outcomes. A transport failure, a 5xx, an unrecognised error, or a result that cannot be read is
 * `unknown`, never `failed`: a request that may have reached the API is not proof that nothing
 * moved (`OPERATION_NOT_FOUND_RULE`). Reconciliation (R) reads `unknown` operations by their id.
 */
import { z } from "zod"
import type { ExecutionOutcome, Executor } from "./cards"

const PENDING = new Set([
  "pending",
  "running",
  "built",
  "submitted",
  "confirming",
  "processing",
  "queued",
  "building",
  "broadcasting",
])
/** Refusals at admission: nothing was executed. */
const REFUSAL =
  /^(MCP_VALIDATION|KEY_LIMIT_REACHED|SCOPE_MISSING|AGENT_TRADING_DISABLED|TRADING_DISABLED|PROFILE_PAUSED|UNAUTHORIZED|FORBIDDEN|INVALID_[A-Z_]+|IDEMPOTENCY_CONFLICT)$/

/**
 * S4 L-7 (BE-1680): the headless launch route's own refusals, each confirmed by V-S4-3 to come back
 * in the POST's own response before any chain step, so nothing of the user's ran on chain. Read
 * against `apps/api/src/routes/launch-headless.ts` at staging `cc372a5a`:
 *
 *   - `VALIDATION_FAILED`, `QUOTE_PAIR_UNKNOWN`: the body validator, before `begin`.
 *   - `DEV_BUY_TOO_HIGH`: the platform ceiling before `begin`, or the key's spend limit after it.
 *   - `DAILY_CAP_REACHED`, `EXCLUSIVE_NOT_ELIGIBLE`, `AGENT_WALLET_NOT_EMBEDDED`: gates after `begin`.
 *   - `TRANSACTION_TOO_LARGE`: a Solana build-time error, before signing or broadcast.
 *   - `INSUFFICIENT_OWNER_BALANCE`: every path refuses before the owner's transaction is sent; a
 *     launch that was already broadcast answers `LAUNCH_FAILED` instead. On Hood a platform-paid
 *     splitter deploy may already be on chain, which is Candle's spend, not the user's.
 *
 * Left out because V-S4-3 found the real route never returns them: `TIER_REQUIRED` (self and
 * atomic routes only) and every `IMAGE_*` code (the real route reports a bad image as
 * `LAUNCH_FAILED`, a 500). Those stay `unknown`, as any unlisted code does.
 */
const LAUNCH_REFUSAL =
  /^(VALIDATION_FAILED|DEV_BUY_TOO_HIGH|DAILY_CAP_REACHED|AGENT_WALLET_NOT_EMBEDDED|QUOTE_PAIR_UNKNOWN|EXCLUSIVE_NOT_ELIGIBLE|TRANSACTION_TOO_LARGE|INSUFFICIENT_OWNER_BALANCE)$/
const LAUNCH_TOOLS = new Set(["candle_launch_token", "candle_launch_and_seed"])

/** Whether `code` from `tool` is a refusal at admission: nothing was executed. */
export function isRefusal(code: string, tool?: string): boolean {
  return REFUSAL.test(code) || (tool !== undefined && LAUNCH_TOOLS.has(tool) && LAUNCH_REFUSAL.test(code))
}

/** A tool result exactly as `candle mcp` would hand it to an MCP client. */
export interface ToolResult {
  isError?: boolean
  content?: { type: string; text?: string }[]
}

/** A tool's definition as `candle mcp` registers it, for the `candle core mcp` face (A-5). */
export interface ToolDefinition {
  name: string
  title?: string
  description?: string
  inputSchema: unknown
  annotations?: unknown
}

type Captured = ToolDefinition & { handler: (args: unknown, extra: unknown) => Promise<unknown> }

/**
 * Registers `tools` through `packages/mcp`'s own `registerToolSubset` into a capturing registry:
 * the definitions and handlers it would give an MCP server, configured with `apiKey`. Every
 * response the tools receive passes `onResponse` first.
 */
async function capture(
  tools: readonly string[],
  options: { apiUrl: string; apiKey: string; fetch?: typeof fetch; onResponse?: (response: Response) => void },
): Promise<Map<string, Captured>> {
  const { registerToolSubset } = await import("../../../mcp/src/tools")
  const captured = new Map<string, Captured>()
  const registry = {
    registerTool(
      name: string,
      definition: { title?: string; description?: string; inputSchema: unknown; annotations?: unknown },
      handler: (args: unknown, extra: unknown) => Promise<unknown>,
    ) {
      captured.set(name, { name, ...definition, handler })
      return { enable() {}, disable() {}, remove() {}, update() {} }
    },
  }
  const doFetch = options.fetch
  const observe = options.onResponse
  registerToolSubset(registry as never, {
    tools: tools as never,
    getConfig: () => ({ apiUrl: options.apiUrl, apiKey: options.apiKey }),
    ...(doFetch || observe
      ? {
          fetch: async (url: string, init?: RequestInit) => {
            const response = await (doFetch ?? globalThis.fetch)(url, init)
            observe?.(response)
            return response
          },
        }
      : {}),
    env: {},
  })
  return captured
}

/** The definitions of `tools` as `candle mcp` registers them. No key is involved. */
export async function toolDefinitions(tools: readonly string[]): Promise<ToolDefinition[]> {
  const captured = await capture(tools, { apiUrl: "https://api.candle.tv", apiKey: "" })
  return [...captured.values()].map(({ handler: _handler, ...definition }) => definition)
}

/** The object schema a definition's input becomes, as the MCP SDK builds it. */
export function inputObject(inputSchema: unknown): z.ZodTypeAny {
  return inputSchema instanceof z.ZodType ? inputSchema : z.object(inputSchema as z.ZodRawShape)
}

export type CallAnswer =
  | { kind: "result"; result: ToolResult }
  | { kind: "refused"; code: string; message: string }
  | { kind: "thrown"; message: string }

export interface McpExecutor extends Executor {
  /** One call, its result unmapped: what a read through the A-5 face relays. */
  call(
    tool: string,
    params: Record<string, unknown>,
    key: string,
    onResponse?: (response: Response) => void,
  ): Promise<CallAnswer>
}

export function mcpExecutor(options: { apiUrl: string; fetch?: typeof fetch }): McpExecutor {
  const call = async (
    tool: string,
    params: Record<string, unknown>,
    key: string,
    onResponse?: (response: Response) => void,
  ): Promise<CallAnswer> => {
    let captured: Captured | undefined
    try {
      captured = (await capture([tool], { apiUrl: options.apiUrl, apiKey: key, fetch: options.fetch, onResponse })).get(
        tool,
      )
    } catch (error) {
      return {
        kind: "refused",
        code: "TOOL_UNAVAILABLE",
        message: error instanceof Error ? error.message : String(error),
      }
    }
    if (captured === undefined) {
      return { kind: "refused", code: "TOOL_UNAVAILABLE", message: `${tool} is not registered by the MCP tools.` }
    }
    // The SDK's own step: invalid input is refused before the handler runs, so nothing is sent.
    const parsed = inputObject(captured.inputSchema).safeParse(params)
    if (!parsed.success) {
      return {
        kind: "refused",
        code: "MCP_VALIDATION",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      }
    }
    try {
      return { kind: "result", result: (await captured.handler(parsed.data, {})) as ToolResult }
    } catch (error) {
      return { kind: "thrown", message: error instanceof Error ? error.message : String(error) }
    }
  }
  return {
    call,
    async execute(tool, params, writeKey) {
      // MCP bodies do not retain HTTP status. Remember 5xx responses within this call so an
      // ambiguous server failure cannot become a terminal refusal or failure.
      let serverErrorStatus: number | undefined
      const answer = await call(tool, params, writeKey, (response) => {
        if (response.status >= 500) serverErrorStatus = response.status
      })
      if (answer.kind === "refused") return { state: "refused", error: { code: answer.code, message: answer.message } }
      // The request may have left: a throw here is not proof that nothing moved.
      if (answer.kind === "thrown")
        return { state: "unknown", error: { code: "EXECUTOR_TRANSPORT", message: answer.message }, transient: true }
      return outcomeOf(answer.result, serverErrorStatus, tool)
    },
  }
}

/** Maps a tool result to an operation outcome. Exported for the tests. */
export function outcomeOf(
  result: { isError?: boolean; content?: { type: string; text?: string }[] },
  serverErrorStatus?: number,
  tool?: string,
): ExecutionOutcome {
  const text = result.content?.find((block) => block.type === "text")?.text ?? ""
  let body: Record<string, unknown> | undefined
  try {
    const parsed = JSON.parse(text) as unknown
    body = record(parsed)
  } catch {}
  // Multi-call handlers wrap the API answer under `api` (trade and launch errors) or
  // `launch` (launch success). Keep the whole body as evidence, classify the nested answer.
  const payload =
    body && Object.hasOwn(body, "api")
      ? record(body.api)
      : body && Object.hasOwn(body, "launch")
        ? record(body.launch)
        : body
  if (result.isError !== true) {
    if (payload === undefined)
      return {
        state: "unknown",
        error: { code: "UNREADABLE_RESULT", message: "The tool answered with something that is not JSON." },
        transient: true,
      }
    const job = record(payload.job)
    const status = String(payload.status ?? job?.status ?? "").toLowerCase()
    // A successful operation lookup returns a record for reconciliation to interpret, even
    // when that record describes a failed write. Only a write's own answer is a failed action.
    if (status === "failed" && tool !== "candle_get_operation") {
      const error = record(payload.error) ?? record(job?.error)
      return {
        state: "failed",
        error: {
          code: typeof error?.code === "string" ? error.code : "OPERATION_FAILED",
          message: typeof error?.message === "string" ? error.message : "The API recorded a failed operation.",
        },
        result: body,
      }
    }
    return { state: PENDING.has(status) ? "pending" : "succeeded", result: body }
  }
  const error = (payload?.error ?? {}) as { code?: unknown; message?: unknown }
  const code =
    typeof error.code === "string" ? error.code : typeof payload?.code === "string" ? payload.code : undefined
  const message = typeof error.message === "string" ? error.message : text.slice(0, 500)
  if (serverErrorStatus !== undefined && serverErrorStatus >= 500) {
    return { state: "unknown", error: { code: code ?? "EXECUTOR_SERVER_ERROR", message }, transient: true }
  }
  if (body === undefined || code === undefined || code === "MCP_TRANSPORT") {
    return { state: "unknown", error: { code: code ?? "UNREADABLE_RESULT", message }, transient: true }
  }
  // Unrecognised errors do not prove the request never executed.
  return isRefusal(code, tool)
    ? { state: "refused", error: { code, message }, result: body }
    : { state: "unknown", error: { code, message }, result: body }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
