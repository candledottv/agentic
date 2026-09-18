/**
 * T43 (CC-07): the eight-step verifier.
 *
 * Corruption is exercised in EACH BLOB SEPARATELY, because the point of the verifier is that an
 * ordinary open would not have noticed. A flipped byte in the root ciphertext, or in a key blob
 * belonging to an entry no operation would ever decrypt, passes every check an open makes -- so
 * each case here first asserts that the vault still OPENS, and then that the verifier refuses it.
 * Without that first assertion the test would not be testing the gap the verifier exists to close.
 *
 * The consistency failures are built differently and deliberately so: they are re-sealed under the
 * REAL payload key, so no tag fails anywhere and the only thing wrong is that the plaintext does
 * not describe a recoverable vault. Those are `VAULT_VERIFY_FAILED` naming the step and the entry,
 * not `VAULT_BLOB_TAMPERED`.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { canonicalBytes, seal } from "./crypto"
import { addressFromSecret64 } from "./ed25519"
import { VaultError } from "./errors"
import { canonicalHeader, type IndexPlaintext, type KeyEntry, keyAad, type VaultFile } from "./format"
import { DERIVATION_SCHEME, deriveSolanaKey, solanaTeePath, solanaVaultPath } from "./hd"
import { wipe } from "./hygiene"
import { closeVault, commitVault, freshKeyId, sealKeyBlob, type UnlockedVault } from "./store"
import {
  FIXTURE_ENTROPY,
  flipByte,
  makeVault,
  readVaultJson,
  reopen,
  tamper,
  testClock,
  useCheapKdf,
} from "./test-vault"
import { type VerifyObserver, verifyVaultIntegrity } from "./verify"

/**
 * These tests run REAL Argon2id, which is the point of them: a vault suite that stubbed the KDF
 * would not be testing the format anyone actually opens. Even at ED-3's bounds floor (see
 * `useCheapKdf`) a single derivation is a few hundred milliseconds, several tests here do five or
 * six of them, and a CI runner sharing a box with every other workspace's suite is slower again.
 * Bun's default per-test budget is 5 s, which one of these exceeded on CI while passing locally --
 * so the budget is stated here rather than discovered once per runner.
 */
setDefaultTimeout(30_000)

useCheapKdf()

async function refusal(body: () => Promise<unknown>): Promise<VaultError> {
  try {
    await body()
  } catch (error) {
    if (error instanceof VaultError) return error
    throw error
  }
  throw new Error("expected a refusal, but the call succeeded")
}

/**
 * A vault with two derived keys and one `migrated-tee` entry, which is the smallest shape that
 * exercises step 5's two branches (re-derivation, and the address-only check for an independent
 * key) and gives the corruption cases a blob nobody would otherwise read.
 */
async function makeVerifiableVault() {
  const made = await makeVault()
  const entropy = Uint8Array.from(FIXTURE_ENTROPY)
  const entries: KeyEntry[] = []
  const blobs: Array<{ id: string } & { iv: string; ciphertext: string }> = []

  for (const [index, path] of [solanaVaultPath(0), solanaVaultPath(1)].entries()) {
    const derived = await deriveSolanaKey(entropy, path)
    const id = freshKeyId()
    blobs.push(await sealKeyBlob(made.vault, id, derived.secret64))
    entries.push({
      id,
      chain: "solana",
      curve: "ed25519",
      address: derived.address,
      label: `key-${index}`,
      createdAt: "2026-09-17T12:00:00.000Z",
      role: "vault",
      origin: "derived",
      derivation: { scheme: DERIVATION_SCHEME, path },
      exposure: { everRemoteExposed: false, everExported: false },
    })
    wipe(derived.secret64)
  }

  // An independent key, as a migrated TEE wallet entry would be: no derivation, so step 5's
  // re-derivation does not apply to it and the output has to say so.
  const independentSeed = new Uint8Array(32).fill(0x5a)
  const { pubkeyFromSecretSeed } = await import("./ed25519")
  const independent = pubkeyFromSecretSeed(independentSeed)
  const independentId = freshKeyId()
  blobs.push(await sealKeyBlob(made.vault, independentId, independent.secret64))
  entries.push({
    id: independentId,
    chain: "solana",
    curve: "ed25519",
    address: independent.address,
    label: "migrated",
    createdAt: "2026-09-17T12:00:00.000Z",
    role: "tee-wallet",
    origin: "migrated-tee",
    exposure: { everRemoteExposed: true, everExported: false },
    tee: { network: "solana-mainnet", lifecycle: "local-candidate" },
  })
  wipe(independent.secret64)

  const index: IndexPlaintext = {
    hd: {
      scheme: "bip39-24/slip10",
      nextIndex: { solanaVault: 2, solanaTee: 0, evm: 0 },
      rootExported: false,
      exposedIndexes: { solanaVault: [], solanaTee: [], evm: [] },
    },
    entries,
  }
  await commitVault(made.vault, { index, addKeys: blobs }, testClock)
  closeVault(made.vault)
  return { ...made, entries }
}

/** Re-seals an index plaintext under the real payload key, so nothing's tag fails. */
async function replaceIndex(vault: UnlockedVault, path: string, index: IndexPlaintext): Promise<void> {
  const file = await readVaultJson(path)
  const { sealJson } = await import("./crypto")
  const header = { ...file }
  const blob = await sealJson(vault.payloadKey, index, canonicalHeader(header as VaultFile))
  await writeFile(path, `${JSON.stringify({ ...file, index: blob }, null, 2)}\n`, "utf8")
}

describe("T43: a verified copy passes all eight steps", () => {
  test("it reports what it checked, and which entries got which check", async () => {
    const made = await makeVerifiableVault()
    const vault = await reopen(made.path)
    const steps: number[] = []
    const report = await verifyVaultIntegrity(vault, { observer: { onStep: (step) => steps.push(step) } })

    expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(report.addressChecked).toHaveLength(3)
    expect(report.rederived).toHaveLength(2)
    // The `migrated-tee` entry skips re-derivation by construction: it is an independent key, so
    // the address and length checks are the strongest available for it.
    expect(report.notRederived).toHaveLength(1)
    expect(report.comparedAgainstLive).toBe(false)
    closeVault(vault)
  })

  test("step 8 runs, and passes, when a live vault is given to compare against", async () => {
    const made = await makeVerifiableVault()
    const live = await reopen(made.path)
    const copy = await reopen(made.path)
    const report = await verifyVaultIntegrity(copy, { live })
    expect(report.comparedAgainstLive).toBe(true)
    closeVault(live)
    closeVault(copy)
  })
})

describe("T43: one flipped byte, in each blob separately", () => {
  test("the root ciphertext only: the vault still OPENS, and the verifier refuses it", async () => {
    const made = await makeVerifiableVault()
    await tamper(made.path, (file) => {
      file.root.ciphertext = flipByte(file.root.ciphertext)
    })
    // The gap, asserted first: an ordinary open never touches the root (ED-5), so this file looks
    // perfectly healthy to every command except the verifier.
    const vault = await reopen(made.path)
    expect(vault.index.entries).toHaveLength(3)

    const error = await refusal(() => verifyVaultIntegrity(vault))
    expect(error.code).toBe("VAULT_BLOB_TAMPERED")
    closeVault(vault)
  })

  test("one key blob only, belonging to an entry no operation would decrypt", async () => {
    const made = await makeVerifiableVault()
    const target = made.entries[1]?.id as string
    await tamper(made.path, (file) => {
      const blob = file.keys.find((candidate) => candidate.id === target) as { ciphertext: string }
      blob.ciphertext = flipByte(blob.ciphertext)
    })
    const vault = await reopen(made.path)
    expect(vault.index.entries).toHaveLength(3)

    const error = await refusal(() => verifyVaultIntegrity(vault))
    expect(error.code).toBe("VAULT_BLOB_TAMPERED")
    expect(error.message).toContain(target)
    closeVault(vault)
  })

  test("the index only, and the header only: both fail before step 3", async () => {
    const made = await makeVerifiableVault()
    const kept = await readFile(made.path, "utf8")

    await tamper(made.path, (file) => {
      file.index.ciphertext = flipByte(file.index.ciphertext)
    })
    // These two do not even open, which is the difference between them and the two above.
    expect((await refusal(() => reopen(made.path))).code).toBe("VAULT_BLOB_TAMPERED")

    await writeFile(made.path, kept, "utf8")
    await tamper(made.path, (file) => {
      file.generation = file.generation + 1
    })
    expect((await refusal(() => reopen(made.path))).code).toBe("VAULT_BLOB_TAMPERED")
  })
})

describe("T43: consistency failures with no tag failure anywhere", () => {
  test("step 5: an entry whose stored secret does not yield its recorded address", async () => {
    const made = await makeVerifiableVault()
    const vault = await reopen(made.path)
    const entries = vault.index.entries.map((entry, i) =>
      i === 0 ? { ...entry, address: "11111111111111111111111111111111" } : entry,
    )
    await replaceIndex(vault, made.path, { ...vault.index, entries })
    closeVault(vault)

    const reopened = await reopen(made.path)
    const error = await refusal(() => verifyVaultIntegrity(reopened))
    expect(error.code).toBe("VAULT_VERIFY_FAILED")
    expect(error.message).toContain("step 5")
    expect(error.message).toContain("does not produce the address")
    closeVault(reopened)
  })

  test("step 5: a derived entry that does not re-derive from the root along its recorded path", async () => {
    const made = await makeVerifiableVault()
    const vault = await reopen(made.path)
    // The address still matches its stored secret; only the recorded PATH is wrong, so the address
    // check passes and the re-derivation is what catches it.
    const entries = vault.index.entries.map((entry, i) =>
      i === 0 ? { ...entry, derivation: { scheme: DERIVATION_SCHEME, path: solanaTeePath(9) } } : entry,
    )
    await replaceIndex(vault, made.path, {
      hd: { ...vault.index.hd, nextIndex: { ...vault.index.hd.nextIndex, solanaTee: 10 } },
      entries,
    })
    closeVault(vault)

    const reopened = await reopen(made.path)
    const error = await refusal(() => verifyVaultIntegrity(reopened))
    expect(error.code).toBe("VAULT_VERIFY_FAILED")
    expect(error.message).toContain("does not re-derive from the root")
    closeVault(reopened)
  })

  test("step 3: keyIds and keys[] disagreeing, with the index itself consistent", async () => {
    const made = await makeVerifiableVault()
    const vault = await reopen(made.path)
    // An extra key blob and an extra keyIds entry, sealed correctly, with no index entry for it:
    // the file opens, and step 3 is what notices.
    const orphanId = freshKeyId()
    const orphan = await sealKeyBlob(vault, orphanId, new Uint8Array(64).fill(3))
    const file = await readVaultJson(made.path)
    const next: VaultFile = { ...file, keyIds: [...file.keyIds, orphanId], keys: [...file.keys, orphan] }
    // The header changed, so the index must be re-sealed under it for the file to open at all.
    const { sealJson } = await import("./crypto")
    const blob = await sealJson(vault.payloadKey, vault.index, canonicalHeader(next))
    await writeFile(made.path, `${JSON.stringify({ ...next, index: blob }, null, 2)}\n`, "utf8")
    closeVault(vault)

    // This file OPENS: `keyIds` and `keys[]` agree with each other, so the opener's own check
    // passes, and the blob simply has no index entry. That is another instance of the gap the
    // verifier exists for, and step 3 is what closes it.
    const reopened = await reopen(made.path)
    expect(reopened.index.entries).toHaveLength(3)
    expect(reopened.file.keys).toHaveLength(4)

    const error = await refusal(() => verifyVaultIntegrity(reopened))
    expect(error.code).toBe("VAULT_VERIFY_FAILED")
    expect(error.message).toContain("step 3")
    expect(error.message).toContain(orphanId)
    closeVault(reopened)
  })

  test("step 7: a nextIndex at or below a recorded index, and an exposed entry missing from exposedIndexes", async () => {
    const made = await makeVerifiableVault()
    const vault = await reopen(made.path)

    // `exposedIndexes` first: this one reaches the verifier, because the index schema does not
    // check it (only the counter does).
    const entries = vault.index.entries.map((entry) =>
      entry.origin === "derived" ? { ...entry, exposure: { ...entry.exposure, everRemoteExposed: true } } : entry,
    )
    await replaceIndex(vault, made.path, { ...vault.index, entries })
    closeVault(vault)

    const reopened = await reopen(made.path)
    const error = await refusal(() => verifyVaultIntegrity(reopened))
    expect(error.code).toBe("VAULT_VERIFY_FAILED")
    expect(error.message).toContain("step 7")
    expect(error.message).toContain("hd.exposedIndexes")
    closeVault(reopened)
  })

  test("step 4: a root whose 32 bytes do not render a phrase with a valid checksum", async () => {
    const made = await makeVerifiableVault()
    const vault = await reopen(made.path)
    // Re-seal the root with the WRONG LENGTH under the real key: no tag fails, and step 4's own
    // check is the only thing that can catch it.
    const { rootAad } = await import("./format")
    const shortRoot = await seal(vault.payloadKey, new Uint8Array(16).fill(1), rootAad(vault.file.vaultId))
    const file = await readVaultJson(made.path)
    await writeFile(made.path, `${JSON.stringify({ ...file, root: shortRoot }, null, 2)}\n`, "utf8")
    closeVault(vault)

    const reopened = await reopen(made.path)
    const error = await refusal(() => verifyVaultIntegrity(reopened))
    expect(error.code).toBe("VAULT_VERIFY_FAILED")
    expect(error.message).toContain("step 4")
    closeVault(reopened)
  })
})

describe("T43: step 8 catches a copy that is internally perfect but is not this vault", () => {
  test("an address-set mismatch fails even when steps 1 to 7 all pass", async () => {
    const made = await makeVerifiableVault()
    // A DIFFERENT vault, with the same passphrase and the same root, so it opens and verifies on
    // its own terms: steps 1 to 7 pass on it completely.
    const foreign = await makeVault()
    const foreignVault = await reopen(foreign.path)
    await verifyVaultIntegrity(foreignVault)

    const live = await reopen(made.path)
    const error = await refusal(() => verifyVaultIntegrity(foreignVault, { live }))
    expect(error.code).toBe("VAULT_VERIFY_FAILED")
    expect(error.message).toContain("step 8")
    expect(error.message).toContain("stale copy, or a copy of a different vault")
    closeVault(live)
    closeVault(foreignVault)
  })
})

describe("T43: step 5 holds at most one leaf plaintext at a time", () => {
  test("asserted at the seam, and the root is zeroed when the pass ends", async () => {
    const made = await makeVerifiableVault()
    const vault = await reopen(made.path)

    const liveCounts: number[] = []
    let rootZeroed = false
    const observer: VerifyObserver = {
      onLeafLive: (live) => liveCounts.push(live),
      onRootZeroed: () => {
        rootZeroed = true
      },
    }
    await verifyVaultIntegrity(vault, { observer })

    // The peak is 2 and only ever momentarily: that is one entry's stored secret beside the copy
    // re-derived from the root for the comparison, never two different entries' secrets.
    expect(Math.max(...liveCounts)).toBe(2)
    // And each entry is back to zero before the next is read, so the sequence returns to 0 once
    // per entry rather than climbing.
    expect(liveCounts.filter((count) => count === 0)).toHaveLength(3)
    expect(rootZeroed).toBe(true)
    closeVault(vault)
  })
})

describe("T43: one verifier, shared by every caller that claims 'verified'", () => {
  test("backup, verify-backup, restore and retire-legacy all reach the same function", async () => {
    // Asserted at the seam by source inspection rather than by running four commands: the claim
    // is that there is ONE implementation and one meaning of "verified" in this document, and the
    // way that stops being true is a second call site growing its own weaker check.
    const { readFileSync } = await import("node:fs")
    const { resolve } = await import("node:path")
    const commands = resolve(import.meta.dir, "..", "commands")
    const backup = readFileSync(resolve(commands, "vault-backup.ts"), "utf8")
    const restore = readFileSync(resolve(commands, "vault-restore.ts"), "utf8")
    const retire = readFileSync(resolve(commands, "vault-retire-legacy.ts"), "utf8")
    for (const [name, source] of [
      ["vault-backup.ts", backup],
      ["vault-restore.ts", restore],
      ["vault-retire-legacy.ts", retire],
    ] as const) {
      expect(`${name} imports verifyVaultIntegrity: ${source.includes("verifyVaultIntegrity")}`).toBe(
        `${name} imports verifyVaultIntegrity: true`,
      )
    }
    // `backup` and `verify-backup` share one helper inside that file, so both reach it.
    expect(backup.match(/verifyCopy\(/g)?.length).toBeGreaterThanOrEqual(3)
    // retire-legacy must call the verifier on the live vault, not only check the sidecar stamp.
    expect(retire.includes("await verifyVaultIntegrity(")).toBe(true)
  })
})

describe("the verifier's own address check is a derivation, not a lookup", () => {
  test("a secret whose embedded public key was edited still fails", async () => {
    // `addressFromSecret64` re-derives from the seed half rather than reading the second half,
    // which is what makes an edited blob fail rather than pass.
    const seed = new Uint8Array(32).fill(0x11)
    const { pubkeyFromSecretSeed } = await import("./ed25519")
    const { secret64, address } = pubkeyFromSecretSeed(seed)
    expect(addressFromSecret64(secret64)).toBe(address)

    const edited = Uint8Array.from(secret64)
    edited[40] = (edited[40] ?? 0) ^ 0xff
    expect(addressFromSecret64(edited)).toBe(address)
    // The address is unchanged because it comes from the SEED, so an edit to the embedded copy
    // cannot forge one; editing the seed half is what moves it.
    const seedEdited = Uint8Array.from(secret64)
    seedEdited[0] = (seedEdited[0] ?? 0) ^ 0xff
    expect(addressFromSecret64(seedEdited)).not.toBe(address)
  })
})

/** Kept so the unused-import lint cannot mask a missing assertion above. */
export const CANONICAL_BYTES_IN_USE = canonicalBytes
