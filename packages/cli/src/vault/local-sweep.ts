/**
 * Ember Phase 3 PR F (BE-226, R6, P3-AD-13): the local sweep an EXTERNAL key signs.
 *
 * `candle external sweep <external> --to <vault>` sends everything an external wallet holds back
 * to a named vault receive key: SOL, classic SPL and Token-2022 (R5), signed locally with the
 * external key and nothing else. The shape is the TEE sweep's (`tee.ts`) without its server side:
 * no lifecycle read, no server record, no pending-record persistence (an external entry carries no
 * `tee` metadata to keep one in). Each token account is one transaction, transfer then close under
 * the mint's owning program (P3-ED-7), with the hook tail resolved and the post-fee amount shown; a
 * finalized failure earns one of R5's four names as a leftover and never stops the rest; SOL goes
 * last, minus the fee that exact transfer costs.
 */
import { base58 } from "@scure/base"
import type { CommandContext } from "../deps"
import { describeRpcFailure, notePostSignatureRateLimit } from "../solana-endpoint"
import {
  type AccountMeta,
  associatedTokenAddress,
  compileLegacyMessage,
  createAssociatedTokenAccountIdempotent,
  decodePubkey,
  encodePubkey,
  type Instruction,
  isRateLimited,
  type Pubkey,
  type SolanaRpc,
  serializeSignedTransaction,
  signMessage,
  systemTransfer,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  toBase64,
  tokenCloseAccount,
  tokenTransferChecked,
} from "../solana-lite"
import { classifyStatus } from "../sweep-pending"
import {
  classifyTokenSendFailure,
  type MintProfile,
  readMintProfile,
  resolveTransferHookAccounts,
  transferFeeFor,
} from "../token-2022"

/** SPL token account layout: mint(32) owner(32) amount(8) delegate COption(36), then state. */
const TOKEN_ACCOUNT_STATE_OFFSET = 108
const TOKEN_ACCOUNT_STATE_FROZEN = 2
/** Finality polling: 2 s apart, up to 45 tries (90 s), as the TEE sweep waits. */
const CONFIRM_POLL_MS = 2_000
const CONFIRM_MAX_POLLS = 45

export interface SweepReceipt {
  kind: "token" | "close" | "sol"
  mint?: string
  amountRaw: string
  signature: string
}

export interface SweepLeftover {
  kind: string
  detail: string
  mint?: string
  account?: string
  amountRaw?: string
  signature?: string
}

export interface LocalSweepOutcome {
  receipts: SweepReceipt[]
  leftovers: SweepLeftover[]
}

type Broadcast =
  | { status: "finalized"; signature: string }
  | { status: "failed"; signature: string; error: string }
  | { status: "uncertain"; signature: string; error: string }

async function broadcastAndFinalize(
  rpc: SolanaRpc,
  ctx: CommandContext,
  secret64: Uint8Array,
  feePayer: Pubkey,
  instructions: Instruction[],
): Promise<Broadcast> {
  const { deps } = ctx
  const blockhash = await rpc.getLatestBlockhash()
  const message = compileLegacyMessage({ feePayer, recentBlockhash: blockhash, instructions })
  const signatureBytes = signMessage(message, secret64)
  const signature = base58.encode(signatureBytes)
  const wire = serializeSignedTransaction(message, signatureBytes)
  try {
    await rpc.sendTransaction(toBase64(wire))
  } catch (error) {
    // BE-355 (D4): the leftover is unchanged; a rate limit adds the line naming the signature
    // and the fix. The client never re-sends.
    if (isRateLimited(error)) notePostSignatureRateLimit(ctx, signature)
    return {
      status: "uncertain",
      signature,
      error: `send did not answer cleanly (${describeRpcFailure(error)}); it may still land`,
    }
  }
  for (let i = 0; i < CONFIRM_MAX_POLLS; i++) {
    let status: Awaited<ReturnType<SolanaRpc["getSignatureStatus"]>>
    try {
      status = await rpc.getSignatureStatus(signature)
    } catch (error) {
      if (isRateLimited(error)) notePostSignatureRateLimit(ctx, signature)
      return {
        status: "uncertain",
        signature,
        error: `status read failed (${describeRpcFailure(error)}); ${signature} may still land`,
      }
    }
    const observed = classifyStatus(status)
    if (observed.kind === "finalized") return { status: "finalized", signature }
    if (observed.kind === "failed") {
      return { status: "failed", signature, error: `failed on chain: ${JSON.stringify(observed.err)}` }
    }
    await deps.sleep(CONFIRM_POLL_MS)
  }
  return {
    status: "uncertain",
    signature,
    error: `not finalized within ${(CONFIRM_MAX_POLLS * CONFIRM_POLL_MS) / 1000}s; it may still land`,
  }
}

/**
 * Sweeps every balance `owner` holds to `destination`, signing each transaction with `secret64`.
 * `say` receives one human line per event (nothing under `--json`, where the caller passes a no-op).
 */
export async function sweepEverythingTo(input: {
  rpc: SolanaRpc
  ctx: CommandContext
  secret64: Uint8Array
  owner: string
  destination: string
  say: (line: string) => void
}): Promise<LocalSweepOutcome> {
  const { rpc, ctx, secret64, say } = input
  const ownerKey = decodePubkey(input.owner)
  const destinationKey = decodePubkey(input.destination)
  const receipts: SweepReceipt[] = []
  const leftovers: SweepLeftover[] = []

  // 1. Token accounts under BOTH programs (R5), transfer then close under the mint's program.
  const tokenAccounts: Awaited<ReturnType<SolanaRpc["getTokenAccountsByOwner"]>> = []
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      tokenAccounts.push(...(await rpc.getTokenAccountsByOwner(input.owner, programId)))
    } catch (error) {
      leftovers.push({
        kind: "inventory",
        detail: `could not list ${programId === TOKEN_PROGRAM_ID ? "token" : "Token-2022"} accounts: ${describeRpcFailure(error)}`,
      })
    }
  }
  let epoch: bigint | undefined
  for (const acct of tokenAccounts) {
    const token2022 = acct.programId === TOKEN_2022_PROGRAM_ID
    if (acct.state !== "initialized") {
      leftovers.push({
        kind: token2022 && acct.state === "frozen" ? "TOKEN_2022_FROZEN" : "frozen-or-uninitialized",
        detail: `token account state ${acct.state}`,
        mint: acct.mint,
        account: acct.pubkey,
        amountRaw: acct.amountRaw,
      })
      continue
    }
    try {
      const tokenProgram = decodePubkey(acct.programId)
      const mint = decodePubkey(acct.mint)
      const source = decodePubkey(acct.pubkey)
      const destinationAta = associatedTokenAddress(destinationKey, mint, tokenProgram)
      const instructions: Instruction[] = []
      const amount = BigInt(acct.amountRaw)
      let profile: MintProfile | undefined
      let extraAccountsMissing = false
      let destinationFrozen = false
      if (amount > 0n) {
        let extraAccounts: AccountMeta[] = []
        if (token2022) {
          profile = await readMintProfile(rpc, acct.mint)
          const hook = await resolveTransferHookAccounts(rpc, {
            profile,
            source,
            destination: destinationAta,
            owner: ownerKey,
            amount,
          })
          if (hook.ok) extraAccounts = hook.accounts
          else {
            extraAccountsMissing = true
            say(`  ${acct.mint}: the transfer hook's extra accounts could not be resolved (${hook.reason})`)
          }
          for (const risk of profile.risks) say(`  ${acct.mint}: ${risk.message}`)
          if (profile.newerTransferFee || profile.olderTransferFee) {
            epoch ??= await rpc.getEpoch()
            const { feeRaw, postFeeAmountRaw } = transferFeeFor(profile, amount, epoch)
            say(
              `  ${acct.mint}: ${postFeeAmountRaw} raw will arrive; ${feeRaw} raw is withheld by the mint at epoch ${epoch}`,
            )
          }
        }
        const existing = await rpc.getAccountInfo(encodePubkey(destinationAta))
        if (existing === null) {
          instructions.push(
            createAssociatedTokenAccountIdempotent({ payer: ownerKey, owner: destinationKey, mint, tokenProgram }),
          )
          destinationFrozen = profile?.defaultFrozen ?? false
        } else {
          destinationFrozen = existing.data[TOKEN_ACCOUNT_STATE_OFFSET] === TOKEN_ACCOUNT_STATE_FROZEN
        }
        instructions.push(
          tokenTransferChecked({
            source,
            mint,
            destination: destinationAta,
            owner: ownerKey,
            amount,
            decimals: acct.decimals,
            tokenProgram,
            extraAccounts,
          }),
        )
      }
      instructions.push(tokenCloseAccount({ account: source, destination: ownerKey, owner: ownerKey, tokenProgram }))
      const kind = amount > 0n ? ("token" as const) : ("close" as const)
      const outcome = await broadcastAndFinalize(rpc, ctx, secret64, ownerKey, instructions)
      if (outcome.status === "finalized") {
        receipts.push({ kind, mint: acct.mint, amountRaw: acct.amountRaw, signature: outcome.signature })
        say(`  moved ${acct.amountRaw} raw of ${acct.mint} and closed its account: ${outcome.signature}`)
        continue
      }
      const named =
        outcome.status === "failed" && profile
          ? classifyTokenSendFailure({ profile, frozen: destinationFrozen, extraAccountsMissing })
          : undefined
      leftovers.push({
        kind: outcome.status === "failed" ? (named ?? "token-transfer-failed") : "finality-uncertain",
        detail: outcome.error,
        mint: acct.mint,
        account: acct.pubkey,
        amountRaw: acct.amountRaw,
        signature: outcome.signature,
      })
    } catch (error) {
      leftovers.push({
        kind: "token-transfer-failed",
        detail: describeRpcFailure(error),
        mint: acct.mint,
        account: acct.pubkey,
        amountRaw: acct.amountRaw,
      })
    }
  }

  // 2. Native SOL last, minus the fee this exact transfer costs. Skipped while a token transfer is
  //    uncertain: its fee would change this balance under the transfer.
  const uncertain = leftovers.some((l) => l.kind === "finality-uncertain")
  try {
    const balance = uncertain ? 0n : await rpc.getBalance(input.owner)
    if (uncertain) {
      leftovers.push({ kind: "sol-not-swept", detail: "a token transfer is still uncertain; re-run to sweep the SOL" })
    } else if (balance > 0n) {
      const blockhash = await rpc.getLatestBlockhash()
      const probe = compileLegacyMessage({
        feePayer: ownerKey,
        recentBlockhash: blockhash,
        instructions: [systemTransfer(ownerKey, destinationKey, 1n)],
      })
      const fee = await rpc.getFeeForMessage(toBase64(probe))
      if (fee === null) {
        leftovers.push({
          kind: "sol-fee-unknown",
          detail: "the RPC could not quote the transfer fee",
          amountRaw: balance.toString(),
        })
      } else if (balance <= fee) {
        leftovers.push({
          kind: "sol-dust",
          detail: `balance ${balance} lamports does not cover the ${fee} lamport fee`,
          amountRaw: balance.toString(),
        })
      } else {
        const amount = balance - fee
        const outcome = await broadcastAndFinalize(rpc, ctx, secret64, ownerKey, [
          systemTransfer(ownerKey, destinationKey, amount),
        ])
        if (outcome.status === "finalized") {
          receipts.push({ kind: "sol", amountRaw: amount.toString(), signature: outcome.signature })
          say(`  moved ${amount} lamports (fee ${fee}): ${outcome.signature}`)
        } else {
          leftovers.push({
            kind: outcome.status === "failed" ? "sol-transfer-failed" : "finality-uncertain",
            detail: outcome.error,
            amountRaw: amount.toString(),
            signature: outcome.signature,
          })
        }
      }
    }
  } catch (error) {
    leftovers.push({ kind: "sol-transfer-failed", detail: describeRpcFailure(error) })
  }

  return { receipts, leftovers }
}
