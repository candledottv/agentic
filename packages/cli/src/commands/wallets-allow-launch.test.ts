/**
 * `candle wallets allow-launch` and `candle wallets disallow-launch` (BE-850), driven through
 * `run()` against a routed fake API. The device token is the only credential they take; the server
 * resolves the selectors in a preview that names each wallet's label, address and bound key, and
 * the commit sends exactly the previewed ids to `PUT /wallets/:id/capabilities`, one each.
 */
import { describe, expect, test } from "bun:test"
import { run } from "../index"
import {
  type CapturedRequest,
  createCapture,
  createFakeConfigStore,
  createFakeStore,
  createRoutedFetch,
  createTestDeps,
  jsonResponse,
  type RouteHandler,
} from "../test-support"
import { nothingToChangeLine } from "./wallets-allow-launch"

const PREVIEW = "/api/v1/agent/tee-wallets/allow-launch/preview"
const put = (id: string) => `/api/v1/agent/wallets/${id}/capabilities`
const ACCOUNT = "FfU8M5xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx8pPD"

const row = (id: string, label: string, allowLaunch: boolean, boundKeyPrefix: string | null = `cndl_live_${id}`) => ({
  id,
  chain: "solana" as const,
  address: `Addr${id}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
  label,
  boundKeyPrefix,
  allowLaunch,
})

function previewBody(enabled = true, extra: Record<string, unknown> = {}) {
  return {
    success: true,
    dryRun: true,
    capability: "allowLaunch",
    enabled,
    changed: [row("k1", "launcher-1", !enabled), row("k2", "launcher-2", !enabled)],
    unchanged: [row("k3", "launcher-3", enabled)],
    notTee: [],
    ...extra,
  }
}

const parse = (req: CapturedRequest) => JSON.parse(String(req.init.body ?? "{}")) as Record<string, unknown>

/** The preview route and one PUT per id, recording every body, method and credential. */
function api(opts: { preview?: unknown; previewStatus?: number; putStatus?: Record<string, number> } = {}) {
  const sent: Array<{ path: string; method: string; body: Record<string, unknown>; auth: string | null }> = []
  const record = (req: CapturedRequest) =>
    sent.push({
      path: new URL(req.url).pathname,
      method: String(req.init.method),
      body: parse(req),
      auth: new Headers(req.init.headers).get("authorization"),
    })
  const routes: Record<string, RouteHandler> = {
    [PREVIEW]: (req) => {
      record(req)
      return jsonResponse(opts.previewStatus ?? 200, opts.preview ?? previewBody())
    },
  }
  for (const id of ["k1", "k2", "k3"]) {
    routes[put(id)] = (req) => {
      record(req)
      const status = opts.putStatus?.[id] ?? 200
      const body = parse(req)
      return status === 200
        ? jsonResponse(200, { success: true, walletId: id, capability: "allowLaunch", enabled: body.enabled })
        : jsonResponse(status, {
            success: false,
            error: { code: "VALIDATION_FAILED", message: "Active TEE wallet not found" },
          })
    }
  }
  return { routes, sent }
}

function depsFor(
  fetch: typeof globalThis.fetch,
  overrides: { answers?: string[]; tty?: boolean; store?: Record<string, string> } = {},
) {
  const stdout = createCapture()
  const stderr = createCapture()
  const answers = [...(overrides.answers ?? ["confirm"])]
  let prompts = 0
  const configStore = createFakeConfigStore({
    profiles: { production: { account: ACCOUNT, username: "Quant-", apiUrl: "https://api.alpha.candle.tv" } },
    activeProfile: "production",
  })
  const deps = createTestDeps({
    fetch,
    store: createFakeStore(overrides.store ?? { "profile:production:device_token": "cndl_dvc_x" }),
    stdout,
    stderr,
    env: {},
    readConfig: configStore.readConfig,
    writeConfig: configStore.writeConfig,
    clearConfig: configStore.clearConfig,
    updateProfile: configStore.updateProfile,
    isTTY:
      overrides.tty === false
        ? { stdin: false, stdout: false, stderr: false }
        : { stdin: true, stdout: true, stderr: true },
    promptLine: async () => {
      prompts++
      const next = answers.shift()
      if (next === undefined) throw new Error("promptLine asked for more answers than the test scripted")
      return next
    },
    promptSecret: async () => {
      throw new Error("the vault must never be opened by wallets allow-launch")
    },
  })
  return { deps, stdout, stderr, prompts: () => prompts }
}

describe("parsing and the device-token precondition", () => {
  test("no selector is a usage error, exit 2, before any request; allow-launch has no --yes", async () => {
    for (const argv of [
      ["wallets", "allow-launch"],
      ["wallets", "disallow-launch"],
      ["wallets", "allow-launch", "launcher-1", "--yes"],
      ["wallets", "allow-launch", "launcher-1", "--bogus"],
    ]) {
      const { fetch, calls } = createRoutedFetch({})
      const { deps } = depsFor(fetch)
      expect(await run(argv, deps)).toBe(2)
      expect(calls).toHaveLength(0)
    }
  })

  test("a profile with only an API key is DEVICE_TOKEN_REQUIRED up front, with the login suggestion", async () => {
    for (const verb of ["allow-launch", "disallow-launch"]) {
      const { fetch, calls } = createRoutedFetch({})
      const { deps, stdout } = depsFor(fetch, { store: { "profile:production:api_key": "cndl_live_x" } })
      expect(await run(["wallets", verb, "launcher-*", "--json", "--no-verify-account"], deps)).toBe(1)
      expect(calls).toHaveLength(0)
      expect(JSON.parse(stdout.text)).toMatchObject({
        ok: false,
        code: "DEVICE_TOKEN_REQUIRED",
        suggestion: "Run: candle auth login",
      })
    }
  })

  test("no TTY: allow-launch is refused before the preview; disallow-launch points at --yes", async () => {
    let fake = api()
    let routed = createRoutedFetch(fake.routes)
    let d = depsFor(routed.fetch, { tty: false })
    expect(await run(["wallets", "allow-launch", "launcher-*", "--json"], d.deps)).toBe(1)
    expect(JSON.parse(d.stdout.text).code).toBe("ALLOW_LAUNCH_REQUIRES_TTY")
    expect(routed.calls).toHaveLength(0)

    fake = api({ preview: previewBody(false) })
    routed = createRoutedFetch(fake.routes)
    d = depsFor(routed.fetch, { tty: false })
    expect(await run(["wallets", "disallow-launch", "launcher-*", "--json"], d.deps)).toBe(1)
    expect(JSON.parse(d.stdout.text).suggestion).toContain("--yes")
    expect(routed.calls).toHaveLength(0)
  })
})

describe("preview, confirm, commit", () => {
  test("selectors go to the preview over the device token; the screen names label, address and bound key; the commit PUTs only the previewed ids", async () => {
    const fake = api()
    const { fetch } = createRoutedFetch(fake.routes)
    const { deps, stdout, stderr } = depsFor(fetch)
    expect(await run(["wallets", "allow-launch", "launcher-*", "0xAbC"], deps)).toBe(0)
    expect(fake.sent[0]).toMatchObject({
      path: PREVIEW,
      method: "POST",
      body: { wallets: ["launcher-*", "0xAbC"], enabled: true },
    })
    expect(fake.sent.slice(1)).toEqual([
      { path: put("k1"), method: "PUT", body: { capability: "allowLaunch", enabled: true }, auth: "Bearer cndl_dvc_x" },
      { path: put("k2"), method: "PUT", body: { capability: "allowLaunch", enabled: true }, auth: "Bearer cndl_dvc_x" },
    ])
    expect(fake.sent.every((s) => s.auth === "Bearer cndl_dvc_x")).toBe(true)
    for (const fact of ["launcher-1", "Addrk1", "cndl_live_k1", "launcher-2", "cndl_live_k2", "bound key"]) {
      expect(stderr.text).toContain(fact)
    }
    expect(stderr.text).toContain("1 already on: launcher-3")
    expect(stderr.text).toContain("These 2 wallets will be allowed to pay for a launch")
    expect(stdout.text).toEndWith("Allowed launches from 2 wallets.\n")
  })

  test("anything but confirm changes nothing", async () => {
    for (const typed of ["yes", "", "confirm please"]) {
      const fake = api()
      const { fetch } = createRoutedFetch(fake.routes)
      const { deps, stdout } = depsFor(fetch, { answers: [typed] })
      expect(await run(["wallets", "allow-launch", "launcher-*", "--json"], deps)).toBe(1)
      expect(JSON.parse(stdout.text).code).toBe("ALLOW_LAUNCH_NOT_ACKNOWLEDGED")
      expect(fake.sent.map((s) => s.method)).toEqual(["POST"])
    }
  })

  test("disallow-launch asks for confirm too, and --yes skips it (no terminal needed)", async () => {
    let fake = api({ preview: previewBody(false) })
    let routed = createRoutedFetch(fake.routes)
    let d = depsFor(routed.fetch)
    expect(await run(["wallets", "disallow-launch", "launcher-*"], d.deps)).toBe(0)
    expect(d.prompts()).toBe(1)
    expect(fake.sent[1]?.body).toEqual({ capability: "allowLaunch", enabled: false })

    fake = api({ preview: previewBody(false) })
    routed = createRoutedFetch(fake.routes)
    d = depsFor(routed.fetch, { tty: false, answers: [] })
    expect(await run(["wallets", "disallow-launch", "launcher-*", "--yes"], d.deps)).toBe(0)
    expect(d.prompts()).toBe(0)
    expect(fake.sent.filter((s) => s.method === "PUT")).toHaveLength(2)
    expect(d.stdout.text).toEndWith("Stopped launches from 2 wallets.\n")
  })

  test("--json prints exactly one document on stdout; a failed PUT is reported by id, the rest still change, exit 1", async () => {
    const fake = api({ putStatus: { k1: 404 } })
    const { fetch } = createRoutedFetch(fake.routes)
    const { deps, stdout, stderr } = depsFor(fetch)
    expect(await run(["wallets", "allow-launch", "launcher-*", "--json"], deps)).toBe(1)
    const lines = stdout.text.trim().split("\n")
    expect(lines).toHaveLength(1)
    const doc = JSON.parse(lines[0] as string)
    expect(doc).toMatchObject({ success: false, command: "wallets allow-launch", enabled: true })
    expect(doc.changed.map((r: { id: string }) => r.id)).toEqual(["k2"])
    expect(doc.failed).toEqual([
      { id: "k1", code: "WALLET_NOT_FOUND", message: "no longer an active TEE wallet on this account" },
    ])
    expect(stderr.text).toContain("launcher-1")
  })

  test("nothing to change: one line, no prompt, no PUT; naming only non-TEE wallets exits 1", async () => {
    let fake = api({ preview: previewBody(true, { changed: [], unchanged: [row("k3", "launcher-3", true)] }) })
    let routed = createRoutedFetch(fake.routes)
    let d = depsFor(routed.fetch, { answers: [] })
    expect(await run(["wallets", "allow-launch", "launcher-3"], d.deps)).toBe(0)
    expect(d.stdout.text).toEndWith("Nothing to change: that wallet already has allowLaunch on.\n")
    expect(fake.sent).toHaveLength(1)

    const plain = row("p1", "plain", false, null)
    fake = api({ preview: previewBody(true, { changed: [], unchanged: [], notTee: [plain] }) })
    routed = createRoutedFetch(fake.routes)
    d = depsFor(routed.fetch, { answers: [] })
    expect(await run(["wallets", "allow-launch", "plain"], d.deps)).toBe(1)
    expect(d.stdout.text).toEndWith("Nothing to change: plain is not a TEE wallet.\n")
    expect(nothingToChangeLine({ unchanged: [], notTee: [plain] }, true)).toBe(
      "Nothing to change: plain is not a TEE wallet.\n",
    )
  })

  test("a 404 preview (older API, or TEE launch off) is ALLOW_LAUNCH_UNSUPPORTED; not_found suggests candle wallets", async () => {
    let fake = api({
      previewStatus: 404,
      preview: { success: false, error: { code: "VALIDATION_FAILED", message: "x" } },
    })
    let routed = createRoutedFetch(fake.routes)
    let d = depsFor(routed.fetch)
    expect(await run(["wallets", "allow-launch", "launcher-*", "--json"], d.deps)).toBe(1)
    expect(JSON.parse(d.stdout.text).code).toBe("ALLOW_LAUNCH_UNSUPPORTED")

    fake = api({
      previewStatus: 400,
      preview: {
        success: false,
        error: {
          code: "VALIDATION_FAILED",
          message: "nope does not name an active linked wallet",
          reason: "not_found",
        },
      },
    })
    routed = createRoutedFetch(fake.routes)
    d = depsFor(routed.fetch)
    expect(await run(["wallets", "allow-launch", "nope", "--json"], d.deps)).toBe(1)
    expect(JSON.parse(d.stdout.text).suggestion).toContain("candle wallets")
    expect(fake.sent).toHaveLength(1)
  })
})
