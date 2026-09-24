/**
 * Ember Phase 4a (BE-350, spec `2026-09-24-ember-phase-4a-evm-vault-keys-design.md`, D3, D7), E3:
 * `vault new-key --chain evm` allocates the next EVM index, writes the entry, and refuses in a
 * restored vault. Plus the parts of E9 that are `verify`'s: the written entry re-derives and its
 * scalar produces its address, and a tampered one fails.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mnemonicToAccount } from "viem/accounts"
import { FIXTURE_EVM_0, FIXTURE_EVM_1 } from "../evm-lite.test"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"
import { closeVault, commitVault, decryptKey } from "../vault/store"
import { FIXTURE_PHRASE, makeVault, reopen, testClock, useCheapKdf } from "../vault/test-vault"
import { verifyVaultIntegrity } from "../vault/verify"

setDefaultTimeout(60_000)
useCheapKdf()

const unreachableFetch = (async () => {
  throw new Error("no test in this file should make a network call")
}) as unknown as typeof fetch

async function fixture(opts: { restored?: boolean } = {}) {
  const made = await makeVault(
    opts.restored
      ? {
          hd: {
            scheme: "bip39-24/slip10",
            nextIndex: { solanaVault: 1, solanaTee: 0, solanaExternal: 0, evm: 0 },
            rootExported: false,
            exposedIndexes: { solanaVault: [], solanaTee: [], solanaExternal: [], evm: [] },
            discovery: {
              restoredAt: "2026-09-24T00:00:00.000Z",
              account: "",
              requestedCounts: { solanaVault: 1, solanaTee: 0, solanaExternal: 0 },
              highestMatched: { solanaVault: -1, solanaTee: -1, solanaExternal: -1 },
              complete: false,
            },
          },
        }
      : {},
  )
  closeVault(made.vault)
  return { dir: made.dir, path: made.path, passphrase: made.passphrase }
}

async function newKey(fx: Awaited<ReturnType<typeof fixture>>, args: string[]) {
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    fetch: unreachableFetch,
    stdout,
    stderr,
    env: { CANDLE_CONFIG_DIR: fx.dir, HOME: fx.dir },
    isTTY: { stdin: true, stdout: true, stderr: true },
    promptSecret: async () => fx.passphrase,
    promptLine: async () => "no",
  })
  const code = await run(["vault", "new-key", ...args], deps)
  return { code, stdout: stdout.text, stderr: stderr.text }
}

describe("E3: new-key --chain evm", () => {
  test("allocates index 0 then 1 on m/44'/60'/n'/0/0, writes the entry, and the addresses are the fixture root's", async () => {
    const fx = await fixture()
    const first = await newKey(fx, ["--chain", "evm", "--label", "hood-cold"])
    expect(first.code).toBe(0)
    expect(first.stdout).toContain(`${FIXTURE_EVM_0}\n`)
    expect(first.stdout).toContain("derivation  m/44'/60'/0'/0/0")
    expect(first.stdout).toContain("verified    re-read from the vault and re-derived from its root")

    const second = await newKey(fx, ["--chain", "evm", "--json"])
    expect(second.code).toBe(0)
    expect(JSON.parse(second.stdout)).toMatchObject({
      ok: true,
      address: FIXTURE_EVM_1,
      label: "evm-1",
      path: "m/44'/60'/1'/0/0",
      index: 1,
    })

    const vault = await reopen(fx.path)
    try {
      const evm = vault.index.entries.filter((entry) => entry.chain === "evm")
      expect(evm.map((entry) => entry.label)).toEqual(["hood-cold", "evm-1"])
      for (const entry of evm) {
        expect(entry).toMatchObject({
          chain: "evm",
          curve: "secp256k1",
          role: "vault",
          origin: "derived",
          exposure: { everRemoteExposed: false, everExported: false },
        })
        expect(entry.derivation?.scheme).toBe("bip32-secp256k1")
        // The stored secret is the 32-byte scalar, never a 64-byte Solana layout.
        const secret = await decryptKey(vault, entry.id)
        expect(secret.length).toBe(32)
      }
      // The EVM counter moved and the Solana counters did not (invariant 4).
      expect(vault.index.hd.nextIndex).toEqual({ solanaVault: 0, solanaTee: 0, solanaExternal: 0, evm: 2 })
      // The format did not change: still readable as the version `init` wrote (no version 4).
      expect(vault.file.version).toBeLessThanOrEqual(3)
      // E9's verify half: every EVM entry re-derives from the root and its scalar produces its address.
      const report = await verifyVaultIntegrity(vault)
      expect(report.rederived).toEqual(evm.map((entry) => entry.id))
      expect(report.addressChecked).toEqual(evm.map((entry) => entry.id))
    } finally {
      closeVault(vault)
    }
  })

  test("a Solana key and an EVM key coexist, each on its own counter, with distinct default labels", async () => {
    const fx = await fixture()
    expect((await newKey(fx, ["--chain", "solana"])).code).toBe(0)
    expect((await newKey(fx, ["--chain", "evm"])).code).toBe(0)
    expect((await newKey(fx, ["--chain", "evm", "--count", "2", "--json"])).code).toBe(0)
    const vault = await reopen(fx.path)
    try {
      expect(vault.index.entries.map((entry) => [entry.chain, entry.label])).toEqual([
        ["solana", "key-0"],
        ["evm", "evm-0"],
        ["evm", "evm-1"],
        ["evm", "evm-2"],
      ])
      expect(vault.index.hd.nextIndex).toMatchObject({ solanaVault: 1, evm: 3 })
      // An EVM name that is taken refuses before deriving, as a Solana one does (D9 of key naming).
    } finally {
      closeVault(vault)
    }
    const clash = await newKey(fx, ["--chain", "evm", "--label", "evm-1"])
    expect(clash.code).toBe(2)
    expect(clash.stderr).toContain("A key labelled evm-1 already exists")
  })

  test("an exposed EVM index is skipped, and the address matches viem for the index actually used", async () => {
    const fx = await fixture()
    const vault = await reopen(fx.path)
    await commitVault(
      vault,
      {
        index: {
          hd: { ...vault.index.hd, exposedIndexes: { ...vault.index.hd.exposedIndexes, evm: [0] } },
          entries: vault.index.entries,
        },
      },
      testClock,
    )
    closeVault(vault)
    const out = await newKey(fx, ["--chain", "evm", "--json"])
    expect(out.code).toBe(0)
    expect(JSON.parse(out.stdout)).toMatchObject({ index: 1, address: FIXTURE_EVM_1 })
    expect(JSON.parse(out.stdout).address).toBe(mnemonicToAccount(FIXTURE_PHRASE, { accountIndex: 1 }).address)
  })

  test("refuses in a restored vault with VAULT_ALLOCATION_BOUNDARY_UNKNOWN, exactly as --chain solana does", async () => {
    const fx = await fixture({ restored: true })
    const out = await newKey(fx, ["--chain", "evm", "--json"])
    expect(out.code).toBe(1)
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code: "VAULT_ALLOCATION_BOUNDARY_UNKNOWN" })
    const vault = await reopen(fx.path)
    try {
      expect(vault.index.entries).toEqual([])
      expect(vault.index.hd.nextIndex.evm).toBe(0)
    } finally {
      closeVault(vault)
    }
  })

  test("verify fails an EVM entry whose recorded address is not its scalar's, and one whose scalar is not the root's", async () => {
    const fx = await fixture()
    expect((await newKey(fx, ["--chain", "evm"])).code).toBe(0)
    const vault = await reopen(fx.path)
    try {
      const entry = vault.index.entries[0]
      if (entry === undefined) throw new Error("no entry")
      const wrongAddress = {
        ...vault.index,
        entries: [{ ...entry, address: "0x000000000000000000000000000000000000dEaD" }],
      }
      await expect(verifyVaultIntegrity({ ...vault, index: wrongAddress })).rejects.toMatchObject({
        code: "VAULT_VERIFY_FAILED",
        message: expect.stringContaining("does not produce the address the index records"),
      })
      // The right address for index 0 but recorded as index 5: the scalar does not re-derive.
      const wrongPath = {
        ...vault.index,
        entries: [{ ...entry, derivation: { scheme: "bip32-secp256k1" as const, path: "m/44'/60'/5'/0/0" } }],
      }
      await expect(verifyVaultIntegrity({ ...vault, index: wrongPath })).rejects.toMatchObject({
        code: "VAULT_VERIFY_FAILED",
        message: expect.stringContaining("does not re-derive from the root"),
      })
    } finally {
      closeVault(vault)
    }
  })
})
