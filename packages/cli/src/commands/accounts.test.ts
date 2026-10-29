/**
 * `candle accounts create` (cli-account-create spec 5 to 7.2; A7, A8 and A14). The API is a fake
 * fetch; the keychain, the owner files, the runner lock and the reviewed sibling are a fake
 * `AccountsHost`, except in the last block, which drives the real keychain reads through a stub
 * `security` on PATH, the real `flock` holder and a real sibling child (the `keychain.test.ts`
 * pattern).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash, generateKeyPairSync } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ed25519 } from "@noble/curves/ed25519"
import { base58 } from "@scure/base"
import { type Deps, resolveApiKey, resolveDeviceToken } from "../deps"
import { type AccountsHost, liveAccountsHost, type SiblingResult } from "../fleet-accounts"
import { run } from "../index"
import { SecretStoreLockedError } from "../keychain"
import { ProfileFleetOnlyError } from "../profiles"
import { createCapture, createFakeConfigStore, createFakeStore, createTestDeps, jsonResponse } from "../test-support"
import { decodeHeader } from "../x402/codec"
import { siwsMessage } from "../x402/siwx"
import { ACCOUNTS_SIWX_CHAIN_ID } from "./accounts"

const OPS = "/ops/fleet"
const OWNER = "/ops/owner-scripts"
const SIBLING = `${OWNER}/accounts-apikey-sibling.sh`
const SIBLING_BYTES = new TextEncoder().encode("#!/bin/sh\n# reviewed sibling\n")
const SOL_ITEM = "candle-fleet-staging-free-b-sol"
const SIGNER_ITEM = "candle-fleet-staging-free-b-signer"
const APIKEY_ITEM = "candle-fleet-staging-free-b-apikey"
const API_KEY = "cndl_live_0123456789abcdefABCDEF0123456789"
const TERMS = "2026-10-25"

const seed = ed25519.utils.randomPrivateKey()
const PUB = ed25519.getPublicKey(seed)
const SECRET64 = new Uint8Array([...seed, ...PUB])
const K_ITEM_VALUE = base58.encode(SECRET64)
const K = base58.encode(PUB)
const SPKI = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "der" })
const SPKI_B64 = SPKI.toString("base64")
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

function receipt(over: Record<string, unknown> = {}) {
  return json({
    version: 1,
    env: "staging",
    name: "free-b",
    item: SIGNER_ITEM,
    spkiDerBase64: SPKI_B64,
    spkiSha256: sha(SPKI),
    sealedFile: "staging-fleet-free-b-signer-2026-10-28.gpg",
    recipients: 2,
    scriptSha256: "ab".repeat(32),
    createdAt: "2026-10-28T20:00:00Z",
    ...over,
  })
}

const pin = (over: Record<string, unknown> = {}) =>
  json({ version: 1, path: SIBLING, sha256: sha(SIBLING_BYTES), approvedRef: "APPROVED-REGISTER.md#42", ...over })

interface FakeHost extends AccountsHost {
  calls: string[]
  items: Map<string, string>
  files: Map<string, Uint8Array>
  siblingInput: string[]
  lockHeld: boolean
  sibling: (secret: string) => SiblingResult
}

function fakeHost(): FakeHost {
  const host: FakeHost = {
    opsDir: OPS,
    ownerScriptsDir: OWNER,
    calls: [],
    items: new Map([
      [SOL_ITEM, K_ITEM_VALUE],
      [SIGNER_ITEM, "-----BEGIN PRIVATE KEY----- signer pem -----END PRIVATE KEY-----"],
    ]),
    files: new Map([
      [`${OPS}/accounts-apikey-sibling.json`, pin()],
      [SIBLING, SIBLING_BYTES],
      [`${OPS}/signer-receipts/staging-free-b.json`, receipt()],
    ]),
    siblingInput: [],
    lockHeld: false,
    sibling(secret) {
      host.items.set(APIKEY_ITEM, secret)
      return { ok: true }
    },
    async acquireLock(path) {
      host.calls.push(`lock ${path}`)
      if (host.lockHeld) return { ok: false, reason: "held" }
      return { ok: true, lock: { release: async () => void host.calls.push("release") } }
    },
    async itemExists(item) {
      host.calls.push(`exists ${item}`)
      return host.items.has(item)
    },
    async readItem(item) {
      host.calls.push(`read ${item}`)
      return host.items.get(item) ?? null
    },
    async readFile(path) {
      return host.files.get(path) ?? null
    },
    async runSibling(path, args, secret) {
      const text = new TextDecoder().decode(secret)
      host.calls.push(`sibling ${path} ${args.join(" ")}`)
      host.siblingInput.push(text)
      return host.sibling(text)
    },
  }
  return host
}

interface Api {
  requests: { method: string; path: string; headers: Record<string, string>; body: unknown }[]
  create: (body: Record<string, unknown>, header: string) => Response
  nonce: () => Response
  terms: () => Response
}

function fakeApi(): Api & { fetch: typeof fetch } {
  let counter = 0
  const api: Api & { fetch: typeof fetch } = {
    requests: [],
    terms: () => jsonResponse(200, { version: TERMS }),
    nonce: () => {
      counter++
      return jsonResponse(200, {
        nonce: counter.toString(16).padStart(32, "0"),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      })
    },
    create: () =>
      jsonResponse(201, {
        account: K,
        memberId: "j57abcdefghijk",
        memberIdPrefix: "j57abcde",
        wallets: {
          solana: "So1anaTeeWa11et111111111111111111111111111",
          evm: "0x00000000000000000000000000000000000000aa",
        },
        keyPrefix: "cndl_live_0123",
        apiKey: API_KEY,
        scopes: ["account:read", "launch:write"],
        plan: "free",
        createdVia: "test-fleet",
        requestId: "f".repeat(64),
      }),
    fetch: (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const headers = (init?.headers ?? {}) as Record<string, string>
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      api.requests.push({ method: init?.method ?? "GET", path: url.pathname, headers, body })
      if (url.host !== "staging.api.candle.tv" && !url.hostname.startsWith("127.")) {
        throw new Error(`unexpected host ${url.host}`)
      }
      if (url.pathname === "/api/v1/agent/accounts/terms") return api.terms()
      if (url.pathname === "/api/v1/agent/accounts/nonce") return api.nonce()
      if (url.pathname === "/api/v1/agent/accounts") return api.create(body, headers["SIGN-IN-WITH-X"] ?? "")
      throw new Error(`unexpected path ${url.pathname}`)
    }) as unknown as typeof fetch,
  }
  return api
}

interface Setup {
  host: FakeHost
  api: ReturnType<typeof fakeApi>
  deps: Deps
  stdout: ReturnType<typeof createCapture>
  stderr: ReturnType<typeof createCapture>
  config: ReturnType<typeof createFakeConfigStore>
  store: ReturnType<typeof createFakeStore>
}

function setup(over: Partial<Deps> = {}): Setup {
  const host = fakeHost()
  const api = fakeApi()
  const stdout = createCapture()
  const stderr = createCapture()
  const config = createFakeConfigStore()
  const store = createFakeStore()
  const deps = createTestDeps({
    fetch: api.fetch,
    stdout,
    stderr,
    store,
    platform: "darwin",
    accountsHost: host,
    readConfig: config.readConfig,
    writeConfig: config.writeConfig,
    updateProfile: config.updateProfile,
    promptLine: async () => "accept",
    ...over,
  })
  return { host, api, deps, stdout, stderr, config, store }
}

const CREATE = ["accounts", "create", "--env", "staging", "--name", "free-b"]
const envelope = (s: Setup) => JSON.parse(s.stdout.text.trim()) as Record<string, unknown>
const output = (s: Setup) => s.stdout.text + s.stderr.text

/** I2: no form of K, the API key, or the signer item's content, anywhere a person or a log can see. */
function expectNoSecret(s: Setup) {
  const text = output(s)
  for (const secret of [K_ITEM_VALUE, base58.encode(seed), API_KEY, "signer pem", SPKI_B64]) {
    expect(text).not.toContain(secret)
  }
}

describe("A7: refusals before anything is read or sent", () => {
  test("--env production is out of scope, and nothing is touched", async () => {
    const s = setup()
    expect(
      await run(["accounts", "create", "--env", "production", "--name", "free-b", "--json", "--yes"], s.deps),
    ).toBe(2)
    expect(envelope(s).code).toBe("ACCOUNTS_PRODUCTION_OUT_OF_SCOPE")
    expect(s.host.calls).toEqual([])
    expect(s.api.requests).toEqual([])
  })

  test("a store that is not the macOS keychain is refused before any read", async () => {
    const s = setup({ platform: "linux" })
    expect(await run([...CREATE, "--json", "--yes"], s.deps)).toBe(2)
    expect(envelope(s).code).toBe("ACCOUNTS_KEY_STORE_NOT_KEYCHAIN")
    expect(s.host.calls).toEqual([])
    expect(s.api.requests).toEqual([])
  })

  test("--env local refuses a host that is not loopback", async () => {
    const s = setup({ env: { CANDLE_API_URL: "https://api.alpha.candle.tv" } })
    expect(await run(["accounts", "create", "--env", "local", "--name", "free-b", "--json", "--yes"], s.deps)).toBe(2)
    const body = envelope(s)
    expect(body.code).toBe("ACCOUNTS_HOST_NOT_ALLOWED")
    expect(String(body.message)).toContain("api.alpha.candle.tv")
    expect(s.host.calls).toEqual([])
  })

  test("--env staging ignores CANDLE_API_URL and --api-url, and says so", async () => {
    const s = setup({ env: { CANDLE_API_URL: "https://api.alpha.candle.tv" } })
    expect(await run([...CREATE, "--api-url", "https://api.alpha.candle.tv", "--yes"], s.deps)).toBe(0)
    expect(s.stderr.text).toContain("ignores --api-url and CANDLE_API_URL")
    expect(s.api.requests.map((r) => r.path)).toEqual([
      "/api/v1/agent/accounts/terms",
      "/api/v1/agent/accounts/nonce",
      "/api/v1/agent/accounts",
    ])
  })

  test("CANDLE_KEYSTORE_PASSPHRASE is refused", async () => {
    const s = setup({ env: { CANDLE_KEYSTORE_PASSPHRASE: "x" } })
    expect(await run([...CREATE, "--json", "--yes"], s.deps)).toBe(2)
    expect(envelope(s).code).toBe("ENV_PASSPHRASE_REFUSED")
    expect(s.host.calls).toEqual([])
  })

  test("--json without --yes is refused: a machine caller states acceptance", async () => {
    const s = setup()
    expect(await run([...CREATE, "--json"], s.deps)).toBe(2)
    expect(envelope(s).code).toBe("USAGE")
    expect(s.host.calls).toEqual([])
  })

  test("the default username over 30 characters is refused before the nonce, pointing to --username", async () => {
    const s = setup()
    const long = "abcdefghijklmnopq" // 17 characters: fleet-staging-<17> is 31
    expect(await run(["accounts", "create", "--env", "staging", "--name", long, "--json", "--yes"], s.deps)).toBe(2)
    const body = envelope(s)
    expect(body.code).toBe("ACCOUNTS_USERNAME_INVALID")
    expect(String(body.message)).toContain("31 characters")
    expect(String(body.suggestion)).toContain("--username")
    expect(s.host.calls).toEqual([])
    expect(s.api.requests).toEqual([])
  })

  test("a short --username for a long fleet name passes the check and is sent", async () => {
    const s = setup()
    const long = "abcdefghijklmnopq"
    s.host.items.set(`candle-fleet-staging-${long}-sol`, K_ITEM_VALUE)
    s.host.items.set(`candle-fleet-staging-${long}-signer`, "x")
    s.host.files.set(
      `${OPS}/signer-receipts/staging-${long}.json`,
      receipt({ name: long, item: `candle-fleet-staging-${long}-signer` }),
    )
    s.host.sibling = (secret) => {
      s.host.items.set(`candle-fleet-staging-${long}-apikey`, secret)
      return { ok: true }
    }
    const args = ["accounts", "create", "--env", "staging", "--name", long, "--username", "fleet-long", "--yes"]
    expect(await run(args, s.deps)).toBe(0)
    expect((s.api.requests.at(-1)?.body as { username?: string }).username).toBe("fleet-long")
  })

  test("a held runner lock is refused before any security call and any request", async () => {
    const s = setup()
    s.host.lockHeld = true
    expect(await run([...CREATE, "--json", "--yes"], s.deps)).toBe(2)
    expect(envelope(s).code).toBe("ACCOUNTS_RUNNER_LOCKED")
    expect(s.host.calls).toEqual([`lock ${OPS}/runner.lock`])
    expect(s.api.requests).toEqual([])
  })

  test("an existing API-key item is refused even with --yes, and nothing is sent", async () => {
    const s = setup()
    s.host.items.set(APIKEY_ITEM, "the stored key")
    expect(await run([...CREATE, "--json", "--yes"], s.deps)).toBe(2)
    const body = envelope(s)
    expect(body.code).toBe("ACCOUNTS_APIKEY_ITEM_EXISTS")
    expect(String(body.message)).toContain(APIKEY_ITEM)
    expect(s.api.requests).toEqual([])
    expect(s.host.calls).not.toContain(`read ${SOL_ITEM}`)
    expect(s.host.items.get(APIKEY_ITEM)).toBe("the stored key")
    expect(s.host.calls.at(-1)).toBe("release")
  })

  test("a sibling whose bytes differ from the pin is refused", async () => {
    const s = setup()
    s.host.files.set(SIBLING, new TextEncoder().encode("#!/bin/sh\n# edited\n"))
    expect(await run([...CREATE, "--json", "--yes"], s.deps)).toBe(2)
    expect(envelope(s).code).toBe("ACCOUNTS_SIBLING_UNPINNED")
    expect(s.api.requests).toEqual([])
  })

  test("a pin outside the owner-scripts directory is refused", async () => {
    const s = setup()
    s.host.files.set(`${OPS}/accounts-apikey-sibling.json`, pin({ path: "/tmp/sibling.sh" }))
    expect(await run([...CREATE, "--json", "--yes"], s.deps)).toBe(2)
    expect(envelope(s).code).toBe("ACCOUNTS_SIBLING_UNPINNED")
  })

  for (const [label, file] of [
    ["a missing receipt", null],
    ["a receipt whose SPKI does not hash to spkiSha256", receipt({ spkiSha256: "00".repeat(32) })],
    ["a receipt with one recipient", receipt({ recipients: 1 })],
    ["a receipt naming another item", receipt({ item: "candle-fleet-staging-free-c-signer" })],
    ["a receipt that is not JSON", new TextEncoder().encode("{")],
  ] as const) {
    test(`${label} is ACCOUNTS_SIGNER_NOT_SEALED, before any request`, async () => {
      const s = setup()
      if (file === null) s.host.files.delete(`${OPS}/signer-receipts/staging-free-b.json`)
      else s.host.files.set(`${OPS}/signer-receipts/staging-free-b.json`, file)
      expect(await run([...CREATE, "--json", "--yes"], s.deps)).toBe(2)
      expect(envelope(s).code).toBe("ACCOUNTS_SIGNER_NOT_SEALED")
      expect(s.api.requests).toEqual([])
    })
  }

  test("a missing signer item is ACCOUNTS_SIGNER_NOT_SEALED, checked without -w", async () => {
    const s = setup()
    s.host.items.delete(SIGNER_ITEM)
    expect(await run([...CREATE, "--json", "--yes"], s.deps)).toBe(2)
    expect(envelope(s).code).toBe("ACCOUNTS_SIGNER_NOT_SEALED")
    expect(s.host.calls).toContain(`exists ${SIGNER_ITEM}`)
    expect(s.host.calls).not.toContain(`read ${SIGNER_ITEM}`)
    expect(s.api.requests).toEqual([])
  })

  test("a missing identity item names the item and the owner script, and sends no nonce", async () => {
    const s = setup()
    s.host.items.delete(SOL_ITEM)
    expect(await run([...CREATE, "--json", "--yes"], s.deps)).toBe(2)
    const body = envelope(s)
    expect(body.code).toBe("ACCOUNTS_KEY_ITEM_MISSING")
    expect(String(body.message)).toContain(SOL_ITEM)
    expect(String(body.suggestion)).toContain("fleet-account.sh")
    expect(s.api.requests.map((r) => r.path)).toEqual(["/api/v1/agent/accounts/terms"])
  })

  test("without a terminal and without the D10 approval: ACCOUNTS_ATTENDED_REQUIRED", async () => {
    const s = setup({ isTTY: { stdin: false, stdout: false, stderr: false } })
    expect(await run([...CREATE, "--json", "--yes"], s.deps)).toBe(2)
    expect(envelope(s).code).toBe("ACCOUNTS_ATTENDED_REQUIRED")
    expect(s.host.calls).toEqual([])
    expect(s.api.requests).toEqual([])
  })

  test("activation.json's exact D10 approval admits an unattended call; anything else does not", async () => {
    for (const [value, code] of [
      [{ accountsCreateUnattended: "true" }, 2],
      [{ accountsCreateUnattended: true }, 0],
    ] as const) {
      const s = setup({ isTTY: { stdin: false, stdout: false, stderr: false } })
      s.host.files.set(`${OPS}/activation.json`, json(value))
      expect(await run([...CREATE, "--json", "--yes"], s.deps)).toBe(code)
    }
  })

  test("never reads the signer with -w and never makes a signer", async () => {
    const s = setup()
    expect(await run([...CREATE, "--yes"], s.deps)).toBe(0)
    expect(s.host.calls.filter((c) => c.startsWith("read "))).toEqual([`read ${SOL_ITEM}`])
    for (const file of ["accounts.ts", "../fleet-accounts.ts"]) {
      const source = await readFile(join(import.meta.dir, file), "utf8")
      expect(source).not.toContain("generateSignerKeypair")
      expect(source).not.toContain("generateKeyPair")
    }
  })
})

describe("the success path", () => {
  test("signs create_account for K on mainnet, hands the key to the sibling and stores public fields only", async () => {
    const s = setup()
    expect(await run([...CREATE, "--yes"], s.deps)).toBe(0)
    const create = s.api.requests.at(-1)
    expect(create?.method).toBe("POST")
    expect(create?.body).toEqual({ name: "free-b", termsVersion: TERMS, signerPublicKey: SPKI_B64 })
    const proof = decodeHeader(create?.headers["SIGN-IN-WITH-X"] ?? "")
    expect(proof.statement).toBe(`Candle x402 create_account ${K}`)
    expect(proof.address).toBe(K)
    expect(proof.chainId).toBe(ACCOUNTS_SIWX_CHAIN_ID)
    expect(proof.chainId).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")
    expect(proof.domain).toBe("staging.api.candle.tv")
    expect(proof.uri).toBe("https://staging.api.candle.tv/api/v1/agent/accounts")
    const message = siwsMessage(
      proof as unknown as Parameters<typeof siwsMessage>[0],
      K,
      `Candle x402 create_account ${K}`,
    )
    expect(ed25519.verify(base58.decode(proof.signature as string), new TextEncoder().encode(message), PUB)).toBe(true)
    // 4.3: issued at most five minutes before it expires, dated from the server's own clock.
    expect(Date.parse(proof.expirationTime as string) - Date.parse(proof.issuedAt as string)).toBe(300_000)

    expect(s.host.siblingInput).toEqual([API_KEY])
    expect(s.host.calls).toContain(`sibling ${SIBLING} staging free-b`)
    expect(s.host.calls.at(-1)).toBe("release")
    const profile = (await s.config.readConfig()).profiles?.["staging-free-b"]
    expect(profile).toEqual({
      apiUrl: "https://staging.api.candle.tv",
      account: K,
      username: "fleet-staging-free-b",
      keyPrefix: "cndl_live_0123",
      scopes: ["account:read", "launch:write"],
      label: "test fleet staging-free-b",
      apiKeyItem: APIKEY_ITEM,
    })
    expect((await s.config.readConfig()).activeProfile).toBeUndefined()
    expect(await s.store.get("profile:staging-free-b:api_key")).toBeNull()
    expect(s.stdout.text).toContain("Created staging test member fleet-staging-free-b")
    expect(s.stdout.text).toContain("Tag: test-fleet (excluded from KPI). Plan: Free. Terms: 2026-10-25 accepted.")
    expect(s.stdout.text).toContain(`Signer item ${SIGNER_ITEM} was sealed before this run.`)
    expectNoSecret(s)
  })

  test("--json is one object, without the key or the signer", async () => {
    const s = setup()
    expect(await run([...CREATE, "--json", "--yes", "--use"], s.deps)).toBe(0)
    const lines = s.stdout.text.trim().split("\n")
    expect(lines).toHaveLength(1)
    const body = JSON.parse(lines[0] as string)
    expect(body).toMatchObject({ ok: true, account: K, apiKeyItem: APIKEY_ITEM, profile: "staging-free-b" })
    expect(body.apiKey).toBeUndefined()
    expect((await s.config.readConfig()).activeProfile).toBe("staging-free-b")
    expectNoSecret(s)
  })

  test("the typed confirm is required without --yes, and a refusal sends no nonce", async () => {
    const s = setup({ promptLine: async () => "no" })
    expect(await run(CREATE, s.deps)).toBe(1)
    expect(s.stderr.text).toContain("Not accepted")
    expect(s.api.requests.map((r) => r.path)).toEqual(["/api/v1/agent/accounts/terms"])
  })

  test("an existing profile needs --yes", async () => {
    const s = setup()
    await s.config.updateProfile("staging-free-b", { apiUrl: "https://staging.api.candle.tv" })
    expect(await run(CREATE, s.deps)).toBe(2)
    expect(s.stderr.text).toContain("already exists")
    expect(s.host.calls).toEqual([])
  })

  test("--profile names the profile it creates", async () => {
    const s = setup()
    expect(await run([...CREATE, "--profile", "fleet-b", "--yes"], s.deps)).toBe(0)
    expect((await s.config.readConfig()).profiles?.["fleet-b"]?.apiKeyItem).toBe(APIKEY_ITEM)
  })

  test("a refused nonce is fetched again once, then the command stops", async () => {
    const s = setup()
    let calls = 0
    const created = s.api.create
    s.api.create = (body, header) => {
      calls++
      if (calls === 1) {
        return jsonResponse(401, { error: { code: "SIWX_INVALID", message: "refused", reason: "invalid_siwx_nonce" } })
      }
      return created(body, header)
    }
    expect(await run([...CREATE, "--yes"], s.deps)).toBe(0)
    expect(s.api.requests.filter((r) => r.path.endsWith("/nonce"))).toHaveLength(2)

    const t = setup()
    t.api.create = () =>
      jsonResponse(401, { error: { code: "SIWX_INVALID", message: "refused", reason: "invalid_siwx_nonce" } })
    expect(await run([...CREATE, "--json", "--yes"], t.deps)).toBe(1)
    expect(t.api.requests.filter((r) => r.path.endsWith("/nonce"))).toHaveLength(2)
    expect(envelope(t).code).toBe("SIWX_INVALID")
  })
})

describe("A8: no secret on the 202, 409, 429 and 404 paths, and --json stays one object", () => {
  const cases: [string, () => Response, number, string][] = [
    [
      "202",
      () => jsonResponse(202, { status: "fulfilment_pending", requestId: "a".repeat(64), step: "wallets" }),
      3,
      "ACCOUNTS_FULFILMENT_PENDING",
    ],
    [
      "409",
      () =>
        jsonResponse(409, {
          error: { code: "ACCOUNT_EXISTS", message: "exists", data: { account: K, createdVia: "x402" } },
        }),
      1,
      "ACCOUNT_EXISTS",
    ],
    [
      "429",
      () =>
        jsonResponse(429, {
          error: {
            code: "ACCOUNTS_DAILY_CAP",
            message: `cap reached for ${K_ITEM_VALUE}`,
            data: { cap: 5, createdToday: 5, resetsAt: "2026-10-30T00:00:00Z" },
          },
        }),
      1,
      "ACCOUNTS_DAILY_CAP",
    ],
    [
      "409 SIGNER_MISMATCH",
      () => jsonResponse(409, { error: { code: "SIGNER_MISMATCH", message: "different signer" } }),
      1,
      "SIGNER_MISMATCH",
    ],
    ["404", () => new Response("Not Found", { status: 404 }), 1, "ACCOUNTS_ROUTES_OFF"],
  ]
  for (const [label, response, exit, code] of cases) {
    for (const mode of ["human", "json"] as const) {
      test(`${label} (${mode})`, async () => {
        const s = setup()
        s.api.create = response
        const args = mode === "json" ? [...CREATE, "--json", "--yes"] : [...CREATE, "--yes"]
        expect(await run(args, s.deps)).toBe(exit)
        if (mode === "json") {
          const lines = s.stdout.text.trim().split("\n")
          expect(lines).toHaveLength(1)
          expect(JSON.parse(lines[0] as string).code).toBe(code)
        }
        expect(s.host.siblingInput).toEqual([])
        expect(s.host.calls.at(-1)).toBe("release")
        expectNoSecret(s)
      })
    }
  }

  test("202 prints the request id and the rerun command", async () => {
    const s = setup()
    s.api.create = () => jsonResponse(202, { status: "fulfilment_pending", requestId: "a".repeat(64), step: "quorum" })
    expect(await run([...CREATE, "--json", "--yes"], s.deps)).toBe(3)
    expect(envelope(s).details).toEqual({
      requestId: "a".repeat(64),
      step: "quorum",
      rerun: `candle accounts create --env staging --name free-b --key-item ${SOL_ITEM} --signer-item ${SIGNER_ITEM} --profile staging-free-b --yes --json`,
    })
  })

  for (const mode of [[], ["--yes"], ["--yes", "--json"], ["--yes", "--json", "--use"]]) {
    test(`202 replay preserves the checkpoint, receipt, destination and mode: ${mode.join(" ")}`, async () => {
      const s = setup()
      s.host.items.set("custom-sol", K_ITEM_VALUE)
      s.host.items.delete(SOL_ITEM)
      s.host.items.set("custom-signer", "sealed signer")
      s.host.items.delete(SIGNER_ITEM)
      s.host.files.set(`${OPS}/signer-receipts/staging-free-b.json`, receipt({ item: "custom-signer" }))
      const created = s.api.create
      let checkpoint = ""
      let inputs: Record<string, unknown> = {}
      let calls = 0
      s.api.create = (body, header) => {
        const proof = decodeHeader(header)
        const requestId = sha(new TextEncoder().encode(`test-fleet|staging|${body.name}|${proof.address}`))
        if (calls++ === 0) {
          checkpoint = requestId
          inputs = body
          return jsonResponse(202, { requestId, step: "quorum" })
        }
        expect(requestId).toBe(checkpoint)
        expect(body).toEqual(inputs)
        expect(body.signerPublicKey).toBe(SPKI_B64)
        return created(body, header)
      }
      // Scope syntax is passed to the API for validation. Even shell metacharacters must be
      // quoted as data in a recovery command, never interpreted by the owner's shell.
      const scope = "account:read,'$(printf injected)'"
      expect(
        await run(
          [
            ...CREATE,
            "--key-item",
            "custom-sol",
            "--signer-item",
            "custom-signer",
            "--profile",
            "fleet-custom",
            "--username",
            "fleet_custom",
            "--scopes",
            scope,
            ...mode,
          ],
          s.deps,
        ),
      ).toBe(3)
      const command = mode.includes("--json")
        ? (envelope(s).details as { rerun: string }).rerun
        : s.stderr.text.split("Run again with the same signer: ")[1]?.split("\n")[0]
      expect(command).toBeDefined()
      const words = spawnSync("/bin/sh", ["-c", `set -- ${command}; printf '%s\\0' "$@"`], { encoding: "utf8" })
      expect(words.status).toBe(0)
      const replay = words.stdout.split("\0").slice(0, -1)
      expect(replay[0]).toBe("candle")
      expect(replay.slice(replay.indexOf("--scopes") + 1)[0]).toBe(scope)
      expect(replay.includes("--json")).toBe(mode.includes("--json"))
      expect(replay.includes("--yes")).toBe(mode.includes("--yes"))
      expect(replay.includes("--use")).toBe(mode.includes("--use"))
      s.stdout.text = ""
      s.stderr.text = ""
      expect(await run(replay.slice(1), s.deps)).toBe(0)
      expect(calls).toBe(2)
      expect((await s.config.readConfig()).profiles?.["fleet-custom"]?.apiKeyItem).toBe(APIKEY_ITEM)
      expect((await s.config.readConfig()).activeProfile).toBe(mode.includes("--use") ? "fleet-custom" : undefined)
      expectNoSecret(s)
    })
  }

  test("local replay includes the original loopback destination", async () => {
    const s = setup({ env: { CANDLE_API_URL: "http://127.0.0.1:4567" } })
    s.host.files.set(
      `${OPS}/signer-receipts/local-free-b.json`,
      receipt({ env: "local", item: "candle-fleet-local-free-b-signer" }),
    )
    s.host.items.set("candle-fleet-local-free-b-sol", K_ITEM_VALUE)
    s.host.items.set("candle-fleet-local-free-b-signer", "sealed")
    s.api.create = () => jsonResponse(202, { requestId: "r", step: "quorum" })
    expect(await run(["accounts", "create", "--env", "local", "--name", "free-b", "--yes", "--json"], s.deps)).toBe(3)
    const command = (envelope(s).details as { rerun: string }).rerun
    const result = spawnSync("/bin/sh", ["-c", `candle() { /usr/bin/printenv CANDLE_API_URL; }; ${command}`], {
      encoding: "utf8",
    })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(s.deps.env.CANDLE_API_URL as string)
  })

  test("a resume whose key was used returns no plaintext and stores nothing", async () => {
    const s = setup()
    s.api.create = () => jsonResponse(200, { account: K, keyPrefix: "cndl_live_0123", requestId: "r", apiKey: null })
    expect(await run([...CREATE, "--json", "--yes"], s.deps)).toBe(1)
    expect(envelope(s).code).toBe("ACCOUNTS_KEY_NOT_RETURNED")
    expect(String(envelope(s).suggestion)).toContain("POST /api/v1/agent/x402/keys")
    expect(s.host.siblingInput).toEqual([])
    expect((await s.config.readConfig()).profiles).toBeUndefined()
  })
})

describe("A14: a local failure after the 201", () => {
  test("the sibling failing exits 3, prints no secret and writes no profile:*:api_key", async () => {
    const s = setup()
    s.host.sibling = (secret) => ({ ok: false, exitCode: 1, detail: `could not seal ${secret}` })
    expect(await run([...CREATE, "--yes"], s.deps)).toBe(3)
    expect(s.stderr.text).toContain("API-key storage could not be confirmed")
    expect(s.stderr.text).toContain("[redacted]")
    expect(await s.store.get("profile:staging-free-b:api_key")).toBeNull()
    expect((await s.config.readConfig()).profiles).toBeUndefined()
    expect(s.host.calls.at(-1)).toBe("release")
    expectNoSecret(s)
  })

  test("--json: the same failure is one envelope with the code", async () => {
    const s = setup()
    s.host.sibling = () => ({ ok: false, exitCode: 1, detail: "" })
    expect(await run([...CREATE, "--json", "--yes"], s.deps)).toBe(3)
    expect(envelope(s).code).toBe("ACCOUNTS_APIKEY_STORE_FAILED")
    expectNoSecret(s)
  })

  test("a sibling that refuses because the item appeared meanwhile exits 3 and leaves the item unchanged", async () => {
    const s = setup()
    const created = s.api.create
    s.api.create = (body, header) => {
      s.host.items.set(APIKEY_ITEM, "stored by another route")
      return created(body, header)
    }
    s.host.sibling = () => ({ ok: false, exitCode: 1, detail: "Nothing changed: the item exists" })
    expect(await run([...CREATE, "--json", "--yes"], s.deps)).toBe(3)
    expect(envelope(s).code).toBe("ACCOUNTS_APIKEY_STORE_FAILED")
    expect(s.host.items.get(APIKEY_ITEM)).toBe("stored by another route")
    expectNoSecret(s)
  })

  test("a sibling edited after the pin check is not run", async () => {
    const s = setup()
    const created = s.api.create
    s.api.create = (body, header) => {
      s.host.files.set(SIBLING, new TextEncoder().encode("#!/bin/sh\ncat > /tmp/stolen\n"))
      return created(body, header)
    }
    expect(await run([...CREATE, "--json", "--yes"], s.deps)).toBe(3)
    expect(envelope(s).code).toBe("ACCOUNTS_APIKEY_STORE_FAILED")
    expect(s.host.siblingInput).toEqual([])
  })

  test("a sibling that exits 0 without setting the item is a failed store", async () => {
    const s = setup()
    s.host.sibling = () => ({ ok: true })
    expect(await run([...CREATE, "--json", "--yes"], s.deps)).toBe(3)
    expect(envelope(s).code).toBe("ACCOUNTS_APIKEY_STORE_FAILED")
  })

  for (const phase of ["sibling", "verification", "pin read"] as const) {
    test(`a thrown ${phase} failure after 201 exits 3, wipes, redacts and releases`, async () => {
      const s = setup()
      let bytes: Uint8Array | undefined
      const sibling = s.host.runSibling
      s.host.runSibling = async (path, args, secret) => {
        bytes = secret
        if (phase === "sibling") throw new Error(`spawn failed for ${API_KEY} and ${K_ITEM_VALUE}`)
        return sibling(path, args, secret)
      }
      const exists = s.host.itemExists
      s.host.itemExists = async (item) => {
        if (phase === "verification" && item === APIKEY_ITEM && bytes) throw new SecretStoreLockedError()
        return exists(item)
      }
      const read = s.host.readFile
      let siblingReads = 0
      s.host.readFile = async (path) => {
        if (path === SIBLING && ++siblingReads === 2 && phase === "pin read") throw new Error("read failed")
        return read(path)
      }
      expect(await run([...CREATE, "--yes", "--json"], s.deps)).toBe(3)
      expect(envelope(s).code).toBe("ACCOUNTS_APIKEY_STORE_FAILED")
      expect(String(envelope(s).message)).toContain("may already exist")
      expect(String(envelope(s).suggestion)).toContain("Do not rerun while either exists")
      if (bytes) expect([...bytes].every((n) => n === 0)).toBe(true)
      if (phase === "verification") expect(s.host.items.get(APIKEY_ITEM)).toBe(API_KEY)
      expect((await s.config.readConfig()).profiles).toBeUndefined()
      expect(await s.store.get("profile:staging-free-b:api_key")).toBeNull()
      expect(s.host.calls.at(-1)).toBe("release")
      expectNoSecret(s)
    })
  }
})

describe("fleet profiles preserve the section 6 / R9.3 custody boundary", () => {
  for (const itemState of ["present", "missing", "locked"] as const) {
    test(`create then resolve with a ${itemState} fleet item refuses ordinary access before any secret read`, async () => {
      const s = setup()
      expect(await run([...CREATE, "--yes"], s.deps)).toBe(0)
      expect(s.stdout.text).not.toContain(" doctor")
      if (itemState === "missing") s.host.items.delete(APIKEY_ITEM)
      const calls = [...s.host.calls]
      s.host.readItem = async (item) => {
        s.host.calls.push(`unexpected read ${item}`)
        if (itemState === "locked") throw new SecretStoreLockedError()
        return s.host.items.get(item) ?? null
      }
      s.store.get = async () => {
        throw new Error("must not fall back to another secret slot")
      }
      for (const resolver of [resolveApiKey, resolveDeviceToken]) {
        await expect(resolver(s.deps, "staging-free-b")).rejects.toBeInstanceOf(ProfileFleetOnlyError)
      }
      // Environment overrides cannot turn a fleet profile into an unguarded identity either.
      s.deps.env.CANDLE_API_KEY = "unrelated-env-key"
      s.deps.env.CANDLE_DEVICE_TOKEN = "unrelated-device-token"
      for (const resolver of [resolveApiKey, resolveDeviceToken]) {
        await expect(resolver(s.deps, "staging-free-b")).rejects.toBeInstanceOf(ProfileFleetOnlyError)
      }
      s.stdout.text = ""
      s.stderr.text = ""
      const requests = s.api.requests.length
      expect(await run(["--profile", "staging-free-b", "doctor", "--json"], s.deps)).toBe(1)
      expect(envelope(s).code).toBe("ACCOUNTS_FLEET_RUNNER_REQUIRED")
      expect(String(envelope(s).message)).toContain("separate custody decision")
      expect(s.host.calls).toEqual(calls)
      expect(s.api.requests).toHaveLength(requests)
      expectNoSecret(s)
    })
  }
})

// ---- the real keychain reads, flock holder and sibling child ------------------------------------

const SECURITY_STUB = `#!/bin/bash
# Stub of macOS security: generic passwords as files named by SERVICE under $STUB_STATE_DIR.
set -u
printf '%s\\n' "$*" >> "$ARGV_CAPTURE"
[ "\${1:-}" = "find-generic-password" ] || exit 1
shift
service=""; account=""; want=0
while [ $# -gt 0 ]; do
  case "$1" in
    -s) service="$2"; shift 2 ;;
    -a) account="$2"; shift 2 ;;
    -w) want=1; shift ;;
    *) shift ;;
  esac
done
[ "$account" = "candle" ] || exit 44
[ -f "$STUB_STATE_DIR/$service" ] || exit 44
if [ "$want" = "1" ]; then cat "$STUB_STATE_DIR/$service"; else echo "keychain: attributes only"; fi
exit 0
`

const perl = spawnSync("/usr/bin/perl", ["-e", "exit 0"]).status === 0

describe.skipIf(!perl)("the live host, with a stub security, the real flock and a real sibling child", () => {
  let dir: string
  let savedPath: string | undefined
  let host: AccountsHost

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "candle-accounts-"))
    const bin = join(dir, "bin")
    const state = join(dir, "state")
    const ops = join(dir, "ops")
    const owner = join(dir, "owner-scripts")
    for (const d of [bin, state, ops, join(ops, "signer-receipts"), owner]) await mkdir(d, { recursive: true })
    await writeFile(join(bin, "security"), SECURITY_STUB)
    await chmod(join(bin, "security"), 0o755)
    // The sibling stores the key where the stub keychain reads it, as the reviewed one sets the item.
    const sibling = join(owner, "accounts-apikey-sibling.sh")
    const siblingBytes = `#!/bin/bash\nset -eu\n[ "$1" = staging ] && [ "$2" = free-b ]\n[ ! -e "${state}/candle-fleet-$1-$2-apikey" ] || { echo "Nothing changed" >&2; exit 1; }\ncat > "${state}/candle-fleet-$1-$2-apikey"\n`
    await writeFile(sibling, siblingBytes)
    await chmod(sibling, 0o700)
    await writeFile(
      join(ops, "accounts-apikey-sibling.json"),
      JSON.stringify({
        version: 1,
        path: sibling,
        sha256: sha(new TextEncoder().encode(siblingBytes)),
        approvedRef: "APPROVED-REGISTER.md#42",
      }),
    )
    await writeFile(join(ops, "signer-receipts", "staging-free-b.json"), receipt())
    await writeFile(join(state, SOL_ITEM), K_ITEM_VALUE)
    await writeFile(join(state, SIGNER_ITEM), "-----BEGIN PRIVATE KEY----- signer pem -----END PRIVATE KEY-----")
    savedPath = process.env.PATH
    process.env.PATH = `${bin}:${process.env.PATH}`
    process.env.ARGV_CAPTURE = join(dir, "argv")
    process.env.STUB_STATE_DIR = state
    host = { ...liveAccountsHost(), opsDir: ops, ownerScriptsDir: owner }
  })

  afterEach(async () => {
    process.env.PATH = savedPath
    delete process.env.ARGV_CAPTURE
    delete process.env.STUB_STATE_DIR
    await rm(dir, { recursive: true, force: true })
  })

  test("creates, stores the key through the sibling, and never asks security for the signer's secret", async () => {
    const s = setup({ accountsHost: host })
    expect(await run([...CREATE, "--yes"], s.deps)).toBe(0)
    expect(await readFile(join(dir, "state", APIKEY_ITEM), "utf8")).toBe(API_KEY)
    const argv = (await readFile(join(dir, "argv"), "utf8")).trim().split("\n")
    expect(argv).toContain(`find-generic-password -s ${SIGNER_ITEM} -a candle`)
    expect(argv).toContain(`find-generic-password -s ${SOL_ITEM} -a candle -w`)
    expect(argv.filter((line) => line.includes(SIGNER_ITEM) && line.endsWith("-w"))).toEqual([])
    expect(argv.join("\n")).not.toContain(API_KEY)
    expectNoSecret(s)

    // A second run finds the stored item and stops before the nonce, with the server untouched.
    const again = setup({ accountsHost: host })
    expect(await run([...CREATE, "--json", "--yes"], again.deps)).toBe(2)
    expect(envelope(again).code).toBe("ACCOUNTS_APIKEY_ITEM_EXISTS")
    expect(again.api.requests).toEqual([])
  })

  test("a second holder of the runner lock is refused while the first holds it", async () => {
    const first = await host.acquireLock(join(dir, "ops", "runner.lock"))
    expect(first.ok).toBe(true)
    const s = setup({ accountsHost: host })
    expect(await run([...CREATE, "--json", "--yes"], s.deps)).toBe(2)
    expect(envelope(s).code).toBe("ACCOUNTS_RUNNER_LOCKED")
    expect(await readFile(join(dir, "argv"), "utf8").catch(() => "")).toBe("")
    if (first.ok) await first.lock.release()
    const after = await host.acquireLock(join(dir, "ops", "runner.lock"))
    expect(after.ok).toBe(true)
    if (after.ok) await after.lock.release()
  })
})
