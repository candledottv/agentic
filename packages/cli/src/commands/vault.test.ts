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
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Deps } from "../deps"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"
import { GENERATED_WORD_COUNT } from "../vault/passphrase"
import { readSidecar, sidecarPath } from "../vault/sidecar"
import { generatedPassphraseFrom, useCheapKdf } from "../vault/test-vault"

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
    env: { CANDLE_CONFIG_DIR: dir, ...(opts.env ?? {}) },
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
 * `init` with the generated passphrase typed back correctly, and the phrase ceremony declined.
 *
 * The passphrase is generated INSIDE the run, so the typed-back answer is only knowable once it
 * has been printed. The prompt therefore reads it off the captured stdout, which is exactly what
 * an operator does: it is on their screen, and they copy it. A second run would generate a
 * different passphrase and prove nothing.
 */
async function initVault(
  opts: { args?: string[]; env?: Record<string, string> } = {},
): Promise<Harness & { passphrase: string }> {
  const h = await harness({ env: opts.env, lines: ["no"] })
  h.deps.promptSecret = async (text: string) => {
    h.asked.push(`secret: ${text}`)
    return generatedPassphraseFrom(h.stdout.text)
  }
  const code = await run(["vault", "init", ...(opts.args ?? []), "--keystore", h.vaultPath], h.deps)
  if (code !== 0) throw new Error(`init failed (${code}): ${h.stderr.text}${h.stdout.text}`)
  return { ...h, passphrase: generatedPassphraseFrom(h.stdout.text) }
}

describe("T33: AD-6's passphrase policy", () => {
  test("the generated passphrase is 8 words, and a typed-back mismatch writes nothing", async () => {
    const h = await harness({ secrets: ["not what was shown"] })
    const code = await run(["vault", "init", "--keystore", h.vaultPath], h.deps)

    expect(code).toBe(1)
    expect(generatedPassphraseFrom(h.stdout.text).split(" ")).toHaveLength(GENERATED_WORD_COUNT)
    expect(h.stderr.text).toContain("did not match the passphrase shown above")
    expect(h.stderr.text).toContain("Nothing was written")
    // Nothing written means nothing on disk, which is what makes a mistyped passphrase free.
    await expect(stat(h.vaultPath)).rejects.toThrow()
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
    // A constructed fixture: the passphrase envelope replaced by an unknown factor, which ED-7
    // keeps but which counts for nothing recoverable.
    const { reopen } = await import("../vault/test-vault")
    const { commitVault } = await import("../vault/store")
    const vault = await reopen(h.vaultPath, h.passphrase)
    await commitVault(
      vault,
      {
        index: vault.index,
        envelopes: [
          {
            ...vault.file.envelopes[0],
            id: "ZZZZZZZZZZZ",
            factor: "secure-enclave",
            domain: "this-device",
          } as (typeof vault.file.envelopes)[0],
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

  test("--high-value needs a generated passphrase or two recoverable domains before new-key runs", async () => {
    const chosen = "a passphrase I picked myself"
    const h = await harness({ secrets: [chosen, chosen], lines: ["no"] })
    expect(await run(["vault", "init", "--own-passphrase", "--high-value", "--keystore", h.vaultPath], h.deps)).toBe(0)
    expect(h.stdout.text).toContain("high value")

    const k = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [chosen] })
    const code = await run(["vault", "new-key", "--chain", "solana", "--keystore", h.vaultPath], k.deps)
    expect(code).toBe(1)
    expect(k.stderr.text).toContain("--high-value")
    expect(k.stderr.text).toContain("two recoverable factors")

    // A generated passphrase satisfies it on its own.
    const g = await initVault({ args: ["--high-value"] })
    const gk = await harness({ env: { CANDLE_CONFIG_DIR: g.dir }, secrets: [g.passphrase] })
    expect(await run(["vault", "new-key", "--chain", "solana", "--keystore", g.vaultPath], gk.deps)).toBe(0)
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
  test("wallets generate and wallets export exit 2 and name the replacement", async () => {
    for (const [args, expected] of [
      [["wallets", "generate", "--chain", "solana", "--count", "2"], "vault new-key"],
      [["wallets", "export", "--index", "0", "--yes"], "No command in this release prints a private key"],
    ] as const) {
      const h = await harness()
      const code = await run([...args], h.deps)
      expect(code).toBe(2)
      expect(h.stderr.text).toContain("was removed in CLI 0.10.0")
      expect(h.stderr.text).toContain(expected)
      // It names the earlier release that still opens a wallets.enc, which is the one thing an
      // operator holding such a file needs.
      expect(h.stderr.text).toContain("cli-v0.9.2")
    }
  })

  test("the same refusal under --json carries the stable code", async () => {
    const h = await harness()
    expect(await run(["wallets", "export", "--json"], h.deps)).toBe(2)
    const body = JSON.parse(h.stdout.text) as { ok: boolean; code: string }
    expect(body).toMatchObject({ ok: false, code: "COMMAND_REMOVED" })
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
