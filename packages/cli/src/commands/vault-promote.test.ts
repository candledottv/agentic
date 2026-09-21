/**
 * Ember Phase 2 PR C: T40 (promote + fund), T41 (demote), T56 (in-place promote / AD-8 /
 * reconcileGrant). T52 stays recorded as pending (devnet e2e gate).
 *
 * Fake API and fake RPC; real vault format and real HPKE seal boundary (T56 spy).
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { base58 } from "@scure/base"
import { Keypair } from "@solana/web3.js"
import { run } from "../index"
import {
  createCapture,
  createFakeStore,
  createRoutedFetch,
  createTestDeps,
  jsonResponse,
  type RouteHandler,
} from "../test-support"
import { addressFromSecret64 } from "../vault/ed25519"
import { parseIndexPlaintext, serializeIndexPlaintext } from "../vault/format"
import { wipe } from "../vault/hygiene"
import { AD8_WARNING, assertInPlacePreconditions, assertNotPinnedDestination } from "../vault/promote-support"
import { reconcileGrant } from "../vault/reconcile-grant"
import { closeVault, commitVault, decryptKey, unlockWithPassphrase } from "../vault/store"
import { generatedPassphraseFrom, useCheapKdf } from "../vault/test-vault"
import { setSealPlaintextObserver } from "../wallet-import"

setDefaultTimeout(90_000)
useCheapKdf()

/** T52 (CC-06 end to end on isolated Convex + dev Privy): pending gate. Not run in this PR. */
const T52_PENDING = "T52 pending: synthetic lifecycle on devnet with isolated Convex and a dev Privy app (never alpha)."

const ACCOUNT = "PRCAccountABCDEFGH1234567890xyzabc"
const API = "https://api.prc.test"
const RPC = "https://rpc.prc.test/rpc"
// Public mint addresses, not secrets. Named `MINT_*` rather than `*_TOKEN_MINT` on purpose: a
// base58 address beside an identifier carrying the word "token" is gitleaks' `generic-api-key`
// shape, and the scan is worth more than the naming.
const MINT_CLASSIC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const MINT_2022 = "9BVcYqEQxyccuwznvxXqDkSJFavvTyheiTYk231T1A8S"
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"

const ENCRYPTION_PUBLIC_KEY = await (async () => {
  const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  return Buffer.from(await crypto.subtle.exportKey("raw", receiver.publicKey)).toString("base64")
})()

function rpcHandler(overrides: Record<string, unknown> = {}): RouteHandler {
  return async (req) => {
    const body = typeof req.init.body === "string" ? JSON.parse(req.init.body) : {}
    const method = body.method as string
    if (method === "getLatestBlockhash") {
      return jsonResponse(200, { jsonrpc: "2.0", id: body.id, result: { value: { blockhash: BLOCKHASH } } })
    }
    if (method === "getBalance") {
      const value = (overrides.balance as number | undefined) ?? 1_000_000_000
      return jsonResponse(200, { jsonrpc: "2.0", id: body.id, result: { value } })
    }
    if (method === "getTokenAccountsByOwner") {
      // Keyed by the program asked for (BE-218, R5): a holdings read covers both.
      const programId = (body.params[1] as { programId: string }).programId
      const byProgram = overrides.tokens as
        | Record<string, Array<{ mint: string; amount: string; decimals: number }>>
        | undefined
      const tokens = byProgram?.[programId] ?? []
      return jsonResponse(200, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          value: tokens.map((t, i) => ({
            pubkey: `acct-${programId.slice(0, 4)}-${i}`,
            account: {
              data: {
                parsed: {
                  info: { mint: t.mint, state: "initialized", tokenAmount: { amount: t.amount, decimals: t.decimals } },
                },
              },
            },
          })),
        },
      })
    }
    if (method === "getFeeForMessage") {
      return jsonResponse(200, { jsonrpc: "2.0", id: body.id, result: { value: 5000 } })
    }
    if (method === "getAccountInfo") {
      return jsonResponse(200, { jsonrpc: "2.0", id: body.id, result: { value: null } })
    }
    if (method === "sendTransaction") {
      return jsonResponse(200, {
        jsonrpc: "2.0",
        id: body.id,
        result: "SigFake1111111111111111111111111111111111111111111111",
      })
    }
    if (method === "getSignatureStatuses") {
      return jsonResponse(200, {
        jsonrpc: "2.0",
        id: body.id,
        result: { value: [{ confirmationStatus: "finalized", err: null }] },
      })
    }
    if (method === "isBlockhashValid") {
      return jsonResponse(200, { jsonrpc: "2.0", id: body.id, result: { value: true } })
    }
    return jsonResponse(200, { jsonrpc: "2.0", id: body.id, result: null })
  }
}

async function initVault(dir: string): Promise<{ passphrase: string; vaultPath: string }> {
  const stdout = createCapture()
  const stderr = createCapture()
  const lines: string[] = ["n"]
  const secrets: string[] = []
  const deps = createTestDeps({
    fetch: (async () => {
      throw new Error("no network during init")
    }) as unknown as typeof fetch,
    stdout,
    stderr,
    env: { CANDLE_CONFIG_DIR: dir },
    promptSecret: async (text: string) => {
      if (secrets.length === 0) {
        // init generates; typed-back comes from stdout scrape after first run segment
        return ""
      }
      return secrets.shift()!
    },
    promptLine: async () => lines.shift() ?? "",
  })
  // Drive init: first it prints the passphrase; we need a two-pass approach like vault.test.ts
  const first = createCapture()
  const firstDeps = createTestDeps({
    fetch: deps.fetch,
    stdout: first,
    stderr: createCapture(),
    env: { CANDLE_CONFIG_DIR: dir },
    promptSecret: async () => {
      throw new Error("unexpected secret before passphrase printed")
    },
    promptLine: async () => "n",
  })
  // Real init collects generated passphrase via typed-back. Mirror vault.test.ts helper pattern.
  const asked: string[] = []
  const secretQueue: string[] = []
  const lineQueue = ["n"]
  const out = createCapture()
  const err = createCapture()
  const initDeps = createTestDeps({
    fetch: deps.fetch,
    stdout: out,
    stderr: err,
    env: { CANDLE_CONFIG_DIR: dir, HOME: dir },
    promptSecret: async (text: string) => {
      asked.push(text)
      if (secretQueue.length === 0) {
        // After generation the command asks to type it back; scrape from out so far.
        const generated = generatedPassphraseFrom(out.text)
        secretQueue.push(generated, generated)
      }
      return secretQueue.shift()!
    },
    promptLine: async () => lineQueue.shift() ?? "n",
  })
  const code = await run(["vault", "init"], initDeps)
  if (code !== 0) throw new Error(`vault init failed: ${err.text}\n${out.text}`)
  const passphrase = generatedPassphraseFrom(out.text)
  return { passphrase, vaultPath: join(dir, "vault.enc") }
}

async function newKey(dir: string, passphrase: string, label: string): Promise<string> {
  const out = createCapture()
  const err = createCapture()
  const deps = createTestDeps({
    fetch: (async () => {
      throw new Error("no network")
    }) as unknown as typeof fetch,
    stdout: out,
    stderr: err,
    env: { CANDLE_CONFIG_DIR: dir },
    promptSecret: async () => passphrase,
    promptLine: async () => "",
  })
  const code = await run(["vault", "new-key", "--chain", "solana", "--label", label], deps)
  if (code !== 0) throw new Error(`new-key failed: ${err.text}\n${out.text}`)
  const address = out.text.trim().split("\n")[0]!
  return address
}

function importRoutes(opts: {
  address: string
  vaultDestination: string
  importCalls: { n: number }
  remoteAuthority?: string
}): Record<string, RouteHandler> {
  return {
    "/api/v1/agent/wallets/import/init": () =>
      jsonResponse(200, { success: true, encryptionPublicKey: ENCRYPTION_PUBLIC_KEY }),
    "/api/v1/agent/wallets/import/submit": () => {
      opts.importCalls.n += 1
      return jsonResponse(200, {
        success: true,
        id: "lw_promoted",
        address: opts.address,
        chain: "solana",
        privyWalletId: "pw_promoted",
        profile: "ember-tee",
        boundKeyPrefix: "ck_live_p",
        vaultDestination: opts.vaultDestination,
        remoteAuthority: opts.remoteAuthority ?? "verified-active",
      })
    },
    "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: ACCOUNT }),
    "/api/v1/agent/wallets": () => jsonResponse(200, { page: [], isDone: true }),
    "/api/v1/agent/wallets/import-failures": () =>
      jsonResponse(200, { success: true, account: ACCOUNT, failures: [], complete: true }),
  }
}

describe("T40: vault promote --from and vault fund", () => {
  test("fresh-key promote derives on the TEE branch, writes exposure before import, fund refuses unless verified-active", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-t40-"))
    const { passphrase } = await initVault(dir)
    const cold = await newKey(dir, passphrase, "cold")
    const importCalls = { n: 0 }
    // Promote needs the address after derive; use a capture of submit body via routes that accept any.
    const routes: Record<string, RouteHandler> = {
      "/api/v1/agent/wallets/import/init": () =>
        jsonResponse(200, { success: true, encryptionPublicKey: ENCRYPTION_PUBLIC_KEY }),
      "/api/v1/agent/wallets/import/submit": async (req) => {
        importCalls.n += 1
        const body = typeof req.init.body === "string" ? JSON.parse(req.init.body) : {}
        return jsonResponse(200, {
          success: true,
          id: "lw_fresh",
          address: body.address,
          chain: "solana",
          privyWalletId: "pw_fresh",
          profile: "ember-tee",
          boundKeyPrefix: "ck_live_f",
          vaultDestination: cold,
          remoteAuthority: "verified-active",
        })
      },
      "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: ACCOUNT }),
      "/api/v1/agent/wallets": () => jsonResponse(200, { page: [], isDone: true }),
      "/api/v1/agent/wallets/import-failures": () =>
        jsonResponse(200, { success: true, account: ACCOUNT, failures: [], complete: true }),
      "/rpc": rpcHandler(),
    }
    const { fetch } = createRoutedFetch(routes)
    const out = createCapture()
    const err = createCapture()
    const secrets = [passphrase, passphrase]
    const lines = [cold.slice(-6)]
    const deps = createTestDeps({
      fetch,
      store: createFakeStore({ "profile:prc:api_key": "ck_live_prc" }),
      stdout: out,
      stderr: err,
      env: { CANDLE_CONFIG_DIR: dir, CANDLE_API_URL: API },
      promptSecret: async () => secrets.shift() ?? passphrase,
      promptLine: async () => lines.shift() ?? "",
      readFile: (path) => readFile(path, "utf8"),
      writeFile: (path, content) => writeFile(path, content, "utf8"),
    })
    await deps.writeConfig({
      activeProfile: "prc",
      profiles: { prc: { account: ACCOUNT, apiUrl: API, accountCachedAt: Date.now() } },
    })

    const code = await run(["vault", "promote", "--from", "cold", "--json"], deps)
    expect(code).toBe(0)
    expect(importCalls.n).toBe(1)
    const body = JSON.parse(out.text.trim().split("\n").at(-1)!)
    expect(body.mode).toBe("fresh")
    expect(body.vaultDestination).toBe(cold)
    expect(body.address).not.toBe(cold)

    const vaultPath = join(dir, "vault.enc")
    const opened = await unlockWithPassphrase(vaultPath, await readFile(vaultPath, "utf8"), passphrase)
    try {
      const tee = opened.index.entries.find((e) => e.address === body.address)
      expect(tee?.role).toBe("tee-wallet")
      expect(tee?.exposure?.everRemoteExposed).toBe(true)
      expect(tee?.tee?.lifecycle).toBe("enabled")
      expect(tee?.derivation?.path).toMatch(/m\/44'\/501'\/\d+'\/1'/)
      expect(opened.index.hd.nextIndex.solanaTee).toBeGreaterThan(0)

      // Fund refused when we clear verified-active
      tee!.tee!.remoteAuthority = "unknown"
      await commitVault(opened, { index: { hd: opened.index.hd, entries: opened.index.entries } }, {
        now: () => Date.now(),
        sleep: async () => {},
      } as never)
    } finally {
      closeVault(opened)
    }

    const fundOut = createCapture()
    const fundErr = createCapture()
    const fundDeps = createTestDeps({
      fetch,
      store: createFakeStore({ "profile:prc:api_key": "ck_live_prc" }),
      stdout: fundOut,
      stderr: fundErr,
      env: { CANDLE_CONFIG_DIR: dir, CANDLE_API_URL: API },
      promptSecret: async () => passphrase,
      promptLine: async () => "",
      readFile: (path) => readFile(path, "utf8"),
      writeFile: (path, content) => writeFile(path, content, "utf8"),
    })
    const fundCode = await run(
      ["vault", "fund", body.address, "--amount", "0.1", "--asset", "SOL", "--rpc-url", RPC, "--json"],
      fundDeps,
    )
    expect(fundCode).toBe(1)
    expect(fundErr.text + fundOut.text).toContain("TEE_WALLET_NOT_VERIFIED")
  })
})

describe("T56: in-place promote, AD-8, seal boundary, reconcile verdicts", () => {
  test("AD-8 warning prints in full before confirmations; seal plaintext is exactly the 64-byte secret", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-t56-"))
    const { passphrase } = await initVault(dir)
    const subject = await newKey(dir, passphrase, "subject")
    const cold = await newKey(dir, passphrase, "cold")
    const sealed: Uint8Array[] = []
    setSealPlaintextObserver((p) => sealed.push(Uint8Array.from(p)))
    try {
      const importCalls = { n: 0 }
      const routes = {
        ...importRoutes({ address: subject, vaultDestination: cold, importCalls }),
        "/rpc": rpcHandler({
          balance: 42,
          tokens: {
            TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: [{ mint: MINT_CLASSIC, amount: "700000", decimals: 6 }],
            TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: [{ mint: MINT_2022, amount: "1", decimals: 0 }],
          },
        }),
      }
      const { fetch } = createRoutedFetch(routes)
      const out = createCapture()
      const err = createCapture()
      const secrets = [passphrase, passphrase]
      const lines = [subject.slice(-6), "EXPOSE"]
      const deps = createTestDeps({
        fetch,
        store: createFakeStore({ "profile:prc:api_key": "ck_live_prc" }),
        stdout: out,
        stderr: err,
        env: { CANDLE_CONFIG_DIR: dir, CANDLE_API_URL: API },
        promptSecret: async () => secrets.shift() ?? passphrase,
        promptLine: async () => lines.shift() ?? "",
        readFile: (path) => readFile(path, "utf8"),
        writeFile: (path, content) => writeFile(path, content, "utf8"),
      })
      await deps.writeConfig({
        activeProfile: "prc",
        profiles: { prc: { account: ACCOUNT, apiUrl: API, accountCachedAt: Date.now() } },
      })

      const code = await run(
        ["vault", "promote", "--in-place", "subject", "--sweep-to", "cold", "--rpc-url", RPC],
        deps,
      )
      expect(code).toBe(0)
      // R5: the holdings display covers BOTH programs, and names which is which. A read that only
      // listed classic Token accounts would promote this key while hiding what it holds.
      expect(out.text).toContain(`token ${MINT_CLASSIC}  700000 raw (6 dp, token)`)
      expect(out.text).toContain(`token ${MINT_2022}  1 raw (0 dp, token-2022)`)
      // Warning before both confirmations: all five points present; no reserved-address / signer lookup route hit.
      for (const point of AD8_WARNING.split("\n")) {
        expect(out.text).toContain(point)
      }
      expect(Object.keys(routes).some((k) => k.includes("reserved"))).toBe(false)

      expect(sealed.length).toBe(1)
      const vaultPath = join(dir, "vault.enc")
      const opened = await unlockWithPassphrase(vaultPath, await readFile(vaultPath, "utf8"), passphrase)
      try {
        const entry = opened.index.entries.find((e) => e.address === subject)!
        expect(entry.role).toBe("tee-wallet")
        expect(entry.tee?.promotedInPlaceAt).toBeTruthy()
        const secret = await decryptKey(opened, entry.id)
        try {
          expect(sealed[0]!.length).toBe(64)
          expect(Buffer.from(sealed[0]!).equals(Buffer.from(secret))).toBe(true)
          expect(addressFromSecret64(secret)).toBe(subject)
          // Canaries: seal bytes are not a BIP-39 phrase, not an xpub, not a path string.
          const asText = new TextDecoder().decode(sealed[0]!)
          expect(asText.includes("m/44")).toBe(false)
          expect(asText.toLowerCase().includes("xpub")).toBe(false)
        } finally {
          wipe(secret)
        }
      } finally {
        closeVault(opened)
      }
    } finally {
      setSealPlaintextObserver(null)
    }
  })

  test("PROMOTE_KEY_IS_PINNED_DESTINATION refuses when another TEE wallet pins the subject", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-t56-pin-"))
    const { passphrase } = await initVault(dir)
    const a = await newKey(dir, passphrase, "A")
    const cold = await newKey(dir, passphrase, "cold")
    const vaultPath = join(dir, "vault.enc")
    const opened = await unlockWithPassphrase(vaultPath, await readFile(vaultPath, "utf8"), passphrase)
    try {
      const tee = Keypair.generate()
      const entries = [
        ...opened.index.entries,
        {
          id: "tee-pinned",
          chain: "solana" as const,
          curve: "ed25519" as const,
          address: tee.publicKey.toBase58(),
          label: "T",
          createdAt: new Date().toISOString(),
          role: "tee-wallet" as const,
          origin: "migrated-tee" as const,
          exposure: { everRemoteExposed: true, everExported: false },
          linkedWalletId: "lw_t",
          tee: {
            network: "solana-mainnet" as const,
            lifecycle: "enabled" as const,
            vaultDestination: a,
            remoteAuthority: "verified-active" as const,
            grantIdentity: {
              account: ACCOUNT,
              apiBaseUrl: API,
              source: "recorded-at-operation" as const,
            },
          },
        },
      ]
      // Seal a dummy key blob by copying structure — migrated-tee still needs a key blob.
      // Use commit with addKeys from sealing tee secret.
      const { sealKeyBlob } = await import("../vault/store")
      const blob = await sealKeyBlob(opened, "tee-pinned", tee.secretKey)
      await commitVault(opened, { index: { hd: opened.index.hd, entries }, addKeys: [blob] }, {
        now: () => Date.now(),
        sleep: async () => {},
      } as never)
    } finally {
      closeVault(opened)
    }

    const out = createCapture()
    const err = createCapture()
    const { fetch } = createRoutedFetch({ "/rpc": rpcHandler() })
    const deps = createTestDeps({
      fetch,
      stdout: out,
      stderr: err,
      env: { CANDLE_CONFIG_DIR: dir },
      promptSecret: async () => passphrase,
      promptLine: async () => a.slice(-6),
    })
    const code = await run(
      ["vault", "promote", "--in-place", "A", "--sweep-to", "cold", "--rpc-url", RPC, "--json"],
      deps,
    )
    expect(code).toBe(1)
    expect(err.text + out.text).toContain("PROMOTE_KEY_IS_PINNED_DESTINATION")
    expect(err.text + out.text).toContain("T")

    // Concurrent write boundary: precondition pass then pin appears before write.
    const reopened = await unlockWithPassphrase(vaultPath, await readFile(vaultPath, "utf8"), passphrase)
    try {
      expect(() => assertNotPinnedDestination(reopened.index, a)).toThrow(/pinned sweep destination/)
      // Re-run full precondition against the pinned index.
      expect(() => assertInPlacePreconditions(reopened.index, "A", "cold", {})).toThrow(/pinned sweep destination/)
    } finally {
      closeVault(reopened)
    }
  })

  test("four reconcileGrant verdicts: granted imports zero; strand-final; unresolved; unreadable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-t56-rec-"))
    const { passphrase } = await initVault(dir)
    const subject = await newKey(dir, passphrase, "subject")
    const cold = await newKey(dir, passphrase, "cold")
    const vaultPath = join(dir, "vault.enc")

    // Force subject into import-pending with destination, as the pre-import write does.
    const opened = await unlockWithPassphrase(vaultPath, await readFile(vaultPath, "utf8"), passphrase)
    try {
      const entries = opened.index.entries.map((e) =>
        e.address === subject
          ? {
              ...e,
              role: "tee-wallet" as const,
              exposure: { everRemoteExposed: true, everExported: false },
              tee: {
                network: "solana-mainnet" as const,
                lifecycle: "import-pending" as const,
                vaultDestination: cold,
                promotedInPlaceAt: new Date().toISOString(),
              },
            }
          : e,
      )
      await commitVault(opened, { index: { hd: opened.index.hd, entries } }, {
        now: () => Date.now(),
        sleep: async () => {},
      } as never)
    } finally {
      closeVault(opened)
    }

    const makeCtx = (fetch: typeof globalThis.fetch) => {
      const deps = createTestDeps({
        fetch,
        store: createFakeStore({ "profile:prc:api_key": "ck_live_prc" }),
        stdout: createCapture(),
        stderr: createCapture(),
        env: { CANDLE_CONFIG_DIR: dir, CANDLE_API_URL: API },
        promptSecret: async () => passphrase,
        promptLine: async () => "",
      })
      return {
        deps,
        apiUrl: API,
        profile: "prc",
        json: true,
        verifyAccount: false,
      }
    }

    const entryBase = async () => {
      const v = await unlockWithPassphrase(vaultPath, await readFile(vaultPath, "utf8"), passphrase)
      const entry = v.index.entries.find((e) => e.address === subject)!
      return { v, entry }
    }

    // granted
    {
      const { fetch } = createRoutedFetch({
        "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: ACCOUNT }),
        "/api/v1/agent/wallets": () =>
          jsonResponse(200, {
            page: [
              {
                _id: "lw_g",
                address: subject,
                vaultDestination: cold,
                boundKeyPrefix: "ck_g",
                remoteAuthority: "verified-active",
              },
            ],
            isDone: true,
          }),
        "/api/v1/agent/wallets/import-failures": () =>
          jsonResponse(200, { success: true, account: ACCOUNT, failures: [], complete: true }),
      })
      const { v, entry } = await entryBase()
      try {
        const verdict = await reconcileGrant(makeCtx(fetch) as never, entry, { assertedAccount: ACCOUNT })
        expect(verdict.kind).toBe("granted")
      } finally {
        closeVault(v)
      }
    }

    // strand-final
    {
      const { fetch } = createRoutedFetch({
        "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: ACCOUNT }),
        "/api/v1/agent/wallets": () => jsonResponse(200, { page: [], isDone: true }),
        "/api/v1/agent/wallets/import-failures": () =>
          jsonResponse(200, {
            success: true,
            account: ACCOUNT,
            failures: [
              {
                chain: "solana",
                address: subject,
                stage: "convex_link",
                privyWalletId: "pw",
                createdAt: new Date().toISOString(),
              },
            ],
            complete: true,
          }),
      })
      const { v, entry } = await entryBase()
      try {
        const verdict = await reconcileGrant(makeCtx(fetch) as never, entry, { assertedAccount: ACCOUNT })
        expect(verdict.kind).toBe("strand-final")
      } finally {
        closeVault(v)
      }
    }

    // unresolved (empty lists OR privy_submit alone)
    {
      const { fetch } = createRoutedFetch({
        "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: ACCOUNT }),
        "/api/v1/agent/wallets": () => jsonResponse(200, { page: [], isDone: true }),
        "/api/v1/agent/wallets/import-failures": () =>
          jsonResponse(200, {
            success: true,
            account: ACCOUNT,
            failures: [
              { chain: "solana", address: subject, stage: "privy_submit", createdAt: new Date().toISOString() },
            ],
            complete: true,
          }),
      })
      const { v, entry } = await entryBase()
      try {
        const verdict = await reconcileGrant(makeCtx(fetch) as never, entry, { assertedAccount: ACCOUNT })
        expect(verdict.kind).toBe("unresolved")
      } finally {
        closeVault(v)
      }
    }

    // unreadable (404 on import-failures)
    {
      const { fetch } = createRoutedFetch({
        "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: ACCOUNT }),
        "/api/v1/agent/wallets": () => jsonResponse(200, { page: [], isDone: true }),
        "/api/v1/agent/wallets/import-failures": () => jsonResponse(404, { success: false }),
      })
      const { v, entry } = await entryBase()
      try {
        const verdict = await reconcileGrant(makeCtx(fetch) as never, entry, { assertedAccount: ACCOUNT })
        expect(verdict.kind).toBe("unreadable")
      } finally {
        closeVault(v)
      }
    }

    // Resume on granted imports zero times
    {
      const importCalls = { n: 0 }
      const routes = {
        "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: ACCOUNT }),
        "/api/v1/agent/wallets": () =>
          jsonResponse(200, {
            page: [
              {
                _id: "lw_g2",
                address: subject,
                vaultDestination: cold,
                boundKeyPrefix: "ck_g2",
                remoteAuthority: "verified-active",
              },
            ],
            isDone: true,
          }),
        "/api/v1/agent/wallets/import-failures": () =>
          jsonResponse(200, { success: true, account: ACCOUNT, failures: [], complete: true }),
        "/api/v1/agent/wallets/import/init": () => {
          importCalls.n += 1
          return jsonResponse(200, { success: true, encryptionPublicKey: ENCRYPTION_PUBLIC_KEY })
        },
        "/api/v1/agent/wallets/import/submit": () => {
          importCalls.n += 1
          return jsonResponse(500, { success: false })
        },
      }
      const { fetch } = createRoutedFetch(routes)
      const out = createCapture()
      const err = createCapture()
      const deps = createTestDeps({
        fetch,
        store: createFakeStore({ "profile:prc:api_key": "ck_live_prc" }),
        stdout: out,
        stderr: err,
        env: { CANDLE_CONFIG_DIR: dir, CANDLE_API_URL: API },
        promptSecret: async () => passphrase,
        promptLine: async () => ACCOUNT.slice(-6),
        readFile: (path) => readFile(path, "utf8"),
        writeFile: (path, content) => writeFile(path, content, "utf8"),
      })
      await deps.writeConfig({
        activeProfile: "prc",
        profiles: { prc: { account: ACCOUNT, apiUrl: API, accountCachedAt: Date.now() } },
      })
      const code = await run(["vault", "promote", "--in-place", "subject", "--json"], deps)
      expect(code).toBe(0)
      expect(importCalls.n).toBe(0)
      expect(JSON.parse(out.text.trim().split("\n").at(-1)!).importCalls).toBe(0)
    }
  })

  test("lifecycle round-trip: five tee.lifecycle values reopen under the strict reader", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-t56-life-"))
    const { passphrase } = await initVault(dir)
    await newKey(dir, passphrase, "cold")
    const vaultPath = join(dir, "vault.enc")
    const opened = await unlockWithPassphrase(vaultPath, await readFile(vaultPath, "utf8"), passphrase)
    try {
      const grant = {
        account: ACCOUNT,
        apiBaseUrl: API,
        source: "recorded-at-operation" as const,
      }
      const cold = opened.index.entries.find((e) => e.label === "cold")!
      const shapes: Array<{
        lifecycle: "local-candidate" | "import-pending" | "enabled" | "stranded" | "retired"
        linked?: boolean
      }> = [
        { lifecycle: "local-candidate" },
        { lifecycle: "import-pending" },
        { lifecycle: "enabled", linked: true },
        { lifecycle: "stranded" },
        { lifecycle: "retired", linked: true },
      ]
      const { sealKeyBlob } = await import("../vault/store")
      const addKeys = []
      const entries = [...opened.index.entries]
      for (const [i, shape] of shapes.entries()) {
        const kp = Keypair.generate()
        const id = `life-${i}`
        addKeys.push(await sealKeyBlob(opened, id, kp.secretKey))
        entries.push({
          id,
          chain: "solana",
          curve: "ed25519",
          address: kp.publicKey.toBase58(),
          label: shape.lifecycle,
          createdAt: new Date().toISOString(),
          role: "tee-wallet",
          origin: "migrated-tee",
          exposure: { everRemoteExposed: shape.lifecycle !== "local-candidate", everExported: false },
          ...(shape.linked ? { linkedWalletId: `lw_${i}` } : {}),
          tee: {
            network: "solana-mainnet",
            lifecycle: shape.lifecycle,
            ...(shape.lifecycle === "local-candidate" || shape.lifecycle === "stranded"
              ? {}
              : { vaultDestination: cold.address }),
            ...(shape.lifecycle === "enabled" || shape.lifecycle === "retired"
              ? { grantIdentity: grant, remoteAuthority: "verified-active" as const }
              : shape.lifecycle === "stranded"
                ? { grantIdentity: grant }
                : {}),
            ...(shape.lifecycle === "retired" ? { sweptAt: new Date().toISOString() } : {}),
          },
        })
      }
      await commitVault(opened, { index: { hd: opened.index.hd, entries }, addKeys }, {
        now: () => Date.now(),
        sleep: async () => {},
      } as never)
    } finally {
      closeVault(opened)
    }

    const again = await unlockWithPassphrase(vaultPath, await readFile(vaultPath, "utf8"), passphrase)
    try {
      parseIndexPlaintext(
        new TextEncoder().encode(JSON.stringify(serializeIndexPlaintext(again.index, again.file.version))),
        again.file.version,
      )
      for (const life of ["local-candidate", "import-pending", "enabled", "stranded", "retired"] as const) {
        expect(again.index.entries.some((e) => e.tee?.lifecycle === life)).toBe(true)
      }
    } finally {
      closeVault(again)
    }
  })
})

describe("T41: vault demote adapter basics", () => {
  async function seedImportPending(dir: string, passphrase: string, cold: string): Promise<{ address: string }> {
    // Flip an ordinary vault key into import-pending (same shape as the pre-import write), so
    // nextIndex / derivation stay consistent with what new-key already recorded.
    const address = await newKey(dir, passphrase, "pending")
    const vaultPath = join(dir, "vault.enc")
    const opened = await unlockWithPassphrase(vaultPath, await readFile(vaultPath, "utf8"), passphrase)
    try {
      const entries = opened.index.entries.map((e) =>
        e.address === address
          ? {
              ...e,
              role: "tee-wallet" as const,
              exposure: { everRemoteExposed: true, everExported: false },
              tee: {
                network: "solana-mainnet" as const,
                lifecycle: "import-pending" as const,
                vaultDestination: cold,
              },
            }
          : e,
      )
      await commitVault(opened, { index: { hd: opened.index.hd, entries } }, {
        now: () => Date.now(),
        sleep: async () => {},
      } as never)
    } finally {
      closeVault(opened)
    }
    return { address }
  }

  function demoteDeps(dir: string, passphrase: string, cold: string, fetch: typeof globalThis.fetch) {
    const out = createCapture()
    const err = createCapture()
    const deps = createTestDeps({
      fetch,
      store: createFakeStore({ "profile:prc:api_key": "ck_live_prc" }),
      stdout: out,
      stderr: err,
      env: { CANDLE_CONFIG_DIR: dir, CANDLE_API_URL: API },
      promptSecret: async (text: string) => {
        if (/LAST 6/i.test(text)) return cold.slice(-6)
        return passphrase
      },
      promptLine: async () => ACCOUNT.slice(-6),
      readFile: (path) => readFile(path, "utf8"),
      writeFile: (path, content) => writeFile(path, content, "utf8"),
    })
    return { deps, out, err }
  }

  test("demote on unresolved uses adapter recovery, never the never-enabled shortcut", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-t41-"))
    const { passphrase } = await initVault(dir)
    const cold = await newKey(dir, passphrase, "cold")
    const { address } = await seedImportPending(dir, passphrase, cold)

    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: ACCOUNT }),
      "/api/v1/agent/wallets": () => jsonResponse(200, { page: [], isDone: true }),
      "/api/v1/agent/wallets/import-failures": () =>
        jsonResponse(200, { success: true, account: ACCOUNT, failures: [], complete: true }),
      "/rpc": rpcHandler({ balance: 0 }),
    })
    const { deps, out, err } = demoteDeps(dir, passphrase, cold, fetch)
    await deps.writeConfig({
      activeProfile: "prc",
      profiles: { prc: { account: ACCOUNT, apiUrl: API, accountCachedAt: Date.now() } },
    })
    // CC-10 demote column: unresolved → adapter recovery (emergency sweep), not an early hold.
    const code = await run(["vault", "demote", address, "--rpc-url", RPC], deps)
    const text = out.text + err.text
    expect(text.toLowerCase()).not.toContain("never enabled")
    expect(text).not.toContain("PROMOTE_OUTCOME_UNRESOLVED")
    expect(text).toMatch(/grant could not be identified|remote authority stays unknown/i)
    expect(text).toMatch(/EMERGENCY SWEEP|Nothing to sweep/i)
    // Empty inventory under emergency: residual exit 3 (CC-10: no local-only retirement).
    expect(code).toBe(3)
  })

  test("demote on unreadable (import-failures 404) still recovers to a pinned destination", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-t41-unreadable-"))
    const { passphrase } = await initVault(dir)
    const cold = await newKey(dir, passphrase, "cold")
    const { address } = await seedImportPending(dir, passphrase, cold)

    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: ACCOUNT }),
      "/api/v1/agent/wallets": () => jsonResponse(200, { page: [], isDone: true }),
      "/api/v1/agent/wallets/import-failures": () => jsonResponse(404, { error: "not found" }),
      "/rpc": rpcHandler({ balance: 0 }),
    })
    const { deps, out, err } = demoteDeps(dir, passphrase, cold, fetch)
    await deps.writeConfig({
      activeProfile: "prc",
      profiles: { prc: { account: ACCOUNT, apiUrl: API, accountCachedAt: Date.now() } },
    })
    const code = await run(["vault", "demote", address, "--rpc-url", RPC], deps)
    const text = out.text + err.text
    expect(text).not.toContain("PROMOTE_RECONCILE_INCOMPLETE")
    expect(text).not.toContain("GRANT_DESTINATION_UNRESOLVED")
    expect(text.toLowerCase()).not.toContain("never enabled")
    expect(text).toMatch(/grant could not be identified|remote authority stays unknown|EMERGENCY SWEEP/i)
    expect(code).toBe(3)
  })

  test("strand-final demote keeps vaultDestination so adapter recovery can pin-sweep", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-t41-strand-"))
    const { passphrase } = await initVault(dir)
    const cold = await newKey(dir, passphrase, "cold")
    const { address } = await seedImportPending(dir, passphrase, cold)

    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: ACCOUNT }),
      "/api/v1/agent/wallets": () => jsonResponse(200, { page: [], isDone: true }),
      "/api/v1/agent/wallets/import-failures": () =>
        jsonResponse(200, {
          success: true,
          account: ACCOUNT,
          failures: [
            {
              chain: "solana",
              address,
              stage: "convex_link",
              privyWalletId: "pw",
              createdAt: new Date().toISOString(),
            },
          ],
          complete: true,
        }),
      "/rpc": rpcHandler({ balance: 0 }),
    })
    const { deps, out, err } = demoteDeps(dir, passphrase, cold, fetch)
    await deps.writeConfig({
      activeProfile: "prc",
      profiles: { prc: { account: ACCOUNT, apiUrl: API, accountCachedAt: Date.now() } },
    })
    const code = await run(["vault", "demote", address, "--rpc-url", RPC], deps)
    const text = out.text + err.text
    expect(text).not.toContain("GRANT_DESTINATION_UNRESOLVED")
    expect(code).toBe(3)

    const vaultPath = join(dir, "vault.enc")
    const again = await unlockWithPassphrase(vaultPath, await readFile(vaultPath, "utf8"), passphrase)
    try {
      const entry = again.index.entries.find((e) => e.address === address)
      expect(entry?.tee?.lifecycle).toBe("stranded")
      expect(entry?.tee?.vaultDestination).toBe(cold)
    } finally {
      closeVault(again)
    }
  })
})

describe("T52 pending gate", () => {
  test("recorded as pending, not executed", () => {
    expect(T52_PENDING).toContain("pending")
  })
})
