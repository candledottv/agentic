/**
 * `candle keys access` (BE-361, spec docs/superpowers/specs/2026-09-24-change-key-access-design.md,
 * section 9, tests T-B1 to T-B11), driven through `run()` against a routed fake API. T-B12 lives in
 * transfer.test.ts and auth.test.ts; T-B13 in help.drift.test.ts and scripts/cli-docs.test.ts.
 */
import { describe, expect, test } from "bun:test"
import { scopesForPreset } from "../agent-key-access"
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
import { ACCESS_LEVELS } from "./keys"
import { linkedTransferLine } from "./keys-access"

const PREFIX = "Ab3dEf9h"
const OTHER = "Zz9yXw8v"
const ACCOUNT = "FfU8M5xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx8pPD"
const RW = scopesForPreset("readwrite")
const RWT = scopesForPreset("readwritetransfer")
const ACCESS_PATH = `/api/v1/agent/keys/${PREFIX}/access`
const SELF_PATH = "/api/v1/agent/keys/self/access"
const KEYS_PATH = "/api/v1/agent/keys"
const HISTORY_PATH = `/api/v1/agent/keys/${PREFIX}/access-changes`

type Direction = "widen" | "narrow" | "unchanged"

function accessBody(direction: Direction, opts: { dryRun?: boolean; keyPrefix?: string; extra?: object } = {}) {
  const [from, to, fromAccess, toAccess] =
    direction === "widen"
      ? [RW, RWT, "readwrite", "readwritetransfer"]
      : direction === "narrow"
        ? [RWT, RW, "readwritetransfer", "readwrite"]
        : [RW, RW, "readwrite", "readwrite"]
  const added = to.filter((s) => !from.includes(s))
  const removed = from.filter((s) => !to.includes(s))
  return {
    success: true,
    dryRun: opts.dryRun ?? true,
    keyPrefix: opts.keyPrefix ?? PREFIX,
    label: "cndl",
    direction,
    from: { access: fromAccess, scopes: from },
    to: { access: toAccess, scopes: to },
    added,
    removed,
    effects:
      direction === "widen"
        ? {
            boundTeeWallets: {
              count: 3,
              sample: [
                { id: "k1", label: "tr-01", address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" },
                { id: "k2", label: "tr-02", address: "8xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" },
                { id: "k3", label: "tr-03", address: "9xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" },
              ],
            },
            walletScope: "all",
            linkedTransferReady: { txLimit: true, assets: { sol: true, usdc: false, cndl: false } },
          }
        : {},
    warnings:
      direction === "widen"
        ? [
            { code: "MOVES_FUNDS", message: "This key will be able to move funds." },
            {
              code: "VAULT_TRANSFER_READY",
              message: "It can move the funds of 3 wallets to their vaults as soon as this commits.",
            },
          ]
        : direction === "narrow"
          ? [{ code: "OPEN_SIGNS_REFUSED", message: "2 prepared transactions will be refused at signing." }]
          : [],
    ...(opts.dryRun === false ? { changeId: "j97abc", at: 1790000000000 } : {}),
    ...(opts.extra ?? {}),
  }
}

const parse = (req: CapturedRequest) => JSON.parse(String(req.init.body ?? "{}")) as Record<string, unknown>

/** An access route that answers the preview then the commit, recording both bodies. */
function accessApi(direction: Direction, opts: { commit?: RouteHandler; keyPrefix?: string } = {}) {
  const bodies: Record<string, unknown>[] = []
  const handlers: RouteHandler[] = [
    (req) => {
      bodies.push(parse(req))
      return jsonResponse(200, accessBody(direction, { keyPrefix: opts.keyPrefix }))
    },
    opts.commit ??
      ((req) => {
        bodies.push(parse(req))
        return jsonResponse(200, accessBody(direction, { dryRun: false, keyPrefix: opts.keyPrefix }))
      }),
  ]
  return { handlers, bodies }
}

function keysList(keys: Array<{ keyPrefix: string; label?: string; revokedAt?: number }>): RouteHandler {
  return () =>
    jsonResponse(200, {
      keys: keys.map((k) => ({ scopes: RW, environment: "live", createdAt: 1, ...k })),
    })
}

function depsFor(
  fetch: typeof globalThis.fetch,
  overrides: {
    answers?: string[]
    tty?: boolean
    store?: Record<string, string>
    profileKeyPrefix?: string
    profileScopes?: string[]
  } = {},
) {
  const stdout = createCapture()
  const stderr = createCapture()
  const answers = [...(overrides.answers ?? [])]
  const prompts: string[] = []
  const configStore = createFakeConfigStore({
    profiles: {
      production: {
        account: ACCOUNT,
        username: "Quant-",
        apiUrl: "https://api.alpha.candle.tv",
        keyPrefix: overrides.profileKeyPrefix ?? PREFIX,
        scopes: overrides.profileScopes ?? RW,
      },
    },
    activeProfile: "production",
  })
  const deps = createTestDeps({
    fetch,
    store: createFakeStore(
      overrides.store ?? {
        "profile:production:device_token": "cndl_dvc_x",
        "profile:production:api_key": "ck_live_whatever",
      },
    ),
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
    promptLine: async (text: string) => {
      prompts.push(text)
      const next = answers.shift()
      if (next === undefined) throw new Error("promptLine asked for more answers than the test scripted")
      return next
    },
  })
  return { deps, stdout, stderr, prompts, readConfig: configStore.readConfig }
}

const puts = (calls: CapturedRequest[]) => calls.filter((c) => c.init.method === "PUT")

/** The requests this command made: the account guard's own read (guard.ts) runs before every
 * routed command and is not this command's business. */
const keyCalls = (calls: CapturedRequest[]) => calls.filter((c) => new URL(c.url).pathname.startsWith(KEYS_PATH))

/** The command's own output: `printIdentity` writes the profile line first. */
const lastLine = (text: string) => text.trimEnd().split("\n").at(-1) ?? ""

describe("T-B1: flags", () => {
  test("--access values are exactly the ACCESS_LEVELS map keys, sent as the preset ids", async () => {
    for (const [spelling, preset] of Object.entries(ACCESS_LEVELS)) {
      const { handlers, bodies } = accessApi("unchanged")
      const { fetch } = createRoutedFetch({ [ACCESS_PATH]: handlers })
      const { deps } = depsFor(fetch)
      expect(await run(["keys", "access", PREFIX, "--access", spelling], deps)).toBe(0)
      expect(bodies[0]).toEqual({ access: preset, dryRun: true })
    }
  })

  test("--access and --history together, neither, an unknown level, or no key is exit 2 with no request", async () => {
    for (const argv of [
      ["keys", "access", PREFIX, "--access", "read", "--history"],
      ["keys", "access", PREFIX],
      ["keys", "access", PREFIX, "--access", "full"],
      ["keys", "access", "--access", "read"],
      ["keys", "access", PREFIX, OTHER, "--access", "read"],
      ["keys", "access", "self", "--history"],
      ["keys", "access", PREFIX, "--history", "--yes"],
    ]) {
      const { fetch, calls } = createRoutedFetch({})
      const { deps, stderr } = depsFor(fetch)
      expect([argv.join(" "), await run(argv, deps)]).toEqual([argv.join(" "), 2])
      expect(keyCalls(calls)).toHaveLength(0)
      expect(stderr.text.length).toBeGreaterThan(0)
    }
  })

  test("no device token for a prefix is NO_DEVICE_TOKEN, exit 1, with no request", async () => {
    const { fetch, calls } = createRoutedFetch({})
    const { deps, stdout } = depsFor(fetch, { store: {} })
    expect(await run(["keys", "access", PREFIX, "--access", "read", "--json"], deps)).toBe(1)
    expect(JSON.parse(stdout.text).code).toBe("NO_DEVICE_TOKEN")
    expect(keyCalls(calls)).toHaveLength(0)
  })
})

describe("T-B2: which key", () => {
  test("an exact label resolves to its prefix through GET /keys; revoked keys are skipped", async () => {
    const { handlers } = accessApi("unchanged")
    const { fetch } = createRoutedFetch({
      [KEYS_PATH]: keysList([
        { keyPrefix: OTHER, label: "cndl", revokedAt: 5 },
        { keyPrefix: PREFIX, label: "cndl" },
      ]),
      [ACCESS_PATH]: handlers,
    })
    const { deps, stdout } = depsFor(fetch)
    expect(await run(["keys", "access", "cndl", "--access", "read-write"], deps)).toBe(0)
    expect(stdout.text).toContain(`${PREFIX} (cndl) is already Read:Write. Nothing changed.`)
  })

  test("no match lists the labelled keys; an ambiguous label lists the prefixes; nothing is changed", async () => {
    {
      const { fetch, calls } = createRoutedFetch({ [KEYS_PATH]: keysList([{ keyPrefix: OTHER, label: "scalper" }]) })
      const { deps, stdout } = depsFor(fetch)
      expect(await run(["keys", "access", "cndl", "--access", "read", "--json"], deps)).toBe(1)
      const failure = JSON.parse(stdout.text)
      expect(failure.code).toBe("KEY_ACCESS_KEY_NOT_FOUND")
      expect(failure.suggestion).toContain(`${OTHER} scalper`)
      expect(puts(calls)).toHaveLength(0)
    }
    {
      const { fetch, calls } = createRoutedFetch({
        [KEYS_PATH]: keysList([
          { keyPrefix: OTHER, label: "cndl" },
          { keyPrefix: PREFIX, label: "cndl" },
        ]),
      })
      const { deps, stdout } = depsFor(fetch)
      expect(await run(["keys", "access", "cndl", "--access", "read", "--json"], deps)).toBe(1)
      const failure = JSON.parse(stdout.text)
      expect(failure.code).toBe("KEY_ACCESS_KEY_AMBIGUOUS")
      expect(failure.suggestion).toContain(`${OTHER}, ${PREFIX}`)
      expect(puts(calls)).toHaveLength(0)
    }
  })
})

describe("T-B3: widening needs a terminal, and --yes never widens", () => {
  test("widen without a TTY is KEY_ACCESS_REQUIRES_TTY, exit 1, and no commit is sent", async () => {
    const { handlers, bodies } = accessApi("widen")
    const { fetch } = createRoutedFetch({ [ACCESS_PATH]: handlers })
    const { deps, stdout } = depsFor(fetch, { tty: false })
    expect(await run(["keys", "access", PREFIX, "--access", "read-write-transfer", "--json"], deps)).toBe(1)
    const failure = JSON.parse(stdout.text)
    expect(failure.code).toBe("KEY_ACCESS_REQUIRES_TTY")
    expect(failure.suggestion).toContain("there is no flag and no environment variable to widen a key")
    // Only the dry run, which writes nothing, and which is how the CLI learns it is a widen.
    expect(bodies).toEqual([{ access: "readwritetransfer", dryRun: true }])
  })

  test("widen with --yes is a usage error, exit 2, and no commit is sent", async () => {
    const { handlers, bodies } = accessApi("widen")
    const { fetch } = createRoutedFetch({ [ACCESS_PATH]: handlers })
    const { deps, stderr, prompts } = depsFor(fetch)
    expect(await run(["keys", "access", PREFIX, "--access", "read-write-transfer", "--yes"], deps)).toBe(2)
    expect(stderr.text).toContain("--yes only skips the prompt when narrowing")
    expect(bodies).toHaveLength(1)
    expect(prompts).toHaveLength(0)
  })
})

describe("T-B4: the typed prefix", () => {
  test("a wrong prefix is KEY_ACCESS_NOT_ACKNOWLEDGED, exit 1, and no commit is sent", async () => {
    for (const typed of ["ab3def9h", "Ab3dEf9", "yes", ""]) {
      const { handlers, bodies } = accessApi("widen")
      const { fetch } = createRoutedFetch({ [ACCESS_PATH]: handlers })
      const { deps, stdout, prompts } = depsFor(fetch, { answers: [typed] })
      expect(await run(["keys", "access", PREFIX, "--access", "read-write-transfer", "--json"], deps)).toBe(1)
      expect(JSON.parse(stdout.text).code).toBe("KEY_ACCESS_NOT_ACKNOWLEDGED")
      expect(prompts).toEqual([`Type the key prefix ${PREFIX} to widen it: `])
      expect(bodies).toHaveLength(1)
    }
  })

  test("the right prefix (trimmed) commits with the preview's scopes as expectScopes", async () => {
    const { handlers, bodies } = accessApi("widen")
    const { fetch } = createRoutedFetch({ [ACCESS_PATH]: handlers })
    const { deps, stdout, stderr } = depsFor(fetch, { answers: [`  ${PREFIX} `] })
    expect(await run(["keys", "access", PREFIX, "--access", "read-write-transfer"], deps)).toBe(0)
    expect(bodies[1]).toEqual({ access: "readwritetransfer", expectScopes: RW })
    expect(lastLine(stdout.text)).toBe(`Changed ${PREFIX} (cndl) to Read:Write:Transfer. Change id j97abc`)
    // The screen: key, account, API, the change, the fund-moving label, the wallets and the caps.
    expect(stderr.text).toContain(`Key             ${PREFIX}  cndl`)
    expect(stderr.text).toContain("Candle account  Quant-")
    expect(stderr.text).toContain("API             https://api.alpha.candle.tv  (production)")
    expect(stderr.text).toContain("Access          Read:Write  ->  Read:Write:Transfer   (widen)")
    expect(stderr.text).toContain("Adds            transfer:bound (moves funds")
    expect(stderr.text).toContain("Removes         nothing")
    expect(stderr.text).toContain("TEE wallets on this key: 3  (tr-01, tr-02, tr-03)")
    expect(stderr.text).toContain("It can move these wallets' funds to their vaults as soon as you confirm.")
    expect(stderr.text).toContain("it also needs a USDC and a CNDL spend cap; SOL is ready.")
  })

  test("a stale commit is refused with the server's code and a rerun suggestion", async () => {
    const { handlers } = accessApi("widen", {
      commit: () =>
        jsonResponse(409, {
          success: false,
          error: { code: "KEY_ACCESS_STALE", message: "This key's scopes changed since the preview", scopes: RWT },
        }),
    })
    const { fetch } = createRoutedFetch({ [ACCESS_PATH]: handlers })
    const { deps, stderr } = depsFor(fetch, { answers: [PREFIX] })
    expect(await run(["keys", "access", PREFIX, "--access", "read-write-transfer"], deps)).toBe(1)
    expect(stderr.text).toContain("KEY_ACCESS_STALE: This key's scopes changed since the preview")
    expect(stderr.text).toContain("Run the command again")
  })
})

describe("T-B5: narrowing", () => {
  test("--yes commits without a prompt, and works without a terminal", async () => {
    const { handlers, bodies } = accessApi("narrow")
    const { fetch } = createRoutedFetch({ [ACCESS_PATH]: handlers })
    const { deps, stdout, stderr, prompts } = depsFor(fetch, { tty: false })
    expect(await run(["keys", "access", PREFIX, "--access", "read-write", "--yes"], deps)).toBe(0)
    expect(prompts).toHaveLength(0)
    expect(bodies[1]).toEqual({ access: "readwrite", expectScopes: RWT })
    expect(stdout.text).toContain(`Changed ${PREFIX} (cndl) to Read:Write.`)
    expect(stderr.text).toContain("Warning: 2 prepared transactions will be refused at signing.")
  })

  test("without --yes it asks y/N at a terminal; anything but y changes nothing", async () => {
    {
      const { handlers, bodies } = accessApi("narrow")
      const { fetch } = createRoutedFetch({ [ACCESS_PATH]: handlers })
      const { deps, prompts } = depsFor(fetch, { answers: ["y"] })
      expect(await run(["keys", "access", PREFIX, "--access", "read-write"], deps)).toBe(0)
      expect(prompts).toEqual([`Change ${PREFIX} (cndl) from Read:Write:Transfer to Read:Write? [y/N] `])
      expect(bodies).toHaveLength(2)
    }
    {
      const { handlers, bodies } = accessApi("narrow")
      const { fetch } = createRoutedFetch({ [ACCESS_PATH]: handlers })
      const { deps, stdout } = depsFor(fetch, { answers: [""] })
      expect(await run(["keys", "access", PREFIX, "--access", "read-write", "--json"], deps)).toBe(1)
      expect(JSON.parse(stdout.text).code).toBe("KEY_ACCESS_NOT_ACKNOWLEDGED")
      expect(bodies).toHaveLength(1)
    }
  })

  test("without a terminal and without --yes it is a usage error, exit 2, and no commit is sent", async () => {
    const { handlers, bodies } = accessApi("narrow")
    const { fetch } = createRoutedFetch({ [ACCESS_PATH]: handlers })
    const { deps, stderr } = depsFor(fetch, { tty: false })
    expect(await run(["keys", "access", PREFIX, "--access", "read-write"], deps)).toBe(2)
    expect(stderr.text).toContain("needs --yes")
    expect(bodies).toHaveLength(1)
  })
})

describe("T-B6: unchanged", () => {
  test("exit 0, no prompt, no commit, and the one line", async () => {
    const { handlers, bodies } = accessApi("unchanged")
    const { fetch } = createRoutedFetch({ [ACCESS_PATH]: handlers })
    const { deps, stdout, prompts } = depsFor(fetch)
    expect(await run(["keys", "access", PREFIX, "--access", "read-write"], deps)).toBe(0)
    expect(lastLine(stdout.text)).toBe(`${PREFIX} (cndl) is already Read:Write. Nothing changed.`)
    expect(prompts).toHaveLength(0)
    expect(bodies).toHaveLength(1)
  })
})

describe("T-B7: --json", () => {
  test("the screen goes to stderr and stdout is exactly one document tagged keys access", async () => {
    const { handlers } = accessApi("widen")
    const { fetch } = createRoutedFetch({ [ACCESS_PATH]: handlers })
    const { deps, stdout, stderr } = depsFor(fetch, { answers: [PREFIX] })
    expect(await run(["keys", "access", PREFIX, "--access", "read-write-transfer", "--json"], deps)).toBe(0)
    const lines = stdout.text.trim().split("\n")
    expect(lines).toHaveLength(1)
    const doc = JSON.parse(lines[0] as string)
    expect(doc).toMatchObject({ command: "keys access", direction: "widen", changeId: "j97abc", dryRun: false })
    expect(stderr.text).toContain("Access          Read:Write  ->  Read:Write:Transfer")
  })

  test("unchanged under --json is the preview document, tagged", async () => {
    const { handlers } = accessApi("unchanged")
    const { fetch } = createRoutedFetch({ [ACCESS_PATH]: handlers })
    const { deps, stdout } = depsFor(fetch)
    expect(await run(["keys", "access", PREFIX, "--access", "read-write", "--json"], deps)).toBe(0)
    expect(JSON.parse(stdout.text)).toMatchObject({ command: "keys access", direction: "unchanged" })
  })
})

describe("T-B8: the profile's recorded scopes", () => {
  test("changing the profile's own key records the new scopes", async () => {
    const { handlers } = accessApi("narrow")
    const { fetch } = createRoutedFetch({ [ACCESS_PATH]: handlers })
    const { deps, readConfig } = depsFor(fetch, { profileScopes: RWT })
    expect(await run(["keys", "access", PREFIX, "--access", "read-write", "--yes"], deps)).toBe(0)
    expect((await readConfig()).profiles?.production?.scopes).toEqual(RW)
  })

  test("changing another key leaves the profile's scopes alone", async () => {
    const { handlers } = accessApi("narrow")
    const { fetch } = createRoutedFetch({ [ACCESS_PATH]: handlers })
    const { deps, readConfig } = depsFor(fetch, { profileKeyPrefix: OTHER, profileScopes: RWT })
    expect(await run(["keys", "access", PREFIX, "--access", "read-write", "--yes"], deps)).toBe(0)
    expect((await readConfig()).profiles?.production?.scopes).toEqual(RWT)
  })
})

describe("T-B9: self", () => {
  test("self uses the profile's API key on the self route, and narrows", async () => {
    const { handlers, bodies } = accessApi("narrow")
    const { fetch, calls } = createRoutedFetch({ [SELF_PATH]: handlers })
    const { deps } = depsFor(fetch, { store: { "profile:production:api_key": "ck_live_whatever" } })
    expect(await run(["keys", "access", "self", "--access", "read-write", "--yes"], deps)).toBe(0)
    expect(bodies[1]).toEqual({ access: "readwrite", expectScopes: RWT })
    const headers = new Headers(keyCalls(calls)[0]?.init.headers as HeadersInit)
    expect(headers.get("x-api-key")).toBe("ck_live_whatever")
    expect(calls.some((c) => new URL(c.url).pathname === KEYS_PATH)).toBe(false)
  })

  test("a widen on self gets the server's LOOSEN_REQUIRES_SESSION and the owner suggestion", async () => {
    const { fetch } = createRoutedFetch({
      [SELF_PATH]: () =>
        jsonResponse(403, {
          success: false,
          error: {
            code: "LOOSEN_REQUIRES_SESSION",
            message:
              "Widening a key's access requires the account owner (a signed-in session or the CLI device token), not an agent key",
          },
        }),
    })
    const { deps, stderr } = depsFor(fetch)
    expect(await run(["keys", "access", "self", "--access", "read-write-transfer"], deps)).toBe(1)
    expect(stderr.text).toContain("LOOSEN_REQUIRES_SESSION")
    expect(stderr.text).toContain(
      "Widen it from a signed-in session or with the device token: candle keys access <prefix> --access read-write-transfer",
    )
  })

  test("self with no API key is API_KEY_REQUIRED, exit 1, with no request", async () => {
    const { fetch, calls } = createRoutedFetch({})
    const { deps, stdout } = depsFor(fetch, { store: { "profile:production:device_token": "cndl_dvc_x" } })
    expect(await run(["keys", "access", "self", "--access", "read", "--json"], deps)).toBe(1)
    expect(JSON.parse(stdout.text).code).toBe("API_KEY_REQUIRED")
    expect(keyCalls(calls)).toHaveLength(0)
  })
})

describe("T-B10: an API without the route", () => {
  test("a 404 with no error code is KEY_ACCESS_UNSUPPORTED", async () => {
    const { fetch } = createRoutedFetch({ [ACCESS_PATH]: () => new Response("404 Not Found", { status: 404 }) })
    const { deps, stdout } = depsFor(fetch)
    expect(await run(["keys", "access", PREFIX, "--access", "read", "--json"], deps)).toBe(1)
    const failure = JSON.parse(stdout.text)
    expect(failure.code).toBe("KEY_ACCESS_UNSUPPORTED")
    expect(failure.message).toBe("This Candle API cannot change a key's access yet; nothing changed.")
  })

  test("a 404 VALIDATION_FAILED Key not found stays the key refusal", async () => {
    const { fetch } = createRoutedFetch({
      [ACCESS_PATH]: () =>
        jsonResponse(404, { success: false, error: { code: "VALIDATION_FAILED", message: "Key not found" } }),
    })
    const { deps, stdout } = depsFor(fetch)
    expect(await run(["keys", "access", PREFIX, "--access", "read", "--json"], deps)).toBe(1)
    const failure = JSON.parse(stdout.text)
    expect(failure.code).toBe("VALIDATION_FAILED")
    expect(failure.message).toBe("Key not found")
  })
})

describe("T-B11: --history", () => {
  const rows = [
    {
      changeId: "c2",
      at: 1790000000000,
      keyPrefix: PREFIX,
      direction: "narrow",
      from: { access: "readwritetransfer", scopes: RWT },
      to: { access: "readwrite", scopes: RW },
      actor: "agent",
      actorKeyPrefix: PREFIX,
    },
    {
      changeId: "c1",
      at: 1789990000000,
      keyPrefix: PREFIX,
      direction: "widen",
      from: { access: null, scopes: ["swap:write", "lp:write"] },
      to: { access: "readwritetransfer", scopes: RWT },
      actor: "device",
      actorDevicePrefix: "dvc12345",
    },
  ]

  test("prints one row per change, and the portal line under a device actor", async () => {
    const { fetch, calls } = createRoutedFetch({
      [HISTORY_PATH]: () => jsonResponse(200, { success: true, changes: rows }),
    })
    const { deps, stdout } = depsFor(fetch)
    expect(await run(["keys", "access", PREFIX, "--history"], deps)).toBe(0)
    expect(stdout.text).toContain("Read:Write:Transfer")
    expect(stdout.text).toContain("custom (")
    expect(stdout.text).toContain("dvc12345")
    expect(stdout.text).toContain("agent")
    expect(stdout.text).toContain("A device token cannot revoke devices")
    expect(new Headers(keyCalls(calls)[0]?.init.headers as HeadersInit).get("authorization")).toBe("Bearer cndl_dvc_x")
  })

  test("no device actor, no portal line; none at all, one line; --json is the body tagged", async () => {
    {
      const { fetch } = createRoutedFetch({
        [HISTORY_PATH]: () => jsonResponse(200, { success: true, changes: [rows[0]] }),
      })
      const { deps, stdout } = depsFor(fetch)
      expect(await run(["keys", "access", PREFIX, "--history"], deps)).toBe(0)
      expect(stdout.text).not.toContain("A device token cannot revoke devices")
    }
    {
      const { fetch } = createRoutedFetch({ [HISTORY_PATH]: () => jsonResponse(200, { success: true, changes: [] }) })
      const { deps, stdout } = depsFor(fetch)
      expect(await run(["keys", "access", PREFIX, "--history"], deps)).toBe(0)
      expect(lastLine(stdout.text)).toBe(`No access changes on key ${PREFIX}.`)
    }
    {
      const { fetch } = createRoutedFetch({ [HISTORY_PATH]: () => jsonResponse(200, { success: true, changes: rows }) })
      const { deps, stdout } = depsFor(fetch)
      expect(await run(["keys", "access", PREFIX, "--history", "--json"], deps)).toBe(0)
      expect(JSON.parse(stdout.text)).toMatchObject({ command: "keys access", changes: rows })
    }
  })
})

describe("the linked-transfer line", () => {
  test("names what is missing and what is ready, and is absent when nothing is missing", () => {
    expect(linkedTransferLine({ txLimit: false, assets: { sol: true, usdc: true, cndl: true } })).toContain(
      "it also needs a USD transaction limit; SOL, USDC and CNDL are ready.",
    )
    expect(linkedTransferLine({ txLimit: true, assets: { sol: true, usdc: true, cndl: true } })).toBeNull()
  })
})
