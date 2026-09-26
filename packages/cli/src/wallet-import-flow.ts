/**
 * The network-and-store sequence that turns a private key into a linked wallet, shared by
 * `wallets import` (one key the operator supplies) and `candle tee new` (a dedicated key the CLI
 * made). It was also shared with `wallets generate` until AD-3 removed that command in CLI 0.10.0.
 *
 * Extracted rather than copied. This repo has been bitten repeatedly by one truth restated by
 * hand in two places and drifting invisibly, and this particular sequence is the worst candidate
 * for that: its ordering is load-bearing security behaviour, not incidental.
 *
 * The ordering, and why it is what it is:
 *
 *   init -> seal -> generate signer -> STAGE the signer -> submit -> COMMIT the signer -> unstage
 *
 * Staging the signer's private half before the server hears about its public half is the part that
 * matters. The order used to be submit-then-store, and a store failure in that window (a locked
 * keychain, a cancelled passphrase prompt, a full disk) left a wallet registered on the account
 * whose signer existed only in process memory: it could never sign a trade, and nothing on screen
 * said so. Writing first inverts the failure, so an unavailable store is discovered before
 * anything is registered and the command fails having changed nothing anywhere.
 *
 * Rendering deliberately stays in the callers. They return different shapes (`import` reports one
 * wallet and verifies the account it landed on; `generate` reports progress across N and records
 * each into a keystore), so this returns a tagged result and lets each render it.
 */
import { apiRequest } from "./client"
import type { Deps } from "./deps"
import { importPendingSignerRef, pemToStoredSigner, walletSignerRef } from "./secret-store"
import { encryptWalletKeyForImport, generateSignerKeypair, type WalletChain } from "./wallet-import"

export interface ImportInitResponse {
  encryptionPublicKey: string
}

/** The server's `profile` for a TEE wallet (apps/api, packages/db TEE_PROFILE). Not the store marker. */
export const TEE_PROFILE = "ember-tee" as const

export interface ImportSubmitResponse {
  id: string
  address: string
  chain: WalletChain
  privyWalletId: string
  /** Ember Phase 1: present only for `profile: "ember-tee"` imports. */
  profile?: typeof TEE_PROFILE
  boundKeyPrefix?: string
  /** Key signers (4.2): present when the wallet was imported onto a key's signer. */
  keySigner?: { fingerprint: string; spkiSha256: string }
  vaultDestination?: string
  remoteAuthority?: "verified-active" | "verified-denied" | "unknown" | "none"
  reasonCode?: string
}

type ApiResult = Awaited<ReturnType<typeof apiRequest>>
/** Only the failure branch is ever carried out of here, which is what `writeFailure` accepts. */
type ApiFailure = Extract<ApiResult, { ok: false }>

export type ImportFlowFailure =
  /** An API call failed. `stage` names which, so a caller can say what did or did not happen. */
  | { kind: "api"; stage: "init" | "submit"; response: ApiFailure }
  /** The signer could not be staged. Nothing was registered. */
  | { kind: "signer-store"; error: unknown }
  /** The wallet exists but its signer is only under the staged ref. Recoverable, not lost. */
  | { kind: "signer-commit"; error: unknown; pendingRef: string; walletId: string }

export type ImportFlowResult =
  /** `signerPrivateKeyPem` is null for a keySigner import: no per-wallet signer exists. */
  | { ok: true; submitted: ImportSubmitResponse; signerPrivateKeyPem: string | null }
  | { ok: false; failure: ImportFlowFailure }

export interface ImportFlowParams {
  chain: WalletChain
  address: string
  privateKey: string
  label?: string
  apiKey: string
  apiUrl: string
  deps: Deps
  /** Ember Phase 1 (BE-94): the dedicated TEE wallet profile and its pinned sweep destination.
   * Forwarded to import/submit verbatim; the server validates and records them. */
  profile?: typeof TEE_PROFILE
  vaultDestination?: string
  /**
   * Key signers (spec 2026-09-25-key-signers-design.md, 4.2 and 5.2): import onto a key's signer
   * instead of a per-wallet one. No signer is generated or stored on this machine; the submit
   * names `keySigner: true` and the pinned full hash, and the server owns the wallet by that
   * key's quorum. With `targetKeyPrefix` the submit is the cross-key mount: the device token
   * alone, never the API key, and the server binds the wallet to the target in the same call.
   * The init is the calling key's either way.
   */
  keySigner?: { spkiSha256: string } | { spkiSha256: string; targetKeyPrefix: string; deviceToken: string }
}

export async function runImportFlow(params: ImportFlowParams): Promise<ImportFlowResult> {
  const { chain, address, privateKey, label, apiKey, apiUrl, deps, profile, vaultDestination, keySigner } = params
  const credentials = { apiKey }

  const init = await apiRequest("/api/v1/agent/wallets/import/init", {
    method: "POST",
    body: { chain, address },
    auth: "key",
    credentials,
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
  })
  if (!init.ok) return { ok: false, failure: { kind: "api", stage: "init", response: init } }
  const { encryptionPublicKey } = init.body as ImportInitResponse

  const { ciphertext, encapsulatedKey } = await encryptWalletKeyForImport({ chain, privateKey, encryptionPublicKey })
  if (keySigner !== undefined) {
    const crossKey = "targetKeyPrefix" in keySigner
    const submit = await apiRequest("/api/v1/agent/wallets/import/submit", {
      method: "POST",
      body: {
        chain,
        address,
        ciphertext,
        encapsulatedKey,
        keySigner: true,
        spkiSha256: keySigner.spkiSha256,
        ...(crossKey ? { targetKeyPrefix: keySigner.targetKeyPrefix } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(profile !== undefined ? { profile } : {}),
        ...(vaultDestination !== undefined ? { vaultDestination } : {}),
      },
      // One credential per request (4.2): the cross-key mount refuses an API key beside it.
      ...(crossKey
        ? { auth: "device" as const, credentials: { deviceToken: keySigner.deviceToken } }
        : { auth: "key" as const, credentials }),
      apiUrl,
      fetch: deps.fetch,
      env: deps.env,
    })
    if (!submit.ok) return { ok: false, failure: { kind: "api", stage: "submit", response: submit } }
    return { ok: true, submitted: submit.body as ImportSubmitResponse, signerPrivateKeyPem: null }
  }
  const signer = await generateSignerKeypair()
  const storedSigner = pemToStoredSigner(signer.privateKeyPem)

  const pendingRef = importPendingSignerRef(chain, address)
  try {
    await deps.store.set(pendingRef, storedSigner)
  } catch (error) {
    return { ok: false, failure: { kind: "signer-store", error } }
  }

  const submit = await apiRequest("/api/v1/agent/wallets/import/submit", {
    method: "POST",
    body: {
      chain,
      address,
      ciphertext,
      encapsulatedKey,
      signerPublicKey: signer.publicKeyDerBase64,
      ...(label !== undefined ? { label } : {}),
      ...(profile !== undefined ? { profile } : {}),
      ...(vaultDestination !== undefined ? { vaultDestination } : {}),
    },
    auth: "key",
    credentials,
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
  })
  if (!submit.ok) {
    // No wallet was created, so the staged signer is for nothing. Best effort: a store that cannot
    // delete is not a reason to report this as anything other than the submit failure it was.
    await deps.store.delete(pendingRef).catch(() => {})
    return { ok: false, failure: { kind: "api", stage: "submit", response: submit } }
  }
  const submitted = submit.body as ImportSubmitResponse

  try {
    await deps.store.set(walletSignerRef(submitted.id), storedSigner)
  } catch (error) {
    return { ok: false, failure: { kind: "signer-commit", error, pendingRef, walletId: submitted.id } }
  }
  // Best effort: the committed copy is what every later trade reads, so a stray staged duplicate
  // is hygiene rather than correctness.
  await deps.store.delete(pendingRef).catch(() => {})

  return { ok: true, submitted, signerPrivateKeyPem: signer.privateKeyPem }
}
