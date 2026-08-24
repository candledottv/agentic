/**
 * Pure EVM transaction-assembly helpers for a Hood (EVM) linked wallet's one-shot flows
 * (trade()/selfLaunch()). Hood's build endpoints (POST /api/v1/trade/agent/build,
 * POST /api/v1/launch/self/build) return raw calldata legs -- a `{ to, data, value }` the SDK
 * must wrap into a full EIP-1559 transaction (nonce, chain id, gas limit, fee fields) before it
 * can be handed to signLinkedTransaction()'s `evmTxParams` and, from there, Privy's
 * `eth_signTransaction`.
 *
 * Every function here takes an injected `rpc: EvmRpc` seam instead of a URL, so each one
 * unit-tests against a faked rpc with no network. The real seam (Task 3) is
 * `{ call: (m, p) => this.jsonRpcCall(url, m, p), callRaw: (m, p) => this.jsonRpcCallRaw(url, m,
 * p) }` on CandleClient, closing over `evmRpcUrl`.
 *
 * All amounts are handled as BigInt end to end -- never floats -- and every RPC-bound quantity is
 * a minimal-length hex string (`0x0` for zero), per Ethereum's JSON-RPC "quantity" encoding.
 */
import type { EvmSignTransactionParams } from "./client";
/**
 * The EVM JSON-RPC seam these helpers depend on. `call` is for methods whose `result` is a hex
 * string (eth_getTransactionCount, eth_chainId, eth_estimateGas, eth_maxPriorityFeePerGas,
 * eth_gasPrice) -- mirrors CandleClient's private `jsonRpcCall`, which validates that shape.
 * `callRaw` is for methods whose `result` is an object or null (eth_getBlockByNumber,
 * eth_getTransactionReceipt) -- mirrors CandleClient's private `jsonRpcCallRaw`, which returns
 * `parsed.result` unchecked.
 */
export interface EvmRpc {
    call(method: string, params: unknown[]): Promise<string>;
    callRaw(method: string, params: unknown[]): Promise<unknown>;
}
/** A mined (or pending) transaction receipt, per eth_getTransactionReceipt. */
export interface EvmTransactionReceipt {
    status: string;
    [key: string]: unknown;
}
/** Parses a hex-quantity string ("0x..." or "0x0") into a BigInt. */
export declare function hexToBigInt(hex: string): bigint;
/** Formats a non-negative BigInt as a minimal-length hex quantity ("0x0" for zero, no padding). */
export declare function bigIntToHexQuantity(n: bigint): string;
/**
 * Converts a build leg's decimal `value` string (e.g. a dev-buy or trade amount in wei) to a hex
 * quantity via BigInt, never a float, so precision holds past Number.MAX_SAFE_INTEGER.
 */
export declare function decimalToHexQuantity(decimalString: string): string;
/** eth_getTransactionCount(from, "pending"), parsed to a number. */
export declare function fetchNonce(rpc: EvmRpc, from: string): Promise<number>;
/** eth_chainId, parsed to a number. */
export declare function fetchChainId(rpc: EvmRpc): Promise<number>;
/**
 * EIP-1559 fee data: the priority fee comes from eth_maxPriorityFeePerGas, falling back to
 * eth_gasPrice when the node does not implement that method (the call throws). The max fee is
 * `baseFee * 2n + priority`, base fee read from `eth_getBlockByNumber("latest", false)`'s
 * `baseFeePerGas` (a raw/object call, hence `callRaw`). Both results are hex quantities.
 */
export declare function fetchFeeData(rpc: EvmRpc): Promise<{
    maxFeePerGasHex: string;
    maxPriorityFeePerGasHex: string;
}>;
/**
 * eth_estimateGas for one leg, with a +20% safety buffer applied to the raw result
 * (`* 12n / 10n`, via BigInt). `value`, when provided, must already be a hex quantity.
 */
export declare function estimateGas(rpc: EvmRpc, params: {
    from: string;
    to: string;
    data: string;
    value?: string;
}): Promise<string>;
/** Everything assembleEvmTx() needs to produce one signable EIP-1559 transaction. */
export interface AssembleEvmTxInput {
    from: string;
    to: string;
    data: string;
    /** Decimal wei string, as a build leg's `value` field ships it. */
    valueDecimal: string;
    nonce: number;
    chainId: number;
    gasLimitHex: string;
    feeData: {
        maxFeePerGasHex: string;
        maxPriorityFeePerGasHex: string;
    };
}
/**
 * Assembles the exact `EvmSignTransactionParams` shape Privy's `eth_signTransaction` expects
 * (client.ts:565-576): `nonce`/`chain_id`/`type` as numbers, `value`/`gas_limit`/fee fields as hex
 * quantity strings. `type` is always 2 (EIP-1559): no legacy `gas_price` field.
 */
export declare function assembleEvmTx(input: AssembleEvmTxInput): EvmSignTransactionParams;
/**
 * Polls eth_getTransactionReceipt (a `callRaw` -- the receipt is an object, or null before it is
 * mined) until it resolves non-null, then returns it -- unless the receipt reports a revert
 * (`status: "0x0"`), which throws instead of returning a receipt the caller would have to
 * remember to check. Throws a clear timeout error after `opts.timeoutMs` (default 120s) with no
 * receipt, polling every `opts.pollMs` (default 2s).
 */
export declare function waitForReceipt(rpc: EvmRpc, txHash: string, opts?: {
    timeoutMs?: number;
    pollMs?: number;
}): Promise<EvmTransactionReceipt>;
//# sourceMappingURL=evm-tx.d.ts.map