/**
 * Ember Phase 4b (BE-391, spec `2026-09-24-ember-phase-4b-hood-tee-wallets-design.md`, D1): moving a
 * Hood TEE wallet's funds home, never needing the Candle API.
 *
 * - `candle tee sweep <0x address> [--emergency] [--token <0x...>]... [--from-block <n>]` sweeps every
 *   ERC-20 the token sources find (`vault/evm-sweep.ts`), then ETH last as balance minus gas, to the
 *   wallet's pinned EVM vault key, signing locally with the key the vault holds.
 * - `candle tee disable <0x address>` asks the server to stop the wallet, the stop intent recorded
 *   locally first, exactly as on Solana.
 * - `candle vault demote <0x address>` disables, then sweeps.
 *
 * The rules are Solana's (SC-06, HW-07), with what an EVM wallet adds:
 *
 * - An ordinary sweep waits for the server's quarantine and reads the D4 operation lock before it
 *   signs, refusing while a sequenced leg holds this wallet's nonce (`WALLET_BUSY`) and refusing
 *   closed when the lock cannot be read (`WALLET_LOCK_UNKNOWN`).
 * - `--emergency` makes no Candle API call at all. It cannot see the lock, so it compares
 *   `eth_getTransactionCount` at `latest` and at `pending`: when `pending` is ahead, it signs at the
 *   in-flight leg's nonce and says this may replace that leg (not guaranteed if the leg paid more).
 * - No ETH means no gas: a sweep with token balances and too little ETH for their transfers refuses
 *   with `EVM_SWEEP_NEEDS_GAS`, names the shortfall and prints the `vault fund` command.
 * - Each transaction is recorded pending in the vault before it is broadcast and becomes a receipt
 *   once its receipt reads status 1; a re-run resolves what an interrupted run left.
 * - Exit 0 only on an observed-empty wallet (no token the sources know of holds a balance, and ETH is
 *   at most the gas dust a final transfer cannot move) AND only when every source this invocation
 *   needed ran: log discovery always (so no start block means no exit 0), and the server's list
 *   unless `--emergency`.
 */

import { parseArgs } from "../args"
import { apiRequest } from "../client"
import { type CommandContext, resolveApiKey } from "../deps"
import {
  buildErc20Transfer,
  buildNativeTransfer,
  checkEvmAddress,
  type EvmRpc,
  evmAddressFromSecret,
  formatUnits,
  gasWithHeadroom,
  HOOD_CHAIN_ID,
  NATIVE_DECIMALS,
  quoteFees,
  sameEvmAddress,
  signTransaction,
} from "../evm-lite"
import { printIdentity } from "../profiles"
import { writeLocalFailure } from "../render"
import { VaultError } from "../vault/errors"
import { readEvmRecord } from "../vault/evm-record"
import {
  alwaysTokens,
  discoverTransferLogs,
  mergedTokens,
  recordSource,
  sourceLines,
  startBlock,
  type TokenSources,
} from "../vault/evm-sweep"
import {
  assertHoodChain,
  assertWalletLockFree,
  type HoodClient,
  hoodHostLine,
  readHoodTeeServer,
  resolveHoodClient,
} from "../vault/evm-tee"
import { broadcast } from "../vault/evm-transfer"
import type { KeyEntry, VaultTeeMeta } from "../vault/format"
import { wipe } from "../vault/hygiene"
import { assertColdVaultDestination, sameAddress } from "../vault/promote-support"
import { commitVault, decryptKey, type UnlockedVault } from "../vault/store"
import {
  confirmLastSix,
  refuseEnvPassphrase,
  requireTty,
  requireVaultRaw,
  runVaultCommand,
  unlockInteractively,
  usage,
  vaultPathFor,
  writeJson,
} from "./vault-support"
import { readDisableOutcome } from "./wallets"

/** The most gas one token transfer may cost before a sweep leaves that token as a residual. */
export const MAX_TOKEN_TRANSFER_GAS = 1_000_000n

/**
 * What a node needs to accept a replacement of an in-flight nonce: double both fee caps and add
 * one wei to the tip, so a replacement is not priced exactly at the leg it is trying to replace.
 */
function replacementFees<T extends { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>(fees: T): T {
  return {
    ...fees,
    maxFeePerGas: fees.maxFeePerGas * 2n,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas * 2n + 1n,
  }
}

/** A sweep transaction recorded in `tee.sweepPending` before it is broadcast (SC-06). */
export interface EvmSweepPending {
  chain: "hood"
  hash: string
  nonce: string
  kind: "erc20" | "native"
  token?: string
  amountRaw: string
  at: string
}

/** A sweep transaction whose receipt was read, in `tee.sweepReceipts`. */
export interface EvmSweepReceipt {
  chain: "hood"
  hash: string
  kind: "erc20" | "native"
  token?: string
  amountRaw: string
  status: "confirmed" | "reverted"
  blockNumber?: string
  at: string
}

interface Residual {
  kind: string
  detail: string
  token?: string
  amountRaw?: string
}

/**
 * Whether a tee or demote command names a Hood TEE wallet: its positional is a `0x` address (the
 * value after a value flag is not a positional). Decided before the Solana parser runs, because the
 * EVM sweep takes flags (`--token`, `--from-block`) the Solana one refuses.
 */
export function namesEvmWallet(args: string[]): boolean {
  const valueFlags = new Set(["--rpc-url", "--keystore", "-k", "--sweep-to", "--from-block", "--token"])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (valueFlags.has(arg)) {
      i += 1
      continue
    }
    if (arg.startsWith("-")) continue
    return /^0x[0-9a-fA-F]{40}$/.test(arg)
  }
  return false
}

/** `--token` is repeatable; the shared parser keeps one value per flag, so it is taken out first. */
export function extractRepeated(args: string[], flag: string): { rest: string[]; values: string[] } {
  const rest: string[] = []
  const values: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === flag) {
      const value = args[i + 1]
      if (value !== undefined) values.push(...value.split(",").filter((part) => part.length > 0))
      else values.push("")
      i += 1
      continue
    }
    rest.push(arg)
  }
  return { rest, values }
}

function findEvmTee(vault: UnlockedVault, address: string): KeyEntry | undefined {
  return vault.index.entries.find(
    (entry) => entry.chain === "evm" && entry.role === "tee-wallet" && sameAddress(entry.address, address),
  )
}

function unknownWallet(ctx: CommandContext, address: string): number {
  writeLocalFailure(
    ctx.deps,
    {
      code: "TEE_WALLET_UNKNOWN",
      message: `${address} is not a Hood TEE wallet in this vault.`,
      suggestion: "Hood TEE wallets live in the vault only: candle vault list shows every wallet it holds.",
    },
    ctx.json,
  )
  return 1
}

/** Rewrites one entry's tee metadata through the vault's one write path, and returns the new vault. */
async function patchTee(
  ctx: CommandContext,
  vault: UnlockedVault,
  entryId: string,
  patch: (tee: VaultTeeMeta) => VaultTeeMeta,
): Promise<UnlockedVault> {
  return commitVault(
    vault,
    {
      index: {
        ...vault.index,
        entries: vault.index.entries.map((entry) =>
          entry.id === entryId && entry.tee !== undefined ? { ...entry, tee: patch(entry.tee) } : entry,
        ),
      },
    },
    ctx.deps,
  )
}

// ── tee sweep ─────────────────────────────────────────────────────────────────────────────────

export async function teeSweepEvm(args: string[], ctx: CommandContext): Promise<number> {
  const { rest, values: tokenFlags } = extractRepeated(args, "--token")
  const parsed = parseArgs(rest, {
    valueFlags: ["--rpc-url", "--keystore", "--from-block"],
    booleanFlags: ["--emergency", "--accept-older-copy"],
    pathFlags: ["--keystore"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [address, extra] = parsed.positionals
  if (!address || extra !== undefined) {
    return usage(
      ctx,
      "Usage: candle tee sweep <0x address> [--rpc-url <url>] [--emergency] [--token <0x...>]... [--from-block <n>]",
    )
  }
  const tokens: string[] = []
  for (const raw of tokenFlags) {
    const checked = checkEvmAddress(raw)
    if (!checked.ok)
      return usage(ctx, `--token must be an ERC-20 contract address: ${raw || "(empty)"} is ${checked.reason}.`)
    tokens.push(checked.address)
  }
  let fromBlock: bigint | undefined
  const fromBlockRaw = parsed.values["--from-block"]
  if (fromBlockRaw !== undefined) {
    if (!/^\d+$/.test(fromBlockRaw))
      return usage(ctx, `--from-block must be a Hood block number: ${fromBlockRaw} is not.`)
    fromBlock = BigInt(fromBlockRaw)
  }
  const client = resolveHoodClient(ctx, parsed.values["--rpc-url"])
  if ("error" in client) return usage(ctx, client.error)
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "tee sweep")) return 1
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const emergency = parsed.booleans.has("--emergency")

  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await requireVaultRaw(ctx, resolvedVault)
    // ED-6 stays best effort on the tee commands (tee-lookup.ts): an older copy opens with the warning.
    const opened = await unlockInteractively(ctx, resolvedVault.path, raw, { acceptOlderCopy: true })
    const vault = hold(opened.vault)
    const entry = findEvmTee(vault, address)
    if (entry === undefined) return unknownWallet(ctx, address)
    return sweepEvmWallet({ ctx, vault, hold, entry, client, emergency, tokenFlags: tokens, fromBlock })
  })
}

interface SweepInput {
  ctx: CommandContext
  vault: UnlockedVault
  hold: (vault: UnlockedVault) => UnlockedVault
  entry: KeyEntry
  client: HoodClient
  emergency: boolean
  tokenFlags: string[]
  fromBlock: bigint | undefined
}

async function sweepEvmWallet(input: SweepInput): Promise<number> {
  const { ctx, client, emergency, hold } = input
  const { deps, json } = ctx
  let vault = input.vault
  let entry = input.entry
  const address = entry.address
  const rpc = client.rpc
  const note = (line: string) => (json ? deps.stderr : deps.stdout).write(`${line}\n`)

  const destination = entry.tee?.vaultDestination
  if (destination === undefined) {
    writeLocalFailure(
      deps,
      {
        code: "TEE_WALLET_NO_VAULT",
        message: `${address} has no pinned vault destination, so there is nothing a sweep may send to.`,
        suggestion: `Pin a cold EVM vault key first: candle vault demote ${address} --sweep-to <evm vault key>`,
      },
      json,
    )
    return 1
  }

  // ── The server's gate (HW-07), and the D4 lock. --emergency asks the server nothing at all. ──
  let serverState = "local-only"
  let apiKey: string | undefined
  let server: Awaited<ReturnType<typeof readHoodTeeServer>> | undefined
  if (!emergency) {
    if (entry.linkedWalletId !== undefined) {
      apiKey = await resolveApiKey(deps, ctx.profile)
      let unreadReason: string | undefined
      if (apiKey === undefined) unreadReason = "no API key available"
      else {
        const lifecycle = await apiRequest(
          `/api/v1/agent/wallets/${encodeURIComponent(entry.linkedWalletId)}/lifecycle`,
          { auth: "key", credentials: { apiKey }, apiUrl: ctx.apiUrl, fetch: deps.fetch, env: deps.env },
        )
        if (!lifecycle.ok)
          unreadReason = `the lifecycle read failed: ${lifecycle.message ?? `HTTP ${lifecycle.status}`}`
        else serverState = (lifecycle.body as { state?: string }).state ?? "unknown"
      }
      if (unreadReason !== undefined) {
        writeLocalFailure(
          deps,
          {
            code: "TEE_WALLET_STATE_UNREAD",
            message: `Could not read ${address}'s lifecycle from the server (${unreadReason}); its remote signing authority is unverified.`,
            suggestion: `Restore the API key or connectivity and re-run. If the credential is lost or theft is suspected, recover WITHOUT the server: candle tee sweep ${address} --emergency`,
          },
          json,
        )
        return 3
      }
      if (serverState === "enabled") {
        writeLocalFailure(
          deps,
          {
            code: "TEE_WALLET_STILL_ENABLED",
            message: `${address} is still enabled for the agent.`,
            suggestion: `Stop it first: candle tee disable ${address}`,
          },
          json,
        )
        return 1
      }
      if (serverState === "disable-pending") {
        writeLocalFailure(
          deps,
          {
            code: "TEE_WALLET_DISABLE_PENDING",
            message: `${address}'s remote signing authority is not yet verified denied.`,
            suggestion: `Re-run: candle tee disable ${address}. If the provider is down or theft is suspected, add --emergency (the agent signer may still race you).`,
          },
          json,
        )
        return 3
      }
      if (serverState !== "quarantined" && serverState !== "swept") {
        writeLocalFailure(
          deps,
          { code: "TEE_WALLET_STATE_UNKNOWN", message: `Server reports state "${serverState}"; refusing to sweep.` },
          json,
        )
        return 1
      }
    }
    server = await readHoodTeeServer(ctx, entry)
    assertWalletLockFree(entry, server.lock, deps.now())
  }
  if (emergency) {
    note(
      "EMERGENCY SWEEP: no Candle API call is made. Remote signing authority is NOT verified denied, and a still-authorized agent signer can race these transactions.",
    )
  }

  // ── Pending transactions an earlier run left (SC-06): resolve before anything new is signed. ──
  deps.stderr.write(`${hoodHostLine(client, "the chain id, nonces, balances and logs")}\n`)
  await assertHoodChain(client)
  const resolved = await resolvePending(ctx, vault, entry, rpc)
  vault = hold(resolved.vault)
  entry = findEvmTee(vault, address) as KeyEntry
  if (resolved.stillPending.length > 0) {
    writeLocalFailure(
      deps,
      {
        code: "EVM_SWEEP_INCOMPLETE",
        message: `${resolved.stillPending.length} sweep transaction(s) from an earlier run are still in flight (${resolved.stillPending.map((p) => p.hash).join(", ")}).`,
        suggestion: `Nothing new was signed. Re-run this sweep once they land: candle tee sweep ${address}${emergency ? " --emergency" : ""}`,
      },
      json,
    )
    return 3
  }

  // ── The token sources (D1) ──────────────────────────────────────────────────────────────────
  const head = await rpc.blockNumber()
  if (input.fromBlock !== undefined && input.fromBlock > head) {
    return usage(ctx, `--from-block ${input.fromBlock} is above the chain head (${head}). Nothing was scanned.`)
  }
  const record = recordSource(await readEvmRecord(vault), address)
  const start = startBlock(record.scanStarts, input.fromBlock)
  const sources: TokenSources = {
    always: alwaysTokens(),
    record,
    server: emergency
      ? { asked: false, answered: false, tokens: [], reason: "--emergency calls no Candle API" }
      : server?.tradedTokens !== undefined
        ? {
            asked: true,
            answered: true,
            tokens: server.tradedTokens,
            ...(server.tradedTokensTruncated ? { truncated: true } : {}),
          }
        : {
            asked: true,
            answered: false,
            tokens: [],
            reason: server?.lock.state === "unknown" ? server.lock.reason : "the read carried no list",
          },
    flags: input.tokenFlags,
    logs: { ran: false, tokens: [], pages: 0 },
  }
  if (start === undefined) {
    sources.logs = {
      ran: false,
      tokens: [],
      pages: 0,
      reason: `no start block: no scan start is recorded for this wallet on this machine and --from-block was not given. Pass --from-block <n> (a Hood block at or before its first transfer in) or name tokens with --token <0x...>`,
    }
  } else {
    const found = await discoverTransferLogs(rpc, address, start.block, head)
    sources.logs = {
      ran: true,
      fromBlock: start.block,
      toBlock: head,
      startSource: start.source,
      tokens: found.tokens,
      pages: found.pages,
      ...("failed" in found ? { failed: true, reason: found.failed } : {}),
    }
  }
  const candidates = mergedTokens(sources)
  for (const line of sourceLines(sources, client.host)) note(line)

  // ── Balances and the plan ───────────────────────────────────────────────────────────────────
  const residuals: Residual[] = []
  const holding: Array<{ token: string; balance: bigint }> = []
  for (const token of candidates) {
    try {
      const balance = await rpc.erc20BalanceOf(token, address)
      if (balance > 0n) holding.push({ token, balance })
    } catch (error) {
      residuals.push({
        kind: "token-unreadable",
        token,
        detail: `balanceOf could not be read: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  // --emergency cannot see the D4 lock, so it compares the chain's nonces (D1). When a transaction
  // already occupies the latest nonce, this sweep signs at that nonce with doubled fees, which is
  // what a node needs to accept a replacement; it is still not guaranteed if the leg paid more.
  let emergencyNonces: { latest: bigint; pending: bigint } | undefined
  if (emergency) {
    emergencyNonces = {
      latest: await rpc.getTransactionCount(address, "latest"),
      pending: await rpc.getTransactionCount(address, "pending"),
    }
  }
  const replacing = emergencyNonces !== undefined && emergencyNonces.pending > emergencyNonces.latest
  const quoted = await quoteFees(rpc)
  const fees = replacing ? replacementFees(quoted) : quoted
  const planned: Array<{ token: string; balance: bigint; gas: bigint }> = []
  for (const item of holding) {
    const draft = buildErc20Transfer({
      chainId: BigInt(HOOD_CHAIN_ID),
      nonce: 0n,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      maxFeePerGas: fees.maxFeePerGas,
      gas: 0n,
      token: item.token,
      recipient: destination,
      amount: item.balance,
    })
    try {
      const estimate = await rpc.estimateGas({ from: address, to: draft.to, value: 0n, data: draft.data })
      const gas = gasWithHeadroom(estimate)
      if (gas > MAX_TOKEN_TRANSFER_GAS) {
        // A plain ERC-20 transfer costs well under this; a token that asks for more is not swept
        // automatically, so one hostile contract cannot spend the gas every other token needs.
        residuals.push({
          kind: "token-gas-too-high",
          token: item.token,
          amountRaw: item.balance.toString(),
          detail: `its transfer estimates at ${gas} gas, above the ${MAX_TOKEN_TRANSFER_GAS} a sweep spends on one token; move it on purpose with candle vault transfer <to> --asset ${item.token} --from ${address} if it is yours`,
        })
        continue
      }
      planned.push({ ...item, gas })
    } catch (error) {
      residuals.push({
        kind: "token-not-transferable",
        token: item.token,
        amountRaw: item.balance.toString(),
        detail: `the transfer does not estimate (${error instanceof Error ? error.message : String(error)}); it may be frozen or not a plain ERC-20`,
      })
    }
  }
  const ethBalance = await rpc.getBalance(address)
  const tokenGasCost = planned.reduce((sum, item) => sum + item.gas * fees.maxFeePerGas, 0n)
  // What the ETH covers, in source order (USDG, WETH, --token, the record, the server's list, the
  // logs); the rest stays as residuals with the fund command, rather than nothing moving at all.
  let budget = ethBalance
  const deferred: typeof planned = []
  for (const item of [...planned]) {
    const cost = item.gas * fees.maxFeePerGas
    if (cost <= budget) {
      budget -= cost
      continue
    }
    deferred.push(item)
    planned.splice(planned.indexOf(item), 1)
  }
  if (planned.length === 0 && deferred.length > 0) {
    // Not one token transfer is affordable: nothing moves, and the gas refusal names the shortfall.
    const shortfall = tokenGasCost - ethBalance
    throw new VaultError(
      "EVM_SWEEP_NEEDS_GAS",
      `${address} holds ${formatUnits(ethBalance, NATIVE_DECIMALS)} ETH; the ${deferred.length} token transfer(s) need up to ${formatUnits(tokenGasCost, NATIVE_DECIMALS)} ETH of gas, ${formatUnits(shortfall, NATIVE_DECIMALS)} ETH short.`,
      {
        suggestion: `Nothing was signed. Fund the gas, then sweep again: candle vault fund ${address} --amount ${formatUnits(shortfall * 2n, NATIVE_DECIMALS)} --asset ETH`,
        details: {
          shortfallWei: shortfall.toString(),
          requiredWei: tokenGasCost.toString(),
          balanceWei: ethBalance.toString(),
        },
      },
    )
  }
  if (deferred.length > 0) {
    const need = deferred.reduce((sum, item) => sum + item.gas * fees.maxFeePerGas, 0n)
    for (const item of deferred) {
      residuals.push({
        kind: "token-needs-gas",
        token: item.token,
        amountRaw: item.balance.toString(),
        detail: `not enough ETH left for its transfer; fund the gas and sweep again: candle vault fund ${address} --amount ${formatUnits(need * 2n, NATIVE_DECIMALS)} --asset ETH`,
      })
    }
  }

  note(`Sweep ${address} -> vault ${destination} (Hood)`)
  for (const item of planned) note(`  send ${item.balance} raw of ${item.token}  (gas limit ${item.gas})`)
  note(`  then ETH: the balance left after these transfers, minus the final transfer's gas`)

  const receipts: EvmSweepReceipt[] = []
  const pendingNow: EvmSweepPending[] = []
  let stopped: string | undefined
  const somethingToMove = planned.length > 0 || ethBalance > 0n
  if (somethingToMove) {
    await confirmLastSix(ctx, destination, "the vault destination")
    // The stop intent, before the first signature (SC-06): `vault fund` refuses this address from here.
    const stopRequestedAt = entry.tee?.stopRequestedAt ?? new Date(deps.now()).toISOString()
    vault = hold(await patchTee(ctx, vault, entry.id, (tee) => ({ ...tee, stopRequestedAt })))
    // D1: the lock again, immediately before the first signature.
    if (!emergency) assertWalletLockFree(entry, (await readHoodTeeServer(ctx, entry)).lock, deps.now())

    let nonce: bigint
    if (emergencyNonces !== undefined) {
      const { latest, pending } = emergencyNonces
      nonce = latest
      note(
        pending > latest
          ? `A transaction already occupies nonce ${latest} (pending ${pending} > latest ${latest}). This sweep signs at nonce ${latest} with doubled fees and may replace that in-flight leg; replacement is not guaranteed if the leg paid a higher fee.`
          : `No in-flight transaction was observed (latest and pending nonce are both ${latest}); signing from nonce ${latest}.`,
      )
    } else {
      nonce = await rpc.getTransactionCount(address, "pending")
    }

    const secret = await decryptKey(vault, entry.id)
    try {
      if (!sameEvmAddress(evmAddressFromSecret(secret), address)) {
        throw new VaultError("VAULT_VERIFY_FAILED", "The stored secret does not derive this address; refusing to sign.")
      }
      const send = async (
        tx: ReturnType<typeof buildErc20Transfer>,
        meta: { kind: "erc20" | "native"; token?: string; amountRaw: bigint },
      ): Promise<boolean> => {
        const signed = signTransaction(tx, secret)
        const record: EvmSweepPending = {
          chain: "hood",
          hash: signed.hash,
          nonce: tx.nonce.toString(),
          kind: meta.kind,
          ...(meta.token !== undefined ? { token: meta.token } : {}),
          amountRaw: meta.amountRaw.toString(),
          at: new Date(deps.now()).toISOString(),
        }
        vault = hold(
          await patchTee(ctx, vault, entry.id, (tee) => ({
            ...tee,
            sweepPending: [...(tee.sweepPending ?? []), record],
          })),
        )
        let status: "confirmed" | "reverted" | "uncertain"
        let blockNumber: bigint | undefined
        let line: string
        try {
          const outcome = await broadcast(rpc, ctx, signed.raw, signed.hash, BigInt(HOOD_CHAIN_ID))
          status = outcome.status === "confirmed" ? "confirmed" : "uncertain"
          blockNumber = outcome.blockNumber
          line = outcome.line
        } catch (error) {
          if (error instanceof VaultError && error.code === "EVM_TRANSFER_REVERTED") {
            status = "reverted"
            line = error.message
          } else if (error instanceof VaultError && error.code === "EVM_NONCE_STALE") {
            // Another transaction used the nonce and this one has no receipt: it never landed.
            vault = hold(
              await patchTee(ctx, vault, entry.id, (tee) => ({
                ...tee,
                sweepPending: (tee.sweepPending ?? []).filter((p) => (p as EvmSweepPending).hash !== signed.hash),
              })),
            )
            stopped = `${error.message} ${error.suggestion ?? ""}`.trim()
            return false
          } else {
            throw error
          }
        }
        note(`  ${line}`)
        if (status === "uncertain") {
          pendingNow.push(record)
          stopped = `transaction ${signed.hash} is in flight; the sweep stopped before signing the next nonce`
          return false
        }
        const receipt: EvmSweepReceipt = {
          chain: "hood",
          hash: signed.hash,
          kind: meta.kind,
          ...(meta.token !== undefined ? { token: meta.token } : {}),
          amountRaw: meta.amountRaw.toString(),
          status,
          ...(blockNumber !== undefined ? { blockNumber: blockNumber.toString() } : {}),
          at: new Date(deps.now()).toISOString(),
        }
        receipts.push(receipt)
        vault = hold(
          await patchTee(ctx, vault, entry.id, (tee) => ({
            ...tee,
            sweepPending: (tee.sweepPending ?? []).filter((p) => (p as EvmSweepPending).hash !== signed.hash),
            sweepReceipts: [...(tee.sweepReceipts ?? []), receipt],
          })),
        )
        if (status === "reverted") {
          residuals.push({
            kind: "transfer-reverted",
            detail: `${signed.hash} reverted; the fee was spent`,
            ...(meta.token !== undefined ? { token: meta.token } : {}),
            amountRaw: meta.amountRaw.toString(),
          })
        }
        return true
      }

      for (const item of planned) {
        const tx = buildErc20Transfer({
          chainId: BigInt(HOOD_CHAIN_ID),
          nonce,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          maxFeePerGas: fees.maxFeePerGas,
          gas: item.gas,
          token: item.token,
          recipient: destination,
          amount: item.balance,
        })
        const ok = await send(tx, { kind: "erc20", token: item.token, amountRaw: item.balance })
        if (!ok) break
        nonce += 1n
      }

      // ETH last (D1): the balance minus the final transfer's gas, re-read after the tokens moved.
      // When this nonce is still one an in-flight leg occupies, the same replacement bump the
      // token legs use applies here too, and the value is what remains after that bumped fee.
      if (stopped === undefined) {
        const balance = await rpc.getBalance(address)
        const quotedEth = await quoteFees(rpc)
        const ethReplacing = emergencyNonces !== undefined && nonce < emergencyNonces.pending
        const ethFees = ethReplacing ? replacementFees(quotedEth) : quotedEth
        const draft = buildNativeTransfer({
          chainId: BigInt(HOOD_CHAIN_ID),
          nonce,
          maxPriorityFeePerGas: ethFees.maxPriorityFeePerGas,
          maxFeePerGas: ethFees.maxFeePerGas,
          gas: 0n,
          to: destination,
          value: 0n,
        })
        const gas = gasWithHeadroom(await rpc.estimateGas({ from: address, to: draft.to, value: 0n, data: draft.data }))
        const value = balance - gas * ethFees.maxFeePerGas
        if (value > 0n) await send({ ...draft, gas, value }, { kind: "native", amountRaw: value })
      }
    } finally {
      wipe(secret)
    }
  }

  // ── Post-sweep inventory (SC-06): completion is what the chain holds afterwards. ──
  const inventory: { observedAt: string; verified: boolean; ethWei: string | null; dustCeilingWei: string | null } = {
    observedAt: new Date(deps.now()).toISOString(),
    verified: false,
    ethWei: null,
    dustCeilingWei: null,
  }
  try {
    const eth = await rpc.getBalance(address)
    const dustFees = await quoteFees(rpc)
    const dustGas = gasWithHeadroom(
      await rpc.estimateGas({ from: address, to: destination, value: 0n, data: new Uint8Array() }),
    )
    const dustCeiling = dustGas * dustFees.maxFeePerGas
    inventory.ethWei = eth.toString()
    inventory.dustCeilingWei = dustCeiling.toString()
    if (eth > dustCeiling) {
      residuals.push({
        kind: "eth-remaining",
        amountRaw: eth.toString(),
        detail: `${formatUnits(eth, NATIVE_DECIMALS)} ETH remains, above the ${formatUnits(dustCeiling, NATIVE_DECIMALS)} ETH a final transfer would cost; re-run the sweep`,
      })
    }
    for (const token of candidates) {
      if (residuals.some((r) => r.token !== undefined && sameAddress(r.token, token) && r.kind !== "transfer-reverted"))
        continue
      const left = await rpc.erc20BalanceOf(token, address)
      if (left > 0n) {
        residuals.push({
          kind: "token-remaining",
          token,
          amountRaw: left.toString(),
          detail: "a balance remains; re-run the sweep",
        })
      }
    }
    inventory.verified = true
  } catch (error) {
    residuals.push({
      kind: "inventory-unverified",
      detail: `the post-sweep balances could not be read: ${error instanceof Error ? error.message : String(error)}`,
    })
  }

  // Every source this invocation needed actually ran (D1): discovery always; the server's list
  // unless --emergency. A missing one means the wallet is not called observed-empty.
  const missingSources: string[] = []
  if (!sources.logs.ran || sources.logs.failed) missingSources.push("Transfer-log discovery")
  if (!emergency && !sources.server.answered) missingSources.push("the server's traded-token list")
  const observedEmpty =
    inventory.verified && residuals.length === 0 && stopped === undefined && missingSources.length === 0

  // ── Completion and the server's record (SC-06) ──
  const allReceipts = [...((entry.tee?.sweepReceipts ?? []) as EvmSweepReceipt[]), ...receipts].filter(
    (receipt, at, list) => list.findIndex((other) => other.hash === receipt.hash) === at,
  )
  let recordedOnServer = entry.tee?.sweptAt !== undefined || serverState === "swept"
  const complete =
    observedEmpty &&
    !emergency &&
    (serverState === "quarantined" ||
      serverState === "swept" ||
      (serverState === "local-only" && !entry.linkedWalletId))
  if (complete && entry.linkedWalletId && apiKey && !recordedOnServer) {
    const result = await apiRequest(`/api/v1/agent/wallets/${encodeURIComponent(entry.linkedWalletId)}/swept`, {
      method: "POST",
      auth: "key",
      credentials: { apiKey },
      apiUrl: ctx.apiUrl,
      fetch: deps.fetch,
      env: deps.env,
      body: { signatures: allReceipts.map((r) => r.hash), residuals: [] },
    })
    recordedOnServer = result.ok
    if (!result.ok) {
      residuals.push({
        kind: "server-record-failed",
        detail: `${result.message ?? `HTTP ${result.status}`}; the receipts are retained locally, re-run to record`,
      })
    }
  }
  let sweptLocally = entry.tee?.sweptAt !== undefined
  if (complete && (recordedOnServer || !entry.linkedWalletId) && !sweptLocally) {
    const sweptAt = new Date(deps.now()).toISOString()
    vault = hold(
      await patchTee(ctx, vault, entry.id, (tee) => ({
        ...tee,
        sweptAt,
        lifecycle: tee.lifecycle === "stranded" ? tee.lifecycle : "retired",
        ...(tee.vaultDestination !== undefined ? { vaultDestination: tee.vaultDestination } : {}),
      })),
    )
    sweptLocally = true
  }
  const finalState = sweptLocally && complete ? "swept" : emergency ? "disable-pending" : serverState
  const exit = finalState === "swept" ? 0 : 3

  if (json) {
    writeJson(deps, {
      ok: exit === 0,
      chain: "hood",
      address,
      vaultDestination: destination,
      state: finalState,
      serverState: emergency ? "not-read" : serverState,
      emergency,
      observedEmpty,
      sources: {
        record: {
          tokens: record.tokens.length,
          scanStarts: record.scanStarts.map(String),
          absent: record.absent,
          unreadableLines: record.unreadableLines,
          partialTail: record.partialTail,
        },
        server: sources.server,
        tokenFlags: sources.flags,
        logs: {
          ran: sources.logs.ran,
          ...(sources.logs.fromBlock !== undefined ? { fromBlock: sources.logs.fromBlock.toString() } : {}),
          ...(sources.logs.toBlock !== undefined ? { toBlock: sources.logs.toBlock.toString() } : {}),
          ...(sources.logs.startSource !== undefined ? { startSource: sources.logs.startSource } : {}),
          tokens: sources.logs.tokens,
          ...(sources.logs.reason !== undefined ? { reason: sources.logs.reason } : {}),
        },
      },
      missingSources,
      receipts: allReceipts,
      newReceipts: receipts.length,
      pending: pendingNow,
      residuals,
      inventory,
      recordedOnServer,
      ...(stopped !== undefined ? { stopped } : {}),
    })
    return exit
  }
  if (exit === 0) {
    deps.stdout.write(
      `Swept. ${allReceipts.length} transaction(s) confirmed; the wallet is observed empty and retired, and must not be reused.\n`,
    )
    return 0
  }
  if (stopped !== undefined) deps.stdout.write(`Sweep stopped: ${stopped}.\n`)
  if (residuals.length > 0) {
    deps.stdout.write(`Sweep incomplete: ${residuals.length} residual(s) remain.\n`)
    for (const r of residuals) {
      deps.stdout.write(
        `  - ${r.kind}${r.token ? ` ${r.token}` : ""}${r.amountRaw ? ` (${r.amountRaw} raw)` : ""}: ${r.detail}\n`,
      )
    }
  }
  if (missingSources.length > 0) {
    deps.stdout.write(
      `Not reported observed-empty: ${missingSources.join(" and ")} did not run, so a token only they would find may remain. ${sources.logs.ran ? "" : `Re-run with --from-block <n> or --token <0x...>: candle tee sweep ${address} --from-block <n>`}\n`,
    )
  }
  if (emergency) {
    deps.stdout.write(
      `Recovered funds recorded; remote authority is still pending. Re-run: candle tee disable ${address}\n`,
    )
  } else if (observedEmpty && !complete) {
    deps.stdout.write(
      `The wallet is observed empty, but its server state is ${serverState}; re-run once it is quarantined.\n`,
    )
  }
  deps.stdout.write(
    `Inventory at ${inventory.observedAt}: ${inventory.verified ? `${inventory.ethWei} wei ETH (gas dust ceiling ${inventory.dustCeilingWei} wei), ${candidates.length} token(s) read` : "NOT verified"}.\n`,
  )
  return exit
}

/**
 * SC-06 for EVM: every pending record an earlier run left is read against the chain. A receipt makes
 * it a receipt; a nonce the chain has passed without this hash means another transaction used it,
 * so it is dropped. A record with no receipt whose nonce is still current is dropped when
 * `eth_getTransactionByHash` returns null: the node never accepted it, and re-signing that nonce
 * to the same pinned destination is harmless. A lookup that throws, or that returns the
 * transaction, leaves the record in flight and the sweep signs nothing new.
 */
async function resolvePending(
  ctx: CommandContext,
  vault: UnlockedVault,
  entry: KeyEntry,
  rpc: EvmRpc,
): Promise<{ vault: UnlockedVault; stillPending: EvmSweepPending[] }> {
  const pending = (entry.tee?.sweepPending ?? []) as EvmSweepPending[]
  if (pending.length === 0) return { vault, stillPending: [] }
  const latest = await rpc.getTransactionCount(entry.address, "latest")
  const still: EvmSweepPending[] = []
  const landed: EvmSweepReceipt[] = []
  for (const record of pending) {
    const receipt = await rpc.getTransactionReceipt(record.hash)
    if (receipt !== null) {
      landed.push({
        chain: "hood",
        hash: record.hash,
        kind: record.kind,
        ...(record.token !== undefined ? { token: record.token } : {}),
        amountRaw: record.amountRaw,
        status: receipt.status === 1 ? "confirmed" : "reverted",
        blockNumber: receipt.blockNumber.toString(),
        at: new Date(ctx.deps.now()).toISOString(),
      })
      continue
    }
    if (BigInt(record.nonce) < latest) continue
    // The nonce is still unused. A null lookup means this hash never reached the node (a timeout
    // or a refusal on eth_sendRawTransaction). Drop it so the sweep can sign the nonce again.
    let known: { hash: string } | null
    try {
      known = await rpc.getTransactionByHash(record.hash)
    } catch {
      still.push(record)
      continue
    }
    if (known === null) continue
    still.push(record)
  }
  const next = await patchTee(ctx, vault, entry.id, (tee) => ({
    ...tee,
    sweepPending: still,
    sweepReceipts: [...(tee.sweepReceipts ?? []), ...landed],
  }))
  return { vault: next, stillPending: still }
}

// ── tee disable ───────────────────────────────────────────────────────────────────────────────

/**
 * `tee disable <0x address>`: the stop intent recorded in the vault BEFORE the server is asked
 * (HW-06), then the same `DELETE /api/v1/agent/wallets/:id` and typed outcome as Solana.
 */
export async function teeDisableEvm(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--keystore"],
    booleanFlags: ["--accept-older-copy"],
    pathFlags: ["--keystore"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [address, extra] = parsed.positionals
  if (!address || extra !== undefined) return usage(ctx, "Usage: candle tee disable <address>")
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "tee disable")) return 1
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const { deps, json } = ctx
  await printIdentity(ctx)
  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await requireVaultRaw(ctx, resolvedVault)
    const opened = await unlockInteractively(ctx, resolvedVault.path, raw, { acceptOlderCopy: true })
    let vault = hold(opened.vault)
    const entry = findEvmTee(vault, address)
    if (entry === undefined) return unknownWallet(ctx, address)
    if (entry.linkedWalletId === undefined) {
      writeLocalFailure(
        deps,
        { code: "TEE_WALLET_NOT_ENABLED", message: `${entry.address} was never enabled; there is nothing to stop.` },
        json,
      )
      return 1
    }
    const linkedWalletId = entry.linkedWalletId
    const stopRequestedAt = entry.tee?.stopRequestedAt ?? new Date(deps.now()).toISOString()
    vault = hold(await patchTee(ctx, vault, entry.id, (tee) => ({ ...tee, stopRequestedAt })))
    const unconfirmed = (detail: string, suggestion: string): number => {
      if (json) {
        writeJson(deps, {
          ok: false,
          code: "STOP_UNCONFIRMED",
          message: detail,
          address: entry.address,
          linkedWalletId,
          stopRequestedAt,
          remoteEnforcement: "unconfirmed",
          suggestion,
        })
        return 1
      }
      deps.stderr.write(
        `${detail}\nStop intent recorded locally at ${stopRequestedAt}: this CLI will not fund ${entry.address} again. Remote enforcement is UNCONFIRMED: the agent may still trade until the server acknowledges the stop.\n${suggestion}\n`,
      )
      return 1
    }
    const apiKey = await resolveApiKey(deps, ctx.profile)
    if (!apiKey) {
      return unconfirmed(
        "No API key available, so the server was not asked to stop the agent.",
        `Stop it from your Candle session (revoke linked wallet ${linkedWalletId}), or restore the key and re-run: candle tee disable ${entry.address}`,
      )
    }
    const result = await apiRequest(`/api/v1/agent/wallets/${encodeURIComponent(linkedWalletId)}`, {
      method: "DELETE",
      auth: "key",
      credentials: { apiKey },
      apiUrl: ctx.apiUrl,
      fetch: deps.fetch,
      env: deps.env,
    })
    if (!result.ok) {
      return unconfirmed(
        `The stop request failed: ${result.message ?? `HTTP ${result.status}`}.`,
        `Re-run: candle tee disable ${entry.address}. If the key is lost or revoked, stop it from your Candle session (revoke linked wallet ${linkedWalletId}).`,
      )
    }
    const outcome = readDisableOutcome(result.body)
    if (json) {
      writeJson(deps, { address: entry.address, linkedWalletId, ...(result.body as object) })
      return outcome.complete ? 0 : 3
    }
    if (outcome.complete) {
      deps.stdout.write(`Stopped ${entry.address}. Remote signing denial verified; the wallet is quarantined.\n`)
      deps.stdout.write(`Recover the funds: candle tee sweep ${entry.address}\n`)
      return 0
    }
    deps.stdout.write(
      `Agent trading stopped at Candle for ${entry.address}. Remote policy verification is pending${outcome.reasonCode ? ` (${outcome.reasonCode})` : ""}.\nFunds remain in the TEE wallet and its TEE signing authority may still be active. Re-run: candle tee disable ${entry.address}\nIf the provider is down or theft is suspected: candle tee sweep ${entry.address} --emergency\n`,
    )
    return 3
  })
}

// ── vault demote ──────────────────────────────────────────────────────────────────────────────

/**
 * `vault demote <0x address>`: disable, then sweep (D1). `--sweep-to <evm vault key>` pins a cold
 * destination first when the wallet has none (a restored `stranded` entry). A wallet with no
 * linked-wallet id, or `--emergency`, skips the disable (it would be an API call) and sweeps under
 * `--emergency`. Disabling stops new builds; it does not clear a leg in flight, so the sweep still
 * reads the lock and refuses while it is held.
 */
export async function vaultDemoteEvm(args: string[], ctx: CommandContext): Promise<number> {
  const { rest, values: tokenFlags } = extractRepeated(args, "--token")
  const parsed = parseArgs(rest, {
    valueFlags: ["--rpc-url", "--sweep-to", "--keystore", "--from-block"],
    booleanFlags: ["--emergency", "--accept-older-copy", "--accept-unknown-exposure"],
    pathFlags: ["--keystore"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [address, extra] = parsed.positionals
  if (!address || extra !== undefined) {
    return usage(ctx, "Usage: candle vault demote <tee-address> [--rpc-url <url>] [--emergency] [--sweep-to <label>]")
  }
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "vault demote")) return 1
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const sweepTo = parsed.values["--sweep-to"]
  let emergency = parsed.booleans.has("--emergency")

  const snapshot = await runVaultCommand(ctx, async ({ hold }) => {
    const raw = await requireVaultRaw(ctx, resolvedVault)
    const opened = await unlockInteractively(ctx, resolvedVault.path, raw, {
      acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
    })
    const vault = hold(opened.vault)
    const entry = findEvmTee(vault, address)
    if (entry === undefined) return unknownWallet(ctx, address)
    if (entry.tee?.vaultDestination === undefined) {
      if (sweepTo === undefined) {
        throw new VaultError("GRANT_DESTINATION_UNRESOLVED", `${address} has no pinned vault destination.`, {
          suggestion: "Pass --sweep-to <evm vault key> (a cold EVM vault key in this vault).",
        })
      }
      // A restored vault's keys are all exposureUnknown; --accept-unknown-exposure admits exactly
      // that case, as it does on promote (never an everRemoteExposed or everExported key).
      const destination = assertColdVaultDestination(vault.index, sweepTo, {
        chain: "evm",
        acceptUnknownExposure: parsed.booleans.has("--accept-unknown-exposure"),
      })
      hold(await patchTee(ctx, vault, entry.id, (tee) => ({ ...tee, vaultDestination: destination.address })))
    }
    if (entry.linkedWalletId === undefined) {
      ctx.deps.stdout.write(
        `No linkedWalletId is recorded for ${entry.address}; disable was not called and remote authority stays unknown.\n`,
      )
      emergency = true
    }
    return 0
  })
  if (snapshot !== 0) return snapshot

  if (!emergency) {
    const disableCode = await teeDisableEvm([address, ...keystoreArgs(parsed)], ctx)
    if (disableCode !== 0 && disableCode !== 3) return disableCode
    if (disableCode === 3) {
      ctx.deps.stdout.write(
        `The disable is not yet verified; the sweep below will wait for quarantine. If the provider is down or theft is suspected, run: candle vault demote ${address} --emergency\n`,
      )
    }
  }
  const sweepArgs = [address, ...keystoreArgs(parsed)]
  if (parsed.values["--rpc-url"] !== undefined) sweepArgs.push("--rpc-url", parsed.values["--rpc-url"])
  if (parsed.values["--from-block"] !== undefined) sweepArgs.push("--from-block", parsed.values["--from-block"])
  for (const token of tokenFlags) sweepArgs.push("--token", token)
  if (emergency) sweepArgs.push("--emergency")
  return teeSweepEvm(sweepArgs, ctx)
}

function keystoreArgs(parsed: { values: Record<string, string> }): string[] {
  return parsed.values["--keystore"] !== undefined ? ["--keystore", parsed.values["--keystore"]] : []
}
