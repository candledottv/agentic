/**
 * Ember Phase 2 (BE-135, AD-2, CC-03's platform passkey bullet, CC-12): `candle vault factor add
 * passkey`.
 *
 * The order is the whole design, as it is for the security key and Touch ID. The policy, the
 * helper, its code signature, macOS 15, the associated-domains entitlement, the provisioning
 * profile and the `apple-app-site-association` on the RP id domain come FIRST, each a typed
 * refusal before the vault passphrase is typed and before any passkey sheet appears, and never a
 * fallback to a security key, a passphrase or a browser. Then the vault is opened with the
 * passphrase (the recovery floor, present on every vault), a discoverable user-verified credential
 * is registered on the platform authenticator with the PRF extension checked for support, ONE
 * assertion yields the PRF output the KEK derives from (ED-4, the security key's derivation), the
 * DEK is wrapped, the index is re-encrypted under the new header (ED-1, nothing else rewritten),
 * and the file is re-read and opened WITH THE NEW PASSKEY before success is reported: a factor
 * that has not been proven to open the file is not a factor. Three sheets, and the output says so.
 *
 * What the envelope records (CC-01): the credential id and the relying party (the identity), the
 * raw PRF salt, that the platform applied its own salt derivation, the BE and BS flags, and the
 * helper's team id, bundle id and version, which the codesign requirement pins at every unlock.
 * The domain is `apple-account` (AD-2): recoverable, because the credential follows the account to
 * a new Mac, and never independent of any other Apple-account item. A credential the platform
 * reports as NOT backup-eligible (iCloud Keychain off) is refused rather than recorded under a
 * domain it does not belong to, exactly as the security key refuses a synced one.
 *
 * Every failure leaves state a retry can use. The platform keeps a passkey a failed enrolment
 * created (there is no API to delete one; the output says where to remove it); it opens nothing
 * without its envelope, and a retry registers a fresh credential under a fresh envelope id. A
 * failed proof rolls the envelope back out of the file, so the vault is what it was.
 */
import type { ParsedArgs } from "../args"
import type { CommandContext } from "../deps"
import { PASSKEY_RP_ID } from "../enclave-helper/protocol"
import { b64u, randomBytes } from "../vault/crypto"
import { countRecoverableFactors } from "../vault/domains"
import { VaultError } from "../vault/errors"
import { currentPlatformFacts } from "../vault/fido2"
import { type Envelope, type PlatformPasskeyEnvelope, VAULT_CIPHER } from "../vault/format"
import { wipe } from "../vault/hygiene"
import {
  assertPlatformPrf,
  checkAppleAppSiteAssociation,
  type PasskeySession,
  registerPlatformPasskey,
} from "../vault/passkey"
import { assertFactorAddable } from "../vault/platform"
import {
  closeVault,
  commitVault,
  freshEnvelopeId,
  readVaultRaw,
  type UnlockedVault,
  unlockVault,
  wrapDekForPrf,
} from "../vault/store"
import { requireVaultRaw, unlockInteractively, writeJson } from "./vault-support"

export const PASSKEY_NOTE =
  "A synced passkey lives in your Apple account: it follows the account to a new Mac, so it is a recoverable factor, and it is never counted as independent of any other Apple-account item (two synced passkeys are one factor). What syncs through iCloud Keychain is the credential's private key; the PRF output and this vault's key never leave this Mac. Keep the passphrase and the recovery phrase outside that Apple account."

export const PASSKEY_LEFTOVER_NOTE =
  "The passkey this attempt created remains in your Passwords (System Settings, Passwords, cli.candle.tv) and opens nothing without its envelope; remove it there. Nothing was written to the vault."

export async function addPasskeyFactor(
  ctx: CommandContext,
  parsed: ParsedArgs,
  path: string,
  hold: (vault: UnlockedVault) => UnlockedVault,
): Promise<number> {
  const { deps } = ctx
  // CC-12 first: the policy, the helper, its signature, macOS 15, the entitlement and the profile,
  // each a typed refusal before the vault is read and never a substitution.
  const facts = await currentPlatformFacts(deps)
  assertFactorAddable("passkey-prf", facts, "platform-macos")
  const helper = facts.enclaveHelper
  if (helper === undefined || helper.state !== "ready") {
    throw new VaultError("VAULT_HELPER_MISSING", "The signed macOS helper was not found after the platform check.")
  }
  const session: PasskeySession = {
    path: helper.path,
    appPath: helper.appPath,
    identity: helper.identity,
    version: helper.version,
  }
  // The one gate outside this machine: the RP id domain's apple-app-site-association, checked
  // before the passphrase so a missing deployment prerequisite costs no secret.
  const association = await checkAppleAppSiteAssociation(deps, helper.identity)

  const raw = await requireVaultRaw(path)
  const envelopeId = freshEnvelopeId()
  const label = parsed.values["--label"] ?? "synced passkey"

  // The vault, with the passphrase: the passkey does not exist yet, and the recovery floor is on
  // every vault.
  const opened = await unlockInteractively(ctx, path, raw, {
    acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
    promptText: "Current vault passphrase, to unlock (input hidden): ",
    factor: "passphrase",
  })
  const vault = hold(opened.vault)
  const vaultId = vault.file.vaultId

  // The credential: one sheet. From here on a failure leaves the passkey on the platform and the
  // output says where it is; the vault is untouched.
  let registered: Awaited<ReturnType<typeof registerPlatformPasskey>>
  try {
    registered = await registerPlatformPasskey(deps, session, { vaultId, envelopeId })
  } catch (error) {
    deps.stderr.write("Nothing was written to the vault.\n")
    throw error
  }
  if (!registered.prfSupported) {
    throw new VaultError(
      "VAULT_PRF_UNSUPPORTED",
      "The platform authenticator reports the PRF extension unsupported for the passkey it created, so no key can be derived from it.",
      { suggestion: `${PASSKEY_LEFTOVER_NOTE} No other derivation is substituted.` },
    )
  }
  if (!registered.backupEligible) {
    throw new VaultError(
      "VAULT_FACTOR_UNAVAILABLE",
      "The platform authenticator reports the passkey it created as not backup-eligible (not synced: iCloud Keychain is off for this Apple account), so it is not a synced passkey and cannot be recorded under the apple-account domain.",
      {
        suggestion: `Turn on iCloud Keychain (System Settings, Apple Account, iCloud, Passwords & Keychain) and retry, or use a security key or Touch ID for a device-bound factor. ${PASSKEY_LEFTOVER_NOTE}`,
      },
    )
  }

  // The salt is not a secret, but every random buffer is tracked by the T36 seam, so it is zeroed
  // once encoded rather than left for the collector.
  const salt = randomBytes(32)
  const prfSalt = b64u(salt)
  wipe(salt)
  const envelope: PlatformPasskeyEnvelope = {
    id: envelopeId,
    factor: "passkey-prf",
    transport: "platform-macos",
    domain: "apple-account",
    label,
    createdAt: new Date(deps.now()).toISOString(),
    rpId: PASSKEY_RP_ID,
    credentialId: registered.credentialId,
    prfSalt,
    userVerification: "required",
    backupEligible: true,
    backupState: registered.backupState,
    saltDerivation: "platform",
    helper: { teamId: session.identity.teamId, bundleId: session.identity.bundleId, minVersion: session.version },
    wrap: { alg: VAULT_CIPHER, iv: "", ciphertext: "" },
  }

  let sealed: Envelope
  let committed: UnlockedVault
  try {
    // One assertion for the PRF output, wrapped, zeroed.
    const prfOutput = await assertPlatformPrf(deps, session, envelope, vaultId, "derive this vault's key on it")
    let wrap: PlatformPasskeyEnvelope["wrap"]
    try {
      wrap = await wrapDekForPrf(vault.dek, prfOutput, envelope as unknown as Envelope, vault.file)
    } finally {
      wipe(prfOutput)
    }
    sealed = { ...(envelope as unknown as Envelope), wrap }
    // The index is re-encrypted under the NEW header, which is what makes the added envelope part
    // of what the index authenticates; generation increments; no key blob is touched.
    committed = hold(
      await commitVault(vault, { index: vault.index, envelopes: [...vault.file.envelopes, sealed] }, deps),
    )
  } catch (error) {
    deps.stderr.write(`${PASSKEY_LEFTOVER_NOTE}\n`)
    throw error
  }

  // Re-open with the NEW factor before reporting, for the same reason `init` does. A failed proof
  // is rolled back so the vault is what it was.
  try {
    const written = await readVaultRaw(path)
    if (written === null) throw new VaultError("VAULT_WRITE_FAILED", `The vault at ${path} could not be read back.`)
    const proof = await assertPlatformPrf(
      deps,
      session,
      sealed as unknown as PlatformPasskeyEnvelope,
      vaultId,
      "prove the new synced passkey opens the vault",
    )
    try {
      closeVault(await unlockVault(path, written, { factor: "passkey-prf", envelopeId, prfOutput: proof }))
    } finally {
      wipe(proof)
    }
  } catch (error) {
    try {
      await commitVault(
        committed,
        {
          index: committed.index,
          envelopes: committed.file.envelopes.filter((candidate) => candidate.id !== envelopeId),
        },
        deps,
      )
      deps.stderr.write(`The unproven envelope ${envelopeId} was removed from the vault again.\n`)
    } catch {
      deps.stderr.write(
        `Envelope ${envelopeId} could not be removed from the vault; remove it with: candle vault factor remove ${envelopeId}\n`,
      )
    }
    deps.stderr.write(`${PASSKEY_LEFTOVER_NOTE}\n`)
    throw error
  }

  const recoverable = countRecoverableFactors(committed.file.envelopes)
  if (ctx.json) {
    writeJson(deps, {
      ok: true,
      envelopeId,
      factor: "passkey-prf",
      transport: "platform-macos",
      domain: "apple-account",
      label,
      rpId: PASSKEY_RP_ID,
      appId: association.appId,
      backupEligible: true,
      backupState: registered.backupState,
      userVerification: "required",
      saltDerivation: "platform",
      helper: envelope.helper,
      recoverableFactors: recoverable,
      verified: true,
    })
    return 0
  }
  deps.stdout.write(`Added synced passkey factor ${envelopeId} (${PASSKEY_RP_ID}, this Apple account).\n`)
  deps.stdout.write(
    `  domain     apple-account (backup-eligible: yes, backed up now: ${registered.backupState ? "yes" : "no"})\n`,
  )
  deps.stdout.write(
    `  helper     ${session.identity.bundleId} ${session.version}, signed by team ${session.identity.teamId}\n`,
  )
  deps.stdout.write(`  verified   the vault was re-read and opened with the new passkey\n`)
  deps.stdout.write(`  unlock     candle vault status --unlock --factor ${envelopeId}\n`)
  deps.stdout.write(`\n${PASSKEY_NOTE}\n`)
  deps.stdout.write(`This vault now has ${recoverable} recoverable factor(s), domains counted once.\n`)
  return 0
}
