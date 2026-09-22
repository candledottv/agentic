/**
 * BE-259 (spec `2026-09-22-cli-vault-key-naming-design.md`): `candle vault rename`, end to end
 * through `run()`. T5 (the label changes and the resolver follows), T6 (the invariant, over the
 * bytes), T7 (the file version does not move), T8 (the five refusals), T9 (the real count and every
 * candidate), T10 (a restored vault renames), T11 (a legacy address held twice and `--id`), T20
 * (concurrency is `VAULT_CHANGED`) and T21 (same name is two checks).
 *
 * Every vault here is made through the real creation path and every key through the real
 * commands, with one deliberate exception: `relabelEntries` writes duplicate labels through
 * `commitVault` with none of the commands' guards, because that is the state §2 of the spec says a
 * vault can already be in and `vault new-key` now refuses to produce it.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { base58 } from "@scure/base"
import { Keypair } from "@solana/web3.js"
import type { Deps } from "../deps"
import { run } from "../index"
import { SECRET_REFS } from "../secret-store"
import { createCapture, createFakeStore, createRoutedFetch, createTestDeps, jsonResponse } from "../test-support"
import type { KeyEntry } from "../vault/format"
import { findVaultRoleEntry } from "../vault/promote-support"
import { closeVault, commitVault, decryptKey, sealKeyBlob } from "../vault/store"
import {
  FIXTURE_PHRASE,
  generatedPassphraseFrom,
  makeVault,
  readVaultJson,
  relabelEntries,
  reopen,
  testClock,
  useCheapKdf,
} from "../vault/test-vault"
import {
  createKeystore,
  defaultTeeKeystorePath,
  type KeystoreEntry,
  serializeKeystore,
  TEE_KEYSTORE_PURPOSE,
  writeKeystoreFile,
} from "../wallet-keystore"
import { RENAME_USAGE, SAME_STRING_LINE } from "./vault-rename"

setDefaultTimeout(60_000)
useCheapKdf()

const unreachableFetch = (async () => {
  throw new Error("no test in this file should make a network call")
}) as unknown as typeof fetch

interface Fixture {
  dir: string
  path: string
  passphrase: string
}

/** A real vault with no keys yet, closed: every command below opens it for itself. */
async function fixture(): Promise<Fixture> {
  const made = await makeVault()
  closeVault(made.vault)
  return { dir: made.dir, path: made.path, passphrase: made.passphrase }
}

interface Run {
  code: number
  stdout: string
  stderr: string
  /** How many times the passphrase was asked for: zero proves a refusal came before the unlock. */
  prompted: number
}

/** One command against the fixture, with fresh captures and the passphrase on a hidden prompt. */
async function cmd(
  fx: Fixture,
  argv: string[],
  opts: { beforeSecret?: () => Promise<void>; deps?: Partial<Deps> } = {},
): Promise<Run> {
  const stdout = createCapture()
  const stderr = createCapture()
  let prompted = 0
  const deps = createTestDeps({
    fetch: unreachableFetch,
    stdout,
    stderr,
    env: { CANDLE_CONFIG_DIR: fx.dir, HOME: fx.dir },
    isTTY: { stdin: true, stdout: true },
    promptSecret: async () => {
      prompted++
      await opts.beforeSecret?.()
      return fx.passphrase
    },
    promptLine: async () => "no",
    ...(opts.deps ?? {}),
  })
  const code = await run(argv, deps)
  return { code, stdout: stdout.text, stderr: stderr.text, prompted }
}

function json(out: Run): Record<string, unknown> {
  const lines = out.stdout.trimEnd().split("\n").filter(Boolean)
  expect(lines, `expected one JSON line, got:\n${out.stdout}`).toHaveLength(1)
  return JSON.parse(lines[0] as string) as Record<string, unknown>
}

/** `vault new-key --label`, answering the new key's address. */
async function newKey(fx: Fixture, label: string): Promise<string> {
  const out = await cmd(fx, ["vault", "new-key", "--chain", "solana", "--label", label, "--json"])
  if (out.code !== 0) throw new Error(`new-key ${label} failed: ${out.stderr}${out.stdout}`)
  return json(out).address as string
}

async function entries(fx: Fixture): Promise<KeyEntry[]> {
  const vault = await reopen(fx.path, fx.passphrase)
  try {
    return vault.index.entries
  } finally {
    closeVault(vault)
  }
}

async function bytes(fx: Fixture): Promise<string> {
  return readFile(fx.path, "utf8")
}

/** The refusal shape T8 asserts for every code: exit 1, the envelope, and an unchanged file. */
async function refused(fx: Fixture, argv: string[]): Promise<{ body: Record<string, unknown>; out: Run }> {
  const before = await bytes(fx)
  const out = await cmd(fx, [...argv, "--json"])
  expect(out.code).toBe(1)
  const body = json(out)
  expect(body.ok).toBe(false)
  expect(await bytes(fx)).toBe(before)
  return { body, out }
}

describe("T5: rename changes the label, and the resolver follows it", () => {
  test("--from <new> resolves the key --from <old> used to, and <old> resolves nothing", async () => {
    const fx = await fixture()
    const treasury = await newKey(fx, "treasury")
    await newKey(fx, "ops")
    {
      const vault = await reopen(fx.path, fx.passphrase)
      expect(findVaultRoleEntry(vault.index, "treasury")?.address).toBe(treasury)
      closeVault(vault)
    }

    const out = await cmd(fx, ["vault", "rename", "treasury", "treasury-cold"])
    expect(out.code).toBe(0)
    expect(out.stdout).toContain("Renamed treasury to treasury-cold.\n")
    expect(out.stdout).toContain(`  address     ${treasury}\n`)
    expect(out.stdout).toContain("  role        vault\n")
    expect(out.stdout).toContain("  unchanged   address, derivation path, key blob, every envelope\n")
    expect(out.prompted).toBe(1)

    const vault = await reopen(fx.path, fx.passphrase)
    expect(findVaultRoleEntry(vault.index, "treasury-cold")?.address).toBe(treasury)
    expect(findVaultRoleEntry(vault.index, "treasury")).toBeUndefined()
    // The other key is untouched.
    expect(findVaultRoleEntry(vault.index, "ops")).toBeDefined()
    closeVault(vault)
  })

  test("<old> may be the address, and --json is the receipt: id, address, role, from, to", async () => {
    const fx = await fixture()
    const treasury = await newKey(fx, "treasury")
    const [entry] = await entries(fx)
    const out = await cmd(fx, ["vault", "rename", treasury, "cold", "--json"])
    expect(out.code).toBe(0)
    expect(json(out)).toEqual({
      ok: true,
      id: entry?.id,
      address: treasury,
      role: "vault",
      from: "treasury",
      to: "cold",
    })
    expect((await entries(fx))[0]?.label).toBe("cold")
  })
})

describe("T6: the invariant, asserted over the bytes on disk", () => {
  test("only one entry's label and the index write's own bookkeeping change", async () => {
    const fx = await fixture()
    await newKey(fx, "treasury")
    await newKey(fx, "ops")
    const before = await readVaultJson(fx.path)
    const beforeIndex = await indexOf(fx)

    expect((await cmd(fx, ["vault", "rename", "ops", "fee-payer"])).code).toBe(0)

    const after = await readVaultJson(fx.path)
    const afterIndex = await indexOf(fx)
    // Everything sealed stays byte for byte: the root, every key blob, every envelope.
    for (const field of ["root", "keys", "keyIds", "envelopes", "vaultId", "createdAt", "cipher", "format"] as const) {
      expect(after[field], field).toEqual(before[field] as never)
    }
    expect(after.version).toBe(before.version)
    expect(after.generation).toBe(before.generation + 1)
    // The index blob itself is re-sealed under the new header with a fresh IV: it MUST differ.
    expect(after.index).not.toEqual(before.index)

    // Inside the index: the `hd` record is deep-equal, and exactly one entry differs, in `label`
    // and in no other field.
    expect(afterIndex.hd).toEqual(beforeIndex.hd)
    expect(afterIndex.entries).toHaveLength(beforeIndex.entries.length)
    const differing = beforeIndex.entries
      .map((entry, at) => [entry, afterIndex.entries[at]] as const)
      .filter(([was, is]) => JSON.stringify(was) !== JSON.stringify(is))
    expect(differing).toHaveLength(1)
    const [was, is] = differing[0] as [KeyEntry, KeyEntry]
    expect(was.label).toBe("ops")
    expect(is).toEqual({ ...was, label: "fee-payer" })
  })
})

/** The decrypted index, read fresh from disk. */
async function indexOf(fx: Fixture): Promise<{ hd: unknown; entries: KeyEntry[] }> {
  const vault = await reopen(fx.path, fx.passphrase)
  try {
    return { hd: vault.index.hd, entries: vault.index.entries }
  } finally {
    closeVault(vault)
  }
}

describe("T7: the file version does not move", () => {
  test("a version 2 file stays version 2 across a rename of a vault entry", async () => {
    const fx = await fixture()
    await newKey(fx, "treasury")
    expect((await readVaultJson(fx.path)).version).toBe(2)
    expect((await cmd(fx, ["vault", "rename", "treasury", "cold"])).code).toBe(0)
    expect((await readVaultJson(fx.path)).version).toBe(2)
  })

  test("a version 3 file stays version 3, for an external entry and for a vault entry", async () => {
    const fx = await fixture()
    await newKey(fx, "treasury")
    expect((await cmd(fx, ["external", "new", "--label", "trader"])).code).toBe(0)
    expect((await readVaultJson(fx.path)).version).toBe(3)

    const ext = await cmd(fx, ["vault", "rename", "trader", "bot-signer", "--json"])
    expect(ext.code).toBe(0)
    expect(json(ext)).toMatchObject({ ok: true, role: "external", from: "trader", to: "bot-signer" })
    expect((await readVaultJson(fx.path)).version).toBe(3)

    expect((await cmd(fx, ["vault", "rename", "treasury", "cold"])).code).toBe(0)
    expect((await readVaultJson(fx.path)).version).toBe(3)
    const labels = (await entries(fx)).map((entry) => [entry.role, entry.label])
    expect(labels).toEqual([
      ["vault", "cold"],
      ["external", "bot-signer"],
    ])
  })
})

describe("T8: the five refusals, each with its code, exit, message, suggestion and an unchanged file", () => {
  test("VAULT_LABEL_NOT_FOUND", async () => {
    const fx = await fixture()
    await newKey(fx, "treasury")
    const { body } = await refused(fx, ["vault", "rename", "ghost", "cold"])
    expect(body.code).toBe("VAULT_LABEL_NOT_FOUND")
    expect(body.message).toBe("No key in this vault is called ghost, and no key has that address or id.")
    expect(body.suggestion).toBe("List them with their labels: `candle vault status --unlock`")

    // With --id the id is what was looked up, and the message says so.
    const byId = await refused(fx, ["vault", "rename", "treasury", "cold", "--id", "nope"])
    expect(byId.body.code).toBe("VAULT_LABEL_NOT_FOUND")
    expect(byId.body.message).toBe("No key in this vault has the id nope.")

    // Human mode: exit 1 and the same sentence on stderr.
    const human = await cmd(fx, ["vault", "rename", "ghost", "cold"])
    expect(human.code).toBe(1)
    expect(human.stderr).toContain("No key in this vault is called ghost")
  })

  test("VAULT_LABEL_TAKEN: <new> is some other entry's label", async () => {
    const fx = await fixture()
    await newKey(fx, "treasury")
    await newKey(fx, "ops")
    const { body } = await refused(fx, ["vault", "rename", "treasury", "ops"])
    expect(body.code).toBe("VAULT_LABEL_TAKEN")
    expect(body.message).toBe("A key labelled ops already exists in this vault. Nothing was written.")
    expect(body.suggestion).toBe(
      "Choose a name no key has, or rename that key first: `candle vault status --unlock` lists them.",
    )
  })

  test("VAULT_LABEL_UNCHANGED: the resolved entry's label already equals <new>", async () => {
    const fx = await fixture()
    const treasury = await newKey(fx, "treasury")
    const { body } = await refused(fx, ["vault", "rename", treasury, "treasury"])
    expect(body.code).toBe("VAULT_LABEL_UNCHANGED")
    expect(body.message).toBe("treasury is already this key's label. Nothing was written.")
    expect(body.suggestion).toBe("Nothing to rename. `candle vault status --unlock` lists every label.")
  })

  test("VAULT_LABEL_AMBIGUOUS: more than one entry carries <old>", async () => {
    const fx = await fixture()
    const a = await newKey(fx, "a")
    const b = await newKey(fx, "b")
    await relabelEntries(fx.path, fx.passphrase, { [a]: "treasury", [b]: "treasury" })
    const { body } = await refused(fx, ["vault", "rename", "treasury", "cold"])
    expect(body.code).toBe("VAULT_LABEL_AMBIGUOUS")
    expect(body.message).toBe(
      "2 keys in this vault are called treasury, so this rename would not say which one it meant. Nothing was written.",
    )
    const [first, second] = await entries(fx)
    expect(body.suggestion).toBe(
      `Name one by address or id. The candidates are ${a} (${first?.id}), ${b} (${second?.id}).`,
    )
  })

  test("VAULT_RENAME_ROLE_REFUSED: a TEE wallet's label also lives on the linked wallet", async () => {
    const fx = await fixture()
    const { keypair } = legacyEntry("hot", 0)
    await importLegacy(fx, [legacyEntry("hot", 0, keypair).entry])
    const migrated = (await entries(fx)).find((entry) => entry.label === "hot")
    expect(migrated?.role).toBe("tee-wallet")

    const { body } = await refused(fx, ["vault", "rename", "hot", "cold"])
    expect(body.code).toBe("VAULT_RENAME_ROLE_REFUSED")
    expect(body.message).toBe(
      "hot is a TEE wallet. Its label was sent to Candle when it was enabled and `candle wallets` lists that copy, so renaming it here would give one wallet two names and nothing reconciles them.",
    )
    expect(body.suggestion).toBe(
      "A vault key or an external wallet renames here. For a TEE wallet, nothing in this release changes the name on either side.",
    )
    // By address and by --id the answer is the same: the role decides, not the handle.
    expect((await refused(fx, ["vault", "rename", keypair.publicKey.toBase58(), "cold"])).body.code).toBe(
      "VAULT_RENAME_ROLE_REFUSED",
    )
    expect((await refused(fx, ["vault", "rename", "hot", "cold", "--id", migrated?.id ?? ""])).body.code).toBe(
      "VAULT_RENAME_ROLE_REFUSED",
    )
  })
})

describe("T9: VAULT_LABEL_AMBIGUOUS uses the real count and lists every candidate", () => {
  test("a label collision of three: the count is 3, every address and id is listed, no 'Two', no 'and'", async () => {
    const fx = await fixture()
    const a = await newKey(fx, "a")
    const b = await newKey(fx, "b")
    const c = await newKey(fx, "c")
    await relabelEntries(fx.path, fx.passphrase, { [a]: "treasury", [b]: "treasury", [c]: "treasury" })
    const [ea, eb, ec] = await entries(fx)

    const { body } = await refused(fx, ["vault", "rename", "treasury", "cold"])
    expect(body.code).toBe("VAULT_LABEL_AMBIGUOUS")
    expect(body.message).toBe(
      "3 keys in this vault are called treasury, so this rename would not say which one it meant. Nothing was written.",
    )
    expect(body.suggestion).toBe(
      `Name one by address or id. The candidates are ${a} (${ea?.id}), ${b} (${eb?.id}), ${c} (${ec?.id}).`,
    )
    expect(body.message).not.toContain("Two")
    expect(body.suggestion).not.toContain(" and ")

    // Re-running with any one listed disambiguator resolves THAT entry: the address for one, the
    // id for another. The third keeps its name.
    expect((await cmd(fx, ["vault", "rename", b, "treasury-eu"])).code).toBe(0)
    expect((await cmd(fx, ["vault", "rename", "treasury", "treasury-us", "--id", ec?.id ?? ""])).code).toBe(0)
    const after = await entries(fx)
    expect(after.map((entry) => entry.label)).toEqual(["treasury", "treasury-eu", "treasury-us"])
    expect(after.map((entry) => entry.id)).toEqual([ea?.id as string, eb?.id as string, ec?.id as string])
    // With one holder left, the label resolves on its own again.
    expect((await cmd(fx, ["vault", "rename", "treasury", "treasury-cold"])).code).toBe(0)
  })

  test("an address collision: the count is real, every candidate is listed, and --id is the way through", async () => {
    const fx = await fixture()
    const treasury = await newKey(fx, "treasury")
    // The shape D4 names: one address under two ids. Built through the real seal and commit path,
    // with the same secret sealed twice under a second id, which is what a legacy store that held
    // one address twice produces on migration (T11 drives that path through the command).
    const vault = await reopen(fx.path, fx.passphrase)
    const [original] = vault.index.entries
    if (original === undefined) throw new Error("no entry")
    const secret = await decryptKey(vault, original.id)
    const twinId = "TwinId01"
    const blob = await sealKeyBlob(vault, twinId, secret)
    secret.fill(0)
    await commitVault(
      vault,
      {
        index: { hd: vault.index.hd, entries: [...vault.index.entries, { ...original, id: twinId, label: "twin" }] },
        addKeys: [blob],
      },
      testClock,
    )
    closeVault(vault)

    const { body } = await refused(fx, ["vault", "rename", treasury, "cold"])
    expect(body.code).toBe("VAULT_LABEL_AMBIGUOUS")
    expect(body.message).toBe(
      `2 keys in this vault have the address ${treasury}, so this rename would not say which one it meant. Nothing was written.`,
    )
    expect(body.suggestion).toBe(
      `Name one by id. The candidates are ${treasury} (${original.id}), ${treasury} (${twinId}). Re-run: \`candle vault rename ${treasury} <new-label> --id ${original.id}\`.`,
    )
    expect(body.suggestion).not.toContain(" and ")

    const fixed = await cmd(fx, ["vault", "rename", treasury, "cold", "--id", twinId, "--json"])
    expect(fixed.code).toBe(0)
    expect(json(fixed)).toMatchObject({ ok: true, id: twinId, address: treasury, from: "twin", to: "cold" })
    expect((await entries(fx)).map((entry) => [entry.id, entry.label])).toEqual([
      [original.id, "treasury"],
      [twinId, "cold"],
    ])
  })
})

describe("T10: a restored vault renames, because rename is not an allocation", () => {
  test("no VAULT_ALLOCATION_BOUNDARY_UNKNOWN: the key-<n> a restore invents can be given its real name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-rename-restore-"))
    const path = join(dir, "vault.enc")
    const stdout = createCapture()
    const stderr = createCapture()
    const routed = createRoutedFetch({
      "/api/v1/agent/wallets/embedded": () =>
        jsonResponse(200, { success: true, account: "AcctAddress1111111111111111111abcdef" }),
      "/api/v1/agent/wallets": [() => jsonResponse(200, { success: true, page: [], isDone: true })],
    })
    let askedPhrase = false
    const deps = createTestDeps({
      fetch: routed.fetch,
      stdout,
      stderr,
      store: createFakeStore({ [SECRET_REFS.apiKey]: "ck_live_testkey" }),
      env: { CANDLE_CONFIG_DIR: dir, HOME: dir },
      isTTY: { stdin: true, stdout: true },
      promptSecret: async () => {
        if (!askedPhrase) {
          askedPhrase = true
          return FIXTURE_PHRASE
        }
        return generatedPassphraseFrom(stdout.text)
      },
      promptLine: async (text: string) => (text.includes("last six characters") ? "abcdef" : "no"),
    })
    expect(await run(["vault", "restore", "--phrase", "--count", "1", "--keystore", path], deps)).toBe(0)
    const fx: Fixture = { dir, path, passphrase: generatedPassphraseFrom(stdout.text) }
    const restored = await entries(fx)
    expect(restored[0]?.label).toBe("key-0")
    expect(restored[0]?.exposure.exposureUnknown).toBe(true)

    // Allocation is refused here; a rename is not one.
    const alloc = await cmd(fx, ["vault", "new-key", "--chain", "solana", "--json"])
    expect(json(alloc).code).toBe("VAULT_ALLOCATION_BOUNDARY_UNKNOWN")

    const out = await cmd(fx, ["vault", "rename", "key-0", "treasury", "--json"])
    expect(out.code).toBe(0)
    expect(json(out)).toMatchObject({ ok: true, from: "key-0", to: "treasury", role: "vault" })
    expect((await entries(fx))[0]).toEqual({ ...(restored[0] as KeyEntry), label: "treasury" })
  })
})

describe("T11: a legacy store holding one address twice", () => {
  test("both copies migrate, the address is ambiguous, and --id is the handle that still resolves", async () => {
    const fx = await fixture()
    const { keypair } = legacyEntry("hot-a", 0)
    await importLegacy(fx, [legacyEntry("hot-a", 0, keypair).entry, legacyEntry("hot-b", 1, keypair).entry])
    const address = keypair.publicKey.toBase58()
    const migrated = (await entries(fx)).filter((entry) => entry.address === address)
    expect(migrated.map((entry) => entry.label)).toEqual(["hot-a", "hot-b"])
    expect(new Set(migrated.map((entry) => entry.id)).size).toBe(2)

    const { body } = await refused(fx, ["vault", "rename", address, "cold"])
    expect(body.code).toBe("VAULT_LABEL_AMBIGUOUS")
    expect(body.message).toBe(
      `2 keys in this vault have the address ${address}, so this rename would not say which one it meant. Nothing was written.`,
    )
    expect(body.suggestion).toContain(`${address} (${migrated[0]?.id}), ${address} (${migrated[1]?.id})`)
    expect(body.suggestion).toContain(`--id ${migrated[0]?.id}`)

    // `--id` resolves exactly one of them. These are TEE wallets, so what it reaches is D6's
    // refusal -- and that refusal names the entry the id picked, which is the resolution.
    const second = await refused(fx, ["vault", "rename", address, "cold", "--id", migrated[1]?.id ?? ""])
    expect(second.body.code).toBe("VAULT_RENAME_ROLE_REFUSED")
    expect(second.body.message).toStartWith("hot-b is a TEE wallet.")
  })
})

describe("T20: concurrency is VAULT_CHANGED, with nothing written", () => {
  test("a second rename that lands between this one's read and its commit is refused", async () => {
    const fx = await fixture()
    await newKey(fx, "a")
    await newKey(fx, "b")
    let other: Run | undefined
    const out = await cmd(fx, ["vault", "rename", "a", "a-renamed", "--json"], {
      // While the first rename waits at its passphrase prompt, holding the bytes it read, another
      // command writes the vault. The sub-second window every vault write has, held open.
      beforeSecret: async () => {
        if (other === undefined) other = await cmd(fx, ["vault", "rename", "b", "b-renamed"])
      },
    })
    expect(other?.code).toBe(0)
    expect(out.code).toBe(1)
    expect(json(out)).toMatchObject({
      ok: false,
      code: "VAULT_CHANGED",
      suggestion: "Another candle command wrote to it. Run this one again.",
    })
    // The other command's write is the file's whole state: this one wrote nothing on top of it.
    expect((await entries(fx)).map((entry) => entry.label)).toEqual(["a", "b-renamed"])
    // And the operator re-runs, as the suggestion says.
    expect((await cmd(fx, ["vault", "rename", "a", "a-renamed"])).code).toBe(0)
    expect((await entries(fx)).map((entry) => entry.label)).toEqual(["a-renamed", "b-renamed"])
  })
})

describe("T21: same name is two checks", () => {
  test("rename X X is exit 2 before the unlock: no prompt, the file is not opened, nothing moves", async () => {
    const fx = await fixture()
    await newKey(fx, "treasury")
    const before = await readVaultJson(fx.path)
    const out = await cmd(fx, ["vault", "rename", "treasury", "treasury"])
    expect(out.code).toBe(2)
    expect(out.prompted).toBe(0)
    expect(out.stderr).toBe(`${SAME_STRING_LINE}\n`)
    expect(out.stdout).toBe("")
    expect(await readVaultJson(fx.path)).toEqual(before)
    // The same refusal for a name that is nowhere in the vault: nothing was resolved.
    const ghost = await cmd(fx, ["vault", "rename", "ghost", "ghost", "--json"])
    expect(ghost.code).toBe(2)
    expect(ghost.prompted).toBe(0)
    expect(json(ghost)).toEqual({ ok: false, code: "USAGE", message: SAME_STRING_LINE })
  })

  test("rename <address> <current-label> is exit 1 VAULT_LABEL_UNCHANGED after the unlock, file byte-identical", async () => {
    const fx = await fixture()
    const treasury = await newKey(fx, "treasury")
    const before = await bytes(fx)
    const out = await cmd(fx, ["vault", "rename", treasury, "treasury", "--json"])
    expect(out.code).toBe(1)
    expect(out.prompted).toBe(1)
    expect(json(out).code).toBe("VAULT_LABEL_UNCHANGED")
    expect(await bytes(fx)).toBe(before)
    expect((await readVaultJson(fx.path)).generation).toBe(JSON.parse(before).generation)
  })
})

describe("the argument-shape refusals: exit 2, before any prompt", () => {
  test("wrong argument count", async () => {
    const fx = await fixture()
    for (const argv of [
      ["vault", "rename"],
      ["vault", "rename", "only"],
      ["vault", "rename", "a", "b", "c"],
    ]) {
      const out = await cmd(fx, argv)
      expect(out.code).toBe(2)
      expect(out.prompted).toBe(0)
      expect(out.stderr).toBe(`${RENAME_USAGE}\n`)
    }
  })

  test("an empty, whitespace-only or control-character <new> is refused", async () => {
    const fx = await fixture()
    await newKey(fx, "treasury")
    const before = await bytes(fx)
    const cases: [string, string][] = [
      ["", "A key's label cannot be empty."],
      ["   ", "A key's label cannot be empty."],
      ["a\tb", "A key's label cannot contain a newline, a tab or a control character."],
      ["a\nb", "A key's label cannot contain a newline, a tab or a control character."],
    ]
    for (const [label, line] of cases) {
      const out = await cmd(fx, ["vault", "rename", "treasury", label])
      expect([label, out.code]).toEqual([label, 2])
      expect(out.prompted).toBe(0)
      expect(out.stderr).toBe(`${line}\n`)
    }
    expect(await bytes(fx)).toBe(before)
  })

  test("a leading dash never reaches the command: the parser refuses it as a flag", async () => {
    const fx = await fixture()
    const out = await cmd(fx, ["vault", "rename", "treasury", "-cold"])
    expect(out.code).toBe(2)
    expect(out.prompted).toBe(0)
    expect(out.stderr).toContain("Unknown flag: -cold")
  })

  test("no terminal: the unlock is refused before anything is asked, in both modes", async () => {
    const fx = await fixture()
    const out = await cmd(fx, ["vault", "rename", "treasury", "cold", "--json"], {
      deps: { isTTY: { stdin: false, stdout: false } },
    })
    expect(out.code).toBe(1)
    expect(out.prompted).toBe(0)
    expect(json(out).code).toBe("VAULT_UNLOCK_FAILED")
  })
})

// ── The legacy TEE store fixture (T8's role refusal and T11) ─────────────────────────────────

const TEE_PASS = "a strong tee-store passphrase for BE-259"

/** One Phase 1 `tee new` entry: never enabled, so it migrates as a `local-candidate` TEE wallet
 * with no grant and no network call. The same keypair can be given to two entries, which is the
 * store T11 needs. */
function legacyEntry(
  label: string,
  index: number,
  keypair = Keypair.generate(),
): { keypair: Keypair; entry: KeystoreEntry } {
  return {
    keypair,
    entry: {
      index,
      chain: "solana",
      address: keypair.publicKey.toBase58(),
      label,
      createdAt: "2026-09-17T00:00:00.000Z",
      privateKey: base58.encode(keypair.secretKey),
      imported: false,
      tee: { network: "solana-mainnet" },
    },
  }
}

/** Seeds `tee-wallets.enc` beside the vault and migrates it with `vault import-legacy --tee`. */
async function importLegacy(fx: Fixture, legacy: KeystoreEntry[]): Promise<void> {
  const ks = await createKeystore(TEE_PASS)
  const teePath = defaultTeeKeystorePath({ CANDLE_CONFIG_DIR: fx.dir })
  await writeKeystoreFile(
    teePath,
    await serializeKeystore(legacy, ks.key, ks.salt, ks.iterations, TEE_KEYSTORE_PURPOSE),
  )
  const secrets = [TEE_PASS, fx.passphrase]
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    fetch: unreachableFetch,
    stdout,
    stderr,
    env: { CANDLE_CONFIG_DIR: fx.dir, HOME: fx.dir },
    isTTY: { stdin: true, stdout: true },
    promptSecret: async () => {
      const next = secrets.shift()
      if (next === undefined) throw new Error("import-legacy asked for more than the test scripted")
      return next
    },
    promptLine: async () => {
      throw new Error("import-legacy must not promptLine")
    },
    readFile: (path) => readFile(path, "utf8"),
    writeFile: (path, content) => writeFile(path, content, "utf8"),
  })
  const code = await run(["vault", "import-legacy", "--tee", "--from", teePath, "--keystore", fx.path], deps)
  if (code !== 0) throw new Error(`import-legacy failed (${code}): ${stderr.text}${stdout.text}`)
}
