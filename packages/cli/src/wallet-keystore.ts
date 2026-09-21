/**
 * The v1 encrypted keystore: `tee-wallets.enc` today, and `wallets.enc` historically.
 *
 * It was written for `wallets generate`, which AD-3 removed in CLI 0.10.0 (Ember Phase 2) along with
 * `wallets export`. No command in this release reads, writes or deletes a `wallets.enc`; the TEE
 * wallet store is the live user of this format, and `vault.enc` (version 2) is the format that
 * replaces it for new keys.
 *
 * A SEPARATE file from credentials.enc on purpose. That one holds the device token and API key:
 * operational secrets you rotate freely and that are useless once revoked. This one holds
 * fund-bearing private keys, and an operator backing those up should not be forced to copy their
 * API key along with them. They can also carry different passphrases.
 *
 * The whole entry array is sealed as one blob, metadata included. An earlier draft kept addresses
 * and labels in cleartext so a keystore could be listed without a passphrase, but resume has to
 * decrypt the private keys in order to import them, so it needs the passphrase regardless.
 * Cleartext metadata therefore bought only a promptless `--list` and paid for it by recording on
 * disk exactly which addresses one operator owns, which is the linkage the feature exists to avoid.
 *
 * The crypto deliberately matches EncryptedFileSecretStore (AES-256-GCM over a PBKDF2-HMAC-SHA256
 * key): it is already reviewed, and a second scheme in the same CLI is a second thing to get wrong.
 * The iteration count is recorded in the file rather than assumed from the constant below, so
 * raising the default later never orphans a keystore written under the old one.
 *
 * Because these keys are the operator's only copy, the on-disk format is deliberately
 * self-describing: salt, iv, cipher and iteration count all travel with the ciphertext, so the
 * file can be decrypted by anyone with the passphrase and any AES-GCM implementation, with no
 * dependency on this CLI continuing to exist.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { candleConfigDir } from "./vault/store"
import type { WalletChain } from "./wallet-import"

/**
 * Default location, alongside credentials.enc but a distinct file. Mirrors secret-store's own
 * configDir (CANDLE_CONFIG_DIR, else ~/.config/candle), which is module-private there; the env is
 * passed in rather than read from process so a test can point this somewhere disposable.
 */
export function defaultKeystorePath(env: Record<string, string | undefined>): string {
  return join(candleConfigDir(env), "wallets.enc")
}

/**
 * Ember Phase 1 (BE-94, D3): the dedicated TEE wallet store, a SEPARATE file from wallets.enc with
 * its own passphrase and a `purpose` marker in the header, so the legacy readers refused it and the
 * `tee` commands refuse anything else. Those legacy readers are gone as of 0.10.0 (AD-3); the
 * marker stays, because a file written under it is still opened by the `tee` commands.
 */
export function defaultTeeKeystorePath(env: Record<string, string | undefined>): string {
  return join(candleConfigDir(env), "tee-wallets.enc")
}

/**
 * Where the TEE wallet store was written before the 2026-09-17 rename. `candle tee` falls back to it
 * only when no store exists at `defaultTeeKeystorePath`, so a source-built user's funded key is found
 * without a flag; the next write rewrites that file under the current marker (LEGACY_TEE_PURPOSE).
 */
export function legacyTeeKeystorePath(env: Record<string, string | undefined>): string {
  return join(candleConfigDir(env), "hot-wallets.enc")
}

/** The header marker of a TEE wallet store. One constant, so the value is spelled in one place. */
export const TEE_KEYSTORE_PURPOSE = "ember-tee" as const

/** What a keystore file is FOR. Absent in every file written before Phase 1, which reads as `wallets`. */
export type KeystorePurpose = "wallets" | typeof TEE_KEYSTORE_PURPOSE

/**
 * The TEE wallet store's header marker and entry field before the 2026-09-17 rename. Only CLIs
 * built from source ever wrote them (no npm release shipped the command), but such a file holds
 * the only copy of a funded key, so it must still open for a sweep. Read, never written: the next
 * rewrite of the file stores the current names.
 */
const LEGACY_TEE_PURPOSE = "ember-hot"
const LEGACY_TEE_FIELD = "hot"

/** The Ember TEE wallet store accepts PBKDF2 iteration counts in this range and fails closed outside it (D3). */
export const TEE_KEYSTORE_MIN_ITERATIONS = 210_000
export const TEE_KEYSTORE_MAX_ITERATIONS = 2_100_000

export const KEYSTORE_VERSION = 1
/** Matches EncryptedFileSecretStore's constant. Persisted per file so raising it never orphans. */
export const KEYSTORE_ITERATIONS = 210_000

export interface KeystoreEntry {
  index: number
  chain: WalletChain
  address: string
  label: string
  createdAt: string
  /** Base58 of the 64-byte secret for Solana, 0x-prefixed hex for EVM. */
  privateKey: string
  imported: boolean
  /**
   * The linked-wallet row id the import returned: the handle `wallets revoke` takes, the trade
   * API's `from.linkedWalletId`, and what the signer is keyed under. Recorded on BOTH the import
   * and reconcile paths, because it is the id every later operation needs.
   */
  linkedWalletId?: string
  /**
   * Privy's own wallet id. Only the import path has it; `GET /wallets` does not return it, so a
   * reconciled entry leaves this unset rather than filling it with a different id.
   */
  privyWalletId?: string
  importedAt?: string
  /**
   * Ember Phase 1 (BE-94): the TEE wallet grant this key backs. Lives INSIDE the sealed blob on
   * purpose: the vault destination is what a sweep sends every asset to, and a cleartext side
   * file could be edited by anything running as the user. Under the AEAD it is tamper-evident.
   */
  tee?: TeeWalletMeta
}

export interface TeeWalletMeta {
  network: "solana-mainnet"
  /** The human-approved sweep destination, pinned at enable. Never edited by an agent. */
  vaultDestination?: string
  /** The one API key the server bound this wallet to at import. */
  boundKeyPrefix?: string
  /** What the server's enable read-back established; only `verified-active` trades. */
  remoteAuthority?: "verified-active" | "verified-denied" | "unknown" | "none"
  enabledAt?: string
  stopRequestedAt?: string
  /**
   * Every finalized sweep transaction this key ever signed, retained across runs (HW-07 operation
   * evidence). A later `tee sweep` reconciles them: a recording outage, an interrupted run, or an
   * emergency sweep followed by a verified disable all finish from here without another transfer.
   */
  sweepReceipts?: SweepReceiptRecord[]
  /**
   * Sweep transactions signed and handed to the RPC whose fate is not yet known: written BEFORE
   * the broadcast, so a polling deadline, an ambiguous send, or a crash never loses the signature.
   * The next run resolves each one (finalized -> receipt; failed or blockhash expired -> dropped
   * and the balance swept again; still pending -> the run signs nothing new and stays residual).
   */
  sweepPending?: SweepPendingRecord[]
  /** Set when the server accepted the sweep record (or already derived `swept`). */
  sweptAt?: string
}

export interface SweepPendingRecord {
  kind: "token" | "sol" | "close"
  mint?: string
  account?: string
  amountRaw: string
  signature: string
  blockhash: string
  submittedAt: string
}

export interface SweepReceiptRecord {
  kind: "token" | "sol" | "close"
  mint?: string
  amountRaw: string
  signature: string
  finalizedAt: string
}

interface KeystoreFile {
  version: number
  createdAt: string
  kdf: "PBKDF2-HMAC-SHA256"
  iterations: number
  salt: string
  cipher: "AES-256-GCM"
  iv: string
  ciphertext: string
  /** Absent on legacy files (= "wallets"). Cleartext, and covered by nothing: it is a ROUTING hint
   * for which command may open the file, not a security claim; the secrets stay under the AEAD. */
  purpose?: KeystorePurpose | typeof LEGACY_TEE_PURPOSE
}

/** An opened keystore, carrying the derived key so rewrites do not re-run PBKDF2. */
export interface OpenKeystore {
  entries: KeystoreEntry[]
  key: CryptoKey
  salt: Uint8Array
  iterations: number
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64")
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"))

export async function deriveKeystoreKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ])
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )
}

/** Creates the key material for a brand-new keystore. */
export async function createKeystore(passphrase: string): Promise<Omit<OpenKeystore, "entries">> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return { key: await deriveKeystoreKey(passphrase, salt, KEYSTORE_ITERATIONS), salt, iterations: KEYSTORE_ITERATIONS }
}

export async function serializeKeystore(
  entries: KeystoreEntry[],
  key: CryptoKey,
  salt: Uint8Array,
  iterations: number,
  purpose?: KeystorePurpose,
): Promise<string> {
  // A fresh IV per write. Reusing one across rewrites under the same key would be a nonce reuse,
  // which for GCM is not a weakening but a break.
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(JSON.stringify(entries)),
  )
  const file: KeystoreFile = {
    version: KEYSTORE_VERSION,
    createdAt: new Date().toISOString(),
    kdf: "PBKDF2-HMAC-SHA256",
    iterations,
    salt: b64(salt),
    cipher: "AES-256-GCM",
    iv: b64(iv),
    ciphertext: b64(new Uint8Array(sealed)),
    ...(purpose !== undefined && purpose !== "wallets" ? { purpose } : {}),
  }
  return `${JSON.stringify(file, null, 2)}\n`
}

export async function readKeystore(
  raw: string,
  passphrase: string,
  /**
   * `expectPurpose` (Ember Phase 1): which kind of file the CALLER is allowed to open. A legacy
   * reader passes "wallets" and is refused a TEE wallet store; a `tee` command passes "ember-tee" and is
   * refused a legacy store. Omitted = no check (the pre-Phase-1 behavior, kept for the tests and
   * tooling that read either).
   */
  opts: { expectPurpose?: KeystorePurpose } = {},
): Promise<OpenKeystore> {
  let file: KeystoreFile
  try {
    file = JSON.parse(raw) as KeystoreFile
  } catch {
    throw new Error("The keystore file is not valid JSON.")
  }
  if (file.version !== KEYSTORE_VERSION) {
    throw new Error(`Unsupported keystore version ${file.version}: this CLI writes version ${KEYSTORE_VERSION}.`)
  }
  const purpose: KeystorePurpose =
    file.purpose === TEE_KEYSTORE_PURPOSE || file.purpose === LEGACY_TEE_PURPOSE ? TEE_KEYSTORE_PURPOSE : "wallets"
  if (opts.expectPurpose !== undefined && purpose !== opts.expectPurpose) {
    throw new Error(
      purpose === TEE_KEYSTORE_PURPOSE
        ? "This is a TEE wallet store (tee-wallets.enc). It has no export path; use: candle tee sweep."
        : "This is not a TEE wallet store. The tee commands only open tee-wallets.enc.",
    )
  }
  if (purpose === TEE_KEYSTORE_PURPOSE) {
    // Fail closed on anything the format does not promise (D3): a downgraded KDF, an absurd
    // iteration count, or an algorithm swap must not be "repaired" by guessing.
    if (file.kdf !== "PBKDF2-HMAC-SHA256" || file.cipher !== "AES-256-GCM") {
      throw new Error("The TEE wallet store names an unsupported KDF or cipher; refusing to open it.")
    }
    if (
      !Number.isInteger(file.iterations) ||
      file.iterations < TEE_KEYSTORE_MIN_ITERATIONS ||
      file.iterations > TEE_KEYSTORE_MAX_ITERATIONS
    ) {
      throw new Error(
        `The TEE wallet store's PBKDF2 iteration count (${file.iterations}) is outside the accepted ` +
          `${TEE_KEYSTORE_MIN_ITERATIONS}-${TEE_KEYSTORE_MAX_ITERATIONS} range; refusing to open it.`,
      )
    }
  }
  const salt = unb64(file.salt)
  const key = await deriveKeystoreKey(passphrase, salt, file.iterations)
  let plain: ArrayBuffer
  try {
    // A wrong passphrase derives a wrong key and AES-GCM's tag check throws here. That fail-closed
    // behaviour is the point: it can never return plausible-looking garbage.
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(file.iv) as BufferSource },
      key,
      unb64(file.ciphertext) as BufferSource,
    )
  } catch {
    throw new Error("Could not decrypt the keystore: wrong passphrase, or the file is corrupt.")
  }
  const decoded = JSON.parse(new TextDecoder().decode(plain)) as Array<KeystoreEntry & Record<string, unknown>>
  return {
    entries: decoded.map(({ [LEGACY_TEE_FIELD]: legacy, ...entry }) =>
      legacy !== undefined && entry.tee === undefined ? { ...entry, tee: legacy as TeeWalletMeta } : entry,
    ),
    key,
    salt,
    iterations: file.iterations,
  }
}

/**
 * Writes the keystore atomically, mirroring EncryptedFileSecretStore's approach: temp file in the
 * same directory, then rename. A crash mid-write must never truncate an existing keystore, because
 * for independently generated keys that file is the only copy of every one of them.
 *
 * The directory is hardened ONLY WHEN THIS CALL CREATED IT, and even then best effort (BE-245).
 *
 * It used to be chmodded 0700 unconditionally, and fatally, which made `vault backup --to` a real
 * iCloud Drive folder impossible. `~/Library/Mobile Documents/com~apple~CloudDocs` is already
 * `drwx------` -- already 0700 -- and macOS refuses any chmod on a file-provider root, so the write
 * died EPERM asking for a permission the directory already had. Probing the five syscalls by hand
 * showed every other step succeeding against that folder, rename included.
 *
 * A directory that already exists belongs to someone else: a file provider, a shared volume, a
 * removable disk, the operator. Changing its mode was never this function's business, and failing
 * a whole backup when the change is refused is worse still. `mkdir` reports whether it created
 * anything, which is exactly the "is this ours?" question, so the hardening now follows that; the
 * `.catch` behind it covers a filesystem that accepts the directory and refuses the mode anyway.
 *
 * The FILE mode is the control that matters and it is untouched by all of this: the temp is
 * created 0600, chmodded 0600, and renamed into place. `writeSidecar` in `vault/sidecar.ts` has
 * always treated its own directory chmod as best effort, for the same reason.
 */
export async function writeKeystoreFile(path: string, contents: string): Promise<void> {
  const dir = dirname(path)
  const created = await mkdir(dir, { recursive: true })
  if (created !== undefined) await chmod(dir, 0o700).catch(() => {})
  // A unique temp per write. A shared `${path}.tmp` meant two concurrent generators raced on one
  // file and whichever renamed second won, so a run could believe it had sealed keys that the
  // other run's bytes had replaced, and then import them. That is the half of the audit's NEW-02
  // that the ENOENT fix did not cover.
  const tmpPath = `${path}.${crypto.randomUUID()}.tmp`
  await writeFile(tmpPath, contents, { encoding: "utf8", mode: 0o600 })
  // `mode` only applies when the file is newly created, so force it in case a previous run left a
  // .tmp behind with a different mode.
  await chmod(tmpPath, 0o600)
  await rename(tmpPath, path)
}

/**
 * Ember Phase 1 (BE-94, T28 "two writers cannot lose keys"): an advisory lock around a whole
 * read-modify-write of one keystore file. `writeKeystoreFile`'s unique temp + rename makes each
 * REPLACEMENT atomic, but two commands that both opened the store, both appended, and both renamed
 * would each replace the other's entry with their own stale copy, and the second writer would
 * silently delete the first writer's key. The lock is a directory beside the store (`mkdir` is
 * atomic and fails EEXIST when it exists), held only across the re-read + merge + write, never
 * across a prompt or a network call, so a normal hold is well under a second.
 *
 * A lock left behind by a crash is never broken automatically: breaking a live lock would reopen
 * the exact race this exists to close. After `waitMs` of polling the caller gets
 * `KeystoreLockedError` naming the lock path and, when readable, who took it and when, so a human
 * can remove it once they know no other `candle tee` command is running.
 */
export class KeystoreLockedError extends Error {
  constructor(
    readonly lockPath: string,
    readonly owner: string | null,
  ) {
    super(
      `Another command holds the TEE wallet store lock at ${lockPath}` +
        `${owner ? ` (${owner})` : ""}. If no other candle tee command is running, remove that directory and retry.`,
    )
    this.name = "KeystoreLockedError"
  }
}

export function keystoreLockPath(path: string): string {
  return `${path}.lock`
}

export async function withKeystoreLock<T>(
  path: string,
  clock: { now: () => number; sleep: (ms: number) => Promise<void> },
  fn: () => Promise<T>,
  opts: { waitMs?: number; pollMs?: number; owner?: string } = {},
): Promise<T> {
  const lockPath = keystoreLockPath(path)
  const waitMs = opts.waitMs ?? 10_000
  const pollMs = opts.pollMs ?? 100
  await mkdir(dirname(path), { recursive: true })
  const started = clock.now()
  for (;;) {
    try {
      await mkdir(lockPath)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") throw error
      if (clock.now() - started >= waitMs) {
        let owner: string | null = null
        try {
          owner = (await readFile(join(lockPath, "owner"), "utf8")).trim() || null
        } catch {
          owner = null
        }
        throw new KeystoreLockedError(lockPath, owner)
      }
      await clock.sleep(pollMs)
    }
  }
  try {
    // Best effort: who holds it, for the message a blocked operator reads. Not a correctness input.
    await writeFile(
      join(lockPath, "owner"),
      `${opts.owner ?? `pid ${process.pid}`} since ${new Date().toISOString()}\n`,
      { encoding: "utf8", mode: 0o600 },
    ).catch(() => {})
    return await fn()
  } finally {
    await rm(lockPath, { recursive: true, force: true })
  }
}
