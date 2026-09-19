/**
 * Ember Phase 2 (BE-136, CC-03 invariant 1, CC-11): building a brand-new vault.
 *
 * Shared by `vault init` and `vault restore --phrase`, because invariant 1 is enforced BY SEQUENCE
 * and the sequence is the same in both: write the passphrase envelope and the root blob, re-open
 * the file with that passphrase, decrypt the index (which authenticates the header) and the root,
 * and only THEN report success. A crash after the write and before the verify leaves a file the
 * next `init` refuses to overwrite rather than a vault whose only factor was never proven to work.
 *
 * No key is created here. `init` creates none at all, and restore derives its keys afterwards
 * through the ordinary write path, so that "a recoverable factor exists before any key is created"
 * is true of the file on disk and not only of the code's intentions.
 */
import type { Deps } from "../deps"
import { type Blob, derivePayloadKey, freshArgon2Params, seal, unb64u } from "./crypto"
import { VaultError } from "./errors"
import {
  type Envelope,
  type HdRecord,
  type IndexPlaintext,
  indexRequiresVersion3,
  LEGACY_VAULT_VERSION,
  type PassphraseEnvelope,
  type PassphraseStrength,
  rootAad,
  VAULT_CIPHER,
  VAULT_FORMAT,
  VAULT_VERSION,
  type VaultFile,
} from "./format"
import { withSecret } from "./hygiene"
import { nextSidecar, readSidecar, sidecarPath, writeSidecar } from "./sidecar"
import {
  fileExists,
  freshDek,
  freshEnvelopeId,
  freshVaultId,
  readVaultRaw,
  sealIndex,
  serializeVault,
  type UnlockedVault,
  unlockWithPassphrase,
  wrapDekForPassphrase,
  writeNewVault,
} from "./store"

/** The `hd` record a fresh vault starts with: nothing derived, nothing exported, nothing exposed. */
export function freshHdRecord(patch: Partial<HdRecord> = {}): HdRecord {
  return {
    scheme: "bip39-24/slip10",
    nextIndex: { solanaVault: 0, solanaTee: 0, solanaExternal: 0, evm: 0 },
    rootExported: false,
    exposedIndexes: { solanaVault: [], solanaTee: [], solanaExternal: [], evm: [] },
    ...patch,
  }
}

export interface CreateVaultRequest {
  path: string
  passphrase: string
  strength: PassphraseStrength
  /** The 32 bytes of BIP-39 entropy this vault's root holds. The caller owns and zeroes it. */
  rootEntropy: Uint8Array
  label?: string
  /** Restore seeds the `hd` record with its discovery record; `init` passes nothing. */
  hd?: HdRecord
  notice?: (line: string) => void
}

/**
 * Creates the file and returns it OPENED, having re-read it from disk and decrypted its index with
 * the passphrase that was just set. The caller closes it.
 */
export async function createVault(request: CreateVaultRequest, clock: Pick<Deps, "now">): Promise<UnlockedVault> {
  if (await fileExists(request.path)) {
    throw new VaultError("VAULT_EXISTS", `A vault already exists at ${request.path}.`, {
      suggestion: "This CLI never overwrites one. Move it aside first if you really mean to start over.",
    })
  }

  const vaultId = freshVaultId()
  const createdAt = new Date(clock.now()).toISOString()
  const envelope: PassphraseEnvelope = {
    id: freshEnvelopeId(),
    factor: "passphrase",
    domain: "human-memory",
    label: request.label ?? "passphrase",
    createdAt,
    kdf: freshArgon2Params(),
    strength: request.strength,
    // Filled in below, once the DEK exists to wrap.
    wrap: { alg: VAULT_CIPHER, iv: "", ciphertext: "" },
  }

  const dek = freshDek()
  const file = await withSecret(dek, async (dekBytes) => {
    const wrap = await wrapDekForPassphrase(
      dekBytes,
      request.passphrase,
      envelope as unknown as Envelope,
      { vaultId },
      request.notice,
    )
    const sealedEnvelope: Envelope = { ...(envelope as unknown as Envelope), wrap }
    const payloadKey = await derivePayloadKey(dekBytes, unb64u(vaultId, "vaultId"))
    const root: Blob = await seal(payloadKey, request.rootEntropy, rootAad(vaultId))
    const index: IndexPlaintext = { hd: request.hd ?? freshHdRecord(), entries: [] }
    // R6: a new vault is written as version 2 unless its index already needs the external branch
    // (a restore bounded on it). `init` therefore still writes a file a 0.10.x CLI opens; the
    // version moves to 3 on the first write that allocates or recovers an external key.
    const header: Omit<VaultFile, "index"> = {
      format: VAULT_FORMAT,
      version: indexRequiresVersion3(index) ? VAULT_VERSION : LEGACY_VAULT_VERSION,
      vaultId,
      generation: 1,
      createdAt,
      updatedAt: createdAt,
      cipher: VAULT_CIPHER,
      envelopes: [sealedEnvelope],
      keyIds: [],
      root,
      keys: [],
    }
    return sealIndex(header, index, payloadKey)
  })

  await writeNewVault(request.path, serializeVault(file))

  // The sidecar is written HERE, at creation, and not left to the first later write. ED-6's
  // whole-file rollback check compares a copy's generation against the last one this machine saw,
  // so a vault whose sidecar only appeared at its second write would have a window -- between
  // `init` and the first key -- in which restoring an older copy of it went unnoticed. Best
  // effort, as the sidecar always is: a failure to write it must not fail the creation of a vault
  // that is otherwise complete and verified.
  const path = sidecarPath(request.path)
  await writeSidecar(path, nextSidecar(await readSidecar(path), file)).catch(() => {})

  // Invariant 1's verification step: re-READ the file rather than trusting the object just built,
  // so what is proven to open is the bytes on disk.
  const raw = await readVaultRaw(request.path)
  if (raw === null) {
    throw new VaultError("VAULT_WRITE_FAILED", `The vault was written to ${request.path} but could not be read back.`)
  }
  return unlockWithPassphrase(request.path, raw, request.passphrase, { notice: request.notice })
}
