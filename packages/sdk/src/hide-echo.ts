import { CandleApiError } from "./errors"

/**
 * Per-order `hide` (agent-stream design 5.2 and 5.6). An order placed with `hide` stays out of the
 * public activity stream. The wire field is `hide`, sent only when true: a body without it is
 * byte-identical to one from before this field existed.
 *
 * An API that predates `hide` would ignore the field and publish the order, so a caller that asked
 * for it must see `hide: true` echoed in the successful response. A response without the echo is
 * refused with `HIDE_NOT_CONFIRMED`. Where the caller signs (linked and TEE wallets) the check
 * runs on the build, before anything is signed. Where the server executes inline (the embedded
 * wallet), the build response is the executed order, so the error reports that the order may have
 * been placed publicly.
 */
export const HIDE_NOT_CONFIRMED = "HIDE_NOT_CONFIRMED"

const TRUE = new Set<unknown>([true, "true", 1, "1"])
const FALSE = new Set<unknown>([undefined, null, false, "false", 0, "0"])

/**
 * Reads the caller's `hide` (the same truthy set the API takes) and returns `true` when the order
 * must be hidden, `false` when it is public. Anything else throws: dropping an unreadable `hide`
 * would place a public order the caller asked to keep out of the stream.
 */
export function hideRequested(value: unknown): boolean {
  if (TRUE.has(value)) return true
  if (FALSE.has(value)) return false
  throw new CandleApiError({
    status: 400,
    code: "VALIDATION_FAILED",
    field: "hide",
    message: 'hide must be a boolean (true, "true" or 1)',
    retryable: false,
  })
}

/** The body fragment to spread: `{ hide: true }` only when hidden, otherwise nothing. */
export function hideField(value: unknown): { hide?: true } {
  return hideRequested(value) ? { hide: true } : {}
}

/**
 * The stale-server gate for hidden embedded launches (design 5.6): the dry run must carry the
 * echo before the live launch is sent. A dry run publishes nothing, so a refusal here means
 * nothing was placed -- unlike `assertHideEchoed`, which runs after a request that may have run.
 */
export function assertHideSupportedByDryRun(response: unknown, what: string): void {
  if (response && typeof response === "object" && (response as { hide?: unknown }).hide === true) return
  throw new CandleApiError({
    status: 502,
    code: HIDE_NOT_CONFIRMED,
    message: `${what} asked for hide, but the API's dry run did not confirm it. Its server may predate hide; nothing was launched.`,
    retryable: false,
    field: "hide",
  })
}

/** Throws `HIDE_NOT_CONFIRMED` when `requested` and the response does not carry `hide: true`. */
export function assertHideEchoed(requested: boolean, response: unknown, what: string): void {
  if (!requested) return
  if (response && typeof response === "object" && (response as { hide?: unknown }).hide === true) return
  throw new CandleApiError({
    status: 502,
    code: HIDE_NOT_CONFIRMED,
    message: `${what} asked for hide, but the API did not confirm it. Its server may predate hide, so the order may have been placed publicly. Check the order before sending another.`,
    retryable: false,
    field: "hide",
  })
}
