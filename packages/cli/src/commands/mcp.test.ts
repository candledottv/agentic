/**
 * `candle mcp`, driven through `run()`: the command that starts the bundled MCP server with the
 * CLI's stored credentials. No server is ever actually started: `deps.runMcpServer` is the
 * injected seam, and every test asserts the exact environment the server would receive.
 *
 * That seam used to be `runChild`, spawning `npx --yes @candledottv/mcp`. The server is bundled
 * into the binary now, so there is no command, no args and no child process to assert -- only the
 * environment, which is where every property these tests care about lives.
 */

import { describe, expect, test } from "bun:test"
import { run } from "../index"
import {
  createCapture,
  createFakeConfigStore,
  createFakeStore,
  createRoutedFetch,
  createTestDeps,
} from "../test-support"
import { MCP_TOOL_NAMES, READ_ONLY_TOOL_NAMES } from "./mcp"

interface CapturedStart {
  env: Record<string, string | undefined>
}

/** Captures the environment the server would be started with. `fail` makes the start throw, the
 * in-process equivalent of the old child exiting non-zero. */
function captureMcpServer(fail?: Error): {
  calls: CapturedStart[]
  runMcpServer: (env: Record<string, string | undefined>) => Promise<void>
} {
  const calls: CapturedStart[] = []
  return {
    calls,
    runMcpServer: async (env) => {
      calls.push({ env })
      if (fail) throw fail
    },
  }
}

const unusedFetch = (() => {
  throw new Error("fetch should not be called for this test")
}) as unknown as typeof fetch

describe("mcp", () => {
  test("starts the bundled server with the stored key and resolved API URL in its environment", async () => {
    const { fetch } = createRoutedFetch({})
    const { calls, runMcpServer } = captureMcpServer()
    const store = createFakeStore({ api_key: "cndl_live_secret" })
    const stderr = createCapture()
    const code = await run(["mcp"], createTestDeps({ fetch, store, runMcpServer, stderr }))

    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.env.CANDLE_AGENT_API_KEY).toBe("cndl_live_secret")
    expect(calls[0]?.env.CANDLE_API_URL).toBe("https://api.alpha.candle.tv")
    expect(calls[0]?.env.CANDLE_MCP_TOOLS).toBeUndefined()
    // The startup note goes to stderr: under MCP the protocol owns stdout, which is now this
    // process's own stdout rather than a child's.
    expect(stderr.text).toContain("Candle MCP server")
  })

  test("a server that fails to start exits 1 and says why, instead of reporting success", async () => {
    const { fetch } = createRoutedFetch({})
    const { runMcpServer } = captureMcpServer(new Error("transport unavailable"))
    const store = createFakeStore({ api_key: "cndl_live_secret" })
    const stderr = createCapture()
    const code = await run(["mcp"], createTestDeps({ fetch, store, runMcpServer, stderr }))
    expect(code).toBe(1)
    expect(stderr.text).toContain("transport unavailable")
  })

  test("--read-only launches with NO key and the four keyless read tools pinned", async () => {
    const { fetch } = createRoutedFetch({})
    const { calls, runMcpServer } = captureMcpServer()
    // A stored key exists; --read-only must still not hand it to the child.
    const store = createFakeStore({ api_key: "cndl_live_secret" })
    const code = await run(["mcp", "--read-only"], createTestDeps({ fetch, store, runMcpServer }))

    expect(code).toBe(0)
    expect(calls[0]?.env.CANDLE_AGENT_API_KEY).toBeUndefined()
    expect(calls[0]?.env.CANDLE_MCP_TOOLS).toBe(READ_ONLY_TOOL_NAMES.join(","))
  })

  test("--read-only strips every inherited Candle credential from the child env", async () => {
    const { fetch } = createRoutedFetch({})
    const { calls, runMcpServer } = captureMcpServer()
    // The leak this closes: the child env was built by spreading the parent's, so a credential
    // that was merely PRESENT in the environment reached a server advertised as keyless. Resolving
    // the key to undefined was never enough on its own.
    const env = {
      CANDLE_API_KEY: "cndl_live_ambient",
      CANDLE_AGENT_API_KEY: "cndl_live_agent",
      CANDLE_DEVICE_TOKEN: "device_token_ambient",
      CANDLE_KEYRING_PASSPHRASE: "passphrase_ambient",
      PATH: "/usr/bin",
    }
    const code = await run(["mcp", "--read-only"], createTestDeps({ fetch, runMcpServer, env }))

    expect(code).toBe(0)
    expect(calls[0]?.env.CANDLE_API_KEY).toBeUndefined()
    expect(calls[0]?.env.CANDLE_AGENT_API_KEY).toBeUndefined()
    expect(calls[0]?.env.CANDLE_DEVICE_TOKEN).toBeUndefined()
    expect(calls[0]?.env.CANDLE_KEYRING_PASSPHRASE).toBeUndefined()
    // Non-credential inherited environment still reaches the server: PATH, HOME and the rest.
    expect(calls[0]?.env.PATH).toBe("/usr/bin")
  })

  test("a normal launch passes only the resolved key, never an ambient one", async () => {
    const { fetch } = createRoutedFetch({})
    const { calls, runMcpServer } = captureMcpServer()
    const store = createFakeStore({ api_key: "cndl_live_from_store" })
    // An ambient CANDLE_AGENT_API_KEY must not survive next to the resolved key: whichever the
    // child preferred, the identity line the user just read would be describing a different one.
    const env = { CANDLE_AGENT_API_KEY: "cndl_live_stale", CANDLE_KEYRING_PASSPHRASE: "passphrase_ambient" }
    const code = await run(["mcp"], createTestDeps({ fetch, store, runMcpServer, env }))

    expect(code).toBe(0)
    expect(calls[0]?.env.CANDLE_AGENT_API_KEY).toBe("cndl_live_from_store")
    expect(calls[0]?.env.CANDLE_KEYRING_PASSPHRASE).toBeUndefined()
  })

  test("an inherited CANDLE_MCP_TOOLS cannot widen what --read-only pinned", async () => {
    const { fetch } = createRoutedFetch({})
    const { calls, runMcpServer } = captureMcpServer()
    const env = { CANDLE_MCP_TOOLS: MCP_TOOL_NAMES.join(",") }
    const code = await run(["mcp", "--read-only"], createTestDeps({ fetch, runMcpServer, env }))

    expect(code).toBe(0)
    expect(calls[0]?.env.CANDLE_MCP_TOOLS).toBe(READ_ONLY_TOOL_NAMES.join(","))
  })

  test("--tools passes a validated allowlist through CANDLE_MCP_TOOLS", async () => {
    const { fetch } = createRoutedFetch({})
    const { calls, runMcpServer } = captureMcpServer()
    const store = createFakeStore({ api_key: "cndl_live_secret" })
    const code = await run(
      ["mcp", "--tools", "candle_get_market, candle_trade"],
      createTestDeps({ fetch, store, runMcpServer }),
    )
    expect(code).toBe(0)
    expect(calls[0]?.env.CANDLE_MCP_TOOLS).toBe("candle_get_market,candle_trade")
  })

  test("an unknown tool name is a usage error, exit 2, naming the valid tools, with no child launched", async () => {
    const { fetch } = createRoutedFetch({})
    const { calls, runMcpServer } = captureMcpServer()
    const store = createFakeStore({ api_key: "cndl_live_secret" })
    const stderr = createCapture()
    const code = await run(
      ["mcp", "--tools", "candle_get_market,candle_frobnicate"],
      createTestDeps({ fetch, store, runMcpServer, stderr }),
    )
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(stderr.text).toContain("candle_frobnicate")
    for (const name of MCP_TOOL_NAMES) expect(stderr.text).toContain(name)
  })

  test("--read-only with --tools is a usage error: read-only IS a tool selection", async () => {
    const { fetch } = createRoutedFetch({})
    const { calls, runMcpServer } = captureMcpServer()
    const code = await run(
      ["mcp", "--read-only", "--tools", "candle_get_market"],
      createTestDeps({ fetch, runMcpServer }),
    )
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })

  test("no stored key and not --read-only: exits 1 with the auth-login suggestion, no child launched", async () => {
    const { fetch } = createRoutedFetch({})
    const { calls, runMcpServer } = captureMcpServer()
    const stdout = createCapture()
    const code = await run(["mcp", "--json"], createTestDeps({ fetch, runMcpServer, stdout }))
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
    const { calls, runMcpServer } = captureMcpServer()
    const stdout = createCapture()
    const code = await run(["mcp", "--print-config", "--read-only"], createTestDeps({ fetch, runMcpServer, stdout }))
    expect(code).toBe(0)
    expect(calls).toHaveLength(0)
    expect(JSON.parse(stdout.text)).toEqual({
      mcpServers: {
        candle: {
          command: "/usr/local/bin/node",
          args: ["/usr/local/lib/node_modules/@candledottv/cli/dist/index.js", "mcp", "--read-only"],
        },
      },
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

describe("mcp --print-config uses an absolute command", () => {
  test("a compiled binary names its own path", async () => {
    const stdout = createCapture()
    const deps = createTestDeps({ fetch: unusedFetch, stdout, execPath: "/Users/a/.local/bin/candle" })
    expect(await run(["mcp", "--print-config", "--read-only"], deps)).toBe(0)
    const block = JSON.parse(stdout.text)
    expect(block.mcpServers.candle).toEqual({ command: "/Users/a/.local/bin/candle", args: ["mcp", "--read-only"] })
  })
  test("a Homebrew install names the opt link that survives brew upgrade", async () => {
    const stdout = createCapture()
    const deps = createTestDeps({
      fetch: unusedFetch,
      stdout,
      execPath: "/opt/homebrew/bin/candle",
      realpath: async () => "/opt/homebrew/Cellar/candle/0.6.0/bin/candle",
    })
    expect(await run(["mcp", "--print-config"], deps)).toBe(0)
    expect(JSON.parse(stdout.text).mcpServers.candle.command).toBe("/opt/homebrew/opt/candle/bin/candle")
  })
  test("a script install names node and the script, so a GUI host needs no PATH", async () => {
    const stdout = createCapture()
    const deps = createTestDeps({
      fetch: unusedFetch,
      stdout,
      execPath: "/usr/local/bin/node",
      argv1: "/usr/local/lib/node_modules/@candledottv/cli/dist/index.js",
    })
    expect(await run(["mcp", "--print-config"], deps)).toBe(0)
    expect(JSON.parse(stdout.text).mcpServers.candle).toEqual({
      command: "/usr/local/bin/node",
      args: ["/usr/local/lib/node_modules/@candledottv/cli/dist/index.js", "mcp"],
    })
  })
})

describe("profiles", () => {
  test("--print-config prints the identity line to stderr, using the profile's cached account, and stdout stays pure JSON", async () => {
    const { fetch } = createRoutedFetch({})
    const { calls, runMcpServer } = captureMcpServer()
    const store = createFakeStore({ "profile:staging:api_key": "cndl_live_secret" })
    const config = createFakeConfigStore({ profiles: { staging: { account: "A" } }, activeProfile: "staging" })
    const stdout = createCapture()
    const stderr = createCapture()
    const code = await run(
      ["mcp", "--print-config", "--read-only"],
      createTestDeps({ fetch, runMcpServer, stdout, stderr, store, ...config }),
    )
    expect(code).toBe(0)
    expect(calls).toHaveLength(0)
    expect(stderr.text).toContain("Profile: staging   Account: A at ")
    expect(JSON.parse(stdout.text)).toEqual({
      mcpServers: {
        candle: {
          command: "/usr/local/bin/node",
          args: ["/usr/local/lib/node_modules/@candledottv/cli/dist/index.js", "mcp", "--read-only"],
        },
      },
    })
  })

  test("the stderr identity line names an acting env override rather than the profile's cached account", async () => {
    // The server the launcher is about to start would run on the OVERRIDE's key, so naming the
    // profile's cached account here would misreport which account the MCP client is wired to.
    const { fetch } = createRoutedFetch({})
    const { calls, runMcpServer } = captureMcpServer()
    const config = createFakeConfigStore({ profiles: { staging: { account: "A" } }, activeProfile: "staging" })
    const stderr = createCapture()
    const code = await run(
      ["mcp"],
      createTestDeps({ fetch, runMcpServer, stderr, env: { CANDLE_API_KEY: "cndl_live_from_env" }, ...config }),
    )
    expect(code).toBe(0)
    expect(calls[0]?.env.CANDLE_AGENT_API_KEY).toBe("cndl_live_from_env")
    expect(stderr.text).toContain("Account: unknown (CANDLE_API_KEY override)")
    expect(stderr.text).not.toContain("Account: A")
  })
})
