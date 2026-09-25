/**
 * BE-391 (spec `2026-09-24-ember-phase-4b-hood-tee-wallets-design.md`, D1), end to end through
 * `run()`: H3 (EVM promote, both modes, version 4, the path, the scan start), H9 (fund, transfer
 * from a Hood TEE wallet, sweep normal and `--emergency`, demote, the gas refusal, the lock reads,
 * restore then log discovery) and the command half of H13 (backup carries the record, verify-backup
 * runs the ninth check).
 *
 * The Hood node is a stateful fake JSON-RPC: it decodes every raw transaction it is sent (viem),
 * moves the balances that transaction moves, answers receipts and nonces from what it has seen, and
 * serves `Transfer` logs from a script. The Candle API is a route table recording every call, so
 * "--emergency makes no Candle API call" is a count, not a claim.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { keccak256, parseTransaction, recoverTransactionAddress } from "viem"
import { mnemonicToAccount } from "viem/accounts"
import type { Deps } from "../deps"
import { HOOD_WETH_ADDRESS, toChecksumAddress } from "../evm-lite"
import { FIXTURE_EVM_0, FIXTURE_EVM_1 } from "../evm-lite.test"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"
import { VaultError } from "../vault/errors"
import { appendEvmRecordEntry, evmRecordPath, readEvmRecord } from "../vault/evm-record"
import { appendEvmRecordForTrade, assertWalletLockFree, readHoodTeeServer } from "../vault/evm-tee"
import { closeVault } from "../vault/store"
import {
  FIXTURE_PASSPHRASE,
  FIXTURE_PHRASE,
  generatedPassphraseFrom,
  makeVault,
  readVaultJson,
  reopen,
  tempDir,
  testClock,
  useCheapKdf,
} from "../vault/test-vault"

setDefaultTimeout(120_000)
useCheapKdf()

const HOOD_HOST = "rpc.mainnet.chain.robinhood.com"
const API = "https://api.evm-tee.test"
const API_KEY = `cndl_live_${"evmtestk".padEnd(43, "x")}`
const ACCOUNT = "EvmTeeAccount1111111111111111111abcd"
const ETH = 1_000_000_000_000_000_000n
const USDG = toChecksumAddress("0x5fc5360d0400a0fd4f2af552add042d716f1d168")
const TOKEN_RECORD = "0xAaAaaAAaaAaAAaAaAAaaaaAAaaaAaaaAaaaaaAAA"
const TOKEN_SERVER = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"
const TOKEN_FLAG = "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
const TOKEN_LOGS = "0xdDdDddDdDdddDDddDDddDDDDdDdDDdDDdDDDDDDd"
const OTHER = "0x000000000000000000000000000000000000dEaD"
/** The fixture root's EVM TEE index 0, `m/44'/60'/0'/1'/0'`, from viem, independently of this CLI. */
const TEE_0 = mnemonicToAccount(FIXTURE_PHRASE, { path: "m/44'/60'/0'/1'/0'" }).address
const TEE_1 = mnemonicToAccount(FIXTURE_PHRASE, { path: "m/44'/60'/1'/1'/0'" }).address

const hex = (value: bigint) => `0x${value.toString(16)}`
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`
const lower = (value: string) => value.toLowerCase()

// ── The Hood node ─────────────────────────────────────────────────────────────────────────────

interface Sent {
  hash: string
  from: string
  to: string
  nonce: number
  value: bigint
  data: string
  kind: "erc20" | "native"
  token?: string
  recipient?: string
  amount?: bigint
  maxFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
}

function hoodNode(start: { head?: bigint } = {}) {
  const state = {
    head: start.head ?? 5_000n,
    baseFee: 100n,
    tip: 10n,
    eth: new Map<string, bigint>(),
    tokens: new Map<string, bigint>(),
    latest: new Map<string, bigint>(),
    pendingExtra: new Map<string, bigint>(),
    /** The next `eth_sendRawTransaction` answers HTTP 429 and is not accepted. */
    failNextSend: false,
    /** Hashes `eth_getTransactionByHash` answers even when this node has no receipt. */
    knownHashes: new Set<string>(),
    receipts: new Map<string, { status: number; blockNumber: bigint }>(),
    logs: [] as Array<{ address: string; to: string; blockNumber: bigint }>,
    sent: [] as Sent[],
    methods: [] as string[],
    logRanges: [] as Array<{ from: bigint; to: bigint }>,
    /** Shifted by each `eth_chainId`; empty means Hood (4663). */
    chainIdSequence: [] as bigint[],
    /** A token whose transfer estimates at this gas instead of 50,000 (a hostile or odd contract). */
    tokenGas: new Map<string, bigint>(),
  }
  const tokenKey = (token: string, owner: string) => `${lower(token)}:${lower(owner)}`
  const effective = () => state.baseFee + state.tip
  const handle = async (body: { id: number; method: string; params: unknown[] }) => {
    state.methods.push(body.method)
    const p = body.params
    switch (body.method) {
      case "eth_chainId": {
        const next = state.chainIdSequence.shift()
        return hex(next ?? 4663n)
      }
      case "eth_blockNumber":
        return hex(state.head)
      case "eth_getTransactionCount": {
        const address = lower(p[0] as string)
        const latest = state.latest.get(address) ?? 0n
        return hex(p[1] === "pending" ? latest + (state.pendingExtra.get(address) ?? 0n) : latest)
      }
      case "eth_feeHistory":
        return { oldestBlock: "0x1", baseFeePerGas: [hex(state.baseFee), hex(state.baseFee)], reward: [["0x1"]] }
      case "eth_maxPriorityFeePerGas":
        return hex(state.tip)
      case "eth_getBalance":
        return hex(state.eth.get(lower(p[0] as string)) ?? 0n)
      case "eth_estimateGas": {
        const call = p[0] as { to?: string; data?: string }
        if (!call.data?.startsWith("0xa9059cbb")) return hex(21_000n)
        return hex(state.tokenGas.get(lower(call.to ?? "")) ?? 50_000n)
      }
      case "eth_call": {
        const call = p[0] as { to: string; data: string }
        if (call.data.startsWith("0x70a08231")) {
          const owner = `0x${call.data.slice(-40)}`
          return word(state.tokens.get(tokenKey(call.to, owner)) ?? 0n)
        }
        if (call.data.startsWith("0x313ce567")) return word(lower(call.to) === lower(USDG) ? 6n : 18n)
        if (call.data.startsWith("0x95d89b41")) {
          const bytes = Buffer.from(lower(call.to) === lower(USDG) ? "USDG" : "TOK", "utf8")
          return `0x${word(32n).slice(2)}${word(BigInt(bytes.length)).slice(2)}${bytes.toString("hex").padEnd(64, "0")}`
        }
        return word(0n)
      }
      case "eth_getLogs": {
        const filter = p[0] as { fromBlock: string; toBlock: string; topics: Array<string | null> }
        const from = BigInt(filter.fromBlock)
        const to = BigInt(filter.toBlock)
        state.logRanges.push({ from, to })
        const target = lower(filter.topics[2] as string).slice(-40)
        return state.logs
          .filter((log) => log.blockNumber >= from && log.blockNumber <= to && lower(log.to).slice(2) === target)
          .map((log) => ({ address: lower(log.address), blockNumber: hex(log.blockNumber) }))
      }
      case "eth_sendRawTransaction": {
        const raw = p[0] as `0x${string}`
        const tx = parseTransaction(raw)
        const from = await recoverTransactionAddress({ serializedTransaction: raw as never })
        const hash = keccak256(raw)
        const data = (tx.data ?? "0x") as string
        const erc20 = data.startsWith("0xa9059cbb")
        const gasUsed = erc20 ? 50_000n : 21_000n
        const price = effective() < (tx.maxFeePerGas ?? 0n) ? effective() : (tx.maxFeePerGas ?? 0n)
        const sender = lower(from)
        state.eth.set(sender, (state.eth.get(sender) ?? 0n) - gasUsed * price - (tx.value ?? 0n))
        const sent: Sent = {
          hash,
          from,
          to: tx.to as string,
          nonce: tx.nonce as number,
          value: tx.value ?? 0n,
          data,
          kind: erc20 ? "erc20" : "native",
          maxFeePerGas: tx.maxFeePerGas,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        }
        if (erc20) {
          const recipient = `0x${data.slice(34, 74)}`
          const amount = BigInt(`0x${data.slice(74, 138)}`)
          const token = tx.to as string
          state.tokens.set(tokenKey(token, sender), (state.tokens.get(tokenKey(token, sender)) ?? 0n) - amount)
          state.tokens.set(tokenKey(token, recipient), (state.tokens.get(tokenKey(token, recipient)) ?? 0n) + amount)
          Object.assign(sent, { token, recipient, amount })
        } else {
          const to = lower(tx.to as string)
          state.eth.set(to, (state.eth.get(to) ?? 0n) + (tx.value ?? 0n))
        }
        state.latest.set(sender, (state.latest.get(sender) ?? 0n) + 1n)
        state.receipts.set(hash, { status: 1, blockNumber: state.head })
        state.sent.push(sent)
        return hash
      }
      case "eth_getTransactionReceipt": {
        const receipt = state.receipts.get(p[0] as string)
        if (receipt === undefined) return null
        return { status: hex(BigInt(receipt.status)), blockNumber: hex(receipt.blockNumber), transactionHash: p[0] }
      }
      case "eth_getTransactionByHash": {
        const hash = p[0] as string
        if (!state.knownHashes.has(hash) && !state.receipts.has(hash)) return null
        return { hash }
      }
      default:
        throw new Error(`unexpected RPC method ${body.method}`)
    }
  }
  return {
    state,
    setEth: (address: string, wei: bigint) => state.eth.set(lower(address), wei),
    setToken: (token: string, owner: string, raw: bigint) => state.tokens.set(tokenKey(token, owner), raw),
    tokenOf: (token: string, owner: string) => state.tokens.get(tokenKey(token, owner)) ?? 0n,
    ethOf: (address: string) => state.eth.get(lower(address)) ?? 0n,
    handle,
  }
}

// ── The Candle API ────────────────────────────────────────────────────────────────────────────

const ENCRYPTION_PUBLIC_KEY = await (async () => {
  const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  return Buffer.from(await crypto.subtle.exportKey("raw", receiver.publicKey)).toString("base64")
})()

function candleApi() {
  const state = {
    calls: [] as Array<{ method: string; path: string; body: Record<string, unknown> }>,
    lifecycle: "enabled",
    activeOperation: null as null | { operationId: string; kind: string; expiresAt: number },
    hoodTeeFails: false,
    tradedTokens: [] as string[],
    imports: 0,
    /** Address recorded at import, keyed by the linked-wallet id the submit returned. */
    importedAddress: new Map<string, string>(),
    /** When set, every hood-tee response uses this address instead of the imported one. */
    hoodTeeAddress: undefined as string | undefined,
    /** When set, the hood-tee response omits `address`. */
    omitHoodTeeAddress: false,
  }
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  const handle = (method: string, path: string, body: Record<string, unknown>): Response => {
    state.calls.push({ method, path, body })
    if (path === "/api/v1/agent/wallets/import/init") {
      return json(200, { success: true, encryptionPublicKey: ENCRYPTION_PUBLIC_KEY })
    }
    if (path === "/api/v1/agent/wallets/import/submit") {
      state.imports += 1
      const id = `lw_hood_${state.imports}`
      if (typeof body.address === "string") state.importedAddress.set(id, body.address)
      return json(200, {
        success: true,
        id,
        address: body.address,
        chain: "evm",
        profile: "ember-tee",
        boundKeyPrefix: "evmtestk",
        vaultDestination: body.vaultDestination,
        remoteAuthority: "verified-active",
      })
    }
    if (path === "/api/v1/agent/wallets/embedded") return json(200, { success: true, account: ACCOUNT })
    if (path === "/api/v1/agent/wallets/room") {
      return json(200, { success: true, tier: "max", active: 0, cap: 1000, room: 1000 })
    }
    if (path === "/api/v1/agent/keys") return json(401, { success: false, error: { code: "UNAUTHORIZED" } })
    if (path === "/api/v1/activity/report") return json(200, { success: true })
    const lifecycle = /^\/api\/v1\/agent\/wallets\/([^/]+)\/lifecycle$/.exec(path)
    if (lifecycle) return json(200, { success: true, id: lifecycle[1], state: state.lifecycle })
    const hoodTee = /^\/api\/v1\/agent\/wallets\/([^/]+)\/hood-tee$/.exec(path)
    if (hoodTee) {
      if (state.hoodTeeFails) {
        return json(503, {
          success: false,
          error: { code: "VALIDATION_FAILED", message: "lock read down", retryable: true },
        })
      }
      const imported = state.importedAddress.get(hoodTee[1] as string)
      const address = state.hoodTeeAddress ?? imported
      return json(200, {
        success: true,
        id: hoodTee[1],
        ...(state.omitHoodTeeAddress || address === undefined ? {} : { address }),
        activeOperation: state.activeOperation,
        tradedTokens: state.tradedTokens,
        tradedTokensTruncated: false,
      })
    }
    if (/^\/api\/v1\/agent\/wallets\/[^/]+\/swept$/.test(path)) return json(200, { success: true, state: "swept" })
    if (method === "DELETE" && /^\/api\/v1\/agent\/wallets\/[^/]+$/.test(path)) {
      state.lifecycle = "quarantined"
      return json(200, { success: true, state: "quarantined", complete: true, remoteAuthority: "verified-denied" })
    }
    throw new Error(`no route for ${method} ${path}`)
  }
  return { state, handle }
}

// ── The fixture ───────────────────────────────────────────────────────────────────────────────

async function fixture(opts: { dir?: string; passphrase?: string; vaultPath?: string } = {}) {
  let dir = opts.dir
  let passphrase = opts.passphrase ?? FIXTURE_PASSPHRASE
  if (dir === undefined) {
    const made = await makeVault()
    closeVault(made.vault)
    dir = made.dir
    passphrase = made.passphrase
  }
  const node = hoodNode()
  const api = candleApi()
  const stdout = createCapture()
  const stderr = createCapture()
  const prompts: string[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : {}
    if (url.host === HOOD_HOST) {
      if (body.method === "eth_sendRawTransaction" && node.state.failNextSend) {
        node.state.failNextSend = false
        return new Response("rate limited", { status: 429 })
      }
      const result = await node.handle(body)
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return api.handle(init?.method ?? "GET", url.pathname, body)
  }) as typeof fetch
  const deps: Deps = createTestDeps({
    fetch: fetchFn,
    stdout,
    stderr,
    env: { CANDLE_CONFIG_DIR: dir, HOME: dir, CANDLE_API_URL: API, CANDLE_API_KEY: API_KEY },
    isTTY: { stdin: true, stdout: true, stderr: true },
    readFile: (path: string) => readFile(path, "utf8"),
    promptSecret: async (prompt) => {
      prompts.push(prompt)
      return passphrase
    },
    promptLine: async (prompt) => {
      prompts.push(prompt)
      if (prompt.startsWith("Type confirm")) return "confirm"
      const match = /\(([^)]+)\) to confirm/.exec(prompt)
      return (match?.[1] ?? "").slice(-6)
    },
  })
  const vaultPath = opts.vaultPath ?? join(dir, "vault.enc")
  const cli = async (args: string[]) => {
    stdout.text = ""
    stderr.text = ""
    return run(args, deps)
  }
  return { dir, passphrase, vaultPath, node, api, stdout, stderr, prompts, deps, cli }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

function lastJson(text: string): Record<string, unknown> {
  return JSON.parse(text.trimEnd().split("\n").at(-1) ?? "{}")
}

/** A vault with `hood-cold` (EVM vault key 0) and a fresh Hood TEE wallet promoted from it. */
async function promoted(): Promise<Fixture & { wallet: string }> {
  const fx = await fixture()
  expect(await fx.cli(["vault", "new-key", "--chain", "evm", "--label", "hood-cold"])).toBe(0)
  expect(await fx.cli(["vault", "promote", "--from", "hood-cold", "--json"])).toBe(0)
  const wallet = lastJson(fx.stdout.text).address as string
  return { ...fx, wallet }
}

// ── H3 ────────────────────────────────────────────────────────────────────────────────────────

describe("H3: vault promote on EVM", () => {
  test("--from: a fresh key on m/44'/60'/n'/1'/0', version 4 with the record key, imported as evm, scan start recorded", async () => {
    const fx = await fixture()
    expect(await fx.cli(["vault", "new-key", "--chain", "evm", "--label", "hood-cold"])).toBe(0)
    expect((await readVaultJson(fx.vaultPath)).version).toBe(2)
    fx.node.state.head = 7_777n

    expect(await fx.cli(["vault", "promote", "--from", "hood-cold", "--json"])).toBe(0)
    const doc = lastJson(fx.stdout.text)
    expect(doc).toMatchObject({
      mode: "fresh",
      chain: "evm",
      address: TEE_0,
      path: "m/44'/60'/0'/1'/0'",
      vaultDestination: FIXTURE_EVM_0,
      lifecycle: "enabled",
      linkedWalletId: "lw_hood_1",
      importCalls: 1,
      scanStart: { block: "7777", recorded: true },
      vaultVersion: 4,
    })
    const submit = fx.api.state.calls.find((call) => call.path === "/api/v1/agent/wallets/import/submit")
    expect(submit?.body).toMatchObject({
      chain: "evm",
      address: TEE_0,
      profile: "ember-tee",
      vaultDestination: FIXTURE_EVM_0,
    })
    // The key never travels in the clear: the body carries HPKE ciphertext only.
    expect(JSON.stringify(submit?.body)).not.toMatch(/"privateKey"/)

    const file = await readVaultJson(fx.vaultPath)
    expect(file.version).toBe(4)
    expect(file.evmRecordPublicKey).toBeDefined()
    const vault = await reopen(fx.vaultPath, fx.passphrase)
    try {
      const entry = vault.index.entries.find((candidate) => candidate.address === TEE_0)
      expect(entry).toMatchObject({
        chain: "evm",
        role: "tee-wallet",
        derivation: { scheme: "bip32-secp256k1", path: "m/44'/60'/0'/1'/0'" },
        exposure: { everRemoteExposed: true, everExported: false },
        tee: {
          network: "hood-mainnet",
          lifecycle: "enabled",
          vaultDestination: FIXTURE_EVM_0,
          remoteAuthority: "verified-active",
        },
      })
      expect(vault.index.hd.nextIndex.evmTee).toBe(1)
      expect(vault.index.hd.exposedIndexes.evmTee).toEqual([0])
      // The record is beside the vault, not in the index.
      const record = await readEvmRecord(vault)
      expect(record.entries).toEqual([{ kind: "scanStart", wallet: TEE_0, block: 7777 }])
      expect(JSON.stringify(vault.index)).not.toContain("scanStart")
    } finally {
      closeVault(vault)
    }

    // A second promote on the same vault adds its own scan start; the version stays 4.
    fx.node.state.head = 8_000n
    expect(await fx.cli(["vault", "promote", "--from", "hood-cold", "--json"])).toBe(0)
    expect(lastJson(fx.stdout.text)).toMatchObject({ address: TEE_1, path: "m/44'/60'/1'/1'/0'" })
    const again = await reopen(fx.vaultPath, fx.passphrase)
    try {
      expect((await readEvmRecord(again)).entries).toEqual([
        { kind: "scanStart", wallet: TEE_0, block: 7777 },
        { kind: "scanStart", wallet: TEE_1, block: 8000 },
      ])
      expect(again.file.version).toBe(4)
    } finally {
      closeVault(again)
    }
  })

  test("the EVM TEE path is on no wallet app's scan list", async () => {
    const { WALLET_APP_EVM_SCAN_PATTERNS, evmTeePath } = await import("../vault/hd")
    for (let n = 0; n < 50; n++) {
      for (const { pattern } of WALLET_APP_EVM_SCAN_PATTERNS) expect(pattern.test(evmTeePath(n))).toBe(false)
    }
    // And the patterns do match what those apps scan, so the check is not vacuous.
    expect(WALLET_APP_EVM_SCAN_PATTERNS.map(({ pattern }) => pattern.test("m/44'/60'/0'/0/3"))).toContain(true)
    expect(WALLET_APP_EVM_SCAN_PATTERNS.map(({ pattern }) => pattern.test("m/44'/60'/4'/0/0"))).toContain(true)
    expect(WALLET_APP_EVM_SCAN_PATTERNS.map(({ pattern }) => pattern.test("m/44'/60'/0'/4"))).toContain(true)
  })

  test("--in-place: holdings, the sentence, last six and confirm, then version 4 and the promote height only", async () => {
    const fx = await fixture()
    expect(await fx.cli(["vault", "new-key", "--chain", "evm", "--label", "hood-cold"])).toBe(0)
    expect(await fx.cli(["vault", "new-key", "--chain", "evm", "--label", "hood-hot"])).toBe(0)
    fx.node.setEth(FIXTURE_EVM_1, 3n * ETH)
    fx.node.setToken(USDG, FIXTURE_EVM_1, 12_500_000n)
    fx.node.state.head = 9_100n
    fx.prompts.length = 0
    fx.deps.env.CANDLE_SOLANA_RPC_URL = "http://remote.example"

    expect(await fx.cli(["vault", "promote", "--in-place", "hood-hot", "--sweep-to", "hood-cold"])).toBe(0)
    expect(fx.stdout.text).toContain(`Holdings at ${FIXTURE_EVM_1} on Hood`)
    expect(fx.stdout.text).toContain("ETH   3")
    expect(fx.stdout.text).toContain("USDG  12.5")
    expect(fx.stdout.text).toContain("You are about to accept a permanent copy of this key in Privy's TEE")
    expect(fx.stdout.text).toContain(`Promoted ${FIXTURE_EVM_1} in place on Hood`)
    expect(fx.prompts.some((prompt) => prompt.includes(`the address being promoted (${FIXTURE_EVM_1})`))).toBe(true)
    expect(fx.prompts.some((prompt) => prompt.startsWith("Type confirm"))).toBe(true)

    const vault = await reopen(fx.vaultPath, fx.passphrase)
    try {
      expect(vault.file.version).toBe(4)
      const entry = vault.index.entries.find((candidate) => candidate.address === FIXTURE_EVM_1)
      expect(entry).toMatchObject({
        role: "tee-wallet",
        derivation: { path: "m/44'/60'/1'/0/0" },
        tee: { network: "hood-mainnet", lifecycle: "enabled", vaultDestination: FIXTURE_EVM_0 },
      })
      expect(entry?.tee?.promotedInPlaceAt).toBeDefined()
      expect(vault.index.hd.exposedIndexes.evm).toEqual([1])
      expect((await readEvmRecord(vault)).entries).toEqual([{ kind: "scanStart", wallet: FIXTURE_EVM_1, block: 9100 }])
    } finally {
      closeVault(vault)
    }
  })

  test("a promote whose scan start cannot be written still succeeds and prints the height and --from-block", async () => {
    const fx = await fixture()
    expect(await fx.cli(["vault", "new-key", "--chain", "evm", "--label", "hood-cold"])).toBe(0)
    fx.node.state.head = 4_242n
    await mkdir(`${evmRecordPath(fx.vaultPath)}.lock`)
    expect(await fx.cli(["vault", "promote", "--from", "hood-cold", "--json"])).toBe(0)
    expect(lastJson(fx.stdout.text)).toMatchObject({ scanStart: { block: "4242", recorded: false } })
    expect(fx.stderr.text).toContain("The promote height, Hood block 4242, was not written to the sealed EVM record")
    expect(fx.stderr.text).toContain(`candle tee sweep ${TEE_0} --from-block 4242`)
    expect((await readVaultJson(fx.vaultPath)).version).toBe(4)
  })

  test("promote-batch: a file of EVM keys becomes Hood TEE wallets under one confirm, each with its scan start; a mixed file is refused", async () => {
    const fx = await fixture()
    expect(await fx.cli(["vault", "new-key", "--chain", "evm", "--label", "hood-cold"])).toBe(0)
    expect(await fx.cli(["vault", "new-key", "--chain", "evm", "--label", "hood-a"])).toBe(0)
    expect(await fx.cli(["vault", "new-key", "--chain", "evm", "--label", "hood-b"])).toBe(0)
    expect(await fx.cli(["vault", "new-key", "--chain", "solana", "--label", "sol-a"])).toBe(0)
    const file = join(fx.dir, "pairs.txt")
    await Bun.write(file, "hood-a hood-cold\nhood-b hood-cold\n")
    fx.node.state.head = 6_060n
    fx.deps.env.CANDLE_SOLANA_RPC_URL = "http://remote.example"
    expect(await fx.cli(["vault", "promote-batch", "--pairs-from", file, "--json"])).toBe(0)
    expect(fx.stderr.text).toContain("ETH, USDG and WETH read for 2 addresses")
    expect(fx.stderr.text).toMatch(/ETH\s+USDG\s+WETH/)
    expect(fx.api.state.imports).toBe(2)
    const vault = await reopen(fx.vaultPath, fx.passphrase)
    try {
      expect(vault.file.version).toBe(4)
      const promotedEntries = vault.index.entries.filter((entry) => entry.role === "tee-wallet")
      expect(promotedEntries.map((entry) => entry.label).sort()).toEqual(["hood-a", "hood-b"])
      for (const entry of promotedEntries)
        expect(entry.tee).toMatchObject({ network: "hood-mainnet", lifecycle: "enabled" })
      const record = await readEvmRecord(vault)
      expect(record.entries.map((entry) => (entry.kind === "scanStart" ? entry.block : -1))).toEqual([6060, 6060])
    } finally {
      closeVault(vault)
    }

    const mixed = join(fx.dir, "mixed.txt")
    await Bun.write(mixed, "hood-cold hood-a\nsol-a hood-a\n")
    expect(await fx.cli(["vault", "promote-batch", "--pairs-from", mixed, "--json"])).toBe(1)
    expect(lastJson(fx.stdout.text)).toMatchObject({ code: "SOLANA_COMMAND_EVM_KEY" })
  })

  test("the destination must be a cold EVM vault key: a Solana key is refused by name, before any write", async () => {
    const fx = await fixture()
    expect(await fx.cli(["vault", "new-key", "--chain", "evm", "--label", "hood-hot"])).toBe(0)
    expect(await fx.cli(["vault", "new-key", "--chain", "solana", "--label", "cold"])).toBe(0)
    const before = await readFile(fx.vaultPath, "utf8")
    expect(await fx.cli(["vault", "promote", "--in-place", "hood-hot", "--sweep-to", "cold", "--json"])).toBe(1)
    expect(lastJson(fx.stdout.text)).toMatchObject({ code: "PROMOTE_DESTINATION_NOT_COLD" })
    expect(await readFile(fx.vaultPath, "utf8")).toBe(before)
  })
})

// ── H9 ────────────────────────────────────────────────────────────────────────────────────────

describe("H9: fund, transfer and sweep a Hood TEE wallet", () => {
  test("vault fund sends ETH or USDG from the pinned EVM vault key, with the last six and the factor", async () => {
    const fx = await promoted()
    fx.node.setEth(FIXTURE_EVM_0, 2n * ETH)
    fx.node.setToken(USDG, FIXTURE_EVM_0, 50_000_000n)
    fx.prompts.length = 0
    expect(await fx.cli(["vault", "fund", fx.wallet, "--amount", "0.25", "--asset", "ETH", "--json"])).toBe(0)
    expect(fx.node.ethOf(fx.wallet)).toBe(ETH / 4n)
    expect(fx.prompts.some((prompt) => prompt.includes(`the TEE wallet destination (${fx.wallet})`))).toBe(true)
    expect(fx.prompts.some((prompt) => prompt.includes("fund 0.25 ETH"))).toBe(true)
    expect(lastJson(fx.stdout.text)).toMatchObject({ ok: true, tee: fx.wallet, from: FIXTURE_EVM_0 })

    expect(await fx.cli(["vault", "fund", fx.wallet, "--amount", "10", "--asset", "USDG"])).toBe(0)
    expect(fx.node.tokenOf(USDG, fx.wallet)).toBe(10_000_000n)
    // No --yes, and no asset of the other chain.
    expect(await fx.cli(["vault", "fund", fx.wallet, "--amount", "1", "--asset", "SOL"])).toBe(2)
    expect(await fx.cli(["vault", "fund", fx.wallet, "--amount", "1", "--asset", "ETH", "--yes"])).toBe(2)
  })

  test("vault transfer --from a Hood TEE wallet: refused while the lock is held or unreadable, reported when confirmed", async () => {
    const fx = await promoted()
    fx.node.setEth(fx.wallet, ETH)
    fx.api.state.activeOperation = { operationId: "op-77", kind: "trade", expiresAt: 10_000_000 }
    expect(
      await fx.cli(["vault", "transfer", OTHER, "--amount", "0.1", "--asset", "ETH", "--from", "evm-tee-0", "--json"]),
    ).toBe(1)
    const busy = lastJson(fx.stdout.text)
    expect(busy).toMatchObject({ code: "WALLET_BUSY", details: { operationId: "op-77" } })
    expect(String(busy.message)).toContain("op-77")
    expect(fx.node.state.sent).toHaveLength(0)

    fx.api.state.activeOperation = null
    fx.api.state.hoodTeeFails = true
    expect(
      await fx.cli(["vault", "transfer", OTHER, "--amount", "0.1", "--asset", "ETH", "--from", "evm-tee-0", "--json"]),
    ).toBe(1)
    expect(lastJson(fx.stdout.text)).toMatchObject({ code: "WALLET_LOCK_UNKNOWN" })
    expect(fx.node.state.sent).toHaveLength(0)

    fx.api.state.hoodTeeFails = false
    fx.api.state.hoodTeeAddress = OTHER
    expect(
      await fx.cli(["vault", "transfer", OTHER, "--amount", "0.1", "--asset", "ETH", "--from", "evm-tee-0", "--json"]),
    ).toBe(1)
    const mismatch = lastJson(fx.stdout.text)
    expect(mismatch).toMatchObject({ code: "WALLET_LOCK_UNKNOWN" })
    expect(String(mismatch.message)).toContain("not this wallet")
    expect(fx.node.state.sent).toHaveLength(0)

    fx.api.state.hoodTeeAddress = undefined
    fx.api.state.omitHoodTeeAddress = true
    expect(
      await fx.cli(["vault", "transfer", OTHER, "--amount", "0.1", "--asset", "ETH", "--from", "evm-tee-0", "--json"]),
    ).toBe(1)
    expect(String(lastJson(fx.stdout.text).message)).toContain("named no wallet address")
    expect(fx.node.state.sent).toHaveLength(0)

    fx.api.state.omitHoodTeeAddress = false
    fx.api.state.hoodTeeAddress = fx.wallet.toLowerCase()
    expect(
      await fx.cli([
        "vault",
        "transfer",
        OTHER,
        "--amount",
        "0.1",
        "--asset",
        "ETH",
        "--from",
        fx.wallet.toLowerCase(),
        "--json",
      ]),
    ).toBe(0)
    expect(fx.node.state.sent).toHaveLength(1)
    // The server said enabled, so the operator was warned; the confirmed transfer was reported on Hood.
    expect(fx.stderr.text).toContain("this wallet is enabled")
    expect(lastJson(fx.stdout.text)).toMatchObject({ ok: true, activityReport: "reported" })
    const report = fx.api.state.calls.find((call) => call.path === "/api/v1/activity/report")
    expect(report?.body).toEqual({ chain: "hood", signature: fx.node.state.sent[0]?.hash })
  })

  // A path on the Hood host that is not the built-in URL, so `builtIn` is false and the second
  // chain-id read is what the pin has to catch.
  const customHoodRpc = "https://rpc.mainnet.chain.robinhood.com/v1"

  test("vault transfer --from a Hood TEE wallet refuses to sign when the planned chain id is not 4663", async () => {
    const fx = await promoted()
    fx.node.setEth(fx.wallet, ETH)
    fx.node.state.chainIdSequence.push(4663n, 1n, 1n)
    expect(
      await fx.cli([
        "vault",
        "transfer",
        OTHER,
        "--amount",
        "0.1",
        "--asset",
        "ETH",
        "--from",
        "evm-tee-0",
        "--rpc-url",
        customHoodRpc,
        "--json",
      ]),
    ).toBe(1)
    const refused = lastJson(fx.stdout.text)
    expect(refused).toMatchObject({ code: "EVM_CHAIN_MISMATCH" })
    expect(String(refused.message)).toContain("4663")
    expect(fx.node.state.sent).toHaveLength(0)
  })

  test("vault fund refuses to sign when the planned chain id is not 4663", async () => {
    const fx = await promoted()
    fx.node.setEth(FIXTURE_EVM_0, 2n * ETH)
    fx.node.state.chainIdSequence.push(4663n, 1n, 1n)
    expect(
      await fx.cli([
        "vault",
        "fund",
        fx.wallet,
        "--amount",
        "0.1",
        "--asset",
        "ETH",
        "--rpc-url",
        customHoodRpc,
        "--json",
      ]),
    ).toBe(1)
    expect(lastJson(fx.stdout.text)).toMatchObject({ code: "EVM_CHAIN_MISMATCH" })
    expect(String(lastJson(fx.stdout.text).message)).toContain("4663")
    expect(fx.node.state.sent).toHaveLength(0)
  })

  test("vault transfer --from refuses while a sweep of the wallet is pending", async () => {
    const fx = await promoted()
    const { commitVault } = await import("../vault/store")
    const vault = await reopen(fx.vaultPath, fx.passphrase)
    await commitVault(
      vault,
      {
        index: {
          ...vault.index,
          entries: vault.index.entries.map((entry) =>
            entry.address === fx.wallet && entry.tee
              ? { ...entry, tee: { ...entry.tee, sweepPending: [{ chain: "hood", hash: "0xabc", nonce: "0" }] } }
              : entry,
          ),
        },
      },
      testClock,
    )
    closeVault(vault)
    expect(
      await fx.cli(["vault", "transfer", OTHER, "--amount", "0.1", "--asset", "ETH", "--from", "evm-tee-0", "--json"]),
    ).toBe(1)
    expect(lastJson(fx.stdout.text)).toMatchObject({ code: "TRANSFER_SWEEP_PENDING" })
  })

  test("tee sweep merges USDG/WETH, the record, the server's list, --token and the logs, moves tokens then ETH, and exits 0 only when empty", async () => {
    const fx = await promoted()
    const w = fx.wallet
    fx.api.state.lifecycle = "quarantined"
    fx.api.state.tradedTokens = [TOKEN_SERVER]
    // A landed leg's token line, appended with the vault locked (the trade path's append).
    expect(
      await appendEvmRecordForTrade({ deps: fx.deps } as never, { kind: "token", wallet: w, token: TOKEN_RECORD }),
    ).toEqual({
      appended: true,
    })
    fx.node.state.logs.push({ address: TOKEN_LOGS, to: w, blockNumber: 5_100n })
    fx.node.state.head = 5_200n
    fx.node.setEth(w, ETH)
    for (const token of [USDG, HOOD_WETH_ADDRESS, TOKEN_RECORD, TOKEN_SERVER, TOKEN_FLAG, TOKEN_LOGS]) {
      fx.node.setToken(token, w, 1_000n)
    }

    expect(await fx.cli(["tee", "sweep", w, "--token", TOKEN_FLAG, "--json"])).toBe(0)
    const doc = lastJson(fx.stdout.text)
    expect(doc).toMatchObject({ ok: true, state: "swept", observedEmpty: true, emergency: false, missingSources: [] })
    // Every source ran, and the scan started at the promote height.
    expect(fx.stderr.text).toContain("sealed EVM record: 1 token(s), 1 scan start(s)")
    expect(fx.stderr.text).toContain("server traded-token list: 1 token(s)")
    expect(fx.stderr.text).toContain("Transfer logs over rpc.mainnet.chain.robinhood.com: blocks 5000 to 5200")
    expect(fx.node.state.logRanges[0]?.from).toBe(5_000n)
    // Six token transfers, then ETH last.
    const kinds = fx.node.state.sent.map((sent) => sent.kind)
    expect(kinds).toEqual(["erc20", "erc20", "erc20", "erc20", "erc20", "erc20", "native"])
    for (const token of [USDG, HOOD_WETH_ADDRESS, TOKEN_RECORD, TOKEN_SERVER, TOKEN_FLAG, TOKEN_LOGS]) {
      expect(fx.node.tokenOf(token, w)).toBe(0n)
      expect(fx.node.tokenOf(token, FIXTURE_EVM_0)).toBe(1_000n)
    }
    expect(fx.node.state.sent.map((sent) => sent.nonce)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(fx.node.state.sent.every((sent) => lower(sent.recipient ?? sent.to) === lower(FIXTURE_EVM_0))).toBe(true)
    expect(fx.api.state.calls.some((call) => call.path.endsWith("/swept"))).toBe(true)
    const vault = await reopen(fx.vaultPath, fx.passphrase)
    try {
      const entry = vault.index.entries.find((candidate) => candidate.address === w)
      expect(entry?.tee?.sweptAt).toBeDefined()
      expect(entry?.tee?.lifecycle).toBe("retired")
      expect(entry?.tee?.sweepPending ?? []).toEqual([])
      expect(entry?.tee?.sweepReceipts).toHaveLength(7)
    } finally {
      closeVault(vault)
    }
  })

  test("a sweep with token balances and no ETH refuses with EVM_SWEEP_NEEDS_GAS and the fund command, signing nothing", async () => {
    const fx = await promoted()
    fx.api.state.lifecycle = "quarantined"
    fx.node.setToken(USDG, fx.wallet, 5_000_000n)
    expect(await fx.cli(["tee", "sweep", fx.wallet, "--json"])).toBe(1)
    const doc = lastJson(fx.stdout.text)
    expect(doc.code).toBe("EVM_SWEEP_NEEDS_GAS")
    expect(String(doc.suggestion)).toContain(`candle vault fund ${fx.wallet} --amount`)
    expect(String(doc.suggestion)).toContain("--asset ETH")
    expect(fx.node.state.sent).toHaveLength(0)
  })

  test("short ETH moves what it covers in source order; a token asking for more than the gas cap is left, not paid for", async () => {
    const fx = await promoted()
    fx.api.state.lifecycle = "quarantined"
    const hostile = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"
    fx.node.setToken(USDG, fx.wallet, 10n)
    fx.node.setToken(HOOD_WETH_ADDRESS, fx.wallet, 20n)
    fx.node.setToken(hostile, fx.wallet, 30n)
    fx.node.state.tokenGas.set(lower(hostile), 30_000_000n)
    // 60,000 gas per token at 210 wei max fee: one transfer's worth of ETH and a little more.
    fx.node.setEth(fx.wallet, 60_000n * 210n + 1_000n)
    expect(await fx.cli(["tee", "sweep", fx.wallet, "--token", hostile, "--json"])).toBe(3)
    const doc = lastJson(fx.stdout.text)
    const residuals = doc.residuals as Array<{ kind: string; token?: string }>
    expect(residuals.find((r) => r.kind === "token-gas-too-high")?.token).toBe(hostile)
    expect(residuals.find((r) => r.kind === "token-needs-gas")?.token).toBe(HOOD_WETH_ADDRESS)
    expect(fx.node.tokenOf(USDG, fx.wallet)).toBe(0n)
    expect(fx.node.tokenOf(HOOD_WETH_ADDRESS, fx.wallet)).toBe(20n)
    expect(fx.node.tokenOf(hostile, fx.wallet)).toBe(30n)
    expect(doc.observedEmpty).toBe(false)
  })

  test("an ordinary sweep refuses while the lock is held, and closed when it cannot be read", async () => {
    const fx = await promoted()
    fx.api.state.lifecycle = "quarantined"
    fx.node.setEth(fx.wallet, ETH)
    fx.api.state.activeOperation = { operationId: "op-9", kind: "swap", expiresAt: 5_000_000 }
    expect(await fx.cli(["tee", "sweep", fx.wallet, "--json"])).toBe(1)
    expect(lastJson(fx.stdout.text)).toMatchObject({ code: "WALLET_BUSY", details: { operationId: "op-9" } })
    fx.api.state.activeOperation = null
    fx.api.state.hoodTeeFails = true
    expect(await fx.cli(["tee", "sweep", fx.wallet, "--json"])).toBe(1)
    expect(lastJson(fx.stdout.text)).toMatchObject({ code: "WALLET_LOCK_UNKNOWN" })
    expect(fx.node.state.sent).toHaveLength(0)
  })

  test("--emergency calls no Candle API, sweeps a token known only from the record, and signs the in-flight nonce", async () => {
    const fx = await promoted()
    const w = fx.wallet
    await appendEvmRecordEntry({
      vaultPath: fx.vaultPath,
      entry: { kind: "token", wallet: w, token: TOKEN_RECORD },
      clock: testClock,
    })
    fx.node.setEth(w, ETH)
    fx.node.setToken(TOKEN_RECORD, w, 77n)
    fx.node.state.latest.set(lower(w), 4n)
    fx.node.state.pendingExtra.set(lower(w), 1n)
    const apiCalls = fx.api.state.calls.length

    expect(await fx.cli(["tee", "sweep", w, "--emergency", "--json"])).toBe(3)
    expect(fx.api.state.calls.length).toBe(apiCalls)
    expect(fx.stderr.text).toContain("A transaction already occupies nonce 4 (pending 5 > latest 4)")
    expect(fx.stderr.text).toContain(
      "with doubled fees and may replace that in-flight leg; replacement is not guaranteed",
    )
    expect(fx.node.state.sent[0]).toMatchObject({ kind: "erc20", nonce: 4, token: lower(TOKEN_RECORD) })
    expect(fx.node.tokenOf(TOKEN_RECORD, w)).toBe(0n)
    const doc = lastJson(fx.stdout.text)
    // Observed empty, but an emergency sweep never records `swept`: remote authority is pending.
    expect(doc).toMatchObject({
      emergency: true,
      observedEmpty: true,
      state: "disable-pending",
      serverState: "not-read",
    })
  })

  test("a transport error on broadcast is dropped when the re-run's transaction lookup is null, and the sweep proceeds", async () => {
    const fx = await promoted()
    fx.api.state.lifecycle = "quarantined"
    fx.node.setEth(fx.wallet, ETH)
    fx.node.state.failNextSend = true
    expect(await fx.cli(["tee", "sweep", fx.wallet, "--json"])).toBe(3)
    const stuck = lastJson(fx.stdout.text)
    const pending = stuck.pending as Array<{ hash: string }>
    expect(pending).toHaveLength(1)
    expect(fx.node.state.sent).toHaveLength(0)
    expect(fx.node.state.methods).not.toContain("eth_getTransactionByHash")

    expect(await fx.cli(["tee", "sweep", fx.wallet, "--json"])).toBe(0)
    expect(fx.node.state.methods).toContain("eth_getTransactionByHash")
    expect(fx.node.state.sent).toHaveLength(1)
    expect(lastJson(fx.stdout.text)).toMatchObject({ ok: true, state: "swept", pending: [] })
    const vault = await reopen(fx.vaultPath, fx.passphrase)
    try {
      const entry = vault.index.entries.find((candidate) => candidate.address === fx.wallet)
      expect(entry?.tee?.sweepPending ?? []).toEqual([])
    } finally {
      closeVault(vault)
    }
  })

  test("the same re-run still refuses when the transaction lookup returns the hash", async () => {
    const fx = await promoted()
    fx.api.state.lifecycle = "quarantined"
    fx.node.setEth(fx.wallet, ETH)
    fx.node.state.failNextSend = true
    expect(await fx.cli(["tee", "sweep", fx.wallet, "--json"])).toBe(3)
    const hash = (lastJson(fx.stdout.text).pending as Array<{ hash: string }>)[0]?.hash as string
    fx.node.state.knownHashes.add(hash)

    expect(await fx.cli(["tee", "sweep", fx.wallet, "--json"])).toBe(3)
    expect(lastJson(fx.stdout.text)).toMatchObject({ code: "EVM_SWEEP_INCOMPLETE" })
    expect(String(lastJson(fx.stdout.text).message)).toContain(hash)
    expect(fx.node.state.sent).toHaveLength(0)
    expect(fx.node.state.methods.filter((method) => method === "eth_sendRawTransaction")).toHaveLength(0)
  })

  test("--emergency bumps the ETH leg when its nonce is still in flight, and the value uses that fee", async () => {
    const fx = await promoted()
    const w = fx.wallet
    fx.node.setEth(w, ETH)
    fx.node.state.latest.set(lower(w), 4n)
    fx.node.state.pendingExtra.set(lower(w), 1n)
    expect(await fx.cli(["tee", "sweep", w, "--emergency", "--json"])).toBe(3)
    // Quoted max fee is 2 × base(100) + tip(10) = 210; the replacement doubles it and adds 1 wei to the tip.
    const native = fx.node.state.sent.find((sent) => sent.kind === "native")
    expect(native).toMatchObject({ nonce: 4, maxFeePerGas: 420n, maxPriorityFeePerGas: 21n })
    const gas = 25_200n
    expect(native?.value).toBe(ETH - gas * 420n)
  })

  test("--from-block above the chain head is a usage error and scans nothing", async () => {
    const fx = await promoted()
    expect(await fx.cli(["tee", "sweep", fx.wallet, "--emergency", "--from-block", "5001", "--json"])).toBe(2)
    expect(String(lastJson(fx.stdout.text).message)).toContain("above")
    expect(fx.node.state.methods).not.toContain("eth_getLogs")
    expect(fx.node.state.sent).toHaveLength(0)
  })

  test("--emergency with matching nonces says no in-flight transaction was observed", async () => {
    const fx = await promoted()
    fx.node.setEth(fx.wallet, ETH)
    expect(await fx.cli(["tee", "sweep", fx.wallet, "--emergency"])).toBe(3)
    expect(fx.stdout.text).toContain("No in-flight transaction was observed (latest and pending nonce are both 0)")
  })

  test("vault demote disables, then sweeps home", async () => {
    const fx = await promoted()
    fx.node.setEth(fx.wallet, ETH)
    fx.node.setToken(USDG, fx.wallet, 9n)
    expect(await fx.cli(["vault", "demote", fx.wallet])).toBe(0)
    expect(fx.api.state.calls.some((call) => call.method === "DELETE")).toBe(true)
    expect(fx.node.tokenOf(USDG, fx.wallet)).toBe(0n)
    expect(fx.stdout.text).toContain("Stopped")
    expect(fx.stdout.text).toContain("Swept.")
  })

  test("the production deps wire the record writer; a landed leg's append never fails: no vault, a version 3 header", async () => {
    const { buildRealDeps } = await import("../index")
    expect((await buildRealDeps()).appendEvmRecord).toBe(appendEvmRecordForTrade)
    const dir = await tempDir()
    const ctxFor = (configDir: string) =>
      ({ deps: { ...testClock, env: { CANDLE_CONFIG_DIR: configDir }, homedir: () => configDir } }) as never
    const entry = { kind: "token" as const, wallet: TEE_0, token: TOKEN_RECORD }
    expect(await appendEvmRecordForTrade(ctxFor(dir), entry)).toMatchObject({ appended: false })
    const made = await makeVault()
    closeVault(made.vault)
    const v3 = await appendEvmRecordForTrade(ctxFor(made.dir), entry)
    expect(v3).toMatchObject({ appended: false })
    expect((v3 as { notice: string }).notice).toContain("not version 4")
    expect(await appendEvmRecordForTrade(ctxFor("~nope"), entry)).toMatchObject({ appended: false })
  })
})

// ── H9: after a phrase restore ────────────────────────────────────────────────────────────────

describe("H9: restore --evm-tee-count, no record, and log discovery", () => {
  async function restored(k: number) {
    const dir = await tempDir()
    const stdout = createCapture()
    let askedPhrase = false
    const rowFor = {
      _id: "lw_restored",
      address: TEE_0,
      chain: "evm",
      vaultDestination: FIXTURE_EVM_0,
      remoteAuthority: "verified-active",
    }
    const deps = createTestDeps({
      fetch: (async (input: string | URL) => {
        const path = new URL(String(input)).pathname
        if (path === "/api/v1/agent/wallets/embedded") {
          return new Response(JSON.stringify({ success: true, account: ACCOUNT }), { status: 200 })
        }
        if (path === "/api/v1/agent/wallets") {
          return new Response(JSON.stringify({ success: true, page: k > 0 ? [rowFor] : [], isDone: true }), {
            status: 200,
          })
        }
        throw new Error(`unexpected ${path}`)
      }) as typeof fetch,
      stdout,
      stderr: createCapture(),
      env: { CANDLE_CONFIG_DIR: dir, HOME: dir, CANDLE_API_KEY: API_KEY, CANDLE_API_URL: API },
      isTTY: { stdin: true, stdout: true, stderr: true },
      promptSecret: async () => {
        if (!askedPhrase) {
          askedPhrase = true
          return FIXTURE_PHRASE
        }
        return generatedPassphraseFrom(stdout.text)
      },
      promptLine: async (text: string) => (text.includes("last six characters") ? ACCOUNT.slice(-6) : "no"),
    })
    const args = ["vault", "restore", "--phrase", "--count", "1", "--evm-count", "1"]
    if (k >= 0) args.push("--evm-tee-count", String(k))
    const code = await run(args, deps)
    return { dir, code, stdout, passphrase: generatedPassphraseFrom(stdout.text), vaultPath: join(dir, "vault.enc") }
  }

  test("k = 1 creates version 4 with a record key in the first write; k = 0 and no flag stay below 4", async () => {
    const one = await restored(1)
    expect(one.code).toBe(0)
    const file = await readVaultJson(one.vaultPath)
    expect(file.version).toBe(4)
    expect(file.evmRecordPublicKey).toBeDefined()
    expect(one.stdout.text).toContain("evm tee: indices 0 to 0, on m/44'/60'/n'/1'/0'")
    expect(one.stdout.text).toContain("--from-block")
    const vault = await reopen(one.vaultPath, one.passphrase)
    try {
      const entry = vault.index.entries.find((candidate) => candidate.address === TEE_0)
      expect(entry).toMatchObject({
        role: "tee-wallet",
        chain: "evm",
        derivation: { path: "m/44'/60'/0'/1'/0'" },
        exposure: { exposureUnknown: true, everRemoteExposed: true },
        linkedWalletId: "lw_restored",
        tee: { network: "hood-mainnet", lifecycle: "enabled", vaultDestination: FIXTURE_EVM_0 },
      })
      expect(vault.index.hd.nextIndex.evmTee).toBe(1)
      // A phrase restore does not bring a record, and the next landed leg's append reads.
      expect((await readEvmRecord(vault)).absent).toBe(true)
      await appendEvmRecordEntry({
        vaultPath: one.vaultPath,
        entry: { kind: "token", wallet: TEE_0, token: TOKEN_RECORD },
        clock: testClock,
      })
      expect((await readEvmRecord(vault)).entries).toHaveLength(1)
    } finally {
      closeVault(vault)
    }
    // Allocation stays refused in a restored vault.
    for (const k of [0, -1]) {
      const other = await restored(k)
      expect(other.code).toBe(0)
      const otherFile = await readVaultJson(other.vaultPath)
      expect(otherFile.version).toBeLessThan(4)
      expect(otherFile.evmRecordPublicKey).toBeUndefined()
    }
  })

  test("the restore refusal of an existing vault names its record path too", async () => {
    const one = await restored(1)
    const again = createTestDeps({
      fetch: (async () => {
        throw new Error("no network")
      }) as unknown as typeof fetch,
      stdout: createCapture(),
      stderr: createCapture(),
      env: { CANDLE_CONFIG_DIR: one.dir, HOME: one.dir },
      isTTY: { stdin: true, stdout: true, stderr: true },
    })
    expect(await run(["vault", "restore", "--phrase", "--evm-tee-count", "1"], again)).toBe(1)
    expect((again.stderr as ReturnType<typeof createCapture>).text).toContain(evmRecordPath(one.vaultPath))
  })

  test("vault transfer --from a restored Hood wallet (its row matched, so its lock can be read) signs", async () => {
    const one = await restored(1)
    const fx = await fixture({ dir: one.dir, passphrase: one.passphrase })
    fx.api.state.hoodTeeAddress = TEE_0
    fx.node.setEth(TEE_0, ETH)
    expect(
      await fx.cli(["vault", "transfer", OTHER, "--amount", "0.1", "--asset", "ETH", "--from", TEE_0, "--json"]),
    ).toBe(0)
    expect(fx.node.state.sent).toHaveLength(1)
    expect(fx.api.state.calls.some((call) => call.path === "/api/v1/agent/wallets/lw_restored/hood-tee")).toBe(true)
  })

  test("--emergency after a restore: --from-block finds a traded token in the logs; without it, the wallet is not called empty", async () => {
    const one = await restored(1)
    const fx = await fixture({ dir: one.dir, passphrase: one.passphrase })
    fx.node.setEth(TEE_0, ETH)
    fx.node.setToken(TOKEN_LOGS, TEE_0, 555n)
    fx.node.state.logs.push({ address: TOKEN_LOGS, to: TEE_0, blockNumber: 4_100n })

    expect(await fx.cli(["tee", "sweep", TEE_0, "--emergency", "--json"])).toBe(3)
    const blind = lastJson(fx.stdout.text)
    expect(blind).toMatchObject({ observedEmpty: false, missingSources: ["Transfer-log discovery"] })
    expect(String((blind.sources as { logs: { reason: string } }).logs.reason)).toContain("--from-block")
    expect(fx.node.tokenOf(TOKEN_LOGS, TEE_0)).toBe(555n)

    fx.node.setEth(TEE_0, ETH)
    expect(await fx.cli(["tee", "sweep", TEE_0, "--emergency", "--from-block", "4000", "--json"])).toBe(3)
    const found = lastJson(fx.stdout.text)
    expect(found).toMatchObject({ observedEmpty: true, emergency: true })
    expect(fx.node.tokenOf(TOKEN_LOGS, TEE_0)).toBe(0n)
    expect(fx.node.tokenOf(TOKEN_LOGS, FIXTURE_EVM_0)).toBe(555n)
    expect(fx.node.state.logRanges.at(-1)?.from).toBe(4_000n)
  })
})

// ── H13, the command half ─────────────────────────────────────────────────────────────────────

describe("WALLET_BUSY names the command that can see the holder", () => {
  function hint(kind: string): string {
    try {
      assertWalletLockFree(
        { label: "evm-tee-0", address: TEE_0 } as never,
        { state: "held", operationId: "op-9", kind, expiresAt: 0 },
        0,
      )
    } catch (error) {
      expect(error).toBeInstanceOf(VaultError)
      return (error as VaultError).suggestion ?? ""
    }
    throw new Error("expected WALLET_BUSY")
  }

  test("swap, trade and launch name swap status; a transfer does not", () => {
    expect(hint("swap")).toContain("candle swap status op-9")
    expect(hint("swap")).not.toContain("--kind")
    expect(hint("trade")).toContain("candle swap status op-9 --kind trade")
    expect(hint("launch")).toContain("candle swap status op-9 --kind launch")
    const transfer = hint("transfer")
    expect(transfer).not.toContain("swap status")
    expect(transfer).toContain("the transfer operation op-9")
  })
})

describe("a wallet with no server row", () => {
  test("WALLET_LOCK_UNKNOWN does not tell the operator to restore an API key", async () => {
    const read = await readHoodTeeServer({} as never, { label: "evm-tee-0", address: TEE_0 } as never)
    expect(read.lock).toMatchObject({ state: "unknown" })
    if (read.lock.state !== "unknown") return
    expect(read.lock.suggestion ?? "").not.toContain("Restore the API key")
    expect(read.lock.suggestion).toContain("exits 3")
    expect(read.lock.suggestion).toContain("sweptAt")
    try {
      assertWalletLockFree({ label: "evm-tee-0", address: TEE_0 } as never, read.lock, 0)
      throw new Error("expected WALLET_LOCK_UNKNOWN")
    } catch (error) {
      expect(error).toBeInstanceOf(VaultError)
      expect((error as VaultError).code).toBe("WALLET_LOCK_UNKNOWN")
      expect((error as VaultError).suggestion).toBe(read.lock.suggestion)
    }
  })
})

describe("H13: vault backup carries the record; verify-backup runs the ninth check", () => {
  test("backup writes <copy minus .enc>.evm-record.sealed, reports the counts, and verify-backup passes it at step 9", async () => {
    const fx = await promoted()
    await appendEvmRecordEntry({
      vaultPath: fx.vaultPath,
      entry: { kind: "token", wallet: fx.wallet, token: TOKEN_RECORD },
      clock: testClock,
    })
    const backupDir = await tempDir("candle-evm-backup-")
    const copy = join(backupDir, "copy.enc")
    expect(await fx.cli(["vault", "backup", "--to", copy, "--json"])).toBe(0)
    const doc = lastJson(fx.stdout.text)
    expect(doc).toMatchObject({
      steps: 9,
      evmRecord: { absent: false, lines: 2 },
      evmRecordCopy: { path: join(backupDir, "copy.evm-record.sealed"), present: true, copied: 2, dropped: 0 },
    })
    expect((await stat(join(backupDir, "copy.evm-record.sealed"))).isFile()).toBe(true)

    expect(await fx.cli(["vault", "verify-backup", copy, "--json"])).toBe(0)
    expect(lastJson(fx.stdout.text)).toMatchObject({ steps: 9, evmRecord: { absent: false, lines: 2 } })

    // A version 4 copy with no record beside it passes, and says so.
    await rm(join(backupDir, "copy.evm-record.sealed"))
    expect(await fx.cli(["vault", "verify-backup", copy])).toBe(0)
    expect(fx.stdout.text).toContain("all 9 passed")
    expect(fx.stdout.text).toContain("EVM record    absent beside the copy")

    // The backup refuses before writing anything when the copy's record path is taken.
    const second = join(backupDir, "second.enc")
    await Bun.write(join(backupDir, "second.evm-record.sealed"), "taken\n")
    expect(await fx.cli(["vault", "backup", "--to", second, "--json"])).toBe(1)
    expect(lastJson(fx.stdout.text)).toMatchObject({ code: "EXPORT_TARGET_EXISTS" })
    await expect(stat(second)).rejects.toThrow()
  })
})
