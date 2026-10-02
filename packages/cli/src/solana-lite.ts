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

/** What `simulateTransaction` answers: the outcome, the logs, and the requested accounts after it. */
export interface SimulationResult {
  /** `null` when the simulation succeeded; the program error object otherwise. */
  err: unknown
  logs: string[]
  /** One per requested address, in order; `null` for an account that does not exist afterwards. */
  accounts: Array<AccountView | null>
  unitsConsumed?: number
}

/**
 * BE-658 (S1.1): the optional trailing argument of every method a sweep floors. Absent, or with
 * `minContextSlot` undefined, the request is byte-identical to today's.
 */
export interface RpcContextOptions {
  /** Sent as `minContextSlot`. Absent: the request is byte-identical to today's. */
  minContextSlot?: number
  /** Called with `result.context.slot` when the answer carries one. Never called otherwise. */
  onContext?: (slot: number) => void
}

export interface SolanaRpc {
  getLatestBlockhash(opts?: RpcContextOptions): Promise<string>
  getBalance(address: string, opts?: RpcContextOptions): Promise<bigint>
  getTokenAccountsByOwner(owner: string, programId: string, opts?: RpcContextOptions): Promise<TokenAccountView[]>
  /**
   * Ember Phase 3 (BE-218, P3-ED-7). One base64 `getAccountInfo`, which is what a Token-2022 move
   * needs and a classic one does not: the MINT's owning program (so the transfer, the close and the
   * ATA derivation all happen under it) and its raw TLV, which `token-2022.ts` reads for the fee
   * schedule, the transfer hook and the non-transferable flag. Also the hook's own validation
   * account and any account a seed configuration names. It replaced Phase 1's `accountExists`,
   * whose only callers now need the account's state and owner as well as its existence.
   */
  getAccountInfo(address: string, opts?: RpcContextOptions): Promise<AccountView | null>
  /**
   * The current epoch, which selects a transfer-fee schedule (older vs newer). `getEpochInfo`
   * answers no `context`, so a floor is sent but never checked (BE-658 S1.4).
   */
  getEpoch(opts?: RpcContextOptions): Promise<bigint>
  /**
   * Ember Phase 3 PR F (BE-226, R6): the two reads `candle sign` needs and nothing else here does.
   * `getMultipleAccounts` is the PRE-simulation state of the accounts a transaction writes (and the
   * lookup tables a v0 message names); `simulateTransaction`, with signature verification off,
   * returns the program error and logs plus the POST-simulation state of the same accounts, which
   * is what the displayed deltas are computed from. Decoding, lookup-table reconstruction and the
   * delta arithmetic live in `solana-alt.ts` (P3-ED-6), not here.
   */
  getMultipleAccounts(addresses: string[], opts?: RpcContextOptions): Promise<Array<AccountView | null>>
  simulateTransaction(txBase64: string, addresses: string[], opts?: RpcContextOptions): Promise<SimulationResult>
  getFeeForMessage(messageBase64: string, opts?: RpcContextOptions): Promise<bigint | null>
  getMinimumBalanceForRentExemption(size: number): Promise<bigint>
  /**
   * BE-355 (D3): a mint's decimals, as `getTokenSupply` answers them at `confirmed`. The trading
   * commands read this before sizing an amount; it moved here from `trading.ts`'s own `rpc()`
   * helper so the read gets the same rate-limit detection and retry as every other. The caller
   * validates the value (a non-integer or an absent one is its `INVALID_RESPONSE`).
   */
  getTokenSupply(mint: string): Promise<{ decimals?: unknown }>
  /**
   * `minContextSlot` applies to the preflight bank (BE-658 S1.1). Never retried, for a rate limit
   * or a node behind the floor (D4); a `-32016` here is a definite rejection (`definiteSendRejection`).
   */
  sendTransaction(txBase64: string, opts?: RpcContextOptions): Promise<string>
  /**
   * Not floored: `getSignatureStatuses` takes no `minContextSlot`, and its `context.slot` is the
   * node's processed bank, so it never raises a finalized floor (BE-658 S1.2). `slot` is the slot
   * the transaction landed in, when the RPC sends it as a safe integer.
   */
  getSignatureStatus(
    signature: string,
  ): Promise<{ confirmationStatus: string | null; err: unknown; slot?: number } | null>
  /**
   * Whether a transaction built on this blockhash can still land.
   * The default commitment is finalized, which is what pending resolution uses. Pass `"confirmed"`
   * for a blockhash taken at confirmed: close-build does that, and a blockhash newer than the last
   * finalized slot is still valid there while an expired one is not.
   */
  isBlockhashValid(
    blockhash: string,
    commitment?: "finalized" | "confirmed" | "processed",
    opts?: RpcContextOptions,
  ): Promise<boolean>
  /**
   * Whether this address has ever signed or been touched by a confirmed transaction (Ember Phase 2,
   * BE-136, CC-11). Read-only, and used by exactly one caller: `vault restore --phrase`'s gap scan,
   * which stops after twenty consecutive indices with no lamports, no token account and no
   * signature history. A balance alone is not enough there -- an address that received and then
   * sent everything has a zero balance and a history, and treating it as unused would end the scan
   * one index early.
   */
  hasSignatureHistory(address: string): Promise<boolean>
  /**
   * The pubkeys of every account under `programId` that matches every filter (BE-296, D6, D7):
   * `getProgramAccounts` with `dataSlice {offset: 0, length: 0}`, so the answer is addresses only
   * and never account data. Read-only. Takes an `AbortSignal`, because the signer-role scan
   * bounds each request at 20 s and cancels a group's in-flight requests once the group has
   * failed; no existing method changes. Throws `SolanaRpcError`, which carries the HTTP status
   * (so a caller can tell a 429 from a 403) and the RPC error code when there is one.
   *
   * With `dataSlice` (BE-318, BE-314 D2) it asks for those bytes instead and answers
   * `{ pubkey, data }` pairs, `data` being exactly the slice the RPC returned. The mint groups use
   * it to read the 4-byte COption tag in the response rather than in the filter.
   */
  getProgramAccounts(
    programId: string,
    filters: ProgramAccountFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<string[]>
  getProgramAccounts(
    programId: string,
    filters: ProgramAccountFilter[],
    opts: { signal?: AbortSignal; dataSlice: ProgramAccountDataSlice },
  ): Promise<ProgramAccountSlice[]>
  /**
   * One page of Helius `getProgramAccountsV2` (BE-306). Same filters and the same pubkey-only
   * `dataSlice` as `getProgramAccounts`, plus `limit` and an optional `paginationKey`.
   * `withContext` is omitted, so `accounts` and `paginationKey` sit on `result`. With `dataSlice`
   * the page carries `{ pubkey, data }` pairs, as `getProgramAccounts` does.
   * https://www.helius.dev/docs/api-reference/rpc/http/getprogramaccountsv2
   */
  getProgramAccountsV2(
    programId: string,
    filters: ProgramAccountFilter[],
    opts?: { signal?: AbortSignal; paginationKey?: string; limit?: number },
  ): Promise<ProgramAccountsV2Page>
  getProgramAccountsV2(
    programId: string,
    filters: ProgramAccountFilter[],
    opts: { signal?: AbortSignal; paginationKey?: string; limit?: number; dataSlice: ProgramAccountDataSlice },
  ): Promise<ProgramAccountsV2SlicePage>
}

/**
 * Page size for `getProgramAccountsV2`. Helius allows 1 to 10,000 and says to start at 1,000
 * (docs, "Performance Tips", read 2026-09-24). A smaller page is a pubkey-only filtered scan,
 * which is what a single authority lookup returns.
 */
export const PROGRAM_ACCOUNTS_V2_LIMIT = 1000

/** One page of `getProgramAccountsV2`. `paginationKey` is null when the cursor is exhausted. */
export interface ProgramAccountsV2Page {
  pubkeys: string[]
  paginationKey: string | null
}

/** The bytes of each matching account to return: `length` bytes from `offset`. */
export interface ProgramAccountDataSlice {
  offset: number
  length: number
}

/** One matching account with the slice of its data the request asked for. */
export interface ProgramAccountSlice {
  pubkey: string
  data: Uint8Array
}

/** One page of `getProgramAccountsV2` asked with a `dataSlice`. */
export interface ProgramAccountsV2SlicePage {
  accounts: ProgramAccountSlice[]
  paginationKey: string | null
}

/** One `getProgramAccounts` filter: an exact data length, or bytes at an offset (base64-encoded). */
export type ProgramAccountFilter =
  | { dataSize: number }
  | { memcmp: { offset: number; bytes: string; encoding: "base64" } }

/**
 * What an RPC request threw, with the facts the signer-role scheduler branches on (BE-296, D7):
 * `status` for an HTTP failure (429 is retried, anything else stops the group), `retryAfterMs`
 * from a 429's `Retry-After` header when the server sent one, and `rpcCode` for a JSON-RPC
 * `error` member (`-32602 INVALID_PARAMS` is what the public endpoint answers a token scan with).
 * The message is byte-identical to what every existing method threw before this class existed,
 * so no caller that matched on the text changes.
 */
export class SolanaRpcError extends Error {
  readonly status?: number
  readonly retryAfterMs?: number
  readonly rpcCode?: number
  /**
   * BE-355 (D3): whether this answer was a rate limit, derived once from the three facts above so
   * every caller asks one question. Any of: HTTP 429; JSON-RPC `error.code` -32429; a JSON-RPC
   * `error.message` matching "too many requests" (some providers answer HTTP 200 with that).
   */
  readonly rateLimited: boolean
  /** BE-658 (S2.1): the JSON-RPC method that threw, set on every error `once()` builds. */
  readonly method?: string
  /**
   * BE-658 (S2.1): whether the answer's JSON-RPC `id` equalled the request's. Set on the
   * `error`-member path only; a successful answer is never checked.
   */
  readonly responseIdMatched?: boolean
  /** BE-658 (S2.4): the sanitized simulation of a `-32002` whose `data` is an object. */
  readonly simulation?: SimulationDiagnostics
  /** BE-658 (S2.1): `data.contextSlot` of a `-32016`, when it is a safe integer. */
  readonly contextSlot?: number
  /** BE-658 (S1.4): every attempt at a floored read found the node behind the floor. */
  readonly contextBehind?: { required: number; observed: number | undefined }
  /** BE-658 (S1.4): a floored read was answered without a numeric `context.slot`. */
  readonly contextUnverified?: true
  constructor(message: string, facts: SolanaRpcErrorFacts = {}) {
    super(message)
    this.name = "SolanaRpcError"
    this.status = facts.status
    this.retryAfterMs = facts.retryAfterMs
    this.rpcCode = facts.rpcCode
    this.rateLimited =
      facts.status === 429 || facts.rpcCode === RPC_RATE_LIMIT_CODE || /too many requests/i.test(message)
    if (facts.method !== undefined) this.method = facts.method
    if (facts.responseIdMatched !== undefined) this.responseIdMatched = facts.responseIdMatched
    if (facts.simulation !== undefined) this.simulation = facts.simulation
    if (facts.contextSlot !== undefined) this.contextSlot = facts.contextSlot
    if (facts.contextBehind !== undefined) this.contextBehind = facts.contextBehind
    if (facts.contextUnverified) this.contextUnverified = true
  }
}

export interface SolanaRpcErrorFacts {
  status?: number
  retryAfterMs?: number
  rpcCode?: number
  method?: string
  responseIdMatched?: boolean
  simulation?: SimulationDiagnostics
  contextSlot?: number
  contextBehind?: { required: number; observed: number | undefined }
  contextUnverified?: boolean
}

/** The JSON-RPC code for a failed preflight simulation; `data` is the simulation result. */
export const RPC_PREFLIGHT_FAILED_CODE = -32002
/** The JSON-RPC code for "Minimum context slot has not been reached"; `data.contextSlot` is the node's. */
export const RPC_MIN_CONTEXT_SLOT_CODE = -32016

/**
 * BE-658 (S1.4): the waits between the attempts of a floored read whose node is behind. Three
 * attempts and 3 s of waiting at most; D3's single rate-limit retry still applies inside each.
 */
export const RPC_CONTEXT_BEHIND_SLEEPS_MS: readonly number[] = [1_000, 2_000]

/**
 * BE-658 (S2.4): what survives of a failed preflight's `error.data`, bounded and sanitized where
 * the error is built, so no caller ever holds the raw `data`. At most about 6 KB.
 */
export interface SimulationDiagnostics {
  /** `error.message`, sanitized, at most 300 chars. */
  message: string
  /** `JSON.stringify(data.err)`, sanitized, at most 512 chars; "unrepresentable" if it throws. */
  err: string | null
  /** The LAST 20 string lines of `data.logs`, sanitized: the failing instruction's lines come last. */
  logs: string[]
  /** How many earlier lines were dropped. */
  logsOmitted: number
  /** Only when a safe integer. */
  unitsConsumed?: number
}

const DIAGNOSTIC_LOG_LINES = 20
const DIAGNOSTIC_LOG_LINE_CHARS = 240
const DIAGNOSTIC_MESSAGE_CHARS = 300
const DIAGNOSTIC_ERR_CHARS = 512

/**
 * One diagnostic string under the S2.4 rules: C0/C1 controls become a space, a URL becomes
 * `<url>`, an `api-key=`/`token=`/`auth=` value becomes `<redacted>`, and the text is cut at
 * `keep` chars plus an ellipsis.
 */
function sanitizeDiagnostic(text: string, keep: number): string {
  const clean = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this strips
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/(api[-_]?key|token|auth)=\S+/gi, "$1=<redacted>")
  return clean.length > keep ? `${clean.slice(0, keep)}…` : clean
}

/**
 * BE-658 (S2.4): the bounded, sanitized view of a simulation `data` object and its message. Keeps
 * `err`, `logs` and `unitsConsumed`; every other key (`accounts`, `returnData`,
 * `innerInstructions`, `replacementBlockhash`, ...) is dropped.
 */
export function sanitizeSimulation(message: unknown, data: Record<string, unknown>): SimulationDiagnostics {
  let err: string | null = null
  if (data.err !== undefined && data.err !== null) {
    let encoded: string | undefined
    try {
      encoded = JSON.stringify(data.err)
    } catch {
      encoded = "unrepresentable"
    }
    err = encoded === undefined ? null : sanitizeDiagnostic(encoded, DIAGNOSTIC_ERR_CHARS - 1)
  }
  const lines = Array.isArray(data.logs) ? data.logs.filter((line): line is string => typeof line === "string") : []
  const kept = lines.slice(-DIAGNOSTIC_LOG_LINES)
  return {
    message: sanitizeDiagnostic(typeof message === "string" ? message : "", DIAGNOSTIC_MESSAGE_CHARS - 1),
    err,
    logs: kept.map((line) => sanitizeDiagnostic(line, DIAGNOSTIC_LOG_LINE_CHARS)),
    logsOmitted: lines.length - kept.length,
    ...(Number.isSafeInteger(data.unitsConsumed) ? { unitsConsumed: data.unitsConsumed as number } : {}),
  }
}

/** BE-658 (S2.1): a send the answering node refused before it forwarded anything. */
export interface DefiniteRejection {
  reason: "preflight-failed" | "context-behind"
  rpcCode: -32002 | -32016
  /** S2.4; null for context-behind. */
  diagnostics: SimulationDiagnostics | null
  /** context-behind only. */
  contextSlot?: number
}

/**
 * BE-658 (S2.1): non-null only when ALL hold: `error` is a `SolanaRpcError` that
 * `sendTransaction` threw; HTTP was 2xx and the body parsed as JSON; the answer's `id` matched the
 * request's; it is not a rate limit; and it is either a `-32002` whose simulation `err` is present
 * and not null, or a `-32016` with a safe-integer `data.contextSlot`. Everything else (transport
 * errors, 429/5xx, a non-JSON body, a missing or mismatched id, `-32002` without `data` or with a
 * null `err`, `-32005`, any other code) is null: uncertain, exactly as before. Pure.
 */
export function definiteSendRejection(error: unknown): DefiniteRejection | null {
  if (!(error instanceof SolanaRpcError)) return null
  if (error.method !== "sendTransaction") return null
  if (error.status !== undefined) return null
  if (error.responseIdMatched !== true) return null
  if (error.rateLimited) return null
  if (error.rpcCode === RPC_PREFLIGHT_FAILED_CODE && error.simulation !== undefined && error.simulation.err !== null) {
    return { reason: "preflight-failed", rpcCode: RPC_PREFLIGHT_FAILED_CODE, diagnostics: error.simulation }
  }
  if (error.rpcCode === RPC_MIN_CONTEXT_SLOT_CODE && error.contextSlot !== undefined) {
    return {
      reason: "context-behind",
      rpcCode: RPC_MIN_CONTEXT_SLOT_CODE,
      diagnostics: null,
      contextSlot: error.contextSlot,
    }
  }
  return null
}

/** The JSON-RPC error code some providers answer a rate limit with, beside or instead of HTTP 429. */
export const RPC_RATE_LIMIT_CODE = -32429

/**
 * BE-355 (D3): the wait before the one retry of a rate-limited read. `Retry-After` when the server
 * sent one, capped at 10 s; otherwise 2 s. Exported so the client test pins the three cases.
 */
export const RPC_RETRY_DEFAULT_MS = 2_000
export const RPC_RETRY_CAP_MS = 10_000

export function rpcRetryDelayMs(error: SolanaRpcError): number {
  return Math.min(error.retryAfterMs ?? RPC_RETRY_DEFAULT_MS, RPC_RETRY_CAP_MS)
}

/**
 * The methods `createSolanaRpc` never retries (D3, decision 4). `sendTransaction`: never an
 * automatic re-send, even of the same bytes. The two `getProgramAccounts` forms: their 429 policy
 * belongs to the signer-role scheduler (`vault/signer-roles.ts`, BE-296 D7), which is unchanged.
 */
const NEVER_RETRIED = new Set(["sendTransaction", "getProgramAccounts", "getProgramAccountsV2"])

/**
 * What a rate-limited answer said, for the one sentence that names it: `HTTP 429`, `RPC -32429`,
 * or the quoted "Too many requests".
 */
export function describeRateLimit(error: SolanaRpcError): string {
  if (error.status === 429) return "HTTP 429"
  if (error.rpcCode === RPC_RATE_LIMIT_CODE) return `RPC ${RPC_RATE_LIMIT_CODE}`
  return '"Too many requests"'
}

export function isRateLimited(error: unknown): error is SolanaRpcError {
  return error instanceof SolanaRpcError && error.rateLimited
}

/** `Retry-After` as milliseconds: delta-seconds, or an HTTP date; `undefined` when absent or unreadable. */
function retryAfterMs(header: string | null, now: number): number | undefined {
  if (header === null) return undefined
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - now)
}

/**
 * The entries of a `getProgramAccounts` or `getProgramAccountsV2` answer: pubkeys, or with
 * `sliced` the pubkey and the base64 slice the request asked for. An entry without a pubkey,
 * or a sliced entry without base64 data, throws: it is an answer this client cannot read.
 */
function readProgramAccounts(method: string, entries: unknown[], sliced: false): string[]
function readProgramAccounts(method: string, entries: unknown[], sliced: true): ProgramAccountSlice[]
function readProgramAccounts(method: string, entries: unknown[], sliced: boolean): string[] | ProgramAccountSlice[]
function readProgramAccounts(method: string, entries: unknown[], sliced: boolean): string[] | ProgramAccountSlice[] {
  const pubkeys = entries.map((entry) => {
    const pubkey = (entry as { pubkey?: unknown } | null)?.pubkey
    if (typeof pubkey !== "string") throw new SolanaRpcError(`RPC ${method} answered an account without a pubkey`)
    return pubkey
  })
  if (!sliced) return pubkeys
  return entries.map((entry, i) => {
    const data = (entry as { account?: { data?: unknown } }).account?.data
    const encoded = Array.isArray(data) && data[1] === "base64" ? data[0] : undefined
    if (typeof encoded !== "string") throw new SolanaRpcError(`RPC ${method} answered an account without base64 data`)
    return { pubkey: pubkeys[i] as string, data: new Uint8Array(Buffer.from(encoded, "base64")) }
  })
}

/** One account as the RPC answers it under `encoding: "base64"`. */
interface RawAccount {
  owner?: string
  lamports?: number
  data?: [string, string]
}

function rawAccountView(value: RawAccount | null, address: string): AccountView | null {
  if (!value) return null
  const owner = value.owner
  const encoded = value.data?.[0]
  if (typeof owner !== "string" || typeof encoded !== "string") {
    throw new Error(`RPC answered without a base64 owner/data pair for ${address}`)
  }
  return { owner, lamports: BigInt(value.lamports ?? 0), data: new Uint8Array(Buffer.from(encoded, "base64")) }
}

/**
 * The narrowest JSON-RPC client the sweep needs, over the injected `fetch`. Every call is a POST
 * of one request; a non-2xx or an `error` member throws with the RPC's code/message only (never
 * the request body, which for sendTransaction is a signed transaction).
 *
 * BE-355 (D3): a rate-limited answer to a read is retried exactly once, after `rpcRetryDelayMs`
 * through `sleep`; a second rate-limited answer throws the `SolanaRpcError` with `rateLimited`.
 * `sendTransaction` and the `getProgramAccounts*` methods are never retried (`NEVER_RETRIED`).
 * `sleep` is a required positional parameter with no default on purpose: a default would compile
 * at every two-argument site and silently opt that site out of the retry, so the compiler is what
 * finds every caller (T19). Every site passes `deps.sleep`, which a test can make instant.
 *
 * BE-658 (S1.1, S1.4): the methods in `RpcContextOptions`' table take an optional trailing
 * argument. Without `minContextSlot` the request is byte-identical to before and nothing is
 * checked; `onContext` still hears an answer's `context.slot`. With it, the floor is sent and a
 * node behind it (`-32016`, or a `context.slot` below the floor) is asked again after 1 s and 2 s,
 * three attempts in all, before `contextBehind`; an answer without a `context.slot` is
 * `contextUnverified` at once. There is no unfloored fallback. `sendTransaction` is never retried.
 */
export function createSolanaRpc(url: string, fetchFn: typeof fetch, sleep: (ms: number) => Promise<void>): SolanaRpc {
  let id = 0
  async function call<T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
    try {
      return await once<T>(method, params, signal)
    } catch (error) {
      if (!isRateLimited(error) || NEVER_RETRIED.has(method)) throw error
      await sleep(rpcRetryDelayMs(error))
      return await once<T>(method, params, signal)
    }
  }
  /**
   * A read that may carry a context floor (S1.4). `answersContext` is false only for
   * `getEpochInfo`, whose answer has no `context`: its floor is sent but not checked.
   */
  async function read<T>(
    method: string,
    params: unknown[],
    opts: RpcContextOptions | undefined,
    answersContext = true,
  ): Promise<T> {
    const required = opts?.minContextSlot
    if (required === undefined) {
      const result = await call<T>(method, params)
      const slot = answersContext ? contextSlotOf(result) : undefined
      if (slot !== undefined) opts?.onContext?.(slot)
      return result
    }
    let observed: number | undefined
    for (let attempt = 0; ; attempt += 1) {
      let slot: number | undefined
      try {
        const result = await call<T>(method, params)
        if (!answersContext) return result
        slot = contextSlotOf(result)
        if (slot === undefined) {
          throw new SolanaRpcError(
            `RPC ${method} answered without a context slot, so minimum context slot ${required} cannot be verified`,
            { method, contextUnverified: true },
          )
        }
        if (slot >= required) {
          opts?.onContext?.(slot)
          return result
        }
      } catch (error) {
        if (!(error instanceof SolanaRpcError) || error.rpcCode !== RPC_MIN_CONTEXT_SLOT_CODE) throw error
        slot = error.contextSlot
      }
      if (slot !== undefined) observed = observed === undefined ? slot : Math.max(observed, slot)
      const wait = RPC_CONTEXT_BEHIND_SLEEPS_MS[attempt]
      if (wait === undefined) {
        throw new SolanaRpcError(
          `RPC ${method} failed: the node is behind minimum context slot ${required} (observed ${observed ?? "unknown"})`,
          { method, contextBehind: { required, observed } },
        )
      }
      await sleep(wait)
    }
  }
  async function once<T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
    id += 1
    const requestId = id
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
      ...(signal !== undefined ? { signal } : {}),
    })
    if (!res.ok) {
      throw new SolanaRpcError(`RPC ${method} failed: HTTP ${res.status}`, {
        method,
        status: res.status,
        ...(res.status === 429
          ? (() => {
              const after = retryAfterMs(res.headers.get("retry-after"), Date.now())
              return after === undefined ? {} : { retryAfterMs: after }
            })()
          : {}),
      })
    }
    const json = (await res.json()) as {
      id?: unknown
      result?: T
      error?: { code?: number; message?: string; data?: unknown }
    }
    if (json.error) {
      const code = json.error.code
      // S2.1, S2.4: `data` is read here and only its sanitized parts leave this function.
      const data = json.error.data
      const dataObject =
        data !== null && typeof data === "object" && !Array.isArray(data)
          ? (data as Record<string, unknown>)
          : undefined
      const contextSlot = dataObject?.contextSlot
      throw new SolanaRpcError(`RPC ${method} failed: ${json.error.code ?? ""} ${json.error.message ?? ""}`.trim(), {
        ...(typeof code === "number" ? { rpcCode: code } : {}),
        method,
        responseIdMatched: json.id === requestId,
        ...(code === RPC_PREFLIGHT_FAILED_CODE && dataObject
          ? { simulation: sanitizeSimulation(json.error.message, dataObject) }
          : {}),
        ...(code === RPC_MIN_CONTEXT_SLOT_CODE && Number.isSafeInteger(contextSlot)
          ? { contextSlot: contextSlot as number }
          : {}),
      })
    }
    return json.result as T
  }
  return {
    async getLatestBlockhash(opts) {
      const r = await read<{ value: { blockhash: string } }>(
        "getLatestBlockhash",
        [withMinContextSlot({ commitment: "finalized" }, opts)],
        opts,
      )
      return r.value.blockhash
    },
    async getBalance(address, opts) {
      const r = await read<{ value: number }>(
        "getBalance",
        [address, withMinContextSlot({ commitment: "finalized" }, opts)],
        opts,
      )
      return BigInt(r.value)
    },
    async getTokenAccountsByOwner(owner, programId, opts) {
      const r = await read<{
        value: Array<{
          pubkey: string
          account: {
            data: {
              parsed: { info: { mint: string; state: string; tokenAmount: { amount: string; decimals: number } } }
            }
          }
        }>
      }>(
        "getTokenAccountsByOwner",
        [owner, { programId }, withMinContextSlot({ encoding: "jsonParsed", commitment: "finalized" }, opts)],
        opts,
      )
      return r.value.map((v) => ({
        pubkey: v.pubkey,
        mint: v.account.data.parsed.info.mint,
        amountRaw: v.account.data.parsed.info.tokenAmount.amount,
        decimals: v.account.data.parsed.info.tokenAmount.decimals,
        state: v.account.data.parsed.info.state,
        programId,
      }))
    },
    async getFeeForMessage(messageBase64, opts) {
      const r = await read<{ value: number | null }>(
        "getFeeForMessage",
        [messageBase64, withMinContextSlot({ commitment: "finalized" }, opts)],
        opts,
      )
      return r.value === null ? null : BigInt(r.value)
    },
    async getMinimumBalanceForRentExemption(size) {
      const rent = await call<number>("getMinimumBalanceForRentExemption", [size, { commitment: "finalized" }])
      if (!Number.isSafeInteger(rent) || rent < 0) throw new Error("Invalid rent exemption quote")
      return BigInt(rent)
    },
    async getAccountInfo(address, opts) {
      const r = await read<{
        value: { owner?: string; lamports?: number; data?: [string, string] } | null
      }>("getAccountInfo", [address, withMinContextSlot({ encoding: "base64", commitment: "finalized" }, opts)], opts)
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
    async getEpoch(opts) {
      const r = await read<{ epoch?: number }>(
        "getEpochInfo",
        [withMinContextSlot({ commitment: "finalized" }, opts)],
        opts,
        false,
      )
      if (!Number.isSafeInteger(r?.epoch)) throw new Error("RPC getEpochInfo answered without an epoch")
      return BigInt(r.epoch as number)
    },
    async getMultipleAccounts(addresses, opts) {
      const out: Array<AccountView | null> = []
      // The RPC caps one request at 100 addresses.
      for (let at = 0; at < addresses.length; at += 100) {
        const chunk = addresses.slice(at, at + 100)
        const r = await read<{ value?: Array<RawAccount | null> }>(
          "getMultipleAccounts",
          [chunk, withMinContextSlot({ encoding: "base64", commitment: "finalized" }, opts)],
          opts,
        )
        if (!Array.isArray(r?.value) || r.value.length !== chunk.length) {
          throw new Error("RPC getMultipleAccounts answered with the wrong number of accounts")
        }
        for (const [i, value] of r.value.entries()) out.push(rawAccountView(value, chunk[i] ?? ""))
      }
      return out
    },
    async simulateTransaction(txBase64, addresses, opts) {
      const r = await read<{
        value?: { err?: unknown; logs?: unknown; accounts?: Array<RawAccount | null> | null; unitsConsumed?: unknown }
      }>(
        "simulateTransaction",
        [
          txBase64,
          withMinContextSlot(
            {
              sigVerify: false,
              // The transaction is simulated as it will be signed, but against a blockhash the RPC can
              // still evaluate; the blockhash the tool put in the message is what is signed and sent.
              replaceRecentBlockhash: true,
              commitment: "finalized",
              encoding: "base64",
              accounts: { encoding: "base64", addresses },
            },
            opts,
          ),
        ],
        opts,
      )
      const value = r?.value
      if (!value || typeof value !== "object") throw new Error("RPC simulateTransaction answered without a value")
      const accounts = Array.isArray(value.accounts) ? value.accounts : []
      if (value.accounts !== null && value.accounts !== undefined && accounts.length !== addresses.length) {
        throw new Error("RPC simulateTransaction answered with the wrong number of accounts")
      }
      return {
        err: value.err ?? null,
        logs: Array.isArray(value.logs) ? value.logs.filter((line): line is string => typeof line === "string") : [],
        accounts:
          value.accounts === null || value.accounts === undefined
            ? addresses.map(() => null)
            : accounts.map((account, i) => rawAccountView(account, addresses[i] ?? "")),
        ...(Number.isSafeInteger(value.unitsConsumed) ? { unitsConsumed: value.unitsConsumed as number } : {}),
      }
    },
    async getTokenSupply(mint) {
      const r = await call<{ value?: { decimals?: unknown } | null }>("getTokenSupply", [
        mint,
        { commitment: "confirmed" },
      ])
      if (!r?.value || typeof r.value !== "object")
        throw new SolanaRpcError("RPC getTokenSupply answered without a value")
      return { decimals: r.value.decimals }
    },
    async sendTransaction(txBase64, opts) {
      // Never through `read`: a send is never retried, behind or not (D4, S1.4). The floor applies
      // to the preflight bank; a `-32016` is thrown with its `contextSlot` (S2.1).
      return await call<string>("sendTransaction", [
        txBase64,
        withMinContextSlot(
          { encoding: "base64", skipPreflight: false, preflightCommitment: "finalized", maxRetries: 3 },
          opts,
        ),
      ])
    },
    async getSignatureStatus(signature) {
      const r = await call<{
        value: Array<{ confirmationStatus: string | null; err: unknown; slot?: unknown } | null>
      }>("getSignatureStatuses", [[signature], { searchTransactionHistory: true }])
      const status = r.value[0] ?? null
      if (status === null) return null
      // S1.1: `slot` is a safe integer or absent; every other field is passed on as before.
      const { slot, ...rest } = status
      return Number.isSafeInteger(slot) ? { ...rest, slot: slot as number } : rest
    },
    async hasSignatureHistory(address) {
      const r = await call<Array<unknown>>("getSignaturesForAddress", [address, { limit: 1 }])
      return Array.isArray(r) && r.length > 0
    },
    async isBlockhashValid(blockhash, commitment = "finalized", opts) {
      const r = await read<{ value?: unknown }>(
        "isBlockhashValid",
        [blockhash, withMinContextSlot({ commitment }, opts)],
        opts,
      )
      // The contract is a boolean. Anything else is not evidence of expiry: throw, and the caller
      // keeps the transaction uncertain.
      if (typeof r?.value !== "boolean") throw new Error("isBlockhashValid answered with a non-boolean value")
      return r.value
    },
    getProgramAccounts: (async (
      programId: string,
      filters: ProgramAccountFilter[],
      opts?: { signal?: AbortSignal; dataSlice?: ProgramAccountDataSlice },
    ) => {
      const r = await call<unknown>(
        "getProgramAccounts",
        [
          programId,
          {
            encoding: "base64",
            commitment: "finalized",
            dataSlice: opts?.dataSlice ?? { offset: 0, length: 0 },
            filters,
          },
        ],
        opts?.signal,
      )
      // Addresses or nothing: a `null` or non-array answer is not "no accounts", it is an answer
      // this method cannot read, and the caller must not mistake it for a clean scan.
      if (!Array.isArray(r)) throw new SolanaRpcError("RPC getProgramAccounts answered without an account list")
      return readProgramAccounts("getProgramAccounts", r, opts?.dataSlice !== undefined)
    }) as SolanaRpc["getProgramAccounts"],
    getProgramAccountsV2: (async (
      programId: string,
      filters: ProgramAccountFilter[],
      opts?: { signal?: AbortSignal; paginationKey?: string; limit?: number; dataSlice?: ProgramAccountDataSlice },
    ) => {
      // Docs: omit `withContext` and `accounts` / `paginationKey` are on `result`, not `result.value`.
      // `paginationKey` is sent only from the second page on. A page shorter than `limit` is not
      // the end; the caller follows `paginationKey` until it is null.
      const config: {
        encoding: "base64"
        commitment: "finalized"
        dataSlice: ProgramAccountDataSlice
        filters: ProgramAccountFilter[]
        limit: number
        paginationKey?: string
      } = {
        encoding: "base64",
        commitment: "finalized",
        dataSlice: opts?.dataSlice ?? { offset: 0, length: 0 },
        filters,
        limit: opts?.limit ?? PROGRAM_ACCOUNTS_V2_LIMIT,
      }
      if (opts?.paginationKey !== undefined) config.paginationKey = opts.paginationKey
      const r = await call<unknown>("getProgramAccountsV2", [programId, config], opts?.signal)
      if (r === null || typeof r !== "object" || !Array.isArray((r as { accounts?: unknown }).accounts)) {
        throw new SolanaRpcError("RPC getProgramAccountsV2 answered without an account list")
      }
      const page = r as { accounts: unknown[]; paginationKey?: unknown }
      const sliced = opts?.dataSlice !== undefined
      const accounts = readProgramAccounts("getProgramAccountsV2", page.accounts, sliced)
      const cursor = page.paginationKey
      let paginationKey: string | null = null
      if (cursor !== null && cursor !== undefined) {
        if (typeof cursor !== "string" || cursor.length === 0) {
          throw new SolanaRpcError("RPC getProgramAccountsV2 answered a paginationKey that is not a string")
        }
        paginationKey = cursor
      }
      return sliced ? { accounts, paginationKey } : { pubkeys: accounts, paginationKey }
    }) as SolanaRpc["getProgramAccountsV2"],
  }
}

/** `config` with `minContextSlot` appended when the options carry one; otherwise `config` itself. */
function withMinContextSlot<C extends object>(config: C, opts: RpcContextOptions | undefined): C {
  return opts?.minContextSlot === undefined ? config : { ...config, minContextSlot: opts.minContextSlot }
}

/** `result.context.slot` of a context-carrying answer, when it is a safe integer. */
function contextSlotOf(result: unknown): number | undefined {
  const context = result !== null && typeof result === "object" ? (result as { context?: unknown }).context : undefined
  const slot = context !== null && typeof context === "object" ? (context as { slot?: unknown }).slot : undefined
  return Number.isSafeInteger(slot) ? (slot as number) : undefined
}

/**
 * BE-658 (S1.2): the slot no dependent read or send may go below, for one run. It starts at the
 * highest retained receipt slot (or undefined), and only facts about the FINALIZED bank raise it.
 */
export interface ContextFloor {
  readonly slot: number | undefined
  /** Monotonic: max(slot, observed). A lower value is ignored. */
  raise(observed: number): void
}

export function createContextFloor(seed?: number): ContextFloor {
  let slot: number | undefined
  const floor: ContextFloor = {
    get slot() {
      return slot
    },
    raise(observed) {
      if (!Number.isSafeInteger(observed) || observed < 0) return
      if (slot === undefined || observed > slot) slot = observed
    },
  }
  if (seed !== undefined) floor.raise(seed)
  return floor
}

/**
 * BE-658 (S1.2): `rpc` with `floor` passed to every method that takes one. A finalized read sends
 * the floor as it stands at the time of the call and raises it to the answer's `context.slot`.
 * `isBlockhashValid` at `confirmed` or `processed` sends the floor but never raises it, and
 * `sendTransaction` sends it for its preflight. `getSignatureStatus` and every other method pass
 * through unchanged: a status's `context.slot` is the node's processed bank. A caller's own
 * options still apply: the higher `minContextSlot` wins and its `onContext` still hears the slot.
 */
export function withContextFloor(rpc: SolanaRpc, floor: ContextFloor): SolanaRpc {
  // `minContextSlot` is a live view: a method that issues several requests for one call (the chunks
  // of `getMultipleAccounts`) reads it again for each, so a floor raised by chunk 1 reaches chunk 2.
  const required = (opts?: RpcContextOptions): RpcContextOptions => {
    const own = opts?.minContextSlot
    return {
      get minContextSlot() {
        return floor.slot === undefined ? own : own === undefined ? floor.slot : Math.max(floor.slot, own)
      },
      ...(opts?.onContext !== undefined ? { onContext: opts.onContext } : {}),
    }
  }
  const finalized = (opts?: RpcContextOptions): RpcContextOptions => {
    const base = required(opts)
    return {
      // Not spread: that would freeze the live `minContextSlot` getter at its current value.
      get minContextSlot() {
        return base.minContextSlot
      },
      onContext: (slot) => {
        floor.raise(slot)
        opts?.onContext?.(slot)
      },
    }
  }
  return {
    getLatestBlockhash: (opts) => rpc.getLatestBlockhash(finalized(opts)),
    getBalance: (address, opts) => rpc.getBalance(address, finalized(opts)),
    getTokenAccountsByOwner: (owner, programId, opts) => rpc.getTokenAccountsByOwner(owner, programId, finalized(opts)),
    getAccountInfo: (address, opts) => rpc.getAccountInfo(address, finalized(opts)),
    getEpoch: (opts) => rpc.getEpoch(finalized(opts)),
    getMultipleAccounts: (addresses, opts) => rpc.getMultipleAccounts(addresses, finalized(opts)),
    simulateTransaction: (txBase64, addresses, opts) => rpc.simulateTransaction(txBase64, addresses, finalized(opts)),
    getFeeForMessage: (messageBase64, opts) => rpc.getFeeForMessage(messageBase64, finalized(opts)),
    sendTransaction: (txBase64, opts) => rpc.sendTransaction(txBase64, required(opts)),
    isBlockhashValid: (blockhash, commitment, opts) =>
      rpc.isBlockhashValid(
        blockhash,
        commitment,
        commitment === undefined || commitment === "finalized" ? finalized(opts) : required(opts),
      ),
    getSignatureStatus: (signature) => rpc.getSignatureStatus(signature),
    getMinimumBalanceForRentExemption: (size) => rpc.getMinimumBalanceForRentExemption(size),
    getTokenSupply: (mint) => rpc.getTokenSupply(mint),
    hasSignatureHistory: (address) => rpc.hasSignatureHistory(address),
    getProgramAccounts: ((...args: unknown[]) =>
      Reflect.apply(rpc.getProgramAccounts, rpc, args)) as SolanaRpc["getProgramAccounts"],
    getProgramAccountsV2: ((...args: unknown[]) =>
      Reflect.apply(rpc.getProgramAccountsV2, rpc, args)) as SolanaRpc["getProgramAccountsV2"],
  }
}
