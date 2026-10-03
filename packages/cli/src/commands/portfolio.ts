/**
 * `candle portfolio [<filter>] [--rpc-url <url>] [--keystore <path>] [--json]` (Ember Phase 3 R7; BE-316).
 *
 * Every wallet the operator holds, in one table: grouped as vault, TEE and embedded, each token
 * with its amount, price and value, and a total.
 *
 * ── Who reads what (P3-AD-11, P3-ED-11) ──────────────────────────────────────────────────────
 *
 * - **TEE and embedded wallets come from Candle**, `GET /api/v1/agent/portfolio`: Candle already
 *   holds those rows, so it reads their balances over its own RPC and prices what they hold.
 * - **Vault and external wallets are read over the resolved Solana RPC** (BE-355: `--rpc-url`,
 *   else `CANDLE_SOLANA_RPC_URL`, else the profile's `rpcUrl`, else the public endpoint, whose
 *   host is printed on stderr before the first request). Candle does not know those addresses and
 *   this command does not tell it: the only thing sent about them is the list of MINTS they hold,
 *   to `POST /agent/prices`, and only the mints Candle's own answer did not already price. External
 *   wallets are listed with the vault as holdings only; Candle is in none of their transactions, so
 *   they carry no P&L.
 * - A read that is still rate-limited after the client's retry stops the vault read (BE-355, D3):
 *   the wallets not yet read are "not read", the exit is 3, and the stderr line carries
 *   `RPC_RATE_LIMITED` and the fix.
 *
 * ── Fast and readable at 146 TEE wallets ─────────────────────────────────────────────────────
 *
 * The Candle read is one request. The vault read is `getMultipleAccounts` per 100 addresses for
 * SOL and `getTokenAccountsByOwner` per owner per token program for tokens, at most eight in
 * flight, started alongside the Candle read rather than after it. A failed read costs that wallet
 * alone: it is listed as unread, never as empty, and the exit code is 3 (partial). The table leaves
 * out wallets that hold nothing and says how many it left out, sorts each group by value, and ends
 * with a subtotal per group and a total. `--json` is the whole document, every wallet included,
 * written once (the pipe drain is `index.ts`'s, BE-299).
 *
 * ── LP positions (E2, BE-323) ────────────────────────────────────────────────────────────────
 *
 * When Candle's answer carries an `lp` section (the API serves LP, `LP_ENABLED`), each TEE
 * wallet's Meteora DAMM v2 positions come with it: the position's share of the pool reserves plus
 * its unclaimed fees, valued server-side at the same marks as the token rows, from the LP routes'
 * own pool read. Nothing about a pool is computed here (no Meteora SDK in the CLI, P3-ED-6). The
 * positions are shown in a second table after the tokens, counted in the wallet, group and total
 * figures, and carried per wallet in `--json`. A position whose pool could not be read is shown as
 * not read and left out, and the total says it is partial (exit 3). Without an `lp` section the
 * output is exactly what it was.
 *
 * ── Hood (Ember Phase 4d, 4d-ED-1 to 4d-ED-7) ────────────────────────────────────────────────
 *
 * Every wallet and holding carries `chain` (`solana` or `hood`), and the table has a CHAIN
 * column. The three groups hold both chains:
 *
 * - **TEE and embedded Hood wallets come from Candle**, in the answer's `hood` section (not its
 *   top-level `embedded` and `tee`, which stay Solana-only for released CLIs): ETH, USDG and
 *   tokens, priced under `hood:native` and `hood:<lowercased address>` keys. A token with no fresh
 *   mark shows its `unpricedReason` where its value would be, and the Hood subtotal counts them
 *   from `hood.unpriced` and `hood.unpricedByReason`. An API with no `hood` section is an older
 *   deployment: no Hood wallets, not an error.
 * - **EVM vault keys are read over the operator's own EVM RPC**, as `vault list --balances` does:
 *   `--evm-rpc-url`, else `CANDLE_EVM_RPC_URL`, else the built-in Hood RPC, whose host is printed
 *   on stderr before the first request. ETH and USDG only: the CLI cannot enumerate tokens, and
 *   vault keys never trade. The RPC must answer Hood's chain id; any other chain is refused by
 *   name before a balance is read. Their prices come from `POST /agent/prices` with a `hood` list
 *   of `native` and the USDG contract: never a vault address.
 * - External wallets stay Solana-only: there are no external EVM keys.
 *
 * `<filter>` keeps the wallets whose label or address contains it, in every group (`vault list`'s
 * rule: case-insensitive substring, no glob). Vault and external keys are filtered BEFORE the RPC
 * read, so a vault of 168 keys asked for seven sends seven: fewer requests (the public endpoint
 * rate-limits the full read) and a smaller disclosure. TEE and embedded rows come from Candle in
 * one request whatever the filter, and are narrowed after. Every figure is over the matched
 * wallets only, and the output says how many matched.
 *
 * `--chain solana|hood` shows one chain and reads nothing for the other. A failed Hood read is
 * partial like a failed Solana one (exit 3), with `unread` naming `eth`, `usdg` or `hood-tokens`,
 * and the footer names the chain. Subtotals are per group, then per chain, then one total. A bridge
 * (4c) moves value between the two chain subtotals; it is not a trade.
 */
import { parseArgs } from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveApiKey } from "../deps"
import {
  createEvmRpc,
  EVM_RPC_URL_ENV,
  HOOD_CHAIN_ID,
  HOOD_USDG_ADDRESS,
  HOOD_USDG_DECIMALS,
  NATIVE_DECIMALS,
  resolveEvmRpcUrl,
  rpcHostOf,
  toChecksumAddress,
} from "../evm-lite"
import { printIdentity } from "../profiles"
import { renderTable, terminalText, writeFailure, writeLocalFailure } from "../render"
import { describeRpcFailure, openSolanaClient, rateLimitedReadFailure, type SolanaClient } from "../solana-endpoint"
import { isRateLimited, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../solana-lite"
import { formatAmount, formatPrice, formatUsd, shortAddress } from "../usd"
import { VaultError } from "../vault/errors"
import { readVaultRaw } from "../vault/store"
import {
  refuseEnvPassphrase,
  requirePromptStreams,
  runVaultCommand,
  unlockInteractively,
  usage,
  vaultPathFor,
  writeJson,
} from "./vault-support"

export const SOL_MINT = "So11111111111111111111111111111111111111112"
/** Symbols for the base assets, which no price row names. Everything else takes Candle's name or none. */
const KNOWN_SYMBOLS: Record<string, string> = {
  [SOL_MINT]: "SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  "9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL": "CNDL",
}
/** The RPC caps one `getMultipleAccounts` at 100 addresses; `POST /agent/prices` takes 100 mints. */
const CHUNK = 100
const TOKEN_READS_IN_FLIGHT = 8
/** EVM vault reads at once: two calls each (ETH, then USDG), over the operator's own RPC. */
const EVM_READS_IN_FLIGHT = 8

/** Every chain a wallet or holding can be on (4d-ED-1). A third is one more member here. */
export type Chain = "solana" | "hood"
const CHAINS: readonly Chain[] = ["solana", "hood"]
const CHAIN_NAMES: Record<Chain, string> = { solana: "Solana", hood: "Hood" }

/** The Hood ETH price key, and `hood:<lowercased address>` for a contract (4d-ED-5). */
const HOOD_NATIVE = "native"
function hoodPriceKey(mint: string): string {
  return mint === HOOD_NATIVE ? "hood:native" : `hood:${mint.toLowerCase()}`
}
const HOOD_USDG = toChecksumAddress(HOOD_USDG_ADDRESS)

/** Why Candle left a Hood asset unpriced (4d-ED-4). Never rendered as zero. */
export type HoodUnpricedReason = "no-market-row" | "unusable-price" | "stale-mark" | "source-unavailable"

/** The halves of a wallet's read. Solana: `sol`, `tokens`. Hood: `eth`, then `usdg` (vault) or `hood-tokens`. */
export type UnreadPart = "sol" | "tokens" | "eth" | "usdg" | "hood-tokens"
const UNREAD_LABELS: Record<UnreadPart, string> = {
  sol: "SOL",
  tokens: "tokens",
  eth: "ETH",
  usdg: "USDG",
  "hood-tokens": "tokens",
}

type Program = "native" | "token" | "token-2022" | "erc20"
interface RawHolding {
  mint: string
  amountRaw: string
  decimals: number
  program: Program
}
interface TokenRow {
  mint: string
  amountRaw: string
  decimals: number
  program: "token" | "token-2022"
}
interface WalletRead {
  lamports: string | null
  tokens: TokenRow[] | null
}
/** One ERC-20 a Hood wallet holds, as Candle reads it. `mint` is the contract. */
interface HoodTokenRow {
  mint: string
  amountRaw: string
  decimals: number
  symbol?: string
}
/** A Hood wallet's read: ETH in wei and its tokens, each null when that half failed. */
interface HoodRead {
  wei: string | null
  tokens: HoodTokenRow[] | null
  /** Candle's holdings service lists at most 200 tokens; true when the wallet holds more. */
  truncated?: true
}
interface MintPrice {
  priceUsd: number | null
  source: "market" | "jupiter" | "reference" | null
  symbol?: string
  name?: string
  unpricedReason?: HoodUnpricedReason
}
interface LpToken {
  mint: string
  decimals: number
  amountRaw: string
  unclaimedFeesRaw: string
  symbol?: string
  priceUsd: number | null
  valueUsd: number | null
}
interface CandleLpPosition {
  position: string
  pool: string
  wallet: string
  walletId: string
  tokens: LpToken[]
  poolShare?: number
  valueUsd: number | null
  unpriced: number
}
interface CandlePortfolio {
  embedded: ({ address: string } & WalletRead)[]
  tee: ({ id: string; address: string; label?: string; active: boolean } & WalletRead)[]
  prices: Record<string, MintPrice>
  unavailable: string[]
  complete: boolean
  /** Present when the API serves LP (BE-323). Absent means no LP section, not "no positions". */
  lp?: {
    positions: CandleLpPosition[]
    unreadable: { position: string; wallet: string; walletId: string }[]
    complete: boolean
  }
  /** The account's Hood wallets (4d-ED-2). Absent from an API that predates 4d: no Hood wallets. */
  hood?: {
    embedded: ({ address: string } & HoodRead)[]
    tee: ({ id: string; address: string; label?: string; active: boolean } & HoodRead)[]
    unavailable: string[]
    unpriced: number
    unpricedByReason: Partial<Record<HoodUnpricedReason, number>>
  }
}

export interface Holding extends RawHolding {
  chain: Chain
  symbol: string | null
  amount: string
  priceUsd: number | null
  valueUsd: number | null
  priceSource: MintPrice["source"]
  /** Why a Hood holding has no price, shown where its value would be. */
  unpricedReason?: HoodUnpricedReason
}
/** One side of an LP position, as shown: amount and unclaimed fees in whole tokens, and its value. */
export interface LpPositionToken extends Omit<LpToken, "symbol"> {
  symbol: string | null
  amount: string
  unclaimedFees: string
}
export interface LpPositionRow {
  position: string
  pool: string
  tokens: LpPositionToken[]
  poolShare?: number
  /** Share of the reserves plus unclaimed fees at the marks; null when a side is unpriced. */
  valueUsd: number | null
  unpriced: number
}
export interface PortfolioWallet {
  chain: Chain
  address: string
  label?: string
  /** `vault` or `external` for a vault-file entry; absent for Candle's own rows. */
  role?: "vault" | "external"
  /** Candle's linked-wallet id, on a TEE wallet. */
  id?: string
  active?: boolean
  /** Null when the wallet could not be read at all: unknown, which is not the same as empty. */
  holdings: Holding[] | null
  /** The halves of the read that failed, when some did. Their holdings are unknown, not absent. */
  unread?: UnreadPart[]
  /** A Hood wallet holding more tokens than Candle lists: the rest are not shown or counted. */
  truncated?: true
  /** DAMM v2 positions this TEE wallet holds, when the API serves LP (BE-323). In `valueUsd`. */
  lpPositions?: LpPositionRow[]
  /** Position NFTs whose pool could not be read. Their value is unknown, not zero. */
  lpUnread?: string[]
  valueUsd: number
  unpriced: number
}
export interface ChainSubtotal {
  valueUsd: number
  unpriced: number
}
export interface PortfolioGroup {
  group: "vault" | "tee" | "embedded"
  read: boolean
  /** Why a group was not read, when it was not. */
  reason?: string
  wallets: PortfolioWallet[]
  valueUsd: number
  unpriced: number
  /** The group's figures per chain shown (4d-ED-7). */
  byChain: Partial<Record<Chain, ChainSubtotal>>
}

const NO_API_KEY = {
  code: "NO_API_KEY",
  message: "No API key for this profile.",
  suggestion: "Set CANDLE_API_KEY, or run `candle auth login` to store one.",
}

export async function portfolio(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--rpc-url", "--evm-rpc-url", "--keystore", "--chain"],
    pathFlags: ["--keystore"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length > 1) return usage(ctx, `Unexpected argument: ${parsed.positionals[1]}`)
  const filter = parsed.positionals[0]
  if (filter !== undefined && filter.trim() === "") return usage(ctx, "The filter is empty.")
  const keep = (wallet: { address: string; label?: string }) => filter === undefined || matches(wallet, filter)
  const { deps } = ctx

  // 4d-ED-6: one chain, or both. A flag for the chain not shown reads nothing, so it is said.
  const chainFlag = parsed.values["--chain"]
  if (chainFlag !== undefined && !CHAINS.includes(chainFlag as Chain)) {
    return usage(ctx, `--chain must be solana or hood, not ${chainFlag}.`)
  }
  const chains: Chain[] = chainFlag === undefined ? [...CHAINS] : [chainFlag as Chain]
  const showSolana = chains.includes("solana")
  const showHood = chains.includes("hood")
  if (!showSolana && parsed.values["--rpc-url"] !== undefined) {
    return usage(ctx, "--rpc-url is the Solana RPC and has no effect with --chain hood; use --evm-rpc-url.")
  }
  if (!showHood && parsed.values["--evm-rpc-url"] !== undefined) {
    return usage(ctx, "--evm-rpc-url is the Hood RPC and has no effect with --chain solana.")
  }

  const apiKey = await resolveApiKey(deps, ctx.profile)
  if (!apiKey) {
    writeLocalFailure(deps, NO_API_KEY, ctx.json)
    return 1
  }
  // BE-355 (D1): resolved and validated before the prompt; the vault is always read when there is one.
  let solana: SolanaClient | undefined
  if (showSolana) {
    const opened = await openSolanaClient(ctx, parsed.values["--rpc-url"])
    if ("error" in opened) return usage(ctx, opened.error)
    solana = opened
  }
  // 4d-ED-6: the EVM endpoint `vault list --balances` uses, checked before the prompt as well.
  let evmRpc: { url: string; builtIn: boolean } | undefined
  if (showHood) {
    const resolved = resolveEvmRpcUrl(parsed.values["--evm-rpc-url"], deps.env[EVM_RPC_URL_ENV], "--evm-rpc-url")
    if ("error" in resolved) return usage(ctx, resolved.error)
    evmRpc = resolved
  }
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)

  return runVaultCommand(ctx, async ({ hold }) => {
    // The vault first, when it will be read: the passphrase prompt comes before any waiting.
    let vaultEntries: { address: string; label: string; role: "vault" | "external" }[] | undefined
    let evmEntries: { address: string; label: string }[] | undefined
    let vaultReason: string | undefined
    // Wallets before the filter, for "N of M": the vault's here, Candle's once it has answered.
    let known = 0
    const raw = await readVaultRaw(resolvedVault.path)
    if (raw === null) {
      vaultReason = `no vault at ${resolvedVault.path}`
    } else {
      if (!refuseEnvPassphrase(ctx)) return 1
      if (!requirePromptStreams(ctx, "portfolio")) return 1
      const vault = hold((await unlockInteractively(ctx, resolvedVault.path, raw)).vault)
      vaultEntries = showSolana
        ? vault.index.entries
            .filter((entry) => entry.chain === "solana" && (entry.role === "vault" || entry.role === "external"))
            .map((entry) => ({ address: entry.address, label: entry.label, role: entry.role as "vault" | "external" }))
        : []
      // EVM vault keys (4d-ED-2). An EVM TEE-role entry is a local candidate, as a Solana one is.
      evmEntries = showHood
        ? vault.index.entries
            .filter((entry) => entry.chain === "evm" && entry.role === "vault")
            .map((entry) => ({ address: entry.address, label: entry.label }))
        : []
      // Filtered here, before any request: an address the filter did not keep is never sent.
      known += vaultEntries.length + evmEntries.length
      vaultEntries = vaultEntries.filter(keep)
      evmEntries = evmEntries.filter(keep)
    }

    await printIdentity(ctx)
    const rpcHost = solana?.endpoint.host
    if (solana && vaultEntries && vaultEntries.length > 0) {
      // D2's host line (and the notice, once) before this command's own sentence and first request.
      await solana.disclose()
      // The host, never the URL: a provider URL can carry an API key. stderr in both modes.
      const requests = Math.ceil(vaultEntries.length / CHUNK) + vaultEntries.length * 2
      deps.stderr.write(
        `Reading ${vaultEntries.length} vault ${vaultEntries.length === 1 ? "address" : "addresses"} from ${rpcHost} in ${requests} requests. That endpoint sees them together; Candle sees none of them.\n`,
      )
    }
    // 4d-ED-3, 4d-ED-6: the EVM host before its first request, then Hood or a refusal by name.
    let evmHost: string | undefined
    if (evmRpc && evmEntries && evmEntries.length > 0) {
      evmHost = rpcHostOf(evmRpc.url)
      const n = evmEntries.length
      deps.stderr.write(
        `Reading ETH and USDG for ${n} EVM vault ${n === 1 ? "address" : "addresses"} from ${evmHost}${evmRpc.builtIn ? " (the built-in Hood RPC)" : ""} in ${1 + 2 * n} requests. That endpoint sees them together; Candle sees none of them.\n`,
      )
    }
    const evmRead =
      evmRpc && evmEntries && evmEntries.length > 0
        ? await startEvmRead(
            evmEntries.map((entry) => entry.address),
            evmRpc.url,
            deps.fetch,
          )
        : undefined

    const [candle, vaultRead, evmBalances] = await Promise.all([
      apiRequest("/api/v1/agent/portfolio", {
        auth: "key",
        credentials: { apiKey },
        apiUrl: ctx.apiUrl,
        fetch: deps.fetch,
        env: deps.env,
      }),
      solana && vaultEntries && vaultEntries.length > 0
        ? readOwnRpc(
            vaultEntries.map((entry) => entry.address),
            solana,
            ctx,
          )
        : Promise.resolve(undefined),
      evmRead ? evmRead.balances() : Promise.resolve(undefined),
    ])
    if (vaultRead?.failure !== undefined) {
      // BE-355 (D3): the same line `vault list` prints, in both modes; under --json stdout stays
      // one document and the exit code says partial.
      const n = vaultRead.unavailable.length
      deps.stderr.write(`${n} vault ${n === 1 ? "address" : "addresses"} could not be read: ${vaultRead.failure}.\n`)
    }
    if (evmBalances?.failure !== undefined) {
      const n = evmBalances.unavailable.length
      deps.stderr.write(
        `${n} EVM vault ${n === 1 ? "address" : "addresses"} on Hood could not be read in full: ${terminalText(evmBalances.failure)}.\n`,
      )
    }
    if (!candle.ok) {
      writeFailure(deps, candle, { apiUrl: ctx.apiUrl, authType: "key" }, ctx.json)
      return 1
    }
    const answered = candle.body as CandlePortfolio
    known +=
      (showSolana ? (answered.tee ?? []).length + (answered.embedded ?? []).length : 0) +
      (showHood ? (answered.hood?.tee ?? []).length + (answered.hood?.embedded ?? []).length : 0)
    const fromCandle = filter === undefined ? answered : filterCandle(answered, keep)
    const prices: Record<string, MintPrice> = { ...(fromCandle.prices ?? {}) }
    // An API that predates 4d sends no `hood` section: no Hood wallets, not an error.
    const candleHood = showHood ? fromCandle.hood : undefined

    // Mints only, and only the ones Candle's answer did not already carry.
    let priceFailure: string | undefined
    if (vaultRead) {
      const wanted = new Set<string>()
      for (const wallet of vaultRead.byAddress.values()) {
        if (wallet.lamports !== null) wanted.add(SOL_MINT)
        for (const token of wallet.tokens ?? []) wanted.add(token.mint)
      }
      const missing = [...wanted].filter((mint) => prices[mint] === undefined)
      for (let at = 0; at < missing.length; at += CHUNK) {
        const priced = await apiRequest("/api/v1/agent/prices", {
          method: "POST",
          body: { mints: missing.slice(at, at + CHUNK) },
          auth: "key",
          credentials: { apiKey },
          apiUrl: ctx.apiUrl,
          fetch: deps.fetch,
          env: deps.env,
        })
        if (priced.ok) Object.assign(prices, (priced.body as { prices?: Record<string, MintPrice> }).prices ?? {})
        else priceFailure ??= priced.message
      }
    }
    // 4d-ED-4: the EVM vault's ETH and USDG, by asset alone. `native` and the USDG contract are
    // the whole request: nothing in it names a vault key.
    if (evmBalances) {
      const wanted: string[] = []
      const held = [...evmBalances.byAddress.values()]
      if (held.some((b) => (b.wei ?? 0n) > 0n)) wanted.push(HOOD_NATIVE)
      if (held.some((b) => (b.usdg ?? 0n) > 0n)) wanted.push(HOOD_USDG)
      const missing = wanted.filter((asset) => prices[hoodPriceKey(asset)] === undefined)
      if (missing.length > 0) {
        const priced = await apiRequest("/api/v1/agent/prices", {
          method: "POST",
          body: { hood: missing },
          auth: "key",
          credentials: { apiKey },
          apiUrl: ctx.apiUrl,
          fetch: deps.fetch,
          env: deps.env,
        })
        if (priced.ok) Object.assign(prices, (priced.body as { prices?: Record<string, MintPrice> }).prices ?? {})
        else priceFailure ??= priced.message
      }
    }
    if (priceFailure !== undefined) {
      deps.stderr.write(
        `Some vault holdings could not be priced: ${terminalText(priceFailure)}. They are shown as unpriced.\n`,
      )
    }

    // LP positions by the TEE wallet that holds them (E2). Absent section, absent rows. Solana only.
    const lpSection = showSolana ? fromCandle.lp : undefined
    const lpByWallet = new Map<string, { positions: LpPositionRow[]; unread: string[] }>()
    const lpOf = (address: string) => {
      const entry = lpByWallet.get(address) ?? { positions: [], unread: [] }
      lpByWallet.set(address, entry)
      return entry
    }
    for (const position of lpSection?.positions ?? []) lpOf(position.wallet).positions.push(lpRow(position, prices))
    for (const unread of lpSection?.unreadable ?? []) lpOf(unread.wallet).unread.push(unread.position)

    const wallet = (
      chain: Chain,
      address: string,
      read: { holdings: Holding[] | null; unread: UnreadPart[]; truncated?: true },
      extra: Pick<PortfolioWallet, "label" | "role" | "id" | "active">,
    ): PortfolioWallet => {
      const lp = chain === "solana" && lpSection ? lpOf(address) : undefined
      return {
        chain,
        address,
        ...extra,
        holdings: read.holdings,
        ...(read.unread.length > 0 ? { unread: read.unread } : {}),
        ...(read.truncated ? { truncated: true as const } : {}),
        ...(lp ? { lpPositions: lp.positions } : {}),
        ...(lp && lp.unread.length > 0 ? { lpUnread: lp.unread } : {}),
        valueUsd:
          (read.holdings ?? []).reduce((sum, h) => sum + (h.valueUsd ?? 0), 0) +
          (lp?.positions ?? []).reduce((sum, p) => sum + (p.valueUsd ?? 0), 0),
        unpriced:
          (read.holdings ?? []).filter((h) => h.priceUsd === null).length +
          (lp?.positions ?? []).filter((p) => p.valueUsd === null).length,
      }
    }
    const subtotals = (wallets: PortfolioWallet[]): Partial<Record<Chain, ChainSubtotal>> =>
      Object.fromEntries(
        chains.map((chain) => {
          const on = wallets.filter((w) => w.chain === chain)
          return [
            chain,
            {
              valueUsd: on.reduce((sum, w) => sum + w.valueUsd, 0),
              unpriced: on.reduce((sum, w) => sum + w.unpriced, 0),
            },
          ]
        }),
      )
    const group = (
      name: PortfolioGroup["group"],
      wallets: PortfolioWallet[],
      read: boolean,
      reason?: string,
    ): PortfolioGroup => ({
      group: name,
      read,
      ...(reason !== undefined ? { reason } : {}),
      wallets,
      valueUsd: wallets.reduce((sum, w) => sum + w.valueUsd, 0),
      unpriced: wallets.reduce((sum, w) => sum + w.unpriced, 0),
      byChain: subtotals(wallets),
    })
    const solanaRows = <R extends WalletRead>(rows: R[] | undefined) => (showSolana ? (rows ?? []) : [])

    const groups: PortfolioGroup[] = [
      group(
        "vault",
        [
          ...(vaultEntries ?? []).map((entry) =>
            wallet("solana", entry.address, solanaHoldings(vaultRead?.byAddress.get(entry.address), prices), {
              label: entry.label,
              role: entry.role,
            }),
          ),
          ...(evmEntries ?? []).map((entry) => {
            const read = evmBalances?.byAddress.get(entry.address)
            return wallet(
              "hood",
              entry.address,
              hoodHoldings(
                read && {
                  wei: read.wei === null ? null : read.wei.toString(),
                  tokens:
                    read.usdg === null
                      ? null
                      : read.usdg > 0n
                        ? [
                            {
                              mint: HOOD_USDG,
                              amountRaw: read.usdg.toString(),
                              decimals: HOOD_USDG_DECIMALS,
                              symbol: "USDG",
                            },
                          ]
                        : [],
                },
                prices,
                "usdg",
              ),
              { label: entry.label, role: "vault" },
            )
          }),
        ],
        vaultEntries !== undefined,
        vaultReason,
      ),
      group(
        "tee",
        [
          ...solanaRows(fromCandle.tee).map((row) =>
            wallet("solana", row.address, solanaHoldings(row, prices), {
              id: row.id,
              ...(row.label ? { label: row.label } : {}),
              active: row.active,
            }),
          ),
          ...(candleHood?.tee ?? []).map((row) =>
            wallet("hood", row.address, hoodHoldings(row, prices, "hood-tokens"), {
              id: row.id,
              ...(row.label ? { label: row.label } : {}),
              active: row.active,
            }),
          ),
        ],
        true,
      ),
      group(
        "embedded",
        [
          ...solanaRows(fromCandle.embedded).map((row) =>
            wallet("solana", row.address, solanaHoldings(row, prices), {}),
          ),
          ...(candleHood?.embedded ?? []).map((row) =>
            wallet("hood", row.address, hoodHoldings(row, prices, "hood-tokens"), {}),
          ),
        ],
        true,
      ),
    ]

    const unavailableByChain: Record<Chain, string[]> = {
      solana: showSolana ? [...(vaultRead?.unavailable ?? []), ...(fromCandle.unavailable ?? [])] : [],
      hood: [...(evmBalances?.unavailable ?? []), ...(candleHood?.unavailable ?? [])],
    }
    const unavailable = chains.flatMap((chain) => unavailableByChain[chain])
    const lpUnread = (lpSection?.unreadable ?? []).length
    // Candle's `complete` also covers a wallet list it had to cut off, which no `unavailable`
    // entry names: when it is false with nothing else to explain it, the run is partial too.
    // Read from Candle's whole answer: a wallet the filter left out still explains `complete`.
    const candleExplained =
      (answered.unavailable ?? []).length > 0 ||
      (answered.hood?.unavailable ?? []).length > 0 ||
      (answered.lp?.unreadable ?? []).length > 0
    const listCutOff = answered.complete === false && !candleExplained
    const complete = !listCutOff && unavailable.length === 0 && lpUnread === 0
    const totalUsd = groups.reduce((sum, g) => sum + g.valueUsd, 0)
    const unpriced = groups.reduce((sum, g) => sum + g.unpriced, 0)
    const lp = lpSection
      ? {
          positions: lpSection.positions.length,
          unpriced: lpSection.positions.filter((p) => p.valueUsd === null).length,
          unreadable: lpUnread,
          valueUsd: lpSection.positions.reduce((sum, p) => sum + (p.valueUsd ?? 0), 0),
        }
      : undefined

    // Per chain (4d-ED-7). Hood's unpriced figures are Candle's (`hood.unpriced`,
    // `hood.unpricedByReason`) plus the EVM vault's own, priced here.
    const all = groups.flatMap((g) => g.wallets)
    const byChain = subtotals(all) as Partial<
      Record<
        Chain,
        ChainSubtotal & {
          wallets: number
          unavailable: number
          unpricedByReason?: Partial<Record<HoodUnpricedReason, number>>
        }
      >
    >
    for (const chain of chains) {
      const entry = byChain[chain]
      if (!entry) continue
      entry.wallets = all.filter((w) => w.chain === chain).length
      entry.unavailable = unavailableByChain[chain].length
    }
    const hoodTotals = byChain.hood
    if (hoodTotals) {
      // Under a filter Candle's own counts cover wallets that are not shown, so every Hood wallet
      // shown is counted here instead; without one, Candle's counts plus the EVM vault's.
      const counted = filter === undefined ? (groups[0]?.wallets ?? []) : all
      const reasons: Partial<Record<HoodUnpricedReason, number>> =
        filter === undefined ? { ...(candleHood?.unpricedByReason ?? {}) } : {}
      let localUnpriced = 0
      for (const w of counted) {
        if (w.chain !== "hood") continue
        for (const h of w.holdings ?? []) {
          if (h.priceUsd !== null) continue
          localUnpriced += 1
          const reason = h.unpricedReason ?? "source-unavailable"
          reasons[reason] = (reasons[reason] ?? 0) + 1
        }
      }
      if (filter !== undefined) hoodTotals.unpriced = localUnpriced
      else if (candleHood) hoodTotals.unpriced = (candleHood.unpriced ?? 0) + localUnpriced
      hoodTotals.unpricedByReason = reasons
    }
    const matched = filter === undefined ? undefined : { filter, matched: all.length, wallets: known }

    if (ctx.json) {
      writeJson(deps, {
        ok: true,
        ...(matched ?? {}),
        chains,
        totalUsd,
        unpriced,
        complete,
        unavailable,
        unavailableByChain: Object.fromEntries(chains.map((chain) => [chain, unavailableByChain[chain]])),
        rpcHost: rpcHost ?? null,
        ...(evmHost !== undefined ? { evmRpcHost: evmHost } : {}),
        ...(lp ? { lp } : {}),
        byChain,
        groups,
      })
      return complete ? 0 : 3
    }

    if (matched) {
      // Before the table, so a short table is read as a filtered one. No match is an answer, not
      // a refusal (`vault list`'s rule): the exit code still says whether the reads were whole.
      deps.stdout.write(
        matched.matched === 0
          ? `No wallet matches "${terminalText(matched.filter)}". ${matched.wallets} ${matched.wallets === 1 ? "wallet" : "wallets"} on this account and vault; candle portfolio with no filter shows them.\n`
          : `${matched.matched} of ${matched.wallets} wallets match "${terminalText(matched.filter)}". Every figure below is for those wallets only.\n`,
      )
      if (matched.matched === 0) return complete ? 0 : 3
    }
    writeTable(ctx, groups, {
      totalUsd,
      unpriced,
      chains,
      byChain,
      unavailableByChain,
      listCutOff,
      lp,
    })
    return complete ? 0 : 3
  })
}

/**
 * The filter, `vault list`'s rule (BE-274 D10): a case-insensitive substring over label and
 * address. No glob and no regex. An embedded wallet has no label, so only its address can match.
 */
function matches(wallet: { address: string; label?: string }, filter: string): boolean {
  const needle = filter.toLowerCase()
  return (wallet.label ?? "").toLowerCase().includes(needle) || wallet.address.toLowerCase().includes(needle)
}

/**
 * Candle's answer narrowed to the wallets the filter keeps: the rows, and what is said ABOUT rows
 * (`unavailable`, LP positions and unreadable positions, by wallet address). Prices are left
 * whole. Hood's own unpriced counts are dropped: they cover every wallet, so the caller counts
 * the ones shown.
 */
function filterCandle(
  body: CandlePortfolio,
  keep: (wallet: { address: string; label?: string }) => boolean,
): CandlePortfolio {
  const tee = (body.tee ?? []).filter(keep)
  const embedded = (body.embedded ?? []).filter(keep)
  const kept = new Set([...tee, ...embedded].map((row) => row.address))
  const hoodTee = (body.hood?.tee ?? []).filter(keep)
  const hoodEmbedded = (body.hood?.embedded ?? []).filter(keep)
  const hoodKept = new Set([...hoodTee, ...hoodEmbedded].map((row) => row.address))
  return {
    ...body,
    tee,
    embedded,
    unavailable: (body.unavailable ?? []).filter((address) => kept.has(address)),
    ...(body.lp
      ? {
          lp: {
            ...body.lp,
            positions: body.lp.positions.filter((position) => kept.has(position.wallet)),
            unreadable: body.lp.unreadable.filter((position) => kept.has(position.wallet)),
          },
        }
      : {}),
    ...(body.hood
      ? {
          hood: {
            tee: hoodTee,
            embedded: hoodEmbedded,
            unavailable: (body.hood.unavailable ?? []).filter((address) => hoodKept.has(address)),
            unpriced: 0,
            unpricedByReason: {},
          },
        }
      : {}),
  }
}

/**
 * The EVM vault read (4d-ED-2, 4d-ED-3): `eth_chainId` first, and a chain other than Hood is
 * refused by name before any balance is asked for. A chain id that cannot be read leaves every EVM
 * vault address unread, which is partial, not a refusal. Then ETH and USDG per address, a few
 * addresses at a time; a failed call leaves that half unread and the read goes on.
 */
async function startEvmRead(
  addresses: string[],
  rpcUrl: string,
  fetchFn: typeof fetch,
): Promise<{
  balances: () => Promise<{
    byAddress: Map<string, { wei: bigint | null; usdg: bigint | null }>
    unavailable: string[]
    failure?: string
  }>
}> {
  const rpc = createEvmRpc(rpcUrl, fetchFn)
  const host = rpcHostOf(rpcUrl)
  const unique = [...new Set(addresses)]
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
  let chainId: bigint
  try {
    chainId = await rpc.chainId()
  } catch (error) {
    const failure = message(error)
    return {
      balances: async () => ({
        byAddress: new Map(unique.map((address) => [address, { wei: null, usdg: null }])),
        unavailable: unique,
        failure,
      }),
    }
  }
  if (chainId !== BigInt(HOOD_CHAIN_ID)) {
    throw new VaultError(
      "EVM_CHAIN_MISMATCH",
      `${host} answered chain id ${chainId}; candle portfolio reads EVM vault keys on Hood, chain id ${HOOD_CHAIN_ID}, only.`,
      {
        suggestion:
          "Nothing was read or priced. Point --evm-rpc-url (or CANDLE_EVM_RPC_URL) at a Hood RPC, or pass --chain solana.",
      },
    )
  }
  return {
    balances: async () => {
      const byAddress = new Map<string, { wei: bigint | null; usdg: bigint | null }>()
      let failure: string | undefined
      let next = 0
      await Promise.all(
        Array.from({ length: Math.min(EVM_READS_IN_FLIGHT, unique.length) }, async () => {
          while (next < unique.length) {
            const address = unique[next++] as string
            const read = async (call: () => Promise<bigint>) => {
              try {
                return await call()
              } catch (error) {
                failure ??= message(error)
                return null
              }
            }
            const wei = await read(() => rpc.getBalance(address))
            const usdg = await read(() => rpc.erc20BalanceOf(HOOD_USDG, address))
            byAddress.set(address, { wei, usdg })
          }
        }),
      )
      const unavailable = unique.filter((address) => {
        const read = byAddress.get(address)
        return read === undefined || read.wei === null || read.usdg === null
      })
      return { byAddress, unavailable, ...(failure === undefined ? {} : { failure }) }
    },
  }
}

/**
 * Holdings over the resolved Solana RPC. Per-chunk and per-owner failures stay local (see header),
 * except a rate limit that survived the client's retry (BE-355, D3): after it, nothing more is
 * sent, every wallet not yet read is unavailable, and `failure` names `RPC_RATE_LIMITED` and the
 * fix. Any other first failure's message is `failure` too, for the stderr line.
 */
async function readOwnRpc(
  addresses: string[],
  solana: SolanaClient,
  ctx: CommandContext,
): Promise<{ byAddress: Map<string, WalletRead>; unavailable: string[]; failure?: string }> {
  const { rpc } = solana
  const unique = [...new Set(addresses)]
  const lamports = new Map<string, string | null>()
  let rateLimited = false
  let failure: string | undefined
  const noteFailure = (error: unknown) => {
    if (isRateLimited(error)) {
      rateLimited = true
      failure ??= rateLimitedReadFailure(ctx, error)
    } else failure ??= describeRpcFailure(error)
  }
  for (let at = 0; at < unique.length; at += CHUNK) {
    const chunk = unique.slice(at, at + CHUNK)
    if (rateLimited) {
      for (const address of chunk) lamports.set(address, null)
      continue
    }
    try {
      const accounts = await rpc.getMultipleAccounts(chunk)
      for (const [i, address] of chunk.entries()) lamports.set(address, (accounts[i]?.lamports ?? 0n).toString())
    } catch (error) {
      noteFailure(error)
      for (const address of chunk) lamports.set(address, null)
    }
  }

  const tokens = new Map<string, Map<string, TokenRow>>()
  const failed = new Set<string>()
  const reads = unique.flatMap((owner) =>
    [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) => ({ owner, programId })),
  )
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(TOKEN_READS_IN_FLIGHT, reads.length) }, async () => {
      while (next < reads.length) {
        const { owner, programId } = reads[next++] as (typeof reads)[number]
        if (rateLimited) {
          failed.add(owner)
          continue
        }
        try {
          const accounts = await rpc.getTokenAccountsByOwner(owner, programId)
          const held = tokens.get(owner) ?? new Map<string, TokenRow>()
          tokens.set(owner, held)
          const program = programId === TOKEN_PROGRAM_ID ? "token" : "token-2022"
          for (const account of accounts) {
            if (!/^\d+$/.test(account.amountRaw) || BigInt(account.amountRaw) === 0n) continue
            const key = `${program}:${account.mint}`
            const prior = held.get(key)
            held.set(key, {
              mint: account.mint,
              amountRaw: (BigInt(prior?.amountRaw ?? "0") + BigInt(account.amountRaw)).toString(),
              decimals: account.decimals,
              program,
            })
          }
        } catch (error) {
          noteFailure(error)
          failed.add(owner)
        }
      }
    }),
  )

  const byAddress = new Map<string, WalletRead>()
  const unavailable: string[] = []
  for (const address of unique) {
    const sol = lamports.get(address) ?? null
    const held = failed.has(address) ? null : [...(tokens.get(address)?.values() ?? [])]
    byAddress.set(address, { lamports: sol, tokens: held })
    if (sol === null || held === null) unavailable.push(address)
  }
  return { byAddress, unavailable, ...(failure === undefined ? {} : { failure }) }
}

/** A Solana wallet's holdings as shown, and the halves of its read that failed. Null when nothing was read. */
function solanaHoldings(
  read: WalletRead | undefined,
  prices: Record<string, MintPrice>,
): { holdings: Holding[] | null; unread: UnreadPart[] } {
  if (read === undefined || (read.lamports === null && read.tokens === null)) return { holdings: null, unread: [] }
  return {
    holdings: valueHoldings(read, prices),
    unread: [...(read.lamports === null ? ["sol" as const] : []), ...(read.tokens === null ? ["tokens" as const] : [])],
  }
}

/** SOL first, then tokens; zero SOL is left out, an unread half contributes nothing. */
function valueHoldings(read: WalletRead, prices: Record<string, MintPrice>): Holding[] {
  const raw: RawHolding[] = []
  if (read.lamports !== null && BigInt(read.lamports) > 0n) {
    raw.push({ mint: SOL_MINT, amountRaw: read.lamports, decimals: 9, program: "native" })
  }
  for (const token of read.tokens ?? []) raw.push(token)
  return raw.map((h) => {
    const price = prices[h.mint]
    const priceUsd = price?.priceUsd ?? null
    const amount = formatAmount(h.amountRaw, h.decimals)
    return {
      chain: "solana",
      ...h,
      symbol: KNOWN_SYMBOLS[h.mint] ?? price?.symbol ?? null,
      amount,
      priceUsd,
      valueUsd: priceUsd === null ? null : Number(amount) * priceUsd,
      priceSource: price?.source ?? null,
    }
  })
}

/**
 * A Hood wallet's holdings as shown (4d-ED-2, 4d-ED-5): ETH first, then its tokens, each priced
 * under its lowercased `hood:` key. Null when nothing was read. `tokensPart` names a failed token
 * half: `usdg` for an EVM vault key (the only token read for it), `hood-tokens` for Candle's rows.
 */
function hoodHoldings(
  read: HoodRead | undefined,
  prices: Record<string, MintPrice>,
  tokensPart: "usdg" | "hood-tokens",
): { holdings: Holding[] | null; unread: UnreadPart[]; truncated?: true } {
  if (read === undefined || (read.wei === null && read.tokens === null)) return { holdings: null, unread: [] }
  const raw: (RawHolding & { symbol?: string })[] = []
  if (read.wei !== null && BigInt(read.wei) > 0n) {
    raw.push({ mint: HOOD_NATIVE, amountRaw: read.wei, decimals: NATIVE_DECIMALS, program: "native", symbol: "ETH" })
  }
  for (const token of read.tokens ?? []) {
    if (!/^\d+$/.test(token.amountRaw) || BigInt(token.amountRaw) === 0n) continue
    raw.push({
      mint: token.mint,
      amountRaw: token.amountRaw,
      decimals: token.decimals,
      program: "erc20",
      ...(token.symbol ? { symbol: token.symbol } : {}),
    })
  }
  const holdings = raw.map(({ symbol, ...h }): Holding => {
    const price = prices[hoodPriceKey(h.mint)]
    const priceUsd = price?.priceUsd ?? null
    const amount = formatAmount(h.amountRaw, h.decimals)
    const known = h.mint.toLowerCase() === HOOD_USDG_ADDRESS ? "USDG" : undefined
    return {
      chain: "hood",
      ...h,
      symbol: known ?? symbol ?? price?.symbol ?? null,
      amount,
      priceUsd,
      valueUsd: priceUsd === null ? null : Number(amount) * priceUsd,
      priceSource: price?.source ?? null,
      // No entry at all means no answer reached this run: the price source, not the token.
      ...(priceUsd === null ? { unpricedReason: price?.unpricedReason ?? "source-unavailable" } : {}),
    }
  })
  return {
    holdings,
    unread: [...(read.wei === null ? ["eth" as const] : []), ...(read.tokens === null ? [tokensPart] : [])],
    ...(read.truncated ? { truncated: true as const } : {}),
  }
}

/** An LP position as Candle valued it, with each side in whole tokens for the table and `--json`. */
function lpRow(position: CandleLpPosition, prices: Record<string, MintPrice>): LpPositionRow {
  return {
    position: position.position,
    pool: position.pool,
    tokens: position.tokens.map((token) => ({
      ...token,
      symbol: KNOWN_SYMBOLS[token.mint] ?? token.symbol ?? prices[token.mint]?.symbol ?? null,
      amount: formatAmount(token.amountRaw, token.decimals),
      unclaimedFees: formatAmount(token.unclaimedFeesRaw, token.decimals),
    })),
    ...(position.poolShare !== undefined ? { poolShare: position.poolShare } : {}),
    valueUsd: position.valueUsd,
    unpriced: position.unpriced,
  }
}

function writeTable(
  ctx: CommandContext,
  groups: PortfolioGroup[],
  totals: {
    totalUsd: number
    unpriced: number
    chains: Chain[]
    byChain: Partial<
      Record<Chain, ChainSubtotal & { wallets: number; unpricedByReason?: Partial<Record<HoodUnpricedReason, number>> }>
    >
    unavailableByChain: Record<Chain, string[]>
    listCutOff: boolean
    lp?: { positions: number; unpriced: number; unreadable: number; valueUsd: number }
  },
): void {
  const { deps } = ctx
  const rows: string[][] = []
  const lpRows: string[][] = []
  const notes: string[][] = []
  for (const g of groups) {
    const shown = g.wallets
      .filter(
        (w) =>
          w.holdings === null ||
          w.holdings.length > 0 ||
          (w.unread?.length ?? 0) > 0 ||
          (w.lpPositions?.length ?? 0) > 0 ||
          (w.lpUnread?.length ?? 0) > 0,
      )
      .sort((a, b) => b.valueUsd - a.valueUsd)
    let lpCount = 0
    let lpUnread = 0
    for (const w of shown) {
      const name = `${w.label ? `${w.label} ` : ""}(${shortAddress(w.address)})${w.role === "external" ? " external" : ""}`
      const side = (t: LpPositionToken, amount: string) => `${amount} ${t.symbol ?? shortAddress(t.mint)}`
      for (const p of [...(w.lpPositions ?? [])].sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1))) {
        lpCount += 1
        lpRows.push([
          g.group,
          name,
          shortAddress(p.position),
          shortAddress(p.pool),
          p.tokens.map((t) => side(t, t.amount)).join(" + "),
          p.tokens.map((t) => side(t, t.unclaimedFees)).join(" + "),
          p.valueUsd === null ? "unpriced" : formatUsd(p.valueUsd),
        ])
      }
      for (const position of w.lpUnread ?? []) {
        lpUnread += 1
        lpRows.push([g.group, name, shortAddress(position), "-", "not read", "-", "-"])
      }
      if (w.holdings === null) {
        rows.push([g.group, w.chain, name, "-", "not read", "-", "-"])
        continue
      }
      const sorted = [...w.holdings].sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1))
      for (const h of sorted) {
        rows.push([
          g.group,
          w.chain,
          name,
          h.symbol ?? shortAddress(h.mint),
          h.amount,
          h.priceUsd === null ? "unpriced" : formatPrice(h.priceUsd),
          // 4d-ED-4: where a value would be, why there is none.
          h.valueUsd === null ? (h.unpricedReason ?? "-") : formatUsd(h.valueUsd),
        ])
      }
      for (const part of w.unread ?? []) rows.push([g.group, w.chain, name, UNREAD_LABELS[part], "not read", "-", "-"])
    }
    const empty = g.wallets.length - shown.length
    const count = `${g.wallets.length} ${g.wallets.length === 1 ? "wallet" : "wallets"}`
    notes.push([
      g.group,
      g.read ? formatUsd(g.valueUsd) : "-",
      g.read
        ? `${count}${empty > 0 ? `, ${empty} empty not shown` : ""}${lpCount > 0 ? `, ${lpCount} LP ${lpCount === 1 ? "position" : "positions"}` : ""}${lpUnread > 0 ? `, ${lpUnread} LP not read` : ""}${g.unpriced > 0 ? `, ${g.unpriced} unpriced` : ""}`
        : (g.reason ?? "not read"),
    ])
  }
  if (rows.length > 0)
    deps.stdout.write(
      `\n${renderTable(
        ["GROUP", "CHAIN", "WALLET", "TOKEN", "AMOUNT", "PRICE", "VALUE"],
        rows.map((row) => row.map(terminalText)),
      )}\n`,
    )
  else deps.stdout.write("\nNothing held in any wallet read.\n")
  // LP positions after the tokens (R7): share of the pool plus unclaimed fees, at the same marks.
  if (lpRows.length > 0)
    deps.stdout.write(
      `\nLP positions\n${renderTable(
        ["GROUP", "WALLET", "POSITION", "POOL", "HOLDINGS", "UNCLAIMED FEES", "VALUE"],
        lpRows.map((row) => row.map(terminalText)),
      )}\n`,
    )

  // 4d-ED-7: per group above, then per chain, then one total.
  for (const chain of totals.chains) {
    const sub = totals.byChain[chain]
    if (!sub) continue
    const reasons = Object.entries(sub.unpricedByReason ?? {})
      .filter(([, n]) => (n ?? 0) > 0)
      .map(([reason, n]) => `${n} ${reason}`)
    notes.push([
      chain,
      formatUsd(sub.valueUsd),
      `${sub.wallets} ${sub.wallets === 1 ? "wallet" : "wallets"}${sub.unpriced > 0 ? `, ${sub.unpriced} unpriced${reasons.length > 0 ? ` (${reasons.join(", ")})` : ""}` : ""}`,
    ])
  }
  notes.push([
    "total",
    formatUsd(totals.totalUsd),
    totals.unpriced > 0
      ? `${totals.unpriced} unpriced ${totals.unpriced === 1 ? "holding" : "holdings"} not counted`
      : "every holding priced",
  ])
  const width = Math.max(...notes.map(([label]) => (label as string).length))
  const valueWidth = Math.max(...notes.map(([, value]) => (value as string).length))
  deps.stdout.write("\n")
  for (const [label, value, note] of notes) {
    deps.stdout.write(
      `${(label as string).padEnd(width)}  ${(value as string).padStart(valueWidth)}  ${terminalText(note as string)}\n`,
    )
  }
  // 4d-ED-7: a failed read names its chain.
  const unreadByChain = totals.chains
    .map((chain) => [chain, totals.unavailableByChain[chain].length] as const)
    .filter(([, n]) => n > 0)
  const unavailable = unreadByChain.reduce((sum, [, n]) => sum + n, 0)
  if (unavailable > 0) {
    deps.stdout.write(
      `${unavailable} ${unavailable === 1 ? "wallet" : "wallets"} could not be read in full (${unreadByChain.map(([chain, n]) => `${n} on ${CHAIN_NAMES[chain]}`).join(", ")}). What was not read is marked "not read" and is not in the total.\n`,
    )
  }
  if (totals.listCutOff) {
    deps.stdout.write("Candle listed only part of this account's wallets. The total is partial.\n")
  }
  const truncated = groups.flatMap((g) => g.wallets).filter((w) => w.truncated).length
  if (truncated > 0) {
    deps.stdout.write(
      `${truncated} Hood ${truncated === 1 ? "wallet holds" : "wallets hold"} more tokens than Candle lists. The rest are not shown and not in the total.\n`,
    )
  }
  if ((totals.lp?.unreadable ?? 0) > 0) {
    const n = totals.lp?.unreadable ?? 0
    deps.stdout.write(
      `${n} LP ${n === 1 ? "position" : "positions"} could not be read (the pool did not answer). ${n === 1 ? "It is" : "They are"} marked "not read" and not in the total.\n`,
    )
  }
  // 4d-ED-2: the vault's Hood rows are ETH and USDG only, and the help says so; so does the table.
  if (groups.some((g) => g.group === "vault" && g.wallets.some((w) => w.chain === "hood"))) {
    deps.stdout.write("EVM vault keys are read for ETH and USDG only; other tokens they hold are not shown.\n")
  }
}
