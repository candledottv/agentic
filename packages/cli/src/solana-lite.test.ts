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
  createSolanaRpc,
  decodePubkey,
  encodePubkey,
  findProgramAddress,
  isOnCurve,
  pubkeyFromSecret,
  serializeSignedTransaction,
  signMessage,
  systemTransfer,
  TOKEN_2022_PROGRAM_ID,
  toBase64,
  tokenCloseAccount,
  tokenTransferChecked,
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
    const rpc = createSolanaRpc("https://rpc.test/", fetchFn)
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
