/**
 * Ember Phase 2 (BE-136, ED-6, N2): the cleartext sidecar `vault.state.json`.
 *
 * What it is for, precisely, because it is easy to over-read. ED-6 distinguishes two rollback
 * shapes. A MIXED file (the current header with an index blob from another write of the same
 * vault) fails the index's AEAD tag by construction and needs no sidecar at all. A WHOLE-FILE
 * rollback (header and index together from an older write) is internally consistent and cannot be
 * detected from the file alone, so this records the last generation and envelope ids this machine
 * saw, and opening a copy with a lower generation is refused unless `--accept-older-copy` is
 * passed. That detects an ACCIDENTAL restore of an old backup. It is not a defense against a
 * same-user attacker, who can edit this file, and the documentation and the tests both say so.
 *
 * N2: it contains NO ADDRESS, no label and no derivation path, in any field. An earlier draft
 * recorded migration sources by address, which put on disk in cleartext exactly the linkage the
 * vault exists to keep encrypted. `sourceDigest` is `SHA-256(vaultId || source file bytes)`, which
 * is enough to recognize a repeated migration of the same file before unlock; idempotency BY
 * ADDRESS is decided inside the opened vault, where the addresses already are.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { sha256 } from "@noble/hashes/sha256"
import { b64u } from "./crypto"

export interface VaultSidecar {
  vaultId: string
  lastGeneration: number
  envelopeIds: string[]
  /** What lets `status` name the envelopes older copies may still open with (N1). */
  removedEnvelopeIds: string[]
  lastVerifiedBackupAt?: string
  lastBackupDomain?: string
  lastBackupSharedDomainAccepted?: boolean
  migratedFrom?: Array<{ path: string; at: string; sourceDigest: string }>
}

export function sidecarPath(vaultPath: string): string {
  return vaultPath.replace(/\.enc$/, "") + ".state.json"
}

/** `SHA-256(vaultId || bytes)`, base64url. Recognizes a repeated migration; names no address. */
export function sourceDigest(vaultId: string, bytes: Uint8Array): string {
  const id = new TextEncoder().encode(vaultId)
  const joined = new Uint8Array(id.length + bytes.length)
  joined.set(id, 0)
  joined.set(bytes, id.length)
  return b64u(sha256(joined))
}

/**
 * Reads the sidecar. A missing or unreadable one is `null`, never a refusal: ED-6 makes its
 * absence a warning, because a vault copied to a new machine legitimately arrives without one and
 * refusing there would turn a recovery into a dead end.
 */
export async function readSidecar(path: string): Promise<VaultSidecar | null> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as VaultSidecar
    if (typeof parsed?.vaultId !== "string" || !Number.isInteger(parsed?.lastGeneration)) return null
    return {
      ...parsed,
      envelopeIds: Array.isArray(parsed.envelopeIds) ? parsed.envelopeIds : [],
      removedEnvelopeIds: Array.isArray(parsed.removedEnvelopeIds) ? parsed.removedEnvelopeIds : [],
    }
  } catch {
    return null
  }
}

/** Writes the sidecar 0600 in a 0700 directory. Best effort: a failure here never fails a command. */
export async function writeSidecar(path: string, state: VaultSidecar): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  await chmod(dir, 0o700).catch(() => {})
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  await chmod(path, 0o600).catch(() => {})
}

/**
 * The sidecar that describes `file` after a write. `previous` carries forward the bookkeeping this
 * write does not change, and `removedEnvelopeIds` only ever grows: an envelope this machine has
 * seen and no longer sees is one older copies may still open with, and forgetting that is exactly
 * the thing N1 asks `status` to be able to say.
 */
export function nextSidecar(
  previous: VaultSidecar | null,
  file: { vaultId: string; generation: number; envelopes: Array<{ id: string }> },
  patch: Partial<VaultSidecar> = {},
): VaultSidecar {
  const currentIds = file.envelopes.map((envelope) => envelope.id)
  const known = previous?.envelopeIds ?? []
  const removed = new Set(previous?.removedEnvelopeIds ?? [])
  for (const id of known) if (!currentIds.includes(id)) removed.add(id)
  return {
    ...(previous ?? {}),
    vaultId: file.vaultId,
    lastGeneration: file.generation,
    envelopeIds: currentIds,
    removedEnvelopeIds: [...removed].sort(),
    ...patch,
  }
}
