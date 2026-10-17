import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbiParameters,
} from "viem"
import { HOOD_USDG_ADDRESS, HOOD_WETH_ADDRESS } from "./evm-lite"
import {
  CURVE_BUY_SELECTOR,
  CURVE_BUY_WITH_QUOTE_SELECTOR,
  CURVE_SELL_SELECTOR,
  HOOD_KYBER_ROUTER,
  HOOD_UNIV3_ROUTER,
  HOOD_V4_UNIVERSAL_ROUTER,
  hoodTradeLegCheck,
} from "./hood-legs"
import {
  ACTIONS,
  CURRENCY_AMOUNT,
  kyberSwap,
  SWAP_PARAMS,
  urAbi,
  v3Multicall,
  v3Path,
  v3Single,
  v3Unwrap,
  v4Direct,
} from "./test-hood-calldata"

type Hex = `0x${string}`
const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const attacker = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const token = "0x1111111111111111111111111111111111111111"
const routerRecipient = "0x0000000000000000000000000000000000000002"
const native = "0x0000000000000000000000000000000000000000"
const kyberNative = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
const amount = 10n ** 16n
const minimum = 123456n
const leg = (to: string, data: string, buy = false) => ({ to, data, value: buy ? amount.toString() : "0" })
const check = (buy: boolean, outputToken: string | undefined = buy ? token : undefined) =>
  hoodTradeLegCheck({
    wallet,
    inputToken: buy ? undefined : token,
    outputToken,
    amountRaw: amount,
    minOutRaw: minimum,
    venue: "dex",
  })

/** Edit one Universal Router input, preserving the command sequence and its other inputs. */
function editInput(data: Hex, index: number, edit: (input: Hex) => Hex): Hex {
  const {
    args: [commands, original, deadline],
  } = decodeFunctionData({ abi: urAbi, data })
  const inputs = [...original]
  inputs[index] = edit(inputs[index] as Hex)
  return encodeFunctionData({ abi: urAbi, functionName: "execute", args: [commands, inputs, deadline] })
}

function editV4(data: Hex, index: number, edit: (params: Hex[]) => void, newActions?: Hex): Hex {
  return editInput(data, index, (input) => {
    const [actions, original] = decodeAbiParameters(ACTIONS, input)
    const params = [...original]
    edit(params)
    return encodeAbiParameters(ACTIONS, [newActions ?? actions, params])
  })
}

describe("Hood output terms are enforced by each router", () => {
  for (const path of [false, true]) {
    test(`v3 ${path ? "exactInput" : "exactInputSingle"} pins output, minimum and recipient`, async () => {
      const encode = (output = token, floor = minimum, recipient = wallet) =>
        v3Multicall([
          path
            ? v3Path({
                tokens: [HOOD_WETH_ADDRESS, HOOD_USDG_ADDRESS, output],
                amountIn: amount,
                recipient,
                minimum: floor,
              })
            : v3Single({ tokenIn: HOOD_WETH_ADDRESS, tokenOut: output, amountIn: amount, recipient, minimum: floor }),
        ])
      expect(await check(true)("trade", leg(HOOD_UNIV3_ROUTER, encode(), true))).toBe(true)
      for (const bad of [encode(attacker), encode(token, minimum - 1n), encode(token, minimum, attacker)])
        expect(await check(true)("trade", leg(HOOD_UNIV3_ROUTER, bad, true))).toBe(false)
    })
  }

  test("v3 ETH output requires WETH held for a subsequent unwrap, with both floors pinned", async () => {
    const encode = (output = HOOD_WETH_ADDRESS, swapFloor = minimum, unwrapFloor = minimum, recipient = wallet) =>
      v3Multicall([
        v3Single({
          tokenIn: token,
          tokenOut: output,
          amountIn: amount,
          recipient: routerRecipient,
          minimum: swapFloor,
        }),
        v3Unwrap(recipient, unwrapFloor),
      ])
    expect(await check(false)("trade", leg(HOOD_UNIV3_ROUTER, encode()))).toBe(true)
    for (const bad of [
      encode(attacker),
      encode(HOOD_WETH_ADDRESS, 0n),
      encode(HOOD_WETH_ADDRESS, minimum, 0n),
      encode(HOOD_WETH_ADDRESS, minimum, minimum, attacker),
    ])
      expect(await check(false)("trade", leg(HOOD_UNIV3_ROUTER, bad))).toBe(false)
    const swap = v3Single({ tokenIn: token, tokenOut: HOOD_WETH_ADDRESS, amountIn: amount, recipient: routerRecipient })
    expect(await check(false)("trade", leg(HOOD_UNIV3_ROUTER, v3Multicall([v3Unwrap(wallet), swap])))).toBe(false)
    expect(
      await check(false)(
        "trade",
        leg(
          HOOD_UNIV3_ROUTER,
          v3Multicall([v3Single({ tokenIn: token, tokenOut: HOOD_WETH_ADDRESS, amountIn: amount, recipient: wallet })]),
        ),
      ),
    ).toBe(false)
  })

  test("v4 direct pins the output currency and both swap and TAKE_ALL floors", async () => {
    const base = { token, zeroForOne: true, amountIn: amount }
    const honest = v4Direct(base)
    expect(await check(true)("trade", leg(HOOD_V4_UNIVERSAL_ROUTER, honest, true))).toBe(true)
    for (const bad of [
      v4Direct({ ...base, token: attacker }),
      v4Direct({ ...base, minimum: minimum - 1n }),
      v4Direct({ ...base, takeMinimum: 0n }),
    ])
      expect(await check(true)("trade", leg(HOOD_V4_UNIVERSAL_ROUTER, bad, true))).toBe(false)
    // TAKE_ALL pays msg.sender. Replacing it with an explicit TAKE to an attacker is refused.
    const stolen = editV4(
      honest,
      0,
      (params) => {
        params[2] = encodeAbiParameters(parseAbiParameters("address,address,uint256"), [token, attacker, minimum])
      },
      "0x060c0e",
    )
    expect(await check(true)("trade", leg(HOOD_V4_UNIVERSAL_ROUTER, stolen, true))).toBe(false)
    expect(
      await check(false, HOOD_USDG_ADDRESS)(
        "trade",
        leg(HOOD_V4_UNIVERSAL_ROUTER, v4Direct({ token, zeroForOne: false, amountIn: amount })),
      ),
    ).toBe(false)
  })

  for (const mode of ["swap", "swapGeneric", "swapSimpleMode"]) {
    test(`Kyber ${mode} pins output, floor, recipient and exact input, including attacker source receivers`, async () => {
      const base = {
        srcToken: token,
        dstReceiver: wallet,
        amount,
        generic: mode === "swapGeneric",
        simple: mode === "swapSimpleMode",
      }
      expect(await check(false)("trade", leg(HOOD_KYBER_ROUTER, kyberSwap(base)))).toBe(true)
      for (const bad of [
        { dstToken: attacker },
        { minimum: minimum - 1n },
        { dstReceiver: attacker },
        { amount: amount - 1n },
        { srcReceivers: [attacker], dstToken: attacker, minimum: 0n },
        { srcReceivers: [attacker], minimum: 0n },
      ])
        expect(await check(false)("trade", leg(HOOD_KYBER_ROUTER, kyberSwap({ ...base, ...bad })))).toBe(false)
      // Native output has Kyber's sentinel; WETH and the zero address are different assets.
      for (const dstToken of [HOOD_WETH_ADDRESS, native])
        expect(await check(false)("trade", leg(HOOD_KYBER_ROUTER, kyberSwap({ ...base, dstToken })))).toBe(false)
      expect(
        await check(false)(
          "trade",
          leg(HOOD_KYBER_ROUTER, kyberSwap({ ...base, dstToken: kyberNative, minimum: minimum + 1n })),
        ),
      ).toBe(true)
      expect(
        await check(true)(
          "trade",
          leg(HOOD_KYBER_ROUTER, kyberSwap({ dstToken: token, dstReceiver: wallet, amount }), true),
        ),
      ).toBe(true)
    })
  }
})

// Like hood-legs.test.ts, this fixture exists only in the monorepo, not in the CLI mirror.
const sharedFile = join(import.meta.dir, "..", "..", "..", "packages", "shared", "src", "hood-dex.ts")
test.skipIf(!existsSync(sharedFile))(
  "bridged v4 pins final currency, final floor and payouts on both sides",
  async () => {
    const shared = await import(sharedFile)
    const route = {
      kind: "bridged-v4",
      quoteAsset: HOOD_USDG_ADDRESS,
      bridgeFee: 500,
      poolKey: { currency0: HOOD_USDG_ADDRESS, currency1: token, fee: 3000, tickSpacing: 60, hooks: native },
      zeroForOne: true,
    }
    const build = (side: "buy" | "sell", account = wallet, minAmountOut = minimum) =>
      shared.buildBridgedV4Swap({
        side,
        account,
        route: { ...route, zeroForOne: side === "buy" },
        amountInWei: amount,
        minAmountOut,
        deadline: 9999999999n,
      }).data as Hex
    const buy = build("buy")
    const sell = build("sell")
    expect(await check(true)("trade", leg(HOOD_V4_UNIVERSAL_ROUTER, buy, true))).toBe(true)
    expect(await check(false)("trade", leg(HOOD_V4_UNIVERSAL_ROUTER, sell))).toBe(true)
    const wrongBuyOutput = buy.replaceAll(token.slice(2), attacker.slice(2))
    const wrongSellOutput = sell.replaceAll(HOOD_WETH_ADDRESS.slice(2).toLowerCase(), attacker.slice(2))
    expect(await check(true)("trade", leg(HOOD_V4_UNIVERSAL_ROUTER, wrongBuyOutput, true))).toBe(false)
    expect(await check(false)("trade", leg(HOOD_V4_UNIVERSAL_ROUTER, wrongSellOutput))).toBe(false)
    const lowTake = editV4(buy, 2, (params) => {
      params[2] = encodeAbiParameters(CURRENCY_AMOUNT, [token, minimum - 1n])
    })
    const lowSwap = editV4(buy, 2, (params) => {
      const [swap] = decodeAbiParameters(SWAP_PARAMS, params[1] as Hex)
      params[1] = encodeAbiParameters(SWAP_PARAMS, [{ ...swap, amountOutMinimum: 0n }])
    })
    const stolenBuy = editV4(
      buy,
      2,
      (params) => {
        params[2] = encodeAbiParameters(parseAbiParameters("address,address,uint256"), [token, attacker, minimum])
      },
      "0x0b060e",
    )
    for (const bad of [lowTake, lowSwap, stolenBuy])
      expect(await check(true)("trade", leg(HOOD_V4_UNIVERSAL_ROUTER, bad, true))).toBe(false)
    for (const bad of [build("sell", wallet, minimum - 1n), build("sell", attacker)])
      expect(await check(false)("trade", leg(HOOD_V4_UNIVERSAL_ROUTER, bad))).toBe(false)
  },
)

describe("curve output floors", () => {
  const curve = "0x5555555555555555555555555555555555555555"
  const word = (n: bigint) => n.toString(16).padStart(64, "0")
  for (const entry of ["buy", "buyWithQuote", "sell"]) {
    test(`${entry} pins minAmountOut and the registered output source`, async () => {
      const buy = entry !== "sell"
      const verify = hoodTradeLegCheck({
        wallet,
        venue: "curve",
        inputToken: entry === "buy" ? undefined : entry === "buyWithQuote" ? HOOD_USDG_ADDRESS : token,
        outputToken: buy ? token : undefined,
        amountRaw: amount,
        minOutRaw: minimum,
        curve: async () => curve,
      })
      const data = (floor: bigint) =>
        entry === "buy"
          ? `${CURVE_BUY_SELECTOR}${word(floor)}`
          : `${entry === "sell" ? CURVE_SELL_SELECTOR : CURVE_BUY_WITH_QUOTE_SELECTOR}${word(amount)}${word(floor)}`
      for (const floor of [minimum, minimum + 1n])
        expect(await verify("trade", leg(curve, data(floor), entry === "buy"))).toBe(true)
      for (const floor of [0n, minimum - 1n])
        expect(await verify("trade", leg(curve, data(floor), entry === "buy"))).toBe(false)
      // Curves pay their caller, and the registry lookup is for the confirmed traded token.
      expect(await verify("trade", leg(attacker, data(minimum), entry === "buy"))).toBe(false)
    })
  }
})
