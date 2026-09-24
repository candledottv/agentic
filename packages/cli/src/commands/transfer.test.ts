/**
 * `candle transfer` (Read:Write:Transfer spec, 2026-09-24, D6 / R19): builds over
 * POST /agent/transfer/build, approves the relay with the wallet's P-256 key, submits over
 * POST /agent/transfer/submit, and never opens a vault. Driven through `run()` against a stub
 * server, the same shape as swap.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { run } from "../index"
import { pemToStoredSigner } from "../secret-store"
import { createCapture, createFakeStore, createTestDeps } from "../test-support"

const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
/** The TEE wallet's address (the payer). */
const TEE = "7ZL9FvkpCMgdvzfoMSYZSuCXLCYN25dfgtDXej1BBJaB"
/** The account's embedded wallet, distinct from the TEE wallet. */
const EMBEDDED = "9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL"
/** A session-linked wallet on the account, labelled `treasury`. */
const TREASURY = "4Nd1mYvM6HqS8VqLFPzWx5W2sTQeXKZbLqBTdrBGTsGa"
/** The TEE wallet's pinned vault. */
const VAULT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
/** An address that is nobody's linked wallet. */
const STRANGER = "8pM1nYvQ6HqS8VqLFPzWx5W2sTQeXKZbLqBTdrBGTsGb"
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const SIGNED = Buffer.concat([Buffer.from([1]), Buffer.alloc(64, 5), Buffer.alloc(40)]).toString("base64")

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(
  opts: {
    scopes?: string[]
    prompt?: string
    tty?: boolean
    /** What the lifecycle answers for vaultDestination; null drops the field. */
    vault?: string | null
    /** BE-249 shape: the account's only payer is the embedded wallet. */
    teeWallets?: number
    /** The linked wallets GET /wallets lists besides the TEE wallet itself. */
    linked?: { _id: string; address: string; label?: string; chain?: string; revokedAt?: number }[]
    /** What /transfer/build answers; a `{ error }` answers that Candle error. */
    build?: Record<string, unknown> | { error: { code: string; message: string } }
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "candle-transfer-"))
  folders.push(dir)
  const calls: { path: string; body: Record<string, unknown> | undefined }[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const path = url.pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path, body })
    const ok = (value: unknown) => Response.json(value)
    if (path === "/api/v1/agent/wallets/trading")
      return ok({
        scopes: opts.scopes ?? ["swap:write", "transfer:write", "transfer:bound"],
        privyAppId: "app",
        page: Array.from({ length: opts.teeWallets ?? 1 }, () => ({
          id: "wallet",
          address: TEE,
          label: "agent-one",
          chain: "solana",
          active: true,
          allowLaunch: false,
          privyWalletId: "privy",
        })),
        isDone: true,
      })
    if (path === "/api/v1/agent/wallets/embedded")
      return ok({ success: true, wallets: { solana: { address: EMBEDDED }, evm: null } })
    if (path === "/api/v1/agent/wallets")
      return ok({
        success: true,
        page: [
          { _id: "wallet", address: TEE, label: "agent-one", chain: "solana", profile: "ember-tee" },
          ...(opts.linked ?? [{ _id: "lw-treasury", address: TREASURY, label: "treasury", chain: "solana" }]).map(
            (row) => ({ chain: "solana", ...row }),
          ),
        ],
        isDone: true,
      })
    if (path === "/api/v1/agent/wallets/wallet/lifecycle")
      return ok({
        state: "enabled",
        boundKeyPrefix: "bound",
        ...(opts.vault === null ? {} : { vaultDestination: opts.vault ?? VAULT }),
      })
    if (path === "/api/v1/agent/transfer/build") {
      if (opts.build && "error" in opts.build) return Response.json({ error: opts.build.error }, { status: 403 })
      return ok({
        success: true,
        transferId: "tr-1",
        walletId: "wallet",
        payerAddress: TEE,
        amountRaw: body?.amountRaw === "max" ? "999990000" : body?.amountRaw,
        destinationClass: "own",
        destinationKind: body?.to === VAULT ? "vault" : "linked",
        unsignedTransactionsBase64: ["unsigned"],
        expiresAt: 10_000,
        ...(opts.build ?? {}),
      })
    }
    if (path === "/api/v1/agent/wallets/wallet/sign") return ok({ signedTransaction: SIGNED, encoding: "base64" })
    if (path === "/api/v1/agent/transfer/submit")
      return ok({
        success: true,
        signature: "SoLSig111",
        amountRaw: "5000",
        from: TEE,
        to: body?.to ?? TREASURY,
        destinationClass: "own",
        destinationKind: "linked",
        walletId: "wallet",
      })
    if (path === "/rpc") return ok({ jsonrpc: "2.0", id: 1, result: { value: { decimals: 6 } } })
    throw new Error(`Unexpected ${path}`)
  }) as typeof fetch
  const stdout = createCapture()
  const stderr = createCapture()
  const tty = opts.tty ?? true
  const deps = createTestDeps({
    fetch: fetcher,
    env: { CANDLE_CONFIG_DIR: dir, CANDLE_API_KEY: "bound-key", CANDLE_SOLANA_RPC_URL: "http://localhost/rpc" },
    store: createFakeStore({ wallet_signer_wallet: pemToStoredSigner(pem) }),
    stdout,
    stderr,
    isTTY: { stdin: tty, stdout: tty, stderr: tty },
    promptLine: async () => opts.prompt ?? "y",
  })
  return { deps, calls, stdout, stderr, paths: () => calls.map((call) => call.path) }
}

const base = ["transfer", "--wallet", "agent-one"]

describe("candle transfer (R19)", () => {
  test("to a linked wallet by name: confirm names the linked wallet, then build, relay sign and submit, one JSON receipt", async () => {
    const f = await fixture()
    const code = await run([...base, "--to", "treasury", "--asset", "USDC", "--amount", "250", "--json"], f.deps)
    expect(code).toBe(0)
    // The confirmation goes to stderr under --json and names the destination and its kind.
    expect(f.stderr.text).toContain(`to linked wallet treasury (lw-treasury, ${TREASURY})`)
    expect(f.stderr.text).toContain("Destination: a linked wallet on this account")
    expect(f.stderr.text).not.toContain("TEE")
    const build = f.calls.find((call) => call.path === "/api/v1/agent/transfer/build")
    expect(build?.body).toEqual({
      walletId: "wallet",
      chain: "solana",
      asset: "USDC",
      amountRaw: "250000000",
      to: TREASURY,
    })
    const sign = f.calls.find((call) => call.path === "/api/v1/agent/wallets/wallet/sign")
    expect((sign?.body as { body: { params: { transaction: string } } }).body.params.transaction).toBe("unsigned")
    expect(typeof (sign?.body as Record<string, unknown>).authorizationSignature).toBe("string")
    const submit = f.calls.find((call) => call.path === "/api/v1/agent/transfer/submit")
    expect(submit?.body).toEqual({ transferId: "tr-1", signedTransactionsBase64: [SIGNED] })
    // Order: resolve, confirm, build, sign, submit.
    const order = f.paths().filter((p) => p.includes("/transfer/") || p.endsWith("/sign"))
    expect(order).toEqual([
      "/api/v1/agent/transfer/build",
      "/api/v1/agent/wallets/wallet/sign",
      "/api/v1/agent/transfer/submit",
    ])
    const lines = f.stdout.text.trim().split("\n")
    expect(lines).toHaveLength(1)
    const receipt = JSON.parse(lines[0] as string)
    expect(receipt).toMatchObject({
      success: true,
      signature: "SoLSig111",
      transferId: "tr-1",
      walletId: "wallet",
      wallet: TEE,
      destinationKind: "linked",
      destination: { kind: "linked", address: TREASURY, id: "lw-treasury", label: "treasury" },
    })
  })

  test("--to vault resolves the wallet's pinned vaultDestination from its lifecycle, and max passes through", async () => {
    const f = await fixture()
    const code = await run([...base, "--to", "vault", "--asset", "SOL", "--amount", "max"], f.deps)
    expect(code).toBe(0)
    expect(f.paths()).toContain("/api/v1/agent/wallets/wallet/lifecycle")
    expect(f.stdout.text).toContain(`to this wallet's pinned vault ${VAULT}`)
    expect(f.stdout.text).toContain("the full spendable balance of SOL")
    const build = f.calls.find((call) => call.path === "/api/v1/agent/transfer/build")
    expect(build?.body).toEqual({ walletId: "wallet", chain: "solana", asset: "SOL", amountRaw: "max", to: VAULT })
    // Pretty-printed receipt (no --json) still carries the destination kind.
    expect(f.stdout.text).toContain('"destinationKind": "vault"')
  })

  test("--to vault with no pinned vault on Candle is refused before any build", async () => {
    const f = await fixture({ vault: null })
    const code = await run([...base, "--to", "vault", "--asset", "SOL", "--amount", "1", "--json"], f.deps)
    expect(code).toBe(1)
    expect(JSON.parse(f.stdout.text).code).toBe("VAULT_NOT_PINNED")
    expect(f.paths()).not.toContain("/api/v1/agent/transfer/build")
  })

  test("a --mint to the vault reads decimals over RPC and sends mint, not asset", async () => {
    const f = await fixture()
    const code = await run([...base, "--to", "vault", "--mint", MINT, "--amount", "1.5", "--yes"], f.deps)
    expect(code).toBe(0)
    expect(f.paths()).toContain("/rpc")
    const build = f.calls.find((call) => call.path === "/api/v1/agent/transfer/build")
    expect(build?.body).toEqual({ walletId: "wallet", chain: "solana", mint: MINT, amountRaw: "1500000", to: VAULT })
  })

  test("an address that is not a linked wallet is sent as an address, and the confirm says Candle decides", async () => {
    const f = await fixture()
    const code = await run([...base, "--to", STRANGER, "--asset", "SOL", "--amount", "0.5"], f.deps)
    expect(code).toBe(0)
    expect(f.stdout.text).toContain(`to address ${STRANGER}`)
    expect(f.stdout.text).toContain("Candle decides whether it is allowed")
    const build = f.calls.find((call) => call.path === "/api/v1/agent/transfer/build")
    expect(build?.body).toMatchObject({ to: STRANGER, amountRaw: "500000000" })
  })

  test("a linked wallet named by its address still reads as that linked wallet", async () => {
    const f = await fixture()
    const code = await run([...base, "--to", TREASURY, "--asset", "SOL", "--amount", "1"], f.deps)
    expect(code).toBe(0)
    expect(f.stdout.text).toContain(`to linked wallet treasury (lw-treasury, ${TREASURY})`)
  })

  test("the source wallet itself, an unknown name, and an ambiguous label are refused before any build", async () => {
    let f = await fixture()
    expect(await run([...base, "--to", TEE, "--asset", "SOL", "--amount", "1", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text).code).toBe("DESTINATION_IS_SOURCE")
    f = await fixture()
    expect(await run([...base, "--to", "nobody", "--asset", "SOL", "--amount", "1", "--json"], f.deps)).toBe(1)
    const unknown = JSON.parse(f.stdout.text)
    expect(unknown.code).toBe("DESTINATION_UNKNOWN")
    expect(unknown.message).toContain("treasury")
    f = await fixture({
      linked: [
        { _id: "lw-a", address: TREASURY, label: "dup" },
        { _id: "lw-b", address: STRANGER, label: "dup" },
      ],
    })
    expect(await run([...base, "--to", "dup", "--asset", "SOL", "--amount", "1", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text).code).toBe("DESTINATION_AMBIGUOUS")
    expect(f.paths()).not.toContain("/api/v1/agent/transfer/build")
  })

  test("a revoked linked wallet is not a name; its address is sent as an address for Candle to classify", async () => {
    const f = await fixture({ linked: [{ _id: "lw-old", address: TREASURY, label: "treasury", revokedAt: 5 }] })
    expect(await run([...base, "--to", "treasury", "--asset", "SOL", "--amount", "1", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text).code).toBe("DESTINATION_UNKNOWN")
  })

  test("declining the confirmation builds, signs and submits nothing", async () => {
    const f = await fixture({ prompt: "n" })
    const code = await run([...base, "--to", "treasury", "--asset", "USDC", "--amount", "1"], f.deps)
    expect(code).toBe(0)
    expect(f.paths().some((p) => p.includes("/transfer/") || p.endsWith("/sign"))).toBe(false)
    expect(f.stdout.text).toContain('"status": "cancelled"')
  })

  test("without a terminal and without --yes it is CONFIRMATION_REQUIRED, and nothing is built", async () => {
    const f = await fixture({ tty: false })
    const code = await run([...base, "--to", "treasury", "--asset", "USDC", "--amount", "1", "--json"], f.deps)
    expect(code).toBe(1)
    expect(JSON.parse(f.stdout.text).code).toBe("CONFIRMATION_REQUIRED")
    expect(f.paths()).not.toContain("/api/v1/agent/transfer/build")
  })

  test("--yes skips the prompt but still prints the destination", async () => {
    const f = await fixture({ tty: false })
    const code = await run([...base, "--to", "treasury", "--asset", "USDC", "--amount", "1", "--yes", "--json"], f.deps)
    expect(code).toBe(0)
    expect(f.stderr.text).toContain("to linked wallet treasury")
  })

  test("a key without transfer:bound is refused with the mint-and-rebind hint before any build", async () => {
    const f = await fixture({ scopes: ["swap:write", "transfer:write"] })
    const code = await run([...base, "--to", "treasury", "--asset", "USDC", "--amount", "1", "--json"], f.deps)
    expect(code).toBe(1)
    const failure = JSON.parse(f.stdout.text)
    expect(failure.code).toBe("SCOPE_MISSING")
    expect(failure.message).toContain("candle keys create --access read-write-transfer")
    expect(failure.message).toContain("candle tee rebind")
    expect(f.paths()).not.toContain("/api/v1/agent/transfer/build")
  })

  test("a key without transfer:write cannot pay at all", async () => {
    const f = await fixture({ scopes: ["swap:write"] })
    const code = await run([...base, "--to", "treasury", "--asset", "USDC", "--amount", "1", "--json"], f.deps)
    expect(code).toBe(1)
    expect(JSON.parse(f.stdout.text).message).toContain("transfer:write")
  })

  test("the embedded wallet is refused as a payer: this command moves a linked wallet", async () => {
    const f = await fixture({ teeWallets: 0 })
    const code = await run(["transfer", "--to", "treasury", "--asset", "USDC", "--amount", "1", "--json"], f.deps)
    expect(code).toBe(1)
    expect(JSON.parse(f.stdout.text).code).toBe("PAYER_UNSUPPORTED")
    expect(f.paths()).not.toContain("/api/v1/agent/transfer/build")
  })

  test("Candle's refusal at build is reported with its code and nothing is signed", async () => {
    const f = await fixture({
      build: {
        error: {
          code: "TRANSFER_DESTINATION_NOT_APPROVED",
          message:
            "From this wallet, funds can only go to a wallet you linked while signed in or marked trusted, or to this wallet's vault.",
        },
      },
    })
    const code = await run([...base, "--to", STRANGER, "--asset", "SOL", "--amount", "1", "--yes", "--json"], f.deps)
    expect(code).toBe(1)
    expect(JSON.parse(f.stdout.text).code).toBe("TRANSFER_DESTINATION_NOT_APPROVED")
    expect(f.paths().some((p) => p.endsWith("/sign"))).toBe(false)
  })

  test("a build that names another payer, or returns no transaction, is refused before signing", async () => {
    let f = await fixture({ build: { payerAddress: EMBEDDED } })
    expect(await run([...base, "--to", "vault", "--asset", "SOL", "--amount", "1", "--yes", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text).code).toBe("INVALID_RESPONSE")
    expect(f.paths().some((p) => p.endsWith("/sign"))).toBe(false)
    f = await fixture({ build: { unsignedTransactionsBase64: [] } })
    expect(await run([...base, "--to", "vault", "--asset", "SOL", "--amount", "1", "--yes", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text).code).toBe("INVALID_RESPONSE")
  })

  test("usage: --to and --amount are required, --asset and --mint are exclusive, USDG is not a Solana asset, no request is made", async () => {
    for (const argv of [
      ["transfer"],
      ["transfer", "--to", "vault", "--amount", "1"],
      ["transfer", "--to", "vault", "--asset", "SOL"],
      ["transfer", "--to", "vault", "--asset", "SOL", "--mint", MINT, "--amount", "1"],
      ["transfer", "--to", "vault", "--asset", "USDG", "--amount", "1"],
      ["transfer", "--to", "vault", "--mint", "not-a-mint", "--amount", "1"],
      ["transfer", "extra", "--to", "vault", "--asset", "SOL", "--amount", "1"],
      ["transfer", "--to", "vault", "--asset", "SOL", "--amount", "1", "--bogus"],
    ]) {
      const f = await fixture()
      expect(await run(argv, f.deps)).toBe(2)
      expect(f.calls).toHaveLength(0)
    }
    const f = await fixture()
    expect(await run([...base, "--to", "vault", "--asset", "SOL", "--amount", "abc", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text).code).toBe("INVALID_AMOUNT")
    expect(f.calls).toHaveLength(0)
  })

  test("a device credential alone cannot transfer", async () => {
    const f = await fixture()
    f.deps.env = { CANDLE_CONFIG_DIR: f.deps.env.CANDLE_CONFIG_DIR ?? "" }
    const code = await run([...base, "--to", "vault", "--asset", "SOL", "--amount", "1", "--json"], f.deps)
    expect(code).toBe(1)
    expect(JSON.parse(f.stdout.text).code).toBe("API_KEY_REQUIRED")
  })
})
