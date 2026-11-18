/** BE-3765: fixed protocol fixtures and hostile build mutations before local signing. */
import { describe, expect, test } from "bun:test"
import { amountMicrosOf, fixed6Micros, type TransferBuild, verifyTransferBuild } from "./perps-transfer"

const ID = "transfer-1"
const ACCOUNT = "0x52908400098527886e0f7030069857d2e4169ee7"
const OTHER = "0x2222222222222222222222222222222222222222"
const domain = {
  name: "HyperliquidSignTransaction",
  version: "1",
  chainId: 42161,
  verifyingContract: `0x${"0".repeat(40)}`,
}
// Field order from hyperliquid-python-sdk/utils/signing.py, USD_CLASS_TRANSFER_SIGN_TYPES and SEND_ASSET_SIGN_TYPES.
function fixture(mode: "toDex" | "fromSpot" = "toDex"): TransferBuild {
  const dex = mode === "toDex"
  const primary = dex ? "HyperliquidTransaction:SendAsset" : "HyperliquidTransaction:UsdClassTransfer"
  const names = dex
    ? ["hyperliquidChain", "destination", "sourceDex", "destinationDex", "token", "amount", "fromSubAccount", "nonce"]
    : ["hyperliquidChain", "amount", "toPerp", "nonce"]
  const message: Record<string, unknown> = dex
    ? {
        hyperliquidChain: "Mainnet",
        destination: ACCOUNT,
        sourceDex: "",
        destinationDex: "xyz",
        token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
        amount: "5",
        fromSubAccount: "",
        nonce: 7,
      }
    : { hyperliquidChain: "Mainnet", amount: "5", toPerp: true, nonce: 7 }
  return {
    id: ID,
    status: "built",
    mode,
    ...(dex ? { dex: "xyz" } : {}),
    nonce: 7,
    typedData: {
      domain,
      types: {
        [primary]: names.map((name) => ({
          name,
          type: name === "nonce" ? "uint64" : name === "toPerp" ? "bool" : "string",
        })),
      },
      primary_type: primary,
      message,
    },
    action: { type: dex ? "sendAsset" : "usdClassTransfer", signatureChainId: "0xa4b1", ...message },
  }
}
const expected = (mode: "toDex" | "fromSpot" = "toDex") => ({
  id: ID,
  account: ACCOUNT,
  mode,
  ...(mode === "toDex" ? { dex: "xyz" } : {}),
  amountMicros: 5_000_000n,
})
describe("verifyTransferBuild", () => {
  test("official dex and spot shapes bind signed nonce and action", () => {
    for (const mode of ["toDex", "fromSpot"] as const)
      expect(verifyTransferBuild(fixture(mode), expected(mode))).toBeNull()
  })
  test("foreign destination, token, subaccount, dex, amount, domain, type and unsigned action are refused", () => {
    for (const patch of [
      { destination: OTHER },
      { token: "OTHER" },
      { fromSubAccount: OTHER },
      { sourceDex: "xyz" },
      { destinationDex: "other" },
      { amount: "6" },
      { nonce: 8 },
    ]) {
      const build = fixture()
      Object.assign(build.typedData!.message, patch)
      expect(verifyTransferBuild(build, expected())).not.toBeNull()
    }
    const badDomain = fixture()
    badDomain.typedData!.domain.chainId = 1
    expect(verifyTransferBuild(badDomain, expected())).not.toBeNull()
    const badAction = fixture()
    badAction.action!.destination = OTHER
    expect(verifyTransferBuild(badAction, expected())).not.toBeNull()
    const badTypes = fixture()
    badTypes.typedData!.types = {}
    expect(verifyTransferBuild(badTypes, expected())).not.toBeNull()
  })
  test("spot subaccount suffix, omitted nonce, wrong direction and added destination are refused", () => {
    for (const patch of [
      { amount: `5 subaccount:${OTHER}` },
      { nonce: undefined },
      { toPerp: false },
      { destination: OTHER },
    ]) {
      const build = fixture("fromSpot")
      Object.assign(build.typedData!.message, patch)
      expect(verifyTransferBuild(build, expected("fromSpot"))).not.toBeNull()
    }
  })
  test("amount parsers", () => {
    expect(amountMicrosOf("5")).toBe(5_000_000n)
    expect(amountMicrosOf("0")).toBeNull()
    expect(fixed6Micros("5.000000")).toBe(5_000_000n)
  })
})
