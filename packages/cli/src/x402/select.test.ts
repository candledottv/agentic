import { describe, expect, test } from "bun:test"
import type { PaymentRequired, PaymentRequirements } from "./codec"
import {
  MAINNET_PAY_TO,
  networkConfig,
  SOLANA_DEVNET,
  SOLANA_MAINNET,
  selectRequirement,
  USDC_MINTS,
  usdcText,
} from "./select"

const PAY_TO = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
const FEE_PAYER = "2wmVCSfPxGPjrnMMn7rchp4uaeoTqN39mXFC2zhPdri9"
const MEMO = `cndl:${"0f".repeat(16)}`

const devnetOffer = (over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: SOLANA_DEVNET,
  amount: "10000",
  asset: USDC_MINTS[SOLANA_DEVNET],
  payTo: PAY_TO,
  maxTimeoutSeconds: 120,
  extra: { feePayer: FEE_PAYER, memo: MEMO, paymentFlow: "upfront" },
  ...over,
})
const required = (...accepts: PaymentRequirements[]): PaymentRequired => ({
  x402Version: 2,
  resource: { url: "https://api.test/x" },
  accepts,
})
const devnet = () => {
  const c = networkConfig({ CANDLE_X402_NETWORK: "devnet", CANDLE_X402_PAY_TO: PAY_TO })
  if (!c.ok) throw new Error(c.message)
  return c.config
}

describe("network configuration (10.2, 10.3 rule 4)", () => {
  test("mainnet by default, with mainnet USDC and the pinned pay-to (none in this build)", () => {
    expect(networkConfig({})).toEqual({
      ok: true,
      config: { network: SOLANA_MAINNET, asset: USDC_MINTS[SOLANA_MAINNET], payTo: MAINNET_PAY_TO },
    })
    expect(MAINNET_PAY_TO).toBeNull()
  })

  test("devnet takes CANDLE_X402_PAY_TO; mainnet refuses it", () => {
    expect(devnet()).toEqual({ network: SOLANA_DEVNET, asset: USDC_MINTS[SOLANA_DEVNET], payTo: PAY_TO })
    expect(networkConfig({ CANDLE_X402_NETWORK: SOLANA_DEVNET }).ok).toBe(true)
    expect(networkConfig({ CANDLE_X402_PAY_TO: PAY_TO }).ok).toBe(false)
    expect(networkConfig({ CANDLE_X402_NETWORK: "devnet", CANDLE_X402_PAY_TO: "nope" }).ok).toBe(false)
    expect(networkConfig({ CANDLE_X402_NETWORK: "solana-devnet" }).ok).toBe(false)
  })
})

describe("selectRequirement", () => {
  test("picks exact USDC on the configured network", () => {
    const pick = selectRequirement(required(devnetOffer({ scheme: "upto" }), devnetOffer()), devnet())
    expect(pick).toEqual({
      ok: true,
      selected: { requirement: devnetOffer(), amountRaw: 10000n, feePayer: FEE_PAYER, memo: MEMO },
    })
  })

  test("refuses another network, asset or scheme and says what was offered", () => {
    for (const offer of [
      devnetOffer({ network: SOLANA_MAINNET }),
      devnetOffer({ asset: USDC_MINTS[SOLANA_MAINNET] }),
      devnetOffer({ scheme: "upto" }),
    ]) {
      const pick = selectRequirement(required(offer), devnet())
      expect(pick.ok).toBe(false)
      if (!pick.ok) expect(pick.reason).toContain(offer.network)
    }
    expect(selectRequirement(required(), devnet())).toEqual({
      ok: false,
      reason: `No offer this CLI can pay: it pays exact USDC on ${SOLANA_DEVNET}, and the server offered nothing.`,
    })
  })

  test("refuses an unreadable amount, fee payer or memo", () => {
    for (const offer of [
      devnetOffer({ amount: "0" }),
      devnetOffer({ amount: "1.5" }),
      devnetOffer({ amount: "18446744073709551616" }),
      devnetOffer({ extra: { memo: MEMO } }),
      devnetOffer({ extra: { feePayer: FEE_PAYER, memo: "other" } }),
      devnetOffer({ payTo: "not-an-address" }),
    ]) {
      expect(selectRequirement(required(offer), devnet()).ok).toBe(false)
    }
  })

  test("usdcText", () => {
    expect([usdcText(10000n), usdcText(50000n), usdcText(1_000_000n), usdcText(1_234_567n)]).toEqual([
      "0.01",
      "0.05",
      "1",
      "1.234567",
    ])
  })
})
