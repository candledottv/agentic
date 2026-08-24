/**
 * Shared fakes for command tests: never touch the network, a real keychain, real timers, or the
 * filesystem outside a `CANDLE_CONFIG_DIR` temp dir. Not a `*.test.ts` file itself -- a plain
 * module imported by the test files under `src/` and `src/commands/`, matching the credential
 * store's own SecretStore interface and the config module's own read/write/clear contract so a
 * fake here behaves exactly like the real thing from a command's point of view.
 */

import type { CliConfig } from "./config"
import type { Deps } from "./deps"
import type { SecretStore } from "./secret-store"

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

export interface CapturedRequest {
  url: string
  init: RequestInit
}

/** A minimal in-memory `SecretStore`, matching the real interface, for command-level tests that
 * don't need real encryption or a real keychain -- those get their own dedicated coverage in
 * secret-store.test.ts and keychain.test.ts. */
export function createFakeStore(seed: Record<string, string> = {}): SecretStore {
  const data = new Map(Object.entries(seed))
  return {
    async get(ref: string) {
      return data.has(ref) ? (data.get(ref) as string) : null
    },
    async set(ref: string, value: string) {
      data.set(ref, value)
    },
    async delete(ref: string) {
      data.delete(ref)
    },
  }
}

/** A capturing writer: `.text` accumulates everything written to it, in order. */
export function createCapture(): Deps["stdout"] & { text: string } {
  return {
    text: "",
    write(chunk: string) {
      this.text += chunk
    },
  }
}

/** An in-memory config store matching `readConfig`/`writeConfig`/`clearConfig`'s real behavior:
 * `writeConfig` merges into the existing value, and a patch field explicitly set to `undefined`
 * clears it on read-back -- the real file-backed store gets this for free from
 * `JSON.stringify` dropping undefined-valued keys, so this fake reproduces it explicitly via the
 * same round trip rather than via `delete`, keeping the two implementations behaviorally
 * identical for exactly the case a command test would otherwise not be able to tell apart. */
export function createFakeConfigStore(initial: CliConfig = {}): {
  readConfig: () => Promise<CliConfig>
  writeConfig: (patch: Partial<CliConfig>) => Promise<void>
  clearConfig: () => Promise<void>
} {
  let current: CliConfig = { ...initial }
  return {
    async readConfig() {
      return { ...current }
    },
    async writeConfig(patch: Partial<CliConfig>) {
      const merged: CliConfig = { ...current, ...patch }
      current = JSON.parse(JSON.stringify(merged))
    },
    async clearConfig() {
      current = {}
    },
  }
}

/** A deterministic fake clock: `sleep(ms)` advances `now()` by exactly `ms` and resolves
 * immediately, so the device-flow poll loop's timing is exercised without a real wait. Every
 * sleep call is recorded, in order, in `calls`, for asserting exactly what the poll loop waited
 * on (e.g. the interval increase after `slow_down`). */
export function createFakeClock(startAt = 0): {
  now: () => number
  sleep: (ms: number) => Promise<void>
  calls: number[]
} {
  let value = startAt
  const calls: number[] = []
  return {
    now: () => value,
    sleep: async (ms: number) => {
      calls.push(ms)
      value += ms
    },
    calls,
  }
}

export type RouteHandler = (req: CapturedRequest) => Response | Promise<Response>

/**
 * Routes a fake `fetch` by URL PATH (ignoring host and query), for tests that hit multiple
 * endpoints. Each path maps to either one handler (every call to that path gets it) or an array
 * of handlers consumed in order, the last one repeating once exhausted -- covers both "doctor"
 * style multi-endpoint tests (one handler per path) and "auth login" style poll-sequence tests
 * (authorization_pending, then slow_down, then success, all against the SAME path).
 *
 * A request to a path with no registered handler still throws (so a test's script has to name
 * every call it expects), but `apiRequest` catches that throw and turns it into an ordinary
 * `status:0` result -- which could otherwise let a misrouted call quietly satisfy a loose test
 * assertion instead of failing loudly. `unmatched` records every such request directly, so a
 * test can assert `expect(unmatched).toHaveLength(0)` rather than relying on that side effect.
 */
export function createRoutedFetch(routes: Record<string, RouteHandler | RouteHandler[]>): {
  fetch: typeof fetch
  calls: CapturedRequest[]
  unmatched: CapturedRequest[]
} {
  const calls: CapturedRequest[] = []
  const unmatched: CapturedRequest[] = []
  const callIndex = new Map<string, number>()
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    const req: CapturedRequest = { url, init: init ?? {} }
    calls.push(req)
    const path = new URL(url).pathname
    const entry = routes[path]
    if (!entry) {
      unmatched.push(req)
      throw new Error(`No route registered for ${path}`)
    }
    if (Array.isArray(entry)) {
      const idx = callIndex.get(path) ?? 0
      callIndex.set(path, idx + 1)
      const handler = entry[Math.min(idx, entry.length - 1)]
      if (!handler) throw new Error(`No handler registered for ${path}`)
      return handler(req)
    }
    return entry(req)
  }) as typeof fetch
  return { fetch: fetchFn, calls, unmatched }
}

/** Builds a full `Deps` object with safe, inert defaults (empty store, empty config, capturing
 * writers, a fake clock starting at 0, a no-op openBrowser, empty env). Every field can be
 * overridden per test. `fetch` MUST be supplied by the caller -- there is no safe default that
 * would not silently hide a missing mock. */
export function createTestDeps(overrides: Partial<Deps> & { fetch: typeof fetch }): Deps {
  const configStore = createFakeConfigStore()
  const clock = createFakeClock()
  return {
    store: createFakeStore(),
    backend: "encrypted-file",
    readConfig: configStore.readConfig,
    writeConfig: configStore.writeConfig,
    clearConfig: configStore.clearConfig,
    stdout: createCapture(),
    // Inert by default: no test should launch a real child accidentally. mcp tests override
    // this with a capturing fake, the same posture as `fetch` (which has no default at all).
    runChild: async () => 0,
    stderr: createCapture(),
    now: clock.now,
    sleep: clock.sleep,
    openBrowser: () => {},
    env: {},
    nodeVersion: process.versions.node,
    hostname: "test-host",
    // Throwing defaults, like fetch's must-be-supplied rule but softer: only tests that
    // exercise wallets import's file/prompt paths need these, and a test that hits one
    // unexpectedly should fail loud, not silently read something.
    readFile: async (path: string) => {
      throw new Error(`no readFile fake configured (asked for ${path})`)
    },
    writeFile: async (path: string) => {
      throw new Error(`no writeFile fake configured (asked for ${path})`)
    },
    promptSecret: async () => {
      throw new Error("no promptSecret fake configured")
    },
    ...overrides,
  }
}
