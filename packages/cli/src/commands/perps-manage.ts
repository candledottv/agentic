/**
 * Hyperliquid phase 1 D (BE-1584, spec docs/superpowers/specs/2026-10-17-hyperliquid-phase1-d-management-actions-design.md):
 * `candle perps modify | margin | tpsl | schedule-cancel | flatten | reduce-only`. (`close --pct` is
 * in perps.ts.)
 *
 * Single actions (modify, margin, schedule-cancel) go through `runPerpsWrite`: build, check against
 * this machine's own read of Hyperliquid, confirm, relay-sign, submit, judge the answer per leg.
 * TP/SL changes and flatten are plans of several such steps, run by `hyperliquid-manage.ts` (the
 * SDK's file byte for byte, as the SDK and the MCP server run it): one prompt for the complete plan
 * unless --yes; --no-submit builds and checks the first step only and --sign-only signs it only,
 * with the rest reported as planned. Exit 0 when the plan completed (or, with --no-submit or
 * --sign-only, when its first step passed), 1 when it refused or ended incomplete, 3 when a step was
 * signed and its submit did not answer (the signed body is in the step's exchangeBody), 2 for usage.
 *
 * `reduce-only` reads or sets the key's restriction: this key may turn itself on; turning it off,
 * or setting another key, is the owner's, with the device token. --yes never substitutes for it.
 */
import { randomBytes } from "node:crypto"
import { parseArgs } from "../args"
import { type ApiResult, apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveDeviceToken } from "../deps"
import { writeFields, writeSuccess } from "../human-output"
import { HYPERLIQUID_CLOID_RE, type HyperliquidTypedData } from "../hyperliquid"
import {
  PerpsWorkflowError,
  type PerpsWorkflowIo,
  type PerpsWorkflowResult,
  type PerpsWorkflowStep,
  perpsTpslParamsProblem,
  runPerpsFlatten,
  runPerpsTpsl,
} from "../hyperliquid-manage"
import { notice } from "../presentation"
import { writeFailure, writeLocalFailure, writeUsageFailure } from "../render"
import { type Json, safeText, TradingError, tradingKey } from "../trading"
import { NO_DEVICE_TOKEN } from "./keys"
import {
  builderPin,
  PERPS_SCOPE,
  perpsNetwork,
  perpsRequest,
  perpsWallet,
  runPerpsWrite,
  sharedWrite,
  slippage,
  typedDataAuthorization,
} from "./perps"
import { printTradingResult, tradingFailure } from "./swap"
import { resolveTargetKey } from "./tee-rebind"

const DEC_RE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/
const USD_RE = /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/
const WRITE_BOOLEANS = ["--yes", "--no-submit", "--sign-only"]

function usage(ctx: CommandContext, line: string): number {
  writeUsageFailure(ctx.deps, line, ctx.json)
  return 2
}

// ── modify ───────────────────────────────────────────────────────────────────────────────────

const MODIFY_USAGE =
  "Usage: candle perps modify --cloid <0x+32 hex> [--price <px>] [--size <n>] [--slippage-bps <n>] [--wallet <tee>] [--yes]"

/**
 * Change a resting order Candle built: its price, its size, or both. The replacement keeps the
 * order's side, time in force and reduce-only flag, read from Hyperliquid and checked here; it gets a
 * new cloid. A trigger leg cannot be modified (cancel it, or use `perps tpsl`).
 */
export async function perpsModify(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--wallet", "--cloid", "--price", "--size", "--slippage-bps"],
    booleanFlags: WRITE_BOOLEANS,
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const { values } = parsed
  const cloid = values["--cloid"]?.toLowerCase()
  if (parsed.positionals.length !== 0 || cloid === undefined || !HYPERLIQUID_CLOID_RE.test(cloid))
    return usage(ctx, MODIFY_USAGE)
  if (values["--price"] === undefined && values["--size"] === undefined)
    return usage(ctx, "Give --price, --size, or both.")
  for (const flag of ["--price", "--size"])
    if (values[flag] !== undefined && !DEC_RE.test(values[flag] as string))
      return usage(ctx, `${flag} must be a plain decimal.`)
  const slippageBps = slippage(values["--slippage-bps"])
  if (slippageBps === null) return usage(ctx, "--slippage-bps must be a whole number of at least 1.")
  const body: Json = {
    cloid,
    ...(values["--price"] !== undefined ? { price: values["--price"] } : {}),
    ...(values["--size"] !== undefined ? { size: values["--size"] } : {}),
    ...(slippageBps !== undefined ? { slippageBps } : {}),
  }
  try {
    return await runPerpsWrite(ctx, {
      path: "/api/v1/agent/perps/modify",
      body,
      method: "modify",
      ...sharedWrite(values, parsed.booleans),
    })
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}

// ── margin ───────────────────────────────────────────────────────────────────────────────────

const MARGIN_USAGE =
  "Usage: candle perps margin <coin> --amount <usd> | candle perps margin <coin> --mode cross|isolated [--leverage <n>]  [--wallet <tee>] [--yes]"

/**
 * `--amount` adds isolated margin to an isolated position (a positive USD amount, at most six
 * decimals; this command never removes margin). `--mode` sets the coin's margin mode, keeping the
 * current leverage unless `--leverage` names one; a mode change needs no position and no resting
 * order in the coin. Exactly one of the two.
 */
export async function perpsMargin(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--wallet", "--amount", "--mode", "--leverage"],
    booleanFlags: WRITE_BOOLEANS,
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [coin] = parsed.positionals
  const { values } = parsed
  if (parsed.positionals.length !== 1 || !coin) return usage(ctx, MARGIN_USAGE)
  const amount = values["--amount"]
  const mode = values["--mode"]
  if ((amount === undefined) === (mode === undefined))
    return usage(ctx, `Give --amount or --mode, not both. ${MARGIN_USAGE}`)
  try {
    if (amount !== undefined) {
      if (values["--leverage"] !== undefined) return usage(ctx, "--leverage goes with --mode.")
      if (!USD_RE.test(amount) || /^0+(\.0+)?$/.test(amount))
        return usage(ctx, "--amount must be a positive USD amount with at most 6 decimals.")
      return await runPerpsWrite(ctx, {
        path: "/api/v1/agent/perps/margin",
        body: { coin, amount },
        method: "margin",
        ...sharedWrite(values, parsed.booleans),
      })
    }
    if (mode !== "cross" && mode !== "isolated") return usage(ctx, "--mode must be cross or isolated.")
    const raw = values["--leverage"]
    const leverage = raw === undefined ? undefined : Number(raw)
    if (leverage !== undefined && (!/^[1-9][0-9]{0,2}$/.test(raw as string) || !Number.isInteger(leverage)))
      return usage(ctx, "--leverage must be a whole number of at least 1.")
    return await runPerpsWrite(ctx, {
      path: "/api/v1/agent/perps/leverage",
      body: { coin, mode, ...(leverage !== undefined ? { leverage } : {}) },
      method: "leverage",
      ...sharedWrite(values, parsed.booleans),
    })
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}

// ── schedule-cancel ──────────────────────────────────────────────────────────────────────────

const SCHEDULE_USAGE =
  "Usage: candle perps schedule-cancel <seconds> | candle perps schedule-cancel --clear  [--wallet <tee>] [--yes]"

/**
 * Hyperliquid's own cancel-all timer, `<seconds>` from now (at least 5), or `--clear`. It is
 * wallet-wide: when it fires it cancels every open order on the account, protection included, and
 * no positions. Candle records the venue's acknowledgement; no public read can confirm the timer,
 * and Hyperliquid's ten triggers per UTC day are never counted here.
 */
export async function perpsScheduleCancel(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--wallet"], booleanFlags: [...WRITE_BOOLEANS, "--clear"] })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const clear = parsed.booleans.has("--clear")
  const [seconds] = parsed.positionals
  if (clear ? parsed.positionals.length !== 0 : parsed.positionals.length !== 1) return usage(ctx, SCHEDULE_USAGE)
  if (!clear && (!/^[0-9]{1,9}$/.test(seconds as string) || Number(seconds) < 5))
    return usage(ctx, "<seconds> must be a whole number of at least 5.")
  try {
    return await runPerpsWrite(ctx, {
      path: "/api/v1/agent/perps/schedule-cancel",
      body: clear ? { clear: true } : { seconds: Number(seconds) },
      method: "scheduleCancel",
      ...sharedWrite(parsed.values, parsed.booleans),
    })
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}

// ── tpsl and flatten: plans ──────────────────────────────────────────────────────────────────

async function workflowIo(
  ctx: CommandContext,
  opts: { wallet?: string; yes: boolean; submit: boolean; signOnly: boolean },
): Promise<PerpsWorkflowIo> {
  const key = await tradingKey(ctx)
  const { wallet } = await perpsWallet(ctx, key, opts.wallet, PERPS_SCOPE)
  if (!wallet) throw new TradingError("TEE_WALLET_REQUIRED", "No EVM TEE wallet resolved.")
  const builder = builderPin(ctx)
  // A failed read never says "unrestricted": the plan is then checked as for a reduce-only key.
  const reduceOnly = await perpsRequest(ctx, key, "/api/v1/agent/keys/self/perps-reduce-only").catch(() => null)

  return {
    network: perpsNetwork(ctx),
    walletId: wallet.id,
    address: wallet.address,
    builder,
    keyReduceOnly: reduceOnly === null ? true : reduceOnly.perpsReduceOnly === true,
    fetcher: ctx.deps.fetch as never,
    now: ctx.deps.now,
    build: (path, body) => perpsRequest(ctx, key, path, body as Json),
    read: (path) => perpsRequest(ctx, key, path),
    sign: async (typedData: HyperliquidTypedData) => {
      const relay = await perpsRequest(
        ctx,
        key,
        `/api/v1/agent/wallets/${encodeURIComponent(wallet.id)}/sign`,
        typedDataAuthorization(wallet, typedData) as unknown as Json,
      )
      if (typeof relay.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(relay.signature))
        throw new TradingError("INVALID_RESPONSE", "The relay did not return a signature.")
      return relay.signature
    },
    mode: !opts.submit ? "no-submit" : opts.signOnly ? "sign-only" : "submit",
    confirm: async (plan) => {
      writeFields(ctx.deps, ctx.json ? "stderr" : "stdout", [
        ["Hyperliquid account", safeText(wallet.address)],
        ["Network", perpsNetwork(ctx)],
      ])
      for (const step of plan.steps)
        notice(ctx.deps, ctx.json ? "stderr" : "stdout", "note", `  ${stepLine(step)}\n`.trim())
      for (const warning of plan.warnings)
        notice(ctx.deps, ctx.json ? "stderr" : "stdout", "warning", `${safeText(warning)}\n`.trim())
      if (opts.yes) return true
      if (!ctx.deps.isTTY.stdin)
        throw new TradingError("CONFIRMATION_REQUIRED", "Run interactively to confirm, or use --yes.")
      return (await ctx.deps.promptLine("Sign and submit this plan? [y/N] ")).trim().toLowerCase() === "y"
    },
    cloid: () => `0x${randomBytes(16).toString("hex")}`,
  }
}

function stepLine(step: PerpsWorkflowStep): string {
  const what =
    step.kind === "cancel"
      ? `cancel ${step.leg ? `${step.leg} leg ` : ""}${safeText(step.coin)} order ${safeText(step.target?.oid ?? "?")}`
      : step.kind === "attach"
        ? `attach ${safeText(step.leg)} on ${safeText(step.coin)}`
        : `close ${safeText(step.coin)} (full, reduce-only IOC)`
  return `${step.step + 1}. ${what}: ${step.status}${step.detail ? ` (${safeText(step.detail)})` : ""}`
}

function workflowExit(ctx: CommandContext, result: PerpsWorkflowResult, mode: PerpsWorkflowIo["mode"]): number {
  const unknown = result.steps.some((s) => s.status === "unknown")
  if (ctx.json) ctx.deps.stdout.write(`${JSON.stringify(result)}\n`)
  else {
    for (const step of result.steps) notice(ctx.deps, "stdout", "note", `${stepLine(step)}\n`.trim())
    for (const warning of result.warnings) notice(ctx.deps, "stdout", "warning", `${safeText(warning)}\n`.trim())
    for (const leg of result.unowned ?? [])
      notice(
        ctx.deps,
        "stdout",
        "note",
        `Not Candle's, left untouched: ${leg.leg} order ${leg.oid} at ${safeText(leg.triggerPx)}\n`.trim(),
      )
    if (mode !== "submit")
      notice(
        ctx.deps,
        "stdout",
        "note",
        "Only the first step was built (and signed, with --sign-only); the rest is planned.\n".trim(),
      )
    else if (result.complete)
      writeSuccess(
        ctx.deps,
        "stdout",
        (result.operation === "flatten" ? "Main perps flat (an observed snapshot).\n" : "Done.\n").trim(),
      )
    else notice(ctx.deps, "stdout", "warning", `Incomplete. Remaining: ${safeText(JSON.stringify(result.remaining))}`)
  }
  if (unknown) return 3
  if (mode !== "submit") return result.steps.some((s) => s.status === "rejected") ? 1 : 0
  return result.complete ? 0 : 1
}

function workflowFailure(ctx: CommandContext, error: unknown): number {
  if (error instanceof PerpsWorkflowError)
    return tradingFailure(
      ctx,
      new TradingError(error.code, error.message, {
        ...(Object.keys(error.details).length ? { details: error.details } : {}),
      }),
    )
  return tradingFailure(ctx, error)
}

const TPSL_USAGE =
  "Usage: candle perps tpsl <coin> [--take-profit <px>] [--stop-loss <px>] [--remove-tp] [--remove-sl] [--target-tp <cloid>] [--target-sl <cloid>] [--wallet <tee>] [--yes]"

/**
 * Attach, change or remove the position's take-profit and stop-loss. Each leg is a reducing market
 * trigger sized to the position now; a change cancels the old leg, sees it gone, and only then
 * places the new one, so the position is briefly unprotected on that side. A flag left out leaves
 * that leg alone. Legs Candle did not build are listed and never touched; when several of Candle's
 * match, --target-tp / --target-sl names the one.
 */
export async function perpsTpsl(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--wallet", "--take-profit", "--stop-loss", "--target-tp", "--target-sl"],
    booleanFlags: [...WRITE_BOOLEANS, "--remove-tp", "--remove-sl"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [coin] = parsed.positionals
  if (parsed.positionals.length !== 1 || !coin) return usage(ctx, TPSL_USAGE)
  const { values, booleans } = parsed
  const params = {
    coin,
    ...(values["--take-profit"] !== undefined ? { takeProfit: values["--take-profit"] } : {}),
    ...(values["--stop-loss"] !== undefined ? { stopLoss: values["--stop-loss"] } : {}),
    ...(booleans.has("--remove-tp") ? { removeTp: true } : {}),
    ...(booleans.has("--remove-sl") ? { removeSl: true } : {}),
    ...(values["--target-tp"] !== undefined ? { targetTp: values["--target-tp"].toLowerCase() } : {}),
    ...(values["--target-sl"] !== undefined ? { targetSl: values["--target-sl"].toLowerCase() } : {}),
  }
  const problem = perpsTpslParamsProblem(params)
  if (problem) return usage(ctx, `${problem}. ${TPSL_USAGE}`)
  try {
    const shared = sharedWrite(values, booleans)
    const io = await workflowIo(ctx, shared)
    return workflowExit(ctx, await runPerpsTpsl(io, params), io.mode)
  } catch (error) {
    return workflowFailure(ctx, error)
  }
}

/**
 * Cancel every open main-perp order on the wallet (protection included), then close every main-perp
 * position, then read again. At most 100 signed steps a run; run it again for the rest. Spot, HIP-3
 * and vault exposure is not reached.
 */
export async function perpsFlatten(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--wallet"], booleanFlags: WRITE_BOOLEANS })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length !== 0) return usage(ctx, "Usage: candle perps flatten [--wallet <tee>] [--yes]")
  try {
    const io = await workflowIo(ctx, sharedWrite(parsed.values, parsed.booleans))
    return workflowExit(ctx, await runPerpsFlatten(io), io.mode)
  } catch (error) {
    return workflowFailure(ctx, error)
  }
}

// ── reduce-only ──────────────────────────────────────────────────────────────────────────────

const REDUCE_ONLY_USAGE = "Usage: candle perps reduce-only [on|off] [--key <self|prefix|label>]"

/**
 * Read (no argument) or set the key's perps reduce-only restriction. `on` for this key uses its own
 * credential; `off`, or any write to another key, needs the owner's device token (`candle auth
 * login`). It limits future Candle builds only: it cancels nothing and revokes no signed action.
 */
export async function perpsReduceOnly(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--key"] })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [verb] = parsed.positionals
  if (parsed.positionals.length > 1 || (verb !== undefined && verb !== "on" && verb !== "off"))
    return usage(ctx, REDUCE_ONLY_USAGE)
  const target = parsed.values["--key"] ?? "self"
  const self = target === "self"
  try {
    if (verb === undefined) {
      if (!self) return usage(ctx, "Reading names this key only: drop --key, or use candle keys show for another.")
      const key = await tradingKey(ctx)
      const answer = await perpsRequest(ctx, key, "/api/v1/agent/keys/self/perps-reduce-only")
      if (ctx.json) return printTradingResult(ctx, answer)
      writeFields(ctx.deps, "stdout", [
        ["Key", safeText(answer.keyPrefix)],
        ["Perps reduce-only", answer.perpsReduceOnly === true ? "on" : "off"],
        ["Policy version", safeText(answer.perpsPolicyVersion)],
      ])
      return 0
    }
  } catch (error) {
    return tradingFailure(ctx, error)
  }
  const body = { perpsReduceOnly: verb === "on" }
  let result: ApiResult
  if (self && verb === "on") {
    let key: string
    try {
      key = await tradingKey(ctx)
    } catch (error) {
      return tradingFailure(ctx, error)
    }
    result = await apiRequest("/api/v1/agent/keys/self/perps-reduce-only", {
      method: "PUT",
      body,
      apiUrl: ctx.apiUrl,
      credentials: { apiKey: key },
      auth: "key",
      fetch: ctx.deps.fetch,
      env: ctx.deps.env,
    })
  } else {
    // The owner's route: the device token. A key's own credential can never turn this off.
    const deviceToken = await resolveDeviceToken(ctx.deps, ctx.profile)
    if (!deviceToken) {
      writeLocalFailure(ctx.deps, NO_DEVICE_TOKEN, ctx.json)
      return 1
    }
    let keyPrefix = target
    if (self) {
      let key: string
      try {
        key = await tradingKey(ctx)
      } catch (error) {
        return tradingFailure(ctx, error)
      }
      const current = await perpsRequest(ctx, key, "/api/v1/agent/keys/self/perps-reduce-only").catch(() => null)
      if (!current || typeof current.keyPrefix !== "string") {
        writeLocalFailure(
          ctx.deps,
          {
            code: "PERPS_REDUCE_ONLY_UNREAD",
            message: "Could not read this key's prefix; name it with --key <prefix>.",
          },
          ctx.json,
        )
        return 1
      }
      keyPrefix = current.keyPrefix
    } else {
      const resolved = await resolveTargetKey(ctx, deviceToken, target, { codePrefix: "PERPS_REDUCE_ONLY" })
      if (!resolved.ok) return resolved.code
      keyPrefix = resolved.keyPrefix
    }
    result = await apiRequest(`/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}/perps-reduce-only`, {
      method: "PUT",
      body,
      apiUrl: ctx.apiUrl,
      credentials: { deviceToken },
      auth: "device",
      fetch: ctx.deps.fetch,
      env: ctx.deps.env,
    })
  }
  if (!result.ok) {
    if (result.status === 404 && result.code === undefined) {
      writeLocalFailure(
        ctx.deps,
        {
          code: "PERPS_REDUCE_ONLY_UNSUPPORTED",
          message: "This Candle API cannot store reduce-only yet; nothing changed.",
        },
        ctx.json,
      )
      return 1
    }
    writeFailure(ctx.deps, result, { apiUrl: ctx.apiUrl, authType: self && verb === "on" ? "key" : "device" }, ctx.json)
    return 1
  }
  const answer = result.body as Json
  if (ctx.json) return printTradingResult(ctx, answer)
  writeFields(ctx.deps, "stdout", [
    ["Key", safeText(answer.keyPrefix)],
    ["Perps reduce-only", answer.perpsReduceOnly === true ? "on" : "off"],
    ["Changed", answer.changed === false ? "no" : "yes"],
    ["Policy version", safeText(answer.perpsPolicyVersion)],
  ])
  for (const line of Array.isArray(answer.limits) ? answer.limits : [])
    notice(ctx.deps, "stdout", "note", `  ${safeText(line)}\n`.trim())
  return 0
}
