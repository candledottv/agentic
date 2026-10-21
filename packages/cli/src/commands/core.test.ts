/**
 * BE-1665 (spec C-1 to C-4, T-14): `candle core serve`.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { openSync } from "node:fs"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireInstanceLock } from "../core/instance-lock"
import { readJournal } from "../core/journal"
import { corePaths, ensureCoreDir } from "../core/paths"
import { PROTOCOL_VERSION } from "../core/rpc"
import {
  connectTestClient,
  DEVICE_TOKEN,
  inspectableStore,
  profileConfig,
  READ_KEY,
  WRITE_KEY,
  WRITE_PREFIX,
} from "../core/test-fixtures"
import type { CommandContext, Deps } from "../deps"
import { profileSecretRef } from "../profiles"
import { createCapture, createFakeConfigStore, createTestDeps } from "../test-support"
import { closeVault } from "../vault/store"
import { makeVault, useCheapKdf } from "../vault/test-vault"
import { coreServe, keyLimitOf } from "./core"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function setup(opts: { apiUrl?: string; profile?: string | null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "candle-core-serve-"))
  dirs.push(dir)
  const env = { CANDLE_CONFIG_DIR: dir }
  const store = inspectableStore({ [profileSecretRef("staging", "apiKey")]: READ_KEY })
  let terminate: (() => void) | undefined
  const deps: Deps = createTestDeps({
    fetch: (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch,
    store,
    ...createFakeConfigStore(profileConfig("staging")),
    env,
    homedir: () => dir,
    stdout: createCapture(),
    stderr: createCapture(),
    now: () => Date.parse("2026-10-19T12:00:00Z"),
    onTerminate: (handler) => {
      terminate = handler
      return () => {
        terminate = undefined
      }
    },
  })
  const ctx: CommandContext = {
    deps,
    json: true,
    apiUrl: opts.apiUrl ?? "https://staging.api.candle.tv",
    profile: opts.profile === null ? undefined : (opts.profile ?? "staging"),
    verifyAccount: true,
  }
  // Stops the core once it is actually waiting: its terminate hook is registered only after start-up,
  // which a fixed sleep raced on a slow CI runner.
  const stop = async () => {
    for (let i = 0; i < 500 && terminate === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    terminate?.()
  }
  return { dir, env, deps, ctx, store, stop, paths: corePaths(env, dir, "staging") }
}

const stdoutOf = (deps: Deps) => (deps.stdout as unknown as { text: string }).text

describe("candle core serve", () => {
  test("starts, journals its start and stop, and keeps its state in a 0700 directory", async () => {
    const s = await setup()
    const running = coreServe([], s.ctx)
    await s.stop()
    expect(await running).toBe(0)
    const ready = JSON.parse(stdoutOf(s.deps).trim().split("\n")[0] ?? "{}")
    expect(ready).toMatchObject({ ok: true, profile: "staging", environment: "staging", socket: s.paths.socket })
    expect((await stat(s.paths.dir)).mode & 0o777).toBe(0o700)
    const journal = await readJournal(s.paths.journal)
    expect(journal.rows.map((row) => row.type)).toEqual(["core.started", "core.stopped"])
    expect(journal.rows[1]?.reason).toBe("terminated")
    expect(
      journal.rows.every((row) => row.environment === "staging" && row.profile === "staging" && row.mode === "live"),
    ).toBe(true)
    // The lock is released on the way out, so the next start succeeds.
    const again = coreServe([], s.ctx)
    await s.stop()
    expect(await again).toBe(0)
  })

  test("T-14: a second core for the same profile exits CORE_ALREADY_RUNNING with the socket path", async () => {
    const s = await setup()
    await ensureCoreDir(s.paths)
    const held = await acquireInstanceLock({ lockPath: s.paths.lock, socketPath: s.paths.socket })
    try {
      expect(await coreServe([], s.ctx)).toBe(1)
      const body = JSON.parse(stdoutOf(s.deps).trim())
      expect(body).toMatchObject({
        ok: false,
        code: "CORE_ALREADY_RUNNING",
        details: { socketPath: s.paths.socket, pid: process.pid },
      })
    } finally {
      await held.release()
    }
  })

  test("refuses with no profile in play, and against a host that is neither staging nor production", async () => {
    const none = await setup({ profile: null })
    expect(await coreServe([], none.ctx)).toBe(1)
    expect(JSON.parse(stdoutOf(none.deps).trim()).code).toBe("CORE_PROFILE_REQUIRED")

    const local = await setup({ apiUrl: "http://127.0.0.1:8787" })
    expect(await coreServe([], local.ctx)).toBe(1)
    expect(JSON.parse(stdoutOf(local.deps).trim()).code).toBe("CORE_ENVIRONMENT_UNKNOWN")
  })

  test("rejects arguments it does not take", async () => {
    const s = await setup()
    expect(await coreServe(["now"], s.ctx)).toBe(2)
    expect(await coreServe(["--bogus"], s.ctx)).toBe(2)
  })

  test("finishes a slot move a crash interrupted, and journals it", async () => {
    const s = await setup()
    await ensureCoreDir(s.paths)
    await writeFile(
      s.paths.slot,
      JSON.stringify({
        format: "candle-core-slot",
        version: 1,
        profile: "staging",
        environment: "staging",
        vaultId: "AAAAAAAAAAAAAAAAAAAAAA",
        writeKeyPrefix: WRITE_PREFIX,
        createdAt: "2026-10-19T00:00:00.000Z",
        blob: { iv: "AAAAAAAAAAAAAAAA", ciphertext: "AAAA" },
      }),
    )
    await s.store.set(profileSecretRef("staging", "deviceToken"), DEVICE_TOKEN)
    const running = coreServe([], s.ctx)
    await s.stop()
    expect(await running).toBe(0)
    expect(await s.store.get(profileSecretRef("staging", "deviceToken"))).toBeNull()
    expect(await s.store.get(profileSecretRef("staging", "apiKey"))).toBe(READ_KEY)
    const rows = (await readJournal(s.paths.journal)).rows
    expect(rows[0]).toMatchObject({ type: "slot.move_finished", refs: [profileSecretRef("staging", "deviceToken")] })
  })

  test("hands this start's view token to the launcher's descriptor, and exits when the last view detaches (C-3)", async () => {
    const s = await setup()
    const handoff = join(s.dir, "handoff")
    const fd = openSync(handoff, "w")
    const running = coreServe(["--view-token-fd", String(fd)], s.ctx)
    let token = ""
    for (let i = 0; i < 100 && token === ""; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      token = (await readFile(handoff, "utf8").catch(() => "")).trim()
    }
    expect(token).toMatch(/^chv_/)
    // The token is on the descriptor the launcher owns, and nowhere in the state directory.
    for (const name of ["journal.jsonl", "tokens.json", "core.lock"]) {
      expect(await readFile(join(s.paths.dir, name), "utf8").catch(() => "")).not.toContain(token)
    }
    const view = await connectTestClient(s.paths.socket)
    expect(
      (await view.request("core.hello", { protocol: PROTOCOL_VERSION, token, clientName: "tui" })).error,
    ).toBeUndefined()
    view.close()
    expect(await running).toBe(0)
    const rows = (await readJournal(s.paths.journal)).rows
    expect(rows.at(-1)).toMatchObject({ type: "core.stopped", reason: "last_view_detached" })
    expect(rows.find((row) => row.type === "core.started")?.viewTokenHandedOff).toBe(true)
  })

  test("refuses a descriptor below 3", async () => {
    const s = await setup()
    expect(await coreServe(["--view-token-fd", "1"], s.ctx)).toBe(2)
  })
})

describe("candle core serve, end to end with cards (spec K)", () => {
  beforeAll(() => useCheapKdf())

  test("trading on moves the credentials; a harness proposes, only the view approves, the Write key reaches only the API", async () => {
    const m = await makeVault()
    dirs.push(m.dir)
    closeVault(m.vault)
    const env = { CANDLE_CONFIG_DIR: m.dir }
    const store = inspectableStore({
      [profileSecretRef("staging", "apiKey")]: WRITE_KEY,
      [profileSecretRef("staging", "deviceToken")]: DEVICE_TOKEN,
    })
    const api: { url: string; key: string | null; device: string | null }[] = []
    let terminate: (() => void) | undefined
    const deps: Deps = createTestDeps({
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        const headers = new Headers(init?.headers)
        api.push({ url, key: headers.get("x-api-key"), device: headers.get("authorization") })
        if (url.endsWith("/api/v1/agent/keys"))
          return Response.json({ key: READ_KEY, keyPrefix: "rrrrrrrr", scopes: ["account:read"] })
        if (url.endsWith("/api/v1/agent/staking/rewards/rw_9/claim"))
          return Response.json({ success: true, signature: "sig9" })
        return new Response("{}", { status: 404 })
      }) as unknown as typeof fetch,
      store,
      ...createFakeConfigStore(profileConfig("staging")),
      env,
      homedir: () => m.dir,
      stdout: createCapture(),
      stderr: createCapture(),
      onTerminate: (handler) => {
        terminate = handler
        return () => {}
      },
    })
    const paths = corePaths(env, m.dir, "staging")
    const ctx: CommandContext = {
      deps,
      json: true,
      apiUrl: "https://staging.api.candle.tv",
      profile: "staging",
      verifyAccount: true,
    }
    const handoff = join(m.dir, "handoff")
    const running = coreServe(["--view-token-fd", String(openSync(handoff, "w"))], ctx)
    let token = ""
    for (let i = 0; i < 200 && token === ""; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      token = (await readFile(handoff, "utf8").catch(() => "")).trim()
    }
    const view = await connectTestClient(paths.socket)
    await view.request("core.hello", { protocol: PROTOCOL_VERSION, token, clientName: "tui" })

    // S-9: trading on, with the passphrase. The Read key is minted over the device token.
    const on = await view.request("settings.set", {
      path: "trading",
      value: true,
      factor: { type: "passphrase", value: m.passphrase },
    })
    expect(on.result).toMatchObject({ tradingOn: true, approvalPolicy: "ask" })
    expect(store.entries()).toEqual([[profileSecretRef("staging", "apiKey"), READ_KEY]])
    expect(await stat(paths.slot).then(() => true)).toBe(true)

    const minted = (await view.request("harness.register", { name: "Claude Code" })).result as { token: string }
    const harness = await connectTestClient(paths.socket)
    await harness.request("core.hello", { protocol: PROTOCOL_VERSION, token: minted.token, clientName: "claude" })
    await harness.request("subscribe", { topics: ["cards", "operations"] })

    const proposed = await harness.request("cards.propose", {
      tool: "candle_claim_staking_reward",
      params: { rewardId: "rw_9" },
    })
    const card = proposed.result as { cardId: string; cardHash: string; opId: string }
    expect(card.opId).toBe("rw_9")
    expect(
      (await harness.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash })).error?.data?.code,
    ).toBe("FORBIDDEN_FOR_ROLE")
    expect((await harness.request("cards.propose", { tool: "candle_transfer", params: {} })).error?.data?.code).toBe(
      "TRANSFER_USER_ONLY",
    )
    expect(api.filter((call) => call.url.includes("/staking/"))).toEqual([])

    const approved = await view.request("cards.approve", {
      cardId: card.cardId,
      cardHash: card.cardHash,
      factor: { type: "passphrase", value: m.passphrase },
    })
    expect(approved.result).toMatchObject({
      card: { state: "approved" },
      operation: { opId: "rw_9", state: "succeeded" },
    })
    const claim = api.find((call) => call.url.endsWith("/staking/rewards/rw_9/claim"))
    expect(claim?.key).toBe(WRITE_KEY)
    // The harness heard about its card and its operation, and never saw a secret.
    for (
      let i = 0;
      i < 100 &&
      !harness.events.some(
        (e) => e.topic === "operations" && !e.snapshot && JSON.stringify(e.data).includes("succeeded"),
      );
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(harness.events.some((e) => e.topic === "operations" && JSON.stringify(e.data).includes("succeeded"))).toBe(
      true,
    )
    const frames = [...view.frames, ...harness.frames].join("\n")
    for (const secret of [WRITE_KEY, DEVICE_TOKEN, READ_KEY, m.passphrase, token])
      expect(frames.includes(secret)).toBe(false)
    const journal = await readFile(paths.journal, "utf8")
    for (const secret of [WRITE_KEY, DEVICE_TOKEN, READ_KEY, m.passphrase, token])
      expect(journal.includes(secret)).toBe(false)

    harness.close()
    view.close()
    expect(await running).toBe(0)
    expect(terminate).toBeDefined()
  })
})

describe("keyLimitOf (K-5)", () => {
  test("reads the Write key's row, with the usage that matches its reset", () => {
    const keys = [
      { keyPrefix: "other000", txLimit: { usdMicros: 1, reset: "daily" } },
      {
        keyPrefix: "wwwwwwww",
        txLimit: { usdMicros: 50_000_000, reset: "weekly" },
        usage: { todayUsdMicros: 1, weekUsdMicros: 7_000_000 },
      },
    ]
    expect(keyLimitOf(keys, "wwwwwwww", 5)).toEqual({
      usdMicros: 50_000_000,
      reset: "weekly",
      usedUsdMicros: 7_000_000,
      readAt: 5,
    })
    expect(keyLimitOf([{ keyPrefix: "wwwwwwww", txLimit: null }], "wwwwwwww", 0)).toBeUndefined()
    expect(keyLimitOf("nope", "wwwwwwww", 0)).toBeUndefined()
  })

  test("an Ember window beats the usage rollups: it is the figure the cap checks admit against (BE-1749 item 5)", () => {
    // A perps order reserves the window at build and never writes an apiKeyUsage row, so
    // todayUsdMicros can read 0 while the window cap check reports most of the cap spent. The
    // row's emberWindow is the same remaining the gate judges, so it wins when present.
    const keys = [
      {
        keyPrefix: "wwwwwwww",
        txLimit: { usdMicros: 60_000_000, reset: "daily" },
        usage: { todayUsdMicros: 0 },
        emberWindow: {
          windowKey: "daily:1",
          capUsdMicros: 60_000_000,
          reservedUsdMicros: 33_070_000,
          remainingUsdMicros: 26_930_000,
          resetsAt: 2,
          nextWindowCapUsdMicros: 60_000_000,
        },
      },
    ]
    expect(keyLimitOf(keys, "wwwwwwww", 5)).toEqual({
      usdMicros: 60_000_000,
      reset: "daily",
      usedUsdMicros: 33_070_000,
      readAt: 5,
    })
  })
})
