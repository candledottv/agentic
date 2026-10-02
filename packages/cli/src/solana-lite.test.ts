/**
 * Every byte solana-lite.ts produces is pinned here against `@solana/web3.js` and
 * `@solana/spl-token`, imported from the repo root's hoisted node_modules as an INDEPENDENT
 * oracle (apps/api depends on both; the CLI package does not, and must not, ship them). If the
 * hoisting ever changes, these tests fail to import rather than silently passing.
 */
import { describe, expect, test } from "bun:test"
import {
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID as SPL_TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction as splCreateAta,
} from "@solana/spl-token"
import { Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js"
import {
  associatedTokenAddress,
  compileLegacyMessage,
  createAssociatedTokenAccountIdempotent,
  createContextFloor,
  createSolanaRpc,
  decodePubkey,
  definiteSendRejection,
  encodePubkey,
  findProgramAddress,
  isOnCurve,
  pubkeyFromSecret,
  SolanaRpcError,
  sanitizeSimulation,
  serializeSignedTransaction,
  signMessage,
  systemTransfer,
  TOKEN_2022_PROGRAM_ID,
  toBase64,
  tokenCloseAccount,
  tokenTransferChecked,
  withContextFloor,
} from "./solana-lite"

const payer = Keypair.generate()
const vault = Keypair.generate()
const mint = Keypair.generate().publicKey
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"

function fromWeb3(ix: TransactionInstruction) {
  return {
    programId: ix.programId.toBytes(),
    keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBytes(), isSigner: k.isSigner, isWritable: k.isWritable })),
    data: new Uint8Array(ix.data),
  }
}

describe("pubkeys and PDAs", () => {
  test("decode/encode round trip and length check", () => {
    expect(encodePubkey(decodePubkey(payer.publicKey.toBase58()))).toBe(payer.publicKey.toBase58())
    expect(() => decodePubkey("abc")).toThrow(/32-byte/)
    expect(() => decodePubkey("0OIl")).toThrow(/base58/)
  })

  test("isOnCurve agrees with web3.js for keypairs and for PDAs", () => {
    expect(isOnCurve(payer.publicKey.toBytes())).toBe(true)
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("seed")], SystemProgram.programId)
    expect(isOnCurve(pda.toBytes())).toBe(false)
    expect(PublicKey.isOnCurve(pda.toBytes())).toBe(false)
  })

  test("findProgramAddress matches web3.js's address AND bump", () => {
    const seeds = [payer.publicKey.toBytes(), Buffer.from("x")]
    const [expected, bump] = PublicKey.findProgramAddressSync(seeds, SystemProgram.programId)
    const ours = findProgramAddress(seeds, SystemProgram.programId.toBytes())
    expect(encodePubkey(ours.address)).toBe(expected.toBase58())
    expect(ours.bump).toBe(bump)
  })

  test("the associated token address matches spl-token", () => {
    const expected = getAssociatedTokenAddressSync(mint, vault.publicKey)
    expect(encodePubkey(associatedTokenAddress(vault.publicKey.toBytes(), mint.toBytes()))).toBe(expected.toBase58())
  })
})

describe("instructions match spl-token / web3.js byte for byte", () => {
  test("SystemProgram.transfer", () => {
    const ours = systemTransfer(payer.publicKey.toBytes(), vault.publicKey.toBytes(), 123_456_789n)
    const theirs = fromWeb3(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vault.publicKey, lamports: 123_456_789 }),
    )
    expect(ours).toEqual(theirs)
  })

  test("TransferChecked", () => {
    const source = getAssociatedTokenAddressSync(mint, payer.publicKey)
    const dest = getAssociatedTokenAddressSync(mint, vault.publicKey)
    const ours = tokenTransferChecked({
      source: source.toBytes(),
      mint: mint.toBytes(),
      destination: dest.toBytes(),
      owner: payer.publicKey.toBytes(),
      amount: 5_000_000n,
      decimals: 6,
    })
    const theirs = fromWeb3(createTransferCheckedInstruction(source, mint, dest, payer.publicKey, 5_000_000n, 6))
    expect(ours).toEqual(theirs)
  })

  test("CloseAccount", () => {
    const source = getAssociatedTokenAddressSync(mint, payer.publicKey)
    const ours = tokenCloseAccount({
      account: source.toBytes(),
      destination: payer.publicKey.toBytes(),
      owner: payer.publicKey.toBytes(),
    })
    expect(ours).toEqual(fromWeb3(createCloseAccountInstruction(source, payer.publicKey, payer.publicKey)))
  })

  test("CreateIdempotent associated token account", () => {
    const ata = getAssociatedTokenAddressSync(mint, vault.publicKey)
    const ours = createAssociatedTokenAccountIdempotent({
      payer: payer.publicKey.toBytes(),
      owner: vault.publicKey.toBytes(),
      mint: mint.toBytes(),
    })
    expect(ours).toEqual(fromWeb3(splCreateAta(payer.publicKey, ata, vault.publicKey, mint)))
  })

  // Ember Phase 3 PR A (BE-218, R5): the same three instructions under Token-2022. spl-token takes
  // the program as its last argument, so these pin OUR program plumbing rather than restating the
  // classic tests: a `tokenProgram` that failed to reach the encoder would produce the classic
  // program id and fail here.
  test("Token-2022 TransferChecked, with and without a transfer hook's extra accounts", () => {
    const source = getAssociatedTokenAddressSync(mint, payer.publicKey, false, SPL_TOKEN_2022_PROGRAM_ID)
    const dest = getAssociatedTokenAddressSync(mint, vault.publicKey, false, SPL_TOKEN_2022_PROGRAM_ID)
    const ours = tokenTransferChecked({
      source: source.toBytes(),
      mint: mint.toBytes(),
      destination: dest.toBytes(),
      owner: payer.publicKey.toBytes(),
      amount: 5_000_000n,
      decimals: 6,
      tokenProgram: decodePubkey(TOKEN_2022_PROGRAM_ID),
    })
    const theirs = fromWeb3(
      createTransferCheckedInstruction(
        source,
        mint,
        dest,
        payer.publicKey,
        5_000_000n,
        6,
        [],
        SPL_TOKEN_2022_PROGRAM_ID,
      ),
    )
    expect(ours).toEqual(theirs)
    expect(encodePubkey(ours.programId)).toBe(TOKEN_2022_PROGRAM_ID)

    // The hook tail is appended after the four fixed keys, in order, and changes nothing else.
    const hookProgram = Keypair.generate().publicKey
    const extra = Keypair.generate().publicKey
    const withHook = tokenTransferChecked({
      source: source.toBytes(),
      mint: mint.toBytes(),
      destination: dest.toBytes(),
      owner: payer.publicKey.toBytes(),
      amount: 5_000_000n,
      decimals: 6,
      tokenProgram: decodePubkey(TOKEN_2022_PROGRAM_ID),
      extraAccounts: [
        { pubkey: extra.toBytes(), isSigner: false, isWritable: true },
        { pubkey: hookProgram.toBytes(), isSigner: false, isWritable: false },
      ],
    })
    expect(withHook.data).toEqual(ours.data)
    expect(withHook.keys.slice(0, 4)).toEqual(ours.keys)
    expect(withHook.keys.slice(4).map((k) => encodePubkey(k.pubkey))).toEqual([
      extra.toBase58(),
      hookProgram.toBase58(),
    ])
  })

  test("Token-2022 CloseAccount runs under Token-2022", () => {
    const source = getAssociatedTokenAddressSync(mint, payer.publicKey, false, SPL_TOKEN_2022_PROGRAM_ID)
    const ours = tokenCloseAccount({
      account: source.toBytes(),
      destination: payer.publicKey.toBytes(),
      owner: payer.publicKey.toBytes(),
      tokenProgram: decodePubkey(TOKEN_2022_PROGRAM_ID),
    })
    expect(ours).toEqual(
      fromWeb3(createCloseAccountInstruction(source, payer.publicKey, payer.publicKey, [], SPL_TOKEN_2022_PROGRAM_ID)),
    )
  })

  test("the Token-2022 ATA is a DIFFERENT address, and the program is a seed of it", () => {
    const classic = getAssociatedTokenAddressSync(mint, vault.publicKey)
    const ata = getAssociatedTokenAddressSync(mint, vault.publicKey, false, SPL_TOKEN_2022_PROGRAM_ID)
    expect(ata.toBase58()).not.toBe(classic.toBase58())
    expect(
      encodePubkey(
        associatedTokenAddress(vault.publicKey.toBytes(), mint.toBytes(), decodePubkey(TOKEN_2022_PROGRAM_ID)),
      ),
    ).toBe(ata.toBase58())
    const ours = createAssociatedTokenAccountIdempotent({
      payer: payer.publicKey.toBytes(),
      owner: vault.publicKey.toBytes(),
      mint: mint.toBytes(),
      tokenProgram: decodePubkey(TOKEN_2022_PROGRAM_ID),
    })
    expect(ours).toEqual(fromWeb3(splCreateAta(payer.publicKey, ata, vault.publicKey, mint, SPL_TOKEN_2022_PROGRAM_ID)))
    // The derived account is the Token-2022 one, not the classic one it would otherwise create.
    expect(encodePubkey(ours.keys[1]?.pubkey ?? new Uint8Array())).toBe(ata.toBase58())
  })

  test("P3-ED-6: solana-lite models no program position, no versioned message and no lookup table", async () => {
    // The scope guard for the file itself. `tee sweep`'s DAMM v2 position handling is PR D, and it
    // lands in a sibling; a v0 message or an ALT appearing HERE is the thing this refuses.
    const source = await Bun.file(new URL("./solana-lite.ts", import.meta.url)).text()
    // Identifiers, not prose: the file's own doc comment says the word "non-versioned".
    for (const forbidden of ["MessageV0", "ddressLookupTable", "cp-amm", "compileV0", "@meteora"]) {
      expect(`${forbidden}: ${source.includes(forbidden)}`).toBe(`${forbidden}: false`)
    }
    const exported = await import("./solana-lite")
    expect(Object.keys(exported).filter((k) => /position|damm|lookup/i.test(k))).toEqual([])
  })
})

describe("legacy message compile and signing", () => {
  function web3Tx(ixs: TransactionInstruction[]) {
    const tx = new Transaction({ recentBlockhash: BLOCKHASH, feePayer: payer.publicKey })
    tx.add(...ixs)
    return tx
  }

  test("a SOL transfer message is byte-identical to web3.js's compileMessage", () => {
    const ixs = [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vault.publicKey, lamports: 42 })]
    const theirs = new Uint8Array(web3Tx(ixs).compileMessage().serialize())
    const ours = compileLegacyMessage({
      feePayer: payer.publicKey.toBytes(),
      recentBlockhash: BLOCKHASH,
      instructions: [systemTransfer(payer.publicKey.toBytes(), vault.publicKey.toBytes(), 42n)],
    })
    expect(ours).toEqual(theirs)
  })

  test("a three-instruction token sweep (create ATA, transferChecked, close) is byte-identical", () => {
    const source = getAssociatedTokenAddressSync(mint, payer.publicKey)
    const dest = getAssociatedTokenAddressSync(mint, vault.publicKey)
    const ixs = [
      splCreateAta(payer.publicKey, dest, vault.publicKey, mint),
      createTransferCheckedInstruction(source, mint, dest, payer.publicKey, 777n, 6),
      createCloseAccountInstruction(source, payer.publicKey, payer.publicKey),
    ]
    const theirs = new Uint8Array(web3Tx(ixs).compileMessage().serialize())
    const ours = compileLegacyMessage({
      feePayer: payer.publicKey.toBytes(),
      recentBlockhash: BLOCKHASH,
      instructions: [
        createAssociatedTokenAccountIdempotent({
          payer: payer.publicKey.toBytes(),
          owner: vault.publicKey.toBytes(),
          mint: mint.toBytes(),
        }),
        tokenTransferChecked({
          source: source.toBytes(),
          mint: mint.toBytes(),
          destination: dest.toBytes(),
          owner: payer.publicKey.toBytes(),
          amount: 777n,
          decimals: 6,
        }),
        tokenCloseAccount({
          account: source.toBytes(),
          destination: payer.publicKey.toBytes(),
          owner: payer.publicKey.toBytes(),
        }),
      ],
    })
    expect(ours).toEqual(theirs)
  })

  test("the signature verifies under web3.js and the serialized transaction round-trips", () => {
    const message = compileLegacyMessage({
      feePayer: payer.publicKey.toBytes(),
      recentBlockhash: BLOCKHASH,
      instructions: [systemTransfer(payer.publicKey.toBytes(), vault.publicKey.toBytes(), 42n)],
    })
    const signature = signMessage(message, payer.secretKey)
    const wire = serializeSignedTransaction(message, signature)
    const parsed = Transaction.from(Buffer.from(wire))
    expect(parsed.verifySignatures()).toBe(true)
    expect(parsed.signatures[0]?.publicKey.toBase58()).toBe(payer.publicKey.toBase58())
    expect(toBase64(wire)).toBe(Buffer.from(wire).toString("base64"))
  })

  test("pubkeyFromSecret derives the embedded key and refuses a mismatched pair", () => {
    expect(encodePubkey(pubkeyFromSecret(payer.secretKey))).toBe(payer.publicKey.toBase58())
    const tampered = new Uint8Array(payer.secretKey)
    tampered[40] = (tampered[40] ?? 0) ^ 0xff
    expect(() => pubkeyFromSecret(tampered)).toThrow(/does not match/)
    expect(() => pubkeyFromSecret(payer.secretKey.slice(0, 32))).toThrow(/64-byte/)
  })
})

describe("createSolanaRpc", () => {
  test("posts JSON-RPC and maps the sweep's calls; an RPC error throws without the request body", async () => {
    const seen: Array<{ method: string; params: unknown[] }> = []
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[]; id: number }
      seen.push({ method: body.method, params: body.params })
      const result: Record<string, unknown> = {
        getLatestBlockhash: { value: { blockhash: BLOCKHASH } },
        getBalance: { value: 5000 },
        getFeeForMessage: { value: 5000 },
        getAccountInfo: { value: { owner: "o1", lamports: 9, data: ["AQI=", "base64"] } },
        sendTransaction: "sig111",
        getSignatureStatuses: { value: [{ confirmationStatus: "finalized", err: null }] },
        getTokenAccountsByOwner: {
          value: [
            {
              pubkey: "acct1",
              account: {
                data: {
                  parsed: { info: { mint: "mint1", state: "initialized", tokenAmount: { amount: "7", decimals: 6 } } },
                },
              },
            },
          ],
        },
      }
      if (body.method === "boom") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32002, message: "nope" } }), {
          status: 200,
        })
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: result[body.method] }), { status: 200 })
    }) as typeof fetch
    const rpc = createSolanaRpc("https://rpc.test/", fetchFn, async () => {})
    expect(await rpc.getLatestBlockhash()).toBe(BLOCKHASH)
    expect(await rpc.getBalance("x")).toBe(5000n)
    expect(await rpc.getFeeForMessage("m")).toBe(5000n)
    expect(await rpc.getAccountInfo("x")).toEqual({ owner: "o1", lamports: 9n, data: new Uint8Array([1, 2]) })
    expect(await rpc.sendTransaction("dHg=")).toBe("sig111")
    expect(await rpc.getSignatureStatus("sig111")).toEqual({ confirmationStatus: "finalized", err: null })
    expect(await rpc.getTokenAccountsByOwner("o", "p")).toEqual([
      { pubkey: "acct1", mint: "mint1", amountRaw: "7", decimals: 6, state: "initialized", programId: "p" },
    ])
    expect(seen.map((s) => s.method)).toEqual([
      "getLatestBlockhash",
      "getBalance",
      "getFeeForMessage",
      "getAccountInfo",
      "sendTransaction",
      "getSignatureStatuses",
      "getTokenAccountsByOwner",
    ])
    // sendTransaction carries the signed tx as base64 with the encoding declared.
    expect(seen[4]?.params).toEqual([
      "dHg=",
      { encoding: "base64", skipPreflight: false, preflightCommitment: "finalized", maxRetries: 3 },
    ])
  })
})

/**
 * BE-355 (D3, T7 to T9, T19): a rate-limited read is retried exactly once, after the server's
 * `Retry-After` (capped at 10 s) or 2 s; a second rate-limited answer throws with `rateLimited`;
 * `sendTransaction` and the `getProgramAccounts*` methods are never retried; and `sleep` is a
 * required parameter, so a two-argument client cannot compile.
 */
describe("BE-355 D3: rate limits, one retry, then the named error", () => {
  type Answer = { status: number; body?: unknown; headers?: Record<string, string> }

  /** Answers in order; the last repeats. Records every request's method and every sleep. */
  function scripted(answers: Answer[]) {
    const seen: string[] = []
    const sleeps: number[] = []
    let at = 0
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; id: number }
      seen.push(body.method)
      const answer = answers[Math.min(at++, answers.length - 1)] as Answer
      const payload = answer.status === 200 ? { jsonrpc: "2.0", id: body.id, ...(answer.body as object) } : "limited"
      return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
        status: answer.status,
        headers: answer.headers ?? {},
      })
    }) as typeof fetch
    const rpc = createSolanaRpc("https://rpc.test/", fetchFn, async (ms) => {
      sleeps.push(ms)
    })
    return { rpc, seen, sleeps }
  }
  const limited = (headers?: Record<string, string>): Answer => ({ status: 429, headers })
  const balance = (value: number): Answer => ({ status: 200, body: { result: { value } } })

  test("T7: 429 twice is two requests, one 2 s sleep, and a SolanaRpcError with rateLimited", async () => {
    const s = scripted([limited(), limited()])
    const error = await s.rpc.getBalance("x").catch((e) => e)
    expect(error).toBeInstanceOf(SolanaRpcError)
    expect((error as SolanaRpcError).rateLimited).toBe(true)
    expect((error as SolanaRpcError).status).toBe(429)
    expect(s.seen).toEqual(["getBalance", "getBalance"])
    expect(s.sleeps).toEqual([2000])
  })

  test("T7: Retry-After is honoured, capped at 10 s", async () => {
    const three = scripted([limited({ "retry-after": "3" }), limited()])
    await three.rpc.getBalance("x").catch(() => undefined)
    expect(three.sleeps).toEqual([3000])
    const sixty = scripted([limited({ "retry-after": "60" }), limited()])
    await sixty.rpc.getBalance("x").catch(() => undefined)
    expect(sixty.sleeps).toEqual([10000])
  })

  test("T7: 429 then 200 is the value, after one sleep", async () => {
    const s = scripted([limited(), balance(5000)])
    expect(await s.rpc.getBalance("x")).toBe(5000n)
    expect(s.seen).toEqual(["getBalance", "getBalance"])
    expect(s.sleeps).toEqual([2000])
  })

  test("T8: HTTP 429, RPC -32429, and a 'Too many requests' message are each rateLimited; -32602 is not", async () => {
    const rpcError = (code: number, message: string): Answer => ({ status: 200, body: { error: { code, message } } })
    const shapes: Array<[Answer, boolean]> = [
      [limited(), true],
      [rpcError(-32429, "rate limited"), true],
      [rpcError(-32602, "Too many requests for a specific RPC call"), true],
      [rpcError(-32602, "Invalid params"), false],
    ]
    for (const [answer, expected] of shapes) {
      const s = scripted([answer, answer])
      const error = (await s.rpc.getBalance("x").catch((e) => e)) as SolanaRpcError
      expect(error).toBeInstanceOf(SolanaRpcError)
      expect([answer, error.rateLimited]).toEqual([answer, expected])
      // A rate limit is retried once; anything else is not.
      expect([answer, s.seen.length]).toEqual([answer, expected ? 2 : 1])
    }
  })

  test("T9: sendTransaction and the role-check methods are never retried", async () => {
    const send = scripted([limited()])
    const sendError = (await send.rpc.sendTransaction("dHg=").catch((e) => e)) as SolanaRpcError
    expect(sendError.rateLimited).toBe(true)
    expect(send.seen).toEqual(["sendTransaction"])
    expect(send.sleeps).toEqual([])

    const v2 = scripted([limited()])
    await v2.rpc.getProgramAccountsV2("prog", []).catch(() => undefined)
    expect(v2.seen).toEqual(["getProgramAccountsV2"])
    expect(v2.sleeps).toEqual([])

    const v1 = scripted([limited()])
    await v1.rpc.getProgramAccounts("prog", []).catch(() => undefined)
    expect(v1.seen).toEqual(["getProgramAccounts"])
    expect(v1.sleeps).toEqual([])
  })

  test("T19: sleep is required: a two-argument client is a type error, so every site retries", () => {
    const fetchFn = (() => {
      throw new Error("never called")
    }) as unknown as typeof fetch
    const twoArguments = () =>
      // @ts-expect-error sleep is required (BE-355 D3)
      createSolanaRpc("https://rpc.test/", fetchFn)
    expect(typeof twoArguments).toBe("function")
  })
})

/**
 * BE-658 PR A (spec section 12, L1 to L10): the context floor, the bounded behind / unverified
 * handling, the sanitized simulation facts and the definite-rejection truth table. Every answer is
 * scripted; the URL is `https://synthetic.invalid`, and nothing is signed or sent anywhere.
 */
describe("BE-658: RPC context floor and definite send rejection", () => {
  const URL_ = "https://synthetic.invalid"
  type Request = { id: number; method: string; params: unknown[] }
  /** What one request is answered with: a JSON-RPC member, an HTTP status, a raw body, or a throw. */
  type Reply =
    | { result: unknown }
    | { error: { code: number; message: string; data?: unknown } }
    | { status: number }
    | { raw: string }
    | { id: unknown; error: { code: number; message: string; data?: unknown } }
    | { throws: Error }

  /** Answers in order (the last repeats) and records every request and every sleep. */
  function scripted(replies: Reply[]) {
    const seen: Request[] = []
    const sleeps: number[] = []
    let at = 0
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Request
      seen.push(body)
      const reply = replies[Math.min(at++, replies.length - 1)] as Reply
      if ("throws" in reply) throw reply.throws
      if ("status" in reply) return new Response("unavailable", { status: reply.status })
      if ("raw" in reply) return new Response(reply.raw, { status: 200 })
      const id = "id" in reply ? reply.id : body.id
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...reply }), { status: 200 })
    }) as typeof fetch
    const rpc = createSolanaRpc(URL_, fetchFn, async (ms) => {
      sleeps.push(ms)
    })
    return { rpc, seen, sleeps }
  }
  /** The config object of a request: the last param. */
  const config = (r: Request | undefined) => r?.params[r.params.length - 1] as Record<string, unknown>
  const atSlot = (slot: number, value: unknown) => ({ result: { context: { slot }, value } })
  const behind = (contextSlot?: number): Reply => ({
    error: {
      code: -32016,
      message: "Minimum context slot has not been reached",
      ...(contextSlot === undefined ? {} : { data: { contextSlot } }),
    },
  })
  const SIM_MESSAGE = "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1"
  const SIM_LOGS = [
    "Program 11111111111111111111111111111111 invoke [1]",
    "Transfer: insufficient lamports 834880258, need 836389098",
    "Program 11111111111111111111111111111111 failed: custom program error: 0x1",
  ]
  const SIM_DATA = { err: { InstructionError: [0, { Custom: 1 }] }, logs: SIM_LOGS, unitsConsumed: 150 }
  const preflightFailed = (data: unknown = SIM_DATA): Reply => ({ error: { code: -32002, message: SIM_MESSAGE, data } })
  const thrown = async (p: Promise<unknown>) => (await p.then(() => undefined).catch((e) => e)) as SolanaRpcError

  test("L1: a -32002 with data keeps rpcCode, adds the sanitized simulation, and its message is unchanged", async () => {
    const s = scripted([preflightFailed()])
    const error = await thrown(s.rpc.sendTransaction("dHg="))
    expect(error).toBeInstanceOf(SolanaRpcError)
    // The message is the string every caller quoted before BE-658, byte for byte.
    expect(error.message).toBe(`RPC sendTransaction failed: -32002 ${SIM_MESSAGE}`)
    expect(error.rpcCode).toBe(-32002)
    expect(error.rateLimited).toBe(false)
    expect(error.responseIdMatched).toBe(true)
    expect(error.simulation).toEqual({
      message: SIM_MESSAGE,
      err: '{"InstructionError":[0,{"Custom":1}]}',
      logs: SIM_LOGS,
      logsOmitted: 0,
      unitsConsumed: 150,
    })
    // `data` itself is never held by the error.
    expect(Object.keys(error)).not.toContain("data")
  })

  test("L2: logs are bounded to the last 20 and sanitized; secrets, URLs, controls and other keys are gone", async () => {
    const lines = Array.from({ length: 45 }, (_, i) => `Program log: line ${i}`)
    lines[40] = "x".repeat(1000)
    lines[41] = "fetching https://host/key?api-key=SECRET for the hook"
    lines[42] = "bell\u0007 escape\u001b[31m c1\u0085 end"
    lines[43] = "header token=SECRET2 and Api_Key=SECRET3 and auth=SECRET4"
    const data = {
      err: { InstructionError: [0, { Custom: 1 }] },
      logs: [...lines.slice(0, 44), 7, null, lines[44]],
      unitsConsumed: 1.5,
      accounts: [{ owner: "ACCOUNTSLEAK" }],
      returnData: { data: ["RETURNDATALEAK", "base64"] },
      innerInstructions: [{ index: 0, instructions: ["INNERLEAK"] }],
      replacementBlockhash: { blockhash: "REPLACEMENTLEAK" },
    }
    const s = scripted([
      {
        error: {
          code: -32002,
          message: `Transaction simulation failed via ${URL_}/v1/KEY?api-key=SECRET5 ${"m".repeat(400)}`,
          data,
        },
      },
    ])
    const error = await thrown(s.rpc.sendTransaction("dHg="))
    const sim = error.simulation
    expect(sim).toBeDefined()
    if (!sim) return
    expect(Object.keys(sim).sort()).toEqual(["err", "logs", "logsOmitted", "message"])
    expect(sim.logs).toHaveLength(20)
    expect(sim.logsOmitted).toBe(25)
    expect(sim.logs[0]).toBe("Program log: line 25")
    expect(sim.logs[15]).toBe(`${"x".repeat(240)}…`)
    expect(sim.logs[16]).toBe("fetching <url> for the hook")
    expect(sim.logs[17]).toBe("bell  escape [31m c1  end")
    expect(sim.logs[18]).toBe("header token=<redacted> and Api_Key=<redacted> and auth=<redacted>")
    expect(sim.logs[19]).toBe("Program log: line 44")
    expect(sim.message.startsWith("Transaction simulation failed via <url> ")).toBe(true)
    expect(sim.message.length).toBe(300)
    expect(sim.message.endsWith("…")).toBe(true)
    const serialized = JSON.stringify(sim)
    for (const leak of ["SECRET", "KEY", "synthetic.invalid", "https://", "LEAK", "\u0007", "\u001b", "\u0085"]) {
      expect(`${leak}: ${serialized.includes(leak)}`).toBe(`${leak}: false`)
    }
    // err is capped at 512 chars, and a value JSON cannot encode is named, never thrown.
    const long = sanitizeSimulation("m", { err: "e".repeat(2000) })
    expect(long.err?.length).toBe(512)
    expect(sanitizeSimulation("m", { err: 1n }).err).toBe("unrepresentable")
    expect(sanitizeSimulation("m", { err: null, logs: "not an array" })).toEqual({
      message: "m",
      err: null,
      logs: [],
      logsOmitted: 0,
    })
  })

  test("L3: a floored read answered -32016 is asked three times, sleeping 1 s and 2 s, then contextBehind", async () => {
    const s = scripted([behind(90), behind(95), behind(93)])
    const error = await thrown(s.rpc.getBalance("addr", { minContextSlot: 100 }))
    expect(error).toBeInstanceOf(SolanaRpcError)
    expect(error.contextBehind).toEqual({ required: 100, observed: 95 })
    expect(error.contextUnverified).toBeUndefined()
    expect(s.sleeps).toEqual([1000, 2000])
    expect(s.seen.map((r) => [r.method, config(r).minContextSlot])).toEqual([
      ["getBalance", 100],
      ["getBalance", 100],
      ["getBalance", 100],
    ])
    expect(error.message).not.toContain(URL_)

    // `observed` is undefined when no answer named a slot.
    const blind = scripted([behind()])
    expect((await thrown(blind.rpc.getBalance("addr", { minContextSlot: 100 }))).contextBehind).toEqual({
      required: 100,
      observed: undefined,
    })

    const recovers = scripted([behind(99), atSlot(100, 5000)])
    const seenSlots: number[] = []
    expect(await recovers.rpc.getBalance("addr", { minContextSlot: 100, onContext: (n) => seenSlots.push(n) })).toBe(
      5000n,
    )
    expect(recovers.sleeps).toEqual([1000])
    expect(recovers.seen).toHaveLength(2)
    expect(seenSlots).toEqual([100])
  })

  test("L4: a context below the floor is behind; no context is unverified at once; getEpoch is exempt", async () => {
    const low = scripted([atSlot(80, 1), atSlot(85, 1), atSlot(120, 7)])
    expect(await low.rpc.getBalance("addr", { minContextSlot: 100 })).toBe(7n)
    expect(low.sleeps).toEqual([1000, 2000])

    const stillLow = scripted([atSlot(80, 1)])
    const lowError = await thrown(stillLow.rpc.getLatestBlockhash({ minContextSlot: 100 }))
    expect(lowError.contextBehind).toEqual({ required: 100, observed: 80 })
    expect(stillLow.seen).toHaveLength(3)

    for (const result of [{ value: 1 }, { context: {}, value: 1 }, { context: { slot: "100" }, value: 1 }]) {
      const bare = scripted([{ result }])
      const error = await thrown(bare.rpc.getBalance("addr", { minContextSlot: 100 }))
      expect([result, error.contextUnverified]).toEqual([result, true])
      expect([result, bare.seen.length, bare.sleeps]).toEqual([result, 1, []])
    }

    const epoch = scripted([{ result: { epoch: 812 } }])
    expect(await epoch.rpc.getEpoch({ minContextSlot: 100 })).toBe(812n)
    expect(config(epoch.seen[0]).minContextSlot).toBe(100)
    expect(epoch.seen).toHaveLength(1)
  })

  test("L5: without options every method's params are byte-identical to the baseline's", async () => {
    // Captured from `createSolanaRpc` at staging 87028df5, before BE-658.
    const BASELINE: Array<[string, string]> = [
      ["getLatestBlockhash", '[{"commitment":"finalized"}]'],
      ["getBalance", '["addr",{"commitment":"finalized"}]'],
      ["getTokenAccountsByOwner", '["owner",{"programId":"prog"},{"encoding":"jsonParsed","commitment":"finalized"}]'],
      ["getFeeForMessage", '["bXNn",{"commitment":"finalized"}]'],
      ["getAccountInfo", '["addr",{"encoding":"base64","commitment":"finalized"}]'],
      ["getMultipleAccounts", '[["addr"],{"encoding":"base64","commitment":"finalized"}]'],
      [
        "simulateTransaction",
        '["dHg=",{"sigVerify":false,"replaceRecentBlockhash":true,"commitment":"finalized","encoding":"base64","accounts":{"encoding":"base64","addresses":["addr"]}}]',
      ],
      ["getEpochInfo", '[{"commitment":"finalized"}]'],
      ["isBlockhashValid", '["h",{"commitment":"finalized"}]'],
      ["isBlockhashValid", '["h",{"commitment":"confirmed"}]'],
      [
        "sendTransaction",
        '["dHg=",{"encoding":"base64","skipPreflight":false,"preflightCommitment":"finalized","maxRetries":3}]',
      ],
      ["getSignatureStatuses", '[["sig"],{"searchTransactionHistory":true}]'],
    ]
    const answers: Record<string, unknown> = {
      getLatestBlockhash: { value: { blockhash: "h" } },
      getBalance: { value: 1 },
      getTokenAccountsByOwner: { value: [] },
      getFeeForMessage: { value: 5000 },
      getAccountInfo: { value: null },
      getMultipleAccounts: { value: [null] },
      simulateTransaction: { value: { err: null, logs: [], accounts: null } },
      getEpochInfo: { epoch: 1 },
      isBlockhashValid: { value: true },
      sendTransaction: "sig",
      getSignatureStatuses: { value: [null] },
    }
    async function every(opts?: { minContextSlot?: undefined }) {
      const seen: Request[] = []
      const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Request
        seen.push(body)
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: answers[body.method] }))
      }) as typeof fetch
      const rpc = createSolanaRpc(URL_, fetchFn, async () => {})
      await rpc.getLatestBlockhash(opts)
      await rpc.getBalance("addr", opts)
      await rpc.getTokenAccountsByOwner("owner", "prog", opts)
      await rpc.getFeeForMessage("bXNn", opts)
      await rpc.getAccountInfo("addr", opts)
      await rpc.getMultipleAccounts(["addr"], opts)
      await rpc.simulateTransaction("dHg=", ["addr"], opts)
      await rpc.getEpoch(opts)
      await rpc.isBlockhashValid("h", undefined, opts)
      await rpc.isBlockhashValid("h", "confirmed", opts)
      await rpc.sendTransaction("dHg=", opts)
      await rpc.getSignatureStatus("sig")
      return seen.map((r): [string, string] => [r.method, JSON.stringify(r.params)])
    }
    expect(await every()).toEqual(BASELINE)
    // An options object whose floor is not set yet is the same request.
    expect(await every({ minContextSlot: undefined })).toEqual(BASELINE)
  })

  test("L6: sendTransaction is asked once whatever it answers, floor or not (D4)", async () => {
    for (const reply of [behind(90), preflightFailed(), { status: 429 } as Reply]) {
      const s = scripted([reply, { result: "never" }])
      const error = await thrown(s.rpc.sendTransaction("dHg=", { minContextSlot: 100 }))
      expect(error).toBeInstanceOf(SolanaRpcError)
      expect([reply, s.seen.length, s.sleeps]).toEqual([reply, 1, []])
      expect(config(s.seen[0]).minContextSlot).toBe(100)
    }
    // The floor goes into the preflight config after every existing key.
    const ok = scripted([{ result: "sig" }])
    expect(await ok.rpc.sendTransaction("dHg=", { minContextSlot: 100 })).toBe("sig")
    expect(JSON.stringify(ok.seen[0]?.params)).toBe(
      '["dHg=",{"encoding":"base64","skipPreflight":false,"preflightCommitment":"finalized","maxRetries":3,"minContextSlot":100}]',
    )
  })

  test("L7: definiteSendRejection is non-null only for a validated -32002 or -32016 answer to a send", async () => {
    const uncertain: Array<[string, Reply[]]> = [
      ["HTTP 502", [{ status: 502 }]],
      ["HTTP 429", [{ status: 429 }]],
      ["RPC -32429", [{ error: { code: -32429, message: "rate limited", data: { err: "X" } } }]],
      [
        "Too many requests",
        [{ error: { code: -32002, message: "Too many requests", data: { err: { InstructionError: [0, "X"] } } } }],
      ],
      ["body not JSON", [{ raw: "<html>bad gateway</html>" }]],
      ["id mismatch", [{ id: 999_999, ...(preflightFailed() as { error: { code: number; message: string } }) }]],
      ["id missing", [{ id: null, ...(preflightFailed() as { error: { code: number; message: string } }) }]],
      ["-32002 without data", [{ error: { code: -32002, message: SIM_MESSAGE } }]],
      ["-32002 with err null", [preflightFailed({ err: null, logs: SIM_LOGS })]],
      ["-32002 with data not an object", [preflightFailed("simulation failed")]],
      ["-32016 without contextSlot", [behind()]],
      ["-32005 node unhealthy", [{ error: { code: -32005, message: "Node is unhealthy", data: { err: "X" } } }]],
      ["connection reset", [{ throws: new TypeError("fetch failed: connection reset") }]],
    ]
    for (const [name, replies] of uncertain) {
      const s = scripted(replies)
      const error = await s.rpc.sendTransaction("dHg=").then(
        () => undefined,
        (e) => e,
      )
      expect(`${name}: ${error === undefined ? "resolved" : "threw"}`).toBe(`${name}: threw`)
      expect(`${name}: ${JSON.stringify(definiteSendRejection(error))}`).toBe(`${name}: null`)
    }
    // Not a send: the same answer to a read is never a rejection.
    const read = scripted([preflightFailed()])
    expect(definiteSendRejection(await thrown(read.rpc.getBalance("addr")))).toBeNull()
    expect(definiteSendRejection(new Error("plain"))).toBeNull()
    expect(definiteSendRejection(undefined)).toBeNull()

    const failed = scripted([preflightFailed()])
    expect(definiteSendRejection(await thrown(failed.rpc.sendTransaction("dHg=")))).toEqual({
      reason: "preflight-failed",
      rpcCode: -32002,
      diagnostics: {
        message: SIM_MESSAGE,
        err: '{"InstructionError":[0,{"Custom":1}]}',
        logs: SIM_LOGS,
        logsOmitted: 0,
        unitsConsumed: 150,
      },
    })
    const blockhash = scripted([preflightFailed({ err: "BlockhashNotFound", logs: [] })])
    expect(definiteSendRejection(await thrown(blockhash.rpc.sendTransaction("dHg=")))).toMatchObject({
      reason: "preflight-failed",
      diagnostics: { err: '"BlockhashNotFound"', logs: [], logsOmitted: 0 },
    })
    const stale = scripted([behind(452_457_900)])
    const staleError = await thrown(stale.rpc.sendTransaction("dHg=", { minContextSlot: 452_457_990 }))
    expect(staleError.contextSlot).toBe(452_457_900)
    expect(definiteSendRejection(staleError)).toEqual({
      reason: "context-behind",
      rpcCode: -32016,
      diagnostics: null,
      contextSlot: 452_457_900,
    })
  })

  test("L8: withContextFloor raises only on finalized contexts and never lowers", async () => {
    const answers: Record<string, unknown[]> = {
      getBalance: [{ context: { slot: 100 }, value: 836_394_098 }],
      getLatestBlockhash: [{ context: { slot: 120 }, value: { blockhash: "h" } }],
      isBlockhashValid: [{ context: { slot: 200 }, value: true }],
      getSignatureStatuses: [
        { context: { slot: 300 }, value: [{ confirmationStatus: "processed", err: null, slot: 290 }] },
      ],
      getFeeForMessage: [{ context: { slot: 130 }, value: 5000 }],
      sendTransaction: ["sig"],
    }
    const seen: Request[] = []
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Request
      seen.push(body)
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: answers[body.method]?.[0] }))
    }) as typeof fetch
    const floor = createContextFloor()
    const rpc = withContextFloor(
      createSolanaRpc(URL_, fetchFn, async () => {}),
      floor,
    )

    // No floor yet: the first read goes out as today, and its finalized context sets the floor.
    expect(await rpc.getBalance("wallet")).toBe(836_394_098n)
    expect(config(seen[0]).minContextSlot).toBeUndefined()
    expect(floor.slot).toBe(100)

    expect(await rpc.getLatestBlockhash()).toBe("h")
    expect(config(seen[1]).minContextSlot).toBe(100)
    expect(floor.slot).toBe(120)

    // A confirmed check sends the floor but its (newer, confirmed) context never raises it.
    expect(await rpc.isBlockhashValid("h", "confirmed")).toBe(true)
    expect(config(seen[2])).toEqual({ commitment: "confirmed", minContextSlot: 120 })
    expect(floor.slot).toBe(120)

    // A status read is not floored, and neither its processed context nor its slot raise the floor.
    expect(await rpc.getSignatureStatus("sig")).toEqual({ confirmationStatus: "processed", err: null, slot: 290 })
    expect(seen[3]?.params).toEqual([["sig"], { searchTransactionHistory: true }])
    expect(floor.slot).toBe(120)

    // The send carries the floor as it stands now; a later finalized read raises it again.
    expect(await rpc.getFeeForMessage("bXNn")).toBe(5000n)
    expect(floor.slot).toBe(130)
    expect(await rpc.sendTransaction("dHg=")).toBe("sig")
    expect(config(seen[5]).minContextSlot).toBe(130)

    // Monotonic: lower or invalid values are ignored; a seed starts the floor.
    floor.raise(50)
    floor.raise(Number.NaN)
    floor.raise(-1)
    expect(floor.slot).toBe(130)
    expect(createContextFloor(77).slot).toBe(77)
    expect(createContextFloor().slot).toBeUndefined()

    // A caller's own options still apply: the higher floor wins and its onContext still hears.
    const heard: number[] = []
    expect(await rpc.getFeeForMessage("bXNn", { minContextSlot: 99, onContext: (n) => heard.push(n) })).toBe(5000n)
    expect(config(seen[6]).minContextSlot).toBe(130)
    expect(heard).toEqual([130])
  })

  test("L8b: chunked getMultipleAccounts re-reads the floor for every chunk", async () => {
    const addresses = Array.from({ length: 101 }, (_, i) => `a${i}`)
    const accountsOf = (n: number) => Array.from({ length: n }, () => null)
    const run = async (seed: number | undefined, replies: Array<{ slot: number; n: number } | "behind">) => {
      const seen: Request[] = []
      const sleeps: number[] = []
      let at = 0
      const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Request
        seen.push(body)
        const reply = replies[Math.min(at, replies.length - 1)] as { slot: number; n: number } | "behind"
        at += 1
        if (reply === "behind") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32016, message: "Minimum context slot has not been reached", data: { contextSlot: 150 } },
            }),
          )
        }
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { context: { slot: reply.slot }, value: accountsOf(reply.n) },
          }),
        )
      }) as typeof fetch
      const floor = createContextFloor(seed)
      const rpc = withContextFloor(
        createSolanaRpc(URL_, fetchFn, async (ms) => void sleeps.push(ms)),
        floor,
      )
      return { rpc, floor, seen, sleeps }
    }
    const sent = (seen: Request[]) => seen.map((r) => config(r).minContextSlot)

    // Seeded floor: chunk 1's finalized 200 raises the floor chunk 2 sends.
    const seeded = await run(100, [
      { slot: 200, n: 100 },
      { slot: 210, n: 1 },
    ])
    expect(await seeded.rpc.getMultipleAccounts(addresses)).toHaveLength(101)
    expect(sent(seeded.seen)).toEqual([100, 200])
    expect(seeded.floor.slot).toBe(210)
    expect(seeded.seen.map((r) => (r.params as unknown[][])[0]?.length)).toEqual([100, 1])

    // Unset floor: chunk 1 goes out as today, chunk 2 is floored by chunk 1's context.
    const unset = await run(undefined, [
      { slot: 200, n: 100 },
      { slot: 200, n: 1 },
    ])
    expect(await unset.rpc.getMultipleAccounts(addresses)).toHaveLength(101)
    expect(sent(unset.seen)).toEqual([undefined, 200])

    // A stale second chunk (150 < 200) is behind: it is asked again and recovers.
    const recovers = await run(100, [
      { slot: 200, n: 100 },
      { slot: 150, n: 1 },
      { slot: 205, n: 1 },
    ])
    expect(await recovers.rpc.getMultipleAccounts(addresses)).toHaveLength(101)
    expect(sent(recovers.seen)).toEqual([100, 200, 200])
    expect(recovers.sleeps).toEqual([1000])

    // ...or exhausts after three attempts with contextBehind against the refreshed floor.
    const exhausts = await run(100, [{ slot: 200, n: 100 }, "behind"])
    const error = await thrown(exhausts.rpc.getMultipleAccounts(addresses))
    expect(error.contextBehind).toEqual({ required: 200, observed: 150 })
    expect(sent(exhausts.seen)).toEqual([100, 200, 200, 200])
    expect(exhausts.sleeps).toEqual([1000, 2000])

    // A caller's own higher floor and callback still apply to every chunk.
    const heard: number[] = []
    const own = await run(100, [
      { slot: 300, n: 100 },
      { slot: 300, n: 1 },
    ])
    await own.rpc.getMultipleAccounts(addresses, { minContextSlot: 250, onContext: (n) => heard.push(n) })
    expect(sent(own.seen)).toEqual([250, 300])
    expect(heard).toEqual([300, 300])
  })

  test("L9: getSignatureStatus returns the status's slot when the RPC sends one", async () => {
    const withSlot = scripted([
      {
        result: {
          context: { slot: 452_458_700 },
          value: [{ confirmationStatus: "finalized", err: null, slot: 452_458_642 }],
        },
      },
    ])
    expect(await withSlot.rpc.getSignatureStatus("sig")).toEqual({
      confirmationStatus: "finalized",
      err: null,
      slot: 452_458_642,
    })
    const malformed = scripted([{ result: { value: [{ confirmationStatus: "finalized", err: null, slot: "42" }] } }])
    const status = await malformed.rpc.getSignatureStatus("sig")
    expect(status).toEqual({ confirmationStatus: "finalized", err: null })
    expect(status !== null && "slot" in status).toBe(false)
    expect(await scripted([{ result: { value: [null] } }]).rpc.getSignatureStatus("sig")).toBeNull()
  })

  test("L10: D3 is unchanged: one retry for a read (floored or not), none for a send; -32002 is no rate limit", async () => {
    const read = scripted([{ status: 429 }, atSlot(100, 5)])
    expect(await read.rpc.getBalance("addr", { minContextSlot: 100 })).toBe(5n)
    expect(read.seen).toHaveLength(2)
    expect(read.sleeps).toEqual([2000])

    const twice = scripted([{ status: 429 }])
    expect((await thrown(twice.rpc.getBalance("addr", { minContextSlot: 100 }))).rateLimited).toBe(true)
    expect(twice.seen).toHaveLength(2)

    const send = scripted([{ status: 429 }])
    expect((await thrown(send.rpc.sendTransaction("dHg=", { minContextSlot: 100 }))).rateLimited).toBe(true)
    expect(send.seen).toHaveLength(1)
    expect(send.sleeps).toEqual([])

    const preflight = scripted([preflightFailed()])
    expect((await thrown(preflight.rpc.getBalance("addr"))).rateLimited).toBe(false)
    expect(preflight.seen).toHaveLength(1)
    expect(preflight.sleeps).toEqual([])
  })
})
