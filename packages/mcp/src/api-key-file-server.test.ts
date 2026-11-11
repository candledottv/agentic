import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { resolveConfig } from "./client"
import { createCandleMcpServer, runStdioServer } from "./server"
import { PROFILE_EDIT_TOOL_NAMES, registerEligibleProfileTool } from "./tools"

test("standalone aliases, file exclusivity, blanks and no-key compatibility", () => {
  const base = { CANDLE_API_URL: "http://127.0.0.1:1234" }
  expect(resolveConfig({ ...base, CANDLE_API_KEY: " cli ", CANDLE_AGENT_API_KEY: " mcp " }).apiKey).toBe("mcp")
  expect(resolveConfig({ ...base, CANDLE_API_KEY_FILE: " \t ", CANDLE_API_KEY: " cli " }).apiKey).toBe("cli")
  expect(resolveConfig(base).apiKey).toBeUndefined()
  expect(() => resolveConfig({ ...base, CANDLE_API_KEY_FILE: "/absent", CANDLE_AGENT_API_KEY: "raw" })).toThrow(
    "conflicts",
  )
})

test("server snapshots survive file replacement/removal, tool calls and late eligibility; servers are independent", async () => {
  const first = "synthetic-first-key",
    second = "synthetic-second-key"
  const dir = mkdtempSync(join(tmpdir(), "candle-mcp-key-")),
    path = join(dir, "key")
  const seen: boolean[] = []
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      seen.push(request.headers.get("x-api-key") === first)
      return Response.json({ account: "fixture-B", canEdit: true })
    },
  })
  const clients: Client[] = [],
    servers: ReturnType<typeof createCandleMcpServer>[] = []
  try {
    writeFileSync(path, first, { mode: 0o600 })
    const env = {
      CANDLE_API_KEY_FILE: path,
      CANDLE_API_URL: http.url.origin,
      CANDLE_MCP_TOOLS: `candle_get_agent_profile,${PROFILE_EDIT_TOOL_NAMES.join(",")}`,
    }
    const server = createCandleMcpServer(env)
    servers.push(server)
    writeFileSync(path, second, { mode: 0o600 })
    const other = createCandleMcpServer(env)
    servers.push(other)
    rmSync(path)
    for (const [instance, expected] of [
      [server, first],
      [other, second],
    ] as const) {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      const client = new Client({ name: "file-fixture", version: "1" })
      clients.push(client)
      await instance.connect(serverTransport)
      await client.connect(clientTransport)
      for (let i = 0; i < 2; i++) {
        await registerEligibleProfileTool(instance, env, async (_url, init) => {
          expect(new Headers(init?.headers).get("x-api-key") === expected).toBe(true)
          return Response.json({ canEdit: true })
        })
        expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(PROFILE_EDIT_TOOL_NAMES[0])
        await client.callTool({ name: "candle_get_agent_profile", arguments: { idOrWallet: "fixture" } })
      }
    }
    expect(seen).toEqual([true, true, false, false])
  } finally {
    for (const client of clients) await client.close()
    for (const server of servers) await server.close()
    http.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("invalid file startup sends no discovery and never connects the transport", async () => {
  let started = false
  await expect(
    runStdioServer(
      { CANDLE_API_KEY_FILE: "/missing/synthetic-key", CANDLE_API_URL: "http://127.0.0.1:1234" },
      {
        async start() {
          started = true
        },
        async send() {},
        async close() {},
      },
    ),
  ).rejects.toMatchObject({ code: "API_KEY_FILE_UNREADABLE" })
  expect(started).toBe(false)
})
