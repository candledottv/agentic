/**
 * Export is the escape hatch that makes independent random keys survivable: the keystore is the
 * only copy, so there has to be a way out. Everything worth pinning is about restraint. It prints
 * one key, never a set, and never without a second deliberate step.
 */
import { describe, expect, test } from "bun:test"
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

function routes() {
  let n = 0
  return createRoutedFetch({
    "/api/v1/agent/wallets/import/init": () =>
      jsonResponse(200, { success: true, encryptionPublicKey: ENCRYPTION_PUBLIC_KEY }),
    "/api/v1/agent/wallets/import/submit": (req) => {
      n++
      const body = JSON.parse(String(req.init.body)) as { address: string; chain: string }
      return jsonResponse(200, {
        success: true,
        id: `lw_${n}`,
        address: body.address,
        chain: body.chain,
        privyWalletId: `pw_${n}`,
      })
    },
    "/api/v1/agent/wallets": () => jsonResponse(200, { success: true, page: [], isDone: true }),
  })
}

function depsFor(extra: Record<string, unknown> = {}) {
  return createTestDeps({
    fetch: routes().fetch,
    store: createFakeStore({ api_key: "ck_live_x" }),
    stdout: createCapture(),
    stderr: createCapture(),
    env: { CANDLE_KEYSTORE_PASSPHRASE: PASSPHRASE },
    readFile: async (p: string) => realReadFile(p, "utf8"),
    ...extra,
  } as Parameters<typeof createTestDeps>[0])
}

/** Generates a real 3-wallet keystore, so export is tested against the format it will meet. */
async function seededKeystore(): Promise<{ path: string; keys: string[]; addresses: string[] }> {
  const path = join(await mkdtemp(join(tmpdir(), "candle-export-")), "wallets.enc")
  await run(["wallets", "generate", "--chain", "solana", "--count", "3", "--keystore", path], depsFor())
  const { entries } = await readKeystore(await realReadFile(path, "utf8"), PASSPHRASE)
  return { path, keys: entries.map((e) => e.privateKey), addresses: entries.map((e) => e.address) }
}

describe("wallets export", () => {
  test("prints exactly one key, and only the one asked for", async () => {
    const { path, keys } = await seededKeystore()
    const stdout = createCapture()
    const code = await run(["wallets", "export", "--index", "1", "--yes", "--keystore", path], depsFor({ stdout }))
    expect(code).toBe(0)
    expect(stdout.text).toContain(keys[1] as string)
    expect(stdout.text).not.toContain(keys[0] as string)
    expect(stdout.text).not.toContain(keys[2] as string)
  })

  test("without --yes it names the wallet but prints no key", async () => {
    const { path, keys, addresses } = await seededKeystore()
    const stdout = createCapture()
    const code = await run(["wallets", "export", "--index", "1", "--keystore", path], depsFor({ stdout }))
    expect(code).toBe(1)
    expect(stdout.text).toContain(addresses[1] as string)
    expect(stdout.text).not.toContain(keys[1] as string)
  })

  test("an out-of-range index is refused and prints nothing", async () => {
    const { path, keys } = await seededKeystore()
    const stdout = createCapture()
    const code = await run(["wallets", "export", "--index", "9", "--yes", "--keystore", path], depsFor({ stdout }))
    expect(code).toBe(1)
    for (const k of keys) expect(stdout.text).not.toContain(k)
  })

  test("--index is required: there is no way to ask for everything", async () => {
    const { path } = await seededKeystore()
    expect(await run(["wallets", "export", "--yes", "--keystore", path], depsFor())).toBe(2)
  })

  test("there is no --all flag", async () => {
    const { path } = await seededKeystore()
    expect(await run(["wallets", "export", "--all", "--keystore", path], depsFor())).toBe(2)
  })

  test("a wrong passphrase fails closed and prints no key", async () => {
    const { path, keys } = await seededKeystore()
    const stdout = createCapture()
    const code = await run(
      ["wallets", "export", "--index", "0", "--yes", "--keystore", path],
      depsFor({ stdout, env: { CANDLE_KEYSTORE_PASSPHRASE: "wrong" } }),
    )
    expect(code).toBe(1)
    expect(stdout.text).not.toContain(keys[0] as string)
  })
})
