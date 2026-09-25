/**
 * `candle transfer`: move one asset out of a linked wallet this machine can sign for, over the
 * transfer rail's linked-origin shape (Read:Write:Transfer spec, 2026-09-24, D6 / R19):
 *
 *   POST /agent/transfer/build  ->  POST /agent/wallets/:id/sign (relay)  ->  POST /agent/transfer/submit
 *
 * The payer is resolved exactly as `candle swap` resolves it (`tradingPayer`): a TEE wallet bound
 * to this profile's key, named by id, address or label, whose relay authorization key this
 * machine holds. Candle builds the transaction, this machine approves the relay request with that
 * key, Privy signs, and Candle broadcasts. No vault or TEE private key is ever opened here.
 *
 * Where the funds may go is Candle's decision, not this command's: from a TEE wallet, only that
 * wallet's own pinned vault or another of the account's wallets the owner linked while signed in
 * or marked trusted (the bound key must hold `transfer:bound`). The confirmation names the
 * destination and which of those it is, so the operator reads what they are approving.
 */
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { apiKeyPrefix } from "../profiles"
import { writeUsageFailure } from "../render"
import {
  BASES,
  decimalAmount,
  type Json,
  rawAmount,
  relaySign,
  request,
  safeText,
  TradingError,
  tradingKey,
  tradingPayer,
} from "../trading"
import { decimalsFor, lazySolanaClient, printTradingResult, tradingFailure } from "./swap"

const USAGE =
  "Usage: candle transfer --to <address|wallet name|vault> --asset <SOL|USDC|CNDL>|--mint <mint> --amount <decimal|max> [--wallet <name>] [--rpc-url <url>] [--yes] [--json]"

/** The base assets a Solana linked-origin transfer may name by key; anything else is a `--mint`. */
const TRANSFER_ASSETS = Object.keys(BASES)

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

/** The linked-wallet rows `GET /wallets` returns, the fields `--to <wallet name>` resolves by. */
interface LinkedWalletRow {
  _id: string
  address: string
  chain: string
  label?: string
  revokedAt?: number
}

/** Where the funds go, as this command resolved it. Candle classifies it again at build. */
export type TransferDestination =
  | { kind: "vault"; address: string }
  | { kind: "linked"; address: string; id: string; label?: string }
  | { kind: "address"; address: string }

/** Every page of the account's linked wallets, the same walk `candle wallets` makes. */
async function readLinkedWallets(ctx: CommandContext, key: string): Promise<LinkedWalletRow[]> {
  const rows: LinkedWalletRow[] = []
  let cursor: string | null = null
  const seen = new Set<string>()
  for (let page = 0; page < 25; page++) {
    const query = cursor === null ? "?limit=100" : `?limit=100&cursor=${encodeURIComponent(cursor)}`
    const body = await request(ctx, key, `/api/v1/agent/wallets${query}`)
    if (!Array.isArray(body.page)) throw new TradingError("INVALID_RESPONSE", "Wallet discovery did not return a page.")
    rows.push(...(body.page as LinkedWalletRow[]))
    if (body.isDone !== false || typeof body.continueCursor !== "string" || seen.has(body.continueCursor)) return rows
    seen.add(body.continueCursor)
    cursor = body.continueCursor
  }
  return rows
}

/**
 * `--to`, resolved in this order: the literal word `vault` is the source wallet's own pinned
 * `vaultDestination` (read from its lifecycle); a value naming one of the account's active Solana
 * linked wallets by label, id or address is that wallet; a base58 address that names none is sent
 * as an address for Candle to classify; anything else is refused here, before any build.
 */
export async function resolveDestination(
  ctx: CommandContext,
  key: string,
  source: { id: string; address: string },
  to: string,
): Promise<TransferDestination> {
  if (to === "vault") {
    const lifecycle = await request(ctx, key, `/api/v1/agent/wallets/${encodeURIComponent(source.id)}/lifecycle`)
    const vault = lifecycle.vaultDestination
    if (typeof vault !== "string" || vault.length === 0)
      throw new TradingError(
        "VAULT_NOT_PINNED",
        "This wallet has no pinned vault recorded on Candle, so --to vault names nothing. Pass the address instead.",
      )
    return { kind: "vault", address: vault }
  }
  const rows = (await readLinkedWallets(ctx, key)).filter(
    (row) => row.chain === "solana" && row.revokedAt === undefined && row.address !== source.address,
  )
  const matches = rows.filter((row) => row.label === to || row._id === to || row.address === to)
  if (matches.length > 1)
    throw new TradingError(
      "DESTINATION_AMBIGUOUS",
      `"${to}" names ${matches.length} linked wallets: ${matches.map((row) => `${row.label ?? ""} (${row._id}, ${row.address})`.trim()).join("; ")}. Name one by id or address.`,
    )
  const match = matches[0]
  if (match)
    return { kind: "linked", address: match.address, id: match._id, ...(match.label ? { label: match.label } : {}) }
  if (to === source.address)
    throw new TradingError(
      "DESTINATION_IS_SOURCE",
      "--to names the wallet the funds would leave. Name a different destination.",
    )
  if (BASE58_ADDRESS.test(to)) return { kind: "address", address: to }
  throw new TradingError(
    "DESTINATION_UNKNOWN",
    rows.length === 0
      ? `"${to}" is not vault, a Solana address, or a linked wallet on this account (it has no other active Solana linked wallets).`
      : `"${to}" is not vault, a Solana address, or a linked wallet on this account. Linked wallets: ${rows.map((row) => `${row.label ?? ""} (${row._id}, ${row.address})`.trim()).join("; ")}.`,
  )
}

/** One line naming the destination and which kind it is, for the confirmation and the receipt. */
export function describeDestination(destination: TransferDestination): string {
  switch (destination.kind) {
    case "vault":
      return `this wallet's pinned vault ${destination.address}`
    case "linked":
      return `linked wallet ${destination.label ? `${destination.label} ` : ""}(${destination.id}, ${destination.address})`
    case "address":
      return `address ${destination.address} (not one of this account's linked wallets; Candle decides whether it is allowed)`
  }
}

async function confirmTransfer(ctx: CommandContext, lines: string[], yes: boolean): Promise<boolean> {
  const output = ctx.json ? ctx.deps.stderr : ctx.deps.stdout
  for (const line of lines) output.write(`${safeText(line)}\n`)
  if (yes) return true
  if (!ctx.deps.isTTY.stdin)
    throw new TradingError(
      "CONFIRMATION_REQUIRED",
      "Run interactively to confirm, or use --yes for an ordinary transfer prompt.",
    )
  return (await ctx.deps.promptLine("Proceed? [y/N] ")).trim().toLowerCase() === "y"
}

export async function transfer(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--wallet", "--to", "--asset", "--mint", "--amount", "--rpc-url"],
    booleanFlags: ["--yes"],
  })
  if ("error" in parsed) {
    writeUsageFailure(ctx.deps, parsed.error, ctx.json)
    return 2
  }
  const flags = parsed.values
  const asset = flags["--asset"]?.toUpperCase()
  if (
    parsed.positionals.length !== 0 ||
    !flags["--to"] ||
    !flags["--amount"] ||
    Boolean(flags["--asset"]) === Boolean(flags["--mint"]) ||
    (asset !== undefined && !TRANSFER_ASSETS.includes(asset)) ||
    (flags["--mint"] !== undefined && !BASE58_ADDRESS.test(flags["--mint"]))
  ) {
    writeUsageFailure(ctx.deps, USAGE, ctx.json)
    return 2
  }
  const to = flags["--to"]
  const isMax = flags["--amount"] === "max"
  try {
    // Syntax before network access; the mint's own precision is checked after its RPC read.
    if (!isMax) rawAmount(flags["--amount"], 18)
    const key = await tradingKey(ctx)
    const payer = await tradingPayer(ctx, key, flags["--wallet"], "transfer:write")
    if (payer.kind === "embedded")
      throw new TradingError(
        "PAYER_UNSUPPORTED",
        "This command moves a linked wallet this machine can sign for. The embedded wallet transfers through the agent transfer rail (MCP candle_transfer), not from here. Name a TEE wallet with --wallet.",
      )
    if (!payer.scopes.includes("transfer:bound"))
      throw new TradingError(
        "SCOPE_MISSING",
        `Moving funds out of a TEE wallet needs a Read:Write:Transfer key. Widen the bound key with: candle keys access ${apiKeyPrefix(key) ?? "<bound prefix>"} --access read-write-transfer. Or mint one with: candle keys create --access read-write-transfer, then bind the wallet to it with: candle tee rebind`,
      )
    const wallet = payer.wallet
    const destination = await resolveDestination(ctx, key, wallet, to)
    const label = asset ?? (flags["--mint"] as string)
    let amountRaw: string
    if (isMax) amountRaw = "max"
    else {
      const decimals = asset
        ? (BASES[asset]?.decimals ?? 9)
        : await decimalsFor(ctx, flags["--mint"] as string, lazySolanaClient(ctx, flags["--rpc-url"]))
      amountRaw = rawAmount(flags["--amount"], decimals)
    }
    const amountText = isMax ? `the full spendable balance of ${label}` : `${flags["--amount"]} ${label}`
    const confirmed = await confirmTransfer(
      ctx,
      [
        `Transfer ${amountText} from ${wallet.address} (${wallet.id}) to ${describeDestination(destination)}`,
        destination.kind === "vault"
          ? "Destination: this wallet's own vault, pinned when it was imported."
          : destination.kind === "linked"
            ? "Destination: a linked wallet on this account. Candle allows it only if you linked it while signed in or marked it trusted, and the amount counts against this key's spend caps."
            : "Destination: an address Candle will classify at build; from a TEE wallet only its vault or a trusted linked wallet is allowed.",
      ],
      parsed.booleans.has("--yes"),
    )
    if (!confirmed)
      return printTradingResult(ctx, { success: true, status: "cancelled", walletId: wallet.id, destination })
    const built = await request(ctx, key, "/api/v1/agent/transfer/build", {
      walletId: wallet.id,
      chain: "solana",
      ...(asset ? { asset } : { mint: flags["--mint"] }),
      amountRaw,
      to: destination.address,
    })
    const transferId = built.transferId
    const unsigned = built.unsignedTransactionsBase64
    if (
      typeof transferId !== "string" ||
      !Array.isArray(unsigned) ||
      unsigned.length !== 1 ||
      typeof unsigned[0] !== "string"
    )
      throw new TradingError(
        "INVALID_RESPONSE",
        "Candle did not return one unsigned transfer transaction; nothing was signed.",
      )
    if (typeof built.payerAddress === "string" && built.payerAddress !== wallet.address)
      throw new TradingError(
        "INVALID_RESPONSE",
        "The transfer build does not name the requested payer; nothing was signed.",
      )
    const builtAmount = typeof built.amountRaw === "string" ? built.amountRaw : amountRaw
    ctx.deps.stderr.write(
      `Built transfer ${transferId}: ${asset ? `${decimalAmount(builtAmount, BASES[asset]?.decimals ?? 0)} ${asset}` : `${builtAmount} raw units of ${label}`}${typeof built.destinationKind === "string" ? ` to ${built.destinationKind === "vault" ? "the vault" : "a linked wallet"}` : ""}.\n`,
    )
    const signed = await relaySign(ctx, key, wallet, unsigned[0])
    const result = await request(ctx, key, "/api/v1/agent/transfer/submit", {
      transferId,
      signedTransactionsBase64: [signed],
    })
    const receipt: Json = {
      ...result,
      transferId,
      walletId: wallet.id,
      wallet: safeText(wallet.address),
      destination,
      ...(typeof built.destinationKind === "string" ? { destinationKind: built.destinationKind } : {}),
    }
    return printTradingResult(ctx, receipt)
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}
