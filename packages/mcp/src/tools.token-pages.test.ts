import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { tokenPageShapes } from "./token-pages"
import { buildRequest, registerToolSubset, type ToolName } from "./tools"

const token = { chain: "solana", address: "So11111111111111111111111111111111111111112" }
const prefix = "candle_token_page_"
const versionId = "10000000-0000-4000-8000-000000000001"
const options = { idempotencyKey: "persisted-before-send" }
const cfg = { apiUrl: "https://api.test", apiKey: "fixture-key" }
const base = `${cfg.apiUrl}/api/v1/token-pages/${token.chain}/${token.address}`
const ok = (data: unknown) => Response.json({ success: true, data })
type Call = { url: string; init?: RequestInit }
const name = (suffix: string) => `${prefix}${suffix}` as ToolName
async function fixture(
  run: (f: {
    client: Client
    calls: Call[]
    answer: (fn: (call: Call, count: number) => Response | Promise<Response>) => void
  }) => Promise<void>,
  apiKey: string | undefined = cfg.apiKey,
) {
  const calls: Call[] = []
  let answer = (_call: Call, _count: number): Response | Promise<Response> => ok({ revision: "9007199254740993" })
  const server = new McpServer({ name: "token-pages-fixture", version: "1" })
  registerToolSubset(server, {
    tools: Object.keys(tokenPageShapes) as ToolName[],
    getConfig: () => ({ apiUrl: cfg.apiUrl, apiKey }),
    fetch: async (url, init) => {
      const call = { url, init }
      calls.push(call)
      return answer(call, calls.length)
    },
  })
  const client = new Client({ name: "fixture", version: "1" })
  const [caller, receiver] = InMemoryTransport.createLinkedPair()
  await server.connect(receiver)
  await client.connect(caller)
  try {
    await run({
      client,
      calls,
      answer: (fn) => {
        answer = fn
      },
    })
  } finally {
    await client.close()
    await server.close()
  }
}
const call = (client: Client, suffix: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name: name(suffix), arguments: { ...token, ...args } })
function blocks(result: Awaited<ReturnType<typeof call>>) {
  return (result.content as { text: string }[]).map((b) => JSON.parse(b.text))
}

test("public About/burn/history are keyless and uncached; capabilities are a separate keyed GET", async () => {
  await fixture(async ({ client, calls, answer }) => {
    const data = {
      items: [{ text: null, tombstone: "removed" }],
      nextCursor: "opaque:/?&",
      revision: "9007199254740993",
    }
    answer(() => ok(data))
    for (const [suffix, args] of [
      ["about", {}],
      ["burns", { limit: 5 }],
      ["history", { section: "lore", cursor: "opaque:/?&", limit: 50 }],
      ["capabilities", {}],
    ] as const) {
      expect(blocks(await call(client, suffix, args))[0]).toEqual({ success: true, data })
    }
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      new URL(base).pathname,
      `${new URL(base).pathname}/burns`,
      `${new URL(base).pathname}/sections/lore/history`,
      `${new URL(base).pathname}/capabilities`,
    ])
    expect(new URL(calls[2]?.url ?? "https://api.test/").searchParams.get("cursor")).toBe("opaque:/?&")
    calls.forEach((c, i) => {
      expect(c.init?.method).toBe("GET")
      expect(c.init?.cache).toBe("no-store")
      expect(new Headers(c.init?.headers).get("x-api-key")).toBe(i === 3 ? cfg.apiKey : null)
    })
  })
})

test("content writes send the same API DTO and Idempotency-Key, and return the server body unchanged", async () => {
  await fixture(async ({ client, calls, answer }) => {
    const data = { id: versionId, revision: "9007199254740993" }
    answer(() => ok(data))
    const cases = [
      ["claim", { kind: "holder" }, "POST", "/claims"],
      [
        "section_set",
        { section: "thesis", text: "exact\r\n🕯️ draft", baseRevision: "9007199254740992" },
        "PUT",
        "/sections/thesis",
      ],
      [
        "section_restore",
        { section: "lore", versionId, baseRevision: "9007199254740993" },
        "POST",
        "/sections/lore/restore",
      ],
      ["flag", { contentId: versionId, reason: "unsafe_link", detail: "review this item" }, "POST", "/flags"],
    ] as const
    for (const [suffix, args, method, path] of cases) {
      const result = await call(client, suffix, { ...args, ...options })
      expect(result.isError).not.toBe(true)
      expect(blocks(result)).toEqual([
        { success: true, data },
        { status: 200, retryAfter: null, ...options },
      ])
      const sent = calls.at(-1)
      if (!sent) throw new Error("No request recorded")
      expect(sent.url).toBe(`${base}${path}`)
      expect(sent.init?.method).toBe(method)
      const { section: _section, ...body } = args as Record<string, unknown>
      expect(JSON.parse(String(sent.init?.body))).toEqual(body)
      expect(new Headers(sent.init?.headers).get("Idempotency-Key")).toBe(options.idempotencyKey)
      expect(new Headers(sent.init?.headers).get("x-api-key")).toBe(cfg.apiKey)
    }
    expect(calls).toHaveLength(4)
  })
})

test("strict protocol schemas reject unknown/owner fields, invalid revisions, pagination and missing replay keys before fetch", async () => {
  await fixture(async ({ client, calls }) => {
    for (const [suffix, args] of [
      ["claim", { kind: "holder", ...options, account: "someone-else" }],
      ["claim", { kind: "holder" }],
      ["claim", { kind: "admin", ...options }],
      ["creator_challenge", { signature: "should-not-sign" }],
      ["section_set", { section: "thesis", text: "draft", baseRevision: 1, ...options }],
      ["section_set", { section: "thesis", text: "draft", baseRevision: "01", ...options }],
      ["section_restore", { section: "lore", versionId: "bad-id", baseRevision: "1", ...options }],
      ["history", { section: "lore", limit: 51 }],
      ["history", { section: "lore", limit: 1.5 }],
      ["flag", { contentId: "thesis", reason: "other", ...options }],
      ["flag", { contentId: versionId, reason: "other", detail: "x".repeat(501), ...options }],
    ] as const)
      expect((await call(client, suffix, args)).isError).toBe(true)
    expect(calls).toEqual([])
  })
})

test("all private calls need a key; public reads work without one", async () => {
  await fixture(async ({ client, calls }) => {
    for (const [suffix, args] of [
      ["capabilities", {}],
      ["creator_challenge", {}],
      ["claim", { kind: "holder", ...options }],
      ["section_set", { section: "thesis", text: "draft", baseRevision: "0", ...options }],
      ["section_restore", { section: "lore", versionId, baseRevision: "1", ...options }],
      ["flag", { contentId: versionId, reason: "spam", ...options }],
    ] as const)
      expect(blocks(await call(client, suffix, args))[0]).toMatchObject({ error: "API_KEY_REQUIRED" })
    expect(calls).toEqual([])
    await call(client, "about")
    expect(calls).toHaveLength(1)
  }, "")
})

test("creator challenges preserve exact UTF-8 bytes and signatures are explicit for both chains; no implicit actions", async () => {
  await fixture(async ({ client, calls, answer }) => {
    const challenge = {
      challengeId: versionId,
      message: "Candle token page creator proof v1\nNonce: 🕯\n",
      expiresAt: "2026-10-28T22:00:00Z",
    }
    answer(() => ok(challenge))
    expect(blocks(await call(client, "creator_challenge"))[0].data).toEqual(challenge)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.init?.body).toBe("{}")
    expect(new Headers(calls[0]?.init?.headers).has("idempotency-key")).toBe(false)
    for (const [chain, signature] of [
      ["solana", "base64-message-signature"],
      ["hood", `0x${"ab".repeat(65)}`],
    ]) {
      await call(client, "claim", { chain, kind: "creator", challengeId: versionId, signature, ...options })
      expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({
        kind: "creator",
        challengeId: versionId,
        signature,
      })
    }
    expect(calls).toHaveLength(3)
  })
})

test("auth, scope, feature-off, eligibility, proof, moderation and conflict refusals relay code/status/latest without retry or restore", async () => {
  await fixture(async ({ client, calls, answer }) => {
    for (const [code, status] of [
      ["invalid_body", 400],
      ["invalid_text", 422],
      ["invalid_signature", 422],
      ["challenge_used", 409],
      ["feature_off", 409],
      ["not_found", 404],
      ["revision_conflict", 409],
      ["idempotency_conflict", 409],
      ["insufficient_holding", 403],
      ["restricted", 403],
      ["eligibility_unavailable", 503],
      ["rate_limited", 429],
      ["SCOPE_MISSING", 403],
      ["UNAUTHORIZED", 401],
    ] as const) {
      const body = {
        success: false,
        error: code === "SCOPE_MISSING" || code === "UNAUTHORIZED" ? { code, message: "refused" } : code,
        latest: { revision: "9007199254740994", versionId },
      }
      answer(() => Response.json(body, { status, headers: { "retry-after": "60" } }))
      const before = calls.length
      const draft = { section: "thesis", text: "my draft", baseRevision: "1", ...options }
      const result = await call(client, "section_set", draft)
      expect(result.isError).toBe(true)
      expect(blocks(result)).toEqual([body, { status, retryAfter: "60", ...options }])
      expect(calls.length).toBe(before + 1)
      expect(draft.text).toBe("my draft")
    }
  })
})

test("one transport retry uses identical serialized body/key, including a response cut off after headers", async () => {
  for (const interrupted of [false, true])
    await fixture(async ({ client, calls, answer }) => {
      answer((_c, n) => {
        if (n === 1) {
          if (interrupted)
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new Error("cut off"))
                },
              }),
            )
          throw new Error("lost response")
        }
        return ok({ id: versionId, revision: "1" })
      })
      const result = await call(client, "section_set", {
        section: "thesis",
        text: "my draft",
        baseRevision: "0",
        ...options,
      })
      expect(result.isError).not.toBe(true)
      expect(calls).toHaveLength(2)
      expect(calls[0]?.init?.body).toBe(calls[1]?.init?.body)
      for (const c of calls) expect(new Headers(c.init?.headers).get("idempotency-key")).toBe(options.idempotencyKey)
    })
})

test("unknown outcomes keep the replay key and never echo transport secrets; challenge is attempted once", async () => {
  await fixture(async ({ client, calls, answer }) => {
    answer(() => {
      throw new Error("fixture-key secret draft")
    })
    const result = await call(client, "claim", { kind: "holder", ...options })
    expect(blocks(result)).toEqual([{ success: false, error: "OUTCOME_UNKNOWN", ...options }])
    expect(calls).toHaveLength(2)
    expect(JSON.stringify(result)).not.toContain("fixture-key")
    expect(JSON.stringify(result)).not.toContain("secret draft")
    expect(blocks(await call(client, "creator_challenge"))[0].error).toBe("NETWORK_ERROR")
    expect(calls).toHaveLength(3)
    answer(() => new Response("bad success"))
    expect(blocks(await call(client, "claim", { kind: "holder", ...options }))[0]).toMatchObject({
      error: "OUTCOME_UNKNOWN",
      ...options,
    })
    expect(calls).toHaveLength(4)
  })
})

test("schema list marks four reads and every state-changing call as mutations", async () => {
  await fixture(async ({ client }) => {
    const tools = (await client.listTools()).tools
    expect(tools).toHaveLength(9)
    for (const tool of tools) {
      const read = ["about", "capabilities", "burns", "history"].some((s) => tool.name === name(s))
      expect(tool.annotations?.readOnlyHint).toBe(read)
      expect(tool.annotations?.destructiveHint).toBe(!read)
      expect(tool.annotations?.idempotentHint).toBe(tool.name !== name("creator_challenge"))
    }
  })
})

test("public request construction escapes token and cursor path/query delimiters", () => {
  const req = buildRequest(
    name("history") as "candle_token_page_history",
    { ...token, address: "with/slash", section: "lore", cursor: "a&b", limit: 10 },
    cfg,
  )
  expect(req.url).toBe(
    `${cfg.apiUrl}/api/v1/token-pages/solana/with%2Fslash/sections/lore/history?cursor=a%26b&limit=10`,
  )
})
