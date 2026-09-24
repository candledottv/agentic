/**
 * Ember Phase 4a (BE-350, spec `2026-09-24-ember-phase-4a-evm-vault-keys-design.md`, D5, D6):
 * `candle vault transfer` from an EVM `role: "vault"` key.
 *
 * The EVM primitives (derivation, RLP, the two shapes, signing, the RPC client) live in
 * `evm-lite.ts` and nowhere else; this file is the command flow around them, the counterpart of
 * `vault-transfer-sign.ts` for Solana. It imports no EVM library.
 *
 * D5's order is the shape of `runEvmTransfer`: resolve `--from` → read the chain id → resolve the
 * asset → read the pending nonce and the fees → estimate gas → set a native `max` → build → display
 * → the recipient's last six typed → the factor again → RE-READ the chain id and the pending nonce
 * → refuse if either moved → sign → broadcast → wait for the receipt. The re-read is after the
 * factor and before any signature, because the factor prompt can take minutes; there is no read of
 * the chain id after signing, because the type-2 envelope already binds the id that was signed.
 *
 * D6's table is the second half: every pre-sign refusal is exit 1 with no signature, and every
 * post-sign outcome names the hash the CLI computed locally before it sent anything. `confirmed`
 * means DEPTH-confirmed (1 block on Hood, 2 elsewhere), never Ethereum finality; the `--json`
 * document says so with `depth` and `finalized: false`, so a caller cannot read EVM exit 0 as
 * Solana finality.
 */
import type { CommandContext } from "../deps"
import {
  buildErc20Transfer,
  buildNativeTransfer,
  checkEvmAddress,
  DEFAULT_HOOD_RPC_URL,
  decodeErc20Transfer,
  type EvmReceipt,
  type EvmRpc,
  EvmRpcError,
  type EvmTransaction,
  evmAddressFromSecret,
  formatUnits,
  gasWithHeadroom,
  HOOD_CHAIN_ID,
  HOOD_USDG_ADDRESS,
  looksLikeEvmAddress,
  NATIVE_DECIMALS,
  parseUnits,
  quoteFees,
  requiredDepth,
  rpcHostOf,
  sameEvmAddress,
  signTransaction,
  toChecksumAddress,
} from "../evm-lite"
import { VaultError } from "./errors"
import type { KeyEntry } from "./format"
import { wipe } from "./hygiene"

/** D6: how long the CLI waits for a receipt at the required depth before it reports exit 3. */
export const EVM_RECEIPT_WAIT_MS = 120_000
/** How often the receipt is polled inside that wait. */
export const EVM_RECEIPT_POLL_MS = 2_000

export type EvmTransferStatus = "confirmed" | "reverted" | "uncertain"

/** A resolved asset: the native coin, or an ERC-20 whose decimals and symbol were read from the contract. */
export interface ResolvedEvmAsset {
  kind: "native" | "erc20"
  /** `ETH`, `USDG`, or the contract's symbol; the display name. */
  symbol: string
  decimals: number
  /** The contract, for an ERC-20. */
  token?: string
}

/** What is displayed before the last-six prompt (D5), and what the factor prompt names. */
export interface EvmTransferPlan {
  chainId: bigint
  hood: boolean
  from: KeyEntry
  asset: ResolvedEvmAsset
  /** The human recipient: `to` for native, the calldata recipient for an ERC-20. */
  recipient: string
  amountRaw: bigint
  amount: string
  tx: EvmTransaction
  feeCap: bigint
  displayLines: string[]
}

export interface EvmTransferInput {
  ctx: CommandContext
  rpcUrl: string
  /** Whether `rpcUrl` is the built-in Hood RPC, which must answer chain id 4663 (D1). */
  builtIn: boolean
  from: KeyEntry
  to: string
  amount: string
  asset: string
  /** The last-six prompt (CC-08), shared with the Solana path. */
  confirmLastSix: (address: string, what: string) => Promise<void>
  /** The factor presented again before signing (ED-10). */
  confirmFactor: (what: string) => Promise<void>
  /** Decrypts the `--from` key's 32-byte scalar. The transfer owns and zeroes it. */
  decryptSecret: () => Promise<Uint8Array>
  /** A usage refusal (exit 2), for a flag value that is wrong rather than a state that is refused. */
  usage: (line: string) => number
  writeJson: (value: unknown) => void
}

function refuse(
  code: VaultError["code"],
  message: string,
  opts: { suggestion?: string; details?: Record<string, string> } = {},
) {
  return new VaultError(code, message, { suggestion: opts.suggestion ?? "Nothing was signed.", ...opts })
}

/**
 * D3's chain-family check, before any read: a destination that is not an EVM address for an EVM
 * key is `TRANSFER_CHAIN_MISMATCH`; one that is `0x` but not twenty bytes, or mixed case with a
 * failing EIP-55 checksum, is `EVM_DESTINATION_INVALID`. Returns the checksummed spelling.
 */
export function checkEvmDestination(to: string, from: KeyEntry): string {
  if (!to.startsWith("0x")) {
    throw refuse(
      "TRANSFER_CHAIN_MISMATCH",
      `${to} is not an EVM address, and ${from.label || from.address} is an EVM key.`,
      { suggestion: "Nothing was signed. An EVM key sends to a 0x address; a Solana key sends to a Solana address." },
    )
  }
  const checked = checkEvmAddress(to)
  if (!checked.ok) {
    throw refuse("EVM_DESTINATION_INVALID", `${to} is not a valid EVM address: ${checked.reason}.`)
  }
  if (sameEvmAddress(checked.address, from.address)) {
    throw refuse("EVM_SELF_TRANSFER", `${to} is ${from.label || from.address}'s own address.`)
  }
  return checked.address
}

/** The Solana side of the same rule: an EVM address given to a Solana key. */
export function assertSolanaDestination(to: string, from: KeyEntry): void {
  if (!looksLikeEvmAddress(to)) return
  throw refuse(
    "TRANSFER_CHAIN_MISMATCH",
    `${to} is an EVM address, and ${from.label || from.address} is a Solana key.`,
    { suggestion: "Nothing was signed. A Solana key sends to a Solana address; an EVM key sends to a 0x address." },
  )
}

/**
 * D1's asset rule. `ETH` is the native asset on every chain. `USDG` is Hood's, on chain id 4663
 * only; anywhere else an ERC-20 is its contract address. Decimals and symbol are read from the
 * contract, never from a table: `EVM_TOKEN_UNREADABLE` when it does not answer `decimals`.
 */
export async function resolveEvmAsset(
  rpc: EvmRpc,
  asset: string,
  chainId: bigint,
): Promise<ResolvedEvmAsset | { usage: string }> {
  const upper = asset.toUpperCase()
  if (upper === "ETH") return { kind: "native", symbol: "ETH", decimals: NATIVE_DECIMALS }
  let token: string
  if (upper === "USDG") {
    if (chainId !== BigInt(HOOD_CHAIN_ID)) {
      return {
        usage: `USDG is named on Hood (chain id ${HOOD_CHAIN_ID}) only; this RPC answered chain id ${chainId}. Name the token by its contract address.`,
      }
    }
    token = toChecksumAddress(HOOD_USDG_ADDRESS)
  } else {
    const checked = checkEvmAddress(asset)
    if (!checked.ok)
      return {
        usage: `--asset must be ETH, USDG (on Hood), or an ERC-20 contract address: ${asset} is ${checked.reason}.`,
      }
    token = checked.address
  }
  let decimals: number
  try {
    decimals = await rpc.erc20Decimals(token)
  } catch (error) {
    throw refuse(
      "EVM_TOKEN_UNREADABLE",
      `${token} did not answer decimals(): ${error instanceof Error ? error.message : String(error)}`,
      { suggestion: "Nothing was signed. Check the contract address, and that this RPC serves the chain it lives on." },
    )
  }
  const symbol = upper === "USDG" ? "USDG" : ((await rpc.erc20Symbol(token)) ?? `${token.slice(0, 10)}…`)
  return { kind: "erc20", symbol, decimals, token }
}

function nativeName(hood: boolean, chainId: bigint): string {
  return hood ? "ETH" : `ETH on chain ${chainId}`
}

/** The display block (D5), in the order the operator reads it. */
export function evmDisplayLines(plan: EvmTransferPlan): string[] {
  const { tx, asset, hood, chainId } = plan
  const native = nativeName(hood, chainId)
  const lines = [
    `chain       ${chainId}${hood ? " (Hood)" : ""}`,
    `from        ${plan.from.label}  ${plan.from.address}`,
  ]
  if (asset.kind === "native") {
    lines.push(`to          ${tx.to}`)
    lines.push(`amount      ${plan.amount} ${native} = ${plan.amountRaw} wei`)
  } else {
    lines.push(`to          ${tx.to}  (the ${asset.symbol} contract, ${asset.decimals} dp)`)
    lines.push(`recipient   ${plan.recipient}  (decoded from transfer(address,uint256))`)
    lines.push(`amount      ${plan.amount} ${asset.symbol} = ${plan.amountRaw} raw`)
  }
  lines.push(`gas limit   ${tx.gas}`)
  lines.push(`max fee     ${tx.maxFeePerGas} wei/gas (priority ${tx.maxPriorityFeePerGas} wei/gas)`)
  lines.push(`fee cap     ${formatUnits(plan.feeCap, NATIVE_DECIMALS)} ${native} (gas × max fee)`)
  lines.push(`nonce       ${tx.nonce}`)
  return lines
}

/**
 * Everything before the prompts (D5): the reads, the refusals, the built transaction and its
 * display. Returns a usage exit code for a flag value that is wrong rather than a refusal.
 */
export async function planEvmTransfer(
  rpc: EvmRpc,
  input: Pick<EvmTransferInput, "from" | "to" | "amount" | "asset" | "builtIn">,
): Promise<EvmTransferPlan | { usage: string }> {
  const to = checkEvmDestination(input.to, input.from)
  const chainId = await rpc.chainId()
  if (input.builtIn && chainId !== BigInt(HOOD_CHAIN_ID)) {
    throw refuse("EVM_CHAIN_MISMATCH", `The built-in Hood RPC answered chain id ${chainId}, not ${HOOD_CHAIN_ID}.`, {
      suggestion: "Nothing was signed. Pass --rpc-url for another chain; the built-in endpoint is Hood's only.",
    })
  }
  const hood = chainId === BigInt(HOOD_CHAIN_ID)
  const asset = await resolveEvmAsset(rpc, input.asset, chainId)
  if ("usage" in asset) return asset
  const max = input.amount.toLowerCase() === "max"
  if (asset.kind === "erc20" && asset.token !== undefined && sameEvmAddress(to, asset.token)) {
    throw refuse(
      "EVM_RECIPIENT_IS_TOKEN",
      `${to} is the ${asset.symbol} contract itself; sending it its own tokens is a loss.`,
    )
  }

  let amountRaw = 0n
  if (!max) {
    const parsed = parseUnits(input.amount, asset.decimals)
    if (!parsed.ok && parsed.reason === "precision") {
      throw refuse(
        "EVM_AMOUNT_PRECISION",
        `${input.amount} has more decimal places than ${asset.symbol}'s ${asset.decimals}.`,
      )
    }
    if (!parsed.ok) return { usage: `--amount must be a positive decimal or max; ${input.amount} is neither.` }
    amountRaw = parsed.raw
  }

  const nonce = await rpc.getTransactionCount(input.from.address, "pending")
  const fees = await quoteFees(rpc)
  const nativeBalance = await rpc.getBalance(input.from.address)

  if (asset.kind === "erc20" && asset.token !== undefined) {
    if (max) {
      amountRaw = await rpc.erc20BalanceOf(asset.token, input.from.address)
      if (amountRaw === 0n) {
        throw new VaultError(
          "VAULT_INDEX_INVALID",
          `${input.from.label} holds no ${asset.symbol}; there is nothing to send.`,
        )
      }
    }
    const draft = buildErc20Transfer({
      chainId,
      nonce,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      maxFeePerGas: fees.maxFeePerGas,
      gas: 0n,
      token: asset.token,
      recipient: to,
      amount: amountRaw,
    })
    const gas = gasWithHeadroom(await estimate(rpc, input.from.address, draft))
    const tx = { ...draft, gas }
    const feeCap = gas * tx.maxFeePerGas
    if (nativeBalance < feeCap) {
      throw refuse(
        "EVM_INSUFFICIENT_FOR_FEES",
        `${input.from.label} holds ${formatUnits(nativeBalance, NATIVE_DECIMALS)} ${nativeName(hood, chainId)}, below the fee cap of ${formatUnits(feeCap, NATIVE_DECIMALS)}.`,
      )
    }
    const plan: EvmTransferPlan = {
      chainId,
      hood,
      from: input.from,
      asset,
      recipient: to,
      amountRaw,
      amount: formatUnits(amountRaw, asset.decimals),
      tx,
      feeCap,
      displayLines: [],
    }
    plan.displayLines = evmDisplayLines(plan)
    return plan
  }

  // Native. For `max`, gas is estimated at value 0 before the value is known (D5), then
  // `value = balance − gas × maxFeePerGas`; the display shows the value that will be signed.
  const draft = buildNativeTransfer({
    chainId,
    nonce,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    maxFeePerGas: fees.maxFeePerGas,
    gas: 0n,
    to,
    value: max ? 0n : amountRaw,
  })
  // A non-max native amount above the balance never reaches `eth_estimateGas`. Real nodes reject
  // that estimate ("insufficient funds for gas * price + value"), which would otherwise surface
  // as VAULT_UNREADABLE. The value + fee cap check below still runs after a successful estimate.
  if (!max && nativeBalance < amountRaw) {
    throw refuse(
      "EVM_INSUFFICIENT_FOR_FEES",
      `${input.from.label} holds ${formatUnits(nativeBalance, NATIVE_DECIMALS)} ${nativeName(hood, chainId)}, below the amount of ${formatUnits(amountRaw, NATIVE_DECIMALS)}.`,
    )
  }
  const gas = gasWithHeadroom(await estimate(rpc, input.from.address, draft))
  const feeCap = gas * draft.maxFeePerGas
  let value = amountRaw
  if (max) {
    value = nativeBalance - feeCap
    if (value <= 0n) {
      throw refuse(
        "EVM_INSUFFICIENT_FOR_FEES",
        `${input.from.label} holds ${formatUnits(nativeBalance, NATIVE_DECIMALS)} ${nativeName(hood, chainId)}, not above the fee cap of ${formatUnits(feeCap, NATIVE_DECIMALS)}; max leaves nothing to send.`,
      )
    }
  } else if (nativeBalance < value + feeCap) {
    throw refuse(
      "EVM_INSUFFICIENT_FOR_FEES",
      `${input.from.label} holds ${formatUnits(nativeBalance, NATIVE_DECIMALS)} ${nativeName(hood, chainId)}, below the amount plus the fee cap of ${formatUnits(value + feeCap, NATIVE_DECIMALS)}.`,
    )
  }
  const tx = { ...draft, gas, value }
  const plan: EvmTransferPlan = {
    chainId,
    hood,
    from: input.from,
    asset,
    recipient: to,
    amountRaw: value,
    amount: formatUnits(value, NATIVE_DECIMALS),
    tx,
    feeCap,
    displayLines: [],
  }
  plan.displayLines = evmDisplayLines(plan)
  return plan
}

async function estimate(rpc: EvmRpc, from: string, tx: EvmTransaction): Promise<bigint> {
  try {
    return await rpc.estimateGas({ from, to: tx.to, value: tx.value, data: tx.data })
  } catch (error) {
    throw new VaultError(
      "VAULT_UNREADABLE",
      `Could not estimate gas: ${error instanceof Error ? error.message : String(error)}`,
      { suggestion: "Nothing was signed. A revert here usually means the balance does not cover the amount." },
    )
  }
}

export function displayEvmTransferPlan(ctx: CommandContext, plan: EvmTransferPlan): void {
  ctx.deps.stdout.write("Decoded EVM transfer (local signing only):\n")
  for (const line of plan.displayLines) ctx.deps.stdout.write(`  ${line}\n`)
}

/** What the factor prompt names (ED-10): amount, asset and the human recipient. */
export function evmFactorPrompt(plan: EvmTransferPlan): string {
  return `sign transfer of ${plan.amount} ${plan.asset.symbol} to ${plan.recipient}${plan.hood ? " on Hood" : ` on chain ${plan.chainId}`}`
}

interface Outcome {
  status: EvmTransferStatus
  exit: 0 | 3
  line: string
  blockNumber?: bigint
}

/**
 * D6 after the receipt is read: `status` 0 is `EVM_TRANSFER_REVERTED` (exit 1, hash in `details`);
 * `status` 1 at the required depth is confirmed. A receipt short of depth is not an outcome yet.
 */
function judgeReceipt(
  receipt: EvmReceipt,
  head: bigint,
  depth: number,
  hash: string,
  chainId: bigint,
): Outcome | undefined {
  if (receipt.status === 0) {
    throw new VaultError(
      "EVM_TRANSFER_REVERTED",
      `Transaction ${hash} reverted in block ${receipt.blockNumber}; the fee was spent.`,
      {
        suggestion: "Nothing else was signed. Read the transaction on an explorer before sending again.",
        details: { hash, chainId: chainId.toString(), blockNumber: receipt.blockNumber.toString(), status: "reverted" },
      },
    )
  }
  const reached = head - receipt.blockNumber + 1n
  if (reached < BigInt(depth)) return undefined
  return {
    status: "confirmed",
    exit: 0,
    blockNumber: receipt.blockNumber,
    line: `Confirmed ${hash} in block ${receipt.blockNumber}, ${reached} block${reached === 1n ? "" : "s"} deep (depth ${depth}, not finality).`,
  }
}

/**
 * Waits up to `EVM_RECEIPT_WAIT_MS` for a receipt at the required depth. A read that throws is a
 * poll that answered nothing; the wait goes on. At the deadline: a receipt seen is "short of depth",
 * none is "uncertain"; both exit 3 with the hash.
 */
async function awaitReceipt(rpc: EvmRpc, ctx: CommandContext, hash: string, chainId: bigint): Promise<Outcome> {
  const depth = requiredDepth(chainId)
  const deadline = ctx.deps.now() + EVM_RECEIPT_WAIT_MS
  let seen: EvmReceipt | undefined
  for (;;) {
    try {
      const receipt = await rpc.getTransactionReceipt(hash)
      if (receipt !== null) {
        seen = receipt
        const outcome = judgeReceipt(receipt, await rpc.blockNumber(), depth, hash, chainId)
        if (outcome !== undefined) return outcome
      }
    } catch (error) {
      if (error instanceof VaultError) throw error
    }
    if (ctx.deps.now() >= deadline) break
    await ctx.deps.sleep(EVM_RECEIPT_POLL_MS)
  }
  if (seen !== undefined) {
    return {
      status: "uncertain",
      exit: 3,
      blockNumber: seen.blockNumber,
      line: `Submitted ${hash}: it is in block ${seen.blockNumber} but not yet ${depth} block${depth === 1 ? "" : "s"} deep after ${EVM_RECEIPT_WAIT_MS / 1000} s. Do not resend; check the hash on an explorer.`,
    }
  }
  return {
    status: "uncertain",
    exit: 3,
    line: `Submitted ${hash}; no receipt after ${EVM_RECEIPT_WAIT_MS / 1000} s. It may still land: do not resend blindly; check the hash on an explorer first.`,
  }
}

/**
 * D6 for `eth_sendRawTransaction`. The hash is known locally, so none of these is a refusal or "no
 * signature": a transport failure and `already known` are exit 3 with the hash; `nonce too low`
 * reads the receipt first and follows it, or is `EVM_NONCE_STALE` (exit 1, hash in `details`) with
 * no receipt. Any other RPC error is reported as uncertain with the node's message, because the
 * CLI cannot prove from a refusal message alone that the transaction is not in flight.
 */
async function broadcast(
  rpc: EvmRpc,
  ctx: CommandContext,
  raw: Uint8Array,
  hash: string,
  chainId: bigint,
): Promise<Outcome> {
  try {
    await rpc.sendRawTransaction(raw)
  } catch (error) {
    if (!(error instanceof EvmRpcError)) throw error
    const message = error.message.toLowerCase()
    if (error.kind === "transport") {
      return {
        status: "uncertain",
        exit: 3,
        line: `Submitted ${hash}, but the RPC did not answer eth_sendRawTransaction (${error.message}). It may still land: do not resend blindly; check the hash on an explorer first.`,
      }
    }
    if (message.includes("already known")) {
      return {
        status: "uncertain",
        exit: 3,
        line: `Submitted ${hash}: the RPC already knows it, so it is in flight. Do not resend; check the hash on an explorer.`,
      }
    }
    if (message.includes("nonce too low")) {
      let receipt: EvmReceipt | null = null
      try {
        receipt = await rpc.getTransactionReceipt(hash)
      } catch {
        receipt = null
      }
      if (receipt !== null) {
        // A receipt follows the receipt rules. `blockNumber` failing here must not escape as
        // VAULT_UNREADABLE: the hash is already known, and `awaitReceipt` treats a failed head
        // read as a poll that answered nothing, then exits 3 with the hash.
        let head: bigint
        try {
          head = await rpc.blockNumber()
        } catch {
          return awaitReceipt(rpc, ctx, hash, chainId)
        }
        const outcome = judgeReceipt(receipt, head, requiredDepth(chainId), hash, chainId)
        if (outcome !== undefined) return outcome
        return awaitReceipt(rpc, ctx, hash, chainId)
      }
      throw new VaultError(
        "EVM_NONCE_STALE",
        `The RPC refused ${hash}: nonce too low, and it has no receipt for that hash. Another transaction used this nonce.`,
        {
          suggestion:
            "Nothing was resent. Run the transfer again; it reads the pending nonce afresh. The CLI never re-signs on its own.",
          details: { hash, chainId: chainId.toString() },
        },
      )
    }
    return {
      status: "uncertain",
      exit: 3,
      line: `Submitted ${hash}, and the RPC answered: ${error.message}. The CLI cannot tell from that whether it is in flight: do not resend blindly; check the hash on an explorer first.`,
    }
  }
  return awaitReceipt(rpc, ctx, hash, chainId)
}

/** The whole D5 flow for one EVM transfer, returning the exit code. */
export async function runEvmTransfer(input: EvmTransferInput, rpc: EvmRpc): Promise<number> {
  const { ctx } = input
  const { deps } = ctx
  // The destination and self checks need no read, so they come before the host line.
  checkEvmDestination(input.to, input.from)
  // The host only, never the URL (a provider URL can carry a key), before the first request (D3).
  deps.stderr.write(
    `Reading chain id, nonce, fees and balances for ${input.from.label} from ${rpcHostOf(input.rpcUrl)}${input.rpcUrl === DEFAULT_HOOD_RPC_URL ? " (the built-in Hood RPC)" : ""}.\n`,
  )
  const planned = await planEvmTransfer(rpc, input)
  if ("usage" in planned) return input.usage(planned.usage)
  const plan = planned

  displayEvmTransferPlan(ctx, plan)
  await input.confirmLastSix(plan.recipient, plan.asset.kind === "erc20" ? "the token recipient" : "the destination")
  await input.confirmFactor(evmFactorPrompt(plan))

  // D6: the pause on the factor is where a nonce or a chain id moves. Re-read both, refuse on
  // either, and only then sign. Nothing is read again after the signature.
  const chainIdAgain = await rpc.chainId()
  if (chainIdAgain !== plan.chainId) {
    throw refuse(
      "EVM_CHAIN_MISMATCH",
      `The RPC answered chain id ${chainIdAgain} after the factor, but ${plan.chainId} was displayed.`,
    )
  }
  const nonceAgain = await rpc.getTransactionCount(plan.from.address, "pending")
  if (nonceAgain !== plan.tx.nonce) {
    throw refuse(
      "EVM_NONCE_STALE",
      `The pending nonce is ${nonceAgain} after the factor, but ${plan.tx.nonce} was displayed; another transaction moved it.`,
      { suggestion: "Nothing was signed. Run the transfer again; it reads the pending nonce afresh." },
    )
  }

  const secret = await input.decryptSecret()
  let signed: ReturnType<typeof signTransaction>
  try {
    if (!sameEvmAddress(evmAddressFromSecret(secret), plan.from.address)) {
      throw new VaultError("VAULT_VERIFY_FAILED", "The decrypted key does not match the planned sender.")
    }
    signed = signTransaction(plan.tx, secret)
  } finally {
    wipe(secret)
  }

  const outcome = await broadcast(rpc, ctx, signed.raw, signed.hash, plan.chainId)
  if (ctx.json) {
    input.writeJson({
      ok: outcome.status === "confirmed",
      chainId: Number(plan.chainId),
      hash: signed.hash,
      status: outcome.status,
      ...(outcome.blockNumber !== undefined ? { blockNumber: outcome.blockNumber.toString() } : {}),
      // `confirmed` is depth-confirmed, not Ethereum finality: `depth` is the depth required on
      // this chain and `finalized` is always false, so a caller cannot treat exit 0 as Solana's.
      depth: requiredDepth(plan.chainId),
      finalized: false,
      from: plan.from.address,
      to: plan.tx.to,
      recipient: plan.recipient,
      amount: plan.amount,
      asset: plan.asset.symbol,
      amountRaw: plan.amountRaw.toString(),
      ...(plan.asset.token !== undefined ? { token: plan.asset.token } : {}),
      nonce: plan.tx.nonce.toString(),
      gas: plan.tx.gas.toString(),
      maxFeePerGas: plan.tx.maxFeePerGas.toString(),
      maxPriorityFeePerGas: plan.tx.maxPriorityFeePerGas.toString(),
    })
  } else {
    deps.stdout.write(`${outcome.line}\n`)
  }
  return outcome.exit
}

/** The recipient a built ERC-20 shape names, for tests and the display; undefined for a native shape. */
export function recipientOf(tx: EvmTransaction): string | undefined {
  return decodeErc20Transfer(tx.data)?.recipient
}
