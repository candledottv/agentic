import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { VersionedTransaction } from "@solana/web3.js"
import { run } from "../index"
import { createCapture, createRoutedFetch, createTestDeps, jsonResponse, type RouteHandler } from "../test-support"
import { closeVault } from "../vault/store"
import { makeVault, useCheapKdf } from "../vault/test-vault"
import { decodeHeader, encodeHeader } from "../x402/codec"
import { SOLANA_DEVNET, USDC_MINTS } from "../x402/select"
import { foldSpendLog, readSpendLog, spendPaths } from "../x402/spend-log"

useCheapKdf()
setDefaultTimeout(60_000)

const MINT = "So11111111111111111111111111111111111111112"
const FORENSICS = `/api/v1/markets/solana/${MINT}/forensics`
const PAY_TO = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
const FEE_PAYER = "2wmVCSfPxGPjrnMMn7rchp4uaeoTqN39mXFC2zhPdri9"
const BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi"

const required = {
  x402Version: 2,
  resource: { url: `https://api.test${FORENSICS}`, description: "Token forensics past the free rate, 0.01 USDC" },
  accepts: [
    {
      scheme: "exact",
      network: SOLANA_DEVNET,
      amount: "10000",
      asset: USDC_MINTS[SOLANA_DEVNET],
      payTo: PAY_TO,
      maxTimeoutSeconds: 120,
      extra: { feePayer: FEE_PAYER, memo: `cndl:${"3".repeat(32)}`, paymentFlow: "upfront" },
    },
  ],
}
const payable: RouteHandler = () =>
  jsonResponse(
    402,
    { success: false, error: { code: "PAYMENT_REQUIRED", message: "This call costs 0.01 USDC.", retryable: true } },
    { "PAYMENT-REQUIRED": encodeHeader(required) },
  )
const rpc: RouteHandler = (req) => {
  const { method, id } = JSON.parse(String(req.init.body))
  if (method !== "getLatestBlockhash") throw new Error(`unexpected RPC ${method}`)
  return jsonResponse(200, { id, jsonrpc: "2.0", result: { context: { slot: 1 }, value: { blockhash: BLOCKHASH } } })
}

async function withVault(routes: Record<string, RouteHandler | RouteHandler[]>, env: Record<string, string> = {}) {
  const made = await makeVault()
  closeVault(made.vault)
  const stdout = createCapture()
  const stderr = createCapture()
  const routed = createRoutedFetch({ "/": rpc, ...routes })
  const prompts: string[] = []
  const deps = createTestDeps({
    fetch: routed.fetch,
    stdout,
    stderr,
    env: {
      CANDLE_CONFIG_DIR: made.dir,
      CANDLE_API_URL: "https://api.test",
      CANDLE_X402_NETWORK: "devnet",
      CANDLE_X402_PAY_TO: PAY_TO,
      ...env,
    },
    promptSecret: async () => made.passphrase,
    promptLine: async (text) => {
      prompts.push(text)
      return "confirm"
    },
  })
  expect(await run(["vault", "new-key", "--chain", "solana", "--label", "payer", "--json"], deps)).toBe(0)
  const payer = String(JSON.parse(stdout.text.trim().split("\n").at(-1) ?? "{}").address)
  stdout.text = ""
  stderr.text = ""
  return { made, deps, stdout, stderr, routed, prompts, payer }
}

describe("candle token forensics: a per-use payment from the vault (spec 10.1 to 10.3)", () => {
  test("a payable 402 is confirmed, signed by the vault key, paid once and logged", async () => {
    let signatureHeader = ""
    const f = await withVault({
      [FORENSICS]: [
        payable,
        (req) => {
          signatureHeader = (req.init.headers as Record<string, string>)["PAYMENT-SIGNATURE"] ?? ""
          return jsonResponse(
            200,
            { success: true, data: { mint: MINT, flags: [] } },
            { "PAYMENT-RESPONSE": encodeHeader({ success: true, transaction: "devnetsig", network: SOLANA_DEVNET }) },
          )
        },
      ],
    })
    expect(await run(["token", "forensics", MINT, "--json"], f.deps)).toBe(0)
    const out = JSON.parse(f.stdout.text)
    expect(out).toEqual({
      ok: true,
      data: { mint: MINT, flags: [] },
      payment: { id: expect.any(String), state: "settled", amountUsdc: "0.01", payer: f.payer, signature: "devnetsig" },
    })
    expect(f.prompts.some((p) => p.includes("pay 0.01 USDC for Token forensics past the free rate"))).toBe(true)
    const payload = decodeHeader(signatureHeader) as { payload: { transaction: string } }
    const tx = VersionedTransaction.deserialize(Buffer.from(payload.payload.transaction, "base64"))
    expect(tx.message.staticAccountKeys.map((k) => k.toBase58())).toContain(f.payer)
    const entries = foldSpendLog(await readSpendLog(spendPaths({ CANDLE_CONFIG_DIR: f.made.dir }, "/x")))
    expect(entries.map((e) => [e.kind, e.state, e.payer, e.amountRaw])).toEqual([
      ["forensics", "settled", f.payer, 10000n],
    ])
    expect(f.routed.unmatched).toHaveLength(0)
  })

  test("without a terminal a payable 402 is refused before anything is unlocked or signed", async () => {
    const f = await withVault({ [FORENSICS]: payable })
    f.deps.isTTY = { stdin: false, stdout: false, stderr: false }
    expect(await run(["token", "forensics", MINT, "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: false, code: "VAULT_UNLOCK_FAILED" })
    expect(f.routed.calls.filter((c) => new URL(c.url).pathname === FORENSICS)).toHaveLength(1)
    expect(foldSpendLog(await readSpendLog(spendPaths({ CANDLE_CONFIG_DIR: f.made.dir }, "/x")))).toEqual([])
  })

  test("a refusal by the spending rules names the price and pays nothing", async () => {
    const f = await withVault({ [FORENSICS]: payable })
    expect(await run(["spend", "pause"], f.deps)).toBe(0)
    f.stdout.text = ""
    expect(await run(["token", "forensics", MINT, "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: false, code: "SPEND_PAUSED", details: { priceUsdc: "0.01" } })
  })
})

describe("the paid reads with no payment asked", () => {
  function plain(status: number, body: unknown, env: Record<string, string> = {}) {
    const stdout = createCapture()
    const stderr = createCapture()
    const routed = createRoutedFetch({
      [FORENSICS]: () => jsonResponse(status, body),
      "/api/v1/markets/vamp-candidates": () => jsonResponse(status, body),
    })
    const deps = createTestDeps({
      fetch: routed.fetch,
      stdout,
      stderr,
      env: { CANDLE_API_URL: "https://api.test", ...env },
    })
    return { deps, stdout, stderr, routed }
  }

  test("a free forensics read prints the data and sends no key when none is configured", async () => {
    const f = plain(200, { success: true, data: { mint: MINT } })
    expect(await run(["token", "forensics", MINT, "--json"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text)).toEqual({ ok: true, data: { mint: MINT } })
    expect((f.routed.calls[0]?.init.headers as Record<string, string>)["x-api-key"]).toBeUndefined()
  })

  test("the vamp finder sends the profile's key and the query it was given", async () => {
    const f = plain(200, { success: true, candidates: [] }, { CANDLE_API_KEY: "cndl_live_x" })
    expect(await run(["token", "vamp-candidates", "--limit", "5", "--stage", "graduated", "--json"], f.deps)).toBe(0)
    const call = f.routed.calls[0]
    expect(new URL(call?.url ?? "").search).toBe("?limit=5&stage=graduated")
    expect((call?.init.headers as Record<string, string>)["x-api-key"]).toBe("cndl_live_x")
  })

  test("an ordinary 402 (no PAYMENT-REQUIRED) is the error it always was", async () => {
    const f = plain(402, { success: false, error: { code: "FEE_LEG_MISSING", message: "Fee leg missing." } })
    expect(await run(["token", "forensics", MINT, "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: false, code: "FEE_LEG_MISSING", status: 402 })
  })

  test("usage errors exit 2", async () => {
    const f = plain(200, {})
    expect(await run(["token", "forensics"], f.deps)).toBe(2)
    expect(await run(["token", "forensics", MINT, "--chain", "eth"], f.deps)).toBe(2)
    expect(await run(["token", "vamp-candidates", "--stage", "soon"], f.deps)).toBe(2)
    expect(await run(["token", "vamp-candidates", "--limit", "0"], f.deps)).toBe(2)
    expect(f.routed.calls).toHaveLength(0)
  })
})
