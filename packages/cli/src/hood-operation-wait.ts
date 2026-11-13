import { z } from "zod"
import type { CommandContext } from "./deps"
import { type Json, request, safeText, TradingError } from "./trading"

const WAIT_MS = 10 * 60_000
const POLL_MS = 5_000
const responseSchema = z
  .object({
    operation: z
      .object({
        operationId: z.string(),
        status: z.enum(["active", "completed", "failed", "expired"]),
        plannedLegCount: z.number().int().positive(),
        legs: z.array(z.object({ kind: z.string(), status: z.string() }).passthrough()),
        guard: z.object({ recoveryRequired: z.boolean() }).passthrough().optional(),
        recovery: z.object({ recoveryRequired: z.boolean() }).passthrough().optional(),
      })
      .passthrough(),
  })
  .passthrough()

/** Follow receipts only. Never acquire/release a guard, recover, sign, or resend a leg. */
export async function waitForHoodOperation(
  ctx: CommandContext,
  key: string,
  id: string,
  evidence?: Json,
): Promise<number> {
  const deadline = ctx.deps.now() + WAIT_MS
  const hint = `candle swap status --operation ${safeText(id)}`
  // Bound the HTTP read too: a stalled server must not keep --wait open past its deadline.
  const readCtx = {
    ...ctx,
    deps: {
      ...ctx.deps,
      fetch: ((input, init) =>
        ctx.deps.fetch(input, {
          ...init,
          signal: AbortSignal.timeout(Math.max(1, deadline - ctx.deps.now())),
        })) as typeof fetch,
    },
  }
  for (;;) {
    let result: z.infer<typeof responseSchema>
    try {
      result = responseSchema.parse(
        await request(readCtx, key, `/api/v1/agent/hood-tee/operations/${encodeURIComponent(id)}`),
      )
      if (result.operation.operationId !== id) throw new Error("The server returned a different operation")
    } catch (error) {
      throw new TradingError(
        "HOOD_WAIT_UNAVAILABLE",
        `Could not follow Hood settlement. Do not repeat the swap. Read ${hint}.`,
        {
          exitCode: 3,
          details: {
            ...evidence,
            operationId: id,
            readCode: error instanceof TradingError ? error.code : "INVALID_RESPONSE",
          },
        },
      )
    }
    const op = result.operation
    const held = op.guard?.recoveryRequired === true || op.recovery?.recoveryRequired === true
    const completed =
      op.status === "completed" &&
      op.legs.length === op.plannedLegCount &&
      op.legs.every((leg) => leg.status === "landed")
    const failed = op.status === "failed" || op.status === "expired"
    const final = !held && (completed || failed)
    if (final || ctx.deps.now() >= deadline) {
      // Preserve the operation-status response, including every leg and the server's guard.
      ctx.deps.stdout.write(`${JSON.stringify(result, null, ctx.json ? undefined : 2)}\n`)
      if (!final) ctx.deps.stderr.write(`Still not final after ten minutes. Do not repeat the swap. Read ${hint}.\n`)
      else if (failed)
        ctx.deps.stderr.write(`Hood operation ${safeText(op.status)}. Do not repeat the swap. Read ${hint}.\n`)
      if (!final) return 3
      if (completed) return 0
      // A trade that landed before a failed fee is partial execution, not a safe retry.
      return op.legs.some((leg) => leg.kind === "trade" && leg.status === "landed") ? 3 : 1
    }
    await ctx.deps.sleep(Math.min(POLL_MS, deadline - ctx.deps.now()))
  }
}
