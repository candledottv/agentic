/**
 * BE-1665 (spec K-1, T-1): every MCP tool is classified, and nothing classified is invented. A new
 * tool in `packages/mcp/src/tools.ts` fails this until someone decides whether it is a read or a
 * card, which is the point: the core refuses an unclassified tool rather than guess.
 */
import { describe, expect, test } from "bun:test"
import { TOOL_NAMES } from "../../../mcp/src/tools"
import { CORE_LOCAL_TOOLS, classificationDrift, classifyCall, TOOL_CLASSES } from "./classify"
import { offeredTools } from "./tools-face"

describe("T-1: the card table matches TOOL_NAMES", () => {
  test("both directions", () => {
    const classified = Object.keys(TOOL_CLASSES).sort()
    expect([...TOOL_NAMES].filter((name) => !Object.hasOwn(TOOL_CLASSES, name))).toEqual([])
    expect(classified.filter((name) => !(TOOL_NAMES as readonly string[]).includes(name))).toEqual([])
    expect(classified).toEqual([...TOOL_NAMES].sort())
  })

  test("S5 T-17: every offered name is in exactly one table, and no core-local name collides", () => {
    expect(classificationDrift(TOOL_NAMES)).toEqual([])
    const offered = offeredTools().map((tool) => tool.name)
    for (const name of offered) {
      const tables = [Object.hasOwn(TOOL_CLASSES, name), Object.hasOwn(CORE_LOCAL_TOOLS, name)].filter(Boolean)
      expect(`${name}: ${tables.length}`).toBe(`${name}: 1`)
    }
    expect(offered).toContain("candle_get_signals")
    expect(classifyCall("candle_get_signals", {})).toEqual({ class: "read" })
  })

  test("S5 T-17: the drift rule fails on an unclassified, an invented or a colliding name", () => {
    const names = [...TOOL_NAMES, "candle_new_tool"]
    expect(classificationDrift(names)).toEqual(["unclassified: candle_new_tool"])
    expect(classificationDrift(TOOL_NAMES, { ...TOOL_CLASSES, candle_made_up: { class: "read" } })).toEqual([
      "not an MCP tool: candle_made_up",
    ])
    expect(
      classificationDrift(TOOL_NAMES, TOOL_CLASSES, { ...CORE_LOCAL_TOOLS, candle_get_market: { class: "read" } }),
    ).toEqual(["core-local name collides with an MCP tool: candle_get_market", "in both tables: candle_get_market"])
  })

  test("an unknown tool is unclassified, never a read; prototype names are unknown too", () => {
    expect(classifyCall("candle_future_tool", {})).toEqual({ class: "unclassified" })
    expect(classifyCall("toString", {})).toEqual({ class: "unclassified" })
  })

  test("paper trades and launch dry runs need no card; the live forms do", () => {
    expect(classifyCall("candle_trade", { paper: true })).toEqual({ class: "paper" })
    expect(classifyCall("candle_trade", { paper: "true" })).toMatchObject({ class: "card", kind: "trade" })
    expect(classifyCall("candle_trade", {})).toMatchObject({ class: "card", kind: "trade", idKey: "clientTradeId" })
    expect(classifyCall("candle_launch_and_seed", { dryRun: true })).toEqual({ class: "dry_run" })
    expect(classifyCall("candle_launch_token", {})).toMatchObject({ class: "card", kind: "launch" })
    expect(classifyCall("candle_get_market", {})).toEqual({ class: "read" })
  })

  test("transfers, profile wallets and profile writes are the kinds the spec names", () => {
    expect(classifyCall("candle_transfer", {})).toMatchObject({ kind: "transfer" })
    expect(classifyCall("candle_sweep", {})).toMatchObject({ kind: "transfer" })
    expect(classifyCall("candle_set_profile_wallets", {})).toMatchObject({ kind: "keyaccess" })
    expect(classifyCall("candle_create_post", {})).toMatchObject({ kind: "profile" })
    expect(classifyCall("candle_claim_staking_reward", {})).toMatchObject({ kind: "claim", idKey: "rewardId" })
  })
})
