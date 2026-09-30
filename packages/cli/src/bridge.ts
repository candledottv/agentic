/**
 * Ember Phase 4c rollout C (BE-560, spec docs/superpowers/specs/2026-09-29-ember-phase-4c-relay-bridging-design.md):
 * the CLI's half of a bridge between Solana and Hood through `candle swap`.
 *
 * A bridge is a TEE-wallet swap on Candle's Relay rail (4c-AD-1, 4c-AD-2). The server resolves the
 * destination, caps the spend and verifies Relay's steps before it stamps anything (4c-ED-1,
 * 4c-ED-3, 4c-ED-5). This module is the independent second check (4c-ED-6) and the reads the
 * sweep and status commands make of the server's open-bridge state (4c-ED-9, 4c-ED-10):
 *
 * - **Hood legs.** Every sequenced leg is decoded against the pinned depository, selectors and
 *   calldata lengths from `relay-constants.ts` (kept equal to `packages/shared` by a drift test)
 *   before the relay signs it: an approve only to USDG, for the depository, of exactly the amount;
 *   a deposit whose `depositor`, `token` and `amount` are the payer, the origin token and the amount.
 * - **Solana deposit.** The returned transaction is decoded, its lookup tables are resolved (one
 *   that does not resolve refuses; it is never skipped), and it must have the payer as fee payer
 *   and only signer, and the Relay depository as its only top-level program. No Compute Budget.
 * - **Open bridges.** The wallet reads carry `bridges`. A sweep refuses `BRIDGE_IN_FLIGHT` while one
 *   is `open`; `uncertain` (past two hours) is a warning. The CLI never asks Relay itself.
 *
 * The server's checks are the enforcement. These are defense in depth: a refusal here means nothing
 * was signed, never that the server would have accepted it.
 */
import { z } from "zod"
import { HOOD_USDG_ADDRESS, sameEvmAddress } from "./evm-lite"
import {
  RELAY_HOOD_DEPOSIT_ERC20_SELECTOR,
  RELAY_HOOD_DEPOSIT_NATIVE_SELECTOR,
  RELAY_HOOD_DEPOSITORY,
  RELAY_SOLANA_DEPOSITORY_PROGRAM,
} from "./relay-constants"
import {
  COMPUTE_BUDGET_PROGRAM_ID,
  decodeStrictBase64,
  decodeTransaction,
  LookupTableError,
  resolveCompiledKeys,
  TransactionDecodeError,
} from "./solana-alt"
import type { SolanaRpc } from "./solana-lite"
import { decimalAmount, type LegKind, type SequencedLeg, safeText, type TradeAsset, type TradeChain } from "./trading"

/** The four assets a bridge may start or end on (4c-ED-2). CNDL and tokens convert first. */
export type BridgeAsset = "SOL" | "USDC" | "ETH" | "USDG"

export const BRIDGE_ASSETS: Record<BridgeAsset, { chain: TradeChain; decimals: number }> = {
  SOL: { chain: "solana", decimals: 9 },
  USDC: { chain: "solana", decimals: 6 },
  ETH: { chain: "hood", decimals: 18 },
  USDG: { chain: "hood", decimals: 6 },
}

function isBridgeAsset(value: string | undefined): value is BridgeAsset {
  return value !== undefined && Object.hasOwn(BRIDGE_ASSETS, value)
}

/**
 * The pair as a bridge, or null. A bridge is a base asset on each chain: SOL or USDC on one side,
 * ETH or USDG on the other. Every other cross-chain pair (a token, CNDL) stays `CHAIN_MISMATCH`.
 */
export function bridgePair(from: TradeAsset, to: TradeAsset): { from: BridgeAsset; to: BridgeAsset } | null {
  if (from.chain === to.chain || !isBridgeAsset(from.base) || !isBridgeAsset(to.base)) return null
  return { from: from.base, to: to.base }
}

/** The Hood leg kinds a bridge may sign: an exact approve for USDG, then the deposit (4c-ED-7). */
export function bridgeLegKinds(origin: "ETH" | "USDG"): LegKind[] {
  return origin === "USDG" ? ["approval", "bridgeDeposit"] : ["bridgeDeposit"]
}

/**
 * Whether a Hood bridge's plan is one the spec admits (4c-ED-5: zero or one approve, then exactly
 * one deposit). A USDG bridge may be the deposit alone, when the wallet's allowance to the
 * depository already covers the amount (an approve that landed before a deposit that did not);
 * the server builds that plan too. A native ETH bridge is only ever the deposit.
 */
export function bridgePlanAdmitted(origin: "ETH" | "USDG", plan: LegKind[] | undefined): boolean {
  const shape = plan?.join()
  return shape === "bridgeDeposit" || (origin === "USDG" && shape === "approval,bridgeDeposit")
}

// ── Hood legs (4c-ED-5's Hood rules, from the CLI's own copy of the constants) ─────────────────

const APPROVE_SELECTOR = "0x095ea7b3"

/** 32-byte ABI word `index` after the selector, lowercase hex without 0x. */
function word(data: string, index: number): string {
  return data.slice(10 + index * 64, 10 + (index + 1) * 64)
}

/** An ABI address word: 12 zero bytes then the address. Null when the padding is dirty. */
function wordAddress(data: string, index: number): string | null {
  const w = word(data, index)
  return w.length === 64 && /^0{24}/.test(w) ? `0x${w.slice(24)}` : null
}

function wordUint(data: string, index: number): bigint | null {
  const w = word(data, index)
  return w.length === 64 ? BigInt(`0x${w}`) : null
}

/**
 * Why a Hood bridge leg must not be signed, or null when it is exactly the leg this bridge
 * confirmed. The chain id is checked by the leg loop itself.
 */
export function relayHoodLegProblem(
  kind: LegKind,
  leg: SequencedLeg,
  expect: { origin: "ETH" | "USDG"; payer: string; amountRaw: string },
): string | null {
  const data = leg.data.toLowerCase()
  const bytes = (data.length - 2) / 2
  const selector = data.slice(0, 10)
  const amount = BigInt(expect.amountRaw)
  const value = BigInt(leg.value)
  const payer = expect.payer.toLowerCase()
  const usdg = HOOD_USDG_ADDRESS.toLowerCase()

  if (kind === "approval") {
    if (expect.origin !== "USDG") return "a native ETH bridge has no approval"
    if (!sameEvmAddress(leg.to, usdg)) return `the approval is to ${leg.to}, not USDG`
    if (selector !== APPROVE_SELECTOR) return `the approval's selector is ${selector}`
    if (bytes !== 68) return `the approval's calldata is ${bytes} bytes, not 68`
    if (wordAddress(data, 0) !== RELAY_HOOD_DEPOSITORY) return "the approval's spender is not Relay's depository"
    if (wordUint(data, 1) !== amount) return `the approval is for ${String(wordUint(data, 1))}, not ${amount}`
    if (value !== 0n) return `the approval carries ${value} wei`
    return null
  }
  if (kind !== "bridgeDeposit") return `a bridge never signs a ${kind} leg`
  if (!sameEvmAddress(leg.to, RELAY_HOOD_DEPOSITORY)) return `the deposit is to ${leg.to}, not Relay's depository`
  if (expect.origin === "ETH") {
    if (selector !== RELAY_HOOD_DEPOSIT_NATIVE_SELECTOR) return `the deposit's selector is ${selector}`
    if (bytes !== 68) return `the deposit's calldata is ${bytes} bytes, not 68`
    if (wordAddress(data, 0) !== payer) return "the deposit's depositor is not this wallet"
    if (value !== amount) return `the deposit sends ${value} wei, not ${amount}`
    return null
  }
  if (selector !== RELAY_HOOD_DEPOSIT_ERC20_SELECTOR) return `the deposit's selector is ${selector}`
  if (bytes !== 132) return `the deposit's calldata is ${bytes} bytes, not 132`
  if (wordAddress(data, 0) !== payer) return "the deposit's depositor is not this wallet"
  if (wordAddress(data, 1) !== usdg) return "the deposit's token is not USDG"
  if (wordUint(data, 2) !== amount) return `the deposit is for ${String(wordUint(data, 2))}, not ${amount}`
  if (value !== 0n) return `the deposit carries ${value} wei`
  return null
}

// ── Solana deposit (4c-ED-6) ──────────────────────────────────────────────────────────────────

/**
 * Why the Solana deposit must not be signed, or null. Decodes the transaction Candle returned,
 * resolves every lookup table over the caller's RPC, and requires the payer as fee payer and only
 * signer and Relay's depository as every top-level program. A rate limit from the RPC is rethrown
 * for the caller's `RPC_RATE_LIMITED`; every other read failure is an unresolved table, a refusal.
 * The simulation and the network-fee cap are the server's (4c-ED-5); this check needs no key.
 */
export async function relaySolanaDepositProblem(
  transactionBase64: string,
  payer: string,
  rpc: SolanaRpc,
): Promise<string | null> {
  let decoded: ReturnType<typeof decodeTransaction>
  try {
    decoded = decodeTransaction(decodeStrictBase64(transactionBase64))
  } catch (error) {
    if (error instanceof TransactionDecodeError) return `the deposit does not decode: ${error.message}`
    throw error
  }
  const message = decoded.message
  if (message.numRequiredSignatures !== 1)
    return `the deposit needs ${message.numRequiredSignatures} signatures; a bridge has one signer`
  if (message.staticKeys[0] !== payer) return `the deposit's fee payer is ${message.staticKeys[0]}, not this wallet`
  let keys: string[]
  try {
    keys = (await resolveCompiledKeys(message, rpc)).keys
  } catch (error) {
    if (error instanceof LookupTableError) return `a lookup table did not resolve: ${error.message}`
    throw error
  }
  if (message.instructions.length === 0) return "the deposit has no instructions"
  for (const instruction of message.instructions) {
    const program = keys[instruction.programIdIndex]
    if (program === COMPUTE_BUDGET_PROGRAM_ID) return "the deposit carries a Compute Budget instruction"
    if (program !== RELAY_SOLANA_DEPOSITORY_PROGRAM) return `the deposit calls ${program}, not Relay's depository`
  }
  return null
}

// ── Open bridges on a wallet read (4c-ED-10) ──────────────────────────────────────────────────

const walletBridgeSchema = z
  .object({
    clientTradeId: z.string(),
    role: z.enum(["source", "recipient"]),
    state: z.enum(["open", "uncertain"]),
    openedAt: z.number(),
    blockingUntil: z.number().optional(),
  })
  .passthrough()
export type WalletBridge = z.infer<typeof walletBridgeSchema>

/**
 * The `bridges` field of a wallet read (`/lifecycle`, `/hood-tee`, the disable answer). An array
 * is the open and `uncertain` bridges; null is the server saying it could not read them; undefined
 * is an API that predates bridges. A field that does not parse is treated as unread (null).
 */
export function walletBridgesOf(body: unknown): WalletBridge[] | null | undefined {
  if (!body || typeof body !== "object" || !("bridges" in body)) return undefined
  const raw = (body as { bridges?: unknown }).bridges
  if (raw === undefined) return undefined
  if (raw === null) return null
  const parsed = z.array(walletBridgeSchema).safeParse(raw)
  return parsed.success ? parsed.data : null
}

function direction(bridge: WalletBridge): string {
  return bridge.role === "recipient" ? "into" : "out of"
}

/**
 * The sweep's gate (R4). `open` refuses `BRIDGE_IN_FLIGHT` before anything is signed; `uncertain`
 * and an unread state are warnings, and the sweep goes on. The server refuses the `swept` record
 * the same way, so this is the local half.
 */
export function bridgeSweepGate(
  address: string,
  bridges: WalletBridge[] | null | undefined,
): {
  refusal?: { code: "BRIDGE_IN_FLIGHT"; message: string; suggestion: string; details: Record<string, unknown> }
  warnings: string[]
} {
  const warnings: string[] = []
  if (bridges === null)
    warnings.push(
      `Warning: Candle could not say whether a bridge into or out of ${address} is open. If one is, its fill or refund lands after this sweep and needs a second sweep.`,
    )
  const open = (bridges ?? []).find((bridge) => bridge.state === "open")
  if (open) {
    const until =
      open.blockingUntil !== undefined ? new Date(open.blockingUntil).toISOString() : "two hours after it opened"
    return {
      refusal: {
        code: "BRIDGE_IN_FLIGHT",
        message: `A bridge ${direction(open)} ${address} is still open (${safeText(open.clientTradeId)}); its fill or refund may still land here.`,
        suggestion: `Nothing was signed. Check it with candle swap status ${safeText(open.clientTradeId)} and sweep once it closes. From ${until} it is a warning and the sweep goes ahead.`,
        details: { bridges },
      },
      warnings,
    }
  }
  for (const bridge of bridges ?? [])
    warnings.push(
      `Warning: bridge ${safeText(bridge.clientTradeId)} ${direction(bridge)} ${address} has had no result for over two hours. The sweep goes ahead; if its fill or refund lands later, sweep this wallet again.`,
    )
  return { warnings }
}

/** What `tee disable` prints about bridges that will still pay into or refund to the wallet. */
export function bridgeDisableWarnings(address: string, body: unknown): string[] {
  return (walletBridgesOf(body) ?? []).map(
    (bridge) =>
      `Bridge ${safeText(bridge.clientTradeId)} ${direction(bridge)} ${address} is ${bridge.state === "open" ? "still open" : "unresolved after two hours"}: its fill or refund still lands in this wallet. Check it with candle swap status ${safeText(bridge.clientTradeId)}; if it lands after the sweep, sweep again.`,
  )
}

/** What `tee sweep --emergency` prints: it asks the API nothing, so it cannot see a bridge. */
export const EMERGENCY_BRIDGE_NOTE =
  "An emergency sweep cannot see an open bridge. If a bridge's fill or refund lands in this wallet after the sweep, sweep it again."

// ── Status (4c-ED-9) ──────────────────────────────────────────────────────────────────────────

/**
 * Where a bridge stands, from the job read. `filled`, `failed` and `uncertain` are the settlement's
 * end states; the others are on the way there.
 */
export type BridgePhase = "not_broadcast" | "depositing" | "filling" | "filled" | "failed" | "uncertain"

const jobSettlementSchema = z
  .object({
    state: z.enum(["settled", "pending", "failed", "uncertain"]),
    legs: z.array(z.object({ status: z.string() }).passthrough()).default([]),
    settledOutRaw: z.string().regex(/^\d+$/).optional(),
  })
  .passthrough()
const jobBridgeSchema = z.union([
  z.object({ state: z.literal("open"), blockingUntil: z.number() }).passthrough(),
  z.object({ state: z.literal("uncertain") }).passthrough(),
])

/** Facts about a bridge this machine built, kept beside the operation (the job read does not carry them). */
export interface BridgeFacts {
  from: BridgeAsset
  to: BridgeAsset
  recipient: string
  /** Relay's status URL: where the destination transaction is named. */
  statusCheck?: string
}

export interface BridgeStatus {
  phase: BridgePhase
  /** The job's `bridge` field: open inside two hours, or `uncertain` after. Absent once closed. */
  open?: "open" | "uncertain"
  blockingUntil?: number
  settledOutRaw?: string
  lines: string[]
}

/**
 * A job read in words (4c-ED-9): deposit landed, filling, filled with the amount, refunded or
 * failed, uncertain, and the two-hour warning. Relay reports a refund and a failure the same way,
 * so a failure after the deposit landed says both.
 */
export function describeBridgeJob(job: Record<string, unknown>, facts?: BridgeFacts): BridgeStatus {
  const settlement = jobSettlementSchema.safeParse(job.settlement)
  const reading = settlement.success ? settlement.data : undefined
  const bridge = jobBridgeSchema.safeParse(job.bridge)
  const open = bridge.success ? bridge.data : undefined
  const landed = reading !== undefined && reading.legs.length > 0 && reading.legs.every((l) => l.status === "confirmed")
  let phase: BridgePhase
  let line: string
  if (reading?.state === "settled") {
    phase = "filled"
    const amount =
      reading.settledOutRaw === undefined
        ? "an amount Candle did not measure"
        : facts
          ? `${decimalAmount(reading.settledOutRaw, BRIDGE_ASSETS[facts.to].decimals)} ${facts.to}`
          : `${reading.settledOutRaw} raw units`
    line = `Filled: received ${amount}${facts ? ` at ${safeText(facts.recipient)}` : ""}.`
  } else if (reading?.state === "failed") {
    phase = "failed"
    line = landed
      ? "Failed or refunded: the deposit landed and Relay did not fill it. Relay refunds to the source wallet; check its balance."
      : "Failed: the deposit did not land on the source chain, so nothing was bridged."
  } else if (reading?.state === "uncertain") {
    phase = "uncertain"
    line = "Uncertain: Relay reported a result Candle could not attribute to one fill. Check the destination wallet."
  } else if (reading?.state === "pending") {
    phase = landed ? "filling" : "depositing"
    line = landed ? "Deposit landed; Relay is filling." : "Deposit sent; waiting for it to land."
  } else if (job.status === "failed") {
    phase = "failed"
    line = "Failed before the deposit was sent; nothing was bridged."
  } else if (typeof job.signature === "string" || job.status === "submitted" || job.status === "confirmed") {
    phase = "depositing"
    line = "Deposit sent; Candle has not measured it yet."
  } else {
    phase = "not_broadcast"
    line = "Built; the deposit has not been sent."
  }
  const lines = [line]
  if (facts?.statusCheck && phase !== "not_broadcast") lines.push(`Relay status: ${safeText(facts.statusCheck)}`)
  if (open?.state === "open")
    lines.push(
      `Open: a sweep of the source or destination wallet refuses BRIDGE_IN_FLIGHT until it closes or until ${new Date(open.blockingUntil).toISOString()}.`,
    )
  if (open?.state === "uncertain")
    lines.push(
      "Warning: no result after two hours. Sweeps now go ahead; if the fill or refund lands later, sweep that wallet again.",
    )
  return {
    phase,
    ...(open ? { open: open.state } : {}),
    ...(open?.state === "open" ? { blockingUntil: open.blockingUntil } : {}),
    ...(reading?.settledOutRaw !== undefined ? { settledOutRaw: reading.settledOutRaw } : {}),
    lines,
  }
}

/**
 * `--wait` stops on these: the settlement's end states, the two-hour warning, or a build that was
 * never broadcast and that the server no longer holds open (nothing is coming to wait for).
 */
export function bridgeStatusFinal(status: BridgeStatus): boolean {
  return (
    status.phase === "filled" ||
    status.phase === "failed" ||
    status.phase === "uncertain" ||
    status.open === "uncertain" ||
    (status.phase === "not_broadcast" && status.open === undefined)
  )
}

/** R1: `--wait` polls for at most ten minutes. */
export const BRIDGE_WAIT_MS = 10 * 60 * 1000
export const BRIDGE_WAIT_POLL_MS = 10_000
