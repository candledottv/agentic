/**
 * Ember Phase 1 (BE-94, HW-07): the smallest Solana surface the LOCAL recovery sweep needs, built
 * on the primitives the CLI already ships (`@noble/curves` ed25519, `@noble/hashes` sha256,
 * `@scure/base` base58) rather than a new dependency. The sweep's whole point is that it runs
 * with the TEE wallet key on the operator's machine after the remote signer has been neutralized, so it
 * cannot lean on the API to build or sign anything.
 *
 * Scope, deliberately: legacy (non-versioned) messages; SystemProgram transfer; TransferChecked,
 * CloseAccount and the associated-token-account idempotent create under EITHER token program
 * (classic SPL Token or Token-2022, chosen by the caller from the mint's owner); the JSON-RPC
 * calls a sweep needs. Nothing else.
 *
 * Ember Phase 3 PR A (BE-218, R5 / P3-ED-7 / the Phase 2 ED-10 amendment) widened that list by
 * exactly three instructions' worth of program parameter and one extra-account tail. Program
 * POSITIONS are still not modeled and never will be here (P3-ED-6): no versioned messages, no
 * address-lookup tables, no DAMM v2. Reading a mint's extensions and resolving a transfer hook's
 * extra accounts live in the sibling `token-2022.ts`, not here, for the same reason.
 *
 * `solana-lite.test.ts` pins every byte this produces against `@solana/web3.js` and
 * `@solana/spl-token` as an independent oracle.
 */
import { ed25519 } from "@noble/curves/ed25519"
import { sha256 } from "@noble/hashes/sha256"
import { base58 } from "@scure/base"

export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111"
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"

export type Pubkey = Uint8Array

export function decodePubkey(address: string): Pubkey {
  let bytes: Uint8Array
  try {
    bytes = base58.decode(address)
  } catch {
    throw new Error(`Not a base58 address: ${address}`)
  }
  if (bytes.length !== 32) throw new Error(`Not a 32-byte Solana address: ${address}`)
  return bytes
}

export function encodePubkey(bytes: Pubkey): string {
  return base58.encode(bytes)
}

/** True when the 32 bytes decode to a point on the ed25519 curve (a PDA never does). */
export function isOnCurve(bytes: Pubkey): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(bytes)
    return true
  } catch {
    return false
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress")

/** `findProgramAddress`: the first bump from 255 down whose sha256 lands off the curve. */
export function findProgramAddress(seeds: Uint8Array[], programId: Pubkey): { address: Pubkey; bump: number } {
  for (let bump = 255; bump >= 0; bump--) {
    const candidate = sha256(concat(...seeds, new Uint8Array([bump]), programId, PDA_MARKER))
    if (!isOnCurve(candidate)) return { address: candidate, bump }
  }
  throw new Error("Unable to find a viable program address bump seed")
}

/** The associated token account for (owner, mint), under the classic Token program by default. */
export function associatedTokenAddress(
  owner: Pubkey,
  mint: Pubkey,
  tokenProgram: Pubkey = decodePubkey(TOKEN_PROGRAM_ID),
): Pubkey {
  return findProgramAddress([owner, tokenProgram, mint], decodePubkey(ASSOCIATED_TOKEN_PROGRAM_ID)).address
}

// ── Instructions ──────────────────────────────────────────────────────────────────────────────

export interface AccountMeta {
  pubkey: Pubkey
  isSigner: boolean
  isWritable: boolean
}

export interface Instruction {
  programId: Pubkey
  keys: AccountMeta[]
  data: Uint8Array
}

function u64le(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffffffffffffffffn) throw new Error(`u64 out of range: ${value}`)
  const out = new Uint8Array(8)
  let v = value
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4)
  out[0] = value & 0xff
  out[1] = (value >>> 8) & 0xff
  out[2] = (value >>> 16) & 0xff
  out[3] = (value >>> 24) & 0xff
  return out
}

/** SystemProgram::Transfer (instruction index 2). */
export function systemTransfer(from: Pubkey, to: Pubkey, lamports: bigint): Instruction {
  return {
    programId: decodePubkey(SYSTEM_PROGRAM_ID),
    keys: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
    ],
    data: concat(u32le(2), u64le(lamports)),
  }
}

/**
 * TransferChecked (instruction 12): amount u64, decimals u8. `tokenProgram` is the MINT's owning
 * program, which the caller reads from the mint account -- never assumed (P3-ED-7). The opcode and
 * the four fixed keys are identical under both programs; Token-2022 differs only in what it does
 * with them, and in `extraAccounts`, the transfer hook's resolved tail (resolved extras, then the
 * hook program, then its validation account), which `token-2022.ts` produces.
 */
export function tokenTransferChecked(input: {
  source: Pubkey
  mint: Pubkey
  destination: Pubkey
  owner: Pubkey
  amount: bigint
  decimals: number
  tokenProgram?: Pubkey
  extraAccounts?: readonly AccountMeta[]
}): Instruction {
  return {
    programId: input.tokenProgram ?? decodePubkey(TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: input.source, isSigner: false, isWritable: true },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: input.destination, isSigner: false, isWritable: true },
      { pubkey: input.owner, isSigner: true, isWritable: false },
      ...(input.extraAccounts ?? []),
    ],
    data: concat(new Uint8Array([12]), u64le(input.amount), new Uint8Array([input.decimals])),
  }
}

/**
 * CloseAccount (instruction 9): rent goes to `destination`, under the MINT's owning program. A
 * Token-2022 account must be closed under Token-2022, exactly as a classic one is closed under the
 * classic program (R5).
 */
export function tokenCloseAccount(input: {
  account: Pubkey
  destination: Pubkey
  owner: Pubkey
  tokenProgram?: Pubkey
}): Instruction {
  return {
    programId: input.tokenProgram ?? decodePubkey(TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: input.account, isSigner: false, isWritable: true },
      { pubkey: input.destination, isSigner: false, isWritable: true },
      { pubkey: input.owner, isSigner: true, isWritable: false },
    ],
    data: new Uint8Array([9]),
  }
}

/**
 * Associated Token Program CreateIdempotent (instruction 1). `tokenProgram` is the mint's owning
 * program: it is BOTH a seed of the derived address and the last key, so passing the wrong one
 * derives a different account under a program that will refuse it.
 */
export function createAssociatedTokenAccountIdempotent(input: {
  payer: Pubkey
  owner: Pubkey
  mint: Pubkey
  tokenProgram?: Pubkey
}): Instruction {
  const tokenProgram = input.tokenProgram ?? decodePubkey(TOKEN_PROGRAM_ID)
  const ata = associatedTokenAddress(input.owner, input.mint, tokenProgram)
  return {
    programId: decodePubkey(ASSOCIATED_TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: input.payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: input.owner, isSigner: false, isWritable: false },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: decodePubkey(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array([1]),
  }
}

// ── Legacy message compile + sign ─────────────────────────────────────────────────────────────

function shortvec(n: number): Uint8Array {
  const out: number[] = []
  let rem = n
  for (;;) {
    let elem = rem & 0x7f
    rem >>= 7
    if (rem === 0) {
      out.push(elem)
      return new Uint8Array(out)
    }
    elem |= 0x80
    out.push(elem)
  }
}

function keyEq(a: Pubkey, b: Pubkey): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Compiles a legacy message exactly the way web3.js's `Transaction.compileMessage` does, so the
 * bytes can be pinned against it: every instruction's keys in order, then every program id,
 * de-duplicated with flags merged; sorted signer-first, then writable-first, ties broken by an
 * `en` locale compare of the base58 form; then the fee payer moved (or inserted) at index 0 as a
 * writable signer. The header counts fall out of that ordering.
 */
export function compileLegacyMessage(input: {
  feePayer: Pubkey
  recentBlockhash: string
  instructions: Instruction[]
}): Uint8Array {
  type Meta = { pubkey: Pubkey; base58: string; isSigner: boolean; isWritable: boolean }
  const metas: Meta[] = []
  const upsert = (pubkey: Pubkey, isSigner: boolean, isWritable: boolean) => {
    const b58 = encodePubkey(pubkey)
    const existing = metas.find((x) => x.base58 === b58)
    if (existing) {
      existing.isSigner = existing.isSigner || isSigner
      existing.isWritable = existing.isWritable || isWritable
    } else {
      metas.push({ pubkey, base58: b58, isSigner, isWritable })
    }
  }
  for (const ix of input.instructions) for (const k of ix.keys) upsert(k.pubkey, k.isSigner, k.isWritable)
  for (const ix of input.instructions) upsert(ix.programId, false, false)

  const localeOptions: Intl.CollatorOptions = {
    localeMatcher: "best fit",
    usage: "sort",
    sensitivity: "variant",
    ignorePunctuation: false,
    numeric: false,
    caseFirst: "lower",
  }
  metas.sort((x, y) => {
    if (x.isSigner !== y.isSigner) return x.isSigner ? -1 : 1
    if (x.isWritable !== y.isWritable) return x.isWritable ? -1 : 1
    return x.base58.localeCompare(y.base58, "en", localeOptions)
  })

  const payerB58 = encodePubkey(input.feePayer)
  const payerIdx = metas.findIndex((m) => m.base58 === payerB58)
  if (payerIdx > -1) {
    const [payer] = metas.splice(payerIdx, 1)
    if (!payer) throw new Error("unreachable")
    payer.isSigner = true
    payer.isWritable = true
    metas.unshift(payer)
  } else {
    metas.unshift({ pubkey: input.feePayer, base58: payerB58, isSigner: true, isWritable: true })
  }

  const numRequiredSignatures = metas.filter((m) => m.isSigner).length
  const numReadonlySigned = metas.filter((m) => m.isSigner && !m.isWritable).length
  const numReadonlyUnsigned = metas.filter((m) => !m.isSigner && !m.isWritable).length

  const indexOf = (k: Pubkey) => {
    const b58 = encodePubkey(k)
    const i = metas.findIndex((m) => m.base58 === b58)
    if (i < 0) throw new Error("unreachable: key missing from account list")
    return i
  }

  const parts: Uint8Array[] = [
    new Uint8Array([numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned]),
    shortvec(metas.length),
    ...metas.map((m) => m.pubkey),
    decodePubkey(input.recentBlockhash),
    shortvec(input.instructions.length),
  ]
  for (const ix of input.instructions) {
    const accountIdx = new Uint8Array(ix.keys.map((k) => indexOf(k.pubkey)))
    parts.push(
      new Uint8Array([indexOf(ix.programId)]),
      shortvec(accountIdx.length),
      accountIdx,
      shortvec(ix.data.length),
      ix.data,
    )
  }
  return concat(...parts)
}

/** The 64-byte Solana secret is seed(32) || pubkey(32); the seed is what ed25519 signs with. */
export function signMessage(message: Uint8Array, secret64: Uint8Array): Uint8Array {
  if (secret64.length !== 64) throw new Error(`expected a 64-byte Solana secret, got ${secret64.length}`)
  return ed25519.sign(message, secret64.slice(0, 32))
}

export function pubkeyFromSecret(secret64: Uint8Array): Pubkey {
  if (secret64.length !== 64) throw new Error(`expected a 64-byte Solana secret, got ${secret64.length}`)
  const derived = ed25519.getPublicKey(secret64.slice(0, 32))
  const embedded = secret64.slice(32)
  if (!keyEq(derived, embedded)) throw new Error("The secret's embedded public key does not match its seed")
  return derived
}

/** A single-signer legacy transaction: shortvec(1) || signature || message. */
export function serializeSignedTransaction(message: Uint8Array, signature: Uint8Array): Uint8Array {
  if (signature.length !== 64) throw new Error("expected a 64-byte signature")
  return concat(shortvec(1), signature, message)
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64")
}

// ── JSON-RPC ──────────────────────────────────────────────────────────────────────────────────

export interface TokenAccountView {
  pubkey: string
  mint: string
  amountRaw: string
  decimals: number
  state: string
  programId: string
}

/** A raw account read: its owning program and its data. `null` when the account does not exist. */
export interface AccountView {
  owner: string
  lamports: bigint
  data: Uint8Array
}

export interface SolanaRpc {
  getLatestBlockhash(): Promise<string>
  getBalance(address: string): Promise<bigint>
  getTokenAccountsByOwner(owner: string, programId: string): Promise<TokenAccountView[]>
  /**
   * Ember Phase 3 (BE-218, P3-ED-7). One base64 `getAccountInfo`, which is what a Token-2022 move
   * needs and a classic one does not: the MINT's owning program (so the transfer, the close and the
   * ATA derivation all happen under it) and its raw TLV, which `token-2022.ts` reads for the fee
   * schedule, the transfer hook and the non-transferable flag. Also the hook's own validation
   * account and any account a seed configuration names. It replaced Phase 1's `accountExists`,
   * whose only callers now need the account's state and owner as well as its existence.
   */
  getAccountInfo(address: string): Promise<AccountView | null>
  /** The current epoch, which selects a transfer-fee schedule (older vs newer). */
  getEpoch(): Promise<bigint>
  getFeeForMessage(messageBase64: string): Promise<bigint | null>
  getMinimumBalanceForRentExemption(size: number): Promise<bigint>
  sendTransaction(txBase64: string): Promise<string>
  getSignatureStatus(signature: string): Promise<{ confirmationStatus: string | null; err: unknown } | null>
  /** Whether a transaction built on this blockhash can still land (finalized commitment). */
  isBlockhashValid(blockhash: string): Promise<boolean>
  /**
   * Whether this address has ever signed or been touched by a confirmed transaction (Ember Phase 2,
   * BE-136, CC-11). Read-only, and used by exactly one caller: `vault restore --phrase`'s gap scan,
   * which stops after twenty consecutive indices with no lamports, no token account and no
   * signature history. A balance alone is not enough there -- an address that received and then
   * sent everything has a zero balance and a history, and treating it as unused would end the scan
   * one index early.
   */
  hasSignatureHistory(address: string): Promise<boolean>
}

/**
 * The narrowest JSON-RPC client the sweep needs, over the injected `fetch`. Every call is a POST
 * of one request; a non-2xx or an `error` member throws with the RPC's code/message only (never
 * the request body, which for sendTransaction is a signed transaction).
 */
export function createSolanaRpc(url: string, fetchFn: typeof fetch): SolanaRpc {
  let id = 0
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    id += 1
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    })
    if (!res.ok) throw new Error(`RPC ${method} failed: HTTP ${res.status}`)
    const json = (await res.json()) as { result?: T; error?: { code?: number; message?: string } }
    if (json.error) throw new Error(`RPC ${method} failed: ${json.error.code ?? ""} ${json.error.message ?? ""}`.trim())
    return json.result as T
  }
  return {
    async getLatestBlockhash() {
      const r = await call<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "finalized" }])
      return r.value.blockhash
    },
    async getBalance(address) {
      const r = await call<{ value: number }>("getBalance", [address, { commitment: "finalized" }])
      return BigInt(r.value)
    },
    async getTokenAccountsByOwner(owner, programId) {
      const r = await call<{
        value: Array<{
          pubkey: string
          account: {
            data: {
              parsed: { info: { mint: string; state: string; tokenAmount: { amount: string; decimals: number } } }
            }
          }
        }>
      }>("getTokenAccountsByOwner", [owner, { programId }, { encoding: "jsonParsed", commitment: "finalized" }])
      return r.value.map((v) => ({
        pubkey: v.pubkey,
        mint: v.account.data.parsed.info.mint,
        amountRaw: v.account.data.parsed.info.tokenAmount.amount,
        decimals: v.account.data.parsed.info.tokenAmount.decimals,
        state: v.account.data.parsed.info.state,
        programId,
      }))
    },
    async getFeeForMessage(messageBase64) {
      const r = await call<{ value: number | null }>("getFeeForMessage", [messageBase64, { commitment: "finalized" }])
      return r.value === null ? null : BigInt(r.value)
    },
    async getMinimumBalanceForRentExemption(size) {
      const rent = await call<number>("getMinimumBalanceForRentExemption", [size, { commitment: "finalized" }])
      if (!Number.isSafeInteger(rent) || rent < 0) throw new Error("Invalid rent exemption quote")
      return BigInt(rent)
    },
    async getAccountInfo(address) {
      const r = await call<{
        value: { owner?: string; lamports?: number; data?: [string, string] } | null
      }>("getAccountInfo", [address, { encoding: "base64", commitment: "finalized" }])
      const value = r.value
      if (!value) return null
      const owner = value.owner
      const encoded = value.data?.[0]
      if (typeof owner !== "string" || typeof encoded !== "string") {
        throw new Error(`RPC getAccountInfo answered without a base64 owner/data pair for ${address}`)
      }
      return {
        owner,
        lamports: BigInt(value.lamports ?? 0),
        data: new Uint8Array(Buffer.from(encoded, "base64")),
      }
    },
    async getEpoch() {
      const r = await call<{ epoch?: number }>("getEpochInfo", [{ commitment: "finalized" }])
      if (!Number.isSafeInteger(r?.epoch)) throw new Error("RPC getEpochInfo answered without an epoch")
      return BigInt(r.epoch as number)
    },
    async sendTransaction(txBase64) {
      return await call<string>("sendTransaction", [
        txBase64,
        { encoding: "base64", skipPreflight: false, preflightCommitment: "finalized", maxRetries: 3 },
      ])
    },
    async getSignatureStatus(signature) {
      const r = await call<{ value: Array<{ confirmationStatus: string | null; err: unknown } | null> }>(
        "getSignatureStatuses",
        [[signature], { searchTransactionHistory: true }],
      )
      return r.value[0] ?? null
    },
    async hasSignatureHistory(address) {
      const r = await call<Array<unknown>>("getSignaturesForAddress", [address, { limit: 1 }])
      return Array.isArray(r) && r.length > 0
    },
    async isBlockhashValid(blockhash) {
      const r = await call<{ value?: unknown }>("isBlockhashValid", [blockhash, { commitment: "finalized" }])
      // The contract is a boolean. Anything else is not evidence of expiry: throw, and the caller
      // keeps the transaction uncertain.
      if (typeof r?.value !== "boolean") throw new Error("isBlockhashValid answered with a non-boolean value")
      return r.value
    },
  }
}
