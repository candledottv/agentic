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
 * Four factors exist as of PR G: the passphrase everywhere; the security key over CTAP2 on the
 * four shipping targets wherever the `candle-fido2` helper is present; the Secure Enclave on
 * macOS, only in a build whose release policy ships the signed helper, only where that helper is
 * present, passes its code signature check and reports an Enclave; and the synced passkey over
 * the native macOS API (BE-135, AD-2), which needs everything the Enclave needs plus macOS 15 or
 * later and a helper whose own entitlements carry the associated domain and whose bundle embeds
 * a provisioning profile. Each missing gate is its own typed reason, before any ceremony.
 */
import type { Deps } from "../deps"
import {
  type BiometryState,
  type BiometryType,
  type LaErrorReport,
  PASSKEY_ASSOCIATED_DOMAIN,
  PASSKEY_MIN_OS_MAJOR,
} from "../enclave-helper/protocol"
import { VaultError, type VaultErrorCode } from "./errors"
import type { Envelope, KnownFactor } from "./format"

/** CC-12's Linux sentence, printed verbatim with `VAULT_AUTHENTICATOR_NOT_READABLE` (T58). */
export const HIDRAW_MESSAGE =
  "A security key is attached but this user cannot open its hidraw device. Install libfido2's udev rules (70-u2f.rules) or add a rule for this key, unplug and replug it, then retry."

/** The release targets E24 records. T58 asserts the release workflow has not silently gained one. */
export const SHIPPING_TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const

/**
 * The AD-1 signed macOS helper, as `vault/enclave.ts` found it for this run (BE-141). `omitted`
 * is the checked-in release policy saying this build ships no signed helper; `absent` is a
 * `signed` build with no bundle on disk; `untrusted` is a bundle that failed the codesign
 * requirement or whose own signature names another team or bundle id; `ready` carries what the
 * verified helper reported about this Mac.
 */
export type EnclaveHelperState =
  | { state: "omitted"; reason: string }
  | { state: "absent"; reason: string }
  | { state: "untrusted"; reason: string }
  | { state: "unavailable"; reason: string; code: "VAULT_HELPER_MISSING" | "VAULT_FACTOR_UNAVAILABLE" }
  | {
      state: "ready"
      appPath: string
      path: string
      source: "env" | "beside-binary" | "libexec"
      identity: { teamId: string; bundleId: string }
      version: string
      secureEnclave: boolean
      biometry: BiometryState
      biometryReason?: string
      biometryType?: BiometryType
      laError?: LaErrorReport
      /** The macOS major version the helper reported (BE-135); undefined from a helper that reports none. */
      osMajor?: number
      /** The helper's own associated-domains entitlement (BE-135); empty from an unsigned or PR F helper. */
      associatedDomains: string[]
      /** Whether the bundle embeds a provisioning profile (BE-135). */
      provisioningProfile: boolean
    }

export interface PlatformFacts {
  /** `process.platform`. */
  platform: string
  /** `process.arch`. */
  arch: string
  /** The major OS version, when it can be read; undefined when it cannot. */
  osMajor?: number
  /** The AD-1 signed macOS helper (PRs F and G), summarized; `enclaveHelper` has the detail. */
  helper?: "absent" | "untrusted" | "ready"
  /** The `candle-fido2` helper (PR E): where it was found, or why it was not. */
  fido2Helper?: { state: "ready"; path: string } | { state: "absent"; reason: string }
  /** The signed Secure Enclave helper (PR F): policy, location, signature and what it reported. */
  enclaveHelper?: EnclaveHelperState
  /** Whether this machine has a Secure Enclave, as the AD-1 helper reported it. */
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
  enclaveHelper?: EnclaveHelperState,
): PlatformFacts {
  return {
    platform: deps.platform,
    arch: deps.arch,
    helper: enclaveHelper?.state === "ready" ? "ready" : enclaveHelper?.state === "untrusted" ? "untrusted" : "absent",
    fido2Helper,
    ...(enclaveHelper !== undefined ? { enclaveHelper } : {}),
    ...(enclaveHelper?.state === "ready" ? { secureEnclave: enclaveHelper.secureEnclave } : {}),
    // The OS version comes from the verified helper (BE-135); the fake overrides it for T58.
    ...(enclaveHelper?.state === "ready" && enclaveHelper.osMajor !== undefined
      ? { osMajor: enclaveHelper.osMajor }
      : {}),
    ...(deps.env.CANDLE_VAULT_FAKE_OS_MAJOR ? { osMajor: Number(deps.env.CANDLE_VAULT_FAKE_OS_MAJOR) } : {}),
  }
}

export type FactorAvailability =
  | { state: "available" }
  /**
   * Supported on this platform in principle; not drivable on this machine right now. `code` says
   * which typed refusal asking for it explicitly gets: the helper is missing, or the device is.
   */
  | {
      state: "unavailable-on-this-device"
      reason: string
      code: "VAULT_HELPER_MISSING" | "VAULT_HELPER_UNTRUSTED" | "VAULT_FACTOR_UNAVAILABLE"
    }
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
      if (transport === "platform-macos") return platformPasskeyAvailability(facts)
      return { state: "unsupported-on-this-platform", reason: `this CLI does not know the transport ${transport}` }
    }
    case "secure-enclave":
      return secureEnclaveAvailability(facts)
    default:
      return { state: "unsupported-on-this-platform", reason: `this CLI does not know the factor ${factor}` }
  }
}

/**
 * CC-12's Secure Enclave column: macOS only; a build whose policy omits the signed helper cannot
 * drive it anywhere; a signed build needs the helper present and trusted; and the helper decides
 * whether this Mac has an Enclave (every Apple silicon Mac; Intel only with a T2 chip).
 */
function secureEnclaveAvailability(facts: PlatformFacts): FactorAvailability {
  if (facts.platform !== "darwin") {
    return { state: "unsupported-on-this-platform", reason: "the Secure Enclave is macOS only" }
  }
  const helper = facts.enclaveHelper ?? { state: "omitted" as const, reason: "the signed helper was not looked for" }
  switch (helper.state) {
    case "omitted":
      return { state: "unsupported-on-this-platform", reason: helper.reason }
    case "absent":
      return { state: "unavailable-on-this-device", reason: helper.reason, code: "VAULT_HELPER_MISSING" }
    case "unavailable":
      return { state: "unavailable-on-this-device", reason: helper.reason, code: helper.code }
    case "untrusted":
      return { state: "unavailable-on-this-device", reason: helper.reason, code: "VAULT_HELPER_UNTRUSTED" }
    default:
      if (!helper.secureEnclave) {
        return {
          state: "unsupported-on-this-platform",
          reason: "this Mac has no Secure Enclave (an Intel Mac without a T2 chip)",
        }
      }
      return { state: "available" }
  }
}

/**
 * CC-12's synced passkey column (BE-135, AD-2's gates): macOS only; a build whose policy omits the
 * signed helper cannot drive it; the helper must be present and trusted; and then, from what the
 * verified helper reported about itself and this Mac, macOS 15 or later, the associated-domains
 * entitlement for `webcredentials:cli.candle.tv`, and an embedded provisioning profile. Each
 * missing gate is its own reason. The `apple-app-site-association` on the domain is the one gate
 * not decided here: `factor add passkey` checks it before the ceremony, and at unlock the system's
 * own association check answers, translated to a typed refusal that says what must be served.
 */
function platformPasskeyAvailability(facts: PlatformFacts): FactorAvailability {
  if (facts.platform !== "darwin") {
    return { state: "unsupported-on-this-platform", reason: "the synced passkey transport is macOS only" }
  }
  const helper = facts.enclaveHelper ?? { state: "omitted" as const, reason: "the signed helper was not looked for" }
  switch (helper.state) {
    case "omitted":
      return {
        state: "unsupported-on-this-platform",
        reason:
          "this build's release policy omits the signed macOS helper (release-policy.json: macosHelper.release is omit), so the synced passkey factor is not in this build; it arrives in CLI 0.13.0 (PR G) once Apple approves the Developer ID enrolment and T57 has passed",
      }
    case "absent":
      return { state: "unavailable-on-this-device", reason: helper.reason, code: "VAULT_HELPER_MISSING" }
    case "unavailable":
      return { state: "unavailable-on-this-device", reason: helper.reason, code: helper.code }
    case "untrusted":
      return { state: "unavailable-on-this-device", reason: helper.reason, code: "VAULT_HELPER_UNTRUSTED" }
    default: {
      const osMajor = facts.osMajor ?? helper.osMajor
      if (osMajor === undefined) {
        return {
          state: "unsupported-on-this-platform",
          reason: `the helper at ${helper.appPath} (version ${helper.version}) does not report the macOS version, so this CLI cannot establish macOS ${PASSKEY_MIN_OS_MAJOR} or later; reinstall the CLI so candle and candle-enclave.app come from the same release`,
        }
      }
      if (osMajor < PASSKEY_MIN_OS_MAJOR) {
        return {
          state: "unsupported-on-this-platform",
          reason: `the synced passkey factor needs macOS ${PASSKEY_MIN_OS_MAJOR} or later (the platform PRF extension arrived there); this Mac runs macOS ${osMajor}`,
        }
      }
      if (!helper.associatedDomains.includes(PASSKEY_ASSOCIATED_DOMAIN)) {
        return {
          state: "unsupported-on-this-platform",
          reason: `the helper at ${helper.appPath} lacks the associated-domains entitlement for ${PASSKEY_ASSOCIATED_DOMAIN} (its entitlements list ${helper.associatedDomains.length > 0 ? helper.associatedDomains.join(", ") : "no associated domain"}); a release built with the entitlement and a provisioning profile is required`,
        }
      }
      if (!helper.provisioningProfile) {
        return {
          state: "unsupported-on-this-platform",
          reason: `the helper at ${helper.appPath} embeds no provisioning profile (Contents/embedded.provisionprofile), which the associated-domains entitlement needs under Developer ID; a release built with the profile is required`,
        }
      }
      return { state: "available" }
    }
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
      suggestion: `${addSuggestion(factor, transport, availability)} No other factor is substituted and nothing was written.`,
    },
  )
}

function addSuggestion(
  factor: KnownFactor,
  transport: string | undefined,
  availability: Exclude<FactorAvailability, { state: "available" }>,
): string {
  if (availability.state !== "unavailable-on-this-device") return ""
  // The Enclave and the synced passkey share the signed helper; the security key has its own.
  const signedHelper = factor === "secure-enclave" || (factor === "passkey-prf" && transport === "platform-macos")
  if (signedHelper) {
    return availability.code === "VAULT_HELPER_UNTRUSTED"
      ? "Reinstall the CLI from a release so candle-enclave.app carries the release's signature."
      : "Install a release build of the CLI that ships the signed helper (the darwin tarball and Homebrew place candle-enclave.app beside candle), or set CANDLE_ENCLAVE_HELPER to the path of a signed candle-enclave.app."
  }
  return "Install a release build of the CLI (which places candle-fido2 beside candle) or set CANDLE_FIDO2_HELPER."
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
