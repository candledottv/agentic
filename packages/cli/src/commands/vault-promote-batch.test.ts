/**
 * BE-285 (spec `2026-09-22-cli-vault-promote-batch-design.md`, §6): `candle vault promote-batch`.
 *
 * Fake API and fake RPC; real vault format, real unlock, real commits. The five tests the spec says
 * must exist before the rest -- T-P1, T-P8, T-U1, T-U3, T-R7 -- are the first five describes.
 * T-R1 (`vault promote` unchanged) is `vault-promote.test.ts` itself, passing untouched.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmod, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { sha256 } from "@noble/hashes/sha256"
import { base58, base64 } from "@scure/base"
import { Keypair } from "@solana/web3.js"
import type { Deps } from "../deps"
import { AUTHDATA_FLAG_UP, AUTHDATA_FLAG_UV, handleLine, RP_ID } from "../fido2-helper/protocol"
import { type BackendLogEntry, type HelperScript, scriptedBackend } from "../fido2-helper/test-backend"
import { run } from "../index"
import {
  createCapture,
  createFakeStore,
  createRoutedFetch,
  createTestDeps,
  jsonResponse,
  type RouteHandler,
} from "../test-support"
import { HELPER_ENV } from "../vault/fido2"
import type { KeyEntry } from "../vault/format"
import { wipe } from "../vault/hygiene"
import { formatSol, formatUsd, parsePairsFile, parseValueUsdCell, preflightBatch } from "../vault/promote-batch"
import { applyPromotion, confirmPrompt, promoteSentence, SENTENCE_PREFIX } from "../vault/promote-support"
import { REQUESTS_PER_KEY, ROLE_GROUP_IDS, STAKE_PROGRAM_ID } from "../vault/signer-roles"
import { closeVault, commitVault, decryptKey, unlockWithPassphrase } from "../vault/store"
import { generatedPassphraseFrom, makeVault, tempDir, useCheapKdf } from "../vault/test-vault"
import { setPromoteBatchObserver } from "./vault-promote-batch"

setDefaultTimeout(180_000)
useCheapKdf()

const ACCOUNT = "PBAccountABCDEFGH1234567890xyzabcd"
const USERNAME = "pb-operator"
const API = "https://api.pb.test"
/** A key in the server's shape (BE-296, D4): `cndl_live_` then 43 characters; the prefix is the first 8. */
const KEY_PREFIX = "pbpbpbpb"
const API_KEY = `cndl_live_${KEY_PREFIX.padEnd(43, "x")}`
const DEVICE_TOKEN = "dt_pb_device_token"
const KEY_LABEL = "vault-promote"
const RPC = "https://rpc.pb.test/rpc"
const SYSTEM_PROGRAM = "11111111111111111111111111111111"
const CLOCK = { now: () => Date.now(), sleep: async () => {} } as never

const ENCRYPTION_PUBLIC_KEY = await (async () => {
  const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  return Buffer.from(await crypto.subtle.exportKey("raw", receiver.publicKey)).toString("base64")
})()

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────────

interface Fixture {
  dir: string
  path: string
  passphrase: string
  /** Label -> address, for every key `keys` derived. */
  addresses: Record<string, string>
}

async function unreachable(): Promise<never> {
  throw new Error("no network in this step")
}

/** A real vault with one `role: "vault"` key per label, derived through `vault new-key`. */
async function fixture(labels: string[]): Promise<Fixture> {
  const made = await makeVault()
  closeVault(made.vault)
  const addresses: Record<string, string> = {}
  for (const label of labels) addresses[label] = await newKey(made.dir, made.passphrase, label)
  return { dir: made.dir, path: made.path, passphrase: made.passphrase, addresses }
}

async function newKey(dir: string, passphrase: string, label: string): Promise<string> {
  const out = createCapture()
  const err = createCapture()
  const deps = createTestDeps({
    fetch: unreachable as unknown as typeof fetch,
    stdout: out,
    stderr: err,
    env: { CANDLE_CONFIG_DIR: dir },
    promptSecret: async () => passphrase,
    promptLine: async () => "",
  })
  const code = await run(["vault", "new-key", "--chain", "solana", "--label", label], deps)
  if (code !== 0) throw new Error(`new-key ${label} failed: ${err.text}\n${out.text}`)
  return out.text.trim().split("\n")[0] as string
}

/** `--count n` under one unlock, for the 146-address read test. Label -> address, in allocation order. */
async function newKeys(dir: string, passphrase: string, count: number): Promise<Record<string, string>> {
  const out = createCapture()
  const err = createCapture()
  const deps = createTestDeps({
    fetch: unreachable as unknown as typeof fetch,
    stdout: out,
    stderr: err,
    env: { CANDLE_CONFIG_DIR: dir },
    promptSecret: async () => passphrase,
    promptLine: async () => "",
  })
  const code = await run(["vault", "new-key", "--chain", "solana", "--count", String(count)], deps)
  if (code !== 0) throw new Error(`new-key --count failed: ${err.text}\n${out.text}`)
  const addresses: Record<string, string> = {}
  for (const line of out.text.trim().split("\n")) {
    const [address, label] = line.split(/\s+/)
    if (address !== undefined && label !== undefined && label.startsWith("key-")) addresses[label] = address
  }
  return addresses
}

async function openVault(f: Fixture) {
  return unlockWithPassphrase(f.path, await readFile(f.path, "utf8"), f.passphrase)
}

async function readEntries(f: Fixture): Promise<{ generation: number; entries: KeyEntry[] }> {
  const v = await openVault(f)
  try {
    return { generation: v.file.generation, entries: v.index.entries }
  } finally {
    closeVault(v)
  }
}

/** Rewrites entries through the real write path, with none of the commands' guards. */
async function seed(f: Fixture, mutate: (entry: KeyEntry) => KeyEntry): Promise<void> {
  const v = await openVault(f)
  try {
    await commitVault(v, { index: { hd: v.index.hd, entries: v.index.entries.map(mutate) } }, CLOCK)
  } finally {
    closeVault(v)
  }
}

const teeSeed = (
  lifecycle: "import-pending" | "local-candidate" | "enabled" | "stranded",
  vaultDestination: string | undefined,
  opts: { grant?: boolean; linked?: boolean } = {},
) =>
  ({
    role: "tee-wallet" as const,
    exposure: { everRemoteExposed: true, everExported: false },
    ...(opts.linked ? { linkedWalletId: "lw_seeded" } : {}),
    tee: {
      network: "solana-mainnet" as const,
      lifecycle,
      ...(vaultDestination !== undefined ? { vaultDestination } : {}),
      ...(lifecycle === "enabled" ? { remoteAuthority: "verified-active" as const, boundKeyPrefix: "ck_seed" } : {}),
      ...(opts.grant
        ? { grantIdentity: { account: ACCOUNT, apiBaseUrl: API, source: "recorded-at-operation" as const } }
        : {}),
    },
  }) as const

async function pairsFile(dir: string, contents: string, name = "promote-plan.txt"): Promise<string> {
  const file = join(dir, name)
  await writeFile(file, contents, "utf8")
  return file
}

// ── Fake API and RPC ───────────────────────────────────────────────────────────────────────────

interface RpcCounts {
  getMultipleAccounts: number
  getTokenAccountsByOwner: number
  getProgramAccounts: number
}

/** One `getProgramAccounts` as the fake sees it (BE-296): the program, its filters, and the request's own signal. */
interface ProgramAccountsCall {
  programId: string
  filters: Array<{ dataSize?: number; memcmp?: { offset: number; bytes: string; encoding: string } }>
  signal?: AbortSignal
  n: number
}

function rpcHandler(opts: {
  counts: RpcCounts
  lamports?: number
  failMultiple?: boolean
  /** Answers a `getProgramAccounts` (BE-296): a Response to override, or a pubkey list; default `[]`. */
  programAccounts?: (call: ProgramAccountsCall) => Response | string[] | undefined
}): RouteHandler {
  return async (req) => {
    const body = typeof req.init.body === "string" ? JSON.parse(req.init.body) : {}
    const method = body.method as keyof RpcCounts
    if (method in opts.counts) opts.counts[method] += 1
    if (method === "getProgramAccounts") {
      const answer = opts.programAccounts?.({
        programId: body.params[0] as string,
        filters: (body.params[1] as { filters: ProgramAccountsCall["filters"] }).filters,
        ...(req.init.signal ? { signal: req.init.signal } : {}),
        n: opts.counts.getProgramAccounts,
      })
      if (answer instanceof Response) return answer
      return jsonResponse(200, {
        jsonrpc: "2.0",
        id: body.id,
        result: (answer ?? []).map((pubkey) => ({ pubkey, account: { data: ["", "base64"] } })),
      })
    }
    if (method === "getMultipleAccounts") {
      if (opts.failMultiple) return jsonResponse(500, { error: "rate limited" })
      const addresses = body.params[0] as string[]
      return jsonResponse(200, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          value: addresses.map(() => ({
            owner: SYSTEM_PROGRAM,
            lamports: opts.lamports ?? 21_400_000,
            data: ["", "base64"],
          })),
        },
      })
    }
    if (method === "getTokenAccountsByOwner") {
      return jsonResponse(200, { jsonrpc: "2.0", id: body.id, result: { value: [] } })
    }
    return jsonResponse(200, { jsonrpc: "2.0", id: body.id, result: null })
  }
}

interface ApiOptions {
  /** Called for every import/submit, in order. Return a Response to override the default success. */
  submit?: (n: number, body: Record<string, unknown>) => Response | undefined
  /** Called for every import/init, in order (BE-288). Return a Response to override the default success. */
  init?: (n: number, body: Record<string, unknown>) => Response | undefined
  /** `GET /agent/wallets/room` (BE-288, D7). Default: a Max account with every slot free. */
  room?: RouteHandler
  /** The linked-wallet listing(s): one handler, or one per call in order. */
  wallets?: RouteHandler | RouteHandler[]
  remoteAuthority?: string | ((address: string) => string)
  failures?: unknown[]
  /** `GET /agent/wallets/embedded` (BE-296, D5). Default: `ACCOUNT` with `USERNAME`. */
  embedded?: RouteHandler
  /** `GET /agent/keys` (BE-296, D4). Default: one row whose `keyPrefix` is this key's, labelled `KEY_LABEL`. */
  keys?: RouteHandler
}

function apiRoutes(
  opts: ApiOptions,
  submits: { n: number; addresses: string[] },
  inits: { n: number },
): Record<string, RouteHandler | RouteHandler[]> {
  return {
    "/api/v1/agent/wallets/room":
      opts.room ?? (() => jsonResponse(200, { success: true, tier: "max", active: 0, cap: 1000, room: 1000 })),
    "/api/v1/agent/wallets/import/init": async (req) => {
      inits.n += 1
      const body = (typeof req.init.body === "string" ? JSON.parse(req.init.body) : {}) as Record<string, unknown>
      const override = opts.init?.(inits.n, body)
      if (override !== undefined) return override
      return jsonResponse(200, { success: true, encryptionPublicKey: ENCRYPTION_PUBLIC_KEY })
    },
    "/api/v1/agent/wallets/import/submit": async (req) => {
      submits.n += 1
      const body = (typeof req.init.body === "string" ? JSON.parse(req.init.body) : {}) as Record<string, unknown>
      submits.addresses.push(body.address as string)
      const override = opts.submit?.(submits.n, body)
      if (override !== undefined) return override
      const address = body.address as string
      return jsonResponse(200, {
        success: true,
        id: `lw_${address.slice(0, 6)}`,
        address,
        chain: "solana",
        privyWalletId: `pw_${address.slice(0, 6)}`,
        profile: "ember-tee",
        boundKeyPrefix: "ck_live_p",
        vaultDestination: body.vaultDestination,
        remoteAuthority:
          typeof opts.remoteAuthority === "function"
            ? opts.remoteAuthority(address)
            : (opts.remoteAuthority ?? "verified-active"),
      })
    },
    "/api/v1/agent/wallets/embedded":
      opts.embedded ?? (() => jsonResponse(200, { success: true, account: ACCOUNT, username: USERNAME })),
    "/api/v1/agent/keys":
      opts.keys ??
      (() =>
        jsonResponse(200, {
          keys: [
            { keyPrefix: "otherkey", scopes: ["read"], environment: "production", createdAt: 1, label: "not this one" },
            {
              keyPrefix: KEY_PREFIX,
              scopes: ["read", "trade"],
              environment: "production",
              createdAt: 2,
              label: KEY_LABEL,
            },
          ],
        })),
    "/api/v1/agent/wallets": opts.wallets ?? (() => jsonResponse(200, { page: [], isDone: true })),
    "/api/v1/agent/wallets/import-failures": () =>
      jsonResponse(200, { success: true, account: ACCOUNT, failures: opts.failures ?? [], complete: true }),
  }
}

const grantedWallets =
  (rows: Array<{ address: string; vaultDestination?: string }>): RouteHandler =>
  () =>
    jsonResponse(200, {
      page: rows.map((row) => ({
        _id: `lw_g_${row.address.slice(0, 6)}`,
        address: row.address,
        chain: "solana",
        ...(row.vaultDestination !== undefined ? { vaultDestination: row.vaultDestination } : {}),
        boundKeyPrefix: "ck_g",
        remoteAuthority: "verified-active",
      })),
      isDone: true,
    })

// ── Running the command ────────────────────────────────────────────────────────────────────────

interface RunOptions {
  file: string
  args?: string[]
  /** Visible-prompt answers, in order. The acknowledgement is the only one the batch asks for. */
  lines?: string[]
  /** `"correct"` types `confirm` at the acknowledgement. */
  ack?: "correct"
  api?: ApiOptions
  rpc?: {
    lamports?: number
    failMultiple?: boolean
    programAccounts?: (call: ProgramAccountsCall) => Response | string[] | undefined
  }
  json?: boolean
  tty?: boolean
  env?: Record<string, string>
  deps?: Partial<Deps>
  /** No cached account on the profile (a grant-less resume then has nothing to assert). */
  noAccount?: boolean
  /** A device token in the store (BE-296, D4): only then is the key's label read. */
  deviceToken?: boolean
  /** No API key in the store (BE-296, D5). */
  noApiKey?: boolean
}

interface Outcome {
  code: number
  out: string
  err: string
  secretPrompts: number
  linePrompts: string[]
  /** stdout as it stood when each visible prompt was asked. */
  stdoutAtPrompt: string[]
  /** stderr as it stood when each visible prompt was asked. */
  stderrAtPrompt: string[]
  /** Every request the fake fetch saw, in order. */
  calls: Array<{ url: string; init: RequestInit }>
  rpc: RpcCounts
  submits: { n: number; addresses: string[] }
  inits: { n: number }
  deps: Deps
}

async function runBatch(f: Fixture, opts: RunOptions): Promise<Outcome> {
  const out = createCapture()
  const err = createCapture()
  const counts: RpcCounts = { getMultipleAccounts: 0, getTokenAccountsByOwner: 0, getProgramAccounts: 0 }
  const submits = { n: 0, addresses: [] as string[] }
  const inits = { n: 0 }
  const { fetch, calls } = createRoutedFetch({
    ...apiRoutes(opts.api ?? {}, submits, inits),
    "/rpc": rpcHandler({ counts, ...(opts.rpc ?? {}) }),
  })
  const lines = [...(opts.lines ?? [])]
  const linePrompts: string[] = []
  const stdoutAtPrompt: string[] = []
  const stderrAtPrompt: string[] = []
  let secretPrompts = 0
  const deps = createTestDeps({
    fetch,
    store: createFakeStore({
      ...(opts.noApiKey ? {} : { "profile:pb:api_key": API_KEY }),
      ...(opts.deviceToken ? { "profile:pb:device_token": DEVICE_TOKEN } : {}),
    }),
    stdout: out,
    stderr: err,
    env: { CANDLE_CONFIG_DIR: f.dir, CANDLE_API_URL: API, ...(opts.env ?? {}) },
    isTTY: { stdin: opts.tty ?? true, stdout: opts.tty ?? true, stderr: opts.tty ?? true },
    promptSecret: async () => {
      secretPrompts += 1
      return f.passphrase
    },
    promptLine: async (text: string) => {
      linePrompts.push(text)
      stdoutAtPrompt.push(out.text)
      stderrAtPrompt.push(err.text)
      if (opts.ack === "correct" && text.startsWith("Type confirm")) return "confirm"
      return lines.shift() ?? ""
    },
    readFile: (path) => readFile(path, "utf8"),
    writeFile: (path, content) => writeFile(path, content, "utf8"),
    ...(opts.deps ?? {}),
  })
  await deps.writeConfig({
    activeProfile: "pb",
    profiles: { pb: { ...(opts.noAccount ? {} : { account: ACCOUNT }), apiUrl: API, accountCachedAt: Date.now() } },
  })
  const code = await run(
    [
      "vault",
      "promote-batch",
      "--pairs-from",
      opts.file,
      "--rpc-url",
      RPC,
      ...(opts.args ?? []),
      ...(opts.json ? ["--json"] : []),
    ],
    deps,
  )
  return {
    code,
    out: out.text,
    err: err.text,
    secretPrompts,
    linePrompts,
    stdoutAtPrompt,
    stderrAtPrompt,
    calls,
    rpc: counts,
    submits,
    inits,
    deps,
  }
}

/** stdout with the one sentence (the inherited exception, §1.2 of BE-296) removed: what must be exactly one JSON value. */
function jsonDocuments(out: string): string[] {
  return out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => !line.startsWith(SENTENCE_PREFIX))
}

/** The D4 block as this harness's fixture renders it: profile `pb`, the URL from CANDLE_API_URL, no Candle host. */
function controlledByBlock(n: number, opts: { label?: string; username?: string | null } = {}): string {
  const subject = n === 1 ? "This key" : `These ${n} keys`
  const label = opts.label !== undefined ? `(${opts.label})  ` : ""
  const username = opts.username === null ? "(no username)" : (opts.username ?? USERNAME)
  return [
    `${subject} will be controlled by:`,
    `  Candle account  ${username}  (${ACCOUNT.slice(0, 6)}…${ACCOUNT.slice(-4)})`,
    `  API key         ${KEY_PREFIX}…  ${label}profile pb`,
    `  API             ${API}  (not a Candle host, from CANDLE_API_URL)`,
  ].join("\n")
}

function batchRefusal(o: Outcome): { rows: Array<Record<string, string | number>>; message: string } {
  const docs = jsonDocuments(o.out)
  expect(docs).toHaveLength(1)
  const body = JSON.parse(docs[0] as string)
  expect(body.ok).toBe(false)
  expect(body.code).toBe("PROMOTE_BATCH_REFUSED")
  return body
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The five that must exist first.
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("T-P1: the named failure, a destination this file promotes", () => {
  test("row 3 sweeps to the key row 2 promotes: refused before any commit, row 2 is not a failure line", async () => {
    const f = await fixture(["a", "q1", "b", "d1"])
    const before = await readEntries(f)
    const file = await pairsFile(f.dir, "a d1\nq1 d1\nb q1\n")
    const o = await runBatch(f, { file, json: true })
    expect(o.code).toBe(1)
    const body = batchRefusal(o)
    expect(body.message).toBe("1 of 3 rows cannot run; nothing was written.")
    expect(body.rows).toEqual([
      {
        line: 3,
        label: "b",
        destination: "q1",
        code: "PROMOTE_DESTINATION_NOT_COLD",
        message: "No vault key matches q1.",
        why: "q1 is promoted by row 2 of this file.",
      },
    ])
    // Zero writes: same generation, nothing moved to tee-wallet.
    const after = await readEntries(f)
    expect(after.generation).toBe(before.generation)
    expect(after.entries.every((e) => e.role === "vault" && e.tee === undefined)).toBe(true)
    expect(o.submits.n).toBe(0)
    expect(o.linePrompts).toEqual([])
  })

  test("the human rendering is the same report: a table on stderr and the continuation sentence", async () => {
    const f = await fixture(["a", "q1", "b", "d1"])
    const file = await pairsFile(f.dir, "a d1\nq1 d1\nb q1\n")
    const o = await runBatch(f, { file })
    expect(o.code).toBe(1)
    expect(o.err).toContain("This batch was refused and NOTHING was written. 1 of 3 rows cannot run:")
    expect(o.err).toContain("PROMOTE_DESTINATION_NOT_COLD")
    expect(o.err).toContain("No vault key matches q1. q1 is promoted by row 2 of this file.")
    expect(o.err).toContain("Each row was checked against the vault as it will be when the rows above it have run")
    expect(o.err).toContain("the next run re-checks all 3")
    // No sentence and no table on a refusal: nothing to acknowledge (D8, point 1).
    expect(o.out).not.toContain(SENTENCE_PREFIX)
    expect(o.err).not.toContain("value_usd")
  })
})

describe("T-P8: the check that today runs after the commit", () => {
  test("a stored secret that does not match its address is refused before any commitVault", async () => {
    const f = await fixture(["a", "b", "d1"])
    // A blob that decrypts to a different key than the index claims: the index says `b` is at a
    // fresh keypair's address, the blob under its id is still the derived secret.
    const impostor = Keypair.generate().publicKey.toBase58()
    await seed(f, (e) => (e.label === "b" ? { ...e, address: impostor } : e))
    const before = await readEntries(f)
    const file = await pairsFile(f.dir, `a d1\nb d1\n`)
    const o = await runBatch(f, { file, json: true })
    expect(o.code).toBe(1)
    const body = batchRefusal(o)
    expect(body.rows).toEqual([
      {
        line: 2,
        label: "b",
        destination: "d1",
        code: "VAULT_VERIFY_FAILED",
        message: "Stored secret does not match the subject address.",
      },
    ])
    const after = await readEntries(f)
    expect(after.generation).toBe(before.generation)
    expect(after.entries.some((e) => e.tee?.lifecycle === "import-pending")).toBe(false)
    expect(o.submits.n).toBe(0)
  })
})

/** The scripted security key, as `vault-security-key.test.ts` drives it, in process. */
const PIN = "482913"
const HMAC_SECRET = base64.encode(new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff))
const CRED = base64.encode(new Uint8Array(48).map((_, i) => (i * 7 + 3) & 0xff))
const AAGUID = "2fc0579f811347eab116bb5a8db9202a"
function authDataFor(rpId: string, flags: number): string {
  const out = new Uint8Array(37)
  out.set(sha256(new TextEncoder().encode(rpId)), 0)
  out[32] = flags
  return base64.encode(out)
}
function keyScript(): HelperScript {
  return {
    devices: [
      {
        path: "/dev/hidraw3",
        product: "YubiKey 5 NFC",
        manufacturer: "Yubico",
        aaguid: AAGUID,
        extensions: ["hmac-secret", "credProtect"],
        options: { rk: true, clientPin: true, uv: false },
      },
    ],
    register: { credentialId: CRED, aaguid: AAGUID, authData: authDataFor(RP_ID, AUTHDATA_FLAG_UP | AUTHDATA_FLAG_UV) },
    assert: { hmacSecret: HMAC_SECRET, authData: authDataFor(RP_ID, AUTHDATA_FLAG_UP | AUTHDATA_FLAG_UV) },
  }
}

/** A vault whose passphrase factor has a scripted security key beside it. */
async function keyFixture(
  labels: string[],
): Promise<Fixture & { calls: BackendLogEntry[]; keyDeps: (opts: { secrets: string[] }) => Partial<Deps> }> {
  const dir = await tempDir("candle-pb-key-")
  const helper = join(dir, "candle-fido2")
  await writeFile(helper, "#!/bin/sh\nexit 1\n")
  await chmod(helper, 0o755)
  const calls: BackendLogEntry[] = []
  const script = keyScript()
  const spawnHelper: Deps["spawnHelper"] = async (_path, line) => {
    const response = handleLine(line, () => scriptedBackend(script, (entry) => calls.push(entry)))
    return { stdout: `${JSON.stringify(response)}\n`, stderr: "", exitCode: response.ok ? 0 : 1, signal: null }
  }
  const env = { CANDLE_CONFIG_DIR: dir, HOME: dir, [HELPER_ENV]: helper }
  const keyDeps = (opts: { secrets: string[] }): Partial<Deps> => {
    const secrets = [...opts.secrets]
    return {
      env: { ...env, CANDLE_API_URL: API },
      platform: "linux",
      arch: "x64",
      spawnHelper,
      promptSecret: async () => {
        const next = secrets.shift()
        if (next === undefined) throw new Error("promptSecret asked for more than the test scripted")
        return next
      },
    }
  }
  // init: Enter at the passphrase choice, Enter to acknowledge the words, "no" at the phrase ceremony.
  const init = createTestDeps({
    fetch: unreachable as unknown as typeof fetch,
    env,
    platform: "linux",
    arch: "x64",
    spawnHelper,
    promptLine: (() => {
      const lines = ["", "", "no"]
      return async () => lines.shift() ?? ""
    })(),
    promptSecret: async () => {
      throw new Error("init asks for no secret")
    },
  })
  const initOut = init.stdout as ReturnType<typeof createCapture>
  const initCode = await run(["vault", "init"], init)
  if (initCode !== 0) throw new Error(`init failed: ${(init.stderr as ReturnType<typeof createCapture>).text}`)
  const passphrase = generatedPassphraseFrom(initOut.text)
  const add = createTestDeps({
    fetch: unreachable as unknown as typeof fetch,
    ...keyDeps({ secrets: [PIN, passphrase] }),
    promptLine: async () => "",
  })
  const addCode = await run(["vault", "factor", "add", "security-key", "--label", "desk key"], add)
  if (addCode !== 0) throw new Error(`factor add failed: ${(add.stderr as ReturnType<typeof createCapture>).text}`)
  calls.length = 0
  const addresses: Record<string, string> = {}
  for (const label of labels) {
    const out = createCapture()
    const deps = createTestDeps({
      fetch: unreachable as unknown as typeof fetch,
      stdout: out,
      env,
      promptSecret: async () => passphrase,
      promptLine: async () => "",
    })
    const code = await run(["vault", "new-key", "--chain", "solana", "--label", label, "--factor", "passphrase"], deps)
    if (code !== 0) throw new Error(`new-key ${label} failed`)
    addresses[label] = out.text.trim().split("\n")[0] as string
  }
  return { dir, path: join(dir, "vault.enc"), passphrase, addresses, calls, keyDeps }
}

describe("T-U1: one unlock is real", () => {
  test("a 5-row batch against the scripted security key receives exactly two assertions", async () => {
    const f = await keyFixture(["a", "b", "c", "d", "e", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\nc cold\nd cold\ne cold\n")
    const o = await runBatch(f, {
      file,
      ack: "correct",
      args: ["--factor", "security-key"],
      deps: f.keyDeps({ secrets: [PIN] }),
    })
    expect(o.err + o.out).not.toContain("Error")
    expect(o.code).toBe(0)
    expect(o.submits.n).toBe(5)
    // The unlock, and the single end-of-run factor re-open. Not 2 to 3 per key.
    expect(f.calls.map((call) => call.op)).toEqual(["assert", "assert"])
    const after = await readEntries(f)
    expect(after.entries.filter((e) => e.tee?.lifecycle === "enabled")).toHaveLength(5)
  })
})

describe("T-U3: the shared DEK survives row 1", () => {
  test("after row 1's import commit the batch's DEK is not zeroed, and row 2 commits", async () => {
    const f = await fixture(["a", "b", "c", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\nc cold\n")
    const seen: Array<{ line: number; stage: string; dekIntact: boolean }> = []
    setPromoteBatchObserver(({ line, stage, vault }) => {
      seen.push({ line, stage, dekIntact: vault.dek.some((byte) => byte !== 0) })
    })
    try {
      const o = await runBatch(f, { file, ack: "correct" })
      expect(o.code).toBe(0)
    } finally {
      setPromoteBatchObserver(null)
    }
    // `closeVault` at `vault-promote.ts`'s `finally` wipes `dek`; a decrypt-only check would miss
    // it because `payloadKey` survives. The bytes are the assertion.
    expect(seen.filter((s) => s.stage === "imported").map((s) => [s.line, s.dekIntact])).toEqual([
      [1, true],
      [2, true],
      [3, true],
    ])
    const after = await readEntries(f)
    expect(
      after.entries
        .filter((e) => e.tee?.lifecycle === "enabled")
        .map((e) => e.label)
        .sort(),
    ).toEqual(["a", "b", "c"])
  })
})

describe("T-R7: resume rows are reconciled in Phase B, and never prompt in the loop", () => {
  test("a local-candidate whose server destination differs from the file is refused with zero writes", async () => {
    const f = await fixture(["a", "lc", "d1", "d2"])
    await seed(f, (e) => (e.label === "lc" ? { ...e, ...teeSeed("local-candidate", undefined) } : e))
    const before = await readEntries(f)
    const file = await pairsFile(f.dir, "a d1\nlc d1\n")
    const o = await runBatch(f, {
      file,
      json: true,
      api: { wallets: grantedWallets([{ address: f.addresses.lc as string, vaultDestination: f.addresses.d2 }]) },
    })
    expect(o.code).toBe(1)
    const body = batchRefusal(o)
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0]).toMatchObject({ line: 2, label: "lc", code: "GRANT_BINDING_MISMATCH" })
    expect(String(body.rows[0]?.message)).toContain(f.addresses.d2 as string)
    expect(String(body.rows[0]?.message)).toContain(f.addresses.d1 as string)
    expect((await readEntries(f)).generation).toBe(before.generation)
    expect(o.linePrompts).toEqual([])
  })

  test("a matching resume with no grantIdentity prints the account once in the footer and does not prompt for it", async () => {
    const f = await fixture(["a", "ip", "d1"])
    await seed(f, (e) => (e.label === "ip" ? { ...e, ...teeSeed("import-pending", f.addresses.d1) } : e))
    const file = await pairsFile(f.dir, "a d1\nip d1\n")
    const o = await runBatch(f, {
      file,
      ack: "correct",
      api: { wallets: grantedWallets([{ address: f.addresses.ip as string, vaultDestination: f.addresses.d1 }]) },
    })
    expect(o.code).toBe(0)
    const footerLine = `Resume rows with no grant identity assert this profile's account ${ACCOUNT} (…${ACCOUNT.slice(-6)}).`
    expect(o.err.split(footerLine)).toHaveLength(2)
    // One visible prompt for the whole run: the acknowledgement. No `confirmLastSix` for the
    // account, none for the destination, and no grant block on stdout.
    expect(o.linePrompts).toEqual([confirmPrompt(2)])
    expect(o.out).not.toContain("Server grant for")
    expect(o.out).not.toContain("This profile acts as account")
    expect(o.submits.n).toBe(1)
    const after = await readEntries(f)
    const ip = after.entries.find((e) => e.label === "ip")
    expect(ip?.tee?.lifecycle).toBe("enabled")
    expect(ip?.tee?.grantIdentity?.account).toBe(ACCOUNT)
    expect(ip?.linkedWalletId).toBe(`lw_g_${(f.addresses.ip as string).slice(0, 6)}`)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The rest of the matrix.
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("T-P2: the projection and the loop agree", () => {
  test("each promote row's pre-import write is byte-equal to the projected entry, and hd matches at the end", async () => {
    const f = await fixture(["a", "b", "c", "cold"])
    const v = await openVault(f)
    let projected: Awaited<ReturnType<typeof preflightBatch>>
    try {
      projected = await preflightBatch(
        v.index,
        [
          { line: 1, label: "a", destination: "cold" },
          { line: 2, label: "b", destination: "cold" },
          { line: 3, label: "c", destination: "cold" },
        ],
        {
          acceptUnknownExposure: false,
          now: new Date(0).toISOString(),
          verifySubject: async () => {},
          reconcileResume: async () => {
            throw new Error("no resume row here")
          },
        },
      )
    } finally {
      closeVault(v)
    }
    expect(projected.failures).toEqual([])
    const file = await pairsFile(f.dir, "a cold\nb cold\nc cold\n")
    const written: Array<{ line: number; entry: KeyEntry | undefined }> = []
    setPromoteBatchObserver(async ({ line, stage }) => {
      if (stage !== "pre-import") return
      // Read the DISK, not the object: the guarantee is about the file.
      const onDisk = await openVault(f)
      try {
        const label = ["a", "b", "c"][line - 1] as string
        written.push({ line, entry: onDisk.index.entries.find((e) => e.label === label) })
      } finally {
        closeVault(onDisk)
      }
    })
    let o: Outcome
    try {
      // The fake clock starts at 0 and nothing sleeps, so `now` is the same instant the projection used.
      o = await runBatch(f, { file, ack: "correct" })
    } finally {
      setPromoteBatchObserver(null)
    }
    expect(o.code).toBe(0)
    expect(written).toHaveLength(3)
    for (const { line, entry } of written) {
      const label = ["a", "b", "c"][line - 1] as string
      const projectedEntry = projected.projection.entries.find((e) => e.label === label)
      expect(JSON.stringify(entry)).toBe(JSON.stringify(projectedEntry))
      expect(entry?.tee?.lifecycle).toBe("import-pending")
    }
    const after = await readEntries(f)
    const v2 = await openVault(f)
    try {
      expect(v2.index.hd.exposedIndexes).toEqual(projected.projection.hd.exposedIndexes)
    } finally {
      closeVault(v2)
    }
    expect(after.entries.filter((e) => e.tee?.lifecycle === "enabled")).toHaveLength(3)
  })
})

describe("T-P3, T-P4: pins and the continuation rule", () => {
  test("T-P3: a subject an earlier row sweeps to is refused as pinned, before any commit; the earlier row is not a failure line", async () => {
    const f = await fixture(["a", "p3", "d1"])
    const before = await readEntries(f)
    const file = await pairsFile(f.dir, "a p3\np3 d1\n")
    const o = await runBatch(f, { file, json: true })
    expect(o.code).toBe(1)
    const body = batchRefusal(o)
    expect(body.rows).toEqual([
      {
        line: 2,
        label: "p3",
        destination: "d1",
        code: "PROMOTE_KEY_IS_PINNED_DESTINATION",
        message: `${f.addresses.p3} is the pinned sweep destination for: a.`,
        why: "Row 1 of this file sweeps to p3.",
      },
    ])
    expect((await readEntries(f)).generation).toBe(before.generation)
  })

  test("T-P4: a refused row is not projected, so a later row that sweeps to its subject passes and is not reported", async () => {
    const f = await fixture(["q1", "b", "d1"])
    const file = await pairsFile(f.dir, "q1 nowhere\nb q1\n")
    const o = await runBatch(f, { file, json: true })
    expect(o.code).toBe(1)
    const body = batchRefusal(o)
    expect(body.rows.map((row) => row.line)).toEqual([1])
    expect(body.rows[0]).toMatchObject({
      code: "PROMOTE_DESTINATION_NOT_COLD",
      message: "No vault key matches nowhere.",
    })
    expect(body.rows[0]?.why).toBeUndefined()
    const human = await runBatch(f, { file })
    expect(human.err).toContain("every row that fails on that basis")
  })
})

describe("T-P9: no recoverable factor", () => {
  test("refused with the shipped VAULT_NO_RECOVERABLE_FACTOR before the table, zero writes", async () => {
    const f = await keyFixture(["a", "b", "cold"])
    // Leave only the hardware envelope, through the real write path.
    const v = await unlockWithPassphrase(f.path, await readFile(f.path, "utf8"), f.passphrase)
    try {
      await commitVault(
        v,
        { index: v.index, envelopes: v.file.envelopes.filter((e) => e.factor !== "passphrase") },
        CLOCK,
      )
    } finally {
      closeVault(v)
    }
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, {
      file,
      json: true,
      args: ["--factor", "security-key"],
      deps: f.keyDeps({ secrets: [PIN] }),
    })
    expect(o.code).toBe(1)
    const docs = jsonDocuments(o.out)
    expect(docs).toHaveLength(1)
    expect(JSON.parse(docs[0] as string)).toMatchObject({ ok: false, code: "VAULT_NO_RECOVERABLE_FACTOR" })
    expect(o.err).not.toContain("state")
    expect(o.submits.n).toBe(0)
    expect(o.linePrompts).toEqual([])
  })
})

describe("T-P5, T-P6, T-P7: Phase A, before the unlock", () => {
  test("T-P5: a malformed file refuses with exit 2 and promptSecret was never called", async () => {
    const f = await fixture(["a", "cold"])
    const file = await pairsFile(f.dir, "a\ncold\n")
    const o = await runBatch(f, { file, json: true })
    expect(o.code).toBe(2)
    expect(o.secretPrompts).toBe(0)
    expect(JSON.parse(o.out)).toMatchObject({ ok: false, code: "USAGE" })
    expect(String(JSON.parse(o.out).message)).toContain("nothing was unlocked")
  })

  test("T-P6: every malformed line is named together, not the first", async () => {
    const f = await fixture(["a", "cold"])
    const file = await pairsFile(f.dir, "a cold\nlonely\nb cold extra\n\n# comment\nc\n")
    const o = await runBatch(f, { file })
    expect(o.code).toBe(2)
    expect(o.err).toContain(`${file}: 3 lines cannot be used, and nothing was unlocked.`)
    expect(o.err).toContain(`line 2   only one field; a row is "<label> <destination>"`)
    expect(o.err).toContain(`line 3   3 fields; a row is "<label> <destination>"`)
    expect(o.err).toContain(`line 6   only one field`)
    expect(o.secretPrompts).toBe(0)
  })

  test("T-P7: duplicate label, order out of sequence, 257 rows, and a single row are each refused before the unlock", async () => {
    const f = await fixture(["a", "cold"])
    const dup = await runBatch(f, { file: await pairsFile(f.dir, "a cold\nb cold\na cold\n", "dup.txt") })
    expect(dup.code).toBe(2)
    expect(dup.err).toContain("line 1   label a appears again on line 3")

    const order = await runBatch(f, {
      file: await pairsFile(f.dir, "order,label,sweep_to\n51,a,cold\n44,b,cold\n", "order.csv"),
    })
    expect(order.code).toBe(2)
    expect(order.err).toContain(
      "line 3   order 44 is not greater than the previous row's 51; the file's line order is what runs",
    )

    const many = Array.from({ length: 257 }, (_, i) => `k${i} cold`).join("\n")
    const cap = await runBatch(f, { file: await pairsFile(f.dir, `${many}\n`, "cap.txt") })
    expect(cap.code).toBe(2)
    expect(cap.err).toContain("holds 257 rows; a batch is capped at 256")

    const one = await runBatch(f, { file: await pairsFile(f.dir, "a cold\n", "one.txt") })
    expect(one.code).toBe(2)
    expect(one.err).toContain(`Run: candle vault promote --in-place a --sweep-to cold --rpc-url ${RPC}`)
    for (const o of [dup, order, cap, one]) expect(o.secretPrompts).toBe(0)
  })

  test("--from is refused by name, naming the route; a bare address in sweep_to and a --label are not accepted", async () => {
    const f = await fixture(["a", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const from = await runBatch(f, { file, args: ["--from", "x"] })
    expect(from.code).toBe(2)
    expect(from.err).toContain("takes no --from")
    expect(from.err).toContain("vault new-key --chain solana --labels-from")
    const label = await runBatch(f, { file, args: ["--label", "x"] })
    expect(label.code).toBe(2)
    expect(label.err).toContain("Unknown flag: --label")
    const tilde = await runBatch(f, { file: "~/plan.txt" })
    expect(tilde.code).toBe(2)
    expect(tilde.err).toContain('literal "~"')
    expect(from.secretPrompts + label.secretPrompts + tilde.secretPrompts).toBe(0)
  })
})

describe("T-I1, T-I2, T-I3: the input file", () => {
  test("T-I1: the operator's real header is accepted, and reordered columns map identically, by name", () => {
    const real = parsePairsFile(
      "order,label,family,sweep_to,value_usd\n1,tr-1,tr,p-2,2140.00\n2,tr-2,tr,p-2,880.50\n",
      {
        file: "plan.csv",
        rpcUrl: RPC,
      },
    )
    const reordered = parsePairsFile(
      "sweep_to,value_usd,label,family,order\np-2,2140.00,tr-1,tr,1\np-2,880.50,tr-2,tr,2\n",
      {
        file: "plan.csv",
        rpcUrl: RPC,
      },
    )
    expect(real.ok && reordered.ok).toBe(true)
    if (!real.ok || !reordered.ok) return
    expect(real.rows).toEqual(reordered.rows)
    expect(real.rows).toEqual([
      { line: 2, label: "tr-1", destination: "p-2", order: "1", valueUsd: "2140.00" },
      { line: 3, label: "tr-2", destination: "p-2", order: "2", valueUsd: "880.50" },
    ])
    expect(real.format).toBe("csv")
    expect(real.hasValueUsd).toBe(true)
  })

  test("T-I1: the same file through the command: family is carried, not used, and value_usd is echoed as yours", async () => {
    const f = await fixture(["tr-1", "tr-2", "p-2"])
    const file = await pairsFile(
      f.dir,
      "order,label,family,sweep_to,value_usd\n1,tr-1,tr,p-2,2140.00\n2,tr-2,tr,p-2,880.50\n",
      "plan.csv",
    )
    const o = await runBatch(f, { file, lines: ["nope"] })
    expect(o.code).toBe(1)
    expect(o.err).toContain("value_usd (yours)")
    // Echoed verbatim: the cell as the file spells it, not a reformatting of it (D4).
    expect(o.err).toMatch(/^2\s+promote\s+tr-1\s+\S+\s+p-2 \(…\w+\)\s+none\s+0\.021400\s+2140\.00$/m)
    expect(o.err).toContain(
      "value_usd totals your file's own column; this CLI reads no price. Total for the 2 rows this run will act on: $3,020.50",
    )
    expect(o.err).not.toContain("tr  ")
  })

  test("T-I2: a CSV missing sweep_to lists the columns it found; a 3-field whitespace line names its line", async () => {
    const missing = parsePairsFile("order,label,family\n1,a,x\n", { file: "plan.csv", rpcUrl: RPC })
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.findings).toEqual([
      { line: 1, problem: "a CSV needs both a label and a sweep_to column; found: order, label, family" },
    ])
    const three = parsePairsFile("a cold\nb cold extra\n", { file: "plan.txt", rpcUrl: RPC })
    expect(three.ok).toBe(false)
    if (three.ok) return
    expect(three.findings).toEqual([{ line: 2, problem: `3 fields; a row is "<label> <destination>"` }])
  })

  test("T-I3: an unparseable value_usd cell is shown verbatim, excluded from the total, counted, and does not refuse", async () => {
    const f = await fixture(["a", "b", "cold"])
    // A quote-free CSV is the operator's real shape, so a `$1,500` cell would split on its own
    // comma; the lenient parse is exercised on the helper below and the run uses `$1500`.
    const file = await pairsFile(f.dir, "label,sweep_to,value_usd\na,cold,$1500\nb,cold,n/a\n", "plan.csv")
    const o = await runBatch(f, { file, ack: "correct" })
    expect(o.code).toBe(0)
    expect(o.err).toContain("n/a")
    expect(o.err).toContain(
      "Total for the 2 rows this run will act on: $1,500.00 (1 row excluded: the cell did not parse)",
    )
    expect(parseValueUsdCell("$1,500")).toBe(1500)
    expect(parseValueUsdCell("n/a")).toBeUndefined()
    expect(formatUsd(310749)).toBe("$310,749.00")
    expect(formatSol(21_400_000n)).toBe("0.021400")
  })
})

describe("T-U2: a passphrase batch asks for the passphrase once", () => {
  test("five rows, one promptSecret", async () => {
    const f = await fixture(["a", "b", "c", "d", "e", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\nc cold\nd cold\ne cold\n")
    const o = await runBatch(f, { file, ack: "correct" })
    expect(o.code).toBe(0)
    expect(o.secretPrompts).toBe(1)
    expect(o.submits.n).toBe(5)
    expect(o.out).toContain("5 addresses promoted under one unlock, each committed on its own.")
    // Streamed as they land, one line per row, on stderr.
    expect(o.err).toContain("✓ 1/5  a  ")
    expect(o.err).toContain("✓ 5/5  e  ")
  })
})

describe("T-A1 to T-A4: the sentence and the acknowledgement (BE-296)", () => {
  test("T-A1: one sentence, exactly once, on stdout, before the prompt; the table and the block are on stderr", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, { file, ack: "correct" })
    expect(o.code).toBe(0)
    // Every group answered (the fake returns no accounts), so the sentence is Form N, plural.
    const sentence = promoteSentence({ n: 2, form: "N", where: "below" })
    expect(o.out.split(`\n${sentence}\n\n`)).toHaveLength(2)
    expect(o.out).toContain(SENTENCE_PREFIX)
    expect(o.err).not.toContain(SENTENCE_PREFIX)
    // At the moment the prompt was asked, the sentence was already on stdout.
    expect(o.stdoutAtPrompt[0]).toContain(sentence)
    // The table is on stderr, `line` first, `authority` after `destination` (D10, D8).
    expect(o.err).toMatch(/line\s+state\s+label\s+address\s+destination\s+authority\s+SOL \(tokens not read\)/)
    expect(o.err).not.toContain("This acknowledges permanent TEE exposure")
    // The controlled-by block is the last thing on stderr before the prompt (D4).
    expect(o.stderrAtPrompt[0]?.endsWith(`\n${controlledByBlock(2)}\n`)).toBe(true)
    expect(o.linePrompts).toEqual([confirmPrompt(2)])
  })

  test("T3: confirm, Confirm and padded CONFIRM proceed; EXPOSE, yes, the old token and empty each refuse with zero writes", async () => {
    for (const accepted of ["confirm", "Confirm", "  CONFIRM  "]) {
      const f = await fixture(["a", "b", "cold"])
      const file = await pairsFile(f.dir, "a cold\nb cold\n")
      const o = await runBatch(f, { file, lines: [accepted] })
      expect([accepted, o.code]).toEqual([accepted, 0])
      expect(o.submits.n).toBe(2)
    }
    for (const refused of ["EXPOSE", "yes", "y", `2 ${"CwTwwC"}`, ""]) {
      const f = await fixture(["a", "b", "cold"])
      const before = await readEntries(f)
      const file = await pairsFile(f.dir, "a cold\nb cold\n")
      const o = await runBatch(f, { file, lines: [refused, "should not be asked"] })
      expect([refused, o.code]).toEqual([refused, 1])
      expect(o.err).toContain("The acknowledgement is the word confirm; nothing was promoted, and nothing was written.")
      expect(o.linePrompts).toEqual([confirmPrompt(2)])
      expect((await readEntries(f)).generation).toBe(before.generation)
      expect(o.submits.n).toBe(0)
      expect(o.inits.n).toBe(0)
    }
  })

  test("T-A3, T-A4: a wrong answer writes nothing, exits 1, never echoes what was typed, and is not re-asked", async () => {
    const f = await fixture(["a", "b", "cold"])
    const before = await readEntries(f)
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, { file, lines: ["zzzzzz-typed", "should not be asked"], json: true })
    expect(o.code).toBe(1)
    const docs = jsonDocuments(o.out)
    expect(docs).toHaveLength(1)
    const body = JSON.parse(docs[0] as string)
    expect(body).toMatchObject({ ok: false, code: "PROMOTE_NOT_ACKNOWLEDGED" })
    expect(body.message).toBe("The acknowledgement is the word confirm; nothing was promoted, and nothing was written.")
    expect(body.suggestion).toBe("Run the command again and type confirm at the prompt.")
    expect(o.out + o.err).not.toContain("zzzzzz-typed")
    expect(o.linePrompts).toEqual([confirmPrompt(2)])
    expect((await readEntries(f)).generation).toBe(before.generation)
    expect(o.submits.n).toBe(0)
  })
})

describe("T-R2 to T-R6: re-runs", () => {
  test("T-R2: three of five already landed: skip on those, an acting count of 2, and the acknowledgement expects 2", async () => {
    const f = await fixture(["a", "b", "c", "d", "e", "cold"])
    const cold = f.addresses.cold as string
    await seed(f, (e) =>
      ["a", "b", "c"].includes(e.label) ? { ...e, ...teeSeed("enabled", cold, { grant: true, linked: true }) } : e,
    )
    const file = await pairsFile(f.dir, "a cold\nb cold\nc cold\nd cold\ne cold\n")
    // The acting count (2), not the file's row count (5), is what the prompt, the sentence and
    // the block name.
    const wrong = await runBatch(f, { file, lines: ["no"] })
    expect(wrong.code).toBe(1)
    expect(wrong.err).toContain("The acknowledgement is the word confirm")
    expect(wrong.err).toContain("5 rows from")
    expect(wrong.err).toContain("3 already promoted (skipped), 0 to resume, 2 to promote.")
    expect(wrong.err).toMatch(/^1\s+skip\s+a\s/m)
    expect(wrong.err).toMatch(/^4\s+promote\s+d\s/m)
    expect(wrong.out).toContain("a permanent copy of these 2 keys")
    expect(wrong.err).toContain("These 2 keys will be controlled by:")
    expect(wrong.linePrompts).toEqual([confirmPrompt(2)])
    // Skip rows get no role requests: two acting keys, nine each (D7).
    expect(wrong.rpc.getProgramAccounts).toBe(2 * REQUESTS_PER_KEY)

    const right = await runBatch(f, { file, ack: "correct" })
    void cold
    expect(right.code).toBe(0)
    expect(right.submits.addresses).toEqual([f.addresses.d as string, f.addresses.e as string])
    expect(right.out).toContain(
      "2 addresses promoted under one unlock, each committed on its own; 3 already promoted (skipped).",
    )
  })

  test("T-R3: an import-pending row resumes through resumePromote with zero import calls and zero confirmLastSix calls", async () => {
    const f = await fixture(["a", "ip", "cold"])
    const cold = f.addresses.cold as string
    await seed(f, (e) => (e.label === "ip" ? { ...e, ...teeSeed("import-pending", cold, { grant: true }) } : e))
    const file = await pairsFile(f.dir, "a cold\nip cold\n")
    const o = await runBatch(f, {
      file,
      ack: "correct",
      json: true,
      api: { wallets: grantedWallets([{ address: f.addresses.ip as string, vaultDestination: cold }]) },
    })
    expect(o.code).toBe(0)
    // The one import is row 1's. Row 2 adopted the grant.
    expect(o.submits.addresses).toEqual([f.addresses.a as string])
    expect(o.linePrompts).toEqual([confirmPrompt(2)])
    const docs = jsonDocuments(o.out)
    expect(docs).toHaveLength(1)
    const body = JSON.parse(docs[0] as string)
    expect(body).toMatchObject({ ok: true, complete: true, rows: 2, promoted: 1, resumed: 1, skipped: 0 })
    expect(body.keys[1]).toMatchObject({ line: 2, label: "ip", state: "resumed", lifecycle: "enabled", importCalls: 0 })
    expect(body.destinations).toEqual([{ label: "cold", address: cold, keys: 2 }])
  })

  test("T-R4: an on-disk destination that differs from the file's refuses the whole batch, naming both", async () => {
    const f = await fixture(["a", "done", "d1", "d2"])
    await seed(f, (e) =>
      e.label === "done" ? { ...e, ...teeSeed("enabled", f.addresses.d1, { grant: true, linked: true }) } : e,
    )
    const before = await readEntries(f)
    const file = await pairsFile(f.dir, "a d2\ndone d2\n")
    const o = await runBatch(f, { file, json: true })
    expect(o.code).toBe(1)
    const body = batchRefusal(o)
    expect(body.rows).toEqual([
      {
        line: 2,
        label: "done",
        destination: "d2",
        code: "PROMOTE_ALREADY_TEE_WALLET",
        message: "done is already a TEE wallet (enabled).",
        why: `On disk it sweeps to ${f.addresses.d1}; this file says d2 (${f.addresses.d2}).`,
      },
    ])
    expect((await readEntries(f)).generation).toBe(before.generation)
  })

  test("T-R5: a skip row whose destination is now everRemoteExposed does not refuse", async () => {
    const f = await fixture(["a", "done", "cold"])
    const cold = f.addresses.cold as string
    // `done` landed in an earlier run; a LATER row of that run then promoted `cold` itself, so the
    // destination is exposed now. Re-checking `done` against the cold rule would refuse a correct,
    // completed promotion.
    await seed(f, (e) =>
      e.label === "done"
        ? { ...e, ...teeSeed("enabled", cold, { grant: true, linked: true }) }
        : e.label === "cold"
          ? { ...e, exposure: { everRemoteExposed: true, everExported: false } }
          : e,
    )
    const file = await pairsFile(f.dir, "done cold\na cold\n")
    const o = await runBatch(f, { file, json: true })
    // Row 2 is a fresh promote to an exposed destination, so IT refuses, on the shipped rule; the
    // skip row is not a failure line.
    expect(o.code).toBe(1)
    const body = batchRefusal(o)
    expect(body.rows.map((row) => row.line)).toEqual([2])
    expect(body.rows[0]?.code).toBe("PROMOTE_DESTINATION_NOT_COLD")
  })

  test("T-R6: acting count 0 prints the table, prompts for nothing, exits 0", async () => {
    const f = await fixture(["a", "b", "cold"])
    const cold = f.addresses.cold as string
    await seed(f, (e) =>
      ["a", "b"].includes(e.label) ? { ...e, ...teeSeed("enabled", cold, { grant: true, linked: true }) } : e,
    )
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, { file })
    expect(o.code).toBe(0)
    expect(o.linePrompts).toEqual([])
    expect(o.err).toContain("2 already promoted (skipped), 0 to resume, 0 to promote.")
    expect(o.err).toContain("Nothing to do: every row already landed.")
    expect(o.out).not.toContain(SENTENCE_PREFIX)
    // No acting rows, so the role check does not run: no requests, no opening line, no done line.
    expect(o.rpc.getProgramAccounts).toBe(0)
    expect(o.err).not.toContain("Checking token mint")
    expect(o.err).not.toContain("✓ authorities")
    const json = await runBatch(f, { file, json: true })
    expect(json.code).toBe(0)
    expect(JSON.parse(json.out)).toMatchObject({
      ok: true,
      complete: true,
      rows: 2,
      promoted: 0,
      resumed: 0,
      skipped: 2,
      authorities: { checked: [...ROLE_GROUP_IDS], notChecked: [], found: [] },
    })
  })
})

describe("T-C1, T-C2: one commit per key, a mid-run failure stops the batch", () => {
  test("a submit that fails on the fourth row leaves three promoted, the fourth import-pending, the fifth untouched; re-running the same file resumes", async () => {
    const f = await fixture(["a", "b", "c", "d", "e", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\nc cold\nd cold\ne cold\n")
    const o = await runBatch(f, {
      file,
      ack: "correct",
      api: { submit: (n) => (n === 4 ? jsonResponse(500, { success: false, error: "privy down" }) : undefined) },
    })
    expect(o.code).toBe(1)
    expect(o.submits.n).toBe(4)
    expect(o.err).toContain("3 of 5 rows landed and ARE in the vault; the vault is intact. 2 remain.")
    expect(o.err).toContain(
      "Re-run the same file: the rows that landed are skipped, an interrupted row resumes, and the rest are promoted.",
    )
    const after = await readEntries(f)
    const by = (label: string) => after.entries.find((e) => e.label === label)
    expect(["a", "b", "c"].map((l) => by(l)?.tee?.lifecycle)).toEqual(["enabled", "enabled", "enabled"])
    expect(by("d")?.tee?.lifecycle).toBe("import-pending")
    expect(by("e")?.role).toBe("vault")

    // The re-run: 3 skip, 1 resume (the server holds d's grant now), 1 promote.
    const again = await runBatch(f, {
      file,
      ack: "correct",
      api: { wallets: grantedWallets([{ address: f.addresses.d as string, vaultDestination: f.addresses.cold }]) },
    })
    expect(again.code).toBe(0)
    expect(again.err).toContain("3 already promoted (skipped), 1 to resume, 1 to promote.")
    expect(again.submits.addresses).toEqual([f.addresses.e as string])
    const done = await readEntries(f)
    expect(done.entries.filter((e) => e.tee?.lifecycle === "enabled")).toHaveLength(5)
  })
})

describe("T-H1, T-H2, T-H3: the bounded holdings read", () => {
  test("T-H1: 146 addresses are two getMultipleAccounts requests; token accounts only under --token-holdings", async () => {
    const made = await makeVault()
    closeVault(made.vault)
    const f: Fixture = { dir: made.dir, path: made.path, passphrase: made.passphrase, addresses: {} }
    const keys = await newKeys(f.dir, f.passphrase, 147)
    const labels = Object.keys(keys)
    const dest = labels[146] as string
    const file = await pairsFile(
      f.dir,
      `${labels
        .slice(0, 146)
        .map((label) => `${label} ${dest}`)
        .join("\n")}\n`,
    )
    const o = await runBatch(f, { file, lines: ["no"] })
    expect(o.code).toBe(1)
    expect(o.rpc.getMultipleAccounts).toBe(2)
    expect(o.rpc.getTokenAccountsByOwner).toBe(0)
    expect(o.err).toContain("✓ SOL read for 146 addresses (2 requests)")
    expect(o.err).toContain("146 rows from")
    // BE-296 (D7): the opening line names the request count before the first one is sent, and
    // the acting rows get nine requests each.
    expect(o.err).toContain(
      "Checking token mint, freeze, program upgrade and stake authorities for 146 addresses: 1,314 requests over rpc.pb.test.",
    )
    expect(o.rpc.getProgramAccounts).toBe(1314)
    expect(o.err).toContain("✓ authorities read for 146 addresses (1,314 requests, 7 of 7 groups read) in 0s")
    expect(o.out).toContain("a permanent copy of these 146 keys")
    expect(o.linePrompts).toEqual([confirmPrompt(146)])

    const tokens = await runBatch(f, { file, lines: ["no"], args: ["--token-holdings"] })
    expect(tokens.rpc.getMultipleAccounts).toBe(2)
    expect(tokens.rpc.getTokenAccountsByOwner).toBe(292)
    expect(tokens.err).toContain("Reading token accounts for 146 addresses: 292 requests over rpc.pb.test.")
    expect(tokens.err).toContain("Token accounts were read under both programs.")
  })

  test("T-H2: without --token-holdings the header and the footer both say token accounts were not read", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, { file, lines: ["no"] })
    expect(o.err).toContain("SOL (tokens not read)")
    expect(o.err).toContain("Token accounts were not read (pass --token-holdings).")
    expect(o.err).toContain("SOL read at 1970-01-01T00:00:00.000Z over rpc.pb.test.")
  })

  test("T-H3: a failed SOL read keeps the table, shows unread, and refuses rather than degrading", async () => {
    const f = await fixture(["a", "b", "cold"])
    const before = await readEntries(f)
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, { file, rpc: { failMultiple: true } })
    expect(o.code).toBe(1)
    expect(o.linePrompts).toEqual([])
    expect(o.err).toMatch(/^1\s+promote\s+a\s+\S+\s+cold \(…\w+\)\s+\?\s+unread$/m)
    expect(o.err).toContain(
      "SOL read over rpc.pb.test FAILED: RPC getMultipleAccounts failed: HTTP 500. The batch is refused.",
    )
    expect(o.err).toContain("The SOL read over rpc.pb.test failed")
    expect(o.out).not.toContain(SENTENCE_PREFIX)
    // The batch refuses right here, so the role read is not made and the column reads `?`.
    expect(o.rpc.getProgramAccounts).toBe(0)
    expect((await readEntries(f)).generation).toBe(before.generation)
  })
})

describe("T-J1, T-J2, T-J3: --json", () => {
  test("T-J1: exactly one document; complete false and exit 3 when an import is not verified-active; no secret anywhere", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, {
      file,
      ack: "correct",
      json: true,
      api: { remoteAuthority: (address) => (address === f.addresses.b ? "unknown" : "verified-active") },
    })
    expect(o.code).toBe(3)
    const docs = jsonDocuments(o.out)
    expect(docs).toHaveLength(1)
    const body = JSON.parse(docs[0] as string)
    expect(body).toMatchObject({ ok: true, complete: false, file, rows: 2, promoted: 2, resumed: 0, skipped: 0 })
    expect(body.keys.map((k: { remoteAuthority: string }) => k.remoteAuthority)).toEqual(["verified-active", "unknown"])
    expect(body.keys[0]).toEqual({
      line: 1,
      label: "a",
      address: f.addresses.a,
      destination: f.addresses.cold,
      state: "promoted",
      lifecycle: "enabled",
      linkedWalletId: `lw_${(f.addresses.a as string).slice(0, 6)}`,
      remoteAuthority: "verified-active",
      importCalls: 1,
    })
    // No secret: neither key's base58 private key appears on either stream.
    const v = await openVault(f)
    try {
      for (const label of ["a", "b"]) {
        const entry = v.index.entries.find((e) => e.label === label) as KeyEntry
        const secret = await decryptKey(v, entry.id)
        try {
          const encoded = base58.encode(secret)
          expect(o.out).not.toContain(encoded)
          expect(o.err).not.toContain(encoded)
        } finally {
          wipe(secret)
        }
      }
    } finally {
      closeVault(v)
    }
  })

  test("T-J3: a runTeeImport failure and a resumePromote failure under --json each leave exactly one document, the batch's", async () => {
    // runTeeImport: the second submit fails.
    const f = await fixture(["a", "b", "c", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\nc cold\n")
    const o = await runBatch(f, {
      file,
      ack: "correct",
      json: true,
      api: {
        submit: (n) =>
          n === 2
            ? jsonResponse(503, { success: false, error: { code: "PRIVY_DOWN", message: "privy down" } })
            : undefined,
      },
    })
    expect(o.code).toBe(1)
    const docs = jsonDocuments(o.out)
    expect(docs).toHaveLength(1)
    const body = JSON.parse(docs[0] as string)
    expect(body).toMatchObject({
      ok: false,
      complete: false,
      promoted: 1,
      failedLine: 2,
      code: "PRIVY_DOWN",
      message: "privy down",
    })
    expect(body.keys).toHaveLength(1)
    expect(o.err).toContain("1 of 3 rows landed and ARE in the vault")

    // resumePromote: Phase B reads a grant, the loop's second read finds nothing (unresolved, exit 3).
    const g = await fixture(["x", "ip", "cold"])
    const cold = g.addresses.cold as string
    await seed(g, (e) => (e.label === "ip" ? { ...e, ...teeSeed("import-pending", cold, { grant: true }) } : e))
    const file2 = await pairsFile(g.dir, "ip cold\nx cold\n")
    const r = await runBatch(g, {
      file: file2,
      ack: "correct",
      json: true,
      api: {
        wallets: [
          grantedWallets([{ address: g.addresses.ip as string, vaultDestination: cold }]),
          () => jsonResponse(200, { page: [], isDone: true }),
        ],
      },
    })
    expect(r.code).toBe(3)
    const rdocs = jsonDocuments(r.out)
    expect(rdocs).toHaveLength(1)
    expect(JSON.parse(rdocs[0] as string)).toMatchObject({
      ok: false,
      complete: false,
      failedLine: 1,
      code: "PROMOTE_OUTCOME_UNRESOLVED",
      promoted: 0,
      resumed: 0,
    })
    // Row 2 was not attempted (D12).
    expect(r.submits.n).toBe(0)
  })

  test("T-J2: no TTY refuses with the shipped VAULT_UNLOCK_FAILED; CANDLE_KEYSTORE_PASSPHRASE is refused first", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const pipe = await runBatch(f, { file, json: true, tty: false })
    expect(pipe.code).toBe(1)
    expect(JSON.parse(pipe.out)).toMatchObject({ ok: false, code: "VAULT_UNLOCK_FAILED" })
    expect(String(JSON.parse(pipe.out).message)).toContain("vault promote-batch needs a terminal")
    const env = await runBatch(f, { file, json: true, env: { CANDLE_KEYSTORE_PASSPHRASE: "x" } })
    expect(env.code).toBe(1)
    expect(JSON.parse(env.out)).toMatchObject({ ok: false, code: "ENV_PASSPHRASE_REFUSED" })
    expect(pipe.secretPrompts + env.secretPrompts).toBe(0)
  })
})

describe("--accept-unknown-exposure applies to every row and is visible per row", () => {
  test("rows admitted by the flag are promote* in the table and listed in the footer; without it they refuse", async () => {
    const f = await fixture(["a", "b", "cold"])
    await seed(f, (e) =>
      e.label === "cold"
        ? { ...e, exposure: { everRemoteExposed: false, everExported: false, exposureUnknown: true } }
        : e,
    )
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const refused = await runBatch(f, { file, json: true })
    expect(refused.code).toBe(1)
    expect(batchRefusal(refused).rows.map((row) => row.code)).toEqual([
      "PROMOTE_DESTINATION_NOT_COLD",
      "PROMOTE_DESTINATION_NOT_COLD",
    ])
    const admitted = await runBatch(f, { file, ack: "correct", args: ["--accept-unknown-exposure"] })
    expect(admitted.code).toBe(0)
    expect(admitted.err).toMatch(/^1\s+promote\*\s+a\s/m)
    expect(admitted.err).toContain("2 rows needed --accept-unknown-exposure (promote*): a, b")
    const after = await readEntries(f)
    expect(after.entries.find((e) => e.label === "a")?.tee?.destinationExposureAccepted).toBe(true)
  })
})

describe("the projection helper the loop and the preflight share", () => {
  test("applyPromotion moves the subject to tee-wallet / import-pending with its pin and records the exposed index", async () => {
    const f = await fixture(["a", "cold"])
    const v = await openVault(f)
    try {
      const subject = v.index.entries.find((e) => e.label === "a") as KeyEntry
      const destination = v.index.entries.find((e) => e.label === "cold") as KeyEntry
      const next = applyPromotion(v.index, subject, destination, {
        now: "2026-09-22T22:41:07.000Z",
        acceptUnknownExposure: false,
      })
      const moved = next.entries.find((e) => e.id === subject.id) as KeyEntry
      expect(moved.role).toBe("tee-wallet")
      expect(moved.tee).toEqual({
        network: "solana-mainnet",
        lifecycle: "import-pending",
        vaultDestination: destination.address,
        promotedInPlaceAt: "2026-09-22T22:41:07.000Z",
      })
      expect(moved.exposure).toEqual({ everRemoteExposed: true, everExported: false })
      expect(next.hd.exposedIndexes.solanaVault).toEqual([0])
      // The original is untouched: a projection is a copy.
      expect(v.index.entries.find((e) => e.id === subject.id)?.role).toBe("vault")
    } finally {
      closeVault(v)
    }
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
// BE-288 (spec `2026-09-23-linked-wallet-cap-before-import-design.md`, §6.2): the room is read
// before the table, the whole batch is refused when its `promote` rows exceed it, and a definite
// init answer puts the row's pre-import entry back.
// ══════════════════════════════════════════════════════════════════════════════════════════════

const roomOf =
  (room: { tier: string; active: number; cap: number }): RouteHandler =>
  () =>
    jsonResponse(200, { success: true, ...room, room: Math.max(0, room.cap - room.active) })

const RESTORED = "The vault entry is back as it was: nothing left this machine."
const LIMIT_MESSAGE =
  "Active linked-wallet limit reached for this tier: 10 of 10 active. Nothing was sent to the wallet provider."
const LIMIT_HINT = "You have reached your trading-wallet limit for this tier. Revoke one or upgrade."
const limitRefusal = () =>
  jsonResponse(400, {
    success: false,
    error: {
      code: "WALLET_LIMIT_REACHED",
      message: LIMIT_MESSAGE,
      retryable: false,
      uiHint: LIMIT_HINT,
      linkedWallets: { active: 10, cap: 10 },
      keyImported: false,
    },
  })
const IMPORT_FAILED_MESSAGE = "Wallet import could not be started. Please try again."
const importFailed = () =>
  jsonResponse(400, {
    success: false,
    error: { code: "WALLET_IMPORT_FAILED", message: IMPORT_FAILED_MESSAGE, retryable: true },
  })

describe("BE-288 C1, C2: a Pro account with 146 promote rows is refused at preflight, zero writes", () => {
  test("C1: the §4.1 stderr text exactly, exit 1, vault bytes identical, no import request, no RPC, no prompt; C2: the --json document is the only thing on stdout", async () => {
    const made = await makeVault()
    closeVault(made.vault)
    const f: Fixture = { dir: made.dir, path: made.path, passphrase: made.passphrase, addresses: {} }
    const keys = await newKeys(f.dir, f.passphrase, 151)
    const labels = Object.keys(keys)
    const dests = labels.slice(146, 151)
    const file = await pairsFile(
      f.dir,
      `${labels
        .slice(0, 146)
        .map((label, i) => `${label} ${dests[i % 5]}`)
        .join("\n")}\n`,
    )
    const before = await readFile(f.path, "utf8")
    const message =
      "This batch would link 146 wallets to this Candle account, and it has room for 10: 0 of 10 linked wallets are active on the Pro tier. Nothing was written."
    const suggestion =
      "Upgrade to Max, revoke linked wallets you no longer use, or split the file so this run acts on at most 10 rows. Promotion is irreversible, so no row runs until every row can link."

    const o = await runBatch(f, { file, api: { room: roomOf({ tier: "pro", active: 0, cap: 10 }) } })
    expect(o.code).toBe(1)
    // §4.1's transcript starts after the unlock: everything from the first progress line on.
    expect(o.err.slice(o.err.indexOf("✓"))).toBe(
      `✓ 146 rows read from ${file}\n✓ preflight: 146 rows, 5 destinations, no conflicts\n${message} ${suggestion}\n`,
    )
    expect(o.out).toBe("")
    expect(await readFile(f.path, "utf8")).toBe(before)
    expect(o.inits.n).toBe(0)
    expect(o.submits.n).toBe(0)
    expect(o.rpc.getMultipleAccounts).toBe(0)
    expect(o.rpc.getTokenAccountsByOwner).toBe(0)
    expect(o.linePrompts).toEqual([])

    const j = await runBatch(f, { file, json: true, api: { room: roomOf({ tier: "pro", active: 0, cap: 10 }) } })
    expect(j.code).toBe(1)
    expect(j.out).toBe(
      `${JSON.stringify({
        ok: false,
        code: "WALLET_LIMIT_REACHED",
        message,
        suggestion,
        details: { acting: "146", active: "0", cap: "10", room: "10", tier: "pro" },
      })}\n`,
    )
    expect(await readFile(f.path, "utf8")).toBe(before)
    expect(j.inits.n).toBe(0)
    expect(j.linePrompts).toEqual([])
  })
})

describe("BE-288 C3: only promote rows take room", () => {
  test("140 skip rows and 6 promote rows pass with room 6, and the footer carries the §4.3 line", async () => {
    const made = await makeVault()
    closeVault(made.vault)
    const f: Fixture = { dir: made.dir, path: made.path, passphrase: made.passphrase, addresses: {} }
    const keys = await newKeys(f.dir, f.passphrase, 147)
    const labels = Object.keys(keys)
    const destLabel = labels[146] as string
    const dest = keys[destLabel] as string
    const skipped = new Set(labels.slice(0, 140))
    await seed(f, (e) =>
      skipped.has(e.label) ? { ...e, ...teeSeed("enabled", dest, { linked: true, grant: true }) } : e,
    )
    const file = await pairsFile(
      f.dir,
      `${labels
        .slice(0, 146)
        .map((label) => `${label} ${destLabel}`)
        .join("\n")}\n`,
    )
    const o = await runBatch(f, { file, lines: ["no"], api: { room: roomOf({ tier: "pro", active: 4, cap: 10 }) } })
    // The acknowledgement was refused, so nothing ran; the point is that the room check passed
    // 146 rows against a room of 6, and said so in the footer.
    expect(o.code).toBe(1)
    expect(o.err).toContain("140 already promoted (skipped), 0 to resume, 6 to promote.")
    expect(o.err).toContain("Linked wallets: 4 of 10 active on the Pro tier; this run links 6, leaving 0.")
    expect(o.err).not.toContain("This batch would link")
    expect(o.linePrompts).toEqual([confirmPrompt(6)])
    expect(o.inits.n).toBe(0)
  })
})

describe("BE-288 C4, C5: an unreadable room refuses, and so does a tier with no cap", () => {
  test("C4: a 404, a thrown fetch, and a body without numbers each refuse with LINKED_WALLET_ROOM_UNREADABLE and zero writes", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const before = await readFile(f.path, "utf8")
    const rooms: Array<[string, RouteHandler]> = [
      ["HTTP 404", () => jsonResponse(404, { success: false, error: { code: "NOT_FOUND", message: "Not Found" } })],
      [
        "Could not reach",
        () => {
          throw new Error("connection refused")
        },
      ],
      ["the response carried no numeric active and cap", () => jsonResponse(200, { success: true })],
    ]
    for (const [reason, room] of rooms) {
      const o = await runBatch(f, { file, json: true, api: { room } })
      expect(o.code).toBe(1)
      const docs = jsonDocuments(o.out)
      expect(docs).toHaveLength(1)
      const body = JSON.parse(docs[0] as string)
      expect(body.code).toBe("LINKED_WALLET_ROOM_UNREADABLE")
      expect(body.message).toContain("Could not read how many linked wallets this account has room for (")
      expect(body.message).toContain(reason)
      expect(body.message).toContain("Nothing was written.")
      expect(body.suggestion).toContain("an API older than this CLI answers 404 here until it is updated")
      expect(await readFile(f.path, "utf8")).toBe(before)
      expect(o.inits.n).toBe(0)
      expect(o.rpc.getMultipleAccounts).toBe(0)
      expect(o.linePrompts).toEqual([])
    }
  })

  test("C5: a Free account (cap 0) refuses with TIER_REQUIRED before any write", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const before = await readFile(f.path, "utf8")
    const o = await runBatch(f, { file, api: { room: roomOf({ tier: "free", active: 0, cap: 0 }) } })
    expect(o.code).toBe(1)
    expect(o.err).toContain(
      "Linked wallets need the Pro or Max tier, and this account is on Free. Nothing was written.",
    )
    expect(await readFile(f.path, "utf8")).toBe(before)
    expect(o.inits.n).toBe(0)
    expect(o.linePrompts).toEqual([])
  })
})

describe("BE-288 C6, C7, C12: a mid-run refusal at init restores the row; at submit it does not", () => {
  test("C6: row 3's init answers WALLET_LIMIT_REACHED: rows 1-2 enabled, row 3's entry back field for field, no submit for it, the restore sentence in the stopped message", async () => {
    const f = await fixture(["a", "b", "c", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\nc cold\n")
    const before = await readEntries(f)
    const o = await runBatch(f, {
      file,
      ack: "correct",
      api: { room: roomOf({ tier: "pro", active: 0, cap: 10 }), init: (n) => (n === 3 ? limitRefusal() : undefined) },
    })
    expect(o.code).toBe(1)
    expect(o.inits.n).toBe(3)
    expect(o.submits.addresses).toEqual([f.addresses.a as string, f.addresses.b as string])
    expect(o.err).toContain("2 of 3 rows landed and ARE in the vault; the vault is intact. 1 remain.")
    expect(o.err).toContain(`${LIMIT_MESSAGE} ${RESTORED} ${LIMIT_HINT}\n`)
    const after = await readEntries(f)
    const by = (entries: KeyEntry[], label: string) => entries.find((e) => e.label === label)
    expect(["a", "b"].map((l) => by(after.entries, l)?.tee?.lifecycle)).toEqual(["enabled", "enabled"])
    expect(by(after.entries, "c")).toEqual(by(before.entries, "c"))
    expect(by(after.entries, "c")?.role).toBe("vault")
    expect(by(after.entries, "c")?.tee).toBeUndefined()
    expect(by(after.entries, "c")?.exposure).toEqual(by(before.entries, "c")?.exposure)
  })

  test("C7: row 3's submit answers WALLET_LIMIT_REACHED with keyImported false: the row stays import-pending, everRemoteExposed, and no restore sentence", async () => {
    const f = await fixture(["a", "b", "c", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\nc cold\n")
    const o = await runBatch(f, {
      file,
      ack: "correct",
      api: { room: roomOf({ tier: "pro", active: 0, cap: 10 }), submit: (n) => (n === 3 ? limitRefusal() : undefined) },
    })
    expect(o.code).toBe(1)
    expect(o.submits.n).toBe(3)
    expect(o.err).toContain(LIMIT_MESSAGE)
    expect(o.err).not.toContain(RESTORED)
    const after = await readEntries(f)
    const c = after.entries.find((e) => e.label === "c")
    expect(c?.role).toBe("tee-wallet")
    expect(c?.tee?.lifecycle).toBe("import-pending")
    expect(c?.exposure?.everRemoteExposed).toBe(true)
  })

  test("C12: row 3's init answers WALLET_IMPORT_FAILED (D3): the row is back, the stopped line is the D9 sentence pair, no submit for it", async () => {
    const f = await fixture(["a", "b", "c", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\nc cold\n")
    const before = await readEntries(f)
    const o = await runBatch(f, {
      file,
      ack: "correct",
      api: { room: roomOf({ tier: "pro", active: 0, cap: 10 }), init: (n) => (n === 3 ? importFailed() : undefined) },
    })
    expect(o.code).toBe(1)
    expect(o.submits.addresses).toEqual([f.addresses.a as string, f.addresses.b as string])
    expect(o.err).toContain(`\n${IMPORT_FAILED_MESSAGE} ${RESTORED}\n`)
    const after = await readEntries(f)
    expect(after.entries.find((e) => e.label === "c")).toEqual(before.entries.find((e) => e.label === "c"))

    // Under --json the stopped document carries the same message, and stage/status are not in it.
    const g = await fixture(["x", "y", "cold"])
    const file2 = await pairsFile(g.dir, "x cold\ny cold\n")
    const j = await runBatch(g, {
      file: file2,
      ack: "correct",
      json: true,
      api: { room: roomOf({ tier: "pro", active: 0, cap: 10 }), init: (n) => (n === 1 ? importFailed() : undefined) },
    })
    expect(j.code).toBe(1)
    const docs = jsonDocuments(j.out)
    expect(docs).toHaveLength(1)
    const body = JSON.parse(docs[0] as string)
    expect(body).toMatchObject({
      ok: false,
      complete: false,
      promoted: 0,
      failedLine: 1,
      code: "WALLET_IMPORT_FAILED",
      message: `${IMPORT_FAILED_MESSAGE} ${RESTORED}`,
    })
    expect(body.stage).toBeUndefined()
    expect(body.status).toBeUndefined()
    expect(body.suggestion).toBeUndefined()
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
// BE-296 (spec `2026-09-23-cli-vault-promote-confirm-design.md`, §6): the controlled-by block, the
// live account read, the always-on role check, the `authority` column, the `line` header, --json.

/** The D6 group a `getProgramAccounts` belongs to, from its program and filter shape. */
function groupOfCall(call: ProgramAccountsCall): string {
  const dataSize = call.filters.find((f) => f.dataSize !== undefined)?.dataSize
  const offsets = call.filters.map((f) => f.memcmp?.offset).filter((o): o is number => o !== undefined)
  if (call.programId === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
    return offsets.includes(46) ? "token-freeze" : "token-mint"
  if (call.programId === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")
    return offsets.includes(46) ? "token2022-freeze" : "token2022-mint"
  if (call.programId === "BPFLoaderUpgradeab1e11111111111111111111111")
    return offsets.includes(12) ? "program-upgrade" : "program-resolve"
  if (call.programId === STAKE_PROGRAM_ID && dataSize === 200)
    return offsets.includes(44) ? "stake-withdrawer" : "stake-staker"
  throw new Error(`unrecognised getProgramAccounts ${call.programId} ${JSON.stringify(call.filters)}`)
}

/** Whether the request's key bytes are this address (the key sits at the end of the memcmp bytes). */
function isFor(call: ProgramAccountsCall, address: string): boolean {
  const key = Buffer.from(base58.decode(address))
  return call.filters.some((f) => {
    if (f.memcmp === undefined) return false
    const bytes = Buffer.from(f.memcmp.bytes, "base64")
    return bytes.length >= key.length && bytes.subarray(bytes.length - key.length).equals(key)
  })
}

describe("BE-296 T5, T5a: the controlled-by block", () => {
  test("T5: username, shortened account, 8-character prefix, label in parentheses with a device token, profile source, full URL and environment; the secret appears nowhere", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, { file, ack: "correct", deviceToken: true })
    expect(o.code).toBe(0)
    const block = controlledByBlock(2, { label: KEY_LABEL })
    expect(o.err).toContain(block)
    // Directly above the prompt: the block is the last stderr output before `confirm` is asked.
    expect(o.stderrAtPrompt[0]?.endsWith(`\n${block}\n`)).toBe(true)
    expect(o.err).not.toContain(API_KEY)
    expect(o.out).not.toContain(API_KEY)
    expect(o.err).not.toContain(DEVICE_TOKEN)
    expect(o.err).not.toContain(KEY_PREFIX.padEnd(43, "x"))
    // The label read used the device token, never the API key.
    const keysCall = o.calls.find((call) => call.url.endsWith("/api/v1/agent/keys"))
    expect(keysCall).toBeDefined()
    const headers = (keysCall?.init.headers ?? {}) as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${DEVICE_TOKEN}`)
    expect(headers["x-api-key"]).toBeUndefined()
  })

  test("T5: CANDLE_API_KEY as the source when the env var supplies the key; (no username) when the account has none", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const env = await runBatch(f, {
      file,
      lines: ["no"],
      noApiKey: true,
      env: { CANDLE_API_KEY: API_KEY },
      json: true,
      api: { embedded: () => jsonResponse(200, { success: true, account: ACCOUNT }) },
    })
    expect(env.code).toBe(1)
    expect(env.err).toContain(`  API key         ${KEY_PREFIX}…  CANDLE_API_KEY`)
    expect(env.err).toContain(`  Candle account  (no username)  (${ACCOUNT.slice(0, 6)}…${ACCOUNT.slice(-4)})`)
    // No profile key, no device token: nothing reads the label, and the run still reaches the prompt.
    expect(env.calls.some((call) => call.url.endsWith("/api/v1/agent/keys"))).toBe(false)
    expect(env.linePrompts).toEqual([confirmPrompt(2)])
  })

  test("T5a: no parenthesis, no extra line, and the run still reaches the prompt when the label cannot be read", async () => {
    const cases: Array<{ name: string; deviceToken: boolean; keys?: RouteHandler }> = [
      { name: "no device token", deviceToken: false },
      {
        name: "401",
        deviceToken: true,
        keys: () => jsonResponse(401, { success: false, error: { code: "UNAUTHORIZED", message: "no" } }),
      },
      { name: "500", deviceToken: true, keys: () => jsonResponse(500, { success: false }) },
      {
        name: "network error",
        deviceToken: true,
        keys: () => {
          throw new Error("ECONNRESET")
        },
      },
      {
        name: "no row with the prefix",
        deviceToken: true,
        keys: () =>
          jsonResponse(200, {
            keys: [{ keyPrefix: "someone", label: "theirs", scopes: [], environment: "production", createdAt: 1 }],
          }),
      },
      {
        name: "empty label",
        deviceToken: true,
        keys: () =>
          jsonResponse(200, {
            keys: [{ keyPrefix: KEY_PREFIX, label: "", scopes: [], environment: "production", createdAt: 1 }],
          }),
      },
      {
        name: "absent label",
        deviceToken: true,
        keys: () =>
          jsonResponse(200, { keys: [{ keyPrefix: KEY_PREFIX, scopes: [], environment: "production", createdAt: 1 }] }),
      },
    ]
    for (const c of cases) {
      const f = await fixture(["a", "b", "cold"])
      const file = await pairsFile(f.dir, "a cold\nb cold\n")
      const o = await runBatch(f, {
        file,
        lines: ["no"],
        deviceToken: c.deviceToken,
        api: c.keys ? { keys: c.keys } : {},
      })
      expect([c.name, o.code]).toEqual([c.name, 1])
      expect([c.name, o.err.includes(`  API key         ${KEY_PREFIX}…  profile pb\n`)]).toEqual([c.name, true])
      expect([c.name, o.err.includes(`(${KEY_LABEL})`)]).toEqual([c.name, false])
      expect([c.name, o.stderrAtPrompt[0]?.endsWith(`\n${controlledByBlock(2)}\n`)]).toEqual([c.name, true])
      expect([c.name, o.linePrompts]).toEqual([c.name, [confirmPrompt(2)]])
      expect([c.name, o.calls.some((call) => call.url.endsWith("/api/v1/agent/keys"))]).toEqual([c.name, c.deviceToken])
    }
  })

  test("T5a: GET /keys is not called when the account read has already refused", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, {
      file,
      deviceToken: true,
      api: { embedded: () => jsonResponse(500, { success: false }) },
    })
    expect(o.code).toBe(1)
    expect(o.err).toContain(
      "Could not confirm which Candle account this API key acts for (HTTP 500); nothing was written.",
    )
    expect(o.calls.some((call) => call.url.endsWith("/api/v1/agent/keys"))).toBe(false)
  })
})

describe("BE-296 T6: the account read is live or the batch refuses", () => {
  test("a network error, a 401, a 500 and a body without account each refuse with PROMOTE_ACCOUNT_UNRESOLVED, before any RPC, prompt or write, despite the cached account", async () => {
    const cases: Array<{ name: string; embedded: RouteHandler; reason: string }> = [
      {
        name: "network",
        embedded: () => {
          throw new Error("ECONNREFUSED")
        },
        reason: "Could not confirm which Candle account this API key acts for (",
      },
      {
        name: "401",
        embedded: () =>
          jsonResponse(401, { success: false, error: { code: "UNAUTHORIZED", message: "Invalid API key" } }),
        reason: "Could not confirm which Candle account this API key acts for (HTTP 401); nothing was written.",
      },
      {
        name: "500",
        embedded: () => jsonResponse(500, { success: false }),
        reason: "Could not confirm which Candle account this API key acts for (HTTP 500); nothing was written.",
      },
      {
        name: "no account",
        embedded: () => jsonResponse(200, { success: true, wallets: {} }),
        reason:
          "Could not confirm which Candle account this API key acts for (the response carried no account); nothing was written.",
      },
    ]
    for (const c of cases) {
      const f = await fixture(["a", "b", "cold"])
      const before = await readEntries(f)
      const file = await pairsFile(f.dir, "a cold\nb cold\n")
      const o = await runBatch(f, { file, api: { embedded: c.embedded } })
      expect([c.name, o.code]).toEqual([c.name, 1])
      expect([c.name, o.err.includes(c.reason)]).toEqual([c.name, true])
      expect(o.err).toContain(
        "Check the key with: candle doctor. Promotion registers the keys to that account, so it does not proceed on a cached value.",
      )
      // The cached profile account is never printed as the answer.
      expect([c.name, o.err.includes("will be controlled by")]).toEqual([c.name, false])
      expect([c.name, o.linePrompts]).toEqual([c.name, []])
      expect([c.name, o.rpc]).toEqual([
        c.name,
        { getMultipleAccounts: 0, getTokenAccountsByOwner: 0, getProgramAccounts: 0 },
      ])
      expect([c.name, o.inits.n]).toEqual([c.name, 0])
      expect([c.name, (await readEntries(f)).generation]).toEqual([c.name, before.generation])
      expect(o.out).not.toContain(SENTENCE_PREFIX)
    }
    // Under --json: the failure envelope with the new code, and nothing else on stdout.
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const j = await runBatch(f, { file, json: true, api: { embedded: () => jsonResponse(500, { success: false }) } })
    expect(j.code).toBe(1)
    const docs = jsonDocuments(j.out)
    expect(docs).toHaveLength(1)
    expect(JSON.parse(docs[0] as string)).toMatchObject({ ok: false, code: "PROMOTE_ACCOUNT_UNRESOLVED" })
  })

  test("no API key at all: the room read (BE-288, D7), which comes first in the batch, refuses before the account read can", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, { file, noApiKey: true })
    expect(o.code).toBe(1)
    expect(o.err).toContain(
      "Could not read how many linked wallets this account has room for (no API key is available). Nothing was written.",
    )
    expect(o.err).not.toContain("will be controlled by")
    expect(o.linePrompts).toEqual([])
    expect(o.rpc.getProgramAccounts).toBe(0)
  })
})

describe("BE-296 T10 to T13: the role check always runs", () => {
  test("T10: nine requests per acting key, no flag; --check-authorities is an unknown-flag usage error; the opening line comes before the first request", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const order: string[] = []
    const o = await runBatch(f, {
      file,
      lines: ["no"],
      rpc: {
        programAccounts: () => {
          order.push("request")
          return []
        },
      },
      deps: {},
    })
    expect(o.code).toBe(1)
    expect(o.rpc.getProgramAccounts).toBe(2 * REQUESTS_PER_KEY)
    const opening =
      "Checking token mint, freeze, program upgrade and stake authorities for 2 addresses: 18 requests over rpc.pb.test."
    expect(o.err.indexOf(opening)).toBeGreaterThan(-1)
    expect(o.err.indexOf(opening)).toBeLessThan(o.err.indexOf("Checking authorities:"))
    expect(o.err.indexOf(opening)).toBeLessThan(o.err.indexOf("✓ authorities read"))

    const flagged = await runBatch(f, { file, args: ["--check-authorities"] })
    expect(flagged.code).toBe(2)
    expect(flagged.err).toContain("--check-authorities")
    expect(flagged.secretPrompts).toBe(0)
    expect(flagged.rpc.getProgramAccounts).toBe(0)
  })

  test("T11: a 403 on the SPL-mint scan names the group not read in the footer and in --json, the sentence is Form U, the column says ?, and the run reaches the prompt", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const programAccounts = (call: ProgramAccountsCall) =>
      groupOfCall(call) === "token-mint" ? jsonResponse(403, { error: "Your IP or provider is blocked" }) : []
    const o = await runBatch(f, { file, lines: ["no"], rpc: { programAccounts } })
    expect(o.code).toBe(1)
    expect(o.linePrompts).toEqual([confirmPrompt(2)])
    expect(o.out).toContain(promoteSentence({ n: 2, form: "U", where: "below" }))
    expect(o.err).toMatch(/^1\s+promote\s+a\s+\S+\s+cold \(…\w+\)\s+\?\s+0\.021400$/m)
    expect(o.err).toContain("Authorities: none found; 1 of 7 groups were not read (see below).")
    expect(o.err).toContain(
      "Authorities read over rpc.pb.test: token freeze, Token-2022 mint, Token-2022 freeze, program upgrade, stake staker, stake withdrawer. Not read: token mint (HTTP 403). Not checked: multisig membership, Token-2022 extension authorities, metadata update authority.",
    )
    expect(o.err).toMatch(/✓ authorities read for 2 addresses \(\d+ requests, 6 of 7 groups read, 1 refused\) in 0s/)

    const j = await runBatch(f, { file, ack: "correct", json: true, rpc: { programAccounts } })
    expect(j.code).toBe(0)
    const body = JSON.parse(jsonDocuments(j.out)[0] as string)
    expect(body.authorities.notChecked).toEqual([{ group: "token-mint", reason: "HTTP 403" }])
    expect(body.authorities.checked).toEqual(ROLE_GROUP_IDS.filter((id) => id !== "token-mint"))
    expect(body.authorities.found).toEqual([])
  })

  test("T12: a request that is aborted (timeout) behaves as a refusal of its group", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, {
      file,
      lines: ["no"],
      rpc: {
        programAccounts: (call) => {
          if (groupOfCall(call) !== "stake-staker") return []
          throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" })
        },
      },
    })
    expect(o.code).toBe(1)
    expect(o.err).toContain("Not read: stake staker (timed out after 20 s).")
    expect(o.out).toContain(promoteSentence({ n: 2, form: "U", where: "below" }))
    expect(o.linePrompts).toEqual([confirmPrompt(2)])
  })

  test("T12b: the progress line is written to stderr with \\r and replaced by the ✓ line; under --json none of it reaches stdout", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, { file, ack: "correct", json: true })
    expect(o.code).toBe(0)
    expect(o.err).toContain("\rChecking authorities: 1 of 18 requests, 0 s elapsed")
    expect(o.err).toContain("\rChecking authorities: 18 of 18 requests, 0 s elapsed")
    expect(o.err).toContain("\r✓ authorities read for 2 addresses (18 requests, 7 of 7 groups read) in 0s\n")
    expect(o.out).not.toContain("Checking authorities")
    expect(o.out).not.toContain("✓ authorities")
    expect(jsonDocuments(o.out)).toHaveLength(1)
  })

  test("T12c: a found stake withdrawer and a found mint on one key: the row, the footer count (keys, not findings), the sentence's k, and --json", async () => {
    const f = await fixture(["a", "b", "cold"])
    const a = f.addresses.a as string
    const mint = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"
    const stake = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const programAccounts = (call: ProgramAccountsCall) => {
      if (!isFor(call, a)) return []
      if (groupOfCall(call) === "stake-withdrawer") return [stake]
      if (groupOfCall(call) === "token-mint") return [mint]
      return []
    }
    const o = await runBatch(f, { file, lines: ["no"], rpc: { programAccounts } })
    expect(o.code).toBe(1)
    expect(o.err).toContain(`  mint authority of ${mint}; withdrawer authority of ${stake}  `)
    expect(o.err).toMatch(/^2\s+promote\s+b\s+\S+\s+cold \(…\w+\)\s+none\s+0\.021400$/m)
    expect(o.err).toContain("Authorities: 1 of 2 keys holds one (2 findings, in the authority column).")
    expect(o.out).toContain(promoteSentence({ n: 2, form: "F", k: 1, where: "below" }))
    expect(o.out).toContain("1 of them holds a mint, freeze, upgrade or stake authority, named below")

    const j = await runBatch(f, { file, ack: "correct", json: true, rpc: { programAccounts } })
    const body = JSON.parse(jsonDocuments(j.out)[0] as string)
    expect(body.authorities.found).toEqual([
      { address: a, role: "mint", target: mint, program: "token" },
      { address: a, role: "withdrawer", target: stake, program: "stake" },
    ])
  })

  test("T13: an upgrade hit resolves its program id with one more request; one that does not resolve prints the ProgramData address and says so", async () => {
    const f = await fixture(["a", "b", "cold"])
    const b = f.addresses.b as string
    const programData = "9BVcYqEQxyccuwznvxXqDkSJFavvTyheiTYk231T1A8S"
    const programId = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
    const orphan = "So11111111111111111111111111111111111111112"
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, {
      file,
      lines: ["no"],
      rpc: {
        programAccounts: (call) => {
          const group = groupOfCall(call)
          if (group === "program-upgrade") return isFor(call, b) ? [programData, orphan] : []
          if (group === "program-resolve") {
            const which = call.filters[1]?.memcmp?.bytes
            return which === base64.encode(base58.decode(programData)) ? [programId] : []
          }
          return []
        },
      },
    })
    expect(o.code).toBe(1)
    // 18 scans plus 2 resolves.
    expect(o.rpc.getProgramAccounts).toBe(20)
    expect(o.err).toContain(
      `upgrade authority of ${programId}; upgrade authority of ${orphan} (ProgramData account; the program id could not be resolved)`,
    )
    expect(o.err).toContain("✓ authorities read for 2 addresses (20 requests, 7 of 7 groups read) in 0s")
  })
})

describe("BE-296 T14, T15: the line header and --json", () => {
  test("T14: the batch table and the refusal table are headed `line`, and the values are the file lines the document carries", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "# plan\n\na cold\n\nb cold\n")
    const o = await runBatch(f, { file, lines: ["no"] })
    expect(o.err).toMatch(/^line\s+state\s+label\s+address\s+destination\s+authority\s+SOL \(tokens not read\)$/m)
    expect(o.err).not.toMatch(/^#\s+state/m)
    expect(o.err).toMatch(/^3\s+promote\s+a\s/m)
    expect(o.err).toMatch(/^5\s+promote\s+b\s/m)
    const j = await runBatch(f, { file, ack: "correct", json: true })
    const body = JSON.parse(jsonDocuments(j.out)[0] as string)
    expect(body.keys.map((k: { line: number }) => k.line)).toEqual([3, 5])

    // The refusal table (row 2 sweeps to a key row 1 promotes).
    const g = await fixture(["p", "q", "cold"])
    const refused = await pairsFile(g.dir, "p cold\nq p\n")
    const r = await runBatch(g, { file: refused })
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/^line\s+label\s+destination\s+code\s+why$/m)
    expect(r.err).not.toMatch(/^#\s+label/m)
  })

  test("T15: success and stopped documents carry controlledBy and authorities; every pre-existing key is unchanged; one JSON value on stdout", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, { file, ack: "correct", json: true, deviceToken: true })
    expect(o.code).toBe(0)
    const docs = jsonDocuments(o.out)
    expect(docs).toHaveLength(1)
    const body = JSON.parse(docs[0] as string)
    expect(Object.keys(body).sort()).toEqual([
      "authorities",
      "complete",
      "controlledBy",
      "destinations",
      "file",
      "keys",
      "ok",
      "promoted",
      "resumed",
      "rows",
      "skipped",
    ])
    expect(body.controlledBy).toEqual({
      account: ACCOUNT,
      username: USERNAME,
      keyPrefix: KEY_PREFIX,
      keyLabel: KEY_LABEL,
      keySource: "profile",
      apiUrl: API,
      environment: null,
    })
    expect(body.authorities).toEqual({ checked: [...ROLE_GROUP_IDS], notChecked: [], found: [] })
    const inOne = [
      ...body.authorities.checked,
      ...body.authorities.notChecked.map((n: { group: string }) => n.group),
    ].sort()
    expect(inOne).toEqual([...ROLE_GROUP_IDS].sort())

    // Stopped mid-run (row 2's submit fails): the same two keys, `keyLabel` null without a device token.
    const g = await fixture(["a", "b", "cold"])
    const gfile = await pairsFile(g.dir, "a cold\nb cold\n")
    const s = await runBatch(g, {
      file: gfile,
      ack: "correct",
      json: true,
      api: {
        submit: (n) =>
          n === 2 ? jsonResponse(500, { success: false, error: { code: "INTERNAL", message: "boom" } }) : undefined,
      },
    })
    expect(s.code).toBe(1)
    const sdocs = jsonDocuments(s.out)
    expect(sdocs).toHaveLength(1)
    const stopped = JSON.parse(sdocs[0] as string)
    expect(stopped).toMatchObject({ ok: false, complete: false, failedLine: 2 })
    expect(stopped.controlledBy).toMatchObject({
      account: ACCOUNT,
      keyPrefix: KEY_PREFIX,
      keyLabel: null,
      keySource: "profile",
    })
    expect(stopped.authorities).toEqual({ checked: [...ROLE_GROUP_IDS], notChecked: [], found: [] })
  })
})
