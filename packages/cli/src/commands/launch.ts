import { randomUUID } from "node:crypto"
import { z } from "zod"
import { parseArgs } from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import {
  checkEvmAddress,
  type EvmReceipt,
  type EvmRpc,
  formatUnits,
  sameEvmAddress,
  toChecksumAddress,
} from "../evm-lite"
import {
  createCurveLegOk,
  curveCreatedBy,
  feeLegOk,
  hoodFeeTreasury,
  LAUNCH_FEE_MAX_BPS,
  launchBuyLegOk,
  launchFeeCap,
} from "../hood-legs"
import { BundleReadError, readLaunchBundle } from "../launch-bundle"
import { writeUsageFailure } from "../render"
import { postSignatureRateLimitMessage, postSignatureSuggestion } from "../solana-endpoint"
import { isRateLimited } from "../solana-lite"
import {
  BASES,
  chainName,
  claimOperation,
  confirmQuote,
  decimalAmount,
  HOOD_BASES,
  type Json,
  launchBuildSchema,
  payerSignature,
  type QuoteDisplay,
  rawAmount,
  relaySign,
  request,
  runSequencedLegs,
  type SequencedBody,
  safeText,
  savedOperation,
  saveOperationBundle,
  saveOperationSignature,
  sequencedSchema,
  sweepReserveFloor,
  type TradeChain,
  TradingError,
  TradingUsage,
  type TradingWallet,
  tradingKey,
  tradingSolanaClient,
  tradingWallet,
  walletNameChain,
} from "../trading"
import { type LocalImage, readLocalImage, uploadImage, uploadNotice } from "./image"
import {
  lazyEvmRpc,
  lookupOperation,
  printTradingResult,
  recordTradedToken,
  tradingFailure,
  validClientId,
} from "./swap"

const USAGE =
  "Usage: candle launch --name <name> --symbol <symbol> --image <path>|--image-url <https-url> --wallet <tee> [--buy <amount>] [--client-trade-id <id>] [--quote-asset sol|usdc|cndl|eth|usdg] [--dex-version v3|v4] [--mode <mode>] [--rpc-url <url>] [--yes]. A Hood TEE wallet launches on Hood and needs --dex-version."

/** The launch quote assets by chain, as the server's launch matrix lists them. */
const QUOTE_CHAIN: Record<string, TradeChain> = {
  sol: "solana",
  usdc: "solana",
  cndl: "solana",
  eth: "hood",
  usdg: "hood",
}

/**
 * A Hood TEE launch without `--buy` signs the curve and nothing else (D9): Candle charges its fee
 * on the first buy, so a launch with none has no fee leg.
 */
const HOOD_LAUNCH_LEGS = ["createCurve"] as const
/** With `--buy` (BE-869): the curve, Candle's fee when one applies, then its server-built curve buy. */
const HOOD_LAUNCH_BUY_LEGS = ["createCurve", "feeTransfer", "trade"] as const

/** A launch's first buy (BE-869): `--buy` in whole units of the quote asset, and the same in base units. */
interface LaunchBuy {
  raw: string
  display: string
}

/**
 * `--buy` converted as `candle swap` converts `--amount`: whole units of the launch's quote asset
 * (SOL by default on Solana, ETH on Hood) to its base units. Undefined without `--buy`, which
 * launches exactly as before.
 */
function launchBuy(flags: Record<string, string>, chain: TradeChain): LaunchBuy | undefined {
  const amount = flags["--buy"]
  if (amount === undefined) return undefined
  const quote = (flags["--quote-asset"] ?? (chain === "hood" ? "eth" : "sol")).toUpperCase()
  const decimals = chain === "hood" ? HOOD_BASES[quote]?.decimals : BASES[quote]?.decimals
  if (decimals === undefined)
    throw new TradingError(
      "INVALID_AMOUNT",
      `--buy is in the launch's quote asset, and ${safeText(quote)} is not one on ${chainName(chain)}. Nothing was built.`,
    )
  const raw = rawAmount(amount, decimals)
  return { raw, display: `${decimalAmount(raw, decimals)} ${quote}` }
}

/**
 * What `/launch/atomic/build` answers for a TEE creator while TEE_LAUNCH_BUYS_ENABLED is off
 * (BE-868): the payer resolver's refusal of a TEE wallet on the `launch` route class, on field
 * `linkedWalletId`. The route has no code of its own for it, so the CLI reads the message.
 */
const ATOMIC_TEE_REFUSAL = "This is a TEE wallet: agents may only trade it through the trade rail"

/**
 * The server's refusal of a TEE wallet's first buy, said plainly (BE-869). Candle takes a first
 * buy on a TEE launch only with TEE_LAUNCH_BUYS_ENABLED on. While it is off, `/launch/self/build`
 * (Hood) answers `VALIDATION_FAILED` on field `buyAmount`, and `/launch/atomic/build` (a Solana
 * `--buy`, BE-1721) refuses the TEE creator with `ATOMIC_TEE_REFUSAL`. Any other error passes
 * through as is.
 */
function buyRefusal(error: unknown): unknown {
  if (!(error instanceof TradingError) || error.code !== "VALIDATION_FAILED") return error
  const field = error.details?.field
  if (field !== "buyAmount" && !(field === "linkedWalletId" && error.message.includes(ATOMIC_TEE_REFUSAL))) return error
  return new TradingError(
    "VALIDATION_FAILED",
    `Candle refused the first buy on this TEE launch: ${safeText(error.message)}. A TEE wallet's launch takes --buy only where the server has TEE_LAUNCH_BUYS_ENABLED on, and it is off on this deployment. Nothing was built or signed.`,
    {
      suggestion:
        "Launch without --buy under a new --client-trade-id, then make the first buy with candle swap once the token lands.",
      details: error.details,
    },
  )
}

/** The line printed before the confirm: what the launch does about a first buy. */
function buyNotice(buy: LaunchBuy | undefined, chain: TradeChain): string {
  if (!buy)
    return "Launch creates the token only. Make the first buy with a separate candle swap. Price impact does not apply to creation.\n"
  return chain === "hood"
    ? `Launch creates the token, then spends ${buy.display} on a first buy on the new curve, as the last leg. Candle reserves the buy against this key's spend window before any leg is signed. If the buy leg never lands, the token exists with no first buy. Price impact does not apply to creation.\n`
    : `Launch creates the token, then spends ${buy.display} on a first buy from the same wallet as its own transaction. Both go to Candle as one Jito bundle: the launch and the first buy land together or not at all. The bundle pays a Jito tip from this wallet, inside the launch transaction. Candle reserves both against this key's spend window before anything is signed. Price impact does not apply to creation.\n`
}

/**
 * Phase 4b-2 (D6, D9): the wallet decides a launch's chain. Before any request, what the flags
 * already say must agree: a 0x `--wallet` is Hood, `--quote-asset` names its chain, and
 * `--dex-version` exists only on Hood. Undefined when nothing says.
 */
function flagChain(flags: Record<string, string>): TradeChain | undefined {
  const said: Array<[string, TradeChain]> = []
  const named = walletNameChain(flags["--wallet"] ?? "")
  if (named) said.push([`--wallet ${flags["--wallet"]}`, named])
  const quote = flags["--quote-asset"]
  const quoteChain = quote === undefined ? undefined : QUOTE_CHAIN[quote.toLowerCase()]
  if (quoteChain) said.push([`--quote-asset ${quote}`, quoteChain])
  if (flags["--dex-version"] !== undefined) said.push(["--dex-version", "hood"])
  const [first, ...rest] = said
  const other = rest.find(([, chain]) => chain !== first?.[1])
  if (first && other)
    throw new TradingError(
      "CHAIN_MISMATCH",
      `${safeText(first[0])} is ${chainName(first[1])} and ${safeText(other[0])} is ${chainName(other[1])}; a launch is on one chain. Nothing was built.`,
    )
  return first?.[1]
}

export async function launch(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: [
      "--name",
      "--symbol",
      "--image",
      "--image-url",
      "--description",
      "--wallet",
      "--client-trade-id",
      "--rpc-url",
      "--quote-asset",
      "--mode",
      "--dex-version",
      "--buy",
    ],
    booleanFlags: ["--yes"],
    pathFlags: ["--image"],
  })
  if ("error" in parsed) {
    writeUsageFailure(ctx.deps, parsed.error, ctx.json)
    return 2
  }
  const flags = parsed.values
  const id = flags["--client-trade-id"] ?? `launch-${randomUUID()}`
  // BE-1283: the image is a file on this machine or a hosted URL, exactly one of the two.
  if (flags["--image"] !== undefined && flags["--image-url"] !== undefined) {
    writeUsageFailure(
      ctx.deps,
      `Pass --image <path> or --image-url <https-url>, not both: a launch has one image. ${USAGE}`,
      ctx.json,
    )
    return 2
  }
  // The server's own rule (`imageUrl must be an https URL`), answered here with the way forward.
  if (flags["--image-url"] !== undefined && !flags["--image-url"].startsWith("https://")) {
    writeUsageFailure(
      ctx.deps,
      "--image-url takes an https:// URL; for an image file on this machine, use --image <path> instead.",
      ctx.json,
    )
    return 2
  }
  if (
    parsed.positionals.length ||
    !flags["--name"] ||
    !flags["--symbol"] ||
    (flags["--image"] === undefined && flags["--image-url"] === undefined) ||
    !flags["--wallet"] ||
    !validClientId(id) ||
    (flags["--dex-version"] !== undefined && flags["--dex-version"] !== "v3" && flags["--dex-version"] !== "v4")
  ) {
    writeUsageFailure(ctx.deps, USAGE, ctx.json)
    return 2
  }
  try {
    // Before any request, as `candle swap` checks `--amount`; the quote asset's decimals come later.
    if (flags["--buy"] !== undefined) rawAmount(flags["--buy"], 18)
    const hinted = flagChain(flags)
    if (hinted === "hood" && flags["--dex-version"] === undefined) {
      writeUsageFailure(ctx.deps, `A Hood launch needs --dex-version v3|v4. ${USAGE}`, ctx.json)
      return 2
    }
    // BE-1283: a file that is unreadable, over 10MB or not one of the four image types is refused
    // here, before any request. No launch id is involved yet, so the failure names none.
    let image: LocalImage | undefined
    try {
      if (flags["--image"] !== undefined) image = await readLocalImage(flags["--image"])
    } catch (error) {
      return tradingFailure(ctx, error)
    }
    const key = await tradingKey(ctx)
    const prior = await lookupOperation(ctx, key, id, "launch")
    /** BE-1721 (R4): a same-id re-run of an atomic launch whose bundle did not land, and the image it was built with. */
    let retry: { imageUrl?: string } | undefined
    if (prior) {
      const local = await savedOperation(ctx, key, id)
      const settled = prior.job?.status === "confirmed" || prior.job?.status === "failed"
      if (local?.bundleId) {
        // BE-1721 (R5): an atomic TEE launch saved its bundle before /submit. Only a bundle that
        // did not land is built again, under the same id, where the server starts a clean attempt.
        if (!atomicRetryable(prior, local)) return resumeAtomicLaunch(ctx, id, local, prior)
        retry = local.imageUrl !== undefined ? { imageUrl: local.imageUrl } : {}
        ctx.deps.stderr.write(
          `Bundle ${safeText(local.bundleId)} was never sent or did not land; building launch ${id} again under the same id.\n`,
        )
      } else {
        // Phase 4b-2: a Hood TEE launch saved its operation id with the leg's hash. It is recorded
        // from the legs the server sent, never from a broadcast signature.
        if (local?.operationId && !settled) return await resumeHoodLaunch(ctx, key, id, local.operationId, prior)
        if (local?.signature && !settled) {
          const result = await request(ctx, key, "/api/v1/launch/self/confirm", {
            clientLaunchId: id,
            signature: local.signature,
          })
          return printTradingResult(ctx, { ...result, clientTradeId: id, kind: "launch" })
        }
        return printTradingResult(ctx, prior)
      }
    }
    const wallet = await tradingWallet(ctx, key, flags["--wallet"], "launch:write", hinted ?? "any")
    const chain: TradeChain = wallet.chain === "evm" ? "hood" : "solana"
    if (chain === "hood" && flags["--dex-version"] === undefined)
      throw new TradingUsage(`${wallet.address} is a Hood TEE wallet, and a Hood launch needs --dex-version v3|v4.`)
    const buy = launchBuy(flags, chain)
    // BE-1721 (D1): a Solana TEE launch with a first buy is an atomic launch, the buy its own leg.
    // Its local refusals come here, before the upload and before the id is claimed.
    const atomic = chain === "solana" && buy !== undefined
    if (atomic) atomicPreflight(ctx, flags, wallet, buy)
    // Only a self-signed Solana launch reads an RPC (the atomic one is sent by Candle). Resolved
    // before the upload, so an endpoint that fails validation refuses the launch with nothing published.
    const solana = chain === "solana" && !atomic ? await tradingSolanaClient(ctx, flags["--rpc-url"]) : undefined
    // BE-1283: one upload, on a first run only (a resumed operation returned above), after every
    // refusal this machine can decide and before either chain claims the launch id. A failed upload
    // therefore leaves the id unused, and both chains build with the URL that came back.
    let imageUrl = flags["--image-url"] ?? ""
    // A same-id retry builds with the image the bundle was built with, without uploading again.
    if (image && retry?.imageUrl) imageUrl = retry.imageUrl
    else if (image) {
      ctx.deps.stderr.write(uploadNotice(image))
      try {
        imageUrl = await uploadImage(ctx, key, image)
      } catch (error) {
        ctx.deps.stderr.write(`The launch was not started, and its id ${id} is unused.\n`)
        return tradingFailure(ctx, error)
      }
      ctx.deps.stderr.write(`Image: ${safeText(imageUrl)}\n`)
    }
    // With --image the result carries the URL the launch was made with.
    const used: Json = image ? { imageUrl: safeText(imageUrl) } : {}
    if (atomic)
      return await atomicLaunch(ctx, key, {
        flags,
        id,
        wallet,
        buy,
        imageUrl,
        used,
        yes: parsed.booleans.has("--yes"),
        retry: retry !== undefined,
      })
    if (!solana)
      return await hoodLaunch(ctx, key, { flags, id, wallet, buy, imageUrl, used, yes: parsed.booleans.has("--yes") })
    if (!(await claimOperation(ctx, key, id, "launch")))
      throw new TradingError(
        "OPERATION_ALREADY_STARTED",
        "This machine already started this launch id; no write was resent.",
      )
    ctx.deps.stderr.write(`Operation: ${id}\n`)
    const built = launchBuildSchema.parse(
      await request(ctx, key, "/api/v1/launch/self/build", {
        clientLaunchId: id,
        chain: "solana",
        buyAmount: buy ? buy.raw : 0,
        name: flags["--name"],
        symbol: flags["--symbol"],
        imageUrl,
        linkedWalletId: wallet.id,
        ...(flags["--description"] ? { description: flags["--description"] } : {}),
        ...(flags["--quote-asset"] ? { quoteAsset: flags["--quote-asset"] } : {}),
        ...(flags["--mode"] ? { mode: flags["--mode"] } : {}),
      }).catch((error) => {
        throw buyRefusal(error)
      }),
    )
    if (!built.transaction || !/^\d+$/.test(built.maxDebitLamports ?? ""))
      throw new TradingError(
        "INVALID_RESPONSE",
        "Candle did not return a launch transaction and maximum debit; nothing was signed.",
      )
    const quote = {
      intent: `Launch ${flags["--name"]} (${flags["--symbol"]})${buy ? ` with a first buy of ${buy.display}` : ""}`,
      wallet: wallet.address,
      venue: "curve launch",
      priceImpactPct: null,
      fee: built.fee ?? { bps: 0, feeRaw: "0" },
      minimumReceived: buy ? "not quoted (the first buy on the new curve)" : "0 tokens (no first buy)",
      maxDebitLamports: built.maxDebitLamports,
      tokenRisks: [],
    }
    ctx.deps.stderr.write(buyNotice(buy, "solana"))
    if (!(await confirmQuote(ctx, quote, parsed.booleans.has("--yes"))))
      return printTradingResult(ctx, {
        success: true,
        status: "cancelled",
        clientTradeId: id,
        kind: "launch",
        quote,
        ...used,
      })
    if (!Number.isFinite(built.expiresAt) || built.expiresAt <= ctx.deps.now())
      throw new TradingError("QUOTE_EXPIRED", "The launch build expired before signing.")
    const signed = await relaySign(ctx, key, wallet, built.transaction)
    const signature = await saveOperationSignature(ctx, key, id, "launch", signed)
    let broadcastSignature: string
    try {
      broadcastSignature = await solana.rpc.sendTransaction(signed)
    } catch (error) {
      // BE-355 (D4): the signature is in the operation file, the client never re-sends, and the
      // transaction may still land. Exit 3; the resume path above confirms it and sends nothing.
      if (!isRateLimited(error)) throw error
      throw new TradingError(
        "RPC_RATE_LIMITED",
        `${postSignatureRateLimitMessage(signature)} Re-run with the same --client-trade-id ${id}: it confirms the saved signature and sends nothing new.`,
        { suggestion: postSignatureSuggestion(ctx), exitCode: 3 },
      )
    }
    if (broadcastSignature !== signature)
      throw new TradingError("RPC_FAILED", "RPC returned a different transaction signature; check the saved operation.")
    ctx.deps.stderr.write(`Launch signature: ${signature}\n`)
    const result = await request(ctx, key, "/api/v1/launch/self/confirm", { clientLaunchId: id, signature })
    return printTradingResult(ctx, { ...result, clientTradeId: id, kind: "launch", quote, ...used })
  } catch (error) {
    return tradingFailure(ctx, error, id)
  }
}

// ── BE-1721: a Solana TEE launch with a first buy, as an atomic launch ────────────────────────

/**
 * The self-launch dev-buy ceilings (spec 2026-10-20, D2), read as the API's `devBuyCeilings()`
 * reads them: the env value when it is a positive whole number, else the default. An atomic first
 * buy is not held to them server-side, so a TEE `--buy` keeps the ceiling it had on self-launch here.
 */
const DEV_BUY_CEILINGS: Record<string, { env: string; fallback: bigint; unit: string }> = {
  sol: { env: "DEV_BUY_MAX_LAMPORTS", fallback: 500_000_000n, unit: "lamports" },
  usdc: { env: "DEV_BUY_MAX_USDC_RAW", fallback: 500_000_000n, unit: "USDC raw units" },
  cndl: { env: "DEV_BUY_MAX_CNDL_RAW", fallback: 2_000_000_000_000n, unit: "CNDL raw units" },
}

function devBuyCeiling(env: Record<string, string | undefined>, quoteAsset: string): { ceiling: bigint; unit: string } {
  const bounds = DEV_BUY_CEILINGS[quoteAsset]
  if (!bounds)
    throw new TradingError(
      "DEV_BUY_UNSUPPORTED_FOR_PAIR",
      `An initial buy is not supported for ${safeText(quoteAsset)}-quoted solana launches`,
    )
  const raw = env[bounds.env]
  const value = raw && /^\d+$/.test(raw) ? BigInt(raw) : 0n
  return { ceiling: value > 0n ? value : bounds.fallback, unit: bounds.unit }
}

/**
 * Before the upload and the claim: the dev-buy ceiling (D2, in the API's own words) and the
 * `swap:write` scope the atomic route needs (R6), so a refusal here leaves the id unused.
 */
function atomicPreflight(
  ctx: CommandContext,
  flags: Record<string, string>,
  wallet: TradingWallet,
  buy: LaunchBuy,
): void {
  const quoteAsset = (flags["--quote-asset"] ?? "sol").toLowerCase()
  const { ceiling, unit } = devBuyCeiling(ctx.deps.env, quoteAsset)
  if (BigInt(buy.raw) > ceiling)
    throw new TradingError(
      "DEV_BUY_TOO_HIGH",
      `buyAmount exceeds the per-launch dev-buy ceiling of ${ceiling} ${unit} for ${quoteAsset} on solana`,
      { details: { field: "buyAmount" } },
    )
  if (wallet.scopes !== undefined && !wallet.scopes.includes("swap:write")) throw swapScopeRefusal()
}

function swapScopeRefusal(): TradingError {
  return new TradingError(
    "SCOPE_MISSING",
    "This key needs swap:write for a first buy on a TEE launch: the buy is its own leg in an atomic launch. Nothing was built or signed.",
    {
      suggestion:
        "Add swap:write to the key, or launch without --buy and make the first buy with candle swap once the token lands.",
    },
  )
}

/**
 * The atomic route's refusals that a TEE `--buy` meets, said plainly (R6). No refusal falls back to
 * a one-transaction build or to a separate buy: the launch is not made, and nothing was signed.
 */
function atomicRefusal(error: unknown): unknown {
  if (!(error instanceof TradingError)) return error
  if (error.code === "SCOPE_MISSING") return swapScopeRefusal()
  if (error.code === "VALIDATION_FAILED" && error.message.includes("configured Jito block engine"))
    return new TradingError(
      "VALIDATION_FAILED",
      "A TEE launch with --buy goes to Candle as one Jito bundle, and this Candle deployment has no Jito block engine configured. Nothing was built or signed.",
      {
        suggestion:
          "Launch without --buy under a new --client-trade-id, then make the first buy with candle swap once the token lands.",
      },
    )
  return buyRefusal(error)
}

const atomicLegSchema = z.object({
  index: z.number().int(),
  role: z.enum(["launch", "buy"]),
  signer: z.enum(["server", "client"]),
  unsignedTxBase64: z.string().min(1).optional(),
  expectedFill: z
    .object({ amountOutRaw: z.string().regex(/^\d+$/), minAmountOutRaw: z.string().regex(/^\d+$/).optional() })
    .passthrough()
    .optional(),
})
const atomicBuildSchema = z.object({
  bundleId: z.string().min(1),
  legs: z.array(atomicLegSchema),
  expiresAt: z.number().finite(),
})
/** `/launch/atomic/submit`'s three outcomes: `landed` is the 200 body, `failed` and `timeout` the 502 one. */
const atomicOutcomeSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("landed"), bundleId: z.string(), mint: z.string(), signatures: z.array(z.string()) })
    .passthrough(),
  z.object({ status: z.literal("failed"), bundleId: z.string(), retryable: z.boolean() }).passthrough(),
  z.object({ status: z.literal("timeout"), bundleId: z.string(), retryable: z.boolean() }).passthrough(),
])

/**
 * `candle launch --wallet <solana tee> --buy <amount>` (BE-1721, option D): one
 * `/launch/atomic/build` with this wallet as the creator and as the only first buyer (R1), the
 * quote read off the two legs (R2), both legs relay-signed in order and saved with the bundle
 * before one `/submit` (R3), and the bundle's outcome (R4). The CLI never sends a leg itself:
 * Candle relays the bundle to Jito, so the launch and the first buy land together or not at all.
 */
async function atomicLaunch(
  ctx: CommandContext,
  key: string,
  args: {
    flags: Record<string, string>
    id: string
    wallet: TradingWallet
    buy: LaunchBuy
    imageUrl: string
    used: Json
    yes: boolean
    /** A same-id retry after a bundle that did not land: the id is already this machine's. */
    retry: boolean
  },
): Promise<number> {
  const { flags, id, wallet, buy } = args
  if (!args.retry && !(await claimOperation(ctx, key, id, "launch")))
    throw new TradingError(
      "OPERATION_ALREADY_STARTED",
      "This machine already started this launch id; no write was resent.",
    )
  ctx.deps.stderr.write(`Operation: ${id}\n`)
  const payer = { type: "linked", linkedWalletId: wallet.id }
  const built = atomicBuildSchema.parse(
    await request(ctx, key, "/api/v1/launch/atomic/build", {
      clientLaunchId: id,
      chain: "solana",
      name: flags["--name"],
      symbol: flags["--symbol"],
      imageUrl: args.imageUrl,
      ...(flags["--description"] ? { description: flags["--description"] } : {}),
      ...(flags["--quote-asset"] ? { quoteAsset: flags["--quote-asset"] } : {}),
      ...(flags["--mode"] ? { mode: flags["--mode"] } : {}),
      payer,
      firstBuys: [{ payer, amountRaw: buy.raw }],
    }).catch((error) => {
      throw atomicRefusal(error)
    }),
  )
  const [launchLeg, buyLeg] = built.legs
  if (
    built.legs.length !== 2 ||
    launchLeg?.role !== "launch" ||
    buyLeg?.role !== "buy" ||
    built.legs.some((leg, index) => leg.index !== index || leg.signer !== "client" || !leg.unsignedTxBase64)
  )
    throw new TradingError(
      "INVALID_RESPONSE",
      "Candle did not return this wallet's launch leg and first-buy leg to sign; nothing was signed.",
    )
  const quoteAsset = (flags["--quote-asset"] ?? "sol").toUpperCase() as "SOL" | "USDC" | "CNDL"
  const decimals = BASES[quoteAsset]?.decimals ?? 9
  const minOut = buyLeg.expectedFill?.minAmountOutRaw
  let reading: ReturnType<typeof readLaunchBundle>
  try {
    reading = readLaunchBundle({
      legs: [launchLeg.unsignedTxBase64 as string, buyLeg.unsignedTxBase64 as string],
      wallet: wallet.address,
      quote: quoteAsset,
      buyRaw: BigInt(buy.raw),
      ...(minOut !== undefined ? { minOutRaw: BigInt(minOut) } : {}),
    })
  } catch (error) {
    if (!(error instanceof BundleReadError)) throw error
    throw new TradingError(
      "INVALID_RESPONSE",
      `The bundle Candle built does not read as this launch and its first buy: ${safeText(error.message)}. Nothing was signed.`,
    )
  }
  const sol = `${decimalAmount(reading.lamports.toString(), 9)} SOL`
  const quote: QuoteDisplay & Json = {
    intent: `Launch ${flags["--name"]} (${flags["--symbol"]}) with a first buy of ${buy.display}, as one Jito bundle`,
    wallet: wallet.address,
    venue: "curve launch (atomic bundle)",
    priceImpactPct: null,
    candleFee:
      reading.feeRaw > 0n
        ? `${decimalAmount(reading.feeRaw.toString(), decimals)} ${quoteAsset} (the tier fee on the first buy, in its leg)`
        : "none on this first buy",
    minimumReceived:
      minOut !== undefined ? `${minOut} raw units of the new token (the first buy's floor)` : "not quoted",
    maxLoss:
      quoteAsset === "SOL" ? sol : `${sol} and ${decimalAmount(reading.quoteRaw.toString(), decimals)} ${quoteAsset}`,
    tokenRisks: [],
    bundleId: built.bundleId,
  }
  // Saved before anything is signed: a re-run after a decline or a refused signature, which sent
  // nothing, builds again under the same id instead of stopping at the unsent build.
  await saveOperationBundle(ctx, key, id, {
    bundleId: built.bundleId,
    signatures: [],
    imageUrl: args.imageUrl,
    outcome: "unsigned",
  })
  ctx.deps.stderr.write(buyNotice(buy, "solana"))
  if (!(await confirmQuote(ctx, quote, args.yes))) {
    ctx.deps.stderr.write(
      `Nothing was signed. Candle holds bundle ${safeText(built.bundleId)}'s spend reservation until the build expires at ${new Date(built.expiresAt).toISOString()}.\n`,
    )
    return printTradingResult(ctx, {
      success: true,
      status: "cancelled",
      clientTradeId: id,
      kind: "launch",
      quote,
      ...args.used,
    })
  }
  if (!Number.isFinite(built.expiresAt) || built.expiresAt <= ctx.deps.now())
    throw new TradingError("QUOTE_EXPIRED", "The launch build expired before signing.")
  // R3: every leg relay-signed, in leg order. A refused signature submits nothing: the bundle
  // expires unseen and its hold goes back by the build's own rules.
  const signed: string[] = []
  for (const leg of built.legs) signed.push(await relaySign(ctx, key, wallet, leg.unsignedTxBase64 as string))
  const signatures = signed.map(payerSignature)
  const bundle = { bundleId: built.bundleId, signatures, imageUrl: args.imageUrl }
  await saveOperationBundle(ctx, key, id, bundle)
  ctx.deps.stderr.write(`Bundle: ${safeText(built.bundleId)} (launch ${signatures[0]}, first buy ${signatures[1]})\n`)
  const submitted = await apiRequest("/api/v1/launch/atomic/submit", {
    apiUrl: ctx.apiUrl,
    credentials: { apiKey: key },
    auth: "key",
    method: "POST",
    body: { bundleId: built.bundleId, signedTxsBase64: signed },
    fetch: ctx.deps.fetch,
    env: ctx.deps.env,
  })
  const outcome = atomicOutcomeSchema.safeParse(submitted.ok ? submitted.body : submitted.raw)
  const details = { bundleId: built.bundleId, signatures }
  if (!outcome.success || outcome.data.bundleId !== built.bundleId) {
    // A 4xx other than a conflict signed and sent nothing (the API's own contract), so a same-id
    // re-run may build again. Anything else, a lost answer included, may have sent the bundle.
    const refused = !submitted.ok && submitted.status >= 400 && submitted.status < 500 && submitted.status !== 409
    if (refused) await saveOperationBundle(ctx, key, id, { ...bundle, outcome: "refused" })
    throw new TradingError(
      submitted.ok ? "INVALID_RESPONSE" : (submitted.code ?? "REQUEST_FAILED"),
      refused
        ? `Candle refused bundle ${safeText(built.bundleId)} and sent nothing: ${safeText(submitted.ok ? "" : submitted.message)}. Re-run with the same --client-trade-id ${id} to build it again.`
        : `Bundle ${safeText(built.bundleId)} may have been sent, and its outcome is unknown${submitted.ok ? "" : `: ${safeText(submitted.message)}`}. Re-run with the same --client-trade-id ${id} to read it; nothing is re-signed or re-sent. Never relaunch under a new id: that would be a second token.`,
      { ...(refused ? {} : { exitCode: 3 as const }), details },
    )
  }
  await saveOperationBundle(ctx, key, id, { ...bundle, outcome: outcome.data.status })
  if (outcome.data.status === "failed")
    throw new TradingError(
      "BUNDLE_FAILED",
      `Bundle ${safeText(built.bundleId)} did not land: neither the launch nor its first buy is on chain. Retry with the same --client-trade-id ${id}; Candle starts a clean attempt under it.`,
      { details },
    )
  if (outcome.data.status === "timeout")
    throw new TradingError(
      "BUNDLE_UNRESOLVED",
      `Bundle ${safeText(built.bundleId)} is unresolved and may still land. Re-run with the same --client-trade-id ${id} to read its outcome; nothing is re-signed or re-sent. Never relaunch under a new id: that would be a second token.`,
      { exitCode: 3, details },
    )
  const [launchSignature, buySignature] = outcome.data.signatures
  ctx.deps.stderr.write(
    `Launched ${safeText(outcome.data.mint)}. Launch signature: ${safeText(launchSignature)}. First buy signature: ${safeText(buySignature)}.\n`,
  )
  return printTradingResult(ctx, {
    ...outcome.data,
    success: true,
    clientTradeId: id,
    kind: "launch",
    quote,
    ...args.used,
  })
}

/**
 * Whether a saved bundle's launch may be built again under its id: only once it is known not to
 * have landed. `unsigned` never reached `/submit`, `refused` was refused there with nothing sent,
 * and `failed` was answered by it. Signatures saved with no outcome may have been sent.
 */
function atomicRetryable(prior: Json & { job: { status: string } }, local: { bundleOutcome?: string }): boolean {
  if (prior.job.status === "confirmed") return false
  return prior.job.status === "failed" || ["unsigned", "refused", "failed"].includes(local.bundleOutcome ?? "")
}

/**
 * R5: a re-run of an atomic launch whose bundle may have landed re-signs nothing and re-sends
 * nothing. It reads the launch job for the id: `confirmed` is reported as the launch, and anything
 * else is unresolved (exit 3), as the first run's `timeout` was.
 */
function resumeAtomicLaunch(
  ctx: CommandContext,
  id: string,
  local: { bundleId?: string; bundleSignatures?: string[] },
  prior: Json & { job: { status: string } },
): number {
  const saved = { bundleId: local.bundleId, signatures: local.bundleSignatures ?? [] }
  if (prior.job.status === "confirmed") return printTradingResult(ctx, { ...prior, ...saved })
  throw new TradingError(
    "OPERATION_IN_FLIGHT",
    `Launch ${id}'s bundle ${safeText(local.bundleId)} is unresolved (the launch job is ${safeText(prior.job.status)}) and may still land. Nothing was re-signed or re-sent. Re-run with the same --client-trade-id to read it again; never relaunch under a new id, which would be a second token.`,
    { exitCode: 3, details: { ...saved, job: prior.job } },
  )
}

// ── Phase 4b-2: a launch from a Hood TEE wallet (D9) ──────────────────────────────────────────

/**
 * `candle launch --wallet <hood tee>`: the launch's legs (`createCurve`, then the fee when one
 * applies) run through the D4 leg loop, one at a time, each relay-signed with
 * `eth_signTransaction` and sent by Candle, which answers only after its receipt. Without `--buy`
 * the build's `buyAmount` is 0 and the first buy is a separate `candle swap`. With it (BE-869),
 * Candle adds its own curve buy as the last leg, for exactly that amount, and reserves it against
 * the key's spend window when the operation opens. Nothing here writes over a Hood RPC: the server
 * sets nonces and fees, broadcasts, and records the launch from the legs it sent. The leg checks
 * only read over it (the splitter, the treasury, and the createCurve receipt the buy is held to).
 */
async function hoodLaunch(
  ctx: CommandContext,
  key: string,
  args: {
    flags: Record<string, string>
    id: string
    wallet: TradingWallet
    buy?: LaunchBuy
    /** The image the build is made with: `--image-url`, or the URL `--image`'s upload returned. */
    imageUrl: string
    /** What the result carries beside the launch: the uploaded image's URL, with `--image`. */
    used: Json
    yes: boolean
  },
): Promise<number> {
  const { flags, id, wallet, buy } = args
  const allowedLegs = buy ? HOOD_LAUNCH_BUY_LEGS : HOOD_LAUNCH_LEGS
  if (!(await claimOperation(ctx, key, id, "launch")))
    throw new TradingError(
      "OPERATION_ALREADY_STARTED",
      "This machine already started this launch id; no write was resent.",
    )
  ctx.deps.stderr.write(`Operation: ${id}\n`)
  const built = await request(ctx, key, "/api/v1/launch/self/build", {
    clientLaunchId: id,
    chain: "hood",
    buyAmount: buy ? buy.raw : 0,
    name: flags["--name"],
    symbol: flags["--symbol"],
    imageUrl: args.imageUrl,
    linkedWalletId: wallet.id,
    dexVersion: flags["--dex-version"],
    ...(flags["--description"] ? { description: flags["--description"] } : {}),
    ...(flags["--quote-asset"] ? { quoteAsset: flags["--quote-asset"].toLowerCase() } : {}),
    ...(flags["--mode"] ? { mode: flags["--mode"] } : {}),
  }).catch((error) => {
    throw buyRefusal(error)
  })
  // D4: a Hood TEE wallet signs one leg at a time. An answer without the sequenced envelope is a
  // deployment that predates it, and its transaction is never signed from this wallet.
  const parsed = sequencedSchema.safeParse(built)
  if (!parsed.success)
    throw new TradingError(
      "SEQUENCED_RAIL_REQUIRED",
      "A Hood TEE wallet launches one leg at a time, and this Candle deployment did not answer with a sequenced leg. Nothing was signed.",
    )
  const first: SequencedBody = parsed.data
  const curve = typeof built.curveAddress === "string" ? checkEvmAddress(built.curveAddress) : undefined
  if (
    built.chain !== "hood" ||
    built.clientLaunchId !== id ||
    typeof built.walletAddress !== "string" ||
    !sameEvmAddress(built.walletAddress, wallet.address) ||
    !curve?.ok
  )
    throw new TradingError(
      "INVALID_RESPONSE",
      "The Hood launch build does not name this launch and payer; nothing was signed.",
    )
  // With --buy the plan must have room for the buy leg after the curve.
  if (
    first.legKind !== "createCurve" ||
    first.plannedLegCount > allowedLegs.length ||
    (buy !== undefined && first.plannedLegCount < 2)
  )
    throw new TradingError(
      "INVALID_RESPONSE",
      `A Hood launch starts with its createCurve leg, and Candle offered ${safeText(first.legKind)} of ${first.plannedLegCount}; nothing was signed.`,
    )
  const leg = first.nextLeg
  const maxFee = BigInt(leg.maxFeePerGas)
  const reserve = sweepReserveFloor(maxFee)
  const quote: QuoteDisplay & Json = {
    intent: `Launch ${flags["--name"]} (${flags["--symbol"]}) on Hood${buy ? ` with a first buy of ${buy.display}` : ""}`,
    wallet: wallet.address,
    venue: "curve launch",
    priceImpactPct: null,
    minimumReceived: buy ? "not quoted (Candle's buy leg sets its floor on the new curve)" : "0 tokens (no first buy)",
    tokenRisks: [],
    legs: hoodLaunchLegNames(first.plannedLegCount, buy !== undefined),
    gas: `the createCurve leg up to ${formatUnits(BigInt(leg.gas) * maxFee, 18)} ETH (gas ${leg.gas} at ${formatUnits(maxFee, 9)} gwei)${hoodLaterLegsGas(first.plannedLegCount, buy !== undefined)}`,
    reserve: `at least ${formatUnits(reserve.wei, 18)} ETH stays in the wallet for a sweep home (${reserve.erc20Transfers} ERC-20 transfers and the final ETH transfer at twice the fee)`,
    curveAddress: curve.address,
    operationId: first.operationId,
  }
  // The build does not echo the fee, so the quote shows the ceiling its leg is held to.
  const feeCap = buy && first.plannedLegCount === 3 ? launchFeeCap(buy.raw) : undefined
  if (feeCap !== undefined)
    quote.candleFee = `at most ${formatUnits(feeCap, 18)} ETH (the tier fee on the first buy, never above ${Number(LAUNCH_FEE_MAX_BPS) / 100}% of it)`
  ctx.deps.stderr.write(buyNotice(buy, "hood"))
  if (!(await confirmQuote(ctx, quote, args.yes))) {
    // The build holds the wallet (D4, one operation per wallet) until its window closes.
    ctx.deps.stderr.write(
      `Nothing was signed. Operation ${first.operationId} holds this wallet until ${new Date(first.expiresAt).toISOString()}; a new Hood operation from it is refused as WALLET_BUSY until then.\n`,
    )
    return printTradingResult(ctx, {
      success: true,
      status: "cancelled",
      clientTradeId: id,
      kind: "launch",
      chain: "hood",
      quote,
      operationId: first.operationId,
      walletHeldUntil: first.expiresAt,
      ...args.used,
    })
  }
  const confirmedPlan: readonly string[] | undefined = buy
    ? first.plannedLegCount === 3
      ? ["createCurve", "feeTransfer", "trade"]
      : ["createCurve", "trade"]
    : undefined
  let position = 0
  let createCurveHash: string | undefined
  let quotedCurve: Promise<string | undefined> | undefined
  const evm = lazyEvmRpc(ctx, flags["--rpc-url"])
  const run = await runSequencedLegs(ctx, key, {
    wallet,
    first,
    submitPath: "/api/v1/launch/self/confirm",
    submitFields: { clientLaunchId: id },
    unwrap: (answer) => answer,
    clientId: id,
    kind: "launch",
    primaryLeg: "createCurve",
    allowedLegs,
    // createCurve calls the pinned factory with no ETH and names this wallet the creator. The fee
    // is plain ETH, no more than the ceiling the quote showed, to the treasury the chain names. The
    // buy leg pays exactly the amount confirmed to the curve the quote showed, which must be the
    // one this launch's own createCurve made, as its receipt says. That is settled before the fee
    // is signed, so a buy that would be refused never costs the fee.
    onSigned: (kind, hash) => {
      if (kind === "createCurve") createCurveHash = hash
    },
    checkLeg: async (kind, leg) => {
      // The curve the createCurve receipt names, only if it is the one the quote showed; read once.
      const buyCurve = (): Promise<string | undefined> => {
        if (createCurveHash === undefined) return Promise.resolve(undefined)
        quotedCurve ??= launchedCurve(ctx, evm(), createCurveHash, wallet.address).then((created) =>
          created !== undefined && sameEvmAddress(created, curve.address) ? created : undefined,
        )
        return quotedCurve
      }
      // With a buy, the confirmed sequence is the only one signed: each leg must be the kind the
      // plan puts at its position, so a fee in the buy's slot or after it is never signed.
      if (confirmedPlan && confirmedPlan[position++] !== kind) return false
      if (kind === "createCurve") return await createCurveLegOk(leg, wallet.address, evm())
      if (kind === "feeTransfer") {
        if (feeCap === undefined) return false
        if (buy !== undefined && (await buyCurve()) === undefined) return false
        const treasury = await hoodFeeTreasury(evm())
        return treasury !== undefined && feeLegOk(leg, { cap: feeCap, asset: "eth", treasury })
      }
      if (kind !== "trade" || buy === undefined) return false
      const created = await buyCurve()
      return created !== undefined && launchBuyLegOk(leg, buy.raw, created)
    },
    onLanded: async () => {},
  })
  // A final answer before the buy landed is not the launch the user confirmed.
  if (confirmedPlan && run.landed.map((done) => done.kind).join() !== confirmedPlan.join())
    throw new TradingError(
      "INVALID_RESPONSE",
      `Candle ended the launch before every confirmed leg landed (${confirmedPlan.join(", ")}).${
        run.landed.length === 0
          ? " No leg landed."
          : ` Landed: ${run.landed.map((done) => `${done.kind} ${safeText(done.hash)}`).join(", ")}.`
      }`,
      { details: { operationId: first.operationId, landedLegs: run.landed } },
    )
  return printTradingResult(ctx, {
    ...run.final,
    ...(await recordLaunchedToken(ctx, wallet, run.final)),
    clientTradeId: id,
    kind: "launch",
    chain: "hood",
    quote,
    wallet: safeText(wallet.address),
    operationId: first.operationId,
    landedLegs: run.landed,
    ...args.used,
  })
}

/** How often a buy's check asks the RPC for the createCurve receipt Candle has already seen. */
const RECEIPT_ATTEMPTS = 5
const RECEIPT_RETRY_MS = 1_000

/**
 * The curve this launch's own createCurve made (`curveCreatedBy`), from its receipt over the
 * user's RPC. Candle answers only after it saw the receipt, so a missing one is a node a block or
 * two behind and is asked again, briefly; an RPC error is asked again the same way, and no receipt after the attempts refuses the buy.
 */
async function launchedCurve(
  ctx: CommandContext,
  rpc: EvmRpc,
  hash: string,
  wallet: string,
): Promise<string | undefined> {
  for (let attempt = 1; ; attempt++) {
    let receipt: EvmReceipt | null = null
    try {
      receipt = await rpc.getTransactionReceipt(hash)
    } catch {
      // A thrown read is asked again like a missing receipt.
    }
    if (receipt !== null) return curveCreatedBy(receipt, wallet)
    if (attempt >= RECEIPT_ATTEMPTS) return undefined
    await ctx.deps.sleep(RECEIPT_RETRY_MS)
  }
}

/** What the gas line says about the legs after createCurve, which Candle prices when each becomes next. */
function hoodLaterLegsGas(count: number, buys: boolean): string {
  return count < 2 || !buys ? "" : "; the later legs are priced by Candle when each becomes next"
}

/** The legs a Hood launch names before its confirm, from the planned count and whether it buys. */
function hoodLaunchLegNames(count: number, buys: boolean): string[] {
  if (!buys) return ["create curve"]
  return count === 3 ? ["create curve", "fee", "first buy"] : ["create curve", "first buy"]
}

/** D1: the launched token is one line of the sealed EVM record, so a later sweep finds it. */
async function recordLaunchedToken(ctx: CommandContext, wallet: TradingWallet, final: Json): Promise<Json> {
  const mint = typeof final.mint === "string" ? checkEvmAddress(final.mint) : undefined
  if (!mint?.ok) {
    const notice =
      "Notice: Candle did not name the launched token, so the sealed EVM record was not updated. The launch landed."
    ctx.deps.stderr.write(`${notice}\n`)
    return { evmRecord: { notices: [notice] } }
  }
  const token = toChecksumAddress(mint.address)
  const notice = await recordTradedToken(ctx, wallet.address, token)
  return { evmRecord: { token, notices: notice ? [notice] : [] } }
}

/**
 * A re-run of a Hood TEE launch this machine started. While the operation still holds the wallet
 * its leg may yet land, so nothing is posted: exit 3, as the first run did. Once it has let go,
 * `/confirm { operationId }` records the launch from the legs Candle sent; nothing is re-signed or
 * re-sent.
 */
async function resumeHoodLaunch(
  ctx: CommandContext,
  key: string,
  id: string,
  operationId: string,
  prior: Json & { job: { status: string } },
): Promise<number> {
  const operation = (prior.job as Json).operation as Json | undefined
  if (operation?.status === "active" && typeof operation.expiresAt === "number" && operation.expiresAt > ctx.deps.now())
    throw new TradingError(
      "OPERATION_IN_FLIGHT",
      `Operation ${operationId} still holds this wallet until ${new Date(operation.expiresAt).toISOString()}, and its leg may still land. Nothing was posted or re-sent.`,
      { exitCode: 3, details: { operationId, operation } },
    )
  const result = await request(ctx, key, "/api/v1/launch/self/confirm", { clientLaunchId: id, operationId })
  return printTradingResult(ctx, { ...result, clientTradeId: id, kind: "launch", chain: "hood", operationId })
}
