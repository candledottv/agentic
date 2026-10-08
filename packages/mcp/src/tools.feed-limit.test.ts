import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { registerToolSubset } from "./tools"

/*
 * BE-1095: `limit` was typed as a string, so a model that sent the number the description
 * implied failed validation on its first call. These run the arguments through the registered
 * schema exactly as the MCP SDK does (safeParseAsync on the raw shape), then through the handler,
 * so both the refusal and the query string the API receives are covered.
 */
describe("candle_get_feed limit", () => {
  const requests: string[] = []
  let shape: z.ZodRawShape = {}
  let handler: (args: Record<string, unknown>) => Promise<unknown> = async () => undefined
  registerToolSubset(
    {
      registerTool(_name: string, config: { inputSchema: z.ZodRawShape }, h: typeof handler) {
        shape = config.inputSchema
        handler = h
      },
    } as never,
    {
      tools: ["candle_get_feed"],
      getConfig: () => ({ apiUrl: "https://api.test" }),
      fetch: async (url) => {
        requests.push(url)
        return Response.json({ success: true, tokens: [] })
      },
    },
  )

  async function call(args: Record<string, unknown>) {
    const parsed = await z.object(shape).safeParseAsync({ bucket: "graduated", ...args })
    if (!parsed.success) return { error: parsed.error.issues.map((i) => i.message) }
    requests.length = 0
    await handler(parsed.data)
    return { query: new URL(requests[0] as string).searchParams }
  }

  test("a number is accepted and reaches the query string", async () => {
    const r = await call({ limit: 3 })
    expect(r.query?.get("limit")).toBe("3")
  })

  test("a numeric string still works, as clients and saved prompts already send it", async () => {
    const r = await call({ limit: "3" })
    expect(r.query?.get("limit")).toBe("3")
  })

  test("the bounds are inclusive", async () => {
    expect((await call({ limit: 1 })).query?.get("limit")).toBe("1")
    expect((await call({ limit: 200 })).query?.get("limit")).toBe("200")
  })

  test.each([
    ["zero", 0],
    ["above the cap", 201],
    ["a fraction", 2.5],
    ["a non-numeric string", "abc"],
    ["a numeric string out of range", "201"],
    ["a decimal string", "2.5"],
    ["a negative", -1],
    ["a boolean", true],
  ])("%s is refused with a readable message", async (_label, limit) => {
    const r = await call({ limit })
    expect(r.error).toEqual(["limit must be a whole number from 1 to 200"])
  })

  test("no limit sends none, and an empty string still means not set", async () => {
    expect((await call({})).query?.has("limit")).toBe(false)
    expect((await call({ limit: "" })).query?.has("limit")).toBe(false)
  })
})
