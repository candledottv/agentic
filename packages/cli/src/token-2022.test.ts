/**
 * Ember Phase 3 PR A (BE-218, R5 / P3-ED-7). Same rule as `solana-lite.test.ts`: every answer here
 * is pinned against `@solana/spl-token` as an INDEPENDENT oracle, imported from the repo root's
 * hoisted node_modules. The CLI package does not ship it, and must not.
 *
 * The mint fixtures are assembled byte by byte rather than by a helper, because the layout IS what
 * is under test: `unpackMint` and the extension getters read the same bytes back.
 */
import { describe, expect, test } from "bun:test"
import {
  addExtraAccountMetasForExecute,
  calculateFee,
  createTransferCheckedInstruction,
  getDefaultAccountState,
  getExtraAccountMetaAddress,
  getNonTransferable,
  getPermanentDelegate,
  getTransferFeeConfig,
  getTransferHook,
  TOKEN_2022_PROGRAM_ID as SPL_TOKEN_2022_PROGRAM_ID,
  unpackMint,
} from "@solana/spl-token"
import { type AccountInfo, type Connection, Keypair, PublicKey } from "@solana/web3.js"
import {
  type AccountView,
  decodePubkey,
  encodePubkey,
  type SolanaRpc,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./solana-lite"
import {
  ataFor,
  classifyTokenSendFailure,
  extraAccountMetaAddress,
  MintReadError,
  parseExtraAccountMetas,
  parseMintAccount,
  readMintProfile,
  resolveTransferHookAccounts,
  transferFeeFor,
} from "./token-2022"

const mintKey = Keypair.generate().publicKey
const mint = mintKey.toBase58()
const owner = Keypair.generate().publicKey
const vaultOwner = Keypair.generate().publicKey

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────────

/** A classic 82-byte mint: authority option, authority, supply, decimals, initialized, freeze. */
function baseMint(decimals: number): Uint8Array {
  const data = new Uint8Array(82)
  data[44] = decimals
  data[45] = 1
  return data
}

/** A Token-2022 mint: the 82-byte base padded to 165, the Mint account type, then TLV entries. */
function extendedMint(decimals: number, extensions: Array<{ type: number; body: Uint8Array }>): Uint8Array {
  const tlv = extensions.flatMap(({ type, body }) => {
    const header = new Uint8Array(4)
    const view = new DataView(header.buffer)
    view.setUint16(0, type, true)
    view.setUint16(2, body.length, true)
    return [header, body]
  })
  const size = 166 + tlv.reduce((n, part) => n + part.length, 0)
  const data = new Uint8Array(size)
  data.set(baseMint(decimals), 0)
  data[165] = 1
  let at = 166
  for (const part of tlv) {
    data.set(part, at)
    at += part.length
  }
  return data
}

/** TransferFeeConfig (108): two authorities, withheld, then older and newer 18-byte schedules. */
function transferFeeBody(input: {
  olderEpoch: bigint
  olderBps: number
  olderMax: bigint
  newerEpoch: bigint
  newerBps: number
  newerMax: bigint
}): Uint8Array {
  const body = new Uint8Array(108)
  const view = new DataView(body.buffer)
  const schedule = (at: number, epoch: bigint, max: bigint, bps: number) => {
    view.setBigUint64(at, epoch, true)
    view.setBigUint64(at + 8, max, true)
    view.setUint16(at + 16, bps, true)
  }
  schedule(72, input.olderEpoch, input.olderMax, input.olderBps)
  schedule(90, input.newerEpoch, input.newerMax, input.newerBps)
  return body
}

/** TransferHook (64): authority then program id. */
function transferHookBody(authority: PublicKey, program: PublicKey): Uint8Array {
  const body = new Uint8Array(64)
  body.set(authority.toBytes(), 0)
  body.set(program.toBytes(), 32)
  return body
}

function splMint(data: Uint8Array, programId = SPL_TOKEN_2022_PROGRAM_ID) {
  return unpackMint(
    mintKey,
    {
      data: Buffer.from(data),
      owner: programId,
      executable: false,
      lamports: 1,
      rentEpoch: 0,
    } as AccountInfo<Buffer>,
    programId,
  )
}

/** An RPC whose every unused call is a loud failure rather than a silent undefined. */
function rpcOver(accounts: Record<string, AccountView | null>, epoch = 500n): SolanaRpc {
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
    getMultipleAccounts: refuse("getMultipleAccounts"),
    getProgramAccounts: refuse("getProgramAccounts"),
    getProgramAccountsV2: refuse("getProgramAccountsV2"),
    simulateTransaction: refuse("simulateTransaction"),
    getAccountInfo: async (address: string) => accounts[address] ?? null,
    getEpoch: async () => epoch,
  }
}

function view(data: Uint8Array, accountOwner = TOKEN_2022_PROGRAM_ID): AccountView {
  return { owner: accountOwner, lamports: 1n, data }
}

// ── The extension reader ───────────────────────────────────────────────────────────────────────

describe("parseMintAccount agrees with spl-token on the same bytes", () => {
  test("a classic mint has decimals, the classic program, and no extensions", () => {
    const data = baseMint(6)
    const profile = parseMintAccount(mint, TOKEN_PROGRAM_ID, data)
    expect(profile.decimals).toBe(splMint(data, new PublicKey(TOKEN_PROGRAM_ID)).decimals)
    expect(profile.token2022).toBe(false)
    expect(profile.tokenProgram).toBe(TOKEN_PROGRAM_ID)
    expect(profile.risks).toEqual([])
    expect(profile.nonTransferable).toBe(false)
  })

  test("a bare Token-2022 mint with no extensions reads as clean", () => {
    const profile = parseMintAccount(mint, TOKEN_2022_PROGRAM_ID, baseMint(9))
    expect(profile.token2022).toBe(true)
    expect(profile.decimals).toBe(9)
    expect(profile.risks).toEqual([])
  })

  test("the whole R5 warning set, each against spl-token's own getter", () => {
    const delegate = Keypair.generate().publicKey
    const hookAuthority = Keypair.generate().publicKey
    const hookProgram = Keypair.generate().publicKey
    const pauseAuthority = Keypair.generate().publicKey
    const pausable = new Uint8Array(33)
    pausable.set(pauseAuthority.toBytes(), 0)
    pausable[32] = 1
    const data = extendedMint(6, [
      {
        type: 1,
        body: transferFeeBody({
          olderEpoch: 10n,
          olderBps: 150,
          olderMax: 1_000_000n,
          newerEpoch: 600n,
          newerBps: 250,
          newerMax: 2_000_000n,
        }),
      },
      { type: 6, body: new Uint8Array([2]) },
      { type: 9, body: new Uint8Array(0) },
      { type: 12, body: delegate.toBytes() },
      { type: 14, body: transferHookBody(hookAuthority, hookProgram) },
      { type: 26, body: pausable },
    ])
    const profile = parseMintAccount(mint, TOKEN_2022_PROGRAM_ID, data)
    const oracle = splMint(data)

    expect(getPermanentDelegate(oracle)?.delegate.toBase58()).toBe(delegate.toBase58())
    expect(getTransferHook(oracle)?.programId.toBase58()).toBe(hookProgram.toBase58())
    expect(getDefaultAccountState(oracle)?.state).toBe(2)
    expect(getNonTransferable(oracle)).not.toBeNull()
    const feeConfig = getTransferFeeConfig(oracle)
    expect(feeConfig?.olderTransferFee.transferFeeBasisPoints).toBe(150)
    expect(feeConfig?.newerTransferFee.transferFeeBasisPoints).toBe(250)

    expect(profile.transferHookProgram).toBe(hookProgram.toBase58())
    expect(profile.nonTransferable).toBe(true)
    expect(profile.defaultFrozen).toBe(true)
    expect(profile.paused).toBe(true)
    expect(profile.olderTransferFee).toEqual({ epoch: 10n, basisPoints: 150, maximumFeeRaw: 1_000_000n })
    expect(profile.newerTransferFee).toEqual({ epoch: 600n, basisPoints: 250, maximumFeeRaw: 2_000_000n })
    // One plain line each, in the order the TLV holds them (R5).
    expect(profile.risks.map((r) => r.kind)).toEqual([
      "transfer_fee",
      "default_frozen",
      "non_transferable",
      "permanent_delegate",
      "transfer_hook",
      "pausable",
    ])
    expect(profile.risks.map((r) => r.message)).toEqual([
      "Transfer fee: 1.5% capped at 1000000 raw units; from epoch 600, 2.5% capped at 2000000 raw units.",
      "New token accounts are frozen by default.",
      "This token is non-transferable.",
      `Permanent delegate ${delegate.toBase58()} can move or burn your tokens.`,
      `Transfer hook ${hookProgram.toBase58()} (unknown program) runs code on every transfer.`,
      `Token is paused by ${pauseAuthority.toBase58()}.`,
    ])
  })

  test("an unknown extension is skipped rather than guessed at", () => {
    const data = extendedMint(4, [
      { type: 999, body: new Uint8Array([7, 7, 7]) },
      { type: 9, body: new Uint8Array(0) },
    ])
    const profile = parseMintAccount(mint, TOKEN_2022_PROGRAM_ID, data)
    expect(profile.nonTransferable).toBe(true)
    expect(profile.risks).toHaveLength(1)
  })

  test("malformed bytes refuse; they never produce a half-read mint", () => {
    expect(() => parseMintAccount(mint, TOKEN_2022_PROGRAM_ID, new Uint8Array(10))).toThrow(MintReadError)
    const uninitialized = baseMint(6)
    uninitialized[45] = 0
    expect(() => parseMintAccount(mint, TOKEN_2022_PROGRAM_ID, uninitialized)).toThrow(/not an initialized mint/)
    // A 355-byte account is a Multisig, whose bytes would otherwise walk as a TLV.
    const multisig = new Uint8Array(355)
    multisig.set(baseMint(6), 0)
    multisig[165] = 1
    expect(() => parseMintAccount(mint, TOKEN_2022_PROGRAM_ID, multisig)).toThrow(/invalid mint extension header/)
    // A wrong extension length is a refusal, not a shifted read of everything after it.
    const badLength = extendedMint(6, [{ type: 12, body: new Uint8Array(31) }])
    expect(() => parseMintAccount(mint, TOKEN_2022_PROGRAM_ID, badLength)).toThrow(/invalid extension 12 length/)
    // A duplicate extension is a refusal: the second could contradict the first.
    const duplicated = extendedMint(6, [
      { type: 9, body: new Uint8Array(0) },
      { type: 9, body: new Uint8Array(0) },
    ])
    expect(() => parseMintAccount(mint, TOKEN_2022_PROGRAM_ID, duplicated)).toThrow(/duplicate extension/)
    // A fee rate above 100% is not a fee.
    const absurdFee = extendedMint(6, [
      {
        type: 1,
        body: transferFeeBody({
          olderEpoch: 1n,
          olderBps: 10_001,
          olderMax: 1n,
          newerEpoch: 1n,
          newerBps: 1,
          newerMax: 1n,
        }),
      },
    ])
    expect(() => parseMintAccount(mint, TOKEN_2022_PROGRAM_ID, absurdFee)).toThrow(/Invalid transfer fee rate/)
  })

  test("zero padding after a reallocation ends the walk instead of reading a header out of it", () => {
    const real = extendedMint(6, [{ type: 9, body: new Uint8Array(0) }])
    const padded = new Uint8Array(real.length + 64)
    padded.set(real, 0)
    expect(parseMintAccount(mint, TOKEN_2022_PROGRAM_ID, padded).nonTransferable).toBe(true)
  })
})

describe("readMintProfile takes the program from the account's owner", () => {
  test("the owner decides, for a classic mint and a Token-2022 one alike", async () => {
    const classic = baseMint(6)
    const extended = extendedMint(0, [{ type: 9, body: new Uint8Array(0) }])
    const rpc = rpcOver({ [mint]: view(classic, TOKEN_PROGRAM_ID) })
    expect((await readMintProfile(rpc, mint)).tokenProgram).toBe(TOKEN_PROGRAM_ID)
    expect((await readMintProfile(rpc, mint)).token2022).toBe(false)
    const rpc2022 = rpcOver({ [mint]: view(extended) })
    const profile = await readMintProfile(rpc2022, mint)
    expect(profile.tokenProgram).toBe(TOKEN_2022_PROGRAM_ID)
    expect(profile.nonTransferable).toBe(true)
  })

  test("a missing mint, or one owned by neither token program, refuses", async () => {
    await expect(readMintProfile(rpcOver({}), mint)).rejects.toThrow(/does not exist/)
    const stranger = rpcOver({ [mint]: view(baseMint(6), owner.toBase58()) })
    await expect(readMintProfile(stranger, mint)).rejects.toThrow(/not a token program/)
  })

  test("the ATA follows the mint's program, so the two never cross", async () => {
    const rpc = rpcOver({ [mint]: view(baseMint(6)) })
    const profile = await readMintProfile(rpc, mint)
    expect(encodePubkey(ataFor(profile, vaultOwner.toBytes()))).not.toBe(
      encodePubkey(ataFor({ ...profile, tokenProgram: TOKEN_PROGRAM_ID }, vaultOwner.toBytes())),
    )
  })
})

// ── Transfer fees ──────────────────────────────────────────────────────────────────────────────

describe("transferFeeFor matches spl-token's calculateFee", () => {
  const profile = {
    olderTransferFee: { epoch: 10n, basisPoints: 150, maximumFeeRaw: 1_000_000n },
    newerTransferFee: { epoch: 600n, basisPoints: 250, maximumFeeRaw: 2_000_000n },
  }
  const asSpl = (schedule: { epoch: bigint; basisPoints: number; maximumFeeRaw: bigint }) => ({
    epoch: schedule.epoch,
    maximumFee: schedule.maximumFeeRaw,
    transferFeeBasisPoints: schedule.basisPoints,
  })

  test("the schedule in force is the newer one from its epoch onward", () => {
    for (const [epoch, schedule] of [
      [599n, profile.olderTransferFee],
      [600n, profile.newerTransferFee],
      [601n, profile.newerTransferFee],
    ] as const) {
      for (const amount of [1n, 999n, 1_000_000n, 123_456_789n, 10_000_000_000n]) {
        const ours = transferFeeFor(profile, amount, epoch)
        expect(`${epoch}/${amount}: ${ours.feeRaw}`).toBe(
          `${epoch}/${amount}: ${calculateFee(asSpl(schedule), amount)}`,
        )
        expect(ours.postFeeAmountRaw).toBe(amount - ours.feeRaw)
      }
    }
  })

  test("the fee rounds UP and is then capped", () => {
    // 1 raw unit at 1.5% is 0.015, which rounds to 1: a dust transfer still pays.
    expect(transferFeeFor(profile, 1n, 100n).feeRaw).toBe(1n)
    // Far past the cap, the cap is the answer.
    expect(transferFeeFor(profile, 10_000_000_000n, 100n).feeRaw).toBe(1_000_000n)
  })

  test("a mint with no fee config withholds nothing", () => {
    expect(transferFeeFor({}, 42n, 700n)).toEqual({ feeRaw: 0n, postFeeAmountRaw: 42n })
  })
})

// ── Transfer hook extra accounts ───────────────────────────────────────────────────────────────

const hookProgram = Keypair.generate().publicKey
const source = Keypair.generate().publicKey
const destination = Keypair.generate().publicKey

/** The validation account: 8-byte Execute discriminator, u32 byte length, u32 count, then metas. */
function validationAccount(
  metas: Array<{ discriminator: number; addressConfig: Uint8Array; isSigner: boolean; isWritable: boolean }>,
): Uint8Array {
  const data = new Uint8Array(16 + metas.length * 35)
  data.set([105, 37, 101, 197, 75, 251, 102, 26], 0)
  const view = new DataView(data.buffer)
  view.setUint32(8, 4 + metas.length * 35, true)
  view.setUint32(12, metas.length, true)
  metas.forEach((meta, i) => {
    const at = 16 + i * 35
    data[at] = meta.discriminator
    data.set(meta.addressConfig.subarray(0, 32), at + 1)
    data[at + 33] = meta.isSigner ? 1 : 0
    data[at + 34] = meta.isWritable ? 1 : 0
  })
  return data
}

function seedConfig(bytes: number[]): Uint8Array {
  const config = new Uint8Array(32)
  config.set(bytes, 0)
  return config
}

/** spl-token's `addExtraAccountMetasForExecute` reads only `getAccountInfo`. */
function connectionOver(accounts: Record<string, AccountView | null>): Connection {
  return {
    getAccountInfo: async (key: PublicKey) => {
      const account = accounts[key.toBase58()]
      if (!account) return null
      return {
        data: Buffer.from(account.data),
        owner: new PublicKey(account.owner),
        executable: false,
        lamports: Number(account.lamports),
        rentEpoch: 0,
      }
    },
  } as unknown as Connection
}

describe("resolveTransferHookAccounts reproduces spl-token's Execute tail", () => {
  const validateState = getExtraAccountMetaAddress(mintKey, hookProgram)
  const hookMint = extendedMint(6, [{ type: 14, body: transferHookBody(owner, hookProgram) }])

  /** Every extra-account form at once: literal, PDA under the hook, PDA under a listed account. */
  const literal = Keypair.generate().publicKey
  const seeded = Keypair.generate().publicKey
  const metas = [
    { discriminator: 0, addressConfig: literal.toBytes(), isSigner: false, isWritable: true },
    // PDA under the hook program from a literal seed plus the source account's key.
    {
      discriminator: 1,
      addressConfig: seedConfig([1, 5, 0x68, 0x6f, 0x6f, 0x6b, 0x73, 3, 0]),
      isSigner: false,
      isWritable: false,
    },
    // PDA under extra account 0 (discriminator 128 + index), seeded from the Execute amount.
    { discriminator: 128 + 5, addressConfig: seedConfig([2, 8, 8]), isSigner: false, isWritable: true },
    // Pubkey read out of an account's data.
    { discriminator: 2, addressConfig: seedConfig([2, 0, 0]), isSigner: false, isWritable: false },
  ]

  test("the resolved tail is element-for-element what spl-token appends, in order", async () => {
    const seededData = new Uint8Array(32)
    seededData.set(seeded.toBytes(), 0)
    const accounts: Record<string, AccountView> = {
      [mint]: view(hookMint),
      [validateState.toBase58()]: view(validationAccount(metas), hookProgram.toBase58()),
      [source.toBase58()]: view(seededData, TOKEN_2022_PROGRAM_ID),
    }
    const profile = await readMintProfile(rpcOver(accounts), mint)
    const ours = await resolveTransferHookAccounts(rpcOver(accounts), {
      profile,
      source: source.toBytes(),
      destination: destination.toBytes(),
      owner: owner.toBytes(),
      amount: 4_200n,
    })
    expect(ours.ok).toBe(true)
    if (!ours.ok) throw new Error("unreachable")

    const instruction = createTransferCheckedInstruction(
      source,
      mintKey,
      destination,
      owner,
      4_200n,
      6,
      [],
      SPL_TOKEN_2022_PROGRAM_ID,
    )
    await addExtraAccountMetasForExecute(
      connectionOver(accounts),
      instruction,
      hookProgram,
      source,
      mintKey,
      destination,
      owner,
      4_200n,
    )
    const theirs = instruction.keys.slice(4)
    expect(ours.accounts.map((k) => encodePubkey(k.pubkey))).toEqual(theirs.map((k) => k.pubkey.toBase58()))
    expect(ours.accounts.map((k) => [k.isSigner, k.isWritable])).toEqual(theirs.map((k) => [k.isSigner, k.isWritable]))
    // The tail always ends with the hook program and its validation account.
    expect(encodePubkey(ours.accounts[ours.accounts.length - 2]?.pubkey ?? new Uint8Array())).toBe(
      hookProgram.toBase58(),
    )
    expect(encodePubkey(ours.accounts[ours.accounts.length - 1]?.pubkey ?? new Uint8Array())).toBe(
      validateState.toBase58(),
    )
  })

  test("the amount is a seed, so a different amount resolves a different account", async () => {
    const accounts: Record<string, AccountView> = {
      [mint]: view(hookMint),
      [validateState.toBase58()]: view(
        validationAccount([
          { discriminator: 1, addressConfig: seedConfig([2, 8, 8]), isSigner: false, isWritable: false },
        ]),
        hookProgram.toBase58(),
      ),
    }
    const profile = await readMintProfile(rpcOver(accounts), mint)
    const at = async (amount: bigint) => {
      const resolved = await resolveTransferHookAccounts(rpcOver(accounts), {
        profile,
        source: source.toBytes(),
        destination: destination.toBytes(),
        owner: owner.toBytes(),
        amount,
      })
      if (!resolved.ok) throw new Error(resolved.reason)
      return encodePubkey(resolved.accounts[0]?.pubkey ?? new Uint8Array())
    }
    expect(await at(1n)).not.toBe(await at(2n))
  })

  test("our PDA seed address matches spl-token's for the validation account itself", () => {
    expect(encodePubkey(extraAccountMetaAddress(mintKey.toBytes(), hookProgram.toBytes()))).toBe(
      validateState.toBase58(),
    )
  })

  test("a mint with no hook needs no tail; a hook with no validation account needs none either", async () => {
    const plain = await readMintProfile(rpcOver({ [mint]: view(baseMint(6)) }), mint)
    await expect(
      resolveTransferHookAccounts(rpcOver({}), {
        profile: plain,
        source: source.toBytes(),
        destination: destination.toBytes(),
        owner: owner.toBytes(),
        amount: 1n,
      }),
    ).resolves.toEqual({ ok: true, accounts: [] })

    const accounts = { [mint]: view(hookMint) }
    const hooked = await readMintProfile(rpcOver(accounts), mint)
    await expect(
      resolveTransferHookAccounts(rpcOver(accounts), {
        profile: hooked,
        source: source.toBytes(),
        destination: destination.toBytes(),
        owner: owner.toBytes(),
        amount: 1n,
      }),
    ).resolves.toEqual({ ok: true, accounts: [] })
  })

  test("an unresolvable tail answers ok:false with a reason, and never throws at the caller", async () => {
    const accounts: Record<string, AccountView> = {
      [mint]: view(hookMint),
      // A seed type the interface does not define.
      [validateState.toBase58()]: view(
        validationAccount([{ discriminator: 1, addressConfig: seedConfig([9]), isSigner: false, isWritable: false }]),
        hookProgram.toBase58(),
      ),
    }
    const profile = await readMintProfile(rpcOver(accounts), mint)
    const resolved = await resolveTransferHookAccounts(rpcOver(accounts), {
      profile,
      source: source.toBytes(),
      destination: destination.toBytes(),
      owner: owner.toBytes(),
      amount: 1n,
    })
    expect(resolved.ok).toBe(false)
    if (resolved.ok) throw new Error("unreachable")
    expect(resolved.reason).toMatch(/unknown seed type 9/)
  })

  test("a truncated validation account is unresolvable, not a short list read as complete", () => {
    const full = validationAccount([
      { discriminator: 0, addressConfig: literal.toBytes(), isSigner: false, isWritable: false },
      { discriminator: 0, addressConfig: seeded.toBytes(), isSigner: false, isWritable: false },
    ])
    expect(parseExtraAccountMetas(full)).toHaveLength(2)
    expect(() => parseExtraAccountMetas(full.subarray(0, full.length - 10))).toThrow(
      /more extra accounts than it holds/,
    )
    expect(() => parseExtraAccountMetas(new Uint8Array(8))).toThrow(/too short to decode/)
  })
})

// ── Naming a failed send ───────────────────────────────────────────────────────────────────────

describe("classifyTokenSendFailure names a failed send, never refuses one", () => {
  const profileOf = (extras: Partial<Parameters<typeof classifyTokenSendFailure>[0]["profile"]>) => ({
    mint,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    token2022: true,
    decimals: 6,
    nonTransferable: false,
    defaultFrozen: false,
    paused: false,
    risks: [],
    ...extras,
  })

  test("each of R5's four names, in the order that makes the most specific one win", () => {
    expect(
      classifyTokenSendFailure({
        profile: profileOf({ nonTransferable: true, transferHookProgram: hookProgram.toBase58() }),
        frozen: true,
        extraAccountsMissing: true,
      }),
    ).toBe("TOKEN_2022_NOT_TRANSFERABLE")
    expect(
      classifyTokenSendFailure({
        profile: profileOf({ transferHookProgram: hookProgram.toBase58() }),
        frozen: true,
        extraAccountsMissing: true,
      }),
    ).toBe("TOKEN_2022_FROZEN")
    expect(
      classifyTokenSendFailure({
        profile: profileOf({ transferHookProgram: hookProgram.toBase58() }),
        frozen: false,
        extraAccountsMissing: true,
      }),
    ).toBe("TOKEN_2022_EXTRA_ACCOUNTS_MISSING")
    expect(
      classifyTokenSendFailure({
        profile: profileOf({ transferHookProgram: hookProgram.toBase58() }),
        frozen: false,
        extraAccountsMissing: false,
      }),
    ).toBe("TOKEN_2022_HOOK_REFUSED")
  })

  test("a plain Token-2022 mint, and any classic mint, get no name at all", () => {
    expect(classifyTokenSendFailure({ profile: profileOf({}), frozen: false, extraAccountsMissing: false })).toBe(
      undefined,
    )
    expect(
      classifyTokenSendFailure({
        profile: profileOf({ token2022: false, tokenProgram: TOKEN_PROGRAM_ID, nonTransferable: true }),
        frozen: true,
        extraAccountsMissing: true,
      }),
    ).toBe(undefined)
  })

  test("decodePubkey of every program id this module hands to solana-lite is a real address", () => {
    // The two constants are strings until something decodes them; a typo would surface here first.
    expect(decodePubkey(TOKEN_2022_PROGRAM_ID)).toHaveLength(32)
    expect(decodePubkey(TOKEN_PROGRAM_ID)).toHaveLength(32)
    expect(SPL_TOKEN_2022_PROGRAM_ID.toBase58()).toBe(TOKEN_2022_PROGRAM_ID)
  })
})
