/**
 * BE-2948 (spec 2026-11-09-owner-confirm-device-token-design.md, 7.1, AC20): the CLI's browser confirm for
 * device-token owner steps, against a fake API. The flow lives in `apiRequest`, the CLI's one HTTP call site,
 * so the client tests cover every caller; the command tests drive `run()` end to end.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { apiRequest, OWNER_CONFIRM_HEADER, type OwnerConfirmHooks, setOwnerConfirmHooks } from "./client"
import { run } from "./index"
import { coreOwnerConfirmHooks, EXIT_OWNER_CONFIRM_PENDING, ownerConfirmPendingLine } from "./owner-confirm"
import { SECRET_REFS } from "./secret-store"
import {
  type CapturedRequest,
  createCapture,
  createFakeClock,
  createFakeConfigStore,
  createFakeStore,
  createRoutedFetch,
  createTestDeps,
  jsonResponse,
} from "./test-support"

const API = "https://api.example.test"
const CONFIRM_ID = "c".repeat(43)
const STATUS_PATH = "/api/v1/agent/device/confirm/status"

function confirmRequired(
  reason = "required",
  userCode = "KQ7M-3XPD",
  account?: { wallet: string; displayName: string | null },
) {
  return jsonResponse(403, {
    success: false,
    error: {
      code: "OWNER_CONFIRM_REQUIRED",
      message: `Confirm this in your browser: https://candle.tv/dev/agent/confirm?code=${userCode} (code ${userCode}, expires in 5 minutes). Nothing changed.`,
      retryable: true,
      ownerConfirm: {
        confirmId: CONFIRM_ID,
        userCode,
        verificationUri: "https://candle.tv/dev/agent/confirm",
        verificationUriComplete: `https://candle.tv/dev/agent/confirm?code=${userCode}`,
        expiresIn: 300,
        interval: 5,
        step: "keys.mint",
        summary: "Create API key with account:read; embedded wallet denied",
        ...(account ? { account } : {}),
        reason,
      },
    },
  })
}

const status = (value: string) => () => jsonResponse(200, { success: true, status: value, expiresAt: 0, interval: 5 })
const header = (req: CapturedRequest, name: string) =>
  (req.init.headers as Record<string, string> | undefined)?.[name] ??
  (req.init.headers as Record<string, string> | undefined)?.[name.toLowerCase()]

function hooks(clock = createFakeClock(), wait = true) {
  const shown: string[] = []
  const settled: string[] = []
  const h: OwnerConfirmHooks = {
    wait,
    sleep: clock.sleep,
    now: clock.now,
    pending: (c) => shown.push(c.userCode),
    settled: (_c, outcome) => settled.push(outcome),
  }
  return { h, shown, settled, clock }
}

afterEach(() => {
  setOwnerConfirmHooks(undefined)
})

describe("apiRequest: the confirm flow (7.1 steps 2 to 5)", () => {
  test("approved: resends the identical bytes, Idempotency-Key and all, with Candle-Owner-Confirm", async () => {
    const routed = createRoutedFetch({
      "/api/v1/agent/keys/ab12cd34/rotate": [
        () => confirmRequired(),
        () => jsonResponse(200, { key: "cndl_live_new", keyPrefix: "ab12cd34" }),
      ],
      [STATUS_PATH]: [status("pending"), status("approved")],
    })
    const { h, shown, settled, clock } = hooks()
    const result = await apiRequest("/api/v1/agent/keys/ab12cd34/rotate", {
      method: "POST",
      auth: "device",
      credentials: { deviceToken: "cndl_dvc_x" },
      apiUrl: API,
      fetch: routed.fetch,
      headers: { "Idempotency-Key": "idem-1" },
      body: { graceSeconds: 3600 },
      ownerConfirm: h,
    })
    expect(result.ok).toBe(true)
    expect(shown).toEqual(["KQ7M-3XPD"])
    expect(settled).toEqual(["approved"])
    const sends = routed.calls.filter((c) => c.url.endsWith("/rotate"))
    expect(sends).toHaveLength(2)
    expect(sends[1]?.init.body).toBe(sends[0]?.init.body)
    expect(header(sends[1] as CapturedRequest, "Idempotency-Key")).toBe("idem-1")
    expect(header(sends[1] as CapturedRequest, OWNER_CONFIRM_HEADER)).toBe(CONFIRM_ID)
    expect(header(sends[0] as CapturedRequest, OWNER_CONFIRM_HEADER)).toBeUndefined()
    // Polled with the device token and the confirmId, at the interval.
    const polls = routed.calls.filter((c) => c.url.endsWith(STATUS_PATH))
    expect(polls).toHaveLength(2)
    expect(JSON.parse(String(polls[0]?.init.body))).toEqual({ confirmId: CONFIRM_ID })
    expect(header(polls[0] as CapturedRequest, "authorization")).toBe("Bearer cndl_dvc_x")
    expect(clock.calls).toEqual([5000, 5000])
  })

  test("denied: ends non-zero with nothing resent", async () => {
    const routed = createRoutedFetch({
      "/api/v1/agent/keys": () => confirmRequired(),
      [STATUS_PATH]: status("denied"),
    })
    const { h } = hooks()
    const result = await apiRequest("/api/v1/agent/keys", {
      method: "POST",
      auth: "device",
      credentials: { deviceToken: "cndl_dvc_x" },
      apiUrl: API,
      fetch: routed.fetch,
      body: {},
      ownerConfirm: h,
    })
    expect(result).toMatchObject({
      ok: false,
      code: "OWNER_CONFIRM_DENIED",
      message: "Denied in the browser; nothing changed.",
    })
    expect(routed.calls.filter((c) => c.url.endsWith("/keys"))).toHaveLength(1)
  })

  test("expired: the window passes while pending, or the server says expired", async () => {
    for (const answer of [status("pending"), status("expired")]) {
      const routed = createRoutedFetch({ "/api/v1/agent/keys": () => confirmRequired(), [STATUS_PATH]: answer })
      const { h } = hooks()
      const result = await apiRequest("/api/v1/agent/keys", {
        method: "POST",
        auth: "device",
        credentials: { deviceToken: "cndl_dvc_x" },
        apiUrl: API,
        fetch: routed.fetch,
        body: {},
        ownerConfirm: h,
      })
      expect(result).toMatchObject({
        ok: false,
        code: "OWNER_CONFIRM_EXPIRED",
        message: "The confirmation expired; nothing changed. Run the command again.",
      })
      expect(routed.calls.filter((c) => c.url.endsWith("/keys"))).toHaveLength(1)
    }
  })

  test("a 429 on the poll adds 5 s to the interval", async () => {
    const routed = createRoutedFetch({
      "/api/v1/agent/keys": [() => confirmRequired(), () => jsonResponse(200, { key: "k" })],
      [STATUS_PATH]: [
        () => jsonResponse(429, { success: false, error: { code: "RATE_LIMITED", message: "slow", retryable: true } }),
        status("approved"),
      ],
    })
    const { h, clock } = hooks()
    const result = await apiRequest("/api/v1/agent/keys", {
      method: "POST",
      auth: "device",
      credentials: { deviceToken: "cndl_dvc_x" },
      apiUrl: API,
      fetch: routed.fetch,
      body: {},
      ownerConfirm: h,
    })
    expect(result.ok).toBe(true)
    expect(clock.calls).toEqual([5000, 10000])
  })

  test("a second 403 after a redeem is followed once; a third ends with the server's message", async () => {
    const routed = createRoutedFetch({
      "/api/v1/agent/keys": [
        () => confirmRequired(),
        () => confirmRequired("grant_mismatch", "AAAA-BBBB"),
        () => confirmRequired("grant_mismatch", "CCCC-DDDD"),
      ],
      [STATUS_PATH]: status("approved"),
    })
    const { h, shown } = hooks()
    const result = await apiRequest("/api/v1/agent/keys", {
      method: "POST",
      auth: "device",
      credentials: { deviceToken: "cndl_dvc_x" },
      apiUrl: API,
      fetch: routed.fetch,
      body: {},
      ownerConfirm: h,
    })
    expect(shown).toEqual(["KQ7M-3XPD", "AAAA-BBBB"])
    expect(result).toMatchObject({ ok: false, status: 403, code: "OWNER_CONFIRM_REQUIRED" })
    expect(result.ok ? "" : result.message).toContain("CCCC-DDDD")
    expect(routed.calls.filter((c) => c.url.endsWith("/keys"))).toHaveLength(3)
  })

  test("an agent-key request, or no hooks at all, gets the 403 back unchanged", async () => {
    const routed = createRoutedFetch({ "/api/v1/agent/keys": () => confirmRequired() })
    const { h, shown } = hooks()
    const keyed = await apiRequest("/api/v1/agent/keys", {
      method: "POST",
      auth: "key",
      credentials: { apiKey: "cndl_live_x" },
      apiUrl: API,
      fetch: routed.fetch,
      body: {},
      ownerConfirm: h,
    })
    expect(keyed).toMatchObject({ ok: false, code: "OWNER_CONFIRM_REQUIRED" })
    const bare = await apiRequest("/api/v1/agent/keys", {
      method: "POST",
      auth: "device",
      credentials: { deviceToken: "cndl_dvc_x" },
      apiUrl: API,
      fetch: routed.fetch,
      body: {},
    })
    expect(bare).toMatchObject({ ok: false, code: "OWNER_CONFIRM_REQUIRED" })
    expect(shown).toHaveLength(0)
  })

  test("the --json pending line carries the 7.1 fields and never the confirmId", () => {
    const line = ownerConfirmPendingLine({
      confirmId: CONFIRM_ID,
      userCode: "KQ7M-3XPD",
      verificationUri: "https://candle.tv/dev/agent/confirm",
      verificationUriComplete: "https://candle.tv/dev/agent/confirm?code=KQ7M-3XPD",
      expiresIn: 300,
      interval: 5,
      step: "keys.mint",
      summary: "s",
      reason: "required",
    })
    expect(JSON.parse(line)).toEqual({
      ok: false,
      pending: true,
      code: "OWNER_CONFIRM_REQUIRED",
      ownerConfirm: {
        userCode: "KQ7M-3XPD",
        verificationUriComplete: "https://candle.tv/dev/agent/confirm?code=KQ7M-3XPD",
        expiresIn: 300,
        step: "keys.mint",
        summary: "s",
      },
    })
    expect(line).not.toContain(CONFIRM_ID)
  })

  test("BE-3296: the pending line carries the account when the 403 names one, and omits it when not", () => {
    const account = { wallet: "3Cirbe5kAAAA111111111111111111111111116jDX", displayName: "Economic-Brown-Mollusk" }
    const withAccount = ownerConfirmPendingLine({
      confirmId: CONFIRM_ID,
      userCode: "KQ7M-3XPD",
      verificationUri: "https://candle.tv/dev/agent/confirm",
      verificationUriComplete: "https://candle.tv/dev/agent/confirm?code=KQ7M-3XPD",
      expiresIn: 300,
      interval: 5,
      step: "keys.mint",
      summary: "s",
      account,
      reason: "required",
    })
    expect(JSON.parse(withAccount).ownerConfirm.account).toEqual(account)
    const noName = ownerConfirmPendingLine({
      confirmId: CONFIRM_ID,
      userCode: "KQ7M-3XPD",
      verificationUri: "https://candle.tv/dev/agent/confirm",
      verificationUriComplete: "https://candle.tv/dev/agent/confirm?code=KQ7M-3XPD",
      expiresIn: 300,
      interval: 5,
      step: "keys.mint",
      summary: "s",
      account: { wallet: account.wallet, displayName: null },
      reason: "required",
    })
    expect(JSON.parse(noName).ownerConfirm.account).toEqual({ wallet: account.wallet, displayName: null })
  })
})

describe("run(): keys create through the confirm (AC20)", () => {
  const NEW_KEY = "ck_live_FIXTURE_CONFIRMED_KEY"
  function setup(statusSeq: Array<() => Response>) {
    const routed = createRoutedFetch({
      "/api/v1/agent/keys": [
        () => confirmRequired(),
        () =>
          jsonResponse(200, {
            success: true,
            key: NEW_KEY,
            keyPrefix: "ck_livenn",
            scopes: ["account:read"],
            environment: "production",
          }),
      ],
      [STATUS_PATH]: statusSeq,
    })
    const store = createFakeStore({ device_token: "cndl_dvc_x" })
    const configStore = createFakeConfigStore()
    const stdout = createCapture()
    const stderr = createCapture()
    const opened: string[] = []
    const deps = createTestDeps({
      fetch: routed.fetch,
      store,
      readConfig: configStore.readConfig,
      writeConfig: configStore.writeConfig,
      clearConfig: configStore.clearConfig,
      stdout,
      stderr,
      openBrowser: (url) => opened.push(url),
    })
    return { routed, store, stdout, stderr, opened, deps }
  }

  test("prints the summary, URL, code and warning on stderr, waits, and creates the key once approved", async () => {
    const t = setup([status("pending"), status("approved")])
    const code = await run(["keys", "create"], t.deps)
    expect(code).toBe(0)
    expect(t.stderr.text).toContain("Create API key with account:read; embedded wallet denied")
    expect(t.stderr.text).toContain("Open https://candle.tv/dev/agent/confirm?code=KQ7M-3XPD")
    expect(t.stderr.text).toContain("Code: KQ7M-3XPD")
    expect(t.stderr.text).toContain("Only approve if you just ran this command.")
    expect(t.stderr.text).not.toContain(CONFIRM_ID)
    expect(t.stdout.text).toContain(NEW_KEY)
    expect(await t.store.get(SECRET_REFS.apiKey)).toBe(NEW_KEY)
    // No browser without --open.
    expect(t.opened).toHaveLength(0)
  })

  test("BE-3296: names the account the request was made as, and the account the browser needs", async () => {
    const account = { wallet: "3Cirbe5kAAAA111111111111111111111111116jDX", displayName: "Economic-Brown-Mollusk" }
    const routed = createRoutedFetch({
      "/api/v1/agent/keys": [
        () => confirmRequired("required", "KQ7M-3XPD", account),
        () =>
          jsonResponse(200, {
            success: true,
            key: NEW_KEY,
            keyPrefix: "ck_livenn",
            scopes: ["account:read"],
            environment: "production",
          }),
      ],
      [STATUS_PATH]: [status("pending"), status("approved")],
    })
    const stdout = createCapture()
    const stderr = createCapture()
    const deps = createTestDeps({
      fetch: routed.fetch,
      store: createFakeStore({ device_token: "cndl_dvc_x" }),
      readConfig: createFakeConfigStore().readConfig,
      writeConfig: createFakeConfigStore().writeConfig,
      clearConfig: createFakeConfigStore().clearConfig,
      stdout,
      stderr,
    })
    expect(await run(["keys", "create"], deps)).toBe(0)
    expect(stderr.text).toContain(
      "This needs your approval in the browser as Economic-Brown-Mollusk (3Cir…6jDX): Create API key with account:read; embedded wallet denied",
    )
    expect(stderr.text).toContain("The browser must be signed in as Economic-Brown-Mollusk (3Cir…6jDX).")
    expect(stderr.text).not.toContain(CONFIRM_ID)
  })

  test("BE-3296: without a display name the prompt names the short wallet alone", async () => {
    const account = { wallet: "3Cirbe5kAAAA111111111111111111111111116jDX", displayName: null }
    const routed = createRoutedFetch({
      "/api/v1/agent/keys": [
        () => confirmRequired("required", "KQ7M-3XPD", account),
        () =>
          jsonResponse(200, {
            success: true,
            key: NEW_KEY,
            keyPrefix: "ck_livenn",
            scopes: ["account:read"],
            environment: "production",
          }),
      ],
      [STATUS_PATH]: [status("pending"), status("approved")],
    })
    const stdout = createCapture()
    const stderr = createCapture()
    const deps = createTestDeps({
      fetch: routed.fetch,
      store: createFakeStore({ device_token: "cndl_dvc_x" }),
      readConfig: createFakeConfigStore().readConfig,
      writeConfig: createFakeConfigStore().writeConfig,
      clearConfig: createFakeConfigStore().clearConfig,
      stdout,
      stderr,
    })
    expect(await run(["keys", "create"], deps)).toBe(0)
    expect(stderr.text).toContain("This needs your approval in the browser as 3Cir…6jDX:")
    expect(stderr.text).toContain("The browser must be signed in as 3Cir…6jDX.")
  })

  test("--open opens the console page", async () => {
    const t = setup([status("approved")])
    expect(await run(["keys", "create", "--open"], t.deps)).toBe(0)
    expect(t.opened).toEqual(["https://candle.tv/dev/agent/confirm?code=KQ7M-3XPD"])
  })

  test("--json writes one pending line to stderr and keeps stdout for the final result", async () => {
    const t = setup([status("approved")])
    expect(await run(["keys", "create", "--json"], t.deps)).toBe(0)
    const pending = t.stderr.text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { pending?: boolean })
      .filter((l) => l.pending)
    expect(pending).toHaveLength(1)
    expect(t.stdout.text).not.toContain("OWNER_CONFIRM_REQUIRED")
    expect(t.stdout.text).toContain(NEW_KEY)
  })

  test("denied exits non-zero and creates nothing", async () => {
    const t = setup([status("denied")])
    const code = await run(["keys", "create"], t.deps)
    expect(code).not.toBe(0)
    expect(t.stderr.text + t.stdout.text).toContain("Denied in the browser; nothing changed.")
    expect(await t.store.get(SECRET_REFS.apiKey)).toBeNull()
  })

  test(`--no-wait prints the challenge, polls nothing, and exits ${EXIT_OWNER_CONFIRM_PENDING}`, async () => {
    const t = setup([status("approved")])
    const code = await run(["keys", "create", "--no-wait"], t.deps)
    expect(code).toBe(EXIT_OWNER_CONFIRM_PENDING)
    expect(t.stderr.text).toContain("Code: KQ7M-3XPD")
    expect(t.routed.calls.filter((c) => c.url.endsWith(STATUS_PATH))).toHaveLength(0)
    expect(await t.store.get(SECRET_REFS.apiKey)).toBeNull()
  })
})

describe("every device-auth call reaches the API through apiRequest (7.1 inventory)", () => {
  test("no source file under packages/cli/src sends a device token around apiRequest", () => {
    const root = new URL(".", import.meta.url).pathname
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) {
          if (name !== "node_modules" && name !== "__fixtures__") walk(path)
          continue
        }
        if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name.includes("test-support")) continue
        const source = readFileSync(path, "utf8")
        // A Bearer device token built by hand would skip the confirm flow.
        if (/Bearer \$\{[^}]*[dD]evice[tT]oken/.test(source) && !path.endsWith("/client.ts")) offenders.push(path)
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})

describe("candle core: both key mints report the confirm to the Harness (7.2, AC21)", () => {
  const coreSource = readFileSync(new URL("./commands/core.ts", import.meta.url), "utf8")

  test("mintWithdrawKey and mintReadKey each pass their own core hooks to the POST /keys request", () => {
    for (const [helper, mint] of [
      ["mintWithdrawKey", "withdraw"],
      ["mintReadKey", "read"],
    ] as const) {
      const start = coreSource.indexOf(`${helper}: async`)
      expect(start).toBeGreaterThan(0)
      const block = coreSource.slice(start, coreSource.indexOf('"/api/v1/agent/keys"', start) + 600)
      expect(block).toContain(`ownerConfirm: coreOwnerConfirm("${mint}")`)
    }
  })

  for (const mint of ["withdraw", "read"] as const) {
    for (const outcome of ["approved", "denied", "expired"] as const) {
      test(`${mint} mint: pending event, poll, then ${outcome}`, async () => {
        const events: Record<string, unknown>[] = []
        const clock = createFakeClock()
        const routed = createRoutedFetch({
          "/api/v1/agent/keys": [() => confirmRequired(), () => jsonResponse(200, { key: "cndl_live_k" })],
          [STATUS_PATH]: status(outcome),
        })
        const result = await apiRequest("/api/v1/agent/keys", {
          method: "POST",
          auth: "device",
          credentials: { deviceToken: "cndl_dvc_x" },
          apiUrl: API,
          fetch: routed.fetch,
          body: { scopes: ["account:read"], embeddedWallet: "denied" },
          ownerConfirm: coreOwnerConfirmHooks(mint, {
            sleep: clock.sleep,
            now: clock.now,
            publish: (data) => events.push(data),
            cancelled: new Set(),
          }),
        })
        expect(events[0]).toEqual({
          mint,
          state: "pending",
          userCode: "KQ7M-3XPD",
          verificationUriComplete: "https://candle.tv/dev/agent/confirm?code=KQ7M-3XPD",
          expiresIn: 300,
          step: "keys.mint",
          summary: "Create API key with account:read; embedded wallet denied",
        })
        expect(JSON.stringify(events)).not.toContain(CONFIRM_ID)
        expect(events[1]).toMatchObject({ mint, state: outcome })
        expect(result.ok).toBe(outcome === "approved")
      })
    }
  }

  test("a cancel from the Harness stops the poll; nothing is resent", async () => {
    const cancelled = new Set<string>()
    const events: Record<string, unknown>[] = []
    const clock = createFakeClock()
    const routed = createRoutedFetch({
      "/api/v1/agent/keys": () => confirmRequired(),
      [STATUS_PATH]: () => {
        cancelled.add("read")
        return jsonResponse(200, { success: true, status: "pending" })
      },
    })
    const result = await apiRequest("/api/v1/agent/keys", {
      method: "POST",
      auth: "device",
      credentials: { deviceToken: "cndl_dvc_x" },
      apiUrl: API,
      fetch: routed.fetch,
      body: {},
      ownerConfirm: coreOwnerConfirmHooks("read", {
        sleep: clock.sleep,
        now: clock.now,
        publish: (d) => events.push(d),
        cancelled,
      }),
    })
    expect(result).toMatchObject({ ok: false, code: "OWNER_CONFIRM_CANCELLED" })
    expect(events.at(-1)).toMatchObject({ state: "cancelled" })
    expect(routed.calls.filter((c) => c.url.endsWith("/keys"))).toHaveLength(1)
  })
})
