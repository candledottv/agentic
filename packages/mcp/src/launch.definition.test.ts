import { expect, test } from "bun:test"
import {
  launchAndSeedShape,
  launchFieldHelp,
  launchTokenShape,
  MCP_IMAGE_PATH_KEYS,
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
        tools.set(name, { description: config.description ?? "", inputSchema: config.inputSchema, handler })
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
  expect(sorted(Object.keys(launchTokenShape))).toEqual(sorted([...defined, ...TOKEN_LEGACY_KEYS]))
  expect(sorted(Object.keys(launchAndSeedShape))).toEqual(sorted([...defined, ...SEED_LEGACY_KEYS]))
  expect(defined).not.toContain("wallet")
  expect(defined).not.toContain("buy")
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
