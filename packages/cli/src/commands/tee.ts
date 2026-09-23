/**
 * `candle tee …`: Ember Phase 1 (BE-94), the dedicated delegated TEE wallet.
 * Spec: docs/superpowers/specs/2026-09-16-ember-phase-1-delegated-tee-wallets.md (Draft 2).
 *
 * Six commands, one lifecycle:
 *
 *   new      seal a fresh Solana key into tee-wallets.enc (HW-01); no network
 *   enable   import it for THIS profile's agent with the sweep vault pinned (HW-02, HW-03)
 *   fund     print the funding instruction the VAULT signs; the CLI signs nothing (HW-04)
 *   status   the server's derived lifecycle state, plus balances when an RPC is given
 *   disable  stop the agent: typed state, exit 3 when remote enforcement is unconfirmed (HW-06)
 *   sweep    sign LOCALLY with the TEE wallet key and move everything to the vault (HW-07)
 *
 * Every command refuses to run while CANDLE_KEYSTORE_PASSPHRASE is set (D3): the TEE wallet store's
 * passphrase is typed, never read from the environment, and its value is never looked at. The TEE
 * wallet store is a separate file with a `purpose` marker; the legacy `wallets` commands refuse it and
 * these commands refuse anything else. The API never sees the TEE wallet private key or the passphrase.
 */
import { base58 } from "@scure/base"
import { isUsageError, type ParsedArgs, parseArgs } from "../args"
import { apiRequest } from "../client"
import type { CommandContext, Deps } from "../deps"
import { resolveApiKey } from "../deps"
import { printIdentity } from "../profiles"
import { writeFailure, writeLocalFailure, writeUsageFailure } from "../render"
import {
  type AccountMeta,
  associatedTokenAddress,
  compileLegacyMessage,
  createAssociatedTokenAccountIdempotent,
  createSolanaRpc,
  decodePubkey,
  encodePubkey,
  type Instruction,
  pubkeyFromSecret,
  type SolanaRpc,
  serializeSignedTransaction,
  signMessage,
  systemTransfer,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  toBase64,
  tokenCloseAccount,
  tokenTransferChecked,
} from "../solana-lite"
import { classifyStatus, resolvePending } from "../sweep-pending"
import {
  classifyTokenSendFailure,
  type MintProfile,
  readMintProfile,
  resolveTransferHookAccounts,
  transferFeeFor,
} from "../token-2022"
import type { KeyEntry } from "../vault/format"
import { CONFIG_DIR_ENV } from "../vault/store"
import {
  commitVaultTeeEntry,
  maybeReconcileVaultTee,
  type ResolvedTee,
  refuseLegacyWriteForVaultAddress,
  releaseResolvedTee,
  resolveTeeAddress,
  type TeeAccess,
} from "../vault/tee-resolve"
import { runImportFlow, TEE_PROFILE } from "../wallet-import-flow"
import { generateWallet } from "../wallet-keygen"
import {
  createKeystore,
  defaultTeeKeystorePath,
  type KeystoreEntry,
  KeystoreLockedError,
  legacyTeeKeystorePath,
  type OpenKeystore,
  readKeystore,
  type SweepPendingRecord,
  type SweepReceiptRecord,
  serializeKeystore,
  TEE_KEYSTORE_PURPOSE,
  withKeystoreLock,
  writeKeystoreFile,
} from "../wallet-keystore"
import { readDisableOutcome } from "./wallets"

const MIN_PASSPHRASE_LENGTH = 12
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const RPC_URL_ENV = "CANDLE_SOLANA_RPC_URL"
/** Finality polling: 2 s apart, up to 45 tries (90 s). A stalled confirmation is a residual, not a success. */
const CONFIRM_POLL_MS = 2_000
const CONFIRM_MAX_POLLS = 45

// ── Shared guards and store access ──────────────────────────────────────────────────────────

/** D3: the TEE wallet store's passphrase is typed. The variable's VALUE is never read, only its presence. */
function refuseEnvPassphrase(ctx: CommandContext): boolean {
  if (ctx.deps.env.CANDLE_KEYSTORE_PASSPHRASE === undefined) return true
  writeLocalFailure(
    ctx.deps,
    {
      code: "ENV_PASSPHRASE_REFUSED",
      message:
        "CANDLE_KEYSTORE_PASSPHRASE is set. The TEE wallet store never reads its passphrase from the environment.",
      suggestion: "Unset it and run again; the tee commands prompt for the passphrase with input hidden.",
    },
    ctx.json,
  )
  return false
}

function usage(ctx: CommandContext, line: string): number {
  writeUsageFailure(ctx.deps, line, ctx.json)
  return 2
}

type StoreRead = { path: string; raw: string | null } | { path: string; error: unknown } | { usage: string }

/**
 * The TEE store for this invocation: `--keystore`, else `CANDLE_CONFIG_DIR`, else the default
 * (and the pre-rename fallback). Returns `{ error }` rather than throwing for the one refusal
 * that can happen here, a `CANDLE_CONFIG_DIR` beginning with a literal `~` (D4): same exit 2 and
 * `USAGE` envelope as `vaultPathFor`. `--keystore` is already tilde-checked at parse time.
 */
function teeStorePathsFor(
  ctx: CommandContext,
  parsed: ParsedArgs,
): { current: string; legacy: string } | { error: string } {
  const flag = parsed.values["--keystore"]
  if (flag !== undefined) return { current: flag, legacy: flag }
  try {
    const home = ctx.deps.homedir()
    return { current: defaultTeeKeystorePath(ctx.deps.env, home), legacy: legacyTeeKeystorePath(ctx.deps.env, home) }
  } catch (error) {
    if (isUsageError(error)) return { error: error.message }
    throw error
  }
}

/**
 * Finds the TEE wallet store and reads it, once. `--keystore` wins. Otherwise the current store, or,
 * only when that file does not exist, the store a source-built CLI wrote before the rename
 * (`hot-wallets.enc`). `raw` is null when neither exists (reported against the current path); any
 * other read failure comes back as `error` with the path it happened on. A `CANDLE_CONFIG_DIR`
 * refusal comes back as `{ usage }` so the caller can exit 2 before any prompt or write.
 */
async function readTeeStore(ctx: CommandContext, parsed: ParsedArgs): Promise<StoreRead> {
  const paths = teeStorePathsFor(ctx, parsed)
  if ("error" in paths) return { usage: paths.error }
  const attempt = async (path: string): Promise<Exclude<StoreRead, { usage: string }>> => {
    try {
      return { path, raw: await readTeeStoreRaw(ctx.deps, path) }
    } catch (error) {
      return { path, error }
    }
  }
  const current = await attempt(paths.current)
  if ("error" in current || current.raw !== null) return current
  if (paths.legacy === paths.current) return current
  const legacy = await attempt(paths.legacy)
  return "error" in legacy || legacy.raw !== null ? legacy : current
}

/**
 * Why THIS store path, in the same words the vault's `VAULT_MISSING` uses (D3). `tee` resolves its
 * own path (`--keystore`, else the current default, else the pre-rename name), so it cannot reuse
 * `vaultPathFor`'s result -- but the operator reading the message cannot tell the two commands apart,
 * and should not have to.
 */
function teePathSourceNote(ctx: CommandContext, parsed: ParsedArgs): string {
  if (parsed.values["--keystore"] !== undefined) return "(from --keystore)"
  const configured = ctx.deps.env[CONFIG_DIR_ENV]?.trim()
  return configured
    ? `(from ${CONFIG_DIR_ENV}=${configured})`
    : `(the default: no --keystore given and ${CONFIG_DIR_ENV} is unset)`
}

/** null = no store here (ENOENT); throws for every other read failure (see wallets-generate). */
async function readTeeStoreRaw(deps: Deps, path: string): Promise<string | null> {
  try {
    return await deps.readFile(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code !== undefined && code !== "ENOENT") throw error
    return null
  }
}

async function promptPassphrase(
  deps: Deps,
  creating: boolean,
): Promise<{ ok: true; passphrase: string } | { ok: false; message: string }> {
  const first = (await deps.promptSecret("TEE wallet store passphrase (input hidden): ")).trim()
  if (first === "") return { ok: false, message: "A passphrase is required." }
  if (creating) {
    if (first.length < MIN_PASSPHRASE_LENGTH) {
      return { ok: false, message: `The passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.` }
    }
    const again = (await deps.promptSecret("Confirm passphrase: ")).trim()
    if (again !== first) return { ok: false, message: "The passphrases did not match. Nothing was created." }
  }
  return { ok: true, passphrase: first }
}

async function persistTee(store: OpenKeystore, path: string): Promise<string> {
  const contents = await serializeKeystore(store.entries, store.key, store.salt, store.iterations, TEE_KEYSTORE_PURPOSE)
  await writeKeystoreFile(path, contents)
  return contents
}

/** A store as opened: the decrypted entries plus the exact bytes they came from (null = no file yet). */
interface OpenedTee {
  store: OpenKeystore
  path: string
  passphrase: string
  raw: string | null
}

type CommitResult =
  | { ok: true; store: OpenKeystore }
  | { ok: false; code: "TEE_STORE_LOCKED" | "TEE_STORE_CHANGED" | "TEE_STORE_WRITE_FAILED"; message: string }

/**
 * T28 ("two writers cannot lose keys"): every write to the TEE wallet store goes through here. Under the
 * store lock it re-reads the file; if the bytes moved since this command opened it (another `tee`
 * command committed in between), it decrypts the CURRENT file with the same passphrase and applies
 * `mutate` to those entries instead of the stale copy, so a concurrent writer's key is carried
 * forward rather than replaced. `mutate` must therefore be expressed against whatever entries it
 * is handed (append an entry; find an entry by address and set fields), never against captured
 * objects. The lock spans only re-read + merge + write + optional read-back verification: no
 * prompt and no network call happens inside it.
 *
 * Fails closed, writing nothing, when the lock cannot be taken, when the changed file no longer
 * opens with this passphrase (it is not ours to merge into), or when `mutate` throws.
 */
async function commitTee(
  deps: Deps,
  opened: OpenedTee,
  mutate: (entries: KeystoreEntry[]) => void,
  opts: { verifyAddress?: string } = {},
): Promise<CommitResult> {
  try {
    const store = await withKeystoreLock(
      opened.path,
      deps,
      async () => {
        let current: string | null
        try {
          current = await deps.readFile(opened.path)
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | undefined)?.code
          if (code !== undefined && code !== "ENOENT") throw error
          current = null
        }
        let target = opened.store
        if (current !== opened.raw) {
          if (current === null) {
            // The file vanished under us. Its entries are not recoverable from here; write ours,
            // which is the most this command can honestly do.
            target = opened.store
          } else {
            try {
              target = await readKeystore(current, opened.passphrase, { expectPurpose: TEE_KEYSTORE_PURPOSE })
            } catch (error) {
              throw new StoreChangedError(
                `${opened.path} was replaced by another command and does not open with this passphrase: ` +
                  `${error instanceof Error ? error.message : error}`,
              )
            }
          }
        }
        mutate(target.entries)
        // Remember the bytes this command wrote: the next commit from the same command must not
        // mistake its own write for a foreign change and re-derive the key for nothing.
        opened.raw = await persistTee(target, opened.path)
        if (opts.verifyAddress !== undefined) {
          const reopened = await readKeystore(await deps.readFile(opened.path), opened.passphrase, {
            expectPurpose: TEE_KEYSTORE_PURPOSE,
          })
          const stored = reopened.entries.find((e) => e.address === opts.verifyAddress)
          if (!stored) throw new Error("the new entry is missing after re-reading the store")
          const derived = encodePubkey(pubkeyFromSecret(base58.decode(stored.privateKey)))
          if (derived !== opts.verifyAddress) throw new Error("the stored secret does not derive the printed address")
        }
        return target
      },
      { owner: `candle tee (pid ${process.pid})` },
    )
    opened.store = store
    return { ok: true, store }
  } catch (error) {
    if (error instanceof KeystoreLockedError) return { ok: false, code: "TEE_STORE_LOCKED", message: error.message }
    if (error instanceof StoreChangedError) return { ok: false, code: "TEE_STORE_CHANGED", message: error.message }
    return {
      ok: false,
      code: "TEE_STORE_WRITE_FAILED",
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

class StoreChangedError extends Error {}

/**
 * Phase 1 disable/sweep write target: either the legacy `tee-wallets.enc` store or a vault TEE
 * entry (CC-06 demote). Mutations are expressed against a KeystoreEntry view; vault commits map
 * tee fields back onto the KeyEntry without rewriting Phase 1 files.
 */
type ActiveTee =
  | { source: "legacy"; opened: OpenedTee; entry: KeystoreEntry; path: string; deps: Deps }
  | {
      source: "vault"
      resolved: Extract<ResolvedTee, { source: "vault" }>
      entry: KeystoreEntry
      path: string
      ctx: CommandContext
    }

function applyKeystoreViewToVaultEntry(entry: KeyEntry, view: KeystoreEntry): void {
  if (view.linkedWalletId !== undefined) entry.linkedWalletId = view.linkedWalletId
  else delete entry.linkedWalletId
  const meta = view.tee
  if (meta === undefined) return
  const prior = entry.tee
  let lifecycle = prior?.lifecycle ?? "enabled"
  if (meta.sweptAt !== undefined && lifecycle !== "stranded") lifecycle = "retired"
  entry.tee = {
    ...prior,
    ...meta,
    lifecycle,
  }
}

async function commitActiveTee(active: ActiveTee, mutate: (entry: KeystoreEntry) => void): Promise<CommitResult> {
  if (active.source === "legacy") {
    return commitTee(active.deps, active.opened, (entries) => {
      const target = entries.find((e) => e.address === active.entry.address)
      if (!target) throw new Error(`${active.entry.address} is no longer in ${active.path}`)
      mutate(target)
      active.entry = target
    })
  }
  mutate(active.entry)
  try {
    const next = await commitVaultTeeEntry(active.ctx, active.resolved.vault, active.resolved.entry.id, (entry) => {
      applyKeystoreViewToVaultEntry(entry, active.entry)
    })
    active.resolved.vault.raw = next.raw
    active.resolved.vault.file = next.file
    active.resolved.vault.index = next.index
    const updated = next.index.entries.find((e) => e.id === active.resolved.entry.id)
    if (updated === undefined) {
      return { ok: false, code: "TEE_STORE_WRITE_FAILED", message: "vault entry vanished after write" }
    }
    active.resolved.entry = updated
    return { ok: true, store: { entries: [active.entry] } as OpenKeystore }
  } catch (error) {
    return {
      ok: false,
      code: "TEE_STORE_WRITE_FAILED",
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

async function openActiveTee(
  ctx: CommandContext,
  parsed: ParsedArgs,
  address: string,
  access: TeeAccess,
): Promise<{ ok: true; active: ActiveTee } | { ok: false; code: number }> {
  const resolved = await resolveTeeAddress(ctx, parsed, address, () => openExistingTeeStore(ctx, parsed), access)
  if (!resolved.ok) return { ok: false, code: resolved.code }
  if (resolved.resolved.source === "vault") {
    return {
      ok: true,
      active: {
        source: "vault",
        resolved: resolved.resolved,
        entry: resolved.resolved.legacyView,
        path: "vault",
        ctx,
      },
    }
  }
  return {
    ok: true,
    active: {
      source: "legacy",
      opened: {
        store: resolved.resolved.store,
        path: resolved.resolved.path,
        passphrase: resolved.resolved.passphrase,
        raw: resolved.resolved.raw,
      },
      entry: resolved.resolved.entry,
      path: resolved.resolved.path,
      deps: ctx.deps,
    },
  }
}

function releaseActiveTee(active: ActiveTee): void {
  if (active.source === "vault") releaseResolvedTee(active.resolved)
}

function writeCommitFailure(ctx: CommandContext, failure: Extract<CommitResult, { ok: false }>, consequence: string) {
  writeLocalFailure(ctx.deps, { code: failure.code, message: failure.message, suggestion: consequence }, ctx.json)
}

type Opened = ({ ok: true } & OpenedTee) | { ok: false; code: number }

/** Opens an EXISTING TEE wallet store (prompting once) and returns it, or writes the failure and a code. */
async function openExistingTeeStore(ctx: CommandContext, parsed: ParsedArgs): Promise<Opened> {
  const { deps, json } = ctx
  const found = await readTeeStore(ctx, parsed)
  if ("usage" in found) return { ok: false, code: usage(ctx, found.usage) }
  const { path } = found
  if ("error" in found) {
    writeLocalFailure(
      deps,
      {
        code: "TEE_STORE_UNREADABLE",
        message: `Could not read ${path}: ${found.error instanceof Error ? found.error.message : found.error}`,
      },
      json,
    )
    return { ok: false, code: 1 }
  }
  const { raw } = found
  if (raw === null) {
    writeLocalFailure(
      deps,
      {
        // D3 (BE-241): the same source parenthetical the vault's own refusals carry. The code is
        // unchanged; what is added is WHY this path, which is the half that was missing when an
        // operator passed --keystore to one command and not the next.
        code: "TEE_STORE_MISSING",
        message: `No TEE wallet store at ${path} ${teePathSourceNote(ctx, parsed)}.`,
        suggestion: "Run: candle tee new",
      },
      json,
    )
    return { ok: false, code: 1 }
  }
  const passphrase = await promptPassphrase(deps, false)
  if (!passphrase.ok) {
    writeLocalFailure(deps, { code: "TEE_STORE_PASSPHRASE", message: passphrase.message }, json)
    return { ok: false, code: 1 }
  }
  try {
    const store = await readKeystore(raw, passphrase.passphrase, { expectPurpose: TEE_KEYSTORE_PURPOSE })
    return { ok: true, store, path, passphrase: passphrase.passphrase, raw }
  } catch (error) {
    writeLocalFailure(
      deps,
      { code: "TEE_STORE_UNREADABLE", message: error instanceof Error ? error.message : String(error) },
      json,
    )
    return { ok: false, code: 1 }
  }
}

function findEntry(store: OpenKeystore, address: string): KeystoreEntry | undefined {
  return store.entries.find((e) => e.address === address)
}

/**
 * Returns whether `address` is a TEE wallet inside the vault. Prompts for the vault passphrase
 * when a vault exists. `false` when there is no vault or the address is not in it; `"error"` when
 * the unlock failed.
 */
async function addressOwnedByVault(ctx: CommandContext, address: string): Promise<boolean | "error" | "usage"> {
  const { findTeeInVault } = await import("../vault/tee-lookup")
  const { closeVault } = await import("../vault/store")
  try {
    const hit = await findTeeInVault(ctx, address)
    if (!hit.hit) return false
    closeVault(hit.vault)
    return true
  } catch (error) {
    if (isUsageError(error)) {
      writeUsageFailure(ctx.deps, error.message, ctx.json)
      return "usage"
    }
    writeLocalFailure(
      ctx.deps,
      {
        code: "VAULT_UNLOCK_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
      ctx.json,
    )
    return "error"
  }
}

function noSuchEntry(ctx: CommandContext, address: string, path: string): number {
  writeLocalFailure(
    ctx.deps,
    {
      code: "TEE_WALLET_UNKNOWN",
      message: `${address} is not a TEE wallet in ${path}.`,
      suggestion: "Run: candle tee new",
    },
    ctx.json,
  )
  return 1
}

function isSolanaAddress(value: string): boolean {
  try {
    decodePubkey(value)
    return true
  } catch {
    return false
  }
}

/**
 * HW-03: the destination is confirmed by typing its last six characters. `promptSecret` is the
 * CLI's only interactive input; hidden echo is fine for six characters the operator can see on
 * the line above.
 */
async function confirmVault(deps: Deps, vault: string): Promise<boolean> {
  const typed = (
    await deps.promptSecret(`Type the LAST 6 characters of the vault address (${vault}) to confirm: `)
  ).trim()
  return typed === vault.slice(-6)
}

function rpcUrlFrom(ctx: CommandContext, parsed: ParsedArgs): string | { error: string } {
  const url = parsed.values["--rpc-url"] ?? ctx.deps.env[RPC_URL_ENV]?.trim()
  if (!url) return { error: `--rpc-url <url> is required (or set ${RPC_URL_ENV}).` }
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return { error: `--rpc-url is not a valid URL: ${url}` }
  }
  const local = parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost"
  if (parsedUrl.protocol !== "https:" && !(parsedUrl.protocol === "http:" && local)) {
    return { error: "--rpc-url must be https:// (plain http is allowed only for 127.0.0.1 / localhost)." }
  }
  return url
}

// ── tee new ─────────────────────────────────────────────────────────────────────────────────

export async function teeNew(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, json } = ctx
  if (!refuseEnvPassphrase(ctx)) return 1
  const parsed = parseArgs(args, { valueFlags: ["--label", "--keystore"], pathFlags: ["--keystore"] })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length > 0) return usage(ctx, `Unexpected argument: ${parsed.positionals[0]}`)

  const found = await readTeeStore(ctx, parsed)
  if ("usage" in found) return usage(ctx, found.usage)
  const { path } = found
  if ("error" in found) {
    writeLocalFailure(
      deps,
      {
        code: "TEE_STORE_UNREADABLE",
        message: `Could not read ${path}: ${found.error instanceof Error ? found.error.message : found.error}`,
        suggestion: "Refusing to continue: a store may exist at that path, and overwriting it would destroy its keys.",
      },
      json,
    )
    return 1
  }
  const { raw } = found

  const passphrase = await promptPassphrase(deps, raw === null)
  if (!passphrase.ok) {
    writeLocalFailure(deps, { code: "TEE_STORE_PASSPHRASE", message: passphrase.message }, json)
    return 1
  }

  let store: OpenKeystore
  if (raw !== null) {
    try {
      store = await readKeystore(raw, passphrase.passphrase, { expectPurpose: TEE_KEYSTORE_PURPOSE })
    } catch (error) {
      writeLocalFailure(
        deps,
        { code: "TEE_STORE_UNREADABLE", message: error instanceof Error ? error.message : String(error) },
        json,
      )
      return 1
    }
  } else {
    store = { ...(await createKeystore(passphrase.passphrase)), entries: [] }
  }

  const wallet = generateWallet("solana")
  // The index and default label are decided at commit time against the entries actually in the
  // file (T28): a concurrent `tee new` may have appended since this command opened the store.
  let index = -1
  let label = ""
  const committed = await commitTee(
    deps,
    { store, path, passphrase: passphrase.passphrase, raw },
    (entries) => {
      index = entries.length
      label = parsed.values["--label"] ?? `tee-${index}`
      entries.push({
        index,
        chain: "solana",
        address: wallet.address,
        label,
        createdAt: new Date().toISOString(),
        privateKey: wallet.privateKey,
        imported: false,
        tee: { network: "solana-mainnet" },
      })
    },
    // HW-01: seal, then PROVE the backup restores before printing anything: re-read the file with
    // the same passphrase and check the stored secret derives the printed address.
    { verifyAddress: wallet.address },
  )
  if (!committed.ok) {
    writeLocalFailure(
      deps,
      {
        code: committed.code === "TEE_STORE_WRITE_FAILED" ? "TEE_STORE_VERIFY_FAILED" : committed.code,
        message: `${committed.code === "TEE_STORE_WRITE_FAILED" ? "Backup verification failed: " : ""}${committed.message}`,
        suggestion: "Nothing was enabled or funded. Fix the error and run: candle tee new",
      },
      json,
    )
    return 1
  }

  if (json) {
    deps.stdout.write(
      `${JSON.stringify({ address: wallet.address, index, label, keystore: path, state: "local-only" })}\n`,
    )
    return 0
  }
  deps.stdout.write(`New TEE wallet [${index}] ${wallet.address}  ${label}\n`)
  deps.stdout.write(`Sealed to ${path} and verified to restore.\n`)
  deps.stdout.write(`BACK UP THIS FILE AND REMEMBER THE PASSPHRASE. This key exists nowhere else.\n`)
  deps.stdout.write(`State: local-only. Next: candle tee enable ${wallet.address} --vault <your-vault-address>\n`)
  return 0
}

// ── tee enable ──────────────────────────────────────────────────────────────────────────────

export async function teeEnable(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  if (!refuseEnvPassphrase(ctx)) return 1
  const parsed = parseArgs(args, {
    valueFlags: ["--vault", "--vault-key", "--label", "--keystore"],
    booleanFlags: ["--accept-unknown-exposure"],
    pathFlags: ["--keystore"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [address, extra] = parsed.positionals
  if (!address || extra !== undefined) {
    return usage(ctx, "Usage: candle tee enable <address> --vault <address> | --vault-key <label>")
  }
  const vaultFlag = parsed.values["--vault"]
  const vaultKey = parsed.values["--vault-key"]
  if (vaultFlag !== undefined && vaultKey !== undefined) {
    return usage(ctx, "Use either --vault or --vault-key, not both.")
  }
  let vault = vaultFlag
  if (vaultKey !== undefined) {
    const { assertColdVaultDestination } = await import("../vault/promote-support")
    const { readVaultRaw, closeVault } = await import("../vault/store")
    const { unlockInteractively, vaultPathFor } = await import("./vault-support")
    const { isVaultError } = await import("../vault/errors")
    const resolvedVault = vaultPathFor(ctx, parsed)
    if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
    const vaultPath = resolvedVault.path
    const raw = await readVaultRaw(vaultPath)
    if (raw === null) {
      writeLocalFailure(
        deps,
        { code: "VAULT_MISSING", message: `No vault at ${vaultPath}.`, suggestion: "Create one: candle vault init" },
        json,
      )
      return 1
    }
    // The shared factor-aware open (BE-140): `--factor` and `--device` apply here as on every
    // vault command, so a security key names the destination and no passphrase is substituted.
    // An older whole-file copy warns rather than refuses, as the tee commands always have.
    let opened: import("../vault/store").UnlockedVault
    try {
      opened = (await unlockInteractively(ctx, vaultPath, raw, { acceptOlderCopy: true })).vault
    } catch (error) {
      if (isVaultError(error)) {
        writeLocalFailure(
          deps,
          { code: error.code, message: error.message, ...(error.suggestion ? { suggestion: error.suggestion } : {}) },
          json,
        )
        return error.exitCode
      }
      throw error
    }
    try {
      const destination = assertColdVaultDestination(opened.index, vaultKey, {
        acceptUnknownExposure: parsed.booleans.has("--accept-unknown-exposure"),
      })
      vault = destination.address
    } catch (error) {
      if (error instanceof Error && "code" in error) {
        const coded = error as Error & { code: string; suggestion?: string }
        writeLocalFailure(
          deps,
          {
            code: String(coded.code),
            message: coded.message,
            ...(coded.suggestion ? { suggestion: coded.suggestion } : {}),
          },
          json,
        )
        return 1
      }
      throw error
    } finally {
      closeVault(opened)
    }
  }
  if (!vault)
    return usage(ctx, "--vault <address> or --vault-key <label> is required: the destination every sweep sends to.")
  if (!isSolanaAddress(vault)) return usage(ctx, "--vault is not a valid Solana address.")
  if (vault === address) return usage(ctx, "--vault must be a different address from the TEE wallet.")

  // CC-05: a migrated address is owned by the vault; never rewrite tee-wallets.enc for it.
  const vaultOwned = await addressOwnedByVault(ctx, address)
  if (vaultOwned === "usage") return 2
  if (vaultOwned === "error") return 1
  if (vaultOwned === true) return refuseLegacyWriteForVaultAddress(ctx, address)

  await printIdentity(ctx)
  const apiKey = await resolveApiKey(deps, ctx.profile)
  if (!apiKey) {
    writeLocalFailure(
      deps,
      { code: "NO_API_KEY", message: "No API key available.", suggestion: "Run: candle keys create" },
      json,
    )
    return 1
  }

  const opened = await openExistingTeeStore(ctx, parsed)
  if (!opened.ok) return opened.code
  const { store, path } = opened
  const entry = findEntry(store, address)
  if (!entry) return noSuchEntry(ctx, address, path)
  if (entry.imported || entry.linkedWalletId) {
    writeLocalFailure(
      deps,
      {
        code: "TEE_WALLET_ALREADY_ENABLED",
        message: `${address} was already enabled${entry.linkedWalletId ? ` as ${entry.linkedWalletId}` : ""}.`,
        suggestion: "A retired or enabled TEE wallet is never re-enabled. Run: candle tee new",
      },
      json,
    )
    return 1
  }

  // HW-02: the human sees exactly what is being granted before confirming.
  if (!json) {
    deps.stdout.write(`About to delegate a DEDICATED TEE wallet to this profile's agent:\n`)
    deps.stdout.write(`  TEE wallet   ${address}\n`)
    deps.stdout.write(`  network      solana-mainnet\n`)
    deps.stdout.write(`  sweep vault  ${vault}\n`)
    deps.stdout.write(
      `  routes       trade rail only (build/confirm/submit) with THIS profile's API key; nothing else\n`,
    )
    deps.stdout.write(
      `  limits       the key's per-transaction cap and USD window cap must both be set; the server refuses otherwise\n`,
    )
    deps.stdout.write(
      `Exposure: everything you fund into this wallet, plus anything deposited later, can be lost by a\n`,
    )
    deps.stdout.write(
      `compromised agent within those limits. Once enabled a copy of this key stays in the TEE for good.\n`,
    )
  }
  if (!(await confirmVault(deps, vault))) {
    writeLocalFailure(
      deps,
      { code: "VAULT_NOT_CONFIRMED", message: "The vault confirmation did not match. Nothing was enabled." },
      json,
    )
    return 1
  }

  const flow = await runImportFlow({
    chain: "solana",
    address,
    privateKey: entry.privateKey,
    label: parsed.values["--label"] ?? entry.label,
    apiKey,
    apiUrl,
    deps,
    profile: TEE_PROFILE,
    vaultDestination: vault,
  })
  if (!flow.ok) {
    const failure = flow.failure
    if (failure.kind === "api") writeFailure(deps, failure.response, { apiUrl, authType: "key" }, json)
    else {
      writeLocalFailure(
        deps,
        {
          code: failure.kind === "signer-store" ? "SIGNER_STORE_FAILED" : "SIGNER_COMMIT_FAILED",
          message: `${address}: ${failure.error instanceof Error ? failure.error.message : failure.error}`,
          suggestion: "The key is still sealed locally. Fix the error above and run enable again.",
        },
        json,
      )
    }
    return 1
  }

  const submitted = flow.submitted
  const importedAt = new Date().toISOString()
  const committed = await commitTee(deps, opened, (entries) => {
    const target = entries.find((e) => e.address === address)
    if (!target) throw new Error(`${address} is no longer in ${path}`)
    target.imported = true
    target.linkedWalletId = submitted.id
    target.privyWalletId = submitted.privyWalletId
    target.importedAt = importedAt
    target.tee = {
      network: "solana-mainnet",
      vaultDestination: vault,
      ...(submitted.boundKeyPrefix ? { boundKeyPrefix: submitted.boundKeyPrefix } : {}),
      remoteAuthority: submitted.remoteAuthority ?? "unknown",
      enabledAt: importedAt,
    }
  })
  if (!committed.ok) {
    writeCommitFailure(
      ctx,
      committed,
      `The server DID import ${address} as ${submitted.id}, but the grant could not be recorded locally. ` +
        `Do not fund it. Stop it (candle tee disable ${address}, or revoke ${submitted.id} from your session) and enable a fresh wallet.`,
    )
    return 1
  }

  const verified = submitted.remoteAuthority === "verified-active"
  if (json) {
    deps.stdout.write(
      `${JSON.stringify({
        address,
        linkedWalletId: submitted.id,
        vaultDestination: vault,
        boundKeyPrefix: submitted.boundKeyPrefix ?? null,
        remoteAuthority: submitted.remoteAuthority ?? "unknown",
        state: "enabled",
        tradable: verified,
      })}\n`,
    )
    return verified ? 0 : 3
  }
  if (verified) {
    deps.stdout.write(`Enabled ${address} as ${submitted.id}, bound to key ${submitted.boundKeyPrefix ?? "?"}.\n`)
    deps.stdout.write(`Remote authority verified. Fund it: candle tee fund ${address} --amount <n> --asset SOL|USDC\n`)
    return 0
  }
  deps.stdout.write(
    `Imported ${address} as ${submitted.id}, but the server could NOT verify the remote authority` +
      `${submitted.reasonCode ? ` (${submitted.reasonCode})` : ""}. The agent cannot trade it.\n` +
      `Do not fund it. Disable it (candle tee disable ${address}) and enable a fresh wallet.\n`,
  )
  return 3
}

// ── tee fund ────────────────────────────────────────────────────────────────────────────────

function decimalToRaw(decimal: string, decimals: number): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(decimal)) return null
  const [whole, frac = ""] = decimal.split(".")
  if (frac.length > decimals) return null
  return BigInt((whole ?? "0") + frac.padEnd(decimals, "0"))
}

export async function teeFund(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, json } = ctx
  if (!refuseEnvPassphrase(ctx)) return 1
  const parsed = parseArgs(args, { valueFlags: ["--amount", "--asset", "--keystore"], pathFlags: ["--keystore"] })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [address, extra] = parsed.positionals
  if (!address || extra !== undefined)
    return usage(ctx, "Usage: candle tee fund <address> --amount <n> [--asset SOL|USDC]")
  const asset = (parsed.values["--asset"] ?? "SOL").toUpperCase()
  if (asset !== "SOL" && asset !== "USDC") return usage(ctx, "--asset must be SOL or USDC.")
  const amount = parsed.values["--amount"]
  if (!amount) return usage(ctx, "--amount <n> is required.")
  const decimals = asset === "SOL" ? 9 : 6
  const raw = decimalToRaw(amount, decimals)
  if (raw === null || raw === 0n)
    return usage(ctx, `--amount must be a positive decimal with at most ${decimals} decimal places.`)

  // Vault first (PR split B / CC-05): a migrated entry wins over a stale tee-wallets.enc row.
  const resolved = await resolveTeeAddress(ctx, parsed, address, () => openExistingTeeStore(ctx, parsed))
  if (!resolved.ok) return resolved.code
  try {
    const entry = resolved.resolved.source === "vault" ? resolved.resolved.legacyView : resolved.resolved.entry
    if (!entry.linkedWalletId || entry.tee?.remoteAuthority !== "verified-active") {
      writeLocalFailure(
        deps,
        {
          code: "TEE_WALLET_NOT_VERIFIED",
          message: `${address} is not an enabled TEE wallet with verified remote authority; do not fund it.`,
          suggestion: "Run: candle tee enable <address> --vault <address>, and fund only after it reports verified.",
        },
        json,
      )
      return 1
    }
    if (entry.tee?.stopRequestedAt) {
      writeLocalFailure(
        deps,
        { code: "TEE_WALLET_STOPPED", message: `${address} has been stopped; a retired address is never refunded.` },
        json,
      )
      return 1
    }

    const instruction = {
      action: "fund-tee-wallet",
      network: "solana-mainnet",
      asset,
      ...(asset === "USDC" ? { mint: USDC_MINT } : {}),
      amount,
      amountRaw: raw.toString(),
      destination: address,
      from: "your vault wallet (sign it there; this CLI signs nothing)",
      note: "Every funded unit adds to the TEE wallet exposure. The initial float is not a maximum loss.",
    }
    if (json) {
      deps.stdout.write(`${JSON.stringify(instruction)}\n`)
      return 0
    }
    deps.stdout.write(`Funding instruction (sign this from your VAULT wallet; this CLI signs nothing):\n`)
    deps.stdout.write(
      `  send      ${amount} ${asset}${asset === "USDC" ? ` (mint ${USDC_MINT})` : ""}  = ${raw} raw units\n`,
    )
    deps.stdout.write(`  to        ${address}\n`)
    deps.stdout.write(`  network   solana-mainnet\n`)
    deps.stdout.write(`Every funded unit adds to the TEE wallet exposure; the initial float is not a maximum loss.\n`)
    return 0
  } finally {
    releaseResolvedTee(resolved.resolved)
  }
}

// ── tee status ──────────────────────────────────────────────────────────────────────────────

type ApiFailure = Extract<Awaited<ReturnType<typeof apiRequest>>, { ok: false }>

interface LifecycleResponse {
  state?: string
  remoteAuthority?: string
  evidenceObservedAt?: number | null
  boundKeyPrefix?: string | null
  vaultDestination?: string | null
  revokedAt?: number | null
  sweptAt?: number | null
}

async function readLifecycle(
  ctx: CommandContext,
  apiKey: string,
  linkedWalletId: string,
): Promise<{ ok: true; body: LifecycleResponse } | { ok: false; result: ApiFailure }> {
  const result = await apiRequest(`/api/v1/agent/wallets/${encodeURIComponent(linkedWalletId)}/lifecycle`, {
    auth: "key",
    credentials: { apiKey },
    apiUrl: ctx.apiUrl,
    fetch: ctx.deps.fetch,
    env: ctx.deps.env,
  })
  if (!result.ok) return { ok: false, result }
  return { ok: true, body: result.body as LifecycleResponse }
}

export async function teeStatus(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, json } = ctx
  if (!refuseEnvPassphrase(ctx)) return 1
  const parsed = parseArgs(args, { valueFlags: ["--rpc-url", "--keystore"], pathFlags: ["--keystore"] })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [address, extra] = parsed.positionals
  if (!address || extra !== undefined) return usage(ctx, "Usage: candle tee status <address> [--rpc-url <url>]")

  const resolved = await resolveTeeAddress(ctx, parsed, address, () => openExistingTeeStore(ctx, parsed))
  if (!resolved.ok) return resolved.code
  try {
    if (resolved.resolved.source === "vault") {
      const reconciled = await maybeReconcileVaultTee(ctx, resolved.resolved)
      if (reconciled.code !== null) return reconciled.code
    }
    const entry = resolved.resolved.source === "vault" ? resolved.resolved.legacyView : resolved.resolved.entry

    const report: Record<string, unknown> = {
      address,
      label: entry.label,
      source: resolved.resolved.source,
      linkedWalletId: entry.linkedWalletId ?? null,
      vaultDestination: entry.tee?.vaultDestination ?? null,
      localState: entry.tee?.sweptAt
        ? "swept"
        : entry.tee?.stopRequestedAt
          ? "stop-requested"
          : entry.linkedWalletId
            ? "enabled"
            : "local-only",
      retainedSweepReceipts: entry.tee?.sweepReceipts?.length ?? 0,
      pendingSweepTransactions: entry.tee?.sweepPending?.length ?? 0,
      observedAt: new Date(deps.now()).toISOString(),
    }
    if (resolved.resolved.source === "vault") {
      report.vaultLifecycle = resolved.resolved.entry.tee?.lifecycle ?? null
    }

    if (entry.linkedWalletId) {
      const apiKey = await resolveApiKey(deps, ctx.profile)
      if (apiKey) {
        const lifecycle = await readLifecycle(ctx, apiKey, entry.linkedWalletId)
        if (lifecycle.ok) {
          report.server = lifecycle.body
        } else {
          report.server = { error: lifecycle.result.message ?? `HTTP ${lifecycle.result.status}` }
        }
      } else {
        report.server = { error: "no API key available; server state not read" }
      }
    }

    const rpcUrl = parsed.values["--rpc-url"] ?? deps.env[RPC_URL_ENV]?.trim()
    if (rpcUrl) {
      const checked = rpcUrlFrom(ctx, parsed)
      if (typeof checked !== "string") return usage(ctx, checked.error)
      const rpc = createSolanaRpc(checked, deps.fetch)
      try {
        const lamports = await rpc.getBalance(address)
        const tokens = [
          ...(await rpc.getTokenAccountsByOwner(address, TOKEN_PROGRAM_ID)),
          ...(await rpc.getTokenAccountsByOwner(address, TOKEN_2022_PROGRAM_ID)),
        ]
        report.balances = {
          lamports: lamports.toString(),
          tokens: tokens.map((t) => ({
            mint: t.mint,
            amountRaw: t.amountRaw,
            decimals: t.decimals,
            state: t.state,
            program: t.programId === TOKEN_PROGRAM_ID ? "token" : "token-2022",
            // Never priced here: an unpriced balance is reported as unknown, not as zero (HW-04).
            usdValue: "unknown",
          })),
        }
      } catch (error) {
        report.balances = { error: error instanceof Error ? error.message : String(error) }
      }
    }

    if (json) {
      deps.stdout.write(`${JSON.stringify(report)}\n`)
      return 0
    }
    deps.stdout.write(`${address}  ${entry.label}\n`)
    if (resolved.resolved.source === "vault") {
      deps.stdout.write(`  source        vault (Phase 1 store is read-only for this address)\n`)
      deps.stdout.write(`  vault life    ${resolved.resolved.entry.tee?.lifecycle ?? "?"}\n`)
    }
    deps.stdout.write(`  local state   ${report.localState}\n`)
    if (entry.tee?.vaultDestination) deps.stdout.write(`  vault         ${entry.tee.vaultDestination}\n`)
    const server = report.server as LifecycleResponse | { error: string } | undefined
    if (server) {
      if ("error" in server) deps.stdout.write(`  server        (unavailable: ${server.error})\n`)
      else {
        deps.stdout.write(`  server state  ${server.state ?? "?"}  remote authority ${server.remoteAuthority ?? "?"}\n`)
        if (server.evidenceObservedAt)
          deps.stdout.write(`  evidence at   ${new Date(server.evidenceObservedAt).toISOString()}\n`)
      }
    }
    const balances = report.balances as
      | { lamports?: string; tokens?: Array<Record<string, unknown>>; error?: string }
      | undefined
    if (balances) {
      if (balances.error) deps.stdout.write(`  balances      (unavailable: ${balances.error})\n`)
      else {
        deps.stdout.write(`  SOL           ${balances.lamports} lamports\n`)
        for (const t of balances.tokens ?? []) {
          deps.stdout.write(
            `  token         ${t.mint}  ${t.amountRaw} raw (${t.decimals} dp, ${t.state}, ${t.program})  USD unknown\n`,
          )
        }
      }
    }
    deps.stdout.write(`  observed at   ${report.observedAt}\n`)
    return 0
  } finally {
    releaseResolvedTee(resolved.resolved)
  }
}

// ── tee disable ─────────────────────────────────────────────────────────────────────────────

export async function teeDisable(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  if (!refuseEnvPassphrase(ctx)) return 1
  const parsed = parseArgs(args, { valueFlags: ["--keystore"], pathFlags: ["--keystore"] })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [address, extra] = parsed.positionals
  if (!address || extra !== undefined) return usage(ctx, "Usage: candle tee disable <address>")

  await printIdentity(ctx)
  // Disable reads the grant handle and never signs: the key is verified, not kept.
  const openedActive = await openActiveTee(ctx, parsed, address, "read")
  if (!openedActive.ok) return openedActive.code
  const { active } = openedActive
  try {
    const entry = active.entry
    if (!entry.linkedWalletId) {
      writeLocalFailure(
        deps,
        { code: "TEE_WALLET_NOT_ENABLED", message: `${address} was never enabled; there is nothing to stop.` },
        json,
      )
      return 1
    }
    const linkedWalletId = entry.linkedWalletId

    // HW-06: the stop intent is durable BEFORE the server is asked. From here on this CLI refuses to
    // fund the address whatever the server answers; a failed or unavailable acknowledgement is
    // reported as remote enforcement unconfirmed, never as "nothing happened".
    const stopRequestedAt = entry.tee?.stopRequestedAt ?? new Date().toISOString()
    const committed = await commitActiveTee(active, (target) => {
      target.tee = { ...(target.tee ?? { network: "solana-mainnet" }), stopRequestedAt }
    })
    if (!committed.ok) {
      writeCommitFailure(
        ctx,
        committed,
        `The stop was NOT recorded locally and the server was not asked. Retry: candle tee disable ${address}`,
      )
      return 1
    }

    const unconfirmed = (detail: string, suggestion: string) => {
      if (json) {
        deps.stdout.write(
          `${JSON.stringify({
            ok: false,
            code: "STOP_UNCONFIRMED",
            message: detail,
            address,
            linkedWalletId,
            stopRequestedAt,
            remoteEnforcement: "unconfirmed",
            suggestion,
          })}\n`,
        )
        return
      }
      deps.stderr.write(`${detail}\n`)
      deps.stderr.write(
        `Stop intent recorded locally at ${stopRequestedAt}: this CLI will not fund ${address} again. ` +
          `Remote enforcement is UNCONFIRMED: the agent may still trade until the server acknowledges the stop.\n${suggestion}\n`,
      )
    }

    const apiKey = await resolveApiKey(deps, ctx.profile)
    if (!apiKey) {
      unconfirmed(
        "No API key available, so the server was not asked to stop the agent.",
        `Stop it from your Candle session (revoke linked wallet ${linkedWalletId}), or restore the key and re-run: candle tee disable ${address}`,
      )
      return 1
    }

    const result = await apiRequest(`/api/v1/agent/wallets/${encodeURIComponent(linkedWalletId)}`, {
      method: "DELETE",
      auth: "key",
      credentials: { apiKey },
      apiUrl,
      fetch: deps.fetch,
      env: deps.env,
    })
    if (!result.ok) {
      unconfirmed(
        `The stop request failed: ${result.message ?? `HTTP ${result.status}`}${result.status === 401 ? " (this API key no longer works)" : ""}.`,
        `Re-run: candle tee disable ${address}. If the key is lost or revoked, stop it from your Candle session (revoke linked wallet ${linkedWalletId}).`,
      )
      return 1
    }
    const outcome = readDisableOutcome(result.body)

    if (json) {
      deps.stdout.write(
        `${JSON.stringify({ address, linkedWalletId: entry.linkedWalletId, ...(result.body as object) })}\n`,
      )
      return outcome.complete ? 0 : 3
    }
    if (outcome.complete) {
      deps.stdout.write(`Stopped ${address}. Remote signing denial verified; the wallet is quarantined.\n`)
      deps.stdout.write(`Recover the funds: candle tee sweep ${address} --rpc-url <url>\n`)
      return 0
    }
    deps.stdout.write(
      `Agent trading stopped at Candle for ${address}. Remote policy verification is pending` +
        `${outcome.reasonCode ? ` (${outcome.reasonCode})` : ""}.\n` +
        `Funds remain in the TEE wallet and its TEE signing authority may still be active. Re-run: candle tee disable ${address}\n` +
        `If the provider is down or theft is suspected: candle tee sweep ${address} --rpc-url <url> --emergency\n`,
    )
    return 3
  } finally {
    releaseActiveTee(active)
  }
}

// ── tee sweep ───────────────────────────────────────────────────────────────────────────────

type SweepReceipt = SweepReceiptRecord

/** SPL token account layout: mint(32) owner(32) amount(8) delegate COption(36), then state. */
const TOKEN_ACCOUNT_STATE_OFFSET = 108
const TOKEN_ACCOUNT_STATE_FROZEN = 2

interface SweepResidual {
  kind: string
  detail: string
  mint?: string
  account?: string
  amountRaw?: string
}

/** The typed lifecycle state a refused sweep record carries (`error.state`), or null. */
function refusalState(raw: unknown): "disable-pending" | "enabled" | null {
  if (!raw || typeof raw !== "object") return null
  const error = (raw as { error?: unknown }).error
  if (!error || typeof error !== "object") return null
  const state = (error as { state?: unknown }).state
  return state === "disable-pending" || state === "enabled" ? state : null
}

type BroadcastOutcome =
  | { status: "finalized"; signature: string }
  | { status: "failed"; signature: string; error: string }
  /** Sent (or possibly sent) and not finalized within the deadline: the pending record stays. */
  | { status: "uncertain"; signature: string; error: string }
  | { status: "not-sent"; error: string }

/**
 * Sign, RECORD the pending transaction in the sealed entry, then broadcast and wait for
 * `finalized`. The signature is known before the broadcast (it is the ed25519 signature over
 * the message), so the record is written first: a polling deadline, a send that throws after
 * the RPC may have relayed it, or a crash all leave a pending record the next run can resolve,
 * and a timeout is reported as uncertain, never as failed. `recordPending` persists; `clearPending`
 * removes the record once the fate is known (a failed transaction never lands, so its balance is
 * swept again).
 */
async function broadcastAndFinalize(
  rpc: SolanaRpc,
  deps: Deps,
  secret: Uint8Array,
  feePayer: Uint8Array,
  instructions: Instruction[],
  pending: Omit<SweepPendingRecord, "signature" | "blockhash" | "submittedAt">,
  recordPending: (record: SweepPendingRecord) => Promise<boolean>,
  clearPending: (signature: string) => Promise<void>,
): Promise<BroadcastOutcome> {
  const blockhash = await rpc.getLatestBlockhash()
  const message = compileLegacyMessage({ feePayer, recentBlockhash: blockhash, instructions })
  const signatureBytes = signMessage(message, secret)
  // The transaction's identity is its first signature, known here, before submission. Nothing
  // the RPC answers later replaces it.
  const signature = base58.encode(signatureBytes)
  const wire = serializeSignedTransaction(message, signatureBytes)
  const recorded = await recordPending({
    ...pending,
    signature,
    blockhash,
    submittedAt: new Date(deps.now()).toISOString(),
  })
  if (!recorded) {
    return { status: "not-sent", error: "could not record the pending transaction locally; not broadcast" }
  }
  let echoNote = ""
  try {
    const echoed = await rpc.sendTransaction(toBase64(wire))
    if (echoed !== signature) {
      // A conforming RPC echoes the transaction's first signature. A different answer is a
      // protocol error on the RPC's side: it is noted, the locally known identity stays
      // authoritative for every later status read, and this send counts as uncertain unless the
      // chain confirms it under that identity.
      echoNote = `; the RPC echoed a different signature (${echoed}), which was ignored`
    }
  } catch (error) {
    return {
      status: "uncertain",
      signature,
      error: `send did not answer cleanly (${error instanceof Error ? error.message : error}); it may still land`,
    }
  }
  for (let i = 0; i < CONFIRM_MAX_POLLS; i++) {
    let status: Awaited<ReturnType<SolanaRpc["getSignatureStatus"]>>
    try {
      status = await rpc.getSignatureStatus(signature)
    } catch (error) {
      return {
        status: "uncertain",
        signature,
        error: `status read failed (${error instanceof Error ? error.message : error}); ${signature} may still land`,
      }
    }
    const observed = classifyStatus(status)
    if (observed.kind === "finalized") return { status: "finalized", signature }
    if (observed.kind === "failed") {
      // Final and failed: it can never land. Only a FINALIZED error settles it; an error seen at
      // processed/confirmed can still roll back with its fork and keeps polling.
      await clearPending(signature)
      return {
        status: "failed",
        signature,
        error: `transaction ${signature} failed on chain: ${JSON.stringify(observed.err)}`,
      }
    }
    await deps.sleep(CONFIRM_POLL_MS)
  }
  return {
    status: "uncertain",
    signature,
    error: `transaction ${signature} was not finalized within ${(CONFIRM_MAX_POLLS * CONFIRM_POLL_MS) / 1000}s; it may still land${echoNote}`,
  }
}

export async function teeSweep(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  if (!refuseEnvPassphrase(ctx)) return 1
  const parsed = parseArgs(args, {
    valueFlags: ["--rpc-url", "--keystore"],
    booleanFlags: ["--emergency"],
    pathFlags: ["--keystore"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [address, extra] = parsed.positionals
  if (!address || extra !== undefined)
    return usage(ctx, "Usage: candle tee sweep <address> --rpc-url <url> [--emergency]")
  const rpcUrl = rpcUrlFrom(ctx, parsed)
  if (typeof rpcUrl !== "string") return usage(ctx, rpcUrl.error)
  const emergency = parsed.booleans.has("--emergency")

  // The one tee command that signs with the key, so the one that may keep it after the verify.
  const openedActive = await openActiveTee(ctx, parsed, address, "sign")
  if (!openedActive.ok) return openedActive.code
  const { active } = openedActive
  try {
    const entry = active.entry
    const vault = entry.tee?.vaultDestination
    if (!vault) {
      writeLocalFailure(
        deps,
        {
          code: "TEE_WALLET_NO_VAULT",
          message: `${address} has no pinned vault (it was never enabled), so there is nothing a sweep may send to.`,
        },
        json,
      )
      return 1
    }

    // Gate on the SERVER's derived state (HW-07): ordinary sweep waits for quarantine; only
    // --emergency proceeds from disable-pending, and it says what that means.
    //
    // HW-08 / T25: recovery must not depend on the operational credential. When the lifecycle
    // cannot be read at all (no API key, a revoked key, the API down), the server state is `unread`
    // and the sweep is allowed ONLY with --emergency, under the same race warning as a
    // disable-pending sweep: the local key and the pinned vault are all the recovery needs, and the
    // remote authority stays explicitly unknown until a later disable read-back verifies it.
    let serverState = "local-only"
    let apiKey: string | undefined
    let unreadReason: string | null = null
    if (entry.linkedWalletId) {
      apiKey = await resolveApiKey(deps, ctx.profile)
      if (!apiKey) unreadReason = "no API key available"
      else {
        const lifecycle = await readLifecycle(ctx, apiKey, entry.linkedWalletId)
        if (!lifecycle.ok) {
          unreadReason = `the lifecycle read failed: ${lifecycle.result.message ?? `HTTP ${lifecycle.result.status}`}`
          if (lifecycle.result.status === 401 || lifecycle.result.status === 403) apiKey = undefined
        } else serverState = lifecycle.body.state ?? "unknown"
      }
      if (unreadReason !== null) {
        serverState = "unread"
        if (!emergency) {
          writeLocalFailure(
            deps,
            {
              code: "TEE_WALLET_STATE_UNREAD",
              message: `Could not read ${address}'s lifecycle from the server (${unreadReason}); its remote signing authority is unverified.`,
              suggestion:
                `Restore the API key or connectivity and re-run, or stop it from your Candle session first. ` +
                `If the credential is lost or theft is suspected, recover WITHOUT the server: candle tee sweep ${address} --rpc-url <url> --emergency ` +
                `(remote authority stays pending and a still-authorized agent signer may race the sweep).`,
            },
            json,
          )
          return 3
        }
      } else if (serverState === "enabled") {
        writeLocalFailure(
          deps,
          {
            code: "TEE_WALLET_STILL_ENABLED",
            message: `${address} is still enabled for the agent.`,
            suggestion: `Stop it first: candle tee disable ${address}`,
          },
          json,
        )
        return 1
      }
      if (serverState === "disable-pending" && !emergency) {
        writeLocalFailure(
          deps,
          {
            code: "TEE_WALLET_DISABLE_PENDING",
            message: `${address}'s remote signing authority is not yet verified denied.`,
            suggestion: `Re-run: candle tee disable ${address}. If the provider is down or theft is suspected, add --emergency (the agent signer may still race you).`,
          },
          json,
        )
        return 3
      }
      if (
        serverState !== "quarantined" &&
        serverState !== "swept" &&
        serverState !== "disable-pending" &&
        serverState !== "unread"
      ) {
        writeLocalFailure(
          deps,
          { code: "TEE_WALLET_STATE_UNKNOWN", message: `Server reports state "${serverState}"; refusing to sweep.` },
          json,
        )
        return 1
      }
    }
    if (emergency && !json) {
      deps.stdout.write(
        `EMERGENCY SWEEP: remote signing authority is NOT verified denied. A still-authorized agent signer or\n`,
      )
      deps.stdout.write(
        `any holder of a raw key copy can race these transactions. Recovered funds are recorded; remote authority stays pending.\n`,
      )
      if (unreadReason !== null) {
        deps.stdout.write(
          `The server's lifecycle state was NOT read (${unreadReason}): this recovery uses only the local key and the pinned vault.\n` +
            `Stop the agent from your Candle session if you have not, and re-run candle tee disable once a key is available.\n`,
        )
      }
    }

    if (!json) {
      deps.stdout.write(`Sweep ${address} -> vault ${vault} (solana-mainnet)\n`)
    }
    if (!(await confirmVault(deps, vault))) {
      writeLocalFailure(
        deps,
        { code: "VAULT_NOT_CONFIRMED", message: "The vault confirmation did not match. Nothing was signed." },
        json,
      )
      return 1
    }

    const secret = base58.decode(entry.privateKey)
    const teePubkey = pubkeyFromSecret(secret)
    if (encodePubkey(teePubkey) !== address) {
      writeLocalFailure(
        deps,
        { code: "TEE_KEY_MISMATCH", message: "The stored secret does not derive this address; refusing to sign." },
        json,
      )
      return 1
    }
    // A sweep retires the address whatever else happens (SC-06): record the stop intent locally
    // before the first signature, so `tee fund` refuses this address from now on even if the sweep
    // is interrupted, and even when the server could not be told (HW-06, HW-08).
    const stopRequestedAt = entry.tee?.stopRequestedAt ?? new Date().toISOString()
    const marked = await commitActiveTee(active, (target) => {
      target.tee = { ...(target.tee ?? { network: "solana-mainnet" }), stopRequestedAt }
    })
    if (!marked.ok) {
      writeCommitFailure(
        ctx,
        marked,
        "Nothing was signed: the sweep needs to record the retirement of this address first.",
      )
      return 1
    }

    const vaultKey = decodePubkey(vault)
    const rpc = createSolanaRpc(rpcUrl, deps.fetch)
    // HW-07 operation evidence: receipts from EARLIER runs of this sweep are retained in the sealed
    // entry and reconciled here; every receipt this run finalizes is persisted before the next
    // transaction is signed, so an outage or an interrupted run never loses what already moved.
    const retained: SweepReceipt[] = entry.tee?.sweepReceipts ?? []
    const receipts: SweepReceipt[] = []
    const residuals: SweepResidual[] = []
    let solHandledAsResidual = false
    const alreadyRecordedLocally = entry.tee?.sweptAt !== undefined
    const pendingStill: SweepPendingRecord[] = []
    const retainReceipt = async (receipt: SweepReceipt): Promise<void> => {
      receipts.push(receipt)
      const kept = await commitActiveTee(active, (target) => {
        const existing = target.tee?.sweepReceipts ?? []
        target.tee = {
          ...(target.tee ?? { network: "solana-mainnet" }),
          sweepReceipts: existing.some((r) => r.signature === receipt.signature) ? existing : [...existing, receipt],
          sweepPending: (target.tee?.sweepPending ?? []).filter((p) => p.signature !== receipt.signature),
        }
      })
      if (!kept.ok) {
        residuals.push({
          kind: "local-record-failed",
          detail: `finalized ${receipt.signature} but could not retain the receipt locally: ${kept.message}`,
        })
      }
    }
    const recordPending = async (record: SweepPendingRecord): Promise<boolean> => {
      const kept = await commitActiveTee(active, (target) => {
        const existing = target.tee?.sweepPending ?? []
        if (existing.some((p) => p.signature === record.signature)) return
        target.tee = { ...(target.tee ?? { network: "solana-mainnet" }), sweepPending: [...existing, record] }
      })
      if (!kept.ok) residuals.push({ kind: "local-record-failed", detail: kept.message })
      return kept.ok
    }
    const clearPending = async (signature: string): Promise<void> => {
      const kept = await commitActiveTee(active, (target) => {
        target.tee = {
          ...(target.tee ?? { network: "solana-mainnet" }),
          sweepPending: (target.tee?.sweepPending ?? []).filter((p) => p.signature !== signature),
        }
      })
      if (!kept.ok) residuals.push({ kind: "local-record-failed", detail: kept.message })
    }
    const broadcast = (
      instructions: Instruction[],
      pending: Omit<SweepPendingRecord, "signature" | "blockhash" | "submittedAt">,
    ) => broadcastAndFinalize(rpc, deps, secret, teePubkey, instructions, pending, recordPending, clearPending)
    /**
     * Records a non-finalized broadcast outcome; true when this run may keep signing. `failedKind`
     * is R5's name for this move, used only for a FINALIZED failure: that is the one outcome that
     * proves the send was refused rather than merely unconfirmed.
     */
    const settle = (
      outcome: Exclude<BroadcastOutcome, { status: "finalized" }>,
      pending: Omit<SweepPendingRecord, "signature" | "blockhash" | "submittedAt">,
      describe: string,
      failedKind?: string,
    ): boolean => {
      if (outcome.status === "failed") {
        residuals.push({
          kind: failedKind ?? `${describe}-failed`,
          detail: outcome.error,
          ...(pending.mint ? { mint: pending.mint } : {}),
          ...(pending.account ? { account: pending.account } : {}),
          ...(failedKind ? { amountRaw: pending.amountRaw } : {}),
        })
        return true
      }
      if (outcome.status === "not-sent") {
        residuals.push({ kind: `${describe}-not-sent`, detail: outcome.error })
        return false
      }
      residuals.push({
        kind: "finality-uncertain",
        detail: outcome.error,
        ...(pending.mint ? { mint: pending.mint } : {}),
        amountRaw: pending.amountRaw,
      })
      pendingStill.push({ ...pending, signature: outcome.signature, blockhash: "", submittedAt: "" })
      return false
    }

    // 0. Resolve what an EARLIER run left pending (HW-07 operation evidence). A signature that
    //    finalized after that run's deadline becomes a receipt; one that failed, or whose blockhash
    //    can no longer land, is dropped and its balance is swept again below; one still in flight
    //    keeps this run from signing anything new (a competing transfer of the same balance would
    //    race it), and the address stays residual until it resolves.
    let signingBlocked = false
    const reads = {
      status: (signature: string) => rpc.getSignatureStatus(signature),
      blockhashValid: (blockhash: string) => rpc.isBlockhashValid(blockhash),
    }
    for (const p of entry.tee?.sweepPending ?? []) {
      const resolution = await resolvePending(reads, p)
      if (resolution.kind === "finalized") {
        await retainReceipt({
          kind: p.kind,
          ...(p.mint ? { mint: p.mint } : {}),
          amountRaw: p.amountRaw,
          signature: p.signature,
          finalizedAt: new Date(deps.now()).toISOString(),
        })
        if (!json) deps.stdout.write(`  pending ${p.signature} from an earlier run finalized: receipt retained\n`)
        continue
      }
      if (resolution.kind === "failed" || resolution.kind === "expired") {
        await clearPending(p.signature)
        if (!json) deps.stdout.write(`  pending ${p.signature}: ${resolution.detail}; its balance is swept again\n`)
        continue
      }
      residuals.push({
        kind: "finality-uncertain",
        detail: `pending ${p.signature} from an earlier run: ${resolution.detail}; nothing new is signed until it resolves`,
        ...(p.mint ? { mint: p.mint } : {}),
        amountRaw: p.amountRaw,
      })
      pendingStill.push(p)
      signingBlocked = true
    }

    // 1. Token accounts under BOTH programs (R5): tokens first, closing each account for its rent
    //    (HW-07). Every instruction for an account runs under the program that OWNS its mint --
    //    the transfer, the destination ATA derivation, and the close. Phase 1 swept the classic
    //    program and listed Token-2022 as an untouched residual (SC-06); the Phase 2 ED-10
    //    amendment in this spec is what lets the TEE key sign the Token-2022 shapes too.
    const tokenAccounts: Awaited<ReturnType<SolanaRpc["getTokenAccountsByOwner"]>> = []
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      try {
        tokenAccounts.push(...(await rpc.getTokenAccountsByOwner(address, programId)))
      } catch (error) {
        residuals.push({
          kind: "inventory",
          detail: `could not list ${programId === TOKEN_PROGRAM_ID ? "token" : "Token-2022"} accounts: ${error instanceof Error ? error.message : error}`,
        })
      }
    }
    // One epoch read for the whole sweep, and only when a transfer-fee mint needs it.
    let epoch: bigint | undefined
    for (const acct of tokenAccounts) {
      if (signingBlocked) break
      const token2022 = acct.programId === TOKEN_2022_PROGRAM_ID
      if (acct.state !== "initialized") {
        residuals.push({
          // A frozen Token-2022 account earns R5's name; a classic one keeps Phase 1's.
          kind: token2022 && acct.state === "frozen" ? "TOKEN_2022_FROZEN" : "frozen-or-uninitialized",
          detail: `token account state ${acct.state}`,
          mint: acct.mint,
          account: acct.pubkey,
          amountRaw: acct.amountRaw,
        })
        continue
      }
      try {
        const tokenProgram = decodePubkey(acct.programId)
        const mint = decodePubkey(acct.mint)
        const source = decodePubkey(acct.pubkey)
        const destination = associatedTokenAddress(vaultKey, mint, tokenProgram)
        const instructions: Instruction[] = []
        const amount = BigInt(acct.amountRaw)
        let profile: MintProfile | undefined
        let extraAccountsMissing = false
        let destinationFrozen = false
        if (amount > 0n) {
          let extraAccounts: AccountMeta[] = []
          if (token2022) {
            // The mint is read for its extensions, not for its program: this account is already
            // known to be Token-2022 because Token-2022 listed it.
            profile = await readMintProfile(rpc, acct.mint)
            const hook = await resolveTransferHookAccounts(rpc, {
              profile,
              source,
              destination,
              owner: teePubkey,
              amount,
            })
            if (hook.ok) extraAccounts = hook.accounts
            else {
              // Never a refusal (P3-AD-9): the transfer is sent without the tail it could not
              // resolve, and a chain refusal is then named TOKEN_2022_EXTRA_ACCOUNTS_MISSING.
              extraAccountsMissing = true
              if (!json)
                deps.stdout.write(
                  `  ${acct.mint}: the transfer hook's extra accounts could not be resolved (${hook.reason})\n`,
                )
            }
            if (!json) for (const risk of profile.risks) deps.stdout.write(`  ${acct.mint}: ${risk.message}\n`)
            if (profile.newerTransferFee || profile.olderTransferFee) {
              epoch ??= await rpc.getEpoch()
              const { feeRaw, postFeeAmountRaw } = transferFeeFor(profile, amount, epoch)
              if (!json)
                deps.stdout.write(
                  `  ${acct.mint}: ${postFeeAmountRaw} raw will arrive; ${feeRaw} raw is withheld by the mint at epoch ${epoch}\n`,
                )
            }
          }
          const existing = await rpc.getAccountInfo(encodePubkey(destination))
          if (existing === null) {
            instructions.push(
              createAssociatedTokenAccountIdempotent({ payer: teePubkey, owner: vaultKey, mint, tokenProgram }),
            )
            destinationFrozen = profile?.defaultFrozen ?? false
          } else {
            destinationFrozen = existing.data[TOKEN_ACCOUNT_STATE_OFFSET] === TOKEN_ACCOUNT_STATE_FROZEN
          }
          instructions.push(
            tokenTransferChecked({
              source,
              mint,
              destination,
              owner: teePubkey,
              amount,
              decimals: acct.decimals,
              tokenProgram,
              extraAccounts,
            }),
          )
        }
        // The close runs under the SAME program as the transfer, in the same transaction: either
        // both land or neither does, so a refused transfer never leaves an emptied-and-closed ATA.
        instructions.push(
          tokenCloseAccount({ account: source, destination: teePubkey, owner: teePubkey, tokenProgram }),
        )
        const pending = {
          kind: amount > 0n ? ("token" as const) : ("close" as const),
          mint: acct.mint,
          account: acct.pubkey,
          amountRaw: acct.amountRaw,
        }
        const outcome = await broadcast(instructions, pending)
        if (outcome.status !== "finalized") {
          const named = profile
            ? classifyTokenSendFailure({ profile, frozen: destinationFrozen, extraAccountsMissing })
            : undefined
          if (!settle(outcome, pending, "token-transfer", named)) {
            signingBlocked = true
            break
          }
          continue
        }
        const signature = outcome.signature
        await retainReceipt({
          kind: pending.kind,
          mint: acct.mint,
          amountRaw: acct.amountRaw,
          signature,
          finalizedAt: new Date(deps.now()).toISOString(),
        })
        if (!json)
          deps.stdout.write(`  moved ${acct.amountRaw} raw of ${acct.mint} and closed its account: ${signature}\n`)
      } catch (error) {
        residuals.push({
          kind: "token-transfer-failed",
          detail: error instanceof Error ? error.message : String(error),
          mint: acct.mint,
          account: acct.pubkey,
          amountRaw: acct.amountRaw,
        })
      }
    }

    // 3. Native SOL last, minus the fee this exact transfer will cost. Skipped while an earlier
    //    transaction is still in flight: its fee and its transfer would change this balance.
    try {
      const balance = signingBlocked ? 0n : await rpc.getBalance(address)
      if (balance > 0n) {
        const blockhash = await rpc.getLatestBlockhash()
        const probe = compileLegacyMessage({
          feePayer: teePubkey,
          recentBlockhash: blockhash,
          instructions: [systemTransfer(teePubkey, vaultKey, 1n)],
        })
        const fee = await rpc.getFeeForMessage(toBase64(probe))
        if (fee === null) {
          solHandledAsResidual = true
          residuals.push({
            kind: "sol-fee-unknown",
            detail: "the RPC could not quote the transfer fee",
            amountRaw: balance.toString(),
          })
        } else if (balance <= fee) {
          solHandledAsResidual = true
          residuals.push({
            kind: "sol-dust",
            detail: `balance ${balance} lamports does not cover the ${fee} lamport fee`,
            amountRaw: balance.toString(),
          })
        } else {
          const amount = balance - fee
          const pending = { kind: "sol" as const, amountRaw: amount.toString() }
          const outcome = await broadcast([systemTransfer(teePubkey, vaultKey, amount)], pending)
          if (outcome.status !== "finalized") {
            solHandledAsResidual = true
            if (!settle(outcome, pending, "sol-transfer")) signingBlocked = true
          } else {
            const signature = outcome.signature
            await retainReceipt({
              kind: "sol",
              amountRaw: amount.toString(),
              signature,
              finalizedAt: new Date(deps.now()).toISOString(),
            })
            if (!json) deps.stdout.write(`  moved ${amount} lamports (fee ${fee}): ${signature}\n`)
          }
        }
      }
    } catch (error) {
      solHandledAsResidual = true
      residuals.push({ kind: "sol-transfer-failed", detail: error instanceof Error ? error.message : String(error) })
    }

    // 4. Post-finality inventory (SC-06, HW-07): completion is decided from what the chain holds
    //    AFTER the receipts finalized, never from the pre-transfer inventory. A deposit that landed
    //    while the transfers confirmed, a token account the earlier pass did not see, or an
    //    inventory read that fails all keep the address residual-present; `swept` needs an
    //    observed-empty wallet.
    const inventory: {
      observedAt: string
      verified: boolean
      lamports: string | null
      tokenAccounts: number | null
    } = { observedAt: new Date(deps.now()).toISOString(), verified: false, lamports: null, tokenAccounts: null }
    try {
      const listed = new Set(residuals.map((r) => r.account).filter((a): a is string => a !== undefined))
      const lamports = await rpc.getBalance(address)
      inventory.lamports = lamports.toString()
      if (lamports > 0n && !solHandledAsResidual) {
        residuals.push({
          kind: "sol-remaining",
          detail: `${lamports} lamports remain after finality (a late deposit or an unswept balance); re-run the sweep`,
          amountRaw: lamports.toString(),
        })
      }
      const remaining = [
        ...(await rpc.getTokenAccountsByOwner(address, TOKEN_PROGRAM_ID)),
        ...(await rpc.getTokenAccountsByOwner(address, TOKEN_2022_PROGRAM_ID)),
      ]
      inventory.tokenAccounts = remaining.length
      for (const acct of remaining) {
        if (listed.has(acct.pubkey)) continue
        residuals.push({
          kind: "token-account-remaining",
          detail: `token account still open after finality (${acct.state}, ${acct.programId === TOKEN_PROGRAM_ID ? "token" : "token-2022"}); re-run the sweep`,
          mint: acct.mint,
          account: acct.pubkey,
          amountRaw: acct.amountRaw,
        })
      }
      inventory.verified = true
    } catch (error) {
      residuals.push({
        kind: "inventory-unverified",
        detail: `the post-sweep balance inventory could not be read: ${error instanceof Error ? error.message : error}`,
      })
    }

    // 5. Completion (SC-06): swept only with receipts (this run's or retained from an earlier one),
    //    no residuals, a verified-empty inventory, a QUARANTINED grant (never from --emergency, never
    //    when the server's state was not read), and the server's own record accepted (the server
    //    refuses a disable-pending row, and its refusal carries the NEWER state, which replaces the
    //    one read before the transfers). Recorded on the server as the operator's own claim, then
    //    locally. A record that already exists (local `sweptAt`, or the server deriving `swept`) is
    //    not re-posted: the reconcile is idempotent.
    const allReceipts = [...retained, ...receipts]
    let recordedOnServer = alreadyRecordedLocally || serverState === "swept"
    const complete =
      residuals.length === 0 &&
      allReceipts.length > 0 &&
      inventory.verified &&
      !emergency &&
      (serverState === "quarantined" ||
        serverState === "swept" ||
        (serverState === "local-only" && !entry.linkedWalletId))
    if (complete && entry.linkedWalletId && apiKey && !recordedOnServer) {
      const result = await apiRequest(`/api/v1/agent/wallets/${encodeURIComponent(entry.linkedWalletId)}/swept`, {
        method: "POST",
        auth: "key",
        credentials: { apiKey },
        apiUrl,
        fetch: deps.fetch,
        env: deps.env,
        body: { signatures: allReceipts.map((r) => r.signature), residuals: [] },
      })
      recordedOnServer = result.ok
      if (!result.ok) {
        const refusedState = refusalState(result.raw)
        if (refusedState !== null) {
          // The server's answer is a newer observation than the lifecycle read before the transfers.
          serverState = refusedState
          residuals.push({
            kind: "server-record-refused",
            detail: `${result.message ?? `HTTP ${result.status}`} (server state now ${refusedState}); the receipts are retained locally, re-run after the stop is verified`,
          })
        } else {
          residuals.push({
            kind: "server-record-failed",
            detail: `${result.message ?? `HTTP ${result.status}`}; the receipts are retained locally, re-run to record`,
          })
        }
      }
    }
    let sweptLocally = false
    if (complete && (recordedOnServer || !entry.linkedWalletId)) {
      if (alreadyRecordedLocally) sweptLocally = true
      else {
        const sweptAt = new Date().toISOString()
        const recorded = await commitActiveTee(active, (target) => {
          target.tee = { ...(target.tee ?? { network: "solana-mainnet" }), sweptAt }
        })
        sweptLocally = recorded.ok
        if (!recorded.ok) residuals.push({ kind: "local-record-failed", detail: recorded.message })
      }
    }

    // The state this command can honestly report, from the NEWEST server observation. `unread` is
    // reported as disable-pending: a stop was recorded locally and remote enforcement is unconfirmed.
    const finalState = sweptLocally
      ? "swept"
      : emergency || serverState === "disable-pending" || serverState === "unread"
        ? "disable-pending"
        : serverState === "local-only"
          ? "local-only"
          : "quarantined"
    if (json) {
      deps.stdout.write(
        `${JSON.stringify({
          address,
          vaultDestination: vault,
          state: finalState,
          serverState,
          emergency,
          receipts: allReceipts,
          newReceipts: receipts.length,
          retainedReceipts: retained.length,
          residuals,
          pending: pendingStill.map((p) => ({
            kind: p.kind,
            ...(p.mint ? { mint: p.mint } : {}),
            amountRaw: p.amountRaw,
            signature: p.signature,
          })),
          inventory,
          recordedOnServer,
        })}\n`,
      )
      return finalState === "swept" ? 0 : 3
    }
    if (retained.length > 0)
      deps.stdout.write(
        `  ${retained.length} receipt(s) retained from an earlier run are included in this reconcile.\n`,
      )
    if (finalState === "swept") {
      deps.stdout.write(
        `Swept. ${allReceipts.length} transaction(s) finalized; this address is retired and must not be reused.\n`,
      )
      return 0
    }
    if (residuals.length > 0) {
      deps.stdout.write(
        `Sweep incomplete: ${residuals.length} residual(s) remain. This address stays ${finalState}; no new agent trades are allowed.\n`,
      )
      for (const r of residuals)
        deps.stdout.write(
          `  - ${r.kind}${r.mint ? ` ${r.mint}` : ""}${r.amountRaw ? ` (${r.amountRaw} raw)` : ""}: ${r.detail}\n`,
        )
    }
    if (emergency)
      deps.stdout.write(
        `Recovered funds recorded; remote authority is still pending. Re-run: candle tee disable ${address}\n`,
      )
    if (pendingStill.length > 0)
      deps.stdout.write(
        `${pendingStill.length} transaction(s) still in flight (${pendingStill.map((p) => p.signature).join(", ")}). Re-run this sweep: a finalized one becomes a receipt, an expired one is swept again.\n`,
      )
    if (serverState === "disable-pending" && !emergency)
      deps.stdout.write(
        `Remote signing authority is not verified denied. Re-run: candle tee disable ${address}, then re-run this sweep to record it.\n`,
      )
    if (allReceipts.length === 0 && residuals.length === 0) deps.stdout.write(`Nothing to sweep: no balances found.\n`)
    deps.stdout.write(
      `Inventory at ${inventory.observedAt}: ${inventory.verified ? `${inventory.lamports} lamports, ${inventory.tokenAccounts} token account(s)` : "NOT verified"}.\n`,
    )
    return 3
  } finally {
    releaseActiveTee(active)
  }
}
