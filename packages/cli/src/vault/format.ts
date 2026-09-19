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
 *
 * Ember Phase 3 PR F (BE-226, R6, P3-AD-13): `version: 3` adds the external branch. The index
 * gains `hd.nextIndex.solanaExternal`, the external branch in `hd.exposedIndexes` and in the
 * discovery record, and `role: "external"`; CC-11 gains the row `m/44'/501'/n'/2'`. Nothing else
 * changes: the same canonical-header-as-index-AAD construction, the same envelopes, key blobs and
 * root blob, byte for byte. This reader opens BOTH versions and applies each version's own index
 * rules, so a `version: 2` file stays a `version: 2` file (its index never carries the external
 * branch on disk) until the write that allocates the first external key, and a 0.10.x or 0.11.x
 * reader meeting a `version: 3` file refuses it with `VAULT_VERSION_UNSUPPORTED` and writes nothing.
 *
 * The envelope, root and key blob AADs keep `version: 2` in both file versions (`BLOB_AAD_VERSION`).
 * Those blobs are never re-encrypted (ED-1), and a Touch ID or security-key envelope COULD not be
 * re-wrapped without the device present, so the version bump must not change the bytes they were
 * sealed under. The file's `version` is authenticated by the index AAD instead: the canonical header
 * carries it, so editing a `3` to a `2` (or the reverse) is an index tag failure, never a downgrade.
 */
import type { Blob } from "./crypto"
import { type Argon2Params, assertKdfInBounds, canonicalBytes } from "./crypto"
import { VaultError } from "./errors"
import { isHelperBundleId, isHelperTeamId } from "./helper-identity"

export const VAULT_FORMAT = "candle-vault" as const
/** The current format version: what a vault carrying the external branch is written as. */
export const VAULT_VERSION = 3 as const
/** Phase 2's version: what a vault with no external branch keeps, so an older CLI still opens it. */
export const LEGACY_VAULT_VERSION = 2 as const
export type VaultVersion = typeof LEGACY_VAULT_VERSION | typeof VAULT_VERSION
export const SUPPORTED_VAULT_VERSIONS: readonly VaultVersion[] = [LEGACY_VAULT_VERSION, VAULT_VERSION]
/**
 * The `version` inside every envelope, root and key blob AAD, in BOTH file versions. Those blobs
 * are sealed once and never re-encrypted (ED-1), so the value they were sealed under is the value
 * they are opened under; the file's own version is authenticated through the canonical header.
 */
export const BLOB_AAD_VERSION = 2 as const
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

/** The `passkey-prf` transports the format names. PR E drives `ctap2`; `platform-macos` is PR G's. */
export const KNOWN_TRANSPORTS = ["ctap2", "platform-macos"] as const
export type KnownTransport = (typeof KNOWN_TRANSPORTS)[number]

/**
 * A security key over CTAP2 `hmac-secret` (BE-140, ED-11, CC-01). Every field below `label` is
 * inside the envelope AAD, so editing `userVerification` out of the envelope, or changing the salt
 * or the credential id, is a tag failure rather than a silently different derivation. `aaguid` and
 * `product` are model information for display only: they are authenticated through the header
 * like the rest of the envelope but are never consulted to choose or admit a device.
 */
export interface Ctap2Envelope extends EnvelopeCommon {
  factor: "passkey-prf"
  transport: "ctap2"
  domain: "hardware-token"
  rpId: string
  /** base64url */
  credentialId: string
  /** base64url, 32 bytes */
  prfSalt: string
  userVerification: "required"
  backupEligible: boolean
  backupState: boolean
  saltDerivation: "webauthn-prf"
  /** hex, 16 bytes; display only. */
  aaguid: string
  /** Display only. */
  product: string
}

export const CTAP2_RP_ID = "cli.candle.tv" as const

/**
 * A synced platform passkey over the native macOS API (BE-135, AD-2, CC-01's passkey-prf row with
 * `transport: "platform-macos"`). The same factor type and the same KEK derivation as the security
 * key (ED-4); what differs is recorded: `saltDerivation: "platform"` says the platform applied its
 * own salt hashing, `backupEligible` is true by construction (a credential the platform reports as
 * not synced is refused at `factor add` rather than recorded under a domain it does not belong
 * to), and `helper` pins the signed helper the CLI verifies before trusting an assertion, exactly
 * as the Enclave envelope does. Every field below `label` is inside the envelope AAD. The domain
 * is `apple-account`: recoverable (the credential follows the account to a new Mac) and never
 * independent of any other Apple-account item (AD-2).
 */
export interface PlatformPasskeyEnvelope extends EnvelopeCommon {
  factor: "passkey-prf"
  transport: "platform-macos"
  domain: "apple-account"
  rpId: string
  /** base64url */
  credentialId: string
  /** base64url, 32 bytes */
  prfSalt: string
  userVerification: "required"
  backupEligible: true
  backupState: boolean
  saltDerivation: "platform"
  helper: { teamId: string; bundleId: string; minVersion: string }
}

/** CC-01's `kek.alg` for the `secure-enclave` row: Apple's ECIES over P-256 with SHA-256 and AES-GCM. */
export const SECURE_ENCLAVE_KEK_ALG = "ECIES-P256-SHA256-AESGCM" as const

/**
 * The Secure Enclave factor (BE-141, ED-12, CC-01). Every field below `label` is inside the
 * envelope AAD. `helper` pins the signed helper the CLI verifies before trusting an unwrap (team
 * id and bundle id go into the codesign requirement; `minVersion` is the helper the envelope was
 * made with). `publicKey` is the Enclave key's public half as SPKI; `keyTag` is the keychain tag
 * the key lives under; `kek.ciphertext` is the random intermediate KEK wrapped to that public key,
 * which only the Enclave can open, behind Touch ID (`accessControl`). The domain is `this-device`:
 * the key never leaves the Mac, and the factor is never recoverable.
 */
export interface SecureEnclaveEnvelope extends EnvelopeCommon {
  factor: "secure-enclave"
  domain: "this-device"
  helper: { teamId: string; bundleId: string; minVersion: string }
  /** base64url, DER SubjectPublicKeyInfo of an uncompressed P-256 point. */
  publicKey: string
  keyTag: string
  accessControl: "biometryCurrentSet"
  kek: { alg: typeof SECURE_ENCLAVE_KEK_ALG; ciphertext: string }
}

/**
 * Any envelope as read off disk. ED-7: a build that does not know a factor still carries the
 * envelope through canonicalization verbatim and still reads its `domain`, because CC-03's domain
 * counting and AD-2's backup rule depend on that one common field.
 */
export type Envelope = EnvelopeCommon & Record<string, unknown>

export function isPassphraseEnvelope(envelope: Envelope): envelope is PassphraseEnvelope & Record<string, unknown> {
  return envelope.factor === "passphrase"
}

export function isCtap2Envelope(envelope: Envelope): envelope is Ctap2Envelope & Record<string, unknown> {
  return envelope.factor === "passkey-prf" && envelope.transport === "ctap2"
}

export function isSecureEnclaveEnvelope(
  envelope: Envelope,
): envelope is SecureEnclaveEnvelope & Record<string, unknown> {
  return envelope.factor === "secure-enclave"
}

export function isPlatformPasskeyEnvelope(
  envelope: Envelope,
): envelope is PlatformPasskeyEnvelope & Record<string, unknown> {
  return envelope.factor === "passkey-prf" && envelope.transport === "platform-macos"
}

/** Either `passkey-prf` transport: the KEK derivation is the same for both (ED-4). */
export function isPrfEnvelope(
  envelope: Envelope,
): envelope is (Ctap2Envelope | PlatformPasskeyEnvelope) & Record<string, unknown> {
  return isCtap2Envelope(envelope) || isPlatformPasskeyEnvelope(envelope)
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
  version: VaultVersion
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

export type Branch = "solanaVault" | "solanaTee" | "solanaExternal" | "evm"
/** Every branch a `version: 3` index carries. */
export const BRANCHES: readonly Branch[] = ["solanaVault", "solanaTee", "solanaExternal", "evm"]
/** The three a `version: 2` index carries; `solanaExternal` is what version 3 adds (R6). */
export const LEGACY_BRANCHES: readonly Branch[] = ["solanaVault", "solanaTee", "evm"]
/** The branches a discovery record counts: the Solana ones a restore can be bounded on. */
export const DISCOVERY_BRANCHES = ["solanaVault", "solanaTee", "solanaExternal"] as const
export type DiscoveryBranch = (typeof DISCOVERY_BRANCHES)[number]

export function branchesForVersion(version: VaultVersion): readonly Branch[] {
  return version === LEGACY_VAULT_VERSION ? LEGACY_BRANCHES : BRANCHES
}

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
  /** In memory every discovery record carries the external branch; a `version: 2` file omits it on disk. */
  requestedCounts: Record<DiscoveryBranch, number>
  highestMatched: Record<DiscoveryBranch, number>
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
  /**
   * `"external"` (R6, P3-AD-13, `version: 3` only): a key on the external branch that signs only
   * through `candle sign`, `candle sign message` and `candle external sweep`, is never delegated
   * to Privy and is never registered with Candle. Always `derived`, never carrying `tee` or a
   * `linkedWalletId`, exactly as a `role: "vault"` entry may not.
   */
  role: "vault" | "tee-wallet" | "external"
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

/** The index a command reads after unlock: the same shape, named for the callers that only look. */
export type UnlockedVaultIndex = IndexPlaintext

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
    version: BLOB_AAD_VERSION,
    vaultId: file.vaultId,
    envelopeId: envelope.id,
    factor: envelope.factor,
  }
  if (isPassphraseEnvelope(envelope)) {
    return canonicalBytes({ ...base, kdf: envelope.kdf, strength: envelope.strength })
  }
  if (isCtap2Envelope(envelope)) {
    // CC-01's passkey-prf row, every parameter in the AAD. `aaguid` and `product` are display
    // only and are deliberately NOT here: a vendor string is not a derivation parameter.
    return canonicalBytes({
      ...base,
      transport: envelope.transport,
      rpId: envelope.rpId,
      credentialId: envelope.credentialId,
      prfSalt: envelope.prfSalt,
      userVerification: envelope.userVerification,
      backupEligible: envelope.backupEligible,
      backupState: envelope.backupState,
      saltDerivation: envelope.saltDerivation,
    })
  }
  if (isSecureEnclaveEnvelope(envelope)) {
    // CC-01's secure-enclave row, every parameter in the AAD: the pinned helper identity, the
    // public key, the tag, the access control and the wrapped KEK. Editing any of them out of the
    // envelope is a tag failure, never a silently different unwrap.
    return canonicalBytes({
      ...base,
      helper: envelope.helper,
      publicKey: envelope.publicKey,
      keyTag: envelope.keyTag,
      accessControl: envelope.accessControl,
      kek: envelope.kek,
    })
  }
  if (isPlatformPasskeyEnvelope(envelope)) {
    // CC-01's passkey-prf row for the platform transport (BE-135): the same parameters as ctap2
    // plus the pinned helper identity, so editing any of them is a tag failure.
    return canonicalBytes({
      ...base,
      transport: envelope.transport,
      rpId: envelope.rpId,
      credentialId: envelope.credentialId,
      prfSalt: envelope.prfSalt,
      userVerification: envelope.userVerification,
      backupEligible: envelope.backupEligible,
      backupState: envelope.backupState,
      saltDerivation: envelope.saltDerivation,
      helper: envelope.helper,
    })
  }
  // An unknown envelope is never unwrapped (ED-7), so it never needs an AAD.
  throw new VaultError(
    "VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM",
    `This CLI cannot unwrap a ${envelope.factor}${typeof envelope.transport === "string" ? `/${envelope.transport}` : ""} envelope.`,
  )
}

export function rootAad(vaultId: string): Uint8Array {
  return canonicalBytes({ format: VAULT_FORMAT, version: BLOB_AAD_VERSION, vaultId, purpose: "root" })
}

export function keyAad(vaultId: string, keyId: string): Uint8Array {
  return canonicalBytes({ format: VAULT_FORMAT, version: BLOB_AAD_VERSION, vaultId, purpose: "key", keyId })
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
 * that section lists them: not JSON, unknown `format`, `version` other than 2 or 3, `cipher` other
 * than AES-256-GCM, unknown top-level field, then KDF parameters outside ED-3's bounds.
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
  if (!SUPPORTED_VAULT_VERSIONS.includes(value.version as VaultVersion)) {
    throw new VaultError(
      "VAULT_VERSION_UNSUPPORTED",
      `Unsupported vault version ${JSON.stringify(value.version)}: this CLI reads versions ${SUPPORTED_VAULT_VERSIONS.join(" and ")} and writes version ${VAULT_VERSION}.`,
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
  // Required in EVERY version 2 and version 3 file, so its absence is checked at every open (CC-01).
  if (!isBlob(value.root)) {
    throw new VaultError(
      "VAULT_INDEX_INVALID",
      `The vault has no root blob; every version ${String(value.version)} vault must carry one.`,
    )
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
    // A ctap2 envelope this build CAN drive is checked for the fields the derivation needs, so a
    // malformed one is refused here rather than mid-assertion. Any other transport of the same
    // factor is kept verbatim (ED-7): this build never derives from it.
    if (envelope.factor === "passkey-prf" && envelope.transport === "ctap2") {
      assertCtap2EnvelopeShape(envelope)
    }
    if (envelope.factor === "passkey-prf" && envelope.transport === "platform-macos") {
      assertPlatformPasskeyEnvelopeShape(envelope)
    }
    if (envelope.factor === "secure-enclave") {
      assertSecureEnclaveEnvelopeShape(envelope)
    }
  }

  const ids = new Set<string>()
  for (const envelope of value.envelopes as Envelope[]) {
    if (ids.has(envelope.id)) refuse("VAULT_UNREADABLE", `Two envelopes share the id ${envelope.id}.`)
    ids.add(envelope.id)
  }

  return value as unknown as VaultFile
}

/** CC-01's passkey-prf row for the `ctap2` transport: the fields a derivation needs, typed. */
function assertCtap2EnvelopeShape(envelope: Record<string, unknown>): void {
  const id = String(envelope.id)
  const bad = (detail: string): never => refuse("VAULT_UNREADABLE", `Envelope ${id} (security key) ${detail}.`)
  if (envelope.domain !== "hardware-token")
    bad(`has domain ${JSON.stringify(envelope.domain)}, expected hardware-token`)
  if (envelope.rpId !== CTAP2_RP_ID) bad(`has rpId ${JSON.stringify(envelope.rpId)}, expected ${CTAP2_RP_ID}`)
  if (typeof envelope.credentialId !== "string" || envelope.credentialId === "") bad("has no credentialId")
  if (typeof envelope.prfSalt !== "string" || envelope.prfSalt === "") bad("has no prfSalt")
  // ED-11: the user-verified variant only. An envelope claiming anything else is not one this
  // CLI wrote, and is not one it will derive from.
  if (envelope.userVerification !== "required") bad("does not record userVerification: required")
  if (typeof envelope.backupEligible !== "boolean") bad("has no backupEligible flag")
  if (typeof envelope.backupState !== "boolean") bad("has no backupState flag")
  if (envelope.saltDerivation !== "webauthn-prf") bad("does not record saltDerivation: webauthn-prf")
  if (typeof envelope.aaguid !== "string") bad("has no aaguid")
  if (typeof envelope.product !== "string") bad("has no product")
}

/** CC-01's passkey-prf row for the `platform-macos` transport (BE-135): the fields an assertion needs. */
function assertPlatformPasskeyEnvelopeShape(envelope: Record<string, unknown>): void {
  const id = String(envelope.id)
  const bad = (detail: string): never => refuse("VAULT_UNREADABLE", `Envelope ${id} (synced passkey) ${detail}.`)
  if (envelope.domain !== "apple-account") bad(`has domain ${JSON.stringify(envelope.domain)}, expected apple-account`)
  if (envelope.rpId !== CTAP2_RP_ID) bad(`has rpId ${JSON.stringify(envelope.rpId)}, expected ${CTAP2_RP_ID}`)
  if (typeof envelope.credentialId !== "string" || envelope.credentialId === "") bad("has no credentialId")
  if (typeof envelope.prfSalt !== "string" || envelope.prfSalt === "") bad("has no prfSalt")
  if (envelope.userVerification !== "required") bad("does not record userVerification: required")
  // A synced credential has BE set by construction (AD-2); an envelope claiming otherwise is not
  // one this CLI wrote, and its domain would be wrong.
  if (envelope.backupEligible !== true) bad("does not record backupEligible: true")
  if (typeof envelope.backupState !== "boolean") bad("has no backupState flag")
  if (envelope.saltDerivation !== "platform") bad("does not record saltDerivation: platform")
  const helper = envelope.helper
  if (!isRecord(helper)) {
    bad("has no helper record")
    return
  }
  if (!isHelperTeamId(helper.teamId)) bad("has an invalid helper.teamId")
  if (!isHelperBundleId(helper.bundleId)) bad("has an invalid helper.bundleId")
  if (typeof helper.minVersion !== "string" || helper.minVersion === "") bad("has no helper.minVersion")
}

/** CC-01's secure-enclave row: the fields an unwrap needs, typed, refused here rather than mid-prompt. */
function assertSecureEnclaveEnvelopeShape(envelope: Record<string, unknown>): void {
  const id = String(envelope.id)
  const bad = (detail: string): never => refuse("VAULT_UNREADABLE", `Envelope ${id} (Secure Enclave) ${detail}.`)
  if (envelope.domain !== "this-device") bad(`has domain ${JSON.stringify(envelope.domain)}, expected this-device`)
  const helper = envelope.helper
  if (!isRecord(helper)) {
    bad("has no helper record")
    return
  }
  if (!isHelperTeamId(helper.teamId)) bad("has an invalid helper.teamId")
  if (!isHelperBundleId(helper.bundleId)) bad("has an invalid helper.bundleId")
  if (typeof helper.minVersion !== "string" || helper.minVersion === "") bad("has no helper.minVersion")
  if (typeof envelope.publicKey !== "string" || envelope.publicKey === "") bad("has no publicKey")
  if (typeof envelope.keyTag !== "string" || envelope.keyTag === "") bad("has no keyTag")
  if (envelope.accessControl !== "biometryCurrentSet") bad("does not record accessControl: biometryCurrentSet")
  const kek = envelope.kek
  if (!isRecord(kek)) {
    bad("has no kek record")
    return
  }
  if (kek.alg !== SECURE_ENCLAVE_KEK_ALG)
    bad(`has kek.alg ${JSON.stringify(kek.alg)}, expected ${SECURE_ENCLAVE_KEK_ALG}`)
  if (typeof kek.ciphertext !== "string" || kek.ciphertext === "") bad("has no kek.ciphertext")
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
 *
 * `version` is the FILE's version, read off the authenticated header, and selects that version's
 * index rules (R6): a `version: 2` index must not carry the external branch or a `role: "external"`
 * entry (a 0.10.x reader would refuse it, and this CLI never writes one), and a `version: 3` index
 * must carry `hd.nextIndex.solanaExternal` and the branch's exposure list. A version 2 index is
 * widened IN MEMORY to the version 3 shape (`solanaExternal: 0`, an empty exposure list), so every
 * command reads one shape; `serializeIndexPlaintext` narrows it again on a version 2 write.
 */
export function parseIndexPlaintext(bytes: Uint8Array, version: VaultVersion = LEGACY_VAULT_VERSION): IndexPlaintext {
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

  const hd = parseHd(value.hd, version)
  if (!Array.isArray(value.entries)) refuse("VAULT_INDEX_INVALID", "The index has no entries array.")
  const entries = (value.entries as unknown[]).map((entry) => parseEntry(entry, version))

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

/**
 * Whether an index can only be written as `version: 3`: it holds external state a version 2 file
 * has no field for. A write of such an index rewrites a version 2 file as version 3, and that is
 * the ONLY thing that does (R6): every other write keeps the version the file already had.
 */
export function indexRequiresVersion3(index: IndexPlaintext): boolean {
  if (index.entries.some((entry) => entry.role === "external")) return true
  if (index.hd.nextIndex.solanaExternal > 0) return true
  if (index.hd.exposedIndexes.solanaExternal.length > 0) return true
  const discovery = index.hd.discovery
  if (discovery === undefined) return false
  return discovery.requestedCounts.solanaExternal !== 0 || discovery.highestMatched.solanaExternal !== -1
}

/**
 * The index as it is written under `version`. A version 3 write is the in-memory shape verbatim.
 * A version 2 write drops the external branch from the counters, the exposure lists and the
 * discovery record, so the file stays one a 0.10.x reader opens; it refuses to drop anything that
 * carries information, which is what `indexRequiresVersion3` decides, because silently narrowing
 * an external key out of a file is exactly the loss a strict reader exists to prevent.
 */
export function serializeIndexPlaintext(index: IndexPlaintext, version: VaultVersion): unknown {
  if (version === VAULT_VERSION) return index
  if (indexRequiresVersion3(index)) {
    throw new VaultError(
      "VAULT_INDEX_INVALID",
      "This index carries the external branch and cannot be written as a version 2 vault.",
    )
  }
  const { solanaExternal: _nextExternal, ...nextIndex } = index.hd.nextIndex
  const { solanaExternal: _exposedExternal, ...exposedIndexes } = index.hd.exposedIndexes
  const hd: Record<string, unknown> = { ...index.hd, nextIndex, exposedIndexes }
  if (index.hd.discovery !== undefined) {
    const { solanaExternal: _requested, ...requestedCounts } = index.hd.discovery.requestedCounts
    const { solanaExternal: _matched, ...highestMatched } = index.hd.discovery.highestMatched
    hd.discovery = { ...index.hd.discovery, requestedCounts, highestMatched }
  }
  return { hd, entries: index.entries }
}

function parseHd(value: unknown, version: VaultVersion): HdRecord {
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
  const onDisk = branchesForVersion(version)
  for (const field of Object.keys(counters)) {
    if (!onDisk.includes(field as Branch)) {
      refuse("VAULT_INDEX_INVALID", `hd.nextIndex.${field} is not a branch a version ${version} vault carries.`)
    }
  }
  for (const field of Object.keys(exposed)) {
    if (!onDisk.includes(field as Branch)) {
      refuse("VAULT_INDEX_INVALID", `hd.exposedIndexes.${field} is not a branch a version ${version} vault carries.`)
    }
  }
  for (const branch of BRANCHES) {
    if (!onDisk.includes(branch)) {
      // A version 2 file has no external branch on disk (R6). In memory it reads as unallocated
      // and unexposed, the shape a fresh vault starts from, so every command sees one shape.
      nextIndex[branch] = 0
      exposedIndexes[branch] = []
      continue
    }
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
    const parsedCounts = {} as Record<"requestedCounts" | "highestMatched", Record<DiscoveryBranch, number>>
    for (const field of ["requestedCounts", "highestMatched"] as const) {
      const counts = record[field]
      if (!isRecord(counts) || !Number.isInteger(counts.solanaVault) || !Number.isInteger(counts.solanaTee)) {
        refuse("VAULT_INDEX_INVALID", `hd.discovery.${field} is missing or malformed.`)
      }
      // The external branch: required in version 3, absent in version 2 (R6). Read as "nothing
      // requested, nothing matched" from a version 2 file, which is the truth of that file.
      if (onDisk.includes("solanaExternal")) {
        if (!Number.isInteger(counts.solanaExternal)) {
          refuse("VAULT_INDEX_INVALID", `hd.discovery.${field}.solanaExternal is missing or malformed.`)
        }
      } else if (counts.solanaExternal !== undefined) {
        refuse("VAULT_INDEX_INVALID", `hd.discovery.${field}.solanaExternal is not a field a version 2 vault carries.`)
      }
      parsedCounts[field] = {
        solanaVault: counts.solanaVault as number,
        solanaTee: counts.solanaTee as number,
        solanaExternal: onDisk.includes("solanaExternal")
          ? (counts.solanaExternal as number)
          : field === "requestedCounts"
            ? 0
            : -1,
      }
    }
    discovery = {
      ...(record as unknown as HdDiscovery),
      requestedCounts: parsedCounts.requestedCounts,
      highestMatched: parsedCounts.highestMatched,
    }
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

function parseEntry(value: unknown, version: VaultVersion): KeyEntry {
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
  if (value.role !== "vault" && value.role !== "tee-wallet" && value.role !== "external") {
    refuse("VAULT_INDEX_INVALID", `Entry ${String(value.id)} has an unrecognized role.`)
  }
  // R6: the external role is what version 3 adds. A version 2 file recording one is a file this
  // CLI never wrote and an older reader would refuse; it is refused here rather than read.
  if (value.role === "external" && version === LEGACY_VAULT_VERSION) {
    refuse("VAULT_INDEX_INVALID", `Entry ${String(value.id)} is role:external, which a version 2 vault cannot carry.`)
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
  // reachable from a path ED-10 keeps it out of. R6 applies the same rule to an external key,
  // which is additionally always derived: it exists on the external branch and nowhere else.
  if (value.role === "vault" || value.role === "external") {
    const what = value.role === "vault" ? "a vault key" : "an external key"
    if (value.tee !== undefined)
      refuse("VAULT_INDEX_INVALID", `Entry ${String(value.id)} is ${what} carrying tee metadata.`)
    if (value.linkedWalletId !== undefined) {
      refuse("VAULT_INDEX_INVALID", `Entry ${String(value.id)} is ${what} carrying a linkedWalletId.`)
    }
    if (value.role === "external" && value.origin !== "derived") {
      refuse("VAULT_INDEX_INVALID", `Entry ${String(value.id)} is an external key that is not derived.`)
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
  match = /^m\/44'\/501'\/(\d+)'\/2'$/.exec(path)
  if (match?.[1] !== undefined) return { branch: "solanaExternal", index: Number(match[1]) }
  match = /^m\/44'\/60'\/(\d+)'\/0\/0$/.exec(path)
  if (match?.[1] !== undefined) return { branch: "evm", index: Number(match[1]) }
  return undefined
}
