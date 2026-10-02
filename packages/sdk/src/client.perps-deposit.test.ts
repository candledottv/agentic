/** Perps C (BE-647, HL-ED-8): `perpsDeposit()` checks the build before the relay signs anything. */
import { describe, expect, test } from "bun:test"
import { CandleClient, type PerpsDepositBuild, type PerpsDepositParams, perpsDepositProblem } from "./client"
import { InMemorySecretStore } from "./secret-store"
import { generateSignerKeypair } from "./wallet-import"

const ACCOUNT = "0x1111111111111111111111111111111111111111"
const WALLET = "hood-tee"

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

async function client(responses: Response[]) {
  const store = new InMemorySecretStore()
  const { privateKeyPem } = await generateSignerKeypair()
  await store.set(WALLET, privateKeyPem)
  await store.set("sol-tee", privateKeyPem)
  const calls: { url: string; body?: Record<string, unknown> }[] = []
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    const next = responses.shift()
    if (!next) throw new Error("no response queued")
    return next
  }) as unknown as typeof fetch
  return {
    calls,
    client: new CandleClient({
      apiUrl: "https://api.test",
      apiKey: "cndl_test_key",
      fetch: fetchImpl,
      privyAppId: "app-test",
      secretStore: store,
    }),
  }
}

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

function hoodBuild(extra: Partial<PerpsDepositBuild> = {}): PerpsDepositBuild {
  return {
    success: true,
    status: "built",
    clientDepositId: "dep-1",
    depositId: "d-1",
    chain: "hood",
    venue: "relay",
    network: "mainnet",
    asset: "USDG",
    amountRaw: "25000000",
    walletId: WALLET,
    walletAddress: ACCOUNT,
    destination: { walletId: WALLET, address: ACCOUNT, chainId: 1337, currency: "0x00000000000000000000000000000000" },
    firstDeposit: false,
    expectedOutRaw: "2497000000",
    minimumOutRaw: "2472000000",
    outDecimals: 8,
    floorUsdcMicros: "1000000",
    minimumCreditUsdcMicros: "24720000",
    fee: { bps: 0, feeRaw: "0" },
    statusChecks: [],
    requestId: "0xr1",
    expiresAt: Date.now() + 60_000,
    mode: "sequenced",
    operationId: "op-1",
    legKind: "approval",
    plannedLegCount: 2,
    nextLeg: leg(7),
    ...extra,
  }
}

const params: PerpsDepositParams = {
  clientDepositId: "dep-1",
  asset: "USDG",
  amountRaw: "25000000",
  walletId: WALLET,
  privyWalletId: "privy-hood",
  account: ACCOUNT,
}

describe("perpsDepositProblem", () => {
  test("accepts the build it asked for", () => {
    expect(perpsDepositProblem(hoodBuild(), params)).toBeNull()
  })

  test("refuses another account, chain, currency, amount, wallet or a Candle fee", () => {
    const destination = hoodBuild().destination
    for (const build of [
      hoodBuild({ destination: { ...destination, address: "0x2222222222222222222222222222222222222222" } }),
      hoodBuild({ destination: { ...destination, chainId: 42161 } }),
      hoodBuild({ destination: { ...destination, currency: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" } }),
      hoodBuild({ amountRaw: "1" }),
      hoodBuild({ walletId: "other" }),
      hoodBuild({ fee: { bps: 10, feeRaw: "1" } }),
      hoodBuild({ walletAddress: "0x3333333333333333333333333333333333333333" }),
      hoodBuild({ chain: "solana" }),
    ]) {
      expect(perpsDepositProblem(build, params)).not.toBeNull()
    }
  })
})

describe("perpsDeposit", () => {
  test("Hood: signs each sequenced leg through the relay and submits it to /perps/deposit/submit", async () => {
    const { client: c, calls } = await client([
      json(hoodBuild()),
      json({ success: true, signedTransaction: "0x02aa", encoding: "rlp" }),
      json({ ...hoodBuild({ legKind: "bridgeDeposit", nextLeg: leg(8) }), status: "built" }),
      json({ success: true, signedTransaction: "0x02bb", encoding: "rlp" }),
      json({ success: true, status: "submitted", hashes: ["0xaaa", "0xbbb"] }),
    ])
    const result = await c.perpsDeposit(params)
    expect(result).toMatchObject({ submitted: true, result: { status: "submitted" } })
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/v1/agent/perps/deposit",
      "/api/v1/agent/wallets/hood-tee/sign",
      "/api/v1/agent/perps/deposit/submit",
      "/api/v1/agent/wallets/hood-tee/sign",
      "/api/v1/agent/perps/deposit/submit",
    ])
    expect(calls[0]?.body).toEqual({ clientDepositId: "dep-1", walletId: WALLET, asset: "USDG", amountRaw: "25000000" })
    const relay = calls[1]?.body?.body as { method: string; params: { transaction: Record<string, unknown> } }
    expect(relay.method).toBe("eth_signTransaction")
    expect(relay.params.transaction).toMatchObject({
      chain_id: 4663,
      nonce: 7,
      from: ACCOUNT,
      type: 2,
      gas_limit: "0x15f90",
    })
    expect(calls[2]?.body).toEqual({
      clientDepositId: "dep-1",
      depositId: "d-1",
      operationId: "op-1",
      signedTransaction: "0x02aa",
    })
  })

  test("a build naming another account is refused with nothing signed", async () => {
    const { client: c, calls } = await client([
      json(
        hoodBuild({
          destination: { ...hoodBuild().destination, address: "0x2222222222222222222222222222222222222222" },
        }),
      ),
    ])
    await expect(c.perpsDeposit(params)).rejects.toThrow("refused to sign this deposit")
    expect(calls).toHaveLength(1)
  })

  test("a Hood leg outside the plan is refused before the relay", async () => {
    const { client: c, calls } = await client([json(hoodBuild({ legKind: "trade" }))])
    await expect(c.perpsDeposit(params)).rejects.toThrow("refused to sign deposit leg trade")
    expect(calls).toHaveLength(1)
  })

  test("Solana: signs the one deposit and submits it", async () => {
    const { client: c, calls } = await client([
      json(
        hoodBuild({
          chain: "solana",
          asset: "USDC",
          walletId: "sol-tee",
          walletAddress: "So1anaPayer1111111111111111111111111111111",
          destination: {
            walletId: WALLET,
            address: ACCOUNT,
            chainId: 1337,
            currency: "0x00000000000000000000000000000000",
          },
          transactionsBase64: ["AQID"],
          mode: undefined,
        }),
      ),
      json({ success: true, signedTransaction: "BAUG", encoding: "base64" }),
      json({ success: true, status: "submitted", hashes: ["sig"] }),
    ])
    const result = await c.perpsDeposit({
      ...params,
      asset: "USDC",
      walletId: "sol-tee",
      privyWalletId: "privy-sol",
      perpsWalletId: WALLET,
    })
    expect(result.submitted).toBe(true)
    expect(calls[0]?.body).toMatchObject({ walletId: "sol-tee", perpsWalletId: WALLET })
    expect(calls[2]?.body).toEqual({ clientDepositId: "dep-1", depositId: "d-1", signedTransactionsBase64: ["BAUG"] })
  })

  test("submit: false returns the checked build and signs nothing", async () => {
    const { client: c, calls } = await client([json(hoodBuild())])
    expect(await c.perpsDeposit({ ...params, submit: false })).toMatchObject({ submitted: false, result: null })
    expect(calls).toHaveLength(1)
  })
})
