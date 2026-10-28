import { randomUUID } from "node:crypto"
import { z } from "zod"
import { type ArgSpec, parseArgs } from "../args"
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
import { writeFields } from "../human-output"
import { BundleReadError, readLaunchBundle } from "../launch-bundle"
import { launchCheck } from "../launch-check"
import { LAUNCH_DEFINITION } from "../launch-definition"
import { LAUNCH_IMAGE_FLAG, LAUNCH_USAGE, launchFieldProblem, launchFlagFields } from "../launch-options"
import { notice } from "../presentation"
import { writeUsageFailure } from "../render"
import { postSignatureRateLimitMessage, postSignatureSuggestion } from "../solana-endpoint"
import { isRateLimited } from "../solana-lite"
import {
  BASES,
  chainName,
  claimOperation,
  confirmQuote,
  decimalAmount,
  embeddedSchema,
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
import { poolRequestFields } from "./pool-options"
import {
  lazyEvmRpc,
  lookupOperation,
  printTradingResult,
  recordTradedToken,
  tradingFailure,
  validClientId,
} from "./swap"

export const USAGE = `Usage: ${LAUNCH_USAGE}`
const EMBEDDED_WALLET_NAMES = new Set<string>(LAUNCH_DEFINITION.wallet.embeddedNames)

export const LAUNCH_ARG_SPEC: ArgSpec = {
  valueFlags: [
    ...launchFlagFields.filter((field) => field.type !== "boolean").map((field) => field.cli.flag),
    LAUNCH_IMAGE_FLAG,
    "--rpc-url",
  ],
  booleanFlags: [
    ...launchFlagFields.filter((field) => field.type === "boolean").map((field) => field.cli.flag),
    "--check",
    "--yes",
  ],
  pathFlags: ["--image", "--banner"],
}

/** The launch quote assets by chain, as the server's launch matrix lists them. */
const QUOTE_CHAIN: Record<string, TradeChain> = LAUNCH_DEFINITION.quoteChains

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
function launchBuyRaw(amount: string, decimals: number): string {
  try {
    return rawAmount(amount, decimals)
  } catch (error) {
    if (!(error instanceof TradingError)) throw error
    throw new TradingError("VALIDATION_FAILED", error.message, { details: { field: "buyAmount" } })
  }
}

function launchBuy(flags: Record<string, string>, chain: TradeChain): LaunchBuy | undefined {
  const amount = flags["--buy"]
  if (amount === undefined || amount.trim() === "" || /^0+(\.0+)?$/.test(amount)) return undefined
  const quote = (flags["--quote-asset"] ?? LAUNCH_DEFINITION.defaultQuote[chain]).toUpperCase()
  const decimals = LAUNCH_DEFINITION.quoteDecimals[quote.toLowerCase() as keyof typeof LAUNCH_DEFINITION.quoteDecimals]
  if (decimals === undefined)
    throw new TradingError(
      "INVALID_AMOUNT",
      `--buy is in the launch's quote asset, and ${safeText(quote)} is not one on ${chainName(chain)}. Nothing was built.`,
    )
  const raw = launchBuyRaw(amount, decimals)
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
  return new TradingError("VALIDATION_FAILED", error.message, {
    suggestion:
      "Launch without --buy under a new --client-trade-id, then make the first buy with candle swap once the token lands.",
    details: error.details,
  })
}

/**
 * BE-1806: what is wrong with `--mode`'s companions, before any request, or undefined. `--curve-v`
 * and `--curve-g` are exp-custom's V and G, in whole units of the quote asset, and go together;
 * `--creator-fee-bps` is 0, 100 or 200 on an exp- mode. The API checks the curve's limits.
 */
function curveFlagProblem(flags: Record<string, string>): string | undefined {
  const mode = flags["--mode"]
  const v = flags["--curve-v"]
  const g = flags["--curve-g"]
  if ((v === undefined) !== (g === undefined)) return "--curve-v and --curve-g go together: a curve is its V and its G."
  if (v !== undefined && mode !== "exp-custom") return "--curve-v and --curve-g take --mode exp-custom."
  if (mode === "exp-custom" && v === undefined)
    return "--mode exp-custom needs --curve-v and --curve-g: the curve's V and G in whole units of the quote asset."
  const fee = flags["--creator-fee-bps"]
  if (fee !== undefined && !mode?.startsWith("exp-")) return "--creator-fee-bps takes an exp- --mode."
  return undefined
}

/** The curve fields of every launch body (BE-1806): exp-custom's curve and an exp- mode's extra creator fee. */
function launchCurveFields(flags: Record<string, string>): Json {
  return {
    ...(flags["--curve-v"] !== undefined && flags["--curve-g"] !== undefined
      ? { curve: { virtualQuote: flags["--curve-v"], threshold: flags["--curve-g"] } }
      : {}),
    ...(flags["--creator-fee-bps"] !== undefined ? { creatorFeeBps: Number(flags["--creator-fee-bps"]) } : {}),
  }
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
  const parsed = parseArgs(
    args.map((arg, index) => (args[index - 1] === "--buy" && arg.trim() === "" ? "0" : arg)),
    LAUNCH_ARG_SPEC,
  )
  if ("error" in parsed) {
    writeUsageFailure(ctx.deps, parsed.error, ctx.json)
    return 2
  }
  const flags = parsed.values
  if (flags["--quote-asset"]) flags["--quote-asset"] = flags["--quote-asset"].toLowerCase()
  const id = flags["--client-trade-id"] ?? `launch-${randomUUID()}`
  const embedded = EMBEDDED_WALLET_NAMES.has(flags["--wallet"] ?? "")
  const dryRun = parsed.booleans.has("--dry-run")
  // BE-2139 (surfaces item B): --check is the preflight that stops before anything is sent.
  const check = parsed.booleans.has("--check")
  if (check && dryRun) {
    writeUsageFailure(ctx.deps, `--check and --dry-run are two different stops; pass one. ${USAGE}`, ctx.json)
    return 2
  }
  const fieldProblem = launchFieldProblem(flags)
  if (fieldProblem) {
    writeUsageFailure(ctx.deps, fieldProblem, ctx.json)
    return 2
  }
  const curveProblem = curveFlagProblem(flags)
  if (curveProblem) {
    writeUsageFailure(ctx.deps, `${curveProblem} ${USAGE}`, ctx.json)
    return 2
  }
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
    flags["--banner"] &&
    /^[a-z][a-z0-9+.-]*:\/\//i.test(flags["--banner"]) &&
    !flags["--banner"].startsWith("https://")
  ) {
    writeUsageFailure(ctx.deps, "--banner takes a local file or an https:// URL.", ctx.json)
    return 2
  }
  // A preflight names no token: --name, --symbol, --image and --wallet stay optional under --check,
  // and everything below it reads and sends nothing a launch would.
  const missingRequired =
    !flags["--name"] ||
    !flags["--symbol"] ||
    (flags["--image"] === undefined && flags["--image-url"] === undefined) ||
    !flags["--wallet"]
  if (parsed.positionals.length || (!check && missingRequired) || !validClientId(id)) {
    writeUsageFailure(ctx.deps, USAGE, ctx.json)
    return 2
  }
  try {
    poolRequestFields(flags)
  } catch (error) {
    writeUsageFailure(ctx.deps, `${(error as Error).message}. ${USAGE}`, ctx.json)
    return 2
  }
  try {
    // Before any request, as `candle swap` checks `--amount`; the quote asset's decimals come later.
    if (flags["--buy"]?.trim() && !/^0+(\.0+)?$/.test(flags["--buy"])) launchBuyRaw(flags["--buy"], 18)
    const hinted = flagChain(flags)
    if (!check && hinted === "hood" && flags["--dex-version"] === undefined) {
      writeUsageFailure(ctx.deps, `A Hood launch needs --dex-version v3|v4. ${USAGE}`, ctx.json)
      return 2
    }
    // BE-1283: a file that is unreadable, over 10MB or not one of the four image types is refused
    // here, before any request. No launch id is involved yet, so the failure names none. Under
    // --check nothing is read: the preflight answers before the image exists.
    let image: LocalImage | undefined
    let banner: LocalImage | undefined
    if (!check) {
      try {
        if (flags["--image"] !== undefined) image = await readLocalImage(flags["--image"])
        if (flags["--banner"] && !flags["--banner"].startsWith("https://"))
          banner = await readLocalImage(flags["--banner"])
      } catch (error) {
        return tradingFailure(ctx, error)
      }
    }
    const key = await tradingKey(ctx)
    // BE-2139 (surfaces item B): the one preflight call, before any upload, build or id claim.
    if (check) return await launchCheck(ctx, key, flags["--wallet"], hinted)
    // A dry run reads no operation and resumes none: it records nothing under the id.
    const prior = dryRun ? null : await lookupOperation(ctx, key, id, "launch")
    /** BE-1721 (R4): a same-id re-run of an atomic launch whose bundle did not land, and the image it was built with. */
    let retry: { imageUrl?: string; bannerUrl?: string } | undefined
    if (prior) {
      const local = await savedOperation(ctx, key, id)
      const settled = prior.job?.status === "confirmed" || prior.job?.status === "failed"
      if (local?.bundleId) {
        // BE-1721 (R5): an atomic launch (TEE or embedded) saved its bundle before /submit. Only a
        // bundle that did not land is built again, under the same id, where the server starts a
        // clean attempt.
        if (!atomicRetryable(prior, local)) return resumeAtomicLaunch(ctx, id, local, prior)
        retry = { imageUrl: local.imageUrl, bannerUrl: local.bannerUrl }
        notice(
          ctx.deps,
          "stderr",
          "warning",
          `Bundle ${safeText(local.bundleId)} was never sent or did not land; building launch ${id} again under the same id.\n`.trim(),
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
        if (embedded && !settled)
          throw new TradingError(
            "OPERATION_IN_FLIGHT",
            `Launch ${id} is ${safeText(prior.job.status)} and may still land. Re-run with the same --client-trade-id; nothing was re-sent.`,
            { exitCode: 3, details: { job: prior.job } },
          )
        return printTradingResult(ctx, prior)
      }
    }
    if (embedded)
      return await embeddedLaunch(ctx, key, {
        flags,
        id,
        image,
        banner,
        retry,
        yes: parsed.booleans.has("--yes"),
        dryRun,
      })
    // Past --check, the required-flags refusal above guarantees --wallet is present.
    const wallet = await tradingWallet(ctx, key, flags["--wallet"] ?? "", "launch:write", hinted ?? "any")
    const chain: TradeChain = wallet.chain === "evm" ? "hood" : "solana"
    if (chain === "hood" && flags["--dex-version"] === undefined)
      throw new TradingUsage(`${wallet.address} is a Hood TEE wallet, and a Hood launch needs --dex-version v3|v4.`)
    const buy = launchBuy(flags, chain)
    if (chain === "hood" && Object.keys(poolRequestFields(flags)).length)
      throw new TradingUsage("Pool fee and pool shape choices are Solana only; a Hood launch cannot take them.")
    // BE-1721 (D1): a Solana TEE launch with a first buy is an atomic launch, the buy its own leg.
    // Its local refusals come here, before the upload and before the id is claimed.
    const atomic = chain === "solana" && buy !== undefined
    if (atomic) firstBuyCeiling(ctx, flags, buy)
    // Only a self-signed Solana launch reads an RPC (the atomic one is sent by Candle). Resolved
    // before the upload, so an endpoint that fails validation refuses the launch with nothing published.
    const solana =
      chain === "solana" && !atomic && !dryRun ? await tradingSolanaClient(ctx, flags["--rpc-url"]) : undefined
    const uploaded = await uploadLaunchImages(ctx, key, { flags, id, image, banner, retry })
    if (typeof uploaded === "number") return uploaded
    const { imageUrl, bannerUrl, used } = uploaded
    // BE-1806: the dry run sends the body the launch would build, to the route's dry run, and stops.
    if (dryRun) return await dryRunLaunch(ctx, key, { flags, id, wallet, chain, buy, imageUrl, bannerUrl, used })
    if (atomic)
      return await atomicLaunch(ctx, key, {
        flags,
        id,
        wallet,
        buy,
        imageUrl,
        bannerUrl,
        used,
        yes: parsed.booleans.has("--yes"),
        retry: retry !== undefined,
      })
    if (!solana)
      return await hoodLaunch(ctx, key, {
        flags,
        id,
        wallet,
        buy,
        imageUrl,
        bannerUrl,
        used,
        yes: parsed.booleans.has("--yes"),
      })
    if (!(await claimOperation(ctx, key, id, "launch")))
      throw new TradingError(
        "OPERATION_ALREADY_STARTED",
        "This machine already started this launch id; no write was resent.",
      )
    writeFields(ctx.deps, "stderr", [["Operation", id]])
    const built = launchBuildSchema.parse(
      await request(
        ctx,
        key,
        "/api/v1/launch/self/build",
        solanaSelfBody({ flags, id, wallet, buy, imageUrl, bannerUrl }),
      ).catch((error) => {
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
    notice(ctx.deps, "stderr", "note", buyNotice(buy, "solana").trim())
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
    // A dry run started nothing under the id, and neither did --check, so those refusals name no
    // operation to check.
    return tradingFailure(ctx, error, dryRun || check ? undefined : id)
  }
}

/** The images a launch was made with, and the fields its result reports them in. */
interface LaunchImages {
  imageUrl: string
  bannerUrl?: string
  used: Json
}

/**
 * BE-1283: one upload, on a first run only (a resumed operation returned before this), after every
 * refusal this machine can decide and before either chain claims the launch id. A failed upload
 * therefore leaves the id unused, and both chains build with the URL that came back. Returns the
 * exit code instead when an upload failed.
 */
async function uploadLaunchImages(
  ctx: CommandContext,
  key: string,
  args: {
    flags: Record<string, string>
    id: string
    image?: LocalImage
    banner?: LocalImage
    retry?: { imageUrl?: string; bannerUrl?: string }
  },
): Promise<LaunchImages | number> {
  const { flags, id, image, banner, retry } = args
  let imageUrl = flags["--image-url"] ?? ""
  // A same-id retry builds with the image the bundle was built with, without uploading again.
  if (image && retry?.imageUrl) imageUrl = retry.imageUrl
  else if (image) {
    notice(ctx.deps, "stderr", "note", uploadNotice(image).trim())
    try {
      imageUrl = await uploadImage(ctx, key, image)
    } catch (error) {
      notice(ctx.deps, "stderr", "note", `The launch was not started, and its id ${id} is unused.\n`.trim())
      return tradingFailure(ctx, error)
    }
    ctx.deps.stderr.write(`Image: ${safeText(imageUrl)}\n`)
  }
  // A retry keeps the original banner, including its absence, so the id's request stays stable.
  let bannerUrl = retry ? retry.bannerUrl : flags["--banner"]?.startsWith("https://") ? flags["--banner"] : undefined
  if (banner && !retry) {
    notice(ctx.deps, "stderr", "note", uploadNotice(banner).trim())
    try {
      bannerUrl = await uploadImage(ctx, key, banner, "banner")
    } catch (error) {
      notice(ctx.deps, "stderr", "note", `The launch was not started, and its id ${id} is unused.\n`.trim())
      return tradingFailure(ctx, error)
    }
    ctx.deps.stderr.write(`Banner: ${safeText(bannerUrl)}\n`)
  }
  // With --image the result carries the URL the launch was made with.
  const used: Json = {
    ...(image ? { imageUrl: safeText(imageUrl) } : {}),
    ...(bannerUrl ? { bannerUrl: safeText(bannerUrl) } : {}),
  }
  return { imageUrl, ...(bannerUrl ? { bannerUrl } : {}), used }
}

// ── BE-1806: the three launch bodies, and the dry run that sends them ─────────────────────────

/** What every launch body is built from. */
interface LaunchBodyArgs {
  flags: Record<string, string>
  id: string
  wallet: TradingWallet
  buy?: LaunchBuy
  imageUrl: string
  bannerUrl?: string
}

/** Optional metadata is identical on every launch route. */
function launchMetadataFields(flags: Record<string, string>): Json {
  const socials = Object.fromEntries(
    launchFlagFields
      .filter((field) => field.key.startsWith("socials.") && flags[field.cli.flag] !== undefined)
      .map((field) => [field.key.slice("socials.".length), flags[field.cli.flag]?.trim()]),
  )
  return {
    ...(Object.keys(socials).length ? { socials } : {}),
    ...(flags["--staker-allocation-bps"] !== undefined
      ? { stakerAllocationBps: Number(flags["--staker-allocation-bps"]) }
      : {}),
    ...(flags["--visibility"] !== undefined ? { visibility: flags["--visibility"] } : {}),
  }
}

/** The fields the three bodies share: the token, the image, and the curve it launches on. */
function launchFields(args: LaunchBodyArgs): Json {
  const { flags } = args
  return {
    clientLaunchId: args.id,
    name: flags["--name"],
    symbol: flags["--symbol"],
    imageUrl: args.imageUrl,
    ...(args.bannerUrl ? { bannerUrl: args.bannerUrl } : {}),
    ...(flags["--description"] ? { description: flags["--description"] } : {}),
    ...(flags["--mode"] ? { mode: flags["--mode"] } : {}),
    ...launchCurveFields(flags),
    ...launchMetadataFields(flags),
    // Solana graduation choices; a Hood launch refuses these flags before any body is built.
    ...poolRequestFields(flags),
  }
}

/** `/launch/self/build` (and its dry run) on Solana: the dev buy rides in the launch transaction. */
function solanaSelfBody(args: LaunchBodyArgs): Json {
  const quoteAsset = args.flags["--quote-asset"]
  return {
    ...launchFields(args),
    chain: "solana",
    buyAmount: args.buy ? args.buy.raw : 0,
    linkedWalletId: args.wallet.id,
    ...(quoteAsset ? { quoteAsset } : {}),
  }
}

/** `/launch/self/build` (and its dry run) on Hood. */
function hoodBody(args: LaunchBodyArgs): Json {
  const quoteAsset = args.flags["--quote-asset"]
  return {
    ...launchFields(args),
    chain: "hood",
    buyAmount: args.buy ? args.buy.raw : 0,
    linkedWalletId: args.wallet.id,
    dexVersion: args.flags["--dex-version"],
    ...(quoteAsset ? { quoteAsset: quoteAsset.toLowerCase() } : {}),
  }
}

const previewSchema = z
  .object({
    resolved: z.object({ mode: z.string(), quoteAsset: z.string() }).passthrough().optional(),
    curveTerms: z
      .object({
        symbol: z.string(),
        raise: z.number(),
        startFdv: z.number(),
        bondingFdv: z.number(),
        supplySoldPct: z.number(),
        firstBuy: z
          .object({ basis: z.string(), amountRaw: z.string(), supplyPct: z.number() })
          .passthrough()
          .optional(),
        fees: z
          .object({ curve: z.object({ feeBps: z.number() }), pool: z.object({ feeBps: z.number() }) })
          .passthrough()
          .optional(),
        migration: z
          .object({ venue: z.string(), poolShape: z.string(), openingPriceStepPct: z.number() })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    devBuyMax: z.string().nullable().optional(),
    fills: z
      .array(z.object({ index: z.number(), amountRaw: z.string(), supplyPct: z.number() }).passthrough())
      .optional(),
  })
  .passthrough()

const percent = (value: number) => `${Number(value.toFixed(4))}%`

/** The dry run's preview in a few lines for stderr; --json reads the whole answer on stdout. Absent fields print nothing. */
function previewLines(answer: Json, chain: TradeChain): string {
  const parsed = previewSchema.safeParse(answer)
  if (!parsed.success) return ""
  const { resolved, curveTerms: terms, devBuyMax, fills } = parsed.data
  const quote = (resolved?.quoteAsset ?? LAUNCH_DEFINITION.defaultQuote[chain]).toUpperCase()
  const decimals = (chain === "hood" ? HOOD_BASES[quote] : BASES[quote])?.decimals
  const whole = (raw: string) => (decimals === undefined ? `${raw} raw` : `${shortAmount(raw, decimals)} ${quote}`)
  const lines: string[] = []
  if (terms) {
    lines.push(
      `Curve${resolved ? ` (${safeText(resolved.mode)})` : ""}: raises ${terms.raise} ${safeText(terms.symbol)}; market cap ${terms.startFdv} at start and ${terms.bondingFdv} at graduation; ${percent(terms.supplySoldPct)} of the supply sold by graduation.`,
    )
    if (terms.firstBuy)
      lines.push(
        `First buy (${terms.firstBuy.basis === "buyAmount" ? "your --buy" : "a reference buy"}): ${whole(terms.firstBuy.amountRaw)} takes ${percent(terms.firstBuy.supplyPct)} of the supply after the curve fee.`,
      )
    if (terms.fees)
      lines.push(
        `Fees: ${terms.fees.curve.feeBps / 100}% on the curve, ${terms.fees.pool.feeBps / 100}% in the pool after graduation.`,
      )
    if (terms.migration)
      lines.push(
        `Graduation: a ${safeText(terms.migration.poolShape)} pool on ${safeText(terms.migration.venue)}, opening ${percent(terms.migration.openingPriceStepPct)} against the curve's last price, its liquidity locked for good.`,
      )
  }
  for (const fill of fills ?? [])
    lines.push(`First buy ${fill.index}: ${whole(fill.amountRaw)} takes ${percent(fill.supplyPct)} of the supply.`)
  if (devBuyMax) lines.push(`Dev-buy ceiling: ${whole(devBuyMax)}.`)
  return lines.length ? `${lines.join("\n")}\n` : ""
}

/**
 * `candle launch ... --dry-run` (BE-1806): the body the launch would build, sent to the route's dry
 * run (`/launch/self/dry-run`, with or without a first buy),
 * after this machine's own refusals and the image upload. Nothing is claimed, built, signed or
 * recorded, and the id stays unused. The upload, with --image, still happens: the dry run checks
 * the image by its URL.
 */
async function dryRunLaunch(
  ctx: CommandContext,
  key: string,
  args: LaunchBodyArgs & { chain: TradeChain; used: Json },
): Promise<number> {
  const { chain } = args
  const path = "/api/v1/launch/self/dry-run"
  const body = chain === "hood" ? hoodBody(args) : solanaSelfBody(args)
  const answer = await request(ctx, key, path, body).catch((error) => {
    throw buyRefusal(error)
  })
  ctx.deps.stderr.write(
    `Dry run: nothing was built, signed or recorded, and launch id ${args.id} is unused.\n${previewLines(answer, chain)}`,
  )
  return printTradingResult(ctx, { ...answer, clientTradeId: args.id, kind: "launch", ...args.used })
}

// ── BE-1721: a Solana TEE launch with a first buy, as an atomic launch ────────────────────────

/**
 * The self-launch dev-buy ceilings (spec 2026-10-20, D2), read as the API's `devBuyCeilings()`
 * reads them: the env value when it is a positive whole number, else the default. The server holds
 * the sum of the creator's own first-buy legs to the effective ceiling on `/launch/atomic` (BE-1849),
 * so this local read is the early refusal in the API's words, not the authority: a ceiling this
 * machine does not know is refused by the dry run and the build, and nothing is sent.
 */
const DEV_BUY_CEILINGS: Record<string, { env: string; raw: string; unit: string }> =
  LAUNCH_DEFINITION.buyLimits.defaults

function devBuyCeiling(env: Record<string, string | undefined>, quoteAsset: string): { ceiling: bigint; unit: string } {
  const bounds = DEV_BUY_CEILINGS[quoteAsset]
  if (!bounds)
    throw new TradingError(
      "DEV_BUY_UNSUPPORTED_FOR_PAIR",
      `An initial buy is not supported for ${safeText(quoteAsset)}-quoted solana launches`,
    )
  const raw = env[bounds.env]
  const value = raw && /^\d+$/.test(raw) ? BigInt(raw) : 0n
  return { ceiling: value > 0n ? value : BigInt(bounds.raw), unit: bounds.unit }
}

/** `decimalAmount` without trailing zeros: "0.5" rather than "0.500000000", as the API writes amounts. */
function shortAmount(raw: string, decimals: number): string {
  const full = decimalAmount(raw, decimals)
  return full.includes(".") ? full.replace(/0+$/, "").replace(/\.$/, "") : full
}

/** An exp- launch's G in raw units: the preset's, or exp-custom's `--curve-g`. Undefined for any other mode. */
function expThresholdRaw(flags: Record<string, string>, quoteAsset: string): bigint | undefined {
  const mode = flags["--mode"]
  if (mode === "exp-custom") {
    const g = flags["--curve-g"]
    const decimals = BASES[quoteAsset.toUpperCase()]?.decimals
    return g === undefined || decimals === undefined ? undefined : BigInt(rawAmount(g, decimals))
  }
  const presets: Record<string, Record<string, string>> = LAUNCH_DEFINITION.buyLimits.presetThresholds
  const raw = mode ? presets[mode]?.[quoteAsset] : undefined
  return raw === undefined ? undefined : BigInt(raw)
}

/**
 * The creator's first buy in an atomic launch, held to the effective dev-buy ceiling in the API's
 * own words (D2; BE-1849 review P1): the ordinary ceiling, or on an exp- curve
 * min(10% of the threshold, ordinary) -- "at most 0.5 SOL, or 10% of the threshold when that is
 * lower", with the threshold taken from the preset or from exp-custom's --curve-g. The dry run
 * and the build refuse the same leg server-side, env overrides included.
 */
function firstBuyCeiling(ctx: CommandContext, flags: Record<string, string>, buy: LaunchBuy): void {
  const quoteAsset = (flags["--quote-asset"] ?? "sol").toLowerCase()
  const { ceiling, unit } = devBuyCeiling(ctx.deps.env, quoteAsset)
  // BE-1806: an exp- curve's own ceiling, as the API's devBuyCeiling: min(10% of G, the ordinary).
  const threshold = expThresholdRaw(flags, quoteAsset)
  if (threshold !== undefined) {
    const curveCap = (threshold * BigInt(LAUNCH_DEFINITION.buyLimits.thresholdBps)) / 10_000n
    const applies = curveCap < ceiling ? curveCap : ceiling
    if (BigInt(buy.raw) > applies) {
      const symbol = quoteAsset.toUpperCase()
      const decimals = BASES[symbol]?.decimals ?? 9
      throw new TradingError(
        "DEV_BUY_TOO_HIGH",
        `buyAmount exceeds this launch's dev-buy ceiling of ${shortAmount(applies.toString(), decimals)} ${symbol} (${applies} ${unit}): at most ${shortAmount(ceiling.toString(), decimals)} ${symbol}, or 10% of the threshold when that is lower`,
        { details: { field: "buyAmount" } },
      )
    }
  }
  if (BigInt(buy.raw) > ceiling)
    throw new TradingError(
      "DEV_BUY_TOO_HIGH",
      `buyAmount exceeds the per-launch dev-buy ceiling of ${ceiling} ${unit} for ${quoteAsset} on solana`,
      { details: { field: "buyAmount" } },
    )
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
 * `/launch/self/build` with this wallet as the creator and buyAmount as its only first buy (R1), the
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
    bannerUrl?: string
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
  writeFields(ctx.deps, "stderr", [["Operation", id]])
  const built = atomicBuildSchema.parse(
    await request(ctx, key, "/api/v1/launch/self/build", solanaSelfBody(args)).catch((error) => {
      throw buyRefusal(error)
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
    ...(args.bannerUrl ? { bannerUrl: args.bannerUrl } : {}),
    outcome: "unsigned",
  })
  notice(ctx.deps, "stderr", "note", buyNotice(buy, "solana").trim())
  if (!(await confirmQuote(ctx, quote, args.yes))) {
    notice(
      ctx.deps,
      "stderr",
      "note",
      `Nothing was signed. Candle holds bundle ${safeText(built.bundleId)}'s spend reservation until the build expires at ${new Date(built.expiresAt).toISOString()}.\n`.trim(),
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
  const bundle = {
    bundleId: built.bundleId,
    signatures,
    imageUrl: args.imageUrl,
    ...(args.bannerUrl ? { bannerUrl: args.bannerUrl } : {}),
  }
  await saveOperationBundle(ctx, key, id, bundle)
  writeFields(ctx.deps, "stderr", [
    ["Bundle", safeText(built.bundleId)],
    ["Launch signature", signatures[0]],
    ["First buy signature", signatures[1]],
  ])
  return await submitBundle(ctx, key, { id, bundle, signed, quote, used: args.used })
}

/**
 * R3/R4: one `/launch/atomic/submit` for a built bundle, saved beforehand with whatever signatures
 * this machine has (none for the embedded wallet, whose legs Candle signs), and its outcome. A
 * failed bundle may be built again under the same id; anything that may have been sent is exit 3.
 */
async function submitBundle(
  ctx: CommandContext,
  key: string,
  args: {
    id: string
    bundle: { bundleId: string; signatures: string[]; imageUrl: string; bannerUrl?: string }
    /** The client-signed legs, in leg order: exactly what /submit takes. Empty when Candle signs every leg. */
    signed: string[]
    quote: QuoteDisplay & Json
    used: Json
  },
): Promise<number> {
  const { id, bundle, signed, quote } = args
  const { bundleId, signatures } = bundle
  const submitted = await apiRequest("/api/v1/launch/atomic/submit", {
    apiUrl: ctx.apiUrl,
    credentials: { apiKey: key },
    auth: "key",
    method: "POST",
    body: { bundleId, signedTxsBase64: signed },
    fetch: ctx.deps.fetch,
    env: ctx.deps.env,
  })
  const outcome = atomicOutcomeSchema.safeParse(submitted.ok ? submitted.body : submitted.raw)
  const details = { bundleId, signatures }
  if (!outcome.success || outcome.data.bundleId !== bundleId) {
    // A 4xx other than a conflict signed and sent nothing (the API's own contract), so a same-id
    // re-run may build again. Anything else, a lost answer included, may have sent the bundle.
    const refused = !submitted.ok && submitted.status >= 400 && submitted.status < 500 && submitted.status !== 409
    if (refused) await saveOperationBundle(ctx, key, id, { ...bundle, outcome: "refused" })
    throw new TradingError(
      submitted.ok ? "INVALID_RESPONSE" : (submitted.code ?? "REQUEST_FAILED"),
      refused
        ? `Candle refused bundle ${safeText(bundleId)} and sent nothing: ${safeText(submitted.ok ? "" : submitted.message)}. Re-run with the same --client-trade-id ${id} to build it again.`
        : `Bundle ${safeText(bundleId)} may have been sent, and its outcome is unknown${submitted.ok ? "" : `: ${safeText(submitted.message)}`}. Re-run with the same --client-trade-id ${id} to read it; nothing is re-signed or re-sent. Never relaunch under a new id: that would be a second token.`,
      { ...(refused ? {} : { exitCode: 3 as const }), details },
    )
  }
  await saveOperationBundle(ctx, key, id, { ...bundle, outcome: outcome.data.status })
  if (outcome.data.status === "failed")
    throw new TradingError(
      "BUNDLE_FAILED",
      `Bundle ${safeText(bundleId)} did not land: neither the launch nor its first buy is on chain. Retry with the same --client-trade-id ${id}; Candle starts a clean attempt under it.`,
      { details },
    )
  if (outcome.data.status === "timeout")
    throw new TradingError(
      "BUNDLE_UNRESOLVED",
      `Bundle ${safeText(bundleId)} is unresolved and may still land. Re-run with the same --client-trade-id ${id} to read its outcome; nothing is re-signed or re-sent. Never relaunch under a new id: that would be a second token.`,
      { exitCode: 3, details },
    )
  const [launchSignature, buySignature] = outcome.data.signatures
  writeFields(
    ctx.deps,
    "stderr",
    [
      ["Mint", safeText(outcome.data.mint)],
      ["Launch signature", safeText(launchSignature)],
      ["First buy signature", safeText(buySignature)],
    ],
    "Launched",
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

// ── BE-1849: a launch from the embedded wallet, as an atomic launch ───────────────────────────

/** The embedded wallet pays for both legs, and Candle signs both at `/submit`. */

/** `/launch/atomic/dry-run`'s fields this command reads: the launch's wallet and its one first buy. */
const atomicDryRunSchema = z
  .object({
    launchWallet: z.string(),
    launchSigner: z.enum(["server", "client"]),
    fills: z.array(
      z
        .object({
          index: z.number().int(),
          signer: z.enum(["server", "client"]),
          wallet: z.string(),
          amountRaw: z.string().regex(/^\d+$/),
          feeRaw: z.string().regex(/^\d+$/),
          expectedFill: z.object({
            amountOutRaw: z.string().regex(/^\d+$/),
            minAmountOutRaw: z.string().regex(/^\d+$/),
          }),
          supplyPct: z.number(),
        })
        .passthrough(),
    ),
    graduatesInBundle: z.boolean().optional(),
  })
  .passthrough()

/**
 * The account's embedded wallet for this chain, read as `candle swap` reads it, before the upload: a key
 * the owner denied the embedded wallet is refused here with the fix, as the server would refuse it.
 */
async function embeddedLaunchWallet(ctx: CommandContext, key: string, chain: TradeChain): Promise<string> {
  const discovered = embeddedSchema.parse(await request(ctx, key, "/api/v1/agent/wallets/embedded"))
  const address = chain === "hood" ? discovered.wallets?.evm?.address : discovered.wallets?.solana?.address
  if (!address)
    throw new TradingError(
      "PAYER_REQUIRED",
      `This account has no ${chainName(chain)} embedded wallet. Create one in the app, or launch from a TEE wallet with --wallet <tee>. Nothing was built.`,
    )
  if (discovered.embeddedWalletPermission === "denied")
    throw new TradingError(
      "EMBEDDED_WALLET_NOT_PERMITTED",
      `This key may not use the account's embedded wallet (${address}). Nothing was built.`,
      {
        suggestion:
          "Have the owner allow it: candle keys update <prefix> --embedded-wallet allow (device token), or in the web key manager. Or launch from a TEE wallet bound to this key with --wallet <tee>.",
      },
    )
  return address
}

/** The embedded wallet previews and executes through headless, with or without a first buy.
 * The server owns build/sign/submit and its slippage floor. Recovery keeps clientLaunchId.
 */
async function embeddedLaunch(
  ctx: CommandContext,
  key: string,
  args: {
    flags: Record<string, string>
    id: string
    image?: LocalImage
    banner?: LocalImage
    /** A same-id retry after a bundle that did not land: the id is already this machine's. */
    retry?: { imageUrl?: string; bannerUrl?: string }
    yes: boolean
    dryRun: boolean
  },
): Promise<number> {
  const { flags, id } = args
  const chain = flagChain(flags) ?? "solana"
  const buy = launchBuy(flags, chain)
  if (buy && chain === "solana") firstBuyCeiling(ctx, flags, buy)
  if (chain === "hood" && Object.keys(poolRequestFields(flags)).length)
    throw new TradingUsage("Pool fee and pool shape choices are Solana only; a Hood launch cannot take them.")
  const wallet = await embeddedLaunchWallet(ctx, key, chain)
  const uploaded = await uploadLaunchImages(ctx, key, args)
  if (typeof uploaded === "number") return uploaded
  const { imageUrl, bannerUrl, used } = uploaded
  const body = {
    clientLaunchId: id,
    chain,
    name: flags["--name"],
    symbol: flags["--symbol"],
    imageUrl,
    ...(bannerUrl ? { bannerUrl } : {}),
    ...(flags["--description"] ? { description: flags["--description"] } : {}),
    ...(flags["--quote-asset"] ? { quoteAsset: flags["--quote-asset"] } : {}),
    ...(flags["--dex-version"] ? { dexVersion: flags["--dex-version"] } : {}),
    ...(flags["--mode"] ? { mode: flags["--mode"] } : {}),
    ...launchCurveFields(flags),
    ...launchMetadataFields(flags),
    ...poolRequestFields(flags),
    ...(buy
      ? { buyAmount: chain === "hood" || BigInt(buy.raw) > BigInt(Number.MAX_SAFE_INTEGER) ? buy.raw : Number(buy.raw) }
      : {}),
  }
  const answer = await request(ctx, key, "/api/v1/launch/headless/dry-run", body)
  let quote: QuoteDisplay & Json = {
    intent: `Launch ${flags["--name"]} (${flags["--symbol"]})${buy ? ` with a first buy of ${buy.display}` : ""} from the embedded wallet`,
    wallet,
    venue: "curve launch (signed by Candle)",
    priceImpactPct: null,
    minimumReceived: "0 tokens (no first buy)",
    tokenRisks: [],
  }
  if (buy && chain === "solana") {
    const preview = atomicDryRunSchema.safeParse(answer)
    const fill = preview.success ? preview.data.fills[0] : undefined
    if (
      !preview.success ||
      !fill ||
      preview.data.fills.length !== 1 ||
      preview.data.launchWallet !== wallet ||
      preview.data.launchSigner !== "server" ||
      fill.wallet !== wallet ||
      fill.signer !== "server" ||
      fill.amountRaw !== buy.raw
    )
      throw new TradingError(
        "INVALID_RESPONSE",
        "Candle's dry run does not read as this launch and its first buy from the embedded wallet; nothing was built.",
      )
    const quoteAsset = (flags["--quote-asset"] ?? "sol").toUpperCase()
    const decimals =
      LAUNCH_DEFINITION.quoteDecimals[quoteAsset.toLowerCase() as keyof typeof LAUNCH_DEFINITION.quoteDecimals]
    quote = {
      ...quote,
      venue: "curve launch (atomic bundle, signed by Candle)",
      candleFee:
        fill.feeRaw !== "0"
          ? `${decimalAmount(fill.feeRaw, decimals)} ${quoteAsset} (the tier fee on the first buy, in its leg)`
          : "none on this first buy",
      minimumReceived: `${fill.expectedFill.minAmountOutRaw} raw units of the new token (the first buy's floor; ${fill.supplyPct}% of the supply expected)`,
    }
    if (preview.data.graduatesInBundle)
      notice(
        ctx.deps,
        "stderr",
        "note",
        "This first buy alone takes the new curve to graduation inside the bundle.\n".trim(),
      )
  } else {
    previewSchema.parse(answer)
    if (buy) quote.minimumReceived = "not quoted (best-effort first buy after creation)"
  }
  ctx.deps.stderr.write(previewLines(answer, chain))
  if (args.dryRun) {
    ctx.deps.stderr.write(`Dry run: nothing was built, signed or recorded, and launch id ${id} is unused.\n`)
    return printTradingResult(ctx, { ...answer, clientTradeId: id, kind: "launch", quote, ...used })
  }
  notice(ctx.deps, "stderr", "note", buyNotice(buy, chain).trim())
  if (!(await confirmQuote(ctx, quote, args.yes)))
    return printTradingResult(ctx, {
      success: true,
      status: "cancelled",
      clientTradeId: id,
      kind: "launch",
      quote,
      ...used,
    })
  if (!args.retry && !(await claimOperation(ctx, key, id, "launch")))
    throw new TradingError(
      "OPERATION_ALREADY_STARTED",
      "This machine already started this launch id; no write was resent.",
    )
  writeFields(ctx.deps, "stderr", [["Operation", id]])
  // The server builds, signs and submits in one call. Its slippage floor applies; there is no
  // separate client-side build-floor comparison. Recovery uses the durable clientLaunchId.
  const result = await apiRequest("/api/v1/launch/headless", {
    apiUrl: ctx.apiUrl,
    credentials: { apiKey: key },
    auth: "key",
    method: "POST",
    body,
    fetch: ctx.deps.fetch,
    env: ctx.deps.env,
  })
  if (!result.ok) {
    const raw = result.raw as Json | undefined
    const unresolved = result.status === 0 || raw?.status === "timeout"
    throw new TradingError(result.code ?? (unresolved ? "BUNDLE_UNRESOLVED" : "REQUEST_FAILED"), result.message, {
      ...(unresolved ? { exitCode: 3 as const } : {}),
      suggestion: `Recover with --client-trade-id ${id}; check candle swap status ${id} --kind launch before another attempt.`,
      ...(typeof raw?.bundleId === "string" ? { details: { bundleId: raw.bundleId } } : {}),
    })
  }
  return printTradingResult(ctx, {
    ...z.record(z.unknown()).parse(result.body),
    clientTradeId: id,
    kind: "launch",
    quote,
    ...used,
  })
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
    bannerUrl?: string
    /** What the result carries beside the launch: the uploaded image's URL, with `--image`. */
    used: Json
    yes: boolean
  },
): Promise<number> {
  const { flags, id, wallet, buy } = args
  if (Object.keys(poolRequestFields(flags)).length)
    throw new TradingUsage("Pool fee and pool shape choices are Solana only; a Hood launch cannot take them.")
  const allowedLegs = buy ? HOOD_LAUNCH_BUY_LEGS : HOOD_LAUNCH_LEGS
  if (!(await claimOperation(ctx, key, id, "launch")))
    throw new TradingError(
      "OPERATION_ALREADY_STARTED",
      "This machine already started this launch id; no write was resent.",
    )
  writeFields(ctx.deps, "stderr", [["Operation", id]])
  const built = await request(ctx, key, "/api/v1/launch/self/build", hoodBody(args)).catch((error) => {
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
  notice(ctx.deps, "stderr", "note", buyNotice(buy, "hood").trim())
  if (!(await confirmQuote(ctx, quote, args.yes))) {
    // The build holds the wallet (D4, one operation per wallet) until its window closes.
    notice(
      ctx.deps,
      "stderr",
      "note",
      `Nothing was signed. Operation ${first.operationId} holds this wallet until ${new Date(first.expiresAt).toISOString()}; a new Hood operation from it is refused as WALLET_BUSY until then.\n`.trim(),
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
