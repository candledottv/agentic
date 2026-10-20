/**
 * BE-1665 (spec A-1 to A-4): the attach interface. T-2 (roles), T-3 (no secret over the socket)
 * and T-13 (no card without a view) live here.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Journal, readJournal } from "./journal"
import { Redactor } from "./redact"
import { PROTOCOL_VERSION } from "./rpc"
import { CoreServer, METHOD_ROLES } from "./server"
import { connectTestClient, DEVICE_TOKEN, READ_KEY, SIGNER_HALF, type TestClient, WRITE_KEY } from "./test-fixtures"
import { TokenBook } from "./tokens"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function startServer() {
  const dir = await mkdtemp(join(tmpdir(), "candle-srv-"))
  const redactor = new Redactor()
  // As the core does: every value it holds is registered before anything is sent.
  for (const secret of [READ_KEY, WRITE_KEY, DEVICE_TOKEN, SIGNER_HALF]) redactor.add(secret)
  const journal = await Journal.open({
    path: join(dir, "journal.jsonl"),
    redactor,
    environment: "staging",
    profile: "staging",
    now: Date.now,
  })
  const tokens = await TokenBook.open(join(dir, "tokens.json"), Date.now)
  redactor.add(tokens.viewToken)
  const server = new CoreServer({
    socketPath: join(dir, "core.sock"),
    layoutPath: join(dir, "config.json"),
    profile: "staging",
    environment: "staging",
    coreVersion: "0.0.0-test",
    journal,
    redactor,
    tokens,
    now: Date.now,
  })
  await server.listen()
  const clients: TestClient[] = []
  cleanups.push(async () => {
    for (const client of clients) client.close()
    await server.close()
    await journal.close()
    await rm(dir, { recursive: true, force: true })
  })
  const connect = async () => {
    const client = await connectTestClient(join(dir, "core.sock"))
    clients.push(client)
    return client
  }
  const hello = async (token: string, extra: Record<string, unknown> = {}) => {
    const client = await connect()
    const response = await client.request("core.hello", {
      protocol: PROTOCOL_VERSION,
      token,
      clientName: "test",
      ...extra,
    })
    return { client, response }
  }
  const view = async () => {
    const { client, response } = await hello(tokens.viewToken)
    expect(response.error).toBeUndefined()
    return client
  }
  const harness = async (via?: TestClient) => {
    const registrar = via ?? (await view())
    const minted = (await registrar.request("harness.register", { name: "Claude Code" })).result as {
      token: string
      tokenId: string
    }
    const { client, response } = await hello(minted.token, { harnessKind: "claude-code" })
    expect(response.error).toBeUndefined()
    return { client, minted, registrar }
  }
  return { dir, server, journal, tokens, connect, hello, view, harness }
}

/** Polls until `condition` holds (5 s at most): socket delivery has no fixed latency on a CI runner. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(condition()).toBe(true)
}

describe("core.hello", () => {
  test("a view token attaches as view and returns the core's identity", async () => {
    const s = await startServer()
    const { response } = await s.hello(s.tokens.viewToken)
    expect(response.result).toMatchObject({
      protocol: PROTOCOL_VERSION,
      coreVersion: "0.0.0-test",
      profile: "staging",
      environment: "staging",
      tradingOn: false,
      approvalPolicy: "ask",
      role: "view",
    })
    expect(s.server.viewCount()).toBe(1)
  })

  test("a harness token attaches as harness; the role comes from the token, not the claim", async () => {
    const s = await startServer()
    const { client } = await s.harness()
    const status = (await client.request("core.status")).result as { clientCount: number }
    expect(status.clientCount).toBe(2)
    expect(s.server.clients().find((c) => c.role === "harness")).toMatchObject({
      clientName: "test",
      harnessKind: "claude-code",
    })
  })

  test("a different protocol major is refused with both versions, and the connection closes", async () => {
    const s = await startServer()
    const { client, response } = await s.hello(s.tokens.viewToken, { protocol: "2.0" })
    expect(response.error?.data).toEqual({ code: "PROTOCOL_MISMATCH", core: PROTOCOL_VERSION, client: "2.0" })
    await client.closed
  })

  test("an unknown token, and any method before hello, are UNAUTHENTICATED and close", async () => {
    const s = await startServer()
    const bad = await s.hello("chv_not-the-token")
    expect(bad.response.error?.data?.code).toBe("UNAUTHENTICATED")
    await bad.client.closed
    const early = await s.connect()
    expect((await early.request("core.status")).error?.data?.code).toBe("UNAUTHENTICATED")
    await early.closed
    expect(s.server.clients()).toEqual([])
  })

  test("the socket is mode 0600", async () => {
    const s = await startServer()
    expect((await stat(join(s.dir, "core.sock"))).mode & 0o777).toBe(0o600)
  })
})

describe("T-2: role enforcement (A-3)", () => {
  test("for every method, a harness gets FORBIDDEN_FOR_ROLE exactly where the table says no; a view never does", async () => {
    const s = await startServer()
    const viewClient = await s.view()
    const { client: harnessClient } = await s.harness(viewClient)
    const forbidden: string[] = []
    for (const [method, roles] of Object.entries(METHOD_ROLES)) {
      if (method === "core.hello") continue
      const harnessAnswer = await harnessClient.request(method, {})
      const harnessForbidden = harnessAnswer.error?.data?.code === "FORBIDDEN_FOR_ROLE"
      expect(`${method}: ${harnessForbidden}`).toBe(`${method}: ${roles.harness === "no"}`)
      if (harnessForbidden) {
        expect(harnessAnswer.error?.code).toBe(-32001)
        forbidden.push(method)
      }
      // Never kill or revoke the harness under test while sweeping the view's column.
      if (method === "clients.kill" || method === "harness.revoke") continue
      const viewAnswer = await viewClient.request(method, {})
      expect(`${method}: ${viewAnswer.error?.data?.code ?? "ok"}`).not.toBe(`${method}: FORBIDDEN_FOR_ROLE`)
    }
    expect(forbidden.sort()).toEqual(
      Object.entries(METHOD_ROLES)
        .filter(([, roles]) => roles.harness === "no")
        .map(([method]) => method)
        .sort(),
    )
    // Each refusal is a client event in the journal, written before the refusal is sent.
    const rows = (await readJournal(join(s.dir, "journal.jsonl"))).rows.filter((row) => row.type === "call.forbidden")
    expect(rows.map((row) => row.method).sort()).toEqual(forbidden.sort())
  })

  test("a method that is not in the table does not exist", async () => {
    const s = await startServer()
    const viewClient = await s.view()
    expect((await viewClient.request("cards.approveAll")).error).toMatchObject({
      code: -32601,
      data: { code: "METHOD_NOT_FOUND" },
    })
    expect((await viewClient.request("toString")).error?.data?.code).toBe("METHOD_NOT_FOUND")
  })

  test("a harness may not subscribe to clients; it may subscribe to status", async () => {
    const s = await startServer()
    const { client } = await s.harness()
    expect((await client.request("subscribe", { topics: ["clients"] })).error?.data?.code).toBe("FORBIDDEN_FOR_ROLE")
    expect((await client.request("subscribe", { topics: ["status"] })).result).toEqual({ topics: ["status"] })
    expect((await client.request("subscribe", { topics: ["nonsense"] })).error?.data?.code).toBe("INVALID_PARAMS")
  })
})

describe("T-13: no card without a view (C-3)", () => {
  test("with every view detached, cards.propose is NO_VIEW_ATTACHED; with one attached it reaches the card layer", async () => {
    const s = await startServer()
    const { client: harnessClient, registrar } = await s.harness()
    expect((await harnessClient.request("cards.propose", { kind: "trade", params: {} })).error?.data?.code).toBe(
      "METHOD_NOT_AVAILABLE",
    )
    registrar.close()
    await until(() => s.server.viewCount() === 0)
    expect((await harnessClient.request("cards.propose", { kind: "trade", params: {} })).error?.data?.code).toBe(
      "NO_VIEW_ATTACHED",
    )
    const rows = (await readJournal(join(s.dir, "journal.jsonl"))).rows
    expect(rows.some((row) => row.type === "call.refused" && row.code === "NO_VIEW_ATTACHED")).toBe(true)
  })
})

describe("T-3: no secret over the socket (invariant 2)", () => {
  test("every frame of every method, from both roles, carries no stored secret and never the view token", async () => {
    const s = await startServer()
    // A handler that tries to leak, as an upstream error with a key in it would.
    s.server.handle("tools.call", async () => {
      throw new Error(`upstream 500 for ${WRITE_KEY} with token ${DEVICE_TOKEN}`)
    })
    s.server.handle("tools.list", async () => ({
      readKey: READ_KEY,
      signer: SIGNER_HALF,
      url: "https://x/?api-key=secret123456",
    }))
    const viewClient = await s.view()
    const { client: harnessClient, minted } = await s.harness(viewClient)
    await viewClient.request("subscribe", { topics: ["status", "clients", "cards", "operations"] })
    await harnessClient.request("subscribe", { topics: ["status", "portfolio", "cards"] })
    for (const method of Object.keys(METHOD_ROLES)) {
      if (method === "core.hello" || method === "clients.kill" || method === "harness.revoke") continue
      await viewClient.request(method, { name: "probe", layout: { preset: "C" }, topics: ["status"] })
      await harnessClient.request(method, { topics: ["status"] })
    }
    s.server.events.publish("cards", { error: `failed with ${WRITE_KEY}` })
    await until(() => viewClient.events.some((e) => e.topic === "cards" && !e.snapshot))
    const frames = [...viewClient.frames, ...harnessClient.frames]
    expect(frames.length).toBeGreaterThan(40)
    for (const secret of [READ_KEY, WRITE_KEY, DEVICE_TOKEN, SIGNER_HALF, s.tokens.viewToken, "secret123456"]) {
      expect(frames.filter((frame) => frame.includes(secret))).toEqual([])
    }
    // The one token a method returns is the harness token just minted, once, to the view that asked.
    const carrying = frames.filter((frame) => frame.includes(minted.token))
    expect(carrying.length).toBe(1)
    expect(viewClient.frames).toContain(carrying[0] as string)
    // The token book on disk holds hashes only.
    const book = await readFile(join(s.dir, "tokens.json"), "utf8")
    expect(book).not.toContain(minted.token)
    expect((await stat(join(s.dir, "tokens.json"))).mode & 0o777).toBe(0o600)
  })
})

describe("clients.kill and harness.revoke", () => {
  test("killing a harness disconnects it and revokes its token", async () => {
    const s = await startServer()
    const { client: harnessClient, minted, registrar } = await s.harness()
    const harnessId = s.server.clients().find((c) => c.role === "harness")?.clientId
    const killed: string[] = []
    s.server.onClientKilled((client) => killed.push(client.clientId))
    expect((await registrar.request("clients.kill", { clientId: harnessId })).result).toEqual({
      killed: harnessId,
      revokedTokenId: minted.tokenId,
    })
    await harnessClient.closed
    expect(killed).toEqual([harnessId as string])
    expect((await s.hello(minted.token)).response.error?.data?.code).toBe("UNAUTHENTICATED")
  })

  test("revoking a token disconnects every client attached with it", async () => {
    const s = await startServer()
    const { client: harnessClient, minted, registrar } = await s.harness()
    const answer = (await registrar.request("harness.revoke", { tokenId: minted.tokenId })).result as {
      disconnected: string[]
    }
    expect(answer.disconnected.length).toBe(1)
    await harnessClient.closed
    expect((await registrar.request("harness.revoke", { tokenId: minted.tokenId })).error?.data?.code).toBe(
      "TOKEN_NOT_FOUND",
    )
  })

  test("clients.list shows token ids and names, never hashes or values", async () => {
    const s = await startServer()
    const { registrar, minted } = await s.harness()
    const listed = JSON.stringify((await registrar.request("clients.list")).result)
    expect(listed).toContain(minted.tokenId)
    expect(listed).not.toContain(minted.token)
    expect(listed).not.toContain('"hash"')
  })
})

describe("events (A-4)", () => {
  test("a harness receives its own card events only; a view receives all", async () => {
    const s = await startServer()
    const viewClient = await s.view()
    const a = await s.harness(viewClient)
    const b = await s.harness(viewClient)
    for (const c of [viewClient, a.client, b.client]) await c.request("subscribe", { topics: ["cards"] })
    await until(() =>
      [viewClient, a.client, b.client].every((c) => c.events.some((e) => e.topic === "cards" && e.snapshot)),
    )
    const aId = s.server.clients().filter((c) => c.role === "harness")[0]?.clientId as string
    s.server.events.publish("cards", { cardId: "k1" }, aId)
    s.server.events.publish("cards", { cardId: "k2" })
    await until(() => viewClient.events.filter((e) => e.topic === "cards" && !e.snapshot).length === 2)
    // The harness that must not see k1 has had the same chance to receive it.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const live = (client: TestClient) =>
      client.events.filter((e) => !e.snapshot).map((e) => (e.data as { cardId: string }).cardId)
    expect(live(viewClient)).toEqual(["k1", "k2"])
    const harnessCards = [live(a.client), live(b.client)]
    expect(harnessCards).toContainEqual(["k1"])
    expect(harnessCards).toContainEqual([])
  })

  test("resubscribing with sinceSeq replays held card events; a status subscribe gets a snapshot", async () => {
    const s = await startServer()
    const viewClient = await s.view()
    s.server.events.publish("cards", { cardId: "k1" })
    s.server.events.publish("cards", { cardId: "k2" })
    s.server.events.publish("cards", { cardId: "k3" })
    await viewClient.request("subscribe", { topics: ["cards", "status"], sinceSeq: { cards: 1 } })
    await until(
      () =>
        viewClient.events.some((e) => e.topic === "status") &&
        viewClient.events.filter((e) => e.topic === "cards").length === 2,
    )
    expect(viewClient.events.filter((e) => e.topic === "cards").map((e) => e.seq)).toEqual([2, 3])
    const status = viewClient.events.find((e) => e.topic === "status")
    expect(status?.snapshot).toBe(true)
    expect(status?.data).toMatchObject({ profile: "staging", viewCount: 1 })
  })

  test("view count changes reach listeners and the status topic", async () => {
    const s = await startServer()
    const counts: number[] = []
    s.server.onViewCount((count) => counts.push(count))
    const first = await s.view()
    first.close()
    await until(() => counts.length === 2)
    expect(counts).toEqual([1, 0])
    expect(s.server.hadView()).toBe(true)
  })
})

describe("framing and layout", () => {
  test("a message over 1 MiB is refused without desyncing the stream", async () => {
    const s = await startServer()
    const viewClient = await s.view()
    viewClient.writeRaw(`${"x".repeat(1024 * 1024 + 10)}\n`)
    await until(() => viewClient.frames.some((frame) => frame.includes("MESSAGE_TOO_LARGE")))
    expect((await viewClient.request("core.status")).result).toMatchObject({ viewCount: 1 })
  })

  test("garbage lines get JSON-RPC errors and the connection keeps working", async () => {
    const s = await startServer()
    const viewClient = await s.view()
    viewClient.writeRaw("not json\n")
    viewClient.writeRaw(`${JSON.stringify({ id: 9, method: "core.status" })}\n`)
    await until(() => viewClient.frames.some((frame) => frame.includes('"INVALID_REQUEST"')))
    expect(viewClient.frames.some((frame) => frame.includes('"PARSE_ERROR"'))).toBe(true)
    expect((await viewClient.request("core.status")).error).toBeUndefined()
  })

  test("layout.set persists and layout.get reads it back; the default is preset C", async () => {
    const s = await startServer()
    const viewClient = await s.view()
    expect((await viewClient.request("layout.get")).result).toEqual({ layout: { preset: "C" } })
    await viewClient.request("layout.set", { layout: { preset: "C", tabs: ["holdings"] } })
    expect((await viewClient.request("layout.get")).result).toEqual({ layout: { preset: "C", tabs: ["holdings"] } })
    expect((await viewClient.request("layout.set", { layout: [] })).error?.data?.code).toBe("INVALID_PARAMS")
  })
})
