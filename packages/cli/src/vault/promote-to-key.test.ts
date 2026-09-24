/**
 * BE-322: the pure half of `--to-key`, and the chunked rebind against a routed fake API. The
 * end-to-end runs (a real vault, the unlock, the import, the block) are in
 * `commands/vault-promote-to-key.test.ts`; this file pins the rules those runs rely on.
 */
import { describe, expect, test } from "bun:test"
import type { CommandContext } from "../deps"
import { type CapturedRequest, createCapture, createRoutedFetch, createTestDeps, jsonResponse } from "../test-support"
import {
  chunkWallets,
  finalBoundKey,
  finishingCommands,
  pendingWallets,
  REBIND_CHUNK,
  type RebindableWallet,
  rebindJson,
  rebindPromoted,
  renderRebindReport,
  SELECTED_SCOPE_LIMIT,
  type TargetKeyRow,
  type ToKeyTarget,
  targetKeyRefusal,
  tradeReadinessOf,
  walletRebindJson,
} from "./promote-to-key"

const TO = "Ab3dEf9h"
const FROM = "ck_live_p"
const NOW = 1_758_600_000_000

const good: TargetKeyRow = {
  keyPrefix: TO,
  label: "tr-01",
  scopes: ["swap:write", "read"],
  environment: "production",
  createdAt: 1,
  txLimit: { usdMicros: 1, reset: "daily" },
  spendLimits: [{ asset: "sol", maxPerTxRaw: "1" }],
}

describe("targetKeyRefusal: the mutation's D2.1 checks, in its order, from the listing row", () => {
  test("a key not in the listing is not on this account", () => {
    expect(targetKeyRefusal(undefined, TO, NOW)?.code).toBe("REBIND_KEY_NOT_FOUND")
    expect(targetKeyRefusal(undefined, TO, NOW)?.message).toContain("Nothing was written.")
  })

  test("revoked, expired, test and missing swap:write each refuse with REBIND_TARGET_INVALID and the route's reason", () => {
    const cases: Array<[Partial<TargetKeyRow>, string]> = [
      [{ revokedAt: 5 }, "is revoked"],
      [{ expiresAt: NOW - 1 }, "has expired"],
      [{ environment: "test" }, "is a test key"],
      [{ scopes: ["read"] }, "lacks swap:write"],
    ]
    for (const [patch, reason] of cases) {
      const refusal = targetKeyRefusal({ ...good, ...patch }, TO, NOW)
      expect([reason, refusal?.code]).toEqual([reason, "REBIND_TARGET_INVALID"])
      expect(refusal?.message).toContain(reason)
      expect(refusal?.message).toContain("Nothing was written.")
    }
    // Revoked wins over expired, as in the mutation.
    expect(targetKeyRefusal({ ...good, revokedAt: 5, expiresAt: NOW - 1 }, TO, NOW)?.message).toContain("is revoked")
  })

  test("a key that expires later, or never, and holds swap:write on production is accepted", () => {
    expect(targetKeyRefusal(good, TO, NOW)).toBeNull()
    expect(targetKeyRefusal({ ...good, expiresAt: NOW + 1 }, TO, NOW)).toBeNull()
  })
})

describe("tradeReadinessOf: the route's rule from the row", () => {
  test("no txLimit is not ready for either asset, and names all three caps", () => {
    expect(tradeReadinessOf({ txLimit: null, spendLimits: null })).toEqual({
      tradeReady: { sol: false, usdc: false },
      missingCaps: ["txLimit", "spendLimits.sol", "spendLimits.usdc"],
    })
  })

  test("txLimit with a SOL cap only: SOL ready, USDC not; either spelling of the asset counts", () => {
    expect(tradeReadinessOf(good)).toEqual({
      tradeReady: { sol: true, usdc: false },
      missingCaps: ["spendLimits.usdc"],
    })
    expect(tradeReadinessOf({ txLimit: {}, spendLimits: [{ asset: "USDC", maxPerTxRaw: "1" }] }).tradeReady).toEqual({
      sol: false,
      usdc: true,
    })
  })
})

describe("chunking and the finishing command", () => {
  test("201 ids are two chunks of 200 and 1, and two finishing commands", () => {
    const ids = Array.from({ length: 201 }, (_, i) => `w${i}`)
    expect(chunkWallets(ids).map((chunk) => chunk.length)).toEqual([200, 1])
    expect(REBIND_CHUNK).toBe(200)
    expect(SELECTED_SCOPE_LIMIT).toBe(50)
    const commands = finishingCommands(ids, TO)
    expect(commands).toHaveLength(2)
    expect(commands[0]?.startsWith("candle tee rebind w0 w1 ")).toBe(true)
    expect(commands[0]?.endsWith(` w199 --to-key ${TO}`)).toBe(true)
    expect(commands[1]).toBe(`candle tee rebind w200 --to-key ${TO}`)
    expect(finishingCommands([], TO)).toEqual([])
  })
})

// ── The rebind against a routed fake ─────────────────────────────────────────────────────────

const parse = (req: CapturedRequest) => JSON.parse(String(req.init.body ?? "{}")) as Record<string, unknown>

function target(): ToKeyTarget {
  return {
    keyPrefix: TO,
    label: "tr-01",
    walletScope: "all",
    paused: false,
    launchScope: false,
    tradeReady: { sol: true, usdc: false },
    missingCaps: ["spendLimits.usdc"],
  }
}

function wallets(n: number): RebindableWallet[] {
  return Array.from({ length: n }, (_, i) => ({ id: `lw${i}`, address: `Addr${i}`, label: `k-${i}` }))
}

/** A rebind route that answers from the request: a preview echoes the ids it was given as `rebound`. */
function rebindRoute(opts: {
  alreadyThere?: Set<string>
  failCommit?: (n: number) => Response | undefined
  failPreview?: (n: number) => Response | undefined
}) {
  const bodies: Record<string, unknown>[] = []
  let previews = 0
  let commits = 0
  const toKey = {
    keyPrefix: TO,
    label: "tr-01",
    paused: false,
    walletScope: "all",
    tradeReady: { sol: true, usdc: true },
    missingCaps: [],
    launchScope: false,
  }
  const handler = (req: CapturedRequest) => {
    const body = parse(req)
    bodies.push(body)
    if (body.dryRun === true) {
      previews += 1
      const refused = opts.failPreview?.(previews)
      if (refused) return refused
      const ids = body.wallets as string[]
      return jsonResponse(200, {
        success: true,
        dryRun: true,
        toKey,
        rebound: ids
          .filter((id) => !opts.alreadyThere?.has(id))
          .map((id) => ({ id, address: `A${id}`, label: id, fromKeyPrefix: FROM, allowLaunch: false })),
        unchanged: ids.filter((id) => opts.alreadyThere?.has(id)).map((id) => ({ id, address: `A${id}`, label: id })),
      })
    }
    commits += 1
    const refused = opts.failCommit?.(commits)
    if (refused) return refused
    const ids = body.walletIds as string[]
    return jsonResponse(200, {
      success: true,
      dryRun: false,
      toKey,
      rebound: ids.map((id) => ({
        id,
        address: `A${id}`,
        label: id,
        fromKeyPrefix: FROM,
        allowLaunch: false,
        auditId: `aud-${id}`,
      })),
      unchanged: [],
    })
  }
  return { handler, bodies, counts: () => ({ previews, commits }) }
}

function ctxFor(fetch: typeof globalThis.fetch): CommandContext {
  const deps = createTestDeps({ fetch, stdout: createCapture(), stderr: createCapture(), env: {} })
  return { deps, json: false, apiUrl: "https://api.pb.test", verifyAccount: true }
}

describe("rebindPromoted: preview then commit per chunk of at most 200", () => {
  test("201 wallets are two previews and two commits, 200 then 1, each commit exactly the preview's ids and bindings", async () => {
    const api = rebindRoute({})
    const { fetch, calls } = createRoutedFetch({ "/api/v1/agent/tee-wallets/rebind": api.handler })
    const run = await rebindPromoted(ctxFor(fetch), "dt", TO, wallets(201))
    expect(run.ok).toBe(true)
    expect(run.requests).toBe(4)
    expect(api.counts()).toEqual({ previews: 2, commits: 2 })
    expect(calls).toHaveLength(4)
    expect((api.bodies[0]?.wallets as string[]).length).toBe(200)
    expect(api.bodies[0]).toMatchObject({ dryRun: true, toKeyPrefix: TO })
    expect((api.bodies[1]?.walletIds as string[]).length).toBe(200)
    expect(api.bodies[1]).toEqual({
      toKeyPrefix: TO,
      walletIds: (api.bodies[0]?.wallets as string[]).slice(),
      expect: Object.fromEntries((api.bodies[0]?.wallets as string[]).map((id) => [id, FROM])),
    })
    expect(api.bodies[2]).toEqual({ dryRun: true, toKeyPrefix: TO, wallets: ["lw200"] })
    expect(api.bodies[3]).toEqual({ toKeyPrefix: TO, walletIds: ["lw200"], expect: { lw200: FROM } })
    expect([...run.outcomes.values()].every((o) => o.state === "rebound")).toBe(true)
    expect(run.outcomes.get("lw200")?.auditId).toBe("aud-lw200")
    expect(run.toKey?.keyPrefix).toBe(TO)
    // The device token, never an API key.
    for (const call of calls) {
      const headers = (call.init.headers ?? {}) as Record<string, string>
      expect(headers.authorization).toBe("Bearer dt")
      expect(headers["x-api-key"]).toBeUndefined()
    }
  })

  test("wallets already on the target are unchanged, and a chunk with nothing to move sends no commit", async () => {
    const api = rebindRoute({ alreadyThere: new Set(["lw0", "lw1", "lw2"]) })
    const { fetch } = createRoutedFetch({ "/api/v1/agent/tee-wallets/rebind": api.handler })
    const run = await rebindPromoted(ctxFor(fetch), "dt", TO, wallets(3))
    expect(run.ok).toBe(true)
    expect(api.counts()).toEqual({ previews: 1, commits: 0 })
    expect([...run.outcomes.values()].map((o) => o.state)).toEqual(["unchanged", "unchanged", "unchanged"])
    expect(pendingWallets(wallets(3), run)).toEqual([])
  })

  test("a commit refused in chunk 1 stops the run: chunk 1 failed, chunk 2 not reached, the route's suggestion kept", async () => {
    const retryAfter = Date.UTC(2026, 8, 24, 12, 30)
    const api = rebindRoute({
      failCommit: (n) =>
        n === 1
          ? jsonResponse(409, {
              success: false,
              error: {
                code: "REBIND_BUILD_OPEN",
                message: "open build",
                retryable: false,
                walletIds: ["lw0"],
                retryAfter,
              },
            })
          : undefined,
    })
    const { fetch } = createRoutedFetch({ "/api/v1/agent/tee-wallets/rebind": api.handler })
    const all = wallets(201)
    const run = await rebindPromoted(ctxFor(fetch), "dt", TO, all)
    expect(run.ok).toBe(false)
    expect(api.counts()).toEqual({ previews: 1, commits: 1 })
    expect(run.failure).toMatchObject({ code: "REBIND_BUILD_OPEN", chunk: 1 })
    expect(run.failure?.suggestion).toContain(`Stop the agent on key ${FROM} (candle keys stop ${FROM})`)
    expect(run.outcomes.get("lw0")?.state).toBe("failed")
    expect(run.outcomes.get("lw199")?.state).toBe("failed")
    expect(run.outcomes.get("lw200")?.state).toBe("not-reached")
    expect(pendingWallets(all, run)).toHaveLength(201)

    // The report names every pending wallet and the two commands that finish.
    const report = renderRebindReport({
      target: target(),
      callingKeyPrefix: FROM,
      wallets: all,
      run,
      notRebindable: [],
    })
    expect(report).toContain("Rebind REBIND_BUILD_OPEN: open build")
    expect(report).toContain(`201 promoted wallets are still bound to the calling key ${FROM}, not ${TO}:`)
    expect(report).toContain("  k-0 (Addr0)")
    expect(report).toContain("Finish with:")
    expect(report).toContain(`  candle tee rebind Addr200 --to-key ${TO}`)
    const json = rebindJson({ target: target(), callingKeyPrefix: FROM, wallets: all, run, notRebindable: [] })
    expect(json.rebind).toMatchObject({
      ok: false,
      reached: true,
      requests: 2,
      rebound: 0,
      unchanged: 0,
      code: "REBIND_BUILD_OPEN",
    })
    expect(json.rebind.pending).toHaveLength(201)
    expect(json.rebind.finishWith).toHaveLength(2)
    // The preview's readiness replaces the row's.
    expect(json.toKey.tradeReady).toEqual({ sol: true, usdc: true })
  })

  test("a preview refused by a server without the route is REBIND_UNSUPPORTED with every wallet not reached", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/tee-wallets/rebind": () => jsonResponse(404, { error: "Not Found" }),
    })
    const all = wallets(2)
    const run = await rebindPromoted(ctxFor(fetch), "dt", TO, all)
    expect(run.ok).toBe(false)
    expect(run.failure?.code).toBe("REBIND_UNSUPPORTED")
    expect([...run.outcomes.values()].map((o) => o.state)).toEqual(["not-reached", "not-reached"])
  })
})

describe("the document's per-wallet keys", () => {
  test("bound key and rebind state for moved, unchanged, failed, not-reached and not-rebindable wallets", async () => {
    const api = rebindRoute({ alreadyThere: new Set(["lw1"]) })
    const { fetch } = createRoutedFetch({ "/api/v1/agent/tee-wallets/rebind": api.handler })
    const run = await rebindPromoted(ctxFor(fetch), "dt", TO, wallets(2))
    expect(finalBoundKey({ id: "lw0", importedTo: FROM }, run, TO)).toBe(TO)
    expect(finalBoundKey({ id: "lw1", importedTo: FROM }, run, TO)).toBe(TO)
    expect(finalBoundKey({ id: "lw9", importedTo: FROM }, run, TO)).toBe(FROM)
    expect(finalBoundKey({ id: null, importedTo: null }, run, TO)).toBeNull()
    expect(walletRebindJson({ id: "lw0", remoteAuthority: "verified-active" }, run)).toEqual({
      state: "rebound",
      auditId: "aud-lw0",
    })
    expect(walletRebindJson({ id: "lw1", remoteAuthority: "verified-active" }, run)).toEqual({ state: "unchanged" })
    expect(walletRebindJson({ id: "lw9", remoteAuthority: "verified-active" }, run)).toEqual({ state: "not-reached" })
    expect(walletRebindJson({ id: "lw9", remoteAuthority: "verified-active" }, undefined)).toEqual({
      state: "not-reached",
    })
    expect(walletRebindJson({ id: "lw0", remoteAuthority: "unknown" }, run)).toEqual({
      state: "not-rebindable",
      reason: "remote authority is unknown, not verified-active",
    })
    expect(walletRebindJson({ id: null, remoteAuthority: "verified-active" }, run).state).toBe("not-rebindable")
  })

  test("the not-reached report names the landed wallets and the finishing command, with no run at all", () => {
    const report = renderRebindReport({
      target: target(),
      callingKeyPrefix: FROM,
      wallets: wallets(2),
      notRebindable: [{ address: "Addr9", label: "k-9", reason: "remote authority is unknown, not verified-active" }],
    })
    expect(report).toContain(`2 promoted wallets are still bound to the calling key ${FROM}, not ${TO}:`)
    expect(report).toContain(`  candle tee rebind Addr0 Addr1 --to-key ${TO}`)
    expect(report).toContain("1 wallet cannot be rebound yet (only a verified-active wallet moves):")
    expect(report).toContain("  k-9 (Addr9): remote authority is unknown, not verified-active")
    expect(report).not.toContain("✓")
  })
})
