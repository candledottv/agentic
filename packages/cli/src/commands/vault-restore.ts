/**
 * Ember Phase 2 (BE-136, CC-11): `candle vault restore --phrase` and `candle vault reconcile-exposure`.
 *
 * One rule governs everything in this file, and it is worth stating before any code: **discovery is
 * bounded, and absence of evidence is never evidence of coldness.** Every derived entry a restore
 * creates is written `exposureUnknown: true`, and no command in this document ever writes it back
 * to false. Positive evidence upgrades an entry to `everRemoteExposed: true`; nothing downgrades
 * one to a cold claim. That is not a missing feature: the linked-wallet list covers ONE Candle
 * account, and the same phrase can have been restored under a second account, under another
 * deployment, or into a wallet that never touched Candle. `hd.discovery.complete` is written
 * `false` for that reason and is never written `true`.
 *
 * The second rule is CC-11's separation of recovery from allocation. Restore RECOVERS: it derives
 * indices inside explicit bounds to reproduce addresses the root already determined, which is
 * always safe. It does not ALLOCATE, and the vault it builds does not either -- `vault new-key`
 * and `vault promote --from` refuse in it permanently, because no margin above the highest
 * recovered index can make an allocation claim true when the old boundary was never established.
 * The exit is a fresh root, and it needs no new command and no override flag.
 *
 * A gap scan is discovery, not enumeration. An allocated index that was never funded is invisible
 * to it, so a scan extends the derived set and establishes nothing about the indices it skipped.
 *
 * Phase 4a (BE-350, D7): `--evm-count <m>` derives EVM indices `0..m-1` on `m/44'/60'/n'/0/0` and
 * sets `hd.nextIndex.evm = m`. It defaults to 0, is never gap-scanned (there is no EVM scan;
 * `--rpc-url` stays the Solana endpoint), and is NOT recorded in `discovery`: `requestedCounts`
 * keeps its three Solana branches, because invariant 4 forbids a format change. A linked-wallet row
 * whose address is a derived EVM key flags that entry remotely exposed and appends its index to
 * `exposedIndexes.evm`; the entry stays `role: "vault"` and is never rewritten as a Solana
 * `tee-wallet`.
 */
import { rm } from "node:fs/promises"
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { resolveApiKey } from "../deps"
import { EVM_DERIVATION_SCHEME, looksLikeEvmAddress } from "../evm-lite"
import { flagEndpoint, RPC_URL_ENV, type SolanaClient, solanaClientFor, validateSolanaRpcUrl } from "../solana-endpoint"
import { type SolanaRpc, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../solana-lite"
import { createVault, freshHdRecord } from "../vault/create"
import { randomBytes } from "../vault/crypto"
import { VaultError } from "../vault/errors"
import type { Branch, HdRecord, KeyEntry, TeeRemoteState } from "../vault/format"
import { branchOfPath } from "../vault/format"
import {
  DERIVATION_SCHEME,
  deriveEvmKeyFromRoot,
  deriveSolanaKey,
  entropyFromPhrase,
  PHRASE_WORDS,
  pathForBranch,
  ROOT_ENTROPY_BYTES,
} from "../vault/hd"
import { wipe, withSecret } from "../vault/hygiene"
import { completeLinkedWalletRead, type LinkedWalletRow } from "../vault/linked-wallets"
import {
  APPLE_ACCOUNT_NOTICE,
  assertOwnPassphraseAcceptable,
  GENERATED_WORD_COUNT,
  generatedEntropyBits,
  generatePassphrase,
  strengthFor,
} from "../vault/passphrase"
import { sidecarPath } from "../vault/sidecar"
import { closeVault, commitVault, fileExists, freshKeyId, sealKeyBlob, type UnlockedVault } from "../vault/store"
import { verifyVaultIntegrity } from "../vault/verify"
import {
  askForOwnPassphrase,
  nonDefaultVaultFooter,
  refuseEnvPassphrase,
  requireTty,
  requireVaultRaw,
  runVaultCommand,
  unlockInteractively,
  usage,
  vaultAlreadyExists,
  vaultPathFor,
  writeJson,
} from "./vault-support"

/** CC-11: the scan stops after twenty consecutive indices with nothing on chain. */
const GAP_LIMIT = 20
/** A scan still needs a ceiling, so a fixture RPC answering "used" forever cannot loop. */
const SCAN_CEILING = 500

export async function vaultRestore(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--keystore", "--count", "--tee-count", "--external-count", "--evm-count", "--rpc-url"],
    booleanFlags: ["--phrase", "--own-passphrase"],
    pathFlags: ["--keystore"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length > 0) return usage(ctx, `Unexpected argument: ${parsed.positionals[0]}`)
  if (!parsed.booleans.has("--phrase"))
    return usage(ctx, "--phrase is required: this command restores from a 24-word recovery phrase.")
  // BE-355 (D7): the gap scan reads `--rpc-url` ONLY. Not the public default, and not
  // `CANDLE_SOLANA_RPC_URL` or the profile's `rpcUrl` either: both are ambient, and a scan that
  // sends every derived address to an endpoint stays an explicit act on this command line. The
  // flag is validated by the shared rule (D1), before any prompt.
  const rpcUrlFlag = parsed.values["--rpc-url"]
  if (rpcUrlFlag !== undefined) {
    const fault = validateSolanaRpcUrl(rpcUrlFlag, "--rpc-url")
    if (fault !== undefined) return usage(ctx, fault)
  }
  if (!refuseEnvPassphrase(ctx)) return 1
  if (ctx.json) {
    return usage(
      ctx,
      "Restoring reads a recovery phrase from a hidden prompt and has no --json form. Run it without --json, on a terminal.",
    )
  }
  if (!requireTty(ctx, "vault restore")) return 1

  const counts = parseCounts(
    parsed.values["--count"],
    parsed.values["--tee-count"],
    parsed.values["--external-count"],
    parsed.values["--rpc-url"],
    parsed.values["--evm-count"],
  )
  if ("error" in counts) return usage(ctx, counts.error)

  const { deps } = ctx
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const path = resolvedVault.path

  return runVaultCommand(ctx, async ({ hold }) => {
    if (await fileExists(path)) {
      throw vaultAlreadyExists(
        ctx,
        resolvedVault,
        "Restoring builds a new vault and never merges into one. Move the existing file aside first.",
      )
    }
    const sidecarExisted = await fileExists(sidecarPath(path))

    // D8 (BE-241): said BEFORE anything has been typed. The operator in BE-235 item 5 typed the
    // SOURCE vault's passphrase at the copy-back prompt, the AD-6 gate refused correctly, nothing
    // was written, and it read as being stuck. The gate is right; what was missing was this line.
    deps.stdout.write(`${RESTORE_NEW_PASSPHRASE_NOTICE}\n\n`)
    deps.stdout.write(
      `Type your ${PHRASE_WORDS}-word recovery phrase. It is not echoed, and nothing is written until its checksum checks out.\n`,
    )
    const typed = await deps.promptSecret(`Recovery phrase (${PHRASE_WORDS} words, input hidden): `)
    // A checksum failure writes nothing and the message never echoes a word back.
    const entropy = entropyFromPhrase(typed)

    const vault = await withSecret(entropy, async (rootEntropy) => {
      if (rootEntropy.length !== ROOT_ENTROPY_BYTES) {
        throw new VaultError(
          "PHRASE_INVALID",
          `That phrase carries ${rootEntropy.length} bytes of entropy, not ${ROOT_ENTROPY_BYTES}.`,
          { suggestion: "Nothing was written. Check the word count and order, then run it again." },
        )
      }
      // D8: the choice is offered HERE -- after the phrase is validated, before the passphrase
      // step -- so an answer typed wrong costs one re-prompt rather than retyping 24 words.
      const own = parsed.booleans.has("--own-passphrase") || (await askForOwnPassphrase(ctx, RESTORE_PASSPHRASE_PROMPT))
      const passphrase = own ? await collectOwn(ctx) : await collectGenerated(ctx)
      const ownPassphrase = own
      // A NEW vaultId and a NEW DEK: nothing from the old vault is needed, and nothing from it is
      // reused, so a leaked copy of the old file gains nothing from this one existing.
      //
      // The discovery record is seeded into the FIRST write, not left for the commit below: from
      // the moment this file exists it is a restored vault, and `new-key` refuses in it. A crash
      // between this write and the commit therefore leaves a file that cannot allocate, rather
      // than one with a fresh-looking `hd` that would hand out index 0 of a root whose history is
      // unknown (CC-11).
      return createVault(
        {
          path,
          passphrase,
          strength: strengthFor(ownPassphrase),
          rootEntropy,
          hd: restoreSeedHd(counts, new Date(deps.now()).toISOString()),
          notice: (line) => deps.stderr.write(line),
        },
        deps,
      )
    })
    hold(vault)

    // Everything from here to the commit runs against a file that exists but holds no entry yet.
    // A failure in between must not strand it: the operator would be left with a vault that lists
    // nothing, and a retry would refuse because the path is taken. So a thrown failure before the
    // commit removes exactly what this run created (the file, and the sidecar if this run made it)
    // and says so, and the retry starts clean. Nothing in the removed file is irreplaceable: its
    // root came from the phrase the operator still holds, and its passphrase was minted seconds ago.
    let committed = false
    try {
      // CC-07's verifier runs on the vault this command has just built, BEFORE anything else, so
      // the three callers of that function cannot drift and a restore that produced an unopenable
      // root is caught here rather than on the day it is needed.
      await verifyVaultIntegrity(vault)
      deps.stdout.write(`\nNew vault at ${path}, verified in full (all eight steps).\n`)
      deps.stdout.write(`${APPLE_ACCOUNT_NOTICE}\n\n`)

      const solana = rpcUrlFlag === undefined ? undefined : solanaClientFor(ctx, flagEndpoint(rpcUrlFlag))

      // Step 1: derive every index inside the two bounds and build an address map IN MEMORY.
      const derived = await deriveWithinBounds(ctx, vault, counts, solana)

      // Step 2: the complete linked-wallet read. A partial or failed read is not a short answer;
      // it stops the discovery step entirely, because a list that happens to be empty would
      // otherwise read as "never imported" and let a remotely exposed key be presented as cold.
      const apiKey = await resolveApiKey(deps, ctx.profile)
      let matches: MatchOutcome = {
        matched: [],
        unmatched: [],
        account: undefined,
        complete: false,
        reason: "no API key is stored, so no exposure could be read",
      }
      if (apiKey !== undefined) {
        matches = await matchAgainstAccount(ctx, apiKey, derived)
      } else {
        deps.stderr.write("No API key is stored for this profile, so this restore read no exposure at all.\n")
      }

      const outcome = await writeRestoredIndex(ctx, vault, derived, matches, counts)
      committed = true
      const config = await deps.readConfig()
      const ambient =
        Boolean(deps.env[RPC_URL_ENV]?.trim()) ||
        Boolean(ctx.profile !== undefined && config.profiles?.[ctx.profile]?.rpcUrl?.trim())
      const result = reportRestore(ctx, vault, derived, matches, outcome, counts, ambient)
      // D8/D10, last: the moment the non-default vault is born is the moment to say that every
      // later vault command needs the flag, or the variable that moves every file together. Human
      // mode only, which is every mode here: restore has no --json form at all.
      const footer = nonDefaultVaultFooter(resolvedVault)
      if (footer !== undefined) deps.stdout.write(footer)
      return result
    } catch (error) {
      if (!committed) await discardIncompleteRestore(ctx, path, sidecarExisted)
      throw error
    }
  })
}

/**
 * The `hd` record a restore writes FIRST, before any entry exists. `discovery` is present with
 * `complete: false` from the first byte on disk, which is the whole of what refuses allocation
 * (CC-11); the commit later replaces the counters and the account, never the presence.
 */
export function restoreSeedHd(counts: Pick<Counts, "requested">, restoredAt: string): HdRecord {
  return freshHdRecord({
    discovery: {
      restoredAt,
      account: "",
      requestedCounts: counts.requested,
      highestMatched: { solanaVault: -1, solanaTee: -1, solanaExternal: -1 },
      complete: false,
    },
  })
}

/**
 * Removes the file this run created and did not finish, so the path is free for a retry. The
 * sidecar goes only if this run made it: one left by a vault that was moved aside is that vault's
 * bookkeeping, not ours. Best effort on the removal itself, and the outcome is stated either way.
 */
async function discardIncompleteRestore(ctx: CommandContext, path: string, sidecarExisted: boolean): Promise<void> {
  try {
    await rm(path, { force: true })
    if (!sidecarExisted) await rm(sidecarPath(path), { force: true })
    ctx.deps.stderr.write(
      `The vault this run had written at ${path} was removed because the restore did not complete, so a retry starts clean.\n`,
    )
  } catch {
    ctx.deps.stderr.write(
      `The vault this run had written at ${path} could not be removed; it holds no key entry, and a retry needs it moved aside.\n`,
    )
  }
}

// ── Bounds and derivation ─────────────────────────────────────────────────────────────────────

/** The three Solana branches a restore derives, in the order they are derived and reported. */
const RESTORED_BRANCHES = ["solanaVault", "solanaTee", "solanaExternal"] as const
type RestoredBranch = (typeof RESTORED_BRANCHES)[number]

interface Counts {
  /** undefined means "gap scan this branch", which is only reachable with an `--rpc-url`. */
  solanaVault: number | undefined
  solanaTee: number | undefined
  /** R6: the external branch, on exactly the same rules as the other two. */
  solanaExternal: number | undefined
  /** Phase 4a: EVM indices `0..evm-1`. Defaults to 0, never scanned, never recorded in `discovery`. */
  evm: number
  requested: Record<RestoredBranch, number>
}

/**
 * CC-11's defaults, which are fiddlier than they look and are therefore in one function: each
 * count defaults to 1 when it is omitted and ANOTHER is given, and all default to 1 when none is
 * given and no `--rpc-url` is supplied. With an `--rpc-url` and no explicit count for a branch,
 * that branch is gap-scanned. R6 adds `--external-count` as a third count on the same rules.
 */
export function parseCounts(
  count: string | undefined,
  teeCount: string | undefined,
  externalCount: string | undefined,
  rpcUrl: string | undefined,
  evmCount?: string,
): Counts | { error: string } {
  const parse = (raw: string | undefined, flag: string): number | undefined | { error: string } => {
    if (raw === undefined) return undefined
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 0) return { error: `${flag} must be a whole number, zero or greater.` }
    return value
  }
  const vaultCount = parse(count, "--count")
  if (typeof vaultCount === "object" && vaultCount !== null) return vaultCount
  const teeParsed = parse(teeCount, "--tee-count")
  if (typeof teeParsed === "object" && teeParsed !== null) return teeParsed
  const externalParsed = parse(externalCount, "--external-count")
  if (typeof externalParsed === "object" && externalParsed !== null) return externalParsed
  const evmParsed = parse(evmCount, "--evm-count")
  if (typeof evmParsed === "object" && evmParsed !== null) return evmParsed

  const allOmitted = vaultCount === undefined && teeParsed === undefined && externalParsed === undefined
  const scan = rpcUrl !== undefined
  const resolve = (value: number | undefined): number | undefined => {
    if (value !== undefined) return value
    // Omitted: gap-scan it when an RPC was given, otherwise fall back to 1.
    return scan ? undefined : 1
  }
  const solanaVault = allOmitted && !scan ? 1 : resolve(vaultCount)
  const solanaTee = allOmitted && !scan ? 1 : resolve(teeParsed)
  const solanaExternal = allOmitted && !scan ? 1 : resolve(externalParsed)
  return {
    solanaVault,
    solanaTee,
    solanaExternal,
    // The EVM count takes no part in the Solana defaulting above: 0 unless asked for (D7).
    evm: evmParsed ?? 0,
    requested: { solanaVault: solanaVault ?? -1, solanaTee: solanaTee ?? -1, solanaExternal: solanaExternal ?? -1 },
  }
}

interface DerivedEntry {
  branch: Branch
  index: number
  address: string
  path: string
  keyId: string
  blob: Awaited<ReturnType<typeof sealKeyBlob>>
}

interface DerivedSet {
  entries: DerivedEntry[]
  /**
   * The vault- and TEE-branch entries, which the linked-wallet read is matched against, and
   * (Phase 4a) the EVM entries keyed by their lowercased address, since a Hood row may carry
   * either spelling of one address.
   */
  byAddress: Map<string, DerivedEntry>
  /**
   * The external-branch entries, kept apart (R6): an external key is never registered with Candle,
   * so the linked-wallet read says nothing about it and cannot raise its exposure. It is recovered
   * by derivation inside the bound, and by nothing else.
   */
  externalByAddress: Map<string, DerivedEntry>
  scanStoppedAt: Partial<Record<Branch, number>>
}

/**
 * Derives each branch inside its bound, sealing each key as it goes so exactly one derived secret
 * is live at a time. The root plaintext is held for the whole pass, which is unavoidable, and is
 * zeroed the moment the pass ends.
 */
async function deriveWithinBounds(
  ctx: CommandContext,
  vault: UnlockedVault,
  counts: Counts,
  solana: SolanaClient | undefined,
): Promise<DerivedSet> {
  const { decryptRoot } = await import("../vault/store")
  const root = await decryptRoot(vault)
  const set: DerivedSet = { entries: [], byAddress: new Map(), externalByAddress: new Map(), scanStoppedAt: {} }
  try {
    for (const branch of RESTORED_BRANCHES) {
      const bound = counts[branch]
      if (bound !== undefined) {
        for (let index = 0; index < bound; index++) {
          set.entries.push(await deriveOne(vault, root, branch, index))
        }
        continue
      }
      if (solana === undefined) continue
      // The gap scan. Every index it derives is added; the ones it steps over prove nothing. The
      // host line prints before the first read (D2); a read still rate-limited after the client's
      // retry stops here with RPC_RATE_LIMITED (D3), where any failed scan read stops today.
      let consecutiveUnused = 0
      let index = 0
      for (; index < SCAN_CEILING && consecutiveUnused < GAP_LIMIT; index++) {
        const entry = await deriveOne(vault, root, branch, index)
        set.entries.push(entry)
        const used = await solana.read(() => addressLooksUsed(solana.rpc, entry.address))
        consecutiveUnused = used ? 0 : consecutiveUnused + 1
      }
      set.scanStoppedAt[branch] = index
      ctx.deps.stdout.write(
        `Gap scan on ${branch} stopped at index ${index - 1} after ${GAP_LIMIT} consecutive indices with no balance, no token account and no signature history.\n`,
      )
    }
    // Phase 4a (D7): the EVM branch, bounded by `--evm-count` and never scanned.
    for (let index = 0; index < counts.evm; index++) {
      set.entries.push(await deriveOneEvm(vault, root, index))
    }
  } finally {
    wipe(root)
  }
  for (const entry of set.entries) {
    if (entry.branch === "solanaExternal") set.externalByAddress.set(entry.address, entry)
    else if (entry.branch === "evm") set.byAddress.set(entry.address.toLowerCase(), entry)
    else set.byAddress.set(entry.address, entry)
  }
  return set
}

async function deriveOneEvm(vault: UnlockedVault, root: Uint8Array, index: number): Promise<DerivedEntry> {
  const derived = await deriveEvmKeyFromRoot(root, index)
  try {
    const keyId = freshKeyId()
    return {
      branch: "evm",
      index,
      address: derived.address,
      path: derived.path,
      keyId,
      blob: await sealKeyBlob(vault, keyId, derived.secret),
    }
  } finally {
    wipe(derived.secret)
  }
}

/** A row's address as the derived map keys it: lowercased when it is an EVM address. */
function lookupKey(address: string): string {
  return looksLikeEvmAddress(address) ? address.toLowerCase() : address
}

async function deriveOne(vault: UnlockedVault, root: Uint8Array, branch: Branch, index: number): Promise<DerivedEntry> {
  const path = pathForBranch(branch, index)
  const derived = await deriveSolanaKey(root, path)
  try {
    const keyId = freshKeyId()
    return {
      branch,
      index,
      address: derived.address,
      path,
      keyId,
      blob: await sealKeyBlob(vault, keyId, derived.secret64),
    }
  } finally {
    wipe(derived.secret64)
  }
}

/**
 * "Used" means anything on chain: lamports, a token account under EITHER program (R5), or a
 * signature in its history. An index whose only holding is a Token-2022 account used to read as
 * unused, which would end the twenty-index gap scan early and lose every key past it.
 */
async function addressLooksUsed(rpc: SolanaRpc, address: string): Promise<boolean> {
  if ((await rpc.getBalance(address)) > 0n) return true
  if ((await rpc.getTokenAccountsByOwner(address, TOKEN_PROGRAM_ID)).length > 0) return true
  if ((await rpc.getTokenAccountsByOwner(address, TOKEN_2022_PROGRAM_ID)).length > 0) return true
  return rpc.hasSignatureHistory(address)
}

// ── Matching against the account ──────────────────────────────────────────────────────────────

interface MatchOutcome {
  matched: Array<{ entry: DerivedEntry; row: LinkedWalletRow }>
  /** Listed addresses this restore did not derive: the ambiguity CC-11 refuses to resolve. */
  unmatched: string[]
  /**
   * Listed addresses that ARE external-branch keys of this root (R6). Not a match (the read cannot
   * raise an external key's exposure) and not the CC-11 ambiguity either; reported in words.
   */
  externalListed?: string[]
  account: string | undefined
  complete: boolean
  reason?: string
  /** Set when the read completed but the operator did not confirm the account it belongs to. */
  refused?: "EXPOSURE_ACCOUNT_MISMATCH"
}

async function matchAgainstAccount(ctx: CommandContext, apiKey: string, derived: DerivedSet): Promise<MatchOutcome> {
  const read = await completeLinkedWalletRead(ctx, apiKey)
  if (!read.complete) {
    return {
      matched: [],
      unmatched: [],
      account: read.account || undefined,
      complete: false,
      reason: read.incompleteReason,
    }
  }

  // The account is displayed and its last six typed BEFORE any re-flagging: re-flagging one vault
  // against a different account's history would be both wrong and silent.
  ctx.deps.stdout.write(`\nThis profile acts as account ${read.account}.\n`)
  const typed = (
    await ctx.deps.promptLine(
      `Type the last six characters of that account to confirm before any exposure is recorded: `,
    )
  ).trim()
  if (typed !== read.account.slice(-6)) {
    // Refused, as a stop to the exposure step and not to the restore: the vault is still
    // committed below with every derived entry, its discovery record and no exposure at all, the
    // same shape an incomplete read leaves, so nothing half-built is on disk and the named exit
    // is `reconcile-exposure` on the right profile rather than a second restore against a path
    // that is now taken. The account is not recorded, since it was not confirmed.
    return {
      matched: [],
      unmatched: [],
      account: undefined,
      complete: false,
      reason: "that is not the last six characters of the account this profile acts as, so it was not confirmed",
      refused: "EXPOSURE_ACCOUNT_MISMATCH",
    }
  }

  const matched: MatchOutcome["matched"] = []
  const unmatched: string[] = []
  const externalListed: string[] = []
  for (const row of read.rows) {
    if (typeof row.address !== "string") continue
    const entry = derived.byAddress.get(lookupKey(row.address))
    if (entry) matched.push({ entry, row })
    else if (derived.externalByAddress.has(row.address)) externalListed.push(row.address)
    else unmatched.push(row.address)
  }
  return { matched, unmatched, externalListed, account: read.account, complete: true }
}

// ── Writing the restored index ────────────────────────────────────────────────────────────────

interface RestoreOutcome {
  entries: KeyEntry[]
  hd: HdRecord
}

async function writeRestoredIndex(
  ctx: CommandContext,
  vault: UnlockedVault,
  derived: DerivedSet,
  matches: MatchOutcome,
  counts: Counts,
): Promise<RestoreOutcome> {
  const now = new Date(ctx.deps.now()).toISOString()
  const matchByAddress = new Map(matches.matched.map((match) => [match.entry.address, match.row]))

  const entries: KeyEntry[] = derived.entries.map((entry) => {
    const row = matchByAddress.get(entry.address)
    if (entry.branch === "evm") {
      // Phase 4a (D7): an EVM entry is written as an EVM vault key, `exposureUnknown` like every
      // recovered key. A matching linked-wallet row (a Hood wallet this account imported) ADDS
      // `everRemoteExposed`; it is not passed through `teeFieldsFor`, because that mapping is the
      // Solana TEE lifecycle and an EVM key has none until 4b.
      return {
        id: entry.keyId,
        chain: "evm",
        curve: "secp256k1",
        address: entry.address,
        label: row?.label ?? `evm-${entry.index}`,
        createdAt: now,
        role: "vault",
        origin: "derived",
        derivation: { scheme: EVM_DERIVATION_SCHEME, path: entry.path },
        exposure: { everRemoteExposed: row !== undefined, everExported: false, exposureUnknown: true },
      }
    }
    const external = entry.branch === "solanaExternal"
    const base: KeyEntry = {
      id: entry.keyId,
      chain: "solana",
      curve: "ed25519",
      address: entry.address,
      label: row?.label ?? `${external ? "external" : entry.branch === "solanaTee" ? "tee" : "key"}-${entry.index}`,
      createdAt: now,
      // R6: an external-branch key is recovered AS an external key, on which every non-allocating
      // command keeps working (`vault fund`, `external sweep`, `candle sign`, listing, backup).
      role: external ? "external" : "vault",
      origin: "derived",
      derivation: { scheme: DERIVATION_SCHEME, path: entry.path },
      // Every derived entry a restore creates is exposureUnknown, permanently. A match ADDS
      // `everRemoteExposed` on top; nothing ever clears either.
      exposure: { everRemoteExposed: false, everExported: false, exposureUnknown: true },
    }
    if (row === undefined) return base
    return { ...base, ...teeFieldsFor(row, ctx), exposure: { ...base.exposure, everRemoteExposed: true } }
  })

  // `nextIndex` lands one past the highest index this restore derived OR matched, with no reserve.
  // In a restored vault it is a record of what was recovered, not a license to allocate, and the
  // allocation refusal rather than this number is what enforces CC-10's no-reuse contract.
  // The EVM branch has no scan and no reserve either: `nextIndex.evm` is exactly `--evm-count`.
  const highest: Record<Branch, number> = { solanaVault: -1, solanaTee: -1, solanaExternal: -1, evm: -1 }
  const exposed: Record<Branch, number[]> = { solanaVault: [], solanaTee: [], solanaExternal: [], evm: [] }
  for (const entry of entries) {
    const located = entry.derivation ? branchOfPath(entry.derivation.path) : undefined
    if (located === undefined) continue
    highest[located.branch] = Math.max(highest[located.branch], located.index)
    if (entry.exposure.everRemoteExposed) exposed[located.branch].push(located.index)
  }
  // The external branch is never matched (R6), so its highest match stays -1 by construction.
  const highestMatched = { solanaVault: -1, solanaTee: -1, solanaExternal: -1 }
  for (const match of matches.matched) {
    if (match.entry.branch === "solanaVault")
      highestMatched.solanaVault = Math.max(highestMatched.solanaVault, match.entry.index)
    if (match.entry.branch === "solanaTee")
      highestMatched.solanaTee = Math.max(highestMatched.solanaTee, match.entry.index)
  }

  const hd: HdRecord = {
    scheme: "bip39-24/slip10",
    nextIndex: {
      solanaVault: highest.solanaVault + 1,
      solanaTee: highest.solanaTee + 1,
      solanaExternal: highest.solanaExternal + 1,
      evm: highest.evm + 1,
    },
    rootExported: false,
    exposedIndexes: {
      solanaVault: exposed.solanaVault.sort((a, b) => a - b),
      solanaTee: exposed.solanaTee.sort((a, b) => a - b),
      solanaExternal: exposed.solanaExternal.sort((a, b) => a - b),
      evm: exposed.evm.sort((a, b) => a - b),
    },
    // Present, with `complete: false`, permanently. Its presence is what refuses allocation.
    discovery: {
      restoredAt: now,
      account: matches.account ?? "",
      requestedCounts: counts.requested,
      highestMatched,
      complete: false,
    },
    ...(matches.complete ? { exposureReconciledAt: now } : {}),
  }

  await commitVault(vault, { index: { hd, entries }, addKeys: derived.entries.map((entry) => entry.blob) }, ctx.deps)
  return { entries, hd }
}

/**
 * A matched address is a key this account imported, so it is a TEE wallet entry rather than a
 * vault key. CC-11 step 3 defers the lifecycle detail to CC-10, which ships in PR C; what this
 * release can justify from a linked-wallet row alone is the mapping below, and CC-01's per-value
 * table is what it is checked against.
 *
 *   swept, with a pinned destination  -> `retired`   (the sweep that retired it had a destination)
 *   a pinned destination              -> `enabled`   (all four required fields are present; a
 *                                                     revoked row is recorded as `remoteState`,
 *                                                     never as a lifecycle, so a revoked-but-funded
 *                                                     grant reopens `enabled` + `quarantined`)
 *   no pinned destination             -> `stranded`  (no row ever pinned one; a later sweep takes
 *                                                     `--sweep-to`, and `linkedWalletId` is absent
 *                                                     by definition for that value)
 */
function teeFieldsFor(row: LinkedWalletRow, ctx: CommandContext): Partial<KeyEntry> {
  const remoteState: TeeRemoteState =
    row.sweptAt !== undefined ? "swept" : row.revokedAt !== undefined ? "quarantined" : "enabled"
  const grantIdentity = {
    account: "",
    apiBaseUrl: ctx.apiUrl,
    // The row itself is the authoritative answer, which is what `recorded-at-operation` means.
    source: "recorded-at-operation" as const,
  }
  const common = {
    network: "solana-mainnet" as const,
    ...(row.vaultDestination !== undefined ? { vaultDestination: row.vaultDestination } : {}),
    ...(row.boundKeyPrefix !== undefined ? { boundKeyPrefix: row.boundKeyPrefix } : {}),
    ...(row.remoteAuthority !== undefined ? { remoteAuthority: row.remoteAuthority } : {}),
    ...(row.sweptAt !== undefined ? { sweptAt: new Date(row.sweptAt).toISOString() } : {}),
    remoteState,
  }
  if (row.sweptAt !== undefined && row.vaultDestination !== undefined) {
    return { role: "tee-wallet", tee: { ...common, lifecycle: "retired" } }
  }
  if (row.vaultDestination !== undefined) {
    return { role: "tee-wallet", linkedWalletId: row._id, tee: { ...common, lifecycle: "enabled", grantIdentity } }
  }
  // `stranded` forbids `linkedWalletId`, so the row id is reported in the output rather than
  // recorded on the entry; PR C's reconciliation is what adopts a destination for it.
  return { role: "tee-wallet", tee: { ...common, lifecycle: "stranded", grantIdentity } }
}

function reportRestore(
  ctx: CommandContext,
  vault: UnlockedVault,
  derived: DerivedSet,
  matches: MatchOutcome,
  outcome: RestoreOutcome,
  counts: Counts,
  ambientSolanaEndpoint: boolean,
): number {
  const { deps } = ctx
  deps.stdout.write(`\nRecovered ${outcome.entries.length} address(es) from the phrase.\n`)
  for (const entry of outcome.entries) {
    deps.stdout.write(
      `  ${entry.address}  ${entry.derivation?.path}  ${entry.role}${entry.exposure.everRemoteExposed ? "  (this account imported it)" : ""}\n`,
    )
  }
  deps.stdout.write(
    `\nEvery one of them is recorded with an unknown history and stays that way: this phrase may have been restored under another account, under another deployment, or outside Candle entirely, and no read can rule that out.\n`,
  )
  deps.stdout.write(
    `This vault does not allocate. \`vault new-key\`, \`vault promote --from\` and \`candle external new\` refuse here; the exit is \`candle vault init\` for a fresh root and \`candle vault transfer\` to move funds across.\n`,
  )
  deps.stdout.write(
    `The Phase 1 TEE wallet store was not read, and no migrated-tee entry was restored: the phrase does not restore those keys, and the vault file plus a factor does.\n`,
  )

  let scanHint = false
  for (const branch of RESTORED_BRANCHES) {
    const bound = counts[branch]
    if (bound === undefined) {
      deps.stdout.write(`  ${branch}: gap-scanned to index ${(derived.scanStoppedAt[branch] ?? 1) - 1}\n`)
    } else if (bound <= 1) {
      scanHint = true
      deps.stdout.write(
        `  ${branch}: index 0 only. If you derived more, re-run with --count/--tee-count/--external-count, or with --rpc-url to gap-scan.\n`,
      )
    }
  }
  // BE-355 (D7): an ambient endpoint was set and deliberately not used for a scan; say so once.
  if (scanHint && ambientSolanaEndpoint) {
    deps.stdout.write(
      `A gap scan runs only with --rpc-url on this command; ${RPC_URL_ENV} and profile settings are not used for it.\n`,
    )
  }
  if (counts.evm === 0) {
    deps.stdout.write(
      `  evm: none. If this root has EVM keys, re-run with --evm-count <n>; the EVM branch is never gap-scanned.\n`,
    )
  } else {
    deps.stdout.write(`  evm: indices 0 to ${counts.evm - 1}, on m/44'/60'/n'/0/0.\n`)
  }
  if ((matches.externalListed?.length ?? 0) > 0) {
    // R6: an external key is never registered with Candle, so a listed address that is one of this
    // root's external keys is a fact worth stating, and not one the read is allowed to act on.
    deps.stdout.write(
      `\n${matches.externalListed?.length} address(es) this account imported are external-branch keys of this root. An external key is never registered with Candle, so this read does not flag them; their history is unknown like every other recovered key's.\n`,
    )
  }

  if (!matches.complete) {
    if (matches.refused !== undefined) deps.stdout.write(`\n${matches.refused}: the account was not confirmed.\n`)
    deps.stdout.write(`\nNo exposure was recorded: ${matches.reason ?? "the linked-wallet read did not complete"}.\n`)
    deps.stdout.write(
      matches.refused !== undefined
        ? `The vault was created, verified and written in full; nothing in it is flagged. Run \`candle vault reconcile-exposure\` once you are on the right profile.\n`
        : `A partial list that happened to be empty would read as good news, so nothing was flagged at all. Run \`candle vault reconcile-exposure\` once the read succeeds.\n`,
    )
    return 3
  }

  if (matches.unmatched.length > 0) {
    // The ambiguity, named as one. Two different things produce it and the CLI cannot tell them
    // apart, so it prints both explanations and the action each implies rather than prescribing an
    // open-ended ladder of higher-count restores, which for the second case has no top.
    deps.stdout.write(
      `\n${matches.unmatched.length} address(es) this account imported were NOT derived by this restore:\n`,
    )
    for (const address of matches.unmatched) deps.stdout.write(`  ${address}\n`)
    deps.stdout.write(
      `\nEither this root derives them at an index beyond the bounds used here, in which case a higher --count or --tee-count finds them;\n`,
    )
    deps.stdout.write(
      `or they are independent keys this root never produced (a \`wallets import\` of an outside keypair, or a Phase 1 \`tee new\` key), in which case no count will ever find them and only a vault backup plus a factor recovers them.\n`,
    )
    return 3
  }

  closeVault(vault)
  deps.stdout.write(
    `\n${matches.matched.length} of them are addresses this account imported, and each is flagged as remotely exposed.\n`,
  )
  return 0
}

// ── reconcile-exposure ────────────────────────────────────────────────────────────────────────

/**
 * Re-runs the complete read against the live API and ADDS exposure. It clears nothing, ever: an
 * entry that is `exposureUnknown` before the run is `exposureUnknown` after it, whatever the API
 * said. It refuses offline and on any incomplete read, because a partial list that happens to list
 * nothing would otherwise read as good news.
 */
export async function vaultReconcileExposure(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--keystore"],
    booleanFlags: ["--accept-older-copy"],
    pathFlags: ["--keystore"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length > 0) return usage(ctx, `Unexpected argument: ${parsed.positionals[0]}`)
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "vault reconcile-exposure")) return 1

  const { deps } = ctx
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const path = resolvedVault.path

  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await requireVaultRaw(ctx, resolvedVault)
    const vault = hold(
      (await unlockInteractively(ctx, path, raw, { acceptOlderCopy: parsed.booleans.has("--accept-older-copy") }))
        .vault,
    )

    const apiKey = await resolveApiKey(deps, ctx.profile)
    if (apiKey === undefined) {
      throw new VaultError(
        "VAULT_UNREADABLE",
        "No API key is stored for this profile, so there is no account to reconcile against.",
        {
          suggestion: "Run: candle auth login",
        },
      )
    }
    const read = await completeLinkedWalletRead(ctx, apiKey)
    if (!read.complete) {
      throw new VaultError(
        "VAULT_UNREADABLE",
        `The linked-wallet read did not complete: ${read.incompleteReason}. Nothing was flagged.`,
        {
          suggestion:
            "A partial list that happened to list nothing would read as good news, so no exposure is recorded from an incomplete read.",
        },
      )
    }

    // Re-flagging one vault against a DIFFERENT account's history would be both wrong and silent.
    const recorded = vault.index.hd.discovery?.account
    if (recorded !== undefined && recorded !== "" && recorded !== read.account) {
      throw new VaultError(
        "EXPOSURE_ACCOUNT_MISMATCH",
        `This vault recorded its discovery against account ${recorded}, and this profile acts as ${read.account}.`,
        { suggestion: "Switch profile and run it again. Nothing was flagged." },
      )
    }

    // Phase 4a: an EVM row may carry either spelling of one address, so EVM addresses compare lowercased.
    const listed = new Set(read.rows.map((row) => lookupKey(row.address)))
    // R6: the read cannot raise an external key's exposure; those entries pass through untouched.
    const entries = vault.index.entries.map((entry) =>
      entry.role !== "external" && listed.has(lookupKey(entry.address)) && !entry.exposure.everRemoteExposed
        ? { ...entry, exposure: { ...entry.exposure, everRemoteExposed: true } }
        : entry,
    )
    const added = entries.filter((entry, i) => entry !== vault.index.entries[i])

    const exposedIndexes = { ...vault.index.hd.exposedIndexes }
    for (const entry of entries) {
      const located = entry.derivation ? branchOfPath(entry.derivation.path) : undefined
      if (located === undefined || !entry.exposure.everRemoteExposed) continue
      if (!exposedIndexes[located.branch].includes(located.index)) {
        exposedIndexes[located.branch] = [...exposedIndexes[located.branch], located.index].sort((a, b) => a - b)
      }
    }

    const now = new Date(deps.now()).toISOString()
    const highestMatched = {
      ...(vault.index.hd.discovery?.highestMatched ?? { solanaVault: -1, solanaTee: -1, solanaExternal: -1 }),
    }
    for (const entry of entries) {
      if (!entry.exposure.everRemoteExposed) continue
      const located = entry.derivation ? branchOfPath(entry.derivation.path) : undefined
      if (located?.branch === "solanaVault")
        highestMatched.solanaVault = Math.max(highestMatched.solanaVault, located.index)
      if (located?.branch === "solanaTee") highestMatched.solanaTee = Math.max(highestMatched.solanaTee, located.index)
    }

    await commitVault(
      vault,
      {
        index: {
          hd: {
            ...vault.index.hd,
            exposedIndexes,
            exposureReconciledAt: now,
            ...(vault.index.hd.discovery ? { discovery: { ...vault.index.hd.discovery, highestMatched } } : {}),
          },
          entries,
        },
      },
      deps,
    )

    if (ctx.json) {
      writeJson(deps, {
        ok: true,
        account: read.account,
        listed: read.rows.length,
        newlyFlagged: added.length,
        cleared: 0,
        exposureReconciledAt: now,
      })
      return 0
    }
    deps.stdout.write(
      `Reconciled against account ${read.account}: ${read.rows.length} linked wallet(s) read, ${added.length} vault address(es) newly flagged as remotely exposed.\n`,
    )
    deps.stdout.write(
      `Nothing was cleared. This command only ever adds exposure: no read can establish that an address is cold.\n`,
    )
    return 0
  })
}

/**
 * D8's first line, printed before the phrase prompt. The words carry the KEYS; a passphrase belongs
 * to one file, so the restored vault's is new and the source vault's does not carry over.
 */
export const RESTORE_NEW_PASSPHRASE_NOTICE =
  "This builds a NEW vault from your 24 words, and it gets a NEW passphrase: the one that opened the vault the words came from does not carry over. The words carry the keys; a passphrase belongs to one file."

export const RESTORE_PASSPHRASE_PROMPT =
  "Passphrase for the new vault. Press Enter to have one generated (8 words, shown once, typed back), or type own to choose your own (16+ characters, typed twice, never shown): "

async function collectGenerated(ctx: CommandContext): Promise<string> {
  const passphrase = generatePassphrase()
  ctx.deps.stdout.write(
    `\nThe new vault's passphrase, ${GENERATED_WORD_COUNT} words, about ${generatedEntropyBits()} bits. Write it down now; it is shown once.\n\n    ${passphrase}\n\n`,
  )
  const typed = await ctx.deps.promptSecret("Type it back in full to confirm (input hidden): ")
  if (typed.trim() !== passphrase) {
    throw new VaultError("VAULT_UNLOCK_FAILED", "That did not match the passphrase shown above. Nothing was written.")
  }
  return passphrase
}

async function collectOwn(ctx: CommandContext): Promise<string> {
  const first = await ctx.deps.promptSecret(
    "Choose a passphrase for the new vault, 16 characters or more (input hidden): ",
  )
  assertOwnPassphraseAcceptable(first)
  const again = await ctx.deps.promptSecret("Type it again to confirm: ")
  if (again !== first)
    throw new VaultError("VAULT_UNLOCK_FAILED", "The passphrases did not match. Nothing was written.")
  return first
}

export { randomBytes }
