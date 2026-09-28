/**
 * `candle keys update --embedded-wallet` and `candle keys self embedded-wallet deny` (BE-503, CLI
 * 0.11.10 remediation spec, R5.9, R5.11). Driven through `run()` against a fake API that answers
 * the two `PUT .../embedded-wallet` routes the way B1's handler does.
 */
import { describe, expect, test } from "bun:test"
import { run } from "../index"
import {
  type CapturedRequest,
  createCapture,
  createFakeStore,
  createRoutedFetch,
  createTestDeps,
  jsonResponse,
} from "../test-support"

const PREFIX = "Ab3dEf9h"
const API_KEY = `cndl_live_${PREFIX}${"q".repeat(35)}`

/** The owner route: previews and commits against one stored value, with B1's compare-and-swap. */
function ownerApi(stored: { value: "allowed" | "denied" }) {
  return createRoutedFetch({
    "/api/v1/agent/keys": () =>
      jsonResponse(200, { keys: [{ keyPrefix: PREFIX, label: "agent-one", scopes: ["swap:write"] }] }),
    [`/api/v1/agent/keys/${PREFIX}/embedded-wallet`]: (req: CapturedRequest) => {
      const body = JSON.parse(String(req.init.body)) as { permission: string; dryRun?: boolean; expect?: string }
      const from = stored.value
      const to = body.permission as "allowed" | "denied"
      const direction = from === to ? "unchanged" : to === "allowed" ? "widen" : "narrow"
      if (!body.dryRun) {
        if (body.expect !== from)
          return jsonResponse(409, { success: false, error: { code: "KEY_ACCESS_STALE", message: "changed" } })
        stored.value = to
      }
      return jsonResponse(200, {
        success: true,
        dryRun: body.dryRun === true,
        keyPrefix: PREFIX,
        label: "agent-one",
        direction,
        from,
        to,
        ...(!body.dryRun && direction !== "unchanged" ? { changeId: "chg1", at: 1 } : {}),
      })
    },
  })
}

const bodies = (calls: CapturedRequest[]) =>
  calls.filter((c) => c.url.endsWith("/embedded-wallet")).map((c) => JSON.parse(String(c.init.body)))

describe("keys update --embedded-wallet (device token)", () => {
  test("allow: dry run, the screen, the prefix typed back, then a commit naming the previewed value", async () => {
    const stored = { value: "denied" as "allowed" | "denied" }
    const { fetch, calls } = ownerApi(stored)
    const stdout = createCapture()
    const stderr = createCapture()
    const prompts: string[] = []
    const deps = createTestDeps({ fetch, store: createFakeStore({ device_token: "cndl_dvc_x" }), stdout, stderr })
    deps.promptLine = async (text) => {
      prompts.push(text)
      return PREFIX
    }
    expect(await run(["keys", "update", "agent-one", "--embedded-wallet", "allow"], deps)).toBe(0)
    expect(bodies(calls)).toEqual([
      { permission: "allowed", dryRun: true },
      { permission: "allowed", expect: "denied" },
    ])
    expect(prompts).toEqual([`Type the key prefix ${PREFIX} to allow it: `])
    expect(stderr.text).toContain("Embedded wallet denied  ->  allowed   (widen)")
    expect(stdout.text).toContain(`${PREFIX} (agent-one)'s embedded wallet is now allowed. Change id chg1`)
    expect(stored.value).toBe("allowed")
  })

  test("allow with the wrong prefix typed changes nothing", async () => {
    const stored = { value: "denied" as "allowed" | "denied" }
    const { fetch, calls } = ownerApi(stored)
    const deps = createTestDeps({ fetch, store: createFakeStore({ device_token: "cndl_dvc_x" }) })
    deps.promptLine = async () => "nope"
    expect(await run(["keys", "update", PREFIX, "--embedded-wallet", "allow"], deps)).toBe(1)
    expect(bodies(calls)).toHaveLength(1)
    expect(stored.value).toBe("denied")
  })

  test("allow needs a terminal, and --yes cannot stand in for it", async () => {
    for (const [argv, exit] of [
      [["keys", "update", PREFIX, "--embedded-wallet", "allow", "--json"], 1],
      [["keys", "update", PREFIX, "--embedded-wallet", "allow", "--yes", "--json"], 2],
    ] as const) {
      const stored = { value: "denied" as "allowed" | "denied" }
      const { fetch, calls } = ownerApi(stored)
      const deps = createTestDeps({ fetch, store: createFakeStore({ device_token: "cndl_dvc_x" }) })
      deps.isTTY = { stdin: false, stdout: false, stderr: false }
      expect(await run([...argv], deps)).toBe(exit)
      expect(bodies(calls)).toHaveLength(1)
      expect(stored.value).toBe("denied")
    }
  })

  test("deny with --yes commits without a prompt or a terminal", async () => {
    const stored = { value: "allowed" as "allowed" | "denied" }
    const { fetch, calls } = ownerApi(stored)
    const stdout = createCapture()
    const deps = createTestDeps({ fetch, store: createFakeStore({ device_token: "cndl_dvc_x" }), stdout })
    deps.isTTY = { stdin: false, stdout: false, stderr: false }
    expect(await run(["keys", "update", PREFIX, "--embedded-wallet", "deny", "--yes", "--json"], deps)).toBe(0)
    expect(bodies(calls)).toEqual([
      { permission: "denied", dryRun: true },
      { permission: "denied", expect: "allowed" },
    ])
    expect(JSON.parse(stdout.text)).toMatchObject({ direction: "narrow", to: "denied", command: "keys update" })
  })

  test("an unchanged value previews and stops: nothing is committed", async () => {
    const stored = { value: "denied" as "allowed" | "denied" }
    const { fetch, calls } = ownerApi(stored)
    const stdout = createCapture()
    const deps = createTestDeps({ fetch, store: createFakeStore({ device_token: "cndl_dvc_x" }), stdout })
    expect(await run(["keys", "update", PREFIX, "--embedded-wallet", "deny"], deps)).toBe(0)
    expect(bodies(calls)).toHaveLength(1)
    expect(stdout.text).toContain("already denied. Nothing changed.")
  })

  test("usage: a missing or unknown value, self, and no key are exit 2 with no request", async () => {
    for (const argv of [
      ["keys", "update", PREFIX],
      ["keys", "update", PREFIX, "--embedded-wallet", "allowed"],
      ["keys", "update", "self", "--embedded-wallet", "deny"],
      ["keys", "update", "--embedded-wallet", "deny"],
    ]) {
      const { fetch, calls } = ownerApi({ value: "allowed" })
      expect(await run(argv, createTestDeps({ fetch, store: createFakeStore({ device_token: "cndl_dvc_x" }) }))).toBe(2)
      expect(calls).toHaveLength(0)
    }
  })

  test("without a device token it fails before any request", async () => {
    const { fetch, calls } = ownerApi({ value: "allowed" })
    const stdout = createCapture()
    const code = await run(
      ["keys", "update", PREFIX, "--embedded-wallet", "deny", "--yes", "--json"],
      createTestDeps({ fetch, store: createFakeStore({}), stdout }),
    )
    expect(code).toBe(1)
    expect(calls).toHaveLength(0)
    expect(JSON.parse(stdout.text).code).toBe("NO_DEVICE_TOKEN")
  })

  test("an API without the route (a codeless 404) says so rather than 'key not found'", async () => {
    const { fetch } = createRoutedFetch({
      [`/api/v1/agent/keys/${PREFIX}/embedded-wallet`]: () => new Response("404 Not Found", { status: 404 }),
    })
    const stdout = createCapture()
    const code = await run(
      ["keys", "update", PREFIX, "--embedded-wallet", "deny", "--yes", "--json"],
      createTestDeps({ fetch, store: createFakeStore({ device_token: "cndl_dvc_x" }), stdout }),
    )
    expect(code).toBe(1)
    expect(JSON.parse(stdout.text).code).toBe("EMBEDDED_WALLET_UNSUPPORTED")
  })
})

describe("keys self embedded-wallet deny (the profile's own API key)", () => {
  test("denies itself with no prompt and no terminal, on the self route with the key's credential", async () => {
    const { fetch, calls } = createRoutedFetch({
      "/api/v1/agent/keys/self/embedded-wallet": () =>
        jsonResponse(200, {
          success: true,
          dryRun: false,
          keyPrefix: PREFIX,
          label: null,
          direction: "narrow",
          from: "allowed",
          to: "denied",
          changeId: "chg2",
          at: 1,
        }),
    })
    const stdout = createCapture()
    const deps = createTestDeps({ fetch, store: createFakeStore({}), stdout, env: { CANDLE_API_KEY: API_KEY } })
    deps.isTTY = { stdin: false, stdout: false, stderr: false }
    expect(await run(["keys", "self", "embedded-wallet", "deny"], deps)).toBe(0)
    expect(bodies(calls)).toEqual([{ permission: "denied" }])
    expect(new Headers(calls[0]?.init.headers).get("x-api-key")).toBe(API_KEY)
    expect(stdout.text).toContain(`${PREFIX}'s embedded wallet is now denied. Change id chg2`)
  })

  test("allow is refused locally before any request: a key can never allow itself", async () => {
    const { fetch, calls } = createRoutedFetch({})
    const stdout = createCapture()
    const deps = createTestDeps({ fetch, store: createFakeStore({}), stdout, env: { CANDLE_API_KEY: API_KEY } })
    expect(await run(["keys", "self", "embedded-wallet", "allow", "--json"], deps)).toBe(1)
    expect(calls).toHaveLength(0)
    const failure = JSON.parse(stdout.text)
    expect(failure.code).toBe("LOOSEN_REQUIRES_SESSION")
    expect(failure.suggestion).toContain("candle keys update <prefix> --embedded-wallet allow")
  })

  test("the server's LOOSEN_REQUIRES_SESSION is passed through with the owner's fix", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys/self/embedded-wallet": () =>
        jsonResponse(403, { success: false, error: { code: "LOOSEN_REQUIRES_SESSION", message: "no" } }),
    })
    const stdout = createCapture()
    const deps = createTestDeps({ fetch, store: createFakeStore({}), stdout, env: { CANDLE_API_KEY: API_KEY } })
    expect(await run(["keys", "self", "embedded-wallet", "deny", "--json"], deps)).toBe(1)
    expect(JSON.parse(stdout.text)).toMatchObject({ code: "LOOSEN_REQUIRES_SESSION" })
  })

  test("usage: another setting, a missing value, or an extra word is exit 2 with no request", async () => {
    for (const argv of [
      ["keys", "self"],
      ["keys", "self", "embedded-wallet"],
      ["keys", "self", "access", "deny"],
      ["keys", "self", "embedded-wallet", "maybe"],
      ["keys", "self", "embedded-wallet", "deny", "now"],
    ]) {
      const { fetch, calls } = createRoutedFetch({})
      const deps = createTestDeps({ fetch, store: createFakeStore({}), env: { CANDLE_API_KEY: API_KEY } })
      expect(await run(argv, deps)).toBe(2)
      expect(calls).toHaveLength(0)
    }
  })

  test("with no API key it fails before any request", async () => {
    const { fetch, calls } = createRoutedFetch({})
    const stdout = createCapture()
    expect(
      await run(
        ["keys", "self", "embedded-wallet", "deny", "--json"],
        createTestDeps({ fetch, store: createFakeStore({}), stdout }),
      ),
    ).toBe(1)
    expect(calls).toHaveLength(0)
    expect(JSON.parse(stdout.text).code).toBe("API_KEY_REQUIRED")
  })
})
