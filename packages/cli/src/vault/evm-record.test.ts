/**
 * BE-391 (spec `2026-09-24-ember-phase-4b-hood-tee-wallets-design.md`, D1), H3 (the format half) and
 * H13: vault format version 4 and the sealed EVM record, at the module level.
 *
 * Every vault here is built through the real `createVault` and written through the real
 * `commitVault`, so what is asserted is the production write path: the first EVM TEE wallet moves a
 * file to version 4 and creates the record key in that same write, nothing else moves the version,
 * an append needs only the header, and a reader needs the vault open.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { EVM_DERIVATION_SCHEME } from "../evm-lite"
import { VaultError } from "./errors"
import {
  appendEvmRecordEntry,
  copyEvmRecordForBackup,
  evmRecordPath,
  readEvmRecord,
  splitRecord,
  verifyEvmRecordCopy,
} from "./evm-record"
import { createEvmRecordKey, EVM_RECORD_PLAINTEXT_BYTES, paddedEntry, sealEvmRecordLine } from "./evm-record-key"
import { type KeyEntry, parseVaultFile, VAULT_VERSION } from "./format"
import { deriveEvmTeeKeyFromRoot, evmTeePath } from "./hd"
import { wipe } from "./hygiene"
import {
  closeVault,
  commitVault,
  decryptRoot,
  freshKeyId,
  sealIndex,
  sealKeyBlob,
  serializeVault,
  type UnlockedVault,
} from "./store"
import { flipByte, makeVault, readVaultJson, reopen, tamper, testClock, useCheapKdf } from "./test-vault"

setDefaultTimeout(60_000)
useCheapKdf()

const WALLET = "0x1111111111111111111111111111111111111111"
const TOKEN_A = "0x2222222222222222222222222222222222222222"
const TOKEN_B = "0x3333333333333333333333333333333333333333"

/** Adds one EVM TEE wallet (evmTee index `n`) through `commitVault`, the write a promote makes. */
async function addEvmTee(vault: UnlockedVault, n = 0): Promise<UnlockedVault> {
  const root = await decryptRoot(vault)
  try {
    const derived = await deriveEvmTeeKeyFromRoot(root, n)
    try {
      const id = freshKeyId()
      const blob = await sealKeyBlob(vault, id, derived.secret)
      const entry: KeyEntry = {
        id,
        chain: "evm",
        curve: "secp256k1",
        address: derived.address,
        label: `evm-tee-${n}`,
        createdAt: "2026-09-25T00:00:00.000Z",
        role: "tee-wallet",
        origin: "derived",
        derivation: { scheme: EVM_DERIVATION_SCHEME, path: evmTeePath(n) },
        exposure: { everRemoteExposed: true, everExported: false },
        tee: { network: "hood-mainnet", lifecycle: "import-pending", vaultDestination: WALLET },
      }
      const exposed = [...(vault.index.hd.exposedIndexes.evmTee ?? []), n]
      return await commitVault(
        vault,
        {
          index: {
            ...vault.index,
            hd: {
              ...vault.index.hd,
              nextIndex: { ...vault.index.hd.nextIndex, evmTee: n + 1 },
              exposedIndexes: { ...vault.index.hd.exposedIndexes, evmTee: exposed },
            },
            entries: [...vault.index.entries, entry],
          },
          addKeys: [blob],
        },
        testClock,
      )
    } finally {
      wipe(derived.secret)
    }
  } finally {
    wipe(root)
  }
}

async function v4Vault() {
  const made = await makeVault()
  const vault = await addEvmTee(made.vault)
  return { ...made, vault }
}

describe("H3: version 4 is created by the first EVM TEE wallet, and by nothing else", () => {
  test("a new vault is version 2, and a write with no EVM TEE wallet keeps it there", async () => {
    const made = await makeVault()
    expect(made.vault.file.version).toBe(2)
    const next = await commitVault(made.vault, { index: made.vault.index }, testClock)
    expect(next.file.version).toBe(2)
    expect(next.file.evmRecordPublicKey).toBeUndefined()
    expect(next.index.evmRecordKey).toBeUndefined()
    closeVault(next)
  })

  test("the first EVM TEE wallet writes version 4 with the record key in that same write", async () => {
    const { path, vault } = await v4Vault()
    expect(vault.file.version).toBe(4)
    const onDisk = await readVaultJson(path)
    expect(onDisk.version).toBe(4)
    expect(onDisk.evmRecordPublicKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // The generation of that write is the one that carries the key: no second write was needed.
    expect(onDisk.generation).toBe(2)
    const reopened = await reopen(path)
    expect(reopened.index.evmRecordKey).toBeDefined()
    expect(reopened.index.hd.nextIndex.evmTee).toBe(1)
    expect(reopened.index.entries[0]?.derivation?.path).toBe("m/44'/60'/0'/1'/0'")
    closeVault(reopened)
  })

  test("every later write keeps version 4 and the same record key, even one that rebuilds the index as { hd, entries }", async () => {
    const { path, vault } = await v4Vault()
    const key = vault.file.evmRecordPublicKey
    const next = await commitVault(vault, { index: { hd: vault.index.hd, entries: vault.index.entries } }, testClock)
    expect(next.file.version).toBe(4)
    expect(next.file.evmRecordPublicKey).toBe(key)
    const reopened = await reopen(path)
    expect(reopened.file.evmRecordPublicKey).toBe(key)
    expect(reopened.index.evmRecordKey).toBeDefined()
    closeVault(reopened)
    closeVault(next)
  })

  test("a version 3 vault (the external branch) moves to 4 on its first EVM TEE wallet, never before", async () => {
    const made = await makeVault()
    const v3 = await commitVault(
      made.vault,
      {
        index: {
          ...made.vault.index,
          hd: { ...made.vault.index.hd, nextIndex: { ...made.vault.index.hd.nextIndex, solanaExternal: 1 } },
        },
      },
      testClock,
    )
    expect(v3.file.version).toBe(VAULT_VERSION)
    const v4 = await addEvmTee(v3)
    expect(v4.file.version).toBe(4)
    expect(v4.index.hd.nextIndex.solanaExternal).toBe(1)
    closeVault(v4)
  })

  test("the strict reader: version 4 needs its key, and a version 3 header may not carry one", async () => {
    const { path } = await v4Vault()
    const raw = await readFile(path, "utf8")
    const noKey = JSON.parse(raw)
    delete noKey.evmRecordPublicKey
    expect(() => parseVaultFile(JSON.stringify(noKey))).toThrow(VaultError)
    const downgraded = JSON.parse(raw)
    downgraded.version = 3
    try {
      parseVaultFile(JSON.stringify(downgraded))
      throw new Error("expected a refusal")
    } catch (error) {
      expect((error as VaultError).code).toBe("VAULT_FIELD_UNKNOWN")
    }
    // A reader that knows versions 2 and 3 only (0.11.x) refuses before any factor: the version is
    // checked first, and 5 stands in for "a version this build does not read".
    const future = JSON.parse(raw)
    future.version = 5
    try {
      parseVaultFile(JSON.stringify(future))
      throw new Error("expected a refusal")
    } catch (error) {
      expect((error as VaultError).code).toBe("VAULT_VERSION_UNSUPPORTED")
    }
  })

  test("a swapped header public key fails the index tag; a pair that does not match fails the key check", async () => {
    const { path, vault } = await v4Vault()
    const original = await readFile(path, "utf8")
    const other = await createEvmRecordKey(vault.payloadKey, vault.file.vaultId)
    await tamper(path, (file) => {
      file.evmRecordPublicKey = other.publicKey
    })
    await expect(reopen(path)).rejects.toMatchObject({ code: "VAULT_BLOB_TAMPERED" })

    // A header and index that agree with each other but hold a mismatched pair: the index is
    // re-sealed under the original header with a different private key.
    await writeFile(path, original, "utf8")
    const { index: _index, ...header } = vault.file
    const forged = await sealIndex(header, { ...vault.index, evmRecordKey: other.blob }, vault.payloadKey)
    await writeFile(path, serializeVault(forged), "utf8")
    await expect(reopen(path)).rejects.toMatchObject({ code: "VAULT_INDEX_INVALID" })
    closeVault(vault)
  })
})

describe("H13: the sealed EVM record", () => {
  test("the record path is <vault path minus .enc>.evm-record.sealed", () => {
    expect(evmRecordPath("/a/vault.enc")).toBe("/a/vault.evm-record.sealed")
    expect(evmRecordPath("/a/backup.enc")).toBe("/a/backup.evm-record.sealed")
    expect(evmRecordPath("/a/copy")).toBe("/a/copy.evm-record.sealed")
  })

  test("an append needs no unlock, writes only same-length ciphertext, and a reader decrypts and dedupes", async () => {
    const { path, vault } = await v4Vault()
    closeVault(vault)
    for (const entry of [
      { kind: "token" as const, wallet: WALLET, token: TOKEN_A },
      { kind: "scanStart" as const, wallet: WALLET, block: 12 },
      { kind: "token" as const, wallet: WALLET, token: TOKEN_A },
    ]) {
      const outcome = await appendEvmRecordEntry({ vaultPath: path, entry, clock: testClock })
      expect(outcome.written).toBe(true)
    }
    const bytes = await readFile(evmRecordPath(path), "utf8")
    // Nothing in the clear: no address, no kind.
    expect(bytes).not.toContain(WALLET.slice(2))
    expect(bytes).not.toContain("scanStart")
    const lines = bytes.trimEnd().split("\n")
    expect(lines).toHaveLength(3)
    expect(new Set(lines.map((line) => line.length)).size).toBe(1)
    for (const line of lines) expect(Object.keys(JSON.parse(line)).sort()).toEqual(["ct", "epk", "v"])
    expect((await stat(evmRecordPath(path))).mode & 0o777).toBe(0o600)

    const opened = await reopen(path)
    const read = await readEvmRecord(opened)
    expect(read.absent).toBe(false)
    expect(read.entries).toEqual([
      { kind: "token", wallet: WALLET, token: TOKEN_A },
      { kind: "scanStart", wallet: WALLET, block: 12 },
    ])
    closeVault(opened)
  })

  test("the padding: every entry is exactly 160 bytes, and one over is refused, never truncated", async () => {
    expect(paddedEntry({ kind: "token", wallet: WALLET, token: TOKEN_A })?.length).toBe(EVM_RECORD_PLAINTEXT_BYTES)
    expect(paddedEntry({ kind: "scanStart", wallet: WALLET, block: 1 })?.length).toBe(EVM_RECORD_PLAINTEXT_BYTES)
    const long = { kind: "token" as const, wallet: WALLET, token: `0x${"a".repeat(200)}` }
    expect(paddedEntry(long)).toBeUndefined()
    const { path, vault } = await v4Vault()
    closeVault(vault)
    const outcome = await appendEvmRecordEntry({ vaultPath: path, entry: long, clock: testClock })
    expect(outcome).toMatchObject({ written: false, reason: "too-long" })
    await expect(stat(evmRecordPath(path))).rejects.toThrow()
  })

  test("a seal failure other than an over-long entry is write-failed", async () => {
    const { path, vault } = await v4Vault()
    closeVault(vault)
    await tamper(path, (file) => {
      // 43 base64url characters, so the header accepts it, and non-zero padding, so the seal's
      // decode throws. That failure is not an over-long entry.
      file.evmRecordPublicKey = `${"A".repeat(42)}B`
    })
    const outcome = await appendEvmRecordEntry({
      vaultPath: path,
      entry: { kind: "token", wallet: WALLET, token: TOKEN_A },
      clock: testClock,
    })
    expect(outcome).toMatchObject({ written: false, reason: "write-failed" })
  })

  test("a skipped append names why: no vault, a version 3 header, an unreadable header, a lock not taken", async () => {
    const entry = { kind: "token" as const, wallet: WALLET, token: TOKEN_A }
    const made = await makeVault()
    closeVault(made.vault)
    expect(
      await appendEvmRecordEntry({ vaultPath: join(made.dir, "none.enc"), entry, clock: testClock }),
    ).toMatchObject({
      written: false,
      reason: "no-vault",
    })
    expect(await appendEvmRecordEntry({ vaultPath: made.path, entry, clock: testClock })).toMatchObject({
      written: false,
      reason: "no-record-key",
    })
    const { path, vault } = await v4Vault()
    closeVault(vault)
    await mkdir(`${evmRecordPath(path)}.lock`)
    expect(await appendEvmRecordEntry({ vaultPath: path, entry, clock: testClock, lockWaitMs: 0 })).toMatchObject({
      written: false,
      reason: "locked",
    })
    await writeFile(path, "{ not json", "utf8")
    expect(await appendEvmRecordEntry({ vaultPath: path, entry, clock: testClock })).toMatchObject({
      written: false,
      reason: "header-unreadable",
    })
  })

  test("repair (i): a torn append is truncated under the lock, and the next line reads", async () => {
    const { path, vault } = await v4Vault()
    closeVault(vault)
    await appendEvmRecordEntry({
      vaultPath: path,
      entry: { kind: "token", wallet: WALLET, token: TOKEN_A },
      clock: testClock,
    })
    const record = evmRecordPath(path)
    await writeFile(record, `${await readFile(record, "utf8")}{"v":1,"epk":"torn`, "utf8")
    const opened = await reopen(path)
    const torn = await readEvmRecord(opened)
    expect(torn.partialTail).toBe(true)
    expect(torn.entries).toHaveLength(1)
    const outcome = await appendEvmRecordEntry({
      vaultPath: path,
      entry: { kind: "token", wallet: WALLET, token: TOKEN_B },
      clock: testClock,
    })
    expect(outcome).toMatchObject({ written: true, repairedPartial: true })
    const repaired = await readEvmRecord(opened)
    expect(repaired.partialTail).toBe(false)
    expect(repaired.unreadableLines).toBe(0)
    expect(repaired.entries.map((entry) => (entry.kind === "token" ? entry.token : ""))).toEqual([TOKEN_A, TOKEN_B])
    closeVault(opened)
  })

  test("a line that does not decrypt is counted and skipped, never a stop; a missing record is absent, not an error", async () => {
    const { path, vault } = await v4Vault()
    expect((await readEvmRecord(vault)).absent).toBe(true)
    const foreign = await createEvmRecordKey(vault.payloadKey, vault.file.vaultId)
    const line = await sealEvmRecordLine(
      { kind: "token", wallet: WALLET, token: TOKEN_B },
      foreign.publicKey,
      vault.file.vaultId,
    )
    await appendEvmRecordEntry({
      vaultPath: path,
      entry: { kind: "token", wallet: WALLET, token: TOKEN_A },
      clock: testClock,
    })
    const record = evmRecordPath(path)
    await writeFile(record, `${await readFile(record, "utf8")}${line}`, "utf8")
    const read = await readEvmRecord(vault)
    expect(read.unreadableLines).toBe(1)
    expect(read.entries).toEqual([{ kind: "token", wallet: WALLET, token: TOKEN_A }])
    closeVault(vault)
  })

  test("backup copies the lines that decrypt, reports copied and dropped, leaves the live record alone; verify passes the copy", async () => {
    const { path, dir, vault } = await v4Vault()
    await appendEvmRecordEntry({
      vaultPath: path,
      entry: { kind: "token", wallet: WALLET, token: TOKEN_A },
      clock: testClock,
    })
    await appendEvmRecordEntry({
      vaultPath: path,
      entry: { kind: "scanStart", wallet: WALLET, block: 9 },
      clock: testClock,
    })
    const foreign = await createEvmRecordKey(vault.payloadKey, vault.file.vaultId)
    const bad = await sealEvmRecordLine(
      { kind: "token", wallet: WALLET, token: TOKEN_B },
      foreign.publicKey,
      vault.file.vaultId,
    )
    const record = evmRecordPath(path)
    const live = `${await readFile(record, "utf8")}${bad}{"v":1,"partial`
    await writeFile(record, live, "utf8")

    const copyPath = join(dir, "backup.enc")
    await writeFile(copyPath, await readFile(path, "utf8"), "utf8")
    const outcome = await copyEvmRecordForBackup(vault, evmRecordPath(copyPath), testClock)
    expect(outcome).toMatchObject({ present: true, copied: 2, dropped: 2 })
    expect(await readFile(record, "utf8")).toBe(live)

    const copy = await reopen(copyPath)
    expect(await verifyEvmRecordCopy(copy)).toMatchObject({ notApplicable: false, absent: false, lines: 2 })
    // (iii) the copy's record edited after the backup fails the ninth check.
    const copied = await readFile(evmRecordPath(copyPath), "utf8")
    const [first, second] = copied.trimEnd().split("\n")
    const edited = JSON.parse(first as string)
    edited.ct = flipByte(edited.ct)
    await writeFile(evmRecordPath(copyPath), `${JSON.stringify(edited)}\n${second}\n`, "utf8")
    await expect(verifyEvmRecordCopy(copy)).rejects.toMatchObject({ code: "VAULT_VERIFY_FAILED" })
    await writeFile(evmRecordPath(copyPath), `${copied}{"v":1`, "utf8")
    await expect(verifyEvmRecordCopy(copy)).rejects.toMatchObject({ code: "VAULT_VERIFY_FAILED" })
    closeVault(copy)
    closeVault(vault)
  })

  test("verify-backup passes a version 4 copy with no record beside it, and says it was absent", async () => {
    const { path, vault } = await v4Vault()
    closeVault(vault)
    const copy = await reopen(path)
    expect(await verifyEvmRecordCopy(copy, join(copy.path, "..", "nothing.evm-record.sealed"))).toMatchObject({
      absent: true,
      lines: 0,
    })
    closeVault(copy)
  })

  test("backup fails, recording nothing, when the live record's lock cannot be taken", async () => {
    const { path, dir, vault } = await v4Vault()
    await appendEvmRecordEntry({
      vaultPath: path,
      entry: { kind: "token", wallet: WALLET, token: TOKEN_A },
      clock: testClock,
    })
    await mkdir(`${evmRecordPath(path)}.lock`)
    const clock = {
      now: (() => {
        let t = 0
        return () => (t += 20_000)
      })(),
      sleep: async () => {},
    }
    await expect(copyEvmRecordForBackup(vault, join(dir, "b.evm-record.sealed"), clock)).rejects.toMatchObject({
      code: "EVM_RECORD_UNAVAILABLE",
    })
    closeVault(vault)
  })

  test("repair (ii): a record left by an earlier vault is moved aside by the write that creates the key", async () => {
    const made = await makeVault()
    const record = evmRecordPath(made.path)
    await writeFile(record, "an earlier vault's line\n", "utf8")
    const notices: string[] = []
    const v4 = await commitVault(
      made.vault,
      { index: made.vault.index },
      { ...testClock, stderr: { write: (line: string) => notices.push(line) } as never },
    )
    // A write with no EVM TEE wallet does not create the key and moves nothing.
    expect(v4.file.version).toBe(2)
    expect(await readFile(record, "utf8")).toBe("an earlier vault's line\n")
    const added = await addEvmTeeWithNotice(v4, notices)
    expect(added.file.version).toBe(4)
    const siblings = await readdir(made.dir)
    const orphan = siblings.find((name) => name.startsWith("vault.evm-record.sealed.orphaned-"))
    expect(orphan).toMatch(/^vault\.evm-record\.sealed\.orphaned-\d{8}T\d{6}Z$/)
    expect(await readFile(join(made.dir, orphan as string), "utf8")).toBe("an earlier vault's line\n")
    await expect(stat(record)).rejects.toThrow()
    expect(notices.join("")).toContain(`was at ${record}; it was moved to ${join(made.dir, orphan as string)}`)
    // The next append starts a fresh record whose first line is this vault's.
    await appendEvmRecordEntry({
      vaultPath: made.path,
      entry: { kind: "token", wallet: WALLET, token: TOKEN_A },
      clock: testClock,
    })
    const read = await readEvmRecord(added)
    expect(read.entries).toHaveLength(1)
    expect(read.unreadableLines).toBe(0)
    closeVault(added)
  })

  test("splitRecord: complete lines, and a partial tail", () => {
    const enc = (s: string) => new TextEncoder().encode(s)
    expect(splitRecord(enc(""))).toEqual({ lines: [], partialTail: false })
    expect(splitRecord(enc("a\nb\n"))).toEqual({ lines: ["a", "b"], partialTail: false })
    expect(splitRecord(enc("a\nb"))).toEqual({ lines: ["a"], partialTail: true })
  })
})

async function addEvmTeeWithNotice(vault: UnlockedVault, notices: string[]): Promise<UnlockedVault> {
  const root = await decryptRoot(vault)
  try {
    const derived = await deriveEvmTeeKeyFromRoot(root, 0)
    try {
      const id = freshKeyId()
      const blob = await sealKeyBlob(vault, id, derived.secret)
      return await commitVault(
        vault,
        {
          index: {
            ...vault.index,
            hd: {
              ...vault.index.hd,
              nextIndex: { ...vault.index.hd.nextIndex, evmTee: 1 },
              exposedIndexes: { ...vault.index.hd.exposedIndexes, evmTee: [0] },
            },
            entries: [
              ...vault.index.entries,
              {
                id,
                chain: "evm",
                curve: "secp256k1",
                address: derived.address,
                label: "evm-tee-0",
                createdAt: "2026-09-25T00:00:00.000Z",
                role: "tee-wallet",
                origin: "derived",
                derivation: { scheme: EVM_DERIVATION_SCHEME, path: evmTeePath(0) },
                exposure: { everRemoteExposed: true, everExported: false },
                tee: { network: "hood-mainnet", lifecycle: "import-pending", vaultDestination: WALLET },
              },
            ],
          },
          addKeys: [blob],
        },
        { ...testClock, stderr: { write: (line: string) => notices.push(line) } as never },
      )
    } finally {
      wipe(derived.secret)
    }
  } finally {
    wipe(root)
  }
}
