/**
 * The core-only credential slot (BE-1665, spec K-11). Turning trading on moves a profile's Write
 * key, device token and key-signer private halves out of the plain `tv.candle.cli` items and into
 * `<state dir>/slot.enc`, sealed under a key only an unlocked vault can derive.
 *
 * Why the vault and not an OS access list: the plain store has no per-binary gate on any backend
 * (`keychain.ts` writes with no `-T`, and any same-user process can run the same `security` read),
 * and a harness such as Claude Code or Codex runs shell commands as the user. A secret it can read
 * without a factor is a secret it holds. Sealing under the vault means opening the slot needs the
 * vault factor (passphrase, Touch ID through the Secure Enclave helper, or a security key), which
 * is the spec's "Write key inside the vault" route and, on macOS, its Secure Enclave route.
 *
 * THIS MODULE IS IMPORTED BY EXACTLY ONE FILE: `commands/core.ts`, the `candle core serve` entry.
 * `core-slot-imports.test.ts` enforces that over every source file, static and dynamic imports and
 * re-exports alike. No other subcommand, flag, environment variable or config value reaches
 * {@link openCoreSlot}. The plain CLI decides core ownership from the slot file's existence alone
 * (`ownership.ts`), without reading it.
 *
 * Key: HKDF-SHA256 over the vault DEK, salt the vault id, info `candle-core/v1/slot`; AES-256-GCM
 * with the canonical header (format, version, profile, environment, vault id, write-key prefix)
 * as associated data, so a slot copied to another profile or environment fails its tag.
 *
 * The Withdraw key (BE-1680, spec S4 W-1 to W-3). When the user turns transfers from the embedded
 * wallet on, the slot also holds an optional `withdrawKey`, re-sealed in place by
 * {@link resealCoreSlot}. Opening the slot decrypts all of it, so {@link openCoreSlot} takes a
 * `purpose`: `"trading"` (every open but a transfer's) drops the field before it returns, after the
 * plaintext buffer is wiped, so no window, paper run or dry run ever holds a reference to it;
 * only `"transfer"` returns it.
 */
import { open as openFile, readFile, rename, rm } from "node:fs/promises"
import type { Deps } from "../deps"
import { keySignerRef } from "../key-signers"
import { apiKeyPrefix, profileSecretRef } from "../profiles"
import { SECRET_REFS } from "../secret-store"
import { canonicalBytes } from "../vault/canonical-json"
import { type Blob, b64u, open as openBlob, seal, unb64u } from "../vault/crypto"
import { wipe } from "../vault/hygiene"
import type { UnlockedVault } from "../vault/store"

/** The slice of an unlocked vault the slot uses: its DEK and its id. */
export type SlotVault = Pick<UnlockedVault, "dek"> & { file: Pick<UnlockedVault["file"], "vaultId"> }

import type { CoreEnvironment } from "./journal"
import { slotExists } from "./ownership"
import type { CorePaths } from "./paths"

export const CORE_SLOT_FORMAT = "candle-core-slot"
export const CORE_SLOT_VERSION = 1
const HKDF_INFO = "candle-core/v1/slot"

/** The non-secret header, stored in clear beside the sealed blob and bound into its tag. */
export interface CoreSlotHeader {
  format: typeof CORE_SLOT_FORMAT
  version: typeof CORE_SLOT_VERSION
  profile: string
  environment: CoreEnvironment
  vaultId: string
  /** The Write key's public 8-character prefix: lets a resumed move match a leftover plain key. */
  writeKeyPrefix: string
}

export interface CoreSlotFile extends CoreSlotHeader {
  createdAt: string
  blob: Blob
}

export interface CoreSlotSigner {
  /** The secret-store ref it was moved from (`key_signer_<prefix>_<spkiSha256>`). */
  ref: string
  value: string
}

/** What the slot holds. Lives only in the core's memory once opened. */
export interface CoreSlotContents {
  writeKey: string
  deviceToken: string
  signers: CoreSlotSigner[]
  /** S4 W-1: present once transfers from the embedded wallet are on. Returned for `purpose: "transfer"` only. */
  withdrawKey?: string
}

/** Why the slot is opened (W-3): only a transfer receives the Withdraw key. */
export type CoreSlotPurpose = "trading" | "transfer"

export class CoreSlotError extends Error {
  constructor(
    readonly code:
      | "CORE_SLOT_EXISTS"
      | "CORE_SLOT_MISSING"
      | "CORE_SLOT_INVALID"
      | "CORE_SLOT_MISMATCH"
      | "CORE_SLOT_NOTHING_TO_MOVE"
      | "CORE_SLOT_READ_KEY_IS_WRITE_KEY",
    message: string,
  ) {
    super(message)
    this.name = "CoreSlotError"
  }
}

function headerOf(file: CoreSlotHeader): CoreSlotHeader {
  return {
    format: file.format,
    version: file.version,
    profile: file.profile,
    environment: file.environment,
    vaultId: file.vaultId,
    writeKeyPrefix: file.writeKeyPrefix,
  }
}

async function deriveSlotKey(vault: SlotVault): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", vault.dek as BufferSource, "HKDF", false, ["deriveKey"])
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: unb64u(vault.file.vaultId, "vaultId") as BufferSource,
      info: new TextEncoder().encode(HKDF_INFO),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )
}

/** Seals `contents` for `header` under `vault`. Exported for the tests; `moveProfileToCore` is the caller. */
export async function sealCoreSlot(
  vault: SlotVault,
  header: CoreSlotHeader,
  contents: CoreSlotContents,
  createdAt: string,
): Promise<CoreSlotFile> {
  const key = await deriveSlotKey(vault)
  const plain = new TextEncoder().encode(JSON.stringify(contents))
  try {
    const blob = await seal(key, plain, canonicalBytes(headerOf(header)))
    return { ...headerOf(header), createdAt, blob }
  } finally {
    wipe(plain)
  }
}

export function parseCoreSlotFile(raw: string): CoreSlotFile {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new CoreSlotError("CORE_SLOT_INVALID", "The core slot file is not valid JSON.")
  }
  const file = value as Partial<CoreSlotFile>
  if (
    file === null ||
    typeof file !== "object" ||
    file.format !== CORE_SLOT_FORMAT ||
    file.version !== CORE_SLOT_VERSION ||
    typeof file.profile !== "string" ||
    (file.environment !== "staging" && file.environment !== "production") ||
    typeof file.vaultId !== "string" ||
    typeof file.writeKeyPrefix !== "string" ||
    typeof file.blob?.iv !== "string" ||
    typeof file.blob?.ciphertext !== "string"
  ) {
    throw new CoreSlotError("CORE_SLOT_INVALID", "The core slot file is not a version 1 Candle core slot.")
  }
  return file as CoreSlotFile
}

/** Reads the slot's clear header. Needs no factor and yields no secret. */
export async function readCoreSlotHeader(paths: CorePaths): Promise<CoreSlotFile | undefined> {
  let raw: string
  try {
    raw = await readFile(paths.slot, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  return parseCoreSlotFile(raw)
}

/**
 * THE credential loader (K-11). Opens the slot with an unlocked vault. A wrong vault, a slot
 * moved to another profile or environment, or a tampered file all fail the same tag check.
 */
export async function openCoreSlot(input: {
  paths: CorePaths
  vault: SlotVault
  profile: string
  environment: CoreEnvironment
  /** W-3: `"trading"` (the default) drops the Withdraw key; only `"transfer"` returns it. */
  purpose?: CoreSlotPurpose
}): Promise<CoreSlotContents> {
  const file = await readCoreSlotHeader(input.paths)
  if (file === undefined) throw new CoreSlotError("CORE_SLOT_MISSING", "This profile has no core slot.")
  if (file.profile !== input.profile || file.environment !== input.environment) {
    throw new CoreSlotError(
      "CORE_SLOT_MISMATCH",
      `The core slot is for profile "${file.profile}" on ${file.environment}, not "${input.profile}" on ${input.environment}.`,
    )
  }
  if (file.vaultId !== input.vault.file.vaultId) {
    throw new CoreSlotError("CORE_SLOT_MISMATCH", "The core slot was sealed under a different vault on this machine.")
  }
  const key = await deriveSlotKey(input.vault)
  const plain = await openBlob(key, file.blob, canonicalBytes(headerOf(file)), {
    code: "VAULT_BLOB_TAMPERED",
    message: "The core slot failed its authentication tag.",
    suggestion: "Nothing was read. Turn trading off and on again in the Candle TUI to rebuild the slot.",
  })
  try {
    const parsed = JSON.parse(new TextDecoder().decode(plain)) as Partial<CoreSlotContents>
    if (
      typeof parsed.writeKey !== "string" ||
      typeof parsed.deviceToken !== "string" ||
      !Array.isArray(parsed.signers) ||
      (parsed.withdrawKey !== undefined && typeof parsed.withdrawKey !== "string")
    ) {
      throw new CoreSlotError("CORE_SLOT_INVALID", "The core slot's contents are not in the expected shape.")
    }
    const contents: CoreSlotContents = {
      writeKey: parsed.writeKey,
      deviceToken: parsed.deviceToken,
      signers: parsed.signers,
    }
    if (input.purpose === "transfer" && parsed.withdrawKey !== undefined) contents.withdrawKey = parsed.withdrawKey
    // W-3: the parsed object is the only other reference to the Withdraw key; drop it before return.
    delete parsed.withdrawKey
    return contents
  } finally {
    wipe(plain)
  }
}

/**
 * W-2: re-seals the slot with `withdrawKey`, or without it when undefined, under the same vault and
 * header. Written like the first seal: a temporary file, fsync, then an atomic rename, so a crash
 * leaves either the old slot or the new one.
 */
export async function resealCoreSlot(input: {
  paths: CorePaths
  vault: SlotVault
  profile: string
  environment: CoreEnvironment
  withdrawKey: string | undefined
  now: () => number
}): Promise<void> {
  const file = await readCoreSlotHeader(input.paths)
  if (file === undefined) throw new CoreSlotError("CORE_SLOT_MISSING", "This profile has no core slot.")
  const contents = await openCoreSlot({ ...input, purpose: "transfer" })
  if (input.withdrawKey === undefined) delete contents.withdrawKey
  else contents.withdrawKey = input.withdrawKey
  const sealed = await sealCoreSlot(input.vault, headerOf(file), contents, new Date(input.now()).toISOString())
  await writeSlotFile(input.paths, sealed)
}

async function writeSlotFile(paths: CorePaths, file: CoreSlotFile): Promise<void> {
  const temp = `${paths.slot}.tmp-${b64u(crypto.getRandomValues(new Uint8Array(6)))}`
  const handle = await openFile(temp, "wx", 0o600)
  try {
    await handle.write(`${JSON.stringify(file)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temp, paths.slot)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

type MoveDeps = Pick<Deps, "store" | "readConfig" | "updateProfile">

/** Migration retained legacy copies for rollback. Remove matching copies before their profile
 * refs, so an interrupted cleanup can still compare the device token on its next attempt. */
async function removeLegacyCopies(
  deps: MoveDeps,
  deviceToken: string | null,
  writeKeyPrefix: string,
  writeKey?: string,
): Promise<string[]> {
  const removed: string[] = []
  const legacyToken = await deps.store.get(SECRET_REFS.deviceToken)
  if (deviceToken !== null && legacyToken === deviceToken) {
    await deps.store.delete(SECRET_REFS.deviceToken)
    removed.push(SECRET_REFS.deviceToken)
  }
  const legacyKey = await deps.store.get(SECRET_REFS.apiKey)
  if (
    legacyKey !== null &&
    (writeKey !== undefined
      ? legacyKey === writeKey
      : writeKeyPrefix !== "" && apiKeyPrefix(legacyKey) === writeKeyPrefix)
  ) {
    await deps.store.delete(SECRET_REFS.apiKey)
    removed.push(SECRET_REFS.apiKey)
  }
  return removed
}

/** The plain refs a core-owned profile must not hold, for the Write key whose prefix is given. */
async function plainWriteRefs(deps: MoveDeps, profile: string, writeKeyPrefix: string): Promise<string[]> {
  const config = await deps.readConfig()
  const signerRefs = (config.keySigners?.entries ?? [])
    .filter((entry) => entry.keyPrefix === writeKeyPrefix)
    .map((entry) => keySignerRef(entry.keyPrefix, entry.spkiSha256))
  return [profileSecretRef(profile, "deviceToken"), ...signerRefs]
}

/**
 * Moves a profile's credentials into its core-only slot (K-11), in an order that a crash at any
 * point leaves safe:
 *
 *   1. seal and write the slot (fsync, then an atomic rename) -- from here the profile is
 *      core-owned, because ownership is the slot's existence;
 *   2. record the `coreOwned` marker (informational only; see `ownership.ts`);
 *   3. delete the plain device token, the plain Write key and the plain signer halves;
 *   4. store the Read key, when one is given, as the profile's plain key.
 *
 * A crash between 1 and 3 leaves plain copies behind on a profile the plain CLI already refuses
 * to act as; {@link finishCoreMove} removes them on the core's next start without a factor.
 */
export async function moveProfileToCore(input: {
  deps: MoveDeps
  paths: CorePaths
  profile: string
  environment: CoreEnvironment
  vault: SlotVault
  readKey?: string
  now: () => number
}): Promise<CoreSlotHeader> {
  const { deps, profile } = input
  if (await slotExists(input.paths)) {
    throw new CoreSlotError("CORE_SLOT_EXISTS", `Profile "${profile}" already has a core slot.`)
  }
  const apiKeyRef = profileSecretRef(profile, "apiKey")
  const writeKey = await deps.store.get(apiKeyRef)
  const deviceToken = await deps.store.get(profileSecretRef(profile, "deviceToken"))
  if (!writeKey || !deviceToken) {
    throw new CoreSlotError(
      "CORE_SLOT_NOTHING_TO_MOVE",
      `Profile "${profile}" has no stored API key and device token to move. Sign in with candle auth login first.`,
    )
  }
  if (input.readKey !== undefined && input.readKey.trim() === writeKey.trim()) {
    throw new CoreSlotError(
      "CORE_SLOT_READ_KEY_IS_WRITE_KEY",
      "The Read key given is the Write key itself; a core-owned profile keeps only a read-only key in the plain store.",
    )
  }
  const writeKeyPrefix = apiKeyPrefix(writeKey) ?? ""
  const refs = await plainWriteRefs(deps, profile, writeKeyPrefix)
  const signers: CoreSlotSigner[] = []
  for (const ref of refs.slice(1)) {
    const value = await deps.store.get(ref)
    if (value) signers.push({ ref, value })
  }

  const header: CoreSlotHeader = {
    format: CORE_SLOT_FORMAT,
    version: CORE_SLOT_VERSION,
    profile,
    environment: input.environment,
    vaultId: input.vault.file.vaultId,
    writeKeyPrefix,
  }
  const file = await sealCoreSlot(
    input.vault,
    header,
    { writeKey, deviceToken, signers },
    new Date(input.now()).toISOString(),
  )
  await writeSlotFile(input.paths, file)

  await deps.updateProfile(profile, { coreOwned: true })
  await removeLegacyCopies(deps, deviceToken, writeKeyPrefix, writeKey)
  for (const ref of refs) await deps.store.delete(ref)
  await deps.store.delete(apiKeyRef)
  if (input.readKey !== undefined) {
    await deps.store.set(apiKeyRef, input.readKey.trim())
    await deps.updateProfile(profile, { keyPrefix: apiKeyPrefix(input.readKey) })
  }
  return header
}

/**
 * Completes a move a crash interrupted (step 3 above), with no factor: the slot's clear header
 * names the Write key's prefix, which is enough to recognise a leftover plain copy. Returns the
 * refs it removed.
 */
export async function finishCoreMove(input: { deps: MoveDeps; paths: CorePaths; profile: string }): Promise<string[]> {
  const file = await readCoreSlotHeader(input.paths)
  if (file === undefined) return []
  const removed = await removeLegacyCopies(
    input.deps,
    await input.deps.store.get(profileSecretRef(input.profile, "deviceToken")),
    file.writeKeyPrefix,
  )
  for (const ref of await plainWriteRefs(input.deps, input.profile, file.writeKeyPrefix)) {
    if ((await input.deps.store.get(ref)) !== null) {
      await input.deps.store.delete(ref)
      removed.push(ref)
    }
  }
  const apiKeyRef = profileSecretRef(input.profile, "apiKey")
  const plainKey = await input.deps.store.get(apiKeyRef)
  if (plainKey !== null && file.writeKeyPrefix !== "" && apiKeyPrefix(plainKey) === file.writeKeyPrefix) {
    await input.deps.store.delete(apiKeyRef)
    removed.push(apiKeyRef)
  }
  return removed
}
