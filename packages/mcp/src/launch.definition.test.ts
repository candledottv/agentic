import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import {
  launchAndSeedShape,
  launchFieldHelp,
  launchTokenShape,
  MCP_IMAGE_PATH_KEYS,
  MCP_QUOTE_CONTROL_KEYS,
  mcpLaunchFields,
  mcpLaunchTopKeys,
  SEED_LEGACY_KEYS,
  SOCIAL_KEYS,
  TOKEN_LEGACY_KEYS,
} from "./launch-schema"
import type { FetchLike } from "./orchestrate"
import { registerToolSubset, TOOL_NAMES, type ToolName } from "./tools"

const sorted = (values: Iterable<string>) => [...values].sort()
const BASE = { clientLaunchId: "c1", name: "T", symbol: "T", imageUrl: "https://x.example/y.png" }
const FOUR = {
  website: "https://example.com",
  twitter: "https://x.com/candle",
  telegram: "https://t.me/candle",
  discord: "https://discord.gg/candle",
}

function registered(env?: Record<string, string>, fetch?: FetchLike) {
  const tools = new Map<
    string,
    {
      description: string
      rawSchema: unknown
      inputSchema: Record<string, unknown>
      handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>
    }
  >()
  registerToolSubset(
    {
      registerTool(
        name: string,
        config: { description?: string; inputSchema: Record<string, unknown> },
        handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>,
      ) {
        const raw = config.inputSchema as unknown
        const inputSchema = raw instanceof z.ZodObject ? (raw.shape as Record<string, unknown>) : config.inputSchema
        tools.set(name, { description: config.description ?? "", rawSchema: raw, inputSchema, handler })
      },
    } as never,
    {
      tools: ["candle_launch_token", "candle_launch_and_seed"],
      getConfig: () => ({ apiUrl: "https://api.test", apiKey: "cndl_live_k" }),
      ...(env ? { env } : {}),
      ...(fetch ? { fetch } : {}),
    },
  )
  return tools
}

test("shape keys equal the definition's MCP keys plus each tool's legacy keys", () => {
  const defined = mcpLaunchTopKeys()
  expect(sorted(Object.keys(launchTokenShape))).toEqual(
    sorted([...defined, ...TOKEN_LEGACY_KEYS, ...MCP_QUOTE_CONTROL_KEYS]),
  )
  expect(sorted(Object.keys(launchAndSeedShape))).toEqual(
    sorted([...defined, ...SEED_LEGACY_KEYS, ...MCP_QUOTE_CONTROL_KEYS]),
  )
  expect(defined).not.toContain("wallet")
  expect(defined).not.toContain("buy")
  expect(defined).not.toContain("feeWallet")
  expect(defined).not.toContain("feeWalletMultisig")
  expect(defined).not.toContain("hoodGen2Options")
  expect(defined).toContain("snipeExempt")
  expect(defined).toContain("teamAllocation")
  expect(Object.keys(launchTokenShape)).not.toContain("candle_launch")
  expect(TOOL_NAMES).toContain("candle_launch_token")
  expect(TOOL_NAMES).toContain("candle_launch_and_seed")
  expect(TOOL_NAMES as readonly string[]).not.toContain("candle_launch")
})

test("each launch description contains every applicable help sentence", () => {
  const tools = registered()
  for (const name of ["candle_launch_token", "candle_launch_and_seed"] as const) {
    const description = tools.get(name)?.description ?? ""
    for (const field of mcpLaunchFields()) expect(description).toContain(field.help)
  }
  expect(tools.get("candle_launch_token")?.inputSchema.poolOpen).toMatchObject({
    description: launchFieldHelp("poolOpen"),
  })
  expect(tools.get("candle_launch_and_seed")?.inputSchema.expPoolShape).toMatchObject({
    description: launchFieldHelp("expPoolShape"),
  })
})

test("image paths are the named surface-only controls", () => {
  expect([...MCP_IMAGE_PATH_KEYS]).toEqual(["imagePath", "bannerPath"])
  const plain = registered()
  const local = registered({ CANDLE_IMAGE_DIR: "/tmp/candle-images" })
  for (const name of ["candle_launch_token", "candle_launch_and_seed"] as const) {
    const plainKeys = Object.keys(plain.get(name)?.inputSchema ?? {})
    const localKeys = Object.keys(local.get(name)?.inputSchema ?? {})
    for (const key of MCP_IMAGE_PATH_KEYS) {
      expect(plainKeys).not.toContain(key)
      expect(localKeys).toContain(key)
    }
  }
})

test("an unknown socials key is refused locally and the four keys pass", async () => {
  const calls: { url: string; body: unknown }[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, dryRun: true }) }
  }
  const tools = registered(undefined, fetch)
  for (const name of ["candle_launch_token", "candle_launch_and_seed"] as const satisfies readonly ToolName[]) {
    calls.length = 0
    const refused = await tools.get(name)?.handler({ ...BASE, socials: { instagram: "https://example.com" } })
    expect(refused?.isError).toBe(true)
    const body = JSON.parse(refused?.content[0]?.text ?? "{}") as { error?: { code?: string; message?: string } }
    expect(body.error?.code).toBe("VALIDATION_FAILED")
    expect(body.error?.message).toContain(SOCIAL_KEYS.join(", "))
    expect(calls).toEqual([])

    calls.length = 0
    const accepted = await tools.get(name)?.handler({ ...BASE, socials: FOUR, dryRun: true })
    expect(accepted?.isError).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toMatchObject({ socials: FOUR })
    expect(String(calls[0]?.url)).toContain("/launch/headless/dry-run")
  }
})

// BE-2794 (BE-2791 spec 7.1): both launch tools take the nested launchRules object, in seconds
// and raw units, and forward it as given; the API refuses what is out of bounds.
const RULES = {
  openDelaySecs: 600,
  maxBuyPerWalletRaw: "10000000",
  capWindowSecs: 3600,
  allowlist: ["11111111111111111111111111111111"],
  allowlistWindowSecs: 1800,
  devBuyMaxRaw: "5000000",
}

test("launchRules is one nested object with the eight wire fields, each with its help", () => {
  const fullRules = { ...RULES, snipeFeeStartBps: 1500, snipeFeeDecaySecs: 300 }
  const tools = registered()
  for (const name of ["candle_launch_token", "candle_launch_and_seed"] as const) {
    const schema = tools.get(name)?.inputSchema.launchRules as import("zod").ZodTypeAny
    expect(schema.safeParse(RULES).success).toBe(true)
    expect(schema.safeParse(fullRules).success).toBe(true)
    expect(schema.safeParse({ maxBuyPerWalletRaw: 100_000, capWindowSecs: 60, devBuyMaxRaw: 50_000 }).success).toBe(
      true,
    )
    expect(schema.safeParse({ openDelaySecs: 60, snipeFeeStartBps: null, snipeFeeDecaySecs: null }).success).toBe(true)
    expect(schema.safeParse(undefined).success).toBe(true)
    expect(schema.safeParse({ openDelaySecs: "600" }).success).toBe(false)
    expect(schema.safeParse({ maxBuyPerWalletRaw: 1.5, capWindowSecs: 60 }).success).toBe(false)
    expect(schema.safeParse({ allowlist: "one" }).success).toBe(false)
    expect(schema.safeParse({ unknownGen2Key: 1 }).success).toBe(false)
    for (const key of Object.keys(fullRules))
      expect(schema.description).toContain(launchFieldHelp(`launchRules.${key}`))
  }
})

test("both launch tools forward launchRules verbatim, with and without a seed", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, dryRun: true }) }
  }
  const tools = registered(undefined, fetch)
  await tools.get("candle_launch_token")?.handler({ ...BASE, launchRules: RULES, dryRun: true })
  await tools.get("candle_launch_and_seed")?.handler({ ...BASE, launchRules: RULES, dryRun: true })
  await tools.get("candle_launch_and_seed")?.handler({ ...BASE, launchRules: RULES, devBuy: "0.005", dryRun: true })
  expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
    "/api/v1/launch/headless/dry-run",
    "/api/v1/launch/headless/dry-run",
    "/api/v1/launch/atomic/dry-run",
  ])
  for (const call of calls) expect(call.body.launchRules).toEqual(RULES)
  // Without the field, no body carries it.
  calls.length = 0
  await tools.get("candle_launch_token")?.handler({ ...BASE, dryRun: true })
  expect(calls[0]?.body).not.toHaveProperty("launchRules")
})

test("BE-4350: Hood generation 2 options travel as top-level wire keys, feeWallet stays withheld, and Solana refuses Hood-only fields", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, dryRun: true }) }
  }
  const tools = registered(undefined, fetch)
  const hoodArgs = {
    ...BASE,
    chain: "hood",
    dexVersion: "v4",
    launchRules: {
      openDelaySecs: 600,
      maxBuyPerWalletRaw: "10000000000000000",
      capWindowSecs: 3600,
      allowlist: ["0x1111111111111111111111111111111111111111"],
      allowlistWindowSecs: 1800,
      devBuyMaxRaw: "5000000000000000",
      snipeFeeStartBps: 1500,
      snipeFeeDecaySecs: 300,
    },
    snipeExempt: ["0x2222222222222222222222222222222222222222"],
    creatorFeeBps: 150,
    teamAllocation: {
      recipient: "0x3333333333333333333333333333333333333333",
      percent: 2.5,
      cliffDays: 30,
      vestingDays: 365,
    },
    dryRun: true,
  }
  const expectedWire = {
    launchRules: hoodArgs.launchRules,
    snipeExempt: hoodArgs.snipeExempt,
    creatorFeeBps: 150,
    teamAllocation: hoodArgs.teamAllocation,
  }

  for (const name of ["candle_launch_token", "candle_launch_and_seed"] as const) {
    calls.length = 0
    const res = await tools.get(name)?.handler(hoodArgs)
    expect(res?.isError).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toMatchObject(expectedWire)
    expect(calls[0]?.body).not.toHaveProperty("hoodGen2Options")
    expect(calls[0]?.body).not.toHaveProperty("feeWallet")
  }

  // Hood launch with no gen 2 options leaves them absent.
  calls.length = 0
  await tools.get("candle_launch_token")?.handler({ ...BASE, chain: "hood", dexVersion: "v4", dryRun: true })
  for (const key of ["launchRules", "snipeExempt", "creatorFeeBps", "teamAllocation", "hoodGen2Options", "feeWallet"]) {
    expect(calls[0]?.body).not.toHaveProperty(key)
  }

  // Client-side refusals on Solana (including explicit null on Hood-only fields) and on Hood combined-rate overflow.
  const refusals: Record<string, unknown>[] = [
    { ...BASE, teamAllocation: hoodArgs.teamAllocation, dryRun: true },
    { ...BASE, teamAllocation: null, dryRun: true },
    { ...BASE, snipeExempt: hoodArgs.snipeExempt, dryRun: true },
    { ...BASE, snipeExempt: null, dryRun: true },
    { ...BASE, launchRules: { snipeFeeStartBps: 500, snipeFeeDecaySecs: 60 }, dryRun: true },
    { ...BASE, launchRules: { openDelaySecs: 60, snipeFeeStartBps: null }, dryRun: true },
    { ...BASE, launchRules: { openDelaySecs: 60, snipeFeeDecaySecs: null }, dryRun: true },
    { ...BASE, mode: "exp-a", creatorFeeBps: 150, dryRun: true },
    { ...BASE, chain: "hood", dexVersion: "v4", hoodGen2Options: {}, dryRun: true },
    {
      ...BASE,
      chain: "hood",
      dexVersion: "v4",
      creatorFeeBps: 8500,
      launchRules: { snipeFeeStartBps: 1400, snipeFeeDecaySecs: 60 },
      dryRun: true,
    },
  ]
  for (const name of ["candle_launch_token", "candle_launch_and_seed"] as const) {
    for (const bad of refusals) {
      calls.length = 0
      const out = await tools.get(name)?.handler(bad)
      expect(out?.isError).toBe(true)
      const parsed = JSON.parse(out?.content[0]?.text ?? "{}") as { error?: { code?: string } }
      expect(parsed.error?.code).toBe("VALIDATION_FAILED")
      expect(calls).toEqual([])
    }
  }
})

test("BE-4350: real MCP client/server protocol validation refuses nested hoodGen2Options and unknown gen 2 keys with zero HTTP calls", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const server = new McpServer({ name: "launch-protocol-test", version: "1.0.0" })
  registerToolSubset(server, {
    tools: ["candle_launch_token", "candle_launch_and_seed"],
    getConfig: () => ({ apiUrl: "https://api.test", apiKey: "cndl_live_k" }),
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      })
      return Response.json({ success: true, dryRun: true })
    },
  })
  const client = new Client({ name: "launch-protocol-client", version: "1.0.0" })
  const [caller, receiver] = InMemoryTransport.createLinkedPair()
  await server.connect(receiver)
  await client.connect(caller)
  try {
    const badPayloads: [Record<string, unknown>, string][] = [
      [
        {
          ...BASE,
          chain: "hood",
          dexVersion: "v4",
          hoodGen2Options: {
            creatorFeeBps: 150,
            snipeExempt: ["0x2222222222222222222222222222222222222222"],
          },
        },
        "hoodGen2Options",
      ],
      [
        {
          ...BASE,
          chain: "hood",
          dexVersion: "v4",
          hoodGen2Options: { creatorFeeBps: 150 },
          dryRun: true,
        },
        "hoodGen2Options",
      ],
      [
        {
          ...BASE,
          chain: "hood",
          dexVersion: "v4",
          snipeFeeStartBps: 500,
          dryRun: true,
        },
        "snipeFeeStartBps",
      ],
      [
        {
          ...BASE,
          chain: "hood",
          dexVersion: "v4",
          feeWallet: "0x3333333333333333333333333333333333333333",
          dryRun: true,
        },
        "feeWallet",
      ],
      [
        {
          ...BASE,
          chain: "hood",
          dexVersion: "v4",
          launchRules: { hoodGen2Options: { creatorFeeBps: 150 } },
          dryRun: true,
        },
        "hoodGen2Options",
      ],
      [
        {
          ...BASE,
          chain: "hood",
          dexVersion: "v4",
          launchRules: { unknownGen2Key: 1 },
          dryRun: true,
        },
        "unknownGen2Key",
      ],
      [
        {
          ...BASE,
          chain: "hood",
          dexVersion: "v4",
          teamAllocation: {
            recipient: "0x3333333333333333333333333333333333333333",
            percent: 2,
            cliffDays: 30,
            extraGen2Key: true,
          },
          dryRun: true,
        },
        "extraGen2Key",
      ],
    ]

    for (const toolName of ["candle_launch_token", "candle_launch_and_seed"] as const) {
      for (const [args, offendingKey] of badPayloads) {
        calls.length = 0
        const result = await client.callTool({ name: toolName, arguments: args })
        expect(result.isError).toBe(true)
        const text = (result.content as { text: string }[]).map((block) => block.text).join("\n")
        expect(text).toContain(offendingKey)
        expect(calls).toEqual([])
      }

      // Check-mode misplaced and nested gen 2 keys are refused before any preflight GET.
      for (const [checkArgs, offendingKey] of [
        [{ check: true, chain: "hood", snipeFeeStartBps: 500 }, "snipeFeeStartBps"],
        [{ check: true, chain: "hood", hoodGen2Options: { creatorFeeBps: 150 } }, "hoodGen2Options"],
        [{ check: true, chain: "hood", feeWallet: "0x3333333333333333333333333333333333333333" }, "feeWallet"],
        [{ check: true, chain: "hood", launchRules: { unknownGen2Key: 1 } }, "unknownGen2Key"],
        [{ check: true, launchRules: { openDelaySecs: 60, snipeFeeStartBps: null } }, "launchRules.snipeFeeStartBps"],
        [{ check: true, launchRules: { openDelaySecs: 60, snipeFeeDecaySecs: null } }, "launchRules.snipeFeeDecaySecs"],
        [{ check: true, snipeExempt: null }, "snipeExempt"],
        [{ check: true, teamAllocation: null }, "teamAllocation"],
      ] as [Record<string, unknown>, string][]) {
        calls.length = 0
        const refusedCheck = await client.callTool({ name: toolName, arguments: checkArgs })
        expect(refusedCheck.isError).toBe(true)
        const refusedText = (refusedCheck.content as { text: string }[]).map((block) => block.text).join("\n")
        expect(refusedText).toContain(offendingKey)
        expect(calls).toEqual([])
      }

      // Solana Hood-only explicit null fields are refused over MCP protocol with zero HTTP calls.
      for (const [solanaNullArgs, offendingKey] of [
        [{ ...BASE, teamAllocation: null, dryRun: true }, "teamAllocation"],
        [{ ...BASE, snipeExempt: null, dryRun: true }, "snipeExempt"],
        [
          { ...BASE, launchRules: { openDelaySecs: 60, snipeFeeStartBps: null }, dryRun: true },
          "launchRules.snipeFeeStartBps",
        ],
        [
          { ...BASE, launchRules: { openDelaySecs: 60, snipeFeeDecaySecs: null }, dryRun: true },
          "launchRules.snipeFeeDecaySecs",
        ],
      ] as [Record<string, unknown>, string][]) {
        calls.length = 0
        const refusedSolana = await client.callTool({ name: toolName, arguments: solanaNullArgs })
        expect(refusedSolana.isError).toBe(true)
        const refusedSolanaText = (refusedSolana.content as { text: string }[]).map((block) => block.text).join("\n")
        expect(refusedSolanaText).toContain(offendingKey)
        expect(calls).toEqual([])
      }

      // Solana creatorFeeBps: null is accepted and sent (API treats null as 0).
      calls.length = 0
      const solanaNullCreatorFee = await client.callTool({
        name: toolName,
        arguments: { ...BASE, mode: "exp-a", creatorFeeBps: null, dryRun: true },
      })
      expect(solanaNullCreatorFee.isError).not.toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.body).toMatchObject({ mode: "exp-a", creatorFeeBps: null })

      // Valid Hood gen 2 payload with explicit empty snipeExempt, numeric raw amount, and null optional numeric fields passes.
      calls.length = 0
      const okResult = await client.callTool({
        name: toolName,
        arguments: {
          ...BASE,
          chain: "hood",
          dexVersion: "v4",
          creatorFeeBps: null,
          snipeExempt: [],
          launchRules: {
            maxBuyPerWalletRaw: 100_000,
            capWindowSecs: 60,
            snipeFeeStartBps: null,
            snipeFeeDecaySecs: null,
          },
          teamAllocation: {
            recipient: "0x3333333333333333333333333333333333333333",
            percent: 2,
            cliffDays: 30,
            vestingDays: null,
          },
          dryRun: true,
        },
      })
      expect(okResult.isError).not.toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.body).toMatchObject({
        chain: "hood",
        dexVersion: "v4",
        creatorFeeBps: null,
        snipeExempt: [],
        launchRules: {
          maxBuyPerWalletRaw: 100_000,
          capWindowSecs: 60,
          snipeFeeStartBps: null,
          snipeFeeDecaySecs: null,
        },
        teamAllocation: {
          recipient: "0x3333333333333333333333333333333333333333",
          percent: 2,
          cliffDays: 30,
          vestingDays: null,
        },
      })
      expect(calls[0]?.body).not.toHaveProperty("hoodGen2Options")

      // Without CANDLE_IMAGE_DIR (hosted URL-only schema), an imagePath sent over MCP alongside imageUrl is dropped
      // before the handler rather than leaking or failing, while imagePath alone still requires imageUrl.
      calls.length = 0
      const withExtraImagePath = await client.callTool({
        name: toolName,
        arguments: { ...BASE, imagePath: "/etc/hosts", dryRun: true },
      })
      expect(withExtraImagePath.isError).not.toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.body).not.toHaveProperty("imagePath")

      calls.length = 0
      const imagePathAlone = await client.callTool({
        name: toolName,
        arguments: { clientLaunchId: "c-alone", name: "T", symbol: "T", imagePath: "/etc/hosts" },
      })
      expect(imagePathAlone.isError).toBe(true)
      expect((imagePathAlone.content as { text: string }[])[0]?.text ?? "").toContain("imageUrl")
      expect(calls).toEqual([])
    }

    // Valid check-only call omitting launch identity fields still issues GET /api/v1/launch/preflight.
    const checkCalls: string[] = []
    const checkServer = new McpServer({ name: "launch-check-protocol-test", version: "1.0.0" })
    registerToolSubset(checkServer, {
      tools: ["candle_launch_token", "candle_launch_and_seed"],
      getConfig: () => ({ apiUrl: "https://api.test", apiKey: "cndl_live_k" }),
      fetch: async (url) => {
        checkCalls.push(String(url))
        return Response.json({
          success: true,
          key: {
            keyPrefix: "cndl_liv",
            scopes: ["launch:write"],
            tier: "pro",
            selfLaunch: true,
            embeddedWalletPermission: "allowed",
          },
          switches: { headlessLaunch: true, agentTrading: true, teeLaunchBuys: true },
          embedded: { evm: { address: "0x1111111111111111111111111111111111111111", delegated: true } },
          wallets: [],
        })
      },
    })
    const checkClient = new Client({ name: "launch-check-protocol-client", version: "1.0.0" })
    const [checkCaller, checkReceiver] = InMemoryTransport.createLinkedPair()
    await checkServer.connect(checkReceiver)
    await checkClient.connect(checkCaller)
    try {
      for (const toolName of ["candle_launch_token", "candle_launch_and_seed"] as const) {
        const res = await checkClient.callTool({ name: toolName, arguments: { check: true, chain: "hood" } })
        expect(res.isError).not.toBe(true)
      }
      expect(checkCalls).toEqual([
        "https://api.test/api/v1/launch/preflight",
        "https://api.test/api/v1/launch/preflight",
      ])
    } finally {
      await checkClient.close()
      await checkServer.close()
    }
  } finally {
    await client.close()
    await server.close()
  }
})
