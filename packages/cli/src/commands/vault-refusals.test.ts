/**
 * T9 (BE-241, D3): every typed refusal an operator can act on carries a next step, and the two they
 * meet while setting a vault up say WHERE they looked and WHY.
 *
 * Two halves. The first is a source scan in the shape this package already uses for a drift test
 * (`declared-imports.test.ts`, `wallet-import.drift.test.ts`): every `new VaultError(` in
 * `commands/*.ts` carries a `suggestion` unless its code is allowlisted below with a reason. The
 * scan is deliberately limited to `commands/`, the refusals an operator reaches from the terminal;
 * the ~40 sites under `src/vault/` are the library's own and mostly surface through a command that
 * wraps them, which is a different card.
 *
 * The second half is behavioural: `VAULT_MISSING` and `VAULT_EXISTS` from a real run, once per path
 * source, in both modes.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"
import { VAULT_ERROR_CODES } from "../vault/errors"
import { INSTALL_HELPER_SENTENCE } from "../vault/platform"

setDefaultTimeout(30_000)

/**
 * A code whose refusals need no next step, each with the reason. Per CODE, not per site: a code
 * where the honest answer is "nothing you can do differently" is that everywhere it is thrown.
 */
const NO_SUGGESTION_NEEDED: Record<string, string> = {
  VAULT_WRITE_FAILED:
    "The message already carries the OS reason (permission denied, not a directory, no space); there is no candle-side step to name.",
  VAULT_VERIFY_FAILED:
    "A file that fails its own verification is a broken file. The message names which of the eight steps failed and that nothing was committed; the next move is a restore, not a flag.",
  VAULT_UNLOCK_FAILED:
    "Wrong passphrase, wrong PIN, or a mismatch at a copy-back prompt. The only step is to run it again, which the message already says.",
  VAULT_UNREADABLE:
    "An unreadable file at a named path. The message carries the path and the OS reason; candle has nothing to suggest about someone else's filesystem.",
  VAULT_INDEX_INVALID:
    "The decrypted index does not hold what the command needs. The file authenticated, so this is a shape the operator cannot repair from the CLI.",
  VAULT_BLOB_TAMPERED:
    "Thrown from the library (`vault/ed25519.ts`); the only honest answer is already in `store.ts`'s wrapper. Listed so the omission stays a decision.",
}

/** Every `new VaultError(` call's full source text, with the file and line it is on. */
async function vaultErrorCalls(): Promise<{ file: string; line: number; code: string | null; source: string }[]> {
  const dir = resolve(import.meta.dir)
  const out: { file: string; line: number; code: string | null; source: string }[] = []
  for (const name of (await readdir(dir)).sort()) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue
    const src = await readFile(join(dir, name), "utf8")
    let from = 0
    for (;;) {
      const at = src.indexOf("new VaultError(", from)
      if (at === -1) break
      let depth = 0
      let i = src.indexOf("(", at)
      for (; i < src.length; i++) {
        if (src[i] === "(") depth++
        else if (src[i] === ")") {
          depth--
          if (depth === 0) break
        }
      }
      const call = src.slice(at, i + 1)
      // The first argument, when it is a string literal. `null` means the code is computed.
      const code = /^new VaultError\(\s*"([A-Z0-9_]+)"/.exec(call)?.[1] ?? null
      out.push({ file: name, line: src.slice(0, at).split("\n").length, code, source: call })
      from = i + 1
    }
  }
  return out
}

describe("T9: D3's house rule, enforced over commands/", () => {
  test("the scan finds the refusals it is supposed to be reading", async () => {
    const calls = await vaultErrorCalls()
    // A scan that silently matched nothing would pass every assertion below.
    expect(calls.length).toBeGreaterThan(100)
    expect(new Set(calls.map((call) => call.file)).size).toBeGreaterThan(10)
  })

  test("every code it throws as a literal is a declared code", async () => {
    const declared = new Set<string>(VAULT_ERROR_CODES)
    // One site passes `refusalCodeFor(availability)` -- a code chosen at run time from the
    // platform's answer, which the scan cannot read and `vault/platform.ts` types against
    // `VaultErrorCode` anyway. Those are skipped here rather than guessed at.
    for (const call of (await vaultErrorCalls()).filter((call) => call.code !== null)) {
      expect(declared.has(call.code as string), `${call.file}:${call.line} throws ${call.code}`).toBe(true)
    }
  })

  test("every refusal carries a suggestion, or its code is allowlisted with a reason", async () => {
    const stranded = (await vaultErrorCalls())
      .filter((call) => !call.source.includes("suggestion"))
      .filter((call) => call.code === null || NO_SUGGESTION_NEEDED[call.code] === undefined)
      .map((call) => `${call.file}:${call.line} ${call.code}`)
    expect(stranded).toEqual([])
  })

  test("every allowlisted code states a reason", () => {
    for (const [code, reason] of Object.entries(NO_SUGGESTION_NEEDED)) {
      expect(reason.length, `${code} needs a reason, not an empty string`).toBeGreaterThan(40)
    }
  })
})

const unreachableFetch = (async () => {
  throw new Error("no test in this file should make a network call")
}) as unknown as typeof fetch

async function refuse(
  argv: string[],
  opts: { env?: Record<string, string>; json?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const dir = await mkdtemp(join(tmpdir(), "candle-refusal-"))
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    fetch: unreachableFetch,
    stdout,
    stderr,
    env: { CANDLE_CONFIG_DIR: dir, ...(opts.env ?? {}) },
    isTTY: { stdin: true, stdout: true, stderr: true },
  })
  const code = await run(opts.json ? [...argv, "--json"] : argv, deps)
  return { code, stdout: stdout.text, stderr: stderr.text }
}

describe("T9: VAULT_MISSING says where it looked and why", () => {
  test("the default path: the parenthetical names both reasons it is the default", async () => {
    // T1 (BE-274, D1/D2): `vaultPathFor` reads CANDLE_CONFIG_DIR, so "the default" here means the
    // flagless, envless branch -- which falls back to the HOME, and read the developer's own until
    // `homedir` became a dep. This case then passed on CI, where nothing has run `vault init`, and
    // failed on every machine that had. The temp home below is the seam: empty, so the branch
    // refuses with VAULT_MISSING whatever is in the operator's real ~/.config/candle.
    const home = await mkdtemp(join(tmpdir(), "candle-default-"))
    const stdout = createCapture()
    const stderr = createCapture()
    const deps = createTestDeps({
      fetch: unreachableFetch,
      stdout,
      stderr,
      env: {},
      homedir: () => home,
      isTTY: { stdin: true, stdout: true, stderr: true },
    })
    const code = await run(["vault", "status"], deps)
    expect(code).toBe(1)
    // The path it looked at is the one built from THIS test's home, not from anyone's real one.
    expect(stderr.text).toContain(`No vault at ${join(home, ".config", "candle", "vault.enc")} `)
    expect(stderr.text).toContain("(the default: no --keystore given and CANDLE_CONFIG_DIR is unset)")
    // Cheapest-if-wrong branch first: checking a path costs nothing, a second vault costs a vault.
    const wrongPath = stderr.text.indexOf("If your vault is somewhere else")
    const neverMade = stderr.text.indexOf("If you have never made one")
    expect(wrongPath).toBeGreaterThan(-1)
    expect(neverMade).toBeGreaterThan(wrongPath)
  })

  test("--keystore: the parenthetical names the flag, and the first branch is ls", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "candle-flag-")), "elsewhere.enc")
    const out = await refuse(["vault", "status", "--keystore", path])
    expect(out.code).toBe(1)
    expect(out.stderr).toContain(`No vault at ${path} (from --keystore).`)
    expect(out.stderr).toContain(`ls -l ${path}`)
    expect(out.stderr).toContain(`candle vault init -k ${path}`)
  })

  test("-k is the same flag, and says so the same way", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "candle-shortflag-")), "elsewhere.enc")
    const out = await refuse(["vault", "status", "-k", path])
    expect(out.stderr).toContain(`No vault at ${path} (from --keystore).`)
  })

  test("CANDLE_CONFIG_DIR: the parenthetical names the variable and its value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-env-"))
    const out = await refuse(["vault", "status"], { env: { CANDLE_CONFIG_DIR: dir } })
    expect(out.code).toBe(1)
    expect(out.stderr).toContain(`No vault at ${join(dir, "vault.enc")} (from CANDLE_CONFIG_DIR=${dir}).`)
  })

  test("--json carries details.path and details.pathSource, per source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-json-env-"))
    const fromEnv = await refuse(["vault", "status"], { env: { CANDLE_CONFIG_DIR: dir }, json: true })
    const envBody = JSON.parse(fromEnv.stdout)
    expect(envBody.ok).toBe(false)
    expect(envBody.code).toBe("VAULT_MISSING")
    expect(envBody.details).toEqual({ path: join(dir, "vault.enc"), pathSource: "env" })
    // The --json suggestion is one sentence rather than the aligned block: an envelope's
    // suggestion is read, not laid out.
    expect(envBody.suggestion).not.toContain("\n")

    const path = join(await mkdtemp(join(tmpdir(), "candle-json-flag-")), "v.enc")
    const fromFlag = await refuse(["vault", "status", "-k", path], { json: true })
    expect(JSON.parse(fromFlag.stdout).details).toEqual({ path, pathSource: "flag" })
  })

  test("vault factor list refuses with the same message, from the same helper", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "candle-factorlist-")), "v.enc")
    const out = await refuse(["vault", "factor", "list", "-k", path], { json: true })
    const body = JSON.parse(out.stdout)
    expect(body.code).toBe("VAULT_MISSING")
    expect(body.details).toEqual({ path, pathSource: "flag" })
  })

  test("a requireVaultRaw caller (vault phrase show) refuses the same way", async () => {
    // `phrase show` has no `--json` form at all (the ceremony is interactive), so the human
    // rendering is the whole of its output -- which is the one this helper's callers see anyway.
    const path = join(await mkdtemp(join(tmpdir(), "candle-phrase-")), "v.enc")
    const out = await refuse(["vault", "phrase", "show", "-k", path])
    expect(out.code).toBe(1)
    expect(out.stderr).toContain(`No vault at ${path} (from --keystore).`)
    expect(out.stderr).toContain(`ls -l ${path}`)
  })
})

describe("T9: VAULT_EXISTS is the other half of the same sentence", () => {
  test("init on an occupied path names where it looked, and keeps its own suggestion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-exists-"))
    const path = join(dir, "vault.enc")
    await writeFile(path, "not really a vault", "utf8")
    const out = await refuse(["vault", "init"], { env: { CANDLE_CONFIG_DIR: dir } })
    expect(out.code).toBe(1)
    expect(out.stderr).toContain(`A vault already exists at ${path} (from CANDLE_CONFIG_DIR=${dir}).`)
    expect(out.stderr).toContain("This CLI never overwrites one, including after an interrupted init.")
  })

  test("restore on an occupied path does too, with restore's own suggestion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-exists-restore-"))
    const path = join(dir, "here.enc")
    await writeFile(path, "not really a vault", "utf8")
    const out = await refuse(["vault", "restore", "--phrase", "-k", path])
    expect(out.code).toBe(1)
    expect(out.stderr).toContain(`A vault already exists at ${path} (from --keystore).`)
    expect(out.stderr).toContain("Restoring builds a new vault and never merges into one.")
  })

  test("--json carries the same details", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-exists-json-"))
    const path = join(dir, "vault.enc")
    await writeFile(path, "not really a vault", "utf8")
    const out = await refuse(["vault", "init", "--own-passphrase"], { env: { CANDLE_CONFIG_DIR: dir }, json: true })
    const body = JSON.parse(out.stdout)
    expect(body.code).toBe("VAULT_EXISTS")
    expect(body.details).toEqual({ path, pathSource: "env" })
  })
})

/**
 * BE-275 D8 (test 11): the enrolment refusal a release binary gives when `candle-fido2` is not
 * beside it. Every sentence it had survives, in order -- it names the file, the directory it
 * searched, both remedies, and that nothing was written and no weaker factor was substituted --
 * and exactly one sentence is added, naming `--install-helper`. The sentence is offered only where
 * the flag can help: an npm install ships no helper to fetch (D10) and gets the refusal unchanged.
 */
describe("BE-275 D8: the enrolment refusal keeps every sentence and gains one", () => {
  async function refuseEnrolment(argv: string[], execPath: string, json = false) {
    const dir = await mkdtemp(join(tmpdir(), "candle-enrol-refusal-"))
    const stdout = createCapture()
    const stderr = createCapture()
    const deps = createTestDeps({
      fetch: unreachableFetch,
      stdout,
      stderr,
      env: { CANDLE_CONFIG_DIR: dir },
      execPath: execPath.replace("<dir>", dir),
      isTTY: { stdin: true, stdout: true, stderr: true },
    })
    const code = await run(json ? [...argv, "--json"] : argv, deps)
    return { code, stdout: stdout.text, stderr: stderr.text, dir }
  }

  test("a release binary with no helper beside it: the four facts, then the new sentence, once", async () => {
    const out = await refuseEnrolment(["vault", "factor", "add", "security-key"], "<dir>/candle")
    expect(out.code).toBe(1)
    const text = out.stderr
    // The file and the directory it searched.
    expect(text).toContain(
      `This CLI cannot add a passkey-prf/ctap2 factor here: no candle-fido2 executable beside ${out.dir}/candle.`,
    )
    // Both remedies, unchanged.
    const remedies =
      "Install a release build of the CLI (which places candle-fido2 beside candle) or set CANDLE_FIDO2_HELPER."
    expect(text).toContain(remedies)
    // Nothing written, nothing substituted, unchanged.
    const nothing = "No other factor is substituted and nothing was written."
    expect(text).toContain(nothing)
    // The one new sentence, exactly once, between the remedies and the closing sentence.
    expect(text.split(INSTALL_HELPER_SENTENCE)).toHaveLength(2)
    expect(text.indexOf(INSTALL_HELPER_SENTENCE)).toBeGreaterThan(text.indexOf(remedies))
    expect(text.indexOf(INSTALL_HELPER_SENTENCE)).toBeLessThan(text.indexOf(nothing))
    // And it was a refusal, not a partial run: no vault was created and no helper appeared.
    expect(await readdir(out.dir)).toEqual([])
  })

  test("--json carries the code and the sentence in the suggestion", async () => {
    const out = await refuseEnrolment(["vault", "factor", "add", "security-key"], "<dir>/candle", true)
    expect(out.code).toBe(1)
    const body = JSON.parse(out.stdout) as { ok: boolean; code: string; suggestion: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe("VAULT_HELPER_MISSING")
    expect(body.suggestion).toContain("--install-helper")
    expect(body.suggestion).toContain("nothing was written")
  })

  test("vault enroll security-key is the same refusal with the same sentence", async () => {
    const out = await refuseEnrolment(["vault", "enroll", "security-key"], "<dir>/candle")
    expect(out.code).toBe(1)
    expect(out.stderr.split(INSTALL_HELPER_SENTENCE)).toHaveLength(2)
  })

  test("an npm install gets the refusal unchanged: no helper exists to fetch, so the flag is not offered", async () => {
    const out = await refuseEnrolment(["vault", "factor", "add", "security-key"], "/usr/local/bin/node")
    expect(out.code).toBe(1)
    expect(out.stderr).toContain("ships no candle-fido2 executable")
    expect(out.stderr).toContain("or set CANDLE_FIDO2_HELPER.")
    expect(out.stderr).toContain("No other factor is substituted and nothing was written.")
    expect(out.stderr).not.toContain("--install-helper")
  })

  test("--install-helper on any other factor is a usage error, before anything runs", async () => {
    const out = await refuseEnrolment(["vault", "factor", "add", "passphrase", "--install-helper"], "<dir>/candle")
    expect(out.code).toBe(2)
    expect(out.stderr).toContain("--install-helper applies to the security-key factor only")
  })
})
