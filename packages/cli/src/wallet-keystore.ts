/**
 * The encrypted keystore behind `wallets generate`.
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
import { chmod, mkdir, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { WalletChain } from "./wallet-import"

/**
 * Default location, alongside credentials.enc but a distinct file. Mirrors secret-store's own
 * configDir (CANDLE_CONFIG_DIR, else ~/.config/candle), which is module-private there; the env is
 * passed in rather than read from process so a test can point this somewhere disposable.
 */
export function defaultKeystorePath(env: Record<string, string | undefined>): string {
  const dir = env.CANDLE_CONFIG_DIR?.trim() || join(homedir(), ".config", "candle")
  return join(dir, "wallets.enc")
}

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
  privyWalletId?: string
  importedAt?: string
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
  }
  return `${JSON.stringify(file, null, 2)}\n`
}

export async function readKeystore(raw: string, passphrase: string): Promise<OpenKeystore> {
  let file: KeystoreFile
  try {
    file = JSON.parse(raw) as KeystoreFile
  } catch {
    throw new Error("The keystore file is not valid JSON.")
  }
  if (file.version !== KEYSTORE_VERSION) {
    throw new Error(`Unsupported keystore version ${file.version}: this CLI writes version ${KEYSTORE_VERSION}.`)
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
  return {
    entries: JSON.parse(new TextDecoder().decode(plain)) as KeystoreEntry[],
    key,
    salt,
    iterations: file.iterations,
  }
}

/**
 * Writes the keystore atomically, mirroring EncryptedFileSecretStore's approach: temp file in the
 * same directory, then rename. A crash mid-write must never truncate an existing keystore, because
 * for independently generated keys that file is the only copy of every one of them.
 */
export async function writeKeystoreFile(path: string, contents: string): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  await chmod(dir, 0o700)
  const tmpPath = `${path}.tmp`
  await writeFile(tmpPath, contents, { encoding: "utf8", mode: 0o600 })
  // `mode` only applies when the file is newly created, so force it in case a previous run left a
  // .tmp behind with a different mode.
  await chmod(tmpPath, 0o600)
  await rename(tmpPath, path)
}
