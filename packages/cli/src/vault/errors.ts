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
  // "COMMAND_REMOVED" was the 0.10.0 tombstone for `wallets generate` / `wallets export`. Both
  // handlers were removed in 0.11.1 (BE-238, D6), so nothing throws it -- and by this file's own
  // rule, a code nothing throws is a code nothing can be tested against.
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
  // BE-259 (spec 2026-09-22-cli-vault-key-naming-design.md, D11): `candle vault rename`. Every one
  // is decided after the unlock, about the vault's state, so every one is exit 1; each is thrown
  // by exactly one site in `commands/vault-rename.ts`.
  "VAULT_LABEL_NOT_FOUND",
  "VAULT_LABEL_AMBIGUOUS",
  "VAULT_LABEL_TAKEN",
  "VAULT_LABEL_UNCHANGED",
  "VAULT_RENAME_ROLE_REFUSED",
  // BE-285 (spec 2026-09-22-cli-vault-promote-batch-design.md, D7): `candle vault promote-batch`'s
  // one new code. The whole-set preflight refuses with it and lists every failing row, each row
  // carrying its OWN shipped `PROMOTE_*` code unchanged. Thrown nowhere: the report is returned and
  // rendered by `writeBatchRefusal`, because `VaultError.details` cannot carry a row list.
  "PROMOTE_BATCH_REFUSED",
  // BE-288 (spec 2026-09-23-linked-wallet-cap-before-import-design.md, D7, D8): the room read
  // `vault promote` and `vault promote-batch` make before they commit anything locally. The first
  // two reuse the server's strings on purpose, so an agent that already branches on the server's
  // `WALLET_LIMIT_REACHED` gets the same code whether the CLI or the server refused. All three are
  // thrown from `vault/account-room.ts`.
  "WALLET_LIMIT_REACHED",
  "TIER_REQUIRED",
  "LINKED_WALLET_ROOM_UNREADABLE",
  // BE-296 (spec 2026-09-23-cli-vault-promote-confirm-design.md, D5): the live read of which
  // Candle account the API key acts for, made by `vault promote --in-place` and
  // `vault promote-batch` before anything is printed or written. It never falls back to the
  // cached profile account: the block it feeds exists only because it is live. Thrown from
  // `vault/promote-support.ts` (`readControlledBy`).
  "PROMOTE_ACCOUNT_UNRESOLVED",
  // BE-326 (Phase 2 ED-10 amendment, 2026-09-24): `vault transfer` from a promoted wallet refuses
  // while a sweep of that wallet is pending, before anything is signed. Thrown from
  // `vault/tee-transfer.ts`.
  "TRANSFER_SWEEP_PENDING",
  // BE-337 (spec 2026-09-24-cli-security-key-authorizes-factor-add-design.md, D3): `vault factor
  // add security-key` refuses to enroll a key that already holds one of this vault's credentials,
  // by locator, by the silent probe, or by the authenticator's own exclude-list answer. Thrown from
  // `vault/fido2.ts` (`alreadyEnrolled`) and nowhere else; exit 1.
  "VAULT_KEY_ALREADY_ENROLLED",
  // BE-350 (spec 2026-09-24-ember-phase-4a-evm-vault-keys-design.md, D3, D6): EVM vault keys.
  // The pre-sign refusals of `vault transfer` from an EVM key, each exit 1 with no signature,
  // thrown from `vault/evm-transfer.ts`; `EVM_TRANSFER_REVERTED` and the post-sign
  // `EVM_NONCE_STALE` are the two that carry a hash in `details`. `TRANSFER_CHAIN_MISMATCH` is a
  // destination of the wrong chain family for `--from`'s chain, before any read.
  // `SOLANA_COMMAND_EVM_KEY` is the Solana-only filter: `fund`, `promote`, `promote-batch`,
  // `demote`, `tee`, `external sweep` and `sign` refuse an EVM entry named to them (D3), thrown
  // from `vault/promote-support.ts` (`assertNotEvmEntry`).
  "EVM_CHAIN_MISMATCH",
  "EVM_NONCE_STALE",
  "EVM_TOKEN_UNREADABLE",
  "EVM_AMOUNT_PRECISION",
  "EVM_INSUFFICIENT_FOR_FEES",
  "EVM_DESTINATION_INVALID",
  "EVM_SELF_TRANSFER",
  "EVM_RECIPIENT_IS_TOKEN",
  "EVM_TRANSFER_REVERTED",
  "TRANSFER_CHAIN_MISMATCH",
  "SOLANA_COMMAND_EVM_KEY",
  // BE-355 (spec 2026-09-24-cli-default-solana-rpc-design.md, D3): the Solana RPC rate-limited a
  // read, the one retry was rate-limited too, and nothing has been signed. Exit 1, thrown from
  // `solana-endpoint.ts` (`rpcRateLimitedError`) by the vault and TEE commands; the trading
  // commands throw a `TradingError` with the same code. After a signature the same code travels
  // with exit 3 and the local signature (D4), never an automatic re-send.
  "RPC_RATE_LIMITED",
  // BE-391 (spec 2026-09-24-ember-phase-4b-hood-tee-wallets-design.md, D1): Hood TEE wallet custody.
  // `EVM_RECORD_ENTRY_TOO_LONG`: a sealed EVM record entry over 160 bytes is refused, never
  // truncated (`vault/evm-record-key.ts`); an append turns it into a skipped append and a notice.
  // `EVM_SWEEP_NEEDS_GAS`: an EVM sweep with ERC-20 balances and no ETH for the gas, naming the
  // shortfall and the `vault fund` command. `EVM_SWEEP_INCOMPLETE`: a sweep that ran but did not
  // observe the wallet empty, or skipped a source it needed (exit 3). `WALLET_BUSY`: a local signer
  // refusing while the D4 per-wallet lock is held, with the operation id. `WALLET_LOCK_UNKNOWN`: the
  // same signer refusing closed when that lock cannot be read. `EVM_RECORD_UNAVAILABLE`: `vault
  // backup` could not take the sealed record's lock, so no verified backup is recorded.
  "EVM_RECORD_ENTRY_TOO_LONG",
  "EVM_SWEEP_NEEDS_GAS",
  "EVM_SWEEP_INCOMPLETE",
  "WALLET_BUSY",
  "WALLET_LOCK_UNKNOWN",
  "EVM_RECORD_UNAVAILABLE",
] as const

export type VaultErrorCode = (typeof VAULT_ERROR_CODES)[number]

/**
 * A refusal with a stable code. Every vault code path throws this and nothing else, so a command
 * can map one catch to one failure envelope instead of guessing at a message.
 *
 * `exitCode` follows the Phase 1 convention the spec's Interfaces section restates: 1 failure,
 * 2 usage, 3 pending or partial. It defaults to 1 because that is what almost every refusal is.
 *
 * `details` (D3, BE-241) carries the FACTS a caller can act on, machine-readable: for
 * `VAULT_MISSING` and `VAULT_EXISTS`, `{ path, pathSource }`. `writeVaultFailure` spreads it into
 * the `--json` envelope as a nested `details` key, which is the additive optional key the `--json`
 * contract allows; the human rendering is untouched, because the same facts are already in
 * `message` as the parenthetical that says WHY that path. It exists so an agent can self-correct
 * the same way a human reading the parenthetical does, without parsing prose.
 */
export class VaultError extends Error {
  readonly code: VaultErrorCode
  readonly suggestion?: string
  readonly exitCode: 1 | 2 | 3
  readonly details?: Record<string, string>

  constructor(
    code: VaultErrorCode,
    message: string,
    opts: { suggestion?: string; exitCode?: 1 | 2 | 3; details?: Record<string, string> } = {},
  ) {
    super(message)
    this.name = "VaultError"
    this.code = code
    this.suggestion = opts.suggestion
    this.exitCode = opts.exitCode ?? 1
    this.details = opts.details
  }
}

export function isVaultError(error: unknown): error is VaultError {
  return error instanceof VaultError
}
