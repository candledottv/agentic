/**
 * The ordering test here is the reason this command is shaped the way it is: if any import call
 * were issued before the keystore write landed, a crash in that window would leave a wallet inside
 * Privy whose private key existed only in a dead process. So it asserts against the real
 * filesystem (the keystore must already be readable when the first init call arrives) rather than
 * against a spy, because the invariant is about durability, not call order in memory.
 *
 * The rest cover the states a partial run can leave behind, since import is one wallet at a time
 * and a half-finished batch is the expected case rather than an exceptional one.
 */
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile as realReadFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { run } from "../index"
import { createCapture, createFakeStore, createRoutedFetch, createTestDeps, jsonResponse } from "../test-support"
import { readKeystore } from "../wallet-keystore"

const PASSPHRASE = "correct horse battery staple"
const ENCRYPTION_PUBLIC_KEY = await (async () => {
  const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  return Buffer.from(await crypto.subtle.exportKey("raw", receiver.publicKey)).toString("base64")
})()

async function keystorePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "candle-gen-")), "wallets.enc")
}

/** Routes for a run where every import succeeds. `onInit` observes the moment init is called. */
function routes(
  opts: { onInit?: () => void; submitFails?: number; alreadyExists?: boolean; existingAddress?: string } = {},
) {
  let submits = 0
  return createRoutedFetch({
    "/api/v1/agent/wallets/import/init": () => {
      opts.onInit?.()
      if (opts.alreadyExists) return jsonResponse(400, { success: false, error: { message: "Wallet already exists" } })
      return jsonResponse(200, { success: true, encryptionPublicKey: ENCRYPTION_PUBLIC_KEY })
    },
    "/api/v1/agent/wallets/import/submit": (req) => {
      submits++
      if (opts.submitFails !== undefined && submits > opts.submitFails) {
        return jsonResponse(500, { success: false, error: { message: "upstream exploded" } })
      }
      const body = JSON.parse(String(req.init.body)) as { address: string; chain: string }
      return jsonResponse(200, {
        success: true,
        id: `lw_${submits}`,
        address: body.address,
        chain: body.chain,
        privyWalletId: `pw_${submits}`,
      })
    },
    "/api/v1/agent/wallets": () =>
      jsonResponse(200, {
        success: true,
        page: opts.existingAddress ? [{ _id: "lw_existing", address: opts.existingAddress }] : [],
        isDone: true,
      }),
  })
}

function depsFor(fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) {
  return createTestDeps({
    fetch,
    store: createFakeStore({ api_key: "ck_live_x" }),
    stdout: createCapture(),
    stderr: createCapture(),
    env: { CANDLE_KEYSTORE_PASSPHRASE: PASSPHRASE },
    readFile: async (p: string) => realReadFile(p, "utf8"),
    ...extra,
  } as Parameters<typeof createTestDeps>[0])
}

describe("wallets generate", () => {
  test("the keystore is on disk before any import call is issued", async () => {
    const path = await keystorePath()
    let existedAtFirstInit: boolean | undefined
    const { fetch } = routes({
      onInit: () => {
        if (existedAtFirstInit === undefined) existedAtFirstInit = existsSync(path)
      },
    })
    const code = await run(
      ["wallets", "generate", "--chain", "solana", "--count", "2", "--keystore", path],
      depsFor(fetch),
    )
    expect(code).toBe(0)
    // The invariant: durable before anything was registered anywhere.
    expect(existedAtFirstInit).toBe(true)
  })

  test("every key is sealed and readable back, with the imports recorded", async () => {
    const path = await keystorePath()
    const { fetch } = routes()
    await run(["wallets", "generate", "--chain", "solana", "--count", "3", "--keystore", path], depsFor(fetch))
    const opened = await readKeystore(await realReadFile(path, "utf8"), PASSPHRASE)
    expect(opened.entries).toHaveLength(3)
    expect(opened.entries.every((e) => e.imported)).toBe(true)
    expect(opened.entries.every((e) => e.privateKey.length > 0)).toBe(true)
    expect(new Set(opened.entries.map((e) => e.address)).size).toBe(3)
  })

  test("a failure mid-import leaves every key sealed and only the successes marked", async () => {
    const path = await keystorePath()
    const { fetch } = routes({ submitFails: 1 })
    const code = await run(
      ["wallets", "generate", "--chain", "solana", "--count", "3", "--keystore", path],
      depsFor(fetch),
    )
    expect(code).toBe(1)
    const opened = await readKeystore(await realReadFile(path, "utf8"), PASSPHRASE)
    expect(opened.entries).toHaveLength(3)
    expect(opened.entries.filter((e) => e.imported)).toHaveLength(1)
  })

  test("--resume imports only what is left, and generates nothing new", async () => {
    const path = await keystorePath()
    await run(
      ["wallets", "generate", "--chain", "solana", "--count", "3", "--keystore", path],
      depsFor(routes({ submitFails: 1 }).fetch),
    )
    const before = await readKeystore(await realReadFile(path, "utf8"), PASSPHRASE)

    const { fetch, calls } = routes()
    const code = await run(["wallets", "generate", "--resume", "--keystore", path], depsFor(fetch))
    expect(code).toBe(0)
    const after = await readKeystore(await realReadFile(path, "utf8"), PASSPHRASE)
    expect(after.entries).toHaveLength(3)
    expect(after.entries.every((e) => e.imported)).toBe(true)
    // Same addresses: resume must never mint replacements for keys it already holds.
    expect(after.entries.map((e) => e.address)).toEqual(before.entries.map((e) => e.address))
    // Two wallets were outstanding, so two init calls, not three.
    expect(calls.filter((c) => c.url.includes("/import/init"))).toHaveLength(2)
  })

  test("--resume reconciles a wallet Privy already has", async () => {
    const path = await keystorePath()
    await run(
      ["wallets", "generate", "--chain", "solana", "--count", "1", "--keystore", path],
      depsFor(routes({ submitFails: 0 }).fetch),
    )
    const stalled = await readKeystore(await realReadFile(path, "utf8"), PASSPHRASE)
    expect(stalled.entries[0]?.imported).toBe(false)

    // The crash-between-submit-and-rewrite case: init now refuses the address as already taken,
    // and the account genuinely holds it, which is exactly the state a mid-run crash leaves.
    const { fetch } = routes({ alreadyExists: true, existingAddress: stalled.entries[0]?.address })
    const code = await run(["wallets", "generate", "--resume", "--keystore", path], depsFor(fetch))
    expect(code).toBe(0)
    const opened = await readKeystore(await realReadFile(path, "utf8"), PASSPHRASE)
    expect(opened.entries[0]?.imported).toBe(true)
    expect(opened.entries[0]?.privyWalletId).toBe("lw_existing")
  })

  test("--count with --resume is rejected", async () => {
    const { fetch } = routes()
    expect(await run(["wallets", "generate", "--count", "2", "--resume"], depsFor(fetch))).toBe(2)
  })

  test("--count above the cap is rejected", async () => {
    const path = await keystorePath()
    const { fetch } = routes()
    expect(
      await run(["wallets", "generate", "--chain", "solana", "--count", "51", "--keystore", path], depsFor(fetch)),
    ).toBe(2)
  })

  test("generating over a populated keystore without --resume is refused", async () => {
    const path = await keystorePath()
    await run(["wallets", "generate", "--chain", "solana", "--count", "1", "--keystore", path], depsFor(routes().fetch))
    const before = await realReadFile(path, "utf8")
    const code = await run(
      ["wallets", "generate", "--chain", "solana", "--count", "1", "--keystore", path],
      depsFor(routes().fetch),
    )
    expect(code).toBe(1)
    // Untouched: refusing must never be a partial overwrite of the only copy of a key.
    expect(await realReadFile(path, "utf8")).toBe(before)
  })

  test("hood is an EVM wallet and says so", async () => {
    const path = await keystorePath()
    const stdout = createCapture()
    const { fetch } = routes()
    await run(
      ["wallets", "generate", "--chain", "hood", "--count", "1", "--keystore", path],
      depsFor(fetch, { stdout }),
    )
    const opened = await readKeystore(await realReadFile(path, "utf8"), PASSPHRASE)
    expect(opened.entries[0]?.chain).toBe("evm")
    expect(opened.entries[0]?.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(stdout.text).toContain("every other EVM chain")
  })
})
