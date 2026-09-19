/**
 * T35 (invariant 2, AD-2) and the command half of T43: `vault backup --to` and
 * `vault verify-backup`.
 *
 * The classification half is unit-tested directly, because the interesting inputs are paths that
 * cannot exist on the machine running the suite (an iCloud Drive path on a Linux runner), and a
 * test that could only run on a Mac would be a test that never runs.
 *
 * The AD-9 rule and invariant 2 are deliberately tested apart. They are different claims: invariant
 * 2 is about RECOVERABILITY (some recoverable factor must live outside the destination's account),
 * and AD-9's rule is about CONFIDENTIALITY (an Apple-account compromise must not yield both the
 * blob and a factor that opens it, so a cloud copy is sealed to the passphrase envelope by default).
 * The AD-9 amendment (Andrew, 2026-09-19; BE-205) extends the second rule to `unknown` and leaves
 * the first alone, which is why the `unknown` cases below assert a sealed copy and no refusal.
 * In Phase 2 the first holds by construction through the mandatory passphrase, which is exactly
 * why the second needs its own fixture. The end-to-end sealed backup, on a vault carrying a synced
 * passkey envelope, is in `vault-passkey.test.ts`.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, posix, win32 } from "node:path"
import type { Deps } from "../deps"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"
import {
  accountDomainOf,
  assertBackupDomainAllowed,
  classifyDestination,
  countRecoverableFactors,
  sealedEnvelopes,
  sealsByDefault,
} from "../vault/domains"
import type { Envelope } from "../vault/format"
import { readSidecar, sidecarPath } from "../vault/sidecar"
import { flipByte, generatedPassphraseFrom, tamper, useCheapKdf } from "../vault/test-vault"
import {
  assertOutsideConfigDir,
  backupVerdictLines,
  isInsideDir,
  sealReason,
  sharedDomainLine,
  UNPLACEABLE_DESTINATION_NOTE,
} from "./vault-backup"

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

describe("T35: invariant 2 and AD-9's sealing", () => {
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
    transport: "platform-macos",
    domain: "apple-account",
    label: "",
    createdAt: "",
    backupEligible: true,
    wrap: { alg: "AES-256-GCM", iv: "", ciphertext: "" },
  } as unknown as Envelope
  const enclaveEnvelope = {
    id: "e1",
    factor: "secure-enclave",
    domain: "this-device",
    label: "",
    createdAt: "",
    wrap: { alg: "AES-256-GCM", iv: "", ciphertext: "" },
  } as unknown as Envelope
  const home = "/Users/someone"
  const icloud = `${home}/Library/Mobile Documents/com~apple~CloudDocs/vault.enc`
  const dropbox = `${home}/Dropbox/vault.enc`

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

  test("AD-9: an iCloud destination beside an apple-account envelope is not refused; the copy is sealed by default", () => {
    const verdict = assertBackupDomainAllowed([passphraseEnvelope, appleEnvelope, enclaveEnvelope], icloud, {
      acceptSharedDomain: false,
      home,
    })
    expect(verdict).toEqual({
      destination: "icloud-drive",
      cloud: true,
      sealsByDefault: true,
      sharedDomain: true,
      sealed: true,
      sharedDomainAccepted: false,
    })
    // The sealed copy keeps every passphrase envelope and nothing else.
    expect(sealedEnvelopes([passphraseEnvelope, appleEnvelope, enclaveEnvelope]).map((e) => e.id)).toEqual(["p1"])
    expect(
      sealedEnvelopes([passphraseEnvelope, { ...passphraseEnvelope, id: "p2" }, appleEnvelope]).map((e) => e.id),
    ).toEqual(["p1", "p2"])
  })

  test("AD-9: --accept-shared-domain writes an unsealed copy to a cloud destination and records the acceptance", () => {
    const accepted = assertBackupDomainAllowed([passphraseEnvelope, appleEnvelope], icloud, {
      acceptSharedDomain: true,
      home,
    })
    expect(accepted).toMatchObject({ sealed: false, sharedDomain: true, sharedDomainAccepted: true, cloud: true })
  })

  test("AD-9: any other cloud destination is sealed too, even with no apple-account envelope", () => {
    expect(assertBackupDomainAllowed([passphraseEnvelope], dropbox, { acceptSharedDomain: false, home })).toEqual({
      destination: "other-cloud",
      cloud: true,
      sealsByDefault: true,
      sharedDomain: false,
      sealed: true,
      sharedDomainAccepted: false,
    })
    expect(
      assertBackupDomainAllowed([passphraseEnvelope, enclaveEnvelope], dropbox, { acceptSharedDomain: true, home }),
    ).toMatchObject({ sealed: false, sharedDomainAccepted: true })
  })

  test("a local destination beside the same envelope is neither sealed nor a shared domain, flag or no flag", () => {
    for (const acceptSharedDomain of [false, true]) {
      const result = assertBackupDomainAllowed([passphraseEnvelope, appleEnvelope], `${home}/backups/vault.enc`, {
        acceptSharedDomain,
        home,
      })
      expect(result).toEqual({
        destination: "local-disk",
        cloud: false,
        sealsByDefault: false,
        sharedDomain: false,
        sealed: false,
        sharedDomainAccepted: false,
      })
    }
    expect(
      assertBackupDomainAllowed([passphraseEnvelope, appleEnvelope], "/Volumes/BACKUP/vault.enc", {
        acceptSharedDomain: false,
        home,
      }).sealed,
    ).toBe(false)
  })

  // BE-205, the AD-9 amendment (Andrew, 2026-09-19). The two paths below are the same ones the
  // classification test above calls `unknown`: a network share and an NFS mount. Before this
  // amendment each received an unsealed copy carrying every envelope, including the synced-passkey
  // and Enclave wraps, which is the exposure AD-9 closed for a recognised cloud folder.
  describe("AD-9 amendment: a destination Candle cannot place seals like a cloud one", () => {
    const unplaceable = ["/net/fileserver/backups/vault.enc", "/srv/nfs/vault.enc"]

    test("the default copy holds the passphrase envelopes and nothing else", () => {
      for (const path of unplaceable) {
        expect(classifyDestination(path, home)).toBe("unknown")
        expect(
          assertBackupDomainAllowed([passphraseEnvelope, appleEnvelope, enclaveEnvelope], path, {
            acceptSharedDomain: false,
            home,
          }),
        ).toEqual({
          destination: "unknown",
          // `unknown` has no account domain, so invariant 2 and its label are untouched: only the
          // confidentiality rule reads the amendment.
          cloud: false,
          sealsByDefault: true,
          sharedDomain: false,
          sealed: true,
          sharedDomainAccepted: false,
        })
      }
      expect(sealedEnvelopes([passphraseEnvelope, appleEnvelope, enclaveEnvelope]).map((e) => e.id)).toEqual(["p1"])
    })

    test("--accept-shared-domain writes the full set and records the acceptance", () => {
      for (const path of unplaceable) {
        expect(
          assertBackupDomainAllowed([passphraseEnvelope, appleEnvelope, enclaveEnvelope], path, {
            acceptSharedDomain: true,
            home,
          }),
        ).toEqual({
          destination: "unknown",
          cloud: false,
          sealsByDefault: true,
          sharedDomain: false,
          sealed: false,
          // What `vault backup` writes to the sidecar as `lastBackupSharedDomainAccepted`.
          sharedDomainAccepted: true,
        })
      }
    })

    test("an unknown destination never refuses: invariant 2 has no account domain to compare", () => {
      // The vault carrying only the apple-account envelope is refused for iCloud Drive above. The
      // same vault is allowed here, sealed, because `unknown` belongs to no account.
      expect(accountDomainOf("unknown")).toBeUndefined()
      expect(
        assertBackupDomainAllowed([appleEnvelope], "/srv/nfs/vault.enc", { acceptSharedDomain: false, home }).sealed,
      ).toBe(true)
    })

    test("only a recognised local disk or removable drive still gets the full set by default", () => {
      expect(sealsByDefault("local-disk")).toBe(false)
      expect(sealsByDefault("removable-media")).toBe(false)
      expect(sealsByDefault("icloud-drive")).toBe(true)
      expect(sealsByDefault("other-cloud")).toBe(true)
      expect(sealsByDefault("unknown")).toBe(true)
      for (const path of [`${home}/backups/vault.enc`, "/Volumes/BACKUP/vault.enc"]) {
        expect(
          assertBackupDomainAllowed([passphraseEnvelope, appleEnvelope, enclaveEnvelope], path, {
            acceptSharedDomain: false,
            home,
          }),
        ).toMatchObject({ sealsByDefault: false, sealed: false, sharedDomainAccepted: false })
      }
    })

    test("the copy says what could not be told, not that a class was unknown", () => {
      // "unknown destination" reads as a failure of the tool. What the operator needs is the fact
      // that produced the smaller copy, and the flag that writes the full one instead.
      expect(sealReason("unknown", "/srv/nfs/vault.enc")).toBe(
        "Candle cannot tell whether /srv/nfs/vault.enc syncs to an account",
      )
      expect(sealReason("icloud-drive", "/i/vault.enc")).toBe("/i/vault.enc is a icloud-drive destination")
      expect(UNPLACEABLE_DESTINATION_NOTE).toContain("cannot tell whether this path syncs to an account")
      expect(UNPLACEABLE_DESTINATION_NOTE).toContain("opens only with the passphrase")
      expect(UNPLACEABLE_DESTINATION_NOTE).toContain("--accept-shared-domain")
    })

    test("the report states the class, the sealed envelope set, and why it was sealed", () => {
      expect(backupVerdictLines({ destination: "unknown", sealed: true }, ["p1"], ["a1", "e1"])).toEqual([
        "  destination   unknown",
        "  sealed        yes: passphrase envelope(s) p1 only; left out a1, e1",
        `  why sealed    ${UNPLACEABLE_DESTINATION_NOTE}`,
      ])
      // A cloud destination names itself and gains no extra line, so the existing output is intact.
      expect(backupVerdictLines({ destination: "icloud-drive", sealed: true }, ["p1"], ["a1"])).toEqual([
        "  destination   icloud-drive",
        "  sealed        yes: passphrase envelope(s) p1 only; left out a1",
      ])
      expect(backupVerdictLines({ destination: "local-disk", sealed: false }, ["p1"], [])).toEqual([
        "  destination   local-disk",
      ])
    })

    test("an accepted unsealed copy to an unplaceable path says what was accepted", () => {
      expect(sharedDomainLine({ destination: "unknown", sharedDomain: false, sharedDomainAccepted: true })).toContain(
        "carries every envelope to a path Candle cannot place, which may sync to an account",
      )
      expect(
        sharedDomainLine({ destination: "other-cloud", sharedDomain: false, sharedDomainAccepted: true }),
      ).toContain("carries every envelope into a cloud account")
      expect(
        sharedDomainLine({ destination: "icloud-drive", sharedDomain: true, sharedDomainAccepted: true }),
      ).toContain("are one Apple account")
    })
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

describe("BE-178 finding 5: the config-dir guard on Windows-shaped paths", () => {
  test("isInsideDir follows path.relative on both platforms", () => {
    const config = "C:\\Users\\me\\.config\\candle"
    expect(isInsideDir(config, "C:\\Users\\me\\.config\\candle\\copy.enc", win32)).toBe(true)
    expect(isInsideDir(config, "C:\\Users\\me\\.config\\candle", win32)).toBe(true)
    expect(isInsideDir(config, "C:\\Users\\me\\.config\\candle\\deep\\copy.enc", win32)).toBe(true)
    expect(isInsideDir(config, "c:\\users\\ME\\.config\\Candle\\copy.enc", win32)).toBe(true)
    expect(isInsideDir(config, "C:\\Users\\me\\.config\\candle-backups\\copy.enc", win32)).toBe(false)
    expect(isInsideDir(config, "C:\\Users\\me\\.config\\copy.enc", win32)).toBe(false)
    expect(isInsideDir(config, "D:\\backups\\copy.enc", win32)).toBe(false)

    expect(isInsideDir("/home/me/.config/candle", "/home/me/.config/candle/copy.enc", posix)).toBe(true)
    expect(isInsideDir("/home/me/.config/candle", "/home/me/.config/candle", posix)).toBe(true)
    expect(isInsideDir("/home/me/.config/candle", "/home/me/.config/candle-backups/copy.enc", posix)).toBe(false)
    expect(isInsideDir("/home/me/.config/candle", "/home/me/.config/copy.enc", posix)).toBe(false)
    // A name that merely starts with two dots is a child, not a parent.
    expect(isInsideDir("/home/me/.config/candle", "/home/me/.config/candle/..copy.enc", posix)).toBe(true)
  })

  test("assertOutsideConfigDir refuses a Windows destination inside CANDLE_CONFIG_DIR", () => {
    const env = { CANDLE_CONFIG_DIR: "C:\\Users\\me\\.config\\candle" }
    expect(() => assertOutsideConfigDir("C:\\Users\\me\\.config\\candle\\copy.enc", env, win32)).toThrow(
      /where the vault itself lives/,
    )
    expect(() => assertOutsideConfigDir("D:\\backups\\copy.enc", env, win32)).not.toThrow()
    expect(() => assertOutsideConfigDir("C:\\Users\\me\\.config\\candle-backups\\copy.enc", env, win32)).not.toThrow()
  })
})
