/**
 * `apiRequest`: the CLI's only HTTP call site. Covers error-envelope classification (Candle's own
 * `{success:false,error:{code,message}}` shape vs. an RFC-flavored `{error:"..."}` string, as used
 * by the OAuth device flow's `authorization_pending`), auth-header selection per `auth` mode, and
 * base-URL resolution. No real network calls: `globalThis.fetch` is stubbed per test and restored
 * in `afterEach`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { apiRequest, DEFAULT_API_URL, resolveApiUrl } from "./client"

type CapturedRequest = { url: string; init: RequestInit }

let originalFetch: typeof fetch
let lastRequest: CapturedRequest | undefined

function stubFetch(respond: (req: CapturedRequest) => Response) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    const req = { url, init: init ?? {} }
    lastRequest = req
    return respond(req)
  }) as typeof fetch
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

beforeEach(() => {
  originalFetch = globalThis.fetch
  lastRequest = undefined
})

afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.CANDLE_API_URL
})

describe("apiRequest: error envelope classification", () => {
  test("a Candle-shaped error envelope yields ok:false with code and message", async () => {
    stubFetch(() =>
      jsonResponse(403, { success: false, error: { code: "TIER_REQUIRED", message: "Upgrade your tier to do this" } }),
    )

    const result = await apiRequest("/v1/keys", {
      auth: "none",
      credentials: {},
      apiUrl: "https://api.candle.tv",
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected ok:false")
    expect(result.status).toBe(403)
    expect(result.code).toBe("TIER_REQUIRED")
    expect(result.message).toBe("Upgrade your tier to do this")
  })

  test("an RFC-style string error yields ok:false with rfcError", async () => {
    stubFetch(() => jsonResponse(400, { error: "authorization_pending" }))

    const result = await apiRequest("/v1/device/token", {
      auth: "none",
      credentials: {},
      apiUrl: "https://api.candle.tv",
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected ok:false")
    expect(result.status).toBe(400)
    expect(result.rfcError).toBe("authorization_pending")
  })

  test("a successful response yields ok:true with the parsed body", async () => {
    stubFetch(() => jsonResponse(200, { success: true, data: { id: "key_1" } }))

    const result = await apiRequest("/v1/keys", {
      auth: "none",
      credentials: {},
      apiUrl: "https://api.candle.tv",
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok:true")
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ success: true, data: { id: "key_1" } })
  })

  test("a network-level failure yields ok:false, status:0, and names the URL and the CANDLE_API_URL override", async () => {
    stubFetch(() => {
      throw new Error("getaddrinfo ENOTFOUND api.candle.tv")
    })

    const result = await apiRequest("/v1/keys", {
      auth: "none",
      credentials: {},
      apiUrl: "https://api.candle.tv",
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected ok:false")
    expect(result.status).toBe(0)
    expect(result.message).toContain("https://api.candle.tv/v1/keys")
    expect(result.message).toContain("CANDLE_API_URL")
  })
})

describe("apiRequest: credentials never leak into the result", () => {
  test("an ok:false result never contains the credential used to make the request", async () => {
    stubFetch(() => jsonResponse(401, { success: false, error: { code: "UNAUTHORIZED", message: "Bad token" } }))

    const result = await apiRequest("/v1/me", {
      auth: "device",
      credentials: { deviceToken: "dtok_should_never_leak_into_the_result_or_its_json" },
      apiUrl: "https://api.candle.tv",
    })

    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain("dtok_should_never_leak_into_the_result_or_its_json")
  })
})

describe("apiRequest: auth header selection", () => {
  test("auth:'device' sends Authorization: Bearer <deviceToken> and no x-api-key", async () => {
    stubFetch(() => jsonResponse(200, { success: true }))

    await apiRequest("/v1/me", {
      auth: "device",
      credentials: { deviceToken: "dtok_abc123" },
      apiUrl: "https://api.candle.tv",
    })

    const headers = lastRequest?.init.headers as Record<string, string>
    expect(headers.authorization).toBe("Bearer dtok_abc123")
    expect(headers["x-api-key"]).toBeUndefined()
  })

  test("auth:'key' sends x-api-key and no bearer", async () => {
    stubFetch(() => jsonResponse(200, { success: true }))

    await apiRequest("/v1/me", {
      auth: "key",
      credentials: { apiKey: "ck_live_xyz" },
      apiUrl: "https://api.candle.tv",
    })

    const headers = lastRequest?.init.headers as Record<string, string>
    expect(headers["x-api-key"]).toBe("ck_live_xyz")
    expect(headers.authorization).toBeUndefined()
  })

  test("auth:'none' sends neither header", async () => {
    stubFetch(() => jsonResponse(200, { success: true }))

    await apiRequest("/v1/health", {
      auth: "none",
      credentials: {},
      apiUrl: "https://api.candle.tv",
    })

    const headers = lastRequest?.init.headers as Record<string, string>
    expect(headers.authorization).toBeUndefined()
    expect(headers["x-api-key"]).toBeUndefined()
  })
})

describe("apiRequest: base URL handling", () => {
  test("a trailing slash on apiUrl does not produce a double slash in the request URL", async () => {
    stubFetch(() => jsonResponse(200, { success: true }))

    await apiRequest("/v1/health", {
      auth: "none",
      credentials: {},
      apiUrl: "https://api.candle.tv/",
    })

    expect(lastRequest?.url).toBe("https://api.candle.tv/v1/health")
  })

  test("a path without a leading slash is still joined correctly", async () => {
    stubFetch(() => jsonResponse(200, { success: true }))

    await apiRequest("v1/health", {
      auth: "none",
      credentials: {},
      apiUrl: "https://api.candle.tv",
    })

    expect(lastRequest?.url).toBe("https://api.candle.tv/v1/health")
  })
})

describe("resolveApiUrl", () => {
  afterEach(() => {
    delete process.env.CANDLE_API_URL
  })

  test("defaults to DEFAULT_API_URL when nothing else is set", () => {
    delete process.env.CANDLE_API_URL
    expect(resolveApiUrl()).toBe(DEFAULT_API_URL)
  })

  test("a configured apiUrl beats the default", () => {
    delete process.env.CANDLE_API_URL
    expect(resolveApiUrl("https://staging-api.candle.tv")).toBe("https://staging-api.candle.tv")
  })

  test("CANDLE_API_URL beats a configured apiUrl", () => {
    process.env.CANDLE_API_URL = "https://env-api.candle.tv"
    expect(resolveApiUrl("https://staging-api.candle.tv")).toBe("https://env-api.candle.tv")
  })

  test("trims trailing slashes", () => {
    delete process.env.CANDLE_API_URL
    expect(resolveApiUrl("https://staging-api.candle.tv///")).toBe("https://staging-api.candle.tv")
  })

  test("an injected env object beats a configured apiUrl and is read instead of process.env", () => {
    delete process.env.CANDLE_API_URL
    expect(resolveApiUrl("https://staging-api.candle.tv", { CANDLE_API_URL: "https://injected.candle.tv" })).toBe(
      "https://injected.candle.tv",
    )
  })

  test("an injected env object with no override falls through to the configured apiUrl, ignoring real process.env", () => {
    process.env.CANDLE_API_URL = "https://real-process-env.candle.tv"
    expect(resolveApiUrl("https://staging-api.candle.tv", {})).toBe("https://staging-api.candle.tv")
  })
})

describe("apiRequest: injected env drives the network-failure hint", () => {
  afterEach(() => {
    delete process.env.CANDLE_API_URL
  })

  test("the 'currently ...' hint reflects the injected env, not real process.env", async () => {
    process.env.CANDLE_API_URL = "https://real-process-env.candle.tv"
    stubFetch(() => {
      throw new Error("connection refused")
    })

    const result = await apiRequest("/v1/keys", {
      auth: "none",
      credentials: {},
      apiUrl: "https://api.candle.tv",
      env: { CANDLE_API_URL: "https://injected.candle.tv" },
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected ok:false")
    expect(result.message).toContain('currently "https://injected.candle.tv"')
    expect(result.message).not.toContain("real-process-env")
  })

  test("omitting env falls back to real process.env, unchanged from before this field existed", async () => {
    process.env.CANDLE_API_URL = "https://real-process-env.candle.tv"
    stubFetch(() => {
      throw new Error("connection refused")
    })

    const result = await apiRequest("/v1/keys", { auth: "none", credentials: {}, apiUrl: "https://api.candle.tv" })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected ok:false")
    expect(result.message).toContain('currently "https://real-process-env.candle.tv"')
  })
})

describe("classifyError: uiHint/docsPath lift", () => {
  test("the API's uiHint and docsPath ride the failed ApiResult so --json failures can carry a suggestion", async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          success: false,
          error: {
            code: "TIER_REQUIRED",
            message: "Pro tier required",
            uiHint: "Stake CNDL to reach Pro.",
            docsPath: "developers/agent-access",
          },
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch
    const result = await apiRequest("/api/v1/agent/tier", {
      auth: "key",
      credentials: { apiKey: "k" },
      apiUrl: "https://api.test",
      fetch: fetchFn,
    })
    if (result.ok) throw new Error("expected a failure")
    expect(result.code).toBe("TIER_REQUIRED")
    expect(result.uiHint).toBe("Stake CNDL to reach Pro.")
    expect(result.docsPath).toBe("developers/agent-access")
  })
})
