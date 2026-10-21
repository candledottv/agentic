/**
 * `candle core mcp` (BE-1665, spec A-5): a stdio MCP server any harness can run unmodified, which
 * attaches to the running Candle core as role `harness` and relays every tool call to it.
 *
 * Same tool names, titles, descriptions and schemas as `candle mcp`, taken from the same
 * `packages/mcp` registrations, plus the core's own reads (`candle_get_signals`, S5 G-2), and with
 * one documented superset: `candle_get_operation`'s `kind` also
 * accepts the core's own kinds (swap, stake, claim, perps, profile). The core decides everything
 * else: a money write answers `APPROVAL_REQUIRED` with its card and operation id instead of
 * executing, paper passes through, transfers are not offered.
 *
 * This process holds no Candle credential and reads no secret store: its only credential is the
 * harness token the user pasted into this harness's config (`--token`, or `CANDLE_CORE_TOKEN` to
 * keep it off the process list), and that token can only read and propose (A-2, A-3).
 */
import { z } from "zod"
import { parseArgs } from "../args"
import { isCoreLocalTool } from "../core/classify"
import { CoreClientError, type CoreConnection, connectCore } from "../core/client"
import { coreLocalDefinitions } from "../core/core-local-tools"
import { inputObject, type ToolDefinition, type ToolResult, toolDefinitions } from "../core/executor"
import { corePaths } from "../core/paths"
import { CORE_OPERATION_KINDS } from "../core/tools-face"
import type { CommandContext } from "../deps"
import { writeLocalFailure, writeUsageFailure } from "../render"
import { CLI_VERSION } from "../version"

const USAGE = "Usage: candle core mcp [--token <harness token>] [--harness <kind>]"

/** The MCP `instructions` this face sends (A-5): how to read an answer that is not a refusal. */
export const CORE_MCP_INSTRUCTIONS = `This is the Candle core: the same Candle tools as candle mcp, attached to the user's Candle TUI.

MONEY WRITES WAIT FOR THE USER. A live trade, swap, stake, claim, launch or profile write does not run when you call it. It becomes an approval card the user approves in the Candle TUI with their own factor. The answer comes back at once:
  success: false, error.code: "APPROVAL_REQUIRED", cardId, the tool's id field (clientTradeId, clientSwapId, ...), kind, next
That is not a refusal and not a failure. Do not retry it, and never send it again under a new id: a new id is a second trade. Read the state with candle_get_operation {clientId: <that id>, kind: <that kind>}. It answers awaiting_approval, then the outcome once the user approves. Only rejected and expired are final, and you do not propose that action again unless the user asks.

Sending the same request with the same id again is always safe: it returns the current state, never a second card or a second write. The same id with different parameters is refused (OP_ID_CONFLICT).

OUTCOME_UNKNOWN means Candle could not confirm a write. It is not proof that nothing moved. Do not propose it again; the user resolves it in the TUI.

Paper trades (candle_trade with paper: true) and launch dry runs run at once, with no card. They need trading on, and a paper window the user opened in the TUI.

Transfers are not offered here. Only the user starts a transfer, in the TUI.`

export interface CoreMcpServer {
  connect(transport: unknown): Promise<void>
  close(): Promise<void>
}

/**
 * Builds the MCP server over an attached core connection: one registration per tool the core
 * offers this harness, each relaying to the core's `tools.call`.
 */
export async function buildCoreMcpServer(connection: CoreConnection): Promise<CoreMcpServer> {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js")
  const offered = (await connection.request<{ tools: { name: string }[] }>("tools.list")).tools.map((tool) => tool.name)
  // S5 G-2: the core's own reads (candle_get_signals) carry the core's definitions, not packages/mcp's.
  const definitions = [
    ...(await toolDefinitions(offered.filter((name) => !isCoreLocalTool(name)))),
    ...coreLocalDefinitions().filter((definition) => offered.includes(definition.name)),
  ]
  const server = new McpServer({ name: "candle-core", version: CLI_VERSION }, { instructions: CORE_MCP_INSTRUCTIONS })
  for (const definition of definitions) {
    const inputSchema = definition.name === "candle_get_operation" ? operationShape(definition) : definition.inputSchema
    ;(server.registerTool as (...a: unknown[]) => unknown)(
      definition.name,
      {
        ...(definition.title ? { title: definition.title } : {}),
        ...(definition.description ? { description: definition.description } : {}),
        inputSchema,
        ...(definition.annotations ? { annotations: definition.annotations } : {}),
      },
      async (args: Record<string, unknown>) => relayToCore(connection, definition.name, args),
    )
  }
  return server as unknown as CoreMcpServer
}

/** The superset (A-5): `kind` also takes every kind the core issues ids for. */
function operationShape(definition: ToolDefinition): z.ZodRawShape {
  const base = inputObject(definition.inputSchema) as z.AnyZodObject
  return {
    ...base.shape,
    kind: z
      .enum(CORE_OPERATION_KINDS)
      .describe(
        "trade or launch, as candle mcp takes; on the Candle core also swap, stake, claim, perps or profile, for ids the core issued",
      ),
  }
}

async function relayToCore(
  connection: CoreConnection,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    return await connection.request<ToolResult>("tools.call", { name, args })
  } catch (error) {
    const code = error instanceof CoreClientError ? error.code : "CORE_CALL_FAILED"
    const message = error instanceof Error ? error.message : String(error)
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: false,
            error: { code, message },
            next: "If this was a write, read candle_get_operation with the same id before doing anything else; never resend under a new id.",
          }),
        },
      ],
      isError: true,
    }
  }
}

export async function coreMcp(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, json } = ctx
  const parsed = parseArgs(args, { valueFlags: ["--token", "--harness"] })
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}\n${USAGE}`, json)
    return 2
  }
  const token = parsed.values["--token"] ?? deps.env.CANDLE_CORE_TOKEN?.trim()
  if (!token) {
    writeUsageFailure(
      deps,
      `A harness token is required: --token, or CANDLE_CORE_TOKEN. Mint one in the Candle TUI (Agents > Connect a harness).\n${USAGE}`,
      json,
    )
    return 2
  }
  if (ctx.profile === undefined) {
    writeLocalFailure(
      deps,
      {
        code: "CORE_PROFILE_REQUIRED",
        message: "The Candle core runs for one profile, and none is in play.",
        suggestion: "Name one with --profile.",
      },
      json,
    )
    return 1
  }
  const paths = corePaths(deps.env, deps.homedir(), ctx.profile)
  let connection: CoreConnection
  try {
    connection = (
      await connectCore({
        socketPath: paths.socket,
        token,
        clientName: "candle core mcp",
        harnessKind: parsed.values["--harness"] ?? "mcp",
      })
    ).connection
  } catch (error) {
    if (!(error instanceof CoreClientError)) throw error
    // stdout belongs to MCP once a harness runs this, so the failure goes to stderr in both modes.
    deps.stderr.write(`${error.code}: ${error.message}\n`)
    return 1
  }
  const server = await buildCoreMcpServer(connection)
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js")
  connection.onClose(() => void server.close())
  await server.connect(new StdioServerTransport())
  return 0
}
