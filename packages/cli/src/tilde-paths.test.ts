/**
 * T10 to T12 (BE-241): D4's literal-`~` refusal and D5's `-k`.
 *
 * `--keystore ~t47/vault.enc` reached `writeFile` as typed in 0.11.0 and `vault init` created a
 * directory literally named `~t47` in the working directory (BE-235, item 4, cause 3). A shell
 * leaves `~t47` alone when no user `t47` exists, and leaves `"~/x"` alone inside double quotes, so
 * the CLI is the only thing that can catch it -- and guessing at a path that holds keys is worse
 * than stopping.
 *
 * The rule attaches to the VALUE's meaning, not the flag's name, which is why the table below has
 * two halves: `--to` is a file on `vault backup` and a key label on `external sweep`, and `--from` is
 * a file on `vault import-legacy` and a label on `vault transfer`.
 */
import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs, refuseUnexpandedTilde, SHORT_FLAGS } from "./args"
import type { Deps } from "./deps"
import { run } from "./index"
import { createCapture, createTestDeps } from "./test-support"

const unreachableFetch = (async () => {
  throw new Error("no test in this file should make a network call")
}) as unknown as typeof fetch

interface Ran {
  code: number
  stdout: string
  stderr: string
  reads: string[]
  writes: string[]
  secretsAsked: string[]
}

async function ran(argv: string[], opts: { env?: Record<string, string> } = {}): Promise<Ran> {
  const dir = await mkdtemp(join(tmpdir(), "candle-tilde-"))
  const stdout = createCapture()
  const stderr = createCapture()
  const reads: string[] = []
  const writes: string[] = []
  const secretsAsked: string[] = []
  const deps: Deps = createTestDeps({
    fetch: unreachableFetch,
    stdout,
    stderr,
    env: { CANDLE_CONFIG_DIR: dir, ...(opts.env ?? {}) },
    isTTY: { stdin: true, stdout: true },
    readFile: (async (path: string) => {
      reads.push(path)
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    }) as Deps["readFile"],
    writeFile: (async (path: string) => {
      writes.push(path)
    }) as Deps["writeFile"],
    promptSecret: async (text: string) => {
      secretsAsked.push(text)
      throw new Error(`a refused invocation must never prompt: ${text}`)
    },
  })
  const code = await run(argv, deps)
  return { code, stdout: stdout.text, stderr: stderr.text, reads, writes, secretsAsked }
}

describe("refuseUnexpandedTilde: the message, in both of its forms", () => {
  test("a flag names the flag and speaks of the path", () => {
    expect(refuseUnexpandedTilde("--keystore", "~t47/vault.enc")).toBe(
      '--keystore ~t47/vault.enc: the path begins with a literal "~", which the shell did not expand and candle will not guess at. Use an absolute path, or set CANDLE_CONFIG_DIR. Nothing was read or written.',
    )
  })

  test("an environment variable is named NAME=value and speaks of the value", () => {
    expect(refuseUnexpandedTilde("CANDLE_CONFIG_DIR", "~t47")).toBe(
      'CANDLE_CONFIG_DIR=~t47: the value begins with a literal "~", which the shell did not expand and candle will not guess at. Use an absolute path, or set CANDLE_CONFIG_DIR. Nothing was read or written.',
    )
  })

  test("a path that does not begin with ~ is not refused, wherever the ~ is", () => {
    expect(refuseUnexpandedTilde("--keystore", "/Users/a/t~47/vault.enc")).toBeUndefined()
    expect(refuseUnexpandedTilde("--keystore", "./relative/vault.enc")).toBeUndefined()
  })

  test("both the bare ~/ form and the ~name form are refused", () => {
    expect(refuseUnexpandedTilde("--keystore", "~/vault.enc")).toBeDefined()
    expect(refuseUnexpandedTilde("--keystore", "~t47/vault.enc")).toBeDefined()
    expect(refuseUnexpandedTilde("--keystore", "~")).toBeDefined()
  })

  test("parseArgs applies it to the flags a spec names as paths, and to no others", () => {
    const spec = { valueFlags: ["--keystore", "--to"], pathFlags: ["--keystore"] }
    expect(parseArgs(["--keystore", "~x/v.enc"], spec)).toEqual({
      error: refuseUnexpandedTilde("--keystore", "~x/v.enc") as string,
    })
    // `--to` is in valueFlags but not in pathFlags on this spec, so it means something else here.
    expect(parseArgs(["--to", "~label"], spec)).toEqual({
      values: { "--to": "~label" },
      booleans: new Set(),
      positionals: [],
    })
  })

  test("parseArgs applies it to a positional a spec names as a path", () => {
    const spec = { pathPositionals: ["<path>"] }
    expect(parseArgs(["~x/copy.enc"], spec)).toEqual({
      error: refuseUnexpandedTilde("<path>", "~x/copy.enc") as string,
    })
    expect(parseArgs(["/tmp/copy.enc"], spec)).toEqual({
      values: {},
      booleans: new Set(),
      positionals: ["/tmp/copy.enc"],
    })
  })
})

/**
 * T10: every path-valued flag and positional in D4's table, one invocation each. `--keystore` is
 * checked on one representative per family (vault, tee, external, sign) plus the commands whose own
 * flags are paths; a spec that forgot its `pathFlags` entry fails the drift test after T10 instead.
 */
const REFUSED: { argv: string[]; flag: string }[] = [
  { argv: ["vault", "status", "--keystore", "~t47/vault.enc"], flag: "--keystore" },
  { argv: ["vault", "status", "-k", "~t47/vault.enc"], flag: "--keystore" },
  { argv: ["vault", "init", "--keystore", "~t47/vault.enc"], flag: "--keystore" },
  { argv: ["vault", "factor", "list", "-k", "~t47/vault.enc"], flag: "--keystore" },
  { argv: ["vault", "enroll", "passphrase", "-k", "~t47/vault.enc"], flag: "--keystore" },
  { argv: ["vault", "phrase", "show", "-k", "~t47/vault.enc"], flag: "--keystore" },
  { argv: ["vault", "new-key", "--chain", "solana", "-k", "~t47/vault.enc"], flag: "--keystore" },
  { argv: ["vault", "backup", "--to", "/tmp/copy.enc", "-k", "~t47/vault.enc"], flag: "--keystore" },
  { argv: ["vault", "backup", "--to", "~backups/copy.enc"], flag: "--to" },
  { argv: ["vault", "verify-backup", "~backups/copy.enc"], flag: "<path>" },
  { argv: ["vault", "export-key", "treasury", "--to", "~out/key.json"], flag: "--to" },
  { argv: ["vault", "import-legacy", "--tee", "--from", "~old/tee-wallets.enc"], flag: "--from" },
  { argv: ["vault", "retire-legacy", "--from", "~old/tee-wallets.enc"], flag: "--from" },
  { argv: ["vault", "restore", "--phrase", "-k", "~t47/vault.enc"], flag: "--keystore" },
  { argv: ["tee", "new", "-k", "~t47/vault.enc"], flag: "--keystore" },
  { argv: ["external", "list", "-k", "~t47/vault.enc"], flag: "--keystore" },
  { argv: ["sign", "--wallet", "w", "-k", "~t47/vault.enc"], flag: "--keystore" },
  { argv: ["sign", "--wallet", "w", "--file", "~in/tx.b64"], flag: "--file" },
  { argv: ["sign", "message", "--wallet", "w", "--file", "~in/msg.txt"], flag: "--file" },
  { argv: ["verify", "~dist/candle"], flag: "<file>" },
  { argv: ["verify", "/tmp/candle", "--bundle", "~dist/candle.sigstore.json"], flag: "--bundle" },
  { argv: ["wallet", "import", "--chain", "solana", "--key-file", "~keys/k.json"], flag: "--key-file" },
  {
    argv: ["wallet", "import", "--chain", "solana", "--key-file", "/tmp/k.json", "--signer-out", "~out/s.json"],
    flag: "--signer-out",
  },
]

describe("T10: a literal ~ is refused, and nothing is read, written or prompted", () => {
  for (const { argv, flag } of REFUSED) {
    test(`candle ${argv.join(" ")}`, async () => {
      const out = await ran(argv)
      expect(out.code).toBe(2)
      expect(out.stderr).toContain(`${flag} ~`)
      expect(out.stderr).toContain('begins with a literal "~"')
      expect(out.stderr).toContain("Nothing was read or written.")
      expect(out.stdout).toBe("")
      expect(out.secretsAsked).toEqual([])
      expect(out.writes).toEqual([])
      // `reads` is the injected `deps.readFile`; the refusal is decided before any of it.
      expect(out.reads).toEqual([])
    })

    test(`candle ${argv.join(" ")} --json`, async () => {
      const out = await ran([...argv, "--json"])
      expect(out.code).toBe(2)
      const body = JSON.parse(out.stdout)
      expect(body.ok).toBe(false)
      expect(body.code).toBe("USAGE")
      expect(body.message).toContain('begins with a literal "~"')
      expect(out.stderr).toBe("")
    })
  }
})

describe("T10: CANDLE_CONFIG_DIR is refused too, and doctor reports it", () => {
  test("vault status refuses, naming the variable", async () => {
    const out = await ran(["vault", "status"], { env: { CANDLE_CONFIG_DIR: "~t47" } })
    expect(out.code).toBe(2)
    expect(out.stderr).toContain('CANDLE_CONFIG_DIR=~t47: the value begins with a literal "~"')
  })

  test("under --json it is the USAGE envelope on stdout", async () => {
    const out = await ran(["vault", "status", "--json"], { env: { CANDLE_CONFIG_DIR: "~t47" } })
    expect(out.code).toBe(2)
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code: "USAGE" })
  })

  test("doctor reports it as a FAIL row rather than crashing", async () => {
    const out = await ran(["doctor", "--json"], { env: { CANDLE_CONFIG_DIR: "~t47" } })
    const body = JSON.parse(out.stdout) as { rows: { check: string; state: string; detail: string }[] }
    const row = body.rows.find((r) => r.check === "Config directory")
    expect(row?.state).toBe("FAIL")
    expect(row?.detail).toContain('begins with a literal "~"')
    // And the vault row cannot be answered without a usable config dir, so it says so.
    expect(body.rows.find((r) => r.check === "Vault")?.state).toBe("SKIP")
  })

  // The env-var check used to hold only on `vaultPathFor` / `doctor`. Tee lookups go through
  // `defaultVaultPath` / `defaultTeeKeystorePath` instead; T10 has to cover those too.
  const teeEnvRefused: { name: string; argv: string[] }[] = [
    { name: "tee status", argv: ["tee", "status", "SomeAddress1111"] },
    { name: "tee new", argv: ["tee", "new"] },
    { name: "tee enable --vault-key", argv: ["tee", "enable", "SomeAddress1111", "--vault-key", "treasury"] },
  ]
  for (const { name, argv } of teeEnvRefused) {
    test(`${name} refuses, naming the variable, without prompting or writing`, async () => {
      const out = await ran(argv, { env: { CANDLE_CONFIG_DIR: "~t47" } })
      expect(out.code).toBe(2)
      expect(out.stderr).toContain('CANDLE_CONFIG_DIR=~t47: the value begins with a literal "~"')
      expect(out.stderr).toContain("Nothing was read or written.")
      expect(out.stdout).toBe("")
      expect(out.secretsAsked).toEqual([])
      expect(out.writes).toEqual([])
    })

    test(`${name} under --json is the USAGE envelope on stdout, and does not throw`, async () => {
      const out = await ran([...argv, "--json"], { env: { CANDLE_CONFIG_DIR: "~t47" } })
      expect(out.code).toBe(2)
      expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code: "USAGE" })
      expect(JSON.parse(out.stdout).message).toContain('begins with a literal "~"')
      expect(out.stderr).toBe("")
      expect(out.secretsAsked).toEqual([])
      expect(out.writes).toEqual([])
    })
  }
})

/**
 * T10 drift: every `parseArgs` spec that takes a flag whose value is always a filesystem path
 * must list it in `pathFlags`. `--to` / `--from` are mixed (file on some commands, label on
 * others) and stay out of this scan; T10's per-invocation table covers those.
 */
const ALWAYS_PATH_FLAGS = ["--keystore", "--file", "--key-file", "--signer-out", "--bundle"] as const

async function commandSourceFiles(): Promise<{ file: string; src: string }[]> {
  const dir = resolve(import.meta.dir, "commands")
  const out: { file: string; src: string }[] = []
  for (const name of (await readdir(dir)).sort()) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue
    out.push({ file: name, src: await readFile(join(dir, name), "utf8") })
  }
  return out
}

describe("T10: a parseArgs spec that takes a path-valued flag lists it in pathFlags", () => {
  test("every always-a-path flag in valueFlags is also in pathFlags", async () => {
    const files = await commandSourceFiles()
    const missing: string[] = []
    const specsSeen = { count: 0, withPathFlag: 0 }
    for (const { file, src } of files) {
      const re = /parseArgs\([\s\S]*?,\s*\{([\s\S]*?)\}\s*\)/g
      for (let match = re.exec(src); match !== null; match = re.exec(src)) {
        const spec = match[1] ?? ""
        specsSeen.count++
        const valueFlags = /valueFlags:\s*\[([^\]]*)\]/.exec(spec)?.[1] ?? ""
        const pathFlags = /pathFlags:\s*\[([^\]]*)\]/.exec(spec)?.[1] ?? ""
        for (const flag of ALWAYS_PATH_FLAGS) {
          if (!valueFlags.includes(`"${flag}"`)) continue
          specsSeen.withPathFlag++
          if (!pathFlags.includes(`"${flag}"`)) {
            missing.push(`${file}: valueFlags has ${flag} but pathFlags does not`)
          }
        }
      }
    }
    // A scan that matched nothing would pass every assertion below.
    expect(specsSeen.count).toBeGreaterThan(20)
    expect(specsSeen.withPathFlag).toBeGreaterThan(10)
    expect(missing).toEqual([])
  })
})

/** T11: the same two flag names, where the value is a label or an address, are NOT refused here. */
describe("T11: a value that is not a path is not touched by the rule", () => {
  const notRefused: string[][] = [
    ["vault", "transfer", "~someone", "--amount", "1", "--asset", "SOL", "--from", "~label", "--rpc-url", "https://r"],
    ["external", "sweep", "~ext", "--to", "~label", "--rpc-url", "https://r"],
    ["vault", "promote", "--in-place", "~label"],
    ["vault", "fund", "~tee", "--amount", "1", "--asset", "SOL", "--rpc-url", "https://r", "--from", "~label"],
    ["tee", "enable", "~addr", "--vault", "~addr2"],
  ]
  for (const argv of notRefused) {
    test(`candle ${argv.join(" ")} fails later, not on the tilde rule`, async () => {
      const out = await ran(argv)
      expect(out.stderr + out.stdout).not.toContain('begins with a literal "~"')
    })
  }
})

/** T12: `-k` is `--keystore`, on exactly the commands that take one. */
describe("T12: -k", () => {
  test("the map holds the one short form this release adds", () => {
    expect(SHORT_FLAGS).toEqual({ "-k": "--keystore" })
  })

  test("-k is keyed as --keystore, so every handler reads one flag", () => {
    const spec = { valueFlags: ["--keystore"], pathFlags: ["--keystore"] }
    expect(parseArgs(["-k", "/tmp/v.enc"], spec)).toEqual({
      values: { "--keystore": "/tmp/v.enc" },
      booleans: new Set(),
      positionals: [],
    })
  })

  test("-k with no value names the token the operator typed", () => {
    expect(parseArgs(["-k"], { valueFlags: ["--keystore"] })).toEqual({ error: "-k requires a value" })
    expect(parseArgs(["-k", "--json"], { valueFlags: ["--keystore"] })).toEqual({ error: "-k requires a value" })
  })

  test("-k=<path> is not a form this parser takes, as with every long flag", () => {
    expect(parseArgs(["-k=/tmp/v.enc"], { valueFlags: ["--keystore"] })).toEqual({
      error: "Unknown flag: -k=/tmp/v.enc",
    })
  })

  test("on a command that takes no keystore, -k is still an unknown flag", async () => {
    for (const argv of [
      ["keys", "list", "-k", "/tmp/v.enc"],
      ["profile", "list", "-k", "/tmp/v.enc"],
      ["auth", "status", "-k", "/tmp/v.enc"],
    ]) {
      const out = await ran(argv)
      expect(out.code).toBe(2)
      expect(out.stderr).toContain("Unknown flag: -k")
    }
  })

  test("-k is indistinguishable from --keystore, on one command per family", async () => {
    // One representative per family in D4's table. `tee new` is absent on purpose: it collects the
    // TEE store's own passphrase from a hidden prompt before it looks at any flag, so there is
    // nothing to compare that is not a prompt.
    const families: [string, string[]][] = [
      ["vault", ["status"]],
      ["vault", ["factor", "list"]],
      ["tee", ["disable", "SomeAddress1111"]],
      ["external", ["list"]],
      ["sign", ["--wallet", "w"]],
    ]
    for (const [word, rest] of families) {
      const path = join(await mkdtemp(join(tmpdir(), `candle-k-${word}-`)), "v.enc")
      const short = await ran([word, ...rest, "-k", path])
      const long = await ran([word, ...rest, "--keystore", path])
      expect(short.code, `${word} ${rest.join(" ")}`).toBe(long.code)
      expect(short.stderr, `${word} ${rest.join(" ")}`).toBe(long.stderr)
      expect(short.stdout, `${word} ${rest.join(" ")}`).toBe(long.stdout)
    }
  })

  test("-k names the vault the same way --keystore does, where the command reports it", async () => {
    for (const argv of [
      ["vault", "status"],
      ["vault", "factor", "list"],
      ["external", "list"],
    ]) {
      const path = join(await mkdtemp(join(tmpdir(), "candle-k-path-")), "v.enc")
      const out = await ran([...argv, "-k", path])
      expect(out.stderr, argv.join(" ")).toContain(`No vault at ${path} (from --keystore).`)
    }
  })
})
