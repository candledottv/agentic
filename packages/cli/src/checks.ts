/**
 * A shared row shape and a request-and-classify helper for the live credential checks `auth
 * status` and `doctor` both run (fix round 1, item 11): hit an endpoint with a credential, PASS
 * if the request succeeds, FAIL with `renderError`'s message otherwise. One row shape (`check`,
 * `state`, `detail`) across both commands, including their `--json` output, rather than two
 * shapes ("label" vs "check") that happen to carry the same three fields.
 *
 * Callers decide SKIP themselves: there's nothing to request when a credential isn't present at
 * all, so that branch never reaches this helper.
 */

import { apiRequest } from "./client"
import type { Deps } from "./deps"
import { renderError } from "./render"

export interface CheckRow {
  check: string
  state: "PASS" | "FAIL" | "SKIP"
  detail: string
}

export async function runLiveCheck(params: {
  deps: Deps
  apiUrl: string
  path: string
  auth: "device" | "key"
  credential: string
  check: string
  passDetail: string
}): Promise<CheckRow> {
  const { deps, apiUrl, path, auth, credential, check, passDetail } = params
  const result = await apiRequest(path, {
    auth,
    credentials: auth === "device" ? { deviceToken: credential } : { apiKey: credential },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
  })
  return result.ok
    ? { check, state: "PASS", detail: passDetail }
    : { check, state: "FAIL", detail: renderError(result, { apiUrl, authType: auth }) }
}
