/**
 * `candle tee rebind` and `candle tee rebinds` (BE-303, spec
 * docs/superpowers/specs/2026-09-23-tee-wallet-rebind-design.md, tests L1 to L7 and L9), driven
 * through `run()` against a routed fake API. The vault is never opened: the deps carry no vault
 * and no prompt for a secret, and a command that reached for either would throw.
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

const TO = "Ab3dEf9h"
const FROM = "B6P-TSRs"
const ADDR_1 = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
const ADDR_2 = "9yLMtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosg222"
const ACCOUNT = "FfU8M5xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx8pPD"

type ToKey = {
  keyPrefix: string
  label: string | null
  paused: boolean
  walletScope: "all" | "selected"
  tradeReady: { sol: boolean; usdc: boolean }
  missingCaps: string[]
  launchScope: boolean
}

const readyKey: ToKey = {
  keyPrefix: TO,
  label: "tr-01",
  paused: true,
  walletScope: "all",
  tradeReady: { sol: true, usdc: false },
  missingCaps: ["spendLimits.usdc"],
  launchScope: false,
}

function previewBody(toKey: ToKey = readyKey, extra: Record<string, unknown> = {}) {
  return {
    success: true,
    dryRun: true,
    toKey,
    rebound: [
      { id: "k57", address: ADDR_1, label: "tr-01", fromKeyPrefix: FROM, allowLaunch: false },
      { id: "k58", address: ADDR_2, label: "tr-02", fromKeyPrefix: FROM, allowLaunch: true },
    ],
    unchanged: [{ id: "k59", address: "AddrThree", label: "tr-03" }],
    ...extra,
  }
}

function commitBody() {
  return {
    success: true,
    dryRun: false,
    toKey: readyKey,
    rebound: [
      { id: "k57", address: ADDR_1, label: "tr-01", fromKeyPrefix: FROM, allowLaunch: false, auditId: "aud1" },
      { id: "k58", address: ADDR_2, label: "tr-02", fromKeyPrefix: FROM, allowLaunch: true, auditId: "aud2" },
    ],
    unchanged: [{ id: "k59", address: "AddrThree", label: "tr-03" }],
  }
}

const parse = (req: CapturedRequest) => JSON.parse(String(req.init.body ?? "{}")) as Record<string, unknown>

/** A rebind API that answers the preview and the commit in order, recording both bodies. */
function rebindApi(opts: { preview?: unknown; commit?: unknown; previewStatus?: number; commitStatus?: number } = {}) {
  const bodies: Record<string, unknown>[] = []
  const handlers: RouteHandler[] = [
    (req) => {
      bodies.push(parse(req))
      return jsonResponse(opts.previewStatus ?? 200, opts.preview ?? previewBody())
    },
    (req) => {
      bodies.push(parse(req))
      return jsonResponse(opts.commitStatus ?? 200, opts.commit ?? commitBody())
    },
  ]
  return { handlers, bodies }
}

function depsFor(
  fetch: typeof globalThis.fetch,
  overrides: { answers?: string[]; tty?: boolean; store?: Record<string, string>; env?: Record<string, string> } = {},
) {
  const stdout = createCapture()
  const stderr = createCapture()
  const answers = [...(overrides.answers ?? ["confirm"])]
  const configStore = createFakeConfigStore({
    profiles: { production: { account: ACCOUNT, username: "Quant-", apiUrl: "https://api.alpha.candle.tv" } },
    activeProfile: "production",
  })
  const deps = createTestDeps({
    fetch,
    store: createFakeStore(overrides.store ?? { "profile:production:device_token": "cndl_dvc_x" }),
    stdout,
    stderr,
    env: overrides.env ?? {},
    readConfig: configStore.readConfig,
    writeConfig: configStore.writeConfig,
    clearConfig: configStore.clearConfig,
    updateProfile: configStore.updateProfile,
    isTTY:
      overrides.tty === false
        ? { stdin: false, stdout: false, stderr: false }
        : { stdin: true, stdout: true, stderr: true },
    promptLine: async () => {
      const next = answers.shift()
      if (next === undefined) throw new Error("promptLine asked for more answers than the test scripted")
      return next
    },
    promptSecret: async () => {
      throw new Error("the vault must never be opened by tee rebind (L7)")
    },
  })
  return { deps, stdout, stderr }
}

describe("L1: parsing", () => {
  test("no selector and no --label-prefix, or no --to-key, is a usage error, exit 2, before any request", async () => {
    for (const argv of [
      ["tee", "rebind", "--to-key", TO],
      ["tee", "rebind", "tr-01"],
      ["tee", "rebind", "tr-01", "--to-key", TO, "--bogus"],
    ]) {
      const { fetch, calls } = createRoutedFetch({})
      const { deps, stderr } = depsFor(fetch)
      expect(await run(argv, deps)).toBe(2)
      expect(calls).toHaveLength(0)
      expect(stderr.text.length).toBeGreaterThan(0)
    }
    const { fetch, calls } = createRoutedFetch({})
    const { deps, stdout } = depsFor(fetch)
    expect(await run(["tee", "rebind", "--to-key", TO, "--json"], deps)).toBe(2)
    expect(calls).toHaveLength(0)
    expect(JSON.parse(stdout.text)).toMatchObject({ ok: false, code: "USAGE" })
  })

  test("a profile with only an API key is DEVICE_TOKEN_REQUIRED, with the login suggestion", async () => {
    const { fetch, calls } = createRoutedFetch({})
    // `--no-verify-account`: with a stored API key the account guard would make its own read first,
    // and this test is about the command's refusal, which must come before any rebind request.
    const { deps, stdout } = depsFor(fetch, { store: { "profile:production:api_key": "cndl_live_x" } })
    expect(await run(["tee", "rebind", "tr-01", "--to-key", TO, "--json", "--no-verify-account"], deps)).toBe(1)
    expect(calls).toHaveLength(0)
    expect(JSON.parse(stdout.text)).toEqual({
      ok: false,
      code: "DEVICE_TOKEN_REQUIRED",
      message: "Moving a TEE wallet needs the device token, the owner's credential; an API key cannot do it.",
      suggestion: "Run: candle auth login",
    })
  })
})

describe("L2: --to-key by label", () => {
  const keys = (rows: Array<Record<string, unknown>>) => () => jsonResponse(200, { success: true, keys: rows })

  test("a unique, non-revoked label resolves to its prefix; the server receives only the prefix", async () => {
    const api = rebindApi()
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys": keys([
        {
          keyPrefix: "Rev0ked1",
          label: "tr-01",
          scopes: ["swap:write"],
          environment: "production",
          createdAt: 1,
          revokedAt: 5,
        },
        { keyPrefix: TO, label: "tr-01", scopes: ["swap:write"], environment: "production", createdAt: 1 },
        { keyPrefix: "Other001", label: "cn-1", scopes: ["swap:write"], environment: "production", createdAt: 1 },
      ]),
      "/api/v1/agent/tee-wallets/rebind": api.handlers,
    })
    const { deps } = depsFor(fetch)
    expect(await run(["tee", "rebind", "tr-01", "--to-key", "tr-01"], deps)).toBe(0)
    expect(api.bodies[0]).toMatchObject({ dryRun: true, toKeyPrefix: TO, wallets: ["tr-01"] })
  })

  test("an ambiguous label is refused with the prefixes listed; no match lists the labelled keys; zero rebind requests", async () => {
    const dup = keys([
      { keyPrefix: "Ab3dEf9h", label: "dup", scopes: [], environment: "production", createdAt: 1 },
      { keyPrefix: "Cd4eFg0i", label: "dup", scopes: [], environment: "production", createdAt: 1 },
    ])
    let routed = createRoutedFetch({ "/api/v1/agent/keys": dup })
    let d = depsFor(routed.fetch)
    expect(await run(["tee", "rebind", "tr-01", "--to-key", "dup", "--json"], d.deps)).toBe(1)
    let parsed = JSON.parse(d.stdout.text)
    expect(parsed.code).toBe("REBIND_KEY_AMBIGUOUS")
    expect(parsed.suggestion).toContain("Ab3dEf9h")
    expect(parsed.suggestion).toContain("Cd4eFg0i")
    expect(routed.calls.filter((c) => c.url.includes("tee-wallets"))).toHaveLength(0)

    routed = createRoutedFetch({ "/api/v1/agent/keys": dup })
    d = depsFor(routed.fetch)
    expect(await run(["tee", "rebind", "tr-01", "--to-key", "nope", "--json"], d.deps)).toBe(1)
    parsed = JSON.parse(d.stdout.text)
    expect(parsed.code).toBe("REBIND_KEY_NOT_FOUND")
    expect(parsed.suggestion).toContain("dup")
    expect(routed.calls.filter((c) => c.url.includes("tee-wallets"))).toHaveLength(0)
  })
})

describe("L3, L4, L5: the screen, the acknowledgement, the commit", () => {
  test("no TTY: refused before the preview", async () => {
    const api = rebindApi()
    const { fetch, calls } = createRoutedFetch({ "/api/v1/agent/tee-wallets/rebind": api.handlers })
    const { deps, stdout } = depsFor(fetch, { tty: false })
    expect(await run(["tee", "rebind", "tr-01", "--to-key", TO, "--json"], deps)).toBe(1)
    expect(JSON.parse(stdout.text).code).toBe("REBIND_REQUIRES_TTY")
    expect(calls).toHaveLength(0)
  })

  test("anything but confirm is refused with zero commits; confirm, Confirm and ' CONFIRM ' proceed", async () => {
    for (const typed of ["yes", "", "confirm please"]) {
      const api = rebindApi()
      const { fetch } = createRoutedFetch({ "/api/v1/agent/tee-wallets/rebind": api.handlers })
      const { deps, stdout } = depsFor(fetch, { answers: [typed] })
      expect(await run(["tee", "rebind", "tr-01", "tr-02", "--to-key", TO, "--json"], deps)).toBe(1)
      expect(JSON.parse(stdout.text).code).toBe("REBIND_NOT_ACKNOWLEDGED")
      expect(api.bodies).toHaveLength(1)
      expect(api.bodies[0]?.dryRun).toBe(true)
    }
    for (const typed of ["confirm", "Confirm", " CONFIRM "]) {
      const api = rebindApi()
      const { fetch } = createRoutedFetch({ "/api/v1/agent/tee-wallets/rebind": api.handlers })
      const { deps } = depsFor(fetch, { answers: [typed] })
      expect(await run(["tee", "rebind", "tr-01", "tr-02", "--to-key", TO], deps)).toBe(0)
      expect(api.bodies).toHaveLength(2)
    }
  })

  test("L4: the commit body is exactly the preview's walletIds and expect, with no selectors", async () => {
    const api = rebindApi()
    const { fetch } = createRoutedFetch({ "/api/v1/agent/tee-wallets/rebind": api.handlers })
    const { deps, stdout } = depsFor(fetch)
    expect(await run(["tee", "rebind", "tr-01", ADDR_2, "--to-key", TO, "--label-prefix", "cn-"], deps)).toBe(0)
    expect(api.bodies[0]).toEqual({ dryRun: true, toKeyPrefix: TO, wallets: ["tr-01", ADDR_2], labelPrefix: "cn-" })
    expect(api.bodies[1]).toEqual({ toKeyPrefix: TO, walletIds: ["k57", "k58"], expect: { k57: FROM, k58: FROM } })
    expect(stdout.text).toContain(`Moved 2 wallets to ${TO}. Audit ids: aud1, aud2`)
  })

  test("L5: the mixed-cap screen, on stderr, and --json stdout parses as one document", async () => {
    const api = rebindApi()
    const { fetch } = createRoutedFetch({ "/api/v1/agent/tee-wallets/rebind": api.handlers })
    const { deps, stdout, stderr } = depsFor(fetch)
    expect(await run(["tee", "rebind", "tr-01", "tr-02", "--to-key", TO, "--json"], deps)).toBe(0)
    const screen = stderr.text
    // The table: line, label, address, from, allowLaunch.
    expect(screen).toContain("allowLaunch")
    expect(screen).toMatch(/1\s+tr-01\s+7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU\s+B6P-TSRs\s+no/)
    expect(screen).toMatch(/2\s+tr-02\s+\S+\s+B6P-TSRs\s+yes/)
    expect(screen).toContain("1 already bound to this key: tr-03")
    // The block: key with label and the paused marker, account, API with the environment.
    expect(screen).toContain("These 2 wallets will move to:")
    expect(screen).toContain(`API key         ${TO}  tr-01  (paused)`)
    expect(screen).toContain("Candle account  Quant-  (FfU8M5…8pPD)")
    expect(screen).toContain("API             https://api.alpha.candle.tv  (production)")
    // The warnings: USDC only (SOL is ready and is not called blocked), and the launch line.
    expect(screen).toContain(
      `Warning: key ${TO} can trade SOL-quoted swaps; it cannot trade USDC-quoted swaps until a USDC cap is set.`,
    )
    expect(screen).not.toContain("cannot trade SOL-quoted swaps")
    expect(screen).toContain(`Warning: key ${TO} lacks launch:write; tr-02 has allowLaunch but cannot launch under it.`)
    expect(screen).toContain("The relay signer does not move: trade these wallets from the machine that promoted them.")
    // stdout: exactly one document, the server response plus the command.
    const parsed = JSON.parse(stdout.text)
    expect(parsed.command).toBe("tee rebind")
    expect(parsed.rebound.map((r: { auditId: string }) => r.auditId)).toEqual(["aud1", "aud2"])
  })

  test("L5: no txLimit prints the txLimit warning and does not say SOL trades are ready", async () => {
    const noLimit: ToKey = {
      ...readyKey,
      tradeReady: { sol: false, usdc: false },
      missingCaps: ["txLimit", "spendLimits.sol", "spendLimits.usdc"],
    }
    const api = rebindApi({ preview: previewBody(noLimit) })
    const { fetch } = createRoutedFetch({ "/api/v1/agent/tee-wallets/rebind": api.handlers })
    const { deps, stderr } = depsFor(fetch)
    expect(await run(["tee", "rebind", "tr-01", "--to-key", TO], deps)).toBe(0)
    expect(stderr.text).toContain(
      `Warning: key ${TO} has no txLimit; it cannot trade SOL-quoted or USDC-quoted swaps until one is set.`,
    )
    expect(stderr.text).not.toContain("can trade SOL-quoted swaps")
  })

  test("both assets ready prints no cap warning; a key with launch:write prints no launch warning", async () => {
    const ready: ToKey = { ...readyKey, tradeReady: { sol: true, usdc: true }, missingCaps: [], launchScope: true }
    const api = rebindApi({ preview: previewBody(ready) })
    const { fetch } = createRoutedFetch({ "/api/v1/agent/tee-wallets/rebind": api.handlers })
    const { deps, stderr } = depsFor(fetch)
    expect(await run(["tee", "rebind", "tr-01", "--to-key", TO], deps)).toBe(0)
    expect(stderr.text).not.toContain("Warning:")
  })

  test("every wallet already on the target: nothing to move, no prompt, exit 0", async () => {
    const api = rebindApi({ preview: previewBody(readyKey, { rebound: [] }) })
    const { fetch } = createRoutedFetch({ "/api/v1/agent/tee-wallets/rebind": api.handlers })
    const { deps, stdout } = depsFor(fetch, { answers: [] })
    expect(await run(["tee", "rebind", "tr-03", "--to-key", TO], deps)).toBe(0)
    expect(stdout.text).toContain("Nothing to move")
    expect(api.bodies).toHaveLength(1)
  })
})

describe("L6: refusals", () => {
  const refusal = (status: number, code: string, extra: Record<string, unknown> = {}) =>
    jsonResponse(status, {
      success: false,
      error: { code, message: `server says ${code}`, retryable: false, ...extra },
    })

  test("a 404 from a server without the route is REBIND_UNSUPPORTED, exit 1", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/tee-wallets/rebind": () => jsonResponse(404, { error: "Not Found" }),
    })
    const { deps, stdout } = depsFor(fetch)
    expect(await run(["tee", "rebind", "tr-01", "--to-key", TO, "--json"], deps)).toBe(1)
    const parsed = JSON.parse(stdout.text)
    expect(parsed.code).toBe("REBIND_UNSUPPORTED")
    expect(parsed.message).toBe("This Candle API does not support rebinding yet; nothing changed.")
  })

  test("REBIND_BUILD_OPEN prints the stop suggestion with the old key and a local time", async () => {
    const retryAfter = Date.UTC(2026, 8, 23, 12, 30)
    const api = rebindApi({ commit: null })
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/tee-wallets/rebind": [
        api.handlers[0] as RouteHandler,
        () => refusal(409, "REBIND_BUILD_OPEN", { walletIds: ["k57"], retryAfter }),
      ],
    })
    const { deps, stderr } = depsFor(fetch)
    expect(await run(["tee", "rebind", "tr-01", "--to-key", TO], deps)).toBe(1)
    expect(stderr.text).toContain(`Stop the agent on key ${FROM} (candle keys stop ${FROM}), then run this again after`)
    expect(stderr.text).toContain(new Date(retryAfter).toLocaleString())
  })

  test("REBIND_FORWARD_OPEN prints the in-flight line and never a 30-minute wait", async () => {
    const api = rebindApi()
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/tee-wallets/rebind": [
        api.handlers[0] as RouteHandler,
        () => refusal(409, "REBIND_FORWARD_OPEN", { walletIds: ["k57"] }),
      ],
    })
    const { deps, stderr, stdout } = depsFor(fetch)
    expect(await run(["tee", "rebind", "tr-01", "--to-key", TO], deps)).toBe(1)
    expect(stderr.text).toContain("A sign for these wallets is still in flight or not yet expired; nothing changed.")
    expect(`${stderr.text}${stdout.text}`).not.toMatch(/30.minute/)
  })

  test("REBIND_RECONCILE_INCOMPLETE says to run the same command again", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/tee-wallets/rebind": () => refusal(503, "REBIND_RECONCILE_INCOMPLETE", { retryable: true }),
    })
    const { deps, stdout } = depsFor(fetch)
    expect(await run(["tee", "rebind", "tr-01", "--to-key", TO, "--json"], deps)).toBe(1)
    const parsed = JSON.parse(stdout.text)
    expect(parsed.code).toBe("REBIND_RECONCILE_INCOMPLETE")
    expect(parsed.suggestion).toContain("Run the same command again")
  })
})

describe("L7: the vault is never opened", () => {
  test("a full rebind, human mode, makes no vault or secret prompt and reads no keystore", async () => {
    const api = rebindApi()
    const { fetch, calls } = createRoutedFetch({ "/api/v1/agent/tee-wallets/rebind": api.handlers })
    const { deps } = depsFor(fetch)
    // The deps' promptSecret throws, readFile throws, and CANDLE_CONFIG_DIR points nowhere.
    expect(await run(["tee", "rebind", "tr-01", "--to-key", TO], deps)).toBe(0)
    // Key signers: a binding-only rebind also READS each source key's signer, to say which
    // machine keeps trading the wallets. Reads only; nothing else is called.
    expect(
      calls.every((c) => c.url.includes("/api/v1/agent/tee-wallets/rebind") || /\/keys\/[^/]+\/signer$/.test(c.url)),
    ).toBe(true)
  })
})

describe("L9: tee rebinds", () => {
  const history = () =>
    jsonResponse(200, {
      success: true,
      rebinds: [
        {
          id: "aud1",
          at: 1_758_600_000_000,
          linkedWalletId: "k57",
          address: ADDR_1,
          fromKeyPrefix: FROM,
          toKeyPrefix: TO,
          actor: "device",
          actorDevicePrefix: "dvc12345",
          batchId: "b1",
        },
        {
          id: "aud0",
          at: 1_758_500_000_000,
          linkedWalletId: "k58",
          address: ADDR_2,
          fromKeyPrefix: FROM,
          toKeyPrefix: TO,
          actor: "session",
          batchId: "b0",
        },
      ],
    })

  test("prints the device prefix and the portal line; no TTY is needed; the vault is not opened", async () => {
    const { fetch, calls } = createRoutedFetch({ "/api/v1/agent/tee-wallets/rebinds": history })
    const { deps, stdout } = depsFor(fetch, { tty: false, answers: [] })
    expect(await run(["tee", "rebinds"], deps)).toBe(0)
    expect(stdout.text).toContain("dvc12345")
    expect(stdout.text).toContain(FROM)
    expect(stdout.text).toContain(TO)
    expect(stdout.text).toContain("revoke a device you do not recognise from the portal")
    expect(calls).toHaveLength(1)
    expect(JSON.stringify(calls[0]?.init.headers)).toContain("Bearer cndl_dvc_x")
  })

  test("a wallet argument filters, and --json stdout is one document with the command", async () => {
    const { fetch, calls } = createRoutedFetch({ "/api/v1/agent/tee-wallets/rebinds": history })
    const { deps, stdout, stderr } = depsFor(fetch, { tty: false, answers: [] })
    expect(await run(["tee", "rebinds", "k57", "--json"], deps)).toBe(0)
    expect(calls[0]?.url).toContain("walletId=k57")
    expect(stderr.text).toBe("")
    const parsed = JSON.parse(stdout.text)
    expect(parsed.command).toBe("tee rebinds")
    expect(parsed.rebinds).toHaveLength(2)
  })

  test("without a device token it is DEVICE_TOKEN_REQUIRED, with no request", async () => {
    const { fetch, calls } = createRoutedFetch({})
    const { deps, stdout } = depsFor(fetch, { store: {}, answers: [] })
    expect(await run(["tee", "rebinds", "--json"], deps)).toBe(1)
    expect(JSON.parse(stdout.text).code).toBe("DEVICE_TOKEN_REQUIRED")
    expect(calls).toHaveLength(0)
  })
})
