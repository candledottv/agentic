/**
 * Ember Phase 3 PR F (BE-226, R6): `candle sign` and `candle sign message` through `run()`.
 *
 * Every refusal in the BYO matrix, each asserted WITH `--yes` where the matrix says so, because the
 * flag skips the confirmation prompt and nothing else: a vault or TEE signer, an unnamed external
 * signer, a failing or unreachable simulation, an undecodable input (nothing displayed), a v0
 * transaction whose lookup table cannot be fetched (nothing displayed), and the happy path with the
 * display carrying the signing wallet's own deltas and naming every other recipient.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { ed25519 } from "@noble/curves/ed25519"
import { base58 } from "@scure/base"
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js"
import { run } from "../index"
import { ADDRESS_LOOKUP_TABLE_PROGRAM_ID, decodeTransaction } from "../solana-alt"
import { SYSTEM_PROGRAM_ID } from "../solana-lite"
import { createCapture, createRoutedFetch, createTestDeps, jsonResponse } from "../test-support"
import type { KeyEntry } from "../vault/format"
import { deriveSolanaKey, solanaExternalPath, solanaTeePath, solanaVaultPath } from "../vault/hd"
import { closeVault, commitVault, freshKeyId, sealKeyBlob } from "../vault/store"
import { FIXTURE_ENTROPY, makeVault, testClock, useCheapKdf } from "../vault/test-vault"
import { renderableAsText } from "./sign"

setDefaultTimeout(90_000)
useCheapKdf()

const RPC = "https://rpc.test/rpc"
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"
const entropy = () => Uint8Array.from(FIXTURE_ENTROPY)
const external0 = await deriveSolanaKey(entropy(), solanaExternalPath(0))
const external1 = await deriveSolanaKey(entropy(), solanaExternalPath(1))
const vault0 = await deriveSolanaKey(entropy(), solanaVaultPath(0))
const tee0 = await deriveSolanaKey(entropy(), solanaTeePath(0))
const recipient = Keypair.generate().publicKey

interface RawAccount {
  owner: string
  lamports: number
  data: Uint8Array
}

function account(owner: string, lamports: number, data: Uint8Array = new Uint8Array(0)): RawAccount {
  return { owner, lamports, data }
}

function encode(raw: RawAccount | null) {
  return raw === null
    ? null
    : {
        owner: raw.owner,
        lamports: raw.lamports,
        data: [Buffer.from(raw.data).toString("base64"), "base64"],
        executable: false,
        rentEpoch: 0,
      }
}

interface RpcScript {
  pre: Record<string, RawAccount | null>
  /** What the simulation answers for each account; defaults to the pre-state (no change). */
  post?: Record<string, RawAccount | null>
  simulateErr?: unknown
  unreachable?: boolean
  sendFails?: boolean
}

/** The scripted RPC: pre-state, post-state (what the simulation answers), tables, mints. */
function rpcFake(script: RpcScript) {
  const calls: string[] = []
  let sent: string | undefined
  const routed = createRoutedFetch({
    "/rpc": async (req) => {
      if (script.unreachable) throw new Error("connection refused")
      const { method, params, id } = JSON.parse(String(req.init.body)) as {
        method: string
        params: unknown[]
        id: number
      }
      calls.push(method)
      const reply = (result: unknown) => jsonResponse(200, { id, jsonrpc: "2.0", result })
      switch (method) {
        case "getMultipleAccounts":
          return reply({ value: ((params[0] as string[]) ?? []).map((address) => encode(script.pre[address] ?? null)) })
        case "simulateTransaction": {
          const addresses = ((params[1] as { accounts: { addresses: string[] } }).accounts.addresses ?? []) as string[]
          return reply({
            value: {
              err: script.simulateErr ?? null,
              logs: script.simulateErr
                ? ["Program log: refused"]
                : ["Program 11111111111111111111111111111111 success"],
              accounts: addresses.map((address) => encode((script.post ?? script.pre)[address] ?? null)),
              unitsConsumed: 150,
            },
          })
        }
        case "sendTransaction":
          if (script.sendFails) {
            return jsonResponse(200, { id, jsonrpc: "2.0", error: { code: -32002, message: "Blockhash not found" } })
          }
          sent = String(params[0])
          return reply("ok")
        default:
          throw new Error(`unexpected RPC method ${method}`)
      }
    },
  })
  return {
    ...routed,
    calls,
    get sent() {
      return sent
    },
  }
}

/** A vault with external 0 and 1, vault key 0 and a local-candidate TEE entry, all from the fixture root. */
async function vaultWithEveryRole() {
  const made = await makeVault()
  const entries: KeyEntry[] = []
  const blobs: Awaited<ReturnType<typeof sealKeyBlob>>[] = []
  const add = async (role: KeyEntry["role"], derived: typeof external0, label: string) => {
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
      derivation: { scheme: "slip10-ed25519", path: derived.path },
      exposure: { everRemoteExposed: role === "tee-wallet", everExported: false },
      ...(role === "tee-wallet"
        ? { tee: { network: "solana-mainnet" as const, lifecycle: "local-candidate" as const } }
        : {}),
    })
  }
  await add("vault", vault0, "cold")
  await add("tee-wallet", tee0, "agent")
  await add("external", external0, "trader")
  await add("external", external1, "second")
  await commitVault(
    made.vault,
    {
      index: {
        hd: {
          ...made.vault.index.hd,
          nextIndex: { ...made.vault.index.hd.nextIndex, solanaVault: 1, solanaTee: 1, solanaExternal: 2 },
          exposedIndexes: { ...made.vault.index.hd.exposedIndexes, solanaTee: [0] },
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

async function harness(rpc: ReturnType<typeof rpcFake>, input: Uint8Array) {
  const made = await vaultWithEveryRole()
  const stdout = createCapture()
  const stderr = createCapture()
  let secretPrompts = 0
  const deps = createTestDeps({
    fetch: rpc.fetch,
    stdout,
    stderr,
    env: { CANDLE_CONFIG_DIR: made.dir },
    readBytes: async (path) => {
      if (path !== "tx.txt") throw new Error(`unexpected file ${path}`)
      return input
    },
    readStdin: async () => input,
    promptSecret: async () => {
      secretPrompts++
      return made.passphrase
    },
  })
  return {
    made,
    deps,
    stdout,
    stderr,
    get secretPrompts() {
      return secretPrompts
    },
  }
}

function legacyTransfer(from: PublicKey, lamports = 1_000): Uint8Array {
  const tx = new Transaction({ feePayer: from, recentBlockhash: BLOCKHASH }).add(
    SystemProgram.transfer({ fromPubkey: from, toPubkey: recipient, lamports }),
  )
  return new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }))
}

const base64Of = (bytes: Uint8Array) => new TextEncoder().encode(`${Buffer.from(bytes).toString("base64")}\n`)

const systemPre = (lamports: number) => account(SYSTEM_PROGRAM_ID, lamports)

const signArgs = (...extra: string[]) => ["sign", "--file", "tx.txt", "--rpc-url", RPC, ...extra]

describe("candle sign refuses, before any prompt and with --yes", () => {
  test("a vault key as fee payer is SIGN_SIGNER_NOT_EXTERNAL, and --yes changes nothing", async () => {
    for (const yes of [[], ["--yes"]]) {
      const rpc = rpcFake({ pre: {} })
      const h = await harness(rpc, base64Of(legacyTransfer(new PublicKey(vault0.address))))
      expect(await run(signArgs("--wallet", "trader", "--json", ...yes), h.deps)).toBe(1)
      const body = JSON.parse(h.stdout.text.trim())
      expect(body.code).toBe("SIGN_SIGNER_NOT_EXTERNAL")
      expect(body.message).toContain(vault0.address)
      expect(body.message).toContain("a vault key")
      expect(rpc.calls).not.toContain("simulateTransaction")
    }
  })

  test("a TEE wallet as fee payer, and an address this vault does not hold, are each SIGN_SIGNER_NOT_EXTERNAL", async () => {
    const h = await harness(rpcFake({ pre: {} }), base64Of(legacyTransfer(new PublicKey(tee0.address))))
    expect(await run(signArgs("--wallet", "trader", "--json", "--yes"), h.deps)).toBe(1)
    expect(JSON.parse(h.stdout.text.trim())).toMatchObject({
      code: "SIGN_SIGNER_NOT_EXTERNAL",
      message: expect.stringContaining("a TEE wallet"),
    })

    const stranger = await harness(rpcFake({ pre: {} }), base64Of(legacyTransfer(Keypair.generate().publicKey)))
    expect(await run(signArgs("--wallet", "trader", "--json", "--yes"), stranger.deps)).toBe(1)
    expect(JSON.parse(stranger.stdout.text.trim())).toMatchObject({
      code: "SIGN_SIGNER_NOT_EXTERNAL",
      message: expect.stringContaining("not an address this vault holds"),
    })
  })

  test("an external signer the invocation did not name is SIGN_SIGNER_NOT_PROVIDED, never a half-signed transaction", async () => {
    const h = await harness(rpcFake({ pre: {} }), base64Of(legacyTransfer(new PublicKey(external0.address))))
    expect(await run(signArgs("--wallet", "second", "--json", "--yes"), h.deps)).toBe(1)
    const body = JSON.parse(h.stdout.text.trim())
    expect(body.code).toBe("SIGN_SIGNER_NOT_PROVIDED")
    expect(body.suggestion).toContain("--wallet trader")
    expect(body.signedTransaction).toBeUndefined()
  })

  test("--wallet naming a vault key is refused by role, and --wallet is required", async () => {
    const h = await harness(rpcFake({ pre: {} }), base64Of(legacyTransfer(new PublicKey(external0.address))))
    expect(await run(signArgs("--wallet", "cold", "--json", "--yes"), h.deps)).toBe(1)
    expect(JSON.parse(h.stdout.text.trim()).code).toBe("SIGN_SIGNER_NOT_EXTERNAL")
    h.stdout.text = ""
    expect(await run(signArgs("--json"), h.deps)).toBe(2)
  })

  test("a failing simulation is SIGN_SIMULATION_FAILED with the program error and logs, and --yes offers no override", async () => {
    const pre = { [external0.address]: systemPre(1_000_000) }
    for (const yes of [[], ["--yes"]]) {
      const rpc = rpcFake({ pre, simulateErr: { InstructionError: [0, "Custom"] } })
      const h = await harness(rpc, base64Of(legacyTransfer(new PublicKey(external0.address))))
      expect(await run(signArgs("--wallet", "trader", "--json", ...yes), h.deps)).toBe(1)
      const body = JSON.parse(h.stdout.text.trim())
      expect(body.code).toBe("SIGN_SIMULATION_FAILED")
      expect(body.message).toContain("InstructionError")
      expect(body.message).toContain("Program log: refused")
      expect(body.message).toContain("no override")
      expect(rpc.sent).toBeUndefined()
      // The factor was presented once, to open the vault; never a second time for a signature.
      expect(h.secretPrompts).toBe(1)
    }
  })

  test("an unreachable RPC is SIGN_SIMULATION_FAILED too", async () => {
    const h = await harness(
      rpcFake({ pre: {}, unreachable: true }),
      base64Of(legacyTransfer(new PublicKey(external0.address))),
    )
    expect(await run(signArgs("--wallet", "trader", "--json", "--yes"), h.deps)).toBe(1)
    expect(JSON.parse(h.stdout.text.trim())).toMatchObject({ code: "SIGN_SIMULATION_FAILED" })
  })

  test("strict-base64 failure, trailing bytes, a truncated transaction and an unsupported message version are SIGN_TRANSACTION_UNDECODABLE with nothing displayed", async () => {
    const wire = legacyTransfer(new PublicKey(external0.address))
    const versioned = new Uint8Array([...wire.subarray(0, 65), 0x81, ...wire.subarray(65)])
    for (const input of [
      new TextEncoder().encode("not base64 at all!\n"),
      base64Of(new Uint8Array([...wire, 1, 2])),
      base64Of(versioned),
      base64Of(wire.subarray(0, 40)),
    ]) {
      const rpc = rpcFake({ pre: {} })
      const h = await harness(rpc, input)
      expect(await run(signArgs("--wallet", "trader", "--yes"), h.deps)).toBe(1)
      expect(h.stderr.text).toContain("not one base64 legacy or v0 transaction")
      expect(h.stderr.text).not.toContain("Decoded transaction")
      expect(rpc.calls).toEqual([])
      // Nothing was even asked of the vault.
      expect(h.secretPrompts).toBe(0)
    }
  })
})

/** A v0 transaction from the external wallet whose recipient is loaded from a lookup table. */
function v0Fixture() {
  const tableKey = Keypair.generate().publicKey
  const data = new Uint8Array(56 + 32)
  const view = new DataView(data.buffer)
  view.setUint32(0, 1, true)
  view.setBigUint64(4, 0xffffffffffffffffn, true)
  data[21] = 0
  data.set(recipient.toBytes(), 56)
  const table = new AddressLookupTableAccount({ key: tableKey, state: AddressLookupTableAccount.deserialize(data) })
  const from = new PublicKey(external0.address)
  const message = new TransactionMessage({
    payerKey: from,
    recentBlockhash: BLOCKHASH,
    instructions: [
      SystemProgram.transfer({ fromPubkey: from, toPubkey: recipient, lamports: 7_000 }),
      new TransactionInstruction({
        programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
        keys: [],
        data: Buffer.from("hi"),
      }),
    ],
  }).compileToV0Message([table])
  const wire = new VersionedTransaction(message).serialize()
  expect(message.addressTableLookups).toHaveLength(1)
  return { wire, tableKey: tableKey.toBase58(), tableData: data, message }
}

describe("candle sign: v0 with lookup tables, the display, the confirmation and the output", () => {
  test("an unfetchable table is SIGN_LOOKUP_TABLE_UNRESOLVED after decoding, with nothing displayed", async () => {
    const fixture = v0Fixture()
    const rpc = rpcFake({ pre: {} })
    const h = await harness(rpc, base64Of(fixture.wire))
    expect(await run(signArgs("--wallet", "trader", "--yes"), h.deps)).toBe(1)
    expect(h.stderr.text).toContain(`lookup table ${fixture.tableKey} does not exist`)
    expect(h.stderr.text).not.toContain("Decoded transaction")
    expect(rpc.calls).toEqual(["getMultipleAccounts"])
    expect(h.secretPrompts).toBe(0)
  })

  test("with the table fetched the display is built from the compiled order, the deltas come from the simulation, and the signature verifies", async () => {
    const fixture = v0Fixture()
    const pre = {
      [fixture.tableKey]: account(ADDRESS_LOOKUP_TABLE_PROGRAM_ID, 1, fixture.tableData),
      [external0.address]: systemPre(1_000_000),
      [recipient.toBase58()]: null,
    }
    const post = { ...pre, [external0.address]: systemPre(988_000), [recipient.toBase58()]: systemPre(7_000) }
    const rpc = rpcFake({ pre, post })
    const h = await harness(rpc, base64Of(fixture.wire))
    expect(await run(signArgs("--wallet", "trader"), h.deps)).toBe(0)
    const display = h.stderr.text
    expect(display).toContain("v0, 2 instruction(s)")
    expect(display).toContain("(1 lookup table(s) resolved)")
    expect(display).toContain(`fee payer   ${external0.address}`)
    expect(display).toContain("program     System (11111111111111111111111111111111)")
    expect(display).toContain("program     Memo (")
    expect(display).toContain("trader      0.001 SOL -> 0.000988 SOL (-0.000012 SOL)")
    expect(display).toContain(`receives    ${recipient.toBase58()} receives +0.000007 SOL`)
    expect(display).toContain("simulation is evidence, not a guarantee")
    // The prompt: the factor a second time, since --yes was not given.
    expect(h.secretPrompts).toBe(2)
    // stdout is the signed transaction alone, valid for the external key, over the exact message.
    const signed = decodeTransaction(new Uint8Array(Buffer.from(h.stdout.text.trim(), "base64")))
    expect(Array.from(signed.message.bytes)).toEqual(Array.from(fixture.message.serialize()))
    expect(
      ed25519.verify(signed.signatures[0] as Uint8Array, signed.message.bytes, base58.decode(external0.address)),
    ).toBe(true)
    expect(rpc.sent).toBeUndefined()
  })

  test("--yes skips the confirmation prompt and no check; --broadcast sends the signed bytes; a refused send is SIGN_BROADCAST_FAILED", async () => {
    const wire = legacyTransfer(new PublicKey(external0.address))
    const pre = { [external0.address]: systemPre(50_000), [recipient.toBase58()]: null }
    const post = { [external0.address]: systemPre(44_000), [recipient.toBase58()]: systemPre(1_000) }
    const ok = rpcFake({ pre, post })
    const h = await harness(ok, base64Of(wire))
    expect(await run(signArgs("--wallet", "trader", "--yes", "--broadcast", "--json"), h.deps)).toBe(0)
    expect(h.secretPrompts).toBe(1)
    const body = JSON.parse(h.stdout.text.trim())
    expect(body.ok).toBe(true)
    expect(body.broadcast).toMatchObject({ ok: true, signature: body.signature })
    expect(ok.sent).toBe(body.signedTransaction)
    expect(body.display.some((line: string) => line.includes("receives"))).toBe(true)
    expect(ok.calls).toEqual(["getMultipleAccounts", "simulateTransaction", "sendTransaction"])

    const failing = rpcFake({ pre, post, sendFails: true })
    const k = await harness(failing, base64Of(wire))
    expect(await run(signArgs("--wallet", "trader", "--yes", "--broadcast"), k.deps)).toBe(1)
    // The signed transaction is still handed back, so a retry needs no second signature.
    expect(k.stdout.text.trim().length).toBeGreaterThan(80)
    expect(k.stderr.text).toContain("Blockhash not found")
  })

  test("stdin is the same byte stream contract as --file", async () => {
    const wire = legacyTransfer(new PublicKey(external0.address))
    const pre = { [external0.address]: systemPre(50_000), [recipient.toBase58()]: null }
    const h = await harness(rpcFake({ pre }), base64Of(wire))
    expect(await run(["sign", "--wallet", "trader", "--rpc-url", RPC, "--yes", "--json"], h.deps)).toBe(0)
    expect(JSON.parse(h.stdout.text.trim()).ok).toBe(true)
  })
})

describe("candle sign message: exact bytes from a file or stdin, a lossless display", () => {
  async function signBytes(bytes: Uint8Array, args: string[]) {
    const made = await vaultWithEveryRole()
    const stdout = createCapture()
    const stderr = createCapture()
    const deps = createTestDeps({
      fetch: (async () => {
        throw new Error("no network")
      }) as unknown as typeof fetch,
      stdout,
      stderr,
      env: { CANDLE_CONFIG_DIR: made.dir },
      readBytes: async () => bytes,
      readStdin: async () => bytes,
      promptSecret: async () => made.passphrase,
    })
    const code = await run(["sign", "message", ...args], deps)
    return { code, stdout, stderr }
  }

  test("file and stdin sign byte-identical input to the same signature, which verifies over exactly those bytes", async () => {
    const bytes = new TextEncoder().encode("Sign in to example\nnonce 42")
    const viaFile = await signBytes(bytes, ["--wallet", "trader", "--file", "m.txt", "--yes"])
    const viaStdin = await signBytes(bytes, ["--wallet", "trader", "--yes"])
    expect(viaFile.code).toBe(0)
    expect(viaStdin.stdout.text).toBe(viaFile.stdout.text)
    const signature = base58.decode(viaFile.stdout.text.trim())
    expect(ed25519.verify(signature, bytes, base58.decode(external0.address))).toBe(true)
    expect(viaFile.stderr.text).toContain("bytes       27")
    expect(viaFile.stderr.text).toContain("form        UTF-8 text with no control characters other than newline")
    expect(viaFile.stderr.text).toContain("text        Sign in to example\n            nonce 42")
  })

  test("non-UTF-8 bytes, and UTF-8 with a control other than newline, are shown as hex only, with no replacement character", async () => {
    const controlA = new Uint8Array([0x61, 0x01, 0x62]) // "a", U+0001, "b"
    const tabbed = new Uint8Array([0x74, 0x61, 0x62, 0x09, 0x68, 0x65, 0x72, 0x65]) // "tab<TAB>here"
    for (const bytes of [new Uint8Array([0xff, 0xfe, 0x41]), controlA, tabbed]) {
      const out = await signBytes(bytes, ["--wallet", "trader", "--yes", "--json"])
      expect(out.code).toBe(0)
      const body = JSON.parse(out.stdout.text.trim())
      expect(body.renderedAs).toBe("hex")
      expect(body.byteLength).toBe(bytes.length)
      expect(ed25519.verify(base58.decode(body.signature), bytes, base58.decode(external0.address))).toBe(true)
      expect(out.stdout.text + out.stderr.text).not.toContain("�")
    }
    expect(renderableAsText(new TextEncoder().encode("plain\nlines"))).toBe("plain\nlines")
    expect(renderableAsText(new Uint8Array([0xc2, 0x85]))).toBeUndefined() // U+0085, a C1 control
    expect(renderableAsText(new Uint8Array([0x7f]))).toBeUndefined()
  })

  test("a vault key never signs a message; an argv message form does not exist", async () => {
    const bytes = new TextEncoder().encode("hello")
    const refused = await signBytes(bytes, ["--wallet", "cold", "--yes", "--json"])
    expect(refused.code).toBe(1)
    expect(JSON.parse(refused.stdout.text.trim()).code).toBe("SIGN_SIGNER_NOT_EXTERNAL")
    const argv = await signBytes(bytes, ["--wallet", "trader", "hello"])
    expect(argv.code).toBe(2)
    expect(argv.stderr.text).toContain("never an argument")
  })
})
