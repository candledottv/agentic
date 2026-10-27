/**
 * The x402 payment loop for a paid call inside an existing command (spec 10.2 `pay.ts`, 10.3):
 *
 *   request; on a 402 whose `PAYMENT-REQUIRED` decodes, pick the requirement this CLI can pay, run
 *   the spending rules, confirm unless --yes, unlock the vault key, sign the `exact` transfer,
 *   write the `pending` line under the log's lock, retry once with `PAYMENT-SIGNATURE`, read
 *   `PAYMENT-RESPONSE` and log what happened.
 *
 * Never more than one payment per call: a 402 after paying is shown, not paid. A 402 without the
 * header, or one that does not decode, is the ordinary error it is today (3.2). When the server
 * does not answer 402 at all (switch off, or an alpha a day behind), nothing here runs and the
 * command behaves exactly as before (10.5).
 *
 * The spending rules refuse as early as they can be read: the pause, the per-call ceiling, the
 * pinned pay-to and the daily limit are checked before the vault is opened, so those refusals
 * sign nothing. The daily limit is checked again under the lock that writes the `pending` line,
 * after the transfer is signed; when that recheck refuses, the signed transaction is never sent.
 */
import { type ApiRequestOptions, type ApiResult, apiRequest } from "../client"
import {
  encodePaymentPayload,
  PAYMENT_SIGNATURE_HEADER,
  type PaymentRequired,
  paymentRequiredOf,
  SIGN_IN_WITH_X_HEADER,
  settlementOf,
} from "./codec"
import {
  type NetworkConfig,
  networkConfig,
  PAY_TO_ENV,
  type SelectedRequirement,
  SOLANA_MAINNET,
  selectRequirement,
  usdcText,
  type X402ClientNetwork,
} from "./select"
import { spendChallengeOf, spendProofHeader } from "./siwx"
import { buildExactTransfer, serializePartiallySigned } from "./solana-exact"
import {
  foldSpendLog,
  readLimits,
  readSpendLog,
  recordSpendState,
  reserveSpend,
  type SpendEntry,
  type SpendPaths,
  type SpendState,
  spentOn,
  usdText,
  utcDay,
} from "./spend-log"

/** What a payment is for, as the confirmation and the vault prompt name it. */
export interface PaymentOffer {
  amountRaw: bigint
  /** "0.01", in USDC. */
  priceText: string
  description: string
  payTo: string
  network: X402ClientNetwork
}

export interface PaymentSigner {
  address: string
  sign(message: Uint8Array): Uint8Array
  close(): void
}

/** The command's half: how a payment is confirmed and which key signs it. Both may throw to refuse. */
export interface PayerSource {
  confirm(offer: PaymentOffer): Promise<void>
  open(offer: PaymentOffer): Promise<PaymentSigner>
}

export interface X402Refusal {
  code:
    | "X402_NOT_PAYABLE"
    | "X402_PAY_TO_UNPINNED"
    | "X402_PAY_TO_MISMATCH"
    | "X402_OFFER_CHANGED"
    | "SPEND_PAUSED"
    | "SPEND_MAX_PER_CALL"
    | "SPEND_DAILY_LIMIT"
  message: string
  suggestion?: string
  /** The price the server asked, when one was read. */
  priceUsdc?: string
}

export interface PaymentRecord {
  id: string
  state: SpendState
  amountUsdc: string
  payer: string
  signature?: string
  reason?: string
}

export interface PaidCallResult {
  /** The response the command renders: the paid one, the credit-served one, or the original. */
  result: ApiResult
  /** The payment this call made, if it made one. */
  payment: PaymentRecord | null
  /** Why a payable 402 was not paid. `result` is then that 402. */
  refusal: X402Refusal | null
  /** True when a wallet credit served the call (3.7): nothing was paid. */
  servedFromCredit: boolean
}

export interface PaidCallInput {
  path: string
  /** Everything `apiRequest` takes except the x402 headers this loop adds. */
  request: Omit<ApiRequestOptions, "headers">
  /** The log's `kind`: `forensics`, `vamp`, `quant`. */
  kind: string
  paths: SpendPaths
  payer: PayerSource
  /** A recent blockhash on `network` (the CLI's RPC on mainnet, the public devnet RPC on devnet). */
  blockhash: (network: X402ClientNetwork) => Promise<string>
  env: Record<string, string | undefined>
  now: () => number
  newId: () => string
}

type Assessment = { ok: true; selected: SelectedRequirement; offer: PaymentOffer } | { ok: false; refusal: X402Refusal }

/** 10.3 rules 1, 2 and 4, and a first read of rule 3: everything that needs no key and no lock. */
async function assess(
  required: PaymentRequired,
  config: NetworkConfig,
  paths: SpendPaths,
  now: number,
): Promise<Assessment> {
  const selection = selectRequirement(required, config)
  if (!selection.ok) return { ok: false, refusal: { code: "X402_NOT_PAYABLE", message: selection.reason } }
  const { selected } = selection
  const priceUsdc = usdcText(selected.amountRaw)
  const limits = await readLimits(paths)
  if (limits.paused) {
    return {
      ok: false,
      refusal: {
        code: "SPEND_PAUSED",
        message: `This call costs ${priceUsdc} USDC, and per-use payments are paused. Nothing was paid.`,
        suggestion: "Run: candle spend resume",
        priceUsdc,
      },
    }
  }
  if (selected.amountRaw > limits.maxPerCallUsdMicros) {
    return {
      ok: false,
      refusal: {
        code: "SPEND_MAX_PER_CALL",
        message: `This call costs ${priceUsdc} USDC, over the per-call ceiling of $${usdText(limits.maxPerCallUsdMicros)}. Nothing was paid.`,
        suggestion: "Raise it with: candle spend max-per-call <usd>",
        priceUsdc,
      },
    }
  }
  if (config.payTo === null) {
    return {
      ok: false,
      refusal: {
        code: "X402_PAY_TO_UNPINNED",
        message:
          config.network === SOLANA_MAINNET
            ? `This call costs ${priceUsdc} USDC, and this CLI release pins no mainnet pay-to address, so it pays nothing on mainnet.`
            : `This call costs ${priceUsdc} USDC on devnet, and no pay-to address is set for devnet.`,
        ...(config.network === SOLANA_MAINNET
          ? {}
          : { suggestion: `Set ${PAY_TO_ENV} to the devnet address the API pays to.` }),
        priceUsdc,
      },
    }
  }
  if (selected.requirement.payTo !== config.payTo) {
    return {
      ok: false,
      refusal: {
        code: "X402_PAY_TO_MISMATCH",
        message: `The server asked for payment to ${selected.requirement.payTo}, not the address this CLI pays (${config.payTo}). Nothing was paid.`,
        priceUsdc,
      },
    }
  }
  const spentToday = spentOn(foldSpendLog(await readSpendLog(paths)), utcDay(now))
  if (spentToday + selected.amountRaw > limits.dailyLimitUsdMicros) {
    return { ok: false, refusal: dailyRefusal(priceUsdc, spentToday, limits.dailyLimitUsdMicros) }
  }
  return {
    ok: true,
    selected,
    offer: {
      amountRaw: selected.amountRaw,
      priceText: priceUsdc,
      description: required.resource.description ?? required.resource.url,
      payTo: selected.requirement.payTo,
      network: config.network,
    },
  }
}

function dailyRefusal(priceUsdc: string, spentToday: bigint, limit: bigint): X402Refusal {
  return {
    code: "SPEND_DAILY_LIMIT",
    message: `This call costs ${priceUsdc} USDC; today's per-use payments are already $${usdText(spentToday)} of the $${usdText(limit)} daily limit. Nothing was paid.`,
    suggestion: "See today's payments with: candle spend, or raise the limit with: candle spend limit <usd>",
    priceUsdc,
  }
}

/** True when this wallet has a keyless payment the server credited, so it may hold a wallet credit. */
function mayHoldWalletCredit(entries: SpendEntry[], address: string, network: string): boolean {
  return entries.some((e) => e.keyless && e.state === "credited" && e.payer === address && e.network === network)
}

/** How the retried request ended, for the log. */
function outcomeOf(second: ApiResult): { state: SpendState; signature?: string; reason?: string } {
  const settlement = settlementOf(second.headers)
  if (settlement?.success) {
    // Settled. Served is `settled`; a handler that failed after settlement earned a credit (3.7).
    return second.ok
      ? { state: "settled", signature: settlement.transaction }
      : { state: "credited", signature: settlement.transaction, reason: second.code ?? `HTTP_${second.status}` }
  }
  if (second.ok) return { state: "unknown", reason: "served_without_payment_response" }
  if (second.status === 402) {
    // 3.4: every 402 after a payment is a refusal before anything moved (quote, local checks,
    // verify) or a settle that broadcast nothing.
    const reason = settlement?.errorReason ?? paymentRequiredOf(second.headers)?.error ?? second.code ?? "HTTP_402"
    return { state: "failed", reason }
  }
  // No answer, a 5xx (PAYMENT_PENDING among them) or a 409: whether money moved is not known here.
  if (second.status === 0 || second.status >= 500 || second.status === 409) {
    return { state: "unknown", reason: second.code ?? `HTTP_${second.status}` }
  }
  // Any other 4xx is refused before the reservation step (decode, rate ceiling, auth): nothing moved.
  return { state: "failed", reason: second.code ?? `HTTP_${second.status}` }
}

export async function paidRequest(input: PaidCallInput): Promise<PaidCallResult> {
  const plain = (result: ApiResult): PaidCallResult => ({
    result,
    payment: null,
    refusal: null,
    servedFromCredit: false,
  })
  const first = await apiRequest(input.path, input.request)
  if (first.ok || first.status !== 402) return plain(first)
  let required = paymentRequiredOf(first.headers)
  if (!required) return plain(first)

  const refused = (result: ApiResult, refusal: X402Refusal): PaidCallResult => ({
    result,
    payment: null,
    refusal,
    servedFromCredit: false,
  })
  const network = networkConfig(input.env)
  if (!network.ok) return refused(first, { code: "X402_NOT_PAYABLE", message: network.message })
  const config = network.config
  const firstAssessment = await assess(required, config, input.paths, input.now())
  if (!firstAssessment.ok) return refused(first, firstAssessment.refusal)
  let { selected, offer } = firstAssessment
  let current: ApiResult = first

  await input.payer.confirm(offer)
  const signer = await input.payer.open(offer)
  try {
    const keyless = input.request.auth !== "key" || !input.request.credentials.apiKey
    // A wallet credit is spent only with that wallet's proof (3.7, 3.9). Tried once, before paying.
    const apiHost = new URL(input.request.apiUrl).host
    const challenge = spendChallengeOf(required.extensions, apiHost, config.network)
    if (
      keyless &&
      challenge &&
      mayHoldWalletCredit(foldSpendLog(await readSpendLog(input.paths)), signer.address, config.network)
    ) {
      const viaCredit = await apiRequest(input.path, {
        ...input.request,
        headers: { [SIGN_IN_WITH_X_HEADER]: spendProofHeader(challenge, signer.address, (m) => signer.sign(m)) },
      })
      if (viaCredit.ok) return { result: viaCredit, payment: null, refusal: null, servedFromCredit: true }
      const again = viaCredit.status === 402 ? paymentRequiredOf(viaCredit.headers) : null
      if (!again) return plain(viaCredit)
      // Too little credit: the fresh quote goes through every rule again, and must ask what was confirmed.
      const second = await assess(again, config, input.paths, input.now())
      if (!second.ok) return refused(viaCredit, second.refusal)
      if (second.offer.amountRaw !== offer.amountRaw || second.offer.payTo !== offer.payTo) {
        return refused(viaCredit, {
          code: "X402_OFFER_CHANGED",
          message: "The server's second offer differs from the one confirmed. Nothing was paid.",
          priceUsdc: second.offer.priceText,
        })
      }
      required = again
      selected = second.selected
      offer = second.offer
      current = viaCredit
    }

    const transfer = buildExactTransfer({
      payer: signer.address,
      payTo: selected.requirement.payTo,
      asset: selected.requirement.asset,
      amountRaw: selected.amountRaw,
      feePayer: selected.feePayer,
      memo: selected.memo,
      recentBlockhash: await input.blockhash(config.network),
    })
    const transaction = serializePartiallySigned(transfer, signer.sign(transfer.message))

    const id = input.newId()
    const limits = await readLimits(input.paths)
    const method = (input.request.method ?? "GET").toUpperCase()
    const reservation = await reserveSpend(input.paths, limits.dailyLimitUsdMicros, {
      v: 1,
      at: new Date(input.now()).toISOString(),
      id,
      state: "pending",
      kind: input.kind,
      route: `${method} ${new URL(required.resource.url, input.request.apiUrl).pathname}`,
      network: config.network,
      amountRaw: selected.amountRaw.toString(),
      payTo: selected.requirement.payTo,
      payer: signer.address,
      quoteMemo: selected.memo,
      keyless,
    })
    if (!reservation.ok) {
      return refused(current, dailyRefusal(offer.priceText, reservation.spentToday, limits.dailyLimitUsdMicros))
    }

    const paid = await apiRequest(input.path, {
      ...input.request,
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentPayload({
          resource: required.resource,
          accepted: selected.requirement,
          transaction,
        }),
      },
    })
    const outcome = outcomeOf(paid)
    await recordSpendState(input.paths, { id, at: new Date(input.now()).toISOString(), ...outcome })
    return {
      result: paid,
      payment: {
        id,
        state: outcome.state,
        amountUsdc: offer.priceText,
        payer: signer.address,
        ...(outcome.signature ? { signature: outcome.signature } : {}),
        ...(outcome.reason ? { reason: outcome.reason } : {}),
      },
      refusal: null,
      servedFromCredit: false,
    }
  } finally {
    signer.close()
  }
}
