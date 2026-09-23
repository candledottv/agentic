/**
 * Ember Phase 2 (BE-140, CC-03, ED-11, CC-12): the security key factor, end to end through `run()`.
 *
 * The authenticator is scripted and everything else is real: the helper protocol (validation,
 * selection, snapshot, feature detection), the CLI's translation and its independent UV check, the
 * ED-4 derivation, the vault write and the re-open with the new factor. The two hardware facts no
 * script can stand in for (that a real key's `hmac-secret` output is what it is, and that a PIN-only
 * key satisfies user verification through the PIN protocol) are T47's, run by hand.
 *
 * Two shapes of fake. The in-process one answers `spawnHelper` by running the real protocol code
 * over a scripted backend, which is fast and lets a test mutate the device set between calls; the
 * subprocess one spawns the scripted helper over a real pipe through the real spawn seam, so the
 * happy path is also proven against the shape the compiled helper has.
 *
 * T58 (CC-12's refusal matrix) is here too, because every row of it is a `run()` with the platform
 * facts injected.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sha256 } from "@noble/hashes/sha256"
import { base58, base64 } from "@scure/base"
import { Keypair } from "@solana/web3.js"
import type { Deps } from "../deps"
import { AUTHDATA_FLAG_BE, AUTHDATA_FLAG_UP, AUTHDATA_FLAG_UV, handleLine, RP_ID } from "../fido2-helper/protocol"
import { type BackendLogEntry, type HelperScript, scriptedBackend } from "../fido2-helper/test-backend"
import { realSpawnHelper, run } from "../index"
import {
  createCapture,
  createFakeStore,
  createRoutedFetch,
  createTestDeps,
  jsonResponse,
  TEST_HOME,
} from "../test-support"
import { HELPER_ENV } from "../vault/fido2"
import { HIDRAW_MESSAGE, SHIPPING_TARGETS } from "../vault/platform"
import { generatedPassphraseFrom, useCheapKdf } from "../vault/test-vault"
import {
  createKeystore,
  defaultTeeKeystorePath,
  type KeystoreEntry,
  readKeystore,
  serializeKeystore,
  TEE_KEYSTORE_PURPOSE,
  writeKeystoreFile,
} from "../wallet-keystore"

setDefaultTimeout(60_000)
useCheapKdf()

const unreachableFetch = (async () => {
  throw new Error("no test in this file should make a network call")
}) as unknown as typeof fetch

const PIN = "482913"
/** The scripted key's PRF output: a fixed 32 bytes, so an unlock derives the same KEK as the add. */
const HMAC_SECRET = base64.encode(new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff))
const CRED = base64.encode(new Uint8Array(48).map((_, i) => (i * 7 + 3) & 0xff))
const AAGUID = "2fc0579f811347eab116bb5a8db9202a"

function authDataFor(rpId: string, flags: number): string {
  const out = new Uint8Array(37)
  out.set(sha256(new TextEncoder().encode(rpId)), 0)
  out[32] = flags
  return base64.encode(out)
}

const UV = authDataFor(RP_ID, AUTHDATA_FLAG_UP | AUTHDATA_FLAG_UV)

const yubikey = (path = "/dev/hidraw3", extra: Partial<HelperScript["devices"][number]> = {}) => ({
  path,
  product: "YubiKey 5 NFC",
  manufacturer: "Yubico",
  aaguid: AAGUID,
  extensions: ["hmac-secret", "credProtect"],
  options: { rk: true, clientPin: true, uv: false },
  ...extra,
})

/** A script for one PIN-only YubiKey that registers and asserts with user verification. */
function goodScript(): HelperScript {
  return {
    devices: [yubikey()],
    register: { credentialId: CRED, aaguid: AAGUID, authData: UV },
    assert: { hmacSecret: HMAC_SECRET, authData: UV },
  }
}

interface Harness {
  deps: Deps
  stdout: ReturnType<typeof createCapture>
  stderr: ReturnType<typeof createCapture>
  asked: string[]
  /** Every call that reached the scripted authenticator, PIN included. */
  calls: BackendLogEntry[]
  dir: string
  vaultPath: string
  script: HelperScript
}

interface HarnessOptions {
  secrets?: string[]
  lines?: string[]
  env?: Record<string, string>
  tty?: boolean
  script?: HelperScript
  /** Whether a helper executable is present. Default present, at CANDLE_FIDO2_HELPER. */
  helper?: "ready" | "absent"
  platform?: string
  arch?: string
  /** Spawn the scripted helper as a real subprocess instead of answering in process. */
  subprocess?: boolean
}

async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = opts.env?.CANDLE_CONFIG_DIR ?? (await mkdtemp(join(tmpdir(), "candle-vault-sk-")))
  const stdout = createCapture()
  const stderr = createCapture()
  const asked: string[] = []
  const calls: BackendLogEntry[] = []
  const secrets = [...(opts.secrets ?? [])]
  const lines = [...(opts.lines ?? [])]
  const script = opts.script ?? goodScript()
  const env: Record<string, string> = { CANDLE_CONFIG_DIR: dir, HOME: dir, ...(opts.env ?? {}) }
  let spawnHelper: Deps["spawnHelper"]
  if (opts.subprocess) {
    const scriptPath = join(dir, `script-${Math.random().toString(36).slice(2)}.json`)
    script.log = join(dir, "backend.log")
    await writeFile(scriptPath, JSON.stringify(script))
    const helper = join(dir, "candle-fido2")
    const scripted = join(import.meta.dir, "..", "fido2-helper", "scripted-helper.ts")
    await writeFile(helper, `#!/bin/sh\nexec bun "${scripted}" "${scriptPath}"\n`)
    await chmod(helper, 0o755)
    env[HELPER_ENV] = helper
    spawnHelper = realSpawnHelper
  } else {
    if ((opts.helper ?? "ready") === "ready") {
      const helper = join(dir, "candle-fido2")
      await writeFile(helper, "#!/bin/sh\nexit 1\n")
      await chmod(helper, 0o755)
      env[HELPER_ENV] = helper
    }
    // The real protocol code over the scripted backend, in process. What `spawnHelper` returns is
    // exactly what the compiled helper prints: one JSON line, exit 0 or 1.
    spawnHelper = async (_path, line) => {
      const response = handleLine(line, () => scriptedBackend(script, (entry) => calls.push(entry)))
      return { stdout: `${JSON.stringify(response)}\n`, stderr: "", exitCode: response.ok ? 0 : 1, signal: null }
    }
  }
  const deps = createTestDeps({
    fetch: unreachableFetch,
    stdout,
    stderr,
    env,
    platform: opts.platform ?? "linux",
    arch: opts.arch ?? "x64",
    isTTY: { stdin: opts.tty ?? true, stdout: opts.tty ?? true, stderr: opts.tty ?? true },
    spawnHelper,
    promptSecret: async (text: string) => {
      asked.push(`secret: ${text}`)
      const next = secrets.shift()
      if (next === undefined) throw new Error(`promptSecret asked for more than the test scripted: ${text}`)
      return next
    },
    promptLine: async (text: string) => {
      asked.push(`line: ${text}`)
      const next = lines.shift()
      if (next === undefined) throw new Error(`promptLine asked for more than the test scripted: ${text}`)
      return next
    },
  })
  return { deps, stdout, stderr, asked, calls, dir, vaultPath: join(dir, "vault.enc"), script }
}

async function initVault(): Promise<Harness & { passphrase: string }> {
  // BE-245: three lines and no secret. Enter at D8's passphrase choice, Enter to acknowledge
  // having saved the words, "no" at the recovery-phrase ceremony. The copy-back is gone.
  const h = await harness({ lines: ["", "", "no"] })
  const code = await run(["vault", "init", "--keystore", h.vaultPath], h.deps)
  if (code !== 0) throw new Error(`init failed (${code}): ${h.stderr.text}${h.stdout.text}`)
  return { ...h, passphrase: generatedPassphraseFrom(h.stdout.text) }
}

interface VaultJson {
  generation: number
  index: { ciphertext: string }
  root: { ciphertext: string }
  envelopes: Array<Record<string, unknown> & { id: string; factor: string; transport?: string }>
  keys: unknown[]
}

async function readVault(path: string): Promise<VaultJson> {
  return JSON.parse(await readFile(path, "utf8")) as VaultJson
}

/** Adds the scripted key to a fresh vault and returns everything a later test needs. */
async function vaultWithKey(opts: Partial<HarnessOptions> = {}) {
  const v = await initVault()
  const add = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [PIN, v.passphrase], ...opts })
  const code = await run(
    ["vault", "factor", "add", "security-key", "--label", "desk key", "--keystore", v.vaultPath],
    add.deps,
  )
  if (code !== 0) throw new Error(`factor add security-key failed (${code}): ${add.stderr.text}${add.stdout.text}`)
  const file = await readVault(v.vaultPath)
  const keyEnvelope = file.envelopes.find(
    (envelope) => envelope.factor === "passkey-prf",
  ) as VaultJson["envelopes"][number]
  return { ...v, add, keyId: keyEnvelope.id, keyEnvelope }
}

describe("factor add security-key: the ceremony", () => {
  test("registers, derives once, writes only the index, and re-opens with the new key before reporting", async () => {
    const v = await initVault()
    const before = await readVault(v.vaultPath)
    const add = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [PIN, v.passphrase] })
    const code = await run(
      ["vault", "factor", "add", "security-key", "--label", "desk key", "--keystore", v.vaultPath],
      add.deps,
    )
    expect(add.stderr.text + add.stdout.text).not.toContain("Error")
    expect(code).toBe(0)

    // The key is settled before the passphrase is asked: PIN first, then the vault.
    expect(add.asked[0]).toContain("PIN for YubiKey 5 NFC")
    expect(add.asked[1]).toContain("Current vault passphrase")
    expect(add.asked).toHaveLength(2)

    // Three touches: register, the assertion the KEK derives from, and the re-open proof. Every
    // one carried the PIN, to the one named path.
    expect(add.calls.map((call) => call.op)).toEqual(["register", "assert", "assert"])
    expect(add.calls.every((call) => call.path === "/dev/hidraw3" && call.pin === PIN)).toBe(true)
    expect(add.calls[0]?.rpId).toBe("cli.candle.tv")
    expect(add.calls[1]?.credentialId).toBe(CRED)
    // The salt the key saw is the ED-11 derivation, not the envelope's raw prfSalt.
    const after = await readVault(v.vaultPath)
    const envelope = after.envelopes.find((candidate) => candidate.factor === "passkey-prf") as Record<string, unknown>
    expect(add.calls[1]?.salt).not.toBe(envelope.prfSalt)

    // ED-1: the index moved under the new header, the root and the key blobs did not.
    expect(after.envelopes).toHaveLength(2)
    expect(after.generation).toBe(before.generation + 1)
    expect(after.index.ciphertext).not.toBe(before.index.ciphertext)
    expect(after.root.ciphertext).toBe(before.root.ciphertext)

    // CC-01's passkey-prf row, recorded; the locator is not.
    expect(envelope).toMatchObject({
      factor: "passkey-prf",
      transport: "ctap2",
      domain: "hardware-token",
      label: "desk key",
      rpId: "cli.candle.tv",
      userVerification: "required",
      backupEligible: false,
      backupState: false,
      saltDerivation: "webauthn-prf",
      aaguid: AAGUID,
      product: "YubiKey 5 NFC",
    })
    expect(JSON.stringify(envelope)).not.toContain("deviceId")
    expect(JSON.stringify(envelope)).not.toContain("hidraw")

    expect(add.stdout.text).toContain("Added security key factor")
    expect(add.stdout.text).toContain("re-read and opened with the new key")
    expect(add.stdout.text).toContain("One security key is not a recoverable factor")
    // One passphrase plus one hardware key: still one recoverable factor (CC-03).
    expect(add.stdout.text).toContain("1 recoverable factor(s)")
  })

  test("the same ceremony over a real subprocess through the real spawn seam", async () => {
    const v = await initVault()
    const add = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [PIN, v.passphrase], subprocess: true })
    const code = await run(["vault", "factor", "add", "security-key", "--keystore", v.vaultPath], add.deps)
    expect(add.stderr.text + add.stdout.text).not.toContain("Error")
    expect(code).toBe(0)
    const log = (await readFile(join(v.dir, "backend.log"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as BackendLogEntry)
    expect(log.map((entry) => entry.op)).toEqual(["register", "assert", "assert"])
    expect(log.every((entry) => entry.pin === PIN)).toBe(true)

    // And the key then opens the vault, over the subprocess too.
    const file = await readVault(v.vaultPath)
    const keyId = file.envelopes.find((envelope) => envelope.factor === "passkey-prf")?.id as string
    const status = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [PIN], subprocess: true })
    expect(await run(["vault", "status", "--unlock", "--factor", keyId, "--keystore", v.vaultPath], status.deps)).toBe(
      0,
    )
    expect(status.stdout.text).toContain("Keys (0)")
  })

  test("no secret reaches stdout, stderr, --json or the file: the PIN and the PRF output are canaries", async () => {
    const v = await initVault()
    const add = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [PIN, v.passphrase] })
    add.deps.stdout = add.stdout
    const code = await run(["vault", "factor", "add", "security-key", "--json", "--keystore", v.vaultPath], add.deps)
    expect(code).toBe(0)
    const payload = JSON.parse(add.stdout.text) as Record<string, unknown>
    expect(payload).toMatchObject({
      ok: true,
      factor: "passkey-prf",
      transport: "ctap2",
      domain: "hardware-token",
      verified: true,
    })
    const everything = add.stdout.text + add.stderr.text + (await readFile(v.vaultPath, "utf8"))
    expect(everything).not.toContain(PIN)
    expect(everything).not.toContain(HMAC_SECRET)
    expect(everything).not.toContain(v.passphrase)
    expect(add.stdout.text.trim().split("\n")).toHaveLength(1)
  })

  test("a key without hmac-secret is refused before the passphrase is asked and before it is touched", async () => {
    const v = await initVault()
    const add = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [PIN, v.passphrase],
      script: { ...goodScript(), devices: [yubikey("/dev/hidraw3", { extensions: ["credProtect"] })] },
    })
    expect(await run(["vault", "factor", "add", "security-key", "--json", "--keystore", v.vaultPath], add.deps)).toBe(1)
    expect(JSON.parse(add.stdout.text)).toMatchObject({ ok: false, code: "VAULT_PRF_UNSUPPORTED" })
    expect(add.asked).toEqual([])
    expect(add.calls).toEqual([])
    expect((await readVault(v.vaultPath)).envelopes).toHaveLength(1)
  })

  test("a key with no PIN and no biometric is VAULT_UV_UNSUPPORTED, never the non-verified secret", async () => {
    const v = await initVault()
    const add = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [v.passphrase],
      script: {
        ...goodScript(),
        devices: [yubikey("/dev/hidraw3", { options: { rk: true, clientPin: false, uv: false } })],
      },
    })
    expect(await run(["vault", "factor", "add", "security-key", "--json", "--keystore", v.vaultPath], add.deps)).toBe(1)
    const payload = JSON.parse(add.stdout.text) as { code: string; suggestion?: string }
    expect(payload.code).toBe("VAULT_UV_UNSUPPORTED")
    expect(payload.suggestion).toContain("Set a PIN on this key")
    expect(add.asked).toEqual([])
    expect(add.calls).toEqual([])
  })

  test("a biometric key with no PIN set is driven with its built-in verification and no PIN prompt", async () => {
    const v = await initVault()
    const add = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [v.passphrase],
      script: {
        ...goodScript(),
        devices: [
          yubikey("/dev/hidraw3", { product: "YubiKey Bio", options: { rk: true, clientPin: false, uv: true } }),
        ],
      },
    })
    expect(await run(["vault", "factor", "add", "security-key", "--keystore", v.vaultPath], add.deps)).toBe(0)
    expect(add.asked.filter((line) => line.includes("PIN"))).toEqual([])
    expect(add.calls.every((call) => call.pin === null)).toBe(true)
  })

  test("with two keys attached and none named, nothing is sent to either and both are listed with --device", async () => {
    const v = await initVault()
    const add = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [PIN, v.passphrase],
      script: { ...goodScript(), devices: [yubikey("/dev/hidraw3"), yubikey("/dev/hidraw4")] },
    })
    expect(await run(["vault", "factor", "add", "security-key", "--json", "--keystore", v.vaultPath], add.deps)).toBe(1)
    const payload = JSON.parse(add.stdout.text) as { code: string; message: string }
    expect(payload.code).toBe("VAULT_AUTHENTICATOR_AMBIGUOUS")
    expect(payload.message.match(/--device \S+/g)).toHaveLength(2)
    expect(add.asked).toEqual([])
    expect(add.calls).toEqual([])
  })

  test("naming one of two keys of the same model drives exactly that key, and the PIN goes nowhere else", async () => {
    const v = await initVault()
    const script = { ...goodScript(), devices: [yubikey("/dev/hidraw3"), yubikey("/dev/hidraw4")] }
    const list = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, script })
    // The ids come from a listing, as they would for an operator.
    const listed = handleLine(
      JSON.stringify({ op: "info", vaultId: "v", envelopeId: "e", digest: base64.encode(new Uint8Array(32)) }),
      () => scriptedBackend(script),
    )
    if (!listed.ok || listed.op !== "info") throw new Error("listing failed")
    const second = listed.devices.find((device) => device.path === "/dev/hidraw4")?.deviceId as string
    void list
    const add = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [PIN, v.passphrase], script })
    expect(
      await run(["vault", "factor", "add", "security-key", "--device", second, "--keystore", v.vaultPath], add.deps),
    ).toBe(0)
    expect(add.calls.length).toBe(3)
    expect(add.calls.every((call) => call.path === "/dev/hidraw4" && call.pin === PIN)).toBe(true)
    expect(add.calls.some((call) => call.path === "/dev/hidraw3")).toBe(false)
  })

  test("a credential the key reports as backup-eligible is refused as not hardware-bound, nothing written", async () => {
    const v = await initVault()
    const add = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [PIN, v.passphrase],
      script: {
        ...goodScript(),
        register: {
          credentialId: CRED,
          aaguid: AAGUID,
          authData: authDataFor(RP_ID, AUTHDATA_FLAG_UP | AUTHDATA_FLAG_UV | AUTHDATA_FLAG_BE),
        },
      },
    })
    expect(await run(["vault", "factor", "add", "security-key", "--json", "--keystore", v.vaultPath], add.deps)).toBe(1)
    const payload = JSON.parse(add.stdout.text) as { code: string; message: string }
    expect(payload.code).toBe("VAULT_FACTOR_UNAVAILABLE")
    expect(payload.message).toContain("backup-eligible")
    expect((await readVault(v.vaultPath)).envelopes).toHaveLength(1)
    expect(add.calls.map((call) => call.op)).toEqual(["register"])
  })

  test("a registration the key made without user verification is refused with nothing written", async () => {
    const v = await initVault()
    const add = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [PIN, v.passphrase],
      script: {
        ...goodScript(),
        register: { credentialId: CRED, aaguid: AAGUID, authData: authDataFor(RP_ID, AUTHDATA_FLAG_UP) },
      },
    })
    expect(await run(["vault", "factor", "add", "security-key", "--json", "--keystore", v.vaultPath], add.deps)).toBe(1)
    const payload = JSON.parse(add.stdout.text) as { code: string; message: string }
    expect(payload.code).toBe("VAULT_UNLOCK_FAILED")
    expect(payload.message).toContain("UV flag is clear")
    expect((await readVault(v.vaultPath)).envelopes).toHaveLength(1)
  })

  test("an empty PIN is VAULT_PIN_REQUIRED and nothing is sent to the key; a wrong PIN is VAULT_PIN_INVALID", async () => {
    const v = await initVault()
    const empty = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [""] })
    expect(await run(["vault", "factor", "add", "security-key", "--json", "--keystore", v.vaultPath], empty.deps)).toBe(
      1,
    )
    expect(JSON.parse(empty.stdout.text)).toMatchObject({ code: "VAULT_PIN_REQUIRED" })
    expect(empty.calls).toEqual([])

    const wrong = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: ["000000", v.passphrase],
      script: { ...goodScript(), register: { error: { code: "PIN_INVALID", message: "FIDO_ERR_PIN_INVALID" } } },
    })
    expect(await run(["vault", "factor", "add", "security-key", "--json", "--keystore", v.vaultPath], wrong.deps)).toBe(
      1,
    )
    expect(JSON.parse(wrong.stdout.text)).toMatchObject({ code: "VAULT_PIN_INVALID" })
    expect((await readVault(v.vaultPath)).envelopes).toHaveLength(1)
  })

  test("a cancelled or timed-out touch is VAULT_AUTHENTICATOR_CANCELLED with nothing written", async () => {
    const v = await initVault()
    const add = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [PIN, v.passphrase],
      script: { ...goodScript(), register: { error: { code: "CANCELLED", message: "FIDO_ERR_USER_ACTION_TIMEOUT" } } },
    })
    expect(await run(["vault", "factor", "add", "security-key", "--json", "--keystore", v.vaultPath], add.deps)).toBe(1)
    expect(JSON.parse(add.stdout.text)).toMatchObject({ code: "VAULT_AUTHENTICATOR_CANCELLED" })
    expect((await readVault(v.vaultPath)).envelopes).toHaveLength(1)
  })

  test("a key removed between the listing and the operation is VAULT_AUTHENTICATOR_CHANGED", async () => {
    const v = await initVault()
    const add = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [PIN, v.passphrase] })
    // Unplugged after `info` (which the session ran) and before `register` (which re-enumerates).
    const original = add.deps.promptSecret
    add.deps.promptSecret = async (text) => {
      if (text.includes("Current vault passphrase")) add.script.devices = []
      return original(text)
    }
    expect(await run(["vault", "factor", "add", "security-key", "--json", "--keystore", v.vaultPath], add.deps)).toBe(1)
    expect(JSON.parse(add.stdout.text)).toMatchObject({ code: "VAULT_AUTHENTICATOR_CHANGED" })
    expect(add.calls).toEqual([])
    expect((await readVault(v.vaultPath)).envelopes).toHaveLength(1)
  })

  test("a key that disappears during the operation is VAULT_FACTOR_UNAVAILABLE, not a retry elsewhere", async () => {
    const v = await initVault()
    const add = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [PIN, v.passphrase],
      script: { ...goodScript(), register: { error: { code: "DEVICE_IO", message: "FIDO_ERR_TX" } } },
    })
    expect(await run(["vault", "factor", "add", "security-key", "--json", "--keystore", v.vaultPath], add.deps)).toBe(1)
    expect(JSON.parse(add.stdout.text)).toMatchObject({ code: "VAULT_FACTOR_UNAVAILABLE" })
    expect(add.calls.map((call) => call.op)).toEqual(["register"])
  })
})

describe("unlocking with a security key", () => {
  test("--factor <id> drives that envelope; status --unlock lists the keys; two assertions for new-key", async () => {
    const v = await vaultWithKey()
    const status = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [PIN] })
    expect(
      await run(["vault", "status", "--unlock", "--factor", v.keyId, "--keystore", v.vaultPath], status.deps),
    ).toBe(0)
    expect(status.asked).toEqual([expect.stringContaining("PIN for YubiKey 5 NFC")])
    expect(status.calls.map((call) => call.op)).toEqual(["assert"])
    expect(status.stdout.text).toContain("Keys (0)")

    // new-key opens, writes, then re-opens the written file with the same factor: a second touch.
    const key = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [PIN] })
    expect(
      await run(
        ["vault", "new-key", "--chain", "solana", "--factor", "security-key", "--keystore", v.vaultPath],
        key.deps,
      ),
    ).toBe(0)
    expect(key.calls.map((call) => call.op)).toEqual(["assert", "assert"])
    expect(key.asked).toHaveLength(1)
    expect((await readVault(v.vaultPath)).keys).toHaveLength(1)
  })

  test("with a passphrase and a key both drivable and no --factor, the operator is asked which", async () => {
    const v = await vaultWithKey()
    const byKey = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, lines: [v.keyId], secrets: [PIN] })
    expect(await run(["vault", "status", "--unlock", "--keystore", v.vaultPath], byKey.deps)).toBe(0)
    expect(byKey.asked[0]).toContain("Type passphrase, or the id of a security key envelope")
    expect(byKey.asked[0]).toContain(v.keyId)
    expect(byKey.calls.map((call) => call.op)).toEqual(["assert"])

    const byPassphrase = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      lines: ["passphrase"],
      secrets: [v.passphrase],
    })
    expect(await run(["vault", "status", "--unlock", "--keystore", v.vaultPath], byPassphrase.deps)).toBe(0)
    expect(byPassphrase.calls).toEqual([])

    const neither = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, lines: ["whatever"] })
    expect(await run(["vault", "status", "--unlock", "--json", "--keystore", v.vaultPath], neither.deps)).toBe(1)
    expect(JSON.parse(neither.stdout.text)).toMatchObject({ code: "VAULT_FACTOR_UNAVAILABLE" })
    expect(neither.calls).toEqual([])
  })

  test("the passphrase-only vault is untouched by any of this: no prompt for which factor, no helper run", async () => {
    const v = await initVault()
    const status = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [v.passphrase] })
    expect(await run(["vault", "status", "--unlock", "--keystore", v.vaultPath], status.deps)).toBe(0)
    expect(status.asked).toEqual([expect.stringContaining("Vault passphrase")])
    expect(status.calls).toEqual([])
  })

  test("an assertion made without user verification is refused before any unwrap, with nothing derived", async () => {
    const v = await vaultWithKey()
    const status = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [PIN],
      script: { ...goodScript(), assert: { hmacSecret: HMAC_SECRET, authData: authDataFor(RP_ID, AUTHDATA_FLAG_UP) } },
    })
    expect(
      await run(["vault", "status", "--unlock", "--factor", v.keyId, "--json", "--keystore", v.vaultPath], status.deps),
    ).toBe(1)
    const payload = JSON.parse(status.stdout.text) as { code: string; message: string }
    expect(payload.code).toBe("VAULT_UNLOCK_FAILED")
    expect(payload.message).toContain("UV flag is clear")
    expect(status.stdout.text).not.toContain(HMAC_SECRET)
  })

  test("the named key does not hold the credential: VAULT_CREDENTIAL_NOT_PRESENT, one attempt, no passphrase asked", async () => {
    const v = await vaultWithKey()
    const status = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [PIN],
      script: { ...goodScript(), assert: { error: { code: "NO_CREDENTIAL", message: "FIDO_ERR_NO_CREDENTIALS" } } },
    })
    expect(
      await run(["vault", "status", "--unlock", "--factor", v.keyId, "--json", "--keystore", v.vaultPath], status.deps),
    ).toBe(1)
    expect(JSON.parse(status.stdout.text)).toMatchObject({ code: "VAULT_CREDENTIAL_NOT_PRESENT" })
    expect(status.calls.map((call) => call.op)).toEqual(["assert"])
    expect(status.asked.filter((line) => line.includes("passphrase"))).toEqual([])
  })

  test("a helper code the CLI does not know is VAULT_UNLOCK_FAILED and is never retried against the passphrase", async () => {
    const v = await vaultWithKey()
    const status = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [PIN],
      script: { ...goodScript(), assert: { error: { code: "SOMETHING_NEW" as never, message: "future" } } },
    })
    expect(
      await run(["vault", "status", "--unlock", "--factor", v.keyId, "--json", "--keystore", v.vaultPath], status.deps),
    ).toBe(1)
    const payload = JSON.parse(status.stdout.text) as { code: string; message: string }
    expect(payload.code).toBe("VAULT_UNLOCK_FAILED")
    expect(payload.message).toContain("SOMETHING_NEW")
    expect(status.asked).toHaveLength(1)
  })

  test("a different key's PRF output does not unwrap: VAULT_UNLOCK_FAILED, nothing derived from it", async () => {
    const v = await vaultWithKey()
    const other = base64.encode(new Uint8Array(32).fill(0xee))
    const status = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [PIN],
      script: { ...goodScript(), assert: { hmacSecret: other, authData: UV } },
    })
    expect(
      await run(["vault", "status", "--unlock", "--factor", v.keyId, "--json", "--keystore", v.vaultPath], status.deps),
    ).toBe(1)
    const payload = JSON.parse(status.stdout.text) as { code: string; suggestion?: string }
    expect(payload.code).toBe("VAULT_UNLOCK_FAILED")
    expect(payload.suggestion).toContain("no other factor was tried")
  })

  test("userVerification: required edited out of the envelope breaks the file; an edited salt breaks the tag", async () => {
    const v = await vaultWithKey()
    const original = await readFile(v.vaultPath, "utf8")
    const edited = JSON.parse(original) as VaultJson
    const envelope = edited.envelopes.find((candidate) => candidate.factor === "passkey-prf") as Record<string, unknown>
    delete envelope.userVerification
    await writeFile(v.vaultPath, JSON.stringify(edited, null, 2))
    const stripped = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [PIN] })
    expect(await run(["vault", "status", "--keystore", v.vaultPath], stripped.deps)).toBe(1)
    expect(stripped.stderr.text).toContain("userVerification: required")

    const resalted = JSON.parse(original) as VaultJson
    const target = resalted.envelopes.find((candidate) => candidate.factor === "passkey-prf") as Record<string, unknown>
    target.prfSalt = base64
      .encode(new Uint8Array(32).fill(1))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    await writeFile(v.vaultPath, JSON.stringify(resalted, null, 2))
    const wrong = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [PIN] })
    expect(
      await run(["vault", "status", "--unlock", "--factor", v.keyId, "--json", "--keystore", v.vaultPath], wrong.deps),
    ).toBe(1)
    expect(JSON.parse(wrong.stdout.text)).toMatchObject({ code: "VAULT_UNLOCK_FAILED" })
    await writeFile(v.vaultPath, original)
  })

  test("backup opens the copy with the same key (a second touch) and verifies it in full", async () => {
    const v = await vaultWithKey()
    const dest = join(await mkdtemp(join(tmpdir(), "candle-vault-copy-")), "vault-backup.enc")
    const backup = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [PIN] })
    const code = await run(
      ["vault", "backup", "--to", dest, "--factor", "security-key", "--keystore", v.vaultPath],
      backup.deps,
    )
    expect(backup.stderr.text + backup.stdout.text).not.toContain("Error")
    expect(code).toBe(0)
    expect(backup.calls.map((call) => call.op)).toEqual(["assert", "assert"])
    expect(backup.stdout.text).toContain("all 8 passed")
  })

  test("factor list and status report the key as available here, with the helper, and as unavailable without", async () => {
    const v = await vaultWithKey()
    const withHelper = await harness({ env: { CANDLE_CONFIG_DIR: v.dir } })
    expect(await run(["vault", "factor", "list", "--json", "--keystore", v.vaultPath], withHelper.deps)).toBe(0)
    const listed = JSON.parse(withHelper.stdout.text) as {
      envelopes: Array<{ factor: string; transport?: string; availability: string; domain: string }>
      recoverableFactors: number
    }
    const key = listed.envelopes.find((envelope) => envelope.factor === "passkey-prf")
    expect(key).toMatchObject({ transport: "ctap2", domain: "hardware-token", availability: "available" })
    expect(listed.recoverableFactors).toBe(1)

    const without = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, helper: "absent" })
    expect(await run(["vault", "status", "--json", "--keystore", v.vaultPath], without.deps)).toBe(0)
    const status = JSON.parse(without.stdout.text) as {
      envelopes: Array<{ factor: string; availability: string; availabilityReason?: string }>
    }
    const absent = status.envelopes.find((envelope) => envelope.factor === "passkey-prf")
    expect(absent?.availability).toBe("unavailable-on-this-device")
    expect(absent?.availabilityReason).toContain("npm package")
  })

  test("two envelopes on two keys are a recoverable pair; the CLI cannot tell two on one key apart and says so", async () => {
    const v = await vaultWithKey()
    const second = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [PIN, v.passphrase],
      script: {
        ...goodScript(),
        devices: [yubikey("/dev/hidraw7")],
        register: { credentialId: base64.encode(new Uint8Array(48).fill(5)), aaguid: AAGUID, authData: UV },
      },
    })
    expect(
      await run(
        ["vault", "factor", "add", "security-key", "--label", "drawer key", "--keystore", v.vaultPath],
        second.deps,
      ),
    ).toBe(0)
    expect(second.stdout.text).toContain("2 recoverable factor(s)")
    expect(second.stdout.text).toContain("Two security key envelopes on two different keys are a recoverable pair")
  })
})

describe("T58: CC-12's refusal matrix, every row with the platform injected", () => {
  const rows: Array<{ platform: string; arch: string; shipping: boolean }> = [
    { platform: "darwin", arch: "arm64", shipping: true },
    { platform: "darwin", arch: "x64", shipping: true },
    { platform: "linux", arch: "x64", shipping: true },
    { platform: "linux", arch: "arm64", shipping: true },
    { platform: "win32", arch: "x64", shipping: false },
  ]

  for (const row of rows) {
    test(`${row.platform}-${row.arch}: factor add of each unsupported or unavailable factor is typed, and nothing is substituted`, async () => {
      const v = await initVault()
      const facts = { platform: row.platform, arch: row.arch }

      // Security key with no helper: on a shipping target it is the helper that is missing; off
      // them the platform itself is refused (BE-124).
      const noHelper = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, helper: "absent", ...facts })
      expect(
        await run(["vault", "factor", "add", "security-key", "--json", "--keystore", v.vaultPath], noHelper.deps),
      ).toBe(1)
      const securityKey = JSON.parse(noHelper.stdout.text) as { code: string; message: string; suggestion?: string }
      expect(securityKey.code).toBe(row.shipping ? "VAULT_HELPER_MISSING" : "VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM")
      expect(securityKey.message).toContain(row.shipping ? "npm package" : "BE-124")
      expect(`${securityKey.message} ${securityKey.suggestion}`).toContain("No other factor is substituted")
      expect(noHelper.asked).toEqual([])

      // Secure Enclave and the synced passkey: PRs F and G, refused everywhere in this release.
      const touchId = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, ...facts })
      expect(await run(["vault", "factor", "add", "touch-id", "--json", "--keystore", v.vaultPath], touchId.deps)).toBe(
        1,
      )
      const enclave = JSON.parse(touchId.stdout.text) as { code: string; message: string }
      expect(enclave.code).toBe("VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM")
      expect(enclave.message).toContain(row.platform === "darwin" ? "a later release" : "macOS only")

      const passkey = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, ...facts })
      expect(await run(["vault", "factor", "add", "passkey", "--json", "--keystore", v.vaultPath], passkey.deps)).toBe(
        1,
      )
      const synced = JSON.parse(passkey.stdout.text) as { code: string; message: string }
      expect(synced.code).toBe("VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM")
      expect(synced.message).toContain(row.platform === "darwin" ? "a later release" : "macOS only")

      // A supported factor with the helper present and no device attached.
      if (row.shipping) {
        const noDevice = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, ...facts, script: { devices: [] } })
        expect(
          await run(["vault", "factor", "add", "security-key", "--json", "--keystore", v.vaultPath], noDevice.deps),
        ).toBe(1)
        expect(JSON.parse(noDevice.stdout.text)).toMatchObject({ code: "VAULT_FACTOR_UNAVAILABLE" })
        expect((await readVault(v.vaultPath)).envelopes).toHaveLength(1)
      }
    })
  }

  test("an envelope of an unsupported transport is listed unsupported-on-this-platform, not offered, and refused by name", async () => {
    const v = await initVault()
    // A platform-macos envelope (PR G, BE-135) in CC-01's shape. This build's policy is `omit`,
    // so on macOS the factor is not in the build and on Linux it is macOS only; either way the
    // envelope is kept verbatim (ED-7) and never offered.
    const file = JSON.parse(await readFile(v.vaultPath, "utf8")) as VaultJson
    file.envelopes.push({
      id: "g1g1g1g1",
      factor: "passkey-prf",
      transport: "platform-macos",
      domain: "apple-account",
      label: "synced",
      createdAt: "2026-09-18T00:00:00.000Z",
      rpId: "cli.candle.tv",
      credentialId: "AQIDBAUGBwgJCgsMDQ4PEA",
      prfSalt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      userVerification: "required",
      backupEligible: true,
      backupState: true,
      saltDerivation: "platform",
      helper: { teamId: "ABCDE12345", bundleId: "tv.candle.cli.enclave", minVersion: "0.13.0" },
      wrap: {
        alg: "AES-256-GCM",
        iv: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    })
    await writeFile(v.vaultPath, JSON.stringify(file, null, 2))

    for (const platform of ["darwin", "linux"]) {
      const status = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, platform })
      expect(await run(["vault", "status", "--json", "--keystore", v.vaultPath], status.deps)).toBe(0)
      const listed = JSON.parse(status.stdout.text) as {
        envelopes: Array<{ id: string; availability: string; availabilityReason?: string }>
      }
      const synced = listed.envelopes.find((envelope) => envelope.id === "g1g1g1g1")
      expect(synced?.availability).toBe("unsupported-on-this-platform")
      expect(synced?.availabilityReason).toContain(platform === "darwin" ? "a later release" : "macOS only")

      // Asked for explicitly: the typed code, before any prompt, and no other envelope tried.
      const explicit = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, platform })
      expect(
        await run(
          ["vault", "status", "--unlock", "--factor", "g1g1g1g1", "--json", "--keystore", v.vaultPath],
          explicit.deps,
        ),
      ).toBe(1)
      expect(JSON.parse(explicit.stdout.text)).toMatchObject({ code: "VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM" })
      expect(explicit.asked).toEqual([])
      expect(explicit.calls).toEqual([])
    }

    // And with no --factor the passphrase is used without a menu: the synced envelope is not offered.
    const plain = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, platform: "darwin", secrets: [v.passphrase] })
    // The header changed outside this CLI, so the open itself fails the index tag; what matters
    // here is that the only prompt was the passphrase and no menu offered the unsupported envelope.
    await run(["vault", "status", "--unlock", "--keystore", v.vaultPath], plain.deps)
    expect(plain.asked).toEqual([expect.stringContaining("Vault passphrase")])
  })

  test("a security key envelope with no helper is unavailable-on-this-device, and asking for it is VAULT_HELPER_MISSING", async () => {
    const v = await vaultWithKey()
    const explicit = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, helper: "absent" })
    expect(
      await run(
        ["vault", "status", "--unlock", "--factor", v.keyId, "--json", "--keystore", v.vaultPath],
        explicit.deps,
      ),
    ).toBe(1)
    const payload = JSON.parse(explicit.stdout.text) as { code: string; suggestion?: string }
    expect(payload.code).toBe("VAULT_HELPER_MISSING")
    expect(explicit.asked).toEqual([])
    // With no --factor, the passphrase opens it without a menu: the key is not offered here.
    const plain = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, helper: "absent", secrets: [v.passphrase] })
    expect(await run(["vault", "status", "--unlock", "--keystore", v.vaultPath], plain.deps)).toBe(0)
    expect(plain.asked).toEqual([expect.stringContaining("Vault passphrase")])
  })

  test("the Linux hidraw message is printed verbatim with VAULT_AUTHENTICATOR_NOT_READABLE, and never suggests root", async () => {
    const v = await initVault()
    const linux = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      platform: "linux",
      script: { ...goodScript(), devices: [yubikey("/dev/hidraw3", { unreadable: true })] },
    })
    expect(await run(["vault", "factor", "add", "security-key", "--json", "--keystore", v.vaultPath], linux.deps)).toBe(
      1,
    )
    const payload = JSON.parse(linux.stdout.text) as { code: string; message: string }
    expect(payload.code).toBe("VAULT_AUTHENTICATOR_NOT_READABLE")
    expect(payload.message).toBe(HIDRAW_MESSAGE)
    expect(payload.message).not.toMatch(/sudo|as root/)
    expect(linux.asked).toEqual([])
    expect(linux.calls).toEqual([])

    // With another, readable key attached and named, the unreadable one is simply not touched.
    const named = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      platform: "linux",
      secrets: [PIN, v.passphrase],
      script: { ...goodScript(), devices: [yubikey("/dev/hidraw3", { unreadable: true }), yubikey("/dev/hidraw4")] },
    })
    const listed = handleLine(
      JSON.stringify({ op: "info", vaultId: "v", envelopeId: "e", digest: base64.encode(new Uint8Array(32)) }),
      () => scriptedBackend(named.script),
    )
    if (!listed.ok || listed.op !== "info") throw new Error("listing failed")
    const readable = listed.devices.find((device) => device.readable)?.deviceId as string
    expect(
      await run(
        ["vault", "factor", "add", "security-key", "--device", readable, "--keystore", v.vaultPath],
        named.deps,
      ),
    ).toBe(0)
    expect(named.calls.every((call) => call.path === "/dev/hidraw4")).toBe(true)
  })

  test("the Windows row has no binary: the release target list has not silently gained one (E24)", async () => {
    expect([...SHIPPING_TARGETS].sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"])
    const candidates = [
      join(import.meta.dir, "..", "..", "..", "..", "distribution", "agentic", ".github", "workflows", "release.yaml"),
      join(import.meta.dir, "..", "..", "..", "..", ".github", "workflows", "release.yaml"),
    ]
    let workflow: string | undefined
    for (const candidate of candidates) {
      try {
        workflow = await readFile(candidate, "utf8")
        break
      } catch {
        // Try the next location.
      }
    }
    if (workflow === undefined) throw new Error(`release.yaml not found at any of: ${candidates.join(", ")}`)
    const listed = workflow
      .match(/^\s+RELEASE_TARGETS:\s*(.+)$/m)?.[1]
      ?.trim()
      .split(/\s+/)
    expect(listed?.slice().sort()).toEqual([...SHIPPING_TARGETS].sort())
    const loops = [...workflow.matchAll(/for target in ([^;]+); do/g)].map((match) => (match[1] ?? "").trim())
    expect(loops.length).toBeGreaterThan(0)
    for (const loop of loops) {
      const targets = loop === `\${RELEASE_TARGETS}` || loop === "$RELEASE_TARGETS" ? listed : loop.split(/\s+/)
      expect([...(targets ?? [])].sort()).toEqual([...SHIPPING_TARGETS].sort())
    }
    expect(workflow).not.toMatch(/windows|win32|\.exe/i)
    // The helper is built in the same loop, and signed by the same step, as the four binaries.
    expect(workflow).toContain(`candle-fido2-\${target}`)
    expect(workflow).toMatch(/cosign sign-blob[^\n]*\n/)
    expect(workflow).toContain(
      "candle-fido2-darwin-arm64 candle-fido2-darwin-x64 candle-fido2-linux-x64 candle-fido2-linux-arm64",
    )
  })
})

describe("what refuses without a terminal", () => {
  test("factor add security-key needs a terminal for the PIN and the passphrase", async () => {
    const v = await initVault()
    const piped = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, tty: false })
    expect(await run(["vault", "factor", "add", "security-key", "--json", "--keystore", v.vaultPath], piped.deps)).toBe(
      1,
    )
    const payload = JSON.parse(piped.stdout.text) as { message: string }
    expect(payload.message).toContain("security key PIN")
    expect(piped.calls).toEqual([])
  })
})

describe("TEE paths honour --factor and --device (the vault-backed TEE lifecycle and tee enable --vault-key)", () => {
  const TEE_PASS = "a strong tee-store passphrase"
  const ACCOUNT = "AcctSecurityKey11111111111111111111111111"
  const API = "https://api.test"
  const teeKey = Keypair.generate()
  const TEE = teeKey.publicKey.toBase58()
  const freshKey = Keypair.generate()
  const FRESH = freshKey.publicKey.toBase58()
  const VAULT_DEST = Keypair.generate().publicKey.toBase58()

  function teeEntry(key: Keypair, address: string, overrides: Partial<KeystoreEntry> = {}): KeystoreEntry {
    return {
      index: 0,
      chain: "solana",
      address,
      label: "tee-0",
      createdAt: "2026-09-16T00:00:00.000Z",
      privateKey: base58.encode(key.secretKey),
      imported: false,
      tee: { network: "solana-mainnet" },
      ...overrides,
    }
  }

  /** An enabled Phase 1 TEE entry, the shape `import-legacy` migrates to `lifecycle: "enabled"`. */
  const enabledTee = (): KeystoreEntry =>
    teeEntry(teeKey, TEE, {
      imported: true,
      linkedWalletId: "lw_tee1",
      privyWalletId: "pw_tee1",
      importedAt: "2026-09-16T01:00:00.000Z",
      tee: {
        network: "solana-mainnet",
        vaultDestination: VAULT_DEST,
        boundKeyPrefix: "ck_live_x",
        remoteAuthority: "verified-active",
        enabledAt: "2026-09-16T01:00:00.000Z",
      },
    })

  async function seedTeeStore(dir: string, entries: KeystoreEntry[]): Promise<string> {
    const ks = await createKeystore(TEE_PASS)
    const path = defaultTeeKeystorePath({ CANDLE_CONFIG_DIR: dir }, TEST_HOME)
    await writeKeystoreFile(
      path,
      await serializeKeystore(entries, ks.key, ks.salt, ks.iterations, TEE_KEYSTORE_PURPOSE),
    )
    return path
  }

  /** The harness with real files (the TEE store is read through `deps.readFile`), a profile whose
   * account the migration records, and an API key for the lifecycle read. */
  async function teeHarness(dir: string, opts: Omit<HarnessOptions, "env"> & { fetch?: typeof fetch } = {}) {
    const h = await harness({ env: { CANDLE_CONFIG_DIR: dir }, ...opts })
    h.deps.readFile = (path) => readFile(path, "utf8")
    h.deps.writeFile = (path, content) => writeFile(path, content, "utf8")
    h.deps.store = createFakeStore({ "profile:sk:api_key": "ck_live_x" })
    if (opts.fetch) h.deps.fetch = opts.fetch
    await h.deps.writeConfig({
      activeProfile: "sk",
      profiles: { sk: { account: ACCOUNT, apiUrl: API, accountCachedAt: Date.now() } },
    })
    return h
  }

  /** A vault with a passphrase and the scripted key, holding a migrated enabled TEE entry. */
  async function vaultWithKeyAndTee() {
    const v = await vaultWithKey()
    const teePath = await seedTeeStore(v.dir, [enabledTee()])
    // The migration itself opens the vault with the key: the legacy store passphrase first, then
    // the factor `--factor` names (PIN and a touch), and the on-disk verification re-opens with it.
    const migrate = await teeHarness(v.dir, { secrets: [TEE_PASS, PIN] })
    const code = await run(
      [
        "vault",
        "import-legacy",
        "--tee",
        "--from",
        teePath,
        "--factor",
        v.keyId,
        "--no-verify-account",
        "--keystore",
        v.vaultPath,
      ],
      migrate.deps,
    )
    if (code !== 0) throw new Error(`import-legacy failed (${code}): ${migrate.stderr.text}${migrate.stdout.text}`)
    expect(migrate.calls.map((call) => call.op)).toEqual(["assert", "assert"])
    expect(migrate.asked.filter((line) => line.includes("Vault passphrase"))).toEqual([])
    return { ...v, teePath }
  }

  test("tee status on a migrated vault TEE entry opens with --factor <key>, no passphrase asked, no legacy store read", async () => {
    const v = await vaultWithKeyAndTee()
    const routes = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () =>
        jsonResponse(200, {
          success: true,
          id: "lw_tee1",
          state: "enabled",
          remoteAuthority: "verified-active",
          evidenceObservedAt: 1_726_000_000_000,
          profile: "ember-tee",
          boundKeyPrefix: "ck_live_x",
          vaultDestination: VAULT_DEST,
        }),
    })
    const status = await teeHarness(v.dir, { secrets: [PIN], fetch: routes.fetch })
    const code = await run(["tee", "status", TEE, "--json", "--factor", v.keyId, "--no-verify-account"], status.deps)
    expect(status.stderr.text).not.toContain("Error")
    expect(code).toBe(0)
    const report = JSON.parse(status.stdout.text) as {
      source: string
      vaultLifecycle: string
      server: { state: string }
    }
    expect(report.source).toBe("vault")
    expect(report.vaultLifecycle).toBe("enabled")
    expect(report.server.state).toBe("enabled")
    // Exactly one factor prompt, the key's PIN; one assertion; the TEE store passphrase never asked.
    expect(status.asked).toEqual([expect.stringContaining("PIN for YubiKey 5 NFC")])
    expect(status.calls.map((call) => call.op)).toEqual(["assert"])
    expect(status.calls[0]?.pin).toBe(PIN)
  })

  test("with both factors drivable and no --factor, the TEE command asks which, like every vault command", async () => {
    const v = await vaultWithKeyAndTee()
    const byKey = await teeHarness(v.dir, { lines: [v.keyId], secrets: [PIN] })
    expect(await run(["tee", "status", TEE, "--json", "--no-verify-account"], byKey.deps)).toBe(0)
    expect(byKey.asked[0]).toContain("Type passphrase, or the id of a security key envelope")
    expect(byKey.calls.map((call) => call.op)).toEqual(["assert"])

    const byPassphrase = await teeHarness(v.dir, { lines: ["passphrase"], secrets: [v.passphrase] })
    expect(await run(["tee", "status", TEE, "--json", "--no-verify-account"], byPassphrase.deps)).toBe(0)
    expect(byPassphrase.calls).toEqual([])
  })

  test("a key that does not hold the credential refuses the TEE command typed: no passphrase, no legacy store, no retry", async () => {
    const v = await vaultWithKeyAndTee()
    const status = await teeHarness(v.dir, {
      secrets: [PIN],
      script: { ...goodScript(), assert: { error: { code: "NO_CREDENTIAL", message: "FIDO_ERR_NO_CREDENTIALS" } } },
    })
    expect(await run(["tee", "status", TEE, "--json", "--factor", v.keyId, "--no-verify-account"], status.deps)).toBe(1)
    expect(JSON.parse(status.stdout.text)).toMatchObject({ code: "VAULT_CREDENTIAL_NOT_PRESENT" })
    expect(status.asked).toEqual([expect.stringContaining("PIN for YubiKey 5 NFC")])
    expect(status.calls.map((call) => call.op)).toEqual(["assert"])
  })

  test("tee enable --vault-key names the destination through the key and never substitutes the passphrase", async () => {
    const v = await vaultWithKeyAndTee()
    // A cold vault key to pin as the sweep destination, created through the key factor.
    const key = await teeHarness(v.dir, { secrets: [PIN] })
    expect(
      await run(
        [
          "vault",
          "new-key",
          "--chain",
          "solana",
          "--label",
          "cold",
          "--json",
          "--factor",
          v.keyId,
          "--no-verify-account",
          "--keystore",
          v.vaultPath,
        ],
        key.deps,
      ),
    ).toBe(0)
    const cold = (JSON.parse(key.stdout.text) as { address: string }).address

    const ENCRYPTION_PUBLIC_KEY = await (async () => {
      const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
      return Buffer.from(await crypto.subtle.exportKey("raw", receiver.publicKey)).toString("base64")
    })()
    const submits: Record<string, unknown>[] = []
    const routes = createRoutedFetch({
      "/api/v1/agent/wallets/import/init": () =>
        jsonResponse(200, { success: true, encryptionPublicKey: ENCRYPTION_PUBLIC_KEY }),
      "/api/v1/agent/wallets/import/submit": (req) => {
        const body = JSON.parse(String(req.init.body)) as Record<string, unknown>
        submits.push(body)
        return jsonResponse(200, {
          success: true,
          id: "lw_tee2",
          address: body.address,
          chain: "solana",
          privyWalletId: "pw_tee2",
          profile: "ember-tee",
          vaultDestination: body.vaultDestination,
          boundKeyPrefix: "ck_live_x",
          remoteAuthority: "verified-active",
          evidenceObservedAt: 1_726_000_000_000,
          state: "enabled",
        })
      },
    })
    // A fresh legacy TEE entry, seeded AFTER the migration so the vault does not own it (the
    // migrated address would be refused a legacy write, correctly). Same passphrase, new store.
    await seedTeeStore(v.dir, [enabledTee(), teeEntry(freshKey, FRESH, { index: 1, label: "tee-1" })])
    // No --keystore on `tee enable`: there that flag names the Phase 1 TEE store, and the vault is
    // at its default path under CANDLE_CONFIG_DIR.
    // Prompts, in order: the key's PIN for the destination lookup, the key's PIN again for the
    // vault-ownership check of the TEE address, the legacy TEE store passphrase, the typed
    // confirmation of the destination's last six characters. No vault passphrase anywhere.
    const enable = await teeHarness(v.dir, { secrets: [PIN, PIN, TEE_PASS, cold.slice(-6)], fetch: routes.fetch })
    const code = await run(
      ["tee", "enable", FRESH, "--vault-key", "cold", "--factor", v.keyId, "--no-verify-account"],
      enable.deps,
    )
    expect(enable.stderr.text).not.toContain("Error")
    expect(code).toBe(0)
    expect(submits).toHaveLength(1)
    expect(submits[0]).toMatchObject({ address: FRESH, vaultDestination: cold })
    expect(enable.asked.filter((line) => line.includes("Vault passphrase"))).toEqual([])
    expect(enable.calls.map((call) => call.op)).toEqual(["assert", "assert"])
    expect(enable.calls.every((call) => call.pin === PIN && call.path === "/dev/hidraw3")).toBe(true)
    // The legacy store, not the vault, was written for the fresh address; the migrated entry is untouched.
    const store = await readKeystore(await readFile(v.teePath, "utf8"), TEE_PASS, {
      expectPurpose: TEE_KEYSTORE_PURPOSE,
    })
    expect(store.entries.find((entry) => entry.address === FRESH)).toMatchObject({
      imported: true,
      linkedWalletId: "lw_tee2",
      tee: { vaultDestination: cold },
    })
  })

  test("tee enable --vault-key with a key that cannot open the vault is the typed refusal before any import call", async () => {
    const v = await vaultWithKeyAndTee()
    const routes = createRoutedFetch({})
    const enable = await teeHarness(v.dir, {
      secrets: [PIN],
      fetch: routes.fetch,
      script: { ...goodScript(), assert: { error: { code: "NO_CREDENTIAL", message: "FIDO_ERR_NO_CREDENTIALS" } } },
    })
    const code = await run(
      ["tee", "enable", FRESH, "--vault-key", "cold", "--json", "--factor", v.keyId, "--no-verify-account"],
      enable.deps,
    )
    expect(code).toBe(1)
    expect(JSON.parse(enable.stdout.text)).toMatchObject({ code: "VAULT_CREDENTIAL_NOT_PRESENT" })
    expect(enable.asked).toEqual([expect.stringContaining("PIN for YubiKey 5 NFC")])
    expect(routes.calls).toHaveLength(0)
  })
})
