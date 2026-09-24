/**
 * Ember Phase 4a (BE-350, spec `2026-09-24-ember-phase-4a-evm-vault-keys-design.md`, D7), E9:
 * `vault restore --phrase --evm-count 3` derives EVM indices 0..2, sets `nextIndex.evm = 3`, writes
 * every EVM entry `exposureUnknown: true`, and adds nothing to `discovery.requestedCounts`. A
 * linked-wallet row whose address is one of those keys flags it remotely exposed and records the
 * index in `exposedIndexes.evm`, and the entry stays `role: "vault"` rather than becoming a Solana
 * `tee-wallet`. `verify` then checks scalar bytes and secret→address on the restored vault.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mnemonicToAccount } from "viem/accounts"
import type { Deps } from "../deps"
import { FIXTURE_EVM_0, FIXTURE_EVM_1 } from "../evm-lite.test"
import { run } from "../index"
import { SECRET_REFS } from "../secret-store"
import {
  createCapture,
  createFakeStore,
  createRoutedFetch,
  createTestDeps,
  jsonResponse,
  type RouteHandler,
} from "../test-support"
import { closeVault, decryptKey } from "../vault/store"
import { FIXTURE_PHRASE, generatedPassphraseFrom, reopen, useCheapKdf } from "../vault/test-vault"
import { verifyVaultIntegrity } from "../vault/verify"

setDefaultTimeout(60_000)
useCheapKdf()

const ACCOUNT = "AcctAddress1111111111111111111abcdef"
const EVM_2 = mnemonicToAccount(FIXTURE_PHRASE, { accountIndex: 2 }).address

function row(address: string, extra: Record<string, unknown> = {}) {
  return { _id: `w-${address.slice(0, 8)}`, address, chain: "hood", ...extra }
}

async function harness(pages?: RouteHandler[]) {
  const dir = await mkdtemp(join(tmpdir(), "candle-vault-restore-evm-"))
  const stdout = createCapture()
  const stderr = createCapture()
  const routed = createRoutedFetch({
    "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: ACCOUNT }),
    "/api/v1/agent/wallets": pages ?? [() => jsonResponse(200, { success: true, page: [], isDone: true })],
  })
  let askedPhrase = false
  const deps: Deps = createTestDeps({
    fetch: routed.fetch,
    stdout,
    stderr,
    store: createFakeStore({ [SECRET_REFS.apiKey]: "ck_live_testkey" }),
    env: { CANDLE_CONFIG_DIR: dir, HOME: dir },
    isTTY: { stdin: true, stdout: true, stderr: true },
    promptSecret: async () => {
      if (!askedPhrase) {
        askedPhrase = true
        return FIXTURE_PHRASE
      }
      return generatedPassphraseFrom(stdout.text)
    },
    promptLine: async (text: string) => (text.includes("last six characters") ? ACCOUNT.slice(-6) : "no"),
  })
  const vaultPath = join(dir, "vault.enc")
  return {
    deps,
    stdout,
    stderr,
    vaultPath,
    restore: (args: string[]) => run(["vault", "restore", "--phrase", ...args, "--keystore", vaultPath], deps),
    reopen: () => reopen(vaultPath, generatedPassphraseFrom(stdout.text)),
  }
}

describe("E9: restore --evm-count", () => {
  test("derives 0..2 on m/44'/60'/n'/0/0 as EVM vault keys, sets nextIndex.evm = 3, and discovery has no evm count", async () => {
    const h = await harness()
    expect(await h.restore(["--count", "1", "--evm-count", "3"])).toBe(0)
    expect(h.stdout.text).toContain(`${FIXTURE_EVM_0}  m/44'/60'/0'/0/0  vault`)
    expect(h.stdout.text).toContain(`${FIXTURE_EVM_1}  m/44'/60'/1'/0/0  vault`)
    expect(h.stdout.text).toContain(`${EVM_2}  m/44'/60'/2'/0/0  vault`)
    expect(h.stdout.text).toContain("evm: indices 0 to 2, on m/44'/60'/n'/0/0.")

    const vault = await h.reopen()
    try {
      const evm = vault.index.entries.filter((entry) => entry.chain === "evm")
      expect(evm.map((entry) => entry.label)).toEqual(["evm-0", "evm-1", "evm-2"])
      for (const entry of evm) {
        expect(entry).toMatchObject({
          curve: "secp256k1",
          role: "vault",
          origin: "derived",
          exposure: { everRemoteExposed: false, everExported: false, exposureUnknown: true },
        })
        expect(entry.derivation).toEqual({ scheme: "bip32-secp256k1", path: `m/44'/60'/${evm.indexOf(entry)}'/0/0` })
        expect(entry.tee).toBeUndefined()
        expect((await decryptKey(vault, entry.id)).length).toBe(32)
      }
      expect(vault.index.hd.nextIndex).toEqual({ solanaVault: 1, solanaTee: 1, solanaExternal: 1, evm: 3 })
      expect(vault.index.hd.exposedIndexes.evm).toEqual([])
      // Invariant 4: `--evm-count` is a command argument, not a discovery field.
      expect(vault.index.hd.discovery?.requestedCounts).toEqual({ solanaVault: 1, solanaTee: 1, solanaExternal: 1 })
      expect(Object.keys(vault.index.hd.discovery?.requestedCounts ?? {})).not.toContain("evm")
      expect(vault.index.hd.discovery?.highestMatched).toEqual({ solanaVault: -1, solanaTee: -1, solanaExternal: -1 })
      // The verifier's EVM half on the restored vault: scalar bytes re-derive, secret→address holds.
      const report = await verifyVaultIntegrity(vault)
      for (const entry of evm) {
        expect(report.rederived).toContain(entry.id)
        expect(report.addressChecked).toContain(entry.id)
      }
    } finally {
      closeVault(vault)
    }
  })

  test("--evm-count defaults to 0, is never gap-scanned, and the output says how to ask for it", async () => {
    const h = await harness()
    expect(await h.restore(["--count", "1"])).toBe(0)
    expect(h.stdout.text).not.toContain("m/44'/60'")
    expect(h.stdout.text).toContain(
      "evm: none. If this root has EVM keys, re-run with --evm-count <n>; the EVM branch is never gap-scanned.",
    )
    const vault = await h.reopen()
    try {
      expect(vault.index.entries.some((entry) => entry.chain === "evm")).toBe(false)
      expect(vault.index.hd.nextIndex.evm).toBe(0)
    } finally {
      closeVault(vault)
    }
    const { parseCounts } = await import("./vault-restore")
    expect(parseCounts(undefined, undefined, undefined, undefined, "2")).toMatchObject({ evm: 2, solanaVault: 1 })
    expect(parseCounts(undefined, undefined, undefined, "https://rpc.test", undefined)).toMatchObject({ evm: 0 })
    expect(parseCounts(undefined, undefined, undefined, undefined, "x")).toMatchObject({
      error: expect.stringContaining("--evm-count"),
    })
  })

  test("a linked-wallet row matching a derived EVM address (in either case) flags it, records exposedIndexes.evm, and keeps role vault", async () => {
    const h = await harness([
      () =>
        jsonResponse(200, {
          success: true,
          page: [row(FIXTURE_EVM_1.toLowerCase(), { label: "hood-agent", vaultDestination: "SomeSolanaVault111" })],
          isDone: true,
        }),
    ])
    expect(await h.restore(["--count", "1", "--evm-count", "2"])).toBe(0)
    expect(h.stdout.text).toContain(`${FIXTURE_EVM_1}  m/44'/60'/1'/0/0  vault  (this account imported it)`)
    expect(h.stdout.text).toContain("1 of them are addresses this account imported")
    const vault = await h.reopen()
    try {
      const flagged = vault.index.entries.find((entry) => entry.address === FIXTURE_EVM_1)
      expect(flagged).toMatchObject({
        chain: "evm",
        role: "vault",
        label: "hood-agent",
        exposure: { everRemoteExposed: true, everExported: false, exposureUnknown: true },
      })
      // Not rewritten as a Solana TEE wallet: no `tee`, no `linkedWalletId`.
      expect(flagged?.tee).toBeUndefined()
      expect(flagged?.linkedWalletId).toBeUndefined()
      const other = vault.index.entries.find((entry) => entry.address === FIXTURE_EVM_0)
      expect(other?.exposure.everRemoteExposed).toBe(false)
      expect(vault.index.hd.exposedIndexes.evm).toEqual([1])
      expect(vault.index.hd.exposedIndexes.solanaVault).toEqual([])
      // Step 7 of the verifier accepts the flagged entry because its index is recorded.
      await verifyVaultIntegrity(vault)
    } finally {
      closeVault(vault)
    }
  })

  test("a listed 0x address this restore did not derive stays in the unmatched bucket", async () => {
    const h = await harness([
      () =>
        jsonResponse(200, { success: true, page: [row("0x000000000000000000000000000000000000dEaD")], isDone: true }),
    ])
    expect(await h.restore(["--count", "1", "--evm-count", "1"])).toBe(3)
    expect(h.stdout.text).toContain("1 address(es) this account imported were NOT derived by this restore")
    expect(h.stdout.text).toContain("0x000000000000000000000000000000000000dEaD")
  })
})
