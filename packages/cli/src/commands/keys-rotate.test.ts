/**
 * BE-2648: `candle keys rotate` gives an existing key a new secret, rewrites the profile's own
 * keychain slot when the key is this CLI's, and `--finish` ends the grace window.
 */
import { describe, expect, test } from "bun:test"
import { run } from "../index"
import { profileSecretRef } from "../profiles"
import { createCapture, createFakeStore, createRoutedFetch, createTestDeps, jsonResponse } from "../test-support"
import { parseGrace } from "./keys-rotate"

const OLD = `cndl_live_Ab3dEf9h${"o".repeat(35)}`
const NEW = `cndl_live_Ab3dEf9h${"n".repeat(35)}`
const UNTIL = Date.UTC(2026, 10, 4, 1, 0)
// A legacy config is migrated to the `default` profile on first run, so its key lives in that slot.
const SLOT = profileSecretRef("default", "apiKey")

function routes(
  rotate = () => jsonResponse(200, { key: NEW, keyPrefix: "Ab3dEf9h", rotatedAt: 1, previousValidUntil: UNTIL }),
) {
  return createRoutedFetch({
    "/api/v1/agent/keys": () =>
      jsonResponse(200, { keys: [{ keyPrefix: "Ab3dEf9h", label: "agent-one", scopes: ["swap:write"] }] }),
    "/api/v1/agent/keys/Ab3dEf9h/rotate": rotate,
    "/api/v1/agent/keys/Ab3dEf9h/rotate/finish": () => jsonResponse(200, { keyPrefix: "Ab3dEf9h", changed: true }),
  })
}
const post = (calls: { url: string; init: RequestInit }[]) => calls.filter((call) => call.init.method === "POST")

describe("parseGrace", () => {
  test("seconds, s, m and h, up to 24h", () => {
    expect(parseGrace("0")).toEqual({ ok: true, seconds: 0 })
    expect(parseGrace("90")).toEqual({ ok: true, seconds: 90 })
    expect(parseGrace("30m")).toEqual({ ok: true, seconds: 1800 })
    expect(parseGrace("24h")).toEqual({ ok: true, seconds: 86_400 })
    expect(parseGrace("25h").ok).toBe(false)
    expect(parseGrace("1d").ok).toBe(false)
    expect(parseGrace("-1").ok).toBe(false)
    expect(parseGrace("1.5h").ok).toBe(false)
  })
})

describe("keys rotate", () => {
  test("a label resolves to its prefix and the default grace is one hour", async () => {
    const { fetch, calls } = routes()
    const stdout = createCapture()
    const code = await run(
      ["keys", "rotate", "agent-one", "--yes"],
      createTestDeps({ fetch, store: createFakeStore({ device_token: "cndl_dvc_x" }), stdout }),
    )
    expect(code).toBe(0)
    const [call] = post(calls)
    expect(call?.url).toContain("/keys/Ab3dEf9h/rotate")
    expect(JSON.parse(String(call?.init.body))).toEqual({ graceSeconds: 3600 })
    expect(stdout.text).toContain(NEW)
    expect(stdout.text).toContain("not this CLI's working key")
  })

  test("the profile's own key is replaced in its keychain slot", async () => {
    const { fetch } = routes()
    const store = createFakeStore({ device_token: "cndl_dvc_x", api_key: OLD })
    const deps = createTestDeps({ fetch, store, stdout: createCapture() })
    await deps.writeConfig({ keyPrefix: "Ab3dEf9h" })
    const code = await run(["keys", "rotate", "Ab3dEf9h", "--grace", "30m", "--yes", "--json"], deps)
    expect(code).toBe(0)
    expect(await store.get(SLOT)).toBe(NEW)
    const out = JSON.parse((deps.stdout as ReturnType<typeof createCapture>).text)
    expect(out).toMatchObject({ key: NEW, stored: true, previousValidUntil: UNTIL })
  })

  test("--now sends a zero grace; --force is passed through", async () => {
    const { fetch, calls } = routes()
    const code = await run(
      ["keys", "rotate", "Ab3dEf9h", "--now", "--force", "--yes", "--json"],
      createTestDeps({ fetch, store: createFakeStore({ device_token: "cndl_dvc_x" }), stdout: createCapture() }),
    )
    expect(code).toBe(0)
    expect(JSON.parse(String(post(calls)[0]?.init.body))).toEqual({ graceSeconds: 0, force: true })
  })

  test("CANDLE_API_KEY holding the old secret is named, since the CLI cannot change it", async () => {
    const { fetch } = routes()
    const stderr = createCapture()
    const code = await run(
      ["keys", "rotate", "Ab3dEf9h", "--yes"],
      createTestDeps({
        fetch,
        store: createFakeStore({ device_token: "cndl_dvc_x" }),
        stdout: createCapture(),
        stderr,
        env: { CANDLE_API_KEY: OLD },
      }),
    )
    expect(code).toBe(0)
    expect(stderr.text.replace(/\s+/g, " ")).toContain("Update CANDLE_API_KEY where this key is deployed before")
  })

  test("--finish posts the finish route and nothing else", async () => {
    const { fetch, calls } = routes()
    const code = await run(
      ["keys", "rotate", "Ab3dEf9h", "--finish", "--json"],
      createTestDeps({ fetch, store: createFakeStore({ device_token: "cndl_dvc_x" }), stdout: createCapture() }),
    )
    expect(code).toBe(0)
    const posts = post(calls)
    expect(posts).toHaveLength(1)
    expect(posts[0]?.url).toContain("/keys/Ab3dEf9h/rotate/finish")
  })

  test("without --yes and no terminal, nothing is rotated", async () => {
    const { fetch, calls } = routes()
    const code = await run(
      ["keys", "rotate", "Ab3dEf9h"],
      createTestDeps({
        fetch,
        store: createFakeStore({ device_token: "cndl_dvc_x" }),
        stderr: createCapture(),
        isTTY: { stdin: false, stdout: false, stderr: false },
      }),
    )
    expect(code).toBe(2)
    expect(post(calls)).toHaveLength(0)
  })

  test("at a terminal the typed prefix confirms; anything else cancels", async () => {
    const { fetch, calls } = routes()
    const deps = (answer: string) =>
      createTestDeps({
        fetch,
        store: createFakeStore({ device_token: "cndl_dvc_x" }),
        stdout: createCapture(),
        stderr: createCapture(),
        isTTY: { stdin: true, stdout: false, stderr: false },
        promptLine: async () => answer,
      })
    expect(await run(["keys", "rotate", "Ab3dEf9h"], deps("no"))).toBe(1)
    expect(post(calls)).toHaveLength(0)
    expect(await run(["keys", "rotate", "Ab3dEf9h"], deps("Ab3dEf9h"))).toBe(0)
    expect(post(calls)).toHaveLength(1)
  })

  test("flag conflicts and a bad grace are usage errors before any request", async () => {
    for (const args of [
      ["--grace", "1h", "--now"],
      ["--finish", "--now"],
      ["--grace", "2d"],
    ]) {
      const { fetch, calls } = routes()
      const code = await run(
        ["keys", "rotate", "Ab3dEf9h", "--yes", ...args],
        createTestDeps({ fetch, store: createFakeStore({ device_token: "cndl_dvc_x" }), stderr: createCapture() }),
      )
      expect(code).toBe(2)
      expect(calls).toHaveLength(0)
    }
  })

  test("an API refusal exits 1 and leaves the stored key alone", async () => {
    const { fetch } = routes(() =>
      jsonResponse(409, { error: { code: "VALIDATION_FAILED", message: "A rotation's grace window is open" } }),
    )
    const store = createFakeStore({ device_token: "cndl_dvc_x", api_key: OLD })
    const deps = createTestDeps({ fetch, store, stdout: createCapture(), stderr: createCapture() })
    await deps.writeConfig({ keyPrefix: "Ab3dEf9h" })
    expect(await run(["keys", "rotate", "Ab3dEf9h", "--yes"], deps)).toBe(1)
    expect(await store.get(SLOT)).not.toBe(NEW)
  })

  test("every rotation sends an Idempotency-Key; a lost response is retried once with the same key and stored once", async () => {
    let attempts = 0
    const { fetch, calls } = routes(() => {
      attempts += 1
      if (attempts === 1) throw new TypeError("fetch failed")
      return jsonResponse(200, { key: NEW, keyPrefix: "Ab3dEf9h", rotatedAt: 1, previousValidUntil: UNTIL })
    })
    const store = createFakeStore({ device_token: "cndl_dvc_x", api_key: OLD })
    const deps = createTestDeps({ fetch, store, stdout: createCapture(), stderr: createCapture() })
    await deps.writeConfig({ keyPrefix: "Ab3dEf9h" })
    expect(await run(["keys", "rotate", "Ab3dEf9h", "--yes"], deps)).toBe(0)
    const posts = post(calls)
    expect(posts).toHaveLength(2)
    const keyOf = (c: { init: RequestInit }) => new Headers(c.init.headers).get("idempotency-key")
    expect(keyOf(posts[0] as { init: RequestInit })).toBeTruthy()
    expect(keyOf(posts[1] as { init: RequestInit })).toBe(keyOf(posts[0] as { init: RequestInit }))
    expect(await store.get(SLOT)).toBe(NEW)
  })

  test("two lost answers exit 3 and print the key; --idempotency-key reruns with it", async () => {
    const { fetch, calls } = routes(() => {
      throw new TypeError("fetch failed")
    })
    const stderr = createCapture()
    const stdout = createCapture()
    const deps = createTestDeps({ fetch, store: createFakeStore({ device_token: "cndl_dvc_x" }), stdout, stderr })
    expect(await run(["keys", "rotate", "Ab3dEf9h", "--yes", "--idempotency-key", "my-key-1"], deps)).toBe(3)
    expect(post(calls)).toHaveLength(2)
    expect(new Headers(post(calls)[0]?.init.headers).get("idempotency-key")).toBe("my-key-1")
    expect(`${stdout.text}${stderr.text}`).toContain("--idempotency-key my-key-1")
  })

  test("a 503 says the old secret is unchanged; --idempotency-key length is checked", async () => {
    const { fetch } = routes(() =>
      jsonResponse(503, {
        error: { code: "IDENTITY_UNAVAILABLE", message: "x", reason: "rotation_verifier_not_ready" },
      }),
    )
    const stderr = createCapture()
    const deps = createTestDeps({
      fetch,
      store: createFakeStore({ device_token: "cndl_dvc_x" }),
      stdout: createCapture(),
      stderr,
    })
    expect(await run(["keys", "rotate", "Ab3dEf9h", "--yes"], deps)).toBe(1)
    expect(stderr.text).toContain("old secret is unchanged")
    expect(await run(["keys", "rotate", "Ab3dEf9h", "--yes", "--idempotency-key", ""], deps)).toBe(2)
    expect(await run(["keys", "rotate", "Ab3dEf9h", "--finish", "--idempotency-key", "k"], deps)).toBe(2)
  })
})
