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
import { TOOL_NAMES } from "./tools"

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

/**
 * The server's own orientation, handed to the client at initialize.
 *
 * Worth pinning for two reasons. It is the ONLY thing a model reads before it starts guessing
 * at fifteen tools, and it names a specific set of no-key tools — a name that drifts out of
 * `TOOL_NAMES` becomes an instruction to call something that does not exist, which is worse
 * than no instruction at all.
 */
describe("server instructions", () => {
  const instructions = (createCandleMcpServer({}) as unknown as { server: { _instructions?: string } }).server
    ._instructions

  test("the server ships orientation, not just tools", () => {
    expect(instructions).toBeTruthy()
    expect(instructions).toContain("START HERE")
  })

  test("every tool the instructions name actually exists", () => {
    const named = [...(instructions ?? "").matchAll(/candle_[a-z_]+/g)].map((m) => m[0])
    expect(named.length).toBeGreaterThan(0)
    for (const name of new Set(named)) {
      expect(TOOL_NAMES).toContain(name as (typeof TOOL_NAMES)[number])
    }
  })

  test("forensics is called out, because a model will not run it unprompted", () => {
    expect(instructions).toContain("candle_token_forensics")
    // "unavailable is not clean" is the one judgement the rail cannot make for the model.
    expect(instructions?.toLowerCase()).toContain("unavailable")
  })

  /*
   * The coverage boundary is load-bearing, and it was found by actually connecting.
   *
   * candle_get_feed indexes external launchpads; candle_get_market answers for same-chain
   * indexed tokens; candle_token_forensics answers for those plus indexed external Hood with
   * unknown hacc flags. Unknown mints can still 404. Without this paragraph a model reads that
   * as a broken integration and either retries, asks the human to re-authenticate, or reports
   * the rail as down. All three are wrong, and all three are what "the agent doesn't understand
   * it" looked like.
   */
  test("the feed/market coverage boundary is explained, and MARKET_NOT_FOUND is not 'clean'", () => {
    expect(instructions).toContain("MARKET_NOT_FOUND")
    expect(instructions).toContain("candle_get_feed")
    // It must say the error is expected rather than a fault, so the model does not retry or re-auth.
    expect(instructions?.toLowerCase()).toContain("coverage boundary")
    // And it must not let that error be read as a pass.
    expect(instructions?.toLowerCase()).toContain("clean bill of health")
  })

  /*
   * Spec C21: the session preamble is a second string from tools.ts. Updating the tool
   * description (or only START HERE) still leaves every session gating on deleted fields
   * if this paragraph is stale. Pin the two lies that were still shipping after the
   * safety-flag rewrite: holder concentration is gone, and indexed external Hood tokens
   * return 200 with unknown hacc flags rather than 404.
   */
  test("INSTRUCTIONS does not promise concentration or Hood-unlaunched indexed 404", () => {
    expect(instructions).toBeTruthy()
    expect(instructions?.toLowerCase()).not.toContain("concentration")
    expect(instructions).not.toMatch(/Hood tokens Candle did not launch[\s\S]{0,120}MARKET_NOT_FOUND/)
    expect(instructions).toContain("Indexed external Hood tokens also answer")
    expect(instructions).toContain("unknown hacc flags")
  })
})
