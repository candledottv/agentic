/**
 * BE-316 (Ember Phase 3 R7, P3-ED-11): `candle portfolio`.
 *
 * Driven through the real dispatcher against a real vault written by the real commit path. One
 * scripted `fetch` answers both the Candle API and the operator's RPC and records every request,
 * which is what turns the privacy rule into an assertion: no vault or external address appears in
 * any request to Candle, and the only vault-derived thing Candle receives is a mint list.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Deps } from "../deps"
import { FIXTURE_EVM_0, FIXTURE_EVM_1 } from "../evm-lite.test"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"
import type { IndexPlaintext, KeyEntry } from "../vault/format"
import { closeVault, commitVault } from "../vault/store"
import { FIXTURE_PASSPHRASE, makeVault, testClock, useCheapKdf } from "../vault/test-vault"

setDefaultTimeout(60_000)
useCheapKdf()

const API = "https://api.example.test"
const RPC_URL = "https://rpc.example.test/key-in-path"
const SOL = "So11111111111111111111111111111111111111112"
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const MEME = "MemeMint1111111111111111111111111111111111"
const ODD = "OddMint22222222222222222222222222222222222"
const EMBEDDED = "Embedded1111111111111111111111111111111111"

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
function fakeAddress(stem: string, index: number): string {
  let tail = ""
  let n = index
  for (let i = 0; i < 4; i += 1) {
    tail = `${B58[n % 58] as string}${tail}`
    n = Math.floor(n / 58)
  }
  return `${stem}${tail}`
}
const vaultAddress = (i: number) => fakeAddress("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJos", i)
const teeAddress = (i: number) => fakeAddress("TeeWxtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJos", i)

function entryAt(index: number, label: string, role: KeyEntry["role"] = "vault"): KeyEntry {
  const branch = role === "tee-wallet" ? "1" : role === "external" ? "2" : "0"
  return {
    id: `key-${String(index).padStart(3, "0")}`,
    chain: "solana",
    curve: "ed25519",
    address: vaultAddress(index),
    label,
    createdAt: "2026-09-24T12:00:00.000Z",
    role,
    origin: "derived",
    derivation: { scheme: "slip10-ed25519", path: `m/44'/501'/${index}'/${branch}'` },
    exposure: { everRemoteExposed: false, everExported: false },
    ...(role === "tee-wallet"
      ? { tee: { lifecycle: "local-candidate" as const, network: "solana-mainnet" as const } }
      : {}),
  }
}

async function vaultWith(entries: KeyEntry[]): Promise<{ dir: string; path: string }> {
  const made = await makeVault()
  try {
    const next = (branch: string) =>
      entries.filter((e) => e.derivation?.path.endsWith(`/${branch}'`)).length === 0
        ? 0
        : Math.max(...entries.map((e) => Number(/^m\/44'\/501'\/(\d+)'/.exec(e.derivation?.path ?? "")?.[1] ?? -1))) + 1
    const index: IndexPlaintext = {
      hd: {
        ...made.vault.index.hd,
        nextIndex: {
          solanaVault: next("0"),
          solanaTee: next("1"),
          solanaExternal: next("2"),
          evm: entries.some((e) => e.chain === "evm") ? 1000 : 0,
        },
      },
      entries,
    }
    await commitVault(made.vault, { index }, testClock)
  } finally {
    closeVault(made.vault)
  }
  return { dir: made.dir, path: made.path }
}

interface Wallet {
  lamports: string | null
  tokens: { mint: string; amountRaw: string; decimals: number; program: "token" | "token-2022" }[] | null
}

interface HoodWallet {
  wei: string | null
  tokens: { chain: "hood"; mint: string; amountRaw: string; decimals: number; symbol?: string }[] | null
  truncated?: true
}
interface HoodSection {
  embedded: ({ address: string; chain: "hood" } & HoodWallet)[]
  tee: ({ id: string; address: string; label?: string; active: boolean; chain: "hood" } & HoodWallet)[]
  unavailable: string[]
  unpriced: number
  unpricedByReason: Record<string, number>
}

interface Recorded {
  host: string
  path: string
  method: string
  body: string
}

function harness(opts: {
  dir?: string
  env?: Record<string, string>
  tee?: ({ id: string; address: string; label?: string; active: boolean } & Wallet)[]
  candlePrices?: Record<string, { priceUsd: number | null; source: string | null; symbol?: string }>
  /** Answers POST /agent/prices by mint. */
  prices?: Record<string, number>
  /** Vault-side RPC answers. */
  rpcLamports?: (address: string) => number
  rpcTokens?: (owner: string, programId: string) => { mint: string; amount: string; decimals: number }[]
  rpcFailOwner?: string
  /** BE-355 (T13): the 1-based getMultipleAccounts calls that answer HTTP 429 (the client retries once). */
  rpcRateLimitCalls?: number[]
  candleStatus?: number
  tty?: boolean
  /** The `hood` section Candle adds from Ember 4d. Absent by default: an API that predates it. */
  hood?: HoodSection
  /** Answers POST /agent/prices `hood` entries by asset (`native` or a contract, any case). */
  hoodPrices?: Record<string, { priceUsd: number | null; source: string | null; unpricedReason?: string }>
  /** The operator's EVM RPC at evm.example.test. */
  evm?: {
    chainId?: number
    chainIdFails?: boolean
    wei?: (address: string) => bigint
    usdg?: (address: string) => bigint
    /** balanceOf (USDG) fails for this address. */
    usdgFailAddress?: string
  }
  /** The `lp` section Candle adds when it serves LP (BE-323). Absent by default, as before E2. */
  lp?: {
    positions: {
      position: string
      pool: string
      wallet: string
      walletId: string
      tokens: {
        mint: string
        decimals: number
        amountRaw: string
        unclaimedFeesRaw: string
        symbol?: string
        priceUsd: number | null
        valueUsd: number | null
      }[]
      poolShare?: number
      valueUsd: number | null
      unpriced: number
    }[]
    unreadable: { position: string; wallet: string; walletId: string }[]
    complete: boolean
  }
}) {
  const stdout = createCapture()
  const stderr = createCapture()
  const asked: string[] = []
  const requests: Recorded[] = []
  let inFlight = 0
  let peak = 0
  let chunkCalls = 0
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = init?.body ? String(init.body) : ""
    requests.push({ host: url.host, path: url.pathname, method: init?.method ?? "GET", body })
    if (url.host === "evm.example.test") {
      const rpc = JSON.parse(body) as { id: number; method: string; params: unknown[] }
      const answer = (result: string) => Response.json({ jsonrpc: "2.0", id: rpc.id, result })
      if (rpc.method === "eth_chainId") {
        if (opts.evm?.chainIdFails) return new Response("down", { status: 503 })
        return answer(`0x${(opts.evm?.chainId ?? 4663).toString(16)}`)
      }
      if (rpc.method === "eth_getBalance")
        return answer(`0x${(opts.evm?.wei?.(rpc.params[0] as string) ?? 0n).toString(16)}`)
      if (rpc.method === "eth_call") {
        const call = rpc.params[0] as { to: string; data: string }
        const owner = `0x${call.data.slice(-40)}`
        if (opts.evm?.usdgFailAddress?.toLowerCase() === owner) {
          return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: "execution reverted" } })
        }
        const held = opts.evm?.usdg?.(owner) ?? 0n
        return answer(`0x${held.toString(16).padStart(64, "0")}`)
      }
      throw new Error(`Unexpected EVM method ${rpc.method}`)
    }
    if (url.host === "rpc.example.test") {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 0))
      inFlight -= 1
      const rpc = JSON.parse(body) as { id: number; method: string; params: unknown[] }
      if (rpc.method === "getMultipleAccounts") {
        chunkCalls += 1
        if (opts.rpcRateLimitCalls?.includes(chunkCalls)) return new Response("rate limited", { status: 429 })
        const addresses = rpc.params[0] as string[]
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            value: addresses.map((a) => {
              const lamports = opts.rpcLamports?.(a) ?? 0
              return lamports === 0
                ? null
                : { owner: "11111111111111111111111111111111", lamports, data: ["", "base64"] }
            }),
          },
        })
      }
      const [owner, { programId }] = rpc.params as [string, { programId: string }]
      if (owner === opts.rpcFailOwner) return new Response("rate limited", { status: 429 })
      return Response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          value: (opts.rpcTokens?.(owner, programId) ?? []).map((t, i) => ({
            pubkey: `Acct${i}`,
            account: {
              data: {
                parsed: {
                  info: { mint: t.mint, state: "initialized", tokenAmount: { amount: t.amount, decimals: t.decimals } },
                },
              },
            },
          })),
        },
      })
    }
    if (url.pathname === "/api/v1/agent/portfolio") {
      if (opts.candleStatus && opts.candleStatus !== 200) {
        return Response.json(
          { success: false, error: { code: "SCOPE_MISSING", message: "The account's portfolio requires a Read key" } },
          { status: opts.candleStatus },
        )
      }
      const tee = opts.tee ?? []
      return Response.json({
        success: true,
        embedded: [{ address: EMBEDDED, lamports: "2000000000", tokens: [] }],
        tee,
        prices: opts.candlePrices ?? { [SOL]: { priceUsd: 100, source: "jupiter", symbol: "SOL" } },
        unavailable: tee.filter((w) => w.lamports === null || w.tokens === null).map((w) => w.address),
        complete:
          tee.every((w) => w.lamports !== null && w.tokens !== null) &&
          (opts.lp?.complete ?? true) &&
          (opts.hood?.unavailable.length ?? 0) === 0,
        ...(opts.lp ? { lp: opts.lp } : {}),
        ...(opts.hood ? { hood: opts.hood } : {}),
      })
    }
    if (url.pathname === "/api/v1/agent/prices") {
      const { mints = [], hood = [] } = JSON.parse(body) as { mints?: string[]; hood?: string[] }
      return Response.json({
        success: true,
        prices: Object.fromEntries([
          ...hood.map((asset) => {
            const key = asset === "native" ? "hood:native" : `hood:${asset.toLowerCase()}`
            const answer = Object.entries(opts.hoodPrices ?? {}).find(([a]) => a.toLowerCase() === asset.toLowerCase())
            return [key, answer?.[1] ?? { priceUsd: null, source: null, unpricedReason: "no-market-row" }]
          }),
          ...mints.map((m) => [
            m,
            opts.prices?.[m] === undefined
              ? { priceUsd: null, source: null }
              : { priceUsd: opts.prices[m], source: "market" },
          ]),
        ]),
      })
    }
    throw new Error(`Unexpected request ${url.href}`)
  }) as typeof fetch

  const deps: Deps = createTestDeps({
    fetch: fetchFn,
    stdout,
    stderr,
    env: {
      CANDLE_API_KEY: "test-key",
      CANDLE_API_URL: API,
      ...(opts.dir ? { CANDLE_CONFIG_DIR: opts.dir, HOME: opts.dir } : {}),
      ...(opts.env ?? {}),
    },
    isTTY: { stdin: opts.tty ?? true, stdout: true, stderr: opts.tty ?? true },
    promptSecret: async (text: string) => {
      asked.push(text)
      return FIXTURE_PASSPHRASE
    },
  })
  const candleRequests = () => requests.filter((r) => r.host === "api.example.test")
  const rpcRequests = () => requests.filter((r) => r.host === "rpc.example.test")
  const evmRequests = () => requests.filter((r) => r.host === "evm.example.test")
  return { deps, stdout, stderr, asked, requests, candleRequests, rpcRequests, evmRequests, peak: () => peak }
}

async function emptyConfigDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "candle-portfolio-"))
}

describe("candle portfolio", () => {
  test("no RPC and no vault file: the public default is resolved, nothing is asked or sent, and the row says where it looked (BE-355)", async () => {
    const dir = await emptyConfigDir()
    const h = harness({
      dir,
      tee: [
        { id: "w1", address: teeAddress(1), label: "tee-1", active: true, lamports: "500000000", tokens: [] },
        { id: "w2", address: teeAddress(2), active: true, lamports: "0", tokens: [] },
      ],
    })
    const code = await run(["portfolio"], h.deps)
    expect(code).toBe(0)
    expect(h.asked).toEqual([])
    expect(h.rpcRequests()).toEqual([])
    expect(h.candleRequests().map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/v1/agent/portfolio"])
    const out = h.stdout.text
    expect(out).toContain("GROUP     CHAIN   WALLET")
    expect(out).toMatch(/tee\s+solana\s+tee-1 \(TeeW…[^)]+\)\s+SOL\s+0\.5\s+\$100\.00\s+\$50\.00/)
    expect(out).toMatch(/embedded\s+solana\s+\(Embe…1111\)\s+SOL\s+2\s+\$100\.00\s+\$200\.00/)
    expect(out).toMatch(/vault\s+-\s+no vault at /)
    // No vault entry, so no request: neither the notice nor the host line was printed (invariant 4).
    expect(h.stderr.text).not.toContain("Solana RPC:")
    expect(out).toMatch(/tee\s+\$50\.00\s+2 wallets, 1 empty not shown/)
    expect(out).toMatch(/total\s+\$250\.00\s+every holding priced/)
  })

  test("with a vault: vault and external read over the operator's RPC; Candle gets mints only", async () => {
    const { dir } = await vaultWith([
      entryAt(0, "treasury"),
      entryAt(1, "cold-2"),
      entryAt(2, "tee-local", "tee-wallet"),
      entryAt(3, "ext-1", "external"),
    ])
    const h = harness({
      dir,
      env: { CANDLE_SOLANA_RPC_URL: RPC_URL },
      tee: [
        {
          id: "w1",
          address: teeAddress(1),
          active: true,
          lamports: "0",
          tokens: [{ mint: MEME, amountRaw: "1000000", decimals: 6, program: "token" }],
        },
      ],
      candlePrices: {
        [SOL]: { priceUsd: 100, source: "jupiter", symbol: "SOL" },
        [MEME]: { priceUsd: 0.5, source: "market", symbol: "MEME" },
      },
      prices: { [USDC]: 1 },
      rpcLamports: (a) => (a === vaultAddress(0) ? 3_000_000_000 : a === vaultAddress(3) ? 1_000_000_000 : 0),
      rpcTokens: (owner, programId) =>
        owner === vaultAddress(0) && programId.startsWith("Tokenkeg")
          ? [
              { mint: USDC, amount: "25000000", decimals: 6 },
              { mint: MEME, amount: "2000000", decimals: 6 },
            ]
          : owner === vaultAddress(1) && programId.startsWith("Tokenz")
            ? [{ mint: ODD, amount: "7", decimals: 0 }]
            : [],
    })
    const code = await run(["portfolio", "--json"], h.deps)
    expect(code).toBe(0)
    expect(h.asked).toHaveLength(1)

    // The RPC was asked about exactly the vault and external keys: never the local TEE-role entry.
    const rpcOwners = new Set(
      h.rpcRequests().flatMap((r) => {
        const rpc = JSON.parse(r.body) as { method: string; params: unknown[] }
        return rpc.method === "getMultipleAccounts" ? (rpc.params[0] as string[]) : [rpc.params[0] as string]
      }),
    )
    expect(rpcOwners).toEqual(new Set([vaultAddress(0), vaultAddress(1), vaultAddress(3)]))

    // Nothing sent to Candle carries a vault or external address.
    for (const request of h.candleRequests()) {
      for (const i of [0, 1, 2, 3]) {
        expect(`${request.path} ${request.body}`).not.toContain(vaultAddress(i))
      }
    }
    // One price request: the vault's mints Candle had not already priced, and nothing else.
    const priced = h.candleRequests().filter((r) => r.path === "/api/v1/agent/prices")
    expect(priced).toHaveLength(1)
    expect(Object.keys(JSON.parse(priced[0]?.body ?? "{}"))).toEqual(["mints"])
    expect(new Set(JSON.parse(priced[0]?.body ?? "{}").mints)).toEqual(new Set([USDC, ODD]))

    const doc = JSON.parse(h.stdout.text)
    expect(doc.ok).toBe(true)
    expect(doc.complete).toBe(true)
    const vault = doc.groups.find((g: { group: string }) => g.group === "vault")
    expect(vault.read).toBe(true)
    expect(vault.wallets.map((w: { label: string; role: string }) => [w.label, w.role])).toEqual([
      ["treasury", "vault"],
      ["cold-2", "vault"],
      ["ext-1", "external"],
    ])
    const treasury = vault.wallets[0]
    expect(
      treasury.holdings.map((x: { symbol: string; amount: string; valueUsd: number }) => [
        x.symbol,
        x.amount,
        x.valueUsd,
      ]),
    ).toEqual([
      ["SOL", "3", 300],
      ["USDC", "25", 25],
      ["MEME", "2", 1],
    ])
    // An unpriced holding is null-valued and counted, never zero.
    const odd = vault.wallets[1].holdings[0]
    expect(odd).toMatchObject({ mint: ODD, amount: "7", program: "token-2022", priceUsd: null, valueUsd: null })
    expect(vault.unpriced).toBe(1)
    // 300 + 25 + 1 (treasury) + 100 (ext-1 SOL) + 0.5 (tee MEME) + 200 (embedded SOL)
    expect(doc.totalUsd).toBeCloseTo(626.5, 10)
    expect(doc.unpriced).toBe(1)
    expect(doc.rpcHost).toBe("rpc.example.test")
    // stderr names the host, never the URL (which can carry a provider key).
    expect(h.stderr.text).toContain("from rpc.example.test")
    expect(h.stderr.text).not.toContain("key-in-path")
  })

  test("146 TEE wallets and 150 vault keys: one Candle read, batched vault reads, one readable table", async () => {
    const entries = Array.from({ length: 150 }, (_, i) => entryAt(i, `v-${i}`))
    const { dir } = await vaultWith(entries)
    const tee = Array.from({ length: 146 }, (_, i) => ({
      id: `w${i}`,
      address: teeAddress(i),
      label: `tee-${i}`,
      active: true,
      lamports: i < 10 ? String((i + 1) * 100_000_000) : "0",
      tokens: [],
    }))
    const h = harness({
      dir,
      env: { CANDLE_SOLANA_RPC_URL: RPC_URL },
      tee,
      rpcLamports: (a) => (a === vaultAddress(7) ? 1_000_000_000 : 0),
    })
    const code = await run(["portfolio"], h.deps)
    expect(code).toBe(0)
    expect(h.candleRequests().map((r) => r.path)).toEqual(["/api/v1/agent/portfolio"])
    const methods = h.rpcRequests().map((r) => (JSON.parse(r.body) as { method: string }).method)
    expect(methods.filter((m) => m === "getMultipleAccounts")).toHaveLength(2)
    expect(methods.filter((m) => m === "getTokenAccountsByOwner")).toHaveLength(300)
    expect(h.peak()).toBeLessThanOrEqual(8)
    // Only wallets holding something become rows: 10 TEE, 1 vault, 1 embedded.
    const rows = h.stdout.text.split("\n").filter((line) => /^(vault|tee|embedded)\s+\S+.*\$/.test(line))
    expect(rows.filter((line) => line.startsWith("tee ") && line.includes("(TeeW"))).toHaveLength(10)
    expect(h.stdout.text).toMatch(/tee\s+\$550\.00\s+146 wallets, 136 empty not shown/)
    expect(h.stdout.text).toMatch(/vault\s+\$100\.00\s+150 wallets, 149 empty not shown/)
    // Sorted by value: the largest TEE wallet first.
    const firstTee = rows.find((line) => line.startsWith("tee "))
    expect(firstTee).toContain("tee-9 ")
  })

  test("a vault wallet the RPC refused is listed as not read, the total excludes it, and the exit is 3", async () => {
    const { dir } = await vaultWith([entryAt(0, "treasury"), entryAt(1, "busy")])
    const h = harness({
      dir,
      env: { CANDLE_SOLANA_RPC_URL: RPC_URL },
      rpcLamports: () => 1_000_000_000,
      rpcFailOwner: vaultAddress(1),
    })
    const code = await run(["portfolio"], h.deps)
    expect(code).toBe(3)
    // SOL answered, the token read did not: the SOL is shown and counted, the tokens are "not read".
    expect(h.stdout.text).toMatch(/vault\s+solana\s+busy \(7xKX…[^)]+\)\s+SOL\s+1\s+\$100\.00\s+\$100\.00/)
    expect(h.stdout.text).toMatch(/vault\s+solana\s+busy \(7xKX…[^)]+\)\s+tokens\s+not read\s+-\s+-/)
    expect(h.stdout.text).toContain(
      '1 wallet could not be read in full (1 on Solana). What was not read is marked "not read" and is not in the total.',
    )

    const j = harness({
      dir,
      env: { CANDLE_SOLANA_RPC_URL: RPC_URL },
      rpcLamports: () => 1_000_000_000,
      rpcFailOwner: vaultAddress(1),
    })
    expect(await run(["portfolio", "--json"], j.deps)).toBe(3)
    const doc = JSON.parse(j.stdout.text)
    expect(doc.complete).toBe(false)
    expect(doc.unavailable).toEqual([vaultAddress(1)])
    const busy = doc.groups[0].wallets.find((w: { label: string }) => w.label === "busy")
    expect(busy.unread).toEqual(["tokens"])
    expect(busy.holdings.map((x: { symbol: string }) => x.symbol)).toEqual(["SOL"])
  })

  test("an RPC given with no vault file: nothing is unlocked and the vault row says where it looked", async () => {
    const dir = await emptyConfigDir()
    const h = harness({ dir, env: { CANDLE_SOLANA_RPC_URL: RPC_URL } })
    expect(await run(["portfolio"], h.deps)).toBe(0)
    expect(h.asked).toEqual([])
    expect(h.rpcRequests()).toEqual([])
    expect(h.stdout.text).toMatch(/vault\s+-\s+no vault at /)
  })

  test("a vault to read without a terminal refuses before any request", async () => {
    const { dir } = await vaultWith([entryAt(0, "treasury")])
    const h = harness({ dir, env: { CANDLE_SOLANA_RPC_URL: RPC_URL }, tty: false })
    expect(await run(["portfolio", "--json"], h.deps)).toBe(1)
    expect(JSON.parse(h.stdout.text)).toMatchObject({ ok: false, code: "VAULT_UNLOCK_FAILED" })
    expect(h.requests).toEqual([])
  })

  test("Candle refusing the account read is the API's envelope and exit 1", async () => {
    const dir = await emptyConfigDir()
    const h = harness({ dir, candleStatus: 403 })
    expect(await run(["portfolio", "--json"], h.deps)).toBe(1)
    expect(JSON.parse(h.stdout.text)).toMatchObject({ ok: false, code: "SCOPE_MISSING" })
  })

  test("a plain-http public RPC URL is a usage refusal", async () => {
    const dir = await emptyConfigDir()
    const h = harness({ dir })
    expect(await run(["portfolio", "--rpc-url", "http://rpc.example.test", "--json"], h.deps)).toBe(2)
    expect(JSON.parse(h.stdout.text)).toMatchObject({ ok: false, code: "USAGE" })
    expect(h.requests).toEqual([])
  })

  /**
   * BE-323 (E2). Candle values each TEE wallet's DAMM v2 positions itself (no Meteora code here);
   * the CLI shows them after the tokens, counts them in the wallet, group and total, carries them
   * per wallet in `--json`, and treats a position it could not read as unknown: a row, a footnote,
   * out of the total, exit 3.
   */
  const POS_A = "PositionNftAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  const POS_B = "PositionNftBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
  const POS_C = "PositionNftCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
  const POOL = "PoolAddressXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
  const lpSection = (unreadable = false) => ({
    positions: [
      {
        position: POS_A,
        pool: POOL,
        wallet: teeAddress(1),
        walletId: "w1",
        tokens: [
          {
            mint: SOL,
            decimals: 9,
            amountRaw: "500000000",
            unclaimedFeesRaw: "10000000",
            symbol: "SOL",
            priceUsd: 100,
            valueUsd: 51,
          },
          {
            mint: USDC,
            decimals: 6,
            amountRaw: "200000000",
            unclaimedFeesRaw: "1500000",
            symbol: "USDC",
            priceUsd: 1,
            valueUsd: 201.5,
          },
        ],
        poolShare: 0.25,
        valueUsd: 252.5,
        unpriced: 0,
      },
      {
        position: POS_B,
        pool: POOL,
        wallet: teeAddress(2),
        walletId: "w2",
        tokens: [
          { mint: MEME, decimals: 6, amountRaw: "3000000", unclaimedFeesRaw: "0", priceUsd: null, valueUsd: null },
          {
            mint: USDC,
            decimals: 6,
            amountRaw: "1000000",
            unclaimedFeesRaw: "0",
            symbol: "USDC",
            priceUsd: 1,
            valueUsd: 1,
          },
        ],
        poolShare: 0.01,
        valueUsd: null,
        unpriced: 1,
      },
    ],
    unreadable: unreadable ? [{ position: POS_C, wallet: teeAddress(1), walletId: "w1" }] : [],
    complete: !unreadable,
  })

  test("an lp section: positions after the tokens, valued at Candle's marks, counted in the wallet, group and total", async () => {
    const dir = await emptyConfigDir()
    const h = harness({
      dir,
      tee: [
        { id: "w1", address: teeAddress(1), label: "tee-1", active: true, lamports: "500000000", tokens: [] },
        { id: "w2", address: teeAddress(2), active: true, lamports: "0", tokens: [] },
      ],
      lp: lpSection(),
    })
    expect(await run(["portfolio"], h.deps)).toBe(0)
    const out = h.stdout.text
    // The token table first, then the LP table.
    expect(out.indexOf("GROUP     CHAIN   WALLET")).toBeLessThan(out.indexOf("LP positions"))
    expect(out).toContain("GROUP  WALLET             POSITION   POOL       HOLDINGS")
    expect(out).toMatch(
      /tee\s+tee-1 \(TeeW…[^)]+\)\s+Posi…AAAA\s+Pool…XXXX\s+0\.5 SOL \+ 200 USDC\s+0\.01 SOL \+ 1\.5 USDC\s+\$252\.50/,
    )
    // An unpriced side: the amounts are shown, the value is a word, and the wallet is listed although it holds no token.
    expect(out).toMatch(
      /tee\s+\(TeeW…[^)]+\)\s+Posi…BBBB\s+Pool…XXXX\s+3 Meme…1111 \+ 1 USDC\s+0 Meme…1111 \+ 0 USDC\s+unpriced/,
    )
    // tee: $50 of SOL + $252.50 of LP; 2 positions, one unpriced. Total adds the embedded $200.
    expect(out).toMatch(/tee\s+\$302\.50\s+2 wallets, 2 LP positions, 1 unpriced/)
    expect(out).toMatch(/total\s+\$502\.50\s+1 unpriced holding not counted/)
  })

  test("--json carries the positions per wallet and a top-level lp summary", async () => {
    const dir = await emptyConfigDir()
    const h = harness({
      dir,
      tee: [
        { id: "w1", address: teeAddress(1), label: "tee-1", active: true, lamports: "500000000", tokens: [] },
        { id: "w2", address: teeAddress(2), active: true, lamports: "0", tokens: [] },
      ],
      lp: lpSection(),
    })
    expect(await run(["portfolio", "--json"], h.deps)).toBe(0)
    const doc = JSON.parse(h.stdout.text)
    expect(doc.complete).toBe(true)
    expect(doc.totalUsd).toBeCloseTo(502.5, 10)
    expect(doc.unpriced).toBe(1)
    expect(doc.lp).toEqual({ positions: 2, unpriced: 1, unreadable: 0, valueUsd: 252.5 })
    const tee = doc.groups.find((g: { group: string }) => g.group === "tee")
    expect(tee.valueUsd).toBeCloseTo(302.5, 10)
    expect(tee.unpriced).toBe(1)
    const [w1, w2] = tee.wallets
    expect(w1.valueUsd).toBeCloseTo(302.5, 10)
    expect(w1.lpPositions).toHaveLength(1)
    expect(w1.lpPositions[0]).toMatchObject({
      position: POS_A,
      pool: POOL,
      poolShare: 0.25,
      valueUsd: 252.5,
      unpriced: 0,
    })
    expect(
      w1.lpPositions[0].tokens.map((t: { symbol: string; amount: string; unclaimedFees: string; valueUsd: number }) => [
        t.symbol,
        t.amount,
        t.unclaimedFees,
        t.valueUsd,
      ]),
    ).toEqual([
      ["SOL", "0.5", "0.01", 51],
      ["USDC", "200", "1.5", 201.5],
    ])
    expect(w1.lpUnread).toBeUndefined()
    expect(w2.lpPositions[0]).toMatchObject({ position: POS_B, valueUsd: null, unpriced: 1 })
    expect(w2.lpPositions[0].tokens[0]).toMatchObject({ mint: MEME, symbol: null, priceUsd: null, valueUsd: null })
    // The vault group carries no LP fields at all; the embedded wallet gets an empty list.
    const vault = doc.groups.find((g: { group: string }) => g.group === "vault")
    expect(vault.wallets).toEqual([])
    const embedded = doc.groups.find((g: { group: string }) => g.group === "embedded")
    expect(embedded.wallets[0].lpPositions).toEqual([])
  })

  test("a position Candle could not read: a not-read row, a footnote, out of the total, exit 3", async () => {
    const dir = await emptyConfigDir()
    const h = harness({
      dir,
      tee: [{ id: "w1", address: teeAddress(1), label: "tee-1", active: true, lamports: "500000000", tokens: [] }],
      lp: {
        ...lpSection(true),
        positions: [lpSection().positions[0] as NonNullable<Parameters<typeof harness>[0]["lp"]>["positions"][number]],
      },
    })
    expect(await run(["portfolio"], h.deps)).toBe(3)
    const out = h.stdout.text
    expect(out).toMatch(/tee\s+tee-1 \(TeeW…[^)]+\)\s+Posi…CCCC\s+-\s+not read\s+-\s+-/)
    expect(out).toMatch(/tee\s+\$302\.50\s+1 wallet, 1 LP position, 1 LP not read/)
    expect(out).toContain(
      '1 LP position could not be read (the pool did not answer). It is marked "not read" and not in the total.',
    )

    const j = harness({
      dir,
      tee: [{ id: "w1", address: teeAddress(1), label: "tee-1", active: true, lamports: "500000000", tokens: [] }],
      lp: { ...lpSection(true), positions: [] },
    })
    expect(await run(["portfolio", "--json"], j.deps)).toBe(3)
    const doc = JSON.parse(j.stdout.text)
    expect(doc.complete).toBe(false)
    expect(doc.lp).toEqual({ positions: 0, unpriced: 0, unreadable: 1, valueUsd: 0 })
    expect(doc.groups.find((g: { group: string }) => g.group === "tee").wallets[0].lpUnread).toEqual([POS_C])
  })

  test("without an lp section nothing LP is printed or carried", async () => {
    const dir = await emptyConfigDir()
    const h = harness({
      dir,
      tee: [{ id: "w1", address: teeAddress(1), label: "tee-1", active: true, lamports: "500000000", tokens: [] }],
    })
    expect(await run(["portfolio", "--json"], h.deps)).toBe(0)
    const doc = JSON.parse(h.stdout.text)
    expect(doc.lp).toBeUndefined()
    expect(doc.groups.find((g: { group: string }) => g.group === "tee").wallets[0].lpPositions).toBeUndefined()
    const t = harness({
      dir,
      tee: [{ id: "w1", address: teeAddress(1), label: "tee-1", active: true, lamports: "500000000", tokens: [] }],
    })
    expect(await run(["portfolio"], t.deps)).toBe(0)
    expect(t.stdout.text).not.toContain("LP")
  })

  test("control characters in an LP token symbol never reach the terminal", async () => {
    const dir = await emptyConfigDir()
    const section = lpSection()
    // A mint the CLI does not name itself (SOL and USDC take the CLI's own symbols): the server's.
    const meme = section.positions[1]?.tokens[0]
    if (meme) meme.symbol = "ME\u001b[2JME\u0007"
    const h = harness({
      dir,
      tee: [
        { id: "w1", address: teeAddress(1), label: "tee-1", active: true, lamports: "500000000", tokens: [] },
        { id: "w2", address: teeAddress(2), active: true, lamports: "0", tokens: [] },
      ],
      lp: section,
    })
    expect(await run(["portfolio"], h.deps)).toBe(0)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence.
    expect(h.stdout.text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)
    expect(h.stdout.text).toContain("3 ME[2JME")
  })

  test("control characters in a server-supplied symbol or label never reach the terminal; --json keeps them escaped", async () => {
    const dir = await emptyConfigDir()
    const hostile = "\u001b[2J\u001b[31mUSDC\u0007\u009b"
    const tee = [
      {
        id: "w1",
        address: teeAddress(1),
        label: "tee\u001b[8m-hidden",
        active: true,
        lamports: "0",
        tokens: [{ mint: MEME, amountRaw: "1000000", decimals: 6, program: "token" as const }],
      },
    ]
    const candlePrices = {
      [SOL]: { priceUsd: 100, source: "jupiter" },
      [MEME]: { priceUsd: 2, source: "market", symbol: hostile },
    }
    const h = harness({ dir, tee, candlePrices })
    expect(await run(["portfolio"], h.deps)).toBe(0)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence.
    expect(h.stdout.text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)
    expect(h.stdout.text).toMatch(
      /tee\s+solana\s+tee\[8m-hidden \(TeeW…[^)]+\)\s+\[2J\[31mUSDC\s+1\s+\$2\.00\s+\$2\.00/,
    )

    const j = harness({ dir, tee, candlePrices })
    expect(await run(["portfolio", "--json"], j.deps)).toBe(0)
    const doc = JSON.parse(j.stdout.text)
    expect(doc.groups[1].wallets[0].holdings[0].symbol).toBe(hostile)
    expect(j.stdout.text).not.toContain("\u001b")
  })
})

/**
 * BE-355 (T13): a chunk still rate-limited after the client's retry stops the vault read. Nothing
 * more is sent (no third chunk, no token reads), every wallet not yet read is "not read", the exit
 * is 3 with `complete: false`, and the stderr line carries `RPC_RATE_LIMITED` and the fix.
 */
describe("BE-355 T13: a rate-limited vault read is partial, and stops", () => {
  test("second chunk rate-limited twice: chunk 3 never sent, no token reads, exit 3, the fix on stderr", async () => {
    const entries = Array.from({ length: 250 }, (_, i) => entryAt(i, `v-${i}`))
    const { dir } = await vaultWith(entries)
    const h = harness({
      dir,
      env: { CANDLE_SOLANA_RPC_URL: RPC_URL },
      tee: [],
      rpcLamports: () => 1_000_000_000,
      rpcRateLimitCalls: [2, 3],
    })
    expect(await run(["portfolio", "--json"], h.deps)).toBe(3)
    const methods = h.rpcRequests().map((r) => (JSON.parse(r.body) as { method: string }).method)
    expect(methods).toEqual(["getMultipleAccounts", "getMultipleAccounts", "getMultipleAccounts"])
    const doc = JSON.parse(h.stdout.text) as {
      complete: boolean
      unavailable: string[]
      groups: { group: string; read: boolean; wallets: { unread?: string[] }[] }[]
    }
    expect(doc.complete).toBe(false)
    expect(doc.unavailable).toHaveLength(250)
    expect(doc.groups[0]?.read).toBe(true)
    expect(h.stderr.text).toContain(
      "250 vault addresses could not be read: RPC_RATE_LIMITED (HTTP 429, retried once). Fix: --rpc-url https://<your-rpc> on this command, or CANDLE_SOLANA_RPC_URL for every command, or sign in (candle auth login) to store one per profile.",
    )
    expect(h.stderr.text).toContain("Solana RPC: rpc.example.test (CANDLE_SOLANA_RPC_URL)")
    expect(h.stdout.text + h.stderr.text).not.toContain("key-in-path")
  })
})

/**
 * Ember Phase 4d PR B (BE-670, 4d-ED-1 to 4d-ED-7): Hood rows in `candle portfolio`.
 *
 * Candle's Hood wallets arrive in the answer's `hood` section; EVM vault keys are read over the
 * operator's EVM RPC (evm.example.test here) for ETH and USDG, and priced by asset alone.
 */
const EVM_RPC_URL = "https://evm.example.test/key-in-path"
const HOOD_TEE = "0x1111111111111111111111111111111111111111"
const HOOD_EMBEDDED = "0x2222222222222222222222222222222222222222"
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"
const HOODIE = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa"
const STALE = "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb"

function evmEntryAt(index: number, label: string, address: string): KeyEntry {
  return {
    ...entryAt(900 + index, label),
    id: `evm-${String(index).padStart(3, "0")}`,
    chain: "evm",
    curve: "secp256k1",
    address,
    derivation: { scheme: "bip32-secp256k1", path: `m/44'/60'/${index}'/0/0` },
  }
}

/** One Hood TEE wallet (ETH, USDG, a fresh-marked token, a stale one) and the Hood embedded wallet. */
function hoodSection(overrides: Partial<HoodSection> = {}): HoodSection {
  return {
    embedded: [{ address: HOOD_EMBEDDED, chain: "hood", wei: "500000000000000000", tokens: [] }],
    tee: [
      {
        id: "hw1",
        address: HOOD_TEE,
        label: "hood-1",
        active: true,
        chain: "hood",
        wei: "1000000000000000000",
        tokens: [
          { chain: "hood", mint: USDG, amountRaw: "25000000", decimals: 6 },
          { chain: "hood", mint: HOODIE, amountRaw: "3000000000000000000", decimals: 18, symbol: "HOODIE" },
          { chain: "hood", mint: STALE, amountRaw: "7000000000000000000", decimals: 18, symbol: "STALE" },
        ],
      },
    ],
    unavailable: [],
    unpriced: 1,
    unpricedByReason: { "stale-mark": 1 },
    ...overrides,
  }
}

/** Candle's prices map: Solana by mint, Hood under lowercased `hood:` keys (4d-ED-5). */
const HOOD_PRICES = {
  [SOL]: { priceUsd: 100, source: "jupiter", symbol: "SOL" },
  "hood:native": { priceUsd: 2000, source: "reference" },
  [`hood:${USDG.toLowerCase()}`]: { priceUsd: 1, source: "reference" },
  [`hood:${HOODIE.toLowerCase()}`]: { priceUsd: 0.5, source: "market", symbol: "HOODIE" },
  [`hood:${STALE.toLowerCase()}`]: { priceUsd: null, source: null, symbol: "STALE", unpricedReason: "stale-mark" },
}

describe("Ember 4d: Hood in candle portfolio", () => {
  test("Candle's hood section: a CHAIN column, ETH, USDG and tokens at hood: prices, the reason where a value would be, per-chain subtotals", async () => {
    const dir = await emptyConfigDir()
    const h = harness({
      dir,
      tee: [{ id: "w1", address: teeAddress(1), label: "tee-1", active: true, lamports: "500000000", tokens: [] }],
      candlePrices: HOOD_PRICES,
      hood: hoodSection(),
    })
    expect(await run(["portfolio"], h.deps)).toBe(0)
    // Hood rows come from Candle's one read; nothing else is asked.
    expect(h.candleRequests().map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/v1/agent/portfolio"])
    expect(h.evmRequests()).toEqual([])
    const out = h.stdout.text
    expect(out).toContain("GROUP     CHAIN   WALLET")
    expect(out).toMatch(/tee\s+solana\s+tee-1 \(TeeW…[^)]+\)\s+SOL\s+0\.5\s+\$100\.00\s+\$50\.00/)
    expect(out).toMatch(/tee\s+hood\s+hood-1 \(0x11…1111\)\s+ETH\s+1\s+\$2,000\.00\s+\$2,000\.00/)
    expect(out).toMatch(/tee\s+hood\s+hood-1 \(0x11…1111\)\s+USDG\s+25\s+\$1\.00\s+\$25\.00/)
    expect(out).toMatch(/tee\s+hood\s+hood-1 \(0x11…1111\)\s+HOODIE\s+3\s+\$0\.5\s+\$1\.50/)
    // 4d-ED-4: an unpriced Hood token shows its reason where its value would be, never $0.
    expect(out).toMatch(/tee\s+hood\s+hood-1 \(0x11…1111\)\s+STALE\s+7\s+unpriced\s+stale-mark/)
    expect(out).toMatch(/embedded\s+hood\s+\(0x22…2222\)\s+ETH\s+0\.5\s+\$2,000\.00\s+\$1,000\.00/)
    expect(out).toMatch(/embedded\s+solana\s+\(Embe…1111\)\s+SOL\s+2\s+\$100\.00\s+\$200\.00/)
    // Per group, then per chain, then one total (4d-ED-7). Hood's unpriced line is hood.unpricedByReason.
    expect(out).toMatch(/tee\s+\$2,076\.50\s+2 wallets, 1 unpriced/)
    expect(out).toMatch(/embedded\s+\$1,200\.00\s+2 wallets/)
    expect(out).toMatch(/solana\s+\$250\.00\s+2 wallets\n/)
    expect(out).toMatch(/hood\s+\$3,026\.50\s+2 wallets, 1 unpriced \(1 stale-mark\)/)
    expect(out).toMatch(/total\s+\$3,276\.50\s+1 unpriced holding not counted/)
    const lines = out.split("\n")
    const at = (label: string) => lines.findIndex((line) => line.startsWith(label))
    expect(at("embedded ")).toBeLessThan(at("solana "))
    expect(at("solana ")).toBeLessThan(at("hood "))
    expect(at("hood ")).toBeLessThan(at("total "))
  })

  test("--json: chain on every wallet and holding, per-chain and per-group subtotals", async () => {
    const dir = await emptyConfigDir()
    const h = harness({
      dir,
      tee: [{ id: "w1", address: teeAddress(1), active: true, lamports: "500000000", tokens: [] }],
      candlePrices: HOOD_PRICES,
      hood: hoodSection(),
    })
    expect(await run(["portfolio", "--json"], h.deps)).toBe(0)
    const doc = JSON.parse(h.stdout.text)
    expect(doc.chains).toEqual(["solana", "hood"])
    expect(doc.complete).toBe(true)
    expect(doc.totalUsd).toBeCloseTo(3276.5)
    expect(doc.byChain.solana).toEqual({ valueUsd: 250, unpriced: 0, wallets: 2, unavailable: 0 })
    expect(doc.byChain.hood).toEqual({
      valueUsd: 3026.5,
      unpriced: 1,
      wallets: 2,
      unavailable: 0,
      unpricedByReason: { "stale-mark": 1 },
    })
    const tee = doc.groups.find((g: { group: string }) => g.group === "tee")
    expect(tee.byChain).toEqual({ solana: { valueUsd: 50, unpriced: 0 }, hood: { valueUsd: 2026.5, unpriced: 1 } })
    for (const group of doc.groups) {
      for (const wallet of group.wallets) {
        expect(["solana", "hood"]).toContain(wallet.chain)
        for (const holding of wallet.holdings ?? []) expect(holding.chain).toBe(wallet.chain)
      }
    }
    const hoodTee = tee.wallets.find((w: { chain: string }) => w.chain === "hood")
    expect(hoodTee).toMatchObject({ chain: "hood", address: HOOD_TEE, id: "hw1", label: "hood-1", active: true })
    expect(hoodTee.holdings.map((x: { symbol: string; program: string }) => `${x.symbol}:${x.program}`)).toEqual([
      "ETH:native",
      "USDG:erc20",
      "HOODIE:erc20",
      "STALE:erc20",
    ])
    const stale = hoodTee.holdings.find((x: { symbol: string }) => x.symbol === "STALE")
    expect(stale).toMatchObject({ priceUsd: null, valueUsd: null, unpricedReason: "stale-mark" })
    expect(hoodTee.holdings[0]).toMatchObject({ mint: "native", amount: "1", priceUsd: 2000, priceSource: "reference" })
  })

  test("an EVM vault key: read over the operator's EVM RPC, host on stderr first, priced by asset with no address sent", async () => {
    const { dir } = await vaultWith([entryAt(0, "treasury"), evmEntryAt(0, "hood-cold", FIXTURE_EVM_0)])
    const h = harness({
      dir,
      env: { CANDLE_SOLANA_RPC_URL: RPC_URL, CANDLE_EVM_RPC_URL: EVM_RPC_URL },
      rpcLamports: () => 1_000_000_000,
      evm: { wei: () => 2_000_000_000_000_000_000n, usdg: () => 1_500_000n },
      hoodPrices: { native: { priceUsd: 2000, source: "reference" }, [USDG]: { priceUsd: 1, source: "reference" } },
    })
    expect(await run(["portfolio"], h.deps)).toBe(0)
    // ETH, then USDG: eth_chainId once, then balance and balanceOf for the one key.
    expect(h.evmRequests().map((r) => (JSON.parse(r.body) as { method: string }).method)).toEqual([
      "eth_chainId",
      "eth_getBalance",
      "eth_call",
    ])
    // The Solana RPC never saw the 0x address; Candle never saw either vault address.
    for (const r of h.rpcRequests()) expect(r.body).not.toContain(FIXTURE_EVM_0)
    for (const r of h.candleRequests()) {
      expect(`${r.path} ${r.body}`.toLowerCase()).not.toContain(FIXTURE_EVM_0.toLowerCase())
      expect(`${r.path} ${r.body}`).not.toContain(vaultAddress(0))
    }
    // 4d-ED-4: one hood price request, `native` and the USDG contract, and nothing else.
    const hoodPriced = h
      .candleRequests()
      .filter((r) => r.path === "/api/v1/agent/prices" && r.body.includes("hood"))
      .map((r) => JSON.parse(r.body))
    expect(hoodPriced).toEqual([{ hood: ["native", USDG] }])
    // 4d-ED-6: the host, never the URL, before the first EVM request.
    expect(h.stderr.text).toContain(
      "Reading ETH and USDG for 1 EVM vault address from evm.example.test in 3 requests. That endpoint sees them together; Candle sees none of them.",
    )
    expect(h.stderr.text).not.toContain("key-in-path")
    const out = h.stdout.text
    expect(out).toMatch(/vault\s+hood\s+hood-cold \(0xF9…A40F\)\s+ETH\s+2\s+\$2,000\.00\s+\$4,000\.00/)
    expect(out).toMatch(/vault\s+hood\s+hood-cold \(0xF9…A40F\)\s+USDG\s+1\.5\s+\$1\.00\s+\$1\.50/)
    expect(out).toMatch(/vault\s+solana\s+treasury/)
    expect(out).toContain("EVM vault keys are read for ETH and USDG only")
  })

  test("--evm-rpc-url wins over the env, and the built-in Hood RPC is named when neither is set", async () => {
    const { dir } = await vaultWith([evmEntryAt(0, "hood-cold", FIXTURE_EVM_0)])
    const h = harness({
      dir,
      env: { CANDLE_EVM_RPC_URL: "https://ignored.example.test/rpc" },
      evm: { wei: () => 0n, usdg: () => 0n },
    })
    expect(await run(["portfolio", "--chain", "hood", "--evm-rpc-url", EVM_RPC_URL], h.deps)).toBe(0)
    expect(h.evmRequests()).toHaveLength(3)
    expect(h.requests.some((r) => r.host === "ignored.example.test")).toBe(false)
    // An empty wallet is listed as such, and nothing is priced for it.
    expect(h.candleRequests().map((r) => r.path)).toEqual(["/api/v1/agent/portfolio"])

    const builtIn = harness({ dir, evm: {} })
    const hood = new Set<string>()
    builtIn.deps.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.host === "rpc.mainnet.chain.robinhood.com") {
        hood.add(url.host)
        return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "not in this test" } })
      }
      return h.deps.fetch(input, init)
    }) as typeof fetch
    expect(await run(["portfolio", "--chain", "hood"], builtIn.deps)).toBe(3)
    expect(hood).toEqual(new Set(["rpc.mainnet.chain.robinhood.com"]))
    expect(builtIn.stderr.text).toContain("from rpc.mainnet.chain.robinhood.com (the built-in Hood RPC)")
  })

  test("an EVM RPC on another chain is refused by name before any balance is read (4d-ED-3)", async () => {
    const { dir } = await vaultWith([evmEntryAt(0, "hood-cold", FIXTURE_EVM_0)])
    const h = harness({ dir, env: { CANDLE_EVM_RPC_URL: EVM_RPC_URL }, evm: { chainId: 1 } })
    expect(await run(["portfolio"], h.deps)).toBe(1)
    expect(h.evmRequests().map((r) => (JSON.parse(r.body) as { method: string }).method)).toEqual(["eth_chainId"])
    expect(h.candleRequests()).toEqual([])
    expect(h.stderr.text).toContain("evm.example.test answered chain id 1")
    expect(h.stderr.text).toContain("Hood, chain id 4663, only")

    const j = harness({ dir, env: { CANDLE_EVM_RPC_URL: EVM_RPC_URL }, evm: { chainId: 8453 } })
    expect(await run(["portfolio", "--json"], j.deps)).toBe(1)
    expect(JSON.parse(j.stdout.text)).toMatchObject({ ok: false, code: "EVM_CHAIN_MISMATCH" })
  })

  test("--chain hood reads nothing on Solana and shows Hood alone; --chain solana reads nothing on Hood", async () => {
    const { dir } = await vaultWith([entryAt(0, "treasury"), evmEntryAt(0, "hood-cold", FIXTURE_EVM_0)])
    const hood = harness({
      dir,
      env: { CANDLE_SOLANA_RPC_URL: RPC_URL, CANDLE_EVM_RPC_URL: EVM_RPC_URL },
      tee: [{ id: "w1", address: teeAddress(1), active: true, lamports: "500000000", tokens: [] }],
      candlePrices: HOOD_PRICES,
      hood: hoodSection(),
      evm: { wei: () => 1_000_000_000_000_000_000n, usdg: () => 0n },
    })
    expect(await run(["portfolio", "--chain", "hood", "--json"], hood.deps)).toBe(0)
    expect(hood.rpcRequests()).toEqual([])
    const doc = JSON.parse(hood.stdout.text)
    expect(doc.chains).toEqual(["hood"])
    expect(Object.keys(doc.byChain)).toEqual(["hood"])
    expect(doc.rpcHost).toBeNull()
    expect(doc.evmRpcHost).toBe("evm.example.test")
    const wallets = doc.groups.flatMap((g: { wallets: { chain: string }[] }) => g.wallets)
    expect(wallets.map((w: { chain: string }) => w.chain)).toEqual(["hood", "hood", "hood"])

    const solana = harness({
      dir,
      env: { CANDLE_SOLANA_RPC_URL: RPC_URL, CANDLE_EVM_RPC_URL: EVM_RPC_URL },
      candlePrices: HOOD_PRICES,
      hood: hoodSection(),
      rpcLamports: () => 1_000_000_000,
    })
    expect(await run(["portfolio", "--chain", "solana"], solana.deps)).toBe(0)
    expect(solana.evmRequests()).toEqual([])
    expect(solana.stdout.text).not.toMatch(/\bhood\b/)
    expect(solana.stdout.text).toMatch(/vault\s+solana\s+treasury/)
  })

  test("--chain and the RPC flags are checked before anything is asked or sent", async () => {
    const { dir } = await vaultWith([entryAt(0, "treasury")])
    for (const argv of [
      ["portfolio", "--chain", "base"],
      ["portfolio", "--chain", "solana", "--evm-rpc-url", EVM_RPC_URL],
      ["portfolio", "--chain", "hood", "--rpc-url", RPC_URL],
      ["portfolio", "--evm-rpc-url", "http://evm.example.test/rpc"],
    ]) {
      const h = harness({ dir })
      expect(await run(argv, h.deps)).toBe(2)
      expect(h.asked).toEqual([])
      expect(h.requests).toEqual([])
    }
    const bad = harness({ dir })
    await run(["portfolio", "--chain", "base"], bad.deps)
    expect(bad.stderr.text).toContain("--chain must be solana or hood, not base.")
  })

  test("a Hood wallet Candle could not read: not read, out of the total, exit 3, and the footer names Hood", async () => {
    const dir = await emptyConfigDir()
    const h = harness({
      dir,
      candlePrices: HOOD_PRICES,
      hood: hoodSection({
        tee: [{ id: "hw1", address: HOOD_TEE, label: "hood-1", active: true, chain: "hood", wei: null, tokens: null }],
        unavailable: [HOOD_TEE],
        unpriced: 0,
        unpricedByReason: {},
      }),
    })
    expect(await run(["portfolio"], h.deps)).toBe(3)
    expect(h.stdout.text).toMatch(/tee\s+hood\s+hood-1 \(0x11…1111\)\s+-\s+not read\s+-\s+-/)
    expect(h.stdout.text).toContain(
      '1 wallet could not be read in full (1 on Hood). What was not read is marked "not read" and is not in the total.',
    )

    const j = harness({
      dir,
      candlePrices: HOOD_PRICES,
      hood: hoodSection({
        tee: [
          {
            id: "hw1",
            address: HOOD_TEE,
            active: true,
            chain: "hood",
            wei: "1000000000000000000",
            tokens: null,
          },
        ],
        unavailable: [HOOD_TEE],
      }),
    })
    expect(await run(["portfolio", "--json"], j.deps)).toBe(3)
    const doc = JSON.parse(j.stdout.text)
    expect(doc.complete).toBe(false)
    expect(doc.unavailable).toEqual([HOOD_TEE])
    expect(doc.unavailableByChain).toEqual({ solana: [], hood: [HOOD_TEE] })
    const wallet = doc.groups[1].wallets.find((w: { chain: string }) => w.chain === "hood")
    expect(wallet.unread).toEqual(["hood-tokens"])
    expect(wallet.holdings.map((x: { symbol: string }) => x.symbol)).toEqual(["ETH"])
  })

  test("an EVM vault key whose USDG read failed: ETH counted, USDG not read, exit 3, the failure on stderr", async () => {
    const { dir } = await vaultWith([evmEntryAt(0, "a", FIXTURE_EVM_0), evmEntryAt(1, "b", FIXTURE_EVM_1)])
    const h = harness({
      dir,
      env: { CANDLE_EVM_RPC_URL: EVM_RPC_URL },
      evm: { wei: () => 1_000_000_000_000_000_000n, usdg: () => 2_000_000n, usdgFailAddress: FIXTURE_EVM_1 },
      hoodPrices: { native: { priceUsd: 2000, source: "reference" }, [USDG]: { priceUsd: 1, source: "reference" } },
    })
    expect(await run(["portfolio", "--chain", "hood", "--json"], h.deps)).toBe(3)
    const doc = JSON.parse(h.stdout.text)
    expect(doc.unavailableByChain).toEqual({ hood: [FIXTURE_EVM_1] })
    const b = doc.groups[0].wallets.find((w: { label: string }) => w.label === "b")
    expect(b.unread).toEqual(["usdg"])
    expect(b.holdings.map((x: { symbol: string }) => x.symbol)).toEqual(["ETH"])
    expect(doc.totalUsd).toBe(4002)
    expect(h.stderr.text).toContain("1 EVM vault address on Hood could not be read in full")

    // The EVM chain id not answering at all: every EVM vault key unread, partial, not refused.
    const down = harness({ dir, env: { CANDLE_EVM_RPC_URL: EVM_RPC_URL }, evm: { chainIdFails: true } })
    expect(await run(["portfolio", "--chain", "hood"], down.deps)).toBe(3)
    expect(down.stdout.text).toMatch(/vault\s+hood\s+a \(0xF9…A40F\)\s+-\s+not read/)
    expect(down.stdout.text).toContain("(2 on Hood)")
  })

  test("an API with no hood section (an older deployment) is no Hood wallets, not an error", async () => {
    const dir = await emptyConfigDir()
    const h = harness({
      dir,
      tee: [{ id: "w1", address: teeAddress(1), active: true, lamports: "500000000", tokens: [] }],
    })
    expect(await run(["portfolio", "--json"], h.deps)).toBe(0)
    const doc = JSON.parse(h.stdout.text)
    expect(doc.complete).toBe(true)
    expect(doc.byChain.hood).toEqual({ valueUsd: 0, unpriced: 0, wallets: 0, unavailable: 0, unpricedByReason: {} })
    expect(doc.groups.flatMap((g: { wallets: { chain: string }[] }) => g.wallets.map((w) => w.chain))).toEqual([
      "solana",
      "solana",
    ])
  })
})
