/**
 * `candle launch --check` (BE-2139, surfaces item B): the preflight that answers, on one screen and
 * before any image upload, which launch path works for this key.
 *
 * The desk report behind the card met these refusals serially, each only after the launch image was
 * already published: the embedded allowance at /launch/headless, then the tier gate and allowLaunch
 * at /launch/self, then TEE_LAUNCH_BUYS_ENABLED at the build. One GET /api/v1/launch/preflight
 * answers all of them, and no upload, build, reservation or id claim ever happens under --check.
 */
import { z } from "zod"
import type { CommandContext } from "./deps"
import { LAUNCH_DEFINITION } from "./launch-definition"
import { chainName, type Json, request, rowChain, type TradeChain, TradingError } from "./trading"

/** GET /launch/preflight's answer. Every field is a fact the server owns; the wording below is ours. */
const checkSchema = z
  .object({
    key: z.object({
      keyPrefix: z.string(),
      scopes: z.array(z.string()),
      tier: z.string(),
      selfLaunch: z.boolean(),
      embeddedWalletPermission: z.enum(["allowed", "denied"]),
    }),
    switches: z.object({
      headlessLaunch: z.boolean(),
      agentTrading: z.boolean(),
      teeLaunchBuys: z.boolean(),
    }),
    embedded: z
      .object({
        solana: z.object({ address: z.string(), delegated: z.boolean().optional() }).nullable().optional(),
        evm: z.object({ address: z.string(), delegated: z.boolean().optional() }).nullable().optional(),
      })
      .optional(),
    wallets: z.array(
      z.object({
        id: z.string(),
        address: z.string(),
        chain: z.string(),
        label: z.string().nullable(),
        allowLaunch: z.boolean(),
        active: z.boolean(),
      }),
    ),
  })
  .passthrough()

type CheckAnswer = z.infer<typeof checkSchema>

const EMBEDDED_NAMES = new Set<string>(LAUNCH_DEFINITION.wallet.embeddedNames)

/** How a wallet row is named on the screen: the label, else the id, as a person reads it. */
function walletName(row: CheckAnswer["wallets"][number]): string {
  return row.label ?? row.id
}

/** One TEE wallet's verdict lines, in the launch card's own voice. */
function walletLines(answer: CheckAnswer, row: CheckAnswer["wallets"][number], requestedChain?: TradeChain): string[] {
  const name = walletName(row)
  const chain = row.chain === "evm" ? "Hood" : "Solana"
  const lines: string[] = []
  if (requestedChain && rowChain(row) !== requestedChain)
    return [
      `${name} (${chain}) cannot launch on ${chainName(requestedChain)}: choose a ${chainName(requestedChain)} wallet.`,
    ]
  const gated = gatedOff(answer)
  if (gated) {
    lines.push(`${name} (${chain}): ${gated}`)
    return lines
  }
  if (!answer.key.selfLaunch)
    lines.push(`${name} (${chain}) cannot launch: TEE launches need Pro or Max, and this key is ${answer.key.tier}.`)
  else if (!row.allowLaunch)
    lines.push(
      `${name} (${chain}) cannot launch: the account owner has allowLaunch off for it. Run candle wallets allow-launch ${row.id} on a profile signed in with candle auth login.`,
    )
  else if (!row.active) lines.push(`${name} (${chain}) cannot launch: it is not a verified-active TEE wallet.`)
  else {
    lines.push(`This key can launch from ${name} with no first buy.`)
    if (!answer.switches.teeLaunchBuys)
      lines.push(`A first buy from ${name} is off on this server; launch with no first buy, then buy with candle swap.`)
    else if (chain === "Solana" && !answer.switches.agentTrading)
      lines.push(`A first buy from ${name} is off on this server (AGENT_TRADING_ENABLED off for Solana first buys).`)
    else lines.push(`A first buy from ${name} rides the launch (TEE_LAUNCH_BUYS_ENABLED is on).`)
  }
  return lines
}

/** The one line that names a switch no launch path can pass, or undefined when none is off. */
function gatedOff(answer: CheckAnswer): string | undefined {
  if (!answer.key.scopes.includes("launch:write"))
    return "this key lacks launch:write, so no launch path works under it."
  if (!answer.switches.headlessLaunch) return "launches are off on this server (HEADLESS_LAUNCH_ENABLED off)."
  return undefined
}

/** The embedded wallet's verdict lines, in the same voice. */
function embeddedLines(answer: CheckAnswer, requestedChain?: TradeChain): string[] {
  const lines: string[] = []
  const gated = gatedOff(answer)
  if (answer.key.embeddedWalletPermission === "denied") {
    lines.push("The embedded wallet is denied on this key.")
    return lines
  }
  const paths = embeddedPaths(answer, requestedChain)
  if (!paths.some((path) => path.wallet)) {
    lines.push(
      `This account has no ${requestedChain ? `${chainName(requestedChain)} ` : ""}embedded wallet. Create one in the app, or launch from a TEE wallet with --wallet <tee>.`,
    )
    return lines
  }
  if (gated) {
    lines.push(`Embedded wallet: ${gated}`)
    return lines
  }
  for (const { chain, wallet } of paths) {
    if (!wallet) continue
    if (wallet.delegated === false) {
      lines.push(`The account's ${chainName(chain)} embedded wallet is not delegated for agent access.`)
      continue
    }
    lines.push(`This key can launch from the ${chainName(chain)} embedded wallet with no first buy.`)
    if (chain === "solana" && !answer.switches.agentTrading)
      lines.push("A Solana first buy from the embedded wallet is off on this server (AGENT_TRADING_ENABLED off).")
    else
      lines.push(
        chain === "solana"
          ? "A Solana first buy can ride the launch as one bundle signed by Candle."
          : "A Hood first buy can ride the launch best effort after creation.",
      )
  }
  return lines
}

/** Whether a TEE wallet row is a working launch path for this key. */
function walletWorks(answer: CheckAnswer, row: CheckAnswer["wallets"][number], requestedChain?: TradeChain): boolean {
  return (
    (requestedChain === undefined || rowChain(row) === requestedChain) &&
    gatedOff(answer) === undefined &&
    answer.key.selfLaunch &&
    row.allowLaunch &&
    row.active
  )
}

/** With no chain hint, report both paths independently; delegation on one never blocks the other. */
function embeddedPaths(answer: CheckAnswer, requestedChain?: TradeChain) {
  return (requestedChain ? [requestedChain] : (["solana", "hood"] as const)).map((chain) => ({
    chain,
    wallet: chain === "solana" ? answer.embedded?.solana : answer.embedded?.evm,
  }))
}

/** Whether the embedded wallet is a working launch path for this key. */
function embeddedWorks(answer: CheckAnswer, requestedChain?: TradeChain): boolean {
  return (
    gatedOff(answer) === undefined &&
    answer.key.embeddedWalletPermission === "allowed" &&
    embeddedPaths(answer, requestedChain).some(({ wallet }) => wallet != null && wallet.delegated !== false)
  )
}

/** How a TEE wallet is named back to someone who has to pick one, as trading.ts names them. */
function describeRow(row: CheckAnswer["wallets"][number]): string {
  return `${row.label ? `${row.label} ` : ""}(${row.id}, ${row.address})`
}

/**
 * The preflight itself: one GET, then the one screen. `--wallet <name>` narrows the answer to that
 * wallet (or to the embedded wallet by its names); the flags' chain hint narrows compatible paths.
 * Exit 0 when a launch path the caller asked about works, 1 when none does. Under --json the facts and the
 * verdicts print as one value.
 */
export async function launchCheck(
  ctx: CommandContext,
  key: string,
  walletFlag: string | undefined,
  requestedChain?: TradeChain,
): Promise<number> {
  const answer = checkSchema.parse(await request(ctx, key, "/api/v1/launch/preflight"))
  const embeddedOnly = walletFlag !== undefined && EMBEDDED_NAMES.has(walletFlag)
  const named =
    walletFlag === undefined || embeddedOnly
      ? []
      : answer.wallets.filter((row) => row.id === walletFlag || row.address === walletFlag || row.label === walletFlag)
  if (walletFlag !== undefined && !embeddedOnly && named.length !== 1)
    throw new TradingError(
      "TEE_WALLET_REQUIRED",
      named.length > 1
        ? `"${walletFlag}" matches ${named.length} TEE wallets on this key: ${named.map(describeRow).join("; ")}. Name one by id or address.`
        : answer.wallets.length === 0
          ? "This key has no TEE wallets bound to it. Enrol one, or select the profile whose key holds it."
          : `No TEE wallet on this key is called "${walletFlag}". Bound to this key: ${answer.wallets.map(describeRow).join("; ")}.`,
    )
  const shownWallets = walletFlag === undefined ? answer.wallets : named
  const lines: string[] = [`Launch paths for key ${answer.key.keyPrefix} (tier ${answer.key.tier}):`]
  if (requestedChain) lines.push(`Requested launch chain: ${chainName(requestedChain)}.`)
  if (walletFlag === undefined || embeddedOnly) lines.push(...embeddedLines(answer, requestedChain))
  for (const row of shownWallets) lines.push(...walletLines(answer, row, requestedChain))
  const works =
    (walletFlag === undefined || embeddedOnly ? embeddedWorks(answer, requestedChain) : false) ||
    shownWallets.some((row) => walletWorks(answer, row, requestedChain))
  lines.push(
    works
      ? "Nothing was uploaded, built or sent; this was the whole check."
      : "No launch path works for this key. Nothing was uploaded, built or sent.",
  )
  const result: Json = {
    success: true,
    check: true,
    works,
    ...(requestedChain ? { requestedChain } : {}),
    key: answer.key,
    switches: answer.switches,
    ...(answer.embedded ? { embedded: answer.embedded } : {}),
    wallets: shownWallets.map((row) => ({
      ...row,
      canLaunch: walletWorks(answer, row, requestedChain),
      canBuy:
        walletWorks(answer, row, requestedChain) &&
        answer.switches.teeLaunchBuys &&
        (row.chain !== "solana" || answer.switches.agentTrading),
    })),
    ...(embeddedOnly || walletFlag === undefined ? { embeddedCanLaunch: embeddedWorks(answer, requestedChain) } : {}),
  }
  if (ctx.json) ctx.deps.stdout.write(`${JSON.stringify(result)}\n`)
  else ctx.deps.stdout.write(`${lines.join("\n")}\n`)
  return works ? 0 : 1
}
