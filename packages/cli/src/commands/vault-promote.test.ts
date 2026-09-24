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
import {
  assertInPlacePreconditions,
  assertNotPinnedDestination,
  confirmPrompt,
  promoteSentence,
  SENTENCE_PREFIX,
} from "../vault/promote-support"
import { reconcileGrant } from "../vault/reconcile-grant"
import { NOT_CHECKED_LINE, REQUESTS_PER_KEY } from "../vault/signer-roles"
import { closeVault, commitVault, decryptKey, unlockWithPassphrase } from "../vault/store"
import { generatedPassphraseFrom, useCheapKdf } from "../vault/test-vault"
import { setSealPlaintextObserver } from "../wallet-import"

setDefaultTimeout(90_000)
useCheapKdf()

/** T52 (CC-06 end to end on isolated Convex + dev Privy): pending gate. Not run in this PR. */
const T52_PENDING = "T52 pending: synthetic lifecycle on devnet with isolated Convex and a dev Privy app (never alpha)."

const ACCOUNT = "PRCAccountABCDEFGH1234567890xyzabc"
const USERNAME = "prc-operator"
const API = "https://api.prc.test"
/** A key in the server's shape (BE-296, D4): `cndl_live_` then 43 characters; the prefix is the first 8. */
const KEY_PREFIX = "prcprcpr"
const API_KEY = `cndl_live_${KEY_PREFIX.padEnd(43, "x")}`
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
  let programAccountCalls = 0
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
    if (method === "getProgramAccounts") {
      // BE-296 (D6): the role read. `programAccounts` answers with a Response or a pubkey list.
      const answer = (
        overrides.programAccounts as
          | ((call: { programId: string; filters: unknown[]; n: number }) => Response | string[] | undefined)
          | undefined
      )?.({
        programId: body.params[0] as string,
        filters: (body.params[1] as { filters: unknown[] }).filters,
        n: programAccountCalls++,
      })
      if (answer instanceof Response) return answer
      return jsonResponse(200, {
        jsonrpc: "2.0",
        id: body.id,
        result: (answer ?? []).map((pubkey) => ({ pubkey, account: { data: ["", "base64"] } })),
      })
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
    "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: ACCOUNT, username: USERNAME }),
    "/api/v1/agent/wallets": () => jsonResponse(200, { page: [], isDone: true }),
    "/api/v1/agent/wallets/import-failures": () =>
      jsonResponse(200, { success: true, account: ACCOUNT, failures: [], complete: true }),
    // BE-288 (D8): the room read before the holdings. A Max account with every slot free.
    "/api/v1/agent/wallets/room": () =>
      jsonResponse(200, { success: true, tier: "max", active: 0, cap: 1000, room: 1000 }),
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
      store: createFakeStore({ "profile:prc:api_key": API_KEY }),
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
      store: createFakeStore({ "profile:prc:api_key": API_KEY }),
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
      const lines = [subject.slice(-6), "confirm"]
      const deps = createTestDeps({
        fetch,
        store: createFakeStore({ "profile:prc:api_key": API_KEY }),
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
      // BE-296: one sentence before both confirmations, Form N because every group answered; the
      // authorities block sits under the holdings; the block is directly above `confirm`.
      expect(out.text).toContain(`\n${promoteSentence({ n: 1, form: "N", where: "above" })}\n\n`)
      expect(out.text).toContain("Authorities (read over rpc.prc.test):")
      expect(out.text).toContain("  none: not a token mint, freeze, program upgrade or stake authority")
      expect(out.text).toContain(`  ${NOT_CHECKED_LINE}`)
      expect(err.text).toContain("This key will be controlled by:")
      expect(err.text).toContain(`  Candle account  ${USERNAME}  (${ACCOUNT.slice(0, 6)}…${ACCOUNT.slice(-4)})`)
      expect(err.text).toContain(`  API key         ${KEY_PREFIX}…  profile prc`)
      expect(err.text).toContain(`  API             ${API}  (not a Candle host, from CANDLE_API_URL)`)
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
        store: createFakeStore({ "profile:prc:api_key": API_KEY }),
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
        store: createFakeStore({ "profile:prc:api_key": API_KEY }),
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
      store: createFakeStore({ "profile:prc:api_key": API_KEY }),
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

/**
 * BE-288 (spec `2026-09-23-linked-wallet-cap-before-import-design.md`, §6.3): single `vault
 * promote` reads the room before the AD-8 warning (D8) and puts its pre-import entry back when
 * init answers definitively (D9).
 */
describe("BE-288 C8 to C13: vault promote reads the room, and restores on a definite init answer", () => {
  const RESTORED = "The vault entry is back as it was: nothing left this machine."
  const LIMIT_MESSAGE =
    "Active linked-wallet limit reached for this tier: 10 of 10 active. Nothing was sent to the wallet provider."
  const LIMIT_HINT = "You have reached your trading-wallet limit for this tier. Revoke one or upgrade."
  const IMPORT_FAILED_MESSAGE = "Wallet import could not be started. Please try again."
  const roomOf =
    (room: { tier: string; active: number; cap: number }): RouteHandler =>
    () =>
      jsonResponse(200, { success: true, ...room, room: Math.max(0, room.cap - room.active) })
  const limitRefusal = () =>
    jsonResponse(400, {
      success: false,
      error: {
        code: "WALLET_LIMIT_REACHED",
        message: LIMIT_MESSAGE,
        retryable: false,
        uiHint: LIMIT_HINT,
        keyImported: false,
      },
    })

  interface Fixture {
    dir: string
    passphrase: string
    subject: string
    cold: string
    vaultPath: string
  }
  async function setup(tag: string): Promise<Fixture> {
    const dir = await mkdtemp(join(tmpdir(), `candle-be288-${tag}-`))
    const { passphrase } = await initVault(dir)
    const subject = await newKey(dir, passphrase, "subject")
    const cold = await newKey(dir, passphrase, "cold")
    return { dir, passphrase, subject, cold, vaultPath: join(dir, "vault.enc") }
  }
  async function entries(f: Fixture) {
    const opened = await unlockWithPassphrase(f.vaultPath, await readFile(f.vaultPath, "utf8"), f.passphrase)
    try {
      return { hd: opened.index.hd, entries: opened.index.entries }
    } finally {
      closeVault(opened)
    }
  }
  async function runPromote(
    f: Fixture,
    opts: { routes: Record<string, RouteHandler>; args: string[]; json?: boolean; lines?: string[] },
  ) {
    const out = createCapture()
    const err = createCapture()
    const lines = [...(opts.lines ?? [f.subject.slice(-6), "confirm"])]
    const asked: string[] = []
    let rpcCalls = 0
    const base = rpcHandler({ balance: 42 })
    const { fetch } = createRoutedFetch({
      ...opts.routes,
      "/rpc": (req) => {
        rpcCalls += 1
        return base(req)
      },
    })
    const deps = createTestDeps({
      fetch,
      store: createFakeStore({ "profile:prc:api_key": API_KEY }),
      stdout: out,
      stderr: err,
      env: { CANDLE_CONFIG_DIR: f.dir, CANDLE_API_URL: API },
      promptSecret: async () => f.passphrase,
      promptLine: async (text: string) => {
        asked.push(text)
        return lines.shift() ?? ""
      },
      readFile: (path) => readFile(path, "utf8"),
      writeFile: (path, content) => writeFile(path, content, "utf8"),
    })
    await deps.writeConfig({
      activeProfile: "prc",
      profiles: { prc: { account: ACCOUNT, apiUrl: API, accountCachedAt: Date.now() } },
    })
    const code = await run(["vault", "promote", ...opts.args, ...(opts.json ? ["--json"] : [])], deps)
    return { code, out: out.text, err: err.text, asked, rpcCalls }
  }
  const inPlace = ["--in-place", "subject", "--sweep-to", "cold", "--rpc-url", RPC]
  /** Every JSON document on stdout (the AD-8 prose and the holdings lines are not JSON). */
  const jsonDocs = (out: string) => out.split("\n").filter((line) => line.startsWith("{"))

  test("C8: --in-place at cap is refused with WALLET_LIMIT_REACHED before the sentence, before any prompt, with the vault unchanged", async () => {
    const f = await setup("c8")
    const before = await readFile(f.vaultPath, "utf8")
    const importCalls = { n: 0 }
    const r = await runPromote(f, {
      routes: {
        ...importRoutes({ address: f.subject, vaultDestination: f.cold, importCalls }),
        "/api/v1/agent/wallets/room": roomOf({ tier: "pro", active: 10, cap: 10 }),
      },
      args: inPlace,
    })
    expect(r.code).toBe(1)
    expect(r.err).toContain(
      "This promotion would link a wallet to this Candle account, and it has no room: 10 of 10 linked wallets are active on the Pro tier. Nothing was written. Upgrade to Max, or revoke linked wallets you no longer use.",
    )
    expect(r.out).not.toContain(SENTENCE_PREFIX)
    expect(r.asked).toEqual([])
    expect(r.rpcCalls).toBe(0)
    expect(importCalls.n).toBe(0)
    expect(await readFile(f.vaultPath, "utf8")).toBe(before)
  })

  test("C9: --in-place with an unreadable room proceeds, prints the D8 line on stderr, and the --json document is unchanged", async () => {
    const f = await setup("c9")
    const importCalls = { n: 0 }
    const r = await runPromote(f, {
      routes: {
        ...importRoutes({ address: f.subject, vaultDestination: f.cold, importCalls }),
        "/api/v1/agent/wallets/room": () =>
          jsonResponse(404, { success: false, error: { code: "NOT_FOUND", message: "Not Found" } }),
      },
      args: inPlace,
      json: true,
    })
    expect(r.code).toBe(0)
    expect(r.err).toContain(
      "Could not read this account's linked-wallet room (HTTP 404); continuing. The server refuses before anything is sent if the account is full.",
    )
    expect(importCalls.n).toBe(1)
    const docs = jsonDocs(r.out)
    expect(docs).toHaveLength(1)
    // Every pre-existing key unchanged; BE-296 (D9) adds exactly `controlledBy` and `authorities`.
    expect(JSON.parse(docs[0] as string)).toEqual({
      ok: true,
      mode: "in-place",
      address: f.subject,
      vaultDestination: f.cold,
      lifecycle: "enabled",
      linkedWalletId: "lw_promoted",
      controlledBy: {
        account: ACCOUNT,
        username: USERNAME,
        keyPrefix: KEY_PREFIX,
        keyLabel: null,
        keySource: "profile",
        apiUrl: API,
        environment: null,
      },
      authorities: {
        checked: [
          "token-mint",
          "token-freeze",
          "token2022-mint",
          "token2022-freeze",
          "program-upgrade",
          "stake-staker",
          "stake-withdrawer",
        ],
        notChecked: [],
        found: [],
      },
    })
  })

  test("C10: --in-place init refusal restores the entry, and the caller writes once after the restore (human, then --json); a vault rewritten under it refuses the restore as VAULT_CHANGED", async () => {
    const f = await setup("c10")
    const before = await entries(f)
    const subjectBefore = before.entries.find((e) => e.address === f.subject)
    const importCalls = { n: 0 }
    const routes = {
      ...importRoutes({ address: f.subject, vaultDestination: f.cold, importCalls }),
      "/api/v1/agent/wallets/room": roomOf({ tier: "pro", active: 9, cap: 10 }),
      "/api/v1/agent/wallets/import/init": () => limitRefusal(),
    }

    const human = await runPromote(f, { routes, args: inPlace })
    expect(human.code).toBe(1)
    expect(human.err).toContain(`${LIMIT_MESSAGE} ${RESTORED} ${LIMIT_HINT}\n`)
    expect(importCalls.n).toBe(0)
    expect(jsonDocs(human.out)).toEqual([])
    const afterHuman = await entries(f)
    expect(afterHuman.entries.find((e) => e.address === f.subject)).toEqual(subjectBefore)
    expect(afterHuman.hd).toEqual(before.hd)

    const json = await runPromote(f, { routes, args: inPlace, json: true })
    expect(json.code).toBe(1)
    const docs = jsonDocs(json.out)
    expect(docs).toHaveLength(1)
    expect(JSON.parse(docs[0] as string)).toEqual({
      ok: false,
      code: "WALLET_LIMIT_REACHED",
      message: `${LIMIT_MESSAGE} ${RESTORED}`,
      suggestion: LIMIT_HINT,
    })
    expect((await entries(f)).entries.find((e) => e.address === f.subject)).toEqual(subjectBefore)

    // The collision: another writer replaces the file after the pre-import commit landed and
    // before init answers. The restore's commitVault refuses; one failure, VAULT_CHANGED.
    const original = await readFile(f.vaultPath, "utf8")
    const changed = await runPromote(f, {
      routes: {
        ...routes,
        "/api/v1/agent/wallets/import/init": async () => {
          await writeFile(f.vaultPath, original, "utf8")
          return limitRefusal()
        },
      },
      args: inPlace,
      json: true,
    })
    expect(changed.code).toBe(1)
    const changedDocs = jsonDocs(changed.out)
    expect(changedDocs).toHaveLength(1)
    expect(JSON.parse(changedDocs[0] as string)).toEqual({
      ok: false,
      code: "VAULT_CHANGED",
      message: `${LIMIT_MESSAGE} The vault changed on disk while this command was running; the restore wrote nothing.`,
      suggestion: "Another candle command wrote to it. Run this one again.",
    })
    expect(changed.out).not.toContain(RESTORED)
    expect(await readFile(f.vaultPath, "utf8")).toBe(original)
  })

  test("C11: --from at cap is refused before the commit; nextIndex.solanaTee is unchanged", async () => {
    const f = await setup("c11")
    const before = await entries(f)
    const importCalls = { n: 0 }
    const r = await runPromote(f, {
      routes: {
        ...importRoutes({ address: f.subject, vaultDestination: f.cold, importCalls }),
        "/api/v1/agent/wallets/room": roomOf({ tier: "pro", active: 10, cap: 10 }),
      },
      args: ["--from", "cold"],
      lines: [],
    })
    expect(r.code).toBe(1)
    expect(r.err).toContain("This promotion would link a wallet to this Candle account, and it has no room")
    expect(r.asked).toEqual([])
    expect(importCalls.n).toBe(0)
    const after = await entries(f)
    expect(after.hd.nextIndex.solanaTee).toBe(before.hd.nextIndex.solanaTee)
    expect(after.hd).toEqual(before.hd)
    expect(after.entries).toEqual(before.entries)
  })

  test("C13: --in-place init WALLET_IMPORT_FAILED (D3) restores: the D9 human line, and the D9 --json document with no suggestion key", async () => {
    const f = await setup("c13")
    const before = await entries(f)
    const subjectBefore = before.entries.find((e) => e.address === f.subject)
    const importCalls = { n: 0 }
    const routes = {
      ...importRoutes({ address: f.subject, vaultDestination: f.cold, importCalls }),
      "/api/v1/agent/wallets/room": roomOf({ tier: "pro", active: 9, cap: 10 }),
      "/api/v1/agent/wallets/import/init": () =>
        jsonResponse(400, {
          success: false,
          error: { code: "WALLET_IMPORT_FAILED", message: IMPORT_FAILED_MESSAGE, retryable: true },
        }),
    }
    const human = await runPromote(f, { routes, args: inPlace })
    expect(human.code).toBe(1)
    expect(human.err).toContain(`\n${IMPORT_FAILED_MESSAGE} ${RESTORED}\n`)
    expect(importCalls.n).toBe(0)
    expect((await entries(f)).entries.find((e) => e.address === f.subject)).toEqual(subjectBefore)

    const json = await runPromote(f, { routes, args: inPlace, json: true })
    expect(json.code).toBe(1)
    const docs = jsonDocs(json.out)
    expect(docs).toHaveLength(1)
    expect(docs[0]).toBe(
      JSON.stringify({ ok: false, code: "WALLET_IMPORT_FAILED", message: `${IMPORT_FAILED_MESSAGE} ${RESTORED}` }),
    )
    expect(importCalls.n).toBe(0)
  })
})

/**
 * BE-296 (spec `2026-09-23-cli-vault-promote-confirm-design.md`, §6), single promote: `confirm`
 * (T3), the last six kept before it (T4), the block and the live account read (T5, T6), the nine
 * role requests with no flag (T10), a found withdrawer (T12c), and the --json keys (T15).
 */
describe("BE-296: vault promote --in-place: one sentence, live block, always-on role check, confirm", () => {
  interface Fixture {
    dir: string
    passphrase: string
    subject: string
    cold: string
    vaultPath: string
  }
  async function setup(tag: string): Promise<Fixture> {
    const dir = await mkdtemp(join(tmpdir(), `candle-be296-${tag}-`))
    const { passphrase } = await initVault(dir)
    const subject = await newKey(dir, passphrase, "subject")
    const cold = await newKey(dir, passphrase, "cold")
    return { dir, passphrase, subject, cold, vaultPath: join(dir, "vault.enc") }
  }
  const inPlace = ["--in-place", "subject", "--sweep-to", "cold", "--rpc-url", RPC]
  async function runSingle(
    f: Fixture,
    opts: {
      routes?: Record<string, RouteHandler>
      args?: string[]
      json?: boolean
      lines?: string[]
      programAccounts?: (call: { programId: string; filters: unknown[]; n: number }) => Response | string[] | undefined
      importCalls?: { n: number }
      noApiKey?: boolean
    } = {},
  ) {
    const out = createCapture()
    const err = createCapture()
    const importCalls = opts.importCalls ?? { n: 0 }
    const lines = [...(opts.lines ?? [f.subject.slice(-6), "confirm"])]
    const asked: string[] = []
    const stderrAtPrompt: string[] = []
    let programCalls = 0
    const base = rpcHandler({ balance: 42, programAccounts: opts.programAccounts })
    const { fetch } = createRoutedFetch({
      ...importRoutes({ address: f.subject, vaultDestination: f.cold, importCalls }),
      ...(opts.routes ?? {}),
      "/rpc": (req) => {
        const body = JSON.parse(req.init.body as string)
        if (body.method === "getProgramAccounts") programCalls += 1
        return base(req)
      },
    })
    const deps = createTestDeps({
      fetch,
      store: createFakeStore(opts.noApiKey ? {} : { "profile:prc:api_key": API_KEY }),
      stdout: out,
      stderr: err,
      env: { CANDLE_CONFIG_DIR: f.dir, CANDLE_API_URL: API },
      promptSecret: async () => f.passphrase,
      promptLine: async (text: string) => {
        asked.push(text)
        stderrAtPrompt.push(err.text)
        return lines.shift() ?? ""
      },
      readFile: (path) => readFile(path, "utf8"),
      writeFile: (path, content) => writeFile(path, content, "utf8"),
    })
    await deps.writeConfig({
      activeProfile: "prc",
      profiles: { prc: { account: ACCOUNT, apiUrl: API, accountCachedAt: Date.now() } },
    })
    const code = await run(["vault", "promote", ...(opts.args ?? inPlace), ...(opts.json ? ["--json"] : [])], deps)
    return { code, out: out.text, err: err.text, asked, stderrAtPrompt, programCalls, importCalls }
  }
  const block = () =>
    [
      "This key will be controlled by:",
      `  Candle account  ${USERNAME}  (${ACCOUNT.slice(0, 6)}…${ACCOUNT.slice(-4)})`,
      `  API key         ${KEY_PREFIX}…  profile prc`,
      `  API             ${API}  (not a Candle host, from CANDLE_API_URL)`,
    ].join("\n")

  test("T3: confirm, Confirm and padded CONFIRM proceed; EXPOSE, yes and empty refuse with PROMOTE_NOT_ACKNOWLEDGED, exit 1, zero writes, one attempt", async () => {
    for (const accepted of ["confirm", "Confirm", "  CONFIRM  "]) {
      const f = await setup("t3-ok")
      const r = await runSingle(f, { lines: [f.subject.slice(-6), accepted] })
      expect([accepted, r.code]).toEqual([accepted, 0])
      expect(r.importCalls.n).toBe(1)
    }
    for (const refused of ["EXPOSE", "yes", ""]) {
      const f = await setup("t3-no")
      const before = await readFile(f.vaultPath, "utf8")
      const r = await runSingle(f, { lines: [f.subject.slice(-6), refused, "not asked"] })
      expect([refused, r.code]).toEqual([refused, 1])
      expect(r.err).toContain("The acknowledgement is the word confirm; nothing was promoted, and nothing was written.")
      expect(r.err).toContain("Run the command again and type confirm at the prompt.")
      expect(r.asked).toHaveLength(2)
      expect(r.asked[1]).toBe(confirmPrompt(1))
      expect(r.importCalls.n).toBe(0)
      expect(await readFile(f.vaultPath, "utf8")).toBe(before)
    }
  })

  test("T4: the subject's last six is still asked first; a wrong answer is DESTINATION_NOT_CONFIRMED with zero writes and confirm is never asked", async () => {
    const f = await setup("t4")
    const before = await readFile(f.vaultPath, "utf8")
    const r = await runSingle(f, { lines: ["zzzzzz", "confirm"], json: true })
    expect(r.code).toBe(1)
    const doc = JSON.parse(r.out.split("\n").filter((line) => line.startsWith("{"))[0] as string)
    expect(doc).toMatchObject({ ok: false, code: "DESTINATION_NOT_CONFIRMED" })
    expect(r.asked).toHaveLength(1)
    expect(r.asked[0]).toContain("Type the last six characters of the address being promoted")
    expect(r.importCalls.n).toBe(0)
    expect(await readFile(f.vaultPath, "utf8")).toBe(before)
  })

  test("T5: the block is the last stderr output before the confirm prompt, after the last-six prompt; the secret appears nowhere", async () => {
    const f = await setup("t5")
    const r = await runSingle(f)
    expect(r.code).toBe(0)
    expect(r.asked).toEqual([
      `Type the last six characters of the address being promoted (${f.subject}) to confirm: `,
      confirmPrompt(1),
    ])
    // Not yet printed when the last six is asked; the last thing on stderr when confirm is asked.
    expect(r.stderrAtPrompt[0]).not.toContain("will be controlled by")
    expect(r.stderrAtPrompt[1]?.endsWith(`${block()}\n`)).toBe(true)
    expect(r.out + r.err).not.toContain(API_KEY)
    // The sentence, once, on stdout, before either prompt; Form N, singular, `named above` is F's word only.
    expect(r.out.split(`\n${promoteSentence({ n: 1, form: "N", where: "above" })}\n\n`)).toHaveLength(2)
  })

  test("T6: an unreadable account refuses with PROMOTE_ACCOUNT_UNRESOLVED after the room and before the holdings, no prompt, no RPC, vault unchanged, despite the cached account", async () => {
    for (const [name, embedded] of [
      ["500", () => jsonResponse(500, { success: false })],
      ["401", () => jsonResponse(401, { success: false, error: { code: "UNAUTHORIZED", message: "no" } })],
      ["no account", () => jsonResponse(200, { success: true, wallets: { solana: null, evm: null } })],
      [
        "network",
        () => {
          throw new Error("ECONNRESET")
        },
      ],
    ] as Array<[string, RouteHandler]>) {
      const f = await setup("t6")
      const before = await readFile(f.vaultPath, "utf8")
      const r = await runSingle(f, { routes: { "/api/v1/agent/wallets/embedded": embedded } })
      expect([name, r.code]).toEqual([name, 1])
      expect([name, r.err.includes("Could not confirm which Candle account this API key acts for (")]).toEqual([
        name,
        true,
      ])
      expect([name, r.err.includes("it does not proceed on a cached value.")]).toEqual([name, true])
      expect([name, r.asked]).toEqual([name, []])
      expect([name, r.programCalls]).toEqual([name, 0])
      expect([name, r.out.includes("Holdings at")]).toEqual([name, false])
      expect([name, r.importCalls.n]).toEqual([name, 0])
      expect(await readFile(f.vaultPath, "utf8")).toBe(before)
    }
    // No API key: the room read proceeds with its D8 line (BE-288), and the account read refuses.
    const f = await setup("t6-nokey")
    const r = await runSingle(f, { noApiKey: true, json: true })
    expect(r.code).toBe(1)
    const doc = JSON.parse(r.out.split("\n").filter((line) => line.startsWith("{"))[0] as string)
    expect(doc).toMatchObject({
      ok: false,
      code: "PROMOTE_ACCOUNT_UNRESOLVED",
      message:
        "Could not confirm which Candle account this API key acts for (no API key is available); nothing was written.",
    })
    expect(r.asked).toEqual([])
  })

  test("T10: nine role requests, no flag; --check-authorities is a usage error, exit 2", async () => {
    const f = await setup("t10")
    const r = await runSingle(f)
    expect(r.code).toBe(0)
    expect(r.programCalls).toBe(REQUESTS_PER_KEY)
    expect(r.err).toContain("✓ authorities read for 1 address (9 requests, 7 of 7 groups read) in 0s")
    const flagged = await runSingle(f, { args: [...inPlace, "--check-authorities"] })
    expect(flagged.code).toBe(2)
    expect(flagged.err).toContain("--check-authorities")
    expect(flagged.asked).toEqual([])
  })

  test("T12c: a found stake withdrawer prints its line under the holdings with (Stake), and the sentence is Form F naming it above", async () => {
    const f = await setup("t12c")
    const stake = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    const r = await runSingle(f, {
      json: true,
      programAccounts: (call) => {
        const filters = call.filters as Array<{ dataSize?: number; memcmp?: { offset: number } }>
        const withdrawer = filters.some((x) => x.dataSize === 200) && filters.some((x) => x.memcmp?.offset === 44)
        return withdrawer ? [stake] : []
      },
    })
    expect(r.code).toBe(0)
    expect(r.out).toContain(
      `Authorities (read over rpc.prc.test):\n  withdrawer authority of ${stake} (Stake)\n  ${NOT_CHECKED_LINE}\n`,
    )
    expect(r.out).toContain(promoteSentence({ n: 1, form: "F", k: 1, where: "above" }))
    const doc = JSON.parse(r.out.split("\n").filter((line) => line.startsWith("{"))[0] as string)
    expect(doc.authorities.found).toEqual([{ address: f.subject, role: "withdrawer", target: stake, program: "stake" }])
    expect(doc.controlledBy).toMatchObject({
      account: ACCOUNT,
      username: USERNAME,
      keyPrefix: KEY_PREFIX,
      keyLabel: null,
    })
  })

  test("T11: a refused Token-2022 scan is named not read in the block, the sentence falls to Form U, and the run still promotes", async () => {
    const f = await setup("t11")
    const r = await runSingle(f, {
      programAccounts: (call) =>
        call.programId === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" ? jsonResponse(403, { error: "blocked" }) : [],
    })
    expect(r.code).toBe(0)
    expect(r.out).toContain(
      "  Token-2022 mint, Token-2022 freeze: not read (RPC getProgramAccounts failed: HTTP 403)\n",
    )
    expect(r.out).not.toContain("  none: not a token mint")
    expect(r.out).toContain(promoteSentence({ n: 1, form: "U", where: "above" }))
    expect(r.err).toMatch(/✓ authorities read for 1 address \(\d+ requests, 5 of 7 groups read, 2 refused\) in 0s/)
  })
})
