/**
 * Ember Phase 2 (BE-141, helper protocols): the `candle-enclave` contract, without a Mac.
 *
 * Request validation, each operation over the scripted backend, the typed failures, and the
 * scripted helper over a real pipe: one request line in, one response line out, exit 0 or 1.
 */
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { p256 } from "@noble/curves/p256"
import { base64, hex } from "@scure/base"
import { eciesEncrypt } from "../vault/ecies"
import { ENCLAVE_PROTOCOL, type EnclaveRequest, handleEnclaveLine, parseEnclaveRequest } from "./protocol"
import { type EnclaveScript, scriptedEnclaveBackend } from "./test-backend"

const DIGEST = base64.encode(new Uint8Array(32).fill(1))
const common = { vaultId: "vault", envelopeId: "env1", digest: DIGEST }

async function script(overrides: Partial<EnclaveScript> = {}): Promise<EnclaveScript> {
  const dir = await mkdtemp(join(tmpdir(), "candle-enclave-proto-"))
  return {
    version: "0.12.0",
    bundleId: "tv.candle.cli.enclave",
    teamId: "ABCDE12345",
    secureEnclave: true,
    biometry: "available",
    store: join(dir, "keys.json"),
    ...overrides,
  }
}

describe("request validation", () => {
  test("every refusal is BAD_REQUEST and names the field", () => {
    const rows: Array<[string, RegExp]> = [
      ["not json", /not JSON/],
      ["[]", /not a JSON object/],
      [JSON.stringify({ op: "sign", ...common }), /unknown op "sign"/],
      [JSON.stringify({ op: "info", envelopeId: "e", digest: DIGEST }), /vaultId is missing/],
      [JSON.stringify({ op: "info", ...common, digest: base64.encode(new Uint8Array(31)) }), /digest is 31 bytes/],
      [JSON.stringify({ op: "create", ...common }), /keyTag is missing/],
      [
        JSON.stringify({ op: "create", ...common, keyTag: "t", label: "l", accessControl: "userPresence" }),
        /accessControl must be biometryCurrentSet/,
      ],
      [
        JSON.stringify({
          op: "decrypt",
          ...common,
          keyTag: "t",
          publicKey: base64.encode(new Uint8Array(64)),
          ciphertext: "AA==",
          reason: "r",
        }),
        /publicKey is 64 bytes/,
      ],
      [
        JSON.stringify({
          op: "decrypt",
          ...common,
          keyTag: "t",
          publicKey: base64.encode(new Uint8Array(65)),
          ciphertext: "AA==",
        }),
        /reason is missing/,
      ],
    ]
    for (const [line, message] of rows) {
      expect(() => parseEnclaveRequest(line)).toThrow(message)
      try {
        parseEnclaveRequest(line)
      } catch (error) {
        expect((error as { code: string }).code).toBe("BAD_REQUEST")
      }
    }
  })

  test("a well-formed request of each op parses to exactly its fields", () => {
    expect(parseEnclaveRequest(JSON.stringify({ op: "info", ...common, extra: 1 }))).toEqual({ op: "info", ...common })
    expect(parseEnclaveRequest(JSON.stringify({ op: "delete", ...common, keyTag: "t" }))).toEqual({
      op: "delete",
      ...common,
      keyTag: "t",
    })
  })
})

describe("the four operations over the scripted Enclave", () => {
  test("info reports what the helper and the Mac are; create, decrypt and delete round-trip a packet", async () => {
    const s = await script()
    const backend = () => scriptedEnclaveBackend(s)
    const info = await handleEnclaveLine(JSON.stringify({ op: "info", ...common }), backend)
    expect(info).toMatchObject({
      ok: true,
      protocol: ENCLAVE_PROTOCOL,
      op: "info",
      secureEnclave: true,
      biometry: "available",
      teamId: "ABCDE12345",
    })

    const created = await handleEnclaveLine(
      JSON.stringify({ op: "create", ...common, keyTag: "tag1", label: "l", accessControl: "biometryCurrentSet" }),
      backend,
    )
    expect(created).toMatchObject({ ok: true, op: "create" })
    const point = base64.decode((created as { publicKey: string }).publicKey)
    expect(point.length).toBe(65)
    expect(() => p256.ProjectivePoint.fromHex(point).assertValidity()).not.toThrow()

    const plaintext = new Uint8Array(32).map((_, i) => i)
    const packet = await eciesEncrypt(point, plaintext)
    const decrypted = await handleEnclaveLine(
      JSON.stringify({
        op: "decrypt",
        ...common,
        keyTag: "tag1",
        publicKey: base64.encode(point),
        ciphertext: base64.encode(packet),
        reason: "unlock the Candle vault",
      }),
      backend,
    )
    expect(decrypted).toMatchObject({ ok: true, op: "decrypt", plaintext: base64.encode(plaintext) })

    // A second create under the same tag is refused: the tag is the identity.
    const again = await handleEnclaveLine(
      JSON.stringify({ op: "create", ...common, keyTag: "tag1", label: "l", accessControl: "biometryCurrentSet" }),
      backend,
    )
    expect(again).toMatchObject({ ok: false, code: "KEY_EXISTS" })

    // The wrong public key for the tag, or a tag with no key, is KEY_NOT_FOUND; nothing decrypts.
    const other = p256.getPublicKey(p256.utils.randomPrivateKey(), false)
    const wrongKey = await handleEnclaveLine(
      JSON.stringify({
        op: "decrypt",
        ...common,
        keyTag: "tag1",
        publicKey: base64.encode(other),
        ciphertext: base64.encode(packet),
        reason: "r",
      }),
      backend,
    )
    expect(wrongKey).toMatchObject({ ok: false, code: "KEY_NOT_FOUND" })
    expect(await handleEnclaveLine(JSON.stringify({ op: "delete", ...common, keyTag: "tag1" }), backend)).toMatchObject(
      { ok: true, removed: true },
    )
    expect(await handleEnclaveLine(JSON.stringify({ op: "delete", ...common, keyTag: "tag1" }), backend)).toMatchObject(
      { ok: true, removed: false },
    )
    const gone = await handleEnclaveLine(
      JSON.stringify({
        op: "decrypt",
        ...common,
        keyTag: "tag1",
        publicKey: base64.encode(point),
        ciphertext: base64.encode(packet),
        reason: "r",
      }),
      backend,
    )
    expect(gone).toMatchObject({ ok: false, code: "KEY_NOT_FOUND" })
  })

  test("no Enclave, Touch ID unavailable, and a corrupt packet are each their own typed failure", async () => {
    const noEnclave = await script({ secureEnclave: false })
    expect(
      await handleEnclaveLine(
        JSON.stringify({ op: "create", ...common, keyTag: "t", label: "l", accessControl: "biometryCurrentSet" }),
        () => scriptedEnclaveBackend(noEnclave),
      ),
    ).toMatchObject({ ok: false, code: "NO_ENCLAVE" })

    const lidClosed = await script({ biometry: "unavailable", biometryReason: "Biometry is not available" })
    expect(
      await handleEnclaveLine(
        JSON.stringify({ op: "create", ...common, keyTag: "t", label: "l", accessControl: "biometryCurrentSet" }),
        () => scriptedEnclaveBackend(lidClosed),
      ),
    ).toMatchObject({ ok: false, code: "BIOMETRY_UNAVAILABLE", message: "Biometry is not available" })

    const s = await script()
    const backend = () => scriptedEnclaveBackend(s)
    const created = (await handleEnclaveLine(
      JSON.stringify({ op: "create", ...common, keyTag: "t", label: "l", accessControl: "biometryCurrentSet" }),
      backend,
    )) as { publicKey: string }
    const corrupt = await handleEnclaveLine(
      JSON.stringify({
        op: "decrypt",
        ...common,
        keyTag: "t",
        publicKey: created.publicKey,
        ciphertext: base64.encode(new Uint8Array(90).fill(4)),
        reason: "r",
      }),
      backend,
    )
    expect(corrupt).toMatchObject({ ok: false, code: "DECRYPT_FAILED" })
  })
})

describe("the scripted helper over a real pipe", () => {
  test("one request line in, one response line out, exit 0 on ok and 1 on a typed failure; --version answers", async () => {
    const s = await script()
    const scriptPath = join(s.store, "..", "script.json")
    await writeFile(scriptPath, JSON.stringify(s))
    const helper = join(import.meta.dir, "scripted-helper.ts")
    const run = (request: EnclaveRequest | Record<string, unknown>) =>
      spawnSync("bun", [helper, scriptPath], { input: `${JSON.stringify(request)}\n`, encoding: "utf8" })

    const info = run({ op: "info", ...common })
    expect(info.status).toBe(0)
    expect(info.stdout.trim().split("\n")).toHaveLength(1)
    expect(JSON.parse(info.stdout)).toMatchObject({ ok: true, op: "info", version: "0.12.0" })

    const created = run({ op: "create", ...common, keyTag: "sub", label: "l", accessControl: "biometryCurrentSet" })
    expect(created.status).toBe(0)
    const point = base64.decode((JSON.parse(created.stdout) as { publicKey: string }).publicKey)
    // The key survives into the next process, as a real Enclave key does.
    const stored = JSON.parse(await readFile(s.store, "utf8")) as Record<string, { publicKey: string }>
    expect(stored.sub?.publicKey).toBe(hex.encode(point))

    const packet = await eciesEncrypt(point, new Uint8Array(32).fill(3))
    const decrypted = run({
      op: "decrypt",
      ...common,
      keyTag: "sub",
      publicKey: base64.encode(point),
      ciphertext: base64.encode(packet),
      reason: "r",
    })
    expect(decrypted.status).toBe(0)
    expect(JSON.parse(decrypted.stdout)).toMatchObject({
      ok: true,
      plaintext: base64.encode(new Uint8Array(32).fill(3)),
    })

    const bad = run({
      op: "decrypt",
      ...common,
      keyTag: "nope",
      publicKey: base64.encode(point),
      ciphertext: base64.encode(packet),
      reason: "r",
    })
    expect(bad.status).toBe(1)
    expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false, code: "KEY_NOT_FOUND" })

    const version = spawnSync("bun", [helper, scriptPath, "--version"], { input: "", encoding: "utf8" })
    expect(version.stdout).toBe(`candle-enclave 0.12.0 (protocol ${ENCLAVE_PROTOCOL})\n`)

    const empty = spawnSync("bun", [helper, scriptPath], { input: "", encoding: "utf8" })
    expect(empty.status).toBe(2)
    expect(JSON.parse(empty.stdout)).toMatchObject({ ok: false, code: "BAD_REQUEST" })
  })
})

// ── BE-135: the two passkey operations ────────────────────────────────────────────────────────

describe("passkey-register and passkey-assert (BE-135)", () => {
  const SALT = base64.encode(new Uint8Array(32).fill(9))
  const passkeyScript = (overrides: Partial<EnclaveScript> = {}) =>
    script({
      osVersion: "15.1.0",
      associatedDomains: ["webcredentials:cli.candle.tv"],
      provisioningProfile: true,
      ...overrides,
    })

  test("validation: the relying party is fixed, the hash and the salt are 32 bytes, and the ids are base64", () => {
    const rows: Array<[Record<string, unknown>, RegExp]> = [
      [{ op: "passkey-register", ...common }, /rpId is missing/],
      [{ op: "passkey-register", ...common, rpId: "example.com" }, /rpId must be cli.candle.tv/],
      [
        { op: "passkey-register", ...common, rpId: "cli.candle.tv", clientDataHash: "AA==" },
        /clientDataHash is 1 bytes/,
      ],
      [
        { op: "passkey-register", ...common, rpId: "cli.candle.tv", clientDataHash: DIGEST, userId: "***" },
        /userId is not base64/,
      ],
      [
        { op: "passkey-register", ...common, rpId: "cli.candle.tv", clientDataHash: DIGEST, userId: "AA==" },
        /userName is missing/,
      ],
      [{ op: "passkey-assert", ...common, rpId: "cli.candle.tv", clientDataHash: DIGEST }, /credentialId is missing/],
      [
        {
          op: "passkey-assert",
          ...common,
          rpId: "cli.candle.tv",
          clientDataHash: DIGEST,
          credentialId: "AA==",
          prfSalt: "AA==",
        },
        /prfSalt is 1 bytes/,
      ],
    ]
    for (const [request, message] of rows) {
      let thrown: unknown
      try {
        parseEnclaveRequest(JSON.stringify(request))
      } catch (error) {
        thrown = error
      }
      expect((thrown as { code?: string })?.code).toBe("BAD_REQUEST")
      expect((thrown as { message?: string })?.message).toMatch(message)
    }
    const registerLine = JSON.stringify({
      op: "passkey-register",
      ...common,
      rpId: "cli.candle.tv",
      userId: "AQID",
      userName: "candle vault",
      clientDataHash: DIGEST,
      extra: "ignored",
    })
    expect(parseEnclaveRequest(registerLine)).toEqual({
      op: "passkey-register",
      ...common,
      rpId: "cli.candle.tv",
      userId: "AQID",
      userName: "candle vault",
      clientDataHash: DIGEST,
    })
  })

  test("info reports the gates, register answers an attestation object with the flags, assert answers 32 bytes of PRF", async () => {
    const s = await passkeyScript({
      biometryType: "touchID",
      laError: { code: -4, name: "systemCancel" },
      biometry: "not-interactive",
    })
    const backend = () => scriptedEnclaveBackend(s)
    const info = await handleEnclaveLine(JSON.stringify({ op: "info", ...common }), backend)
    expect(info).toMatchObject({
      ok: true,
      op: "info",
      osVersion: "15.1.0",
      associatedDomains: ["webcredentials:cli.candle.tv"],
      provisioningProfile: true,
      biometry: "not-interactive",
      biometryType: "touchID",
      laError: { code: -4, name: "systemCancel" },
    })

    const registered = await handleEnclaveLine(
      JSON.stringify({
        op: "passkey-register",
        ...common,
        rpId: "cli.candle.tv",
        userId: "AQID",
        userName: "candle vault",
        clientDataHash: DIGEST,
      }),
      backend,
    )
    expect(registered).toMatchObject({ ok: true, op: "passkey-register", prfSupported: true })
    const { credentialId, attestationObject } = registered as { credentialId: string; attestationObject: string }
    const { authDataFromAttestationObject, authDataFlags } = await import("../vault/webauthn-cbor")
    const authData = authDataFromAttestationObject(base64.decode(attestationObject))
    expect(authDataFlags(authData)).toEqual({
      userPresent: true,
      userVerified: true,
      backupEligible: true,
      backupState: true,
    })

    const asserted = await handleEnclaveLine(
      JSON.stringify({
        op: "passkey-assert",
        ...common,
        rpId: "cli.candle.tv",
        credentialId,
        clientDataHash: DIGEST,
        prfSalt: SALT,
      }),
      backend,
    )
    expect(asserted).toMatchObject({ ok: true, op: "passkey-assert" })
    const prf = base64.decode((asserted as { prfOutput: string }).prfOutput)
    expect(prf).toHaveLength(32)
    // Deterministic per credential and salt; different for another salt.
    const again = await handleEnclaveLine(
      JSON.stringify({
        op: "passkey-assert",
        ...common,
        rpId: "cli.candle.tv",
        credentialId,
        clientDataHash: DIGEST,
        prfSalt: SALT,
      }),
      backend,
    )
    expect((again as { prfOutput: string }).prfOutput).toBe((asserted as { prfOutput: string }).prfOutput)
    const other = await handleEnclaveLine(
      JSON.stringify({
        op: "passkey-assert",
        ...common,
        rpId: "cli.candle.tv",
        credentialId,
        clientDataHash: DIGEST,
        prfSalt: base64.encode(new Uint8Array(32).fill(8)),
      }),
      backend,
    )
    expect((other as { prfOutput: string }).prfOutput).not.toBe((asserted as { prfOutput: string }).prfOutput)
  })

  test("macOS 14, no associated domain, an unknown credential and a scripted failure are each their own typed code", async () => {
    const register = (s: EnclaveScript) =>
      handleEnclaveLine(
        JSON.stringify({
          op: "passkey-register",
          ...common,
          rpId: "cli.candle.tv",
          userId: "AQID",
          userName: "u",
          clientDataHash: DIGEST,
        }),
        () => scriptedEnclaveBackend(s),
      )
    expect(await register(await passkeyScript({ osVersion: "14.7.1" }))).toMatchObject({
      ok: false,
      code: "PASSKEY_UNSUPPORTED",
    })
    expect(await register(await passkeyScript({ associatedDomains: [] }))).toMatchObject({
      ok: false,
      code: "DOMAIN_NOT_ASSOCIATED",
    })
    expect(
      await register(
        await passkeyScript({ fail: { passkeyRegister: { code: "CANCELLED", message: "sheet dismissed" } } }),
      ),
    ).toMatchObject({ ok: false, code: "CANCELLED", message: "sheet dismissed" })
    const s = await passkeyScript()
    expect(
      await handleEnclaveLine(
        JSON.stringify({
          op: "passkey-assert",
          ...common,
          rpId: "cli.candle.tv",
          credentialId: "AQID",
          clientDataHash: DIGEST,
          prfSalt: SALT,
        }),
        () => scriptedEnclaveBackend(s),
      ),
    ).toMatchObject({ ok: false, code: "NO_CREDENTIAL" })
  })

  test("the scripted helper over a real pipe answers a passkey registration then an assertion in a later process", async () => {
    const s = await passkeyScript()
    const scriptPath = join(dirname(s.store), "script.json")
    await writeFile(scriptPath, JSON.stringify(s))
    const helper = join(import.meta.dir, "scripted-helper.ts")
    const first = spawnSync("bun", [helper, scriptPath], {
      input: `${JSON.stringify({ op: "passkey-register", ...common, rpId: "cli.candle.tv", userId: "AQID", userName: "u", clientDataHash: DIGEST })}\n`,
      encoding: "utf8",
    })
    expect(first.status).toBe(0)
    const registered = JSON.parse(first.stdout.trim()) as { ok: boolean; credentialId: string }
    expect(registered.ok).toBe(true)
    const second = spawnSync("bun", [helper, scriptPath], {
      input: `${JSON.stringify({ op: "passkey-assert", ...common, rpId: "cli.candle.tv", credentialId: registered.credentialId, clientDataHash: DIGEST, prfSalt: SALT })}\n`,
      encoding: "utf8",
    })
    expect(second.status).toBe(0)
    expect(second.stdout.trim().split("\n")).toHaveLength(1)
    expect(JSON.parse(second.stdout)).toMatchObject({ ok: true, protocol: ENCLAVE_PROTOCOL, op: "passkey-assert" })
  })
})
