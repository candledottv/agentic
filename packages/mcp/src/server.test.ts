/**
 * server.ts: the callable server entry `candle mcp` starts in-process.
 *
 * The property worth pinning is `runStdioServer`'s lifetime. An earlier version resolved as soon
 * as `connect()` returned, which is fine for this package's own bin (a top-level await in an ES
 * module keeps the process alive by itself) and silently fatal for an in-process host: `candle mcp`
 * awaited it, fell through to its own exit, and killed the server before it answered a single
 * request. Only an end-to-end handshake against the compiled binary caught that, so it gets a test
 * here rather than staying an e2e-only property.
 */

import { describe, expect, test } from "bun:test"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { createCandleMcpServer, runStdioServer } from "./server"

/** The smallest thing `server.connect()` accepts: it starts, accepts sends, and can be closed. */
function fakeTransport(): Transport & { closeIt: () => void } {
  const transport: Transport & { closeIt: () => void } = {
    async start() {},
    async send() {},
    async close() {
      transport.onclose?.()
    },
    closeIt() {
      transport.onclose?.()
    },
  }
  return transport
}

const HTTPS_ENV = { CANDLE_API_URL: "https://api.test" }

describe("runStdioServer", () => {
  test("does not resolve while the transport is open, and resolves once it closes", async () => {
    const transport = fakeTransport()
    let resolved = false
    const running = runStdioServer(HTTPS_ENV, transport).then(() => {
      resolved = true
    })

    // Give connect() every chance to settle. If the promise tracked connect() rather than close,
    // this is where it would already be resolved.
    await new Promise((r) => setTimeout(r, 20))
    expect(resolved).toBe(false)

    transport.closeIt()
    await running
    expect(resolved).toBe(true)
  })

  test("an onclose handler is installed once connected, and closing it still completes the run", async () => {
    const transport = fakeTransport()
    const running = runStdioServer(HTTPS_ENV, transport)
    // Wait for connect() to settle before inspecting or closing: the wrapper that resolves the run
    // is installed after it, so closing sooner would race the thing under test.
    await new Promise((r) => setTimeout(r, 20))
    // `connect()` installs the SDK's own handler; the wrapper preserves and calls it rather than
    // replacing it, so a handler is present either way and the close still completes the run.
    expect(typeof transport.onclose).toBe("function")
    transport.closeIt()
    await running
  })
})

describe("createCandleMcpServer", () => {
  test("builds a server named candle-mcp and honors the env it is given, not the ambient one", () => {
    // A bad allowlist throws at registration, which is the observable proof that THIS env was
    // read rather than process.env (which carries no CANDLE_MCP_TOOLS in a test run).
    expect(() => createCandleMcpServer({ ...HTTPS_ENV, CANDLE_MCP_TOOLS: "candle_frobnicate" })).toThrow(
      /unknown tool name/i,
    )
    expect(() => createCandleMcpServer({ ...HTTPS_ENV, CANDLE_MCP_TOOLS: "candle_get_market" })).not.toThrow()
  })

  test("a cleartext API URL in the passed env is refused, the same as for the bin", () => {
    expect(() => createCandleMcpServer({ CANDLE_API_URL: "http://api.candle.tv" })).toThrow(
      /refusing to send credentials in the clear/i,
    )
  })
})
