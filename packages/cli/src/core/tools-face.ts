/**
 * The core's tool face (BE-1665, spec A-5): `tools.list` and `tools.call`, which `candle core mcp`
 * relays to any harness, and which the bundled Pi harness calls directly. One path, not two.
 *
 * Every call is classified (`classify.ts`) before anything runs:
 *   - a read passes through to the API with the core's Read key, and its answer is relayed as is;
 *   - a paper trade (`candle_trade` with `paper: true`) or a launch dry run runs at once, with no
 *     card, using the Write key held by a paper window (the Write key is sealed under the vault on
 *     this build, so the user opens that window once with the factor); trading off is `TRADING_OFF`;
 *   - a money write becomes a card and answers `APPROVAL_REQUIRED` at once, never executing;
 *   - a transfer is refused (`TRANSFER_USER_ONLY`) and never listed;
 *   - an unclassified tool is refused (`TOOL_NOT_CLASSIFIED`).
 *
 * A write naming an operation id the core holds is a read of that card or operation (A-5, R-4), and
 * `candle_get_operation` answers from the card first, for every kind the core issued.
 */

import { canonicalJson } from "../vault/canonical-json"
import type { Card, CardBook, CardOrigin, Operation } from "./cards"
import { CORE_LOCAL_TOOLS, classifyCall, isCoreLocalTool, TOOL_CLASSES } from "./classify"
import type { CallAnswer, McpExecutor, ToolResult } from "./executor"
import type { Journal } from "./journal"
import { invalidParams, RpcError } from "./rpc"
import type { CoreServer } from "./server"
import type { TradingState } from "./trading"

/** The kinds `candle_get_operation` accepts on this face: `candle mcp`'s two, plus every core kind. */
export const CORE_OPERATION_KINDS = ["trade", "launch", "swap", "stake", "claim", "perps", "profile"] as const

/** What the face offers: every classified tool but the transfers (K-3), and the core's own reads (S5 G-2). */
export function offeredTools(): { name: string; class: "read" | "card"; kind?: string; idKey?: string }[] {
  return [...Object.entries(TOOL_CLASSES), ...Object.entries(CORE_LOCAL_TOOLS)]
    .filter(([, cls]) => !(cls.class === "card" && cls.kind === "transfer"))
    .map(([name, cls]) =>
      cls.class === "card"
        ? { name, class: "card" as const, kind: cls.kind, idKey: cls.idKey }
        : { name, class: "read" as const },
    )
}

const text = (body: unknown, isError = false): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(body) }],
  ...(isError ? { isError: true } : {}),
})

const refusal = (code: string, message: string, extra: Record<string, unknown> = {}): ToolResult =>
  text({ success: false, error: { code, message }, ...extra }, true)

const NEXT_PENDING = (kind: string, idKey: string) =>
  `The user must approve this in the Candle TUI. Read the outcome with candle_get_operation using this id (kind: ${kind}). Never send it again under a new id; to retry, send the same request with the same ${idKey}.`
const NEXT_FINAL = "Final. Do not propose this again unless the user asks."
const NEXT_UNKNOWN = "Do not propose this again; the user is resolving it in the Candle TUI."

/** The answer for a card and its operation, in whatever state they are (A-5). */
export function cardAnswer(card: Card & { operation?: Operation }): ToolResult {
  const ids = { cardId: card.cardId, [card.idKey]: card.opId, opId: card.opId, kind: card.kind }
  const op = card.operation
  if (op === undefined) {
    if (card.state === "awaiting_approval" || card.state === "proposed") {
      return text({
        success: false,
        error: {
          code: "APPROVAL_REQUIRED",
          message: "A card awaits the user's approval. This is not a refusal and not a failure.",
        },
        ...ids,
        state: "awaiting_approval",
        expiresAt: card.expiresAt,
        next: NEXT_PENDING(card.kind, card.idKey),
      })
    }
    // S4 L-4: a launch whose dry run failed is withdrawn by the core, with the API's answer.
    const checks = card.display.checks as { dryRun?: unknown; error?: unknown } | undefined
    if (card.state === "withdrawn" && checks?.dryRun === "failed") {
      return text({
        success: false,
        error: { code: "DRY_RUN_FAILED", message: "The launch's dry run failed, so the card was withdrawn." },
        api: { error: checks.error ?? null },
        ...ids,
        state: card.state,
        next: "Fix what the dry run names, then propose the launch again under a new clientLaunchId.",
      })
    }
    return text({
      success: false,
      error: { code: `CARD_${card.state.toUpperCase()}`, message: `The card was ${card.state}.` },
      ...ids,
      state: card.state,
      next: NEXT_FINAL,
    })
  }
  if (op.state === "succeeded") return text({ success: true, ...ids, state: op.state, result: op.result ?? null })
  if (op.state === "submitting" || op.state === "pending") {
    return text({
      success: false,
      error: { code: "OPERATION_PENDING", message: "Approved and running." },
      ...ids,
      state: op.state,
      next: `Read it again with candle_get_operation (kind: ${card.kind}).`,
    })
  }
  if (op.state === "failed" || op.state === "refused") {
    return text({
      success: false,
      error: op.error ?? { code: op.state.toUpperCase(), message: op.state },
      ...ids,
      state: op.state,
      result: op.result ?? null,
      next: NEXT_FINAL,
    })
  }
  return text({
    success: false,
    error: { code: "OUTCOME_UNKNOWN", message: "Candle could not confirm this. It is not proof that nothing moved." },
    ...ids,
    state: op.state,
    next: op.state === "unknown" ? NEXT_UNKNOWN : NEXT_FINAL,
  })
}

function relay(answer: CallAnswer): ToolResult {
  if (answer.kind === "result") return answer.result
  if (answer.kind === "refused") return refusal(answer.code, answer.message)
  return refusal("CORE_CALL_FAILED", answer.message)
}

export function registerToolFace(
  server: CoreServer,
  deps: {
    cards: CardBook
    trading: TradingState
    executor: McpExecutor
    journal: Journal
    readKey: () => string | undefined
    /** S5 G-2: the tools the core answers itself (`CORE_LOCAL_TOOLS`), never the executor. */
    coreLocal?: (name: string, args: Record<string, unknown>) => Promise<ToolResult>
  },
): void {
  server.handle("tools.list", async () => ({ tools: offeredTools() }))
  server.handle("tools.call", async (params, { client }) => {
    const name = params.name
    const args = params.args ?? {}
    if (typeof name !== "string" || name.length === 0 || name.length > 64) throw invalidParams("name must name a tool.")
    if (args === null || typeof args !== "object" || Array.isArray(args)) throw invalidParams("args must be an object.")
    const callArgs = args as Record<string, unknown>
    const origin: CardOrigin = {
      clientId: client.clientId,
      role: client.role,
      clientName: client.clientName,
      ...(client.harnessKind !== undefined ? { harnessKind: client.harnessKind } : {}),
    }
    const verdict = classifyCall(name, callArgs)
    if (verdict.class === "unclassified") {
      await deps.journal.append({
        type: "tool.refused",
        clientId: client.clientId,
        tool: name,
        code: "TOOL_NOT_CLASSIFIED",
      })
      return refusal("TOOL_NOT_CLASSIFIED", `${name} is not a tool this core has classified, so it is refused.`)
    }
    if (verdict.class === "card" && verdict.kind === "transfer") {
      await deps.journal.append({
        type: "tool.refused",
        clientId: client.clientId,
        tool: name,
        code: "TRANSFER_USER_ONLY",
      })
      return refusal("TRANSFER_USER_ONLY", "Only you can start a transfer, from the Candle TUI.")
    }
    // S5 G-2: a core-local read is answered here, before the executor, and needs no key.
    if (isCoreLocalTool(name)) {
      if (deps.coreLocal === undefined)
        return refusal("METHOD_NOT_AVAILABLE", `${name} is not in this build of the core.`)
      return deps.coreLocal(name, callArgs)
    }
    if (name === "candle_get_operation") return getOperation(callArgs, deps)
    if (verdict.class === "read") {
      const readKey = deps.readKey()
      if (readKey === undefined)
        return refusal("NO_READ_KEY", "The core holds no Read key for this profile. Sign in with candle auth login.")
      return relay(await deps.executor.call(name, callArgs, readKey))
    }
    if (verdict.class === "paper" || verdict.class === "dry_run") {
      // Paper and dry runs never raise a card (invariant 9), and are journaled as paper rows.
      try {
        const answer = await deps.trading.withPaperCredentials((credentials) =>
          deps.executor.call(name, callArgs, credentials.writeKey),
        )
        const result = relay(answer)
        await deps.journal.append({
          type: "paper.call",
          mode: "paper",
          clientId: client.clientId,
          tool: name,
          isError: result.isError === true,
          answer: result.content?.[0]?.text?.slice(0, 2000) ?? null,
        })
        return result
      } catch (error) {
        if (!(error instanceof RpcError)) throw error
        await deps.journal.append({
          type: "paper.refused",
          mode: "paper",
          clientId: client.clientId,
          tool: name,
          code: error.code,
        })
        return refusal(error.code, error.message)
      }
    }
    // A-5, R-4: a write naming an id the core holds is a read of that card or operation, answered
    // in every state, before anything that could refuse a NEW card (no view, trading off).
    const heldId = verdict.idKey === "coreOpId" ? undefined : callArgs[verdict.idKey]
    const held = typeof heldId === "string" ? deps.cards.held(heldId) : undefined
    if (held !== undefined) {
      if (canonicalJson({ tool: held.tool, params: held.params }) !== canonicalJson({ tool: name, params: callArgs })) {
        await deps.journal.append({
          type: "tool.refused",
          clientId: client.clientId,
          tool: name,
          code: "OP_ID_CONFLICT",
        })
        return refusal(
          "OP_ID_CONFLICT",
          "That operation id is held for a different request. Never reuse an id for new parameters.",
          {
            opId: heldId,
          },
        )
      }
      return cardAnswer(held)
    }
    // A money write: a card, and an answer at once. Invariant 10: never with no view to show it.
    if (server.viewCount() === 0) {
      await deps.journal.append({
        type: "tool.refused",
        clientId: client.clientId,
        tool: name,
        code: "NO_VIEW_ATTACHED",
      })
      return refusal("NO_VIEW_ATTACHED", "No Candle TUI view is attached, so no card can be shown. Nothing was queued.")
    }
    try {
      return cardAnswer(await deps.cards.propose({ tool: name, params: callArgs }, origin))
    } catch (error) {
      if (!(error instanceof RpcError)) throw error
      return refusal(error.code, error.message, error.details)
    }
  })
}

/** `candle_get_operation` on the core face: the card or operation first, for any id the core issued. */
async function getOperation(
  args: Record<string, unknown>,
  deps: { cards: CardBook; executor: McpExecutor; readKey: () => string | undefined },
): Promise<ToolResult> {
  const clientId = args.clientId
  const kind = args.kind
  if (typeof clientId !== "string" || clientId.length === 0)
    return refusal("MCP_VALIDATION", "clientId must be a string.")
  if (typeof kind !== "string" || !(CORE_OPERATION_KINDS as readonly string[]).includes(kind)) {
    return refusal("MCP_VALIDATION", `kind is one of ${CORE_OPERATION_KINDS.join(", ")}.`)
  }
  const held = deps.cards.held(clientId)
  if (held !== undefined) return cardAnswer(held)
  if (kind === "trade" || kind === "launch") {
    const readKey = deps.readKey()
    if (readKey === undefined) return refusal("NO_READ_KEY", "The core holds no Read key for this profile.")
    return relay(await deps.executor.call("candle_get_operation", { clientId, kind }, readKey))
  }
  return refusal(
    "OPERATION_NOT_HELD",
    `The core issued no ${kind} operation under this id. A swap the core did not issue is read by replaying it with its clientSwapId.`,
  )
}
