/**
 * Ember Phase 4a (BE-350, spec `2026-09-24-ember-phase-4a-evm-vault-keys-design.md`, §6), E11:
 * one native and one USDG transfer against a local Anvil fork of Hood. Opt-in and not in CI, on
 * the `signed-e2e` pattern: the whole file skips unless `CANDLE_EVM_E2E_RPC_URL` names a running
 * fork, and it is run by hand before merge (spec §8).
 *
 *   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --port 8545
 *   CANDLE_EVM_E2E_RPC_URL=http://127.0.0.1:8545 bun test src/evm-anvil.e2e.test.ts
 *
 * Anvil's `anvil_setBalance` funds the fixture root's EVM index 0 with ETH, and
 * `anvil_setStorageAt` is not relied on for USDG: the USDG leg funds the key by impersonating a
 * holder found through `CANDLE_EVM_E2E_USDG_HOLDER` (an address on Hood that holds USDG), through
 * `anvil_impersonateAccount`. Without that variable the USDG leg is skipped and says so.
 *
 * Every assertion runs through the real `vault transfer` command with the real prompts scripted,
 * so what is exercised is the shipped flow against a real EVM node: `eth_chainId` answers 4663,
 * the fee history is real, the estimate is real, and the receipt is a real receipt.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { FIXTURE_EVM_0 } from "./evm-lite.test"
import { run } from "./index"
import { createCapture, createTestDeps } from "./test-support"
import { closeVault } from "./vault/store"
import { makeVault, useCheapKdf } from "./vault/test-vault"

const RPC = process.env.CANDLE_EVM_E2E_RPC_URL
const USDG_HOLDER = process.env.CANDLE_EVM_E2E_USDG_HOLDER
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168"
const DESTINATION = "0x000000000000000000000000000000000000dEaD"

setDefaultTimeout(180_000)
useCheapKdf()

async function anvil(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC as string, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const json = (await res.json()) as { result?: unknown; error?: { message?: string } }
  if (json.error) throw new Error(`${method}: ${json.error.message}`)
  return json.result
}

async function fixture() {
  const made = await makeVault()
  closeVault(made.vault)
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    fetch,
    stdout,
    stderr,
    env: { CANDLE_CONFIG_DIR: made.dir, HOME: made.dir, CANDLE_EVM_RPC_URL: RPC as string },
    isTTY: { stdin: true, stdout: true, stderr: true },
    promptSecret: async () => made.passphrase,
    promptLine: async (prompt) => {
      const match = /\(([^)]+)\) to confirm/.exec(prompt)
      return (match?.[1] ?? "").slice(-6)
    },
  })
  expect(await run(["vault", "new-key", "--chain", "evm", "--label", "hood-cold"], deps)).toBe(0)
  stdout.text = ""
  return { deps, stdout, stderr }
}

function lastJson(text: string): Record<string, unknown> {
  return JSON.parse(text.trimEnd().split("\n").at(-1) ?? "")
}

describe.skipIf(RPC === undefined)("E11: a native and a USDG transfer against an Anvil fork of Hood", () => {
  test("the fork is Hood", async () => {
    expect(await anvil("eth_chainId", [])).toBe("0x1237")
  })

  test("native: 0.01 ETH from the fixture key lands, depth-confirmed, exit 0", async () => {
    await anvil("anvil_setBalance", [FIXTURE_EVM_0, "0xde0b6b3a7640000"]) // 1 ETH
    const fx = await fixture()
    const code = await run(
      ["vault", "transfer", DESTINATION, "--amount", "0.01", "--asset", "ETH", "--from", "hood-cold", "--json"],
      fx.deps,
    )
    // Anvil mines on demand, so the receipt is in the head block and depth 1 is met at once.
    expect(code).toBe(0)
    const body = lastJson(fx.stdout.text)
    expect(body).toMatchObject({ ok: true, chainId: 4663, status: "confirmed", depth: 1, finalized: false })
    const receipt = (await anvil("eth_getTransactionReceipt", [body.hash])) as { status: string }
    expect(receipt.status).toBe("0x1")
  })

  test.skipIf(USDG_HOLDER === undefined)(
    "USDG: 0.5 USDG from the fixture key lands through transfer(address,uint256)",
    async () => {
      await anvil("anvil_setBalance", [FIXTURE_EVM_0, "0xde0b6b3a7640000"])
      await anvil("anvil_setBalance", [USDG_HOLDER, "0xde0b6b3a7640000"])
      await anvil("anvil_impersonateAccount", [USDG_HOLDER])
      // transfer(fixture, 1_000_000) from the holder: 1 USDG to the fixture key.
      const data = `0xa9059cbb${(FIXTURE_EVM_0.slice(2)).padStart(64, "0")}${(1_000_000).toString(16).padStart(64, "0")}`
      await anvil("eth_sendTransaction", [{ from: USDG_HOLDER, to: USDG, data }])
      await anvil("anvil_stopImpersonatingAccount", [USDG_HOLDER])
      const fx = await fixture()
      const code = await run(
        ["vault", "transfer", DESTINATION, "--amount", "0.5", "--asset", "USDG", "--from", "hood-cold", "--json"],
        fx.deps,
      )
      expect(code).toBe(0)
      expect(lastJson(fx.stdout.text)).toMatchObject({
        ok: true,
        status: "confirmed",
        asset: "USDG",
        amountRaw: "500000",
      })
    },
  )
})
