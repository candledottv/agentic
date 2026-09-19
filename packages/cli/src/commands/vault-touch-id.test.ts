/**
 * Ember Phase 2 (BE-141, CC-03, ED-12, CC-12): the Touch ID factor, end to end through `run()`.
 *
 * The Enclave is scripted and everything else is real: the release policy gate, the helper's
 * location, the codesign requirement the CLI builds (the spawn is faked and its arguments
 * recorded), the helper protocol over a real pipe in the subprocess test, the ECIES wrap and the
 * reference unwrap, the vault write, the rollback, and the re-open with the new factor. The two
 * facts no script can stand in for (that Apple's decryptor agrees with this encryptor, and what
 * Touch ID and the keychain actually answer on a Mac) are T48's, run by hand.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { base64, base64urlnopad } from "@scure/base"
import type { CommandContext, Deps } from "../deps"
import { ENCLAVE_BUNDLE_NAME, ENCLAVE_EXECUTABLE_RELATIVE, handleEnclaveLine } from "../enclave-helper/protocol"
import { type EnclaveLogEntry, type EnclaveScript, scriptedEnclaveBackend } from "../enclave-helper/test-backend"
import { realSpawnHelper, run } from "../index"
import { createCapture, createTestDeps } from "../test-support"
import { pointFromSpki } from "../vault/ecies"
import { CODESIGN_PATH, codesignRequirement, ENCLAVE_HELPER_ENV, type ReleasePolicy } from "../vault/enclave"
import { trackSecrets } from "../vault/hygiene"
import { RELEASE_POLICY } from "../vault/release-policy"
import { generatedPassphraseFrom, useCheapKdf } from "../vault/test-vault"
import { unlockInteractively } from "./vault-support"

setDefaultTimeout(60_000)
useCheapKdf()

const unreachableFetch = (async () => {
  throw new Error("no test in this file should make a network call")
}) as unknown as typeof fetch

const TEAM = "ABCDE12345"
const BUNDLE = "tv.candle.cli.enclave"
const SIGNED: ReleasePolicy = { macosHelper: { release: "signed", bundleId: BUNDLE, teamId: TEAM } }

interface Harness {
  deps: Deps
  stdout: ReturnType<typeof createCapture>
  stderr: ReturnType<typeof createCapture>
  asked: string[]
  /** Every call that reached the scripted Enclave. */
  calls: EnclaveLogEntry[]
  /** Every codesign invocation's arguments. */
  codesign: string[][]
  /** The base64 plaintexts the scripted helper handed back over the pipe (the KEK canaries). */
  unwrapped: string[]
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
  /** Replaces the helper's response line, for a stale or foreign helper. */
  helperResponse?: (line: string) => string | undefined
}

async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = opts.env?.CANDLE_CONFIG_DIR ?? (await mkdtemp(join(tmpdir(), "candle-vault-tid-")))
  const stdout = createCapture()
  const stderr = createCapture()
  const asked: string[] = []
  const calls: EnclaveLogEntry[] = []
  const codesign: string[][] = []
  const unwrapped: string[] = []
  const secrets = [...(opts.secrets ?? [])]
  const lines = [...(opts.lines ?? [])]
  const script: EnclaveScript = {
    version: "0.12.0",
    bundleId: BUNDLE,
    teamId: TEAM,
    secureEnclave: true,
    biometry: "available",
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
    const response = await handleEnclaveLine(line, () => scriptedEnclaveBackend(script, (entry) => calls.push(entry)))
    if (response.ok && response.op === "decrypt") unwrapped.push(response.plaintext)
    const text = opts.helperResponse?.(line) ?? JSON.stringify(response)
    return { stdout: `${text}\n`, stderr: "", exitCode: response.ok ? 0 : 1, signal: null }
  }
  const deps = createTestDeps({
    fetch: unreachableFetch,
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
    unwrapped,
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

/** Adds the scripted Touch ID factor to a fresh vault and returns everything a later test needs. */
async function vaultWithTouchId(opts: Partial<HarnessOptions> = {}) {
  const v = await initVault(opts)
  const add = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [v.passphrase], ...opts })
  const code = await run(
    ["vault", "factor", "add", "touch-id", "--label", "this mac", "--keystore", v.vaultPath],
    add.deps,
  )
  if (code !== 0) throw new Error(`factor add touch-id failed (${code}): ${add.stderr.text}${add.stdout.text}`)
  const file = await readVault(v.vaultPath)
  const envelope = file.envelopes.find(
    (candidate) => candidate.factor === "secure-enclave",
  ) as VaultJson["envelopes"][number]
  return { ...v, add, envelopeId: envelope.id, envelope }
}

/** The last JSON line on stdout: a harness reused for two commands has two. */
function failure(h: Harness): { code: string; message: string; suggestion?: string } {
  const lines = h.stdout.text.trim().split("\n")
  return JSON.parse(lines[lines.length - 1] as string) as { code: string; message: string; suggestion?: string }
}

describe("factor add touch-id: the ceremony", () => {
  test("creates the key, wraps a fresh KEK, writes only the index, and re-opens with Touch ID once before reporting", async () => {
    const v = await initVault()
    const before = await readVault(v.vaultPath)
    const add = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [v.passphrase] })
    const tracking = trackSecrets()
    const code = await run(
      ["vault", "factor", "add", "touch-id", "--label", "this mac", "--keystore", v.vaultPath],
      add.deps,
    )
    const secretsAllocated = tracking.stop()
    expect(code).toBe(0)
    expect(add.stdout.text).toContain("Added Touch ID factor")
    expect(add.stdout.text).toContain("verified   the vault was re-read and opened with Touch ID")
    expect(add.stdout.text).toContain("Touch ID is a daily-use factor, not a recovery factor")
    expect(add.stdout.text).toContain("1 recoverable factor(s)")

    // The passphrase was asked once, after the platform and helper checks, and nothing else.
    expect(add.asked).toEqual(["secret: Current vault passphrase, to unlock (input hidden): "])

    // The codesign requirement pinned the policy's team id and bundle id, by absolute path.
    expect(add.codesign.length).toBeGreaterThan(0)
    for (const args of add.codesign) {
      expect(args.slice(0, 3)).toEqual(["--verify", "--strict", "--deep"])
      expect(args[3]).toBe("-R")
      expect(args[4]).toBe(codesignRequirement({ teamId: TEAM, bundleId: BUNDLE }))
      expect(args[4]).toContain(`certificate leaf[subject.OU] = "${TEAM}"`)
      expect(args[4]).toContain(`identifier "${BUNDLE}"`)
      expect(args[5]).toBe(add.appPath)
    }

    // One create, then exactly one decrypt: the proof, with the reason the prompt shows.
    const ops = add.calls.map((call) => call.op)
    expect(ops.filter((op) => op === "create")).toHaveLength(1)
    expect(ops.filter((op) => op === "decrypt")).toHaveLength(1)
    expect(ops).not.toContain("delete")
    expect(add.calls.find((call) => call.op === "decrypt")?.reason).toBe(
      "prove the new Touch ID factor opens the Candle vault",
    )

    // The envelope, as CC-01's row says; the index re-encrypted; root and key blobs untouched.
    const after = await readVault(v.vaultPath)
    expect(after.generation).toBe(before.generation + 1)
    expect(after.index.ciphertext).not.toBe(before.index.ciphertext)
    expect(after.root.ciphertext).toBe(before.root.ciphertext)
    expect(after.envelopes).toHaveLength(2)
    const envelope = after.envelopes.find((candidate) => candidate.factor === "secure-enclave") as Record<
      string,
      unknown
    >
    expect(envelope).toMatchObject({
      domain: "this-device",
      label: "this mac",
      helper: { teamId: TEAM, bundleId: BUNDLE, minVersion: "0.12.0" },
      accessControl: "biometryCurrentSet",
      kek: { alg: "ECIES-P256-SHA256-AESGCM" },
    })
    expect(envelope.keyTag).toBe(`tv.candle.cli.vault.${after.vaultId}.${String(envelope.id)}`)
    const point = pointFromSpki(base64urlnopad.decode(String(envelope.publicKey)), "publicKey")
    const stored = JSON.parse(await readFile(add.script.store, "utf8")) as Record<string, { publicKey: string }>
    expect(Object.keys(stored)).toEqual([String(envelope.keyTag)])
    expect(stored[String(envelope.keyTag)]?.publicKey).toBe(Buffer.from(point).toString("hex"))
    // The packet: ephemeral point, 32 bytes of KEK, 16-byte tag.
    expect(base64urlnopad.decode(String((envelope.kek as { ciphertext: string }).ciphertext)).length).toBe(65 + 32 + 16)

    // Every secret the run allocated is zero afterwards (T36).
    expect(secretsAllocated.length).toBeGreaterThan(0)
    console.log(
      "DEBUG",
      secretsAllocated.map((b, i) => `${i}:${b.length}:${b.some((x) => x !== 0) ? "DIRTY" : "zero"}`).join(" "),
    )
    for (const buffer of secretsAllocated) expect(buffer.every((byte) => byte === 0)).toBe(true)
  })

  test("the same ceremony over a real subprocess through the real spawn seam, and an unlock in a later process", async () => {
    const v = await initVault({ subprocess: true })
    const add = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [v.passphrase], subprocess: true })
    const code = await run(["vault", "factor", "add", "touch-id", "--keystore", v.vaultPath], add.deps)
    expect(`${code} ${add.stderr.text}`).toStartWith("0 ")
    const log = (await readFile(add.script.log as string, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as EnclaveLogEntry)
    expect(log.map((entry) => entry.op)).toEqual(["info", "info", "create", "decrypt"])

    // The key lives in the scripted Enclave's store, so a fresh process (a fresh harness) opens with it.
    const later = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      subprocess: true,
      script: { store: add.script.store },
    })
    expect(
      await run(["vault", "status", "--unlock", "--factor", "touch-id", "--keystore", v.vaultPath], later.deps),
    ).toBe(0)
    expect(later.asked).toEqual([])
    expect(later.stdout.text).toContain("Keys (0)")
  })

  test("no secret reaches stdout, stderr, --json or the file: the unwrapped KEK is the canary", async () => {
    const v = await initVault()
    const add = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, secrets: [v.passphrase] })
    expect(await run(["vault", "factor", "add", "touch-id", "--json", "--keystore", v.vaultPath], add.deps)).toBe(0)
    expect(add.unwrapped).toHaveLength(1)
    const kek = base64.decode(add.unwrapped[0] as string)
    const forms = [base64.encode(kek), base64urlnopad.encode(kek), Buffer.from(kek).toString("hex")]
    const outputs = [add.stdout.text, add.stderr.text, await readFile(v.vaultPath, "utf8")]
    for (const form of forms) for (const output of outputs) expect(output).not.toContain(form)
    expect(outputs[2]).not.toContain(v.passphrase)
    const json = JSON.parse(add.stdout.text) as Record<string, unknown>
    expect(json).toMatchObject({
      ok: true,
      factor: "secure-enclave",
      domain: "this-device",
      helper: { teamId: TEAM, bundleId: BUNDLE, minVersion: "0.12.0" },
      accessControl: "biometryCurrentSet",
      recoverableFactors: 1,
      verified: true,
    })
    expect(add.stdout.text.trim().split("\n")).toHaveLength(1)
  })

  test("a failed key creation is typed, nothing is written, and the passphrase envelope is untouched", async () => {
    const v = await initVault()
    const before = await readVault(v.vaultPath)
    const add = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [v.passphrase],
      script: { fail: { create: { code: "KEYCHAIN_IO", message: "OSStatus -34018: missing entitlement" } } },
    })
    expect(await run(["vault", "factor", "add", "touch-id", "--json", "--keystore", v.vaultPath], add.deps)).toBe(1)
    expect(failure(add)).toMatchObject({ code: "VAULT_FACTOR_UNAVAILABLE" })
    expect(failure(add).message).toContain("missing entitlement")
    expect(await readVault(v.vaultPath)).toEqual(before)
    expect(add.stderr.text).toContain("Nothing was written to the vault")
  })

  test("a failed proof rolls the envelope back out of the file, deletes the key, and a retry succeeds", async () => {
    const v = await initVault()
    const before = await readVault(v.vaultPath)
    const add = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [v.passphrase],
      script: { fail: { decrypt: { code: "CANCELLED", message: "LAErrorDomain -2: cancelled" } } },
    })
    expect(await run(["vault", "factor", "add", "touch-id", "--json", "--keystore", v.vaultPath], add.deps)).toBe(1)
    expect(failure(add)).toMatchObject({ code: "VAULT_AUTHENTICATOR_CANCELLED" })
    expect(add.calls.map((call) => call.op)).toEqual(["info", "info", "create", "decrypt", "delete"])
    const after = await readVault(v.vaultPath)
    expect(after.envelopes.map((envelope) => envelope.id)).toEqual(before.envelopes.map((envelope) => envelope.id))
    expect(after.generation).toBe(before.generation + 2)
    expect(after.root.ciphertext).toBe(before.root.ciphertext)
    expect(JSON.parse(await readFile(add.script.store, "utf8"))).toEqual({})
    expect(add.stderr.text).toContain("was removed from the vault again")
    expect(add.stderr.text).toContain("Removed the Secure Enclave key")

    const retry = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      secrets: [v.passphrase],
      script: { store: add.script.store },
    })
    expect(await run(["vault", "factor", "add", "touch-id", "--keystore", v.vaultPath], retry.deps)).toBe(0)
    expect((await readVault(v.vaultPath)).envelopes).toHaveLength(2)
  })

  test("needs a terminal for the passphrase", async () => {
    const v = await initVault()
    const add = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, tty: false })
    expect(await run(["vault", "factor", "add", "touch-id", "--json", "--keystore", v.vaultPath], add.deps)).toBe(1)
    expect(failure(add)).toMatchObject({ code: "VAULT_UNLOCK_FAILED" })
    expect(failure(add).message).toContain("needs a terminal")
    expect(add.calls).toEqual([])
  })
})

describe("factor add touch-id: every refusal is typed, before the passphrase, and substitutes nothing", () => {
  const rows: Array<{
    name: string
    opts: HarnessOptions
    code: string
    message: string
    /** Whether the helper executable was ever run. */
    helperRun: boolean
  }> = [
    {
      name: "the release policy omits the signed helper (the state until Apple approves)",
      opts: { policy: "omit" },
      code: "VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM",
      message: "release policy omits the signed Secure Enclave helper",
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
      name: "codesign itself cannot be run",
      opts: { codesign: "missing" },
      code: "VAULT_HELPER_UNTRUSTED",
      message: "Could not run /usr/bin/codesign",
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
      name: "an Intel Mac without a T2 chip",
      opts: { arch: "x64", script: { secureEnclave: false } },
      code: "VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM",
      message: "no Secure Enclave",
      helperRun: true,
    },
    {
      name: "Touch ID not usable right now (lid closed, no sensor)",
      opts: { script: { biometry: "unavailable", biometryReason: "Biometry is not available on this device" } },
      code: "VAULT_FACTOR_UNAVAILABLE",
      message: "Biometry is not available on this device",
      helperRun: true,
    },
    {
      name: "no fingerprint enrolled",
      opts: { script: { biometry: "none", biometryReason: "No fingerprints are enrolled" } },
      code: "VAULT_FACTOR_UNAVAILABLE",
      message: "No fingerprints are enrolled",
      helperRun: true,
    },
    // BE-135 (constraint 5): the report a process outside the interactive session gets on a Mac
    // that HAS Touch ID (LAError -4, systemCancel) is worded as "not available from this session",
    // names the LAError, and is not "no Touch ID hardware".
    {
      name: "not available from this session (SSH, a background agent, the lid closed): LAError systemCancel",
      opts: {
        script: {
          biometry: "not-interactive",
          biometryReason: "Authentication canceled.",
          biometryType: "touchID",
          laError: { code: -4, name: "systemCancel" },
        },
      },
      code: "VAULT_FACTOR_UNAVAILABLE",
      message: "Touch ID is not available from this session (LAError systemCancel, -4): this Mac has Touch ID, but",
      helperRun: true,
    },
    {
      name: "not available from this session: LAError notInteractive",
      opts: {
        script: {
          biometry: "not-interactive",
          biometryType: "touchID",
          laError: { code: -1004, name: "notInteractive" },
        },
      },
      code: "VAULT_FACTOR_UNAVAILABLE",
      message: "not available from this session (LAError notInteractive, -1004)",
      helperRun: true,
    },
    {
      name: "locked out after failed attempts: LAError biometryLockout",
      opts: {
        script: {
          biometry: "locked-out",
          biometryReason: "Biometry is locked out.",
          biometryType: "touchID",
          laError: { code: -8, name: "biometryLockout" },
        },
      },
      code: "VAULT_FACTOR_UNAVAILABLE",
      message:
        "Touch ID is locked out after too many failed attempts: Biometry is locked out (LAError biometryLockout, -8)",
      helperRun: true,
    },
    {
      name: "no Touch ID sensor at all: LAError biometryNotAvailable with biometryType none",
      opts: {
        script: {
          biometry: "unavailable",
          biometryReason: "Biometry is not available on this device.",
          biometryType: "none",
          laError: { code: -6, name: "biometryNotAvailable" },
        },
      },
      code: "VAULT_FACTOR_UNAVAILABLE",
      message:
        "This Mac has no Touch ID sensor: Biometry is not available on this device (LAError biometryNotAvailable, -6)",
      helperRun: true,
    },
  ]
  for (const row of rows) {
    test(row.name, async () => {
      const v = await initVault(row.opts)
      const before = await readVault(v.vaultPath)
      const add = await harness({ env: { CANDLE_CONFIG_DIR: v.dir }, ...row.opts })
      expect(await run(["vault", "factor", "add", "touch-id", "--json", "--keystore", v.vaultPath], add.deps)).toBe(1)
      const refusal = failure(add)
      expect(refusal.code).toBe(row.code)
      expect(refusal.message).toContain(row.message)
      expect(`${refusal.message} ${refusal.suggestion ?? ""}`).toMatch(/[Nn]o other factor is substituted/)
      expect(add.asked).toEqual([])
      expect(add.calls.map((call) => call.op)).not.toContain("create")
      if (!row.helperRun) expect(add.calls).toEqual([])
      expect(await readVault(v.vaultPath)).toEqual(before)
    })
  }

  test("a helper speaking another protocol revision is a stale install, VAULT_HELPER_MISSING", async () => {
    const v = await initVault()
    const add = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      helperResponse: () => JSON.stringify({ ok: true, protocol: 2, op: "info" }),
    })
    expect(await run(["vault", "factor", "add", "touch-id", "--json", "--keystore", v.vaultPath], add.deps)).toBe(1)
    expect(failure(add)).toMatchObject({ code: "VAULT_HELPER_MISSING" })
    expect(failure(add).message).toContain("could not report its availability (VAULT_HELPER_MISSING)")
    expect(add.asked).toEqual([])
  })
})

describe("BE-135: the biometry report is worded by state, not collapsed to unavailable", () => {
  test("each state maps to its own sentence, the session states carry the LAError name, and none claims missing hardware wrongly", async () => {
    const { describeBiometry, translateEnclaveFailure } = await import("../vault/enclave")
    const session = describeBiometry({
      biometry: "not-interactive",
      biometryReason: "Authentication canceled.",
      biometryType: "touchID",
      laError: { code: -4, name: "systemCancel" },
    })
    expect(session.message).toContain("not available from this session")
    expect(session.message).toContain("LAError systemCancel, -4")
    expect(session.message).toContain("this Mac has Touch ID")
    expect(session.message).not.toContain("no Touch ID sensor")
    expect(session.suggestion).toContain("Terminal window inside the logged-in session")
    expect(session.suggestion).toMatch(/no other factor is substituted/)

    const unknownType = describeBiometry({
      biometry: "not-interactive",
      laError: { code: -1004, name: "notInteractive" },
    })
    expect(unknownType.message).toContain("may have Touch ID")

    const none = describeBiometry({ biometry: "none", biometryReason: "No fingerprints are enrolled." })
    expect(none.message).toContain("No fingerprint is enrolled")
    expect(none.suggestion).toContain("Enrol a fingerprint")

    const locked = describeBiometry({ biometry: "locked-out", laError: { code: -8, name: "biometryLockout" } })
    expect(locked.message).toContain("locked out")
    expect(locked.suggestion).toContain("Unlock the Mac with its password")

    const noSensor = describeBiometry({
      biometry: "unavailable",
      biometryType: "none",
      laError: { code: -6, name: "biometryNotAvailable" },
    })
    expect(noSensor.message).toContain("no Touch ID sensor")
    const lidClosed = describeBiometry({
      biometry: "unavailable",
      biometryType: "touchID",
      laError: { code: -6, name: "biometryNotAvailable" },
    })
    expect(lidClosed.message).toContain("present but not usable right now")
    expect(lidClosed.suggestion).toContain("Open the lid")

    // A PR F helper that reports neither the type nor the LAError still gets a sentence, not a crash.
    expect(describeBiometry({ biometry: "unavailable", biometryReason: "Authentication canceled." }).message).toContain(
      "present but not usable right now: Authentication canceled.",
    )
    expect(
      describeBiometry({ biometry: "unavailable", biometryReason: "Authentication canceled." }).message,
    ).not.toContain("..")

    // The helper's own NOT_INTERACTIVE at decrypt time is the same typed code and wording.
    const translated = translateEnclaveFailure(
      "NOT_INTERACTIVE",
      "LAErrorDomain -4: Authentication canceled. (LAError systemCancel)",
    )
    expect(translated.code).toBe("VAULT_FACTOR_UNAVAILABLE")
    expect(translated.message).toContain("not available from this session")
    expect(translated.suggestion).toContain("Terminal window inside the logged-in session")
  })

  test("status --json carries the biometry type and the LAError from the helper's report", async () => {
    const v = await initVault({
      script: { biometry: "not-interactive", biometryType: "touchID", laError: { code: -4, name: "systemCancel" } },
    })
    const status = await harness({
      env: { CANDLE_CONFIG_DIR: v.dir },
      script: { biometry: "not-interactive", biometryType: "touchID", laError: { code: -4, name: "systemCancel" } },
    })
    expect(await run(["vault", "factor", "add", "touch-id", "--json", "--keystore", v.vaultPath], status.deps)).toBe(1)
    expect(failure(status).message).toContain("LAError systemCancel, -4")
    expect(status.asked).toEqual([])
  })
})

describe("unlocking with Touch ID", () => {
  test("--factor touch-id and --factor <id> drive the envelope with one prompt naming the operation; new-key re-opens (two prompts)", async () => {
    const t = await vaultWithTouchId()
    const status = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, script: { store: t.add.script.store } })
    expect(
      await run(["vault", "status", "--unlock", "--factor", t.envelopeId, "--keystore", t.vaultPath], status.deps),
    ).toBe(0)
    expect(status.asked).toEqual([])
    expect(status.calls.filter((call) => call.op === "decrypt").map((call) => call.reason)).toEqual([
      "unlock the Candle vault",
    ])
    expect(status.stderr.text).toContain("Confirm with Touch ID to unlock the Candle vault.")

    const newKey = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, script: { store: t.add.script.store } })
    expect(
      await run(
        ["vault", "new-key", "--chain", "solana", "--label", "cold", "--factor", "touch-id", "--keystore", t.vaultPath],
        newKey.deps,
      ),
    ).toBe(0)
    expect(newKey.asked).toEqual([])
    expect(newKey.calls.filter((call) => call.op === "decrypt")).toHaveLength(2)

    const listed = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, script: { store: t.add.script.store } })
    expect(
      await run(
        ["vault", "status", "--unlock", "--factor", "touch-id", "--json", "--keystore", t.vaultPath],
        listed.deps,
      ),
    ).toBe(0)
    const json = JSON.parse(listed.stdout.text) as { unlocked: { entries: Array<{ label: string }> } }
    expect(json.unlocked.entries.map((entry) => entry.label)).toEqual(["cold"])
  })

  test("confirm puts the operation itself in the Touch ID prompt (ED-12)", async () => {
    const t = await vaultWithTouchId()
    const h = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, script: { store: t.add.script.store } })
    const ctx = {
      deps: h.deps,
      json: false,
      apiUrl: "http://unused.invalid",
      vaultFactor: "touch-id",
    } as unknown as CommandContext
    const raw = await readFile(t.vaultPath, "utf8")
    const opened = await unlockInteractively(ctx, t.vaultPath, raw)
    expect(opened.factor.kind).toBe("touch-id")
    await opened.confirm("sign transfer of 1.5 SOL to 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin")
    const { closeVault } = await import("../vault/store")
    closeVault(opened.vault)
    expect(h.calls.filter((call) => call.op === "decrypt").map((call) => call.reason)).toEqual([
      "unlock the Candle vault",
      "sign transfer of 1.5 SOL to 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    ])
  })

  test("with a passphrase and Touch ID both drivable and no --factor, the operator is asked which", async () => {
    const t = await vaultWithTouchId()
    const byId = await harness({
      env: { CANDLE_CONFIG_DIR: t.dir },
      script: { store: t.add.script.store },
      lines: [t.envelopeId],
    })
    expect(await run(["vault", "status", "--unlock", "--keystore", t.vaultPath], byId.deps)).toBe(0)
    expect(byId.asked[0]).toContain("This vault opens with a passphrase or Touch ID.")
    expect(byId.asked[0]).toContain(`${t.envelopeId}  Touch ID  this mac`)
    expect(byId.calls.filter((call) => call.op === "decrypt")).toHaveLength(1)

    const byPassphrase = await harness({
      env: { CANDLE_CONFIG_DIR: t.dir },
      script: { store: t.add.script.store },
      lines: ["passphrase"],
      secrets: [t.passphrase],
    })
    expect(await run(["vault", "status", "--unlock", "--keystore", t.vaultPath], byPassphrase.deps)).toBe(0)
    expect(byPassphrase.calls.filter((call) => call.op === "decrypt")).toHaveLength(0)
  })

  test("the key is not on this Mac: VAULT_FACTOR_UNAVAILABLE, one attempt, no passphrase asked, nothing derived", async () => {
    const t = await vaultWithTouchId()
    await writeFile(t.add.script.store, "{}")
    const h = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, script: { store: t.add.script.store } })
    expect(
      await run(["vault", "status", "--unlock", "--factor", "touch-id", "--json", "--keystore", t.vaultPath], h.deps),
    ).toBe(1)
    expect(failure(h)).toMatchObject({ code: "VAULT_FACTOR_UNAVAILABLE" })
    expect(failure(h).message).toContain("does not hold this envelope's key")
    expect(failure(h).suggestion).toContain("never leaves the Mac")
    expect(h.calls.filter((call) => call.op === "decrypt")).toHaveLength(1)
    expect(h.asked).toEqual([])
  })

  test("Touch ID refusals at unlock are typed and never retried against the passphrase", async () => {
    const t = await vaultWithTouchId()
    const rows: Array<{ fail: { code: string; message: string }; code: string; text: string }> = [
      {
        fail: { code: "CANCELLED", message: "user cancelled" },
        code: "VAULT_AUTHENTICATOR_CANCELLED",
        text: "did not complete",
      },
      {
        fail: { code: "AUTH_FAILED", message: "OSStatus -25293" },
        code: "VAULT_UNLOCK_FAILED",
        text: "enrolled fingerprints changed",
      },
      {
        fail: { code: "LOCKED", message: "biometry lockout" },
        code: "VAULT_AUTHENTICATOR_BLOCKED",
        text: "locked out",
      },
      {
        fail: { code: "BIOMETRY_UNAVAILABLE", message: "lid closed" },
        code: "VAULT_FACTOR_UNAVAILABLE",
        text: "not available right now",
      },
      {
        fail: { code: "SOMETHING_NEW", message: "from a newer helper" },
        code: "VAULT_UNLOCK_FAILED",
        text: "reported SOMETHING_NEW",
      },
    ]
    for (const row of rows) {
      const h = await harness({
        env: { CANDLE_CONFIG_DIR: t.dir },
        script: { store: t.add.script.store, fail: { decrypt: row.fail as { code: "CANCELLED"; message: string } } },
      })
      expect(
        await run(["vault", "status", "--unlock", "--factor", "touch-id", "--json", "--keystore", t.vaultPath], h.deps),
      ).toBe(1)
      expect(failure(h).code).toBe(row.code)
      expect(failure(h).message).toContain(row.text)
      expect(h.asked).toEqual([])
      expect(h.calls.filter((call) => call.op === "decrypt")).toHaveLength(1)
    }
    // The helper terminated by the timeout or an interrupt: cancelled, nothing derived.
    const killed = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, script: { store: t.add.script.store } })
    const inner = killed.deps.spawnHelper
    killed.deps.spawnHelper = async (path, line, o) => {
      if (path !== CODESIGN_PATH && line.includes('"op":"decrypt"'))
        return { stdout: "", stderr: "", exitCode: null, signal: "SIGTERM" }
      return inner(path, line, o)
    }
    expect(
      await run(
        ["vault", "status", "--unlock", "--factor", "touch-id", "--json", "--keystore", t.vaultPath],
        killed.deps,
      ),
    ).toBe(1)
    expect(failure(killed)).toMatchObject({ code: "VAULT_AUTHENTICATOR_CANCELLED" })
  })

  test("at unlock the codesign requirement pins the build identity, and a failing helper is refused before any prompt", async () => {
    const t = await vaultWithTouchId()
    const untrusted = await harness({
      env: { CANDLE_CONFIG_DIR: t.dir },
      script: { store: t.add.script.store },
      codesign: "fail",
    })
    expect(
      await run(
        ["vault", "status", "--unlock", "--factor", "touch-id", "--json", "--keystore", t.vaultPath],
        untrusted.deps,
      ),
    ).toBe(1)
    expect(failure(untrusted)).toMatchObject({ code: "VAULT_HELPER_UNTRUSTED" })
    expect(untrusted.calls.filter((call) => call.op === "decrypt")).toHaveLength(0)
    expect(untrusted.asked).toEqual([])

    // The requirement string carries the build's trusted helper identity.
    const ok = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, script: { store: t.add.script.store } })
    expect(await run(["vault", "status", "--unlock", "--factor", "touch-id", "--keystore", t.vaultPath], ok.deps)).toBe(
      0,
    )
    const requirement = ok.codesign.map((args) => args[4])
    expect(requirement.every((r) => r === codesignRequirement({ teamId: TEAM, bundleId: BUNDLE }))).toBe(true)

    // A foreign identity is refused before codesign or any helper operation.
    const edited = JSON.parse(await readFile(t.vaultPath, "utf8")) as VaultJson
    const env = edited.envelopes.find((candidate) => candidate.factor === "secure-enclave") as Record<string, unknown>
    ;(env.helper as { teamId: string }).teamId = "ZZZZZ99999"
    const editedPath = join(t.dir, "edited.enc")
    await writeFile(editedPath, JSON.stringify(edited))
    const h = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, script: { store: t.add.script.store } })
    expect(
      await run(["vault", "status", "--unlock", "--factor", "touch-id", "--json", "--keystore", editedPath], h.deps),
    ).toBe(1)
    expect(failure(h)).toMatchObject({ code: "VAULT_HELPER_UNTRUSTED" })
    expect(failure(h).message).toContain("This envelope recorded helper ZZZZZ99999")
    expect(failure(h).message).toContain(`${TEAM} / ${BUNDLE}`)
    expect(h.codesign).toEqual([])
    expect(h.calls).toEqual([])
    expect(h.calls.filter((call) => call.op === "decrypt")).toHaveLength(0)

    // Every helper field is inside the envelope AAD: editing minVersion changes nothing the helper
    // checks, the Enclave unwraps the KEK, and the DEK's tag fails. Nothing else is tried.
    const aad = JSON.parse(await readFile(t.vaultPath, "utf8")) as VaultJson
    const aadEnv = aad.envelopes.find((candidate) => candidate.factor === "secure-enclave") as Record<string, unknown>
    ;(aadEnv.helper as { minVersion: string }).minVersion = "0.0.1"
    const aadPath = join(t.dir, "aad.enc")
    await writeFile(aadPath, JSON.stringify(aad))
    const tagged = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, script: { store: t.add.script.store } })
    expect(
      await run(["vault", "status", "--unlock", "--factor", "touch-id", "--json", "--keystore", aadPath], tagged.deps),
    ).toBe(1)
    expect(failure(tagged)).toMatchObject({ code: "VAULT_UNLOCK_FAILED" })
    expect(failure(tagged).suggestion).toContain("no other factor was tried")
    expect(tagged.calls.filter((call) => call.op === "decrypt")).toHaveLength(1)
    expect(tagged.asked).toEqual([])

    // A helper older than the envelope's minVersion is a stale install.
    const stale = await harness({
      env: { CANDLE_CONFIG_DIR: t.dir },
      script: { store: t.add.script.store, version: "0.11.9" },
    })
    expect(
      await run(
        ["vault", "status", "--unlock", "--factor", "touch-id", "--json", "--keystore", t.vaultPath],
        stale.deps,
      ),
    ).toBe(1)
    expect(failure(stale)).toMatchObject({ code: "VAULT_HELPER_MISSING" })
    expect(failure(stale).message).toContain("0.11.9")
  })

  test("status and factor list report availability per machine; a Linux host keeps the envelope and opens with the passphrase", async () => {
    const t = await vaultWithTouchId()
    const here = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, script: { store: t.add.script.store } })
    expect(await run(["vault", "factor", "list", "--json", "--keystore", t.vaultPath], here.deps)).toBe(0)
    const listed = JSON.parse(here.stdout.text) as {
      envelopes: Array<{ factor: string; availability: string; reason?: string }>
      recoverableFactors: number
    }
    expect(listed.envelopes.find((e) => e.factor === "secure-enclave")).toMatchObject({ availability: "available" })
    expect(listed.recoverableFactors).toBe(1)

    const noHelper = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, helper: "absent" })
    expect(await run(["vault", "factor", "list", "--json", "--keystore", t.vaultPath], noHelper.deps)).toBe(0)
    const absent = JSON.parse(noHelper.stdout.text) as {
      envelopes: Array<{ factor: string; availability: string; reason?: string }>
    }
    expect(absent.envelopes.find((e) => e.factor === "secure-enclave")).toMatchObject({
      availability: "unavailable-on-this-device",
    })
    expect(
      await run(
        ["vault", "status", "--unlock", "--factor", "touch-id", "--json", "--keystore", t.vaultPath],
        noHelper.deps,
      ),
    ).toBe(1)
    expect(failure(noHelper)).toMatchObject({ code: "VAULT_HELPER_MISSING" })

    const omit = await harness({ env: { CANDLE_CONFIG_DIR: t.dir }, policy: "omit" })
    expect(
      await run(
        ["vault", "status", "--unlock", "--factor", "touch-id", "--json", "--keystore", t.vaultPath],
        omit.deps,
      ),
    ).toBe(1)
    expect(failure(omit)).toMatchObject({ code: "VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM" })

    const linux = await harness({
      env: { CANDLE_CONFIG_DIR: t.dir },
      platform: "linux",
      arch: "x64",
      secrets: [t.passphrase],
    })
    expect(await run(["vault", "status", "--unlock", "--keystore", t.vaultPath], linux.deps)).toBe(0)
    expect(linux.asked).toEqual(["secret: Vault passphrase (input hidden): "])
    expect(linux.stdout.text).toContain("secure-enclave  this-device  unsupported-on-this-platform")
    expect(linux.calls).toEqual([])
  })

  test("Touch ID counts for nothing recoverable: the last passphrase cannot be removed beside it, and the Touch ID envelope can", async () => {
    const t = await vaultWithTouchId()
    const passphraseId = (await readVault(t.vaultPath)).envelopes.find((e) => e.factor === "passphrase")?.id as string
    const last = await harness({
      env: { CANDLE_CONFIG_DIR: t.dir },
      script: { store: t.add.script.store },
      lines: ["passphrase"],
      secrets: [t.passphrase],
    })
    expect(await run(["vault", "factor", "remove", passphraseId, "--json", "--keystore", t.vaultPath], last.deps)).toBe(
      1,
    )
    expect(failure(last)).toMatchObject({ code: "VAULT_LAST_PASSPHRASE" })

    const remove = await harness({
      env: { CANDLE_CONFIG_DIR: t.dir },
      script: { store: t.add.script.store },
      secrets: [t.passphrase],
    })
    expect(
      await run(
        ["vault", "factor", "remove", t.envelopeId, "--factor", "passphrase", "--keystore", t.vaultPath],
        remove.deps,
      ),
    ).toBe(0)
    expect(remove.stdout.text).toContain("Removing a factor is not revocation")
    expect((await readVault(t.vaultPath)).envelopes).toHaveLength(1)
  })
})

test("native helper identity quotes are refused at parse time without a spawn or prompt", async () => {
  const t = await vaultWithTouchId()
  const original = await readFile(t.vaultPath, "utf8")
  for (const field of ["teamId", "bundleId"] as const) {
    const file = JSON.parse(original) as VaultJson
    const envelope = file.envelopes.find((e) => e.factor === "secure-enclave") as Record<string, unknown>
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
