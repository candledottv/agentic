/**
 * The `exact` transaction against `@solana/web3.js` and `@solana/spl-token` as an independent
 * oracle (dev dependencies only), checked against the rules the server's local checks apply
 * (`apps/api/src/services/x402/transaction.ts`) and the facilitator's.
 */
import { describe, expect, test } from "bun:test"
import { ed25519 } from "@noble/curves/ed25519"
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token"
import { ComputeBudgetProgram, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js"
import { signMessage } from "../solana-lite"
import { SOLANA_DEVNET, USDC_MINTS } from "./select"
import {
  buildExactTransfer,
  COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  MEMO_PROGRAM_ID,
  serializePartiallySigned,
} from "./solana-exact"

const payer = Keypair.fromSeed(new Uint8Array(32).fill(7))
const feePayer = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey.toBase58()
const payTo = Keypair.fromSeed(new Uint8Array(32).fill(11)).publicKey.toBase58()
const asset = USDC_MINTS[SOLANA_DEVNET]
const memo = `cndl:${"ab".repeat(16)}`
const blockhash = Keypair.fromSeed(new Uint8Array(32).fill(13)).publicKey.toBase58()

function build(amountRaw = 10_000n) {
  const transfer = buildExactTransfer({
    payer: payer.publicKey.toBase58(),
    payTo,
    asset,
    amountRaw,
    feePayer,
    memo,
    recentBlockhash: blockhash,
  })
  const wire = serializePartiallySigned(transfer, signMessage(transfer.message, payer.secretKey))
  return { transfer, tx: VersionedTransaction.deserialize(Buffer.from(wire, "base64")) }
}

describe("solana exact transfer (spec 10.2)", () => {
  test("a v0 message, no lookup tables, the facilitator's fee payer at account 0", () => {
    const { tx } = build()
    expect(tx.version).toBe(0)
    expect(tx.message.addressTableLookups).toHaveLength(0)
    expect(tx.message.staticAccountKeys[0]?.toBase58()).toBe(feePayer)
    expect(tx.message.recentBlockhash).toBe(blockhash)
    expect(tx.message.header.numRequiredSignatures).toBe(2)
  })

  test("compute limit, a price under 5 lamports a CU, TransferChecked to payTo's account, the memo", () => {
    const { tx } = build(50_000n)
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58())
    const ixs = tx.message.compiledInstructions
    expect(ixs.map((ix) => keys[ix.programIdIndex])).toEqual([
      ComputeBudgetProgram.programId.toBase58(),
      ComputeBudgetProgram.programId.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
      MEMO_PROGRAM_ID,
    ])
    const price = Buffer.from(ixs[1]?.data ?? []).readBigUInt64LE(1)
    expect(price).toBe(COMPUTE_UNIT_PRICE_MICROLAMPORTS)
    expect(price <= 5_000_000n).toBe(true)

    const transfer = ixs[2]
    if (!transfer) throw new Error("no transfer")
    const data = Buffer.from(transfer.data)
    expect([data[0], data.readBigUInt64LE(1), data[9]]).toEqual([12, 50_000n, 6])
    const [source, mint, destination, authority] = transfer.accountKeyIndexes.map((i) => keys[i])
    const mintKey = new PublicKey(asset)
    expect(source).toBe(getAssociatedTokenAddressSync(mintKey, payer.publicKey).toBase58())
    expect(mint).toBe(asset)
    expect(destination).toBe(getAssociatedTokenAddressSync(mintKey, new PublicKey(payTo), true).toBase58())
    expect(authority).toBe(payer.publicKey.toBase58())
    expect(Buffer.from(ixs[3]?.data ?? []).toString("utf8")).toBe(memo)
  })

  test("the fee payer is in no instruction and authorizes nothing", () => {
    const { tx } = build()
    for (const ix of tx.message.compiledInstructions) {
      expect(ix.programIdIndex).not.toBe(0)
      expect(ix.accountKeyIndexes).not.toContain(0)
    }
  })

  test("the payer's signature is valid and the fee payer's slot is left for the facilitator", () => {
    const { tx, transfer } = build()
    expect(tx.signatures[0]).toEqual(new Uint8Array(64))
    const signature = tx.signatures[transfer.payerIndex] as Uint8Array
    expect(ed25519.verify(signature, tx.message.serialize(), payer.publicKey.toBytes())).toBe(true)
  })

  test("refuses a fee payer that is the paying wallet", () => {
    expect(() =>
      buildExactTransfer({
        payer: feePayer,
        payTo,
        asset,
        amountRaw: 1n,
        feePayer,
        memo,
        recentBlockhash: blockhash,
      }),
    ).toThrow("fee payer")
  })
})
