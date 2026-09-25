import { describe, expect, test } from "bun:test"
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID as SPL_TOKEN_2022 } from "@solana/spl-token"
import { Keypair, PublicKey } from "@solana/web3.js"
import type { CommandContext } from "../deps"
import { flagEndpoint, solanaClientFor } from "../solana-endpoint"
import { createSolanaRpc, encodePubkey, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../solana-lite"
import { createCapture, createRoutedFetch, createTestDeps, jsonResponse } from "../test-support"
import type { KeyEntry } from "./format"
import {
  assertTransferSigner,
  assertVaultSigner,
  displayTransferPlan,
  namedSendFailure,
  planTransfer,
  signAndBroadcastTransfer,
  USDC_MINT,
} from "./vault-transfer-sign"

const fromKey = Keypair.generate()
const from = fromKey.publicKey.toBase58()
const to = Keypair.generate().publicKey.toBase58()
const rpcUrl = "https://rpc.test/rpc"
/** The client a command would hand the helpers (BE-355): built with an instant `sleep`. */
const rpcOver = (fetch: typeof globalThis.fetch) => createSolanaRpc(rpcUrl, fetch, async () => {})
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"

// ── Mint fixtures (the same byte layout `token-2022.test.ts` pins against spl-token) ───────────

function baseMint(decimals: number): Uint8Array {
  const data = new Uint8Array(82)
  data[44] = decimals
  data[45] = 1
  return data
}

function extendedMint(decimals: number, extensions: Array<{ type: number; body: Uint8Array }>): Uint8Array {
  const parts = extensions.flatMap(({ type, body }) => {
    const header = new Uint8Array(4)
    const view = new DataView(header.buffer)
    view.setUint16(0, type, true)
    view.setUint16(2, body.length, true)
    return [header, body]
  })
  const data = new Uint8Array(166 + parts.reduce((n, p) => n + p.length, 0))
  data.set(baseMint(decimals), 0)
  data[165] = 1
  let at = 166
  for (const part of parts) {
    data.set(part, at)
    at += part.length
  }
  return data
}

function transferFeeBody(bps: number, max: bigint): Uint8Array {
  const body = new Uint8Array(108)
  const view = new DataView(body.buffer)
  view.setBigUint64(72, 0n, true)
  view.setBigUint64(80, max, true)
  view.setUint16(88, bps, true)
  view.setBigUint64(90, 0n, true)
  view.setBigUint64(98, max, true)
  view.setUint16(106, bps, true)
  return body
}

function hookBody(program: PublicKey): Uint8Array {
  const body = new Uint8Array(64)
  body.set(program.toBytes(), 32)
  return body
}

/** A token account, for the state byte the plan reads at offset 108. */
function tokenAccount(frozen: boolean): Uint8Array {
  const data = new Uint8Array(165)
  data[108] = frozen ? 2 : 1
  return data
}

interface ChainFixture {
  /** address -> account, or absent for "does not exist". */
  accounts: Record<string, { owner: string; data: Uint8Array }>
  epoch?: number
  rent?: number | "unavailable"
}

function rpcRoute(fixture: ChainFixture) {
  return (req: { init: { body?: BodyInit | null } }) => {
    const { method, params } = JSON.parse(String(req.init.body)) as { method: string; params: unknown[] }
    if (method === "getAccountInfo") {
      const account = fixture.accounts[params[0] as string]
      if (!account) return jsonResponse(200, { result: { value: null } })
      return jsonResponse(200, {
        result: {
          value: {
            owner: account.owner,
            lamports: 1,
            data: [Buffer.from(account.data).toString("base64"), "base64"],
          },
        },
      })
    }
    if (method === "getEpochInfo") return jsonResponse(200, { result: { epoch: fixture.epoch ?? 100 } })
    if (method === "getMinimumBalanceForRentExemption") {
      return fixture.rent === "unavailable"
        ? jsonResponse(503, {})
        : jsonResponse(200, { result: fixture.rent ?? 2_123_456 })
    }
    if (method === "getLatestBlockhash") return jsonResponse(200, { result: { value: { blockhash: BLOCKHASH } } })
    throw new Error(`unexpected RPC ${method}`)
  }
}

const usdcKey = new PublicKey(USDC_MINT)

describe("transfer account creation disclosure", () => {
  for (const exists of [false, true]) {
    test(`destination account ${exists ? "exists" : "needs creation"}`, async () => {
      const destinationAta = getAssociatedTokenAddressSync(usdcKey, new PublicKey(to))
      const accounts: ChainFixture["accounts"] = {
        [USDC_MINT]: { owner: TOKEN_PROGRAM_ID, data: baseMint(6) },
      }
      if (exists) accounts[destinationAta.toBase58()] = { owner: TOKEN_PROGRAM_ID, data: tokenAccount(false) }
      const { fetch } = createRoutedFetch({ "/rpc": rpcRoute({ accounts }) })
      const plan = await planTransfer({ from, to, amount: "1", asset: "USDC", rpc: rpcOver(fetch) })
      const stdout = createCapture()
      const ctx: CommandContext = {
        deps: createTestDeps({ fetch, stdout }),
        json: false,
        apiUrl: "",
        verifyAccount: false,
      }
      displayTransferPlan(ctx, plan, 5000n)
      expect(plan.instructions).toHaveLength(exists ? 1 : 2)
      expect(stdout.text).toContain("fee quote  5000 lamports")
      // A classic mint still runs under the classic program, and says so.
      expect(stdout.text).toContain(`program     ${TOKEN_PROGRAM_ID}`)
      expect(stdout.text).not.toContain("Token-2022")
      expect(namedSendFailure(plan)).toBeUndefined()
      if (exists) expect(stdout.text).not.toContain("account rent")
      else {
        expect(stdout.text).toContain("create associated token account")
        expect(stdout.text).toContain(`account owner ${to}`)
        expect(stdout.text).toContain(`account rent 2123456 lamports, paid by ${from} if created`)
      }
    })
  }

  test("an unavailable rent quote refuses before signing", async () => {
    const { fetch } = createRoutedFetch({
      "/rpc": rpcRoute({
        accounts: { [USDC_MINT]: { owner: TOKEN_PROGRAM_ID, data: baseMint(6) } },
        rent: "unavailable",
      }),
    })
    await expect(planTransfer({ from, to, amount: "1", asset: "USDC", rpc: rpcOver(fetch) })).rejects.toThrow(
      "HTTP 503",
    )
  })

  test("an unreadable mint refuses; nothing is planned from a guessed program", async () => {
    const { fetch } = createRoutedFetch({ "/rpc": rpcRoute({ accounts: {} }) })
    await expect(planTransfer({ from, to, amount: "1", asset: "USDC", rpc: rpcOver(fetch) })).rejects.toThrow(
      /does not exist/,
    )
  })
})

// ── Phase 2 ED-10 amendment: the token shape under the mint's own program (BE-218, R5) ─────────

describe("a Token-2022 vault transfer runs under Token-2022 throughout", () => {
  const mintKey = Keypair.generate().publicKey
  const mint = mintKey.toBase58()
  const sourceAta = getAssociatedTokenAddressSync(mintKey, fromKey.publicKey, false, SPL_TOKEN_2022)
  const destinationAta = getAssociatedTokenAddressSync(mintKey, new PublicKey(to), false, SPL_TOKEN_2022)

  function fixtureFor(data: Uint8Array, extra: ChainFixture["accounts"] = {}): ChainFixture {
    return {
      accounts: {
        [mint]: { owner: TOKEN_2022_PROGRAM_ID, data },
        [sourceAta.toBase58()]: { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccount(false) },
        ...extra,
      },
    }
  }

  test("the ATAs, the create and the TransferChecked all use the mint's program", async () => {
    const { fetch } = createRoutedFetch({ "/rpc": rpcRoute(fixtureFor(baseMint(6))) })
    const plan = await planTransfer({ from, to, amount: "2.5", asset: mint, rpc: rpcOver(fetch) })
    expect(plan.instructions).toHaveLength(2)
    const [create, transfer] = plan.instructions
    // Create is the ATA program's, and names the Token-2022 account plus Token-2022 as its program.
    expect(encodePubkey(create?.keys[1]?.pubkey ?? new Uint8Array())).toBe(destinationAta.toBase58())
    expect(encodePubkey(create?.keys[5]?.pubkey ?? new Uint8Array())).toBe(TOKEN_2022_PROGRAM_ID)
    expect(encodePubkey(transfer?.programId ?? new Uint8Array())).toBe(TOKEN_2022_PROGRAM_ID)
    expect(encodePubkey(transfer?.keys[0]?.pubkey ?? new Uint8Array())).toBe(sourceAta.toBase58())
    expect(encodePubkey(transfer?.keys[2]?.pubkey ?? new Uint8Array())).toBe(destinationAta.toBase58())
    expect(plan.amountRaw).toBe(2_500_000n)
    // The classic ATA is a different address; using it would send to an account nothing owns.
    expect(destinationAta.toBase58()).not.toBe(getAssociatedTokenAddressSync(mintKey, new PublicKey(to)).toBase58())
  })

  test("a position NFT (0 decimals, amount 1) transfers as one whole unit", async () => {
    const { fetch } = createRoutedFetch({
      "/rpc": rpcRoute(
        fixtureFor(baseMint(0), {
          [destinationAta.toBase58()]: { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccount(false) },
        }),
      ),
    })
    const plan = await planTransfer({ from, to, amount: "1", asset: mint, rpc: rpcOver(fetch) })
    expect(plan.decimals).toBe(0)
    expect(plan.amountRaw).toBe(1n)
    expect(plan.instructions).toHaveLength(1)
    expect(plan.instructions[0]?.data.at(-1)).toBe(0)
    // A fractional amount of a 0-decimal mint is not a thing.
    await expect(planTransfer({ from, to, amount: "0.5", asset: mint, rpc: rpcOver(fetch) })).rejects.toThrow(
      /at most 0 decimal places/,
    )
  })

  test("a transfer fee is shown as what actually arrives, before the factor prompt", async () => {
    const { fetch } = createRoutedFetch({
      "/rpc": rpcRoute({
        ...fixtureFor(extendedMint(6, [{ type: 1, body: transferFeeBody(150, 1_000_000n) }])),
        epoch: 42,
      }),
    })
    const plan = await planTransfer({ from, to, amount: "100", asset: mint, rpc: rpcOver(fetch) })
    const stdout = createCapture()
    displayTransferPlan(
      { deps: createTestDeps({ fetch, stdout }), json: false, apiUrl: "", verifyAccount: false },
      plan,
      5000n,
    )
    // 100_000_000 raw at 1.5% is 1_500_000, capped at 1_000_000.
    expect(stdout.text).toContain("post-fee    99000000 raw arrives (1000000 raw withheld by the mint at epoch 42)")
    expect(stdout.text).toContain("Transfer fee: 1.5% capped at 1000000 raw units")
    expect(stdout.text).toContain(`program     ${TOKEN_2022_PROGRAM_ID} (Token-2022)`)
  })

  test("a transfer hook's extra accounts are appended to the transfer", async () => {
    const hookProgram = Keypair.generate().publicKey
    const literal = Keypair.generate().publicKey
    const validateState = PublicKey.findProgramAddressSync(
      [Buffer.from("extra-account-metas"), mintKey.toBuffer()],
      hookProgram,
    )[0]
    const validation = new Uint8Array(16 + 35)
    validation.set([105, 37, 101, 197, 75, 251, 102, 26], 0)
    new DataView(validation.buffer).setUint32(8, 39, true)
    new DataView(validation.buffer).setUint32(12, 1, true)
    validation[16] = 0
    validation.set(literal.toBytes(), 17)
    validation[50] = 1
    const { fetch } = createRoutedFetch({
      "/rpc": rpcRoute(
        fixtureFor(extendedMint(6, [{ type: 14, body: hookBody(hookProgram) }]), {
          [validateState.toBase58()]: { owner: hookProgram.toBase58(), data: validation },
          [destinationAta.toBase58()]: { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccount(false) },
        }),
      ),
    })
    const plan = await planTransfer({ from, to, amount: "1", asset: mint, rpc: rpcOver(fetch) })
    const transfer = plan.instructions[0]
    expect(transfer?.keys.slice(4).map((k) => encodePubkey(k.pubkey))).toEqual([
      literal.toBase58(),
      hookProgram.toBase58(),
      validateState.toBase58(),
    ])
    expect(plan.token?.extraAccountsMissing).toBe(false)
    // The tail resolved, so if this send still fails the hook itself is the explanation.
    expect(namedSendFailure(plan)).toBe("TOKEN_2022_HOOK_REFUSED")
    const stdout = createCapture()
    displayTransferPlan(
      { deps: createTestDeps({ fetch, stdout }), json: false, apiUrl: "", verifyAccount: false },
      plan,
      null,
    )
    expect(stdout.text).toContain("3 extra account(s) resolved")
    expect(stdout.text).toContain("runs code on every transfer")
  })

  test("an unresolvable hook tail is disclosed and still sent, never refused (P3-AD-9)", async () => {
    const hookProgram = Keypair.generate().publicKey
    const validateState = PublicKey.findProgramAddressSync(
      [Buffer.from("extra-account-metas"), mintKey.toBuffer()],
      hookProgram,
    )[0]
    // One extra account with an undefined seed type: the tail cannot be built.
    const validation = new Uint8Array(16 + 35)
    validation.set([105, 37, 101, 197, 75, 251, 102, 26], 0)
    new DataView(validation.buffer).setUint32(8, 39, true)
    new DataView(validation.buffer).setUint32(12, 1, true)
    validation[16] = 1
    validation[17] = 9
    const { fetch } = createRoutedFetch({
      "/rpc": rpcRoute(
        fixtureFor(extendedMint(6, [{ type: 14, body: hookBody(hookProgram) }]), {
          [validateState.toBase58()]: { owner: hookProgram.toBase58(), data: validation },
          [destinationAta.toBase58()]: { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccount(false) },
        }),
      ),
    })
    const plan = await planTransfer({ from, to, amount: "1", asset: mint, rpc: rpcOver(fetch) })
    expect(plan.instructions).toHaveLength(1)
    expect(plan.instructions[0]?.keys).toHaveLength(4)
    expect(plan.token?.extraAccountsMissing).toBe(true)
    expect(namedSendFailure(plan)).toBe("TOKEN_2022_EXTRA_ACCOUNTS_MISSING")
    const stdout = createCapture()
    displayTransferPlan(
      { deps: createTestDeps({ fetch, stdout }), json: false, apiUrl: "", verifyAccount: false },
      plan,
      null,
    )
    expect(stdout.text).toContain("extra accounts could NOT be resolved")
  })

  test("non-transferable, frozen, and hooked mints each earn their own name after a failed send", async () => {
    const cases: Array<{
      data: Uint8Array
      extra: ChainFixture["accounts"]
      expected: ReturnType<typeof namedSendFailure>
    }> = [
      {
        data: extendedMint(0, [{ type: 9, body: new Uint8Array(0) }]),
        extra: {},
        expected: "TOKEN_2022_NOT_TRANSFERABLE",
      },
      {
        data: baseMint(6),
        extra: { [destinationAta.toBase58()]: { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccount(true) } },
        expected: "TOKEN_2022_FROZEN",
      },
      // Frozen by default and the destination does not exist yet: it will be created frozen.
      { data: extendedMint(6, [{ type: 6, body: new Uint8Array([2]) }]), extra: {}, expected: "TOKEN_2022_FROZEN" },
    ]
    for (const { data, extra, expected } of cases) {
      const { fetch } = createRoutedFetch({ "/rpc": rpcRoute(fixtureFor(data, extra)) })
      const plan = await planTransfer({ from, to, amount: "1", asset: mint, rpc: rpcOver(fetch) })
      // The move is still built and would still be sent: nothing here is a refusal.
      expect(plan.instructions.length).toBeGreaterThan(0)
      expect(namedSendFailure(plan)).toBe(expected)
    }
  })
})

test("a failed pending write never reaches broadcast", async () => {
  const { fetch, calls } = createRoutedFetch({
    "/rpc": (req) => {
      expect(JSON.parse(String(req.init.body)).method).toBe("getLatestBlockhash")
      return jsonResponse(200, { result: { value: { blockhash: BLOCKHASH } } })
    },
  })
  const plan = await planTransfer({ from, to, amount: "1", asset: "SOL", rpc: rpcOver(fetch) })
  const ctx: CommandContext = { deps: createTestDeps({ fetch }), json: false, apiUrl: "", verifyAccount: false }
  await expect(
    signAndBroadcastTransfer({
      ctx,
      solana: solanaClientFor(ctx, flagEndpoint(rpcUrl)),
      secret64: fromKey.secretKey,
      plan,
      beforeBroadcast: async ({ signature, blockhash }) => {
        expect(signature.length).toBeGreaterThan(0)
        expect(blockhash).toBe(BLOCKHASH)
        throw new Error("disk write refused")
      },
    }),
  ).rejects.toThrow("disk write refused")
  expect(calls).toHaveLength(1)
})

test("a send that finalizes with an error carries R5's name for the mint that refused it", async () => {
  const mintKey = Keypair.generate().publicKey
  const mint = mintKey.toBase58()
  const sourceAta = getAssociatedTokenAddressSync(mintKey, fromKey.publicKey, false, SPL_TOKEN_2022)
  const destinationAta = getAssociatedTokenAddressSync(mintKey, new PublicKey(to), false, SPL_TOKEN_2022)
  const chain = rpcRoute({
    accounts: {
      [mint]: { owner: TOKEN_2022_PROGRAM_ID, data: extendedMint(0, [{ type: 9, body: new Uint8Array(0) }]) },
      [sourceAta.toBase58()]: { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccount(false) },
      [destinationAta.toBase58()]: { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccount(false) },
    },
  })
  const { fetch } = createRoutedFetch({
    "/rpc": (req) => {
      const { method } = JSON.parse(String(req.init.body)) as { method: string }
      if (method === "sendTransaction") return jsonResponse(200, { result: "sig1" })
      if (method === "getSignatureStatuses") {
        return jsonResponse(200, { result: { value: [{ confirmationStatus: "finalized", err: { Custom: 40 } }] } })
      }
      return chain(req)
    },
  })
  const plan = await planTransfer({ from, to, amount: "1", asset: mint, rpc: rpcOver(fetch) })
  const ctx: CommandContext = { deps: createTestDeps({ fetch }), json: false, apiUrl: "", verifyAccount: false }
  await expect(
    signAndBroadcastTransfer({
      ctx,
      solana: solanaClientFor(ctx, flagEndpoint(rpcUrl)),
      secret64: fromKey.secretKey,
      plan,
    }),
  ).rejects.toThrow("Transfer failed on chain (TOKEN_2022_NOT_TRANSFERABLE)")
})

describe("BE-326: which roles may sign which transfer (ED-10 amendment)", () => {
  const entry = (role: KeyEntry["role"]) => ({ role, label: `a-${role}`, address: from }) as KeyEntry

  test("vault transfer admits a vault key and a promoted wallet, and refuses an external wallet", () => {
    expect(() => assertTransferSigner(entry("vault"))).not.toThrow()
    expect(() => assertTransferSigner(entry("tee-wallet"))).not.toThrow()
    expect(() => assertTransferSigner(entry("external"))).toThrow(/external wallet/)
  })

  test("vault fund stays vault-key-only", () => {
    expect(() => assertVaultSigner(entry("vault"))).not.toThrow()
    expect(() => assertVaultSigner(entry("tee-wallet"))).toThrow(/vault fund signs from vault keys only/)
  })
})
