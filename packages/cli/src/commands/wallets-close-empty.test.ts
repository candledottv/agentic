/**
 * `candle wallet close-empty` (BE-418): preview, confirm, then close over the embedded-wallet
 * close routes, with nothing signed on this machine. BE-1687: a bound TEE wallet's close is
 * previewed, built by the server, checked here, relay-signed per transaction and submitted whole.
 * Driven through `run()` against a stub server, the same shape as transfer.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { humanText } from "../human-output.test-support"
import { run } from "../index"
import { pemToStoredSigner } from "../secret-store"
import {
  compileLegacyMessage,
  decodePubkey,
  encodePubkey,
  type Instruction,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  tokenCloseAccount,
} from "../solana-lite"
import { FIXTURE_BLOCKHASH, tokenApprove } from "../solana-verify.fixtures"
import { createCapture, createFakeStore, createTestDeps } from "../test-support"
import { closeProblem, splitKeep } from "./wallets-close-empty"

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
    expect(humanText(f.stderr.text)).toContain(
      humanText(`Close 2 empty token accounts on the embedded wallet ${EMBEDDED}`),
    )
    expect(humanText(f.stderr.text)).toContain(
      humanText("Rent returned to that same wallet: 0.00411336 SOL in 1 transaction"),
    )
    expect(humanText(f.stderr.text)).toContain(humanText("network fee about 0.000005 SOL"))
    expect(humanText(f.stderr.text)).toContain(humanText("MintA  token-2022  0.00207408 SOL"))
    expect(humanText(f.stderr.text)).toContain(humanText("Left open: 1 kept by --keep, 1 wrapped SOL"))
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
    expect(humanText(f.stdout.text)).toContain(
      humanText(`No empty token accounts to close on the embedded wallet ${EMBEDDED}.`),
    )
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

  test("--wallet <the embedded address> is the embedded close, with no TEE wallet lookup", async () => {
    const f = await fixture()
    expect(await run(["wallet", "close-empty", "--wallet", EMBEDDED, "--yes"], f.deps)).toBe(0)
    expect(f.paths().filter((p) => p.includes("close-empty"))).toEqual([PREVIEW, EXECUTE])
    expect(f.paths()).not.toContain("/api/v1/agent/wallets/trading")
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

// ── BE-1687: a bound TEE wallet ──────────────────────────────────────────────────────────────

const TEE_ID = "tee-1"
const STRANGER = "8pM1nYvQ6HqS8VqLFPzWx5W2sTQeXKZbLqBTdrBGTsGb"
const signerPem = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString()
const address = (fill: number) => encodePubkey(new Uint8Array(32).fill(fill))
const TEE_ACCOUNTS = [
  { account: address(11), mint: "MintA", tokenProgram: "token-2022", lamports: "2074080" },
  { account: address(12), mint: "MintB", tokenProgram: "spl-token", lamports: "2039280" },
  { account: address(13), mint: "MintC", tokenProgram: "spl-token", lamports: "2039280" },
]

/**
 * CloseAccount of each row, rent to `destination` and owned by the TEE wallet, as the server builds
 * it: unsigned, one zeroed slot per required signature (two when another address pays the fee).
 */
function closeTransaction(
  rows: typeof TEE_ACCOUNTS,
  opts: { destination?: string; payer?: string; extra?: Instruction[] } = {},
): string {
  const instructions = [
    ...rows.map((row) =>
      tokenCloseAccount({
        account: decodePubkey(row.account),
        destination: decodePubkey(opts.destination ?? TEE),
        owner: decodePubkey(TEE),
        tokenProgram: decodePubkey(row.tokenProgram === "token-2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID),
      }),
    ),
    ...(opts.extra ?? []),
  ]
  const message = compileLegacyMessage({
    feePayer: decodePubkey(opts.payer ?? TEE),
    recentBlockhash: FIXTURE_BLOCKHASH,
    instructions,
  })
  const signers = message[0] as number
  return Buffer.concat([Buffer.from([signers]), Buffer.alloc(64 * signers), message]).toString("base64")
}

/** The honest build: two transactions over the three previewed accounts. */
function honestBuild(): { index: number; unsignedTransaction: string; accounts: string[]; lamports: string }[] {
  const first = TEE_ACCOUNTS.slice(0, 2)
  const second = TEE_ACCOUNTS.slice(2)
  return [
    {
      index: 0,
      unsignedTransaction: closeTransaction(first),
      accounts: first.map((a) => a.account),
      lamports: "4113360",
    },
    {
      index: 1,
      unsignedTransaction: closeTransaction(second),
      accounts: second.map((a) => a.account),
      lamports: "2039280",
    },
  ]
}

/** What the relay hands back: the same message, with the fee payer's signature slot filled. */
function relaySigned(unsigned: string): string {
  const bytes = Buffer.from(unsigned, "base64")
  bytes.fill(5, 1, 65)
  return bytes.toString("base64")
}

const TEE_BASE = `/api/v1/agent/wallets/${TEE_ID}/close-empty`
const TEE_PREVIEW = `${TEE_BASE}/preview`
const TEE_BUILD = `${TEE_BASE}/build`
const TEE_SUBMIT = `${TEE_BASE}/submit`
const TEE_SIGN = `/api/v1/agent/wallets/${TEE_ID}/sign`

async function teeFixture(
  opts: {
    scopes?: string[]
    /** The build's transactions; the honest build by default. */
    transactions?: ReturnType<typeof honestBuild>
    buildWallet?: string
    /** What the TEE jobs route answers for a named id; absent is JOB_NOT_FOUND. */
    job?: Record<string, unknown>
    /** The submit's answer and HTTP status; `completed` by default. */
    submit?: { status: number; body: Record<string, unknown> }
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "candle-close-empty-tee-"))
  folders.push(dir)
  const calls: { path: string; body: Record<string, unknown> | undefined }[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path, body })
    const ok = (value: unknown) => Response.json(value)
    if (path === "/api/v1/agent/wallets/trading")
      return ok({
        scopes: opts.scopes ?? ["swap:write"],
        privyAppId: "app",
        page: [
          {
            id: TEE_ID,
            address: TEE,
            label: "agent-one",
            chain: "solana",
            active: true,
            allowLaunch: false,
            privyWalletId: "privy",
          },
        ],
        isDone: true,
      })
    if (path === "/api/v1/agent/wallets/embedded")
      return ok({ success: true, wallets: { solana: { address: EMBEDDED }, evm: null } })
    if (path.startsWith(`${TEE_BASE}/jobs/`)) {
      if (!opts.job)
        return Response.json({ success: false, error: { code: "JOB_NOT_FOUND", message: "none" } }, { status: 404 })
      return ok({ success: true, job: opts.job })
    }
    if (path === TEE_PREVIEW)
      return ok({
        success: true,
        wallet: TEE,
        linkedWalletId: TEE_ID,
        keep: body?.keep ?? [],
        accounts: TEE_ACCOUNTS,
        accountCount: 3,
        totalLamports: "6152640",
        totalSol: "0.00615264",
        transactions: 2,
        estimatedFeeLamports: "10000",
        netLamports: "6142640",
        netSol: "0.00614264",
        skipped: [{ account: "Kept", mint: KEEP, tokenProgram: "spl-token", lamports: "2039280", reason: "kept" }],
        undecodable: [],
        closesPerTransaction: 20,
        maxAccountsPerCall: 200,
      })
    if (path === TEE_BUILD)
      return ok({
        success: true,
        status: "built",
        clientTradeId: body?.clientTradeId,
        wallet: opts.buildWallet ?? TEE,
        linkedWalletId: TEE_ID,
        recentBlockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
        expiresAtBlockHeight: 1000,
        transactions: opts.transactions ?? honestBuild(),
        accountCount: 3,
        totalLamports: "6152640",
        totalSol: "0.00615264",
        estimatedFeeLamports: "10000",
        netLamports: "6142640",
        netSol: "0.00614264",
        keep: body?.keep ?? [],
        notClosed: [],
        skipped: [],
        remaining: 0,
      })
    if (path === TEE_SIGN) {
      const transaction = (body?.body as { params: { transaction: string } }).params.transaction
      return ok({ success: true, signedTransaction: relaySigned(transaction), encoding: "base64" })
    }
    if (path === TEE_SUBMIT) {
      const answer = opts.submit ?? {
        status: 200,
        body: {
          success: true,
          status: "completed",
          clientTradeId: body?.clientTradeId,
          wallet: TEE,
          linkedWalletId: TEE_ID,
          signatures: ["CloseSig0", "CloseSig1"],
          lamportsRecovered: "6152640",
          solRecovered: "0.00615264",
          feeLamports: "10000",
          netLamports: "6142640",
          netSol: "0.00614264",
          failed: [],
          unattempted: [],
        },
      }
      return Response.json(answer.body, { status: answer.status })
    }
    throw new Error(`Unexpected ${path}`)
  }) as typeof fetch
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    fetch: fetcher,
    env: { CANDLE_CONFIG_DIR: dir, CANDLE_API_KEY: "bound-key" },
    store: createFakeStore({ [`wallet_signer_${TEE_ID}`]: pemToStoredSigner(signerPem) }),
    stdout,
    stderr,
    isTTY: { stdin: true, stdout: true, stderr: true },
    promptLine: async () => "y",
  })
  return { deps, calls, stdout, stderr, paths: () => calls.map((call) => call.path) }
}

const closePaths = (paths: string[]) => paths.filter((p) => p.includes("close-empty") || p.endsWith("/sign"))

describe("candle wallet close-empty --wallet <TEE wallet> (BE-1687)", () => {
  test("previews, confirms, builds, checks, relay-signs each transaction, then submits the whole batch", async () => {
    const f = await teeFixture()
    const code = await run(["wallet", "close-empty", "--wallet", "agent-one", "--keep", KEEP, "--json"], f.deps)
    expect(code).toBe(0)
    expect(humanText(f.stderr.text)).toContain(
      humanText(`Close 3 empty token accounts on the TEE wallet agent-one (${TEE})`),
    )
    expect(humanText(f.stderr.text)).toContain(
      humanText("Rent returned to that same wallet: 0.00615264 SOL in 2 transactions"),
    )
    expect(humanText(f.stderr.text)).toContain(humanText("Left open: 1 kept by --keep"))
    expect(closePaths(f.paths())).toEqual([TEE_PREVIEW, TEE_BUILD, TEE_SIGN, TEE_SIGN, TEE_SUBMIT])
    expect(f.calls.find((c) => c.path === TEE_PREVIEW)?.body).toEqual({ keep: [KEEP] })
    const build = f.calls.find((c) => c.path === TEE_BUILD)?.body as Record<string, unknown>
    expect(build.accounts).toEqual(TEE_ACCOUNTS.map((a) => a.account))
    expect(build.keep).toEqual([KEEP])
    expect(String(build.clientTradeId)).toMatch(/^close-[0-9a-f-]{36}$/)
    // Each built transaction went to the relay exactly as built, in index order.
    const built = honestBuild()
    const signs = f.calls.filter((c) => c.path === TEE_SIGN)
    expect(signs.map((c) => (c.body?.body as { params: { transaction: string } }).params.transaction)).toEqual(
      built.map((t) => t.unsignedTransaction),
    )
    expect(f.calls.find((c) => c.path === TEE_SUBMIT)?.body).toEqual({
      clientTradeId: build.clientTradeId,
      signed: built.map((t) => ({ index: t.index, signedTransaction: relaySigned(t.unsignedTransaction) })),
    })
    expect(JSON.parse(f.stdout.text)).toMatchObject({
      success: true,
      status: "completed",
      clientTradeId: build.clientTradeId,
      signatures: ["CloseSig0", "CloseSig1"],
    })
  })

  const tampered: [string, () => Parameters<typeof teeFixture>[0]][] = [
    [
      "an instruction other than CloseAccount",
      () => {
        const build = honestBuild()
        const rows = TEE_ACCOUNTS.slice(2)
        ;(build[1] as { unsignedTransaction: string }).unsignedTransaction = closeTransaction(rows, {
          extra: [tokenApprove(rows[0]?.account as string, STRANGER, TEE, 1n)],
        })
        return { transactions: build }
      },
    ],
    [
      "rent sent somewhere other than the wallet",
      () => {
        const build = honestBuild()
        ;(build[0] as { unsignedTransaction: string }).unsignedTransaction = closeTransaction(
          TEE_ACCOUNTS.slice(0, 2),
          {
            destination: STRANGER,
          },
        )
        return { transactions: build }
      },
    ],
    [
      "another fee payer",
      () => {
        const build = honestBuild()
        ;(build[1] as { unsignedTransaction: string }).unsignedTransaction = closeTransaction(TEE_ACCOUNTS.slice(2), {
          payer: STRANGER,
        })
        return { transactions: build }
      },
    ],
    [
      "an account the preview did not list",
      () => {
        const build = honestBuild()
        const extra = [{ account: address(99), mint: "MintZ", tokenProgram: "spl-token", lamports: "2039280" }]
        build.push({ index: 2, unsignedTransaction: closeTransaction(extra), accounts: [address(99)], lamports: "1" })
        return { transactions: build }
      },
    ],
    ["another wallet named on the build", () => ({ buildWallet: STRANGER })],
  ]
  for (const [what, opts] of tampered) {
    test(`a build with ${what} is refused before anything is signed or sent`, async () => {
      const f = await teeFixture(opts())
      const code = await run(["wallet", "close-empty", "--wallet", TEE, "--yes", "--json"], f.deps)
      expect(code).toBe(1)
      const error = JSON.parse(f.stdout.text)
      expect(error.code).toBe("INVALID_RESPONSE")
      expect(error.message).toContain("nothing was signed")
      expect(f.paths()).not.toContain(TEE_SIGN)
      expect(f.paths()).not.toContain(TEE_SUBMIT)
    })
  }

  test("a named id that already ran prints the TEE job and sends nothing", async () => {
    const f = await teeFixture({
      job: {
        clientTradeId: "close-1",
        kind: "close-empty",
        walletKind: "tee",
        linkedWalletId: TEE_ID,
        status: "completed",
        result: { success: true, status: "completed", signatures: ["CloseSig0"] },
      },
    })
    const code = await run(
      ["wallet", "close-empty", "--wallet", TEE_ID, "--client-trade-id", "close-1", "--json"],
      f.deps,
    )
    expect(code).toBe(0)
    expect(closePaths(f.paths())).toEqual([`${TEE_BASE}/jobs/close-1`])
    expect(JSON.parse(f.stdout.text)).toMatchObject({ job: { walletKind: "tee", status: "completed" } })
  })

  test("a recovering submit is printed with the re-run that reads it, exit 3", async () => {
    const f = await teeFixture({
      submit: {
        status: 202,
        body: {
          success: true,
          status: "recovering",
          message: "Not every close is settled on chain yet.",
          clientTradeId: "close-9",
          wallet: TEE,
          signatures: ["CloseSig0"],
          unresolved: [
            { index: 1, accounts: [address(13)], signature: "CloseSig1", reason: "no confirmed outcome yet" },
          ],
        },
      },
    })
    const code = await run(
      ["wallet", "close-empty", "--wallet", "agent-one", "--client-trade-id", "close-9", "--yes", "--json"],
      f.deps,
    )
    expect(code).toBe(3)
    // JOB_NOT_FOUND for the named id, so the close ran under it.
    expect(closePaths(f.paths())[0]).toBe(`${TEE_BASE}/jobs/close-9`)
    expect(f.calls.find((c) => c.path === TEE_BUILD)?.body?.clientTradeId).toBe("close-9")
    expect(humanText(f.stderr.text)).toContain(
      humanText(`candle wallet close-empty --wallet ${TEE} --client-trade-id close-9`),
    )
    expect(JSON.parse(f.stdout.text)).toMatchObject({ status: "recovering", unresolved: [{ index: 1 }] })
  })

  test("a key without swap:write is refused before any preview", async () => {
    const f = await teeFixture({ scopes: ["transfer:write"] })
    expect(await run(["wallet", "close-empty", "--wallet", "agent-one", "--yes", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text).code).toBe("SCOPE_MISSING")
    expect(f.paths()).not.toContain(TEE_PREVIEW)
  })
})

describe("closeProblem", () => {
  test("passes an honest close and names what is wrong with anything else", () => {
    const rows = TEE_ACCOUNTS.slice(0, 2)
    const listed = new Set(rows.map((r) => r.account))
    expect(closeProblem(closeTransaction(rows), TEE, listed)).toBeNull()
    expect(closeProblem(closeTransaction(rows), TEE, new Set([...listed, address(99)]))).toBe(
      "lists accounts it does not close",
    )
    expect(closeProblem(closeTransaction(rows, { destination: STRANGER }), TEE, listed)).toContain(
      `sends the rent to ${STRANGER}`,
    )
    expect(closeProblem("not base64!", TEE, listed)).toContain("does not decode")
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
