/**
 * The pinned contracts and selectors a Hood TEE wallet's legs are held to (hood-legs.ts), and the
 * drift guard that keeps them equal to what the server's planner builds against. The leg loop
 * itself is exercised end to end in commands/swap-hood.test.ts and launch-transfer-hood.test.ts.
 *
 * The drift checks read `packages/shared` and `docs/` by path, so they skip in a standalone export
 * of this package (the public agentic mirror), as the reserve drift check in swap-hood.test.ts does.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { keccak_256 } from "@noble/hashes/sha3"
import { bytesToHex, type EvmRpc, HOOD_USDG_ADDRESS, HOOD_WETH_ADDRESS } from "./evm-lite"
import {
  CREATE_CURVE_SELECTOR,
  CURVE_BUY_SELECTOR,
  CURVE_BUY_WITH_QUOTE_SELECTOR,
  CURVE_CREATED_TOPIC,
  CURVE_SELL_SELECTOR,
  createCurveLegOk,
  curveCreatedBy,
  ERC20_APPROVE_SELECTOR,
  feeLegOk,
  HOOD_CURVE_FACTORY,
  HOOD_CURVE_REGISTRIES,
  HOOD_KYBER_ROUTER,
  HOOD_PERMIT2,
  HOOD_SPLITTER_FACTORY,
  HOOD_UNIV3_ROUTER,
  HOOD_V4_UNIVERSAL_ROUTER,
  hoodFeeTreasury,
  hoodTradeLegCheck,
  KYBER_SWAP_GENERIC_SELECTOR,
  KYBER_SWAP_SELECTOR,
  KYBER_SWAP_SIMPLE_SELECTOR,
  launchBuyLegOk,
  launchFeeCap,
  PERMIT2_APPROVE_SELECTOR,
  registeredCurveFor,
  SPLITTER_DEV_SELECTOR,
  SPLITTER_IS_SPLITTER_SELECTOR,
  SPLITTER_PLATFORM_VAULT_SELECTOR,
  UNIVERSAL_EXECUTE_SELECTOR,
  V3_EXACT_INPUT_SELECTOR,
  V3_EXACT_INPUT_SINGLE_SELECTOR,
  V3_MULTICALL_SELECTOR,
  V3_REFUND_ETH_SELECTOR,
  V3_UNWRAP_WETH9_SELECTOR,
} from "./hood-legs"
import {
  kyberSwap,
  v3Buy,
  v3Multicall,
  v3Path,
  v3Refund,
  v3Sell,
  v3Single,
  v3Unwrap,
  v4Direct,
  v4Raw,
} from "./test-hood-calldata"

const selector = (signature: string) => bytesToHex(keccak_256(new TextEncoder().encode(signature)).subarray(0, 4))
const root = join(import.meta.dir, "..", "..", "..")
const treasury = "0x3333333333333333333333333333333333333333"
/** An address as the 32-byte word an `eth_call` answers. */
const wordOf = (address: string) => {
  const out = new Uint8Array(32)
  out.set(Buffer.from(address.slice(2), "hex"), 12)
  return out
}

describe("pinned selectors", () => {
  test("each selector is the keccak of its signature", () => {
    expect(CREATE_CURVE_SELECTOR).toBe(
      selector(
        "createCurve((address,address,address,address,address,address,address,uint16,bool,uint256,string,string,string,string,string,uint8,uint256,(uint16,uint256,uint256,uint256,uint256,uint256,uint256)),uint8,uint16,bytes32)",
      ),
    )
    expect(ERC20_APPROVE_SELECTOR).toBe(selector("approve(address,uint256)"))
    expect(PERMIT2_APPROVE_SELECTOR).toBe(selector("approve(address,address,uint160,uint48)"))
    expect(CURVE_BUY_SELECTOR).toBe(selector("buy(uint256)"))
    expect(CURVE_BUY_WITH_QUOTE_SELECTOR).toBe(selector("buyWithQuote(uint256,uint256)"))
    expect(CURVE_SELL_SELECTOR).toBe(selector("sell(uint256,uint256)"))
    expect(V3_MULTICALL_SELECTOR).toBe(selector("multicall(uint256,bytes[])"))
    expect(V3_EXACT_INPUT_SINGLE_SELECTOR).toBe(
      selector("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))"),
    )
    expect(V3_EXACT_INPUT_SELECTOR).toBe(selector("exactInput((bytes,address,uint256,uint256))"))
    expect(V3_UNWRAP_WETH9_SELECTOR).toBe(selector("unwrapWETH9(uint256,address)"))
    expect(V3_REFUND_ETH_SELECTOR).toBe(selector("refundETH()"))
    expect(UNIVERSAL_EXECUTE_SELECTOR).toBe(selector("execute(bytes,bytes[],uint256)"))
    const desc = "(address,address,address[],uint256[],address[],uint256[],address,uint256,uint256,uint256,bytes)"
    expect(KYBER_SWAP_SELECTOR).toBe(selector(`swap((address,address,bytes,${desc},bytes))`))
    expect(KYBER_SWAP_GENERIC_SELECTOR).toBe(selector(`swapGeneric((address,address,bytes,${desc},bytes))`))
    expect(KYBER_SWAP_SIMPLE_SELECTOR).toBe(selector(`swapSimpleMode(address,${desc},bytes,bytes)`))
    expect(SPLITTER_DEV_SELECTOR).toBe(selector("dev()"))
    expect(SPLITTER_IS_SPLITTER_SELECTOR).toBe(selector("isSplitter(address)"))
    expect(SPLITTER_PLATFORM_VAULT_SELECTOR).toBe(selector("platformVault()"))
    // `DexVersion` is an enum, so the event's ABI signature carries it as uint8.
    expect(CURVE_CREATED_TOPIC).toBe(
      bytesToHex(keccak_256(new TextEncoder().encode("CurveCreated(address,address,address,uint8,bytes32,bytes32)"))),
    )
  })

  test("CurveCreated is the factory's event, with curve, base token and creator indexed in that order", () => {
    const file = join(root, "packages", "contracts-evm", "src", "CandleCurveFactory.sol")
    if (!existsSync(file)) return
    expect(readFileSync(file, "utf8").replace(/\s+/g, " ")).toContain(
      "event CurveCreated( address indexed curve, address indexed baseToken, address indexed creator, DexVersion dexVersion, bytes32 configHash, bytes32 launcherSalt );",
    )
  })
})

describe("drift: the pinned contracts are the ones the server builds against", () => {
  test("routers and Permit2 match packages/shared/src/hood-dex.ts", () => {
    const file = join(root, "packages", "shared", "src", "hood-dex.ts")
    if (!existsSync(file)) return
    const shared = readFileSync(file, "utf8")
    expect(shared).toContain(`HOOD_UNIV3_ROUTER = "${HOOD_UNIV3_ROUTER}"`)
    expect(shared).toContain(`HOOD_KYBER_ROUTER = "${HOOD_KYBER_ROUTER}"`)
    // v4 and Permit2 keep an env override on the server; the defaults are what the CLI pins.
    for (const address of [HOOD_V4_UNIVERSAL_ROUTER, HOOD_PERMIT2])
      expect(shared).toContain(`"${address}") as \`0x\${string}\``)
  })

  test("the factory is the newest stack's and the registries are all three stacks' in docs/contracts.md", () => {
    const file = join(root, "docs", "contracts.md")
    if (!existsSync(file)) return
    const rows = readFileSync(file, "utf8").split("\n")
    const columns = (name: string) =>
      rows
        .find((row) => row.startsWith(`| \`${name}\``))
        ?.split("|")
        .slice(2, 5)
        .map((cell) => cell.trim().replaceAll("`", ""))
    expect(columns("CandleCurveFactory")?.[0]).toBe(HOOD_CURVE_FACTORY)
    expect(columns("CandleCurveRegistry")).toEqual([...HOOD_CURVE_REGISTRIES])
    expect(columns("CandleFeeSplitterFactory")?.[0]).toBe(HOOD_SPLITTER_FACTORY)
  })
})

describe("fee legs", () => {
  test("launchFeeCap is 10% of the first buy, rounded up", () => {
    expect(launchFeeCap("1000000000000000")).toBe(100000000000000n)
    expect(launchFeeCap("11")).toBe(2n)
  })

  test("ETH: empty data, at most the cap, to the treasury and nowhere else", () => {
    const ok = { to: treasury, data: "0x", value: "10" }
    expect(feeLegOk(ok, { cap: 10n, asset: "eth", treasury })).toBe(true)
    expect(feeLegOk({ ...ok, value: "11" }, { cap: 10n, asset: "eth", treasury })).toBe(false)
    expect(feeLegOk({ ...ok, data: "0x00" }, { cap: 10n, asset: "eth", treasury })).toBe(false)
    expect(feeLegOk({ ...ok, to: HOOD_USDG_ADDRESS }, { cap: 10n, asset: "eth", treasury })).toBe(false)
    expect(feeLegOk({ ...ok, value: "-1" }, { cap: 10n, asset: "eth", treasury })).toBe(false)
    expect(feeLegOk({ ...ok, to: HOOD_SPLITTER_FACTORY }, { cap: 10n, asset: "eth", treasury })).toBe(false)
  })

  test("hoodFeeTreasury is the splitter factory's platformVault; a zero answer or an RPC error is none", async () => {
    const asked: Array<{ to: string; data: string }> = []
    const rpcAnswering = (answer: Uint8Array | Error): EvmRpc =>
      ({
        call: async (req: { to: string; data: Uint8Array }) => {
          asked.push({ to: req.to, data: bytesToHex(req.data) })
          if (answer instanceof Error) throw answer
          return answer
        },
      }) as unknown as EvmRpc
    expect(await hoodFeeTreasury(rpcAnswering(wordOf(treasury)))).toBe(treasury)
    expect(asked[0]).toEqual({ to: HOOD_SPLITTER_FACTORY, data: SPLITTER_PLATFORM_VAULT_SELECTOR })
    expect(await hoodFeeTreasury(rpcAnswering(new Uint8Array(32)))).toBe(undefined)
    expect(await hoodFeeTreasury(rpcAnswering(new Error("rpc down")))).toBe(undefined)
  })

  test("a trade's fee leg is refused when the chain names another treasury, or none", async () => {
    const wallet = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa"
    const check = (named: () => Promise<string | undefined>) =>
      hoodTradeLegCheck({
        wallet,
        venue: "dex",
        amountRaw: 10n,
        outputToken: "0x1111111111111111111111111111111111111111",
        minOutRaw: 1n,
        fee: { cap: 5n, asset: "eth" },
        treasury: named,
      })
    const leg = { to: treasury, data: "0x", value: "5" }
    expect(await check(async () => treasury)("feeTransfer", leg)).toBe(true)
    expect(await check(async () => "0x9999999999999999999999999999999999999999")("feeTransfer", leg)).toBe(false)
    expect(await check(async () => undefined)("feeTransfer", leg)).toBe(false)
    expect(
      await check(async () => {
        throw new Error("rpc down")
      })("feeTransfer", leg),
    ).toBe(false)
  })
})

describe("a launch's buy is held to the curve its own createCurve made", () => {
  const wallet = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa"
  const curve = "0x5555555555555555555555555555555555555555"
  const topic = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`
  const created = (overrides: { address?: string; creator?: string; curve?: string } = {}) => ({
    address: overrides.address ?? HOOD_CURVE_FACTORY,
    topics: [
      CURVE_CREATED_TOPIC,
      topic(overrides.curve ?? curve),
      topic("0x6666666666666666666666666666666666666666"),
      topic(overrides.creator ?? wallet),
    ],
  })
  const receipt = (logs: Array<{ address: string; topics: string[] }>, status: 0 | 1 = 1) => ({
    status,
    blockNumber: 1n,
    transactionHash: `0x${"ab".repeat(32)}`,
    logs,
  })

  test("the one CurveCreated the pinned factory logged for this wallet names the curve", () => {
    expect(curveCreatedBy(receipt([created()]), wallet)).toBe(curve)
  })

  test("another creator, another emitter, two curves, a revert or no receipt name none", () => {
    expect(curveCreatedBy(receipt([created({ creator: treasury })]), wallet)).toBe(undefined)
    expect(curveCreatedBy(receipt([created({ address: treasury })]), wallet)).toBe(undefined)
    expect(curveCreatedBy(receipt([created(), created({ curve: treasury })]), wallet)).toBe(undefined)
    expect(curveCreatedBy(receipt([created()], 0), wallet)).toBe(undefined)
    expect(curveCreatedBy(receipt([]), wallet)).toBe(undefined)
    expect(curveCreatedBy(null, wallet)).toBe(undefined)
  })

  test("the buy leg is exactly buy(minAmountOut) on that curve for the confirmed amount", () => {
    const data = `${CURVE_BUY_SELECTOR}${"0".repeat(63)}1`
    expect(launchBuyLegOk({ to: curve, data, value: "1000" }, "1000", curve)).toBe(true)
    expect(launchBuyLegOk({ to: treasury, data, value: "1000" }, "1000", curve)).toBe(false)
    expect(launchBuyLegOk({ to: curve, data, value: "1001" }, "1000", curve)).toBe(false)
    expect(launchBuyLegOk({ to: curve, data: CURVE_BUY_SELECTOR, value: "1000" }, "1000", curve)).toBe(false)
    expect(
      launchBuyLegOk({ to: curve, data: `${CURVE_SELL_SELECTOR}${"0".repeat(64)}`, value: "1000" }, "1000", curve),
    ).toBe(false)
  })
})

describe("registeredCurveFor", () => {
  const rpcAnswering = (answers: Array<Uint8Array | Error>): EvmRpc =>
    ({
      call: async () => {
        const next = answers.shift()
        if (next instanceof Error || next === undefined) throw next ?? new Error("no answer")
        return next
      },
    }) as unknown as EvmRpc

  test("the newest registry that names a curve wins; a zero answer or a revert falls to the next", async () => {
    const curve = "0x5555555555555555555555555555555555555555"
    expect(await registeredCurveFor(rpcAnswering([wordOf(curve)]), treasury)).toBe(curve)
    expect(await registeredCurveFor(rpcAnswering([new Uint8Array(32), wordOf(curve)]), treasury)).toBe(curve)
    expect(await registeredCurveFor(rpcAnswering([new Error("reverted"), wordOf(curve)]), treasury)).toBe(curve)
    expect(await registeredCurveFor(rpcAnswering([new Uint8Array(32), new Error("reverted")]), treasury)).toBe(
      undefined,
    )
  })
})

describe("DEX trade legs are decoded and held to what was confirmed", () => {
  const wallet = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa"
  const other = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"
  const token = "0x1111111111111111111111111111111111111111"
  const AMOUNT = 10n ** 16n
  const dexLeg = (to: string, data: string, value = "0") => ({ to, data, value })
  const check = (inputToken: string | undefined) =>
    hoodTradeLegCheck({
      wallet,
      venue: "dex",
      ...(inputToken ? { inputToken } : {}),
      amountRaw: AMOUNT,
      outputToken: inputToken ? undefined : token,
      minOutRaw: 123456n,
    })
  const sell = check(token)
  const buy = check(undefined)

  test("honest v3 and Kyber calls pass", async () => {
    expect(await sell("trade", dexLeg(HOOD_UNIV3_ROUTER, v3Sell(token, AMOUNT, wallet)))).toBe(true)
    expect(await buy("trade", dexLeg(HOOD_UNIV3_ROUTER, v3Buy(token, AMOUNT, wallet), AMOUNT.toString()))).toBe(true)
    const hops = v3Multicall([
      v3Path({
        tokens: [token, HOOD_USDG_ADDRESS, HOOD_WETH_ADDRESS],
        recipient: "0x0000000000000000000000000000000000000002",
        amountIn: AMOUNT,
      }),
      v3Unwrap(wallet),
    ])
    expect(await sell("trade", dexLeg(HOOD_UNIV3_ROUTER, hops))).toBe(true)
    expect(
      await sell(
        "trade",
        dexLeg(HOOD_KYBER_ROUTER, kyberSwap({ srcToken: token, dstReceiver: wallet, amount: AMOUNT })),
      ),
    ).toBe(true)
    expect(
      await sell(
        "trade",
        dexLeg(HOOD_KYBER_ROUTER, kyberSwap({ srcToken: token, dstReceiver: wallet, amount: AMOUNT, simple: true })),
      ),
    ).toBe(true)
    expect(
      await buy(
        "trade",
        dexLeg(
          HOOD_KYBER_ROUTER,
          kyberSwap({ dstToken: token, dstReceiver: wallet, amount: AMOUNT }),
          AMOUNT.toString(),
        ),
      ),
    ).toBe(true)
    expect(
      await sell("trade", dexLeg(HOOD_V4_UNIVERSAL_ROUTER, v4Direct({ token, zeroForOne: false, amountIn: AMOUNT }))),
    ).toBe(true)
    expect(
      await buy(
        "trade",
        dexLeg(HOOD_V4_UNIVERSAL_ROUTER, v4Direct({ token, zeroForOne: true, amountIn: AMOUNT }), AMOUNT.toString()),
      ),
    ).toBe(true)
  })

  test("a call that names another input token is refused on every router", async () => {
    expect(await sell("trade", dexLeg(HOOD_UNIV3_ROUTER, v3Sell(other, AMOUNT, wallet)))).toBe(false)
    expect(
      await sell(
        "trade",
        dexLeg(
          HOOD_UNIV3_ROUTER,
          v3Multicall([v3Path({ tokens: [other, HOOD_WETH_ADDRESS], recipient: wallet, amountIn: AMOUNT })]),
        ),
      ),
    ).toBe(false)
    expect(
      await sell(
        "trade",
        dexLeg(HOOD_KYBER_ROUTER, kyberSwap({ srcToken: other, dstReceiver: wallet, amount: AMOUNT })),
      ),
    ).toBe(false)
    expect(
      await sell(
        "trade",
        dexLeg(
          HOOD_V4_UNIVERSAL_ROUTER,
          v4Direct({ token: other, zeroForOne: false, amountIn: AMOUNT, settleCurrency: other }),
        ),
      ),
    ).toBe(false)
  })

  test("a larger amount than confirmed is refused on every router", async () => {
    const more = AMOUNT + 1n
    expect(await sell("trade", dexLeg(HOOD_UNIV3_ROUTER, v3Sell(token, more, wallet)))).toBe(false)
    const twice = v3Multicall([
      v3Single({ tokenIn: token, tokenOut: HOOD_WETH_ADDRESS, recipient: wallet, amountIn: AMOUNT }),
      v3Single({ tokenIn: token, tokenOut: HOOD_WETH_ADDRESS, recipient: wallet, amountIn: AMOUNT }),
    ])
    expect(await sell("trade", dexLeg(HOOD_UNIV3_ROUTER, twice))).toBe(false)
    expect(
      await sell("trade", dexLeg(HOOD_KYBER_ROUTER, kyberSwap({ srcToken: token, dstReceiver: wallet, amount: more }))),
    ).toBe(false)
    expect(
      await sell("trade", dexLeg(HOOD_V4_UNIVERSAL_ROUTER, v4Direct({ token, zeroForOne: false, amountIn: more }))),
    ).toBe(false)
  })

  test("another recipient is refused on every router", async () => {
    expect(await sell("trade", dexLeg(HOOD_UNIV3_ROUTER, v3Sell(token, AMOUNT, other)))).toBe(false)
    expect(await buy("trade", dexLeg(HOOD_UNIV3_ROUTER, v3Buy(token, AMOUNT, other), AMOUNT.toString()))).toBe(false)
    expect(
      await sell(
        "trade",
        dexLeg(HOOD_KYBER_ROUTER, kyberSwap({ srcToken: token, dstReceiver: other, amount: AMOUNT })),
      ),
    ).toBe(false)
  })

  test("Kyber carrying fee receivers or a source split above the amount is refused", async () => {
    const base = { srcToken: token, dstReceiver: wallet, amount: AMOUNT }
    expect(
      await sell("trade", dexLeg(HOOD_KYBER_ROUTER, kyberSwap({ ...base, feeReceivers: [other], feeAmounts: [1n] }))),
    ).toBe(false)
    expect(await sell("trade", dexLeg(HOOD_KYBER_ROUTER, kyberSwap({ ...base, srcAmounts: [AMOUNT, 1n] })))).toBe(false)
  })

  test("calls this check does not decode are refused", async () => {
    // An unknown selector, a Universal Router command it does not know, extra multicall members,
    // truncated data, and a v3 sweep to another address.
    expect(await sell("trade", dexLeg(HOOD_KYBER_ROUTER, "0xabcdef"))).toBe(false)
    expect(await sell("trade", dexLeg(HOOD_UNIV3_ROUTER, `0xdeadbeef${"00".repeat(64)}`))).toBe(false)
    // The Uniswap v2 router is no longer a known spender or target.
    expect(
      await sell("trade", dexLeg("0x89e5db8b5aa49aa85ac63f691524311aeb649eba", `0xdeadbeef${"00".repeat(64)}`)),
    ).toBe(false)
    expect(await sell("trade", dexLeg(HOOD_UNIV3_ROUTER, `${V3_EXACT_INPUT_SINGLE_SELECTOR}${"00".repeat(32)}`))).toBe(
      false,
    )
    expect(await sell("trade", dexLeg(HOOD_V4_UNIVERSAL_ROUTER, v4Raw("0x0a", ["0x"])))).toBe(false)
    expect(await sell("trade", dexLeg(HOOD_V4_UNIVERSAL_ROUTER, v4Raw("0x1010", ["0x", "0x"])))).toBe(false)
    expect(
      await sell(
        "trade",
        dexLeg(HOOD_V4_UNIVERSAL_ROUTER, v4Direct({ token, zeroForOne: false, amountIn: AMOUNT }).slice(0, 200)),
      ),
    ).toBe(false)
    expect(await sell("trade", dexLeg(HOOD_UNIV3_ROUTER, v3Multicall([v3Refund(), "0x12345678"])))).toBe(false)
    expect(await sell("trade", dexLeg(HOOD_UNIV3_ROUTER, v3Multicall([])))).toBe(false)
  })

  test("a v4 swap whose settle names another currency or whose take is another currency is refused", async () => {
    const wrongSettle = v4Direct({ token, zeroForOne: false, amountIn: AMOUNT, settleCurrency: other })
    const wrongTake = v4Direct({ token, zeroForOne: false, amountIn: AMOUNT, takeCurrency: other })
    expect(await sell("trade", dexLeg(HOOD_V4_UNIVERSAL_ROUTER, wrongSettle))).toBe(false)
    expect(await sell("trade", dexLeg(HOOD_V4_UNIVERSAL_ROUTER, wrongTake))).toBe(false)
  })

  test("what packages/shared/src/hood-dex.ts builds is accepted, bridged v4 included", async () => {
    const file = join(root, "packages", "shared", "src", "hood-dex.ts")
    if (!existsSync(file)) return
    const shared = await import(file)
    const deadline = 9_999_999_999n
    const poolKey = {
      currency0: "0x0000000000000000000000000000000000000000",
      currency1: token,
      fee: 3000,
      tickSpacing: 60,
      hooks: "0x0000000000000000000000000000000000000000",
    }
    const v3 = shared.buildDexSwapMulticall({
      side: "sell",
      baseToken: token,
      account: wallet,
      amountInWei: AMOUNT,
      minAmountOut: 123456n,
      route: { kind: "weth", fee: 3000 },
      deadline,
    })
    expect(await sell("trade", dexLeg(HOOD_UNIV3_ROUTER, v3.data))).toBe(true)
    const v3Usdg = shared.buildDexSwapMulticall({
      side: "sell",
      baseToken: token,
      account: wallet,
      amountInWei: AMOUNT,
      minAmountOut: 123456n,
      route: { kind: "usdg-hop", tokenWethFee: 3000, bridgeFee: 500 },
      deadline,
    })
    expect(
      await hoodTradeLegCheck({
        wallet,
        venue: "dex",
        inputToken: token,
        outputToken: HOOD_USDG_ADDRESS,
        amountRaw: AMOUNT,
        minOutRaw: 123456n,
      })("trade", dexLeg(HOOD_UNIV3_ROUTER, v3Usdg.data)),
    ).toBe(true)
    const v3Buy_ = shared.buildDexSwapMulticall({
      side: "buy",
      baseToken: token,
      account: wallet,
      amountInWei: AMOUNT,
      minAmountOut: 123456n,
      route: { kind: "weth", fee: 3000 },
      deadline,
    })
    expect(await buy("trade", dexLeg(HOOD_UNIV3_ROUTER, v3Buy_.data, AMOUNT.toString()))).toBe(true)
    const v4Sell = shared.buildV4Swap({
      side: "sell",
      poolKey,
      zeroForOne: false,
      baseToken: token,
      amountInWei: AMOUNT,
      minAmountOut: 123456n,
      deadline,
    })
    expect(await sell("trade", dexLeg(HOOD_V4_UNIVERSAL_ROUTER, v4Sell.data))).toBe(true)
    const v4Buy = shared.buildV4Swap({
      side: "buy",
      poolKey,
      zeroForOne: true,
      baseToken: token,
      amountInWei: AMOUNT,
      minAmountOut: 123456n,
      deadline,
    })
    expect(await buy("trade", dexLeg(HOOD_V4_UNIVERSAL_ROUTER, v4Buy.data, AMOUNT.toString()))).toBe(true)
    const route = {
      kind: "bridged-v4",
      poolKey: { ...poolKey, currency0: HOOD_USDG_ADDRESS },
      zeroForOne: false,
      quoteAsset: HOOD_USDG_ADDRESS,
      bridgeFee: 500,
    }
    const bridgedBuy = shared.buildBridgedV4Swap({
      side: "buy",
      route: { ...route, poolKey: { ...route.poolKey, currency1: token }, zeroForOne: true },
      account: wallet,
      amountInWei: AMOUNT,
      minAmountOut: 123456n,
      deadline,
    })
    expect(await buy("trade", dexLeg(HOOD_V4_UNIVERSAL_ROUTER, bridgedBuy.data, AMOUNT.toString()))).toBe(true)
    const bridgedSell = shared.buildBridgedV4Swap({
      side: "sell",
      route: { ...route, poolKey: { ...route.poolKey, currency1: token }, zeroForOne: false },
      account: wallet,
      amountInWei: AMOUNT,
      minAmountOut: 123456n,
      deadline,
    })
    expect(await sell("trade", dexLeg(HOOD_V4_UNIVERSAL_ROUTER, bridgedSell.data))).toBe(true)
    // ...and the same bridged sell with its unwrap paying another address is not.
    const stolen = shared.buildBridgedV4Swap({
      side: "sell",
      route: { ...route, poolKey: { ...route.poolKey, currency1: token }, zeroForOne: false },
      account: other,
      amountInWei: AMOUNT,
      minAmountOut: 123456n,
      deadline,
    })
    expect(await sell("trade", dexLeg(HOOD_V4_UNIVERSAL_ROUTER, stolen.data))).toBe(false)
  })
})

describe("createCurve pins the fee splitter", () => {
  const wallet = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa"
  const splitter = "0x7777777777777777777777777777777777777777"
  const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0")
  const curveData = (feeRecipient: string, creator = wallet) =>
    `${CREATE_CURVE_SELECTOR}${[word("80"), word("1"), word("0"), word("ab".repeat(32)), word(""), word(""), word(""), word(feeRecipient), word(""), word(creator)].join("")}`
  const rpc = (opts: { vouched?: boolean; dev?: string; throws?: boolean }): EvmRpc =>
    ({
      call: async (req: { to: string; data: Uint8Array }) => {
        if (opts.throws) throw new Error("rpc down")
        const out = new Uint8Array(32)
        if (bytesToHex(req.data).startsWith(SPLITTER_IS_SPLITTER_SELECTOR)) {
          out[31] = opts.vouched === false ? 0 : 1
        } else out.set(Buffer.from((opts.dev ?? wallet).slice(2), "hex"), 12)
        return out
      },
    }) as unknown as EvmRpc
  const leg = (data: string) => ({ to: HOOD_CURVE_FACTORY, data, value: "0" })

  test("a vouched splitter whose dev is the wallet passes", async () => {
    expect(await createCurveLegOk(leg(curveData(splitter)), wallet, rpc({}))).toBe(true)
  })
  test("a splitter whose dev is someone else is refused", async () => {
    expect(
      await createCurveLegOk(
        leg(curveData(splitter)),
        wallet,
        rpc({ dev: "0x9999999999999999999999999999999999999999" }),
      ),
    ).toBe(false)
  })
  test("a fee recipient the splitter factory does not vouch for is refused", async () => {
    expect(await createCurveLegOk(leg(curveData(splitter)), wallet, rpc({ vouched: false }))).toBe(false)
  })
  test("an RPC that cannot answer refuses rather than signs", async () => {
    expect(await createCurveLegOk(leg(curveData(splitter)), wallet, rpc({ throws: true }))).toBe(false)
  })
  test("another creator is still refused", async () => {
    expect(
      await createCurveLegOk(leg(curveData(splitter, "0x9999999999999999999999999999999999999999")), wallet, rpc({})),
    ).toBe(false)
  })
})
