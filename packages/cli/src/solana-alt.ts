/**
 * Ember Phase 3 PR F (BE-226, R6, P3-ED-6): the versioned-transaction sibling of `solana-lite.ts`.
 *
 * `solana-lite` compiles and signs the legacy shapes the vault and the TEE sweep build themselves,
 * and P3-ED-6 pins it there: no versioned messages, no address-lookup tables. `candle sign` has the
 * opposite job. It signs a transaction SOMETHING ELSE built (a plug-in, the user's own script, a
 * service's API called with the user's key), so it must read a legacy or v0 transaction it did not
 * compile, reconstruct the account list a v0 message only commits to by table and index, and show
 * the operator what the transaction does before an external key signs it. That is what lives here,
 * and nothing here reaches `solana-lite`.
 *
 * Three rules, each a build requirement of R6:
 *
 * - **Decode strictly, or refuse.** The input is exactly one complete serialized transaction whose
 *   message is legacy or v0. A base64 alphabet or padding error, a byte sequence that does not
 *   deserialize, bytes left over after the one transaction, or a message version other than legacy
 *   and 0 is `TransactionDecodeError` (the command maps it to `SIGN_TRANSACTION_UNDECODABLE`), and
 *   nothing of the transaction is displayed.
 * - **Reconstruct the compiled key order before anything is displayed.** A v0 message names lookup
 *   tables and indexes into them; the accounts an instruction actually touches are only known once
 *   every table is fetched and every index applied, in compiled order: static keys, then every
 *   loaded writable address table by table, then every loaded readonly address table by table. A
 *   table that cannot be fetched, an account that is not a lookup table, or an index past its end
 *   is `LookupTableError` (`SIGN_LOOKUP_TABLE_UNRESOLVED`), raised only after a supported v0
 *   transaction has decoded, so the two codes never overlap.
 * - **Deltas come from the simulation.** `simulateTransaction` answers the outcome, the logs and
 *   the post-simulation state of the accounts it is asked about; the pre-simulation state is read
 *   with `getMultipleAccounts` first. The difference, per writable account, is what the operator
 *   sees: lamports before and after, and for a token account its mint, owner and amount.
 *
 * `solana-alt.test.ts` pins the decoder and the compiled order against `@solana/web3.js` as an
 * independent oracle; the package itself ships no Solana runtime dependency.
 */
import { base58 } from "@scure/base"
import {
  type AccountView,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  encodePubkey,
  isRateLimited,
  type SimulationResult,
  type SolanaRpc,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./solana-lite"

export const ADDRESS_LOOKUP_TABLE_PROGRAM_ID = "AddressLookupTab1e1111111111111111111111111"
export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111"
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"

/** The input could not be read as exactly one legacy or v0 transaction. Nothing was displayed. */
export class TransactionDecodeError extends Error {}
/** A supported v0 transaction decoded, and a lookup table it names could not be resolved. */
export class LookupTableError extends Error {}

const SIGNATURE_BYTES = 64
const PUBKEY_BYTES = 32
const BLOCKHASH_BYTES = 32
/** The lookup-table account's fixed header before its address list. */
const LOOKUP_TABLE_META_SIZE = 56

// ── Strict base64 ─────────────────────────────────────────────────────────────────────────────

/**
 * Decodes base64 strictly: the standard alphabet, correct padding, a length that is a multiple of
 * four, and a canonical encoding (re-encoding the bytes gives the input back, so unused trailing
 * bits are zero). Trailing newlines are tolerated because a file ends in one; nothing else is.
 */
export function decodeStrictBase64(text: string): Uint8Array {
  const trimmed = text.replace(/[\r\n]+$/, "")
  if (trimmed.length === 0) throw new TransactionDecodeError("the input is empty")
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) {
    throw new TransactionDecodeError("the input is not strict base64")
  }
  const bytes = Buffer.from(trimmed, "base64")
  if (bytes.toString("base64") !== trimmed) {
    throw new TransactionDecodeError("the input is not canonical base64")
  }
  return new Uint8Array(bytes)
}

// ── The wire format ───────────────────────────────────────────────────────────────────────────

export interface DecodedInstruction {
  programIdIndex: number
  accountIndexes: number[]
  data: Uint8Array
}

export interface DecodedLookup {
  table: string
  writableIndexes: number[]
  readonlyIndexes: number[]
}

export interface DecodedMessage {
  version: "legacy" | 0
  numRequiredSignatures: number
  numReadonlySigned: number
  numReadonlyUnsigned: number
  staticKeys: string[]
  recentBlockhash: string
  instructions: DecodedInstruction[]
  /** Empty for a legacy message. */
  lookups: DecodedLookup[]
  /** The exact message bytes: what a signature covers. */
  bytes: Uint8Array
}

export interface DecodedTransaction {
  /** One slot per required signature, as the input carried them (all-zero when unsigned). */
  signatures: Uint8Array[]
  message: DecodedMessage
}

interface Reader {
  bytes: Uint8Array
  at: number
}

function fail(detail: string): never {
  throw new TransactionDecodeError(detail)
}

function u8(r: Reader): number {
  const value = r.bytes[r.at]
  if (value === undefined) fail("the transaction ends early")
  r.at += 1
  return value
}

/** Solana's compact-u16: up to three bytes, seven bits each, little-endian. */
function shortvec(r: Reader): number {
  let value = 0
  for (let i = 0; i < 3; i++) {
    const byte = u8(r)
    value |= (byte & 0x7f) << (7 * i)
    if ((byte & 0x80) === 0) {
      if (i === 2 && byte > 0x03) fail("a compact length is out of range")
      return value
    }
  }
  fail("a compact length is malformed")
}

function take(r: Reader, n: number): Uint8Array {
  if (r.at + n > r.bytes.length) fail("the transaction ends early")
  const out = r.bytes.subarray(r.at, r.at + n)
  r.at += n
  return out
}

function indexes(r: Reader): number[] {
  const count = shortvec(r)
  const out: number[] = []
  for (let i = 0; i < count; i++) out.push(u8(r))
  return out
}

/**
 * Exactly one transaction: a compact count of 64-byte signatures, then a legacy or v0 message, and
 * nothing after it. Every structural rule the runtime's own sanitizer enforces is checked here, so
 * a transaction that decodes is one the chain could accept, and every index is inside the account
 * list the message commits to (static keys plus, for v0, the loaded addresses by count).
 */
export function decodeTransaction(wire: Uint8Array): DecodedTransaction {
  const r: Reader = { bytes: wire, at: 0 }
  const signatureCount = shortvec(r)
  const signatures: Uint8Array[] = []
  for (let i = 0; i < signatureCount; i++) signatures.push(Uint8Array.from(take(r, SIGNATURE_BYTES)))

  const messageStart = r.at
  const prefix = u8(r)
  let version: "legacy" | 0
  if ((prefix & 0x80) === 0) {
    version = "legacy"
    r.at = messageStart
  } else {
    const found = prefix & 0x7f
    if (found !== 0) fail(`message version ${found} is not supported (legacy and v0 only)`)
    version = 0
  }
  const numRequiredSignatures = u8(r)
  const numReadonlySigned = u8(r)
  const numReadonlyUnsigned = u8(r)
  const staticCount = shortvec(r)
  const staticKeys: string[] = []
  for (let i = 0; i < staticCount; i++) staticKeys.push(encodePubkey(Uint8Array.from(take(r, PUBKEY_BYTES))))
  const recentBlockhash = base58.encode(Uint8Array.from(take(r, BLOCKHASH_BYTES)))
  const instructionCount = shortvec(r)
  const instructions: DecodedInstruction[] = []
  for (let i = 0; i < instructionCount; i++) {
    const programIdIndex = u8(r)
    const accountIndexes = indexes(r)
    const dataLength = shortvec(r)
    instructions.push({ programIdIndex, accountIndexes, data: Uint8Array.from(take(r, dataLength)) })
  }
  const lookups: DecodedLookup[] = []
  if (version === 0) {
    const lookupCount = shortvec(r)
    for (let i = 0; i < lookupCount; i++) {
      const table = encodePubkey(Uint8Array.from(take(r, PUBKEY_BYTES)))
      const writableIndexes = indexes(r)
      const readonlyIndexes = indexes(r)
      lookups.push({ table, writableIndexes, readonlyIndexes })
    }
  }
  if (r.at !== wire.length) fail(`${wire.length - r.at} byte(s) remain after the transaction`)

  // The sanitizer's rules. A transaction that breaks one never lands, so it is refused here rather
  // than displayed as if it could.
  if (signatureCount !== numRequiredSignatures) {
    fail(
      `the transaction carries ${signatureCount} signature slot(s) but its message requires ${numRequiredSignatures}`,
    )
  }
  if (numRequiredSignatures === 0) fail("the message requires no signature, so it has no fee payer")
  if (numRequiredSignatures > staticCount) fail("the message requires more signatures than it has static keys")
  if (numReadonlySigned > numRequiredSignatures) fail("the message's readonly-signed count exceeds its signer count")
  if (numReadonlyUnsigned > staticCount - numRequiredSignatures) {
    fail("the message's readonly-unsigned count exceeds its unsigned key count")
  }
  if (version === 0 && lookups.length > 0 && numReadonlySigned === numRequiredSignatures) {
    // Nothing to check here: a message whose every signer is readonly is still valid.
  }
  const loadedCount = lookups.reduce((n, l) => n + l.writableIndexes.length + l.readonlyIndexes.length, 0)
  const totalKeys = staticCount + loadedCount
  for (const [i, ix] of instructions.entries()) {
    if (ix.programIdIndex >= totalKeys) fail(`instruction ${i} names a program index outside the account list`)
    if (ix.programIdIndex >= staticCount)
      fail(`instruction ${i} names a program from a lookup table, which is not allowed`)
    for (const index of ix.accountIndexes) {
      if (index >= totalKeys) fail(`instruction ${i} names an account index outside the account list`)
    }
  }
  const seenTables = new Set<string>()
  for (const lookup of lookups) {
    if (seenTables.has(lookup.table)) fail(`lookup table ${lookup.table} is named twice`)
    seenTables.add(lookup.table)
    if (lookup.writableIndexes.length === 0 && lookup.readonlyIndexes.length === 0) {
      fail(`lookup table ${lookup.table} is named but loads nothing`)
    }
  }
  return {
    signatures,
    message: {
      version,
      numRequiredSignatures,
      numReadonlySigned,
      numReadonlyUnsigned,
      staticKeys,
      recentBlockhash,
      instructions,
      lookups,
      bytes: Uint8Array.from(wire.subarray(messageStart)),
    },
  }
}

function encodeShortvec(n: number): Uint8Array {
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

/**
 * The transaction with `signatures` written into their slots: signer index `i` of the message is
 * signature slot `i`. Slots not named keep whatever the input carried (another party's signature
 * on a partially signed transaction, or the zeros of an unsigned one).
 */
export function attachSignatures(tx: DecodedTransaction, signed: Map<number, Uint8Array>): Uint8Array {
  const slots = tx.signatures.map((existing, i) => signed.get(i) ?? existing)
  for (const [i, slot] of slots.entries()) {
    if (slot.length !== SIGNATURE_BYTES) throw new Error(`signature slot ${i} is not ${SIGNATURE_BYTES} bytes`)
  }
  const count = encodeShortvec(slots.length)
  const out = new Uint8Array(count.length + slots.length * SIGNATURE_BYTES + tx.message.bytes.length)
  out.set(count, 0)
  let at = count.length
  for (const slot of slots) {
    out.set(slot, at)
    at += SIGNATURE_BYTES
  }
  out.set(tx.message.bytes, at)
  return out
}

// ── Lookup tables and the compiled key order ──────────────────────────────────────────────────

/** The address list a lookup-table account holds, in table order. */
export function parseLookupTableAddresses(account: AccountView | null, table: string): string[] {
  if (account === null) throw new LookupTableError(`lookup table ${table} does not exist`)
  if (account.owner !== ADDRESS_LOOKUP_TABLE_PROGRAM_ID) {
    throw new LookupTableError(`${table} is not a lookup table (owned by ${account.owner})`)
  }
  const data = account.data
  if (data.length < LOOKUP_TABLE_META_SIZE || (data.length - LOOKUP_TABLE_META_SIZE) % PUBKEY_BYTES !== 0) {
    throw new LookupTableError(`lookup table ${table} has a malformed address list`)
  }
  const addresses: string[] = []
  for (let at = LOOKUP_TABLE_META_SIZE; at < data.length; at += PUBKEY_BYTES) {
    addresses.push(encodePubkey(data.subarray(at, at + PUBKEY_BYTES)))
  }
  return addresses
}

/** Every account the transaction touches, in compiled order, with the flags the runtime applies. */
export interface CompiledKeys {
  keys: string[]
  isSigner: boolean[]
  isWritable: boolean[]
  /** How many of `keys` are static; the rest were loaded from lookup tables, writable first. */
  staticCount: number
}

/**
 * Static keys, then every loaded writable address in lookup order, then every loaded readonly one
 * in lookup order: the exact order the runtime compiles, which is the order instruction indexes
 * are resolved against. A legacy message has no tables and needs no read.
 */
export async function resolveCompiledKeys(message: DecodedMessage, rpc: SolanaRpc): Promise<CompiledKeys> {
  const loadedWritable: string[] = []
  const loadedReadonly: string[] = []
  if (message.lookups.length > 0) {
    let accounts: Array<AccountView | null>
    try {
      accounts = await rpc.getMultipleAccounts(message.lookups.map((lookup) => lookup.table))
    } catch (error) {
      // BE-355 (D3): a rate limit that survived the client's retry is the caller's RPC_RATE_LIMITED,
      // not a table that could not be fetched.
      if (isRateLimited(error)) throw error
      throw new LookupTableError(
        `the lookup table(s) could not be fetched: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    for (const [i, lookup] of message.lookups.entries()) {
      const addresses = parseLookupTableAddresses(accounts[i] ?? null, lookup.table)
      const lookupAddress = (index: number): string => {
        const address = addresses[index]
        if (address === undefined) {
          throw new LookupTableError(
            `lookup table ${lookup.table} has ${addresses.length} address(es) and the message indexes ${index}`,
          )
        }
        return address
      }
      for (const index of lookup.writableIndexes) loadedWritable.push(lookupAddress(index))
      for (const index of lookup.readonlyIndexes) loadedReadonly.push(lookupAddress(index))
    }
  }
  const staticCount = message.staticKeys.length
  const keys = [...message.staticKeys, ...loadedWritable, ...loadedReadonly]
  const isSigner = keys.map((_, i) => i < message.numRequiredSignatures)
  const isWritable = keys.map((_, i) => {
    if (i < message.numRequiredSignatures) return i < message.numRequiredSignatures - message.numReadonlySigned
    if (i < staticCount) return i < staticCount - message.numReadonlyUnsigned
    return i < staticCount + loadedWritable.length
  })
  return { keys, isSigner, isWritable, staticCount }
}

// ── Simulation and deltas ─────────────────────────────────────────────────────────────────────

export interface AccountSnapshot {
  address: string
  before: AccountView | null
  after: AccountView | null
}

export interface SimulationSnapshot {
  result: SimulationResult
  /** One per writable account of the transaction, in compiled order. */
  snapshots: AccountSnapshot[]
}

/**
 * The pre-state of every writable account, then the simulation with signature verification off,
 * asking for the post-state of the same accounts. Throws on an RPC failure; the caller treats
 * that as a simulation that could not be run, which is a refusal (R6).
 */
export async function simulateWithSnapshots(
  rpc: SolanaRpc,
  txBase64: string,
  compiled: CompiledKeys,
): Promise<SimulationSnapshot> {
  const writable = compiled.keys.filter((_, i) => compiled.isWritable[i])
  const before = await rpc.getMultipleAccounts(writable)
  const result = await rpc.simulateTransaction(txBase64, writable)
  return {
    result,
    snapshots: writable.map((address, i) => ({
      address,
      before: before[i] ?? null,
      after: result.accounts[i] ?? null,
    })),
  }
}

/** SPL token account layout: mint(32) owner(32) amount(8 LE) ... 165 bytes, plus Token-2022's extensions. */
const TOKEN_ACCOUNT_SIZE = 165

export interface TokenBalance {
  mint: string
  owner: string
  amount: bigint
  tokenProgram: string
}

/** The token balance a view holds, or undefined when it is not a token account. */
export function tokenBalanceOf(view: AccountView | null): TokenBalance | undefined {
  if (view === null) return undefined
  if (view.owner !== TOKEN_PROGRAM_ID && view.owner !== TOKEN_2022_PROGRAM_ID) return undefined
  if (view.data.length < TOKEN_ACCOUNT_SIZE) return undefined
  const dv = new DataView(view.data.buffer, view.data.byteOffset, view.data.byteLength)
  return {
    mint: encodePubkey(view.data.subarray(0, 32)),
    owner: encodePubkey(view.data.subarray(32, 64)),
    amount: dv.getBigUint64(64, true),
    tokenProgram: view.owner,
  }
}

export interface SolDelta {
  address: string
  before: bigint
  after: bigint
}

export interface TokenDelta {
  account: string
  owner: string
  mint: string
  tokenProgram: string
  before: bigint
  after: bigint
}

/** Every writable account's lamport change, and every token account's amount change, from the snapshots. */
export function computeDeltas(snapshots: AccountSnapshot[]): { sol: SolDelta[]; tokens: TokenDelta[] } {
  const sol: SolDelta[] = []
  const tokens: TokenDelta[] = []
  for (const snapshot of snapshots) {
    sol.push({
      address: snapshot.address,
      before: snapshot.before?.lamports ?? 0n,
      after: snapshot.after?.lamports ?? 0n,
    })
    const pre = tokenBalanceOf(snapshot.before)
    const post = tokenBalanceOf(snapshot.after)
    const shape = post ?? pre
    if (shape === undefined) continue
    tokens.push({
      account: snapshot.address,
      owner: shape.owner,
      mint: shape.mint,
      tokenProgram: shape.tokenProgram,
      before: pre?.amount ?? 0n,
      after: post?.amount ?? 0n,
    })
  }
  return { sol, tokens }
}

/** A plain name for the programs the operator meets most; the address for every other one. */
export function programNameOf(programId: string): string {
  switch (programId) {
    case SYSTEM_PROGRAM_ID:
      return `System (${programId})`
    case TOKEN_PROGRAM_ID:
      return `Token (${programId})`
    case TOKEN_2022_PROGRAM_ID:
      return `Token-2022 (${programId})`
    case ASSOCIATED_TOKEN_PROGRAM_ID:
      return `Associated Token (${programId})`
    case COMPUTE_BUDGET_PROGRAM_ID:
      return `Compute Budget (${programId})`
    case MEMO_PROGRAM_ID:
      return `Memo (${programId})`
    case ADDRESS_LOOKUP_TABLE_PROGRAM_ID:
      return `Address Lookup Table (${programId})`
    default:
      return programId
  }
}
