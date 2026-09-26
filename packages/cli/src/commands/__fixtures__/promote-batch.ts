/**
 * The shared harness for `candle vault promote-batch`'s tests (BE-285, BE-288, BE-296): a real vault,
 * a fake API and a fake RPC, and `runBatch`, which drives the command and records what it saw.
 *
 * It lives here, not in a `.test.ts`, so that two test files can share it. The suite was one file of
 * about 280 s, which alone set the floor of a CI test shard (`scripts/ci/cli-test-shard.ts`). Split
 * in two, it spreads across the shards like any other file.
 */
import { expect } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Deps } from "../../deps"
import { run } from "../../index"
import {
  createCapture,
  createFakeStore,
  createRoutedFetch,
  createTestDeps,
  jsonResponse,
  type RouteHandler,
  signerView,
} from "../../test-support"
import type { KeyEntry } from "../../vault/format"
import { SENTENCE_PREFIX } from "../../vault/promote-support"
import { closeVault, commitVault, unlockWithPassphrase } from "../../vault/store"
import { makeVault } from "../../vault/test-vault"

export const ACCOUNT = "PBAccountABCDEFGH1234567890xyzabcd"
export const USERNAME = "pb-operator"
export const API = "https://api.pb.test"
/** A key in the server's shape (BE-296, D4): `cndl_live_` then 43 characters; the prefix is the first 8. */
export const KEY_PREFIX = "pbpbpbpb"
export const API_KEY = `cndl_live_${KEY_PREFIX.padEnd(43, "x")}`
export const DEVICE_TOKEN = "dt_pb_device_token"
export const KEY_LABEL = "vault-promote"
export const RPC = "https://rpc.pb.test/rpc"
const SYSTEM_PROGRAM = "11111111111111111111111111111111"
export const CLOCK = { now: () => Date.now(), sleep: async () => {} } as never

const ENCRYPTION_PUBLIC_KEY = await (async () => {
  const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  return Buffer.from(await crypto.subtle.exportKey("raw", receiver.publicKey)).toString("base64")
})()

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────────

export interface Fixture {
  dir: string
  path: string
  passphrase: string
  /** Label -> address, for every key `keys` derived. */
  addresses: Record<string, string>
}

export async function unreachable(): Promise<never> {
  throw new Error("no network in this step")
}

/** A real vault with one `role: "vault"` key per label, derived through `vault new-key`. */
export async function fixture(labels: string[]): Promise<Fixture> {
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
export async function newKeys(dir: string, passphrase: string, count: number): Promise<Record<string, string>> {
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

export async function openVault(f: Fixture) {
  return unlockWithPassphrase(f.path, await readFile(f.path, "utf8"), f.passphrase)
}

export async function readEntries(f: Fixture): Promise<{ generation: number; entries: KeyEntry[] }> {
  const v = await openVault(f)
  try {
    return { generation: v.file.generation, entries: v.index.entries }
  } finally {
    closeVault(v)
  }
}

/** Rewrites entries through the real write path, with none of the commands' guards. */
export async function seed(f: Fixture, mutate: (entry: KeyEntry) => KeyEntry): Promise<void> {
  const v = await openVault(f)
  try {
    await commitVault(v, { index: { hd: v.index.hd, entries: v.index.entries.map(mutate) } }, CLOCK)
  } finally {
    closeVault(v)
  }
}

export const teeSeed = (
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

export async function pairsFile(dir: string, contents: string, name = "promote-plan.txt"): Promise<string> {
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
export interface ProgramAccountsCall {
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
      // BE-318: a mint-group call asks for the 4-byte COption tag back. Every hit this fake
      // returns is a live authority, so it answers the slice of `01 00 00 00`.
      const slice = (body.params[1] as { dataSlice?: { offset: number; length: number } }).dataSlice
      const data = Buffer.from([1, 0, 0, 0].slice(slice?.offset ?? 0, (slice?.offset ?? 0) + (slice?.length ?? 0)))
      return jsonResponse(200, {
        jsonrpc: "2.0",
        id: body.id,
        result: (answer ?? []).map((pubkey) => ({ pubkey, account: { data: [data.toString("base64"), "base64"] } })),
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
  /** `POST /agent/tee-wallets/rebind` (BE-322). Default: a server without the route (404). */
  rebind?: RouteHandler | RouteHandler[]
  /** Any other route, keyed by pathname (BE-322: `GET /agent/keys/<prefix>/wallets`). Spread last. */
  routes?: Record<string, RouteHandler | RouteHandler[]>
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
    "/api/v1/agent/tee-wallets/rebind": opts.rebind ?? (() => jsonResponse(404, { error: "Not Found" })),
    // Key signers: the `--to-key` targets these tests name have no signer (today's path).
    "/api/v1/agent/keys/Ab3dEf9h/signer": () => signerView("Ab3dEf9h"),
    ...(opts.routes ?? {}),
  }
}

export const grantedWallets =
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

export interface Outcome {
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

export async function runBatch(f: Fixture, opts: RunOptions): Promise<Outcome> {
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
export function jsonDocuments(out: string): string[] {
  return out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => !line.startsWith(SENTENCE_PREFIX))
}

/** The D4 block as this harness's fixture renders it: profile `pb`, the URL from CANDLE_API_URL, no Candle host. */
export function controlledByBlock(n: number, opts: { label?: string; username?: string | null } = {}): string {
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

export function batchRefusal(o: Outcome): { rows: Array<Record<string, string | number>>; message: string } {
  const docs = jsonDocuments(o.out)
  expect(docs).toHaveLength(1)
  const body = JSON.parse(docs[0] as string)
  expect(body.ok).toBe(false)
  expect(body.code).toBe("PROMOTE_BATCH_REFUSED")
  return body
}
