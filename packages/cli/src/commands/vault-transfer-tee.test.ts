/**
 * BE-326 (Phase 2 ED-10 amendment, 2026-09-24): `vault transfer --from` a promoted wallet.
 *
 * The signing is `vault transfer`'s own, so what is asserted here is that a `role: "tee-wallet"`
 * source reaches it with the same prompts and last-six as a vault key, plus the three things the
 * amendment adds for that source only: the pending-sweep refusal, the server-state warning before
 * the confirmation, and the activity report after finality. A vault key's transfer is asserted to
 * make none of those calls.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { base58 } from "@scure/base"
import { getAssociatedTokenAddressSync } from "@solana/spl-token"
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js"
import { run } from "../index"
import { TOKEN_PROGRAM_ID } from "../solana-lite"
import { createCapture, createFakeStore, createRoutedFetch, createTestDeps, jsonResponse } from "../test-support"
import { closeVault, commitVault } from "../vault/store"
import { makeVault, reopen, testClock, useCheapKdf } from "../vault/test-vault"
import { USDC_MINT } from "../vault/vault-transfer-sign"

setDefaultTimeout(60_000)
useCheapKdf()
const RPC = "https://rpc.test/rpc"
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"
const DESTINATION = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
const LIFECYCLE = "/api/v1/agent/wallets/lw_test/lifecycle"
const REPORT = "/api/v1/activity/report"

/** The JSON value `--json` ends stdout with (the decoded display precedes it on the vault path too). */
function lastJson(text: string): Record<string, unknown> {
  return JSON.parse(text.trimEnd().split("\n").at(-1) ?? "")
}

type Handler = Parameters<typeof createRoutedFetch>[0][string]

function classicMint(decimals: number): string {
  const data = new Uint8Array(82)
  data[44] = decimals
  data[45] = 1
  return Buffer.from(data).toString("base64")
}

async function fixture(opts: { lifecycle?: Handler; report?: Handler; apiKey?: boolean; sweepPending?: boolean } = {}) {
  const made = await makeVault()
  closeVault(made.vault)
  const output = createCapture()
  const errors = createCapture()
  const sent: Transaction[] = []
  const events: string[] = []
  let signingPrompts = 0
  const { fetch, calls } = createRoutedFetch({
    "/rpc": async (req) => {
      const { method, params, id } = JSON.parse(String(req.init.body))
      const reply = (result: unknown) => jsonResponse(200, { id, jsonrpc: "2.0", result })
      switch (method) {
        case "getLatestBlockhash":
          return reply({ value: { blockhash: BLOCKHASH } })
        case "getFeeForMessage":
          return reply({ value: 5000 })
        case "getAccountInfo":
          if (params[0] === USDC_MINT) {
            return reply({ value: { owner: TOKEN_PROGRAM_ID, lamports: 1, data: [classicMint(6), "base64"] } })
          }
          return reply({ value: null })
        case "getMinimumBalanceForRentExemption":
          return reply(2_039_280)
        case "sendTransaction": {
          const tx = Transaction.from(Buffer.from(params[0], "base64"))
          expect(tx.verifySignatures()).toBe(true)
          sent.push(tx)
          events.push("broadcast")
          return reply("UntrustedRpcEcho")
        }
        case "getSignatureStatuses":
          return reply({ value: [{ confirmationStatus: "finalized", err: null }] })
        default:
          throw new Error(`unexpected RPC method ${method}`)
      }
    },
    [LIFECYCLE]: opts.lifecycle ?? (() => jsonResponse(200, { success: true, state: "enabled" })),
    [REPORT]: opts.report ?? (() => jsonResponse(200, { payload: { logged: true } })),
  })
  const deps = createTestDeps({
    fetch,
    stdout: output,
    stderr: errors,
    store: createFakeStore(opts.apiKey === false ? {} : { api_key: "ck_live_test" }),
    env: { CANDLE_CONFIG_DIR: made.dir },
    readFile: (path) => readFile(path, "utf8"),
    promptSecret: async (prompt) => {
      if (prompt.startsWith("Vault passphrase to")) {
        signingPrompts++
        events.push("factor")
      }
      return made.passphrase
    },
    promptLine: async (prompt) => {
      events.push(`last-six after ${JSON.stringify(output.text + errors.text)}`)
      expect(prompt).toContain(DESTINATION)
      return DESTINATION.slice(-6)
    },
  })
  for (const label of ["cold", "desk"]) {
    expect(await run(["vault", "new-key", "--chain", "solana", "--label", label], deps)).toBe(0)
  }
  const opened = await reopen(made.path)
  const cold = opened.index.entries.find((entry) => entry.label === "cold")!.address
  const tee = opened.index.entries.find((entry) => entry.label === "desk")!
  const teeAddress = tee.address
  tee.role = "tee-wallet"
  tee.exposure.everRemoteExposed = true
  tee.linkedWalletId = "lw_test"
  tee.tee = {
    network: "solana-mainnet",
    lifecycle: "enabled",
    vaultDestination: cold,
    remoteAuthority: "verified-active",
    destinationExposureAccepted: true,
    boundKeyPrefix: "ck_live_test",
    grantIdentity: { account: "TestAccount", apiBaseUrl: "https://api.test", source: "recorded-at-operation" },
    ...(opts.sweepPending ? { sweepPending: [{ signature: "PendingSweepSig", mint: null }] } : {}),
  }
  await commitVault(opened, { index: opened.index }, testClock)
  closeVault(opened)
  output.text = ""
  errors.text = ""
  events.length = 0
  const setupCalls = calls.length
  const signingPromptsAtSetup = signingPrompts
  return {
    deps,
    output,
    errors,
    sent,
    events,
    cold,
    teeAddress,
    path: made.path,
    get signingPrompts() {
      return signingPrompts - signingPromptsAtSetup
    },
    apiCalls: (path: string) => calls.slice(setupCalls).filter((call) => new URL(call.url).pathname === path),
    transfer: (from: string, asset = "SOL", extra: string[] = []) =>
      run(
        [
          "vault",
          "transfer",
          DESTINATION,
          "--from",
          from,
          "--amount",
          "0.1",
          "--asset",
          asset,
          "--rpc-url",
          RPC,
          ...extra,
        ],
        deps,
      ),
  }
}

describe("BE-326: vault transfer from a promoted wallet", () => {
  test("signs and broadcasts a SOL transfer by label, with the vault key's prompts and last-six", async () => {
    const f = await fixture()
    expect(await f.transfer("desk")).toBe(0)
    expect(f.sent).toHaveLength(1)
    const tx = f.sent[0]!
    expect(tx.feePayer?.toBase58()).toBe(f.teeAddress)
    const ix = tx.instructions[0]!
    expect(ix.programId.equals(SystemProgram.programId)).toBe(true)
    expect(ix.keys[1]?.pubkey.toBase58()).toBe(DESTINATION)
    // The factor a second time, then the broadcast: the same sequence a vault key goes through.
    expect(f.signingPrompts).toBe(1)
    expect(f.events.filter((e) => !e.startsWith("last-six"))).toEqual(["factor", "broadcast"])
    expect(f.output.text).toContain(`fee payer   ${f.teeAddress}`)
    expect(f.output.text).toContain(`Transferred 0.1 SOL to ${DESTINATION}: ${base58.encode(tx.signature!)}`)
  })

  test("signs an SPL TransferChecked with idempotent ATA creation", async () => {
    const f = await fixture()
    expect(await f.transfer("desk", "USDC")).toBe(0)
    const tx = f.sent[0]!
    expect(tx.feePayer?.toBase58()).toBe(f.teeAddress)
    const [create, transfer] = tx.instructions
    expect(create?.data[0]).toBe(1) // CreateIdempotent
    const mint = new PublicKey(USDC_MINT)
    expect(transfer?.programId.toBase58()).toBe(TOKEN_PROGRAM_ID)
    expect(transfer?.data[0]).toBe(12) // TransferChecked
    expect(transfer?.keys[0]?.pubkey.toBase58()).toBe(
      getAssociatedTokenAddressSync(mint, new PublicKey(f.teeAddress)).toBase58(),
    )
    expect(transfer?.keys[2]?.pubkey.toBase58()).toBe(
      getAssociatedTokenAddressSync(mint, new PublicKey(DESTINATION)).toBase58(),
    )
    expect(transfer?.keys[3]?.pubkey.toBase58()).toBe(f.teeAddress)
  })

  test("an enabled wallet is warned about before the confirmation, and the transfer proceeds", async () => {
    const f = await fixture()
    expect(await f.transfer("desk")).toBe(0)
    const lastSix = f.events.find((e) => e.startsWith("last-six"))!
    expect(lastSix).toContain("an agent may be trading it now")
    expect(f.apiCalls(LIFECYCLE)).toHaveLength(1)
  })

  test("a wallet that is not enabled is not warned about", async () => {
    const f = await fixture({ lifecycle: () => jsonResponse(200, { success: true, state: "quarantined" }) })
    expect(await f.transfer("desk")).toBe(0)
    expect(f.output.text).not.toContain("agent may be trading")
  })

  test("an unreadable state is reported and does not block", async () => {
    const f = await fixture({ lifecycle: () => jsonResponse(503, { error: "down" }) })
    expect(await f.transfer("desk")).toBe(0)
    const lastSix = f.events.find((e) => e.startsWith("last-six"))!
    expect(lastSix).toContain("Could not read this wallet's Candle state")
    expect(f.sent).toHaveLength(1)
  })

  test("a pending sweep refuses before any read, prompt or signature", async () => {
    const f = await fixture({ sweepPending: true })
    expect(await f.transfer("desk", "SOL", ["--json"])).toBe(1)
    expect(lastJson(f.output.text)).toMatchObject({ ok: false, code: "TRANSFER_SWEEP_PENDING" })
    expect(f.sent).toHaveLength(0)
    expect(f.signingPrompts).toBe(0)
    expect(f.events).toEqual([])
    expect(f.apiCalls(LIFECYCLE)).toHaveLength(0)
  })

  test("the finalized transfer is reported with the key; --json carries the outcome", async () => {
    const f = await fixture()
    expect(await f.transfer("desk", "SOL", ["--json"])).toBe(0)
    const reports = f.apiCalls(REPORT)
    expect(reports).toHaveLength(1)
    const signature = base58.encode(f.sent[0]!.signature!)
    expect(JSON.parse(String(reports[0]!.init.body))).toEqual({ chain: "solana", signature })
    const body = lastJson(f.output.text)
    expect(body).toMatchObject({ ok: true, signature, from: f.teeAddress, activityReport: "reported" })
    // Stdout is one JSON value; the human lines went to stderr.
    expect(f.errors.text).toContain("Reported to Candle's history.")
  })

  test("a key without activity:write skips the report with a message and exits 0", async () => {
    const f = await fixture({
      report: () =>
        jsonResponse(403, {
          success: false,
          error: { code: "SCOPE_MISSING", message: "This key lacks the activity:write scope" },
        }),
    })
    expect(await f.transfer("desk")).toBe(0)
    expect(f.output.text).toContain("lacks activity:write, so Candle's history will not show this transfer.")
  })

  test("a report failure does not change the exit code", async () => {
    const f = await fixture({ report: () => jsonResponse(500, { error: "boom" }) })
    expect(await f.transfer("desk")).toBe(0)
    expect(f.output.text).toContain("Could not report this transfer")
  })

  test("with no API key, neither read nor report is attempted and both are said", async () => {
    const f = await fixture({ apiKey: false })
    expect(await f.transfer("desk")).toBe(0)
    expect(f.apiCalls(LIFECYCLE)).toHaveLength(0)
    expect(f.apiCalls(REPORT)).toHaveLength(0)
    expect(f.output.text).toContain("Could not read this wallet's Candle state (no API key for this profile)")
    expect(f.output.text).toContain("No API key for this profile, so Candle's history will not show this transfer.")
  })

  test("the entry keeps its role, binding, lifecycle and exposure", async () => {
    const f = await fixture()
    const before = await reopen(f.path)
    const entryBefore = JSON.stringify(before.index.entries.find((e) => e.address === f.teeAddress))
    closeVault(before)
    expect(await f.transfer("desk")).toBe(0)
    const after = await reopen(f.path)
    try {
      expect(JSON.stringify(after.index.entries.find((e) => e.address === f.teeAddress))).toBe(entryBefore)
    } finally {
      closeVault(after)
    }
  })

  test("a vault key's transfer makes no lifecycle read and no report", async () => {
    const f = await fixture()
    expect(await f.transfer("cold", "SOL", ["--json"])).toBe(0)
    expect(f.sent[0]?.feePayer?.toBase58()).toBe(f.cold)
    expect(f.apiCalls(LIFECYCLE)).toHaveLength(0)
    expect(f.apiCalls(REPORT)).toHaveLength(0)
    expect(lastJson(f.output.text)).not.toHaveProperty("activityReport")
    expect(f.errors.text).not.toContain("Candle's history")
    expect(f.errors.text).not.toContain("Candle state")
  })
})
