/**
 * Ember Phase 2 (BE-136, CC-12): the platform seam.
 *
 * CC-12's rule is one sentence: a factor a platform does not support is refused with a typed code,
 * never silently replaced by another derivation. The CLI never picks a different envelope on the
 * user's behalf; it lists the envelopes that can open the vault HERE and stops.
 *
 * Everything the rule reads (platform, architecture, OS version, Secure Enclave presence, helper
 * state) goes through `PlatformFacts`, injected, so the whole refusal matrix is exercisable under
 * `bun test` on any host (T58, PR E). The real-hardware rows stay T47, T48 and T57.
 *
 * In THIS release only the passphrase factor exists anywhere. The other three are named by the
 * format (ED-7 keeps their envelopes) and are reported as not yet available, with the PR that adds
 * each one named in the reason, which is the honest answer: PR A ships no CTAP2 transport, no
 * signed helper and no AuthenticationServices binding, so there is nothing for a Mac to be good
 * enough FOR yet.
 */
import { VaultError } from "./errors"
import type { Envelope, KnownFactor } from "./format"

export interface PlatformFacts {
  /** `process.platform`. */
  platform: string
  /** `process.arch`. */
  arch: string
  /** The major OS version, when it can be read; undefined when it cannot. */
  osMajor?: number
  /** Whether the AD-1 helper is installed and passed its signature check. Always false in PR A. */
  helper?: "absent" | "untrusted" | "ready"
  /** Whether this machine has a Secure Enclave, as the helper would report it. */
  secureEnclave?: boolean
}

export function realPlatformFacts(env: Record<string, string | undefined>): PlatformFacts {
  return {
    platform: process.platform,
    arch: process.arch,
    // The helper lands in PR F; until then its absence is the only truthful answer, and
    // `CANDLE_FIDO2_HELPER` is read by PR E rather than here.
    helper: "absent",
    ...(env.CANDLE_VAULT_FAKE_OS_MAJOR ? { osMajor: Number(env.CANDLE_VAULT_FAKE_OS_MAJOR) } : {}),
  }
}

export type FactorAvailability =
  | { state: "available" }
  /** Supported on this platform in principle; the device is not here (an Enclave key from another Mac). */
  | { state: "unavailable-on-this-device"; reason: string }
  /** This platform cannot drive the factor at all. */
  | { state: "unsupported-on-this-platform"; reason: string }

/**
 * Whether this build, on this machine, can drive `factor`. The PR gates are part of the answer
 * rather than a separate check: a factor whose code has not shipped is not drivable here, and
 * saying "not in this release (PR E)" is more useful than "unsupported".
 */
export function factorAvailability(factor: string, facts: PlatformFacts): FactorAvailability {
  if (factor === "passphrase") return { state: "available" }

  const mac = facts.platform === "darwin"
  switch (factor) {
    case "passkey-prf":
      // PR E (security key over CTAP2) and PR G (synced passkey) both write this factor; neither
      // has shipped, so every host says the same thing and no host is told to try anyway.
      return {
        state: "unsupported-on-this-platform",
        reason:
          "this release has no security key or passkey transport; the security key factor arrives in CLI 0.11.0 and the synced passkey factor in 0.13.0",
      }
    case "secure-enclave":
      return {
        state: "unsupported-on-this-platform",
        reason: mac
          ? "this release ships no signed macOS helper; the Secure Enclave factor arrives in CLI 0.12.0"
          : "the Secure Enclave is macOS only",
      }
    default:
      return { state: "unsupported-on-this-platform", reason: `this CLI does not know the factor ${factor}` }
  }
}

/** The availability of the factor an envelope names, for `status` and `factor list`. */
export function envelopeAvailability(envelope: Envelope, facts: PlatformFacts): FactorAvailability {
  return factorAvailability(envelope.factor, facts)
}

/** True when this build can actually unlock with the envelope. Nothing else offers one. */
export function canDrive(envelope: Envelope, facts: PlatformFacts): boolean {
  return envelopeAvailability(envelope, facts).state === "available"
}

/**
 * CC-12's `factor add` refusal. Typed, with the reason in the message, and never a fallback to
 * another factor.
 */
export function assertFactorAddable(factor: KnownFactor, facts: PlatformFacts): void {
  const availability = factorAvailability(factor, facts)
  if (availability.state === "available") return
  const code =
    availability.state === "unavailable-on-this-device"
      ? "VAULT_FACTOR_UNAVAILABLE"
      : "VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM"
  throw new VaultError(code, `This CLI cannot add a ${factor} factor here: ${availability.reason}.`, {
    suggestion: "No other factor is substituted and nothing was written.",
  })
}

/** The word `status` and `factor list` print for an envelope's availability. */
export function availabilityLabel(availability: FactorAvailability): string {
  switch (availability.state) {
    case "available":
      return "available"
    case "unavailable-on-this-device":
      return "unavailable-on-this-device"
    default:
      return "unsupported-on-this-platform"
  }
}
