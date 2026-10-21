/**
 * What an agent key GRANTS, in one place: the scope mirror, the presets, the capability chips, and
 * the inverse that turns a key's stored scopes back into `Read` / `Write` / `Withdraw` /
 * `Trade perps`.
 *
 * The web imports this through `@candle/shared`. The CLI carries a byte-identical copy
 * (`packages/cli/src/agent-key-access.ts`), because the CLI is published alone into the agentic
 * mirror, which does not carry the shared package. A drift test beside the CLI copy fails on any
 * difference, so this file must stay dependency-free: no import of any kind, and no relative path
 * that climbs out of the package it sits in (keys list Access and Name spec, 2026-09-23, D1).
 */

/**
 * Mirrors `AGENT_KEY_SCOPES` / `AgentKeyScope` in apps/api/src/lib/agent-keys.ts. Defined locally
 * rather than imported -- neither the frontend nor the CLI can reach into apps/api, the same
 * dependency-free convention the agent SDK follows for this same string union. Order matches the
 * API's own array.
 *
 * Deliberately NOT the API's whole list: `lp:write`, `perps:withdraw`, `entitlement:read` and
 * `hacc:sync` are absent, and stay absent. The two partner-only scopes cannot be named through self-service
 * issuance at all, and `lp:write` was never part of Full Access, so adding it here would widen
 * what Write grants (Read and Read:Write agent key scopes, 2026-09-22 spec, A5 and 3.8).
 * `scripts/check-agent-key-scope-mirrors.test.ts` checks this mirror carries `account:read`.
 */
export const AGENT_KEY_SCOPES = [
  "launch:write",
  "launch:read",
  // Read the whole account the owner can see, across every profile, and write nothing. The whole
  // of what the "Read" preset grants (2026-09-22 spec, R2).
  "account:read",
  "activity:write",
  "swap:write",
  // Agent transfers (2026-08-23 spec): move assets between the account's own wallets and to
  // owner-approved withdrawal addresses. Withdraw only, never Write or Read (key default without
  // transfer, 2026-10-08 spec, D1): Write trades and launches; Withdraw is the level that moves funds.
  "transfer:write",
  // Read:Write:Transfer (2026-09-24 spec, D1): move funds OUT OF the wallet this key runs, to
  // wallets the owner linked while signed in or marked trusted, or to that wallet's own vault.
  // Only the third preset grants it; never Write.
  "transfer:bound",
  // Hyperliquid perps (2026-10-01 spec, HL-ED-3): set up and trade perps from the key's EVM TEE
  // wallet under its limits. Owner-granted and in no default; only the Trade perps preset names it
  // (2026-10-17 C spec, section 7). It moves no funds off the account: no transfer, no withdrawal.
  "perps:write",
] as const
export type AgentKeyScope = (typeof AGENT_KEY_SCOPES)[number]

/**
 * Four presets. Read and Read:Write (2026-09-22 spec, R1) replaced "Launch only" / "Full
 * access": the old split asked "can this key move funds", and every read on the account rode
 * along on whichever WRITE scope gated it, so there was no way to grant reading without granting
 * doing. Read:Write:Transfer (2026-09-24 spec, D1 / R3) is Write plus `transfer:bound`: the
 * same key can also move funds out of the wallet it is bound to, to the account's own wallets.
 * Since the 2026-10-08 spec (D1) it also holds `transfer:write`, which Write no longer does, so
 * Withdraw is the one preset that moves funds. Trade perps (2026-10-17 C spec, section 7) reads the
 * account and trades Hyperliquid perps, and nothing else; it is minted from the CLI, and no web
 * picker offers it yet.
 *
 * The ids are new rather than reused (`launcher` / `full`) on purpose: `scopesForPreset("full")`
 * would otherwise keep a name no surface shows, and the retired Launch Only must not survive as
 * a code path.
 */
export type AgentKeyPreset = "read" | "readwrite" | "readwritetransfer" | "tradeperps"

/** Read: see the account, change nothing. One member, so the guarantee is legible from the list. */
const READ_SCOPES: readonly AgentKeyScope[] = ["account:read"]

/**
 * Write: trade and launch, plus `account:read`. An EXPLICIT list, never `[...AGENT_KEY_SCOPES]`:
 * spreading the mirror would let a later addition to it silently widen this preset (spec 3.8).
 * `lp:write` is not here because Full Access never granted it (spec A5). `transfer:write` is not
 * here either (key default without transfer, 2026-10-08 spec, D1): Write cannot move funds. A key
 * minted before that change still holds it, matches no preset, and reads as custom (D3).
 */
const READWRITE_SCOPES: readonly AgentKeyScope[] = [
  "launch:write",
  "launch:read",
  "activity:write",
  "swap:write",
  "account:read",
]

/**
 * Withdraw: exactly Write plus `transfer:write` and `transfer:bound`, again as an EXPLICIT list
 * (2026-09-24 spec, D1: "an explicit list, never a spread"). The only preset that moves funds
 * (2026-10-08 spec, D2). The API refuses `transfer:bound` without `transfer:write` at mint, which
 * this list satisfies.
 */
const READWRITETRANSFER_SCOPES: readonly AgentKeyScope[] = [
  "launch:write",
  "launch:read",
  "activity:write",
  "swap:write",
  "transfer:write",
  "account:read",
  "transfer:bound",
]

/**
 * Trade perps (2026-10-17 C spec, section 7): read the account, and set up and trade Hyperliquid
 * perps under the key's existing limits. Exactly these two, as an EXPLICIT list. Not Write plus
 * perps: it cannot trade tokens, launch or move funds. Deposit's `swap:write` and the withdrawal
 * scope `perps:withdraw` stay separate explicit grants, so a Trade perps key cannot fund its own
 * Hyperliquid account through Relay. Minted through `POST /keys` (`candle keys create --access
 * trade-perps`); the device-approval page still refuses `perps:write`.
 */
const TRADEPERPS_SCOPES: readonly AgentKeyScope[] = ["account:read", "perps:write"]

/**
 * Scopes granted by each portal preset, sent verbatim as `POST /keys`'s `scopes` field.
 *   read              -- `account:read` only: trades, positions, P&L, transactions, workers, the
 *                        tier snapshot, and the hacc.fun tape; no trades, no launches, no transfers.
 *   readwrite         -- trade and launch plus `account:read`; `swap:write` (trading) included,
 *                        `transfer:write` not: a Write key cannot move funds.
 *   readwritetransfer -- readwrite plus `transfer:write` and `transfer:bound`: moving funds between
 *                        the account's own wallets and to approved addresses, and out of the
 *                        wallet the key runs to the owner's session-linked or trusted wallets and
 *                        its vault.
 *   tradeperps        -- `account:read` and `perps:write` only: Hyperliquid perps setup and orders
 *                        under the key's limits; no token trades, launches, transfers or withdrawals.
 */
export function scopesForPreset(preset: AgentKeyPreset): AgentKeyScope[] {
  switch (preset) {
    case "read":
      return [...READ_SCOPES]
    case "readwrite":
      return [...READWRITE_SCOPES]
    case "readwritetransfer":
      return [...READWRITETRANSFER_SCOPES]
    case "tradeperps":
      return [...TRADEPERPS_SCOPES]
  }
}

/** The words each preset is shown as: the web's create-form picker and the CLI's Access column. */
export const AGENT_KEY_PRESET_LABELS = {
  read: "Read",
  readwrite: "Write",
  readwritetransfer: "Withdraw",
  tradeperps: "Trade perps",
} as const satisfies Record<AgentKeyPreset, string>

function sameSet(scopes: readonly string[], preset: readonly string[]): boolean {
  const held = new Set(scopes)
  return held.size === preset.length && preset.every((scope) => held.has(scope))
}

/**
 * The inverse of `scopesForPreset`: which preset a key's STORED scopes are. Set equality against
 * each preset's own list, so order and duplicates do not matter and the answer cannot drift from
 * what the create form mints. Anything else -- a strict subset, a superset (Write plus
 * `lp:write`), or a legacy Full Access key without `account:read` -- is null.
 */
export function presetForScopes(scopes: readonly string[]): AgentKeyPreset | null {
  if (sameSet(scopes, READ_SCOPES)) return "read"
  if (sameSet(scopes, READWRITE_SCOPES)) return "readwrite"
  if (sameSet(scopes, READWRITETRANSFER_SCOPES)) return "readwritetransfer"
  if (sameSet(scopes, TRADEPERPS_SCOPES)) return "tradeperps"
  return null
}

/** What a key can DO in plain terms, derived from its raw `scopes` array. */
export interface AgentKeyCapabilities {
  /** `account:read`: the whole account's trades, positions, P&L, transactions and workers. */
  read: boolean
  launch: boolean
  trade: boolean
  /** `lp:write`: open, add to, remove and claim Meteora DAMM v2 positions from a TEE wallet. */
  lp: boolean
  transfer: boolean
  /** `transfer:bound`: move funds out of the wallet this key runs, to the account's own wallets. */
  linkedTransfer: boolean
  report: boolean
}

/** The one scope behind each capability. A scope in no entry here has no capability word. */
const CAPABILITY_SCOPES = {
  read: "account:read",
  launch: "launch:write",
  trade: "swap:write",
  lp: "lp:write",
  transfer: "transfer:write",
  linkedTransfer: "transfer:bound",
  report: "activity:write",
} as const satisfies Record<keyof AgentKeyCapabilities, string>

const NAMED_CAPABILITY_SCOPES: ReadonlySet<string> = new Set(Object.values(CAPABILITY_SCOPES))

/**
 * Maps a key's raw scopes to the capabilities the portal shows in plain English: `account:read`
 * grants account-wide reading, `launch:write` grants launching, `swap:write` grants trading,
 * `lp:write` grants liquidity, `transfer:write` grants transfers, `transfer:bound` grants
 * transfers out of the bound wallet, `activity:write` grants activity reporting.
 *
 * Derived from the STORED scopes, never from a preset name: a key issued before the Read /
 * Write presets existed keeps its scopes until revoked, matches neither preset, and must be
 * described by what it can actually do (Read and Read:Write agent key scopes, 2026-09-22 spec, R6).
 */
export function agentKeyCapabilities(scopes: readonly string[]): AgentKeyCapabilities {
  return {
    read: scopes.includes(CAPABILITY_SCOPES.read),
    launch: scopes.includes(CAPABILITY_SCOPES.launch),
    trade: scopes.includes(CAPABILITY_SCOPES.trade),
    lp: scopes.includes(CAPABILITY_SCOPES.lp),
    transfer: scopes.includes(CAPABILITY_SCOPES.transfer),
    linkedTransfer: scopes.includes(CAPABILITY_SCOPES.linkedTransfer),
    report: scopes.includes(CAPABILITY_SCOPES.report),
  }
}

/**
 * The chips the web key manager row renders, in its order, each struck through when the key lacks
 * it. The CLI's Access column reads the same list for a key matching neither preset, so the two
 * surfaces cannot word or order them differently. Every capability has a chip: a key holding
 * `account:read` or `lp:write` once read as if it could not read or provide liquidity (BE-1538).
 */
export const AGENT_KEY_CAPABILITY_CHIPS = [
  ["Read", "read"],
  ["Launch", "launch"],
  ["Trade", "trade"],
  ["LP", "lp"],
  ["Transfer", "transfer"],
  ["Withdraw", "linkedTransfer"],
  ["Report", "report"],
] as const satisfies ReadonlyArray<readonly [string, keyof AgentKeyCapabilities]>

/** The chip words a list of scopes grants, in chip order, regardless of preset membership. */
export function agentKeyCapabilityWords(scopes: readonly string[]): string[] {
  const caps = agentKeyCapabilities(scopes)
  return AGENT_KEY_CAPABILITY_CHIPS.filter(([, cap]) => caps[cap]).map(([word]) => word)
}

/** What a key IS, for a one-cell summary: the preset word, else the chip words it holds. */
export type AgentKeyAccess =
  | { kind: "preset"; preset: AgentKeyPreset; label: (typeof AGENT_KEY_PRESET_LABELS)[AgentKeyPreset] }
  /**
   * `can`: held chip words, in chip order. `unnamed`: the held scopes no chip names
   * (`launch:read`, `perps:write`, ...), sorted, so a summary never drops what a key holds.
   */
  | { kind: "custom"; can: string[]; unnamed: string[] }

export function agentKeyAccess(scopes: readonly string[]): AgentKeyAccess {
  const preset = presetForScopes(scopes)
  if (preset) return { kind: "preset", preset, label: AGENT_KEY_PRESET_LABELS[preset] }
  return {
    kind: "custom",
    can: agentKeyCapabilityWords(scopes),
    unnamed: sortAgentKeyScopes(scopes.filter((scope) => !NAMED_CAPABILITY_SCOPES.has(scope))),
  }
}

/** A custom key's summary words: its chip words, then any scope no chip names. */
export function agentKeyAccessWords(access: Extract<AgentKeyAccess, { kind: "custom" }>): string[] {
  return [...access.can, ...access.unnamed]
}

/**
 * The one order raw scopes are shown to a person in, on every surface: a plain code-unit sort.
 * Not the API's array order, which is a mirror that lags its authority and has no place for a
 * scope it does not name. Returns a copy; never sorts in place.
 */
export function sortAgentKeyScopes(scopes: readonly string[]): string[] {
  return [...scopes].sort()
}
