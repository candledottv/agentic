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
 *
 * Phase 4b-2 (spec `2026-09-24-ember-phase-4b-hood-tee-wallets-design.md`, D9): from a Hood TEE
 * wallet, `--asset ETH|USDG` or `--token <0x...>`. The same destinations apply, with EVM addresses
 * compared case-blind. The one leg runs through the D4 leg loop: Candle sets its nonce and fees,
 * this machine checks the leg moves exactly what was confirmed to exactly that destination, the
 * relay signs it with `eth_signTransaction`, and Candle broadcasts it and reads its receipt.
 */
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { checkEvmAddress, decodeErc20Transfer, formatUnits, hexToBytes, sameEvmAddress } from "../evm-lite"
import { apiKeyPrefix } from "../profiles"
import { writeUsageFailure } from "../render"
import {
  BASES,
  chainMismatch,
  decimalAmount,
  HOOD_BASES,
  type Json,
  rawAmount,
  relaySign,
  request,
  runSequencedLegs,
  type SequencedLeg,
  safeText,
  sequencedSchema,
  type TradeChain,
  TradingError,
  type TradingWallet,
  tradingKey,
  tradingPayer,
  walletNameChain,
} from "../trading"
import { decimalsFor, hoodDecimals, lazyEvmRpc, lazySolanaClient, printTradingResult, tradingFailure } from "./swap"

const USAGE =
  "Usage: candle transfer --to <address|wallet name|vault> --asset <SOL|USDC|CNDL|ETH|USDG>|--mint <mint>|--token <0x...> --amount <decimal|max> [--wallet <name>] [--rpc-url <url>] [--yes] [--json]"

/** The base assets a linked-origin transfer may name by key; anything else is a `--mint` (Solana) or `--token` (Hood). */
const TRANSFER_ASSETS = [...Object.keys(BASES), ...Object.keys(HOOD_BASES)]

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
 * `vaultDestination` (read from its lifecycle); a value naming one of the account's active linked
 * wallets on the source's chain by label, id or address is that wallet; an address on that chain
 * that names none is sent as an address for Candle to classify; anything else is refused here,
 * before any build. On Hood (Phase 4b-2) addresses compare case-blind and go out checksummed.
 */
export async function resolveDestination(
  ctx: CommandContext,
  key: string,
  source: { id: string; address: string },
  to: string,
  chain: TradeChain = "solana",
): Promise<TransferDestination> {
  const hood = chain === "hood"
  const same = (a: string, b: string) => (hood ? sameEvmAddress(a, b) : a === b)
  if (to === "vault") {
    const lifecycle = await request(ctx, key, `/api/v1/agent/wallets/${encodeURIComponent(source.id)}/lifecycle`)
    const vault = lifecycle.vaultDestination
    if (typeof vault !== "string" || vault.length === 0)
      throw new TradingError(
        "VAULT_NOT_PINNED",
        "This wallet has no pinned vault recorded on Candle, so --to vault names nothing. Pass the address instead.",
      )
    if (!hood) return { kind: "vault", address: vault }
    const checked = checkEvmAddress(vault)
    if (!checked.ok)
      throw new TradingError(
        "INVALID_RESPONSE",
        "Candle recorded a vault for this Hood wallet that is not an EVM address; nothing was built.",
      )
    return { kind: "vault", address: checked.address }
  }
  const rowChain = hood ? "evm" : "solana"
  const rows = (await readLinkedWallets(ctx, key)).filter(
    (row) => row.chain === rowChain && row.revokedAt === undefined && !same(row.address, source.address),
  )
  const matches = rows.filter((row) => row.label === to || row._id === to || same(row.address, to))
  if (matches.length > 1)
    throw new TradingError(
      "DESTINATION_AMBIGUOUS",
      `"${to}" names ${matches.length} linked wallets: ${matches.map((row) => `${row.label ?? ""} (${row._id}, ${row.address})`.trim()).join("; ")}. Name one by id or address.`,
    )
  const match = matches[0]
  if (match)
    return { kind: "linked", address: match.address, id: match._id, ...(match.label ? { label: match.label } : {}) }
  if (same(to, source.address))
    throw new TradingError(
      "DESTINATION_IS_SOURCE",
      "--to names the wallet the funds would leave. Name a different destination.",
    )
  if (!hood && BASE58_ADDRESS.test(to)) return { kind: "address", address: to }
  const evm = hood ? checkEvmAddress(to) : undefined
  if (evm?.ok) return { kind: "address", address: evm.address }
  const name = hood ? "Hood" : "Solana"
  throw new TradingError(
    "DESTINATION_UNKNOWN",
    rows.length === 0
      ? `"${to}" is not vault, a ${name} address, or a linked wallet on this account (it has no other active ${name} linked wallets).`
      : `"${to}" is not vault, a ${name} address, or a linked wallet on this account. Linked wallets: ${rows.map((row) => `${row.label ?? ""} (${row._id}, ${row.address})`.trim()).join("; ")}.`,
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
    valueFlags: ["--wallet", "--to", "--asset", "--mint", "--token", "--amount", "--rpc-url"],
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
    [flags["--asset"], flags["--mint"], flags["--token"]].filter(Boolean).length !== 1 ||
    (asset !== undefined && !TRANSFER_ASSETS.includes(asset)) ||
    (flags["--mint"] !== undefined && !BASE58_ADDRESS.test(flags["--mint"])) ||
    (flags["--token"] !== undefined && !checkEvmAddress(flags["--token"]).ok)
  ) {
    writeUsageFailure(ctx.deps, USAGE, ctx.json)
    return 2
  }
  const to = flags["--to"]
  const isMax = flags["--amount"] === "max"
  try {
    // Phase 4b-2 (D6): the asset decides the chain, and a 0x --wallet or --to must agree, before any request.
    const chain: TradeChain =
      flags["--token"] !== undefined || (asset !== undefined && HOOD_BASES[asset]) ? "hood" : "solana"
    const named = walletNameChain(flags["--wallet"] ?? "")
    if (named !== undefined && named !== chain)
      throw chainMismatch(`--wallet ${safeText(flags["--wallet"])}`, named, chain)
    const toNamed = walletNameChain(to)
    if (toNamed !== undefined && toNamed !== chain)
      throw new TradingError(
        "CHAIN_MISMATCH",
        `--to ${safeText(to)} is a Hood address and ${asset ?? "this mint"} is on Solana; a transfer stays on one chain. Nothing was built.`,
      )
    if (chain === "hood") return await hoodTransfer(ctx, { flags, asset, to, isMax, yes: parsed.booleans.has("--yes") })
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

// ── Phase 4b-2: from a Hood TEE wallet (D9) ───────────────────────────────────────────────────

/**
 * Whether a leg moves exactly `amountRaw` of the asset to `to`: a plain ETH send (empty data,
 * that value) or the ERC-20's own `transfer(to, amountRaw)` with no ETH. Checked on every
 * sequenced leg before it is signed, so a later leg to another address or of another amount never is.
 */
export function transferLegMoves(
  leg: SequencedLeg,
  expected: { token: string | null; to: string; amountRaw: string },
): boolean {
  if (expected.token === null)
    return leg.data === "0x" && leg.value === expected.amountRaw && sameEvmAddress(leg.to, expected.to)
  if (leg.value !== "0" || !sameEvmAddress(leg.to, expected.token)) return false
  const decoded = decodeErc20Transfer(hexToBytes(leg.data))
  return (
    decoded !== undefined &&
    sameEvmAddress(decoded.recipient, expected.to) &&
    decoded.amount.toString() === expected.amountRaw
  )
}

async function hoodTransfer(
  ctx: CommandContext,
  args: { flags: Record<string, string>; asset: string | undefined; to: string; isMax: boolean; yes: boolean },
): Promise<number> {
  const { flags, asset, to, isMax } = args
  // ETH is native (null); USDG and a --token are ERC-20 contracts. --token was checked at parse.
  const checked = flags["--token"] === undefined ? undefined : checkEvmAddress(flags["--token"])
  const tokenAddress: string | null =
    asset !== undefined ? (HOOD_BASES[asset]?.address ?? null) : checked?.ok ? checked.address : null
  const label = asset ?? (tokenAddress as string)
  // Syntax before network access; a token's own precision is checked after its RPC read.
  if (!isMax) rawAmount(flags["--amount"] as string, 18)
  const key = await tradingKey(ctx)
  const payer = await tradingPayer(ctx, key, flags["--wallet"], "transfer:write", "hood")
  if (payer.kind === "embedded")
    throw new TradingError(
      "PAYER_UNSUPPORTED",
      "This command moves a linked wallet this machine can sign for. The embedded wallet transfers through the agent transfer rail (MCP candle_transfer), not from here. Name a Hood TEE wallet with --wallet.",
    )
  if (!payer.scopes.includes("transfer:bound"))
    throw new TradingError(
      "SCOPE_MISSING",
      `Moving funds out of a TEE wallet needs a Read:Write:Transfer key. Widen the bound key with: candle keys access ${apiKeyPrefix(key) ?? "<bound prefix>"} --access read-write-transfer. Or mint one with: candle keys create --access read-write-transfer, then bind the wallet to it with: candle tee rebind`,
    )
  const wallet: TradingWallet = payer.wallet
  const destination = await resolveDestination(ctx, key, wallet, to, "hood")
  const decimals = asset
    ? (HOOD_BASES[asset]?.decimals ?? 18)
    : await hoodDecimals({ chain: "hood", asset: tokenAddress as string }, lazyEvmRpc(ctx, flags["--rpc-url"]))
  const requested = isMax ? "max" : rawAmount(flags["--amount"] as string, decimals)
  const amountText = isMax ? `the full spendable balance of ${label}` : `${flags["--amount"]} ${label}`
  const confirmed = await confirmTransfer(
    ctx,
    [
      `Transfer ${amountText} on Hood from ${wallet.address} (${wallet.id}) to ${describeDestination(destination)}`,
      destination.kind === "vault"
        ? "Destination: this wallet's own vault, pinned when it was imported."
        : destination.kind === "linked"
          ? "Destination: a linked wallet on this account. Candle allows it only if you linked it while signed in or marked it trusted, only for ETH or USDG, and the amount counts against this key's spend caps."
          : "Destination: an address Candle will classify at build; from a TEE wallet only its vault or a trusted linked wallet is allowed.",
      ...(asset === "ETH"
        ? [
            "ETH keeps this send's gas and the sweep-home gas reserve in the wallet; Candle refuses an amount that would spend them.",
          ]
        : []),
    ],
    args.yes,
  )
  if (!confirmed)
    return printTradingResult(ctx, {
      success: true,
      status: "cancelled",
      chain: "hood",
      walletId: wallet.id,
      destination,
    })
  const built = await request(ctx, key, "/api/v1/agent/transfer/build", {
    walletId: wallet.id,
    chain: "hood",
    ...(asset ? { asset } : { mint: tokenAddress }),
    amountRaw: requested,
    to: destination.address,
  })
  // D4: a Hood TEE wallet signs one leg at a time; anything else is never signed from it.
  const parsed = sequencedSchema.safeParse(built)
  if (!parsed.success)
    throw new TradingError(
      "SEQUENCED_RAIL_REQUIRED",
      "A Hood TEE wallet transfers one leg at a time, and this Candle deployment did not answer with a sequenced leg. Nothing was signed.",
    )
  const first = parsed.data
  const transferId = built.transferId
  const amountRaw = typeof built.amountRaw === "string" && /^[1-9]\d*$/.test(built.amountRaw) ? built.amountRaw : null
  if (
    typeof transferId !== "string" ||
    typeof built.payerAddress !== "string" ||
    !sameEvmAddress(built.payerAddress, wallet.address) ||
    amountRaw === null ||
    (requested !== "max" && amountRaw !== requested)
  )
    throw new TradingError(
      "INVALID_RESPONSE",
      "The Hood transfer build does not name this payer and amount; nothing was signed.",
    )
  if (
    first.legKind !== "transfer" ||
    first.plannedLegCount !== 1 ||
    !transferLegMoves(first.nextLeg, { token: tokenAddress, to: destination.address, amountRaw })
  )
    throw new TradingError(
      "INVALID_RESPONSE",
      `The leg Candle built does not move ${decimalAmount(amountRaw, decimals)} ${label} to ${destination.address}; nothing was signed.`,
    )
  const leg = first.nextLeg
  const maxFee = BigInt(leg.maxFeePerGas)
  ctx.deps.stderr.write(
    `Built transfer ${safeText(transferId)}: ${decimalAmount(amountRaw, decimals)} ${safeText(label)}${typeof built.destinationKind === "string" ? ` to ${built.destinationKind === "vault" ? "the vault" : "a linked wallet"}` : ""}. Gas up to ${formatUnits(BigInt(leg.gas) * maxFee, 18)} ETH (gas ${leg.gas} at ${formatUnits(maxFee, 9)} gwei).\n`,
  )
  const run = await runSequencedLegs(ctx, key, {
    wallet,
    first,
    submitPath: "/api/v1/agent/transfer/submit",
    submitFields: { transferId },
    unwrap: (answer) => answer,
    primaryLeg: "transfer",
    allowedLegs: ["transfer"],
    checkLeg: (_kind, leg) => transferLegMoves(leg, { token: tokenAddress, to: destination.address, amountRaw }),
    onLanded: async () => {},
  })
  const receipt: Json = {
    ...run.final,
    transferId,
    chain: "hood",
    walletId: wallet.id,
    wallet: safeText(wallet.address),
    destination,
    ...(typeof built.destinationKind === "string" ? { destinationKind: built.destinationKind } : {}),
    operationId: first.operationId,
    landedLegs: run.landed,
  }
  return printTradingResult(ctx, receipt)
}
