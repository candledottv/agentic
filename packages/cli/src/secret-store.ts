/**
 * secret-store: the CLI's `SecretStore` interface and its always-available fallback
 * implementation, `EncryptedFileSecretStore`.
 *
 * `keychain.ts` layers the OS-keychain-backed stores (`KeychainSecretStore`, `SecretToolSecretStore`)
 * and `resolveSecretStore()` on top of this file, falling back to `EncryptedFileSecretStore` when no
 * OS keychain is usable. This module has no dependency on `keychain.ts` (the reverse is true), so it
 * also works standalone.
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/** Storage for a single CLI credential, keyed by a stable `ref` (see `SECRET_REFS`). */
export interface SecretStore {
  /** Returns the stored value for `ref`, or `null` if nothing is stored under that ref. */
  get(ref: string): Promise<string | null>
  /** Stores `value` under `ref`, replacing any previous value for that ref. */
  set(ref: string, value: string): Promise<void>
  /** Removes any stored value for `ref`. A no-op if nothing was stored under it. */
  delete(ref: string): Promise<void>
}

/**
 * The two credentials the CLI ever stores, and the stable `ref` string each is keyed under across
 * every `SecretStore` implementation (OS keychain account name, or the encrypted file's JSON key).
 * Command code should always go through these constants rather than the literal strings, so a typo
 * can't silently split one credential across two refs.
 */
export const SECRET_REFS = {
  deviceToken: "device_token",
  apiKey: "api_key",
} as const

/**
 * The ref an imported linked wallet's signer private key (PEM) is stored under, keyed by the
 * wallet's Candle linked-wallet id. Per-wallet (unlike SECRET_REFS' two fixed credentials)
 * because an account can import any number of wallets, each with its own 1-of-1 signer.
 */
export function walletSignerRef(walletId: string): string {
  return `wallet_signer_${walletId}`
}

/**
 * The signer PEM's STORED form: its base64 body, armor and newlines stripped. A PEM block
 * contains newlines, which `KeychainSecretStore.set`'s command-injection guard rightly refuses
 * (a newline starts a whole new `security -i` command), so a multiline value can never go into
 * the macOS Keychain as-is. Storing the single-line base64 body keeps every backend on one
 * format, and the SDK's keychain store re-armors on read. Round-trip contract:
 * `storedSignerToPem(pemToStoredSigner(pem)) === pem` for any standard 64-column PKCS8 PEM.
 */
export function pemToStoredSigner(pem: string): string {
  return pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "")
}

/** Re-armors a stored single-line signer value back into the standard 64-column PEM block. */
export function storedSignerToPem(stored: string): string {
  const lines = stored.match(/.{1,64}/g) ?? [stored]
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`
}

/**
 * Resolves the directory the CLI keeps its state in: `$CANDLE_CONFIG_DIR` if set (test /
 * advanced-use seam -- tests point this at a temp dir so nothing here ever touches a real
 * `~/.config`), else `~/.config/candle`. Mirrored in `config.ts` for the same reason: keeping each
 * file's path resolution self-contained avoids a needless inter-module dependency for two lines of
 * logic.
 */
function configDir(): string {
  return process.env.CANDLE_CONFIG_DIR?.trim() || join(homedir(), ".config", "candle")
}

function defaultCredentialsPath(): string {
  return join(configDir(), "credentials.enc")
}

// AES-256-GCM with a PBKDF2-derived key. This deliberately re-implements roughly 80 lines of the
// SDK's EncryptedFileSecretStore pattern instead of importing it: the CLI has zero runtime
// dependencies by design (spec decision 4; the bunx distribution depends on a self-contained
// bundle), and this is an internal storage detail for two credentials, not a shared policy
// surface. Do not deduplicate.
const PBKDF2_ITERATIONS = 210_000 // matches the SDK's constant; persisted per entry so raising it never orphans old entries
const SALT_LENGTH_BYTES = 16
const IV_LENGTH_BYTES = 12

interface FileEntry {
  salt: string // base64, random per entry
  iv: string // base64, 12 bytes
  ciphertext: string // base64, GCM tag appended
  iterations: number
}

type FileContents = Record<string, FileEntry>

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

export interface EncryptedFileSecretStoreOptions {
  /** Overrides the on-disk credentials path. Defaults to `$CANDLE_CONFIG_DIR`-aware `credentials.enc`. */
  path?: string
  /**
   * Overrides the PBKDF2 iteration count used for NEW writes (`set`) from this instance.
   * Internal/test-only seam: production code should never need this, since the default already
   * matches the SDK's constant. `get` always uses the entry's own persisted `iterations` value,
   * never this override, so raising it here only affects writes going forward.
   */
  iterations?: number
}

/**
 * The CLI's always-available `SecretStore`: a single encrypted JSON file
 * (`~/.config/candle/credentials.enc`, or `$CANDLE_CONFIG_DIR/credentials.enc`), keyed from a
 * passphrase. This is what `resolveSecretStore()` falls back to when no OS keychain is usable.
 *
 * Crypto construction (WebCrypto):
 *   - Key derivation: PBKDF2-HMAC-SHA256, {@link PBKDF2_ITERATIONS} iterations by default, a random
 *     {@link SALT_LENGTH_BYTES}-byte salt generated fresh for every `set` call. Both the salt and
 *     the iteration count actually used are stored alongside that entry's ciphertext (not read back
 *     from the module constant), so a correct passphrase can always re-derive the key even after
 *     the default iteration count is raised for new entries later.
 *   - Encryption: AES-GCM-256, a random {@link IV_LENGTH_BYTES}-byte IV generated fresh for every
 *     `set` call.
 *   - At rest: one JSON object per file (mode 0600, parent dir 0700), one salt/iv/iterations/
 *     ciphertext record per `ref`. A wrong passphrase derives the wrong key and WebCrypto's
 *     auth-tag check makes `get` throw rather than ever return garbage plaintext.
 *
 * Passphrase resolution (every public method resolves it first, even when the operation would not
 * otherwise need the filesystem, so a non-TTY caller with no passphrase available fails loudly and
 * consistently rather than only on some code paths):
 *   1. `CANDLE_KEYRING_PASSPHRASE`, if set.
 *   2. An interactive hidden prompt, if `process.stdin.isTTY`.
 *   3. Otherwise, a hard error naming the environment variable -- never a silent plaintext file.
 * Resolved once per instance and cached for the rest of the process (a fresh CLI invocation only
 * ever constructs one store, so this means "prompt at most once per run").
 *
 * Not safe for concurrent writers against the same file: `set` and `delete` both do a
 * read-modify-write of the whole file.
 */
export class EncryptedFileSecretStore implements SecretStore {
  private readonly path: string
  private readonly iterations: number
  private cachedPassphrase: string | undefined

  constructor(options: EncryptedFileSecretStoreOptions = {}) {
    this.path = options.path ?? defaultCredentialsPath()
    this.iterations = options.iterations ?? PBKDF2_ITERATIONS
  }

  async get(ref: string): Promise<string | null> {
    const passphrase = await this.resolvePassphrase()
    const contents = await this.readContents()
    const entry = contents[ref]
    if (!entry) return null

    const salt = fromBase64(entry.salt)
    const key = await deriveKey(passphrase, salt, entry.iterations)
    const iv = fromBase64(entry.iv)
    const ciphertext = fromBase64(entry.ciphertext)
    // A wrong passphrase derives the wrong AES-GCM key; WebCrypto's auth-tag check then makes this
    // reject rather than resolve to garbage bytes. Caught here only to attach a message that names
    // the likely cause and the file -- the bare WebCrypto error ("OperationError: the operation
    // failed for an operation-specific reason") names neither.
    let plaintext: ArrayBuffer
    try {
      plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv as BufferSource },
        key,
        ciphertext as BufferSource,
      )
    } catch {
      throw new Error(
        `Could not decrypt the credential for "${ref}" in ${this.path}. CANDLE_KEYRING_PASSPHRASE is likely wrong for this file.`,
      )
    }
    return new TextDecoder().decode(plaintext)
  }

  async set(ref: string, value: string): Promise<void> {
    const passphrase = await this.resolvePassphrase()
    const contents = await this.readContents()

    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH_BYTES))
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES))
    const key = await deriveKey(passphrase, salt, this.iterations)
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      new TextEncoder().encode(value),
    )

    contents[ref] = {
      salt: toBase64(salt),
      iv: toBase64(iv),
      ciphertext: toBase64(new Uint8Array(ciphertext)),
      iterations: this.iterations,
    }
    await this.writeContents(contents)
  }

  async delete(ref: string): Promise<void> {
    await this.resolvePassphrase()
    const contents = await this.readContents()
    if (!(ref in contents)) return
    delete contents[ref]
    await this.writeContents(contents)
  }

  private async resolvePassphrase(): Promise<string> {
    if (this.cachedPassphrase !== undefined) return this.cachedPassphrase

    const fromEnv = process.env.CANDLE_KEYRING_PASSPHRASE
    if (fromEnv) {
      this.cachedPassphrase = fromEnv
      return fromEnv
    }

    if (process.stdin.isTTY) {
      const prompted = await promptHiddenPassphrase("Passphrase for Candle credential store: ")
      this.cachedPassphrase = prompted
      return prompted
    }

    throw new Error(
      "No keychain available and no CANDLE_KEYRING_PASSPHRASE set; set it to use the encrypted file store on this machine",
    )
  }

  private async readContents(): Promise<FileContents> {
    let raw: string
    try {
      raw = await readFile(this.path, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {}
      throw err
    }
    try {
      return JSON.parse(raw) as FileContents
    } catch {
      // A bare SyntaxError here would otherwise escape get/set/delete alike, giving the user no way
      // to tell what's wrong or how to recover. Name the file and the fix (there is no way to repair
      // a corrupted ciphertext file; the only way out is to delete it and re-store the credentials).
      throw new Error(
        `The credentials file at ${this.path} is not valid JSON and cannot be read. Delete it and re-run ` +
          "the command that stores your device token / API key to recreate it.",
      )
    }
  }

  private async writeContents(contents: FileContents): Promise<void> {
    const dir = dirname(this.path)
    await mkdir(dir, { recursive: true })
    await chmod(dir, 0o700)
    // Write to a temp file in the same directory and rename over the real path, rather than
    // truncating it in place: `rename` is atomic on the same filesystem, so a crash or power loss
    // mid-write can never leave `credentials.enc` half-written (which would lose BOTH stored
    // credentials, not just the one being updated, since they share one file).
    const tmpPath = `${this.path}.tmp`
    await writeFile(tmpPath, JSON.stringify(contents, null, 2), { encoding: "utf8", mode: 0o600 })
    // `writeFile`'s `mode` option only applies when the file is newly created; force it explicitly
    // in case a previous run left a `.tmp` file behind with a different mode.
    await chmod(tmpPath, 0o600)
    await rename(tmpPath, this.path)
  }
}

/**
 * Prompts for a passphrase on the controlling TTY without echoing keystrokes, using node:readline's
 * `_writeToOutput` override (its standard, if undocumented, hook for masked-input prompts -- there
 * is no public readline API for this, and zero runtime dependencies rules out a package that wraps
 * it). Not covered by the automated tests, since exercising it requires a real TTY; the non-TTY
 * refusal path immediately above it is what's tested.
 */
/**
 * TTY-guarded hidden prompt for `Deps.promptSecret` (wallets import's interactive key entry).
 * Same masking mechanism as the passphrase prompt below; refuses without a TTY so a piped or CI
 * invocation gets an actionable error instead of hanging on stdin.
 */
export async function promptHiddenSecret(promptText: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error("No TTY available for interactive input; pass --key-file instead")
  }
  return promptHiddenPassphrase(promptText)
}

async function promptHiddenPassphrase(promptText: string): Promise<string> {
  const readline = await import("node:readline")
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const rlInternals = rl as unknown as { _writeToOutput?: (text: string) => void }
    // Fail CLOSED: echo only a write that is exactly the prompt text itself. Everything else --
    // every typed character and its newline echo -- is swallowed unconditionally. (An earlier
    // version echoed everything up to the first write that matched the prompt, which fails open: if
    // readline ever emits something else first, keystrokes would be echoed before that guard ever
    // triggers.)
    rlInternals._writeToOutput = (text: string) => {
      if (text === promptText) process.stdout.write(text)
    }
    rl.question(promptText, (answer) => {
      rl.close()
      process.stdout.write("\n")
      resolve(answer)
    })
  })
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64")
}

function fromBase64(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"))
}
