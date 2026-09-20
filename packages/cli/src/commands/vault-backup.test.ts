/**
 * T35 (invariant 2, AD-2) and the command half of T43: `vault backup --to` and
 * `vault verify-backup`.
 *
 * The classification half is unit-tested directly, because the interesting inputs are paths that
 * cannot exist on the machine running the suite (an iCloud Drive path on a Linux runner), and a
 * test that could only run on a Mac would be a test that never runs. BE-236's block is the one
 * exception, and has to be: it builds a real symlink tree in a temp dir, because a symlink is
 * precisely what a string fixture cannot have, and following one is what that fix added.
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
import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises"
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
  isSealedCopy,
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

/**
 * The three envelope shapes the domain rules read: the mandatory passphrase one, a synced passkey
 * in the user's Apple account, and a Secure Enclave wrap bound to this device. Module scope
 * because both the AD-9 block and the BE-236 resolution block below need them.
 */
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

/**
 * BE-236: the classifier resolves links, so every fixture needs a `realpath`. These two are the
 * pair the suite uses. `noLinks` answers "this path is already real", which is what the
 * placement fixtures below want: they are paths that cannot exist on the runner (an iCloud Drive
 * path on a Linux box), and what they exercise is placement, not resolution. `realLinks` is the
 * real `node:fs` resolver, used by the resolution block, which builds an actual symlink tree.
 */
const noLinks = async (path: string) => path
const realLinks = (path: string) => realpath(path)

describe("T35: destination classification", () => {
  const home = "/Users/someone"

  test("iCloud Drive, other cloud, removable media and local disk", async () => {
    expect(
      await classifyDestination(`${home}/Library/Mobile Documents/com~apple~CloudDocs/vault.enc`, {
        realpath: noLinks,
        home,
      }),
    ).toBe("icloud-drive")
    expect(
      await classifyDestination(`${home}/Library/CloudStorage/Dropbox/vault.enc`, { realpath: noLinks, home }),
    ).toBe("other-cloud")
    expect(await classifyDestination(`${home}/Dropbox/vault.enc`, { realpath: noLinks, home })).toBe("other-cloud")
    expect(await classifyDestination(`${home}/Google Drive/vault.enc`, { realpath: noLinks, home })).toBe("other-cloud")
    expect(await classifyDestination("/Volumes/BACKUP/vault.enc", { realpath: noLinks, home })).toBe("removable-media")
    expect(await classifyDestination("/media/usb/vault.enc", { realpath: noLinks, home })).toBe("removable-media")
    expect(await classifyDestination(`${home}/backups/vault.enc`, { realpath: noLinks, home })).toBe("local-disk")
  })

  test("anything it cannot place is unknown, not local-disk", async () => {
    // Guessing "local" for an unfamiliar mount is how a network share would pass silently, and both
    // rules below treat `unknown` as "cannot rule out a shared domain".
    expect(await classifyDestination("/net/fileserver/backups/vault.enc", { realpath: noLinks, home })).toBe("unknown")
    expect(await classifyDestination("/srv/nfs/vault.enc", { realpath: noLinks, home })).toBe("unknown")
  })

  test("only a cloud destination belongs to an account domain", () => {
    expect(accountDomainOf("icloud-drive")).toBe("apple-account")
    expect(accountDomainOf("other-cloud")).toBe("other-cloud-account")
    expect(accountDomainOf("local-disk")).toBeUndefined()
    expect(accountDomainOf("removable-media")).toBeUndefined()
  })
})

/**
 * BE-236, the classification hole, on a REAL symlink tree rather than on strings.
 *
 * `classifyDestination` used `node:path.resolve`, which is purely lexical and never follows a
 * link, so the same file reached through a link and through its real path got opposite verdicts.
 * The shape built here is the one macOS's "Desktop & Documents Folders in iCloud" produces --
 * `~/Documents` is a symlink into `~/Library/Mobile Documents/com~apple~CloudDocs/Documents` --
 * which is why this is a default-on configuration and not an exotic one. `local-disk` writes the
 * full envelope set, so before the fix a user with that setting got an unsealed vault, carrying
 * its Touch ID and synced-passkey envelopes, written into the same Apple account that holds those
 * factors: the exposure AD-9 exists to close.
 *
 * These tests do build the tree on disk. The fixtures cannot be strings, because what is under
 * test is the resolution itself, and a symlink is the one thing a string fixture cannot have.
 */
describe("T35: invariant 2 and AD-9's sealing", () => {
  const home = "/Users/someone"
  const icloud = `${home}/Library/Mobile Documents/com~apple~CloudDocs/vault.enc`
  const dropbox = `${home}/Dropbox/vault.enc`
  /** These fixtures are paths that cannot exist on the runner; resolution has its own block. */
  const lexical = { realpath: noLinks, home }

  test("in Phase 2 invariant 2 holds by construction, because a passphrase is mandatory", async () => {
    const result = await assertBackupDomainAllowed([passphraseEnvelope], icloud, {
      acceptSharedDomain: true,
      ...lexical,
    })
    expect(result.destination).toBe("icloud-drive")
    expect(countRecoverableFactors([passphraseEnvelope])).toBe(1)
  })

  test("the refusal path is exercised on a fixture with no passphrase envelope", async () => {
    // This is the case the check exists FOR: it starts biting the day passphrase removal is ever
    // allowed, and a rule enforced only by another rule disappears silently when that one changes.
    await expect(
      assertBackupDomainAllowed([appleEnvelope], icloud, { acceptSharedDomain: true, ...lexical }),
    ).rejects.toThrow(/same administrative domain/)
    await expect(assertBackupDomainAllowed([], icloud, { acceptSharedDomain: true, ...lexical })).rejects.toThrow(
      /no recoverable factor/,
    )
  })

  test("AD-9: an iCloud destination beside an apple-account envelope is not refused; the copy is sealed by default", async () => {
    const verdict = await assertBackupDomainAllowed([passphraseEnvelope, appleEnvelope, enclaveEnvelope], icloud, {
      acceptSharedDomain: false,
      ...lexical,
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

  test("AD-9: --accept-shared-domain writes an unsealed copy to a cloud destination and records the acceptance", async () => {
    const accepted = await assertBackupDomainAllowed([passphraseEnvelope, appleEnvelope], icloud, {
      acceptSharedDomain: true,
      ...lexical,
    })
    expect(accepted).toMatchObject({ sealed: false, sharedDomain: true, sharedDomainAccepted: true, cloud: true })
  })

  test("AD-9: any other cloud destination is sealed too, even with no apple-account envelope", async () => {
    expect(
      await assertBackupDomainAllowed([passphraseEnvelope], dropbox, { acceptSharedDomain: false, ...lexical }),
    ).toEqual({
      destination: "other-cloud",
      cloud: true,
      sealsByDefault: true,
      sharedDomain: false,
      sealed: true,
      sharedDomainAccepted: false,
    })
    expect(
      await assertBackupDomainAllowed([passphraseEnvelope, enclaveEnvelope], dropbox, {
        acceptSharedDomain: true,
        ...lexical,
      }),
    ).toMatchObject({ sealed: false, sharedDomainAccepted: true })
  })

  test("a local destination beside the same envelope is neither sealed nor a shared domain, flag or no flag", async () => {
    for (const acceptSharedDomain of [false, true]) {
      const result = await assertBackupDomainAllowed([passphraseEnvelope, appleEnvelope], `${home}/backups/vault.enc`, {
        acceptSharedDomain,
        ...lexical,
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
      (
        await assertBackupDomainAllowed([passphraseEnvelope, appleEnvelope], "/Volumes/BACKUP/vault.enc", {
          acceptSharedDomain: false,
          ...lexical,
        })
      ).sealed,
    ).toBe(false)
  })

  // BE-205, the AD-9 amendment (Andrew, 2026-09-19). The two paths below are the same ones the
  // classification test above calls `unknown`: a network share and an NFS mount. Before this
  // amendment each received an unsealed copy carrying every envelope, including the synced-passkey
  // and Enclave wraps, which is the exposure AD-9 closed for a recognised cloud folder.
  describe("AD-9 amendment: a destination Candle cannot place seals like a cloud one", () => {
    const unplaceable = ["/net/fileserver/backups/vault.enc", "/srv/nfs/vault.enc"]

    test("the default copy holds the passphrase envelopes and nothing else", async () => {
      for (const path of unplaceable) {
        expect(await classifyDestination(path, lexical)).toBe("unknown")
        expect(
          await assertBackupDomainAllowed([passphraseEnvelope, appleEnvelope, enclaveEnvelope], path, {
            acceptSharedDomain: false,
            ...lexical,
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

    test("--accept-shared-domain writes the full set and records the acceptance", async () => {
      for (const path of unplaceable) {
        expect(
          await assertBackupDomainAllowed([passphraseEnvelope, appleEnvelope, enclaveEnvelope], path, {
            acceptSharedDomain: true,
            ...lexical,
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

    test("an unknown destination never refuses: invariant 2 has no account domain to compare", async () => {
      // The vault carrying only the apple-account envelope is refused for iCloud Drive above. The
      // same vault is allowed here, sealed, because `unknown` belongs to no account.
      expect(accountDomainOf("unknown")).toBeUndefined()
      expect(
        (
          await assertBackupDomainAllowed([appleEnvelope], "/srv/nfs/vault.enc", {
            acceptSharedDomain: false,
            ...lexical,
          })
        ).sealed,
      ).toBe(true)
    })

    test("only a recognised local disk or removable drive still gets the full set by default", async () => {
      expect(sealsByDefault("local-disk")).toBe(false)
      expect(sealsByDefault("removable-media")).toBe(false)
      expect(sealsByDefault("icloud-drive")).toBe(true)
      expect(sealsByDefault("other-cloud")).toBe(true)
      expect(sealsByDefault("unknown")).toBe(true)
      for (const path of [`${home}/backups/vault.enc`, "/Volumes/BACKUP/vault.enc"]) {
        expect(
          await assertBackupDomainAllowed([passphraseEnvelope, appleEnvelope, enclaveEnvelope], path, {
            acceptSharedDomain: false,
            ...lexical,
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

describe("BE-236: the destination is classified from the real path, not its spelling", () => {
  /** A home with the Apple shape: a real CloudDocs tree and `Documents` linked into it. */
  async function appleHome() {
    const home = await mkdtemp(join(tmpdir(), "candle-vault-links-"))
    const cloudDocs = join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "Documents")
    await mkdir(cloudDocs, { recursive: true })
    await symlink(cloudDocs, join(home, "Documents"))
    await mkdir(join(home, "backups"), { recursive: true })
    return { home, cloudDocs }
  }

  test("a path through the iCloud Documents symlink classifies as the real path does", async () => {
    const { home, cloudDocs } = await appleHome()
    const throughLink = join(home, "Documents", "candle-vault.enc")
    const realPath = join(cloudDocs, "candle-vault.enc")

    // The regression itself: same file, same destination, and before the fix opposite verdicts --
    // `local-disk` through the link and `icloud-drive` by its real path.
    expect(await classifyDestination(throughLink, { realpath: realLinks, home })).toBe("icloud-drive")
    expect(await classifyDestination(realPath, { realpath: realLinks, home })).toBe(
      await classifyDestination(throughLink, { realpath: realLinks, home }),
    )
    // A deeper path through the same link resolves too; it is the directory components that matter.
    await mkdir(join(cloudDocs, "vaults"), { recursive: true })
    expect(
      await classifyDestination(join(home, "Documents", "vaults", "candle-vault.enc"), {
        realpath: realLinks,
        home,
      }),
    ).toBe("icloud-drive")
  })

  test("a link into a sync client's folder is other-cloud, not local-disk", async () => {
    // The Apple feature is not needed to reach this state: any link, alias or bind mount into a
    // synced folder does, which is why the fix is resolution rather than a longer marker list.
    const home = await mkdtemp(join(tmpdir(), "candle-vault-links-"))
    await mkdir(join(home, "Dropbox", "secure"), { recursive: true })
    await symlink(join(home, "Dropbox", "secure"), join(home, "safe"))
    expect(await classifyDestination(join(home, "safe", "vault.enc"), { realpath: realLinks, home })).toBe(
      "other-cloud",
    )
  })

  test("resolution does not seal an ordinary local destination", async () => {
    // The fix must not turn every backup into a sealed one: a real directory under home still
    // gets the full envelope set, and so does a path spelled with `..` that lands there.
    const { home } = await appleHome()
    expect(await classifyDestination(join(home, "backups", "vault.enc"), { realpath: realLinks, home })).toBe(
      "local-disk",
    )
    expect(
      await classifyDestination(join(home, "Documents", "..", "backups", "vault.enc"), { realpath: realLinks, home }),
    ).toBe("local-disk")
  })

  test("a link OUT of a cloud folder to a local one is local-disk: the rule is symmetric", async () => {
    // The fix reads where the bytes land, in both directions. A cloud-looking spelling that
    // resolves onto an ordinary disk is not sealed, because there is no account to share.
    const home = await mkdtemp(join(tmpdir(), "candle-vault-links-"))
    const cloudDocs = join(home, "Library", "Mobile Documents", "com~apple~CloudDocs")
    await mkdir(cloudDocs, { recursive: true })
    await mkdir(join(home, "on-disk"), { recursive: true })
    await symlink(join(home, "on-disk"), join(cloudDocs, "elsewhere"))
    expect(await classifyDestination(join(cloudDocs, "elsewhere", "vault.enc"), { realpath: realLinks, home })).toBe(
      "local-disk",
    )
  })

  test("a destination whose parent does not exist is unknown, never local-disk", async () => {
    // The wrinkle this fix had to design around: the destination file does not exist yet, so the
    // resolve is of its containing directory, and that resolve can fail. Falling back to the
    // lexical answer here would rebuild the hole, because a path under home always matched the
    // `local-disk` branch first. `unknown` seals (AD-9 amendment, 2026-09-19).
    const { home } = await appleHome()
    const missingParent = join(home, "no-such-dir", "vault.enc")
    expect(await classifyDestination(missingParent, { realpath: realLinks, home })).toBe("unknown")
    expect(await classifyDestination(join(home, "a", "b", "c", "vault.enc"), { realpath: realLinks, home })).toBe(
      "unknown",
    )
    // A symlink loop is unresolvable for a different reason and lands in the same place.
    await symlink(join(home, "loop-b"), join(home, "loop-a"))
    await symlink(join(home, "loop-a"), join(home, "loop-b"))
    expect(await classifyDestination(join(home, "loop-a", "vault.enc"), { realpath: realLinks, home })).toBe("unknown")
  })

  test("an unresolvable home falls back to its spelling: home is not what is being placed", async () => {
    // Home failing to resolve says nothing about the destination, so it must not seal one. Only
    // the cloud markers read home, and the destination here resolves perfectly well without it.
    const real = await mkdtemp(join(tmpdir(), "candle-vault-nohome-"))
    const withoutHome = await classifyDestination(join(real, "vault.enc"), {
      realpath: realLinks,
      home: "/no/such/home",
    })
    expect(withoutHome).toBe(await classifyDestination(join(real, "vault.enc"), { realpath: realLinks, home: real }))
    expect(sealsByDefault(withoutHome)).toBe(false)
  })

  test("the whole rule, end to end: a symlinked iCloud destination seals the copy", async () => {
    // What the hole actually cost: `assertBackupDomainAllowed` is the one decision point, and
    // through the link it returned the full envelope set. The envelopes below are the exposure --
    // a synced passkey in the same Apple account as the destination.
    const { home, cloudDocs } = await appleHome()
    const through = join(home, "Documents", "candle-vault.enc")
    const envelopes = [passphraseEnvelope, appleEnvelope, enclaveEnvelope]
    const verdict = await assertBackupDomainAllowed(envelopes, through, {
      acceptSharedDomain: false,
      realpath: realLinks,
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
    // Identical to the verdict on the real path, which is the property that was broken.
    expect(verdict).toEqual(
      await assertBackupDomainAllowed(envelopes, join(cloudDocs, "candle-vault.enc"), {
        acceptSharedDomain: false,
        realpath: realLinks,
        home,
      }),
    )
    expect(sealedEnvelopes(envelopes).map((e) => e.id)).toEqual(["p1"])

    // And a missing parent under the same home seals too, rather than reporting a local backup.
    expect(
      await assertBackupDomainAllowed(envelopes, join(home, "no-such-dir", "vault.enc"), {
        acceptSharedDomain: false,
        realpath: realLinks,
        home,
      }),
    ).toMatchObject({ destination: "unknown", sealed: true, cloud: false })
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

/**
 * BE-236 through the real command, which is where the hole actually cost something: the unit
 * tests above prove the classifier, and these prove that `vault backup` reads it. Before the fix
 * the first of these wrote an UNSEALED copy -- every envelope, including the synced-passkey and
 * Enclave wraps -- into a directory that is iCloud Drive, and reported it as a local-disk backup.
 */
describe("BE-236: `vault backup` through a symlink into iCloud", () => {
  /** A temp tree in macOS's "Desktop & Documents Folders in iCloud" shape. */
  async function icloudTree() {
    const root = await mkdtemp(join(tmpdir(), "candle-vault-icloud-"))
    const cloudDocs = join(root, "Library", "Mobile Documents", "com~apple~CloudDocs", "Documents")
    await mkdir(cloudDocs, { recursive: true })
    await symlink(cloudDocs, join(root, "Documents"))
    return { root, cloudDocs }
  }

  test("the copy is sealed and recorded as icloud-drive, not written whole as local-disk", async () => {
    const h = await vaultWithKey()
    const { root, cloudDocs } = await icloudTree()
    const to = join(root, "Documents", "candle-vault.enc")

    const b = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase, h.passphrase] })
    // The real resolver: resolution is what is under test. The suite's default fake answers "this
    // path is already real", which is the lexical behaviour this card removed.
    b.deps.realpath = realLinks
    expect(await run(["vault", "backup", "--to", to, "--keystore", h.vaultPath], b.deps)).toBe(0)

    expect(b.stdout.text).toContain("destination   icloud-drive")
    expect(b.stdout.text).toContain("sealed        yes")
    const sidecar = await readSidecar(sidecarPath(h.vaultPath))
    expect(sidecar?.lastBackupDomain).toBe("icloud-drive")
    expect(sidecar?.lastBackupSealed).toBe(true)
    // The bytes landed behind the link, and what landed there is a sealed copy.
    expect(isSealedCopy(await readFile(join(cloudDocs, "candle-vault.enc"), "utf8"))).toBe(true)
  })

  test("a destination whose parent does not exist is sealed as unknown, and says why", async () => {
    // The missing-parent case end to end. The backup still happens -- `unknown` seals, it does not
    // refuse -- and the operator is told it was the not-knowing that produced the smaller copy.
    const h = await vaultWithKey()
    const { root } = await icloudTree()
    const to = join(root, "no-such-dir", "candle-vault.enc")

    const b = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase, h.passphrase] })
    b.deps.realpath = realLinks
    expect(await run(["vault", "backup", "--to", to, "--keystore", h.vaultPath], b.deps)).toBe(0)

    expect(b.stdout.text).toContain("destination   unknown")
    expect(b.stdout.text).toContain(UNPLACEABLE_DESTINATION_NOTE)
    const sidecar = await readSidecar(sidecarPath(h.vaultPath))
    expect(sidecar?.lastBackupDomain).toBe("unknown")
    expect(sidecar?.lastBackupSealed).toBe(true)
    expect(isSealedCopy(await readFile(to, "utf8"))).toBe(true)
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
