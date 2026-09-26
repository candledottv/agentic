/**
 * `candle tee rebind` and `candle tee rebinds` (BE-303, spec
 * docs/superpowers/specs/2026-09-23-tee-wallet-rebind-design.md, D7 and D10): move promoted TEE
 * wallets to another API key on this account, and read the account's rebind history.
 *
 * Both take the device token, the owner's CLI credential for key management (`keysAuth` on the
 * API side). Neither opens the vault (D9): a rebind needs no custody, and requiring an unlock
 * would make the operator produce a factor to change a server-side authorization. The server
 * resolves every selector against the caller's own TEE rows, so no API key is needed either.
 *
 * `tee rebind` is preview, screen, `confirm`, commit. The commit sends exactly the ids and
 * bindings the preview showed (`expect`, a compare-and-swap on the server), never the selectors,
 * so a label edited after the preview cannot change what is committed. The typed `confirm` is
 * the same rule as `vault promote` (trimmed, case-insensitive, one attempt); it is not a security
 * boundary, the API is, but it stops a scripted or mistaken run on an owner's machine.
 */
import { parseArgs } from "../args"
import { type ApiResult, apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveDeviceToken } from "../deps"
import {
  activeSigner,
  confirmSignerPin,
  errorDetails,
  localSignerFor,
  type PinFailure,
  readSigner,
  type SignerView,
  signOwnerChange,
} from "../key-signers"
import { apiKeyPrefix, candleEnvironment, effectiveProfileFields, printIdentity } from "../profiles"
import { errorEnvelope, formatTimestamp, renderTable, writeLocalFailure, writeUsageFailure } from "../render"
import { walletSignerRef } from "../secret-store"
import { CONFIRM_WORD, shortAddress } from "../vault/promote-support"
import { type KeyRow, labelCell } from "./keys"
import { refuseEnvPassphrase } from "./tee"

const REBIND_PATH = "/api/v1/agent/tee-wallets/rebind"
const REBINDS_PATH = "/api/v1/agent/tee-wallets/rebinds"
const KEYS_PATH = "/api/v1/agent/keys"

const USAGE_REBIND = "Usage: candle tee rebind <wallet...> --to-key <prefix|label> [--label-prefix <p>] [--json]"
const USAGE_REBINDS = "Usage: candle tee rebinds [wallet] [--json]"

/**
 * The one precondition both commands share: the device token, not an API key. `vault promote
 * --to-key` (BE-322) refuses with the same envelope before its unlock, since its rebind is this one.
 */
export const DEVICE_TOKEN_REQUIRED = {
  code: "DEVICE_TOKEN_REQUIRED",
  message: "Moving a TEE wallet needs the device token, the owner's credential; an API key cannot do it.",
  suggestion: "Run: candle auth login",
}

/** A key's 8-character prefix, as `keys list` prints it and as the server names it. */
const KEY_PREFIX_RE = /^[A-Za-z0-9_-]{8}$/

export interface RebindPreviewRow {
  id: string
  address: string
  label: string | null
  fromKeyPrefix: string
  allowLaunch: boolean
  auditId?: string
}

export interface RebindResponse {
  success: true
  dryRun: boolean
  toKey: {
    keyPrefix: string
    label: string | null
    paused: boolean
    walletScope: "all" | "selected"
    tradeReady: { sol: boolean; usdc: boolean }
    missingCaps: string[]
    launchScope: boolean
    /** Key signers (5.5): the target's active signer, or null. Absent from an older API. */
    signer?: { fingerprint: string; spkiSha256: string } | null
  }
  rebound: RebindPreviewRow[]
  unchanged: Array<{ id: string; address: string; label: string | null }>
  /**
   * Key signers (5.5), when the target has an active signer. The preview names the wallets whose
   * owner changes with the binding, and the owner each holds now; the commit reports which owner
   * changes were forwarded and which Privy already showed.
   */
  ownerChange?: {
    signerQuorumId: string
    wallets?: Array<{ id: string; privyWalletId: string; signerQuorumId: string | null }>
    forwarded?: string[]
    alreadyOwned?: string[]
  } | null
  /** The Privy app id the owner changes sign over, on a preview that names any. */
  privyAppId?: string | null
}

/** The screen's wording for each cap gap, one line per asset that is not ready (D7). */
export function capWarnings(keyPrefix: string, toKey: RebindResponse["toKey"]): string[] {
  const { tradeReady, missingCaps } = toKey
  if (missingCaps.includes("txLimit")) {
    return [
      `Warning: key ${keyPrefix} has no txLimit; it cannot trade SOL-quoted or USDC-quoted swaps until one is set.`,
    ]
  }
  const lines: string[] = []
  if (!tradeReady.sol) {
    lines.push(
      `Warning: key ${keyPrefix} can trade USDC-quoted swaps; it cannot trade SOL-quoted swaps until a SOL cap is set.`,
    )
  }
  if (!tradeReady.usdc) {
    lines.push(
      `Warning: key ${keyPrefix} can trade SOL-quoted swaps; it cannot trade USDC-quoted swaps until a USDC cap is set.`,
    )
  }
  return lines
}

/** The launch warning: the target lacks `launch:write`, and a moved wallet carries `allowLaunch` (D7). */
export function launchWarning(
  keyPrefix: string,
  toKey: RebindResponse["toKey"],
  rows: RebindPreviewRow[],
): string | null {
  if (toKey.launchScope) return null
  const launchers = rows.filter((row) => row.allowLaunch).map((row) => row.label ?? shortAddress(row.address))
  if (launchers.length === 0) return null
  return `Warning: key ${keyPrefix} lacks launch:write; ${launchers.join(", ")} ${launchers.length === 1 ? "has" : "have"} allowLaunch but cannot launch under it.`
}

/** The pin refusal's "what did not happen" sentence for an owner-changing rebind (D3). */
export const REBIND_NOTHING_PINNED = "Nothing was signed, nothing moved and nothing was pinned."

export const RELAY_SIGNER_LINE =
  "The relay signer does not move: trade these wallets from the machine that promoted them."

/**
 * The owner lines for a binding-only rebind (the target has no signer, so no owner changes; spec
 * 5.5 and the BE-419 PASS note). A wallet on a key signer stays owned by it and trades from the
 * machine holding THAT signer, not "the machine that promoted it", so each source key is read and
 * its wallets are named by what owns them. Only legacy per-wallet wallets get RELAY_SIGNER_LINE.
 * A source whose signer cannot be read is described the old way.
 */
export async function ownerLines(
  ctx: CommandContext,
  deviceToken: string,
  rows: Array<{ id: string; address: string; label: string | null; fromKeyPrefix: string }>,
): Promise<string[]> {
  const lines: string[] = []
  let legacy = false
  const byKey = new Map<string, typeof rows>()
  for (const row of rows) byKey.set(row.fromKeyPrefix, [...(byKey.get(row.fromKeyPrefix) ?? []), row])
  for (const [fromKeyPrefix, keyRows] of byKey) {
    const read = await readSigner(ctx, fromKeyPrefix, { deviceToken })
    const view = read.ok ? (read.body as SignerView) : null
    const active = view !== null ? activeSigner(view) : null
    const onSigner = new Set(view?.wallets?.onSigner?.map((w) => w.id) ?? [])
    const moving = new Set(view?.wallets?.moving?.map((w) => w.id) ?? [])
    const name = (row: (typeof rows)[number]) => row.label ?? shortAddress(row.address)
    const onActive = keyRows.filter((row) => onSigner.has(row.id))
    const onPrevious = keyRows.filter((row) => moving.has(row.id))
    if (onActive.length > 0 && active !== null) {
      lines.push(
        `${onActive.map(name).join(", ")} stay${onActive.length === 1 ? "s" : ""} owned by key ${fromKeyPrefix}'s signer ${active.fingerprint}: trade ${onActive.length === 1 ? "it" : "them"} from the machine that holds that signer.`,
      )
    }
    if (onPrevious.length > 0) {
      lines.push(
        `${onPrevious.map(name).join(", ")} stay${onPrevious.length === 1 ? "s" : ""} owned by a previous signer of key ${fromKeyPrefix}: trade ${onPrevious.length === 1 ? "it" : "them"} from the machine that holds that signer.`,
      )
    }
    if (keyRows.length > onActive.length + onPrevious.length) legacy = true
  }
  if (legacy) lines.push(RELAY_SIGNER_LINE)
  return lines
}

/**
 * Where a wallet's current owner is, for a refusal that has to send the operator to that machine
 * (5.5: "names the machine that holds the current owner"). `ownerId` is the owner Privy or the
 * row reports; the source key is read with the device token.
 */
export async function ownerMachine(
  ctx: CommandContext,
  deviceToken: string,
  wallet: { id: string; fromKeyPrefix?: string; ownerId: string | null },
): Promise<string> {
  if (wallet.fromKeyPrefix !== undefined) {
    const read = await readSigner(ctx, wallet.fromKeyPrefix, { deviceToken })
    if (read.ok) {
      const view = read.body as SignerView
      const active = activeSigner(view)
      if (active !== null && wallet.ownerId !== null && active.signerQuorumId === wallet.ownerId) {
        return `the machine that holds key ${wallet.fromKeyPrefix}'s signer ${active.fingerprint}`
      }
      if (view.wallets?.moving?.some((w) => w.id === wallet.id)) {
        return `the machine that holds a previous signer of key ${wallet.fromKeyPrefix}`
      }
    }
  }
  return "the machine that promoted it (its per-wallet signer)"
}

export interface OwnerSigning {
  /** Wallet id to the relay request the commit's `owner` carries. */
  owner: Record<string, { body: { owner_id: string }; authorizationSignature: string }>
  /** Wallet ids signed with a legacy per-wallet signer: their slot is deleted once the owner moved. */
  legacy: string[]
}

/**
 * Signs each owner change a rebind needs with the local signer that owns the wallet now (5.3's
 * rule). `null` in `missing` for every wallet this machine holds no signer for: nothing is sent
 * then, and the caller names where that owner is.
 */
export async function signOwnerChanges(
  ctx: CommandContext,
  wallets: Array<{ walletId: string; privyWalletId: string; ownerId: string | null }>,
  target: { signerQuorumId: string; appId: string },
): Promise<
  { ok: true; signing: OwnerSigning } | { ok: false; missing: Array<{ walletId: string; ownerId: string | null }> }
> {
  const signing: OwnerSigning = { owner: {}, legacy: [] }
  const missing: Array<{ walletId: string; ownerId: string | null }> = []
  for (const wallet of wallets) {
    const signer = await localSignerFor(ctx.deps, wallet.walletId, wallet.ownerId)
    if (signer === null) {
      missing.push({ walletId: wallet.walletId, ownerId: wallet.ownerId })
      continue
    }
    signing.owner[wallet.walletId] = signOwnerChange(signer.pem, {
      privyWalletId: wallet.privyWalletId,
      ownerId: target.signerQuorumId,
      appId: target.appId,
    })
    if (signer.kind === "legacy") signing.legacy.push(wallet.walletId)
  }
  return missing.length > 0 ? { ok: false, missing } : { ok: true, signing }
}

/**
 * The refusal when the signer a commit would sign to is not the one the operator confirmed (D3).
 * The rebind commit carries no server-side pin, so the CLI holds the line: nothing is signed.
 */
export function signerChangedFailure(keyPrefix: string, now: string | undefined): PinFailure {
  return {
    code: "KEY_SIGNER_CHANGED",
    message: `Key ${keyPrefix}'s signer is not the one you confirmed${now !== undefined ? `; the server now names ${now}` : ""}. Nothing was signed and nothing moved.`,
    suggestion:
      "Read the key's full fingerprint on the trading machine, then run the same command again; it asks for the full fingerprint.",
  }
}

/**
 * A rebind commit onto a key that may have an active signer (5.5). The commit goes first with no
 * `owner`: the server GETs each wallet, so one whose owner change already landed (a lost record)
 * completes from the GET with no new signature. When the server answers
 * KEY_SIGNER_SIGNATURE_REQUIRED, it names the wallets that still need one and the owner Privy
 * shows for each; those are signed here and the commit is sent once more with `owner`. After a
 * success, a legacy per-wallet slot used to sign is deleted: the read-back showed the new owner.
 *
 * `signerSpkiSha256` is the full hash of the target signer the operator confirmed against the pin
 * (D3), or null when none was. The owner changes are signed only to a signer with exactly that
 * hash: a different one (approved after the pin) or none confirmed refuses KEY_SIGNER_CHANGED and
 * signs nothing.
 */
export async function commitRebind(
  ctx: CommandContext,
  deviceToken: string,
  body: { toKeyPrefix: string; walletIds: string[]; expect: Record<string, string> },
  opts: {
    appId: string | null | undefined
    fromKeyPrefixes: Record<string, string>
    signerSpkiSha256: string | null
  },
): Promise<
  | { ok: true; result: ApiResult & { ok: true }; signed: string[] }
  | { ok: false; result: Extract<ApiResult, { ok: false }> }
  | { ok: false; missing: Array<{ walletId: string; ownerId: string | null; where: string }> }
  | { ok: false; changed: PinFailure }
> {
  const first = await postRebind(ctx, deviceToken, body)
  if (first.ok) return { ok: true, result: first, signed: [] }
  if (first.code !== "KEY_SIGNER_SIGNATURE_REQUIRED") return { ok: false, result: first }
  const details = errorDetails(first)
  const owners = Array.isArray(details.owners)
    ? (details.owners as Array<{ walletId: string; privyWalletId: string; ownerId: string | null }>)
    : []
  const keySigner = (details.keySigner ?? {}) as {
    signerQuorumId?: unknown
    spkiSha256?: unknown
    fingerprint?: unknown
  }
  const quorum = keySigner.signerQuorumId
  if (opts.signerSpkiSha256 === null || keySigner.spkiSha256 !== opts.signerSpkiSha256) {
    return {
      ok: false,
      changed: signerChangedFailure(
        body.toKeyPrefix,
        typeof keySigner.fingerprint === "string" ? keySigner.fingerprint : undefined,
      ),
    }
  }
  if (owners.length === 0 || typeof quorum !== "string" || !opts.appId) return { ok: false, result: first }
  const signed = await signOwnerChanges(ctx, owners, { signerQuorumId: quorum, appId: opts.appId })
  if (!signed.ok) {
    const missing: Array<{ walletId: string; ownerId: string | null; where: string }> = []
    for (const wallet of signed.missing) {
      missing.push({
        ...wallet,
        where: await ownerMachine(ctx, deviceToken, {
          id: wallet.walletId,
          fromKeyPrefix: opts.fromKeyPrefixes[wallet.walletId],
          ownerId: wallet.ownerId,
        }),
      })
    }
    return { ok: false, missing }
  }
  const second = await postRebind(ctx, deviceToken, { ...body, owner: signed.signing.owner })
  if (!second.ok) return { ok: false, result: second }
  const moved = new Set([
    ...(((second.body as RebindResponse).ownerChange?.forwarded as string[] | undefined) ?? []),
    ...(((second.body as RebindResponse).ownerChange?.alreadyOwned as string[] | undefined) ?? []),
  ])
  for (const walletId of signed.signing.legacy) {
    if (moved.has(walletId)) await ctx.deps.store.delete(walletSignerRef(walletId)).catch(() => {})
  }
  return { ok: true, result: second, signed: Object.keys(signed.signing.owner) }
}

/** The refusal when this machine holds no signer for a wallet whose owner must change (5.5). */
export function missingSignerFailure(missing: Array<{ walletId: string; where: string }>): {
  code: string
  message: string
  suggestion: string
} {
  return {
    code: "KEY_SIGNER_SIGNATURE_REQUIRED",
    message: `The target key has a signer, so the owner of ${missing.length === 1 ? "this wallet" : "these wallets"} must change with the binding, and this machine does not hold the current owner. Nothing changed.\n${missing
      .map((m) => `  ${m.walletId}: on ${m.where}`)
      .join("\n")}`,
    suggestion: "Run the same rebind on the machine named for each wallet, with the device token there.",
  }
}

export interface RebindFailureDetails {
  code: string
  message: string
  suggestion?: string
  status: number
}

/**
 * The server's refusal, with the suggestion the spec gives each code (D7), as facts: `tee rebind`
 * writes them below, and `vault promote --to-key` (BE-322) folds them into its own report, where a
 * second envelope on stdout would break the one-document rule.
 */
export function rebindFailureDetails(
  result: Extract<ApiResult, { ok: false }>,
  context: { fromKeyPrefixes?: string[] },
): RebindFailureDetails {
  let code = result.code
  let message = result.message
  let suggestion: string | undefined
  if (result.status === 404 && result.code !== "REBIND_WALLET_INVALID") {
    code = "REBIND_UNSUPPORTED"
    message = "This Candle API does not support rebinding yet; nothing changed."
  } else if (result.code === "REBIND_BUILD_OPEN") {
    const retryAfter = (result.raw as { error?: { retryAfter?: unknown } } | null)?.error?.retryAfter
    const when = typeof retryAfter === "number" ? new Date(retryAfter).toLocaleString() : "the build window closes"
    const keys = context.fromKeyPrefixes ?? []
    const stop =
      keys.length === 1
        ? `Stop the agent on key ${keys[0]} (candle keys stop ${keys[0]})`
        : keys.length > 1
          ? `Stop the agents on keys ${keys.join(", ")} (candle keys stop <prefix>)`
          : "Stop the agent on the wallet's current key (candle keys stop <prefix>)"
    suggestion = `${stop}, then run this again after ${when}.`
  } else if (result.code === "REBIND_FORWARD_OPEN") {
    message = "A sign for these wallets is still in flight or not yet expired; nothing changed."
  } else if (result.code === "REBIND_RECONCILE_INCOMPLETE") {
    suggestion = "Run the same command again; nothing changed."
  } else if (result.code === "REBIND_STALE") {
    suggestion = "Run the command again; the preview will show the current binding."
  }
  return {
    code: code ?? `HTTP ${result.status}`,
    message,
    ...(suggestion !== undefined ? { suggestion } : {}),
    status: result.status,
  }
}

/**
 * The refusal, written like every other failure: the envelope on stdout under `--json`, one line
 * on stderr otherwise. Exit 1.
 */
function writeRebindFailure(
  ctx: CommandContext,
  result: Extract<ApiResult, { ok: false }>,
  context: { fromKeyPrefixes?: string[] },
): number {
  const { deps, apiUrl, json } = ctx
  const { code, message, suggestion } = rebindFailureDetails(result, context)
  const envelope = errorEnvelope({ ...result, code, message }, { apiUrl, authType: "device" })
  if (json) {
    deps.stdout.write(`${JSON.stringify({ ...envelope, ...(suggestion ? { suggestion } : {}) })}\n`)
  } else {
    deps.stderr.write(`${code}: ${message}${suggestion ? ` ${suggestion}` : ""}\n`)
  }
  return 1
}

/** `GET /keys` with the device token, the read `keys list` makes: every key on this account. */
export async function listAccountKeys(ctx: CommandContext, deviceToken: string): Promise<ApiResult> {
  const { deps, apiUrl } = ctx
  return apiRequest(KEYS_PATH, {
    auth: "device",
    credentials: { deviceToken },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
  })
}

/** One `POST /tee-wallets/rebind` with the device token: a preview (`dryRun: true`) or a commit. */
export async function postRebind(
  ctx: CommandContext,
  deviceToken: string,
  body: Record<string, unknown>,
): Promise<ApiResult> {
  const { deps, apiUrl } = ctx
  return apiRequest(REBIND_PATH, {
    method: "POST",
    body,
    auth: "device",
    credentials: { deviceToken },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
  })
}

/**
 * `--to-key` (and `keys access <key>`, BE-361): an 8-character prefix is used as is. Anything else is matched as an exact label
 * against the non-revoked keys from `GET /keys` (the same device-token read `keys list` makes).
 * No match lists the labelled keys; more than one match is refused with the prefixes listed. The
 * server only ever receives a prefix.
 *
 * `opts.keys` (BE-322) is the listing when the caller has already made that read; `vault promote
 * --to-key` reads it once for the target checks it makes before its unlock, and resolves through
 * here so the two commands cannot drift on what a label means. The refusal is written here in
 * both cases, so the caller returns the exit code and nothing else.
 */
export async function resolveTargetKey(
  ctx: CommandContext,
  deviceToken: string,
  raw: string,
  opts: {
    keys?: KeyRow[]
    /** The refusal codes' prefix: `REBIND` here, `KEY_ACCESS` for `keys access` (BE-361). */
    codePrefix?: string
    /** How a failed `GET /keys` is written; the rebind envelope unless the caller names another. */
    writeListFailure?: (result: Extract<ApiResult, { ok: false }>) => number
  } = {},
): Promise<{ ok: true; keyPrefix: string } | { ok: false; code: number }> {
  const { deps, json } = ctx
  const codePrefix = opts.codePrefix ?? "REBIND"
  if (KEY_PREFIX_RE.test(raw)) return { ok: true, keyPrefix: raw }
  let listed = opts.keys
  if (listed === undefined) {
    const result = await listAccountKeys(ctx, deviceToken)
    if (!result.ok) {
      return {
        ok: false,
        code: opts.writeListFailure ? opts.writeListFailure(result) : writeRebindFailure(ctx, result, {}),
      }
    }
    listed = (result.body as { keys?: KeyRow[] } | null)?.keys ?? []
  }
  const keys = listed.filter((key) => !key.revokedAt)
  const matches = keys.filter((key) => key.label === raw)
  if (matches.length === 1) return { ok: true, keyPrefix: (matches[0] as KeyRow).keyPrefix }
  if (matches.length === 0) {
    const labelled = keys.filter((key) => key.label).map((key) => `${key.keyPrefix} ${labelCell(key.label)}`)
    writeLocalFailure(
      deps,
      {
        code: `${codePrefix}_KEY_NOT_FOUND`,
        message: `No active key on this account is named ${JSON.stringify(raw)}.`,
        suggestion:
          labelled.length > 0
            ? `Named keys on this account:\n${labelled.map((line) => `  ${line}`).join("\n")}`
            : "No key on this account has a name; pass the key's 8-character prefix from: candle keys list",
      },
      json,
    )
    return { ok: false, code: 1 }
  }
  writeLocalFailure(
    deps,
    {
      code: `${codePrefix}_KEY_AMBIGUOUS`,
      message: `${matches.length} active keys are named ${JSON.stringify(raw)}; pass a prefix instead.`,
      suggestion: `Matching prefixes: ${matches.map((key) => key.keyPrefix).join(", ")}`,
    },
    json,
  )
  return { ok: false, code: 1 }
}

export async function teeRebind(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  if (!refuseEnvPassphrase(ctx)) return 1
  const parsed = parseArgs(args, { valueFlags: ["--to-key", "--label-prefix"] })
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  const toKey = parsed.values["--to-key"]
  const labelPrefix = parsed.values["--label-prefix"]
  if (!toKey) {
    writeUsageFailure(deps, `--to-key is required. ${USAGE_REBIND}`, json)
    return 2
  }
  if (parsed.positionals.length === 0 && labelPrefix === undefined) {
    writeUsageFailure(deps, `Name at least one wallet, or pass --label-prefix. ${USAGE_REBIND}`, json)
    return 2
  }

  await printIdentity(ctx)
  const deviceToken = await resolveDeviceToken(deps, ctx.profile)
  if (!deviceToken) {
    writeLocalFailure(deps, DEVICE_TOKEN_REQUIRED, json)
    return 1
  }
  // D7: a TTY, before the preview. No flag and no environment variable supplies `confirm`.
  if (!deps.isTTY.stdin || !deps.isTTY.stdout) {
    writeLocalFailure(
      deps,
      {
        code: "REBIND_REQUIRES_TTY",
        message: "candle tee rebind needs a terminal: the acknowledgement is typed, and nothing else supplies it.",
        suggestion: "Run it in an interactive shell; there is no flag and no environment variable for confirm.",
      },
      json,
    )
    return 1
  }

  const target = await resolveTargetKey(ctx, deviceToken, toKey)
  if (!target.ok) return target.code

  const call = (body: Record<string, unknown>) => postRebind(ctx, deviceToken, body)

  // Preview: every check the commit makes, nothing written.
  const preview = await call({
    dryRun: true,
    toKeyPrefix: target.keyPrefix,
    wallets: parsed.positionals,
    ...(labelPrefix !== undefined ? { labelPrefix } : {}),
  })
  if (!preview.ok) return writeRebindFailure(ctx, preview, {})
  const shown = preview.body as RebindResponse
  const moving = shown.rebound
  if (moving.length === 0) {
    if (json) {
      deps.stdout.write(`${JSON.stringify({ ...shown, command: "tee rebind" })}\n`)
    } else {
      deps.stdout.write(`Nothing to move: every named wallet is already bound to ${shown.toKey.keyPrefix}.\n`)
    }
    return 0
  }

  // Key signers (5.5): onto a key with an active signer the owner changes with the binding, signed
  // here by the owner each wallet has now. Check this machine holds every one of those owners, and
  // the target's signer against the pin (D3), before the screen and before `confirm`. Onto a key
  // with none, the rebind stays binding-only, and each wallet is named by what still owns it.
  const targetSigner = shown.toKey.signer ?? null
  const ownerChanges = shown.ownerChange?.wallets ?? []
  const fromKeyPrefixes = Object.fromEntries(moving.map((row) => [row.id, row.fromKeyPrefix]))
  let ownerSection: string[]
  let pinnedSpkiSha256: string | null = null
  if (targetSigner !== null && shown.ownerChange) {
    const missing: Array<{ walletId: string; where: string }> = []
    for (const change of ownerChanges) {
      if ((await localSignerFor(deps, change.id, change.signerQuorumId)) !== null) continue
      missing.push({
        walletId: change.id,
        where: await ownerMachine(ctx, deviceToken, {
          id: change.id,
          fromKeyPrefix: fromKeyPrefixes[change.id],
          ownerId: change.signerQuorumId,
        }),
      })
    }
    if (missing.length > 0) {
      writeLocalFailure(deps, missingSignerFailure(missing), json)
      return 1
    }
    const pinned = await confirmSignerPin(ctx, shown.toKey.keyPrefix, targetSigner, { nothing: REBIND_NOTHING_PINNED })
    if (!pinned.ok) {
      writeLocalFailure(deps, pinned.failure, json)
      return 1
    }
    pinnedSpkiSha256 = targetSigner.spkiSha256
    ownerSection =
      ownerChanges.length > 0
        ? [
            `The owner of ${ownerChanges.length === 1 ? "this wallet" : `these ${ownerChanges.length} wallets`} moves to key ${shown.toKey.keyPrefix}'s signer ${targetSigner.fingerprint}, signed here by the current owner. Afterwards ${ownerChanges.length === 1 ? "it trades" : "they trade"} from the machine that holds that signer.`,
          ]
        : [
            `Already owned by key ${shown.toKey.keyPrefix}'s signer ${targetSigner.fingerprint}; only the binding moves.`,
          ]
  } else {
    ownerSection = await ownerLines(ctx, deviceToken, moving)
  }

  // The screen, on stderr, so `--json` stdout carries exactly one document (D7).
  const table = renderTable(
    ["line", "label", "address", "from", "allowLaunch"],
    moving.map((row, i) => [
      String(i + 1),
      labelCell(row.label ?? undefined),
      row.address,
      row.fromKeyPrefix,
      row.allowLaunch ? "yes" : "no",
    ]),
  )
  const config = await deps.readConfig()
  const fields = effectiveProfileFields(config, ctx.profile)
  const account = fields.account ? shortAddress(fields.account) : "unknown"
  const accountLine = fields.username ? `${fields.username}  (${account})` : account
  const environment = candleEnvironment(apiUrl) ?? "not a Candle host"
  const keyLabel = shown.toKey.label ? `  ${labelCell(shown.toKey.label)}` : ""
  const n = moving.length
  const screen = [
    table,
    ...(shown.unchanged.length > 0
      ? [
          `${shown.unchanged.length} already bound to this key: ${shown.unchanged
            .map((row) => row.label ?? shortAddress(row.address))
            .join(", ")}`,
        ]
      : []),
    "",
    `${n === 1 ? "This wallet" : `These ${n} wallets`} will move to:`,
    `  API key         ${shown.toKey.keyPrefix}${keyLabel}${shown.toKey.paused ? "  (paused)" : ""}`,
    `  Candle account  ${accountLine}`,
    `  API             ${apiUrl}  (${environment})`,
    "",
    ...capWarnings(shown.toKey.keyPrefix, shown.toKey),
    ...(launchWarning(shown.toKey.keyPrefix, shown.toKey, moving)
      ? [launchWarning(shown.toKey.keyPrefix, shown.toKey, moving) as string]
      : []),
    ...ownerSection,
    "",
  ]
  deps.stderr.write(`${screen.join("\n")}\n`)

  const typed = await deps.promptLine(
    `Type ${CONFIRM_WORD} to move ${n === 1 ? "this wallet" : `these ${n} wallets`}: `,
  )
  if (typed.trim().toLowerCase() !== CONFIRM_WORD) {
    writeLocalFailure(
      deps,
      {
        code: "REBIND_NOT_ACKNOWLEDGED",
        message: `The acknowledgement is the word ${CONFIRM_WORD}; nothing was moved.`,
        suggestion: `Run the command again and type ${CONFIRM_WORD} at the prompt.`,
      },
      json,
    )
    return 1
  }

  // Commit: exactly the preview's ids and bindings, no selectors (D6, L4). Onto a key with a
  // signer, the owner changes the server asks for are signed and sent with it (5.5).
  const committed = await commitRebind(
    ctx,
    deviceToken,
    {
      toKeyPrefix: shown.toKey.keyPrefix,
      walletIds: moving.map((row) => row.id),
      expect: Object.fromEntries(moving.map((row) => [row.id, row.fromKeyPrefix])),
    },
    { appId: shown.privyAppId, fromKeyPrefixes, signerSpkiSha256: pinnedSpkiSha256 },
  )
  if (!committed.ok) {
    if ("missing" in committed) {
      writeLocalFailure(deps, missingSignerFailure(committed.missing), json)
      return 1
    }
    if ("changed" in committed) {
      writeLocalFailure(deps, committed.changed, json)
      return 1
    }
    return writeRebindFailure(ctx, committed.result, {
      fromKeyPrefixes: Array.from(new Set(moving.map((row) => row.fromKeyPrefix))),
    })
  }
  const result = committed.result.body as RebindResponse
  if (json) {
    deps.stdout.write(`${JSON.stringify({ ...result, command: "tee rebind" })}\n`)
    return 0
  }
  const auditIds = result.rebound.map((row) => row.auditId).filter((id): id is string => typeof id === "string")
  const owners = result.ownerChange
  deps.stdout.write(
    `Moved ${result.rebound.length} wallet${result.rebound.length === 1 ? "" : "s"} to ${result.toKey.keyPrefix}.` +
      `${auditIds.length > 0 ? ` Audit ids: ${auditIds.join(", ")}` : ""}\n` +
      (owners && targetSigner !== null
        ? `Owner: key ${result.toKey.keyPrefix}'s signer ${targetSigner.fingerprint} (${owners.forwarded?.length ?? 0} changed, ${owners.alreadyOwned?.length ?? 0} already there).\n`
        : ""),
  )
  return 0
}

interface RebindHistoryRow {
  id: string
  at: number
  linkedWalletId: string
  address: string
  fromKeyPrefix: string
  toKeyPrefix: string
  actor: "session" | "device"
  actorDevicePrefix?: string
  batchId: string
}

export const PORTAL_REVOKE_LINE =
  "A device token cannot revoke devices: revoke a device you do not recognise from the portal, with a signed-in session."

/** `candle tee rebinds [wallet]`: the account's rebind history (D10). Device token; no TTY; no vault. */
export async function teeRebinds(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  if (!refuseEnvPassphrase(ctx)) return 1
  const parsed = parseArgs(args, {})
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  const [walletId, extra] = parsed.positionals
  if (extra !== undefined) {
    writeUsageFailure(deps, `Unexpected argument: ${extra}. ${USAGE_REBINDS}`, json)
    return 2
  }

  await printIdentity(ctx)
  const deviceToken = await resolveDeviceToken(deps, ctx.profile)
  if (!deviceToken) {
    writeLocalFailure(deps, DEVICE_TOKEN_REQUIRED, json)
    return 1
  }
  const query = walletId ? `?walletId=${encodeURIComponent(walletId)}` : ""
  const result = await apiRequest(`${REBINDS_PATH}${query}`, {
    auth: "device",
    credentials: { deviceToken },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
  })
  if (!result.ok) return writeRebindFailure(ctx, result, {})
  const body = result.body as { rebinds?: RebindHistoryRow[] }
  if (json) {
    deps.stdout.write(`${JSON.stringify({ ...(result.body as object), command: "tee rebinds" })}\n`)
    return 0
  }
  const rows = body.rebinds ?? []
  if (rows.length === 0) {
    deps.stdout.write(`No rebinds on this account${walletId ? ` for ${walletId}` : ""}.\n`)
    return 0
  }
  deps.stdout.write(
    `${renderTable(
      ["Time", "Wallet", "From", "To", "Actor", "Device"],
      rows.map((row) => [
        formatTimestamp(row.at),
        row.address,
        row.fromKeyPrefix,
        row.toKeyPrefix,
        row.actor,
        row.actorDevicePrefix ?? "",
      ]),
    )}\n`,
  )
  if (rows.some((row) => row.actor === "device")) deps.stdout.write(`${PORTAL_REVOKE_LINE}\n`)
  return 0
}

/** Exposed for the help drift test: `--to-key` accepts what `apiKeyPrefix` would print, or a label. */
export function isKeyPrefix(value: string): boolean {
  return KEY_PREFIX_RE.test(value) || apiKeyPrefix(value) !== undefined
}
