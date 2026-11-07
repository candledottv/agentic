/**
 * BE-355 (spec `docs/superpowers/specs/2026-09-24-cli-default-solana-rpc-design.md`, T10 to T12):
 * `candle vault transfer` from a Solana vault key when the RPC rate-limits.
 *
 * Before any signature (the blockhash read), a rate limit that survives the client's one retry is
 * `RPC_RATE_LIMITED`, exit 1, and nothing is sent. After the signature (the send, or a status read
 * after it), the outcome is the existing uncertain one: exit 3 with the local signature, exactly
 * one send, and D4's fix line on stderr. Each case runs with an acting profile `work` and in
 * pre-profile mode, because the fix text differs (D2).
 */
import { describe, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { ExtensionType, getAccountLen, getAssociatedTokenAddressSync } from "@solana/spl-token"
import { PublicKey, SystemInstruction, Transaction } from "@solana/web3.js"
import { run } from "../index"
import { publicRpcNoticeLines, rpcFixLines } from "../solana-endpoint"
import * as solanaLite from "../solana-lite"
import { createCapture, createFakeConfigStore, createRoutedFetch, createTestDeps, jsonResponse } from "../test-support"
import { closeVault } from "../vault/store"
import { makeVault, useCheapKdf } from "../vault/test-vault"

setDefaultTimeout(60_000)
useCheapKdf()

const RPC = "https://rpc.test/rpc"
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"
const DESTINATION = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const rentForSize = (size: number) => (size + 128) * 6960
const PRE_PROFILE_FIX = [
  "--rpc-url https://<your-rpc> on this command, or CANDLE_SOLANA_RPC_URL for every command",
  "or sign in (candle auth login) to store one per profile",
]

function lastJson(text: string): Record<string, unknown> {
  return JSON.parse(text.trimEnd().split("\n").at(-1) ?? "")
}

async function fixture(
  opts: {
    rateLimit?: Record<string, number>
    profile?: boolean
    balance?: number
    amount?: string
    fee?: number | null
    fees?: number[]
    sourceOwner?: string
    sourceData?: Uint8Array
    status?: "finalized" | "never"
    token?: { program: string; mintData: Uint8Array }
  } = {},
) {
  const made = await makeVault()
  closeVault(made.vault)
  const stdout = createCapture()
  const stderr = createCapture()
  const methods: string[] = []
  const wires: string[] = []
  const quotes: string[] = []
  const chain = { balance: opts.balance ?? 10_000_000_000, fee: opts.fee === undefined ? 5000 : opts.fee }
  const limited = new Map<string, number>()
  const rentSizes: number[] = []
  let from = ""
  const { fetch } = createRoutedFetch({
    "/rpc": async (req) => {
      const { method, params, id } = JSON.parse(String(req.init.body))
      methods.push(method)
      const remaining = opts.rateLimit?.[method] ?? 0
      const seen = limited.get(method) ?? 0
      if (seen < remaining) {
        limited.set(method, seen + 1)
        return new Response("rate limited", { status: 429 })
      }
      const reply = (result: unknown) => jsonResponse(200, { id, jsonrpc: "2.0", result })
      switch (method) {
        case "getLatestBlockhash":
          return reply({ value: { blockhash: BLOCKHASH } })
        case "getFeeForMessage":
          quotes.push(params[0])
          return reply({ value: opts.fees?.[quotes.length - 1] ?? chain.fee })
        case "getBalance":
          return reply({ value: chain.balance })
        case "getAccountInfo": {
          const token = opts.token
          if (!token)
            return reply({
              value: {
                owner: opts.sourceOwner ?? solanaLite.SYSTEM_PROGRAM_ID,
                lamports: chain.balance,
                data: [Buffer.from(opts.sourceData ?? []).toString("base64"), "base64"],
              },
            })
          const source = getAssociatedTokenAddressSync(
            new PublicKey(MINT),
            new PublicKey(from),
            false,
            new PublicKey(token.program),
          ).toBase58()
          const data = new Uint8Array(165)
          data[108] = 1
          new DataView(data.buffer).setBigUint64(64, 2_000_000n, true)
          const bytes = params[0] === MINT ? token.mintData : params[0] === source ? data : null
          return reply({
            value:
              bytes === null
                ? null
                : {
                    owner: token.program,
                    lamports: 1,
                    data: [Buffer.from(bytes).toString("base64"), "base64"],
                  },
          })
        }
        case "getMinimumBalanceForRentExemption":
          rentSizes.push(params[0])
          return reply(rentForSize(params[0]))
        case "getEpochInfo":
          return reply({ epoch: 100 })
        case "sendTransaction":
          wires.push(params[0])
          return reply(String(params[0]).slice(0, 8))
        case "getSignatureStatuses":
          return reply({ value: [opts.status === "never" ? null : { confirmationStatus: "finalized", err: null }] })
        default:
          throw new Error(`unexpected RPC method ${method}`)
      }
    },
  })
  const deps = createTestDeps({
    fetch,
    stdout,
    stderr,
    env: { CANDLE_CONFIG_DIR: made.dir, HOME: made.dir, CANDLE_SOLANA_RPC_URL: RPC },
    promptSecret: async () => made.passphrase,
    promptLine: async () => "confirm",
    ...(opts.profile ? createFakeConfigStore({ profiles: { work: {} }, activeProfile: "work" }) : {}),
  })
  expect(await run(["vault", "new-key", "--chain", "solana", "--label", "cold", "--json"], deps)).toBe(0)
  from = String(lastJson(stdout.text).address)
  stdout.text = ""
  stderr.text = ""
  methods.length = 0
  const transfer = () =>
    run(
      [
        "vault",
        "transfer",
        DESTINATION,
        "--from",
        "cold",
        "--amount",
        opts.amount ?? (opts.token ? "1" : "0.1"),
        "--asset",
        opts.token ? MINT : "SOL",
        "--json",
      ],
      deps,
    )
  return { deps, stdout, stderr, methods, rentSizes, transfer, chain, wires, quotes }
}

/** Mint TLV fixtures; SPL's account sizing is the independent oracle, never the code under test. */
function tokenMint(extensions: Array<{ type: ExtensionType; body: Uint8Array }>): Uint8Array {
  const data = new Uint8Array(extensions.length ? 166 + extensions.reduce((n, e) => n + 4 + e.body.length, 0) : 82)
  data[44] = 6
  data[45] = 1
  if (extensions.length) data[165] = 1
  let at = 166
  for (const { type, body } of extensions) {
    const view = new DataView(data.buffer)
    view.setUint16(at, type, true)
    view.setUint16(at + 2, body.length, true)
    data.set(body, at + 4)
    at += 4 + body.length
  }
  return data
}

describe("BE-2596: SOL max", () => {
  function sentLamports(f: Awaited<ReturnType<typeof fixture>>): bigint {
    const tx = Transaction.from(Buffer.from(f.wires[0] ?? "", "base64"))
    expect(tx.verifySignatures()).toBe(true)
    expect(tx.serializeMessage().toString("base64")).toBe(f.quotes.at(-1) ?? "")
    const instruction = tx.instructions[0]
    if (!instruction) throw new Error("missing transfer instruction")
    const transfer = SystemInstruction.decodeTransfer(instruction)
    expect(transfer.toPubkey.toBase58()).toBe(DESTINATION)
    return BigInt(transfer.lamports)
  }

  test("sends balance minus the exact quoted fee, empties the system wallet with zero rent reserve, and signs that message once", async () => {
    const f = await fixture({ amount: "max", balance: 1_000_000_000, fee: 12_345 })
    expect(await f.transfer()).toBe(0)
    expect(sentLamports(f)).toBe(999_987_655n)
    expect(f.wires).toHaveLength(1)
    expect(lastJson(f.stdout.text)).toMatchObject({ amount: "0.999987655", amountRaw: "999987655" })
    expect(f.stdout.text).toContain("source reserve 0 lamports (source emptied)")
    expect(f.methods).not.toContain("getMinimumBalanceForRentExemption")
    const sendIndex = f.methods.indexOf("sendTransaction")
    expect(f.methods[sendIndex - 1]).toBe("getFeeForMessage")
  })

  for (const balance of [0, 4_999, 5_000]) {
    test(`${balance} lamports cannot cover the fee and a positive send; no confirmation or signature`, async () => {
      const f = await fixture({ amount: "max", balance })
      let confirms = 0
      f.deps.promptLine = async () => {
        confirms++
        return "confirm"
      }
      const signing = spyOn(solanaLite, "signMessage")
      try {
        expect(await f.transfer()).toBe(1)
        expect(lastJson(f.stdout.text)).toMatchObject({ code: "TRANSFER_INSUFFICIENT_FUNDS" })
        expect(f.stdout.text).toContain("max leaves nothing to send")
        expect(confirms).toBe(0)
        expect(signing).not.toHaveBeenCalled()
        expect(f.wires).toHaveLength(0)
      } finally {
        signing.mockRestore()
      }
    })
  }

  test("an unavailable fee refuses instead of guessing a fee buffer", async () => {
    const f = await fixture({ amount: "max", fee: null })
    expect(await f.transfer()).toBe(1)
    expect(f.stdout.text).toContain("could not quote the SOL max fee")
    expect(f.wires).toHaveLength(0)
  })

  test("a fee change while quoting is resolved before confirmation", async () => {
    const f = await fixture({ amount: "max", fees: [5_000, 6_000, 6_000], fee: 6_000 })
    expect(await f.transfer()).toBe(0)
    expect(sentLamports(f)).toBe(BigInt(f.chain.balance - 6_000))
  })

  test("an unstable fee quote has a bounded refusal without signing", async () => {
    const f = await fixture({ amount: "max", fees: [5_000, 6_000, 7_000] })
    expect(await f.transfer()).toBe(1)
    expect(f.quotes).toHaveLength(3)
    expect(f.stdout.text).toContain("fee quote kept changing")
    expect(f.wires).toHaveLength(0)
  })

  for (const change of ["fee", "balance"] as const) {
    test(`a ${change} change during confirmation refetches and reconfirms the exact new amount`, async () => {
      const f = await fixture({ amount: "max" })
      let confirms = 0
      f.deps.promptLine = async () => {
        confirms++
        if (confirms === 1) {
          if (change === "fee") f.chain.fee = (f.chain.fee ?? 0) + 7_000
          else f.chain.balance += 7_000
        }
        return "confirm"
      }
      expect(await f.transfer()).toBe(0)
      expect(confirms).toBe(2)
      expect(sentLamports(f)).toBe(BigInt(f.chain.balance - (f.chain.fee ?? 0)))
      expect(lastJson(f.stdout.text).amountRaw).toBe(String(f.chain.balance - (f.chain.fee ?? 0)))
      expect(f.stderr.text).toContain("review and confirm the refreshed amount")
      expect(f.wires).toHaveLength(1)
    })
  }

  test("a wallet that keeps changing is refused after three confirmations without a signature", async () => {
    const f = await fixture({ amount: "max" })
    let confirms = 0
    f.deps.promptLine = async () => {
      confirms++
      f.chain.balance += 1
      return "confirm"
    }
    expect(await f.transfer()).toBe(1)
    expect(confirms).toBe(3)
    expect(f.stdout.text).toContain("kept changing during confirmation")
    expect(f.wires).toHaveLength(0)
  })

  test("declining a changed amount never broadcasts the old or new amount", async () => {
    const f = await fixture({ amount: "max" })
    let confirms = 0
    f.deps.promptLine = async () => {
      confirms++
      f.chain.balance += 1
      return confirms === 1 ? "confirm" : "no"
    }
    // BE-2674 (R28): a declined typed confirm is exit 5 (CANCELLED_EXIT).
    expect(await f.transfer()).toBe(5)
    expect(lastJson(f.stdout.text)).toMatchObject({ code: "DESTINATION_NOT_CONFIRMED" })
    expect(f.wires).toHaveLength(0)
  })

  for (const source of [{ sourceData: new Uint8Array(80) }, { sourceOwner: solanaLite.TOKEN_PROGRAM_ID }]) {
    test(`an unsupported source (${Object.keys(source)[0]}) cannot be swept by a plain system transfer`, async () => {
      const f = await fixture({ amount: "max", ...source })
      expect(await f.transfer()).toBe(1)
      expect(f.stdout.text).toContain("requires a system wallet with no account data")
      expect(f.wires).toHaveLength(0)
    })
  }

  test("SOL max still broadcasts at most once when the send is rate limited", async () => {
    const f = await fixture({ amount: "max", rateLimit: { sendTransaction: 1 } })
    expect(await f.transfer()).toBe(3)
    expect(f.methods.filter((method) => method === "sendTransaction")).toHaveLength(1)
    expect(f.stderr.text).toContain("rate-limited this CLI after the transaction was signed")
  })

  for (const program of [solanaLite.TOKEN_PROGRAM_ID, solanaLite.TOKEN_2022_PROGRAM_ID]) {
    test(`token max transfers the entire raw balance under ${program}`, async () => {
      const f = await fixture({ amount: "max", token: { program, mintData: tokenMint([]) } })
      expect(await f.transfer()).toBe(0)
      const tx = Transaction.from(Buffer.from(f.wires[0] ?? "", "base64"))
      const transfer = tx.instructions.at(-1)
      if (!transfer) throw new Error("missing token transfer instruction")
      expect(transfer.programId.toBase58()).toBe(program)
      expect(transfer.data[0]).toBe(12) // TransferChecked
      expect(transfer.data.readBigUInt64LE(1)).toBe(2_000_000n)
      expect(lastJson(f.stdout.text)).toMatchObject({ amount: "2", amountRaw: "2000000" })
    })
  }

  test("vault fund retains its decimal-only amount contract", async () => {
    const f = await fixture()
    expect(await run(["vault", "fund", DESTINATION, "--amount", "max", "--asset", "SOL", "--json"], f.deps)).toBe(2)
    expect(f.stdout.text).toContain("funding a wallet takes no max")
    expect(f.methods).toHaveLength(0)
  })
})

describe("BE-1551 review: account rent gates the command before confirmation and signing", () => {
  const fee = { type: ExtensionType.TransferFeeConfig, body: new Uint8Array(108) }
  const hook = { type: ExtensionType.TransferHook, body: new Uint8Array(64) } // disabled, still requires account state
  const nonTransferable = { type: ExtensionType.NonTransferable, body: new Uint8Array(0) }
  const pausable = { type: ExtensionType.PausableConfig, body: new Uint8Array(33) } // unpaused
  const cases = [
    { name: "classic", program: solanaLite.TOKEN_PROGRAM_ID, mintExtensions: [], accountExtensions: [] },
    {
      name: "bare Token-2022",
      program: solanaLite.TOKEN_2022_PROGRAM_ID,
      mintExtensions: [],
      accountExtensions: [ExtensionType.ImmutableOwner],
    },
    {
      name: "transfer fee",
      program: solanaLite.TOKEN_2022_PROGRAM_ID,
      mintExtensions: [fee],
      accountExtensions: [ExtensionType.ImmutableOwner, ExtensionType.TransferFeeAmount],
    },
    {
      name: "combined extensions",
      program: solanaLite.TOKEN_2022_PROGRAM_ID,
      mintExtensions: [fee, hook, nonTransferable, pausable],
      accountExtensions: [
        ExtensionType.ImmutableOwner,
        ExtensionType.TransferFeeAmount,
        ExtensionType.TransferHookAccount,
        ExtensionType.NonTransferableAccount,
        ExtensionType.PausableAccount,
      ],
    },
  ]
  for (const c of cases) {
    test(`${c.name}: old quote and one lamport short refuse; exact rent plus fee signs once`, async () => {
      const size = getAccountLen(c.accountExtensions)
      const rent = rentForSize(size)
      const needed = rent + 5000
      const balances = [...new Set([rentForSize(165) + 5000, needed - 1, needed])]
      for (const balance of balances) {
        const f = await fixture({ balance, token: { program: c.program, mintData: tokenMint(c.mintExtensions) } })
        let confirms = 0
        f.deps.promptLine = async () => {
          confirms++
          return "confirm"
        }
        const signing = spyOn(solanaLite, "signMessage")
        try {
          const accepted = balance === needed
          expect(await f.transfer()).toBe(accepted ? 0 : 1)
          expect(f.rentSizes).toEqual([size])
          expect(f.stdout.text).toContain(`account rent ${rent} lamports`)
          expect(confirms).toBe(accepted ? 1 : 0)
          expect(signing).toHaveBeenCalledTimes(accepted ? 1 : 0)
          expect(f.methods.filter((m) => m === "sendTransaction")).toHaveLength(accepted ? 1 : 0)
          if (!accepted) {
            expect(lastJson(f.stdout.text)).toMatchObject({
              code: "TRANSFER_INSUFFICIENT_FUNDS",
              details: { heldLamports: String(balance), neededLamports: String(needed) },
            })
          }
        } finally {
          signing.mockRestore()
        }
      }
    })
  }
})

describe("T10: RPC_RATE_LIMITED before any signature", () => {
  test("with acting profile work: exit 1, nothing signed or sent, the suggestion names profile set", async () => {
    const f = await fixture({ rateLimit: { getLatestBlockhash: Number.POSITIVE_INFINITY }, profile: true })
    expect(await f.transfer()).toBe(1)
    const body = lastJson(f.stdout.text)
    expect(body.code).toBe("RPC_RATE_LIMITED")
    expect(body.message).toBe(
      "The Solana RPC at rpc.test is rate-limiting this CLI (HTTP 429, retried once). Nothing was signed or sent.",
    )
    expect(body.suggestion).toBe(
      "candle profile set work --rpc-url https://<your-rpc>\nor, for one command, --rpc-url https://<your-rpc> or CANDLE_SOLANA_RPC_URL",
    )
    // One retry, then the refusal: two blockhash reads and no send.
    expect(f.methods).toEqual(["getLatestBlockhash", "getLatestBlockhash"])
    // The env source: a host line, and no notice.
    expect(f.stderr.text).toContain("Solana RPC: rpc.test (CANDLE_SOLANA_RPC_URL)")
    expect(f.stderr.text).not.toContain(publicRpcNoticeLines({ profile: "work" } as never)[0] as string)
  })

  test("pre-profile: the suggestion is D3's pre-profile text byte for byte", async () => {
    const f = await fixture({ rateLimit: { getLatestBlockhash: Number.POSITIVE_INFINITY } })
    expect(await f.transfer()).toBe(1)
    const body = lastJson(f.stdout.text)
    expect(body.code).toBe("RPC_RATE_LIMITED")
    expect(body.suggestion).toBe(PRE_PROFILE_FIX.join("\n"))
    expect(String(body.suggestion)).not.toContain("profile set")
    expect(String(body.suggestion)).not.toContain("<name>")
    expect(f.methods).not.toContain("sendTransaction")
  })

  test("human mode: the message, then Fix: with the lines aligned under it", async () => {
    const f = await fixture({ rateLimit: { getLatestBlockhash: Number.POSITIVE_INFINITY }, profile: true })
    expect(
      await run(["vault", "transfer", DESTINATION, "--from", "cold", "--amount", "0.1", "--asset", "SOL"], f.deps),
    ).toBe(1)
    expect(f.stderr.text).toContain(
      "Nothing was signed or sent.\nFix: candle profile set work --rpc-url https://<your-rpc>\n     or, for one command, --rpc-url https://<your-rpc> or CANDLE_SOLANA_RPC_URL\n",
    )
  })
})

describe("T11: a post-signature rate limit exits 3 with the signature and never re-sends", () => {
  test("with acting profile work: one send, finalized false, the signature, and Fix: profile set", async () => {
    const f = await fixture({ rateLimit: { sendTransaction: Number.POSITIVE_INFINITY }, profile: true })
    expect(await f.transfer()).toBe(3)
    const body = lastJson(f.stdout.text)
    expect(body.ok).toBe(false)
    expect(body.finalized).toBe(false)
    expect(typeof body.signature).toBe("string")
    expect(f.methods.filter((m) => m === "sendTransaction")).toHaveLength(1)
    expect(f.stderr.text).toContain(
      `The RPC rate-limited this CLI after the transaction was signed. It may still land: check ${body.signature} before anything else.\nFix: candle profile set work --rpc-url https://<your-rpc>\n`,
    )
  })

  test("pre-profile: the fix is D3's two pre-profile lines; exit code and signature are unchanged", async () => {
    const f = await fixture({ rateLimit: { sendTransaction: Number.POSITIVE_INFINITY } })
    expect(await f.transfer()).toBe(3)
    const body = lastJson(f.stdout.text)
    expect(typeof body.signature).toBe("string")
    expect(f.methods.filter((m) => m === "sendTransaction")).toHaveLength(1)
    expect(f.stderr.text).toContain(
      `check ${body.signature} before anything else.\nFix: ${PRE_PROFILE_FIX[0]}\n     ${PRE_PROFILE_FIX[1]}\n`,
    )
    expect(f.stderr.text).not.toContain("profile set")
    expect(f.stderr.text).not.toContain("<name>")
  })
})

describe("T12: a rate-limited status read after the send retries once, then exits 3", () => {
  test("two status requests, one send, exit 3 with the signature", async () => {
    const f = await fixture({ rateLimit: { getSignatureStatuses: Number.POSITIVE_INFINITY }, profile: true })
    expect(await f.transfer()).toBe(3)
    const body = lastJson(f.stdout.text)
    expect(typeof body.signature).toBe("string")
    expect(f.methods.filter((m) => m === "sendTransaction")).toHaveLength(1)
    expect(f.methods.filter((m) => m === "getSignatureStatuses")).toHaveLength(2)
    expect(f.stderr.text).toContain(`check ${body.signature} before anything else.`)
    expect(rpcFixLines({ profile: "work" } as never)[0]).toBe("candle profile set work --rpc-url https://<your-rpc>")
  })
})

describe("BE-1551 (T48 A8): a key that cannot pay, and a send the network never held", () => {
  test("an empty key refuses before the confirmation with TRANSFER_INSUFFICIENT_FUNDS; nothing is signed or sent", async () => {
    const f = await fixture({ balance: 0 })
    let confirms = 0
    f.deps.promptLine = async () => {
      confirms++
      return "confirm"
    }
    expect(await f.transfer()).toBe(1)
    const body = lastJson(f.stdout.text)
    expect(body.code).toBe("TRANSFER_INSUFFICIENT_FUNDS")
    expect(body.message).toContain("holds 0 lamports and this transfer needs 100005000 (100000000 to send + 5000 fee)")
    expect(body.message).toContain("Nothing was signed or sent.")
    expect(body.details).toMatchObject({ heldLamports: "0", neededLamports: "100005000" })
    expect(confirms).toBe(0)
    expect(f.methods).not.toContain("sendTransaction")
  })

  test("a balance one lamport short of amount plus fee refuses; exactly enough proceeds", async () => {
    const short = await fixture({ balance: 100_004_999 })
    expect(await short.transfer()).toBe(1)
    expect(lastJson(short.stdout.text).code).toBe("TRANSFER_INSUFFICIENT_FUNDS")
    const exact = await fixture({ balance: 100_005_000 })
    expect(await exact.transfer()).toBe(0)
    expect(exact.methods.filter((m) => m === "sendTransaction")).toHaveLength(1)
  })

  test("a send no status read ever finds is worded as most likely dropped, not submitted; exit 3", async () => {
    const human = await fixture({ status: "never" })
    expect(
      await run(["vault", "transfer", DESTINATION, "--from", "cold", "--amount", "0.1", "--asset", "SOL"], human.deps),
    ).toBe(3)
    expect(human.stdout.text).toContain("but no status read found it on the network: it was most likely dropped")
    expect(human.stdout.text).not.toContain("Submitted")

    const json = await fixture({ status: "never" })
    expect(await json.transfer()).toBe(3)
    const body = lastJson(json.stdout.text)
    expect(body).toMatchObject({ ok: false, finalized: false, seen: false })
  })
})
