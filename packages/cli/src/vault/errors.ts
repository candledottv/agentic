/**
 * Ember Phase 2 (BE-136): the stable error codes the spec's Interfaces section lists, and the one
 * error type every vault refusal is thrown as.
 *
 * The codes are a contract with an agent reading `--json`, so they live in one frozen list rather
 * than as string literals at the throw sites: a code that only exists at one `throw` is a code
 * nothing can be tested against. `VaultError` carries the code, the human line, and an optional
 * fix; `render.ts`'s `writeLocalFailure` is what turns it into either shape of output.
 *
 * Every code the spec names is listed, including the ones PRs B to G throw, so that the list is
 * the spec's list and a later PR adds a throw rather than a code. `VAULT_ERROR_CODES` is what the
 * test asserts against the spec document.
 */

export const VAULT_ERROR_CODES = [
  "VAULT_MISSING",
  "VAULT_EXISTS",
  "VAULT_UNREADABLE",
  "VAULT_FORMAT_UNKNOWN",
  "VAULT_VERSION_UNSUPPORTED",
  "VAULT_FIELD_UNKNOWN",
  "VAULT_KDF_OUT_OF_BOUNDS",
  "VAULT_UNLOCK_FAILED",
  "VAULT_BLOB_TAMPERED",
  "VAULT_INDEX_INVALID",
  "VAULT_OLDER_COPY",
  "VAULT_LOCKED",
  "VAULT_CHANGED",
  "VAULT_WRITE_FAILED",
  "VAULT_VERIFY_FAILED",
  "VAULT_NO_RECOVERABLE_FACTOR",
  "VAULT_LAST_PASSPHRASE",
  "VAULT_FACTOR_UNAVAILABLE",
  "VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM",
  "VAULT_AUTHENTICATOR_NOT_READABLE",
  "VAULT_PRF_UNSUPPORTED",
  "VAULT_UV_UNSUPPORTED",
  "VAULT_PIN_REQUIRED",
  "VAULT_PIN_INVALID",
  "VAULT_AUTHENTICATOR_BLOCKED",
  "VAULT_AUTHENTICATOR_CANCELLED",
  "VAULT_CREDENTIAL_NOT_PRESENT",
  "VAULT_AUTHENTICATOR_AMBIGUOUS",
  "VAULT_AUTHENTICATOR_CHANGED",
  "VAULT_HELPER_MISSING",
  "VAULT_HELPER_UNTRUSTED",
  "VAULT_SHARED_DOMAIN",
  "VAULT_BACKUP_INSIDE_CONFIG",
  "ENV_PASSPHRASE_REFUSED",
  "COMMAND_REMOVED",
  "CHAIN_NOT_OFFERED",
  "DESTINATION_NOT_CONFIRMED",
  "PHRASE_REQUIRES_TTY",
  "PHRASE_INVALID",
  "PHRASE_NOT_CONFIRMED",
  "PROMOTE_NOT_VAULT_KEY",
  "PROMOTE_ALREADY_TEE_WALLET",
  "PROMOTE_SAME_KEY_DESTINATION",
  "PROMOTE_KEY_IS_PINNED_DESTINATION",
  "PROMOTE_DESTINATION_NOT_COLD",
  "PROMOTE_SUBJECT_EXPOSURE_UNKNOWN",
  "PROMOTE_RECONCILE_INCOMPLETE",
  "PROMOTE_OUTCOME_UNRESOLVED",
  "PROMOTE_NOT_ACKNOWLEDGED",
  "GRANT_IDENTITY_MISMATCH",
  "GRANT_BINDING_MISMATCH",
  "GRANT_DESTINATION_UNRESOLVED",
  "VAULT_ALLOCATION_BOUNDARY_UNKNOWN",
  "EXPOSURE_ACCOUNT_MISMATCH",
  "EXPORT_TARGET_EXISTS",
  "EXPORT_TARGET_SYMLINK",
  "LEGACY_INCOMPLETE",
  "LEGACY_UNVERIFIED_BACKUP",
  // Ember Phase 3 PR F (BE-226, R6): `candle sign` and `candle sign message`. The refusals are
  // structural and run before any prompt; `--yes` skips the confirmation and none of them.
  "SIGN_SIGNER_NOT_EXTERNAL",
  "SIGN_SIGNER_NOT_PROVIDED",
  "SIGN_SIMULATION_FAILED",
  "SIGN_LOOKUP_TABLE_UNRESOLVED",
  "SIGN_TRANSACTION_UNDECODABLE",
  "SIGN_BROADCAST_FAILED",
] as const

export type VaultErrorCode = (typeof VAULT_ERROR_CODES)[number]

/**
 * A refusal with a stable code. Every vault code path throws this and nothing else, so a command
 * can map one catch to one failure envelope instead of guessing at a message.
 *
 * `exitCode` follows the Phase 1 convention the spec's Interfaces section restates: 1 failure,
 * 2 usage, 3 pending or partial. It defaults to 1 because that is what almost every refusal is.
 */
export class VaultError extends Error {
  readonly code: VaultErrorCode
  readonly suggestion?: string
  readonly exitCode: 1 | 2 | 3

  constructor(code: VaultErrorCode, message: string, opts: { suggestion?: string; exitCode?: 1 | 2 | 3 } = {}) {
    super(message)
    this.name = "VaultError"
    this.code = code
    this.suggestion = opts.suggestion
    this.exitCode = opts.exitCode ?? 1
  }
}

export function isVaultError(error: unknown): error is VaultError {
  return error instanceof VaultError
}
