/** A1 operator acceptance: only fake HTTP and a throwaway local store. */
import { describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { run } from "../index"
import { keySignerFingerprint, keySignerRef, spkiSha256Of } from "../key-signers"
import { SecretStoreLockedError } from "../keychain"
import { pemToStoredSigner } from "../secret-store"
import {
  createCapture,
  createFakeConfigStore,
  createFakeStore,
  createRoutedFetch,
  createTestDeps,
  jsonResponse,
} from "../test-support"

const API_KEY = `cndl_test_${"abcdefgh"}${"q".repeat(35)}`
const TOKEN = `cndl_dvc_${"z".repeat(43)}`
const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
const der = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64")
const sha = spkiSha256Of(der)
const entry = {
  keyPrefix: "abcdefgh",
  spkiSha256: sha,
  publicKeyDer: der,
  fingerprint: keySignerFingerprint(sha),
  signerQuorumId: "q-local",
  createdAt: 0,
}
const wallet = { id: "W1", address: "address", chain: "solana", privyWalletId: "pw1", signerQuorumId: "q-local" }
const view = {
  keyPrefix: entry.keyPrefix,
  state: "active",
  fingerprint: entry.fingerprint,
  spkiSha256: sha,
  publicKeyDer: der,
  signerQuorumId: "q-local",
  pending: null,
  wallets: { onSigner: [wallet], legacy: [], moving: [] },
}

type Row = { id: string; check: string; state: string; detail: string }
function fixture(
  opts: {
    paused?: boolean
    scopes?: string[]
    embedded?: boolean
    reachable?: boolean
    status?: number
    device?: boolean
    signers?: boolean
    old?: boolean
    /** BE-500: `teeReadiness` on GET /keys/self/limits; absent means an API that predates it. */
    readiness?: unknown
    /** BE-500: the chain of the key's one TEE wallet. */
    chain?: string
    /** BE-503: `embeddedWalletPermission` on GET /wallets/embedded; absent as an older API answers. */
    permission?: "allowed" | "denied"
  } = {},
) {
  const stdout = createCapture(),
    stderr = createCapture()
  const { fetch, calls } = createRoutedFetch({
    "/api/v1/status": () => jsonResponse(200, {}),
    "/api/v1/agent/keys": () => jsonResponse(200, { keys: [] }),
    "/api/v1/agent/wallets/trading": () =>
      jsonResponse(
        opts.status ?? 200,
        opts.status
          ? { error: { code: "API_KEY_INVALID", message: "revoked" } }
          : opts.old
            ? { paused: opts.paused }
            : {
                scopes: opts.scopes ?? ["swap:write"],
                paused: opts.paused,
                page: [{ ...wallet, chain: opts.chain ?? wallet.chain, active: opts.reachable !== false }],
                isDone: true,
              },
      ),
    "/api/v1/agent/tier": () => jsonResponse(200, { tier: "free" }),
    "/api/v1/agent/wallets/embedded": () =>
      jsonResponse(200, {
        wallets: { solana: { delegated: opts.embedded ?? false }, evm: null },
        ...(opts.permission !== undefined ? { embeddedWalletPermission: opts.permission } : {}),
      }),
    "/api/v1/agent/keys/self/signer": () => jsonResponse(200, view),
    "/api/v1/agent/keys/self/limits": () =>
      jsonResponse(200, { keyLimits: null, ...(opts.readiness !== undefined ? { teeReadiness: opts.readiness } : {}) }),
    "/releases/latest/download/latest.json": () =>
      jsonResponse(200, {
        version: "0.11.10",
        tag: "cli-v0.11.10",
        assets: {},
        helpers: { "linux-x64": { name: "candle-fido2-linux-x64", sha256: "ab", size: 1 } },
      }),
  })
  const store = createFakeStore({
    [keySignerRef(entry.keyPrefix, sha)]: pemToStoredSigner(
      pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    ),
  })
  const deps = createTestDeps({
    fetch,
    store,
    stdout,
    stderr,
    execPath: "/nonexistent/candle",
    env: {
      CANDLE_API_KEY: API_KEY,
      ...(opts.device ? { CANDLE_DEVICE_TOKEN: TOKEN } : {}),
      CANDLE_RELEASE_BASE_URL: "https://example.test",
    },
    ...createFakeConfigStore({
      profiles: { bot: { scopes: ["account:read"] } },
      activeProfile: "bot",
      keySigners: { entries: opts.signers === false ? [] : [entry] },
    }),
  })
  return {
    deps,
    stdout,
    stderr,
    calls,
    body: () => JSON.parse(stdout.text) as { role: string; rows: Row[]; provenance: Record<string, unknown> },
  }
}
const row = (f: ReturnType<typeof fixture>, id: string) => f.body().rows.find((r) => r.id === id)

describe("A1 role-aware doctor", () => {
  test("T-A1-7 bot key + readable signer + active TEE, no device/vault/helper/delegation, exits 0", async () => {
    const f = fixture()
    expect(await run(["doctor", "--json"], f.deps)).toBe(0)
    expect(f.body().role).toBe("bot")
    expect(row(f, "credentials")?.state).toBe("PASS")
    expect(row(f, "device_token")).toMatchObject({ state: "SKIP", detail: "not used on a bot box" })
    expect(row(f, "security_key_helper")?.state).toBe("SKIP")
    expect(row(f, "embedded_wallet")).toMatchObject({ state: "SKIP", detail: "not used by this key" })
    expect(row(f, "trade_path")).toMatchObject({ state: "PASS" })
    expect(row(f, "trade_path")?.detail).toContain("1 of 1 wallets")
    expect(row(f, "api_key")?.detail).toBe("scopes: swap:write")
  })
  test.each(["bot", "owner"])("paused %s exits 1; API key stays valid, pause is Trade path FAIL", async (role) => {
    const f = fixture({ paused: true, embedded: true })
    expect(await run(["doctor", "--role", role, "--json"], f.deps)).toBe(1)
    expect(row(f, "api_key")).toMatchObject({ state: "PASS" })
    expect(row(f, "api_key")?.detail).toContain("paused")
    expect(row(f, "trade_path")).toMatchObject({ state: "FAIL" })
    expect(row(f, "trade_path")?.detail).toContain("PROFILE_PAUSED")
  })
  test.each([false, undefined])("unpaused/absent paused=%s does not invent a failure", async (paused) => {
    const f = fixture({ paused })
    expect(await run(["doctor", "--json"], f.deps)).toBe(0)
  })
  test("owner auto-detection and bot override, invalid role is usage", async () => {
    for (const [args, role] of [
      [[], "owner"],
      [["--role", "bot"], "bot"],
    ] as const) {
      const f = fixture({ device: true, embedded: true })
      expect(await run(["doctor", ...args, "--json"], f.deps)).toBe(0)
      expect(f.body().role).toBe(role)
    }
    const f = fixture()
    expect(await run(["doctor", "--role", "wrong", "--json"], f.deps)).toBe(2)
    expect(f.calls).toHaveLength(0)
  })
  for (const scope of [true, false])
    for (const reachable of [true, false])
      for (const embedded of [true, false]) {
        test(`trade matrix scope=${scope} TEE=${reachable} embedded=${embedded}`, async () => {
          const f = fixture({ scopes: scope ? ["swap:write"] : ["account:read"], reachable, embedded })
          expect(await run(["doctor", "--json"], f.deps)).toBe(0)
          expect(row(f, "trade_path")?.state).toBe(scope && (reachable || embedded) ? "PASS" : "WARN")
          expect(row(f, "embedded_wallet")?.state).toBe(embedded ? "PASS" : reachable ? "SKIP" : "WARN")
        })
      }
  describe("the key's embedded-wallet permission (BE-503, R5.13)", () => {
    test("bot, denied, with a reachable TEE wallet: SKIP, and the TEE wallet is the trade path", async () => {
      const f = fixture({ embedded: true, permission: "denied" })
      expect(await run(["doctor", "--json"], f.deps)).toBe(0)
      expect(row(f, "embedded_wallet")).toMatchObject({
        state: "SKIP",
        detail: "denied for this key; not used by this key",
      })
      expect(row(f, "trade_path")?.state).toBe("PASS")
      expect(row(f, "trade_path")?.detail).not.toContain("embedded")
    })
    test("bot, denied, no TEE wallet: WARN naming the fix, trade path WARN, and still exit 0", async () => {
      const f = fixture({ embedded: true, permission: "denied", reachable: false })
      expect(await run(["doctor", "--json"], f.deps)).toBe(0)
      const embedded = row(f, "embedded_wallet")
      expect(embedded?.state).toBe("WARN")
      expect(embedded?.detail).toContain("denied for this key")
      expect(embedded?.detail).toContain("candle keys update abcdefgh --embedded-wallet allow")
      expect(row(f, "trade_path")).toMatchObject({ state: "WARN" })
      expect(row(f, "trade_path")?.detail).toContain("no reachable payer")
    })
    test("owner, delegated but denied: WARN, never the undelegated FAIL", async () => {
      const f = fixture({ device: true, embedded: true, permission: "denied" })
      expect(await run(["doctor", "--json"], f.deps)).toBe(0)
      expect(f.body().role).toBe("owner")
      const embedded = row(f, "embedded_wallet")
      expect(embedded?.state).toBe("WARN")
      expect(embedded?.detail).toContain("may not use it (denied)")
    })
    test.each([
      "allowed",
      undefined,
    ] as const)("permission %s (undefined: an older API) keeps today's PASS", async (permission) => {
      const f = fixture({ embedded: true, reachable: false, permission })
      expect(await run(["doctor", "--json"], f.deps)).toBe(0)
      expect(row(f, "embedded_wallet")).toMatchObject({ state: "PASS", detail: "delegated" })
      expect(row(f, "trade_path")).toMatchObject({ state: "PASS" })
      expect(row(f, "trade_path")?.detail).toContain("embedded wallet delegated and permitted")
    })
  })
  test("old API uses tier and cached scopes; unauthorized does not fall back to key PASS", async () => {
    const f = fixture({ old: true })
    expect(await run(["doctor", "--json"], f.deps)).toBe(0)
    expect(row(f, "api_key")?.detail).toBe("scopes (cached): account:read")
    const bad = fixture({ status: 401 })
    expect(await run(["doctor", "--json"], bad.deps)).toBe(1)
    expect(row(bad, "api_key")?.state).toBe("FAIL")
  })
  test.each(["owner", "bot"])("helper missing fails only with a vault: %s", async (role) => {
    const dir = await mkdtemp(join(tmpdir(), "doctor-a1-"))
    try {
      for (const hasVault of [false, true]) {
        if (hasVault) await writeFile(join(dir, "vault.enc"), "existence fixture")
        const f = fixture({ embedded: true })
        f.deps.env.CANDLE_CONFIG_DIR = dir
        expect(await run(["doctor", "--role", role, "--json"], f.deps)).toBe(hasVault ? 1 : 0)
        expect(row(f, "security_key_helper")?.state).toBe(hasVault ? "FAIL" : "SKIP")
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test("locked existing signer produces Keychain FAIL with remedy and a secret-free slot error", async () => {
    const f = fixture({ device: true })
    f.deps.store.get = async () => {
      throw new SecretStoreLockedError()
    }
    expect(await run(["doctor", "--json"], f.deps)).toBe(1)
    expect(row(f, "keychain")?.detail).toContain("security unlock-keychain")
    expect(row(f, "signer_slot")?.detail).toBe("cannot be opened: keychain locked")
    expect(f.stdout.text).not.toContain(keySignerRef(entry.keyPrefix, sha))
  })
  test.each([
    true,
    false,
  ])("provenance and project .env names never emit 12-character secret slices (json=%s)", async (json) => {
    const f = fixture({ device: true, embedded: true })
    f.deps.readFile = async () =>
      `CANDLE_API_KEY=${API_KEY}\nexport CANDLE_DEVICE_TOKEN='${TOKEN}'\n# CANDLE_IGNORED=x\nOTHER=secret`
    expect(await run(["doctor", ...(json ? ["--json"] : [])], f.deps)).toBe(0)
    const output = f.stdout.text + f.stderr.text
    for (const secret of [API_KEY, TOKEN])
      for (let i = 0; i <= secret.length - 12; i++) expect(output).not.toContain(secret.slice(i, i + 12))
    expect(output).toContain("CANDLE_API_KEY")
    expect(output).not.toContain("CANDLE_IGNORED")
    expect(output).toContain("export them, or store them in a profile")
    if (json) expect(f.body().provenance.apiKey).toEqual({ source: "CANDLE_API_KEY", prefix: "abcdefgh" })
  })
})

for (const [flag, env, profile, legacy, expected, source] of [
  [
    "https://flag.test",
    "https://env.test",
    "https://profile.test",
    "https://legacy.test",
    "https://flag.test",
    "--api-url",
  ],
  [undefined, "https://env.test", "https://profile.test", "https://legacy.test", "https://env.test", "CANDLE_API_URL"],
  [undefined, undefined, "https://profile.test", "https://legacy.test", "https://profile.test", "profile bot"],
  [undefined, undefined, undefined, "https://legacy.test", "https://legacy.test", "config"],
  [undefined, undefined, undefined, undefined, "https://api.alpha.candle.tv", "default"],
] as const) {
  test(`R1.3 API URL precedence from ${source} (fake fetch only)`, async () => {
    const f = fixture({ signers: false })
    Object.assign(
      f.deps,
      createFakeConfigStore({ profiles: { bot: { apiUrl: profile } }, activeProfile: "bot", apiUrl: legacy }),
    )
    f.deps.env.CANDLE_API_URL = env
    await run(["doctor", "--json", ...(flag ? ["--api-url", flag] : [])], f.deps)
    expect(f.body().provenance.apiUrl).toEqual({ value: expected, source })
    expect(f.calls[0]?.url).toBe(`${expected}/api/v1/status`)
  })
}

test("R6.2 locked legacy credentials become diagnostic rows, before any migration", async () => {
  const f = fixture({ signers: false })
  Object.assign(f.deps, createFakeConfigStore({ apiUrl: "https://legacy.test" }))
  delete f.deps.env.CANDLE_API_KEY
  f.deps.store.get = async () => {
    throw new SecretStoreLockedError()
  }
  expect(await run(["doctor", "--json"], f.deps)).toBe(1)
  expect(row(f, "keychain")?.detail).toContain("security unlock-keychain")
})

test("R6.3 both exported credentials avoid all store reads even with legacy config", async () => {
  const f = fixture({ device: true, signers: false, embedded: true })
  Object.assign(f.deps, createFakeConfigStore({ apiUrl: "https://legacy.test" }))
  f.deps.store.get = async () => {
    throw new Error("must not read store")
  }
  expect(await run(["doctor", "--json"], f.deps)).toBe(0)
  expect(row(f, "keychain")?.state).toBe("PASS")
})

test("R2.6 reach counts later pages and wallets on earlier local signers", async () => {
  const f = fixture()
  const fetch = f.deps.fetch
  let pageRequests = 0
  f.deps.fetch = (async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/wallets/trading")) {
      pageRequests++
      return jsonResponse(
        200,
        url.searchParams.has("cursor")
          ? { scopes: ["swap:write"], page: [{ ...wallet, active: true }], isDone: true }
          : {
              scopes: ["swap:write"],
              page: [{ ...wallet, id: "other", active: false }],
              isDone: false,
              continueCursor: "next page",
            },
      )
    }
    if (url.pathname.endsWith("/keys/self/signer"))
      return jsonResponse(200, { ...view, wallets: { onSigner: [], moving: [wallet], legacy: [] } })
    return fetch(input, init)
  }) as typeof fetch
  expect(await run(["doctor", "--json"], f.deps)).toBe(0)
  expect(pageRequests).toBe(2)
  expect(row(f, "trade_path")).toMatchObject({
    state: "PASS",
    detail: "1 of 2 wallets on this key trade from this machine",
  })
})

test.each(["profile", "legacy", "unrecognized"])("R1.4 credential provenance: %s", async (source) => {
  const f = fixture({ signers: false })
  delete f.deps.env.CANDLE_API_KEY
  const value = source === "unrecognized" ? "not-a-key-but-still-a-secret" : API_KEY
  f.deps.store = createFakeStore({ [source === "legacy" ? "api_key" : "profile:bot:api_key"]: value })
  if (source === "legacy") Object.assign(f.deps, createFakeConfigStore({}))
  await run(["doctor", "--json"], f.deps)
  expect(f.body().provenance.apiKey).toEqual({
    source: source === "legacy" ? "legacy store" : "profile bot",
    prefix: source === "unrecognized" ? null : "abcdefgh",
  })
  expect(f.stdout.text).not.toContain(value)
  if (source === "unrecognized") expect(row(f, "api_key_provenance")?.detail).toContain("unrecognized format")
})

// BE-500 (R4.5): the TEE limits row. Informational: only limits the owner set apply.
describe("TEE limits row", () => {
  const caps = { SOL: true, USDC: true, CNDL: true, ETH: true, USDG: true }
  test("PASS names the limits set on the chains this key's wallets are on", async () => {
    const f = fixture({ readiness: { txLimit: true, rawCaps: { ...caps, ETH: false } } })
    expect(await run(["doctor", "--json"], f.deps)).toBe(0)
    expect(row(f, "tee_limits")).toMatchObject({
      state: "PASS",
      detail: "USD limit set; per-transaction caps set for SOL, USDC, CNDL",
    })
  })
  test("unset limits are reported as unlimited, never as a warning, and exit 0", async () => {
    const f = fixture({ readiness: { txLimit: false, rawCaps: { ...caps, USDC: false, CNDL: false, USDG: false } } })
    expect(await run(["doctor", "--json"], f.deps)).toBe(0)
    const tee = row(f, "tee_limits")
    expect(tee?.state).toBe("PASS")
    expect(tee?.detail).toBe(
      "no USD limit (unlimited); per-transaction caps set for SOL; no cap for USDC, CNDL (trades and swaps unlimited; transfers, LP deposits and launches need one)",
    )
    // USDG is a Hood asset, and this key's only wallet is on Solana.
    expect(tee?.detail).not.toContain("USDG")
  })
  test("a Hood wallet is judged on ETH and USDG", async () => {
    const f = fixture({ chain: "evm", readiness: { txLimit: true, rawCaps: { ...caps, USDG: false } } })
    await run(["doctor", "--json"], f.deps)
    expect(row(f, "tee_limits")).toMatchObject({ state: "PASS" })
    expect(row(f, "tee_limits")?.detail).toContain("no cap for USDG")
  })
  test("SKIP when the API does not report readiness, instead of guessing", async () => {
    const f = fixture()
    expect(await run(["doctor", "--json"], f.deps)).toBe(0)
    expect(row(f, "tee_limits")).toMatchObject({ state: "SKIP", detail: "this API does not report readiness yet" })
  })
  test("no row when the key has no TEE wallets", async () => {
    const f = fixture({ old: true, readiness: { txLimit: false, rawCaps: caps } })
    await run(["doctor", "--json"], f.deps)
    expect(row(f, "tee_limits")).toBeUndefined()
  })
  test("the human table shows the row under its label", async () => {
    const f = fixture({ readiness: { txLimit: false, rawCaps: caps } })
    await run(["doctor"], f.deps)
    expect(f.stdout.text).toMatch(/TEE limits\s+PASS\s+no USD limit \(unlimited\)/)
  })
})
