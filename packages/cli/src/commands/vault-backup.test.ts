/**
 * T35 (invariant 2, AD-2) and the command half of T43: `vault backup --to` and
 * `vault verify-backup`.
 *
 * The classification half is unit-tested directly, because the interesting inputs are paths that
 * cannot exist on the machine running the suite (an iCloud Drive path on a Linux runner), and a
 * test that could only run on a Mac would be a test that never runs.
 *
 * The AD-2 rule and invariant 2 are deliberately tested apart. They are different claims: invariant
 * 2 is about RECOVERABILITY (some recoverable factor must live outside the destination's account),
 * and AD-2's rule is about CONFIDENTIALITY (an Apple-account compromise must not yield both the
 * blob and a factor that opens it). In Phase 2 the first holds by construction through the
 * mandatory passphrase, which is exactly why the second needs its own fixture.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Deps } from "../deps"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"
import {
  accountDomainOf,
  assertBackupDomainAllowed,
  classifyDestination,
  countRecoverableFactors,
} from "../vault/domains"
import type { Envelope } from "../vault/format"
import { readSidecar, sidecarPath } from "../vault/sidecar"
import { flipByte, generatedPassphraseFrom, tamper, useCheapKdf } from "../vault/test-vault"

/**
 * These tests run REAL Argon2id, which is the point of them: a vault suite that stubbed the KDF
 * would not be testing the format anyone actually opens. Even at ED-3's bounds floor (see
 * `useCheapKdf`) a single derivation is a few hundred milliseconds, several tests here do five or
 * six of them, and a CI runner sharing a box with every other workspace's suite is slower again.
 * Bun's default per-test budget is 5 s, which one of these exceeded on CI while passing locally --
 * so the budget is stated here rather than discovered once per runner.
 */
setDefaultTimeout(30_000)

useCheapKdf()

const unreachableFetch = (async () => {
  throw new Error("no test in this file should make a network call")
}) as unknown as typeof fetch

async function harness(opts: { secrets?: string[]; env?: Record<string, string> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "candle-vault-backup-"))
  const stdout = createCapture()
  const stderr = createCapture()
  const secrets = [...(opts.secrets ?? [])]
  const deps: Deps = createTestDeps({
    fetch: unreachableFetch,
    stdout,
    stderr,
    env: { CANDLE_CONFIG_DIR: dir, ...(opts.env ?? {}) },
    isTTY: { stdin: true, stdout: true },
    promptSecret: async () => {
      const next = secrets.shift()
      if (next === undefined) throw new Error("promptSecret asked for more than the test scripted")
      return next
    },
    promptLine: async () => "no",
  })
  return { deps, stdout, stderr, dir, vaultPath: join(dir, "vault.enc") }
}

/** A vault with one derived key, created through the real commands. */
async function vaultWithKey(env?: Record<string, string>) {
  const h = await harness({ env })
  h.deps.promptSecret = async () => generatedPassphraseFrom(h.stdout.text)
  const code = await run(["vault", "init", "--keystore", h.vaultPath], h.deps)
  if (code !== 0) throw new Error(`init failed: ${h.stderr.text}`)
  const passphrase = generatedPassphraseFrom(h.stdout.text)

  const k = await harness({ env: { CANDLE_CONFIG_DIR: h.dir, ...(env ?? {}) }, secrets: [passphrase] })
  if ((await run(["vault", "new-key", "--chain", "solana", "--keystore", h.vaultPath], k.deps)) !== 0) {
    throw new Error(`new-key failed: ${k.stderr.text}`)
  }
  return { ...h, passphrase }
}

describe("T35: destination classification", () => {
  const home = "/Users/someone"

  test("iCloud Drive, other cloud, removable media and local disk", () => {
    expect(classifyDestination(`${home}/Library/Mobile Documents/com~apple~CloudDocs/vault.enc`, home)).toBe(
      "icloud-drive",
    )
    expect(classifyDestination(`${home}/Library/CloudStorage/Dropbox/vault.enc`, home)).toBe("other-cloud")
    expect(classifyDestination(`${home}/Dropbox/vault.enc`, home)).toBe("other-cloud")
    expect(classifyDestination(`${home}/Google Drive/vault.enc`, home)).toBe("other-cloud")
    expect(classifyDestination("/Volumes/BACKUP/vault.enc", home)).toBe("removable-media")
    expect(classifyDestination("/media/usb/vault.enc", home)).toBe("removable-media")
    expect(classifyDestination(`${home}/backups/vault.enc`, home)).toBe("local-disk")
  })

  test("anything it cannot place is unknown, not local-disk", () => {
    // Guessing "local" for an unfamiliar mount is how a network share would pass silently, and both
    // rules below treat `unknown` as "cannot rule out a shared domain".
    expect(classifyDestination("/net/fileserver/backups/vault.enc", home)).toBe("unknown")
    expect(classifyDestination("/srv/nfs/vault.enc", home)).toBe("unknown")
  })

  test("only a cloud destination belongs to an account domain", () => {
    expect(accountDomainOf("icloud-drive")).toBe("apple-account")
    expect(accountDomainOf("other-cloud")).toBe("other-cloud-account")
    expect(accountDomainOf("local-disk")).toBeUndefined()
    expect(accountDomainOf("removable-media")).toBeUndefined()
  })
})

describe("T35: invariant 2 and AD-2's refusal", () => {
  const passphraseEnvelope = {
    id: "p1",
    factor: "passphrase",
    domain: "human-memory",
    label: "",
    createdAt: "",
    wrap: { alg: "AES-256-GCM", iv: "", ciphertext: "" },
  } as unknown as Envelope
  const appleEnvelope = {
    id: "a1",
    factor: "passkey-prf",
    domain: "apple-account",
    label: "",
    createdAt: "",
    backupEligible: true,
    wrap: { alg: "AES-256-GCM", iv: "", ciphertext: "" },
  } as unknown as Envelope
  const home = "/Users/someone"
  const icloud = `${home}/Library/Mobile Documents/com~apple~CloudDocs/vault.enc`

  test("in Phase 2 invariant 2 holds by construction, because a passphrase is mandatory", () => {
    const result = assertBackupDomainAllowed([passphraseEnvelope], icloud, { acceptSharedDomain: true, home })
    expect(result.destination).toBe("icloud-drive")
    expect(countRecoverableFactors([passphraseEnvelope])).toBe(1)
  })

  test("the refusal path is exercised on a fixture with no passphrase envelope", () => {
    // This is the case the check exists FOR: it starts biting the day passphrase removal is ever
    // allowed, and a rule enforced only by another rule disappears silently when that one changes.
    expect(() => assertBackupDomainAllowed([appleEnvelope], icloud, { acceptSharedDomain: true, home })).toThrow(
      /same administrative domain/,
    )
    expect(() => assertBackupDomainAllowed([], icloud, { acceptSharedDomain: true, home })).toThrow(
      /no recoverable factor/,
    )
  })

  test("AD-2: an iCloud destination beside an apple-account envelope is refused without the flag", () => {
    let thrown: unknown
    try {
      assertBackupDomainAllowed([passphraseEnvelope, appleEnvelope], icloud, { acceptSharedDomain: false, home })
    } catch (error) {
      thrown = error
    }
    expect((thrown as { code?: string })?.code).toBe("VAULT_SHARED_DOMAIN")
    expect((thrown as { message?: string })?.message).toContain("one Apple account would hold both")

    // With the flag it is accepted, and the acceptance is what `status` prints afterwards.
    const accepted = assertBackupDomainAllowed([passphraseEnvelope, appleEnvelope], icloud, {
      acceptSharedDomain: true,
      home,
    })
    expect(accepted.sharedDomain).toBe(true)
  })

  test("a local destination beside the same envelope is not a shared domain", () => {
    const result = assertBackupDomainAllowed([passphraseEnvelope, appleEnvelope], `${home}/backups/vault.enc`, {
      acceptSharedDomain: false,
      home,
    })
    expect(result.sharedDomain).toBe(false)
    expect(result.destination).toBe("local-disk")
  })
})

describe("backup runs the full verifier, and records only on a full pass", () => {
  test("a verified copy reports all eight steps and records the destination class", async () => {
    const h = await vaultWithKey()
    const to = join(h.dir, "..", `backup-${Date.now()}.enc`)
    const b = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    expect(await run(["vault", "backup", "--to", to, "--keystore", h.vaultPath], b.deps)).toBe(0)

    expect(b.stdout.text).toContain("all 8 passed, in order")
    expect(b.stdout.text).toContain("keys checked  1")
    expect(b.stdout.text).toContain("re-derived    1")
    expect(b.stdout.text).toContain("address set   matches the live vault")
    // Every backup output prints the counters and the phrase caveat (CC-11, CC-07).
    expect(b.stdout.text).toContain("Derivation counters to keep with your recovery phrase")
    expect(b.stdout.text).toContain("solanaVault  1")
    expect(b.stdout.text).toContain("restores derived keys only")

    const sidecar = await readSidecar(sidecarPath(h.vaultPath))
    expect(sidecar?.lastVerifiedBackupAt).toBeDefined()
    expect(sidecar?.lastBackupDomain).toBeDefined()
  })

  test("a destination inside the config dir is refused before any passphrase is asked for", async () => {
    const h = await vaultWithKey()
    const b = await harness({ env: { CANDLE_CONFIG_DIR: h.dir } })
    const code = await run(["vault", "backup", "--to", join(h.dir, "copy.enc"), "--keystore", h.vaultPath], b.deps)
    expect(code).toBe(1)
    expect(b.stderr.text).toContain("where the vault itself lives")
    expect(b.stderr.text).toContain("lost with it")
    // No secret was collected: the harness's queue was empty and would have thrown.
    await expect(stat(join(h.dir, "copy.enc"))).rejects.toThrow()
  })

  test("an existing destination is not overwritten", async () => {
    const h = await vaultWithKey()
    const to = join(h.dir, "..", `occupied-${Date.now()}.enc`)
    await writeFile(to, "someone else's file\n", "utf8")

    const b = await harness({ env: { CANDLE_CONFIG_DIR: h.dir } })
    expect(await run(["vault", "backup", "--to", to, "--keystore", h.vaultPath], b.deps)).toBe(1)
    expect(b.stderr.text).toContain("already exists")
    expect(await readFile(to, "utf8")).toBe("someone else's file\n")
  })

  test("verify-backup on a corrupt copy fails and records NOTHING", async () => {
    const h = await vaultWithKey()
    const to = join(h.dir, "..", `corrupt-${Date.now()}.enc`)
    const b = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    expect(await run(["vault", "backup", "--to", to, "--keystore", h.vaultPath], b.deps)).toBe(0)
    const recordedAt = (await readSidecar(sidecarPath(h.vaultPath)))?.lastVerifiedBackupAt

    // One flipped byte in the ROOT ciphertext only: the copy still opens, and only the verifier
    // notices, which is the whole reason `verify-backup` is not "open it and compare addresses".
    await tamper(to, (file) => {
      file.root.ciphertext = flipByte(file.root.ciphertext)
    })
    const v = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    expect(await run(["vault", "verify-backup", to, "--keystore", h.vaultPath], v.deps)).toBe(1)
    expect(v.stderr.text).toContain("root blob failed its authentication tag")

    // The copy is left in place for inspection, and nothing new was recorded.
    await stat(to)
    expect((await readSidecar(sidecarPath(h.vaultPath)))?.lastVerifiedBackupAt).toBe(recordedAt)
  })

  test("verify-backup catches a copy of a DIFFERENT vault, which is step 8's job alone", async () => {
    const h = await vaultWithKey()
    const other = await vaultWithKey()
    const v = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    // The other vault's passphrase differs, so it cannot even be opened with this one's; the
    // in-file version of step 8 is asserted in `vault/verify.test.ts`, where both share a factor.
    expect(await run(["vault", "verify-backup", other.vaultPath, "--keystore", h.vaultPath], v.deps)).toBe(1)
    expect(v.stderr.text.length).toBeGreaterThan(0)
  })

  test("--json carries the verdict and the counters, and no secret", async () => {
    const h = await vaultWithKey()
    const to = join(h.dir, "..", `json-${Date.now()}.enc`)
    const b = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    expect(await run(["vault", "backup", "--to", to, "--json", "--keystore", h.vaultPath], b.deps)).toBe(0)
    const body = JSON.parse(b.stdout.text) as Record<string, unknown>
    expect(body).toMatchObject({ ok: true, verified: true, steps: 8, comparedAgainstLive: true })
    expect(b.stdout.text).not.toContain(h.passphrase)
  })
})
