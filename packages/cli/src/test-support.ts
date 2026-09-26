/**
 * Shared fakes for command tests: never touch the network, a real keychain, real timers, or the
 * filesystem outside a `CANDLE_CONFIG_DIR` temp dir. Not a `*.test.ts` file itself -- a plain
 * module imported by the test files under `src/` and `src/commands/`, matching the credential
 * store's own SecretStore interface and the config module's own read/write/clear contract so a
 * fake here behaves exactly like the real thing from a command's point of view.
 */

import { mkdtempSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CliConfig, ProfileConfig } from "./config"
import type { Deps } from "./deps"
import { realRunPlugin } from "./plugins"
import type { SecretStore } from "./secret-store"
import { RELEASE_POLICY } from "./vault/release-policy"

/**
 * The home every test resolves the default config directory from (BE-274, D1). Never the machine's
 * real one: the vault's default path is built from it, and a developer who has run `vault init`
 * would otherwise make the "no vault here" branch untestable locally -- green on CI, red at home,
 * which is the bug this seam exists for. A test that wants a home it can write to passes its own.
 */
export const TEST_HOME = "/nonexistent/candle-test-home"

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

/**
 * Key signers (K1's `GET /keys/:prefix/signer`): a key with no signer and no wallets, the answer
 * every key gives on a server where nobody has approved one. Fixtures that exercise a `--to-key`
 * target or a rebind's source register it, so the CLI's signer read sees today's state.
 */
export function signerView(keyPrefix: string, extra: Record<string, unknown> = {}): Response {
  return jsonResponse(200, {
    success: true,
    keyPrefix,
    keyLabel: null,
    state: "none",
    fingerprint: null,
    spkiSha256: null,
    publicKeyDer: null,
    requestedAt: null,
    pending: null,
    wallets: { onSigner: [], legacy: [], moving: [] },
    counts: { onSigner: 0, legacy: 0, moving: 0 },
    reconcile: { checked: 0, recorded: 0, mismatched: [], remaining: 0 },
    privyAppId: "app-test",
    ...extra,
  })
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
  updateProfile: (name: string, patch: Partial<ProfileConfig>) => Promise<void>
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
    async updateProfile(name: string, patch: Partial<ProfileConfig>) {
      const profiles = { ...(current.profiles ?? {}) }
      profiles[name] = { ...(profiles[name] ?? {}), ...patch }
      current = JSON.parse(JSON.stringify({ ...current, profiles }))
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
    // Its own fake, never the credential store's: the two namespaces are the point (R6).
    secretsStore: createFakeStore(),
    backend: "encrypted-file",
    readConfig: configStore.readConfig,
    writeConfig: configStore.writeConfig,
    clearConfig: configStore.clearConfig,
    updateProfile: configStore.updateProfile,
    stdout: createCapture(),
    // Inert by default: no test should start a real MCP server on this process's stdio by
    // accident. mcp tests override this with a capturing fake, the same posture as `fetch`
    // (which has no default at all).
    runMcpServer: async () => {},
    stderr: createCapture(),
    now: clock.now,
    sleep: clock.sleep,
    openBrowser: () => {},
    env: {},
    nodeVersion: process.versions.node,
    hostname: "test-host",
    homedir: () => TEST_HOME,
    // Throwing defaults, like fetch's must-be-supplied rule but softer: only tests that
    // exercise wallets import's file/prompt paths need these, and a test that hits one
    // unexpectedly should fail loud, not silently read something.
    readFile: async (path: string) => {
      throw new Error(`no readFile fake configured (asked for ${path})`)
    },
    readBytes: async (path: string) => {
      throw new Error(`no readBytes fake configured (asked for ${path})`)
    },
    readStdin: async () => {
      throw new Error("no readStdin fake configured")
    },
    // The REAL runner: a plug-in test spawns a real child so the environment it receives is the
    // environment a real plug-in receives, not a fake's account of it.
    runPlugin: realRunPlugin,
    writeFile: async (path: string) => {
      throw new Error(`no writeFile fake configured (asked for ${path})`)
    },
    promptSecret: async () => {
      throw new Error("no promptSecret fake configured")
    },
    promptLine: async () => {
      throw new Error("no promptLine fake configured")
    },
    // TTY by default: the vault commands refuse without one, and a test that means to exercise
    // that refusal says so explicitly rather than getting it by accident from an inert default.
    isTTY: { stdin: true, stdout: true, stderr: true },
    execPath: "/usr/local/bin/node",
    argv1: "/usr/local/lib/node_modules/@candledottv/cli/dist/index.js",
    platformKey: "linux-x64",
    platform: "linux",
    arch: "x64",
    realpath: async (path: string) => path,
    // Throwing by default, like the file fakes: a test that reaches the security key helper says
    // so by scripting it, and one that reaches it by accident fails loud.
    spawnHelper: async (path: string) => {
      throw new Error(`no spawnHelper fake configured (asked to run ${path})`)
    },
    // The checked-in policy, exactly as the real deps read it: `omit` until Apple approves. A
    // test of the signed path injects its own.
    releasePolicy: RELEASE_POLICY,
    writeBytes: async (path: string) => {
      throw new Error(`no writeBytes fake configured (asked for ${path})`)
    },
    rename: async (from: string) => {
      throw new Error(`no rename fake configured (asked for ${from})`)
    },
    unlink: async () => {},
    ...overrides,
  }
}

/**
 * A loopback wallets API with `rows` linked wallets, for the tests that run the BUILT CLI in a
 * child process (BE-299: `stdout-drain.compiled.test.ts` and `bin.test.ts`). Serves the two routes
 * `candle wallets` reads, with the real pagination contract (100 rows a page, `cursor` is the row
 * offset), and answers 401 to any key but `FAKE_WALLETS_API_KEY`. A row carries the fields a real
 * one does so the document is the size a real account's would be; every 50th row is revoked.
 *
 * The server lives in the test process, so the CLI must be spawned asynchronously (`Bun.spawn`):
 * a `spawnSync` blocks the thread this server answers on and the CLI hangs on its first request.
 */
export const FAKE_WALLETS_API_KEY = "cndl_test_key"

export function fakeWalletsAddress(index: number): string {
  return `FakeWa11et${String(index).padStart(6, "0")}${"x".repeat(28)}`
}

export function fakeWalletsApi(rows: number): { url: string; stop(): void } {
  const all = Array.from({ length: rows }, (_, index) => ({
    _id: `k17fake${String(index).padStart(6, "0")}wallet`,
    address: fakeWalletsAddress(index),
    chain: "solana",
    label: `fixture wallet ${index}`,
    userAddress: "FakeAccount1111111111111111111111111111111",
    privyWalletId: `privy-fake-${String(index).padStart(6, "0")}`,
    profile: index % 10 === 0 ? "ember-tee" : "import",
    createdAt: 1_758_000_000_000 + index,
    lastUsedAt: 1_758_600_000_000 + index,
    ...(index % 50 === 49 ? { revokedAt: 1_758_700_000_000 + index } : {}),
  }))
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (req.headers.get("x-api-key") !== FAKE_WALLETS_API_KEY) return jsonResponse(401, { error: "unauthorized" })
      const url = new URL(req.url)
      if (req.method === "GET" && url.pathname === "/api/v1/agent/wallets/embedded") {
        return jsonResponse(200, {
          wallets: {
            solana: { address: "FakeEmbeddedSo1ana11111111111111111111111111", delegated: true },
            evm: { address: "0x00000000000000000000000000000000000fa4e0", delegated: false },
          },
        })
      }
      if (req.method === "GET" && url.pathname === "/api/v1/agent/wallets") {
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 100)
        const offset = Number(url.searchParams.get("cursor") ?? 0)
        const page = all.slice(offset, offset + limit)
        const next = offset + page.length
        const isDone = next >= all.length
        return jsonResponse(200, { page, isDone, continueCursor: isDone ? null : String(next) })
      }
      return jsonResponse(404, { error: "not found" })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

/** One argument, quoted for a `bash -c` script. */
export function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`
}

/**
 * The environment a built CLI runs in for the pipe tests (BE-299 spec §4.4). A fresh config dir,
 * an API key from the env so nothing is stored, a keyring passphrase so the encrypted-file store
 * opens without a prompt, and a `PATH` holding only `bash`, `cat`, `sleep` and `head`: no
 * `security` or `secret-tool` on it, so the developer's keychain is never touched. `HOME` is the
 * same temp dir, so nothing can fall back to the real home either. Anything else the pipeline
 * runs (the node binary for the bundle) is resolved by the caller BEFORE this `PATH` applies and
 * invoked by its absolute path.
 */
export function pipeEnv(apiKey: string = FAKE_WALLETS_API_KEY): { env: Record<string, string>; bash: string } {
  const tools = mkdtempSync(join(tmpdir(), "candle-pipe-path-"))
  let bash = ""
  for (const tool of ["bash", "cat", "sleep", "head"]) {
    const found = Bun.which(tool)
    if (!found) throw new Error(`the pipe tests need ${tool} on PATH, and Bun.which could not find it`)
    symlinkSync(found, join(tools, tool))
    if (tool === "bash") bash = found
  }
  const configDir = mkdtempSync(join(tmpdir(), "candle-pipe-config-"))
  return {
    bash,
    env: {
      CANDLE_API_KEY: apiKey,
      CANDLE_CONFIG_DIR: configDir,
      CANDLE_KEYRING_PASSPHRASE: "candle-pipe-test-passphrase",
      HOME: configDir,
      PATH: tools,
    },
  }
}

/**
 * Runs `script` under `bash -o pipefail -c`, asynchronously. The CLI inside the script writes to a
 * pipe(2) that bash made, which is the point: the spawner's own `stdout: "pipe"` is a socketpair
 * with a far larger buffer, and the truncation this exists to catch passes straight through it.
 * Only what the LAST command in the script prints comes back here, never the CLI's own stdout.
 */
export async function runPipeline(
  script: string,
  pipe: { env: Record<string, string>; bash: string },
): Promise<{ status: number; out: Buffer; err: string }> {
  const proc = Bun.spawn([pipe.bash, "-o", "pipefail", "-c", script], {
    env: pipe.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [status, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
  ])
  return { status, out: Buffer.from(out), err }
}
