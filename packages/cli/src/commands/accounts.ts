/**
 * `candle accounts create` (spec docs/superpowers/specs/2026-10-28-cli-account-create-design.md,
 * sections 5 to 7.2): a staging test member, created from this laptop with no browser.
 *
 *   candle accounts create --env staging --name <fleet-name>
 *       [--key-item <item>] [--signer-item <item>] [--username <handle>] [--scopes <a,b,c>]
 *       [--profile <name>] [--use] [--yes] [--json]
 *
 * The identity key `K` comes from the macOS login keychain item `candle-fleet-<env>-<name>-sol` and
 * signs a `Candle x402 create_account <K>` proof. The key signer `S` is never read: its public half
 * comes from the owner's sealed-signer receipt, and its keychain item is checked for existence only.
 * The API key the server returns once goes to the hash-pinned reviewed sibling on its stdin, which
 * seals it into `candle-fleet-<env>-<name>-apikey`; the profile keeps the item's name, never the key.
 *
 * Refusals before the nonce exit 2 and send nothing but `GET /terms`. An API refusal exits 1. A
 * pending fulfilment (202) and a failed local store exit 3. Production is refused in v1 (7.3), and in
 * v1 the command needs a terminal unless `activation.json` carries the D10 approval.
 *
 * Every byte written goes through a redactor holding `K` and the API key, so neither can reach
 * stdout or stderr on any path.
 */

import { ed25519 } from "@noble/curves/ed25519"
import { base58 } from "@scure/base"
import { parseArgs, parseScopesList } from "../args"
import { type ApiResult, apiRequest, isLoopbackHost } from "../client"
import type { CommandContext, Deps, Writer } from "../deps"
import {
  FLEET_ACCOUNT_SCRIPT,
  type FleetEnv,
  fleetItem,
  liveAccountsHost,
  parseSiblingPin,
  parseSignerReceipt,
  type RunnerLock,
  sha256Hex,
  unattendedApproved,
} from "../fleet-accounts"
import { writeFields, writeSuccess } from "../human-output"
import { SecretStoreLockedError } from "../keychain"
import { notice } from "../presentation"
import { isValidProfileName } from "../profiles"
import { terminalText, writeLocalFailure, writeUsageFailure } from "../render"
import { encodePubkey, pubkeyFromSecret, signMessage } from "../solana-lite"
import { wipe } from "../vault/hygiene"
import { SIGN_IN_WITH_X_HEADER } from "../x402/codec"
import { createAccountProofHeader, type SpendChallenge } from "../x402/siwx"

export const STAGING_ACCOUNTS_API_URL = "https://staging.api.candle.tv"
/** 7.2: the only hosts this command talks to. Loopback is `--env local` only. */
export const ACCOUNTS_ALLOWED_HOST = "staging.api.candle.tv"
/**
 * The chain id a `create_account` proof names: the server's `ACCOUNTS_SIWX_CHAIN_ID` (Solana mainnet,
 * `apps/api/src/services/test-fleet/config.ts`), which a proof naming any other chain fails. Copied
 * because the CLI has no cross-package import; `scripts/test-fleet-cli.test.ts` pins the two together.
 */
export const ACCOUNTS_SIWX_CHAIN_ID = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
/** Fleet R6.3. */
export const FLEET_NAME = /^[a-z][a-z0-9-]{1,23}$/
/** `validateUsername`'s rule (`packages/db/convex/users.ts`): 3 to 30 of `[A-Za-z0-9_-]`. */
const USERNAME = /^[A-Za-z0-9_-]{3,30}$/
const USERNAME_MAX = 30
const ITEM = /^[A-Za-z0-9._-]{1,128}$/
export const CANDLE_TERMS_URL = "https://docs.candle.tv/terms"
const SIWX_TTL_MS = 300_000
/** Back-dating `issuedAt` from the server's own nonce expiry, so a clock gap never makes it "in the future". */
const ISSUED_AT_SLACK_MS = 5_000
/** 8: a nonce that expired or was replayed is fetched again once, and then the command stops. */
const NONCE_RETRY_REASONS = new Set([
  "invalid_siwx_nonce",
  "invalid_siwx_expired",
  "invalid_siwx_issued_at_too_old",
  "invalid_siwx_issued_at_in_future",
])
const REDACTED = "[redacted]"

const USAGE =
  "Usage: candle accounts create --env staging|local --name <fleet-name> [--key-item <item>] [--signer-item <item>] [--username <handle>] [--scopes <a,b,c>] [--profile <name>] [--use] [--yes] [--json]"

/** A writer that replaces every registered secret before anything reaches the stream (I2). */
function redacting(writer: Writer, secrets: Set<string>): Writer {
  return {
    write(chunk: string) {
      let text = chunk
      for (const secret of secrets) if (secret.length >= 8) text = text.split(secret).join(REDACTED)
      writer.write(text)
    },
  }
}

/** The identity item's secret: base58 of the 64-byte Solana secret or the 32-byte seed, or a keygen JSON array. */
export function parseIdentitySecret(raw: string): Uint8Array | null {
  const text = raw.trim()
  let bytes: Uint8Array | null = null
  if (text.startsWith("[")) {
    try {
      const array = JSON.parse(text) as unknown
      if (Array.isArray(array) && array.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
        bytes = Uint8Array.from(array as number[])
      }
    } catch {
      bytes = null
    }
  } else {
    try {
      bytes = base58.decode(text)
    } catch {
      bytes = null
    }
  }
  if (bytes === null) return null
  if (bytes.length === 32) {
    const secret = new Uint8Array(64)
    secret.set(bytes, 0)
    secret.set(ed25519.getPublicKey(bytes), 32)
    wipe(bytes)
    return secret
  }
  if (bytes.length !== 64) {
    wipe(bytes)
    return null
  }
  try {
    pubkeyFromSecret(bytes)
  } catch {
    wipe(bytes)
    return null
  }
  return bytes
}

interface Created {
  account: string
  memberId?: string
  memberIdPrefix?: string
  wallets?: { solana?: string; evm?: string }
  keyPrefix?: string
  apiKey: string | null
  scopes?: string[]
  plan?: string
  createdVia?: string
  requestId?: string
}

type Attempt =
  | { kind: "created"; body: Created; status: number }
  | { kind: "pending"; requestId?: string; step?: string }
  | { kind: "refused"; result: Extract<ApiResult, { ok: false }> }

/** Quote a single POSIX-shell argument for the recovery command (the owner runs macOS). */
function shellArgument(value: string): string {
  return /^[A-Za-z0-9_./:@,=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`
}

function errorField(result: Extract<ApiResult, { ok: false }>, field: string): unknown {
  const raw = result.raw as { error?: Record<string, unknown> } | undefined
  return raw?.error?.[field]
}

export async function accountsCreate(args: string[], ctx: CommandContext): Promise<number> {
  const secrets = new Set<string>()
  const deps: Deps = {
    ...ctx.deps,
    stdout: redacting(ctx.deps.stdout, secrets),
    stderr: redacting(ctx.deps.stderr, secrets),
  }
  const json = ctx.json
  const host = ctx.deps.accountsHost ?? liveAccountsHost()
  const refuse = (code: string, message: string, suggestion?: string, exit = 2, details?: Record<string, unknown>) => {
    writeLocalFailure(
      deps,
      { code, message, ...(suggestion ? { suggestion } : {}), ...(details ? { details } : {}) },
      json,
    )
    return exit
  }

  const parsed = parseArgs(args, {
    valueFlags: ["--env", "--name", "--key-item", "--signer-item", "--username", "--scopes"],
    booleanFlags: ["--yes", "--use"],
  })
  if ("error" in parsed || parsed.positionals.length !== 0) {
    writeUsageFailure(deps, "error" in parsed ? `${parsed.error}\n${USAGE}` : USAGE, json)
    return 2
  }
  const envFlag = parsed.values["--env"]
  const nameFlag = parsed.values["--name"]
  if (envFlag === undefined || nameFlag === undefined) {
    writeUsageFailure(deps, USAGE, json)
    return 2
  }
  const name: string = nameFlag
  const use = parsed.booleans.has("--use")
  // 7.2: production is v2 and no flag opens it.
  if (envFlag === "production") {
    return refuse(
      "ACCOUNTS_PRODUCTION_OUT_OF_SCOPE",
      "Production test accounts are not part of v1. Nothing was read or sent.",
      "Production account creation is a separate v2 card with its own owner go (spec 7.3).",
    )
  }
  if (envFlag !== "staging" && envFlag !== "local") {
    writeUsageFailure(deps, `--env must be staging or local, not ${terminalText(envFlag)}.\n${USAGE}`, json)
    return 2
  }
  const env: FleetEnv = envFlag
  if (ctx.deps.platform !== "darwin") {
    return refuse(
      "ACCOUNTS_KEY_STORE_NOT_KEYCHAIN",
      "Fleet keys live only in the macOS login keychain, and this machine is not macOS. Nothing was read or sent.",
    )
  }
  if (!FLEET_NAME.test(name)) {
    return refuse(
      "ACCOUNTS_NAME_INVALID",
      `--name must match ^[a-z][a-z0-9-]{1,23}$ (fleet R6.3), not ${terminalText(name)}.`,
    )
  }
  // The server's default is the same string; checked here, before any read or request, because the
  // default is over 30 characters for a long fleet name and the server would refuse it at the proof.
  const usernameFlag = parsed.values["--username"]
  const username = usernameFlag ?? `fleet-${env}-${name}`
  if (!USERNAME.test(username)) {
    return refuse(
      "ACCOUNTS_USERNAME_INVALID",
      usernameFlag === undefined
        ? `The default username ${username} is ${username.length} characters, and a Candle username is 3 to ${USERNAME_MAX}. Nothing was read or sent.`
        : `--username must be 3 to ${USERNAME_MAX} of A-Z, a-z, 0-9, _ and -. Nothing was read or sent.`,
      usernameFlag === undefined ? "Choose a shorter one with --username <handle>." : undefined,
    )
  }
  const keyItem = parsed.values["--key-item"] ?? fleetItem(env, name, "sol")
  const signerItem = parsed.values["--signer-item"] ?? fleetItem(env, name, "signer")
  const apiKeyItem = fleetItem(env, name, "apikey")
  for (const [flag, item] of [
    ["--key-item", keyItem],
    ["--signer-item", signerItem],
  ] as const) {
    if (!ITEM.test(item)) {
      writeUsageFailure(deps, `${flag} must be a keychain item name of A-Z, a-z, 0-9, ., _ and -.`, json)
      return 2
    }
  }
  const scopesFlag = parsed.values["--scopes"]
  const scopes = scopesFlag === undefined ? undefined : parseScopesList(scopesFlag)
  if (scopes !== undefined && scopes.length === 0) {
    writeUsageFailure(deps, "--scopes must name at least one scope.", json)
    return 2
  }

  // 7.2: the host is fixed by --env. CANDLE_API_URL and --api-url are ignored for staging.
  let apiUrl = STAGING_ACCOUNTS_API_URL
  if (env === "staging") {
    if (ctx.apiUrlFlag !== undefined || deps.env.CANDLE_API_URL?.trim()) {
      notice(
        deps,
        "stderr",
        "note",
        `accounts create ignores --api-url and CANDLE_API_URL; --env staging is ${apiUrl}.`,
      )
    }
  } else {
    const local = deps.env.CANDLE_API_URL?.trim()
    let localHost: string | null = null
    try {
      localHost = local ? new URL(local).hostname : null
    } catch {
      localHost = null
    }
    if (!local || localHost === null || !isLoopbackHost(localHost)) {
      return refuse(
        "ACCOUNTS_HOST_NOT_ALLOWED",
        `--env local talks only to a loopback API named by CANDLE_API_URL, and ${
          localHost ? `${terminalText(localHost)} is not loopback` : "CANDLE_API_URL names none"
        }. Nothing was read or sent.`,
      )
    }
    apiUrl = local.replace(/\/+$/, "")
  }
  const apiHost = new URL(apiUrl).host
  const apiHostname = new URL(apiUrl).hostname
  if (apiHostname !== ACCOUNTS_ALLOWED_HOST && !(env === "local" && isLoopbackHost(apiHostname))) {
    return refuse("ACCOUNTS_HOST_NOT_ALLOWED", `${terminalText(apiHost)} is not an allowed host for accounts create.`)
  }

  const yes = parsed.booleans.has("--yes")
  if (json && !yes) {
    writeUsageFailure(deps, "--json needs --yes: a machine caller must state that it accepts the terms.", json)
    return 2
  }
  // Presence only: the value is never read (the vault rule, `refuseEnvPassphrase`).
  if (!(deps.env.CANDLE_KEYSTORE_PASSPHRASE === undefined)) {
    return refuse(
      "ENV_PASSPHRASE_REFUSED",
      "CANDLE_KEYSTORE_PASSPHRASE is set. No Candle command reads its value. Nothing was read or sent.",
      "Unset it and run again.",
    )
  }
  const profile = ctx.profileFlag ?? `${env}-${name}`
  if (!isValidProfileName(profile)) {
    writeUsageFailure(deps, `--profile ${terminalText(profile)} is not a valid profile name.`, json)
    return 2
  }
  const existing = (await deps.readConfig()).profiles?.[profile]
  if (existing !== undefined && !yes) {
    return refuse(
      "ACCOUNTS_PROFILE_EXISTS",
      `A profile named ${profile} already exists. Nothing was read or sent.`,
      "Pass --yes to update it, or --profile <name> for another.",
    )
  }
  // D10: v1 is run by the owner at a terminal. Unattended needs the owner's pinned approval.
  if (!(deps.isTTY.stdin && deps.isTTY.stdout)) {
    if (!unattendedApproved(await host.readFile(`${host.opsDir}/activation.json`))) {
      return refuse(
        "ACCOUNTS_ATTENDED_REQUIRED",
        "accounts create runs at a terminal in v1: the owner runs it in their own Terminal (decision D10). Nothing was read or sent.",
      )
    }
  }

  // Step 0 (fleet R9.3): the runner lock, before any keychain read, held through the sibling.
  const taken = await host.acquireLock(`${host.opsDir}/runner.lock`)
  if (!taken.ok) {
    if (taken.reason === "held") {
      return refuse(
        "ACCOUNTS_RUNNER_LOCKED",
        "Another fleet run holds the runner lock. Nothing was read or sent.",
        "Wait for it to finish, then run again.",
      )
    }
    return refuse(
      "ACCOUNTS_RUNNER_LOCK_FAILED",
      `The fleet runner lock could not be taken${taken.detail ? ` (${terminalText(taken.detail)})` : ""}. Nothing was read or sent.`,
    )
  }
  const lock: RunnerLock = taken.lock
  let secret: Uint8Array | null = null
  try {
    return await createLocked()
  } catch (error) {
    if (error instanceof SecretStoreLockedError) return refuse("SECRET_STORE_FAILED", error.message)
    throw error
  } finally {
    wipe(secret)
    await lock.release()
  }

  async function createLocked(): Promise<number> {
    // Step 1, the rest of the guards. None of these reads a secret.
    if (await host.itemExists(apiKeyItem)) {
      return refuse(
        "ACCOUNTS_APIKEY_ITEM_EXISTS",
        `The keychain item ${apiKeyItem} exists: this account is already stored. Nothing was sent.`,
        "Replacing a stored key is an owner action outside this command; --yes does not override it.",
      )
    }
    const pin = parseSiblingPin(
      await host.readFile(`${host.opsDir}/accounts-apikey-sibling.json`),
      host.ownerScriptsDir,
    )
    if (!pin.ok)
      return refuse("ACCOUNTS_SIBLING_UNPINNED", `The API-key sibling is not pinned: ${pin.reason}. Nothing was sent.`)
    const sibling = await host.readFile(pin.value.path)
    if (sibling === null || sha256Hex(sibling) !== pin.value.sha256) {
      return refuse(
        "ACCOUNTS_SIBLING_UNPINNED",
        `The API-key sibling ${terminalText(pin.value.path)} ${sibling === null ? "is missing" : "does not match its pinned sha256"}. Nothing was sent.`,
      )
    }
    const receipt = parseSignerReceipt(await host.readFile(`${host.opsDir}/signer-receipts/${env}-${name}.json`), {
      env,
      name,
      item: signerItem,
    })
    const notSealed = (reason: string) =>
      refuse(
        "ACCOUNTS_SIGNER_NOT_SEALED",
        `The key signer is not sealed: ${reason}. Nothing was sent, and this command never makes a signer.`,
        "The owner's reviewed signer script seals it to both YubiKeys and writes the receipt.",
      )
    if (!receipt.ok) return notSealed(receipt.reason)
    if (!(await host.itemExists(signerItem))) return notSealed(`the keychain item ${signerItem} does not exist`)

    // Step 2: terms.
    const terms = await apiRequest("/api/v1/agent/accounts/terms", {
      apiUrl,
      auth: "none",
      credentials: {},
      env: deps.env,
      fetch: deps.fetch,
    })
    if (!terms.ok) return apiRefusal(terms)
    const termsVersion = (terms.body as { version?: unknown } | null)?.version
    if (typeof termsVersion !== "string" || !/^[0-9A-Za-z._-]{1,64}$/.test(termsVersion)) {
      return refuse(
        "ACCOUNTS_UNREADABLE_ANSWER",
        "The API's terms answer was unreadable. Nothing was created.",
        undefined,
        1,
      )
    }
    writeFields(
      deps,
      json ? "stderr" : "stdout",
      [
        ["Terms version", termsVersion],
        ["Terms", CANDLE_TERMS_URL],
        ["Account", `${username} on ${apiHost}`],
      ],
      "Candle terms",
    )
    if (!yes) {
      const answer = await deps.promptLine(`Type accept to accept Candle's terms ${termsVersion} for ${username}: `)
      if (answer.trim().toLowerCase() !== "accept") {
        return refuse("TERMS_NOT_ACCEPTED", "Not accepted; nothing was created.", undefined, 1)
      }
    }

    // Step 3: K, from the keychain into memory. Never printed.
    const raw = await host.readItem(keyItem)
    if (raw === null) {
      return refuse(
        "ACCOUNTS_KEY_ITEM_MISSING",
        `The keychain item ${keyItem} (account candle) does not exist. Nothing was sent.`,
        `The owner script ${FLEET_ACCOUNT_SCRIPT} makes it; this command never takes a key any other way.`,
      )
    }
    secrets.add(raw)
    secrets.add(raw.trim())
    secret = parseIdentitySecret(raw)
    if (secret === null) {
      return refuse(
        "ACCOUNTS_KEY_ITEM_INVALID",
        `The keychain item ${keyItem} does not hold a Solana secret this command can read. Nothing was sent.`,
      )
    }
    secrets.add(base58.encode(secret))
    secrets.add(base58.encode(secret.slice(0, 32)))
    const identity = secret
    const account = encodePubkey(pubkeyFromSecret(identity))

    // Steps 5 and 6: nonce, proof, create. A nonce refusal is retried once with a fresh nonce.
    let outcome = await attempt(account, identity, termsVersion, receipt.value.spkiDerBase64)
    if (
      outcome.kind === "refused" &&
      outcome.result.code === "SIWX_INVALID" &&
      NONCE_RETRY_REASONS.has(String(errorField(outcome.result, "reason")))
    ) {
      outcome = await attempt(account, identity, termsVersion, receipt.value.spkiDerBase64)
    }
    if (outcome.kind === "refused") return apiRefusal(outcome.result)
    if (outcome.kind === "pending") {
      const replay = [
        "candle",
        "accounts",
        "create",
        "--env",
        env,
        "--name",
        name,
        "--key-item",
        keyItem,
        "--signer-item",
        signerItem,
        "--profile",
        profile,
        ...(usernameFlag !== undefined ? ["--username", username] : []),
        ...(scopes !== undefined ? ["--scopes", scopes.join(",")] : []),
        ...(use ? ["--use"] : []),
        ...(yes ? ["--yes"] : []),
        ...(json ? ["--json"] : []),
      ]
        .map(shellArgument)
        .join(" ")
      // local's destination comes from the environment, so make it part of the exact replay too.
      const rerun = env === "local" ? `CANDLE_API_URL=${shellArgument(apiUrl)} ${replay}` : replay
      return refuse(
        "ACCOUNTS_FULFILMENT_PENDING",
        `The account is not finished yet${outcome.step ? ` (step ${outcome.step})` : ""}. Nothing was stored on this machine.`,
        `Run again with the same signer: ${rerun}`,
        3,
        { requestId: outcome.requestId ?? null, step: outcome.step ?? null, rerun },
      )
    }
    const created = outcome.body
    if (created.apiKey === null) {
      return refuse(
        "ACCOUNTS_KEY_NOT_RETURNED",
        `The account ${created.account} exists, and the key issued for it has already been used, so the API did not return it again. Nothing was stored.`,
        "A used key is not replaced here: reissue it with a reissue_key proof from K through POST /api/v1/agent/x402/keys.",
        1,
        { account: created.account, keyPrefix: created.keyPrefix ?? null, requestId: created.requestId ?? null },
      )
    }
    secrets.add(created.apiKey)
    return store(created, termsVersion, pin.value)
  }

  async function attempt(
    account: string,
    identity: Uint8Array,
    termsVersion: string,
    signerPublicKey: string,
  ): Promise<Attempt> {
    const nonce = await apiRequest("/api/v1/agent/accounts/nonce", {
      method: "POST",
      apiUrl,
      auth: "none",
      credentials: {},
      env: deps.env,
      fetch: deps.fetch,
    })
    if (!nonce.ok) return { kind: "refused", result: nonce }
    const { nonce: value, expiresAt } = (nonce.body ?? {}) as { nonce?: unknown; expiresAt?: unknown }
    const expiry = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN
    if (typeof value !== "string" || !/^[0-9a-f]{32}$/.test(value) || !Number.isFinite(expiry)) {
      return {
        kind: "refused",
        result: {
          ok: false,
          status: 0,
          code: "ACCOUNTS_UNREADABLE_ANSWER",
          message: "The API's nonce answer was unreadable.",
          raw: undefined,
        },
      }
    }
    // Dated from the server's own expiry, never this machine's clock.
    const issuedAt = expiry - SIWX_TTL_MS - ISSUED_AT_SLACK_MS
    const challenge: SpendChallenge = {
      domain: apiHost,
      uri: `${apiUrl}/api/v1/agent/accounts`,
      version: "1",
      nonce: value,
      issuedAt: new Date(issuedAt).toISOString(),
      expirationTime: new Date(issuedAt + SIWX_TTL_MS).toISOString(),
      chainId: ACCOUNTS_SIWX_CHAIN_ID,
    }
    const header = createAccountProofHeader(challenge, account, (message) => signMessage(message, identity))
    const result = await apiRequest("/api/v1/agent/accounts", {
      method: "POST",
      apiUrl,
      auth: "none",
      credentials: {},
      env: deps.env,
      fetch: deps.fetch,
      headers: { [SIGN_IN_WITH_X_HEADER]: header },
      body: {
        name,
        ...(usernameFlag !== undefined ? { username } : {}),
        termsVersion,
        signerPublicKey,
        ...(scopes !== undefined ? { scopes } : {}),
      },
    })
    if (!result.ok) return { kind: "refused", result }
    const body = (result.body ?? {}) as Record<string, unknown>
    if (result.status === 202) {
      return {
        kind: "pending",
        ...(typeof body.requestId === "string" ? { requestId: body.requestId } : {}),
        ...(typeof body.step === "string" ? { step: body.step } : {}),
      }
    }
    if (typeof body.account !== "string" || (body.apiKey !== null && typeof body.apiKey !== "string")) {
      return {
        kind: "refused",
        result: {
          ok: false,
          status: result.status,
          code: "ACCOUNTS_UNREADABLE_ANSWER",
          message: "The API's answer was unreadable.",
          raw: undefined,
        },
      }
    }
    if (typeof body.apiKey === "string") secrets.add(body.apiKey)
    return { kind: "created", body: body as unknown as Created, status: result.status }
  }

  /** Step 6 on a 201: the pinned sibling seals the key; then the profile records public fields only. */
  async function store(created: Created, termsVersion: string, pin: { path: string; sha256: string }): Promise<number> {
    const plaintext = new TextEncoder().encode(created.apiKey as string)
    const storeFailed = (reason: string) =>
      refuse(
        "ACCOUNTS_APIKEY_STORE_FAILED",
        `The account ${created.account} exists, but API-key storage could not be confirmed: ${reason}. The key was not printed. The keychain item or sealed copy may already exist.`,
        `Have the owner check ${apiKeyItem} and its sealed copy before retrying. Do not rerun while either exists. Resume only after the owner confirms neither was stored, or revoke the key as the owner.`,
        3,
        { account: created.account, keyPrefix: created.keyPrefix ?? null, requestId: created.requestId ?? null },
      )
    try {
      // Hashed again right before it runs: the pin is checked against the bytes about to execute.
      const bytes = await host.readFile(pin.path)
      if (bytes === null || sha256Hex(bytes) !== pin.sha256) return storeFailed("the sibling no longer matches its pin")
      const ran = await host.runSibling(pin.path, [env, name], plaintext)
      if (!ran.ok) {
        return storeFailed(
          `the sibling exited ${ran.exitCode ?? "without a status"}${ran.detail ? ` (${terminalText(ran.detail)})` : ""}`,
        )
      }
      if (!(await host.itemExists(apiKeyItem)))
        return storeFailed(`the sibling finished but ${apiKeyItem} does not exist`)
    } catch (error) {
      // The account already exists. A thrown child/read/verification error is a local store
      // failure, even when security reports a locked keychain after the sibling succeeded.
      return storeFailed(terminalText(error instanceof Error ? error.message : String(error)))
    } finally {
      wipe(plaintext)
    }

    const view = {
      env,
      name,
      account: created.account,
      username,
      memberIdPrefix: created.memberIdPrefix ?? created.memberId?.slice(0, 8) ?? null,
      wallets: { solana: created.wallets?.solana ?? null, evm: created.wallets?.evm ?? null },
      keyPrefix: created.keyPrefix ?? null,
      scopes: created.scopes ?? [],
      plan: created.plan ?? "free",
      createdVia: created.createdVia ?? "test-fleet",
      termsVersion,
      requestId: created.requestId ?? null,
      profile,
      apiKeyItem,
      signerItem,
      credentialAccess: "fleet-runner-only",
    }
    try {
      await deps.updateProfile(profile, {
        apiUrl,
        account: created.account,
        username,
        ...(created.keyPrefix ? { keyPrefix: created.keyPrefix } : {}),
        scopes: view.scopes,
        label: `test fleet ${env}-${name}`,
        apiKeyItem,
      })
      if (use) await deps.writeConfig({ activeProfile: profile })
    } catch (error) {
      return refuse(
        "ACCOUNTS_APIKEY_STORE_FAILED",
        `The API key is stored in ${apiKeyItem}, but the profile ${profile} was not written: ${terminalText(
          error instanceof Error ? error.message : String(error),
        )}.`,
        undefined,
        3,
        { account: created.account, apiKeyItem },
      )
    }

    if (json) {
      deps.stdout.write(`${JSON.stringify({ ok: true, ...view })}\n`)
      return 0
    }
    const label = env === "staging" ? "staging" : "local"
    writeSuccess(deps, "stdout", `Created ${label} test member ${username}`)
    writeFields(deps, "stdout", [
      ["Account", created.account],
      ["Member id", view.memberIdPrefix ? `${view.memberIdPrefix}…` : undefined],
      ["Solana TEE", view.wallets.solana],
      ["Hood TEE", view.wallets.evm],
      ["Key", view.keyPrefix ? `${view.keyPrefix}…  scopes: ${view.scopes.join(", ")}` : undefined],
      ["Key item", apiKeyItem],
      ["Profile", `${profile}  (public fleet record; credentials require the reviewed fleet runner)`],
    ])
    notice(
      deps,
      "stdout",
      "note",
      "Ordinary CLI authentication with this profile is refused (ACCOUNTS_FLEET_RUNNER_REQUIRED); general profile use needs a separate custody decision.",
    )
    notice(deps, "stdout", "note", `Tag: test-fleet (excluded from KPI). Plan: Free. Terms: ${termsVersion} accepted.`)
    notice(
      deps,
      "stdout",
      "warning",
      `Signer item ${signerItem} was sealed before this run. Losing that item and its sealed copy loses the TEE wallets.`,
    )
    return 0
  }

  function apiRefusal(result: Extract<ApiResult, { ok: false }>): number {
    const code = result.code ?? (result.status === 404 ? "ACCOUNTS_ROUTES_OFF" : `HTTP_${result.status}`)
    const data = errorField(result, "data") as Record<string, unknown> | undefined
    const reason = errorField(result, "reason")
    let message = result.message
    let suggestion: string | undefined
    if (result.status === 404 && result.code === undefined) {
      message = `The account routes are off on ${apiHost} (TEST_FLEET_SIGNUP is not on). Nothing was created.`
    } else if (code === "USERNAME_TAKEN" || code === "USERNAME_INVALID") {
      suggestion = "Choose another with --username <handle>."
    } else if (code === "ACCOUNT_EXISTS") {
      message = `This wallet is already a Candle member${
        typeof data?.createdVia === "string" ? ` (created via ${data.createdVia})` : ""
      }. Nothing was created.`
    } else if (code === "SIGNER_MISMATCH" || code === "INPUT_MISMATCH") {
      suggestion = "Resume with the original signer and inputs. This command never makes a new signer."
    } else if (code === "TERMS_VERSION_STALE") {
      message = `The terms changed to ${typeof data?.current === "string" ? data.current : "a new version"} while this ran. Nothing was created.`
      suggestion = "Run again to read and accept the new version."
    } else if (code === "SIWX_INVALID" && typeof reason === "string") {
      message = `${message} (${terminalText(reason)})`
    }
    writeLocalFailure(
      deps,
      { code, message, ...(suggestion ? { suggestion } : {}), ...(data ? { details: data } : {}) },
      json,
    )
    return 1
  }
}
