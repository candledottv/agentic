/**
 * Ember Phase 4b-1 (BE-392, spec D5 and D6): `candle tee status <0x address>` shows ETH, USDG,
 * the reserve, and `gas: low` when ETH is under twice the reserve. No vault on this machine (an
 * agent machine): the wallet is found through the bound key and read over the EVM endpoint.
 * The vault branch (an EVM key that is not a TEE wallet is refused before any request) is E12 in
 * `vault-solana-only.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evmAddressFromSecret, hexToBytes } from "../evm-lite"
import { run } from "../index"
import { createCapture, createFakeStore, createTestDeps } from "../test-support"

const wallet = evmAddressFromSecret(hexToBytes(`0x${"44".repeat(32)}`))
const EVM_RPC = "https://hood.test/rpc"
const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(opts: { ethWei: bigint; bound?: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), "candle-tee-status-evm-"))
  folders.push(dir)
  const calls: string[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push(url)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (url.startsWith(EVM_RPC)) {
      const result =
        body.method === "eth_getBalance"
          ? `0x${opts.ethWei.toString(16)}`
          : body.method === "eth_call"
            ? `0x${2_500_000n.toString(16).padStart(64, "0")}`
            : body.method === "eth_feeHistory"
              ? { baseFeePerGas: ["0x3b9aca00", "0x3b9aca00"], reward: [["0x0"]] }
              : "0xf4240"
      return Response.json({ jsonrpc: "2.0", id: body.id, result })
    }
    const path = new URL(url).pathname
    if (path === "/api/v1/agent/wallets/trading")
      return Response.json({
        scopes: ["swap:write"],
        privyAppId: "app",
        page:
          opts.bound === false
            ? []
            : [
                {
                  id: "hood-tee",
                  address: wallet.toLowerCase(),
                  label: "hood",
                  chain: "evm",
                  active: true,
                  allowLaunch: false,
                },
              ],
        isDone: true,
      })
    if (path === "/api/v1/agent/wallets/hood-tee/lifecycle")
      return Response.json({ state: "verified-active", remoteAuthority: "enabled" })
    throw new Error(`Unexpected ${url}`)
  }) as typeof fetch
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    fetch: fetcher,
    env: { CANDLE_CONFIG_DIR: dir, CANDLE_API_KEY: "bound-key", CANDLE_EVM_RPC_URL: EVM_RPC },
    store: createFakeStore({}),
    stdout,
    stderr,
  })
  return { deps, stdout, stderr, calls }
}

// maxFeePerGas = 2 x 1 gwei + 0.001 gwei; reserve = (65k x 3 + 21k) gas x that fee x 2.
const RESERVE_WEI = (65_000n * 3n + 21_000n) * 2_001_000_000n * 2n

describe("tee status on a Hood TEE wallet (D5)", () => {
  test("shows ETH, USDG, the reserve and gas ok, with the server's state through the bound key", async () => {
    const f = await fixture({ ethWei: 10n ** 18n })
    expect(await run(["tee", "status", wallet, "--json"], f.deps)).toBe(0)
    const report = JSON.parse(f.stdout.text)
    expect(report).toMatchObject({
      address: wallet,
      chain: "hood",
      source: "server",
      linkedWalletId: "hood-tee",
      server: { state: "verified-active" },
      balances: { eth: "1", usdg: "2.5" },
      reserve: { wei: RESERVE_WEI.toString(), erc20Transfers: 3 },
      gas: "ok",
    })
    expect(report.fund).toBeUndefined()
    expect(f.stderr.text).toContain("from hood.test")
    expect(f.stderr.text).not.toContain(EVM_RPC)
  })

  test("gas: low when ETH is under twice the reserve, with the vault fund command for the top-up", async () => {
    const eth = RESERVE_WEI * 2n - 1n
    const f = await fixture({ ethWei: eth })
    expect(await run(["tee", "status", wallet], f.deps)).toBe(0)
    expect(f.stdout.text).toContain("gas: low")
    expect(f.stdout.text).toContain(`candle vault fund ${wallet} --amount 0.000000000000000001 --asset ETH`)
    expect(f.stdout.text).toContain("USDG          2.5")
    expect(f.stdout.text).toContain("reserve       at least")
  })

  test("exactly twice the reserve is not low", async () => {
    const f = await fixture({ ethWei: RESERVE_WEI * 2n })
    expect(await run(["tee", "status", wallet, "--json"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text).gas).toBe("ok")
  })

  test("a wallet not bound to this key still reports the chain, and says the server has no record", async () => {
    const f = await fixture({ ethWei: 10n ** 18n, bound: false })
    expect(await run(["tee", "status", wallet, "--json"], f.deps)).toBe(0)
    const report = JSON.parse(f.stdout.text)
    expect(report.server).toEqual({ error: "not a TEE wallet on this key" })
    expect(report.gas).toBe("ok")
  })

  test("a malformed 0x address is a usage error before any request", async () => {
    const f = await fixture({ ethWei: 0n })
    expect(await run(["tee", "status", `0x${"aB".repeat(20)}`, "--json"], f.deps)).toBe(2)
    expect(f.calls).toEqual([])
  })
})
