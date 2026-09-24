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
 *
 * BE-337 (spec `2026-09-24-cli-security-key-authorizes-factor-add-design.md`): a security key the
 * vault already has may open it for this command (D1), which puts two keys in one command. The
 * order is D4's: one `info` and one silent `probe` first; the menu; the opening device and the key
 * being added decided from that probe, before any PIN (D2); a key that already holds one of this
 * vault's credentials refused by locator, by the probe, and finally by the authenticator's own
 * exclude list (D3); the opener's session (its PIN, one assertion) run to completion and dropped
 * before the enrolling key is asked anything beyond `info` and `probe`; then the enrolling key's
 * own session, its own PIN prompt worded apart, and the three touches as before. A PIN is never
 * reused across the two keys. With the passphrase as the opener the order is the old one: the key
 * being added, its checks and its PIN, then the passphrase.
 */
import { base64 } from "@scure/base"
import type { ParsedArgs } from "../args"
import type { CommandContext } from "../deps"
import type { DeviceReport } from "../fido2-helper/protocol"
import { b64u, randomBytes, unb64u } from "../vault/crypto"
import { countRecoverableFactors } from "../vault/domains"
import { VaultError } from "../vault/errors"
import {
  type AttachedKeys,
  alreadyEnrolled,
  assertDeviceServesFactor,
  assertExcludeListFits,
  assertHelperExcludeList,
  assertPrf,
  currentPlatformFacts,
  describeDeviceForList,
  HELPER_NAME,
  listSecurityKeys,
  openSecurityKeySession,
  probeAttachedKeys,
  registerCredential,
  type SecurityKeySession,
  selectDevice,
} from "../vault/fido2"
import {
  CTAP2_RP_ID,
  type Ctap2Envelope,
  type Envelope,
  isCtap2Envelope,
  parseVaultFile,
  VAULT_CIPHER,
} from "../vault/format"
import { wipe } from "../vault/hygiene"
import { installHelperForThisRelease } from "../vault/install-helper"
import { assertFactorAddable } from "../vault/platform"
import { closeVault, commitVault, freshEnvelopeId, readVaultRaw, unlockVault, wrapDekForPrf } from "../vault/store"
import { CLI_VERSION } from "../version"
import {
  factorAddAmong,
  type ResolvedVaultPath,
  requireVaultRaw,
  unlockInteractively,
  writeJson,
} from "./vault-support"

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
  const vaultId = file.vaultId
  const keysInHeader = file.envelopes.filter(isCtap2Envelope)

  // D4 step 2: one `info` and one silent `probe`, over EVERY attached device (`--device` names the
  // key being added here, so it must not narrow the probe). No PIN, no touch, no secret. The probe
  // is best effort: `undefined` when it cannot run, and then D2 step 1 cannot place the opener,
  // refusal 2 is skipped, and refusal 3 (the authenticator's own answer) still holds.
  const { helperPath, info } = await listSecurityKeys(deps, { vaultId, envelopeId })
  // D3, mixed versions: with credentials to exclude, the helper must say it has the feature, before
  // any PIN (and before the probe, which it would only waste). The first enrollment on a vault
  // (nothing to exclude) works with any protocol-1 helper.
  assertHelperExcludeList(info, helperPath, keysInHeader.length)
  const attached =
    keysInHeader.length > 0 ? await probeAttachedKeys(deps, { vaultId, envelopes: keysInHeader }) : undefined
  const excludeCountNow = keysInHeader.length

  const addingLine = (device: DeviceReport) =>
    deps.stderr.write(
      `Adding: ${device.product || "security key"} (--device ${device.deviceId}), a different key from the one that opened the vault.\n`,
    )

  /** The enrolling key's session, when it is opened before the vault (the passphrase path). */
  let session: SecurityKeySession | undefined
  /** The key being added, decided before the vault opened (a security key opened it). */
  let enrolling: DeviceReport | undefined
  /** D2, deferred: only the opening device was attached; the key to add is asked for after the open. */
  let deferredAfter: DeviceReport | undefined

  const opened = await unlockInteractively(ctx, path, raw, {
    acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
    promptText: "Current vault passphrase, to unlock (input hidden): ",
    // D1: the passphrase or one of the vault's security keys, never Touch ID or a synced passkey.
    among: factorAddAmong(file.envelopes),
    // Passed even when undefined: the chooser must not probe a second time (D1).
    attached,
    onFactorChosen: async (chosen) => {
      if (chosen.kind === "passphrase") {
        // With the passphrase as the opener the order is the old one: the key being added, its
        // feature checks and its PIN, then the passphrase. Selection is `selectDevice`'s (`--device`,
        // or the one attached key). Refusal 2 and the exclude-list capacity are checked before the
        // PIN, from the same probe.
        session = await openSecurityKeySession(deps, {
          vaultId,
          envelopeId,
          deviceFlag: ctx.vaultDevice,
          requireFeatures: true,
          beforePin: (device) => {
            refuseIfEnrolled(device, attached)
            assertExcludeListFits(device, excludeCountNow)
          },
        })
        return undefined
      }
      if (chosen.kind !== "security-key") return undefined
      // D2: the opening device and the key being added, both before any PIN.
      const plan = planDevices(ctx, chosen.envelope, info.devices, attached)
      if (plan.enrolling !== undefined) {
        // D3 refusal 2, then the ordering rule of this file's header: a key that cannot serve the
        // factor is refused before the opener's PIN is typed, and before the capacity check.
        refuseIfEnrolled(plan.enrolling, attached)
        assertDeviceServesFactor(plan.enrolling)
        assertExcludeListFits(plan.enrolling, excludeCountNow)
        enrolling = plan.enrolling
        addingLine(plan.enrolling)
      } else {
        deferredAfter = plan.opening
      }
      return { preferDevice: plan.opening.deviceId }
    },
  })
  const vault = hold(opened.vault)
  const openedWith = {
    factor: opened.factor.kind === "passphrase" ? ("passphrase" as const) : ("security-key" as const),
    envelopeId: opened.factor.envelopeId,
  }
  // D4 step 4: the opener's session is dropped. Its PIN is a JavaScript string with CC-04's stated
  // lifetime caveat; nothing that runs from here on can reach it, and it is never sent to the key
  // being added, even when the operator uses the same PIN on both.
  if (opened.factor.kind === "security-key") opened.factor.session.pin = undefined

  // D3 refusal 3: the exclude list comes from the AUTHENTICATED header, not the cleartext one the
  // early checks read. A header edited to hide a credential fails the index tag at the unlock.
  const enrolledKeys = vault.file.envelopes.filter(isCtap2Envelope)
  const excludeCredentialIds = enrolledKeys.map((envelope) =>
    base64.encode(unb64u(envelope.credentialId, "credentialId")),
  )

  if (session === undefined) {
    // A security key opened the vault. Its assertion has returned; only now is the key being added
    // asked for anything beyond `info` and `probe`.
    if (deferredAfter !== undefined) {
      // D2, deferred: one Enter prompt, one fresh enumeration and probe, no polling and no second
      // chance. The open vault is closed by `runVaultCommand` on any refusal here, as on any other.
      await deps.promptLine(
        `The vault is open. Unplug ${deferredAfter.product || "the security key that opened it"}, insert the security key to add, then press Enter.`,
      )
      const again = await listSecurityKeys(deps, { vaultId, envelopeId })
      const probeAgain =
        enrolledKeys.length > 0 ? await probeAttachedKeys(deps, { vaultId, envelopes: enrolledKeys }) : undefined
      const inserted = chooseAfterInsert(ctx, again.info.devices, probeAgain)
      refuseIfEnrolled(inserted, probeAgain)
      assertDeviceServesFactor(inserted)
      assertExcludeListFits(inserted, excludeCredentialIds.length)
      addingLine(inserted)
      enrolling = inserted
    }
    if (enrolling === undefined) throw new Error("factor add security-key: no enrolling device was decided")
    const target = enrolling
    // D4 step 6: the enrolling key's own session, its own `info` and snapshot, and its own PIN
    // prompt, worded apart from the opener's so two same-model keys are told apart at the prompt.
    session = await openSecurityKeySession(deps, {
      vaultId,
      envelopeId,
      deviceFlag: target.deviceId,
      requireFeatures: true,
      pinPrompt: (device) => `PIN for the key being added, ${device.product || "the security key"} (input hidden): `,
    })
  }

  const registered = await registerCredential(deps, session, { vaultId, envelopeId, excludeCredentialIds })
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
      // BE-337 (D6): the one additive key, the shape `vault backup` gave it (parity spec D9).
      openedWith,
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

/**
 * BE-337 (D3, refusals 1 and 2 use this for the probe half): the device's probe entry holds one of
 * the vault's credentials. `envelopeId` in the refusal names which. Skipped when there is no probe
 * answer for the device (the probe failed, or the device was not in that enumeration); refusal 3,
 * the authenticator's own answer under the PIN, still holds.
 */
function refuseIfEnrolled(device: DeviceReport, attached: AttachedKeys | undefined): void {
  const entry = attached?.devices?.find((candidate) => candidate.deviceId === device.deviceId)
  if (entry === undefined || attached?.credentials === undefined) return
  for (const [envelopeId, credentialId] of attached.credentials) {
    if (entry.present.includes(credentialId)) throw alreadyEnrolled(device, envelopeId)
  }
}

/**
 * BE-337 (D2): with a security key as the opener, which attached device answers the opener's
 * assertion and which is added, both decided before any PIN from the command's own `info` and
 * `probe`. The opening device: the one the probe placed the opener's credential on; else the one
 * device `--device` does not name; else (one key attached, and `--device` names it) that key, since
 * the opener's assertion can go nowhere else, which then meets refusal 1. Anything else is the
 * typed ambiguity refusal. A wrong guess costs nothing: the assertion names the credential, and a
 * device without it answers `VAULT_CREDENTIAL_NOT_PRESENT`.
 */
function planDevices(
  ctx: CommandContext,
  opener: Ctap2Envelope,
  devices: DeviceReport[],
  attached: AttachedKeys | undefined,
): { opening: DeviceReport; enrolling: DeviceReport | undefined } {
  const platform = ctx.deps.platform
  if (devices.length === 0) {
    throw new VaultError("VAULT_FACTOR_UNAVAILABLE", "No security key is attached.", {
      suggestion: "Plug the key in and run the command again. No other factor is substituted.",
    })
  }
  const named = ctx.vaultDevice
  const openerCredential = attached?.credentials?.get(opener.id)
  const holders =
    openerCredential === undefined
      ? []
      : (attached?.devices ?? []).filter((device) => device.present.includes(openerCredential))
  let opening: DeviceReport | undefined
  if (holders.length === 1) {
    opening = devices.find((device) => device.deviceId === (holders[0] as { deviceId: string }).deviceId)
  }
  if (opening === undefined) {
    const candidates = devices.filter((device) => device.deviceId !== named)
    if (candidates.length === 1) opening = candidates[0]
    else if (devices.length === 1) opening = devices[0]
  }
  if (opening === undefined) {
    throw new VaultError(
      "VAULT_AUTHENTICATOR_AMBIGUOUS",
      `${devices.length} security keys are attached and the one that opens the vault could not be told apart. Leave only the key that opens the vault attached; this command asks for the key to add after the vault is open.`,
      { suggestion: "Nothing was sent to any key. Run again with only the key that opens the vault attached." },
    )
  }
  if (!opening.readable) selectDevice([opening], undefined, platform)

  const others = devices.filter((device) => device.deviceId !== opening.deviceId)
  if (named !== undefined) {
    // D3 refusal 1, by locator: the key to add is the key that opens the vault.
    if (named === opening.deviceId) throw alreadyEnrolled(opening, opener.id)
    // The existing refusal when the named id is not attached, listing what is (besides the opener).
    return { opening, enrolling: selectDevice(others, named, platform) }
  }
  if (others.length === 1) return { opening, enrolling: selectDevice(others, undefined, platform) }
  if (others.length > 1) {
    const listing = others.map((device) => `  ${describeDeviceForList(device)}`).join("\n")
    throw new VaultError(
      "VAULT_AUTHENTICATOR_AMBIGUOUS",
      `${others.length} security keys are attached besides the one that opens the vault, and none was named, so nothing was sent to any of them:\n${listing}`,
      { suggestion: "Run again with --device <id> naming the key to add." },
    )
  }
  // Only the opening device is attached: the key to add is asked for after the vault is open.
  return { opening, enrolling: undefined }
}

/**
 * BE-337 (D2, deferred): the enumeration after the Enter prompt. One device attached is the
 * candidate, and refusal 2 decides whether it is the opener re-inserted. With several, a device
 * whose probe holds one of the vault's credentials is taken to be an opener and set aside; exactly
 * one other is the key to add. There is no second prompt.
 */
function chooseAfterInsert(
  ctx: CommandContext,
  devices: DeviceReport[],
  probe: AttachedKeys | undefined,
): DeviceReport {
  const platform = ctx.deps.platform
  if (devices.length === 0) {
    throw new VaultError(
      "VAULT_FACTOR_UNAVAILABLE",
      "No security key other than the one that opened the vault is attached. Nothing was written.",
      { suggestion: "Run the command again with the key to add inserted when asked." },
    )
  }
  if (devices.length === 1) return selectDevice(devices, undefined, platform)
  const holdsVault = (device: DeviceReport) =>
    (probe?.devices?.find((entry) => entry.deviceId === device.deviceId)?.present.length ?? 0) > 0
  const others = devices.filter((device) => !holdsVault(device))
  if (others.length === 1) return selectDevice(others, undefined, platform)
  if (others.length === 0) {
    throw new VaultError(
      "VAULT_FACTOR_UNAVAILABLE",
      "Every attached security key already holds one of this vault's credentials, so there is no key to add. Nothing was written.",
      { suggestion: "Run the command again with a security key this vault does not have inserted when asked." },
    )
  }
  const listing = others.map((device) => `  ${describeDeviceForList(device)}`).join("\n")
  throw new VaultError(
    "VAULT_AUTHENTICATOR_AMBIGUOUS",
    `${others.length} security keys are attached besides the one that opened the vault, so nothing was sent to any of them:\n${listing}`,
    { suggestion: "Run the command again with only the key to add inserted when asked. Nothing was written." },
  )
}
