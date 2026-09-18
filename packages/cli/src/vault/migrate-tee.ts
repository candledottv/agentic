/**
 * Ember Phase 2 (BE-137, CC-05, CC-10): map a Phase 1 TEE wallet store entry into a vault
 * `migrated-tee` key entry.
 *
 * The mapping is on evidence and never on assumption. A Phase 1 `tee new` candidate and an enable
 * that died before its single local commit are byte-identical on disk (`imported: false`, no
 * `linkedWalletId`, `tee: { network }` only); both become `local-candidate` with
 * `everRemoteExposed: false`, and migration invents neither a destination nor a grant identity.
 * Only a fully swept entry (local `sweptAt`, non-empty `sweepReceipts`, empty `sweepPending`)
 * becomes `retired`. A pending disable or a pending sweep stays `enabled` with those fields
 * carried verbatim.
 */
import { base58 } from "@scure/base"
import type { KeystoreEntry, TeeWalletMeta } from "../wallet-keystore"
import { addressFromSecret64, SOLANA_SECRET_BYTES } from "./ed25519"
import { VaultError } from "./errors"
import type { KeyEntry, TeeGrantIdentity, TeeLifecycle, VaultTeeMeta } from "./format"
import { wipe } from "./hygiene"

export interface MigratedTeeKey {
  entry: KeyEntry
  /** The 64-byte Solana secret to seal. Caller owns and zeroes it. */
  secret64: Uint8Array
}

export interface MigrationGrantContext {
  /** The migrating profile's account (cached or confirmed). Required for every non-candidate. */
  account: string
  apiBaseUrl: string
}

/**
 * Decodes the Phase 1 private-key string into the vault's 64-byte layout and checks it matches the
 * recorded address. Wrong length or a mismatched address is a refuse, not a silent remapping.
 */
export function secretFromLegacyEntry(entry: KeystoreEntry): Uint8Array {
  if (entry.chain !== "solana") {
    throw new VaultError(
      "VAULT_INDEX_INVALID",
      `Legacy entry ${entry.address} is chain ${entry.chain}; this release migrates Solana TEE wallet keys only.`,
    )
  }
  let decoded: Uint8Array
  try {
    decoded = base58.decode(entry.privateKey)
  } catch {
    throw new VaultError(
      "VAULT_VERIFY_FAILED",
      `Legacy entry ${entry.address} does not hold a decodable Solana secret.`,
    )
  }
  if (decoded.length !== SOLANA_SECRET_BYTES) {
    wipe(decoded)
    throw new VaultError(
      "VAULT_VERIFY_FAILED",
      `Legacy entry ${entry.address} holds a ${decoded.length}-byte secret; a Solana secret is ${SOLANA_SECRET_BYTES} bytes.`,
    )
  }
  try {
    if (addressFromSecret64(decoded) !== entry.address) {
      throw new VaultError(
        "VAULT_VERIFY_FAILED",
        `Legacy entry ${entry.address} does not re-derive from its stored secret.`,
      )
    }
  } catch (error) {
    wipe(decoded)
    throw error
  }
  return decoded
}

/**
 * Whether this Phase 1 entry is the never-enabled / failed-enable candidate shape: no import
 * evidence on disk, and tee metadata is network-only (or absent beside the network default).
 */
export function isLocalCandidateShape(entry: KeystoreEntry): boolean {
  if (entry.imported || entry.linkedWalletId !== undefined) return false
  const tee = entry.tee
  if (tee === undefined) return true
  const keys = Object.keys(tee).filter((key) => (tee as unknown as Record<string, unknown>)[key] !== undefined)
  return keys.length === 1 && keys[0] === "network"
}

/**
 * Whether Phase 1's own swept conditions are already met on the local entry. Migration does not
 * contact the server, so "inventory verified empty" and "server quarantined" are represented by
 * the local fields Phase 1 writes when those conditions hold: `sweptAt` plus at least one receipt
 * and no unresolved pending signature.
 */
export function isFullySweptShape(entry: KeystoreEntry): boolean {
  const tee = entry.tee
  if (tee === undefined) return false
  if (tee.sweptAt === undefined) return false
  if (!Array.isArray(tee.sweepReceipts) || tee.sweepReceipts.length === 0) return false
  if (Array.isArray(tee.sweepPending) && tee.sweepPending.length > 0) return false
  return true
}

export function lifecycleForLegacyEntry(entry: KeystoreEntry): TeeLifecycle {
  if (isFullySweptShape(entry)) return "retired"
  if (isLocalCandidateShape(entry)) return "local-candidate"
  // Active, pending-disable, and pending-sweep shapes all stay enabled; their distinguishing
  // fields travel verbatim inside tee metadata.
  if (entry.imported && entry.linkedWalletId !== undefined) return "enabled"
  // An incomplete enable that recorded some tee fields but never linked is still a candidate:
  // migration invents nothing and leaves reconciliation to resolve it.
  return "local-candidate"
}

/**
 * Builds the vault index entry and the secret bytes for one legacy TEE wallet. The secret is not
 * wiped here; the caller seals it and zeroes it.
 */
export function mapLegacyTeeEntry(
  entry: KeystoreEntry,
  keyId: string,
  grant: MigrationGrantContext | null,
  createdAtFallback: string,
): MigratedTeeKey {
  const lifecycle = lifecycleForLegacyEntry(entry)
  const secret64 = secretFromLegacyEntry(entry)
  const everRemoteExposed = lifecycle !== "local-candidate"
  const tee = buildTeeMeta(entry, lifecycle, grant)

  const mapped: KeyEntry = {
    id: keyId,
    chain: "solana",
    curve: "ed25519",
    address: entry.address,
    label: entry.label,
    createdAt: entry.createdAt || createdAtFallback,
    role: "tee-wallet",
    origin: "migrated-tee",
    exposure: { everRemoteExposed, everExported: false },
    tee,
    ...(lifecycle === "enabled" && entry.linkedWalletId !== undefined ? { linkedWalletId: entry.linkedWalletId } : {}),
  }
  return { entry: mapped, secret64 }
}

function buildTeeMeta(
  entry: KeystoreEntry,
  lifecycle: TeeLifecycle,
  grant: MigrationGrantContext | null,
): VaultTeeMeta {
  const source = entry.tee
  const network = source?.network ?? "solana-mainnet"
  if (network !== "solana-mainnet") {
    throw new VaultError(
      "VAULT_INDEX_INVALID",
      `Legacy entry ${entry.address} names network ${String(network)}; only solana-mainnet migrates.`,
    )
  }

  const meta: VaultTeeMeta = { network, lifecycle }

  // Verbatim carry of every Phase 1 field the vault schema still names.
  carryOptional(meta, source, [
    "vaultDestination",
    "boundKeyPrefix",
    "remoteAuthority",
    "enabledAt",
    "stopRequestedAt",
    "sweepReceipts",
    "sweepPending",
    "sweptAt",
  ])

  if (lifecycle === "local-candidate") {
    // Invent nothing: no grantIdentity, no destination, no link id.
    return { network, lifecycle }
  }

  if (lifecycle === "enabled") {
    if (meta.vaultDestination === undefined) {
      throw new VaultError(
        "VAULT_INDEX_INVALID",
        `Legacy entry ${entry.address} is imported but records no vaultDestination; the vault cannot represent it as enabled.`,
      )
    }
  }

  if (lifecycle === "enabled" || lifecycle === "stranded") {
    if (grant === null || grant.account.trim() === "") {
      throw new VaultError(
        "VAULT_UNREADABLE",
        `Migrating ${entry.address} as ${lifecycle} needs the migrating profile's account so grantIdentity can be recorded.`,
        { suggestion: "Run candle auth login (or candle profile use) so this profile caches its account, then retry." },
      )
    }
    const grantIdentity: TeeGrantIdentity = {
      account: grant.account,
      apiBaseUrl: grant.apiBaseUrl,
      // Recorded at the migration operation from the migrating profile; not invented later.
      source: "recorded-at-operation",
    }
    meta.grantIdentity = grantIdentity
  }

  if (lifecycle === "retired") {
    if (meta.vaultDestination === undefined) {
      throw new VaultError(
        "VAULT_INDEX_INVALID",
        `Legacy entry ${entry.address} looks fully swept but records no vaultDestination; the vault cannot represent it as retired.`,
      )
    }
  }

  return meta
}

function carryOptional(
  target: VaultTeeMeta,
  source: TeeWalletMeta | undefined,
  fields: ReadonlyArray<keyof TeeWalletMeta & keyof VaultTeeMeta>,
): void {
  if (source === undefined) return
  for (const field of fields) {
    const value = source[field]
    if (value !== undefined) (target as unknown as Record<string, unknown>)[field] = value
  }
}
