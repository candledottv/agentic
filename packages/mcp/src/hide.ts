/**
 * Per-order `hide` (agent-stream design 5.2 and 5.6): keep one order out of the public activity
 * stream. Sent only when true, so no live body carries the word otherwise. An API that predates
 * `hide` would ignore it and publish the order, so a result for an order that asked for it must
 * carry the API's `hide: true` echo; without it the tool answers an error.
 */
import { z } from "zod"

export const HIDE_NOT_CONFIRMED = "HIDE_NOT_CONFIRMED"

/** What a model or host may pass for the flag: a boolean, "true" or 1. */
export function isHideFlag(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1"
}

/** `{ hide: true }` only when asked; spread it into a request body. */
export function hideField(value: unknown): { hide?: true } {
  return isHideFlag(value) ? { hide: true } : {}
}

/** The zod field for trade and swap shapes (the `paper` preprocess, with the text a model reads). */
export const hideSchema = z.preprocess(
  (value) =>
    value === "true" || value === 1 || value === "1"
      ? true
      : value === "false" || value === 0 || value === "0"
        ? false
        : value,
  z
    .boolean()
    .optional()
    .describe(
      "Keep this order out of the public activity stream. Sent only when true. The API confirms it; " +
        "a result without that confirmation is an error, because an API that does not know `hide` " +
        "would place the order publicly. Hidden orders still count in this key's own record. " +
        "A refusal means the API has not enabled hide yet: nothing was placed.",
    ),
)

/** True when the parsed API body echoes `hide: true`. */
export function hideEchoed(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as { hide?: unknown }).hide === true
}

/** True when relayed tool text is the JSON body of a response that echoes `hide: true`. */
export function hideEchoedText(text: string): boolean {
  try {
    return hideEchoed(JSON.parse(text))
  } catch {
    return false
  }
}

export function hideNotConfirmedMessage(what: string): string {
  return (
    `${HIDE_NOT_CONFIRMED}: ${what} asked for hide, but the API did not confirm it. Its server may predate hide, ` +
    "so the order may have been placed publicly. Read the order back before sending another."
  )
}

/**
 * The stale-server gate (design 5.6): a hidden launch's dry run lacks the echo. A dry run
 * publishes nothing, so unlike `hideNotConfirmedMessage` this says nothing was placed.
 */
export function hideUnsupportedByDryRunMessage(what: string): string {
  return (
    `${HIDE_NOT_CONFIRMED}: ${what} asked for hide, but the API's dry run did not confirm it. ` +
    "Its server has not enabled hide yet. The dry run published nothing and no launch was sent; " +
    "retry without hide, or after the API enables it."
  )
}

/**
 * Relayed text from a successful call: when `asked` and the body lacks the echo, returns the error
 * block to answer instead. Returns undefined when nothing is wrong (or the body is not JSON, which
 * the caller reports as it always did).
 */
export function missingHideEcho(asked: boolean, text: string, what: string): string | undefined {
  if (!asked) return undefined
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  return hideEchoed(body) ? undefined : hideNotConfirmedMessage(what)
}
