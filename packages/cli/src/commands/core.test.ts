/**
 * BE-1665 (spec C-1 to C-4, T-14): `candle core serve`.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireInstanceLock } from "../core/instance-lock"
import { readJournal } from "../core/journal"
import { corePaths, ensureCoreDir } from "../core/paths"
import { DEVICE_TOKEN, inspectableStore, profileConfig, READ_KEY, WRITE_PREFIX } from "../core/test-fixtures"
import type { CommandContext, Deps } from "../deps"
import { profileSecretRef } from "../profiles"
import { createCapture, createFakeConfigStore, createTestDeps } from "../test-support"
import { coreServe } from "./core"

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
})
