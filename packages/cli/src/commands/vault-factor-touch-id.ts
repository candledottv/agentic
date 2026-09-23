/**
 * Ember Phase 2 (BE-141, CC-03, ED-12, CC-12): `candle vault factor add touch-id`.
 *
 * The order is the whole design, as it is for the security key. The policy, the helper, its code
 * signature, the Enclave and Touch ID's availability come FIRST, so an operator on a Mac that
 * cannot serve the factor (a build whose policy omits the helper, no helper, a helper that fails
 * the codesign requirement, an Intel Mac without a T2 chip, a closed lid) is refused with a typed
 * code before typing the vault passphrase. Then the vault is opened with the passphrase (the
 * recovery floor, present on every vault), the Enclave key is created under `biometryCurrentSet`,
 * a fresh 32-byte KEK is wrapped to its public key with Apple's ECIES, the DEK is wrapped under
 * that KEK, the index is re-encrypted under the new header (ED-1, nothing else rewritten), and
 * the file is re-read and opened WITH THE NEW FACTOR, one Touch ID prompt, before success is
 * reported: a factor that has not been proven to open the file is not a factor.
 *
 * Every failure leaves state a retry can use. A failure before the commit deletes the Enclave key
 * the ceremony created, so nothing of it remains. A failed proof rolls the commit back (the
 * envelope comes out of the file under the same lock discipline) and deletes the key. In both
 * cases the passphrase opens the vault exactly as before and a retry starts from nothing.
 *
 * What the envelope records (CC-01): the helper's team id and bundle id, which the codesign
 * requirement pins at every unlock, and the helper version it was made with; the public key; the
 * keychain tag; the access control; the wrapped KEK. The domain is `this-device`, never
 * recoverable, always beside the passphrase envelope.
 */
import type { ParsedArgs } from "../args"
import type { CommandContext } from "../deps"
import { countRecoverableFactors } from "../vault/domains"
import {
  createEnclaveKey,
  deleteEnclaveKey,
  describeBiometry,
  type EnclaveSession,
  keyTagFor,
  unwrapKekWithEnclave,
  wrapFreshKekForEnclave,
} from "../vault/enclave"
import { VaultError } from "../vault/errors"
import { currentPlatformFacts } from "../vault/fido2"
import { type Envelope, SECURE_ENCLAVE_KEK_ALG, type SecureEnclaveEnvelope, VAULT_CIPHER } from "../vault/format"
import { wipe } from "../vault/hygiene"
import { assertFactorAddable } from "../vault/platform"
import {
  closeVault,
  commitVault,
  freshEnvelopeId,
  readVaultRaw,
  type UnlockedVault,
  unlockVault,
  wrapDekForKek,
} from "../vault/store"
import { type ResolvedVaultPath, requireVaultRaw, unlockInteractively, writeJson } from "./vault-support"

export const TOUCH_ID_NOTE =
  "Touch ID is a daily-use factor, not a recovery factor: it opens this vault on this Mac only, and a wiped Mac, a changed fingerprint set or a lost Mac loses it. The passphrase remains this vault's recovery floor. The Secure Enclave resists extraction of its key; it does not stop a process running as you from asking the helper to unwrap, which is why every unlock names its operation in the Touch ID prompt."

export async function addTouchIdFactor(
  ctx: CommandContext,
  parsed: ParsedArgs,
  resolvedVault: ResolvedVaultPath,
  hold: (vault: UnlockedVault) => UnlockedVault,
): Promise<number> {
  const path = resolvedVault.path
  const { deps } = ctx
  // CC-12 first: the policy, the helper, its signature and the Enclave, each a typed refusal
  // before the vault is read and never a substitution.
  const facts = await currentPlatformFacts(deps)
  assertFactorAddable("secure-enclave", facts)
  const helper = facts.enclaveHelper
  if (helper === undefined || helper.state !== "ready") {
    throw new VaultError("VAULT_HELPER_MISSING", "The Secure Enclave helper was not found after the platform check.", {
      suggestion: "Install a release build (candle update), or point CANDLE_ENCLAVE_HELPER at the signed helper.",
    })
  }
  if (helper.biometry !== "available") {
    // BE-135: the five states are worded apart. "Not available from this session" (SSH, a
    // background agent, the lid closed) names the LAError and is not "no Touch ID hardware".
    const described = describeBiometry(helper)
    throw new VaultError("VAULT_FACTOR_UNAVAILABLE", described.message, { suggestion: described.suggestion })
  }
  const session: EnclaveSession = {
    path: helper.path,
    appPath: helper.appPath,
    identity: helper.identity,
    version: helper.version,
    biometry: helper.biometry,
  }

  const raw = await requireVaultRaw(ctx, resolvedVault)
  const envelopeId = freshEnvelopeId()
  const label = parsed.values["--label"] ?? "Touch ID"

  // The vault, with the passphrase: the Enclave key does not exist yet, and the recovery floor is
  // on every vault.
  const opened = await unlockInteractively(ctx, path, raw, {
    acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
    promptText: "Current vault passphrase, to unlock (input hidden): ",
    factor: "passphrase",
    // BE-292 (D7, row F2; D10): said before the prompt when the vault has another factor.
    passphraseOnlyBecause:
      "adding a factor opens the vault with the passphrase. A security key does not authorise enrollment: adding a second key while one is plugged in needs a device-selection rule this command does not have (D10).",
  })
  const vault = hold(opened.vault)
  const vaultId = vault.file.vaultId
  const keyTag = keyTagFor(vaultId, envelopeId)

  // The key. From here on, a failure deletes it so a retry starts from nothing.
  let created: Awaited<ReturnType<typeof createEnclaveKey>>
  try {
    created = await createEnclaveKey(deps, session, { vaultId, envelopeId, label })
  } catch (error) {
    deps.stderr.write("Nothing was written to the vault.\n")
    throw error
  }
  const removeKey = async (): Promise<void> => {
    const removed = await deleteEnclaveKey(deps, session, { vaultId, envelopeId })
    deps.stderr.write(
      removed
        ? `Removed the Secure Enclave key ${keyTag} this failed enrolment created.\n`
        : `Could not remove the Secure Enclave key ${keyTag}; it opens nothing and a retry creates a new one.\n`,
    )
  }

  let sealed: Envelope
  let committed: UnlockedVault
  try {
    const { kek, ciphertext } = await wrapFreshKekForEnclave(created.point)
    const envelope: SecureEnclaveEnvelope = {
      id: envelopeId,
      factor: "secure-enclave",
      domain: "this-device",
      label,
      createdAt: new Date(deps.now()).toISOString(),
      helper: { teamId: session.identity.teamId, bundleId: session.identity.bundleId, minVersion: session.version },
      publicKey: created.publicKeySpki,
      keyTag,
      accessControl: "biometryCurrentSet",
      kek: { alg: SECURE_ENCLAVE_KEK_ALG, ciphertext },
      wrap: { alg: VAULT_CIPHER, iv: "", ciphertext: "" },
    }
    let wrap: SecureEnclaveEnvelope["wrap"]
    try {
      wrap = await wrapDekForKek(vault.dek, kek, envelope as unknown as Envelope, vault.file)
    } finally {
      wipe(kek)
    }
    sealed = { ...(envelope as unknown as Envelope), wrap }
    // The index is re-encrypted under the NEW header, which is what makes the added envelope part
    // of what the index authenticates; generation increments; no key blob is touched.
    committed = hold(
      await commitVault(vault, { index: vault.index, envelopes: [...vault.file.envelopes, sealed] }, deps),
    )
  } catch (error) {
    await removeKey()
    deps.stderr.write("Nothing was written to the vault.\n")
    throw error
  }

  // Re-open with the NEW factor before reporting, for the same reason `init` does. This is the
  // one Touch ID prompt of the ceremony, and it is also the round trip that proves the Enclave
  // unwraps what this CLI wrapped. A failed proof is rolled back so the vault is what it was.
  try {
    const written = await readVaultRaw(path)
    if (written === null) throw new VaultError("VAULT_WRITE_FAILED", `The vault at ${path} could not be read back.`)
    const proof = await unwrapKekWithEnclave(
      deps,
      session,
      sealed as unknown as SecureEnclaveEnvelope,
      vaultId,
      "prove the new Touch ID factor opens the Candle vault",
    )
    try {
      closeVault(await unlockVault(path, written, { factor: "secure-enclave", envelopeId, kek: proof }))
    } finally {
      wipe(proof)
    }
  } catch (error) {
    try {
      await commitVault(
        committed,
        {
          index: committed.index,
          envelopes: committed.file.envelopes.filter((envelope) => envelope.id !== envelopeId),
        },
        deps,
      )
      deps.stderr.write(`The unproven envelope ${envelopeId} was removed from the vault again.\n`)
    } catch {
      deps.stderr.write(
        `Envelope ${envelopeId} could not be removed from the vault; remove it with: candle vault factor remove ${envelopeId}\n`,
      )
    }
    await removeKey()
    throw error
  }

  const recoverable = countRecoverableFactors(committed.file.envelopes)
  if (ctx.json) {
    writeJson(deps, {
      ok: true,
      envelopeId,
      factor: "secure-enclave",
      domain: "this-device",
      label,
      helper: { teamId: session.identity.teamId, bundleId: session.identity.bundleId, minVersion: session.version },
      accessControl: "biometryCurrentSet",
      recoverableFactors: recoverable,
      verified: true,
    })
    return 0
  }
  deps.stdout.write(`Added Touch ID factor ${envelopeId} (Secure Enclave, this Mac).\n`)
  deps.stdout.write(`  domain     this-device (never recoverable; the key never leaves this Mac)\n`)
  deps.stdout.write(
    `  helper     ${session.identity.bundleId} ${session.version}, signed by team ${session.identity.teamId}\n`,
  )
  deps.stdout.write(`  verified   the vault was re-read and opened with Touch ID\n`)
  deps.stdout.write(`  unlock     candle vault status --unlock --factor ${envelopeId}\n`)
  deps.stdout.write(`\n${TOUCH_ID_NOTE}\n`)
  deps.stdout.write(`This vault now has ${recoverable} recoverable factor(s), domains counted once.\n`)
  return 0
}
