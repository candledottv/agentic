import { describe, expect, test } from "bun:test"
import {
  createApproveInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
} from "@solana/spl-token"
import { ComputeBudgetProgram, Keypair, SystemProgram } from "@solana/web3.js"
import { BundleReadError, readLaunchBundle } from "./launch-bundle"
import {
  buyLeg,
  expectedLamports,
  FIXTURE_CURVE_PROGRAM,
  FIXTURE_TALLY_RENT,
  FIXTURE_USDC,
  type LegOptions,
  launchLeg,
} from "./launch-bundle.fixtures"

const wallet = Keypair.generate().publicKey.toBase58()
const sol: LegOptions = { wallet, quote: "SOL", buyRaw: 10_000_000n, feeRaw: 100_000n, minOutRaw: 4_000_000n }
const usdc: LegOptions = { wallet, quote: "USDC", buyRaw: 2_500_000n, feeRaw: 25_000n, minOutRaw: 7_000n }

function read(opts: LegOptions, overrides: Partial<Parameters<typeof readLaunchBundle>[0]> = {}) {
  return readLaunchBundle({
    legs: [launchLeg(opts), buyLeg(opts)],
    wallet,
    quote: opts.quote,
    buyRaw: opts.buyRaw,
    minOutRaw: opts.minOutRaw,
    ...overrides,
  })
}

describe("BE-1721: an atomic TEE launch's legs, read before signing", () => {
  test("SOL: every lamport the wallet funds across both legs, and the fee beside the wrap", () => {
    expect(read(sol)).toEqual({ lamports: expectedLamports(sol), quoteRaw: 0n, feeRaw: 100_000n })
  })

  test("USDC: SOL for rent and fees, and the buy plus its fee in USDC", () => {
    expect(read(usdc)).toEqual({ lamports: expectedLamports(usdc), quoteRaw: 2_525_000n, feeRaw: 25_000n })
  })

  test("no fee leg reads as no fee", () => {
    expect(read({ ...sol, feeRaw: 0n }).feeRaw).toBe(0n)
  })

  test("a priority fee the leg sets is counted", () => {
    const priced = buyLeg({
      ...sol,
      extraBuy: () => [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
      ],
    })
    const reading = readLaunchBundle({ legs: [launchLeg(sol), priced], wallet, quote: "SOL", buyRaw: sol.buyRaw })
    // 300,000 units at 10,000 micro-lamports each.
    expect(reading.lamports).toBe(expectedLamports(sol) + 3_000n)
  })

  test("BE-2899: a launch with rules reads the creator's register_buyer ahead of the SOL swap, and its tally's rent", () => {
    const ruled = { ...sol, register: {} }
    expect(read(ruled, { rules: true })).toEqual({ lamports: expectedLamports(ruled), quoteRaw: 0n, feeRaw: 100_000n })
    expect(expectedLamports(ruled) - expectedLamports(sol)).toBe(FIXTURE_TALLY_RENT)
  })

  test("BE-2899: the same on a USDC launch with rules", () => {
    const ruled = { ...usdc, register: {} }
    expect(read(ruled, { rules: true })).toEqual({
      lamports: expectedLamports(ruled),
      quoteRaw: 2_525_000n,
      feeRaw: 25_000n,
    })
  })

  test("BE-2899: a launch with rules whose buy leg does not register still reads as before", () => {
    expect(read(sol, { rules: true })).toEqual(read(sol))
  })

  const curveCall = (data: Buffer) => (owner: Keypair["publicKey"]) => [
    { keys: [{ pubkey: owner, isSigner: true, isWritable: true }], programId: FIXTURE_CURVE_PROGRAM, data },
  ]

  const refused: Array<[string, () => unknown, RegExp]> = [
    [
      "a register_buyer on a launch without rules",
      () => read({ ...sol, register: {} }),
      /registers a buyer on a launch without rules/,
    ],
    [
      "a register_buyer with a proof",
      () => read({ ...sol, register: { proof: [Buffer.alloc(32, 1)] } }, { rules: true }),
      /registers the buyer with a proof/,
    ],
    [
      "a register_buyer for another wallet",
      () => read({ ...sol, register: { buyer: Keypair.generate().publicKey.toBase58() } }, { rules: true }),
      /registers a buyer other than this wallet/,
    ],
    [
      "a register_buyer for another pool than the swap's",
      () => read({ ...sol, register: { otherPool: true } }, { rules: true }),
      /another pool/,
    ],
    [
      "a register_buyer and two swaps",
      () =>
        read(
          { ...sol, register: {}, extraBuy: curveCall(Buffer.concat([Buffer.alloc(8, 9), Buffer.alloc(16)])) },
          { rules: true },
        ),
      /not one curve swap/,
    ],
    [
      "a register_buyer and an unknown instruction",
      () =>
        read(
          {
            ...sol,
            register: {},
            extraBuy: (owner) =>
              [SystemProgram.transfer({ fromPubkey: owner, toPubkey: owner, lamports: 0 })].map((ix) => ({
                ...ix,
                programId: Keypair.generate().publicKey,
              })),
          },
          { rules: true },
        ),
      /not one curve swap/,
    ],
    [
      "two swaps on a launch with rules",
      () =>
        read({ ...sol, extraBuy: curveCall(Buffer.concat([Buffer.alloc(8, 9), Buffer.alloc(16)])) }, { rules: true }),
      /not one curve swap/,
    ],
    [
      "a launch leg paid by another wallet",
      () => read({ ...sol, launchPayer: Keypair.generate().publicKey.toBase58() }),
      /leg 0 is not paid by this wallet/,
    ],
    ["a swap of another amount", () => read({ ...sol, swapRaw: 20_000_000n }), /does not swap the confirmed --buy/],
    ["a floor that is not the quoted one", () => read(sol, { minOutRaw: 1n }), /floor/],
    [
      "a wrap of another amount",
      () =>
        readLaunchBundle({
          legs: [launchLeg(sol), buyLeg({ ...sol, buyRaw: 20_000_000n, swapRaw: 10_000_000n })],
          wallet,
          quote: "SOL",
          buyRaw: 10_000_000n,
        }),
      /does not wrap the confirmed --buy/,
    ],
    [
      "an Approve of the wallet's token account",
      () =>
        read({
          ...usdc,
          extraBuy: (owner) => [
            createApproveInstruction(
              getAssociatedTokenAddressSync(FIXTURE_USDC, owner, true),
              Keypair.generate().publicKey,
              owner,
              1n,
            ),
          ],
        }),
      /control/,
    ],
    [
      "a close that pays the rent to someone else",
      () =>
        read({
          ...usdc,
          extraBuy: (owner) => [
            createCloseAccountInstruction(
              getAssociatedTokenAddressSync(NATIVE_MINT, owner, true),
              Keypair.generate().publicKey,
              owner,
            ),
          ],
        }),
      /closes a token account/,
    ],
    [
      "a System Assign of the wallet",
      () =>
        read({
          ...sol,
          extraBuy: (owner) => [
            SystemProgram.assign({ accountPubkey: owner, programId: Keypair.generate().publicKey }),
          ],
        }),
      /not a transfer/,
    ],
    [
      "a second program call in the buy leg",
      () =>
        read({
          ...sol,
          extraBuy: (owner) =>
            [SystemProgram.transfer({ fromPubkey: owner, toPubkey: owner, lamports: 0 })].map((ix) => ({
              ...ix,
              programId: Keypair.generate().publicKey,
            })),
        }),
      /not one curve swap/,
    ],
    [
      "bytes that are not a transaction",
      () => readLaunchBundle({ legs: ["AAAA", buyLeg(sol)], wallet, quote: "SOL", buyRaw: sol.buyRaw }),
      /leg 0 does not decode/,
    ],
  ]
  for (const [name, run, message] of refused)
    test(`refused: ${name}`, () => {
      expect(run).toThrow(BundleReadError)
      expect(run).toThrow(message)
    })
})
