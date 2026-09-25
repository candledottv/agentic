/**
 * BE-355 (spec `docs/superpowers/specs/2026-09-24-cli-default-solana-rpc-design.md`): which Solana
 * RPC a command uses, and what it says about it.
 *
 * One resolver for every Solana command (D1): `--rpc-url`, else `CANDLE_SOLANA_RPC_URL`, else the
 * acting profile's `rpcUrl`, else the public endpoint. The same validation applies to every source,
 * and the URL itself (it may carry a provider key) is never printed, never written to stdout, and
 * never put in a JSON document: only its host. No Candle host is ever a Solana endpoint (decision
 * 6): none of the four sources is derived from the API URL.
 *
 * Disclosure (D2) happens before a command's FIRST request, not at resolution, so a command that
 * refuses before any request prints nothing. It is the host line always, and, for the public
 * default only, a notice that the public endpoint rate-limits and sees every address it is asked
 * about. The notice shows once per machine, recorded in `config.json` as `publicRpcNotice` only
 * after it was printed; a failed write is swallowed and the notice prints again next time.
 *
 * `rpcFixLines` is the one source of every "Fix:" text (D2, D3, D4). It has two forms: with an
 * acting profile it names `candle profile set <that profile>`; with no acting profile (which only
 * happens when there are no profiles at all, see `resolveProfileName`) it names the flag, the env
 * var and `candle auth login`, and never `profile set`, because that command refuses when there is
 * no profile to set. No printed line contains the literal `<name>`; the only placeholder is
 * `<your-rpc>`.
 *
 * `vault restore`'s gap scan is the one command that does not resolve here (D7): it reads
 * `--rpc-url` only, and `solanaClientFor` gives it the same disclosure and retry once it has one.
 */
import type { CliConfig } from "./config"
import type { CommandContext } from "./deps"
import {
  createSolanaRpc,
  describeRateLimit,
  isRateLimited,
  type SolanaRpc,
  SolanaRpcError as SolanaRpcErrorClass,
} from "./solana-lite"

type SolanaRpcError = SolanaRpcErrorClass

import { VaultError } from "./vault/errors"

export const PUBLIC_SOLANA_RPC = "https://api.mainnet-beta.solana.com"
export const PUBLIC_SOLANA_RPC_HOST = "api.mainnet-beta.solana.com"
export const RPC_URL_ENV = "CANDLE_SOLANA_RPC_URL"
/** The one placeholder any fix line may carry. */
const RPC_PLACEHOLDER = "https://<your-rpc>"

export type RpcSource = "flag" | "env" | "profile" | "default"

export interface SolanaEndpoint {
  /** Never printed, never written to stdout, never put in a JSON document. Only `fetch` sees it. */
  url: string
  /** `new URL(url).host`: what every printed line and document carries instead. */
  host: string
  source: RpcSource
}

/**
 * D1's rule, for every source: `https:`, or `http:` for `127.0.0.1` / `localhost` only. The message
 * names the source and never echoes the value, because the value may carry a key. `undefined`
 * when the value passes.
 */
export function validateSolanaRpcUrl(url: string, source: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return `${source} is not a valid URL`
  }
  const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost"
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    return `${source} must be https:// (plain http is allowed only for 127.0.0.1 / localhost).`
  }
  return undefined
}

/** How a source is named in a validation message: the flag, the variable, or the profile's field. */
function sourceLabel(source: RpcSource, ctx: CommandContext): string {
  if (source === "flag") return "--rpc-url"
  if (source === "env") return RPC_URL_ENV
  return `profile ${ctx.profile}'s rpcUrl`
}

/** How a source is named in the host line's parenthetical. */
export function describeSource(endpoint: SolanaEndpoint, ctx: CommandContext): string {
  if (endpoint.source === "flag") return "--rpc-url"
  if (endpoint.source === "env") return RPC_URL_ENV
  if (endpoint.source === "profile") return `profile ${ctx.profile}`
  return "public default"
}

/**
 * `--rpc-url`, else `CANDLE_SOLANA_RPC_URL`, else the acting profile's `rpcUrl`, else
 * `PUBLIC_SOLANA_RPC`. Pure: no request, no stderr. An empty or whitespace env value is unset and
 * falls through to the profile. In pre-profile mode (`ctx.profile === undefined`) there is no
 * profile field to read and the resolver goes from env to the default.
 */
export function resolveSolanaEndpoint(
  ctx: CommandContext,
  flag: string | undefined,
  config: CliConfig,
): SolanaEndpoint | { error: string } {
  const profileUrl =
    ctx.profile !== undefined && config.profiles !== undefined && Object.hasOwn(config.profiles, ctx.profile)
      ? config.profiles[ctx.profile]?.rpcUrl?.trim() || undefined
      : undefined
  const candidates: Array<[RpcSource, string | undefined]> = [
    ["flag", flag],
    ["env", ctx.deps.env[RPC_URL_ENV]?.trim() || undefined],
    ["profile", profileUrl],
  ]
  for (const [source, url] of candidates) {
    if (url === undefined) continue
    const fault = validateSolanaRpcUrl(url, sourceLabel(source, ctx))
    if (fault !== undefined) return { error: fault }
    return { url, host: new URL(url).host, source }
  }
  return { url: PUBLIC_SOLANA_RPC, host: PUBLIC_SOLANA_RPC_HOST, source: "default" }
}

/** The endpoint an explicit, already validated `--rpc-url` names (restore's gap scan, D7). */
export function flagEndpoint(url: string): SolanaEndpoint {
  return { url, host: new URL(url).host, source: "flag" }
}

/** The `profile set` command for the acting profile, written once so no line can misspell it. */
function profileSetCommand(profile: string): string {
  return `candle profile set ${profile} --rpc-url ${RPC_PLACEHOLDER}`
}

/**
 * D2: every "Fix:" line, in one of two forms. Every place that names the fix (the notice's
 * pointers, `RPC_RATE_LIMITED`'s suggestion, the post-signature line) reads it from here.
 */
export function rpcFixLines(ctx: CommandContext): string[] {
  if (ctx.profile !== undefined) {
    return [profileSetCommand(ctx.profile), `or, for one command, --rpc-url ${RPC_PLACEHOLDER} or ${RPC_URL_ENV}`]
  }
  return [
    `--rpc-url ${RPC_PLACEHOLDER} on this command, or ${RPC_URL_ENV} for every command`,
    "or sign in (candle auth login) to store one per profile",
  ]
}

/** D2's notice, verbatim, in the profile form or the pre-profile form. */
export function publicRpcNoticeLines(ctx: CommandContext): string[] {
  const first = `Using the public Solana RPC, ${PUBLIC_SOLANA_RPC_HOST}. It rate-limits heavily, and it sees every address this CLI asks it about.`
  const last = "This notice is shown once on this machine."
  if (ctx.profile !== undefined) {
    return [
      first,
      `Set your own RPC for this profile: ${profileSetCommand(ctx.profile)}`,
      `Or for one command: --rpc-url ${RPC_PLACEHOLDER}, or ${RPC_URL_ENV}.`,
      last,
    ]
  }
  return [
    first,
    `Set your own RPC for one command with --rpc-url ${RPC_PLACEHOLDER}, or for every command with ${RPC_URL_ENV}.`,
    "Or sign in (candle auth login) to store one per profile.",
    last,
  ]
}

/**
 * The notice, once per machine. Read the record, print, then record: a write that fails (read-only
 * config, full disk) is swallowed, as `update-notice.ts` does, so the notice prints again next time
 * and never fails the command. Nothing else suppresses it: no env var, no flag, and not `--json`.
 */
async function maybeWritePublicRpcNotice(ctx: CommandContext): Promise<void> {
  let config: CliConfig = {}
  try {
    config = await ctx.deps.readConfig()
  } catch {
    // An unreadable config is treated as "never shown": printing twice is the safe failure.
  }
  if (config.publicRpcNotice?.shownAt !== undefined) return
  for (const line of publicRpcNoticeLines(ctx)) ctx.deps.stderr.write(`${line}\n`)
  try {
    await ctx.deps.writeConfig({ publicRpcNotice: { shownAt: ctx.deps.now() } })
  } catch {
    // Deliberately swallowed: see the doc comment.
  }
}

/** The host line every Solana command prints on stderr before its first request. */
export function hostLine(endpoint: SolanaEndpoint, ctx: CommandContext): string {
  return `Solana RPC: ${endpoint.host} (${describeSource(endpoint, ctx)})`
}

export interface SolanaClient {
  endpoint: SolanaEndpoint
  /** Built with `deps.sleep`, so every read is retried once (D3) and a test never waits. */
  rpc: SolanaRpc
  /**
   * D2, before the FIRST request: the notice when the source is the public default and it has not
   * been recorded, then the host line. `rpc` calls it before its first request on its own, so a
   * command needs it only to put the host line ABOVE a sentence of its own that precedes the
   * request (`vault list`, `portfolio`). Idempotent.
   */
  disclose(): Promise<void>
  /**
   * Reads before any signature (D3): runs `read` and turns a rate limit that survived the
   * client's one retry into `RPC_RATE_LIMITED` (exit 1, nothing signed or sent). Every other
   * failure passes through unchanged.
   */
  read<T>(read: () => Promise<T>): Promise<T>
}

/**
 * `rpc` with every method preceded by `disclose()`. The disclosure is tied to the first request
 * itself rather than to a call site's judgement of where that request is, so a command that
 * refuses before any request cannot have printed it, and one that adds a read later cannot
 * forget it. The methods close over their client and never read `this`, so calling them
 * unbound is safe.
 */
function disclosing(rpc: SolanaRpc, disclose: () => Promise<void>): SolanaRpc {
  const wrapped: Record<string, unknown> = {}
  for (const key of Object.keys(rpc)) {
    const method = (rpc as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[key]
    if (typeof method !== "function") continue
    wrapped[key] = async (...args: unknown[]) => {
      await disclose()
      return method(...args)
    }
  }
  return wrapped as unknown as SolanaRpc
}

/** A client over a resolved endpoint. Creating it makes no request. */
export function solanaClientFor(ctx: CommandContext, endpoint: SolanaEndpoint): SolanaClient {
  let disclosed = false
  const disclose = async (): Promise<void> => {
    if (disclosed) return
    disclosed = true
    if (endpoint.source === "default") await maybeWritePublicRpcNotice(ctx)
    ctx.deps.stderr.write(`${hostLine(endpoint, ctx)}\n`)
  }
  return {
    endpoint,
    rpc: disclosing(createSolanaRpc(endpoint.url, ctx.deps.fetch, ctx.deps.sleep), disclose),
    disclose,
    async read(read) {
      try {
        return await read()
      } catch (error) {
        if (isRateLimited(error)) throw rpcRateLimitedError(ctx, endpoint.host, error)
        throw error
      }
    },
  }
}

/**
 * Resolve (D1) and build the client, reading the config the profile's `rpcUrl` lives in. The
 * `{ error }` is a usage refusal (exit 2), decided before any request and before any prompt.
 */
export async function openSolanaClient(
  ctx: CommandContext,
  flag: string | undefined,
): Promise<SolanaClient | { error: string }> {
  const endpoint = resolveSolanaEndpoint(ctx, flag, await ctx.deps.readConfig())
  if ("error" in endpoint) return endpoint
  return solanaClientFor(ctx, endpoint)
}

/**
 * A suggestion built from fix lines, in the shape each mode wants: `--json` carries the lines
 * joined with a newline and no prefix, so an agent reads the commands themselves; a person reads
 * `Fix: ` before the first line and the rest aligned under it.
 */
function fixSuggestion(ctx: CommandContext, lines: string[]): string {
  if (ctx.json) return lines.join("\n")
  const [first, ...rest] = lines
  return [`Fix: ${first}`, ...rest.map((line) => `     ${line}`)].join("\n")
}

/** D3's suggestion: the fix lines, the same whatever the source was. */
export function rateLimitedSuggestion(ctx: CommandContext): string {
  return fixSuggestion(ctx, rpcFixLines(ctx))
}

/** D3's message, before any signature. The status names what the RPC actually answered. */
export function rateLimitedMessage(host: string, error: SolanaRpcError): string {
  return `The Solana RPC at ${host} is rate-limiting this CLI (${describeRateLimit(error)}, retried once). Nothing was signed or sent.`
}

/** D3: the refusal a vault or TEE command stops with when the retry was also rate-limited. Exit 1. */
export function rpcRateLimitedError(ctx: CommandContext, host: string, error: SolanaRpcError): VaultError {
  return new VaultError("RPC_RATE_LIMITED", rateLimitedMessage(host, error), {
    suggestion: rateLimitedSuggestion(ctx),
    exitCode: 1,
  })
}

/**
 * D4's fix, after a signature: with an acting profile the one `profile set` line; with none, the
 * two pre-profile lines (there is no single-line fix without a profile).
 */
function postSignatureFixLines(ctx: CommandContext): string[] {
  const lines = rpcFixLines(ctx)
  return ctx.profile === undefined ? lines : lines.slice(0, 1)
}

/** D4's first line: the locally known signature is what to check before anything else. */
export function postSignatureRateLimitMessage(signature: string): string {
  return `The RPC rate-limited this CLI after the transaction was signed. It may still land: check ${signature} before anything else.`
}

/** D4's suggestion for the trading paths' `RPC_RATE_LIMITED` (exit 3), in the mode's shape. */
export function postSignatureSuggestion(ctx: CommandContext): string {
  return fixSuggestion(ctx, postSignatureFixLines(ctx))
}

/**
 * D4, on stderr in both modes: the uncertain-outcome line with the real signature, then the fix.
 * The paths that already report an uncertain send keep their outcome, JSON and exit code; this is
 * the one line they add when the cause was a rate limit.
 */
export function notePostSignatureRateLimit(ctx: CommandContext, signature: string): void {
  const [first, ...rest] = postSignatureFixLines(ctx)
  ctx.deps.stderr.write(`${postSignatureRateLimitMessage(signature)}\n`)
  ctx.deps.stderr.write(`Fix: ${first}\n`)
  for (const line of rest) ctx.deps.stderr.write(`     ${line}\n`)
}

/**
 * A thrown RPC error made safe to quote (invariant 1). The client's own `SolanaRpcError` never
 * carries the URL, but some runtimes put the full URL, key and all, into a connect failure's
 * message (`TypeError: fetch failed ...`). Every place that interpolates a thrown read, send or
 * status failure into its own text, or renders an unknown error at the top level, quotes this.
 */
export function describeRpcFailure(error: unknown): string {
  if (error instanceof SolanaRpcErrorClass) return error.message
  if (error instanceof Error) return error.message.replace(/https?:\/\/\S+/g, "<rpc>")
  return String(error)
}

/**
 * D3's partial-read sentence for the three commands that report rather than refuse (`vault list
 * --balances`, `portfolio`, `tee status`): the code, what the RPC answered, and the fix on one
 * line, in place of the RPC's own text.
 */
export function rateLimitedReadFailure(ctx: CommandContext, error: SolanaRpcError): string {
  return `RPC_RATE_LIMITED (${describeRateLimit(error)}, retried once). Fix: ${rpcFixLines(ctx).join(", ")}`
}
