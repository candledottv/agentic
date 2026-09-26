/**
 * Key signers K3 (spec docs/superpowers/specs/2026-09-25-key-signers-design.md): the shared rules
 * in `key-signers.ts`. The owner-change bytes, the full-hash pin (T5), and which local signer owns
 * a wallet (T7, T10).
 */
import { describe, expect, test } from "bun:test"
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto"
import {
  confirmSignerPin,
  fingerprintMatches,
  keySignerFingerprint,
  keySignerRef,
  localSignerFor,
  ownerChangePayload,
  readPin,
  saveKeySignerEntry,
  signerSlotProblem,
  signOwnerChange,
  spkiSha256Of,
} from "./key-signers"
import { pemToStoredSigner, walletSignerRef } from "./secret-store"
import { createCapture, createFakeStore, createRoutedFetch, createTestDeps } from "./test-support"

function pair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString()
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" }).toString("base64")
  return { pem, publicKeyDer, spkiSha256: spkiSha256Of(publicKeyDer) }
}

function deps(answers: string[] = []) {
  const stderr = createCapture()
  const prompts: string[] = []
  const d = createTestDeps({
    fetch: createRoutedFetch({}).fetch,
    stderr,
    promptSecret: async (text) => {
      prompts.push(text)
      const next = answers.shift()
      if (next === undefined) throw new Error("promptSecret asked for more answers than the test scripted")
      return next
    },
  })
  return { deps: d, stderr, prompts }
}

describe("the owner change (4.2, D4)", () => {
  test("the signed bytes are exactly { owner_id } and { privy-app-id }, in RFC 8785 order, as the API's ownerChangeSignaturePayload", () => {
    expect(ownerChangePayload("pw-W1", "q-target", "app-1")).toBe(
      '{"body":{"owner_id":"q-target"},"headers":{"privy-app-id":"app-1"},"method":"PATCH","url":"https://api.privy.io/v1/wallets/pw-W1","version":1}',
    )
  })

  test("the relay request is { body: { owner_id }, authorizationSignature } and the signature verifies over those bytes", () => {
    const owner = pair()
    const request = signOwnerChange(owner.pem, { privyWalletId: "pw-W1", ownerId: "q-target", appId: "app-1" })
    expect(Object.keys(request).sort()).toEqual(["authorizationSignature", "body"])
    expect(request.body).toEqual({ owner_id: "q-target" })
    const key = createPublicKey({ key: Buffer.from(owner.publicKeyDer, "base64"), format: "der", type: "spki" })
    const bytes = Buffer.from(ownerChangePayload("pw-W1", "q-target", "app-1"))
    expect(verify("sha256", bytes, key, Buffer.from(request.authorizationSignature, "base64"))).toBe(true)
    // Not over any other body: a signature for q-target does not move the wallet anywhere else.
    const other = Buffer.from(ownerChangePayload("pw-W1", "q-other", "app-1"))
    expect(verify("sha256", other, key, Buffer.from(request.authorizationSignature, "base64"))).toBe(false)
  })
})

describe("fingerprints (D3)", () => {
  test("the display form is the first 60 bits, and only the full group string matches", () => {
    const sha = createHash("sha256").update("x").digest("hex")
    const fingerprint = keySignerFingerprint(sha)
    expect(fingerprint).toMatch(/^CNDL-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    const [, a, b, c] = fingerprint.split("-")
    expect(fingerprintMatches(fingerprint, fingerprint)).toBe(true)
    expect(fingerprintMatches(`${a} ${b} ${c}`.toLowerCase(), fingerprint)).toBe(true)
    expect(fingerprintMatches(c, fingerprint)).toBe(false)
    expect(fingerprintMatches(`${a}-${b}`, fingerprint)).toBe(false)
  })
})

describe("the pin (D3, T5)", () => {
  const signerA = { spkiSha256: "a".repeat(64), fingerprint: keySignerFingerprint("a".repeat(64)) }
  const signerB = { spkiSha256: "b".repeat(64), fingerprint: keySignerFingerprint("b".repeat(64)) }

  test("the first pin needs the full group string, asked without echo, and stores the full sha256", async () => {
    const { deps: d, prompts } = deps([signerA.fingerprint])
    const result = await confirmSignerPin({ deps: d }, "Tr2KeyAb", signerA)
    expect(result).toEqual({ ok: true, pinned: "first" })
    expect(prompts).toHaveLength(1)
    expect((await readPin(d, "Tr2KeyAb"))?.spkiSha256).toBe(signerA.spkiSha256)
  })

  test("one group, or two, does not pass and pins nothing", async () => {
    const groups = signerA.fingerprint.split("-")
    for (const typed of [groups[3] as string, `${groups[1]}-${groups[2]}`]) {
      const { deps: d } = deps([typed])
      const result = await confirmSignerPin({ deps: d }, "Tr2KeyAb", signerA)
      expect(result.ok).toBe(false)
      expect(await readPin(d, "Tr2KeyAb")).toBeUndefined()
    }
  })

  test("the same full hash passes silently; a changed one is KEY_SIGNER_CHANGED until the new full string is typed", async () => {
    const { deps: d, prompts, stderr } = deps([signerA.fingerprint, signerA.fingerprint, signerB.fingerprint])
    await confirmSignerPin({ deps: d }, "Tr2KeyAb", signerA)
    expect(await confirmSignerPin({ deps: d }, "Tr2KeyAb", signerA)).toEqual({ ok: true, pinned: "same" })
    expect(prompts).toHaveLength(1)
    // The server now reports B. Typing A's fingerprint (what the operator knew) is refused.
    const refused = await confirmSignerPin({ deps: d }, "Tr2KeyAb", signerB)
    expect(refused.ok === false && refused.failure.code).toBe("KEY_SIGNER_CHANGED")
    expect(stderr.text).toContain("KEY_SIGNER_CHANGED")
    expect((await readPin(d, "Tr2KeyAb"))?.spkiSha256).toBe(signerA.spkiSha256)
    expect(await confirmSignerPin({ deps: d }, "Tr2KeyAb", signerB)).toEqual({ ok: true, pinned: "changed" })
    expect((await readPin(d, "Tr2KeyAb"))?.spkiSha256).toBe(signerB.spkiSha256)
  })

  test("the comparison is the full hash: a signer whose display matches the pin but whose hash differs is a change", async () => {
    // Same first 15 hex digits, so the same display fingerprint, different key.
    const lookalike = { spkiSha256: `${"a".repeat(15)}${"c".repeat(49)}`, fingerprint: signerA.fingerprint }
    const { deps: d, prompts } = deps([signerA.fingerprint, signerA.fingerprint])
    await confirmSignerPin({ deps: d }, "Tr2KeyAb", signerA)
    expect(await confirmSignerPin({ deps: d }, "Tr2KeyAb", lookalike)).toEqual({ ok: true, pinned: "changed" })
    expect(prompts).toHaveLength(2)
  })
})

describe("which local signer owns a wallet (5.3, T7, T10)", () => {
  test("the key-signer entry whose quorum is the wallet's owner, of any key, active or not; else the legacy slot", async () => {
    const active = pair()
    const previous = pair()
    const legacy = pair()
    const store = createFakeStore({
      [keySignerRef("Tr2KeyAb", active.spkiSha256)]: pemToStoredSigner(active.pem),
      [keySignerRef("Tr2KeyAb", previous.spkiSha256)]: pemToStoredSigner(previous.pem),
      [walletSignerRef("W-legacy")]: pemToStoredSigner(legacy.pem),
    })
    const d = createTestDeps({ fetch: createRoutedFetch({}).fetch, store })
    for (const [p, quorum] of [
      [active, "q-active"],
      [previous, "q-old"],
    ] as const) {
      await saveKeySignerEntry(d, {
        keyPrefix: "Tr2KeyAb",
        spkiSha256: p.spkiSha256,
        fingerprint: keySignerFingerprint(p.spkiSha256),
        publicKeyDer: p.publicKeyDer,
        signerQuorumId: quorum,
        createdAt: 1,
      })
    }
    expect((await localSignerFor(d, "W1", "q-active"))?.pem).toBe(active.pem)
    // A moving wallet, still on the previous signer, is signed by that slot (T10: it keeps trading).
    expect((await localSignerFor(d, "W2", "q-old"))?.pem).toBe(previous.pem)
    const fallback = await localSignerFor(d, "W-legacy", "q-per-wallet")
    expect(fallback?.kind).toBe("legacy")
    expect(fallback?.pem).toBe(legacy.pem)
    expect(await localSignerFor(d, "W-elsewhere", "q-someone-else")).toBeNull()
  })
})

describe("a slot's health (doctor, T12)", () => {
  test("a good slot, a slot whose public half is not the named one, and garbage", () => {
    const p = pair()
    expect(signerSlotProblem(pemToStoredSigner(p.pem), p.spkiSha256)).toBeNull()
    expect(signerSlotProblem(pemToStoredSigner(p.pem), "0".repeat(64))).toContain("does not match")
    expect(signerSlotProblem("not-a-key")).toContain("cannot be parsed")
  })
})
