/**
 * secret-store: `InMemorySecretStore`'s plain get/set/delete contract, and
 * `EncryptedFileSecretStore`'s at-rest guarantees (Agent Pilot Phase 3, Task 3) -- a real file
 * round-trip under a passphrase, a wrong passphrase throwing instead of returning garbage
 * plaintext (AES-GCM's auth tag catches this), and the on-disk bytes never containing the PEM in
 * plaintext.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EncryptedFileSecretStore, InMemorySecretStore } from "./secret-store"

const SAMPLE_PEM =
  "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg\n-----END PRIVATE KEY-----\n"
// A substring unique enough to the sample PEM's body that its presence anywhere in the on-disk
// bytes would mean the plaintext leaked.
const PEM_TELL = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg"

describe("InMemorySecretStore", () => {
  test("set then get returns the PEM", async () => {
    const store = new InMemorySecretStore()
    await store.set("wallet-1", SAMPLE_PEM)
    expect(await store.get("wallet-1")).toBe(SAMPLE_PEM)
  })

  test("delete removes it", async () => {
    const store = new InMemorySecretStore()
    await store.set("wallet-1", SAMPLE_PEM)
    await store.delete("wallet-1")
    expect(await store.get("wallet-1")).toBeNull()
  })

  test("get of an unknown ref returns null", async () => {
    const store = new InMemorySecretStore()
    expect(await store.get("never-set")).toBeNull()
  })
})

describe("EncryptedFileSecretStore", () => {
  let dir: string

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  async function tempPath(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "candle-secret-store-"))
    return join(dir, "secrets.json")
  }

  test("set then get round-trips through a real file with a passphrase", async () => {
    const path = await tempPath()
    const store = new EncryptedFileSecretStore(path, "correct horse battery staple")
    await store.set("wallet-1", SAMPLE_PEM)

    // A fresh store instance pointed at the same file and passphrase must read back the PEM --
    // proving the round trip goes through the file, not an in-memory cache.
    const reopened = new EncryptedFileSecretStore(path, "correct horse battery staple")
    expect(await reopened.get("wallet-1")).toBe(SAMPLE_PEM)
  })

  test("the ciphertext file and its directory are owner-only, and no temp file is left behind", async () => {
    const path = await tempPath()
    const store = new EncryptedFileSecretStore(path, "correct horse battery staple")
    await store.set("wallet-1", SAMPLE_PEM)

    // Created with no explicit mode, a normal `umask 022` left these 0644/0755, so any other
    // local account could copy the ciphertext and attack the passphrase offline.
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    // The write goes via a temp file plus rename; the temp must not survive the call.
    expect(await readdir(dir)).toEqual(["secrets.json"])
  })

  test("a second write keeps the owner-only mode, and both entries survive it", async () => {
    const path = await tempPath()
    const store = new EncryptedFileSecretStore(path, "correct horse battery staple")
    await store.set("wallet-1", SAMPLE_PEM)
    await store.set("wallet-2", SAMPLE_PEM)

    // `writeFile`'s mode applies only on creation, so the rename path has to hold the mode too.
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const reopened = new EncryptedFileSecretStore(path, "correct horse battery staple")
    expect(await reopened.get("wallet-1")).toBe(SAMPLE_PEM)
    expect(await reopened.get("wallet-2")).toBe(SAMPLE_PEM)
  })

  test("delete removes the entry from a reopened store", async () => {
    const path = await tempPath()
    const store = new EncryptedFileSecretStore(path, "correct horse battery staple")
    await store.set("wallet-1", SAMPLE_PEM)
    await store.delete("wallet-1")

    const reopened = new EncryptedFileSecretStore(path, "correct horse battery staple")
    expect(await reopened.get("wallet-1")).toBeNull()
  })

  test("get of an unknown ref returns null", async () => {
    const path = await tempPath()
    const store = new EncryptedFileSecretStore(path, "correct horse battery staple")
    expect(await store.get("never-set")).toBeNull()
  })

  test("a wrong passphrase fails to decrypt: throws, does not return garbage", async () => {
    const path = await tempPath()
    const store = new EncryptedFileSecretStore(path, "correct horse battery staple")
    await store.set("wallet-1", SAMPLE_PEM)

    const wrongStore = new EncryptedFileSecretStore(path, "wrong passphrase entirely")
    await expect(wrongStore.get("wallet-1")).rejects.toThrow()
  })

  test("set persists the PBKDF2 iteration count actually used, per entry", async () => {
    const path = await tempPath()
    const store = new EncryptedFileSecretStore(path, "correct horse battery staple")
    await store.set("wallet-1", SAMPLE_PEM)

    const onDisk = JSON.parse(await readFile(path, "utf8")) as Record<string, { iterations: unknown }>
    expect(typeof onDisk["wallet-1"]?.iterations).toBe("number")
    expect(onDisk["wallet-1"]?.iterations as number).toBeGreaterThan(0)
  })

  test("get uses the entry's own persisted iteration count, not a hardcoded default -- so raising the default later cannot lock out entries written under an older one", async () => {
    const path = await tempPath()
    const passphrase = "correct horse battery staple"

    // Hand-craft a file entry the way `set` would have written it under a PBKDF2 iteration count
    // that deliberately differs from this module's current default (Important fix under test).
    // If `get` re-derived the key using a hardcoded module constant instead of this entry's own
    // `iterations` field, this decrypt would fail even with the correct passphrase.
    const iterations = 1_000
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, [
      "deriveKey",
    ])
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    )
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(SAMPLE_PEM))

    await writeFile(
      path,
      JSON.stringify({
        "wallet-1": {
          salt: Buffer.from(salt).toString("base64"),
          iv: Buffer.from(iv).toString("base64"),
          ciphertext: Buffer.from(ciphertext).toString("base64"),
          iterations,
        },
      }),
      "utf8",
    )

    const store = new EncryptedFileSecretStore(path, passphrase)
    expect(await store.get("wallet-1")).toBe(SAMPLE_PEM)
  })

  test("the on-disk bytes never contain the PEM in plaintext", async () => {
    const path = await tempPath()
    const store = new EncryptedFileSecretStore(path, "correct horse battery staple")
    await store.set("wallet-1", SAMPLE_PEM)

    const onDisk = await readFile(path, "utf8")
    expect(onDisk).not.toContain(SAMPLE_PEM)
    expect(onDisk).not.toContain(PEM_TELL)
  })

  test("stores multiple walletRefs independently", async () => {
    const path = await tempPath()
    const store = new EncryptedFileSecretStore(path, "correct horse battery staple")
    const pemTwo = SAMPLE_PEM.replace("MIGH", "MIGX")
    await store.set("wallet-1", SAMPLE_PEM)
    await store.set("wallet-2", pemTwo)

    const reopened = new EncryptedFileSecretStore(path, "correct horse battery staple")
    expect(await reopened.get("wallet-1")).toBe(SAMPLE_PEM)
    expect(await reopened.get("wallet-2")).toBe(pemTwo)
  })

  test("get on a store backed by a nonexistent file returns null rather than throwing", async () => {
    dir = await mkdtemp(join(tmpdir(), "candle-secret-store-"))
    const path = join(dir, "does-not-exist.json")
    const store = new EncryptedFileSecretStore(path, "correct horse battery staple")
    expect(await store.get("wallet-1")).toBeNull()
  })
})
