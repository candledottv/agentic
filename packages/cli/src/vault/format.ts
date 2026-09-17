/**
 * Ember Phase 2 (BE-136, CC-01, ED-1, ED-5, ED-7): the vault file's schema, its four associated-data
 * constructions, and the strict reader that refuses everything CC-01's fail-closed list names.
 *
 * The one construction worth reading twice is ED-1's. The header must be authenticated, and yet a
 * factor must be addable or removable without re-encrypting a single key. Binding the envelope set
 * into every key blob's AAD would force that re-encryption; sealing the header under a key derived
 * from the DEK was Draft 1's answer and the independent review broke it, because a file assembled
 * from the current header and an older index blob of the same vault opened cleanly. So the
 * CANONICAL HEADER IS THE INDEX BLOB'S ASSOCIATED DATA. Opening the index is what authenticates the
 * header, and because `generation` is in the header and changes on every write, an index from any
 * other write of the same vault fails the tag before a key blob is touched. Adding a factor
 * re-encrypts the index (small, no secrets) and nothing else.
 *
 * ED-7's asymmetry is deliberate and is what lets PRs E, F and G add factors without a format bump:
 * an envelope whose `factor` or `transport` this build does not know is CANONICALIZED INTO THE
 * HEADER like any other and simply never offered for unlock, while an unknown TOP-LEVEL field, an
 * unknown KEY-ENTRY field, and an unknown `format` or `version` are all refused.
 */
import type { Blob } from "./crypto"
import { type Argon2Params, assertKdfInBounds, canonicalBytes } from "./crypto"
import { VaultError } from "./errors"

export const VAULT_FORMAT = "candle-vault" as const
export const VAULT_VERSION = 2 as const
export const VAULT_CIPHER = "AES-256-GCM" as const

// ── Envelopes ─────────────────────────────────────────────────────────────────────────────────

/** Where a factor lives administratively. Invariant 2 and AD-2's backup rule both count on it. */
export type FactorDomain = "human-memory" | "hardware-token" | "this-device" | "apple-account"

/** The factor names the FORMAT knows. Which ones a build can DRIVE is `platform.ts`'s question. */
export const KNOWN_FACTORS = ["passphrase", "passkey-prf", "secure-enclave"] as const
export type KnownFactor = (typeof KNOWN_FACTORS)[number]

export interface EnvelopeCommon {
  /** base64url, 8 random bytes. */
  id: string
  factor: string
  domain: string
  label: string
  createdAt: string
  wrap: { alg: "AES-256-GCM" } & Blob
}

export interface PassphraseEnvelope extends EnvelopeCommon {
  factor: "passphrase"
  domain: "human-memory"
  kdf: Argon2Params
  strength: PassphraseStrength
}

/** AD-6: generated 8 words (about 103 bits), or 16+ characters the operator chose. */
export type PassphraseStrength = "generated-103" | "user-chosen"

/**
 * Any envelope as read off disk. ED-7: a build that does not know a factor still carries the
 * envelope through canonicalization verbatim and still reads its `domain`, because CC-03's domain
 * counting and AD-2's backup rule depend on that one common field.
 */
export type Envelope = EnvelopeCommon & Record<string, unknown>

export function isPassphraseEnvelope(envelope: Envelope): envelope is PassphraseEnvelope & Record<string, unknown> {
  return envelope.factor === "passphrase"
}

/**
 * The KDF record of a passphrase envelope, or a typed refusal. Every Argon2 call goes through here
 * rather than reaching into an `Envelope` and asserting: an envelope of some other factor reaching
 * a passphrase derivation is a routing bug, and it should say so rather than derive from undefined.
 */
export function passphraseKdf(envelope: Envelope): Argon2Params {
  if (!isPassphraseEnvelope(envelope)) {
    throw new VaultError(
      "VAULT_FACTOR_UNAVAILABLE",
      `Envelope ${envelope.id} is a ${envelope.factor} envelope, not a passphrase one.`,
    )
  }
  return envelope.kdf
}

// ── The file ──────────────────────────────────────────────────────────────────────────────────

/** Every top-level field except `index`, `root` and `keys`: exactly what the canonical header is. */
export interface VaultHeader {
  format: typeof VAULT_FORMAT
  version: typeof VAULT_VERSION
  vaultId: string
  generation: number
  createdAt: string
  updatedAt: string
  cipher: typeof VAULT_CIPHER
  envelopes: Envelope[]
  keyIds: string[]
}

export interface VaultFile extends VaultHeader {
  index: Blob
  /** ED-13: the 32 bytes of BIP-39 entropy. Written once at `init` or `restore`, never rewritten. */
  root: Blob
  keys: Array<{ id: string } & Blob>
}

/** The three top-level fields the canonical header excludes, in one place so it cannot drift. */
const NON_HEADER_FIELDS = ["index", "root", "keys"] as const
const HEADER_FIELDS = [
  "format",
  "version",
  "vaultId",
  "generation",
  "createdAt",
  "updatedAt",
  "cipher",
  "envelopes",
  "keyIds",
] as const
const TOP_LEVEL_FIELDS: readonly string[] = [...HEADER_FIELDS, ...NON_HEADER_FIELDS]

// ── Index plaintext ───────────────────────────────────────────────────────────────────────────

export type Branch = "solanaVault" | "solanaTee" | "evm"
export const BRANCHES: readonly Branch[] = ["solanaVault", "solanaTee", "evm"]

export interface HdRecord {
  scheme: "bip39-24/slip10"
  /** Each only ever increases; an index is never reused (CC-10). */
  nextIndex: Record<Branch, number>
  /** Never reset once true. */
  rootExported: boolean
  rootExportedAt?: string
  exposureReconciledAt?: string
  /** Per branch, every index positively known to have been exposed. Only ever grows (CC-11). */
  exposedIndexes: Record<Branch, number[]>
  /** Present only in a vault built by `restore --phrase`; its presence is what refuses allocation. */
  discovery?: HdDiscovery
}

export interface HdDiscovery {
  restoredAt: string
  account: string
  requestedCounts: { solanaVault: number; solanaTee: number }
  highestMatched: { solanaVault: number; solanaTee: number }
  /**
   * Written `false` and never written `true` by any command, because no procedure can establish
   * that a phrase was never used outside this vault (CC-11). The strict reader refuses `true`.
   */
  complete: false
}

export interface KeyDerivation {
  scheme: "slip10-ed25519" | "bip32-secp256k1"
  path: string
}

export interface KeyExposure {
  everRemoteExposed: boolean
  everExported: boolean
  /** Set by every restore and never written back to false by any command (CC-11). */
  exposureUnknown?: boolean
}

export const TEE_LIFECYCLES = ["local-candidate", "import-pending", "enabled", "stranded", "retired"] as const
export type TeeLifecycle = (typeof TEE_LIFECYCLES)[number]

/** SC-03's vocabulary. An OBSERVATION recorded beside the lifecycle, never copied into it. */
export const TEE_REMOTE_STATES = [
  "local-only",
  "enabling",
  "enabled",
  "disable-pending",
  "quarantined",
  "swept",
] as const
export type TeeRemoteState = (typeof TEE_REMOTE_STATES)[number]

export interface TeeGrantIdentity {
  account: string
  apiBaseUrl: string
  /** Moves one way only, `operator-asserted` to `recorded-at-operation`; the reverse is refused. */
  source: "operator-asserted" | "recorded-at-operation"
}

/** Phase 1's `TeeWalletMeta` plus the Phase 2 fields CC-01 declares here and nowhere else. */
export interface VaultTeeMeta {
  network: "solana-mainnet"
  vaultDestination?: string
  boundKeyPrefix?: string
  remoteAuthority?: "verified-active" | "verified-denied" | "unknown" | "none"
  enabledAt?: string
  stopRequestedAt?: string
  sweepReceipts?: unknown[]
  sweepPending?: unknown[]
  sweptAt?: string
  lifecycle: TeeLifecycle
  grantIdentity?: TeeGrantIdentity
  promotedInPlaceAt?: string
  fundingReceipts?: unknown[]
  destinationExposureAccepted?: boolean
  remoteState?: TeeRemoteState
}

export interface KeyEntry {
  id: string
  chain: "solana" | "evm"
  curve: "ed25519" | "secp256k1"
  address: string
  label: string
  createdAt: string
  role: "vault" | "tee-wallet"
  origin: "derived" | "migrated-tee"
  derivation?: KeyDerivation
  exposure: KeyExposure
  /**
   * An ENTRY field rather than a `tee` field because Phase 1 stores it on `KeystoreEntry` and not
   * on `TeeWalletMeta` (`wallet-keystore.ts`); the vault keeps that placement so one reader serves
   * both stores.
   */
  linkedWalletId?: string
  tee?: VaultTeeMeta
}

export interface IndexPlaintext {
  hd: HdRecord
  entries: KeyEntry[]
}

/** CC-01: exactly the fields an entry may carry. The strict reader refuses any other. */
const KEY_ENTRY_FIELDS: readonly string[] = [
  "id",
  "chain",
  "curve",
  "address",
  "label",
  "createdAt",
  "role",
  "origin",
  "derivation",
  "exposure",
  "linkedWalletId",
  "tee",
]

/**
 * CC-01's authoritative per-lifecycle table. `entry` names fields on the KeyEntry itself,
 * `tee` names fields inside the metadata; `forbidden` is what that value may not carry at all.
 */
const LIFECYCLE_TABLE: Record<TeeLifecycle, { tee: string[]; entry: string[]; forbiddenEntry: string[] }> = {
  // A Phase 1 `tee new` entry has no id, binding or destination and migration invents none.
  "local-candidate": { tee: ["network"], entry: [], forbiddenEntry: ["linkedWalletId"] },
  // `linkedWalletId` absent by definition: the link is what this value says has not happened.
  "import-pending": { tee: ["network"], entry: [], forbiddenEntry: ["linkedWalletId"] },
  enabled: { tee: ["network", "grantIdentity", "vaultDestination"], entry: ["linkedWalletId"], forbiddenEntry: [] },
  stranded: { tee: ["network", "grantIdentity"], entry: [], forbiddenEntry: ["linkedWalletId"] },
  retired: { tee: ["network", "vaultDestination"], entry: [], forbiddenEntry: [] },
}

// ── Associated data (ED-1, ED-4, and the appendix) ────────────────────────────────────────────

/**
 * The canonical header: every top-level field except `index`, `root` and `keys`, with each
 * envelope included verbatim. This is the index blob's associated data, so it is also the thing
 * that makes a stripped envelope, an added one, a changed KDF parameter, an edited `generation`
 * or a foreign index blob all fail one tag check.
 */
export function canonicalHeader(file: VaultHeader): Uint8Array {
  const header: Record<string, unknown> = {}
  for (const field of HEADER_FIELDS) header[field] = (file as unknown as Record<string, unknown>)[field]
  return canonicalBytes(header)
}

/**
 * The envelope AAD: the immutable identity plus the factor's own parameters, so a parameter change
 * is a tag failure rather than a silently weaker derivation. The appendix names this exact shape
 * for the passphrase factor, which is the one a third party has to reproduce.
 */
export function envelopeAad(file: Pick<VaultHeader, "vaultId">, envelope: Envelope): Uint8Array {
  const base = {
    format: VAULT_FORMAT,
    version: VAULT_VERSION,
    vaultId: file.vaultId,
    envelopeId: envelope.id,
    factor: envelope.factor,
  }
  if (isPassphraseEnvelope(envelope)) {
    return canonicalBytes({ ...base, kdf: envelope.kdf, strength: envelope.strength })
  }
  // No other factor is created or unwrapped by this release; PRs E to G add their parameter sets
  // here beside the passphrase one. An unknown envelope is never unwrapped, so it never needs one.
  throw new VaultError("VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM", `This CLI cannot unwrap a ${envelope.factor} envelope.`)
}

export function rootAad(vaultId: string): Uint8Array {
  return canonicalBytes({ format: VAULT_FORMAT, version: VAULT_VERSION, vaultId, purpose: "root" })
}

export function keyAad(vaultId: string, keyId: string): Uint8Array {
  return canonicalBytes({ format: VAULT_FORMAT, version: VAULT_VERSION, vaultId, purpose: "key", keyId })
}

// ── The strict reader ─────────────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isBlob = (value: unknown): value is Blob =>
  isRecord(value) && typeof value.iv === "string" && typeof value.ciphertext === "string"

function refuse(code: "VAULT_UNREADABLE" | "VAULT_FIELD_UNKNOWN" | "VAULT_INDEX_INVALID", message: string): never {
  throw new VaultError(code, message)
}

/**
 * Parses and structurally validates a vault file, applying CC-01's fail-closed rules IN THE ORDER
 * that section lists them: not JSON, unknown `format`, `version` other than 2, `cipher` other than
 * AES-256-GCM, unknown top-level field, then KDF parameters outside ED-3's bounds.
 *
 * Nothing here decrypts. Everything past this point (a wrong envelope, an index tag failure, an
 * invalid index) needs a factor, and this function runs before one has been asked for.
 */
export function parseVaultFile(raw: string): VaultFile {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    refuse("VAULT_UNREADABLE", "The vault file is not valid JSON.")
  }
  if (!isRecord(value)) refuse("VAULT_UNREADABLE", "The vault file is not a JSON object.")

  if (value.format !== VAULT_FORMAT) {
    throw new VaultError("VAULT_FORMAT_UNKNOWN", `Not a Candle vault: format is ${JSON.stringify(value.format)}.`)
  }
  if (value.version !== VAULT_VERSION) {
    throw new VaultError(
      "VAULT_VERSION_UNSUPPORTED",
      `Unsupported vault version ${JSON.stringify(value.version)}: this CLI writes version ${VAULT_VERSION}.`,
    )
  }
  if (value.cipher !== VAULT_CIPHER) {
    refuse("VAULT_UNREADABLE", `Unsupported cipher ${JSON.stringify(value.cipher)}: this format is ${VAULT_CIPHER}.`)
  }
  for (const field of Object.keys(value)) {
    if (!TOP_LEVEL_FIELDS.includes(field)) {
      throw new VaultError("VAULT_FIELD_UNKNOWN", `The vault file carries an unknown top-level field: ${field}.`, {
        suggestion: "A newer CLI may have written it. This CLI refuses rather than dropping a field it cannot honour.",
      })
    }
  }

  if (typeof value.vaultId !== "string") refuse("VAULT_UNREADABLE", "vaultId is missing or not a string.")
  if (!Number.isInteger(value.generation) || (value.generation as number) < 0) {
    refuse("VAULT_UNREADABLE", "generation is missing or is not a whole number.")
  }
  for (const field of ["createdAt", "updatedAt"] as const) {
    if (typeof value[field] !== "string") refuse("VAULT_UNREADABLE", `${field} is missing or not a string.`)
  }
  if (!Array.isArray(value.envelopes)) refuse("VAULT_UNREADABLE", "envelopes is missing or not an array.")
  if (!Array.isArray(value.keyIds) || value.keyIds.some((id) => typeof id !== "string")) {
    refuse("VAULT_UNREADABLE", "keyIds is missing or is not an array of strings.")
  }
  if (!isBlob(value.index)) refuse("VAULT_UNREADABLE", "index is missing or malformed.")
  // Required in EVERY version 2 file, so its absence is checked at every open (CC-01).
  if (!isBlob(value.root)) {
    throw new VaultError("VAULT_INDEX_INVALID", "The vault has no root blob; every version 2 vault must carry one.")
  }
  if (!Array.isArray(value.keys)) refuse("VAULT_UNREADABLE", "keys is missing or not an array.")
  for (const blob of value.keys) {
    if (!isRecord(blob) || typeof blob.id !== "string" || !isBlob(blob)) {
      refuse("VAULT_UNREADABLE", "A key blob is malformed.")
    }
  }

  for (const envelope of value.envelopes as unknown[]) {
    if (!isRecord(envelope)) refuse("VAULT_UNREADABLE", "An envelope is not a JSON object.")
    for (const field of ["id", "factor", "domain", "label", "createdAt"] as const) {
      if (typeof envelope[field] !== "string") {
        refuse("VAULT_UNREADABLE", `An envelope is missing its ${field}, which every factor carries.`)
      }
    }
    const wrap = envelope.wrap
    if (!isBlob(wrap) || (wrap as unknown as Record<string, unknown>).alg !== VAULT_CIPHER) {
      refuse("VAULT_UNREADABLE", `Envelope ${String(envelope.id)} has a malformed wrap.`)
    }
    // ED-3's bounds, enforced before any derivation runs. An UNKNOWN factor is deliberately not
    // checked here: this build cannot drive it and will never derive from it (ED-7).
    if (envelope.factor === "passphrase") {
      if (!isRecord(envelope.kdf)) refuse("VAULT_UNREADABLE", `Envelope ${String(envelope.id)} has no kdf record.`)
      if (envelope.strength !== "generated-103" && envelope.strength !== "user-chosen") {
        refuse("VAULT_UNREADABLE", `Envelope ${String(envelope.id)} has an unrecognized strength.`)
      }
      assertKdfInBounds(envelope.kdf as unknown as Argon2Params)
    }
  }

  const ids = new Set<string>()
  for (const envelope of value.envelopes as Envelope[]) {
    if (ids.has(envelope.id)) refuse("VAULT_UNREADABLE", `Two envelopes share the id ${envelope.id}.`)
    ids.add(envelope.id)
  }

  return value as unknown as VaultFile
}

/**
 * CC-01's `keyIds` / `keys[]` agreement check. Run once the index has opened, because until then
 * there is nothing that says which set is the authoritative one.
 */
export function assertKeyIdsAgree(file: VaultFile): void {
  const declared = new Set(file.keyIds)
  const present = new Set(file.keys.map((blob) => blob.id))
  const missing = [...declared].filter((id) => !present.has(id))
  const extra = [...present].filter((id) => !declared.has(id))
  if (missing.length === 0 && extra.length === 0) return
  throw new VaultError(
    "VAULT_INDEX_INVALID",
    `The vault's keyIds and key blobs disagree: ${missing.length} declared blob(s) absent, ${extra.length} undeclared blob(s) present.`,
  )
}

/**
 * The index plaintext's schema, which is where most of CC-01's refusals live. Every one of them is
 * `VAULT_INDEX_INVALID`: the index decrypted (so the header authenticated and the factor was
 * right) and what came out does not describe a vault this CLI can operate on.
 */
export function parseIndexPlaintext(bytes: Uint8Array): IndexPlaintext {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    refuse("VAULT_INDEX_INVALID", "The vault index is not valid JSON.")
  }
  if (!isRecord(value)) refuse("VAULT_INDEX_INVALID", "The vault index is not a JSON object.")
  for (const field of Object.keys(value)) {
    if (field !== "hd" && field !== "entries")
      refuse("VAULT_INDEX_INVALID", `The index carries an unknown field: ${field}.`)
  }

  const hd = parseHd(value.hd)
  if (!Array.isArray(value.entries)) refuse("VAULT_INDEX_INVALID", "The index has no entries array.")
  const entries = (value.entries as unknown[]).map(parseEntry)

  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.id)) refuse("VAULT_INDEX_INVALID", `Two index entries share the id ${entry.id}.`)
    seen.add(entry.id)
  }

  // A `nextIndex` at or below a recorded derivation index would mean the counter no longer bounds
  // what has been allocated, which is the one thing it exists to do (CC-11).
  for (const entry of entries) {
    if (entry.derivation === undefined) continue
    const located = branchOfPath(entry.derivation.path)
    if (located === undefined) continue
    if (hd.nextIndex[located.branch] <= located.index) {
      refuse(
        "VAULT_INDEX_INVALID",
        `hd.nextIndex.${located.branch} is ${hd.nextIndex[located.branch]}, at or below the index ${located.index} that entry ${entry.id} already derives.`,
      )
    }
  }

  return { hd, entries }
}

function parseHd(value: unknown): HdRecord {
  if (!isRecord(value)) refuse("VAULT_INDEX_INVALID", "The index has no hd record.")
  for (const field of Object.keys(value)) {
    const allowed = [
      "scheme",
      "nextIndex",
      "rootExported",
      "rootExportedAt",
      "exposureReconciledAt",
      "exposedIndexes",
      "discovery",
    ]
    if (!allowed.includes(field)) refuse("VAULT_INDEX_INVALID", `hd carries an unknown field: ${field}.`)
  }
  if (value.scheme !== "bip39-24/slip10") refuse("VAULT_INDEX_INVALID", `hd.scheme is ${JSON.stringify(value.scheme)}.`)
  if (typeof value.rootExported !== "boolean") refuse("VAULT_INDEX_INVALID", "hd.rootExported is not a boolean.")

  const counters = value.nextIndex
  if (!isRecord(counters)) refuse("VAULT_INDEX_INVALID", "hd.nextIndex is missing.")
  const exposed = value.exposedIndexes
  if (!isRecord(exposed)) refuse("VAULT_INDEX_INVALID", "hd.exposedIndexes is missing.")
  const nextIndex = {} as Record<Branch, number>
  const exposedIndexes = {} as Record<Branch, number[]>
  for (const branch of BRANCHES) {
    const counter = counters[branch]
    if (!Number.isInteger(counter) || (counter as number) < 0) {
      refuse("VAULT_INDEX_INVALID", `hd.nextIndex.${branch} is missing or is not a whole number.`)
    }
    nextIndex[branch] = counter as number
    const list = exposed[branch]
    if (!Array.isArray(list) || list.some((n) => !Number.isInteger(n) || (n as number) < 0)) {
      refuse("VAULT_INDEX_INVALID", `hd.exposedIndexes.${branch} is missing or is not a list of whole numbers.`)
    }
    exposedIndexes[branch] = [...(list as number[])].sort((a, b) => a - b)
  }

  let discovery: HdDiscovery | undefined
  if (value.discovery !== undefined) {
    const record = value.discovery
    if (!isRecord(record)) refuse("VAULT_INDEX_INVALID", "hd.discovery is not an object.")
    // Never written true by any command, so a file claiming it was not written by this CLI (CC-11).
    if (record.complete !== false) {
      refuse("VAULT_INDEX_INVALID", "hd.discovery.complete is not false; no command ever writes it true.")
    }
    if (typeof record.restoredAt !== "string" || typeof record.account !== "string") {
      refuse("VAULT_INDEX_INVALID", "hd.discovery is missing restoredAt or account.")
    }
    for (const field of ["requestedCounts", "highestMatched"] as const) {
      const counts = record[field]
      if (!isRecord(counts) || !Number.isInteger(counts.solanaVault) || !Number.isInteger(counts.solanaTee)) {
        refuse("VAULT_INDEX_INVALID", `hd.discovery.${field} is missing or malformed.`)
      }
    }
    discovery = record as unknown as HdDiscovery
  }

  return {
    scheme: "bip39-24/slip10",
    nextIndex,
    rootExported: value.rootExported,
    ...(typeof value.rootExportedAt === "string" ? { rootExportedAt: value.rootExportedAt } : {}),
    ...(typeof value.exposureReconciledAt === "string" ? { exposureReconciledAt: value.exposureReconciledAt } : {}),
    exposedIndexes,
    ...(discovery ? { discovery } : {}),
  }
}

function parseEntry(value: unknown): KeyEntry {
  if (!isRecord(value)) refuse("VAULT_INDEX_INVALID", "An index entry is not a JSON object.")
  for (const field of Object.keys(value)) {
    if (!KEY_ENTRY_FIELDS.includes(field)) {
      refuse("VAULT_INDEX_INVALID", `An index entry carries a field this format does not define: ${field}.`)
    }
  }
  for (const field of ["id", "address", "label", "createdAt"] as const) {
    if (typeof value[field] !== "string") refuse("VAULT_INDEX_INVALID", `An index entry is missing its ${field}.`)
  }
  if (value.chain !== "solana" && value.chain !== "evm") {
    refuse("VAULT_INDEX_INVALID", `Entry ${String(value.id)} has an unrecognized chain.`)
  }
  if (value.curve !== "ed25519" && value.curve !== "secp256k1") {
    refuse("VAULT_INDEX_INVALID", `Entry ${String(value.id)} has an unrecognized curve.`)
  }
  if (value.role !== "vault" && value.role !== "tee-wallet") {
    refuse("VAULT_INDEX_INVALID", `Entry ${String(value.id)} has an unrecognized role.`)
  }
  if (value.origin !== "derived" && value.origin !== "migrated-tee") {
    refuse("VAULT_INDEX_INVALID", `Entry ${String(value.id)} has an unrecognized origin.`)
  }

  // CC-01: required when derived, forbidden when migrated. These are the two halves of the same
  // statement, and a file that gets either wrong is describing a key it cannot re-derive or one it
  // falsely claims it can.
  if (value.origin === "derived" && value.derivation === undefined) {
    refuse("VAULT_INDEX_INVALID", `Entry ${String(value.id)} is derived but records no derivation.`)
  }
  if (value.origin === "migrated-tee" && value.derivation !== undefined) {
    refuse("VAULT_INDEX_INVALID", `Entry ${String(value.id)} is migrated-tee and must not record a derivation.`)
  }
  if (value.derivation !== undefined) {
    const derivation = value.derivation
    if (
      !isRecord(derivation) ||
      (derivation.scheme !== "slip10-ed25519" && derivation.scheme !== "bip32-secp256k1") ||
      typeof derivation.path !== "string"
    ) {
      refuse("VAULT_INDEX_INVALID", `Entry ${String(value.id)} has a malformed derivation.`)
    }
    for (const field of Object.keys(derivation)) {
      if (field !== "scheme" && field !== "path") {
        refuse("VAULT_INDEX_INVALID", `Entry ${String(value.id)}'s derivation carries an unknown field: ${field}.`)
      }
    }
  }

  const exposure = value.exposure
  if (
    !isRecord(exposure) ||
    typeof exposure.everRemoteExposed !== "boolean" ||
    typeof exposure.everExported !== "boolean"
  ) {
    refuse("VAULT_INDEX_INVALID", `Entry ${String(value.id)} has a malformed exposure record.`)
  }
  for (const field of Object.keys(exposure)) {
    if (!["everRemoteExposed", "everExported", "exposureUnknown"].includes(field)) {
      refuse("VAULT_INDEX_INVALID", `Entry ${String(value.id)}'s exposure carries an unknown field: ${field}.`)
    }
  }
  if (exposure.exposureUnknown !== undefined && typeof exposure.exposureUnknown !== "boolean") {
    refuse("VAULT_INDEX_INVALID", `Entry ${String(value.id)}'s exposureUnknown is not a boolean.`)
  }

  if (value.linkedWalletId !== undefined && typeof value.linkedWalletId !== "string") {
    refuse("VAULT_INDEX_INVALID", `Entry ${String(value.id)} has a malformed linkedWalletId.`)
  }

  // N3 / CC-01: a vault key is a vault key. Carrying TEE metadata or a link id would make it
  // reachable from a path ED-10 keeps it out of.
  if (value.role === "vault") {
    if (value.tee !== undefined)
      refuse("VAULT_INDEX_INVALID", `Entry ${String(value.id)} is a vault key carrying tee metadata.`)
    if (value.linkedWalletId !== undefined) {
      refuse("VAULT_INDEX_INVALID", `Entry ${String(value.id)} is a vault key carrying a linkedWalletId.`)
    }
  } else {
    if (value.tee === undefined)
      refuse("VAULT_INDEX_INVALID", `Entry ${String(value.id)} is a TEE wallet with no tee metadata.`)
    parseTee(value.tee, value as unknown as KeyEntry)
  }

  return value as unknown as KeyEntry
}

const TEE_FIELDS: readonly string[] = [
  "network",
  "vaultDestination",
  "boundKeyPrefix",
  "remoteAuthority",
  "enabledAt",
  "stopRequestedAt",
  "sweepReceipts",
  "sweepPending",
  "sweptAt",
  "lifecycle",
  "grantIdentity",
  "promotedInPlaceAt",
  "fundingReceipts",
  "destinationExposureAccepted",
  "remoteState",
]

function parseTee(value: unknown, entry: KeyEntry): void {
  const id = entry.id
  if (!isRecord(value)) refuse("VAULT_INDEX_INVALID", `Entry ${id} has malformed tee metadata.`)
  for (const field of Object.keys(value)) {
    if (!TEE_FIELDS.includes(field))
      refuse("VAULT_INDEX_INVALID", `Entry ${id}'s tee metadata carries an unknown field: ${field}.`)
  }
  if (value.lifecycle === undefined) refuse("VAULT_INDEX_INVALID", `Entry ${id} has no tee.lifecycle.`)
  // "a `remoteState` used as a `lifecycle`" is called out separately in CC-01 because it is the
  // confusion the two vocabularies invite, and the message should say which mistake was made.
  if (
    TEE_REMOTE_STATES.includes(value.lifecycle as TeeRemoteState) &&
    !TEE_LIFECYCLES.includes(value.lifecycle as TeeLifecycle)
  ) {
    refuse(
      "VAULT_INDEX_INVALID",
      `Entry ${id}'s tee.lifecycle is ${JSON.stringify(value.lifecycle)}, which is a remoteState observation and never a lifecycle value.`,
    )
  }
  if (!TEE_LIFECYCLES.includes(value.lifecycle as TeeLifecycle)) {
    refuse(
      "VAULT_INDEX_INVALID",
      `Entry ${id}'s tee.lifecycle is ${JSON.stringify(value.lifecycle)}, which is not one of the five values.`,
    )
  }
  if (value.remoteState !== undefined && !TEE_REMOTE_STATES.includes(value.remoteState as TeeRemoteState)) {
    refuse("VAULT_INDEX_INVALID", `Entry ${id}'s tee.remoteState is not one of SC-03's words.`)
  }
  if (value.grantIdentity !== undefined) {
    const grant = value.grantIdentity
    if (
      !isRecord(grant) ||
      typeof grant.account !== "string" ||
      typeof grant.apiBaseUrl !== "string" ||
      (grant.source !== "operator-asserted" && grant.source !== "recorded-at-operation")
    ) {
      refuse("VAULT_INDEX_INVALID", `Entry ${id}'s tee.grantIdentity is malformed.`)
    }
  }

  const rule = LIFECYCLE_TABLE[value.lifecycle as TeeLifecycle]
  for (const field of rule.tee) {
    if ((value as Record<string, unknown>)[field] === undefined) {
      refuse("VAULT_INDEX_INVALID", `Entry ${id} is ${String(value.lifecycle)} and must record tee.${field}.`)
    }
  }
  for (const field of rule.entry) {
    if ((entry as unknown as Record<string, unknown>)[field] === undefined) {
      refuse("VAULT_INDEX_INVALID", `Entry ${id} is ${String(value.lifecycle)} and must record ${field}.`)
    }
  }
  for (const field of rule.forbiddenEntry) {
    if ((entry as unknown as Record<string, unknown>)[field] !== undefined) {
      refuse("VAULT_INDEX_INVALID", `Entry ${id} is ${String(value.lifecycle)} and must not carry ${field}.`)
    }
  }
}

// ── Path helpers ──────────────────────────────────────────────────────────────────────────────

/**
 * Which branch and index a recorded path names, or undefined for a path outside CC-11's table.
 * Used by the counter check above and by the verifier's step 7; it never GRANTS anything, so an
 * unrecognized path is simply not counted rather than refused.
 */
export function branchOfPath(path: string): { branch: Branch; index: number } | undefined {
  let match = /^m\/44'\/501'\/(\d+)'\/0'$/.exec(path)
  if (match?.[1] !== undefined) return { branch: "solanaVault", index: Number(match[1]) }
  match = /^m\/44'\/501'\/(\d+)'\/1'$/.exec(path)
  if (match?.[1] !== undefined) return { branch: "solanaTee", index: Number(match[1]) }
  match = /^m\/44'\/60'\/(\d+)'\/0\/0$/.exec(path)
  if (match?.[1] !== undefined) return { branch: "evm", index: Number(match[1]) }
  return undefined
}
