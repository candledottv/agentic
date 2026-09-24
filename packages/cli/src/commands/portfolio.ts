/**
 * `candle portfolio [--rpc-url <url>] [--keystore <path>] [--json]` (Ember Phase 3 R7; BE-316).
 *
 * Every wallet the operator holds, in one table: grouped as vault, TEE and embedded, each token
 * with its amount, price and value, and a total.
 *
 * ── Who reads what (P3-AD-11, P3-ED-11) ──────────────────────────────────────────────────────
 *
 * - **TEE and embedded wallets come from Candle**, `GET /api/v1/agent/portfolio`: Candle already
 *   holds those rows, so it reads their balances over its own RPC and prices what they hold.
 * - **Vault and external wallets are read over the operator's own RPC** (`--rpc-url`, else
 *   `CANDLE_SOLANA_RPC_URL`). Candle does not know those addresses and this command does not tell
 *   it: the only thing sent about them is the list of MINTS they hold, to `POST /agent/prices`,
 *   and only the mints Candle's own answer did not already price. External wallets are listed
 *   with the vault as holdings only; Candle is in none of their transactions, so they carry no P&L.
 * - With no RPC given, the vault is not read and not unlocked, and the output says so. No default
 *   endpoint is added, because a default endpoint is a default recipient (`vault list`, D5).
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
 */
import { parseArgs } from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveApiKey } from "../deps"
import { printIdentity } from "../profiles"
import { renderTable, terminalText, writeFailure, writeLocalFailure } from "../render"
import { createSolanaRpc, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../solana-lite"
import { formatAmount, formatPrice, formatUsd, shortAddress } from "../usd"
import { readVaultRaw } from "../vault/store"
import {
  RPC_URL_ENV,
  refuseEnvPassphrase,
  requirePromptStreams,
  rpcUrlFrom,
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

type Program = "native" | "token" | "token-2022"
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
interface MintPrice {
  priceUsd: number | null
  source: "market" | "jupiter" | null
  symbol?: string
  name?: string
}
interface CandlePortfolio {
  embedded: ({ address: string } & WalletRead)[]
  tee: ({ id: string; address: string; label?: string; active: boolean } & WalletRead)[]
  prices: Record<string, MintPrice>
  unavailable: string[]
  complete: boolean
}

export interface Holding extends RawHolding {
  symbol: string | null
  amount: string
  priceUsd: number | null
  valueUsd: number | null
  priceSource: MintPrice["source"]
}
export interface PortfolioWallet {
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
  unread?: ("sol" | "tokens")[]
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
}

const NO_API_KEY = {
  code: "NO_API_KEY",
  message: "No API key for this profile.",
  suggestion: "Set CANDLE_API_KEY, or run `candle auth login` to store one.",
}

export async function portfolio(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--rpc-url", "--keystore"], pathFlags: ["--keystore"] })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length > 0) return usage(ctx, `Unexpected argument: ${parsed.positionals[0]}`)
  const { deps } = ctx

  const apiKey = await resolveApiKey(deps, ctx.profile)
  if (!apiKey) {
    writeLocalFailure(deps, NO_API_KEY, ctx.json)
    return 1
  }
  const rpcGiven = parsed.values["--rpc-url"] !== undefined || Boolean(deps.env[RPC_URL_ENV]?.trim())
  let rpcUrl: string | undefined
  if (rpcGiven) {
    const resolved = rpcUrlFrom(ctx, parsed)
    if (typeof resolved !== "string") return usage(ctx, resolved.error)
    rpcUrl = resolved
  }
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)

  return runVaultCommand(ctx, async ({ hold }) => {
    // The vault first, when it will be read: the passphrase prompt comes before any waiting.
    let vaultEntries: { address: string; label: string; role: "vault" | "external" }[] | undefined
    let vaultReason: string | undefined
    const raw = rpcUrl === undefined ? null : await readVaultRaw(resolvedVault.path)
    if (rpcUrl === undefined) {
      vaultReason = `not read: vault balances are read only over your own RPC; pass --rpc-url or set ${RPC_URL_ENV}`
    } else if (raw === null) {
      vaultReason = `no vault at ${resolvedVault.path}`
    } else {
      if (!refuseEnvPassphrase(ctx)) return 1
      if (!requirePromptStreams(ctx, "portfolio")) return 1
      const vault = hold((await unlockInteractively(ctx, resolvedVault.path, raw)).vault)
      vaultEntries = vault.index.entries
        .filter((entry) => entry.chain === "solana" && (entry.role === "vault" || entry.role === "external"))
        .map((entry) => ({ address: entry.address, label: entry.label, role: entry.role as "vault" | "external" }))
    }

    await printIdentity(ctx)
    const rpcHost = rpcUrl === undefined ? undefined : new URL(rpcUrl).host
    if (vaultEntries && vaultEntries.length > 0 && rpcHost !== undefined) {
      // The host, never the URL: a provider URL can carry an API key. stderr in both modes.
      const requests = Math.ceil(vaultEntries.length / CHUNK) + vaultEntries.length * 2
      deps.stderr.write(
        `Reading ${vaultEntries.length} vault ${vaultEntries.length === 1 ? "address" : "addresses"} from ${rpcHost} in ${requests} requests. That endpoint sees them together; Candle sees none of them.\n`,
      )
    }

    const [candle, vaultRead] = await Promise.all([
      apiRequest("/api/v1/agent/portfolio", {
        auth: "key",
        credentials: { apiKey },
        apiUrl: ctx.apiUrl,
        fetch: deps.fetch,
        env: deps.env,
      }),
      vaultEntries && rpcUrl
        ? readOwnRpc(
            vaultEntries.map((entry) => entry.address),
            rpcUrl,
            deps.fetch,
          )
        : Promise.resolve(undefined),
    ])
    if (!candle.ok) {
      writeFailure(deps, candle, { apiUrl: ctx.apiUrl, authType: "key" }, ctx.json)
      return 1
    }
    const fromCandle = candle.body as CandlePortfolio
    const prices: Record<string, MintPrice> = { ...(fromCandle.prices ?? {}) }

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
    if (priceFailure !== undefined) {
      deps.stderr.write(
        `Some vault holdings could not be priced: ${terminalText(priceFailure)}. They are shown as unpriced.\n`,
      )
    }

    const wallet = (
      address: string,
      read: WalletRead | undefined,
      extra: Omit<PortfolioWallet, "address" | "holdings" | "unread" | "valueUsd" | "unpriced">,
    ): PortfolioWallet => {
      const holdings = read === undefined ? null : valueHoldings(read, prices)
      const unread: ("sol" | "tokens")[] =
        read === undefined
          ? []
          : [...(read.lamports === null ? ["sol" as const] : []), ...(read.tokens === null ? ["tokens" as const] : [])]
      return {
        address,
        ...extra,
        holdings,
        ...(unread.length > 0 ? { unread } : {}),
        valueUsd: (holdings ?? []).reduce((sum, h) => sum + (h.valueUsd ?? 0), 0),
        unpriced: (holdings ?? []).filter((h) => h.priceUsd === null).length,
      }
    }
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
    })
    const orNull = (read: WalletRead): WalletRead | undefined =>
      read.lamports === null && read.tokens === null ? undefined : read

    const groups: PortfolioGroup[] = [
      group(
        "vault",
        (vaultEntries ?? []).map((entry) => {
          const read = vaultRead?.byAddress.get(entry.address)
          return wallet(entry.address, read ? orNull(read) : undefined, { label: entry.label, role: entry.role })
        }),
        vaultEntries !== undefined,
        vaultReason,
      ),
      group(
        "tee",
        (fromCandle.tee ?? []).map((row) =>
          wallet(row.address, orNull(row), {
            id: row.id,
            ...(row.label ? { label: row.label } : {}),
            active: row.active,
          }),
        ),
        true,
      ),
      group(
        "embedded",
        (fromCandle.embedded ?? []).map((row) => wallet(row.address, orNull(row), {})),
        true,
      ),
    ]
    const unavailable = [...(vaultRead?.unavailable ?? []), ...(fromCandle.unavailable ?? [])]
    const complete = fromCandle.complete !== false && unavailable.length === 0
    const totalUsd = groups.reduce((sum, g) => sum + g.valueUsd, 0)
    const unpriced = groups.reduce((sum, g) => sum + g.unpriced, 0)

    if (ctx.json) {
      writeJson(deps, {
        ok: true,
        totalUsd,
        unpriced,
        complete,
        unavailable,
        ...(rpcHost !== undefined ? { rpcHost } : {}),
        groups,
      })
      return complete ? 0 : 3
    }

    writeTable(ctx, groups, { totalUsd, unpriced, unavailable: unavailable.length })
    return complete ? 0 : 3
  })
}

/** Holdings over the operator's own RPC. Per-chunk and per-owner failures stay local (see header). */
async function readOwnRpc(
  addresses: string[],
  rpcUrl: string,
  fetchFn: typeof fetch,
): Promise<{ byAddress: Map<string, WalletRead>; unavailable: string[] }> {
  const rpc = createSolanaRpc(rpcUrl, fetchFn)
  const unique = [...new Set(addresses)]
  const lamports = new Map<string, string | null>()
  for (let at = 0; at < unique.length; at += CHUNK) {
    const chunk = unique.slice(at, at + CHUNK)
    try {
      const accounts = await rpc.getMultipleAccounts(chunk)
      for (const [i, address] of chunk.entries()) lamports.set(address, (accounts[i]?.lamports ?? 0n).toString())
    } catch {
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
        } catch {
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
  return { byAddress, unavailable }
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
      ...h,
      symbol: KNOWN_SYMBOLS[h.mint] ?? price?.symbol ?? null,
      amount,
      priceUsd,
      valueUsd: priceUsd === null ? null : Number(amount) * priceUsd,
      priceSource: price?.source ?? null,
    }
  })
}

function writeTable(
  ctx: CommandContext,
  groups: PortfolioGroup[],
  totals: { totalUsd: number; unpriced: number; unavailable: number },
): void {
  const { deps } = ctx
  const rows: string[][] = []
  const notes: string[][] = []
  for (const g of groups) {
    const shown = g.wallets
      .filter((w) => w.holdings === null || w.holdings.length > 0 || (w.unread?.length ?? 0) > 0)
      .sort((a, b) => b.valueUsd - a.valueUsd)
    for (const w of shown) {
      const name = `${w.label ? `${w.label} ` : ""}(${shortAddress(w.address)})${w.role === "external" ? " external" : ""}`
      if (w.holdings === null) {
        rows.push([g.group, name, "-", "not read", "-", "-"])
        continue
      }
      const sorted = [...w.holdings].sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1))
      for (const h of sorted) {
        rows.push([
          g.group,
          name,
          h.symbol ?? shortAddress(h.mint),
          h.amount,
          h.priceUsd === null ? "unpriced" : formatPrice(h.priceUsd),
          h.valueUsd === null ? "-" : formatUsd(h.valueUsd),
        ])
      }
      for (const part of w.unread ?? [])
        rows.push([g.group, name, part === "sol" ? "SOL" : "tokens", "not read", "-", "-"])
    }
    const empty = g.wallets.length - shown.length
    const count = `${g.wallets.length} ${g.wallets.length === 1 ? "wallet" : "wallets"}`
    notes.push([
      g.group,
      g.read ? formatUsd(g.valueUsd) : "-",
      g.read
        ? `${count}${empty > 0 ? `, ${empty} empty not shown` : ""}${g.unpriced > 0 ? `, ${g.unpriced} unpriced` : ""}`
        : (g.reason ?? "not read"),
    ])
  }
  if (rows.length > 0)
    deps.stdout.write(
      `\n${renderTable(
        ["GROUP", "WALLET", "TOKEN", "AMOUNT", "PRICE", "VALUE"],
        rows.map((row) => row.map(terminalText)),
      )}\n`,
    )
  else deps.stdout.write("\nNothing held in any wallet read.\n")

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
    deps.stdout.write(`${(label as string).padEnd(width)}  ${(value as string).padStart(valueWidth)}  ${note}\n`)
  }
  if (totals.unavailable > 0) {
    deps.stdout.write(
      `${totals.unavailable} ${totals.unavailable === 1 ? "wallet" : "wallets"} could not be read in full. What was not read is marked "not read" and is not in the total.\n`,
    )
  }
}
