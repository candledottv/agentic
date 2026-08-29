/**
 * The keystore is the ONLY copy of these keys (the spec chose independent random keys over a
 * mnemonic), so the properties worth pinning are: it round-trips exactly, nothing sensitive is
 * legible in the file, a wrong passphrase fails closed rather than returning garbage, and a file
 * written under a different iteration count is still readable after the default is raised.
 */
import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createKeystore,
  deriveKeystoreKey,
  KEYSTORE_ITERATIONS,
  type KeystoreEntry,
  readKeystore,
  serializeKeystore,
  writeKeystoreFile,
} from "./wallet-keystore"

const entry: KeystoreEntry = {
  index: 0,
  chain: "solana",
  address: "7GU9VsN9PHaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  label: "trading-0",
  createdAt: "2026-08-29T00:00:00.000Z",
  privateKey: "5JnotARealKeyButDistinctEnoughToGrepFor",
  imported: false,
}

async function seal(entries: KeystoreEntry[], passphrase: string, iterations?: number): Promise<string> {
  if (iterations === undefined) {
    const ks = await createKeystore(passphrase)
    return serializeKeystore(entries, ks.key, ks.salt, ks.iterations)
  }
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return serializeKeystore(entries, await deriveKeystoreKey(passphrase, salt, iterations), salt, iterations)
}

describe("wallet keystore", () => {
  test("round-trips entries exactly", async () => {
    const opened = await readKeystore(await seal([entry], "correct horse"), "correct horse")
    expect(opened.entries).toEqual([entry])
    expect(opened.iterations).toBe(KEYSTORE_ITERATIONS)
  })

  test("neither the key nor the metadata is legible in the file", async () => {
    const raw = await seal([entry], "correct horse")
    expect(raw).not.toContain(entry.privateKey)
    // Metadata is sealed too, so the address linkage does not leak to anyone reading the file.
    expect(raw).not.toContain(entry.address)
    expect(raw).not.toContain(entry.label)
  })

  test("a wrong passphrase fails closed", async () => {
    const raw = await seal([entry], "correct horse")
    await expect(readKeystore(raw, "wrong horse")).rejects.toThrow(/wrong passphrase|corrupt/i)
  })

  test("reads a file written under a different iteration count", async () => {
    const opened = await readKeystore(await seal([entry], "pw", 1000), "pw")
    expect(opened.iterations).toBe(1000)
    expect(opened.entries).toEqual([entry])
  })

  test("rejects an unknown file version rather than guessing", async () => {
    const raw = await seal([entry], "pw")
    const tampered = JSON.stringify({ ...JSON.parse(raw), version: 99 })
    await expect(readKeystore(tampered, "pw")).rejects.toThrow(/version/i)
  })

  test("a tampered ciphertext fails closed", async () => {
    const file = JSON.parse(await seal([entry], "pw")) as { ciphertext: string }
    const bytes = Buffer.from(file.ciphertext, "base64")
    bytes[0] = (bytes[0] as number) ^ 0xff
    const tampered = JSON.stringify({ ...file, ciphertext: bytes.toString("base64") })
    await expect(readKeystore(tampered, "pw")).rejects.toThrow()
  })

  test("each write uses a fresh IV, so rewrites never reuse a nonce", async () => {
    const ks = await createKeystore("pw")
    const a = JSON.parse(await serializeKeystore([entry], ks.key, ks.salt, ks.iterations)) as { iv: string }
    const b = JSON.parse(await serializeKeystore([entry], ks.key, ks.salt, ks.iterations)) as { iv: string }
    expect(a.iv).not.toBe(b.iv)
  })

  test("writes atomically with 0600 and no leftover temp file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-keystore-"))
    const path = join(dir, "wallets.enc")
    await writeKeystoreFile(path, await seal([entry], "pw"))
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600")
    await expect(stat(`${path}.tmp`)).rejects.toThrow()
    // And it is readable back off disk, not just in memory.
    expect((await readKeystore(await readFile(path, "utf8"), "pw")).entries).toEqual([entry])
  })
})
