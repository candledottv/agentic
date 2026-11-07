/**
 * BE-2794 (BE-2791 spec 7.1): `candle launch`'s launch rules flags. Each maps to the request's
 * nested `launchRules` in raw units, a value out of 3.3's bounds is refused before any request in
 * the API's words, and the dry run prints a "Launch rules" block from the answer's own
 * `launchRules` object, and nothing without one.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync, randomBytes } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Keypair, PublicKey } from "@solana/web3.js"
import { humanText } from "../human-output.test-support"
import { run } from "../index"
import { launchRulesLines, parseAllowlist, parseDuration } from "../launch-rules"
import { pemToStoredSigner } from "../secret-store"
import { createCapture, createFakeStore, createTestDeps } from "../test-support"

const WALLET = Keypair.generate().publicKey.toBase58()
const EMBEDDED = Keypair.generate().publicKey.toBase58()
const wallets = (count: number) => Array.from({ length: count }, () => new PublicKey(randomBytes(32)).toBase58())

/** The summary a dry run answers for a request with rules (spec 4.1), resolved at a fixed clock. */
const SUMMARY = {
  openAt: "2026-11-06T12:00:00.000Z",
  capUntil: "2026-11-06T13:00:00.000Z",
  maxBuyPerWalletRaw: "500000000",
  allowlistUntil: "2026-11-06T13:00:00.000Z",
  allowlistRoot: "9f3a00000000000000000000000000000000000000000000000000000000c21e",
  allowlistSize: 1204,
  devBuyer: WALLET,
  devBuyMaxRaw: "200000000",
  clusterTime: "2026-11-06T06:00:00.000Z",
}

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "candle-launch-rules-"))
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
    if (path === "/api/v1/agent/wallets/embedded")
      return ok({ embeddedWalletPermission: "allowed", wallets: { solana: { address: EMBEDDED } } })
    if (path === "/api/v1/launch/self/dry-run" || path === "/api/v1/launch/headless/dry-run")
      return ok({
        success: true,
        dryRun: true,
        launchWallet: WALLET,
        resolved: { chain: "solana", quoteAsset: body.quoteAsset ?? "sol", mode: "open" },
        ...(body.launchRules ? { launchRules: SUMMARY } : {}),
      })
    if (path.startsWith("/api/v1/launch/headless/jobs/"))
      return ok({ error: { code: "JOB_NOT_FOUND", message: "not found" } }, 404)
    throw new Error(`Unexpected ${path}`)
  }) as typeof fetch
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    fetch: fetcher,
    env: { CANDLE_CONFIG_DIR: dir, CANDLE_API_KEY: "bound-key", CANDLE_SOLANA_RPC_URL: "http://localhost/rpc" },
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
  const file = async (name: string, text: string) => {
    const path = join(dir, name)
    await writeFile(path, text)
    return path
  }
  const dryRunBody = () => calls.find((call) => call.path.endsWith("/dry-run"))?.body ?? {}
  return { deps, calls, stdout, stderr, file, dryRunBody, paths: () => calls.map((call) => call.path) }
}

const base = (wallet = "tee") => [
  "launch",
  "--name",
  "Rules Token",
  "--symbol",
  "RULE",
  "--image-url",
  "https://example.test/image.png",
  "--wallet",
  wallet,
  "--client-trade-id",
  "launch-1",
  "--dry-run",
  "--json",
]

describe("BE-2794: the launch rules flags map to the nested request in raw units", () => {
  test("--open-in is seconds, from a duration or a number", async () => {
    for (const [value, seconds] of [
      ["6h", 21_600],
      ["90m", 5_400],
      ["2d", 172_800],
      ["600", 600],
      ["45s", 45],
    ] as const) {
      const f = await fixture()
      expect(await run([...base(), "--open-in", value], f.deps)).toBe(0)
      expect(f.dryRunBody().launchRules).toEqual({ openDelaySecs: seconds })
    }
  })

  test("--max-buy-per-wallet is raw units of the quote asset, with --cap-window in seconds", async () => {
    const sol = await fixture()
    expect(await run([...base(), "--max-buy-per-wallet", "0.5", "--cap-window", "1h"], sol.deps)).toBe(0)
    expect(sol.dryRunBody().launchRules).toEqual({ maxBuyPerWalletRaw: "500000000", capWindowSecs: 3_600 })
    const usdc = await fixture()
    expect(
      await run(
        [...base(), "--quote-asset", "usdc", "--max-buy-per-wallet", "25.5", "--cap-window", "86400"],
        usdc.deps,
      ),
    ).toBe(0)
    expect(usdc.dryRunBody().launchRules).toEqual({ maxBuyPerWalletRaw: "25500000", capWindowSecs: 86_400 })
  })

  test("--allowlist reads a file, one per line or comma separated, duplicates dropped, with --allowlist-window", async () => {
    const f = await fixture()
    const [a, b, c] = wallets(3)
    const path = await f.file("list.csv", `${a}\n\n${b}, "${c}"\n${a}\r\n`)
    expect(await run([...base(), "--allowlist", path, "--allowlist-window", "30m"], f.deps)).toBe(0)
    expect(f.dryRunBody().launchRules).toEqual({ allowlist: [a, b, c], allowlistWindowSecs: 1_800 })
  })

  test("--dev-buy-max is raw, with --open-in, and may raise the pre-open allowance above --buy", async () => {
    const f = await fixture()
    expect(await run([...base(), "--buy", "0.1", "--open-in", "1h", "--dev-buy-max", "0.25"], f.deps)).toBe(0)
    expect(f.dryRunBody()).toMatchObject({
      buyAmount: "100000000",
      launchRules: { openDelaySecs: 3_600, devBuyMaxRaw: "250000000" },
    })
  })

  test("every rule at once, on the embedded wallet's headless dry run too", async () => {
    const [a] = wallets(1)
    for (const wallet of ["tee", "embedded"]) {
      const f = await fixture()
      const path = await f.file("list.txt", `${a}\n`)
      const flags = [
        "--open-in",
        "10m",
        "--max-buy-per-wallet",
        "0.01",
        "--cap-window",
        "1h",
        "--allowlist",
        path,
        "--allowlist-window",
        "30m",
        "--dev-buy-max",
        "0.005",
      ]
      expect(await run([...base(wallet), ...flags], f.deps)).toBe(0)
      expect(f.dryRunBody().launchRules).toEqual({
        openDelaySecs: 600,
        maxBuyPerWalletRaw: "10000000",
        capWindowSecs: 3_600,
        allowlist: [a],
        allowlistWindowSecs: 1_800,
        devBuyMaxRaw: "5000000",
      })
    }
    const embedded = await fixture()
    expect(await run([...base("embedded"), "--open-in", "1h"], embedded.deps)).toBe(0)
    expect(embedded.paths()).toContain("/api/v1/launch/headless/dry-run")
  })

  test("no flag, or --open-in 0 alone, sends no launchRules field", async () => {
    for (const extra of [[], ["--open-in", "0"], ["--open-in", "0s"]]) {
      const f = await fixture()
      expect(await run([...base(), ...extra], f.deps)).toBe(0)
      expect(f.dryRunBody()).not.toHaveProperty("launchRules")
    }
  })
})

describe("BE-2794: out-of-range values are refused before any request, in 3.3's words", () => {
  const refused = async (extra: string[] | ((f: Awaited<ReturnType<typeof fixture>>) => Promise<string[]>)) => {
    const f = await fixture()
    const flags = typeof extra === "function" ? await extra(f) : extra
    const code = await run([...base(), ...flags], f.deps)
    return { code, paths: f.paths(), text: humanText(f.stderr.text + f.stdout.text) }
  }

  test("the open delay is 0 to 604800 seconds: 7d passes, 604801 and 8d do not", async () => {
    for (const ok of ["604800", "7d", "0"]) {
      const f = await fixture()
      expect(await run([...base(), "--open-in", ok], f.deps)).toBe(0)
    }
    // A negative value reads as a flag, and the parser refuses it before this check.
    expect((await refused(["--open-in", "-1"])).code).toBe(2)
    for (const bad of ["604801", "8d", "1.5h", "soon"]) {
      const r = await refused(["--open-in", bad])
      expect(r.code).toBe(2)
      expect(r.paths).toEqual([])
      expect(r.text).toContain("--open-in must be a whole number of seconds from 0 to 604800")
    }
  })

  test("each window is 1 to 86400 seconds: 1 and 24h pass, 0, 86401 and 25h do not", async () => {
    for (const ok of ["1", "24h"]) {
      const f = await fixture()
      expect(await run([...base(), "--max-buy-per-wallet", "1", "--cap-window", ok], f.deps)).toBe(0)
    }
    for (const bad of ["0", "86401", "25h", "2d"]) {
      const cap = await refused(["--max-buy-per-wallet", "1", "--cap-window", bad])
      expect(cap.code).toBe(2)
      expect(cap.paths).toEqual([])
      expect(cap.text).toContain("--cap-window must be a whole number of seconds from 1 to 86400")
      const list = await refused(async (f) => [
        "--allowlist",
        await f.file("one.txt", wallets(1)[0] as string),
        "--allowlist-window",
        bad,
      ])
      expect(list.code).toBe(2)
      expect(list.text).toContain("--allowlist-window must be a whole number of seconds from 1 to 86400")
    }
  })

  test("a cap without a window, and a list without a window, or either window alone", async () => {
    const cases: [string[], string][] = [
      [["--max-buy-per-wallet", "1"], "--max-buy-per-wallet and --cap-window go together"],
      [["--cap-window", "1h"], "--max-buy-per-wallet and --cap-window go together"],
      [["--allowlist", "./list.txt"], "--allowlist and --allowlist-window go together"],
      [["--allowlist-window", "1h"], "--allowlist and --allowlist-window go together"],
    ]
    for (const [flags, message] of cases) {
      const r = await refused(flags)
      expect(r.code).toBe(2)
      expect(r.paths).toEqual([])
      expect(r.text).toContain(message)
    }
  })

  test("amounts are positive whole-unit decimals within the quote's decimals", async () => {
    for (const bad of ["0", "0.000", "abc", "0.0000000001", "18446744073.709551616"]) {
      const r = await refused(["--max-buy-per-wallet", bad, "--cap-window", "1h"])
      expect(r.code).toBe(2)
      expect(r.paths).toEqual([])
    }
    const zero = await refused(["--max-buy-per-wallet", "0", "--cap-window", "1h"])
    expect(zero.text).toContain("--max-buy-per-wallet must be a positive amount in whole quote units")
  })

  test("--dev-buy-max without a delay, below the dev buy, and above the ceiling", async () => {
    const cases: [string[], string][] = [
      [["--dev-buy-max", "0.1"], "--dev-buy-max needs --open-in above 0: it only applies before the open."],
      [["--open-in", "0", "--dev-buy-max", "0.1"], "--dev-buy-max needs --open-in above 0"],
      [
        ["--buy", "0.2", "--open-in", "1h", "--dev-buy-max", "0.1"],
        "--dev-buy-max (0.1 SOL) is below this launch's own dev buy, --buy (0.2 SOL).",
      ],
      [
        ["--open-in", "1h", "--dev-buy-max", "0.6"],
        "--dev-buy-max is above the dev-buy ceiling for this launch (0.5 SOL).",
      ],
    ]
    for (const [flags, message] of cases) {
      const r = await refused(flags)
      expect(r.code).toBe(2)
      expect(r.paths).toEqual([])
      expect(r.text).toContain(message)
    }
    // At the ceiling passes.
    const f = await fixture()
    expect(await run([...base(), "--open-in", "1h", "--dev-buy-max", "0.5"], f.deps)).toBe(0)
  })

  test("with no open delay the dev buy must fit the cap", async () => {
    const r = await refused(["--buy", "0.2", "--max-buy-per-wallet", "0.1", "--cap-window", "1h"])
    expect(r.code).toBe(2)
    expect(r.paths).toEqual([])
    expect(r.text).toContain(
      "This launch's dev buy (--buy 0.2 SOL) is over --max-buy-per-wallet (0.1 SOL); with no open delay the dev buy is held to the cap.",
    )
    // With an open delay the dev buy is held to --dev-buy-max instead.
    const f = await fixture()
    expect(
      await run(
        [...base(), "--buy", "0.2", "--max-buy-per-wallet", "0.1", "--cap-window", "1h", "--open-in", "1h"],
        f.deps,
      ),
    ).toBe(0)
  })

  test("4,097 distinct wallets are refused, while 4,097 entries with one duplicate pass", async () => {
    const list = wallets(4_097)
    const over = await refused(async (f) => [
      "--allowlist",
      await f.file("over.txt", list.join("\n")),
      "--allowlist-window",
      "1h",
    ])
    expect(over.code).toBe(2)
    expect(over.paths).toEqual([])
    expect(over.text).toContain("--allowlist holds 1 to 4096 distinct wallets;")
    expect(over.text).toContain("has 4097.")
    const f = await fixture()
    const dup = [...list.slice(0, 4_096), list[0] as string]
    const path = await f.file("dup.txt", dup.join("\n"))
    expect(await run([...base(), "--allowlist", path, "--allowlist-window", "1h"], f.deps)).toBe(0)
    expect((f.dryRunBody().launchRules as { allowlist: string[] }).allowlist).toHaveLength(4_096)
  })

  test("a bad entry names its line, and an empty or unreadable file is refused", async () => {
    const [a] = wallets(1)
    const bad = await refused(async (f) => [
      "--allowlist",
      await f.file("bad.txt", `${a}\nnot-a-wallet\n`),
      "--allowlist-window",
      "1h",
    ])
    expect(bad.code).toBe(2)
    expect(bad.paths).toEqual([])
    expect(bad.text).toContain("line 2: not-a-wallet is not a base58 Solana address.")
    const empty = await refused(async (f) => [
      "--allowlist",
      await f.file("empty.txt", "\n\n"),
      "--allowlist-window",
      "1h",
    ])
    expect(empty.code).toBe(2)
    expect(empty.text).toContain("has 0.")
    const missing = await refused(["--allowlist", "./no-such-file.txt", "--allowlist-window", "1h"])
    expect(missing.code).toBe(2)
    expect(missing.paths).toEqual([])
    expect(missing.text).toContain("could not be read as a file")
  })

  test("rules are Solana only: a Hood quote asset is refused", async () => {
    const r = await refused(["--quote-asset", "eth", "--dex-version", "v4", "--open-in", "1h"])
    expect(r.code).toBe(2)
    expect(r.paths).toEqual([])
    expect(r.text).toContain("are only available on Solana launches")
  })
})

describe("BE-2794: the dry run's Launch rules block", () => {
  test("renders from the answer's launchRules, with the pre-open spend line", async () => {
    const f = await fixture()
    expect(
      await run(
        [...base(), "--buy", "0.1", "--open-in", "6h", "--max-buy-per-wallet", "0.5", "--cap-window", "1h"],
        f.deps,
      ),
    ).toBe(0)
    expect(f.stderr.text).toContain(
      [
        "Launch rules",
        "  Opens        2026-11-06 12:00 UTC (in 6h); only your wallet may buy before then, up to 0.2 SOL",
        "               (that spend counts toward the per-wallet cap after the open)",
        "  Allowlist    1,204 wallets until 2026-11-06 13:00 UTC (root 9f3a…c21e)",
        "  Cap          0.5 SOL per wallet until 2026-11-06 13:00 UTC",
        "  Buyers pay   a one-time ~0.0015 SOL registration while a cap or allowlist is active (refundable)",
      ].join("\n"),
    )
    // --json carries the API's object verbatim.
    const out = JSON.parse(f.stdout.text.trimEnd().split("\n").at(-1) ?? "{}")
    expect(out.launchRules).toEqual(SUMMARY)
  })

  test("is absent without rules", async () => {
    const f = await fixture()
    expect(await run(base(), f.deps)).toBe(0)
    expect(f.stderr.text).not.toContain("Launch rules")
  })

  test("prints only the lines its rules have", () => {
    const whole = (raw: string) => `${Number(raw) / 1e9} SOL`
    const capOnly = {
      ...SUMMARY,
      openAt: null,
      allowlistUntil: null,
      allowlistRoot: null,
      allowlistSize: 0,
      devBuyMaxRaw: "0",
    }
    expect(launchRulesLines({ launchRules: capOnly }, whole)).toEqual([
      "Launch rules",
      "  Cap          0.5 SOL per wallet until 2026-11-06 13:00 UTC",
      "  Buyers pay   a one-time ~0.0015 SOL registration while a cap or allowlist is active (refundable)",
    ])
    const delayOnly = {
      ...capOnly,
      openAt: "2026-11-06T07:30:15.000Z",
      capUntil: null,
      maxBuyPerWalletRaw: null,
    }
    expect(launchRulesLines({ launchRules: delayOnly }, whole)).toEqual([
      "Launch rules",
      "  Opens        2026-11-06 07:30:15 UTC (in 1h 30m 15s); nobody may buy before then",
    ])
    expect(launchRulesLines({}, whole)).toEqual([])
    expect(launchRulesLines({ launchRules: { openAt: 1 } }, whole)).toEqual([])
  })
})

test("parseDuration and parseAllowlist", () => {
  expect(parseDuration("0")).toBe(0)
  expect(parseDuration("2d")).toBe(172_800)
  expect(parseDuration(" 15m ")).toBe(900)
  expect(parseDuration("1h30m")).toBeUndefined()
  expect(parseDuration("1.5h")).toBeUndefined()
  expect(parseDuration("h")).toBeUndefined()
  const [a, b] = wallets(2) as [string, string]
  expect(parseAllowlist(`${a},${b}\n${b}`, "list")).toEqual([a, b])
  expect(() => parseAllowlist(`${a}\n${a}0`, "list")).toThrow("line 2")
})
