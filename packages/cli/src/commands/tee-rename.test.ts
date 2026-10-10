/**
 * BE-1146 (spec `2026-10-09-cli-transfer-confirm-and-batch-rename-design.md`, 2.3 and 2.5):
 * `candle tee rename`, end to end through `run()`, against a real vault and a fake rename route.
 *
 * The fake route keeps a table of linked wallets and answers the preview and the commit the way
 * the API does (apps/api's `agent.linked-wallet-rename.test.ts` pins the real one), so a test can
 * read what the server holds after a run. Every vault is made through the real creation path, and
 * its TEE entries through `vault import-legacy --tee`, the route `vault-rename.test.ts` uses.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { base58 } from "@scure/base"
import { Keypair } from "@solana/web3.js"
import { run } from "../index"
import {
  type CapturedRequest,
  createCapture,
  createFakeConfigStore,
  createFakeStore,
  createRoutedFetch,
  createTestDeps,
  jsonResponse,
  TEST_HOME,
} from "../test-support"
import type { KeyEntry } from "../vault/format"
import { closeVault } from "../vault/store"
import { makeVault, readVaultJson, reopen, tempDir, useCheapKdf } from "../vault/test-vault"
import {
  createKeystore,
  defaultTeeKeystorePath,
  type KeystoreEntry,
  serializeKeystore,
  TEE_KEYSTORE_PURPOSE,
  writeKeystoreFile,
} from "../wallet-keystore"
import { rerunFile, TEE_RENAME_USAGE } from "./tee-rename"

setDefaultTimeout(60_000)
useCheapKdf()

const PATH = "/api/v1/agent/linked-wallets/rename"
const ACCOUNT = "FfU8M5xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx8pPD"
const DEVICE = { "profile:production:device_token": "cndl_dvc_x" }

interface ServerWallet {
  id: string
  chain: "solana" | "evm"
  address: string
  label: string | null
  tee: boolean
}

/** The rename route over a table of wallets: the preview resolves handles, the commit writes. */
function renameApi(wallets: ServerWallet[], opts: { onCommit?: () => Promise<void>; status?: number } = {}) {
  const previews: Record<string, unknown>[] = []
  const commits: Record<string, unknown>[] = []
  const auth: (string | null)[] = []
  const refuse = (findings: unknown[]) =>
    jsonResponse(400, {
      success: false,
      error: { code: "VALIDATION_FAILED", message: "Rename refused; nothing changed.", retryable: false, findings },
    })
  const { fetch, calls, unmatched } = createRoutedFetch({
    [PATH]: async (req: CapturedRequest) => {
      auth.push(new Headers(req.init.headers).get("authorization"))
      if (opts.status !== undefined) {
        return jsonResponse(opts.status, { success: false, error: { code: "NOT_FOUND", message: "Not found" } })
      }
      const body = JSON.parse(String(req.init.body ?? "{}")) as {
        dryRun?: boolean
        renames: Array<{ wallet?: string; id?: string; label: string }>
      }
      if (body.dryRun === true) {
        previews.push(body)
        const findings: unknown[] = []
        const renamed: unknown[] = []
        const unchanged: unknown[] = []
        for (const [row, { wallet, label }] of body.renames.entries()) {
          const matches = wallets.filter((w) => w.id === wallet || w.address === wallet || w.label === wallet)
          if (matches.length === 0) {
            findings.push({
              row,
              wallet,
              reason: "not_found",
              problem: `${wallet} does not name an active linked wallet on this account.`,
            })
          } else if (matches.length > 1) {
            findings.push({
              row,
              wallet,
              reason: "ambiguous",
              problem: `${wallet} names more than one wallet; use an id or an address.`,
              matches: matches.map((w) => ({ id: w.id, address: w.address, label: w.label })),
            })
          } else {
            const w = matches[0] as ServerWallet
            const view = { row, id: w.id, chain: w.chain, address: w.address, from: w.label, label, tee: w.tee }
            if (w.label === label) unchanged.push(view)
            else renamed.push(view)
          }
        }
        if (findings.length > 0) return refuse(findings)
        return jsonResponse(200, { success: true, dryRun: true, renamed, unchanged })
      }
      commits.push(body)
      const renamed: unknown[] = []
      for (const { id, label } of body.renames) {
        const w = wallets.find((candidate) => candidate.id === id) as ServerWallet
        renamed.push({ id: w.id, chain: w.chain, address: w.address, from: w.label, label })
        w.label = label
      }
      await opts.onCommit?.()
      return jsonResponse(200, { success: true, renamed, unchanged: [] })
    },
  })
  return { fetch, calls, unmatched, previews, commits, auth }
}

interface Fixture {
  dir: string
  path: string
  passphrase: string
}

async function fixture(): Promise<Fixture> {
  const made = await makeVault()
  closeVault(made.vault)
  return { dir: made.dir, path: made.path, passphrase: made.passphrase }
}

interface Run {
  code: number
  stdout: string
  stderr: string
  /** How many times the passphrase was asked for: zero proves the vault was not opened. */
  prompted: number
}

async function cmd(
  dir: string,
  passphrase: string,
  argv: string[],
  fetch: typeof globalThis.fetch,
  opts: { tty?: boolean; store?: Record<string, string>; env?: Record<string, string> } = {},
): Promise<Run> {
  const stdout = createCapture()
  const stderr = createCapture()
  let prompted = 0
  const configStore = createFakeConfigStore({
    profiles: { production: { account: ACCOUNT, username: "Quant-", apiUrl: "https://api.alpha.candle.tv" } },
    activeProfile: "production",
  })
  const deps = createTestDeps({
    fetch,
    store: createFakeStore(opts.store ?? DEVICE),
    readFile: (path) => readFile(path, "utf8"),
    stdout,
    stderr,
    env: { CANDLE_CONFIG_DIR: dir, HOME: dir, ...(opts.env ?? {}) },
    readConfig: configStore.readConfig,
    writeConfig: configStore.writeConfig,
    clearConfig: configStore.clearConfig,
    updateProfile: configStore.updateProfile,
    isTTY:
      opts.tty === false ? { stdin: false, stdout: false, stderr: false } : { stdin: true, stdout: true, stderr: true },
    promptSecret: async () => {
      prompted++
      return passphrase
    },
    promptLine: async () => {
      throw new Error("tee rename has no typed confirmation")
    },
  })
  const code = await run(argv, deps)
  return { code, stdout: stdout.text, stderr: stderr.text, prompted }
}

function json(out: Run): Record<string, unknown> {
  const lines = out.stdout.trimEnd().split("\n").filter(Boolean)
  expect(lines, `expected one JSON line, got:\n${out.stdout}\n${out.stderr}`).toHaveLength(1)
  return JSON.parse(lines[0] as string) as Record<string, unknown>
}

const TEE_PASS = "a strong tee-store passphrase for BE-1146"

function legacyEntry(label: string, index: number): KeystoreEntry {
  const keypair = Keypair.generate()
  return {
    index,
    chain: "solana",
    address: keypair.publicKey.toBase58(),
    label,
    createdAt: "2026-09-17T00:00:00.000Z",
    privateKey: base58.encode(keypair.secretKey),
    imported: false,
    tee: { network: "solana-mainnet" },
  }
}

/** Puts TEE wallets in the vault: a Phase 1 store, migrated with `vault import-legacy --tee`. */
async function teeWallets(fx: Fixture, labels: string[]): Promise<Record<string, string>> {
  const legacy = labels.map((label, at) => legacyEntry(label, at))
  const ks = await createKeystore(TEE_PASS)
  const teePath = defaultTeeKeystorePath({ CANDLE_CONFIG_DIR: fx.dir }, TEST_HOME)
  await writeKeystoreFile(
    teePath,
    await serializeKeystore(legacy, ks.key, ks.salt, ks.iterations, TEE_KEYSTORE_PURPOSE),
  )
  const secrets = [TEE_PASS, fx.passphrase]
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    fetch: (async () => {
      throw new Error("import-legacy makes no request")
    }) as unknown as typeof fetch,
    stdout,
    stderr,
    env: { CANDLE_CONFIG_DIR: fx.dir, HOME: fx.dir },
    isTTY: { stdin: true, stdout: true, stderr: true },
    promptSecret: async () => secrets.shift() as string,
    readFile: (path) => readFile(path, "utf8"),
    writeFile: (path, content) => writeFile(path, content, "utf8"),
  })
  const code = await run(["vault", "import-legacy", "--tee", "--from", teePath, "--keystore", fx.path], deps)
  if (code !== 0) throw new Error(`import-legacy failed (${code}): ${stderr.text}${stdout.text}`)
  return Object.fromEntries(legacy.map((entry) => [entry.label, entry.address]))
}

/** A vault key, through the real command, with no request. */
async function vaultKey(fx: Fixture, label: string): Promise<void> {
  const out = await cmd(
    fx.dir,
    fx.passphrase,
    ["vault", "new-key", "--chain", "solana", "--label", label],
    (async () => {
      throw new Error("new-key makes no request")
    }) as unknown as typeof fetch,
  )
  if (out.code !== 0) throw new Error(`new-key ${label} failed: ${out.stderr}${out.stdout}`)
}

async function entries(fx: Fixture): Promise<KeyEntry[]> {
  const vault = await reopen(fx.path, fx.passphrase)
  try {
    return vault.index.entries
  } finally {
    closeVault(vault)
  }
}
const labels = async (fx: Fixture) => (await entries(fx)).map((entry) => entry.label)
const generation = async (fx: Fixture) => (await readVaultJson(fx.path)).generation
const bytes = (fx: Fixture) => readFile(fx.path, "utf8")
const serverWallet = (id: string, address: string, label: string, tee = true): ServerWallet => ({
  id,
  chain: "solana",
  address,
  label,
  tee,
})

async function pairsFile(fx: Fixture, contents: string): Promise<string> {
  const file = join(fx.dir, `pairs-${Math.random().toString(36).slice(2)}.txt`)
  await writeFile(file, contents, "utf8")
  return file
}

describe("a wallet whose key is in the vault changes on both sides", () => {
  test("one preview, one unlock, one server call, one vault commit", async () => {
    const fx = await fixture()
    const addr = await teeWallets(fx, ["tr-01", "tr-02"])
    const wallets = [
      serverWallet("w1", addr["tr-01"] as string, "tr-01"),
      serverWallet("w2", addr["tr-02"] as string, "tr-02"),
    ]
    const api = renameApi(wallets)
    const before = await generation(fx)

    const out = await cmd(fx.dir, fx.passphrase, ["tee", "rename", "tr-01", "desk-01"], api.fetch)
    expect(out.code).toBe(0)
    expect(out.prompted).toBe(1)
    expect(out.stdout).toContain("Renamed 1 wallet.\n")
    expect(out.stdout).toContain(`  tr-01 -> desk-01  ${addr["tr-01"]} (server and vault)\n`)

    expect(api.previews).toEqual([{ dryRun: true, renames: [{ wallet: "tr-01", label: "desk-01" }] }])
    // The commit carries the id the preview named, never the handle.
    expect(api.commits).toEqual([{ renames: [{ id: "w1", label: "desk-01" }] }])
    expect(api.auth).toEqual(["Bearer cndl_dvc_x", "Bearer cndl_dvc_x"])
    expect(api.unmatched).toHaveLength(0)
    expect(wallets.map((w) => w.label)).toEqual(["desk-01", "tr-02"])
    expect(await labels(fx)).toEqual(["desk-01", "tr-02"])
    expect(await generation(fx)).toBe(before + 1)
    // Only the label moved: the entry is otherwise what it was.
    const entry = (await entries(fx)).find((candidate) => candidate.label === "desk-01")
    expect(entry?.address).toBe(addr["tr-01"] as string)
    expect(entry?.role).toBe("tee-wallet")
  })

  test("the wallet may be named by id or address, and --json is the receipt", async () => {
    const fx = await fixture()
    const addr = await teeWallets(fx, ["tr-01"])
    const address = addr["tr-01"] as string
    const wallets = [serverWallet("w1", address, "tr-01")]
    const out = await cmd(
      fx.dir,
      fx.passphrase,
      ["tee", "rename", address, "desk 01", "--json"],
      renameApi(wallets).fetch,
    )
    expect(out.code).toBe(0)
    expect(json(out)).toEqual({
      ok: true,
      renamed: [
        { id: "w1", chain: "solana", address, from: "tr-01", to: "desk 01", server: "renamed", vault: "renamed" },
      ],
    })
    expect(wallets[0]?.label).toBe("desk 01")
    expect(await labels(fx)).toEqual(["desk 01"])
  })
})

describe("a wallet with no vault entry changes on the server only", () => {
  test("not a TEE wallet: no unlock, even with a vault on this machine", async () => {
    const fx = await fixture()
    await teeWallets(fx, ["tr-01"])
    const wallets = [serverWallet("w9", "LinkedAddr1111111111111111111111111111111111", "dest-1", false)]
    const api = renameApi(wallets)
    const before = await bytes(fx)
    const out = await cmd(fx.dir, fx.passphrase, ["tee", "rename", "dest-1", "payout", "--json"], api.fetch)
    expect(out.code).toBe(0)
    expect(out.prompted).toBe(0)
    expect((json(out).renamed as Record<string, unknown>[])[0]).toMatchObject({ server: "renamed", vault: "none" })
    expect(wallets[0]?.label).toBe("payout")
    expect(await bytes(fx)).toBe(before)
  })

  test("a TEE wallet and no vault on this machine: no unlock, and no terminal is needed", async () => {
    const dir = await tempDir()
    const wallets = [serverWallet("w1", "TeeAddr11111111111111111111111111111111111111", "tr-01")]
    const api = renameApi(wallets)
    const out = await cmd(dir, "unused", ["tee", "rename", "tr-01", "desk-01"], api.fetch, { tty: false })
    expect(out.code).toBe(0)
    expect(out.prompted).toBe(0)
    expect(out.stdout).toContain("(server)\n")
    expect(wallets[0]?.label).toBe("desk-01")
  })

  test("a TEE wallet this vault does not hold: unlocked once, the vault is not written", async () => {
    const fx = await fixture()
    await teeWallets(fx, ["tr-01"])
    const wallets = [serverWallet("w7", "ElsewhereAddr111111111111111111111111111111", "tr-07")]
    const before = await bytes(fx)
    const out = await cmd(
      fx.dir,
      fx.passphrase,
      ["tee", "rename", "tr-07", "desk-07", "--json"],
      renameApi(wallets).fetch,
    )
    expect(out.code).toBe(0)
    expect(out.prompted).toBe(1)
    expect((json(out).renamed as Record<string, unknown>[])[0]).toMatchObject({ server: "renamed", vault: "none" })
    expect(wallets[0]?.label).toBe("desk-07")
    expect(await bytes(fx)).toBe(before)
  })
})

describe("the vault's name check runs before the server call", () => {
  test("a new name a vault key outside the rename has: refused, no commit, nothing written", async () => {
    const fx = await fixture()
    await vaultKey(fx, "treasury")
    const addr = await teeWallets(fx, ["tr-01"])
    const wallets = [serverWallet("w1", addr["tr-01"] as string, "tr-01")]
    const api = renameApi(wallets)
    const before = await bytes(fx)
    const out = await cmd(fx.dir, fx.passphrase, ["tee", "rename", "tr-01", "treasury", "--json"], api.fetch)
    expect(out.code).toBe(1)
    const body = json(out)
    expect(body.code).toBe("VAULT_LABEL_TAKEN")
    expect(String(body.message)).toContain("New name treasury is taken by a vault key outside this rename.")
    expect(api.previews).toHaveLength(1)
    expect(api.commits).toHaveLength(0)
    expect(wallets[0]?.label).toBe("tr-01")
    expect(await bytes(fx)).toBe(before)
  })

  test("in a file it is a finding on its line, beside the others", async () => {
    const fx = await fixture()
    await vaultKey(fx, "treasury")
    const addr = await teeWallets(fx, ["tr-01", "tr-02"])
    const wallets = [
      serverWallet("w1", addr["tr-01"] as string, "tr-01"),
      serverWallet("w2", addr["tr-02"] as string, "tr-02"),
    ]
    const api = renameApi(wallets)
    const file = await pairsFile(fx, "# names\ntr-01 desk-01\n\ntr-02 treasury\n")
    const out = await cmd(fx.dir, fx.passphrase, ["tee", "rename", "--pairs-from", file, "--json"], api.fetch)
    expect(out.code).toBe(1)
    expect(json(out)).toEqual({
      ok: false,
      code: "TEE_RENAME_BATCH_REFUSED",
      message: "TEE rename refused. Nothing was changed.",
      findings: [{ line: 4, problem: "New name treasury is taken by a vault key outside this rename." }],
    })
    expect(api.commits).toHaveLength(0)
    expect(await labels(fx)).toEqual(["treasury", "tr-01", "tr-02"])
  })
})

describe("the server-then-vault boundary", () => {
  test("a vault write that fails after the server accepted prints address-keyed rows, and they finish it", async () => {
    const fx = await fixture()
    await vaultKey(fx, "other")
    const addr = await teeWallets(fx, ["tr-01", "tr-02"])
    const wallets = [
      serverWallet("w1", addr["tr-01"] as string, "tr-01"),
      serverWallet("w2", addr["tr-02"] as string, "tr-02"),
    ]
    const noRequest = (async () => {
      throw new Error("vault rename makes no request")
    }) as unknown as typeof fetch
    // Another command writes the vault while the server is answering the commit, so this
    // command's `commitVault` finds the file moved: VAULT_CHANGED, after the server accepted.
    const api = renameApi(wallets, {
      onCommit: async () => {
        const other = await cmd(fx.dir, fx.passphrase, ["vault", "rename", "other", "other-2"], noRequest)
        expect(other.code).toBe(0)
      },
    })
    const file = await pairsFile(fx, "tr-01 desk-01\ntr-02 desk-02\n")

    const out = await cmd(fx.dir, fx.passphrase, ["tee", "rename", "--pairs-from", file, "--json"], api.fetch)
    expect(out.code).toBe(1)
    const body = json(out)
    expect(body.ok).toBe(false)
    expect(body.code).toBe("TEE_RENAME_VAULT_INCOMPLETE")
    expect(body.cause).toBe("VAULT_CHANGED")
    // The rows that finish it are keyed by address: the old labels no longer resolve on the server.
    expect(body.rerun).toEqual([
      { from: addr["tr-01"], to: "desk-01" },
      { from: addr["tr-02"], to: "desk-02" },
    ])
    expect(wallets.map((w) => w.label)).toEqual(["desk-01", "desk-02"])
    expect(await labels(fx)).toEqual(["other-2", "tr-01", "tr-02"])

    // The same run without --json prints those rows as a pairs file.
    const text = rerunFile(body.rerun as Array<{ from: string; to: string }>)
    expect(text).toEqual([`${addr["tr-01"]} desk-01`, `${addr["tr-02"]} desk-02`])

    // Re-run with those rows: the old label names nothing on the server, the address does.
    const stale = renameApi(wallets)
    const byOldLabel = await cmd(fx.dir, fx.passphrase, ["tee", "rename", "tr-01", "desk-01", "--json"], stale.fetch)
    expect(byOldLabel.code).toBe(1)
    expect(stale.commits).toHaveLength(0)

    const again = renameApi(wallets)
    const rerun = await pairsFile(fx, `${text.join("\n")}\n`)
    const before = await generation(fx)
    const finished = await cmd(fx.dir, fx.passphrase, ["tee", "rename", "--pairs-from", rerun, "--json"], again.fetch)
    expect(finished.code).toBe(0)
    // The server label already equals the new one: no write is sent, and the label stays.
    expect(again.commits).toHaveLength(0)
    expect(wallets.map((w) => w.label)).toEqual(["desk-01", "desk-02"])
    expect((json(finished).renamed as Record<string, unknown>[]).map((row) => [row.server, row.vault])).toEqual([
      ["unchanged", "renamed"],
      ["unchanged", "renamed"],
    ])
    expect(await labels(fx)).toEqual(["other-2", "desk-01", "desk-02"])
    expect(await generation(fx)).toBe(before + 1)
  })

  test("without --json the failure names the cause and prints the rows and the command", async () => {
    const fx = await fixture()
    await vaultKey(fx, "other")
    const addr = await teeWallets(fx, ["tr-01"])
    const wallets = [serverWallet("w1", addr["tr-01"] as string, "tr-01")]
    const noRequest = (async () => {
      throw new Error("vault rename makes no request")
    }) as unknown as typeof fetch
    const api = renameApi(wallets, {
      onCommit: async () => {
        await cmd(fx.dir, fx.passphrase, ["vault", "rename", "other", "other-2"], noRequest)
      },
    })
    const out = await cmd(fx.dir, fx.passphrase, ["tee", "rename", "tr-01", "desk-01"], api.fetch)
    expect(out.code).toBe(1)
    expect(out.stderr).toContain("The server renamed 1 wallet, but the vault write failed (VAULT_CHANGED:")
    expect(out.stderr).toContain("1 vault entry still has its old name.")
    expect(out.stderr).toContain(`  ${addr["tr-01"]} desk-01\n`)
    expect(out.stderr).toContain("Then run: candle tee rename --pairs-from <file>\n")
    // No receipt: stdout holds only the identity line.
    expect(out.stdout).not.toContain("Renamed")
    expect(out.stdout).not.toContain("desk-01")
  })

  test("a commit with no HTTP answer prints the address-keyed rows and says the server state is unknown", async () => {
    const fx = await fixture()
    const addr = await teeWallets(fx, ["tr-01", "tr-02"])
    const wallets = [
      serverWallet("w1", addr["tr-01"] as string, "tr-01"),
      serverWallet("w2", addr["tr-02"] as string, "tr-02"),
    ]
    const preview = renameApi(wallets)
    let calls = 0
    const dropped = (async (input: string | URL | Request, init?: RequestInit) => {
      calls++
      if (calls === 1) return preview.fetch(input as never, init)
      throw new TypeError("connection dropped")
    }) as typeof globalThis.fetch
    const before = await bytes(fx)

    const text = await cmd(fx.dir, fx.passphrase, ["tee", "rename", "tr-01", "desk-01"], dropped)
    expect(text.code).toBe(1)
    expect(text.stderr).toContain("whether the server applied it is unknown")
    expect(text.stderr).toContain(`  ${addr["tr-01"]} desk-01\n`)
    expect(text.stderr).toContain("Then run: candle tee rename --pairs-from <file>\n")

    calls = 0
    const file = await pairsFile(fx, "tr-01 desk-01\ntr-02 desk-02\n")
    const out = await cmd(fx.dir, fx.passphrase, ["tee", "rename", "--pairs-from", file, "--json"], dropped)
    expect(out.code).toBe(1)
    expect(json(out)).toMatchObject({
      ok: false,
      code: "TEE_RENAME_SERVER_UNKNOWN",
      rerun: [
        { from: addr["tr-01"], to: "desk-01" },
        { from: addr["tr-02"], to: "desk-02" },
      ],
    })
    // The vault was not written, and a re-run by address finishes it either way.
    expect(await bytes(fx)).toBe(before)
    const again = renameApi(wallets)
    const rerun = await pairsFile(fx, `${addr["tr-01"]} desk-01\n${addr["tr-02"]} desk-02\n`)
    const done = await cmd(fx.dir, fx.passphrase, ["tee", "rename", "--pairs-from", rerun, "--json"], again.fetch)
    expect(done.code).toBe(0)
    expect(await labels(fx)).toEqual(["desk-01", "desk-02"])
  })

  test("an older whole-file copy is refused before the server call, unless --accept-older-copy", async () => {
    const fx = await fixture()
    const addr = await teeWallets(fx, ["tr-01"])
    const older = await bytes(fx)
    await vaultKey(fx, "extra")
    await writeFile(fx.path, older, "utf8")
    const wallets = [serverWallet("w1", addr["tr-01"] as string, "tr-01")]

    const api = renameApi(wallets)
    const refused = await cmd(fx.dir, fx.passphrase, ["tee", "rename", "tr-01", "desk-01", "--json"], api.fetch)
    expect(refused.code).toBe(1)
    expect(refused.stdout + refused.stderr).toContain("VAULT_OLDER_COPY")
    expect(api.commits).toHaveLength(0)
    expect(wallets[0]?.label).toBe("tr-01")
    expect(await bytes(fx)).toBe(older)

    const accepted = renameApi(wallets)
    const out = await cmd(
      fx.dir,
      fx.passphrase,
      ["tee", "rename", "tr-01", "desk-01", "--accept-older-copy", "--json"],
      accepted.fetch,
    )
    expect(out.code).toBe(0)
    expect(wallets[0]?.label).toBe("desk-01")
    expect(await labels(fx)).toEqual(["desk-01"])
  })

  test("a server refusal at the commit writes nothing in the vault", async () => {
    const fx = await fixture()
    const addr = await teeWallets(fx, ["tr-01"])
    const wallets = [serverWallet("w1", addr["tr-01"] as string, "tr-01")]
    const preview = renameApi(wallets)
    let calls = 0
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls++
      if (calls === 1) return preview.fetch(input as never, init)
      return jsonResponse(500, {
        success: false,
        error: { code: "SWAP_FAILED", message: "Could not rename right now; nothing changed. Retry.", retryable: true },
      })
    }) as typeof globalThis.fetch
    const before = await bytes(fx)
    const out = await cmd(fx.dir, fx.passphrase, ["tee", "rename", "tr-01", "desk-01", "--json"], fetch)
    expect(out.code).toBe(1)
    expect(json(out)).toMatchObject({ ok: false, code: "SWAP_FAILED", retryable: true })
    expect(await bytes(fx)).toBe(before)
  })

  test("rerunFile: plain lines, or a quoted from,to CSV when a name holds a space, a comma or a quote", () => {
    expect(rerunFile([{ from: "Addr1", to: "desk-01" }])).toEqual(["Addr1 desk-01"])
    expect(
      rerunFile([
        { from: "Addr1", to: "desk 01" },
        { from: "Addr2", to: 'a,"b"' },
      ]),
    ).toEqual(["from,to", 'Addr1,"desk 01"', 'Addr2,"a,""b"""'])
  })
})

describe("the batch form", () => {
  test("a clean file renames every row with one server call and one vault commit; a swap works", async () => {
    const fx = await fixture()
    const addr = await teeWallets(fx, ["tr-01", "tr-02", "tr-03"])
    const wallets = [
      serverWallet("w1", addr["tr-01"] as string, "tr-01"),
      serverWallet("w2", addr["tr-02"] as string, "tr-02"),
      serverWallet("w3", addr["tr-03"] as string, "tr-03"),
      serverWallet("w9", "LinkedAddr1111111111111111111111111111111111", "dest-1", false),
    ]
    const api = renameApi(wallets)
    const before = await generation(fx)
    const file = await pairsFile(fx, 'from,to\ntr-01,tr-02\ntr-02,tr-01\ntr-03,"desk 03"\ndest-1,payout\n')
    const out = await cmd(fx.dir, fx.passphrase, ["tee", "rename", "--pairs-from", file, "--json"], api.fetch)
    expect(out.code).toBe(0)
    expect(out.prompted).toBe(1)
    expect(api.previews).toHaveLength(1)
    expect(api.commits).toEqual([
      {
        renames: [
          { id: "w1", label: "tr-02" },
          { id: "w2", label: "tr-01" },
          { id: "w3", label: "desk 03" },
          { id: "w9", label: "payout" },
        ],
      },
    ])
    expect((json(out).renamed as Record<string, unknown>[]).map((row) => [row.to, row.server, row.vault])).toEqual([
      ["tr-02", "renamed", "renamed"],
      ["tr-01", "renamed", "renamed"],
      ["desk 03", "renamed", "renamed"],
      ["payout", "renamed", "none"],
    ])
    expect(wallets.map((w) => w.label)).toEqual(["tr-02", "tr-01", "desk 03", "payout"])
    expect(await labels(fx)).toEqual(["tr-02", "tr-01", "desk 03"])
    expect(await generation(fx)).toBe(before + 1)
  })

  test("--dry-run unlocks, prints the plan and changes nothing on either side", async () => {
    const fx = await fixture()
    const addr = await teeWallets(fx, ["tr-01"])
    const wallets = [serverWallet("w1", addr["tr-01"] as string, "tr-01")]
    const api = renameApi(wallets)
    const file = await pairsFile(fx, "tr-01 desk-01\n")
    const before = await bytes(fx)
    const out = await cmd(
      fx.dir,
      fx.passphrase,
      ["tee", "rename", "--pairs-from", file, "--dry-run", "--json"],
      api.fetch,
    )
    expect(out.code).toBe(0)
    expect(out.prompted).toBe(1)
    expect(json(out)).toEqual({
      ok: true,
      renamed: [
        {
          id: "w1",
          chain: "solana",
          address: addr["tr-01"],
          from: "tr-01",
          to: "desk-01",
          server: "renamed",
          vault: "renamed",
        },
      ],
      dryRun: true,
    })
    expect(api.commits).toHaveLength(0)
    expect(wallets[0]?.label).toBe("tr-01")
    expect(await bytes(fx)).toBe(before)

    const text = await cmd(fx.dir, fx.passphrase, ["tee", "rename", "--pairs-from", file, "--dry-run"], api.fetch)
    expect(text.stdout).toContain(
      `Dry run: nothing was changed.\n  tr-01 -> desk-01  ${addr["tr-01"]} (server and vault)\n`,
    )
  })

  test("file findings refuse before any request and before the unlock", async () => {
    const fx = await fixture()
    await teeWallets(fx, ["tr-01"])
    const api = renameApi([])
    const file = await pairsFile(
      fx,
      `tr-01 ${"a".repeat(65)}\ntr-02 -dash\ntr-03 same\ntr-04 same\nonly-one-field\nfrom,to\n`,
    )
    const out = await cmd(fx.dir, fx.passphrase, ["tee", "rename", "--pairs-from", file, "--json"], api.fetch)
    expect(out.code).toBe(2)
    expect(out.prompted).toBe(0)
    expect(api.calls).toHaveLength(0)
    const body = json(out)
    expect(body.code).toBe("TEE_RENAME_BATCH_REFUSED")
    const findings = JSON.stringify(body.findings)
    expect(findings).toContain("cannot exceed 64 characters")
    expect(findings).toContain('cannot begin with \\"-\\"')
    expect(findings).toContain("Duplicate to same (line 3).")
    expect(findings).toContain("A row needs")
  })

  test("edge whitespace in a CSV name is refused, not trimmed", async () => {
    const fx = await fixture()
    const api = renameApi([])
    const file = await pairsFile(fx, 'from,to\ntr-01," desk-01"\n')
    const out = await cmd(fx.dir, fx.passphrase, ["tee", "rename", "--pairs-from", file, "--json"], api.fetch)
    expect(out.code).toBe(2)
    expect(JSON.stringify(json(out).findings)).toContain("cannot begin or end with whitespace")
    expect(api.calls).toHaveLength(0)
  })

  test("the server's findings are reported together, each on the line that named it", async () => {
    const fx = await fixture()
    const addr = await teeWallets(fx, ["tr-01"])
    const wallets = [
      serverWallet("w1", addr["tr-01"] as string, "tr-01"),
      serverWallet("w5", "TwinAddr1111111111111111111111111111111111111", "twin"),
      serverWallet("w6", "TwinAddr2222222222222222222222222222222222222", "twin"),
    ]
    const api = renameApi(wallets)
    const file = await pairsFile(fx, "tr-01 desk-01\n\nmissing desk-02\ntwin desk-03\n")
    const out = await cmd(fx.dir, fx.passphrase, ["tee", "rename", "--pairs-from", file, "--json"], api.fetch)
    expect(out.code).toBe(1)
    // Refused by the preview: no unlock, no commit.
    expect(out.prompted).toBe(0)
    expect(api.commits).toHaveLength(0)
    expect(json(out).findings).toEqual([
      { line: 3, problem: "missing does not name an active linked wallet on this account." },
      { line: 4, problem: "twin names more than one wallet; use an id or an address. Candidates: w5, w6." },
    ])
    expect(wallets[0]?.label).toBe("tr-01")
  })

  test("a file that names nothing new changes nothing and sends no write", async () => {
    const fx = await fixture()
    const addr = await teeWallets(fx, ["tr-01"])
    const wallets = [serverWallet("w1", addr["tr-01"] as string, "tr-01")]
    const api = renameApi(wallets)
    const file = await pairsFile(fx, `${addr["tr-01"]} tr-01\n`)
    const before = await bytes(fx)
    const out = await cmd(fx.dir, fx.passphrase, ["tee", "rename", "--pairs-from", file], api.fetch)
    expect(out.code).toBe(0)
    expect(out.stdout).toContain(
      `Nothing to change: every wallet already has its new name.\n  tr-01 -> tr-01  ${addr["tr-01"]} (already named)\n`,
    )
    expect(api.commits).toHaveLength(0)
    expect(await bytes(fx)).toBe(before)
  })
})

describe("refusals before any request", () => {
  test("argument shape is a usage error, exit 2", async () => {
    const dir = await tempDir()
    for (const [argv, line] of [
      [["tee", "rename"], TEE_RENAME_USAGE],
      [["tee", "rename", "tr-01"], TEE_RENAME_USAGE],
      [["tee", "rename", "tr-01", "a", "b"], TEE_RENAME_USAGE],
      [["tee", "rename", "tr-01", "a", "--dry-run"], TEE_RENAME_USAGE],
      [["tee", "rename", "tr-01", "a", "--pairs-from", "f"], TEE_RENAME_USAGE],
      [["tee", "rename", "tr-01", "tr-01"], "The two arguments are the same string; nothing to do."],
      [["tee", "rename", "tr-01", "a".repeat(65)], "A key's label cannot exceed 64 characters."],
      [["tee", "rename", "tr-01", " desk"], "A key's label cannot begin or end with whitespace."],
      [["tee", "rename", "tr-01", "desk "], "A key's label cannot begin or end with whitespace."],
      [["tee", "rename", "tr-01", "de\nsk"], "A key's label cannot contain a newline, a tab or a control character."],
      [["tee", "rename", "tr-01", "   "], "A key's label cannot be empty."],
    ] as const) {
      const api = renameApi([])
      const out = await cmd(dir, "unused", [...argv, "--json"], api.fetch)
      expect([argv, out.code]).toEqual([argv, 2])
      expect(json(out)).toEqual({ ok: false, code: "USAGE", message: line })
      expect(api.calls).toHaveLength(0)
    }
  })

  test("a 64-character name is within the rule", async () => {
    const dir = await tempDir()
    const wallets = [serverWallet("w9", "LinkedAddr1111111111111111111111111111111111", "dest-1", false)]
    const label = "a".repeat(64)
    const out = await cmd(dir, "unused", ["tee", "rename", "dest-1", label], renameApi(wallets).fetch)
    expect(out.code).toBe(0)
    expect(wallets[0]?.label).toBe(label)
  })

  test("an API key alone is refused: the device token is the owner's credential", async () => {
    const dir = await tempDir()
    const api = renameApi([])
    const out = await cmd(
      dir,
      "unused",
      ["tee", "rename", "tr-01", "desk-01", "--json", "--no-verify-account"],
      api.fetch,
      {
        store: { "profile:production:api_key": "cndl_live_x" },
      },
    )
    expect(out.code).toBe(1)
    expect(json(out)).toEqual({
      ok: false,
      code: "DEVICE_TOKEN_REQUIRED",
      message: "Renaming a TEE wallet needs the device token, the owner's credential; an API key cannot do it.",
      suggestion: "Run: candle auth login",
    })
    expect(api.calls).toHaveLength(0)
  })

  test("CANDLE_KEYSTORE_PASSPHRASE set is refused, as on every tee command", async () => {
    const dir = await tempDir()
    const api = renameApi([])
    const out = await cmd(dir, "unused", ["tee", "rename", "tr-01", "desk-01", "--json"], api.fetch, {
      env: { CANDLE_KEYSTORE_PASSPHRASE: "x" },
    })
    expect(out.code).toBe(1)
    expect(json(out).code).toBe("ENV_PASSPHRASE_REFUSED")
    expect(api.calls).toHaveLength(0)
  })
})

describe("refusals after the preview", () => {
  test("no terminal, with a TEE wallet and a vault here: refused before the server is written", async () => {
    const fx = await fixture()
    const addr = await teeWallets(fx, ["tr-01"])
    const wallets = [serverWallet("w1", addr["tr-01"] as string, "tr-01")]
    const api = renameApi(wallets)
    const out = await cmd(fx.dir, fx.passphrase, ["tee", "rename", "tr-01", "desk-01", "--json"], api.fetch, {
      tty: false,
    })
    expect(out.code).toBe(1)
    expect(out.prompted).toBe(0)
    expect(api.commits).toHaveLength(0)
    expect(wallets[0]?.label).toBe("tr-01")
    expect(await labels(fx)).toEqual(["tr-01"])
  })

  test("a wallet that names nothing is the server's refusal, with nothing changed", async () => {
    const dir = await tempDir()
    const api = renameApi([])
    const out = await cmd(dir, "unused", ["tee", "rename", "nope", "desk-01", "--json"], api.fetch)
    expect(out.code).toBe(1)
    expect(json(out)).toMatchObject({
      ok: false,
      code: "TEE_RENAME_REFUSED",
      message: "nope does not name an active linked wallet on this account. Nothing was changed.",
    })
    expect(api.commits).toHaveLength(0)
  })

  test("an API without the route is TEE_RENAME_UNSUPPORTED", async () => {
    const dir = await tempDir()
    const api = renameApi([], { status: 404 })
    const out = await cmd(dir, "unused", ["tee", "rename", "tr-01", "desk-01", "--json"], api.fetch)
    expect(out.code).toBe(1)
    expect(json(out)).toEqual({
      ok: false,
      code: "TEE_RENAME_UNSUPPORTED",
      message: "This Candle API does not support renaming TEE wallets yet; nothing changed.",
    })
  })
})
