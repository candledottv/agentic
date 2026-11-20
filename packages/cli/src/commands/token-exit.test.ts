/** `candle token exit` (BE-3794, BE-3630 spec 6.2 and 10), driven through `run()` against a stub server. */
import { describe, expect, test } from "bun:test"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"

const TOKEN = "0x2222222222222222222222222222222222222222"
const CURVE = "0x1111111111111111111111111111111111111111"
const EMBEDDED = "0x3333333333333333333333333333333333333333"
const OTHER = "0x4444444444444444444444444444444444444444"
const USDG = "0x5555555555555555555555555555555555555555"
const TX = `0x${"ab".repeat(32)}`

const MARKET_PATH = `/api/v1/markets/hood/${TOKEN}`
const READ_PATH = `/api/v1/hood/curves/${CURVE}/holder-exit`
const AGENT_PATH = `/api/v1/agent/hood/holder-exit/${CURVE}`

type Answer = (body: Record<string, unknown> | undefined, search: string) => Response

function view(state: string, extra: Record<string, unknown> = {}) {
  return {
    generation: 2,
    state,
    lifecycle: state === "recovery" || state === "rescued" ? "recovery" : "graduated",
    recoveryWindow: null,
    recovery: null,
    rescue: null,
    team: null,
    actions: [],
    disclosure: `Disclosure sentence for ${state}.`,
    ...extra,
  }
}

const RECOVERY = view("recovery", {
  recovery: {
    quoteToken: USDG,
    quoteDecimals: 6,
    reserveSnapshotRaw: "1000000000",
    eligibleSupplyRaw: "2000000000000000000000",
    surrenderedRaw: "0",
    remainingRaw: "2000000000000000000000",
    ratePerTokenRaw: "500000",
    paysBy: "tokens_held",
  },
  account: {
    address: EMBEDDED,
    baseBalanceRaw: "10000000000000000000",
    allowanceToCurveRaw: "0",
    recoveryQuoteOutRaw: "5000000",
    mayEnterRecoveryNow: false,
    isTeamRecipient: false,
  },
  actions: ["claim_recovery"],
})

function fixture(answers: Record<string, Answer>, opts: { key?: boolean; prompt?: string; tty?: boolean } = {}) {
  const calls: { path: string; method: string; body: Record<string, unknown> | undefined; key: string | null }[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    const headers = new Headers(init?.headers)
    calls.push({
      path: `${url.pathname}${url.search}`,
      method: init?.method ?? "GET",
      body,
      key: headers.get("x-api-key"),
    })
    const answer = answers[url.pathname]
    if (!answer) throw new Error(`Unexpected ${url.pathname}`)
    return answer(body, url.search)
  }) as typeof fetch
  const stdout = createCapture()
  const stderr = createCapture()
  const prompts: string[] = []
  const deps = createTestDeps({
    fetch: fetcher,
    env: { CANDLE_PLAIN: "1", ...(opts.key === false ? {} : { CANDLE_API_KEY: "main-key" }) },
    stdout,
    stderr,
    isTTY: { stdin: opts.tty !== false, stdout: false, stderr: false },
    promptLine: async (question: string) => {
      prompts.push(question)
      return opts.prompt ?? "n"
    },
  })
  return { deps, calls, stdout, stderr, prompts }
}

const market: Answer = () =>
  Response.json({ success: true, market: { chain: "hood", mint: TOKEN, curveAddress: CURVE, decimals: 18 } })
const embedded: Answer = () => Response.json({ success: true, wallets: { solana: null, evm: { address: EMBEDDED } } })
const readOf =
  (holderExit: unknown): Answer =>
  () =>
    Response.json({ payload: { curve: CURVE, token: TOKEN, holderExit } })

const dryRunBody = {
  success: true,
  curve: CURVE,
  action: "claim_recovery",
  wallet: EMBEDDED,
  signer: "embedded",
  dryRun: true,
  build: {
    amountRaw: "10000000000000000000",
    expectedQuoteOutRaw: "5000000",
    quoteToken: USDG,
    quoteDecimals: 6,
    calls: [{ kind: "approve" }, { kind: "claim_recovery" }],
  },
  signable: true,
  outcome: "not_started",
  calls: [
    { kind: "approve", to: TOKEN, status: "not_sent", txHash: null },
    { kind: "claim_recovery", to: CURVE, status: "not_sent", txHash: null },
  ],
}

describe("candle token exit: the read", () => {
  for (const state of ["none", "awaiting_migration", "recovery_open", "recovery", "rescue_pending", "rescued"]) {
    test(`prints the ${state} disclosure verbatim, read for the embedded wallet`, async () => {
      const f = fixture({
        [MARKET_PATH]: market,
        "/api/v1/agent/wallets/embedded": embedded,
        [READ_PATH]: readOf(state === "recovery" ? RECOVERY : view(state)),
      })
      expect(await run(["token", "exit", TOKEN], f.deps)).toBe(0)
      expect(f.stdout.text).toContain(`Disclosure sentence for ${state}.`)
      expect(f.calls.map((c) => c.path)).toEqual([
        MARKET_PATH,
        "/api/v1/agent/wallets/embedded",
        `${READ_PATH}?account=${EMBEDDED}`,
      ])
    })
  }

  test("recovery shows the rate, the balance, what Recovery pays, and the command to run", async () => {
    const f = fixture({
      [MARKET_PATH]: market,
      "/api/v1/agent/wallets/embedded": embedded,
      [READ_PATH]: readOf(RECOVERY),
    })
    expect(await run(["token", "exit", TOKEN], f.deps)).toBe(0)
    const text = f.stdout.text.replace(/\s+/g, " ")
    expect(text).toContain(`0.5 ${USDG} per token`)
    expect(text).toContain("Balance 10 tokens")
    expect(text).toContain(`Recovery would pay 5 ${USDG}`)
    expect(text).toContain(`candle token exit ${TOKEN} --recover`)
  })

  test("without a key and without --wallet, the curve is read with no account and no credential", async () => {
    const f = fixture({ [MARKET_PATH]: market, [READ_PATH]: readOf(view("awaiting_migration")) }, { key: false })
    expect(await run(["token", "exit", TOKEN], f.deps)).toBe(0)
    expect(f.calls.map((c) => [c.path, c.key])).toEqual([
      [MARKET_PATH, null],
      [READ_PATH, null],
    ])
  })

  test("--wallet <0x> reads that wallet without asking for the embedded one", async () => {
    const f = fixture({ [MARKET_PATH]: market, [READ_PATH]: readOf(view("none")) })
    expect(await run(["token", "exit", TOKEN, "--wallet", OTHER], f.deps)).toBe(0)
    expect(f.calls.map((c) => c.path)).toEqual([MARKET_PATH, `${READ_PATH}?account=${OTHER}`])
  })

  test("--json prints the API body as sent, one value", async () => {
    const body = { payload: { curve: CURVE, token: TOKEN, holderExit: RECOVERY } }
    const f = fixture({
      [MARKET_PATH]: market,
      "/api/v1/agent/wallets/embedded": embedded,
      [READ_PATH]: () => Response.json(body),
    })
    expect(await run(["token", "exit", TOKEN, "--json"], f.deps)).toBe(0)
    expect(f.stdout.text.trimEnd().split("\n")).toHaveLength(1)
    expect(JSON.parse(f.stdout.text)).toEqual(body)
  })

  test("a token with no curve is NO_HOOD_CURVE", async () => {
    const f = fixture({
      [MARKET_PATH]: () => Response.json({ success: true, market: { chain: "hood", curveAddress: null } }),
    })
    expect(await run(["token", "exit", TOKEN, "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: false, code: "NO_HOOD_CURVE" })
  })

  test("a 404 read and a 503 read keep the route's code and words", async () => {
    const notListed = fixture({
      [MARKET_PATH]: market,
      [READ_PATH]: () => Response.json({ error: true, payload: "No Candle curve at this address" }, { status: 404 }),
    })
    expect(await run(["token", "exit", TOKEN, "--wallet", OTHER, "--json"], notListed.deps)).toBe(1)
    expect(JSON.parse(notListed.stdout.text)).toMatchObject({
      code: "HTTP_404",
      message: "No Candle curve at this address",
    })

    const down = fixture({
      [MARKET_PATH]: market,
      [READ_PATH]: () =>
        Response.json(
          { error: true, code: "FEED_UNAVAILABLE", payload: "Holder-exit read unavailable" },
          { status: 503 },
        ),
    })
    expect(await run(["token", "exit", TOKEN, "--wallet", OTHER, "--json"], down.deps)).toBe(1)
    expect(JSON.parse(down.stdout.text)).toMatchObject({ code: "FEED_UNAVAILABLE" })
  })

  test("usage refusals send nothing", async () => {
    for (const args of [
      ["token", "exit"],
      ["token", "exit", "not-an-address"],
      ["token", "exit", TOKEN, "--recover", "--claim-team"],
      ["token", "exit", TOKEN, "--amount", "5"],
      ["token", "exit", TOKEN, "--dry-run"],
      ["token", "exit", TOKEN, "--wallet", "desk"],
    ]) {
      const f = fixture({})
      expect(await run(args, f.deps)).toBe(2)
      expect(f.calls).toHaveLength(0)
    }
  })
})

describe("candle token exit: the actions", () => {
  test("--recover --dry-run sends the dry run only, with the disclosure first", async () => {
    const f = fixture({
      [MARKET_PATH]: market,
      "/api/v1/agent/wallets/embedded": embedded,
      [READ_PATH]: readOf(RECOVERY),
      [AGENT_PATH]: () => Response.json(dryRunBody),
    })
    expect(await run(["token", "exit", TOKEN, "--recover", "--dry-run"], f.deps)).toBe(0)
    const agent = f.calls.filter((c) => c.path === AGENT_PATH)
    expect(agent).toHaveLength(1)
    expect(agent[0]?.body).toEqual({ action: "claim_recovery", dryRun: true })
    expect(agent[0]?.key).toBe("main-key")
    const text = f.stdout.text.replace(/\s+/g, " ")
    expect(text.indexOf("Disclosure sentence for recovery.")).toBeLessThan(text.indexOf("Dry run"))
    expect(text).toContain(`Would pay 5 ${USDG}`)
    expect(text).toContain("Nothing was sent.")
  })

  test("--amount is converted with the token's decimals and --wallet <0x> is forwarded", async () => {
    const f = fixture({
      [MARKET_PATH]: market,
      [READ_PATH]: readOf(RECOVERY),
      [AGENT_PATH]: () => Response.json(dryRunBody),
    })
    expect(
      await run(["token", "exit", TOKEN, "--recover", "--amount", "2.5", "--wallet", OTHER, "--dry-run"], f.deps),
    ).toBe(0)
    expect(f.calls.find((c) => c.path === AGENT_PATH)?.body).toEqual({
      action: "claim_recovery",
      amountRaw: "2500000000000000000",
      wallet: OTHER,
      dryRun: true,
    })
  })

  test("a real run asks after the dry run, and a decline sends nothing more (exit 5)", async () => {
    const f = fixture(
      {
        [MARKET_PATH]: market,
        "/api/v1/agent/wallets/embedded": embedded,
        [READ_PATH]: readOf(RECOVERY),
        [AGENT_PATH]: () => Response.json(dryRunBody),
      },
      { prompt: "n" },
    )
    expect(await run(["token", "exit", TOKEN, "--recover"], f.deps)).toBe(5)
    expect(f.prompts).toEqual(["Redeem at the Recovery rate now? [y/N] "])
    expect(f.calls.filter((c) => c.path === AGENT_PATH).map((c) => c.body?.dryRun)).toEqual([true])
  })

  test("a confirmed run sends the dry run, then the real one, and prints the outcome", async () => {
    const f = fixture(
      {
        [MARKET_PATH]: market,
        "/api/v1/agent/wallets/embedded": embedded,
        [READ_PATH]: readOf(RECOVERY),
        [AGENT_PATH]: (body) =>
          Response.json(
            body?.dryRun
              ? dryRunBody
              : {
                  ...dryRunBody,
                  dryRun: false,
                  outcome: "complete",
                  calls: [
                    { kind: "approve", to: TOKEN, status: "confirmed", txHash: TX },
                    { kind: "claim_recovery", to: CURVE, status: "confirmed", txHash: TX, recorded: "booked" },
                  ],
                  warnings: [],
                },
          ),
      },
      { prompt: "y" },
    )
    expect(await run(["token", "exit", TOKEN, "--recover"], f.deps)).toBe(0)
    expect(f.calls.filter((c) => c.path === AGENT_PATH).map((c) => c.body?.dryRun)).toEqual([true, false])
    expect(f.stdout.text).toContain("Outcome")
    expect(f.stdout.text).toContain("complete")
  })

  test("without a terminal and without --yes, the real run is refused after the dry run", async () => {
    const f = fixture(
      {
        [MARKET_PATH]: market,
        "/api/v1/agent/wallets/embedded": embedded,
        [READ_PATH]: readOf(RECOVERY),
        [AGENT_PATH]: () => Response.json(dryRunBody),
      },
      { tty: false },
    )
    expect(await run(["token", "exit", TOKEN, "--recover", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ code: "CONFIRMATION_REQUIRED" })
    expect(f.calls.filter((c) => c.path === AGENT_PATH)).toHaveLength(1)
  })

  test("a refusal prints the API code with the disclosure; --json carries both", async () => {
    const refusal = {
      success: false,
      error: {
        code: "HOOD_RECOVERY_NOT_READY",
        message: "Recovery isn't open for this wallet yet.",
        retryable: false,
        stage: "not_broadcast",
        details: { creatorMayEnterAt: "100", anyoneMayEnterAt: "200" },
      },
    }
    const answers = {
      [MARKET_PATH]: market,
      "/api/v1/agent/wallets/embedded": embedded,
      [READ_PATH]: readOf(view("awaiting_migration")),
      [AGENT_PATH]: () => Response.json(refusal, { status: 409 }),
    }
    const human = fixture(answers)
    expect(await run(["token", "exit", TOKEN, "--enter-recovery", "--yes"], human.deps)).toBe(1)
    expect(human.stderr.text).toContain("HOOD_RECOVERY_NOT_READY")
    expect(human.stderr.text + human.stdout.text).toContain("Disclosure sentence for awaiting_migration.")

    const json = fixture(answers)
    expect(await run(["token", "exit", TOKEN, "--enter-recovery", "--yes", "--json"], json.deps)).toBe(1)
    expect(JSON.parse(json.stdout.text)).toMatchObject({
      ok: false,
      code: "HOOD_RECOVERY_NOT_READY",
      details: {
        disclosure: "Disclosure sentence for awaiting_migration.",
        stage: "not_broadcast",
        refusal: { creatorMayEnterAt: "100", anyoneMayEnterAt: "200" },
      },
    })
  })

  for (const code of [
    "HOOD_VESTING_NOT_MIGRATED",
    "HOOD_VESTING_STRANDED",
    "HOOD_VESTING_NO_ESCROW",
    "SCOPE_MISSING",
  ]) {
    test(`--claim-team refusal ${code} keeps its code`, async () => {
      const f = fixture({
        [MARKET_PATH]: market,
        "/api/v1/agent/wallets/embedded": embedded,
        [READ_PATH]: readOf(view("none")),
        [AGENT_PATH]: () =>
          Response.json({ success: false, error: { code, message: "refused", retryable: false } }, { status: 409 }),
      })
      expect(await run(["token", "exit", TOKEN, "--claim-team", "--yes", "--json"], f.deps)).toBe(1)
      expect(JSON.parse(f.stdout.text)).toMatchObject({ code })
      expect(f.calls.find((c) => c.path === AGENT_PATH)?.body).toEqual({ action: "claim_team", dryRun: true })
    })
  }

  test("a partial outcome is a refusal carrying outcome and calls; indeterminate exits 3", async () => {
    const failed = (outcome: string) => ({
      success: false,
      error: { code: "HOOD_EXIT_FAILED", message: "did not complete", retryable: true, stage: "reverted" },
      outcome,
      calls: [
        { kind: "approve", to: TOKEN, status: "confirmed", txHash: TX },
        {
          kind: "claim_recovery",
          to: CURVE,
          status: outcome === "partial" ? "reverted" : "submitted_unknown",
          txHash: TX,
        },
      ],
      warnings: ["w"],
    })
    for (const [outcome, exit] of [
      ["partial", 1],
      ["indeterminate", 3],
    ] as const) {
      const f = fixture({
        [MARKET_PATH]: market,
        "/api/v1/agent/wallets/embedded": embedded,
        [READ_PATH]: readOf(RECOVERY),
        [AGENT_PATH]: (body) =>
          body?.dryRun
            ? Response.json(dryRunBody)
            : Response.json(failed(outcome), { status: outcome === "partial" ? 409 : 502 }),
      })
      expect(await run(["token", "exit", TOKEN, "--recover", "--yes", "--json"], f.deps)).toBe(exit)
      const envelope = JSON.parse(f.stdout.text)
      expect(envelope).toMatchObject({ code: "HOOD_EXIT_FAILED", details: { outcome, warnings: ["w"] } })
      expect(envelope.details.calls).toHaveLength(2)
    }
  })

  test("a dry run that says the wallet is not signable stops before the real run", async () => {
    const f = fixture({
      [MARKET_PATH]: market,
      "/api/v1/agent/wallets/embedded": embedded,
      [READ_PATH]: readOf(RECOVERY),
      [AGENT_PATH]: () => Response.json({ ...dryRunBody, signable: false, reason: "embedded_wallet_not_permitted" }),
    })
    expect(await run(["token", "exit", TOKEN, "--recover", "--yes", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ code: "HOOD_EXIT_WALLET_NOT_SIGNABLE" })
    expect(f.calls.filter((c) => c.path === AGENT_PATH)).toHaveLength(1)
  })

  test("an action needs a key", async () => {
    const f = fixture({ [MARKET_PATH]: market }, { key: false })
    expect(await run(["token", "exit", TOKEN, "--recover", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: false })
    expect(f.calls.some((c) => c.path === AGENT_PATH)).toBe(false)
  })
})
