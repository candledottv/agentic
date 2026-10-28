import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { base58, base64 } from "@scure/base"
import type { Deps } from "../deps"
import { run } from "../index"
import { createCapture, createFakeConfigStore, createFakeStore, createTestDeps } from "../test-support"
import { bpsPercent, rawUnits, sectionText, signatureFor } from "./token-pages"

const MINT = "9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL"
const HOOD = "0x00000000000000000000000000000000000000aa"
const PAGE = `/api/v1/token-pages/solana/${MINT}`
const VERSION = "11111111-2222-4333-8444-555555555555"
const CHALLENGE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
const KEY = "fixture-key"
const MESSAGE = [
  "Candle token page creator proof v1",
  "Domain: https://staging.candle.tv",
  "Environment: staging",
  `Account: ${MINT}`,
  "Chain: solana",
  `Token: ${MINT}`,
  "Creator: CreatorWallet1111111111111111111111111111111",
  "Nonce: n0nce",
  "Issued at: 2026-10-28T00:00:00.000Z",
  "Expires at: 2026-10-28T00:05:00.000Z",
  "Purpose: prove creator identity for this page; no transaction or token permission",
].join("\n")

type Call = { method: string; path: string; search: string; headers: Headers; body: unknown }
type Answer = (call: Call) => Response | Promise<Response>

function fixture(answer: Answer, overrides: Partial<Deps> = {}) {
  const calls: Call[] = []
  const stdout = createCapture()
  const stderr = createCapture()
  const written: { path: string; content: string }[] = []
  const deps = createTestDeps({
    stdout,
    stderr,
    env: { CANDLE_API_KEY: KEY },
    writeFile: async (path, content) => {
      written.push({ path, content })
    },
    promptSecret: async () => {
      throw new Error("a token page command must never prompt for a secret")
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      const call = {
        method: init?.method ?? "GET",
        path: url.pathname,
        search: url.search,
        headers: new Headers(init?.headers),
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      }
      calls.push(call)
      return answer(call)
    }) as typeof fetch,
    ...overrides,
  })
  return { deps, calls, stdout, stderr, written }
}
const ok = (data: unknown, status = 200) => Response.json({ success: true, data }, { status })
const refused = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  Response.json({ success: false, error, ...extra }, { status })
const file = (text: string | Uint8Array) => ({
  readBytes: async () => (typeof text === "string" ? new TextEncoder().encode(text) : text),
})
const json = (f: { stdout: { text: string } }) => JSON.parse(f.stdout.text)

const ABOUT = {
  token: { chain: "solana", address: MINT },
  revision: "7",
  claim: { state: "community", lead: { kind: "agent", name: null }, eligibleAccounts: null, measuredAt: null },
  sections: {
    thesis: {
      id: VERSION,
      section: "thesis",
      revision: "3",
      text: "line one\nline two\u0007",
      author: { kind: "account", name: "maker", account: "acct" },
      dev: true,
      shareBps: "62",
      source: "editor",
      createdAt: "2026-10-28T00:00:00.000Z",
      linksWithheld: true,
      newerAwaitingReview: false,
    },
  },
  facts: [
    {
      metric: "burned",
      status: "known",
      raw: "1449747000000",
      decimals: 6,
      unit: "token",
      measuredAt: "2026-10-28T00:00:00.000Z",
      source: "Candle burn ledger",
      evidence: [],
      coverage: "complete",
    },
    {
      metric: "locked",
      status: "unavailable",
      unit: "token",
      measuredAt: null,
      source: "x",
      evidence: [],
      coverage: "unknown",
    },
  ],
  latestVisibleUpdate: null,
  features: { read: true, edit: false, flags: false, updates: false, comments: false, hoodHolderEdit: false },
}

describe("about and history are public reads", () => {
  test("about sends no key and renders claim, sections and measured facts", async () => {
    const f = fixture(() => ok(ABOUT))
    expect(await run(["token", "about", MINT], f.deps)).toBe(0)
    expect(f.calls.map((c) => [c.method, c.path, c.headers.get("x-api-key")])).toEqual([["GET", PAGE, null]])
    expect(f.stdout.text).toContain("claimed by community")
    expect(f.stdout.text).toContain("Agent")
    expect(f.stdout.text).toContain("refreshing")
    expect(f.stdout.text).toContain("maker (dev)")
    expect(f.stdout.text).toContain("0.62%")
    expect(f.stdout.text).toContain("1449747")
    expect(f.stdout.text).toContain("Links are withheld pending review.")
    // Holder text keeps its line breaks and loses every other control character.
    expect(f.stdout.text).toContain("line one\nline two\n")
    expect(f.stdout.text).not.toContain("\u0007")
    expect(f.stdout.text).not.toContain("locked")
  })

  test("about --capabilities adds this account's private read with the key", async () => {
    const caps = {
      canClaim: true,
      canEdit: false,
      canFlag: true,
      creatorProven: false,
      shareBps: "49",
      observedAt: "2026-10-28T00:00:00.000Z",
      refusal: "insufficient_holding",
    }
    const f = fixture((c) => (c.path.endsWith("/capabilities") ? ok(caps) : ok(ABOUT)))
    expect(await run(["token", "about", MINT, "--capabilities", "--json"], f.deps)).toBe(0)
    expect(f.calls.map((c) => [c.path, c.headers.get("x-api-key")])).toEqual([
      [PAGE, null],
      [`${PAGE}/capabilities`, KEY],
    ])
    expect(json(f)).toEqual({ ok: true, data: ABOUT, capabilities: caps })
  })

  test("history reads one section's versions with limit and cursor and no key; tombstones have no body", async () => {
    const items = [
      {
        kind: "version",
        id: VERSION,
        revision: "2",
        text: null,
        author: { kind: "candle", name: "Candle" },
        dev: false,
        shareBps: null,
        source: "candle_seed",
        createdAt: "2026-10-28T00:00:00.000Z",
        restoredFrom: null,
        tombstone: "removed",
      },
    ]
    const f = fixture(() => ok({ token: ABOUT.token, section: "lore", items, nextCursor: "abc" }))
    expect(await run(["token", "history", MINT, "lore", "--limit", "5", "--cursor", "abc"], f.deps)).toBe(0)
    expect(f.calls[0]?.path).toBe(`${PAGE}/sections/lore/history`)
    expect(f.calls[0]?.search).toBe("?limit=5&cursor=abc")
    expect(f.calls[0]?.headers.get("x-api-key")).toBeNull()
    expect(f.stdout.text).toContain("removed")
    expect(f.stdout.text).toContain("--cursor abc")
  })

  test("a switched-off server is a refusal with its code, not a crash", async () => {
    const f = fixture(() => refused(404, "not_found"))
    expect(await run(["token", "about", MINT, "--json"], f.deps)).toBe(1)
    expect(json(f)).toMatchObject({ ok: false, code: "not_found", status: 404 })
  })

  test("Hood addresses go to the hood path", async () => {
    const f = fixture(() => ok({ ...ABOUT, token: { chain: "hood", address: HOOD } }))
    expect(await run(["token", "about", HOOD, "--chain", "hood", "--json"], f.deps)).toBe(0)
    expect(f.calls[0]?.path).toBe(`/api/v1/token-pages/hood/${HOOD}`)
  })
})

describe("claim and the creator message proof", () => {
  test("a holder claim posts kind holder with the key and an Idempotency-Key", async () => {
    const f = fixture(() => ok({ state: "claimed", kind: "holder", creatorProven: false, revision: "8" }))
    expect(await run(["token", "claim", MINT, "--json"], f.deps)).toBe(0)
    const [call] = f.calls
    expect([call?.method, call?.path, call?.body]).toEqual(["POST", `${PAGE}/claims`, { kind: "holder" }])
    expect(call?.headers.get("x-api-key")).toBe(KEY)
    expect(call?.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/)
    expect(json(f).idempotencyKey).toBe(call?.headers.get("idempotency-key"))
  })

  test("--challenge prints the exact bytes, writes them to --message-out unchanged, and builds no transaction", async () => {
    const f = fixture(() =>
      ok({ challengeId: CHALLENGE, message: MESSAGE, expiresAt: "2026-10-28T00:05:00.000Z" }, 201),
    )
    expect(
      await run(["token", "claim", MINT, "--creator", "--challenge", "--message-out", "/work/proof.txt"], f.deps),
    ).toBe(0)
    // One request, to the challenge route, with an empty body: nothing to sign is ever sent to Candle.
    expect(f.calls.map((c) => [c.method, c.path, c.body])).toEqual([["POST", `${PAGE}/creator-challenges`, {}]])
    expect(f.written).toEqual([{ path: "/work/proof.txt", content: MESSAGE }])
    expect(f.stdout.text).toContain(`-----\n${MESSAGE}\n-----\n`)
    expect(f.stdout.text).toContain(createHash("sha256").update(MESSAGE, "utf8").digest("hex"))
    expect(f.stdout.text).toContain("candle sign message")
    expect(f.stdout.text).toContain(`--challenge-id ${CHALLENGE}`)
    expect(f.stdout.text.toLowerCase()).not.toContain("private key")
  })

  test("--challenge --json carries the message, its byte length and sha256", async () => {
    const f = fixture(() =>
      ok({ challengeId: CHALLENGE, message: MESSAGE, expiresAt: "2026-10-28T00:05:00.000Z" }, 201),
    )
    expect(await run(["token", "claim", MINT, "--creator", "--challenge", "--json"], f.deps)).toBe(0)
    const out = json(f)
    expect(out.data.message).toBe(MESSAGE)
    expect(out.byteLength).toBe(new TextEncoder().encode(MESSAGE).length)
    expect(out.sha256).toBe(createHash("sha256").update(MESSAGE, "utf8").digest("hex"))
  })

  test("the signed claim sends the challenge id and a base64 signature, whichever encoding was given", async () => {
    const sig = new Uint8Array(64).fill(7)
    for (const given of [base58.encode(sig), base64.encode(sig)]) {
      const f = fixture(() => ok({ state: "claimed", kind: "creator", creatorProven: true, revision: "9" }))
      expect(
        await run(["token", "claim", MINT, "--creator", "--challenge-id", CHALLENGE, "--signature", given], f.deps),
      ).toBe(0)
      expect(f.calls[0]?.body).toEqual({ kind: "creator", challengeId: CHALLENGE, signature: base64.encode(sig) })
    }
    const hood = `0x${"ab".repeat(65)}`
    const h = fixture(() => ok({ state: "claimed", kind: "creator", creatorProven: true, revision: "1" }))
    expect(
      await run(
        ["token", "claim", HOOD, "--chain", "hood", "--creator", "--challenge-id", CHALLENGE, "--signature", hood],
        h.deps,
      ),
    ).toBe(0)
    expect(h.calls[0]?.body).toEqual({ kind: "creator", challengeId: CHALLENGE, signature: hood })
  })

  test("an expired or replayed proof is the server's refusal, exit 1, code verbatim", async () => {
    const sig = base64.encode(new Uint8Array(64))
    for (const [status, code] of [
      [422, "invalid_signature"],
      [409, "challenge_used"],
    ] as const) {
      const f = fixture(() => refused(status, code))
      const args = ["token", "claim", MINT, "--creator", "--challenge-id", CHALLENGE, "--signature", sig, "--json"]
      expect(await run(args, f.deps)).toBe(1)
      expect(json(f)).toMatchObject({ ok: false, code, status })
      expect(f.calls).toHaveLength(1)
    }
  })

  test("a creator claim without a known creator wallet points at --challenge", async () => {
    const f = fixture(() => refused(422, "invalid_signature"))
    expect(await run(["token", "claim", MINT, "--creator"], f.deps)).toBe(1)
    expect(f.calls[0]?.body).toEqual({ kind: "creator" })
    expect(f.stderr.text).toContain("--creator --challenge")
  })

  test("malformed claim flags are usage errors with no request", async () => {
    const bad = [
      ["token", "claim", MINT, "--challenge"],
      ["token", "claim", MINT, "--creator", "--challenge-id", CHALLENGE],
      ["token", "claim", MINT, "--creator", "--challenge", "--signature", "x"],
      ["token", "claim", MINT, "--creator", "--challenge-id", "nope", "--signature", base64.encode(new Uint8Array(64))],
      ["token", "claim", MINT, "--creator", "--challenge-id", CHALLENGE, "--signature", "short"],
      ["token", "claim", HOOD, "--chain", "hood", "--creator", "--challenge-id", CHALLENGE, "--signature", "0x12"],
      ["token", "claim", MINT, "--message-out", "/work/x"],
      ["token", "claim", MINT, "--chain", "evm"],
      ["token", "claim"],
    ]
    for (const args of bad) {
      const f = fixture(() => ok({}))
      expect(await run(args, f.deps)).toBe(2)
      expect(f.calls).toHaveLength(0)
    }
  })
})

describe("section set and restore", () => {
  const saved = () => ok({ id: VERSION, revision: "4" }, 201)

  test("set reads --file, normalizes CRLF and sends text with the base revision", async () => {
    const f = fixture(saved, file("first\r\nsecond"))
    expect(
      await run(
        ["token", "section", "set", MINT, "thesis", "--file", "/work/t.txt", "--base-revision", "3", "--json"],
        f.deps,
      ),
    ).toBe(0)
    const [call] = f.calls
    expect([call?.method, call?.path]).toEqual(["PUT", `${PAGE}/sections/thesis`])
    expect(call?.body).toEqual({ text: "first\nsecond", baseRevision: "3" })
    expect(json(f).data).toEqual({ id: VERSION, revision: "4" })
  })

  test("a revision conflict exits 4, names the latest revision and leaves the draft untouched", async () => {
    const latest = { revision: "5", versionId: VERSION }
    const f = fixture(() => refused(409, "revision_conflict", { latest }), file("my draft"))
    const args = ["token", "section", "set", MINT, "lore", "--file", "/work/d.txt", "--base-revision", "3"]
    expect(await run(args, f.deps)).toBe(4)
    expect(f.stderr.text).toContain("latest is revision 5")
    expect(f.stderr.text).toContain("Your file was not changed")
    expect(f.written).toEqual([])
    // No body logging: the draft never reaches the terminal.
    expect(f.stderr.text + f.stdout.text).not.toContain("my draft")

    const j = fixture(() => refused(409, "revision_conflict", { latest }), file("my draft"))
    expect(await run([...args, "--json"], j.deps)).toBe(4)
    expect(json(j)).toMatchObject({ ok: false, code: "revision_conflict", latest })
  })

  test("restore posts the version id and base revision", async () => {
    const f = fixture(saved)
    expect(
      await run(
        ["token", "section", "restore", MINT, "tokenomics", "--version-id", VERSION, "--base-revision", "4"],
        f.deps,
      ),
    ).toBe(0)
    expect([f.calls[0]?.method, f.calls[0]?.path, f.calls[0]?.body]).toEqual([
      "POST",
      `${PAGE}/sections/tokenomics/restore`,
      { versionId: VERSION, baseRevision: "4" },
    ])
    expect(f.stdout.text).toContain("restored as a new version")
  })

  test("the file limits refuse locally, exit 2, and send nothing", async () => {
    const cases: [string, string | Uint8Array][] = [
      ["thesis", "x".repeat(281)],
      ["lore", "x".repeat(5001)],
      ["lore", "x".repeat(32 * 1024 + 1)],
      ["thesis", new Uint8Array([0xc3, 0x28])],
      ["thesis", "bell\u0007"],
      ["thesis", "nul\u0000"],
    ]
    for (const [section, body] of cases) {
      const f = fixture(saved, file(body))
      const args = ["token", "section", "set", MINT, section, "--file", "/work/t", "--base-revision", "0", "--json"]
      expect(await run(args, f.deps)).toBe(2)
      expect(f.calls).toHaveLength(0)
      expect(json(f).code).toBe("TEXT_REFUSED")
    }
  })

  test("the limit counts code points: 280 emoji is a full thesis; tab and newline are allowed", async () => {
    const f = fixture(saved, file("🕯".repeat(280)))
    expect(await run(["token", "section", "set", MINT, "thesis", "--file", "/w", "--base-revision", "0"], f.deps)).toBe(
      0,
    )
    const g = fixture(saved, file("a\tb\nc"))
    expect(await run(["token", "section", "set", MINT, "thesis", "--file", "/w", "--base-revision", "0"], g.deps)).toBe(
      0,
    )
  })

  test("an empty file clears only with --clear", async () => {
    const f = fixture(saved, file(""))
    expect(await run(["token", "section", "set", MINT, "lore", "--file", "/w", "--base-revision", "2"], f.deps)).toBe(2)
    expect(f.calls).toHaveLength(0)
    const g = fixture(saved, file("\n"))
    expect(
      await run(["token", "section", "set", MINT, "lore", "--file", "/w", "--base-revision", "2", "--clear"], g.deps),
    ).toBe(0)
    expect(g.calls[0]?.body).toEqual({ text: "\n", baseRevision: "2" })
    const h = fixture(saved, file("words"))
    expect(
      await run(["token", "section", "set", MINT, "lore", "--file", "/w", "--base-revision", "2", "--clear"], h.deps),
    ).toBe(2)
  })

  test("malformed section flags are usage errors with no request", async () => {
    for (const args of [
      ["token", "section"],
      ["token", "section", "edit", MINT, "thesis"],
      ["token", "section", "set", MINT, "summary", "--file", "/w", "--base-revision", "0"],
      ["token", "section", "set", MINT, "thesis", "--file", "/w"],
      ["token", "section", "set", MINT, "thesis", "--file", "/w", "--base-revision", "-1"],
      ["token", "section", "set", MINT, "thesis", "--base-revision", "0"],
      ["token", "section", "restore", MINT, "thesis", "--version-id", "v1", "--base-revision", "0"],
      ["token", "section", "restore", MINT, "thesis", "--file", "/w", "--base-revision", "0"],
    ]) {
      const f = fixture(saved, file("x"))
      expect(await run(args, f.deps)).toBe(2)
      expect(f.calls).toHaveLength(0)
    }
  })
})

describe("idempotent retry and refusals", () => {
  test("no answer is retried once with the same key and body", async () => {
    let n = 0
    const f = fixture(() => {
      n += 1
      if (n === 1) throw new Error("ECONNRESET")
      return ok({ state: "claimed", kind: "holder", creatorProven: false, revision: "2" })
    })
    expect(await run(["token", "claim", MINT, "--json"], f.deps)).toBe(0)
    expect(f.calls).toHaveLength(2)
    expect(f.calls[0]?.headers.get("idempotency-key")).toBe(f.calls[1]?.headers.get("idempotency-key"))
    expect(f.calls[0]?.body).toEqual(f.calls[1]?.body)
  })

  test("two unanswered attempts exit 3 and print the key to rerun with; --idempotency-key is sent as given", async () => {
    const f = fixture(() => {
      throw new Error("ECONNRESET")
    })
    const args = [
      "token",
      "flag",
      MINT,
      "--content",
      VERSION,
      "--reason",
      "spam",
      "--idempotency-key",
      "retry-me",
      "--json",
    ]
    expect(await run(args, f.deps)).toBe(3)
    expect(f.calls.map((c) => c.headers.get("idempotency-key"))).toEqual(["retry-me", "retry-me"])
    expect(json(f)).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN", details: { idempotencyKey: "retry-me" } })
  })

  const cutOff = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("body disconnected"))
        },
      }),
      { status: 200 },
    )

  test("a response body that disconnects is retried once with the same key and body", async () => {
    let n = 0
    const f = fixture(() => {
      n += 1
      return n === 1 ? cutOff() : ok({ state: "claimed", kind: "holder", creatorProven: false, revision: "2" })
    })
    expect(await run(["token", "claim", MINT, "--json"], f.deps)).toBe(0)
    expect(f.calls).toHaveLength(2)
    expect(f.calls[0]?.headers.get("idempotency-key")).toBe(f.calls[1]?.headers.get("idempotency-key"))
    expect(f.calls[0]?.body).toEqual(f.calls[1]?.body)
  })

  test("two disconnected response bodies exit 3 with OUTCOME_UNKNOWN and the original key", async () => {
    const f = fixture(() => cutOff())
    expect(await run(["token", "claim", MINT, "--idempotency-key", "cut-off", "--json"], f.deps)).toBe(3)
    expect(f.calls).toHaveLength(2)
    expect(json(f)).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN", details: { idempotencyKey: "cut-off" } })
  })

  test("an answered refusal is never retried", async () => {
    const f = fixture(() => refused(503, "eligibility_unavailable"))
    expect(await run(["token", "claim", MINT, "--json"], f.deps)).toBe(1)
    expect(f.calls).toHaveLength(1)
    expect(json(f)).toMatchObject({ code: "eligibility_unavailable", status: 503 })
  })

  test("feature_off, insufficient_holding, restricted and idempotency_conflict keep their codes", async () => {
    for (const [status, code] of [
      [409, "feature_off"],
      [403, "insufficient_holding"],
      [403, "restricted"],
      [409, "idempotency_conflict"],
    ] as const) {
      const f = fixture(() => refused(status, code), file("text"))
      const args = ["token", "section", "set", MINT, "thesis", "--file", "/w", "--base-revision", "0", "--json"]
      expect(await run(args, f.deps)).toBe(1)
      expect(json(f)).toMatchObject({ ok: false, code, status })
    }
    const human = fixture(() => refused(409, "feature_off"))
    expect(await run(["token", "claim", MINT], human.deps)).toBe(1)
    expect(human.stderr.text).toContain("switched off")
  })

  test("a wrong-scope key gets the API's own error envelope, and the key is never printed", async () => {
    const f = fixture(() =>
      Response.json(
        { error: { code: "INSUFFICIENT_SCOPE", message: "This key lacks token-pages:write" } },
        { status: 403 },
      ),
    )
    expect(await run(["token", "claim", MINT, "--json"], f.deps)).toBe(1)
    expect(json(f).code).toBe("INSUFFICIENT_SCOPE")
    expect(f.stdout.text + f.stderr.text).not.toContain(KEY)
  })

  test("a write without a key refuses locally and names the scopes", async () => {
    const f = fixture(() => ok({}), { env: {} })
    expect(await run(["token", "claim", MINT, "--json"], f.deps)).toBe(1)
    expect(f.calls).toHaveLength(0)
    expect(json(f)).toMatchObject({ code: "API_KEY_REQUIRED" })
    expect(json(f).suggestion).toContain("token-pages:read,token-pages:write")
  })
})

describe("flag", () => {
  test("posts the exact content id, reason and detail", async () => {
    const f = fixture(() => ok({ contentId: VERSION, flagged: true, hidden: true }))
    expect(
      await run(
        ["token", "flag", MINT, "--content", VERSION, "--reason", "unsafe_link", "--detail", "bad link"],
        f.deps,
      ),
    ).toBe(0)
    expect(f.calls[0]?.body).toEqual({ contentId: VERSION, reason: "unsafe_link", detail: "bad link" })
    expect(f.calls[0]?.path).toBe(`${PAGE}/flags`)
    expect(f.stdout.text).toContain("pending Candle review")
  })

  test("bad reason, id or detail length is a usage error with no request", async () => {
    for (const args of [
      ["token", "flag", MINT, "--content", VERSION, "--reason", "dislike"],
      ["token", "flag", MINT, "--content", "thesis", "--reason", "spam"],
      ["token", "flag", MINT, "--content", VERSION, "--reason", "spam", "--detail", "x".repeat(501)],
      ["token", "flag", MINT, "--content", VERSION, "--reason", "spam", "--idempotency-key", "k".repeat(129)],
    ]) {
      const f = fixture(() => ok({}))
      expect(await run(args, f.deps)).toBe(2)
      expect(f.calls).toHaveLength(0)
    }
  })
})

describe("the account guard", () => {
  const mismatched = () => ({
    store: createFakeStore({ "profile:staging:api_key": "k" }),
    ...createFakeConfigStore({
      activeProfile: "staging",
      profiles: { staging: { apiUrl: "https://staging.api.candle.tv", account: "CACHED1" } },
    }),
    env: {},
  })
  const answer: Answer = (c) =>
    c.path === "/api/v1/agent/wallets/embedded" ? Response.json({ success: true, account: "OTHER22" }) : ok(ABOUT)

  test("a write refuses a mismatched profile before it sends anything", async () => {
    for (const args of [
      ["token", "claim", MINT, "--json"],
      ["token", "flag", MINT, "--content", VERSION, "--reason", "spam", "--json"],
      ["token", "about", MINT, "--capabilities", "--json"],
    ]) {
      const f = fixture(answer, mismatched())
      expect(await run(args, f.deps)).toBe(1)
      expect(json(f).code).toBe("ACCOUNT_MISMATCH")
      expect(f.calls.map((c) => c.path)).toEqual(["/api/v1/agent/wallets/embedded"])
    }
  })

  test("the public reads stay unguarded", async () => {
    const f = fixture(answer, mismatched())
    expect(await run(["token", "about", MINT, "--json"], f.deps)).toBe(0)
    expect(f.calls.map((c) => c.path)).toEqual([PAGE])
  })
})

describe("helpers", () => {
  test("bpsPercent and rawUnits are exact past 2^53", () => {
    expect(bpsPercent("50")).toBe("0.50%")
    expect(bpsPercent("10000")).toBe("100.00%")
    expect(bpsPercent(null)).toBeUndefined()
    expect(rawUnits("123456789012345678901234567890", 9)).toBe("123456789012345678901.23456789")
    expect(rawUnits("5", 6)).toBe("0.000005")
    expect(rawUnits("1000000", 6)).toBe("1")
  })

  test("sectionText refuses lone surrogates' replacement and keeps CR-only lines as newlines", () => {
    expect(sectionText(new TextEncoder().encode("a\rb"), "thesis")).toEqual({ text: "a\nb" })
    expect("error" in sectionText(new Uint8Array([0xed, 0xa0, 0x80]), "thesis")).toBe(true)
  })

  test("signatureFor accepts only 64-byte Solana and 65-byte Hood signatures", () => {
    expect(signatureFor("solana", base64.encode(new Uint8Array(63)))).toBeUndefined()
    expect(signatureFor("hood", `0x${"ab".repeat(64)}`)).toBeUndefined()
  })
})
