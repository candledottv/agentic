import { describe, expect, test } from "bun:test"
import type { Deps } from "../deps"
import { run } from "../index"
import { createCapture, createFakeConfigStore, createFakeStore, createTestDeps } from "../test-support"
import { chainFor, EDIT_FIELDS, editBodyOf } from "./token-metadata"

const MINT = "9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT"
const HOOD = "0x52908400098527886e0f7030069857d2e4169ee7"
const KEY = "fixture-key"

type Call = { method: string; path: string; search: string; headers: Headers; body: unknown }

function fixture(answer: (call: Call) => Response | Promise<Response>, overrides: Partial<Deps> = {}) {
  const calls: Call[] = []
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    stdout,
    stderr,
    env: { CANDLE_API_KEY: KEY, CANDLE_PLAIN: "1" },
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
      return await answer(call)
    }) as typeof fetch,
    ...overrides,
  })
  return { deps, calls, stdout, stderr }
}

const PAYLOAD = {
  chain: "solana",
  mint: MINT,
  changed: true,
  version: 1,
  description: "",
  socials: { twitter: "https://x.com/gadi" },
  chainState: "candle",
  chainTx: null,
}
const edited = () => Response.json({ success: true, payload: PAYLOAD })
const json = (f: { stdout: { text: string } }) => JSON.parse(f.stdout.text)

describe("AC20: candle token edit", () => {
  test("--x sends socials.twitter, with the key and an Idempotency-Key, as a PATCH", async () => {
    const f = fixture(edited)
    expect(await run(["token", "edit", MINT, "--x", "https://x.com/gadi"], f.deps)).toBe(0)
    expect(f.calls).toHaveLength(1)
    const [call] = f.calls
    expect(call?.method).toBe("PATCH")
    expect(call?.path).toBe(`/api/v1/tokens/solana/${MINT}/metadata`)
    expect(call?.body).toEqual({ socials: { twitter: "https://x.com/gadi" } })
    expect(call?.headers.get("x-api-key")).toBe(KEY)
    expect(call?.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/)
    expect(f.stdout.text).toContain("edited")
    expect(f.stdout.text).toMatch(/Version\s+1/)
  })

  test("--clear website sends an empty string; --clear repeats; --description joins the body", async () => {
    const f = fixture(edited)
    const args = [
      "token",
      "edit",
      MINT,
      "--clear",
      "website",
      "--clear",
      "description",
      "--discord",
      "https://discord.gg/x",
    ]
    expect(await run(args, f.deps)).toBe(0)
    expect(f.calls[0]?.body).toEqual({ description: "", socials: { website: "", discord: "https://discord.gg/x" } })
  })

  test("--json prints exactly one value: the route's payload, unchanged, under data", async () => {
    const f = fixture(edited)
    expect(await run(["token", "edit", MINT, "--x", "https://x.com/gadi", "--json"], f.deps)).toBe(0)
    expect(f.stdout.text.trimEnd().split("\n")).toHaveLength(1)
    expect(json(f)).toEqual({ ok: true, data: PAYLOAD })
    expect(f.stderr.text).toBe("")
  })

  test("--chain is inferred from 0x, and --chain overrides it", async () => {
    const f = fixture(edited)
    expect(await run(["token", "edit", HOOD, "--website", "https://a.io"], f.deps)).toBe(0)
    expect(f.calls[0]?.path).toBe(`/api/v1/tokens/hood/${HOOD}/metadata`)
    expect(chainFor(MINT, undefined)).toBe("solana")
    expect(chainFor(HOOD, undefined)).toBe("hood")
    expect(chainFor(MINT, "hood")).toBe("hood")
    expect(chainFor(MINT, "eth")).toBeUndefined()
  })

  test("usage refusals send nothing: no field, a bad --clear, a flag and its --clear together", async () => {
    for (const args of [
      ["token", "edit", MINT],
      ["token", "edit", MINT, "--clear", "image"],
      ["token", "edit", MINT, "--x", "https://x.com/a", "--clear", "x"],
      ["token", "edit", MINT, "--name", "New"],
      ["token", "edit", "--x", "https://x.com/a"],
    ]) {
      const f = fixture(edited)
      expect(await run([...args, "--json"], f.deps)).toBe(2)
      expect(f.calls).toEqual([])
    }
  })

  test("a refusal is exit 1 with the server's code", async () => {
    const f = fixture(() =>
      Response.json(
        { success: false, error: { code: "NOT_TOKEN_CREATOR", message: "Only the creator", retryable: false } },
        { status: 403 },
      ),
    )
    expect(await run(["token", "edit", MINT, "--x", "https://x.com/a", "--json"], f.deps)).toBe(1)
    expect(json(f).code).toBe("NOT_TOKEN_CREATOR")
  })

  test("no answer twice is exit 3 with the key to rerun; the retry reused the same key and body", async () => {
    const f = fixture(() => {
      throw new TypeError("fetch failed")
    })
    expect(await run(["token", "edit", MINT, "--x", "https://x.com/a", "--json"], f.deps)).toBe(3)
    expect(f.calls).toHaveLength(2)
    const [a, b] = f.calls
    expect(a?.headers.get("Idempotency-Key")).toBe(b?.headers.get("Idempotency-Key") as string)
    expect(a?.body).toEqual(b?.body)
    expect(json(f)).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" })
    expect(f.stdout.text).toContain(a?.headers.get("Idempotency-Key") as string)
  })

  test("a post-commit 502 keeps the key: printed in both modes, reused by the retry, and a rerun replays instead of overwriting a newer edit", async () => {
    // A server that commits the receipt first, then fails to project: it answers 502 until healed.
    const state = { twitter: "https://x.com/old" }
    const receipts = new Map<string, typeof PAYLOAD>()
    let healthy = false
    const answer = (call: Call) => {
      const key = call.headers.get("Idempotency-Key") as string
      const replay = receipts.get(key)
      if (!replay) {
        Object.assign(state, (call.body as { socials: typeof state }).socials)
        receipts.set(key, { ...PAYLOAD, socials: { ...state } })
      }
      if (!healthy) {
        return Response.json(
          { success: false, error: { code: "UNKNOWN", message: "Projection failed", retryable: true } },
          { status: 502 },
        )
      }
      return Response.json({ success: true, payload: receipts.get(key) })
    }
    const human = fixture(answer)
    expect(await run(["token", "edit", MINT, "--x", "https://x.com/mine"], human.deps)).toBe(1)
    expect(human.calls).toHaveLength(2)
    const key = human.calls[0]?.headers.get("Idempotency-Key") as string
    expect(human.calls[1]?.headers.get("Idempotency-Key")).toBe(key)
    expect(human.stderr.text).toContain(`--idempotency-key ${key}`)

    const machine = fixture(answer)
    expect(
      await run(
        ["token", "edit", MINT, "--x", "https://x.com/mine", "--idempotency-key", "k-json", "--json"],
        machine.deps,
      ),
    ).toBe(1)
    expect(json(machine)).toMatchObject({ ok: false, code: "UNKNOWN", status: 502, idempotencyKey: "k-json" })

    // Another edit commits between attempts; the same-key rerun must replay, not re-merge.
    state.twitter = "https://x.com/newer"
    healthy = true
    const rerun = fixture(answer)
    expect(await run(["token", "edit", MINT, "--x", "https://x.com/mine", "--idempotency-key", key], rerun.deps)).toBe(
      0,
    )
    expect(state.twitter).toBe("https://x.com/newer")
  })

  test("a 502 answered by a non-retryable 503 still keeps the key: the refusal does not settle the first attempt", async () => {
    // The server commits the receipt, fails to project (502 retryable), and the switch is turned
    // off before the automatic retry: a 503 METADATA_EDIT_DISABLED, retryable false.
    const state = { twitter: "https://x.com/old" }
    const receipts = new Map<string, typeof PAYLOAD>()
    const seq = { n: 0 }
    let healed = false
    const answer = (call: Call) => {
      const key = call.headers.get("Idempotency-Key") as string
      seq.n++
      if (seq.n === 2) {
        return Response.json(
          { success: false, error: { code: "METADATA_EDIT_DISABLED", message: "Off", retryable: false } },
          { status: 503 },
        )
      }
      if (!receipts.has(key)) {
        Object.assign(state, (call.body as { socials: typeof state }).socials)
        receipts.set(key, { ...PAYLOAD, socials: { ...state } })
      }
      if (!healed) {
        return Response.json(
          { success: false, error: { code: "UNKNOWN", message: "Projection failed", retryable: true } },
          { status: 502 },
        )
      }
      return Response.json({ success: true, payload: receipts.get(key) })
    }
    const human = fixture(answer)
    expect(await run(["token", "edit", MINT, "--x", "https://x.com/mine"], human.deps)).toBe(1)
    expect(human.calls).toHaveLength(2)
    const key = human.calls[0]?.headers.get("Idempotency-Key") as string
    expect(human.calls[1]?.headers.get("Idempotency-Key")).toBe(key)
    expect(human.stderr.text).toContain("Off")
    expect(human.stderr.text).toContain(`--idempotency-key ${key}`)

    const machine = fixture(answer)
    seq.n = 0
    expect(
      await run(
        ["token", "edit", MINT, "--x", "https://x.com/mine", "--idempotency-key", "k-mixed", "--json"],
        machine.deps,
      ),
    ).toBe(1)
    expect(machine.calls).toHaveLength(2)
    expect(machine.calls[1]?.headers.get("Idempotency-Key")).toBe("k-mixed")
    expect(json(machine)).toMatchObject({
      ok: false,
      code: "METADATA_EDIT_DISABLED",
      status: 503,
      idempotencyKey: "k-mixed",
      retryCommand: expect.stringContaining("--idempotency-key k-mixed"),
    })

    // After re-enabling, another edit commits in between: the same-key rerun must replay the
    // receipt and leave the newer edit in place, not re-merge the original patch over it.
    healed = true
    state.twitter = "https://x.com/newer"
    const rerun = fixture(answer)
    expect(await run(["token", "edit", MINT, "--x", "https://x.com/mine", "--idempotency-key", key], rerun.deps)).toBe(
      0,
    )
    expect(state.twitter).toBe("https://x.com/newer")
  })

  test("a transport failure answered by a refusal still keeps the key in both modes", async () => {
    const answer = (() => {
      let n = 0
      return () => {
        n++
        if (n % 2 === 0) {
          return Response.json(
            { success: false, error: { code: "METADATA_EDIT_DISABLED", message: "Off", retryable: false } },
            { status: 503 },
          )
        }
        throw new TypeError("fetch failed")
      }
    })()
    const human = fixture(answer)
    expect(await run(["token", "edit", MINT, "--x", "https://x.com/a"], human.deps)).toBe(1)
    const key = human.calls[0]?.headers.get("Idempotency-Key") as string
    expect(human.calls[1]?.headers.get("Idempotency-Key")).toBe(key)
    expect(human.stderr.text).toContain(`--idempotency-key ${key}`)

    const machine = fixture(answer)
    expect(
      await run(
        ["token", "edit", MINT, "--x", "https://x.com/a", "--idempotency-key", "k-transport", "--json"],
        machine.deps,
      ),
    ).toBe(1)
    expect(json(machine)).toMatchObject({ ok: false, code: "METADATA_EDIT_DISABLED", idempotencyKey: "k-transport" })
  })

  test("--idempotency-key is sent as given", async () => {
    const f = fixture(edited)
    expect(await run(["token", "edit", MINT, "--x", "https://x.com/a", "--idempotency-key", "retry-1"], f.deps)).toBe(0)
    expect(f.calls[0]?.headers.get("Idempotency-Key")).toBe("retry-1")
  })

  test("the five flags are the launch definition's description and socials fields", () => {
    expect(EDIT_FIELDS.map((field) => [field.key, field.cli.flag])).toEqual([
      ["description", "--description"],
      ["socials.website", "--website"],
      ["socials.twitter", "--x"],
      ["socials.telegram", "--telegram"],
      ["socials.discord", "--discord"],
    ])
    expect(editBodyOf({ "--x": "https://x.com/a" }, [])).toEqual({ socials: { twitter: "https://x.com/a" } })
  })
})

describe("candle token history", () => {
  const ITEM = {
    version: 2,
    createdAt: "2026-11-20T12:00:00.000Z",
    changedFields: ["socials.twitter"],
    description: "d",
    socials: { twitter: "https://x.com/new" },
    prevDescription: "d",
    prevSocials: { twitter: "https://x.com/old" },
    chainState: "candle",
    chainTx: null,
    author: { kind: "agent", name: null },
  }
  const page = () =>
    Response.json({ success: true, payload: { chain: "solana", mint: MINT, items: [ITEM], nextCursor: "2" } })

  test("one address is the edit history: keyless, newest first, with what changed", async () => {
    const f = fixture(page)
    expect(await run(["token", "history", MINT, "--limit", "5"], f.deps)).toBe(0)
    expect(f.calls[0]?.path).toBe(`/api/v1/tokens/solana/${MINT}/metadata/history`)
    expect(f.calls[0]?.search).toBe("?limit=5")
    expect(f.calls[0]?.headers.get("x-api-key")).toBeNull()
    expect(f.stdout.text).toContain("version 2")
    expect(f.stdout.text).toContain("https://x.com/old -> https://x.com/new")
    expect(f.stdout.text).toContain("Agent")
    expect(f.stdout.text).toContain("--cursor 2")
  })

  test("--json prints the payload under data", async () => {
    const f = fixture(page)
    expect(await run(["token", "history", MINT, "--json"], f.deps)).toBe(0)
    expect(json(f)).toEqual({ ok: true, data: { chain: "solana", mint: MINT, items: [ITEM], nextCursor: "2" } })
  })

  test("an address and a section is still the About section history", async () => {
    const f = fixture(() => Response.json({ success: true, data: { items: [], nextCursor: null } }))
    expect(await run(["token", "history", MINT, "thesis"], f.deps)).toBe(0)
    expect(f.calls[0]?.path).toBe(`/api/v1/token-pages/solana/${MINT}/sections/thesis/history`)
  })
})

describe("AC21: the account guard", () => {
  const mismatched = () => ({
    store: createFakeStore({ "profile:staging:api_key": "k" }),
    ...createFakeConfigStore({
      activeProfile: "staging",
      profiles: { staging: { apiUrl: "https://staging.api.candle.tv", account: "CACHED1" } },
    }),
    env: {},
  })
  const answer = (c: Call) =>
    c.path === "/api/v1/agent/wallets/embedded" ? Response.json({ success: true, account: "OTHER22" }) : edited()

  test("token edit refuses a mismatched profile before it sends the edit", async () => {
    const f = fixture(answer, mismatched())
    expect(await run(["token", "edit", MINT, "--x", "https://x.com/a", "--json"], f.deps)).toBe(1)
    expect(json(f).code).toBe("ACCOUNT_MISMATCH")
    expect(f.calls.map((c) => c.path)).toEqual(["/api/v1/agent/wallets/embedded"])
  })

  test("token clusters and token history stay unguarded", async () => {
    const clusters = fixture(() => Response.json({ status: "unavailable", reason: "x" }), mismatched())
    await run(["token", "clusters", MINT, "--json"], clusters.deps)
    expect(clusters.calls.map((c) => c.path)).not.toContain("/api/v1/agent/wallets/embedded")
    const history = fixture(
      () => Response.json({ success: true, payload: { chain: "solana", mint: MINT, items: [], nextCursor: null } }),
      mismatched(),
    )
    expect(await run(["token", "history", MINT, "--json"], history.deps)).toBe(0)
    expect(history.calls.map((c) => c.path)).toEqual([`/api/v1/tokens/solana/${MINT}/metadata/history`])
  })
})
