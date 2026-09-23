/**
 * Ember Phase 3 PR F (BE-226, R6): `candle secrets set|list|remove`, and the namespace split.
 *
 * A secret is read on a hidden prompt, written to the SECRETS store and never the credential store,
 * never printed after `set`, and listed by name only. On the keychain backends the two stores are
 * two services (`tv.candle.cli` and `tv.candle.cli.secrets`), asserted here against a `security`
 * stub that records the command line it was handed; on the encrypted-file fallback they are two
 * files.
 */
import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { run } from "../index"
import { CREDENTIAL_SERVICE, KeychainSecretStore, resolveSecretStore, SECRETS_SERVICE } from "../keychain"
import { defaultSecretsPath } from "../secret-store"
import { createCapture, createFakeStore, createTestDeps } from "../test-support"

const unusedFetch = (() => {
  throw new Error("secrets never touch the network")
}) as unknown as typeof fetch

function harness(opts: { tty?: boolean; profile?: boolean } = {}) {
  const stdout = createCapture()
  const stderr = createCapture()
  const store = createFakeStore()
  const secretsStore = createFakeStore()
  const asked: string[] = []
  const deps = createTestDeps({
    fetch: unusedFetch,
    stdout,
    stderr,
    store,
    secretsStore,
    isTTY: { stdin: opts.tty ?? true, stdout: opts.tty ?? true, stderr: opts.tty ?? true },
    promptSecret: async (text) => {
      asked.push(text)
      return "sk-live-very-secret"
    },
  })
  return { deps, stdout, stderr, store, secretsStore, asked }
}

describe("candle secrets", () => {
  test("set stores under the secrets namespace, never the credential store, and never prints the value", async () => {
    const h = await harness()
    expect(await run(["secrets", "set", "exchange_key"], h.deps)).toBe(0)
    expect(h.asked).toEqual(["Value for EXCHANGE_KEY (input hidden): "])
    expect(await h.secretsStore.get("secret:EXCHANGE_KEY")).toBe("sk-live-very-secret")
    expect(await h.store.get("secret:EXCHANGE_KEY")).toBeNull()
    expect(h.stdout.text + h.stderr.text).not.toContain("sk-live-very-secret")
    expect(h.stdout.text).toContain("Stored EXCHANGE_KEY")
    expect(h.stdout.text).toContain("CANDLE_SECRET_EXCHANGE_KEY")

    h.stdout.text = ""
    expect(await run(["secrets", "list"], h.deps)).toBe(0)
    expect(h.stdout.text).toContain("EXCHANGE_KEY")
    expect(h.stdout.text).not.toContain("sk-live")
    h.stdout.text = ""
    expect(await run(["secrets", "list", "--json"], h.deps)).toBe(0)
    expect(JSON.parse(h.stdout.text.trim())).toEqual({ ok: true, names: ["EXCHANGE_KEY"], backend: "encrypted-file" })

    h.stdout.text = ""
    expect(await run(["secrets", "remove", "EXCHANGE_KEY"], h.deps)).toBe(0)
    expect(await h.secretsStore.get("secret:EXCHANGE_KEY")).toBeNull()
    expect(await run(["secrets", "list", "--json"], h.deps)).toBe(0)
    expect(JSON.parse(h.stdout.text.trim().split("\n").at(-1) ?? "").names).toEqual([])
  })

  test("a name is an environment suffix; anything else is a usage error", async () => {
    const h = await harness()
    expect(await run(["secrets", "set", "bad-name"], h.deps)).toBe(2)
    expect(await run(["secrets", "set", "1abc"], h.deps)).toBe(2)
    expect(await run(["secrets", "set"], h.deps)).toBe(2)
    expect(h.asked).toEqual([])
  })

  test("set needs a terminal: no environment variable and no flag supplies a value", async () => {
    const h = await harness({ tty: false })
    expect(await run(["secrets", "set", "KEY", "--json"], h.deps)).toBe(1)
    expect(JSON.parse(h.stdout.text.trim())).toMatchObject({ ok: false, code: "SECRET_REQUIRES_TTY" })
    expect(h.asked).toEqual([])
  })

  test("under a profile the ref is namespaced to it, and the names live on that profile", async () => {
    const h = await harness()
    await h.deps.writeConfig({ profiles: { work: { apiUrl: "https://api.test" } }, activeProfile: "work" })
    expect(await run(["secrets", "set", "DATA_KEY"], h.deps)).toBe(0)
    expect(await h.secretsStore.get("profile:work:secret:DATA_KEY")).toBe("sk-live-very-secret")
    expect(await h.secretsStore.get("secret:DATA_KEY")).toBeNull()
    expect((await h.deps.readConfig()).profiles?.work?.secretNames).toEqual(["DATA_KEY"])
  })
})

describe("the two keychain namespaces", () => {
  const SECURITY_STUB = `#!/bin/bash
printf '%s\\n' "$*" >> "$ARGV_CAPTURE"
if [ "\${1:-}" = "-i" ]; then
  cat >> "$STDIN_CAPTURE"
  exit 0
fi
exit 44
`

  test("the secrets store talks to security under its own service, distinct from the credential service", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-secrets-keychain-"))
    const stub = join(dir, "security")
    await writeFile(stub, SECURITY_STUB, "utf8")
    await chmod(stub, 0o755)
    const argvCapture = join(dir, "argv.txt")
    const stdinCapture = join(dir, "stdin.txt")
    process.env.ARGV_CAPTURE = argvCapture
    process.env.STDIN_CAPTURE = stdinCapture
    await writeFile(argvCapture, "", "utf8")
    await writeFile(stdinCapture, "", "utf8")
    try {
      const secrets = new KeychainSecretStore(stub, SECRETS_SERVICE)
      const credentials = new KeychainSecretStore(stub, CREDENTIAL_SERVICE)
      expect(await secrets.get("secret:X")).toBeNull()
      expect(await credentials.get("api_key")).toBeNull()
      await secrets.set("secret:X", "value-x")
      const argv = await readFile(argvCapture, "utf8")
      expect(argv).toContain(`find-generic-password -s ${SECRETS_SERVICE} -a secret:X -w`)
      expect(argv).toContain(`find-generic-password -s ${CREDENTIAL_SERVICE} -a api_key -w`)
      expect(SECRETS_SERVICE).not.toBe(CREDENTIAL_SERVICE)
      // The write went to the secrets service on the command-on-stdin line, and the value never
      // reached argv.
      const stdin = await readFile(stdinCapture, "utf8")
      expect(stdin).toContain(`add-generic-password -U -s "${SECRETS_SERVICE}" -a "secret:X" -w "value-x"`)
      expect(argv).not.toContain("value-x")
    } finally {
      delete process.env.ARGV_CAPTURE
      delete process.env.STDIN_CAPTURE
    }
  })

  test("on the encrypted-file fallback the two namespaces are two files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-secrets-file-"))
    const resolved = await resolveSecretStore("freebsd", {
      service: SECRETS_SERVICE,
      filePath: defaultSecretsPath({ CANDLE_CONFIG_DIR: dir }),
    })
    expect(resolved.backend).toBe("encrypted-file")
    expect(defaultSecretsPath({ CANDLE_CONFIG_DIR: dir })).toBe(join(dir, "secrets.enc"))
    expect(defaultSecretsPath({ CANDLE_CONFIG_DIR: dir })).not.toBe(join(dir, "credentials.enc"))
  })
})
