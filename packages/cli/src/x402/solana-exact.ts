/**
 * The transaction the Solana `exact` scheme expects (spec 10.2; upstream
 * `specs/schemes/exact/scheme_exact_svm.md`, the standard-wallet layout the server's local checks
 * accept, `apps/api/src/services/x402/transaction.ts`):
 *
 *   SetComputeUnitLimit, SetComputeUnitPrice (at most 5 lamports a CU), TransferChecked from the
 *   payer's USDC token account to payTo's, and a Memo carrying `extra.memo`.
 *
 * A version 0 message with no address lookup tables. The fee payer is `extra.feePayer`, the
 * facilitator's, at account 0; it appears in no instruction, and its signature slot is left empty
 * for the facilitator to fill. This machine signs only as the transfer's authority, with the vault
 * key. Built on `solana-lite.ts`, so no new dependency.
 */
import {
  type AccountMeta,
  associatedTokenAddress,
  compileLegacyMessage,
  decodePubkey,
  encodePubkey,
  type Instruction,
  TOKEN_PROGRAM_ID,
  tokenTransferChecked,
} from "../solana-lite"

export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111"
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
export const USDC_DECIMALS = 6
/** A TransferChecked and a short memo use well under this. */
export const COMPUTE_UNIT_LIMIT = 40_000
/** One micro-lamport a CU: far under the facilitator's ceiling of 5 lamports (5,000,000 micro-lamports). */
export const COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1n

function le(value: bigint, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes)
  let v = value
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

function computeBudget(data: Uint8Array): Instruction {
  return { programId: decodePubkey(COMPUTE_BUDGET_PROGRAM_ID), keys: [], data }
}

function memoInstruction(memo: string): Instruction {
  const keys: AccountMeta[] = []
  return { programId: decodePubkey(MEMO_PROGRAM_ID), keys, data: new TextEncoder().encode(memo) }
}

export interface ExactTransferInput {
  payer: string
  payTo: string
  asset: string
  amountRaw: bigint
  feePayer: string
  memo: string
  recentBlockhash: string
}

export interface ExactTransfer {
  /** The version 0 message the signatures cover. */
  message: Uint8Array
  /** How many signatures the message requires (the fee payer's and the payer's). */
  signatureCount: number
  /** The payer's slot among them. */
  payerIndex: number
}

/** Builds the unsigned message. Throws when the fee payer would also be the payer. */
export function buildExactTransfer(input: ExactTransferInput): ExactTransfer {
  if (input.feePayer === input.payer) throw new Error("The facilitator's fee payer cannot be the paying wallet.")
  const payer = decodePubkey(input.payer)
  const mint = decodePubkey(input.asset)
  const legacy = compileLegacyMessage({
    feePayer: decodePubkey(input.feePayer),
    recentBlockhash: input.recentBlockhash,
    instructions: [
      computeBudget(new Uint8Array([2, ...le(BigInt(COMPUTE_UNIT_LIMIT), 4)])),
      computeBudget(new Uint8Array([3, ...le(COMPUTE_UNIT_PRICE_MICROLAMPORTS, 8)])),
      tokenTransferChecked({
        source: associatedTokenAddress(payer, mint),
        mint,
        destination: associatedTokenAddress(decodePubkey(input.payTo), mint),
        owner: payer,
        amount: input.amountRaw,
        decimals: USDC_DECIMALS,
        tokenProgram: decodePubkey(TOKEN_PROGRAM_ID),
      }),
      memoInstruction(input.memo),
    ],
  })
  // A legacy message is the v0 body with no version prefix and no lookup table section, so the
  // v0 message is the prefix, those bytes, and an empty table list.
  const message = new Uint8Array(legacy.length + 2)
  message[0] = 0x80
  message.set(legacy, 1)
  message[message.length - 1] = 0
  const signatureCount = legacy[0] as number
  // Under 128 accounts the key count is one byte; the keys follow it.
  const keyCount = legacy[3] as number
  let payerIndex = -1
  for (let i = 0; i < keyCount; i++) {
    if (encodePubkey(legacy.slice(4 + i * 32, 4 + (i + 1) * 32)) === input.payer) payerIndex = i
  }
  if (payerIndex < 1 || payerIndex >= signatureCount) throw new Error("unreachable: the payer is not a signer")
  return { message, signatureCount, payerIndex }
}

/** The base64 wire transaction with the payer's signature in its slot and the fee payer's empty. */
export function serializePartiallySigned(transfer: ExactTransfer, payerSignature: Uint8Array): string {
  if (payerSignature.length !== 64) throw new Error("expected a 64-byte signature")
  if (transfer.signatureCount > 127) throw new Error("unreachable: too many signatures")
  const out = new Uint8Array(1 + transfer.signatureCount * 64 + transfer.message.length)
  out[0] = transfer.signatureCount
  out.set(payerSignature, 1 + transfer.payerIndex * 64)
  out.set(transfer.message, 1 + transfer.signatureCount * 64)
  return Buffer.from(out).toString("base64")
}
