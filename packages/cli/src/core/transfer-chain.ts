/**
 * The chain side of a transfer out (BE-1680, spec S4 T-4, T-7, T-8), over the CLI's own vault
 * transfer code so the core builds, checks and signs exactly what `candle vault transfer` would:
 *
 *   - Solana: `planTransfer`, `quoteTransferFee` and `assertTransferAffordable`
 *     (`vault/vault-transfer-sign.ts`), then the same legacy message signed with the vault key.
 *   - Hood: `planEvmTransfer` (`vault/evm-transfer.ts`), signed with `signTransaction`.
 *   - Embedded: MCP `candle_transfer` with `clientTransferId = opId` and the Withdraw key.
 *
 * Unlike the CLI, signing and broadcasting are two steps: the card book journals the signature (or
 * hash) and this module keeps the signed bytes in `<state dir>/pending/<opId>.tx` (0600) before
 * anything is sent, so an interrupted send is read back by its signature and only ever re-sent as
 * the same bytes (T-8). The bytes never reach the journal.
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { base58, base64 } from "@scure/base"
import {
  type EvmRpc,
  EvmRpcError,
  evmAddressFromSecret,
  formatUnits,
  HOOD_CHAIN_ID,
  requiredDepth,
  sameEvmAddress,
  signTransaction,
} from "../evm-lite"
import type { SolanaClient } from "../solana-endpoint"
import {
  compileLegacyMessage,
  decodePubkey,
  definiteSendRejection,
  encodePubkey,
  pubkeyFromSecret,
  serializeSignedTransaction,
  signMessage,
  toBase64,
} from "../solana-lite"
import { ataFor, readMintProfile } from "../token-2022"
import { planEvmTransfer } from "../vault/evm-transfer"
import type { KeyEntry } from "../vault/format"
import { wipe } from "../vault/hygiene"
import {
  assertTransferAffordable,
  planTransfer,
  quoteTransferFee,
  type TransferPlan,
  USDC_MINT,
} from "../vault/vault-transfer-sign"
import type { ExecutionOutcome, Executor, SignedTransfer, TransferEngine, TransferRef, TransferStatus } from "./cards"
import { refused } from "./rpc"
import type { OpenVault, VaultWallet } from "./trading"
import { BASE_CONTRACTS, rawToDecimal, type TransferChain, type TransferParams } from "./transfer-params"
import type { Balance, VaultPreview } from "./transfers"

/** What one Solana base asset is, for the CLI's planner (which knows SOL and USDC by name). */
const SOLANA_MINTS: Record<string, string> = { USDC: USDC_MINT, CNDL: BASE_CONTRACTS.CNDL }
/** One signature at the base fee, when the RPC will not quote a message (the CLI's fallback). */
const FALLBACK_FEE_LAMPORTS = 5000n
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64

export interface ChainDeps {
  /** The profile's Solana client, built on first use (a bad RPC setting refuses a Solana send, not the core). */
  solana: () => SolanaClient
  /** The Hood RPC; `builtIn` when it is the built-in endpoint, which must answer chain id 4663. */
  hood: { rpc: EvmRpc; builtIn: boolean }
  executor: Executor
  /** `<state dir>/pending`, created 0700. */
  pendingDir: string
  /** A promoted TEE wallet's pre-sign checks (a pending sweep, the Hood operation lock), as the CLI runs them. */
  teeChecks?(entry: KeyEntry): Promise<void>
  /** A promoted TEE wallet's finalized send, reported to Candle's history. */
  reportActivity?(chain: TransferChain, id: string): Promise<void>
  /** T-3: a succeeded send's destination joins the display-only history. */
  recordDestination(chain: TransferChain, address: string): Promise<void>
}

/** The planner's asset name: `SOL`, `USDC`, or a mint for everything else on Solana. */
function solanaAsset(asset: TransferParams["asset"]): string {
  if ("symbol" in asset)
    return asset.symbol === "SOL" || asset.symbol === "USDC" ? asset.symbol : (SOLANA_MINTS[asset.symbol] as string)
  if ("mint" in asset) return asset.mint
  throw refused("INVALID_ASSET", "A Solana transfer names SOL, USDC, CNDL or a mint.")
}

function evmAsset(asset: TransferParams["asset"]): string {
  if ("symbol" in asset) return asset.symbol
  if ("token" in asset) return asset.token
  throw refused("INVALID_ASSET", "A Hood transfer names ETH, USDG or a token address.")
}

function tokenAccountAmount(data: Uint8Array): bigint {
  if (data.length < TOKEN_ACCOUNT_AMOUNT_OFFSET + 8) return 0n
  return new DataView(data.buffer, data.byteOffset + TOKEN_ACCOUNT_AMOUNT_OFFSET, 8).getBigUint64(0, true)
}

/** A vault wallet as the CLI's planners take it: the index entry's public fields. */
function keyEntryOf(wallet: VaultWallet, entry?: unknown): KeyEntry {
  return (
    (entry as KeyEntry | undefined) ??
    ({
      id: wallet.id,
      chain: wallet.chain,
      curve: wallet.chain === "evm" ? "secp256k1" : "ed25519",
      address: wallet.address,
      label: wallet.label,
      role: wallet.role,
    } as KeyEntry)
  )
}

export function createTransferChain(chainDeps: ChainDeps) {
  let client: SolanaClient | undefined
  const solana = () => {
    client ??= chainDeps.solana()
    return client
  }
  const deps = {
    ...chainDeps,
    get solana() {
      return solana()
    },
  }
  const solanaRpc = new Proxy({} as SolanaClient["rpc"], {
    get: (_target, name) => {
      const value = solana().rpc[name as keyof SolanaClient["rpc"]]
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(solana().rpc) : value
    },
  })

  /** The raw amount `max` means on Solana right now: the token account's balance, or SOL less the fee. */
  async function solanaMax(params: TransferParams): Promise<{ raw: bigint; decimals: number }> {
    const asset = solanaAsset(params.asset)
    if (asset === "SOL") {
      const balance = await deps.solana.read(() => solanaRpc.getBalance(params.source.address))
      const draft = await deps.solana.read(() =>
        planTransfer({
          from: params.source.address,
          to: params.to,
          amount: rawToDecimal(balance > 0n ? balance : 1n, 9),
          asset,
          rpc: solanaRpc,
        }),
      )
      const fee =
        (await deps.solana.read(() => quoteTransferFee(solanaRpc, draft.from, draft.instructions))) ??
        FALLBACK_FEE_LAMPORTS
      const raw = balance - fee
      if (raw <= 0n)
        throw refused(
          "TRANSFER_INSUFFICIENT_FUNDS",
          `${params.source.address} holds no SOL above the fee; max leaves nothing to send.`,
        )
      return { raw, decimals: 9 }
    }
    const profile = await deps.solana.read(() => readMintProfile(solanaRpc, asset === "USDC" ? USDC_MINT : asset))
    const source = encodePubkey(ataFor(profile, decodePubkey(params.source.address)))
    const account = await deps.solana.read(() => solanaRpc.getAccountInfo(source))
    const raw = account === null ? 0n : tokenAccountAmount(account.data)
    if (raw === 0n)
      throw refused(
        "TRANSFER_INSUFFICIENT_FUNDS",
        `${params.source.address} holds none of this token; there is nothing to send.`,
      )
    return { raw, decimals: profile.decimals }
  }

  async function solanaDecimals(asset: TransferParams["asset"]): Promise<number> {
    const name = solanaAsset(asset)
    if (name === "SOL") return 9
    return (await deps.solana.read(() => readMintProfile(solanaRpc, name === "USDC" ? USDC_MINT : name))).decimals
  }

  /** The CLI's plan for the exact params, `max` resolved against the balance now. */
  async function solanaPlan(params: TransferParams): Promise<TransferPlan> {
    const { raw, decimals } =
      "max" in params.amount
        ? await solanaMax(params)
        : { raw: BigInt(params.amount.raw), decimals: await solanaDecimals(params.asset) }
    return deps.solana.read(() =>
      planTransfer({
        from: params.source.address,
        to: params.to,
        amount: rawToDecimal(raw, decimals),
        asset: solanaAsset(params.asset),
        rpc: solanaRpc,
      }),
    )
  }

  async function evmPlan(params: TransferParams, wallet: VaultWallet, entry?: unknown) {
    const { rpc, builtIn } = deps.hood
    const planned = await planEvmTransfer(rpc, {
      from: keyEntryOf(wallet, entry),
      to: params.to,
      asset: evmAsset(params.asset),
      amount: "max" in params.amount ? "max" : rawToDecimal(BigInt(params.amount.raw), await evmDecimals(params.asset)),
      builtIn,
    })
    if ("usage" in planned) throw refused("INVALID_AMOUNT", planned.usage)
    if (wallet.role === "tee-wallet" && planned.chainId !== BigInt(HOOD_CHAIN_ID)) {
      throw refused("EVM_CHAIN_MISMATCH", `A promoted wallet signs on Hood only (chain id ${HOOD_CHAIN_ID}).`)
    }
    return planned
  }

  async function evmDecimals(asset: TransferParams["asset"]): Promise<number> {
    if ("symbol" in asset) return asset.symbol === "ETH" ? 18 : 6
    if ("token" in asset) return deps.hood.rpc.erc20Decimals(asset.token)
    throw refused("INVALID_ASSET", "A Hood transfer names ETH, USDG or a token address.")
  }

  /**
   * Where a sent transfer stands. `expired: true` is read as "it can no longer land" and settles
   * `failed`, so it is only returned after a second look: a transaction admitted between the two
   * reads (or a load-balanced node that is ahead) must not be recorded as unsent. A read that
   * throws propagates and never settles `failed`.
   */
  async function readStatus(ref: TransferRef): Promise<TransferStatus> {
    if (ref.id === undefined) return { state: "not_found", expired: false }
    if (ref.chain === "solana") {
      const solanaStatus = async (): Promise<TransferStatus | null> => {
        const status = await solanaRpc.getSignatureStatus(ref.id as string)
        if (status?.confirmationStatus === "finalized") {
          return status.err
            ? { state: "failed", reason: "The transfer failed on chain. Nothing moved." }
            : { state: "finalized" }
        }
        return status ? { state: "pending" } : null
      }
      const first = await solanaStatus()
      if (first) return first
      const valid = ref.blockhash ? await solanaRpc.isBlockhashValid(ref.blockhash) : true
      if (valid) return { state: "not_found", expired: false }
      return (await solanaStatus()) ?? { state: "not_found", expired: true }
    }
    const hoodStatus = async (): Promise<TransferStatus | null> => {
      const receipt = await deps.hood.rpc.getTransactionReceipt(ref.id as string)
      if (receipt === null) return null
      if (receipt.status === 0) return { state: "failed", reason: "The transfer reverted on chain." }
      // The CLI's rule: confirmed at the chain's required depth, not at the first receipt.
      const head = await deps.hood.rpc.blockNumber()
      return head - receipt.blockNumber + 1n >= BigInt(requiredDepth(BigInt(HOOD_CHAIN_ID)))
        ? { state: "finalized" }
        : { state: "pending" }
    }
    const first = await hoodStatus()
    if (first) return first
    if (ref.nonce !== undefined) {
      const latest = await deps.hood.rpc.getTransactionCount(ref.from, "latest")
      if (latest > BigInt(ref.nonce)) return (await hoodStatus()) ?? { state: "not_found", expired: true }
    }
    return { state: "not_found", expired: false }
  }

  const pendingPath = (opId: string) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(opId)) throw new Error(`Not an operation id: ${opId}`)
    return join(deps.pendingDir, `${opId}.tx`)
  }

  const engine: TransferEngine & {
    preview(params: TransferParams, wallet: VaultWallet): Promise<VaultPreview>
    balances(chain: TransferChain, address: string): Promise<Balance[] | undefined>
    decimals(chain: TransferChain, asset: TransferParams["asset"]): Promise<number | undefined>
  } = {
    async preview(params, wallet) {
      if (params.chain === "solana") {
        const plan = await solanaPlan(params)
        const fee = await deps.solana.read(() => quoteTransferFee(solanaRpc, plan.from, plan.instructions))
        // BE-1551: a key that cannot pay refuses here, before any card.
        await assertTransferAffordable(deps.solana, plan, fee)
        return {
          lines: plan.displayLines,
          ...(fee !== null ? { feeEstimate: `${fee} lamports` } : {}),
          ...("max" in params.amount ? { maxRaw: plan.amountRaw.toString() } : {}),
        }
      }
      const plan = await evmPlan(params, wallet)
      return {
        lines: plan.displayLines,
        feeEstimate: `${formatUnits(plan.feeCap, 18)} ETH at most`,
        ...("max" in params.amount ? { maxRaw: plan.amountRaw.toString() } : {}),
      }
    },

    async balances(chain, address) {
      if (chain === "solana") {
        const lamports = await deps.solana.read(() => solanaRpc.getBalance(address))
        return [{ asset: "SOL", contract: BASE_CONTRACTS.SOL, raw: lamports.toString(), decimals: 9 }]
      }
      const wei = await deps.hood.rpc.getBalance(address)
      return [{ asset: "ETH", contract: BASE_CONTRACTS.ETH, raw: wei.toString(), decimals: 18 }]
    },

    async decimals(chain, asset) {
      return chain === "solana" ? solanaDecimals(asset) : evmDecimals(asset)
    },

    async signVault(params, vault: OpenVault) {
      const wallet = vault.wallets?.find(
        (candidate) => candidate.id === params.source.walletId && candidate.address === params.source.address,
      )
      if (wallet === undefined || vault.signingKey === undefined) {
        throw refused("INVALID_SOURCE", "That wallet is not in the vault that opened. Nothing was signed.")
      }
      const entry = (vault as OpenVault & { entry?(id: string): unknown }).entry?.(wallet.id)
      if (wallet.role === "tee-wallet" && entry !== undefined) await deps.teeChecks?.(entry as KeyEntry)
      if (params.chain === "solana") {
        // Planned again with the same params: a fresh blockhash, and `max` read now.
        const plan = await solanaPlan(params)
        const fee = await deps.solana.read(() => quoteTransferFee(solanaRpc, plan.from, plan.instructions))
        await assertTransferAffordable(deps.solana, plan, fee)
        const secret = await vault.signingKey(wallet.id)
        try {
          const feePayer = pubkeyFromSecret(secret)
          if (encodePubkey(feePayer) !== plan.from) {
            throw refused(
              "VAULT_VERIFY_FAILED",
              "The decrypted key does not match the planned fee payer. Nothing was signed.",
            )
          }
          const blockhash = await deps.solana.read(() => solanaRpc.getLatestBlockhash())
          const message = compileLegacyMessage({
            feePayer,
            recentBlockhash: blockhash,
            instructions: plan.instructions,
          })
          const signature = signMessage(message, secret)
          return {
            chain: "solana",
            id: base58.encode(signature),
            wire: toBase64(serializeSignedTransaction(message, signature)),
            from: plan.from,
            blockhash,
            amountRaw: plan.amountRaw.toString(),
          } satisfies SignedTransfer
        } finally {
          wipe(secret)
        }
      }
      const plan = await evmPlan(params, wallet, entry)
      const secret = await vault.signingKey(wallet.id)
      try {
        if (!sameEvmAddress(evmAddressFromSecret(secret), wallet.address)) {
          throw refused(
            "VAULT_VERIFY_FAILED",
            "The decrypted key does not match the planned sender. Nothing was signed.",
          )
        }
        const signed = signTransaction(plan.tx, secret)
        return {
          chain: "hood",
          id: signed.hash,
          wire: base64.encode(signed.raw),
          from: wallet.address,
          nonce: plan.tx.nonce.toString(),
          amountRaw: plan.amountRaw.toString(),
        } satisfies SignedTransfer
      } finally {
        wipe(secret)
      }
    },

    async keepPending(opId, signed) {
      await mkdir(deps.pendingDir, { recursive: true, mode: 0o700 })
      await chmod(deps.pendingDir, 0o700)
      const path = pendingPath(opId)
      const temp = `${path}.tmp`
      await writeFile(temp, `${JSON.stringify(signed)}\n`, { mode: 0o600 })
      await rename(temp, path)
    },

    async readPending(opId) {
      try {
        const parsed = JSON.parse(await readFile(pendingPath(opId), "utf8")) as SignedTransfer
        return typeof parsed?.id === "string" && typeof parsed.wire === "string" ? parsed : undefined
      } catch {
        return undefined
      }
    },

    async dropPending(opId) {
      await rm(pendingPath(opId), { force: true })
    },

    async broadcast(signed) {
      if (signed.chain === "solana") {
        try {
          await solanaRpc.sendTransaction(signed.wire)
          return { ok: true }
        } catch (error) {
          const definite = definiteSendRejection(error)
          return {
            ok: false,
            definite: definite !== null,
            code: definite ? "TRANSFER_REJECTED" : "BROADCAST_UNCERTAIN",
            message: error instanceof Error ? error.message : String(error),
          }
        }
      }
      try {
        await deps.hood.rpc.sendRawTransaction(base64.decode(signed.wire))
        return { ok: true }
      } catch (error) {
        // An EVM answer never proves the bytes cannot land (the CLI's `broadcast`): read it back.
        const message = error instanceof EvmRpcError || error instanceof Error ? error.message : String(error)
        if (message.toLowerCase().includes("already known")) return { ok: true }
        return { ok: false, definite: false, code: "BROADCAST_UNCERTAIN", message }
      }
    },

    status(ref: TransferRef): Promise<TransferStatus> {
      return readStatus(ref)
    },

    async sendEmbedded(params, clientTransferId, withdrawKey): Promise<ExecutionOutcome> {
      const asset = params.asset
      return deps.executor.execute(
        "candle_transfer",
        {
          chain: params.chain,
          ...("symbol" in asset ? { asset: asset.symbol } : { mint: "mint" in asset ? asset.mint : asset.token }),
          amountRaw: "max" in params.amount ? "max" : params.amount.raw,
          to: params.to,
          clientTransferId,
        },
        withdrawKey,
      )
    },

    async reportActivity(params, ref) {
      if (ref.id !== undefined) await deps.reportActivity?.(params.chain, ref.id)
    },

    async recordDestination(params) {
      await deps.recordDestination(params.chain, params.to)
    },
  }
  return engine
}
