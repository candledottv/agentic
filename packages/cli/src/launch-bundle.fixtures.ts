/**
 * Test support for BE-1721 (`launch-bundle.ts`, `commands/launch.ts`'s atomic path): the two legs
 * `/launch/atomic/build` hands a TEE creator who is its own first buyer, shaped as the API builds
 * them. Leg 0 is a v0 message against a lookup table with the four launch signers (payer, platform
 * authority, mint, attribution), the reimbursement, a stand-in `initialize_pool`, the Jito tip and,
 * for an SPL quote, the treasury ATA create. Leg 1 is `atomic-first-buys.ts`'s shape: both ATA
 * creates, the wrap (SOL), the curve swap, the close (SOL) and the tier-fee transfer.
 */
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
} from "@solana/spl-token"
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js"

export const FIXTURE_CURVE_PROGRAM = new PublicKey("6wXTwJwdtA5RhNu6VyYnBzrV51TbsMpTbo5kZv2zdssG")
export const FIXTURE_USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
export const FIXTURE_REIMBURSEMENT = 26_126_320n
export const FIXTURE_TIP = 100_000n
export const FIXTURE_RENT = 2_039_280n
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"

export interface LegOptions {
  wallet: string
  quote: "SOL" | "USDC"
  buyRaw: bigint
  feeRaw: bigint
  minOutRaw: bigint
  /** The amount the swap encodes, when a test wants it to differ from `buyRaw`. */
  swapRaw?: bigint
  /** Extra instructions appended to the buy leg. */
  extraBuy?: (wallet: PublicKey) => TransactionInstruction[]
  /** Another fee payer for the launch leg. */
  launchPayer?: string
}

function u64(value: bigint): Buffer {
  const out = Buffer.alloc(8)
  out.writeBigUInt64LE(value)
  return out
}

function serialize(message: ReturnType<TransactionMessage["compileToV0Message"]>): string {
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64")
}

export function launchLeg(opts: LegOptions): string {
  const payer = new PublicKey(opts.launchPayer ?? opts.wallet)
  const authority = Keypair.generate().publicKey
  const mint = Keypair.generate().publicKey
  const attribution = Keypair.generate().publicKey
  const table = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: BigInt("0xffffffffffffffff"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: [SYSVAR_RENT_PUBKEY, NATIVE_MINT, Keypair.generate().publicKey],
    },
  })
  const initializePool = new TransactionInstruction({
    programId: FIXTURE_CURVE_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: mint, isSigner: true, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: attribution, isSigner: true, isWritable: false },
    ],
    data: Buffer.alloc(8, 7),
  })
  const instructions = [
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: authority, lamports: FIXTURE_REIMBURSEMENT }),
    initializePool,
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: FIXTURE_TIP }),
  ]
  if (opts.quote === "USDC") {
    const treasury = Keypair.generate().publicKey
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        payer,
        getAssociatedTokenAddressSync(FIXTURE_USDC, treasury, true),
        treasury,
        FIXTURE_USDC,
      ),
    )
  }
  return serialize(
    new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions }).compileToV0Message([table]),
  )
}

export function buyLeg(opts: LegOptions): string {
  const wallet = new PublicKey(opts.wallet)
  const quoteMint = opts.quote === "SOL" ? NATIVE_MINT : FIXTURE_USDC
  const baseMint = Keypair.generate().publicKey
  const userQuote = getAssociatedTokenAddressSync(quoteMint, wallet, true)
  const swap = new TransactionInstruction({
    programId: FIXTURE_CURVE_PROGRAM,
    keys: [
      { pubkey: wallet, isSigner: true, isWritable: true },
      { pubkey: userQuote, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([Buffer.alloc(8, 9), u64(opts.swapRaw ?? opts.buyRaw), u64(opts.minOutRaw)]),
  })
  const treasury = Keypair.generate().publicKey
  const instructions = [
    createAssociatedTokenAccountIdempotentInstruction(
      wallet,
      getAssociatedTokenAddressSync(baseMint, wallet, true),
      wallet,
      baseMint,
    ),
    createAssociatedTokenAccountIdempotentInstruction(wallet, userQuote, wallet, quoteMint),
    ...(opts.quote === "SOL"
      ? [
          SystemProgram.transfer({ fromPubkey: wallet, toPubkey: userQuote, lamports: opts.buyRaw }),
          createSyncNativeInstruction(userQuote),
          swap,
          createCloseAccountInstruction(userQuote, wallet, wallet),
        ]
      : [swap]),
    ...(opts.feeRaw > 0n
      ? [
          opts.quote === "SOL"
            ? SystemProgram.transfer({ fromPubkey: wallet, toPubkey: treasury, lamports: opts.feeRaw })
            : createTransferInstruction(
                userQuote,
                getAssociatedTokenAddressSync(FIXTURE_USDC, treasury, true),
                wallet,
                opts.feeRaw,
              ),
        ]
      : []),
    ...(opts.extraBuy?.(wallet) ?? []),
  ]
  return serialize(
    new TransactionMessage({ payerKey: wallet, recentBlockhash: BLOCKHASH, instructions }).compileToV0Message(),
  )
}

/** What the reader should count for these legs: leg 0's four signatures, leg 1's one, and every transfer and rent. */
export function expectedLamports(opts: LegOptions): bigint {
  const launch = 4n * 5_000n + FIXTURE_REIMBURSEMENT + FIXTURE_TIP + (opts.quote === "USDC" ? FIXTURE_RENT : 0n)
  const buy = 5_000n + 2n * FIXTURE_RENT + (opts.quote === "SOL" ? opts.buyRaw + opts.feeRaw : 0n)
  return launch + buy
}

/** A relay signature: the leg with a non-zero payer signature in slot 0. */
export function relaySigned(unsigned: string, fill: number): string {
  const bytes = Buffer.from(unsigned, "base64")
  bytes.fill(fill, 1, 65)
  return bytes.toString("base64")
}
