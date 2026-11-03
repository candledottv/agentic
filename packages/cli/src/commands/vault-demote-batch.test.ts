/**
 * BE-2597 (WAIFULAB W10): `vault demote <a> <b> ...` and `vault demote --all --empty`.
 *
 * Real vault format, fake API and fake RPC, in the shape of `vault-promote.test.ts`'s BE-981 block.
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
import { closeVault, commitVault, decryptKey, readVaultRaw, reopenWithHeldDek } from "../vault/store"
import { makeVault, reopen, retireTeeEntries, testClock, useCheapKdf } from "../vault/test-vault"
import { isBatchDemote } from "./vault-demote-batch"

setDefaultTimeout(90_000)
useCheapKdf()

const ACCOUNT = "BatchAccountABCDEFGH1234567890xyzab"
const API = "https://api.batch.test"
const API_KEY = `cndl_live_${"btchbtch".padEnd(43, "x")}`
const RPC = "https://rpc.batch.test/rpc"
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"
const CONFIRM_BATCH = (n: number) => `Type confirm to demote these ${n} wallets: `

interface Fixture {
  dir: string
  path: string
  passphrase: string
  cold: string
  /** Enabled TEE wallets, in creation order; `lw_<i>` is each one's linked wallet id. */
  wallets: string[]
}

async function newKey(dir: string, passphrase: string, label: string): Promise<string> {
  const out = createCapture()
  const err = createCapture()
  const deps = createTestDeps({
    fetch: (async () => {
      throw new Error("no network")
    }) as unknown as typeof fetch,
    stdout: out,
    stderr: err,
    env: { CANDLE_CONFIG_DIR: dir },
    promptSecret: async () => passphrase,
    promptLine: async () => "",
  })
  const code = await run(["vault", "new-key", "--chain", "solana", "--label", label, "--json"], deps)
  if (code !== 0) throw new Error(`new-key failed: ${err.text}\n${out.text}`)
  return JSON.parse(out.text).address as string
}

/** A vault with one cold key and `n` enabled Solana TEE wallets that sweep to it. */
async function fixture(n: number): Promise<Fixture> {
  const made = await makeVault()
  closeVault(made.vault)
  const cold = await newKey(made.dir, made.passphrase, "cold")
  const wallets: string[] = []
  for (let i = 0; i < n; i++) wallets.push(await newKey(made.dir, made.passphrase, `agent-${i}`))
  const opened = await reopen(made.path, made.passphrase)
  try {
    const entries = opened.index.entries.map((e) => {
      const i = wallets.indexOf(e.address)
      if (i < 0) return e
      return {
        ...e,
        role: "tee-wallet" as const,
        exposure: { everRemoteExposed: true, everExported: false },
        linkedWalletId: `lw_${i}`,
        tee: {
          network: "solana-mainnet" as const,
          lifecycle: "enabled" as const,
          vaultDestination: cold,
          grantIdentity: { account: ACCOUNT, apiBaseUrl: API, source: "recorded-at-operation" as const },
          remoteAuthority: "verified-active" as const,
        },
      }
    })
    await commitVault(opened, { index: { hd: opened.index.hd, entries } }, testClock)
  } finally {
    closeVault(opened)
  }
  return { dir: made.dir, path: made.path, passphrase: made.passphrase, cold, wallets }
}

/** A node where each address holds `balances[address]` lamports until a sweep sends from it. */
function rpc(balances: Record<string, number>): RouteHandler {
  const drained = new Set<string>()
  let current: string | undefined
  return async (req) => {
    const body = typeof req.init.body === "string" ? JSON.parse(req.init.body) : {}
    const id = body.id
    const ok = (result: unknown) => jsonResponse(200, { jsonrpc: "2.0", id, result })
    switch (body.method) {
      case "getBalance": {
        const address = body.params[0] as string
        current = address
        return ok({ value: drained.has(address) ? 0 : (balances[address] ?? 0) })
      }
      case "getTokenAccountsByOwner":
        return ok({ value: [] })
      case "getLatestBlockhash":
        return ok({ value: { blockhash: BLOCKHASH } })
      case "getFeeForMessage":
        return ok({ value: 5000 })
      case "getAccountInfo":
        return ok({ value: null })
      case "sendTransaction":
        if (current !== undefined) drained.add(current)
        return ok("SigFake1111111111111111111111111111111111111111111111")
      case "getSignatureStatuses":
        return ok({ value: [{ confirmationStatus: "finalized", err: null }] })
      case "isBlockhashValid":
        return ok({ value: true })
      default:
        return ok(null)
    }
  }
}

function walletRoutes(n: number, failDisable: Set<number> = new Set()): Record<string, RouteHandler> {
  const routes: Record<string, RouteHandler> = {}
  for (let i = 0; i < n; i++) {
    routes[`/api/v1/agent/wallets/lw_${i}`] = () =>
      failDisable.has(i)
        ? jsonResponse(500, { error: "provider down" })
        : jsonResponse(200, { success: true, state: "quarantined", complete: true, remoteAuthority: "verified-denied" })
    routes[`/api/v1/agent/wallets/lw_${i}/lifecycle`] = () => jsonResponse(200, { success: true, state: "quarantined" })
    routes[`/api/v1/agent/wallets/lw_${i}/swept`] = () => jsonResponse(200, { success: true, state: "swept" })
  }
  return routes
}

async function demote(
  fx: Fixture,
  argv: string[],
  opts: { balances?: Record<string, number>; failDisable?: Set<number>; answer?: string } = {},
) {
  const { fetch, calls } = createRoutedFetch({
    ...walletRoutes(fx.wallets.length, opts.failDisable),
    "/rpc": rpc(opts.balances ?? {}),
  })
  const out = createCapture()
  const err = createCapture()
  const unlocks: string[] = []
  const prompts: Array<{ text: string; actionsBefore: number }> = []
  const deps = createTestDeps({
    fetch,
    store: createFakeStore({ "profile:batch:api_key": API_KEY }),
    stdout: out,
    stderr: err,
    env: { CANDLE_CONFIG_DIR: fx.dir, CANDLE_API_URL: API },
    promptSecret: async (text: string) => {
      unlocks.push(text)
      return fx.passphrase
    },
    promptLine: async (text: string) => {
      prompts.push({ text, actionsBefore: actions(calls).length })
      return opts.answer ?? "confirm"
    },
    readFile: (path) => readFile(path, "utf8"),
    writeFile: (path, content) => writeFile(path, content, "utf8"),
  })
  await deps.writeConfig({
    activeProfile: "batch",
    profiles: { batch: { account: ACCOUNT, apiUrl: API, accountCachedAt: Date.now() } },
  })
  const code = await run(["vault", "demote", ...argv, "--rpc-url", RPC], deps)
  return { code, out, err, unlocks, prompts, calls }
}

/** Calls that act: a disable, or anything to the chain. The account guard's read is neither. */
const actions = (calls: CapturedRequest[]) =>
  calls.filter((c) => c.init.method === "DELETE" || new URL(c.url).pathname === "/rpc")

const disables = (calls: CapturedRequest[]) =>
  calls.filter((c) => c.init.method === "DELETE").map((c) => new URL(c.url).pathname.split("/").at(-1))

async function entryOf(fx: Fixture, address: string) {
  const opened = await reopen(fx.path, fx.passphrase)
  try {
    return opened.index.entries.find((e) => e.address === address)
  } finally {
    closeVault(opened)
  }
}

describe("BE-2597: reopenWithHeldDek", () => {
  test("opens the current bytes with a copy of the held DEK; closing the copy leaves the held one usable", async () => {
    const fx = await fixture(1)
    const held = await reopen(fx.path, fx.passphrase)
    try {
      const keyId = held.index.entries.find((e) => e.address === fx.wallets[0])?.id as string
      const copy = await reopenWithHeldDek(fx.path, (await readVaultRaw(fx.path)) as string, held)
      expect(copy.dek).not.toBe(held.dek)
      expect(copy.index.entries.map((e) => e.address)).toEqual(held.index.entries.map((e) => e.address))
      closeVault(copy)
      expect(copy.dek.every((b) => b === 0)).toBe(true)
      expect(held.dek.some((b) => b !== 0)).toBe(true)
      const secret = await decryptKey(held, keyId)
      expect(secret.length).toBe(64)
    } finally {
      closeVault(held)
    }
  })

  test("refuses a different vault's file", async () => {
    const fx = await fixture(0)
    const other = await makeVault()
    const held = await reopen(fx.path, fx.passphrase)
    try {
      const raw = (await readVaultRaw(other.path)) as string
      await expect(reopenWithHeldDek(other.path, raw, held)).rejects.toThrow("is not the vault this command unlocked")
    } finally {
      closeVault(held)
      closeVault(other.vault)
    }
  })
})

describe("BE-2597: isBatchDemote", () => {
  test("one address is the single demote; several addresses or a batch flag is a batch", () => {
    expect(isBatchDemote(["A"])).toBe(false)
    expect(isBatchDemote(["A", "--rpc-url", "https://x", "--sweep-to", "cold"])).toBe(false)
    expect(isBatchDemote(["A", "B"])).toBe(true)
    expect(isBatchDemote(["--all", "--empty"])).toBe(true)
    expect(isBatchDemote(["A", "--yes"])).toBe(true)
  })
})

describe("BE-2597: vault demote with several addresses", () => {
  test("one unlock, one confirmation listing every wallet before any action, each demoted in turn", async () => {
    const fx = await fixture(3)
    const [a, b, c] = fx.wallets as [string, string, string]
    const r = await demote(fx, [a, b, c], { balances: { [a]: 1_000_000_000, [b]: 0, [c]: 500_000_000 } })

    expect(r.code).toBe(0)
    expect(r.unlocks).toHaveLength(1)
    // The batch's one prompt, and no per-wallet "Type confirm to sweep everything to" prompt.
    expect(r.prompts.map((p) => p.text)).toEqual([CONFIRM_BATCH(3)])
    // Nothing reached the API or the chain before the confirmation.
    expect(r.prompts[0]?.actionsBefore).toBe(0)
    const listing = r.out.text.slice(0, r.out.text.indexOf("[1/3]"))
    for (const address of fx.wallets) expect(listing).toContain(address)
    expect(listing).toContain(fx.cold)

    // One wallet at a time, in the order named.
    expect(disables(r.calls)).toEqual(["lw_0", "lw_1", "lw_2"])
    expect(r.out.text.indexOf("[1/3]")).toBeLessThan(r.out.text.indexOf("[2/3]"))
    expect(r.out.text).toContain(`Result ${a}: done (exit 0)`)
    expect(r.out.text).toContain(`Result ${b}: done (exit 0)`)
    expect(r.out.text).toContain("Summary: 3 done, 0 incomplete, 0 failed, 0 skipped (of 3).")

    expect((await entryOf(fx, a))?.tee?.lifecycle).toBe("retired")
    expect((await entryOf(fx, c))?.tee?.lifecycle).toBe("retired")
    const emptyOne = await entryOf(fx, b)
    expect(emptyOne?.tee?.stopRequestedAt).toBeDefined()
    expect(emptyOne?.tee?.sweptAt).toBeUndefined()
  })

  test("a failure in the middle is reported and the batch continues", async () => {
    const fx = await fixture(3)
    const [a, b, c] = fx.wallets as [string, string, string]
    const r = await demote(fx, [a, b, c], { failDisable: new Set([1]) })

    expect(r.code).toBe(1)
    expect(disables(r.calls)).toEqual(["lw_0", "lw_1", "lw_2"])
    expect(r.out.text).toContain(`Result ${a}: done (exit 0)`)
    expect(r.out.text).toMatch(
      new RegExp(`Result ${b}: FAILED \\(exit 1\\): The stop request failed: provider down\\.\n`),
    )
    expect(r.out.text).toContain(`Result ${c}: done (exit 0)`)
    expect(r.out.text).toContain("Summary: 2 done, 0 incomplete, 1 failed, 0 skipped (of 3).")
    expect((await entryOf(fx, c))?.tee?.stopRequestedAt).toBeDefined()
  })

  test("anything but confirm at the prompt does nothing", async () => {
    const fx = await fixture(2)
    const r = await demote(fx, fx.wallets, { answer: "yes" })
    expect(r.code).toBe(1)
    expect(actions(r.calls)).toHaveLength(0)
    expect(r.err.text).toContain("The batch was not confirmed; nothing was done.")
    expect((await entryOf(fx, fx.wallets[0] as string))?.tee?.stopRequestedAt).toBeUndefined()
  })

  test("--json: one document on stdout, one object per wallet and the summary; --yes skips the prompt", async () => {
    const fx = await fixture(2)
    const [a, b] = fx.wallets as [string, string]
    const unknown = "Unknown1111111111111111111111111111111111111"
    const r = await demote(fx, [a, unknown, a, b, "--yes", "--json"], {
      balances: { [a]: 1_000_000_000 },
      failDisable: new Set([1]),
    })

    expect(r.code).toBe(1)
    expect(r.prompts).toHaveLength(0)
    expect(r.unlocks).toHaveLength(1)
    // Pure JSON: the whole of stdout parses as one value.
    const doc = JSON.parse(r.out.text)
    expect(r.out.text.trim().split("\n")).toHaveLength(1)
    expect(doc.ok).toBe(false)
    expect(doc.summary).toEqual({ total: 4, done: 1, incomplete: 0, failed: 2, skipped: 1 })
    const byStatus = (status: string) => doc.wallets.filter((w: { status: string }) => w.status === status)
    expect(byStatus("skipped")).toEqual([
      { address: a, label: null, chain: "solana", status: "skipped", reason: "listed more than once" },
    ])
    const failed = byStatus("failed")
    expect(failed.map((w: { address: string }) => w.address).sort()).toEqual([unknown, b].sort())
    expect(failed.find((w: { address: string }) => w.address === unknown).code).toBe("TEE_WALLET_UNKNOWN")
    const bFailed = failed.find((w: { address: string }) => w.address === b)
    expect(bFailed.exitCode).toBe(1)
    expect(bFailed.code).toBe("STOP_UNCONFIRMED")
    const done = byStatus("done")[0]
    expect(done.address).toBe(a)
    expect(done.label).toBe("agent-0")
    expect(done.exitCode).toBe(0)
    expect(Array.isArray(done.results)).toBe(true)
    expect(done.results.length).toBeGreaterThan(0)
    // The listing went to stderr, off the document.
    expect(r.err.text).toContain(a)
  })
})

describe("BE-2597: vault demote --all --empty", () => {
  test("demotes only the wallets with nothing left to sweep; a funded one is skipped with its reason", async () => {
    const fx = await fixture(4)
    const [a, b, c, retired] = fx.wallets as [string, string, string, string]
    await retireTeeEntries(fx.path, fx.passphrase, [retired], fx.cold)
    const r = await demote(fx, ["--all", "--empty"], { balances: { [b]: 1_000_000_000 } })

    expect(r.code).toBe(0)
    expect(r.prompts.map((p) => p.text)).toEqual([CONFIRM_BATCH(2)])
    expect(disables(r.calls)).toEqual(["lw_0", "lw_2"])
    expect(r.out.text).toContain(`Not demoted: ${b}: not empty`)
    expect(r.out.text).not.toContain(retired)
    expect(r.out.text).toContain(`Result ${a}: done (exit 0)`)
    expect(r.out.text).toContain(`Result ${c}: done (exit 0)`)
    expect(r.out.text).toContain("Summary: 2 done, 0 incomplete, 0 failed, 1 skipped (of 3).")
    // No sweep was sent for an empty wallet, and the funded one was never touched.
    expect(r.calls.some((c) => typeof c.init.body === "string" && c.init.body.includes('"sendTransaction"'))).toBe(
      false,
    )
    expect((await entryOf(fx, b))?.tee?.stopRequestedAt).toBeUndefined()
  })

  test("usage: --all needs --empty and takes no addresses; Hood-only flags stay on a single demote", async () => {
    const fx = await fixture(1)
    const all = await demote(fx, ["--all"])
    expect(all.code).toBe(2)
    expect(all.err.text).toContain("--all needs a filter: --empty")
    const mixed = await demote(fx, ["--all", "--empty", fx.wallets[0] as string])
    expect(mixed.code).toBe(2)
    const token = await demote(fx, [
      fx.wallets[0] as string,
      "--yes",
      "--token",
      "0x1111111111111111111111111111111111111111",
    ])
    expect(token.code).toBe(2)
    expect(token.err.text).toContain("--token names one Hood wallet's sweep")
    for (const r of [all, mixed, token]) {
      expect(r.unlocks).toHaveLength(0)
      expect(actions(r.calls)).toHaveLength(0)
    }
  })
})
