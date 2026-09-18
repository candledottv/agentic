/** Durable funding evidence shared by vault fund and vault transfer. */
import type { CommandContext } from "../deps"
import { createSolanaRpc } from "../solana-lite"
import { resolvePending } from "../sweep-pending"
import { VaultError } from "./errors"
import { commitVault, type UnlockedVault } from "./store"

export interface FundingReceipt {
  signature: string
  blockhash?: string
  from?: string
  amount: string
  asset: string
  amountRaw: string
  at: string
  finalized: boolean
  outcome?: "failed" | "expired"
}

function readReceipt(value: unknown): FundingReceipt {
  if (
    value === null ||
    typeof value !== "object" ||
    !("signature" in value) ||
    typeof value.signature !== "string" ||
    !("finalized" in value) ||
    typeof value.finalized !== "boolean"
  ) {
    throw new VaultError("VAULT_INDEX_INVALID", "Malformed funding receipt; refusing to sign another transfer.")
  }
  return value as FundingReceipt
}

export async function saveFundingReceipt(
  vault: UnlockedVault,
  teeId: string,
  receipt: FundingReceipt,
  ctx: CommandContext,
): Promise<void> {
  const entries = vault.index.entries.map((entry) => {
    if (entry.id !== teeId || !entry.tee) return entry
    const prior = entry.tee.fundingReceipts ?? []
    const exists = prior.some((value) => readReceipt(value).signature === receipt.signature)
    const fundingReceipts = exists
      ? prior.map((value) => (readReceipt(value).signature === receipt.signature ? receipt : value))
      : [...prior, receipt]
    return { ...entry, tee: { ...entry.tee, fundingReceipts } }
  })
  const next = await commitVault(vault, { index: { ...vault.index, entries } }, ctx.deps)
  // A second commit must compare against the pending write, not the original file generation.
  Object.assign(vault, next)
}

/**
 * Null means no pending funding. Otherwise this invocation only reconciles existing evidence;
 * even a newly finalized receipt ends the command, so retrying cannot accidentally fund twice.
 * Legacy unconfirmed receipts have no blockhash; they can settle but cannot prove expiry.
 */
export async function reconcileFundingReceipts(
  vault: UnlockedVault,
  addresses: string[],
  rpcUrl: string,
  ctx: CommandContext,
): Promise<number | null> {
  const rpc = createSolanaRpc(rpcUrl, ctx.deps.fetch)
  const results: Array<{ signature: string; outcome: string }> = []
  for (const entry of vault.index.entries) {
    if (!entry.tee) continue
    for (const value of entry.tee.fundingReceipts ?? []) {
      const receipt = readReceipt(value)
      if (receipt.finalized || receipt.outcome) continue
      const from = receipt.from ?? entry.tee.vaultDestination
      if (!addresses.includes(entry.address) && (from === undefined || !addresses.includes(from))) continue
      const resolution = await resolvePending(
        {
          status: (signature) => rpc.getSignatureStatus(signature),
          blockhashValid: (blockhash) => (receipt.blockhash ? rpc.isBlockhashValid(blockhash) : Promise.resolve(true)),
        },
        { signature: receipt.signature, blockhash: receipt.blockhash ?? "" },
      )
      if (resolution.kind === "finalized") {
        await saveFundingReceipt(vault, entry.id, { ...receipt, finalized: true }, ctx)
      } else if (resolution.kind === "failed" || resolution.kind === "expired") {
        await saveFundingReceipt(vault, entry.id, { ...receipt, outcome: resolution.kind }, ctx)
      }
      // Never print RPC error details: they may contain the credential-bearing endpoint.
      results.push({ signature: receipt.signature, outcome: resolution.kind })
    }
  }
  if (results.length === 0) return null
  const finalized = results.every((result) => result.outcome === "finalized")
  if (ctx.json) {
    ctx.deps.stdout.write(`${JSON.stringify({ ok: finalized, reconciled: results, signed: false })}\n`)
  } else {
    for (const result of results) ctx.deps.stdout.write(`Funding ${result.signature}: ${result.outcome}.\n`)
    ctx.deps.stdout.write(
      "No new transfer signed. Run again only if you intend a new transfer after pending funding resolves.\n",
    )
  }
  return finalized ? 0 : 3
}
