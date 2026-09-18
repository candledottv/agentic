/**
 * Ember Phase 2 PR C (ED-10, CC-08): build, display and locally sign the two vault transfer
 * shapes. Vault keys only; TEE wallet entries must never reach this path.
 */
import { base58 } from "@scure/base"
import type { CommandContext } from "../deps"
import {
  associatedTokenAddress,
  compileLegacyMessage,
  createAssociatedTokenAccountIdempotent,
  createSolanaRpc,
  decodePubkey,
  encodePubkey,
  type Instruction,
  pubkeyFromSecret,
  serializeSignedTransaction,
  signMessage,
  systemTransfer,
  toBase64,
  tokenTransferChecked,
} from "../solana-lite"
import { VaultError } from "./errors"
import type { KeyEntry } from "./format"

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

export function decimalToRaw(decimal: string, decimals: number): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(decimal)) return null
  const [whole, frac = ""] = decimal.split(".")
  if (frac.length > decimals) return null
  return BigInt((whole ?? "0") + frac.padEnd(decimals, "0"))
}

export function assertVaultSigner(entry: KeyEntry): void {
  if (entry.role !== "vault") {
    throw new VaultError(
      "PROMOTE_NOT_VAULT_KEY",
      `${entry.label ?? entry.address} is a TEE wallet entry and cannot sign vault transfer or fund shapes (ED-10 / N3).`,
    )
  }
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
}

export async function planTransfer(input: {
  from: string
  to: string
  amount: string
  asset: string
  rpcUrl: string
  fetch: typeof fetch
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
  const decimals = asset === "USDC" ? 6 : await readMintDecimals(input.rpcUrl, mintAddress, input.fetch)
  const raw = decimalToRaw(input.amount, decimals)
  if (raw === null || raw === 0n) {
    throw new VaultError(
      "VAULT_INDEX_INVALID",
      `--amount must be a positive decimal with at most ${decimals} decimal places.`,
    )
  }
  const mint = decodePubkey(mintAddress)
  const source = associatedTokenAddress(fromKey, mint)
  const destination = associatedTokenAddress(toKey, mint)
  const rpc = createSolanaRpc(input.rpcUrl, input.fetch)
  const instructions: Instruction[] = []
  const accountCreationLines: string[] = []
  if (!(await rpc.accountExists(encodePubkey(destination)))) {
    const rent = await rpc.getMinimumBalanceForRentExemption(165)
    instructions.push(createAssociatedTokenAccountIdempotent({ payer: fromKey, owner: toKey, mint }))
    accountCreationLines.push(
      `create associated token account ${encodePubkey(destination)} (idempotent)`,
      `account owner ${input.to}`,
      `account rent ${rent} lamports, paid by ${input.from} if created`,
    )
  }
  instructions.push(
    tokenTransferChecked({
      source,
      mint,
      destination,
      owner: fromKey,
      amount: raw,
      decimals,
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
    displayLines: [
      `fee payer   ${input.from}`,
      `destination ${input.to}`,
      `amount      ${input.amount} (${raw} raw, ${decimals} dp)`,
      `mint        ${mintAddress}`,
      ...accountCreationLines,
    ],
  }
}

async function readMintDecimals(rpcUrl: string, mint: string, fetchFn: typeof fetch): Promise<number> {
  const res = await fetchFn(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [mint, { encoding: "jsonParsed", commitment: "finalized" }],
    }),
  })
  if (!res.ok) throw new VaultError("VAULT_UNREADABLE", `RPC getAccountInfo failed for mint ${mint}`)
  const json = (await res.json()) as {
    result?: { value?: { data?: { parsed?: { info?: { decimals?: number } } } } }
  }
  const decimals = json.result?.value?.data?.parsed?.info?.decimals
  if (typeof decimals !== "number") {
    throw new VaultError("VAULT_UNREADABLE", `Could not read decimals for mint ${mint}.`)
  }
  return decimals
}

export async function quoteTransferFee(
  rpcUrl: string,
  fetchFn: typeof fetch,
  from: string,
  instructions: Instruction[],
): Promise<bigint | null> {
  const rpc = createSolanaRpc(rpcUrl, fetchFn)
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

export async function signAndBroadcastTransfer(input: {
  ctx: CommandContext
  rpcUrl: string
  secret64: Uint8Array
  plan: TransferPlan
  beforeBroadcast?: (pending: { signature: string; blockhash: string }) => Promise<void>
}): Promise<{ signature: string; finalized: boolean }> {
  const rpc = createSolanaRpc(input.rpcUrl, input.ctx.deps.fetch)
  const feePayer = pubkeyFromSecret(input.secret64)
  if (encodePubkey(feePayer) !== input.plan.from) {
    throw new VaultError("VAULT_VERIFY_FAILED", "The decrypted key does not match the planned fee payer.")
  }
  const blockhash = await rpc.getLatestBlockhash()
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
  } catch {
    // A failed response cannot prove the transaction was not accepted. Keep its pending receipt.
    return { signature: sigB58, finalized: false }
  }
  for (let i = 0; i < 30; i++) {
    await input.ctx.deps.sleep(500)
    let status: Awaited<ReturnType<typeof rpc.getSignatureStatus>>
    try {
      status = await rpc.getSignatureStatus(sigB58)
    } catch {
      return { signature: sigB58, finalized: false }
    }
    if (status?.confirmationStatus === "finalized") {
      if (status.err) {
        throw new VaultError(
          "VAULT_WRITE_FAILED",
          "Transfer failed on chain. Any pending funding receipt will be reconciled on a rerun.",
        )
      }
      return { signature: sigB58, finalized: true }
    }
  }
  return { signature: sigB58, finalized: false }
}
