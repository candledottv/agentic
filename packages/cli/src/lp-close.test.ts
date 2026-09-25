/**
 * Ember Phase 3 PR D, CLI half (BE-315, P3-ED-6): the close-build verifier, against `@solana/web3.js`
 * as the independent oracle for the v0 wire format (the CLI package ships no Solana runtime).
 *
 * The fixture is the honest shape a DAMM v2 `removeAllLiquidityAndClosePosition` compiles to: a
 * Compute Budget instruction, an idempotent create of the TEE wallet's missing token-A account,
 * and one DAMM v2 instruction over the pool, the position, the pool's two token vaults (token
 * accounts whose authority is the DAMM-owned pool), the wallet's two token accounts, the position
 * NFT account and mint, and the wallet as the single signer. The simulation answers with the NFT
 * account gone, the wallet's accounts credited and the pool vaults debited. Every refusal case is
 * that fixture with exactly one thing changed, so the test says which check caught it.
 */
import { describe, expect, test } from "bun:test"
import {
  AuthorityType,
  createApproveInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSetAuthorityInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID as SPL_ATA,
  TOKEN_PROGRAM_ID as SPL_TOKEN,
  TOKEN_2022_PROGRAM_ID as SPL_TOKEN_2022,
} from "@solana/spl-token"
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js"
import {
  type CloseArtifact,
  DAMM_V2_PROGRAM_ID,
  describeClose,
  isMintAccount,
  isPositionCandidate,
  parseCloseArtifact,
  verifyCloseArtifact,
} from "./lp-close"
import { COMPUTE_BUDGET_PROGRAM_ID, MEMO_PROGRAM_ID } from "./solana-alt"
import {
  type AccountView,
  type SolanaRpc,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./solana-lite"

const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"
const DAMM = new PublicKey(DAMM_V2_PROGRAM_ID)

const tee = Keypair.generate()
const vault = Keypair.generate().publicKey
const stranger = Keypair.generate().publicKey
const pool = Keypair.generate().publicKey
const position = Keypair.generate().publicKey
const mintA = Keypair.generate().publicKey
const mintB = Keypair.generate().publicKey
const nftMint = Keypair.generate().publicKey
const vaultA = Keypair.generate().publicKey
const vaultB = Keypair.generate().publicKey
const teeAtaA = getAssociatedTokenAddressSync(mintA, tee.publicKey, false, SPL_TOKEN)
const teeAtaB = getAssociatedTokenAddressSync(mintB, tee.publicKey, false, SPL_TOKEN)
const nftAccount = getAssociatedTokenAddressSync(nftMint, tee.publicKey, false, SPL_TOKEN_2022)
const strangerAta = getAssociatedTokenAddressSync(mintB, stranger, false, SPL_TOKEN)

// ── account bytes ─────────────────────────────────────────────────────────────────────────────

function mintBytes(decimals: number): Uint8Array {
  const data = new Uint8Array(82)
  data[44] = decimals
  data[45] = 1
  return data
}

function tokenAccountBytes(mint: PublicKey, owner: PublicKey, amount: bigint): Uint8Array {
  const data = new Uint8Array(165)
  data.set(mint.toBytes(), 0)
  data.set(owner.toBytes(), 32)
  new DataView(data.buffer).setBigUint64(64, amount, true)
  data[108] = 1
  return data
}

const view = (owner: string, data: Uint8Array, lamports = 2_039_280n): AccountView => ({ owner, lamports, data })
const system = (lamports: bigint): AccountView => ({ owner: SYSTEM_PROGRAM_ID, lamports, data: new Uint8Array(0) })
const damm = (): AccountView => ({ owner: DAMM_V2_PROGRAM_ID, lamports: 5_000_000n, data: new Uint8Array(200) })

/** The chain before the close, keyed by address. */
function preState(): Record<string, AccountView | null> {
  return {
    [tee.publicKey.toBase58()]: system(50_000_000n),
    [vault.toBase58()]: system(1_000_000_000n),
    [pool.toBase58()]: damm(),
    [position.toBase58()]: damm(),
    [mintA.toBase58()]: view(TOKEN_PROGRAM_ID, mintBytes(9)),
    [mintB.toBase58()]: view(TOKEN_PROGRAM_ID, mintBytes(6)),
    [nftMint.toBase58()]: view(TOKEN_2022_PROGRAM_ID, mintBytes(0)),
    [vaultA.toBase58()]: view(TOKEN_PROGRAM_ID, tokenAccountBytes(mintA, pool, 1_000_000_000n)),
    [vaultB.toBase58()]: view(TOKEN_PROGRAM_ID, tokenAccountBytes(mintB, pool, 5_000_000n)),
    // teeAtaA does not exist yet: the close creates it (the canonical missing-ATA case).
    [teeAtaB.toBase58()]: view(TOKEN_PROGRAM_ID, tokenAccountBytes(mintB, tee.publicKey, 10n)),
    [nftAccount.toBase58()]: view(TOKEN_2022_PROGRAM_ID, tokenAccountBytes(nftMint, tee.publicKey, 1n)),
    [strangerAta.toBase58()]: view(TOKEN_PROGRAM_ID, tokenAccountBytes(mintB, stranger, 0n)),
  }
}

/** The honest outcome: the NFT account and the position are gone, the wallet is credited, the vaults debited. */
function postState(): Record<string, AccountView | null> {
  return {
    [tee.publicKey.toBase58()]: system(50_000_000n + 3_000_000n),
    [position.toBase58()]: null,
    [nftAccount.toBase58()]: null,
    [vaultA.toBase58()]: view(TOKEN_PROGRAM_ID, tokenAccountBytes(mintA, pool, 900_000_000n)),
    [vaultB.toBase58()]: view(TOKEN_PROGRAM_ID, tokenAccountBytes(mintB, pool, 4_500_000n)),
    [teeAtaA.toBase58()]: view(TOKEN_PROGRAM_ID, tokenAccountBytes(mintA, tee.publicKey, 100_000_000n)),
    [teeAtaB.toBase58()]: view(TOKEN_PROGRAM_ID, tokenAccountBytes(mintB, tee.publicKey, 500_010n)),
    [nftMint.toBase58()]: view(TOKEN_2022_PROGRAM_ID, mintBytes(0)),
  }
}

// ── the fake RPC ──────────────────────────────────────────────────────────────────────────────

interface FakeRpc {
  rpc: SolanaRpc
  calls: string[]
}

function fakeRpc(input: {
  pre?: Record<string, AccountView | null>
  post?: Record<string, AccountView | null>
  err?: unknown
}): FakeRpc {
  const pre = input.pre ?? preState()
  const post = input.post ?? postState()
  const calls: string[] = []
  const refuse = (name: string) => () => {
    calls.push(name)
    throw new Error(`${name} must not be called by the verifier`)
  }
  const rpc: SolanaRpc = {
    getLatestBlockhash: refuse("getLatestBlockhash"),
    getBalance: refuse("getBalance"),
    getTokenAccountsByOwner: refuse("getTokenAccountsByOwner"),
    getFeeForMessage: refuse("getFeeForMessage"),
    getMinimumBalanceForRentExemption: refuse("getMinimumBalanceForRentExemption"),
    sendTransaction: refuse("sendTransaction"),
    getSignatureStatus: refuse("getSignatureStatus"),
    isBlockhashValid: refuse("isBlockhashValid"),
    hasSignatureHistory: refuse("hasSignatureHistory"),
    getProgramAccounts: refuse("getProgramAccounts"),
    getProgramAccountsV2: refuse("getProgramAccountsV2"),
    getTokenSupply: refuse("getTokenSupply"),
    getEpoch: refuse("getEpoch"),
    getAccountInfo: async (address) => {
      calls.push(`getAccountInfo ${address}`)
      return pre[address] ?? null
    },
    getMultipleAccounts: async (addresses) => {
      calls.push("getMultipleAccounts")
      return addresses.map((address) => pre[address] ?? null)
    },
    simulateTransaction: async (_tx, addresses) => {
      calls.push("simulateTransaction")
      return {
        err: input.err ?? null,
        logs: [],
        accounts: addresses.map((address) => (address in post ? post[address] : pre[address]) ?? null),
      }
    },
  }
  return { rpc, calls }
}

// ── the artifact ──────────────────────────────────────────────────────────────────────────────

function closeInstruction(keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>) {
  return new TransactionInstruction({ programId: DAMM, keys, data: Buffer.from([7, 7, 7, 7, 7, 7, 7, 7]) })
}

function honestInstructions(): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    createAssociatedTokenAccountIdempotentInstruction(tee.publicKey, teeAtaA, tee.publicKey, mintA),
    closeInstruction([
      { pubkey: tee.publicKey, isSigner: true, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: vaultA, isSigner: false, isWritable: true },
      { pubkey: vaultB, isSigner: false, isWritable: true },
      { pubkey: teeAtaA, isSigner: false, isWritable: true },
      { pubkey: teeAtaB, isSigner: false, isWritable: true },
      { pubkey: nftAccount, isSigner: false, isWritable: true },
      { pubkey: nftMint, isSigner: false, isWritable: true },
      { pubkey: mintA, isSigner: false, isWritable: false },
      { pubkey: mintB, isSigner: false, isWritable: false },
      { pubkey: SPL_TOKEN, isSigner: false, isWritable: false },
      { pubkey: SPL_TOKEN_2022, isSigner: false, isWritable: false },
    ]),
  ]
}

/** What close-build returns: the unsigned v0 transaction and its keys in compiled order. */
function artifactFor(
  instructions: TransactionInstruction[],
  opts: { payer?: PublicKey; tables?: AddressLookupTableAccount[]; sign?: Keypair } = {},
): CloseArtifact {
  const message = new TransactionMessage({
    payerKey: opts.payer ?? tee.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions,
  }).compileToV0Message(opts.tables ?? [])
  const tx = new VersionedTransaction(message)
  if (opts.sign) tx.sign([opts.sign])
  const keys = message.getAccountKeys({ addressLookupTableAccounts: opts.tables ?? [] })
  return {
    transaction: Buffer.from(tx.serialize()).toString("base64"),
    accountKeys: keys.keySegments().flatMap((segment) => segment.map((key) => key.toBase58())),
  }
}

function verify(artifact: CloseArtifact, fake: FakeRpc) {
  return verifyCloseArtifact({
    artifact,
    rpc: fake.rpc,
    tee: tee.publicKey.toBase58(),
    vault: vault.toBase58(),
    nftMint: nftMint.toBase58(),
    nftAccount: nftAccount.toBase58(),
  })
}

async function refusal(artifact: CloseArtifact, fake: FakeRpc = fakeRpc({})): Promise<string> {
  const verdict = await verify(artifact, fake)
  expect(verdict.ok).toBe(false)
  expect(fake.calls).not.toContain("sendTransaction")
  return verdict.ok ? "" : verdict.reason
}

// ── tests ─────────────────────────────────────────────────────────────────────────────────────

describe("a position NFT candidate is Token-2022 with raw amount 1 AND decimals 0", () => {
  test("both conditions, so raw-unit fungible dust and a classic NFT stay on the generic path", () => {
    expect(isPositionCandidate({ programId: TOKEN_2022_PROGRAM_ID, amountRaw: "1", decimals: 0 })).toBe(true)
    expect(isPositionCandidate({ programId: TOKEN_2022_PROGRAM_ID, amountRaw: "1", decimals: 6 })).toBe(false)
    expect(isPositionCandidate({ programId: TOKEN_2022_PROGRAM_ID, amountRaw: "5", decimals: 0 })).toBe(false)
    expect(isPositionCandidate({ programId: TOKEN_2022_PROGRAM_ID, amountRaw: "0", decimals: 0 })).toBe(false)
    expect(isPositionCandidate({ programId: TOKEN_PROGRAM_ID, amountRaw: "1", decimals: 0 })).toBe(false)
  })

  test("parseCloseArtifact takes exactly the two fields close-build returns", () => {
    expect(parseCloseArtifact({ transaction: "AQ==", accountKeys: ["a", "b"] })).toEqual({
      transaction: "AQ==",
      accountKeys: ["a", "b"],
    })
    expect(parseCloseArtifact({ transaction: "AQ==" })).toBeUndefined()
    expect(parseCloseArtifact({ transaction: "", accountKeys: [] })).toBeUndefined()
    expect(parseCloseArtifact({ transaction: "AQ==", accountKeys: [1] })).toBeUndefined()
    expect(parseCloseArtifact(null)).toBeUndefined()
  })

  test("a mint is told from a token account and a multisig by layout, under either program", () => {
    expect(isMintAccount(view(TOKEN_PROGRAM_ID, mintBytes(6)))).toBe(true)
    expect(isMintAccount(view(TOKEN_2022_PROGRAM_ID, mintBytes(0)))).toBe(true)
    const extended = new Uint8Array(200)
    extended.set(mintBytes(0), 0)
    extended[165] = 1
    expect(isMintAccount(view(TOKEN_2022_PROGRAM_ID, extended))).toBe(true)
    extended[165] = 2
    expect(isMintAccount(view(TOKEN_2022_PROGRAM_ID, extended))).toBe(false)
    expect(isMintAccount(view(TOKEN_PROGRAM_ID, tokenAccountBytes(mintA, tee.publicKey, 1n)))).toBe(false)
    expect(isMintAccount(view(TOKEN_PROGRAM_ID, new Uint8Array(355)))).toBe(false)
    expect(isMintAccount(view(DAMM_V2_PROGRAM_ID, mintBytes(6)))).toBe(false)
    expect(isMintAccount(null)).toBe(false)
  })
})

describe("the honest close is accepted, after every check", () => {
  test("DAMM-controlled pool vaults plus a missing canonical TEE ATA pass a clean simulation", async () => {
    const artifact = artifactFor(honestInstructions())
    const fake = fakeRpc({})
    const verdict = await verify(artifact, fake)
    expect(verdict.ok ? "ok" : verdict.reason).toBe("ok")
    if (!verdict.ok) return
    // The ordered array is what the server sent, element for element; static keys only here, as
    // the server compiles these closes without lookup tables.
    expect(verdict.compiled.keys).toEqual(artifact.accountKeys)
    expect(verdict.compiled.staticCount).toBe(artifact.accountKeys.length)
    expect(verdict.tx.message.version).toBe(0)
    // Simulation ran before any signing could, and nothing was sent.
    expect(fake.calls).toContain("simulateTransaction")
    expect(fake.calls).not.toContain("sendTransaction")
    // The message bytes the caller will sign are the ones web3.js compiled.
    const oracle = VersionedTransaction.deserialize(Buffer.from(artifact.transaction, "base64"))
    expect(Array.from(verdict.tx.message.bytes)).toEqual(Array.from(oracle.message.serialize()))
  })

  test("a v0 artifact with a lookup table is accepted once the table resolves, in compiled order", async () => {
    const tableKey = Keypair.generate().publicKey
    const table = new AddressLookupTableAccount({
      key: tableKey,
      state: {
        deactivationSlot: 0xffffffffffffffffn,
        lastExtendedSlot: 100,
        lastExtendedSlotStartIndex: 0,
        authority: tee.publicKey,
        addresses: [pool, vaultA, vaultB, mintA, mintB],
      },
    })
    const tableData = new Uint8Array(56 + 32 * 5)
    const dv = new DataView(tableData.buffer)
    dv.setUint32(0, 1, true)
    dv.setBigUint64(4, 0xffffffffffffffffn, true)
    dv.setBigUint64(12, 100n, true)
    tableData[21] = 1
    tableData.set(tee.publicKey.toBytes(), 22)
    for (const [i, address] of [pool, vaultA, vaultB, mintA, mintB].entries())
      tableData.set(address.toBytes(), 56 + 32 * i)
    const artifact = artifactFor(honestInstructions(), { tables: [table] })
    const pre = {
      ...preState(),
      [tableKey.toBase58()]: view("AddressLookupTab1e1111111111111111111111111", tableData, 1n),
    }
    const verdict = await verify(artifact, fakeRpc({ pre }))
    expect(verdict.ok ? "ok" : verdict.reason).toBe("ok")
    if (!verdict.ok) return
    expect(verdict.compiled.keys).toEqual(artifact.accountKeys)
    expect(verdict.compiled.staticCount).toBeLessThan(artifact.accountKeys.length)

    // The same artifact with the server's array as a permutation (a set-equal answer) is refused.
    const permuted = { ...artifact, accountKeys: [...artifact.accountKeys].reverse() }
    expect(await refusal(permuted, fakeRpc({ pre }))).toMatch(/account key 0 is/)
    // And with a table the RPC does not have, it is refused for the table, not for the keys.
    expect(await refusal(artifact, fakeRpc({}))).toMatch(/lookup table could not be resolved/)
  })
})

describe("every refusal happens before a signature, and names its check", () => {
  test("a permuted server key array (same set, other order) is refused", async () => {
    const artifact = artifactFor(honestInstructions())
    const keys = [...artifact.accountKeys]
    ;[keys[1], keys[2]] = [keys[2] as string, keys[1] as string]
    expect(await refusal({ ...artifact, accountKeys: keys })).toMatch(
      /account key 1 is .* in the server's ordered array/,
    )
    expect(await refusal({ ...artifact, accountKeys: keys.slice(0, -1) })).toMatch(/listed \d+ account keys/)
  })

  test("a fee payer other than the TEE wallet is refused", async () => {
    const other = Keypair.generate()
    const instructions = honestInstructions()
    // The stranger is the one signer: it pays the ATA creation, and the wallet appears in the
    // close without signing, so the transaction requires exactly one signature and that signer
    // is what the check reads.
    instructions[1] = createAssociatedTokenAccountIdempotentInstruction(other.publicKey, teeAtaA, tee.publicKey, mintA)
    for (const key of (instructions[2] as TransactionInstruction).keys)
      if (key.pubkey.equals(tee.publicKey)) key.isSigner = false
    const artifact = artifactFor(instructions, { payer: other.publicKey })
    expect(await refusal(artifact)).toMatch(/fee payer is .* not the TEE wallet/)
  })

  test("an artifact that already carries a signature, a legacy message, and undecodable bytes are refused", async () => {
    expect(await refusal(artifactFor(honestInstructions(), { sign: tee }))).toMatch(/already carries a signature/)
    const legacy = new Transaction({ feePayer: tee.publicKey, recentBlockhash: BLOCKHASH }).add(...honestInstructions())
    const wire = legacy.serialize({ requireAllSignatures: false, verifySignatures: false })
    const keys = legacy.compileMessage().accountKeys.map((key) => key.toBase58())
    expect(await refusal({ transaction: Buffer.from(wire).toString("base64"), accountKeys: keys })).toMatch(/not a v0/)
    expect(await refusal({ transaction: "not base64!", accountKeys: [] })).toMatch(/undecodable/)
    expect(await refusal({ transaction: "AQID", accountKeys: [] })).toMatch(/undecodable/)
  })

  test("an extra program outside the allowlist is refused, and so is a transaction with no DAMM call", async () => {
    const memo = new TransactionInstruction({
      programId: new PublicKey(MEMO_PROGRAM_ID),
      keys: [],
      data: Buffer.from("hi"),
    })
    expect(await refusal(artifactFor([...honestInstructions(), memo]))).toMatch(
      /instruction 3 calls .* which a position close never does/,
    )
    const noDamm = artifactFor(honestInstructions().slice(0, 2))
    expect(await refusal(noDamm)).toMatch(/no DAMM v2 instruction/)
  })

  test("a failing simulation, or one that cannot be run, is refused with no override", async () => {
    const artifact = artifactFor(honestInstructions())
    expect(await refusal(artifact, fakeRpc({ err: { InstructionError: [2, "Custom"] } }))).toMatch(/simulation failed/)
    const down = fakeRpc({})
    down.rpc.simulateTransaction = async () => {
      throw new Error("connection refused")
    }
    expect(await refusal(artifact, down)).toMatch(/simulation could not be run: connection refused/)
  })

  test("a still-held NFT after the simulation is refused", async () => {
    const post = {
      ...postState(),
      [nftAccount.toBase58()]: view(TOKEN_2022_PROGRAM_ID, tokenAccountBytes(nftMint, tee.publicKey, 1n)),
    }
    expect(await refusal(artifactFor(honestInstructions()), fakeRpc({ post }))).toMatch(/still holds 1/)
  })

  test("a positive delta to anyone but the wallet or the vault is refused, in tokens and in lamports", async () => {
    const instructions = honestInstructions()
    const close = instructions[2] as TransactionInstruction
    close.keys.push({ pubkey: strangerAta, isSigner: false, isWritable: true })
    const gains = {
      ...postState(),
      [strangerAta.toBase58()]: view(TOKEN_PROGRAM_ID, tokenAccountBytes(mintB, stranger, 1n)),
    }
    expect(await refusal(artifactFor(instructions), fakeRpc({ post: gains }))).toMatch(/would receive 1 raw of/)
    const lamportsTo = honestInstructions()
    ;(lamportsTo[2] as TransactionInstruction).keys.push({ pubkey: stranger, isSigner: false, isWritable: true })
    const pre = { ...preState(), [stranger.toBase58()]: system(1n) }
    const post = { ...postState(), [stranger.toBase58()]: system(1_000_001n) }
    expect(await refusal(artifactFor(lamportsTo), fakeRpc({ pre, post }))).toMatch(/would receive 1000000 lamports/)
  })

  test("a third-party ATA in the account list is refused before signing, with only DAMM + Compute Budget on top", async () => {
    // The CPI-drain shape: nothing suspicious in the top-level programs, and a stranger's token
    // account among the writable keys. The simulation is scripted clean (no gain shows), so this
    // is the classification catching it, not the delta check.
    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      closeInstruction([
        { pubkey: tee.publicKey, isSigner: true, isWritable: true },
        { pubkey: pool, isSigner: false, isWritable: true },
        { pubkey: position, isSigner: false, isWritable: true },
        { pubkey: vaultA, isSigner: false, isWritable: true },
        { pubkey: vaultB, isSigner: false, isWritable: true },
        { pubkey: teeAtaB, isSigner: false, isWritable: true },
        { pubkey: strangerAta, isSigner: false, isWritable: true },
        { pubkey: nftAccount, isSigner: false, isWritable: true },
        { pubkey: nftMint, isSigner: false, isWritable: true },
        { pubkey: mintB, isSigner: false, isWritable: false },
        { pubkey: SPL_TOKEN, isSigner: false, isWritable: false },
        { pubkey: SPL_TOKEN_2022, isSigner: false, isWritable: false },
      ]),
    ]
    const post = { ...postState() }
    delete post[teeAtaA.toBase58()]
    expect(await refusal(artifactFor(instructions), fakeRpc({ post }))).toMatch(
      new RegExp(`writable token account ${strangerAta.toBase58()} is controlled by ${stranger.toBase58()}`),
    )
  })

  test("a missing writable key that is not a canonical TEE or vault ATA is refused", async () => {
    const instructions = honestInstructions()
    const phantom = Keypair.generate().publicKey
    ;(instructions[2] as TransactionInstruction).keys.push({ pubkey: phantom, isSigner: false, isWritable: true })
    expect(await refusal(artifactFor(instructions))).toMatch(
      new RegExp(
        `writable account ${phantom.toBase58()} does not exist and is not a TEE or vault associated token account`,
      ),
    )
    // Whereas the vault's own missing ATA for a named mint is exactly the admitted case.
    const vaultAtaA = getAssociatedTokenAddressSync(mintA, vault, false, SPL_TOKEN)
    const withVaultAta = honestInstructions()
    ;(withVaultAta[2] as TransactionInstruction).keys.push({ pubkey: vaultAtaA, isSigner: false, isWritable: true })
    const verdict = await verify(artifactFor(withVaultAta), fakeRpc({}))
    expect(verdict.ok ? "ok" : verdict.reason).toBe("ok")
  })

  test("a writable account owned by an unknown program, and a system account that is a stranger, are refused", async () => {
    const foreign = Keypair.generate().publicKey
    const instructions = honestInstructions()
    ;(instructions[2] as TransactionInstruction).keys.push({ pubkey: foreign, isSigner: false, isWritable: true })
    const owned = { ...preState(), [foreign.toBase58()]: view(MEMO_PROGRAM_ID, new Uint8Array(8), 1n) }
    expect(await refusal(artifactFor(instructions), fakeRpc({ pre: owned }))).toMatch(
      new RegExp(`writable account ${foreign.toBase58()} is owned by ${MEMO_PROGRAM_ID}, not DAMM v2`),
    )
    const asSystem = { ...preState(), [foreign.toBase58()]: system(1n) }
    expect(await refusal(artifactFor(instructions), fakeRpc({ pre: asSystem }))).toMatch(
      /writable system account .* is neither the TEE wallet nor its vault/,
    )
    // A token vault whose authority is NOT a DAMM-owned account (a stranger's pool) is a
    // third-party token account, whatever its lamports do.
    const strangerPool = Keypair.generate().publicKey
    const hijacked = {
      ...preState(),
      [strangerPool.toBase58()]: system(1n),
      [vaultA.toBase58()]: view(TOKEN_PROGRAM_ID, tokenAccountBytes(mintA, strangerPool, 1_000_000_000n)),
    }
    expect(await refusal(artifactFor(honestInstructions()), fakeRpc({ pre: hijacked }))).toMatch(
      new RegExp(`writable token account ${vaultA.toBase58()} is controlled by ${strangerPool.toBase58()}`),
    )
  })

  test("a writable mint that is not the named position NFT mint is refused (it is not a token account)", async () => {
    const instructions = honestInstructions()
    const close = instructions[2] as TransactionInstruction
    const entry = close.keys.find((key) => key.pubkey.equals(mintA))
    if (entry) entry.isWritable = true
    expect(await refusal(artifactFor(instructions))).toMatch(
      new RegExp(`writable account ${mintA.toBase58()} is owned by a token program but is not a token account`),
    )
  })

  test("the NFT account absent from the writable keys is refused: nothing could have closed it", async () => {
    const instructions = honestInstructions()
    const close = instructions[2] as TransactionInstruction
    close.keys = close.keys.filter((key) => !key.pubkey.equals(nftAccount))
    expect(await refusal(artifactFor(instructions))).toMatch(
      /position NFT account .* is not written by this transaction/,
    )
  })

  test("more than one required signer is refused", async () => {
    const other = Keypair.generate()
    const instructions = honestInstructions()
    ;(instructions[2] as TransactionInstruction).keys.push({
      pubkey: other.publicKey,
      isSigner: true,
      isWritable: false,
    })
    expect(await refusal(artifactFor(instructions))).toMatch(/requires 2 signers/)
  })

  test("the Compute Budget and System programs are on the allowlist by their ids", () => {
    expect(COMPUTE_BUDGET_PROGRAM_ID).toBe(ComputeBudgetProgram.programId.toBase58())
    expect(SPL_ATA.toBase58()).toBe("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
  })
})

/**
 * Security review of `1ec0ad10` (H1): an honest close plus one extra top-level instruction that
 * moves no balance but transfers CONTROL of a wallet account. The positive-delta check and the
 * pre-state classification cannot see it; the post-simulation control invariant and the
 * per-instruction allowlist both must. Each case asserts refusal, and asserts it through the
 * invariant alone as well, by hiding the instruction inside the DAMM call (the CPI shape), so a
 * future loosening of the allowlist cannot reopen the hole.
 */
describe("H1: control of a wallet account never changes hands, with or without the instruction in sight", () => {
  const mintC = Keypair.generate().publicKey
  const teeAtaC = getAssociatedTokenAddressSync(mintC, tee.publicKey, false, SPL_TOKEN)
  const strangerProgram = Keypair.generate().publicKey
  const BIG = 5_000_000_000n

  function delegated(mint: PublicKey, owner: PublicKey, amount: bigint, delegate: PublicKey): Uint8Array {
    const data = tokenAccountBytes(mint, owner, amount)
    data[72] = 1
    data.set(delegate.toBytes(), 76)
    new DataView(data.buffer).setBigUint64(121, 0xffffffffffffffffn, true)
    return data
  }
  /** The honest fixture plus the wallet's big classic-token account, which the close never touches. */
  function pre(): Record<string, AccountView | null> {
    return {
      ...preState(),
      [mintC.toBase58()]: view(TOKEN_PROGRAM_ID, mintBytes(6)),
      [teeAtaC.toBase58()]: view(TOKEN_PROGRAM_ID, tokenAccountBytes(mintC, tee.publicKey, BIG)),
    }
  }
  /** The same effect reached by CPI: the extra account rides inside the DAMM instruction's keys. */
  function viaDamm(extra: PublicKey): TransactionInstruction[] {
    const instructions = honestInstructions()
    ;(instructions[2] as TransactionInstruction).keys.push({ pubkey: extra, isSigner: false, isWritable: true })
    return instructions
  }

  test("SetAuthority(AccountOwner -> stranger) on an untouched wallet token account is refused", async () => {
    const post = {
      ...postState(),
      [teeAtaC.toBase58()]: view(TOKEN_PROGRAM_ID, tokenAccountBytes(mintC, stranger, BIG)),
    }
    const topLevel = [
      ...honestInstructions(),
      createSetAuthorityInstruction(teeAtaC, tee.publicKey, AuthorityType.AccountOwner, stranger, [], SPL_TOKEN),
    ]
    expect(await refusal(artifactFor(topLevel), fakeRpc({ pre: pre(), post }))).toMatch(
      /instruction 3 is a token instruction other than CloseAccount/,
    )
    expect(await refusal(artifactFor(viaDamm(teeAtaC)), fakeRpc({ pre: pre(), post }))).toMatch(
      new RegExp(`token account ${teeAtaC.toBase58()} would change its authority`),
    )
  })

  test("Approve(delegate stranger, u64::MAX) on the wallet's token account is refused", async () => {
    const post = {
      ...postState(),
      [teeAtaB.toBase58()]: view(TOKEN_PROGRAM_ID, delegated(mintB, tee.publicKey, 500_010n, stranger)),
    }
    const topLevel = [
      ...honestInstructions(),
      createApproveInstruction(teeAtaB, stranger, tee.publicKey, 0xffffffffffffffffn, [], SPL_TOKEN),
    ]
    expect(await refusal(artifactFor(topLevel), fakeRpc({ post }))).toMatch(
      /instruction 3 is a token instruction other than CloseAccount/,
    )
    expect(await refusal(artifactFor(honestInstructions()), fakeRpc({ post }))).toMatch(
      new RegExp(`token account ${teeAtaB.toBase58()} would change its delegate`),
    )
  })

  test("System Assign(wallet -> stranger program) is refused", async () => {
    const post = {
      ...postState(),
      [tee.publicKey.toBase58()]: { owner: strangerProgram.toBase58(), lamports: 53_000_000n, data: new Uint8Array(0) },
    }
    const topLevel = [
      ...honestInstructions(),
      SystemProgram.assign({ accountPubkey: tee.publicKey, programId: strangerProgram }),
    ]
    expect(await refusal(artifactFor(topLevel), fakeRpc({ post }))).toMatch(
      /instruction 3 is a top-level System instruction/,
    )
    expect(await refusal(artifactFor(honestInstructions()), fakeRpc({ post }))).toMatch(
      /the TEE wallet would no longer be a plain System account/,
    )
  })

  test("a simulation that deletes the TEE wallet or the vault is refused", async () => {
    expect(
      await refusal(
        artifactFor(honestInstructions()),
        fakeRpc({ post: { ...postState(), [tee.publicKey.toBase58()]: null } }),
      ),
    ).toMatch(/the TEE wallet would no longer be a plain System account/)
    expect(
      await refusal(artifactFor(viaDamm(vault)), fakeRpc({ post: { ...postState(), [vault.toBase58()]: null } })),
    ).toMatch(/the vault would no longer be a plain System account/)
  })

  test("a close authority, a frozen state, or a changed mint on a wallet token account is refused; a writable account changing owner too", async () => {
    const closeAuthority = tokenAccountBytes(mintB, tee.publicKey, 500_010n)
    closeAuthority[129] = 1
    closeAuthority.set(stranger.toBytes(), 133)
    expect(
      await refusal(
        artifactFor(honestInstructions()),
        fakeRpc({ post: { ...postState(), [teeAtaB.toBase58()]: view(TOKEN_PROGRAM_ID, closeAuthority) } }),
      ),
    ).toMatch(/would change its close authority/)
    const frozen = tokenAccountBytes(mintB, tee.publicKey, 500_010n)
    frozen[108] = 2
    expect(
      await refusal(
        artifactFor(honestInstructions()),
        fakeRpc({ post: { ...postState(), [teeAtaB.toBase58()]: view(TOKEN_PROGRAM_ID, frozen) } }),
      ),
    ).toMatch(/would change its state/)
    expect(
      await refusal(
        artifactFor(honestInstructions()),
        fakeRpc({ post: { ...postState(), [vaultA.toBase58()]: view(MEMO_PROGRAM_ID, new Uint8Array(165)) } }),
      ),
    ).toMatch(new RegExp(`writable account ${vaultA.toBase58()} would change owner`))
    // A token account the close creates for the wallet must start clean.
    const createdDelegated = delegated(mintA, tee.publicKey, 100_000_000n, stranger)
    expect(
      await refusal(
        artifactFor(honestInstructions()),
        fakeRpc({ post: { ...postState(), [teeAtaA.toBase58()]: view(TOKEN_PROGRAM_ID, createdDelegated) } }),
      ),
    ).toMatch(/created token account .* would start with a delegate/)
  })

  test("the per-instruction allowlist: Transfer, a stranger's ATA create and a close to a stranger are refused; the wSOL unwrap is admitted", async () => {
    const strangerAtaB = getAssociatedTokenAddressSync(mintB, stranger, false, SPL_TOKEN)
    expect(
      await refusal(
        artifactFor([
          ...honestInstructions(),
          createTransferInstruction(teeAtaB, strangerAtaB, tee.publicKey, 1n, [], SPL_TOKEN),
        ]),
      ),
    ).toMatch(/instruction 3 is a token instruction other than CloseAccount/)
    const strangerCreate = honestInstructions()
    strangerCreate[1] = createAssociatedTokenAccountIdempotentInstruction(tee.publicKey, strangerAtaB, stranger, mintB)
    expect(await refusal(artifactFor(strangerCreate))).toMatch(/instruction 1 creates a token account for/)
    expect(
      await refusal(
        artifactFor([
          ...honestInstructions(),
          createCloseAccountInstruction(teeAtaB, stranger, tee.publicKey, [], SPL_TOKEN),
        ]),
      ),
    ).toMatch(/instruction 3 closes a token account to/)
    expect(
      await refusal(
        artifactFor([
          ...honestInstructions(),
          SystemProgram.transfer({ fromPubkey: tee.publicKey, toPubkey: vault, lamports: 1 }),
        ]),
      ),
    ).toMatch(/instruction 3 is a top-level System instruction/)
    // The one Token instruction a close issues at the top level: CloseAccount back to the wallet
    // (the wSOL unwrap). The closed account is gone afterwards and its rent lands on the wallet.
    const unwrap = [
      ...honestInstructions(),
      createCloseAccountInstruction(teeAtaB, tee.publicKey, tee.publicKey, [], SPL_TOKEN),
    ]
    const post = { ...postState(), [teeAtaB.toBase58()]: null }
    const verdict = await verify(artifactFor(unwrap), fakeRpc({ post }))
    expect(verdict.ok ? "ok" : verdict.reason).toBe("ok")
  })

  test("describeClose renders the agreed keys, programs, wallet deltas and the NFT closure", async () => {
    const artifact = artifactFor(honestInstructions())
    const verdict = await verify(artifact, fakeRpc({}))
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    const lines = describeClose({
      verdict,
      tee: tee.publicKey.toBase58(),
      vault: vault.toBase58(),
      nftMint: nftMint.toBase58(),
      nftAccount: nftAccount.toBase58(),
    })
    expect(lines[0]).toBe(
      `message     v0, 3 instruction(s), ${artifact.accountKeys.length} account(s), blockhash ${BLOCKHASH}`,
    )
    expect(lines[1]).toBe(`fee payer   ${tee.publicKey.toBase58()} (this TEE wallet)`)
    expect(lines.filter((line) => line.startsWith("program"))).toHaveLength(3)
    expect(lines.some((line) => line.startsWith("program     Meteora DAMM v2"))).toBe(true)
    expect(lines).toContain("wallet      0.05 SOL -> 0.053 SOL (+0.003 SOL)")
    expect(lines).toContain(`wallet      ${mintA.toBase58()}: 0 -> 100000000 raw (+100000000) in ${teeAtaA.toBase58()}`)
    expect(lines).toContain(`wallet      ${mintB.toBase58()}: 10 -> 500010 raw (+500000) in ${teeAtaB.toBase58()}`)
    expect(lines).toContain(`position    NFT account ${nftAccount.toBase58()} is closed by this transaction`)
    expect(lines.some((line) => line.startsWith("pool        ") && line.includes(vaultA.toBase58()))).toBe(true)
    expect(lines.at(-2)).toContain("all passed")
  })
})
