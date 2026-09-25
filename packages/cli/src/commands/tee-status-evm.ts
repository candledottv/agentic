/**
 * `candle tee status <0x address>`: Ember Phase 4b-1 (BE-392, spec
 * `2026-09-24-ember-phase-4b-hood-tee-wallets-design.md`, D5 and D6), a Hood TEE wallet's state.
 *
 * It shows ETH, USDG, the gas reserve, and `gas: low` when ETH is under twice the reserve. The
 * reserve is the D5 formula (USDG, WETH and one extra ERC-20 transfer, plus the final ETH
 * transfer, at twice the current fee) over this machine's EVM endpoint. The server also counts its
 * own traded-token list for the wallet, which no route hands to the CLI, so the figure here is the
 * reserve's floor, and the output says so.
 *
 * The vault is read first, and only read: an EVM key that is not a TEE wallet is refused by name
 * before any request, as every Solana-only `tee` command refuses it. A wallet this machine's vault
 * does not hold (an agent machine with no vault) is still reported from the server and the chain.
 * Nothing is signed or written.
 */
import type { ParsedArgs } from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveApiKey } from "../deps"
import {
  checkEvmAddress,
  createEvmRpc,
  EVM_RPC_URL_ENV,
  formatUnits,
  HOOD_USDG_ADDRESS,
  HOOD_USDG_DECIMALS,
  quoteFees,
  resolveEvmRpcUrl,
  rpcHostOf,
  sameEvmAddress,
} from "../evm-lite"
import { writeLocalFailure, writeUsageFailure } from "../render"
import { describeRpcFailure } from "../solana-endpoint"
import { listTradingWallets, sweepReserveFloor, TradingError } from "../trading"
import { isVaultError, VaultError } from "../vault/errors"
import { closeVault, readVaultRaw } from "../vault/store"
import { unlockInteractively, vaultPathFor } from "./vault-support"

/** D5: `gas: low` when the wallet's ETH is under this many reserves. */
export const GAS_LOW_RESERVE_MULTIPLE = 2n

interface VaultView {
  label?: string
  linkedWalletId?: string
  vaultDestination?: string
}

/** The vault's entry for `address`, read without keeping the vault open. `null` when there is no vault or no entry. */
async function readVaultEntry(ctx: CommandContext, address: string): Promise<VaultView | null> {
  const resolved = vaultPathFor(ctx, { values: {}, booleans: new Set(), positionals: [] })
  if ("error" in resolved) throw new TradingError("USAGE", resolved.error)
  const raw = await readVaultRaw(resolved.path)
  if (raw === null) return null
  const opened = await unlockInteractively(ctx, resolved.path, raw, { acceptOlderCopy: true })
  try {
    const entry = opened.vault.index.entries.find(
      (candidate) => candidate.chain === "evm" && sameEvmAddress(candidate.address, address),
    )
    if (entry === undefined) return null
    if (entry.role !== "tee-wallet")
      throw new VaultError(
        "SOLANA_COMMAND_EVM_KEY",
        `${entry.label || entry.address} is an EVM key (${entry.address}) but not a TEE wallet; tee status reads Solana and Hood TEE wallets only.`,
        {
          suggestion: `Nothing was read or written. An EVM vault key's balances are in: candle vault list --balances`,
        },
      )
    return {
      label: entry.label,
      ...(entry.linkedWalletId ? { linkedWalletId: entry.linkedWalletId } : {}),
      ...(entry.tee?.vaultDestination ? { vaultDestination: entry.tee.vaultDestination } : {}),
    }
  } finally {
    closeVault(opened.vault)
  }
}

export async function teeStatusEvm(ctx: CommandContext, parsed: ParsedArgs, address: string): Promise<number> {
  const { deps, json } = ctx
  const checked = checkEvmAddress(address)
  if (!checked.ok) {
    writeUsageFailure(deps, `${address} is not a Hood address: ${checked.reason}.`, json)
    return 2
  }
  const rpcUrl = resolveEvmRpcUrl(parsed.values["--rpc-url"], deps.env[EVM_RPC_URL_ENV], "--rpc-url")
  if ("error" in rpcUrl) {
    writeUsageFailure(deps, rpcUrl.error, json)
    return 2
  }

  let vault: VaultView | null
  try {
    vault = await readVaultEntry(ctx, checked.address)
  } catch (error) {
    if (error instanceof TradingError && error.code === "USAGE") {
      writeUsageFailure(deps, error.message, json)
      return 2
    }
    if (isVaultError(error)) {
      writeLocalFailure(
        deps,
        { code: error.code, message: error.message, ...(error.suggestion ? { suggestion: error.suggestion } : {}) },
        json,
      )
      return error.exitCode
    }
    throw error
  }

  const report: Record<string, unknown> = {
    address: checked.address,
    chain: "hood",
    label: vault?.label ?? null,
    source: vault ? "vault" : "server",
    linkedWalletId: vault?.linkedWalletId ?? null,
    vaultDestination: vault?.vaultDestination ?? null,
    observedAt: new Date(deps.now()).toISOString(),
  }

  const apiKey = await resolveApiKey(deps, ctx.profile)
  if (!apiKey) report.server = { error: "no API key available; server state not read" }
  else {
    try {
      const { rows } = await listTradingWallets(ctx, apiKey)
      const row = rows.find((candidate) => candidate.chain === "evm" && sameEvmAddress(candidate.address, address))
      if (row) {
        report.linkedWalletId ??= row.id
        if (report.label === null && row.label) report.label = row.label
        report.bound = { active: row.active, walletId: row.id }
      }
      const walletId = (report.linkedWalletId as string | null) ?? undefined
      if (walletId === undefined) report.server = { error: "not a TEE wallet on this key" }
      else {
        const lifecycle = await apiRequest(`/api/v1/agent/wallets/${encodeURIComponent(walletId)}/lifecycle`, {
          auth: "key",
          credentials: { apiKey },
          apiUrl: ctx.apiUrl,
          fetch: deps.fetch,
          env: deps.env,
        })
        report.server = lifecycle.ok ? lifecycle.body : { error: lifecycle.message ?? `HTTP ${lifecycle.status}` }
      }
    } catch (error) {
      report.server = { error: error instanceof Error ? error.message : "wallet listing failed" }
    }
  }

  deps.stderr.write(`Reading ETH, USDG and the fee for ${checked.address} from ${rpcHostOf(rpcUrl.url)}\n`)
  const rpc = createEvmRpc(rpcUrl.url, deps.fetch)
  try {
    const [eth, usdg, fees] = await Promise.all([
      rpc.getBalance(checked.address),
      rpc.erc20BalanceOf(HOOD_USDG_ADDRESS, checked.address),
      quoteFees(rpc),
    ])
    const reserve = sweepReserveFloor(fees.maxFeePerGas)
    const low = eth < reserve.wei * GAS_LOW_RESERVE_MULTIPLE
    report.balances = {
      ethWei: eth.toString(),
      eth: formatUnits(eth, 18),
      usdgRaw: usdg.toString(),
      usdg: formatUnits(usdg, HOOD_USDG_DECIMALS),
    }
    report.reserve = {
      wei: reserve.wei.toString(),
      eth: formatUnits(reserve.wei, 18),
      erc20Transfers: reserve.erc20Transfers,
      maxFeePerGas: fees.maxFeePerGas.toString(),
      basis: "floor: USDG, WETH and one extra ERC-20 transfer, plus the final ETH transfer, at twice the fee",
    }
    report.gas = low ? "low" : "ok"
    if (low) {
      const topUp = reserve.wei * GAS_LOW_RESERVE_MULTIPLE - eth
      report.fund = `candle vault fund ${checked.address} --amount ${formatUnits(topUp, 18)} --asset ETH`
    }
  } catch (error) {
    report.balances = { error: describeRpcFailure(error) }
  }

  if (json) {
    deps.stdout.write(`${JSON.stringify(report)}\n`)
    return 0
  }
  deps.stdout.write(`${checked.address}  ${report.label ?? ""}\n`)
  deps.stdout.write(`  chain         Hood (4663)\n`)
  deps.stdout.write(`  source        ${report.source}\n`)
  if (vault?.vaultDestination) deps.stdout.write(`  vault         ${vault.vaultDestination}\n`)
  const server = report.server as { state?: string; remoteAuthority?: string; error?: string } | undefined
  if (server?.error) deps.stdout.write(`  server        (unavailable: ${server.error})\n`)
  else if (server)
    deps.stdout.write(`  server state  ${server.state ?? "?"}  remote authority ${server.remoteAuthority ?? "?"}\n`)
  const balances = report.balances as Record<string, string>
  if (balances.error) deps.stdout.write(`  balances      (unavailable: ${balances.error})\n`)
  else {
    const reserve = report.reserve as { eth: string; erc20Transfers: number }
    deps.stdout.write(`  ETH           ${balances.eth}\n`)
    deps.stdout.write(`  USDG          ${balances.usdg}\n`)
    deps.stdout.write(
      `  reserve       at least ${reserve.eth} ETH (${reserve.erc20Transfers} ERC-20 transfers and the final ETH transfer at twice the fee)\n`,
    )
    deps.stdout.write(
      report.gas === "low"
        ? `  gas: low      ETH is under twice the reserve. Fund it: ${report.fund}\n`
        : `  gas           ok\n`,
    )
  }
  deps.stdout.write(`  observed at   ${report.observedAt}\n`)
  return 0
}
