/**
 * The core's executor (BE-1665, spec K-7): runs one approved card's tool call with the Write key,
 * through the exact tool code `candle mcp` runs (`packages/mcp/src/tools.ts`), in this process.
 *
 * For each call it registers that one tool with the Write key for this call alone, validates the
 * card's `params` against the tool's own schema, and runs the tool's handler with them unchanged
 * (the operation id already in its id field). No key outlives the call here, and no harness ever
 * sees one: the harness proposed the card, the core runs it.
 *
 * Outcomes. A transport failure, or a result that cannot be read, is `unknown`, never `failed`: a
 * request that may have reached the API is not proof that nothing moved (`OPERATION_NOT_FOUND_RULE`).
 * Reconciliation (R) reads `unknown` operations by their id.
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

export function mcpExecutor(options: { apiUrl: string; fetch?: typeof fetch }): Executor {
  return {
    async execute(tool, params, writeKey) {
      // MCP bodies do not retain HTTP status. Remember 5xx responses within this call so an
      // ambiguous server failure cannot become a terminal refusal or failure. A failed
      // best-effort market read after a confirmed launch does not make that launch unknown.
      let serverErrorStatus: number | undefined
      const doFetch = options.fetch ?? globalThis.fetch
      const { registerToolSubset } = await import("../../../mcp/src/tools")
      // A one-tool registry: `registerToolSubset` hands this the definition and handler it would
      // give an MCP server, and the core calls the handler itself. Same code as `candle mcp`, with
      // no protocol hop and no second copy of the MCP SDK in play.
      let captured: { inputSchema: unknown; handler: (args: unknown, extra: unknown) => Promise<unknown> } | undefined
      const registry = {
        registerTool(
          name: string,
          definition: { inputSchema: unknown },
          handler: (args: unknown, extra: unknown) => Promise<unknown>,
        ) {
          if (name === tool) captured = { inputSchema: definition.inputSchema, handler }
          return { enable() {}, disable() {}, remove() {}, update() {} }
        },
      }
      try {
        registerToolSubset(registry as never, {
          tools: [tool as never],
          getConfig: () => ({ apiUrl: options.apiUrl, apiKey: writeKey }),
          fetch: async (url: string, init?: RequestInit) => {
            const response = await doFetch(url, init)
            if (response.status >= 500) serverErrorStatus = response.status
            return response
          },
          env: {},
        })
      } catch (error) {
        return {
          state: "refused",
          error: { code: "TOOL_UNAVAILABLE", message: error instanceof Error ? error.message : String(error) },
        }
      }
      if (captured === undefined)
        return {
          state: "refused",
          error: { code: "TOOL_UNAVAILABLE", message: `${tool} is not registered by the MCP tools.` },
        }
      // The SDK's own step: a raw shape becomes an object schema, and invalid input is refused
      // before the handler runs, so nothing is sent.
      const schema =
        captured.inputSchema instanceof z.ZodType
          ? captured.inputSchema
          : z.object(captured.inputSchema as z.ZodRawShape)
      const parsed = schema.safeParse(params)
      if (!parsed.success) {
        return {
          state: "refused",
          error: {
            code: "MCP_VALIDATION",
            message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          },
        }
      }
      try {
        const result = (await captured.handler(parsed.data, {})) as {
          isError?: boolean
          content?: { type: string; text?: string }[]
        }
        return outcomeOf(result, serverErrorStatus, tool)
      } catch (error) {
        // The request may have left: a throw here is not proof that nothing moved.
        return {
          state: "unknown",
          error: { code: "EXECUTOR_TRANSPORT", message: error instanceof Error ? error.message : String(error) },
        }
      }
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
    return { state: "unknown", error: { code: code ?? "EXECUTOR_SERVER_ERROR", message } }
  }
  if (body === undefined || code === undefined || code === "MCP_TRANSPORT") {
    return { state: "unknown", error: { code: code ?? "UNREADABLE_RESULT", message } }
  }
  // Unrecognised errors do not prove the request never executed.
  return REFUSAL.test(code)
    ? { state: "refused", error: { code, message }, result: body }
    : { state: "unknown", error: { code, message } }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
