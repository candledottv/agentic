/**
 * Ember Phase 3 PR F (BE-226, R6): the transaction decoder and the compiled key order, pinned
 * against `@solana/web3.js` as an independent oracle (the CLI package does not ship it).
 *
 * The property that matters is the one `candle sign` rests on: a v0 message's account list is
 * reconstructed element for element in the order the runtime compiles it (static, then loaded
 * writable, then loaded readonly), and a transaction that does not decode strictly is refused
 * before anything about it is displayed.
 */
import { describe, expect, test } from "bun:test"
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Keypair,
  type PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js"
import {
  ADDRESS_LOOKUP_TABLE_PROGRAM_ID,
  attachSignatures,
  computeDeltas,
  decodeStrictBase64,
  decodeTransaction,
  LookupTableError,
  parseLookupTableAddresses,
  resolveCompiledKeys,
  TransactionDecodeError,
  tokenBalanceOf,
} from "./solana-alt"
import { type AccountView, type SolanaRpc, TOKEN_PROGRAM_ID } from "./solana-lite"

const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"
const payer = Keypair.generate()
const other = Keypair.generate()

/** A lookup-table account's bytes: web3.js's own 56-byte header layout, then the addresses. */
function lookupTableData(addresses: PublicKey[]): Uint8Array {
  const data = new Uint8Array(56 + 32 * addresses.length)
  const view = new DataView(data.buffer)
  view.setUint32(0, 1, true) // typeIndex: LookupTable
  view.setBigUint64(4, 0xffffffffffffffffn, true) // deactivationSlot: none
  view.setBigUint64(12, 100n, true) // lastExtendedSlot
  data[20] = 0 // lastExtendedStartIndex
  data[21] = 1 // authority: Some
  data.set(payer.publicKey.toBytes(), 22)
  for (const [i, address] of addresses.entries()) data.set(address.toBytes(), 56 + 32 * i)
  return data
}

function rpcWith(accounts: Record<string, AccountView | null>): SolanaRpc {
  const refuse = (name: string) => () => {
    throw new Error(`${name} is not part of this fixture`)
  }
  return {
    getLatestBlockhash: refuse("getLatestBlockhash"),
    getBalance: refuse("getBalance"),
    getTokenAccountsByOwner: refuse("getTokenAccountsByOwner"),
    getFeeForMessage: refuse("getFeeForMessage"),
    getMinimumBalanceForRentExemption: refuse("getMinimumBalanceForRentExemption"),
    sendTransaction: refuse("sendTransaction"),
    getSignatureStatus: refuse("getSignatureStatus"),
    isBlockhashValid: refuse("isBlockhashValid"),
    hasSignatureHistory: refuse("hasSignatureHistory"),
    simulateTransaction: refuse("simulateTransaction"),
    getProgramAccounts: refuse("getProgramAccounts"),
    getProgramAccountsV2: refuse("getProgramAccountsV2"),
    getEpoch: refuse("getEpoch"),
    getAccountInfo: async (address) => accounts[address] ?? null,
    getMultipleAccounts: async (addresses) => addresses.map((address) => accounts[address] ?? null),
  }
}

describe("strict base64", () => {
  test("accepts canonical base64 with a trailing newline, and nothing looser", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const text = Buffer.from(bytes).toString("base64")
    expect(Array.from(decodeStrictBase64(`${text}\n`))).toEqual(Array.from(bytes))
    for (const bad of ["", "AQID BAU=", "AQIDBAU", "AQIDBAV=", "AQIDBAU=x", "!!!!", `${text} `]) {
      expect(() => decodeStrictBase64(bad)).toThrow(TransactionDecodeError)
    }
  })
})

describe("a legacy transaction decodes exactly as web3.js built it", () => {
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: BLOCKHASH }).add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: other.publicKey, lamports: 1_000 }),
  )
  const wire = new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }))

  test("message, keys, header and instruction bytes", async () => {
    const decoded = decodeTransaction(wire)
    expect(decoded.message.version).toBe("legacy")
    expect(decoded.signatures).toHaveLength(1)
    expect(decoded.message.numRequiredSignatures).toBe(1)
    expect(decoded.message.staticKeys).toEqual(tx.compileMessage().accountKeys.map((key) => key.toBase58()))
    expect(decoded.message.recentBlockhash).toBe(BLOCKHASH)
    expect(Array.from(decoded.message.bytes)).toEqual(Array.from(tx.compileMessage().serialize()))
    const compiled = await resolveCompiledKeys(decoded.message, rpcWith({}))
    expect(compiled.keys).toEqual(decoded.message.staticKeys)
    expect(compiled.isSigner).toEqual([true, false, false])
    expect(compiled.isWritable).toEqual([true, true, false])
  })

  test("a signature written into its slot re-serializes to what web3.js signs", () => {
    const decoded = decodeTransaction(wire)
    tx.sign(payer)
    const signed = new Uint8Array(tx.serialize())
    const ours = attachSignatures(decoded, new Map([[0, new Uint8Array(tx.signature as Buffer)]]))
    expect(Array.from(ours)).toEqual(Array.from(signed))
  })

  test("trailing bytes, a truncated transaction, and a signature-count mismatch are all undecodable", () => {
    expect(() => decodeTransaction(new Uint8Array([...wire, 0]))).toThrow(/remain after/)
    expect(() => decodeTransaction(wire.subarray(0, wire.length - 3))).toThrow(TransactionDecodeError)
    // Zero signature slots on a message that requires one: the runtime's sanitizer refuses it too.
    const zeroSlots = new Uint8Array([0, ...wire.subarray(1 + 64)])
    expect(() => decodeTransaction(zeroSlots)).toThrow(/signature slot/)
  })

  test("a message version other than legacy and 0 is undecodable, before any lookup is attempted", () => {
    const messageStart = 1 + 64
    const v1 = Uint8Array.from(wire)
    // Turn the legacy header into a versioned prefix for version 1.
    const bumped = new Uint8Array([...v1.subarray(0, messageStart), 0x81, ...v1.subarray(messageStart)])
    expect(() => decodeTransaction(bumped)).toThrow(/version 1/)
  })
})

describe("a v0 transaction with a lookup table reconstructs the compiled order web3.js uses", () => {
  const tableKey = Keypair.generate().publicKey
  const loadedA = Keypair.generate().publicKey
  const loadedB = Keypair.generate().publicKey
  const loadedC = Keypair.generate().publicKey
  const tableAddresses = [loadedA, loadedB, loadedC, Keypair.generate().publicKey]
  const table = new AddressLookupTableAccount({
    key: tableKey,
    state: AddressLookupTableAccount.deserialize(lookupTableData(tableAddresses)),
  })
  const program = Keypair.generate().publicKey
  // Two loaded writable (C then A, deliberately out of table order) and one loaded readonly (B).
  const ix = new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: loadedC, isSigner: false, isWritable: true },
      { pubkey: loadedB, isSigner: false, isWritable: false },
      { pubkey: loadedA, isSigner: false, isWritable: true },
      { pubkey: other.publicKey, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([7, 7, 7]),
  })
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [ix],
  }).compileToV0Message([table])
  const wire = new VersionedTransaction(message).serialize()

  test("the table account bytes parse to the addresses web3.js reads", () => {
    const view: AccountView = {
      owner: ADDRESS_LOOKUP_TABLE_PROGRAM_ID,
      lamports: 1n,
      data: lookupTableData(tableAddresses),
    }
    expect(parseLookupTableAddresses(view, tableKey.toBase58())).toEqual(tableAddresses.map((k) => k.toBase58()))
    expect(table.state.addresses.map((k) => k.toBase58())).toEqual(tableAddresses.map((k) => k.toBase58()))
    expect(AddressLookupTableProgram.programId.toBase58()).toBe(ADDRESS_LOOKUP_TABLE_PROGRAM_ID)
  })

  test("static, then loaded writable, then loaded readonly, element for element", async () => {
    const decoded = decodeTransaction(wire)
    expect(decoded.message.version).toBe(0)
    expect(decoded.message.lookups).toHaveLength(1)
    expect(decoded.message.lookups[0]?.table).toBe(tableKey.toBase58())
    const rpc = rpcWith({
      [tableKey.toBase58()]: {
        owner: ADDRESS_LOOKUP_TABLE_PROGRAM_ID,
        lamports: 1n,
        data: lookupTableData(tableAddresses),
      },
    })
    const compiled = await resolveCompiledKeys(decoded.message, rpc)
    const oracle = message.getAccountKeys({ addressLookupTableAccounts: [table] })
    const expected = oracle.keySegments().flatMap((segment) => segment.map((key) => key.toBase58()))
    expect(compiled.keys).toEqual(expected)
    expect(compiled.staticCount).toBe(message.staticAccountKeys.length)
    // The loaded segment: writable first (C, A in instruction order), then readonly (B).
    expect(compiled.keys.slice(compiled.staticCount)).toEqual([loadedC, loadedA, loadedB].map((k) => k.toBase58()))
    expect(compiled.isWritable.slice(compiled.staticCount)).toEqual([true, true, false])
    // A permutation of the same set is a different answer.
    expect(compiled.keys).not.toEqual([...compiled.keys].reverse())
    // Every instruction index resolves to the key web3.js resolves it to.
    for (const [i, instruction] of decoded.message.instructions.entries()) {
      const theirs = message.compiledInstructions[i]
      expect(instruction.accountIndexes.map((n) => compiled.keys[n])).toEqual(
        (theirs?.accountKeyIndexes ?? []).map((n) => oracle.get(n)?.toBase58()),
      )
    }
  })

  test("an unfetchable table, a non-table account, and an index past the end are each LookupTableError", async () => {
    const decoded = decodeTransaction(wire)
    await expect(resolveCompiledKeys(decoded.message, rpcWith({}))).rejects.toThrow(LookupTableError)
    await expect(
      resolveCompiledKeys(
        decoded.message,
        rpcWith({
          [tableKey.toBase58()]: { owner: TOKEN_PROGRAM_ID, lamports: 1n, data: lookupTableData(tableAddresses) },
        }),
      ),
    ).rejects.toThrow(/not a lookup table/)
    await expect(
      resolveCompiledKeys(
        decoded.message,
        rpcWith({
          [tableKey.toBase58()]: {
            owner: ADDRESS_LOOKUP_TABLE_PROGRAM_ID,
            lamports: 1n,
            data: lookupTableData([loadedA]),
          },
        }),
      ),
    ).rejects.toThrow(/indexes/)
    const failing = rpcWith({})
    failing.getMultipleAccounts = async () => {
      throw new Error("connection refused")
    }
    await expect(resolveCompiledKeys(decoded.message, failing)).rejects.toThrow(LookupTableError)
  })

  test("the message bytes are exactly what web3.js signs, and a signature attaches in place", () => {
    const decoded = decodeTransaction(wire)
    expect(Array.from(decoded.message.bytes)).toEqual(Array.from(message.serialize()))
    const signedTx = new VersionedTransaction(message)
    signedTx.sign([payer])
    const ours = attachSignatures(decoded, new Map([[0, signedTx.signatures[0] as Uint8Array]]))
    expect(Array.from(ours)).toEqual(Array.from(signedTx.serialize()))
  })
})

describe("deltas", () => {
  function tokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint): AccountView {
    const data = new Uint8Array(165)
    data.set(mint.toBytes(), 0)
    data.set(owner.toBytes(), 32)
    new DataView(data.buffer).setBigUint64(64, amount, true)
    data[108] = 1
    return { owner: TOKEN_PROGRAM_ID, lamports: 2_039_280n, data }
  }

  test("a token account's mint, owner and amount are read; a system account is not a token account", () => {
    const mint = Keypair.generate().publicKey
    const view = tokenAccount(mint, other.publicKey, 42n)
    expect(tokenBalanceOf(view)).toEqual({
      mint: mint.toBase58(),
      owner: other.publicKey.toBase58(),
      amount: 42n,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    expect(
      tokenBalanceOf({ owner: SystemProgram.programId.toBase58(), lamports: 1n, data: new Uint8Array(0) }),
    ).toBeUndefined()
    expect(tokenBalanceOf(null)).toBeUndefined()
  })

  test("lamport and token deltas per writable account, a created account counted from zero", () => {
    const mint = Keypair.generate().publicKey
    const ata = Keypair.generate().publicKey.toBase58()
    const deltas = computeDeltas([
      {
        address: payer.publicKey.toBase58(),
        before: { owner: SystemProgram.programId.toBase58(), lamports: 10n, data: new Uint8Array(0) },
        after: { owner: SystemProgram.programId.toBase58(), lamports: 4n, data: new Uint8Array(0) },
      },
      { address: ata, before: null, after: tokenAccount(mint, other.publicKey, 5n) },
    ])
    expect(deltas.sol).toEqual([
      { address: payer.publicKey.toBase58(), before: 10n, after: 4n },
      { address: ata, before: 0n, after: 2_039_280n },
    ])
    expect(deltas.tokens).toEqual([
      {
        account: ata,
        owner: other.publicKey.toBase58(),
        mint: mint.toBase58(),
        tokenProgram: TOKEN_PROGRAM_ID,
        before: 0n,
        after: 5n,
      },
    ])
  })
})
