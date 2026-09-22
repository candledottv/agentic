/**
 * Ember Phase 2 (BE-136): shared helpers for the vault tests. Not a `*.test.ts` file itself -- a
 * plain module the test files import, matching `test-support.ts`'s role for the command tests.
 *
 * Two things live here. `withCheapKdf` switches newly created vaults to ED-3's bounds FLOOR for
 * the duration of a suite (see `setTestKdfCost` for why that is a module seam and not a flag), and
 * `makeVault` builds a real vault through the real `createVault`, so every test is asserting
 * against the production write path rather than a hand-assembled file.
 *
 * `tamper` is the third: CC-01's refusals are almost all about a file that was edited outside this
 * CLI, and a test that cannot produce one cannot test them. It edits the parsed JSON and writes it
 * back, which is exactly what "outside this CLI" means.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Deps } from "../deps"
import { type CreateVaultRequest, createVault } from "./create"
import { ARGON2_BOUNDS, setTestKdfCost } from "./crypto"
import type { VaultFile } from "./format"
import {
  closeVault,
  commitVault,
  defaultVaultPath,
  readVaultRaw,
  type UnlockedVault,
  unlockWithPassphrase,
} from "./store"

/** ED-3's accepted floor: the cheapest parameters the reader will open at all. */
export const CHEAP_KDF = { version: ARGON2_BOUNDS.version, m: ARGON2_BOUNDS.m.min, t: ARGON2_BOUNDS.t.min, p: 1 }

/** The fixture vault's passphrase and phrase, spelled here so the tests can be read without them. */
export const FIXTURE_PASSPHRASE = "trombone airfare shrouded unpaved recite cufflink barbell hazelnut"
/** 32 bytes of synthetic entropy: 0x00 01 02 ... 1f. Deterministic, and obviously not a real root. */
export const FIXTURE_ENTROPY = new Uint8Array(32).map((_, i) => i)
/** The 24 words `FIXTURE_ENTROPY` renders. Spelled out so a test can assert the rendering, not
 * only that it round-trips through the same function that produced it. */
export const FIXTURE_PHRASE =
  "abandon amount liar amount expire adjust cage candy arch gather drum bullet absurd math era live bid rhythm alien crouch range attend journey unaware"

/** Switches new vaults to the cheap cost for this module's lifetime. Call at the top of a suite. */
export function useCheapKdf(): void {
  setTestKdfCost(CHEAP_KDF)
}

/**
 * The generated passphrase, read back out of what `vault init` printed -- which is exactly what an
 * operator does, since the words are generated inside the run and exist nowhere else.
 *
 * The character class matters and cost a CI run to learn: the EFF long list contains four
 * hyphenated words (`drop-down`, `felt-tip`, `t-shirt`, `yo-yo`), so a scraper written as
 * `[a-z]+` misses about one generated passphrase in 240 and the command it is driving then fails
 * for a reason that has nothing to do with what the test is asserting.
 */
export function generatedPassphraseFrom(output: string): string {
  const match = /\n {4}([a-z][a-z-]*(?: [a-z][a-z-]*){7})\n/.exec(output)
  if (!match?.[1]) throw new Error(`no generated passphrase in output:\n${output}`)
  return match[1]
}

export async function tempDir(prefix = "candle-vault-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/** A minimal clock for the vault modules, which need only `now` and `sleep`. */
export const testClock: Pick<Deps, "now" | "sleep"> = {
  now: () => Date.parse("2026-09-17T12:00:00.000Z"),
  sleep: async () => {},
}

export interface MadeVault {
  dir: string
  path: string
  passphrase: string
  vault: UnlockedVault
}

/** Creates a real vault in a fresh temp dir, through the real creation path. */
export async function makeVault(
  opts: Partial<Pick<CreateVaultRequest, "passphrase" | "strength" | "rootEntropy" | "hd" | "label">> = {},
): Promise<MadeVault> {
  const dir = await tempDir()
  const path = defaultVaultPath({ CANDLE_CONFIG_DIR: dir })
  const passphrase = opts.passphrase ?? FIXTURE_PASSPHRASE
  const vault = await createVault(
    {
      path,
      passphrase,
      strength: opts.strength ?? "generated-103",
      rootEntropy: opts.rootEntropy ? Uint8Array.from(opts.rootEntropy) : Uint8Array.from(FIXTURE_ENTROPY),
      ...(opts.hd ? { hd: opts.hd } : {}),
      ...(opts.label ? { label: opts.label } : {}),
    },
    testClock,
  )
  return { dir, path, passphrase, vault }
}

/** Re-opens a vault from disk, which is what every "and it still opens" assertion needs. */
export async function reopen(path: string, passphrase = FIXTURE_PASSPHRASE): Promise<UnlockedVault> {
  const raw = await readVaultRaw(path)
  if (raw === null) throw new Error(`no vault at ${path}`)
  return unlockWithPassphrase(path, raw, passphrase)
}

export async function readVaultJson(path: string): Promise<VaultFile> {
  return JSON.parse(await readFile(path, "utf8")) as VaultFile
}

/**
 * Edits a vault file the way something OTHER than this CLI would: parse, mutate, write back. Every
 * CC-01 refusal is about a file in this state, so producing one honestly is the whole test.
 */
export async function tamper(path: string, mutate: (file: VaultFile) => void | VaultFile): Promise<void> {
  const file = await readVaultJson(path)
  const next = mutate(file) ?? file
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8")
}

/**
 * Rewrites labels by address through the real index write path, with none of the commands'
 * guards (BE-259). This is how a test produces the state §2 of the key-naming spec says a vault
 * can already be in -- two keys called `X`, written before `vault new-key` checked names, or by
 * a route that still does not -- now that the command refuses to create one. Same `commitVault`
 * a rename uses, so the fixture is a vault this CLI could have written, not a hand-assembled file.
 */
export async function relabelEntries(path: string, passphrase: string, labels: Record<string, string>): Promise<void> {
  const vault = await reopen(path, passphrase)
  try {
    await commitVault(
      vault,
      {
        index: {
          hd: vault.index.hd,
          entries: vault.index.entries.map((entry) =>
            labels[entry.address] === undefined ? entry : { ...entry, label: labels[entry.address] as string },
          ),
        },
      },
      testClock,
    )
  } finally {
    closeVault(vault)
  }
}

/** Flips one byte inside a base64url ciphertext, leaving it decodable and its tag wrong. */
export function flipByte(base64url: string): string {
  const bytes = Buffer.from(base64url.replace(/-/g, "+").replace(/_/g, "/"), "base64")
  bytes[0] = (bytes[0] ?? 0) ^ 0xff
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
