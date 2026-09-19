/**
 * Drift guard between the CLI's transfer-shaped extension reader (`src/token-2022.ts`) and
 * `packages/shared/src/token-2022.ts`, which P3-ED-8 names as the ONE parser.
 *
 * Same reasoning as `wallet-import.drift.test.ts`: the CLI is published alone into the
 * `candledottv/agentic` mirror, which has no `packages/shared`, and the shared module imports
 * `@solana/web3.js`, which the CLI must never bundle into `dist` (E21; P3-ED-6's "no new Solana
 * runtime dependency"). So the shared module stays the server's one parser and the CLI mirrors its
 * rules, and this holds the two to the same answers on the same bytes: same risk kinds, same
 * order, same wording, and the same refusals.
 *
 * The fixtures are built here rather than imported, so that this file fails on its own when either
 * side moves. Skipped when the shared source is absent (the mirror); the monorepo, where edits
 * happen, always has both.
 */
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { parseMintAccount } from "./token-2022"

const sharedPath = join(import.meta.dir, "..", "..", "shared", "src", "token-2022.ts")
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
const MINT = "So11111111111111111111111111111111111111112"
const DELEGATE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
const HOOK = "HooKr1tAWjvhRGDtCaAhAPTXGYpoNnBCE3JnXdxNjyzq"
const PAUSE = "2wmVCSfPxGPjrnMMn7rchp4uaeoTqN39mXFC2zhPdri9"

function baseMint(decimals: number): Uint8Array {
  const data = new Uint8Array(82)
  data[44] = decimals
  data[45] = 1
  return data
}

function extendedMint(decimals: number, extensions: Array<{ type: number; body: Uint8Array }>): Uint8Array {
  const parts = extensions.flatMap(({ type, body }) => {
    const header = new Uint8Array(4)
    const view = new DataView(header.buffer)
    view.setUint16(0, type, true)
    view.setUint16(2, body.length, true)
    return [header, body]
  })
  const data = new Uint8Array(166 + parts.reduce((n, p) => n + p.length, 0))
  data.set(baseMint(decimals), 0)
  data[165] = 1
  let at = 166
  for (const part of parts) {
    data.set(part, at)
    at += part.length
  }
  return data
}

function key(address: string): Uint8Array {
  // The addresses above are pinned base58 constants; decoding them here keeps this file free of
  // any dependency the CLI does not already declare.
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
  let value = 0n
  for (const char of address) {
    const index = ALPHABET.indexOf(char)
    if (index < 0) throw new Error(`not base58: ${address}`)
    value = value * 58n + BigInt(index)
  }
  const out = new Uint8Array(32)
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(value & 0xffn)
    value >>= 8n
  }
  return out
}

function transferFeeBody(): Uint8Array {
  const body = new Uint8Array(108)
  const view = new DataView(body.buffer)
  view.setBigUint64(72, 10n, true)
  view.setBigUint64(80, 1_000_000n, true)
  view.setUint16(88, 150, true)
  view.setBigUint64(90, 600n, true)
  view.setBigUint64(98, 2_000_000n, true)
  view.setUint16(106, 250, true)
  return body
}

function hookBody(): Uint8Array {
  const body = new Uint8Array(64)
  body.set(key(DELEGATE), 0)
  body.set(key(HOOK), 32)
  return body
}

function pausableBody(): Uint8Array {
  const body = new Uint8Array(33)
  body.set(key(PAUSE), 0)
  body[32] = 1
  return body
}

const FIXTURES: Array<{ name: string; data: Uint8Array }> = [
  { name: "no extensions", data: baseMint(9) },
  { name: "transfer fee only", data: extendedMint(6, [{ type: 1, body: transferFeeBody() }]) },
  { name: "hook only", data: extendedMint(6, [{ type: 14, body: hookBody() }]) },
  { name: "non-transferable NFT", data: extendedMint(0, [{ type: 9, body: new Uint8Array(0) }]) },
  { name: "default frozen", data: extendedMint(6, [{ type: 6, body: new Uint8Array([2]) }]) },
  { name: "default unfrozen", data: extendedMint(6, [{ type: 6, body: new Uint8Array([1]) }]) },
  { name: "permanent delegate", data: extendedMint(6, [{ type: 12, body: key(DELEGATE) }]) },
  { name: "pausable and paused", data: extendedMint(6, [{ type: 26, body: pausableBody() }]) },
  {
    name: "all of R5's warnings at once",
    data: extendedMint(6, [
      { type: 1, body: transferFeeBody() },
      { type: 6, body: new Uint8Array([2]) },
      { type: 9, body: new Uint8Array(0) },
      { type: 12, body: key(DELEGATE) },
      { type: 14, body: hookBody() },
      { type: 26, body: pausableBody() },
    ]),
  },
  {
    name: "an unknown extension between two known ones",
    data: extendedMint(6, [
      { type: 12, body: key(DELEGATE) },
      { type: 777, body: new Uint8Array([1, 2, 3, 4, 5]) },
      { type: 9, body: new Uint8Array(0) },
    ]),
  },
]

const MALFORMED: Array<{ name: string; data: Uint8Array }> = [
  { name: "too short to be a mint", data: new Uint8Array(10) },
  { name: "a wrong extension length", data: extendedMint(6, [{ type: 12, body: new Uint8Array(31) }]) },
  {
    name: "a duplicate extension",
    data: extendedMint(6, [
      { type: 9, body: new Uint8Array(0) },
      { type: 9, body: new Uint8Array(0) },
    ]),
  },
]

describe("the CLI reader and the shared parser answer the same on the same bytes", () => {
  if (!existsSync(sharedPath)) {
    // Standalone checkout without packages/shared: nothing to drift from.
    test("skipped: packages/shared is not in this checkout", () => {
      expect(existsSync(sharedPath)).toBe(false)
    })
    return
  }

  for (const fixture of FIXTURES) {
    test(`${fixture.name}: same risk kinds, order and wording`, async () => {
      const { parseToken2022Extensions } = await import("../../shared/src/token-2022")
      const shared = parseToken2022Extensions(MINT, TOKEN_2022_PROGRAM_ID, fixture.data)
      const ours = parseMintAccount(MINT, TOKEN_2022_PROGRAM_ID, fixture.data)
      // Compared as strings: the shared type also declares `"unavailable"`, which its parser never
      // emits (a caller pushes it when a mint read fails). The CLI refuses an unreadable mint
      // outright rather than carrying an advisory risk for it, so its union does not have that
      // member -- a difference in the types, not in what either function returns here.
      expect(ours.risks.map((r) => String(r.kind))).toEqual(shared.map((r) => String(r.kind)))
      expect(ours.risks.map((r) => r.message)).toEqual(shared.map((r) => r.message))
    })
  }

  for (const fixture of MALFORMED) {
    test(`${fixture.name}: both refuse rather than half-read`, async () => {
      const { parseToken2022Extensions } = await import("../../shared/src/token-2022")
      expect(() => parseToken2022Extensions(MINT, TOKEN_2022_PROGRAM_ID, fixture.data)).toThrow()
      expect(() => parseMintAccount(MINT, TOKEN_2022_PROGRAM_ID, fixture.data)).toThrow()
    })
  }

  test("the fee arithmetic agrees, including the epoch switch, the rounding and the cap", async () => {
    const { parseToken2022Extensions, token2022TransferAmounts } = await import("../../shared/src/token-2022")
    const { transferFeeFor } = await import("./token-2022")
    const data = extendedMint(6, [{ type: 1, body: transferFeeBody() }])
    const shared = parseToken2022Extensions(MINT, TOKEN_2022_PROGRAM_ID, data)
    const ours = parseMintAccount(MINT, TOKEN_2022_PROGRAM_ID, data)
    for (const epoch of [1n, 599n, 600n, 10_000n]) {
      for (const amount of [1n, 7n, 12_345n, 1_000_000_000n]) {
        const theirs = token2022TransferAmounts(shared, amount, epoch)
        const mine = transferFeeFor(ours, amount, epoch)
        // The epoch and amount are in the assertion, so a failure names the case.
        expect(`${epoch}/${amount}: ${mine.feeRaw}`).toBe(`${epoch}/${amount}: ${theirs.transferFeeRaw}`)
        expect(`${epoch}/${amount}: ${mine.postFeeAmountRaw}`).toBe(`${epoch}/${amount}: ${theirs.postFeeAmountRaw}`)
      }
    }
  })

  test("a classic mint yields no risks on either side", async () => {
    const { parseToken2022Extensions } = await import("../../shared/src/token-2022")
    const classic = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    expect(parseToken2022Extensions(MINT, classic, baseMint(6))).toEqual([])
    expect(parseMintAccount(MINT, classic, baseMint(6)).risks).toEqual([])
  })
})
