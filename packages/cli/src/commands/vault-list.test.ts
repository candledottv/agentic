/**
 * BE-274, T4 to T11: `candle vault list`.
 *
 * Every test drives the real dispatcher with fake `Deps`, against a real vault written through the
 * real `commitVault`, so what is exercised is the command an operator types. The RPC is a scripted
 * `fetch` that records every method and every chunk it is asked for -- no network, in the shape
 * `solana-lite.test.ts` already uses -- which is what makes D8's cost claim ("four requests for a
 * 304-key vault, and `getMultipleAccounts` is the only method") an assertion rather than a promise.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import type { Deps } from "../deps"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"
import type { IndexPlaintext, KeyEntry } from "../vault/format"
import { closeVault, commitVault } from "../vault/store"
import { FIXTURE_PASSPHRASE, makeVault, testClock, useCheapKdf } from "../vault/test-vault"
import { formatSol } from "./vault-list"
import { LIST_POINTER } from "./vault-status"

// Real Argon2id at ED-3's floor, several times over, on a shared runner. See vault.test.ts.
setDefaultTimeout(60_000)

useCheapKdf()

const RPC_URL = "https://rpc.example.test/candle"
const RPC_HOST = "rpc.example.test"

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
const STEM = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJos"

/** A unique, base58-shaped 44-character address per index. Never a real one: nothing signs here. */
function fakeAddress(index: number): string {
  let tail = ""
  let n = index
  for (let i = 0; i < 4; i += 1) {
    tail = `${B58[n % 58] as string}${tail}`
    n = Math.floor(n / 58)
  }
  return `${STEM}${tail}`
}

interface EntryOptions {
  label: string
  role?: KeyEntry["role"]
  chain?: KeyEntry["chain"]
  /** `migrated-tee` records no derivation, which is the DERIVATION column's `-` case. */
  origin?: KeyEntry["origin"]
}

function entryAt(index: number, opts: EntryOptions): KeyEntry {
  const role = opts.role ?? "vault"
  const chain = opts.chain ?? "solana"
  const origin = opts.origin ?? "derived"
  const branch = role === "tee-wallet" ? "1" : role === "external" ? "2" : "0"
  const derivation =
    origin === "migrated-tee"
      ? undefined
      : chain === "evm"
        ? { scheme: "bip32-secp256k1" as const, path: `m/44'/60'/${index}'/0/0` }
        : { scheme: "slip10-ed25519" as const, path: `m/44'/501'/${index}'/${branch}'` }
  return {
    id: `key-${String(index).padStart(3, "0")}`,
    chain,
    curve: chain === "evm" ? "secp256k1" : "ed25519",
    address: fakeAddress(index),
    label: opts.label,
    createdAt: "2026-09-22T12:00:00.000Z",
    role,
    origin,
    ...(derivation ? { derivation } : {}),
    exposure: { everRemoteExposed: false, everExported: false },
    ...(role === "tee-wallet"
      ? { tee: { lifecycle: "local-candidate" as const, network: "solana-mainnet" as const } }
      : {}),
  }
}

/** A real vault whose index is exactly `entries`, written through the real commit path. */
async function vaultWith(entries: KeyEntry[]): Promise<{ dir: string; path: string }> {
  const made = await makeVault()
  try {
    const highest = (branch: string) =>
      entries.reduce((max, entry) => {
        const match = new RegExp(`^m/44'/501'/(\\d+)'/${branch}'$`).exec(entry.derivation?.path ?? "")
        return match?.[1] === undefined ? max : Math.max(max, Number(match[1]) + 1)
      }, 0)
    const index: IndexPlaintext = {
      hd: {
        ...made.vault.index.hd,
        nextIndex: {
          solanaVault: highest("0"),
          solanaTee: highest("1"),
          solanaExternal: highest("2"),
          evm: entries.some((entry) => entry.chain === "evm") ? 1000 : 0,
        },
      },
      entries,
    }
    await commitVault(made.vault, { index }, testClock)
  } finally {
    closeVault(made.vault)
  }
  return { dir: made.dir, path: made.path }
}

interface Harness {
  deps: Deps
  stdout: ReturnType<typeof createCapture>
  stderr: ReturnType<typeof createCapture>
  asked: string[]
  /** Every Solana JSON-RPC request the run made, in order: its method and the addresses it asked for. */
  calls: { method: string; addresses: string[] }[]
  /** Phase 4a (E10): every EVM JSON-RPC request, with the host it went to. */
  evmCalls: { host: string; method: string; params: unknown[] }[]
}

/** The built-in Hood host, as `vault list` prints it (E10). */
const HOOD_HOST = "rpc.mainnet.chain.robinhood.com"
const ZERO_WORD = `0x${"0".repeat(64)}`
/** An EVM-shaped fixture address: an EVM row carries a 0x address, never a base58 one. */
const EVM_FIXTURE = "0x000000000000000000000000000000000000dEaD"

/**
 * A scripted RPC. `lamports` answers per address; `failCall` is the 1-based call that answers HTTP
 * 429, which is how D11's partial read is produced -- one CALL fails, not one address inside a
 * call, because that is the unit `getMultipleAccounts` throws at.
 */
function harness(
  opts: {
    dir?: string
    env?: Record<string, string>
    tty?: { stdin: boolean; stdout: boolean; stderr: boolean }
    secrets?: string[]
    lamports?: (address: string) => bigint
    failCall?: number
    /** Phase 4a: the EVM node. Answers per method; a missing answer falls back to Hood-shaped zeros. */
    evm?: (method: string, params: unknown[]) => unknown
  } = {},
): Harness {
  const stdout = createCapture()
  const stderr = createCapture()
  const asked: string[] = []
  const calls: { method: string; addresses: string[] }[] = []
  const evmCalls: Harness["evmCalls"] = []
  const secrets = [...(opts.secrets ?? [FIXTURE_PASSPHRASE])]
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] }
    if (body.method.startsWith("eth_")) {
      evmCalls.push({ host: new URL(String(input)).host, method: body.method, params: body.params })
      const scripted = opts.evm?.(body.method, body.params)
      const result =
        scripted !== undefined
          ? scripted
          : body.method === "eth_chainId"
            ? "0x1237"
            : body.method === "eth_getBalance"
              ? "0x0"
              : ZERO_WORD
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    const addresses = body.method === "getMultipleAccounts" ? (body.params[0] as string[]) : []
    calls.push({ method: body.method, addresses })
    if (opts.failCall === calls.length) return new Response("rate limited", { status: 429 })
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          value: addresses.map((address) => {
            const lamports = opts.lamports?.(address) ?? 0n
            // A never-funded address comes back null, which is zero: the path that would read a
            // missing account as anything else is the one worth exercising.
            return lamports === 0n ? null : { owner: STEM, lamports: Number(lamports), data: ["", "base64"] }
          }),
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as typeof fetch
  const deps = createTestDeps({
    fetch: fetchFn,
    stdout,
    stderr,
    env: { ...(opts.dir ? { CANDLE_CONFIG_DIR: opts.dir, HOME: opts.dir } : {}), ...(opts.env ?? {}) },
    isTTY: opts.tty ?? { stdin: true, stdout: true, stderr: true },
    promptSecret: async (text: string) => {
      asked.push(text)
      const next = secrets.shift()
      if (next === undefined) throw new Error(`promptSecret asked for more than the test scripted: ${text}`)
      return next
    },
  })
  return { deps, stdout, stderr, asked, calls, evmCalls }
}

const THREE_KEYS = [
  entryAt(0, { label: "treasury" }),
  entryAt(1, { label: "cn-sol-1" }),
  entryAt(2, { label: "", role: "tee-wallet", origin: "migrated-tee" }),
]

describe("T4: the listing itself", () => {
  test("one line per key, four columns, in index order, with the prompt on stderr", async () => {
    const fx = await vaultWith(THREE_KEYS)
    const h = harness({ dir: fx.dir })
    expect(await run(["vault", "list"], h.deps)).toBe(0)

    expect(h.stdout.text.startsWith(`3 keys in ${fx.path}\n`)).toBe(true)
    expect(h.stdout.text).toContain("ADDRESS")
    expect(h.stdout.text).toContain("LABEL")
    expect(h.stdout.text).toContain("ROLE")
    expect(h.stdout.text).toContain("DERIVATION")
    const lines = h.stdout.text.split("\n")
    const rows = lines.filter((line) => line.startsWith(STEM))
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain("treasury")
    expect(rows[0]).toContain("vault")
    expect(rows[0]).toContain("m/44'/501'/0'/0'")
    // An empty label reads `(none)`, matching status, and an entry with no derivation reads `-`.
    expect(rows[2]).toContain("(none)")
    expect(rows[2]).toContain("tee-wallet")
    expect((rows[2] as string).trimEnd().endsWith("-")).toBe(true)
    // Index order, not sorted by anything.
    expect(rows.map((row) => (row as string).slice(0, 44))).toEqual(THREE_KEYS.map((entry) => entry.address))

    // The passphrase prompt is the command's only prompt, and it is not on stdout.
    expect(h.asked).toHaveLength(1)
    expect(h.stdout.text.toLowerCase()).not.toContain("passphrase")
    // Offline by default: no flag, no request.
    expect(h.calls).toEqual([])
  })

  test("SOL cells are the nine-decimal integer quotient, trimmed, and `0` exactly", () => {
    expect(formatSol(12_482_193_200n)).toBe("12.4821932")
    expect(formatSol(2_039_280n)).toBe("0.00203928")
    expect(formatSol(1_000_000_000n)).toBe("1")
    expect(formatSol(0n)).toBe("0")
    expect(formatSol(13_484_232_480n)).toBe("13.48423248")
    // A u64 that does not survive Number, which is why this is BigInt arithmetic and why `--json`
    // carries lamports as a string.
    expect(formatSol(18_446_744_073_709_551_615n)).toBe("18446744073.709551615")
  })
})

describe("T5: it prompts, and the env passphrase is refused", () => {
  test("there is no --unlock flag: the index is encrypted, so the prompt is the command", async () => {
    const fx = await vaultWith(THREE_KEYS)
    const h = harness({ dir: fx.dir })
    expect(await run(["vault", "list", "--unlock"], h.deps)).toBe(2)
    expect(h.stderr.text).toContain("Unknown flag: --unlock")
    expect(h.asked).toEqual([])
  })

  test("CANDLE_KEYSTORE_PASSPHRASE is refused before anything is read", async () => {
    const fx = await vaultWith(THREE_KEYS)
    const h = harness({ dir: fx.dir, env: { CANDLE_KEYSTORE_PASSPHRASE: "nope" } })
    expect(await run(["vault", "list"], h.deps)).toBe(1)
    expect(h.stderr.text).toContain("CANDLE_KEYSTORE_PASSPHRASE is set")
    expect(h.asked).toEqual([])

    const json = harness({ dir: fx.dir, env: { CANDLE_KEYSTORE_PASSPHRASE: "nope" } })
    expect(await run(["vault", "list", "--json"], json.deps)).toBe(1)
    expect((JSON.parse(json.stdout.text) as { code: string }).code).toBe("ENV_PASSPHRASE_REFUSED")
  })
})

describe("T6: the filter, and what a filtered balance read sends", () => {
  test("it narrows on label and on address, case-insensitively", async () => {
    const fx = await vaultWith(THREE_KEYS)
    const byLabel = harness({ dir: fx.dir })
    expect(await run(["vault", "list", "CN-S"], byLabel.deps)).toBe(0)
    expect(byLabel.stdout.text.startsWith(`1 of 3 keys match "CN-S" in ${fx.path}\n`)).toBe(true)
    expect(byLabel.stdout.text.split("\n").filter((line) => line.startsWith(STEM))).toHaveLength(1)

    const byAddress = harness({ dir: fx.dir })
    const tail = (THREE_KEYS[1] as KeyEntry).address.slice(-6).toLowerCase()
    expect(await run(["vault", "list", tail], byAddress.deps)).toBe(0)
    expect(byAddress.stdout.text).toContain("1 of 3 keys match")
    expect(byAddress.stdout.text).toContain((THREE_KEYS[1] as KeyEntry).address)
  })

  test("no match is exit 0, with the line that says what the vault holds", async () => {
    const fx = await vaultWith(THREE_KEYS)
    const h = harness({ dir: fx.dir })
    expect(await run(["vault", "list", "cn-x"], h.deps)).toBe(0)
    expect(h.stdout.text).toBe(
      'No key matches "cn-x". 3 keys in this vault; candle vault list with no filter lists them.\n',
    )
    expect(h.stdout.text).not.toContain("ADDRESS")
  })

  test("the batch is the matched Solana set: the unmatched addresses are never sent", async () => {
    const fx = await vaultWith(THREE_KEYS)
    const h = harness({ dir: fx.dir, lamports: () => 1_000_000_000n })
    expect(await run(["vault", "list", "cn-s", "--balances", "--rpc-url", RPC_URL], h.deps)).toBe(0)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.addresses).toEqual([(THREE_KEYS[1] as KeyEntry).address])
    expect(h.stderr.text).toContain(
      `Reading SOL for 1 addresses from ${RPC_HOST}, in 1 request. That endpoint sees all 1 together.`,
    )
    expect(h.stdout.text).toContain("total  1 SOL across 1 keys")
  })

  test("no Solana match makes no request, prints no Reading SOL line, and carries the zero-request object", async () => {
    const fx = await vaultWith(THREE_KEYS)
    const h = harness({ dir: fx.dir })
    expect(await run(["vault", "list", "cn-x", "--balances", "--rpc-url", RPC_URL, "--json"], h.deps)).toBe(0)
    expect(h.calls).toEqual([])
    expect(h.stderr.text).not.toContain("Reading SOL")
    const body = JSON.parse(h.stdout.text) as { matched: number; entries: unknown[]; balances: unknown }
    expect(body.matched).toBe(0)
    expect(body.entries).toEqual([])
    expect(body.balances).toEqual({
      rpcHost: RPC_HOST,
      requests: 0,
      complete: true,
      totalLamports: "0",
      unavailable: [],
    })
  })

  test("an evm-only match is a match: the table prints, the SOL cell is `-`, and 0 Solana keys are read", async () => {
    const fx = await vaultWith([
      entryAt(0, { label: "treasury" }),
      { ...entryAt(1, { label: "hood-evm", chain: "evm" }), address: EVM_FIXTURE },
    ])
    const h = harness({ dir: fx.dir })
    expect(await run(["vault", "list", "hood", "--balances", "--rpc-url", RPC_URL], h.deps)).toBe(0)
    // Phase 4a: the Solana endpoint is never sent the EVM address; the EVM row is read from Hood.
    expect(h.calls).toEqual([])
    expect(h.stderr.text).not.toContain("Reading SOL")
    expect(h.stdout.text).toContain("1 of 2 keys match")
    const row = h.stdout.text.split("\n").find((line) => line.startsWith(EVM_FIXTURE)) as string
    // SOL `-`, then ETH 0 and USDG 0 from the Hood read.
    expect(row.trimEnd()).toMatch(/-\s+0\s+0$/)
    // The 0 is the Solana key count: the matched evm key is in the match line and not in this one.
    expect(h.stdout.text).toContain("total  0 SOL across 0 keys")
  })

  test("an evm entry stays in --json with no lamports key at all, and is not `unavailable`", async () => {
    const fx = await vaultWith([
      entryAt(0, { label: "treasury" }),
      { ...entryAt(1, { label: "hood-evm", chain: "evm" }), address: EVM_FIXTURE },
    ])
    const h = harness({ dir: fx.dir, lamports: () => 2_039_280n })
    expect(await run(["vault", "list", "--balances", "--rpc-url", RPC_URL, "--json"], h.deps)).toBe(0)
    const body = JSON.parse(h.stdout.text) as {
      entries: { address: string; lamports?: string | null; wei?: string | null }[]
      balances: { totalLamports: string; unavailable: string[] }
    }
    expect(body.entries[0]?.lamports).toBe("2039280")
    expect(Object.hasOwn(body.entries[1] as object, "lamports")).toBe(false)
    expect(Object.hasOwn(body.entries[0] as object, "wei")).toBe(false)
    expect(body.entries[1]?.wei).toBe("0")
    expect(body.balances.totalLamports).toBe("2039280")
    expect(body.balances.unavailable).toEqual([])
  })
})

/**
 * Phase 4a (BE-350, spec 2026-09-24-ember-phase-4a-evm-vault-keys-design.md, D3, D7), E10: EVM rows
 * are read from the built-in Hood host when no `--evm-rpc-url` is given, that host is printed on
 * stderr, the Solana `--rpc-url` is never sent an EVM address, and Hood USDG is included when the
 * chain id is 4663.
 */
describe("E10: EVM rows under --balances", () => {
  const EVM_ADDRESS = EVM_FIXTURE
  const vaultWithEvm = () =>
    vaultWith([
      entryAt(0, { label: "treasury" }),
      { ...entryAt(1, { label: "hood-cold", chain: "evm" }), address: EVM_ADDRESS },
    ])

  test("no --evm-rpc-url: the built-in Hood host is read and printed, and the Solana RPC sees no 0x address", async () => {
    const fx = await vaultWithEvm()
    const h = harness({
      dir: fx.dir,
      lamports: () => 1_000_000_000n,
      evm: (method, params) => {
        if (method === "eth_chainId") return "0x1237"
        if (method === "eth_getBalance") return "0x1bc16d674ec80000" // 2 ETH
        if (method === "eth_call") {
          const call = params[0] as { to: string; data: string }
          expect(call.to.toLowerCase()).toBe("0x5fc5360d0400a0fd4f2af552add042d716f1d168")
          expect(call.data.startsWith("0x70a08231")).toBe(true)
          return `0x${1_500_000n.toString(16).padStart(64, "0")}` // 1.5 USDG
        }
        return undefined
      },
    })
    expect(await run(["vault", "list", "--balances", "--rpc-url", RPC_URL], h.deps)).toBe(0)
    // The Solana batch is the Solana key only; the EVM address went to Hood and nowhere else.
    expect(h.calls.flatMap((call) => call.addresses)).toEqual([fakeAddress(0)])
    expect(h.evmCalls.map((call) => call.host)).toEqual([HOOD_HOST, HOOD_HOST, HOOD_HOST])
    expect(h.evmCalls.map((call) => call.method)).toEqual(["eth_chainId", "eth_getBalance", "eth_call"])
    expect(h.stderr.text).toContain(`Reading ETH (and USDG when the chain is Hood) for 1 EVM address from ${HOOD_HOST}`)
    expect(h.stderr.text).not.toContain(RPC_URL)
    const row = h.stdout.text.split("\n").find((line) => line.startsWith(EVM_ADDRESS)) as string
    expect(row).toContain("hood-cold")
    expect(row.trimEnd()).toMatch(/-\s+2\s+1\.5$/)
    expect(h.stdout.text).toContain("ETH")
    expect(h.stdout.text).toContain("USDG")
    expect(h.stdout.text).toContain("total  2 ETH across 1 EVM keys on Hood")
    expect(h.stdout.text).toContain("total  1.5 USDG across those keys")
  })

  test("--evm-rpc-url, then CANDLE_EVM_RPC_URL, beat the built-in host; off Hood no USDG is read", async () => {
    const fx = await vaultWithEvm()
    const flagged = harness({
      dir: fx.dir,
      env: { CANDLE_EVM_RPC_URL: "https://env.evm.test/rpc" },
      evm: (method) => (method === "eth_chainId" ? "0x2105" : undefined),
    })
    expect(
      await run(
        ["vault", "list", "hood", "--balances", "--rpc-url", RPC_URL, "--evm-rpc-url", "https://flag.evm.test/rpc"],
        flagged.deps,
      ),
    ).toBe(0)
    expect(new Set(flagged.evmCalls.map((call) => call.host))).toEqual(new Set(["flag.evm.test"]))
    // Chain id 8453 is not Hood: the native balance only, no USDG call, and the column names the chain.
    expect(flagged.evmCalls.map((call) => call.method)).toEqual(["eth_chainId", "eth_getBalance"])
    expect(flagged.stdout.text).toContain("ETH@8453")
    expect(flagged.stdout.text).not.toContain("USDG")

    const fromEnv = harness({ dir: fx.dir, env: { CANDLE_EVM_RPC_URL: "https://env.evm.test/rpc" } })
    expect(await run(["vault", "list", "hood", "--balances", "--rpc-url", RPC_URL], fromEnv.deps)).toBe(0)
    expect(new Set(fromEnv.evmCalls.map((call) => call.host))).toEqual(new Set(["env.evm.test"]))
    expect(fromEnv.stderr.text).toContain("from env.evm.test")
  })

  test("a blank CANDLE_EVM_RPC_URL is the built-in host; an invalid one is a usage error before the prompt", async () => {
    const fx = await vaultWithEvm()
    const blank = harness({ dir: fx.dir, env: { CANDLE_EVM_RPC_URL: "   " } })
    expect(await run(["vault", "list", "--balances", "--rpc-url", RPC_URL], blank.deps)).toBe(0)
    expect(new Set(blank.evmCalls.map((call) => call.host))).toEqual(new Set([HOOD_HOST]))

    const invalid = harness({ dir: fx.dir, env: { CANDLE_EVM_RPC_URL: "not a url" } })
    expect(await run(["vault", "list", "--balances", "--rpc-url", RPC_URL], invalid.deps)).toBe(2)
    expect(invalid.stderr.text).toContain("CANDLE_EVM_RPC_URL is not a valid URL")
    expect(invalid.asked).toEqual([])
    expect(invalid.evmCalls).toEqual([])

    const cleartext = harness({ dir: fx.dir, env: { CANDLE_EVM_RPC_URL: "http://rpc.example.test/rpc" } })
    expect(await run(["vault", "list", "--balances", "--rpc-url", RPC_URL], cleartext.deps)).toBe(2)
    expect(cleartext.stderr.text).toContain("CANDLE_EVM_RPC_URL must be https://")
    expect(cleartext.asked).toEqual([])
  })

  test("--json carries wei and usdgRaw on the EVM entry and an evmBalances object; a failed read is null and exit 3", async () => {
    const fx = await vaultWithEvm()
    const ok = harness({
      dir: fx.dir,
      evm: (method) =>
        method === "eth_getBalance" ? "0x2a" : method === "eth_call" ? `0x${"0".repeat(63)}7` : undefined,
    })
    expect(await run(["vault", "list", "--balances", "--rpc-url", RPC_URL, "--json"], ok.deps)).toBe(0)
    const body = JSON.parse(ok.stdout.text) as {
      entries: { wei?: string | null; usdgRaw?: string | null }[]
      evmBalances: Record<string, unknown>
    }
    expect(body.entries[1]).toMatchObject({ wei: "42", usdgRaw: "7" })
    expect(body.evmBalances).toEqual({
      rpcHost: HOOD_HOST,
      chainId: 4663,
      requests: 3,
      complete: true,
      unavailable: [],
    })

    const failing = harness({
      dir: fx.dir,
      evm: (method) => {
        if (method === "eth_getBalance") throw new Error("boom")
        return undefined
      },
    })
    expect(await run(["vault", "list", "--balances", "--rpc-url", RPC_URL, "--json"], failing.deps)).toBe(3)
    const partial = JSON.parse(failing.stdout.text) as {
      entries: { wei?: string | null }[]
      evmBalances: { complete: boolean; unavailable: string[] }
    }
    expect(partial.entries[1]?.wei).toBeNull()
    expect(partial.evmBalances.complete).toBe(false)
    expect(partial.evmBalances.unavailable).toEqual([EVM_ADDRESS])
    expect(failing.stderr.text).toContain("1 EVM address could not be read")
  })

  test("--evm-rpc-url without --balances is a usage error, like --rpc-url", async () => {
    const fx = await vaultWithEvm()
    const h = harness({ dir: fx.dir })
    expect(await run(["vault", "list", "--evm-rpc-url", "https://flag.evm.test/rpc"], h.deps)).toBe(2)
    expect(h.stderr.text).toContain("--evm-rpc-url has no effect without --balances")
  })
})

describe("T7: one entry document, two commands", () => {
  test("list --json entries equal status --unlock's entries, key for key", async () => {
    const fx = await vaultWith(THREE_KEYS)
    const listed = harness({ dir: fx.dir })
    expect(await run(["vault", "list", "--json"], listed.deps)).toBe(0)
    const status = harness({ dir: fx.dir })
    expect(await run(["vault", "status", "--unlock", "--json"], status.deps)).toBe(0)

    const fromList = (JSON.parse(listed.stdout.text) as { entries: unknown[] }).entries
    const fromStatus = (JSON.parse(status.stdout.text) as { unlocked: { entries: unknown[] } }).unlocked.entries
    expect(fromList).toEqual(fromStatus)
    expect(fromList).toHaveLength(3)
    // And no balance key anywhere without the flag.
    expect(listed.stdout.text).not.toContain("lamports")
    expect(listed.stdout.text).not.toContain("balances")
  })

  test("the document carries the counts, the path, and the filter only when one was given", async () => {
    const fx = await vaultWith(THREE_KEYS)
    const all = harness({ dir: fx.dir })
    expect(await run(["vault", "list", "--json"], all.deps)).toBe(0)
    const body = JSON.parse(all.stdout.text) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.path).toBe(fx.path)
    expect(body.total).toBe(3)
    expect(body.matched).toBe(3)
    expect(Object.hasOwn(body, "filter")).toBe(false)

    const filtered = harness({ dir: fx.dir })
    expect(await run(["vault", "list", "cn-s", "--json"], filtered.deps)).toBe(0)
    const narrowed = JSON.parse(filtered.stdout.text) as Record<string, unknown>
    expect(narrowed.filter).toBe("cn-s")
    expect(narrowed.matched).toBe(1)
    expect(narrowed.total).toBe(3)
  })
})

describe("T8: D7's streams", () => {
  test("stdout may be a file: the listing is the document, and it answers", async () => {
    const fx = await vaultWith(THREE_KEYS)
    const h = harness({ dir: fx.dir, tty: { stdin: true, stdout: false, stderr: true } })
    expect(await run(["vault", "list", "--json"], h.deps)).toBe(0)
    expect((JSON.parse(h.stdout.text) as { entries: unknown[] }).entries).toHaveLength(3)
    expect(h.asked).toHaveLength(1)
  })

  test("stdin or stderr not a terminal is VAULT_UNLOCK_FAILED, before any prompt", async () => {
    const fx = await vaultWith(THREE_KEYS)
    for (const tty of [
      { stdin: false, stdout: true, stderr: true },
      { stdin: true, stdout: true, stderr: false },
    ]) {
      const h = harness({ dir: fx.dir, tty })
      expect(await run(["vault", "list"], h.deps)).toBe(1)
      expect(h.stderr.text).toContain(
        "vault list needs a terminal for the passphrase prompt: standard input and standard error must both be a terminal. Standard output may be redirected; that is where the listing goes.",
      )
      expect(h.asked).toEqual([])
      expect(h.stdout.text).toBe("")

      // Same refusal under --json, and its code is one VAULT_ERROR_CODES already carried (T12).
      const json = harness({ dir: fx.dir, tty })
      expect(await run(["vault", "list", "--json"], json.deps)).toBe(1)
      expect((JSON.parse(json.stdout.text) as { code: string }).code).toBe("VAULT_UNLOCK_FAILED")
    }
  })
})

describe("T9, T11: what --balances costs, and what it reads", () => {
  test("250 keys is exactly three getMultipleAccounts calls, and the total is rendered", async () => {
    const entries = Array.from({ length: 250 }, (_, i) => entryAt(i, { label: `key-${i}` }))
    const fx = await vaultWith(entries)
    // Two funded keys, 248 never funded: the total is their sum, and the rest come back null.
    const funded = new Map([
      [(entries[0] as KeyEntry).address, 12_482_193_200n],
      [(entries[249] as KeyEntry).address, 1_000_000_000n],
    ])
    const h = harness({ dir: fx.dir, lamports: (address) => funded.get(address) ?? 0n })
    expect(await run(["vault", "list", "--balances", "--rpc-url", RPC_URL], h.deps)).toBe(0)

    expect(h.calls).toHaveLength(3)
    expect(h.calls.map((call) => call.addresses.length)).toEqual([100, 100, 50])
    // T11: the invariant, not a default. Tokens cannot arrive by accident.
    expect(new Set(h.calls.map((call) => call.method))).toEqual(new Set(["getMultipleAccounts"]))
    expect(h.stderr.text).toContain(
      `Reading SOL for 250 addresses from ${RPC_HOST}, in 3 requests. That endpoint sees all 250 together.`,
    )
    expect(h.stdout.text).toContain("total  13.4821932 SOL across 250 keys")
    // Every address, once, in index order.
    expect(h.calls.flatMap((call) => call.addresses)).toEqual(entries.map((entry) => entry.address))
  })

  test("--json carries the balances object and lamports as strings", async () => {
    const entries = Array.from({ length: 250 }, (_, i) => entryAt(i, { label: `key-${i}` }))
    const fx = await vaultWith(entries)
    const h = harness({
      dir: fx.dir,
      lamports: (address) => (address === (entries[0] as KeyEntry).address ? 12_482_193_200n : 0n),
    })
    expect(await run(["vault", "list", "--balances", "--rpc-url", RPC_URL, "--json"], h.deps)).toBe(0)
    const body = JSON.parse(h.stdout.text) as {
      entries: { lamports: string | null }[]
      balances: Record<string, unknown>
    }
    expect(body.entries[0]?.lamports).toBe("12482193200")
    expect(body.entries[1]?.lamports).toBe("0")
    expect(body.balances).toEqual({
      rpcHost: RPC_HOST,
      requests: 3,
      complete: true,
      totalLamports: "12482193200",
      unavailable: [],
    })
  })

  test("the endpoint is the operator's: CANDLE_SOLANA_RPC_URL when the flag is absent", async () => {
    const fx = await vaultWith(THREE_KEYS)
    const h = harness({ dir: fx.dir, env: { CANDLE_SOLANA_RPC_URL: RPC_URL } })
    expect(await run(["vault", "list", "--balances"], h.deps)).toBe(0)
    expect(h.calls).toHaveLength(1)
  })
})

describe("T10: a failed chunk does not lose the listing", () => {
  test("its addresses print `?`, the rest stay, complete is false and the exit is 3", async () => {
    const entries = Array.from({ length: 250 }, (_, i) => entryAt(i, { label: `key-${i}` }))
    const fx = await vaultWith(entries)
    const h = harness({
      dir: fx.dir,
      lamports: (address) => (address === (entries[0] as KeyEntry).address ? 12_482_193_200n : 0n),
      // The LAST call fails, so the chunks before it returned and the count is that chunk's size.
      failCall: 3,
    })
    expect(await run(["vault", "list", "--balances", "--rpc-url", RPC_URL], h.deps)).toBe(3)

    // Every chunk was still issued, and the failed one was not retried.
    expect(h.calls).toHaveLength(3)
    const rows = h.stdout.text.split("\n").filter((line) => line.startsWith(STEM))
    expect(rows).toHaveLength(250)
    expect((rows[0] as string).endsWith("12.4821932")).toBe(true)
    expect((rows[99] as string).endsWith("0")).toBe(true)
    // The 50 addresses of the thrown call.
    expect((rows[200] as string).endsWith("?")).toBe(true)
    expect((rows[249] as string).endsWith("?")).toBe(true)
    expect(h.stdout.text).toContain("total  12.4821932 SOL across 200 of 250 keys read")
    expect(h.stderr.text).toContain("50 addresses could not be read: ")
    expect(h.stderr.text).toContain("HTTP 429")
    expect(h.stderr.text).toContain("Narrow with a filter, or use your own endpoint with --rpc-url.")
  })

  test("--json says the same thing: lamports null, complete false, requests counts the thrown call", async () => {
    const entries = Array.from({ length: 250 }, (_, i) => entryAt(i, { label: `key-${i}` }))
    const fx = await vaultWith(entries)
    const h = harness({
      dir: fx.dir,
      lamports: (address) => (address === (entries[0] as KeyEntry).address ? 12_482_193_200n : 0n),
      failCall: 3,
    })
    expect(await run(["vault", "list", "--balances", "--rpc-url", RPC_URL, "--json"], h.deps)).toBe(3)
    const body = JSON.parse(h.stdout.text) as {
      entries: { address: string; lamports: string | null }[]
      balances: { requests: number; complete: boolean; totalLamports: string; unavailable: string[] }
    }
    expect(body.entries[0]?.lamports).toBe("12482193200")
    expect(body.entries[200]?.lamports).toBeNull()
    expect(body.balances.requests).toBe(3)
    expect(body.balances.complete).toBe(false)
    expect(body.balances.totalLamports).toBe("12482193200")
    expect(body.balances.unavailable).toEqual(entries.slice(200).map((entry) => entry.address))
    // D11: the RPC's message is on stderr in this mode too, not only on the human path.
    expect(h.stderr.text).toContain("50 addresses could not be read: ")
    expect(h.stderr.text).toContain("HTTP 429")
    expect(h.stderr.text).toContain("Narrow with a filter, or use your own endpoint with --rpc-url.")
  })
})

describe("the refusals §4.5 names, in the order they are decided", () => {
  test("a second positional, an unknown flag, and --tokens are all exit 2", async () => {
    const fx = await vaultWith(THREE_KEYS)
    const extra = harness({ dir: fx.dir })
    expect(await run(["vault", "list", "cn-s", "treasury"], extra.deps)).toBe(2)
    expect(extra.stderr.text).toContain("Unexpected argument: treasury")

    // There is no --tokens in this slice, and it is parseArgs's ordinary refusal rather than a
    // special case: 608 requests is not a flag an operator should be able to fire by habit (D8).
    const tokens = harness({ dir: fx.dir })
    expect(await run(["vault", "list", "--tokens"], tokens.deps)).toBe(2)
    expect(tokens.stderr.text).toContain("Unknown flag: --tokens")
    expect(tokens.calls).toEqual([])
  })

  test("--rpc-url without --balances says the flag costs nothing here", async () => {
    const fx = await vaultWith(THREE_KEYS)
    const h = harness({ dir: fx.dir })
    expect(await run(["vault", "list", "--rpc-url", RPC_URL], h.deps)).toBe(2)
    expect(h.stderr.text).toContain("--rpc-url has no effect without --balances; vault list is offline by default.")
    expect(h.asked).toEqual([])
  })

  test("--balances with no endpoint is rpcUrlFrom's refusal, before the prompt", async () => {
    const fx = await vaultWith(THREE_KEYS)
    const h = harness({ dir: fx.dir })
    expect(await run(["vault", "list", "--balances"], h.deps)).toBe(2)
    expect(h.stderr.text).toContain("--rpc-url <url> is required (or set CANDLE_SOLANA_RPC_URL).")
    expect(h.asked).toEqual([])
  })

  test("plain http is refused for a remote host, unchanged", async () => {
    const fx = await vaultWith(THREE_KEYS)
    const h = harness({ dir: fx.dir })
    expect(await run(["vault", "list", "--balances", "--rpc-url", "http://rpc.example.test"], h.deps)).toBe(2)
    expect(h.stderr.text).toContain("--rpc-url must be https://")
  })

  test("no vault at the resolved path is VAULT_MISSING, with the parenthetical and the details", async () => {
    const h = harness({ dir: "/nonexistent/candle-no-vault-here", env: {} })
    const code = await run(["vault", "list", "--json"], h.deps)
    expect(code).toBe(1)
    const body = JSON.parse(h.stdout.text) as { code: string; details: Record<string, string> }
    expect(body.code).toBe("VAULT_MISSING")
    expect(body.details.pathSource).toBe("env")
  })
})

describe("T13: status keeps its keys, and `status --json` is untouched", () => {
  test("status --json is untouched: the pointer is human output, and the keys are the keys", async () => {
    const fx = await vaultWith(THREE_KEYS)
    const h = harness({ dir: fx.dir })
    expect(await run(["vault", "status", "--unlock", "--json"], h.deps)).toBe(0)
    expect(h.stdout.text).not.toContain(LIST_POINTER)
    const body = JSON.parse(h.stdout.text) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual([
      "createdAt",
      "envelopes",
      "generation",
      "legacyWalletsEnc",
      "ok",
      "path",
      "recoverableFactors",
      "sidecar",
      "unlocked",
      "updatedAt",
      "version",
    ])
    expect(Object.keys(body.unlocked as object).sort()).toEqual([
      "duplicateLabels",
      "entries",
      "exposedIndexes",
      "nextIndex",
      "restored",
      "rootExported",
    ])
  })
})
