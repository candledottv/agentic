import { parseArgs } from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { writeFields } from "../human-output"
import { notice } from "../presentation"
import { formatTime, terminalText, writeUsageFailure } from "../render"
import { type ClusterResult, clusterUnavailable, readClusterResult } from "../token-clusters"

export async function tokenClusters(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--chain"] })
  if (
    "error" in parsed ||
    parsed.positionals.length !== 1 ||
    (parsed.values["--chain"] !== undefined && !["solana", "hood"].includes(parsed.values["--chain"]))
  ) {
    writeUsageFailure(ctx.deps, "Usage: candle token clusters <mint> [--chain solana|hood]", ctx.json)
    return 2
  }
  const mint = parsed.positionals[0] as string
  const chain = parsed.values["--chain"] ?? "solana"
  let result: ClusterResult = clusterUnavailable(mint, "transport_error")
  try {
    const response = await apiRequest(`/api/v1/tokens/${encodeURIComponent(mint)}/clusters?chain=${chain}`, {
      apiUrl: ctx.apiUrl,
      auth: "none",
      credentials: {},
      env: ctx.deps.env,
      fetch: ((input, init) =>
        ctx.deps.fetch(input, { ...init, signal: AbortSignal.timeout(12000), cache: "no-store" })) as typeof fetch,
    })
    if (response.ok) {
      const body = response.body as { success?: unknown; data?: unknown } | null
      if (body?.success === true) result = readClusterResult(body.data, mint) ?? result
    }
  } catch {
    /* The optional read's transport/decoding failures are normal unavailable results. */
  }
  const out = ctx.deps.stdout
  if (ctx.json) out.write(`${JSON.stringify(result)}\n`)
  else if (result.status === "unavailable")
    writeFields(ctx.deps, "stdout", [
      ["Status", result.message],
      ["Reason", result.reason],
    ])
  else {
    writeFields(
      ctx.deps,
      "stdout",
      [
        ["Fetched", formatTime(result.fetchedAt)],
        ["Cluster supply", `${result.analysis.clusterSupplyPct}%`],
      ],
      result.label,
    )
    for (const cluster of result.analysis.clusters) {
      writeFields(ctx.deps, "stdout", [
        ["Supply", `${cluster.supplyPct}%`],
        ["Addresses", cluster.addresses.map(terminalText).join(" ")],
        ["Tags", cluster.tags.map(terminalText).join(", ")],
      ])
    }
    notice(ctx.deps, "stdout", "note", `${result.caveat}\n`.trim())
  }
  return 0
}
