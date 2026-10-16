/**
 * SEC-003: what `candle transfer` and `candle swap` check in a Solana transaction Candle built,
 * before a TEE wallet's relay signs it.
 *
 * For a TEE wallet the local P-256 key owns the wallet and Candle's server cannot sign, so these
 * checks are the boundary against a dishonest or compromised server build (the Hood path's
 * `transferLegMoves` and `relayHoodLegProblem` are the same boundary for EVM legs). They follow
 * `lp-close.ts`, which verifies a server-built position close the same way:
 *
 * - **Decode strictly, for this wallet.** The transaction must be one complete legacy or v0
 *   transaction whose fee payer is the wallet; v0 lookup tables are resolved over the wallet's own
 *   RPC, so every account an instruction names is known.
 * - **Refuse what hands over control, by instruction.** A top-level Token `Approve`,
 *   `ApproveChecked` or `SetAuthority`, a `CloseAccount` that pays its rent anywhere but the wallet,
 *   and a System `Assign` or `Allocate` of the wallet are refused before anything is simulated. A
 *   transfer is narrower still: only System `Transfer`, Token `Transfer` / `TransferChecked`, an
 *   associated token account create paid by the wallet, Compute Budget and Memo.
 * - **Simulate, then account for every balance.** The simulation runs with signature verification
 *   off and must succeed. From its pre and post state, the wallet's holdings are summed: SOL as the
 *   lamports of the wallet itself plus every token account it owns (rent and wrapped SOL alike), and
 *   each other mint as the amounts of its token accounts. A transfer must take exactly the
 *   confirmed amount of the confirmed asset, and nothing it moves may land anywhere but the wallet
 *   and the confirmed destination. A swap may take at most the confirmed amount of its input (plus
 *   the disclosed Candle fee), must deliver at least the confirmed minimum of its output, and may
 *   take nothing of any other asset. SOL may also fall by `SOLANA_OVERHEAD_LAMPORTS` for network
 *   and priority fees and the rent of accounts created for others.
 * - **Control never changes hands.** `controlChanges` (solana-alt) reads the same snapshots: the
 *   wallet stays a plain System account, and every token account it owns keeps its owner and gains
 *   no delegate and no close authority. An `Approve` reached by CPI moves no balance and is caught
 *   here.
 *
 * The simulation is evidence, not a guarantee: it runs against the chain as it is now, and a
 * program can behave differently once signed. Each check returns a reason, or null when it passed;
 * the command turns a reason into a refusal that ends "nothing was signed."
 */
import {
  COMPUTE_BUDGET_PROGRAM_ID,
  type CompiledKeys,
  controlChanges,
  type DecodedTransaction,
  decodeStrictBase64,
  decodeTransaction,
  describeControlChange,
  LookupTableError,
  MEMO_PROGRAM_ID,
  resolveCompiledKeys,
  type SimulationSnapshot,
  simulateWithSnapshots,
  TransactionDecodeError,
  tokenBalanceOf,
} from "./solana-alt"
import {
  type AccountView,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  isRateLimited,
  type SolanaRpc,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./solana-lite"

/** Wrapped SOL. Its token accounts hold lamports, so the SOL sum already counts them. */
export const NATIVE_MINT = "So11111111111111111111111111111111111111112"

/**
 * Lamports a transaction may cost the wallet beyond what it is confirmed to move: the network and
 * priority fees and the rent of any account it creates for someone else. 0.02 SOL, the server's
 * own drain backstop for a DFlow swap (`DFLOW_MAX_NATIVE_FEE_LAMPORTS`): generous on purpose, so a
 * busy slot's priority fee never refuses an honest build, and still far from a drain.
 */
export const SOLANA_OVERHEAD_LAMPORTS = 20_000_000n

/** What the operator confirmed. An asset is `"SOL"` or a mint address. */
export type SolanaSpend =
  | {
      kind: "transfer"
      asset: string
      /** Exactly this much leaves the wallet. */
      amountRaw: bigint
      /** The one other address that may gain anything. */
      recipient: string
    }
  | {
      kind: "swap"
      spend: string
      /** At most this much of `spend` leaves the wallet. */
      maxSpendRaw: bigint
      /** The asset the wallet must receive, and at least how much; absent for a bridge deposit. */
      receive?: { asset: string; minRaw: bigint }
    }

/** SPL Token instruction discriminators (identical under Token-2022). */
const TOKEN_IX_TRANSFER = 3
const TOKEN_IX_APPROVE = 4
const TOKEN_IX_SET_AUTHORITY = 6
const TOKEN_IX_CLOSE_ACCOUNT = 9
const TOKEN_IX_TRANSFER_CHECKED = 12
const TOKEN_IX_APPROVE_CHECKED = 13
/** System instruction indexes (u32 little-endian). */
const SYSTEM_IX_ASSIGN = 1
const SYSTEM_IX_TRANSFER = 2
const SYSTEM_IX_ALLOCATE = 8
/** Associated Token program: `Create` is an empty data or `[0]`; `CreateIdempotent` is `[1]`. */
const ATA_IX_CREATE = 0
const ATA_IX_CREATE_IDEMPOTENT = 1

/** The programs a plain transfer may call at the top level. */
const TRANSFER_PROGRAMS: ReadonlySet<string> = new Set([
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  MEMO_PROGRAM_ID,
])

function isTokenProgram(program: string | undefined): boolean {
  return program === TOKEN_PROGRAM_ID || program === TOKEN_2022_PROGRAM_ID
}

function systemIndex(data: Uint8Array): number {
  if (data.length < 4) return -1
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true)
}

/** Wrapped SOL is counted as SOL, so the two names are one asset. */
function assetOf(asset: string): string {
  return asset === NATIVE_MINT ? "SOL" : asset
}

/** The first top-level instruction that hands over control or does more than the spend needs. */
function instructionProblem(
  tx: DecodedTransaction,
  compiled: CompiledKeys,
  wallet: string,
  expect: SolanaSpend,
): string | null {
  for (const [i, ix] of tx.message.instructions.entries()) {
    const program = compiled.keys[ix.programIdIndex]
    const account = (at: number) => compiled.keys[ix.accountIndexes[at] ?? -1]
    const kind = ix.data[0]
    if (isTokenProgram(program)) {
      if (kind === TOKEN_IX_APPROVE || kind === TOKEN_IX_APPROVE_CHECKED)
        return `instruction ${i} approves a delegate over a token account`
      if (kind === TOKEN_IX_SET_AUTHORITY) return `instruction ${i} changes a token account's authority`
      // CloseAccount(account, destination, authority): the rent goes back to the wallet or nowhere.
      if (kind === TOKEN_IX_CLOSE_ACCOUNT && account(1) !== wallet)
        return `instruction ${i} closes a token account to ${account(1) ?? "?"}, not this wallet`
    }
    if (program === SYSTEM_PROGRAM_ID) {
      const index = systemIndex(ix.data)
      if ((index === SYSTEM_IX_ASSIGN || index === SYSTEM_IX_ALLOCATE) && account(0) === wallet)
        return `instruction ${i} reassigns this wallet to another program`
    }
    if (expect.kind !== "transfer") continue
    // A transfer is a System or Token transfer, an ATA create for the destination, and nothing more.
    if (program === undefined || !TRANSFER_PROGRAMS.has(program))
      return `instruction ${i} calls ${program ?? "an unknown program"}, which a transfer never does`
    if (program === SYSTEM_PROGRAM_ID && systemIndex(ix.data) !== SYSTEM_IX_TRANSFER)
      return `instruction ${i} is a System instruction other than Transfer`
    if (isTokenProgram(program) && kind !== TOKEN_IX_TRANSFER && kind !== TOKEN_IX_TRANSFER_CHECKED)
      return `instruction ${i} is a token instruction other than Transfer`
    if (program === ASSOCIATED_TOKEN_PROGRAM_ID) {
      const create = ix.data.length === 0 ? ATA_IX_CREATE : ix.data.length === 1 ? ix.data[0] : -1
      if (create !== ATA_IX_CREATE && create !== ATA_IX_CREATE_IDEMPOTENT)
        return `instruction ${i} is an Associated Token instruction other than Create`
      // Accounts: payer, ata, owner, mint, System, Token program.
      const owner = account(2)
      if (account(0) !== wallet || (owner !== expect.recipient && owner !== wallet))
        return `instruction ${i} creates a token account for ${owner ?? "?"}, not ${expect.recipient}`
    }
  }
  return null
}

/** The wallet's holdings on one side of the simulation: SOL in lamports, every other mint in raw units. */
function holdings(views: Array<{ address: string; view: AccountView | null }>, wallet: string): Map<string, bigint> {
  const out = new Map<string, bigint>()
  const add = (asset: string, amount: bigint) => out.set(asset, (out.get(asset) ?? 0n) + amount)
  for (const { address, view } of views) {
    if (view === null) continue
    if (address === wallet) {
      add("SOL", view.lamports)
      continue
    }
    const balance = tokenBalanceOf(view)
    if (balance === undefined || balance.owner !== wallet) continue
    add("SOL", view.lamports)
    if (balance.mint !== NATIVE_MINT) add(balance.mint, balance.amount)
  }
  return out
}

/** Every asset's change for the wallet, after minus before. */
function walletDeltas(simulation: SimulationSnapshot, wallet: string): Map<string, bigint> {
  const before = holdings(
    simulation.snapshots.map((s) => ({ address: s.address, view: s.before })),
    wallet,
  )
  const after = holdings(
    simulation.snapshots.map((s) => ({ address: s.address, view: s.after })),
    wallet,
  )
  const deltas = new Map<string, bigint>()
  for (const asset of new Set([...before.keys(), ...after.keys()]))
    deltas.set(asset, (after.get(asset) ?? 0n) - (before.get(asset) ?? 0n))
  if (!deltas.has("SOL")) deltas.set("SOL", 0n)
  return deltas
}

/** A transfer: exactly the amount leaves, and only the wallet and the recipient gain anything. */
function transferProblem(
  simulation: SimulationSnapshot,
  wallet: string,
  expect: Extract<SolanaSpend, { kind: "transfer" }>,
): string | null {
  const allowed = (address: string | undefined) => address === wallet || address === expect.recipient
  for (const { address, before, after } of simulation.snapshots) {
    const lamportsBefore = before?.lamports ?? 0n
    const lamportsAfter = after?.lamports ?? 0n
    const tokenAfter = tokenBalanceOf(after)
    const tokenBefore = tokenBalanceOf(before)
    if (lamportsAfter > lamportsBefore && !allowed(address) && !allowed(tokenAfter?.owner))
      return `${address} would receive ${lamportsAfter - lamportsBefore} lamports, and only ${expect.recipient} may`
    const amountBefore = tokenBefore?.amount ?? 0n
    const amountAfter = tokenAfter?.amount ?? 0n
    if (tokenAfter !== undefined && amountAfter > amountBefore && !allowed(tokenAfter.owner))
      return `${tokenAfter.owner} would receive ${amountAfter - amountBefore} raw of ${tokenAfter.mint}, and only ${expect.recipient} may`
  }
  const asset = assetOf(expect.asset)
  const deltas = walletDeltas(simulation, wallet)
  const sol = deltas.get("SOL") ?? 0n
  for (const [mint, delta] of deltas) {
    if (mint === "SOL" || mint === asset || delta >= 0n) continue
    return `the wallet would also lose ${-delta} raw of ${mint}`
  }
  if (asset === "SOL") {
    if (-sol < expect.amountRaw || -sol > expect.amountRaw + SOLANA_OVERHEAD_LAMPORTS)
      return `the wallet would lose ${-sol} lamports, not the ${expect.amountRaw} confirmed plus network fees`
    const recipient = simulation.snapshots.find((s) => s.address === expect.recipient)
    const received = (recipient?.after?.lamports ?? 0n) - (recipient?.before?.lamports ?? 0n)
    if (received !== expect.amountRaw)
      return `${expect.recipient} would receive ${received} lamports, not the ${expect.amountRaw} confirmed`
    return null
  }
  const moved = -(deltas.get(asset) ?? 0n)
  if (moved !== expect.amountRaw)
    return `the wallet would send ${moved} raw of ${asset}, not the ${expect.amountRaw} confirmed`
  if (-sol > SOLANA_OVERHEAD_LAMPORTS)
    return `the wallet would also lose ${-sol} lamports, more than network fees and rent`
  let received = 0n
  for (const { before, after } of simulation.snapshots) {
    const post = tokenBalanceOf(after)
    if (post === undefined || post.owner !== expect.recipient || post.mint !== asset) continue
    received += post.amount - (tokenBalanceOf(before)?.amount ?? 0n)
  }
  if (received <= 0n) return `${expect.recipient} would receive none of ${asset}`
  return null
}

/** A swap: at most the confirmed input leaves, at least the confirmed minimum arrives, nothing else is lost. */
function swapProblem(
  simulation: SimulationSnapshot,
  wallet: string,
  expect: Extract<SolanaSpend, { kind: "swap" }>,
): string | null {
  const spend = assetOf(expect.spend)
  const receive = expect.receive === undefined ? undefined : assetOf(expect.receive.asset)
  const deltas = walletDeltas(simulation, wallet)
  for (const [asset, delta] of deltas) {
    if (asset === "SOL" || asset === spend || asset === receive || delta >= 0n) continue
    return `the wallet would also lose ${-delta} raw of ${asset}`
  }
  const sol = deltas.get("SOL") ?? 0n
  const spent = -(deltas.get(spend) ?? 0n)
  const spendLimit = expect.maxSpendRaw + (spend === "SOL" ? SOLANA_OVERHEAD_LAMPORTS : 0n)
  if (spent > spendLimit)
    return `the wallet would spend ${spent} raw of ${spend}, more than the ${expect.maxSpendRaw} confirmed${spend === "SOL" ? " plus network fees" : ""}`
  if (spend !== "SOL" && receive !== "SOL" && -sol > SOLANA_OVERHEAD_LAMPORTS)
    return `the wallet would also lose ${-sol} lamports, more than network fees and rent`
  if (expect.receive === undefined || receive === undefined) return null
  const received = deltas.get(receive) ?? 0n
  const floor = expect.receive.minRaw - (receive === "SOL" ? SOLANA_OVERHEAD_LAMPORTS : 0n)
  if (received < floor || (receive !== "SOL" && received <= 0n))
    return `the wallet would receive ${received} raw of ${receive}, less than the ${expect.receive.minRaw} confirmed`
  return null
}

/**
 * Every SEC-003 check on one server-built transaction. Reads the chain over `rpc` (lookup tables,
 * the pre-state, the simulation) and signs nothing. Null when every check passed; otherwise the
 * reason. A rate limit is rethrown, so the caller's `tradingRead` reports it as one.
 */
export async function solanaSpendProblem(
  transactionBase64: string,
  wallet: string,
  rpc: SolanaRpc,
  expect: SolanaSpend,
): Promise<string | null> {
  let tx: DecodedTransaction
  try {
    tx = decodeTransaction(decodeStrictBase64(transactionBase64))
  } catch (error) {
    if (error instanceof TransactionDecodeError) return `the transaction does not decode: ${error.message}`
    throw error
  }
  if (tx.message.staticKeys[0] !== wallet) return `the fee payer is ${tx.message.staticKeys[0]}, not this wallet`
  let compiled: CompiledKeys
  try {
    compiled = await resolveCompiledKeys(tx.message, rpc)
  } catch (error) {
    if (error instanceof LookupTableError) return `a lookup table did not resolve: ${error.message}`
    throw error
  }
  const refused = instructionProblem(tx, compiled, wallet, expect)
  if (refused) return refused
  let simulation: SimulationSnapshot
  try {
    simulation = await simulateWithSnapshots(rpc, transactionBase64, compiled)
  } catch (error) {
    if (isRateLimited(error)) throw error
    return `the simulation could not be run: ${error instanceof Error ? error.message : String(error)}`
  }
  if (simulation.result.err !== null && simulation.result.err !== undefined)
    return `the simulation failed: ${JSON.stringify(simulation.result.err)}`
  const control = controlChanges(simulation.snapshots, (address) => address === wallet)
  if (control[0] !== undefined) return describeControlChange(control[0])
  return expect.kind === "transfer"
    ? transferProblem(simulation, wallet, expect)
    : swapProblem(simulation, wallet, expect)
}
