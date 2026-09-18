import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { base58 } from "@scure/base"
import { Transaction } from "@solana/web3.js"
import { run } from "../index"
import { createCapture, createFakeStore, createRoutedFetch, createTestDeps, jsonResponse } from "../test-support"
import type { FundingReceipt } from "../vault/funding-receipts"
import { closeVault, commitVault } from "../vault/store"
import { makeVault, reopen, testClock, useCheapKdf } from "../vault/test-vault"

setDefaultTimeout(60_000)
useCheapKdf()
const RPC = "https://rpc.test/rpc"
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"

async function fixture() {
  const made = await makeVault()
  closeVault(made.vault)
  const output = createCapture()
  const errors = createCapture()
  let teeAddress = ""
  let from = ""
  const persistedSignatures: string[] = []
  let fault: "status" | "broadcast" | "confirmed-error" | "missing" | "none" = "status"
  let valid = true
  let broadcasts = 0
  let signingPrompts = 0
  let lamports = 100_000
  const signatures: string[] = []
  const { fetch, calls } = createRoutedFetch({
    "/rpc": async (req) => {
      const { method, params, id } = JSON.parse(String(req.init.body))
      const reply = (result: unknown) => jsonResponse(200, { id, jsonrpc: "2.0", result })
      switch (method) {
        case "getLatestBlockhash":
          return reply({ value: { blockhash: BLOCKHASH } })
        case "getFeeForMessage":
          return reply({ value: 5000 })
        case "getBalance":
          return reply({ value: lamports })
        case "getTokenAccountsByOwner":
          return reply({ value: [] })
        case "getSignatureStatuses":
          expect(signatures.length ? params[0][0] : true).toBe(signatures.at(-1) ?? true)
          if (fault === "status") throw new Error("flaky RPC with secret endpoint detail")
          return reply({
            value: [
              fault === "missing"
                ? null
                : {
                    confirmationStatus: fault === "confirmed-error" ? "confirmed" : "finalized",
                    err: fault === "confirmed-error" ? { InstructionError: [0, "error"] } : null,
                  },
            ],
          })
        case "isBlockhashValid":
          return reply({ value: valid })
        case "sendTransaction": {
          broadcasts++
          const tx = Transaction.from(Buffer.from(params[0], "base64"))
          expect(tx.verifySignatures()).toBe(true)
          const signature = base58.encode(tx.signature!)
          signatures.push(signature)
          const onDisk = await reopen(made.path)
          try {
            const entry = onDisk.index.entries.find((entry) => entry.address === teeAddress)!
            if (tx.feePayer?.toBase58() !== teeAddress) {
              expect(entry.tee?.fundingReceipts).toContainEqual(
                expect.objectContaining({
                  signature,
                  blockhash: BLOCKHASH,
                  finalized: false,
                }),
              )
            } else {
              expect(entry.tee?.sweepPending).toContainEqual(expect.objectContaining({ signature }))
              lamports = 0
            }
          } finally {
            closeVault(onDisk)
          }
          persistedSignatures.push(signature)
          if (fault === "broadcast") throw new Error("response lost with secret endpoint detail")
          return reply("UntrustedRpcEcho")
        }
        default:
          throw new Error(`unexpected RPC method ${method}`)
      }
    },
    "/api/v1/agent/wallets/lw_test": () =>
      jsonResponse(200, {
        success: true,
        state: "quarantined",
        remoteAuthority: "verified-denied",
        complete: true,
      }),
    "/api/v1/agent/wallets/lw_test/lifecycle": () =>
      jsonResponse(200, {
        success: true,
        state: "quarantined",
        remoteAuthority: "verified-denied",
      }),
    "/api/v1/agent/wallets/lw_test/swept": () => jsonResponse(200, { success: true, state: "swept" }),
  })
  const deps = createTestDeps({
    fetch,
    stdout: output,
    stderr: errors,
    store: createFakeStore({ api_key: "ck_live_test" }),
    env: { CANDLE_CONFIG_DIR: made.dir },
    readFile: (path) => readFile(path, "utf8"),
    promptSecret: async (prompt) => {
      if (prompt.startsWith("Type the LAST 6")) return from.slice(-6)
      if (prompt.startsWith("Vault passphrase to")) signingPrompts++
      return made.passphrase
    },
    promptLine: async () => teeAddress.slice(-6),
  })
  for (const label of ["cold", "tee"]) {
    expect(await run(["vault", "new-key", "--chain", "solana", "--label", label], deps)).toBe(0)
  }
  const opened = await reopen(made.path)
  from = opened.index.entries.find((entry) => entry.label === "cold")!.address
  const tee = opened.index.entries.find((entry) => entry.label === "tee")!
  teeAddress = tee.address
  tee.role = "tee-wallet"
  tee.exposure.everRemoteExposed = true
  tee.linkedWalletId = "lw_test"
  tee.tee = {
    network: "solana-mainnet",
    lifecycle: "enabled",
    vaultDestination: from,
    remoteAuthority: "verified-active",
    destinationExposureAccepted: true,
    boundKeyPrefix: "ck_live_test",
    grantIdentity: { account: "TestAccount", apiBaseUrl: "https://api.test", source: "recorded-at-operation" },
  }
  await commitVault(opened, { index: opened.index }, testClock)
  closeVault(opened)
  async function receipts() {
    const vault = await reopen(made.path)
    try {
      return vault.index.entries.find((entry) => entry.address === teeAddress)!.tee!
    } finally {
      closeVault(vault)
    }
  }
  return {
    ...made,
    deps,
    output,
    errors,
    calls,
    from,
    teeAddress,
    receipts,
    setFault: (value: typeof fault) => {
      fault = value
    },
    expire: () => {
      valid = false
    },
    persistedSignatures,
    get broadcasts() {
      return broadcasts
    },
    get signingPrompts() {
      return signingPrompts
    },
    fund: async () => {
      const code = await run(["vault", "fund", teeAddress, "--amount", "0.1", "--asset", "SOL", "--rpc-url", RPC], deps)
      if (code === 1) throw new Error(errors.text)
      return code
    },
    transfer: (to = teeAddress) =>
      run(["vault", "transfer", to, "--from", "cold", "--amount", "0.1", "--asset", "SOL", "--rpc-url", RPC], deps),
  }
}

describe("BE-190 durable funding", () => {
  for (const fault of ["status", "broadcast", "confirmed-error"] as const) {
    test(`${fault} uncertainty retains the pre-broadcast receipt and blocks both signing paths`, async () => {
      const f = await fixture()
      f.setFault(fault)
      expect(await f.fund()).toBe(3)
      const receipts = (await f.receipts()).fundingReceipts as FundingReceipt[]
      expect(receipts).toHaveLength(1)
      expect(receipts[0]?.finalized).toBe(false)
      expect(receipts[0]?.signature).not.toBe("UntrustedRpcEcho")
      f.setFault("status")
      const prompts = f.signingPrompts
      expect(await f.fund()).toBe(3)
      expect(await f.transfer()).toBe(3)
      // Source wallet is guarded even when the transfer targets a different destination.
      expect(await f.transfer(f.from)).toBe(3)
      expect(f.broadcasts).toBe(1)
      expect(f.persistedSignatures).toHaveLength(1)
      expect(f.signingPrompts).toBe(prompts)
      expect(f.output.text + f.errors.text).not.toContain("secret endpoint detail")
      f.setFault("none")
      expect(await f.fund()).toBe(0)
      expect(f.broadcasts).toBe(1)
      expect(f.persistedSignatures).toHaveLength(1)
      expect((await f.receipts()).fundingReceipts).toEqual([{ ...receipts[0], finalized: true }])
    })
  }

  test("a legacy receipt without a blockhash finalizes through vault transfer without a new signature", async () => {
    const f = await fixture()
    expect(await f.fund()).toBe(3)
    const vault = await reopen(f.path)
    const receipt = vault.index.entries.find((e) => e.address === f.teeAddress)!.tee!
      .fundingReceipts![0] as FundingReceipt
    delete receipt.blockhash
    delete receipt.from
    await commitVault(vault, { index: vault.index }, testClock)
    closeVault(vault)
    f.setFault("missing")
    f.expire()
    expect(await f.transfer()).toBe(3)
    f.setFault("none")
    expect(await f.transfer()).toBe(0)
    expect(f.broadcasts).toBe(1)
    expect((await f.receipts()).fundingReceipts?.[0]).toMatchObject({ finalized: true })
  })

  test("expiry requires two missing status reads and records the outcome without signing again", async () => {
    const f = await fixture()
    expect(await f.fund()).toBe(3)
    f.setFault("missing")
    f.expire()
    const before = f.calls.length
    expect(await f.fund()).toBe(3)
    const methods = f.calls.slice(before).map((call) => JSON.parse(String(call.init.body)).method)
    expect(methods).toEqual(["getSignatureStatuses", "isBlockhashValid", "getSignatureStatuses"])
    expect(f.broadcasts).toBe(1)
    expect((await f.receipts()).fundingReceipts?.[0]).toMatchObject({ finalized: false, outcome: "expired" })
  })

  test("fund then disable and sweep preserves funding receipts and destination exposure acceptance", async () => {
    const f = await fixture()
    f.setFault("none")
    expect(await f.fund()).toBe(0)
    const original = (await f.receipts()).fundingReceipts
    expect(await run(["tee", "disable", f.teeAddress], f.deps)).toBe(0)
    expect(await f.receipts()).toMatchObject({ fundingReceipts: original, destinationExposureAccepted: true })
    expect(await run(["tee", "sweep", f.teeAddress, "--rpc-url", RPC], f.deps)).toBe(0)
    expect(await f.receipts()).toMatchObject({ fundingReceipts: original, destinationExposureAccepted: true })
    expect((await f.receipts()).sweepReceipts).toHaveLength(1)
  })
})
