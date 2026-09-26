/**
 * Key signers K3 (spec docs/superpowers/specs/2026-09-25-key-signers-design.md, 5.1, 5.4 and 4.3):
 *
 *   - `candle tee signer new --key <prefix|label> [--out <pem>] [--force]`, on the TRADING machine,
 *     with that key's API key: generate the key's signer here, request it, wait for the owner.
 *   - `candle keys signer approve <code> --key <prefix|label> [--reject]`, the owner's terminal
 *     form of the approval screen, over the device token.
 *   - `candle keys signer move <prefix|label> [--to-key <live>]`, on the machine holding the
 *     SOURCE signer: move every wallet bound to the key onto its active signer, legacy per-wallet
 *     wallets included, or with `--to-key` onto a live key through the rebind.
 *
 * The private half of a signer never leaves the machine it was generated on. What crosses the
 * network is its public half (the request), an owner's typed confirmation (the approval), and an
 * owner-change signature that only the relay forwards.
 */
import { generateKeyPairSync } from "node:crypto"
import { parseArgs } from "../args"
import type { CheckRow } from "../checks"
import { type ApiResult, apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveApiKey, resolveDeviceToken } from "../deps"
import {
  activeSigner,
  allSignerWallets,
  approveSigner,
  confirmSignerPin,
  deleteKeySignerEntry,
  errorDetails,
  fingerprintMatches,
  KEY_PREFIX_RE,
  type KeySignerEntry,
  keySignerFingerprint,
  keySignerRef,
  type LocalSigner,
  localKeySigners,
  localSignerFor,
  readSigner,
  relayOwner,
  requestSigner,
  type SignerAuth,
  type SignerView,
  type SignerWallet,
  saveKeySignerEntry,
  signerSlotProblem,
  signOwnerChange,
  spkiSha256Of,
} from "../key-signers"
import { apiKeyPrefix, printIdentity } from "../profiles"
import { formatTimestamp, writeFailure, writeLocalFailure, writeUsageFailure } from "../render"
import { pemToStoredSigner, storedSignerToPem, walletSignerRef } from "../secret-store"
import { chunkWallets } from "../vault/promote-to-key"
import { labelCell } from "./keys"
import {
  commitRebind,
  DEVICE_TOKEN_REQUIRED,
  missingSignerFailure,
  postRebind,
  REBIND_NOTHING_PINNED,
  type RebindResponse,
  rebindFailureDetails,
  resolveTargetKey,
} from "./tee-rebind"

const USAGE_TEE_SIGNER = "Usage: candle tee signer new --key <prefix|label> [--out <pem>] [--force] [--json]"
const USAGE_KEYS_SIGNER =
  "Usage: candle keys signer approve <code> --key <prefix|label> [--reject] | candle keys signer move <prefix|label> [--to-key <prefix|label>] [--json]"

/** How often `tee signer new` reads the key's signer while it waits for the owner. */
export const SIGNER_POLL_MS = 5_000

/**
 * D2: a device token next to a key signer can approve its own request, which collapses the
 * owner's approval into the bot machine. Printed by `tee signer new` and `keys signer approve`,
 * and reported by `doctor`.
 */
export const DEVICE_TOKEN_BESIDE_SIGNER_LINE =
  "Warning: this machine holds a device token as well as a key signer. A machine with both can approve its own signer request. Do not log the trading machine in: run candle auth logout here, and approve from the owner's machine."

const unsupported = {
  code: "KEY_SIGNER_UNSUPPORTED",
  message: "This Candle API does not serve key signers yet; nothing changed.",
  suggestion: "Try again once the API has been updated.",
}

function name(wallet: SignerWallet): string {
  return wallet.label ? `${labelCell(wallet.label)} (${wallet.id})` : wallet.id
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

// ── candle tee signer new ─────────────────────────────────────────────────────────────────────

export async function teeSigner(args: string[], ctx: CommandContext): Promise<number> {
  const [sub, ...rest] = args
  if (sub === "new") return teeSignerNew(rest, ctx)
  writeUsageFailure(
    ctx.deps,
    sub === undefined ? USAGE_TEE_SIGNER : `Unknown subcommand: ${sub}. ${USAGE_TEE_SIGNER}`,
    ctx.json,
  )
  return 2
}

/** A fresh P-256 pair: the PKCS8 PEM kept here, the base64 SPKI DER sent. */
function generatePair(): { pem: string; publicKeyDer: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  return {
    pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyDer: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  }
}

async function teeSignerNew(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, json } = ctx
  const parsed = parseArgs(args, { valueFlags: ["--key", "--out"], booleanFlags: ["--force"], pathFlags: ["--out"] })
  if ("error" in parsed) {
    writeUsageFailure(deps, `${parsed.error}. ${USAGE_TEE_SIGNER}`, json)
    return 2
  }
  const keyRaw = parsed.values["--key"]
  if (!keyRaw) {
    writeUsageFailure(deps, `--key is required. ${USAGE_TEE_SIGNER}`, json)
    return 2
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}. ${USAGE_TEE_SIGNER}`, json)
    return 2
  }
  const out = parsed.values["--out"]
  const force = parsed.booleans.has("--force")

  await printIdentity(ctx)
  const apiKey = await resolveApiKey(deps, ctx.profile)
  if (!apiKey) {
    writeLocalFailure(
      deps,
      {
        code: "NO_API_KEY",
        message:
          "tee signer new runs on the trading machine, with the API key it trades under; none is configured here.",
        suggestion: "Configure the key (candle auth login, or CANDLE_API_KEY) on the machine that will trade.",
      },
      json,
    )
    return 1
  }
  // D2, before anything is generated or sent.
  if ((await resolveDeviceToken(deps, ctx.profile)) !== undefined)
    deps.stderr.write(`${DEVICE_TOKEN_BESIDE_SIGNER_LINE}\n`)

  // The key this API key is, from the server: `--key` must name it, by prefix or by label.
  const first = await readSigner(ctx, "self", { apiKey })
  if (!first.ok) return writeSignerReadFailure(ctx, first)
  let view = first.body as SignerView
  const keyPrefix = view.keyPrefix
  if (keyRaw !== keyPrefix && keyRaw !== view.keyLabel) {
    writeLocalFailure(
      deps,
      {
        code: "KEY_SIGNER_KEY_MISMATCH",
        message: `This machine's API key is key ${keyPrefix}${view.keyLabel ? ` (${labelCell(view.keyLabel)})` : ""}, not ${keyRaw}. A key's signer is generated on the machine that trades under it.`,
        suggestion: `Run this on the machine holding ${keyRaw}'s API key, or pass --key ${keyPrefix}.`,
      },
      json,
    )
    return 1
  }

  const locals = await localKeySigners(deps, keyPrefix)
  const active = activeSigner(view)
  // A local entry with no quorum is the pending pair (5.1). Resume it; never generate another.
  let entry = locals.filter((e) => e.signerQuorumId === undefined).at(-1)
  if (entry !== undefined && (await deps.store.get(keySignerRef(keyPrefix, entry.spkiSha256))) === null) {
    // Its private half is gone (a wiped store): the entry names nothing it could sign with.
    await deleteKeySignerEntry(deps, entry)
    entry = undefined
  }

  // The lost approval response: the server already shows this pair active. Record and stop.
  if (entry !== undefined && active !== null && active.spkiSha256 === entry.spkiSha256) {
    const recorded: KeySignerEntry = { ...entry, signerQuorumId: active.signerQuorumId }
    await saveKeySignerEntry(deps, recorded)
    await writeOut(ctx, out, recorded)
    return reportApproved(ctx, view, recorded, { resumed: true, requested: false })
  }

  let resumed = entry !== undefined
  if (entry === undefined) {
    // 5.1 / T10: a different signer of this key on this machine that still owns wallets keeps
    // them tradable only while its slot stays; a new signer does not move them. Refuse unless
    // --force, which adds the new slot and leaves the old one exactly where it is.
    const all = allSignerWallets(view)
    const owning = locals
      .filter((e) => e.signerQuorumId !== undefined)
      .map((e) => ({ entry: e, count: all.filter((w) => w.signerQuorumId === e.signerQuorumId).length }))
      .filter((o) => o.count > 0)
    if (owning.length > 0 && !force) {
      const count = owning.reduce((n, o) => n + o.count, 0)
      writeLocalFailure(
        deps,
        {
          code: "KEY_SIGNER_ROTATION_REFUSED",
          message: `This machine's signer ${owning.map((o) => o.entry.fingerprint).join(", ")} for key ${keyPrefix} still owns ${plural(count, "wallet")}. A new signer does not move them. Nothing was generated.`,
          suggestion: `Pass --force to add a new signer and keep the old one here, so those wallets keep trading until candle keys signer move ${keyPrefix} moves them.`,
          details: { keyPrefix, wallets: count },
        },
        json,
      )
      return 1
    }
    const pair = generatePair()
    const spkiSha256 = spkiSha256Of(pair.publicKeyDer)
    const ref = keySignerRef(keyPrefix, spkiSha256)
    // Never write over a slot (5.1). A fresh pair cannot collide; this is the guard, not a path.
    if ((await deps.store.get(ref)) !== null) {
      writeLocalFailure(
        deps,
        { code: "KEY_SIGNER_SLOT_EXISTS", message: `The slot ${ref} is already in use; nothing was written.` },
        json,
      )
      return 1
    }
    await deps.store.set(ref, pemToStoredSigner(pair.pem))
    entry = {
      keyPrefix,
      spkiSha256,
      fingerprint: keySignerFingerprint(spkiSha256),
      publicKeyDer: pair.publicKeyDer,
      createdAt: deps.now(),
    }
    await saveKeySignerEntry(deps, entry)
    resumed = false
  }
  await writeOut(ctx, out, entry)

  const requested = await requestSigner(ctx, apiKey, entry.publicKeyDer)
  if (!requested.ok) {
    if (requested.code === "KEY_SIGNER_ALREADY_ACTIVE") {
      const quorum = (errorDetails(requested).keySigner as { signerQuorumId?: unknown } | undefined)?.signerQuorumId
      if (typeof quorum === "string") {
        const recorded: KeySignerEntry = { ...entry, signerQuorumId: quorum }
        await saveKeySignerEntry(deps, recorded)
        const reread = await readSigner(ctx, "self", { apiKey })
        return reportApproved(ctx, reread.ok ? (reread.body as SignerView) : view, recorded, {
          resumed,
          requested: true,
        })
      }
    }
    writeFailure(deps, requested, { apiUrl: ctx.apiUrl, authType: "key" }, json)
    if (!json)
      deps.stderr.write(
        `The signer ${entry.fingerprint} stays pending on this machine; run the same command again to request a new code.\n`,
      )
    return 1
  }
  const body = requested.body as {
    fingerprint: string
    spkiSha256: string
    userCode: string
    verificationUri: string
    verificationUriComplete: string
    expiresAt: number
  }
  // T1: the fingerprint printed is the one the server hashed from what was sent.
  if (body.spkiSha256 !== entry.spkiSha256) {
    writeLocalFailure(
      deps,
      {
        code: "KEY_SIGNER_CHANGED",
        message: `The server recorded a different public key (${body.fingerprint}) than this machine sent (${entry.fingerprint}). Do not approve it.`,
      },
      json,
    )
    return 1
  }

  deps.stderr.write(
    `${[
      `Key signer for key ${keyPrefix}${view.keyLabel ? ` (${labelCell(view.keyLabel)})` : ""}${resumed ? ", resumed" : ""}`,
      "",
      `    ${entry.fingerprint}`,
      "",
      "The account owner approves it, typing this full fingerprint:",
      `  open ${body.verificationUriComplete}`,
      `  or, on the owner's machine: candle keys signer approve ${body.userCode} --key ${keyPrefix}`,
      `The code expires at ${formatTimestamp(body.expiresAt)}. Waiting for approval...`,
    ].join("\n")}\n`,
  )

  // Like `candle login`: read until the owner approves, the request is superseded or it expires.
  while (deps.now() < body.expiresAt) {
    await deps.sleep(SIGNER_POLL_MS)
    const read = await readSigner(ctx, "self", { apiKey })
    if (!read.ok) continue
    view = read.body as SignerView
    const now = activeSigner(view)
    if (now !== null && now.spkiSha256 === entry.spkiSha256) {
      const recorded: KeySignerEntry = { ...entry, signerQuorumId: now.signerQuorumId }
      await saveKeySignerEntry(deps, recorded)
      return reportApproved(ctx, view, recorded, { resumed, requested: true })
    }
    if (view.pending === null || view.pending.spkiSha256 !== entry.spkiSha256) {
      writeLocalFailure(
        deps,
        {
          code: "KEY_SIGNER_NOT_APPROVED",
          message: `The request for ${entry.fingerprint} was ${view.pending === null ? "rejected or withdrawn" : "superseded by another request for this key"}. The pair stays pending on this machine.`,
          suggestion: `Run candle tee signer new --key ${keyPrefix} again to request a new code for the same signer.`,
          details: { keyPrefix, fingerprint: entry.fingerprint, spkiSha256: entry.spkiSha256, state: "pending" },
        },
        json,
      )
      return 1
    }
  }
  writeLocalFailure(
    deps,
    {
      code: "KEY_SIGNER_NOT_APPROVED",
      message: `The code expired before the owner approved ${entry.fingerprint}. The pair stays pending on this machine.`,
      suggestion: `Run candle tee signer new --key ${keyPrefix} again to request a new code for the same signer.`,
      details: { keyPrefix, fingerprint: entry.fingerprint, spkiSha256: entry.spkiSha256, state: "pending" },
    },
    json,
  )
  return 1
}

/** `--out` (5.1): an opt-in mode-0600 plaintext PEM for an SDK process. The store copy stays. */
async function writeOut(ctx: CommandContext, out: string | undefined, entry: KeySignerEntry): Promise<void> {
  if (out === undefined) return
  const stored = await ctx.deps.store.get(keySignerRef(entry.keyPrefix, entry.spkiSha256))
  if (stored === null) return
  await ctx.deps.writeFile(out, storedSignerToPem(stored))
  ctx.deps.stderr.write(
    `Wrote the signer's private key to ${out} (mode 0600). It is plaintext on disk and weaker than the secret store, which still holds it.\n`,
  )
}

function reportApproved(
  ctx: CommandContext,
  view: SignerView,
  entry: KeySignerEntry,
  how: { resumed: boolean; requested: boolean },
): number {
  const { deps, json } = ctx
  const { onSigner, legacy, moving } = view.wallets
  if (json) {
    deps.stdout.write(
      `${JSON.stringify({
        ok: true,
        command: "tee signer new",
        keyPrefix: entry.keyPrefix,
        state: "active",
        fingerprint: entry.fingerprint,
        spkiSha256: entry.spkiSha256,
        signerQuorumId: entry.signerQuorumId,
        resumed: how.resumed,
        requested: how.requested,
        wallets: {
          onSigner: onSigner.map((w) => w.id),
          legacy: legacy.map((w) => w.id),
          moving: moving.map((w) => w.id),
        },
      })}\n`,
    )
    return 0
  }
  const lines = [
    `Approved: key ${entry.keyPrefix}'s signer is ${entry.fingerprint}, held on this machine.`,
    onSigner.length > 0
      ? `${plural(onSigner.length, "wallet")} on this signer trade${onSigner.length === 1 ? "s" : ""} from this machine now.`
      : "No wallet is on this signer yet. Promote onto it with candle vault promote --to-key on the vault machine.",
  ]
  if (moving.length > 0) {
    lines.push(
      `${plural(moving.length, "wallet")} ${moving.length === 1 ? "is" : "are"} still on a previous signer of this key and keep${moving.length === 1 ? "s" : ""} trading from the machine that holds it until candle keys signer move ${entry.keyPrefix} runs there: ${moving.map(name).join(", ")}`,
    )
  }
  if (legacy.length > 0) {
    lines.push(
      `${plural(legacy.length, "wallet")} keep${legacy.length === 1 ? "s" : ""} a per-wallet signer on the machine that promoted ${legacy.length === 1 ? "it" : "them"} until candle keys signer move ${entry.keyPrefix} runs there: ${legacy.map(name).join(", ")}`,
    )
  }
  deps.stdout.write(`${lines.join("\n")}\n`)
  return 0
}

function writeSignerReadFailure(ctx: CommandContext, result: Extract<ApiResult, { ok: false }>): number {
  // A 404 with no code is the route missing (an API before key signers); a coded 404 is the server's.
  if (result.status === 404 && result.code === undefined) {
    writeLocalFailure(ctx.deps, unsupported, ctx.json)
    return 1
  }
  writeFailure(ctx.deps, result, { apiUrl: ctx.apiUrl, authType: "key" }, ctx.json)
  return 1
}

// ── candle keys signer approve | move ─────────────────────────────────────────────────────────

export async function keysSigner(args: string[], ctx: CommandContext): Promise<number> {
  const [sub, ...rest] = args
  if (sub === "approve") return keysSignerApprove(rest, ctx)
  if (sub === "move") return keysSignerMove(rest, ctx)
  writeUsageFailure(
    ctx.deps,
    sub === undefined ? USAGE_KEYS_SIGNER : `Unknown subcommand: ${sub}. ${USAGE_KEYS_SIGNER}`,
    ctx.json,
  )
  return 2
}

/**
 * 4.3's terminal form: the owner approves (or rejects) a key's pending signer request with the
 * device token. The screen names the key, the full fingerprint and what the approval does to the
 * key's wallets; the approval takes the FULL group string, typed without echo, never one group.
 */
async function keysSignerApprove(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, json } = ctx
  const parsed = parseArgs(args, { valueFlags: ["--key"], booleanFlags: ["--reject"] })
  if ("error" in parsed) {
    writeUsageFailure(deps, `${parsed.error}. ${USAGE_KEYS_SIGNER}`, json)
    return 2
  }
  const [code, extra] = parsed.positionals
  const keyRaw = parsed.values["--key"]
  if (code === undefined || extra !== undefined || !keyRaw) {
    writeUsageFailure(deps, USAGE_KEYS_SIGNER, json)
    return 2
  }
  const reject = parsed.booleans.has("--reject")

  await printIdentity(ctx)
  const deviceToken = await resolveDeviceToken(deps, ctx.profile)
  if (!deviceToken) {
    writeLocalFailure(
      deps,
      {
        ...DEVICE_TOKEN_REQUIRED,
        message: "Approving a key signer needs the device token, the owner's credential; an API key cannot.",
      },
      json,
    )
    return 1
  }
  if (!reject && (!deps.isTTY.stdin || !deps.isTTY.stdout)) {
    writeLocalFailure(
      deps,
      {
        code: "KEY_SIGNER_REQUIRES_TTY",
        message: "candle keys signer approve needs a terminal: the fingerprint is typed, and nothing else supplies it.",
      },
      json,
    )
    return 1
  }
  const target = await resolveTargetKey(ctx, deviceToken, keyRaw, { codePrefix: "KEY_SIGNER" })
  if (!target.ok) return target.code
  const keyPrefix = target.keyPrefix

  const read = await readSigner(ctx, keyPrefix, { deviceToken })
  if (!read.ok) {
    if (read.status === 404 && read.code === undefined) {
      writeLocalFailure(deps, unsupported, json)
      return 1
    }
    writeFailure(deps, read, { apiUrl: ctx.apiUrl, authType: "device" }, json)
    return 1
  }
  const view = read.body as SignerView
  const pending = view.pending
  if (pending === null) {
    writeLocalFailure(
      deps,
      {
        code: "KEY_SIGNER_CODE_INVALID",
        message: `Key ${keyPrefix} has no pending signer request.`,
        suggestion: `Run candle tee signer new --key ${keyPrefix} on the trading machine first.`,
      },
      json,
    )
    return 1
  }
  // D2: approving a request this very machine made is the device token approving its own signer.
  if ((await localKeySigners(deps, keyPrefix)).some((e) => e.spkiSha256 === pending.spkiSha256)) {
    deps.stderr.write(`${DEVICE_TOKEN_BESIDE_SIGNER_LINE}\n`)
  }
  const active = activeSigner(view)
  const all = allSignerWallets(view)
  const onActive = active !== null ? view.wallets.onSigner.length : 0
  deps.stderr.write(
    `${[
      `Signer request for key ${keyPrefix}${view.keyLabel ? `  (${labelCell(view.keyLabel)})` : ""}`,
      "",
      `    ${pending.fingerprint}`,
      "",
      "Requested from a machine using this key. Compare the fingerprint with what that machine printed.",
      `Wallets on this key: ${all.length}.`,
      ...(active !== null && onActive > 0
        ? [
            `${plural(onActive, "wallet")} ${onActive === 1 ? "is" : "are"} owned by signer ${active.fingerprint}. They keep trading from the machine that holds that signer until you move them.`,
          ]
        : []),
      "",
    ].join("\n")}\n`,
  )

  let typed: string | undefined
  if (!reject) {
    typed = await deps.promptSecret("Type the full fingerprint the trading machine printed, all three groups: ")
    if (!fingerprintMatches(typed, pending.fingerprint)) {
      writeLocalFailure(
        deps,
        {
          code: "KEY_SIGNER_FINGERPRINT_MISMATCH",
          message: "That is not the full fingerprint of this request; nothing was approved.",
          suggestion:
            "Type all three groups exactly as the trading machine printed them, for example CNDL-7K2Q-94XM-A1TD.",
        },
        json,
      )
      return 1
    }
  }
  const answered = await approveSigner(ctx, deviceToken, keyPrefix, {
    userCode: code,
    ...(typed !== undefined ? { fingerprint: typed } : {}),
    decision: reject ? "reject" : "approve",
  })
  if (!answered.ok) {
    writeFailure(deps, answered, { apiUrl: ctx.apiUrl, authType: "device" }, json)
    return 1
  }
  if (json) {
    deps.stdout.write(`${JSON.stringify({ ...(answered.body as object), command: "keys signer approve" })}\n`)
    return 0
  }
  if (reject) {
    deps.stdout.write(`Rejected the signer request ${pending.fingerprint} for key ${keyPrefix}.\n`)
    return 0
  }
  const after = answered.body as Partial<SignerView>
  const moving = after.wallets?.moving?.length ?? 0
  deps.stdout.write(
    `Approved: key ${keyPrefix}'s signer is ${pending.fingerprint}.${
      moving > 0
        ? ` ${plural(moving, "wallet")} ${moving === 1 ? "is" : "are"} moving: ${moving === 1 ? "it keeps" : "they keep"} trading from the machine holding the previous signer until candle keys signer move ${keyPrefix} runs there.`
        : ""
    }\n`,
  )
  return 0
}

interface MoveOutcome {
  walletId: string
  label: string | null
  state: "moved" | "already" | "failed" | "not-here"
  code?: string
  message?: string
}

/**
 * 5.4, on the machine holding the SOURCE signer. Without `--to-key`: for every wallet bound to the
 * key whose owner is not its active quorum and whose owner this machine holds, sign the owner
 * change and send it through the owner relay, with the key's own API key or the device token.
 * With `--to-key <live>` (a revoked key has no active quorum): the device token, and the rebind,
 * which changes the owner and the binding together when the live key has a signer, and only the
 * binding when it has none.
 *
 * Resumable: the relay and the rebind GET first, so a wallet whose owner already landed completes
 * with no new signature, and `GET …/signer` reconciles those before listing. A slot is deleted
 * only after a read-back: a key signer's once no wallet on the account is left on its quorum
 * (never the active one), a legacy per-wallet one once its wallet shows the new owner.
 */
async function keysSignerMove(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, json } = ctx
  const parsed = parseArgs(args, { valueFlags: ["--to-key"] })
  if ("error" in parsed) {
    writeUsageFailure(deps, `${parsed.error}. ${USAGE_KEYS_SIGNER}`, json)
    return 2
  }
  const [sourceRaw, extra] = parsed.positionals
  if (sourceRaw === undefined || extra !== undefined) {
    writeUsageFailure(deps, USAGE_KEYS_SIGNER, json)
    return 2
  }
  const toKeyRaw = parsed.values["--to-key"]

  await printIdentity(ctx)
  const apiKey = await resolveApiKey(deps, ctx.profile)
  const deviceToken = await resolveDeviceToken(deps, ctx.profile)
  const ownKeyPrefix = apiKey !== undefined ? apiKeyPrefix(apiKey) : undefined

  // The source key: its own API key reads it as `self`; anything else is the device token's.
  let source: string
  let auth: SignerAuth
  if (apiKey !== undefined && toKeyRaw === undefined && (sourceRaw === ownKeyPrefix || sourceRaw === "self")) {
    source = ownKeyPrefix ?? sourceRaw
    auth = { apiKey }
  } else if (deviceToken !== undefined) {
    const resolved = await resolveTargetKey(ctx, deviceToken, sourceRaw, { codePrefix: "KEY_SIGNER" })
    if (!resolved.ok) return resolved.code
    source = resolved.keyPrefix
    auth = { deviceToken }
  } else if (apiKey !== undefined && toKeyRaw === undefined) {
    // Only an API key: `sourceRaw` may be its label, which the key's own read names.
    const self = await readSigner(ctx, "self", { apiKey })
    if (!self.ok) return writeSignerReadFailure(ctx, self)
    const view = self.body as SignerView
    if (sourceRaw !== view.keyPrefix && sourceRaw !== view.keyLabel) {
      writeLocalFailure(
        deps,
        {
          code: "KEY_SIGNER_KEY_MISMATCH",
          message: `This machine's API key is key ${view.keyPrefix}; moving key ${sourceRaw}'s wallets needs that key's API key or the device token.`,
        },
        json,
      )
      return 1
    }
    source = view.keyPrefix
    auth = { apiKey }
  } else {
    writeLocalFailure(
      deps,
      toKeyRaw !== undefined
        ? DEVICE_TOKEN_REQUIRED
        : {
            code: "NO_CREDENTIAL",
            message: "keys signer move needs the key's API key or the device token; this machine has neither.",
          },
      json,
    )
    return 1
  }
  if (!KEY_PREFIX_RE.test(source)) {
    writeUsageFailure(deps, `Not a key prefix: ${source}. ${USAGE_KEYS_SIGNER}`, json)
    return 2
  }

  if (toKeyRaw !== undefined) {
    if (deviceToken === undefined) {
      writeLocalFailure(deps, DEVICE_TOKEN_REQUIRED, json)
      return 1
    }
    return moveToLiveKey(ctx, deviceToken, source, toKeyRaw)
  }

  const read = await readSigner(ctx, "apiKey" in auth ? "self" : source, auth)
  if (!read.ok) return writeSignerReadFailure(ctx, read)
  const view = read.body as SignerView
  const active = activeSigner(view)
  if (active === null) {
    writeLocalFailure(
      deps,
      {
        code: "KEY_SIGNER_MISSING",
        message: `Key ${source} has no active signer, so there is nothing to move its wallets onto. Nothing changed.`,
        suggestion: `Approve one first (candle tee signer new --key ${source} on the trading machine), or, for a revoked key, move the wallets to a live key: candle keys signer move ${source} --to-key <prefix|label> (device token).`,
      },
      json,
    )
    return 1
  }
  if (!view.privyAppId) {
    writeLocalFailure(deps, unsupported, json)
    return 1
  }

  const outcomes: MoveOutcome[] = []
  const used: LocalSigner[] = []
  for (const wallet of [...view.wallets.legacy, ...view.wallets.moving]) {
    const signer = await localSignerFor(deps, wallet.id, wallet.signerQuorumId)
    if (signer === null) {
      outcomes.push({ walletId: wallet.id, label: wallet.label ?? null, state: "not-here" })
      continue
    }
    const relayed = await relayOwner(
      ctx,
      wallet.id,
      auth,
      signOwnerChange(signer.pem, {
        privyWalletId: wallet.privyWalletId,
        ownerId: active.signerQuorumId,
        appId: view.privyAppId,
      }),
    )
    if (relayed.ok) {
      const forwarded = (relayed.body as { forwarded?: unknown }).forwarded !== false
      outcomes.push({ walletId: wallet.id, label: wallet.label ?? null, state: forwarded ? "moved" : "already" })
      used.push(signer)
      if (!json) deps.stderr.write(`  moved ${name(wallet)}\n`)
    } else {
      outcomes.push({
        walletId: wallet.id,
        label: wallet.label ?? null,
        state: "failed",
        code: relayed.code ?? `HTTP ${relayed.status}`,
        message: relayed.message,
      })
      if (!json) deps.stderr.write(`  failed ${name(wallet)}: ${relayed.code ?? relayed.status} ${relayed.message}\n`)
    }
  }

  const cleanup = await deleteDrainedSlots(ctx, {
    source,
    auth,
    deviceToken,
    apiKey,
    used,
    targetQuorumId: active.signerQuorumId,
  })
  return reportMove(ctx, {
    source,
    target: { keyPrefix: source, fingerprint: active.fingerprint },
    alreadyOn: view.wallets.onSigner.length,
    outcomes,
    cleanup,
  })
}

/** 5.4 with `--to-key`: the rebind route, device token only, chunked like `vault promote --to-key`. */
async function moveToLiveKey(
  ctx: CommandContext,
  deviceToken: string,
  source: string,
  toKeyRaw: string,
): Promise<number> {
  const { deps, json } = ctx
  const target = await resolveTargetKey(ctx, deviceToken, toKeyRaw, { codePrefix: "KEY_SIGNER" })
  if (!target.ok) return target.code
  const read = await readSigner(ctx, source, { deviceToken })
  if (!read.ok) return writeSignerReadFailure(ctx, read)
  const ids = allSignerWallets(read.body as SignerView).map((w) => w.id)
  const outcomes: MoveOutcome[] = []
  let toKey: RebindResponse["toKey"] | undefined
  // D3: the full hash of the target signer the operator confirmed; owner changes sign to nothing else.
  let pinned: string | null = null
  const used: LocalSigner[] = []
  for (const chunk of chunkWallets(ids)) {
    const preview = await postRebind(ctx, deviceToken, { dryRun: true, toKeyPrefix: target.keyPrefix, wallets: chunk })
    if (!preview.ok) {
      const failure = rebindFailureDetails(preview, {})
      writeLocalFailure(deps, failure, json)
      return 1
    }
    const shown = preview.body as RebindResponse
    toKey ??= shown.toKey
    for (const row of shown.unchanged) outcomes.push({ walletId: row.id, label: row.label, state: "already" })
    if (shown.rebound.length === 0) continue
    // The same rebind `tee rebind` makes, so the same pin check before the first owner change (D3).
    const signer = shown.toKey.signer ?? null
    if (signer !== null && signer.spkiSha256 !== pinned) {
      const confirmed = await confirmSignerPin(ctx, target.keyPrefix, signer, { nothing: REBIND_NOTHING_PINNED })
      if (!confirmed.ok) {
        writeLocalFailure(deps, confirmed.failure, json)
        return 1
      }
      pinned = signer.spkiSha256
    }
    // Remember which key signer owns each wallet now, so its slot can be judged afterwards. A
    // legacy slot is the commit's own to delete (commitRebind), once the owner moved.
    for (const change of shown.ownerChange?.wallets ?? []) {
      const signer = await localSignerFor(deps, change.id, change.signerQuorumId)
      if (signer?.kind === "key") used.push(signer)
    }
    const committed = await commitRebind(
      ctx,
      deviceToken,
      {
        toKeyPrefix: target.keyPrefix,
        walletIds: shown.rebound.map((row) => row.id),
        expect: Object.fromEntries(shown.rebound.map((row) => [row.id, row.fromKeyPrefix])),
      },
      {
        appId: shown.privyAppId,
        fromKeyPrefixes: Object.fromEntries(shown.rebound.map((row) => [row.id, row.fromKeyPrefix])),
        signerSpkiSha256: pinned,
      },
    )
    if (!committed.ok) {
      if ("missing" in committed) writeLocalFailure(deps, missingSignerFailure(committed.missing), json)
      else if ("changed" in committed) writeLocalFailure(deps, committed.changed, json)
      else writeLocalFailure(deps, rebindFailureDetails(committed.result, { fromKeyPrefixes: [source] }), json)
      return 1
    }
    for (const row of (committed.result.body as RebindResponse).rebound) {
      outcomes.push({ walletId: row.id, label: row.label, state: "moved" })
      if (!json) deps.stderr.write(`  moved ${row.label ?? row.id} to ${target.keyPrefix}\n`)
    }
  }
  const cleanup = await deleteDrainedSlots(ctx, { source, auth: { deviceToken }, deviceToken, apiKey: undefined, used })
  return reportMove(ctx, {
    source,
    target: { keyPrefix: target.keyPrefix, fingerprint: toKey?.signer?.fingerprint ?? null },
    alreadyOn: 0,
    outcomes,
    cleanup,
  })
}

/**
 * The read-back before any slot is deleted (5.4, T9). Every TEE wallet on the account, with the
 * owner Candle recorded from Privy's read-back: from `GET /wallets` with the API key when it can
 * read the account, else from every key's `GET …/signer` with the device token. `null` when
 * neither can: then nothing is deleted.
 */
async function accountOwners(
  ctx: CommandContext,
  creds: { apiKey?: string; deviceToken?: string },
): Promise<Array<{ id: string; signerQuorumId?: string | null }> | null> {
  if (creds.apiKey !== undefined) {
    const rows: Array<{ _id: string; signerQuorumId?: string }> = []
    let cursor: string | null = null
    let complete = false
    for (let page = 0; page < 1000; page++) {
      const result = await apiRequest(
        `/api/v1/agent/wallets?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        {
          auth: "key",
          credentials: { apiKey: creds.apiKey },
          apiUrl: ctx.apiUrl,
          fetch: ctx.deps.fetch,
          env: ctx.deps.env,
        },
      )
      if (!result.ok) break
      const body = result.body as {
        page?: Array<{ _id: string; signerQuorumId?: string }>
        isDone?: boolean
        continueCursor?: string | null
      }
      rows.push(...(body.page ?? []))
      if (body.isDone === true) {
        complete = true
        break
      }
      cursor = body.continueCursor ?? null
      if (cursor === null) break
    }
    if (complete) return rows.map((row) => ({ id: row._id, signerQuorumId: row.signerQuorumId ?? null }))
  }
  if (creds.deviceToken !== undefined) {
    const keys = await apiRequest("/api/v1/agent/keys", {
      auth: "device",
      credentials: { deviceToken: creds.deviceToken },
      apiUrl: ctx.apiUrl,
      fetch: ctx.deps.fetch,
      env: ctx.deps.env,
    })
    if (!keys.ok) return null
    const out: Array<{ id: string; signerQuorumId?: string | null }> = []
    for (const key of (keys.body as { keys?: Array<{ keyPrefix: string }> } | null)?.keys ?? []) {
      const read = await readSigner(ctx, key.keyPrefix, { deviceToken: creds.deviceToken })
      if (!read.ok) return null
      out.push(...allSignerWallets(read.body as SignerView))
    }
    return out
  }
  return null
}

interface Cleanup {
  deleted: string[]
  kept: Array<{ slot: string; reason: string }>
}

async function deleteDrainedSlots(
  ctx: CommandContext,
  opts: {
    source: string
    auth: SignerAuth
    deviceToken?: string
    apiKey?: string
    /** Signers that moved a wallet in this run. A legacy one is judged by its wallet alone. */
    used: LocalSigner[]
    /** The quorum the wallets moved onto, when there is one. */
    targetQuorumId?: string
  },
): Promise<Cleanup> {
  const { deps } = ctx
  const cleanup: Cleanup = { deleted: [], kept: [] }
  // Key-signer slots to judge: the source key's approved ones, and any used as a signer here.
  const candidates = new Map<string, KeySignerEntry>()
  for (const entry of await localKeySigners(deps, opts.source)) {
    if (entry.signerQuorumId !== undefined) candidates.set(keySignerRef(entry.keyPrefix, entry.spkiSha256), entry)
  }
  for (const signer of opts.used) {
    if (signer.kind === "key")
      candidates.set(keySignerRef(signer.entry.keyPrefix, signer.entry.spkiSha256), signer.entry)
  }
  const legacyUsed = opts.used.filter((s): s is Extract<LocalSigner, { kind: "legacy" }> => s.kind === "legacy")
  if (candidates.size === 0 && legacyUsed.length === 0) return cleanup

  const owners = await accountOwners(ctx, { apiKey: opts.apiKey, deviceToken: opts.deviceToken })
  if (owners === null) {
    const reason = "could not read every wallet's owner back (needs the device token, or a key with account:read)"
    for (const ref of candidates.keys()) cleanup.kept.push({ slot: ref, reason })
    for (const signer of legacyUsed) cleanup.kept.push({ slot: walletSignerRef(signer.walletId), reason })
    return cleanup
  }
  const quorumOf = new Map(owners.map((w) => [w.id, w.signerQuorumId ?? null]))

  for (const [ref, entry] of candidates) {
    // Never the active signer of its key (5.4).
    const read = await readSigner(
      ctx,
      opts.apiKey !== undefined && apiKeyPrefix(opts.apiKey) === entry.keyPrefix ? "self" : entry.keyPrefix,
      opts.apiKey !== undefined && apiKeyPrefix(opts.apiKey) === entry.keyPrefix
        ? { apiKey: opts.apiKey }
        : opts.deviceToken !== undefined
          ? { deviceToken: opts.deviceToken }
          : opts.auth,
    )
    if (!read.ok) {
      cleanup.kept.push({ slot: ref, reason: `could not read key ${entry.keyPrefix}'s signer` })
      continue
    }
    const active = activeSigner(read.body as SignerView)
    if (active !== null && active.spkiSha256 === entry.spkiSha256) continue
    const left = owners.filter((w) => w.signerQuorumId === entry.signerQuorumId).length
    if (left > 0) {
      cleanup.kept.push({ slot: ref, reason: `${plural(left, "wallet")} still on it` })
      continue
    }
    await deleteKeySignerEntry(deps, entry)
    cleanup.deleted.push(ref)
  }
  for (const signer of legacyUsed) {
    // A legacy slot goes only once its wallet's read-back shows the target quorum (5.4).
    if (opts.targetQuorumId === undefined || quorumOf.get(signer.walletId) !== opts.targetQuorumId) {
      cleanup.kept.push({ slot: walletSignerRef(signer.walletId), reason: "the read-back does not show the new owner" })
      continue
    }
    await deps.store.delete(walletSignerRef(signer.walletId))
    cleanup.deleted.push(walletSignerRef(signer.walletId))
  }
  return cleanup
}

function reportMove(
  ctx: CommandContext,
  report: {
    source: string
    target: { keyPrefix: string; fingerprint: string | null }
    alreadyOn: number
    outcomes: MoveOutcome[]
    cleanup: Cleanup
  },
): number {
  const { deps, json } = ctx
  const count = (state: MoveOutcome["state"]) => report.outcomes.filter((o) => o.state === state)
  const failed = count("failed")
  const notHere = count("not-here")
  const exit = failed.length > 0 ? 1 : 0
  if (json) {
    deps.stdout.write(
      `${JSON.stringify({
        ok: exit === 0,
        command: "keys signer move",
        keyPrefix: report.source,
        target: report.target,
        moved: count("moved").map((o) => o.walletId),
        already: count("already").map((o) => o.walletId),
        failed: failed.map(({ walletId, code, message }) => ({ walletId, code, message })),
        notOnThisMachine: notHere.map((o) => o.walletId),
        slots: report.cleanup,
      })}\n`,
    )
    return exit
  }
  const where = report.target.fingerprint
    ? `key ${report.target.keyPrefix}'s signer ${report.target.fingerprint}`
    : `key ${report.target.keyPrefix} (binding only: it has no signer, so the owners stay)`
  const lines = [
    `Moved ${plural(count("moved").length, "wallet")} onto ${where}${count("already").length > 0 ? `; ${count("already").length} already there` : ""}${report.alreadyOn > 0 ? `; ${report.alreadyOn} on it before this run` : ""}.`,
  ]
  if (failed.length > 0) {
    lines.push(`${plural(failed.length, "wallet")} failed; run the same command again:`)
    for (const o of failed) lines.push(`  ${o.label ?? o.walletId}: ${o.code} ${o.message ?? ""}`)
  }
  if (notHere.length > 0) {
    lines.push(
      `${plural(notHere.length, "wallet")} ${notHere.length === 1 ? "is" : "are"} owned by a signer this machine does not hold; run this on the machine that holds it: ${notHere.map((o) => o.label ?? o.walletId).join(", ")}`,
    )
  }
  for (const slot of report.cleanup.deleted) lines.push(`Deleted ${slot}: no wallet is left on it.`)
  for (const kept of report.cleanup.kept) lines.push(`Kept ${kept.slot}: ${kept.reason}.`)
  deps.stdout.write(`${lines.join("\n")}\n`)
  return exit
}

// ── doctor (5.6) ──────────────────────────────────────────────────────────────────────────────

/**
 * `doctor`'s key-signer rows, on a machine that holds a key signer: every `key_signer_*` it
 * indexes and every `wallet_signer_*` the current key's wallets need, each opened and checked
 * (FAIL when it cannot be); the key's active signer when its full hash matches no local slot
 * (WARN: its wallets trade from another machine); and a device token beside a key signer (WARN,
 * D2). The network read is best-effort: a failed read adds no row.
 */
export async function keySignerDoctorRows(
  ctx: CommandContext,
  creds: { apiKey?: string; deviceToken?: string },
): Promise<CheckRow[]> {
  const { deps } = ctx
  const rows: CheckRow[] = []
  const entries = await localKeySigners(deps)
  // Nothing to report on a machine that holds no key signer; and no request for it either.
  if (entries.length === 0) return rows
  let view: SignerView | null = null
  if (creds.apiKey !== undefined) {
    const read = await readSigner(ctx, "self", { apiKey: creds.apiKey }).catch(() => null)
    if (read?.ok) view = read.body as SignerView
  }

  const problems: string[] = []
  for (const entry of entries) {
    const ref = keySignerRef(entry.keyPrefix, entry.spkiSha256)
    let stored: string | null
    try {
      stored = await deps.store.get(ref)
    } catch (error) {
      problems.push(
        `${ref} (${entry.fingerprint}): cannot be opened: ${error instanceof Error ? error.message : String(error)}`,
      )
      continue
    }
    if (stored === null) {
      problems.push(`${ref} (${entry.fingerprint}): missing from the secret store`)
      continue
    }
    const problem = signerSlotProblem(stored, entry.spkiSha256)
    if (problem !== null) problems.push(`${ref} (${entry.fingerprint}): ${problem}`)
  }

  // The legacy per-wallet signers the current key's wallets need: those not on a local key signer.
  if (creds.apiKey !== undefined && view !== null) {
    const quorums = new Set(entries.flatMap((e) => (e.signerQuorumId ? [e.signerQuorumId] : [])))
    for (const wallet of allSignerWallets(view)) {
      if (wallet.signerQuorumId && quorums.has(wallet.signerQuorumId)) continue
      const ref = walletSignerRef(wallet.id)
      let stored: string | null
      try {
        stored = await deps.store.get(ref)
      } catch (error) {
        problems.push(`${ref}: cannot be opened: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      if (stored === null) continue // on another machine, which is not a fault
      const problem = signerSlotProblem(stored)
      if (problem !== null) problems.push(`${ref}: ${problem}`)
    }
  }

  for (const problem of problems) rows.push({ check: "Signer slot", state: "FAIL", detail: problem })
  if (entries.length > 0 && problems.length === 0) {
    rows.push({
      check: "Key signers",
      state: "PASS",
      detail: entries
        .map((e) => `${e.keyPrefix} ${e.fingerprint}${e.signerQuorumId === undefined ? " (pending)" : ""}`)
        .join(", "),
    })
  }
  const active = view !== null ? activeSigner(view) : null
  if (active !== null && !entries.some((e) => e.spkiSha256 === active.spkiSha256)) {
    rows.push({
      check: "Key signer",
      state: "WARN",
      detail: `key ${view?.keyPrefix}'s active signer ${active.fingerprint} is not on this machine; its wallets trade from the machine that holds it`,
    })
  }
  if (creds.deviceToken !== undefined && entries.length > 0) {
    rows.push({ check: "Device token beside signer", state: "WARN", detail: DEVICE_TOKEN_BESIDE_SIGNER_LINE })
  }
  return rows
}
