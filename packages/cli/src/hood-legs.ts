/**
 * What a Hood TEE wallet's sequenced legs may do, checked before each one is signed (D4).
 *
 * A key-signer wallet is owned by the local key: Candle's server cannot sign for it, so these
 * checks are the boundary against a server build that offers a leg the user never confirmed. Each
 * leg's `to`, `value` and `data` are decoded and held to what the CLI itself knows: the contracts
 * pinned here, the amount the user typed, and the fee the quote showed.
 *
 * Every address is pinned in code rather than read from Candle, as `relay-constants.ts` pins Relay's.
 * The routers and Permit2 are the defaults in `packages/shared/src/hood-dex.ts` (the server's own
 * planner reads them there), and the factory is the live launch stack in `docs/contracts.md`.
 * `hood-legs.test.ts` diffs both. A move of any of them is a PR to this file. What those pinned
 * contracts hold is read from them over the user's RPC: the treasury a fee leg pays, the curve a
 * token trades on, and the curve a launch's own `createCurve` made.
 */
import type { EvmReceipt, EvmRpc } from "./evm-lite"
import {
  bytesToHex,
  decodeErc20Transfer,
  HOOD_USDG_ADDRESS,
  HOOD_WETH_ADDRESS,
  hexToBytes,
  sameEvmAddress,
} from "./evm-lite"

/** `CandleCurveFactory`, launch stack v2 (cutover 2026-09-15): every new Hood curve's `createCurve`. */
export const HOOD_CURVE_FACTORY = "0xD08f8489F026957EdeD3Bb8Ef8A9d151A7B1DF22"
/**
 * `CandleCurveRegistry` of each of the three live launch stacks, newest first: every curve keeps
 * trading through the stack that created it. `curveForBaseToken(token)` names the curve the
 * factory created for a token; only the factory can write it.
 */
export const HOOD_CURVE_REGISTRIES: readonly string[] = [
  "0xb789E2711445488407c120563B29dF7c376cC9Ea",
  "0x75934c16162075583435358f9F042D8D6E42Bd5C",
  "0xFD54D094ad93349CA316bA309A3C8573E3D6C0cd",
]
export const HOOD_UNIV3_ROUTER = "0xCaf681a66D020601342297493863E78C959E5cb2"
export const HOOD_V4_UNIVERSAL_ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904"
export const HOOD_KYBER_ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5"
export const HOOD_PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3"
/** `CandleFeeSplitterFactory` of the newest launch stack: the factory `HOOD_CURVE_FACTORY` vouches splitters through. */
export const HOOD_SPLITTER_FACTORY = "0x9318bD328Ac32DBAe08bbD85B634E6B6B06683BF"
/** Kyber's sentinel for the chain's native asset inside `SwapDescriptionV2`. */
const KYBER_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"
/** SwapRouter02's and the Universal Router's "the router itself" recipient sentinel. */
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002"

/** The spenders a DEX approval may name: a router that pulls the input, or Permit2 for a v4 sell. */
const DEX_SPENDERS = [HOOD_UNIV3_ROUTER, HOOD_KYBER_ROUTER, HOOD_PERMIT2]

/**
 * `createCurve((...InitParams), uint8, uint16, bytes32)` on the launch stack v2 factory, whose
 * `InitParams` carries `tokenDeployer` third (seven addresses before the uint16). The pre-v2 six-address
 * shape was `0xe5ab9610`, which this factory does not have. `scripts/check-cli-hood-pins.test.ts`
 * holds this to the factory ABI the API encodes with.
 */
export const CREATE_CURVE_SELECTOR = "0x7cf8ad31"
/** ERC-20 `approve(address,uint256)`. */
export const ERC20_APPROVE_SELECTOR = "0x095ea7b3"
/** Permit2 `approve(address token, address spender, uint160 amount, uint48 expiration)`. */
export const PERMIT2_APPROVE_SELECTOR = "0x87517c45"
/** `CandleCurve.buy(uint256 minAmountOut)`, paid in ETH. */
export const CURVE_BUY_SELECTOR = "0xd96a094a"
/** `CandleCurve.buyWithQuote(uint256 quoteIn, uint256 minAmountOut)`. */
export const CURVE_BUY_WITH_QUOTE_SELECTOR = "0x6818735c"
/** `CandleCurve.sell(uint256 baseIn, uint256 minAmountOut)`. */
export const CURVE_SELL_SELECTOR = "0xd79875eb"
/** SwapRouter02 `multicall(uint256 deadline, bytes[] data)`. */
export const V3_MULTICALL_SELECTOR = "0x5ae401dc"
export const V3_EXACT_INPUT_SINGLE_SELECTOR = "0x04e45aaf"
export const V3_EXACT_INPUT_SELECTOR = "0xb858183f"
export const V3_UNWRAP_WETH9_SELECTOR = "0x49404b7c"
export const V3_REFUND_ETH_SELECTOR = "0x12210e8a"
/** Universal Router `execute(bytes commands, bytes[] inputs, uint256 deadline)`. */
export const UNIVERSAL_EXECUTE_SELECTOR = "0x3593564c"
/** Kyber MetaAggregationRouterV2 `swap`, `swapGeneric` (one `SwapExecutionParams`) and `swapSimpleMode`. */
export const KYBER_SWAP_SELECTOR = "0xe21fd0e9"
export const KYBER_SWAP_GENERIC_SELECTOR = "0x59e50fed"
export const KYBER_SWAP_SIMPLE_SELECTOR = "0x8af033fb"
/** `CandleFeeSplitter.dev()` and `CandleFeeSplitterFactory.isSplitter(address)`. */
export const SPLITTER_DEV_SELECTOR = "0x91cca3db"
export const SPLITTER_IS_SPLITTER_SELECTOR = "0xa4c597d1"
/** `CandleCurveRegistry.curveForBaseToken(address)`. */
const CURVE_FOR_BASE_TOKEN_SELECTOR = "0x446b9253"
/** `CandleFeeSplitterFactory.platformVault()`. */
export const SPLITTER_PLATFORM_VAULT_SELECTOR = "0x20f094f8"
/** `CandleCurveFactory`'s `CurveCreated(address indexed curve, address indexed baseToken, address indexed creator, uint8, bytes32, bytes32)`. */
export const CURVE_CREATED_TOPIC = "0xed3a740542131b3621499825e40efbcaf096e3b1608de865c08a2109378bb36b"

/**
 * The most a launch's fee leg may carry, in basis points of the first buy. The server clamps every
 * tier's fee to 0..1000 bps (`parseAgentFeeBps`); a Hood TEE launch's build does not echo the fee,
 * so this ceiling is what the quote shows and what the leg is held to.
 */
export const LAUNCH_FEE_MAX_BPS = 1000n

type LegKind = "approval" | "permit2Approval" | "trade" | "feeTransfer" | "createCurve" | string
interface Leg {
  to: string
  data: string
  value: string
}

function bytesOf(hex: string): Uint8Array | undefined {
  try {
    return hexToBytes(hex)
  } catch {
    return undefined
  }
}

function selectorOf(data: Uint8Array): string {
  return data.length < 4 ? "" : bytesToHex(data.subarray(0, 4))
}

/** The `index`th 32-byte word from `base` (just past the selector by default), or undefined past the end. */
function word(data: Uint8Array, index: number, base = 4): Uint8Array | undefined {
  const start = base + index * 32
  return start + 32 <= data.length ? data.subarray(start, start + 32) : undefined
}

function wordUint(w: Uint8Array | undefined): bigint | undefined {
  return w === undefined ? undefined : BigInt(bytesToHex(w))
}

/** An ABI-encoded address word: twelve zero bytes, then the address. */
function wordAddress(w: Uint8Array | undefined): string | undefined {
  if (w === undefined || w.subarray(0, 12).some((b) => b !== 0)) return undefined
  return bytesToHex(w.subarray(12))
}

function isDecimal(value: string): boolean {
  return /^\d+$/.test(value)
}

function among(address: string, list: readonly string[]): boolean {
  return list.some((known) => sameEvmAddress(address, known))
}

/** Decodes `approve(spender, amount)`: exactly a selector and two words. */
function decodeApprove(data: Uint8Array): { spender: string; amount: bigint } | undefined {
  if (data.length !== 68 || selectorOf(data) !== ERC20_APPROVE_SELECTOR) return undefined
  const spender = wordAddress(word(data, 0))
  const amount = wordUint(word(data, 1))
  return spender === undefined || amount === undefined ? undefined : { spender, amount }
}

type AbiType = "address" | "uint" | "bool" | "bytes" | { array: AbiType } | { tuple: AbiType[] }
type AbiValue = string | bigint | boolean | Uint8Array | AbiValue[]

/** Arrays longer than any real swap are refused rather than walked. */
const MAX_ABI_ARRAY = 64

function isDynamicType(type: AbiType): boolean {
  if (typeof type === "string") return type === "bytes"
  return "array" in type || type.tuple.some(isDynamicType)
}

function headSize(type: AbiType): number {
  return typeof type === "object" && "tuple" in type && !isDynamicType(type)
    ? type.tuple.reduce((sum, member) => sum + headSize(member), 0)
    : 32
}

function readWord(data: Uint8Array, position: number): Uint8Array {
  if (!Number.isSafeInteger(position) || position < 0 || position + 32 > data.length) throw new Error("abi: short data")
  return data.subarray(position, position + 32)
}

function readNumber(data: Uint8Array, position: number): number {
  const value = BigInt(bytesToHex(readWord(data, position)))
  if (value > BigInt(data.length)) throw new Error("abi: offset past the data")
  return Number(value)
}

function decodeAbiTuple(data: Uint8Array, start: number, types: readonly AbiType[]): AbiValue[] {
  const out: AbiValue[] = []
  let cursor = start
  for (const type of types) {
    if (isDynamicType(type)) {
      out.push(decodeAbiDynamic(data, start + readNumber(data, cursor), type))
      cursor += 32
    } else {
      out.push(decodeAbiStatic(data, cursor, type))
      cursor += headSize(type)
    }
  }
  return out
}

function decodeAbiStatic(data: Uint8Array, position: number, type: AbiType): AbiValue {
  if (typeof type === "object" && "tuple" in type) return decodeAbiTuple(data, position, type.tuple)
  const w = readWord(data, position)
  if (type === "address") {
    const address = wordAddress(w)
    if (address === undefined) throw new Error("abi: dirty address")
    return address
  }
  if (type === "bool") return BigInt(bytesToHex(w)) === 1n
  return BigInt(bytesToHex(w))
}

function decodeAbiDynamic(data: Uint8Array, position: number, type: AbiType): AbiValue {
  if (type === "bytes") {
    const length = readNumber(data, position)
    if (position + 32 + length > data.length) throw new Error("abi: short bytes")
    return data.subarray(position + 32, position + 32 + length)
  }
  if (typeof type === "object" && "array" in type) {
    const length = readNumber(data, position)
    if (length > MAX_ABI_ARRAY) throw new Error("abi: array too long")
    return decodeAbiTuple(
      data,
      position + 32,
      Array.from({ length }, () => type.array),
    )
  }
  return decodeAbiTuple(data, position, (type as { tuple: AbiType[] }).tuple)
}

/** The arguments of a call after its 4-byte selector; undefined when they do not fit `types`. */
function decodeArgs(data: Uint8Array, types: readonly AbiType[], base = 4): AbiValue[] | undefined {
  try {
    return decodeAbiTuple(data, base, types)
  } catch {
    return undefined
  }
}

const V3_SINGLE: AbiType = { tuple: ["address", "address", "uint", "address", "uint", "uint", "uint"] }
const V3_PATH: AbiType = { tuple: ["bytes", "address", "uint", "uint"] }
const KYBER_DESC: AbiType = {
  tuple: [
    "address",
    "address",
    { array: "address" },
    { array: "uint" },
    { array: "address" },
    { array: "uint" },
    "address",
    "uint",
    "uint",
    "uint",
    "bytes",
  ],
}
const KYBER_EXECUTION: AbiType = { tuple: ["address", "address", "bytes", KYBER_DESC, "bytes"] }
const V4_POOL_KEY: AbiType = { tuple: ["address", "address", "uint", "uint", "address"] }
const V4_SWAP_PARAMS: AbiType = { tuple: [V4_POOL_KEY, "bool", "uint", "uint", "uint", "bytes"] }

/** The confirmed assets, amounts and recipient a decoded router call must enforce. */
type DexTerms = Pick<HoodTradeTerms, "wallet" | "inputToken" | "outputToken" | "amountRaw" | "minOutRaw">

const asBytes = (value: AbiValue | undefined) => value as Uint8Array
const asAddress = (value: AbiValue | undefined) => value as string
const asNumber = (value: AbiValue | undefined) => value as bigint
const asList = (value: AbiValue | undefined) => value as AbiValue[]

/** The token a router's first hop must take in: the ERC-20 itself, or WETH for ETH. */
const routedInput = (terms: DexTerms) => terms.inputToken ?? HOOD_WETH_ADDRESS
const routedOutput = (terms: DexTerms) => terms.outputToken ?? HOOD_WETH_ADDRESS

/** The assets, input amount, output minimum and recipient of one SwapRouter02 swap. */
function v3SwapOf(
  call: Uint8Array,
): { tokenIn: string; tokenOut: string; amountIn: bigint; minimum: bigint; recipient: string } | undefined {
  const selector = selectorOf(call)
  if (selector === V3_EXACT_INPUT_SINGLE_SELECTOR) {
    const args = decodeArgs(call, [V3_SINGLE])
    if (!args) return undefined
    const fields = asList(args[0])
    return {
      tokenIn: asAddress(fields[0]),
      tokenOut: asAddress(fields[1]),
      amountIn: asNumber(fields[4]),
      minimum: asNumber(fields[5]),
      recipient: asAddress(fields[3]),
    }
  }
  if (selector === V3_EXACT_INPUT_SELECTOR) {
    const args = decodeArgs(call, [V3_PATH])
    if (!args) return undefined
    const fields = asList(args[0])
    const path = asBytes(fields[0])
    // A v3 path is token (20 bytes), then fee (3) and token (20) per hop.
    if (path.length < 43 || (path.length - 20) % 23 !== 0) return undefined
    return {
      tokenIn: bytesToHex(path.subarray(0, 20)),
      tokenOut: bytesToHex(path.subarray(-20)),
      amountIn: asNumber(fields[2]),
      minimum: asNumber(fields[3]),
      recipient: asAddress(fields[1]),
    }
  }
  return undefined
}

/**
 * SwapRouter02: the deadline `multicall` the planner builds, of swap calls that spend the input
 * (summing to no more than confirmed) and pay the wallet, or the router when an `unwrapWETH9` to the
 * wallet follows, and an optional `refundETH`. Anything else in the batch is refused.
 */
function v3CallOk(data: Uint8Array, terms: DexTerms): boolean {
  if (selectorOf(data) !== V3_MULTICALL_SELECTOR) return false
  const args = decodeArgs(data, ["uint", { array: "bytes" }])
  if (!args) return false
  const calls = asList(args[1]).map(asBytes)
  if (calls.length === 0 || calls.length > 4) return false
  let swaps = 0
  let spent = 0n
  let heldByRouter = false
  let unwrappedToWallet = false
  for (const call of calls) {
    const selector = selectorOf(call)
    if (selector === V3_REFUND_ETH_SELECTOR) {
      if (call.length !== 4) return false
    } else if (selector === V3_UNWRAP_WETH9_SELECTOR) {
      const unwrap = decodeArgs(call, ["uint", "address"])
      if (
        !unwrap ||
        terms.outputToken !== undefined ||
        !heldByRouter ||
        unwrappedToWallet ||
        asNumber(unwrap[0]) < terms.minOutRaw ||
        !sameEvmAddress(asAddress(unwrap[1]), terms.wallet)
      )
        return false
      unwrappedToWallet = true
    } else {
      const swap = v3SwapOf(call)
      if (
        !swap ||
        unwrappedToWallet ||
        !sameEvmAddress(swap.tokenIn, routedInput(terms)) ||
        !sameEvmAddress(swap.tokenOut, routedOutput(terms)) ||
        swap.minimum < terms.minOutRaw ||
        !sameEvmAddress(swap.recipient, terms.outputToken === undefined ? ADDRESS_THIS : terms.wallet)
      )
        return false
      if (!sameEvmAddress(swap.recipient, terms.wallet)) heldByRouter = true
      swaps++
      spent += swap.amountIn
    }
  }
  return swaps > 0 && spent <= terms.amountRaw && (!heldByRouter || unwrappedToWallet)
}

const UR_V3_SWAP_EXACT_IN = 0x00
const UR_WRAP_ETH = 0x0b
const UR_UNWRAP_WETH = 0x0c
const UR_V4_SWAP = 0x10
const V4_SWAP_EXACT_IN_SINGLE = 0x06
const V4_SETTLE = 0x0b
const V4_SETTLE_ALL = 0x0c
const V4_TAKE = 0x0e
const V4_TAKE_ALL = 0x0f
const NATIVE_CURRENCY = "0x0000000000000000000000000000000000000000"

function bytesAre(bytes: Uint8Array, expected: readonly number[]): boolean {
  return bytes.length === expected.length && expected.every((byte, i) => bytes[i] === byte)
}

/** The pool's input and output currency for the swap direction. */
function v4Sides(params: AbiValue[]): { input: string; output: string } {
  const key = asList(params[0])
  const zeroForOne = params[1] === true
  return { input: asAddress(zeroForOne ? key[0] : key[1]), output: asAddress(zeroForOne ? key[1] : key[0]) }
}

/** A v4 input currency matching the confirmed one: the native currency for ETH, else the token. */
function v4InputIs(currency: string, terms: DexTerms): boolean {
  return sameEvmAddress(currency, terms.inputToken ?? NATIVE_CURRENCY)
}

/**
 * Universal Router `execute`, in the two shapes the planner builds. Direct: one V4_SWAP of
 * SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL (TAKE_ALL pays the caller). Bridged: WRAP_ETH, a v3
 * swap into the router and a V4_SWAP on a buy; V4_SWAP, a v3 swap into the router and UNWRAP_WETH to
 * the wallet on a sell. The input is the confirmed one, no more than confirmed is pulled from the
 * wallet, and every payout goes to the wallet or stays in the router for the next command.
 */
function v4CallOk(data: Uint8Array, terms: DexTerms): boolean {
  if (selectorOf(data) !== UNIVERSAL_EXECUTE_SELECTOR) return false
  const args = decodeArgs(data, ["bytes", { array: "bytes" }, "uint"])
  if (!args) return false
  const commands = asBytes(args[0])
  const inputs = asList(args[1]).map(asBytes)
  try {
    if (bytesAre(commands, [UR_V4_SWAP]) && inputs.length === 1) return v4DirectOk(inputs[0] as Uint8Array, terms)
    if (bytesAre(commands, [UR_WRAP_ETH, UR_V3_SWAP_EXACT_IN, UR_V4_SWAP]) && inputs.length === 3)
      return v4BridgedBuyOk(inputs as [Uint8Array, Uint8Array, Uint8Array], terms)
    if (bytesAre(commands, [UR_V4_SWAP, UR_V3_SWAP_EXACT_IN, UR_UNWRAP_WETH]) && inputs.length === 3)
      return v4BridgedSellOk(inputs as [Uint8Array, Uint8Array, Uint8Array], terms)
  } catch {
    return false
  }
  return false
}

function v4DirectOk(input: Uint8Array, terms: DexTerms): boolean {
  const top = decodeArgs(input, ["bytes", { array: "bytes" }], 0)
  if (!top || !bytesAre(asBytes(top[0]), [V4_SWAP_EXACT_IN_SINGLE, V4_SETTLE_ALL, V4_TAKE_ALL])) return false
  const params = asList(top[1]).map(asBytes)
  if (params.length !== 3) return false
  const swap = decodeArgs(params[0] as Uint8Array, [V4_SWAP_PARAMS], 0)
  const settle = decodeArgs(params[1] as Uint8Array, ["address", "uint"], 0)
  const take = decodeArgs(params[2] as Uint8Array, ["address", "uint"], 0)
  if (!swap || !settle || !take) return false
  const fields = asList(swap[0])
  const { input: inCurrency, output: outCurrency } = v4Sides(fields)
  return (
    v4InputIs(inCurrency, terms) &&
    sameEvmAddress(outCurrency, terms.outputToken ?? NATIVE_CURRENCY) &&
    asNumber(fields[3]) >= terms.minOutRaw &&
    asNumber(take[1]) >= terms.minOutRaw &&
    asNumber(fields[2]) <= terms.amountRaw &&
    sameEvmAddress(asAddress(settle[0]), inCurrency) &&
    asNumber(settle[1]) <= terms.amountRaw &&
    sameEvmAddress(asAddress(take[0]), outCurrency)
  )
}

function v3IntoRouterOk(input: Uint8Array, firstToken: string, lastToken: string): boolean {
  const args = decodeArgs(input, ["address", "uint", "uint", "bytes", "bool"], 0)
  if (!args) return false
  const path = asBytes(args[3])
  return (
    sameEvmAddress(asAddress(args[0]), ADDRESS_THIS) &&
    args[4] === false &&
    path.length >= 43 &&
    (path.length - 20) % 23 === 0 &&
    sameEvmAddress(bytesToHex(path.subarray(0, 20)), firstToken) &&
    sameEvmAddress(bytesToHex(path.subarray(-20)), lastToken)
  )
}

function v4BridgedBuyOk([wrap, v3, v4]: [Uint8Array, Uint8Array, Uint8Array], terms: DexTerms): boolean {
  if (terms.inputToken !== undefined || terms.outputToken === undefined) return false
  const wrapped = decodeArgs(wrap, ["address", "uint"], 0)
  if (!wrapped || !sameEvmAddress(asAddress(wrapped[0]), ADDRESS_THIS) || asNumber(wrapped[1]) > terms.amountRaw)
    return false
  const top = decodeArgs(v4, ["bytes", { array: "bytes" }], 0)
  if (!top || !bytesAre(asBytes(top[0]), [V4_SETTLE, V4_SWAP_EXACT_IN_SINGLE, V4_TAKE_ALL])) return false
  const params = asList(top[1]).map(asBytes)
  if (params.length !== 3) return false
  // The settle draws on the router's own balance (payerIsUser false), never the wallet's.
  const settle = decodeArgs(params[0] as Uint8Array, ["address", "uint", "bool"], 0)
  const swap = decodeArgs(params[1] as Uint8Array, [V4_SWAP_PARAMS], 0)
  const take = decodeArgs(params[2] as Uint8Array, ["address", "uint"], 0)
  if (!settle || !swap || !take || settle[2] !== false) return false
  const fields = asList(swap[0])
  const { input, output } = v4Sides(fields)
  return (
    v3IntoRouterOk(v3, HOOD_WETH_ADDRESS, input) &&
    sameEvmAddress(output, terms.outputToken) &&
    asNumber(fields[3]) >= terms.minOutRaw &&
    asNumber(take[1]) >= terms.minOutRaw &&
    sameEvmAddress(asAddress(settle[0]), input) &&
    sameEvmAddress(asAddress(take[0]), output)
  )
}

function v4BridgedSellOk([v4, v3, unwrap]: [Uint8Array, Uint8Array, Uint8Array], terms: DexTerms): boolean {
  if (terms.inputToken === undefined || terms.outputToken !== undefined) return false
  const top = decodeArgs(v4, ["bytes", { array: "bytes" }], 0)
  if (!top || !bytesAre(asBytes(top[0]), [V4_SETTLE, V4_SWAP_EXACT_IN_SINGLE, V4_TAKE])) return false
  const params = asList(top[1]).map(asBytes)
  if (params.length !== 3) return false
  const settle = decodeArgs(params[0] as Uint8Array, ["address", "uint", "bool"], 0)
  const swap = decodeArgs(params[1] as Uint8Array, [V4_SWAP_PARAMS], 0)
  const take = decodeArgs(params[2] as Uint8Array, ["address", "address", "uint"], 0)
  if (!settle || !swap || !take) return false
  const { input, output } = v4Sides(asList(swap[0]))
  if (
    !v4InputIs(input, terms) ||
    !sameEvmAddress(asAddress(settle[0]), input) ||
    asNumber(settle[1]) > terms.amountRaw ||
    settle[2] !== true ||
    // A v4 TAKE does not map the router sentinel: the proceeds stay in the router itself.
    !sameEvmAddress(asAddress(take[0]), output) ||
    !sameEvmAddress(asAddress(take[1]), HOOD_V4_UNIVERSAL_ROUTER)
  )
    return false
  if (!v3IntoRouterOk(v3, output, HOOD_WETH_ADDRESS)) return false
  const unwrapped = decodeArgs(unwrap, ["address", "uint"], 0)
  return (
    unwrapped !== undefined &&
    asNumber(unwrapped[1]) >= terms.minOutRaw &&
    sameEvmAddress(asAddress(unwrapped[0]), terms.wallet)
  )
}

/**
 * Kyber's router, the three swap entry points: the description names the input token (the native
 * sentinel for ETH), the output token and minimum, pays the wallet, takes exactly the input,
 * spreads it over the source receivers without exceeding it, and carries no fee receivers or permit.
 */
function kyberCallOk(data: Uint8Array, terms: DexTerms): boolean {
  const selector = selectorOf(data)
  let desc: AbiValue[] | undefined
  if (selector === KYBER_SWAP_SELECTOR || selector === KYBER_SWAP_GENERIC_SELECTOR) {
    const args = decodeArgs(data, [KYBER_EXECUTION])
    desc = args && asList(asList(args[0])[3])
  } else if (selector === KYBER_SWAP_SIMPLE_SELECTOR) {
    const args = decodeArgs(data, ["address", KYBER_DESC, "bytes", "bytes"])
    desc = args && asList(args[1])
  }
  if (!desc) return false
  const amount = asNumber(desc[7])
  return (
    sameEvmAddress(asAddress(desc[0]), terms.inputToken ?? KYBER_NATIVE) &&
    sameEvmAddress(asAddress(desc[1]), terms.outputToken ?? KYBER_NATIVE) &&
    asNumber(desc[8]) >= terms.minOutRaw &&
    sameEvmAddress(asAddress(desc[6]), terms.wallet) &&
    amount === terms.amountRaw &&
    asList(desc[3]).reduce((sum: bigint, part) => sum + asNumber(part), 0n) <= amount &&
    asList(desc[4]).length === 0 &&
    asList(desc[5]).every((part) => asNumber(part) === 0n) &&
    asBytes(desc[10]).length === 0
  )
}

/**
 * A DEX router call, decoded and held to the confirmed input and output assets, input ceiling,
 * output floor and recipient. A router pulls with `transferFrom`
 * against any allowance the wallet already has (an exact-amount one left by a reverted sell, a
 * MAX_UINT256 grant from before 2026-09-03, a live Permit2 grant), so `to` and `value` alone do not
 * bound what a call can take. A call this does not decode is refused.
 */
function dexCallOk(to: string, data: Uint8Array, terms: DexTerms): boolean {
  if (sameEvmAddress(to, HOOD_UNIV3_ROUTER)) return v3CallOk(data, terms)
  if (sameEvmAddress(to, HOOD_V4_UNIVERSAL_ROUTER)) return v4CallOk(data, terms)
  if (sameEvmAddress(to, HOOD_KYBER_ROUTER)) return kyberCallOk(data, terms)
  return false
}

/**
 * A launch's `createCurve` leg: the pinned factory, no ETH (the factory is not payable), the
 * `createCurve` selector, the wallet itself as the curve's `creator` (the sixth field of the init
 * tuple, which the factory also requires to be `msg.sender`), and a `feeRecipient` (the fourth
 * field) that is a splitter the pinned splitter factory vouches for and whose `dev` is the wallet:
 * `createSplitter` is permissionless, so a splitter alone does not say who collects the creator's
 * share of the token's trading fees for its whole life.
 */
export async function createCurveLegOk(leg: Leg, wallet: string, rpc: EvmRpc): Promise<boolean> {
  if (leg.value !== "0" || !sameEvmAddress(leg.to, HOOD_CURVE_FACTORY)) return false
  const data = bytesOf(leg.data)
  if (!data || selectorOf(data) !== CREATE_CURVE_SELECTOR) return false
  // The tuple is dynamic (it holds strings), so its head sits at the offset in the first word.
  const offset = wordUint(word(data, 0))
  if (offset === undefined || offset % 32n !== 0n || offset > BigInt(data.length)) return false
  const creator = wordAddress(word(data, 5, 4 + Number(offset)))
  if (creator === undefined || !sameEvmAddress(creator, wallet)) return false
  const splitter = wordAddress(word(data, 3, 4 + Number(offset)))
  if (splitter === undefined) return false
  try {
    const vouched = await rpc.call({
      to: HOOD_SPLITTER_FACTORY,
      data: hexToBytes(`${SPLITTER_IS_SPLITTER_SELECTOR}${"0".repeat(24)}${splitter.slice(2)}`),
    })
    if (wordUint(word(vouched, 0, 0)) !== 1n) return false
    const dev = wordAddress(word(await rpc.call({ to: splitter, data: hexToBytes(SPLITTER_DEV_SELECTOR) }), 0, 0))
    return dev !== undefined && sameEvmAddress(dev, wallet)
  } catch {
    return false
  }
}

/** The ceiling a launch's fee leg is held to: `LAUNCH_FEE_MAX_BPS` of the first buy, rounded up. */
export function launchFeeCap(buyRaw: string): bigint {
  return (BigInt(buyRaw) * LAUNCH_FEE_MAX_BPS + 9999n) / 10000n
}

/**
 * A fee leg: no more than `cap`, in the asset the trade settles in, to `treasury` and nowhere else.
 * ETH is a plain transfer (empty data); USDG is exactly `transfer(recipient, amount)` on the USDG
 * contract with no ETH. The treasury is `hoodFeeTreasury`'s, never the build's.
 */
export function feeLegOk(leg: Leg, fee: { cap: bigint; asset: "eth" | "usdg"; treasury: string }): boolean {
  if (!isDecimal(leg.value)) return false
  if (fee.asset === "eth") {
    if (leg.data !== "0x" && leg.data !== "") return false
    if (BigInt(leg.value) > fee.cap) return false
    return sameEvmAddress(leg.to, fee.treasury)
  }
  if (leg.value !== "0" || !sameEvmAddress(leg.to, HOOD_USDG_ADDRESS)) return false
  const data = bytesOf(leg.data)
  const decoded = data ? decodeErc20Transfer(data) : undefined
  if (!decoded || decoded.amount > fee.cap) return false
  return sameEvmAddress(decoded.recipient, fee.treasury)
}

/**
 * Candle's fee treasury on Hood, as the chain names it: `platformVault()` on the pinned splitter
 * factory, the Safe that takes the platform half of every curve's trading fees. The API pays every
 * Hood agent fee to that same Safe (`AGENT_FEE_TREASURY_HOOD`, 0x0ed31DBF... on staging and on
 * production, read from both environments' landed fee legs on 2026-10-16). Only the Safe can move
 * it, so no server build can. Undefined when the RPC cannot answer, which refuses the fee leg.
 */
export async function hoodFeeTreasury(rpc: EvmRpc): Promise<string | undefined> {
  try {
    const answer = await rpc.call({ to: HOOD_SPLITTER_FACTORY, data: hexToBytes(SPLITTER_PLATFORM_VAULT_SELECTOR) })
    const vault = wordAddress(word(answer, 0, 0))
    return vault !== undefined && BigInt(vault) !== 0n ? vault : undefined
  } catch {
    return undefined
  }
}

/**
 * The curve a launch's own `createCurve` made, read from that transaction's receipt: the one
 * `CurveCreated` the pinned factory logged, naming `wallet` as the creator. The hash is the one the
 * CLI computed from the bytes it had signed, never one Candle reports, so an earlier curve of this
 * wallet's cannot stand in. Undefined for a missing or reverted receipt, or any other log shape.
 */
export function curveCreatedBy(receipt: EvmReceipt | null, wallet: string): string | undefined {
  if (!receipt || receipt.status !== 1) return undefined
  const created = (receipt.logs ?? []).filter(
    (log) => sameEvmAddress(log.address, HOOD_CURVE_FACTORY) && log.topics[0]?.toLowerCase() === CURVE_CREATED_TOPIC,
  )
  if (created.length !== 1) return undefined
  const topics = (created[0] as { topics: string[] }).topics
  const topicAddress = (topic: string | undefined) => {
    const bytes = topic === undefined ? undefined : bytesOf(topic)
    return bytes?.length === 32 ? wordAddress(bytes) : undefined
  }
  const curve = topicAddress(topics[1])
  const creator = topicAddress(topics[3])
  if (curve === undefined || BigInt(curve) === 0n || creator === undefined) return undefined
  return sameEvmAddress(creator, wallet) ? curve : undefined
}

/**
 * A launch's buy leg: exactly `buy(minAmountOut)` on the curve this launch created, carrying exactly
 * the confirmed amount. The curve pays `msg.sender`, so the tokens come to the wallet.
 */
export function launchBuyLegOk(leg: Leg, buyRaw: string, curve: string): boolean {
  const data = bytesOf(leg.data)
  return (
    data !== undefined &&
    leg.value === buyRaw &&
    sameEvmAddress(leg.to, curve) &&
    data.length === 36 &&
    selectorOf(data) === CURVE_BUY_SELECTOR
  )
}

/** What a Hood trade or base swap confirmed, which every one of its legs is held to. */
export interface HoodTradeTerms {
  /** The TEE wallet that signs: every router call must pay its output here. */
  wallet: string
  /** The ERC-20 the trade spends, or undefined when it spends ETH. */
  inputToken?: string
  /** The confirmed ERC-20 received, or undefined for native ETH. */
  outputToken: string | undefined
  /** The build's on-chain output floor, before any separate fee transfer. */
  minOutRaw: bigint
  /** The confirmed input, in its base units. */
  amountRaw: bigint
  /** `curve` trades on a Candle curve, held to the registry's curve; anything else is a DEX router. */
  venue: "curve" | "dex"
  /** The fee the quote showed; undefined when the trade carries none, so any fee leg is refused. */
  fee?: { cap: bigint; asset: "eth" | "usdg" }
  /** Candle's treasury as the chain names it (`hoodFeeTreasury`). Called only for a fee leg, once. */
  treasury?: () => Promise<string | undefined>
  /** The curve the registry names for the traded token. Called only on the curve venue, once. */
  curve?: () => Promise<string | undefined>
}

/**
 * The leg check for a Hood trade or base swap. Approvals are an exact-shape `approve` of the
 * confirmed input token, for no more than the input, to a pinned router, Permit2 or the token's
 * registered curve. Permit2's own grant names the input token and the v4 Universal Router. The
 * trade goes to the registered curve, or to a pinned router with its calldata decoded and held to
 * the confirmed assets, input ceiling, output floor and wallet recipient. Undecoded calls are
 * refused. It carries ETH only when ETH is the input and never more than it. The fee is
 * `feeLegOk` against the quoted fee and the treasury the chain names; without one it is refused.
 */
export function hoodTradeLegCheck(terms: HoodTradeTerms): (kind: LegKind, leg: Leg) => Promise<boolean> {
  let curve: Promise<string | undefined> | undefined
  const registeredCurve = () => {
    curve ??= terms.curve ? terms.curve().catch(() => undefined) : Promise.resolve(undefined)
    return curve
  }
  let treasury: Promise<string | undefined> | undefined
  const chainTreasury = () => {
    treasury ??= terms.treasury ? terms.treasury().catch(() => undefined) : Promise.resolve(undefined)
    return treasury
  }
  const spenderOk = async (spender: string) => {
    if (terms.venue !== "curve") return among(spender, DEX_SPENDERS)
    const registered = await registeredCurve()
    return registered !== undefined && sameEvmAddress(spender, registered)
  }
  return async (kind, leg) => {
    if (!isDecimal(leg.value)) return false
    const data = bytesOf(leg.data)
    if (!data) return false
    if (kind === "feeTransfer") {
      if (terms.fee === undefined) return false
      const named = await chainTreasury()
      return named !== undefined && feeLegOk(leg, { ...terms.fee, treasury: named })
    }
    if (kind === "approval") {
      if (terms.inputToken === undefined || leg.value !== "0" || !sameEvmAddress(leg.to, terms.inputToken)) return false
      const approve = decodeApprove(data)
      return approve !== undefined && approve.amount <= terms.amountRaw && (await spenderOk(approve.spender))
    }
    if (kind === "permit2Approval") {
      if (terms.inputToken === undefined || terms.venue !== "dex" || leg.value !== "0") return false
      if (!sameEvmAddress(leg.to, HOOD_PERMIT2) || data.length !== 132) return false
      if (selectorOf(data) !== PERMIT2_APPROVE_SELECTOR) return false
      const token = wordAddress(word(data, 0))
      const spender = wordAddress(word(data, 1))
      const amount = wordUint(word(data, 2))
      return (
        token !== undefined &&
        sameEvmAddress(token, terms.inputToken) &&
        spender !== undefined &&
        sameEvmAddress(spender, HOOD_V4_UNIVERSAL_ROUTER) &&
        amount !== undefined &&
        amount <= terms.amountRaw
      )
    }
    if (kind !== "trade") return false
    const value = BigInt(leg.value)
    if (terms.inputToken !== undefined ? value !== 0n : value > terms.amountRaw) return false
    if (terms.venue === "dex")
      return dexCallOk(leg.to, data, {
        wallet: terms.wallet,
        ...(terms.inputToken !== undefined ? { inputToken: terms.inputToken } : {}),
        amountRaw: terms.amountRaw,
        outputToken: terms.outputToken,
        minOutRaw: terms.minOutRaw,
      })
    const registered = await registeredCurve()
    if (registered === undefined || !sameEvmAddress(leg.to, registered)) return false
    // The registry pins the traded token; curve entry points pay msg.sender and enforce this floor.
    const selector = selectorOf(data)
    if (terms.inputToken === undefined)
      return (
        selector === CURVE_BUY_SELECTOR && data.length === 36 && (wordUint(word(data, 0)) as bigint) >= terms.minOutRaw
      )
    if (data.length !== 68) return false
    const amountIn = wordUint(word(data, 0)) as bigint
    if (amountIn > terms.amountRaw || (wordUint(word(data, 1)) as bigint) < terms.minOutRaw) return false
    // USDG in is a buy on a USDG-quoted curve; any other token in is a sell of that token.
    return (
      selector ===
      (sameEvmAddress(terms.inputToken, HOOD_USDG_ADDRESS) ? CURVE_BUY_WITH_QUOTE_SELECTOR : CURVE_SELL_SELECTOR)
    )
  }
}

/**
 * The curve the factory created for `token`, read from each registry in turn: the only writer of
 * `curveForBaseToken` is the factory, so a curve named there is Candle's own for that token.
 * Undefined when no registry names one (a revert counts as none).
 */
export async function registeredCurveFor(rpc: EvmRpc, token: string): Promise<string | undefined> {
  const call = hexToBytes(`${CURVE_FOR_BASE_TOKEN_SELECTOR}${"0".repeat(24)}${token.toLowerCase().replace(/^0x/, "")}`)
  for (const registry of HOOD_CURVE_REGISTRIES) {
    let answer: Uint8Array
    try {
      answer = await rpc.call({ to: registry, data: call })
    } catch {
      continue
    }
    const curve = wordAddress(word(answer, 0, 0))
    if (curve !== undefined && BigInt(curve) !== 0n) return curve
  }
  return undefined
}
