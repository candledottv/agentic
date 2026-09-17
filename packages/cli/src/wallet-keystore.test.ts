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

// ── Ember Phase 1 (BE-94, D3 / T26 / T28): the TEE wallet store's purpose marker and bounds ──────────

describe("TEE wallet store purpose (Ember Phase 1)", () => {
  const teeEntry: KeystoreEntry = { ...entry, tee: { network: "solana-mainnet", vaultDestination: "Vault111" } }

  async function sealTee(passphrase: string, iterations = KEYSTORE_ITERATIONS): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    return serializeKeystore(
      [teeEntry],
      await deriveKeystoreKey(passphrase, salt, iterations),
      salt,
      iterations,
      "ember-tee",
    )
  }

  test("a TEE wallet store carries purpose ember-tee in the header and the tee metadata under the AEAD", async () => {
    const raw = await sealTee("a strong passphrase 12")
    expect(JSON.parse(raw).purpose).toBe("ember-tee")
    expect(raw).not.toContain("Vault111")
    const opened = await readKeystore(raw, "a strong passphrase 12", { expectPurpose: "ember-tee" })
    expect(opened.entries[0]?.tee?.vaultDestination).toBe("Vault111")
  })

  test("T26: a legacy reader (expectPurpose wallets) refuses a TEE wallet store and names the sweep", async () => {
    const raw = await sealTee("a strong passphrase 12")
    await expect(readKeystore(raw, "a strong passphrase 12", { expectPurpose: "wallets" })).rejects.toThrow(/tee sweep/)
  })

  test("a tee reader refuses a legacy store", async () => {
    const raw = await seal([entry], "a strong passphrase 12")
    expect(JSON.parse(raw).purpose).toBeUndefined()
    await expect(readKeystore(raw, "a strong passphrase 12", { expectPurpose: "ember-tee" })).rejects.toThrow(
      /not a TEE wallet store/,
    )
  })

  test("T28: iteration counts outside 210k-2.1M fail closed for a TEE wallet store, before any decrypt", async () => {
    const low = await sealTee("a strong passphrase 12", 100_000)
    await expect(readKeystore(low, "a strong passphrase 12", { expectPurpose: "ember-tee" })).rejects.toThrow(
      /iteration count/,
    )
    const high = await sealTee("a strong passphrase 12", 3_000_000)
    await expect(readKeystore(high, "a strong passphrase 12", { expectPurpose: "ember-tee" })).rejects.toThrow(
      /iteration count/,
    )
  })

  test("T28: a swapped KDF or cipher name fails closed", async () => {
    const raw = await sealTee("a strong passphrase 12")
    const file = JSON.parse(raw)
    file.kdf = "scrypt"
    await expect(
      readKeystore(JSON.stringify(file), "a strong passphrase 12", { expectPurpose: "ember-tee" }),
    ).rejects.toThrow(/unsupported KDF/)
  })

  test("a store written before the tee rename still opens for the tee commands, metadata carried over", async () => {
    // The old header marker and entry field, as a source-built CLI wrote them before 2026-09-17.
    const { tee: meta, ...plain } = teeEntry
    const legacyEntry = { ...plain, hot: meta } as unknown as KeystoreEntry
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const key = await deriveKeystoreKey("a strong passphrase 12", salt, KEYSTORE_ITERATIONS)
    const file = JSON.parse(await serializeKeystore([legacyEntry], key, salt, KEYSTORE_ITERATIONS, "ember-tee"))
    file.purpose = "ember-hot"
    const raw = JSON.stringify(file)

    const opened = await readKeystore(raw, "a strong passphrase 12", { expectPurpose: "ember-tee" })
    expect(opened.entries[0]?.tee?.vaultDestination).toBe("Vault111")
    expect(opened.entries[0]).not.toHaveProperty("hot")
    // Still not a plain wallets store: the export path stays closed.
    await expect(readKeystore(raw, "a strong passphrase 12", { expectPurpose: "wallets" })).rejects.toThrow(/tee sweep/)
  })

  test("a legacy file without a purpose still opens with no expectation (pre-Phase-1 readers)", async () => {
    const raw = await seal([entry], "a strong passphrase 12")
    expect((await readKeystore(raw, "a strong passphrase 12")).entries).toEqual([entry])
  })
})
