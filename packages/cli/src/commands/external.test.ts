/**
 * Ember Phase 3 PR F (BE-226, R6, P3-AD-13): the external branch through `run()`.
 *
 * The vault format half of the BYO matrix: a version 2 vault stays version 2 through every write
 * that does not touch the external branch, and becomes version 3 on exactly the write that
 * allocates the first external key; a restored vault refuses that allocation and nothing else.
 * Then the money half: `vault fund <external>` confirms the last six of the DESTINATION and has no
 * `--yes`; `external sweep <external> --to <vault>` names both ends, infers neither, and confirms
 * the last six of the vault receive key while displaying the source above it.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { base58 } from "@scure/base"
import { Transaction } from "@solana/web3.js"
import { run } from "../index"
import { createCapture, createRoutedFetch, createTestDeps, jsonResponse } from "../test-support"
import { VaultError } from "../vault/errors"
import { branchOfPath, type KeyEntry, parseVaultFile } from "../vault/format"
import { deriveSolanaKey, solanaExternalPath, solanaTeePath, solanaVaultPath } from "../vault/hd"
import { closeVault, commitVault, freshKeyId, sealKeyBlob } from "../vault/store"
import { FIXTURE_ENTROPY, makeVault, reopen, testClock, useCheapKdf } from "../vault/test-vault"
import { restoreSeedHd } from "./vault-restore"

setDefaultTimeout(90_000)
useCheapKdf()

const RPC = "https://rpc.test/rpc"
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"

/** A scripted Solana JSON-RPC: one handler per method; anything unscripted fails loudly. */
function rpcFake(handlers: Record<string, (params: unknown[]) => unknown>) {
  const methods: string[] = []
  const routed = createRoutedFetch({
    "/rpc": async (req) => {
      const { method, params, id } = JSON.parse(String(req.init.body)) as {
        method: string
        params: unknown[]
        id: number
      }
      methods.push(method)
      const handler = handlers[method]
      if (!handler) throw new Error(`unexpected RPC method ${method}`)
      const result = await handler(params)
      // A handler may answer a whole Response (BE-355: an HTTP 429 the client must see as such).
      if (result instanceof Response) return result
      return jsonResponse(200, { id, jsonrpc: "2.0", result })
    },
    "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: "Acct" }),
  })
  return { ...routed, methods }
}

async function harness(opts: { rpc?: ReturnType<typeof rpcFake>; lines?: string[] } = {}) {
  const made = await makeVault()
  closeVault(made.vault)
  const stdout = createCapture()
  const stderr = createCapture()
  const lines = [...(opts.lines ?? [])]
  const asked: string[] = []
  let secretPrompts = 0
  const deps = createTestDeps({
    fetch:
      opts.rpc?.fetch ??
      ((async () => {
        throw new Error("no network call expected")
      }) as unknown as typeof fetch),
    stdout,
    stderr,
    env: { CANDLE_CONFIG_DIR: made.dir },
    promptSecret: async (text) => {
      asked.push(`secret: ${text}`)
      secretPrompts++
      return made.passphrase
    },
    promptLine: async (text) => {
      asked.push(`line: ${text}`)
      const next = lines.shift()
      if (next === undefined) throw new Error(`promptLine asked for more than scripted: ${text}`)
      return next
    },
  })
  const fileVersion = async () => (JSON.parse(await readFile(made.path, "utf8")) as { version: number }).version
  return {
    ...made,
    deps,
    stdout,
    stderr,
    asked,
    lines,
    fileVersion,
    get secretPrompts() {
      return secretPrompts
    },
  }
}

const expectedExternal0 = (await deriveSolanaKey(Uint8Array.from(FIXTURE_ENTROPY), solanaExternalPath(0))).address
const expectedVault0 = (await deriveSolanaKey(Uint8Array.from(FIXTURE_ENTROPY), solanaVaultPath(0))).address
const expectedTee0 = (await deriveSolanaKey(Uint8Array.from(FIXTURE_ENTROPY), solanaTeePath(0))).address

describe("vault format: version 2 stays version 2 until the first external allocation", () => {
  test("open, list, status, backup and a vault-branch allocation leave a version 2 file at version 2", async () => {
    const h = await harness()
    expect(await h.fileVersion()).toBe(2)
    expect(await run(["vault", "new-key", "--chain", "solana", "--label", "cold"], h.deps)).toBe(0)
    expect(await h.fileVersion()).toBe(2)
    expect(await run(["vault", "status", "--unlock"], h.deps)).toBe(0)
    expect(await run(["external", "list"], h.deps)).toBe(0)
    expect(h.stdout.text).toContain("No external wallets")
    // Outside the config directory, which a backup refuses as a destination.
    const copy = join(await mkdtemp(join(tmpdir(), "candle-external-backup-")), "backup.enc")
    h.deps.promptLine = async () => "yes"
    expect(await run(["vault", "backup", "--to", copy], h.deps)).toBe(0)
    expect(await h.fileVersion()).toBe(2)
    expect((JSON.parse(await readFile(copy, "utf8")) as { version: number }).version).toBe(2)
    // In memory the version 2 index reads as the version 3 shape, unallocated on the new branch.
    const opened = await reopen(h.path)
    expect(opened.index.hd.nextIndex).toEqual({ solanaVault: 1, solanaTee: 0, solanaExternal: 0, evm: 0 })
    expect(opened.index.hd.exposedIndexes.solanaExternal).toEqual([])
    closeVault(opened)
  })

  test("external new allocates m/44'/501'/0'/2', writes the file as version 3, and the address is the branch's", async () => {
    const h = await harness()
    expect(await run(["external", "new", "--label", "trader"], h.deps)).toBe(0)
    expect(h.stdout.text).toContain(expectedExternal0)
    expect(h.stdout.text).toContain("m/44'/501'/0'/2'")
    expect(h.stdout.text).toContain("now version 3")
    expect(await h.fileVersion()).toBe(3)
    const opened = await reopen(h.path)
    const entry = opened.index.entries.find((candidate) => candidate.label === "trader") as KeyEntry
    expect(entry.role).toBe("external")
    expect(entry.origin).toBe("derived")
    expect(entry.exposure).toEqual({ everRemoteExposed: false, everExported: false })
    expect(branchOfPath(entry.derivation?.path ?? "")).toEqual({ branch: "solanaExternal", index: 0 })
    expect(opened.index.hd.nextIndex.solanaExternal).toBe(1)
    // The three branches produce three disjoint address sets from one root (CC-11 row 3).
    expect(new Set([expectedVault0, expectedTee0, expectedExternal0]).size).toBe(3)
    closeVault(opened)

    // A second allocation is index 1, and the file stays version 3 for every later write.
    expect(await run(["external", "new", "--json"], h.deps)).toBe(0)
    const line = h.stdout.text.trim().split("\n").at(-1) ?? ""
    expect(JSON.parse(line)).toMatchObject({
      ok: true,
      index: 1,
      path: "m/44'/501'/1'/2'",
      label: "external-1",
      vaultVersion: 3,
    })
    expect(await run(["vault", "new-key", "--chain", "solana"], h.deps)).toBe(0)
    expect(await h.fileVersion()).toBe(3)
  })

  test("the old reader's rule: a version this reader does not know is VAULT_VERSION_UNSUPPORTED and nothing is written", async () => {
    const h = await harness()
    expect(await run(["external", "new"], h.deps)).toBe(0)
    const raw = await readFile(h.path, "utf8")
    // What a 0.10.x / 0.11.x reader does with this file: its check is `version !== 2`, so a 3 is
    // the same refusal this reader gives a 4. Reproduced here on the refusal path itself.
    const asOlderReaderSees = raw.replace('"version": 3', '"version": 4')
    expect(() => parseVaultFile(asOlderReaderSees)).toThrow(VaultError)
    try {
      parseVaultFile(asOlderReaderSees)
    } catch (error) {
      expect((error as VaultError).code).toBe("VAULT_VERSION_UNSUPPORTED")
    }
    expect(await readFile(h.path, "utf8")).toBe(raw)
    expect(JSON.parse(raw).version).toBe(3)
  })

  test("external list shows the external entries only, and never the vault key", async () => {
    const h = await harness()
    expect(await run(["vault", "new-key", "--chain", "solana", "--label", "cold"], h.deps)).toBe(0)
    expect(await run(["external", "new", "--label", "trader"], h.deps)).toBe(0)
    expect(await run(["external", "list", "--json"], h.deps)).toBe(0)
    const line = h.stdout.text.trim().split("\n").at(-1) ?? ""
    const body = JSON.parse(line) as { wallets: Array<{ label: string; address: string }>; vaultVersion: number }
    expect(body.wallets.map((w) => w.label)).toEqual(["trader"])
    expect(body.wallets[0]?.address).toBe(expectedExternal0)
    expect(body.vaultVersion).toBe(3)
  })
})

/** A restored vault (discovery present) holding one recovered external key and one vault key. */
async function restoredWithExternal() {
  const made = await makeVault({
    hd: restoreSeedHd({ requested: { solanaVault: 1, solanaTee: 0, solanaExternal: 1 } }, "2026-09-19T00:00:00.000Z"),
  })
  const entries: KeyEntry[] = []
  const blobs: Awaited<ReturnType<typeof sealKeyBlob>>[] = []
  for (const [role, path, label] of [
    ["vault", solanaVaultPath(0), "cold"],
    ["external", solanaExternalPath(0), "recovered"],
  ] as const) {
    const derived = await deriveSolanaKey(Uint8Array.from(FIXTURE_ENTROPY), path)
    const id = freshKeyId()
    blobs.push(await sealKeyBlob(made.vault, id, derived.secret64))
    entries.push({
      id,
      chain: "solana",
      curve: "ed25519",
      address: derived.address,
      label,
      createdAt: "2026-09-19T00:00:00.000Z",
      role,
      origin: "derived",
      derivation: { scheme: "slip10-ed25519", path },
      exposure: { everRemoteExposed: false, everExported: false, exposureUnknown: true },
    })
  }
  await commitVault(
    made.vault,
    {
      index: {
        hd: {
          ...made.vault.index.hd,
          nextIndex: { ...made.vault.index.hd.nextIndex, solanaVault: 1, solanaExternal: 1 },
        },
        entries,
      },
      addKeys: blobs,
    },
    testClock,
  )
  closeVault(made.vault)
  return made
}

describe("a restored vault does not allocate an external key, and still funds, sweeps and lists it", () => {
  test("external new refuses with VAULT_ALLOCATION_BOUNDARY_UNKNOWN and names CC-11's exit", async () => {
    const made = await restoredWithExternal()
    const stdout = createCapture()
    const deps = createTestDeps({
      fetch: (async () => {
        throw new Error("no network")
      }) as unknown as typeof fetch,
      stdout,
      env: { CANDLE_CONFIG_DIR: made.dir },
      promptSecret: async () => made.passphrase,
    })
    expect(await run(["external", "new", "--json"], deps)).toBe(1)
    const body = JSON.parse(stdout.text.trim())
    expect(body).toMatchObject({ ok: false, code: "VAULT_ALLOCATION_BOUNDARY_UNKNOWN" })
    expect(body.suggestion).toContain("candle vault init")
    expect(body.suggestion).toContain("candle vault transfer")
    // The file is version 3 from the restore seed and unchanged by the refusal.
    expect((JSON.parse(await readFile(made.path, "utf8")) as { version: number }).version).toBe(3)
    stdout.text = ""
    expect(await run(["external", "list", "--json"], deps)).toBe(0)
    expect(JSON.parse(stdout.text.trim()).wallets).toEqual([
      expect.objectContaining({ label: "recovered", address: expectedExternal0, exposureUnknown: true }),
    ])
  })
})

function fundRpc() {
  const sends: string[] = []
  const rpc = rpcFake({
    getLatestBlockhash: () => ({ value: { blockhash: BLOCKHASH } }),
    getFeeForMessage: () => ({ value: 5000 }),
    sendTransaction: (params) => {
      const tx = Transaction.from(Buffer.from(String((params as string[])[0]), "base64"))
      expect(tx.verifySignatures()).toBe(true)
      sends.push(tx.feePayer?.toBase58() ?? "")
      return base58.encode(tx.signature as Buffer)
    },
    getSignatureStatuses: () => ({ value: [{ confirmationStatus: "finalized", err: null }] }),
  })
  return { ...rpc, sends }
}

describe("vault fund <external>: vault-signed, decoded, last six of the DESTINATION, no --yes", () => {
  test("funds from the only vault key, confirming the external address's last six", async () => {
    const rpc = fundRpc()
    const h = await harness({ rpc })
    expect(await run(["vault", "new-key", "--chain", "solana", "--label", "cold"], h.deps)).toBe(0)
    expect(await run(["external", "new", "--label", "trader"], h.deps)).toBe(0)
    h.lines.push(expectedExternal0.slice(-6))
    h.stdout.text = ""
    const prompts = h.secretPrompts
    expect(await run(["vault", "fund", "trader", "--amount", "0.1", "--asset", "SOL", "--rpc-url", RPC], h.deps)).toBe(
      0,
    )
    expect(h.asked.filter((a) => a.startsWith("line:")).at(-1)).toContain(
      `the external wallet destination (${expectedExternal0})`,
    )
    // The factor a second time before signing: the passphrase typed again (no --yes exists).
    expect(h.secretPrompts).toBe(prompts + 2)
    expect(h.stdout.text).toContain(`destination ${expectedExternal0}`)
    expect(h.stdout.text).toContain("fund a session, not a float")
    expect(rpc.sends).toEqual([expectedVault0])
    expect(h.stdout.text).toContain("Funded trader")
  })

  test("--yes is not a flag this command has, and the wrong last six signs nothing", async () => {
    const rpc = fundRpc()
    const h = await harness({ rpc })
    expect(await run(["external", "new", "--label", "trader"], h.deps)).toBe(0)
    expect(await run(["vault", "new-key", "--chain", "solana", "--label", "cold"], h.deps)).toBe(0)
    h.stderr.text = ""
    expect(await run(["vault", "fund", "trader", "--amount", "0.1", "--rpc-url", RPC, "--yes"], h.deps)).toBe(2)
    expect(h.stderr.text).toContain("Unknown flag: --yes")
    h.lines.push(expectedVault0.slice(-6)) // the SOURCE's last six, which is not the destination's
    expect(await run(["vault", "fund", "trader", "--amount", "0.1", "--rpc-url", RPC], h.deps)).toBe(1)
    expect(h.stderr.text).toContain("not the last six characters")
    expect(rpc.sends).toEqual([])
  })

  test("with several vault keys the source is named with --from, never chosen", async () => {
    const rpc = fundRpc()
    const h = await harness({ rpc })
    expect(await run(["vault", "new-key", "--chain", "solana", "--label", "cold"], h.deps)).toBe(0)
    expect(await run(["vault", "new-key", "--chain", "solana", "--label", "warm"], h.deps)).toBe(0)
    expect(await run(["external", "new", "--label", "trader"], h.deps)).toBe(0)
    expect(await run(["vault", "fund", "trader", "--amount", "0.1", "--rpc-url", RPC], h.deps)).toBe(2)
    expect(h.stderr.text).toContain("--from <label>")
    expect(h.stderr.text).toContain("cold, warm")
    h.lines.push(expectedExternal0.slice(-6))
    expect(await run(["vault", "fund", "trader", "--amount", "0.1", "--rpc-url", RPC, "--from", "warm"], h.deps)).toBe(
      0,
    )
    const warm = (await deriveSolanaKey(Uint8Array.from(FIXTURE_ENTROPY), solanaVaultPath(1))).address
    expect(rpc.sends).toEqual([warm])
    // --from is not a TEE flag.
    expect(
      await run(["vault", "fund", expectedTee0, "--amount", "0.1", "--rpc-url", RPC, "--from", "warm"], h.deps),
    ).toBe(1)
  })
})

function sweepRpc(opts: { lamports?: number } = {}) {
  const sends: string[] = []
  const rpc = rpcFake({
    getTokenAccountsByOwner: () => ({ value: [] }),
    getBalance: () => ({ value: opts.lamports ?? 1_000_000 }),
    getLatestBlockhash: () => ({ value: { blockhash: BLOCKHASH } }),
    getFeeForMessage: () => ({ value: 5000 }),
    sendTransaction: (params) => {
      const tx = Transaction.from(Buffer.from(String((params as string[])[0]), "base64"))
      expect(tx.verifySignatures()).toBe(true)
      sends.push(tx.feePayer?.toBase58() ?? "")
      return base58.encode(tx.signature as Buffer)
    },
    getSignatureStatuses: () => ({ value: [{ confirmationStatus: "finalized", err: null }] }),
  })
  return { ...rpc, sends }
}

describe("external sweep <external> --to <vault>: both named, neither inferred, the DESTINATION confirmed", () => {
  test("sweeps SOL to the named vault key, confirming that key's last six and displaying the source above it", async () => {
    const rpc = sweepRpc()
    const h = await harness({ rpc })
    expect(await run(["vault", "new-key", "--chain", "solana", "--label", "cold"], h.deps)).toBe(0)
    expect(await run(["external", "new", "--label", "trader"], h.deps)).toBe(0)
    h.stdout.text = ""
    h.lines.push(expectedVault0.slice(-6))
    expect(await run(["external", "sweep", "trader", "--to", "cold", "--rpc-url", RPC], h.deps)).toBe(0)
    const prompt = h.asked.filter((a) => a.startsWith("line:")).at(-1) ?? ""
    expect(prompt).toContain(`the vault destination (${expectedVault0})`)
    const source = h.stdout.text.indexOf(`source      trader  ${expectedExternal0}`)
    const destination = h.stdout.text.indexOf(`destination cold  ${expectedVault0}`)
    expect(source).toBeGreaterThan(-1)
    expect(destination).toBeGreaterThan(source)
    expect(rpc.sends).toEqual([expectedExternal0])
    expect(h.stdout.text).toContain("moved 995000 lamports (fee 5000)")
    expect(h.stdout.text).toContain("Swept: 1 transaction(s) finalized")
  })

  test("the source's last six is rejected; the destination's is what confirms", async () => {
    const rpc = sweepRpc()
    const h = await harness({ rpc })
    expect(await run(["vault", "new-key", "--chain", "solana", "--label", "cold"], h.deps)).toBe(0)
    expect(await run(["external", "new", "--label", "trader"], h.deps)).toBe(0)
    h.lines.push(expectedExternal0.slice(-6))
    expect(await run(["external", "sweep", "trader", "--to", "cold", "--rpc-url", RPC], h.deps)).toBe(1)
    expect(h.stderr.text).toContain("not the last six characters")
    expect(rpc.sends).toEqual([])
  })

  test("omitting --to refuses even with several receive keys; the roles are not reinterpreted", async () => {
    const rpc = sweepRpc()
    const h = await harness({ rpc })
    expect(await run(["vault", "new-key", "--chain", "solana", "--label", "cold"], h.deps)).toBe(0)
    expect(await run(["vault", "new-key", "--chain", "solana", "--label", "warm"], h.deps)).toBe(0)
    expect(await run(["external", "new", "--label", "trader"], h.deps)).toBe(0)
    expect(await run(["external", "new", "--label", "other"], h.deps)).toBe(0)
    expect(await run(["external", "sweep", "trader", "--rpc-url", RPC], h.deps)).toBe(2)
    expect(h.stderr.text).toContain("--to <vault> is required")
    h.stderr.text = ""
    // A vault key as the source, an external wallet as the destination: each is the wrong role.
    expect(await run(["external", "sweep", "cold", "--to", "warm", "--rpc-url", RPC], h.deps)).toBe(2)
    expect(h.stderr.text).toContain("cold is a vault key, not an external wallet")
    h.stderr.text = ""
    expect(await run(["external", "sweep", "trader", "--to", "other", "--rpc-url", RPC], h.deps)).toBe(2)
    expect(h.stderr.text).toContain("--to other is an external wallet; a sweep goes to a role:vault receive key only")
    expect(rpc.sends).toEqual([])
  })

  test("a recovered external key in a restored vault sweeps and funds (moving funds off it is the right move)", async () => {
    const made = await restoredWithExternal()
    const rpc = sweepRpc()
    const stdout = createCapture()
    const lines = [expectedVault0.slice(-6), expectedExternal0.slice(-6)]
    const deps = createTestDeps({
      fetch: rpc.fetch,
      stdout,
      env: { CANDLE_CONFIG_DIR: made.dir },
      promptSecret: async () => made.passphrase,
      promptLine: async () => lines.shift() ?? "",
    })
    expect(await run(["external", "sweep", "recovered", "--to", "cold", "--rpc-url", RPC, "--json"], deps)).toBe(0)
    expect(JSON.parse(stdout.text.trim().split("\n").at(-1) ?? "")).toMatchObject({
      ok: true,
      source: expectedExternal0,
      destination: expectedVault0,
    })
    stdout.text = ""
    expect(await run(["vault", "fund", "recovered", "--amount", "0.01", "--rpc-url", RPC, "--json"], deps)).toBe(0)
    expect(JSON.parse(stdout.text.trim().split("\n").at(-1) ?? "")).toMatchObject({
      ok: true,
      external: expectedExternal0,
    })
    expect(rpc.sends).toEqual([expectedExternal0, expectedVault0])
  })
})

/**
 * BE-355 (D4, T11): a rate limit on a sweep's send is the existing uncertain leftover, with the
 * signature, exactly one send, and D4's fix line on stderr (pre-profile form here). The client
 * never re-sends.
 */
describe("BE-355 T11: a rate-limited send during external sweep", () => {
  test("exit 3, one send, a finality-uncertain leftover with the signature, and the fix line on stderr", async () => {
    const rpc = rpcFake({
      getTokenAccountsByOwner: () => ({ value: [] }),
      getBalance: () => ({ value: 1_000_000 }),
      getLatestBlockhash: () => ({ value: { blockhash: BLOCKHASH } }),
      getFeeForMessage: () => ({ value: 5000 }),
      sendTransaction: () => new Response("rate limited", { status: 429 }),
    })
    const h = await harness({ rpc })
    expect(await run(["vault", "new-key", "--chain", "solana", "--label", "cold"], h.deps)).toBe(0)
    expect(await run(["external", "new", "--label", "trader"], h.deps)).toBe(0)
    h.stdout.text = ""
    h.stderr.text = ""
    h.lines.push(expectedVault0.slice(-6))
    expect(await run(["external", "sweep", "trader", "--to", "cold", "--rpc-url", RPC, "--json"], h.deps)).toBe(3)
    expect(rpc.methods.filter((m) => m === "sendTransaction")).toHaveLength(1)
    const body = JSON.parse(h.stdout.text.trim())
    expect(body.ok).toBe(false)
    expect(body.leftovers).toHaveLength(1)
    expect(body.leftovers[0]).toMatchObject({ kind: "finality-uncertain" })
    const signature = body.leftovers[0].signature as string
    expect(typeof signature).toBe("string")
    expect(h.stderr.text).toContain(
      `The RPC rate-limited this CLI after the transaction was signed. It may still land: check ${signature} before anything else.\nFix: --rpc-url https://<your-rpc> on this command, or CANDLE_SOLANA_RPC_URL for every command\n     or sign in (candle auth login) to store one per profile\n`,
    )
    expect(h.stderr.text).not.toContain(RPC)
  })
})
