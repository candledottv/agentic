/**
 * `candle tee …` (Ember Phase 1, BE-94): T19, T20 (unit), T23, T24 (fake RPC), T26/T27 (refusals),
 * T29 (typed states and exit codes). The TEE wallet store lives in a real temp dir (the round-trip check
 * in `tee new` reads the file back); the API and the Solana RPC are routed fakes. Signed sweep
 * transactions are decoded and signature-verified with `@solana/web3.js` (hoisted oracle, same as
 * solana-lite.test.ts) so the test proves what was SIGNED, not what was logged.
 */
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile as realReadFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ed25519 } from "@noble/curves/ed25519"
import { base58 } from "@scure/base"
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID as SPL_TOKEN,
  TOKEN_2022_PROGRAM_ID as SPL_TOKEN_2022,
} from "@solana/spl-token"
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js"
import { run } from "../index"
import { DAMM_V2_PROGRAM_ID } from "../lp-close"
import { SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../solana-lite"
import {
  createCapture,
  createFakeStore,
  createRoutedFetch,
  createTestDeps,
  jsonResponse,
  type RouteHandler,
  TEST_HOME,
} from "../test-support"
import {
  createKeystore,
  defaultTeeKeystorePath,
  type KeystoreEntry,
  keystoreLockPath,
  legacyTeeKeystorePath,
  readKeystore,
  serializeKeystore,
  writeKeystoreFile,
} from "../wallet-keystore"

const PASSPHRASE = "a strong tee-store passphrase"
const RPC = "https://rpc.test/rpc"
const ENCRYPTION_PUBLIC_KEY = await (async () => {
  const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  return Buffer.from(await crypto.subtle.exportKey("raw", receiver.publicKey)).toString("base64")
})()

const teeKey = Keypair.generate()
const TEE = teeKey.publicKey.toBase58()
const VAULT = Keypair.generate().publicKey.toBase58()
const MINT = Keypair.generate().publicKey
const MINT_2022 = Keypair.generate().publicKey
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "candle-tee-"))
}

function prompts(answers: string[]) {
  const queue = [...answers]
  return async () => {
    const next = queue.shift()
    if (next === undefined) throw new Error("promptSecret asked for more answers than the test scripted")
    return next
  }
}

async function seedTeeStore(dir: string, entries: KeystoreEntry[], passphrase = PASSPHRASE): Promise<string> {
  const ks = await createKeystore(passphrase)
  const path = defaultTeeKeystorePath({ CANDLE_CONFIG_DIR: dir }, TEST_HOME)
  await writeKeystoreFile(path, await serializeKeystore(entries, ks.key, ks.salt, ks.iterations, "ember-tee"))
  return path
}

async function openStore(dir: string, passphrase = PASSPHRASE) {
  return await readKeystore(
    await realReadFile(defaultTeeKeystorePath({ CANDLE_CONFIG_DIR: dir }, TEST_HOME), "utf8"),
    passphrase,
    {
      expectPurpose: "ember-tee",
    },
  )
}

function teeEntry(overrides: Partial<KeystoreEntry> = {}): KeystoreEntry {
  return {
    index: 0,
    chain: "solana",
    address: TEE,
    label: "tee-0",
    createdAt: "2026-09-16T00:00:00.000Z",
    privateKey: base58.encode(teeKey.secretKey),
    imported: false,
    tee: { network: "solana-mainnet" },
    ...overrides,
  }
}

function enabledEntry(overrides: Partial<KeystoreEntry> = {}): KeystoreEntry {
  return teeEntry({
    imported: true,
    linkedWalletId: "lw_tee1",
    privyWalletId: "pw_tee1",
    importedAt: "2026-09-16T01:00:00.000Z",
    tee: {
      network: "solana-mainnet",
      vaultDestination: VAULT,
      boundKeyPrefix: "ck_live_x",
      remoteAuthority: "verified-active",
      enabledAt: "2026-09-16T01:00:00.000Z",
    },
    ...overrides,
  })
}

function depsFor(dir: string, fetch: typeof globalThis.fetch, answers: string[], extra: Record<string, unknown> = {}) {
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    fetch,
    store: createFakeStore({ api_key: "ck_live_x" }),
    stdout,
    stderr,
    env: { CANDLE_CONFIG_DIR: dir },
    readFile: async (p: string) => realReadFile(p, "utf8"),
    promptSecret: prompts(answers),
    ...extra,
  })
  return { deps, stdout, stderr }
}

interface RpcState {
  tokenAccounts: Array<{ pubkey: string; mint: string; amount: string; decimals: number; state: string }>
  token2022Accounts: Array<{ pubkey: string; mint: string; amount: string; decimals: number; state: string }>
  lamports: number
  fee: number | null
  /**
   * Raw accounts for `getAccountInfo`: mint accounts (whose owner decides the program and whose
   * TLV carries the extensions), destination ATAs, and a transfer hook's validation account. An
   * address absent from here does not exist, which is what makes the sweep create the vault's ATA.
   */
  accounts: Record<string, { owner: string; data: Uint8Array; lamports?: number }>
  epoch: number
  sent: string[]
  /** Scripted answers, consumed in order; an explicit `null` means "not found". Empty = finalized. */
  statuses: Array<{ confirmationStatus: string | null; err: unknown } | null>
  blockhashValid: boolean
  /**
   * BE-315 (P3-ED-6): what `simulateTransaction` answers for the accounts it is asked about, over
   * `accounts`; an explicit `null` is an account the simulated transaction closed. `simulationErr`
   * makes the simulation fail. `onClose` is the fake chain's state transition for a sent DAMM v2
   * close (the NFT account gone, the withdrawn tokens in the wallet).
   */
  simulated?: Record<string, { owner: string; data: Uint8Array; lamports?: number } | null>
  simulationErr?: unknown
  onClose?: () => void
}

function rawView(account: { owner: string; data: Uint8Array; lamports?: number } | null | undefined) {
  if (!account) return null
  return {
    owner: account.owner,
    lamports: account.lamports ?? 1,
    data: [Buffer.from(account.data).toString("base64"), "base64"],
  }
}

function rpcHandler(state: RpcState): RouteHandler {
  return (req) => {
    const body = JSON.parse(String(req.init.body)) as { id: number; method: string; params: unknown[] }
    const reply = (result: unknown) => jsonResponse(200, { jsonrpc: "2.0", id: body.id, result })
    switch (body.method) {
      case "getLatestBlockhash":
        return reply({ value: { blockhash: BLOCKHASH } })
      case "getBalance":
        return reply({ value: state.lamports })
      case "getFeeForMessage":
        return reply({ value: state.fee })
      case "getAccountInfo": {
        const account = state.accounts[body.params[0] as string]
        if (!account) return reply({ value: null })
        return reply({
          value: {
            owner: account.owner,
            lamports: 1,
            data: [Buffer.from(account.data).toString("base64"), "base64"],
          },
        })
      }
      case "getEpochInfo":
        return reply({ epoch: state.epoch })
      case "getMultipleAccounts":
        return reply({ value: (body.params[0] as string[]).map((address) => rawView(state.accounts[address])) })
      case "simulateTransaction": {
        const addresses = (body.params[1] as { accounts: { addresses: string[] } }).accounts.addresses
        return reply({
          value: {
            err: state.simulationErr ?? null,
            logs: [],
            accounts: addresses.map((address) =>
              state.simulated && address in state.simulated
                ? rawView(state.simulated[address])
                : rawView(state.accounts[address]),
            ),
          },
        })
      }
      case "getTokenAccountsByOwner": {
        const programId = (body.params[1] as { programId: string }).programId
        const list =
          programId === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" ? state.tokenAccounts : state.token2022Accounts
        return reply({
          value: list.map((t) => ({
            pubkey: t.pubkey,
            account: {
              data: {
                parsed: {
                  info: { mint: t.mint, state: t.state, tokenAmount: { amount: t.amount, decimals: t.decimals } },
                },
              },
            },
          })),
        })
      }
      case "sendTransaction": {
        const wire = body.params[0] as string
        state.sent.push(wire)
        applySent(state, wire)
        return reply(sigOf(wire))
      }
      case "getSignatureStatuses":
        return reply({
          value: [state.statuses.length > 0 ? state.statuses.shift() : { confirmationStatus: "finalized", err: null }],
        })
      case "isBlockhashValid":
        return reply({ value: state.blockhashValid })
      default:
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: `unknown ${body.method}` },
        })
    }
  }
}

/**
 * The fake chain's state transition for a sent transaction, so the post-finality inventory the
 * sweep reads afterwards sees what a real chain would: the fee leaves the payer on every
 * transaction, a System transfer debits its lamports, a Token `TransferChecked` empties the source
 * account and `CloseAccount` removes it.
 */
/** Legacy or v0 (BE-315: a signed position close is v0), as one list of resolved instructions. */
function instructionsOf(wire: string): Array<{ programId: PublicKey; keys: PublicKey[]; data: Buffer }> {
  const bytes = Buffer.from(wire, "base64")
  const versioned = VersionedTransaction.deserialize(bytes)
  if (versioned.version === "legacy") {
    return Transaction.from(bytes).instructions.map((ix) => ({
      programId: ix.programId,
      keys: ix.keys.map((key) => key.pubkey),
      data: ix.data,
    }))
  }
  const keys = versioned.message.getAccountKeys()
  return versioned.message.compiledInstructions.map((ix) => ({
    programId: keys.get(ix.programIdIndex) as PublicKey,
    keys: ix.accountKeyIndexes.map((index) => keys.get(index) as PublicKey),
    data: Buffer.from(ix.data),
  }))
}

function applySent(state: RpcState, wire: string): void {
  const tx = { instructions: instructionsOf(wire) }
  if (state.fee !== null) state.lamports = Math.max(0, state.lamports - state.fee)
  for (const ix of tx.instructions) {
    const program = ix.programId.toBase58()
    if (program === DAMM_V2_PROGRAM_ID) {
      state.onClose?.()
      continue
    }
    if (program === "11111111111111111111111111111111" && ix.data.readUInt32LE(0) === 2) {
      const amount = Number(Buffer.from(ix.data.subarray(4, 12)).readBigUInt64LE())
      state.lamports = Math.max(0, state.lamports - amount)
    } else if (program === TOKEN_PROGRAM_ID || program === TOKEN_2022_PROGRAM_ID) {
      const list = program === TOKEN_PROGRAM_ID ? "tokenAccounts" : "token2022Accounts"
      const account = ix.keys[0]?.toBase58()
      if (ix.data[0] === 12) {
        for (const t of state[list]) if (t.pubkey === account) t.amount = "0"
      } else if (ix.data[0] === 9) {
        state[list] = state[list].filter((t) => t.pubkey !== account)
      }
    }
  }
}

/** The transaction's identity: the first signature of the signed wire, as a node echoes it. */
function sigOf(wire: string): string {
  return base58.encode(VersionedTransaction.deserialize(Buffer.from(wire, "base64")).signatures[0] ?? new Uint8Array())
}

// ── Mint fixtures (BE-218, R5). Same byte layout `token-2022.test.ts` pins against spl-token. ──

function baseMint(decimals: number): Uint8Array {
  const data = new Uint8Array(82)
  data[44] = decimals
  data[45] = 1
  return data
}

function extendedMint(decimals: number, extensions: Array<{ type: number; body: Uint8Array }>): Uint8Array {
  const parts = extensions.flatMap(({ type, body }) => {
    const header = new Uint8Array(4)
    const view = new DataView(header.buffer)
    view.setUint16(0, type, true)
    view.setUint16(2, body.length, true)
    return [header, body]
  })
  const data = new Uint8Array(166 + parts.reduce((n, p) => n + p.length, 0))
  data.set(baseMint(decimals), 0)
  data[165] = 1
  let at = 166
  for (const part of parts) {
    data.set(part, at)
    at += part.length
  }
  return data
}

function transferFeeBody(bps: number, max: bigint): Uint8Array {
  const body = new Uint8Array(108)
  const view = new DataView(body.buffer)
  view.setBigUint64(80, max, true)
  view.setUint16(88, bps, true)
  view.setBigUint64(98, max, true)
  view.setUint16(106, bps, true)
  return body
}

function transferHookBody(program: PublicKey): Uint8Array {
  const body = new Uint8Array(64)
  body.set(program.toBytes(), 32)
  return body
}

/** A raw SPL token account, for the frozen-state byte the sweep reads at offset 108. */
function tokenAccountBytes(frozen: boolean): Uint8Array {
  const data = new Uint8Array(165)
  data[108] = frozen ? 2 : 1
  return data
}

function mint2022(data: Uint8Array) {
  return { [MINT_2022.toBase58()]: { owner: TOKEN_2022_PROGRAM_ID, data } }
}

function defaultRpcState(overrides: Partial<RpcState> = {}): RpcState {
  return {
    tokenAccounts: [],
    token2022Accounts: [],
    lamports: 1_000_000,
    fee: 5_000,
    accounts: {},
    epoch: 100,
    sent: [],
    statuses: [],
    blockhashValid: true,
    ...overrides,
  }
}

const LIFECYCLE = (state: string, extra: Record<string, unknown> = {}) => ({
  success: true,
  id: "lw_tee1",
  state,
  remoteAuthority: state === "quarantined" ? "verified-denied" : state === "enabled" ? "verified-active" : "unknown",
  evidenceObservedAt: 1_726_000_000_000,
  profile: "ember-tee",
  boundKeyPrefix: "ck_live_x",
  vaultDestination: VAULT,
  ...extra,
})

describe("T27: every tee command refuses while CANDLE_KEYSTORE_PASSPHRASE is set", () => {
  test("new/enable/fund/status/disable/sweep all exit 1 without touching the store, the network, or the value", async () => {
    const dir = await tempDir()
    const { fetch, calls } = createRoutedFetch({})
    for (const argv of [
      ["tee", "new"],
      ["tee", "enable", TEE, "--vault", VAULT],
      ["tee", "fund", TEE, "--amount", "1"],
      ["tee", "status", TEE],
      ["tee", "disable", TEE],
      ["tee", "sweep", TEE, "--rpc-url", RPC],
    ]) {
      const { deps, stderr } = depsFor(dir, fetch, [], {
        env: { CANDLE_CONFIG_DIR: dir, CANDLE_KEYSTORE_PASSPHRASE: "should-never-be-read" },
      })
      expect(await run(argv, deps)).toBe(1)
      expect(stderr.text).toContain("CANDLE_KEYSTORE_PASSPHRASE is set")
      expect(stderr.text).not.toContain("should-never-be-read")
    }
    expect(calls).toHaveLength(0)
  })
})

describe("tee new (T19, HW-01)", () => {
  test("creates tee-wallets.enc with the purpose marker, verifies the round trip, prints the address, no network", async () => {
    const dir = await tempDir()
    const { fetch, calls } = createRoutedFetch({})
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, PASSPHRASE])
    const code = await run(["tee", "new", "--label", "scalper"], deps)
    expect(code).toBe(0)
    expect(calls).toHaveLength(0)
    const path = defaultTeeKeystorePath({ CANDLE_CONFIG_DIR: dir }, TEST_HOME)
    const raw = await realReadFile(path, "utf8")
    expect(JSON.parse(raw).purpose).toBe("ember-tee")
    const opened = await readKeystore(raw, PASSPHRASE, { expectPurpose: "ember-tee" })
    expect(opened.entries).toHaveLength(1)
    const entry = opened.entries[0] as KeystoreEntry
    expect(entry.label).toBe("scalper")
    expect(entry.imported).toBe(false)
    expect(entry.tee?.network).toBe("solana-mainnet")
    expect(stdout.text).toContain(entry.address)
    expect(stdout.text).toContain("verified to restore")
    expect(stdout.text).toContain("local-only")
    // The secret never reaches stdout.
    expect(stdout.text).not.toContain(entry.privateKey)
  })

  test("a short passphrase or a mismatched confirmation creates nothing", async () => {
    const dir = await tempDir()
    const { fetch } = createRoutedFetch({})
    const short = depsFor(dir, fetch, ["tooshort"])
    expect(await run(["tee", "new"], short.deps)).toBe(1)
    expect(short.stderr.text).toContain("at least 12")
    const mismatch = depsFor(dir, fetch, [PASSPHRASE, "something else entirely"])
    expect(await run(["tee", "new"], mismatch.deps)).toBe(1)
    await expect(realReadFile(defaultTeeKeystorePath({ CANDLE_CONFIG_DIR: dir }, TEST_HOME), "utf8")).rejects.toThrow()
  })

  test("a second `tee new` appends to the existing store under the same passphrase", async () => {
    const dir = await tempDir()
    const { fetch } = createRoutedFetch({})
    expect(await run(["tee", "new"], depsFor(dir, fetch, [PASSPHRASE, PASSPHRASE]).deps)).toBe(0)
    const second = depsFor(dir, fetch, [PASSPHRASE])
    expect(await run(["tee", "new", "--json"], second.deps)).toBe(0)
    const parsed = JSON.parse(second.stdout.text.trim())
    expect(parsed.index).toBe(1)
    expect(parsed.state).toBe("local-only")
  })
})

describe("the store written before the tee rename (hot-wallets.enc)", () => {
  /** The old file name, header marker and entry field, exactly as a source-built CLI wrote them. */
  async function seedLegacyStore(dir: string, entry: KeystoreEntry): Promise<string> {
    const { tee: meta, ...plain } = entry
    const ks = await createKeystore(PASSPHRASE)
    const sealed = await serializeKeystore(
      [{ ...plain, hot: meta } as unknown as KeystoreEntry],
      ks.key,
      ks.salt,
      ks.iterations,
      "ember-tee",
    )
    const file = JSON.parse(sealed)
    file.purpose = "ember-hot"
    const path = legacyTeeKeystorePath({ CANDLE_CONFIG_DIR: dir }, TEST_HOME)
    await writeKeystoreFile(path, JSON.stringify(file))
    return path
  }

  test("with no tee-wallets.enc, a tee command finds it without --keystore", async () => {
    const dir = await tempDir()
    await seedLegacyStore(dir, teeEntry())
    const { fetch, calls } = createRoutedFetch({})
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE])
    expect(await run(["tee", "status", TEE, "--json"], deps)).toBe(0)
    expect(JSON.parse(stdout.text.trim()).localState).toBe("local-only")
    expect(calls).toHaveLength(0)
  })

  test("the first write keeps the old key and rewrites the file under the current marker", async () => {
    const dir = await tempDir()
    const path = await seedLegacyStore(dir, teeEntry())
    const { fetch } = createRoutedFetch({})
    const { deps } = depsFor(dir, fetch, [PASSPHRASE])
    expect(await run(["tee", "new", "--json"], deps)).toBe(0)
    const raw = await realReadFile(path, "utf8")
    expect(JSON.parse(raw).purpose).toBe("ember-tee")
    const opened = await readKeystore(raw, PASSPHRASE, { expectPurpose: "ember-tee" })
    expect(opened.entries.map((e) => e.address)[0]).toBe(TEE)
    expect(opened.entries).toHaveLength(2)
    expect(opened.entries[0]?.tee?.network).toBe("solana-mainnet")
    expect(raw).not.toContain("ember-hot")
  })

  test("when both files exist the current store wins", async () => {
    const dir = await tempDir()
    const other = Keypair.generate()
    const otherAddress = other.publicKey.toBase58()
    await seedLegacyStore(dir, teeEntry({ address: otherAddress, privateKey: base58.encode(other.secretKey) }))
    await seedTeeStore(dir, [teeEntry()])
    const { fetch } = createRoutedFetch({})
    expect(await run(["tee", "status", TEE, "--json"], depsFor(dir, fetch, [PASSPHRASE]).deps)).toBe(0)
    const legacyOnly = depsFor(dir, fetch, [PASSPHRASE])
    expect(await run(["tee", "status", otherAddress, "--json"], legacyOnly.deps)).toBe(1)
    expect(JSON.parse(legacyOnly.stdout.text.trim()).code).toBe("TEE_WALLET_UNKNOWN")
  })

  test("with neither file, the missing-store error names the current path", async () => {
    const dir = await tempDir()
    const { fetch } = createRoutedFetch({})
    const { deps, stdout } = depsFor(dir, fetch, [])
    expect(await run(["tee", "status", TEE, "--json"], deps)).toBe(1)
    const parsed = JSON.parse(stdout.text.trim())
    expect(parsed.code).toBe("TEE_STORE_MISSING")
    expect(parsed.message).toContain("tee-wallets.enc")
  })
})

describe("tee enable (T19/T20, HW-02/HW-03)", () => {
  function apiRoutes(submitExtra: Record<string, unknown> = {}) {
    const submits: Record<string, unknown>[] = []
    const routes = createRoutedFetch({
      "/api/v1/agent/wallets/import/init": () =>
        jsonResponse(200, { success: true, encryptionPublicKey: ENCRYPTION_PUBLIC_KEY }),
      "/api/v1/agent/wallets/import/submit": (req) => {
        const body = JSON.parse(String(req.init.body)) as Record<string, unknown>
        submits.push(body)
        return jsonResponse(200, {
          success: true,
          id: "lw_tee1",
          address: body.address,
          chain: "solana",
          privyWalletId: "pw_tee1",
          profile: "ember-tee",
          vaultDestination: body.vaultDestination,
          boundKeyPrefix: "ck_live_x",
          remoteAuthority: "verified-active",
          evidenceObservedAt: 1_726_000_000_000,
          state: "enabled",
          ...submitExtra,
        })
      },
    })
    return { ...routes, submits }
  }

  test("happy path: confirmation typed, import carries profile + vault, entry records the grant, exit 0", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [teeEntry()])
    const api = apiRoutes()
    const { deps, stdout } = depsFor(dir, api.fetch, [PASSPHRASE, VAULT.slice(-6)])
    const code = await run(["tee", "enable", TEE, "--vault", VAULT], deps)
    expect(code).toBe(0)
    expect(api.submits).toHaveLength(1)
    expect(api.submits[0]).toMatchObject({
      chain: "solana",
      address: TEE,
      profile: "ember-tee",
      vaultDestination: VAULT,
    })
    // The private key never goes over the wire in the clear.
    expect(JSON.stringify(api.submits[0])).not.toContain(base58.encode(teeKey.secretKey))
    expect(stdout.text).toContain("Remote authority verified")
    const opened = await readKeystore(
      await realReadFile(defaultTeeKeystorePath({ CANDLE_CONFIG_DIR: dir }, TEST_HOME), "utf8"),
      PASSPHRASE,
      {
        expectPurpose: "ember-tee",
      },
    )
    expect(opened.entries[0]).toMatchObject({
      imported: true,
      linkedWalletId: "lw_tee1",
      tee: { vaultDestination: VAULT, boundKeyPrefix: "ck_live_x", remoteAuthority: "verified-active" },
    })
  })

  test("HW-03: a wrong confirmation refuses before any import call", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [teeEntry()])
    const api = apiRoutes()
    const { deps, stderr } = depsFor(dir, api.fetch, [PASSPHRASE, "nope00"])
    expect(await run(["tee", "enable", TEE, "--vault", VAULT], deps)).toBe(1)
    expect(stderr.text).toContain("confirmation did not match")
    expect(api.calls).toHaveLength(0)
  })

  test("T20: the vault must be a valid Solana address and not the TEE wallet address; usage errors, no prompt, no network", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [teeEntry()])
    const api = apiRoutes()
    expect(await run(["tee", "enable", TEE, "--vault", "not-an-address"], depsFor(dir, api.fetch, []).deps)).toBe(2)
    expect(await run(["tee", "enable", TEE, "--vault", TEE], depsFor(dir, api.fetch, []).deps)).toBe(2)
    expect(await run(["tee", "enable", TEE], depsFor(dir, api.fetch, []).deps)).toBe(2)
    expect(api.calls).toHaveLength(0)
  })

  test("an unverified enable read-back exits 3, tells the operator not to fund, and records unknown", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [teeEntry()])
    const api = apiRoutes({ remoteAuthority: "unknown", reasonCode: "READ_BACK_UNAVAILABLE" })
    const { deps, stdout } = depsFor(dir, api.fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "enable", TEE, "--vault", VAULT], deps)).toBe(3)
    expect(stdout.text).toContain("Do not fund it")
    expect(stdout.text).toContain("READ_BACK_UNAVAILABLE")
  })

  test("an already-enabled or retired TEE wallet is never re-enabled", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const api = apiRoutes()
    const { deps, stderr } = depsFor(dir, api.fetch, [PASSPHRASE])
    expect(await run(["tee", "enable", TEE, "--vault", VAULT], deps)).toBe(1)
    expect(stderr.text).toContain("never re-enabled")
    expect(api.calls).toHaveLength(0)
  })
})

describe("tee fund (HW-04)", () => {
  test("prints the raw amount and destination for the vault to sign; signs nothing, calls nothing", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const { fetch, calls } = createRoutedFetch({})
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE])
    expect(await run(["tee", "fund", TEE, "--amount", "1.5", "--asset", "USDC", "--json"], deps)).toBe(0)
    const parsed = JSON.parse(stdout.text.trim())
    expect(parsed).toMatchObject({
      asset: "USDC",
      amountRaw: "1500000",
      destination: TEE,
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    })
    expect(calls).toHaveLength(0)
  })

  test("SOL amounts use 9 decimals; too many decimals or zero is a usage error", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const { fetch } = createRoutedFetch({})
    const ok = depsFor(dir, fetch, [PASSPHRASE])
    expect(await run(["tee", "fund", TEE, "--amount", "0.25", "--json"], ok.deps)).toBe(0)
    expect(JSON.parse(ok.stdout.text.trim()).amountRaw).toBe("250000000")
    expect(await run(["tee", "fund", TEE, "--amount", "0.0000000001"], depsFor(dir, fetch, []).deps)).toBe(2)
    expect(await run(["tee", "fund", TEE, "--amount", "0"], depsFor(dir, fetch, []).deps)).toBe(2)
  })

  test("refuses to produce a funding instruction for a wallet whose authority is not verified, or that is stopped", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [
      enabledEntry({ tee: { network: "solana-mainnet", vaultDestination: VAULT, remoteAuthority: "unknown" } }),
    ])
    const { fetch } = createRoutedFetch({})
    const a = depsFor(dir, fetch, [PASSPHRASE])
    expect(await run(["tee", "fund", TEE, "--amount", "1"], a.deps)).toBe(1)
    expect(a.stderr.text).toContain("do not fund")
    const dir2 = await tempDir()
    await seedTeeStore(dir2, [
      enabledEntry({
        tee: {
          network: "solana-mainnet",
          vaultDestination: VAULT,
          remoteAuthority: "verified-active",
          stopRequestedAt: "2026-09-16T02:00:00.000Z",
        },
      }),
    ])
    const b = depsFor(dir2, fetch, [PASSPHRASE])
    expect(await run(["tee", "fund", TEE, "--amount", "1"], b.deps)).toBe(1)
    expect(b.stderr.text).toContain("never refunded")
  })
})

describe("tee status (T21 partial, T29)", () => {
  test("reports the server's derived state and on-chain balances with USD unknown, never zero", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const rpc = defaultRpcState({
      tokenAccounts: [{ pubkey: "acct1", mint: MINT.toBase58(), amount: "700000", decimals: 6, state: "initialized" }],
      token2022Accounts: [
        { pubkey: "acct2", mint: MINT_2022.toBase58(), amount: "5", decimals: 0, state: "initialized" },
      ],
    })
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("enabled")),
      "/rpc": rpcHandler(rpc),
    })
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE])
    expect(await run(["tee", "status", TEE, "--rpc-url", RPC, "--json"], deps)).toBe(0)
    const parsed = JSON.parse(stdout.text.trim())
    expect(parsed.server.state).toBe("enabled")
    expect(parsed.balances.lamports).toBe("1000000")
    expect(parsed.balances.tokens).toHaveLength(2)
    expect(parsed.balances.tokens[0].usdValue).toBe("unknown")
    expect(parsed.balances.tokens[1].program).toBe("token-2022")
    expect(typeof parsed.observedAt).toBe("string")
  })

  test("a local-only wallet reports without any network call", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [teeEntry()])
    const { fetch, calls } = createRoutedFetch({})
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE])
    expect(await run(["tee", "status", TEE, "--json"], deps)).toBe(0)
    expect(JSON.parse(stdout.text.trim()).localState).toBe("local-only")
    expect(calls).toHaveLength(0)
  })
})

describe("tee disable (T23, HW-06)", () => {
  const PENDING = {
    success: true,
    state: "disable-pending",
    stopAcknowledged: true,
    remoteAuthority: "unknown",
    evidenceObservedAt: null,
    complete: false,
    retryable: true,
    reasonCode: "READ_BACK_UNAVAILABLE",
    policyNeutralized: false,
  }
  const QUARANTINED = {
    ...PENDING,
    state: "quarantined",
    remoteAuthority: "verified-denied",
    complete: true,
    retryable: false,
    policyNeutralized: true,
    reasonCode: undefined,
  }

  test("202 disable-pending -> exit 3, pending message, stopRequestedAt persisted", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const { fetch, calls } = createRoutedFetch({ "/api/v1/agent/wallets/lw_tee1": () => jsonResponse(202, PENDING) })
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE])
    expect(await run(["tee", "disable", TEE], deps)).toBe(3)
    expect(calls[0]?.init.method).toBe("DELETE")
    expect(stdout.text).toContain("verification is pending")
    expect(stdout.text).toContain("--emergency")
    const opened = await readKeystore(
      await realReadFile(defaultTeeKeystorePath({ CANDLE_CONFIG_DIR: dir }, TEST_HOME), "utf8"),
      PASSPHRASE,
      {
        expectPurpose: "ember-tee",
      },
    )
    expect(typeof opened.entries[0]?.tee?.stopRequestedAt).toBe("string")
  })

  test("200 quarantined -> exit 0 and the sweep hint", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const { fetch } = createRoutedFetch({ "/api/v1/agent/wallets/lw_tee1": () => jsonResponse(200, QUARANTINED) })
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE])
    expect(await run(["tee", "disable", TEE], deps)).toBe(0)
    expect(stdout.text).toContain("quarantined")
    expect(stdout.text).toContain("tee sweep")
  })

  test("a never-enabled wallet has nothing to stop", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [teeEntry()])
    const { fetch, calls } = createRoutedFetch({})
    const { deps } = depsFor(dir, fetch, [PASSPHRASE])
    expect(await run(["tee", "disable", TEE], deps)).toBe(1)
    expect(calls).toHaveLength(0)
  })
})

describe("tee sweep (T24, HW-07, SC-06)", () => {
  function decodeSent(b64: string) {
    const tx = Transaction.from(Buffer.from(b64, "base64"))
    expect(tx.verifySignatures()).toBe(true)
    expect(tx.signatures[0]?.publicKey.toBase58()).toBe(TEE)
    return tx
  }

  test("quarantined: tokens first (create vault ATA, transferChecked, close), SOL last minus fee, receipts recorded, exit 0", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const source = getAssociatedTokenAddressSync(MINT, teeKey.publicKey)
    const rpc = defaultRpcState({
      tokenAccounts: [
        { pubkey: source.toBase58(), mint: MINT.toBase58(), amount: "700000", decimals: 6, state: "initialized" },
      ],
      lamports: 1_000_000,
      fee: 5_000,
    })
    const swept: unknown[] = []
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
      "/api/v1/agent/wallets/lw_tee1/swept": (req) => {
        swept.push(JSON.parse(String(req.init.body)))
        return jsonResponse(200, {
          success: true,
          id: "lw_tee1",
          state: "swept",
          sweptAt: 1,
          signatures: rpc.sent.map(sigOf),
        })
      },
      "/rpc": rpcHandler(rpc),
    })
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    const code = await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], deps)
    expect(code).toBe(0)
    expect(rpc.sent).toHaveLength(2)

    const tokenTx = decodeSent(rpc.sent[0] as string)
    expect(tokenTx.instructions).toHaveLength(3)
    const vaultAta = getAssociatedTokenAddressSync(MINT, new PublicKey(VAULT))
    // create ATA for the VAULT, paid by the TEE wallet
    expect(tokenTx.instructions[0]?.programId.toBase58()).toBe("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
    expect(tokenTx.instructions[0]?.keys[1]?.pubkey.toBase58()).toBe(vaultAta.toBase58())
    expect(tokenTx.instructions[0]?.keys[2]?.pubkey.toBase58()).toBe(VAULT)
    // transferChecked of the FULL balance to the vault's ATA
    const transfer = tokenTx.instructions[1]
    expect(transfer?.programId.toBase58()).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
    expect(transfer?.keys[2]?.pubkey.toBase58()).toBe(vaultAta.toBase58())
    expect(transfer?.data[0]).toBe(12)
    expect(Buffer.from(transfer?.data.subarray(1, 9) ?? []).readBigUInt64LE()).toBe(700_000n)
    // close the source account, rent back to the TEE wallet
    expect(tokenTx.instructions[2]?.data[0]).toBe(9)
    expect(tokenTx.instructions[2]?.keys[1]?.pubkey.toBase58()).toBe(TEE)

    const solTx = decodeSent(rpc.sent[1] as string)
    expect(solTx.instructions).toHaveLength(1)
    expect(solTx.instructions[0]?.programId.toBase58()).toBe("11111111111111111111111111111111")
    expect(solTx.instructions[0]?.keys[1]?.pubkey.toBase58()).toBe(VAULT)
    // 1_000_000 minus the token transaction's 5_000 fee, minus this transfer's own 5_000 fee.
    expect(Buffer.from(solTx.instructions[0]?.data.subarray(4, 12) ?? []).readBigUInt64LE()).toBe(990_000n)

    const parsed = JSON.parse(stdout.text.trim())
    expect(parsed.state).toBe("swept")
    expect(parsed.serverState).toBe("quarantined")
    expect(parsed.receipts.map((r: { kind: string }) => r.kind)).toEqual(["token", "sol"])
    expect(parsed.residuals).toEqual([])
    // SC-06: completion was decided from the post-finality inventory, which read an empty wallet.
    expect(parsed.inventory).toMatchObject({ verified: true, lamports: "0", tokenAccounts: 0 })
    expect(rpc.lamports).toBe(0)
    expect(swept).toEqual([{ signatures: rpc.sent.map(sigOf), residuals: [] }])
    expect(parsed.receipts.map((r: { signature: string }) => r.signature)).toEqual(rpc.sent.map(sigOf))
    const opened = await readKeystore(
      await realReadFile(defaultTeeKeystorePath({ CANDLE_CONFIG_DIR: dir }, TEST_HOME), "utf8"),
      PASSPHRASE,
      {
        expectPurpose: "ember-tee",
      },
    )
    expect(typeof opened.entries[0]?.tee?.sweptAt).toBe("string")
  })

  // ── Token-2022 (BE-218, R5, Phase 2 ED-10 amendment). Phase 1 listed these as residuals. ──

  test("a Token-2022 balance is SWEPT: TransferChecked then CloseAccount, both under Token-2022", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const source = getAssociatedTokenAddressSync(MINT_2022, teeKey.publicKey, false, SPL_TOKEN_2022)
    const vaultAta = getAssociatedTokenAddressSync(MINT_2022, new PublicKey(VAULT), false, SPL_TOKEN_2022)
    const rpc = defaultRpcState({
      token2022Accounts: [
        { pubkey: source.toBase58(), mint: MINT_2022.toBase58(), amount: "5", decimals: 0, state: "initialized" },
      ],
      accounts: mint2022(baseMint(0)),
    })
    const swept: unknown[] = []
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
      "/api/v1/agent/wallets/lw_tee1/swept": (req) => {
        swept.push(JSON.parse(String(req.init.body)))
        return jsonResponse(200, { success: true, id: "lw_tee1", state: "swept", sweptAt: 1 })
      },
      "/rpc": rpcHandler(rpc),
    })
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], deps)).toBe(0)
    const tx = decodeSent(rpc.sent[0] as string)
    expect(tx.instructions).toHaveLength(3)
    // The vault's ATA is derived under Token-2022, and the create names Token-2022 as its program.
    expect(tx.instructions[0]?.keys[1]?.pubkey.toBase58()).toBe(vaultAta.toBase58())
    expect(tx.instructions[0]?.keys[5]?.pubkey.toBase58()).toBe(TOKEN_2022_PROGRAM_ID)
    expect(vaultAta.toBase58()).not.toBe(getAssociatedTokenAddressSync(MINT_2022, new PublicKey(VAULT)).toBase58())
    // Transfer and close BOTH run under Token-2022, in one transaction.
    expect(tx.instructions[1]?.programId.toBase58()).toBe(TOKEN_2022_PROGRAM_ID)
    expect(tx.instructions[1]?.data[0]).toBe(12)
    expect(tx.instructions[2]?.programId.toBase58()).toBe(TOKEN_2022_PROGRAM_ID)
    expect(tx.instructions[2]?.data[0]).toBe(9)
    expect(tx.instructions[2]?.keys[0]?.pubkey.toBase58()).toBe(source.toBase58())
    expect(tx.instructions[2]?.keys[1]?.pubkey.toBase58()).toBe(TEE)

    const parsed = JSON.parse(stdout.text.trim())
    expect(parsed.state).toBe("swept")
    expect(parsed.residuals).toEqual([])
    expect(parsed.receipts.map((r: { kind: string }) => r.kind)).toEqual(["token", "sol"])
    expect(swept).toHaveLength(1)
  })

  test("both programs in one sweep: a classic account and a Token-2022 account each under their own", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const classicSource = getAssociatedTokenAddressSync(MINT, teeKey.publicKey)
    const source2022 = getAssociatedTokenAddressSync(MINT_2022, teeKey.publicKey, false, SPL_TOKEN_2022)
    const rpc = defaultRpcState({
      tokenAccounts: [
        {
          pubkey: classicSource.toBase58(),
          mint: MINT.toBase58(),
          amount: "700000",
          decimals: 6,
          state: "initialized",
        },
      ],
      token2022Accounts: [
        { pubkey: source2022.toBase58(), mint: MINT_2022.toBase58(), amount: "5", decimals: 0, state: "initialized" },
      ],
      accounts: mint2022(baseMint(0)),
    })
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
      "/api/v1/agent/wallets/lw_tee1/swept": () => jsonResponse(200, { success: true, state: "swept", sweptAt: 1 }),
      "/rpc": rpcHandler(rpc),
    })
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], deps)).toBe(0)
    expect(rpc.sent).toHaveLength(3)
    // Classic first (the order the inventory reads the two programs), then Token-2022, then SOL.
    expect(decodeSent(rpc.sent[0] as string).instructions[1]?.programId.toBase58()).toBe(TOKEN_PROGRAM_ID)
    expect(decodeSent(rpc.sent[1] as string).instructions[1]?.programId.toBase58()).toBe(TOKEN_2022_PROGRAM_ID)
    const parsed = JSON.parse(stdout.text.trim())
    expect(parsed.state).toBe("swept")
    expect(parsed.residuals).toEqual([])
  })

  test("a transfer-fee mint: the post-fee amount is shown, and the full raw balance still moves", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const source = getAssociatedTokenAddressSync(MINT_2022, teeKey.publicKey, false, SPL_TOKEN_2022)
    const rpc = defaultRpcState({
      token2022Accounts: [
        {
          pubkey: source.toBase58(),
          mint: MINT_2022.toBase58(),
          amount: "100000000",
          decimals: 6,
          state: "initialized",
        },
      ],
      accounts: mint2022(extendedMint(6, [{ type: 1, body: transferFeeBody(150, 1_000_000n) }])),
      epoch: 42,
    })
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
      "/api/v1/agent/wallets/lw_tee1/swept": () => jsonResponse(200, { success: true, state: "swept", sweptAt: 1 }),
      "/rpc": rpcHandler(rpc),
    })
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC], deps)).toBe(0)
    // The instruction carries the full raw amount; the mint withholds its own cut on the way.
    const transfer = decodeSent(rpc.sent[0] as string).instructions[1]
    expect(Buffer.from(transfer?.data.subarray(1, 9) ?? []).readBigUInt64LE()).toBe(100_000_000n)
    expect(stdout.text).toContain("99000000 raw will arrive; 1000000 raw is withheld by the mint at epoch 42")
    expect(stdout.text).toContain("Transfer fee: 1.5% capped at 1000000 raw units")
  })

  test("a transfer hook's extra accounts are resolved and appended before the TEE key signs", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const source = getAssociatedTokenAddressSync(MINT_2022, teeKey.publicKey, false, SPL_TOKEN_2022)
    const hookProgram = Keypair.generate().publicKey
    const literal = Keypair.generate().publicKey
    const validateState = PublicKey.findProgramAddressSync(
      [Buffer.from("extra-account-metas"), MINT_2022.toBuffer()],
      hookProgram,
    )[0]
    const validation = new Uint8Array(16 + 35)
    validation.set([105, 37, 101, 197, 75, 251, 102, 26], 0)
    const view = new DataView(validation.buffer)
    view.setUint32(8, 39, true)
    view.setUint32(12, 1, true)
    validation.set(literal.toBytes(), 17)
    validation[50] = 1
    const rpc = defaultRpcState({
      token2022Accounts: [
        { pubkey: source.toBase58(), mint: MINT_2022.toBase58(), amount: "5", decimals: 0, state: "initialized" },
      ],
      accounts: {
        ...mint2022(extendedMint(0, [{ type: 14, body: transferHookBody(hookProgram) }])),
        [validateState.toBase58()]: { owner: hookProgram.toBase58(), data: validation },
      },
    })
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
      "/api/v1/agent/wallets/lw_tee1/swept": () => jsonResponse(200, { success: true, state: "swept", sweptAt: 1 }),
      "/rpc": rpcHandler(rpc),
    })
    const { deps } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], deps)).toBe(0)
    const transfer = decodeSent(rpc.sent[0] as string).instructions[1]
    expect(transfer?.keys.slice(4).map((k) => k.pubkey.toBase58())).toEqual([
      literal.toBase58(),
      hookProgram.toBase58(),
      validateState.toBase58(),
    ])
  })

  test("R5's four names: a failed Token-2022 send is a NAMED leftover, and the rest of the sweep runs", async () => {
    const cases: Array<{
      name: string
      mint: Uint8Array
      extra?: Record<string, { owner: string; data: Uint8Array }>
    }> = [
      { name: "TOKEN_2022_NOT_TRANSFERABLE", mint: extendedMint(0, [{ type: 9, body: new Uint8Array(0) }]) },
      { name: "TOKEN_2022_FROZEN", mint: extendedMint(0, [{ type: 6, body: new Uint8Array([2]) }]) },
      {
        name: "TOKEN_2022_HOOK_REFUSED",
        mint: extendedMint(0, [{ type: 14, body: transferHookBody(Keypair.generate().publicKey) }]),
      },
      {
        // Nothing wrong with the mint: the vault's EXISTING destination account is frozen.
        name: "TOKEN_2022_FROZEN",
        mint: baseMint(0),
        extra: {
          [getAssociatedTokenAddressSync(MINT_2022, new PublicKey(VAULT), false, SPL_TOKEN_2022).toBase58()]: {
            owner: TOKEN_2022_PROGRAM_ID,
            data: tokenAccountBytes(true),
          },
        },
      },
    ]
    for (const { name, mint, extra } of cases) {
      const dir = await tempDir()
      await seedTeeStore(dir, [enabledEntry()])
      const source = getAssociatedTokenAddressSync(MINT_2022, teeKey.publicKey, false, SPL_TOKEN_2022)
      // Amount 7, not 1: raw amount 1 with decimals 0 is a DAMM v2 position NFT candidate since
      // BE-315 (P3-ED-6) and takes the close-build path, not the generic transfer this test pins.
      const rpc = defaultRpcState({
        token2022Accounts: [
          { pubkey: source.toBase58(), mint: MINT_2022.toBase58(), amount: "7", decimals: 0, state: "initialized" },
        ],
        accounts: { ...mint2022(mint), ...extra },
        lamports: 1_000_000,
      })
      const { fetch } = createRoutedFetch({
        "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
        "/rpc": (req) => {
          const body = JSON.parse(String(req.init.body)) as { method: string; id: number }
          // The token transaction finalizes WITH an error: the one unambiguous failed send.
          if (body.method === "getSignatureStatuses" && rpc.sent.length === 1) {
            return jsonResponse(200, {
              jsonrpc: "2.0",
              id: body.id,
              result: { value: [{ confirmationStatus: "finalized", err: { InstructionError: [1, "Custom"] } }] },
            })
          }
          return rpcHandler(rpc)(req)
        },
      })
      const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
      expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], deps)).toBe(3)
      const parsed = JSON.parse(stdout.text.trim())
      const named = parsed.residuals.find((r: { kind: string }) => r.kind === name)
      expect(`${name}: ${JSON.stringify(named ?? parsed.residuals)}`).toContain(`${name}: {`)
      expect(named.mint).toBe(MINT_2022.toBase58())
      expect(named.amountRaw).toBe("7")
      // The leftover does not abort the sweep: SOL still moved.
      expect(parsed.receipts.map((r: { kind: string }) => r.kind)).toContain("sol")
    }
  })

  test("a frozen Token-2022 account is named TOKEN_2022_FROZEN before anything is signed for it", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const rpc = defaultRpcState({
      token2022Accounts: [
        { pubkey: "frozen2022", mint: MINT_2022.toBase58(), amount: "9", decimals: 0, state: "frozen" },
      ],
      tokenAccounts: [{ pubkey: "frozenClassic", mint: MINT.toBase58(), amount: "9", decimals: 6, state: "frozen" }],
      accounts: mint2022(baseMint(0)),
    })
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
      "/rpc": rpcHandler(rpc),
    })
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], deps)).toBe(3)
    const parsed = JSON.parse(stdout.text.trim())
    // The classic account keeps Phase 1's kind; the Token-2022 one earns R5's name.
    expect(parsed.residuals.map((r: { kind: string }) => r.kind)).toContain("frozen-or-uninitialized")
    expect(parsed.residuals.map((r: { kind: string }) => r.kind)).toContain("TOKEN_2022_FROZEN")
  })

  test("--emergency sweeps Token-2022 locally, with no API call at all", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const source = getAssociatedTokenAddressSync(MINT_2022, teeKey.publicKey, false, SPL_TOKEN_2022)
    const rpc = defaultRpcState({
      token2022Accounts: [
        { pubkey: source.toBase58(), mint: MINT_2022.toBase58(), amount: "1", decimals: 0, state: "initialized" },
      ],
      accounts: mint2022(baseMint(0)),
    })
    const apiCalls: string[] = []
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => {
        apiCalls.push("lifecycle")
        return jsonResponse(200, LIFECYCLE("disable-pending"))
      },
      "/api/v1/agent/wallets/lw_tee1/swept": () => {
        apiCalls.push("swept")
        return jsonResponse(200, { success: true })
      },
      "/rpc": rpcHandler(rpc),
    })
    const { deps } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--emergency", "--json"], deps)).toBe(3)
    // The NFT moved to the pinned vault under Token-2022, signed by the local key alone.
    const tx = decodeSent(rpc.sent[0] as string)
    expect(tx.instructions[1]?.programId.toBase58()).toBe(TOKEN_2022_PROGRAM_ID)
    expect(tx.instructions[1]?.keys[2]?.pubkey.toBase58()).toBe(
      getAssociatedTokenAddressSync(MINT_2022, new PublicKey(VAULT), false, SPL_TOKEN_2022).toBase58(),
    )
    // Emergency never records a sweep: the authority is still unverified.
    expect(apiCalls).not.toContain("swept")
  })

  test("a frozen token account and SOL dust are residuals, listed with amounts, never touched", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const rpc = defaultRpcState({
      tokenAccounts: [{ pubkey: "frozenAcct", mint: MINT.toBase58(), amount: "9", decimals: 6, state: "frozen" }],
      lamports: 4_000,
      fee: 5_000,
    })
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
      "/rpc": rpcHandler(rpc),
    })
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], deps)).toBe(3)
    const parsed = JSON.parse(stdout.text.trim())
    expect(rpc.sent).toHaveLength(0)
    expect(parsed.residuals.map((r: { kind: string }) => r.kind).sort()).toEqual([
      "frozen-or-uninitialized",
      "sol-dust",
    ])
    expect(parsed.residuals.find((r: { kind: string }) => r.kind === "sol-dust").amountRaw).toBe("4000")
  })

  test("disable-pending without --emergency refuses to sign (exit 3); with --emergency it sweeps, warns, and stays pending", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const rpc = defaultRpcState()
    const swept: unknown[] = []
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("disable-pending")),
      "/api/v1/agent/wallets/lw_tee1/swept": () => {
        swept.push(true)
        return jsonResponse(200, { success: true })
      },
      "/rpc": rpcHandler(rpc),
    })
    const refused = depsFor(dir, fetch, [PASSPHRASE])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC], refused.deps)).toBe(3)
    expect(refused.stderr.text).toContain("--emergency")
    expect(rpc.sent).toHaveLength(0)

    const emergency = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--emergency"], emergency.deps)).toBe(3)
    expect(emergency.stdout.text).toContain("EMERGENCY SWEEP")
    expect(emergency.stdout.text).toContain("race")
    expect(rpc.sent).toHaveLength(1)
    expect(swept).toEqual([])
    expect(emergency.stdout.text).toContain("remote authority is still pending")
  })

  test("an enabled wallet is refused: disable first", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const rpc = defaultRpcState()
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("enabled")),
      "/rpc": rpcHandler(rpc),
    })
    const { deps, stderr } = depsFor(dir, fetch, [PASSPHRASE])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC], deps)).toBe(1)
    expect(stderr.text).toContain("tee disable")
    expect(rpc.sent).toHaveLength(0)
  })

  test("a wrong vault confirmation signs nothing", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const rpc = defaultRpcState()
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
      "/rpc": rpcHandler(rpc),
    })
    const { deps } = depsFor(dir, fetch, [PASSPHRASE, "wrong!"])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC], deps)).toBe(1)
    expect(rpc.sent).toHaveLength(0)
  })

  test("a transaction that never finalizes is a residual, not a success", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const rpc = defaultRpcState({
      statuses: Array.from({ length: 60 }, () => ({ confirmationStatus: "processed", err: null })),
    })
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
      "/rpc": rpcHandler(rpc),
    })
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], deps)).toBe(3)
    const parsed = JSON.parse(stdout.text.trim())
    expect(parsed.residuals[0].kind).toBe("finality-uncertain")
    expect(parsed.residuals[0].detail).toContain("not finalized")
    expect(parsed.residuals[0].detail).toContain("may still land")
    expect(parsed.pending).toHaveLength(1)
    expect(parsed.pending[0].kind).toBe("sol")
    // The pending record was written BEFORE the broadcast and survives the deadline.
    const stored = (await openStore(dir)).entries[0]
    expect(stored?.tee?.sweepPending?.map((p) => p.signature)).toEqual([parsed.pending[0].signature])
    expect(stored?.tee?.sweepReceipts ?? []).toEqual([])
  })

  test("a plain-http RPC URL to a remote host is a usage error", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const { fetch, calls } = createRoutedFetch({})
    expect(await run(["tee", "sweep", TEE, "--rpc-url", "http://rpc.example/"], depsFor(dir, fetch, []).deps)).toBe(2)
    expect(calls).toHaveLength(0)
  })
})

describe("T28: two writers cannot lose keys (TEE wallet store lock + merge on commit)", () => {
  test("overlapping `tee new` commands both succeed and BOTH keys are in the store", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [teeEntry()])
    const { fetch, calls } = createRoutedFetch({})
    // B opens the store first and stalls on that read; A runs to completion in between; B then
    // commits against the file A wrote, not the copy B opened.
    let releaseB!: () => void
    const waitB = new Promise<void>((resolve) => {
      releaseB = resolve
    })
    let readB!: () => void
    const startedB = new Promise<void>((resolve) => {
      readB = resolve
    })
    let firstRead = true
    const b = depsFor(dir, fetch, [PASSPHRASE], {
      readFile: async (p: string) => {
        const raw = await realReadFile(p, "utf8")
        if (firstRead) {
          firstRead = false
          readB()
          await waitB
        }
        return raw
      },
    })
    const taskB = run(["tee", "new", "--json", "--label", "b"], b.deps)
    await startedB
    const a = depsFor(dir, fetch, [PASSPHRASE])
    expect(await run(["tee", "new", "--json", "--label", "a"], a.deps)).toBe(0)
    releaseB()
    expect(await taskB).toBe(0)
    expect(calls).toHaveLength(0)

    const addressA = JSON.parse(a.stdout.text).address
    const addressB = JSON.parse(b.stdout.text).address
    const stored = await openStore(dir)
    expect(stored.entries.map((e) => e.address)).toEqual([TEE, addressA, addressB])
    expect(stored.entries.map((e) => e.index)).toEqual([0, 1, 2])
    expect(stored.entries.map((e) => e.label)).toEqual(["tee-0", "a", "b"])
    // B's printed index is the one it actually got after the merge, not the stale one.
    expect(JSON.parse(b.stdout.text).index).toBe(2)
    for (const e of stored.entries.slice(1)) {
      expect(base58.decode(e.privateKey)).toHaveLength(64)
    }
  })

  test("a lock left behind fails closed: nothing is written and the message names the lock", async () => {
    const dir = await tempDir()
    const path = await seedTeeStore(dir, [teeEntry()])
    await mkdir(keystoreLockPath(path))
    const before = await realReadFile(path, "utf8")
    const { fetch } = createRoutedFetch({})
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE])
    expect(await run(["tee", "new", "--json"], deps)).toBe(1)
    const failure = JSON.parse(stdout.text)
    expect(failure.code).toBe("TEE_STORE_LOCKED")
    expect(failure.message).toContain(keystoreLockPath(path))
    expect(await realReadFile(path, "utf8")).toBe(before)
  })

  test("a store replaced under a different passphrase between open and commit is never overwritten", async () => {
    const dir = await tempDir()
    const path = await seedTeeStore(dir, [teeEntry()])
    let reads = 0
    const { fetch } = createRoutedFetch({})
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE], {
      readFile: async (p: string) => {
        const raw = await realReadFile(p, "utf8")
        reads += 1
        // Another operator (or a restore) replaces the file after this command opened it.
        if (reads === 1) await seedTeeStore(dir, [teeEntry({ label: "restored" })], "a different passphrase!")
        return raw
      },
    })
    expect(await run(["tee", "new", "--json"], deps)).toBe(1)
    expect(JSON.parse(stdout.text).code).toBe("TEE_STORE_CHANGED")
    const stored = await openStore(dir, "a different passphrase!")
    expect(stored.entries.map((e) => e.label)).toEqual(["restored"])
    expect(await realReadFile(path, "utf8")).toContain("ember-tee")
  })

  test("enable and disable commit against the current file: a key appended meanwhile survives", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const other = Keypair.generate()
    let reads = 0
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1": () =>
        jsonResponse(202, { success: true, state: "disable-pending", complete: false }),
    })
    const { deps } = depsFor(dir, fetch, [PASSPHRASE], {
      readFile: async (p: string) => {
        const raw = await realReadFile(p, "utf8")
        reads += 1
        if (reads === 1) {
          // A concurrent `tee new` lands after this command opened the store.
          const current = await openStore(dir)
          current.entries.push({
            index: 1,
            chain: "solana",
            address: other.publicKey.toBase58(),
            label: "concurrent",
            createdAt: "2026-09-16T02:00:00.000Z",
            privateKey: base58.encode(other.secretKey),
            imported: false,
            tee: { network: "solana-mainnet" },
          })
          await writeKeystoreFile(
            defaultTeeKeystorePath({ CANDLE_CONFIG_DIR: dir }, TEST_HOME),
            await serializeKeystore(current.entries, current.key, current.salt, current.iterations, "ember-tee"),
          )
        }
        return raw
      },
    })
    expect(await run(["tee", "disable", TEE], deps)).toBe(3)
    const stored = await openStore(dir)
    expect(stored.entries.map((e) => e.label)).toEqual(["tee-0", "concurrent"])
    expect(typeof stored.entries[0]?.tee?.stopRequestedAt).toBe("string")
  })
})

describe("HW-06: the stop intent is durable before the server is asked", () => {
  test("a failed stop request (503) still persists stopRequestedAt, exits 1, and reports remote enforcement UNCONFIRMED; fund then refuses", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const { fetch, calls } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1": () => jsonResponse(503, { error: "unavailable" }),
    })
    const { deps, stderr } = depsFor(dir, fetch, [PASSPHRASE])
    expect(await run(["tee", "disable", TEE], deps)).toBe(1)
    expect(calls[0]?.init.method).toBe("DELETE")
    expect(stderr.text).toContain("UNCONFIRMED")
    expect(stderr.text).toContain("tee disable")
    const stored = await openStore(dir)
    expect(typeof stored.entries[0]?.tee?.stopRequestedAt).toBe("string")
    expect(stored.entries[0]?.tee?.remoteAuthority).toBe("verified-active")

    const fund = depsFor(dir, fetch, [PASSPHRASE])
    expect(await run(["tee", "fund", TEE, "--amount", "1", "--json"], fund.deps)).toBe(1)
    expect(JSON.parse(fund.stdout.text).code).toBe("TEE_WALLET_STOPPED")
  })

  test("--json: the unconfirmed stop is one typed object carrying the local marker", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1": () => jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "revoked" } }),
    })
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE])
    expect(await run(["tee", "disable", TEE, "--json"], deps)).toBe(1)
    const body = JSON.parse(stdout.text)
    expect(body).toMatchObject({
      ok: false,
      code: "STOP_UNCONFIRMED",
      remoteEnforcement: "unconfirmed",
      linkedWalletId: "lw_tee1",
    })
    expect(typeof body.stopRequestedAt).toBe("string")
    expect(body.message).toContain("no longer works")
  })

  test("no API key: the stop intent is persisted, no request is made, and the session path is named", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const { fetch, calls } = createRoutedFetch({})
    const { deps, stderr } = depsFor(dir, fetch, [PASSPHRASE], { store: createFakeStore({}) })
    expect(await run(["tee", "disable", TEE], deps)).toBe(1)
    expect(calls).toHaveLength(0)
    expect(stderr.text).toContain("session")
    expect(stderr.text).toContain("lw_tee1")
    expect(typeof (await openStore(dir)).entries[0]?.tee?.stopRequestedAt).toBe("string")
  })

  test("a repeat disable keeps the FIRST stopRequestedAt", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [
      enabledEntry({
        tee: {
          network: "solana-mainnet",
          vaultDestination: VAULT,
          boundKeyPrefix: "ck_live_x",
          remoteAuthority: "verified-active",
          enabledAt: "2026-09-16T01:00:00.000Z",
          stopRequestedAt: "2026-09-16T03:00:00.000Z",
        },
      }),
    ])
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1": () =>
        jsonResponse(202, { success: true, state: "disable-pending", complete: false }),
    })
    const { deps } = depsFor(dir, fetch, [PASSPHRASE])
    expect(await run(["tee", "disable", TEE], deps)).toBe(3)
    expect((await openStore(dir)).entries[0]?.tee?.stopRequestedAt).toBe("2026-09-16T03:00:00.000Z")
  })
})

describe("HW-08 / T25: recovery does not depend on the operational credential", () => {
  test("no API key + --emergency: the sweep signs and sends with only the local key and the pinned vault; authority stays pending", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const rpc = defaultRpcState()
    const { fetch, calls } = createRoutedFetch({ "/rpc": rpcHandler(rpc) })
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)], { store: createFakeStore({}) })
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--emergency"], deps)).toBe(3)
    expect(rpc.sent).toHaveLength(1)
    const tx = Transaction.from(Buffer.from(rpc.sent[0] as string, "base64"))
    expect(tx.verifySignatures()).toBe(true)
    expect(tx.instructions[0]?.keys[1]?.pubkey.toBase58()).toBe(VAULT)
    expect(Buffer.from(tx.instructions[0]?.data.subarray(4, 12) ?? []).readBigUInt64LE()).toBe(995_000n)
    // Only the RPC was called: no lifecycle read, no sweep record, nothing that needs a key.
    expect(calls.every((c) => c.url.includes("/rpc"))).toBe(true)
    expect(stdout.text).toContain("EMERGENCY SWEEP")
    expect(stdout.text).toContain("NOT read")
    expect(stdout.text).toContain("no API key available")
    expect(stdout.text).toContain("remote authority is still pending")
    const stored = await openStore(dir)
    expect(stored.entries[0]?.tee?.sweptAt).toBeUndefined()
    expect(typeof stored.entries[0]?.tee?.stopRequestedAt).toBe("string")
  })

  test("no API key without --emergency: refuses (exit 3), signs nothing, and names the emergency path", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const rpc = defaultRpcState()
    const { fetch } = createRoutedFetch({ "/rpc": rpcHandler(rpc) })
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE], { store: createFakeStore({}) })
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], deps)).toBe(3)
    expect(rpc.sent).toHaveLength(0)
    const body = JSON.parse(stdout.text)
    expect(body.code).toBe("TEE_WALLET_STATE_UNREAD")
    expect(body.suggestion).toContain("--emergency")
  })

  test("a revoked key (401 on the lifecycle read) + --emergency: recovers locally and never posts a sweep record with that key", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const rpc = defaultRpcState()
    const { fetch, calls } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () =>
        jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "API key revoked" } }),
      "/rpc": rpcHandler(rpc),
    })
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--emergency", "--json"], deps)).toBe(3)
    expect(rpc.sent).toHaveLength(1)
    expect(calls.some((c) => c.url.includes("/swept"))).toBe(false)
    const body = JSON.parse(stdout.text)
    expect(body.state).toBe("disable-pending")
    expect(body.serverState).toBe("unread")
    expect(body.recordedOnServer).toBe(false)
  })
})

describe("SC-06: completion needs a post-finality inventory", () => {
  test("SOL deposited while the sweep finalized is a residual: exit 3, not swept, nothing recorded anywhere", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const rpc = defaultRpcState()
    const base = rpcHandler(rpc)
    let balanceReadsAfterSend = 0
    const swept: unknown[] = []
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
      "/api/v1/agent/wallets/lw_tee1/swept": () => {
        swept.push(true)
        return jsonResponse(200, { success: true, state: "swept" })
      },
      "/rpc": (req) => {
        const body = JSON.parse(String(req.init.body)) as { method: string }
        // A deposit lands while the transfer is being confirmed.
        if (body.method === "getSignatureStatuses") rpc.lamports = 123_456
        if (body.method === "getBalance" && rpc.sent.length > 0) balanceReadsAfterSend += 1
        return base(req)
      },
    })
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], deps)).toBe(3)
    expect(balanceReadsAfterSend).toBeGreaterThan(0)
    const body = JSON.parse(stdout.text)
    expect(body.state).toBe("quarantined")
    expect(body.receipts).toHaveLength(1)
    expect(body.residuals).toEqual([expect.objectContaining({ kind: "sol-remaining", amountRaw: "123456" })])
    expect(body.inventory).toMatchObject({ verified: true, lamports: "123456" })
    expect(body.recordedOnServer).toBe(false)
    expect(swept).toEqual([])
    expect((await openStore(dir)).entries[0]?.tee?.sweptAt).toBeUndefined()
  })

  test("a token account that appears after finality is a residual too", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const rpc = defaultRpcState()
    const base = rpcHandler(rpc)
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
      "/rpc": (req) => {
        const body = JSON.parse(String(req.init.body)) as { method: string }
        if (body.method === "getSignatureStatuses" && rpc.tokenAccounts.length === 0) {
          rpc.tokenAccounts.push({
            pubkey: "lateAcct",
            mint: MINT.toBase58(),
            amount: "9",
            decimals: 6,
            state: "initialized",
          })
        }
        return base(req)
      },
    })
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], deps)).toBe(3)
    const body = JSON.parse(stdout.text)
    expect(body.state).not.toBe("swept")
    expect(body.residuals).toEqual([expect.objectContaining({ kind: "token-account-remaining", account: "lateAcct" })])
  })

  test("an inventory that cannot be read after the transfers keeps the address quarantined", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const rpc = defaultRpcState()
    const base = rpcHandler(rpc)
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
      "/rpc": (req) => {
        const body = JSON.parse(String(req.init.body)) as { method: string }
        if (body.method === "getBalance" && rpc.sent.length > 0) return jsonResponse(503, {})
        return base(req)
      },
    })
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], deps)).toBe(3)
    const body = JSON.parse(stdout.text)
    expect(body.state).toBe("quarantined")
    expect(body.inventory.verified).toBe(false)
    expect(body.residuals).toEqual([expect.objectContaining({ kind: "inventory-unverified" })])
  })

  test("the server refusing the record (409: authority pending) REPLACES the earlier quarantined read: state disable-pending, receipts retained, no local swept mark", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const rpc = defaultRpcState()
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
      "/api/v1/agent/wallets/lw_tee1/swept": () =>
        jsonResponse(409, {
          success: false,
          error: {
            code: "VALIDATION_FAILED",
            message: "Remote signing authority is not verified denied",
            state: "disable-pending",
            retryable: true,
          },
        }),
      "/rpc": rpcHandler(rpc),
    })
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], deps)).toBe(3)
    const body = JSON.parse(stdout.text)
    expect(body.state).toBe("disable-pending")
    expect(body.serverState).toBe("disable-pending")
    expect(body.residuals).toEqual([expect.objectContaining({ kind: "server-record-refused" })])
    expect(body.recordedOnServer).toBe(false)
    const stored = (await openStore(dir)).entries[0]
    expect(stored?.tee?.sweptAt).toBeUndefined()
    expect(stored?.tee?.sweepReceipts?.map((r) => r.signature)).toEqual(rpc.sent.map(sigOf))

    // Text output says the same thing: the address is pending, not quarantined.
    const text = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC], text.deps)).toBe(3)
    expect(text.stdout.text).toContain("stays disable-pending")
    expect(text.stdout.text).toContain("not verified denied")
    expect(text.stdout.text).not.toContain("stays quarantined")
  })
})

describe("HW-07: finalized receipts are retained and reconciled on retry", () => {
  function recordingServer(opts: { available: () => boolean; lifecycle: () => string }) {
    let recordCalls = 0
    const records: unknown[] = []
    const rpc = defaultRpcState()
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE(opts.lifecycle())),
      "/api/v1/agent/wallets/lw_tee1/swept": (req) => {
        recordCalls += 1
        records.push(JSON.parse(String(req.init.body)))
        return opts.available()
          ? jsonResponse(200, { success: true, id: "lw_tee1", state: "swept", sweptAt: 1 })
          : jsonResponse(503, { error: "temporary outage" })
      },
      "/rpc": rpcHandler(rpc),
    })
    return { fetch, rpc, records, recordCalls: () => recordCalls }
  }

  test("a recording outage: the second run records the retained receipt with no new transfer and exits 0", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    let available = false
    const server = recordingServer({ available: () => available, lifecycle: () => "quarantined" })
    const first = depsFor(dir, server.fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], first.deps)).toBe(3)
    const one = JSON.parse(first.stdout.text)
    expect(one.receipts).toHaveLength(1)
    expect(one.residuals).toEqual([expect.objectContaining({ kind: "server-record-failed" })])
    expect(one.residuals[0].detail).toContain("retained")
    expect(server.rpc.lamports).toBe(0)
    expect((await openStore(dir)).entries[0]?.tee?.sweepReceipts?.map((r) => r.signature)).toEqual(
      server.rpc.sent.map(sigOf),
    )

    available = true
    const second = depsFor(dir, server.fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], second.deps)).toBe(0)
    const two = JSON.parse(second.stdout.text)
    expect(two.state).toBe("swept")
    expect(two.newReceipts).toBe(0)
    expect(two.retainedReceipts).toBe(1)
    expect(two.receipts.map((r: { signature: string }) => r.signature)).toEqual(server.rpc.sent.map(sigOf))
    expect(server.rpc.sent).toHaveLength(1)
    expect(server.recordCalls()).toBe(2)
    expect(server.records[1]).toEqual({ signatures: server.rpc.sent.map(sigOf), residuals: [] })
    expect(typeof (await openStore(dir)).entries[0]?.tee?.sweptAt).toBe("string")
  })

  test("emergency sweep, then a verified disable, then a plain sweep: the emergency receipts are recorded, nothing is re-signed", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    let lifecycle = "disable-pending"
    const server = recordingServer({ available: () => true, lifecycle: () => lifecycle })
    const emergency = depsFor(dir, server.fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--emergency", "--json"], emergency.deps)).toBe(3)
    expect(JSON.parse(emergency.stdout.text).state).toBe("disable-pending")
    expect(server.recordCalls()).toBe(0)
    expect(server.rpc.sent).toHaveLength(1)

    lifecycle = "quarantined" // a later `tee disable` read back the denial
    const reconcile = depsFor(dir, server.fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], reconcile.deps)).toBe(0)
    const body = JSON.parse(reconcile.stdout.text)
    expect(body.state).toBe("swept")
    expect(body.emergency).toBe(false)
    expect(body.retainedReceipts).toBe(1)
    expect(body.newReceipts).toBe(0)
    expect(server.rpc.sent).toHaveLength(1)
    expect(server.records).toEqual([{ signatures: server.rpc.sent.map(sigOf), residuals: [] }])
  })

  test("a repeat after success is idempotent: exit 0, no transfer, no second record, and a late deposit still reopens residuals", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const server = recordingServer({ available: () => true, lifecycle: () => "quarantined" })
    const first = depsFor(dir, server.fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], first.deps)).toBe(0)
    expect(server.recordCalls()).toBe(1)

    const again = depsFor(dir, server.fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], again.deps)).toBe(0)
    const body = JSON.parse(again.stdout.text)
    expect(body.state).toBe("swept")
    expect(body.recordedOnServer).toBe(true)
    expect(body.newReceipts).toBe(0)
    expect(server.rpc.sent).toHaveLength(1)
    expect(server.recordCalls()).toBe(1)

    // A deposit after the sweep: the address is residual-present again (SC-06), and the next run
    // moves it and reports the new receipt alongside the retained one.
    server.rpc.lamports = 50_000
    const late = depsFor(dir, server.fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], late.deps)).toBe(0)
    const moved = JSON.parse(late.stdout.text)
    expect(moved.newReceipts).toBe(1)
    expect(moved.retainedReceipts).toBe(1)
    expect(server.rpc.sent).toHaveLength(2)
    expect(server.rpc.lamports).toBe(0)
  })

  test("an interrupted run keeps the token receipt: the retry only moves what is left", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const source = getAssociatedTokenAddressSync(MINT, teeKey.publicKey)
    const rpc = defaultRpcState({
      tokenAccounts: [
        { pubkey: source.toBase58(), mint: MINT.toBase58(), amount: "700000", decimals: 6, state: "initialized" },
      ],
      // The token transaction finalizes; the SOL transfer never does on the first run.
      statuses: [
        { confirmationStatus: "finalized", err: null },
        ...Array.from({ length: 60 }, () => ({ confirmationStatus: "processed", err: null })),
      ],
    })
    const records: unknown[] = []
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
      "/api/v1/agent/wallets/lw_tee1/swept": (req) => {
        records.push(JSON.parse(String(req.init.body)))
        return jsonResponse(200, { success: true, state: "swept" })
      },
      "/rpc": rpcHandler(rpc),
    })
    const first = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], first.deps)).toBe(3)
    const one = JSON.parse(first.stdout.text)
    expect(one.receipts.map((r: { kind: string }) => r.kind)).toEqual(["token"])
    expect(one.residuals.map((r: { kind: string }) => r.kind)).toContain("finality-uncertain")
    expect(one.pending).toHaveLength(1)
    expect(rpc.sent).toHaveLength(2)

    // The unfinalized SOL transfer never landed and its blockhash expired: put its lamports back,
    // answer "not found" for that signature on both reads around the validity check, and report
    // the blockhash as no longer valid.
    rpc.lamports = 990_000
    rpc.statuses = [null, null]
    rpc.blockhashValid = false
    const second = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], second.deps)).toBe(0)
    const two = JSON.parse(second.stdout.text)
    expect(two.retainedReceipts).toBe(1)
    expect(two.newReceipts).toBe(1)
    expect(two.receipts.map((r: { kind: string }) => r.kind)).toEqual(["token", "sol"])
    // The retained token receipt (first send) plus the retried SOL transfer (third send); the
    // second send never landed and was dropped as expired.
    expect(records).toEqual([
      { signatures: [sigOf(rpc.sent[0] as string), sigOf(rpc.sent[2] as string)], residuals: [] },
    ])
  })
})

describe("HW-07: ambiguous finality is persisted before broadcast and reconciled", () => {
  test("a transfer that finalizes AFTER the polling deadline: the next run turns the pending record into a receipt, signs nothing, records, exit 0", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const rpc = defaultRpcState({
      statuses: Array.from({ length: 45 }, () => ({ confirmationStatus: "processed", err: null })),
    })
    const base = rpcHandler(rpc)
    let finalized = false
    let statusReads = 0
    const records: unknown[] = []
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
      "/api/v1/agent/wallets/lw_tee1/swept": (req) => {
        records.push(JSON.parse(String(req.init.body)))
        return jsonResponse(200, { success: true, state: "swept" })
      },
      "/rpc": (req) => {
        const body = JSON.parse(String(req.init.body)) as { method: string; id: number }
        if (body.method === "getSignatureStatuses") statusReads += 1
        // Until the transfer finalizes, finalized-commitment balance reads still show the old balance.
        if (body.method === "getBalance" && rpc.sent.length > 0 && !finalized)
          return jsonResponse(200, { jsonrpc: "2.0", id: body.id, result: { value: 1_000_000 } })
        return base(req)
      },
    })
    const first = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], first.deps)).toBe(3)
    const one = JSON.parse(first.stdout.text)
    expect(rpc.sent).toHaveLength(1)
    expect(one.pending).toHaveLength(1)
    const pendingSig = one.pending[0].signature
    expect(one.residuals.map((r: { kind: string }) => r.kind)).toContain("finality-uncertain")
    expect(records).toEqual([])
    const afterFirst = (await openStore(dir)).entries[0]
    expect(afterFirst?.tee?.sweepPending?.map((p) => p.signature)).toEqual([pendingSig])
    expect(afterFirst?.tee?.sweepPending?.[0]?.blockhash).toBe(BLOCKHASH)

    finalized = true
    rpc.statuses = []
    const before = statusReads
    const second = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], second.deps)).toBe(0)
    const two = JSON.parse(second.stdout.text)
    expect(statusReads - before).toBeGreaterThan(0)
    expect(rpc.sent).toHaveLength(1)
    expect(two.state).toBe("swept")
    expect(two.newReceipts).toBe(1)
    expect(two.receipts.map((r: { signature: string }) => r.signature)).toEqual([pendingSig])
    expect(two.pending).toEqual([])
    expect(records).toEqual([{ signatures: [pendingSig], residuals: [] }])
    const stored = (await openStore(dir)).entries[0]
    expect(stored?.tee?.sweepPending).toEqual([])
    expect(stored?.tee?.sweepReceipts?.map((r) => r.signature)).toEqual([pendingSig])
    expect(typeof stored?.tee?.sweptAt).toBe("string")
  })

  test("a send that throws is uncertain, not failed: the record survives and the next run resolves it", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const rpc = defaultRpcState()
    const base = rpcHandler(rpc)
    let sendThrows = true
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
      "/api/v1/agent/wallets/lw_tee1/swept": () => jsonResponse(200, { success: true, state: "swept" }),
      "/rpc": (req) => {
        const body = JSON.parse(String(req.init.body)) as { method: string }
        if (body.method === "sendTransaction" && sendThrows) {
          // The RPC relays it and then the connection drops before the answer arrives.
          base(req)
          return new Response("", { status: 502 })
        }
        return base(req)
      },
    })
    const first = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], first.deps)).toBe(3)
    const one = JSON.parse(first.stdout.text)
    expect(one.pending).toHaveLength(1)
    expect(one.residuals[0].kind).toBe("finality-uncertain")
    expect(one.residuals[0].detail).toContain("may still land")
    expect(rpc.sent).toHaveLength(1)

    sendThrows = false
    const second = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], second.deps)).toBe(0)
    expect(rpc.sent).toHaveLength(1)
    expect(JSON.parse(second.stdout.text).receipts).toHaveLength(1)
  })

  test("a still-unconfirmed pending transaction with a valid blockhash blocks new signing and stays residual", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const rpc = defaultRpcState({
      statuses: Array.from({ length: 45 }, () => ({ confirmationStatus: "processed", err: null })),
    })
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
      "/rpc": rpcHandler(rpc),
    })
    const first = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], first.deps)).toBe(3)
    expect(rpc.sent).toHaveLength(1)

    // Still nothing known about it, and it can still land: do not race it.
    rpc.lamports = 1_000_000
    rpc.statuses = [null]
    rpc.blockhashValid = true
    const second = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC], second.deps)).toBe(3)
    expect(rpc.sent).toHaveLength(1)
    expect(second.stdout.text).toContain("still in flight")
    expect(second.stdout.text).toContain("stays quarantined")
    expect((await openStore(dir)).entries[0]?.tee?.sweepPending).toHaveLength(1)

    // Now it is gone for good (blockhash expired): the balance is swept again and recorded.
    const records: unknown[] = []
    const { fetch: fetch3 } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
      "/api/v1/agent/wallets/lw_tee1/swept": (req) => {
        records.push(JSON.parse(String(req.init.body)))
        return jsonResponse(200, { success: true, state: "swept" })
      },
      "/rpc": rpcHandler(rpc),
    })
    rpc.statuses = [null, null]
    rpc.blockhashValid = false
    const third = depsFor(dir, fetch3, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], third.deps)).toBe(0)
    expect(rpc.sent).toHaveLength(2)
    const body = JSON.parse(third.stdout.text)
    // The fake chain hands out one constant blockhash, so the re-signed transfer is byte-identical
    // to the expired one (a real chain's fresh blockhash gives a fresh signature); what matters is
    // that it was signed and sent AGAIN, finalized, and recorded, with no pending record left.
    expect(body.receipts).toHaveLength(1)
    expect(body.receipts[0].signature).toBe(sigOf(rpc.sent[1] as string))
    expect(records).toEqual([{ signatures: [body.receipts[0].signature], residuals: [] }])
    expect((await openStore(dir)).entries[0]?.tee?.sweepPending).toEqual([])
  })

  test("a pending transaction that failed on chain is dropped and its balance swept again", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [
      enabledEntry({
        tee: {
          network: "solana-mainnet",
          vaultDestination: VAULT,
          boundKeyPrefix: "ck_live_x",
          remoteAuthority: "verified-active",
          enabledAt: "2026-09-16T01:00:00.000Z",
          stopRequestedAt: "2026-09-16T03:00:00.000Z",
          sweepPending: [
            {
              kind: "sol",
              amountRaw: "995000",
              signature: "oldsig",
              blockhash: BLOCKHASH,
              submittedAt: "2026-09-16T03:01:00.000Z",
            },
          ],
        },
      }),
    ])
    const rpc = defaultRpcState({
      statuses: [{ confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] } }],
    })
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
      "/api/v1/agent/wallets/lw_tee1/swept": () => jsonResponse(200, { success: true, state: "swept" }),
      "/rpc": rpcHandler(rpc),
    })
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], deps)).toBe(0)
    const body = JSON.parse(stdout.text)
    expect(rpc.sent).toHaveLength(1)
    expect(body.receipts.map((r: { signature: string }) => r.signature)).not.toContain("oldsig")
    expect(body.pending).toEqual([])
  })
})

describe("HW-07: pending evidence is preserved until conclusive", () => {
  const withPending = (blockhash = BLOCKHASH) =>
    enabledEntry({
      tee: {
        network: "solana-mainnet",
        vaultDestination: VAULT,
        boundKeyPrefix: "ck_live_x",
        remoteAuthority: "verified-active",
        enabledAt: "2026-09-16T01:00:00.000Z",
        stopRequestedAt: "2026-09-16T03:00:00.000Z",
        sweepPending: [
          {
            kind: "sol",
            amountRaw: "995000",
            signature: "original-signature",
            blockhash,
            submittedAt: "2026-09-16T03:01:00.000Z",
          },
        ],
      },
    })
  const quarantined = (rpc: RpcState, extra: Record<string, RouteHandler> = {}) =>
    createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
      "/api/v1/agent/wallets/lw_tee1/swept": () => jsonResponse(200, { success: true, state: "swept" }),
      "/rpc": rpcHandler(rpc),
      ...extra,
    })

  test("a confirmed observation is kept even though its admission blockhash expired; nothing new is signed", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [withPending()])
    const rpc = defaultRpcState({
      lamports: 0,
      statuses: [{ confirmationStatus: "confirmed", err: null }],
      blockhashValid: false,
    })
    const { fetch } = quarantined(rpc)
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], deps)).toBe(3)
    const body = JSON.parse(stdout.text)
    expect(body.pending.map((p: { signature: string }) => p.signature)).toEqual(["original-signature"])
    expect(body.residuals[0]).toMatchObject({ kind: "finality-uncertain" })
    expect(body.residuals[0].detail).toContain("confirmed")
    expect(rpc.sent).toHaveLength(0)
    expect((await openStore(dir)).entries[0]?.tee?.sweepPending).toHaveLength(1)
  })

  test("a nonfinal ERROR is not a failure: kept pending, nothing new signed", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [withPending()])
    const rpc = defaultRpcState({
      lamports: 995_000,
      statuses: [{ confirmationStatus: "processed", err: { InstructionError: [0, "Custom"] } }],
    })
    const { fetch } = quarantined(rpc)
    const { deps } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], deps)).toBe(3)
    expect(rpc.sent).toHaveLength(0)
    expect((await openStore(dir)).entries[0]?.tee?.sweepPending?.map((p) => p.signature)).toEqual([
      "original-signature",
    ])
  })

  test("a malformed isBlockhashValid answer is unknown, not expiry: kept pending, nothing new signed", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [withPending()])
    const rpc = defaultRpcState({ lamports: 0, statuses: [null] })
    const base = rpcHandler(rpc)
    const { fetch } = quarantined(rpc, {
      "/rpc": (req) => {
        const body = JSON.parse(String(req.init.body)) as { method: string; id: number }
        if (body.method === "isBlockhashValid") return jsonResponse(200, { jsonrpc: "2.0", id: body.id, result: {} })
        return base(req)
      },
    })
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], deps)).toBe(3)
    expect(JSON.parse(stdout.text).residuals[0].detail).toContain("validity is unknown")
    expect(rpc.sent).toHaveLength(0)
    expect((await openStore(dir)).entries[0]?.tee?.sweepPending).toHaveLength(1)
  })

  test("the status/expiry race: not found, blockhash expired, then finalized on the confirming re-read becomes a receipt", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [withPending()])
    const rpc = defaultRpcState({
      lamports: 0,
      statuses: [null, { confirmationStatus: "finalized", err: null }],
      blockhashValid: false,
    })
    let statusReads = 0
    const base = rpcHandler(rpc)
    const records: unknown[] = []
    const { fetch } = quarantined(rpc, {
      "/api/v1/agent/wallets/lw_tee1/swept": (req) => {
        records.push(JSON.parse(String(req.init.body)))
        return jsonResponse(200, { success: true, state: "swept" })
      },
      "/rpc": (req) => {
        if ((JSON.parse(String(req.init.body)) as { method: string }).method === "getSignatureStatuses")
          statusReads += 1
        return base(req)
      },
    })
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], deps)).toBe(0)
    expect(statusReads).toBe(2)
    expect(rpc.sent).toHaveLength(0)
    expect(JSON.parse(stdout.text).receipts.map((r: { signature: string }) => r.signature)).toEqual([
      "original-signature",
    ])
    expect(records).toEqual([{ signatures: ["original-signature"], residuals: [] }])
  })

  test("validated expiry needs TWO missing reads around the invalid blockhash; only then is the balance swept again", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [withPending()])
    const rpc = defaultRpcState({ lamports: 995_000, statuses: [null, null], blockhashValid: false })
    const { fetch } = quarantined(rpc)
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], deps)).toBe(0)
    const body = JSON.parse(stdout.text)
    expect(rpc.sent).toHaveLength(1)
    expect(body.receipts.map((r: { signature: string }) => r.signature)).toEqual([sigOf(rpc.sent[0] as string)])
    expect(body.pending).toEqual([])
  })

  test("a mismatched RPC echo never replaces the locally signed identity; the send stays uncertain under that identity", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const rpc = defaultRpcState({
      statuses: Array.from({ length: 45 }, () => ({ confirmationStatus: "processed", err: null })),
    })
    const base = rpcHandler(rpc)
    const { fetch } = quarantined(rpc, {
      "/rpc": (req) => {
        const body = JSON.parse(String(req.init.body)) as { method: string; id: number }
        if (body.method === "sendTransaction") {
          base(req)
          return jsonResponse(200, { jsonrpc: "2.0", id: body.id, result: "sig1" })
        }
        return base(req)
      },
    })
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], deps)).toBe(3)
    const actual = sigOf(rpc.sent[0] as string)
    const body = JSON.parse(stdout.text)
    expect(body.pending[0].signature).toBe(actual)
    expect(body.residuals[0].detail).toContain("echoed a different signature")
    expect((await openStore(dir)).entries[0]?.tee?.sweepPending?.[0]?.signature).toBe(actual)
  })

  test("in-run polling: a nonfinal error keeps polling and ends uncertain; only a finalized error is a failure", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const rpc = defaultRpcState({
      statuses: Array.from({ length: 45 }, () => ({
        confirmationStatus: "confirmed",
        err: { InstructionError: [0, "Custom"] },
      })),
    })
    const { fetch } = quarantined(rpc)
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], deps)).toBe(3)
    expect(JSON.parse(stdout.text).pending).toHaveLength(1)
    expect((await openStore(dir)).entries[0]?.tee?.sweepPending).toHaveLength(1)

    const dir2 = await tempDir()
    await seedTeeStore(dir2, [enabledEntry()])
    const rpc2 = defaultRpcState({
      statuses: [{ confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] } }],
    })
    const { fetch: fetch2 } = quarantined(rpc2)
    const second = depsFor(dir2, fetch2, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], second.deps)).toBe(3)
    const body = JSON.parse(second.stdout.text)
    expect(body.pending).toEqual([])
    expect(body.residuals.map((r: { kind: string }) => r.kind)).toContain("sol-transfer-failed")
    expect((await openStore(dir2)).entries[0]?.tee?.sweepPending).toEqual([])
  })
})

/**
 * BE-315 (Ember Phase 3 PR D, CLI half; spec P3-ED-6, test matrix "DAMM v2"): LP positions in an
 * ordinary sweep. The position NFT is discovered LOCALLY (Token-2022, raw amount 1, decimals 0),
 * one close-build is fetched per candidate mint under the bound key, every artifact is verified
 * before any is signed, and a close that cannot be obtained or fails a check is a named leftover
 * that does not stop the token and SOL moves. `--emergency` never calls the API (pinned above,
 * "--emergency sweeps Token-2022 locally, with no API call at all").
 */
describe("BE-315: DAMM v2 positions in tee sweep (P3-ED-6)", () => {
  const DAMM = new PublicKey(DAMM_V2_PROGRAM_ID)
  const POOL = Keypair.generate().publicKey
  const POSITION = Keypair.generate().publicKey
  const NFT_MINT = Keypair.generate().publicKey
  const POOL_VAULT_A = Keypair.generate().publicKey
  const NFT_ACCOUNT = getAssociatedTokenAddressSync(NFT_MINT, teeKey.publicKey, false, SPL_TOKEN_2022)
  const TEE_ATA_A = getAssociatedTokenAddressSync(MINT, teeKey.publicKey, false, SPL_TOKEN)

  function tokenAccountFull(mint: PublicKey, owner: PublicKey, amount: bigint): Uint8Array {
    const data = new Uint8Array(165)
    data.set(mint.toBytes(), 0)
    data.set(owner.toBytes(), 32)
    new DataView(data.buffer).setBigUint64(64, amount, true)
    data[108] = 1
    return data
  }

  /** The chain with one open position: the NFT in the wallet, the pool's vault holding token A. */
  function positionAccounts(): RpcState["accounts"] {
    return {
      [TEE]: { owner: SYSTEM_PROGRAM_ID, data: new Uint8Array(0), lamports: 1_000_000 },
      [POOL.toBase58()]: { owner: DAMM_V2_PROGRAM_ID, data: new Uint8Array(100) },
      [POSITION.toBase58()]: { owner: DAMM_V2_PROGRAM_ID, data: new Uint8Array(100) },
      [MINT.toBase58()]: { owner: TOKEN_PROGRAM_ID, data: baseMint(6) },
      [NFT_MINT.toBase58()]: { owner: TOKEN_2022_PROGRAM_ID, data: baseMint(0) },
      [POOL_VAULT_A.toBase58()]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountFull(MINT, POOL, 5_000_000n) },
      [NFT_ACCOUNT.toBase58()]: {
        owner: TOKEN_2022_PROGRAM_ID,
        data: tokenAccountFull(NFT_MINT, teeKey.publicKey, 1n),
      },
    }
  }

  /** The honest simulation: NFT account and position gone, token A withdrawn into a new TEE ATA. */
  function honestSimulation(): NonNullable<RpcState["simulated"]> {
    return {
      [TEE]: { owner: SYSTEM_PROGRAM_ID, data: new Uint8Array(0), lamports: 3_000_000 },
      [POSITION.toBase58()]: null,
      [NFT_ACCOUNT.toBase58()]: null,
      [POOL_VAULT_A.toBase58()]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountFull(MINT, POOL, 4_300_000n) },
      [TEE_ATA_A.toBase58()]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountFull(MINT, teeKey.publicKey, 700_000n) },
    }
  }

  /** What close-build returns for this position: one unsigned v0 close and its keys in compiled order. */
  function closeArtifact(mutate?: (keys: string[]) => string[]) {
    const message = new TransactionMessage({
      payerKey: teeKey.publicKey,
      recentBlockhash: BLOCKHASH,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        createAssociatedTokenAccountIdempotentInstruction(teeKey.publicKey, TEE_ATA_A, teeKey.publicKey, MINT),
        new TransactionInstruction({
          programId: DAMM,
          data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
          keys: [
            { pubkey: teeKey.publicKey, isSigner: true, isWritable: true },
            { pubkey: POOL, isSigner: false, isWritable: true },
            { pubkey: POSITION, isSigner: false, isWritable: true },
            { pubkey: POOL_VAULT_A, isSigner: false, isWritable: true },
            { pubkey: TEE_ATA_A, isSigner: false, isWritable: true },
            { pubkey: NFT_ACCOUNT, isSigner: false, isWritable: true },
            { pubkey: NFT_MINT, isSigner: false, isWritable: true },
            { pubkey: MINT, isSigner: false, isWritable: false },
            { pubkey: SPL_TOKEN, isSigner: false, isWritable: false },
            { pubkey: SPL_TOKEN_2022, isSigner: false, isWritable: false },
          ],
        }),
      ],
    }).compileToV0Message()
    const keys = message.staticAccountKeys.map((key) => key.toBase58())
    return {
      transaction: Buffer.from(new VersionedTransaction(message).serialize()).toString("base64"),
      accountKeys: mutate ? mutate(keys) : keys,
    }
  }

  const candidate = () => ({
    pubkey: NFT_ACCOUNT.toBase58(),
    mint: NFT_MINT.toBase58(),
    amount: "1",
    decimals: 0,
    state: "initialized",
  })

  function positionState(overrides: Partial<RpcState> = {}): RpcState {
    const rpc = defaultRpcState({
      token2022Accounts: [candidate()],
      accounts: positionAccounts(),
      simulated: honestSimulation(),
      lamports: 1_000_000,
      fee: 5_000,
      ...overrides,
    })
    rpc.onClose = () => {
      rpc.token2022Accounts = rpc.token2022Accounts.filter((t) => t.pubkey !== NFT_ACCOUNT.toBase58())
      rpc.tokenAccounts.push({
        pubkey: TEE_ATA_A.toBase58(),
        mint: MINT.toBase58(),
        amount: "700000",
        decimals: 6,
        state: "initialized",
      })
    }
    return rpc
  }

  function sweptRoute(rpc: RpcState): RouteHandler {
    return () =>
      jsonResponse(200, { success: true, id: "lw_tee1", state: "swept", sweptAt: 1, signatures: rpc.sent.map(sigOf) })
  }

  test("ordinary quarantined sweep: local inventory, one close-build per candidate, verified, signed locally, then the withdrawn tokens and SOL", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const rpc = positionState()
    const closeBuilds: Array<{ method: string | undefined; auth: string | null; body: string }> = []
    const { fetch, calls, unmatched } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
      [`/api/v1/agent/lp/positions/${NFT_MINT.toBase58()}/close-build`]: (req) => {
        closeBuilds.push({
          method: req.init.method,
          auth: new Headers(req.init.headers).get("x-api-key"),
          body: String(req.init.body),
        })
        return jsonResponse(200, closeArtifact())
      },
      "/api/v1/agent/wallets/lw_tee1/swept": sweptRoute(rpc),
      "/rpc": rpcHandler(rpc),
    })
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], deps)).toBe(0)
    const parsed = JSON.parse(stdout.text.trim())

    // Close-build was called exactly once, for the NFT MINT in the path, with the bound key, and
    // no live positions listing was read (every unregistered route would be recorded here).
    expect(closeBuilds).toHaveLength(1)
    expect(closeBuilds[0]?.method).toBe("POST")
    expect(closeBuilds[0]?.auth).toBe("ck_live_x")
    expect(unmatched).toEqual([])
    expect(calls.map((c) => new URL(c.url).pathname).filter((p) => p.includes("/lp/positions"))).toEqual([
      `/api/v1/agent/lp/positions/${NFT_MINT.toBase58()}/close-build`,
    ])

    // Three transactions: the close (v0, signed by the TEE key), the withdrawn token A, then SOL.
    expect(rpc.sent).toHaveLength(3)
    const close = VersionedTransaction.deserialize(Buffer.from(rpc.sent[0] as string, "base64"))
    expect(close.version).toBe(0)
    expect(close.message.staticAccountKeys[0]?.toBase58()).toBe(TEE)
    expect(close.signatures).toHaveLength(1)
    expect(
      ed25519.verify(close.signatures[0] as Uint8Array, close.message.serialize(), teeKey.publicKey.toBytes()),
    ).toBe(true)
    // The close's message bytes are the server's, untouched.
    expect(Buffer.from(close.message.serialize()).toString("base64")).toBe(
      Buffer.from(
        VersionedTransaction.deserialize(Buffer.from(closeArtifact().transaction, "base64")).message.serialize(),
      ).toString("base64"),
    )
    const tokenTx = Transaction.from(Buffer.from(rpc.sent[1] as string, "base64"))
    expect(tokenTx.instructions.map((ix) => ix.programId.toBase58())).toContain(TOKEN_PROGRAM_ID)
    expect(parsed.receipts.map((r: { kind: string }) => r.kind)).toEqual(["lp-close", "token", "sol"])
    expect(parsed.residuals).toEqual([])

    // Simulation and every account read happened BEFORE the first send.
    const rpcMethods = calls
      .filter((c) => new URL(c.url).pathname === "/rpc")
      .map((c) => (JSON.parse(String(c.init.body)) as { method: string }).method)
    expect(rpcMethods.indexOf("simulateTransaction")).toBeLessThan(rpcMethods.indexOf("sendTransaction"))
  })

  test("raw amount 1 with decimals 6 is not a candidate: no close-build, swept as an ordinary Token-2022 token", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const source = getAssociatedTokenAddressSync(MINT_2022, teeKey.publicKey, false, SPL_TOKEN_2022)
    const rpc = defaultRpcState({
      token2022Accounts: [
        { pubkey: source.toBase58(), mint: MINT_2022.toBase58(), amount: "1", decimals: 6, state: "initialized" },
      ],
      accounts: mint2022(baseMint(6)),
    })
    const { fetch, unmatched } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
      "/api/v1/agent/wallets/lw_tee1/swept": sweptRoute(rpc),
      "/rpc": rpcHandler(rpc),
    })
    const { deps } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], deps)).toBe(0)
    expect(unmatched).toEqual([])
    const tx = Transaction.from(Buffer.from(rpc.sent[0] as string, "base64"))
    expect(tx.instructions[1]?.programId.toBase58()).toBe(TOKEN_2022_PROGRAM_ID)
    expect(tx.instructions[1]?.data[0]).toBe(12) // TransferChecked
  })

  test("an unknown decimals-0 mint (close-build 404) is leftover DAMM_POSITION_CLOSE_UNAVAILABLE, never transferred; a classic token and SOL still sweep", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const classic = getAssociatedTokenAddressSync(MINT, teeKey.publicKey)
    const rpc = positionState({
      tokenAccounts: [
        { pubkey: classic.toBase58(), mint: MINT.toBase58(), amount: "700000", decimals: 6, state: "initialized" },
      ],
    })
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
      [`/api/v1/agent/lp/positions/${NFT_MINT.toBase58()}/close-build`]: () =>
        jsonResponse(404, { success: false, error: { code: "LP_POSITION_NOT_FOUND", message: "Not a position NFT" } }),
      "/rpc": rpcHandler(rpc),
    })
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], deps)).toBe(3)
    const parsed = JSON.parse(stdout.text.trim())
    const leftover = parsed.residuals.find((r: { kind: string }) => r.kind === "DAMM_POSITION_CLOSE_UNAVAILABLE")
    expect(leftover).toMatchObject({ mint: NFT_MINT.toBase58(), account: NFT_ACCOUNT.toBase58(), amountRaw: "1" })
    expect(leftover.detail).toContain("LP_POSITION_NOT_FOUND")
    // Not reported a second time as a leftover token account, and never moved as a token.
    expect(parsed.residuals.filter((r: { account?: string }) => r.account === NFT_ACCOUNT.toBase58())).toHaveLength(1)
    for (const wire of rpc.sent) {
      for (const ix of instructionsOf(wire)) {
        expect(ix.programId.toBase58()).not.toBe(TOKEN_2022_PROGRAM_ID)
        expect(ix.programId.toBase58()).not.toBe(DAMM_V2_PROGRAM_ID)
      }
    }
    expect(parsed.receipts.map((r: { kind: string }) => r.kind)).toEqual(["token", "sol"])
  })

  test("a close that fails a check is leftover DAMM_CLOSE_TRANSACTION_REFUSED before it is signed, and the rest still sweeps", async () => {
    const cases: Array<{ name: string; artifact: () => unknown; state?: Partial<RpcState>; reason: RegExp }> = [
      {
        name: "permuted key array",
        artifact: () => closeArtifact((keys) => [...keys].reverse()),
        reason: /account key 0 is/,
      },
      {
        name: "simulation failure",
        artifact: () => closeArtifact(),
        state: { simulationErr: { InstructionError: [2, "Custom"] } },
        reason: /simulation failed/,
      },
      {
        name: "still-held NFT",
        artifact: () => closeArtifact(),
        state: {
          simulated: {
            ...honestSimulation(),
            [NFT_ACCOUNT.toBase58()]: {
              owner: TOKEN_2022_PROGRAM_ID,
              data: tokenAccountFull(NFT_MINT, teeKey.publicKey, 1n),
            },
          },
        },
        reason: /still holds 1/,
      },
      { name: "no transaction in the answer", artifact: () => ({ accountKeys: [] }), reason: /without a transaction/ },
    ]
    for (const { name, artifact, state, reason } of cases) {
      const dir = await tempDir()
      await seedTeeStore(dir, [enabledEntry()])
      const classic = getAssociatedTokenAddressSync(MINT, teeKey.publicKey)
      const rpc = positionState({
        tokenAccounts: [
          { pubkey: classic.toBase58(), mint: MINT.toBase58(), amount: "9", decimals: 6, state: "initialized" },
        ],
        ...state,
      })
      const { fetch } = createRoutedFetch({
        "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
        [`/api/v1/agent/lp/positions/${NFT_MINT.toBase58()}/close-build`]: () => jsonResponse(200, artifact()),
        "/rpc": rpcHandler(rpc),
      })
      const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
      expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], deps)).toBe(3)
      const parsed = JSON.parse(stdout.text.trim())
      const kind =
        name === "no transaction in the answer" ? "DAMM_POSITION_CLOSE_UNAVAILABLE" : "DAMM_CLOSE_TRANSACTION_REFUSED"
      const leftover = parsed.residuals.find((r: { kind: string }) => r.kind === kind)
      expect(`${name}: ${JSON.stringify(leftover ?? parsed.residuals)}`).toContain(`${name}: {`)
      expect(leftover.detail).toMatch(reason)
      expect(leftover.account).toBe(NFT_ACCOUNT.toBase58())
      // No DAMM transaction was ever signed or sent; the classic token and SOL still moved.
      for (const wire of rpc.sent)
        for (const ix of instructionsOf(wire)) expect(ix.programId.toBase58()).not.toBe(DAMM_V2_PROGRAM_ID)
      expect(parsed.receipts.map((r: { kind: string }) => r.kind)).toEqual(["token", "sol"])
    }
  })

  test("every artifact is fetched and verified before ANY close is signed: a refused second close does not undo the first, and the first is sent only after both were checked", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const OTHER_MINT = Keypair.generate().publicKey
    const OTHER_ACCOUNT = getAssociatedTokenAddressSync(OTHER_MINT, teeKey.publicKey, false, SPL_TOKEN_2022)
    const rpc = positionState({
      token2022Accounts: [
        candidate(),
        {
          pubkey: OTHER_ACCOUNT.toBase58(),
          mint: OTHER_MINT.toBase58(),
          amount: "1",
          decimals: 0,
          state: "initialized",
        },
      ],
    })
    rpc.accounts[OTHER_MINT.toBase58()] = { owner: TOKEN_2022_PROGRAM_ID, data: baseMint(0) }
    rpc.accounts[OTHER_ACCOUNT.toBase58()] = {
      owner: TOKEN_2022_PROGRAM_ID,
      data: tokenAccountFull(OTHER_MINT, teeKey.publicKey, 1n),
    }
    const { fetch, calls } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
      [`/api/v1/agent/lp/positions/${NFT_MINT.toBase58()}/close-build`]: () => jsonResponse(200, closeArtifact()),
      // The second position's close names the wrong fee payer: refused.
      [`/api/v1/agent/lp/positions/${OTHER_MINT.toBase58()}/close-build`]: () =>
        jsonResponse(
          200,
          closeArtifact((keys) => [...keys].reverse()),
        ),
      "/rpc": rpcHandler(rpc),
    })
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], deps)).toBe(3)
    const parsed = JSON.parse(stdout.text.trim())
    expect(parsed.receipts.map((r: { kind: string }) => r.kind)).toEqual(["lp-close", "token", "sol"])
    expect(parsed.residuals.map((r: { kind: string; mint?: string }) => [r.kind, r.mint])).toEqual([
      ["DAMM_CLOSE_TRANSACTION_REFUSED", OTHER_MINT.toBase58()],
    ])
    // Order: both close-builds, then the first send.
    const sequence = calls.map((c) => {
      const path = new URL(c.url).pathname
      if (path === "/rpc") return (JSON.parse(String(c.init.body)) as { method: string }).method
      return path
    })
    const lastFetch = Math.max(...sequence.map((step, i) => (step.endsWith("/close-build") ? i : -1)))
    expect(sequence.filter((step) => step.endsWith("/close-build"))).toHaveLength(2)
    expect(sequence.indexOf("sendTransaction")).toBeGreaterThan(lastFetch)
  })

  test("the verified close is displayed before it is signed, in human output and in the --json document", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const rpc = positionState()
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
      [`/api/v1/agent/lp/positions/${NFT_MINT.toBase58()}/close-build`]: () => jsonResponse(200, closeArtifact()),
      "/api/v1/agent/wallets/lw_tee1/swept": sweptRoute(rpc),
      "/rpc": rpcHandler(rpc),
    })
    const human = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC], human.deps)).toBe(0)
    const text = human.stdout.text
    const shown = text.indexOf(`Close for position ${NFT_MINT.toBase58()} (verified, unsigned; about to sign):`)
    expect(shown).toBeGreaterThan(-1)
    expect(text).toContain(`fee payer   ${TEE} (this TEE wallet)`)
    expect(text).toContain("program     Meteora DAMM v2")
    expect(text).toContain(`wallet      ${MINT.toBase58()}: 0 -> 700000 raw (+700000) in ${TEE_ATA_A.toBase58()}`)
    expect(text).toContain(`position    NFT account ${NFT_ACCOUNT.toBase58()} is closed by this transaction`)
    // Displayed BEFORE the receipt line for the same close.
    expect(shown).toBeLessThan(text.indexOf(`closed LP position ${NFT_MINT.toBase58()}`))

    const dir2 = await tempDir()
    await seedTeeStore(dir2, [enabledEntry()])
    const rpc2 = positionState()
    const routed = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
      [`/api/v1/agent/lp/positions/${NFT_MINT.toBase58()}/close-build`]: () => jsonResponse(200, closeArtifact()),
      "/api/v1/agent/wallets/lw_tee1/swept": sweptRoute(rpc2),
      "/rpc": rpcHandler(rpc2),
    })
    const json = depsFor(dir2, routed.fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], json.deps)).toBe(0)
    const parsed = JSON.parse(json.stdout.text.trim())
    expect(parsed.lpCloses).toHaveLength(1)
    expect(parsed.lpCloses[0]).toMatchObject({ mint: NFT_MINT.toBase58(), account: NFT_ACCOUNT.toBase58() })
    expect(parsed.lpCloses[0].display.some((line: string) => line.startsWith("program     Meteora DAMM v2"))).toBe(true)
  })

  test("a verified close whose blockhash has expired is leftover DAMM_POSITION_CLOSE_UNAVAILABLE without a signature, and tokens and SOL still sweep", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const classic = getAssociatedTokenAddressSync(MINT, teeKey.publicKey)
    const rpc = positionState({
      blockhashValid: false,
      tokenAccounts: [
        { pubkey: classic.toBase58(), mint: MINT.toBase58(), amount: "9", decimals: 6, state: "initialized" },
      ],
    })
    const { fetch, calls } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("quarantined")),
      [`/api/v1/agent/lp/positions/${NFT_MINT.toBase58()}/close-build`]: () => jsonResponse(200, closeArtifact()),
      "/rpc": rpcHandler(rpc),
    })
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--json"], deps)).toBe(3)
    const parsed = JSON.parse(stdout.text.trim())
    const leftover = parsed.residuals.find((r: { kind: string }) => r.kind === "DAMM_POSITION_CLOSE_UNAVAILABLE")
    expect(leftover.detail).toContain("blockhash has expired")
    // close-build's blockhash is taken at confirmed. Finalized would reject a fresh one.
    const blockhashChecks = calls
      .filter((call) => new URL(call.url).pathname === "/rpc")
      .map((call) => JSON.parse(String(call.init?.body)) as { method?: string; params?: unknown[] })
      .filter((body) => body.method === "isBlockhashValid")
    expect(blockhashChecks).toHaveLength(1)
    expect(blockhashChecks[0]?.params?.[1]).toEqual({ commitment: "confirmed" })
    expect(leftover.account).toBe(NFT_ACCOUNT.toBase58())
    for (const wire of rpc.sent)
      for (const ix of instructionsOf(wire)) expect(ix.programId.toBase58()).not.toBe(DAMM_V2_PROGRAM_ID)
    expect(parsed.receipts.map((r: { kind: string }) => r.kind)).toEqual(["token", "sol"])
    expect(parsed.pending).toEqual([])
  })

  test("--emergency with an open position: no API call at all, the NFT itself moves to the vault under Token-2022", async () => {
    const dir = await tempDir()
    await seedTeeStore(dir, [enabledEntry()])
    const rpc = positionState()
    const { fetch, calls } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_tee1/lifecycle": () => jsonResponse(200, LIFECYCLE("disable-pending")),
      "/rpc": rpcHandler(rpc),
    })
    const { deps, stdout } = depsFor(dir, fetch, [PASSPHRASE, VAULT.slice(-6)])
    expect(await run(["tee", "sweep", TEE, "--rpc-url", RPC, "--emergency"], deps)).toBe(3)
    expect(calls.map((c) => new URL(c.url).pathname).filter((p) => p.startsWith("/api/"))).toEqual([
      "/api/v1/agent/wallets/lw_tee1/lifecycle",
    ])
    const tx = Transaction.from(Buffer.from(rpc.sent[0] as string, "base64"))
    expect(tx.instructions[1]?.programId.toBase58()).toBe(TOKEN_2022_PROGRAM_ID)
    expect(tx.instructions[1]?.data[0]).toBe(12)
    expect(tx.instructions[1]?.keys[2]?.pubkey.toBase58()).toBe(
      getAssociatedTokenAddressSync(NFT_MINT, new PublicKey(VAULT), false, SPL_TOKEN_2022).toBase58(),
    )
    expect(stdout.text).toContain("position NFT moved as-is to the vault (emergency")
  })
})
