/**
 * SEC-003: the checks a server-built Solana transfer or swap passes before a TEE wallet signs it.
 * Every refusal case is an honest fixture with one thing changed, so the test says which check
 * caught it.
 */
import { describe, expect, test } from "bun:test"
import { createSolanaRpc, decodePubkey, type SolanaRpc, systemTransfer } from "./solana-lite"
import { NATIVE_MINT, type SolanaSpend, solanaSpendProblem } from "./solana-verify"
import {
  ataOf,
  type SolanaScenario,
  scenarioRpcResult,
  swapScenario,
  tokenAccount,
  tokenApprove,
  tokenSetOwner,
  transferScenario,
  unsignedTransaction,
} from "./solana-verify.fixtures"

const WALLET = "7ZL9FvkpCMgdvzfoMSYZSuCXLCYN25dfgtDXej1BBJaB"
const TREASURY = "4Nd1mYvM6HqS8VqLFPzWx5W2sTQeXKZbLqBTdrBGTsGa"
const STRANGER = "8pM1nYvQ6HqS8VqLFPzWx5W2sTQeXKZbLqBTdrBGTsGb"
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const OTHER_MINT = "9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL"

/** The real JSON-RPC client over a fetch that answers from the scenario, so the wire shapes are tested too. */
function rpcFor(scenario: Pick<SolanaScenario, "pre" | "post">, err: unknown = null): SolanaRpc {
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    const result = scenarioRpcResult(scenario, body.method, body.params, err)
    if (result === undefined) throw new Error(`unexpected ${body.method}`)
    return Response.json({ jsonrpc: "2.0", id: body.id, result })
  }) as typeof fetch
  return createSolanaRpc("http://localhost/rpc", fetcher, async () => {})
}

async function check(scenario: SolanaScenario, expect: SolanaSpend, err: unknown = null) {
  return solanaSpendProblem(scenario.transaction, WALLET, rpcFor(scenario, err), expect)
}

const sendSol = (amountRaw: bigint): SolanaSpend => ({ kind: "transfer", asset: "SOL", amountRaw, recipient: TREASURY })
const sendUsdc = (amountRaw: bigint): SolanaSpend => ({ kind: "transfer", asset: USDC, amountRaw, recipient: TREASURY })
const buyUsdc: SolanaSpend = {
  kind: "swap",
  spend: "SOL",
  maxSpendRaw: 250_000_000n,
  receive: { asset: USDC, minRaw: 120_000n },
}

describe("transfer", () => {
  test("the honest SOL and token transfers pass", async () => {
    expect(
      await check(
        transferScenario({ wallet: WALLET, recipient: TREASURY, asset: "SOL", amountRaw: 500n }),
        sendSol(500n),
      ),
    ).toBeNull()
    expect(
      await check(
        transferScenario({ wallet: WALLET, recipient: TREASURY, asset: USDC, amountRaw: 250n }),
        sendUsdc(250n),
      ),
    ).toBeNull()
  })

  test("a build that pays a different recipient is refused", async () => {
    const sol = await check(
      transferScenario({ wallet: WALLET, recipient: STRANGER, asset: "SOL", amountRaw: 500n }),
      sendSol(500n),
    )
    expect(sol).toContain(STRANGER)
    const token = await check(
      transferScenario({ wallet: WALLET, recipient: STRANGER, asset: USDC, amountRaw: 250n }),
      sendUsdc(250n),
    )
    expect(token).toContain(`creates a token account for ${STRANGER}`)
  })

  test("a build of a different mint is refused", async () => {
    const problem = await check(
      transferScenario({ wallet: WALLET, recipient: TREASURY, asset: OTHER_MINT, amountRaw: 250n }),
      sendUsdc(250n),
    )
    expect(problem).toContain(`lose 250 raw of ${OTHER_MINT}`)
  })

  test("a build of a larger amount is refused", async () => {
    expect(
      await check(
        transferScenario({ wallet: WALLET, recipient: TREASURY, asset: "SOL", amountRaw: 501n }),
        sendSol(500n),
      ),
    ).toContain("not the 500 confirmed")
    expect(
      await check(
        transferScenario({ wallet: WALLET, recipient: TREASURY, asset: USDC, amountRaw: 251n }),
        sendUsdc(250n),
      ),
    ).toContain("send 251 raw")
  })

  test("a second recipient of part of the amount is refused, even when the total matches", async () => {
    const scenario = transferScenario({ wallet: WALLET, recipient: TREASURY, asset: "SOL", amountRaw: 400n })
    scenario.transaction = unsignedTransaction(WALLET, [
      systemTransfer(decodePubkey(WALLET), decodePubkey(TREASURY), 400n),
      systemTransfer(decodePubkey(WALLET), decodePubkey(STRANGER), 100n),
    ])
    scenario.pre[STRANGER] = { ...(scenario.pre[TREASURY] as NonNullable<(typeof scenario.pre)[string]>) }
    scenario.post[STRANGER] = {
      ...(scenario.post[TREASURY] as NonNullable<(typeof scenario.post)[string]>),
      lamports: 1_000_100n,
    }
    expect(await check(scenario, sendSol(500n))).toContain(`${STRANGER} would receive 100 lamports`)
  })

  test("an added Approve or SetAuthority is refused by instruction", async () => {
    const source = ataOf(WALLET, USDC)
    for (const [extra, reason] of [
      [tokenApprove(source, STRANGER, WALLET, 1_000n), "approves a delegate"],
      [tokenSetOwner(source, WALLET, STRANGER), "changes a token account's authority"],
    ] as const) {
      const scenario = transferScenario({ wallet: WALLET, recipient: TREASURY, asset: "SOL", amountRaw: 500n })
      scenario.transaction = unsignedTransaction(WALLET, [
        systemTransfer(decodePubkey(WALLET), decodePubkey(TREASURY), 500n),
        extra,
      ])
      expect(await check(scenario, sendSol(500n))).toContain(reason)
    }
  })

  test("a fee payer other than the wallet, an undecodable build and a failed simulation are refused", async () => {
    const scenario = transferScenario({ wallet: WALLET, recipient: TREASURY, asset: "SOL", amountRaw: 500n })
    const otherPayer = {
      ...scenario,
      transaction: unsignedTransaction(TREASURY, [
        systemTransfer(decodePubkey(TREASURY), decodePubkey(STRANGER), 500n),
      ]),
    }
    expect(await check(otherPayer, sendSol(500n))).toContain("fee payer")
    expect(await check({ ...scenario, transaction: "unsigned" }, sendSol(500n))).toContain("does not decode")
    expect(await check(scenario, sendSol(500n), { InstructionError: [0, "Custom"] })).toContain("simulation failed")
  })
})

describe("swap", () => {
  const honest = () =>
    swapScenario({ wallet: WALLET, spend: "SOL", spendRaw: 250_000_000n, receive: USDC, receiveRaw: 123_456n })

  test("the honest swap passes, either way round and with wrapped SOL named as its mint", async () => {
    expect(await check(honest(), buyUsdc)).toBeNull()
    const sell = swapScenario({
      wallet: WALLET,
      spend: USDC,
      spendRaw: 1_000_000n,
      receive: "SOL",
      receiveRaw: 5_000_000n,
    })
    expect(
      await check(sell, {
        kind: "swap",
        spend: USDC,
        maxSpendRaw: 1_000_000n,
        receive: { asset: NATIVE_MINT, minRaw: 4_000_000n },
      }),
    ).toBeNull()
  })

  test("spending more than confirmed is refused", async () => {
    const scenario = swapScenario({
      wallet: WALLET,
      spend: "SOL",
      spendRaw: 300_000_000n,
      receive: USDC,
      receiveRaw: 123_456n,
    })
    expect(await check(scenario, buyUsdc)).toContain("more than the 250000000 confirmed")
  })

  test("receiving less than the confirmed minimum, or another mint, is refused", async () => {
    const less = swapScenario({ wallet: WALLET, spend: "SOL", spendRaw: 250_000_000n, receive: USDC, receiveRaw: 1n })
    expect(await check(less, buyUsdc)).toContain("less than the 120000 confirmed")
    const other = swapScenario({
      wallet: WALLET,
      spend: "SOL",
      spendRaw: 250_000_000n,
      receive: OTHER_MINT,
      receiveRaw: 123_456n,
    })
    expect(await check(other, buyUsdc)).toContain(`receive 0 raw of ${USDC}`)
  })

  test("taking any other asset the wallet holds is refused", async () => {
    // The venue's second leg drains 50 raw of a mint the wallet holds instead of paying USDC.
    const scenario = swapScenario({
      wallet: WALLET,
      spend: "SOL",
      spendRaw: 250_000_000n,
      receive: OTHER_MINT,
      receiveRaw: -50n,
    })
    expect(await check(scenario, buyUsdc)).toContain(`lose 50 raw of ${OTHER_MINT}`)
  })

  test("an Approve or SetAuthority riding with the swap is refused by instruction", async () => {
    const own = ataOf(WALLET, USDC)
    const approve = swapScenario({
      wallet: WALLET,
      spend: "SOL",
      spendRaw: 250_000_000n,
      receive: USDC,
      receiveRaw: 123_456n,
      extra: [tokenApprove(own, STRANGER, WALLET, 10n ** 12n)],
    })
    expect(await check(approve, buyUsdc)).toContain("approves a delegate")
    const owner = swapScenario({
      wallet: WALLET,
      spend: "SOL",
      spendRaw: 250_000_000n,
      receive: USDC,
      receiveRaw: 123_456n,
      extra: [tokenSetOwner(own, WALLET, STRANGER)],
    })
    expect(await check(owner, buyUsdc)).toContain("changes a token account's authority")
  })

  test("a delegate granted by CPI is refused from the simulation's post state", async () => {
    const scenario = honest()
    const own = ataOf(WALLET, USDC)
    const delegated = tokenAccount(USDC, WALLET, 10_000_000_000n + 123_456n)
    new DataView(delegated.data.buffer).setUint32(72, 1, true)
    delegated.data.set(decodePubkey(STRANGER), 76)
    new DataView(delegated.data.buffer).setBigUint64(121, 10n ** 12n, true)
    scenario.post[own] = delegated
    expect(await check(scenario, buyUsdc)).toContain(`delegate changes from none to ${STRANGER}`)
  })

  test("a bridge deposit (no receive side) is held to its input", async () => {
    const deposit = swapScenario({ wallet: WALLET, spend: USDC, spendRaw: 1_000_000n, receive: "SOL", receiveRaw: 0n })
    expect(await check(deposit, { kind: "swap", spend: USDC, maxSpendRaw: 1_000_000n })).toBeNull()
    expect(await check(deposit, { kind: "swap", spend: USDC, maxSpendRaw: 999_999n })).toContain("more than")
  })
})
