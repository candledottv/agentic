/**
 * T32 (CC-02, ED-3) and the canonical JSON the appendix promises, which is the fourth primitive.
 *
 * The measurement half of T32 is a GATE, not an assertion: the spec asks for wall time on the three
 * shipping shapes and three hardware classes, recorded in the PR, with the release held if the p95
 * exceeds three seconds on the slowest reference. A test cannot decide that, so what runs here is
 * the measurement itself, printed, plus the part that IS a property: parameters outside the bounds
 * are refused before any derivation runs.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { CanonicalJsonError, canonicalJson } from "./canonical-json"
import {
  ARGON2_BOUNDS,
  ARGON2_DEFAULTS,
  assertKdfInBounds,
  b64u,
  derivePassphraseKek,
  freshArgon2Params,
  unb64u,
} from "./crypto"
import { VaultError } from "./errors"

/**
 * These tests run REAL Argon2id, which is the point of them: a vault suite that stubbed the KDF
 * would not be testing the format anyone actually opens. Even at ED-3's bounds floor (see
 * `useCheapKdf`) a single derivation is a few hundred milliseconds, several tests here do five or
 * six of them, and a CI runner sharing a box with every other workspace's suite is slower again.
 * Bun's default per-test budget is 5 s, which one of these exceeded on CI while passing locally --
 * so the budget is stated here rather than discovered once per runner.
 */
setDefaultTimeout(30_000)

describe("canonical JSON: the primitive the appendix asks a third party to reimplement", () => {
  test("keys are sorted and nothing is separated by whitespace", () => {
    expect(canonicalJson({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}')
    expect(canonicalJson({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}')
  })

  test("property order in the input cannot change the output, which is the whole point", () => {
    // Two objects that differ only in insertion order must canonicalize identically, or two writers
    // of the same header would produce two different AEAD tags.
    const one = { format: "candle-vault", version: 2, vaultId: "abc" }
    const two = { vaultId: "abc", version: 2, format: "candle-vault" }
    expect(canonicalJson(one)).toBe(canonicalJson(two))
  })

  test("array order is preserved, because it is the one ordering the caller owns", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]")
    expect(canonicalJson({ envelopes: [{ b: 1, a: 2 }] })).toBe('{"envelopes":[{"a":2,"b":1}]}')
  })

  test("a float, a non-finite number and a negative zero are each refused", () => {
    // A float has no single shortest representation every language agrees on, so admitting one
    // would make the construction un-reimplementable, which is exactly what the appendix promises.
    expect(() => canonicalJson({ m: 1.5 })).toThrow(CanonicalJsonError)
    expect(() => canonicalJson({ m: Number.NaN })).toThrow(CanonicalJsonError)
    expect(() => canonicalJson({ m: Number.POSITIVE_INFINITY })).toThrow(CanonicalJsonError)
    expect(() => canonicalJson({ m: -0 })).toThrow(/negative zero/)
  })

  test("a null is refused, and an undefined is skipped the way JSON.stringify skips it", () => {
    // Two spellings of absent would be two canonical forms of the same header.
    expect(() => canonicalJson({ label: null })).toThrow(/no nulls/)
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
  })

  test("the offending path is named, so a refusal points at a field rather than at the file", () => {
    expect(() => canonicalJson({ envelopes: [{ kdf: { m: 1.5 } }] })).toThrow(/\$\.envelopes\[0\]\.kdf\.m/)
  })

  test("strings, booleans and integers render exactly once each way", () => {
    expect(canonicalJson({ s: 'a "quoted" \n value', t: true, f: false, n: -7 })).toBe(
      '{"f":false,"n":-7,"s":"a \\"quoted\\" \\n value","t":true}',
    )
  })
})

describe("base64url is the one encoding for every binary field", () => {
  test("it round-trips, and it is unpadded", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
    const encoded = b64u(bytes)
    expect(encoded).not.toContain("=")
    expect(encoded).not.toContain("+")
    expect(encoded).not.toContain("/")
    expect([...unb64u(encoded, "test")]).toEqual([...bytes])
  })

  test("a field that is not base64url is refused rather than decoded to garbage", () => {
    expect(() => unb64u("not base64!!", "kdf.salt")).toThrow(VaultError)
    expect(() => unb64u(42 as unknown as string, "kdf.salt")).toThrow(/not a string/)
  })
})

describe("T32: ED-3's bounds are enforced before any derivation runs", () => {
  // Built from ED-3's constants rather than from `freshArgon2Params()`, which another suite's
  // `useCheapKdf()` legitimately redirects: bun shares one process across test files, and the
  // numbers this block is about are the SPEC's, not whatever a sibling suite is writing today.
  const base = () => ({ name: "argon2id" as const, ...ARGON2_DEFAULTS, salt: freshArgon2Params().salt })

  test("the defaults this CLI writes are inside the bounds it accepts on read", () => {
    expect(ARGON2_DEFAULTS.m).toBeGreaterThanOrEqual(ARGON2_BOUNDS.m.min)
    expect(ARGON2_DEFAULTS.m).toBeLessThanOrEqual(ARGON2_BOUNDS.m.max)
    expect(ARGON2_DEFAULTS.t).toBeGreaterThanOrEqual(ARGON2_BOUNDS.t.min)
    expect(ARGON2_DEFAULTS.p).toBe(1)
    expect(() => assertKdfInBounds(base())).not.toThrow()
    // ED-3's own values, pinned so a change to them is a deliberate edit to this test.
    expect({
      m: ARGON2_DEFAULTS.m,
      t: ARGON2_DEFAULTS.t,
      p: ARGON2_DEFAULTS.p,
      version: ARGON2_DEFAULTS.version,
    }).toEqual({
      m: 65536,
      t: 3,
      p: 1,
      version: 19,
    })
  })

  test("the floor is OWASP's minimum and the ceiling stops a hostile file asking for gigabytes", () => {
    expect(ARGON2_BOUNDS.m.min).toBe(19_456)
    expect(ARGON2_BOUNDS.t.min).toBe(2)
    expect(ARGON2_BOUNDS.m.max).toBe(1_048_576)
  })

  test("a parameter outside the bounds is refused, and the message names which one", () => {
    for (const [field, value] of [
      ["m", 1024],
      ["m", 4_000_000],
      ["t", 1],
      ["t", 100],
      ["p", 5],
      ["version", 16],
    ] as const) {
      const kdf = { ...base(), [field]: value }
      try {
        assertKdfInBounds(kdf)
        throw new Error(`expected ${field}=${value} to be refused`)
      } catch (error) {
        expect((error as VaultError).code).toBe("VAULT_KDF_OUT_OF_BOUNDS")
        expect((error as VaultError).message).toContain(field)
      }
    }
  })

  test("a salt outside 16 to 64 bytes is refused, and a wrong kdf name is too", () => {
    expect(() => assertKdfInBounds({ ...base(), salt: b64u(new Uint8Array(8)) })).toThrow(/salt is 8 bytes/)
    expect(() => assertKdfInBounds({ ...base(), salt: b64u(new Uint8Array(65)) })).toThrow(/salt is 65 bytes/)
    expect(() => assertKdfInBounds({ ...base(), name: "scrypt" as "argon2id" })).toThrow(/kdf.name/)
  })

  test("derivation is deterministic, and one byte of salt changes every byte of the key", async () => {
    const kdf = { ...base(), m: ARGON2_BOUNDS.m.min, t: 2 }
    const first = await derivePassphraseKek("a vault passphrase", kdf)
    const second = await derivePassphraseKek("a vault passphrase", kdf)
    expect(b64u(first)).toBe(b64u(second))
    expect(first.length).toBe(32)

    const other = await derivePassphraseKek("a vault passphrase", { ...kdf, salt: b64u(new Uint8Array(16).fill(1)) })
    expect(b64u(other)).not.toBe(b64u(first))
  })

  test("the notice names the cost and never the passphrase or a derived byte", async () => {
    const lines: string[] = []
    const kdf = { ...base(), m: ARGON2_BOUNDS.m.min, t: 2 }
    const kek = await derivePassphraseKek("hunter2 but sixteen chars", kdf, (line) => lines.push(line))
    expect(lines.join("")).toContain("Deriving the vault key (Argon2id, 19 MiB)")
    // BE-259 (D2, T4): the notice is ONE string with its newline inside it, and nothing about it
    // moved. A caller that wants a purpose on the line inserts it before this newline
    // (`derivationNotice` in `commands/vault-support.ts`); this file is not edited for that.
    expect(lines).toEqual(["Deriving the vault key (Argon2id, 19 MiB)\n"])
    expect(lines.join("")).not.toContain("hunter2")
    expect(lines.join("")).not.toContain(b64u(kek).slice(0, 8))
  })

  test("T32 measurement: the default cost on this machine, recorded rather than asserted", async () => {
    // The spec's gate is a p95 across three shipping shapes and three hardware classes, held in the
    // PR and not decidable here. What this does is produce one of those numbers on whatever runs
    // the suite, so the figure in the PR is reproducible rather than remembered.
    const kdf = base()
    const started = performance.now()
    await derivePassphraseKek("a representative vault passphrase", kdf)
    const elapsed = Math.round(performance.now() - started)
    process.stderr.write(`\n  T32 measurement: Argon2id m=${kdf.m} t=${kdf.t} p=${kdf.p} took ${elapsed} ms here\n`)
    // A floor, not a ceiling: a derivation that came back instantly would mean the parameters did
    // not reach the library, which is the failure worth catching automatically.
    expect(elapsed).toBeGreaterThan(50)
  })
})

describe("the EFF wordlist, and the four words that break a naive reader", () => {
  test("it is 7776 unique words, sorted, which is what the entropy claim rests on", async () => {
    const { EFF_LONG_WORDLIST } = await import("./eff-wordlist")
    expect(EFF_LONG_WORDLIST).toHaveLength(7776)
    expect(new Set(EFF_LONG_WORDLIST).size).toBe(7776)
    expect([...EFF_LONG_WORDLIST]).toEqual([...EFF_LONG_WORDLIST].sort())
  })

  test("four of its words are hyphenated, and a generated passphrase may contain one", async () => {
    // Recorded rather than discovered again. A test helper that scraped the printed passphrase as
    // `[a-z]+` missed these and failed about one run in 240, in a command that had nothing to do
    // with the assertion; `generatedPassphraseFrom` now allows a hyphen and this pins why.
    const { EFF_LONG_WORDLIST } = await import("./eff-wordlist")
    const hyphenated = EFF_LONG_WORDLIST.filter((word) => !/^[a-z]+$/.test(word))
    expect(hyphenated).toEqual(["drop-down", "felt-tip", "t-shirt", "yo-yo"])
    // And nothing outside [a-z-] at all, so the scraper's class is complete.
    expect(EFF_LONG_WORDLIST.filter((word) => !/^[a-z][a-z-]*$/.test(word))).toEqual([])
  })

  test("the shared test scraper reads a passphrase containing a hyphenated word", async () => {
    const { generatedPassphraseFrom } = await import("./test-vault")
    const passphrase = "abacus drop-down felt-tip t-shirt yo-yo zoom acorn absurd"
    expect(generatedPassphraseFrom(`some preamble\n\n    ${passphrase}\n\n`)).toBe(passphrase)
  })

  test("a generated passphrase is eight words drawn from that list", async () => {
    const { generatePassphrase, GENERATED_WORD_COUNT } = await import("./passphrase")
    const { EFF_LONG_WORDLIST } = await import("./eff-wordlist")
    const list = new Set(EFF_LONG_WORDLIST)
    for (let i = 0; i < 25; i++) {
      const words = generatePassphrase().split(" ")
      expect(words).toHaveLength(GENERATED_WORD_COUNT)
      for (const word of words) expect(list.has(word)).toBe(true)
    }
  })
})

describe("the test-only KDF cost seam cannot be reached from a real invocation", () => {
  test("only test files and the test helper call setTestKdfCost", () => {
    // The same grep-level discipline T39 applies to CANDLE_KEYSTORE_PASSPHRASE. A weakened KDF that
    // a flag or an environment variable could reach would be the worst kind of convenience, so the
    // seam's ONLY writers are asserted here rather than left to a reviewer's memory.
    const srcDir = resolve(import.meta.dir, "..")
    const callers: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) {
          walk(path)
        } else if (name.endsWith(".ts") && readFileSync(path, "utf8").includes("setTestKdfCost")) {
          callers.push(path.slice(srcDir.length + 1))
        }
      }
    }
    walk(srcDir)
    // `vault/crypto.ts` defines it and `vault/test-vault.ts` is the helper suites call; everything
    // else that names it must be a test file. Anything in a SHIPPING path would mean a real
    // invocation could reach it.
    const shipping = callers.filter((path) => !path.endsWith(".test.ts"))
    expect(shipping.sort()).toEqual(["vault/crypto.ts", "vault/test-vault.ts"])
    // And the helper is not reachable from any command, so no argument or flag leads to it.
    const commandsNamingIt = callers.filter((path) => path.startsWith("commands/"))
    expect(commandsNamingIt).toEqual([])
  })
})
