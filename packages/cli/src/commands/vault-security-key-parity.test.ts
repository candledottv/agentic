/**
 * BE-292 / BE-310 (spec `2026-09-23-cli-security-key-parity-design.md`, §8): security-key parity
 * with the passphrase, end to end through `run()` with the scripted authenticator and a real vault
 * file.
 *
 * What is pinned, by test number of the spec's matrix: a sealed copy keeps the passphrase and the
 * security key by an exact predicate and never a synced passkey or Touch ID envelope (T1, T6, T7);
 * invariant 2 is evaluated against the envelopes that protect the copy (T8); the live vault for a
 * sealed backup opens with a key and the copy is re-opened with it, the floor carried byte for
 * byte (T2, T3, T14); `verify-backup` opens with any carried factor (T4, T16); the copy restores
 * with either factor (T5); `phrase show` accepts a fresh key presentation, TTY-gated and
 * UP-checked, with the record before the render (T9, T10, T11); every passphrase-only prompt is
 * preceded by one `Passphrase only:` line and none is printed where the passphrase is the only
 * envelope (T12); old sealed copies are reported as passphrase-only with a fresh backup advised
 * (T13, T18, T20) and a routine verify keeps a bound receipt bound (T19). T15 lives in the existing
 * backup suites; T17 in `scripts/cli-docs.test.ts`.
 *
 * The synced-passkey and Touch ID envelopes are hand-built fixtures re-sealed into a real vault's
 * header (the index authenticates the header, ED-1, so they cannot simply be appended). Neither can
 * be driven on the Linux runner, which is exactly what T1 needs: they are left out by the
 * predicate, not by being unusable.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { readFileSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sha256 } from "@noble/hashes/sha256"
import { base64 } from "@scure/base"
import type { Deps } from "../deps"
import { AUTHDATA_FLAG_UP, AUTHDATA_FLAG_UV, handleLine, RP_ID } from "../fido2-helper/protocol"
import { type BackendLogEntry, type HelperScript, scriptedBackend } from "../fido2-helper/test-backend"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"
import {
  assertBackupDomainAllowed,
  countRecoverableFactors,
  keptInSealedCopy,
  recoverableDomains,
  sealedEnvelopes,
} from "../vault/domains"
import { HELPER_ENV } from "../vault/fido2"
import type { Envelope } from "../vault/format"
import { nextSidecar, readSidecar, sidecarPath, writeSidecar } from "../vault/sidecar"
import { closeVault, sealIndex, serializeVault, unlockWithPassphrase } from "../vault/store"
import { generatedPassphraseFrom, useCheapKdf } from "../vault/test-vault"
import {
  assertFloorCarried,
  freshBackupAdvice,
  isSealedCopy,
  PASSPHRASE_NOT_EXERCISED,
  sealedCopyNote,
  sealedPassphraseOnlyReason,
} from "./vault-backup"
import { describeLastBackup, lastBackupLines } from "./vault-status"
import { PASSPHRASE_ONLY_PREFIX } from "./vault-support"

setDefaultTimeout(90_000)
useCheapKdf()

const unreachableFetch = (async () => {
  throw new Error("no test in this file should make a network call")
}) as unknown as typeof fetch

const PIN = "482913"
const HMAC_SECRET = base64.encode(new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff))
const CRED = base64.encode(new Uint8Array(48).map((_, i) => (i * 7 + 3) & 0xff))
const AAGUID = "2fc0579f811347eab116bb5a8db9202a"

function authDataFor(rpId: string, flags: number): string {
  const out = new Uint8Array(37)
  out.set(sha256(new TextEncoder().encode(rpId)), 0)
  out[32] = flags
  return base64.encode(out)
}

const UV_UP = authDataFor(RP_ID, AUTHDATA_FLAG_UP | AUTHDATA_FLAG_UV)
/** UV set, UP clear: what T11 refuses. */
const UV_ONLY = authDataFor(RP_ID, AUTHDATA_FLAG_UV)

function goodScript(): HelperScript {
  return {
    devices: [
      {
        path: "/dev/hidraw3",
        product: "YubiKey 5 NFC",
        manufacturer: "Yubico",
        aaguid: AAGUID,
        extensions: ["hmac-secret", "credProtect"],
        options: { rk: true, clientPin: true, uv: false },
      },
    ],
    register: { credentialId: CRED, aaguid: AAGUID, authData: UV_UP },
    assert: { hmacSecret: HMAC_SECRET, authData: UV_UP },
  }
}

interface Harness {
  deps: Deps
  stdout: ReturnType<typeof createCapture>
  stderr: ReturnType<typeof createCapture>
  asked: string[]
  /** One ordered log of stderr writes and prompts, so "before the prompt" is a real assertion. */
  events: string[]
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
  helper?: "ready" | "absent"
}

async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = opts.env?.CANDLE_CONFIG_DIR ?? (await mkdtemp(join(tmpdir(), "candle-vault-parity-")))
  const stdout = createCapture()
  const stderr = createCapture()
  const asked: string[] = []
  const events: string[] = []
  const calls: BackendLogEntry[] = []
  const secrets = [...(opts.secrets ?? [])]
  const lines = [...(opts.lines ?? [])]
  const script = opts.script ?? goodScript()
  const env: Record<string, string> = { CANDLE_CONFIG_DIR: dir, HOME: dir, ...(opts.env ?? {}) }
  if ((opts.helper ?? "ready") === "ready") {
    const helper = join(dir, "candle-fido2")
    await writeFile(helper, "#!/bin/sh\nexit 1\n")
    await chmod(helper, 0o755)
    env[HELPER_ENV] = helper
  }
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
    isTTY: { stdin: opts.tty ?? true, stdout: opts.tty ?? true, stderr: opts.tty ?? true },
    spawnHelper: async (_path, line) => {
      const response = handleLine(line, () => scriptedBackend(script, (entry) => calls.push(entry)))
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
      const next = lines.shift()
      if (next === undefined) throw new Error(`promptLine asked for more than the test scripted: ${text}`)
      return next
    },
  })
  return { deps, stdout, stderr, asked, events, calls, dir, vaultPath: join(dir, "vault.enc"), script }
}

interface VaultJson {
  vaultId: string
  generation: number
  index: { ciphertext: string }
  root: { ciphertext: string }
  envelopes: Array<Record<string, unknown> & { id: string; factor: string; transport?: string; domain: string }>
  keys: Array<{ id: string; ciphertext: string }>
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

/** A vault with one derived key and the scripted security key enrolled. */
async function vaultWithKey() {
  const v = await initVault()
  const k = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [v.passphrase] })
  if ((await run(["vault", "new-key", "--chain", "solana", "--keystore", v.vaultPath], k.deps)) !== 0) {
    throw new Error(`new-key failed: ${k.stderr.text}`)
  }
  const add = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [PIN, v.passphrase] })
  const code = await run(
    ["vault", "factor", "add", "security-key", "--label", "desk key", "--keystore", v.vaultPath],
    add.deps,
  )
  if (code !== 0) throw new Error(`factor add security-key failed (${code}): ${add.stderr.text}${add.stdout.text}`)
  const file = await readVault(v.vaultPath)
  const keyId = (file.envelopes.find((envelope) => envelope.factor === "passkey-prf") as { id: string }).id
  const passphraseId = (file.envelopes.find((envelope) => envelope.factor === "passphrase") as { id: string }).id
  return { ...v, keyId, passphraseId }
}

const HELPER = { teamId: "ABCDE12345", bundleId: "tv.candle.cli.enclave", minVersion: "0.13.0" }
const WRAP = {
  alg: "AES-256-GCM",
  iv: base64.encode(new Uint8Array(12)),
  ciphertext: base64.encode(new Uint8Array(48)),
}

/** A synced passkey envelope, shape-valid, never drivable on this runner. */
const syncedPasskey = (id = "s1"): Envelope =>
  ({
    id,
    factor: "passkey-prf",
    transport: "platform-macos",
    domain: "apple-account",
    label: "synced passkey",
    createdAt: "2026-09-23T00:00:00.000Z",
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

/** A Touch ID envelope, shape-valid, never drivable on this runner. */
const touchId = (id = "t1"): Envelope =>
  ({
    id,
    factor: "secure-enclave",
    domain: "this-device",
    label: "Touch ID",
    createdAt: "2026-09-23T00:00:00.000Z",
    wrap: WRAP,
    helper: HELPER,
    publicKey: "AQID",
    keyTag: "tag",
    accessControl: "biometryCurrentSet",
    kek: { alg: "ECIES-P256-SHA256-AESGCM", ciphertext: "AQID" },
  }) as unknown as Envelope

/**
 * Re-seals the live vault's index under a header that also carries `extra`. The generation is
 * kept (this is the same state with more envelopes recorded), so the sidecar's rollback check is
 * untouched.
 */
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

/** A home of the test's own with the three sealing destinations in it. */
async function cloudHome(): Promise<{ home: string; icloud: string; dropbox: string; unknown: string }> {
  const home = await mkdtemp(join(tmpdir(), "candle-vault-parity-home-"))
  const icloud = join(home, "Library", "Mobile Documents", "com~apple~CloudDocs")
  const dropbox = join(home, "Dropbox")
  await mkdir(icloud, { recursive: true })
  await mkdir(dropbox, { recursive: true })
  return { home, icloud, dropbox, unknown: join(home, "no-such-dir") }
}

/** The four-envelope vault of T1: passphrase, security key, synced passkey, Touch ID. */
async function fourFactorVault() {
  const v = await vaultWithKey()
  await addFixtureEnvelopes(v.vaultPath, v.passphrase, [syncedPasskey(), touchId()])
  expect((await readVault(v.vaultPath)).envelopes.map((e) => e.factor).sort()).toEqual(
    ["passkey-prf", "passkey-prf", "passphrase", "secure-enclave"].sort(),
  )
  return v
}

const passphraseFixture = (id = "p1"): Envelope =>
  ({ id, factor: "passphrase", domain: "human-memory", label: "", createdAt: "", wrap: WRAP }) as unknown as Envelope
const securityKeyFixture = (id: string, over: Record<string, unknown> = {}): Envelope =>
  ({
    id,
    factor: "passkey-prf",
    transport: "ctap2",
    domain: "hardware-token",
    label: "",
    createdAt: "",
    backupEligible: false,
    wrap: WRAP,
    ...over,
  }) as unknown as Envelope

describe("T1, T2, T3, T6: a sealed copy carries the passphrase and the security key, and opens with either", () => {
  test("T1: to icloud-drive, other-cloud and unknown, the copy's header is exactly {passphrase, key}", async () => {
    const v = await fourFactorVault()
    const { home, icloud, dropbox, unknown } = await cloudHome()
    for (const [name, dir, real] of [
      ["icloud-drive", icloud, false],
      ["other-cloud", dropbox, false],
      ["unknown", unknown, true],
    ] as const) {
      const to = join(dir, `copy-${name}.enc`)
      const b = await harness({
        env: { CANDLE_CONFIG_DIR: v.dir, HOME: home },
        lines: ["passphrase"],
        secrets: [v.passphrase],
      })
      if (real) b.deps.realpath = (path: string) => realpath(path)
      expect(await run(["vault", "backup", "--to", to, "--json", "--keystore", v.vaultPath], b.deps)).toBe(0)
      const body = JSON.parse(b.stdout.text) as Record<string, unknown>
      expect(body.destinationDomain).toBe(name)
      expect(body.sealed).toBe(true)
      expect((body.envelopesInCopy as string[]).sort()).toEqual([v.passphraseId, v.keyId].sort())
      expect((body.envelopesLeftOut as string[]).sort()).toEqual(["s1", "t1"])
      expect(body.recoverableFactorsInCopy).toBe(1)
      const copy = await readVault(to)
      expect(copy.envelopes.map((e) => e.id).sort()).toEqual([v.passphraseId, v.keyId].sort())
      expect(copy.envelopes.some((e) => e.domain === "apple-account")).toBe(false)
      expect(copy.envelopes.some((e) => e.domain === "this-device")).toBe(false)
      expect(isSealedCopy(await readFile(to, "utf8"))).toBe(true)
      // The live vault is untouched.
      expect((await readVault(v.vaultPath)).envelopes).toHaveLength(4)
    }
  })

  test("T2: --factor security-key opens the live vault and re-opens the copy with the key; the floor is carried", async () => {
    const v = await fourFactorVault()
    const { home, icloud } = await cloudHome()
    const to = join(icloud, "by-key.enc")
    const b = await harness({ env: { CANDLE_CONFIG_DIR: v.dir, HOME: home }, secrets: [PIN] })
    expect(
      await run(["vault", "backup", "--to", to, "--factor", "security-key", "--keystore", v.vaultPath], b.deps),
    ).toBe(0)
    // The PIN only: no passphrase was asked for.
    expect(b.asked).toEqual([expect.stringContaining("PIN for YubiKey 5 NFC")])
    // Two assertions: the live open, then the copy's re-open. Every one carried the PIN.
    expect(b.calls.map((call) => call.op)).toEqual(["assert", "assert"])
    expect(b.calls.every((call) => call.pin === PIN)).toBe(true)
    // Row B1 before the PIN; no `Passphrase only:` line, since the passphrase was not the only answer.
    const b1 = b.events.findIndex((e) =>
      e.includes("so this backup is a sealed copy: it carries the passphrase and any security key"),
    )
    const pin = b.events.findIndex((e) => e.startsWith("secret: "))
    expect(b1).toBeGreaterThan(-1)
    expect(b1).toBeLessThan(pin)
    expect(b.stderr.text).not.toContain(PASSPHRASE_ONLY_PREFIX)
    expect(b.stderr.text).toContain("Touch YubiKey 5 NFC to unlock the vault.")
    // The report: what the copy carries, what opened it, and that the passphrase came along.
    expect(b.stdout.text).toContain(
      `  sealed        yes: carries passphrase ${v.passphraseId}, security key ${v.keyId}; left out synced passkey s1, Touch ID t1`,
    )
    expect(b.stdout.text).toContain(
      `  verified with security key ${v.keyId} (the copy was re-opened with it); passphrase ${v.passphraseId} carried byte for byte`,
    )
    expect(b.stdout.text).toContain("  steps         all 8 passed, in order")
    expect(b.stdout.text).toContain(sealedCopyNote([v.keyId]))
    expect(b.stdout.text).toContain("Removing a key from this vault later does not remove it from this copy.")
    expect(b.stdout.text + b.stderr.text).not.toContain(PIN)
    expect(b.stdout.text + b.stderr.text).not.toContain(HMAC_SECRET)

    const j = await harness({ env: { CANDLE_CONFIG_DIR: v.dir, HOME: home }, secrets: [PIN] })
    const jsonTo = join(icloud, "by-key-json.enc")
    expect(
      await run(
        ["vault", "backup", "--to", jsonTo, "--factor", "security-key", "--json", "--keystore", v.vaultPath],
        j.deps,
      ),
    ).toBe(0)
    expect(JSON.parse(j.stdout.text)).toMatchObject({
      ok: true,
      sealed: true,
      openedWith: { factor: "security-key", envelopeId: v.keyId },
      recoverableFactorsInCopy: 1,
    })
    // The sidecar binds the copy's ids to this receipt with one string (D8).
    const sidecar = await readSidecar(sidecarPath(v.vaultPath))
    expect(sidecar?.lastBackupAt).toBe(sidecar?.lastVerifiedBackupAt)
    expect(sidecar?.lastBackupEnvelopeIdsAt).toBe(sidecar?.lastBackupAt)
    expect(sidecar?.lastBackupIdsVerifiedAt).toBe(sidecar?.lastVerifiedBackupAt)
    expect(sidecar?.lastBackupEnvelopeIds?.sort()).toEqual([v.passphraseId, v.keyId].sort())
  })

  test("T3: the chooser offers passphrase or key on a sealed backup; answering passphrase runs no helper call", async () => {
    const v = await fourFactorVault()
    const { home, icloud } = await cloudHome()
    const to = join(icloud, "by-passphrase.enc")
    const b = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir, HOME: home },
      lines: ["passphrase"],
      secrets: [v.passphrase],
    })
    expect(await run(["vault", "backup", "--to", to, "--json", "--keystore", v.vaultPath], b.deps)).toBe(0)
    expect(b.asked[0]).toContain("This vault opens with a passphrase or a security key")
    expect(b.asked[0]).toContain(v.keyId)
    // The restricted chooser lists the key and neither of the envelopes the copy leaves out.
    expect(b.asked[0]).not.toContain("s1")
    expect(b.asked[0]).not.toContain("t1")
    expect(b.calls).toEqual([])
    expect(b.stderr.text).not.toContain(PASSPHRASE_ONLY_PREFIX)
    expect(JSON.parse(b.stdout.text)).toMatchObject({
      ok: true,
      openedWith: { factor: "passphrase", envelopeId: v.passphraseId },
    })
  })

  test("B3: --factor passkey or the Touch ID id on a sealed backup prints the not-used line and falls through", async () => {
    const v = await fourFactorVault()
    const { home, icloud } = await cloudHome()
    for (const flag of ["passkey", "touch-id", "t1", "s1"]) {
      const to = join(icloud, `not-used-${flag}.enc`)
      const b = await harness({ env: { CANDLE_CONFIG_DIR: v.dir, HOME: home }, lines: [v.keyId], secrets: [PIN] })
      expect(await run(["vault", "backup", "--to", to, "--factor", flag, "--keystore", v.vaultPath], b.deps)).toBe(0)
      expect(b.stderr.text).toContain(
        `--factor ${flag} is not used here: a sealed copy carries no Touch ID or synced passkey envelope.`,
      )
      // Then the restricted chooser, which the key answered.
      expect(b.asked[0]).toContain("This vault opens with a passphrase or a security key")
      expect(b.calls.map((call) => call.op)).toEqual(["assert", "assert"])
    }
  })

  test("T6: a synced passkey is never carried; a vault with only a synced passkey beside the passphrase gets a passphrase-only copy and row B2", async () => {
    const v = await initVault()
    await addFixtureEnvelopes(v.vaultPath, v.passphrase, [syncedPasskey()])
    const { home, icloud } = await cloudHome()
    const to = join(icloud, "passkey-only.enc")
    const b = await harness({ env: { CANDLE_CONFIG_DIR: v.dir, HOME: home }, secrets: [v.passphrase] })
    expect(await run(["vault", "backup", "--to", to, "--keystore", v.vaultPath], b.deps)).toBe(0)
    const copy = await readVault(to)
    expect(copy.envelopes.map((e) => e.factor)).toEqual(["passphrase"])
    expect(copy.envelopes.some((e) => e.domain === "apple-account")).toBe(false)
    // B1, then B2, both before the passphrase prompt.
    const b1 = b.events.findIndex((e) => e.includes("so this backup is a sealed copy"))
    const b2 = b.events.findIndex((e) =>
      e.includes(
        `${PASSPHRASE_ONLY_PREFIX}a sealed copy opens with the passphrase or a security key, and this vault has no security key. Add one with: candle vault enroll security-key`,
      ),
    )
    const prompt = b.events.findIndex((e) => e.startsWith("secret: Vault passphrase"))
    expect(b1).toBeGreaterThan(-1)
    expect(b2).toBeGreaterThan(b1)
    expect(prompt).toBeGreaterThan(b2)
    expect(b.stdout.text).toContain("This copy opens only with the passphrase it was sealed under")
    expect(b.stdout.text).toContain("This vault had no security key for it to carry.")
  })
})

describe("T7, T8: the predicate and invariant 2 on the copy set", () => {
  test("T7: keptInSealedCopy is an allow-list over two exact shapes, and the pair rule reads the same four fields", () => {
    const p1 = passphraseFixture("p1")
    const k1 = securityKeyFixture("k1")
    expect(keptInSealedCopy(p1)).toBe(true)
    expect(keptInSealedCopy(k1)).toBe(true)
    // Each of the four fields, wrong, leaves the envelope out.
    expect(keptInSealedCopy(securityKeyFixture("k2", { backupEligible: true }))).toBe(false)
    expect(keptInSealedCopy(securityKeyFixture("k3", { domain: "apple-account" }))).toBe(false)
    expect(keptInSealedCopy(securityKeyFixture("k4", { transport: "usb-future" }))).toBe(false)
    expect(keptInSealedCopy(securityKeyFixture("k5", { backupEligible: undefined }))).toBe(false)
    expect(keptInSealedCopy({ ...passphraseFixture("p2"), domain: "apple-account" } as Envelope)).toBe(false)
    expect(keptInSealedCopy({ ...k1, factor: "future-factor" } as Envelope)).toBe(false)
    expect(keptInSealedCopy(syncedPasskey())).toBe(false)
    expect(keptInSealedCopy(touchId())).toBe(false)
    expect(
      sealedEnvelopes([p1, k1, syncedPasskey(), touchId(), securityKeyFixture("k4", { transport: "usb-future" })]).map(
        (e) => e.id,
      ),
    ).toEqual(["p1", "k1"])

    // Two unknown-transport PRF envelopes are not a hardware pair, and a sealed copy leaves them out.
    const u1 = securityKeyFixture("u1", { transport: "usb-future" })
    const u2 = securityKeyFixture("u2", { transport: "usb-future" })
    expect(recoverableDomains([u1, u2])).not.toContain("hardware-token")
    expect(sealedEnvelopes([p1, u1, u2]).map((e) => e.id)).toEqual(["p1"])
    // Two exact security-key envelopes are.
    expect(recoverableDomains([k1, securityKeyFixture("k6")])).toContain("hardware-token")
    expect(recoverableDomains([k1])).not.toContain("hardware-token")
    // A missing flag is not a security key, on either rule.
    expect(
      recoverableDomains([
        securityKeyFixture("k7", { backupEligible: undefined }),
        securityKeyFixture("k8", { backupEligible: undefined }),
      ]),
    ).toEqual([])
  })

  test("T8: assertBackupDomainAllowed evaluates invariant 2 against the envelopes that protect the copy", async () => {
    const lexical = { realpath: async (path: string) => path, home: "/Users/someone" }
    const icloud = "/Users/someone/Library/Mobile Documents/com~apple~CloudDocs/vault.enc"
    const p1 = passphraseFixture("p1")
    const k1 = securityKeyFixture("k1")
    const k2 = securityKeyFixture("k2")
    // A hardware pair with no passphrase is allowed to iCloud Drive: the copy keeps both keys.
    const pair = await assertBackupDomainAllowed([k1, k2], icloud, { acceptSharedDomain: false, ...lexical })
    expect(pair).toMatchObject({ sealed: true, copyEnvelopeIds: ["k1", "k2"], recoverableFactorsInCopy: 1 })
    // One synced passkey and nothing else, unsealed to iCloud Drive: still VAULT_SHARED_DOMAIN.
    await expect(
      assertBackupDomainAllowed([syncedPasskey()], icloud, { acceptSharedDomain: true, ...lexical }),
    ).rejects.toMatchObject({ code: "VAULT_SHARED_DOMAIN" })
    // One CTAP2 envelope alone: no recoverable factor.
    await expect(
      assertBackupDomainAllowed([k1], icloud, { acceptSharedDomain: false, ...lexical }),
    ).rejects.toMatchObject({ code: "VAULT_NO_RECOVERABLE_FACTOR" })
    // Two unknown-transport PRF envelopes with no passphrase: not a pair, so no recoverable factor.
    const u1 = securityKeyFixture("u1", { transport: "usb-future" })
    const u2 = securityKeyFixture("u2", { transport: "usb-future" })
    await expect(
      assertBackupDomainAllowed([u1, u2], icloud, { acceptSharedDomain: false, ...lexical }),
    ).rejects.toMatchObject({ code: "VAULT_NO_RECOVERABLE_FACTOR" })
    // The same two plus a passphrase, sealed: allowed, one recoverable factor, no hardware pair on either set.
    const withPassphrase = await assertBackupDomainAllowed([p1, u1, u2], icloud, {
      acceptSharedDomain: false,
      ...lexical,
    })
    expect(withPassphrase).toMatchObject({ sealed: true, copyEnvelopeIds: ["p1"], recoverableFactorsInCopy: 1 })
    expect(recoverableDomains([p1, u1, u2])).not.toContain("hardware-token")
    expect(recoverableDomains(sealedEnvelopes([p1, u1, u2]))).not.toContain("hardware-token")
    // The copy's count is never above the live vault's, and is below it exactly when the live
    // vault has a recoverable domain the copy does not keep (a synced passkey).
    const mixed = await assertBackupDomainAllowed([p1, k1, syncedPasskey()], icloud, {
      acceptSharedDomain: false,
      ...lexical,
    })
    expect(mixed.recoverableFactorsInCopy).toBe(1)
    expect(countRecoverableFactors([p1, k1, syncedPasskey()])).toBe(2)
    // Unsealed: the copy set is the whole vault, and so is the count.
    const accepted = await assertBackupDomainAllowed([p1, k1, syncedPasskey()], icloud, {
      acceptSharedDomain: true,
      ...lexical,
    })
    expect(accepted).toMatchObject({ sealed: false, copyEnvelopeIds: ["p1", "k1", "s1"], recoverableFactorsInCopy: 2 })
  })
})

describe("T4, T5, T16: verify-backup and restore with either carried factor", () => {
  test("T4: verify-backup of the key-written copy, once with the key and once with the passphrase", async () => {
    const v = await fourFactorVault()
    const { home, icloud } = await cloudHome()
    const to = join(icloud, "verify-me.enc")
    const b = await harness({ env: { CANDLE_CONFIG_DIR: v.dir, HOME: home }, secrets: [PIN] })
    expect(
      await run(["vault", "backup", "--to", to, "--factor", "security-key", "--keystore", v.vaultPath], b.deps),
    ).toBe(0)

    const byKey = await harness({ env: { CANDLE_CONFIG_DIR: v.dir, HOME: home }, secrets: [PIN] })
    expect(
      await run(
        ["vault", "verify-backup", to, "--factor", "security-key", "--json", "--keystore", v.vaultPath],
        byKey.deps,
      ),
    ).toBe(0)
    expect(byKey.calls.map((call) => call.op)).toEqual(["assert", "assert"])
    const keyBody = JSON.parse(byKey.stdout.text) as Record<string, unknown>
    expect(keyBody).toMatchObject({
      ok: true,
      sealed: true,
      steps: 8,
      passphraseExercised: false,
      openedWith: { factor: "security-key", envelopeId: v.keyId },
    })
    expect((keyBody.envelopesInCopy as string[]).sort()).toEqual([v.passphraseId, v.keyId].sort())
    expect(keyBody).not.toHaveProperty("securityKeysNotInCopy")

    const byPassphrase = await harness({ env: { CANDLE_CONFIG_DIR: v.dir, HOME: home }, secrets: [v.passphrase] })
    expect(
      await run(
        ["vault", "verify-backup", to, "--factor", "passphrase", "--json", "--keystore", v.vaultPath],
        byPassphrase.deps,
      ),
    ).toBe(0)
    expect(byPassphrase.calls).toEqual([])
    expect(JSON.parse(byPassphrase.stdout.text)).toMatchObject({
      ok: true,
      sealed: true,
      steps: 8,
      passphraseExercised: true,
      openedWith: { factor: "passphrase", envelopeId: v.passphraseId },
    })

    // Human output with the key: the report names the factor and says the passphrase was carried.
    const human = await harness({ env: { CANDLE_CONFIG_DIR: v.dir, HOME: home }, lines: [v.keyId], secrets: [PIN] })
    expect(await run(["vault", "verify-backup", to, "--keystore", v.vaultPath], human.deps)).toBe(0)
    expect(human.stdout.text).toContain(
      `  verified with security key ${v.keyId} (the copy was re-opened with it); passphrase ${v.passphraseId} carried byte for byte`,
    )
    expect(human.stdout.text).toContain("  sealed        yes: carries passphrase")
    expect(human.stdout.text).not.toContain("Fresh backup advised")
  })

  test("verify-backup with the key after a passphrase rotation says the passphrase was not exercised", async () => {
    const v = await vaultWithKey()
    const { home, icloud } = await cloudHome()
    const to = join(icloud, "before-rotation.enc")
    const b = await harness({ env: { CANDLE_CONFIG_DIR: v.dir, HOME: home }, secrets: [PIN] })
    expect(
      await run(["vault", "backup", "--to", to, "--factor", "security-key", "--keystore", v.vaultPath], b.deps),
    ).toBe(0)
    const fresh = "synthetic rotated passphrase"
    const add = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [v.passphrase, fresh, fresh] })
    expect(
      await run(
        [
          "vault",
          "factor",
          "add",
          "passphrase",
          "--own-passphrase",
          "--factor",
          "passphrase",
          "--keystore",
          v.vaultPath,
        ],
        add.deps,
      ),
      add.stderr.text + add.stdout.text,
    ).toBe(0)
    const remove = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [fresh] })
    expect(
      await run(
        ["vault", "factor", "remove", v.passphraseId, "--factor", "passphrase", "--keystore", v.vaultPath],
        remove.deps,
      ),
      remove.stderr.text + remove.stdout.text,
    ).toBe(0)

    const byKey = await harness({ env: { CANDLE_CONFIG_DIR: v.dir, HOME: home }, secrets: [PIN] })
    expect(
      await run(["vault", "verify-backup", to, "--factor", "security-key", "--keystore", v.vaultPath], byKey.deps),
    ).toBe(0)
    expect(byKey.stdout.text).toContain(
      `  verified with security key ${v.keyId} (the copy was re-opened with it); ${PASSPHRASE_NOT_EXERCISED}`,
    )
    // And with --factor passphrase the copy's own passphrase proves the floor (row V2).
    const byOld = await harness({ env: { CANDLE_CONFIG_DIR: v.dir, HOME: home }, secrets: [fresh, v.passphrase] })
    expect(
      await run(
        ["vault", "verify-backup", to, "--factor", "passphrase", "--json", "--keystore", v.vaultPath],
        byOld.deps,
      ),
    ).toBe(0)
    expect(JSON.parse(byOld.stdout.text)).toMatchObject({
      ok: true,
      passphraseExercised: true,
      openedWith: { factor: "passphrase", envelopeId: v.passphraseId },
    })
    expect(byOld.asked).toEqual([
      expect.stringContaining("Vault passphrase"),
      expect.stringContaining("Passphrase this backup was sealed under"),
    ])
    expect(byOld.calls).toEqual([])
    expect(byOld.stderr.text).toContain(
      `${PASSPHRASE_ONLY_PREFIX}the factor that opened this vault is not in ${to} as it is now, so the copy opens with the passphrase it was sealed under, which may predate a rotation.`,
    )
  })

  test("T5: the sealed copy restores as vault.enc in a fresh config dir and opens with the key and with the passphrase", async () => {
    const v = await fourFactorVault()
    const { home, icloud } = await cloudHome()
    const to = join(icloud, "restore-me.enc")
    const b = await harness({ env: { CANDLE_CONFIG_DIR: v.dir, HOME: home }, secrets: [PIN] })
    expect(
      await run(["vault", "backup", "--to", to, "--factor", "security-key", "--keystore", v.vaultPath], b.deps),
    ).toBe(0)
    const liveStatus = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [v.passphrase] })
    expect(
      await run(
        ["vault", "status", "--unlock", "--factor", "passphrase", "--json", "--keystore", v.vaultPath],
        liveStatus.deps,
      ),
    ).toBe(0)
    const liveEntries = (JSON.parse(liveStatus.stdout.text) as { unlocked: { entries: { address: string }[] } })
      .unlocked.entries

    const restored = await mkdtemp(join(tmpdir(), "candle-vault-restored-"))
    await writeFile(join(restored, "vault.enc"), await readFile(to, "utf8"), { mode: 0o600 })
    for (const [factor, secret] of [
      ["security-key", PIN],
      ["passphrase", v.passphrase],
    ] as const) {
      const s = await harness({ env: { CANDLE_CONFIG_DIR: restored }, secrets: [secret] })
      expect(
        await run(
          ["vault", "status", "--unlock", "--factor", factor, "--json", "--keystore", join(restored, "vault.enc")],
          s.deps,
        ),
      ).toBe(0)
      const entries = (JSON.parse(s.stdout.text) as { unlocked: { entries: { address: string }[] } }).unlocked.entries
      expect(entries.map((e) => e.address)).toEqual(liveEntries.map((e) => e.address))
    }
  })

  test("T16: `sealed` follows the copy's envelopes: passphrase and keys only is sealed wherever it was written", async () => {
    const v = await vaultWithKey()
    // A local-disk full copy of a vault holding only a passphrase and a key: sealed: true (0.11.5 said false).
    const local = join(v.dir, "..", `local-${Date.now()}.enc`)
    const b = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [v.passphrase] })
    expect(
      await run(
        ["vault", "backup", "--to", local, "--factor", "passphrase", "--json", "--keystore", v.vaultPath],
        b.deps,
      ),
    ).toBe(0)
    expect(JSON.parse(b.stdout.text)).toMatchObject({ sealed: false, envelopesLeftOut: [] })
    const verify = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [v.passphrase] })
    expect(
      await run(
        ["vault", "verify-backup", local, "--factor", "passphrase", "--json", "--keystore", v.vaultPath],
        verify.deps,
      ),
    ).toBe(0)
    expect(JSON.parse(verify.stdout.text)).toMatchObject({ ok: true, sealed: true })

    // The same local copy plus a Touch ID envelope: sealed: false.
    await addFixtureEnvelopes(v.vaultPath, v.passphrase, [touchId()])
    const withTouch = join(v.dir, "..", `local-touch-${Date.now()}.enc`)
    const b2 = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [v.passphrase] })
    expect(
      await run(
        ["vault", "backup", "--to", withTouch, "--factor", "passphrase", "--json", "--keystore", v.vaultPath],
        b2.deps,
      ),
    ).toBe(0)
    const verify2 = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [v.passphrase] })
    expect(
      await run(
        ["vault", "verify-backup", withTouch, "--factor", "passphrase", "--json", "--keystore", v.vaultPath],
        verify2.deps,
      ),
    ).toBe(0)
    expect(JSON.parse(verify2.stdout.text)).toMatchObject({ ok: true, sealed: false })
    expect(isSealedCopy(await readFile(withTouch, "utf8"))).toBe(false)
    expect(isSealedCopy(await readFile(local, "utf8"))).toBe(true)
  })
})

describe("T9, T10, T11: phrase show with a security key", () => {
  /** Runs the ceremony with the words answered from the render itself. */
  function answerFromRender(h: Harness): { words: string[] } {
    const state = { words: [] as string[] }
    const write = h.deps.stdout.write.bind(h.deps.stdout)
    h.deps.stdout.write = (chunk: string) => {
      for (const match of chunk.matchAll(/(\d+)\. (\w+)/g)) state.words[Number(match[1]) - 1] = match[2] as string
      write(chunk)
    }
    h.deps.promptLine = async (text: string) => {
      h.asked.push(`line: ${text}`)
      h.events.push(`line: ${text}`)
      if (text.startsWith("Type understood")) return "understood"
      const match = /Type word (\d+):/.exec(text)
      if (!match?.[1]) throw new Error(`unexpected prompt: ${text}`)
      return state.words[Number(match[1]) - 1] as string
    }
    return state
  }

  test("T9: --factor security-key and the chooser both reach the words after one assertion, with the record before the render", async () => {
    for (const [flags, lines] of [
      [["--factor", "security-key"], []],
      [[], []],
    ] as const) {
      const v = await vaultWithKey()
      const before = (await readVault(v.vaultPath)).generation
      const p = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [PIN], lines: [...lines] })
      const generationAtWrite: number[] = []
      const write = p.deps.stdout.write.bind(p.deps.stdout)
      p.deps.stdout.write = (chunk: string) => {
        generationAtWrite.push((JSON.parse(readFileSync(v.vaultPath, "utf8")) as { generation: number }).generation)
        write(chunk)
      }
      const state = answerFromRender(p)
      if (flags.length === 0) {
        const inner = p.deps.promptLine
        p.deps.promptLine = async (text: string) =>
          text.includes("Type passphrase, or the id") ? v.keyId : inner(text)
      }
      expect(await run(["vault", "phrase", "show", ...flags, "--keystore", v.vaultPath], p.deps)).toBe(0)
      expect(state.words).toHaveLength(24)
      expect(p.asked.filter((a) => a.startsWith("secret:"))).toEqual([expect.stringContaining("PIN for YubiKey 5 NFC")])
      expect(p.asked.some((a) => a.includes("Vault passphrase"))).toBe(false)
      expect(p.calls.map((call) => call.op)).toEqual(["assert"])
      expect(p.stderr.text).toContain("Touch YubiKey 5 NFC to show the recovery phrase.")
      expect(p.stdout.text).toContain("Read-back matched")
      // The record precedes the exposure: at the write that rendered the first word row, the
      // vault's generation had already moved.
      const lines2 = p.stdout.text.split("\n")
      const firstRow = lines2.findIndex((line) => /^\s+1\. /.test(line))
      expect(firstRow).toBeGreaterThan(-1)
      const writesBeforeFirstRow = p.stdout.text.split("\n").slice(0, firstRow).join("\n")
      // Every stdout write that came after the commit saw the new generation; the word row is one.
      const rowWriteIndex = generationAtWrite.findIndex((g) => g > before)
      expect(rowWriteIndex).toBeGreaterThan(-1)
      expect(generationAtWrite.slice(rowWriteIndex).every((g) => g > before)).toBe(true)
      expect(writesBeforeFirstRow).not.toMatch(/\b1\. \w+/)
      const s = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [v.passphrase] })
      expect(
        await run(
          ["vault", "status", "--unlock", "--factor", "passphrase", "--json", "--keystore", v.vaultPath],
          s.deps,
        ),
      ).toBe(0)
      expect(JSON.parse(s.stdout.text)).toMatchObject({ unlocked: { rootExported: true } })
    }
  })

  test("T10: without a TTY, and under --json, the key is never spawned and the file is unchanged", async () => {
    const v = await vaultWithKey()
    const original = await readFile(v.vaultPath, "utf8")
    const piped = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, tty: false })
    expect(
      await run(["vault", "phrase", "show", "--factor", "security-key", "--keystore", v.vaultPath], piped.deps),
    ).toBe(1)
    expect(piped.stderr.text).toContain("PHRASE_REQUIRES_TTY")
    expect(piped.asked).toEqual([])
    expect(piped.calls).toEqual([])
    const json = await harness({ env: { CANDLE_CONFIG_DIR: v.dir } })
    expect(
      await run(
        ["vault", "phrase", "show", "--factor", "security-key", "--json", "--keystore", v.vaultPath],
        json.deps,
      ),
    ).toBe(2)
    expect(json.asked).toEqual([])
    expect(json.calls).toEqual([])
    expect(await readFile(v.vaultPath, "utf8")).toBe(original)
  })

  test("T11: an assertion with UV set and UP clear is refused, nothing derived, the record not written", async () => {
    const v = await vaultWithKey()
    const original = await readFile(v.vaultPath, "utf8")
    const script = { ...goodScript(), assert: { hmacSecret: HMAC_SECRET, authData: UV_ONLY } }
    const p = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [PIN], lines: ["understood"], script })
    expect(await run(["vault", "phrase", "show", "--factor", "security-key", "--keystore", v.vaultPath], p.deps)).toBe(
      1,
    )
    expect(p.stderr.text).toContain("without user presence (the UP flag is clear); nothing was derived")
    expect(p.stdout.text).not.toMatch(/\b1\. \w+/)
    expect(await readFile(v.vaultPath, "utf8")).toBe(original)

    const plain = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [PIN], script })
    expect(
      await run(
        ["vault", "status", "--unlock", "--factor", "security-key", "--json", "--keystore", v.vaultPath],
        plain.deps,
      ),
    ).toBe(1)
    expect(JSON.parse(plain.stdout.text)).toMatchObject({ ok: false, code: "VAULT_UNLOCK_FAILED" })
    expect(plain.stdout.text).toContain("UP flag is clear")
    expect(plain.stdout.text + plain.stderr.text).not.toContain(HMAC_SECRET)
  })
})

describe("T12: one Passphrase only: line before every passphrase-only prompt, and none where it is the only envelope", () => {
  /** The index of the line and of the passphrase prompt in the ordered log; the line must come first. */
  function lineBeforePrompt(h: Harness, text: string, prompt = "secret: ") {
    const line = h.events.findIndex((e) => e.startsWith("stderr: ") && e.includes(`${PASSPHRASE_ONLY_PREFIX}${text}`))
    const ask = h.events.findIndex((e) => e.startsWith(prompt))
    expect(line, `no line containing ${JSON.stringify(text)} in:\n${h.events.join("")}`).toBeGreaterThan(-1)
    expect(ask).toBeGreaterThan(line)
    expect(h.stderr.text.split(PASSPHRASE_ONLY_PREFIX)).toHaveLength(2)
  }

  test("B2, no security key: a sealed backup of a vault with a synced passkey only", async () => {
    const v = await initVault()
    await addFixtureEnvelopes(v.vaultPath, v.passphrase, [syncedPasskey()])
    const { home, icloud } = await cloudHome()
    const b = await harness({ env: { CANDLE_CONFIG_DIR: v.dir, HOME: home }, secrets: [v.passphrase] })
    expect(await run(["vault", "backup", "--to", join(icloud, "b2a.enc"), "--keystore", v.vaultPath], b.deps)).toBe(0)
    lineBeforePrompt(
      b,
      "a sealed copy opens with the passphrase or a security key, and this vault has no security key. Add one with: candle vault enroll security-key",
    )
    // B1 comes before the first prompt of a sealed backup with no --factor: Andrew's case.
    const b1 = b.events.findIndex((e) =>
      e.includes("so this backup is a sealed copy: it carries the passphrase and any security key"),
    )
    expect(b1).toBeGreaterThan(-1)
    expect(b1).toBeLessThan(b.events.findIndex((e) => e.startsWith("secret: ")))
  })

  test("B2, a security key that cannot be used here: the helper is absent", async () => {
    const v = await vaultWithKey()
    const { home, icloud } = await cloudHome()
    const b = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir, HOME: home },
      secrets: [v.passphrase],
      helper: "absent",
    })
    expect(await run(["vault", "backup", "--to", join(icloud, "b2b.enc"), "--keystore", v.vaultPath], b.deps)).toBe(0)
    lineBeforePrompt(
      b,
      `a sealed copy opens with the passphrase or a security key, and security key ${v.keyId} cannot be used on this machine: unavailable-on-this-device: `,
    )
    expect(b.calls).toEqual([])
  })

  test("V1: verify-backup of a passphrase-only copy against a vault that has a key", async () => {
    const v = await initVault()
    const { home, icloud } = await cloudHome()
    const to = join(icloud, "old-sealed.enc")
    const b = await harness({ env: { CANDLE_CONFIG_DIR: v.dir, HOME: home }, secrets: [v.passphrase] })
    expect(await run(["vault", "backup", "--to", to, "--keystore", v.vaultPath], b.deps)).toBe(0)
    // No line on a passphrase-only vault, for either prompt.
    expect(b.stderr.text).not.toContain(PASSPHRASE_ONLY_PREFIX)
    const add = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [PIN, v.passphrase] })
    expect(await run(["vault", "factor", "add", "security-key", "--keystore", v.vaultPath], add.deps)).toBe(0)
    // F1 does not fire on a vault whose only envelope was the passphrase when the key was added.
    expect(add.stderr.text).not.toContain(PASSPHRASE_ONLY_PREFIX)

    const verify = await harness({ env: { CANDLE_CONFIG_DIR: v.dir, HOME: home }, secrets: [v.passphrase] })
    expect(await run(["vault", "verify-backup", to, "--keystore", v.vaultPath], verify.deps)).toBe(0)
    lineBeforePrompt(
      verify,
      `${to} carries no security key envelope (a copy sealed by an earlier CLI, or from a vault that had none then), so only the passphrase opens it.`,
    )
    expect(verify.calls).toEqual([])
  })

  test("V2 and C1: after a rotation, the live open explains why the passphrase is the only answer, then the copy's own prompt explains itself", async () => {
    const v = await initVault()
    await addFixtureEnvelopes(v.vaultPath, v.passphrase, [syncedPasskey()])
    const { home, icloud } = await cloudHome()
    const to = join(icloud, "rotated.enc")
    const b = await harness({ env: { CANDLE_CONFIG_DIR: v.dir, HOME: home }, secrets: [v.passphrase] })
    expect(await run(["vault", "backup", "--to", to, "--keystore", v.vaultPath], b.deps)).toBe(0)
    const oldId = (await readVault(to)).envelopes[0]?.id as string
    const fresh = "synthetic rotated passphrase"
    const add = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [v.passphrase, fresh, fresh] })
    expect(
      await run(
        [
          "vault",
          "factor",
          "add",
          "passphrase",
          "--own-passphrase",
          "--factor",
          "passphrase",
          "--keystore",
          v.vaultPath,
        ],
        add.deps,
      ),
    ).toBe(0)
    const remove = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [fresh] })
    expect(
      await run(["vault", "factor", "remove", oldId, "--factor", "passphrase", "--keystore", v.vaultPath], remove.deps),
    ).toBe(0)

    const verify = await harness({ env: { CANDLE_CONFIG_DIR: v.dir, HOME: home }, secrets: [fresh, v.passphrase] })
    expect(await run(["vault", "verify-backup", to, "--keystore", v.vaultPath], verify.deps)).toBe(0)
    // C1 before the live prompt: the synced passkey cannot be driven here.
    const c1 = verify.events.findIndex((e) =>
      e.includes(
        `${PASSPHRASE_ONLY_PREFIX}no other factor on this vault can be used on this machine (s1 synced passkey: unsupported-on-this-platform: `,
      ),
    )
    const livePrompt = verify.events.findIndex((e) => e.startsWith("secret: Vault passphrase"))
    const v2 = verify.events.findIndex((e) =>
      e.includes(
        `${PASSPHRASE_ONLY_PREFIX}the factor that opened this vault is not in ${to} as it is now, and no security key in it can be used here, so the copy opens with the passphrase it was sealed under, which may predate a rotation.`,
      ),
    )
    const copyPrompt = verify.events.findIndex((e) => e.startsWith("secret: Passphrase this backup was sealed under"))
    expect(c1).toBeGreaterThan(-1)
    expect(livePrompt).toBeGreaterThan(c1)
    expect(v2).toBeGreaterThan(livePrompt)
    expect(copyPrompt).toBeGreaterThan(v2)
    expect(verify.stderr.text).toContain("Details: candle vault status")
  })

  test("F1: factor add security-key on a vault that already has one", async () => {
    const v = await vaultWithKey()
    const add = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [PIN, v.passphrase] })
    expect(
      await run(
        ["vault", "factor", "add", "security-key", "--label", "second key", "--keystore", v.vaultPath],
        add.deps,
      ),
    ).toBe(0)
    lineBeforePrompt(
      add,
      "this command's security key session is for the key being added, so the vault opens with the passphrase here.",
      "secret: Current vault passphrase",
    )
  })

  test("C1: no --factor, a key that cannot be driven here, on a plain unlock", async () => {
    const v = await vaultWithKey()
    const s = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [v.passphrase], helper: "absent" })
    expect(await run(["vault", "status", "--unlock", "--keystore", v.vaultPath], s.deps)).toBe(0)
    lineBeforePrompt(
      s,
      `no other factor on this vault can be used on this machine (${v.keyId} security key: unavailable-on-this-device: `,
    )
    expect(s.stderr.text).toContain("). Details: candle vault status")
  })

  test("no line on a passphrase-only vault, on init's re-prompt, or after the operator chose the passphrase", async () => {
    // A passphrase-only vault: every unlock, and a sealed backup of it, is silent.
    const only = await initVault()
    const { home, icloud } = await cloudHome()
    const s = await harness({ env: { CANDLE_CONFIG_DIR: only.dir }, secrets: [only.passphrase] })
    expect(await run(["vault", "status", "--unlock", "--keystore", only.vaultPath], s.deps)).toBe(0)
    expect(s.stderr.text).not.toContain(PASSPHRASE_ONLY_PREFIX)
    const b = await harness({ env: { CANDLE_CONFIG_DIR: only.dir, HOME: home }, secrets: [only.passphrase] })
    expect(await run(["vault", "backup", "--to", join(icloud, "only.enc"), "--keystore", only.vaultPath], b.deps)).toBe(
      0,
    )
    expect(b.stderr.text).toContain("so this backup is a sealed copy")
    expect(b.stderr.text).not.toContain(PASSPHRASE_ONLY_PREFIX)

    // init's re-prompt: the offer accepted, the passphrase asked again, no line.
    const init = await harness({ lines: ["", "", "yes", "no"] })
    init.deps.promptSecret = async (text: string) => {
      init.asked.push(`secret: ${text}`)
      init.events.push(`secret: ${text}`)
      return generatedPassphraseFrom(init.stdout.text)
    }
    await run(["vault", "init", "--keystore", init.vaultPath], init.deps)
    expect(init.asked.filter((a) => a.startsWith("secret:"))).toEqual([
      expect.stringContaining("Vault passphrase, again, to show the recovery phrase"),
    ])
    expect(init.stderr.text).not.toContain(PASSPHRASE_ONLY_PREFIX)

    // The chooser answered `passphrase`, and `--factor passphrase`: the operator chose it.
    const v = await vaultWithKey()
    const chose = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, lines: ["passphrase"], secrets: [v.passphrase] })
    expect(await run(["vault", "status", "--unlock", "--keystore", v.vaultPath], chose.deps)).toBe(0)
    expect(chose.stderr.text).not.toContain(PASSPHRASE_ONLY_PREFIX)
    const flagged = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [v.passphrase] })
    expect(
      await run(["vault", "status", "--unlock", "--factor", "passphrase", "--keystore", v.vaultPath], flagged.deps),
    ).toBe(0)
    expect(flagged.stderr.text).not.toContain(PASSPHRASE_ONLY_PREFIX)
    // And a sealed backup where the chooser was answered `passphrase`.
    const sealed = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir, HOME: home },
      lines: ["passphrase"],
      secrets: [v.passphrase],
    })
    expect(
      await run(["vault", "backup", "--to", join(icloud, "chose.enc"), "--keystore", v.vaultPath], sealed.deps),
    ).toBe(0)
    expect(sealed.stderr.text).not.toContain(PASSPHRASE_ONLY_PREFIX)
  })
})

describe("T13, T14, T18, T19, T20: old sealed copies, the floor check, and the sidecar binding", () => {
  test("T13: an old passphrase-only sealed copy verifies, names the key it lacks, and status advises a fresh backup", async () => {
    const v = await initVault()
    const { home, icloud } = await cloudHome()
    const to = join(icloud, "pre-change.enc")
    const b = await harness({ env: { CANDLE_CONFIG_DIR: v.dir, HOME: home }, secrets: [v.passphrase] })
    expect(await run(["vault", "backup", "--to", to, "--keystore", v.vaultPath], b.deps)).toBe(0)
    expect((await readVault(to)).envelopes.map((e) => e.factor)).toEqual(["passphrase"])
    const add = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [PIN, v.passphrase] })
    expect(await run(["vault", "factor", "add", "security-key", "--keystore", v.vaultPath], add.deps)).toBe(0)
    const keyId = ((await readVault(v.vaultPath)).envelopes.find((e) => e.factor === "passkey-prf") as { id: string })
      .id

    const verify = await harness({ env: { CANDLE_CONFIG_DIR: v.dir, HOME: home }, secrets: [v.passphrase] })
    expect(await run(["vault", "verify-backup", to, "--keystore", v.vaultPath], verify.deps)).toBe(0)
    expect(verify.stderr.text).toContain(`${PASSPHRASE_ONLY_PREFIX}${to} carries no security key envelope`)
    expect(verify.stdout.text).toContain(freshBackupAdvice(to, [keyId]))
    const json = await harness({ env: { CANDLE_CONFIG_DIR: v.dir, HOME: home }, secrets: [v.passphrase] })
    expect(await run(["vault", "verify-backup", to, "--json", "--keystore", v.vaultPath], json.deps)).toBe(0)
    expect(JSON.parse(json.stdout.text)).toMatchObject({
      ok: true,
      sealed: true,
      securityKeysNotInCopy: [keyId],
      passphraseExercised: true,
    })

    // A sidecar from before this change: `lastBackupSealed: true` and no ids.
    const path = sidecarPath(v.vaultPath)
    const stored = await readSidecar(path)
    if (stored === null) throw new Error("no sidecar")
    const {
      lastBackupAt: _a,
      lastBackupEnvelopeIds: _b,
      lastBackupEnvelopeIdsAt: _c,
      lastBackupIdsVerifiedAt: _d,
      ...old
    } = stored
    await writeSidecar(path, { ...old, lastBackupSealed: true })
    const status = await harness({ env: { CANDLE_CONFIG_DIR: v.dir } })
    expect(await run(["vault", "status", "--keystore", v.vaultPath], status.deps)).toBe(0)
    expect(status.stdout.text).toContain("sealed: opens with the passphrase only)")
    expect(status.stdout.text).toContain(
      `  fresh backup advised   the last sealed copy does not carry security key ${keyId}; a new \`candle vault backup\` to the same destination would open with it too.`,
    )
    expect(status.stdout.text).not.toContain(`security key ${keyId})`)
  })

  test("T14: assertFloorCarried refuses a copy header that lacks a live passphrase envelope, with the step named", () => {
    const p1 = passphraseFixture("p1")
    const k1 = securityKeyFixture("k1")
    expect(() => assertFloorCarried({ envelopes: [p1, k1] }, { envelopes: [p1, k1, syncedPasskey()] })).not.toThrow()
    let caught: unknown
    try {
      assertFloorCarried({ envelopes: [k1] }, { envelopes: [p1, k1] })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: "VAULT_VERIFY_FAILED", details: { step: "floor", missing: "p1" } })
    // Same id, different bytes: not carried.
    const edited = { ...p1, label: "renamed" } as Envelope
    expect(() => assertFloorCarried({ envelopes: [edited, k1] }, { envelopes: [p1, k1] })).toThrow(/byte for byte/)
  })

  test("the sealed-copy note, the B2 reason and the status lines are the spec's words", () => {
    expect(sealedCopyNote(["k1", "k2"])).toBe(
      "This copy opens with the passphrase it was sealed under, which may predate a passphrase rotation, or with security key k1, k2 (its PIN and a touch). Removing a key from this vault later does not remove it from this copy. It contains no synced passkey or Touch ID envelope. Keep the passphrase somewhere outside the Apple account that holds a synced passkey. The live vault plus the recovery phrase remain the everyday path; this copy is for the day both are gone.",
    )
    expect(sealedCopyNote([])).toContain("This vault had no security key for it to carry.")
    expect(sealedPassphraseOnlyReason([])).toContain(
      "this vault has no security key. Add one with: candle vault enroll security-key",
    )
    expect(
      sealedPassphraseOnlyReason([
        { id: "k1", word: "security key", availability: "unavailable-on-this-device: no helper" },
      ]),
    ).toBe(
      "a sealed copy opens with the passphrase or a security key, and security key k1 cannot be used on this machine: unavailable-on-this-device: no helper.",
    )
    const live = [passphraseFixture("p1"), securityKeyFixture("k1")]
    const bound = {
      vaultId: "v",
      lastGeneration: 1,
      envelopeIds: ["p1", "k1"],
      removedEnvelopeIds: [],
      lastVerifiedBackupAt: "2026-09-23T15:00:00.000Z",
      lastBackupDomain: "icloud-drive",
      lastBackupSealed: true,
      lastBackupAt: "2026-09-23T15:00:00.000Z",
      lastBackupEnvelopeIds: ["p1", "k1"],
      lastBackupEnvelopeIdsAt: "2026-09-23T15:00:00.000Z",
      lastBackupIdsVerifiedAt: "2026-09-23T15:00:00.000Z",
    }
    expect(lastBackupLines(bound, describeLastBackup(bound, live))).toEqual([
      "  last verified backup   2026-09-23T15:00:00.000Z (icloud-drive, sealed: opens with the passphrase or security key k1)",
    ])
    const unbound = { ...bound, lastVerifiedBackupAt: "2026-09-24T09:12:44.000Z" }
    expect(describeLastBackup(unbound, live).bound).toBe(false)
    expect(lastBackupLines(unbound, describeLastBackup(unbound, live))).toEqual([
      "  last verified backup   2026-09-24T09:12:44.000Z (icloud-drive, sealed: opens with the passphrase only)",
      "  fresh backup advised   the last sealed copy does not carry security key k1; a new `candle vault backup` to the same destination would open with it too.",
    ])
    // An unsealed, unbound record names nothing and advises nothing.
    const unsealed = { ...unbound, lastBackupSealed: false }
    expect(lastBackupLines(unsealed, describeLastBackup(unsealed, live))).toEqual([
      "  last verified backup   2026-09-24T09:12:44.000Z (icloud-drive)",
    ])
  })

  /** Writes the sidecar the way 0.11.5's `vault backup` does: unknown fields spread, three fields set. */
  async function backupLike0115(vaultPath: string, at: string): Promise<void> {
    const path = sidecarPath(vaultPath)
    const carried = await readSidecar(path)
    const file = JSON.parse(await readFile(vaultPath, "utf8")) as {
      vaultId: string
      generation: number
      envelopes: { id: string }[]
    }
    await writeSidecar(path, {
      ...nextSidecar(carried, file),
      lastVerifiedBackupAt: at,
      lastBackupDomain: "icloud-drive",
      lastBackupSealed: true,
    })
  }

  async function statusOf(v: { dir: string; vaultPath: string }) {
    const s = await harness({ env: { CANDLE_CONFIG_DIR: v.dir } })
    expect(await run(["vault", "status", "--keystore", v.vaultPath], s.deps)).toBe(0)
    const j = await harness({ env: { CANDLE_CONFIG_DIR: v.dir } })
    expect(await run(["vault", "status", "--json", "--keystore", v.vaultPath], j.deps)).toBe(0)
    return { text: s.stdout.text, sidecar: (JSON.parse(j.stdout.text) as { sidecar: Record<string, unknown> }).sidecar }
  }

  test("T18: a new-CLI backup binds the ids; a 0.11.5 backup after it unbinds them, and status stops naming the key", async () => {
    const v = await vaultWithKey()
    const { home, icloud } = await cloudHome()
    const b = await harness({ env: { CANDLE_CONFIG_DIR: v.dir, HOME: home }, secrets: [PIN] })
    expect(
      await run(
        ["vault", "backup", "--to", join(icloud, "t18.enc"), "--factor", "security-key", "--keystore", v.vaultPath],
        b.deps,
      ),
    ).toBe(0)
    const after = await readSidecar(sidecarPath(v.vaultPath))
    const stamp = after?.lastBackupAt as string
    expect(after).toMatchObject({
      lastBackupEnvelopeIdsAt: stamp,
      lastBackupIdsVerifiedAt: stamp,
      lastVerifiedBackupAt: stamp,
    })
    expect(after?.lastBackupEnvelopeIds).toContain(v.keyId)
    const bound = await statusOf(v)
    expect(bound.text).toContain(`sealed: opens with the passphrase or security key ${v.keyId})`)
    expect(bound.text).not.toContain("fresh backup advised")
    expect(bound.sidecar).toMatchObject({
      lastBackupEnvelopeIdsBound: true,
      lastBackupAt: stamp,
      lastBackupEnvelopeIds: after?.lastBackupEnvelopeIds,
    })

    await backupLike0115(v.vaultPath, "2099-01-01T00:00:00.000Z")
    const stale = await readSidecar(sidecarPath(v.vaultPath))
    expect(stale).toMatchObject({
      lastBackupAt: stamp,
      lastBackupEnvelopeIdsAt: stamp,
      lastBackupIdsVerifiedAt: stamp,
      lastVerifiedBackupAt: "2099-01-01T00:00:00.000Z",
    })
    const unbound = await statusOf(v)
    expect(unbound.text).toContain("2099-01-01T00:00:00.000Z (icloud-drive, sealed: opens with the passphrase only)")
    expect(unbound.text).toContain(`fresh backup advised   the last sealed copy does not carry security key ${v.keyId}`)
    expect(unbound.text).not.toContain(`security key ${v.keyId})`)
    expect(unbound.sidecar).toMatchObject({ lastBackupEnvelopeIdsBound: false })
  })

  test("T19: a routine verify-backup of the copy this CLI just wrote keeps the receipt bound", async () => {
    const v = await vaultWithKey()
    const { home, icloud } = await cloudHome()
    const to = join(icloud, "t19.enc")
    const b = await harness({ env: { CANDLE_CONFIG_DIR: v.dir, HOME: home }, secrets: [PIN] })
    expect(
      await run(["vault", "backup", "--to", to, "--factor", "security-key", "--keystore", v.vaultPath], b.deps),
    ).toBe(0)
    const after = await readSidecar(sidecarPath(v.vaultPath))
    const stamp = after?.lastBackupAt as string
    // A later clock, so the verify's new string is visibly new.
    const verify = await harness({ env: { CANDLE_CONFIG_DIR: v.dir, HOME: home }, secrets: [PIN] })
    verify.deps.now = () => Date.parse(stamp) + 60_000
    expect(
      await run(["vault", "verify-backup", to, "--factor", "security-key", "--keystore", v.vaultPath], verify.deps),
    ).toBe(0)
    const verified = await readSidecar(sidecarPath(v.vaultPath))
    const newStamp = verified?.lastVerifiedBackupAt as string
    expect(newStamp).not.toBe(stamp)
    expect(verified).toMatchObject({
      lastBackupAt: stamp,
      lastBackupEnvelopeIdsAt: stamp,
      lastBackupEnvelopeIds: after?.lastBackupEnvelopeIds,
      lastBackupIdsVerifiedAt: newStamp,
    })
    const status = await statusOf(v)
    expect(status.text).toContain(
      `${newStamp} (icloud-drive, sealed: opens with the passphrase or security key ${v.keyId})`,
    )
    expect(status.text).not.toContain("fresh backup advised")
    expect(status.sidecar).toMatchObject({ lastBackupEnvelopeIdsBound: true })
  })

  test("T20: a verify after a 0.11.5-shaped backup leaves the stamp alone, so the ids stay unbound", async () => {
    const v = await vaultWithKey()
    const { home, icloud } = await cloudHome()
    const to = join(icloud, "t20.enc")
    const b = await harness({ env: { CANDLE_CONFIG_DIR: v.dir, HOME: home }, secrets: [PIN] })
    expect(
      await run(["vault", "backup", "--to", to, "--factor", "security-key", "--keystore", v.vaultPath], b.deps),
    ).toBe(0)
    const stamp = (await readSidecar(sidecarPath(v.vaultPath)))?.lastBackupAt as string
    await backupLike0115(v.vaultPath, "2099-01-01T00:00:00.000Z")

    const verify = await harness({ env: { CANDLE_CONFIG_DIR: v.dir, HOME: home }, secrets: [PIN] })
    verify.deps.now = () => Date.parse("2099-01-02T00:00:00.000Z")
    expect(
      await run(["vault", "verify-backup", to, "--factor", "security-key", "--keystore", v.vaultPath], verify.deps),
    ).toBe(0)
    const after = await readSidecar(sidecarPath(v.vaultPath))
    expect(after).toMatchObject({
      lastVerifiedBackupAt: "2099-01-02T00:00:00.000Z",
      lastBackupAt: stamp,
      lastBackupEnvelopeIdsAt: stamp,
      lastBackupIdsVerifiedAt: stamp,
    })
    const status = await statusOf(v)
    expect(status.text).toContain("(icloud-drive, sealed: opens with the passphrase only)")
    expect(status.text).toContain(`fresh backup advised   the last sealed copy does not carry security key ${v.keyId}`)
    expect(status.text).not.toContain(`security key ${v.keyId})`)
    expect(status.sidecar).toMatchObject({ lastBackupEnvelopeIdsBound: false })
  })
})
