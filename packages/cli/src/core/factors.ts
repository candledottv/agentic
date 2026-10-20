/**
 * Which vault factors the core can use on this machine (BE-1680, spec S4 F-1 to F-3). The same
 * availability logic as the CLI's unlock (`vault/platform.ts`'s `envelopeAvailability`, over the
 * facts `currentPlatformFacts` reads), so the TUI's picker and `candle vault status` agree.
 *
 * Pure: the vault's envelopes (from its clear header, no unlock) and the platform facts go in, the
 * picker's list comes out, usable first. Two rules are the core's own:
 *
 *   - Touch ID and the synced passkey are listed as not usable even where the CLI could drive them,
 *     until S1's V-2 shows their helper can be driven from a long-running core (F-3, D-E default A).
 *     On a build whose release policy omits the helper, the CLI's own reason ("not in this build")
 *     is what the user reads.
 *   - Touch ID is always listed, enrolled or not, so a machine without it says why (F-2).
 */
import type { Envelope } from "../vault/format"
import {
  isCtap2Envelope,
  isPassphraseEnvelope,
  isPlatformPasskeyEnvelope,
  isSecureEnclaveEnvelope,
} from "../vault/format"
import { envelopeAvailability, factorAvailability, type PlatformFacts } from "../vault/platform"
import type { FactorOption, FactorType } from "./trading"

/** F-3: the reason Touch ID and the passkey are not offered by the core until V-2 passes. */
export const CORE_HELPER_REASON =
  "not driven from the Candle core in this build (it waits on the core helper check, V-2)"

export function factorOptions(envelopes: readonly Envelope[], facts: PlatformFacts): FactorOption[] {
  const options = new Map<FactorType, FactorOption>()
  const offer = (option: FactorOption) => {
    const held = options.get(option.type)
    // One row per kind: a usable envelope of a kind wins over an unusable one.
    if (held === undefined || (!held.usable && option.usable)) options.set(option.type, option)
  }
  for (const envelope of envelopes) {
    if (isPassphraseEnvelope(envelope)) {
      offer({ type: "passphrase", usable: true })
      continue
    }
    const availability = envelopeAvailability(envelope, facts)
    const reason = availability.state === "available" ? undefined : availability.reason
    if (isCtap2Envelope(envelope)) {
      offer(
        reason === undefined ? { type: "security-key", usable: true } : { type: "security-key", usable: false, reason },
      )
    } else if (isSecureEnclaveEnvelope(envelope)) {
      offer({ type: "touch-id", usable: false, reason: reason ?? CORE_HELPER_REASON })
    } else if (isPlatformPasskeyEnvelope(envelope)) {
      offer({ type: "passkey", usable: false, reason: reason ?? CORE_HELPER_REASON })
    }
  }
  if (!options.has("passphrase")) offer({ type: "passphrase", usable: true })
  if (!options.has("touch-id")) {
    const availability = factorAvailability("secure-enclave", facts)
    offer({
      type: "touch-id",
      usable: false,
      reason: availability.state === "available" ? "not enrolled in this vault" : availability.reason,
    })
  }
  const all = [...options.values()]
  return [...all.filter((option) => option.usable), ...all.filter((option) => !option.usable)]
}

/**
 * The CLI's vault error codes, sorted into F-2's two answers: a wrong factor (counts toward the
 * lockout) or a factor that could not be used just now (back to the picker, counts nothing).
 */
export function factorFailureKind(code: string): "rejected" | "unavailable" | undefined {
  if (code === "VAULT_UNLOCK_FAILED" || code === "VAULT_PIN_INVALID") return "rejected"
  if (
    code === "VAULT_FACTOR_UNAVAILABLE" ||
    code === "VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM" ||
    code === "VAULT_HELPER_MISSING" ||
    code === "VAULT_HELPER_UNTRUSTED" ||
    code === "VAULT_PIN_REQUIRED" ||
    code === "VAULT_CREDENTIAL_NOT_PRESENT" ||
    code === "VAULT_PRF_UNSUPPORTED" ||
    code === "VAULT_UV_UNSUPPORTED" ||
    code.startsWith("VAULT_AUTHENTICATOR_")
  ) {
    return "unavailable"
  }
  return undefined
}
