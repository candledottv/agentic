import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ApiKeyFileError } from "../../mcp/src/api-key-file"
import { keyRotationRow } from "./commands/doctor"
import { tradingFailure } from "./commands/swap"
import { writeVaultFailure } from "./commands/vault-support"
import { beginCredentialInvocation, type CommandContext, resolveApiCredential, resolveApiKey } from "./deps"
import { verifyProfileAccount } from "./guard"
import { run } from "./index"
import { printIdentity } from "./profiles"
import { createCapture, createFakeConfigStore, createFakeStore, createTestDeps, jsonResponse } from "./test-support"
import { controlledByJson, readControlledBy, renderControlledBy } from "./vault/promote-support"

const KEY = `cndl_live_Ab3dEf9h${"s".repeat(35)}`
const replacement = `cndl_live_Ab3dEf9h${"r".repeat(35)}`
const config = {
  profiles: { fixture: { account: "cached-account-A", username: "cached-user-A", keyPrefix: "cached-prefix-A" } },
  activeProfile: "fixture",
}
const unused = (() => {
  throw new Error("unexpected network")
}) as unknown as unknown as typeof fetch
function context(deps: ReturnType<typeof createTestDeps>, json = false): CommandContext {
  return { deps, json, apiUrl: "http://127.0.0.1:1234", profile: "fixture", verifyAccount: true } as CommandContext
}
function forbiddenStore() {
  return {
    async get() {
      throw new Error("unexpected credential-store read")
    },
    async set() {
      throw new Error("unexpected credential-store write")
    },
    async delete() {
      throw new Error("unexpected credential-store deletion")
    },
  }
}

describe("file credentials across CLI consumers", () => {
  test("exclusive source, no API-key slot reads, one read across identity/request, next invocation reloads", async () => {
    let reads = 0,
      current = KEY
    const stdout = createCapture()
    const deps = createTestDeps({
      ...createFakeConfigStore(config),
      store: forbiddenStore(),
      stdout,
      env: { CANDLE_API_KEY_FILE: " fixture " },
      loadApiKeyFile: () => {
        reads++
        return current
      },
      fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("x-api-key") === KEY).toBe(true)
        return jsonResponse(200, { account: "acting-account-B" })
      }) as unknown as typeof fetch,
    })
    const scoped = beginCredentialInvocation(deps)
    await printIdentity(context(scoped))
    current = replacement
    const credential = await resolveApiCredential({ ...scoped, stderr: createCapture() }, "fixture")
    expect(credential.source).toBe("file")
    expect(credential.key === KEY).toBe(true)
    expect(reads).toBe(1)
    expect(stdout.text).toContain("acti…nt-B")
    expect(stdout.text).toContain("CANDLE_API_KEY_FILE override")
    expect(stdout.text.includes(KEY)).toBe(false)
    expect(stdout.text).not.toContain("cached-user-A")
    expect(stdout.text).not.toContain("cached-account-A")
    expect((await resolveApiKey(beginCredentialInvocation(deps), "fixture")) === replacement).toBe(true)
    expect(reads).toBe(2)
    expect((await deps.readConfig()).profiles?.fixture?.account).toBe("cached-account-A")
  })
  test("memoized failures never fall back, injected exception and malicious path do not leak", async () => {
    let reads = 0
    const deps = createTestDeps({
      fetch: unused,
      store: forbiddenStore(),
      env: { CANDLE_API_KEY_FILE: `/missing/${KEY}` },
      loadApiKeyFile: () => {
        reads++
        throw new Error(KEY)
      },
    })
    for (let i = 0; i < 2; i++) {
      try {
        await resolveApiKey(deps)
        throw new Error("expected refusal")
      } catch (error) {
        expect(error instanceof ApiKeyFileError).toBe(true)
        expect(String(error).includes(KEY)).toBe(false)
      }
    }
    expect(reads).toBe(1)
    for (const json of [false, true]) {
      const stdout = createCapture(),
        stderr = createCapture()
      expect(await run(["wallets", ...(json ? ["--json"] : [])], { ...deps, stdout, stderr })).toBe(1)
      expect((stdout.text + stderr.text).includes(KEY)).toBe(false)
      expect(stdout.text + stderr.text).toContain(json ? "API_KEY_FILE_UNREADABLE" : "Cannot read CANDLE_API_KEY_FILE")
    }
  })
  test("source conflict precedes file and store access and device-auth requests", async () => {
    for (const raw of [
      { CANDLE_API_KEY: KEY },
      { CANDLE_AGENT_API_KEY: KEY },
      { CANDLE_API_KEY: KEY, CANDLE_AGENT_API_KEY: KEY },
    ]) {
      const deps = createTestDeps({
        fetch: unused,
        store: forbiddenStore(),
        env: { CANDLE_API_KEY_FILE: "/unused", ...raw },
        loadApiKeyFile: () => {
          throw new Error("unexpected loader")
        },
      })
      expect(await run(["keys", "list", "--json"], deps)).toBe(1)
      expect((deps.stdout as ReturnType<typeof createCapture>).text).toContain("API_KEY_SOURCE_CONFLICT")
    }
  })
  test("guard skips stored-account comparison for the external file", async () => {
    const deps = createTestDeps({
      ...createFakeConfigStore(config),
      fetch: unused,
      store: forbiddenStore(),
      env: { CANDLE_API_KEY_FILE: "/fixture" },
    })
    expect(await verifyProfileAccount(context(deps), config)).toEqual({
      ok: true,
      skipped: "CANDLE_API_KEY_FILE external override",
    })
  })
  test("offline identity reports unknown under the file override", async () => {
    const deps = createTestDeps({
      ...createFakeConfigStore(config),
      fetch: unused,
      store: forbiddenStore(),
      env: { CANDLE_API_KEY_FILE: "/fixture" },
      loadApiKeyFile: () => KEY,
    })
    await printIdentity(context(deps))
    const out = (deps.stdout as ReturnType<typeof createCapture>).text
    expect(out).toContain("Account unknown (CANDLE_API_KEY_FILE override)")
    expect(out).not.toContain("cached-user-A")
  })
  test("file source bypasses legacy migration and validates before device-token HTTP", async () => {
    const deps = createTestDeps({
      ...createFakeConfigStore({ keyPrefix: "cached-legacy" }),
      fetch: unused,
      store: forbiddenStore(),
      env: { CANDLE_API_KEY_FILE: "/fixture", CANDLE_DEVICE_TOKEN: "synthetic-device" },
      loadApiKeyFile: () => {
        throw new Error(KEY)
      },
    })
    expect(await run(["keys", "list", "--json"], deps)).toBe(1)
    expect((await deps.readConfig()).profiles).toBeUndefined()
  })
  test("no-file CLI ignores standalone alias, preserves profile/legacy precedence and blanks", async () => {
    const deps = createTestDeps({
      fetch: unused,
      env: { CANDLE_AGENT_API_KEY: "standalone", CANDLE_API_KEY_FILE: " \t " },
      store: createFakeStore({ api_key: "legacy", "profile:fixture:api_key": "profile" }),
    })
    expect(await resolveApiCredential(deps)).toEqual({ key: "legacy", source: "legacy" })
    expect(await resolveApiCredential(deps, "fixture")).toEqual({ key: "profile", source: "profile" })
    expect(await resolveApiCredential(deps, "empty")).toEqual({ key: undefined, source: "none" })
  })
  test("auth status JSON/human never uses cached A as acting B/unknown", async () => {
    for (const json of [true, false])
      for (const offline of [true, false]) {
        const deps = createTestDeps({
          ...createFakeConfigStore(config),
          env: { CANDLE_API_KEY_FILE: "/fixture" },
          loadApiKeyFile: () => KEY,
          fetch: (async () => {
            if (offline) throw new Error("offline")
            return jsonResponse(200, { account: "acting-account-B" })
          }) as unknown as typeof fetch,
        })
        await run(["auth", "status", ...(json ? ["--json"] : [])], deps)
        const out = (deps.stdout as ReturnType<typeof createCapture>).text
        expect(out.includes(KEY)).toBe(false)
        if (json) {
          const body = JSON.parse(out)
          expect(body.account).toBe(offline ? undefined : "acting-account-B")
          expect(body.cachedAccount).toBe("cached-account-A")
          expect(body.envOverrides).toContain("CANDLE_API_KEY_FILE")
          expect(body.apiKeySource).toBe("file")
          expect(body.keyPrefix).toBe("Ab3dEf9h")
        } else {
          expect(out.split("\n")[0]).toContain("CANDLE_API_KEY_FILE override")
          expect(out.split("\n")[0]).not.toContain("cached-account-A")
          expect(out).not.toContain("cached-user-A")
        }
      }
  })
  test("doctor preserves local file error and sends no probes, including device token", async () => {
    const deps = createTestDeps({
      fetch: unused,
      store: forbiddenStore(),
      env: { CANDLE_API_KEY_FILE: `/missing/${KEY}`, CANDLE_DEVICE_TOKEN: "synthetic-device" },
    })
    expect(await run(["doctor", "--json"], deps)).toBe(1)
    const out = (deps.stdout as ReturnType<typeof createCapture>).text
    expect(out).toContain("API_KEY_FILE_UNREADABLE")
    expect(out.includes(KEY)).toBe(false)
    expect(keyRotationRow("2026-11-11T12:00:00Z", "CANDLE_API_KEY_FILE").detail).toContain("restart MCP")
  })
  test("trading/vault diagnostic wrappers and public perps configuration preserve stable file codes", async () => {
    for (const render of [tradingFailure, writeVaultFailure]) {
      const deps = createTestDeps({ fetch: unused })
      expect(render(context(deps, true), new ApiKeyFileError("API_KEY_FILE_INVALID", "Invalid credential file."))).toBe(
        1,
      )
      expect(JSON.parse((deps.stdout as ReturnType<typeof createCapture>).text).code).toBe("API_KEY_FILE_INVALID")
    }
    const deps = createTestDeps({
      fetch: unused,
      store: forbiddenStore(),
      env: { CANDLE_API_KEY_FILE: `/missing/${KEY}` },
    })
    expect(await run(["perps", "markets", "--json"], deps)).toBe(1)
    const out = (deps.stdout as ReturnType<typeof createCapture>).text
    expect(JSON.parse(out).code).toBe("API_KEY_FILE_UNREADABLE")
    expect(out.includes(KEY)).toBe(false)
  })
  test("vault controlling/imported-under metadata reports file, B, and no profile name", async () => {
    const deps = createTestDeps({
      ...createFakeConfigStore(config),
      env: { CANDLE_API_KEY_FILE: "/fixture", CANDLE_DEVICE_TOKEN: "device" },
      loadApiKeyFile: () => KEY,
      fetch: (async (url) =>
        jsonResponse(
          200,
          String(url).endsWith("/embedded") ? { account: "acting-account-B" } : { keys: [] },
        )) as typeof fetch,
    })
    const result = await readControlledBy(context(deps))
    expect(result.keySource).toBe("file")
    expect(result.account).toBe("acting-account-B")
    expect(result.profileName).toBeUndefined()
    expect(renderControlledBy(result, 1)).toContain("CANDLE_API_KEY_FILE")
    const json = controlledByJson({ ...result, toKey: { keyPrefix: "target", label: null, warnings: [] } })
    expect(json.importedUnder?.keySource).toBe("file")
    expect(JSON.stringify(json).includes(KEY)).toBe(false)
  })
  test("rotation warns, does not copy external file to store or alter its bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "candle-rotate-")),
      path = join(dir, "key")
    try {
      writeFileSync(path, KEY, { mode: 0o600 })
      for (const json of [true, false]) {
        const deps = createTestDeps({
          env: { CANDLE_API_KEY_FILE: path, CANDLE_DEVICE_TOKEN: "device" },
          store: forbiddenStore(),
          fetch: (async (url) =>
            jsonResponse(
              200,
              String(url).endsWith("/rotate")
                ? { key: replacement, keyPrefix: "Ab3dEf9h", rotatedAt: 1, previousValidUntil: null }
                : { account: "acting-account-B", keys: [] },
            )) as typeof fetch,
        })
        expect(await run(["keys", "rotate", "Ab3dEf9h", "--yes", ...(json ? ["--json"] : [])], deps)).toBe(0)
        expect(readFileSync(path, "utf8") === KEY).toBe(true)
        const out = (deps.stdout as ReturnType<typeof createCapture>).text
        const err = (deps.stderr as ReturnType<typeof createCapture>).text
        expect((out + err).includes(KEY)).toBe(false)
        if (json) expect(JSON.parse(out)).toMatchObject({ stored: false, candleApiKeyFileStale: true })
        else {
          expect(err).toContain("file was not updated")
          expect(err).toContain("restart MCP")
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test("read-only MCP ignores valid/missing/invalid paths and raw conflicts with zero loaders/store reads", async () => {
    for (const path of ["/fixture", "/missing", `/invalid/${KEY}`])
      for (const print of [false, true]) {
        let loads = 0,
          starts = 0
        const deps = createTestDeps({
          fetch: unused,
          store: forbiddenStore(),
          env: { CANDLE_API_KEY_FILE: path, CANDLE_API_KEY: KEY, CANDLE_AGENT_API_KEY: KEY },
          loadApiKeyFile: () => {
            loads++
            throw new Error("unexpected loader")
          },
          runMcpServer: async (env) => {
            starts++
            expect(env.CANDLE_API_KEY_FILE).toBeUndefined()
            expect(env.CANDLE_API_KEY).toBeUndefined()
            expect(env.CANDLE_AGENT_API_KEY).toBeUndefined()
          },
        })
        expect(await run(["mcp", "--read-only", ...(print ? ["--print-config"] : [])], deps)).toBe(0)
        expect(loads).toBe(0)
        expect(starts).toBe(print ? 0 : 1)
        expect((deps.stdout as ReturnType<typeof createCapture>).text.includes(KEY)).toBe(false)
      }
  })
  test("file input cannot bypass a core-owned dispatch refusal", async () => {
    let reads = 0
    const deps = createTestDeps({
      ...createFakeConfigStore({ profiles: { fixture: { coreOwned: true } }, activeProfile: "fixture" }),
      fetch: unused,
      store: forbiddenStore(),
      env: { CANDLE_API_KEY_FILE: "/fixture" },
      loadApiKeyFile: () => {
        reads++
        return KEY
      },
    })
    expect(await run(["keys", "list", "--json"], deps)).toBe(1)
    expect((deps.stdout as ReturnType<typeof createCapture>).text).toContain("PROFILE_CORE_OWNED")
    expect(reads).toBe(0)
  })
  test("logout leaves the external file active and unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "candle-logout-")),
      path = join(dir, "key")
    try {
      writeFileSync(path, KEY, { mode: 0o600 })
      const deps = createTestDeps({
        ...createFakeConfigStore(config),
        fetch: unused,
        env: { CANDLE_API_KEY_FILE: path, CANDLE_DEVICE_TOKEN: "device" },
      })
      expect(await run(["auth", "logout", "--keep-key", "--json"], deps)).toBe(0)
      const body = JSON.parse((deps.stdout as ReturnType<typeof createCapture>).text)
      expect(body.envOverrides).toContain("CANDLE_API_KEY_FILE")
      expect(readFileSync(path, "utf8") === KEY).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test("help/version/completion and print-config remain local with an invalid file", async () => {
    for (const argv of [["--help"], ["--version"], ["completion", "bash"], ["mcp", "--print-config"]]) {
      const deps = createTestDeps({
        fetch: unused,
        store: forbiddenStore(),
        env: { CANDLE_API_KEY_FILE: "/missing" },
        loadApiKeyFile: () => {
          throw new Error("unexpected loader")
        },
      })
      expect(await run(argv, deps)).toBe(0)
    }
  })
})
