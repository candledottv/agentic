/**
 * Agent-stream card S: `candle launch --hide` rides the shared launch definition. The body carries
 * `hide: true` only when asked, and a build or dry run without the API's echo is never signed.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Keypair } from "@solana/web3.js"
import { run } from "../index"
import { pemToStoredSigner } from "../secret-store"
import { createCapture, createFakeStore, createTestDeps } from "../test-support"

const WALLET = Keypair.generate().publicKey.toBase58()

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(server: { echo?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "candle-hide-"))
  folders.push(dir)
  const calls: { path: string; body: Record<string, unknown> | undefined }[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    calls.push({ path, body })
    const ok = (value: unknown, status = 200) => Response.json(value, { status })
    if (path === "/api/v1/agent/wallets/trading")
      return ok({
        scopes: ["launch:write", "swap:write", "launch:read"],
        privyAppId: "app",
        page: [
          {
            id: "wallet",
            address: WALLET,
            label: "tee",
            chain: "solana",
            active: true,
            allowLaunch: true,
            privyWalletId: "privy",
          },
        ],
        isDone: true,
      })
    if (path === "/api/v1/launch/self/dry-run")
      return ok({
        success: true,
        dryRun: true,
        launchWallet: WALLET,
        // The API echoes the resolved fee wallet (feeWalletEcho); the default is the account's.
        feeWallet: WALLET,
        ...(server.echo && body.hide === true ? { hide: true } : {}),
      })
    if (path === "/api/v1/launch/self/build") return ok({ success: true, built: true })
    if (path.startsWith("/api/v1/launch/headless/jobs/"))
      return ok({ error: { code: "JOB_NOT_FOUND", message: "not found" } }, 404)
    throw new Error(`Unexpected ${path}`)
  }) as typeof fetch
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    fetch: fetcher,
    env: {
      CANDLE_CONFIG_DIR: dir,
      CANDLE_API_KEY: "bound-key",
      CANDLE_SOLANA_RPC_URL: "http://localhost/rpc",
    },
    stdout,
    stderr,
    store: createFakeStore({
      wallet_signer_wallet: pemToStoredSigner(
        generateKeyPairSync("ec", { namedCurve: "P-256" })
          .privateKey.export({ type: "pkcs8", format: "pem" })
          .toString(),
      ),
    }),
    promptLine: async () => "y",
  })
  return { deps, calls, stdout, stderr, paths: () => calls.map((call) => call.path) }
}

const launchArgs = [
  "launch",
  "--name",
  "Fee Wallet Token",
  "--symbol",
  "FWT",
  "--image-url",
  "https://example.test/image.png",
  "--wallet",
  "tee",
  "--client-trade-id",
  "launch-1",
  "--yes",
  "--json",
]

describe("candle launch --hide", () => {
  test("the flag reaches the dry run body, which the API echoes", async () => {
    const f = await fixture({ echo: true })
    expect(await run([...launchArgs, "--hide", "--dry-run"], f.deps)).toBe(0)
    expect(f.calls.find((c) => c.path === "/api/v1/launch/self/dry-run")?.body?.hide).toBe(true)
  })

  test("a dry run without the echo fails closed", async () => {
    const f = await fixture({ echo: false })
    expect(await run([...launchArgs, "--hide", "--dry-run"], f.deps)).not.toBe(0)
    expect(f.stderr.text + f.stdout.text).toContain("HIDE_NOT_CONFIRMED")
  })

  test("a build without the echo is never signed", async () => {
    const f = await fixture({ echo: false })
    expect(await run([...launchArgs, "--hide"], f.deps)).not.toBe(0)
    expect(f.stderr.text + f.stdout.text).toContain("HIDE_NOT_CONFIRMED")
  })

  test("no body carries the word hide when the flag is absent", async () => {
    const f = await fixture({ echo: true })
    await run(launchArgs, f.deps)
    await run([...launchArgs, "--dry-run"], (await fixture({ echo: true })).deps)
    for (const call of f.calls) expect(JSON.stringify(call.body ?? {})).not.toContain("hide")
  })
})
