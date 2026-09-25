/**
 * BE-355 (spec `docs/superpowers/specs/2026-09-24-cli-default-solana-rpc-design.md`, T1 to T6): the
 * one resolver, its validation, the once-per-machine notice, the host line, and what a refusal
 * before the first request does not print. T1 and T2 drive the pure resolver; T3 to T6 drive the
 * real dispatcher over a real vault with a scripted `fetch`, `sleep` and config store.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import type { CliConfig } from "./config"
import type { CommandContext, Deps } from "./deps"
import { run } from "./index"
import {
  PUBLIC_SOLANA_RPC,
  PUBLIC_SOLANA_RPC_HOST,
  publicRpcNoticeLines,
  resolveSolanaEndpoint,
  rpcFixLines,
} from "./solana-endpoint"
import { createCapture, createFakeConfigStore, createTestDeps } from "./test-support"
import { closeVault } from "./vault/store"
import { makeVault, useCheapKdf } from "./vault/test-vault"

setDefaultTimeout(60_000)
useCheapKdf()

const SECRET_URL = "https://rpc.example/v1/SECRETKEY?api-key=SECRET2"
const DESTINATION = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"

const unusedFetch = (() => {
  throw new Error("must not fetch")
}) as unknown as typeof fetch

function ctxFor(env: Record<string, string | undefined>, profile?: string): CommandContext {
  return {
    deps: createTestDeps({ fetch: unusedFetch, env }),
    json: false,
    apiUrl: "",
    verifyAccount: false,
    ...(profile === undefined ? {} : { profile }),
  }
}

const withWork = (rpcUrl?: string): CliConfig => ({
  profiles: { work: rpcUrl === undefined ? {} : { rpcUrl } },
  activeProfile: "work",
})

describe("T1: precedence", () => {
  test("flag beats env beats profile beats default, and source says which", () => {
    const ctx = ctxFor({ CANDLE_SOLANA_RPC_URL: "https://env.test/" }, "work")
    const config = withWork("https://profile.test/")
    expect(resolveSolanaEndpoint(ctx, "https://flag.test/", config)).toEqual({
      url: "https://flag.test/",
      host: "flag.test",
      source: "flag",
    })
    expect(resolveSolanaEndpoint(ctx, undefined, config)).toEqual({
      url: "https://env.test/",
      host: "env.test",
      source: "env",
    })
    expect(resolveSolanaEndpoint(ctxFor({}, "work"), undefined, config)).toEqual({
      url: "https://profile.test/",
      host: "profile.test",
      source: "profile",
    })
    expect(resolveSolanaEndpoint(ctxFor({}, "work"), undefined, withWork())).toEqual({
      url: PUBLIC_SOLANA_RPC,
      host: PUBLIC_SOLANA_RPC_HOST,
      source: "default",
    })
  })

  test("a whitespace-only env value is unset and falls through to the profile", () => {
    const ctx = ctxFor({ CANDLE_SOLANA_RPC_URL: "   " }, "work")
    expect(resolveSolanaEndpoint(ctx, undefined, withWork("https://profile.test/"))).toMatchObject({
      source: "profile",
    })
    expect(resolveSolanaEndpoint(ctx, undefined, withWork())).toMatchObject({ source: "default" })
  })

  test("pre-profile mode skips the profile field even when a profile in the file has one", () => {
    const ctx = ctxFor({})
    expect(resolveSolanaEndpoint(ctx, undefined, withWork("https://profile.test/"))).toMatchObject({
      source: "default",
    })
  })
})

describe("T2: validation names the source and never echoes the value", () => {
  test("http:// to a remote host is refused with the source named", () => {
    expect(resolveSolanaEndpoint(ctxFor({}, "work"), "http://remote", withWork())).toEqual({
      error: "--rpc-url must be https:// (plain http is allowed only for 127.0.0.1 / localhost).",
    })
    expect(
      resolveSolanaEndpoint(ctxFor({ CANDLE_SOLANA_RPC_URL: "http://remote" }, "work"), undefined, withWork()),
    ).toEqual({
      error: "CANDLE_SOLANA_RPC_URL must be https:// (plain http is allowed only for 127.0.0.1 / localhost).",
    })
    expect(resolveSolanaEndpoint(ctxFor({}, "work"), undefined, withWork("http://remote"))).toEqual({
      error: "profile work's rpcUrl must be https:// (plain http is allowed only for 127.0.0.1 / localhost).",
    })
  })

  test("http:// to 127.0.0.1 and localhost is accepted from every source", () => {
    expect(resolveSolanaEndpoint(ctxFor({}, "work"), "http://127.0.0.1:8899", withWork())).toMatchObject({
      host: "127.0.0.1:8899",
      source: "flag",
    })
    expect(
      resolveSolanaEndpoint(ctxFor({ CANDLE_SOLANA_RPC_URL: "http://localhost:8899" }, "work"), undefined, withWork()),
    ).toMatchObject({ host: "localhost:8899", source: "env" })
    expect(resolveSolanaEndpoint(ctxFor({}, "work"), undefined, withWork("http://localhost/"))).toMatchObject({
      source: "profile",
    })
  })

  test("an unparseable value refuses without the value in the message", () => {
    const bad = "not a url api-key=SECRET"
    const cases = [
      resolveSolanaEndpoint(ctxFor({}, "work"), bad, withWork()),
      resolveSolanaEndpoint(ctxFor({ CANDLE_SOLANA_RPC_URL: bad }, "work"), undefined, withWork()),
      resolveSolanaEndpoint(ctxFor({}, "work"), undefined, withWork(bad)),
    ]
    const expectedSources = ["--rpc-url", "CANDLE_SOLANA_RPC_URL", "profile work's rpcUrl"]
    for (const [i, resolved] of cases.entries()) {
      expect(resolved).toEqual({ error: `${expectedSources[i]} is not a valid URL` })
      expect(JSON.stringify(resolved)).not.toContain("SECRET")
    }
  })
})

describe("D2: the fix lines and the notice, in both forms", () => {
  test("with an acting profile, the fix names candle profile set and no line contains <name>", () => {
    const lines = rpcFixLines(ctxFor({}, "work"))
    expect(lines).toEqual([
      "candle profile set work --rpc-url https://<your-rpc>",
      "or, for one command, --rpc-url https://<your-rpc> or CANDLE_SOLANA_RPC_URL",
    ])
    expect(publicRpcNoticeLines(ctxFor({}, "work"))).toEqual([
      "Using the public Solana RPC, api.mainnet-beta.solana.com. It rate-limits heavily, and it sees every address this CLI asks it about.",
      "Set your own RPC for this profile: candle profile set work --rpc-url https://<your-rpc>",
      "Or for one command: --rpc-url https://<your-rpc>, or CANDLE_SOLANA_RPC_URL.",
      "This notice is shown once on this machine.",
    ])
    for (const line of [...lines, ...publicRpcNoticeLines(ctxFor({}, "work"))]) expect(line).not.toContain("<name>")
  })

  test("with no acting profile, nothing names profile set, and sign-in is the pointer", () => {
    const lines = rpcFixLines(ctxFor({}))
    expect(lines).toEqual([
      "--rpc-url https://<your-rpc> on this command, or CANDLE_SOLANA_RPC_URL for every command",
      "or sign in (candle auth login) to store one per profile",
    ])
    const notice = publicRpcNoticeLines(ctxFor({}))
    expect(notice).toEqual([
      "Using the public Solana RPC, api.mainnet-beta.solana.com. It rate-limits heavily, and it sees every address this CLI asks it about.",
      "Set your own RPC for one command with --rpc-url https://<your-rpc>, or for every command with CANDLE_SOLANA_RPC_URL.",
      "Or sign in (candle auth login) to store one per profile.",
      "This notice is shown once on this machine.",
    ])
    for (const line of [...lines, ...notice]) {
      expect(line).not.toContain("profile set")
      expect(line).not.toContain("<name>")
    }
  })
})

// ── The dispatcher over a real vault ──────────────────────────────────────────────────────────

interface Script {
  /** HTTP 429 for the first N requests of this method, then a normal answer. Infinity: always. */
  rateLimit?: Record<string, number>
  /** Every request throws a connect failure whose message carries the full URL, as some runtimes do. */
  connectFailure?: boolean
}

function scriptedFetch(script: Script) {
  const requests: { url: string; method: string }[] = []
  const limited = new Map<string, number>()
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] }
    requests.push({ url, method: body.method })
    if (script.connectFailure) throw new TypeError(`fetch failed: ${url}`)
    const remaining = script.rateLimit?.[body.method] ?? 0
    const seen = limited.get(body.method) ?? 0
    if (seen < remaining) {
      limited.set(body.method, seen + 1)
      return new Response("rate limited", { status: 429 })
    }
    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    switch (body.method) {
      case "getMultipleAccounts":
        return reply({ value: (body.params[0] as string[]).map(() => null) })
      case "getLatestBlockhash":
        return reply({ value: { blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N" } })
      case "getFeeForMessage":
        return reply({ value: 5000 })
      default:
        return reply(null)
    }
  }) as typeof fetch
  return { fetch: fetchFn, requests }
}

async function vaultHarness(opts: { config?: CliConfig; env?: Record<string, string>; script?: Script } = {}) {
  const made = await makeVault()
  closeVault(made.vault)
  const stdout = createCapture()
  const stderr = createCapture()
  const { fetch, requests } = scriptedFetch(opts.script ?? {})
  const sleeps: number[] = []
  const configStore = createFakeConfigStore(opts.config ?? {})
  const deps: Deps = createTestDeps({
    fetch,
    stdout,
    stderr,
    env: { CANDLE_CONFIG_DIR: made.dir, HOME: made.dir, ...(opts.env ?? {}) },
    promptSecret: async () => made.passphrase,
    promptLine: async () => DESTINATION.slice(-6),
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    ...configStore,
  })
  expect(await run(["vault", "new-key", "--chain", "solana", "--label", "cold"], deps)).toBe(0)
  stdout.text = ""
  stderr.text = ""
  requests.length = 0
  const reset = () => {
    stdout.text = ""
    stderr.text = ""
    requests.length = 0
    sleeps.length = 0
  }
  return { deps, stdout, stderr, requests, sleeps, reset, configStore }
}

const NOTICE_FIRST_LINE = "Using the public Solana RPC, api.mainnet-beta.solana.com."
const HOST_LINE_DEFAULT = "Solana RPC: api.mainnet-beta.solana.com (public default)"

describe("T3: the notice is shown once per machine", () => {
  test("first run: notice then host line; second run: host line only; the record is in config.json", async () => {
    const h = await vaultHarness({ config: withWork() })
    expect(await run(["vault", "list", "--balances"], h.deps)).toBe(0)
    const notice = h.stderr.text.indexOf(NOTICE_FIRST_LINE)
    const host = h.stderr.text.indexOf(HOST_LINE_DEFAULT)
    expect(notice).toBeGreaterThan(-1)
    expect(host).toBeGreaterThan(notice)
    expect(h.stderr.text).toContain("candle profile set work --rpc-url https://<your-rpc>")
    expect(h.requests.map((r) => new URL(r.url).host)).toEqual(["api.mainnet-beta.solana.com"])
    expect(typeof (await h.deps.readConfig()).publicRpcNotice?.shownAt).toBe("number")

    h.reset()
    expect(await run(["vault", "list", "--balances"], h.deps)).toBe(0)
    expect(h.stderr.text).not.toContain(NOTICE_FIRST_LINE)
    expect(h.stderr.text).toContain(HOST_LINE_DEFAULT)
  })

  test("a second profile on the same config dir does not see it again", async () => {
    const h = await vaultHarness({ config: { profiles: { work: {}, other: {} }, activeProfile: "work" } })
    expect(await run(["vault", "list", "--balances"], h.deps)).toBe(0)
    expect(h.stderr.text).toContain(NOTICE_FIRST_LINE)
    h.reset()
    expect(await run(["vault", "list", "--balances", "--profile", "other"], h.deps)).toBe(0)
    expect(h.stderr.text).not.toContain(NOTICE_FIRST_LINE)
    expect(h.stderr.text).toContain(HOST_LINE_DEFAULT)
  })

  test("a failing writeConfig prints it again next time, and the command still exits 0", async () => {
    const h = await vaultHarness({ config: withWork() })
    h.deps.writeConfig = async () => {
      throw new Error("read-only config")
    }
    for (let i = 0; i < 2; i++) {
      h.reset()
      expect(await run(["vault", "list", "--balances"], h.deps)).toBe(0)
      expect(h.stderr.text).toContain(NOTICE_FIRST_LINE)
    }
    expect((await h.deps.readConfig()).publicRpcNotice).toBeUndefined()
  })

  test("pre-profile mode prints D2's pre-profile text byte for byte", async () => {
    const h = await vaultHarness()
    expect(await run(["vault", "list", "--balances"], h.deps)).toBe(0)
    const expected = `${publicRpcNoticeLines(ctxFor({})).join("\n")}\n${HOST_LINE_DEFAULT}\n`
    // The unlock's own progress line precedes it; the notice and the host line are contiguous.
    expect(h.stderr.text).toContain(expected)
    expect(h.stderr.text).toContain("--rpc-url https://<your-rpc>")
    expect(h.stderr.text).toContain("CANDLE_SOLANA_RPC_URL")
    expect(h.stderr.text).toContain("candle auth login")
    expect(h.stderr.text).not.toContain("profile set")
    expect(h.stderr.text).not.toContain("<name>")
  })
})

describe("T4: the notice is only for the default", () => {
  for (const source of ["flag", "env", "profile"] as const) {
    test(`source ${source}: no notice and no record`, async () => {
      const h = await vaultHarness({
        config: source === "profile" ? withWork("https://rpc.example/") : withWork(),
        env: source === "env" ? { CANDLE_SOLANA_RPC_URL: "https://rpc.example/" } : {},
      })
      const args = ["vault", "list", "--balances", ...(source === "flag" ? ["--rpc-url", "https://rpc.example/"] : [])]
      expect(await run(args, h.deps)).toBe(0)
      expect(h.stderr.text).not.toContain(NOTICE_FIRST_LINE)
      expect(h.stderr.text).toContain(
        `Solana RPC: rpc.example (${source === "flag" ? "--rpc-url" : source === "env" ? "CANDLE_SOLANA_RPC_URL" : "profile work"})`,
      )
      expect((await h.deps.readConfig()).publicRpcNotice).toBeUndefined()
    })
  }
})

describe("T5: the host line, and no URL or key anywhere", () => {
  const sources = [
    { source: "flag", label: "--rpc-url" },
    { source: "env", label: "CANDLE_SOLANA_RPC_URL" },
    { source: "profile", label: "profile work" },
  ] as const
  const harnessFor = (source: (typeof sources)[number]["source"], script: Script = {}) =>
    vaultHarness({
      config: source === "profile" ? withWork(SECRET_URL) : withWork(),
      env: source === "env" ? { CANDLE_SOLANA_RPC_URL: SECRET_URL } : {},
      script,
    })
  const flagArgs = (source: string) => (source === "flag" ? ["--rpc-url", SECRET_URL] : [])
  const noSecret = (text: string) => {
    expect(text).not.toContain("SECRETKEY")
    expect(text).not.toContain("SECRET2")
  }

  for (const { source, label } of sources) {
    test(`vault list --balances via ${source}: success, --json, rate-limited, and a connect failure that carries the URL`, async () => {
      const ok = await harnessFor(source)
      expect(await run(["vault", "list", "--balances", ...flagArgs(source)], ok.deps)).toBe(0)
      expect(ok.stderr.text).toContain(`Solana RPC: rpc.example (${label})`)
      noSecret(ok.stdout.text + ok.stderr.text)
      ok.reset()
      expect(await run(["vault", "list", "--balances", "--json", ...flagArgs(source)], ok.deps)).toBe(0)
      expect(JSON.parse(ok.stdout.text).balances.rpcHost).toBe("rpc.example")
      noSecret(ok.stdout.text + ok.stderr.text)

      const limited = await harnessFor(source, { rateLimit: { getMultipleAccounts: Number.POSITIVE_INFINITY } })
      expect(await run(["vault", "list", "--balances", "--json", ...flagArgs(source)], limited.deps)).toBe(3)
      expect(limited.stderr.text).toContain("RPC_RATE_LIMITED")
      expect(limited.requests.filter((r) => r.method === "getMultipleAccounts")).toHaveLength(2)
      noSecret(limited.stdout.text + limited.stderr.text)

      const down = await harnessFor(source, { connectFailure: true })
      expect(await run(["vault", "list", "--balances", ...flagArgs(source)], down.deps)).toBe(3)
      expect(down.stderr.text).toContain("could not be read: fetch failed: <rpc>")
      noSecret(down.stdout.text + down.stderr.text)
    })
  }

  test("vault transfer: RPC_RATE_LIMITED before a signature, and a connect failure, name the host only", async () => {
    const limited = await harnessFor("env", { rateLimit: { getLatestBlockhash: Number.POSITIVE_INFINITY } })
    const args = ["vault", "transfer", DESTINATION, "--amount", "0.1", "--asset", "SOL", "--from", "cold", "--json"]
    expect(await run(args, limited.deps)).toBe(1)
    const body = JSON.parse(limited.stdout.text.trimEnd().split("\n").at(-1) ?? "")
    expect(body.code).toBe("RPC_RATE_LIMITED")
    expect(body.message).toContain("The Solana RPC at rpc.example is rate-limiting this CLI (HTTP 429, retried once)")
    noSecret(limited.stdout.text + limited.stderr.text)

    const down = await harnessFor("env", { connectFailure: true })
    expect(await run(args, down.deps)).toBe(1)
    expect(JSON.parse(down.stdout.text.trimEnd().split("\n").at(-1) ?? "").code).toBe("VAULT_UNREADABLE")
    noSecret(down.stdout.text + down.stderr.text)
  })
})

describe("T6: nothing is printed before a refusal", () => {
  test("vault transfer with a missing --amount and no endpoint: no notice, no host line, no write, zero fetches", async () => {
    const h = await vaultHarness({ config: withWork() })
    expect(await run(["vault", "transfer", DESTINATION, "--asset", "SOL", "--from", "cold"], h.deps)).toBe(2)
    expect(h.stderr.text).toContain("--amount <n> is required.")
    expect(h.stderr.text).not.toContain(NOTICE_FIRST_LINE)
    expect(h.stderr.text).not.toContain("Solana RPC:")
    expect((await h.deps.readConfig()).publicRpcNotice).toBeUndefined()
    expect(h.requests).toEqual([])
  })
})
