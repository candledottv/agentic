/**
 * Ember Phase 2 (BE-140, CC-03, ED-11, CC-12): `candle vault factor add security-key`.
 *
 * The order is the whole design. The helper, the key and the key's capabilities come FIRST, so an
 * operator whose key cannot serve the factor (no `hmac-secret`, no PIN and no biometric, or no
 * helper on this machine) is refused with a typed code before typing the vault passphrase and
 * before the key gains a credential it will never use. Then the vault is opened with the
 * passphrase (the recovery floor, present on every vault), the discoverable user-verified
 * credential is registered, ONE assertion yields the PRF output the KEK derives from, the DEK is
 * wrapped, the index is re-encrypted under the new header (ED-1, nothing else rewritten), and the
 * file is re-read and opened WITH THE NEW KEY before success is reported: a factor that has not
 * been proven to open the file is not a factor. Three touches, and the output says so.
 *
 * What the envelope records and what it does not (helper protocols): the credential id and the
 * relying party are the identity and are stored; the device locator is this run's and is not; the
 * AAGUID and product are display only. BE and BS come from the registration's authenticator data;
 * a credential the key reports as backup-eligible is not a hardware-bound factor and is refused
 * rather than recorded under a domain it does not belong to.
 */
import type { ParsedArgs } from "../args"
import type { CommandContext } from "../deps"
import { b64u, randomBytes } from "../vault/crypto"
import { countRecoverableFactors } from "../vault/domains"
import { VaultError } from "../vault/errors"
import {
  assertPrf,
  currentPlatformFacts,
  HELPER_NAME,
  openSecurityKeySession,
  registerCredential,
} from "../vault/fido2"
import { CTAP2_RP_ID, type Ctap2Envelope, type Envelope, parseVaultFile, VAULT_CIPHER } from "../vault/format"
import { wipe } from "../vault/hygiene"
import { installHelperForThisRelease } from "../vault/install-helper"
import { assertFactorAddable } from "../vault/platform"
import { closeVault, commitVault, freshEnvelopeId, readVaultRaw, unlockVault, wrapDekForPrf } from "../vault/store"
import { CLI_VERSION } from "../version"
import { type ResolvedVaultPath, requireVaultRaw, unlockInteractively, writeJson } from "./vault-support"

export const SECURITY_KEY_PAIR_NOTE =
  "One security key is not a recoverable factor: a lost key is a lost factor. Two security key envelopes on two different keys are a recoverable pair. The passphrase remains this vault's recovery floor."

export async function addSecurityKeyFactor(
  ctx: CommandContext,
  parsed: ParsedArgs,
  resolvedVault: ResolvedVaultPath,
  hold: (vault: Parameters<typeof closeVault>[0]) => Parameters<typeof closeVault>[0],
): Promise<number> {
  const path = resolvedVault.path
  const { deps } = ctx
  // `--install-helper` (BE-275 D8), before the platform facts are read: a release binary with no
  // candle-fido2 beside it gets this release's own, downloaded and verified exactly as `update`
  // does, and then the enrolment it was asked for proceeds. Anything short of a verified install
  // installs nothing and is the same typed refusal as without the flag, with the reason named.
  if (parsed.booleans.has("--install-helper")) {
    const install = await installHelperForThisRelease(ctx)
    if (!install.ok) {
      throw new VaultError(
        "VAULT_HELPER_MISSING",
        `--install-helper could not install ${HELPER_NAME} ${CLI_VERSION}: ${install.message}.`,
        {
          suggestion:
            "Nothing was installed. Install a release build of the CLI (which places candle-fido2 beside candle) or set CANDLE_FIDO2_HELPER. No other factor is substituted and nothing was written.",
        },
      )
    }
    if (!ctx.json) {
      deps.stderr.write(
        install.installed
          ? `Installed ${HELPER_NAME} ${CLI_VERSION} to ${install.path}; enrolling.\n`
          : `${HELPER_NAME} is already at ${install.path}; nothing downloaded.\n`,
      )
    }
  }
  // CC-12 first: a platform or a machine that cannot drive the factor is a typed refusal before
  // any device is enumerated, and never a substitution.
  const facts = await currentPlatformFacts(deps)
  assertFactorAddable("passkey-prf", facts, "ctap2")

  const raw = await requireVaultRaw(ctx, resolvedVault)
  const file = parseVaultFile(raw)
  const envelopeId = freshEnvelopeId()

  // The key, before the vault: feature detection (ED-11), selection (the operator's), and the PIN
  // a PIN-only key needs, collected on the CLI's own hidden prompt.
  const session = await openSecurityKeySession(deps, {
    vaultId: file.vaultId,
    envelopeId,
    deviceFlag: ctx.vaultDevice,
    requireFeatures: true,
  })

  // The vault, with the passphrase. `--device` named the key being ADDED, so the unlock must not
  // also try to drive a key; the recovery floor is on every vault and is the factor used here.
  const opened = await unlockInteractively(ctx, path, raw, {
    acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
    promptText: "Current vault passphrase, to unlock (input hidden): ",
    factor: "passphrase",
  })
  const vault = hold(opened.vault)

  const registered = await registerCredential(deps, session, { vaultId: vault.file.vaultId, envelopeId })
  if (registered.backupEligible) {
    throw new VaultError(
      "VAULT_FACTOR_UNAVAILABLE",
      `${session.device.product || "This authenticator"} reports the credential it created as backup-eligible (synced), so it is not a hardware-bound security key credential and cannot be recorded as a hardware-token factor.`,
      {
        suggestion:
          "Nothing was written to the vault. The credential now on the authenticator can be removed with its vendor's tool. Use a hardware security key for this factor.",
      },
    )
  }

  const envelope: Ctap2Envelope = {
    id: envelopeId,
    factor: "passkey-prf",
    transport: "ctap2",
    domain: "hardware-token",
    label: parsed.values["--label"] ?? (session.device.product || "security key"),
    createdAt: new Date(deps.now()).toISOString(),
    rpId: CTAP2_RP_ID,
    credentialId: registered.credentialId,
    prfSalt: b64u(randomBytes(32)),
    userVerification: "required",
    backupEligible: false,
    backupState: registered.backupState,
    saltDerivation: "webauthn-prf",
    aaguid: registered.aaguid,
    product: session.device.product,
    wrap: { alg: VAULT_CIPHER, iv: "", ciphertext: "" },
  }

  // One assertion for the PRF output, wrapped, zeroed.
  const prfOutput = await assertPrf(deps, session, envelope, vault.file.vaultId, "derive this vault's key on it")
  let wrap: Ctap2Envelope["wrap"]
  try {
    wrap = await wrapDekForPrf(vault.dek, prfOutput, envelope as unknown as Envelope, vault.file)
  } finally {
    wipe(prfOutput)
  }
  const sealed = { ...envelope, wrap } as unknown as Envelope

  // The index is re-encrypted under the NEW header, which is what makes the added envelope part
  // of what the index authenticates; generation increments; no key blob is touched.
  await commitVault(vault, { index: vault.index, envelopes: [...vault.file.envelopes, sealed] }, deps)

  // Re-open with the NEW factor before reporting, for the same reason `init` does.
  const written = await readVaultRaw(path)
  if (written === null) throw new VaultError("VAULT_WRITE_FAILED", `The vault at ${path} could not be read back.`)
  const proof = await assertPrf(
    deps,
    session,
    sealed as unknown as Ctap2Envelope,
    vault.file.vaultId,
    "prove the new factor opens the vault",
  )
  try {
    closeVault(await unlockVault(path, written, { factor: "passkey-prf", envelopeId, prfOutput: proof }))
  } finally {
    wipe(proof)
  }

  const recoverable = countRecoverableFactors([...vault.file.envelopes, sealed])
  if (ctx.json) {
    writeJson(deps, {
      ok: true,
      envelopeId,
      factor: "passkey-prf",
      transport: "ctap2",
      domain: "hardware-token",
      label: envelope.label,
      product: envelope.product,
      aaguid: envelope.aaguid,
      backupEligible: false,
      backupState: envelope.backupState,
      userVerification: "required",
      recoverableFactors: recoverable,
      verified: true,
    })
    return 0
  }
  deps.stdout.write(`Added security key factor ${envelopeId} (${envelope.product || "security key"}).\n`)
  deps.stdout.write(`  domain     hardware-token (backup-eligible: no)\n`)
  deps.stdout.write(`  verified   the vault was re-read and opened with the new key\n`)
  deps.stdout.write(`  unlock     candle vault status --unlock --factor ${envelopeId}\n`)
  deps.stdout.write(`\n${SECURITY_KEY_PAIR_NOTE}\n`)
  deps.stdout.write(`This vault now has ${recoverable} recoverable factor(s), domains counted once.\n`)
  return 0
}
