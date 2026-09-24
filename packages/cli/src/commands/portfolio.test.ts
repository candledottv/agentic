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
        nextIndex: { solanaVault: next("0"), solanaTee: next("1"), solanaExternal: next("2"), evm: 0 },
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
  candleStatus?: number
  tty?: boolean
}) {
  const stdout = createCapture()
  const stderr = createCapture()
  const asked: string[] = []
  const requests: Recorded[] = []
  let inFlight = 0
  let peak = 0
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = init?.body ? String(init.body) : ""
    requests.push({ host: url.host, path: url.pathname, method: init?.method ?? "GET", body })
    if (url.host === "rpc.example.test") {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 0))
      inFlight -= 1
      const rpc = JSON.parse(body) as { id: number; method: string; params: unknown[] }
      if (rpc.method === "getMultipleAccounts") {
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
        complete: tee.every((w) => w.lamports !== null && w.tokens !== null),
      })
    }
    if (url.pathname === "/api/v1/agent/prices") {
      const { mints } = JSON.parse(body) as { mints: string[] }
      return Response.json({
        success: true,
        prices: Object.fromEntries(
          mints.map((m) => [
            m,
            opts.prices?.[m] === undefined
              ? { priceUsd: null, source: null }
              : { priceUsd: opts.prices[m], source: "market" },
          ]),
        ),
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
  return { deps, stdout, stderr, asked, requests, candleRequests, rpcRequests, peak: () => peak }
}

async function emptyConfigDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "candle-portfolio-"))
}

describe("candle portfolio", () => {
  test("no RPC: the vault is neither unlocked nor read, and the output says why", async () => {
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
    expect(out).toContain("GROUP     WALLET")
    expect(out).toMatch(/tee\s+tee-1 \(TeeW…[^)]+\)\s+SOL\s+0\.5\s+\$100\.00\s+\$50\.00/)
    expect(out).toMatch(/embedded\s+\(Embe…1111\)\s+SOL\s+2\s+\$100\.00\s+\$200\.00/)
    expect(out).toMatch(/vault\s+-\s+not read: vault balances are read only over your own RPC/)
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
    expect(h.stdout.text).toMatch(/vault\s+busy \(7xKX…[^)]+\)\s+SOL\s+1\s+\$100\.00\s+\$100\.00/)
    expect(h.stdout.text).toMatch(/vault\s+busy \(7xKX…[^)]+\)\s+tokens\s+not read\s+-\s+-/)
    expect(h.stdout.text).toContain(
      '1 wallet could not be read in full. What was not read is marked "not read" and is not in the total.',
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
    expect(h.stdout.text).toMatch(/tee\s+tee\[8m-hidden \(TeeW…[^)]+\)\s+\[2J\[31mUSDC\s+1\s+\$2\.00\s+\$2\.00/)

    const j = harness({ dir, tee, candlePrices })
    expect(await run(["portfolio", "--json"], j.deps)).toBe(0)
    const doc = JSON.parse(j.stdout.text)
    expect(doc.groups[1].wallets[0].holdings[0].symbol).toBe(hostile)
    expect(j.stdout.text).not.toContain("\u001b")
  })
})
