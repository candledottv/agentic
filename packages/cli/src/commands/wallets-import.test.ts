/**
 * `wallets import` and `wallets revoke`, driven through `run()`.
 *
 * The HPKE seal runs for REAL in the happy paths (the vendored wallet-import module against a
 * genuine P-256 receiver key generated per test run), so these tests prove the actual crypto
 * pipeline produces submittable base64, not just that a mock was called. The fixture "secret" is
 * a fixed 64-byte pattern -- the seal doesn't validate key material, only Privy would, and what
 * matters here is byte-exact decode/derive behavior.
 */

import { beforeAll, describe, expect, test } from "bun:test"
import { base58 } from "@scure/base"
import { run } from "../index"
import { walletSignerRef } from "../secret-store"
import { createCapture, createFakeStore, createRoutedFetch, createTestDeps, jsonResponse } from "../test-support"

/** Fixed 64-byte "secret": bytes 0..63. Solana keypair layout embeds the public key as the last
 * 32 bytes, so the derived address is the base58 of bytes 32..63. */
const SOL_SECRET = Uint8Array.from({ length: 64 }, (_, i) => i)
const SOL_SECRET_BASE58 = base58.encode(SOL_SECRET)
const SOL_ID_JSON = JSON.stringify(Array.from(SOL_SECRET))
const SOL_DERIVED_ADDRESS = base58.encode(SOL_SECRET.slice(32))

/** A real P-256 public key in the raw uncompressed SEC1 form `/import/init` returns, so the
 * vendored suite's `deserializePublicKey` accepts it and the seal actually runs. */
let ENCRYPTION_PUBLIC_KEY = ""
beforeAll(async () => {
  const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  const raw = await crypto.subtle.exportKey("raw", receiver.publicKey)
  ENCRYPTION_PUBLIC_KEY = Buffer.from(raw).toString("base64")
})

function importRoutes(overrides: Partial<Record<string, Parameters<typeof createRoutedFetch>[0][string]>> = {}) {
  return createRoutedFetch({
    "/api/v1/agent/wallets/import/init": () =>
      jsonResponse(200, { success: true, encryptionPublicKey: ENCRYPTION_PUBLIC_KEY }),
    "/api/v1/agent/wallets/import/submit": () =>
      jsonResponse(200, {
        success: true,
        id: "lw_test0001",
        address: SOL_DERIVED_ADDRESS,
        chain: "solana",
        privyWalletId: "pw_test0001",
      }),
    ...overrides,
  })
}

function requestBody(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>
}

const BASE64_RE = /^[A-Za-z0-9+/]+=*$/

describe("wallets import", () => {
  test("happy path via --key-file (id.json): derives the address, seals for real, stores the signer, prints the ids", async () => {
    const { fetch, calls } = importRoutes()
    const store = createFakeStore({ api_key: "ck_live_x" })
    const stdout = createCapture()
    const deps = createTestDeps({
      fetch,
      store,
      stdout,
      readFile: async (path: string) => {
        expect(path).toBe("/keys/id.json")
        return SOL_ID_JSON
      },
    })

    const code = await run(
      ["wallets", "import", "--chain", "solana", "--key-file", "/keys/id.json", "--label", "trading"],
      deps,
    )
    expect(code).toBe(0)

    expect(calls).toHaveLength(2)
    const initCall = calls[0]
    const submitCall = calls[1]
    if (!initCall || !submitCall) throw new Error("expected two calls")
    expect(requestBody(initCall)).toEqual({ chain: "solana", address: SOL_DERIVED_ADDRESS })

    const submit = requestBody(submitCall)
    expect(submit.chain).toBe("solana")
    expect(submit.address).toBe(SOL_DERIVED_ADDRESS)
    expect(submit.label).toBe("trading")
    // Real seal output: base64, non-empty, and NOT the plaintext in any encoding. The
    // encapsulated key is a 65-byte P-256 point -> 88 base64 chars.
    expect(String(submit.ciphertext)).toMatch(BASE64_RE)
    expect(String(submit.encapsulatedKey)).toMatch(BASE64_RE)
    expect(Buffer.from(String(submit.encapsulatedKey), "base64")).toHaveLength(65)
    expect(String(submit.ciphertext)).not.toContain(SOL_SECRET_BASE58)
    expect(String(submit.signerPublicKey)).toMatch(BASE64_RE)

    // The signer's private half landed in the store, keyed by the returned wallet id.
    const pem = await store.get(walletSignerRef("lw_test0001"))
    expect(pem).toContain("BEGIN PRIVATE KEY")

    expect(stdout.text).toContain("lw_test0001")
    expect(stdout.text).toContain("pw_test0001")
    expect(stdout.text).toContain("encrypted-file")
  })

  test("--address matching the derived one is accepted; a mismatch refuses BEFORE any network call", async () => {
    const { fetch, calls } = importRoutes()
    const stderr = createCapture()
    const deps = createTestDeps({
      fetch,
      store: createFakeStore({ api_key: "ck_live_x" }),
      stderr,
      readFile: async () => SOL_ID_JSON,
    })

    const code = await run(
      ["wallets", "import", "--chain", "solana", "--key-file", "/k", "--address", "SomeOtherAddress111"],
      deps,
    )
    expect(code).toBe(1)
    expect(calls).toHaveLength(0)
    expect(stderr.text).toContain(SOL_DERIVED_ADDRESS)
    expect(stderr.text.toLowerCase()).toContain("mismatch")
  })

  test("the prompt path: no --key-file reads the key via promptSecret (base58 form) and imports", async () => {
    const { fetch, calls } = importRoutes()
    const store = createFakeStore({ api_key: "ck_live_x" })
    let promptedWith = ""
    const deps = createTestDeps({
      fetch,
      store,
      promptSecret: async (promptText: string) => {
        promptedWith = promptText
        return SOL_SECRET_BASE58
      },
    })

    const code = await run(["wallets", "import", "--chain", "solana"], deps)
    expect(code).toBe(0)
    expect(promptedWith.toLowerCase()).toContain("hidden")
    expect(calls).toHaveLength(2)
  })

  test("--signer-out additionally exports the PEM through deps.writeFile", async () => {
    const { fetch } = importRoutes()
    const written: Array<{ path: string; content: string }> = []
    const deps = createTestDeps({
      fetch,
      store: createFakeStore({ api_key: "ck_live_x" }),
      readFile: async () => SOL_ID_JSON,
      writeFile: async (path: string, content: string) => {
        written.push({ path, content })
      },
    })

    const code = await run(
      ["wallets", "import", "--chain", "solana", "--key-file", "/k", "--signer-out", "/tmp/signer.pem"],
      deps,
    )
    expect(code).toBe(0)
    expect(written).toHaveLength(1)
    expect(written[0]?.path).toBe("/tmp/signer.pem")
    expect(written[0]?.content).toContain("BEGIN PRIVATE KEY")
  })

  test("evm without --address is a usage error, before the key is ever prompted for", async () => {
    const { fetch, calls } = importRoutes()
    const stderr = createCapture()
    let prompted = false
    const deps = createTestDeps({
      fetch,
      store: createFakeStore({ api_key: "ck_live_x" }),
      stderr,
      promptSecret: async () => {
        prompted = true
        return "deadbeef"
      },
    })

    const code = await run(["wallets", "import", "--chain", "evm"], deps)
    expect(code).toBe(2)
    expect(prompted).toBe(false)
    expect(calls).toHaveLength(0)
    expect(stderr.text).toContain("--address is required")
  })

  test("a malformed solana key fails locally with the decoder's own message and no network call", async () => {
    const { fetch, calls } = importRoutes()
    const stderr = createCapture()
    const deps = createTestDeps({
      fetch,
      store: createFakeStore({ api_key: "ck_live_x" }),
      stderr,
      readFile: async () => "[1,2,3]",
    })

    const code = await run(["wallets", "import", "--chain", "solana", "--key-file", "/k"], deps)
    expect(code).toBe(1)
    expect(calls).toHaveLength(0)
    expect(stderr.text).toContain("64-byte")
  })

  test("an init failure (tier gate) reports the API's error and never reaches submit", async () => {
    const { fetch, calls } = createRoutedFetch({
      "/api/v1/agent/wallets/import/init": () =>
        jsonResponse(403, { success: false, error: { code: "TIER_REQUIRED", message: "Requires Pro tier" } }),
    })
    const stderr = createCapture()
    const deps = createTestDeps({
      fetch,
      store: createFakeStore({ api_key: "ck_live_x" }),
      stderr,
      readFile: async () => SOL_ID_JSON,
    })

    const code = await run(["wallets", "import", "--chain", "solana", "--key-file", "/k"], deps)
    expect(code).toBe(1)
    expect(calls).toHaveLength(1)
    expect(stderr.text).toContain("Requires Pro tier")
  })

  test("no API key: fails with the keys-create hint before any request", async () => {
    const { fetch, calls } = importRoutes()
    const stderr = createCapture()
    const deps = createTestDeps({ fetch, stderr, readFile: async () => SOL_ID_JSON })

    const code = await run(["wallets", "import", "--chain", "solana", "--key-file", "/k"], deps)
    expect(code).toBe(1)
    expect(calls).toHaveLength(0)
    expect(stderr.text).toContain("keys create")
  })

  test("an unknown flag is a usage error", async () => {
    const { fetch, calls } = importRoutes()
    const stderr = createCapture()
    const deps = createTestDeps({ fetch, stderr })
    const code = await run(["wallets", "import", "--chain", "solana", "--frobnicate"], deps)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(stderr.text).toContain("--frobnicate")
  })
})

describe("wallets revoke", () => {
  test("revokes by wallet id and removes the stored signer for it", async () => {
    const { fetch, calls } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_test0001": () => jsonResponse(200, { success: true, policyNeutralized: true }),
    })
    const store = createFakeStore({
      api_key: "ck_live_x",
      [walletSignerRef("lw_test0001")]: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
    })
    const stdout = createCapture()
    const deps = createTestDeps({ fetch, store, stdout })

    const code = await run(["wallets", "revoke", "lw_test0001"], deps)
    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.init.method).toBe("DELETE")
    expect(await store.get(walletSignerRef("lw_test0001"))).toBeNull()
    expect(stdout.text).toContain("lw_test0001")
  })

  test("without a wallet id it is a usage error", async () => {
    const { fetch, calls } = createRoutedFetch({})
    const stderr = createCapture()
    const code = await run(["wallets", "revoke"], createTestDeps({ fetch, stderr }))
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(stderr.text).toContain("Usage: candle wallets revoke")
  })
})
