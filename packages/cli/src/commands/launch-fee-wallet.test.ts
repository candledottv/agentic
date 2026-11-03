/**
 * BE-2519: `candle launch --fee-wallet` (with its Squads multisig pair): validated before any
 * request, passed on the build request, and shown in the preview and `--check`. The multisig
 * derivation is the API's own (apps/api/src/lib/fee-wallet.ts), so the fixture derives a real
 * Squads v4 vault the same way.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Keypair, PublicKey } from "@solana/web3.js"
import { humanText } from "../human-output.test-support"
import { run } from "../index"
import { pemToStoredSigner } from "../secret-store"
import { createCapture, createFakeStore, createTestDeps } from "../test-support"

const WALLET = Keypair.generate().publicKey.toBase58()
const FEE_WALLET = Keypair.generate().publicKey.toBase58()
const SQUADS_V4_PROGRAM_ID = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf")
const multisig = Keypair.generate().publicKey
const vaultAt = (index: number) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("multisig"), multisig.toBuffer(), Buffer.from("vault"), Buffer.from([index])],
    SQUADS_V4_PROGRAM_ID,
  )[0].toBase58()
const VAULT = vaultAt(2)
const MULTISIG = multisig.toBase58()

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

/** The preflight facts `--check` reads, as launch-check.test.ts serves them. */
function preflightBody() {
  return {
    success: true,
    key: {
      keyPrefix: "cndl_live_check",
      environment: "production",
      scopes: ["launch:write"],
      tier: "max",
      selfLaunch: true,
      embeddedWalletPermission: "allowed",
    },
    switches: { headlessLaunch: true, agentTrading: true, teeLaunchBuys: false },
    embedded: { solana: { address: WALLET, delegated: true }, evm: null },
    wallets: [{ id: "wallet", address: WALLET, chain: "solana", label: "tee", allowLaunch: true, active: true }],
  }
}

/**
 * The self-route surface the fee wallet rides: the trading wallets, the dry run (echoing the fee
 * wallet as the API does), a build that records its body, the job read, and the --check preflight.
 */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "candle-fee-wallet-"))
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
        feeWallet: body.feeWallet ?? WALLET,
      })
    if (path === "/api/v1/launch/self/build") return ok({ success: true, built: true })
    if (path.startsWith("/api/v1/launch/headless/jobs/"))
      return ok({ error: { code: "JOB_NOT_FOUND", message: "not found" } }, 404)
    if (path === "/api/v1/launch/preflight") return ok(preflightBody())
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

describe("BE-2519: candle launch --fee-wallet", () => {
  test("the flag reaches the self build request, and the multisig pair rides with it", async () => {
    const f = await fixture()
    // The fake build answers nothing signable: reaching it with the body is the assertion.
    await run([...launchArgs, "--fee-wallet", FEE_WALLET], f.deps)
    expect(f.calls.find((c) => c.path === "/api/v1/launch/self/build")?.body).toMatchObject({
      feeWallet: FEE_WALLET,
    })
    expect(f.calls.find((c) => c.path === "/api/v1/launch/self/build")?.body).not.toHaveProperty("feeWalletMultisig")
    const squads = await fixture()
    await run(
      [
        ...launchArgs,
        "--fee-wallet",
        VAULT,
        "--fee-wallet-multisig",
        MULTISIG,
        "--fee-wallet-multisig-vault-index",
        "2",
      ],
      squads.deps,
    )
    expect(squads.calls.find((c) => c.path === "/api/v1/launch/self/build")?.body).toMatchObject({
      feeWallet: VAULT,
      feeWalletMultisig: { address: MULTISIG, vaultIndex: 2 },
    })
  })

  test("omitted flags keep today's default: no fee wallet field on the body", async () => {
    const f = await fixture()
    await run(launchArgs, f.deps)
    const body = f.calls.find((c) => c.path === "/api/v1/launch/self/build")?.body ?? {}
    expect(body).not.toHaveProperty("feeWallet")
    expect(body).not.toHaveProperty("feeWalletMultisig")
  })

  test("the preview names the chosen fee wallet, the multisig, and the default", async () => {
    const chosen = await fixture()
    expect(await run([...launchArgs, "--fee-wallet", FEE_WALLET, "--dry-run"], chosen.deps)).toBe(0)
    expect(humanText(chosen.stderr.text)).toContain(
      humanText(`Fee wallet: ${FEE_WALLET} (earns this launch's fees; set by --fee-wallet)`),
    )
    const squads = await fixture()
    expect(
      await run(
        [
          ...launchArgs,
          "--fee-wallet",
          VAULT,
          "--fee-wallet-multisig",
          MULTISIG,
          "--fee-wallet-multisig-vault-index",
          "2",
          "--dry-run",
        ],
        squads.deps,
      ),
    ).toBe(0)
    expect(humanText(squads.stderr.text)).toContain(
      humanText(`Fee wallet multisig: ${MULTISIG}, vault 2 (the Squads v4 multisig behind the fee wallet)`),
    )
    const defaulted = await fixture()
    expect(await run([...launchArgs, "--dry-run"], defaulted.deps)).toBe(0)
    expect(humanText(defaulted.stderr.text)).toContain(
      humanText(`Fee wallet: ${WALLET} (defaults to the account wallet; pass --fee-wallet <address> to change it)`),
    )
  })

  test("an invalid fee wallet is a usage error before any request", async () => {
    const bad: string[][] = [
      ["--fee-wallet", "not-an-address"],
      ["--fee-wallet", "11111111111111111111111111111111", "--fee-wallet-multisig", MULTISIG],
      ["--fee-wallet", VAULT],
      ["--fee-wallet", VAULT, "--fee-wallet-multisig", MULTISIG],
      ["--fee-wallet", VAULT, "--fee-wallet-multisig", MULTISIG, "--fee-wallet-multisig-vault-index", "256"],
      ["--fee-wallet", VAULT, "--fee-wallet-multisig", MULTISIG, "--fee-wallet-multisig-vault-index", "3"],
      ["--fee-wallet-multisig", MULTISIG],
    ]
    for (const flags of bad) {
      const f = await fixture()
      expect(await run([...launchArgs, ...flags], f.deps)).toBe(2)
      expect(f.paths()).toEqual([])
    }
  })

  test("--check shows the fee wallet, chosen or defaulted, and still makes only its one call", async () => {
    const chosen = await fixture()
    expect(await run(["launch", "--check", "--fee-wallet", FEE_WALLET, "--json"], chosen.deps)).toBe(0)
    expect(chosen.paths()).toEqual(["/api/v1/launch/preflight"])
    const out = JSON.parse(chosen.stdout.text.trimEnd().split("\n").at(-1) ?? "")
    expect(out.feeWallet).toEqual({ feeWallet: FEE_WALLET, set: true })
    const defaulted = await fixture()
    expect(await run(["launch", "--check"], defaulted.deps)).toBe(0)
    expect(defaulted.paths()).toEqual(["/api/v1/launch/preflight"])
    expect(humanText(defaulted.stdout.text)).toContain(
      humanText("Fee wallet: defaults to the account wallet (pass --fee-wallet <address> to change it)."),
    )
  })

  // BE-2572 (W6): a real warning on a live launch, and the opt-in refusal.
  test("a live launch warns on stderr when the fee wallet defaults, and a chosen one does not", async () => {
    const defaulted = await fixture()
    await run(launchArgs, defaulted.deps)
    expect(humanText(defaulted.stderr.text)).toContain(
      humanText(
        "No --fee-wallet given: this launch's curve and pool fees earn to the account wallet. Pass --fee-wallet <address> to send them to another wallet.",
      ),
    )
    const chosen = await fixture()
    await run([...launchArgs, "--fee-wallet", FEE_WALLET], chosen.deps)
    expect(humanText(chosen.stderr.text)).not.toContain("No --fee-wallet given")
    // A dry run is not a live launch: the preview's ordinary info line says the default, loudly not.
    const dry = await fixture()
    expect(await run([...launchArgs, "--dry-run"], dry.deps)).toBe(0)
    expect(humanText(dry.stderr.text)).not.toContain("No --fee-wallet given")
  })

  test("--require-fee-wallet refuses a launch without --fee-wallet, before any request", async () => {
    for (const extra of [["--dry-run"], [], ["--check"]] as string[][]) {
      const f = await fixture()
      expect(await run([...launchArgs.slice(0, -1), "--require-fee-wallet", ...extra], f.deps)).toBe(2)
      expect(f.paths()).toEqual([])
      expect(humanText(f.stderr.text)).toContain("--require-fee-wallet needs --fee-wallet")
    }
    // With a fee wallet given, the strict flag changes nothing: the build is reached as today.
    const ok = await fixture()
    await run([...launchArgs, "--fee-wallet", FEE_WALLET, "--require-fee-wallet"], ok.deps)
    expect(ok.calls.find((c) => c.path === "/api/v1/launch/self/build")?.body).toMatchObject({
      feeWallet: FEE_WALLET,
    })
  })
})
