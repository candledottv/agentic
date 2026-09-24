/**
 * Ember Phase 4a (BE-350, spec `2026-09-24-ember-phase-4a-evm-vault-keys-design.md`, D4): the EVM
 * counterpart of `solana-lite`, and the only EVM code in the shipped CLI.
 *
 * Everything an EVM vault key needs is here and nowhere else: BIP-32 derivation on the path Phase
 * 2 fixed (`m/44'/60'/n'/0/0`, through `@scure/bip32`), the address (keccak-256 of the uncompressed
 * public key without its prefix byte, last 20 bytes, EIP-55 checksummed), RLP, the two type-2
 * transaction shapes D2 admits, the signing payload and the raw transaction, the ERC-20
 * `transfer(address,uint256)` calldata, and the narrowest JSON-RPC client the transfer and the
 * balance read need. No EVM SDK is bundled: `viem` is a devDependency the tests cross-check this
 * file against, and nothing under `src` imports it outside a test.
 *
 * Two builders exist and no third. `buildNativeTransfer` and `buildErc20Transfer` are the whole of
 * what an EVM vault key signs (invariant 1); there is no generic "build a transaction" entry point,
 * no `approve`, no contract call, no message or EIP-712 signing.
 *
 * `@noble/curves` is pinned to an exact 1.x release, and that is load-bearing here: 1.x's
 * `secp256k1.sign` defaults are `lowS: true` and `prehash: false`, and `signTransaction` relies on
 * both. The hash it passes in is already keccak-256 of the signing payload, so the library must not
 * hash again; 2.x changes the `prehash` default. `release-pins.test.ts` (E13) refuses a 2.x pin.
 */
import { secp256k1 } from "@noble/curves/secp256k1"
import { keccak_256 } from "@noble/hashes/sha3"
import { HDKey } from "@scure/bip32"

// ── Hood facts (spec §3) ──────────────────────────────────────────────────────────────────────

/** Hood (Robinhood Chain), the chain `vault transfer` and `vault list --balances` default to (D1). */
export const HOOD_CHAIN_ID = 4663
/** The public Hood RPC. Used only when no `--rpc-url` / `--evm-rpc-url` / `CANDLE_EVM_RPC_URL` is given. */
export const DEFAULT_HOOD_RPC_URL = "https://rpc.mainnet.chain.robinhood.com"
/** `CANDLE_EVM_RPC_URL`: the operator's EVM endpoint, when the flag is not given (D3). */
export const EVM_RPC_URL_ENV = "CANDLE_EVM_RPC_URL"
/** Hood's USDG. Named on chain id 4663 only (D1); its decimals and symbol are still read from the contract. */
export const HOOD_USDG_ADDRESS = "0x5fc5360d0400a0fd4f2af552add042d716f1d168"
export const HOOD_USDG_DECIMALS = 6
/** The native asset's decimals on every EVM chain this CLI reaches. */
export const NATIVE_DECIMALS = 18

/** CC-11's EVM scheme name, as the format records it. */
export const EVM_DERIVATION_SCHEME = "bip32-secp256k1" as const
/** An EVM secret is the 32-byte secp256k1 scalar (Phase 2 :146). */
export const EVM_SECRET_BYTES = 32

// ── Hex and bytes ─────────────────────────────────────────────────────────────────────────────

export function bytesToHex(bytes: Uint8Array): string {
  let out = ""
  for (const b of bytes) out += b.toString(16).padStart(2, "0")
  return `0x${out}`
}

export function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex
  if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) throw new Error(`not a hex string: ${hex}`)
  const out = new Uint8Array(body.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function hexToBigInt(hex: string): bigint {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex
  if (body === "") return 0n
  if (!/^[0-9a-fA-F]+$/.test(body)) throw new Error(`not a hex quantity: ${hex}`)
  return BigInt(`0x${body}`)
}

/** A JSON-RPC quantity: `0x` + minimal hex, `0x0` for zero. */
export function quantity(value: bigint | number): string {
  return `0x${BigInt(value).toString(16)}`
}

/**
 * Minimal big-endian bytes of a non-negative integer. Zero is the EMPTY byte string, not `0x00`:
 * RLP encodes integers as their minimal representation, and a leading zero byte is a different,
 * invalid encoding that a node rejects (D4, "Integers are minimal big-endian").
 */
export function uintToMinimalBytes(value: bigint): Uint8Array {
  if (value < 0n) throw new Error("RLP integers are non-negative")
  if (value === 0n) return new Uint8Array(0)
  let hex = value.toString(16)
  if (hex.length % 2 !== 0) hex = `0${hex}`
  return hexToBytes(hex)
}

// ── RLP ───────────────────────────────────────────────────────────────────────────────────────

export type RlpItem = Uint8Array | RlpItem[]

function rlpLength(length: number, offset: number): Uint8Array {
  if (length < 56) return Uint8Array.of(offset + length)
  const lengthBytes = uintToMinimalBytes(BigInt(length))
  return concat(Uint8Array.of(offset + 55 + lengthBytes.length), lengthBytes)
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** RLP, as the yellow paper appendix B defines it. Strings and lists; integers arrive as minimal bytes. */
export function rlpEncode(item: RlpItem): Uint8Array {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && (item[0] as number) < 0x80) return item
    return concat(rlpLength(item.length, 0x80), item)
  }
  const body = concat(...item.map(rlpEncode))
  return concat(rlpLength(body.length, 0xc0), body)
}

// ── Addresses ─────────────────────────────────────────────────────────────────────────────────

/** EIP-55: the mixed-case checksum form every explorer and wallet displays. */
export function toChecksumAddress(address: string): string {
  const lower = (address.startsWith("0x") ? address.slice(2) : address).toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(lower)) throw new Error(`not an EVM address: ${address}`)
  const digest = bytesToHex(keccak_256(new TextEncoder().encode(lower))).slice(2)
  let out = "0x"
  for (let i = 0; i < lower.length; i++) {
    const c = lower[i] as string
    out += Number.parseInt(digest[i] as string, 16) >= 8 ? c.toUpperCase() : c
  }
  return out
}

/** `0x` and forty hex digits, in any case. Says nothing about the checksum. */
export function looksLikeEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value)
}

export type AddressCheck = { ok: true; address: string } | { ok: false; reason: string }

/**
 * D6's `EVM_DESTINATION_INVALID` rule: not `0x` plus twenty bytes of hex, or mixed case whose
 * EIP-55 checksum fails. All-lowercase and all-uppercase carry no checksum and are accepted as
 * typed; the returned address is always the checksummed spelling.
 */
export function checkEvmAddress(value: string): AddressCheck {
  if (!looksLikeEvmAddress(value)) return { ok: false, reason: "not 0x followed by 40 hex characters" }
  const body = value.slice(2)
  const checksummed = toChecksumAddress(value)
  const hasLower = /[a-f]/.test(body)
  const hasUpper = /[A-F]/.test(body)
  if (hasLower && hasUpper && checksummed !== value) {
    return { ok: false, reason: "its mixed-case EIP-55 checksum does not match" }
  }
  return { ok: true, address: checksummed }
}

/** Two spellings of one address: EIP-55 and lowercase compare equal. */
export function sameEvmAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** The address of a 32-byte scalar: keccak-256 of the uncompressed public key without `0x04`, last 20 bytes. */
export function evmAddressFromSecret(secret: Uint8Array): string {
  if (secret.length !== EVM_SECRET_BYTES) {
    throw new Error(`expected a ${EVM_SECRET_BYTES}-byte secp256k1 scalar, got ${secret.length}`)
  }
  const pub = secp256k1.getPublicKey(secret, false).slice(1)
  return toChecksumAddress(bytesToHex(keccak_256(pub)).slice(-40))
}

// ── Derivation (D4) ───────────────────────────────────────────────────────────────────────────

export interface DerivedEvmKey {
  /** The 32-byte scalar. The caller owns it and zeroes it. */
  secret: Uint8Array
  address: string
  path: string
}

/** Phase 2's fixed EVM path (CC-11): one hardened account per key, the Ledger Live layout. */
export function evmDerivationPath(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= 0x8000_0000) throw new Error(`index out of range: ${index}`)
  return `m/44'/60'/${index}'/0/0`
}

/**
 * `deriveEvmKey(seed, index)`: `@scure/bip32` over the 64-byte BIP-39 seed along `m/44'/60'/index'/0/0`.
 * Every intermediate node is wiped before this returns; only the leaf scalar leaves, copied out of
 * the library's buffer so the wipe cannot reach it.
 */
export function deriveEvmKey(seed: Uint8Array, index: number): DerivedEvmKey {
  const path = evmDerivationPath(index)
  const root = HDKey.fromMasterSeed(seed)
  try {
    const leaf = root.derive(path)
    try {
      if (leaf.privateKey === null) throw new Error("BIP-32 derivation produced no private key")
      const secret = Uint8Array.from(leaf.privateKey)
      return { secret, address: evmAddressFromSecret(secret), path }
    } finally {
      leaf.wipePrivateData()
    }
  } finally {
    root.wipePrivateData()
  }
}

// ── The two shapes (D2) ───────────────────────────────────────────────────────────────────────

/** A type-2 (EIP-1559) transaction, as the two builders produce it. Empty access list, always. */
export interface EvmTransaction {
  chainId: bigint
  nonce: bigint
  maxPriorityFeePerGas: bigint
  maxFeePerGas: bigint
  gas: bigint
  to: string
  value: bigint
  data: Uint8Array
}

export interface FeeFields {
  chainId: bigint
  nonce: bigint
  maxPriorityFeePerGas: bigint
  maxFeePerGas: bigint
  gas: bigint
}

/** Shape 1: the native asset to `to`, with `value` and empty `data`. */
export function buildNativeTransfer(input: FeeFields & { to: string; value: bigint }): EvmTransaction {
  return { ...input, to: toChecksumAddress(input.to), data: new Uint8Array(0) }
}

/** Shape 2: `transfer(address,uint256)` on the token contract, `value` 0. */
export function buildErc20Transfer(
  input: FeeFields & { token: string; recipient: string; amount: bigint },
): EvmTransaction {
  const { token, recipient, amount, ...fees } = input
  return { ...fees, to: toChecksumAddress(token), value: 0n, data: encodeErc20Transfer(recipient, amount) }
}

/** `transfer(address,uint256)`'s selector: the first four bytes of keccak-256 of the signature. */
export const ERC20_TRANSFER_SELECTOR = "0xa9059cbb"
const ERC20_DECIMALS_SELECTOR = "0x313ce567"
const ERC20_SYMBOL_SELECTOR = "0x95d89b41"
const ERC20_BALANCE_OF_SELECTOR = "0x70a08231"

function abiWord(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 256n) throw new Error("uint256 out of range")
  const out = new Uint8Array(32)
  out.set(uintToMinimalBytes(value), 32 - uintToMinimalBytes(value).length)
  return out
}

function abiAddress(address: string): Uint8Array {
  const out = new Uint8Array(32)
  out.set(hexToBytes(address), 12)
  return out
}

/** Exactly `transfer(address,uint256)` and nothing else: selector, padded address, uint256. 68 bytes. */
export function encodeErc20Transfer(recipient: string, amount: bigint): Uint8Array {
  return concat(hexToBytes(ERC20_TRANSFER_SELECTOR), abiAddress(recipient), abiWord(amount))
}

/** The recipient and amount a `transfer(address,uint256)` calldata names, or undefined for any other calldata. */
export function decodeErc20Transfer(data: Uint8Array): { recipient: string; amount: bigint } | undefined {
  if (data.length !== 68) return undefined
  if (bytesToHex(data.subarray(0, 4)) !== ERC20_TRANSFER_SELECTOR) return undefined
  if (data.subarray(4, 16).some((b) => b !== 0)) return undefined
  return {
    recipient: toChecksumAddress(bytesToHex(data.subarray(16, 36))),
    amount: hexToBigInt(bytesToHex(data.subarray(36, 68))),
  }
}

// ── Signing (D4) ──────────────────────────────────────────────────────────────────────────────

const TYPE_2 = Uint8Array.of(0x02)

function unsignedFields(tx: EvmTransaction): RlpItem[] {
  return [
    uintToMinimalBytes(tx.chainId),
    uintToMinimalBytes(tx.nonce),
    uintToMinimalBytes(tx.maxPriorityFeePerGas),
    uintToMinimalBytes(tx.maxFeePerGas),
    uintToMinimalBytes(tx.gas),
    hexToBytes(tx.to),
    uintToMinimalBytes(tx.value),
    tx.data,
    [],
  ]
}

/** `keccak(0x02 ‖ rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to, value, data, []]))`. */
export function signingPayload(tx: EvmTransaction): Uint8Array {
  return keccak_256(concat(TYPE_2, rlpEncode(unsignedFields(tx))))
}

export interface SignedEvmTransaction {
  /** `0x02 ‖ rlp([..., yParity, r, s])`, what `eth_sendRawTransaction` takes. */
  raw: Uint8Array
  /** keccak-256 of `raw`, the transaction's identity, known before it is sent. */
  hash: string
  yParity: 0 | 1
  r: bigint
  s: bigint
}

/**
 * Signs `tx` with the 32-byte scalar. `secp256k1.sign` is called with the 1.x defaults, `lowS` true
 * and `prehash` false: the payload is already a keccak digest and must not be hashed again. `yParity`
 * is the recovery bit, 0 or 1 -- never 27/28 and never the EIP-155 `v`, because the type-2 envelope
 * carries the chain id as its own field.
 */
export function signTransaction(tx: EvmTransaction, secret: Uint8Array): SignedEvmTransaction {
  if (secret.length !== EVM_SECRET_BYTES) {
    throw new Error(`expected a ${EVM_SECRET_BYTES}-byte secp256k1 scalar, got ${secret.length}`)
  }
  const signature = secp256k1.sign(signingPayload(tx), secret, { lowS: true, prehash: false })
  const yParity = signature.recovery === 1 ? 1 : 0
  const raw = concat(
    TYPE_2,
    rlpEncode([
      ...unsignedFields(tx),
      uintToMinimalBytes(BigInt(yParity)),
      uintToMinimalBytes(signature.r),
      uintToMinimalBytes(signature.s),
    ]),
  )
  return { raw, hash: bytesToHex(keccak_256(raw)), yParity, r: signature.r, s: signature.s }
}

// ── Decimal formatting ────────────────────────────────────────────────────────────────────────

/** A raw integer amount as a decimal string, trailing zeros trimmed, `0` exactly. Never through a float. */
export function formatUnits(raw: bigint, decimals: number): string {
  const negative = raw < 0n
  const magnitude = negative ? -raw : raw
  const base = 10n ** BigInt(decimals)
  const whole = magnitude / base
  const fraction = decimals === 0 ? "" : (magnitude % base).toString().padStart(decimals, "0").replace(/0+$/, "")
  const text = fraction === "" ? whole.toString() : `${whole}.${fraction}`
  return negative ? `-${text}` : text
}

export type ParsedAmount = { ok: true; raw: bigint } | { ok: false; reason: "not-a-number" | "precision" | "zero" }

/** A decimal string as raw units. `precision` is D6's `EVM_AMOUNT_PRECISION`; the caller names the code. */
export function parseUnits(decimal: string, decimals: number): ParsedAmount {
  if (!/^\d+(\.\d+)?$/.test(decimal)) return { ok: false, reason: "not-a-number" }
  const [whole, fraction = ""] = decimal.split(".")
  if (fraction.length > decimals) return { ok: false, reason: "precision" }
  const raw = BigInt((whole ?? "0") + fraction.padEnd(decimals, "0"))
  if (raw === 0n) return { ok: false, reason: "zero" }
  return { ok: true, raw }
}

// ── JSON-RPC ──────────────────────────────────────────────────────────────────────────────────

/**
 * An RPC failure, with the one distinction D6 turns on after a signature exists: `transport` means
 * the request did not get a JSON-RPC answer at all (a thrown fetch, a timeout, a non-2xx status),
 * and `rpc` means the node answered with an `error` member, whose message is kept verbatim so
 * `already known` and `nonce too low` can be recognized.
 */
export class EvmRpcError extends Error {
  readonly kind: "transport" | "rpc"
  readonly method: string
  readonly rpcCode?: number
  constructor(kind: "transport" | "rpc", method: string, message: string, rpcCode?: number) {
    super(message)
    this.name = "EvmRpcError"
    this.kind = kind
    this.method = method
    this.rpcCode = rpcCode
  }
}

export interface EvmReceipt {
  status: 0 | 1
  blockNumber: bigint
  transactionHash: string
}

export interface FeeHistory {
  /** One more entry than blocks requested: the last is the NEXT (pending) block's base fee. */
  baseFeePerGas: bigint[]
  /** Per block, the rewards at the requested percentiles. */
  reward: bigint[][]
}

/**
 * The eleven methods D4 lists, and no `eth_getBlockByNumber`: the base fee comes from
 * `eth_feeHistory`, whose last `baseFeePerGas` entry is the pending block's.
 */
export interface EvmRpc {
  chainId(): Promise<bigint>
  getTransactionCount(address: string, tag: "pending" | "latest"): Promise<bigint>
  estimateGas(call: { from: string; to: string; value: bigint; data: Uint8Array }): Promise<bigint>
  feeHistory(blockCount: number, newestBlock: "latest" | "pending", rewardPercentiles: number[]): Promise<FeeHistory>
  maxPriorityFeePerGas(): Promise<bigint>
  getBalance(address: string): Promise<bigint>
  call(call: { to: string; data: Uint8Array }): Promise<Uint8Array>
  sendRawTransaction(raw: Uint8Array): Promise<string>
  getTransactionReceipt(hash: string): Promise<EvmReceipt | null>
  blockNumber(): Promise<bigint>
  /** ERC-20 `decimals()`. Throws `EvmRpcError` when the contract does not answer one. */
  erc20Decimals(token: string): Promise<number>
  /** ERC-20 `symbol()`, or undefined when the contract answers nothing readable. Never throws for the answer's shape. */
  erc20Symbol(token: string): Promise<string | undefined>
  erc20BalanceOf(token: string, owner: string): Promise<bigint>
}

function decodeAbiString(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0) return undefined
  // A dynamic string: offset word, length word, then the bytes.
  if (bytes.length >= 64) {
    const offset = Number(hexToBigInt(bytesToHex(bytes.subarray(0, 32))))
    if (offset + 32 <= bytes.length) {
      const length = Number(hexToBigInt(bytesToHex(bytes.subarray(offset, offset + 32))))
      if (offset + 32 + length <= bytes.length) {
        return new TextDecoder().decode(bytes.subarray(offset + 32, offset + 32 + length))
      }
    }
  }
  // A `bytes32` symbol, as a few old tokens return.
  if (bytes.length === 32) {
    let end = 32
    while (end > 0 && bytes[end - 1] === 0) end--
    const text = new TextDecoder().decode(bytes.subarray(0, end))
    return /^[\x20-\x7e]+$/.test(text) ? text : undefined
  }
  return undefined
}

/**
 * One POST per call over the injected `fetch`. A non-2xx status or a thrown fetch is a transport
 * error; an `error` member is an RPC error with the node's own message. The request body is never
 * echoed into a message: for `eth_sendRawTransaction` it is a signed transaction.
 */
export function createEvmRpc(url: string, fetchFn: typeof fetch): EvmRpc {
  let id = 0
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    id += 1
    let res: Response
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      })
    } catch (error) {
      throw new EvmRpcError(
        "transport",
        method,
        `RPC ${method} failed: ${error instanceof Error ? error.message : error}`,
      )
    }
    if (!res.ok) throw new EvmRpcError("transport", method, `RPC ${method} failed: HTTP ${res.status}`)
    let json: { result?: T; error?: { code?: number; message?: string } }
    try {
      json = (await res.json()) as typeof json
    } catch {
      throw new EvmRpcError("transport", method, `RPC ${method} failed: the answer was not JSON`)
    }
    if (json.error) {
      throw new EvmRpcError(
        "rpc",
        method,
        `${json.error.message ?? "RPC error"}`,
        typeof json.error.code === "number" ? json.error.code : undefined,
      )
    }
    return json.result as T
  }
  const asQuantity = (value: unknown, method: string): bigint => {
    if (typeof value !== "string") throw new EvmRpcError("rpc", method, `RPC ${method} answered without a quantity`)
    return hexToBigInt(value)
  }
  return {
    async chainId() {
      return asQuantity(await call("eth_chainId", []), "eth_chainId")
    },
    async getTransactionCount(address, tag) {
      return asQuantity(await call("eth_getTransactionCount", [address, tag]), "eth_getTransactionCount")
    },
    async estimateGas(input) {
      return asQuantity(
        await call("eth_estimateGas", [
          {
            from: input.from,
            to: input.to,
            value: quantity(input.value),
            ...(input.data.length > 0 ? { data: bytesToHex(input.data) } : {}),
          },
        ]),
        "eth_estimateGas",
      )
    },
    async feeHistory(blockCount, newestBlock, rewardPercentiles) {
      const r = await call<{ baseFeePerGas?: unknown[]; reward?: unknown[][] }>("eth_feeHistory", [
        quantity(blockCount),
        newestBlock,
        rewardPercentiles,
      ])
      const base = Array.isArray(r?.baseFeePerGas) ? r.baseFeePerGas : []
      if (base.length === 0)
        throw new EvmRpcError("rpc", "eth_feeHistory", "RPC eth_feeHistory answered no baseFeePerGas")
      return {
        baseFeePerGas: base.map((value) => asQuantity(value, "eth_feeHistory")),
        reward: (Array.isArray(r.reward) ? r.reward : []).map((row) =>
          (Array.isArray(row) ? row : []).map((value) => asQuantity(value, "eth_feeHistory")),
        ),
      }
    },
    async maxPriorityFeePerGas() {
      return asQuantity(await call("eth_maxPriorityFeePerGas", []), "eth_maxPriorityFeePerGas")
    },
    async getBalance(address) {
      return asQuantity(await call("eth_getBalance", [address, "latest"]), "eth_getBalance")
    },
    async call(input) {
      const r = await call<unknown>("eth_call", [{ to: input.to, data: bytesToHex(input.data) }, "latest"])
      if (typeof r !== "string") throw new EvmRpcError("rpc", "eth_call", "RPC eth_call answered without data")
      return hexToBytes(r)
    },
    async sendRawTransaction(raw) {
      const r = await call<unknown>("eth_sendRawTransaction", [bytesToHex(raw)])
      if (typeof r !== "string") {
        throw new EvmRpcError("rpc", "eth_sendRawTransaction", "RPC eth_sendRawTransaction answered without a hash")
      }
      return r
    },
    async getTransactionReceipt(hash) {
      const r = await call<{ status?: unknown; blockNumber?: unknown; transactionHash?: unknown } | null>(
        "eth_getTransactionReceipt",
        [hash],
      )
      if (r === null || r === undefined) return null
      const status = asQuantity(r.status, "eth_getTransactionReceipt")
      return {
        status: status === 1n ? 1 : 0,
        blockNumber: asQuantity(r.blockNumber, "eth_getTransactionReceipt"),
        transactionHash: typeof r.transactionHash === "string" ? r.transactionHash : hash,
      }
    },
    async blockNumber() {
      return asQuantity(await call("eth_blockNumber", []), "eth_blockNumber")
    },
    async erc20Decimals(token) {
      const answer = await this.call({ to: token, data: hexToBytes(ERC20_DECIMALS_SELECTOR) })
      if (answer.length !== 32) throw new EvmRpcError("rpc", "eth_call", "the contract did not answer decimals()")
      const value = hexToBigInt(bytesToHex(answer))
      if (value > 255n) throw new EvmRpcError("rpc", "eth_call", "the contract's decimals() is not a uint8")
      return Number(value)
    },
    async erc20Symbol(token) {
      try {
        return decodeAbiString(await this.call({ to: token, data: hexToBytes(ERC20_SYMBOL_SELECTOR) }))
      } catch (error) {
        if (error instanceof EvmRpcError && error.kind === "rpc") return undefined
        throw error
      }
    },
    async erc20BalanceOf(token, owner) {
      const answer = await this.call({
        to: token,
        data: concat(hexToBytes(ERC20_BALANCE_OF_SELECTOR), abiAddress(owner)),
      })
      if (answer.length !== 32) throw new EvmRpcError("rpc", "eth_call", "the contract did not answer balanceOf()")
      return hexToBigInt(bytesToHex(answer))
    },
  }
}

// ── Fees (D5) ─────────────────────────────────────────────────────────────────────────────────

export interface FeeQuote {
  baseFee: bigint
  maxPriorityFeePerGas: bigint
  maxFeePerGas: bigint
  /** Where the tip came from, for the display. */
  tipSource: "eth_maxPriorityFeePerGas" | "eth_feeHistory"
}

/** Blocks of `eth_feeHistory` read for the base fee and the fallback tip. */
export const FEE_HISTORY_BLOCKS = 10

/**
 * D5's fee rule. The tip is `eth_maxPriorityFeePerGas`, or, when the node has no such method, the
 * median of the last ten blocks' 50th-percentile rewards. `baseFee` is the last `baseFeePerGas` in
 * `eth_feeHistory`, the pending block's. `maxFeePerGas = 2 × baseFee + tip`.
 */
export async function quoteFees(rpc: EvmRpc): Promise<FeeQuote> {
  const history = await rpc.feeHistory(FEE_HISTORY_BLOCKS, "latest", [50])
  const baseFee = history.baseFeePerGas[history.baseFeePerGas.length - 1] as bigint
  let tip: bigint
  let tipSource: FeeQuote["tipSource"]
  try {
    tip = await rpc.maxPriorityFeePerGas()
    tipSource = "eth_maxPriorityFeePerGas"
  } catch (error) {
    if (!(error instanceof EvmRpcError) || error.kind !== "rpc") throw error
    const rewards = history.reward.map((row) => row[0] ?? 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    tip = rewards.length === 0 ? 0n : (rewards[Math.floor(rewards.length / 2)] as bigint)
    tipSource = "eth_feeHistory"
  }
  return { baseFee, maxPriorityFeePerGas: tip, maxFeePerGas: 2n * baseFee + tip, tipSource }
}

/** `eth_estimateGas × 1.2`, rounded up (D5). */
export function gasWithHeadroom(estimate: bigint): bigint {
  return (estimate * 12n + 9n) / 10n
}

/** D6: 1 block deep on Hood, 2 on any other chain. Decided by the chain id the RPC answered. */
export function requiredDepth(chainId: bigint): number {
  return chainId === BigInt(HOOD_CHAIN_ID) ? 1 : 2
}

/** The host of an RPC URL, for the stderr line. Never the URL: a provider URL can carry a key. */
export function rpcHostOf(url: string): string {
  return new URL(url).host
}

/**
 * `--rpc-url` / `--evm-rpc-url`, else `CANDLE_EVM_RPC_URL`, else the built-in Hood RPC.
 * A blank flag or env value is unset. The value that is used is checked here, before unlock:
 * it must parse, and plain `http://` is only allowed for localhost, the same rule as Solana's
 * `rpcUrlFrom`. `builtIn` follows the URL that is actually used.
 */
export function resolveEvmRpcUrl(
  flag: string | undefined,
  envValue: string | undefined,
  flagName: "--rpc-url" | "--evm-rpc-url",
): { url: string; builtIn: boolean } | { error: string } {
  const fromFlag = flag?.trim() || undefined
  const fromEnv = envValue?.trim() || undefined
  const url = fromFlag ?? fromEnv ?? DEFAULT_HOOD_RPC_URL
  const source = fromFlag !== undefined ? flagName : fromEnv !== undefined ? EVM_RPC_URL_ENV : undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { error: `${source ?? flagName} is not a valid URL: ${url}` }
  }
  const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost"
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    return {
      error: `${source ?? flagName} must be https:// (plain http is allowed only for 127.0.0.1 / localhost).`,
    }
  }
  return { url, builtIn: url === DEFAULT_HOOD_RPC_URL }
}
