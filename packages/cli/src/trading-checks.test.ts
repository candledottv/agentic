import { describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { readdir } from "node:fs/promises"
import { ed25519 } from "@noble/curves/ed25519"
import { base58 } from "@scure/base"
import type { CommandContext } from "./deps"
import { run } from "./index"
import { pemToStoredSigner } from "./secret-store"
import { decodeStrictBase64, decodeTransaction } from "./solana-alt"
import { createContextFloor, createSolanaRpc, serializeSignedTransaction, withContextFloor } from "./solana-lite"
import { type SolanaScenario, scenarioRpcResult, swapScenario } from "./solana-verify.fixtures"
import { tempDirs } from "./temp-dirs.test-support"
import { createCapture, createFakeConfigStore, createFakeStore, createTestDeps } from "./test-support"
import { BASES, completeTradingWallet, inspectTradingWallet, type TradingWalletRow, tradingPayer } from "./trading"
import { type WalletCheck, type WalletReport, walletRecordCheck } from "./trading-checks"

const tempDir = tempDirs()
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const secret = new Uint8Array(32).fill(42)
const address = base58.encode(ed25519.getPublicKey(secret))
const mint = "7ZL9FvkpCMgdvzfoMSYZSuCXLCYN25dfgtDXej1BBJaB"
const embedded = "9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL"
const row: TradingWalletRow = {
  id: "pg-wallet",
  address,
  label: "pool-1",
  chain: "solana",
  active: true,
  allowLaunch: true,
  privyWalletId: "privy",
}
const record = { _id: row.id, address, label: row.label, chain: "solana", profile: "ember-tee" }
const assetOf = (asset: string) => (asset === "SOL" ? "SOL" : (BASES[asset]?.mint ?? asset))
async function fixture(
  opts: {
    rows?: TradingWalletRow[]
    records?: Record<string, unknown>[]
    scopes?: string[]
    noSigner?: boolean
    embedded?: boolean
    denied?: boolean
    buildError?: string
    badBuild?: Record<string, unknown>
    spendError?: unknown
    signedError?: unknown
    invalidSignature?: boolean
    relayError?: boolean
    malformedTrading?: boolean
    repeatedCursor?: boolean
    repeatedRecords?: boolean
    venue?: string
    overSpend?: boolean
    rateLimited?: boolean
    feeRaw?: string
    receiveRaw?: bigint
    paged?: boolean
  } = {},
) {
  const dir = tempDir("candle-checks-")
  const calls: {
    path: string
    body: {
      clientTradeId: string
      payer: { type: string; linkedWalletId: string }
      amountRaw: string
      maxSlippageBps: number
      method?: string
      params: [string, { sigVerify: boolean; replaceRecentBlockhash: boolean; accounts: { addresses: string[] } }]
    } & Record<string, unknown>
    query: string
  }[] = []
  const stdout = createCapture(),
    stderr = createCapture()
  let scenario: SolanaScenario | undefined
  const fetcher = (async (input, init) => {
    const url = new URL(String(input))
    const path = url.pathname
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    calls.push({ path, body, query: url.search })
    const ok = (data: unknown) => Response.json(data)
    if (path === "/api/v1/agent/wallets/trading")
      return ok({
        scopes: opts.scopes ?? ["swap:write"],
        privyAppId: "app",
        page: opts.malformedTrading ? {} : opts.paged && !url.searchParams.has("cursor") ? [] : (opts.rows ?? [row]),
        isDone: opts.paged ? url.searchParams.has("cursor") : !opts.repeatedCursor,
        continueCursor: opts.paged ? "next" : opts.repeatedCursor ? "same" : null,
      })
    if (path === "/api/v1/agent/wallets")
      return ok({
        page: opts.paged && !url.searchParams.has("cursor") ? [] : (opts.records ?? [record]),
        isDone: opts.paged ? url.searchParams.has("cursor") : !opts.repeatedRecords,
        continueCursor: opts.paged ? "next" : "same",
      })
    if (path === "/api/v1/agent/wallets/embedded")
      return ok({
        wallets: { solana: opts.embedded ? { address: embedded } : null },
        embeddedWalletPermission: opts.denied ? "denied" : "allowed",
      })
    if (path === "/api/v1/agent/keys/self/signer") return ok({ active: null })
    if (path.endsWith("/build")) {
      if (opts.buildError)
        return Response.json({ error: { code: opts.buildError, message: opts.buildError } }, { status: 400 })
      const trade = path.includes("trade/agent")
      const from = trade ? (body.side === "buy" ? body.quoteAsset.toUpperCase() : body.mint) : body.from
      const to = trade ? (body.side === "buy" ? body.mint : body.quoteAsset.toUpperCase()) : body.to
      scenario = swapScenario({
        wallet: address,
        spend: assetOf(from),
        spendRaw:
          BigInt(body.amountRaw) +
          (opts.overSpend ? 100_000_000n : 0n) +
          (trade && body.side === "buy" ? BigInt(opts.feeRaw ?? "0") : 0n),
        receive: assetOf(to),
        receiveRaw: opts.receiveRaw ?? 100000n,
      })
      const quote = {
        status: "built",
        minOutRaw: "100000",
        fee: { bps: 0, feeRaw: opts.feeRaw ?? "0" },
        expiresAt: 10000,
        venue: opts.venue ?? "jupiter",
        priceImpactPct: "0.1",
        tokenRisks: [],
        transactionsBase64: [scenario.transaction],
        recipient: address,
        ...opts.badBuild,
      }
      return ok(
        trade
          ? {
              ...quote,
              chain: "solana",
              walletAddress: address,
              artifacts: { ...quote, quoteAsset: body.quoteAsset, transactionBase64: scenario.transaction },
              ...opts.badBuild,
            }
          : { payload: quote },
      )
    }
    if (path.endsWith("/sign")) {
      if (opts.relayError)
        return Response.json(
          { error: { code: "SIGNER_UNAVAILABLE", message: "remote signer unavailable" } },
          { status: 400 },
        )
      const decoded = decodeTransaction(decodeStrictBase64(body.body.params.transaction))
      const signature = opts.invalidSignature ? new Uint8Array(64) : ed25519.sign(decoded.message.bytes, secret)
      return ok({
        encoding: "base64",
        signedTransaction: Buffer.from(serializeSignedTransaction(decoded.message.bytes, signature)).toString("base64"),
      })
    }
    if (path === "/rpc") {
      if (opts.rateLimited) return new Response("limited", { status: 429 })
      if (body.method === "getTokenSupply") return ok({ jsonrpc: "2.0", id: 1, result: { value: { decimals: 6 } } })
      if (body.method === "simulateTransaction") {
        const signed = body.params[1].sigVerify
        const err = signed ? opts.signedError : opts.spendError
        if (err)
          return ok({
            jsonrpc: "2.0",
            id: 1,
            result: { value: { err, logs: [], accounts: body.params[1].accounts.addresses.map(() => null) } },
          })
      }
      if (scenario) {
        const value = scenarioRpcResult(scenario, body.method, body.params)
        if (value !== undefined) return ok({ jsonrpc: "2.0", id: 1, result: value })
      }
    }
    throw new Error(`Forbidden/unexpected call ${path} ${body?.method ?? ""}`)
  }) as typeof fetch
  const deps = createTestDeps({
    fetch: fetcher,
    env: { CANDLE_CONFIG_DIR: dir, CANDLE_API_KEY: "bound-key", CANDLE_SOLANA_RPC_URL: "http://localhost/rpc" },
    store: createFakeStore(
      opts.noSigner
        ? {}
        : Object.fromEntries((opts.rows ?? [row]).map((r) => [`wallet_signer_${r.id}`, pemToStoredSigner(pem)])),
    ),
    stdout,
    stderr,
    ...createFakeConfigStore(),
  })
  const invoke = async (args: string[]) => {
    stdout.text = "" // capture's text is read below; each fixture normally invokes once
    const exit = await run([...args, "--json"], deps)
    const output = JSON.parse(stdout.text.trim())
    return { exit, output }
  }
  const ctx = { deps, json: true, apiUrl: "http://localhost", profile: undefined } as unknown as CommandContext
  return { deps, ctx, invoke, calls, dir, stdout }
}
interface CheckOutput {
  wallets: WalletReport[]
  summary: { total: number; pass: number; fail: number }
  quote?: Record<string, unknown>
  code?: string
}
const check = (output: CheckOutput, id: string): WalletCheck => {
  const found = output.wallets[0]?.checks.find((c) => c.id === id)
  if (!found) throw new Error(`Missing ${id} check`)
  return found
}

describe("TEE checks and dry runs", () => {
  test("batch continues after one unpayable wallet and prints a one-line summary", async () => {
    const f = await fixture()
    expect(await run(["tee", "check", "missing", "pool-1"], f.deps)).toBe(1)
    const lines = f.stdout.text.trim().split("\n")
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain("FAIL  payable/TEE_WALLET_REQUIRED")
    expect(lines[1]).toContain("PASS")
    expect(lines[2]).toBe("1 pass, 1 fail")
  })
  test("missing scope and unpayable swap payer both report without building", async () => {
    const f = await fixture({ scopes: [] })
    const { output } = await f.invoke(["swap", "SOL", "USDC", "--amount", "1", "--wallet", "missing", "--dry-run"])
    expect(check(output, "scope").code).toBe("SCOPE_MISSING")
    expect(check(output, "payable").code).toBe("TEE_WALLET_REQUIRED")
    expect(f.calls.some((c) => c.path.endsWith("/build"))).toBe(false)
  })
  test("prefix selects the complete list and rejects an empty selection", async () => {
    const f = await fixture()
    expect((await f.invoke(["tee", "check", "--label-prefix", "pool-"])).output.summary.total).toBe(1)
    const empty = await fixture()
    expect((await empty.invoke(["tee", "check", "--label-prefix", "absent-"])).output.code).toBe("TEE_WALLET_REQUIRED")
  })
  test("prefix and record parity read both listings to their final page", async () => {
    const f = await fixture({ paged: true })
    expect((await f.invoke(["tee", "check", "--label-prefix", "pool-"])).exit).toBe(0)
    expect(f.calls.filter((c) => c.path.endsWith("/trading"))).toHaveLength(2)
    expect(f.calls.filter((c) => c.path.endsWith("/wallets"))).toHaveLength(2)
    expect(f.calls.filter((c) => c.query.includes("cursor=next"))).toHaveLength(2)
  })
  test("prefix still checks each wallet when an explicit label is ambiguous", async () => {
    const other = { ...row, id: "other", address: embedded }
    const f = await fixture({
      rows: [row, other],
      records: [record, { ...record, _id: other.id, address: other.address }],
    })
    const { output } = await f.invoke(["tee", "check", "pool-1", "--label-prefix", "pool-"])
    expect(output.summary).toEqual({ total: 3, pass: 2, fail: 1 })
  })
  test("dry-run RPC rate limiting is RPC_RATE_LIMITED, with no signing", async () => {
    const f = await fixture({ rateLimited: true })
    const { output } = await f.invoke(["swap", "SOL", mint, "--amount", "1", "--dry-run"])
    expect(check(output, "quote").code).toBe("RPC_RATE_LIMITED")
    expect(f.calls.some((c) => /\/(sign|execute|submit)$/.test(c.path))).toBe(false)
  })
  test("invalid RPC option retains the real swap's usage exit", async () => {
    const f = await fixture()
    const { exit, output } = await f.invoke([
      "swap",
      "SOL",
      mint,
      "--amount",
      "1",
      "--dry-run",
      "--rpc-url",
      "not-a-url",
    ])
    expect(exit).toBe(2)
    expect(output.code).toBe("USAGE")
    expect(f.calls.some((c) => c.path.endsWith("/build") || c.path === "/rpc")).toBe(false)
  })
  test("buy fee is included in the SEC-003 input limit", async () => {
    const f = await fixture({ feeRaw: "100000000" })
    const { output, exit } = await f.invoke(["swap", "SOL", mint, "--amount", "1", "--dry-run"])
    expect(exit).toBe(0)
    expect(check(output, "spend").status).toBe("pass")
  })
  test("curve sell fee is deducted from the output floor", async () => {
    const f = await fixture({
      feeRaw: "10000000",
      venue: "curve",
      receiveRaw: 90000000n,
      badBuild: { minOutRaw: "100000000" },
    })
    const { output, exit } = await f.invoke(["swap", mint, "SOL", "--amount", "1", "--dry-run"])
    expect(exit).toBe(0)
    expect(output.quote.minimumReceivedRaw).toBe("90000000")
    expect(check(output, "spend").status).toBe("pass")
  })
  test("base swap rejects non-Jupiter venue, token build rejects a different payer", async () => {
    for (const opts of [{ venue: "curve" }, { badBuild: { walletAddress: embedded } }]) {
      const f = await fixture(opts)
      const { output } = await f.invoke(["swap", "SOL", opts.venue ? "USDC" : mint, "--amount", "1", "--dry-run"])
      expect(check(output, "quote").code).toBe("INVALID_RESPONSE")
    }
  })
  test("signed simulation option survives a context-floor wrapper", async () => {
    const configs: unknown[] = []
    const rpc = createSolanaRpc(
      "http://localhost/rpc",
      (async (_input, init) => {
        const body = JSON.parse(String(init?.body))
        configs.push(body.params[1])
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: { context: { slot: 100 }, value: { err: null, accounts: [], logs: [] } },
        })
      }) as typeof fetch,
      async () => {},
    )
    const wrapped = withContextFloor(rpc, createContextFloor(50))
    await wrapped.simulateTransaction("signed", [], { sigVerify: true })
    await wrapped.simulateTransaction("unsigned", [])
    expect(configs[0]).toMatchObject({ sigVerify: true, replaceRecentBlockhash: false, minContextSlot: 50 })
    expect(configs[1]).toMatchObject({ sigVerify: false, replaceRecentBlockhash: true, minContextSlot: 100 })
  })
  test("plain tee check is reads only and emits the batch contract", async () => {
    const f = await fixture()
    const { exit, output } = await f.invoke(["tee", "check", "pool-1"])
    expect(exit).toBe(0)
    expect(output).toMatchObject({ success: true, dryRun: true, summary: { total: 1, pass: 1, fail: 0 } })
    expect(check(output, "record").status).toBe("pass")
    expect(check(output, "sign")).toMatchObject({ status: "skipped", because: "--sign not set" })
    expect(f.calls.every((c) => c.body === undefined)).toBe(true)
  })
  test("missing scope and unpayable name are both reported; batch continues", async () => {
    const f = await fixture({ scopes: [] })
    const { exit, output } = await f.invoke(["tee", "check", "unknown", "pool-1"])
    expect(exit).toBe(1)
    expect(output.summary).toEqual({ total: 2, pass: 0, fail: 2 })
    expect(check(output, "payable").code).toBe("TEE_WALLET_REQUIRED")
    expect(check(output, "scope").code).toBe("SCOPE_MISSING")
    expect(output.wallets[1].checks.find((c: WalletCheck) => c.id === "record").status).toBe("pass")
  })
  for (const [name, patch, noSigner, code] of [
    ["inactive", { active: false }, false, "TEE_WALLET_INACTIVE"],
    ["relay identifiers", { privyWalletId: undefined }, false, "SIGNER_UNAVAILABLE"],
    ["signer", {}, true, "SIGNER_UNAVAILABLE"],
    ["chain", { chain: "evm" }, false, "CHAIN_MISMATCH"],
    ["combined", { chain: "evm", active: false, privyWalletId: undefined }, true, "CHAIN_MISMATCH"],
  ] as const)
    test(`completion and payer parity: ${name}`, async () => {
      const broken = { ...row, ...patch }
      const f = await fixture({ rows: [broken], noSigner })
      const inspected = await inspectTradingWallet(f.ctx, broken, "app", "swap:write")
      expect(inspected.failures[0]?.code).toBe(code)
      await expect(completeTradingWallet(f.ctx, broken, "app", "swap:write")).rejects.toMatchObject({ code })
      await expect(tradingPayer(f.ctx, "key", broken.id)).rejects.toMatchObject({ code })
      const { output } = await f.invoke(["tee", "check", broken.id])
      expect(output.wallets[0].checks.some((c: WalletCheck) => c.code === code)).toBe(true)
      if (name === "combined")
        expect(inspected.failures.map((e) => e.code)).toEqual([
          "CHAIN_MISMATCH",
          "TEE_WALLET_INACTIVE",
          "SIGNER_UNAVAILABLE",
          "SIGNER_UNAVAILABLE",
        ])
    })
  test("duplicate matches have the same payer refusal", async () => {
    const f = await fixture({ rows: [row, { ...row, id: "duplicate" }] })
    await expect(tradingPayer(f.ctx, "key", "pool-1")).rejects.toMatchObject({ code: "TEE_WALLET_REQUIRED" })
    expect(check((await f.invoke(["tee", "check", "pool-1"])).output, "payable").code).toBe("TEE_WALLET_REQUIRED")
  })
  test("record mapping, missing/duplicate addresses, revoked and non-TEE records", () => {
    expect(walletRecordCheck(row, [row], [record]).status).toBe("pass")
    expect(walletRecordCheck(row, [row], [{ ...record, profile: "ember-hot" }]).status).toBe("pass")
    for (const patch of [
      { _id: "convex-id" },
      { signerQuorumId: "missing-on-trading" },
      { chain: "evm" },
      { label: undefined },
      { address: embedded },
      { profile: "external" },
      { revokedAt: 0 },
    ])
      expect(walletRecordCheck(row, [row], [{ ...record, ...patch }]).code).toBe("WALLET_RECORD_MISMATCH")
    for (const records of [[], [record, record]])
      expect(walletRecordCheck(row, [row], records).code).toBe("WALLET_RECORD_MISMATCH")
    expect(walletRecordCheck(row, [row, row], [record]).code).toBe("WALLET_RECORD_MISMATCH")
    const be2930 = walletRecordCheck(
      { ...row, id: "convex-id" },
      [{ ...row, id: "convex-id" }],
      [{ ...record, _id: "postgres-id", signerQuorumId: "quorum" }],
    )
    expect(be2930.differences).toMatchObject({
      id: { trading: "convex-id", wallets: "postgres-id" },
      signerQuorumId: { trading: null, wallets: "quorum" },
    })
    // Fields absent from the list are never compared.
    expect(walletRecordCheck({ ...row, privyWalletId: "different", active: false }, [row], [record]).status).toBe(
      "pass",
    )
  })
  for (const pair of [
    ["SOL", "USDC"],
    ["SOL", mint],
    [mint, "SOL"],
  ])
    test(`dry-run payload and SEC-003: ${pair.join("/")}`, async () => {
      const f = await fixture()
      const { exit, output } = await f.invoke(["swap", ...pair, "--amount", "0.001", "--wallet", "pool-1", "--dry-run"])
      expect(exit).toBe(0)
      expect(check(output, "spend").status).toBe("pass")
      expect(output.quote.minOutRaw).toBe("100000")
      const build = f.calls.find((c) => c.path.endsWith("/build"))
      if (!build) throw new Error("Missing build")
      expect(build.path).toBe(pair[1] === "USDC" ? "/api/v1/agent/swap/build" : "/api/v1/trade/agent/build")
      expect(build.body).toMatchObject({
        payer: { type: "linked", linkedWalletId: row.id },
        amountRaw: pair[0] === "SOL" ? "1000000" : "1000",
        maxSlippageBps: 50,
      })
      if (pair[1] !== "USDC")
        expect(build.body).toMatchObject({
          chain: "solana",
          mint,
          side: pair[0] === "SOL" ? "buy" : "sell",
          quoteAsset: "sol",
        })
      expect(f.calls.some((c) => /\/(sign|execute|submit)$/.test(c.path))).toBe(false)
      expect(output).not.toHaveProperty("signature")
      expect(output).not.toHaveProperty("clientTradeId")
      expect(output).not.toHaveProperty("operationId")
      expect(await readdir(f.dir)).not.toContain("operations")
    })
  test("fresh in-memory id on each build", async () => {
    const ids: string[] = []
    for (let i = 0; i < 2; i++) {
      const f = await fixture()
      await f.invoke(["swap", "SOL", "USDC", "--amount", "1", "--dry-run"])
      ids.push(f.calls.find((c) => c.path.endsWith("/build"))?.body.clientTradeId as string)
    }
    expect(ids[0]).not.toBe(ids[1])
  })
  for (const flag of [["--yes"], ["--percent", "20"], ["--client-trade-id", "fixed"]])
    test(`dry-run refuses ${flag[0]} before requests`, async () => {
      const f = await fixture()
      const result = await f.invoke(["swap", "SOL", "USDC", "--amount", "1", "--dry-run", ...flag])
      expect(result.output.code).toBe("VALIDATION_FAILED")
      expect(f.calls).toHaveLength(0)
    })
  for (const pair of [
    ["ETH", "USDG"],
    ["SOL", "ETH"],
  ])
    test(`refuses ${pair.join("/")} before runners`, async () => {
      const f = await fixture()
      expect((await f.invoke(["swap", ...pair, "--amount", "1", "--dry-run"])).output.code).toBe("VALIDATION_FAILED")
      expect(f.calls).toHaveLength(0)
    })
  for (const mode of ["embedded", "ambiguous", "denied"] as const)
    test(`payer discovery: ${mode}`, async () => {
      const f = await fixture({ embedded: true, denied: mode === "denied", rows: mode === "ambiguous" ? [row] : [] })
      const { output } = await f.invoke(["swap", "SOL", "USDC", "--amount", "1", "--dry-run"])
      if (mode === "embedded")
        expect(output).toMatchObject({ code: "VALIDATION_FAILED", message: "dry run checks TEE payers" })
      else
        expect(check(output, "payable").code).toBe(
          mode === "denied" ? "EMBEDDED_WALLET_NOT_PERMITTED" : "PAYER_REQUIRED",
        )
      expect(f.calls.some((c) => c.path.endsWith("/embedded"))).toBe(true)
      expect(f.calls.some((c) => c.path.endsWith("/build"))).toBe(false)
    })
  for (const options of [{ malformedTrading: true }, { repeatedCursor: true }, { repeatedRecords: true }])
    test(`incomplete listing fails the whole run: ${JSON.stringify(options)}`, async () => {
      const f = await fixture(options)
      expect((await f.invoke(["tee", "check", "pool-1"])).output.code).toBe("INVALID_RESPONSE")
    })
  for (const buildError of ["TRADING_DISABLED", "QUOTE_EXPIRED", "INVALID_AMOUNT"])
    test(`preserves build refusal ${buildError}`, async () => {
      const f = await fixture({ buildError })
      expect(check((await f.invoke(["swap", "SOL", "USDC", "--amount", "1", "--dry-run"])).output, "quote").code).toBe(
        buildError,
      )
    })
  for (const badBuild of [
    { status: "executed" },
    { expiresAt: 0 },
    { recipient: embedded },
    { transactionsBase64: [] },
    { minOutRaw: "invalid" },
  ])
    test(`validates build before spend: ${JSON.stringify(badBuild)}`, async () => {
      const f = await fixture({ badBuild })
      const { exit, output } = await f.invoke(["swap", "SOL", "USDC", "--amount", "1", "--dry-run"])
      expect(exit).toBe(1)
      expect(check(output, "quote").status).toBe("fail")
      expect(check(output, "spend").status).toBe("skipped")
    })
  for (const to of ["USDC", mint])
    test(`spend mismatch after ${to} build`, async () => {
      const f = await fixture({ overSpend: true })
      const { output } = await f.invoke(["swap", "SOL", to, "--amount", "1", "--dry-run"])
      expect(check(output, "quote").status).toBe("pass")
      expect(check(output, "spend").code).toBe("INVALID_RESPONSE")
    })
  for (const spendError of ["InsufficientFundsForFee", "AccountNotFound", { InstructionError: [0, "Custom"] }])
    test(`spend gates signing: ${JSON.stringify(spendError)}`, async () => {
      const f = await fixture({ spendError })
      const { output } = await f.invoke(["tee", "check", "pool-1", "--sign"])
      expect(check(output, "spend").status).toBe(typeof spendError === "string" ? "skipped" : "fail")
      expect(check(output, "sign")).toMatchObject({ status: "skipped", because: "spend" })
      expect(f.calls.some((c) => c.path.endsWith("/sign"))).toBe(false)
    })
  for (const signedError of [undefined, "InsufficientFundsForFee", "AccountNotFound", "BlockhashNotFound"])
    test(`signed simulation: ${signedError ?? "pass"}`, async () => {
      const f = await fixture({ signedError })
      const { exit, output } = await f.invoke(["tee", "check", "pool-1", "--sign"])
      expect(exit).toBe(0)
      expect(check(output, "sign").status).toBe("pass")
      expect(check(output, "simulation").status).toBe(signedError ? "skipped" : "pass")
      const simulations = f.calls.filter((c) => c.body?.method === "simulateTransaction")
      expect(simulations[0]?.body.params[1]).toMatchObject({ sigVerify: false, replaceRecentBlockhash: true })
      expect(simulations[1]?.body.params[1]).toMatchObject({ sigVerify: true, replaceRecentBlockhash: false })
      const spendIndex = f.calls.findIndex((c) => c.body?.method === "simulateTransaction")
      expect(f.calls.findIndex((c) => c.path.endsWith("/sign"))).toBeGreaterThan(spendIndex)
      expect(f.calls.some((c) => /\/(execute|submit)$/.test(c.path) || c.body?.method === "sendTransaction")).toBe(
        false,
      )
    })
  for (const opts of [{ invalidSignature: true }, { relayError: true }])
    test(`sign failure wraps cause: ${JSON.stringify(opts)}`, async () => {
      const f = await fixture(opts)
      const { exit, output } = await f.invoke(["tee", "check", "pool-1", "--sign"])
      expect(exit).toBe(1)
      expect(check(output, "sign")).toMatchObject({
        code: "SIGN_FAILED",
        cause: opts.invalidSignature ? "SIGNATURE_INVALID" : "SIGNER_UNAVAILABLE",
      })
    })
  test("sign cap is 10, prefix batch can raise it, no default builds", async () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({
      ...row,
      id: `pg-${i}`,
      address: base58.encode(new Uint8Array(32).fill(i + 1)),
      label: `pool-${i}`,
    }))
    const f = await fixture({ rows })
    expect((await f.invoke(["tee", "check", "--label-prefix", "pool-", "--sign"])).output.code).toBe(
      "VALIDATION_FAILED",
    )
    expect(f.calls.some((c) => c.path.endsWith("/build"))).toBe(false)
    const raised = await fixture({
      rows,
      records: rows.map((r) => ({ ...record, _id: r.id, address: r.address, label: r.label })),
      buildError: "INSUFFICIENT_FUNDS",
    })
    const { exit, output } = await raised.invoke(["tee", "check", "--label-prefix", "pool-", "--sign", "--max", "11"])
    expect(exit).toBe(0)
    expect(output.summary.total).toBe(11)
    expect(raised.calls.filter((c) => c.path.endsWith("/build"))).toHaveLength(11)
  })
  test("no key is a whole-run API_KEY_REQUIRED", async () => {
    const f = await fixture()
    delete f.deps.env.CANDLE_API_KEY
    const { output } = await f.invoke(["tee", "check", "pool-1"])
    expect(output.code).toBe("API_KEY_REQUIRED")
    expect(output.wallets).toBeUndefined()
    expect(f.calls).toHaveLength(0)
  })
})
