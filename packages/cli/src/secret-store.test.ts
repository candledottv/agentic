/**
 * `EncryptedFileSecretStore`: the CLI's fallback `SecretStore` when no OS keychain is available.
 * Covers the at-rest contract (AES-256-GCM, per-entry salt and persisted iteration count, file
 * mode 0600) and the passphrase-resolution contract (env var, or a hard refusal off a TTY --
 * never a silent plaintext fallback).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EncryptedFileSecretStore, SECRET_REFS } from "./secret-store"

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
