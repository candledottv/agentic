/**
 * `candle mcp`, driven through `run()`: the launcher that hands the CLI's stored credentials to
 * the published MCP server (CLI P0 plan, Task 2). The child process is never actually spawned:
 * `deps.runChild` is the injected seam, and every test asserts the exact command, args, and env
 * the launcher would run.
 */

import { describe, expect, test } from "bun:test"
import { run } from "../index"
import { createCapture, createFakeStore, createRoutedFetch, createTestDeps } from "../test-support"
import { MCP_TOOL_NAMES, READ_ONLY_TOOL_NAMES } from "./mcp"

interface CapturedChild {
  command: string
  args: string[]
  env: Record<string, string | undefined>
}

function captureRunChild(exitCode = 0): {
  calls: CapturedChild[]
  runChild: (c: string, a: string[], e: Record<string, string | undefined>) => Promise<number>
} {
  const calls: CapturedChild[] = []
  return {
    calls,
    runChild: async (command, args, env) => {
      calls.push({ command, args, env })
      return exitCode
    },
  }
}

describe("mcp", () => {
  test("launches npx @candledottv/mcp with the stored key and resolved API URL in the child env", async () => {
    const { fetch } = createRoutedFetch({})
    const { calls, runChild } = captureRunChild(0)
    const store = createFakeStore({ api_key: "cndl_live_secret" })
    const stderr = createCapture()
    const code = await run(["mcp"], createTestDeps({ fetch, store, runChild, stderr }))

    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe("npx")
    expect(calls[0]?.args).toEqual(["--yes", "@candledottv/mcp"])
    expect(calls[0]?.env.CANDLE_AGENT_API_KEY).toBe("cndl_live_secret")
    expect(calls[0]?.env.CANDLE_API_URL).toBe("https://api.alpha.candle.tv")
    expect(calls[0]?.env.CANDLE_MCP_TOOLS).toBeUndefined()
    // The startup note goes to stderr: under MCP the child owns stdout for the protocol.
    expect(stderr.text).toContain("@candledottv/mcp")
  })

  test("the child's exit code is the command's exit code", async () => {
    const { fetch } = createRoutedFetch({})
    const { runChild } = captureRunChild(3)
    const store = createFakeStore({ api_key: "cndl_live_secret" })
    const code = await run(["mcp"], createTestDeps({ fetch, store, runChild }))
    expect(code).toBe(3)
  })

  test("--read-only launches with NO key and the four keyless read tools pinned", async () => {
    const { fetch } = createRoutedFetch({})
    const { calls, runChild } = captureRunChild(0)
    // A stored key exists; --read-only must still not hand it to the child.
    const store = createFakeStore({ api_key: "cndl_live_secret" })
    const code = await run(["mcp", "--read-only"], createTestDeps({ fetch, store, runChild }))

    expect(code).toBe(0)
    expect(calls[0]?.env.CANDLE_AGENT_API_KEY).toBeUndefined()
    expect(calls[0]?.env.CANDLE_MCP_TOOLS).toBe(READ_ONLY_TOOL_NAMES.join(","))
  })

  test("--tools passes a validated allowlist through CANDLE_MCP_TOOLS", async () => {
    const { fetch } = createRoutedFetch({})
    const { calls, runChild } = captureRunChild(0)
    const store = createFakeStore({ api_key: "cndl_live_secret" })
    const code = await run(
      ["mcp", "--tools", "candle_get_market, candle_trade"],
      createTestDeps({ fetch, store, runChild }),
    )
    expect(code).toBe(0)
    expect(calls[0]?.env.CANDLE_MCP_TOOLS).toBe("candle_get_market,candle_trade")
  })

  test("an unknown tool name is a usage error, exit 2, naming the valid tools, with no child launched", async () => {
    const { fetch } = createRoutedFetch({})
    const { calls, runChild } = captureRunChild(0)
    const store = createFakeStore({ api_key: "cndl_live_secret" })
    const stderr = createCapture()
    const code = await run(
      ["mcp", "--tools", "candle_get_market,candle_frobnicate"],
      createTestDeps({ fetch, store, runChild, stderr }),
    )
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(stderr.text).toContain("candle_frobnicate")
    for (const name of MCP_TOOL_NAMES) expect(stderr.text).toContain(name)
  })

  test("--read-only with --tools is a usage error: read-only IS a tool selection", async () => {
    const { fetch } = createRoutedFetch({})
    const { calls, runChild } = captureRunChild(0)
    const code = await run(["mcp", "--read-only", "--tools", "candle_get_market"], createTestDeps({ fetch, runChild }))
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })

  test("no stored key and not --read-only: exits 1 with the auth-login suggestion, no child launched", async () => {
    const { fetch } = createRoutedFetch({})
    const { calls, runChild } = captureRunChild(0)
    const stdout = createCapture()
    const code = await run(["mcp", "--json"], createTestDeps({ fetch, runChild, stdout }))
    expect(code).toBe(1)
    expect(calls).toHaveLength(0)
    expect(JSON.parse(stdout.text)).toEqual({
      ok: false,
      code: "NO_API_KEY",
      message: "No API key available.",
      suggestion: "Run: candle auth login",
    })
  })

  test("--print-config prints the ready-to-paste client block, launches nothing, needs no key", async () => {
    const { fetch } = createRoutedFetch({})
    const { calls, runChild } = captureRunChild(0)
    const stdout = createCapture()
    const code = await run(["mcp", "--print-config", "--read-only"], createTestDeps({ fetch, runChild, stdout }))
    expect(code).toBe(0)
    expect(calls).toHaveLength(0)
    expect(JSON.parse(stdout.text)).toEqual({
      mcpServers: { candle: { command: "candle", args: ["mcp", "--read-only"] } },
    })
  })

  test("the tool-name mirror stays in sync with packages/mcp's own TOOL_NAMES (drift guard)", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs")
    const path = require("node:path") as typeof import("node:path")
    const toolsSource = readFileSync(path.join(import.meta.dir, "../../../mcp/src/tools.ts"), "utf-8")
    for (const name of MCP_TOOL_NAMES) {
      expect(toolsSource).toContain(`"${name}"`)
    }
    // And nothing registered over there is missing here.
    // tools.ts routes every registration through its local `register(` guard (the
    // CANDLE_MCP_TOOLS filter), so that call form -- not server.registerTool( -- is the source
    // of truth for what registers.
    const registered = [...toolsSource.matchAll(/\n {2}register\(\s*\n?\s*"(candle_[a-z_]+)"/g)].map((m) => m[1])
    expect(new Set(registered)).toEqual(new Set(MCP_TOOL_NAMES))
  })
})
