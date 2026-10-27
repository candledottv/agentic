import { describe, expect, test } from "bun:test"
import { run } from "../index"
import { createCapture, createRoutedFetch, createTestDeps, jsonResponse } from "../test-support"
import { QUANT_TERMS_VERSION } from "./quant-terms"

const PATH = "/api/v1/agent/quant/terms/accept"

function setup(response: () => Response, env: Record<string, string> = { CANDLE_API_KEY: "cndl_live_k" }) {
  const stdout = createCapture()
  const stderr = createCapture()
  const routed = createRoutedFetch({ [PATH]: response })
  const prompts: string[] = []
  const deps = createTestDeps({
    fetch: routed.fetch,
    stdout,
    stderr,
    env: { CANDLE_API_URL: "https://api.test", ...env },
    promptLine: async (text) => {
      prompts.push(text)
      return "accept"
    },
  })
  return { deps, stdout, stderr, routed, prompts }
}

describe("candle quant terms (spec 7.3, 10.1)", () => {
  test("shows the terms, confirms, and records the version over the key route", async () => {
    const f = setup(() => jsonResponse(200, { ok: true }))
    expect(await run(["quant", "terms"], f.deps)).toBe(0)
    expect(f.stdout.text).toContain("https://docs.candle.tv/terms")
    expect(f.stdout.text).toContain(`Accepted Quant's terms ${QUANT_TERMS_VERSION}.`)
    expect(f.prompts).toEqual([`Type accept to accept Quant's terms ${QUANT_TERMS_VERSION}: `])
    const call = f.routed.calls[0]
    expect(call?.init.method).toBe("POST")
    expect(JSON.parse(String(call?.init.body))).toEqual({ version: QUANT_TERMS_VERSION })
    expect((call?.init.headers as Record<string, string>)["x-api-key"]).toBe("cndl_live_k")
  })

  test("--yes skips the prompt; --terms-version sends another date", async () => {
    const f = setup(() => jsonResponse(200, { ok: true }))
    expect(await run(["quant", "terms", "--yes", "--terms-version", "2026-12-01", "--json"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text)).toEqual({ ok: true, version: "2026-12-01" })
    expect(f.prompts).toEqual([])
    expect(JSON.parse(String(f.routed.calls[0]?.init.body))).toEqual({ version: "2026-12-01" })
  })

  test("a stale version, a route that is off, and no key are each said plainly", async () => {
    let f = setup(() => jsonResponse(400, { code: "terms_version_mismatch" }))
    expect(await run(["quant", "terms", "--yes", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: false, code: "TERMS_VERSION_MISMATCH" })
    f = setup(() => jsonResponse(404, {}))
    expect(await run(["quant", "terms", "--yes", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: false, code: "QUANT_TERMS_UNAVAILABLE" })
    f = setup(() => jsonResponse(200, {}), {})
    expect(await run(["quant", "terms", "--yes", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: false, code: "NO_API_KEY" })
    expect(f.routed.calls).toHaveLength(0)
  })

  test("declining records nothing; a bad version is a usage error", async () => {
    const f = setup(() => jsonResponse(200, {}))
    f.deps.promptLine = async () => "no"
    expect(await run(["quant", "terms"], f.deps)).toBe(1)
    expect(await run(["quant", "terms", "--terms-version", "tomorrow"], f.deps)).toBe(2)
    expect(f.routed.calls).toHaveLength(0)
  })
})
