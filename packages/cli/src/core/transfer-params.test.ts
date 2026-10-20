/**
 * BE-1680 (spec S4 T-3 to T-5): the pure rules of a transfer. Addresses are normalized before any
 * card (spaces removed, EVM to its checksum spelling); the confirm word follows the CLI's
 * `confirmSend` (BE-1710 removed the last six); the form's decimal becomes raw units exactly.
 */
import { describe, expect, test } from "bun:test"
import { toChecksumAddress } from "../evm-lite"
import { encodePubkey } from "../solana-lite"
import {
  confirmTyped,
  describeSend,
  groupAddress,
  normalizeAddress,
  parseTransferInput,
  rawToDecimal,
} from "./transfer-params"

const SOL = encodePubkey(new Uint8Array(32).fill(21))
const FROM = encodePubkey(new Uint8Array(32).fill(11))
const EVM = toChecksumAddress(`0x${"ef".repeat(20)}`)

describe("addresses (T-3)", () => {
  test("a pasted address with spaces, or an EVM address in another case, is normalized", () => {
    expect(normalizeAddress("solana", ` ${groupAddress(SOL)} `)).toBe(SOL)
    expect(normalizeAddress("hood", EVM.toLowerCase())).toBe(EVM)
    expect(groupAddress(EVM).startsWith("0x ")).toBe(true)
  })

  test("a malformed address, or a mixed-case EVM address with a bad checksum, is refused", () => {
    expect(() => normalizeAddress("solana", "0OIl")).toThrow()
    expect(() => normalizeAddress("hood", "0x1234")).toThrow()
    // The checksum spelling with one letter's case flipped: still mixed case, now a bad checksum.
    const at = EVM.slice(2).search(/[a-fA-F]/) + 2
    const flipped = EVM[at] === EVM[at]?.toUpperCase() ? EVM[at]?.toLowerCase() : EVM[at]?.toUpperCase()
    const bad = `${EVM.slice(0, at)}${flipped}${EVM.slice(at + 1)}`
    expect(/[a-f]/.test(bad.slice(2)) && /[A-F]/.test(bad.slice(2))).toBe(true)
    expect(() => normalizeAddress("hood", bad)).toThrow()
  })
})

describe("the confirmations (T-5)", () => {
  test("confirm is trimmed and compared without case; nothing else passes", () => {
    expect(confirmTyped(" Confirm ")).toBe(true)
    for (const typed of ["yes", "", undefined, "confirmed"]) expect(confirmTyped(typed)).toBe(false)
  })

  test("BE-1710: the destination's last six, the old answer, is not the word", () => {
    expect(confirmTyped(SOL.slice(-6))).toBe(false)
    expect(confirmTyped(EVM.slice(-6))).toBe(false)
  })

  test("the send is described the CLI's way", () => {
    expect(describeSend("1.5", "SOL", SOL)).toBe(`send 1.5 SOL to ${SOL}`)
  })
})

describe("amounts (T-4)", () => {
  const base = { source: { kind: "vault", address: FROM }, chain: "solana", asset: { symbol: "SOL" }, to: SOL }
  test("a decimal becomes raw units; max stays max; too many places is refused", async () => {
    const none = async () => undefined
    expect((await parseTransferInput({ ...base, amount: { decimal: "1.5" } }, none)).amount).toEqual({
      raw: "1500000000",
    })
    expect((await parseTransferInput({ ...base, amount: { max: true } }, none)).amount).toEqual({ max: true })
    await expect(parseTransferInput({ ...base, amount: { decimal: "0.0000000001" } }, none)).rejects.toMatchObject({
      code: "INVALID_AMOUNT",
    })
    expect(rawToDecimal(1500000000n, 9)).toBe("1.5")
  })

  test("the destination may not be the source, and a base asset must live on the chain", async () => {
    const none = async () => undefined
    await expect(parseTransferInput({ ...base, to: FROM, amount: { decimal: "1" } }, none)).rejects.toMatchObject({
      code: "INVALID_DESTINATION",
    })
    await expect(
      parseTransferInput({ ...base, asset: { symbol: "ETH" }, amount: { decimal: "1" } }, none),
    ).rejects.toMatchObject({ code: "INVALID_ASSET" })
  })
})
