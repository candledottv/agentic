/**
 * The network-and-store sequence that turns a private key into a linked wallet, shared by
 * `wallets import` (one key the operator supplies) and `wallets generate` (N keys the CLI made).
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

export interface ImportSubmitResponse {
  id: string
  address: string
  chain: WalletChain
  privyWalletId: string
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
  | { ok: true; submitted: ImportSubmitResponse; signerPrivateKeyPem: string }
  | { ok: false; failure: ImportFlowFailure }

export interface ImportFlowParams {
  chain: WalletChain
  address: string
  privateKey: string
  label?: string
  apiKey: string
  apiUrl: string
  deps: Deps
}

export async function runImportFlow(params: ImportFlowParams): Promise<ImportFlowResult> {
  const { chain, address, privateKey, label, apiKey, apiUrl, deps } = params
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
