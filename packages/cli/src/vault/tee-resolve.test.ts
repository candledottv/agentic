/**
 * BE-178, findings 4 and 8: `resolveTeeAddress` on a vault-owned TEE wallet.
 *
 * Finding 8: every resolve decrypts the key blob into a wipeable buffer, verifies it re-derives
 * the address, and zeroes it; only a resolve for SIGNING keeps the secret as a base58 string. So a
 * read resolve leaves no immutable copy of the secret behind, and a tampered key blob is still
 * refused on the read paths: `tee status` must not report such a wallet as usable and `tee fund`
 * must not tell an operator to send funds to it.
 *
 * Finding 4: when the decryption throws, the vault it opened is closed on the way out, so the DEK
 * is zero afterwards. Asserted through `trackSecrets`, the seam onto the real allocations.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { base58 } from "@scure/base"
import { Keypair } from "@solana/web3.js"
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"
import { trackSecrets } from "./hygiene"
import { closeVault, commitVault, sealKeyBlob } from "./store"
import { releaseResolvedTee, resolveTeeAddress } from "./tee-resolve"
import { FIXTURE_PASSPHRASE, flipByte, makeVault, tamper, testClock, useCheapKdf } from "./test-vault"

setDefaultTimeout(30_000)
useCheapKdf()

const unreachableFetch = (async () => {
  throw new Error("no test in this file should make a network call")
}) as unknown as typeof fetch

const parsed = (() => {
  const result = parseArgs([], { valueFlags: [], booleanFlags: [] })
  if ("error" in result) throw new Error(result.error)
  return result
})()

/** A vault holding one migrated TEE wallet whose 64-byte secret is `tee.secretKey`. */
async function vaultWithTee(): Promise<{ dir: string; path: string; address: string; secret64: Uint8Array }> {
  const made = await makeVault()
  const tee = Keypair.generate()
  const destination = Keypair.generate().publicKey.toBase58()
  try {
    const entries = [
      ...made.vault.index.entries,
      {
        id: "tee-1",
        chain: "solana" as const,
        curve: "ed25519" as const,
        address: tee.publicKey.toBase58(),
        label: "T",
        createdAt: "2026-09-17T12:00:00.000Z",
        role: "tee-wallet" as const,
        origin: "migrated-tee" as const,
        exposure: { everRemoteExposed: true, everExported: false },
        linkedWalletId: "lw_t",
        tee: {
          network: "solana-mainnet" as const,
          lifecycle: "enabled" as const,
          vaultDestination: destination,
          remoteAuthority: "verified-active" as const,
          grantIdentity: {
            account: "TestAccountABCDEFGH1234567890xyzabc",
            apiBaseUrl: "https://api.test",
            source: "recorded-at-operation" as const,
          },
        },
      },
    ]
    const blob = await sealKeyBlob(made.vault, "tee-1", tee.secretKey)
    const next = await commitVault(
      made.vault,
      { index: { hd: made.vault.index.hd, entries }, addKeys: [blob] },
      testClock,
    )
    closeVault(next)
  } finally {
    closeVault(made.vault)
  }
  return { dir: made.dir, path: made.path, address: tee.publicKey.toBase58(), secret64: tee.secretKey }
}

function context(dir: string, json = false) {
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    fetch: unreachableFetch,
    stdout,
    stderr,
    env: { CANDLE_CONFIG_DIR: dir },
    promptSecret: async () => FIXTURE_PASSPHRASE,
  })
  const ctx: CommandContext = { deps, json, apiUrl: "https://api.test", verifyAccount: false }
  return { ctx, stdout, stderr, deps }
}

const neverLegacy = async () => {
  throw new Error("the vault owns this address; the Phase 1 store must not be opened")
}

async function tamperTeeBlob(path: string): Promise<void> {
  await tamper(path, (file) => {
    const blob = file.keys.find((candidate) => candidate.id === "tee-1")
    if (!blob) throw new Error("no tee blob")
    blob.ciphertext = flipByte(blob.ciphertext)
  })
}

const allZero = (buffers: Uint8Array[]) => buffers.every((buffer) => buffer.every((byte) => byte === 0))

describe("BE-178 finding 8: the secret survives the resolve only for signing", () => {
  test("a read resolve verifies the key and keeps no string copy; every buffer it used is zero after release", async () => {
    const v = await vaultWithTee()
    const { ctx } = context(v.dir)
    const tracked = trackSecrets()
    const resolved = await resolveTeeAddress(ctx, parsed, v.address, neverLegacy)
    expect(resolved.ok).toBe(true)
    if (!resolved.ok || resolved.resolved.source !== "vault") throw new Error("expected a vault hit")
    try {
      expect(resolved.resolved.privateKeyBase58).toBeNull()
      expect(resolved.resolved.legacyView.privateKey).toBe("")
      expect(resolved.resolved.legacyView.address).toBe(v.address)
      expect(resolved.resolved.legacyView.linkedWalletId).toBe("lw_t")
    } finally {
      releaseResolvedTee(resolved.resolved)
    }
    const buffers = tracked.stop()
    // The decrypted secret and the DEK both went through the tracked path; both are zero now.
    expect(buffers.length).toBeGreaterThanOrEqual(2)
    expect(allZero(buffers)).toBe(true)
  })

  test("a sign resolve keeps the secret, and it re-derives the address", async () => {
    const v = await vaultWithTee()
    const { ctx } = context(v.dir)
    const resolved = await resolveTeeAddress(ctx, parsed, v.address, neverLegacy, "sign")
    expect(resolved.ok).toBe(true)
    if (!resolved.ok || resolved.resolved.source !== "vault") throw new Error("expected a vault hit")
    try {
      expect(resolved.resolved.privateKeyBase58).toBe(base58.encode(v.secret64))
      expect(resolved.resolved.legacyView.privateKey).toBe(base58.encode(v.secret64))
    } finally {
      releaseResolvedTee(resolved.resolved)
    }
  })

  test("a read resolve still refuses a tampered key blob, and closes the vault", async () => {
    const v = await vaultWithTee()
    await tamperTeeBlob(v.path)
    const { ctx, stdout, stderr } = context(v.dir)
    const tracked = trackSecrets()
    const resolved = await resolveTeeAddress(ctx, parsed, v.address, neverLegacy)
    const buffers = tracked.stop()
    expect(resolved.ok).toBe(false)
    expect(stdout.text + stderr.text).toContain("failed its authentication tag")
    expect(buffers.length).toBeGreaterThan(0)
    expect(allZero(buffers)).toBe(true)
  })

  test("tee status on a vault-owned address reports it, and prints no secret", async () => {
    const v = await vaultWithTee()
    const { deps, stdout } = context(v.dir, true)
    expect(await run(["tee", "status", v.address, "--json"], deps)).toBe(0)
    const report = JSON.parse(stdout.text.trim()) as Record<string, unknown>
    expect(report.source).toBe("vault")
    expect(report.address).toBe(v.address)
    expect(report.vaultLifecycle).toBe("enabled")
    expect(stdout.text).not.toContain(base58.encode(v.secret64))
  })

  test("tee status on a tampered key blob fails rather than reporting the wallet as enabled", async () => {
    const v = await vaultWithTee()
    await tamperTeeBlob(v.path)
    const { deps, stdout } = context(v.dir, true)
    expect(await run(["tee", "status", v.address, "--json"], deps)).toBe(1)
    const failure = JSON.parse(stdout.text.trim()) as { ok?: boolean; code?: string }
    expect(failure.ok).toBe(false)
    expect(failure.code).toBe("VAULT_BLOB_TAMPERED")
    expect(stdout.text).not.toContain("localState")
  })

  test("tee fund on a tampered key blob exits non-zero and prints no funding instruction", async () => {
    const v = await vaultWithTee()
    await tamperTeeBlob(v.path)
    const { deps, stdout, stderr } = context(v.dir, true)
    expect(await run(["tee", "fund", v.address, "--amount", "5", "--json"], deps)).toBe(1)
    expect(stdout.text + stderr.text).not.toContain("fund-tee-wallet")
    expect(stdout.text + stderr.text).not.toContain("amountRaw")
    const failure = JSON.parse(stdout.text.trim()) as { ok?: boolean; code?: string }
    expect(failure.ok).toBe(false)
    expect(failure.code).toBe("VAULT_BLOB_TAMPERED")
  })

  test("tee fund on an intact vault-owned wallet still prints the instruction, with no secret in it", async () => {
    const v = await vaultWithTee()
    const { deps, stdout } = context(v.dir, true)
    expect(await run(["tee", "fund", v.address, "--amount", "5", "--json"], deps)).toBe(0)
    const instruction = JSON.parse(stdout.text.trim()) as Record<string, unknown>
    expect(instruction.action).toBe("fund-tee-wallet")
    expect(instruction.destination).toBe(v.address)
    expect(stdout.text).not.toContain(base58.encode(v.secret64))
  })
})

describe("BE-178 finding 4: the vault is closed on every exit path", () => {
  test("a throw from the key blob's decryption zeroes the DEK before the failure is reported", async () => {
    const v = await vaultWithTee()
    await tamperTeeBlob(v.path)
    const { ctx, stdout, stderr } = context(v.dir)
    const tracked = trackSecrets()
    const resolved = await resolveTeeAddress(ctx, parsed, v.address, neverLegacy, "sign")
    const buffers = tracked.stop()
    expect(resolved.ok).toBe(false)
    expect(stdout.text + stderr.text).toContain("failed its authentication tag")
    // The DEK was allocated through the tracked path when the vault opened; it must be zero now.
    expect(buffers.length).toBeGreaterThan(0)
    expect(allZero(buffers)).toBe(true)
  })
})
