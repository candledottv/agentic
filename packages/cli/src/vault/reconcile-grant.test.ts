/**
 * BE-303 (spec 2026-09-23-tee-wallet-rebind-design.md, D9, test L8): the vault's copy of the
 * bound key prefix is a cache the server overrides, never a gate. `adoptGrantedRow`'s
 * fully-recorded branch adopts a server prefix that differs and says so on stderr; a
 * linked-wallet id or destination that differs is still `GRANT_BINDING_MISMATCH`.
 */
import { describe, expect, test } from "bun:test"
import type { CommandContext } from "../deps"
import { createCapture, createTestDeps } from "../test-support"
import { VaultError } from "./errors"
import type { KeyEntry } from "./format"
import type { LinkedWalletRow } from "./linked-wallets"
import { adoptGrantedRow, assertBinding } from "./reconcile-grant"

const ADDRESS = "TeeWa11etAddress111111111111111111111111111"
const VAULT = "VaultAddress1111111111111111111111111111111"

function entry(overrides: Partial<KeyEntry> = {}): KeyEntry {
  return {
    id: "entry-1",
    chain: "solana",
    curve: "ed25519",
    address: ADDRESS,
    label: "tr-01",
    createdAt: "2026-09-16T00:00:00.000Z",
    linkedWalletId: "lw_1",
    tee: {
      network: "solana-mainnet",
      lifecycle: "enabled",
      vaultDestination: VAULT,
      boundKeyPrefix: "B6P-TSRs",
      remoteAuthority: "verified-active",
      grantIdentity: { account: "Acct", apiBaseUrl: "https://api.test", source: "recorded-at-operation" },
    },
    ...overrides,
  } as KeyEntry
}

function row(overrides: Partial<LinkedWalletRow> = {}): LinkedWalletRow {
  return {
    _id: "lw_1",
    address: ADDRESS,
    chain: "solana",
    profile: "ember-tee",
    boundKeyPrefix: "B6P-TSRs",
    vaultDestination: VAULT,
    remoteAuthority: "verified-active",
    ...overrides,
  }
}

function ctxWith(stderr = createCapture()): { ctx: CommandContext; stderr: ReturnType<typeof createCapture> } {
  const deps = createTestDeps({
    fetch: (async () => {
      throw new Error("no request expected")
    }) as unknown as typeof fetch,
    stderr,
  })
  return { ctx: { deps, json: false, apiUrl: "https://api.test", verifyAccount: true }, stderr }
}

describe("assertBinding (L8)", () => {
  test("a prefix-only difference is reported, not thrown", () => {
    expect(assertBinding(entry(), row({ boundKeyPrefix: "Ab3dEf9h" }))).toEqual({ from: "B6P-TSRs", to: "Ab3dEf9h" })
    expect(assertBinding(entry(), row())).toBeUndefined()
  })

  test("a linked-wallet id or a destination that differs is still GRANT_BINDING_MISMATCH", () => {
    for (const bad of [
      row({ _id: "lw_other" }),
      row({ vaultDestination: "OtherVault111111111111111111111111111111111" }),
    ]) {
      let thrown: unknown
      try {
        assertBinding(entry(), bad)
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(VaultError)
      expect((thrown as VaultError).code).toBe("GRANT_BINDING_MISMATCH")
    }
  })
})

describe("adoptGrantedRow on a fully recorded entry (L8)", () => {
  test("adopts the server's prefix into the patch and prints the one line", async () => {
    const { ctx, stderr } = ctxWith()
    const result = await adoptGrantedRow(ctx, entry(), row({ boundKeyPrefix: "Ab3dEf9h" }), "Acct", {
      confirmDestination: async () => {
        throw new Error("a fully recorded entry never asks")
      },
    })
    expect(result.outcome).toBe("verified")
    expect(result.patch.tee?.boundKeyPrefix).toBe("Ab3dEf9h")
    expect(result.patch.tee?.vaultDestination).toBe(VAULT)
    expect(stderr.text).toBe(`${ADDRESS}: bound key is now Ab3dEf9h (was B6P-TSRs); it was moved with tee rebind.\n`)
  })

  test("a matching prefix writes the same patch as before and prints nothing", async () => {
    const { ctx, stderr } = ctxWith()
    const result = await adoptGrantedRow(ctx, entry(), row(), "Acct", {
      confirmDestination: async () => true,
    })
    expect(result.outcome).toBe("verified")
    expect(result.patch.tee?.boundKeyPrefix).toBe("B6P-TSRs")
    expect(stderr.text).toBe("")
  })

  test("a destination mismatch still refuses", async () => {
    const { ctx } = ctxWith()
    await expect(
      adoptGrantedRow(ctx, entry(), row({ vaultDestination: "OtherVault111111111111111111111111111111111" }), "Acct", {
        confirmDestination: async () => true,
      }),
    ).rejects.toMatchObject({ code: "GRANT_BINDING_MISMATCH" })
  })
})
