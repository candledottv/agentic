/**
 * `candle quant ask "<text>" [--timeout <s>] [--json]` (BE-2790): one question to Quant over this
 * profile's API key, through the key route `/api/v1/agent/quant/*` (`QUANT_AGENT_API`, BE-2593).
 * The route takes `account:read` or `launch:write`.
 *
 *   POST /turns {text, clientTurnId}   a lost answer is resent with the same clientTurnId
 *   GET  /turns/:id/events?after=      held polls until the turn ends
 *   POST /turns/:id/cancel             on Ctrl-C, and when --timeout passes
 *
 * The answer is the turn's `text` events joined; `--json` prints `{turnId, answer, remaining?,
 * resetsAt?}` from what the route sent. Every refusal is a plain sentence and exit 1, and `--json`
 * carries the route's code (`limit_reached`, `turn_in_progress`, `text_too_long`, `RATE_LIMITED`,
 * `VALIDATION_FAILED`, `NO_IDENTITY_WALLET`, `TERMS_REQUIRED`); a 404 is the switch being off.
 *
 * This command pays nothing. A 402 past the daily limit is printed as the offer it is, and the
 * command stops.
 */

import { parseArgs } from "../args"
import { type CommandContext, resolveApiKey } from "../deps"
import { createQuantKeyClient, newClientTurnId, type QuantKeyClient, type QuantRefusal } from "../quant"
import { escapeTerminalText as terminalText } from "../terminal-text"
import { decodePaymentRequired, PAYMENT_REQUIRED_HEADER } from "../x402/codec"
import { usdcText } from "../x402/select"
import {
  writeScreenLocalFailure as writeLocalFailure,
  writeScreenUsageFailure as writeUsageFailure,
} from "./key-output"

const USAGE = 'Usage: candle quant ask "<text>" [--timeout <s>] [--json]'
export const QUANT_ASK_DEFAULT_TIMEOUT_S = 300
export const QUANT_ASK_MAX_TIMEOUT_S = 3_600
/** Tries of `POST /turns` when no answer arrived; the same clientTurnId each time (the core's 3). */
export const QUANT_ASK_SEND_TRIES = 3
const TOO_MANY_POLLS_WAIT_MS = 2_000
const TOO_MANY_POLLS_RETRIES = 5
const LOST_POLL_RETRIES = 10

type Failure = { code: string; message: string; suggestion?: string; details?: Record<string, unknown> }

/** A turn that has not ended (the core's `isLiveTurnStatus`): `queued`, then `running`. */
const isLive = (status: string) => status === "queued" || status === "running"

/** A 402 offer as the route sent it: the `PAYMENT-REQUIRED` header, decoded, or the body's message. */
function offerFailure(status: number, headers: Headers | undefined, body: unknown): Failure {
  const header = headers?.get(PAYMENT_REQUIRED_HEADER)
  let details: Record<string, unknown> = { status }
  let message = "Quant asked for a payment for this answer. This command pays nothing; nothing was paid."
  if (header) {
    try {
      const required = decodePaymentRequired(header)
      const offer = required.accepts[0]
      const price = offer && /^\d+$/.test(offer.amount) ? usdcText(BigInt(offer.amount)) : undefined
      details = {
        ...details,
        ...(price ? { priceUsdc: price } : {}),
        ...(offer ? { network: offer.network, payTo: offer.payTo } : {}),
        ...(required.resource.description ? { description: required.resource.description } : {}),
        resource: required.resource.url,
      }
      message = `${price ? `This Quant answer costs ${price} USDC` : "This Quant answer needs a payment"}. This command pays nothing; nothing was paid.`
    } catch {
      // An offer this CLI cannot read is still an offer: say so, pay nothing.
    }
  } else {
    const text = (body as { error?: { message?: unknown } } | null)?.error?.message
    if (typeof text === "string" && text) message = `${text} This command pays nothing; nothing was paid.`
  }
  return { code: "PAYMENT_REQUIRED", message, details }
}

/** The route's refusal of `POST /turns` as the sentence and code this command prints. */
export function turnRefusal(refusal: QuantRefusal): Failure {
  const details: Record<string, unknown> = { status: refusal.status }
  if (refusal.retryable !== undefined) details.retryable = refusal.retryable
  switch (refusal.code) {
    case "limit_reached":
      return {
        code: refusal.code,
        message:
          refusal.resetsAt !== undefined
            ? `This account has used today's Quant answers. They reset at ${refusal.resetsAt}.`
            : "This account has used today's Quant answers.",
        details: { ...details, ...(refusal.resetsAt !== undefined ? { resetsAt: refusal.resetsAt } : {}) },
      }
    case "turn_in_progress":
      return {
        code: refusal.code,
        message: `Quant is already answering another question on this account${refusal.turnId ? ` (turn ${refusal.turnId})` : ""}. Try again when it ends.`,
        details: { ...details, ...(refusal.turnId ? { turnId: refusal.turnId } : {}) },
      }
    case "text_too_long":
      return {
        code: refusal.code,
        message:
          refusal.limit !== undefined
            ? `Too long: Quant takes up to ${refusal.limit} characters.`
            : "Too long for Quant.",
        details: { ...details, ...(refusal.limit !== undefined ? { limit: refusal.limit } : {}) },
      }
    case "RATE_LIMITED":
      return { code: refusal.code, message: "Too many requests just now. Wait a minute and ask again.", details }
    case "VALIDATION_FAILED":
      return { code: refusal.code, message: "The API refused the question as malformed.", details }
    case "NO_IDENTITY_WALLET":
      return {
        code: refusal.code,
        message: "This key's account has no identity wallet, and Quant answers per identity wallet.",
        details,
      }
    case "TERMS_REQUIRED":
      return {
        code: refusal.code,
        message: "Quant's terms are not accepted on this account yet.",
        suggestion: "Run: candle quant terms",
        details,
      }
    case "TIMEOUT":
    case "NETWORK_ERROR":
      return {
        code: "QUANT_UNREACHABLE",
        message: `No answer from the API after ${QUANT_ASK_SEND_TRIES} tries.`,
        details: { ...details, cause: refusal.code },
      }
  }
  if (refusal.status === 404) return offFailure()
  return {
    code: refusal.code,
    message: `Quant refused the question: ${refusal.code} (HTTP ${refusal.status}).`,
    details,
  }
}

function offFailure(): Failure {
  return { code: "QUANT_AGENT_OFF", message: "Quant for agent keys is off on this API." }
}

/** Follows the turn's events to its end, collecting the answer. Stops early when `signal` aborts. */
async function follow(
  client: QuantKeyClient,
  ctx: CommandContext,
  turnId: string,
  signal: AbortSignal,
): Promise<{ ok: true; paragraphs: string[]; done: Record<string, unknown> } | { ok: false; failure: Failure }> {
  const paragraphs: string[] = []
  let next = 0
  let tooMany = 0
  let lost = 0
  while (!signal.aborted) {
    const answer = await client.events(turnId, next, { signal })
    if (signal.aborted) break
    if (!answer.ok) {
      const refusal = answer.refusal
      if (refusal.code === "too_many_polls" && ++tooMany <= TOO_MANY_POLLS_RETRIES) {
        await ctx.deps.sleep(TOO_MANY_POLLS_WAIT_MS)
        continue
      }
      if (refusal.shape === "transport" && ++lost <= LOST_POLL_RETRIES) {
        await ctx.deps.sleep(Math.min(1_000 * lost, 5_000))
        continue
      }
      if (refusal.status === 404 && refusal.code === "HTTP_404") return { ok: false, failure: offFailure() }
      return {
        ok: false,
        failure: {
          code: refusal.code === "TIMEOUT" || refusal.code === "NETWORK_ERROR" ? "QUANT_UNREACHABLE" : refusal.code,
          message: `Lost Quant's answer while it was being written: ${refusal.code}.`,
          details: { turnId, status: refusal.status },
        },
      }
    }
    tooMany = 0
    lost = 0
    for (const event of answer.body.events) {
      if (event.seq <= next) continue
      next = event.seq
      if (event.kind === "text" && typeof event.data.text === "string" && event.data.text) {
        paragraphs.push(event.data.text)
      } else if (event.kind === "done") {
        return { ok: true, paragraphs, done: event.data }
      } else if (event.kind === "error") {
        const code = typeof event.data.code === "string" ? event.data.code : "error"
        return {
          ok: false,
          failure: {
            code,
            message: code === "cancelled" ? "Quant's turn was cancelled." : `Quant could not answer: ${code}.`,
            details: {
              turnId,
              ...(typeof event.data.retryable === "boolean" ? { retryable: event.data.retryable } : {}),
            },
          },
        }
      }
    }
    next = Math.max(next, answer.body.next)
    if (!isLive(answer.body.status)) {
      // The page says the turn is over but carried no closing event: settle it by the status.
      if (answer.body.status === "done") return { ok: true, paragraphs, done: {} }
      return {
        ok: false,
        failure: {
          code: "QUANT_TURN_ENDED",
          message: `Quant's turn ended without an answer (${answer.body.status}).`,
          details: { turnId, turnStatus: answer.body.status },
        },
      }
    }
  }
  return { ok: false, failure: { code: "ABORTED", message: "Stopped waiting." } }
}

export async function quantAsk(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--timeout"] })
  const timeoutRaw = "error" in parsed ? undefined : parsed.values["--timeout"]
  const timeoutS = timeoutRaw === undefined ? QUANT_ASK_DEFAULT_TIMEOUT_S : Number(timeoutRaw)
  const text = "error" in parsed ? "" : (parsed.positionals[0] ?? "")
  if (
    "error" in parsed ||
    parsed.positionals.length !== 1 ||
    !text.trim() ||
    !Number.isInteger(timeoutS) ||
    timeoutS < 1 ||
    timeoutS > QUANT_ASK_MAX_TIMEOUT_S
  ) {
    writeUsageFailure(ctx.deps, USAGE, ctx.json)
    return 2
  }
  const apiKey = await resolveApiKey(ctx.deps, ctx.profile)
  if (!apiKey) {
    writeLocalFailure(
      ctx.deps,
      {
        code: "NO_API_KEY",
        message: "Quant over the CLI asks through an API key, and this profile has none.",
        suggestion: "Run: candle auth login",
      },
      ctx.json,
    )
    return 1
  }

  // The key client reads a refusal's code but not a 402's offer, so the offer is kept here.
  let offer: { status: number; headers: Headers; body: unknown } | undefined
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await ctx.deps.fetch(input, init)
    if (response.status === 402) {
      offer = {
        status: 402,
        headers: response.headers,
        body: await response
          .clone()
          .json()
          .catch(() => null),
      }
    }
    return response
  }) as typeof fetch
  let client: QuantKeyClient
  try {
    client = createQuantKeyClient({ apiUrl: ctx.apiUrl, apiKey, fetch: fetchFn })
  } catch (err) {
    writeLocalFailure(
      ctx.deps,
      { code: "INSECURE_API_URL", message: err instanceof Error ? err.message : String(err) },
      ctx.json,
    )
    return 1
  }

  const stop = new AbortController()
  let reason: "interrupted" | "timeout" | undefined
  const timer = setTimeout(() => {
    reason ??= "timeout"
    stop.abort()
  }, timeoutS * 1_000)
  const unsubscribe =
    ctx.deps.onTerminate?.(() => {
      reason ??= "interrupted"
      stop.abort()
    }) ?? (() => {})
  try {
    const clientTurnId = newClientTurnId()
    let turnId: string | undefined
    let refusal: QuantRefusal | undefined
    for (let attempt = 1; attempt <= QUANT_ASK_SEND_TRIES; attempt++) {
      const sent = await client.sendTurn({ text, clientTurnId })
      if (sent.ok) {
        turnId = sent.body.turnId
        break
      }
      refusal = sent.refusal
      if (refusal.shape !== "transport" || stop.signal.aborted) break
    }
    if (turnId === undefined) {
      if (reason === "interrupted") return await stopped(ctx, client, undefined, reason, timeoutS)
      const failure =
        refusal?.status === 402 && offer
          ? offerFailure(offer.status, offer.headers, offer.body)
          : turnRefusal(refusal ?? { code: "BAD_RESPONSE", status: 0, shape: "transport" })
      writeLocalFailure(ctx.deps, failure, ctx.json)
      return 1
    }
    if (stop.signal.aborted) {
      return await stopped(ctx, client, turnId, reason, timeoutS)
    }

    const result = await follow(client, ctx, turnId, stop.signal)
    if (stop.signal.aborted) {
      return await stopped(ctx, client, turnId, reason, timeoutS)
    }
    if (!result.ok) {
      writeLocalFailure(ctx.deps, result.failure, ctx.json)
      return 1
    }
    const answer = result.paragraphs.join("\n\n")
    if (!answer.trim()) {
      writeLocalFailure(
        ctx.deps,
        { code: "QUANT_EMPTY_ANSWER", message: "Quant ended the turn without an answer.", details: { turnId } },
        ctx.json,
      )
      return 1
    }
    const remaining = typeof result.done.messagesLeft === "number" ? result.done.messagesLeft : undefined
    const resetsAt =
      typeof result.done.resetsAt === "string" || typeof result.done.resetsAt === "number"
        ? result.done.resetsAt
        : undefined
    if (ctx.json) {
      ctx.deps.stdout.write(
        `${JSON.stringify({
          turnId,
          answer,
          ...(remaining !== undefined ? { remaining } : {}),
          ...(resetsAt !== undefined ? { resetsAt } : {}),
        })}\n`,
      )
    } else {
      ctx.deps.stdout.write(`${result.paragraphs.map(terminalText).join("\n\n")}\n`)
      if (remaining !== undefined) {
        ctx.deps.stderr.write(
          `${remaining} Quant answer${remaining === 1 ? "" : "s"} left today${resetsAt !== undefined ? `, resets at ${terminalText(String(resetsAt))}` : ""}.\n`,
        )
      }
    }
    return 0
  } finally {
    clearTimeout(timer)
    unsubscribe()
  }
}

async function stopped(
  ctx: CommandContext,
  client: QuantKeyClient,
  turnId: string | undefined,
  reason: "interrupted" | "timeout" | undefined,
  timeoutS: number,
): Promise<number> {
  const cancellation = turnId ? await client.cancel(turnId) : undefined
  const cancelRefusal = cancellation && !cancellation.ok ? cancellation.refusal : undefined
  const interrupted = reason === "interrupted"
  const prefix = interrupted ? "Interrupted" : `No answer within ${timeoutS} s`
  const message = !turnId
    ? "Interrupted before Quant took the question."
    : cancelRefusal
      ? `${prefix}; cancellation could not be confirmed and Quant's turn may still run.`
      : `${prefix}; Quant's turn was cancelled.`
  writeLocalFailure(
    ctx.deps,
    {
      code: interrupted ? "INTERRUPTED" : "QUANT_TIMEOUT",
      message,
      ...(!interrupted && !cancelRefusal ? { suggestion: "Ask again with a longer --timeout <s>." } : {}),
      ...(turnId ? { details: { turnId, ...(cancelRefusal ? { cancelRefusal } : {}) } } : {}),
    },
    ctx.json,
  )
  return interrupted ? 130 : 1
}
