/**
 * `candle wallet close-empty` (BE-418): preview, confirm, then close over the embedded-wallet
 * close routes, with nothing signed on this machine. Driven through `run()` against a stub server,
 * the same shape as transfer.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"
import { splitKeep } from "./wallets-close-empty"

const EMBEDDED = "9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL"
const TEE = "7ZL9FvkpCMgdvzfoMSYZSuCXLCYN25dfgtDXej1BBJaB"
const KEEP = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const KEEP_2 = "4Nd1mYvM6HqS8VqLFPzWx5W2sTQeXKZbLqBTdrBGTsGa"

const ACCOUNTS = [
  {
    account: "Acct1111111111111111111111111111111111111111",
    mint: "MintA",
    tokenProgram: "token-2022",
    lamports: "2074080",
  },
  {
    account: "Acct2222222222222222222222222222222222222222",
    mint: "MintB",
    tokenProgram: "spl-token",
    lamports: "2039280",
  },
]

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(
  opts: {
    prompt?: string
    tty?: boolean
    accounts?: typeof ACCOUNTS
    embedded?: string | null
    /** What the jobs route answers for a named id; absent is JOB_NOT_FOUND. */
    job?: Record<string, unknown>
    execute?: Record<string, unknown> | { error: { code: string; message: string } }
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "candle-close-empty-"))
  folders.push(dir)
  const calls: { path: string; body: Record<string, unknown> | undefined }[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path, body })
    const ok = (value: unknown) => Response.json(value)
    if (path === "/api/v1/agent/wallets/embedded")
      return ok({
        success: true,
        wallets: { solana: opts.embedded === null ? null : { address: opts.embedded ?? EMBEDDED }, evm: null },
      })
    if (path.startsWith("/api/v1/agent/wallets/embedded/close-empty/jobs/")) {
      if (!opts.job)
        return Response.json({ success: false, error: { code: "JOB_NOT_FOUND", message: "none" } }, { status: 404 })
      return ok({ success: true, job: opts.job })
    }
    if (path === "/api/v1/agent/wallets/embedded/close-empty/preview") {
      const accounts = opts.accounts ?? ACCOUNTS
      return ok({
        success: true,
        wallet: EMBEDDED,
        keep: body?.keep ?? [],
        accounts,
        accountCount: accounts.length,
        totalLamports: "4113360",
        totalSol: "0.00411336",
        transactions: accounts.length ? 1 : 0,
        estimatedFeeLamports: accounts.length ? "5000" : "0",
        netLamports: "4108360",
        netSol: "0.00410836",
        skipped: [
          { account: "Kept", mint: KEEP, tokenProgram: "spl-token", lamports: "2039280", reason: "kept" },
          {
            account: "Wsol",
            mint: "So11111111111111111111111111111111111111112",
            tokenProgram: "spl-token",
            lamports: "2039280",
            reason: "wrapped_sol",
          },
        ],
        undecodable: [],
        closesPerTransaction: 20,
        maxAccountsPerCall: 200,
      })
    }
    if (path === "/api/v1/agent/wallets/embedded/close-empty") {
      if (opts.execute && "error" in opts.execute)
        return Response.json({ success: false, error: opts.execute.error }, { status: 409 })
      return ok({
        success: true,
        status: "completed",
        clientTradeId: body?.clientTradeId,
        wallet: EMBEDDED,
        signatures: ["CloseSig1"],
        lamportsRecovered: "4113360",
        solRecovered: "0.00411336",
        ...(opts.execute ?? {}),
      })
    }
    throw new Error(`Unexpected ${path}`)
  }) as typeof fetch
  const stdout = createCapture()
  const stderr = createCapture()
  const tty = opts.tty ?? true
  const deps = createTestDeps({
    fetch: fetcher,
    env: { CANDLE_CONFIG_DIR: dir, CANDLE_API_KEY: "main-key" },
    stdout,
    stderr,
    isTTY: { stdin: tty, stdout: tty, stderr: tty },
    promptLine: async () => opts.prompt ?? "y",
  })
  return { deps, calls, stdout, stderr, paths: () => calls.map((call) => call.path) }
}

const EXECUTE = "/api/v1/agent/wallets/embedded/close-empty"
const PREVIEW = "/api/v1/agent/wallets/embedded/close-empty/preview"

describe("candle wallet close-empty (BE-418)", () => {
  test("previews, confirms, then closes exactly the previewed accounts under one id", async () => {
    const f = await fixture()
    const code = await run(["wallet", "close-empty", "--keep", KEEP, "--json"], f.deps)
    expect(code).toBe(0)
    // Under --json the preview and prompt go to stderr, and stdout is one JSON line.
    expect(f.stderr.text).toContain(`Close 2 empty token accounts on the embedded wallet ${EMBEDDED}`)
    expect(f.stderr.text).toContain("Rent returned to that same wallet: 0.00411336 SOL in 1 transaction")
    expect(f.stderr.text).toContain("network fee about 0.000005 SOL")
    expect(f.stderr.text).toContain("MintA  token-2022  0.00207408 SOL")
    expect(f.stderr.text).toContain("Left open: 1 kept by --keep, 1 wrapped SOL")
    expect(f.paths().filter((p) => p.includes("close-empty"))).toEqual([PREVIEW, EXECUTE])
    expect(f.calls.find((c) => c.path === PREVIEW)?.body).toEqual({ keep: [KEEP] })
    const execute = f.calls.find((c) => c.path === EXECUTE)?.body as Record<string, unknown>
    expect(execute.accounts).toEqual(ACCOUNTS.map((a) => a.account))
    expect(execute.keep).toEqual([KEEP])
    expect(String(execute.clientTradeId)).toMatch(/^close-[0-9a-f-]{36}$/)
    const lines = f.stdout.text.trim().split("\n")
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      success: true,
      status: "completed",
      signatures: ["CloseSig1"],
      clientTradeId: execute.clientTradeId,
    })
  })

  test("answering no closes nothing and reports cancelled", async () => {
    const f = await fixture({ prompt: "n" })
    const code = await run(["wallet", "close-empty", "--json"], f.deps)
    expect(code).toBe(0)
    expect(f.paths()).not.toContain(EXECUTE)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ success: true, status: "cancelled", wallet: EMBEDDED })
  })

  test("without a terminal it needs --yes, and closes nothing", async () => {
    const f = await fixture({ tty: false })
    const code = await run(["wallet", "close-empty", "--json"], f.deps)
    expect(code).toBe(1)
    expect(f.paths()).not.toContain(EXECUTE)
    expect(JSON.parse(f.stdout.text).code).toBe("CONFIRMATION_REQUIRED")
  })

  test("--yes skips the prompt; repeated and comma-separated --keep all reach the preview", async () => {
    const f = await fixture({ tty: false })
    const code = await run(
      ["wallet", "close-empty", "--keep", `${KEEP},${KEEP_2}`, "--keep", KEEP, "--wallet", "embedded", "--yes"],
      f.deps,
    )
    expect(code).toBe(0)
    expect(f.calls.find((c) => c.path === PREVIEW)?.body).toEqual({ keep: [KEEP, KEEP_2] })
    expect(f.paths()).toContain(EXECUTE)
  })

  test("nothing to close says so and sends no close", async () => {
    const f = await fixture({ accounts: [] })
    const code = await run(["wallet", "close-empty"], f.deps)
    expect(code).toBe(0)
    expect(f.stdout.text).toContain(`No empty token accounts to close on the embedded wallet ${EMBEDDED}.`)
    expect(f.paths()).not.toContain(EXECUTE)
  })

  test("a named id that already ran prints its stored report and sends nothing", async () => {
    const f = await fixture({ job: { clientTradeId: "close-1", kind: "close-empty", status: "completed" } })
    const code = await run(["wallet", "close-empty", "--client-trade-id", "close-1", "--json"], f.deps)
    expect(code).toBe(0)
    expect(f.paths().filter((p) => p.includes("close-empty"))).toEqual([
      "/api/v1/agent/wallets/embedded/close-empty/jobs/close-1",
    ])
    expect(JSON.parse(f.stdout.text)).toMatchObject({ job: { status: "completed" }, clientTradeId: "close-1" })
  })

  test("a named id that has not run is used for the close", async () => {
    const f = await fixture()
    expect(await run(["wallet", "close-empty", "--client-trade-id", "close-2", "--yes"], f.deps)).toBe(0)
    expect(f.calls.find((c) => c.path === EXECUTE)?.body?.clientTradeId).toBe("close-2")
  })

  test("a TEE wallet is refused and pointed at tee sweep, before any preview", async () => {
    const f = await fixture()
    const code = await run(["wallet", "close-empty", "--wallet", TEE, "--json"], f.deps)
    expect(code).toBe(1)
    const error = JSON.parse(f.stdout.text)
    expect(error.code).toBe("PAYER_UNSUPPORTED")
    expect(error.message).toContain("candle tee sweep")
    expect(f.paths()).not.toContain(PREVIEW)
  })

  test("no embedded Solana wallet is refused before any preview", async () => {
    const f = await fixture({ embedded: null })
    expect(await run(["wallet", "close-empty", "--json"], f.deps)).toBe(1)
    expect(f.paths()).not.toContain(PREVIEW)
  })

  test("a server refusal surfaces its code with exit 1", async () => {
    const f = await fixture({ execute: { error: { code: "CLOSE_FAILED", message: "Nothing was closed" } } })
    const code = await run(["wallet", "close-empty", "--yes", "--json"], f.deps)
    expect(code).toBe(1)
    expect(JSON.parse(f.stdout.text).code).toBe("CLOSE_FAILED")
  })

  test("bad flags are usage errors with exit 2 and no request", async () => {
    for (const args of [
      ["--keep"],
      ["--keep", "not-a-mint"],
      ["--client-trade-id", "has space"],
      ["extra-positional"],
      ["--bogus"],
    ]) {
      const f = await fixture()
      expect(await run(["wallet", "close-empty", ...args, "--json"], f.deps)).toBe(2)
      expect(f.calls).toEqual([])
    }
  })
})

describe("splitKeep", () => {
  test("lifts every --keep out, splits commas and dedupes, leaving the rest in order", () => {
    expect(splitKeep(["--yes", "--keep", "a,b", "--wallet", "embedded", "--keep", "a"])).toEqual({
      rest: ["--yes", "--wallet", "embedded"],
      keep: ["a", "b"],
    })
    expect(splitKeep(["--keep", "--yes"])).toEqual({ error: "--keep requires a mint" })
  })
})
