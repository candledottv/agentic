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
 * Beside it sits AD-9's confidentiality rule (Andrew, 2026-09-17, replacing AD-2's proposed
 * refusal), which is a different claim and deliberately kept separate: a copy written to a
 * destination classified `icloud-drive` or `other-cloud` is SEALED by default, a copy whose only
 * unlock envelope is the mandatory passphrase one; the synced-passkey, Enclave and security-key
 * envelopes are left out of the copy, never out of the live vault. Recoverability is fine either
 * way (the passphrase still holds); what sealing removes is one Apple account holding both the
 * blob and a factor that opens it. `--accept-shared-domain` survives as the way to write an
 * unsealed copy (the full envelope set) to a cloud destination, and the acceptance is recorded.
 *
 * AD-9 amendment (Andrew, 2026-09-19; BE-205): `unknown` seals exactly as a cloud destination
 * does. Only a recognised `local-disk` or `removable-media` destination gets the full envelope
 * set by default. A path the CLI cannot place may be a network share, an rclone or WebDAV mount,
 * or a sync client missing from the marker list, and an unsealed copy there is the exposure AD-9
 * closed for recognised cloud folders. A sealed copy always opens with the passphrase, so the
 * cost of sealing a destination that turned out to be an ordinary disk is small. This amendment
 * touches the confidentiality rule only: `unknown` has no account domain, so invariant 2 below is
 * unchanged, and `cloud` keeps meaning what it has always meant.
 *
 * BE-236: the classification reads the REAL path, not its spelling. `node:path.resolve` is purely
 * lexical and never follows a link, so `~/Documents/vault.enc` on a Mac with "Desktop & Documents
 * Folders in iCloud" -- where `~/Documents` is a symlink into `~/Library/Mobile Documents` --
 * classified `local-disk` and received an UNSEALED copy, carrying the synced-passkey and Enclave
 * envelopes into the same Apple account that holds those factors. That is the exposure AD-9 was
 * written to close, reached by the most common iCloud configuration there is. Any symlink, alias
 * or bind mount into a synced folder reaches the same state. The destination file does not exist
 * yet (this command refuses to overwrite one that does), so what gets resolved is the directory
 * that will hold it, with the basename rejoined afterwards. When that resolve fails there is no
 * fall back to the lexical answer: a fallback would rebuild the same hole, and a path the CLI
 * cannot place is `unknown` under the 2026-09-19 amendment, therefore sealed.
 */
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"
import { VaultError } from "./errors"
import type { Envelope } from "./format"

export type DestinationDomain = "local-disk" | "removable-media" | "icloud-drive" | "other-cloud" | "unknown"

/**
 * iCloud Drive's on-disk location, named (BE-245).
 *
 * `placeResolvedPath` below has always recognised `Library/Mobile Documents`, so the constant
 * existed in spirit; what was missing was a NAME the rest of the CLI could reach for. The literal
 * path is hostile to type -- `~/Library/Mobile Documents/com~apple~CloudDocs`, tildes inside the
 * folder name and all -- and that is most of why nobody backs up to it. `vault backup --to icloud`
 * and the post-`init` offer both build their destination from here, so there is one spelling of
 * it rather than one per caller.
 */
export const ICLOUD_DRIVE_SEGMENTS = ["Library", "Mobile Documents", "com~apple~CloudDocs"] as const

/** The shorthand `--to` accepts in place of that path. Compared case-insensitively. */
export const ICLOUD_SHORTHAND = "icloud"

/**
 * A folder of Candle's own inside iCloud Drive, rather than the provider root. Two reasons, both
 * real: a backup that lands beside a user's documents is a backup they lose track of, and the
 * provider root is a file-provider mount whose permissions the CLI may not change (BE-245's
 * chmod EPERM), so a directory Candle creates is the shape every step of the write can handle.
 */
export const ICLOUD_BACKUP_FOLDER = "Candle"

/** `~/Library/Mobile Documents/com~apple~CloudDocs` for the given home. */
export function icloudDriveDir(home: string): string {
  return join(home, ...ICLOUD_DRIVE_SEGMENTS)
}

/**
 * Where `--to icloud` writes: one timestamped file per backup, inside Candle's own folder.
 *
 * Timestamped rather than fixed, because `vault backup` refuses to overwrite an existing copy and
 * a vault is meant to be backed up AGAIN after keys are created (a copy taken at `init` records no
 * key, so `verify-backup` reports it stale once the first `new-key` lands). A fixed name would
 * turn the second, more useful backup into a refusal the operator has to work around by hand.
 */
export function icloudBackupPath(home: string, at: number): string {
  return join(icloudDriveDir(home), ICLOUD_BACKUP_FOLDER, `vault-${backupStamp(at)}.enc`)
}

/** `20260921T015648Z`: sorts, survives every filesystem, and carries no address or label (N2). */
export function backupStamp(at: number): string {
  return new Date(at)
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d+Z$/u, "Z")
}

/** The home directory this CLI works from. `HOME` is honoured so a test can stand one up. */
export function homeDirOf(env: Record<string, string | undefined>): string {
  return env.HOME?.trim() || homedir()
}

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

/** Resolves symlinks. `Deps.realpath` on the real CLI; a fake in tests, which is the whole seam. */
export type RealpathFn = (path: string) => Promise<string>

/** What `classifyDestination` needs: how to resolve a link, and where home is. */
export interface ClassifyOptions {
  realpath: RealpathFn
  home?: string
}

/**
 * Places an ALREADY-RESOLVED absolute path. Everything it cannot place is `unknown` rather than
 * `local-disk`: the two rules below both treat `unknown` as "cannot rule out a shared domain", and
 * guessing "local" for an unfamiliar mount is how a network share would pass silently.
 *
 * Deliberately not exported (BE-236). Every caller must go through `classifyDestination`, which
 * resolves first; an exported lexical classifier is the footgun that produced this bug.
 */
function placeResolvedPath(absolute: string, home: string): DestinationDomain {
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

/**
 * Classifies a destination by where its bytes will actually land (BE-236).
 *
 * The file itself does not exist yet, so the containing directory is what can be resolved and the
 * basename is rejoined onto the resolved result. Every directory component is therefore real,
 * which is what the iCloud symlink shape needs. Home is resolved the same way, so that a resolved
 * destination and the marker prefixes it is compared against are both real paths; if home cannot
 * be resolved the given spelling is used, since home is not the thing being placed.
 *
 * An unresolvable destination -- a missing parent directory, a symlink loop, a directory that
 * cannot be read -- is `unknown`, therefore sealed. It is NOT the lexical answer: falling back to
 * a path's spelling is exactly the classification this function exists to stop making.
 */
export async function classifyDestination(path: string, opts: ClassifyOptions): Promise<DestinationDomain> {
  const absolute = isAbsolute(path) ? path : resolve(path)
  const spelledHome = opts.home ?? homedir()
  let home: string
  try {
    home = await opts.realpath(spelledHome)
  } catch {
    home = spelledHome
  }
  let parent: string
  try {
    parent = await opts.realpath(dirname(absolute))
  } catch {
    return "unknown"
  }
  return placeResolvedPath(join(parent, basename(absolute)), home)
}

/**
 * AD-9 amendment (Andrew, 2026-09-19): which destinations seal by default. Deliberately not
 * `cloud`: a cloud destination belongs to an account (`accountDomainOf`), and an `unknown` one
 * belongs to nothing the CLI can name, which is precisely why it seals. One boolean standing for
 * both would make invariant 2 and the confidentiality rule read off the same fact again.
 */
export function sealsByDefault(destination: DestinationDomain): boolean {
  return destination === "icloud-drive" || destination === "other-cloud" || destination === "unknown"
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

export interface BackupDomainVerdict {
  destination: DestinationDomain
  /** Whether the destination belongs to a cloud account (`icloud-drive` or `other-cloud`). */
  cloud: boolean
  /**
   * AD-9 as amended: whether this destination seals unless the operator accepts otherwise, which
   * is every destination except a recognised local disk or removable drive.
   */
  sealsByDefault: boolean
  /** AD-2's label: a synced passkey envelope and an iCloud Drive destination are one Apple account. */
  sharedDomain: boolean
  /** AD-9: the copy carries the passphrase envelope(s) only. */
  sealed: boolean
  /** AD-9: `--accept-shared-domain` was passed for a cloud destination, so the copy is unsealed. */
  sharedDomainAccepted: boolean
}

/** AD-9: the envelopes a sealed copy keeps, which is every passphrase envelope and nothing else. */
export function sealedEnvelopes(envelopes: Envelope[]): Envelope[] {
  return envelopes.filter((envelope) => envelope.factor === "passphrase")
}

/**
 * Invariant 2 plus AD-9, in the order the spec states them. Returns the classification, whether
 * the copy is sealed, and whether a shared-domain label should be printed; throws when invariant 2
 * refuses.
 */
export async function assertBackupDomainAllowed(
  envelopes: Envelope[],
  destinationPath: string,
  opts: { acceptSharedDomain: boolean } & ClassifyOptions,
): Promise<BackupDomainVerdict> {
  // BE-236: resolved, not spelled. The message below still quotes the path the operator typed.
  const destination = await classifyDestination(destinationPath, opts)
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

  // AD-9's confidentiality rule, which is about a specific pairing rather than about recovery: a
  // cloud destination, or one Candle cannot place, gets a sealed copy unless the operator accepts
  // the shared domain. `cloud` stays the account-domain fact invariant 2 above reads.
  const cloud = destinationAccount !== undefined
  const seals = sealsByDefault(destination)
  const appleEnvelope = envelopes.some((envelope) => envelope.domain === "apple-account")
  const sharedDomain = appleEnvelope && destination === "icloud-drive"
  const sharedDomainAccepted = seals && opts.acceptSharedDomain
  return {
    destination,
    cloud,
    sealsByDefault: seals,
    sharedDomain,
    sealed: seals && !opts.acceptSharedDomain,
    sharedDomainAccepted,
  }
}
