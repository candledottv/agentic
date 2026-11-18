import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FetchLike } from "./orchestrate"
import { executePerpsTransfer } from "./perps-transfer"

const ACCOUNT = "0x1111111111111111111111111111111111111111"
const cfg = { apiUrl: "https://api.test", apiKey: "cndl_live_key" }
const args = { clientTransferId: "move-1", mode: "toDex", dex: "xyz", amountUsdc: "5" }
let dir: string, pemFile: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "candle-transfer-"))
  pemFile = join(dir, "signer.pem")
  await writeFile(
    pemFile,
    generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  )
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})
function fixture() {
  const message = {
    hyperliquidChain: "Mainnet",
    destination: ACCOUNT,
    sourceDex: "",
    destinationDex: "xyz",
    token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
    amount: "5",
    fromSubAccount: "",
    nonce: 7,
  }
  return {
    id: "move-1",
    status: "built",
    mode: "toDex",
    dex: "xyz",
    nonce: 7,
    typedData: {
      domain: {
        name: "HyperliquidSignTransaction",
        version: "1",
        chainId: 42161,
        verifyingContract: `0x${"0".repeat(40)}`,
      },
      types: {
        "HyperliquidTransaction:SendAsset": Object.keys(message).map((name) => ({
          name,
          type: name === "nonce" ? "uint64" : "string",
        })),
      },
      primary_type: "HyperliquidTransaction:SendAsset",
      message,
    },
    action: { type: "sendAsset", signatureChainId: "0xa4b1", ...message },
  }
}
function fake(opts: { scopes?: readonly string[]; tamper?: boolean; refuse?: boolean; exchange?: unknown } = {}) {
  const calls: Array<{ url: string; body?: Record<string, unknown>; headers?: Record<string, string> }> = []
  const fetch: FetchLike = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, body, headers: init?.headers as Record<string, string> })
    const ok = (value: unknown, status = 200) => ({
      ok: status === 200,
      status,
      text: async () => JSON.stringify(value),
    })
    if (url.endsWith("/wallets/trading"))
      return ok({
        scopes: opts.scopes ?? ["perps:write"],
        privyAppId: "app",
        page: [{ id: "wallet", chain: "evm", address: ACCOUNT, privyWalletId: "pw" }],
      })
    if (url.endsWith("/perps/transfer")) {
      if (opts.refuse) return ok({ success: false, error: { code: "PERPS_TRANSFER_DEX_REFUSED" } }, 400)
      const build = fixture()
      if (opts.tamper) build.action.destination = "0x2222222222222222222222222222222222222222"
      return ok(build)
    }
    if (url.endsWith("/wallets/wallet/sign")) return ok({ signature: `0x${"11".repeat(65)}` })
    if (url === "https://api.hyperliquid.xyz/exchange")
      return ok(opts.exchange ?? { status: "ok", response: { type: "default" } })
    if (url.endsWith("/transfer/submitted")) return ok({ success: true, id: "move-1", status: "submitted" })
    throw new Error(`unexpected URL ${url}`)
  }
  return { fetch, calls }
}
describe("MCP own-wallet transfer", () => {
  test("build request, local check, relay, venue and acknowledgement preserve the contract", async () => {
    const f = fake()
    const result = await executePerpsTransfer(args, cfg, { CANDLE_KEY_SIGNER_PEM_FILE: pemFile }, f.fetch)
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.text)).toMatchObject({ id: "move-1", status: "submitted" })
    expect(f.calls.find((c) => c.url.endsWith("/perps/transfer"))!.body).toEqual({ ...args, walletId: "wallet" })
    const venue = f.calls.find((c) => c.url.endsWith("/exchange"))!
    expect(venue.body!.action).toEqual(fixture().action)
    expect(venue.headers).not.toHaveProperty("x-api-key")
    expect(f.calls.at(-1)!.body).toMatchObject({ clientTransferId: "move-1", exchangeResponse: { status: "ok" } })
  })
  test("submit false checks the build without signer or venue calls", async () => {
    const f = fake()
    expect((await executePerpsTransfer({ ...args, submit: false }, cfg, {}, f.fetch)).isError).toBeUndefined()
    expect(f.calls).toHaveLength(2)
  })
  test("wrong scope, foreign destination input, untrusted action, missing signer and API refusal never sign", async () => {
    for (const [input, opts, env, code] of [
      [args, { scopes: ["perps:withdraw"] }, {}, "SCOPE_MISSING"],
      [{ ...args, destination: ACCOUNT }, {}, {}, "MCP_VALIDATION"],
      [{ ...args, submit: false }, { tamper: true }, {}, "PERPS_BUILD_REFUSED"],
      [args, {}, {}, "SIGNER_UNAVAILABLE"],
      [{ ...args, submit: false }, { refuse: true }, {}, "PERPS_TRANSFER_DEX_REFUSED"],
    ] as const) {
      const f = fake(opts)
      const result = await executePerpsTransfer(input, cfg, env, f.fetch)
      expect(result.isError).toBe(true)
      expect(JSON.parse(result.text).error.code).toBe(code)
      expect(f.calls.some((c) => c.url.endsWith("/sign") || c.url.endsWith("/exchange"))).toBe(false)
    }
  })
  test("perps to spot (toSpot, fromSpot) is refused this release before any request", async () => {
    for (const input of [
      { clientTransferId: "spot-1", mode: "toSpot", amountUsdc: "1" },
      { clientTransferId: "spot-2", mode: "fromSpot", all: true },
    ]) {
      const f = fake()
      const result = await executePerpsTransfer(input, cfg, { CANDLE_KEY_SIGNER_PEM_FILE: pemFile }, f.fetch)
      expect(result.isError).toBe(true)
      expect(JSON.parse(result.text).error.code).toBe("MCP_VALIDATION")
      expect(f.calls).toHaveLength(0)
    }
  })
})
