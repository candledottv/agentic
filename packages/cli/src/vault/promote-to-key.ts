/**
 * BE-322: `--to-key <label|prefix>` on `candle vault promote` and `candle vault promote-batch`.
 *
 * The import binds each promoted wallet to the key that sends it (`resolveApiKey`). With the flag,
 * the command promotes exactly as before, under that key, and then moves the promoted wallets to
 * the named key through the rebind route BE-303 shipped (`POST /tee-wallets/rebind`, device token,
 * `keysAuth`). The target's secret never touches this machine. Without the flag, nothing here runs.
 *
 * Three parts, shared by both commands so they cannot drift:
 *
 * Key signers (spec 2026-09-25-key-signers-design.md, 5.2): when the target has an ACTIVE signer,
 * the preflight also reads it and checks it against this machine's pin, and the import then goes
 * onto that signer's quorum and binds to the target in the same call. No rebind follows, and this
 * machine stores no signer. A target with no signer keeps everything below exactly as it was.
 *
 * - **The preflight** (`preflightToKey`), before the unlock and before any write. The rebind
 *   route's preview resolves its selectors against the account's EXISTING TEE rows, so it cannot
 *   be asked about wallets that are not imported yet. The preflight therefore makes the target
 *   checks the rebind mutation makes (D2.1: on this account, not revoked, not expired,
 *   `production`, holds `swap:write`) from the same `GET /keys` listing `tee rebind --to-key`
 *   resolves a label against, plus the `selected`-scope room check (D2.3) from the target's wallet
 *   set. A refusal here writes nothing. The route's own preview still runs, once the wallets exist,
 *   immediately before each commit.
 * - **The rebind** (`rebindPromoted`), after the import: preview then commit per chunk of at most
 *   200 wallets (`REBIND_TOO_MANY`), the commit sending exactly the preview's ids and bindings.
 *   Only a wallet at `verified-active` can move; anything else is listed with its reason.
 * - **The report** (`renderRebindReport`, `rebindJson`). An import that succeeded whose rebind
 *   failed or was not reached leaves the wallet on the calling key. That is never reported as
 *   done: the wallets still on the calling key are named, with the exact `candle tee rebind`
 *   command that finishes the job, and a re-run of the same promote command picks up where it
 *   stopped (the promote's resume path, then a rebind that reports the moved ones `unchanged`).
 */
import { apiRequest } from "../client"
import type { KeyRow } from "../commands/keys"
import {
  capWarnings,
  commitRebind,
  DEVICE_TOKEN_REQUIRED,
  listAccountKeys,
  missingSignerFailure,
  postRebind,
  REBIND_NOTHING_PINNED,
  RELAY_SIGNER_LINE,
  type RebindFailureDetails,
  type RebindResponse,
  rebindFailureDetails,
  resolveTargetKey,
} from "../commands/tee-rebind"
import { type CommandContext, resolveApiKey, resolveDeviceToken } from "../deps"
import { activeSigner, confirmSignerPin, readSigner, type SignerView } from "../key-signers"
import { apiKeyPrefix } from "../profiles"
import { writeLocalFailure } from "../render"

/** The rebind route takes 1 to 200 wallets per request (`REBIND_TOO_MANY`); a batch holds up to 256 rows. */
export const REBIND_CHUNK = 200

/**
 * FALLBACK ONLY: a `selected`-scope key holds at most this many wallets (`MAX_WALLETS_PER_PROFILE`
 * in `packages/db/convex/lib/apiKeyWalletPolicy.ts`, which this package cannot import: the mirror
 * carries no `packages/db`). The live path reads the cap and the raw row count from
 * `GET /keys/:prefix/wallets`'s `scopeLimit` (BE-403); this and the listed count are used only
 * against an older server that omits it. The server's own check at commit time is the authority;
 * this one exists so a batch that cannot fit is refused before the unlock rather than after the
 * import. Only a run that adds wallets to the key is checked.
 */
export const SELECTED_SCOPE_LIMIT = 1000

/** The `GET /keys` row, with the fields the target checks read. The listing is the full key row minus its hash. */
export interface TargetKeyRow extends KeyRow {
  expiresAt?: number
  pausedAt?: number
  walletScope?: "all" | "selected"
  spendLimits?: Array<{ asset: string; maxPerTxRaw: string }> | null
  txLimit?: unknown | null
}

export interface ToKeyTarget {
  keyPrefix: string
  label: string | null
  walletScope: "all" | "selected"
  paused: boolean
  launchScope: boolean
  /** From the key row, the rule the route's `tradeReadiness` applies; the preview's value replaces it in `--json`. */
  tradeReady: { sol: boolean; usdc: boolean }
  missingCaps: string[]
}

export interface ToKeyFailure {
  code: string
  message: string
  suggestion?: string
}

/**
 * D2.1 of the rebind mutation, applied to the listing row, in the mutation's order and with the
 * route's own messages, so what the preflight refuses is what the commit would have refused.
 */
export function targetKeyRefusal(row: TargetKeyRow | undefined, keyPrefix: string, now: number): ToKeyFailure | null {
  const written = "Nothing was written."
  if (row === undefined) {
    return {
      code: "REBIND_KEY_NOT_FOUND",
      message: `No key ${keyPrefix} on this account. ${written}`,
      suggestion: "The target must be a key on the same account: candle keys list",
    }
  }
  if (row.revokedAt !== undefined) {
    return {
      code: "REBIND_TARGET_INVALID",
      message: `The target key ${keyPrefix} is revoked. ${written}`,
      suggestion: "Pick an active key: candle keys list",
    }
  }
  if (row.expiresAt !== undefined && row.expiresAt !== null && row.expiresAt <= now) {
    return {
      code: "REBIND_TARGET_INVALID",
      message: `The target key ${keyPrefix} has expired. ${written}`,
      suggestion: "Pick an active key: candle keys list",
    }
  }
  if (row.environment !== "production") {
    return {
      code: "REBIND_TARGET_INVALID",
      message: `The target key ${keyPrefix} is a test key; the trade rail refuses test keys. ${written}`,
      suggestion: "Pick a production key: candle keys list",
    }
  }
  if (!row.scopes.includes("swap:write")) {
    return {
      code: "REBIND_TARGET_INVALID",
      message: `The target key ${keyPrefix} lacks swap:write, which a TEE wallet needs to trade. ${written}`,
      suggestion: "Pick a key with swap:write, or mint one: candle keys create",
    }
  }
  return null
}

/**
 * The route's `tradeReadiness` rule, from the row: `sol` is ready only when `txLimit` is present
 * and a SOL cap exists (the lowercased asset, then the original spelling), likewise `usdc`.
 */
export function tradeReadinessOf(row: Pick<TargetKeyRow, "spendLimits" | "txLimit">): {
  tradeReady: { sol: boolean; usdc: boolean }
  missingCaps: string[]
} {
  const hasTxLimit = row.txLimit !== null && row.txLimit !== undefined
  const limits = row.spendLimits ?? []
  const cap = (asset: string) =>
    limits.some((limit) => limit.asset === asset.toLowerCase() || limit.asset === asset.toUpperCase())
  const sol = cap("sol")
  const usdc = cap("usdc")
  const missingCaps: string[] = []
  if (!hasTxLimit) missingCaps.push("txLimit")
  if (!sol) missingCaps.push("spendLimits.sol")
  if (!usdc) missingCaps.push("spendLimits.usdc")
  return { tradeReady: { sol: hasTxLimit && sol, usdc: hasTxLimit && usdc }, missingCaps }
}

/** The D7 cap lines for the target, printed under the controlled-by block. */
export function targetWarnings(target: ToKeyTarget): string[] {
  return capWarnings(target.keyPrefix, {
    keyPrefix: target.keyPrefix,
    label: target.label,
    paused: target.paused,
    walletScope: target.walletScope,
    tradeReady: target.tradeReady,
    missingCaps: target.missingCaps,
    launchScope: target.launchScope,
  })
}

/**
 * Key signers (spec 2026-09-25-key-signers-design.md, 5.2): the target's ACTIVE signer, read and
 * checked against this machine's pin before the unlock. Present only when the target has one;
 * then the import goes onto that signer's quorum and binds to the target in the same call, and no
 * rebind follows. `crossKey` is whether the target is not the calling key: the import is then the
 * device-token mount, and the calling key is not sent on the submit.
 */
export interface ToKeySigner {
  fingerprint: string
  spkiSha256: string
  signerQuorumId: string
  crossKey: boolean
}

export type ToKeyPreflight =
  | { ok: true; target: ToKeyTarget; deviceToken: string; keySigner?: ToKeySigner }
  | { ok: false; exit: number }

/** The one line each confirmation screen prints about how the wallet reaches the target. */
export function toKeyPlanLine(toKey: { target: ToKeyTarget; keySigner?: ToKeySigner }, n = 1): string {
  const name = toKey.target.label !== null ? `  (${toKey.target.label})` : ""
  const subject = n === 1 ? "This wallet" : `These ${n} wallets`
  return toKey.keySigner !== undefined
    ? `${subject} will be imported onto key ${toKey.target.keyPrefix}${name}'s signer ${toKey.keySigner.fingerprint} and bound to it in the same call.`
    : `${subject} will be bound to key ${toKey.target.keyPrefix}${name} by a rebind after the import.`
}

/** What `runImportFlow` needs for a keySigner import onto the target (5.2), or undefined for today's path. */
export function keySignerImport(
  toKey: { target: ToKeyTarget; deviceToken: string; keySigner?: ToKeySigner } | undefined,
): { spkiSha256: string } | { spkiSha256: string; targetKeyPrefix: string; deviceToken: string } | undefined {
  if (toKey?.keySigner === undefined) return undefined
  return toKey.keySigner.crossKey
    ? {
        spkiSha256: toKey.keySigner.spkiSha256,
        targetKeyPrefix: toKey.target.keyPrefix,
        deviceToken: toKey.deviceToken,
      }
    : { spkiSha256: toKey.keySigner.spkiSha256 }
}

/**
 * The `--json` keys for a wallet a keySigner import already put on the target: no rebind ran,
 * because none was needed. Same top-level keys as `rebindJson`, so a reader keys on `rebind.ok`.
 */
export function keySignerJson(toKey: { target: ToKeyTarget; keySigner: ToKeySigner }, importedTo: string | null) {
  return {
    toKey: {
      keyPrefix: toKey.target.keyPrefix,
      label: toKey.target.label,
      tradeReady: toKey.target.tradeReady,
      missingCaps: toKey.target.missingCaps,
    },
    keySigner: { fingerprint: toKey.keySigner.fingerprint, spkiSha256: toKey.keySigner.spkiSha256 },
    rebind: {
      ok: importedTo === toKey.target.keyPrefix,
      reached: false,
      requests: 0,
      rebound: 0,
      unchanged: 0,
      pending: [] as string[],
      notRebindable: 0,
      finishWith: [] as string[],
      skipped: "keySigner" as const,
    },
  }
}

/** The stderr line after a keySigner import (5.2): where the wallet trades from now. */
export function keySignerTradableLine(toKey: { target: ToKeyTarget; keySigner: ToKeySigner }): string {
  const name = toKey.target.label ?? toKey.target.keyPrefix
  return `Tradable from the machine holding key ${name} (signer ${toKey.keySigner.fingerprint}). This machine stores no signer for it.`
}

/**
 * 5.2: the target's signer, before the unlock. A target with an active signer is checked against
 * the pin (D3: the full hash; the first time, the typed full group string). A target with none
 * keeps today's path. An API that does not serve the read (404, the alpha lag) has no key signers,
 * so it is the same as none. Any other failure refuses: whether the import owns the wallet by a
 * signer on another machine is not something to guess.
 */
async function readTargetSigner(
  ctx: CommandContext,
  deviceToken: string,
  keyPrefix: string,
): Promise<{ ok: true; keySigner?: ToKeySigner } | { ok: false; failure: ToKeyFailure }> {
  const read = await readSigner(ctx, keyPrefix, { deviceToken })
  if (!read.ok) {
    if (read.status === 404) return { ok: true }
    return {
      ok: false,
      failure: {
        code: read.code ?? `HTTP ${read.status}`,
        message: `Could not read key ${keyPrefix}'s signer (${read.status === 0 ? read.message : `HTTP ${read.status}`}). Nothing was written.`,
        suggestion: "Run the same command again.",
      },
    }
  }
  const active = activeSigner(read.body as SignerView)
  if (active === null) return { ok: true }
  const pinned = await confirmSignerPin(ctx, keyPrefix, active)
  if (!pinned.ok) return { ok: false, failure: pinned.failure }
  const apiKey = await resolveApiKey(ctx.deps, ctx.profile)
  const callingPrefix = apiKey !== undefined ? apiKeyPrefix(apiKey) : undefined
  return { ok: true, keySigner: { ...active, crossKey: callingPrefix !== keyPrefix } }
}

/**
 * Phase A of `--to-key`: before the unlock prompt, before any import. Every refusal is written
 * here (the envelope on stdout under `--json`, one line on stderr otherwise) and nothing has been
 * written to the vault or sent to the API that writes.
 *
 * 1. A device token: the rebind is owner-only. With only an API key, `DEVICE_TOKEN_REQUIRED` and
 *    `candle auth login`, the way `tee rebind` refuses.
 * 2. The target resolves, through `tee rebind`'s own `resolveTargetKey` against one `GET /keys`.
 * 3. The target is on this account and can take TEE wallets (`targetKeyRefusal`).
 * 4. A `selected`-scope target has room: its rows plus the wallets this run would move must not
 *    exceed the limit. The limit and the row count are the server's (`scopeLimit`: revoked
 *    wallets' rows included, as `rebindTee` counts them), falling back to `SELECTED_SCOPE_LIMIT`
 *    and the listed count on an older server. Wallets whose label the key already holds are not
 *    counted, so a re-run does not refuse over wallets that moved last time. The set is read with the calling API key
 *    (`GET /keys/:prefix/wallets` admits an agent key on the same account); when that read is
 *    refused, the check is left to the commit, and one stderr line says so.
 */
export async function preflightToKey(
  ctx: CommandContext,
  raw: string,
  opts: { labels: string[] },
): Promise<ToKeyPreflight> {
  const { deps, json } = ctx
  const refuse = (failure: ToKeyFailure): ToKeyPreflight => {
    writeLocalFailure(deps, failure, json)
    return { ok: false, exit: 1 }
  }
  const deviceToken = await resolveDeviceToken(deps, ctx.profile)
  if (!deviceToken) return refuse(DEVICE_TOKEN_REQUIRED)

  const listing = await listAccountKeys(ctx, deviceToken)
  if (!listing.ok) {
    return refuse({
      code: listing.code ?? `HTTP ${listing.status}`,
      message: `Could not read this account's keys to check --to-key (${listing.status === 0 ? listing.message : `HTTP ${listing.status}`}). Nothing was written.`,
      suggestion: "Check the device token with: candle auth status",
    })
  }
  const keys = ((listing.body as { keys?: TargetKeyRow[] } | null)?.keys ?? []) as TargetKeyRow[]
  const resolved = await resolveTargetKey(ctx, deviceToken, raw, { keys })
  if (!resolved.ok) return { ok: false, exit: resolved.code }
  const keyPrefix = resolved.keyPrefix
  const row = keys.find((key) => key.keyPrefix === keyPrefix)
  const refusal = targetKeyRefusal(row, keyPrefix, deps.now())
  if (refusal !== null) return refuse(refusal)
  const target = row as TargetKeyRow

  const walletScope: ToKeyTarget["walletScope"] = target.walletScope === "selected" ? "selected" : "all"
  if (walletScope === "selected") {
    const room = await readSelectedScopeRoom(ctx, keyPrefix)
    if (room.ok) {
      const moving = opts.labels.filter((label) => !room.heldLabels.has(label)).length
      if (moving > 0 && room.held + moving > room.max) {
        return refuse({
          code: "REBIND_SCOPE_FULL",
          message: `Key ${keyPrefix} is scoped to selected wallets and holds ${room.held} of ${room.max}; the ${moving} this run would move do not fit. Nothing was written.`,
          suggestion: "Widen the key's wallet scope from the portal, or name a key with room.",
        })
      }
    } else {
      deps.stderr.write(
        `Could not read key ${keyPrefix}'s wallet set (${room.reason}); its selected-scope room is checked at the rebind.\n`,
      )
    }
  }

  const signer = await readTargetSigner(ctx, deviceToken, keyPrefix)
  if (!signer.ok) return refuse(signer.failure)

  const readiness = tradeReadinessOf(target)
  return {
    ok: true,
    deviceToken,
    ...(signer.keySigner !== undefined ? { keySigner: signer.keySigner } : {}),
    target: {
      keyPrefix,
      label: typeof target.label === "string" && target.label.length > 0 ? target.label : null,
      walletScope,
      paused: target.pausedAt !== undefined && target.pausedAt !== null,
      launchScope: target.scopes.includes("launch:write"),
      ...readiness,
    },
  }
}

async function readSelectedScopeRoom(
  ctx: CommandContext,
  keyPrefix: string,
): Promise<{ ok: true; held: number; max: number; heldLabels: Set<string> } | { ok: false; reason: string }> {
  const apiKey = await resolveApiKey(ctx.deps, ctx.profile)
  if (!apiKey) return { ok: false, reason: "no API key" }
  const result = await apiRequest(`/api/v1/agent/keys/${encodeURIComponent(keyPrefix)}/wallets`, {
    auth: "key",
    credentials: { apiKey },
    apiUrl: ctx.apiUrl,
    fetch: ctx.deps.fetch,
    env: ctx.deps.env,
  })
  if (!result.ok) return { ok: false, reason: result.status === 0 ? result.message : `HTTP ${result.status}` }
  const body = result.body as { wallets?: Array<{ label?: string }>; scopeLimit?: unknown } | null
  const wallets = body?.wallets
  if (!Array.isArray(wallets)) return { ok: false, reason: "no wallet list in the response" }
  const heldLabels = new Set<string>()
  for (const wallet of wallets) if (typeof wallet?.label === "string") heldLabels.add(wallet.label)
  const served = servedScopeLimit(body?.scopeLimit)
  if (served) return { ok: true, held: served.rows, max: served.max, heldLabels }
  return { ok: true, held: wallets.length, max: SELECTED_SCOPE_LIMIT, heldLabels }
}

/** The server's `scopeLimit`, when present and well-formed; null sends the caller to the fallback. */
function servedScopeLimit(raw: unknown): { max: number; rows: number } | null {
  if (typeof raw !== "object" || raw === null) return null
  const { max, rows } = raw as { max?: unknown; rows?: unknown }
  if (typeof max !== "number" || !Number.isInteger(max) || max < 0) return null
  if (typeof rows !== "number" || !Number.isInteger(rows) || rows < 0) return null
  return { max, rows }
}

// ── The rebind ──────────────────────────────────────────────────────────────────────────────

/** A wallet the import left at `verified-active`, with the server id the import returned. */
export interface RebindableWallet {
  id: string
  address: string
  label: string
}

/** A wallet that landed but cannot be rebound yet, with the reason. */
export interface NotRebindable {
  address: string
  label: string
  reason: string
}

export type RebindState = "rebound" | "unchanged" | "failed" | "not-reached"

export interface RebindRun {
  ok: boolean
  /** Previews and commits sent. */
  requests: number
  /** By wallet id. */
  outcomes: Map<string, { state: RebindState; auditId?: string }>
  /** The target as the first preview described it. */
  toKey?: RebindResponse["toKey"]
  failure?: RebindFailureDetails & { chunk: number }
}

/** The ids in chunks of at most `REBIND_CHUNK`, in order. */
export function chunkWallets<T>(wallets: T[], size: number = REBIND_CHUNK): T[][] {
  const out: T[][] = []
  for (let at = 0; at < wallets.length; at += size) out.push(wallets.slice(at, at + size))
  return out
}

/**
 * Moves `wallets` to the target: per chunk, the route's preview (every check the commit makes,
 * nothing written) and then the commit with exactly the preview's ids and bindings (`expect`, the
 * server's compare-and-swap), never the selectors. A chunk the preview reports wholly `unchanged`
 * sends no commit. The first failure stops the run; every wallet after it is `not-reached`.
 *
 * `pinnedSpkiSha256` is the target signer's full hash the preflight confirmed (5.2), if any. A
 * preview that names a signer with another hash, or a signer when the preflight saw none, is
 * confirmed against the pin here (D3) before any owner change is signed; a refusal stops the run.
 */
export async function rebindPromoted(
  ctx: CommandContext,
  deviceToken: string,
  toKeyPrefix: string,
  wallets: RebindableWallet[],
  pinnedSpkiSha256?: string,
): Promise<RebindRun> {
  const run: RebindRun = { ok: true, requests: 0, outcomes: new Map() }
  let pinned: string | null = pinnedSpkiSha256 ?? null
  for (const wallet of wallets) run.outcomes.set(wallet.id, { state: "not-reached" })
  const chunks = chunkWallets(wallets)
  for (const [at, chunk] of chunks.entries()) {
    run.requests += 1
    const preview = await postRebind(ctx, deviceToken, {
      dryRun: true,
      toKeyPrefix,
      wallets: chunk.map((wallet) => wallet.id),
    })
    if (!preview.ok) {
      run.ok = false
      run.failure = { ...rebindFailureDetails(preview, {}), chunk: at + 1 }
      return run
    }
    const shown = preview.body as RebindResponse
    if (run.toKey === undefined) run.toKey = shown.toKey
    for (const row of shown.unchanged) run.outcomes.set(row.id, { state: "unchanged" })
    const moving = shown.rebound
    if (moving.length === 0) continue
    const signer = shown.toKey.signer ?? null
    if (signer !== null && signer.spkiSha256 !== pinned) {
      const confirmed = await confirmSignerPin(ctx, toKeyPrefix, signer, { nothing: REBIND_NOTHING_PINNED })
      if (!confirmed.ok) {
        run.ok = false
        run.failure = { ...confirmed.failure, status: 0, chunk: at + 1 }
        for (const row of moving) run.outcomes.set(row.id, { state: "failed" })
        return run
      }
      pinned = signer.spkiSha256
    }
    run.requests += 1
    // Key signers (5.5): onto a target with a signer, the owner changes the server asks for are
    // signed here by the wallets' current owner (the per-wallet signer this machine promoted with).
    const committed = await commitRebind(
      ctx,
      deviceToken,
      {
        toKeyPrefix,
        walletIds: moving.map((row) => row.id),
        expect: Object.fromEntries(moving.map((row) => [row.id, row.fromKeyPrefix])),
      },
      {
        appId: shown.privyAppId,
        fromKeyPrefixes: Object.fromEntries(moving.map((row) => [row.id, row.fromKeyPrefix])),
        signerSpkiSha256: pinned,
      },
    )
    if (!committed.ok) {
      run.ok = false
      if ("missing" in committed) {
        const failure = missingSignerFailure(committed.missing)
        run.failure = { ...failure, status: 409, chunk: at + 1 }
      } else if ("changed" in committed) {
        run.failure = { ...committed.changed, status: 409, chunk: at + 1 }
      } else {
        run.failure = {
          ...rebindFailureDetails(committed.result, {
            fromKeyPrefixes: Array.from(new Set(moving.map((row) => row.fromKeyPrefix))),
          }),
          chunk: at + 1,
        }
      }
      for (const row of moving) run.outcomes.set(row.id, { state: "failed" })
      return run
    }
    if (committed.signed.length > 0) run.requests += 1
    const result = committed.result.body as RebindResponse
    for (const row of result.rebound) {
      run.outcomes.set(row.id, { state: "rebound", ...(row.auditId !== undefined ? { auditId: row.auditId } : {}) })
    }
    for (const row of result.unchanged) run.outcomes.set(row.id, { state: "unchanged" })
  }
  return run
}

// ── The report ──────────────────────────────────────────────────────────────────────────────

/** The commands that finish the job, at most 200 wallets each, named by address (never ambiguous). */
export function finishingCommands(addresses: string[], toKeyPrefix: string): string[] {
  return chunkWallets(addresses).map((chunk) => `candle tee rebind ${chunk.join(" ")} --to-key ${toKeyPrefix}`)
}

/** The wallets a run left on the calling key: failed, or never reached. */
export function pendingWallets(wallets: RebindableWallet[], run: RebindRun | undefined): RebindableWallet[] {
  return wallets.filter((wallet) => {
    const state = run?.outcomes.get(wallet.id)?.state
    return state !== "rebound" && state !== "unchanged"
  })
}

export interface RebindReportInput {
  target: ToKeyTarget
  /** The key the import bound the wallets to. */
  callingKeyPrefix: string
  wallets: RebindableWallet[]
  /** Absent when the rebind was not reached (the import stopped first). */
  run?: RebindRun
  notRebindable: NotRebindable[]
}

/**
 * The stderr report, both renderings. The partial-failure shape is the load-bearing one: the
 * wallets still on the calling key by label and address, and the exact command that finishes.
 */
export function renderRebindReport(input: RebindReportInput): string {
  const { target, wallets, run, notRebindable } = input
  const lines: string[] = []
  const name = (wallet: { label: string; address: string }) => `${wallet.label} (${wallet.address})`
  if (run !== undefined) {
    const rebound = wallets.filter((wallet) => run.outcomes.get(wallet.id)?.state === "rebound").length
    const unchanged = wallets.filter((wallet) => run.outcomes.get(wallet.id)?.state === "unchanged").length
    if (rebound > 0 || unchanged > 0) {
      lines.push(
        `✓ ${rebound} wallet${rebound === 1 ? "" : "s"} moved to key ${target.keyPrefix}${
          unchanged > 0 ? ` (${unchanged} already there)` : ""
        } in ${run.requests} request${run.requests === 1 ? "" : "s"}.`,
      )
      // Key signers (5.2, 5.5): who owns the moved wallets now, so where they trade from.
      if (rebound > 0) {
        const signer = run.toKey?.signer ?? null
        lines.push(
          signer !== null
            ? `Owned by key ${target.keyPrefix}'s signer ${signer.fingerprint}: they trade from the machine that holds it.`
            : RELAY_SIGNER_LINE,
        )
      }
    }
    if (run.failure !== undefined) {
      lines.push(
        `Rebind ${run.failure.code}: ${run.failure.message}${run.failure.suggestion ? ` ${run.failure.suggestion}` : ""}`,
      )
    }
  }
  const pending = pendingWallets(wallets, run)
  if (pending.length > 0) {
    lines.push(
      `${pending.length} promoted wallet${pending.length === 1 ? " is" : "s are"} still bound to the calling key ${input.callingKeyPrefix}, not ${target.keyPrefix}:`,
      ...pending.map((wallet) => `  ${name(wallet)}`),
      "Finish with:",
      ...finishingCommands(
        pending.map((wallet) => wallet.address),
        target.keyPrefix,
      ).map((command) => `  ${command}`),
    )
  }
  if (notRebindable.length > 0) {
    lines.push(
      `${notRebindable.length} wallet${notRebindable.length === 1 ? "" : "s"} cannot be rebound yet (only a verified-active wallet moves):`,
      ...notRebindable.map((wallet) => `  ${name(wallet)}: ${wallet.reason}`),
    )
  }
  return lines.join("\n")
}

/** One wallet's `rebind` value in the `--json` document. */
export function walletRebindJson(
  wallet: { id: string | null; remoteAuthority: string | null },
  run: RebindRun | undefined,
): { state: RebindState | "not-rebindable"; auditId?: string; reason?: string } {
  if (wallet.id === null || wallet.remoteAuthority !== "verified-active") {
    return {
      state: "not-rebindable",
      reason:
        wallet.id === null
          ? "no linked wallet id"
          : `remote authority is ${wallet.remoteAuthority ?? "unknown"}, not verified-active`,
    }
  }
  const outcome = run?.outcomes.get(wallet.id)
  if (outcome === undefined) return { state: "not-reached" }
  return { state: outcome.state, ...(outcome.auditId !== undefined ? { auditId: outcome.auditId } : {}) }
}

/** The key a wallet is bound to when the command exits: the target when it moved, else what the import said. */
export function finalBoundKey(
  wallet: { id: string | null; importedTo: string | null },
  run: RebindRun | undefined,
  toKeyPrefix: string,
): string | null {
  const state = wallet.id === null ? undefined : run?.outcomes.get(wallet.id)?.state
  return state === "rebound" || state === "unchanged" ? toKeyPrefix : wallet.importedTo
}

/** The document's top-level `toKey` and `rebind` keys. */
export function rebindJson(input: RebindReportInput): {
  toKey: {
    keyPrefix: string
    label: string | null
    tradeReady: { sol: boolean; usdc: boolean }
    missingCaps: string[]
  }
  rebind: {
    ok: boolean
    reached: boolean
    requests: number
    rebound: number
    unchanged: number
    pending: string[]
    notRebindable: number
    code?: string
    message?: string
    suggestion?: string
    finishWith: string[]
  }
} {
  const { target, wallets, run } = input
  const pending = pendingWallets(wallets, run)
  const count = (state: RebindState) => wallets.filter((wallet) => run?.outcomes.get(wallet.id)?.state === state).length
  return {
    toKey: {
      keyPrefix: target.keyPrefix,
      label: target.label,
      tradeReady: run?.toKey?.tradeReady ?? target.tradeReady,
      missingCaps: run?.toKey?.missingCaps ?? target.missingCaps,
    },
    rebind: {
      ok: run !== undefined && run.ok && input.notRebindable.length === 0,
      reached: run !== undefined,
      requests: run?.requests ?? 0,
      rebound: count("rebound"),
      unchanged: count("unchanged"),
      pending: pending.map((wallet) => wallet.address),
      notRebindable: input.notRebindable.length,
      ...(run?.failure !== undefined
        ? {
            code: run.failure.code,
            message: run.failure.message,
            ...(run.failure.suggestion !== undefined ? { suggestion: run.failure.suggestion } : {}),
          }
        : {}),
      finishWith: finishingCommands(
        pending.map((wallet) => wallet.address),
        target.keyPrefix,
      ),
    },
  }
}
