/**
 * Ember Phase 2 (BE-135, AD-2, AD-9, CC-03's platform passkey bullet, CC-12): the synced passkey
 * factor, end to end through `run()`, and AD-9's sealed cloud backups on a vault that carries one.
 *
 * The platform authenticator is scripted and everything else is real: the release policy gate,
 * the helper's location, the codesign requirement the CLI builds (the spawn is faked and its
 * arguments recorded), the AD-2 gates from the helper's `info`, the apple-app-site-association
 * fetch (a routed fake `fetch`, so every shape of a wrong deployment is exercised), the helper
 * protocol over a real pipe in the subprocess test, the CBOR attestation object, the HKDF
 * derivation, the vault write, the rollback, and the re-open with the new factor. What no script
 * can stand in for (what AuthenticationServices actually answers on a macOS 15 Mac with a
 * Developer ID helper, and whether such a helper gets associated domains at all) is T57's.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { base64 } from "@scure/base"
import type { CommandContext, Deps } from "../deps"
import {
  ENCLAVE_BUNDLE_NAME,
  ENCLAVE_EXECUTABLE_RELATIVE,
  type EnclaveResponse,
  handleEnclaveLine,
} from "../enclave-helper/protocol"
import { type EnclaveLogEntry, type EnclaveScript, scriptedEnclaveBackend } from "../enclave-helper/test-backend"
import { realSpawnHelper, run } from "../index"
import { createCapture, createTestDeps } from "../test-support"
import { AASA_URL, CODESIGN_PATH, codesignRequirement, ENCLAVE_HELPER_ENV, type ReleasePolicy } from "../vault/enclave"
import { trackSecrets } from "../vault/hygiene"
import { RELEASE_POLICY } from "../vault/release-policy"
import { readSidecar, sidecarPath } from "../vault/sidecar"
import { closeVault, unlockWithPassphrase } from "../vault/store"
import { generatedPassphraseFrom, useCheapKdf } from "../vault/test-vault"
import { unlockInteractively } from "./vault-support"

setDefaultTimeout(60_000)
useCheapKdf()

const TEAM = "ABCDE12345"
const BUNDLE = "tv.candle.cli.enclave"
const APP_ID = `${TEAM}.${BUNDLE}`
const SIGNED: ReleasePolicy = { macosHelper: { release: "signed", bundleId: BUNDLE, teamId: TEAM } }

interface AasaOptions {
  status?: number
  contentType?: string
  body?: unknown
  /** Throw from fetch, as an unreachable host does. */
  unreachable?: boolean
}

interface Harness {
  deps: Deps
  stdout: ReturnType<typeof createCapture>
  stderr: ReturnType<typeof createCapture>
  asked: string[]
  /** Every call that reached the scripted authenticator. */
  calls: EnclaveLogEntry[]
  /** Every codesign invocation's arguments. */
  codesign: string[][]
  /** The base64 PRF outputs the scripted helper handed back over the pipe (the canaries). */
  prfOutputs: string[]
  /** Every fetch the command made. */
  fetches: Array<{ url: string; init: RequestInit | undefined }>
  dir: string
  vaultPath: string
  script: EnclaveScript
  appPath: string
}

interface HarnessOptions {
  secrets?: string[]
  lines?: string[]
  env?: Record<string, string>
  tty?: boolean
  script?: Partial<EnclaveScript>
  helper?: "ready" | "absent"
  policy?: "omit" | "signed"
  codesign?: "pass" | "fail" | "missing"
  platform?: string
  arch?: string
  subprocess?: boolean
  aasa?: AasaOptions
  vaultFactor?: string
  /** Replaces the nth response of an op (1-based), for a proof that fails or a foreign helper. */
  tamper?: (op: string, nth: number, response: EnclaveResponse) => EnclaveResponse | undefined
}

async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = opts.env?.CANDLE_CONFIG_DIR ?? (await mkdtemp(join(tmpdir(), "candle-vault-pk-")))
  const stdout = createCapture()
  const stderr = createCapture()
  const asked: string[] = []
  const calls: EnclaveLogEntry[] = []
  const codesign: string[][] = []
  const prfOutputs: string[] = []
  const fetches: Harness["fetches"] = []
  const secrets = [...(opts.secrets ?? [])]
  const lines = [...(opts.lines ?? [])]
  const script: EnclaveScript = {
    version: "0.13.0",
    bundleId: BUNDLE,
    teamId: TEAM,
    secureEnclave: true,
    biometry: "available",
    biometryType: "touchID",
    osVersion: "15.1.0",
    associatedDomains: ["webcredentials:cli.candle.tv"],
    provisioningProfile: true,
    store: join(dir, "enclave-keys.json"),
    ...opts.script,
  }
  const env: Record<string, string> = { CANDLE_CONFIG_DIR: dir, ...(opts.env ?? {}) }
  const appPath = join(dir, ENCLAVE_BUNDLE_NAME)
  const executable = join(appPath, ENCLAVE_EXECUTABLE_RELATIVE)
  if ((opts.helper ?? "ready") === "ready") {
    await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true })
    if (opts.subprocess) {
      const scriptPath = join(dir, `script-${Math.random().toString(36).slice(2)}.json`)
      script.log = join(dir, "enclave.log")
      await writeFile(scriptPath, JSON.stringify(script))
      const scripted = join(import.meta.dir, "..", "enclave-helper", "scripted-helper.ts")
      await writeFile(executable, `#!/bin/sh\nexec bun "${scripted}" "${scriptPath}" "$@"\n`)
    } else {
      await writeFile(executable, "#!/bin/sh\nexit 1\n")
    }
    await chmod(executable, 0o755)
    env[ENCLAVE_HELPER_ENV] = appPath
  }
  const counts = new Map<string, number>()
  const spawnHelper: Deps["spawnHelper"] = async (path, line, o) => {
    if (path === CODESIGN_PATH) {
      codesign.push(o.args ?? [])
      const mode = opts.codesign ?? "pass"
      if (mode === "missing") return { stdout: "", stderr: "", exitCode: null, signal: null, spawnError: "ENOENT" }
      if (mode === "fail") {
        return {
          stdout: "",
          stderr: `${appPath}: code failed to satisfy specified code requirement(s)\n`,
          exitCode: 3,
          signal: null,
        }
      }
      return { stdout: "", stderr: "", exitCode: 0, signal: null }
    }
    if (opts.subprocess) return realSpawnHelper(path, line, o)
    let response = await handleEnclaveLine(line, () => scriptedEnclaveBackend(script, (entry) => calls.push(entry)))
    const op = (JSON.parse(line) as { op: string }).op
    const nth = (counts.get(op) ?? 0) + 1
    counts.set(op, nth)
    response = opts.tamper?.(op, nth, response) ?? response
    if (response.ok && response.op === "passkey-assert") prfOutputs.push(response.prfOutput)
    return { stdout: `${JSON.stringify(response)}\n`, stderr: "", exitCode: response.ok ? 0 : 1, signal: null }
  }
  const aasa = opts.aasa ?? {}
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    fetches.push({ url, init })
    if (url !== AASA_URL) throw new Error(`unexpected fetch ${url}`)
    if (aasa.unreachable) throw new TypeError("fetch failed: getaddrinfo ENOTFOUND cli.candle.tv")
    const status = aasa.status ?? 200
    const body = aasa.body === undefined ? { webcredentials: { apps: [APP_ID] } } : aasa.body
    return new Response(
      status === 204 || status === 304 ? null : typeof body === "string" ? body : JSON.stringify(body),
      {
        status,
        headers: { "content-type": aasa.contentType ?? "application/json" },
      },
    )
  }) as unknown as typeof fetch
  const deps = createTestDeps({
    fetch: fetchFn,
    stdout,
    stderr,
    env,
    platform: opts.platform ?? "darwin",
    arch: opts.arch ?? "arm64",
    isTTY: { stdin: opts.tty ?? true, stdout: opts.tty ?? true },
    spawnHelper,
    releasePolicy: (opts.policy ?? "signed") === "signed" ? SIGNED : RELEASE_POLICY,
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
  return {
    deps,
    stdout,
    stderr,
    asked,
    calls,
    codesign,
    prfOutputs,
    fetches,
    dir,
    vaultPath: join(dir, "vault.enc"),
    script,
    appPath,
  }
}

async function initVault(opts: HarnessOptions = {}): Promise<Harness & { passphrase: string }> {
  const h = await harness({ lines: ["no"], ...opts })
  h.deps.promptSecret = async (text: string) => {
    h.asked.push(`secret: ${text}`)
    return generatedPassphraseFrom(h.stdout.text)
  }
  const code = await run(["vault", "init", "--keystore", h.vaultPath], h.deps)
  if (code !== 0) throw new Error(`init failed (${code}): ${h.stderr.text}${h.stdout.text}`)
  return { ...h, passphrase: generatedPassphraseFrom(h.stdout.text) }
}

interface VaultJson {
  vaultId: string
  generation: number
  index: { ciphertext: string }
  root: { ciphertext: string }
  envelopes: Array<Record<string, unknown> & { id: string; factor: string }>
  keys: Array<{ ciphertext: string }>
}

async function readVault(path: string): Promise<VaultJson> {
  return JSON.parse(await readFile(path, "utf8")) as VaultJson
}

/** Adds the scripted synced passkey to a fresh vault and returns everything a later test needs. */
async function vaultWithPasskey(opts: Partial<HarnessOptions> = {}) {
  const v = await initVault(opts)
  const add = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [v.passphrase], ...opts })
  const code = await run(
    ["vault", "factor", "add", "passkey", "--label", "my passkey", "--keystore", v.vaultPath],
    add.deps,
  )
  if (code !== 0) throw new Error(`factor add passkey failed (${code}): ${add.stderr.text}${add.stdout.text}`)
  const file = await readVault(v.vaultPath)
  const envelope = file.envelopes.find(
    (candidate) => candidate.factor === "passkey-prf",
  ) as VaultJson["envelopes"][number]
  return { ...v, add, envelopeId: envelope.id, envelope }
}

/** The last JSON line on stdout: a harness reused for two commands has two. */
function failure(h: Harness): { code: string; message: string; suggestion?: string } {
  const lines = h.stdout.text.trim().split("\n")
  return JSON.parse(lines[lines.length - 1] as string) as { code: string; message: string; suggestion?: string }
}

function ops(h: Harness): string[] {
  return h.calls.map((call) => call.op)
}

describe("factor add passkey: the ceremony", () => {
  test("registers, derives, writes only the index, and re-opens with the passkey before reporting: three sheets", async () => {
    const v = await initVault()
    const before = await readVault(v.vaultPath)
    const add = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [v.passphrase] })
    const tracking = trackSecrets()
    const code = await run(
      ["vault", "factor", "add", "passkey", "--label", "my passkey", "--keystore", v.vaultPath],
      add.deps,
    )
    const secretsAllocated = tracking.stop()
    expect(`${code} ${add.stderr.text}`).toStartWith("0 ")
    expect(add.stdout.text).toContain("Added synced passkey factor")
    expect(add.stdout.text).toContain("domain     apple-account (backup-eligible: yes, backed up now: yes)")
    expect(add.stdout.text).toContain("verified   the vault was re-read and opened with the new passkey")
    expect(add.stdout.text).toContain("A synced passkey lives in your Apple account")
    expect(add.stdout.text).toContain("2 recoverable factor(s)")

    // The passphrase was asked once, after every gate, and nothing else was prompted.
    expect(add.asked).toEqual(["secret: Current vault passphrase, to unlock (input hidden): "])
    // The AASA was fetched once, without following redirects, before the passphrase.
    expect(add.fetches).toHaveLength(1)
    expect(add.fetches[0]?.url).toBe(AASA_URL)
    expect(add.fetches[0]?.init?.redirect).toBe("manual")

    // The codesign requirement pinned the policy's team id and bundle id, by absolute path.
    expect(add.codesign.length).toBeGreaterThan(0)
    for (const args of add.codesign) {
      expect(args.slice(0, 4)).toEqual(["--verify", "--strict", "--deep", "-R"])
      expect(args[4]).toBe(codesignRequirement({ teamId: TEAM, bundleId: BUNDLE }))
      expect(args[5]).toBe(add.appPath)
    }

    // One registration, then exactly two assertions: the derivation and the proof, in that order,
    // each announced on stderr with what the sheet is for.
    expect(ops(add).filter((op) => op !== "info")).toEqual(["passkey-register", "passkey-assert", "passkey-assert"])
    expect(add.stderr.text).toContain("Confirm in the passkey sheet to create this vault's synced passkey")
    expect(add.stderr.text).toContain("Confirm the synced passkey to derive this vault's key on it.")
    expect(add.stderr.text).toContain("Confirm the synced passkey to prove the new synced passkey opens the vault.")
    const asserts = add.calls.filter((call) => call.op === "passkey-assert")
    expect(asserts[0]?.credentialId).toBe(asserts[1]?.credentialId)
    expect(asserts[0]?.prfSalt).toBe(asserts[1]?.prfSalt)

    // The envelope, as CC-01's row says; the index re-encrypted; root and key blobs untouched.
    const after = await readVault(v.vaultPath)
    expect(after.generation).toBe(before.generation + 1)
    expect(after.index.ciphertext).not.toBe(before.index.ciphertext)
    expect(after.root.ciphertext).toBe(before.root.ciphertext)
    expect(after.envelopes).toHaveLength(2)
    const envelope = after.envelopes.find((candidate) => candidate.factor === "passkey-prf") as Record<string, unknown>
    expect(envelope).toMatchObject({
      factor: "passkey-prf",
      transport: "platform-macos",
      domain: "apple-account",
      label: "my passkey",
      rpId: "cli.candle.tv",
      userVerification: "required",
      backupEligible: true,
      backupState: true,
      saltDerivation: "platform",
      helper: { teamId: TEAM, bundleId: BUNDLE, minVersion: "0.13.0" },
    })
    expect(Object.keys(envelope).sort()).toEqual(
      [
        "backupEligible",
        "backupState",
        "createdAt",
        "credentialId",
        "domain",
        "factor",
        "helper",
        "id",
        "label",
        "prfSalt",
        "rpId",
        "saltDerivation",
        "transport",
        "userVerification",
        "wrap",
      ].sort(),
    )
    // The raw salt the helper was handed is the envelope's, unhashed (saltDerivation: platform).
    const { hex } = await import("@scure/base")
    const { unb64u } = await import("../vault/crypto")
    expect(asserts[0]?.prfSalt).toBe(hex.encode(unb64u(envelope.prfSalt, "prfSalt")))
    expect(unb64u(envelope.prfSalt, "prfSalt")).toHaveLength(32)

    // Every tracked secret (PRF outputs, DEK) is zero afterwards (T36).
    for (const buffer of secretsAllocated) expect(buffer.every((byte) => byte === 0)).toBe(true)
  })

  test("the same ceremony over a real subprocess through the real spawn seam, and an unlock in a later process", async () => {
    const v = await initVault({ subprocess: true })
    const add = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [v.passphrase], subprocess: true })
    const code = await run(["vault", "factor", "add", "passkey", "--keystore", v.vaultPath], add.deps)
    expect(`${code} ${add.stderr.text}`).toStartWith("0 ")
    const log = (await readFile(add.script.log as string, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as EnclaveLogEntry)
    expect(log.map((entry) => entry.op)).toEqual([
      "info",
      "info",
      "passkey-register",
      "passkey-assert",
      "passkey-assert",
    ])

    const later = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      subprocess: true,
      script: { store: add.script.store },
    })
    expect(
      await run(["vault", "status", "--unlock", "--factor", "passkey", "--keystore", v.vaultPath], later.deps),
    ).toBe(0)
    expect(later.asked).toEqual([])
    expect(later.fetches).toEqual([])
    expect(later.stdout.text).toContain("Keys (0)")
  })

  test("no secret reaches stdout, stderr, --json or the file: the PRF output is the canary", async () => {
    const v = await initVault()
    const add = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [v.passphrase] })
    expect(await run(["vault", "factor", "add", "passkey", "--json", "--keystore", v.vaultPath], add.deps)).toBe(0)
    expect(add.prfOutputs).toHaveLength(2)
    const file = await readFile(v.vaultPath, "utf8")
    const { base64urlnopad } = await import("@scure/base")
    for (const output of add.prfOutputs) {
      const raw = base64.decode(output)
      for (const form of [output, base64urlnopad.encode(raw), Buffer.from(raw).toString("hex")]) {
        expect(add.stdout.text).not.toContain(form)
        expect(add.stderr.text).not.toContain(form)
        expect(file).not.toContain(form)
      }
    }
    const body = JSON.parse(add.stdout.text) as Record<string, unknown>
    expect(body).toMatchObject({
      ok: true,
      factor: "passkey-prf",
      transport: "platform-macos",
      domain: "apple-account",
      appId: APP_ID,
      backupEligible: true,
      saltDerivation: "platform",
      recoverableFactors: 2,
      verified: true,
    })
    expect(add.stdout.text).not.toContain(v.passphrase)
  })

  test("PRF unsupported at registration is VAULT_PRF_UNSUPPORTED, nothing written, the leftover passkey named", async () => {
    const v = await initVault()
    const before = await readVault(v.vaultPath)
    const add = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [v.passphrase],
      script: { passkey: { prfSupported: false } },
    })
    expect(await run(["vault", "factor", "add", "passkey", "--json", "--keystore", v.vaultPath], add.deps)).toBe(1)
    expect(failure(add)).toMatchObject({ code: "VAULT_PRF_UNSUPPORTED" })
    expect(failure(add).suggestion).toContain("remains in your Passwords")
    expect(failure(add).suggestion).toContain("Nothing was written")
    expect(ops(add).filter((op) => op !== "info")).toEqual(["passkey-register"])
    expect(await readVault(v.vaultPath)).toEqual(before)
  })

  test("a credential the platform reports as not synced (BE clear) is refused, not recorded under apple-account", async () => {
    const v = await initVault()
    const before = await readVault(v.vaultPath)
    const add = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [v.passphrase],
      script: { passkey: { backupEligible: false, backupState: false } },
    })
    expect(await run(["vault", "factor", "add", "passkey", "--json", "--keystore", v.vaultPath], add.deps)).toBe(1)
    expect(failure(add)).toMatchObject({ code: "VAULT_FACTOR_UNAVAILABLE" })
    expect(failure(add).message).toContain("not backup-eligible")
    expect(failure(add).suggestion).toContain("iCloud Keychain")
    expect(ops(add).filter((op) => op !== "info")).toEqual(["passkey-register"])
    expect(await readVault(v.vaultPath)).toEqual(before)
  })

  test("an assertion made without user verification is refused before anything is derived", async () => {
    const v = await initVault()
    const before = await readVault(v.vaultPath)
    const add = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [v.passphrase],
      script: { passkey: { userVerified: false } },
    })
    expect(await run(["vault", "factor", "add", "passkey", "--json", "--keystore", v.vaultPath], add.deps)).toBe(1)
    expect(failure(add)).toMatchObject({ code: "VAULT_UNLOCK_FAILED" })
    expect(failure(add).message).toContain("UV flag is clear")
    expect(await readVault(v.vaultPath)).toEqual(before)
  })

  test("a failed proof rolls the envelope back out of the file, and a retry succeeds", async () => {
    const v = await initVault()
    const before = await readVault(v.vaultPath)
    const add = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [v.passphrase],
      // The second assertion (the proof) answers a different PRF output: the unwrap fails its tag.
      tamper: (op, nth, response) =>
        op === "passkey-assert" && nth === 2 && response.ok && response.op === "passkey-assert"
          ? { ...response, prfOutput: base64.encode(new Uint8Array(32).fill(0x42)) }
          : undefined,
    })
    expect(await run(["vault", "factor", "add", "passkey", "--json", "--keystore", v.vaultPath], add.deps)).toBe(1)
    expect(failure(add)).toMatchObject({ code: "VAULT_UNLOCK_FAILED" })
    expect(failure(add).message).toContain("synced passkey")
    const after = await readVault(v.vaultPath)
    expect(after.envelopes.map((envelope) => envelope.id)).toEqual(before.envelopes.map((envelope) => envelope.id))
    expect(after.generation).toBe(before.generation + 2)
    expect(after.root.ciphertext).toBe(before.root.ciphertext)
    expect(add.stderr.text).toContain("was removed from the vault again")
    expect(add.stderr.text).toContain("remains in your Passwords")

    const retry = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [v.passphrase],
      script: { store: add.script.store },
    })
    expect(await run(["vault", "factor", "add", "passkey", "--keystore", v.vaultPath], retry.deps)).toBe(0)
    expect((await readVault(v.vaultPath)).envelopes).toHaveLength(2)
  })

  test("a cancelled sheet is VAULT_AUTHENTICATOR_CANCELLED with nothing written", async () => {
    const v = await initVault()
    const before = await readVault(v.vaultPath)
    const add = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [v.passphrase],
      script: { fail: { passkeyRegister: { code: "CANCELLED", message: "ASAuthorizationError 1001: canceled" } } },
    })
    expect(await run(["vault", "factor", "add", "passkey", "--json", "--keystore", v.vaultPath], add.deps)).toBe(1)
    expect(failure(add)).toMatchObject({ code: "VAULT_AUTHENTICATOR_CANCELLED" })
    expect(await readVault(v.vaultPath)).toEqual(before)
  })

  test("needs a terminal for the passphrase", async () => {
    const v = await initVault()
    const add = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, tty: false })
    expect(await run(["vault", "factor", "add", "passkey", "--json", "--keystore", v.vaultPath], add.deps)).toBe(1)
    expect(failure(add).message).toContain("needs a terminal")
    expect(add.calls).toEqual([])
  })
})

describe("factor add passkey: every gate is a typed refusal, before the passphrase, and substitutes nothing", () => {
  const rows: Array<{ name: string; opts: HarnessOptions; code: string; message: string; helperRun: boolean }> = [
    {
      name: "the release policy omits the signed helper (the state until Apple approves): names 0.13.0",
      opts: { policy: "omit" },
      code: "VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM",
      message: "release policy omits the signed macOS helper",
      helperRun: false,
    },
    {
      name: "Linux, even with a signed policy and a helper on disk",
      opts: { platform: "linux", arch: "x64" },
      code: "VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM",
      message: "macOS only",
      helperRun: false,
    },
    {
      name: "no helper bundle on this Mac",
      opts: { helper: "absent" },
      code: "VAULT_HELPER_MISSING",
      message: "npm package",
      helperRun: false,
    },
    {
      name: "a helper that fails the codesign requirement",
      opts: { codesign: "fail" },
      code: "VAULT_HELPER_UNTRUSTED",
      message: `code signature check for team ${TEAM} and bundle id ${BUNDLE}`,
      helperRun: false,
    },
    {
      name: "a helper whose own signature names another team",
      opts: { script: { teamId: "ZZZZZ99999" } },
      code: "VAULT_HELPER_UNTRUSTED",
      message: "reports team ZZZZZ99999",
      helperRun: true,
    },
    {
      name: "macOS 14 (the platform PRF extension arrived in 15)",
      opts: { script: { osVersion: "14.7.1" } },
      code: "VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM",
      message: "needs macOS 15 or later",
      helperRun: true,
    },
    {
      name: "a PR F helper that reports no OS version",
      opts: { script: { osVersion: undefined } },
      code: "VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM",
      message: "does not report the macOS version",
      helperRun: true,
    },
    {
      name: "a helper without the associated-domains entitlement",
      opts: { script: { associatedDomains: [] } },
      code: "VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM",
      message: "lacks the associated-domains entitlement for webcredentials:cli.candle.tv",
      helperRun: true,
    },
    {
      name: "a helper entitled for another domain",
      opts: { script: { associatedDomains: ["webcredentials:example.com"] } },
      code: "VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM",
      message: "its entitlements list webcredentials:example.com",
      helperRun: true,
    },
    {
      name: "a helper without an embedded provisioning profile",
      opts: { script: { provisioningProfile: false } },
      code: "VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM",
      message: "embeds no provisioning profile",
      helperRun: true,
    },
  ]
  for (const row of rows) {
    test(row.name, async () => {
      const v = await initVault(row.opts)
      const before = await readVault(v.vaultPath)
      const add = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, ...row.opts })
      expect(await run(["vault", "factor", "add", "passkey", "--json", "--keystore", v.vaultPath], add.deps)).toBe(1)
      const refusal = failure(add)
      expect(refusal.code).toBe(row.code)
      expect(refusal.message).toContain(row.message)
      expect(`${refusal.message} ${refusal.suggestion ?? ""}`).toMatch(/[Nn]o other factor is substituted/)
      expect(add.asked).toEqual([])
      expect(add.fetches).toEqual([])
      expect(ops(add)).not.toContain("passkey-register")
      if (!row.helperRun) expect(add.calls).toEqual([])
      expect(await readVault(v.vaultPath)).toEqual(before)
      if (row.opts.policy === "omit" && (row.opts.platform ?? "darwin") === "darwin")
        expect(refusal.message).toContain("0.13.0")
    })
  }

  test("under omit nothing about Touch ID or the security key changes, and the passkey envelope is listed not-in-this-build", async () => {
    const v = await initVault({ policy: "omit" })
    const list = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, policy: "omit" })
    expect(await run(["vault", "factor", "list", "--json", "--keystore", v.vaultPath], list.deps)).toBe(0)
    expect(list.calls).toEqual([])
    const touchId = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, policy: "omit" })
    expect(await run(["vault", "factor", "add", "touch-id", "--json", "--keystore", v.vaultPath], touchId.deps)).toBe(1)
    expect(failure(touchId).message).toContain("0.12.0")
  })
})

describe("factor add passkey: the apple-app-site-association is checked before the passphrase", () => {
  const rows: Array<{ name: string; aasa: AasaOptions; detail: string }> = [
    { name: "unreachable", aasa: { unreachable: true }, detail: "could not be fetched" },
    { name: "a redirect", aasa: { status: 301 }, detail: "redirects" },
    { name: "a 404", aasa: { status: 404 }, detail: "answered status 404" },
    {
      name: "served as text/html",
      aasa: { contentType: "text/html; charset=utf-8" },
      detail: "is served as text/html, not application/json",
    },
    { name: "not JSON", aasa: { body: "<html>" }, detail: "is not valid JSON" },
    {
      name: "no webcredentials.apps list",
      aasa: { body: { applinks: {} } },
      detail: "has no webcredentials.apps list",
    },
    {
      name: "listing another app",
      aasa: { body: { webcredentials: { apps: ["OTHER12345.tv.candle.other"] } } },
      detail: `lists OTHER12345.tv.candle.other under webcredentials.apps, not ${APP_ID}`,
    },
    { name: "listing no app", aasa: { body: { webcredentials: { apps: [] } } }, detail: "lists no application" },
  ]
  for (const row of rows) {
    test(`${row.name}: VAULT_FACTOR_UNAVAILABLE naming what must be served, no passphrase, no sheet`, async () => {
      const v = await initVault()
      const before = await readVault(v.vaultPath)
      const add = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, aasa: row.aasa })
      expect(await run(["vault", "factor", "add", "passkey", "--json", "--keystore", v.vaultPath], add.deps)).toBe(1)
      const refusal = failure(add)
      expect(refusal.code).toBe("VAULT_FACTOR_UNAVAILABLE")
      expect(refusal.message).toContain(row.detail)
      // Exactly what must be served, in the refusal itself (constraint 2).
      expect(refusal.message).toContain(
        `The domain must serve ${AASA_URL} over HTTPS with status 200, no redirect, Content-Type application/json`,
      )
      expect(refusal.message).toContain('{"webcredentials":{"apps":["<TEAM ID>.<bundle id>"]}}')
      expect(refusal.message).toContain(`This build's helper is ${APP_ID}`)
      expect(refusal.suggestion).toContain("deployment prerequisite")
      expect(refusal.suggestion).toMatch(/[Nn]o other factor is substituted/)
      expect(add.asked).toEqual([])
      expect(ops(add)).not.toContain("passkey-register")
      expect(await readVault(v.vaultPath)).toEqual(before)
    })
  }

  test("a parameterised content type is accepted, and a later unlock never fetches", async () => {
    const v = await initVault()
    const add = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [v.passphrase],
      aasa: { contentType: "application/json; charset=utf-8" },
    })
    expect(await run(["vault", "factor", "add", "passkey", "--keystore", v.vaultPath], add.deps)).toBe(0)
    const later = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      script: { store: add.script.store },
      aasa: { unreachable: true },
    })
    expect(
      await run(["vault", "status", "--unlock", "--factor", "passkey", "--keystore", v.vaultPath], later.deps),
    ).toBe(0)
    expect(later.fetches).toEqual([])
  })
})

describe("unlocking with a synced passkey", () => {
  test("--factor passkey and --factor <id> drive the envelope with one sheet naming the operation; new-key re-opens (two sheets)", async () => {
    const t = await vaultWithPasskey()
    const byKind = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, script: { store: t.add.script.store } })
    expect(
      await run(
        ["vault", "status", "--unlock", "--factor", "passkey", "--json", "--keystore", t.vaultPath],
        byKind.deps,
      ),
    ).toBe(0)
    expect(byKind.asked).toEqual([])
    expect(ops(byKind).filter((op) => op !== "info")).toEqual(["passkey-assert"])
    expect(byKind.stderr.text).toContain("Confirm the synced passkey to unlock the Candle vault.")
    // At unlock the requirement pins what the ENVELOPE recorded.
    for (const args of byKind.codesign) expect(args[4]).toBe(codesignRequirement({ teamId: TEAM, bundleId: BUNDLE }))

    const byId = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, script: { store: t.add.script.store } })
    expect(
      await run(
        [
          "vault",
          "new-key",
          "--chain",
          "solana",
          "--label",
          "cold",
          "--factor",
          t.envelopeId,
          "--keystore",
          t.vaultPath,
        ],
        byId.deps,
      ),
    ).toBe(0)
    expect(byId.asked).toEqual([])
    expect(ops(byId).filter((op) => op === "passkey-assert")).toHaveLength(2)
    expect(byId.stdout.text).toMatch(/[1-9A-HJ-NP-Za-km-z]{32,44}/)
  })

  test("confirm names the operation on stderr before the second sheet", async () => {
    const t = await vaultWithPasskey()
    const h = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, script: { store: t.add.script.store } })
    const ctx = {
      deps: h.deps,
      json: false,
      apiUrl: "http://unused.invalid",
      vaultFactor: "passkey",
    } as unknown as CommandContext
    const raw = await readFile(t.vaultPath, "utf8")
    const opened = await unlockInteractively(ctx, t.vaultPath, raw)
    expect(opened.factor.kind).toBe("passkey")
    await opened.confirm("sign transfer of 1.5 SOL to 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin")
    closeVault(opened.vault)
    expect(ops(h).filter((op) => op === "passkey-assert")).toHaveLength(2)
    expect(h.stderr.text).toContain("Confirm the synced passkey to unlock the Candle vault.")
    expect(h.stderr.text).toContain(
      "Confirm the synced passkey to sign transfer of 1.5 SOL to 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin.",
    )
  })

  test("with a passphrase and a passkey both drivable and no --factor, the operator is asked which", async () => {
    const t = await vaultWithPasskey()
    const chosen = await harness({
      env: { CANDLE_CONFIG_DIR: t.dir },
      script: { store: t.add.script.store },
      lines: [t.envelopeId],
    })
    expect(await run(["vault", "status", "--unlock", "--keystore", t.vaultPath], chosen.deps)).toBe(0)
    expect(chosen.asked[0]).toContain("This vault opens with a passphrase or a synced passkey.")
    expect(chosen.asked[0]).toContain(`${t.envelopeId}  synced passkey  my passkey`)
    expect(ops(chosen)).toContain("passkey-assert")

    const typed = await harness({
      env: { CANDLE_CONFIG_DIR: t.dir },
      script: { store: t.add.script.store },
      lines: ["passphrase"],
      secrets: [t.passphrase],
    })
    expect(await run(["vault", "status", "--unlock", "--keystore", t.vaultPath], typed.deps)).toBe(0)
    expect(ops(typed)).not.toContain("passkey-assert")
  })

  test("passkey refusals at unlock are typed, say what must be served for a domain failure, and never retry the passphrase", async () => {
    const t = await vaultWithPasskey()
    const rows: Array<{ fail: { code: string; message: string }; code: string; message: string }> = [
      {
        fail: { code: "NO_CREDENTIAL", message: "No credentials available for login." },
        code: "VAULT_CREDENTIAL_NOT_PRESENT",
        message: "No synced passkey with this envelope's credential id",
      },
      {
        fail: {
          code: "DOMAIN_NOT_ASSOCIATED",
          message: "Application with identifier X is not associated with domain cli.candle.tv",
        },
        code: "VAULT_FACTOR_UNAVAILABLE",
        message: `The domain must serve ${AASA_URL}`,
      },
      {
        fail: { code: "CANCELLED", message: "ASAuthorizationError 1001: canceled" },
        code: "VAULT_AUTHENTICATOR_CANCELLED",
        message: "did not complete",
      },
      {
        fail: { code: "NOT_INTERACTIVE", message: "ASAuthorizationError 1005: not interactive" },
        code: "VAULT_FACTOR_UNAVAILABLE",
        message: "not available from this session",
      },
      {
        fail: { code: "PASSKEY_UNSUPPORTED", message: "the platform passkey API needs macOS 15" },
        code: "VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM",
        message: "platform passkey API is not available",
      },
      {
        fail: { code: "PRF_UNSUPPORTED", message: "no PRF output" },
        code: "VAULT_PRF_UNSUPPORTED",
        message: "cannot serve this factor",
      },
      { fail: { code: "SOMETHING_NEW", message: "?" }, code: "VAULT_UNLOCK_FAILED", message: "reported SOMETHING_NEW" },
    ]
    for (const row of rows) {
      const h = await harness({
        env: { CANDLE_CONFIG_DIR: t.dir },
        script: {
          store: t.add.script.store,
          fail: { passkeyAssert: row.fail as { code: "CANCELLED"; message: string } },
        },
      })
      expect(
        await run(["vault", "status", "--unlock", "--factor", "passkey", "--json", "--keystore", t.vaultPath], h.deps),
      ).toBe(1)
      expect(failure(h).code).toBe(row.code)
      expect(failure(h).message).toContain(row.message)
      expect(`${failure(h).message} ${failure(h).suggestion ?? ""}`).toMatch(
        /[Nn]o other factor (was tried|is substituted)/,
      )
      expect(h.asked).toEqual([])
    }
  })

  test("at unlock the AD-2 gates are re-checked from the helper's report, and an envelope whose helper identity was edited is refused before any spawn", async () => {
    const t = await vaultWithPasskey()
    const older = await harness({
      env: { CANDLE_CONFIG_DIR: t.dir },
      script: { store: t.add.script.store, osVersion: "14.7.1" },
    })
    expect(
      await run(
        ["vault", "status", "--unlock", "--factor", "passkey", "--json", "--keystore", t.vaultPath],
        older.deps,
      ),
    ).toBe(1)
    expect(failure(older)).toMatchObject({ code: "VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM" })
    expect(failure(older).message).toContain("macOS 15")
    expect(older.asked).toEqual([])

    // The listing says the same thing without a prompt.
    const listed = await harness({
      env: { CANDLE_CONFIG_DIR: t.dir },
      script: { store: t.add.script.store, associatedDomains: [] },
    })
    expect(await run(["vault", "status", "--json", "--keystore", t.vaultPath], listed.deps)).toBe(0)
    const status = JSON.parse(listed.stdout.text) as {
      envelopes: Array<{ id: string; availability: string; availabilityReason?: string }>
    }
    expect(status.envelopes.find((e) => e.id === t.envelopeId)?.availability).toBe("unsupported-on-this-platform")
    expect(status.envelopes.find((e) => e.id === t.envelopeId)?.availabilityReason).toContain(
      "associated-domains entitlement",
    )

    // An edited helper.teamId is refused before codesign or any helper operation.
    const file = await readVault(t.vaultPath)
    const envelope = file.envelopes.find((e) => e.id === t.envelopeId) as Record<string, unknown>
    envelope.helper = { ...(envelope.helper as Record<string, string>), teamId: "ZZZZZ99999" }
    await writeFile(t.vaultPath, JSON.stringify(file, null, 2))
    const edited = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, script: { store: t.add.script.store } })
    expect(
      await run(
        ["vault", "status", "--unlock", "--factor", "passkey", "--json", "--keystore", t.vaultPath],
        edited.deps,
      ),
    ).toBe(1)
    expect(failure(edited)).toMatchObject({ code: "VAULT_HELPER_UNTRUSTED" })
    expect(edited.codesign).toEqual([])
    expect(edited.calls).toEqual([])
    expect(failure(edited).message).toContain(`ZZZZZ99999 / ${BUNDLE}`)
    expect(failure(edited).message).toContain(`${TEAM} / ${BUNDLE}`)
    expect(ops(edited)).not.toContain("passkey-assert")
  })

  test("status and factor list report availability per machine; a Linux host keeps the envelope and opens with the passphrase (T42)", async () => {
    const t = await vaultWithPasskey()
    const linux = await harness({
      env: { CANDLE_CONFIG_DIR: t.dir },
      platform: "linux",
      arch: "x64",
      secrets: [t.passphrase],
    })
    expect(await run(["vault", "status", "--unlock", "--json", "--keystore", t.vaultPath], linux.deps)).toBe(0)
    const status = JSON.parse(linux.stdout.text) as {
      envelopes: Array<{ id: string; availability: string; availabilityReason?: string }>
      recoverableFactors: number
    }
    const synced = status.envelopes.find((e) => e.id === t.envelopeId)
    expect(synced?.availability).toBe("unsupported-on-this-platform")
    expect(synced?.availabilityReason).toContain("macOS only")
    expect(status.recoverableFactors).toBe(2)
    expect(linux.asked).toEqual([expect.stringContaining("Vault passphrase")])
    expect(linux.calls).toEqual([])

    const explicit = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, platform: "linux", arch: "x64" })
    expect(
      await run(
        ["vault", "status", "--unlock", "--factor", t.envelopeId, "--json", "--keystore", t.vaultPath],
        explicit.deps,
      ),
    ).toBe(1)
    expect(failure(explicit)).toMatchObject({ code: "VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM" })
    expect(explicit.asked).toEqual([])
  })

  test("two synced passkeys count as ONE recoverable factor (AD-2), and the passkey envelope can be removed", async () => {
    const t = await vaultWithPasskey()
    const second = await harness({
      env: { CANDLE_CONFIG_DIR: t.dir },
      secrets: [t.passphrase],
      script: { store: t.add.script.store },
    })
    expect(await run(["vault", "factor", "add", "passkey", "--json", "--keystore", t.vaultPath], second.deps)).toBe(0)
    expect(JSON.parse(second.stdout.text)).toMatchObject({ recoverableFactors: 2 })
    const remove = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, secrets: [t.passphrase] })
    expect(
      await run(
        ["vault", "factor", "remove", t.envelopeId, "--factor", "passphrase", "--json", "--keystore", t.vaultPath],
        remove.deps,
      ),
    ).toBe(0)
    expect((await readVault(t.vaultPath)).envelopes).toHaveLength(2)
  })
})

describe("AD-9: sealed cloud backups", () => {
  async function icloudPath(dir: string, name: string): Promise<string> {
    const cloud = join(dir, "..", "Library", "Mobile Documents", "com~apple~CloudDocs")
    await mkdir(cloud, { recursive: true })
    return join(cloud, name)
  }

  test("a backup to iCloud Drive writes a sealed copy: passphrase envelope only, verified with the passphrase, the output says so", async () => {
    const t = await vaultWithPasskey()
    const keyed = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, secrets: [t.passphrase] })
    expect(
      await run(
        ["vault", "new-key", "--chain", "solana", "--factor", "passphrase", "--keystore", t.vaultPath],
        keyed.deps,
      ),
    ).toBe(0)
    const live = await readVault(t.vaultPath)
    const to = await icloudPath(t.dir, `sealed-${Date.now()}.enc`)

    // No --factor and both kinds drivable: a sealed backup asks for the passphrase and shows no menu.
    const b = await harness({
      env: { CANDLE_CONFIG_DIR: t.dir },
      secrets: [t.passphrase],
      script: { store: t.add.script.store },
    })
    expect(await run(["vault", "backup", "--to", to, "--keystore", t.vaultPath], b.deps)).toBe(0)
    expect(b.asked).toEqual([expect.stringContaining("Vault passphrase")])
    expect(ops(b)).not.toContain("passkey-assert")
    expect(b.stdout.text).toContain("destination   icloud-drive")
    expect(b.stdout.text).toContain(
      `sealed        yes: passphrase envelope(s) ${live.envelopes[0]?.id} only; left out ${t.envelopeId}`,
    )
    expect(b.stdout.text).toContain("all 8 passed, in order")
    expect(b.stdout.text).toContain("address set   matches the live vault")
    expect(b.stdout.text).toContain("This copy opens only with the passphrase")
    expect(b.stdout.text).toContain("Keep the passphrase somewhere outside the Apple account")
    expect(b.stdout.text).toContain("live vault plus the recovery phrase remain the everyday path")
    expect(b.stdout.text).not.toContain("shared domain")

    // The copy: same vault id, generation, root and key blobs; one envelope; its own index.
    const copy = await readVault(to)
    expect(copy.vaultId).toBe(live.vaultId)
    expect(copy.generation).toBe(live.generation)
    expect(copy.root.ciphertext).toBe(live.root.ciphertext)
    expect(copy.keys.map((k) => k.ciphertext)).toEqual(live.keys.map((k) => k.ciphertext))
    expect(copy.envelopes.map((e) => e.factor)).toEqual(["passphrase"])
    expect(copy.index.ciphertext).not.toBe(live.index.ciphertext)
    // The live vault is untouched: every envelope still there, nothing rewritten.
    expect(await readVault(t.vaultPath)).toEqual(live)

    // The copy opens on its own with the passphrase; re-adding the stripped envelope to its header
    // fails the index tag (the copy authenticates its own header, ED-1).
    closeVault(await unlockWithPassphrase(to, await readFile(to, "utf8"), t.passphrase))
    const tampered = { ...copy, envelopes: [...copy.envelopes, t.envelope] }
    await writeFile(`${to}.tampered`, JSON.stringify(tampered, null, 2))
    await expect(
      unlockWithPassphrase(`${to}.tampered`, await readFile(`${to}.tampered`, "utf8"), t.passphrase),
    ).rejects.toMatchObject({ code: "VAULT_BLOB_TAMPERED" })

    const sidecar = await readSidecar(sidecarPath(t.vaultPath))
    expect(sidecar).toMatchObject({ lastBackupDomain: "icloud-drive", lastBackupSealed: true })
    expect(sidecar?.lastBackupSharedDomainAccepted).toBeUndefined()
    const status = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, script: { store: t.add.script.store } })
    expect(await run(["vault", "status", "--keystore", t.vaultPath], status.deps)).toBe(0)
    expect(status.stdout.text).toContain("(icloud-drive, sealed: opens with the passphrase only)")
    expect(status.stdout.text).toContain("lives in your Apple account")
  })

  test("--factor passkey on a sealed backup is not honoured: the passphrase is used and the output says why", async () => {
    const t = await vaultWithPasskey()
    const to = await icloudPath(t.dir, `sealed-factor-${Date.now()}.enc`)
    const b = await harness({
      env: { CANDLE_CONFIG_DIR: t.dir },
      secrets: [t.passphrase],
      script: { store: t.add.script.store },
    })
    expect(
      await run(["vault", "backup", "--to", to, "--factor", "passkey", "--json", "--keystore", t.vaultPath], b.deps),
    ).toBe(0)
    expect(b.stderr.text).toContain(
      "sealed copy that opens only with the passphrase; the passphrase is used here rather than --factor passkey",
    )
    expect(ops(b)).not.toContain("passkey-assert")
    const body = JSON.parse(b.stdout.text) as Record<string, unknown>
    expect(body).toMatchObject({
      ok: true,
      destinationDomain: "icloud-drive",
      sealed: true,
      envelopesLeftOut: [t.envelopeId],
      sharedDomainAccepted: false,
      sharedDomain: true,
      verified: true,
      steps: 8,
    })
    expect(b.stdout.text).not.toContain(t.passphrase)
  })

  test("--accept-shared-domain writes an unsealed copy, records the acceptance, and status keeps the label", async () => {
    const t = await vaultWithPasskey()
    const live = await readVault(t.vaultPath)
    const to = await icloudPath(t.dir, `unsealed-${Date.now()}.enc`)
    const b = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, script: { store: t.add.script.store } })
    expect(
      await run(
        ["vault", "backup", "--to", to, "--accept-shared-domain", "--factor", "passkey", "--keystore", t.vaultPath],
        b.deps,
      ),
    ).toBe(0)
    expect(b.asked).toEqual([])
    expect(ops(b).filter((op) => op === "passkey-assert")).toHaveLength(2)
    expect(b.stdout.text).toContain("sealed        no: every envelope is in this copy (--accept-shared-domain)")
    expect(b.stdout.text).toContain(
      "shared domain this destination and a synced passkey envelope are one Apple account, and this unsealed copy carries that passkey's envelope; you accepted that.",
    )
    expect(b.stdout.text).not.toContain("This copy opens only with the passphrase")
    expect((await readVault(to)).envelopes.map((e) => e.id)).toEqual(live.envelopes.map((e) => e.id))
    expect(await readSidecar(sidecarPath(t.vaultPath))).toMatchObject({
      lastBackupDomain: "icloud-drive",
      lastBackupSealed: false,
      lastBackupSharedDomainAccepted: true,
    })
    const status = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, script: { store: t.add.script.store } })
    expect(await run(["vault", "status", "--keystore", t.vaultPath], status.deps)).toBe(0)
    expect(status.stdout.text).toContain(
      "shared domain          accepted for the last backup destination (an unsealed copy, every envelope included)",
    )
  })

  test("a local destination is never sealed, with or without the flag", async () => {
    const t = await vaultWithPasskey()
    const live = await readVault(t.vaultPath)
    for (const flag of [[], ["--accept-shared-domain"]]) {
      const to = join(t.dir, "..", `local-${Date.now()}-${flag.length}.enc`)
      const b = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, secrets: [t.passphrase] })
      expect(
        await run(
          ["vault", "backup", "--to", to, ...flag, "--factor", "passphrase", "--json", "--keystore", t.vaultPath],
          b.deps,
        ),
      ).toBe(0)
      expect(JSON.parse(b.stdout.text)).toMatchObject({
        sealed: false,
        sharedDomainAccepted: false,
        envelopesLeftOut: [],
      })
      expect((await readVault(to)).envelopes).toHaveLength(live.envelopes.length)
    }
  })

  test("verify-backup verifies a sealed copy with the passphrase, whatever --factor says, through the same eight steps", async () => {
    const t = await vaultWithPasskey()
    const to = await icloudPath(t.dir, `verify-${Date.now()}.enc`)
    const b = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, secrets: [t.passphrase] })
    expect(await run(["vault", "backup", "--to", to, "--keystore", t.vaultPath], b.deps)).toBe(0)

    const v = await harness({
      env: { CANDLE_CONFIG_DIR: t.dir },
      secrets: [t.passphrase],
      script: { store: t.add.script.store },
    })
    expect(await run(["vault", "verify-backup", to, "--factor", "passkey", "--keystore", t.vaultPath], v.deps)).toBe(0)
    expect(v.stderr.text).toContain(
      "is a sealed copy that opens only with the passphrase it was sealed under, which may predate a passphrase rotation. The passphrase is used here rather than --factor passkey",
    )
    expect(v.asked).toEqual([expect.stringContaining("Vault passphrase")])
    expect(ops(v)).not.toContain("passkey-assert")
    expect(v.stdout.text).toContain("sealed        yes")
    expect(v.stdout.text).toContain("all 8 passed, in order")
    expect(v.stdout.text).toContain("address set   matches the live vault")

    const json = await harness({
      env: { CANDLE_CONFIG_DIR: t.dir },
      secrets: [t.passphrase],
      script: { store: t.add.script.store },
    })
    expect(await run(["vault", "verify-backup", to, "--json", "--keystore", t.vaultPath], json.deps)).toBe(0)
    expect(JSON.parse(json.stdout.text)).toMatchObject({ ok: true, sealed: true, steps: 8, comparedAgainstLive: true })

    // An unsealed copy is verified with whichever factor opened the live vault.
    const unsealedTo = await icloudPath(t.dir, `verify-unsealed-${Date.now()}.enc`)
    const ub = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, secrets: [t.passphrase] })
    expect(
      await run(
        [
          "vault",
          "backup",
          "--to",
          unsealedTo,
          "--accept-shared-domain",
          "--factor",
          "passphrase",
          "--keystore",
          t.vaultPath,
        ],
        ub.deps,
      ),
    ).toBe(0)
    const uv = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, script: { store: t.add.script.store } })
    expect(
      await run(
        ["vault", "verify-backup", unsealedTo, "--factor", "passkey", "--json", "--keystore", t.vaultPath],
        uv.deps,
      ),
    ).toBe(0)
    expect(JSON.parse(uv.stdout.text)).toMatchObject({ ok: true, sealed: false })
    expect(ops(uv).filter((op) => op === "passkey-assert")).toHaveLength(2)
  })
})

test("native helper identity quotes are refused at parse time without a spawn or prompt", async () => {
  const t = await vaultWithPasskey()
  const original = await readFile(t.vaultPath, "utf8")
  for (const field of ["teamId", "bundleId"] as const) {
    const file = JSON.parse(original) as VaultJson
    const envelope = file.envelopes.find((e) => e.factor === "passkey-prf") as Record<string, unknown>
    const helper = envelope.helper as Record<string, string>
    helper[field] += '" or true'
    await writeFile(t.vaultPath, JSON.stringify(file))
    const h = await harness({ env: { CANDLE_CONFIG_DIR: t.dir } })
    expect(await run(["vault", "status", "--unlock", "--json", "--keystore", t.vaultPath], h.deps)).toBe(1)
    expect(failure(h).code).toBe("VAULT_UNREADABLE")
    expect(h.codesign).toEqual([])
    expect(h.calls).toEqual([])
    expect(h.asked).toEqual([])
  }
})

test("signed helper info failures leave status, factor list and passphrase enrollment usable", async () => {
  const t = await vaultWithPasskey()
  const touch = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, secrets: [t.passphrase] })
  expect(await run(["vault", "factor", "add", "touch-id", "--keystore", t.vaultPath], touch.deps)).toBe(0)
  for (const failed of [
    { stdout: "", stderr: "secret-canary", exitCode: null, signal: null, spawnError: "ENOENT" },
    { stdout: "not json secret-canary", stderr: "", exitCode: 0, signal: null },
    { stdout: "", stderr: "secret-canary", exitCode: 1, signal: null },
    { stdout: '{"protocol":1,"ok":true,"op":"info"}', stderr: "", exitCode: 0, signal: null },
  ]) {
    for (const command of [["status"], ["factor", "list"], ["factor", "add", "passphrase", "--own-passphrase"]]) {
      const fresh = "synthetic newly added passphrase"
      const h = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, secrets: [t.passphrase, fresh, fresh] })
      const spawn = h.deps.spawnHelper
      h.deps.spawnHelper = (path, line, opts) =>
        path === CODESIGN_PATH ? spawn(path, line, opts) : Promise.resolve(failed)
      expect(
        await run(["vault", ...command, "--factor", "passphrase", "--json", "--keystore", t.vaultPath], h.deps),
      ).toBe(0)
      if (command.length < 3) {
        expect(h.stdout.text).toContain("unavailable-on-this-device")
        expect(h.stdout.text).toContain("could not report its availability")
        const envelopes = JSON.parse(h.stdout.text).envelopes as Array<{ factor: string; availability: string }>
        for (const factor of ["secure-enclave", "passkey-prf"]) {
          expect(envelopes.find((e) => e.factor === factor)?.availability).toBe("unavailable-on-this-device")
        }
        expect(envelopes.find((e) => e.factor === "passphrase")?.availability).toBe("available")
      }
      expect(h.stdout.text + h.stderr.text).not.toContain("secret-canary")
      expect(h.stdout.text + h.stderr.text).not.toContain(fresh)
    }
  }
})

test("a sealed backup retains its old passphrase after rotation", async () => {
  const t = await vaultWithPasskey()
  const cloud = join(t.dir, "..", "Library", "Mobile Documents", t.dir.split("/").pop() as string)
  await mkdir(cloud, { recursive: true })
  const to = join(cloud, "before-rotation.enc")
  const b = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, secrets: [t.passphrase] })
  expect(await run(["vault", "backup", "--to", to, "--keystore", t.vaultPath], b.deps)).toBe(0)
  const oldId = (await readVault(to)).envelopes[0]?.id as string
  const fresh = "synthetic rotated passphrase"
  const add = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, secrets: [t.passphrase, fresh, fresh] })
  expect(
    await run(
      ["vault", "factor", "add", "passphrase", "--own-passphrase", "--factor", "passphrase", "--keystore", t.vaultPath],
      add.deps,
    ),
  ).toBe(0)
  const remove = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, secrets: [fresh] })
  expect(
    await run(["vault", "factor", "remove", oldId, "--factor", "passphrase", "--keystore", t.vaultPath], remove.deps),
  ).toBe(0)
  expect((await readVault(t.vaultPath)).envelopes.some((e) => e.id === oldId)).toBe(false)
  const v = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, secrets: [fresh, t.passphrase] })
  expect(
    await run(["vault", "verify-backup", to, "--factor", "passkey", "--json", "--keystore", t.vaultPath], v.deps),
  ).toBe(0)
  expect(JSON.parse(v.stdout.text)).toMatchObject({ ok: true, sealed: true, steps: 8, comparedAgainstLive: true })
  expect(v.asked).toEqual([
    expect.stringContaining("Vault passphrase"),
    expect.stringContaining("Passphrase this backup was sealed under"),
  ])
  expect(v.stderr.text).toContain("may predate a passphrase rotation")
  expect(ops(v)).not.toContain("passkey-assert")
  expect(v.stdout.text + v.stderr.text).not.toContain(t.passphrase)
  expect(v.stdout.text + v.stderr.text).not.toContain(fresh)
})
