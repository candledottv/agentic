/**
 * BE-2677 (R32): `printIdentity` under a `CANDLE_API_KEY` env override asks the acting key which
 * account it belongs to and names that account on the identity line, instead of `unknown`. The
 * profile's cached account and username never appear under an override (profiles.ts, identityLine),
 * so the only identity the line can assert is one the key itself reported.
 */
import { describe, expect, test } from "bun:test"
import type { CommandContext, Deps } from "./deps"
import { printIdentity } from "./profiles"
import { createCapture, createFakeConfigStore, createTestDeps } from "./test-support"

const CACHED = "FaKwE2xXcachedcachedcachedcachedxxxxxxx"
const ACTING = "9xKQactingkeyaccountaccountaccountff8pPD"
const EMBEDDED = "/api/v1/agent/wallets/embedded"

interface Seen {
  path: string
  apiKey?: string
}

/** A fetch that records what was asked and answers the embedded endpoint with `body`. */
function fetchRecording(seen: Seen[], status: number, body: unknown): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : ((input as Request).url ?? String(input)))
    const headers = new Headers(init?.headers)
    seen.push({ path: url.pathname, apiKey: headers.get("x-api-key") ?? undefined })
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }) as typeof globalThis.fetch
}

function ctxFor(deps: Deps): CommandContext {
  return {
    deps,
    json: false,
    apiUrl: "https://api.candle.tv",
    profile: "production",
    verifyAccount: true,
  } as unknown as CommandContext
}

/** The identity line printIdentity wrote (first line, before its blank line). */
async function identityLineFor(env: Record<string, string>, fetch: typeof globalThis.fetch): Promise<string> {
  const configStore = createFakeConfigStore({
    profiles: { production: { account: CACHED, username: "cached-user" } },
    activeProfile: "production",
  })
  const stdout = createCapture()
  const deps = createTestDeps({ fetch, env, stdout, readConfig: configStore.readConfig })
  await printIdentity(ctxFor(deps))
  return (stdout.text.trim().split("\n")[0] ?? "").trim()
}

describe("printIdentity under a CANDLE_API_KEY override (BE-2677, R32)", () => {
  test("names the account the acting key reported, not the cached one", async () => {
    const seen: Seen[] = []
    const line = await identityLineFor(
      { CANDLE_API_KEY: "cndl_live_envkey" },
      fetchRecording(seen, 200, { account: ACTING, username: "acting-user" }),
    )
    expect(line).toBe("Profile production · Account 9xKQ…8pPD (CANDLE_API_KEY override) · api.candle.tv")
    expect(line).not.toContain(CACHED)
    expect(line).not.toContain("cached-user")
    // The lookup asked the embedded endpoint with the OVERRIDING key, exactly once.
    const asks = seen.filter((s) => s.path === EMBEDDED)
    expect(asks).toHaveLength(1)
    expect(asks[0]?.apiKey).toBe("cndl_live_envkey")
  })

  test("a key whose lookup fails keeps the unknown form rather than guessing", async () => {
    for (const body of [{}, { account: null }]) {
      const line = await identityLineFor({ CANDLE_API_KEY: "cndl_live_envkey" }, fetchRecording([], 200, body))
      expect(line).toBe("Profile production · Account unknown (CANDLE_API_KEY override) · api.candle.tv")
    }
    const failing = await identityLineFor(
      { CANDLE_API_KEY: "cndl_live_envkey" },
      fetchRecording([], 500, { message: "nope" }),
    )
    expect(failing).toBe("Profile production · Account unknown (CANDLE_API_KEY override) · api.candle.tv")
  })

  test("no override makes no network call and shows the cached account", async () => {
    const seen: Seen[] = []
    const line = await identityLineFor({}, fetchRecording(seen, 200, { account: ACTING }))
    expect(line).toBe("Profile production · Account cached-user (FaKw…xxxx) · api.candle.tv")
    expect(seen).toHaveLength(0)
  })

  test("a device-token-only override stays unknown and makes no call", async () => {
    const seen: Seen[] = []
    const line = await identityLineFor(
      { CANDLE_DEVICE_TOKEN: "cndl_dvc_env" },
      fetchRecording(seen, 200, { account: ACTING }),
    )
    expect(line).toBe("Profile production · Account unknown (CANDLE_DEVICE_TOKEN override) · api.candle.tv")
    expect(seen).toHaveLength(0)
  })
})
