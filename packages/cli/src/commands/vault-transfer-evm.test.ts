/**
 * Ember Phase 4a (BE-350, spec `2026-09-24-ember-phase-4a-evm-vault-keys-design.md`, D5, D6, D1),
 * E4 to E8: `vault transfer` from an EVM vault key on a fake JSON-RPC.
 *
 * The fake node records every method in order and every raw transaction it is sent, so the claims
 * here are counts and orderings rather than prose: the post-factor re-read happens after the factor
 * and before the one broadcast (E4), a refusal leaves the node with zero signed bytes (E5), and each
 * post-sign outcome is decided by the receipt and the head the node answers (E6). The raw bytes the
 * node receives are decoded with `viem` to check what was signed is what was displayed.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { parseTransaction, recoverTransactionAddress } from "viem"
import { FIXTURE_EVM_0 } from "../evm-lite.test"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"
import { EVM_RECEIPT_WAIT_MS } from "../vault/evm-transfer"
import { closeVault, commitVault } from "../vault/store"
import { makeVault, reopen, testClock, useCheapKdf } from "../vault/test-vault"

setDefaultTimeout(60_000)
useCheapKdf()

const HOOD_HOST = "rpc.mainnet.chain.robinhood.com"
const DEAD = "0x000000000000000000000000000000000000dEaD"
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168"
const USDG_CHECKSUMMED = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"
const OTHER_TOKEN = "0x1111111111111111111111111111111111111111"
const SOLANA_DESTINATION = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
const ETH = 1_000_000_000_000_000_000n
const ZERO_WORD = `0x${"0".repeat(64)}`

const hex = (value: bigint) => `0x${value.toString(16)}`
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`

interface Receipt {
  status: 0 | 1
  blockNumber: bigint
}

/** The node's script. Every field has a Hood-shaped default; a test overrides what it is about. */
interface NodeScript {
  chainId?: bigint
  /** The chain id answered from the second `eth_chainId` on (the post-factor re-read). */
  chainIdLater?: bigint
  nonce?: bigint
  nonceLater?: bigint
  balance?: bigint
  tokenBalance?: bigint
  decimals?: number | "unreadable"
  symbol?: string
  baseFee?: bigint
  tip?: bigint | "unsupported"
  estimate?: bigint
  /** What `eth_sendRawTransaction` does: accept, fail transport, or answer an RPC error. */
  send?: "accept" | "transport" | { error: string }
  /** The receipt answered on the n-th `eth_getTransactionReceipt` (0-based), else null. */
  receipt?: (poll: number) => Receipt | null
  /** The head answered on the n-th `eth_blockNumber`. */
  head?: (poll: number) => bigint
  /** `eth_blockNumber` throws (a transport failure) instead of answering a head. */
  blockNumberThrows?: boolean
}

function node(script: NodeScript) {
  const methods: string[] = []
  const sent: string[] = []
  const hosts = new Set<string>()
  const params: Record<string, unknown[][]> = {}
  let chainIdReads = 0
  let nonceReads = 0
  let receiptPolls = 0
  let headPolls = 0
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    hosts.add(new URL(String(input)).host)
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] }
    methods.push(body.method)
    params[body.method] = [...(params[body.method] ?? []), body.params]
    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    const rpcError = (message: string) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    switch (body.method) {
      case "eth_chainId": {
        chainIdReads += 1
        const later = script.chainIdLater ?? script.chainId ?? 4663n
        return reply(hex(chainIdReads === 1 ? (script.chainId ?? 4663n) : later))
      }
      case "eth_getTransactionCount": {
        nonceReads += 1
        expect(body.params[1]).toBe("pending")
        const later = script.nonceLater ?? script.nonce ?? 7n
        return reply(hex(nonceReads === 1 ? (script.nonce ?? 7n) : later))
      }
      case "eth_feeHistory":
        return reply({
          oldestBlock: "0x64",
          baseFeePerGas: ["0x5", "0x6", hex(script.baseFee ?? 100n)],
          reward: [["0x1"], ["0x3"], ["0x2"]],
        })
      case "eth_maxPriorityFeePerGas":
        if (script.tip === "unsupported") return rpcError("the method eth_maxPriorityFeePerGas does not exist")
        return reply(hex(script.tip ?? 10n))
      case "eth_getBalance":
        return reply(hex(script.balance ?? 2n * ETH))
      case "eth_estimateGas": {
        // A real node rejects an estimate whose value is above the balance. The pre-sign check
        // must refuse that with EVM_INSUFFICIENT_FOR_FEES before this call; if it does not, the
        // error here would surface as VAULT_UNREADABLE.
        const estimated = body.params[0] as { value?: string }
        const value = estimated.value !== undefined ? BigInt(estimated.value) : 0n
        if (value > (script.balance ?? 2n * ETH)) {
          return rpcError("insufficient funds for gas * price + value")
        }
        return reply(hex(script.estimate ?? 21_000n))
      }
      case "eth_call": {
        const call = body.params[0] as { to: string; data: string }
        if (call.data.startsWith("0x313ce567")) {
          if (script.decimals === "unreadable") return reply("0x")
          return reply(word(BigInt(script.decimals ?? 6)))
        }
        if (call.data.startsWith("0x95d89b41")) {
          const symbol = script.symbol ?? "TOK"
          const bytes = Buffer.from(symbol, "utf8")
          return reply(
            `0x${word(32n).slice(2)}${word(BigInt(bytes.length)).slice(2)}${bytes.toString("hex").padEnd(64, "0")}`,
          )
        }
        if (call.data.startsWith("0x70a08231")) return reply(word(script.tokenBalance ?? 5_000_000n))
        return reply(ZERO_WORD)
      }
      case "eth_sendRawTransaction": {
        sent.push(body.params[0] as string)
        const send = script.send ?? "accept"
        if (send === "transport") return new Response("bad gateway", { status: 502 })
        if (send !== "accept") return rpcError(send.error)
        return reply("0xecho")
      }
      case "eth_getTransactionReceipt": {
        // Without a script the node confirms at once: a receipt in the head block.
        const receipt = script.receipt ? script.receipt(receiptPolls++) : { status: 1 as const, blockNumber: 1_000n }
        if (receipt === null) return reply(null)
        return reply({
          status: hex(BigInt(receipt.status)),
          blockNumber: hex(receipt.blockNumber),
          transactionHash: body.params[0],
        })
      }
      case "eth_blockNumber":
        if (script.blockNumberThrows) throw new Error("socket hang up")
        return reply(hex(script.head?.(headPolls++) ?? 1_000n))
      default:
        throw new Error(`unexpected RPC method ${body.method}`)
    }
  }) as typeof fetch
  return { fetch: fetchFn, methods, sent, hosts, params }
}

async function fixture(script: NodeScript = {}, env: Record<string, string> = {}) {
  const made = await makeVault()
  closeVault(made.vault)
  const stdout = createCapture()
  const stderr = createCapture()
  const rpc = node(script)
  const events: string[] = []
  const asked: string[] = []
  let lastSixPrompt = ""
  let displayAtLastSix = ""
  let factorPrompt = ""
  const deps = createTestDeps({
    fetch: rpc.fetch,
    stdout,
    stderr,
    env: { CANDLE_CONFIG_DIR: made.dir, HOME: made.dir, ...env },
    isTTY: { stdin: true, stdout: true, stderr: true },
    promptSecret: async (prompt) => {
      asked.push(prompt)
      if (prompt.startsWith("Vault passphrase to")) {
        factorPrompt = prompt
        events.push("factor")
      }
      return made.passphrase
    },
    promptLine: async (prompt) => {
      lastSixPrompt = prompt
      displayAtLastSix = stdout.text
      events.push("last-six")
      const match = /\(([^)]+)\) to confirm/.exec(prompt)
      return (match?.[1] ?? "").slice(-6)
    },
  })
  expect(await run(["vault", "new-key", "--chain", "evm", "--label", "hood-cold"], deps)).toBe(0)
  expect(await run(["vault", "new-key", "--chain", "solana", "--label", "cold"], deps)).toBe(0)
  stdout.text = ""
  stderr.text = ""
  rpc.methods.length = 0
  asked.length = 0
  return {
    deps,
    stdout,
    stderr,
    rpc,
    events,
    asked,
    path: made.path,
    get lastSixPrompt() {
      return lastSixPrompt
    },
    get displayAtLastSix() {
      return displayAtLastSix
    },
    get factorPrompt() {
      return factorPrompt
    },
    transfer: (args: string[]) => run(["vault", "transfer", ...args], deps),
  }
}

/** The JSON value `--json` ends stdout with (the decoded display precedes it). */
function lastJson(text: string): Record<string, unknown> {
  return JSON.parse(text.trimEnd().split("\n").at(-1) ?? "")
}

/** The methods the node saw around the factor: everything before the broadcast, in order. */
function methodsBeforeBroadcast(methods: string[]): string[] {
  const at = methods.indexOf("eth_sendRawTransaction")
  return at === -1 ? methods : methods.slice(0, at)
}

describe("E4: the native and ERC-20 shapes, displayed, confirmed, re-read, broadcast once", () => {
  test("native: the display, the last six of `to`, the factor named, the re-read after it, one broadcast, the bytes signed", async () => {
    const fx = await fixture({ balance: 2n * ETH, estimate: 21_000n, baseFee: 100n, tip: 10n, nonce: 7n })
    expect(await fx.transfer([DEAD, "--amount", "0.5", "--asset", "ETH", "--from", "hood-cold"])).toBe(0)

    // The host, before any request, on stderr; never the URL.
    expect(fx.stderr.text).toContain(`from ${HOOD_HOST} (the built-in Hood RPC)`)
    expect(fx.rpc.hosts).toEqual(new Set([HOOD_HOST]))

    // The display (D5), all of it before the last-six prompt.
    const shown = fx.displayAtLastSix
    expect(shown).toContain("chain       4663 (Hood)")
    expect(shown).toContain(`from        hood-cold  ${FIXTURE_EVM_0}`)
    expect(shown).toContain(`to          ${DEAD}`)
    expect(shown).toContain("amount      0.5 ETH = 500000000000000000 wei")
    expect(shown).toContain("gas limit   25200") // 21000 × 1.2
    expect(shown).toContain("max fee     210 wei/gas (priority 10 wei/gas)") // 2 × 100 + 10
    expect(shown).toContain("fee cap     0.000000000005292 ETH") // 25200 × 210 wei
    expect(shown).toContain("nonce       7")
    expect(fx.lastSixPrompt).toContain(`the destination (${DEAD})`)
    expect(fx.factorPrompt).toContain("sign transfer of 0.5 ETH to 0x000000000000000000000000000000000000dEaD on Hood")
    expect(fx.events).toEqual(["last-six", "factor"])

    // D5's order: the reads, then (after both prompts) the chain id and the pending nonce again,
    // then exactly one broadcast, and nothing read the chain id after it.
    expect(methodsBeforeBroadcast(fx.rpc.methods)).toEqual([
      "eth_chainId",
      "eth_getTransactionCount",
      "eth_feeHistory",
      "eth_maxPriorityFeePerGas",
      "eth_getBalance",
      "eth_estimateGas",
      "eth_chainId",
      "eth_getTransactionCount",
    ])
    expect(fx.rpc.methods.filter((m) => m === "eth_sendRawTransaction")).toHaveLength(1)
    expect(fx.rpc.methods.slice(fx.rpc.methods.indexOf("eth_sendRawTransaction") + 1)).not.toContain("eth_chainId")

    // What was signed is what was displayed, and it was signed by the key.
    const raw = fx.rpc.sent[0] as `0x${string}`
    const tx = parseTransaction(raw)
    expect(tx).toMatchObject({
      type: "eip1559",
      chainId: 4663,
      nonce: 7,
      gas: 25_200n,
      maxFeePerGas: 210n,
      maxPriorityFeePerGas: 10n,
      value: 500_000_000_000_000_000n,
    })
    expect(tx.to?.toLowerCase()).toBe(DEAD.toLowerCase())
    expect(tx.data ?? "0x").toBe("0x")
    expect(await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` })).toBe(FIXTURE_EVM_0)
    expect(fx.stdout.text).toContain("Confirmed 0x")
    expect(fx.stdout.text).toContain("depth 1, not finality")
  })

  test("ERC-20: the display shows the contract as `to` and the decoded recipient, the last six is the recipient's, and the calldata is transfer(address,uint256)", async () => {
    const fx = await fixture({ decimals: 6, tokenBalance: 5_000_000n, estimate: 50_000n })
    expect(await fx.transfer([DEAD, "--amount", "1.5", "--asset", "USDG", "--from", "hood-cold", "--json"])).toBe(0)
    const shown = fx.displayAtLastSix
    expect(shown).toContain(`to          ${USDG_CHECKSUMMED}  (the USDG contract, 6 dp)`)
    expect(shown).toContain(`recipient   ${DEAD}  (decoded from transfer(address,uint256))`)
    expect(shown).toContain("amount      1.5 USDG = 1500000 raw")
    expect(fx.lastSixPrompt).toContain(`the token recipient (${DEAD})`)
    expect(fx.factorPrompt).toContain(`sign transfer of 1.5 USDG to ${DEAD}`)
    // The contract was asked its decimals and symbol is not asked for USDG (it is named), then balance was not needed.
    expect(fx.rpc.params.eth_call?.some((p) => String((p[0] as { data: string }).data).startsWith("0x313ce567"))).toBe(
      true,
    )
    const raw = fx.rpc.sent[0] as `0x${string}`
    const tx = parseTransaction(raw)
    expect(tx.to?.toLowerCase()).toBe(USDG)
    expect(tx.value ?? 0n).toBe(0n)
    expect(tx.data).toBe(
      "0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead000000000000000000000000000000000000000000000000000000000016e360",
    )
    expect(fx.rpc.sent).toHaveLength(1)
    const body = lastJson(fx.stdout.text)
    expect(body).toMatchObject({
      ok: true,
      chainId: 4663,
      status: "confirmed",
      depth: 1,
      finalized: false,
      to: USDG_CHECKSUMMED,
      recipient: DEAD,
      asset: "USDG",
      amount: "1.5",
      amountRaw: "1500000",
      token: USDG_CHECKSUMMED,
    })
    expect(typeof body.hash).toBe("string")
    expect(String(body.hash)).toMatch(/^0x[0-9a-f]{64}$/)
  })

  test("--rpc-url picks another EVM chain, --rpc-url and CANDLE_EVM_RPC_URL beat the built-in host, and the tip falls back to eth_feeHistory", async () => {
    const fx = await fixture(
      { chainId: 8453n, tip: "unsupported", head: () => 1_001n, receipt: () => ({ status: 1, blockNumber: 1_000n }) },
      {
        CANDLE_EVM_RPC_URL: "https://env.evm.test/rpc",
      },
    )
    expect(
      await fx.transfer([
        DEAD,
        "--amount",
        "0.5",
        "--asset",
        "ETH",
        "--from",
        "hood-cold",
        "--rpc-url",
        "https://flag.evm.test/rpc",
      ]),
    ).toBe(0)
    expect(fx.rpc.hosts).toEqual(new Set(["flag.evm.test"]))
    expect(fx.stderr.text).toContain("from flag.evm.test")
    expect(fx.stderr.text).not.toContain("built-in")
    // The median of the last ten blocks' 50th-percentile rewards: [1, 3, 2] → 2.
    expect(fx.displayAtLastSix).toContain("max fee     202 wei/gas (priority 2 wei/gas)")
    expect(fx.displayAtLastSix).toContain("chain       8453\n")
    expect(fx.displayAtLastSix).toContain("amount      0.5 ETH on chain 8453 =")

    const fromEnv = await fixture(
      { chainId: 8453n, head: () => 1_001n, receipt: () => ({ status: 1, blockNumber: 1_000n }) },
      {
        CANDLE_EVM_RPC_URL: "https://env.evm.test/rpc",
      },
    )
    expect(await fromEnv.transfer([DEAD, "--amount", "0.5", "--asset", "ETH", "--from", "hood-cold"])).toBe(0)
    expect(fromEnv.rpc.hosts).toEqual(new Set(["env.evm.test"]))
  })

  test("a blank CANDLE_EVM_RPC_URL is unset and uses the built-in host; an invalid one is a usage error before unlock", async () => {
    const blank = await fixture({}, { CANDLE_EVM_RPC_URL: "  " })
    expect(await blank.transfer([DEAD, "--amount", "0.1", "--asset", "ETH", "--from", "hood-cold"])).toBe(0)
    expect(blank.rpc.hosts).toEqual(new Set([HOOD_HOST]))
    expect(blank.stderr.text).toContain("built-in Hood RPC")

    const invalid = await fixture({}, { CANDLE_EVM_RPC_URL: "not a url" })
    expect(await invalid.transfer([DEAD, "--amount", "0.1", "--asset", "ETH", "--from", "hood-cold", "--json"])).toBe(2)
    expect(lastJson(invalid.stdout.text)).toMatchObject({
      ok: false,
      code: "USAGE",
      message: expect.stringContaining("CANDLE_EVM_RPC_URL is not a valid URL"),
    })
    expect(invalid.rpc.methods).toEqual([])
    expect(invalid.asked).toEqual([])
    expect(invalid.events).toEqual([])

    const cleartext = await fixture({}, { CANDLE_EVM_RPC_URL: "http://rpc.example.test/rpc" })
    expect(await cleartext.transfer([DEAD, "--amount", "0.1", "--asset", "ETH", "--from", "hood-cold"])).toBe(2)
    expect(cleartext.stderr.text).toContain("must be https://")
    expect(cleartext.rpc.methods).toEqual([])
    expect(cleartext.asked).toEqual([])
    expect(cleartext.events).toEqual([])
  })

  test("a Solana --from still needs --rpc-url and a Solana destination; --rpc-url is optional for an EVM --from only", async () => {
    const fx = await fixture()
    expect(await fx.transfer([SOLANA_DESTINATION, "--amount", "1", "--asset", "SOL", "--from", "cold"])).toBe(2)
    expect(fx.stderr.text).toContain("--rpc-url <url> is required for a transfer from a Solana key.")
    expect(fx.rpc.methods).toEqual([])
  })
})

describe("E7: native max", () => {
  test("estimates at value 0, then sets value to balance minus the fee cap, and the display shows the reduced value", async () => {
    const fx = await fixture({ balance: 1n * ETH, estimate: 21_000n, baseFee: 100n, tip: 10n })
    expect(await fx.transfer([DEAD, "--amount", "max", "--asset", "ETH", "--from", "hood-cold", "--json"])).toBe(0)
    const estimateCall = fx.rpc.params.eth_estimateGas?.[0]?.[0] as { value: string; to: string }
    expect(estimateCall.value).toBe("0x0")
    expect(estimateCall.to.toLowerCase()).toBe(DEAD.toLowerCase())
    const feeCap = 25_200n * 210n
    const expected = ETH - feeCap
    expect(fx.displayAtLastSix).toContain(`amount      ${(Number(expected) / 1e18).toString()}`)
    expect(fx.displayAtLastSix).toContain(`= ${expected} wei`)
    const tx = parseTransaction(fx.rpc.sent[0] as `0x${string}`)
    expect(tx.value).toBe(expected)
    expect(lastJson(fx.stdout.text)).toMatchObject({ amountRaw: expected.toString() })
  })

  test("refused with EVM_INSUFFICIENT_FOR_FEES when the balance does not exceed the fee cap, before any signature", async () => {
    const fx = await fixture({ balance: 25_200n * 210n, estimate: 21_000n, baseFee: 100n, tip: 10n })
    expect(await fx.transfer([DEAD, "--amount", "max", "--asset", "ETH", "--from", "hood-cold", "--json"])).toBe(1)
    expect(lastJson(fx.stdout.text)).toMatchObject({ ok: false, code: "EVM_INSUFFICIENT_FOR_FEES" })
    expect(fx.rpc.sent).toEqual([])
    expect(fx.events).toEqual([])
  })

  test("ERC-20 max sends the whole balanceOf", async () => {
    const fx = await fixture({ decimals: 6, tokenBalance: 123_456n })
    expect(await fx.transfer([DEAD, "--amount", "max", "--asset", "USDG", "--from", "hood-cold", "--json"])).toBe(0)
    expect(lastJson(fx.stdout.text)).toMatchObject({ amountRaw: "123456", amount: "0.123456" })
  })
})

describe("E5: every pre-sign refusal in D6 fires with no signature", () => {
  const cases: Array<{ code: string; script: NodeScript; args: string[]; prompts?: string[] }> = [
    { code: "EVM_CHAIN_MISMATCH", script: { chainId: 1n }, args: [DEAD, "--amount", "0.1", "--asset", "ETH"] },
    {
      code: "EVM_CHAIN_MISMATCH",
      script: { chainIdLater: 1n },
      args: [DEAD, "--amount", "0.1", "--asset", "ETH"],
      prompts: ["last-six", "factor"],
    },
    {
      code: "EVM_NONCE_STALE",
      script: { nonce: 7n, nonceLater: 8n },
      args: [DEAD, "--amount", "0.1", "--asset", "ETH"],
      prompts: ["last-six", "factor"],
    },
    {
      code: "EVM_TOKEN_UNREADABLE",
      script: { decimals: "unreadable" },
      args: [DEAD, "--amount", "1", "--asset", OTHER_TOKEN],
    },
    { code: "EVM_AMOUNT_PRECISION", script: { decimals: 6 }, args: [DEAD, "--amount", "1.0000001", "--asset", "USDG"] },
    {
      code: "EVM_INSUFFICIENT_FOR_FEES",
      script: { balance: 1_000n },
      args: [DEAD, "--amount", "0.1", "--asset", "ETH"],
    },
    {
      code: "EVM_INSUFFICIENT_FOR_FEES",
      script: { balance: 1_000n, decimals: 6 },
      args: [DEAD, "--amount", "1", "--asset", "USDG"],
    },
    { code: "EVM_DESTINATION_INVALID", script: {}, args: ["0x1234", "--amount", "0.1", "--asset", "ETH"] },
    {
      code: "EVM_DESTINATION_INVALID",
      script: {},
      // The fixture address with one hex letter's case flipped: mixed case that fails EIP-55.
      args: ["0x000000000000000000000000000000000000dEAD", "--amount", "0.1", "--asset", "ETH"],
    },
    { code: "EVM_SELF_TRANSFER", script: {}, args: [FIXTURE_EVM_0, "--amount", "0.1", "--asset", "ETH"] },
    { code: "EVM_SELF_TRANSFER", script: {}, args: [FIXTURE_EVM_0.toLowerCase(), "--amount", "1", "--asset", "USDG"] },
    { code: "EVM_RECIPIENT_IS_TOKEN", script: {}, args: [USDG, "--amount", "1", "--asset", "USDG"] },
    { code: "TRANSFER_CHAIN_MISMATCH", script: {}, args: [SOLANA_DESTINATION, "--amount", "0.1", "--asset", "ETH"] },
  ]
  test("a native amount above the balance is EVM_INSUFFICIENT_FOR_FEES before eth_estimateGas", async () => {
    const fx = await fixture({ balance: 1_000n })
    expect(await fx.transfer([DEAD, "--amount", "1", "--asset", "ETH", "--from", "hood-cold", "--json"])).toBe(1)
    expect(lastJson(fx.stdout.text)).toMatchObject({ ok: false, code: "EVM_INSUFFICIENT_FOR_FEES" })
    expect(fx.rpc.methods).not.toContain("eth_estimateGas")
    expect(fx.rpc.sent).toEqual([])
    expect(fx.events).toEqual([])
  })
  for (const c of cases) {
    test(`${c.code}: exit 1, no eth_sendRawTransaction, no hash in --json (${c.args[0]?.slice(0, 12)} ${c.args[4]})`, async () => {
      const fx = await fixture(c.script)
      expect(await fx.transfer([...c.args, "--from", "hood-cold", "--json"])).toBe(1)
      const body = lastJson(fx.stdout.text)
      expect(body).toMatchObject({ ok: false, code: c.code })
      expect(Object.hasOwn(body, "hash")).toBe(false)
      expect(body.details).toBeUndefined()
      expect(fx.rpc.sent).toEqual([])
      expect(fx.rpc.methods).not.toContain("eth_sendRawTransaction")
      expect(fx.events).toEqual(c.prompts ?? [])
    })
  }

  test("TRANSFER_CHAIN_MISMATCH the other way: a 0x destination for a Solana key, before any read", async () => {
    const fx = await fixture()
    expect(
      await fx.transfer([
        DEAD,
        "--amount",
        "1",
        "--asset",
        "SOL",
        "--from",
        "cold",
        "--rpc-url",
        "https://sol.test/rpc",
        "--json",
      ]),
    ).toBe(1)
    expect(lastJson(fx.stdout.text)).toMatchObject({ ok: false, code: "TRANSFER_CHAIN_MISMATCH" })
    expect(fx.rpc.methods).toEqual([])
  })

  test("the refusals that need no read happen before the host line and before any request", async () => {
    const fx = await fixture()
    expect(await fx.transfer([SOLANA_DESTINATION, "--amount", "0.1", "--asset", "ETH", "--from", "hood-cold"])).toBe(1)
    expect(fx.rpc.methods).toEqual([])
    expect(fx.stderr.text).not.toContain(HOOD_HOST)
  })

  test("an EVM entry that is not a vault key does not sign in 4a (4b widens --from to a promoted EVM wallet)", async () => {
    const fx = await fixture()
    // `assertTransferSigner` admits `tee-wallet` by role for Solana; the EVM flow admits `vault`
    // only. A hand-edited EVM `tee-wallet` entry (no command writes one until 4b) is refused
    // before any read.
    const vault = await reopen(fx.path)
    await commitVault(
      vault,
      {
        index: {
          hd: vault.index.hd,
          entries: vault.index.entries.map((entry) =>
            entry.chain === "evm"
              ? {
                  ...entry,
                  role: "tee-wallet" as const,
                  tee: { network: "solana-mainnet" as const, lifecycle: "local-candidate" as const },
                }
              : entry,
          ),
        },
      },
      testClock,
    )
    closeVault(vault)
    expect(await fx.transfer([DEAD, "--amount", "0.1", "--asset", "ETH", "--from", "hood-cold", "--json"])).toBe(1)
    expect(lastJson(fx.stdout.text)).toMatchObject({ ok: false, code: "PROMOTE_NOT_VAULT_KEY" })
    expect(fx.rpc.methods).toEqual([])
    // By address, a vault key still signs.
    const byAddress = await fixture()
    expect(
      await byAddress.transfer([DEAD, "--amount", "0.1", "--asset", "ETH", "--from", FIXTURE_EVM_0, "--json"]),
    ).toBe(0)
  })
})

describe("E6: after the signature, the hash is known and the receipt decides", () => {
  test("a reverted receipt exits 1 with EVM_TRANSFER_REVERTED, the hash in details, and says the fee was spent", async () => {
    const fx = await fixture({ receipt: () => ({ status: 0, blockNumber: 1_000n }) })
    expect(await fx.transfer([DEAD, "--amount", "0.1", "--asset", "ETH", "--from", "hood-cold", "--json"])).toBe(1)
    const body = lastJson(fx.stdout.text)
    expect(body).toMatchObject({ ok: false, code: "EVM_TRANSFER_REVERTED" })
    expect(String(body.message)).toContain("the fee was spent")
    expect(body.details).toMatchObject({ chainId: "4663", blockNumber: "1000", status: "reverted" })
    expect(String((body.details as { hash: string }).hash)).toMatch(/^0x[0-9a-f]{64}$/)
    expect(fx.rpc.sent).toHaveLength(1)
  })

  test("no receipt within 120 s exits 3 with the hash and the do-not-resend sentence", async () => {
    const fx = await fixture({ receipt: () => null })
    expect(await fx.transfer([DEAD, "--amount", "0.1", "--asset", "ETH", "--from", "hood-cold"])).toBe(3)
    expect(fx.stdout.text).toMatch(
      /Submitted 0x[0-9a-f]{64}; no receipt after 120 s\. It may still land: do not resend blindly/,
    )
    // The fake clock advanced through the whole wait, polling every 2 s.
    expect(fx.rpc.methods.filter((m) => m === "eth_getTransactionReceipt").length).toBe(EVM_RECEIPT_WAIT_MS / 2_000 + 1)
    expect(fx.rpc.sent).toHaveLength(1)
  })

  test("confirmed at depth 1 on Hood exits 0 as soon as the block is the head; --json says depth 1 and finalized false", async () => {
    const fx = await fixture({
      receipt: (poll) => (poll < 2 ? null : { status: 1, blockNumber: 1_000n }),
      head: () => 1_000n,
    })
    expect(await fx.transfer([DEAD, "--amount", "0.1", "--asset", "ETH", "--from", "hood-cold", "--json"])).toBe(0)
    expect(lastJson(fx.stdout.text)).toMatchObject({
      ok: true,
      status: "confirmed",
      blockNumber: "1000",
      depth: 1,
      finalized: false,
    })
    expect(fx.rpc.methods.filter((m) => m === "eth_getTransactionReceipt")).toHaveLength(3)
  })

  test("a receipt short of depth at 120 s exits 3 with the hash: in a block, not yet depth-confirmed", async () => {
    // Chain id 8453 needs 2 blocks; the head never moves past the receipt's block.
    const fx = await fixture(
      { chainId: 8453n, receipt: () => ({ status: 1, blockNumber: 1_000n }), head: () => 1_000n },
      {
        CANDLE_EVM_RPC_URL: "https://base.test/rpc",
      },
    )
    expect(await fx.transfer([DEAD, "--amount", "0.1", "--asset", "ETH", "--from", "hood-cold", "--json"])).toBe(3)
    expect(lastJson(fx.stdout.text)).toMatchObject({
      ok: false,
      status: "uncertain",
      blockNumber: "1000",
      depth: 2,
      finalized: false,
    })
    const human = await fixture(
      { chainId: 8453n, receipt: () => ({ status: 1, blockNumber: 1_000n }), head: () => 1_000n },
      {
        CANDLE_EVM_RPC_URL: "https://base.test/rpc",
      },
    )
    expect(await human.transfer([DEAD, "--amount", "0.1", "--asset", "ETH", "--from", "hood-cold"])).toBe(3)
    expect(human.stdout.text).toContain("is in block 1000 but not yet 2 blocks deep after 120 s. Do not resend")
  })

  test("a transport error on send exits 3 with the locally computed hash", async () => {
    const fx = await fixture({ send: "transport" })
    expect(await fx.transfer([DEAD, "--amount", "0.1", "--asset", "ETH", "--from", "hood-cold", "--json"])).toBe(3)
    const body = lastJson(fx.stdout.text)
    expect(body).toMatchObject({ ok: false, status: "uncertain", finalized: false })
    expect(String(body.hash)).toMatch(/^0x[0-9a-f]{64}$/)
    // Nothing was read after the failed send: the hash is local, not the node's.
    expect(fx.rpc.methods.at(-1)).toBe("eth_sendRawTransaction")
  })

  test("`already known` on send exits 3 with the hash: it is in flight", async () => {
    const fx = await fixture({ send: { error: "already known" } })
    expect(await fx.transfer([DEAD, "--amount", "0.1", "--asset", "ETH", "--from", "hood-cold"])).toBe(3)
    expect(fx.stdout.text).toMatch(/Submitted 0x[0-9a-f]{64}: the RPC already knows it, so it is in flight/)
  })

  test("`nonce too low` with a receipt follows the receipt: confirmed here", async () => {
    const fx = await fixture({
      send: { error: "nonce too low" },
      receipt: () => ({ status: 1, blockNumber: 999n }),
      head: () => 1_000n,
    })
    expect(await fx.transfer([DEAD, "--amount", "0.1", "--asset", "ETH", "--from", "hood-cold", "--json"])).toBe(0)
    expect(lastJson(fx.stdout.text)).toMatchObject({ ok: true, status: "confirmed", blockNumber: "999" })
    expect(fx.rpc.methods.filter((m) => m === "eth_getTransactionReceipt")).toHaveLength(1)
  })

  test("`nonce too low` with a receipt still exits 3 with the hash when eth_blockNumber fails", async () => {
    const fx = await fixture({
      send: { error: "nonce too low" },
      receipt: () => ({ status: 1, blockNumber: 999n }),
      blockNumberThrows: true,
    })
    expect(await fx.transfer([DEAD, "--amount", "0.1", "--asset", "ETH", "--from", "hood-cold", "--json"])).toBe(3)
    const body = lastJson(fx.stdout.text)
    expect(body).toMatchObject({ ok: false, status: "uncertain", blockNumber: "999", finalized: false })
    expect(String(body.hash)).toMatch(/^0x[0-9a-f]{64}$/)
    expect(body.code).toBeUndefined()
    expect(fx.rpc.sent).toHaveLength(1)
  })

  test("`nonce too low` with no receipt exits 1 EVM_NONCE_STALE and prints the hash; the CLI never re-signs", async () => {
    const fx = await fixture({ send: { error: "nonce too low" }, receipt: () => null })
    expect(await fx.transfer([DEAD, "--amount", "0.1", "--asset", "ETH", "--from", "hood-cold", "--json"])).toBe(1)
    const body = lastJson(fx.stdout.text)
    expect(body).toMatchObject({ ok: false, code: "EVM_NONCE_STALE" })
    expect(String((body.details as { hash: string }).hash)).toMatch(/^0x[0-9a-f]{64}$/)
    expect(String(body.suggestion)).toContain("never re-signs")
    expect(fx.rpc.sent).toHaveLength(1)
  })
})

describe("E8: named assets and depth follow the chain id, not the endpoint", () => {
  test("USDG is refused off chain id 4663 (usage, exit 2) before any nonce or fee read; ETH there names the chain", async () => {
    const fx = await fixture({ chainId: 8453n }, { CANDLE_EVM_RPC_URL: "https://base.test/rpc" })
    expect(await fx.transfer([DEAD, "--amount", "1", "--asset", "USDG", "--from", "hood-cold", "--json"])).toBe(2)
    expect(lastJson(fx.stdout.text)).toMatchObject({ ok: false, code: "USAGE" })
    expect(String(lastJson(fx.stdout.text).message)).toContain("USDG is named on Hood (chain id 4663) only")
    expect(fx.rpc.methods).toEqual(["eth_chainId"])
    expect(fx.rpc.sent).toEqual([])

    const eth = await fixture(
      { chainId: 8453n, head: () => 1_001n, receipt: () => ({ status: 1, blockNumber: 1_000n }) },
      {
        CANDLE_EVM_RPC_URL: "https://base.test/rpc",
      },
    )
    expect(await eth.transfer([DEAD, "--amount", "0.1", "--asset", "ETH", "--from", "hood-cold"])).toBe(0)
    expect(eth.displayAtLastSix).toContain("chain       8453")
    expect(eth.displayAtLastSix).toContain("0.1 ETH on chain 8453")
    expect(eth.factorPrompt).toContain("on chain 8453")
    // Depth 2 off Hood: head 1001 with the receipt in 1000 is exactly 2 deep.
    expect(eth.stdout.text).toContain("2 blocks deep (depth 2, not finality)")
  })

  test("depth 1 follows chain id 4663 on a non-default RPC, and a token by address off Hood is read from its contract", async () => {
    const hoodElsewhere = await fixture(
      { chainId: 4663n, receipt: () => ({ status: 1, blockNumber: 1_000n }), head: () => 1_000n },
      {
        CANDLE_EVM_RPC_URL: "https://my-hood.test/rpc",
      },
    )
    expect(
      await hoodElsewhere.transfer([DEAD, "--amount", "0.1", "--asset", "ETH", "--from", "hood-cold", "--json"]),
    ).toBe(0)
    expect(lastJson(hoodElsewhere.stdout.text)).toMatchObject({ status: "confirmed", depth: 1 })
    expect(hoodElsewhere.rpc.hosts).toEqual(new Set(["my-hood.test"]))

    const token = await fixture(
      {
        chainId: 8453n,
        decimals: 18,
        symbol: "WETH",
        head: () => 1_001n,
        receipt: () => ({ status: 1, blockNumber: 1_000n }),
      },
      {
        CANDLE_EVM_RPC_URL: "https://base.test/rpc",
      },
    )
    expect(
      await token.transfer([DEAD, "--amount", "0.25", "--asset", OTHER_TOKEN, "--from", "hood-cold", "--json"]),
    ).toBe(0)
    expect(token.displayAtLastSix).toContain("(the WETH contract, 18 dp)")
    expect(lastJson(token.stdout.text)).toMatchObject({ asset: "WETH", amountRaw: "250000000000000000", depth: 2 })
  })
})
