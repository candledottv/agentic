/**
 * Ember Phase 3 PR D, CLI half (BE-315, P3-ED-6): the sweep's handling of DAMM v2 LP positions.
 *
 * `solana-lite` compiles the legacy shapes the sweep builds itself and stays that way; `solana-alt`
 * decodes a v0 transaction something else built and reconstructs its compiled key order. This is
 * the one more dependency-free sibling the spec allows, and it holds exactly the rules an ordinary
 * `tee sweep` applies to a server-built position close before the TEE key signs it:
 *
 * - **Inventory is local.** A position NFT candidate is a Token-2022 token account with raw amount
 *   `1` AND mint decimals `0`, read over the wallet's own RPC. Every other Token-2022 account,
 *   raw amount `1` with decimals `6` included, stays on the generic transfer-then-close pass. No
 *   live positions listing is consulted.
 * - **The artifact is unsigned, v0, and for this wallet.** `POST /agent/lp/positions/:mint/close-build`
 *   returns one serialized transaction plus the server's resolved keys in compiled-v0 order. It is
 *   refused unless it decodes strictly, carries only zero signature slots, requires exactly one
 *   signer, and names the TEE wallet as that signer and fee payer.
 * - **The ordered key array is reproduced, never compared as a set.** The lookup tables the message
 *   names are fetched, their indexes applied, and the resulting static + loaded-writable +
 *   loaded-readonly order compared element for element with the server's array. A permutation, a
 *   different length, or an unresolvable table is a refusal.
 * - **Every top-level instruction is one a position close needs.** Compute Budget and DAMM v2
 *   instructions (at least one of the latter); an Associated Token `Create` / `CreateIdempotent`
 *   paid by the wallet for the wallet or the vault; and a Token / Token-2022 `CloseAccount` whose
 *   destination and authority are the wallet (the wSOL unwrap). Every other Token / Token-2022
 *   instruction (`SetAuthority`, `Approve`, `Transfer`, ...) and every top-level System instruction
 *   (`Assign`, `Transfer`, ...) is refused: an ATA create reaches System by CPI, and nothing else a
 *   close does needs them (security review of `1ec0ad10`, H1, defense in depth).
 * - **Simulation runs before any signature,** with signature verification off. It must succeed;
 *   every positive lamport or token delta must land on the TEE wallet or the pinned vault (or on a
 *   token account one of them controls); and the locally named NFT token account must end at zero
 *   or be gone.
 * - **Control never changes hands.** From the same simulation's post-state, every writable account
 *   that still exists keeps its program owner; the wallet and the vault stay System-owned with no
 *   data, and a simulation that deletes either of them is the same refusal as `Assign`; every
 *   token account the wallet or the vault controls keeps its mint, authority, delegate, state,
 *   delegated amount and close authority byte for byte; and a token account the close creates for
 *   the wallet or the vault starts with no delegate and no close authority. A `SetAuthority`,
 *   `Approve` or `Assign` moves no balance in the simulation and is exactly what this catches (H1).
 *   Any such change refuses the close.
 * - **Every writable key is classified** with `getAccountInfo`. A Token or Token-2022 account is
 *   admitted when its authority is the TEE wallet or the vault, when it is the named NFT token
 *   account, when it is the named NFT mint (burned by the close, so it is writable), or when its
 *   authority is an account owned by DAMM v2 (the pool's own token vaults). A System-owned account
 *   is admitted only when it IS the TEE wallet or the vault. Every other existing writable account
 *   must be owned by DAMM v2. A key that does not exist yet is admitted only when it is the
 *   canonical associated token account of the TEE wallet or the vault for a mint the transaction
 *   names, under that mint's own program: the destination ATA the close creates.
 *
 * Any refusal is `DAMM_CLOSE_TRANSACTION_REFUSED` on the sweep, raised before that close is signed.
 * An artifact that cannot be obtained at all is `DAMM_POSITION_CLOSE_UNAVAILABLE`. Neither aborts
 * the sweep's token or SOL moves. `describeClose` renders what a verified close does, from the
 * agreed ordered array and the simulation, for the operator to read before the key signs it.
 */
import {
  COMPUTE_BUDGET_PROGRAM_ID,
  type CompiledKeys,
  computeDeltas,
  type DecodedTransaction,
  decodeStrictBase64,
  decodeTransaction,
  LookupTableError,
  programNameOf,
  resolveCompiledKeys,
  type SimulationSnapshot,
  simulateWithSnapshots,
  TransactionDecodeError,
  tokenBalanceOf,
} from "./solana-alt"
import {
  type AccountView,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  decodePubkey,
  encodePubkey,
  type SolanaRpc,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  type TokenAccountView,
} from "./solana-lite"

/** Meteora DAMM v2 (`@meteora-ag/cp-amm-sdk`'s `CP_AMM_PROGRAM_ID`). The CLI ships no SDK; the id is enough. */
export const DAMM_V2_PROGRAM_ID = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"

/** The only programs a position close may call at the top level (P3-ED-6, step 4). */
export const CLOSE_PROGRAM_ALLOWLIST: ReadonlySet<string> = new Set([
  DAMM_V2_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
])

/** The two leftover kinds the sweep reports for a position it did not close (spec, typed codes). */
export const DAMM_POSITION_CLOSE_UNAVAILABLE = "DAMM_POSITION_CLOSE_UNAVAILABLE"
export const DAMM_CLOSE_TRANSACTION_REFUSED = "DAMM_CLOSE_TRANSACTION_REFUSED"

/**
 * A position NFT candidate: Token-2022, raw amount exactly 1, and mint decimals exactly 0. Both
 * conditions, so raw-unit fungible dust (amount 1 of a 6-decimal mint) stays on the generic path.
 */
export function isPositionCandidate(account: Pick<TokenAccountView, "programId" | "amountRaw" | "decimals">): boolean {
  return account.programId === TOKEN_2022_PROGRAM_ID && account.amountRaw === "1" && account.decimals === 0
}

export interface CloseArtifact {
  /** One serialized, unsigned v0 transaction, base64. */
  transaction: string
  /** The server's resolved account keys, in compiled-v0 order. */
  accountKeys: string[]
}

/** The close-build response body, or undefined when it does not carry the two fields. */
export function parseCloseArtifact(body: unknown): CloseArtifact | undefined {
  if (!body || typeof body !== "object") return undefined
  const { transaction, accountKeys } = body as { transaction?: unknown; accountKeys?: unknown }
  if (typeof transaction !== "string" || transaction.length === 0) return undefined
  if (!Array.isArray(accountKeys) || !accountKeys.every((key) => typeof key === "string" && key.length > 0))
    return undefined
  return { transaction, accountKeys: accountKeys as string[] }
}

export type CloseVerdict =
  | { ok: true; tx: DecodedTransaction; compiled: CompiledKeys; simulation: SimulationSnapshot }
  | { ok: false; reason: string }

/** SPL mint layout: a classic mint is exactly 82 bytes; a Token-2022 mint with extensions is padded to 165 and typed at 165. */
const MINT_BASE_SIZE = 82
const ACCOUNT_TYPE_OFFSET = 165
const ACCOUNT_TYPE_MINT = 1
const MULTISIG_SIZE = 355
/** SPL token account layout: mint 0..32, authority 32..64, amount 64..72, delegate COption 72..108,
 * state 108, is_native COption 109..121, delegated amount 121..129, close authority COption 129..165. */
const TOKEN_ACCOUNT_SIZE = 165
const TOKEN_ACCOUNT_STATE_INITIALIZED = 1
/** The byte ranges of a token account that decide who controls it, compared before and after. */
const CONTROL_RANGES: ReadonlyArray<readonly [number, number, string]> = [
  [0, 32, "mint"],
  [32, 64, "authority"],
  [72, 108, "delegate"],
  [108, 109, "state"],
  [121, 129, "delegated amount"],
  [129, 165, "close authority"],
]

/** SPL Token instruction discriminators (identical under Token-2022). */
const TOKEN_IX_CLOSE_ACCOUNT = 9
/** Associated Token program: `Create` is an empty data or `[0]`; `CreateIdempotent` is `[1]`. */
const ATA_IX_CREATE = 0
const ATA_IX_CREATE_IDEMPOTENT = 1

function isTokenProgram(owner: string): boolean {
  return owner === TOKEN_PROGRAM_ID || owner === TOKEN_2022_PROGRAM_ID
}

/** Whether a Token/Token-2022-owned account is a mint (by layout), as opposed to a token account or a multisig. */
export function isMintAccount(view: AccountView | null): boolean {
  if (view === null || !isTokenProgram(view.owner)) return false
  if (view.data.length === MINT_BASE_SIZE) return true
  if (view.data.length === MULTISIG_SIZE) return false
  return view.data.length > ACCOUNT_TYPE_OFFSET && view.data[ACCOUNT_TYPE_OFFSET] === ACCOUNT_TYPE_MINT
}

function isUnsigned(tx: DecodedTransaction): boolean {
  return tx.signatures.every((slot) => slot.every((byte) => byte === 0))
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

function allZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0)
}

/**
 * Apply every P3-ED-6 check to one close-build artifact. Reads the chain over `rpc`; signs
 * nothing; returns the decoded transaction and its compiled keys only when every check passed.
 * The caller signs `tx.message.bytes` afterwards, and only after every other artifact of the
 * sweep has been through this too.
 */
export async function verifyCloseArtifact(input: {
  artifact: CloseArtifact
  rpc: SolanaRpc
  /** The TEE wallet: the only signer, the fee payer, and one of the two allowed recipients. */
  tee: string
  /** The pinned vault: the other allowed recipient. */
  vault: string
  /** The position NFT mint the sweep discovered locally and named in the close-build path. */
  nftMint: string
  /** The TEE wallet's token account holding that NFT, from the same local inventory. */
  nftAccount: string
}): Promise<CloseVerdict> {
  const { artifact, rpc, tee, vault, nftMint, nftAccount } = input
  const refuse = (reason: string): CloseVerdict => ({ ok: false, reason })
  const allowedOwner = (address: string) => address === tee || address === vault

  // Step 2a: decode strictly. Legacy is refused too: close-build's contract is a v0 message with
  // an ordered key array, and a legacy artifact is not what the server promised.
  let tx: DecodedTransaction
  try {
    tx = decodeTransaction(decodeStrictBase64(artifact.transaction))
  } catch (error) {
    if (error instanceof TransactionDecodeError) return refuse(`the close transaction is undecodable: ${error.message}`)
    return refuse(`the close transaction could not be read: ${error instanceof Error ? error.message : error}`)
  }
  if (tx.message.version !== 0) return refuse("the close transaction is not a v0 message")
  if (!isUnsigned(tx))
    return refuse("the close transaction already carries a signature; close-build must return it unsigned")
  if (tx.message.numRequiredSignatures !== 1)
    return refuse(
      `the close transaction requires ${tx.message.numRequiredSignatures} signers; a position close needs only the TEE wallet`,
    )
  if (tx.message.staticKeys[0] !== tee)
    return refuse(`the fee payer is ${tx.message.staticKeys[0]}, not the TEE wallet`)

  // Step 2b: reconstruct the compiled order and compare it element for element.
  let compiled: CompiledKeys
  try {
    compiled = await resolveCompiledKeys(tx.message, rpc)
  } catch (error) {
    if (error instanceof LookupTableError) return refuse(`a lookup table could not be resolved: ${error.message}`)
    return refuse(`the lookup tables could not be read: ${error instanceof Error ? error.message : error}`)
  }
  if (compiled.keys.length !== artifact.accountKeys.length)
    return refuse(
      `the server listed ${artifact.accountKeys.length} account keys and the transaction resolves to ${compiled.keys.length}`,
    )
  for (const [i, key] of compiled.keys.entries()) {
    if (artifact.accountKeys[i] !== key)
      return refuse(
        `account key ${i} is ${key} in the transaction and ${artifact.accountKeys[i]} in the server's ordered array`,
      )
  }

  // Step 4 (program half): every top-level instruction is one a close needs, and DAMM v2 is among them.
  let dammCalls = 0
  for (const [i, ix] of tx.message.instructions.entries()) {
    const program = compiled.keys[ix.programIdIndex]
    const account = (at: number) => compiled.keys[ix.accountIndexes[at] ?? -1]
    if (program === undefined || !CLOSE_PROGRAM_ALLOWLIST.has(program))
      return refuse(`instruction ${i} calls ${program ?? "an unknown program"}, which a position close never does`)
    switch (program) {
      case DAMM_V2_PROGRAM_ID:
        dammCalls += 1
        break
      case COMPUTE_BUDGET_PROGRAM_ID:
        break
      case ASSOCIATED_TOKEN_PROGRAM_ID: {
        const kind = ix.data.length === 0 ? ATA_IX_CREATE : ix.data.length === 1 ? ix.data[0] : -1
        if (kind !== ATA_IX_CREATE && kind !== ATA_IX_CREATE_IDEMPOTENT)
          return refuse(
            `instruction ${i} is an Associated Token instruction other than Create, which a close never needs`,
          )
        // Accounts: payer, ata, owner, mint, System, Token program.
        if (account(0) !== tee || !allowedOwner(account(2) ?? ""))
          return refuse(
            `instruction ${i} creates a token account for ${account(2) ?? "?"}, not the TEE wallet or its vault`,
          )
        break
      }
      case TOKEN_PROGRAM_ID:
      case TOKEN_2022_PROGRAM_ID: {
        // Only the wSOL unwrap: CloseAccount(account, destination, authority) back to the wallet.
        if (ix.data[0] !== TOKEN_IX_CLOSE_ACCOUNT || ix.data.length !== 1)
          return refuse(
            `instruction ${i} is a token instruction other than CloseAccount, which a close never issues at the top level`,
          )
        if (account(1) !== tee || account(2) !== tee)
          return refuse(`instruction ${i} closes a token account to ${account(1) ?? "?"}, not the TEE wallet`)
        break
      }
      default:
        // System: a close reaches it only by CPI from the ATA create. Assign, Transfer, Allocate
        // and the rest change who controls the wallet's lamports and never belong here.
        return refuse(`instruction ${i} is a top-level System instruction, which a close never issues`)
    }
  }
  if (dammCalls === 0) return refuse("the transaction calls no DAMM v2 instruction, so it cannot close a position")

  // Step 3: simulate with signature verification off, and read the deltas.
  let simulation: SimulationSnapshot
  try {
    simulation = await simulateWithSnapshots(rpc, artifact.transaction, compiled)
  } catch (error) {
    return refuse(`the simulation could not be run: ${error instanceof Error ? error.message : error}`)
  }
  if (simulation.result.err !== null && simulation.result.err !== undefined)
    return refuse(`the simulation failed: ${JSON.stringify(simulation.result.err)}`)
  const deltas = computeDeltas(simulation.snapshots)
  const postState = new Map(simulation.snapshots.map((snapshot) => [snapshot.address, snapshot.after]))
  for (const token of deltas.tokens) {
    if (token.after > token.before && !allowedOwner(token.owner))
      return refuse(
        `${token.owner} would receive ${token.after - token.before} raw of ${token.mint} in account ${token.account}`,
      )
  }
  for (const sol of deltas.sol) {
    if (sol.after <= sol.before) continue
    if (allowedOwner(sol.address)) continue
    // A token account's lamports are its rent; it belongs to whoever controls it.
    const balance = tokenBalanceOf(postState.get(sol.address) ?? null)
    if (balance !== undefined && allowedOwner(balance.owner)) continue
    return refuse(`${sol.address} would receive ${sol.after - sol.before} lamports`)
  }
  const nftSnapshot = simulation.snapshots.find((snapshot) => snapshot.address === nftAccount)
  if (nftSnapshot === undefined)
    return refuse(`the position NFT account ${nftAccount} is not written by this transaction`)
  const nftAfter = tokenBalanceOf(nftSnapshot.after)
  if (nftAfter !== undefined && nftAfter.amount !== 0n)
    return refuse(`the position NFT account ${nftAccount} still holds ${nftAfter.amount} after the simulation`)

  // Step 3b (H1): control never changes hands. Compared from the same post-state the deltas came
  // from, so a SetAuthority, Approve or Assign that moves no balance is still seen. Deleting the
  // wallet or the vault is the same failure as Assign: the later token and SOL passes need both
  // to still be plain System accounts.
  for (const { address, before, after } of simulation.snapshots) {
    if (allowedOwner(address)) {
      if (after === null || after.owner !== SYSTEM_PROGRAM_ID || after.data.length !== 0)
        return refuse(
          `${address === tee ? "the TEE wallet" : "the vault"} would no longer be a plain System account after this transaction`,
        )
    }
    if (after === null) continue
    if (before !== null && after.owner !== before.owner)
      return refuse(`writable account ${address} would change owner from ${before.owner} to ${after.owner}`)
    if (before !== null) {
      const controlled = tokenBalanceOf(before)
      if (controlled !== undefined && allowedOwner(controlled.owner)) {
        if (after.data.length < TOKEN_ACCOUNT_SIZE)
          return refuse(`token account ${address} would no longer decode as a token account`)
        for (const [start, end, what] of CONTROL_RANGES) {
          if (!bytesEqual(before.data.subarray(start, end), after.data.subarray(start, end)))
            return refuse(`token account ${address} would change its ${what}, which a close never does`)
        }
        continue
      }
    }
    const created = before === null ? tokenBalanceOf(after) : undefined
    if (created !== undefined) {
      // A token account the close creates: the wallet's or the vault's, with nothing delegated.
      if (!allowedOwner(created.owner))
        return refuse(`created token account ${address} would be controlled by ${created.owner}`)
      if (
        !allZero(after.data.subarray(72, 108)) ||
        after.data[108] !== TOKEN_ACCOUNT_STATE_INITIALIZED ||
        !allZero(after.data.subarray(121, 129)) ||
        !allZero(after.data.subarray(129, 165))
      )
        return refuse(
          `created token account ${address} would start with a delegate, a close authority, or a frozen state`,
        )
    }
  }

  // Step 4 (account half): classify every writable key.
  const infos = new Map<string, AccountView | null>()
  const infoOf = async (address: string): Promise<AccountView | null> => {
    if (!infos.has(address)) infos.set(address, await rpc.getAccountInfo(address))
    return infos.get(address) ?? null
  }
  // Mints the transaction names, under their own program: the only source of admissible missing keys.
  const canonical = new Set<string>()
  for (const key of compiled.keys) {
    const view = await infoOf(key)
    if (!isMintAccount(view) || view === null) continue
    const mint = decodePubkey(key)
    const program = decodePubkey(view.owner)
    canonical.add(encodePubkey(associatedTokenAddress(decodePubkey(tee), mint, program)))
    canonical.add(encodePubkey(associatedTokenAddress(decodePubkey(vault), mint, program)))
  }
  for (const [i, key] of compiled.keys.entries()) {
    if (!compiled.isWritable[i]) continue
    const view = await infoOf(key)
    if (view === null) {
      if (canonical.has(key)) continue
      return refuse(
        `writable account ${key} does not exist and is not a TEE or vault associated token account for a mint this transaction names`,
      )
    }
    if (isTokenProgram(view.owner)) {
      if (key === nftMint) continue
      const balance = tokenBalanceOf(view)
      if (balance === undefined)
        return refuse(`writable account ${key} is owned by a token program but is not a token account`)
      if (allowedOwner(balance.owner) || key === nftAccount) continue
      const authority = await infoOf(balance.owner)
      if (authority !== null && authority.owner === DAMM_V2_PROGRAM_ID) continue
      return refuse(
        `writable token account ${key} is controlled by ${balance.owner}, which is neither this wallet, its vault, nor a DAMM v2 pool`,
      )
    }
    if (view.owner === SYSTEM_PROGRAM_ID) {
      if (allowedOwner(key)) continue
      return refuse(`writable system account ${key} is neither the TEE wallet nor its vault`)
    }
    if (view.owner !== DAMM_V2_PROGRAM_ID)
      return refuse(`writable account ${key} is owned by ${view.owner}, not DAMM v2`)
  }
  return { ok: true, tx, compiled, simulation }
}

function formatSol(lamports: bigint): string {
  const negative = lamports < 0n
  const abs = negative ? -lamports : lamports
  const whole = abs / 1_000_000_000n
  const frac = (abs % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "")
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""} SOL`
}

/**
 * What a verified close does, for the operator to read before the key signs it (P3-ED-6 step 2:
 * "decode and display the transaction from that agreed ordered array"). Pure, so a test can pin
 * it. Amounts are raw units: the sweep has the mint decimals only for the NFT candidate itself.
 */
export function describeClose(input: {
  verdict: Extract<CloseVerdict, { ok: true }>
  tee: string
  vault: string
  nftMint: string
  nftAccount: string
}): string[] {
  const { verdict, tee, vault, nftMint, nftAccount } = input
  const { tx, compiled, simulation } = verdict
  const lines: string[] = []
  lines.push(
    `message     v0, ${tx.message.instructions.length} instruction(s), ${compiled.keys.length} account(s)${tx.message.lookups.length > 0 ? ` (${tx.message.lookups.length} lookup table(s) resolved)` : ""}, blockhash ${tx.message.recentBlockhash}`,
  )
  lines.push(`fee payer   ${compiled.keys[0]} (this TEE wallet)`)
  lines.push(`position    NFT mint ${nftMint}, account ${nftAccount}`)
  const programs = [...new Set(tx.message.instructions.map((ix) => compiled.keys[ix.programIdIndex] ?? "?"))]
  for (const program of programs)
    lines.push(
      `program     ${program === DAMM_V2_PROGRAM_ID ? `Meteora DAMM v2 (${program})` : programNameOf(program)}`,
    )
  const deltas = computeDeltas(simulation.snapshots)
  const who = (address: string) => (address === tee ? "wallet" : address === vault ? "vault" : address)
  for (const address of [tee, vault]) {
    const sol = deltas.sol.find((delta) => delta.address === address)
    if (sol && sol.after !== sol.before)
      lines.push(
        `${who(address).padEnd(11)} ${formatSol(sol.before)} -> ${formatSol(sol.after)} (${sol.after >= sol.before ? "+" : ""}${formatSol(sol.after - sol.before)})`,
      )
    for (const token of deltas.tokens.filter((delta) => delta.owner === address && delta.after !== delta.before)) {
      lines.push(
        `${who(address).padEnd(11)} ${token.mint}: ${token.before} -> ${token.after} raw (${token.after >= token.before ? "+" : ""}${token.after - token.before}) in ${token.account}${token.account === nftAccount ? " (position NFT, burned)" : ""}`,
      )
    }
  }
  const nft = simulation.snapshots.find((snapshot) => snapshot.address === nftAccount)
  if (nft && nft.after === null) lines.push(`position    NFT account ${nftAccount} is closed by this transaction`)
  const others = deltas.tokens.filter(
    (token) => token.owner !== tee && token.owner !== vault && token.after !== token.before,
  )
  for (const token of others)
    lines.push(
      `${token.owner === undefined ? "?" : "pool"}        ${token.mint}: ${token.before} -> ${token.after} raw in ${token.account} (authority ${token.owner})`,
    )
  lines.push("checked     ordered keys, programs, simulation, positive deltas, control, writable accounts: all passed")
  lines.push("note        the simulation is evidence, not a guarantee: a program can behave differently once signed")
  return lines
}
