import { createPrivateKey, sign } from "node:crypto"
import { readFile } from "node:fs/promises"
import { z } from "zod"
import type { RequestConfig } from "./client"
import {
  HYPERLIQUID_EXCHANGE_URLS,
  hyperliquidCanonicalJson,
  hyperliquidExchangeBody,
  hyperliquidExchangeOutcome,
  hyperliquidRelayBody,
} from "./hyperliquid"
import { type OwnTransferBuild, transferAmountMicros, verifyOwnTransferBuild } from "./hyperliquid-transfer"
import type { FetchLike, ToolText } from "./orchestrate"
import { call, fail, Refusal, walletFor } from "./perps"

export const perpsTransferShape = {
  clientTransferId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  mode: z.enum(["toDex", "fromDex"]),
  dex: z
    .string()
    .regex(/^[A-Za-z0-9]{1,16}$/)
    .optional(),
  amountUsdc: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/)
    .optional(),
  all: z.boolean().optional(),
  wallet: z.string().optional(),
  submit: z.boolean().optional(),
}
/** Local MCP only: money stays at the same address. API and relay enforce perps:write again. */
export async function executePerpsTransfer(
  args: Record<string, unknown>,
  cfg: RequestConfig,
  env: Record<string, string | undefined>,
  fetch: FetchLike,
): Promise<ToolText> {
  if (!cfg.apiKey) return fail("MCP_VALIDATION", "CANDLE_AGENT_API_KEY is required.")
  // Perps to spot (BE-3864) is not in this release and not in the schema; an older caller naming
  // a spot mode gets the plain refusal, before any request.
  if (args.mode === "toSpot" || args.mode === "fromSpot")
    return fail("MCP_VALIDATION", "Perps to spot transfers (toSpot, fromSpot) are not available in this release.")
  const parsed = z.object(perpsTransferShape).strict().safeParse(args)
  if (!parsed.success) return fail("MCP_VALIDATION", "Invalid transfer input; no destination is accepted.")
  const a = parsed.data
  const dexMode = a.mode === "toDex" || a.mode === "fromDex"
  if (
    (dexMode && (!a.dex || a.dex.toLowerCase() === "spot")) ||
    (!dexMode && a.dex !== undefined) ||
    (a.all === true ? a.amountUsdc !== undefined || a.mode === "toDex" : transferAmountMicros(a.amountUsdc) === null)
  )
    return fail("MCP_VALIDATION", "Name the source/destination dex and a positive amount, or all on a from-mode.")
  if (env.CANDLE_HYPERLIQUID_NETWORK === "testnet")
    return fail("PERPS_TRANSFER_UNSUPPORTED_NETWORK", "Transfers are mainnet only.")
  try {
    const { row, appId } = await walletFor(cfg, fetch, a.wallet, "perps:write")
    if (row.id === "embedded") return fail("PERPS_EMBEDDED_DISABLED", "Embedded transfers are not enabled.")
    let pem: string | undefined
    if (a.submit !== false) {
      try {
        if (!env.CANDLE_KEY_SIGNER_PEM_FILE || !appId || !row.privyWalletId) throw new Error("missing signer")
        pem = await readFile(env.CANDLE_KEY_SIGNER_PEM_FILE, "utf8")
        createPrivateKey(pem)
      } catch {
        return fail("SIGNER_UNAVAILABLE", "A readable CANDLE_KEY_SIGNER_PEM_FILE and relay identifiers are required.")
      }
    }
    const { wallet: _wallet, submit: _submit, ...request } = a
    const result = await call(cfg, fetch, "POST", "/api/v1/agent/perps/transfer", { ...request, walletId: row.id })
    const build = result as unknown as OwnTransferBuild
    if (build.status !== "built") return { text: JSON.stringify(result) }
    const problem = verifyOwnTransferBuild(build, {
      id: a.clientTransferId,
      account: row.address,
      mode: a.mode,
      dex: a.dex,
      amountMicros: a.all ? null : transferAmountMicros(a.amountUsdc),
    })
    if (problem) return fail("PERPS_BUILD_REFUSED", problem)
    if (a.submit === false) return { text: JSON.stringify({ ...result, submitted: false }) }
    const body = hyperliquidRelayBody(build.typedData as never)
    const payload = hyperliquidCanonicalJson({
      body,
      headers: { "privy-app-id": appId },
      method: "POST",
      url: `https://api.privy.io/v1/wallets/${row.privyWalletId}/rpc`,
      version: 1,
    })
    const signature =
      typeof result.signature === "string"
        ? { signature: result.signature }
        : await call(cfg, fetch, "POST", `/api/v1/agent/wallets/${encodeURIComponent(row.id)}/sign`, {
            body,
            authorizationSignature: sign("sha256", Buffer.from(payload), pem as string).toString("base64"),
          })
    if (typeof signature.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature.signature))
      return fail("INVALID_RESPONSE", "Invalid relay signature")
    const exchangeBody = hyperliquidExchangeBody(
      build.action as Record<string, unknown>,
      Number(build.nonce),
      signature.signature,
    )
    let exchange: Record<string, unknown>
    try {
      const response = await fetch(HYPERLIQUID_EXCHANGE_URLS.mainnet, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(exchangeBody),
      })
      exchange = JSON.parse(await response.text())
      if (!response.ok || hyperliquidExchangeOutcome(exchange).status === "unknown") throw new Error("unconfirmed")
    } catch {
      return fail("PERPS_SUBMIT_FAILED", "Submission outcome unknown; retry only this signed body, never a new id.", {
        clientTransferId: a.clientTransferId,
        exchangeBody,
      })
    }
    const reported = await call(cfg, fetch, "POST", "/api/v1/agent/perps/transfer/submitted", {
      clientTransferId: a.clientTransferId,
      exchangeResponse: exchange,
    })
    return {
      text: JSON.stringify({ ...reported, exchange }),
      ...(hyperliquidExchangeOutcome(exchange).status === "rejected" ? { isError: true } : {}),
    }
  } catch (error) {
    if (error instanceof Refusal) return error.tool
    return fail("PERPS_UNAVAILABLE", error instanceof Error ? error.message : "Transfer failed")
  }
}
