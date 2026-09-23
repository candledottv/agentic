/**
 * T55 (CC-11): `vault restore --phrase` and `vault reconcile-exposure`.
 *
 * The defect this covers is COMPLETENESS OF THE READ, and it is why the fake API here is driven
 * through shapes a naive caller gets wrong: a revoked row (dropped by the route's default), a match
 * on page three (missed by a single-page caller), a page that errors mid-walk, and a first page
 * that succeeds followed by a transport failure. Every incomplete case must refuse to re-flag
 * ANYTHING and exit 3, because a partial list that happens to list nothing reads as good news
 * exactly when it is worst.
 *
 * The other half is CC-11's separation of recovery from allocation. A restored vault does not
 * allocate, permanently, and the test asserts that as a refusal on the FIRST call rather than as a
 * flag that survives: no sequence of `new-key` calls may reach an index the restore did not see.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Deps } from "../deps"
import { run } from "../index"
import { SECRET_REFS } from "../secret-store"
import {
  createCapture,
  createFakeStore,
  createRoutedFetch,
  createTestDeps,
  jsonResponse,
  type RouteHandler,
} from "../test-support"
import { deriveSolanaKey, solanaExternalPath, solanaTeePath, solanaVaultPath } from "../vault/hd"
import { FIXTURE_ENTROPY, FIXTURE_PHRASE, generatedPassphraseFrom, useCheapKdf } from "../vault/test-vault"

/**
 * These tests run REAL Argon2id, which is the point of them: a vault suite that stubbed the KDF
 * would not be testing the format anyone actually opens. Even at ED-3's bounds floor (see
 * `useCheapKdf`) a single derivation is a few hundred milliseconds, several tests here do five or
 * six of them, and a CI runner sharing a box with every other workspace's suite is slower again.
 * Bun's default per-test budget is 5 s, which one of these exceeded on CI while passing locally --
 * so the budget is stated here rather than discovered once per runner.
 */
setDefaultTimeout(30_000)

useCheapKdf()

const ACCOUNT = "AcctAddress1111111111111111111abcdef"

/** The addresses the fixture phrase derives, so a fake API can list exactly the right ones. */
const derived = {
  vault0: (await deriveSolanaKey(Uint8Array.from(FIXTURE_ENTROPY), solanaVaultPath(0))).address,
  vault1: (await deriveSolanaKey(Uint8Array.from(FIXTURE_ENTROPY), solanaVaultPath(1))).address,
  tee0: (await deriveSolanaKey(Uint8Array.from(FIXTURE_ENTROPY), solanaTeePath(0))).address,
  external0: (await deriveSolanaKey(Uint8Array.from(FIXTURE_ENTROPY), solanaExternalPath(0))).address,
  external2: (await deriveSolanaKey(Uint8Array.from(FIXTURE_ENTROPY), solanaExternalPath(2))).address,
}

function row(address: string, extra: Record<string, unknown> = {}) {
  return { _id: `w-${address.slice(0, 6)}`, address, chain: "solana", ...extra }
}

interface ApiScript {
  /** One handler per `GET /wallets` call, in order; the last repeats. */
  pages?: RouteHandler[]
  embedded?: RouteHandler
  /** A Solana JSON-RPC for the gap scan; absent means no `/rpc` route exists at all. */
  rpc?: RouteHandler
}

async function harness(script: ApiScript = {}) {
  const dir = await mkdtemp(join(tmpdir(), "candle-vault-restore-"))
  const stdout = createCapture()
  const stderr = createCapture()
  const secrets: string[] = []
  const lines: string[] = []
  const routed = createRoutedFetch({
    "/api/v1/agent/wallets/embedded": script.embedded ?? (() => jsonResponse(200, { success: true, account: ACCOUNT })),
    "/api/v1/agent/wallets": script.pages ?? [() => jsonResponse(200, { success: true, page: [], isDone: true })],
    ...(script.rpc ? { "/rpc": script.rpc } : {}),
  })
  const deps: Deps = createTestDeps({
    fetch: routed.fetch,
    stdout,
    stderr,
    // An API key must be stored, or the restore reads no exposure at all.
    store: createFakeStore({ [SECRET_REFS.apiKey]: "ck_live_testkey" }),
    env: { CANDLE_CONFIG_DIR: dir, HOME: dir },
    isTTY: { stdin: true, stdout: true, stderr: true },
    promptSecret: async () => {
      const next = secrets.shift()
      if (next === undefined) throw new Error("promptSecret asked for more than the test scripted")
      return next
    },
    promptLine: async () => {
      const next = lines.shift()
      if (next === undefined) throw new Error("promptLine asked for more than the test scripted")
      return next
    },
  })
  return { deps, stdout, stderr, dir, vaultPath: join(dir, "vault.enc"), secrets, lines, routed }
}

/** Drives a restore: the phrase, then the generated passphrase read off the screen, then the account. */
async function restore(h: Awaited<ReturnType<typeof harness>>, args: string[] = []): Promise<number> {
  let askedPhrase = false
  h.deps.promptSecret = async () => {
    if (!askedPhrase) {
      askedPhrase = true
      return FIXTURE_PHRASE
    }
    return generatedPassphraseFrom(h.stdout.text)
  }
  h.deps.promptLine = async (text: string) => (text.includes("last six characters") ? ACCOUNT.slice(-6) : "no")
  return run(["vault", "restore", "--phrase", ...args, "--keystore", h.vaultPath], h.deps)
}

describe("T55: a valid phrase builds a new vault, and a bad one writes nothing", () => {
  test("a checksum failure writes nothing at all", async () => {
    const h = await harness()
    h.deps.promptSecret = async () =>
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon"
    expect(await run(["vault", "restore", "--phrase", "--keystore", h.vaultPath], h.deps)).toBe(1)
    expect(h.stderr.text).toContain("checksum does not match")
    await expect(readFile(h.vaultPath, "utf8")).rejects.toThrow()
  })

  test("a valid phrase produces a new vaultId and DEK with the SAME root, and the verifier passes", async () => {
    const h = await harness({ pages: [() => jsonResponse(200, { success: true, page: [], isDone: true })] })
    expect(await restore(h, ["--count", "1"])).toBe(0)
    expect(h.stdout.text).toContain("verified in full (all eight steps)")

    const file = JSON.parse(await readFile(h.vaultPath, "utf8")) as { vaultId: string }
    expect(file.vaultId).toHaveLength(22)
    // The same root: the derived address matches what the phrase determines, which is the whole
    // promise of AD-5.
    expect(h.stdout.text).toContain(derived.vault0)
  })

  test("every derived entry is exposureUnknown, and the output says so in words", async () => {
    const h = await harness()
    expect(await restore(h, ["--count", "2"])).toBe(0)
    expect(h.stdout.text).toContain("recorded with an unknown history and stays that way")

    const { reopen } = await import("../vault/test-vault")
    const vault = await reopen(h.vaultPath, generatedPassphraseFrom(h.stdout.text))
    // vault 0 and 1, TEE 0, and (R6) external 0: the third branch defaults to 1 like the other two.
    expect(vault.index.entries).toHaveLength(4)
    for (const entry of vault.index.entries) expect(entry.exposure.exposureUnknown).toBe(true)
  })

  test("a vault already at the path is refused: restore never merges into one", async () => {
    const h = await harness()
    await restore(h, ["--count", "1"])
    const second = await harness()
    second.vaultPath = h.vaultPath
    expect(await restore(second, ["--count", "1"])).toBe(1)
    expect(second.stderr.text).toContain("never merges into one")
  })
})

describe("T55: bounds", () => {
  test("--count and --tee-count re-derive exactly indices 0 to n-1 on each branch", async () => {
    const h = await harness()
    expect(await restore(h, ["--count", "2", "--tee-count", "1"])).toBe(0)
    expect(h.stdout.text).toContain(derived.vault0)
    expect(h.stdout.text).toContain(derived.vault1)
    expect(h.stdout.text).toContain(derived.tee0)
  })

  test("each count defaults to 1 when another is given, and all three do when none is", async () => {
    const { parseCounts } = await import("./vault-restore")
    expect(parseCounts(undefined, undefined, undefined, undefined)).toMatchObject({
      solanaVault: 1,
      solanaTee: 1,
      solanaExternal: 1,
    })
    expect(parseCounts("5", undefined, undefined, undefined)).toMatchObject({
      solanaVault: 5,
      solanaTee: 1,
      solanaExternal: 1,
    })
    expect(parseCounts(undefined, "3", undefined, undefined)).toMatchObject({ solanaVault: 1, solanaTee: 3 })
    // R6: the third branch, on the same rules.
    expect(parseCounts(undefined, undefined, "2", undefined)).toMatchObject({
      solanaVault: 1,
      solanaTee: 1,
      solanaExternal: 2,
    })
    // With an --rpc-url and no explicit count, a branch is gap-scanned (undefined = scan).
    expect(parseCounts(undefined, undefined, undefined, "https://rpc.test")).toMatchObject({
      solanaVault: undefined,
      solanaTee: undefined,
      solanaExternal: undefined,
    })
    expect(parseCounts("4", undefined, undefined, "https://rpc.test")).toMatchObject({
      solanaVault: 4,
      solanaTee: undefined,
      solanaExternal: undefined,
    })
    expect(parseCounts("x", undefined, undefined, undefined)).toMatchObject({
      error: expect.stringContaining("--count"),
    })
    expect(parseCounts(undefined, undefined, "-1", undefined)).toMatchObject({
      error: expect.stringContaining("--external-count"),
    })
  })

  test("with neither count and no RPC, index 0 of each branch and the stated note", async () => {
    const h = await harness()
    expect(await restore(h)).toBe(0)
    expect(h.stdout.text).toContain(derived.vault0)
    expect(h.stdout.text).not.toContain(derived.vault1)
    expect(h.stdout.text).toContain("index 0 only")
    expect(h.stdout.text).toContain("re-run with --count/--tee-count/--external-count")
  })

  test("R6: --external-count derives external indices 0 to e-1 as role external, and the vault is version 3", async () => {
    const h = await harness()
    expect(await restore(h, ["--count", "1", "--tee-count", "0", "--external-count", "2"])).toBe(0)
    const external1 = (await deriveSolanaKey(Uint8Array.from(FIXTURE_ENTROPY), solanaExternalPath(1))).address
    expect(h.stdout.text).toContain(`${derived.external0}  m/44'/501'/0'/2'  external`)
    expect(h.stdout.text).toContain(external1)
    expect(h.stdout.text).not.toContain(derived.tee0)
    const { reopen } = await import("../vault/test-vault")
    const vault = await reopen(h.vaultPath, generatedPassphraseFrom(h.stdout.text))
    const externals = vault.index.entries.filter((entry) => entry.role === "external")
    expect(externals.map((entry) => entry.label)).toEqual(["external-0", "external-1"])
    for (const entry of externals)
      expect(entry.exposure).toEqual({ everRemoteExposed: false, everExported: false, exposureUnknown: true })
    expect(vault.index.hd.nextIndex).toMatchObject({ solanaVault: 1, solanaTee: 0, solanaExternal: 2 })
    expect(vault.index.hd.discovery).toMatchObject({
      requestedCounts: { solanaVault: 1, solanaTee: 0, solanaExternal: 2 },
      highestMatched: { solanaVault: -1, solanaTee: -1, solanaExternal: -1 },
    })
    expect(vault.file.version).toBe(3)
  })

  test("R6: a listed address that is an external-branch key is reported in words and never flagged", async () => {
    const h = await harness({
      pages: [() => jsonResponse(200, { success: true, page: [row(derived.external0)], isDone: true })],
    })
    expect(await restore(h, ["--count", "1"])).toBe(0)
    expect(h.stdout.text).toContain("1 address(es) this account imported are external-branch keys of this root")
    expect(h.stdout.text).not.toContain("were NOT derived by this restore")
    const { reopen } = await import("../vault/test-vault")
    const vault = await reopen(h.vaultPath, generatedPassphraseFrom(h.stdout.text))
    const external = vault.index.entries.find((entry) => entry.address === derived.external0)
    expect(external?.role).toBe("external")
    expect(external?.exposure.everRemoteExposed).toBe(false)
    expect(vault.index.hd.exposedIndexes.solanaExternal).toEqual([])
  })

  test("R6: the external branch gap-scans on the same twenty-index rule, and the output says where it stopped", async () => {
    const h = await harness({
      rpc: (req) => {
        const body = JSON.parse(String(req.init.body)) as { id: number; method: string; params: unknown[] }
        const reply = (result: unknown) => jsonResponse(200, { jsonrpc: "2.0", id: body.id, result })
        if (body.method === "getBalance") {
          // External index 2 holds lamports; everything else on chain is empty.
          const external2 = derived.external2
          return reply({ value: (body.params[0] as string) === external2 ? 5 : 0 })
        }
        if (body.method === "getSignaturesForAddress") return reply([])
        if (body.method === "getTokenAccountsByOwner") return reply({ value: [] })
        throw new Error(`unexpected RPC method ${body.method}`)
      },
    })
    expect(await restore(h, ["--count", "1", "--tee-count", "1", "--rpc-url", "https://rpc.test/rpc"])).toBe(0)
    // Index 2 was used, so the scan runs twenty more and stops at index 22.
    expect(h.stdout.text).toContain("Gap scan on solanaExternal stopped at index 22")
    expect(h.stdout.text).toContain("solanaExternal: gap-scanned to index 22")
    const { reopen } = await import("../vault/test-vault")
    const vault = await reopen(h.vaultPath, generatedPassphraseFrom(h.stdout.text))
    expect(vault.index.entries.filter((entry) => entry.role === "external")).toHaveLength(23)
    expect(vault.index.hd.nextIndex.solanaExternal).toBe(23)
  })

  test("R5: an index whose only holding is a Token-2022 account is USED, so the scan continues past it", async () => {
    // BE-218: `addressLooksUsed` read only the classic program, so a vault index holding nothing
    // but a Token-2022 balance looked empty. With twenty empty indices after it, the gap scan
    // would stop one index early and every key past it would be lost to the restore.
    const scanned: string[] = []
    const h = await harness({
      rpc: (req) => {
        const body = JSON.parse(String(req.init.body)) as { id: number; method: string; params: unknown[] }
        const reply = (result: unknown) => jsonResponse(200, { jsonrpc: "2.0", id: body.id, result })
        if (body.method === "getBalance") return reply({ value: 0 })
        if (body.method === "getSignaturesForAddress") return reply([])
        if (body.method === "getTokenAccountsByOwner") {
          const address = body.params[0] as string
          const programId = (body.params[1] as { programId: string }).programId
          scanned.push(`${address}:${programId}`)
          const holds = address === derived.vault0 && programId === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
          return reply({
            value: holds
              ? [
                  {
                    pubkey: "acct2022",
                    account: {
                      data: {
                        parsed: {
                          info: {
                            mint: "So11111111111111111111111111111111111111112",
                            state: "initialized",
                            tokenAmount: { amount: "1", decimals: 0 },
                          },
                        },
                      },
                    },
                  },
                ]
              : [],
          })
        }
        return reply(null)
      },
    })
    expect(await restore(h, ["--rpc-url", "https://rpc.test/rpc"])).toBe(0)
    const { reopen } = await import("../vault/test-vault")
    const vault = await reopen(h.vaultPath, generatedPassphraseFrom(h.stdout.text))
    // Index 0 counted as used, so twenty EMPTY indices (1..20) had to follow before the stop.
    expect(vault.index.hd.nextIndex.solanaVault).toBe(21)
    // The TEE branch held nothing under either program and stopped at twenty.
    expect(vault.index.hd.nextIndex.solanaTee).toBe(20)
    // Both programs were actually asked about, not just the classic one.
    expect(scanned).toContain(`${derived.vault0}:TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`)
    expect(scanned).toContain(`${derived.vault0}:TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`)
  })

  test("nextIndex lands one past the highest derived index, with NO reserve", async () => {
    const h = await harness()
    expect(await restore(h, ["--count", "3", "--tee-count", "2"])).toBe(0)
    const { reopen } = await import("../vault/test-vault")
    const vault = await reopen(h.vaultPath, generatedPassphraseFrom(h.stdout.text))
    expect(vault.index.hd.nextIndex.solanaVault).toBe(3)
    expect(vault.index.hd.nextIndex.solanaTee).toBe(2)
  })
})

describe("T55: completeness of the read, which is the defect this covers", () => {
  test("the caller sends includeRevoked=true, so a revoked row still re-flags", async () => {
    const h = await harness({
      pages: [() => jsonResponse(200, { success: true, page: [row(derived.vault0, { revokedAt: 1 })], isDone: true })],
    })
    expect(await restore(h, ["--count", "1"])).toBe(0)
    // A revoked row is STRONGER evidence of exposure than an active one, not weaker.
    expect(h.stdout.text).toContain("this account imported it")

    const listCalls = h.routed.calls.filter((request) => request.url.includes("/agent/wallets?"))
    expect(listCalls.length).toBeGreaterThan(0)
    for (const call of listCalls) expect(call.url).toContain("includeRevoked=true")
  })

  test("the caller follows continueCursor to isDone; a match on page three is found", async () => {
    const h = await harness({
      pages: [
        () => jsonResponse(200, { success: true, page: [row("Other1")], isDone: false, continueCursor: "100" }),
        () => jsonResponse(200, { success: true, page: [row("Other2")], isDone: false, continueCursor: "200" }),
        () => jsonResponse(200, { success: true, page: [row(derived.vault0)], isDone: true }),
      ],
    })
    // Three pages walked, and the match on the last one is found.
    expect(await restore(h, ["--count", "1"])).toBe(3)
    expect(h.stdout.text).toContain("this account imported it")
    expect(h.routed.calls.filter((request) => request.url.includes("/agent/wallets?"))).toHaveLength(3)
    // Exit 3 because the two unmatched addresses are the ambiguity CC-11 refuses to resolve.
    expect(h.stdout.text).toContain("were NOT derived by this restore")
  })

  test("a single-page caller would fail this: page one alone does not contain the match", async () => {
    // The assertion that makes the test above meaningful rather than incidental.
    const h = await harness({
      pages: [
        () => jsonResponse(200, { success: true, page: [row("Other1")], isDone: false, continueCursor: "100" }),
        () => jsonResponse(200, { success: true, page: [row(derived.vault0)], isDone: true }),
      ],
    })
    await restore(h, ["--count", "1"])
    const firstPage = h.routed.calls.filter((request) => request.url.includes("/agent/wallets?"))
    expect(firstPage.length).toBeGreaterThan(1)
  })

  test("a page that errors mid-walk refuses to re-flag anything and exits 3", async () => {
    const h = await harness({
      pages: [
        () => jsonResponse(200, { success: true, page: [row(derived.vault0)], isDone: false, continueCursor: "100" }),
        () => jsonResponse(500, { success: false, message: "boom" }),
      ],
    })
    expect(await restore(h, ["--count", "1"])).toBe(3)
    expect(h.stdout.text).toContain("No exposure was recorded")
    expect(h.stdout.text).toContain("would read as good news")

    // Nothing flagged: not even the address that DID appear on the first page.
    const { reopen } = await import("../vault/test-vault")
    const vault = await reopen(h.vaultPath, generatedPassphraseFrom(h.stdout.text))
    for (const entry of vault.index.entries) expect(entry.exposure.everRemoteExposed).toBe(false)
  })

  test("a first page that succeeds followed by a page with no cursor is incomplete", async () => {
    const h = await harness({
      pages: [() => jsonResponse(200, { success: true, page: [row(derived.vault0)], isDone: false })],
    })
    expect(await restore(h, ["--count", "1"])).toBe(3)
    expect(h.stdout.text).toContain("No exposure was recorded")
  })

  test("an account the operator did not confirm is refused for exposure, and the vault on disk is complete", async () => {
    const h = await harness({
      pages: [() => jsonResponse(200, { success: true, page: [row(derived.vault0)], isDone: true })],
    })
    let askedPhrase = false
    h.deps.promptSecret = async () => {
      if (!askedPhrase) {
        askedPhrase = true
        return FIXTURE_PHRASE
      }
      return generatedPassphraseFrom(h.stdout.text)
    }
    h.deps.promptLine = async (text: string) => (text.includes("last six characters") ? "wrongs" : "no")
    expect(
      await run(
        ["vault", "restore", "--phrase", "--count", "1", "--tee-count", "1", "--keystore", h.vaultPath],
        h.deps,
      ),
    ).toBe(3)
    expect(h.stdout.text).toContain("EXPOSURE_ACCOUNT_MISMATCH")
    expect(h.stdout.text).toContain("No exposure was recorded")
    expect(h.stdout.text).toContain("candle vault reconcile-exposure")

    // PERSISTED state, not only the exit code: every derived entry is committed, none is flagged
    // (the listed address included), the discovery record is present so the vault does not
    // allocate, and no reconciliation is recorded.
    const passphrase = generatedPassphraseFrom(h.stdout.text)
    const { reopen } = await import("../vault/test-vault")
    const vault = await reopen(h.vaultPath, passphrase)
    expect(vault.index.entries.map((entry) => entry.address).sort()).toEqual(
      [derived.vault0, derived.tee0, derived.external0].sort(),
    )
    for (const entry of vault.index.entries) {
      expect(entry.exposure.exposureUnknown).toBe(true)
      expect(entry.exposure.everRemoteExposed).toBe(false)
    }
    expect(vault.index.hd.discovery).toMatchObject({ complete: false, account: "" })
    expect(vault.index.hd.exposureReconciledAt).toBeUndefined()
    expect(vault.index.hd.nextIndex).toMatchObject({ solanaVault: 1, solanaTee: 1, solanaExternal: 1 })

    const k = await harness()
    k.deps.promptSecret = async () => passphrase
    expect(await run(["vault", "new-key", "--chain", "solana", "--json", "--keystore", h.vaultPath], k.deps)).toBe(1)
    expect(JSON.parse(k.stdout.text)).toMatchObject({ ok: false, code: "VAULT_ALLOCATION_BOUNDARY_UNKNOWN" })

    // The named exit works: reconcile-exposure on the right profile flags the listed address.
    const r = await harness({
      pages: [() => jsonResponse(200, { success: true, page: [row(derived.vault0)], isDone: true })],
    })
    r.deps.promptSecret = async () => passphrase
    expect(await run(["vault", "reconcile-exposure", "--keystore", h.vaultPath], r.deps)).toBe(0)
    const after = await reopen(h.vaultPath, passphrase)
    expect(after.index.entries.find((entry) => entry.address === derived.vault0)?.exposure.everRemoteExposed).toBe(true)
    expect(after.index.hd.exposureReconciledAt).toBeDefined()
  })
})

describe("T55: a restore that fails after the file is written does not strand it", () => {
  test("a failure before the commit removes the file this run created, and a retry succeeds", async () => {
    // An RPC the fake fetch has no route for: the gap scan's first call throws, after the vault
    // was written and verified and before any entry was committed.
    const h = await harness()
    expect(await restore(h, ["--count", "1", "--rpc-url", "https://rpc.test/unrouted"])).toBe(1)
    expect(h.stdout.text).toContain("verified in full (all eight steps)")
    expect(h.stderr.text).toContain("No route registered")
    expect(h.stderr.text).toContain("was removed because the restore did not complete")
    await expect(readFile(h.vaultPath, "utf8")).rejects.toThrow()
    const { sidecarPath } = await import("../vault/sidecar")
    await expect(readFile(sidecarPath(h.vaultPath), "utf8")).rejects.toThrow()

    // The path is free, so the retry is an ordinary restore rather than a VAULT_EXISTS refusal.
    const again = await harness()
    again.vaultPath = h.vaultPath
    expect(await restore(again, ["--count", "1"])).toBe(0)
    expect(again.stdout.text).toContain(derived.vault0)
  })

  test("a sidecar that predates the run is left alone by the cleanup", async () => {
    const h = await harness()
    const { sidecarPath } = await import("../vault/sidecar")
    const { writeFile } = await import("node:fs/promises")
    const stale = `${JSON.stringify({ vaultId: "older", lastGeneration: 4, envelopeIds: [], removedEnvelopeIds: [] })}\n`
    await writeFile(sidecarPath(h.vaultPath), stale, "utf8")
    expect(await restore(h, ["--count", "1", "--rpc-url", "https://rpc.test/unrouted"])).toBe(1)
    await expect(readFile(h.vaultPath, "utf8")).rejects.toThrow()
    // Present still: it belonged to a vault that was moved aside, not to this run.
    expect(await readFile(sidecarPath(h.vaultPath), "utf8")).toBeDefined()
  })

  test("the FIRST write already carries the discovery record, so even a crash leaves a vault that does not allocate", async () => {
    // What a kill between the write and the commit would leave on disk: the file `createVault`
    // wrote with restore's seed record and no entry. Built here through the same function and
    // the same seed, then driven through `new-key`.
    const { restoreSeedHd } = await import("./vault-restore")
    const { createVault } = await import("../vault/create")
    const { closeVault } = await import("../vault/store")
    const h = await harness()
    const passphrase = "a passphrase for the seeded vault"
    const seeded = await createVault(
      {
        path: h.vaultPath,
        passphrase,
        strength: "user-chosen",
        rootEntropy: Uint8Array.from(FIXTURE_ENTROPY),
        hd: restoreSeedHd(
          { requested: { solanaVault: 1, solanaTee: 1, solanaExternal: 0 } },
          "2026-09-18T00:00:00.000Z",
        ),
      },
      h.deps,
    )
    expect(seeded.index.entries).toHaveLength(0)
    expect(seeded.index.hd.discovery).toMatchObject({
      complete: false,
      requestedCounts: { solanaVault: 1, solanaTee: 1 },
    })
    closeVault(seeded)

    const k = await harness()
    k.deps.promptSecret = async () => passphrase
    expect(await run(["vault", "new-key", "--chain", "solana", "--json", "--keystore", h.vaultPath], k.deps)).toBe(1)
    expect(JSON.parse(k.stdout.text)).toMatchObject({ ok: false, code: "VAULT_ALLOCATION_BOUNDARY_UNKNOWN" })
  })
})

describe("T55: discovery, not certification", () => {
  test("a listed address the bounds did not derive is reported with BOTH explanations, exit 3", async () => {
    const h = await harness({
      pages: [() => jsonResponse(200, { success: true, page: [row("SomeAddressNobodyDerived11111")], isDone: true })],
    })
    expect(await restore(h, ["--count", "1"])).toBe(3)
    expect(h.stdout.text).toContain("SomeAddressNobodyDerived11111")
    // Both explanations, and the action each implies. Never silently dropped, and never an
    // open-ended ladder of higher counts, which for the second case has no top.
    expect(h.stdout.text).toContain("beyond the bounds used here")
    expect(h.stdout.text).toContain("no count will ever find them")
    expect(h.stdout.text).toContain("only a vault backup plus a factor recovers them")
  })

  test("a matched TEE-branch address becomes a tee-wallet entry and is flagged", async () => {
    const h = await harness({
      pages: [
        () => jsonResponse(200, { success: true, page: [row(derived.tee0, { vaultDestination: "V1" })], isDone: true }),
      ],
    })
    expect(await restore(h, ["--count", "1", "--tee-count", "1"])).toBe(0)

    const { reopen } = await import("../vault/test-vault")
    const vault = await reopen(h.vaultPath, generatedPassphraseFrom(h.stdout.text))
    const entry = vault.index.entries.find((candidate) => candidate.address === derived.tee0)
    expect(entry?.role).toBe("tee-wallet")
    expect(entry?.exposure.everRemoteExposed).toBe(true)
    // And it stays exposureUnknown: a match ADDS exposure and clears nothing.
    expect(entry?.exposure.exposureUnknown).toBe(true)
    expect(vault.index.hd.exposedIndexes.solanaTee).toContain(0)
  })

  test("the Phase 1 TEE store is not read, and the output says no migrated-tee entry was restored", async () => {
    const h = await harness()
    const { writeFile } = await import("node:fs/promises")
    const legacy = join(h.dir, "tee-wallets.enc")
    const contents = `${JSON.stringify({ version: 1, ciphertext: "untouched" })}\n`
    await writeFile(legacy, contents, "utf8")

    expect(await restore(h, ["--count", "1"])).toBe(0)
    expect(h.stdout.text).toContain("no migrated-tee entry was restored")
    expect(await readFile(legacy, "utf8")).toBe(contents)
  })
})

describe("T55: a restored vault does not allocate, on the FIRST call", () => {
  test("new-key refuses with VAULT_ALLOCATION_BOUNDARY_UNKNOWN and names the exit", async () => {
    const h = await harness()
    expect(await restore(h, ["--count", "1"])).toBe(0)
    const passphrase = generatedPassphraseFrom(h.stdout.text)

    const k = await harness()
    k.deps.promptSecret = async () => passphrase
    const code = await run(["vault", "new-key", "--chain", "solana", "--keystore", h.vaultPath], k.deps)
    expect(code).toBe(1)
    // No sequence of calls reaches a later index at all, because the FIRST one refuses.
    expect(k.stderr.text).toContain("never established")
    expect(k.stderr.text).toContain("There is no flag for this")
    expect(k.stderr.text).toContain("candle vault init")
    expect(k.stderr.text).toContain("candle vault transfer")

    // The stable code is the --json contract, which is where an agent reads it.
    const j = await harness()
    j.deps.promptSecret = async () => passphrase
    expect(await run(["vault", "new-key", "--chain", "solana", "--json", "--keystore", h.vaultPath], j.deps)).toBe(1)
    expect(JSON.parse(j.stdout.text)).toMatchObject({ ok: false, code: "VAULT_ALLOCATION_BOUNDARY_UNKNOWN" })
  })

  test("BE-242: --count does not weaken it; allocating n unknown indexes is worse than allocating one", async () => {
    const h = await harness()
    expect(await restore(h, ["--count", "1"])).toBe(0)
    const passphrase = generatedPassphraseFrom(h.stdout.text)

    const k = await harness()
    k.deps.promptSecret = async () => passphrase
    expect(
      await run(
        ["vault", "new-key", "--chain", "solana", "--count", "160", "--json", "--keystore", h.vaultPath],
        k.deps,
      ),
    ).toBe(1)
    expect(JSON.parse(k.stdout.text)).toMatchObject({ ok: false, code: "VAULT_ALLOCATION_BOUNDARY_UNKNOWN" })

    // The refusal is still the FIRST thing that happens after the unlock, so a batch cannot
    // allocate a single index on its way to being refused.
    const s = await harness()
    s.deps.promptSecret = async () => passphrase
    await run(["vault", "status", "--unlock", "--keystore", h.vaultPath], s.deps)
    expect(s.stdout.text).toContain("solanaVault  1")
  })

  test("status labels the vault as a recovery vault", async () => {
    const h = await harness()
    expect(await restore(h, ["--count", "1"])).toBe(0)
    const passphrase = generatedPassphraseFrom(h.stdout.text)

    const s = await harness()
    s.deps.promptSecret = async () => passphrase
    await run(["vault", "status", "--unlock", "--keystore", h.vaultPath], s.deps)
    expect(s.stdout.text).toContain("recovery artifacts, not fresh cold keys")
    expect(s.stdout.text).toContain("does not allocate new addresses")
    expect(s.stdout.text).toContain("history unknown (restored)")
  })

  test("the named exit works: a fresh init allocates from zero", async () => {
    const fresh = await harness()
    fresh.deps.promptSecret = async () => generatedPassphraseFrom(fresh.stdout.text)
    fresh.deps.promptLine = async () => "no"
    expect(await run(["vault", "init", "--keystore", fresh.vaultPath], fresh.deps)).toBe(0)
    const passphrase = generatedPassphraseFrom(fresh.stdout.text)

    const k = await harness()
    k.deps.promptSecret = async () => passphrase
    expect(await run(["vault", "new-key", "--chain", "solana", "--keystore", fresh.vaultPath], k.deps)).toBe(0)
    expect(k.stdout.text).toContain("m/44'/501'/0'/0'")
  })
})

describe("T55: reconcile-exposure adds and never clears", () => {
  test("it flags a newly listed address and records exposureReconciledAt", async () => {
    const h = await harness()
    expect(await restore(h, ["--count", "2"])).toBe(0)
    const passphrase = generatedPassphraseFrom(h.stdout.text)

    const r = await harness({
      pages: [() => jsonResponse(200, { success: true, page: [row(derived.vault1)], isDone: true })],
    })
    r.deps.promptSecret = async () => passphrase
    expect(await run(["vault", "reconcile-exposure", "--keystore", h.vaultPath], r.deps)).toBe(0)
    expect(r.stdout.text).toContain("1 vault address(es) newly flagged")
    expect(r.stdout.text).toContain("Nothing was cleared")

    const { reopen } = await import("../vault/test-vault")
    const vault = await reopen(h.vaultPath, passphrase)
    const entry = vault.index.entries.find((candidate) => candidate.address === derived.vault1)
    expect(entry?.exposure.everRemoteExposed).toBe(true)
    // Clears NOTHING: exposureUnknown survives every run, whatever the API said.
    expect(entry?.exposure.exposureUnknown).toBe(true)
    expect(vault.index.hd.exposureReconciledAt).toBeDefined()
    expect(vault.index.hd.exposedIndexes.solanaVault).toContain(1)
  })

  test("an API listing NOTHING at all never clears an exposureUnknown", async () => {
    const h = await harness({
      pages: [() => jsonResponse(200, { success: true, page: [row(derived.vault0)], isDone: true })],
    })
    expect(await restore(h, ["--count", "1"])).toBe(0)
    const passphrase = generatedPassphraseFrom(h.stdout.text)

    const r = await harness({ pages: [() => jsonResponse(200, { success: true, page: [], isDone: true })] })
    r.deps.promptSecret = async () => passphrase
    expect(await run(["vault", "reconcile-exposure", "--keystore", h.vaultPath], r.deps)).toBe(0)

    const { reopen } = await import("../vault/test-vault")
    const vault = await reopen(h.vaultPath, passphrase)
    const entry = vault.index.entries[0]
    // Both flags survive: the empty answer is not evidence of anything.
    expect(entry?.exposure.everRemoteExposed).toBe(true)
    expect(entry?.exposure.exposureUnknown).toBe(true)
  })

  test("it refuses on an incomplete read rather than reading an empty list as good news", async () => {
    const h = await harness()
    expect(await restore(h, ["--count", "1"])).toBe(0)
    const passphrase = generatedPassphraseFrom(h.stdout.text)

    const r = await harness({ pages: [() => jsonResponse(503, { success: false, message: "down" })] })
    r.deps.promptSecret = async () => passphrase
    expect(await run(["vault", "reconcile-exposure", "--keystore", h.vaultPath], r.deps)).toBe(1)
    expect(r.stderr.text).toContain("did not complete")
    expect(r.stderr.text).toContain("Nothing was flagged")
  })

  test("a different account is refused with EXPOSURE_ACCOUNT_MISMATCH", async () => {
    const h = await harness()
    expect(await restore(h, ["--count", "1"])).toBe(0)
    const passphrase = generatedPassphraseFrom(h.stdout.text)

    const r = await harness({
      embedded: () => jsonResponse(200, { success: true, account: "SomeOtherAccount9999999999" }),
      pages: [() => jsonResponse(200, { success: true, page: [], isDone: true })],
    })
    r.deps.promptSecret = async () => passphrase
    expect(await run(["vault", "reconcile-exposure", "--json", "--keystore", h.vaultPath], r.deps)).toBe(1)
    const body = JSON.parse(r.stdout.text) as { code: string; message: string; suggestion: string }
    expect(body.code).toBe("EXPOSURE_ACCOUNT_MISMATCH")
    // Re-flagging one vault against a different account's history would be both wrong and silent.
    expect(body.message).toContain("SomeOtherAccount9999999999")
    expect(body.suggestion).toContain("Nothing was flagged")
  })
})

test("verify-backup recognizes a sealed copy after phrase restore replaces every envelope", async () => {
  const original = await harness()
  expect(await restore(original, ["--count", "1"])).toBe(0)
  const oldPassphrase = generatedPassphraseFrom(original.stdout.text)
  const backupPath = join(original.dir, "..", "Library", "Mobile Documents", `${original.dir.split("/").pop()}.enc`)
  const { mkdir } = await import("node:fs/promises")
  await mkdir(join(original.dir, "..", "Library", "Mobile Documents"), { recursive: true })
  original.deps.promptSecret = async () => oldPassphrase
  expect(await run(["vault", "backup", "--to", backupPath, "--keystore", original.vaultPath], original.deps)).toBe(0)

  const restored = await harness()
  expect(await restore(restored, ["--count", "1"])).toBe(0)
  const newPassphrase = generatedPassphraseFrom(restored.stdout.text)
  const oldFile = JSON.parse(await readFile(backupPath, "utf8"))
  const newFile = JSON.parse(await readFile(restored.vaultPath, "utf8"))
  expect(oldFile.vaultId).not.toBe(newFile.vaultId)
  expect(oldFile.envelopes[0].id).not.toBe(newFile.envelopes[0].id)
  const stdout = createCapture()
  const stderr = createCapture()
  const secrets = [newPassphrase, oldPassphrase]
  const deps = { ...restored.deps, stdout, stderr, promptSecret: async () => secrets.shift() as string }
  expect(
    await run(
      ["vault", "verify-backup", backupPath, "--factor", "passkey", "--json", "--keystore", restored.vaultPath],
      deps,
    ),
  ).toBe(0)
  expect(JSON.parse(stdout.text)).toMatchObject({ ok: true, sealed: true, steps: 8, comparedAgainstLive: true })
  expect(secrets).toHaveLength(0)
  expect(stderr.text).toContain("passphrase it was sealed under")
  expect(stdout.text + stderr.text).not.toContain(oldPassphrase)
  expect(stdout.text + stderr.text).not.toContain(newPassphrase)
})

/**
 * T16 (BE-241, D8): restore says what the passphrase IS, before it asks for anything.
 *
 * The operator in BE-235 item 5 typed the SOURCE vault's passphrase at the copy-back prompt. The
 * AD-6 gate refused correctly and wrote nothing, and it read as being stuck. Every assertion below
 * is about copy around that gate; the gate itself is unchanged, which the existing mismatch test in
 * this file is what proves.
 */
describe("T16: D8's restore copy and passphrase prompt", () => {
  test("the new-passphrase line is on stdout before the phrase is asked for", async () => {
    const h = await harness()
    let stdoutAtPrompt = ""
    h.deps.promptSecret = async () => {
      stdoutAtPrompt = h.stdout.text
      throw new Error("stop here: the line is what this test reads")
    }
    await run(["vault", "restore", "--phrase", "--keystore", h.vaultPath], h.deps).catch(() => {})
    expect(stdoutAtPrompt).toContain("This builds a NEW vault from your 24 words, and it gets a NEW passphrase")
    expect(stdoutAtPrompt).toContain("does not carry over")
    expect(stdoutAtPrompt).toContain("The words carry the keys; a passphrase belongs to one file.")
  })

  test("Enter at the prompt takes the generated passphrase, shown once and typed back", async () => {
    const h = await harness()
    const asked: string[] = []
    let askedPhrase = false
    h.deps.promptSecret = async (text: string) => {
      asked.push(text)
      if (!askedPhrase) {
        askedPhrase = true
        return FIXTURE_PHRASE
      }
      return generatedPassphraseFrom(h.stdout.text)
    }
    h.deps.promptLine = async (text: string) => {
      asked.push(text)
      if (text.includes("last six characters")) return ACCOUNT.slice(-6)
      // D8's prompt: empty is Enter.
      if (text.startsWith("Passphrase for the new vault.")) return ""
      return "no"
    }
    expect(await run(["vault", "restore", "--phrase", "--keystore", h.vaultPath], h.deps)).toBe(0)
    // Asked in this order: the phrase, then the choice, then the copy-back of the generated one.
    const choice = asked.findIndex((text) => text.startsWith("Passphrase for the new vault."))
    expect(choice).toBeGreaterThan(0)
    expect(asked[choice]).toContain("Press Enter to have one generated (8 words, shown once, typed back)")
    expect(asked[choice]).toContain("or type own to choose your own (16+ characters, typed twice, never shown)")
    expect(asked.slice(choice + 1).some((text) => text.includes("Type it back in full"))).toBe(true)
    expect(h.stdout.text).toContain("The new vault's passphrase")
  })

  test("typing own takes the chosen-passphrase branch instead", async () => {
    const h = await harness()
    const asked: string[] = []
    let askedPhrase = false
    h.deps.promptSecret = async (text: string) => {
      asked.push(text)
      if (!askedPhrase) {
        askedPhrase = true
        return FIXTURE_PHRASE
      }
      return "a-long-enough-chosen-passphrase"
    }
    h.deps.promptLine = async (text: string) => {
      if (text.includes("last six characters")) return ACCOUNT.slice(-6)
      if (text.startsWith("Passphrase for the new vault.")) return "own"
      return "no"
    }
    expect(await run(["vault", "restore", "--phrase", "--keystore", h.vaultPath], h.deps)).toBe(0)
    expect(asked.some((text) => text.includes("Choose a passphrase for the new vault"))).toBe(true)
    // Nothing generated was shown, so nothing had to be typed back.
    expect(h.stdout.text).not.toContain("The new vault's passphrase")
  })

  test("an answer that is neither is asked once more, then treated as Enter", async () => {
    const h = await harness()
    const choices: string[] = []
    let askedPhrase = false
    h.deps.promptSecret = async () => {
      if (!askedPhrase) {
        askedPhrase = true
        return FIXTURE_PHRASE
      }
      return generatedPassphraseFrom(h.stdout.text)
    }
    h.deps.promptLine = async (text: string) => {
      if (text.includes("last six characters")) return ACCOUNT.slice(-6)
      if (text.startsWith("Passphrase for the new vault.")) {
        choices.push(text)
        return "yes please"
      }
      return "no"
    }
    expect(await run(["vault", "restore", "--phrase", "--keystore", h.vaultPath], h.deps)).toBe(0)
    expect(choices.length).toBe(2)
    expect(h.stdout.text).toContain("The new vault's passphrase")
  })

  test("--own-passphrase skips the prompt entirely", async () => {
    const h = await harness()
    let askedPhrase = false
    let choiceAsked = false
    h.deps.promptSecret = async () => {
      if (!askedPhrase) {
        askedPhrase = true
        return FIXTURE_PHRASE
      }
      return "a-long-enough-chosen-passphrase"
    }
    h.deps.promptLine = async (text: string) => {
      if (text.startsWith("Passphrase for the new vault.")) choiceAsked = true
      return text.includes("last six characters") ? ACCOUNT.slice(-6) : "no"
    }
    expect(await run(["vault", "restore", "--phrase", "--own-passphrase", "--keystore", h.vaultPath], h.deps)).toBe(0)
    expect(choiceAsked).toBe(false)
  })

  test("the footer names the non-default location, and only when -k put it there", async () => {
    const h = await harness()
    expect(await restore(h, [])).toBe(0)
    expect(h.stdout.text).toContain(`This vault is at ${h.vaultPath}, not the default location.`)
    expect(h.stdout.text).toContain(`Every vault command needs -k ${h.vaultPath}`)
    expect(h.stdout.text).toContain(`export CANDLE_CONFIG_DIR=${h.dir}`)

    // The same restore, located by CANDLE_CONFIG_DIR rather than by the flag: the default location
    // for that shell, so there is nothing to warn about.
    const viaEnv = await harness()
    let askedPhrase = false
    viaEnv.deps.promptSecret = async () => {
      if (!askedPhrase) {
        askedPhrase = true
        return FIXTURE_PHRASE
      }
      return generatedPassphraseFrom(viaEnv.stdout.text)
    }
    viaEnv.deps.promptLine = async (text: string) =>
      text.includes("last six characters")
        ? ACCOUNT.slice(-6)
        : text.startsWith("Passphrase for the new vault.")
          ? ""
          : "no"
    expect(await run(["vault", "restore", "--phrase"], viaEnv.deps)).toBe(0)
    expect(viaEnv.stdout.text).not.toContain("not the default location")
  })

  // This also read the docs reference out of the apps directory, four levels up. That package is
  // mirrored to candledottv/agentic, which carries cli, mcp and sdk and no apps at all, and the
  // RELEASE runs this suite there: the read is how cli-v0.11.1's release job died of ENOENT after
  // npm had already published, leaving the signed release and the Homebrew tap a version behind.
  // The docs assertion now lives in scripts/cli-docs.test.ts, which is never exported.
  test("--own-passphrase is documented on the help row", async () => {
    const { HELP } = await import("../help")
    const restoreRow = HELP.vault?.rows.find((row) => row.invocation.startsWith("restore "))
    expect(restoreRow?.invocation).toContain("[--own-passphrase]")
    expect(restoreRow?.description).toContain("new passphrase")
  })
})
