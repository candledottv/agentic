/**
 * BE-322: `--to-key` on `candle vault promote-batch` and `candle vault promote`, end to end: a
 * real vault, the unlock, the import under the calling key, then the rebind to the named key over
 * a routed fake API. The pure rules and the 201-wallet chunking are pinned in
 * `vault/promote-to-key.test.ts`.
 *
 * The batch half drives the shared harness in `__fixtures__/promote-batch.ts`; the single-promote
 * half has its own small runner below, on the same fixture vault.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { run } from "../index"
import {
  type CapturedRequest,
  createCapture,
  createFakeStore,
  createRoutedFetch,
  createTestDeps,
  jsonResponse,
  type RouteHandler,
} from "../test-support"
import { useCheapKdf } from "../vault/test-vault"
import {
  ACCOUNT,
  API,
  API_KEY,
  DEVICE_TOKEN,
  type Fixture,
  fixture,
  jsonDocuments,
  KEY_LABEL,
  KEY_PREFIX,
  pairsFile,
  RPC,
  readEntries,
  runBatch,
  seed,
  teeSeed,
  USERNAME,
} from "./__fixtures__/promote-batch"

setDefaultTimeout(180_000)
useCheapKdf()

const TO = "Ab3dEf9h"
const TO_LABEL = "tr-01"
/** What the fixture's submit reports as `boundKeyPrefix`: the calling key, as the server names it. */
const IMPORTED_TO = "ck_live_p"

type KeyRowIn = Record<string, unknown>

/** The account's keys: the calling key (labelled, so the block's `imported under` line has a name) and the target. */
function keysListing(target: KeyRowIn = {}, extra: KeyRowIn[] = []): RouteHandler {
  return () =>
    jsonResponse(200, {
      keys: [
        { keyPrefix: KEY_PREFIX, scopes: ["read", "trade"], environment: "production", createdAt: 2, label: KEY_LABEL },
        {
          keyPrefix: TO,
          label: TO_LABEL,
          scopes: ["swap:write", "read"],
          environment: "production",
          createdAt: 3,
          txLimit: { usdMicros: 1_000_000, reset: "daily" },
          spendLimits: [{ asset: "sol", maxPerTxRaw: "1000" }],
          ...target,
        },
        ...extra,
      ],
    })
}

const parse = (req: CapturedRequest) => JSON.parse(String(req.init.body ?? "{}")) as Record<string, unknown>

/** A rebind route answering from the request: a preview reports every id not already on the target as moving. */
function rebindRoute(opts: { alreadyThere?: string[]; failCommit?: Response; failPreview?: Response } = {}) {
  const bodies: Record<string, unknown>[] = []
  const toKey = {
    keyPrefix: TO,
    label: TO_LABEL,
    paused: false,
    walletScope: "all",
    tradeReady: { sol: true, usdc: false },
    missingCaps: ["spendLimits.usdc"],
    launchScope: false,
  }
  const there = new Set(opts.alreadyThere ?? [])
  const handler: RouteHandler = (req) => {
    const body = parse(req)
    bodies.push(body)
    if (body.dryRun === true) {
      if (opts.failPreview) return opts.failPreview
      const ids = body.wallets as string[]
      return jsonResponse(200, {
        success: true,
        dryRun: true,
        toKey,
        rebound: ids
          .filter((id) => !there.has(id))
          .map((id) => ({ id, address: `A${id}`, label: id, fromKeyPrefix: IMPORTED_TO, allowLaunch: false })),
        unchanged: ids.filter((id) => there.has(id)).map((id) => ({ id, address: `A${id}`, label: id })),
      })
    }
    if (opts.failCommit) return opts.failCommit
    const ids = body.walletIds as string[]
    return jsonResponse(200, {
      success: true,
      dryRun: false,
      toKey,
      rebound: ids.map((id) => ({
        id,
        address: `A${id}`,
        label: id,
        fromKeyPrefix: IMPORTED_TO,
        allowLaunch: false,
        auditId: `aud-${id}`,
      })),
      unchanged: [],
    })
  }
  return { handler, bodies }
}

const refusal = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  jsonResponse(status, { success: false, error: { code, message: `server says ${code}`, retryable: false, ...extra } })

const linkedId = (address: string) => `lw_${address.slice(0, 6)}`

/** Single promote's stdout carries the holdings and authorities above the document, which is the last line. */
const lastLine = (out: string) => JSON.parse(out.trim().split("\n").at(-1) as string)

/** The block as the batch prints it with a target (BE-322), under the fixture's profile `pb`. */
function targetBlock(n: number): string {
  const subject = n === 1 ? "This key" : `These ${n} keys`
  return [
    `${subject} will be controlled by:`,
    `  Candle account  ${USERNAME}  (${ACCOUNT.slice(0, 6)}…${ACCOUNT.slice(-4)})`,
    `  API key         ${TO}…  (${TO_LABEL})  --to-key, bound by a rebind after the import`,
    `  imported under  ${KEY_PREFIX}…  (${KEY_LABEL})  profile pb`,
    `  API             ${API}  (not a Candle host, from CANDLE_API_URL)`,
    `Warning: key ${TO} can trade SOL-quoted swaps; it cannot trade USDC-quoted swaps until a USDC cap is set.`,
  ].join("\n")
}

function rebindCalls(o: { calls: CapturedRequest[] }) {
  return o.calls.filter((call) => call.url.includes("/tee-wallets/rebind"))
}

describe("promote-batch --to-key: a valid target", () => {
  test("imports under the calling key, one preview and one commit, final binding is the target, the block names the target", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const rebind = rebindRoute()
    const o = await runBatch(f, {
      file,
      ack: "correct",
      json: true,
      deviceToken: true,
      args: ["--to-key", TO_LABEL],
      api: { keys: keysListing(), rebind: rebind.handler },
    })
    expect(o.code).toBe(0)
    // The imports ran under the calling key, exactly as without the flag.
    expect(o.submits.n).toBe(2)
    for (const call of o.calls.filter((c) => c.url.includes("/wallets/import/"))) {
      expect((call.init.headers as Record<string, string>)["x-api-key"]).toBe(API_KEY)
    }
    // One rebind: the preview naming the imported ids, then the commit with the preview's bindings.
    const a = linkedId(f.addresses.a as string)
    const b = linkedId(f.addresses.b as string)
    expect(rebind.bodies).toEqual([
      { dryRun: true, toKeyPrefix: TO, wallets: [a, b] },
      { toKeyPrefix: TO, walletIds: [a, b], expect: { [a]: IMPORTED_TO, [b]: IMPORTED_TO } },
    ])
    for (const call of rebindCalls(o)) {
      const headers = call.init.headers as Record<string, string>
      expect(headers.authorization).toBe(`Bearer ${DEVICE_TOKEN}`)
      expect(headers["x-api-key"]).toBeUndefined()
    }
    // The rebind came after the last import.
    const urls = o.calls.map((c) => new URL(c.url).pathname)
    expect(urls.lastIndexOf("/api/v1/agent/wallets/import/submit")).toBeLessThan(
      urls.indexOf("/api/v1/agent/tee-wallets/rebind"),
    )
    // The block names the target, says how it is reached, names the import key, and warns on USDC.
    expect(o.err).toContain(targetBlock(2))
    expect(o.stderrAtPrompt[0]?.endsWith(`\n${targetBlock(2)}\n`)).toBe(true)
    expect(o.err).toContain(`✓ 2 wallets moved to key ${TO} in 2 requests.`)
    // One document: each wallet's final key and rebind outcome, the target, and the controller.
    const docs = jsonDocuments(o.out)
    expect(docs).toHaveLength(1)
    const body = JSON.parse(docs[0] as string)
    expect(body).toMatchObject({ ok: true, complete: true, promoted: 2 })
    expect(body.keys.map((k: { boundKeyPrefix: string }) => k.boundKeyPrefix)).toEqual([TO, TO])
    expect(body.keys.map((k: { rebind: { state: string; auditId: string } }) => k.rebind)).toEqual([
      { state: "rebound", auditId: `aud-${a}` },
      { state: "rebound", auditId: `aud-${b}` },
    ])
    expect(body.toKey).toEqual({
      keyPrefix: TO,
      label: TO_LABEL,
      tradeReady: { sol: true, usdc: false },
      missingCaps: ["spendLimits.usdc"],
    })
    expect(body.rebind).toEqual({
      ok: true,
      reached: true,
      requests: 2,
      rebound: 2,
      unchanged: 0,
      pending: [],
      notRebindable: 0,
      finishWith: [],
    })
    expect(body.controlledBy).toEqual({
      account: ACCOUNT,
      username: USERNAME,
      keyPrefix: TO,
      keyLabel: TO_LABEL,
      keySource: "--to-key",
      apiUrl: API,
      environment: null,
      importedUnder: { keyPrefix: KEY_PREFIX, keyLabel: KEY_LABEL, keySource: "profile" },
    })
    expect(o.out).not.toContain(API_KEY)
    expect(o.err).not.toContain(API_KEY)
    expect(o.err).not.toContain(DEVICE_TOKEN)
  })

  test("a prefix is used as is and needs no label match; the human summary names the target", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const rebind = rebindRoute()
    const o = await runBatch(f, {
      file,
      ack: "correct",
      deviceToken: true,
      args: ["--to-key", TO],
      api: { keys: keysListing(), rebind: rebind.handler },
    })
    expect(o.code).toBe(0)
    expect(rebind.bodies[0]).toMatchObject({ dryRun: true, toKeyPrefix: TO })
    expect(o.out).toContain("2 addresses promoted under one unlock, each committed on its own.")
    expect(o.out).toContain(`2 of 2 wallets bound to ${TO}.`)
  })

  test("a wallet the import left short of verified-active is not rebound and is listed with the reason; the other moves", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const rebind = rebindRoute()
    const o = await runBatch(f, {
      file,
      ack: "correct",
      json: true,
      deviceToken: true,
      args: ["--to-key", TO],
      api: {
        keys: keysListing(),
        rebind: rebind.handler,
        remoteAuthority: (address) => (address === f.addresses.b ? "unknown" : "verified-active"),
      },
    })
    expect(o.code).toBe(3)
    const a = linkedId(f.addresses.a as string)
    expect(rebind.bodies[0]).toEqual({ dryRun: true, toKeyPrefix: TO, wallets: [a] })
    expect(o.err).toContain("1 wallet cannot be rebound yet (only a verified-active wallet moves):")
    expect(o.err).toContain(`  b (${f.addresses.b}): remote authority is unknown, not verified-active`)
    const body = JSON.parse(jsonDocuments(o.out)[0] as string)
    expect(body).toMatchObject({ ok: true, complete: false })
    expect(body.keys[0]).toMatchObject({ boundKeyPrefix: TO, rebind: { state: "rebound" } })
    expect(body.keys[1]).toMatchObject({
      boundKeyPrefix: IMPORTED_TO,
      rebind: { state: "not-rebindable", reason: "remote authority is unknown, not verified-active" },
    })
    expect(body.rebind).toMatchObject({ ok: false, reached: true, rebound: 1, notRebindable: 1, pending: [] })
  })
})

describe("promote-batch --to-key: every target refusal is before the unlock, with zero writes", () => {
  async function refused(
    args: string[],
    api: Parameters<typeof runBatch>[1]["api"],
    opts: { deviceToken?: boolean } = {},
  ) {
    const f = await fixture(["a", "b", "cold"])
    const before = await readEntries(f)
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, { file, json: true, deviceToken: opts.deviceToken ?? true, args, api })
    expect(o.code).toBe(1)
    // Zero writes, before the unlock: no passphrase asked, no prompt, no import, no rebind, same bytes.
    expect(o.secretPrompts).toBe(0)
    expect(o.linePrompts).toEqual([])
    expect(o.inits.n).toBe(0)
    expect(o.submits.n).toBe(0)
    expect(rebindCalls(o)).toHaveLength(0)
    const after = await readEntries(f)
    expect(after.generation).toBe(before.generation)
    expect(after.entries.every((e) => e.role === "vault" && e.tee === undefined)).toBe(true)
    const docs = jsonDocuments(o.out)
    expect(docs).toHaveLength(1)
    const body = JSON.parse(docs[0] as string)
    expect(body.ok).toBe(false)
    return { body, o }
  }

  test("unknown label: REBIND_KEY_NOT_FOUND, listing the named keys", async () => {
    const { body } = await refused(["--to-key", "nope"], { keys: keysListing() })
    expect(body.code).toBe("REBIND_KEY_NOT_FOUND")
    expect(body.suggestion).toContain(`${TO} ${TO_LABEL}`)
  })

  test("ambiguous label: REBIND_KEY_AMBIGUOUS, listing the prefixes", async () => {
    const { body } = await refused(["--to-key", TO_LABEL], {
      keys: keysListing({}, [
        { keyPrefix: "Cd4eFg0i", label: TO_LABEL, scopes: ["swap:write"], environment: "production", createdAt: 4 },
      ]),
    })
    expect(body.code).toBe("REBIND_KEY_AMBIGUOUS")
    expect(body.suggestion).toContain(TO)
    expect(body.suggestion).toContain("Cd4eFg0i")
  })

  test("a prefix on another account (not in the listing): REBIND_KEY_NOT_FOUND", async () => {
    const { body } = await refused(["--to-key", "Zz9zZz9z"], { keys: keysListing() })
    expect(body.code).toBe("REBIND_KEY_NOT_FOUND")
    expect(body.message).toContain("No key Zz9zZz9z on this account")
  })

  test("revoked, expired, test key and missing swap:write: REBIND_TARGET_INVALID with the reason", async () => {
    const cases: Array<[KeyRowIn, string]> = [
      [{ revokedAt: 5 }, "is revoked"],
      // The test clock starts at 0, so an `expiresAt` of 0 is "now" and expired, as the mutation reads it.
      [{ expiresAt: 0 }, "has expired"],
      [{ environment: "test" }, "is a test key"],
      [{ scopes: ["read", "launch:write"] }, "lacks swap:write"],
    ]
    for (const [patch, reason] of cases) {
      const { body } = await refused(["--to-key", TO], { keys: keysListing(patch) })
      expect([reason, body.code]).toEqual([reason, "REBIND_TARGET_INVALID"])
      expect(body.message).toContain(reason)
      expect(body.message).toContain("Nothing was written.")
    }
  })

  test("a selected-scope key without room for the file: REBIND_SCOPE_FULL", async () => {
    const held = Array.from({ length: 49 }, (_, i) => ({
      linkedWalletId: `lw_h${i}`,
      assignedAt: 1,
      chain: "solana",
      address: `H${i}`,
      label: `held-${i}`,
      spendCapable: true,
    }))
    const { body, o } = await refused(["--to-key", TO], {
      keys: keysListing({ walletScope: "selected" }),
      routes: {
        [`/api/v1/agent/keys/${TO}/wallets`]: () =>
          jsonResponse(200, { keyPrefix: TO, profileId: null, walletScope: "selected", wallets: held }),
      },
    })
    expect(body.code).toBe("REBIND_SCOPE_FULL")
    expect(body.message).toContain(`holds 49 of 50; the 2 this run would move do not fit`)
    // The wallet set was read with the calling API key on the same account.
    const read = o.calls.find((c) => c.url.includes(`/keys/${TO}/wallets`))
    expect((read?.init.headers as Record<string, string>)["x-api-key"]).toBe(API_KEY)
  })

  test("only an API key, no device token: DEVICE_TOKEN_REQUIRED with candle auth login, before any request that writes", async () => {
    const { body, o } = await refused(["--to-key", TO], { keys: keysListing() }, { deviceToken: false })
    expect(body).toEqual({
      ok: false,
      code: "DEVICE_TOKEN_REQUIRED",
      message: "Moving a TEE wallet needs the device token, the owner's credential; an API key cannot do it.",
      suggestion: "Run: candle auth login",
    })
    // The only request is the account guard's own read, which every run makes first.
    expect(o.calls.every((c) => c.url.endsWith("/api/v1/agent/wallets/embedded"))).toBe(true)
  })

  test("an empty --to-key is a usage error, exit 2", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, { file, json: true, deviceToken: true, args: ["--to-key", " "] })
    expect(o.code).toBe(2)
    expect(o.secretPrompts).toBe(0)
  })
})

describe("promote-batch --to-key: partial failure and the re-run", () => {
  test("the rebind fails after both imports: exit 1, both wallets named as on the calling key with the finishing command; the re-run rebinds them", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const a = linkedId(f.addresses.a as string)
    const b = linkedId(f.addresses.b as string)
    const failing = rebindRoute({
      failCommit: refusal(409, "REBIND_BUILD_OPEN", { walletIds: [a], retryAfter: Date.UTC(2026, 8, 24, 12) }),
    })
    const first = await runBatch(f, {
      file,
      ack: "correct",
      json: true,
      deviceToken: true,
      args: ["--to-key", TO],
      api: { keys: keysListing(), rebind: failing.handler },
    })
    expect(first.code).toBe(1)
    expect(first.submits.n).toBe(2)
    expect(failing.bodies).toHaveLength(2)
    expect(first.err).toContain(
      "Rebind REBIND_BUILD_OPEN: server says REBIND_BUILD_OPEN Stop the agent on key ck_live_p",
    )
    expect(first.err).toContain(`2 promoted wallets are still bound to the calling key ${KEY_PREFIX}, not ${TO}:`)
    expect(first.err).toContain(`  a (${f.addresses.a})`)
    expect(first.err).toContain(`  b (${f.addresses.b})`)
    expect(first.err).toContain(`Finish with:\n  candle tee rebind ${f.addresses.a} ${f.addresses.b} --to-key ${TO}`)
    const doc = JSON.parse(jsonDocuments(first.out)[0] as string)
    expect(doc).toMatchObject({ ok: false, complete: false, promoted: 2 })
    expect(
      doc.keys.map((k: { boundKeyPrefix: string; rebind: { state: string } }) => [k.boundKeyPrefix, k.rebind.state]),
    ).toEqual([
      [IMPORTED_TO, "failed"],
      [IMPORTED_TO, "failed"],
    ])
    expect(doc.rebind).toMatchObject({
      ok: false,
      reached: true,
      code: "REBIND_BUILD_OPEN",
      pending: [f.addresses.a, f.addresses.b],
      finishWith: [`candle tee rebind ${f.addresses.a} ${f.addresses.b} --to-key ${TO}`],
    })
    // The imports are in the vault: both enabled, both linked.
    const entries = (await readEntries(f)).entries
    for (const label of ["a", "b"]) {
      const entry = entries.find((e) => e.label === label)
      expect(entry?.tee?.lifecycle).toBe("enabled")
      expect(entry?.linkedWalletId).toBe(linkedId(f.addresses[label] as string))
    }

    // The re-run: every row already landed, so nothing is promoted; the rebind is acknowledged
    // and runs, and this time the server accepts it.
    const working = rebindRoute()
    const second = await runBatch(f, {
      file,
      ack: "correct",
      json: true,
      deviceToken: true,
      args: ["--to-key", TO],
      api: { keys: keysListing(), rebind: working.handler },
    })
    expect(second.code).toBe(0)
    expect(second.submits.n).toBe(0)
    expect(second.linePrompts).toEqual([`Type confirm to move these 2 wallets to ${TO}: `])
    expect(second.err).toContain("Every row already landed; 2 wallets to rebind.")
    expect(second.stderrAtPrompt[0]?.endsWith(`\n${targetBlock(2)}\n`)).toBe(true)
    expect(working.bodies).toEqual([
      { dryRun: true, toKeyPrefix: TO, wallets: [a, b] },
      { toKeyPrefix: TO, walletIds: [a, b], expect: { [a]: IMPORTED_TO, [b]: IMPORTED_TO } },
    ])
    const again = JSON.parse(jsonDocuments(second.out)[0] as string)
    expect(again).toMatchObject({ ok: true, complete: true, promoted: 0, skipped: 2 })
    expect(
      again.keys.map((k: { state: string; boundKeyPrefix: string; rebind: { state: string } }) => [
        k.state,
        k.boundKeyPrefix,
        k.rebind.state,
      ]),
    ).toEqual([
      ["skipped", TO, "rebound"],
      ["skipped", TO, "rebound"],
    ])
    expect(again.rebind).toMatchObject({ ok: true, rebound: 2, pending: [], finishWith: [] })
  })

  test("a re-run whose wallets are already on the target sends no commit and reports them unchanged", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const a = linkedId(f.addresses.a as string)
    const b = linkedId(f.addresses.b as string)
    const done = await runBatch(f, {
      file,
      ack: "correct",
      deviceToken: true,
      args: ["--to-key", TO],
      api: { keys: keysListing(), rebind: rebindRoute().handler },
    })
    expect(done.code).toBe(0)
    const already = rebindRoute({ alreadyThere: [a, b] })
    const o = await runBatch(f, {
      file,
      ack: "correct",
      json: true,
      deviceToken: true,
      args: ["--to-key", TO],
      api: { keys: keysListing(), rebind: already.handler },
    })
    expect(o.code).toBe(0)
    expect(already.bodies).toHaveLength(1)
    expect(o.err).toContain(`✓ 0 wallets moved to key ${TO} (2 already there) in 1 request.`)
    const body = JSON.parse(jsonDocuments(o.out)[0] as string)
    expect(body.keys.map((k: { rebind: { state: string } }) => k.rebind.state)).toEqual(["unchanged", "unchanged"])
    expect(body.rebind).toMatchObject({ ok: true, requests: 1, rebound: 0, unchanged: 2 })
  })

  test("the batch stops at row 2: the rebind is not reached, row 1's wallet is named as on the calling key with the finishing command", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const rebind = rebindRoute()
    const o = await runBatch(f, {
      file,
      ack: "correct",
      json: true,
      deviceToken: true,
      args: ["--to-key", TO],
      api: {
        keys: keysListing(),
        rebind: rebind.handler,
        submit: (n) => (n === 2 ? refusal(500, "WALLET_IMPORT_FAILED") : undefined),
      },
    })
    expect(o.code).toBe(1)
    expect(rebind.bodies).toHaveLength(0)
    expect(o.err).toContain("1 of 2 rows landed and ARE in the vault")
    expect(o.err).toContain(`1 promoted wallet is still bound to the calling key ${KEY_PREFIX}, not ${TO}:`)
    expect(o.err).toContain(`  candle tee rebind ${f.addresses.a} --to-key ${TO}`)
    const body = JSON.parse(jsonDocuments(o.out)[0] as string)
    expect(body).toMatchObject({ ok: false, complete: false, failedLine: 2 })
    expect(body.keys).toHaveLength(1)
    expect(body.keys[0]).toMatchObject({ boundKeyPrefix: IMPORTED_TO, rebind: { state: "not-reached" } })
    expect(body.rebind).toMatchObject({
      ok: false,
      reached: false,
      requests: 0,
      pending: [f.addresses.a],
      finishWith: [`candle tee rebind ${f.addresses.a} --to-key ${TO}`],
    })
    expect(body.toKey.keyPrefix).toBe(TO)
  })
})

describe("promote-batch without --to-key is unchanged", () => {
  test("no rebind request, no key wallet read, and none of the new keys in the document", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, { file, ack: "correct", json: true, deviceToken: true, api: { keys: keysListing() } })
    expect(o.code).toBe(0)
    expect(rebindCalls(o)).toHaveLength(0)
    expect(o.calls.some((c) => c.url.includes("/keys/") && c.url.endsWith("/wallets"))).toBe(false)
    const body = JSON.parse(jsonDocuments(o.out)[0] as string)
    expect(body.toKey).toBeUndefined()
    expect(body.rebind).toBeUndefined()
    expect(body.keys[0].boundKeyPrefix).toBeUndefined()
    expect(body.keys[0].rebind).toBeUndefined()
    expect(body.controlledBy).toEqual({
      account: ACCOUNT,
      username: USERNAME,
      keyPrefix: KEY_PREFIX,
      keyLabel: KEY_LABEL,
      keySource: "profile",
      apiUrl: API,
      environment: null,
    })
    expect(o.err).toContain(`  API key         ${KEY_PREFIX}…  (${KEY_LABEL})  profile pb`)
    expect(o.err).not.toContain("imported under")
  })
})

// ── Single promote ──────────────────────────────────────────────────────────────────────────

const ENCRYPTION_PUBLIC_KEY = await (async () => {
  const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  return Buffer.from(await crypto.subtle.exportKey("raw", receiver.publicKey)).toString("base64")
})()

async function runSingle(
  f: Fixture,
  opts: {
    args: string[]
    lines: string[]
    json?: boolean
    deviceToken?: boolean
    keys?: RouteHandler
    rebind?: RouteHandler
    remoteAuthority?: string
    /** Extra routes, matched before the defaults. */
    routes?: Record<string, RouteHandler>
    /** Rows `GET /wallets` returns. A resume needs the server's grant for the subject. */
    walletPage?: Array<Record<string, unknown>>
  },
) {
  const out = createCapture()
  const err = createCapture()
  const submits = { n: 0, addresses: [] as string[] }
  const { fetch, calls } = createRoutedFetch({
    ...(opts.routes ?? {}),
    "/api/v1/agent/wallets/import/init": () => {
      return jsonResponse(200, { success: true, encryptionPublicKey: ENCRYPTION_PUBLIC_KEY })
    },
    "/api/v1/agent/wallets/import/submit": (req) => {
      submits.n += 1
      const address = parse(req).address as string
      submits.addresses.push(address)
      return jsonResponse(200, {
        success: true,
        id: linkedId(address),
        address,
        chain: "solana",
        privyWalletId: `pw_${address.slice(0, 6)}`,
        profile: "ember-tee",
        boundKeyPrefix: IMPORTED_TO,
        vaultDestination: f.addresses.cold,
        remoteAuthority: opts.remoteAuthority ?? "verified-active",
      })
    },
    "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: ACCOUNT, username: USERNAME }),
    "/api/v1/agent/wallets": () => jsonResponse(200, { page: opts.walletPage ?? [], isDone: true }),
    "/api/v1/agent/wallets/import-failures": () =>
      jsonResponse(200, { success: true, account: ACCOUNT, failures: [], complete: true }),
    "/api/v1/agent/wallets/room": () =>
      jsonResponse(200, { success: true, tier: "max", active: 0, cap: 1000, room: 1000 }),
    "/api/v1/agent/keys": opts.keys ?? keysListing(),
    "/api/v1/agent/tee-wallets/rebind": opts.rebind ?? (() => jsonResponse(404, { error: "Not Found" })),
    "/rpc": (req) => {
      const body = parse(req)
      const id = body.id
      switch (body.method) {
        case "getBalance":
          return jsonResponse(200, { jsonrpc: "2.0", id, result: { value: 42 } })
        case "getTokenAccountsByOwner":
          return jsonResponse(200, { jsonrpc: "2.0", id, result: { value: [] } })
        case "getProgramAccounts":
          return jsonResponse(200, { jsonrpc: "2.0", id, result: [] })
        default:
          return jsonResponse(200, { jsonrpc: "2.0", id, result: null })
      }
    },
  })
  const lines = [...opts.lines]
  const linePrompts: string[] = []
  const stderrAtPrompt: string[] = []
  let secretPrompts = 0
  const deps = createTestDeps({
    fetch,
    store: createFakeStore({
      "profile:pb:api_key": API_KEY,
      ...(opts.deviceToken === false ? {} : { "profile:pb:device_token": DEVICE_TOKEN }),
    }),
    stdout: out,
    stderr: err,
    env: { CANDLE_CONFIG_DIR: f.dir, CANDLE_API_URL: API },
    isTTY: { stdin: true, stdout: true, stderr: true },
    promptSecret: async () => {
      secretPrompts += 1
      return f.passphrase
    },
    promptLine: async (text: string) => {
      linePrompts.push(text)
      stderrAtPrompt.push(err.text)
      return lines.shift() ?? ""
    },
    readFile: (path) => readFile(path, "utf8"),
    writeFile: (path, content) => writeFile(path, content, "utf8"),
  })
  await deps.writeConfig({
    activeProfile: "pb",
    profiles: { pb: { account: ACCOUNT, apiUrl: API, accountCachedAt: Date.now() } },
  })
  const code = await run(["vault", "promote", ...opts.args, ...(opts.json ? ["--json"] : [])], deps)
  return { code, out: out.text, err: err.text, calls, submits, secretPrompts, linePrompts, stderrAtPrompt }
}

describe("vault promote --to-key", () => {
  const inPlace = (f: Fixture) => [
    "--in-place",
    "subject",
    "--sweep-to",
    "cold",
    "--rpc-url",
    RPC,
    "--to-key",
    TO_LABEL,
  ]

  test("--in-place: the block names the target, one preview and one commit after the import, the document carries the final key", async () => {
    const f = await fixture(["subject", "cold"])
    const rebind = rebindRoute()
    const r = await runSingle(f, {
      args: inPlace(f),
      lines: [(f.addresses.subject as string).slice(-6), "confirm"],
      json: true,
      rebind: rebind.handler,
    })
    expect(r.code).toBe(0)
    expect(r.submits.n).toBe(1)
    const id = linkedId(f.addresses.subject as string)
    expect(rebind.bodies).toEqual([
      { dryRun: true, toKeyPrefix: TO, wallets: [id] },
      { toKeyPrefix: TO, walletIds: [id], expect: { [id]: IMPORTED_TO } },
    ])
    // The block, directly above the confirm prompt, names the target and the import key.
    expect(r.linePrompts[1]).toBe("Type confirm to accept this for this key: ")
    expect(r.stderrAtPrompt[1]?.endsWith(`\n${targetBlock(1)}\n`)).toBe(true)
    expect(r.err).toContain(`✓ 1 wallet moved to key ${TO} in 2 requests.`)
    const body = lastLine(r.out)
    expect(body).toMatchObject({
      ok: true,
      mode: "in-place",
      address: f.addresses.subject,
      lifecycle: "enabled",
      linkedWalletId: id,
      boundKeyPrefix: TO,
      walletRebind: { state: "rebound", auditId: `aud-${id}` },
      toKey: { keyPrefix: TO, label: TO_LABEL },
      rebind: { ok: true, reached: true, requests: 2, rebound: 1, pending: [], finishWith: [] },
    })
    expect(body.controlledBy).toMatchObject({
      keyPrefix: TO,
      keySource: "--to-key",
      importedUnder: { keyPrefix: KEY_PREFIX },
    })
  })

  test("--in-place: the rebind refused after the import leaves the wallet on the calling key, exit 1, with the finishing command", async () => {
    const f = await fixture(["subject", "cold"])
    const rebind = rebindRoute({ failCommit: refusal(409, "REBIND_FORWARD_OPEN", { walletIds: ["x"] }) })
    const r = await runSingle(f, {
      args: inPlace(f),
      lines: [(f.addresses.subject as string).slice(-6), "confirm"],
      json: true,
      rebind: rebind.handler,
    })
    expect(r.code).toBe(1)
    expect(r.submits.n).toBe(1)
    expect(r.err).toContain("A sign for these wallets is still in flight or not yet expired; nothing changed.")
    expect(r.err).toContain(`1 promoted wallet is still bound to the calling key ${KEY_PREFIX}, not ${TO}:`)
    expect(r.err).toContain(`  candle tee rebind ${f.addresses.subject} --to-key ${TO}`)
    const body = lastLine(r.out)
    expect(body).toMatchObject({
      ok: false,
      mode: "in-place",
      lifecycle: "enabled",
      boundKeyPrefix: IMPORTED_TO,
      walletRebind: { state: "failed" },
      rebind: {
        ok: false,
        code: "REBIND_FORWARD_OPEN",
        finishWith: [`candle tee rebind ${f.addresses.subject} --to-key ${TO}`],
      },
    })
    // The import itself is in the vault.
    const entry = (await readEntries(f)).entries.find((e) => e.label === "subject")
    expect(entry?.tee?.lifecycle).toBe("enabled")
  })

  test("--in-place: a target refusal is before the passphrase and before any request that writes", async () => {
    for (const [args, code, deviceToken] of [
      [inPlace(await fixture(["subject", "cold"])), "DEVICE_TOKEN_REQUIRED", false],
      [
        ["--in-place", "subject", "--sweep-to", "cold", "--rpc-url", RPC, "--to-key", "nope"],
        "REBIND_KEY_NOT_FOUND",
        true,
      ],
    ] as Array<[string[], string, boolean]>) {
      const f = await fixture(["subject", "cold"])
      const before = await readEntries(f)
      const r = await runSingle(f, { args, lines: [], json: true, deviceToken })
      expect([code, r.code]).toEqual([code, 1])
      expect(r.secretPrompts).toBe(0)
      expect(r.linePrompts).toEqual([])
      expect(r.submits.n).toBe(0)
      // Only the account guard's read and the key listing: nothing that writes.
      expect(
        r.calls.filter((c) => !c.url.endsWith("/api/v1/agent/keys") && !c.url.endsWith("/wallets/embedded")),
      ).toHaveLength(0)
      expect((await readEntries(f)).generation).toBe(before.generation)
      expect(JSON.parse(r.out.trim()).code).toBe(code)
    }
  })

  test("--from: the target is named before the import, and the fresh wallet is rebound", async () => {
    const f = await fixture(["cold"])
    const rebind = rebindRoute()
    const r = await runSingle(f, {
      args: ["--from", "cold", "--to-key", TO],
      lines: [(f.addresses.cold as string).slice(-6)],
      json: true,
      rebind: rebind.handler,
    })
    expect(r.code).toBe(0)
    expect(r.submits.n).toBe(1)
    const address = r.submits.addresses[0] as string
    expect(r.err).toContain(`This wallet will be bound to key ${TO}  (${TO_LABEL}) by a rebind after the import.`)
    expect(r.err).toContain(`Warning: key ${TO} can trade SOL-quoted swaps`)
    expect(rebind.bodies[0]).toEqual({ dryRun: true, toKeyPrefix: TO, wallets: [linkedId(address)] })
    const body = lastLine(r.out)
    expect(body).toMatchObject({
      ok: true,
      mode: "fresh",
      address,
      boundKeyPrefix: TO,
      walletRebind: { state: "rebound" },
    })
  })

  test("without --to-key the in-place document and block are unchanged", async () => {
    const f = await fixture(["subject", "cold"])
    const r = await runSingle(f, {
      args: ["--in-place", "subject", "--sweep-to", "cold", "--rpc-url", RPC],
      lines: [(f.addresses.subject as string).slice(-6), "confirm"],
      json: true,
    })
    expect(r.code).toBe(0)
    expect(r.calls.some((c) => c.url.includes("/tee-wallets/rebind"))).toBe(false)
    const body = lastLine(r.out)
    expect(body.boundKeyPrefix).toBeUndefined()
    expect(body.toKey).toBeUndefined()
    expect(body.rebind).toBeUndefined()
    expect(body.controlledBy.keySource).toBe("profile")
    expect(r.err).not.toContain("imported under")
  })

  test("--in-place resume: names the target and requires confirm before the rebind", async () => {
    const f = await fixture(["subject", "cold"])
    const cold = f.addresses.cold as string
    const subject = f.addresses.subject as string
    await seed(f, (e) => (e.label === "subject" ? { ...e, ...teeSeed("import-pending", cold, { grant: true }) } : e))
    const rebind = rebindRoute()
    const id = linkedId(subject)
    const r = await runSingle(f, {
      args: ["--in-place", "subject", "--to-key", TO_LABEL],
      lines: ["confirm"],
      json: true,
      rebind: rebind.handler,
      walletPage: [
        {
          _id: id,
          address: subject,
          vaultDestination: cold,
          boundKeyPrefix: IMPORTED_TO,
          remoteAuthority: "verified-active",
        },
      ],
    })
    expect(r.code).toBe(0)
    expect(r.submits.n).toBe(0)
    expect(r.linePrompts).toEqual([`Type confirm to move this wallet to ${TO}: `])
    expect(r.stderrAtPrompt[0]).toContain(
      `This wallet will be bound to key ${TO}  (${TO_LABEL}) by a rebind after the import.`,
    )
    expect(r.stderrAtPrompt[0]).toContain(`Warning: key ${TO} can trade SOL-quoted swaps`)
    expect(rebind.bodies).toEqual([
      { dryRun: true, toKeyPrefix: TO, wallets: [id] },
      { toKeyPrefix: TO, walletIds: [id], expect: { [id]: IMPORTED_TO } },
    ])
    const body = lastLine(r.out)
    expect(body).toMatchObject({
      ok: true,
      mode: "resume",
      address: subject,
      boundKeyPrefix: TO,
      walletRebind: { state: "rebound" },
    })
  })

  test("--in-place resume: a wrong acknowledgement rebinds nothing and writes nothing", async () => {
    const f = await fixture(["subject", "cold"])
    await seed(f, (e) =>
      e.label === "subject" ? { ...e, ...teeSeed("import-pending", f.addresses.cold, { grant: true }) } : e,
    )
    const before = await readEntries(f)
    const rebind = rebindRoute()
    const r = await runSingle(f, {
      args: ["--in-place", "subject", "--to-key", TO],
      lines: ["no"],
      json: true,
      rebind: rebind.handler,
    })
    expect(r.code).toBe(1)
    expect(r.linePrompts).toEqual([`Type confirm to move this wallet to ${TO}: `])
    expect(rebind.bodies).toHaveLength(0)
    expect(r.calls.some((c) => c.url.includes("/tee-wallets/rebind"))).toBe(false)
    expect(r.calls.some((c) => c.url.endsWith("/api/v1/agent/wallets"))).toBe(false)
    expect((await readEntries(f)).generation).toBe(before.generation)
    expect(JSON.parse(r.out.trim()).code).toBe("PROMOTE_NOT_ACKNOWLEDGED")
  })

  test("--from without --label: a selected target at the cap is refused before the unlock", async () => {
    const f = await fixture(["cold"])
    const before = await readEntries(f)
    const held = Array.from({ length: 50 }, (_, i) => ({
      linkedWalletId: `lw_h${i}`,
      assignedAt: 1,
      chain: "solana",
      address: `H${i}`,
      label: `held-${i}`,
      spendCapable: true,
    }))
    const r = await runSingle(f, {
      args: ["--from", "cold", "--to-key", TO],
      lines: [],
      json: true,
      keys: keysListing({ walletScope: "selected" }),
      routes: {
        [`/api/v1/agent/keys/${TO}/wallets`]: () =>
          jsonResponse(200, { keyPrefix: TO, profileId: null, walletScope: "selected", wallets: held }),
      },
    })
    expect(r.code).toBe(1)
    expect(r.secretPrompts).toBe(0)
    expect(r.linePrompts).toEqual([])
    expect(r.submits.n).toBe(0)
    expect((await readEntries(f)).generation).toBe(before.generation)
    const body = JSON.parse(r.out.trim())
    expect(body.code).toBe("REBIND_SCOPE_FULL")
    expect(body.message).toContain("holds 50 of 50; the 1 this run would move do not fit")
  })
})
