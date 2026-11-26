/**
 * BE-4350: Hood generation 2 launch options on `candle launch`, mapped to the API's top-level
 * request keys (`snipeExempt`, `feeWallet`, `creatorFeeBps`, `teamAllocation`; `launchRules` with
 * sniper fee fields lives in `launch-rules.ts`). Client validation is per chain: Solana keeps its
 * `0 | 100 | 200` `exp-*` creator fee and refuses Hood-only flags; Hood takes any whole-number
 * `creatorFeeBps` under the combined 100% rate guard plus non-zero 0x EVM addresses and team vesting.
 */
import { looksLikeEvmAddress, toChecksumAddress } from "./evm-lite"
import { LAUNCH_DEFINITION } from "./launch-definition"
import { parseDuration } from "./launch-rules"
import { safeText, type TradeChain } from "./trading"

type Flags = Partial<Record<string, string | undefined>>

const ZERO_EVM_ADDRESS = "0x0000000000000000000000000000000000000000"

export const HOOD_ONLY_LAUNCH_FLAGS = [
  "--snipe-fee-start-bps",
  "--snipe-fee-decay",
  "--snipe-exempt",
  "--team-recipient",
  "--team-percent",
  "--team-cliff-days",
  "--team-vesting-days",
] as const

const TEAM_FLAGS = ["--team-recipient", "--team-percent", "--team-cliff-days", "--team-vesting-days"] as const

export interface HoodTeamAllocationBody {
  recipient: string
  percent: number
  cliffDays: number
  vestingDays: number
}

export interface HoodGen2TopFields {
  snipeExempt?: string[]
  feeWallet?: string
  teamAllocation?: HoodTeamAllocationBody
}

const solanaCreatorFeeValues = (): readonly number[] => {
  const found = LAUNCH_DEFINITION.fields.find((field) => field.key === "creatorFeeBps")
  return found && "valuesByChain" in found && found.valuesByChain?.solana ? found.valuesByChain.solana : [0, 100, 200]
}

export function nonZeroEvmAddress(value: string, label: string): string {
  const trimmed = value.trim()
  if (!looksLikeEvmAddress(trimmed)) throw new Error(`${label} must be a 0x EVM address.`)
  if (trimmed.toLowerCase() === ZERO_EVM_ADDRESS) throw new Error(`${label} cannot be the zero address.`)
  return toChecksumAddress(trimmed)
}

export function isNonZeroEvmAddress(value: string): boolean {
  const trimmed = value.trim()
  return looksLikeEvmAddress(trimmed) && trimmed.toLowerCase() !== ZERO_EVM_ADDRESS
}

/** First Hood-only CLI flag present on a Solana launch, or undefined. */
export function hoodOnlyFlagOnSolanaProblem(flags: Flags): string | undefined {
  for (const flag of HOOD_ONLY_LAUNCH_FLAGS) {
    if (flags[flag] !== undefined) return `${flag} is only available on Hood launches.`
  }
  return undefined
}

/** Per-chain `--creator-fee-bps` validation, matching Solana's exp-* enum and Hood's integer + sum rule. */
export function creatorFeeProblemForChain(flags: Flags, chain: TradeChain): string | undefined {
  const raw = flags["--creator-fee-bps"]
  if (raw === undefined) return undefined
  const bps = Number(raw)
  if (chain === "solana") {
    const allowed = solanaCreatorFeeValues()
    if (!allowed.includes(bps)) return `--creator-fee-bps takes ${allowed.join(", ")}.`
    if (!flags["--mode"]?.startsWith("exp-")) return "--creator-fee-bps takes an exp- --mode."
    return undefined
  }
  const { curveFeeBps, maxCreatorFeeBps } = LAUNCH_DEFINITION.hoodGen2
  if (!Number.isInteger(bps) || bps < 0 || bps > maxCreatorFeeBps)
    return `--creator-fee-bps must be a whole number from 0 to ${maxCreatorFeeBps}.`
  const snipeStart = flags["--snipe-fee-start-bps"] !== undefined ? Number(flags["--snipe-fee-start-bps"]) : 0
  if (curveFeeBps + bps + snipeStart >= 10_000)
    return "the curve fee, creator fee and sniper fee at its peak must total under 100%"
  return undefined
}

/** Parse `--snipe-exempt <0x,...>` into 0..32 distinct checksummed non-zero EVM addresses. */
export function parseSnipeExemptFlag(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  const parts = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  const max = Number(
    (LAUNCH_DEFINITION.fields.find((field) => field.key === "snipeExempt") as { range: { max: string } }).range.max,
  )
  if (parts.length > max) throw new Error(`--snipe-exempt takes 0 to ${max} comma-separated 0x EVM addresses.`)
  const out: string[] = []
  for (const [index, part] of parts.entries()) {
    const address = nonZeroEvmAddress(part, `--snipe-exempt[${index}]`)
    if (out.includes(address)) throw new Error(`--snipe-exempt lists ${safeText(address)} twice.`)
    out.push(address)
  }
  return out
}

/** Parse `--team-recipient`, `--team-percent`, `--team-cliff-days`, and optional `--team-vesting-days`. */
export function parseHoodTeamAllocationFlags(flags: Flags): HoodTeamAllocationBody | undefined {
  if (!TEAM_FLAGS.some((flag) => flags[flag] !== undefined)) return undefined
  if (
    flags["--team-recipient"] === undefined ||
    flags["--team-percent"] === undefined ||
    flags["--team-cliff-days"] === undefined
  ) {
    throw new Error(
      "--team-recipient, --team-percent and --team-cliff-days go together (with optional --team-vesting-days).",
    )
  }
  const recipient = nonZeroEvmAddress(flags["--team-recipient"], "--team-recipient")
  const percent = Number(flags["--team-percent"])
  const { maxTeamBps } = LAUNCH_DEFINITION.hoodGen2
  const bps = Number.isFinite(percent) ? Math.round(percent * 100) : Number.NaN
  if (!(bps > 0 && bps <= maxTeamBps) || Math.abs(bps - percent * 100) > 1e-6) {
    throw new Error(`--team-percent must be above 0 and at most ${maxTeamBps / 100}, with at most two decimals.`)
  }
  const cliffDays = Number(flags["--team-cliff-days"])
  if (!Number.isInteger(cliffDays) || cliffDays < 30 || cliffDays > 3_650) {
    throw new Error("--team-cliff-days must be a whole number of days from 30 to 3650.")
  }
  const vestingRaw = flags["--team-vesting-days"]
  const vestingDays =
    vestingRaw === undefined || vestingRaw.trim() === "" || vestingRaw.trim().toLowerCase() === "null"
      ? 0
      : Number(vestingRaw)
  if (!Number.isInteger(vestingDays) || vestingDays < 0 || vestingDays > 3_650) {
    throw new Error("--team-vesting-days must be a whole number of days from 0 to 3650.")
  }
  return { recipient, percent, cliffDays, vestingDays }
}

/** Validate Hood `--fee-wallet` and refuse Solana's Squads multisig flags on Hood. */
export function hoodFeeWalletFromFlags(flags: Flags): string | undefined {
  if (flags["--fee-wallet-multisig"] !== undefined || flags["--fee-wallet-multisig-vault-index"] !== undefined) {
    throw new Error("--fee-wallet-multisig is Solana's Squads vault: on Hood, pass the Safe's address as --fee-wallet")
  }
  if (flags["--fee-wallet"] === undefined) return undefined
  return nonZeroEvmAddress(flags["--fee-wallet"], "--fee-wallet")
}

/** Parse and validate every top-level Hood generation 2 option (aside from `launchRules` and `creatorFeeBps`). */
export function hoodGen2TopRequestFields(flags: Flags): HoodGen2TopFields {
  const snipeStart = flags["--snipe-fee-start-bps"]
  const snipeDecay = flags["--snipe-fee-decay"]
  if (snipeStart !== undefined && Number(snipeStart) > 0 && (parseDuration(snipeDecay ?? "0") ?? 0) === 0) {
    throw new Error("--snipe-fee-start-bps needs --snipe-fee-decay above 0.")
  }
  const snipeExempt = parseSnipeExemptFlag(flags["--snipe-exempt"])
  const feeWallet = hoodFeeWalletFromFlags(flags)
  const teamAllocation = parseHoodTeamAllocationFlags(flags)
  return {
    ...(snipeExempt !== undefined ? { snipeExempt } : {}),
    ...(feeWallet ? { feeWallet } : {}),
    ...(teamAllocation ? { teamAllocation } : {}),
  }
}
