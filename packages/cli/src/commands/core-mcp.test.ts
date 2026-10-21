/**
 * BE-1665 (spec A-5): the `candle core mcp` face, end to end through a real `candle core serve`, a
 * fixture vault and a fake API. T-6 (tools.list half), T-11, T-15, T-19 (kind swap half), and
 * T-18's "core without the TUI" and paper-window halves.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { openSync } from "node:fs"
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { TOOL_NAMES } from "../../../mcp/src/tools"
import { connectCore } from "../core/client"
import { coreLocalDefinitions } from "../core/core-local-tools"
import { toolDefinitions } from "../core/executor"
import { readJournal } from "../core/journal"
import { corePaths } from "../core/paths"
import { PROTOCOL_VERSION } from "../core/rpc"
import {
  connectTestClient,
  DEVICE_TOKEN,
  inspectableStore,
  profileConfig,
  READ_KEY,
  type TestClient,
  WRITE_KEY,
} from "../core/test-fixtures"
import type { CommandContext, Deps } from "../deps"
import { profileSecretRef } from "../profiles"
import { createCapture, createFakeConfigStore, createTestDeps } from "../test-support"
import { closeVault } from "../vault/store"
import { makeVault, useCheapKdf } from "../vault/test-vault"
import { coreServe } from "./core"
import { buildCoreMcpServer, CORE_MCP_INSTRUCTIONS, coreMcp } from "./core-mcp"

beforeAll(() => useCheapKdf())

const MINT = "So11111111111111111111111111111111111111112"
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {})
})

type ApiCall = { method: string; url: string; key: string | null; body: unknown }

async function startCore(
  base?: {
    dir: string
    passphrase: string
    store: ReturnType<typeof inspectableStore>
    api: ApiCall[]
    respond: Responder
  },
  opts: { view?: boolean } = { view: true },
) {
  const m =
    base ??
    (await (async () => {
      const made = await makeVault()
      closeVault(made.vault)
      cleanups.push(() => rm(made.dir, { recursive: true, force: true }))
      return {
        dir: made.dir,
        passphrase: made.passphrase,
        store: inspectableStore({
          [profileSecretRef("staging", "apiKey")]: WRITE_KEY,
          [profileSecretRef("staging", "deviceToken")]: DEVICE_TOKEN,
        }),
        api: [] as ApiCall[],
        respond: { current: defaultRespond },
      }
    })())
  const env = { CANDLE_CONFIG_DIR: m.dir }
  let terminate: (() => void) | undefined
  const deps: Deps = createTestDeps({
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const call: ApiCall = {
        method: init?.method ?? "GET",
        url,
        key: new Headers(init?.headers).get("x-api-key"),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      }
      m.api.push(call)
      return m.respond.current(call)
    }) as unknown as typeof fetch,
    store: m.store,
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
  const handoff = join(m.dir, `handoff-${Date.now()}`)
  const running = coreServe(opts.view ? ["--view-token-fd", String(openSync(handoff, "w"))] : [], ctx)
  let view: TestClient | undefined
  if (opts.view) {
    let token = ""
    for (let i = 0; i < 200 && token === ""; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      token = (await readFile(handoff, "utf8").catch(() => "")).trim()
    }
    view = await connectTestClient(paths.socket)
    await view.request("core.hello", { protocol: PROTOCOL_VERSION, token, clientName: "tui" })
  } else {
    for (let i = 0; i < 200 && terminate === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const stop = async () => {
    view?.close()
    terminate?.()
    await running
  }
  cleanups.push(stop)
  return { m, paths, view, running, stop, factor: { type: "passphrase", value: m.passphrase } }
}

type Responder = { current: (call: ApiCall) => Response }
function defaultRespond(call: ApiCall): Response {
  if (call.url.endsWith("/api/v1/agent/keys"))
    return Response.json({ key: READ_KEY, keyPrefix: "rrrrrrrr", scopes: ["account:read"] })
  if (call.url.includes("/api/v1/trade/agent/build")) {
    const body = call.body as { clientTradeId?: string; paper?: boolean }
    return Response.json({
      success: true,
      paper: body.paper === true,
      job: { clientTradeId: body.clientTradeId, status: "confirmed" },
    })
  }
  if (call.url.includes("/api/v1/trade/agent/jobs/"))
    return Response.json({ success: true, job: { status: "confirmed" } })
  if (call.method === "GET" && call.url.includes("/market"))
    return Response.json({ success: true, market: { mint: MINT, price: 1, quoteDecimals: 9, candleLaunched: true } })
  return Response.json({ success: false, error: { code: "NOT_FAKED", message: call.url } }, { status: 404 })
}

async function harnessClient(core: Awaited<ReturnType<typeof startCore>>, token?: string) {
  let harnessToken = token
  if (!harnessToken) {
    harnessToken = (
      (await core.view?.request("harness.register", { name: "Claude Code" }))?.result as { token: string }
    ).token
  }
  const { connection } = await connectCore({
    socketPath: core.paths.socket,
    token: harnessToken,
    clientName: "candle core mcp",
    harnessKind: "claude-code",
  })
  const server = await buildCoreMcpServer(connection)
  const client = new Client({ name: "harness", version: "1" })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  await client.connect(clientSide)
  cleanups.push(async () => {
    await client.close()
    await server.close()
    connection.close()
  })
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean
      content: { text: string }[]
    }
    const raw = result.content[0]?.text ?? "null"
    let body: Record<string, unknown>
    try {
      body = JSON.parse(raw)
    } catch {
      throw new Error(`${name} answered with text, not JSON: ${raw.slice(0, 300)}`)
    }
    return { isError: result.isError === true, body }
  }
  return { client, call, token: harnessToken }
}

const turnOn = async (core: Awaited<ReturnType<typeof startCore>>) =>
  expect(
    (await core.view?.request("settings.set", { path: "trading", value: true, factor: core.factor }))?.result,
  ).toMatchObject({ tradingOn: true })

describe("the core MCP face (A-5)", () => {
  test("T-6: the same tools and definitions as candle mcp, minus the transfers, with the core's instructions", async () => {
    const core = await startCore()
    const h = await harnessClient(core)
    const listed = (await h.client.listTools()).tools
    const names = listed.map((tool) => tool.name).sort()
    // S5 G-2: plus the core's own read, candle_get_signals.
    expect(names).toEqual(
      [
        ...TOOL_NAMES.filter((name) => name !== "candle_transfer" && name !== "candle_sweep"),
        "candle_get_signals",
      ].sort(),
    )
    const expected = new Map(
      [
        ...(await toolDefinitions(names.filter((name) => name !== "candle_get_signals"))),
        ...coreLocalDefinitions(),
      ].map((d) => [d.name, d]),
    )
    for (const tool of listed)
      expect(`${tool.name}: ${tool.description}`).toBe(`${tool.name}: ${expected.get(tool.name)?.description}`)
    // S5 Q-I10, T-2: the signals tool has no `mine` (and no `kind`) in its schema.
    const signals = listed.find((tool) => tool.name === "candle_get_signals")
    const properties = Object.keys((signals?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})
    expect(properties.sort()).toEqual(["chain", "limit", "mint", "pattern"])
    const getOperation = listed.find((tool) => tool.name === "candle_get_operation")
    expect(
      (getOperation?.inputSchema as unknown as { properties: { kind: { enum: string[] } } }).properties.kind.enum,
    ).toEqual(["trade", "launch", "swap", "stake", "claim", "perps", "profile"])
    expect(h.client.getInstructions()).toBe(CORE_MCP_INSTRUCTIONS)
    // A transfer called by name anyway is refused, not run.
    const direct = await harnessClientCall(core, h.token, "candle_transfer", { to: "x", amount: "1" })
    expect(direct).toMatchObject({ success: false, error: { code: "TRANSFER_USER_ONLY" } })
  })

  test("T-15: a live trade answers APPROVAL_REQUIRED with its clientTradeId; get_operation reads awaiting_approval, then the record", async () => {
    const core = await startCore()
    await turnOn(core)
    const h = await harnessClient(core)
    const answer = await h.call("candle_trade", { mint: MINT, side: "buy", amount: "0.1" })
    expect(answer.isError).toBe(false)
    expect(answer.body).toMatchObject({
      success: false,
      error: { code: "APPROVAL_REQUIRED" },
      kind: "trade",
      state: "awaiting_approval",
    })
    const clientTradeId = answer.body.clientTradeId as string
    expect(typeof clientTradeId).toBe("string")
    expect(core.m.api.some((call) => call.url.includes("/trade/agent/build"))).toBe(false)
    expect((await h.call("candle_get_operation", { clientId: clientTradeId, kind: "trade" })).body).toMatchObject({
      state: "awaiting_approval",
    })

    const card = (await core.view?.request("cards.list"))?.result as {
      cards: { cardId: string; cardHash: string; opId: string }[]
    }
    const target = card.cards.find((c) => c.opId === clientTradeId)
    const approved = await core.view?.request("cards.approve", {
      cardId: target?.cardId,
      cardHash: target?.cardHash,
      factor: core.factor,
    })
    expect(approved?.result).toMatchObject({ operation: { state: "succeeded" } })
    const build = core.m.api.find((call) => call.url.includes("/trade/agent/build"))
    expect(build?.key).toBe(WRITE_KEY)
    expect((build?.body as { clientTradeId: string }).clientTradeId).toBe(clientTradeId)
    expect((await h.call("candle_get_operation", { clientId: clientTradeId, kind: "trade" })).body).toMatchObject({
      success: true,
      state: "succeeded",
      result: { api: { job: { status: "confirmed" } } },
    })
    // A re-send of the same request under the same id is a read: no second card, no second build.
    expect(
      (await h.call("candle_trade", { mint: MINT, side: "buy", amount: "0.1", clientTradeId })).body,
    ).toMatchObject({ state: "succeeded" })
    expect(core.m.api.filter((call) => call.url.includes("/trade/agent/build")).length).toBe(1)
    // Still a read with trading turned off; the same id with other params is a conflict.
    await core.view?.request("settings.set", { path: "trading", value: false })
    expect(
      (await h.call("candle_trade", { mint: MINT, side: "buy", amount: "0.1", clientTradeId })).body,
    ).toMatchObject({
      state: "succeeded",
    })
    expect((await h.call("candle_trade", { mint: MINT, side: "buy", amount: "9", clientTradeId })).body).toMatchObject({
      error: { code: "OP_ID_CONFLICT" },
    })
  })

  test("T-19, kind swap: a swap the core issued is read by get_operation, never a 404; a foreign swap id is not held", async () => {
    const core = await startCore()
    await turnOn(core)
    const h = await harnessClient(core)
    const answer = await h.call("candle_swap", { from: "SOL", to: "USDC", amount: "1" })
    expect(answer.body).toMatchObject({ error: { code: "APPROVAL_REQUIRED" }, kind: "swap" })
    const clientSwapId = answer.body.clientSwapId as string
    expect((await h.call("candle_get_operation", { clientId: clientSwapId, kind: "swap" })).body).toMatchObject({
      state: "awaiting_approval",
      kind: "swap",
    })
    expect((await h.call("candle_get_operation", { clientId: "not-ours", kind: "swap" })).body).toMatchObject({
      error: { code: "OPERATION_NOT_HELD" },
    })
  })

  test("invariant 6 / A-2: naming a held id reads that card whoever proposed it (pinned, accepted residual risk)", async () => {
    const core = await startCore()
    await turnOn(core)
    const a = await harnessClient(core)
    const b = await harnessClient(core)
    const clientSwapId = "swap-a-1"
    const proposed = await a.call("candle_swap", { from: "SOL", to: "USDC", amount: "1", clientSwapId })
    expect(proposed.body).toMatchObject({ error: { code: "APPROVAL_REQUIRED" } })
    expect((await b.call("candle_get_operation", { clientId: clientSwapId, kind: "swap" })).body).toMatchObject({
      state: "awaiting_approval",
      kind: "swap",
    })
    const resend = await b.call("candle_swap", { from: "SOL", to: "USDC", amount: "1", clientSwapId })
    expect(resend.body).toMatchObject({ error: { code: "APPROVAL_REQUIRED" }, clientSwapId })
    const different = await b.call("candle_swap", { from: "SOL", to: "USDC", amount: "2", clientSwapId })
    expect(different.body).toMatchObject({ error: { code: "OP_ID_CONFLICT" } })
  })

  test("T-11: reads and paper raise no card; paper needs trading on and a paper window; the server's refusal is journaled", async () => {
    const core = await startCore()
    await core.view?.request("subscribe", { topics: ["cards"] })
    const h = await harnessClient(core)
    const paper = { mint: MINT, side: "buy", amount: "0.1", paper: true }
    expect((await h.call("candle_trade", paper)).body).toMatchObject({ error: { code: "TRADING_OFF" } })
    const read = await h.call("candle_get_market", { chain: "solana", mint: MINT })
    expect(read.body).toMatchObject({ success: true })
    await h.call("candle_get_portfolio", {})
    // Before trading on, the plain key is still the profile's own; the core uses it for reads only.
    expect(core.m.api.filter((call) => call.url.includes("portfolio")).at(-1)?.key).toBe(WRITE_KEY)
    await turnOn(core)
    expect((await h.call("candle_trade", paper)).body).toMatchObject({ error: { code: "PAPER_WINDOW_REQUIRED" } })
    await core.view?.request("settings.set", { path: "paperWindow", value: { minutes: 5 }, factor: core.factor })
    const ran = await h.call("candle_trade", paper)
    expect(ran.body).toMatchObject({ api: { success: true, paper: true } })
    const build = core.m.api.filter((call) => call.url.includes("/trade/agent/build")).at(-1)
    expect(build?.key).toBe(WRITE_KEY)
    // After trading on, reads use the minted Read key.
    await h.call("candle_get_portfolio", {})
    expect(core.m.api.filter((call) => call.url.includes("portfolio")).at(-1)?.key).toBe(READ_KEY)
    // The kill switch: the server refuses paper too, and that refusal is a paper row.
    core.m.respond.current = (call) =>
      call.url.includes("/trade/agent/build")
        ? Response.json(
            { success: false, error: { code: "AGENT_TRADING_DISABLED", message: "Agent trading is paused" } },
            { status: 503 },
          )
        : defaultRespond(call)
    expect((await h.call("candle_trade", paper)).isError).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const cardEvents = core.view?.events.filter((e) => e.topic === "cards" && !e.snapshot) ?? []
    expect(cardEvents).toEqual([])
    const rows = (await readJournal(core.paths.journal)).rows
    const paperRows = rows.filter((row) => row.type === "paper.call")
    expect(paperRows.map((row) => row.mode)).toEqual(["paper", "paper"])
    expect(paperRows.at(-1)).toMatchObject({ isError: true })
    expect(JSON.stringify(paperRows)).toContain("AGENT_TRADING_DISABLED")
  })

  test("T-18: a core started without the TUI permits only paper and reads, and restores no window", async () => {
    const first = await startCore()
    await turnOn(first)
    const h = await harnessClient(first)
    await first.view?.request("settings.set", { path: "paperWindow", value: { minutes: 5 }, factor: first.factor })
    await first.view?.request("settings.set", { path: "window", value: { minutes: 5 }, factor: first.factor })
    const proposedBefore = { mint: MINT, side: "buy", amount: "0.3" }
    const heldId = (await h.call("candle_trade", proposedBefore)).body.clientTradeId as string
    await first.stop()

    // A harness starts the core itself: no view token, so no view can attach.
    const second = await startCore(first.m, { view: false })
    const again = await harnessClient(second, h.token)
    // A held id from the last run is still answered with its state, view or no view (A-5, R-4).
    const held = (await again.call("candle_trade", { ...proposedBefore, clientTradeId: heldId })).body
    expect(held).toMatchObject({ error: { code: "CARD_EXPIRED" }, state: "expired", clientTradeId: heldId })
    // The raw RPC path answers the same way: a held id needs no view.
    const raw = await connectCore({ socketPath: second.paths.socket, token: h.token, clientName: "raw" })
    try {
      const card = await raw.connection.request<{ opId: string; state: string }>("cards.propose", {
        tool: "candle_trade",
        params: { ...proposedBefore, clientTradeId: heldId },
      })
      expect(card).toMatchObject({ opId: heldId, state: "expired" })
      await expect(
        raw.connection.request("cards.propose", {
          tool: "candle_trade",
          params: { ...proposedBefore, clientTradeId: "fresh" },
        }),
      ).rejects.toMatchObject({ code: "NO_VIEW_ATTACHED" })
    } finally {
      raw.connection.close()
    }
    expect((await again.call("candle_trade", { mint: MINT, side: "buy", amount: "0.1" })).body).toMatchObject({
      error: { code: "NO_VIEW_ATTACHED" },
    })
    expect(
      (await again.call("candle_trade", { mint: MINT, side: "buy", amount: "0.1", paper: true })).body,
    ).toMatchObject({
      error: { code: "PAPER_WINDOW_REQUIRED" },
    })
    expect((await again.call("candle_get_market", { chain: "solana", mint: MINT })).body).toMatchObject({
      success: true,
    })
    await again.call("candle_get_portfolio", {})
    expect(second.m.api.filter((call) => call.url.includes("portfolio")).at(-1)?.key).toBe(READ_KEY)
  })
})

/** One tools.call straight to the core, past the MCP schema, as a harness that ignores tools/list would. */
async function harnessClientCall(
  core: Awaited<ReturnType<typeof startCore>>,
  token: string,
  name: string,
  args: Record<string, unknown>,
) {
  const { connection } = await connectCore({ socketPath: core.paths.socket, token, clientName: "raw" })
  try {
    const result = await connection.request<{ content: { text: string }[] }>("tools.call", { name, args })
    return JSON.parse(result.content[0]?.text ?? "null")
  } finally {
    connection.close()
  }
}

describe("candle core mcp, the command", () => {
  test("needs a harness token, and says so when the core is not running", async () => {
    const made = await makeVault()
    closeVault(made.vault)
    cleanups.push(() => rm(made.dir, { recursive: true, force: true }))
    const stderr = createCapture()
    const deps = createTestDeps({
      fetch: (async () => new Response("{}")) as unknown as typeof fetch,
      env: { CANDLE_CONFIG_DIR: made.dir },
      homedir: () => made.dir,
      stderr,
    })
    const ctx: CommandContext = {
      deps,
      json: false,
      apiUrl: "https://staging.api.candle.tv",
      profile: "staging",
      verifyAccount: true,
    }
    expect(await coreMcp([], ctx)).toBe(2)
    expect(await coreMcp(["--token", "cht_nothing_here"], ctx)).toBe(1)
    expect(stderr.text).toContain("CORE_NOT_RUNNING")
    // The token may come from the environment instead of the process list.
    const fromEnv = { ...ctx, deps: { ...deps, env: { ...deps.env, CANDLE_CORE_TOKEN: "cht_from_env" } } }
    expect(await coreMcp([], fromEnv)).toBe(1)
  })
})
