/**
 * Key signers K3: a small simulator of K1's server and Privy for the CLI's tests. It models what
 * the CLI depends on and nothing more: each key's active, previous and pending signer; each TEE
 * wallet's binding, its recorded `signerQuorumId`, and the owner Privy actually holds; the four
 * signer routes, the owner relay, the rebind, and the reads a move's cleanup makes.
 *
 * Like K1's route tests, every owner change it accepts is VERIFIED against the public key of the
 * wallet's current owner over `ownerChangePayload`'s bytes. A test that passes therefore proves the
 * CLI signed exactly the bytes Privy checks, with the signer that owns the wallet, and nothing else.
 */
import { createPublicKey, type KeyObject, verify } from "node:crypto"
import { keySignerFingerprint, ownerChangePayload, spkiSha256Of } from "../../key-signers"
import { type CapturedRequest, jsonResponse, type RouteHandler } from "../../test-support"

export const APP_ID = "app-test"

export interface SimSigner {
  publicKeyDer: string
  spkiSha256: string
  fingerprint: string
  quorum: string
}

export interface SimKey {
  keyPrefix: string
  label: string | null
  apiKey?: string
  revoked?: boolean
  active: SimSigner | null
  previous: string[]
  pending: (Omit<SimSigner, "quorum"> & { userCode: string; expiresAt: number }) | null
}

export interface SimWallet {
  id: string
  address: string
  label: string | null
  privyWalletId: string
  boundKeyPrefix: string
  /** What Candle recorded (the row's signerQuorumId). */
  recorded: string
  /** What Privy holds. */
  owner: string
}

const parse = (req: CapturedRequest) => JSON.parse(String(req.init.body ?? "{}")) as Record<string, unknown>
const header = (req: CapturedRequest, name: string) => (req.init.headers as Record<string, string> | undefined)?.[name]
const refusal = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  jsonResponse(status, { success: false, error: { code, message: `sim: ${code}`, retryable: false, ...extra } })

export class SignerSim {
  keys = new Map<string, SimKey>()
  wallets: SimWallet[] = []
  /** Quorum id to the public key that signs for it. */
  quorumKeys = new Map<string, KeyObject>()
  requests: Array<{ keyPrefix: string; publicKeyDer: string; userCode: string }> = []
  relays: Array<{ walletId: string; body: Record<string, unknown>; headers: Record<string, string> }> = []
  rebinds: Array<Record<string, unknown>> = []
  /** Approve the key's pending request on the Nth signer read after it was made (null: never). */
  approveOnRead: number | null = null
  private readsSinceRequest = 0
  private quorumCounter = 0
  /** Fail the owner relay for these wallet ids (a provider error; nothing changes). */
  failRelay = new Set<string>()

  constructor(private readonly now: () => number) {}

  addKey(key: Partial<SimKey> & { keyPrefix: string }): SimKey {
    const full: SimKey = { label: null, active: null, previous: [], pending: null, ...key }
    this.keys.set(full.keyPrefix, full)
    return full
  }

  /** Registers a quorum for a public key, as approval (or a per-wallet import) would. */
  quorumFor(publicKeyDer: string, id?: string): string {
    const quorum = id ?? `q-${++this.quorumCounter}`
    this.quorumKeys.set(
      quorum,
      createPublicKey({ key: Buffer.from(publicKeyDer, "base64"), format: "der", type: "spki" }),
    )
    return quorum
  }

  signer(publicKeyDer: string, quorum?: string): SimSigner {
    const spkiSha256 = spkiSha256Of(publicKeyDer)
    return {
      publicKeyDer,
      spkiSha256,
      fingerprint: keySignerFingerprint(spkiSha256),
      quorum: this.quorumFor(publicKeyDer, quorum),
    }
  }

  approvePending(keyPrefix: string): void {
    const key = this.keys.get(keyPrefix)
    if (!key?.pending) return
    const { userCode: _code, expiresAt: _expires, ...pending } = key.pending
    if (key.active) key.previous.push(key.active.quorum)
    key.active = { ...pending, quorum: this.quorumFor(pending.publicKeyDer) }
    key.pending = null
  }

  private keyForApiKey(apiKey: string | undefined): SimKey | undefined {
    return [...this.keys.values()].find((key) => key.apiKey !== undefined && key.apiKey === apiKey)
  }

  view(key: SimKey) {
    // GET …/signer reconciles moving wallets Privy already shows on the active quorum.
    const active = key.active
    const mine = this.wallets.filter((w) => w.boundKeyPrefix === key.keyPrefix)
    if (active) {
      for (const w of mine)
        if (key.previous.includes(w.recorded) && w.owner === active.quorum) w.recorded = active.quorum
    }
    if (key.pending && key.pending.expiresAt <= this.now()) key.pending = null
    const view = (w: SimWallet) => ({
      id: w.id,
      address: w.address,
      chain: "solana",
      label: w.label,
      privyWalletId: w.privyWalletId,
      signerQuorumId: w.recorded,
    })
    const onSigner = mine.filter((w) => active !== null && w.recorded === active.quorum)
    const moving = mine.filter((w) => !onSigner.includes(w) && key.previous.includes(w.recorded))
    const legacy = mine.filter((w) => !onSigner.includes(w) && !moving.includes(w))
    const current = active ?? key.pending
    return {
      success: true,
      keyPrefix: key.keyPrefix,
      keyLabel: key.label,
      state: active ? "active" : key.pending ? "pending" : "none",
      fingerprint: current?.fingerprint ?? null,
      spkiSha256: current?.spkiSha256 ?? null,
      publicKeyDer: current?.publicKeyDer ?? null,
      ...(active ? { signerQuorumId: active.quorum } : {}),
      pending: key.pending
        ? {
            fingerprint: key.pending.fingerprint,
            spkiSha256: key.pending.spkiSha256,
            requestedAt: 0,
            expiresAt: key.pending.expiresAt,
          }
        : null,
      wallets: { onSigner: onSigner.map(view), legacy: legacy.map(view), moving: moving.map(view) },
      privyAppId: APP_ID,
    }
  }

  /** Verifies one owner change as Privy would: signed by the CURRENT owner, over exactly these bytes. */
  private verifyOwnerChange(wallet: SimWallet, ownerId: string, signature: string): boolean {
    const key = this.quorumKeys.get(wallet.owner)
    if (!key) return false
    return verify(
      "sha256",
      Buffer.from(ownerChangePayload(wallet.privyWalletId, ownerId, APP_ID)),
      key,
      Buffer.from(signature, "base64"),
    )
  }

  routes(): Record<string, RouteHandler> {
    const routes: Record<string, RouteHandler> = {}
    routes["/api/v1/agent/keys/self/signer"] = (req) => {
      const key = this.keyForApiKey(header(req, "x-api-key"))
      if (!key) return refusal(401, "UNAUTHORIZED")
      if (key.pending) {
        this.readsSinceRequest += 1
        if (this.approveOnRead !== null && this.readsSinceRequest >= this.approveOnRead)
          this.approvePending(key.keyPrefix)
      }
      return jsonResponse(200, this.view(key))
    }
    routes["/api/v1/agent/keys/self/signer/request"] = (req) => {
      const key = this.keyForApiKey(header(req, "x-api-key"))
      if (!key) return refusal(401, "UNAUTHORIZED")
      const publicKeyDer = parse(req).publicKeyDer as string
      const spkiSha256 = spkiSha256Of(publicKeyDer)
      if (key.active?.spkiSha256 === spkiSha256) {
        return refusal(409, "KEY_SIGNER_ALREADY_ACTIVE", {
          keySigner: { fingerprint: key.active.fingerprint, spkiSha256, signerQuorumId: key.active.quorum },
        })
      }
      const userCode = `CODE-${this.requests.length + 1}`
      this.requests.push({ keyPrefix: key.keyPrefix, publicKeyDer, userCode })
      this.readsSinceRequest = 0
      const expiresAt = this.now() + 10 * 60 * 1000
      key.pending = { publicKeyDer, spkiSha256, fingerprint: keySignerFingerprint(spkiSha256), userCode, expiresAt }
      return jsonResponse(200, {
        success: true,
        keyPrefix: key.keyPrefix,
        fingerprint: key.pending.fingerprint,
        spkiSha256,
        userCode,
        verificationUri: "https://staging.candle.tv/dev/agent/device",
        verificationUriComplete: `https://staging.candle.tv/dev/agent/device?signer=${key.keyPrefix}&code=${userCode}`,
        expiresAt,
      })
    }
    for (const key of this.keys.values()) {
      routes[`/api/v1/agent/keys/${key.keyPrefix}/signer`] = (req) => {
        const apiKey = header(req, "x-api-key")
        if (apiKey !== undefined && this.keyForApiKey(apiKey)?.keyPrefix !== key.keyPrefix)
          return refusal(403, "VALIDATION_FAILED")
        return jsonResponse(200, this.view(key))
      }
      routes[`/api/v1/agent/keys/${key.keyPrefix}/signer/approve`] = (req) => {
        if (!header(req, "authorization")?.startsWith("Bearer cndl_dvc_")) return refusal(401, "DEVICE_TOKEN_INVALID")
        const body = parse(req)
        if (!key.pending || key.pending.userCode !== body.userCode) return refusal(404, "KEY_SIGNER_CODE_INVALID")
        if (body.decision === "reject") {
          key.pending = null
          return jsonResponse(200, { success: true, keyPrefix: key.keyPrefix, decision: "reject", state: "rejected" })
        }
        if (typeof body.fingerprint !== "string" || body.fingerprint.toUpperCase() !== key.pending.fingerprint) {
          return refusal(400, "KEY_SIGNER_FINGERPRINT_MISMATCH")
        }
        this.approvePending(key.keyPrefix)
        return jsonResponse(200, { ...this.view(key), decision: "approve", approvedVia: "device" })
      }
    }
    for (const wallet of this.wallets) {
      routes[`/api/v1/agent/wallets/${wallet.id}/owner`] = (req) => {
        const body = parse(req)
        const headers = (req.init.headers ?? {}) as Record<string, string>
        this.relays.push({ walletId: wallet.id, body, headers })
        if (Object.keys(body).sort().join() !== "authorizationSignature,body") return refusal(400, "VALIDATION_FAILED")
        const inner = body.body as Record<string, unknown>
        if (Object.keys(inner).join() !== "owner_id") return refusal(400, "VALIDATION_FAILED")
        const key = this.keys.get(wallet.boundKeyPrefix)
        const apiKey = headers["x-api-key"]
        if (apiKey !== undefined && this.keyForApiKey(apiKey)?.keyPrefix !== wallet.boundKeyPrefix) {
          return refusal(403, "KEY_SIGNER_OWNER_INVALID")
        }
        if (!key?.active) return refusal(409, "KEY_SIGNER_MISSING")
        if (inner.owner_id !== key.active.quorum) return refusal(403, "KEY_SIGNER_OWNER_INVALID")
        if (this.failRelay.has(wallet.id)) return refusal(502, "SWAP_FAILED")
        let forwarded = false
        if (wallet.owner !== key.active.quorum) {
          if (!this.verifyOwnerChange(wallet, key.active.quorum, body.authorizationSignature as string)) {
            return refusal(401, "SIGNER_MISMATCH")
          }
          wallet.owner = key.active.quorum
          forwarded = true
        }
        wallet.recorded = key.active.quorum
        return jsonResponse(200, { success: true, walletId: wallet.id, forwarded, recorded: true })
      }
    }
    routes["/api/v1/agent/wallets"] = () =>
      jsonResponse(200, {
        page: this.wallets.map((w) => ({ _id: w.id, address: w.address, signerQuorumId: w.recorded })),
        isDone: true,
        continueCursor: null,
      })
    routes["/api/v1/agent/keys"] = () =>
      jsonResponse(200, {
        keys: [...this.keys.values()].map((key) => ({
          keyPrefix: key.keyPrefix,
          label: key.label ?? undefined,
          scopes: ["swap:write"],
          environment: "production",
          createdAt: 1,
          ...(key.revoked ? { revokedAt: 5 } : {}),
        })),
      })
    routes["/api/v1/agent/tee-wallets/rebind"] = (req) => this.rebind(parse(req))
    return routes
  }

  private rebind(body: Record<string, unknown>): Response {
    this.rebinds.push(body)
    const target = this.keys.get(body.toKeyPrefix as string)
    if (!target) return refusal(404, "REBIND_WALLET_INVALID")
    const toKey = {
      keyPrefix: target.keyPrefix,
      label: target.label,
      paused: false,
      walletScope: "all",
      tradeReady: { sol: true, usdc: true },
      missingCaps: [],
      launchScope: false,
      signer: target.active ? { fingerprint: target.active.fingerprint, spkiSha256: target.active.spkiSha256 } : null,
    }
    const row = (w: SimWallet) => ({
      id: w.id,
      address: w.address,
      label: w.label,
      fromKeyPrefix: w.boundKeyPrefix,
      allowLaunch: false,
    })
    if (body.dryRun === true) {
      const named = (body.wallets as string[]).map((sel) => this.wallets.find((w) => w.id === sel || w.label === sel))
      const found = named.filter((w): w is SimWallet => w !== undefined)
      const moving = found.filter((w) => w.boundKeyPrefix !== target.keyPrefix)
      return jsonResponse(200, {
        success: true,
        dryRun: true,
        toKey,
        rebound: moving.map(row),
        unchanged: found
          .filter((w) => w.boundKeyPrefix === target.keyPrefix)
          .map((w) => ({ id: w.id, address: w.address, label: w.label })),
        ownerChange: target.active
          ? {
              signerQuorumId: target.active.quorum,
              wallets: moving
                .filter((w) => w.recorded !== target.active?.quorum)
                .map((w) => ({ id: w.id, privyWalletId: w.privyWalletId, signerQuorumId: w.recorded })),
            }
          : null,
        ...(target.active ? { privyAppId: APP_ID } : {}),
      })
    }
    const ids = body.walletIds as string[]
    const wallets = ids.map((id) => this.wallets.find((w) => w.id === id) as SimWallet)
    const owner = body.owner as
      | Record<string, { body: { owner_id: string }; authorizationSignature: string }>
      | undefined
    if (!target.active) {
      if (owner !== undefined) return refusal(400, "VALIDATION_FAILED")
      const rebound = wallets.map((w) => ({ ...row(w), auditId: `aud-${w.id}` }))
      for (const w of wallets) w.boundKeyPrefix = target.keyPrefix
      return jsonResponse(200, { success: true, dryRun: false, toKey, rebound, unchanged: [], ownerChange: null })
    }
    const quorum = target.active.quorum
    const missing = wallets.filter((w) => w.owner !== quorum && owner?.[w.id] === undefined)
    if (missing.length > 0) {
      return refusal(409, "KEY_SIGNER_SIGNATURE_REQUIRED", {
        walletIds: missing.map((w) => w.id),
        owners: missing.map((w) => ({ walletId: w.id, privyWalletId: w.privyWalletId, ownerId: w.owner })),
        keySigner: {
          fingerprint: target.active.fingerprint,
          spkiSha256: target.active.spkiSha256,
          signerQuorumId: quorum,
        },
      })
    }
    for (const w of wallets) {
      const change = owner?.[w.id]
      if (
        change &&
        w.owner !== quorum &&
        !this.verifyOwnerChange(w, change.body.owner_id, change.authorizationSignature)
      ) {
        return refusal(401, "SIGNER_MISMATCH")
      }
    }
    const forwarded: string[] = []
    const alreadyOwned: string[] = []
    const rebound = wallets.map((w) => ({ ...row(w), auditId: `aud-${w.id}` }))
    for (const w of wallets) {
      if (w.owner === quorum) alreadyOwned.push(w.id)
      else forwarded.push(w.id)
      w.owner = quorum
      w.recorded = quorum
      w.boundKeyPrefix = target.keyPrefix
    }
    return jsonResponse(200, {
      success: true,
      dryRun: false,
      toKey,
      rebound,
      unchanged: [],
      ownerChange: { signerQuorumId: quorum, forwarded, alreadyOwned },
    })
  }
}
