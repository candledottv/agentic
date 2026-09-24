/**
 * BE-337 / BE-342 (spec `2026-09-24-cli-security-key-authorizes-factor-add-design.md`, §7): a
 * security key authorises `vault factor add`, end to end through `run()` with the scripted
 * authenticator and a real vault file.
 *
 * What is pinned, by the spec's test numbers: the restricted menu (T1); open with key A and enroll
 * key B, both attached or named (T2, T3); the deferred insert (T4); the three refusals that keep a
 * key from being enrolled twice, by locator, by the probe and by the authenticator (T5, T6, T7,
 * T10); PIN separation between the two keys (T8); the passphrase opener's unchanged order (T9); the
 * opening-device ambiguity (T11); an opener failure that leaves the second key untouched (T12); a
 * helper that predates the exclude list (T13); a device too small for the list (T14); `--factor`
 * (T15); row F3 (T16); and what does not change (T18). The helper's own unit rows (T19) are in
 * `fido2-helper/`, Touch ID and passkey enrollment opened by a key (T17) in `vault-passkey.test.ts`,
 * and the docs rows (T20) in `scripts/cli-docs.test.ts`.
 *
 * The "request log" the spec's matrix reads is recorded at the spawn seam: every helper request's
 * `op`, `deviceId`, whether it carried a `pin` and which, and its exclude list. The backend log
 * (what reached the scripted authenticator) is recorded too. Two same-model keys throughout, told
 * apart only by locator, exactly the hardware Group E runs on.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sha256 } from "@noble/hashes/sha256"
import { base64 } from "@scure/base"
import type { Deps } from "../deps"
import {
  AUTHDATA_FLAG_UP,
  AUTHDATA_FLAG_UV,
  deviceIdFor,
  type HelperResponse,
  handleLine,
  RP_ID,
} from "../fido2-helper/protocol"
import { type BackendLogEntry, type HelperScript, scriptedBackend } from "../fido2-helper/test-backend"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"
import { HELPER_ENV } from "../vault/fido2"
import type { Envelope } from "../vault/format"
import { closeVault, sealIndex, serializeVault, unlockWithPassphrase } from "../vault/store"
import { generatedPassphraseFrom, useCheapKdf } from "../vault/test-vault"
import { PASSPHRASE_ONLY_PREFIX } from "./vault-support"

setDefaultTimeout(90_000)
useCheapKdf()

const unreachableFetch = (async () => {
  throw new Error("no test in this file should make a network call")
}) as unknown as typeof fetch

const PIN_A = "482913"
const PIN_B = "770011"
const HMAC_SECRET = base64.encode(new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff))
/** K1's credential, on key A; K2's, on key B. */
const CRED_A = base64.encode(new Uint8Array(48).map((_, i) => (i * 7 + 3) & 0xff))
const CRED_B = base64.encode(new Uint8Array(48).fill(5))
const AAGUID = "2fc0579f811347eab116bb5a8db9202a"
const A = "/dev/hidraw3"
const B = "/dev/hidraw4"
const C = "/dev/hidraw5"
const idOf = (path: string) => deviceIdFor({ path, aaguid: AAGUID })

function authDataFor(rpId: string, flags: number): string {
  const out = new Uint8Array(37)
  out.set(sha256(new TextEncoder().encode(rpId)), 0)
  out[32] = flags
  return base64.encode(out)
}
const UV = authDataFor(RP_ID, AUTHDATA_FLAG_UP | AUTHDATA_FLAG_UV)

type Device = HelperScript["devices"][number]
/** Two YubiKey 5 Nanos: one model, one AAGUID, told apart by path only. */
const nano = (path: string, extra: Partial<Device> = {}): Device => ({
  path,
  product: "YubiKey 5 Nano",
  manufacturer: "Yubico",
  aaguid: AAGUID,
  extensions: ["hmac-secret", "credProtect"],
  options: { rk: true, clientPin: true, uv: false },
  maxCredentialCountInList: 8,
  ...extra,
})

/** A script whose register answers with `credentialId` and whose asserts succeed. */
function script(devices: Device[], credentialId = CRED_B, probe?: HelperScript["probe"]): HelperScript {
  return {
    devices,
    register: { credentialId, aaguid: AAGUID, authData: UV },
    assert: { hmacSecret: HMAC_SECRET, authData: UV },
    ...(probe !== undefined ? { probe } : {}),
  }
}

/** The spec's "request log" entry: one helper request as the CLI sent it. */
interface RequestEntry {
  op: string
  deviceId?: string
  pin?: string
  excludeCredentialIds?: string[]
}

interface Harness {
  deps: Deps
  stdout: ReturnType<typeof createCapture>
  stderr: ReturnType<typeof createCapture>
  asked: string[]
  /** One ordered log of stderr writes, prompts and helper requests, so "before" is a real assertion. */
  events: string[]
  requests: RequestEntry[]
  calls: BackendLogEntry[]
  dir: string
  vaultPath: string
  script: HelperScript
}

interface HarnessOptions {
  secrets?: string[]
  lines?: string[]
  env?: Record<string, string>
  script?: HelperScript
  /** Replaces a helper response before the CLI reads it (a helper from another release). */
  tamper?: (request: RequestEntry, response: HelperResponse) => HelperResponse
  /** Runs when a visible prompt is shown, before it is answered (the operator swapping keys). */
  onLine?: (text: string, script: HelperScript) => void
}

async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = opts.env?.CANDLE_CONFIG_DIR ?? (await mkdtemp(join(tmpdir(), "candle-vault-opener-")))
  const stdout = createCapture()
  const stderr = createCapture()
  const asked: string[] = []
  const events: string[] = []
  const requests: RequestEntry[] = []
  const calls: BackendLogEntry[] = []
  const secrets = [...(opts.secrets ?? [])]
  const lines = [...(opts.lines ?? [])]
  const scripted = opts.script ?? script([nano(A)])
  const env: Record<string, string> = { CANDLE_CONFIG_DIR: dir, HOME: dir, ...(opts.env ?? {}) }
  const helper = join(dir, "candle-fido2")
  await writeFile(helper, "#!/bin/sh\nexit 1\n")
  await chmod(helper, 0o755)
  env[HELPER_ENV] = helper
  const loggedStderr: Deps["stderr"] = {
    write(chunk: string) {
      events.push(`stderr: ${chunk}`)
      stderr.write(chunk)
    },
  }
  const deps = createTestDeps({
    fetch: unreachableFetch,
    stdout,
    stderr: loggedStderr,
    env,
    platform: "linux",
    arch: "x64",
    isTTY: { stdin: true, stdout: true, stderr: true },
    // The real protocol code over the scripted backend, in process; the request is logged as the
    // CLI sent it, the response as the compiled helper would print it.
    spawnHelper: async (_path, line) => {
      const request = JSON.parse(line) as RequestEntry & Record<string, unknown>
      const entry: RequestEntry = {
        op: request.op,
        ...(request.deviceId !== undefined ? { deviceId: request.deviceId } : {}),
        ...(request.pin !== undefined ? { pin: request.pin } : {}),
        ...(request.excludeCredentialIds !== undefined ? { excludeCredentialIds: request.excludeCredentialIds } : {}),
      }
      requests.push(entry)
      events.push(`request: ${entry.op}${entry.deviceId ? `@${entry.deviceId}` : ""}`)
      let response = handleLine(line, () => scriptedBackend(scripted, (call) => calls.push(call)))
      if (opts.tamper) response = opts.tamper(entry, response)
      return { stdout: `${JSON.stringify(response)}\n`, stderr: "", exitCode: response.ok ? 0 : 1, signal: null }
    },
    promptSecret: async (text: string) => {
      asked.push(`secret: ${text}`)
      events.push(`secret: ${text}`)
      const next = secrets.shift()
      if (next === undefined) throw new Error(`promptSecret asked for more than the test scripted: ${text}`)
      return next
    },
    promptLine: async (text: string) => {
      asked.push(`line: ${text}`)
      events.push(`line: ${text}`)
      opts.onLine?.(text, scripted)
      const next = lines.shift()
      if (next === undefined) throw new Error(`promptLine asked for more than the test scripted: ${text}`)
      return next
    },
  })
  return {
    deps,
    stdout,
    stderr,
    asked,
    events,
    requests,
    calls,
    dir,
    vaultPath: join(dir, "vault.enc"),
    script: scripted,
  }
}

interface VaultJson {
  vaultId: string
  generation: number
  envelopes: Array<Record<string, unknown> & { id: string; factor: string; transport?: string; label: string }>
}

async function readVault(path: string): Promise<VaultJson> {
  return JSON.parse(await readFile(path, "utf8")) as VaultJson
}

async function initVault(): Promise<Harness & { passphrase: string }> {
  const h = await harness({ lines: ["", "", "no"] })
  const code = await run(["vault", "init", "--keystore", h.vaultPath], h.deps)
  if (code !== 0) throw new Error(`init failed (${code}): ${h.stderr.text}${h.stdout.text}`)
  return { ...h, passphrase: generatedPassphraseFrom(h.stdout.text) }
}

/** A vault with the passphrase and K1 (credential A, enrolled with key A alone, under the passphrase). */
async function vaultWithK1() {
  const v = await initVault()
  const add = await harness({
    env: { CANDLE_CONFIG_DIR: v.dir },
    secrets: [PIN_A, v.passphrase],
    script: script([nano(A)], CRED_A),
  })
  const code = await run(
    ["vault", "factor", "add", "security-key", "--label", "nano1", "--keystore", v.vaultPath],
    add.deps,
  )
  if (code !== 0) throw new Error(`factor add security-key failed (${code}): ${add.stderr.text}${add.stdout.text}`)
  const file = await readVault(v.vaultPath)
  const k1 = (file.envelopes.find((envelope) => envelope.factor === "passkey-prf") as { id: string }).id
  const passphraseId = (file.envelopes.find((envelope) => envelope.factor === "passphrase") as { id: string }).id
  return { ...v, k1, passphraseId }
}

const HELPER = { teamId: "ABCDE12345", bundleId: "tv.candle.cli.enclave", minVersion: "0.13.0" }
const WRAP = {
  alg: "AES-256-GCM",
  iv: base64.encode(new Uint8Array(12)),
  ciphertext: base64.encode(new Uint8Array(48)),
}
const syncedPasskey = (id = "s1"): Envelope =>
  ({
    id,
    factor: "passkey-prf",
    transport: "platform-macos",
    domain: "apple-account",
    label: "synced passkey",
    createdAt: "2026-09-24T00:00:00.000Z",
    wrap: WRAP,
    rpId: "cli.candle.tv",
    credentialId: "AQID",
    prfSalt: base64.encode(new Uint8Array(32)),
    userVerification: "required",
    backupEligible: true,
    backupState: true,
    saltDerivation: "platform",
    helper: HELPER,
  }) as unknown as Envelope
const touchId = (id = "t1"): Envelope =>
  ({
    id,
    factor: "secure-enclave",
    domain: "this-device",
    label: "Touch ID",
    createdAt: "2026-09-24T00:00:00.000Z",
    wrap: WRAP,
    helper: HELPER,
    publicKey: "AQID",
    keyTag: "tag",
    accessControl: "biometryCurrentSet",
    kek: { alg: "ECIES-P256-SHA256-AESGCM", ciphertext: "AQID" },
  }) as unknown as Envelope

/** Re-seals the live vault's index under a header that also carries `extra` (ED-1). */
async function addFixtureEnvelopes(vaultPath: string, passphrase: string, extra: Envelope[]): Promise<void> {
  const raw = await readFile(vaultPath, "utf8")
  const vault = await unlockWithPassphrase(vaultPath, raw, passphrase)
  try {
    const { index: _index, ...header } = vault.file
    const sealed = await sealIndex(
      { ...header, envelopes: [...header.envelopes, ...extra] },
      vault.index,
      vault.payloadKey,
    )
    await writeFile(vaultPath, serializeVault(sealed), { mode: 0o600 })
  } finally {
    closeVault(vault)
  }
}

/** The probe answer for K1 on key A and nothing else. */
const k1OnA = (): HelperScript["probe"] => ({ [A]: { [CRED_A]: "present" } })

const ops = (h: Harness) =>
  h.requests.map(
    (r) => `${r.op}${r.deviceId ? `@${r.deviceId === idOf(A) ? "A" : r.deviceId === idOf(B) ? "B" : "?"}` : ""}`,
  )
const failure = (h: Harness) => {
  const lines = h.stdout.text.trim().split("\n")
  return JSON.parse(lines[lines.length - 1] as string) as {
    code: string
    message: string
    suggestion?: string
    details?: Record<string, string>
  }
}
/** The spec's "before any PIN": no hidden prompt of any kind was shown. */
const noPin = (h: Harness) => expect(h.asked.filter((a) => a.startsWith("secret:"))).toEqual([])

describe("T1: the restricted menu", () => {
  test("offers the vault's security keys and the passphrase, never Touch ID or a synced passkey, after one probe over every device", async () => {
    const v = await vaultWithK1()
    await addFixtureEnvelopes(v.vaultPath, v.passphrase, [touchId(), syncedPasskey()])
    const h = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      lines: ["nope"],
      script: script([nano(A), nano(B)], CRED_B, k1OnA()),
    })
    expect(await run(["vault", "factor", "add", "security-key", "--json", "--keystore", v.vaultPath], h.deps)).toBe(1)
    expect(h.asked).toEqual([
      `line: Unlock with:\n  1  nano1  (security key, attached)  id ${v.k1}\n  2  Passphrase\n> `,
    ])
    // No Touch ID row, no synced passkey row, and neither is named as unusable: they are not offered.
    expect(h.asked[0]).not.toContain("Touch ID")
    expect(h.asked[0]).not.toContain("passkey")
    expect(h.asked[0]).not.toContain("Not usable")
    // One info, one probe, over every attached device (no deviceId on the probe), and nothing else.
    expect(ops(h)).toEqual(["info", "probe"])
    expect(h.requests[1]).not.toHaveProperty("deviceId")
    expect(
      h.calls
        .filter((call) => call.op === "probe")
        .map((call) => call.path)
        .sort(),
    ).toEqual([A, B])
    expect(failure(h).code).toBe("VAULT_FACTOR_UNAVAILABLE")
    noPin(h)
  })
})

describe("T2, T3: open with A, enroll B", () => {
  /** The spec's D4 order, as the request log records it. */
  const D4_ORDER = ["info", "probe", "info", "assert@A", "info", "register@B", "assert@B", "assert@B"]

  test("T2: both attached, no --device: the menu picks K1, A opens, B is added, no passphrase", async () => {
    const v = await vaultWithK1()
    const before = await readVault(v.vaultPath)
    const h = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      lines: ["1"],
      secrets: [PIN_A, PIN_B],
      script: script([nano(A), nano(B)], CRED_B, k1OnA()),
    })
    expect(
      await run(
        ["vault", "factor", "add", "security-key", "--label", "nano2", "--json", "--keystore", v.vaultPath],
        h.deps,
      ),
    ).toBe(0)
    expect(ops(h)).toEqual(D4_ORDER)
    // PIN A went to A's assertion only; PIN B to B's requests only; the exclude list is K1's credential.
    const assertA = h.requests.find((r) => r.op === "assert" && r.deviceId === idOf(A))
    expect(assertA?.pin).toBe(PIN_A)
    const registerB = h.requests.find((r) => r.op === "register")
    expect(registerB).toMatchObject({ deviceId: idOf(B), pin: PIN_B, excludeCredentialIds: [CRED_A] })
    expect(h.requests.filter((r) => r.deviceId === idOf(B)).every((r) => r.pin === PIN_B)).toBe(true)
    expect(h.asked.some((a) => a.includes("passphrase"))).toBe(false)
    // The two prompts, worded apart (D4), in order: the opener's, then the key being added.
    expect(h.asked.filter((a) => a.startsWith("secret:"))).toEqual([
      "secret: PIN for YubiKey 5 Nano (input hidden): ",
      "secret: PIN for the key being added, YubiKey 5 Nano (input hidden): ",
    ])
    // The `Using` line for the opener, then the `Adding:` line for the key being added, before any PIN.
    const using = h.events.findIndex((e) =>
      e.includes(`Using the attached security key: YubiKey 5 Nano (--device ${idOf(A)})`),
    )
    const adding = h.events.findIndex((e) =>
      e.includes(`Adding: YubiKey 5 Nano (--device ${idOf(B)}), a different key from the one that opened the vault.`),
    )
    const firstPin = h.events.findIndex((e) => e.startsWith("secret:"))
    expect(adding).toBeGreaterThan(-1)
    expect(adding).toBeLessThan(firstPin)
    expect(using).toBeGreaterThan(-1)
    expect(using).toBeLessThan(firstPin)
    // D6: `openedWith` is the one additive key; every existing key is kept.
    const payload = JSON.parse(h.stdout.text) as Record<string, unknown>
    expect(payload.openedWith).toEqual({ factor: "security-key", envelopeId: v.k1 })
    expect(Object.keys(payload).sort()).toEqual(
      [
        "ok",
        "envelopeId",
        "factor",
        "transport",
        "domain",
        "label",
        "product",
        "aaguid",
        "backupEligible",
        "backupState",
        "userVerification",
        "recoverableFactors",
        "verified",
        "openedWith",
      ].sort(),
    )
    expect(payload.recoverableFactors).toBe(2)
    // The vault has K2, on a different credential from K1.
    const after = await readVault(v.vaultPath)
    expect(after.generation).toBe(before.generation + 1)
    const keys = after.envelopes.filter((e) => e.factor === "passkey-prf")
    expect(keys.map((e) => e.label)).toEqual(["nano1", "nano2"])
    expect(keys[0]?.credentialId).not.toBe(keys[1]?.credentialId)
    // No secret anywhere.
    const everything = h.stdout.text + h.stderr.text + (await readFile(v.vaultPath, "utf8"))
    for (const secret of [PIN_A, PIN_B, HMAC_SECRET, v.passphrase]) expect(everything).not.toContain(secret)
  })

  test("T3: --device B names the key to add; the log and the result are the same", async () => {
    const v = await vaultWithK1()
    const h = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      lines: ["1"],
      secrets: [PIN_A, PIN_B],
      script: script([nano(A), nano(B)], CRED_B, k1OnA()),
    })
    expect(
      await run(
        ["vault", "factor", "add", "security-key", "--device", idOf(B), "--label", "nano2", "--keystore", v.vaultPath],
        h.deps,
      ),
    ).toBe(0)
    expect(ops(h)).toEqual(D4_ORDER)
    expect(h.requests.find((r) => r.op === "register")).toMatchObject({
      deviceId: idOf(B),
      excludeCredentialIds: [CRED_A],
    })
    expect((await readVault(v.vaultPath)).envelopes.filter((e) => e.factor === "passkey-prf")).toHaveLength(2)
    expect(h.stdout.text).toContain("2 recoverable factor(s)")
  })

  test("T2 with the probe unable to place K1 (unknown) and a step-2 guess: two keys attached needs --device", async () => {
    const v = await vaultWithK1()
    // The probe answers unknown everywhere: step 1 cannot place K1; with two keys and no --device,
    // step 2 has two candidates, so the command refuses before any PIN rather than guess.
    const h = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      lines: ["1"],
      script: script([nano(A), nano(B)], CRED_B, { [A]: { [CRED_A]: "unknown" }, [B]: { [CRED_A]: "unknown" } }),
    })
    expect(await run(["vault", "factor", "add", "security-key", "--json", "--keystore", v.vaultPath], h.deps)).toBe(1)
    expect(failure(h).code).toBe("VAULT_AUTHENTICATOR_AMBIGUOUS")
    noPin(h)
    expect(ops(h)).toEqual(["info", "probe"])
  })
})

describe("T4: the deferred insert", () => {
  test("only A attached: the vault opens, Enter is asked after A's assertion, and B is asked nothing until then", async () => {
    const v = await vaultWithK1()
    const h = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      lines: ["1", ""],
      secrets: [PIN_A, PIN_B],
      script: script([nano(A)], CRED_B, k1OnA()),
      // The operator unplugs A and plugs B at the Enter prompt.
      onLine: (text, s) => {
        if (text.startsWith("The vault is open.")) s.devices = [nano(B)]
      },
    })
    expect(
      await run(["vault", "factor", "add", "security-key", "--label", "nano2", "--keystore", v.vaultPath], h.deps),
    ).toBe(0)
    const enter = h.events.findIndex((e) =>
      e.startsWith("line: The vault is open. Unplug YubiKey 5 Nano, insert the security key to add, then press Enter."),
    )
    const assertA = h.events.indexOf(`request: assert@${idOf(A)}`)
    const firstToB = h.events.findIndex((e) => e.endsWith(`@${idOf(B)}`))
    expect(enter).toBeGreaterThan(assertA)
    expect(firstToB).toBeGreaterThan(enter)
    // After Enter: one enumeration, one probe, then B's own session (info), register, two asserts.
    expect(ops(h)).toEqual([
      "info",
      "probe",
      "info",
      "assert@A",
      "info",
      "probe",
      "info",
      "register@B",
      "assert@B",
      "assert@B",
    ])
    // The `Adding:` line follows the Enter, and the second PIN prompt is the key being added.
    const adding = h.events.findIndex((e) => e.includes(`Adding: YubiKey 5 Nano (--device ${idOf(B)})`))
    expect(adding).toBeGreaterThan(enter)
    expect(h.asked.filter((a) => a.startsWith("secret:"))[1]).toBe(
      "secret: PIN for the key being added, YubiKey 5 Nano (input hidden): ",
    )
    expect((await readVault(v.vaultPath)).envelopes.filter((e) => e.factor === "passkey-prf")).toHaveLength(2)
  })

  test("nothing attached after Enter is VAULT_FACTOR_UNAVAILABLE, once, with nothing written", async () => {
    const v = await vaultWithK1()
    const before = await readFile(v.vaultPath, "utf8")
    const h = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      lines: ["1", ""],
      secrets: [PIN_A],
      script: script([nano(A)], CRED_B, k1OnA()),
      onLine: (text, s) => {
        if (text.startsWith("The vault is open.")) s.devices = []
      },
    })
    expect(await run(["vault", "factor", "add", "security-key", "--json", "--keystore", v.vaultPath], h.deps)).toBe(1)
    const body = failure(h)
    expect(body.code).toBe("VAULT_FACTOR_UNAVAILABLE")
    expect(body.message).toBe(
      "No security key other than the one that opened the vault is attached. Nothing was written.",
    )
    // One Enter prompt, no second chance, no PIN for a second key.
    expect(h.asked.filter((a) => a.startsWith("line: The vault is open"))).toHaveLength(1)
    expect(h.asked.filter((a) => a.startsWith("secret:"))).toHaveLength(1)
    expect(await readFile(v.vaultPath, "utf8")).toBe(before)
  })
})

describe("T5, T6, T7, T10: a key that already holds this vault's credential is not enrolled twice", () => {
  test("T5, refusal 1 by locator: --device names the key that opens the vault, before any PIN", async () => {
    const v = await vaultWithK1()
    const before = await readFile(v.vaultPath, "utf8")
    const h = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      lines: ["1"],
      script: script([nano(A), nano(B)], CRED_B, k1OnA()),
    })
    expect(
      await run(
        ["vault", "factor", "add", "security-key", "--device", idOf(A), "--json", "--keystore", v.vaultPath],
        h.deps,
      ),
    ).toBe(1)
    const body = failure(h)
    expect(body.code).toBe("VAULT_KEY_ALREADY_ENROLLED")
    expect(body.message).toBe(
      `YubiKey 5 Nano (--device ${idOf(A)}) already holds this vault's security key credential for envelope ${v.k1}, so enrolling it again would not add a second key. Nothing was written.`,
    )
    expect(body.suggestion).toBe("Insert a different security key, or name one with --device.")
    expect(body.details).toEqual({ envelopeId: v.k1 })
    noPin(h)
    expect(ops(h)).toEqual(["info", "probe"])
    expect(await readFile(v.vaultPath, "utf8")).toBe(before)
  })

  test("T6, refusal 2 by credential: A re-inserted at the Enter prompt, after Enter and before PIN B, no register", async () => {
    const v = await vaultWithK1()
    const before = await readFile(v.vaultPath, "utf8")
    const h = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      lines: ["1", ""],
      secrets: [PIN_A],
      // The operator swaps back to A (or never unplugged it): the fresh probe finds K1 on it.
      script: script([nano(A)], CRED_B, k1OnA()),
    })
    expect(await run(["vault", "factor", "add", "security-key", "--json", "--keystore", v.vaultPath], h.deps)).toBe(1)
    const body = failure(h)
    expect(body.code).toBe("VAULT_KEY_ALREADY_ENROLLED")
    expect(body.details).toEqual({ envelopeId: v.k1 })
    expect(body.message).toContain(`for envelope ${v.k1}`)
    expect(ops(h)).toEqual(["info", "probe", "info", "assert@A", "info", "probe"])
    expect(h.asked.filter((a) => a.startsWith("secret:"))).toHaveLength(1)
    expect(await readFile(v.vaultPath, "utf8")).toBe(before)
  })

  test("T7, refusal 3 by the authenticator: B's probe answers unknown, register answers CREDENTIAL_EXCLUDED, nothing committed", async () => {
    const v = await vaultWithK1()
    const before = await readFile(v.vaultPath, "utf8")
    const h = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      lines: ["1"],
      secrets: [PIN_A, PIN_B],
      // B enforces alwaysUv: the silent probe cannot see its credentials, but B holds K1's.
      script: script([nano(A), nano(B, { holds: [CRED_A] })], CRED_B, {
        [A]: { [CRED_A]: "present" },
        [B]: { [CRED_A]: "unknown" },
      }),
    })
    expect(await run(["vault", "factor", "add", "security-key", "--json", "--keystore", v.vaultPath], h.deps)).toBe(1)
    const body = failure(h)
    expect(body.code).toBe("VAULT_KEY_ALREADY_ENROLLED")
    expect(body.message).toBe(
      `YubiKey 5 Nano (--device ${idOf(B)}) already holds this vault's security key credential, so enrolling it again would not add a second key. Nothing was written.`,
    )
    expect(body.details).toBeUndefined()
    expect(ops(h)).toEqual(["info", "probe", "info", "assert@A", "info", "register@B"])
    expect(h.requests.find((r) => r.op === "register")?.excludeCredentialIds).toEqual([CRED_A])
    expect(await readFile(v.vaultPath, "utf8")).toBe(before)
  })

  test("T10, the passphrase opener re-enrolling K1's key: refusal 2 before any PIN; refusal 3 when the probe answers unknown", async () => {
    const v = await vaultWithK1()
    const before = await readFile(v.vaultPath, "utf8")
    const seen = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      script: script([nano(A)], CRED_B, k1OnA()),
    })
    expect(
      await run(
        ["vault", "factor", "add", "security-key", "--factor", "passphrase", "--json", "--keystore", v.vaultPath],
        seen.deps,
      ),
    ).toBe(1)
    expect(failure(seen)).toMatchObject({ code: "VAULT_KEY_ALREADY_ENROLLED", details: { envelopeId: v.k1 } })
    // Before the PIN and before the passphrase: nothing hidden was asked at all.
    expect(seen.asked).toEqual([])
    expect(ops(seen)).toEqual(["info", "probe", "info"])

    const hidden = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [PIN_A, v.passphrase],
      script: script([nano(A, { holds: [CRED_A] })], CRED_B, { [A]: { [CRED_A]: "unknown" } }),
    })
    expect(
      await run(
        ["vault", "factor", "add", "security-key", "--factor", "passphrase", "--json", "--keystore", v.vaultPath],
        hidden.deps,
      ),
    ).toBe(1)
    expect(failure(hidden).code).toBe("VAULT_KEY_ALREADY_ENROLLED")
    expect(ops(hidden)).toEqual(["info", "probe", "info", "register@A"])
    expect(await readFile(v.vaultPath, "utf8")).toBe(before)
  })

  test("a probe that fails degrades: no refusal 2, D2 falls to step 2, and refusal 3 still holds", async () => {
    // The PASS's note 2: `probeAttachedKeys` is `undefined` on any failure, and the spec's D2
    // degrades naturally. Pinned here rather than left implicit.
    const v = await vaultWithK1()
    const before = await readFile(v.vaultPath, "utf8")
    const h = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      lines: ["1"],
      secrets: [PIN_A, PIN_B],
      script: script([nano(A), nano(B, { holds: [CRED_A] })], CRED_B, k1OnA()),
      tamper: (request, response) =>
        request.op === "probe"
          ? { ok: false, protocol: 1, code: "DEVICE_IO", message: "scripted probe failure" }
          : response,
    })
    // --device B: step 1 cannot place K1 (no probe), step 2 leaves A as the one device not named.
    expect(
      await run(
        ["vault", "factor", "add", "security-key", "--device", idOf(B), "--json", "--keystore", v.vaultPath],
        h.deps,
      ),
    ).toBe(1)
    // The menu drew without markers, A opened the vault, and B's own exclude-list answer refused.
    expect(h.asked[0]).toBe(`line: Unlock with:\n  1  nano1  (security key)  id ${v.k1}\n  2  Passphrase\n> `)
    expect(failure(h).code).toBe("VAULT_KEY_ALREADY_ENROLLED")
    expect(ops(h)).toEqual(["info", "probe", "info", "assert@A", "info", "register@B"])
    expect(await readFile(v.vaultPath, "utf8")).toBe(before)
  })
})

describe("T8: PIN separation between two same-model keys", () => {
  test("PIN A only in A's assertion, PIN B only in B's requests; a wrong PIN B is VAULT_PIN_INVALID with A untouched afterwards", async () => {
    const v = await vaultWithK1()
    const good = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      lines: ["1"],
      secrets: [PIN_A, PIN_B],
      script: script([nano(A), nano(B)], CRED_B, k1OnA()),
    })
    expect(await run(["vault", "factor", "add", "security-key", "--keystore", v.vaultPath], good.deps)).toBe(0)
    for (const request of good.requests) {
      if (request.pin === undefined) continue
      if (request.deviceId === idOf(A)) {
        expect(request.op).toBe("assert")
        expect(request.pin).toBe(PIN_A)
      } else {
        expect(request.deviceId).toBe(idOf(B))
        expect(request.pin).toBe(PIN_B)
      }
    }
    expect(good.requests.filter((r) => r.pin === PIN_A)).toHaveLength(1)
    expect(good.requests.filter((r) => r.pin === PIN_B)).toHaveLength(3)
    expect(good.calls.filter((call) => call.path === A).map((call) => call.pin)).toEqual([null, PIN_A])
    expect(good.calls.filter((call) => call.path === B).every((call) => call.pin === PIN_B || call.pin === null)).toBe(
      true,
    )

    const wrong = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      lines: ["1"],
      secrets: [PIN_A, "000000"],
      script: {
        ...script([nano(A), nano(B)], CRED_B, k1OnA()),
        register: { error: { code: "PIN_INVALID", message: "FIDO_ERR_PIN_INVALID" } },
      },
    })
    const beforeWrong = await readFile(v.vaultPath, "utf8")
    expect(await run(["vault", "factor", "add", "security-key", "--json", "--keystore", v.vaultPath], wrong.deps)).toBe(
      1,
    )
    expect(failure(wrong).code).toBe("VAULT_PIN_INVALID")
    const lastToA = wrong.events.lastIndexOf(`request: assert@${idOf(A)}`)
    const registerB = wrong.events.indexOf(`request: register@${idOf(B)}`)
    expect(registerB).toBeGreaterThan(lastToA)
    expect(wrong.events.slice(registerB).some((e) => e.endsWith(`@${idOf(A)}`))).toBe(false)
    expect(await readFile(v.vaultPath, "utf8")).toBe(beforeWrong)
  })
})

describe("T9: the passphrase as the opener", () => {
  test("menu answer Passphrase: today's order (B's info and PIN, then the passphrase), the exclude list, no Passphrase only line", async () => {
    const v = await vaultWithK1()
    const h = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      lines: ["2"],
      secrets: [PIN_B, v.passphrase],
      // Only B attached: the passphrase path selects the one attached key, as it always has.
      script: script([nano(B)], CRED_B, { [B]: { [CRED_A]: "absent" } }),
    })
    expect(
      await run(["vault", "factor", "add", "security-key", "--label", "nano2", "--keystore", v.vaultPath], h.deps),
    ).toBe(0)
    expect(ops(h)).toEqual(["info", "probe", "info", "register@B", "assert@B", "assert@B"])
    expect(h.asked).toEqual([
      `line: Unlock with:\n  1  nano1  (security key, not attached)  id ${v.k1}\n  2  Passphrase\n> `,
      "secret: PIN for YubiKey 5 Nano (input hidden): ",
      "secret: Current vault passphrase, to unlock (input hidden): ",
    ])
    expect(h.requests.find((r) => r.op === "register")).toMatchObject({ pin: PIN_B, excludeCredentialIds: [CRED_A] })
    expect(h.stderr.text).not.toContain(PASSPHRASE_ONLY_PREFIX)
    const payload = await readVault(v.vaultPath)
    expect(payload.envelopes.filter((e) => e.factor === "passkey-prf")).toHaveLength(2)
  })
})

describe("T11: which device opens the vault", () => {
  test("three devices, K1 placed nowhere, no --device: the D2 refusal before any PIN", async () => {
    const v = await vaultWithK1()
    const h = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      lines: ["1"],
      script: script([nano(A), nano(B), nano(C)], CRED_B, {}),
    })
    expect(await run(["vault", "factor", "add", "security-key", "--json", "--keystore", v.vaultPath], h.deps)).toBe(1)
    const body = failure(h)
    expect(body.code).toBe("VAULT_AUTHENTICATOR_AMBIGUOUS")
    expect(body.message).toBe(
      "3 security keys are attached and the one that opens the vault could not be told apart. Leave only the key that opens the vault attached; this command asks for the key to add after the vault is open.",
    )
    noPin(h)
    expect(ops(h)).toEqual(["info", "probe"])
  })

  test("three devices, K1 on A, no --device: the ambiguity names only the two others", async () => {
    const v = await vaultWithK1()
    const h = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      lines: ["1"],
      script: script([nano(A), nano(B), nano(C)], CRED_B, k1OnA()),
    })
    expect(await run(["vault", "factor", "add", "security-key", "--json", "--keystore", v.vaultPath], h.deps)).toBe(1)
    const body = failure(h)
    expect(body.code).toBe("VAULT_AUTHENTICATOR_AMBIGUOUS")
    expect(body.message).toContain("2 security keys are attached besides the one that opens the vault")
    expect(body.message.match(/--device \S+/g)).toEqual([`--device ${idOf(B)}`, `--device ${idOf(C)}`])
    expect(body.message).not.toContain(idOf(A))
    expect(body.suggestion).toBe("Run again with --device <id> naming the key to add.")
    noPin(h)
  })
})

describe("T12: the opener fails", () => {
  test("a wrong PIN A stops at step 4: B saw only info and probe, nothing was written", async () => {
    const v = await vaultWithK1()
    const before = await readFile(v.vaultPath, "utf8")
    const h = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      lines: ["1"],
      secrets: ["000000"],
      script: {
        ...script([nano(A), nano(B)], CRED_B, k1OnA()),
        assert: { error: { code: "PIN_INVALID", message: "FIDO_ERR_PIN_INVALID" } },
      },
    })
    expect(await run(["vault", "factor", "add", "security-key", "--json", "--keystore", v.vaultPath], h.deps)).toBe(1)
    expect(failure(h).code).toBe("VAULT_PIN_INVALID")
    expect(ops(h)).toEqual(["info", "probe", "info", "assert@A"])
    expect(h.calls.filter((call) => call.path === B).map((call) => call.op)).toEqual(["probe"])
    expect(h.asked.filter((a) => a.startsWith("secret:"))).toHaveLength(1)
    expect(await readFile(v.vaultPath, "utf8")).toBe(before)
  })

  test("a step-2 guess that does not hold K1 is VAULT_CREDENTIAL_NOT_PRESENT, with nothing written and no second attempt", async () => {
    const v = await vaultWithK1()
    const before = await readFile(v.vaultPath, "utf8")
    const h = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      lines: ["1"],
      secrets: [PIN_A],
      // No probe answer places K1; --device B makes A the guess; A does not hold K1 (the keys were swapped).
      script: {
        ...script([nano(A), nano(B)], CRED_B, { [A]: { [CRED_A]: "unknown" }, [B]: { [CRED_A]: "unknown" } }),
        assert: { error: { code: "NO_CREDENTIAL", message: "FIDO_ERR_NO_CREDENTIALS" } },
      },
    })
    expect(
      await run(
        ["vault", "factor", "add", "security-key", "--device", idOf(B), "--json", "--keystore", v.vaultPath],
        h.deps,
      ),
    ).toBe(1)
    expect(failure(h).code).toBe("VAULT_CREDENTIAL_NOT_PRESENT")
    expect(ops(h)).toEqual(["info", "probe", "info", "assert@A"])
    expect(await readFile(v.vaultPath, "utf8")).toBe(before)
  })
})

describe("T13: a helper from another release", () => {
  test("info without features and a non-empty exclude list is VAULT_HELPER_MISSING before any PIN", async () => {
    const v = await vaultWithK1()
    const h = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      lines: ["1"],
      script: script([nano(A), nano(B)], CRED_B, k1OnA()),
      tamper: (request, response) => {
        if (request.op === "info" && response.ok && response.op === "info") {
          const { features: _features, ...older } = response
          return older as unknown as HelperResponse
        }
        return response
      },
    })
    expect(await run(["vault", "factor", "add", "security-key", "--json", "--keystore", v.vaultPath], h.deps)).toBe(1)
    const body = failure(h)
    expect(body.code).toBe("VAULT_HELPER_MISSING")
    expect(body.message).toContain("predates the exclude list this command needs")
    expect(body.message).toContain("reinstall the CLI so candle and candle-fido2 come from the same release")
    expect(h.asked).toEqual([])
    expect(ops(h)).toEqual(["info"])
  })

  test("a register answer without excluded is VAULT_HELPER_MISSING after register, names the leftover credential, and commits nothing", async () => {
    const v = await vaultWithK1()
    const before = await readFile(v.vaultPath, "utf8")
    const h = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      lines: ["1"],
      secrets: [PIN_A, PIN_B],
      script: script([nano(A), nano(B)], CRED_B, k1OnA()),
      tamper: (request, response) => {
        if (request.op === "register" && response.ok && response.op === "register") {
          const { excluded: _excluded, ...older } = response
          return older as unknown as HelperResponse
        }
        return response
      },
    })
    expect(await run(["vault", "factor", "add", "security-key", "--json", "--keystore", v.vaultPath], h.deps)).toBe(1)
    const body = failure(h)
    expect(body.code).toBe("VAULT_HELPER_MISSING")
    expect(body.message).toContain("predates the exclude list this command needs")
    expect(body.suggestion).toContain("The credential now on the authenticator can be removed with its vendor's tool")
    expect(ops(h)).toEqual(["info", "probe", "info", "assert@A", "info", "register@B"])
    expect(await readFile(v.vaultPath, "utf8")).toBe(before)
  })

  test("with an empty exclude list, a helper without features enrolls as today", async () => {
    const v = await initVault()
    const h = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [PIN_A, v.passphrase],
      script: script([nano(A)], CRED_A),
      tamper: (request, response) => {
        if (request.op === "info" && response.ok && response.op === "info") {
          const { features: _features, ...older } = response
          return older as unknown as HelperResponse
        }
        if (request.op === "register" && response.ok && response.op === "register") {
          const { excluded: _excluded, ...older } = response
          return older as unknown as HelperResponse
        }
        return response
      },
    })
    expect(await run(["vault", "factor", "add", "security-key", "--keystore", v.vaultPath], h.deps)).toBe(0)
    expect(h.requests.find((r) => r.op === "register")).not.toHaveProperty("excludeCredentialIds")
    expect((await readVault(v.vaultPath)).envelopes.filter((e) => e.factor === "passkey-prf")).toHaveLength(1)
  })
})

describe("T14: a device too small for the exclude list", () => {
  /** A vault with K1 and K2, so two credentials must be excluded. */
  async function vaultWithTwoKeys() {
    const v = await vaultWithK1()
    const h = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [PIN_B, v.passphrase],
      script: script([nano(B)], CRED_B, { [B]: { [CRED_A]: "absent" } }),
    })
    const code = await run(
      [
        "vault",
        "factor",
        "add",
        "security-key",
        "--label",
        "nano2",
        "--factor",
        "passphrase",
        "--keystore",
        v.vaultPath,
      ],
      h.deps,
    )
    if (code !== 0) throw new Error(`second key failed (${code}): ${h.stderr.text}${h.stdout.text}`)
    return v
  }

  test("maxCredentialCountInList 1, and none reported, with two vault keys: VAULT_FACTOR_UNAVAILABLE naming both counts before any PIN", async () => {
    const v = await vaultWithTwoKeys()
    for (const device of [nano(C, { maxCredentialCountInList: 1 }), nano(C, { maxCredentialCountInList: undefined })]) {
      const third: Device = { ...device }
      if (third.maxCredentialCountInList === undefined) delete third.maxCredentialCountInList
      const h = await harness({
        env: { CANDLE_CONFIG_DIR: v.dir },
        script: script([third], base64.encode(new Uint8Array(48).fill(9)), {
          [C]: { [CRED_A]: "absent", [CRED_B]: "absent" },
        }),
      })
      expect(
        await run(
          ["vault", "factor", "add", "security-key", "--factor", "passphrase", "--json", "--keystore", v.vaultPath],
          h.deps,
        ),
      ).toBe(1)
      const body = failure(h)
      expect(body.code).toBe("VAULT_FACTOR_UNAVAILABLE")
      expect(body.message).toContain("takes at most 1 credential in one request")
      expect(body.message).toContain("this vault has 2 security key credentials to exclude")
      if (third.maxCredentialCountInList === undefined)
        expect(body.message).toContain("reports no maxCredentialCountInList")
      expect(h.asked).toEqual([])
      expect(ops(h)).toEqual(["info", "probe", "info"])
    }
  })
})

describe("T15: --factor on factor add security-key", () => {
  test("--factor K1 is honoured, the probe still places the device, and the menu is skipped", async () => {
    const v = await vaultWithK1()
    const h = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [PIN_A, PIN_B],
      script: script([nano(A), nano(B)], CRED_B, k1OnA()),
    })
    expect(
      await run(["vault", "factor", "add", "security-key", "--factor", v.k1, "--keystore", v.vaultPath], h.deps),
    ).toBe(0)
    expect(h.asked.some((a) => a.startsWith("line:"))).toBe(false)
    expect(ops(h)).toEqual(["info", "probe", "info", "assert@A", "info", "register@B", "assert@B", "assert@B"])
  })

  test("--factor touch-id and --factor passkey print the excluded line, then the restricted menu; --factor passphrase prints no line", async () => {
    const v = await vaultWithK1()
    await addFixtureEnvelopes(v.vaultPath, v.passphrase, [touchId(), syncedPasskey()])
    for (const flag of ["touch-id", "passkey", "t1", "s1"]) {
      const h = await harness({
        env: { CANDLE_CONFIG_DIR: v.dir },
        lines: ["nope"],
        script: script([nano(A), nano(B)], CRED_B, k1OnA()),
      })
      expect(
        await run(
          ["vault", "factor", "add", "security-key", "--factor", flag, "--json", "--keystore", v.vaultPath],
          h.deps,
        ),
      ).toBe(1)
      const excluded = h.events.findIndex((e) =>
        e.includes(
          `--factor ${flag} is not used here: adding a factor opens the vault with the passphrase or a security key.`,
        ),
      )
      const menu = h.events.findIndex((e) => e.startsWith("line: Unlock with:"))
      expect([flag, excluded > -1]).toEqual([flag, true])
      expect(menu).toBeGreaterThan(excluded)
      expect(h.events[menu]).toBe(
        `line: Unlock with:\n  1  nano1  (security key, attached)  id ${v.k1}\n  2  Passphrase\n> `,
      )
    }
    const passphrase = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [PIN_B, v.passphrase],
      script: script([nano(B)], CRED_B, { [B]: { [CRED_A]: "absent" } }),
    })
    expect(
      await run(
        ["vault", "factor", "add", "security-key", "--factor", "passphrase", "--keystore", v.vaultPath],
        passphrase.deps,
      ),
    ).toBe(0)
    expect(passphrase.stderr.text).not.toContain(PASSPHRASE_ONLY_PREFIX)
    expect(passphrase.stderr.text).not.toContain("is not used here")
  })
})

describe("T16: row F3", () => {
  test("no key on the vault but another factor: the line before the passphrase prompt, once; none on a passphrase-only vault", async () => {
    const v = await initVault()
    await addFixtureEnvelopes(v.vaultPath, v.passphrase, [touchId()])
    const h = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [PIN_A, v.passphrase],
      script: script([nano(A)], CRED_A),
    })
    expect(await run(["vault", "factor", "add", "security-key", "--keystore", v.vaultPath], h.deps)).toBe(0)
    const line = h.events.findIndex((e) =>
      e.includes(
        `${PASSPHRASE_ONLY_PREFIX}adding a factor opens the vault with the passphrase or a security key, and this vault has no security key.`,
      ),
    )
    const pin = h.events.findIndex((e) => e.startsWith("secret: PIN for"))
    const prompt = h.events.findIndex((e) => e.startsWith("secret: Current vault passphrase"))
    expect(line).toBeGreaterThan(-1)
    expect(pin).toBeLessThan(line)
    expect(prompt).toBeGreaterThan(line)
    expect(h.stderr.text.split(PASSPHRASE_ONLY_PREFIX)).toHaveLength(2)
    // No menu: Touch ID is not offered, and with no key there is nothing to choose.
    expect(h.asked.some((a) => a.startsWith("line:"))).toBe(false)

    // The second variant (keys exist and none can be driven here) cannot reach this command: a
    // machine that cannot drive a security key is refused by `assertFactorAddable` before the vault
    // is read. It is pinned on `factor add touch-id` in `vault-passkey.test.ts` (T17).
    const fresh = await initVault()
    const first = await harness({
      env: { CANDLE_CONFIG_DIR: fresh.dir },
      secrets: [PIN_A, fresh.passphrase],
      script: script([nano(A)], CRED_A),
    })
    expect(await run(["vault", "factor", "add", "security-key", "--keystore", fresh.vaultPath], first.deps)).toBe(0)
    expect(first.stderr.text).not.toContain(PASSPHRASE_ONLY_PREFIX)
  })
})

describe("T18: what does not change", () => {
  test("factor remove of the last passphrase is VAULT_LAST_PASSPHRASE, and factor add passphrase still uses the unrestricted chooser", async () => {
    const v = await vaultWithK1()
    await addFixtureEnvelopes(v.vaultPath, v.passphrase, [touchId(), syncedPasskey()])
    const remove = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [PIN_A],
      script: script([nano(A)], CRED_B, k1OnA()),
    })
    expect(
      await run(
        ["vault", "factor", "remove", v.passphraseId, "--factor", v.k1, "--json", "--keystore", v.vaultPath],
        remove.deps,
      ),
    ).toBe(1)
    expect(failure(remove).code).toBe("VAULT_LAST_PASSPHRASE")

    // `factor add passphrase` opens through the full chooser: the Touch ID and synced passkey this
    // machine cannot drive are named under the rows, which the restricted `factor add` menu never does.
    const add = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      lines: ["nope"],
      script: script([nano(A)], CRED_B, k1OnA()),
    })
    expect(
      await run(
        ["vault", "factor", "add", "passphrase", "--own-passphrase", "--json", "--keystore", v.vaultPath],
        add.deps,
      ),
    ).toBe(1)
    expect(add.asked[0]).toContain("Not usable on this machine: Touch ID (Touch ID), synced passkey (synced passkey)")
  })
})
