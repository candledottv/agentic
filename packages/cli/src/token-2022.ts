/**
 * Ember Phase 3 PR A (BE-218, R5 / P3-ED-7): everything a LOCAL Token-2022 move needs to know
 * about a mint, kept out of `solana-lite.ts` on purpose.
 *
 * `solana-lite.ts` is the instruction encoder, and P3-ED-6 pins its scope: Token-2022
 * `TransferChecked`, `CloseAccount` and ATA creation, and no program positions. Reading a mint's
 * extension TLV and resolving a transfer hook's extra accounts is a different job -- it talks to
 * the RPC, it can fail, and its failures are named leftovers -- so it lives here.
 *
 * The extension reader mirrors `packages/shared/src/token-2022.ts`, the ONE parser of P3-ED-8, and
 * `token-2022.drift.test.ts` holds the two to the same answers on the same bytes. It is a mirror
 * rather than an import for the reason `wallet-import.drift.test.ts` already records: the CLI is
 * published alone to the `candledottv/agentic` mirror, which has no `packages/shared` and no
 * `@candle/shared` on npm, and the shared module imports `@solana/web3.js`, which the CLI must
 * never ship in `dist` (E21, and P3-ED-6's "no new Solana runtime dependency"). So the shared
 * parser stays the one parser the SERVER uses, and this is the same rules over the same bytes with
 * the CLI's own primitives.
 */
import {
  type AccountMeta,
  associatedTokenAddress,
  decodePubkey,
  encodePubkey,
  findProgramAddress,
  type Pubkey,
  type SolanaRpc,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./solana-lite"

/**
 * The four leftover kinds R5 names for a failed send. They are leftovers, never a refused quote
 * and never a silent skip (P3-AD-9): the CLI builds the move it can build, sends it, and reports
 * under one of these names when the chain refuses it.
 */
export const TOKEN_2022_LEFTOVER_KINDS = [
  "TOKEN_2022_NOT_TRANSFERABLE",
  "TOKEN_2022_HOOK_REFUSED",
  "TOKEN_2022_EXTRA_ACCOUNTS_MISSING",
  "TOKEN_2022_FROZEN",
] as const

export type Token2022LeftoverKind = (typeof TOKEN_2022_LEFTOVER_KINDS)[number]

export interface TransferFeeSchedule {
  epoch: bigint
  basisPoints: number
  maximumFeeRaw: bigint
}

/**
 * The shared parser's `TokenRisk["kind"]` also declares `"unavailable"`, which it never returns:
 * a server caller pushes that one when a mint read fails. The CLI has nowhere to put an advisory
 * risk -- an unreadable mint refuses the move rather than proceeding with a warning -- so that
 * member is deliberately absent here.
 */
export type MintRiskKind =
  | "permanent_delegate"
  | "transfer_hook"
  | "transfer_fee"
  | "default_frozen"
  | "pausable"
  | "non_transferable"

/** One plain line for the operator, in the shared parser's wording (R5's warning set). */
export interface MintRisk {
  kind: MintRiskKind
  message: string
}

/** What a move needs to know about a mint: its program, its decimals, and its extensions. */
export interface MintProfile {
  mint: string
  /** The mint account's OWNER: the program every instruction for this mint must run under. */
  tokenProgram: string
  token2022: boolean
  decimals: number
  nonTransferable: boolean
  defaultFrozen: boolean
  paused: boolean
  transferHookProgram?: string
  olderTransferFee?: TransferFeeSchedule
  newerTransferFee?: TransferFeeSchedule
  risks: MintRisk[]
}

export class MintReadError extends Error {}

const MINT_DECIMALS_OFFSET = 44
const MINT_IS_INITIALIZED_OFFSET = 45
/** The base mint is 82 bytes; an extended one is padded to 165 + a 1-byte account type + TLV. */
const MINT_BASE_SIZE = 82
const ACCOUNT_TYPE_OFFSET = 165
const TLV_START = 166
/** A 355-byte account is a Multisig, whose bytes would otherwise read as an extended mint. */
const MULTISIG_SIZE = 355

/** Extension types this reader knows, as SPL Token 0.4.14 numbers them. */
const EXT_TRANSFER_FEE_CONFIG = 1
const EXT_DEFAULT_ACCOUNT_STATE = 6
const EXT_NON_TRANSFERABLE = 9
const EXT_PERMANENT_DELEGATE = 12
const EXT_TRANSFER_HOOK = 14
const EXT_PAUSABLE = 26

/** The `ExecuteInstruction` discriminator of the SPL transfer-hook interface. */
const EXECUTE_DISCRIMINATOR = new Uint8Array([105, 37, 101, 197, 75, 251, 102, 26])
const EXTRA_ACCOUNT_METAS_SEED = new TextEncoder().encode("extra-account-metas")
/** `ExtraAccountMeta`: discriminator u8, addressConfig [u8; 32], isSigner bool, isWritable bool. */
const EXTRA_ACCOUNT_META_SIZE = 35

function readKey(data: Uint8Array, offset: number): string | undefined {
  const bytes = data.subarray(offset, offset + 32)
  return bytes.some((b) => b !== 0) ? encodePubkey(bytes) : undefined
}

function readFeeSchedule(view: DataView, offset: number): TransferFeeSchedule {
  const basisPoints = view.getUint16(offset + 16, true)
  if (basisPoints > 10_000) throw new MintReadError("Invalid transfer fee rate")
  return {
    epoch: view.getBigUint64(offset, true),
    maximumFeeRaw: view.getBigUint64(offset + 8, true),
    basisPoints,
  }
}

/**
 * Read a mint account's decimals and the extensions R5 warns about. The same TLV walk, the same
 * extension numbers, the same refusals and the same messages as `packages/shared/src/token-2022.ts`;
 * an unknown extension is skipped, a malformed one refuses rather than guessing.
 */
export function parseMintAccount(mint: string, owner: string, data: Uint8Array): MintProfile {
  if (data.length < MINT_BASE_SIZE || data[MINT_IS_INITIALIZED_OFFSET] !== 1) {
    throw new MintReadError(`${mint} is not an initialized mint account`)
  }
  const decimals = data[MINT_DECIMALS_OFFSET]
  if (decimals === undefined) throw new MintReadError(`${mint} is not an initialized mint account`)
  const profile: MintProfile = {
    mint,
    tokenProgram: owner,
    token2022: owner === TOKEN_2022_PROGRAM_ID,
    decimals,
    nonTransferable: false,
    defaultFrozen: false,
    paused: false,
    risks: [],
  }
  // Only Token-2022 carries extensions. A classic mint is 82 bytes and has none, and anything
  // past those bytes under the classic program is not a TLV (S10's rule, kept).
  if (!profile.token2022 || data.length === MINT_BASE_SIZE) return profile
  if (data.length < TLV_START || data.length === MULTISIG_SIZE || data[ACCOUNT_TYPE_OFFSET] !== 1) {
    throw new MintReadError(`${mint} has an invalid mint extension header`)
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const seen = new Set<number>()
  for (let offset = TLV_START; offset < data.length; ) {
    // A reallocated account is zero-padded, including a short final header.
    if (data.subarray(offset).every((b) => b === 0)) break
    if (offset + 4 > data.length) throw new MintReadError(`${mint} has a truncated mint extension header`)
    const type = view.getUint16(offset, true)
    const length = view.getUint16(offset + 2, true)
    offset += 4
    if (offset + length > data.length || seen.has(type)) {
      throw new MintReadError(`${mint} has an invalid mint extension length or a duplicate extension`)
    }
    seen.add(type)
    const requireLength = (expected: number) => {
      if (length !== expected) throw new MintReadError(`${mint} has an invalid extension ${type} length`)
    }
    switch (type) {
      case EXT_PERMANENT_DELEGATE: {
        requireLength(32)
        const authority = readKey(data, offset)
        if (authority) {
          profile.risks.push({
            kind: "permanent_delegate",
            message: `Permanent delegate ${authority} can move or burn your tokens.`,
          })
        }
        break
      }
      case EXT_TRANSFER_HOOK: {
        requireLength(64)
        // authority(32) then programId(32): the program is the half a transfer must run.
        const hookProgram = readKey(data, offset + 32)
        if (hookProgram) {
          profile.transferHookProgram = hookProgram
          profile.risks.push({
            kind: "transfer_hook",
            message: `Transfer hook ${hookProgram} (unknown program) runs code on every transfer.`,
          })
        }
        break
      }
      case EXT_TRANSFER_FEE_CONFIG: {
        requireLength(108)
        const older = readFeeSchedule(view, offset + 72)
        const newer = readFeeSchedule(view, offset + 90)
        profile.olderTransferFee = older
        profile.newerTransferFee = newer
        profile.risks.push({
          kind: "transfer_fee",
          message: `Transfer fee: ${older.basisPoints / 100}% capped at ${older.maximumFeeRaw} raw units; from epoch ${newer.epoch}, ${newer.basisPoints / 100}% capped at ${newer.maximumFeeRaw} raw units.`,
        })
        break
      }
      case EXT_DEFAULT_ACCOUNT_STATE: {
        requireLength(1)
        const state = data[offset]
        if (state !== 1 && state !== 2) throw new MintReadError(`${mint} has an invalid default account state`)
        if (state === 2) {
          profile.defaultFrozen = true
          profile.risks.push({ kind: "default_frozen", message: "New token accounts are frozen by default." })
        }
        break
      }
      case EXT_PAUSABLE: {
        requireLength(33)
        const authority = readKey(data, offset)
        const pauseByte = data[offset + 32]
        if (pauseByte !== 0 && pauseByte !== 1) throw new MintReadError(`${mint} has an invalid pause state`)
        const paused = pauseByte === 1
        profile.paused = paused
        if (authority || paused) {
          profile.risks.push({
            kind: "pausable",
            message: `Token ${paused ? "is paused" : "can be paused"}${authority ? ` by ${authority}` : ""}.`,
          })
        }
        break
      }
      case EXT_NON_TRANSFERABLE: {
        requireLength(0)
        profile.nonTransferable = true
        profile.risks.push({ kind: "non_transferable", message: "This token is non-transferable." })
        break
      }
    }
    offset += length
  }
  return profile
}

/** Read the mint account over JSON-RPC and parse it. The OWNER decides the program, never a guess. */
export async function readMintProfile(rpc: SolanaRpc, mint: string): Promise<MintProfile> {
  const account = await rpc.getAccountInfo(mint)
  if (account === null) throw new MintReadError(`Mint ${mint} does not exist`)
  if (account.owner !== TOKEN_PROGRAM_ID && account.owner !== TOKEN_2022_PROGRAM_ID) {
    throw new MintReadError(`Mint ${mint} is owned by ${account.owner}, which is not a token program`)
  }
  return parseMintAccount(mint, account.owner, account.data)
}

/**
 * The fee Token-2022 withholds on a transfer of `amount`, and what therefore arrives. Token-2022
 * rounds the fee UP and then caps it; the schedule in force is the newer one from its epoch
 * onward. Same arithmetic as the shared parser's `token2022TransferAmounts`, in bigint.
 */
export function transferFeeFor(
  profile: Pick<MintProfile, "olderTransferFee" | "newerTransferFee">,
  amount: bigint,
  epoch: bigint,
): { feeRaw: bigint; postFeeAmountRaw: bigint } {
  const { olderTransferFee: older, newerTransferFee: newer } = profile
  const schedule = newer && epoch >= newer.epoch ? newer : older
  if (!schedule) return { feeRaw: 0n, postFeeAmountRaw: amount }
  const rounded = (amount * BigInt(schedule.basisPoints) + 9_999n) / 10_000n
  const fee = rounded < schedule.maximumFeeRaw ? rounded : schedule.maximumFeeRaw
  return { feeRaw: fee, postFeeAmountRaw: amount - fee }
}

// ── Transfer hook extra accounts ───────────────────────────────────────────────────────────────

/** The hook's validation account: PDA of ["extra-account-metas", mint] under the hook program. */
export function extraAccountMetaAddress(mint: Pubkey, hookProgram: Pubkey): Pubkey {
  return findProgramAddress([EXTRA_ACCOUNT_METAS_SEED, mint], hookProgram).address
}

/** The hook's validation account could not be read or decoded; the caller still sends. */
export class HookResolutionError extends Error {}

interface ExtraAccountMetaConfig {
  discriminator: number
  addressConfig: Uint8Array
  isSigner: boolean
  isWritable: boolean
}

/**
 * The validation account's TLV: an 8-byte `Execute` discriminator, a u32 byte length, then a u32
 * count and that many 35-byte `ExtraAccountMeta` records.
 */
export function parseExtraAccountMetas(data: Uint8Array): ExtraAccountMetaConfig[] {
  if (data.length < 16) throw new HookResolutionError("the hook's validation account is too short to decode")
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const count = view.getUint32(12, true)
  if (16 + count * EXTRA_ACCOUNT_META_SIZE > data.length) {
    throw new HookResolutionError("the hook's validation account declares more extra accounts than it holds")
  }
  const metas: ExtraAccountMetaConfig[] = []
  for (let i = 0; i < count; i++) {
    const at = 16 + i * EXTRA_ACCOUNT_META_SIZE
    const discriminator = data[at]
    const isSigner = data[at + 33]
    const isWritable = data[at + 34]
    if (discriminator === undefined || isSigner === undefined || isWritable === undefined) {
      throw new HookResolutionError("the hook's validation account holds a truncated extra account")
    }
    metas.push({
      discriminator,
      addressConfig: data.subarray(at + 1, at + 33),
      isSigner: isSigner === 1,
      isWritable: isWritable === 1,
    })
  }
  return metas
}

/** `Execute`'s instruction data, which a seed configuration may index into: discriminator, amount. */
function executeInstructionData(amount: bigint): Uint8Array {
  const data = new Uint8Array(16)
  data.set(EXECUTE_DISCRIMINATOR, 0)
  new DataView(data.buffer).setBigUint64(8, amount, true)
  return data
}

async function unpackSeeds(
  rpc: SolanaRpc,
  config: Uint8Array,
  previous: AccountMeta[],
  instructionData: Uint8Array,
): Promise<Uint8Array[]> {
  const seeds: Uint8Array[] = []
  let i = 0
  while (i < 32) {
    const discriminator = config[i]
    const rest = config.subarray(i + 1)
    // 0 ends the list. Everything else is one packed seed whose own length advances the cursor.
    if (discriminator === undefined || discriminator === 0) break
    if (discriminator === 1) {
      const length = rest[0]
      if (length === undefined || rest.length - 1 < length) throw new HookResolutionError("invalid literal seed")
      seeds.push(rest.subarray(1, 1 + length))
      i += 2 + length
    } else if (discriminator === 2) {
      const offset = rest[0]
      const length = rest[1]
      if (offset === undefined || length === undefined || instructionData.length < offset + length) {
        throw new HookResolutionError("invalid instruction-data seed")
      }
      seeds.push(instructionData.subarray(offset, offset + length))
      i += 3
    } else if (discriminator === 3) {
      const index = rest[0]
      const meta = index === undefined ? undefined : previous[index]
      if (!meta) throw new HookResolutionError("invalid account-key seed")
      seeds.push(meta.pubkey)
      i += 2
    } else if (discriminator === 4) {
      const accountIndex = rest[0]
      const dataIndex = rest[1]
      const length = rest[2]
      const meta = accountIndex === undefined ? undefined : previous[accountIndex]
      if (!meta || dataIndex === undefined || length === undefined) {
        throw new HookResolutionError("invalid account-data seed")
      }
      const account = await rpc.getAccountInfo(encodePubkey(meta.pubkey))
      if (account === null) throw new HookResolutionError("a seed names an account that does not exist")
      if (account.data.length < dataIndex + length) throw new HookResolutionError("invalid account-data seed range")
      seeds.push(account.data.subarray(dataIndex, dataIndex + length))
      i += 4
    } else {
      throw new HookResolutionError(`unknown seed type ${discriminator}`)
    }
  }
  return seeds
}

async function unpackPubkeyData(
  rpc: SolanaRpc,
  config: Uint8Array,
  previous: AccountMeta[],
  instructionData: Uint8Array,
): Promise<Pubkey> {
  const discriminator = config[0]
  if (discriminator === 1) {
    const offset = config[1]
    if (offset === undefined || instructionData.length < offset + 32) {
      throw new HookResolutionError("a pubkey-data configuration points outside the instruction data")
    }
    return instructionData.subarray(offset, offset + 32)
  }
  if (discriminator === 2) {
    const accountIndex = config[1]
    const dataIndex = config[2]
    const meta = accountIndex === undefined ? undefined : previous[accountIndex]
    if (!meta || dataIndex === undefined) throw new HookResolutionError("invalid pubkey-data configuration")
    const account = await rpc.getAccountInfo(encodePubkey(meta.pubkey))
    if (account === null) throw new HookResolutionError("a pubkey-data configuration names a missing account")
    if (account.data.length < dataIndex + 32) throw new HookResolutionError("invalid pubkey-data range")
    return account.data.subarray(dataIndex, dataIndex + 32)
  }
  throw new HookResolutionError(`unknown pubkey-data type ${discriminator ?? "(absent)"}`)
}

/**
 * Never hand a hook account more privilege than the accounts already in the instruction have: if
 * every earlier meta for this pubkey is read-only, the resolved one is read-only too. The
 * validation account is the mint authority's data, so it is not trusted to escalate.
 */
function deEscalate(meta: AccountMeta, previous: AccountMeta[]): AccountMeta {
  const same = previous.filter((x) => encodePubkey(x.pubkey) === encodePubkey(meta.pubkey))
  if (same.length === 0) return meta
  const isSigner = same.some((x) => x.isSigner)
  const isWritable = same.some((x) => x.isWritable)
  return {
    pubkey: meta.pubkey,
    isSigner: isSigner ? meta.isSigner : false,
    isWritable: isWritable ? meta.isWritable : false,
  }
}

export type HookAccounts =
  | { ok: true; accounts: AccountMeta[] }
  /** Unresolvable: the caller still sends, and names TOKEN_2022_EXTRA_ACCOUNTS_MISSING if it fails. */
  | { ok: false; reason: string }

/**
 * Resolve the tail a Token-2022 `TransferChecked` needs when the mint has a transfer hook: the
 * hook's own extra accounts in order, then the hook program, then its validation account. This is
 * `addExtraAccountMetasForExecute`'s shape, and `token-2022.test.ts` pins it against that function.
 *
 * A mint with no hook needs no tail. A hook whose validation account does not exist needs none
 * either: the interface treats that as "no extra accounts", exactly as spl-token does. Anything
 * else that cannot be resolved returns `ok: false` with the reason -- the transfer is still built
 * and sent, because a refusal here would be a refused quote (P3-AD-9), and a chain refusal is then
 * reported as `TOKEN_2022_EXTRA_ACCOUNTS_MISSING`.
 */
export async function resolveTransferHookAccounts(
  rpc: SolanaRpc,
  input: {
    profile: MintProfile
    source: Pubkey
    destination: Pubkey
    owner: Pubkey
    amount: bigint
  },
): Promise<HookAccounts> {
  const hook = input.profile.transferHookProgram
  if (!hook) return { ok: true, accounts: [] }
  try {
    const hookProgram = decodePubkey(hook)
    const mint = decodePubkey(input.profile.mint)
    const validateState = extraAccountMetaAddress(mint, hookProgram)
    const validateAccount = await rpc.getAccountInfo(encodePubkey(validateState))
    if (validateAccount === null) return { ok: true, accounts: [] }
    const configs = parseExtraAccountMetas(validateAccount.data)
    const instructionData = executeInstructionData(input.amount)
    // `Execute`'s own five accounts seed the resolution and are then dropped: only what follows
    // them is appended to the transfer.
    const resolved: AccountMeta[] = [input.source, mint, input.destination, input.owner, validateState].map(
      (pubkey) => ({ pubkey, isSigner: false, isWritable: false }),
    )
    for (const config of configs) {
      let meta: AccountMeta
      if (config.discriminator === 0) {
        meta = { pubkey: config.addressConfig, isSigner: config.isSigner, isWritable: config.isWritable }
      } else if (config.discriminator === 2) {
        meta = {
          pubkey: await unpackPubkeyData(rpc, config.addressConfig, resolved, instructionData),
          isSigner: config.isSigner,
          isWritable: config.isWritable,
        }
      } else {
        let programId: Pubkey
        if (config.discriminator === 1) {
          programId = hookProgram
        } else {
          const index = config.discriminator - 128
          const owner = index < 0 ? undefined : resolved[index]
          if (!owner) throw new HookResolutionError(`extra account ${config.discriminator} names no earlier account`)
          programId = owner.pubkey
        }
        const seeds = await unpackSeeds(rpc, config.addressConfig, resolved, instructionData)
        meta = {
          pubkey: findProgramAddress(seeds, programId).address,
          isSigner: config.isSigner,
          isWritable: config.isWritable,
        }
      }
      resolved.push(deEscalate(meta, resolved))
    }
    return {
      ok: true,
      accounts: [
        ...resolved.slice(5),
        { pubkey: hookProgram, isSigner: false, isWritable: false },
        { pubkey: validateState, isSigner: false, isWritable: false },
      ],
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

// ── Building a move, and naming what went wrong ────────────────────────────────────────────────

/** The associated token account for this owner under the MINT's program, not the classic default. */
export function ataFor(profile: MintProfile, owner: Pubkey): Pubkey {
  return associatedTokenAddress(owner, decodePubkey(profile.mint), decodePubkey(profile.tokenProgram))
}

/**
 * Which of R5's four names a failed send earns, from what was read BEFORE the send rather than
 * from the RPC's error text: a chain error string is not a contract, and every one of these four
 * conditions is visible in the mint and in the account states the CLI already read.
 *
 * Order matters: a non-transferable mint cannot move at all, a frozen account cannot move whatever
 * the hook says, and an unresolved hook tail is a better answer than a blanket "the hook refused".
 */
export function classifyTokenSendFailure(input: {
  profile: MintProfile
  /** True when the source or the destination token account is frozen, or would be created frozen. */
  frozen: boolean
  /** True when the hook's extra accounts could not be resolved and the transfer went without them. */
  extraAccountsMissing: boolean
}): Token2022LeftoverKind | undefined {
  if (!input.profile.token2022) return undefined
  if (input.profile.nonTransferable) return "TOKEN_2022_NOT_TRANSFERABLE"
  if (input.frozen) return "TOKEN_2022_FROZEN"
  if (input.extraAccountsMissing) return "TOKEN_2022_EXTRA_ACCOUNTS_MISSING"
  if (input.profile.transferHookProgram) return "TOKEN_2022_HOOK_REFUSED"
  return undefined
}
