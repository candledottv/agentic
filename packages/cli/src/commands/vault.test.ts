/**
 * The `candle vault …` commands, end to end through `run()`: T33 (AD-6's passphrase policy), T34
 * (invariant 1), T35 (invariant 2 and AD-2's backup rule), T39 (AD-3's removals), T44 (ED-6's
 * rollback handling), T45 (factor changes and N1) and T54 (the phrase ceremony).
 *
 * Every test drives the real dispatcher with fake `Deps`, so what is exercised is the command an
 * operator types rather than the function behind it. The TTY seam is `deps.isTTY`, which the
 * ceremonies refuse on, and prompts are scripted queues: a command that asks for more input than
 * the test scripted fails loudly instead of hanging.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rename, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Deps } from "../deps"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"
import { GENERATED_WORD_COUNT, SAVE_THE_PASSPHRASE, SAVED_IT_PROMPT } from "../vault/passphrase"
import { readSidecar, sidecarPath } from "../vault/sidecar"
import { generatedPassphraseFrom, makeVault, useCheapKdf } from "../vault/test-vault"
import { INIT_PASSPHRASE_PROMPT } from "./vault-init"
import { NO_VERIFIED_BACKUP_NOTE } from "./vault-status"

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

interface Harness {
  deps: Deps
  stdout: ReturnType<typeof createCapture>
  stderr: ReturnType<typeof createCapture>
  /** Everything the run was asked for, in order, so a test can assert what was prompted. */
  asked: string[]
  dir: string
  vaultPath: string
}

async function harness(
  opts: { secrets?: string[]; lines?: string[]; env?: Record<string, string>; tty?: boolean } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "candle-vault-cmd-"))
  const stdout = createCapture()
  const stderr = createCapture()
  const asked: string[] = []
  const secrets = [...(opts.secrets ?? [])]
  const lines = [...(opts.lines ?? [])]
  const deps = createTestDeps({
    fetch: unreachableFetch,
    stdout,
    stderr,
    // HOME is the harness's own temp dir, never the developer's (BE-245). `vault init` offers an
    // iCloud Drive backup when `$HOME/Library/Mobile Documents/com~apple~CloudDocs` exists, so a
    // suite that inherited the real home would prompt on a Mac and not on CI.
    env: { CANDLE_CONFIG_DIR: dir, HOME: dir, ...(opts.env ?? {}) },
    isTTY: { stdin: opts.tty ?? true, stdout: opts.tty ?? true },
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
  return { deps, stdout, stderr, asked, dir, vaultPath: join(dir, "vault.enc") }
}

/**
 * `init` on the generated default, with the phrase ceremony declined.
 *
 * Three lines and NO secret, which is the shape BE-245 left behind: Enter at D8's passphrase
 * choice (the generated branch), Enter to acknowledge having saved it, and "no" at the recovery
 * phrase ceremony. The passphrase is generated inside the run, so it is read off the captured
 * stdout afterwards -- exactly where the operator reads it.
 */
async function initVault(
  opts: { args?: string[]; env?: Record<string, string> } = {},
): Promise<Harness & { passphrase: string }> {
  const h = await harness({ env: opts.env, lines: ["", "", "no"] })
  const code = await run(["vault", "init", ...(opts.args ?? []), "--keystore", h.vaultPath], h.deps)
  if (code !== 0) throw new Error(`init failed (${code}): ${h.stderr.text}${h.stdout.text}`)
  return { ...h, passphrase: generatedPassphraseFrom(h.stdout.text) }
}

describe("T33: AD-6's passphrase policy", () => {
  test("the generated passphrase is 8 words, and nothing hidden is ever typed for it (BE-245)", async () => {
    const h = await initVault()

    expect(h.passphrase.split(" ")).toHaveLength(GENERATED_WORD_COUNT)
    // The copy-back is gone, and with it the reason an operator reached for the clipboard. The
    // generated branch asks for NO hidden input at all: every prompt it raises is a visible line.
    expect(h.asked.filter((text) => text.startsWith("secret: "))).toEqual([])
    expect(h.stdout.text).not.toContain("Type it back in full")
  })

  test("the words are followed by where to save them, and by an acknowledgement (BE-245)", async () => {
    const h = await initVault()

    // The sentence that was missing: where it goes, that this CLI cannot get it back, and what
    // the fallback is. Below the words, so it is read with them in view.
    const words = h.stdout.text.indexOf(h.passphrase)
    const save = h.stdout.text.indexOf(SAVE_THE_PASSPHRASE)
    expect(words).toBeGreaterThan(-1)
    expect(save).toBeGreaterThan(words)
    expect(SAVE_THE_PASSPHRASE).toContain("password manager or on paper")
    expect(SAVE_THE_PASSPHRASE).toContain("cannot recover it")
    expect(SAVE_THE_PASSPHRASE).toContain("24-word recovery phrase")
    // And the acknowledgement says what it is. It checks nothing, and claims nothing.
    expect(h.asked).toContain(`line: ${SAVED_IT_PROMPT}`)
    expect(SAVED_IT_PROMPT).toContain("when you have saved it")
  })

  test("D8's choice is offered at init too: Enter generates, own chooses (BE-245)", async () => {
    // `restore` shipped this prompt in 0.11.1 and `init` did not, which left the same decision
    // discoverable through one command and invisible through the other.
    const h = await initVault()
    expect(h.asked[0]).toBe(`line: ${INIT_PASSPHRASE_PROMPT}`)
    expect(INIT_PASSPHRASE_PROMPT).toContain("Press Enter to have one generated")
    expect(INIT_PASSPHRASE_PROMPT).toContain("type own")
    // "typed back" went with the retype: the prompt may not promise a step that no longer runs.
    expect(INIT_PASSPHRASE_PROMPT).not.toContain("typed back")

    const chosen = "a passphrase I picked myself"
    const own = await harness({ secrets: [chosen, chosen], lines: ["own", "no"] })
    expect(await run(["vault", "init", "--keystore", own.vaultPath], own.deps)).toBe(0)
    const file = JSON.parse(await readFile(own.vaultPath, "utf8")) as { envelopes: Array<{ strength: string }> }
    expect(file.envelopes[0]?.strength).toBe("user-chosen")
  })

  test("the generated passphrase is drawn from a 7776-word list and is shown once", async () => {
    const { EFF_LONG_WORDLIST } = await import("../vault/eff-wordlist")
    expect(EFF_LONG_WORDLIST).toHaveLength(7776)
    expect(new Set(EFF_LONG_WORDLIST).size).toBe(7776)

    const h = await initVault()
    const passphrase = h.passphrase
    for (const word of passphrase.split(" ")) expect(EFF_LONG_WORDLIST).toContain(word)
    // Shown once: it appears in the rendered block and nowhere else in the output.
    expect(h.stdout.text.split(passphrase)).toHaveLength(2)
  })

  test("the strength label is recorded in the envelope and shown by status", async () => {
    const h = await initVault()
    const file = JSON.parse(await readFile(h.vaultPath, "utf8")) as { envelopes: Array<{ strength: string }> }
    expect(file.envelopes[0]?.strength).toBe("generated-103")

    const s = await harness({ env: { CANDLE_CONFIG_DIR: h.dir } })
    await run(["vault", "status", "--keystore", h.vaultPath], s.deps)
    expect(s.stdout.text).toContain("generated, 8 words (about 103 bits)")
  })

  test("--own-passphrase under 16 characters, or on the denylist, is refused", async () => {
    const short = await harness({ secrets: ["too short"] })
    expect(await run(["vault", "init", "--own-passphrase", "--keystore", short.vaultPath], short.deps)).toBe(1)
    expect(short.stderr.text).toContain("at least 16 characters")
    await expect(stat(short.vaultPath)).rejects.toThrow()

    const denied = await harness({ secrets: ["correct horse battery staple"] })
    expect(await run(["vault", "init", "--own-passphrase", "--keystore", denied.vaultPath], denied.deps)).toBe(1)
    expect(denied.stderr.text).toContain("list of common passphrases")
    await expect(stat(denied.vaultPath)).rejects.toThrow()
  })

  test("--own-passphrase records user-chosen, and the output says the entropy is unknown", async () => {
    const chosen = "a passphrase I picked myself"
    const h = await harness({ secrets: [chosen, chosen], lines: ["no"] })
    expect(await run(["vault", "init", "--own-passphrase", "--keystore", h.vaultPath], h.deps)).toBe(0)

    const file = JSON.parse(await readFile(h.vaultPath, "utf8")) as { envelopes: Array<{ strength: string }> }
    expect(file.envelopes[0]?.strength).toBe("user-chosen")

    const s = await harness({ env: { CANDLE_CONFIG_DIR: h.dir } })
    await run(["vault", "status", "--keystore", h.vaultPath], s.deps)
    expect(s.stdout.text).toContain("this CLI cannot know its entropy")
  })

  test("a mistyped confirmation of a chosen passphrase writes nothing", async () => {
    const h = await harness({ secrets: ["a passphrase I picked myself", "a different one entirely"] })
    expect(await run(["vault", "init", "--own-passphrase", "--keystore", h.vaultPath], h.deps)).toBe(1)
    expect(h.stderr.text).toContain("did not match")
    await expect(stat(h.vaultPath)).rejects.toThrow()
  })

  test("init prints the AD-6 line about the Apple account", async () => {
    const h = await initVault()
    expect(h.stdout.text).toContain("outside the Apple account that holds a synced passkey")
  })
})

describe("T34: invariant 1, a recoverable factor exists before any key is created", () => {
  test("init writes the envelope and the root and verifies BOTH before reporting", async () => {
    const h = await initVault()
    expect(h.stdout.text).toContain("re-read and opened with the passphrase you set, and its root blob decrypted")

    const file = JSON.parse(await readFile(h.vaultPath, "utf8")) as {
      root?: unknown
      envelopes: unknown[]
      keyIds: unknown[]
    }
    expect(file.envelopes).toHaveLength(1)
    expect(file.root).toBeDefined()
    // No key is created here: invariant 1 comes first.
    expect(file.keyIds).toHaveLength(0)
  })

  test("a second init refuses to overwrite, which is also the crash-injection case", async () => {
    const h = await initVault()
    const before = await readFile(h.vaultPath, "utf8")

    const second = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [] })
    expect(await run(["vault", "init", "--keystore", h.vaultPath], second.deps)).toBe(1)
    expect(second.stderr.text).toContain("already exists")
    // A crash after the write and before the verify leaves exactly this file, and the next init
    // refuses it rather than replacing a vault whose factor was never proven.
    expect(second.stderr.text).toContain("including after an interrupted init")
    expect(await readFile(h.vaultPath, "utf8")).toBe(before)
  })

  test("new-key refuses on a vault with no recoverable envelope", async () => {
    const h = await initVault()
    // A constructed fixture: the passphrase envelope replaced by a Secure Enclave one, which this
    // Linux host cannot drive (CC-12) and which counts for nothing recoverable.
    const { reopen } = await import("../vault/test-vault")
    const { commitVault } = await import("../vault/store")
    const vault = await reopen(h.vaultPath, h.passphrase)
    const first = vault.file.envelopes[0] as (typeof vault.file.envelopes)[0]
    await commitVault(
      vault,
      {
        index: vault.index,
        envelopes: [
          {
            id: "ZZZZZZZZZZZ",
            factor: "secure-enclave",
            domain: "this-device",
            label: "",
            createdAt: first.createdAt,
            wrap: first.wrap,
            helper: { teamId: "ABCDE12345", bundleId: "tv.candle.cli.enclave", minVersion: "0.12.0" },
            publicKey: "not-a-key",
            keyTag: "tv.candle.cli.vault.fixture",
            accessControl: "biometryCurrentSet",
            kek: { alg: "ECIES-P256-SHA256-AESGCM", ciphertext: "not-a-packet" },
          } as unknown as (typeof vault.file.envelopes)[0],
        ],
      },
      h.deps,
    )

    const k = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    const code = await run(["vault", "new-key", "--chain", "solana", "--keystore", h.vaultPath], k.deps)
    expect(code).toBe(1)
    // It cannot even unlock, because the only envelope left is one this build cannot drive -- which
    // is itself the invariant holding: a vault whose only envelope is `secure-enclave` cannot exist.
    expect(k.stderr.text).toContain("no passphrase envelope")
  })

  test("two apple-account envelopes count as ONE recoverable factor (AD-2)", async () => {
    const { countRecoverableFactors } = await import("../vault/domains")
    const apple = (id: string) =>
      ({
        id,
        factor: "passkey-prf",
        domain: "apple-account",
        label: "",
        createdAt: "",
        backupEligible: true,
        wrap: { alg: "AES-256-GCM", iv: "", ciphertext: "" },
      }) as never
    expect(countRecoverableFactors([apple("a"), apple("b")])).toBe(1)
    // And a passphrase beside them is a second domain, so it is two.
    const passphrase = {
      id: "p",
      factor: "passphrase",
      domain: "human-memory",
      label: "",
      createdAt: "",
      wrap: {},
    } as never
    expect(countRecoverableFactors([apple("a"), apple("b"), passphrase])).toBe(2)
    // One hardware key is not recoverable; two on distinct credentials are.
    const hardware = (id: string) =>
      ({
        id,
        factor: "passkey-prf",
        domain: "hardware-token",
        label: "",
        createdAt: "",
        backupEligible: false,
        wrap: {},
      }) as never
    expect(countRecoverableFactors([hardware("a")])).toBe(0)
    expect(countRecoverableFactors([hardware("a"), hardware("b")])).toBe(1)
  })

  test("--high-value is gone, and a vault a chosen passphrase opens still allocates (BE-245)", async () => {
    // Removed outright on 2026-09-21: it lived in the unauthenticated sidecar, so `rm` switched it
    // off; a generated passphrase satisfied it and generated is the default, so it was inert on
    // every path but one; and it fired at `new-key`, after the vault was built. Passing it now
    // fails as the unknown flag it is, which is the right answer for a flag nobody has in a script.
    const chosen = "a passphrase I picked myself"
    const rejected = await harness({ secrets: [], lines: [] })
    expect(await run(["vault", "init", "--high-value", "--keystore", rejected.vaultPath], rejected.deps)).toBe(2)
    expect(rejected.stderr.text).toContain("--high-value")
    await expect(stat(rejected.vaultPath)).rejects.toThrow()

    // The one case the gate ever bit -- a chosen passphrase, one recoverable factor -- allocates.
    const h = await harness({ secrets: [chosen, chosen], lines: ["no"] })
    expect(await run(["vault", "init", "--own-passphrase", "--keystore", h.vaultPath], h.deps)).toBe(0)
    const k = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [chosen] })
    expect(await run(["vault", "new-key", "--chain", "solana", "--keystore", h.vaultPath], k.deps)).toBe(0)
  })

  test("a leftover highValue in a sidecar is an ignored field, not a migration (BE-245)", async () => {
    // Nothing reads it any more, so a vault created by 0.11.2 with the flag keeps working and no
    // vault needs migrating. Deliberately NOT cleaned up: code to erase a field nothing reads is
    // code with nothing to do.
    const h = await initVault()
    const sidecar = sidecarPath(h.vaultPath)
    const before = JSON.parse(await readFile(sidecar, "utf8")) as Record<string, unknown>
    await writeFile(sidecar, JSON.stringify({ ...before, highValue: true }, null, 2))

    const k = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    expect(await run(["vault", "new-key", "--chain", "solana", "--keystore", h.vaultPath], k.deps)).toBe(0)
  })
})

describe("new-key derives, records and verifies", () => {
  test("it derives at m/44'/501'/n'/0', advances the counter, and re-reads its own write", async () => {
    const h = await initVault()
    const first = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    expect(await run(["vault", "new-key", "--chain", "solana", "--keystore", h.vaultPath], first.deps)).toBe(0)
    expect(first.stdout.text).toContain("m/44'/501'/0'/0'")
    expect(first.stdout.text).toContain("re-read from the vault and re-derived from its root")

    const second = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    expect(await run(["vault", "new-key", "--chain", "solana", "--keystore", h.vaultPath], second.deps)).toBe(0)
    expect(second.stdout.text).toContain("m/44'/501'/1'/0'")

    const s = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    await run(["vault", "status", "--unlock", "--keystore", h.vaultPath], s.deps)
    expect(s.stdout.text).toContain("solanaVault  2")
  })

  test("--chain evm exits 2 with CHAIN_NOT_OFFERED and derives nothing", async () => {
    const h = await initVault()
    const k = await harness({ env: { CANDLE_CONFIG_DIR: h.dir } })
    expect(await run(["vault", "new-key", "--chain", "evm", "--keystore", h.vaultPath], k.deps)).toBe(2)
    expect(k.stderr.text).toContain("CHAIN_NOT_OFFERED")
    expect(k.stderr.text).toContain("Phase 4")
  })

  test("an index in hd.exposedIndexes is never allocated, even when the boundary is known", async () => {
    const { nextAllocatableIndex } = await import("./vault-new-key")
    expect(nextAllocatableIndex(0, [])).toBe(0)
    expect(nextAllocatableIndex(0, [0])).toBe(1)
    expect(nextAllocatableIndex(3, [3, 4, 5])).toBe(6)
    expect(nextAllocatableIndex(3, [0, 1])).toBe(3)
  })
})

describe("T45: factor changes re-encrypt only the index, and removal is not revocation (N1)", () => {
  test("adding a passphrase envelope re-encrypts the index under the new header; both factors open", async () => {
    const h = await initVault()
    const before = JSON.parse(await readFile(h.vaultPath, "utf8")) as {
      generation: number
      index: { ciphertext: string }
      root: { ciphertext: string }
      keys: unknown[]
    }

    const second = "a second passphrase entirely"
    const add = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase, second, second] })
    expect(
      await run(["vault", "factor", "add", "passphrase", "--own-passphrase", "--keystore", h.vaultPath], add.deps),
    ).toBe(0)
    expect(add.stdout.text).toContain("re-read and opened with the new passphrase")

    const after = JSON.parse(await readFile(h.vaultPath, "utf8")) as {
      generation: number
      index: { ciphertext: string }
      root: { ciphertext: string }
      envelopes: unknown[]
    }
    expect(after.envelopes).toHaveLength(2)
    expect(after.generation).toBe(before.generation + 1)
    // ED-1's whole point: the index moved, the root did not.
    expect(after.index.ciphertext).not.toBe(before.index.ciphertext)
    expect(after.root.ciphertext).toBe(before.root.ciphertext)

    // Both factors open it.
    const { reopen } = await import("../vault/test-vault")
    const { closeVault } = await import("../vault/store")
    closeVault(await reopen(h.vaultPath, h.passphrase))
    closeVault(await reopen(h.vaultPath, second))
  })

  test("key blobs are never re-encrypted by a factor change", async () => {
    const h = await initVault()
    const k = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    await run(["vault", "new-key", "--chain", "solana", "--keystore", h.vaultPath], k.deps)
    const before = JSON.parse(await readFile(h.vaultPath, "utf8")) as { keys: Array<{ ciphertext: string }> }

    const second = "a second passphrase entirely"
    const add = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase, second, second] })
    await run(["vault", "factor", "add", "passphrase", "--own-passphrase", "--keystore", h.vaultPath], add.deps)

    const after = JSON.parse(await readFile(h.vaultPath, "utf8")) as { keys: Array<{ ciphertext: string }> }
    expect(after.keys[0]?.ciphertext).toBe(before.keys[0]?.ciphertext)
  })

  test("removing the last passphrase, or the last recoverable factor, is refused", async () => {
    const h = await initVault()
    const file = JSON.parse(await readFile(h.vaultPath, "utf8")) as { envelopes: Array<{ id: string }> }
    const id = file.envelopes[0]?.id as string

    const r = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    expect(await run(["vault", "factor", "remove", id, "--keystore", h.vaultPath], r.deps)).toBe(1)
    expect(r.stderr.text).toContain("only passphrase factor")
    expect(r.stderr.text).toContain("recovery floor")
  })

  test("removal prints the not-revocation notice, and status then names the removed id", async () => {
    const h = await initVault()
    const second = "a second passphrase entirely"
    const add = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase, second, second] })
    await run(["vault", "factor", "add", "passphrase", "--own-passphrase", "--keystore", h.vaultPath], add.deps)

    const file = JSON.parse(await readFile(h.vaultPath, "utf8")) as { envelopes: Array<{ id: string }> }
    const removedId = file.envelopes[1]?.id as string

    const r = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    expect(await run(["vault", "factor", "remove", removedId, "--keystore", h.vaultPath], r.deps)).toBe(0)
    expect(r.stdout.text).toContain("Removing a factor is not revocation")
    expect(r.stdout.text).toContain("still opens with that factor")
    expect(r.stdout.text).toContain("including keys created after this removal")

    const sidecar = await readSidecar(sidecarPath(h.vaultPath))
    expect(sidecar?.removedEnvelopeIds).toContain(removedId)

    const s = await harness({ env: { CANDLE_CONFIG_DIR: h.dir } })
    await run(["vault", "status", "--keystore", h.vaultPath], s.deps)
    expect(s.stdout.text).toContain(removedId)
  })

  test("the documented behaviour, asserted: an older copy still opens with the removed factor", async () => {
    const h = await initVault()
    const second = "a second passphrase entirely"
    const add = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase, second, second] })
    await run(["vault", "factor", "add", "passphrase", "--own-passphrase", "--keystore", h.vaultPath], add.deps)

    // The copy an operator might have taken while both envelopes existed.
    const copyPath = join(h.dir, "copy.enc")
    await writeFile(copyPath, await readFile(h.vaultPath, "utf8"), "utf8")

    const file = JSON.parse(await readFile(h.vaultPath, "utf8")) as { envelopes: Array<{ id: string }> }
    const removedId = file.envelopes[1]?.id as string
    const r = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    await run(["vault", "factor", "remove", removedId, "--keystore", h.vaultPath], r.deps)

    // Then a key is created in the CURRENT file, after the removal.
    const k = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    expect(await run(["vault", "new-key", "--chain", "solana", "--keystore", h.vaultPath], k.deps)).toBe(0)

    // N1, asserted rather than asserted-away: the removed factor still opens the older copy, and
    // the DEK it yields decrypts the key blob created after the removal.
    const { reopen } = await import("../vault/test-vault")
    const { decryptKey, closeVault } = await import("../vault/store")
    const older = await reopen(copyPath, second)
    const current = await reopen(h.vaultPath, h.passphrase)
    const newKeyId = current.index.entries[0]?.id as string
    // Same vault id, so the same DEK: the older copy's payload key opens the new file's blob.
    expect(older.file.vaultId).toBe(current.file.vaultId)
    const blob = current.file.keys.find((candidate) => candidate.id === newKeyId)
    const secret = await decryptKey({ ...older, file: { ...older.file, keys: [blob as never] } }, newKeyId)
    expect(secret.length).toBe(64)
    closeVault(older)
    closeVault(current)
  })
})

describe("T44: ED-6's two rollback shapes", () => {
  test("a whole-file older copy is refused, and --accept-older-copy names what changed", async () => {
    const h = await initVault()
    const older = await readFile(h.vaultPath, "utf8")

    const second = "a second passphrase entirely"
    const add = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase, second, second] })
    await run(["vault", "factor", "add", "passphrase", "--own-passphrase", "--keystore", h.vaultPath], add.deps)

    // Restore the older whole file: internally consistent, and only the sidecar knows better.
    await writeFile(h.vaultPath, older, "utf8")

    const s = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    expect(await run(["vault", "status", "--unlock", "--keystore", h.vaultPath], s.deps)).toBe(1)
    expect(s.stderr.text).toContain("older copy")
    expect(s.stderr.text).toContain("--accept-older-copy")
    // And it says, in the refusal, that editing the sidecar defeats it: a non-defense stated.
    expect(s.stderr.text).toContain("not a defense")

    const a = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    expect(await run(["vault", "status", "--unlock", "--accept-older-copy", "--keystore", h.vaultPath], a.deps)).toBe(0)
    expect(a.stderr.text).toContain("Opening an older copy")
  })

  test("no sidecar is a warning, not a refusal", async () => {
    const h = await initVault()
    const { rm } = await import("node:fs/promises")
    await rm(sidecarPath(h.vaultPath))

    const s = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    expect(await run(["vault", "status", "--unlock", "--keystore", h.vaultPath], s.deps)).toBe(0)
    expect(s.stderr.text).toContain("cannot be recognized here")
  })

  test("BE-178 finding 3: a write committed onto an accepted older copy does not lower the anchor", async () => {
    const h = await initVault()
    const older = await readFile(h.vaultPath, "utf8")

    // Two more writes: generation 3, and the sidecar remembers it.
    const second = "a second passphrase entirely"
    const third = "a third passphrase entirely"
    for (const extra of [second, third]) {
      const add = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase, extra, extra] })
      expect(
        await run(["vault", "factor", "add", "passphrase", "--own-passphrase", "--keystore", h.vaultPath], add.deps),
      ).toBe(0)
    }
    expect((await readSidecar(sidecarPath(h.vaultPath)))?.lastGeneration).toBe(3)

    // Restore the generation-1 copy and commit onto it, as the tee commands do when they accept an
    // older copy so a recovery is never stranded. The file becomes generation 2.
    await writeFile(h.vaultPath, older, "utf8")
    const onto = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase, second, second] })
    expect(
      await run(
        ["vault", "factor", "add", "passphrase", "--own-passphrase", "--accept-older-copy", "--keystore", h.vaultPath],
        onto.deps,
      ),
    ).toBe(0)
    expect((JSON.parse(await readFile(h.vaultPath, "utf8")) as { generation: number }).generation).toBe(2)
    expect((await readSidecar(sidecarPath(h.vaultPath)))?.lastGeneration).toBe(3)

    // A normal open still reports it as an older copy.
    const s = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    expect(await run(["vault", "status", "--unlock", "--keystore", h.vaultPath], s.deps)).toBe(1)
    expect(s.stderr.text).toContain("older copy")
  })
})

describe("BE-178 finding 1: passphrases and surrounding whitespace", () => {
  test("a chosen passphrase with surrounding whitespace is refused before anything is written", async () => {
    const h = await harness({ secrets: [" sixteen characters long "] })
    expect(await run(["vault", "init", "--own-passphrase", "--keystore", h.vaultPath], h.deps)).toBe(1)
    expect(h.stderr.text).toContain("must not begin or end with a space")
    expect(h.stderr.text).toContain("Nothing was written")
    // Refused at the first prompt: the confirmation was never asked for.
    expect(h.asked).toHaveLength(1)
    await expect(stat(h.vaultPath)).rejects.toThrow()
    await expect(stat(sidecarPath(h.vaultPath))).rejects.toThrow()
  })

  test("factor add passphrase --own-passphrase refuses it too, and the file is untouched", async () => {
    const h = await initVault()
    const before = await readFile(h.vaultPath, "utf8")
    const add = await harness({
      env: { CANDLE_CONFIG_DIR: h.dir },
      secrets: [h.passphrase, "sixteen characters long "],
    })
    expect(
      await run(["vault", "factor", "add", "passphrase", "--own-passphrase", "--keystore", h.vaultPath], add.deps),
    ).toBe(1)
    expect(add.stderr.text).toContain("must not begin or end with a space")
    expect(await readFile(h.vaultPath, "utf8")).toBe(before)
  })

  test("a vault CLI 0.10.0 created with a trailing space re-opens with the passphrase typed as it was", async () => {
    // 0.10.0 wrapped the key with the passphrase exactly as typed and trimmed every unlock, so this
    // vault could never be opened. The creation path now refuses the shape, so the fixture is built
    // through the store directly, which is what that release did.
    const kept = "sixteen characters long "
    const made = await makeVault({ passphrase: kept, strength: "user-chosen" })
    const { closeVault } = await import("../vault/store")
    closeVault(made.vault)

    const s = await harness({ env: { CANDLE_CONFIG_DIR: made.dir }, secrets: [kept] })
    expect(await run(["vault", "status", "--unlock", "--keystore", made.path], s.deps)).toBe(0)
    expect(s.stdout.text).toContain("chosen by you")
  })

  test("a normal vault re-opens when the unlock is typed with a stray trailing space", async () => {
    const h = await initVault()
    const s = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [`${h.passphrase} `] })
    expect(await run(["vault", "status", "--unlock", "--keystore", h.vaultPath], s.deps)).toBe(0)

    // Trimming is not a second guess at the content: a wrong passphrase stays wrong.
    const w = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [`${h.passphrase}x `] })
    expect(await run(["vault", "status", "--unlock", "--keystore", h.vaultPath], w.deps)).toBe(1)
    expect(w.stderr.text).toContain("wrong passphrase")
  })
})

describe("BE-178 finding 2: a new vault does not inherit another vault's verified-backup stamp", () => {
  test("retire-legacy refuses after the old vault.enc was moved aside and a new vault made at the path", async () => {
    const h = await initVault()
    const backupPath = join(h.dir, "..", `be178-backup-${Date.now()}.enc`)
    const b = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    expect(await run(["vault", "backup", "--to", backupPath, "--keystore", h.vaultPath], b.deps)).toBe(0)
    const stamped = await readSidecar(sidecarPath(h.vaultPath))
    expect(stamped?.lastVerifiedBackupAt).toBeDefined()

    // The operator moves the vault aside and starts over at the same path; the sidecar stays.
    await rename(h.vaultPath, `${h.vaultPath}.moved-aside`)
    const n = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, lines: ["", "", "no"] })
    expect(await run(["vault", "init", "--keystore", h.vaultPath], n.deps)).toBe(0)
    const fresh = await readSidecar(sidecarPath(h.vaultPath))
    expect(fresh?.vaultId).toBeDefined()
    expect(fresh?.vaultId).not.toBe(stamped?.vaultId)
    expect(fresh?.lastVerifiedBackupAt).toBeUndefined()

    // So retire-legacy refuses before it reads the Phase 1 store or asks for anything.
    const r = await harness({ env: { CANDLE_CONFIG_DIR: h.dir } })
    const code = await run(
      ["vault", "retire-legacy", "--from", join(h.dir, "tee-wallets.enc"), "--keystore", h.vaultPath, "--json"],
      r.deps,
    )
    expect(code).toBe(1)
    expect(JSON.parse(r.stdout.text.trim()).code).toBe("LEGACY_UNVERIFIED_BACKUP")
    expect(r.asked).toHaveLength(0)
  })
})

describe("T54: the phrase ceremony", () => {
  test("non-TTY stdin or stdout is refused BEFORE any render, and the vault is not read", async () => {
    const h = await initVault()
    for (const tty of [
      { stdin: false, stdout: true },
      { stdin: true, stdout: false },
    ]) {
      const p = await harness({ env: { CANDLE_CONFIG_DIR: h.dir } })
      p.deps.isTTY = tty
      const code = await run(["vault", "phrase", "show", "--keystore", h.vaultPath], p.deps)
      expect(code).toBe(1)
      expect(p.stderr.text).toContain("PHRASE_REQUIRES_TTY")
      expect(p.stderr.text).toContain("Nothing was rendered")
      expect(p.stdout.text).toBe("")
      // And it never asked for a passphrase, so the vault was not opened at all.
      expect(p.asked).toEqual([])
    }
  })

  test("--json exits 2 and renders nothing", async () => {
    const h = await initVault()
    const p = await harness({ env: { CANDLE_CONFIG_DIR: h.dir } })
    expect(await run(["vault", "phrase", "show", "--json", "--keystore", h.vaultPath], p.deps)).toBe(2)
    expect(p.stdout.text).toContain('"code":"USAGE"')
    expect(p.asked).toEqual([])
  })

  test("the acknowledgement precedes the write, the write precedes the render", async () => {
    const h = await initVault()
    const before = JSON.parse(await readFile(h.vaultPath, "utf8")) as { generation: number }

    // Declining the acknowledgement: nothing is displayed and nothing is written.
    const declined = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase], lines: ["no"] })
    expect(await run(["vault", "phrase", "show", "--keystore", h.vaultPath], declined.deps)).toBe(1)
    expect(declined.stdout.text).toContain("Nothing was displayed and nothing was written")
    const unchanged = JSON.parse(await readFile(h.vaultPath, "utf8")) as { generation: number; index: unknown }
    expect(unchanged.generation).toBe(before.generation)
  })

  test("the 24 words are rendered from the stored entropy, and rootExported is written first", async () => {
    const h = await initVault()
    // Three read-back answers are asked for at random positions, so the queue is padded with the
    // full word list: whichever three are asked, the harness answers with the right ones below.
    const p = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase], lines: ["understood"] })
    const answered: string[] = []
    let words: string[] = []
    p.deps.promptLine = async (text: string) => {
      if (text.startsWith("Type understood")) return "understood"
      const match = /Type word (\d+):/.exec(text)
      if (!match?.[1]) throw new Error(`unexpected prompt: ${text}`)
      const word = words[Number(match[1]) - 1] as string
      answered.push(word)
      return word
    }
    // The words the render will show, computed from the vault's own root before the run.
    const { reopen } = await import("../vault/test-vault")
    const { decryptRoot, closeVault } = await import("../vault/store")
    const vault = await reopen(h.vaultPath, h.passphrase)
    const entropy = await decryptRoot(vault)
    const { phraseFromEntropy } = await import("../vault/hd")
    words = phraseFromEntropy(entropy).split(" ")
    closeVault(vault)

    expect(await run(["vault", "phrase", "show", "--keystore", h.vaultPath], p.deps)).toBe(0)
    expect(answered).toHaveLength(3)
    expect(p.stdout.text).toContain("Read-back matched")

    // The record precedes the exposure: the write happened, and the flag never resets.
    const after = JSON.parse(await readFile(h.vaultPath, "utf8")) as { generation: number }
    const s = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    await run(["vault", "status", "--unlock", "--keystore", h.vaultPath], s.deps)
    expect(s.stdout.text).toContain("recovery phrase exported: yes")
    expect(after.generation).toBeGreaterThan(1)

    // A canary word never reaches stderr, the sidecar, or a JSON output.
    const sidecar = await readFile(sidecarPath(h.vaultPath), "utf8")
    const rendered = words.join(" ")
    expect(sidecar).not.toContain(rendered)
    expect(p.stderr.text).not.toContain(rendered)
  })

  test("a mismatched read-back exits 1 with the record ALREADY true", async () => {
    const h = await initVault()
    const p = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    p.deps.promptLine = async (text: string) => (text.startsWith("Type understood") ? "understood" : "wrongword")

    expect(await run(["vault", "phrase", "show", "--keystore", h.vaultPath], p.deps)).toBe(1)
    expect(p.stderr.text).toContain("did not match")
    // Already recorded, because the words were on the screen: the record precedes the exposure and
    // a failed read-back does not undo it.
    const s = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    await run(["vault", "status", "--unlock", "--keystore", h.vaultPath], s.deps)
    expect(s.stdout.text).toContain("recovery phrase exported: yes")
  })
})

describe("T39: AD-3's removals", () => {
  // The two commands are still gone; what changed in 0.11.1 (BE-238, D6) is that the TOMBSTONE is
  // gone too. Andrew's 2026-09-19 call: nobody ran the releases between 0.10.0 and 0.11.0, so the
  // refusal had no audience, and a routed word documented nowhere is a state no drift test can
  // see. `index.test.ts`'s T14 pins what they answer now; the assertion that belongs HERE is the
  // AD-3 half this file owns -- neither word reaches a handler that could open a wallets.enc.
  test("wallets generate and wallets export reach no handler at all", async () => {
    for (const args of [
      ["wallets", "generate", "--chain", "solana", "--count", "2"],
      ["wallets", "export", "--index", "0", "--yes"],
    ] as const) {
      const h = await harness()
      expect(await run([...args], h.deps)).toBe(2)
      // No key material, no file, and none of the tombstone's own wording.
      expect(h.stdout.text).toBe("")
      expect(h.stderr.text).not.toContain("was removed in CLI 0.10.0")
      expect(h.stderr.text).not.toContain("cli-v0.9.2")
    }
  })

  test("no shipping code path reads CANDLE_KEYSTORE_PASSPHRASE's value", async () => {
    // The grep-level half of T39. `tee` and the vault both check its PRESENCE and never its value,
    // so a read of the value anywhere is the thing to catch.
    const { readdirSync, readFileSync, statSync } = await import("node:fs")
    const { resolve } = await import("node:path")
    const srcDir = resolve(import.meta.dir, "..")
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) {
          walk(path)
          continue
        }
        if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue
        const source = readFileSync(path, "utf8")
        for (const line of source.split("\n")) {
          if (!line.includes("CANDLE_KEYSTORE_PASSPHRASE")) continue
          // The only legal shapes are a presence check and a mention in a message or comment.
          const presenceCheck = /CANDLE_KEYSTORE_PASSPHRASE\s*===?\s*undefined/.test(line)
          const inText = /["'`].*CANDLE_KEYSTORE_PASSPHRASE/.test(line)
          const inComment = /^\s*(\*|\/\/)/.test(line)
          if (!presenceCheck && !inText && !inComment) {
            offenders.push(`${path.slice(srcDir.length + 1)}: ${line.trim()}`)
          }
        }
      }
    }
    walk(srcDir)
    expect(offenders).toEqual([])
  })

  test("the runtime canary: every vault command refuses while the variable is set", async () => {
    const h = await initVault()
    for (const args of [
      ["vault", "status"],
      ["vault", "new-key", "--chain", "solana"],
      ["vault", "factor", "list"],
      ["vault", "phrase", "show"],
      ["vault", "backup", "--to", "/tmp/nowhere"],
      ["vault", "verify-backup", "/tmp/nowhere"],
      ["vault", "reconcile-exposure"],
    ]) {
      const c = await harness({ env: { CANDLE_CONFIG_DIR: h.dir, CANDLE_KEYSTORE_PASSPHRASE: "anything at all" } })
      const code = await run([...args, "--keystore", h.vaultPath], c.deps)
      expect(`${args.join(" ")} -> ${code}`).toBe(`${args.join(" ")} -> 1`)
      expect(c.stderr.text).toContain("CANDLE_KEYSTORE_PASSPHRASE is set")
      expect(c.stderr.text).toContain("No Candle command reads its value")
      // Nothing was prompted, so nothing was unlocked.
      expect(c.asked).toEqual([])
    }
  })

  test("no vault command has a --yes flag", async () => {
    const h = await initVault()
    for (const args of [
      ["vault", "new-key", "--chain", "solana", "--yes"],
      ["vault", "factor", "list", "--yes"],
      ["vault", "backup", "--to", "/tmp/x", "--yes"],
    ]) {
      const c = await harness({ env: { CANDLE_CONFIG_DIR: h.dir } })
      expect(await run([...args, "--keystore", h.vaultPath], c.deps)).toBe(2)
      expect(c.stderr.text).toContain("Unknown flag: --yes")
    }
  })

  test("a wallets.enc on disk is never opened, and status names it and the exit path", async () => {
    const h = await initVault()
    const legacy = join(h.dir, "wallets.enc")
    const contents = `${JSON.stringify({ version: 1, ciphertext: "untouched" })}\n`
    await writeFile(legacy, contents, "utf8")

    const s = await harness({ env: { CANDLE_CONFIG_DIR: h.dir } })
    expect(await run(["vault", "status", "--keystore", h.vaultPath], s.deps)).toBe(0)
    expect(s.stdout.text).toContain("A legacy wallets.enc exists")
    expect(s.stdout.text).toContain("this CLI does not read it")
    expect(s.stdout.text).toContain("move those funds on chain to a vault key")
    // Byte-identical afterwards: the vault has no code path that touches it.
    expect(await readFile(legacy, "utf8")).toBe(contents)
  })

  test("--json output from a vault command never carries a key, a phrase word or an xpub", async () => {
    const h = await initVault()
    const k = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    await run(["vault", "new-key", "--chain", "solana", "--json", "--keystore", h.vaultPath], k.deps)
    const created = JSON.parse(k.stdout.text) as Record<string, unknown>
    expect(Object.keys(created).sort()).toEqual(["address", "index", "keyId", "label", "ok", "path"])

    const s = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    await run(["vault", "status", "--unlock", "--json", "--keystore", h.vaultPath], s.deps)
    const body = s.stdout.text
    expect(body).not.toContain("xpub")
    expect(body).not.toContain(h.passphrase)
    // The rendered phrase, in full, must not be anywhere in a machine output.
    const { reopen } = await import("../vault/test-vault")
    const { decryptRoot, closeVault } = await import("../vault/store")
    const vault = await reopen(h.vaultPath, h.passphrase)
    const entropy = await decryptRoot(vault)
    const { phraseFromEntropy } = await import("../vault/hd")
    expect(body).not.toContain(phraseFromEntropy(entropy))
    closeVault(vault)
  })
})

describe("T36 / T39: under --json stdout is one JSON value, and a generated passphrase is never in it", () => {
  /** The whole of stdout must parse as ONE value: a passphrase rendered before the JSON would not. */
  const oneJsonValue = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>
  /** What a rendered generated passphrase looks like: eight lowercase words on an indented line. */
  const RENDERED_PASSPHRASE = /\n {4}[a-z][a-z-]*(?: [a-z][a-z-]*){7}\n/

  test("vault init --json without --own-passphrase is refused before anything is generated or written", async () => {
    const h = await harness()
    expect(await run(["vault", "init", "--json", "--keystore", h.vaultPath], h.deps)).toBe(2)
    expect(oneJsonValue(h.stdout.text)).toMatchObject({ ok: false, code: "USAGE" })
    expect(h.stdout.text).toMatch(/--own-passphrase/)
    expect(h.stdout.text).not.toMatch(RENDERED_PASSPHRASE)
    // Refused up front: no passphrase was generated, no prompt was asked, no file exists.
    expect(h.asked).toEqual([])
    await expect(stat(h.vaultPath)).rejects.toThrow()
  })

  test("vault init --json --own-passphrase answers with exactly one JSON value that carries no passphrase", async () => {
    const own = "a passphrase the operator chose"
    const h = await harness({ secrets: [own, own] })
    expect(await run(["vault", "init", "--json", "--own-passphrase", "--keystore", h.vaultPath], h.deps)).toBe(0)
    const body = oneJsonValue(h.stdout.text)
    expect(body).toMatchObject({ ok: true, path: h.vaultPath, phraseCeremonyOffered: false })
    expect(h.stdout.text).not.toContain(own)
    expect(h.stderr.text).not.toContain(own)
    // The text mode's "recorded as chosen by you" line is not stdout under --json either.
    expect(h.stdout.text).not.toContain("Recorded as chosen by you")
    expect(h.stdout.text.trim().split("\n")).toHaveLength(1)

    const { reopen } = await import("../vault/test-vault")
    const { closeVault } = await import("../vault/store")
    closeVault(await reopen(h.vaultPath, own))
  })

  test("vault factor add passphrase --json without --own-passphrase is refused before any prompt", async () => {
    const h = await initVault()
    const before = await readFile(h.vaultPath, "utf8")
    const add = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    expect(await run(["vault", "factor", "add", "passphrase", "--json", "--keystore", h.vaultPath], add.deps)).toBe(2)
    expect(oneJsonValue(add.stdout.text)).toMatchObject({ ok: false, code: "USAGE" })
    expect(add.stdout.text).not.toMatch(RENDERED_PASSPHRASE)
    expect(add.asked).toEqual([])
    expect(await readFile(h.vaultPath, "utf8")).toBe(before)
  })

  test("vault factor add passphrase --json --own-passphrase is one JSON value, and both factors open", async () => {
    const h = await initVault()
    const second = "a second passphrase entirely"
    const add = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase, second, second] })
    expect(
      await run(
        ["vault", "factor", "add", "passphrase", "--json", "--own-passphrase", "--keystore", h.vaultPath],
        add.deps,
      ),
    ).toBe(0)
    const body = oneJsonValue(add.stdout.text)
    expect(body).toMatchObject({ ok: true, factor: "passphrase", domain: "human-memory" })
    expect(typeof body.envelopeId).toBe("string")
    expect(add.stdout.text).not.toContain(second)
    expect(add.stdout.text).not.toContain(h.passphrase)
    expect(add.stderr.text).not.toContain(second)
    expect(add.stdout.text.trim().split("\n")).toHaveLength(1)

    const { reopen } = await import("../vault/test-vault")
    const { closeVault } = await import("../vault/store")
    closeVault(await reopen(h.vaultPath, second))
    closeVault(await reopen(h.vaultPath, h.passphrase))
  })
})

describe("the TTY rule, and what answers without one", () => {
  test("a command that must collect a passphrase refuses without a terminal", async () => {
    const h = await initVault()
    const k = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, tty: false })
    expect(await run(["vault", "new-key", "--chain", "solana", "--keystore", h.vaultPath], k.deps)).toBe(1)
    expect(k.stderr.text).toContain("needs a terminal")
    expect(k.stderr.text).toContain("There is no environment variable and no flag that supplies one")
    expect(k.asked).toEqual([])
  })

  test("status without --unlock and factor list collect nothing, so they answer under --json", async () => {
    const h = await initVault()
    for (const args of [
      ["vault", "status"],
      ["vault", "factor", "list"],
    ]) {
      const c = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, tty: false })
      expect(await run([...args, "--json", "--keystore", h.vaultPath], c.deps)).toBe(0)
      expect(JSON.parse(c.stdout.text)).toMatchObject({ ok: true })
      expect(c.asked).toEqual([])
    }
  })
})

/**
 * T17 (BE-241, D8): `init` says the passphrase is about to be generated and shown once, BEFORE the
 * ceremony rather than beside the words, and it names the non-default location on the way out.
 *
 * No new prompt here, deliberately: the copy-back is itself the proof of capture, and a mismatch
 * costs nothing because no file exists yet. BE-235 item 5 asked whether a first-ever `init` should
 * say so louder, before the words; this is that answer.
 */
describe("T17: D8's init copy and footer", () => {
  test("the notice precedes the eight words on stdout", async () => {
    const h = await initVault()
    const notice = h.stdout.text.indexOf("Your vault passphrase is about to be generated and shown once.")
    expect(notice).toBeGreaterThan(-1)
    expect(h.stdout.text).toContain("This CLI keeps no copy and cannot recover it.")
    expect(h.stdout.text).toContain("To choose your own instead, type own at the prompt below.")
    expect(h.stdout.text.indexOf(h.passphrase)).toBeGreaterThan(notice)
  })

  test("it is not printed with --own-passphrase, where nothing is generated", async () => {
    const h = await harness({
      secrets: ["a-long-enough-chosen-passphrase", "a-long-enough-chosen-passphrase"],
      lines: ["no"],
    })
    expect(await run(["vault", "init", "--own-passphrase", "--keystore", h.vaultPath], h.deps)).toBe(0)
    expect(h.stdout.text).not.toContain("about to be generated")
  })

  test("the footer names the non-default location, and where to set it once", async () => {
    const h = await initVault()
    expect(h.stdout.text).toContain(`This vault is at ${h.vaultPath}, not the default location.`)
    expect(h.stdout.text).toContain(`Every vault command needs -k ${h.vaultPath}`)
    expect(h.stdout.text).toContain(`export CANDLE_CONFIG_DIR=${h.dir}`)
  })

  test("there is no footer when CANDLE_CONFIG_DIR is what located the vault", async () => {
    const h = await harness({ lines: ["", "", "no"] })
    // No --keystore: the vault lands at the config dir the environment already names.
    expect(await run(["vault", "init"], h.deps)).toBe(0)
    expect(h.stdout.text).not.toContain("not the default location")
  })

  test("the --json payload is unchanged: no footer, no notice, and the same keys", async () => {
    const h = await harness({ secrets: ["a-long-enough-chosen-passphrase", "a-long-enough-chosen-passphrase"] })
    expect(await run(["vault", "init", "--own-passphrase", "--json", "--keystore", h.vaultPath], h.deps)).toBe(0)
    const body = JSON.parse(h.stdout.text) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(
      ["envelopes", "generation", "ok", "path", "phraseCeremonyOffered", "vaultId"].sort(),
    )
    expect(h.stdout.text.trimEnd().split("\n")).toHaveLength(1)
    expect(h.stdout.text).not.toContain("not the default location")
  })
})

/**
 * BE-242: `--count` and `--labels-from`. One unlock, n keys.
 *
 * The migration that asked for this needs 160 fresh keys, one per wallet being replaced. Without
 * a batch flag that is 160 processes and 160 unlocks -- with no Secure Enclave factor available
 * (Apple Developer enrollment still pending), 160 typed passphrases, and 160 chances to stop
 * halfway and leave the job half done.
 *
 * What these pin hardest is what a batch must NOT become. It is one interactive unlock for many
 * keys and never a way to derive keys unattended, so the refusals are asserted against `--count`
 * exactly as they hold for a single key.
 */
describe("new-key --count: one unlock, many keys", () => {
  test("--count 3 derives three consecutive indexes, advances the counter once per key, and prompts once", async () => {
    const h = await initVault()
    const k = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    const code = await run(["vault", "new-key", "--chain", "solana", "--count", "3", "--keystore", h.vaultPath], k.deps)

    expect(code).toBe(0)
    expect(k.stdout.text).toContain("m/44'/501'/0'/0'")
    expect(k.stdout.text).toContain("m/44'/501'/1'/0'")
    expect(k.stdout.text).toContain("m/44'/501'/2'/0'")
    expect(k.stdout.text).toContain("3 keys created under one unlock")
    // The whole point: ONE passphrase prompt for three keys. The harness throws if a run asks
    // for more input than the test scripted, so a second prompt would fail this outright -- but
    // asserted explicitly too, since that is the property the flag exists for.
    expect(k.asked.filter((line) => line.startsWith("secret:"))).toHaveLength(1)

    const s = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    await run(["vault", "status", "--unlock", "--keystore", h.vaultPath], s.deps)
    expect(s.stdout.text).toContain("solanaVault  3")
  })

  test("three distinct addresses land in the vault and each re-derives from the root", async () => {
    const h = await initVault()
    const k = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    expect(
      await run(["vault", "new-key", "--chain", "solana", "--count", "3", "--json", "--keystore", h.vaultPath], k.deps),
    ).toBe(0)
    const body = JSON.parse(k.stdout.text) as { ok: boolean; count: number; keys: { address: string; index: number }[] }
    expect(body.count).toBe(3)
    expect(body.keys.map((key) => key.index)).toEqual([0, 1, 2])
    // Three keys, not one key written three times. A batch that reused a derivation would pass
    // every count assertion above and be worthless.
    expect(new Set(body.keys.map((key) => key.address)).size).toBe(3)

    const { reopen } = await import("../vault/test-vault")
    const { closeVault } = await import("../vault/store")
    const vault = await reopen(h.vaultPath, h.passphrase)
    try {
      for (const key of body.keys) {
        expect(vault.index.entries.some((entry) => entry.address === key.address)).toBe(true)
      }
      expect(vault.index.entries).toHaveLength(3)
    } finally {
      closeVault(vault)
    }
  })

  test("the allocation guard runs per index: an exposed index inside the batch is skipped, not just at its head", async () => {
    const h = await initVault()
    // Index 1 marked exposed. A batch that checked `exposedIndexes` once, for its first index,
    // would allocate 0, 1, 2 and hand back a key at an index positively known to be exposed.
    const { reopen } = await import("../vault/test-vault")
    const { commitVault } = await import("../vault/store")
    const seeded = await reopen(h.vaultPath, h.passphrase)
    await commitVault(
      seeded,
      {
        index: {
          ...seeded.index,
          hd: { ...seeded.index.hd, exposedIndexes: { ...seeded.index.hd.exposedIndexes, solanaVault: [1] } },
        },
      },
      h.deps,
    )

    const k = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    expect(
      await run(["vault", "new-key", "--chain", "solana", "--count", "3", "--json", "--keystore", h.vaultPath], k.deps),
    ).toBe(0)
    const body = JSON.parse(k.stdout.text) as { keys: { index: number }[] }
    expect(body.keys.map((key) => key.index)).toEqual([0, 2, 3])
  })

  test("--labels-from names each key from the file, and the count falls out of its length", async () => {
    const h = await initVault()
    const k = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    // Names that are NOT sequential, which is the whole reason this flag exists rather than a
    // --label-prefix: a 1:1 migration reuses the old wallets' names.
    k.deps.readFile = async () => "treasury-eu\n\n  ops-payer  \nmarket-maker-3\n"
    expect(
      await run(
        ["vault", "new-key", "--chain", "solana", "--labels-from", "/names", "--json", "--keystore", h.vaultPath],
        k.deps,
      ),
    ).toBe(0)
    const body = JSON.parse(k.stdout.text) as { count: number; keys: { label: string }[] }
    expect(body.count).toBe(3)
    // Blank lines dropped, surrounding whitespace trimmed, order preserved.
    expect(body.keys.map((key) => key.label)).toEqual(["treasury-eu", "ops-payer", "market-maker-3"])
  })

  test("a --labels-from name that already exists in the vault is refused BEFORE anything is derived", async () => {
    const h = await initVault()
    const first = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    expect(
      await run(
        ["vault", "new-key", "--chain", "solana", "--label", "treasury", "--keystore", h.vaultPath],
        first.deps,
      ),
    ).toBe(0)

    const k = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    k.deps.readFile = async () => "alpha\ntreasury\nomega\n"
    expect(
      await run(
        ["vault", "new-key", "--chain", "solana", "--labels-from", "/names", "--keystore", h.vaultPath],
        k.deps,
      ),
    ).toBe(2)
    expect(k.stderr.text).toContain("treasury")

    // Nothing was derived: the vault still holds exactly the one key from before. A collision
    // found at key 2 of 3 would otherwise leave `alpha` committed and the mapping half made.
    const s = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    await run(["vault", "status", "--unlock", "--keystore", h.vaultPath], s.deps)
    expect(s.stdout.text).toContain("solanaVault  1")
  })

  test("the batch flags are validated before the unlock, so a bad one never costs a passphrase", async () => {
    const h = await initVault()
    for (const args of [
      ["--count", "0"],
      ["--count", "2.5"],
      ["--count", "257"],
      ["--count", "2", "--label", "one-name"],
    ]) {
      const k = await harness({ env: { CANDLE_CONFIG_DIR: h.dir } })
      expect([
        args,
        await run(["vault", "new-key", "--chain", "solana", ...args, "--keystore", h.vaultPath], k.deps),
      ]).toEqual([args, 2])
      // No secret was collected. The harness has none scripted, so a prompt would throw anyway.
      expect([args, k.asked]).toEqual([args, []])
    }
  })

  test("--count is capped, and a duplicate or empty --labels-from is refused with its reason", async () => {
    const h = await initVault()
    const cap = await harness({ env: { CANDLE_CONFIG_DIR: h.dir } })
    expect(
      await run(["vault", "new-key", "--chain", "solana", "--count", "9999", "--keystore", h.vaultPath], cap.deps),
    ).toBe(2)
    expect(cap.stderr.text).toContain("capped at 256")

    const dup = await harness({ env: { CANDLE_CONFIG_DIR: h.dir } })
    dup.deps.readFile = async () => "a\nb\na\n"
    expect(
      await run(["vault", "new-key", "--chain", "solana", "--labels-from", "/n", "--keystore", h.vaultPath], dup.deps),
    ).toBe(2)
    expect(dup.stderr.text).toContain("more than once")

    const empty = await harness({ env: { CANDLE_CONFIG_DIR: h.dir } })
    empty.deps.readFile = async () => "\n  \n"
    expect(
      await run(
        ["vault", "new-key", "--chain", "solana", "--labels-from", "/n", "--keystore", h.vaultPath],
        empty.deps,
      ),
    ).toBe(2)
    expect(empty.stderr.text).toContain("empty file")

    const disagree = await harness({ env: { CANDLE_CONFIG_DIR: h.dir } })
    disagree.deps.readFile = async () => "a\nb\n"
    expect(
      await run(
        ["vault", "new-key", "--chain", "solana", "--labels-from", "/n", "--count", "5", "--keystore", h.vaultPath],
        disagree.deps,
      ),
    ).toBe(2)
    expect(disagree.stderr.text).toContain("disagrees with --labels-from")
  })

  test("a single key with no batch flag answers in the shape it always did", async () => {
    const h = await initVault()
    const k = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    await run(["vault", "new-key", "--chain", "solana", "--json", "--keystore", h.vaultPath], k.deps)
    // No `keys` array and no `count`: every existing --json caller keeps parsing what it parsed
    // before. A batch document is what the BATCH FLAGS select, not what n happens to be.
    expect(Object.keys(JSON.parse(k.stdout.text) as object).sort()).toEqual([
      "address",
      "index",
      "keyId",
      "label",
      "ok",
      "path",
    ])

    // And `--count 1` DOES select it, so a script never has to branch on n.
    const one = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    await run(["vault", "new-key", "--chain", "solana", "--count", "1", "--json", "--keystore", h.vaultPath], one.deps)
    const body = JSON.parse(one.stdout.text) as { count: number; keys: unknown[] }
    expect(body.count).toBe(1)
    expect(body.keys).toHaveLength(1)
  })
})

describe("--count is a convenience for one unlock, never a way to derive keys unattended", () => {
  test("it still refuses without a terminal, asks for nothing, and allocates none of it", async () => {
    const h = await initVault()
    const k = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, tty: false })
    expect(
      await run(["vault", "new-key", "--chain", "solana", "--count", "10", "--keystore", h.vaultPath], k.deps),
    ).toBe(1)
    expect(k.stderr.text).toContain("needs a terminal")
    expect(k.asked).toEqual([])

    // A refusal above the loop fails the WHOLE batch: the counter has not moved. (This assertion
    // used to ride on `--high-value`, which BE-245 removed; the property it pinned is the batch's,
    // not the flag's, so it moved here rather than going with it.)
    const s = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    await run(["vault", "status", "--unlock", "--keystore", h.vaultPath], s.deps)
    expect(s.stdout.text).toContain("solanaVault  0")
  })

  test("it still refuses while CANDLE_KEYSTORE_PASSPHRASE is set: a batch is not the reason to want it back", async () => {
    const h = await initVault()
    const k = await harness({
      env: { CANDLE_CONFIG_DIR: h.dir, CANDLE_KEYSTORE_PASSPHRASE: "anything at all" },
    })
    expect(
      await run(["vault", "new-key", "--chain", "solana", "--count", "10", "--keystore", h.vaultPath], k.deps),
    ).toBe(1)
    expect(k.stderr.text).toContain("CANDLE_KEYSTORE_PASSPHRASE is set")
    expect(k.asked).toEqual([])
  })
})

/**
 * BE-245: the backup offer `init` never made, and the nag `status` never printed.
 *
 * Nothing in `init` mentioned backup at all, and the moment after `init` is exactly when it
 * matters: the vault exists, nothing else has a copy of it, and the operator is still sitting
 * there. The offer is a prompt and a path, not new crypto -- answering yes runs `vault backup`,
 * with the same AD-9 sealing and the same eight-step verification. It appears only where iCloud
 * Drive actually exists, so a Linux VPS never reads a word about it.
 */
describe("BE-245: init offers a backup, and status nags until there is one", () => {
  /** A home of the test's own with iCloud Drive in it, separate from CANDLE_CONFIG_DIR. */
  async function homeWithIcloud(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "candle-vault-home-"))
    await mkdir(join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"), { recursive: true })
    return home
  }

  test("no iCloud Drive on this machine, no offer and no mention of one", async () => {
    const h = await initVault()
    expect(h.asked.some((text) => text.includes("Back up your encrypted vault"))).toBe(false)
    expect(h.stdout.text).not.toContain("iCloud Drive")
  })

  test("yes writes a sealed, verified copy, and the sidecar records it", async () => {
    const home = await homeWithIcloud()
    // Enter (generated), Enter (saved it), no (phrase ceremony), yes (back it up).
    const h = await harness({ env: { HOME: home }, lines: ["", "", "no", "yes"] })
    h.deps.promptSecret = async (text: string) => {
      h.asked.push(`secret: ${text}`)
      return generatedPassphraseFrom(h.stdout.text)
    }
    expect(await run(["vault", "init", "--keystore", h.vaultPath], h.deps)).toBe(0)

    // The copy is `vault backup`'s: same command, same sealing, same eight steps.
    const destination = `${join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "Candle")}/`
    expect(h.stdout.text).toContain(`Verified ${destination}`)
    expect(h.stdout.text).toContain("steps         all 8 passed, in order")
    expect(h.stdout.text).toContain("sealed        yes")

    const sidecar = await readSidecar(sidecarPath(h.vaultPath))
    expect(sidecar?.lastVerifiedBackupAt).toBeDefined()
    expect(sidecar?.lastBackupDomain).toBe("icloud-drive")
    expect(sidecar?.lastBackupSealed).toBe(true)
  })

  test("the offer is honest about going stale, and skipping leaves the command to run", async () => {
    const home = await homeWithIcloud()
    const h = await harness({ env: { HOME: home }, lines: ["", "", "no", "later"] })
    expect(await run(["vault", "init", "--keystore", h.vaultPath], h.deps)).toBe(0)

    // `init` allocates no key, so `verify-backup` calls a copy taken here stale the moment the
    // first `new-key` lands. Said out loud rather than papered over, because the copy is still
    // worth taking: what it protects is the root every key comes back from.
    expect(h.stdout.text).toContain("Back it up again after your first `vault new-key`")
    expect(h.stdout.text).toContain("candle vault backup --to icloud")
    // Anything but yes skips, and skipping costs nothing: the vault is already created.
    const sidecar = await readSidecar(sidecarPath(h.vaultPath))
    expect(sidecar?.lastVerifiedBackupAt).toBeUndefined()
  })

  test("status says a vault has never been backed up, every time, until it has been", async () => {
    const h = await initVault()

    const before = await harness({ env: { CANDLE_CONFIG_DIR: h.dir } })
    await run(["vault", "status", "--keystore", h.vaultPath], before.deps)
    expect(before.stdout.text).toContain(NO_VERIFIED_BACKUP_NOTE)

    // Twice, because "every time" is the point: the fact does not scroll away after one reading.
    const again = await harness({ env: { CANDLE_CONFIG_DIR: h.dir } })
    await run(["vault", "status", "--keystore", h.vaultPath], again.deps)
    expect(again.stdout.text).toContain(NO_VERIFIED_BACKUP_NOTE)

    const elsewhere = await mkdtemp(join(tmpdir(), "candle-vault-backup-to-"))
    const b = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    expect(
      await run(["vault", "backup", "--to", join(elsewhere, "vault.enc"), "--keystore", h.vaultPath], b.deps),
    ).toBe(0)

    const after = await harness({ env: { CANDLE_CONFIG_DIR: h.dir } })
    await run(["vault", "status", "--keystore", h.vaultPath], after.deps)
    expect(after.stdout.text).not.toContain("has ever been verified from this machine")
    expect(after.stdout.text).toContain("last verified backup")
  })
})
