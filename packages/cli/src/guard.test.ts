/**
 * The strict account guard (spec: "The mismatch guard", settled strict on 2026-08-19). It is the
 * reason the account cache exists: a valid credential for the WRONG account becomes a refusal
 * that names both, instead of a command that quietly acts as someone else.
 */
import { describe, expect, test } from "bun:test"
import type { CommandContext } from "./deps"
import { verifyProfileAccount } from "./guard"
import { createFakeConfigStore, createFakeStore, createRoutedFetch, createTestDeps, jsonResponse } from "./test-support"

function ctxWith(
  over: Partial<CommandContext> & {
    fetch?: typeof fetch
    store?: ReturnType<typeof createFakeStore>
    env?: Record<string, string>
  },
): CommandContext {
  const config = createFakeConfigStore({
    activeProfile: "staging",
    profiles: { staging: { apiUrl: "https://staging.api.candle.tv", account: "CACHED1" } },
  })
  const deps = createTestDeps({
    fetch:
      over.fetch ??
      ((() => {
        throw new Error("must not fetch")
      }) as unknown as typeof fetch),
    store: over.store ?? createFakeStore({ "profile:staging:api_key": "ck_live_x" }),
    env: over.env ?? {},
    ...config,
  })
  return {
    deps,
    json: false,
    apiUrl: "https://staging.api.candle.tv",
    profile: "staging",
    verifyAccount: true,
    ...over,
  }
}

/** The guard now judges the config `run` already read, so every call here passes the very config
 * the fake deps would have returned. */
async function verify(ctx: CommandContext) {
  return verifyProfileAccount(ctx, await ctx.deps.readConfig())
}

describe("verifyProfileAccount", () => {
  test("matching live account passes", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: "CACHED1" }),
    })
    expect(await verify(ctxWith({ fetch }))).toEqual({ ok: true })
  })

  // Fix wave item 2: three ways out, not two, and cheapest first. A key that was legitimately
  // re-issued needs nothing more than a re-cache (`profile use`), which the refusal used to omit
  // entirely -- leaving re-authentication, which mints a NEW key, as the cheapest repair on offer.
  test("a different live account refuses, naming both and all three repairs, cheapest first", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: "OTHER22" }),
    })
    const verdict = await verify(ctxWith({ fetch }))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.message).toContain("CACHED1")
      expect(verdict.message).toContain("OTHER22")
      expect(verdict.message).toContain("candle profile use staging")
      expect(verdict.message).toContain("candle auth login --profile staging")
      expect(verdict.message).toContain("--no-verify-account")
      const order = ["candle profile use staging", "candle auth login --profile staging", "--no-verify-account"].map(
        (repair) => verdict.message.indexOf(repair),
      )
      expect(order).toEqual([...order].sort((a, b) => a - b))
    }
  })

  test("an unreachable API degrades to a warning and proceeds", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    const verdict = await verify(ctxWith({ fetch: failing }))
    expect(verdict.ok).toBe(true)
    expect("warning" in verdict && verdict.warning).toContain("Could not verify")
  })

  test("skips, without a network call, when told to, with no profile, under an env override, with no cached account, or with no stored key", async () => {
    expect(await verify(ctxWith({ verifyAccount: false }))).toMatchObject({
      ok: true,
      skipped: expect.any(String),
    })
    expect(await verify(ctxWith({ profile: undefined }))).toMatchObject({
      ok: true,
      skipped: expect.any(String),
    })
    expect(await verify(ctxWith({ env: { CANDLE_API_KEY: "env-key" } }))).toMatchObject({
      ok: true,
      skipped: expect.any(String),
    })
    expect(await verify(ctxWith({ store: createFakeStore() }))).toMatchObject({
      ok: true,
      skipped: expect.any(String),
    })
    const noCache = ctxWith({})
    noCache.deps = createTestDeps({
      fetch: noCache.deps.fetch,
      store: noCache.deps.store,
      ...createFakeConfigStore({ profiles: { staging: {} }, activeProfile: "staging" }),
    })
    expect(await verify(noCache)).toMatchObject({ ok: true, skipped: expect.any(String) })
  })
})
