/**
 * Which account a stored API key acts as. `GET /api/v1/agent/wallets/embedded` answers it: the
 * endpoint returns `account` alongside the wallets (added 2026-08-19 for exactly this question,
 * and pinned by apps/api/src/routes/agent.wallets-embedded.test.ts:133).
 *
 * One helper because four callers ask the same question -- `auth login` caching it, `auth status`
 * reporting it, `profile use` refreshing it, and the guard comparing it -- and each had spelled
 * out the same request, the same cast of an `unknown` body, and the same reading of what a
 * failure means. Four copies of a cast is four places for the field name to be spelled wrong, and
 * the two that report a reason had already written the wording twice.
 *
 * `failure` is the REASON, ready to interpolate, never a thrown error: an unreachable API says
 * nothing about which account a credential belongs to, so every caller here degrades rather than
 * fails. Exactly one of the two fields is set. Deliberately no wallet data comes back: `wallets`
 * makes this same request for the wallets themselves, and handing it a body fetched for another
 * purpose is how a stale read gets reported as a live one.
 */
import { apiRequest } from "./client"
import type { Deps } from "./deps"

export interface AccountLookup {
  /** The account the key belongs to, when the API named one. */
  account?: string
  /** The account's Candle username, when it has one. Optional and independent of `account`: the
   * endpoint returns `username: null` for an account that never set one. Display only. */
  username?: string
  /** Why it did not, in words a message can carry: an API error, or a body with no account. */
  failure?: string
}

export async function fetchAccount(
  deps: Pick<Deps, "fetch" | "env">,
  apiUrl: string,
  apiKey: string,
): Promise<AccountLookup> {
  const identity = await apiRequest("/api/v1/agent/wallets/embedded", {
    auth: "key",
    credentials: { apiKey },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
  })
  const body = identity.ok ? (identity.body as { account?: string; username?: string }) : undefined
  const account = body?.account
  if (account) return { account, ...(body?.username ? { username: body.username } : {}) }
  return { failure: identity.ok ? "no account in the response" : identity.message }
}
