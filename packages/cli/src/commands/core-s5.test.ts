/**
 * BE-1737 (spec S5): `candle core serve` end to end with a fake API (the Quant key route, tracked
 * wallets) and a fake tape socket. A profile with only a Read key and trading off: no Write key,
 * no device token, no vault factor anywhere.
 *
 * T-1 (every Quant call on the Read key; a turn completes with trading off), T-2 (roles over the
 * socket), T-7 (no Quant text on disk), T-8's core half (Quant text reaches the view redacted),
 * T-15's Off switch, T-17's dispatch half (candle_get_signals never reaches the API or the
 * executor), and Q-I10 over the socket.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { openSync } from "node:fs"
import { readdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { corePaths } from "../core/paths"
import { PROTOCOL_VERSION } from "../core/rpc"
import { fakeQuantApi, fakeTape, stubScript, tapeRow, WATCHED } from "../core/s5-test-kit"
import { connectTestClient, inspectableStore, profileConfig, READ_KEY, type TestClient } from "../core/test-fixtures"
import type { CommandContext, Deps } from "../deps"
import { profileSecretRef } from "../profiles"
import { newClientTurnId } from "../quant"
import { createCapture, createFakeConfigStore, createTestDeps } from "../test-support"
import { closeVault } from "../vault/store"
import { makeVault, useCheapKdf } from "../vault/test-vault"
import { coreServe } from "./core"

beforeAll(() => useCheapKdf())

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await filesUnder(path)))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

const QUESTION = "unique-question-zebra-7731: is this token safe?"
const ANSWER = "unique-answer-quokka-4410: it looks thin."

async function startCore() {
  const m = await makeVault()
  dirs.push(m.dir)
  closeVault(m.vault)
  const env = { CANDLE_CONFIG_DIR: m.dir }
  // A signed-in profile with only its Read key: no Write key, no device token.
  const store = inspectableStore({ [profileSecretRef("staging", "apiKey")]: READ_KEY })
  const api = fakeQuantApi({
    nextScript: [
      ...stubScript(ANSWER, 11).slice(0, 3),
      { kind: "text", data: { text: `${ANSWER}\u001b[2J leaked ${READ_KEY}` } },
      { kind: "done", data: { messagesLeft: 11 } },
    ],
  })
  api.history = [{ id: "m1", role: "user", text: QUESTION, createdAt: "2026-10-21T00:00:00Z" }]
  api.other = (path) =>
    path === "/api/v1/agent/tracked-wallets"
      ? Response.json({ success: true, wallets: [{ chain: "solana", address: WATCHED }], max: 50 })
      : undefined
  const tape = fakeTape()
  const deps: Deps = createTestDeps({
    fetch: api.fetch,
    store,
    ...createFakeConfigStore(profileConfig("staging")),
    env,
    homedir: () => m.dir,
    stdout: createCapture(),
    stderr: createCapture(),
    openTape: tape.open,
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
  for (let i = 0; i < 300 && token === ""; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    token = (await readFile(handoff, "utf8").catch(() => "")).trim()
  }
  const view = await connectTestClient(paths.socket)
  expect(
    (await view.request("core.hello", { protocol: PROTOCOL_VERSION, token, clientName: "tui" })).error,
  ).toBeUndefined()
  const minted = (await view.request("harness.register", { name: "Claude Code" })).result as { token: string }
  const harness = await connectTestClient(paths.socket)
  await harness.request("core.hello", {
    protocol: PROTOCOL_VERSION,
    token: minted.token,
    clientName: "candle core mcp",
    harnessKind: "claude-code",
  })
  return { m, api, tape, view, harness, paths, running, token }
}

const code = (answer: Awaited<ReturnType<TestClient["request"]>>) => answer.error?.data?.code

describe("candle core serve: Quant and signals (S5)", () => {
  test("T-1, T-2, T-7, T-8: Read key only, view only, nothing on disk, redacted on the socket", async () => {
    const core = await startCore()
    const { view, harness, api } = core

    // T-2: a harness reaches no quant.* method, and has no Quant tool.
    for (const method of ["quant.status", "quant.send", "quant.cancel", "quant.history"]) {
      const answer = await harness.request(method, { text: "x", clientTurnId: newClientTurnId(), turnId: "t" })
      expect(`${method}: ${code(answer)} ${answer.error?.code}`).toBe(`${method}: FORBIDDEN_FOR_ROLE -32001`)
    }
    const tools = ((await harness.request("tools.list")).result as { tools: { name: string }[] }).tools
    expect(tools.some((tool) => /quant/i.test(tool.name))).toBe(false)
    expect(tools.some((tool) => tool.name === "candle_get_signals")).toBe(true)
    expect(code(await harness.request("subscribe", { topics: ["quant"] }))).toBe("FORBIDDEN_FOR_ROLE")
    expect(code(await harness.request("subscribe", { topics: ["signals"], scope: "mine" }))).toBe("VALIDATION_FAILED")
    expect(code(await harness.request("subscribe", { topics: ["signals:mine"] }))).toBe("FORBIDDEN_FOR_ROLE")
    const mine = await harness.request("tools.call", { name: "candle_get_signals", args: { mine: true } })
    expect(JSON.parse((mine.result as { content: { text: string }[] }).content[0]?.text ?? "{}")).toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    })

    // T-1: from the view, with trading off, a turn completes on the Read key.
    expect((await view.request("settings.get")).result).toMatchObject({
      tradingOn: false,
      agents: [{ id: "quant", canPropose: false, on: true }],
    })
    await view.request("subscribe", { topics: ["quant"] })
    const status = await view.request("quant.status")
    expect(status.result).toMatchObject({ enabled: true, allowed: true, tier: "pro", remaining: 12, signedIn: true })
    const sent = await view.request("quant.send", { text: QUESTION, clientTurnId: newClientTurnId() })
    expect(sent.result).toMatchObject({ turnId: "turn_1" })
    await until(() =>
      view.events.some((event) => event.topic === "quant" && (event.data as { kind?: string }).kind === "done"),
    )
    const history = await view.request("quant.history", { limit: 30 })
    expect(history.result).toMatchObject({ items: [{ id: "m1" }] })
    const quantCalls = api.calls.filter((call) => call.path.startsWith("/api/v1/agent/quant"))
    expect(quantCalls.length).toBeGreaterThanOrEqual(4)
    expect(quantCalls.every((call) => call.key === READ_KEY)).toBe(true)

    // T-8, core half: the answer reached the view with the key redacted (the view strips the ESC).
    const text = view.events.find(
      (event) => event.topic === "quant" && (event.data as { kind?: string }).kind === "text",
    )
    expect(JSON.stringify(text)).toContain("[redacted]")
    expect(view.frames.join("\n")).not.toContain(READ_KEY)

    // T-17, dispatch half: candle_get_signals answers from the cache; the API sees nothing for it.
    await harness.request("subscribe", { topics: ["signals"] })
    await until(() => core.tape.sockets.length === 1)
    core.tape.accept()
    core.tape.snapshot([tapeRow(1, { wallet: WATCHED }), tapeRow(2)])
    const before = api.calls.length
    const read = await harness.request("tools.call", { name: "candle_get_signals", args: { limit: 5 } })
    const body = JSON.parse((read.result as { content: { text: string }[] }).content[0]?.text ?? "{}")
    expect(body).toMatchObject({ success: true, stale: false, count: 2 })
    expect(api.calls.length).toBe(before)
    // Q-I10: the harness's signals events carry All rows and never the watchlist.
    await view.request("subscribe", { topics: ["signals"], scope: "mine" })
    await until(() =>
      view.events.some(
        (event) => event.topic === "signals:mine" && (event.data as { watchlist?: string }).watchlist === "ok",
      ),
    )
    expect(core.tape.sockets).toHaveLength(1)
    const harnessSignals = harness.events.filter((event) => event.topic.startsWith("signals"))
    expect(harnessSignals.every((event) => event.topic === "signals")).toBe(true)
    expect(JSON.stringify(harnessSignals)).not.toContain('"watchlist"')

    // T-7: no Quant text, asked or answered, anywhere under the config directory.
    await new Promise((resolve) => setTimeout(resolve, 30))
    for (const file of await filesUnder(core.m.dir)) {
      const content = await readFile(file, "utf8").catch(() => "")
      expect(`${file}: ${content.includes("unique-question-zebra")}`).toBe(`${file}: false`)
      expect(`${file}: ${content.includes("unique-answer-quokka")}`).toBe(`${file}: false`)
    }

    // T-15: Off is refused at the core too, and survives in settings.
    const off = await view.request("settings.set", { path: "quant", value: false })
    expect(off.result).toMatchObject({ agents: [{ id: "quant", on: false }] })
    expect(code(await view.request("quant.send", { text: "hi", clientTurnId: newClientTurnId() }))).toBe("QUANT_OFF")

    harness.close()
    view.close()
    expect(await core.running).toBe(0)
  })
})
