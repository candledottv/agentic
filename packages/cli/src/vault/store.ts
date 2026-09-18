/**
 * Ember Phase 2 (BE-136, CC-01, ED-1, ED-6, ED-8): opening, unlocking and writing `vault.enc`.
 *
 * The open sequence is ED-1's and the order is the security property, not an implementation
 * detail. Parse and structurally refuse (no factor needed); unwrap the DEK from one envelope;
 * derive the payload key; decrypt the INDEX under the canonical header, which is what
 * authenticates the header; only then look at a key blob. A header altered outside this CLI, an
 * envelope stripped or added, a KDF parameter changed, or an index from any other write of the
 * same vault all fail at that one tag check, before any key blob is touched.
 *
 * An ordinary open deliberately never decrypts the root and never decrypts a key blob it does not
 * need (ED-5): a signature's plaintext lifetime covers one leaf, not every key the vault could
 * produce. That is also the gap CC-07's verifier exists to close, and why a backup is not verified
 * by opening it.
 *
 * Writes reuse Phase 1's file machinery (ED-8): the same advisory lock directory, the same unique
 * temp plus rename. What is new is the fail-closed re-read: `tee` merges a concurrent writer's
 * entry because losing one would lose a funded key, but a vault write that found the file changed
 * underneath it has no safe merge (the other writer may have added an envelope this one's index
 * does not authenticate), so it refuses with `VAULT_CHANGED` and writes nothing.
 */
import { chmod, mkdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Deps } from "../deps"
import { KeystoreLockedError, withKeystoreLock, writeKeystoreFile } from "../wallet-keystore"
import {
  type Blob,
  b64u,
  DEK_BYTES,
  derivePassphraseKek,
  derivePayloadKey,
  derivePrfKek,
  importAesKey,
  open as openBlob,
  randomBytes,
  seal,
  sealJson,
  unb64u,
} from "./crypto"
import { VaultError } from "./errors"
import {
  assertKeyIdsAgree,
  canonicalHeader,
  type Envelope,
  envelopeAad,
  type IndexPlaintext,
  isPrfEnvelope,
  isSecureEnclaveEnvelope,
  type KeyEntry,
  keyAad,
  parseIndexPlaintext,
  parseVaultFile,
  passphraseKdf,
  rootAad,
  VAULT_CIPHER,
  VAULT_FORMAT,
  VAULT_VERSION,
  type VaultFile,
} from "./format"
import { ownSecret, wipe, withSecret } from "./hygiene"
import { nextSidecar, readSidecar, sidecarPath, type VaultSidecar, writeSidecar } from "./sidecar"

// ── Location (ED-8) ───────────────────────────────────────────────────────────────────────────

export function candleConfigDir(env: Record<string, string | undefined>): string {
  return env.CANDLE_CONFIG_DIR?.trim() || join(homedir(), ".config", "candle")
}

/**
 * `vault.enc`, beside `tee-wallets.enc` and `credentials.enc`. `version: 2` is on purpose: a 0.9.x
 * reader pointed at this file refuses it with "Unsupported keystore version 2" rather than
 * misreading it (T50).
 */
export function defaultVaultPath(env: Record<string, string | undefined>): string {
  return join(candleConfigDir(env), "vault.enc")
}

export function legacyWalletsPath(env: Record<string, string | undefined>): string {
  return join(candleConfigDir(env), "wallets.enc")
}

/** Reads the raw file; null when there is none. Any other read failure is `VAULT_UNREADABLE`. */
export async function readVaultRaw(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null
    throw new VaultError("VAULT_UNREADABLE", `Could not read the vault at ${path}.`)
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// ── Unlocking ─────────────────────────────────────────────────────────────────────────────────

/**
 * How a caller supplies a factor. The passphrase is typed; a passkey's factor is the 32-byte
 * user-verified PRF output the helper returned for THIS envelope, over CTAP2 `hmac-secret`
 * (BE-140, ED-11) or the platform authenticator's PRF extension (BE-135, the same derivation,
 * ED-4), which the caller owns and zeroes; the Secure Enclave's is the 32-byte intermediate KEK
 * the Enclave unwrapped behind Touch ID (BE-141, ED-12), likewise the caller's to zero.
 */
export type UnlockRequest =
  | { factor: "passphrase"; passphrase: string; envelopeId?: string }
  | { factor: "passkey-prf"; envelopeId: string; prfOutput: Uint8Array }
  | { factor: "secure-enclave"; envelopeId: string; kek: Uint8Array }

/**
 * An opened vault. `dek` is the raw data-encryption key and is the caller's to release through
 * `closeVault`; `payloadKey` is non-extractable, so the bytes behind it never exist as a buffer
 * this code could leak.
 */
export interface UnlockedVault {
  path: string
  /** The exact bytes the file held when it was opened, for the write path's change detection. */
  raw: string
  file: VaultFile
  index: IndexPlaintext
  payloadKey: CryptoKey
  dek: Uint8Array
  /** Which envelope actually opened it, for the output that names the factor used. */
  envelope: Envelope
}

export function closeVault(vault: UnlockedVault): void {
  wipe(vault.dek)
}

/**
 * Unwraps the DEK from one envelope, derives the payload key, and decrypts the index under the
 * canonical header.
 *
 * A wrong passphrase and a tampered envelope are indistinguishable here BY DESIGN and share one
 * message: distinguishing them would tell an attacker holding the file which of the two they are
 * looking at. The index tag failure is the other deliberate conflation, and CC-01 names all three
 * of its causes in one sentence for the same reason.
 */
export async function unlockVault(
  path: string,
  raw: string,
  request: UnlockRequest,
  opts: { notice?: (line: string) => void } = {},
): Promise<UnlockedVault> {
  const file = parseVaultFile(raw)
  const envelope = pickEnvelope(file, request)

  const dek = await unwrapDek(file, envelope, request, opts.notice)
  if (dek.length !== DEK_BYTES) {
    wipe(dek)
    throw new VaultError("VAULT_UNLOCK_FAILED", "The unwrapped key is the wrong length; this file is corrupt.")
  }

  try {
    const payloadKey = await derivePayloadKey(dek, unb64u(file.vaultId, "vaultId"))
    // ED-1: THIS is the header authentication. Nothing below has looked at a key blob yet.
    const indexBytes = await openBlob(payloadKey, file.index, canonicalHeader(file), {
      code: "VAULT_BLOB_TAMPERED",
      message:
        "The vault header was altered, an envelope was added or removed outside this CLI, or this index is from a different write of the vault.",
      suggestion: "Nothing was written. Restore the file from a verified backup.",
    })
    let index: IndexPlaintext
    try {
      index = parseIndexPlaintext(indexBytes)
    } finally {
      wipe(indexBytes)
    }
    assertKeyIdsAgree(file)
    return { path, raw, file, index, payloadKey, dek, envelope }
  } catch (error) {
    wipe(dek)
    throw error
  }
}

/**
 * ED-4's one wrapping construction, unwrapped with whichever KEK construction the request names.
 * The factors differ only here: Argon2id over the passphrase, HKDF over the PRF output. A wrong
 * factor and a tampered envelope stay indistinguishable and share one message per factor.
 */
async function unwrapDek(
  file: VaultFile,
  envelope: Envelope,
  request: UnlockRequest,
  notice?: (line: string) => void,
): Promise<Uint8Array> {
  if (request.factor === "passphrase") {
    const kek = await derivePassphraseKek(request.passphrase, passphraseKdf(envelope), notice)
    return withSecret(kek, async (kekBytes) => {
      const kekKey = await importAesKey(kekBytes)
      return openBlob(kekKey, envelope.wrap, envelopeAad(file, envelope), {
        code: "VAULT_UNLOCK_FAILED",
        message: "Could not open the vault: wrong passphrase, or the file is corrupt.",
      })
    })
  }
  if (request.factor === "secure-enclave") {
    if (!isSecureEnclaveEnvelope(envelope)) {
      throw new VaultError(
        "VAULT_FACTOR_UNAVAILABLE",
        `Envelope ${envelope.id} is a ${envelope.factor} envelope, not a Secure Enclave one.`,
      )
    }
    // ED-4: the Enclave's KEK is the random intermediate itself, unwrapped by the Enclave, so
    // there is nothing to derive; it is imported non-extractable and the caller zeroes the bytes.
    const kekKey = await importAesKey(request.kek)
    return openBlob(kekKey, envelope.wrap, envelopeAad(file, envelope), {
      code: "VAULT_UNLOCK_FAILED",
      message:
        "Could not open the vault with the Secure Enclave: what it unwrapped is not this envelope's key, or the file is corrupt.",
      suggestion: "Nothing was derived from it and no other factor was tried.",
    })
  }
  if (!isPrfEnvelope(envelope)) {
    throw new VaultError(
      "VAULT_FACTOR_UNAVAILABLE",
      `Envelope ${envelope.id} is a ${envelope.factor} envelope, not a passkey one.`,
    )
  }
  const kekKey = await derivePrfKek(request.prfOutput, unb64u(file.vaultId, "vaultId"))
  const what = envelope.transport === "platform-macos" ? "this synced passkey" : "this security key"
  return openBlob(kekKey, envelope.wrap, envelopeAad(file, envelope), {
    code: "VAULT_UNLOCK_FAILED",
    message: `Could not open the vault with ${what}: the assertion did not yield this envelope's key, or the file is corrupt.`,
    suggestion: "Nothing was derived from it and no other factor was tried.",
  })
}

function pickEnvelope(file: VaultFile, request: UnlockRequest): Envelope {
  const candidates = file.envelopes.filter((envelope) => envelope.factor === request.factor)
  if (request.envelopeId !== undefined) {
    const named = candidates.find((envelope) => envelope.id === request.envelopeId)
    if (!named)
      throw new VaultError(
        "VAULT_FACTOR_UNAVAILABLE",
        `This vault has no ${request.factor} envelope with id ${request.envelopeId}.`,
      )
    return named
  }
  const first = candidates[0]
  if (!first) {
    throw new VaultError("VAULT_FACTOR_UNAVAILABLE", `This vault has no ${request.factor} envelope.`, {
      suggestion: "Run `candle vault status` to see which factors can open it.",
    })
  }
  return first
}

/**
 * Tries every passphrase envelope in turn. A vault with two passphrase factors should open with
 * either one typed, which a single-envelope attempt would not do; the cost is one Argon2 pass per
 * envelope on a wrong passphrase, which is the correct thing to be slow at.
 */
export async function unlockWithPassphrase(
  path: string,
  raw: string,
  passphrase: string,
  opts: { notice?: (line: string) => void } = {},
): Promise<UnlockedVault> {
  const file = parseVaultFile(raw)
  const envelopes = file.envelopes.filter((envelope) => envelope.factor === "passphrase")
  if (envelopes.length === 0) {
    throw new VaultError("VAULT_FACTOR_UNAVAILABLE", "This vault has no passphrase envelope.")
  }
  let last: unknown
  for (const envelope of envelopes) {
    try {
      return await unlockVault(path, raw, { factor: "passphrase", passphrase, envelopeId: envelope.id }, opts)
    } catch (error) {
      // A tampered INDEX is a property of the file, not of this envelope, so it stops here rather
      // than being retried under the next one with the same outcome and another Argon2 pass.
      if (error instanceof VaultError && error.code !== "VAULT_UNLOCK_FAILED") throw error
      last = error
    }
  }
  throw last
}

// ── Reading the encrypted payloads ────────────────────────────────────────────────────────────

/**
 * ED-13: the events that may decrypt the root are `init`, `new-key`, `promote --from`,
 * `phrase show`, `restore --phrase`, and CC-07's verifier. Nothing else calls this, and T36
 * asserts through a seam that a transfer never does.
 */
export async function decryptRoot(vault: UnlockedVault): Promise<Uint8Array> {
  return openBlob(vault.payloadKey, vault.file.root, rootAad(vault.file.vaultId), {
    code: "VAULT_BLOB_TAMPERED",
    message: "The vault's root blob failed its authentication tag.",
    suggestion:
      "Nothing was written. Restore the file from a verified backup; `vault verify-backup` checks a copy in full.",
  })
}

/** Decrypts exactly one key blob. The caller owns the plaintext and zeroes it. */
export async function decryptKey(vault: UnlockedVault, keyId: string): Promise<Uint8Array> {
  const blob = vault.file.keys.find((candidate) => candidate.id === keyId)
  if (!blob) throw new VaultError("VAULT_INDEX_INVALID", `The vault declares key ${keyId} but holds no blob for it.`)
  return openBlob(vault.payloadKey, blob, keyAad(vault.file.vaultId, keyId), {
    code: "VAULT_BLOB_TAMPERED",
    message: `Key blob ${keyId} failed its authentication tag.`,
    suggestion: "Nothing was written.",
  })
}

// ── Creating and writing ──────────────────────────────────────────────────────────────────────

/**
 * A fresh base64url id of `bytes` random bytes, never starting with `-` or `_`.
 *
 * The leading-character rule is not cosmetic. An envelope id is typed as a POSITIONAL argument
 * (`candle vault factor remove <id>`), and this CLI's shared parser treats any token beginning
 * with `-` as a flag -- correctly, since that is what makes a mistyped flag a usage error rather
 * than a silent positional. So an id that began with `-` would be an envelope the operator could
 * see in `factor list` and could not remove, about one time in thirty-two. Re-drawing costs
 * nothing and removes the case entirely.
 */
function freshId(bytes: number): string {
  for (;;) {
    const id = b64u(crypto.getRandomValues(new Uint8Array(bytes)))
    if (!id.startsWith("-") && !id.startsWith("_")) return id
  }
}

export function freshEnvelopeId(): string {
  return freshId(8)
}

export function freshKeyId(): string {
  return freshId(8)
}

export function freshVaultId(): string {
  return freshId(16)
}

/** A brand-new DEK. Returned raw so the caller can wrap it under each envelope, then zero it. */
export function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES)
}

/** Wraps `dek` under the KEK a passphrase derives, producing the envelope's `wrap` blob. */
export async function wrapDekForPassphrase(
  dek: Uint8Array,
  passphrase: string,
  envelope: Envelope,
  header: Pick<VaultFile, "vaultId">,
  notice?: (line: string) => void,
): Promise<{ alg: typeof VAULT_CIPHER } & Blob> {
  const kek = await derivePassphraseKek(passphrase, passphraseKdf(envelope), notice)
  return withSecret(kek, async (kekBytes) => {
    const kekKey = await importAesKey(kekBytes)
    const blob = await seal(kekKey, dek, envelopeAad(header, envelope))
    return { alg: VAULT_CIPHER, ...blob }
  })
}

/**
 * Wraps `dek` under the KEK a security key's PRF output derives (ED-4, ED-11). The caller owns
 * both `dek` and `prfOutput` and zeroes them; the KEK itself never exists as bytes here.
 */
export async function wrapDekForPrf(
  dek: Uint8Array,
  prfOutput: Uint8Array,
  envelope: Envelope,
  header: Pick<VaultFile, "vaultId">,
): Promise<{ alg: typeof VAULT_CIPHER } & Blob> {
  const kekKey = await derivePrfKek(prfOutput, unb64u(header.vaultId, "vaultId"))
  const blob = await seal(kekKey, dek, envelopeAad(header, envelope))
  return { alg: VAULT_CIPHER, ...blob }
}

/**
 * Wraps `dek` under a KEK that already exists as bytes: the Secure Enclave's random intermediate
 * (ED-4, ED-12). The caller owns `dek` and `kek` and zeroes both; the imported key is
 * non-extractable.
 */
export async function wrapDekForKek(
  dek: Uint8Array,
  kek: Uint8Array,
  envelope: Envelope,
  header: Pick<VaultFile, "vaultId">,
): Promise<{ alg: typeof VAULT_CIPHER } & Blob> {
  const kekKey = await importAesKey(kek)
  const blob = await seal(kekKey, dek, envelopeAad(header, envelope))
  return { alg: VAULT_CIPHER, ...blob }
}

/** Serializes a vault file for disk: pretty-printed, as every other store in this CLI is. */
export function serializeVault(file: VaultFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

/**
 * Re-seals the index under the CURRENT header and returns the finished file. Every write that
 * changes the header goes through here, which is what makes "the index authenticates the header"
 * true of writes and not only of reads: the header is assembled first, then sealed into the index.
 */
export async function sealIndex(
  header: Omit<VaultFile, "index">,
  index: IndexPlaintext,
  payloadKey: CryptoKey,
): Promise<VaultFile> {
  const withoutIndex = { ...header }
  // The canonical header excludes `index`, `root` and `keys`; `canonicalHeader` picks the fields
  // it needs by name, so passing the whole record is safe and keeps one source of that list.
  const blob = await sealJson(payloadKey, index, canonicalHeader(withoutIndex as unknown as VaultFile))
  return { ...withoutIndex, index: blob } as VaultFile
}

export interface CommitPlan {
  /** The index as it should be after this write. */
  index: IndexPlaintext
  /** Envelopes as they should be after this write; defaults to the ones already there. */
  envelopes?: Envelope[]
  /** Key blobs to ADD. Existing blobs are never re-encrypted (ED-1). */
  addKeys?: Array<{ id: string } & Blob>
  /** Sidecar fields this write records beyond the generation and envelope bookkeeping. */
  sidecar?: Partial<VaultSidecar>
}

/**
 * The one write path. Under the lock it re-reads the file and refuses if the bytes moved since
 * this command opened it; then it bumps `generation`, rebuilds the header, re-seals the index
 * under it, writes atomically, and updates the sidecar.
 *
 * The root blob and every existing key blob are copied through untouched, which is ED-1's whole
 * point: adding or removing a factor costs one AES-GCM call over a small plaintext with no
 * secrets in it, and nothing else in the file is rewritten.
 */
export async function commitVault(
  vault: UnlockedVault,
  plan: CommitPlan,
  clock: Pick<Deps, "now" | "sleep">,
): Promise<UnlockedVault> {
  const written = await withVaultLock(vault.path, clock, async () => {
    const current = await readVaultRaw(vault.path)
    if (current !== vault.raw) {
      throw new VaultError(
        "VAULT_CHANGED",
        "The vault changed on disk while this command was running; nothing was written.",
        {
          suggestion: "Another candle command wrote to it. Run this one again.",
        },
      )
    }

    const envelopes = plan.envelopes ?? vault.file.envelopes
    const keys = [...vault.file.keys, ...(plan.addKeys ?? [])]
    const header: Omit<VaultFile, "index"> = {
      format: VAULT_FORMAT,
      version: VAULT_VERSION,
      vaultId: vault.file.vaultId,
      generation: vault.file.generation + 1,
      createdAt: vault.file.createdAt,
      updatedAt: new Date(clock.now()).toISOString(),
      cipher: VAULT_CIPHER,
      envelopes,
      keyIds: keys.map((blob) => blob.id),
      root: vault.file.root,
      keys,
    }
    const next = await sealIndex(header, plan.index, vault.payloadKey)
    const contents = serializeVault(next)
    try {
      await writeKeystoreFile(vault.path, contents)
    } catch {
      throw new VaultError("VAULT_WRITE_FAILED", `Could not write the vault at ${vault.path}.`)
    }
    return { next, contents }
  })

  const path = sidecarPath(vault.path)
  await writeSidecar(path, nextSidecar(await readSidecar(path), written.next, plan.sidecar)).catch(() => {})
  return { ...vault, raw: written.contents, file: written.next, index: plan.index }
}

/** Phase 1's advisory lock, with the vault's own typed refusal on top of it. */
export async function withVaultLock<T>(
  path: string,
  clock: Pick<Deps, "now" | "sleep">,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await withKeystoreLock(path, clock, fn)
  } catch (error) {
    if (error instanceof KeystoreLockedError) {
      throw new VaultError("VAULT_LOCKED", error.message)
    }
    throw error
  }
}

/** Seals one key's raw secret as its own blob (ED-5). Never re-encrypted after creation. */
export async function sealKeyBlob(
  vault: Pick<UnlockedVault, "payloadKey" | "file">,
  keyId: string,
  secret: Uint8Array,
): Promise<{ id: string } & Blob> {
  const blob = await seal(vault.payloadKey, secret, keyAad(vault.file.vaultId, keyId))
  return { id: keyId, ...blob }
}

/** Writes a brand-new vault file, creating the config directory 0700 and the file 0600. */
export async function writeNewVault(path: string, contents: string): Promise<void> {
  await mkdir(candleConfigDirOf(path), { recursive: true })
  await chmod(candleConfigDirOf(path), 0o700).catch(() => {})
  await writeKeystoreFile(path, contents)
}

function candleConfigDirOf(path: string): string {
  return join(path, "..")
}

/** The entries a command lists, ordered as they were created so output is stable. */
export function entriesOf(vault: UnlockedVault): KeyEntry[] {
  return vault.index.entries
}

export { ownSecret }
