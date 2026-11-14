import type { RequestConfig } from "./client"
import { LAUNCH_DEFINITION } from "./launch-definition"
import {
  fixedLaunchQuote,
  LaunchCheckError,
  type LaunchCheckRequest,
  launchCheckPath,
  readLaunchCheck,
} from "./launch-preflight"
import type { FetchLike } from "./orchestrate"

/** Runs before image handling and orchestration. Refusals preserve the server's full body. */
export async function launchCheck(args: Record<string, unknown>, cfg: RequestConfig, fetch: FetchLike) {
  try {
    if (!cfg.apiKey) throw new LaunchCheckError("UNAUTHORIZED", "An API key is required for launch checks.")
    const input = args as unknown as LaunchCheckRequest
    const path = launchCheckPath(input)
    // These MCP tools launch from embedded wallets; TEE wallet controls remain on the SDK/CLI.
    const response = await fetch(`${cfg.apiUrl.replace(/\/$/, "")}${path}`, {
      method: "GET",
      headers: { "x-api-key": cfg.apiKey },
    })
    const text = await response.text()
    if (!response.ok) return { content: [{ type: "text" as const, text }], isError: true }
    const result = readLaunchCheck(JSON.parse(text), { ...input, wallet: "embedded" })
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      ...(!result.works ? { isError: true } : {}),
    }
  } catch (error) {
    return launchControlError(error)
  }
}

export function launchControlError(error: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          success: false,
          error: {
            code: error instanceof LaunchCheckError ? error.code : "QUOTE_CHECK_UNAVAILABLE",
            message: error instanceof Error ? error.message : "Launch check unavailable.",
            ...(error instanceof LaunchCheckError && error.field ? { field: error.field } : {}),
          },
        }),
      },
    ],
    isError: true,
  }
}

/** Strip controls and map fixed-pair aliases before any upload, conversion or POST. */
export function launchExecutionArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { quote, check: _check, ...body } = args
  const quoteAsset = fixedLaunchQuote({ quote, quoteAsset: args.quoteAsset, chain: args.chain } as Parameters<
    typeof fixedLaunchQuote
  >[0])
  const chain =
    quote === undefined || body.chain !== undefined
      ? body.chain
      : LAUNCH_DEFINITION.quoteChains[quoteAsset as keyof typeof LAUNCH_DEFINITION.quoteChains]
  return { ...body, ...(quoteAsset === undefined ? {} : { quoteAsset }), ...(chain === undefined ? {} : { chain }) }
}
