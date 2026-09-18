/**
 * Ember Phase 2 (BE-136, BE-140, CC-12): the platform seam.
 *
 * CC-12's rule is one sentence: a factor a platform does not support is refused with a typed code,
 * never silently replaced by another derivation. The CLI never picks a different envelope on the
 * user's behalf; it lists the envelopes that can open the vault HERE and stops.
 *
 * Everything the rule reads (platform, architecture, OS version, Secure Enclave presence, helper
 * state) goes through `PlatformFacts`, built from injected `Deps`, so the whole refusal matrix is
 * exercisable under `bun test` on any host (T58). The real-hardware rows stay T47, T48 and T57.
 *
 * As of PR E two factors exist: the passphrase everywhere, and the security key over CTAP2 on the
 * four shipping targets wherever the `candle-fido2` helper is present. The Secure Enclave and the
 * synced passkey are named by the format (ED-7 keeps their envelopes) and reported as not yet
 * available, with the PR that adds each one named in the reason.
 */
import type { Deps } from "../deps"
import { VaultError, type VaultErrorCode } from "./errors"
import type { Envelope, KnownFactor } from "./format"

/** CC-12's Linux sentence, printed verbatim with `VAULT_AUTHENTICATOR_NOT_READABLE` (T58). */
export const HIDRAW_MESSAGE =
  "A security key is attached but this user cannot open its hidraw device. Install libfido2's udev rules (70-u2f.rules) or add a rule for this key, unplug and replug it, then retry."

/** The release targets E24 records. T58 asserts the release workflow has not silently gained one. */
export const SHIPPING_TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const

export interface PlatformFacts {
  /** `process.platform`. */
  platform: string
  /** `process.arch`. */
  arch: string
  /** The major OS version, when it can be read; undefined when it cannot. */
  osMajor?: number
  /** The AD-1 signed macOS helper (PRs F and G). Always absent in PR E. */
  helper?: "absent" | "untrusted" | "ready"
  /** The `candle-fido2` helper (PR E): where it was found, or why it was not. */
  fido2Helper?: { state: "ready"; path: string } | { state: "absent"; reason: string }
  /** Whether this machine has a Secure Enclave, as the AD-1 helper would report it. */
  secureEnclave?: boolean
}

/**
 * The facts for this run, from the injected seam. The helper location is the one input that
 * touches the filesystem, so the caller resolves it (`fido2.ts`'s `currentPlatformFacts` does both)
 * and it stays injectable through `deps.env` (`CANDLE_FIDO2_HELPER`) and `deps.execPath`, which is
 * how T58 drives every row on one host.
 */
export function platformFactsFor(
  deps: Pick<Deps, "platform" | "arch" | "env">,
  fido2Helper: PlatformFacts["fido2Helper"],
): PlatformFacts {
  return {
    platform: deps.platform,
    arch: deps.arch,
    helper: "absent",
    fido2Helper,
    ...(deps.env.CANDLE_VAULT_FAKE_OS_MAJOR ? { osMajor: Number(deps.env.CANDLE_VAULT_FAKE_OS_MAJOR) } : {}),
  }
}

export type FactorAvailability =
  | { state: "available" }
  /**
   * Supported on this platform in principle; not drivable on this machine right now. `code` says
   * which typed refusal asking for it explicitly gets: the helper is missing, or the device is.
   */
  | { state: "unavailable-on-this-device"; reason: string; code: "VAULT_HELPER_MISSING" | "VAULT_FACTOR_UNAVAILABLE" }
  /** This platform cannot drive the factor at all. */
  | { state: "unsupported-on-this-platform"; reason: string }

function shippingPlatform(facts: PlatformFacts): boolean {
  return facts.platform === "darwin" || facts.platform === "linux"
}

/**
 * Whether this build, on this machine, can drive `factor` over `transport`. The PR gates are part
 * of the answer rather than a separate check: a factor whose code has not shipped is not drivable
 * here, and saying "not in this release (PR F)" is more useful than "unsupported".
 */
export function factorAvailability(factor: string, facts: PlatformFacts, transport?: string): FactorAvailability {
  if (factor === "passphrase") return { state: "available" }

  const mac = facts.platform === "darwin"
  switch (factor) {
    case "passkey-prf": {
      if (transport === undefined || transport === "ctap2") {
        // CC-12's security key column: every shipping target, given hidraw access on Linux (which
        // surfaces at operation time as VAULT_AUTHENTICATOR_NOT_READABLE) and the bundled helper.
        if (!shippingPlatform(facts)) {
          return {
            state: "unsupported-on-this-platform",
            reason: `this CLI ships no binary for ${facts.platform}, and security keys there belong to the platform spec (BE-124)`,
          }
        }
        const helper = facts.fido2Helper ?? { state: "absent", reason: "the candle-fido2 helper was not looked for" }
        if (helper.state === "absent") {
          return { state: "unavailable-on-this-device", reason: helper.reason, code: "VAULT_HELPER_MISSING" }
        }
        return { state: "available" }
      }
      if (transport === "platform-macos") {
        return {
          state: "unsupported-on-this-platform",
          reason: mac
            ? "the synced passkey factor arrives in CLI 0.13.0 (PR G)"
            : "the synced passkey transport is macOS only",
        }
      }
      return { state: "unsupported-on-this-platform", reason: `this CLI does not know the transport ${transport}` }
    }
    case "secure-enclave":
      return {
        state: "unsupported-on-this-platform",
        reason: mac
          ? "this release ships no signed macOS helper; the Secure Enclave factor arrives in CLI 0.12.0 (PR F)"
          : "the Secure Enclave is macOS only",
      }
    default:
      return { state: "unsupported-on-this-platform", reason: `this CLI does not know the factor ${factor}` }
  }
}

/** The availability of the factor an envelope names, for `status`, `factor list` and unlock. */
export function envelopeAvailability(envelope: Envelope, facts: PlatformFacts): FactorAvailability {
  return factorAvailability(
    envelope.factor,
    facts,
    typeof envelope.transport === "string" ? envelope.transport : undefined,
  )
}

/** True when this build can actually unlock with the envelope. Nothing else offers one. */
export function canDrive(envelope: Envelope, facts: PlatformFacts): boolean {
  return envelopeAvailability(envelope, facts).state === "available"
}

/** The typed code an explicit request for an envelope in `availability` gets (CC-12). */
export function refusalCodeFor(availability: Exclude<FactorAvailability, { state: "available" }>): VaultErrorCode {
  return availability.state === "unavailable-on-this-device"
    ? availability.code
    : "VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM"
}

/**
 * CC-12's `factor add` refusal. Typed, with the reason in the message, and never a fallback to
 * another factor.
 */
export function assertFactorAddable(factor: KnownFactor, facts: PlatformFacts, transport?: string): void {
  const availability = factorAvailability(factor, facts, transport)
  if (availability.state === "available") return
  const name = transport ? `${factor}/${transport}` : factor
  throw new VaultError(
    refusalCodeFor(availability),
    `This CLI cannot add a ${name} factor here: ${availability.reason}.`,
    {
      suggestion:
        availability.state === "unavailable-on-this-device" && availability.code === "VAULT_HELPER_MISSING"
          ? "Install a release build of the CLI (which places candle-fido2 beside candle) or set CANDLE_FIDO2_HELPER. No other factor is substituted and nothing was written."
          : "No other factor is substituted and nothing was written.",
    },
  )
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
