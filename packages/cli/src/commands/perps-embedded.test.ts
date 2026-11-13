import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CANDLE_HYPERLIQUID_BUILDER_ADDRESS as BUILDER,
  hyperliquidActionHash,
  hyperliquidL1TypedData,
} from "../hyperliquid"
import { run } from "../index"
import { createCapture, createFakeStore, createTestDeps } from "../test-support"

const ADDRESS = `0x${"1".repeat(40)}`
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture(lose: boolean | "build" = false) {
  const dir = await mkdtemp(join(tmpdir(), "perps-embedded-"))
  dirs.push(dir)
  const calls: { url: string; body?: Record<string, unknown> }[] = []
  const stdout = createCapture(),
    stderr = createCapture()
  const fetcher = (async (input, init) => {
    const url = String(input),
      body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, body })
    if (url.includes("/wallets/embedded"))
      return Response.json({ wallets: { evm: { address: ADDRESS } }, embeddedWalletPermission: "allowed" })
    if (url.endsWith("/perps/open")) {
      if (lose === "build") throw new Error("lost build answer")
      const nonce = Date.now(),
        action = {
          type: "order",
          orders: [{ a: 0, b: true, p: "60600", s: "0.01", r: false, t: { limit: { tif: "Ioc" } }, c: body.clientId }],
          grouping: "na",
          builder: { b: BUILDER, f: 100 },
        }
      return Response.json({
        success: true,
        walletId: "embedded",
        signer: "embedded",
        address: ADDRESS,
        kind: "open",
        network: "mainnet",
        perpOrderId: "order-1",
        clientId: body.clientId,
        cloid: body.clientId,
        nonce,
        action,
        typedData: hyperliquidL1TypedData(hyperliquidActionHash(action, nonce), "mainnet"),
        signature: { r: `0x${"a".repeat(64)}`, s: `0x${"b".repeat(64)}`, v: 27 },
        preview: {},
      })
    }
    if (url.endsWith("/info"))
      return Response.json([{ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] }, [{ midPx: "60000" }]])
    if (url.endsWith("/exchange")) {
      if (lose) throw new Error("lost response")
      return Response.json({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 1 } }] } } })
    }
    throw new Error(`Unexpected ${url}`)
  }) as typeof fetch
  return {
    calls,
    stdout,
    stderr,
    deps: createTestDeps({
      fetch: fetcher,
      env: { CANDLE_CONFIG_DIR: dir, CANDLE_API_KEY: "bound-key" },
      store: createFakeStore(),
      stdout,
      stderr,
    }),
  }
}
test("embedded open generates a client id and skips local/relay signing", async () => {
  const f = await fixture()
  expect({
    code: await run(["perps", "open", "BTC", "long", "0.01", "--wallet", "embedded", "--yes", "--json"], f.deps),
    output: f.stdout.text,
    errors: f.stderr.text,
  }).toMatchObject({ code: 0 })
  expect(f.calls.some((c) => c.url.endsWith("/sign"))).toBe(false)
  expect(f.calls.find((c) => c.url.endsWith("/perps/open"))?.body?.clientId).toMatch(/^0x[0-9a-f]{32}$/)
  expect(JSON.parse(f.stdout.text).signature).toBeDefined()
})
test("embedded lost build answer exits 3 with its generated id for a safe same-id retry", async () => {
  const f = await fixture("build")
  expect(await run(["perps", "open", "BTC", "long", "0.01", "--wallet", "embedded", "--yes", "--json"], f.deps)).toBe(3)
  const answer = JSON.parse(f.stdout.text || f.stderr.text)
  expect(JSON.stringify(answer)).toContain("PERPS_MAYBE_LANDED")
  expect(JSON.stringify(answer)).toContain(String(f.calls.find((c) => c.url.endsWith("/perps/open"))?.body?.clientId))
})
test("embedded maybe-landed exits 3 and retains client id and signed exchange body", async () => {
  const f = await fixture(true)
  expect({
    code: await run(["perps", "open", "BTC", "long", "0.01", "--wallet", "embedded", "--yes", "--json"], f.deps),
    output: f.stdout.text,
    errors: f.stderr.text,
  }).toMatchObject({ code: 3 })
  const error = JSON.parse(f.stdout.text || f.stderr.text)
  expect(JSON.stringify(error)).toContain("clientId")
  expect(JSON.stringify(error)).toContain("exchangeBody")
})
