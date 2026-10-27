/**
 * Resolving `unknown` spend log entries (spec 10.4): an `unknown` older than 15 minutes is matched
 * against `GET /api/v1/agent/x402/payments` when the CLI has a key, and its server state is logged.
 * Without a key, or with no match, it stays `unknown` and still counts toward the day.
 *
 * The server's list names no quote, and an `unknown` payment's signature is the facilitator's (the
 * fee payer signs first), so a payment is matched on what both sides know: the paying wallet, the
 * amount, the product, and a start within the quote's two minutes. A server row matches one entry.
 */
import {
  foldSpendLog,
  readSpendLog,
  recordSpendState,
  type SpendPaths,
  type SpendState,
  UNKNOWN_RECONCILE_AFTER_MS,
} from "./spend-log"

/** One row of `GET /x402/payments` (`apps/api/src/routes/agent-x402.ts`, `paymentView`). */
export interface ServerPayment {
  id: string
  kind: string
  status: string
  reason: string | null
  payer: string
  amountUsdMicros: string
  signature: string | null
  createdAt: string
}

const MATCH_WINDOW_MS = 2 * 60_000

/** The log state a server status settles, or null while the server does not know either. */
export function stateForServerStatus(status: string): SpendState | null {
  switch (status) {
    case "fulfilled":
    case "settled":
      return "settled"
    case "credited":
      return "credited"
    case "rejected":
    case "settle_failed":
      return "failed"
    default:
      return null
  }
}

export function readServerPayments(body: unknown): ServerPayment[] | null {
  if (typeof body !== "object" || body === null) return null
  const payments = (body as { payments?: unknown }).payments
  if (!Array.isArray(payments)) return null
  return payments.filter(
    (p): p is ServerPayment =>
      typeof p === "object" &&
      p !== null &&
      typeof (p as ServerPayment).status === "string" &&
      typeof (p as ServerPayment).payer === "string" &&
      typeof (p as ServerPayment).amountUsdMicros === "string" &&
      typeof (p as ServerPayment).kind === "string" &&
      typeof (p as ServerPayment).createdAt === "string",
  )
}

/**
 * Logs the server's state for each stale `unknown`. `fetchPayments` is only called when there is
 * one to resolve; it answers null when the list cannot be read. Returns how many were resolved.
 */
export async function reconcileUnknown(
  paths: SpendPaths,
  now: number,
  fetchPayments: () => Promise<ServerPayment[] | null>,
): Promise<number> {
  const stale = foldSpendLog(await readSpendLog(paths)).filter(
    (e) => e.state === "unknown" && now - Date.parse(e.startedAt) > UNKNOWN_RECONCILE_AFTER_MS,
  )
  if (stale.length === 0) return 0
  const payments = await fetchPayments()
  if (!payments) return 0
  const used = new Set<string>()
  let resolved = 0
  for (const entry of stale) {
    const started = Date.parse(entry.startedAt)
    const candidates = payments
      .filter(
        (p) =>
          !used.has(p.id) &&
          p.payer === entry.payer &&
          p.kind === entry.kind &&
          p.amountUsdMicros === entry.amountRaw.toString() &&
          Math.abs(Date.parse(p.createdAt) - started) <= MATCH_WINDOW_MS,
      )
      .sort((a, b) => Math.abs(Date.parse(a.createdAt) - started) - Math.abs(Date.parse(b.createdAt) - started))
    const match = candidates[0]
    if (!match) continue
    used.add(match.id)
    const state = stateForServerStatus(match.status)
    if (state === null) continue
    await recordSpendState(paths, {
      id: entry.id,
      at: new Date(now).toISOString(),
      state,
      ...(match.signature ? { signature: match.signature } : {}),
      reason: `server:${match.status}${match.reason ? `:${match.reason}` : ""}`,
    })
    resolved++
  }
  return resolved
}
