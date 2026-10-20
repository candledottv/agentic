/**
 * BE-1721 (spec 2026-10-20-tee-launch-buy-packet-size-design.md, R2): what an atomic TEE launch's
 * two legs take from the wallet, read off the bytes Candle built, before the relay signs either.
 *
 * `/launch/atomic/build` names the legs and nothing else: no fee and no debit. The quote shows
 * both anyway, read here from the top-level instructions of each leg, without an RPC:
 *
 * - **SOL** is every System transfer and account creation the wallet funds, the rent of every
 *   associated token account it pays for (a ceiling: an idempotent create of an account that
 *   exists costs nothing), and each leg's base network fee plus any priority fee it sets.
 * - **The quote asset** (USDC or CNDL) is the first buy's own swap input plus every token transfer
 *   the wallet authorizes. A SOL buy's input is its wrap, already counted as SOL.
 * - **The fee** is what the buy leg moves out of the wallet besides the buy itself: a System
 *   transfer that is not the wrap (SOL), or a token transfer (USDC, CNDL).
 *
 * The reading also holds the build to what was confirmed: both legs are paid by the wallet, the
 * buy leg swaps exactly `--buy` (and, for SOL, wraps exactly that), and no leg hands the wallet's
 * control or a token account's rent to anyone else. Anything it cannot account for is refused;
 * the caller says "nothing was signed."
 */
import {
  COMPUTE_BUDGET_PROGRAM_ID,
  type DecodedTransaction,
  decodeStrictBase64,
  decodeTransaction,
  MEMO_PROGRAM_ID,
  TransactionDecodeError,
} from "./solana-alt"
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  decodePubkey,
  encodePubkey,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./solana-lite"

const NATIVE_MINT = "So11111111111111111111111111111111111111112"
/** Solana's base fee per signature, which the fee payer pays for every signer. */
const LAMPORTS_PER_SIGNATURE = 5_000n
/** A rent-exempt SPL token account (165 bytes) at the mainnet schedule. */
const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n
const DEFAULT_UNITS_PER_INSTRUCTION = 200_000n
const MAX_COMPUTE_UNITS = 1_400_000n

export interface BundleReading {
  /** Lamports the wallet can spend across both legs: transfers, rent and network fees. */
  lamports: bigint
  /** Quote-asset base units the wallet can spend (0 for a SOL launch). */
  quoteRaw: bigint
  /** The tier fee in the buy leg, in the quote asset's base units. 0 when none applies. */
  feeRaw: bigint
}

export class BundleReadError extends Error {}

function u32(data: Uint8Array, at: number): bigint {
  if (data.length < at + 4) throw new BundleReadError("an instruction's data ends early")
  return BigInt(new DataView(data.buffer, data.byteOffset + at, 4).getUint32(0, true))
}
function u64(data: Uint8Array, at: number): bigint {
  if (data.length < at + 8) throw new BundleReadError("an instruction's data ends early")
  return new DataView(data.buffer, data.byteOffset + at, 8).getBigUint64(0, true)
}

function decodeLeg(base64: string, index: number): DecodedTransaction {
  try {
    return decodeTransaction(decodeStrictBase64(base64))
  } catch (error) {
    if (error instanceof TransactionDecodeError)
      throw new BundleReadError(`leg ${index} does not decode: ${error.message}`)
    throw error
  }
}

/** One leg read for `wallet`. `staticKeys[0]` is the fee payer, and the wallet is always index 0. */
function readLeg(
  tx: DecodedTransaction,
  index: number,
  wallet: string,
): {
  lamports: bigint
  tokenOut: bigint
  systemTransfers: { to: string | undefined; lamports: bigint }[]
  others: { program: string; data: Uint8Array }[]
} {
  const keys = tx.message.staticKeys
  if (keys[0] !== wallet) throw new BundleReadError(`leg ${index} is not paid by this wallet`)
  const key = (i: number | undefined) => (i === undefined ? undefined : keys[i])
  let lamports = BigInt(tx.message.numRequiredSignatures) * LAMPORTS_PER_SIGNATURE
  let tokenOut = 0n
  let unitPrice = 0n
  let unitLimit: bigint | undefined
  let computed = 0n
  const systemTransfers: { to: string | undefined; lamports: bigint }[] = []
  const others: { program: string; data: Uint8Array }[] = []
  for (const ix of tx.message.instructions) {
    // Programs are never loaded from a lookup table, so every program id is a static key.
    const program = key(ix.programIdIndex)
    const accounts = ix.accountIndexes
    const fromWallet = (position: number) => accounts[position] === 0
    if (program === COMPUTE_BUDGET_PROGRAM_ID) {
      if (ix.data[0] === 2) unitLimit = u32(ix.data, 1)
      else if (ix.data[0] === 3) unitPrice = u64(ix.data, 1)
      continue
    }
    computed++
    if (program === SYSTEM_PROGRAM_ID) {
      if (!accounts.includes(0)) continue
      const kind = u32(ix.data, 0)
      // Transfer (2) and CreateAccount (0) fund from the first account; nothing else may name the wallet.
      if (kind === 2n || kind === 0n) {
        if (!fromWallet(0)) continue
        const amount = u64(ix.data, 4)
        lamports += amount
        if (kind === 2n) systemTransfers.push({ to: key(accounts[1]), lamports: amount })
        continue
      }
      throw new BundleReadError(`leg ${index} has a System instruction (${kind}) on this wallet that is not a transfer`)
    }
    if (program === ASSOCIATED_TOKEN_PROGRAM_ID) {
      if (fromWallet(0)) lamports += TOKEN_ACCOUNT_RENT_LAMPORTS
      continue
    }
    if (program === TOKEN_PROGRAM_ID || program === TOKEN_2022_PROGRAM_ID) {
      const op = ix.data[0]
      // Transfer (3, authority third) and TransferChecked (12, authority fourth).
      if (op === 3 && fromWallet(2)) tokenOut += u64(ix.data, 1)
      else if (op === 12 && fromWallet(3)) tokenOut += u64(ix.data, 1)
      // Approve (4), SetAuthority (6), ApproveChecked (13): control never leaves the wallet.
      else if ((op === 4 || op === 6 || op === 13) && accounts.includes(0))
        throw new BundleReadError(`leg ${index} hands a token account's control to someone else`)
      // CloseAccount (9): the rent goes back to the wallet, or the leg is refused.
      else if (op === 9 && fromWallet(2) && !fromWallet(1))
        throw new BundleReadError(`leg ${index} closes a token account to someone other than this wallet`)
      continue
    }
    if (program === MEMO_PROGRAM_ID) continue
    if (program !== undefined) others.push({ program, data: ix.data })
  }
  if (unitPrice > 0n) {
    const units =
      unitLimit ??
      (computed * DEFAULT_UNITS_PER_INSTRUCTION > MAX_COMPUTE_UNITS
        ? MAX_COMPUTE_UNITS
        : computed * DEFAULT_UNITS_PER_INSTRUCTION)
    lamports += (unitPrice * units + 999_999n) / 1_000_000n
  }
  return { lamports, tokenOut, systemTransfers, others }
}

/**
 * Reads the launch leg (`legs[0]`) and the creator's first buy (`legs[1]`), both unsigned and
 * both paid by `wallet`. `buyRaw` is the confirmed `--buy`; `minOutRaw` the floor the build quoted,
 * when it quoted one. Throws `BundleReadError` for anything that does not read as that bundle.
 */
export function readLaunchBundle(args: {
  legs: [string, string]
  wallet: string
  quote: "SOL" | "USDC" | "CNDL"
  buyRaw: bigint
  minOutRaw?: bigint
}): BundleReading {
  const launch = readLeg(decodeLeg(args.legs[0], 0), 0, args.wallet)
  const buy = readLeg(decodeLeg(args.legs[1], 1), 1, args.wallet)
  // The first buy is one curve swap: an 8-byte discriminator, then the input and the floor (u64).
  if (buy.others.length !== 1) throw new BundleReadError("leg 1 is not one curve swap")
  const swap = buy.others[0] as { data: Uint8Array }
  if (u64(swap.data, 8) !== args.buyRaw) throw new BundleReadError("leg 1 does not swap the confirmed --buy")
  if (args.minOutRaw !== undefined && u64(swap.data, 16) !== args.minOutRaw)
    throw new BundleReadError("leg 1's floor is not the one the build quoted")
  let feeRaw: bigint
  let quoteRaw: bigint
  if (args.quote === "SOL") {
    const wrapAccount = encodePubkey(associatedTokenAddress(decodePubkey(args.wallet), decodePubkey(NATIVE_MINT)))
    const wrapped = buy.systemTransfers.filter((t) => t.to === wrapAccount).reduce((sum, t) => sum + t.lamports, 0n)
    if (wrapped !== args.buyRaw) throw new BundleReadError("leg 1 does not wrap the confirmed --buy")
    feeRaw = buy.systemTransfers.filter((t) => t.to !== wrapAccount).reduce((sum, t) => sum + t.lamports, 0n)
    quoteRaw = 0n
  } else {
    if (buy.systemTransfers.length) throw new BundleReadError("leg 1 moves SOL on a token-quoted buy")
    feeRaw = buy.tokenOut
    quoteRaw = args.buyRaw + buy.tokenOut + launch.tokenOut
  }
  return { lamports: launch.lamports + buy.lamports, quoteRaw, feeRaw }
}
