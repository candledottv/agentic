/**
 * Key signers K3, the CLI half of docs/superpowers/specs/2026-09-25-key-signers-design.md.
 *
 * A key signer is a P-256 pair generated on the machine that will trade. Its public half is
 * registered against one API key, and the owner approves it; from then on the Privy quorum made
 * from it OWNS every TEE wallet imported onto that key's signer or moved onto it. This module is
 * what every command shares about that:
 *
 *   - the local slots: the private half at `key_signer_<prefix>_<spkiSha256>` in the secret store
 *     (one slot per public key, never one per prefix), and its public facts plus the quorum in
 *     `config.keySigners`, because no store backend can list its refs;
 *   - the full-hash pin a promote checks before importing onto a key's signer (D3);
 *   - which local signer owns a wallet: the key-signer entry whose quorum equals the wallet's
 *     `signerQuorumId`, else the legacy `wallet_signer_<id>` (5.3);
 *   - the owner-change signature, over exactly the bytes the API's
 *     `ownerChangeSignaturePayload` names: `{ owner_id }` and `{ "privy-app-id" }`, nothing else;
 *   - the four signer routes K1 serves.
 *
 * Nothing here ever sends a private half anywhere. The relay forwards the signature; Candle's
 * server holds no signing authority over these wallets.
 */
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto"
import { type ApiResult, apiRequest } from "./client"
import type { KeySignerEntry, KeySignerIndex, KeySignerPin } from "./config"
import type { CommandContext, Deps } from "./deps"
import { storedSignerToPem, walletSignerRef } from "./secret-store"

export type { KeySignerEntry, KeySignerPin }

/** A key's 8-character prefix, as `keys list` prints it and as the server names it. */
export const KEY_PREFIX_RE = /^[A-Za-z0-9_-]{8}$/

/** The store ref a key signer's private half lives under. One per public key (4.1). */
export function keySignerRef(keyPrefix: string, spkiSha256: string): string {
  return `key_signer_${keyPrefix}_${spkiSha256}`
}

// ── Fingerprints: a copy of packages/db/convex/lib/keySignerPolicy.ts, pinned by a test ──────

/** Crockford base32: no I, L, O or U. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

export function isSpkiSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
}

/**
 * `CNDL-XXXX-XXXX-XXXX`: the first 60 bits of `spkiSha256`, base32, grouped. Recognition only;
 * nothing that decides anything compares it (D3).
 */
export function keySignerFingerprint(spkiSha256: string): string {
  if (!isSpkiSha256(spkiSha256)) throw new Error("keySignerFingerprint: spkiSha256 must be 64 lowercase hex")
  const bits = Array.from(spkiSha256.slice(0, 15), (hex) => Number.parseInt(hex, 16).toString(2).padStart(4, "0")).join(
    "",
  )
  const chars: string[] = []
  for (let i = 0; i < 60; i += 5) chars.push(CROCKFORD[Number.parseInt(bits.slice(i, i + 5), 2)] as string)
  const s = chars.join("")
  return `CNDL-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`
}

/**
 * Whether `typed` is the FULL group string of `fingerprint`. Case and separators are forgiven,
 * and the `CNDL` tag may be left off; a missing, extra or wrong character is not, and one group
 * on its own never passes.
 */
export function fingerprintMatches(typed: unknown, fingerprint: string): boolean {
  if (typeof typed !== "string") return false
  const expected = fingerprint.replace(/^CNDL-/, "").replace(/-/g, "")
  let normalized = typed.toUpperCase().replace(/[^0-9A-Z]/g, "")
  if (normalized.length === expected.length + 4 && normalized.startsWith("CNDL")) normalized = normalized.slice(4)
  return normalized.length === expected.length && normalized === expected
}

/** Lowercase hex sha256 of a base64 SPKI DER. */
export function spkiSha256Of(publicKeyDerBase64: string): string {
  return createHash("sha256").update(Buffer.from(publicKeyDerBase64, "base64")).digest("hex")
}

// ── The local index ───────────────────────────────────────────────────────────────────────────

export async function readKeySignerIndex(deps: Deps): Promise<Required<KeySignerIndex>> {
  const index = (await deps.readConfig()).keySigners ?? {}
  return { entries: [...(index.entries ?? [])], pins: { ...(index.pins ?? {}) } }
}

async function writeKeySignerIndex(deps: Deps, index: Required<KeySignerIndex>): Promise<void> {
  await deps.writeConfig({ keySigners: index })
}

/** Every key signer this machine holds, optionally for one key, oldest first. */
export async function localKeySigners(deps: Deps, keyPrefix?: string): Promise<KeySignerEntry[]> {
  const { entries } = await readKeySignerIndex(deps)
  return entries.filter((entry) => keyPrefix === undefined || entry.keyPrefix === keyPrefix)
}

/** Adds or replaces the entry for one (prefix, spkiSha256). */
export async function saveKeySignerEntry(deps: Deps, entry: KeySignerEntry): Promise<void> {
  const index = await readKeySignerIndex(deps)
  const at = index.entries.findIndex((e) => e.keyPrefix === entry.keyPrefix && e.spkiSha256 === entry.spkiSha256)
  if (at === -1) index.entries.push(entry)
  else index.entries[at] = entry
  await writeKeySignerIndex(deps, index)
}

/**
 * Removes ONE slot: the private half from the store, then its index entry. Callers decide when
 * that is safe (5.4: only after a read-back shows no wallet left on its quorum, never the active).
 */
export async function deleteKeySignerEntry(deps: Deps, entry: KeySignerEntry): Promise<void> {
  await deps.store.delete(keySignerRef(entry.keyPrefix, entry.spkiSha256))
  const index = await readKeySignerIndex(deps)
  index.entries = index.entries.filter((e) => !(e.keyPrefix === entry.keyPrefix && e.spkiSha256 === entry.spkiSha256))
  await writeKeySignerIndex(deps, index)
}

export async function readPin(deps: Deps, keyPrefix: string): Promise<KeySignerPin | undefined> {
  const { pins } = await readKeySignerIndex(deps)
  return Object.hasOwn(pins, keyPrefix) ? pins[keyPrefix] : undefined
}

async function writePin(deps: Deps, keyPrefix: string, pin: KeySignerPin): Promise<void> {
  const index = await readKeySignerIndex(deps)
  index.pins[keyPrefix] = pin
  await writeKeySignerIndex(deps, index)
}

// ── Which local signer owns a wallet (5.3) ─────────────────────────────────────────────────────

export type LocalSigner =
  | { kind: "key"; entry: KeySignerEntry; pem: string }
  | { kind: "legacy"; walletId: string; pem: string }

/**
 * The signer on THIS machine that owns a wallet whose recorded owner is `ownerQuorumId`: the
 * key-signer entry holding that quorum (any key, active or not, so a moving wallet still trades
 * from the machine that holds its source signer), else the legacy per-wallet signer. A legacy
 * wallet's quorum is a per-wallet one no entry holds, so the fallback is by wallet id. `move` and
 * the rebind delete a legacy slot once a read-back shows the wallet on a key signer, so a stale
 * one is not picked over the owner that replaced it.
 */
export async function localSignerFor(
  deps: Deps,
  walletId: string,
  ownerQuorumId: string | null | undefined,
): Promise<LocalSigner | null> {
  const entries = await localKeySigners(deps)
  if (typeof ownerQuorumId === "string" && ownerQuorumId.length > 0) {
    const entry = entries.find((e) => e.signerQuorumId === ownerQuorumId)
    if (entry) {
      const stored = await deps.store.get(keySignerRef(entry.keyPrefix, entry.spkiSha256))
      return stored ? { kind: "key", entry, pem: storedSignerToPem(stored) } : null
    }
  }
  const legacy = await deps.store.get(walletSignerRef(walletId))
  return legacy ? { kind: "legacy", walletId, pem: storedSignerToPem(legacy) } : null
}

// ── The owner change (4.2, D4) ─────────────────────────────────────────────────────────────────

/**
 * The exact bytes an owner change signs, in RFC 8785 order at every level. Byte for byte the
 * API's `ownerChangeSignaturePayload` (apps/api/src/services/privy-wallets.ts): the body is
 * `{ owner_id }` alone and the signed headers are `{ "privy-app-id" }` alone, with no idempotency
 * key, because anything added after the signature makes the request unverifiable.
 */
export function ownerChangePayload(privyWalletId: string, ownerId: string, appId: string): string {
  return JSON.stringify({
    body: { owner_id: ownerId },
    headers: { "privy-app-id": appId },
    method: "PATCH",
    url: `https://api.privy.io/v1/wallets/${privyWalletId}`,
    version: 1,
  })
}

/** The relay request for one owner change: `{ body: { owner_id }, authorizationSignature }`. */
export function signOwnerChange(
  pem: string,
  change: { privyWalletId: string; ownerId: string; appId: string },
): { body: { owner_id: string }; authorizationSignature: string } {
  const payload = ownerChangePayload(change.privyWalletId, change.ownerId, change.appId)
  return {
    body: { owner_id: change.ownerId },
    authorizationSignature: sign("sha256", Buffer.from(payload), pem).toString("base64"),
  }
}

// ── The routes (4.2) ───────────────────────────────────────────────────────────────────────────

export type SignerAuth = { apiKey: string } | { deviceToken: string }

function authOptions(auth: SignerAuth) {
  return "apiKey" in auth
    ? { auth: "key" as const, credentials: { apiKey: auth.apiKey } }
    : { auth: "device" as const, credentials: { deviceToken: auth.deviceToken } }
}

export interface SignerWallet {
  id: string
  address: string
  chain: string
  label?: string | null
  privyWalletId: string
  signerQuorumId?: string | null
}

/** `GET /keys/:prefix/signer`, as K1 serves it. */
export interface SignerView {
  keyPrefix: string
  keyLabel?: string | null
  state: "active" | "pending" | "none"
  fingerprint: string | null
  spkiSha256: string | null
  publicKeyDer: string | null
  signerQuorumId?: string
  pending: { fingerprint: string; spkiSha256: string; requestedAt: number; expiresAt: number | null } | null
  wallets: { onSigner: SignerWallet[]; legacy: SignerWallet[]; moving: SignerWallet[] }
  /** The Privy app id an owner change signs over; absent on an API that predates it. */
  privyAppId?: string | null
}

export function allSignerWallets(view: SignerView): SignerWallet[] {
  return [...view.wallets.onSigner, ...view.wallets.legacy, ...view.wallets.moving]
}

/** The key's ACTIVE signer, when it has one. */
export function activeSigner(
  view: SignerView,
): { fingerprint: string; spkiSha256: string; signerQuorumId: string } | null {
  if (view.state !== "active" || !view.signerQuorumId || !view.fingerprint || !view.spkiSha256) return null
  return { fingerprint: view.fingerprint, spkiSha256: view.spkiSha256, signerQuorumId: view.signerQuorumId }
}

type Api = Pick<CommandContext, "apiUrl"> & { deps: Pick<Deps, "fetch" | "env"> }

export async function readSigner(ctx: Api, keyPrefix: string, auth: SignerAuth): Promise<ApiResult> {
  return apiRequest(`/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}/signer`, {
    ...authOptions(auth),
    apiUrl: ctx.apiUrl,
    fetch: ctx.deps.fetch,
    env: ctx.deps.env,
  })
}

export async function requestSigner(ctx: Api, apiKey: string, publicKeyDer: string): Promise<ApiResult> {
  return apiRequest("/api/v1/agent/keys/self/signer/request", {
    method: "POST",
    body: { publicKeyDer },
    auth: "key",
    credentials: { apiKey },
    apiUrl: ctx.apiUrl,
    fetch: ctx.deps.fetch,
    env: ctx.deps.env,
  })
}

export async function approveSigner(
  ctx: Api,
  deviceToken: string,
  keyPrefix: string,
  body: { userCode: string; fingerprint?: string; decision: "approve" | "reject" },
): Promise<ApiResult> {
  return apiRequest(`/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}/signer/approve`, {
    method: "POST",
    body,
    auth: "device",
    credentials: { deviceToken },
    apiUrl: ctx.apiUrl,
    fetch: ctx.deps.fetch,
    env: ctx.deps.env,
  })
}

export async function relayOwner(
  ctx: Api,
  walletId: string,
  auth: SignerAuth,
  body: { body: { owner_id: string }; authorizationSignature: string },
): Promise<ApiResult> {
  return apiRequest(`/api/v1/agent/wallets/${encodeURIComponent(walletId)}/owner`, {
    method: "POST",
    body,
    ...authOptions(auth),
    apiUrl: ctx.apiUrl,
    fetch: ctx.deps.fetch,
    env: ctx.deps.env,
  })
}

/** The failure's `error` object, for the facts a KEY_SIGNER_* refusal carries (`keySigner`, `owners`). */
export function errorDetails(result: Extract<ApiResult, { ok: false }>): Record<string, unknown> {
  const error = (result.raw as { error?: unknown } | null)?.error
  return error && typeof error === "object" ? (error as Record<string, unknown>) : {}
}

// ── The pin (D3) ───────────────────────────────────────────────────────────────────────────────

export interface PinFailure {
  code: string
  message: string
  suggestion?: string
}

/**
 * D3, before anything is imported onto or signed to a key's signer. The pin stores the FULL
 * sha256 and only that is compared. With no pin yet (trust on first use), or when the active
 * signer's full hash differs from the pin, the operator types the full group string they read on
 * the trading machine; the prompt does not echo, and one group never passes. A match (re)pins the
 * full hash. The same hash as the pin passes silently. With no terminal to type into, anything
 * but the same hash is refused. `nothing` is the refusal's "what did not happen" sentence, for a
 * caller that is not an import (an owner-changing rebind).
 */
export async function confirmSignerPin(
  ctx: Pick<CommandContext, "deps">,
  keyPrefix: string,
  active: { fingerprint: string; spkiSha256: string },
  opts: { nothing?: string } = {},
): Promise<{ ok: true; pinned: "same" | "first" | "changed" } | { ok: false; failure: PinFailure }> {
  const { deps } = ctx
  const nothing = opts.nothing ?? "Nothing was imported and nothing was pinned."
  const pin = await readPin(deps, keyPrefix)
  if (pin && pin.spkiSha256 === active.spkiSha256) return { ok: true, pinned: "same" }
  if (!deps.isTTY.stdin) {
    return {
      ok: false,
      failure: {
        code: pin ? "KEY_SIGNER_CHANGED" : "KEY_SIGNER_FINGERPRINT_MISMATCH",
        message: `Key ${keyPrefix}'s signer is ${active.fingerprint}, which this machine has not pinned, and there is no terminal to type its full fingerprint into. ${nothing}`,
        suggestion: "Run it in an interactive shell and type the full fingerprint the trading machine printed.",
      },
    }
  }
  if (pin) {
    deps.stderr.write(
      `KEY_SIGNER_CHANGED: key ${keyPrefix}'s signer is not the one this machine pinned (${pin.fingerprint}).\n` +
        `The server now reports ${active.fingerprint}. If you approved a new signer, read its full fingerprint on the trading machine.\n`,
    )
  } else {
    deps.stderr.write(
      `Key ${keyPrefix}'s signer is ${active.fingerprint}. This machine has not pinned it yet; it trusts it once you confirm it.\n` +
        "Read the full fingerprint on the trading machine (candle tee signer new printed it).\n",
    )
  }
  const typed = await deps.promptSecret(`Type the full fingerprint of key ${keyPrefix}'s signer, all three groups: `)
  if (!fingerprintMatches(typed, active.fingerprint)) {
    return {
      ok: false,
      failure: {
        code: pin ? "KEY_SIGNER_CHANGED" : "KEY_SIGNER_FINGERPRINT_MISMATCH",
        message: `That is not the full fingerprint of key ${keyPrefix}'s signer. ${nothing}`,
        suggestion:
          "Type all three groups exactly as the trading machine printed them, for example CNDL-7K2Q-94XM-A1TD.",
      },
    }
  }
  await writePin(deps, keyPrefix, {
    spkiSha256: active.spkiSha256,
    fingerprint: active.fingerprint,
    pinnedAt: deps.now(),
  })
  return { ok: true, pinned: pin ? "changed" : "first" }
}

// ── Checking a slot (doctor, 5.6) ──────────────────────────────────────────────────────────────

/**
 * Whether a stored signer opens as a P-256 private key, and for a key signer, whether its public
 * half is the one the entry names. `null` is healthy; a string says what is wrong.
 */
export function signerSlotProblem(stored: string, expectSpkiSha256?: string): string | null {
  let publicDer: Buffer
  try {
    const key = createPrivateKey(storedSignerToPem(stored))
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      return "not a P-256 private key"
    }
    publicDer = createPublicKey(key).export({ format: "der", type: "spki" })
  } catch {
    return "cannot be parsed as a private key"
  }
  if (expectSpkiSha256 !== undefined && createHash("sha256").update(publicDer).digest("hex") !== expectSpkiSha256) {
    return "its public half does not match the slot's sha256"
  }
  return null
}
