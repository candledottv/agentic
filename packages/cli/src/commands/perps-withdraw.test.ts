/**
 * BE-1573 (spec 2026-10-17-hyperliquid-withdrawals-design.md): `candle perps withdraw`. R12 (the
 * owner gate: no terminal refuses, `--yes` is a usage error, the display shows amount, fees, net
 * and destination before the unlock, then one unlock and one typed confirm) and R13 (a tampered
 * build is refused locally with no relay call). The pins are TEST VALUES passed through
 * `CANDLE_PERPS_WITHDRAW_PINS`; with it unset, the shipped V-A part 2 pins apply.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { humanText } from "../human-output.test-support"
import {
  CANDLE_PERPS_WITHDRAW_PINS,
  HYPERLIQUID_SEND_ASSET_TYPES,
  RELAY_NONCE_MAPPING_TYPES,
} from "../hyperliquid-withdraw"
import { run } from "../index"
import { pemToStoredSigner } from "../secret-store"
import { createCapture, createFakeStore, createTestDeps } from "../test-support"
import { closeVault } from "../vault/store"
import { makeVault, useCheapKdf } from "../vault/test-vault"
import { withdrawPins } from "./perps-withdraw"

setDefaultTimeout(60_000)
useCheapKdf()

const pem = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString()
const ACCOUNT = "0x14791697260e4c9a71f18484c9f997b308e59325"
const SOLANA = "7ZL9FvkpCMgdvzfoMSYZSuCXLCYN25dfgtDXej1BBJaB"
const DEPOSITORY = "0x865eb9baa5492cef598adf7afb1038654fcb7081"
const REQUEST_ID = "0x17925562135cd8ba1400a0cdebae8f67615b296b0c7a5cdda91d6286f21bc02c"
const ORDER_ID = "0x507c00b2168f0742b5203c302704d4f37196a22906284a5944ed4dd381a3c52a"
const NONCE = 1_770_329_064_777
const SIGNATURE = `0x${"a".repeat(64)}${"b".repeat(64)}1b`
const ZERO = "0x0000000000000000000000000000000000000000"
const PINS = {
  token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
  destinationDex: "",
  depositories: [DEPOSITORY],
  amountForm: "canonical",
}

function build(message: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    success: true,
    id: "w-1",
    status: "quoted",
    from: { walletId: "wallet", address: ACCOUNT, network: "mainnet" },
    to: { chain: "solana", walletId: "sol-wallet", address: SOLANA },
    amountUsdc: "5",
    feesUsdc: "0.1",
    netUsdc: "4.9",
    minimumOutUsdc: "4.89",
    relayRequestId: REQUEST_ID,
    relayOrderId: ORDER_ID,
    nonce: NONCE,
    expiresAt: Date.now() + 10 * 60_000,
    typedData: {
      domain: { name: "RelayNonceMapping", version: "2", chainId: 1, verifyingContract: ZERO },
      types: RELAY_NONCE_MAPPING_TYPES,
      primary_type: "NonceMapping",
      message: {
        chainId: "hyperliquid",
        wallet: ACCOUNT,
        depositor: ACCOUNT,
        id: ORDER_ID,
        nonce: NONCE,
        ...message,
      },
    },
    ...extra,
  }
}

function authorization(message: Record<string, unknown> = {}) {
  const signed = {
    hyperliquidChain: "Mainnet",
    destination: DEPOSITORY,
    sourceDex: "",
    destinationDex: "",
    token: PINS.token,
    amount: "5",
    fromSubAccount: "",
    nonce: NONCE,
    ...message,
  }
  return {
    success: true,
    id: "w-1",
    status: "authorized",
    nonce: NONCE,
    typedData: {
      domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 42161, verifyingContract: ZERO },
      types: HYPERLIQUID_SEND_ASSET_TYPES,
      primary_type: "HyperliquidTransaction:SendAsset",
      message: signed,
    },
    action: { type: "sendAsset", signatureChainId: "0xa4b1", ...signed },
  }
}

interface Options {
  build?: Record<string, unknown>
  authorization?: Record<string, unknown>
  confirm?: string
  tty?: boolean
  positions?: unknown[]
}

async function fixture(opts: Options = {}) {
  const made = await makeVault()
  closeVault(made.vault)
  const calls: { host: string; path: string; search: string; body: Record<string, unknown> | undefined }[] = []
  const events: string[] = []
  const stdout = createCapture()
  const stderr = createCapture()
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ host: url.host, path: url.pathname, search: url.search, body })
    const ok = (value: unknown) => Response.json(value)
    // What Relay answers a keyless read of its request record since 2026-10 (BE-1777). The client must not ask.
    if (url.host === "api.relay.link")
      return Response.json(
        { code: "FST_ERR_VALIDATION", message: "headers must have required property 'x-api-key'" },
        { status: 400 },
      )
    if (url.host === "api.hyperliquid.xyz") return ok({ status: "ok", response: { type: "default" } })
    if (url.pathname === "/api/v1/agent/wallets/trading")
      return ok({
        scopes: ["perps:withdraw"],
        privyAppId: "app",
        page: [
          {
            id: "sol-wallet",
            address: SOLANA,
            chain: "solana",
            active: true,
            allowLaunch: false,
            privyWalletId: "privy-sol",
          },
          {
            id: "wallet",
            address: ACCOUNT,
            label: "perps",
            chain: "evm",
            active: true,
            allowLaunch: false,
            privyWalletId: "privy-evm",
          },
        ],
        isDone: true,
      })
    if (url.pathname === "/api/v1/agent/perps/withdraw") return ok(opts.build ?? build())
    if (url.pathname === "/api/v1/agent/perps/withdraw/authorize") return ok(opts.authorization ?? authorization())
    if (url.pathname === "/api/v1/agent/perps/withdraw/submitted") return ok({ success: true, status: "submitted" })
    if (url.pathname === "/api/v1/agent/perps/withdraw/w-1")
      return ok({
        success: true,
        id: "w-1",
        status: "settled",
        amountUsdc: "5",
        feesUsdc: "0.1",
        to: { chain: "solana", address: SOLANA },
        relay: { status: "success" },
      })
    if (url.pathname === "/api/v1/agent/perps/positions")
      return ok({
        success: true,
        address: ACCOUNT,
        withdrawable: "12",
        positions: opts.positions ?? [],
        account: {},
        openWithdrawals: [],
      })
    if (url.pathname.endsWith("/sign")) {
      events.push("sign")
      return ok({ success: true, signature: SIGNATURE })
    }
    throw new Error(`Unexpected ${url}`)
  }) as typeof fetch
  const deps = createTestDeps({
    fetch: fetcher,
    env: {
      CANDLE_CONFIG_DIR: made.dir,
      HOME: made.dir,
      CANDLE_API_KEY: "bound-key",
      CANDLE_PERPS_WITHDRAW_PINS: JSON.stringify(PINS),
    },
    store: createFakeStore({ wallet_signer_wallet: pemToStoredSigner(pem) }),
    stdout,
    stderr,
    ...(opts.tty === false ? { isTTY: { stdin: false, stdout: false, stderr: false } } : {}),
    promptSecret: async (text: string) => {
      events.push(`unlock:${stdout.text}`)
      void text
      return made.passphrase
    },
    promptLine: async (text: string) => {
      events.push(`confirm:${text}`)
      return opts.confirm ?? "confirm"
    },
  })
  return { deps, calls, events, stdout, stderr }
}

function withoutOrderId() {
  const { relayOrderId: _omit, ...quoted } = build({ id: REQUEST_ID })
  return quoted
}

const WITHDRAW = ["perps", "withdraw", "5", "--to", "solana", "--id", "w-1"]
const relayCalls = (calls: { path: string }[]) => calls.filter((c) => c.path.endsWith("/sign"))

describe("R12: the owner gate", () => {
  test("--yes is a usage error, before anything is read", async () => {
    const f = await fixture()
    expect(await run([...WITHDRAW, "--yes"], f.deps)).toBe(2)
    expect(f.calls).toEqual([])
  })

  test("no terminal is refused, before anything is read", async () => {
    const f = await fixture({ tty: false })
    expect(await run(WITHDRAW, f.deps)).toBe(1)
    expect(f.calls).toEqual([])
  })

  test("the display (amount, fees, net, grouped destination) comes before the one unlock, then one typed confirm", async () => {
    const f = await fixture()
    expect(await run(WITHDRAW, f.deps)).toBe(0)
    const unlocks = f.events.filter((e) => e.startsWith("unlock:"))
    const confirms = f.events.filter((e) => e.startsWith("confirm:"))
    expect(unlocks).toHaveLength(1)
    expect(confirms).toHaveLength(1)
    const shown = unlocks[0] ?? ""
    expect(humanText(shown)).toContain(humanText("Withdraw 5 USDC Hyperliquid account"))
    expect(humanText(shown)).toContain(
      humanText("Relay fees 0.1 USDC Estimated received 4.9 USDC Minimum received 4.89 USDC"),
    )
    expect(humanText(shown)).toContain("To 7ZL9 Fvkp CMgd vzfo MSYZ SuCX LCYN 25df gtDX ej1B BJaB")
    expect(confirms[0]).toBe(`confirm:Type confirm to withdraw 5 USDC to ${SOLANA}: `)
    // Order: display, unlock, confirm, then the first relay signature.
    expect(f.events.indexOf(unlocks[0] as string)).toBeLessThan(f.events.indexOf(confirms[0] as string))
    expect(f.events.indexOf(confirms[0] as string)).toBeLessThan(f.events.indexOf("sign"))
  })

  test("anything but confirm cancels with nothing signed", async () => {
    const f = await fixture({ confirm: "yes" })
    expect(await run(WITHDRAW, f.deps)).toBe(1)
    expect(relayCalls(f.calls)).toEqual([])
  })

  test("with CANDLE_PERPS_WITHDRAW_PINS unset or blank, the shipped V-A part 2 pins apply", () => {
    const shipped = {
      token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
      destinationDex: "",
      depositories: ["0x66cf0aace1b4e562593bec10ec7868fba9932224"],
      amountForm: "fixed6" as const,
    }
    expect(CANDLE_PERPS_WITHDRAW_PINS).toEqual(shipped)
    expect(withdrawPins({})).toEqual(shipped)
    expect(withdrawPins({ CANDLE_PERPS_WITHDRAW_PINS: "  " })).toEqual(shipped)
  })
})

describe("the flow", () => {
  test("builds, checks, signs the mapping, authorizes, signs the transfer, posts it to Hyperliquid itself, reports, reads", async () => {
    const f = await fixture()
    expect(await run([...WITHDRAW, "--json"], f.deps)).toBe(0)
    expect(
      f.calls
        .map((c) => `${c.host === "localhost" || c.host.startsWith("api.candle") ? "" : `${c.host}:`}${c.path}`)
        .filter((p) => !p.includes("positions")),
    ).toEqual([
      expect.stringContaining("/api/v1/agent/wallets/trading"),
      expect.stringContaining("/api/v1/agent/wallets/trading"),
      expect.stringContaining("/api/v1/agent/perps/withdraw"),
      expect.stringContaining("/api/v1/agent/wallets/wallet/sign"),
      expect.stringContaining("/api/v1/agent/perps/withdraw/authorize"),
      expect.stringContaining("/api/v1/agent/wallets/wallet/sign"),
      "api.hyperliquid.xyz:/exchange",
      expect.stringContaining("/api/v1/agent/perps/withdraw/submitted"),
      expect.stringContaining("/api/v1/agent/perps/withdraw/w-1"),
    ])
    const built = f.calls.find((c) => c.path === "/api/v1/agent/perps/withdraw")
    expect(built?.body).toEqual({ clientWithdrawalId: "w-1", amountUsdc: "5", to: "solana", wallet: "wallet" })
    const exchange = f.calls.find((c) => c.host === "api.hyperliquid.xyz")
    expect(exchange?.body).toMatchObject({
      action: { type: "sendAsset", destination: DEPOSITORY, amount: "5" },
      nonce: NONCE,
    })
    expect(JSON.parse(f.stdout.text.trim())).toMatchObject({ status: "settled", signature: SIGNATURE })
    // N2 (BE-1777): no call to Relay's API, and the relay signs twice.
    expect(f.calls.some((c) => c.host === "api.relay.link")).toBe(false)
    expect(relayCalls(f.calls)).toHaveLength(2)
    expect(ORDER_ID).not.toBe(REQUEST_ID)
  })

  test("open positions are warned about before the unlock", async () => {
    const f = await fixture({ positions: [{ coin: "BTC", szi: "0.1" }] })
    expect(await run(WITHDRAW, f.deps)).toBe(0)
    expect(f.events.find((e) => e.startsWith("unlock:"))).toContain("raises their liquidation risk")
  })
})

describe("R13: a tampered build is refused locally, with no relay call", () => {
  test.each([
    ["wallet", build({ wallet: `0x${"9".repeat(40)}` })],
    ["nonce", build({ nonce: NONCE + 1 })],
    ["amount", build({}, { amountUsdc: "50" })],
    [
      "destination",
      build({}, { to: { chain: "solana", walletId: "x", address: "Attacker1111111111111111111111111111111111" } }),
    ],
  ])("a tampered NonceMapping %s", async (_label, tampered) => {
    const f = await fixture({ build: tampered })
    expect(await run([...WITHDRAW, "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text.trim().split("\n").at(-1) ?? "")).toMatchObject({
      ok: false,
      code: "PERPS_BUILD_REFUSED",
    })
    expect(relayCalls(f.calls)).toEqual([])
  })

  test("a build paying a wallet that is not this key's own is refused before any signature or authorize", async () => {
    const f = await fixture({
      build: build({}, { to: { chain: "solana", walletId: "sol-wallet", address: "A".repeat(43) } }),
    })
    expect(await run([...WITHDRAW, "--json"], f.deps)).toBe(1)
    const refusal = JSON.parse(f.stdout.text.trim().split("\n").at(-1) ?? "")
    expect(refusal).toMatchObject({ ok: false, code: "PERPS_BUILD_REFUSED" })
    expect(String(refusal.message)).toContain("not this key's own")
    expect(relayCalls(f.calls)).toEqual([])
    expect(f.calls.some((c) => c.path.endsWith("/authorize"))).toBe(false)
    expect(f.calls.some((c) => c.host === "api.relay.link")).toBe(false)
  })

  test.each([
    ["the request id", build({ id: REQUEST_ID })],
    ["a missing order id", withoutOrderId()],
    ["a malformed order id", build({ id: REQUEST_ID }, { relayOrderId: "0xabc" })],
  ])("a NonceMapping naming %s is refused with no relay call", async (_label, tampered) => {
    const f = await fixture({ build: tampered })
    expect(await run([...WITHDRAW, "--json"], f.deps)).toBe(1)
    expect(f.calls.some((c) => c.host === "api.relay.link")).toBe(false)
    expect(relayCalls(f.calls)).toEqual([])
    expect(JSON.parse(f.stdout.text.trim().split("\n").at(-1) ?? "")).toMatchObject({
      ok: false,
      code: "PERPS_BUILD_REFUSED",
    })
  })

  test.each([
    ["amount formatting", { amount: "5.0" }],
    ["fromSubAccount", { fromSubAccount: `0x${"5".repeat(40)}` }],
    ["token", { token: "USDC:0x00000000000000000000000000000000" }],
    ["destinationDex", { destinationDex: "xyz" }],
    ["destination", { destination: `0x${"7".repeat(40)}` }],
    ["nonce", { nonce: NONCE + 1 }],
  ])("a tampered SendAsset %s gets no second relay call and reaches no Hyperliquid", async (_label, change) => {
    const f = await fixture({ authorization: authorization(change) })
    expect(await run([...WITHDRAW, "--json"], f.deps)).toBe(1)
    expect(relayCalls(f.calls)).toHaveLength(1)
    expect(f.calls.some((c) => c.host === "api.hyperliquid.xyz")).toBe(false)
  })
})

describe("candle perps withdraw status", () => {
  test("reads one withdrawal", async () => {
    const f = await fixture()
    expect(await run(["perps", "withdraw", "status", "w-1"], f.deps)).toBe(0)
    expect(humanText(f.stdout.text)).toContain(humanText("Withdrawal w-1 Status settled Amount 5 USDC To"))
  })
})
