/** `candle fees` and `candle fees claim` (FE-438), driven through `run()` against a stub server. */
import { describe, expect, test } from "bun:test"
import { generateKeyPairSync, verify } from "node:crypto"
import { run } from "../index"
import { pemToStoredSigner } from "../secret-store"
import { createCapture, createFakeStore, createTestDeps } from "../test-support"

const SOL = { symbol: "SOL", mint: "So11111111111111111111111111111111111111112", decimals: 9, amountRaw: "1500000000" }

function fixture(answers: Record<string, () => Response>) {
  const calls: { path: string; method: string; body: Record<string, unknown> | undefined }[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({
      path: `${url.pathname}${url.search}`,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    const answer = answers[url.pathname]
    if (!answer) throw new Error(`Unexpected ${url.pathname}`)
    return answer()
  }) as typeof fetch
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({ fetch: fetcher, env: { CANDLE_API_KEY: "main-key" }, stdout, stderr })
  return { deps, calls, stdout, stderr }
}

describe("candle fees (FE-438)", () => {
  test("lists tokens with their amounts and reasons, and the next page's cursor", async () => {
    const f = fixture({
      "/api/v1/agent/fees": () =>
        Response.json({
          success: true,
          page: [
            {
              mint: "MintA",
              chain: "solana",
              symbol: "AAA",
              recipient: "W1",
              claimableAmounts: [SOL],
              claimable: true,
              reason: "claimable_by_key",
            },
            {
              mint: "MintB",
              chain: "hood",
              symbol: "BBB",
              recipient: "W2",
              claimableAmounts: [],
              claimable: false,
              reason: "below_dust",
            },
            {
              mint: "MintC",
              chain: "solana",
              symbol: "CCC",
              recipient: "W3",
              claimableAmounts: [SOL],
              claimable: false,
              reason: "claimable_via_web_session",
              note: "a signed-in web session claims them",
            },
          ],
          isDone: false,
          continueCursor: "next1",
        }),
    })
    expect(await run(["fees", "--limit", "2"], f.deps)).toBe(0)
    expect(f.calls[0]).toMatchObject({ path: "/api/v1/agent/fees?limit=2", method: "GET" })
    expect(f.stdout.text).toContain("claimable by this key: 1.5 SOL")
    expect(f.stdout.text).toContain("not claimable: under the dust floor")
    expect(f.stdout.text).toContain("not claimable: the fees go to this account's web wallet")
    expect(f.stdout.text).toContain("More: candle fees --cursor next1")
  })

  test("--json prints the server's answer as sent", async () => {
    const body = { success: true, page: [], isDone: true, continueCursor: null }
    const f = fixture({ "/api/v1/agent/fees": () => Response.json(body) })
    expect(await run(["fees", "--json"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text)).toEqual(body)
  })

  test("a limit outside 1 to 50 is a usage error and sends nothing", async () => {
    const f = fixture({})
    expect(await run(["fees", "--limit", "51"], f.deps)).toBe(2)
    expect(f.calls).toEqual([])
  })
})

describe("candle fees claim (FE-438)", () => {
  const PATH = "/api/v1/agent/fees/MintA/claim"

  test("--dry-run posts dryRun true and says nothing was sent", async () => {
    const f = fixture({
      [PATH]: () =>
        Response.json({
          success: true,
          mint: "MintA",
          chain: "solana",
          dryRun: true,
          recipient: "W1",
          claimable: true,
          claimed: [{ ...SOL, txHash: null }],
          remaining: [],
        }),
    })
    expect(await run(["fees", "claim", "MintA", "--dry-run"], f.deps)).toBe(0)
    expect(f.calls[0]).toEqual({ path: PATH, method: "POST", body: { dryRun: true, teeSigning: true } })
    expect(f.stdout.text).toContain("Dry run")
    expect(f.stdout.text).toContain("1.5 SOL")
    expect(f.stdout.text).toContain("W1")
    expect(f.stdout.text).toContain("Nothing was sent.")
  })

  test("a real claim posts dryRun false and prints the transaction and what remains", async () => {
    const f = fixture({
      [PATH]: () =>
        Response.json({
          success: true,
          mint: "MintA",
          chain: "solana",
          dryRun: false,
          recipient: "W1",
          claimed: [{ ...SOL, txHash: "Sig1" }],
          remaining: [{ ...SOL, amountRaw: "1" }],
          warnings: ["a leg failed"],
        }),
    })
    expect(await run(["fees", "claim", "MintA"], f.deps)).toBe(0)
    expect(f.calls[0]?.body).toEqual({ dryRun: false, teeSigning: true })
    expect(f.stdout.text).toContain("Claimed")
    expect(f.stdout.text).toContain("1.5 SOL")
    expect(f.stdout.text).toContain("W1")
    expect(f.stdout.text).toContain("Sig1")
    expect(f.stdout.text).toContain("0.000000001 SOL")
    expect(f.stderr.text).toContain("a leg failed")
  })

  test("a LAUNCH_DISABLED 503 answer exits 1", async () => {
    const f = fixture({
      [PATH]: () =>
        Response.json({ success: false, error: { code: "LAUNCH_DISABLED", message: "off" } }, { status: 503 }),
    })
    expect(await run(["fees", "claim", "MintA", "--json"], f.deps)).toBe(1)
    expect(f.stderr.text + f.stdout.text).toContain("LAUNCH_DISABLED")
  })

  test("no mint, or a destination argument, is a usage error and sends nothing", async () => {
    const f = fixture({})
    expect(await run(["fees", "claim"], f.deps)).toBe(2)
    expect(await run(["fees", "claim", "MintA", "--to", "Elsewhere"], f.deps)).toBe(2)
    expect(f.calls).toEqual([])
  })
})

describe("BE-2579 CLI fee claim signing", () => {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  const rpc = { method: "signTransaction", params: { encoding: "base64", transaction: "dHg=" } }
  function teeFixture(altered = false) {
    const PATH = "/api/v1/agent/fees/MintA/claim"
    const f = fixture({
      [PATH]: () =>
        Response.json({
          success: true,
          claimed: [],
          signing: [
            { walletId: "tee", wallet: "TeeAddress", leg: "streamer", body: altered ? { ...rpc, extra: true } : rpc },
          ],
        }),
      "/api/v1/agent/wallets/trading": () =>
        Response.json({
          scopes: ["launch:write"],
          privyAppId: "app",
          page: [
            {
              id: "tee",
              address: "TeeAddress",
              chain: "solana",
              active: true,
              allowLaunch: false,
              privyWalletId: "privy",
            },
          ],
          isDone: true,
        }),
      "/api/v1/agent/wallets/tee/sign": () =>
        Response.json({ success: true, signedTransaction: "c2lnbmVk", encoding: "base64" }),
      [`${PATH}/submit`]: () =>
        Response.json({
          success: true,
          recipient: "TeeAddress",
          claimed: [{ ...SOL, txHash: "TeeSig" }],
          remaining: [],
          warnings: [],
        }),
    })
    f.deps.store = createFakeStore({ wallet_signer_tee: pemToStoredSigner(pem) })
    return f
  }
  test("claim authorizes the exact RPC body locally, relays and submits without requiring allowLaunch", async () => {
    const f = teeFixture()
    expect(await run(["fees", "claim", "MintA", "--json"], f.deps)).toBe(0)
    const signed = f.calls.find((call) => call.path.endsWith("/sign"))?.body
    expect(signed?.body).toEqual(rpc)
    expect(signed?.feeClaim).toBe(true)
    const canonical = JSON.stringify({
      body: rpc,
      headers: { "privy-app-id": "app" },
      method: "POST",
      url: "https://api.privy.io/v1/wallets/privy/rpc",
      version: 1,
    })
    expect(
      verify(
        "sha256",
        Buffer.from(canonical),
        pair.publicKey,
        Buffer.from(String(signed?.authorizationSignature), "base64"),
      ),
    ).toBe(true)
    expect(f.calls.at(-1)?.body).toEqual({
      signedClaims: [{ walletId: "tee", leg: "streamer", signedTransaction: "c2lnbmVk" }],
    })
    expect(JSON.parse(f.stdout.text).claimed[0].txHash).toBe("TeeSig")
    expect(f.stdout.text).not.toContain("PRIVATE KEY")
  })
  test("an altered RPC body never reaches relay sign or submit", async () => {
    const f = teeFixture(true)
    expect(await run(["fees", "claim", "MintA", "--json"], f.deps)).toBe(1)
    expect(f.calls.some((call) => call.path.endsWith("/sign") || call.path.endsWith("/submit"))).toBe(false)
  })
})
