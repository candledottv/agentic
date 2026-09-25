/**
 * Ember Phase 2 (BE-136, CC-07): `verifyVaultIntegrity`, the one shared verifier, and nothing
 * weaker.
 *
 * The reason it exists, stated once here because it is the whole argument: OPENING a vault
 * authenticates the header and the index and NOTHING ELSE (CC-01). An ordinary open never touches
 * the root blob and never touches a key blob it does not need. So an address comparison between a
 * copy and the live vault can pass while the copy's root ciphertext is corrupt and every future
 * derivation from it fails, or while one key blob nobody has asked for yet is unrecoverable. The
 * copy would report "verified" and be worthless in exactly the moment it was needed.
 *
 * Hence eight steps, in order, stopping at the first failure. `backup`, `verify-backup`,
 * `retire-legacy` (PR B) and `restore --phrase` all call THIS function, so there is one
 * implementation and one meaning of "verified" in the whole document; a test asserts that at the
 * seam so the callers cannot drift.
 *
 * Step 5's discipline is the cost control. The verifier visits every secret, which is the one
 * place in this design that does, so it holds EXACTLY ONE leaf plaintext at a time and zeroes it
 * before reading the next. The root is the unavoidable exception, since re-derivation needs it,
 * and step 6 zeroes it the moment the pass ends.
 */

import { evmAddressFromSecret, sameEvmAddress } from "../evm-lite"
import { bytesEqual } from "./crypto"
import { addressFromSecret64, SECP256K1_SCALAR_BYTES, SOLANA_SECRET_BYTES } from "./ed25519"
import { VaultError } from "./errors"
import { branchOfPath, exposedIndexesOf, type KeyEntry, nextIndexOf } from "./format"
import {
  deriveEvmKeyFromRoot,
  deriveEvmTeeKeyFromRoot,
  deriveSolanaKey,
  evmIndexOfPath,
  evmTeeIndexOfPath,
  isValidPhrase,
  phraseFromEntropy,
  ROOT_ENTROPY_BYTES,
} from "./hd"
import { wipe } from "./hygiene"
import { decryptKey, decryptRoot, type UnlockedVault } from "./store"

export type VerifyStep = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

export interface VerifyReport {
  /** Entries whose stored secret was checked against its recorded address (every entry). */
  addressChecked: string[]
  /** Derived entries that were also re-derived from the root along their recorded path. */
  rederived: string[]
  /** `migrated-tee` entries, which skip re-derivation by construction; named in the output. */
  notRederived: string[]
  /** Whether step 8 ran, which it does only for `backup` and `verify-backup`. */
  comparedAgainstLive: boolean
}

/**
 * A seam the tests use to assert step 5's one-at-a-time rule at the boundary rather than by
 * reading the implementation: it is called with the number of leaf plaintexts live at that instant,
 * which must never exceed one.
 */
export interface VerifyObserver {
  onLeafLive?: (live: number) => void
  onRootZeroed?: () => void
  onStep?: (step: VerifyStep) => void
}

function fail(step: VerifyStep, message: string, entry?: string): never {
  throw new VaultError(
    "VAULT_VERIFY_FAILED",
    `Verification failed at step ${step}${entry ? ` on entry ${entry}` : ""}: ${message}`,
    {
      suggestion: "Nothing was recorded and the file was left in place for inspection.",
    },
  )
}

/**
 * Runs all eight steps against `copy`. `live` is the vault this copy is supposed to be a copy OF;
 * pass it for `backup` and `verify-backup` (step 8) and omit it for `restore`, which has no
 * earlier vault to compare against.
 *
 * Steps 1 and 2 have already happened by the time this is called: unwrapping the DEK from an
 * envelope and decrypting the index IS how an `UnlockedVault` comes into existence, and doing them
 * again here would be a second Argon2 pass that proves the same thing. The report says so, and the
 * observer is notified for both so a test can still assert the order.
 */
export async function verifyVaultIntegrity(
  copy: UnlockedVault,
  opts: { live?: UnlockedVault; observer?: VerifyObserver } = {},
): Promise<VerifyReport> {
  const observer = opts.observer
  observer?.onStep?.(1)
  observer?.onStep?.(2)

  // Step 3: `keyIds` and the ids in `keys[]` are the same set. `unlockVault` already asserts this,
  // and it is repeated here because the verifier's contract is the eight steps, not "whatever the
  // opener happened to check".
  observer?.onStep?.(3)
  const declared = new Set(copy.file.keyIds)
  const present = new Set(copy.file.keys.map((blob) => blob.id))
  if (declared.size !== present.size || [...declared].some((id) => !present.has(id))) {
    fail(3, "the vault's keyIds and its key blobs are not the same set")
  }
  const indexed = new Set(copy.index.entries.map((entry) => entry.id))
  for (const id of declared) {
    if (!indexed.has(id)) fail(3, `key ${id} has a blob and a keyIds entry but no index entry`)
  }
  for (const id of indexed) {
    if (!declared.has(id)) fail(3, `index entry ${id} has no key blob`)
  }

  // Step 4: decrypt the root under its own associated data and check its 32 bytes render a phrase
  // whose checksum is valid, then hold it for the pass.
  observer?.onStep?.(4)
  const root = await decryptRoot(copy)
  const report: VerifyReport = { addressChecked: [], rederived: [], notRederived: [], comparedAgainstLive: false }
  try {
    if (root.length !== ROOT_ENTROPY_BYTES) {
      fail(4, `the root blob holds ${root.length} bytes, expected ${ROOT_ENTROPY_BYTES}`)
    }
    if (!isValidPhrase(phraseFromEntropy(root))) {
      fail(4, "the root entropy does not render a recovery phrase with a valid checksum")
    }

    // Step 5: one entry at a time.
    observer?.onStep?.(5)
    for (const entry of copy.index.entries) {
      await verifyEntry(copy, entry, root, report, observer)
    }
  } finally {
    // Step 6: zero the root (and every seed the derivations made, which `deriveSolanaKey` already
    // does inside itself).
    wipe(root)
    observer?.onStep?.(6)
    observer?.onRootZeroed?.()
  }

  // Step 7: the counters actually bound what has been allocated, and every flagged-exposed entry
  // is recorded in `hd.exposedIndexes`.
  observer?.onStep?.(7)
  for (const entry of copy.index.entries) {
    const located = entry.derivation ? branchOfPath(entry.derivation.path) : undefined
    if (located === undefined) continue
    if (nextIndexOf(copy.index.hd, located.branch) <= located.index) {
      fail(
        7,
        `hd.nextIndex.${located.branch} is ${nextIndexOf(copy.index.hd, located.branch)}, at or below this entry's index ${located.index}`,
        entry.id,
      )
    }
    if (entry.exposure.everRemoteExposed && !exposedIndexesOf(copy.index.hd, located.branch).includes(located.index)) {
      fail(
        7,
        `it is flagged remotely exposed but index ${located.index} is missing from hd.exposedIndexes.${located.branch}`,
        entry.id,
      )
    }
  }

  // Step 8: the only check that catches a copy which is internally perfect but is a stale or
  // foreign file. Everything above would pass on a vault that simply is not this one.
  if (opts.live) {
    observer?.onStep?.(8)
    report.comparedAgainstLive = true
    const copyAddresses = new Set(copy.index.entries.map((entry) => entry.address))
    const liveAddresses = new Set(opts.live.index.entries.map((entry) => entry.address))
    const missing = [...liveAddresses].filter((address) => !copyAddresses.has(address))
    const extra = [...copyAddresses].filter((address) => !liveAddresses.has(address))
    if (missing.length > 0 || extra.length > 0) {
      fail(
        8,
        `this copy's address set does not match the live vault (${missing.length} address(es) in the vault and not in the copy, ${extra.length} the other way). It may be a stale copy, or a copy of a different vault`,
      )
    }
  }

  return report
}

/**
 * One entry: decrypt its blob, check the stored secret's public key equals the recorded address
 * and that its length matches the curve, re-derive from the root along the recorded path when the
 * entry is `derived` and check byte equality, then zero that leaf and its derived copy BEFORE the
 * next entry is read.
 */
async function verifyEntry(
  copy: UnlockedVault,
  entry: KeyEntry,
  root: Uint8Array,
  report: VerifyReport,
  observer?: VerifyObserver,
): Promise<void> {
  const secret = await decryptKey(copy, entry.id)
  observer?.onLeafLive?.(1)
  try {
    const expectedLength = entry.curve === "ed25519" ? SOLANA_SECRET_BYTES : SECP256K1_SCALAR_BYTES
    if (secret.length !== expectedLength) {
      fail(5, `its stored secret is ${secret.length} bytes, but a ${entry.curve} key is ${expectedLength}`, entry.id)
    }
    if (entry.curve === "ed25519") {
      if (addressFromSecret64(secret) !== entry.address) {
        fail(5, "its stored secret does not produce the address the index records", entry.id)
      }
    } else if (!sameEvmAddress(evmAddressFromSecret(secret), entry.address)) {
      // Phase 4a (D7): the secp256k1 half of the secret→address check. The scalar's uncompressed
      // public key, keccak-256, last 20 bytes, must be the address the index records; the two
      // spellings of one address (EIP-55 and lowercase) are the same address.
      fail(5, "its stored secret does not produce the address the index records", entry.id)
    }
    report.addressChecked.push(entry.id)

    if (entry.origin !== "derived" || entry.derivation === undefined) {
      // A `migrated-tee` entry is an independent key, so the address and length checks above are
      // the strongest available for it, and the output says which entries got which.
      report.notRederived.push(entry.id)
      return
    }
    if (entry.derivation.scheme === "bip32-secp256k1") {
      // Phase 4a (D7): re-derive `m/44'/60'/n'/0/0` from the root and require byte equality of the
      // scalar, exactly as the Solana branch below requires it of the 64-byte secret.
      // Phase 4b (D1): or `m/44'/60'/n'/1'/0'`, the EVM TEE branch, by the same byte equality.
      const index = evmIndexOfPath(entry.derivation.path)
      const teeIndex = evmTeeIndexOfPath(entry.derivation.path)
      if (index === undefined && teeIndex === undefined) {
        fail(5, `its recorded path ${entry.derivation.path} is not on an EVM branch`, entry.id)
      }
      const derivedEvm =
        index !== undefined
          ? await deriveEvmKeyFromRoot(root, index)
          : await deriveEvmTeeKeyFromRoot(root, teeIndex as number)
      observer?.onLeafLive?.(2)
      try {
        if (!bytesEqual(derivedEvm.secret, secret)) {
          fail(5, `it does not re-derive from the root along its recorded path ${entry.derivation.path}`, entry.id)
        }
        report.rederived.push(entry.id)
      } finally {
        wipe(derivedEvm.secret)
        observer?.onLeafLive?.(1)
      }
      return
    }
    if (entry.derivation.scheme !== "slip10-ed25519") {
      report.notRederived.push(entry.id)
      return
    }
    const derived = await deriveSolanaKey(root, entry.derivation.path)
    // Two leaves are live for the length of this comparison, which is the derived copy of the SAME
    // key rather than a second entry's secret; the observer sees it so the assertion is exact.
    observer?.onLeafLive?.(2)
    try {
      if (!bytesEqual(derived.secret64, secret)) {
        fail(5, `it does not re-derive from the root along its recorded path ${entry.derivation.path}`, entry.id)
      }
      report.rederived.push(entry.id)
    } finally {
      wipe(derived.secret64)
      observer?.onLeafLive?.(1)
    }
  } finally {
    wipe(secret)
    observer?.onLeafLive?.(0)
  }
}
