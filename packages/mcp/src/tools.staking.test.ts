import { expect, test } from "bun:test"
import { z } from "zod"
import { buildRequest, registerToolSubset, type ToolName } from "./tools"

const names = [
  "candle_get_staking",
  "candle_stake",
  "candle_unstake",
  "candle_finish_unstake",
  "candle_claim_staking_reward",
] as const satisfies readonly ToolName[]
const cfg = { apiUrl: "http://localhost", apiKey: "key" }

test("staking maps all five local tools and forwards only their own fields", () => {
  const args = {
    payer: "linked",
    linkedWalletId: "w",
    amountRaw: "20",
    clientStakeId: "id",
    dryRun: true,
    withdrawal: "withdrawal",
    rewardId: "reward/1",
    instant: true,
    to: "stranger",
  }
  const calls = names.map((n) => buildRequest(n, args, cfg))
  expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
    "/api/v1/agent/staking",
    "/api/v1/agent/staking/stake/build",
    "/api/v1/agent/staking/unstake/build",
    "/api/v1/agent/staking/finish/build",
    "/api/v1/agent/staking/rewards/reward%2F1/claim",
  ])
  expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
    payer: "linked",
    linkedWalletId: "w",
    amountRaw: "20",
    clientStakeId: "id",
    dryRun: true,
  })
  expect(JSON.parse(String(calls[3]?.init.body))).toEqual({
    payer: "linked",
    linkedWalletId: "w",
    withdrawal: "withdrawal",
    clientStakeId: "id",
    dryRun: true,
  })
  expect(calls[4]?.init.body).toBe("{}")
  for (const n of names) expect(() => buildRequest(n, {}, { apiUrl: cfg.apiUrl })).toThrow("API_KEY")
})

test("staking registrations call the REST mapping; embedded-only registration has no payer choice", async () => {
  for (const embeddedStakingOnly of [false, true]) {
    const tools = new Map<
      string,
      {
        definition: { inputSchema: z.ZodRawShape; description: string }
        handler: (args: Record<string, unknown>) => Promise<unknown>
      }
    >()
    const server = {
      registerTool(
        name: string,
        definition: { inputSchema: z.ZodRawShape; description: string },
        handler: (args: Record<string, unknown>) => Promise<unknown>,
      ) {
        tools.set(name, { definition, handler })
      },
    } as unknown as Parameters<typeof registerToolSubset>[0]
    const calls: string[] = []
    registerToolSubset(server, {
      tools: names,
      embeddedStakingOnly,
      getConfig: () => cfg,
      fetch: async (url) => {
        calls.push(url)
        return Response.json({ success: true })
      },
    })
    expect([...tools.keys()]).toEqual([...names])
    for (const name of names) {
      const tool = tools.get(name)
      if (!tool) throw new Error("Tool was not registered")
      expect(tool.definition.description).toContain("pending withdrawal counts toward nothing for Pro")
      const schema = z.object(tool.definition.inputSchema)
      const args = schema.parse({
        clientStakeId: "id",
        amountRaw: "1",
        withdrawal: "w",
        rewardId: "r",
        payer: "linked",
        linkedWalletId: "l",
      })
      await tool.handler(args)
      expect(tool.definition.inputSchema).not.toHaveProperty("instant")
      if (embeddedStakingOnly) expect(tool.definition.inputSchema).not.toHaveProperty("payer")
    }
    expect(calls).toHaveLength(5)
  }
})

test("linkedWalletId without payer is forwarded so the route refuses the mismatch", () => {
  for (const n of ["candle_stake", "candle_unstake", "candle_finish_unstake"] as const) {
    const body = JSON.parse(
      String(
        buildRequest(n, { linkedWalletId: "lw_tee_1", amountRaw: "5", withdrawal: "w", clientStakeId: "x" }, cfg).init
          .body,
      ),
    )
    expect(body).toMatchObject({ payer: "main", linkedWalletId: "lw_tee_1" })
  }
})
