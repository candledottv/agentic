/**
 * Ember Phase 2 (BE-136, CC-03 invariant 2, AD-2): what administrative domain a backup destination
 * belongs to, and the two rules that read it.
 *
 * Invariant 2 is "no factor shares an administrative domain with the backup it protects". In
 * Phase 2 it holds by construction, because a passphrase envelope (`human-memory`) is mandatory
 * and no cloud provider holds a human's memory. The check exists in code anyway, for the day
 * passphrase removal is ever allowed: an invariant enforced only by another rule is an invariant
 * that disappears silently when that rule changes.
 *
 * Beside it sits AD-2's confidentiality rule, which is a different claim and deliberately kept
 * separate: an `icloud-drive` destination while an `apple-account` envelope exists is refused
 * unless `--accept-shared-domain` is passed. Recoverability is fine there (the passphrase still
 * holds); what is not fine is that one Apple-account compromise then yields both the blob and a
 * factor that opens it.
 */
import { homedir } from "node:os"
import { isAbsolute, resolve, sep } from "node:path"
import { VaultError } from "./errors"
import type { Envelope } from "./format"

export type DestinationDomain = "local-disk" | "removable-media" | "icloud-drive" | "other-cloud" | "unknown"

/** Folder names the common sync clients create under the home directory. */
const OTHER_CLOUD_MARKERS = [
  "Library/CloudStorage",
  "Dropbox",
  "Google Drive",
  "OneDrive",
  "Sync",
  "pCloudDrive",
  "Nextcloud",
  "ownCloud",
  "Box",
  "MEGA",
]

const REMOVABLE_PREFIXES = ["/Volumes/", "/media/", "/mnt/", "/run/media/"]

/**
 * Classifies a destination path. Everything it cannot place is `unknown` rather than `local-disk`:
 * the two rules below both treat `unknown` as "cannot rule out a shared domain", and guessing
 * "local" for an unfamiliar mount is how a network share would pass silently.
 */
export function classifyDestination(path: string, home = homedir()): DestinationDomain {
  const absolute = isAbsolute(path) ? path : resolve(path)
  // iCloud Drive's on-disk location, which is what a `~/iCloud Drive` alias resolves into.
  if (absolute.includes(`${sep}Library${sep}Mobile Documents`)) return "icloud-drive"
  for (const marker of OTHER_CLOUD_MARKERS) {
    if (absolute.startsWith(`${home}${sep}${marker.split("/").join(sep)}`)) return "other-cloud"
  }
  for (const prefix of REMOVABLE_PREFIXES) {
    if (absolute.startsWith(prefix)) return "removable-media"
  }
  if (
    absolute.startsWith(`${home}${sep}`) ||
    absolute.startsWith(`${sep}Users${sep}`) ||
    absolute.startsWith(`${sep}home${sep}`)
  ) {
    return "local-disk"
  }
  if (
    absolute.startsWith(`${sep}tmp${sep}`) ||
    absolute.startsWith(`${sep}var${sep}`) ||
    absolute.startsWith(`${sep}private${sep}`)
  ) {
    return "local-disk"
  }
  return "unknown"
}

/** The account domain a destination belongs to, or undefined for one that belongs to no account. */
export function accountDomainOf(destination: DestinationDomain): string | undefined {
  if (destination === "icloud-drive") return "apple-account"
  if (destination === "other-cloud") return "other-cloud-account"
  return undefined
}

/** CC-03: which envelopes count as recoverable, and which domain each is counted under. */
export function recoverableDomains(envelopes: Envelope[]): string[] {
  const domains: string[] = []
  for (const envelope of envelopes) {
    if (envelope.factor === "passphrase") domains.push("human-memory")
    // A synced passkey (BE set) follows the account to a new Mac, so it is recoverable on its own.
    else if (envelope.factor === "passkey-prf" && envelope.backupEligible === true)
      domains.push(String(envelope.domain))
  }
  // Two hardware credentials on distinct keys are a recoverable PAIR; one is not (CC-03).
  const hardware = envelopes.filter((e) => e.factor === "passkey-prf" && e.backupEligible !== true)
  if (hardware.length >= 2) domains.push("hardware-token")
  return domains
}

/**
 * The recoverable-factor count `status` prints, with domains counted ONCE: AD-2 says two
 * `apple-account` envelopes are one recoverable factor for every count this document makes.
 */
export function countRecoverableFactors(envelopes: Envelope[]): number {
  return new Set(recoverableDomains(envelopes)).size
}

/** Invariant 1's gate: at least one recoverable envelope must exist before any key is created. */
export function assertRecoverableFactorExists(envelopes: Envelope[]): void {
  if (countRecoverableFactors(envelopes) > 0) return
  throw new VaultError(
    "VAULT_NO_RECOVERABLE_FACTOR",
    "This vault has no recoverable factor, so creating a key in it would create one nobody can recover.",
    { suggestion: "Add a passphrase factor first: candle vault factor add passphrase" },
  )
}

/**
 * Invariant 2 plus AD-2, in the order the spec states them. Returns the classification and whether
 * a shared-domain label should be printed, and throws when a rule refuses.
 */
export function assertBackupDomainAllowed(
  envelopes: Envelope[],
  destinationPath: string,
  opts: { acceptSharedDomain: boolean; home?: string },
): { destination: DestinationDomain; sharedDomain: boolean } {
  const destination = classifyDestination(destinationPath, opts.home)
  const destinationAccount = accountDomainOf(destination)

  // Invariant 2: at least one recoverable envelope must sit in a domain the destination does not.
  const domains = new Set(recoverableDomains(envelopes))
  if (domains.size === 0) {
    throw new VaultError(
      "VAULT_NO_RECOVERABLE_FACTOR",
      "This vault has no recoverable factor, so a backup of it could not be opened.",
      {
        suggestion: "Add a passphrase factor first: candle vault factor add passphrase",
      },
    )
  }
  if (destinationAccount !== undefined && [...domains].every((domain) => domain === destinationAccount)) {
    throw new VaultError(
      "VAULT_SHARED_DOMAIN",
      `Every recoverable factor on this vault lives in the same administrative domain as ${destinationPath} (${destinationAccount}).`,
      {
        suggestion:
          "One compromise would yield both the backup and a factor that opens it. Back up somewhere else, or add a factor in another domain.",
      },
    )
  }

  // AD-2's confidentiality rule, which is about a specific pairing rather than about recovery.
  const appleEnvelope = envelopes.some((envelope) => envelope.domain === "apple-account")
  const sharedDomain = appleEnvelope && destination === "icloud-drive"
  if (sharedDomain && !opts.acceptSharedDomain) {
    throw new VaultError(
      "VAULT_SHARED_DOMAIN",
      `${destinationPath} is in iCloud Drive and this vault has a synced passkey envelope, so one Apple account would hold both the backup and a factor that opens it.`,
      { suggestion: "Back it up outside iCloud Drive, or pass --accept-shared-domain to record that you accept this." },
    )
  }
  return { destination, sharedDomain }
}
