/**
 * Ember Phase 4b (D1, Andrew 2026-09-25): the sealed EVM record, `<vault path minus .enc>.evm-record.sealed`.
 *
 * Why a file of its own. The index is encrypted under the data key, which only a factor unwraps,
 * and an agent trades with the vault locked, so a trade cannot write to the index. A plaintext file
 * would list this machine's wallet addresses in the clear (the link the encrypted index exists to
 * hide), and `vault backup` would not carry it. So each line is sealed to the header's record public
 * key (`evm-record-key.ts`), appended without an unlock, and read only by an unlocked vault.
 *
 * The file is append-only, one line per entry, every line the same length. Appends take the record
 * lock (ED-8's advisory lock directory on the RECORD path, not the vault's), and, under it, repair a
 * torn tail before writing: a partial last line never decrypts, so dropping it loses no readable
 * entry, and the new line is never glued onto it.
 *
 * Entries are hints, not authority. Anyone who can write the disk can append a line that decrypts
 * (the public key is in the clear); a forged `scanStart` can force an early scan, a forged token adds
 * a balance read. A lost record loses the hint, never the funds.
 */
import { appendFile, readFile, rename, stat, truncate } from "node:fs/promises"
import type { Deps } from "../deps"
import { KeystoreLockedError, withKeystoreLock, writeKeystoreFile } from "../wallet-keystore"
import { VaultError } from "./errors"
import { type EvmRecordEntry, openEvmRecordKey, openEvmRecordLine, sealEvmRecordLine } from "./evm-record-key"
import { EVM_TEE_VAULT_VERSION, parseVaultFile } from "./format"
import { wipe } from "./hygiene"
// Type-only: `store.ts` imports this file at runtime (the record key is created by its write path).
import type { UnlockedVault } from "./store"

export type { EvmRecordEntry } from "./evm-record-key"

type Clock = Pick<Deps, "now" | "sleep">

/** D1: strip a trailing `.enc`, then add `.evm-record.sealed`, the rule `sidecarPath` follows. */
export function evmRecordPath(vaultPath: string): string {
  return `${vaultPath.replace(/\.enc$/, "")}.evm-record.sealed`
}

/** `20260925T173000Z`: the UTC stamp an orphaned record is renamed with. */
export function utcStamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")
}

async function readIfPresent(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null
    throw error
  }
}

/** Complete lines (no newline) and whether a partial last line follows them. */
export function splitRecord(bytes: Uint8Array): { lines: string[]; partialTail: boolean } {
  const text = new TextDecoder().decode(bytes)
  if (text.length === 0) return { lines: [], partialTail: false }
  const pieces = text.split("\n")
  const last = pieces.pop() as string
  return { lines: pieces.filter((line) => line.length > 0), partialTail: last.length > 0 }
}

// ── Appending (no unlock) ─────────────────────────────────────────────────────────────────────

export type AppendOutcome =
  | { written: true; repairedPartial: boolean; path: string }
  | {
      written: false
      reason: "no-vault" | "no-record-key" | "header-unreadable" | "too-long" | "locked" | "write-failed"
      detail: string
      path: string
    }

/**
 * Appends one sealed entry beside the vault at `vaultPath`. Reads the header only (never the index,
 * never a factor), so a landed trade leg appends with the vault locked. Never throws: every reason
 * an append cannot run comes back as `written: false` with the reason, and the caller prints the
 * notice (`appendNotice`) and carries on. `lockWaitMs` defaults to the keystore lock's full window.
 */
export async function appendEvmRecordEntry(input: {
  vaultPath: string
  entry: EvmRecordEntry
  clock: Clock
  lockWaitMs?: number
}): Promise<AppendOutcome> {
  const path = evmRecordPath(input.vaultPath)
  let raw: string | null
  try {
    const bytes = await readIfPresent(input.vaultPath)
    raw = bytes === null ? null : bytes.toString("utf8")
  } catch (error) {
    return { written: false, reason: "header-unreadable", detail: messageOf(error), path }
  }
  if (raw === null) return { written: false, reason: "no-vault", detail: `no vault at ${input.vaultPath}`, path }
  let publicKey: string | undefined
  let vaultId: string
  try {
    const header = parseVaultFile(raw)
    vaultId = header.vaultId
    publicKey = header.version === EVM_TEE_VAULT_VERSION ? header.evmRecordPublicKey : undefined
  } catch (error) {
    return { written: false, reason: "header-unreadable", detail: messageOf(error), path }
  }
  if (publicKey === undefined) {
    return {
      written: false,
      reason: "no-record-key",
      detail: "the vault is not version 4, so it has no sealed EVM record key",
      path,
    }
  }
  let line: string
  try {
    line = await sealEvmRecordLine(input.entry, publicKey, vaultId)
  } catch (error) {
    const tooLong = error instanceof VaultError && error.code === "EVM_RECORD_ENTRY_TOO_LONG"
    return { written: false, reason: tooLong ? "too-long" : "write-failed", detail: messageOf(error), path }
  }
  try {
    const repairedPartial = await withKeystoreLock(
      path,
      input.clock,
      async () => {
        const repaired = await repairTail(path)
        await appendFile(path, line, { encoding: "utf8", mode: 0o600 })
        return repaired
      },
      input.lockWaitMs !== undefined ? { waitMs: input.lockWaitMs } : {},
    )
    return { written: true, repairedPartial, path }
  } catch (error) {
    if (error instanceof KeystoreLockedError) {
      return { written: false, reason: "locked", detail: error.message, path }
    }
    return { written: false, reason: "write-failed", detail: messageOf(error), path }
  }
}

/**
 * D1 "Repair at append time": under the record lock, a file that does not end in a newline is
 * truncated back to the byte after its last newline (or to empty). Returns whether it did.
 */
async function repairTail(path: string): Promise<boolean> {
  const bytes = await readIfPresent(path)
  if (bytes === null || bytes.length === 0 || bytes[bytes.length - 1] === 0x0a) return false
  const lastNewline = bytes.lastIndexOf(0x0a)
  await truncate(path, lastNewline + 1)
  return true
}

/** The one line a skipped or repaired append prints. Undefined when there is nothing to say. */
export function appendNotice(outcome: AppendOutcome, what: string): string | undefined {
  if (outcome.written) {
    return outcome.repairedPartial
      ? `The sealed EVM record at ${outcome.path} ended in a partial line (a torn earlier append); it was dropped before ${what} was added.`
      : undefined
  }
  return `${what} was not added to the sealed EVM record (${outcome.detail}). A sweep can still find it with --token or --from-block.`
}

// ── Reading (vault open) ──────────────────────────────────────────────────────────────────────

export interface EvmRecordRead {
  path: string
  /** No file at the record path (or an empty one): not an error for a sweep (D1). */
  absent: boolean
  /** The vault has no record key (not version 4), so no line can be read. */
  noKey: boolean
  entries: EvmRecordEntry[]
  /** Complete lines that did not decrypt under this vault's record key. */
  unreadableLines: number
  /** Whether the file ends in a partial line. */
  partialTail: boolean
}

/** Opens the index's record key and checks it against the header. The caller zeroes it. */
export async function openVaultRecordKey(vault: UnlockedVault): Promise<Uint8Array | undefined> {
  const blob = vault.index.evmRecordKey
  const publicKey = vault.file.evmRecordPublicKey
  if (blob === undefined || publicKey === undefined) return undefined
  return openEvmRecordKey(vault.payloadKey, vault.file.vaultId, blob, publicKey)
}

/**
 * Decrypts every complete line, deduped in order, and counts what did not decrypt. Never stops on a
 * bad line: the sweep reports those as unreadable and runs its other sources (D1).
 */
export async function readEvmRecord(vault: UnlockedVault, path = evmRecordPath(vault.path)): Promise<EvmRecordRead> {
  const bytes = await readIfPresent(path)
  const base = { path, entries: [] as EvmRecordEntry[], unreadableLines: 0, partialTail: false }
  const secret = await openVaultRecordKey(vault)
  if (secret === undefined) return { ...base, absent: bytes === null || bytes.length === 0, noKey: true }
  try {
    if (bytes === null || bytes.length === 0) return { ...base, absent: true, noKey: false }
    const { lines, partialTail } = splitRecord(bytes)
    const seen = new Set<string>()
    const entries: EvmRecordEntry[] = []
    let unreadable = 0
    for (const line of lines) {
      const entry = await openEvmRecordLine(line, secret, vault.file.evmRecordPublicKey as string, vault.file.vaultId)
      if (entry === undefined) {
        unreadable += 1
        continue
      }
      const key = JSON.stringify(entry).toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      entries.push(entry)
    }
    return { path, absent: false, noKey: false, entries, unreadableLines: unreadable, partialTail }
  } finally {
    wipe(secret)
  }
}

// ── Backup and verify-backup (D1 fix (a), the ninth check) ────────────────────────────────────

export interface RecordCopyOutcome {
  /** Whether the live record existed; when it did not, no copy file was written. */
  present: boolean
  copied: number
  dropped: number
  copyPath: string
}

/**
 * `vault backup`: under the live record's lock, copies byte for byte and in order only the complete
 * lines that decrypt under the live vault's record key, dropping a partial last line and any line
 * that does not decrypt. Never rewrites the live record. A lock that cannot be taken fails the
 * backup (`EVM_RECORD_UNAVAILABLE`), so no verified backup is recorded without its record.
 */
export async function copyEvmRecordForBackup(
  live: UnlockedVault,
  copyPath: string,
  clock: Clock,
): Promise<RecordCopyOutcome> {
  const livePath = evmRecordPath(live.path)
  try {
    return await withKeystoreLock(livePath, clock, async () => {
      const bytes = await readIfPresent(livePath)
      if (bytes === null) return { present: false, copied: 0, dropped: 0, copyPath }
      const secret = await openVaultRecordKey(live)
      const kept: string[] = []
      let dropped = 0
      const { lines, partialTail } = splitRecord(bytes)
      if (partialTail) dropped += 1
      try {
        for (const line of lines) {
          const entry =
            secret === undefined
              ? undefined
              : await openEvmRecordLine(line, secret, live.file.evmRecordPublicKey as string, live.file.vaultId)
          if (entry === undefined) dropped += 1
          else kept.push(`${line}\n`)
        }
      } finally {
        if (secret !== undefined) wipe(secret)
      }
      await writeKeystoreFile(copyPath, kept.join(""))
      return { present: true, copied: kept.length, dropped, copyPath }
    })
  } catch (error) {
    if (error instanceof KeystoreLockedError) {
      throw new VaultError(
        "EVM_RECORD_UNAVAILABLE",
        `Could not take the sealed EVM record's lock at ${livePath}.lock, so the backup was not completed and no verified backup was recorded.`,
        { suggestion: "Wait for the trade or sweep holding it to finish, then run the backup again." },
      )
    }
    if (error instanceof VaultError) throw error
    throw new VaultError(
      "VAULT_WRITE_FAILED",
      `Could not copy the sealed EVM record to ${copyPath}: ${messageOf(error)}`,
    )
  }
}

export interface RecordVerifyOutcome {
  /** Not a version 4 copy: the ninth check has nothing to check. */
  notApplicable: boolean
  absent: boolean
  lines: number
  path: string
}

/**
 * The ninth check (`verify-backup`): every complete line of the copy's record decrypts under the
 * copy's own record key. A version 4 copy with no record file passes and says so. A partial last
 * line, or a complete line that does not decrypt, fails: the sweep forgives those, this check does
 * not, because a backup is being called intact.
 */
export async function verifyEvmRecordCopy(
  copy: UnlockedVault,
  path = evmRecordPath(copy.path),
): Promise<RecordVerifyOutcome> {
  if (copy.file.version !== EVM_TEE_VAULT_VERSION) return { notApplicable: true, absent: true, lines: 0, path }
  const bytes = await readIfPresent(path)
  if (bytes === null) return { notApplicable: false, absent: true, lines: 0, path }
  const { lines, partialTail } = splitRecord(bytes)
  if (partialTail) {
    throw verifyFailed(`the sealed EVM record at ${path} ends in a partial line`)
  }
  const secret = await openVaultRecordKey(copy)
  if (secret === undefined) throw verifyFailed("the copy has no sealed EVM record key")
  try {
    for (const [index, line] of lines.entries()) {
      const entry = await openEvmRecordLine(line, secret, copy.file.evmRecordPublicKey as string, copy.file.vaultId)
      if (entry === undefined) {
        throw verifyFailed(
          `line ${index + 1} of the sealed EVM record at ${path} does not decrypt under this copy's key`,
        )
      }
    }
  } finally {
    wipe(secret)
  }
  return { notApplicable: false, absent: false, lines: lines.length, path }
}

function verifyFailed(message: string): VaultError {
  return new VaultError("VAULT_VERIFY_FAILED", `Verification failed at step 9: ${message}.`, {
    suggestion:
      "The copy's record changed after it was written. Run `candle vault backup` again; a fresh backup of the same vault copies only the lines that decrypt.",
    details: { step: "9" },
  })
}

// ── A record left by an earlier vault ─────────────────────────────────────────────────────────

/**
 * D1: the write that creates the record key checks for an existing file at the record path first.
 * No line in it can be sealed to a key that did not exist yet, so it belongs to an earlier vault at
 * this path. Under the record lock it is renamed to `<record path>.orphaned-<UTC timestamp>`, never
 * deleted. Returns the new path, or undefined when there was nothing to move.
 */
export async function moveAsideOrphanRecord(vaultPath: string, clock: Clock): Promise<string | undefined> {
  const path = evmRecordPath(vaultPath)
  // Nothing to move is the common case, and it takes no lock: a stale record lock with no record
  // behind it must not stop the write that creates the key.
  if (!(await exists(path))) return undefined
  return withKeystoreLock(path, clock, async () => {
    if (!(await exists(path))) return undefined
    let target = `${path}.orphaned-${utcStamp(clock.now())}`
    for (let n = 2; await exists(target); n++) target = `${path}.orphaned-${utcStamp(clock.now())}-${n}`
    await rename(path, target)
    return target
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
