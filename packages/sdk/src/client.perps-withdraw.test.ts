/**
 * Hyperliquid withdrawals (spec 2026-10-17-hyperliquid-withdrawals-design.md, R13): the client
 * recompute. A tampered wallet, nonce, amount (formatting variants included), sub-account, token,
 * dex or destination is refused locally, with no relay call. The pins are TEST VALUES; the shipped
 * `CANDLE_PERPS_WITHDRAW_PINS` are V-A part 2's, and null pins refuse before anything is built.
 */
import { describe, expect, test } from "bun:test"
import { CandleClient, type PerpsWithdrawParams } from "./client"
import {
  CANDLE_PERPS_WITHDRAW_PINS,
  HYPERLIQUID_SEND_ASSET_TYPES,
  type PerpsWithdrawAuthorization,
  type PerpsWithdrawBuild,
  type PerpsWithdrawPins,
  parseSendAssetAmount,
  parseWithdrawAmount,
  RELAY_NONCE_MAPPING_TYPES,
  verifyWithdrawMapping,
  verifyWithdrawSendAsset,
} from "./hyperliquid-withdraw"
import { InMemorySecretStore } from "./secret-store"
import { generateSignerKeypair } from "./wallet-import"

const ACCOUNT = "0x3333333333333333333333333333333333333333"
const SOLANA = "8pM1nYvQ6HqS8VqLFPzWx5W2sTQeXKZbLqBTdrBGTsGb"
const DEPOSITORY = "0x865eb9baa5492cef598adf7afb1038654fcb7081"
/** Recorded live `/quote/v2` pair, 2026-10-21: the step request id and `protocol.v2.orderId`. */
const REQUEST_ID = "0x17925562135cd8ba1400a0cdebae8f67615b296b0c7a5cdda91d6286f21bc02c"
const ORDER_ID = "0x507c00b2168f0742b5203c302704d4f37196a22906284a5944ed4dd381a3c52a"
const NONCE = 1_770_329_064_777
const ZERO = "0x0000000000000000000000000000000000000000"
const PINS: PerpsWithdrawPins = {
  token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
  destinationDex: "",
  depositories: [DEPOSITORY],
  amountForm: "canonical",
}

function build(overrides: Partial<PerpsWithdrawBuild> = {}, message: Record<string, unknown> = {}): PerpsWithdrawBuild {
  return {
    id: "w-1",
    status: "quoted",
    from: { walletId: "evm-tee", address: ACCOUNT, network: "mainnet" },
    to: { chain: "solana", walletId: "sol-tee", address: SOLANA },
    amountUsdc: "5",
    feesUsdc: "0.1",
    netUsdc: "4.9",
    minimumOutUsdc: "4.89",
    relayRequestId: REQUEST_ID,
    relayOrderId: ORDER_ID,
    nonce: NONCE,
    expiresAt: Date.now() + 60_000,
    typedData: {
      domain: { name: "RelayNonceMapping", version: "2", chainId: 1, verifyingContract: ZERO },
      types: structuredClone(RELAY_NONCE_MAPPING_TYPES) as unknown as Record<string, unknown>,
      primary_type: "NonceMapping",
      message: {
        chainId: "hyperliquid",
        wallet: ACCOUNT,
        depositor: ACCOUNT,
        id: ORDER_ID,
        nonce: NONCE,
        ...message,
      },
    },
    ...overrides,
  }
}

function authorization(
  message: Record<string, unknown> = {},
  action: Record<string, unknown> = {},
): PerpsWithdrawAuthorization {
  const signed = {
    hyperliquidChain: "Mainnet",
    destination: DEPOSITORY,
    sourceDex: "",
    destinationDex: "",
    token: PINS.token,
    amount: "5",
    fromSubAccount: "",
    nonce: NONCE,
    ...message,
  }
  return {
    id: "w-1",
    status: "authorized",
    nonce: NONCE,
    typedData: {
      domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 42161, verifyingContract: ZERO },
      types: structuredClone(HYPERLIQUID_SEND_ASSET_TYPES) as unknown as Record<string, unknown>,
      primary_type: "HyperliquidTransaction:SendAsset",
      message: signed,
    },
    action: { type: "sendAsset", signatureChainId: "0xa4b1", ...signed, ...action },
  }
}

const mappingExpect = {
  id: "w-1",
  account: ACCOUNT,
  to: "solana" as const,
  amountMicros: 5_000_000n,
  ownDestinations: [SOLANA],
  pins: PINS,
}
const sendExpect = { mappingNonce: NONCE, amountMicros: 5_000_000n, pins: PINS }
const reasonOf = (check: { ok: boolean; reason?: string }) => (check.ok ? "ok" : check.reason)

describe("R13: the NonceMapping check", () => {
  test("an honest build passes when the order id differs from the request id", () => {
    const honest = build()
    expect(honest.relayOrderId).not.toBe(honest.relayRequestId)
    expect(honest.typedData?.message.id).toBe(ORDER_ID)
    expect(reasonOf(verifyWithdrawMapping(honest, mappingExpect))).toBe("ok")
  })

  test("a NonceMapping that names the request id is refused", () => {
    expect(reasonOf(verifyWithdrawMapping(build({}, { id: REQUEST_ID }), mappingExpect))).toContain("Relay order")
  })

  test("a missing or malformed order id is refused even when the message names the request id", () => {
    const missing = build({}, { id: REQUEST_ID })
    delete missing.relayOrderId
    expect(reasonOf(verifyWithdrawMapping(missing, mappingExpect))).toBe("the build has no Relay order id")
    expect(reasonOf(verifyWithdrawMapping(build({ relayOrderId: "0xabc" }, { id: REQUEST_ID }), mappingExpect))).toBe(
      "the build has no Relay order id",
    )
    expect(
      reasonOf(verifyWithdrawMapping(build({ relayOrderId: `${ORDER_ID}ff` }, { id: REQUEST_ID }), mappingExpect)),
    ).toBe("the build has no Relay order id")
    const malformedMessage = build()
    if (malformedMessage.typedData) malformedMessage.typedData.message.id = "not-bytes32"
    expect(reasonOf(verifyWithdrawMapping(malformedMessage, mappingExpect))).toContain("Relay order")
  })

  test.each([
    ["wallet", build({}, { wallet: `0x${"9".repeat(40)}` })],
    ["depositor", build({}, { depositor: `0x${"9".repeat(40)}` })],
    ["nonce", build({}, { nonce: NONCE + 1 })],
    ["request id", build({}, { id: `0x${"ab".repeat(32)}` })],
    ["Relay's chain name", build({}, { chainId: "arbitrum" })],
    ["an extra field", build({}, { extra: 1 })],
    ["the account", build({ from: { walletId: "evm-tee", address: `0x${"9".repeat(40)}`, network: "mainnet" } })],
    [
      "the destination",
      build({ to: { chain: "solana", walletId: "sol-tee", address: "Attacker1111111111111111111111111111111111" } }),
    ],
    ["the destination chain", build({ to: { chain: "hood", walletId: "evm-tee", address: ACCOUNT } })],
    ["the amount", build({ amountUsdc: "50" })],
  ])("a tampered %s is refused", (_label, tampered) => {
    expect(reasonOf(verifyWithdrawMapping(tampered, mappingExpect))).not.toBe("ok")
  })

  test("a domain on another chain id or another primary type is refused", () => {
    const b = build()
    if (b.typedData)
      b.typedData.domain = { name: "RelayNonceMapping", version: "2", chainId: 42161, verifyingContract: ZERO }
    expect(reasonOf(verifyWithdrawMapping(b, mappingExpect))).toContain("domain")
    const c = build()
    if (c.typedData) c.typedData.primary_type = "HyperliquidTransaction:SendAsset"
    expect(reasonOf(verifyWithdrawMapping(c, mappingExpect))).not.toBe("ok")
  })

  test("the shipped pins are V-A part 2's; with no pins everything is refused", () => {
    expect(CANDLE_PERPS_WITHDRAW_PINS).toEqual({
      token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
      destinationDex: "",
      depositories: ["0x66cf0aace1b4e562593bec10ec7868fba9932224"],
      amountForm: "fixed6",
    })
    expect(reasonOf(verifyWithdrawMapping(build(), { ...mappingExpect, pins: null }))).toContain("no withdrawal pins")
    expect(reasonOf(verifyWithdrawSendAsset(authorization(), { ...sendExpect, pins: null }))).toContain(
      "no withdrawal pins",
    )
  })
})

describe("R13: the SendAsset check", () => {
  test("an honest authorization passes", () => {
    expect(reasonOf(verifyWithdrawSendAsset(authorization(), sendExpect))).toBe("ok")
  })

  test.each([
    ["nonce", { nonce: NONCE + 1 }],
    ["amount", { amount: "50" }],
    ["amount with a trailing zero", { amount: "5.0" }],
    ["amount with too many decimals", { amount: "5.0000001" }],
    ["amount with an exponent", { amount: "5e0" }],
    ["amount with a leading zero", { amount: "05" }],
    ["fromSubAccount", { fromSubAccount: `0x${"5".repeat(40)}` }],
    ["sourceDex", { sourceDex: "spot" }],
    ["token", { token: "USDC:0x00000000000000000000000000000000" }],
    ["destinationDex", { destinationDex: "xyz" }],
    ["destination", { destination: `0x${"7".repeat(40)}` }],
    ["hyperliquidChain", { hyperliquidChain: "Testnet" }],
  ])("a tampered %s is refused", (_label, change) => {
    expect(reasonOf(verifyWithdrawSendAsset(authorization(change), sendExpect))).not.toBe("ok")
  })

  test("an action that differs from what is signed is refused", () => {
    expect(
      reasonOf(verifyWithdrawSendAsset(authorization({}, { destination: `0x${"7".repeat(40)}` }), sendExpect)),
    ).toContain("differs")
    expect(reasonOf(verifyWithdrawSendAsset(authorization({}, { signatureChainId: "0x1" }), sendExpect))).not.toBe("ok")
    expect(reasonOf(verifyWithdrawSendAsset(authorization({}, { vaultAddress: "" }), sendExpect))).not.toBe("ok")
  })

  test("amounts: request and signed forms parse exactly to micros", () => {
    expect(parseWithdrawAmount("5.5")).toBe(5_500_000n)
    expect(parseWithdrawAmount("0.0000001")).toBeNull()
    expect(parseSendAssetAmount("10.000000", "fixed6")).toBe(10_000_000n)
    expect(parseSendAssetAmount("10", "fixed6")).toBeNull()
    expect(parseSendAssetAmount("10.5", "canonical")).toBe(10_500_000n)
  })
})

// ── The flow: refusals make no relay call ────────────────────────────────────────────────────

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

async function client(responses: Response[], pins: PerpsWithdrawPins | "shipped" = PINS) {
  const store = new InMemorySecretStore()
  const { privateKeyPem } = await generateSignerKeypair()
  await store.set("evm-tee", privateKeyPem)
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
      ...(pins === "shipped" ? {} : { perpsWithdrawPins: pins }),
    }),
  }
}

const params: PerpsWithdrawParams = {
  walletId: "evm-tee",
  privyWalletId: "pw-evm",
  amountUsdc: "5",
  to: "solana",
  clientWithdrawalId: "w-1",
  account: ACCOUNT,
  ownDestinations: [SOLANA],
}
const SIGNATURE = `0x${"1b".repeat(65)}`
const relayCalls = (calls: { url: string }[]) => calls.filter((c) => c.url.includes("/sign"))

describe("perpsWithdraw()", () => {
  test("with no pins passed, the shipped pins apply and the build is requested", async () => {
    const { client: c, calls } = await client([], "shipped")
    await expect(c.perpsWithdraw(params)).rejects.toThrow("no response queued")
    expect(calls).toHaveLength(1)
    expect(relayCalls(calls)).toEqual([])
  })

  test("a tampered build is refused with no relay call", async () => {
    const { client: c, calls } = await client([json(build({}, { wallet: `0x${"9".repeat(40)}` }))])
    await expect(c.perpsWithdraw(params)).rejects.toThrow("refused to sign this withdrawal")
    expect(relayCalls(calls)).toEqual([])
  })

  test("a build paying a wallet that is not this key's own is refused before any signature or authorize", async () => {
    const foreign = build({ to: { chain: "solana", walletId: "sol-tee", address: "A".repeat(43) } })
    const { client: c, calls } = await client([json(foreign)])
    await expect(c.perpsWithdraw(params)).rejects.toThrow("not this key's own")
    expect(relayCalls(calls)).toEqual([])
    expect(calls.some((call) => call.url.endsWith("/authorize"))).toBe(false)
    expect(calls.map((call) => call.url)).toEqual(["https://api.test/api/v1/agent/perps/withdraw"])
  })

  test("a tampered SendAsset is refused after the mapping, with no second relay call", async () => {
    const { client: c, calls } = await client([
      json(build()),
      json({ success: true, signature: SIGNATURE }),
      json(authorization({ destination: `0x${"7".repeat(40)}` })),
    ])
    await expect(c.perpsWithdraw(params)).rejects.toThrow("refused to sign the transfer")
    expect(relayCalls(calls)).toHaveLength(1)
  })

  test("the honest flow signs twice, posts the SendAsset to Hyperliquid itself, and reports it", async () => {
    const { client: c, calls } = await client([
      json(build()),
      json({ success: true, signature: SIGNATURE }),
      json(authorization()),
      json({ success: true, signature: SIGNATURE }),
      json({ status: "ok", response: { type: "default" } }),
      json({ success: true, status: "submitted" }),
    ])
    const result = await c.perpsWithdraw(params)
    expect(result.submitted).toBe(true)
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.test/api/v1/agent/perps/withdraw",
      "https://api.test/api/v1/agent/wallets/evm-tee/sign",
      "https://api.test/api/v1/agent/perps/withdraw/authorize",
      "https://api.test/api/v1/agent/wallets/evm-tee/sign",
      "https://api.hyperliquid.xyz/exchange",
      "https://api.test/api/v1/agent/perps/withdraw/submitted",
    ])
    expect(calls[0]?.body).toEqual({ clientWithdrawalId: "w-1", amountUsdc: "5", to: "solana", wallet: "evm-tee" })
    expect(calls[2]?.body).toEqual({ clientWithdrawalId: "w-1", signature: SIGNATURE })
    expect((calls[4]?.body?.action as Record<string, unknown>).type).toBe("sendAsset")
    expect(calls[4]?.body?.nonce).toBe(NONCE)
    // N2 (BE-1777): the client never calls Relay's API.
    expect(calls.some((call) => call.url.startsWith("https://api.relay.link"))).toBe(false)
  })
})
