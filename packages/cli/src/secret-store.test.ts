import { promptHiddenSecret } from "./secret-store"
/**
 * `EncryptedFileSecretStore`: the CLI's fallback `SecretStore` when no OS keychain is available.
 * Covers the at-rest contract (AES-256-GCM, per-entry salt and persisted iteration count, file
 * mode 0600) and the passphrase-resolution contract (env var, or a hard refusal off a TTY --
 * never a silent plaintext fallback).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EncryptedFileSecretStore, pemToStoredSigner, SECRET_REFS, storedSignerToPem } from "./secret-store"
import { tempDirs } from "./temp-dirs.test-support"

const ORIGINAL_PASSPHRASE_ENV = process.env.CANDLE_KEYRING_PASSPHRASE
const ORIGINAL_IS_TTY = process.stdin.isTTY

describe("SECRET_REFS", () => {
  test("names the two credentials the CLI stores", () => {
    expect(SECRET_REFS).toEqual({ deviceToken: "device_token", apiKey: "api_key" })
  })
})

describe("EncryptedFileSecretStore", () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "candle-cli-secret-store-"))
    path = join(dir, "credentials.enc")
    process.env.CANDLE_KEYRING_PASSPHRASE = "correct horse battery staple"
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    if (ORIGINAL_PASSPHRASE_ENV === undefined) delete process.env.CANDLE_KEYRING_PASSPHRASE
    else process.env.CANDLE_KEYRING_PASSPHRASE = ORIGINAL_PASSPHRASE_ENV
    process.stdin.isTTY = ORIGINAL_IS_TTY
  })

  test("set then get round-trips the value", async () => {
    const store = new EncryptedFileSecretStore({ path })
    await store.set("device_token", "dtok_abc123")
    expect(await store.get("device_token")).toBe("dtok_abc123")
  })

  test("delete then get returns null", async () => {
    const store = new EncryptedFileSecretStore({ path })
    await store.set("device_token", "dtok_abc123")
    await store.delete("device_token")
    expect(await store.get("device_token")).toBeNull()
  })

  test("get of an unknown ref returns null", async () => {
    const store = new EncryptedFileSecretStore({ path })
    expect(await store.get("never_set")).toBeNull()
  })

  test("the credentials file is created at the configured path with mode 0600", async () => {
    const store = new EncryptedFileSecretStore({ path })
    await store.set("device_token", "dtok_abc123")

    const stats = await stat(path)
    expect(stats.mode & 0o777).toBe(0o600)
  })

  test("the on-disk file never contains the plaintext secret, and each entry has exactly the expected fields", async () => {
    const store = new EncryptedFileSecretStore({ path })
    const secret = "dtok_should_never_appear_in_the_file_as_written"
    await store.set("device_token", secret)

    const raw = await readFile(path, "utf8")
    expect(raw).not.toContain(secret)

    const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>
    const entry = parsed.device_token
    expect(entry).toBeDefined()
    // Guards against a `set` that (accidentally or otherwise) writes a `plaintext` field alongside
    // the ciphertext: every one of the round-trip/mode/iteration tests above would still pass in
    // that world, since none of them reads the file back. This is the assertion that would catch it.
    expect(Object.keys(entry ?? {}).sort()).toEqual(["ciphertext", "iterations", "iv", "salt"])
  })

  test("a corrupted credentials file produces a clear error naming the file, not a bare JSON parse error", async () => {
    await writeFile(path, "{ this is not valid json at all", "utf8")
    const store = new EncryptedFileSecretStore({ path })

    let caught: unknown
    try {
      await store.get("device_token")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain(path)
    expect((caught as Error).message.toLowerCase()).toContain("json")
  })

  test("a store constructed with a doubled iteration count still decrypts entries written under the original count (iterations persisted per entry)", async () => {
    const original = new EncryptedFileSecretStore({ path, iterations: 1_000 })
    await original.set("device_token", "dtok_abc123")

    const doubled = new EncryptedFileSecretStore({ path, iterations: 2_000 })
    expect(await doubled.get("device_token")).toBe("dtok_abc123")
  })

  test("a wrong passphrase throws on get rather than returning garbage", async () => {
    const store = new EncryptedFileSecretStore({ path })
    await store.set("device_token", "dtok_abc123")

    process.env.CANDLE_KEYRING_PASSPHRASE = "an entirely different passphrase"
    const wrongStore = new EncryptedFileSecretStore({ path })
    await expect(wrongStore.get("device_token")).rejects.toThrow(/passphrase/i)
  })

  test("non-TTY with no CANDLE_KEYRING_PASSPHRASE refuses every operation, naming the env var", async () => {
    delete process.env.CANDLE_KEYRING_PASSPHRASE
    process.stdin.isTTY = false as unknown as true

    const store = new EncryptedFileSecretStore({ path })
    await expect(store.get("device_token")).rejects.toThrow(/CANDLE_KEYRING_PASSPHRASE/)
    await expect(store.set("device_token", "x")).rejects.toThrow(/CANDLE_KEYRING_PASSPHRASE/)
    await expect(store.delete("device_token")).rejects.toThrow(/CANDLE_KEYRING_PASSPHRASE/)
  })
})

describe("signer PEM storage format", () => {
  const PEM = `-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg0123456789abcdef\n0123456789abcdefABCD\n-----END PRIVATE KEY-----\n`

  test("pemToStoredSigner strips armor and newlines, so the value is safe for every keychain backend", () => {
    const stored = pemToStoredSigner(PEM)
    expect(stored).not.toContain("\n")
    expect(stored).not.toContain("BEGIN")
    expect(stored).toMatch(/^[A-Za-z0-9+/]+=*$/)
  })

  test("storedSignerToPem round-trips back to the exact original PEM", () => {
    expect(storedSignerToPem(pemToStoredSigner(PEM))).toBe(PEM)
  })
})

/**
 * set and delete rewrite the WHOLE file, so two of them interleaving loses an entry: both read the
 * same starting state, both add their own ref, and whichever renames second silently drops the
 * other's. `candle keys create` in one terminal while `candle auth login` finishes in another is
 * enough, and the symptom is a credential reported stored that is not there.
 *
 * The atomic rename never protected against this. It prevents a TORN file, not a lost write.
 */
describe("EncryptedFileSecretStore serializes concurrent writers", () => {
  let dir: string
  let path: string
  const previous = process.env.CANDLE_KEYRING_PASSPHRASE

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "candle-lock-"))
    path = join(dir, "credentials.enc")
    process.env.CANDLE_KEYRING_PASSPHRASE = "correct horse battery staple"
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    if (previous === undefined) delete process.env.CANDLE_KEYRING_PASSPHRASE
    else process.env.CANDLE_KEYRING_PASSPHRASE = previous
  })

  test("every concurrent set survives", async () => {
    const store = new EncryptedFileSecretStore({ path })
    const refs = Array.from({ length: 12 }, (_, i) => `ref_${i}`)
    await Promise.all(refs.map((ref) => store.set(ref, `value-${ref}`)))

    // Re-read from disk rather than trusting the in-process object.
    const reopened = new EncryptedFileSecretStore({ path })
    for (const ref of refs) expect(await reopened.get(ref)).toBe(`value-${ref}`)
  })

  test("concurrent deletes leave the untouched entries alone, and no lock is left behind", async () => {
    const store = new EncryptedFileSecretStore({ path })
    const refs = Array.from({ length: 8 }, (_, i) => `ref_${i}`)
    for (const ref of refs) await store.set(ref, `value-${ref}`)

    await Promise.all(refs.slice(0, 4).map((ref) => store.delete(ref)))

    const reopened = new EncryptedFileSecretStore({ path })
    for (const ref of refs.slice(0, 4)) expect(await reopened.get(ref)).toBeNull()
    for (const ref of refs.slice(4)) expect(await reopened.get(ref)).toBe(`value-${ref}`)
    await expect(stat(`${path}.lock`)).rejects.toThrow()
  })
})

test("promptHiddenSecret without TTY no longer mentions --key-file", async () => {
  process.stdin.isTTY = false as unknown as true
  try {
    await promptHiddenSecret("secret: ")
    throw new Error("must refuse")
  } catch (error) {
    expect((error as Error).message).toBe("No TTY available for hidden input; run this in a terminal.")
    expect((error as Error).message).not.toContain("--key-file")
  }
})

// BE-2712 (D1, D5): the first write on a fresh box. Before, the lock's open failed with ENOENT
// because nothing had created the directory yet, and the command died as `Unexpected error`.
describe("EncryptedFileSecretStore on a machine where the config directory does not exist yet", () => {
  const tempDir = tempDirs()
  const previous = process.env.CANDLE_KEYRING_PASSPHRASE
  beforeEach(() => {
    process.env.CANDLE_KEYRING_PASSPHRASE = "correct horse battery staple"
  })
  afterEach(() => {
    if (previous === undefined) delete process.env.CANDLE_KEYRING_PASSPHRASE
    else process.env.CANDLE_KEYRING_PASSPHRASE = previous
  })

  test("with a fresh HOME and no CANDLE_CONFIG_DIR, set makes ~/.config/candle at 0700 and credentials.enc at 0600", async () => {
    // A child process, because the default path is read from `homedir()`, which Bun resolves once
    // per process: setting HOME here would not move it.
    const home = tempDir("candle-fresh-home-")
    const script = [
      `import { EncryptedFileSecretStore } from ${JSON.stringify(join(import.meta.dir, "secret-store.ts"))}`,
      "const store = new EncryptedFileSecretStore()",
      'await store.set("device_token", "dtok_fresh_box")',
      'console.log(await store.get("device_token"))',
    ].join("\n")
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home }
    env.CANDLE_KEYRING_PASSPHRASE = "correct horse battery staple"
    const child = Bun.spawnSync([process.execPath, "-e", script], { env, stdout: "pipe", stderr: "pipe" })
    expect(child.stderr.toString()).toBe("")
    expect(child.exitCode).toBe(0)
    expect(child.stdout.toString().trim()).toBe("dtok_fresh_box")
    const dir = join(home, ".config", "candle")
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    expect((await stat(join(dir, "credentials.enc"))).mode & 0o777).toBe(0o600)
    await expect(stat(join(dir, "credentials.enc.lock"))).rejects.toThrow()
  })

  test("a nested CANDLE_CONFIG_DIR that does not exist yet is created the same way", async () => {
    const previousDir = process.env.CANDLE_CONFIG_DIR
    const dir = join(tempDir("candle-nested-config-"), "a", "b", "candle")
    process.env.CANDLE_CONFIG_DIR = dir
    try {
      const store = new EncryptedFileSecretStore()
      await store.set("api_key", "ck_nested")
      expect(await new EncryptedFileSecretStore().get("api_key")).toBe("ck_nested")
      expect((await stat(dir)).mode & 0o777).toBe(0o700)
      expect((await stat(join(dir, "credentials.enc"))).mode & 0o777).toBe(0o600)
      await expect(stat(join(dir, "credentials.enc.lock"))).rejects.toThrow()
    } finally {
      if (previousDir === undefined) delete process.env.CANDLE_CONFIG_DIR
      else process.env.CANDLE_CONFIG_DIR = previousDir
    }
  })

  test("delete on a missing directory resolves and leaves an empty 0700 directory", async () => {
    const dir = join(tempDir("candle-delete-missing-"), "candle")
    const store = new EncryptedFileSecretStore({ path: join(dir, "credentials.enc") })
    await store.delete("device_token")
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    expect(await readdir(dir)).toEqual([])
  })
})
