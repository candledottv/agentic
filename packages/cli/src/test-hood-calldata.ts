/**
 * Calldata encoders for the Hood DEX routers, written from the routers' ABIs with viem (a dev
 * dependency), so a test hands hood-legs.ts real bytes rather than a placeholder. The drift test in
 * hood-legs.test.ts feeds it what `packages/shared/src/hood-dex.ts` builds.
 */
import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters } from "viem"
import { HOOD_USDG_ADDRESS, HOOD_WETH_ADDRESS } from "./evm-lite"

type Hex = `0x${string}`
type Address = Hex
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002" as Address
const NATIVE = "0x0000000000000000000000000000000000000000" as Address
const KYBER_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address
const DEADLINE = 9_999_999_999n

const v3Abi = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256)",
  "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function refundETH() payable",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])",
])
export const urAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"])
const kyberAbi = parseAbi([
  "struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }",
  "struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }",
  "function swap(SwapExecutionParams execution) payable returns (uint256 returnAmount, uint256 gasUsed)",
  "function swapGeneric(SwapExecutionParams execution) payable returns (uint256 returnAmount, uint256 gasUsed)",
  "function swapSimpleMode(address caller, SwapDescriptionV2 desc, bytes executorData, bytes clientData) returns (uint256 returnAmount, uint256 gasUsed)",
])

export const v3Single = (a: {
  tokenIn: string
  tokenOut: string
  recipient: string
  amountIn: bigint
  minimum?: bigint
}): Hex =>
  encodeFunctionData({
    abi: v3Abi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: a.tokenIn as Address,
        tokenOut: a.tokenOut as Address,
        fee: 3000,
        recipient: a.recipient as Address,
        amountIn: a.amountIn,
        amountOutMinimum: a.minimum ?? 123456n,
        sqrtPriceLimitX96: 0n,
      },
    ],
  })

export const v3Path = (a: { tokens: string[]; recipient: string; amountIn: bigint; minimum?: bigint }): Hex => {
  const path = `0x${a.tokens.map((t, i) => `${i ? "000bb8" : ""}${t.slice(2)}`).join("")}` as Hex
  return encodeFunctionData({
    abi: v3Abi,
    functionName: "exactInput",
    args: [{ path, recipient: a.recipient as Address, amountIn: a.amountIn, amountOutMinimum: a.minimum ?? 123456n }],
  })
}

export const v3Unwrap = (recipient: string, minimum = 123456n): Hex =>
  encodeFunctionData({ abi: v3Abi, functionName: "unwrapWETH9", args: [minimum, recipient as Address] })
export const v3Refund = (): Hex => encodeFunctionData({ abi: v3Abi, functionName: "refundETH" })
export const v3Multicall = (calls: Hex[]): Hex =>
  encodeFunctionData({ abi: v3Abi, functionName: "multicall", args: [DEADLINE, calls] })

/** A token sell on SwapRouter02, as the planner builds it: swap to the router, unwrap to the wallet. */
export const v3Sell = (token: string, amountIn: bigint, wallet: string): Hex =>
  v3Multicall([
    v3Single({ tokenIn: token, tokenOut: HOOD_WETH_ADDRESS, recipient: ADDRESS_THIS, amountIn }),
    v3Unwrap(wallet),
  ])
/** An ETH buy on SwapRouter02: WETH in off `msg.value`, the token to the wallet, dust refunded. */
export const v3Buy = (token: string, amountIn: bigint, wallet: string): Hex =>
  v3Multicall([v3Single({ tokenIn: HOOD_WETH_ADDRESS, tokenOut: token, recipient: wallet, amountIn }), v3Refund()])

const v4PoolKey = (token: string) => {
  const [currency0, currency1] = [NATIVE, token as Address]
  return { currency0, currency1, fee: 3000, tickSpacing: 60, hooks: NATIVE }
}
export const SWAP_PARAMS = parseAbiParameters(
  "((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData) params",
)
export const ACTIONS = parseAbiParameters("bytes actions, bytes[] params")
export const CURRENCY_AMOUNT = parseAbiParameters("address currency, uint256 amount")

/** A direct v4 swap: native ETH <-> `token`. `zeroForOne` true is the buy (ETH in). */
export function v4Direct(a: {
  token: string
  zeroForOne: boolean
  amountIn: bigint
  settleCurrency?: string
  takeCurrency?: string
  minimum?: bigint
  takeMinimum?: bigint
}): Hex {
  const key = v4PoolKey(a.token)
  const input = a.zeroForOne ? key.currency0 : key.currency1
  const output = a.zeroForOne ? key.currency1 : key.currency0
  const input0 = encodeAbiParameters(ACTIONS, [
    "0x060c0f",
    [
      encodeAbiParameters(SWAP_PARAMS, [
        {
          poolKey: key,
          zeroForOne: a.zeroForOne,
          amountIn: a.amountIn,
          amountOutMinimum: a.minimum ?? 123456n,
          minHopPriceX36: 0n,
          hookData: "0x",
        },
      ]),
      encodeAbiParameters(CURRENCY_AMOUNT, [(a.settleCurrency ?? input) as Address, a.amountIn]),
      encodeAbiParameters(CURRENCY_AMOUNT, [(a.takeCurrency ?? output) as Address, a.takeMinimum ?? 123456n]),
    ],
  ])
  return encodeFunctionData({ abi: urAbi, functionName: "execute", args: ["0x10", [input0], DEADLINE] })
}

/** A Universal Router call with arbitrary commands, for shapes the checker must refuse. */
export const v4Raw = (commands: Hex, inputs: Hex[]): Hex =>
  encodeFunctionData({ abi: urAbi, functionName: "execute", args: [commands, inputs, DEADLINE] })

export function kyberSwap(a: {
  srcToken?: string
  dstToken?: string
  minimum?: bigint
  srcReceivers?: string[]
  generic?: boolean
  dstReceiver: string
  amount: bigint
  srcAmounts?: bigint[]
  feeReceivers?: string[]
  feeAmounts?: bigint[]
  simple?: boolean
}): Hex {
  const desc = {
    srcToken: (a.srcToken ?? KYBER_NATIVE) as Address,
    dstToken: (a.dstToken ?? (a.srcToken ? KYBER_NATIVE : HOOD_USDG_ADDRESS)) as Address,
    srcReceivers: (a.srcReceivers ?? [ADDRESS_THIS]) as Address[],
    srcAmounts: a.srcAmounts ?? [a.amount],
    feeReceivers: (a.feeReceivers ?? []) as Address[],
    feeAmounts: a.feeAmounts ?? (a.feeReceivers ?? []).map(() => 0n),
    dstReceiver: a.dstReceiver as Address,
    amount: a.amount,
    minReturnAmount: a.minimum ?? 123456n,
    flags: 0n,
    permit: "0x" as Hex,
  }
  return a.simple
    ? encodeFunctionData({ abi: kyberAbi, functionName: "swapSimpleMode", args: [ADDRESS_THIS, desc, "0x", "0x"] })
    : encodeFunctionData({
        abi: kyberAbi,
        functionName: a.generic ? "swapGeneric" : "swap",
        args: [{ callTarget: ADDRESS_THIS, approveTarget: ADDRESS_THIS, targetData: "0x1234", desc, clientData: "0x" }],
      })
}
