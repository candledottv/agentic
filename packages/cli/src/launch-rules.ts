/**
 * BE-2794 (BE-2791 spec 7.1): `candle launch`'s launch rules flags, mapped to the request's nested
 * `launchRules` object, and the dry run's "Launch rules" block. The checks mirror the API's own
 * `parseLaunchRules` (apps/api/src/lib/launch-rules-request.ts, spec 3.3), in its words with the
 * flag names, so a bad value is refused here before any request. The server stays the authority:
 * the switch (CURVE_LAUNCH_RULES_ENABLED), the curve generation and the size are its to decide.
 */
import { readFile, stat } from "node:fs/promises"
import { z } from "zod"
import { LAUNCH_DEFINITION } from "./launch-definition"
import { decodePubkey, encodePubkey } from "./solana-lite"
import { decimalAmount, rawAmount, safeText } from "./trading"

type Flags = Partial<Record<string, string | undefined>>

export const LAUNCH_RULES_FLAGS = [
  "--open-in",
  "--max-buy-per-wallet",
  "--cap-window",
  "--allowlist",
  "--allowlist-window",
  "--dev-buy-max",
] as const

const U64_MAX = 0xffff_ffff_ffff_ffffn
const UNITS: Record<string, number> = { s: 1, m: 60, h: 3_600, d: 86_400 }
/** 4,096 addresses with separators is under 200 KB; a file far past that is not an allowlist. */
const MAX_ALLOWLIST_FILE_BYTES = 1_000_000

const rulesField = (key: string) => {
  const found = LAUNCH_DEFINITION.fields.find((field) => field.key === `launchRules.${key}`)
  if (!found || !("range" in found)) throw new Error(`Missing launch rules field ${key}`)
  return found.range
}
const maxAllowlist = Number((rulesField("allowlist") as { max: string }).max)

export function launchRulesGiven(flags: Flags): boolean {
  return LAUNCH_RULES_FLAGS.some((flag) => flags[flag] !== undefined)
}

/** A duration in whole seconds: `600`, `600s`, `90m`, `6h` or `2d`. Undefined when it is not one. */
export function parseDuration(value: string): number | undefined {
  const match = /^(\d+)([smhd])?$/.exec(value.trim())
  if (!match) return undefined
  const seconds = Number(match[1]) * (UNITS[match[2] ?? "s"] ?? 1)
  return Number.isSafeInteger(seconds) ? seconds : undefined
}

/** `launchFieldProblem`'s range check for a duration flag, in the API's words (3.3). */
export function durationProblem(flag: string, value: string, min: number, max: number): string | undefined {
  const seconds = parseDuration(value)
  if (seconds !== undefined && seconds >= min && seconds <= max) return undefined
  return `${flag} must be a whole number of seconds from ${min} to ${max}, or a duration such as 90m or 6h.`
}

const given = (flags: Flags, flag: string) => flags[flag] !== undefined
/** A delay of 0 is no delay, as the API reads it. */
const openDelay = (flags: Flags) => parseDuration(flags["--open-in"] ?? "0") ?? 0

/**
 * The pairing and amount checks of 3.3 that need no quote asset and no file: the cap and the list
 * each need their window, `--dev-buy-max` needs `--open-in`, and an amount is positive. Ranges are
 * `launchFieldProblem`'s, from the shared definition.
 */
export function launchRulesFlagProblem(flags: Flags): string | undefined {
  if (given(flags, "--max-buy-per-wallet") !== given(flags, "--cap-window"))
    return "--max-buy-per-wallet and --cap-window go together: pass both or neither."
  if (given(flags, "--allowlist") !== given(flags, "--allowlist-window"))
    return "--allowlist and --allowlist-window go together: pass both or neither."
  if (given(flags, "--dev-buy-max") && openDelay(flags) === 0)
    return "--dev-buy-max needs --open-in above 0: it only applies before the open."
  for (const flag of ["--max-buy-per-wallet", "--dev-buy-max"]) {
    const value = flags[flag]
    if (value !== undefined && !/^\d+(\.\d+)?$/.test(value)) return amountFormat(flag)
    if (value !== undefined && /^0+(\.0+)?$/.test(value)) return amountFormat(flag)
  }
  return undefined
}

const amountFormat = (flag: string) =>
  `${flag} must be a positive amount in whole quote units, at most the quote asset's decimals, that fits in u64.`

/**
 * The addresses in an allowlist file: one per line, or comma separated, blank lines skipped and a
 * value in double quotes unquoted. Every entry must be a base58 Solana address; duplicates are
 * dropped, and the API sorts the list. Throws a usage message naming the line.
 */
export function parseAllowlist(text: string, path: string): string[] {
  const wallets = new Set<string>()
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    for (const cell of line.split(",")) {
      const entry = cell.trim().replace(/^"(.*)"$/, "$1")
      if (entry === "") continue
      let canonical: string | undefined
      try {
        canonical = encodePubkey(decodePubkey(entry))
      } catch {}
      if (canonical !== entry)
        throw new Error(
          `--allowlist ${safeText(path)}, line ${index + 1}: ${safeText(entry.slice(0, 64))} is not a base58 Solana address.`,
        )
      wallets.add(entry)
    }
  }
  if (wallets.size < 1 || wallets.size > maxAllowlist)
    throw new Error(`--allowlist holds 1 to ${maxAllowlist} distinct wallets; ${safeText(path)} has ${wallets.size}.`)
  return [...wallets]
}

/** `--allowlist <path>` read and parsed. Throws a usage message. */
export async function readAllowlist(path: string): Promise<string[]> {
  let text: string
  try {
    const info = await stat(path)
    if (!info.isFile()) throw new Error("not a file")
    if (info.size > MAX_ALLOWLIST_FILE_BYTES)
      throw new Error(`--allowlist ${safeText(path)} is over 1MB, far more than ${maxAllowlist} addresses.`)
    text = await readFile(path, "utf8")
  } catch (error) {
    if ((error as Error).message.startsWith("--allowlist")) throw error
    throw new Error(`--allowlist ${safeText(path)} could not be read as a file.`)
  }
  return parseAllowlist(text, path)
}

/** The request's `launchRules`, as the API takes it (3.1). */
export interface LaunchRulesBody {
  openDelaySecs?: number
  maxBuyPerWalletRaw?: string
  capWindowSecs?: number
  allowlist?: string[]
  allowlistWindowSecs?: number
  devBuyMaxRaw?: string
}

/**
 * The flags as the request's nested object, in raw units of the launch's quote asset, with the
 * cross-checks 3.3 makes against the launch's own dev buy. Undefined when no rule is set (every
 * flag absent, or `--open-in 0` alone), so the request is the one it was without the flags.
 * Throws a usage message.
 */
export function launchRulesRequest(
  flags: Flags,
  launch: {
    quote: string
    decimals: number
    /** The launch's own dev buy, `--buy`, raw; 0 without one. */
    buyRaw: bigint
    /** The dev-buy ceiling this launch is held to, raw. */
    ceilingRaw: bigint
    allowlist?: string[]
  },
): LaunchRulesBody | undefined {
  const problem = launchRulesFlagProblem(flags)
  if (problem) throw new Error(problem)
  const symbol = launch.quote.toUpperCase()
  const whole = (raw: bigint) => `${shortAmount(raw.toString(), launch.decimals)} ${symbol}`
  const raw = (flag: string, value: string | undefined): bigint | undefined => {
    if (value === undefined) return undefined
    let amount: bigint
    try {
      amount = BigInt(rawAmount(value, launch.decimals))
    } catch {
      throw new Error(amountFormat(flag))
    }
    if (amount > U64_MAX) throw new Error(amountFormat(flag))
    return amount
  }
  const body: LaunchRulesBody = {}
  const delay = openDelay(flags)
  if (delay > 0) body.openDelaySecs = delay
  const cap = raw("--max-buy-per-wallet", flags["--max-buy-per-wallet"])
  if (cap !== undefined) {
    body.maxBuyPerWalletRaw = cap.toString()
    body.capWindowSecs = parseDuration(flags["--cap-window"] ?? "")
  }
  if (launch.allowlist !== undefined) {
    body.allowlist = launch.allowlist
    body.allowlistWindowSecs = parseDuration(flags["--allowlist-window"] ?? "")
  }
  const devBuyMax = raw("--dev-buy-max", flags["--dev-buy-max"])
  if (devBuyMax !== undefined) {
    if (devBuyMax < launch.buyRaw)
      throw new Error(
        `--dev-buy-max (${whole(devBuyMax)}) is below this launch's own dev buy, --buy (${whole(launch.buyRaw)}).`,
      )
    if (devBuyMax > launch.ceilingRaw)
      throw new Error(`--dev-buy-max is above the dev-buy ceiling for this launch (${whole(launch.ceilingRaw)}).`)
    body.devBuyMaxRaw = devBuyMax.toString()
  }
  // With no open delay the dev buy is an ordinary buy under the cap.
  if (cap !== undefined && delay === 0 && launch.buyRaw > cap)
    throw new Error(
      `This launch's dev buy (--buy ${whole(launch.buyRaw)}) is over --max-buy-per-wallet (${whole(cap)}); with no open delay the dev buy is held to the cap.`,
    )
  return Object.keys(body).length ? body : undefined
}

/** `decimalAmount` without trailing zeros: "0.5" rather than "0.500000000". */
function shortAmount(raw: string, decimals: number): string {
  const full = decimalAmount(raw, decimals)
  return full.includes(".") ? full.replace(/0+$/, "").replace(/\.$/, "") : full
}

/** The dry run's and the build's `launchRules` summary (spec 4.1). Absent when the launch has no rules. */
const summarySchema = z
  .object({
    openAt: z.string().nullable(),
    capUntil: z.string().nullable(),
    maxBuyPerWalletRaw: z.string().regex(/^\d+$/).nullable(),
    allowlistUntil: z.string().nullable(),
    allowlistRoot: z.string().nullable(),
    allowlistSize: z.number(),
    devBuyer: z.string(),
    devBuyMaxRaw: z.string().regex(/^\d+$/),
    clusterTime: z.string(),
  })
  .passthrough()

/** "2026-11-06 12:00 UTC", with seconds only when they are not zero. */
function utc(iso: string): string {
  const time = new Date(iso)
  if (Number.isNaN(time.getTime())) return safeText(iso)
  const text = time.toISOString()
  const seconds = text.slice(17, 19)
  return `${text.slice(0, 10)} ${text.slice(11, 16)}${seconds === "00" ? "" : `:${seconds}`} UTC`
}

/** "6h", "1d 2h", "1h 30m", "45s": the open delay the times were resolved with. */
function span(seconds: number): string {
  const parts: string[] = []
  let left = Math.max(0, Math.round(seconds))
  for (const [unit, size] of [
    ["d", 86_400],
    ["h", 3_600],
    ["m", 60],
  ] as const) {
    if (left >= size) parts.push(`${Math.floor(left / size)}${unit}`)
    left %= size
  }
  if (left || !parts.length) parts.push(`${left}s`)
  return parts.join(" ")
}

const LABEL = 13
const row = (label: string, text: string) => `  ${label.padEnd(LABEL)}${text}`
const more = (text: string) => `  ${"".padEnd(LABEL)}${text}`

/**
 * The "Launch rules" block (spec 7.1), from the answer's `launchRules` object. Nothing when the
 * answer has none, which is every launch without rules and every older server. `whole` formats a
 * raw amount of the launch's quote asset.
 */
export function launchRulesLines(answer: unknown, whole: (raw: string) => string): string[] {
  const parsed = z.object({ launchRules: summarySchema }).safeParse(answer)
  if (!parsed.success) return []
  const rules = parsed.data.launchRules
  const lines = ["Launch rules"]
  if (rules.openAt) {
    const delay = (new Date(rules.openAt).getTime() - new Date(rules.clusterTime).getTime()) / 1000
    const when = `${utc(rules.openAt)}${Number.isFinite(delay) ? ` (in ${span(delay)})` : ""}`
    if (rules.devBuyMaxRaw === "0") lines.push(row("Opens", `${when}; nobody may buy before then`))
    else {
      lines.push(row("Opens", `${when}; only your wallet may buy before then, up to ${whole(rules.devBuyMaxRaw)}`))
      if (rules.capUntil) lines.push(more("(that spend counts toward the per-wallet cap after the open)"))
    }
  }
  if (rules.allowlistUntil) {
    const root = rules.allowlistRoot
      ? ` (root ${safeText(rules.allowlistRoot.slice(0, 4))}…${safeText(rules.allowlistRoot.slice(-4))})`
      : ""
    lines.push(
      row(
        "Allowlist",
        `${rules.allowlistSize.toLocaleString("en-US")} wallets until ${utc(rules.allowlistUntil)}${root}`,
      ),
    )
  }
  if (rules.capUntil && rules.maxBuyPerWalletRaw)
    lines.push(row("Cap", `${whole(rules.maxBuyPerWalletRaw)} per wallet until ${utc(rules.capUntil)}`))
  if (rules.capUntil || rules.allowlistUntil)
    lines.push(row("Buyers pay", "a one-time ~0.0015 SOL registration while a cap or allowlist is active (refundable)"))
  return lines
}
