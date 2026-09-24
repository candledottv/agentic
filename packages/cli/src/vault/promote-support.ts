/**
 * Ember Phase 2 PR C (CC-06, CC-10, AD-8): shared preconditions for both promote modes and
 * `tee enable --vault-key`, plus, since BE-296 (spec `2026-09-23-cli-vault-promote-confirm-design.md`),
 * the one-sentence warning, the `confirm` acknowledgement, the live controlled-by block and the
 * signer-role check's screen handling that `vault promote --in-place` and `vault promote-batch`
 * share. One producer for each, so the two commands cannot drift.
 */
import { apiRequest } from "../client"
import { type KeyRow, labelCell } from "../commands/keys"
import { type CommandContext, resolveApiKey, resolveDeviceToken } from "../deps"
import { apiKeyPrefix, candleEnvironment } from "../profiles"
import type { SolanaRpc } from "../solana-lite"
import { VaultError } from "./errors"
import type { IndexPlaintext, KeyEntry } from "./format"
import {
  checkDoneLine,
  progressLine,
  type RoleProgress,
  readSignerRoles,
  type SentenceForm,
  type SignerRolesResult,
} from "./signer-roles"

/** The recovery destination rule (CC-10), shared by both promote modes and `tee enable --vault-key`. */
export function assertColdVaultDestination(
  index: IndexPlaintext,
  destinationLabelOrAddress: string,
  opts: {
    subjectAddress?: string
    acceptUnknownExposure?: boolean
  } = {},
): KeyEntry {
  // D3 (Phase 4a): a sweep destination is a Solana vault key. An EVM key named here is refused
  // by name rather than reported as "no vault key matches", which would send the operator looking
  // for a typo.
  assertNotEvmEntry(index, destinationLabelOrAddress, "this destination")
  const destination = findVaultRoleEntry(index, destinationLabelOrAddress)
  if (destination === undefined) {
    throw new VaultError("PROMOTE_DESTINATION_NOT_COLD", `No vault key matches ${destinationLabelOrAddress}.`, {
      suggestion:
        "Create a cold vault key with `candle vault new-key --chain solana`, or name an existing one that has never been remotely exposed or exported.",
    })
  }
  if (destination.role !== "vault") {
    throw new VaultError(
      "PROMOTE_DESTINATION_NOT_COLD",
      `${destination.label ?? destination.address} is not a role:vault key.`,
    )
  }
  if (opts.subjectAddress !== undefined && destination.address === opts.subjectAddress) {
    throw new VaultError(
      "PROMOTE_SAME_KEY_DESTINATION",
      "The sweep destination must be a different vault key from the one being promoted.",
    )
  }
  const exposed = destination.exposure?.everRemoteExposed === true
  const exported = destination.exposure?.everExported === true
  const unknown = destination.exposure?.exposureUnknown === true
  if (exposed || exported) {
    throw new VaultError(
      "PROMOTE_DESTINATION_NOT_COLD",
      `${destination.label ?? destination.address} is not cold: everRemoteExposed=${exposed}, everExported=${exported}.`,
      {
        suggestion: "Pin a vault key that has never been remotely exposed or exported (`candle vault new-key`).",
      },
    )
  }
  if (unknown && !opts.acceptUnknownExposure) {
    throw new VaultError(
      "PROMOTE_DESTINATION_NOT_COLD",
      `${destination.label ?? destination.address} carries exposureUnknown and is refused as a recovery destination.`,
      {
        suggestion:
          "Pass --accept-unknown-exposure to admit only this case (never an everRemoteExposed or everExported key), or create a fresh cold key.",
      },
    )
  }
  return destination
}

/**
 * Phase 4a's Solana-only filter (D3). Every command this spec does not extend to EVM selects
 * `chain: "solana"` entries only, and when a label, address or positional NAMES an EVM entry it
 * refuses with `SOLANA_COMMAND_EVM_KEY`, exit 1, before anything is signed, written or broadcast.
 * `vault list`, `export-key`, `verify`, `restore` and `transfer` are the commands that may name one.
 */
export function assertNotEvmEntry(
  index: Pick<IndexPlaintext, "entries">,
  labelOrAddress: string,
  command: string,
): void {
  const named = index.entries.find(
    (entry) =>
      entry.chain === "evm" &&
      (entry.label === labelOrAddress || entry.address.toLowerCase() === labelOrAddress.toLowerCase()),
  )
  if (named === undefined) return
  throw new VaultError(
    "SOLANA_COMMAND_EVM_KEY",
    `${named.label || named.address} is an EVM key (${named.address}); ${command} works on Solana keys only.`,
    {
      suggestion: `Nothing was signed or written. An EVM vault key moves funds with: candle vault transfer <0x address> --from ${named.label || named.address}`,
    },
  )
}

/** A Solana `role: "vault"` entry by label, else any Solana entry by address. An EVM entry never answers (D3). */
export function findVaultRoleEntry(index: IndexPlaintext, labelOrAddress: string): KeyEntry | undefined {
  const solana = index.entries.filter((entry) => entry.chain === "solana")
  const byLabel = solana.find(
    (entry) => entry.role === "vault" && entry.label !== undefined && entry.label === labelOrAddress,
  )
  if (byLabel !== undefined) return byLabel
  return solana.find((entry) => entry.address === labelOrAddress)
}

/**
 * `vault transfer --from`: a vault key by label first (unchanged), then a promoted wallet by label
 * (BE-326, ED-10 amendment), then any entry by address. The signer check decides what may sign.
 */
export function findTransferSource(index: IndexPlaintext, labelOrAddress: string): KeyEntry | undefined {
  const byLabel = (role: KeyEntry["role"]) =>
    index.entries.find((entry) => entry.role === role && entry.label !== undefined && entry.label === labelOrAddress)
  return byLabel("vault") ?? byLabel("tee-wallet") ?? index.entries.find((entry) => entry.address === labelOrAddress)
}

export function findEntryByLabelOrAddress(index: IndexPlaintext, labelOrAddress: string): KeyEntry | undefined {
  const byLabel = index.entries.find((entry) => entry.label !== undefined && entry.label === labelOrAddress)
  if (byLabel !== undefined) return byLabel
  return index.entries.find((entry) => entry.address === labelOrAddress)
}

/** Refuse when any TEE entry already pins this address as its sweep destination. */
export function assertNotPinnedDestination(index: IndexPlaintext, subjectAddress: string): void {
  const pinners = index.entries.filter((entry) => entry.tee?.vaultDestination === subjectAddress)
  if (pinners.length === 0) return
  throw new VaultError(
    "PROMOTE_KEY_IS_PINNED_DESTINATION",
    `${subjectAddress} is the pinned sweep destination for: ${pinners.map((e) => e.label ?? e.address).join(", ")}.`,
    {
      suggestion:
        "Demote those TEE wallets to this key first, then promote fresh ones against a different cold destination.",
    },
  )
}

/** Re-check CC-10 steps 1-3 under the vault lock immediately before the write. */
export function assertInPlacePreconditions(
  index: IndexPlaintext,
  subjectLabel: string,
  sweepToLabel: string,
  opts: { acceptUnknownExposure?: boolean },
): { subject: KeyEntry; destination: KeyEntry; resume: boolean } {
  // D3 (Phase 4a): promotion is Solana-only until 4b. An EVM subject is refused by name.
  assertNotEvmEntry(index, subjectLabel, "vault promote")
  const subject = findEntryByLabelOrAddress(index, subjectLabel)
  if (subject === undefined) {
    throw new VaultError("PROMOTE_NOT_VAULT_KEY", `No entry matches ${subjectLabel}.`)
  }
  if (subject.role === "tee-wallet") {
    const lifecycle = subject.tee?.lifecycle
    if (lifecycle === "local-candidate" || lifecycle === "import-pending") {
      return {
        subject,
        destination: assertColdVaultDestination(index, sweepToLabel, {
          subjectAddress: subject.address,
          acceptUnknownExposure: opts.acceptUnknownExposure,
        }),
        resume: true,
      }
    }
    throw new VaultError(
      "PROMOTE_ALREADY_TEE_WALLET",
      `${subject.label ?? subject.address} is already a TEE wallet (${lifecycle ?? "unknown"}).`,
    )
  }
  if (subject.role !== "vault" || subject.tee !== undefined) {
    throw new VaultError("PROMOTE_NOT_VAULT_KEY", `${subjectLabel} is not a role:vault key without tee metadata.`)
  }
  if (subject.exposure?.exposureUnknown === true) {
    throw new VaultError(
      "PROMOTE_SUBJECT_EXPOSURE_UNKNOWN",
      `${subject.label ?? subject.address} carries exposureUnknown and cannot be promoted in place.`,
    )
  }
  assertNotPinnedDestination(index, subject.address)
  const destination = assertColdVaultDestination(index, sweepToLabel, {
    subjectAddress: subject.address,
    acceptUnknownExposure: opts.acceptUnknownExposure,
  })
  return { subject, destination, resume: false }
}

/**
 * The in-place promotion's entry mutation, extracted from `promoteInPlace` (BE-285, spec
 * 2026-09-22-cli-vault-promote-batch-design.md, D6, §8 step 1) so that the loop that writes it and
 * the batch preflight that PROJECTS it call the same function. If the two ever differed, the
 * preflight would pass while looking correct and the loop would fail at row 91, which is the exact
 * failure the batch exists to prevent. Two callers, one mutation: `promoteInPlace` and
 * `applyPromotion`.
 */
export function promotedEntry(
  entry: KeyEntry,
  destination: KeyEntry,
  label: string | undefined,
  now: string,
  acceptUnknown: boolean,
): KeyEntry {
  return {
    ...entry,
    role: "tee-wallet",
    label: label ?? entry.label,
    exposure: {
      everRemoteExposed: true,
      everExported: entry.exposure?.everExported === true,
      ...(entry.exposure?.exposureUnknown ? { exposureUnknown: true } : {}),
    },
    tee: {
      network: "solana-mainnet",
      lifecycle: "import-pending",
      vaultDestination: destination.address,
      promotedInPlaceAt: now,
      ...(acceptUnknown && destination.exposure?.exposureUnknown ? { destinationExposureAccepted: true } : {}),
    },
  }
}

/**
 * The index as it is after one in-place promotion's pre-import write: the subject's entry replaced
 * by `promotedEntry`, and the subject's vault-branch index recorded in `hd.exposedIndexes.solanaVault`.
 * This is the whole of what `promoteInPlace` commits before the import, so the batch preflight can
 * apply it to a projected index and check the next row against the vault as it WILL be (D6).
 */
export function applyPromotion(
  index: IndexPlaintext,
  subject: KeyEntry,
  destination: KeyEntry,
  opts: { label?: string; now: string; acceptUnknownExposure: boolean },
): IndexPlaintext {
  const entries = index.entries.map((entry) =>
    entry.id === subject.id
      ? promotedEntry(entry, destination, opts.label, opts.now, opts.acceptUnknownExposure)
      : entry,
  )
  // Exposure index: record this vault-branch index as exposed.
  const exposedVault = [...index.hd.exposedIndexes.solanaVault]
  const derivedIndex = subject.derivation?.path.match(/m\/44'\/501'\/(\d+)'\/0'/)
  if (derivedIndex?.[1] !== undefined) {
    const idx = Number(derivedIndex[1])
    if (!exposedVault.includes(idx)) exposedVault.push(idx)
    exposedVault.sort((a, b) => a - b)
  }
  return {
    hd: {
      ...index.hd,
      exposedIndexes: { ...index.hd.exposedIndexes, solanaVault: exposedVault },
    },
    entries,
  }
}

// ── D1: the sentence ────────────────────────────────────────────────────────────────────────

export interface SentenceInput {
  /** The acting count: promote plus resume rows in a batch, 1 in single promote. */
  n: number
  form: SentenceForm
  /** Form F only: distinct acting keys with at least one finding. */
  k?: number
  /** Where the findings are named: `below` (the batch table follows) or `above` (single promote's block precedes). */
  where: "below" | "above"
}

/**
 * The one sentence, first, on stdout (D1). Three forms, chosen by what the role read found: U when
 * not every group was read, N when every group was read for every key and nothing was found, F
 * when anything was found. Each states the two facts the acknowledgement covers: the copy is
 * permanent, and demoting does not remove it. The singular/plural variants are the only
 * substitutions; every detail goes in the table, footer or authorities block, never here.
 */
export function promoteSentence(input: SentenceInput): string {
  const plural = input.n !== 1
  const subject = plural ? `these ${input.n} keys` : "this key"
  const head = `You are about to accept a permanent copy of ${subject} in Privy's TEE: demoting will not remove it,`
  switch (input.form) {
    case "U":
      return `${head} and anything ${plural ? "a key" : "it"} signs for (a multisig, a token mint, a program upgrade authority) is then only as safe as Privy.`
    case "N":
      return `${head} ${plural ? "none of them is" : "it is not"} a token mint, freeze, program upgrade or stake authority, and any multisig ${plural ? "they sign" : "it signs"} for (not checked) is then only as safe as Privy.`
    case "F": {
      const k = input.k ?? 1
      const holder = plural ? `${k} of them ${k === 1 ? "holds" : "hold"}` : "it holds"
      return `${head} and ${holder} a mint, freeze, upgrade or stake authority, named ${input.where}, which is then only as safe as Privy.`
    }
  }
}

/** Every form starts with this; the `--json` tests strip the sentence from stdout by it. */
export const SENTENCE_PREFIX = "You are about to accept "

/** Where the five-sentence warning used to be printed: stdout, one line, a blank line after it. */
export function printPromoteSentence(ctx: CommandContext, sentence: string): void {
  ctx.deps.stdout.write(`\n${sentence}\n\n`)
}

// ── D3: the acknowledgement ─────────────────────────────────────────────────────────────────

export const CONFIRM_WORD = "confirm"

/** The prompt's subject: `this key` or `these n keys`, the same words the sentence and the block use. */
export function subjectPhrase(n: number): string {
  return n === 1 ? "this key" : `these ${n} keys`
}

/**
 * The prompt, both commands: `Type confirm to accept this for {these n keys | this key}: `. Trimmed
 * and case-insensitive; anything else is `PROMOTE_NOT_ACKNOWLEDGED`, exit 1, zero writes, one
 * attempt. The refusal never echoes what was typed.
 */
export function confirmPrompt(n: number): string {
  return `Type ${CONFIRM_WORD} to accept this for ${subjectPhrase(n)}: `
}

export async function confirmPromotion(ctx: CommandContext, n: number): Promise<void> {
  const typed = await ctx.deps.promptLine(confirmPrompt(n))
  if (typed.trim().toLowerCase() !== CONFIRM_WORD) {
    throw new VaultError(
      "PROMOTE_NOT_ACKNOWLEDGED",
      `The acknowledgement is the word ${CONFIRM_WORD}; nothing was promoted, and nothing was written.`,
      { suggestion: `Run the command again and type ${CONFIRM_WORD} at the prompt.` },
    )
  }
}

// ── D4, D5: the controlled-by block ─────────────────────────────────────────────────────────

/** `FfU8M5…8pPD`: the first six, an ellipsis, the last four. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export interface ControlledBy {
  /** The account's address, from the live `GET /wallets/embedded`. */
  account: string
  username: string | null
  /** The first 8 characters of the key's random part, the value `keys list` prints. Never more. */
  keyPrefix: string
  /** The key's label from `GET /keys`, or null whenever D4 prints nothing. */
  keyLabel: string | null
  keySource: "env" | "profile" | "default"
  /** The profile name, for the `profile <name>` clause; absent for `env` and `default`. */
  profileName?: string
  apiUrl: string
  environment: "production" | "staging" | null
  /** Set when the URL came from `--api-url` or `CANDLE_API_URL` rather than the profile. */
  apiUrlFrom?: "--api-url" | "CANDLE_API_URL"
  /**
   * BE-322: the key the wallets end up on when `--to-key` is given, reached by a rebind after the
   * import. The block names THIS key as the controller and the fields above as the key the import
   * runs under. `warnings` are the D7 cap lines for it, printed under the block.
   */
  toKey?: { keyPrefix: string; label: string | null; warnings: string[] }
}

/** BE-322: the same block, naming the `--to-key` target as the controller. */
export function withToKey(
  controlledBy: ControlledBy,
  toKey: { keyPrefix: string; label: string | null; warnings: string[] },
): ControlledBy {
  return { ...controlledBy, toKey }
}

function accountUnresolved(reason: string): VaultError {
  return new VaultError(
    "PROMOTE_ACCOUNT_UNRESOLVED",
    `Could not confirm which Candle account this API key acts for (${reason}); nothing was written.`,
    {
      suggestion:
        "Check the key with: candle doctor. Promotion registers the keys to that account, so it does not proceed on a cached value.",
    },
  )
}

/**
 * D5: one live `GET /api/v1/agent/wallets/embedded` with the key the import will use, the call
 * `doctor` makes. Refuses with `PROMOTE_ACCOUNT_UNRESOLVED` when no key resolves, the key is not
 * in the `cndl_live_` / `cndl_test_` shape, the request fails for any reason, or the body has no
 * string `account`. Never falls back to the cached profile account: the block's only purpose is
 * that it is live.
 *
 * Then D4's label read, which is the opposite in every way: it needs the device token rather
 * than the API key, its failure is silent, and it never refuses. The two are not one request and
 * are not awaited together, so a `GET /keys` failure cannot be mistaken for an account failure.
 */
export async function readControlledBy(ctx: CommandContext): Promise<ControlledBy> {
  const { deps } = ctx
  const apiKey = await resolveApiKey(deps, ctx.profile)
  if (!apiKey) throw accountUnresolved("no API key is available")
  const keyPrefix = apiKeyPrefix(apiKey)
  if (keyPrefix === undefined) throw accountUnresolved("the API key is not in the cndl_live_ or cndl_test_ shape")
  const result = await apiRequest("/api/v1/agent/wallets/embedded", {
    method: "GET",
    auth: "key",
    credentials: { apiKey },
    apiUrl: ctx.apiUrl,
    fetch: deps.fetch,
    env: deps.env,
  })
  if (!result.ok) throw accountUnresolved(result.status === 0 ? result.message : `HTTP ${result.status}`)
  const body = (result.body ?? {}) as Record<string, unknown>
  if (typeof body.account !== "string" || body.account.length === 0) {
    throw accountUnresolved("the response carried no account")
  }
  const username = typeof body.username === "string" && body.username.length > 0 ? body.username : null

  const keySource: ControlledBy["keySource"] = deps.env.CANDLE_API_KEY?.trim()
    ? "env"
    : ctx.profile !== undefined
      ? "profile"
      : "default"
  const apiUrlFrom: ControlledBy["apiUrlFrom"] | undefined =
    ctx.apiUrlFlag !== undefined ? "--api-url" : deps.env.CANDLE_API_URL?.trim() ? "CANDLE_API_URL" : undefined

  return {
    account: body.account,
    username,
    keyPrefix,
    keyLabel: await readKeyLabel(ctx, keyPrefix),
    keySource,
    ...(keySource === "profile" && ctx.profile !== undefined ? { profileName: ctx.profile } : {}),
    apiUrl: ctx.apiUrl,
    environment: candleEnvironment(ctx.apiUrl) ?? null,
    ...(apiUrlFrom !== undefined ? { apiUrlFrom } : {}),
  }
}

/** D4's label: `GET /keys` with the device token, exactly as `keys list` calls it; null on every failure. */
async function readKeyLabel(ctx: CommandContext, keyPrefix: string): Promise<string | null> {
  try {
    const deviceToken = await resolveDeviceToken(ctx.deps, ctx.profile)
    if (!deviceToken) return null
    const result = await apiRequest("/api/v1/agent/keys", {
      method: "GET",
      auth: "device",
      credentials: { deviceToken },
      apiUrl: ctx.apiUrl,
      fetch: ctx.deps.fetch,
      env: ctx.deps.env,
    })
    if (!result.ok) return null
    const keys = (result.body as { keys?: unknown } | null)?.keys
    if (!Array.isArray(keys)) return null
    const row = (keys as Array<Partial<KeyRow>>).find((key) => key?.keyPrefix === keyPrefix)
    return typeof row?.label === "string" && row.label.length > 0 ? row.label : null
  } catch {
    return null
  }
}

/**
 * D4's block, printed on stderr directly above the `confirm` prompt:
 *
 *     These 2 keys will be controlled by:
 *       Candle account  Quant-  (FfU8M5…8pPD)
 *       API key         B6P-TSRs…  (vault-promote)  profile production
 *       API             https://api.alpha.candle.tv  (production)
 */
export function renderControlledBy(controlledBy: ControlledBy, n: number): string {
  const subject = n === 1 ? "This key" : `These ${n} keys`
  const source =
    controlledBy.keySource === "env"
      ? "CANDLE_API_KEY"
      : controlledBy.keySource === "profile"
        ? `profile ${controlledBy.profileName ?? ""}`.trimEnd()
        : "default credentials"
  const cleaned = controlledBy.keyLabel !== null ? labelCell(controlledBy.keyLabel) : ""
  const label = cleaned.length > 0 ? `(${cleaned})  ` : ""
  const environment = controlledBy.environment ?? "not a Candle host"
  const from = controlledBy.apiUrlFrom !== undefined ? `, from ${controlledBy.apiUrlFrom}` : ""
  const { toKey } = controlledBy
  if (toKey === undefined) {
    return [
      `${subject} will be controlled by:`,
      `  Candle account  ${controlledBy.username ?? "(no username)"}  (${shortAddress(controlledBy.account)})`,
      `  API key         ${controlledBy.keyPrefix}…  ${label}${source}`,
      `  API             ${controlledBy.apiUrl}  (${environment}${from})`,
    ].join("\n")
  }
  // BE-322: the target is the controller; the import key is named for what it is, and the D7 cap
  // lines for the target follow the block.
  const toLabel = toKey.label !== null && labelCell(toKey.label).length > 0 ? `(${labelCell(toKey.label)})  ` : ""
  return [
    `${subject} will be controlled by:`,
    `  Candle account  ${controlledBy.username ?? "(no username)"}  (${shortAddress(controlledBy.account)})`,
    `  API key         ${toKey.keyPrefix}…  ${toLabel}--to-key, bound by a rebind after the import`,
    `  imported under  ${controlledBy.keyPrefix}…  ${label}${source}`,
    `  API             ${controlledBy.apiUrl}  (${environment}${from})`,
    ...toKey.warnings,
  ].join("\n")
}

export interface ControlledByJson {
  account: string
  username: string | null
  keyPrefix: string
  keyLabel: string | null
  keySource: "env" | "profile" | "default" | "--to-key"
  apiUrl: string
  environment: "production" | "staging" | null
  /** BE-322, only with `--to-key`: the key the import ran under, which the fields above then do not name. */
  importedUnder?: { keyPrefix: string; keyLabel: string | null; keySource: "env" | "profile" | "default" }
}

/**
 * D9: the `controlledBy` value of both commands' documents. With `--to-key` (BE-322) the key named
 * is the target, the one that controls the wallets when the command is done, `keySource` is
 * `--to-key`, and `importedUnder` carries the import key; without it, unchanged.
 */
export function controlledByJson(controlledBy: ControlledBy): ControlledByJson {
  const importedUnder = {
    keyPrefix: controlledBy.keyPrefix,
    keyLabel: controlledBy.keyLabel,
    keySource: controlledBy.keySource,
  }
  if (controlledBy.toKey === undefined) {
    return {
      account: controlledBy.account,
      username: controlledBy.username,
      ...importedUnder,
      apiUrl: controlledBy.apiUrl,
      environment: controlledBy.environment,
    }
  }
  return {
    account: controlledBy.account,
    username: controlledBy.username,
    keyPrefix: controlledBy.toKey.keyPrefix,
    keyLabel: controlledBy.toKey.label,
    keySource: "--to-key",
    apiUrl: controlledBy.apiUrl,
    environment: controlledBy.environment,
    importedUnder,
  }
}

// ── D7: the role read with its progress line ────────────────────────────────────────────────

/**
 * Runs `readSignerRoles` for the acting addresses with the D7 defaults (8 in flight, 2 s backoff,
 * 5 retries, 20 s timeout), drawing the progress line on stderr in place with `\r`, updated on
 * every completed request and at least once a second, and replacing it with the permanent `✓`
 * line when the read finishes. Under `--json` the same lines go to stderr; stdout is untouched.
 * Never throws for an RPC reason.
 */
export async function runRoleCheck(
  ctx: CommandContext,
  rpc: Pick<SolanaRpc, "getProgramAccounts"> & Partial<Pick<SolanaRpc, "getProgramAccountsV2">>,
  addresses: string[],
): Promise<SignerRolesResult> {
  const { deps } = ctx
  const startedAt = deps.now()
  let latest: RoleProgress | undefined
  let drawn = ""
  const draw = () => {
    if (latest === undefined) return
    // The snapshot was taken when a call settled. Recompute elapsed on every draw, including
    // the one-second ticker, so a slow in-flight request does not freeze `elapsed` and `left`.
    const line = progressLine({ ...latest, elapsedMs: deps.now() - startedAt })
    const pad = drawn.length > line.length ? " ".repeat(drawn.length - line.length) : ""
    deps.stderr.write(`\r${line}${pad}`)
    drawn = line
  }
  const ticker = setInterval(draw, 1000)
  ticker.unref?.()
  let result: SignerRolesResult
  try {
    result = await readSignerRoles(rpc, addresses, {
      now: deps.now,
      sleep: deps.sleep,
      onProgress: (progress) => {
        latest = progress
        draw()
      },
    })
  } finally {
    clearInterval(ticker)
  }
  const clear = drawn.length > 0 ? `\r${" ".repeat(drawn.length)}\r` : ""
  deps.stderr.write(`${clear}${checkDoneLine(addresses.length, result)}\n`)
  return result
}
