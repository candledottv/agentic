/**
 * Ember Phase 2 PR C (ED-10, CC-08): build, display and locally sign the two vault transfer
 * shapes. `vault fund` signs them from vault keys only. BE-326 (ED-10 amendment, 2026-09-24):
 * `vault transfer` may also sign them from a promoted wallet (`role: "tee-wallet"`).
 *
 * Ember Phase 3 PR A (BE-218) applies the Phase 2 ED-10 amendment: the token shape is built under
 * the MINT's owning program, classic or Token-2022, with idempotent ATA creation under that same
 * program, a transfer hook's extra accounts appended, and the post-fee amount shown before the
 * factor prompt. Nothing else is admitted: still no arbitrary program, no message signing, no EVM.
 */
import { base58 } from "@scure/base"
import type { CommandContext } from "../deps"
import { describeRpcFailure, notePostSignatureRateLimit, type SolanaClient } from "../solana-endpoint"
import {
  compileLegacyMessage,
  createAssociatedTokenAccountIdempotent,
  decodePubkey,
  encodePubkey,
  type Instruction,
  isRateLimited,
  pubkeyFromSecret,
  type SolanaRpc,
  serializeSignedTransaction,
  signMessage,
  systemTransfer,
  toBase64,
  tokenTransferChecked,
} from "../solana-lite"
import {
  ataFor,
  classifyTokenSendFailure,
  type MintProfile,
  MintReadError,
  readMintProfile,
  resolveTransferHookAccounts,
  type Token2022LeftoverKind,
  transferFeeFor,
} from "../token-2022"
import { VaultError } from "./errors"
import type { KeyEntry } from "./format"

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

export function decimalToRaw(decimal: string, decimals: number): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(decimal)) return null
  const [whole, frac = ""] = decimal.split(".")
  if (frac.length > decimals) return null
  return BigInt((whole ?? "0") + frac.padEnd(decimals, "0"))
}

/** `vault fund`'s signer: a vault key only (ED-10; the 2026-09-24 amendment keeps fund cold-sourced). */
export function assertVaultSigner(entry: KeyEntry): void {
  if (entry.role !== "vault") {
    throw new VaultError(
      "PROMOTE_NOT_VAULT_KEY",
      `${entry.label ?? entry.address} is not a vault key, and vault fund signs from vault keys only (ED-10).`,
      {
        suggestion: `To move funds out of a promoted wallet, use: candle vault transfer <to> --from ${entry.label ?? entry.address}`,
      },
    )
  }
}

/**
 * `vault transfer`'s signer (BE-326, ED-10 amendment of 2026-09-24): a vault key or a promoted
 * wallet. An external wallet signs only through `candle sign` and `external sweep`.
 */
export function assertTransferSigner(entry: KeyEntry): void {
  if (entry.role === "vault" || entry.role === "tee-wallet") return
  throw new VaultError(
    "PROMOTE_NOT_VAULT_KEY",
    `${entry.label ?? entry.address} is an external wallet and cannot sign vault transfer shapes (ED-10).`,
    {
      suggestion: `Move funds out of an external wallet with: candle external sweep ${entry.label} --to <vault>`,
    },
  )
}

export interface TransferPlan {
  asset: "SOL" | "USDC" | string
  amount: string
  amountRaw: bigint
  decimals: number
  mint?: string
  from: string
  to: string
  instructions: Instruction[]
  displayLines: string[]
  /**
   * What a failed send needs to earn one of R5's four names. Present for every token move, so that
   * a classic mint answers `undefined` from one code path rather than two.
   */
  token?: {
    profile: MintProfile
    /** The hook tail could not be resolved; the transfer was built and sent without it. */
    extraAccountsMissing: boolean
    /** Source or destination is frozen, or the destination will be created frozen. */
    frozen: boolean
  }
}

/** The name R5 gives this plan's failure, or undefined when the mint explains nothing. */
export function namedSendFailure(plan: TransferPlan): Token2022LeftoverKind | undefined {
  if (!plan.token) return undefined
  return classifyTokenSendFailure({
    profile: plan.token.profile,
    frozen: plan.token.frozen,
    extraAccountsMissing: plan.token.extraAccountsMissing,
  })
}

/** SPL token account layout: mint(32) owner(32) amount(8) delegate COption(36), then state. */
const TOKEN_ACCOUNT_STATE_OFFSET = 108
const TOKEN_ACCOUNT_STATE_FROZEN = 2

/** Whether an existing token account is frozen. A missing account is not frozen; it is missing. */
async function tokenAccountFrozen(rpc: SolanaRpc, address: string): Promise<{ exists: boolean; frozen: boolean }> {
  const account = await rpc.getAccountInfo(address)
  if (account === null) return { exists: false, frozen: false }
  return { exists: true, frozen: account.data[TOKEN_ACCOUNT_STATE_OFFSET] === TOKEN_ACCOUNT_STATE_FROZEN }
}

/**
 * Builds the plan over the caller's client (BE-355: one client per command, built with `sleep`,
 * so every read here is retried once on a rate limit). A rate limit that survives the retry is
 * rethrown untouched, so the command's `client.read` names it `RPC_RATE_LIMITED`.
 */
export async function planTransfer(input: {
  from: string
  to: string
  amount: string
  asset: string
  rpc: SolanaRpc
}): Promise<TransferPlan> {
  const asset = input.asset.toUpperCase()
  const fromKey = decodePubkey(input.from)
  const toKey = decodePubkey(input.to)
  if (asset === "SOL") {
    const raw = decimalToRaw(input.amount, 9)
    if (raw === null || raw === 0n) {
      throw new VaultError("VAULT_INDEX_INVALID", "--amount must be a positive SOL decimal with at most 9 places.")
    }
    return {
      asset: "SOL",
      amount: input.amount,
      amountRaw: raw,
      decimals: 9,
      from: input.from,
      to: input.to,
      instructions: [systemTransfer(fromKey, toKey, raw)],
      displayLines: [
        `fee payer   ${input.from}`,
        `destination ${input.to}`,
        `amount      ${input.amount} SOL = ${raw} lamports`,
        `mint        (native SOL)`,
      ],
    }
  }

  const mintAddress = asset === "USDC" ? USDC_MINT : input.asset
  const rpc = input.rpc
  // The mint account is read, never assumed -- including for USDC. Its OWNER is the program the
  // transfer, the close and the ATA derivation all run under (P3-ED-7), and reading decimals from
  // a table while reading the program from the chain is how the two come apart.
  let profile: MintProfile
  try {
    profile = await readMintProfile(rpc, mintAddress)
  } catch (error) {
    if (error instanceof MintReadError) throw new VaultError("VAULT_UNREADABLE", error.message)
    if (isRateLimited(error)) throw error
    throw new VaultError("VAULT_UNREADABLE", `Could not read mint ${mintAddress}: ${asMessage(error)}`)
  }
  const decimals = profile.decimals
  const raw = decimalToRaw(input.amount, decimals)
  if (raw === null || raw === 0n) {
    throw new VaultError(
      "VAULT_INDEX_INVALID",
      `--amount must be a positive decimal with at most ${decimals} decimal places.`,
    )
  }
  const mint = decodePubkey(mintAddress)
  const tokenProgram = decodePubkey(profile.tokenProgram)
  const source = ataFor(profile, fromKey)
  const destination = ataFor(profile, toKey)
  const instructions: Instruction[] = []
  const accountCreationLines: string[] = []
  const destinationState = await tokenAccountFrozen(rpc, encodePubkey(destination))
  if (!destinationState.exists) {
    const rent = await rpc.getMinimumBalanceForRentExemption(165)
    instructions.push(createAssociatedTokenAccountIdempotent({ payer: fromKey, owner: toKey, mint, tokenProgram }))
    accountCreationLines.push(
      `create associated token account ${encodePubkey(destination)} (idempotent)`,
      `account owner ${input.to}`,
      `account rent ${rent} lamports, paid by ${input.from} if created`,
    )
  }
  const sourceState = await tokenAccountFrozen(rpc, encodePubkey(source))

  // Warnings, then the hook tail, then the post-fee amount: what the operator reads before the
  // factor prompt. None of them refuses the move (P3-AD-9); they are what the confirmation is for.
  const riskLines = profile.risks.map((risk) => `warning     ${risk.message}`)
  const hook = await resolveTransferHookAccounts(rpc, { profile, source, destination, owner: fromKey, amount: raw })
  const hookLines: string[] = []
  if (profile.transferHookProgram) {
    hookLines.push(
      hook.ok
        ? `hook        ${profile.transferHookProgram}: ${hook.accounts.length} extra account(s) resolved`
        : `hook        ${profile.transferHookProgram}: extra accounts could NOT be resolved (${hook.reason}); the send is expected to fail as TOKEN_2022_EXTRA_ACCOUNTS_MISSING`,
    )
  }
  const feeLines: string[] = []
  if (profile.newerTransferFee || profile.olderTransferFee) {
    const epoch = await rpc.getEpoch()
    const { feeRaw, postFeeAmountRaw } = transferFeeFor(profile, raw, epoch)
    feeLines.push(`post-fee    ${postFeeAmountRaw} raw arrives (${feeRaw} raw withheld by the mint at epoch ${epoch})`)
  }
  instructions.push(
    tokenTransferChecked({
      source,
      mint,
      destination,
      owner: fromKey,
      amount: raw,
      decimals,
      tokenProgram,
      extraAccounts: hook.ok ? hook.accounts : [],
    }),
  )
  return {
    asset: asset === "USDC" ? "USDC" : mintAddress,
    amount: input.amount,
    amountRaw: raw,
    decimals,
    mint: mintAddress,
    from: input.from,
    to: input.to,
    instructions,
    token: {
      profile,
      extraAccountsMissing: !hook.ok,
      frozen: sourceState.frozen || destinationState.frozen || (!destinationState.exists && profile.defaultFrozen),
    },
    displayLines: [
      `fee payer   ${input.from}`,
      `destination ${input.to}`,
      `amount      ${input.amount} (${raw} raw, ${decimals} dp)`,
      `mint        ${mintAddress}`,
      `program     ${profile.tokenProgram}${profile.token2022 ? " (Token-2022)" : ""}`,
      ...accountCreationLines,
      ...riskLines,
      ...hookLines,
      ...feeLines,
    ],
  }
}

function asMessage(error: unknown): string {
  return describeRpcFailure(error)
}

export async function quoteTransferFee(
  rpc: SolanaRpc,
  from: string,
  instructions: Instruction[],
): Promise<bigint | null> {
  const blockhash = await rpc.getLatestBlockhash()
  const message = compileLegacyMessage({
    feePayer: decodePubkey(from),
    recentBlockhash: blockhash,
    instructions,
  })
  return rpc.getFeeForMessage(toBase64(message))
}

export function displayTransferPlan(ctx: CommandContext, plan: TransferPlan, feeQuote: bigint | null): void {
  ctx.deps.stdout.write(`Decoded transfer (local signing only):\n`)
  for (const line of plan.displayLines) ctx.deps.stdout.write(`  ${line}\n`)
  if (feeQuote !== null) ctx.deps.stdout.write(`  fee quote  ${feeQuote} lamports\n`)
  else ctx.deps.stdout.write(`  fee quote  (unavailable)\n`)
}

/**
 * Signs and sends. The blockhash read is before the signature: a rate limit there is D3's
 * `RPC_RATE_LIMITED`, exit 1. The send and the status reads after it are the existing uncertain
 * outcome (`finalized: false`, exit 3 at the caller) whatever threw; when what threw was a rate
 * limit, D4's line and the fix are added on stderr, and nothing is ever re-sent.
 */
export async function signAndBroadcastTransfer(input: {
  ctx: CommandContext
  solana: SolanaClient
  secret64: Uint8Array
  plan: TransferPlan
  beforeBroadcast?: (pending: { signature: string; blockhash: string }) => Promise<void>
}): Promise<{ signature: string; finalized: boolean }> {
  const rpc = input.solana.rpc
  const feePayer = pubkeyFromSecret(input.secret64)
  if (encodePubkey(feePayer) !== input.plan.from) {
    throw new VaultError("VAULT_VERIFY_FAILED", "The decrypted key does not match the planned fee payer.")
  }
  const blockhash = await input.solana.read(() => rpc.getLatestBlockhash())
  const message = compileLegacyMessage({
    feePayer,
    recentBlockhash: blockhash,
    instructions: input.plan.instructions,
  })
  const signature = signMessage(message, input.secret64)
  const wire = serializeSignedTransaction(message, signature)
  const sigB58 = base58.encode(signature)
  // The locally computed signature is the transaction identity, even if the RPC lies or times out.
  await input.beforeBroadcast?.({ signature: sigB58, blockhash })
  try {
    await rpc.sendTransaction(toBase64(wire))
  } catch (error) {
    // A failed response cannot prove the transaction was not accepted. Keep its pending receipt.
    if (isRateLimited(error)) notePostSignatureRateLimit(input.ctx, sigB58)
    return { signature: sigB58, finalized: false }
  }
  for (let i = 0; i < 30; i++) {
    await input.ctx.deps.sleep(500)
    let status: Awaited<ReturnType<typeof rpc.getSignatureStatus>>
    try {
      status = await rpc.getSignatureStatus(sigB58)
    } catch (error) {
      if (isRateLimited(error)) notePostSignatureRateLimit(input.ctx, sigB58)
      return { signature: sigB58, finalized: false }
    }
    if (status?.confirmationStatus === "finalized") {
      if (status.err) {
        // Finalized with an error is the one unambiguous failed send, so it is the one place R5's
        // four names are earned. A send that merely did not confirm is uncertain, not refused, and
        // naming it would be a guess.
        const named = namedSendFailure(input.plan)
        throw new VaultError(
          "VAULT_WRITE_FAILED",
          `Transfer failed on chain${named ? ` (${named})` : ""}. Any pending funding receipt will be reconciled on a rerun.`,
        )
      }
      return { signature: sigB58, finalized: true }
    }
  }
  return { signature: sigB58, finalized: false }
}
