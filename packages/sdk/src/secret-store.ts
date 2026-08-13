/**
 * secret-store: pluggable storage for an agent's P-256 signer private key (Agent Pilot Phase 3).
 *
 * Phase 3 lets a headless agent sign for its own linked wallets by holding the P-256 signer key
 * (`generateSignerKeypair`'s `privateKeyPem`, wallet-import.ts) client-side, not on Candle's
 * servers. Candle never sees this key; the SDK is where it has to live instead, so this module
 * defines where and how. A later task (one-shot trade / selfLaunch) loads the key from a
 * `SecretStore` by `walletRef` to compute the signature at call time.
 *
 * Two implementations ship here:
 *   - `InMemorySecretStore`: a plain `Map`, universal (browser or Node), for tests and ephemeral
 *     agent runs that re-import or re-generate the key each process start.
 *   - `EncryptedFileSecretStore`: AES-GCM-at-rest via WebCrypto, keyed from a passphrase through
 *     PBKDF2, Node-only (it touches the filesystem via `node:fs/promises`).
 *
 * An OS-keychain-backed store (macOS Keychain / libsecret / Windows Credential Manager) is
 * deliberately NOT included here -- it is Node/CLI-specific and belongs to a later phase (Phase
 * 4). Implement `SecretStore` for it then.
 */

import { fromBase64, toBase64 } from "./internal/encoding"

/**
 * Storage for an agent's signer private-key PEM, keyed by `walletRef` (the caller's stable
 * handle for a linked wallet: its `linkedWalletId` or its address). Implementations decide the
 * medium (memory, an encrypted file, later an OS keychain) but must agree on this shape.
 *
 * Deliberately excluded from this module: an OS-keychain implementation. That store is
 * Node/CLI-specific (macOS Keychain, libsecret, Windows Credential Manager) and is planned for
 * Phase 4, not Phase 3 -- implement this interface against it there rather than here.
 */
export interface SecretStore {
  /** Returns the stored PEM for `walletRef`, or `null` if nothing is stored under that ref. */
  get(walletRef: string): Promise<string | null>
  /** Stores `privateKeyPem` under `walletRef`, replacing any previous value for that ref. */
  set(walletRef: string, privateKeyPem: string): Promise<void>
  /** Removes any stored value for `walletRef`. A no-op if nothing was stored under it. */
  delete(walletRef: string): Promise<void>
}

/**
 * A plain in-memory `SecretStore`. Works identically in a browser or Node (no filesystem, no
 * platform APIs), which makes it the right default for tests and for ephemeral agent runs that
 * are fine re-deriving or re-importing the key on every process start. Nothing here survives
 * process exit.
 */
export class InMemorySecretStore implements SecretStore {
  private readonly entries = new Map<string, string>()

  async get(walletRef: string): Promise<string | null> {
    return this.entries.get(walletRef) ?? null
  }

  async set(walletRef: string, privateKeyPem: string): Promise<void> {
    this.entries.set(walletRef, privateKeyPem)
  }

  async delete(walletRef: string): Promise<void> {
    this.entries.delete(walletRef)
  }
}

/**
 * On-disk shape of an `EncryptedFileSecretStore` file: a JSON object mapping each `walletRef` to
 * its own AES-GCM ciphertext, independently salted and IV'd. Per-entry (rather than one salt/IV
 * for the whole file) so entries can be added, replaced, or removed without touching any other
 * entry's ciphertext.
 */
interface EncryptedFileContents {
  [walletRef: string]: {
    /** Base64-encoded PBKDF2 salt, random per entry. */
    salt: string
    /** Base64-encoded AES-GCM IV, random per entry (and per write -- see `set`). */
    iv: string
    /** Base64-encoded AES-GCM ciphertext (includes the auth tag, WebCrypto's default). */
    ciphertext: string
    /**
     * PBKDF2 iteration count used to derive this entry's key, captured from
     * {@link PBKDF2_ITERATIONS} at the time of the `set` call that wrote it. Read back on `get`
     * instead of the current constant, so raising the default later does not lock this entry out:
     * a stored salt only re-derives the right key under the SAME iteration count it was derived
     * with, and the module constant may have moved on since this entry was written.
     */
    iterations: number
  }
}

const PBKDF2_ITERATIONS = 210_000
const SALT_LENGTH_BYTES = 16
const IV_LENGTH_BYTES = 12

/** Derives an AES-GCM key from `passphrase`, `salt`, and `iterations` via PBKDF2-HMAC-SHA256. */
async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ])
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )
}

/**
 * A `SecretStore` backed by a single encrypted JSON file, keyed from a passphrase. Node-only (it
 * reads and writes the filesystem via `node:fs/promises`, imported lazily inside each method so
 * that importing `InMemorySecretStore` from this module never drags a `node:fs` dependency into
 * a browser bundle).
 *
 * Crypto construction (WebCrypto, matching wallet-import.ts's use of `crypto.subtle`):
 *   - Key derivation: PBKDF2-HMAC-SHA256, {@link PBKDF2_ITERATIONS} iterations at the time of
 *     writing, a random {@link SALT_LENGTH_BYTES}-byte salt generated fresh for every `set` call.
 *     Both the salt and the iteration count actually used are stored alongside that entry's
 *     ciphertext (not read back from the module constant), so a correct passphrase can always
 *     re-derive the key even after {@link PBKDF2_ITERATIONS} is raised for new entries later.
 *   - Encryption: AES-GCM-256, a random {@link IV_LENGTH_BYTES}-byte IV generated fresh for every
 *     `set` call (never reused across entries or across overwrites of the same entry).
 *   - At rest: one JSON object per file, one salt/iv/iterations/ciphertext record per `walletRef`.
 *     The ciphertext is AES-GCM's own output (ciphertext + auth tag), so a wrong passphrase
 *     derives the wrong key and `crypto.subtle.decrypt` throws on the auth-tag check -- it can
 *     never silently return garbage plaintext instead of the real PEM.
 *
 * Not safe for concurrent writers against the same file: `set` and `delete` both do a
 * read-modify-write of the whole file, so two concurrent calls (same process or different
 * processes) against the same `path` can race and lose one write.
 */
export class EncryptedFileSecretStore implements SecretStore {
  constructor(
    private readonly path: string,
    private readonly passphrase: string,
  ) {}

  async get(walletRef: string): Promise<string | null> {
    const contents = await this.readFile()
    const entry = contents[walletRef]
    if (!entry) return null

    const salt = fromBase64(entry.salt)
    const key = await deriveKey(this.passphrase, salt, entry.iterations)
    const iv = fromBase64(entry.iv)
    const ciphertext = fromBase64(entry.ciphertext)
    // A wrong passphrase derives the wrong AES-GCM key; WebCrypto's auth-tag check then makes
    // this reject rather than resolve to garbage bytes. Deliberately not caught here -- it
    // propagates to the caller as a thrown error, per this store's contract.
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      ciphertext as BufferSource,
    )
    return new TextDecoder().decode(plaintext)
  }

  async set(walletRef: string, privateKeyPem: string): Promise<void> {
    const contents = await this.readFile()

    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH_BYTES))
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES))
    const key = await deriveKey(this.passphrase, salt, PBKDF2_ITERATIONS)
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      new TextEncoder().encode(privateKeyPem),
    )

    contents[walletRef] = {
      salt: toBase64(salt),
      iv: toBase64(iv),
      ciphertext: toBase64(new Uint8Array(ciphertext)),
      iterations: PBKDF2_ITERATIONS,
    }
    await this.writeFile(contents)
  }

  async delete(walletRef: string): Promise<void> {
    const contents = await this.readFile()
    if (!(walletRef in contents)) return
    delete contents[walletRef]
    await this.writeFile(contents)
  }

  private async readFile(): Promise<EncryptedFileContents> {
    const { readFile } = await import("node:fs/promises")
    try {
      const raw = await readFile(this.path, "utf8")
      return JSON.parse(raw) as EncryptedFileContents
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {}
      throw err
    }
  }

  private async writeFile(contents: EncryptedFileContents): Promise<void> {
    const { mkdir, writeFile } = await import("node:fs/promises")
    const { dirname } = await import("node:path")
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, JSON.stringify(contents, null, 2), "utf8")
  }
}
