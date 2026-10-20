/**
 * Transfers out of a user wallet, the view's half (BE-1680, spec S4 T-1 to T-4, T-9): the three
 * view-only methods `transfer.sources`, `transfer.destinations` and `transfer.prepare`, and the
 * destination history that is a display hint and nothing more.
 *
 * Only the user starts a transfer (K-3, invariant 11). Every method here is view-only in the role
 * table, and `transfer.prepare` is the one way a `transfer` card comes to exist. The form is never
 * pre-filled from agent output: the view sends what the user typed or picked, and the core checks
 * it again here.
 *
 * The history (T-3). A `(environment, chain, address)` with a `succeeded` transfer from this
 * profile shows "sent here before". It is rebuilt from the journal at start into
 * `destinations.json` (0600). Both files are plain files a same-user process can write, so the
 * hint is never trusted: it gates nothing, and every transfer asks for the typed `confirm`.
 */
import { randomBytes } from "node:crypto"
import { rename, writeFile } from "node:fs/promises"
import { terminalText } from "../render"
import type { CardBook, TransferDisplay } from "./cards"
import type { CoreEnvironment, Journal, JournalRow } from "./journal"
import { RpcError, refused } from "./rpc"
import type { CallContext, CoreServer } from "./server"
import { formatKeyLimit, parseFactor, type TradingState, type VaultWallet } from "./trading"
import {
  assetContract,
  assetLabel,
  BASE_ASSETS,
  describeSend,
  groupAddress,
  parseTransferInput,
  rawToDecimal,
  sameAddress,
  type TransferChain,
  type TransferParams,
} from "./transfer-params"

/** A destination the server accepts from the embedded wallet (`agent-transfer.ts` `classifyDestination`). */
export interface ServerDestination {
  chain: TransferChain
  address: string
  label?: string
  serverClass: "own" | "approved" | "linked"
}

export interface Balance {
  /** A base symbol, or the mint or token address. */
  asset: string
  /** The contract address drawn beside the ticker (design 7). */
  contract: string
  raw: string
  decimals: number
}

/** A `vault` send's preview (T-4 step 2): the CLI's plan, fee quote and affordability check. */
export interface VaultPreview {
  lines: string[]
  feeEstimate?: string
  /** What `max` would send at preview time, in raw units. */
  maxRaw?: string
}

/** Everything `transfer.*` reads. The real one is `commands/core.ts`'s; tests pass fakes. */
export interface TransferReads {
  /** The account's embedded wallet addresses (`GET /agent/wallets/embedded`, the Read key). */
  embeddedWallets(): Promise<{ solana?: string; evm?: string } | undefined>
  /** What the server would accept from the embedded wallet on `chain` (own, linked, allowlist). */
  serverDestinations(chain: TransferChain): Promise<ServerDestination[]>
  balances(chain: TransferChain, address: string): Promise<Balance[] | undefined>
  decimals(chain: TransferChain, asset: TransferParams["asset"]): Promise<number | undefined>
  previewVault(params: TransferParams, wallet: VaultWallet): Promise<VaultPreview>
}

/** `vault` wallets are Solana or EVM in the vault; a transfer names Hood for the EVM ones. */
export function walletChain(wallet: Pick<VaultWallet, "chain">): TransferChain {
  return wallet.chain === "evm" ? "hood" : "solana"
}

/** T-3's history: display only, rebuilt from the journal, written to `destinations.json`. */
export class DestinationHistory {
  private readonly seen = new Set<string>()

  constructor(private readonly options: { path: string; environment: CoreEnvironment }) {}

  private key(environment: string, chain: TransferChain, address: string): string {
    return `${environment}:${chain}:${chain === "hood" ? address.toLowerCase() : address}`
  }

  /** Rebuilds the index from the journal's `succeeded` transfer rows, then rewrites the file. */
  async rebuild(rows: readonly JournalRow[]): Promise<void> {
    this.seen.clear()
    const transfers = new Map<string, { chain: TransferChain; to: string }>()
    for (const row of rows) {
      const transfer = row.transfer as { chain?: unknown; to?: unknown } | undefined
      if (row.type === "operation.submitting" && typeof row.opId === "string" && transfer) {
        if ((transfer.chain === "solana" || transfer.chain === "hood") && typeof transfer.to === "string") {
          transfers.set(row.opId, { chain: transfer.chain, to: transfer.to })
        }
      } else if (row.type === "operation.succeeded" && typeof row.opId === "string") {
        const sent = transfers.get(row.opId)
        if (sent) this.seen.add(this.key(row.environment, sent.chain, sent.to))
      }
    }
    await this.write()
  }

  /** "Sent here before", for this environment only. A hint; it never skips a step. */
  has(chain: TransferChain, address: string): boolean {
    return this.seen.has(this.key(this.options.environment, chain, address))
  }

  async add(chain: TransferChain, address: string): Promise<void> {
    this.seen.add(this.key(this.options.environment, chain, address))
    await this.write()
  }

  private async write(): Promise<void> {
    const temp = `${this.options.path}.tmp-${randomBytes(6).toString("base64url")}`
    const body = { note: "Display hint only; rebuilt from the journal at start.", destinations: [...this.seen].sort() }
    await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, flag: "wx" })
    await rename(temp, this.options.path)
  }
}

export interface TransferHandlerDeps {
  cards: CardBook
  trading: TradingState
  journal: Journal
  reads: TransferReads
  history: DestinationHistory
}

/** Registers `transfer.sources`, `transfer.destinations` and `transfer.prepare` (view only). */
export function registerTransferHandlers(server: CoreServer, deps: TransferHandlerDeps): void {
  server.handle("transfer.sources", async (params, call) => sources(params, call, deps))
  server.handle("transfer.destinations", async (params, call) => destinations(params, call, deps))
  server.handle("transfer.prepare", async (params, call) => {
    try {
      return await prepare(params, call, deps)
    } catch (error) {
      // T-9: an attempt that never became a card is a client-event row, as S1 journals refusals.
      if (error instanceof RpcError) {
        await deps.journal.append({
          type: "transfer.refused",
          clientId: call.client.clientId,
          code: error.code,
          ...(typeof error.details.serverRule === "string" ? { serverRule: error.details.serverRule } : {}),
        })
      }
      throw error
    }
  })
}

async function embeddedAddress(deps: TransferHandlerDeps, chain: TransferChain): Promise<string | undefined> {
  const wallets = await deps.reads.embeddedWallets().catch(() => undefined)
  return chain === "hood" ? wallets?.evm : wallets?.solana
}

/** T-2: the wallets the user can send from, with balances, and which source kinds are on. */
async function sources(params: Record<string, unknown>, call: CallContext, deps: TransferHandlerDeps) {
  const factor = parseFactor(params.factor)
  let wallets = deps.trading.vaultWallets()
  if (wallets === undefined && factor !== undefined) wallets = await deps.trading.readVaultWallets(factor)
  const withdraw = deps.trading.withdrawState()
  const out: Record<string, unknown>[] = []
  for (const wallet of wallets ?? []) {
    const chain = walletChain(wallet)
    out.push({
      kind: "vault",
      walletId: wallet.id,
      label: terminalText(wallet.label),
      role: wallet.role,
      chain,
      address: wallet.address,
      on: true,
      balances: (await deps.reads.balances(chain, wallet.address).catch(() => undefined)) ?? null,
    })
  }
  const embedded = await deps.reads.embeddedWallets().catch(() => undefined)
  for (const chain of ["solana", "hood"] as const) {
    const address = chain === "hood" ? embedded?.evm : embedded?.solana
    if (!address) continue
    out.push({
      kind: "embedded",
      label: "Embedded wallet",
      chain,
      address,
      on: withdraw.status === "on",
      ...(withdraw.status === "off"
        ? { reason: withdraw.reason ?? "Turn on transfers from the embedded wallet in Settings > Transfers." }
        : {}),
      balances: (await deps.reads.balances(chain, address).catch(() => undefined)) ?? null,
    })
  }
  await deps.journal.append({ type: "transfer.sources", clientId: call.client.clientId, count: out.length })
  return { sources: out, vaultListed: wallets !== undefined, withdraw }
}

/** T-3: the server's allowed destinations for `embedded`, the user's own wallets for `vault`, and the hints. */
async function destinations(params: Record<string, unknown>, _call: CallContext, deps: TransferHandlerDeps) {
  const kind = (params.source as { kind?: unknown } | undefined)?.kind
  const chain = params.chain
  if (kind !== "vault" && kind !== "embedded") throw refused("INVALID_SOURCE", "source.kind is vault or embedded.")
  if (chain !== "solana" && chain !== "hood") throw refused("INVALID_CHAIN", "chain is solana or hood.")
  const out: Record<string, unknown>[] = []
  const push = (address: string, extra: Record<string, unknown>) => {
    if (out.some((row) => sameAddress(chain, row.address as string, address))) return
    out.push({ address, ...extra, sentBefore: deps.history.has(chain, address) })
  }
  if (kind === "embedded") {
    for (const row of await deps.reads.serverDestinations(chain)) {
      push(row.address, { serverClass: row.serverClass, ...(row.label ? { label: terminalText(row.label) } : {}) })
    }
  } else {
    for (const wallet of deps.trading.vaultWallets() ?? []) {
      if (walletChain(wallet) === chain) push(wallet.address, { label: terminalText(wallet.label), own: true })
    }
    const embedded = await embeddedAddress(deps, chain)
    if (embedded) push(embedded, { label: "Embedded wallet", own: true })
  }
  return { destinations: out }
}

/** T-4: validates, builds the preview, and creates the `transfer` card. */
async function prepare(params: Record<string, unknown>, call: CallContext, deps: TransferHandlerDeps) {
  const input = (params.params ?? params) as Record<string, unknown>
  if (input === null || typeof input !== "object") throw refused("INVALID_PARAMS", "params must be an object.")
  const parsed = await parseTransferInput(input, (chain, asset) => deps.reads.decimals(chain, asset))
  const decimals =
    "symbol" in parsed.asset
      ? BASE_ASSETS[parsed.asset.symbol].decimals
      : await deps.reads.decimals(parsed.chain, parsed.asset)
  if (decimals === undefined)
    throw refused("ASSET_UNREADABLE", "The asset's decimals could not be read; nothing was prepared.")

  let sourceLabel: string | undefined
  let serverClass: TransferDisplay["serverClass"]
  let toLabel: string | undefined
  let preview: VaultPreview | undefined
  let keyLimitUsd: string | undefined
  if (parsed.source.kind === "vault") {
    const wallets = deps.trading.vaultWallets()
    if (wallets === undefined) {
      throw refused("VAULT_WALLETS_NOT_LISTED", "List your vault wallets first (it asks for your factor once).")
    }
    const wallet = wallets.find(
      (candidate) =>
        walletChain(candidate) === parsed.chain &&
        sameAddress(parsed.chain, candidate.address, parsed.source.address) &&
        (parsed.source.walletId === undefined || candidate.id === parsed.source.walletId),
    )
    if (wallet === undefined) throw refused("INVALID_SOURCE", "That address is not a vault wallet on this machine.")
    parsed.source = { kind: "vault", walletId: wallet.id, address: wallet.address }
    sourceLabel = wallet.label
    try {
      preview = await deps.reads.previewVault(parsed, wallet)
    } catch (error) {
      const failure = error as { code?: unknown; message?: unknown }
      throw refused(
        typeof failure.code === "string" ? failure.code : "TRANSFER_PREVIEW_FAILED",
        `${terminalText(typeof failure.message === "string" ? failure.message : String(error))} Nothing was prepared.`,
      )
    }
  } else {
    const withdraw = deps.trading.withdrawState()
    if (withdraw.status !== "on") {
      throw refused(
        "EMBEDDED_TRANSFERS_OFF",
        withdraw.reason ?? "Transfers from the embedded wallet are off. Turn them on in Settings > Transfers.",
      )
    }
    const own = await embeddedAddress(deps, parsed.chain)
    if (own === undefined || !sameAddress(parsed.chain, own, parsed.source.address)) {
      throw refused("INVALID_SOURCE", "That address is not this account's embedded wallet.")
    }
    sourceLabel = "Embedded wallet"
    keyLimitUsd = formatKeyLimit({
      usdMicros: withdraw.limitUsdMicros,
      reset: withdraw.reset,
      usedUsdMicros: 0,
      readAt: 0,
    })?.replace(/, \$[\d.]+ left$/, "")
    const allowed = (await deps.reads.serverDestinations(parsed.chain)).find((row) =>
      sameAddress(parsed.chain, row.address, parsed.to),
    )
    if (allowed !== undefined) {
      serverClass = allowed.serverClass
      toLabel = allowed.label
      if (allowed.serverClass === "approved" && !("symbol" in parsed.asset)) {
        throw refused(
          "TRANSFER_DESTINATION_NOT_APPROVED",
          "A withdrawal to an allowlisted address sends a base asset only (SOL, USDC, CNDL, ETH or USDG). Nothing was prepared.",
          { serverRule: "approved_base_asset_only" },
        )
      }
    } else if (parsed.chain === "hood") {
      // A Privy-verified linked EVM address counts as own on the server but is in no list the key
      // can read; the server decides, and the card says so.
      serverClass = "unlisted"
    } else {
      throw refused(
        "TRANSFER_DESTINATION_NOT_APPROVED",
        "Candle sends from the embedded wallet only to your own wallets, trusted or session-linked wallets, or your withdrawal allowlist. Add this address in the Candle web app; the TUI does not change those lists. Nothing was prepared.",
        { serverRule: "own_linked_or_allowlist" },
      )
    }
  }

  const label = assetLabel(parsed.asset)
  const max = "max" in parsed.amount
  const raw = max ? (preview?.maxRaw ?? "") : (parsed.amount as { raw: string }).raw
  const decimal = max ? "max" : rawToDecimal(BigInt(raw), decimals)
  const display: TransferDisplay = {
    sourceKind: parsed.source.kind,
    source: parsed.source.address,
    ...(sourceLabel ? { sourceLabel } : {}),
    to: parsed.to,
    toGrouped: groupAddress(parsed.to),
    ...(toLabel ? { toLabel } : {}),
    ...(serverClass ? { serverClass } : {}),
    newDestination: !deps.history.has(parsed.chain, parsed.to),
    asset: { label, contract: assetContract(parsed.asset) },
    amount: {
      decimal,
      raw: max ? "max" : raw,
      ...(max ? { max: true } : {}),
      ...(max && preview?.maxRaw ? { balanceAtPreview: rawToDecimal(BigInt(preview.maxRaw), decimals) } : {}),
    },
    ...(preview?.feeEstimate ? { feeEstimate: preview.feeEstimate } : {}),
    ...(preview?.lines ? { previewLines: preview.lines.map((line) => terminalText(line)) } : {}),
    describeSend: describeSend(decimal === "max" ? "all" : decimal, label, parsed.to),
  }
  return deps.cards.createTransferCard({
    params: parsed,
    display: { ...display, ...(keyLimitUsd ? { keyLimitUsd } : {}) },
    origin: {
      clientId: call.client.clientId,
      role: call.client.role,
      clientName: call.client.clientName,
    },
  })
}
