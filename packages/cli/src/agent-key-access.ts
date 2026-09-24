/**
 * What an agent key GRANTS, in one place: the scope mirror, the three portal presets, the
 * capability chips, and the inverse that turns a key's stored scopes back into `Read` /
 * `Read:Write` / `Read:Write:Transfer`.
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
 * Deliberately NOT the API's whole list: `lp:write`, `entitlement:read` and `hacc:sync` are
 * absent, and stay absent. The two partner-only scopes cannot be named through self-service
 * issuance at all, and `lp:write` was never part of Full Access, so adding it here would widen
 * what Read:Write grants (Read and Read:Write agent key scopes, 2026-09-22 spec, A5 and 3.8).
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
  // Agent transfers (2026-08-23 spec): move assets between the account's own wallets (and to
  // owner-approved withdrawal addresses once the allowlist ships). Included in Read:Write (the
  // withdrawal allowlist is the hard gate on external sends), never in Read.
  "transfer:write",
  // Read:Write:Transfer (2026-09-24 spec, D1): move funds OUT OF the wallet this key runs, to
  // wallets the owner linked while signed in or marked trusted, or to that wallet's own vault.
  // Only the third preset grants it; never Read:Write, so no existing key changes power.
  "transfer:bound",
] as const
export type AgentKeyScope = (typeof AGENT_KEY_SCOPES)[number]

/**
 * Three presets. Read and Read:Write (2026-09-22 spec, R1) replaced "Launch only" / "Full
 * access": the old split asked "can this key move funds", and every read on the account rode
 * along on whichever WRITE scope gated it, so there was no way to grant reading without granting
 * doing. Read:Write:Transfer (2026-09-24 spec, D1 / R3) is Read:Write plus `transfer:bound`: the
 * same key can also move funds out of the wallet it is bound to, to the account's own wallets.
 *
 * The ids are new rather than reused (`launcher` / `full`) on purpose: `scopesForPreset("full")`
 * would otherwise keep a name no surface shows, and the retired Launch Only must not survive as
 * a code path.
 */
export type AgentKeyPreset = "read" | "readwrite" | "readwritetransfer"

/** Read: see the account, change nothing. One member, so the guarantee is legible from the list. */
const READ_SCOPES: readonly AgentKeyScope[] = ["account:read"]

/**
 * Read:Write: everything Full Access granted, plus `account:read`. An EXPLICIT list, never
 * `[...AGENT_KEY_SCOPES]`: spreading the mirror would let a later addition to it silently widen
 * this preset (spec 3.8). `lp:write` is not here because Full Access never granted it (spec A5).
 */
const READWRITE_SCOPES: readonly AgentKeyScope[] = [
  "launch:write",
  "launch:read",
  "activity:write",
  "swap:write",
  "transfer:write",
  "account:read",
]

/**
 * Read:Write:Transfer: exactly Read:Write plus `transfer:bound`, again as an EXPLICIT list (2026-09-24
 * spec, D1: "an explicit list, never a spread"). `transfer:write` stays in Read:Write, so the new
 * power is isolated by the new scope alone, and the API refuses `transfer:bound` without
 * `transfer:write` at mint, which this list satisfies.
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
 * Scopes granted by each portal preset, sent verbatim as `POST /keys`'s `scopes` field.
 *   read              -- `account:read` only: trades, positions, P&L, transactions, workers, the
 *                        tier snapshot, and the hacc.fun tape; no trades, no launches, no transfers.
 *   readwrite         -- the Full Access list plus `account:read`, `swap:write` (trading) included.
 *   readwritetransfer -- readwrite plus `transfer:bound`: moving funds out of the wallet the key
 *                        runs, to the owner's session-linked or trusted wallets and its vault.
 */
export function scopesForPreset(preset: AgentKeyPreset): AgentKeyScope[] {
  switch (preset) {
    case "read":
      return [...READ_SCOPES]
    case "readwrite":
      return [...READWRITE_SCOPES]
    case "readwritetransfer":
      return [...READWRITETRANSFER_SCOPES]
  }
}

/** The words each preset is shown as: the web's create-form picker and the CLI's Access column. */
export const AGENT_KEY_PRESET_LABELS = {
  read: "Read",
  readwrite: "Read:Write",
  readwritetransfer: "Read:Write:Transfer",
} as const satisfies Record<AgentKeyPreset, string>

function sameSet(scopes: readonly string[], preset: readonly string[]): boolean {
  const held = new Set(scopes)
  return held.size === preset.length && preset.every((scope) => held.has(scope))
}

/**
 * The inverse of `scopesForPreset`: which preset a key's STORED scopes are. Set equality against
 * each preset's own list, so order and duplicates do not matter and the answer cannot drift from
 * what the create form mints. Anything else -- a strict subset, a superset (Read:Write plus
 * `lp:write`), or a legacy Full Access key without `account:read` -- is null.
 */
export function presetForScopes(scopes: readonly string[]): AgentKeyPreset | null {
  if (sameSet(scopes, READ_SCOPES)) return "read"
  if (sameSet(scopes, READWRITE_SCOPES)) return "readwrite"
  if (sameSet(scopes, READWRITETRANSFER_SCOPES)) return "readwritetransfer"
  return null
}

/** What a key can DO in plain terms, derived from its raw `scopes` array. */
export interface AgentKeyCapabilities {
  /** `account:read`: the whole account's trades, positions, P&L, transactions and workers. */
  read: boolean
  launch: boolean
  trade: boolean
  transfer: boolean
  /** `transfer:bound`: move funds out of the wallet this key runs, to the account's own wallets. */
  linkedTransfer: boolean
  report: boolean
}

/**
 * Maps a key's raw scopes to the capabilities the portal shows in plain English: `account:read`
 * grants account-wide reading, `launch:write` grants launching, `swap:write` grants trading,
 * `transfer:write` grants transfers, `transfer:bound` grants transfers out of the bound wallet,
 * `activity:write` grants activity reporting.
 *
 * Derived from the STORED scopes, never from a preset name: a key issued before the Read /
 * Read:Write presets existed keeps its scopes until revoked, matches neither preset, and must be
 * described by what it can actually do (Read and Read:Write agent key scopes, 2026-09-22 spec, R6).
 */
export function agentKeyCapabilities(scopes: readonly string[]): AgentKeyCapabilities {
  return {
    read: scopes.includes("account:read"),
    launch: scopes.includes("launch:write"),
    trade: scopes.includes("swap:write"),
    transfer: scopes.includes("transfer:write"),
    linkedTransfer: scopes.includes("transfer:bound"),
    report: scopes.includes("activity:write"),
  }
}

/**
 * The chips the web key manager row renders, in its order, each struck through when the key lacks
 * it. The CLI's Access column reads the same list for a key matching neither preset, so the two
 * surfaces cannot word or order them differently. There is no `Read` chip on either surface yet.
 */
export const AGENT_KEY_CAPABILITY_CHIPS = [
  ["Launch", "launch"],
  ["Trade", "trade"],
  ["Transfer", "transfer"],
  ["Linked transfer", "linkedTransfer"],
  ["Report", "report"],
] as const satisfies ReadonlyArray<readonly [string, keyof AgentKeyCapabilities]>

/** What a key IS, for a one-cell summary: the preset word, else the chip words it holds. */
export type AgentKeyAccess =
  | { kind: "preset"; preset: AgentKeyPreset; label: (typeof AGENT_KEY_PRESET_LABELS)[AgentKeyPreset] }
  /** Held chip words, in chip order; empty when the key holds none of them. */
  | { kind: "custom"; can: string[] }

export function agentKeyAccess(scopes: readonly string[]): AgentKeyAccess {
  const preset = presetForScopes(scopes)
  if (preset) return { kind: "preset", preset, label: AGENT_KEY_PRESET_LABELS[preset] }
  const caps = agentKeyCapabilities(scopes)
  return { kind: "custom", can: AGENT_KEY_CAPABILITY_CHIPS.filter(([, cap]) => caps[cap]).map(([word]) => word) }
}

/**
 * The one order raw scopes are shown to a person in, on every surface: a plain code-unit sort.
 * Not the API's array order, which is a mirror that lags its authority and has no place for a
 * scope it does not name. Returns a copy; never sorts in place.
 */
export function sortAgentKeyScopes(scopes: readonly string[]): string[] {
  return [...scopes].sort()
}
