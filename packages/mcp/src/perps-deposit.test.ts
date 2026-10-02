/** Perps C (BE-647, HL-ED-8): `candle_perps_deposit` checks the build before the relay signs. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { generateKeyPairSync, verify } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hyperliquidCanonicalJson } from "./hyperliquid"
import type { FetchLike } from "./orchestrate"
import { executePerpsDeposit } from "./perps"

const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const EVM = "0x14791697260e4c9a71f18484c9f997b308e59325"
const SOLANA = "7ZL9FvkpCMgdvzfoMSYZSuCXLCYN25dfgtDXej1BBJaB"
const cfg = { apiUrl: "https://api.test", apiKey: "cndl_live_key" }
let dir: string
let pemFile: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "candle-mcp-deposit-"))
  pemFile = join(dir, "signer.pem")
  await writeFile(pemFile, pem)
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const leg = (nonce: number) => ({
  chainId: 4663,
  nonce,
  gas: "90000",
  maxFeePerGas: "2000000000",
  maxPriorityFeePerGas: "1000000",
  to: "0x4cd00e387622c35bddb9b4c962c136462338bc31",
  data: "0x1234",
  value: "0",
})

function fake(
  opts: { build?: Record<string, unknown>; destination?: Record<string, unknown>; scopes?: string[] } = {},
) {
  const calls: { url: string; body?: Record<string, unknown> }[] = []
  let submits = 0
  const fetch: FetchLike = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, body })
    const ok = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) })
    if (url === "https://api.test/api/v1/agent/wallets/trading")
      return ok({
        scopes: opts.scopes ?? ["swap:write"],
        privyAppId: "app",
        page: [
          { id: "sol-tee", address: SOLANA, chain: "solana", privyWalletId: "privy-sol", label: "sol" },
          { id: "hood-tee", address: EVM, chain: "evm", privyWalletId: "privy-hood", label: "hood" },
        ],
        isDone: true,
      })
    if (url === "https://api.test/api/v1/agent/perps/deposit") {
      const hood = body.asset === "ETH" || body.asset === "USDG"
      return ok({
        success: true,
        status: "built",
        clientDepositId: body.clientDepositId,
        depositId: "d-1",
        chain: hood ? "hood" : "solana",
        asset: body.asset,
        amountRaw: body.amountRaw,
        walletId: body.walletId,
        walletAddress: hood ? EVM : SOLANA,
        destination: {
          walletId: "hood-tee",
          address: EVM,
          chainId: 1337,
          currency: "0x00000000000000000000000000000000",
          ...opts.destination,
        },
        fee: { bps: 0, feeRaw: "0" },
        ...(hood
          ? { mode: "sequenced", operationId: "op-1", legKind: "approval", plannedLegCount: 2, nextLeg: leg(7) }
          : { transactionsBase64: ["AQID"] }),
        ...opts.build,
      })
    }
    if (url.endsWith("/sign"))
      return ok({
        success: true,
        signedTransaction: body.body.method === "signTransaction" ? "BAUG" : `0x02${submits}`,
        encoding: body.body.method === "signTransaction" ? "base64" : "rlp",
      })
    if (url === "https://api.test/api/v1/agent/perps/deposit/submit") {
      submits += 1
      if (body.signedTransactionsBase64) return ok({ success: true, status: "submitted", hashes: ["sig"] })
      if (submits === 1)
        return ok({
          success: true,
          mode: "sequenced",
          operationId: "op-1",
          legKind: "bridgeDeposit",
          plannedLegCount: 2,
          nextLeg: leg(8),
        })
      return ok({ success: true, status: "submitted", hashes: ["0xa", "0xb"] })
    }
    throw new Error(`unexpected ${url}`)
  }
  return { calls, fetch }
}

const env = () => ({ CANDLE_KEY_SIGNER_PEM_FILE: pemFile })

describe("candle_perps_deposit", () => {
  test("Solana: names the EVM TEE wallet's account, relay-signs the deposit over the canonical body, submits", async () => {
    const f = fake()
    const result = await executePerpsDeposit(
      { asset: "USDC", amount: "20", clientDepositId: "dep-1" },
      cfg,
      env(),
      f.fetch,
    )
    expect(result.isError).toBeUndefined()
    expect(f.calls[1]?.body).toEqual({
      clientDepositId: "dep-1",
      walletId: "sol-tee",
      asset: "USDC",
      amountRaw: "20000000",
      perpsWalletId: "hood-tee",
    })
    const relay = f.calls[2]?.body as { authorizationSignature: string; body: Record<string, unknown> }
    expect(relay.body).toEqual({ method: "signTransaction", params: { encoding: "base64", transaction: "AQID" } })
    const payload = hyperliquidCanonicalJson({
      body: relay.body,
      headers: { "privy-app-id": "app" },
      method: "POST",
      url: "https://api.privy.io/v1/wallets/privy-sol/rpc",
      version: 1,
    })
    expect(
      verify("sha256", Buffer.from(payload), pair.publicKey, Buffer.from(relay.authorizationSignature, "base64")),
    ).toBe(true)
    expect(f.calls[3]?.body).toEqual({ clientDepositId: "dep-1", depositId: "d-1", signedTransactionsBase64: ["BAUG"] })
  })

  test("Hood: signs and submits each leg in turn", async () => {
    const f = fake()
    const result = await executePerpsDeposit(
      { asset: "USDG", amount: "25", clientDepositId: "dep-2" },
      cfg,
      env(),
      f.fetch,
    )
    expect(result.isError).toBeUndefined()
    const relays = f.calls.filter((c) => c.url.endsWith("/sign"))
    expect(relays).toHaveLength(2)
    expect(
      (relays[0]?.body?.body as { params: { transaction: Record<string, unknown> } }).params.transaction,
    ).toMatchObject({ chain_id: 4663, from: EVM, nonce: 7, type: 2, gas_limit: "0x15f90" })
    const submits = f.calls.filter((c) => c.url.endsWith("/deposit/submit"))
    expect(submits.map((c) => c.body?.signedTransaction)).toEqual(["0x020", "0x021"])
    expect(JSON.parse(result.text)).toMatchObject({ status: "submitted", clientDepositId: "dep-2" })
  })

  test("a build that lands on another account, chain or currency, or charges a fee, signs nothing", async () => {
    for (const opts of [
      { destination: { address: "0x1111111111111111111111111111111111111111" } },
      { destination: { chainId: 42161 } },
      { destination: { currency: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" } },
      { build: { fee: { bps: 10, feeRaw: "1" } } },
    ]) {
      const f = fake(opts)
      const result = await executePerpsDeposit({ asset: "USDC", amount: "20" }, cfg, env(), f.fetch)
      expect(result.isError).toBe(true)
      expect(result.text).toContain("PERPS_BUILD_REFUSED")
      expect(f.calls.some((c) => c.url.endsWith("/sign"))).toBe(false)
    }
  })

  test("a Hood leg outside the plan is refused before the relay", async () => {
    const f = fake({ build: { legKind: "trade" } })
    const result = await executePerpsDeposit({ asset: "USDG", amount: "25" }, cfg, env(), f.fetch)
    expect(result.text).toContain("PERPS_BUILD_REFUSED")
    expect(f.calls.some((c) => c.url.endsWith("/sign"))).toBe(false)
  })

  test("without swap:write, or without the signer PEM, nothing is built", async () => {
    const noScope = fake({ scopes: ["perps:write"] })
    expect((await executePerpsDeposit({ asset: "USDC", amount: "20" }, cfg, env(), noScope.fetch)).text).toContain(
      "SCOPE_MISSING",
    )
    const noPem = fake()
    expect((await executePerpsDeposit({ asset: "USDC", amount: "20" }, cfg, {}, noPem.fetch)).text).toContain(
      "SIGNER_UNAVAILABLE",
    )
    for (const f of [noScope, noPem]) expect(f.calls.some((c) => c.url.endsWith("/perps/deposit"))).toBe(false)
  })
})
