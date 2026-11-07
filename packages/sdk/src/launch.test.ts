import { describe, expect, test } from "bun:test"
import { CandleClient, type LaunchRequest } from "./client"
import { CandleApiError } from "./errors"

const fields = { name: "A", symbol: "A", imageUrl: "https://example.com/a.png", clientLaunchId: "launch-1" }
const row = { id: "tee-1", privyWalletId: "privy-1", label: "spider-01", address: "Address1", chain: "solana" }
function fixture(responses: unknown[] = []) {
  const calls: { url: string; body?: Record<string, unknown> }[] = []
  const client = new CandleClient({
    apiUrl: "https://api.test",
    apiKey: "test-key",
    maxRetries: 0,
    fetch: (async (url, init) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return Response.json(responses.shift() ?? { success: true })
    }) as typeof fetch,
  })
  return { client, calls }
}

describe("launch request normalization", () => {
  test.each([
    ["sol", "solana", "0.1", 100000000],
    ["usdc", "solana", "1.000001", 1000001],
    ["cndl", "solana", "0.000001", 1],
    ["eth", "hood", "0.000000000000000001", "1"],
    ["usdg", "hood", "0.1", "100000"],
  ] as const)("%s converts whole-unit buy exactly", async (quoteAsset, chain, buy, buyAmount) => {
    const { client, calls } = fixture()
    await client.launch({ ...fields, chain, quoteAsset, buy, wallet: "embedded" })
    expect(calls[0]?.url).toEndWith("/launch/headless")
    expect(calls[0]?.body).toEqual({ ...fields, chain, quoteAsset, buyAmount })
  })

  test.each([undefined, "embedded", "main"])("%s preserves the legacy headless body", async (wallet) => {
    const { client, calls } = fixture()
    await client.launch({ ...fields, wallet })
    expect(calls[0]?.body).toEqual(fields)
  })

  test.each(["", " ", "0", "0.000", "0.0000000000000000000000000"])("buy %s sends no first buy", async (buy) => {
    const { client, calls } = fixture()
    await client.dryRunLaunch({ ...fields, buy })
    expect(calls[0]?.body).toEqual(fields)
  })

  test.each([
    { buy: "0.1", buyAmount: 1 },
    { wallet: "spider-01", linkedWalletId: "old-id" },
    { buy: "0.0000000001", quoteAsset: "sol" },
    { buy: "0.0000001", quoteAsset: "usdc" },
    { buy: "0.0000000001", quoteAsset: "cndl" },
    { buy: "0.0000000000000000001", quoteAsset: "eth" },
    { buy: "1e3" },
    { buy: "-1" },
    { buy: "9007199254740992" },
    { socials: { instagram: "https://example.com" } },
    { socials: { twitter: "@candle" } },
    { socials: { website: "javascript:alert(1)" } },
  ])("invalid input %j refuses before any request", async (extra) => {
    for (const method of ["launch", "dryRunLaunch", "launchAsync"] as const) {
      const { client, calls } = fixture()
      const error = await client[method]({ ...fields, ...extra } as LaunchRequest).catch((e) => e)
      expect(error).toBeInstanceOf(CandleApiError)
      expect(error.code).toBe("VALIDATION_FAILED")
      expect(calls).toHaveLength(0)
    }
  })

  test("the four socials pass unchanged", async () => {
    const socials = Object.fromEntries(
      ["website", "twitter", "telegram", "discord"].map((key) => [key, `https://example.com/${key}`]),
    )
    const { client, calls } = fixture()
    await client.launch({ ...fields, socials })
    expect(calls[0]?.body?.socials).toEqual(socials)
  })

  test("async embedded launch strips controls and converts buy", async () => {
    const { client, calls } = fixture()
    await client.launchAsync({ ...fields, wallet: "embedded", buy: "0.1" })
    expect(calls[0]?.body).toEqual({ ...fields, async: true, buyAmount: 100000000 })
  })
})

describe("TEE wallet discovery", () => {
  test.each(["spider-01", "tee-1", "Address1"])("%s resolves a wallet over every page", async (wallet) => {
    const { client, calls } = fixture([
      { page: [], isDone: false, continueCursor: "page-2" },
      { page: [row], isDone: true },
      { success: true, launchWallet: row.address, launchWalletId: row.id },
    ])
    await client.dryRunLaunch({ ...fields, wallet, buy: "0.1" })
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.test/api/v1/agent/wallets/trading",
      "https://api.test/api/v1/agent/wallets/trading?cursor=page-2",
      "https://api.test/api/v1/launch/self/dry-run",
    ])
    expect(calls[2]?.body).toEqual({ ...fields, chain: "solana", buyAmount: 100000000, linkedWalletId: row.id })
  })

  test.each([
    { page: [] },
    { page: [row, { ...row, id: "tee-2" }] },
  ])("missing or ambiguous wallets never build", async ({ page }) => {
    const { client, calls } = fixture([{ page, isDone: true }])
    const error = await client.launch({ ...fields, wallet: "spider-01" }).catch((e) => e)
    expect(error.code).toBe("TEE_WALLET_REQUIRED")
    if (page.length) expect(error.message).toContain("tee-2")
    expect(calls).toHaveLength(1)
  })

  test("a Hood wallet selects Hood and wei conversion", async () => {
    const { client, calls } = fixture([{ page: [{ ...row, chain: "evm" }], isDone: true }])
    await client.dryRunLaunch({ ...fields, wallet: "spider-01", buy: "0.1" })
    expect(calls[1]?.body).toEqual({
      ...fields,
      chain: "hood",
      linkedWalletId: row.id,
      buyAmount: "100000000000000000",
    })
  })

  test.each([{ chain: "hood" }, { quoteAsset: "eth" }])("a conflicting chain or quote never builds", async (extra) => {
    const { client, calls } = fixture([{ page: [row], isDone: true }])
    const error = await client.launch({ ...fields, wallet: "spider-01", ...extra } as LaunchRequest).catch((e) => e)
    expect(error.code).toBe("CHAIN_MISMATCH")
    expect(calls).toHaveLength(1)
  })

  test("explicit wallet identifiers need no discovery", async () => {
    const { client, calls } = fixture()
    await client.dryRunLaunch({ ...fields, wallet: { linkedWalletId: row.id, privyWalletId: row.privyWalletId } })
    expect(calls[0]?.url).toEndWith("/self/dry-run")
    expect(calls[0]?.body).toEqual({ ...fields, linkedWalletId: row.id })
  })
})

// BE-2794 (BE-2791 spec 7.1): LaunchRequest's launchRules is the API's nested object in seconds
// and raw units, sent as given; the dry run answers its resolved summary.
describe("launchRules and allowlistProof", () => {
  const launchRules = {
    openDelaySecs: 600,
    maxBuyPerWalletRaw: "10000000",
    capWindowSecs: 3600,
    allowlist: ["11111111111111111111111111111111"],
    allowlistWindowSecs: 1800,
    devBuyMaxRaw: "5000000",
  } satisfies LaunchRequest["launchRules"]

  test("launch and dry run send launchRules verbatim, and the dry run reads the summary", async () => {
    const summary = {
      openAt: "2026-11-06T12:10:00.000Z",
      capUntil: "2026-11-06T13:10:00.000Z",
      maxBuyPerWalletRaw: "10000000",
      allowlistUntil: "2026-11-06T12:40:00.000Z",
      allowlistRoot: "ab".repeat(32),
      allowlistSize: 1,
      devBuyer: "Embedded1",
      devBuyMaxRaw: "5000000",
      clusterTime: "2026-11-06T12:00:00.000Z",
    }
    const { client, calls } = fixture([{ success: true, dryRun: true, launchRules: summary }])
    const preview = await client.dryRunLaunch({ ...fields, launchRules })
    expect(calls[0]?.url).toEndWith("/launch/headless/dry-run")
    expect(calls[0]?.body).toEqual({ ...fields, launchRules })
    expect("launchRules" in preview ? preview.launchRules : undefined).toEqual(summary)
    await client.launch({ ...fields, launchRules })
    expect(calls[1]?.body).toEqual({ ...fields, launchRules })
  })

  test("allowlistProof reads the public proof route for one mint and wallet", async () => {
    const { client, calls } = fixture([{ allowlisted: true, root: "ab".repeat(32), proof: ["cd".repeat(32)] }])
    const proof = await client.allowlistProof("Mint1", "Wallet1")
    expect(calls[0]?.url).toBe("https://api.test/api/v1/launch/Mint1/allowlist-proof/Wallet1")
    expect(proof).toEqual({ allowlisted: true, root: "ab".repeat(32), proof: ["cd".repeat(32)] })
  })

  test("a pool with no allowlist is a 404 CandleApiError", async () => {
    const client = new CandleClient({
      apiUrl: "https://api.test",
      maxRetries: 0,
      fetch: (async () =>
        Response.json(
          { error: { code: "NOT_FOUND", message: "Not found" } },
          { status: 404 },
        )) as unknown as typeof fetch,
    })
    const error = await client.allowlistProof("Mint1", "Wallet1").catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CandleApiError)
    expect((error as CandleApiError).status).toBe(404)
  })
})
