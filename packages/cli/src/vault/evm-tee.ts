/**
 * Ember Phase 4b (BE-391, D1, D6): what every local command that touches a Hood TEE wallet shares.
 *
 * - The Hood RPC: `--rpc-url`, else `CANDLE_EVM_RPC_URL`, else the built-in Hood RPC (4a's
 *   `resolveEvmRpcUrl`), host printed and never the URL. A TEE wallet is Hood only (chain id 4663),
 *   so every command here refuses any other chain the RPC answers.
 * - The holdings a promote shows: ETH, USDG and WETH.
 * - The promote-time `scanStart` append, which is the wallet's only recorded start height and so is
 *   never silent: when it cannot be written the height and the exact `--from-block` are printed.
 * - The D4 lock read (`GET /wallets/:id/hood-tee`) every non-emergency local signer makes before it
 *   signs at this wallet's nonce, and the server's traded-token list from the same read.
 * - `appendEvmRecordForTrade`: the one `token` line a landed trade leg appends (the production
 *   `deps.appendEvmRecord`), which never fails the leg.
 */
import { apiRequest } from "../client"
import { type CommandContext, type EvmRecordAppendOutcome, type EvmRecordTokenEntry, resolveApiKey } from "../deps"
import {
  createEvmRpc,
  EVM_RPC_URL_ENV,
  type EvmRpc,
  formatUnits,
  HOOD_CHAIN_ID,
  HOOD_USDG_ADDRESS,
  HOOD_USDG_DECIMALS,
  HOOD_WETH_ADDRESS,
  NATIVE_DECIMALS,
  resolveEvmRpcUrl,
  rpcHostOf,
  toChecksumAddress,
} from "../evm-lite"
import { VaultError } from "./errors"
import { appendEvmRecordEntry, appendNotice, evmRecordPath } from "./evm-record"
import type { KeyEntry } from "./format"
import { sameAddress } from "./promote-support"
import { defaultVaultPath } from "./store"

export interface HoodClient {
  rpc: EvmRpc
  url: string
  host: string
  builtIn: boolean
}

/** Resolved before any prompt, like every endpoint flag; the error is a usage line. */
export function resolveHoodClient(ctx: CommandContext, flag: string | undefined): HoodClient | { error: string } {
  const resolved = resolveEvmRpcUrl(flag, ctx.deps.env[EVM_RPC_URL_ENV], "--rpc-url")
  if ("error" in resolved) return resolved
  return {
    rpc: createEvmRpc(resolved.url, ctx.deps.fetch),
    url: resolved.url,
    host: rpcHostOf(resolved.url),
    builtIn: resolved.builtIn,
  }
}

/** The host line every Hood read prints before its first request. Never the URL (it can carry a key). */
export function hoodHostLine(client: HoodClient, what: string): string {
  return `Reading ${what} from ${client.host}${client.builtIn ? " (the built-in Hood RPC)" : ""}.`
}

/** A TEE wallet is Hood only (D1, section 1): any other chain id the RPC answers is refused. */
export async function assertHoodChain(client: HoodClient): Promise<void> {
  const chainId = await client.rpc.chainId()
  if (chainId !== BigInt(HOOD_CHAIN_ID)) {
    throw new VaultError(
      "EVM_CHAIN_MISMATCH",
      `${client.host} answered chain id ${chainId}; Hood TEE wallets live on Hood, chain id ${HOOD_CHAIN_ID}, only.`,
      { suggestion: "Nothing was signed or written. Point --rpc-url (or CANDLE_EVM_RPC_URL) at a Hood RPC." },
    )
  }
}

export interface EvmHoldings {
  eth: bigint
  usdg: bigint
  weth: bigint
}

export async function readEvmHoldings(rpc: EvmRpc, address: string): Promise<EvmHoldings> {
  const [eth, usdg, weth] = await Promise.all([
    rpc.getBalance(address),
    rpc.erc20BalanceOf(toChecksumAddress(HOOD_USDG_ADDRESS), address),
    rpc.erc20BalanceOf(HOOD_WETH_ADDRESS, address),
  ])
  return { eth, usdg, weth }
}

export function holdingsLines(address: string, holdings: EvmHoldings, observedAt: string): string[] {
  return [
    `Holdings at ${address} on Hood (observed ${observedAt}):`,
    `  ETH   ${formatUnits(holdings.eth, NATIVE_DECIMALS)}  (${holdings.eth} wei)`,
    `  USDG  ${formatUnits(holdings.usdg, HOOD_USDG_DECIMALS)}  (${holdings.usdg} raw)`,
    `  WETH  ${formatUnits(holdings.weth, NATIVE_DECIMALS)}  (${holdings.weth} raw)`,
    "  Other tokens are not listed: an EVM RPC has no token-account listing.",
  ]
}

/**
 * D1: every EVM TEE promote appends its own wallet's `scanStart`. It waits for the record lock
 * through the full window; when the append still cannot run, the promote has succeeded anyway and
 * the output names the height and the exact `--from-block` to pass, and says the height is not in
 * the record. Returns whether it was written, for `--json`.
 */
export async function appendScanStart(
  ctx: CommandContext,
  vaultPath: string,
  wallet: string,
  block: bigint,
): Promise<{ recorded: boolean; block: string }> {
  const outcome = await appendEvmRecordEntry({
    vaultPath,
    entry: { kind: "scanStart", wallet, block: Number(block) },
    clock: ctx.deps,
  })
  const repaired = appendNotice(outcome, `the scan start for ${wallet}`)
  if (outcome.written) {
    if (repaired !== undefined) ctx.deps.stderr.write(`${repaired}\n`)
    return { recorded: true, block: block.toString() }
  }
  ctx.deps.stderr.write(
    `The promote height, Hood block ${block}, was not written to the sealed EVM record at ${evmRecordPath(vaultPath)} (${outcome.detail}).\n` +
      `Keep it: a later sweep of ${wallet} finds traded tokens from it with: candle tee sweep ${wallet} --from-block ${block}\n`,
  )
  return { recorded: false, block: block.toString() }
}

/**
 * The production `deps.appendEvmRecord` (the seam BE-392's leg loop calls after each Hood TEE leg
 * lands): one `token` line in the sealed EVM record beside this machine's default vault, without
 * unlocking it (D1). It never fails the leg: every reason the append cannot run (no vault file on
 * this machine, a version 3 header, an unreadable header, a record lock not taken in the wait
 * window, an entry over 160 bytes, a config directory that does not resolve) comes back as
 * `appended: false` with the reason, which the leg loop prints as its notice.
 */
export async function appendEvmRecordForTrade(
  ctx: CommandContext,
  entry: EvmRecordTokenEntry,
): Promise<EvmRecordAppendOutcome> {
  let vaultPath: string
  try {
    vaultPath = defaultVaultPath(ctx.deps.env, ctx.deps.homedir())
  } catch (error) {
    return { appended: false, notice: error instanceof Error ? error.message : String(error) }
  }
  try {
    const outcome = await appendEvmRecordEntry({ vaultPath, entry, clock: ctx.deps })
    if (!outcome.written) return { appended: false, notice: outcome.detail }
    const repaired = appendNotice(outcome, `token ${entry.token}`)
    return { appended: true, ...(repaired !== undefined ? { notice: repaired } : {}) }
  } catch (error) {
    return { appended: false, notice: error instanceof Error ? error.message : String(error) }
  }
}

// ── The D4 lock and the server's traded-token list ────────────────────────────────────────────

export type WalletLock =
  | { state: "free" }
  | { state: "held"; operationId: string; kind: string; expiresAt: number }
  | { state: "unknown"; reason: string; suggestion?: string }

export interface HoodTeeServerRead {
  lock: WalletLock
  /** The server's traded-token list, when the read answered. */
  tradedTokens?: string[]
  tradedTokensTruncated?: boolean
}

/**
 * One read of `GET /api/v1/agent/wallets/:id/hood-tee`. Never throws. A wallet with no recorded
 * linked-wallet id, no API key, or a read that did not answer is `unknown`: the caller refuses
 * closed on it (`WALLET_LOCK_UNKNOWN`), because an unread lock is not a free one.
 */
export async function readHoodTeeServer(ctx: CommandContext, entry: KeyEntry): Promise<HoodTeeServerRead> {
  if (entry.linkedWalletId === undefined) {
    return {
      lock: {
        state: "unknown",
        reason: "this wallet has no linked wallet id recorded",
        suggestion: `Nothing was signed. This wallet has no server row, so its lock cannot be read. candle tee sweep ${entry.address} --emergency moves the funds and exits 3; it does not record sweptAt or retire the entry.`,
      },
    }
  }
  const apiKey = await resolveApiKey(ctx.deps, ctx.profile)
  if (apiKey === undefined) return { lock: { state: "unknown", reason: "no API key for this profile" } }
  try {
    const result = await apiRequest(`/api/v1/agent/wallets/${encodeURIComponent(entry.linkedWalletId)}/hood-tee`, {
      auth: "key",
      credentials: { apiKey },
      apiUrl: ctx.apiUrl,
      fetch: ctx.deps.fetch,
      env: ctx.deps.env,
    })
    if (!result.ok) return { lock: { state: "unknown", reason: result.message ?? `HTTP ${result.status}` } }
    const body = (result.body ?? {}) as {
      address?: unknown
      activeOperation?: { operationId?: unknown; kind?: unknown; expiresAt?: unknown } | null
      tradedTokens?: unknown
      tradedTokensTruncated?: unknown
    }
    // The path is the linked-wallet id. A stale or mismatched id can answer another wallet's free
    // lock, so a body that names no address, or a different one, is an unread lock.
    const reported = typeof body.address === "string" ? body.address : undefined
    if (reported === undefined || !sameAddress(reported, entry.address)) {
      return {
        lock: {
          state: "unknown",
          reason:
            reported === undefined
              ? "the response named no wallet address"
              : `the response is for ${reported}, not this wallet`,
        },
      }
    }
    const tradedTokens = Array.isArray(body.tradedTokens)
      ? body.tradedTokens.filter(
          (token): token is string => typeof token === "string" && /^0x[0-9a-fA-F]{40}$/.test(token),
        )
      : undefined
    const extras = {
      ...(tradedTokens !== undefined ? { tradedTokens } : {}),
      ...(body.tradedTokensTruncated === true ? { tradedTokensTruncated: true } : {}),
    }
    if (body.activeOperation === null) return { lock: { state: "free" }, ...extras }
    const op = body.activeOperation
    if (op === undefined || typeof op.operationId !== "string") {
      return { lock: { state: "unknown", reason: "the response carried no activeOperation field" }, ...extras }
    }
    return {
      lock: {
        state: "held",
        operationId: op.operationId,
        kind: typeof op.kind === "string" ? op.kind : "operation",
        expiresAt: typeof op.expiresAt === "number" ? op.expiresAt : 0,
      },
      ...extras,
    }
  } catch (error) {
    return { lock: { state: "unknown", reason: error instanceof Error ? error.message : String(error) } }
  }
}

/**
 * The command that can see this holder. `swap status` covers trade, swap and launch. A transfer
 * (or any later kind) is not one of those, so the hint does not name that command.
 */
function busyStatusHint(kind: string, operationId: string): string {
  if (kind === "swap") return `candle swap status ${operationId}`
  if (kind === "trade" || kind === "launch") return `candle swap status ${operationId} --kind ${kind}`
  return `the ${kind} operation ${operationId}`
}

/**
 * D1 "Local signing while a sequenced operation is in flight": a non-emergency local signer refuses
 * while the lock is held (printing the operation id) and refuses closed when it cannot be read.
 * Nothing is signed or broadcast on either refusal.
 */
export function assertWalletLockFree(entry: KeyEntry, lock: WalletLock, now: number): void {
  if (lock.state === "free") return
  if (lock.state === "held") {
    const left = Math.max(0, Math.ceil((lock.expiresAt - now) / 60_000))
    throw new VaultError(
      "WALLET_BUSY",
      `${entry.label || entry.address} has a sequenced ${lock.kind} in flight (operation ${lock.operationId}); signing locally now could use the nonce one of its legs holds.`,
      {
        suggestion: `Nothing was signed. Wait for operation ${lock.operationId} to finish (${busyStatusHint(lock.kind, lock.operationId)}); the lock expires within ${left} minute(s) at most. If funds must move now, candle tee sweep ${entry.address} --emergency compares the chain's nonces instead.`,
        details: { operationId: lock.operationId },
      },
    )
  }
  throw new VaultError(
    "WALLET_LOCK_UNKNOWN",
    `Could not read whether ${entry.label || entry.address} has a sequenced operation in flight (${lock.reason}), so nothing is signed at its nonce.`,
    {
      suggestion:
        lock.suggestion ??
        `Nothing was signed. Restore the API key or connectivity and run it again. If the server is unreachable and funds must move: candle tee sweep ${entry.address} --emergency`,
    },
  )
}
