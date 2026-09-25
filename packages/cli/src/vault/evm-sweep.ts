/**
 * Ember Phase 4b (BE-391, D1, "Which tokens"): the token list a Hood TEE sweep reads.
 *
 * An EVM RPC has no equivalent of Solana's token-account listing, so the sweep merges five sources,
 * dedupes them, and reads each `balanceOf` over the user's EVM RPC. `--emergency` uses only the
 * sources that do not call the Candle API.
 *
 *   1. USDG and WETH, always.
 *   2. The sealed EVM record: every token a leg that landed on this machine traded, swapped, launched
 *      or received. A lost record loses the hint, never the funds.
 *   3. The server's traded-token list for the wallet, when the API answers. Not asked under
 *      `--emergency`.
 *   4. Every `--token <0x...>` the owner adds.
 *   5. Log discovery: ERC-20 `Transfer` logs on the user's EVM RPC whose `to` topic is the wallet,
 *      paged from a start block (the earliest recorded `scanStart`, or `--from-block`), never from
 *      genesis by default. With no start block it does not run, and the sweep then cannot call the
 *      wallet observed-empty.
 *
 * Everything here reads; nothing signs. `commands/tee-evm.ts` is the sweep itself.
 */
import {
  addressTopic,
  ERC20_TRANSFER_TOPIC,
  type EvmRpc,
  EvmRpcError,
  HOOD_USDG_ADDRESS,
  HOOD_WETH_ADDRESS,
  toChecksumAddress,
} from "../evm-lite"
import type { EvmRecordRead } from "./evm-record"

/** The first page a log scan asks for, in blocks. Halved on an RPC refusal, down to the floor. */
export const LOG_PAGE_BLOCKS = 10_000n
export const LOG_PAGE_FLOOR = 250n

export interface LogDiscovery {
  ran: boolean
  fromBlock?: bigint
  toBlock?: bigint
  /** Where the start block came from: the record's `scanStart`, `--from-block`, or both (earliest wins). */
  startSource?: "record" | "--from-block" | "record and --from-block"
  tokens: string[]
  pages: number
  /** Why it did not run, or why it stopped. */
  reason?: string
  failed?: boolean
}

export interface TokenSources {
  always: string[]
  record: {
    /** The record file was read (the vault is open, so it always is when it exists). */
    tokens: string[]
    scanStarts: bigint[]
    absent: boolean
    noKey: boolean
    unreadableLines: number
    partialTail: boolean
    path: string
  }
  server: { asked: boolean; answered: boolean; tokens: string[]; reason?: string; truncated?: boolean }
  flags: string[]
  logs: LogDiscovery
}

export function sameToken(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** The deduped union of every source that produced a token, checksummed, in source order. */
export function mergedTokens(sources: TokenSources): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  // The order is the order the sweep spends gas in when ETH is short: base assets, what the owner
  // named, what this machine recorded, what the server listed, what the logs found.
  for (const token of [
    ...sources.always,
    ...sources.flags,
    ...sources.record.tokens,
    ...sources.server.tokens,
    ...sources.logs.tokens,
  ]) {
    const key = token.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(toChecksumAddress(token))
  }
  return out
}

/** Source 1. */
export function alwaysTokens(): string[] {
  return [toChecksumAddress(HOOD_USDG_ADDRESS), HOOD_WETH_ADDRESS]
}

/** Source 2, for one wallet, from a record already read by the open vault. */
export function recordSource(read: EvmRecordRead, wallet: string): TokenSources["record"] {
  const mine = read.entries.filter((entry) => sameToken(entry.wallet, wallet))
  return {
    tokens: mine.flatMap((entry) => (entry.kind === "token" ? [entry.token] : [])),
    scanStarts: mine.flatMap((entry) => (entry.kind === "scanStart" ? [BigInt(entry.block)] : [])),
    absent: read.absent,
    noKey: read.noKey,
    unreadableLines: read.unreadableLines,
    partialTail: read.partialTail,
    path: read.path,
  }
}

/**
 * The start block: the earliest of every recorded `scanStart` for this wallet and `--from-block`
 * (D1: "When several scanStart entries exist for one wallet, the earliest block wins"; `--from-block`
 * is the recorded height or any earlier one). Undefined when neither exists.
 */
export function startBlock(
  scanStarts: bigint[],
  fromBlockFlag: bigint | undefined,
): { block: bigint; source: NonNullable<LogDiscovery["startSource"]> } | undefined {
  const recorded = scanStarts.length > 0 ? scanStarts.reduce((a, b) => (a < b ? a : b)) : undefined
  if (recorded === undefined && fromBlockFlag === undefined) return undefined
  if (recorded === undefined) return { block: fromBlockFlag as bigint, source: "--from-block" }
  if (fromBlockFlag === undefined) return { block: recorded, source: "record" }
  return { block: recorded < fromBlockFlag ? recorded : fromBlockFlag, source: "record and --from-block" }
}

/**
 * Source 5: pages `eth_getLogs` for `Transfer(any, wallet, any)` from `fromBlock` to `toBlock`,
 * returning each emitting contract once. A page the RPC refuses (a range too wide for this node) is
 * halved and retried down to `LOG_PAGE_FLOOR`; a refusal at the floor, or a transport failure, ends
 * the scan as failed, and the sweep does not then call the wallet observed-empty.
 */
export async function discoverTransferLogs(
  rpc: EvmRpc,
  wallet: string,
  fromBlock: bigint,
  toBlock: bigint,
  opts: { pageBlocks?: bigint } = {},
): Promise<{ tokens: string[]; pages: number } | { failed: string; tokens: string[]; pages: number }> {
  const seen = new Map<string, string>()
  let page = opts.pageBlocks ?? LOG_PAGE_BLOCKS
  let pages = 0
  let from = fromBlock
  const topics = [ERC20_TRANSFER_TOPIC, null, addressTopic(wallet)]
  while (from <= toBlock) {
    const to = from + page - 1n > toBlock ? toBlock : from + page - 1n
    try {
      const logs = await rpc.getLogs({ fromBlock: from, toBlock: to, topics })
      pages += 1
      for (const log of logs) seen.set(log.address.toLowerCase(), log.address)
      from = to + 1n
    } catch (error) {
      if (error instanceof EvmRpcError && error.kind === "rpc" && page > LOG_PAGE_FLOOR) {
        page = page / 2n < LOG_PAGE_FLOOR ? LOG_PAGE_FLOOR : page / 2n
        continue
      }
      const reason = error instanceof Error ? error.message : String(error)
      return { failed: `eth_getLogs from block ${from} failed: ${reason}`, tokens: [...seen.values()], pages }
    }
  }
  return { tokens: [...seen.values()], pages }
}

/** The lines naming every source that ran (D1: "The output names every source that ran"). */
export function sourceLines(sources: TokenSources, host: string): string[] {
  const lines = ["Token sources:", "  USDG and WETH: always read"]
  const record = sources.record
  if (record.noKey && record.absent) {
    lines.push(`  sealed EVM record: none (this vault has no record key)`)
  } else if (record.absent) {
    lines.push(`  sealed EVM record: absent at ${record.path} (not on this machine, or nothing recorded yet)`)
  } else {
    const damage = [
      ...(record.unreadableLines > 0 ? [`${record.unreadableLines} unreadable line(s) skipped`] : []),
      ...(record.partialTail ? ["a partial last line skipped"] : []),
    ]
    lines.push(
      `  sealed EVM record: ${record.tokens.length} token(s), ${record.scanStarts.length} scan start(s)${damage.length > 0 ? `; ${damage.join(", ")}` : ""}`,
    )
  }
  const server = sources.server
  if (!server.asked)
    lines.push(`  server traded-token list: not asked (${server.reason ?? "--emergency calls no Candle API"})`)
  else if (!server.answered) lines.push(`  server traded-token list: FAILED (${server.reason ?? "no answer"})`)
  else
    lines.push(`  server traded-token list: ${server.tokens.length} token(s)${server.truncated ? " (truncated)" : ""}`)
  lines.push(`  --token: ${sources.flags.length}`)
  const logs = sources.logs
  if (logs.ran && !logs.failed) {
    lines.push(
      `  Transfer logs over ${host}: blocks ${logs.fromBlock} to ${logs.toBlock} (start from ${logs.startSource}), ${logs.tokens.length} contract(s)`,
    )
  } else if (logs.failed) {
    lines.push(`  Transfer logs over ${host}: FAILED (${logs.reason})`)
  } else {
    lines.push(`  Transfer logs: NOT scanned (${logs.reason})`)
  }
  if (logs.ran && logs.fromBlock !== undefined) {
    lines.push(
      `  A token received before block ${logs.fromBlock}, or from a contract that emits no Transfer log, still needs --token <0x...>.`,
    )
  }
  return lines
}
