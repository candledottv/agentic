/**
 * Ember Phase 2 (BE-136, Interfaces "Complete linked-wallet read"): the one read that knows every
 * address an account ever imported, and the reason it is not one `GET`.
 *
 * Two properties of the Phase 1 route make a naive call WRONG, and both are why this module
 * exists. It is **active-only by default**: revoked rows are dropped before paging, so a wallet
 * that was imported and later revoked or swept simply is not in the default answer. And it is
 * **paginated**, `limit` clamped server-side to 100, with a `continueCursor` to follow. A single
 * default call answers with active rows from the first page only, which is precisely the read
 * that would let a revoked, swept or later-page TEE wallet address look like it was never
 * imported, and "never imported" is the conclusion that would let a restore present a remotely
 * exposed key as cold.
 *
 * So: `includeRevoked=true` on every request, `limit=100`, follow the cursor to `isDone`, and read
 * the account identity beside it. **There is no partial success.** Any non-200, transport failure,
 * malformed body, or a cursor that does not terminate within a bounded number of pages yields
 * `complete: false`, and every caller treats that as a stop rather than as a short answer, because
 * a list that happens to be empty reads as good news exactly when it is worst.
 *
 * A `complete: true` result still proves nothing about coldness (CC-11). It is complete for ONE
 * account, and that is all any read can be.
 */
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"

/** What the CLI reads off one `linkedWallets` row. Everything else on the row is ignored. */
export interface LinkedWalletRow {
  _id: string
  address: string
  chain: string
  label?: string
  revokedAt?: number
  privyWalletId?: string
  profile?: string
  boundKeyPrefix?: string
  vaultDestination?: string
  everRemoteExposed?: boolean
  remoteAuthority?: "verified-active" | "verified-denied" | "unknown" | "none"
  sweptAt?: number
}

export interface CompleteRead {
  /** The account the configured profile acts as, carried with the result so a caller can show it. */
  account: string
  rows: LinkedWalletRow[]
  complete: boolean
  /** Why the read is incomplete, for the message. Absent when it is complete. */
  incompleteReason?: string
}

/** A cursor that does not terminate is a server the CLI should stop trusting, not one to follow. */
const MAX_PAGES = 100
const PAGE_LIMIT = 100

export async function completeLinkedWalletRead(ctx: CommandContext, apiKey: string): Promise<CompleteRead> {
  const call = (path: string) =>
    apiRequest(path, {
      auth: "key",
      credentials: { apiKey },
      apiUrl: ctx.apiUrl,
      fetch: ctx.deps.fetch,
      env: ctx.deps.env,
    })

  // Step 3 of the spec's list, done first so an identity failure costs one request rather than the
  // whole walk: every conclusion below is about ONE account and is worthless without knowing which.
  const identity = await call("/api/v1/agent/wallets/embedded")
  if (!identity.ok) {
    return {
      account: "",
      rows: [],
      complete: false,
      incompleteReason: `the account identity could not be read (${identity.message})`,
    }
  }
  const account = (identity.body as { account?: unknown }).account
  if (typeof account !== "string" || account === "") {
    return {
      account: "",
      rows: [],
      complete: false,
      incompleteReason: "the account identity response carried no account",
    }
  }

  const rows: LinkedWalletRow[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ includeRevoked: "true", limit: String(PAGE_LIMIT) })
    if (cursor !== undefined) query.set("cursor", cursor)
    const result = await call(`/api/v1/agent/wallets?${query.toString()}`)
    if (!result.ok) {
      return {
        account,
        rows: [],
        complete: false,
        incompleteReason: `page ${page + 1} of the wallet list failed (${result.message})`,
      }
    }
    const body = result.body as { page?: unknown; isDone?: unknown; continueCursor?: unknown }
    if (!Array.isArray(body.page) || typeof body.isDone !== "boolean") {
      return {
        account,
        rows: [],
        complete: false,
        incompleteReason: `page ${page + 1} of the wallet list was malformed`,
      }
    }
    rows.push(...(body.page as LinkedWalletRow[]))
    if (body.isDone) return { account, rows, complete: true }
    if (typeof body.continueCursor !== "string" || body.continueCursor === "") {
      return {
        account,
        rows: [],
        complete: false,
        incompleteReason: `page ${page + 1} was not the last one but carried no cursor`,
      }
    }
    cursor = body.continueCursor
  }
  return {
    account,
    rows: [],
    complete: false,
    incompleteReason: `the wallet list did not finish within ${MAX_PAGES} pages`,
  }
}
