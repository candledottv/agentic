/**
 * BE-1665 (spec K-11, A-2, T-18's command half): a core-owned profile, as a same-user shell sees
 * it. The plain store holds only the Read key; the slot exists. Repeated with the `coreOwned`
 * marker intact, deleted and edited, because the marker must not matter: `candle swap` (the
 * CLI's trade), `candle keys create`, `candle mcp` with write tools and every other invocation
 * not on the read list exit `PROFILE_CORE_OWNED` before sending a single request.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CliConfig } from "../config"
import { type Deps, resolveApiKey, resolveDeviceToken } from "../deps"
import { ROUTED_COMMANDS, ROUTED_SUBCOMMANDS, run } from "../index"
import { profileSecretRef } from "../profiles"
import { createCapture, createFakeConfigStore, createTestDeps } from "../test-support"
import { CORE_OWNED_INVOCATIONS, coreOwnedAllows, ProfileCoreOwnedError } from "./ownership"
import { corePaths, ensureCoreDir } from "./paths"
import { inspectableStore, profileConfig, READ_KEY } from "./test-fixtures"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

type Marker = "intact" | "deleted" | "edited" | "slot-only-none" | "marker-only"

async function coreOwnedDeps(marker: Marker): Promise<{ deps: Deps; requests: string[]; mcpStarted: () => boolean }> {
  const dir = await mkdtemp(join(tmpdir(), "candle-core-owned-"))
  dirs.push(dir)
  const env = { CANDLE_CONFIG_DIR: dir }
  const paths = corePaths(env, dir, "staging")
  await ensureCoreDir(paths)
  if (marker !== "marker-only") await writeFile(paths.slot, "{}\n")
  const config: CliConfig = profileConfig("staging")
  const profile = config.profiles?.staging ?? {}
  if (marker === "intact" || marker === "marker-only") profile.coreOwned = true
  if (marker === "edited") profile.coreOwned = false
  const configStore = createFakeConfigStore(config)
  const requests: string[] = []
  let started = false
  const deps = createTestDeps({
    fetch: (async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return new Response(JSON.stringify({ ok: false }), { status: 500 })
    }) as unknown as typeof fetch,
    store: inspectableStore({ [profileSecretRef("staging", "apiKey")]: READ_KEY }),
    ...configStore,
    env,
    homedir: () => dir,
    stdout: createCapture(),
    stderr: createCapture(),
    runMcpServer: async () => {
      started = true
    },
  })
  return { deps, requests, mcpStarted: () => started }
}

async function runJson(deps: Deps, argv: string[]) {
  const stdout = createCapture()
  const code = await run([...argv, "--json"], { ...deps, stdout })
  const line = stdout.text.trim().split("\n")[0] ?? ""
  let body: { code?: string } = {}
  try {
    body = JSON.parse(line)
  } catch {}
  return { code, body }
}

const MARKERS: Marker[] = ["intact", "deleted", "edited", "marker-only"]

describe("T-18: a core-owned profile gives a same-user shell no write credential", () => {
  for (const marker of MARKERS) {
    describe(`coreOwned marker ${marker}`, () => {
      test("candle swap (the trade), keys create, auth login, transfer and perps open are refused before any request", async () => {
        const { deps, requests } = await coreOwnedDeps(marker)
        for (const argv of [
          ["swap", "--from", "SOL", "--to", "BONK", "--amount", "0.1"],
          ["keys", "create", "--access", "write"],
          ["auth", "login"],
          ["transfer", "--to", "x", "--amount", "1"],
          ["perps", "open", "BTC", "--side", "long"],
        ]) {
          const { code, body } = await runJson(deps, argv)
          expect(`${argv.join(" ")}: ${code} ${body.code}`).toBe(`${argv.join(" ")}: 1 PROFILE_CORE_OWNED`)
        }
        expect(requests).toEqual([])
      })

      test("candle mcp with write tools is refused; --read-only still starts, with no key", async () => {
        const { deps, mcpStarted } = await coreOwnedDeps(marker)
        expect((await runJson(deps, ["mcp"])).body.code).toBe("PROFILE_CORE_OWNED")
        expect((await runJson(deps, ["mcp", "--tools", "candle_trade"])).body.code).toBe("PROFILE_CORE_OWNED")
        expect(mcpStarted()).toBe(false)
        const readOnly = await run(["mcp", "--read-only"], deps)
        expect(readOnly).toBe(0)
        expect(mcpStarted()).toBe(true)
      })

      test("the device-token resolver refuses too, whatever reaches it", async () => {
        const { deps } = await coreOwnedDeps(marker)
        await expect(resolveDeviceToken(deps, "staging")).rejects.toBeInstanceOf(ProfileCoreOwnedError)
        // The plain API key the CLI can still read is the Read key.
        expect(await resolveApiKey(deps, "staging")).toBe(READ_KEY)
      })

      test("auth status and doctor report the device token as held by the core, not as a failure", async () => {
        const { deps } = await coreOwnedDeps(marker)
        const status = createCapture()
        await run(["auth", "status"], { ...deps, stdout: status })
        expect(status.text).toContain("held by the Candle core")
        const doctor = createCapture()
        await run(["doctor"], { ...deps, stdout: doctor })
        expect(doctor.text).toContain("held by the Candle core")
        expect(`${status.text}${doctor.text}`).not.toContain("PROFILE_CORE_OWNED")
      })

      test("keys list, the owner's device-token read, is refused", async () => {
        const { deps } = await coreOwnedDeps(marker)
        expect((await runJson(deps, ["keys", "list"])).body.code).toBe("PROFILE_CORE_OWNED")
      })

      test("profile remove and rename of the core-owned profile are refused; list still works", async () => {
        const { deps } = await coreOwnedDeps(marker)
        expect((await runJson(deps, ["profile", "remove", "staging", "--yes"])).body.code).toBe("PROFILE_CORE_OWNED")
        expect((await runJson(deps, ["profile", "rename", "staging", "mine"])).body.code).toBe("PROFILE_CORE_OWNED")
        expect((await runJson(deps, ["profile", "list"])).code).toBe(0)
      })
    })
  }

  test("every routed invocation not on the read list is refused, without a request", async () => {
    const { deps, requests } = await coreOwnedDeps("deleted")
    const refused: string[] = []
    const invocations: { cmd: string; sub?: string }[] = []
    for (const cmd of ROUTED_COMMANDS) {
      if (cmd === "help" || cmd === "completion") continue
      for (const sub of ROUTED_SUBCOMMANDS[cmd] ?? []) invocations.push({ cmd, sub })
      invocations.push({ cmd })
    }
    for (const { cmd, sub } of invocations) {
      const isSubcommand = sub !== undefined
      if (coreOwnedAllows({ cmd, sub, isSubcommand, args: [] })) continue
      const { code, body } = await runJson(deps, sub ? [cmd, sub] : [cmd])
      // A bare form that does not exist answers usage before the gate; that runs nothing either.
      if (body.code !== "PROFILE_CORE_OWNED") expect(`${cmd} ${sub ?? ""}: ${code}`).toMatch(/: [12]$/)
      else refused.push(`${cmd}${sub ? ` ${sub}` : ""}`)
    }
    expect(refused).toContain("swap")
    expect(refused).toContain("keys create")
    expect(refused).toContain("vault transfer")
    // The sweep reached the gate for most of the surface, not a handful of words.
    expect(refused.length).toBeGreaterThan(60)
    expect(requests).toEqual([])
  })

  test("every read-list entry names an invocation dispatch routes", () => {
    for (const entry of CORE_OWNED_INVOCATIONS) {
      const [cmd, sub] = entry.split(" ")
      expect(`${entry}: ${ROUTED_COMMANDS.has(cmd ?? "")}`).toBe(`${entry}: true`)
      if (sub !== undefined && sub !== "*")
        expect(`${entry}: ${ROUTED_SUBCOMMANDS[cmd ?? ""]?.includes(sub)}`).toBe(`${entry}: true`)
    }
  })

  test("a profile with neither a slot nor the marker is not core-owned", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-core-owned-"))
    dirs.push(dir)
    const deps = createTestDeps({
      fetch: (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch,
      ...createFakeConfigStore(profileConfig("staging")),
      env: { CANDLE_CONFIG_DIR: dir },
      homedir: () => dir,
    })
    expect(await resolveDeviceToken(deps, "staging")).toBeUndefined()
  })
})
