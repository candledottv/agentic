/**
 * Ember Phase 2 PR C (CC-06, CC-10, AD-4, AD-8): `candle vault promote`.
 *
 * Two modes: `--from` derives a fresh key on the TEE branch; `--in-place` imports one named vault
 * key at its own address after the AD-8 warning and typed confirmations.
 */
import { base58 } from "@scure/base"
import { parseArgs } from "../args"
import { type CommandContext, resolveApiKey } from "../deps"
import { errorEnvelope, renderError, suggestionFor, writeFailure, writeLocalFailure } from "../render"
import { createSolanaRpc, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../solana-lite"
import { assertRecoverableFactorExists } from "../vault/domains"
import { addressFromSecret64 } from "../vault/ed25519"
import { VaultError } from "../vault/errors"
import type { KeyEntry } from "../vault/format"
import { DERIVATION_SCHEME, deriveSolanaKey, solanaTeePath } from "../vault/hd"
import { wipe } from "../vault/hygiene"
import {
  AD8_WARNING,
  applyPromotion,
  assertColdVaultDestination,
  assertInPlacePreconditions,
  assertNotPinnedDestination,
  confirmAd8Acknowledgement,
  findEntryByLabelOrAddress,
  printAd8Warning,
} from "../vault/promote-support"
import { adoptGrantedRow, reconcileGrant } from "../vault/reconcile-grant"
import {
  closeVault,
  commitVault,
  decryptKey,
  decryptRoot,
  freshKeyId,
  readVaultRaw,
  sealKeyBlob,
  type UnlockedVault,
} from "../vault/store"
import { type ImportSubmitResponse, runImportFlow, TEE_PROFILE } from "../wallet-import-flow"
import { nextAllocatableIndex } from "./vault-new-key"
import {
  confirmLastSix,
  type OpenedVault,
  type ResolvedVaultPath,
  refuseEnvPassphrase,
  requireTty,
  requireVaultRaw,
  runVaultCommand,
  unlockInteractively,
  usage,
  vaultPathFor,
  writeJson,
} from "./vault-support"

export async function vaultPromote(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--from", "--in-place", "--sweep-to", "--label", "--rpc-url", "--keystore"],
    booleanFlags: ["--accept-unknown-exposure", "--accept-older-copy"],
    pathFlags: ["--keystore"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length > 0) return usage(ctx, `Unexpected argument: ${parsed.positionals[0]}`)

  const fromLabel = parsed.values["--from"]
  const inPlaceLabel = parsed.values["--in-place"]
  if (fromLabel !== undefined && inPlaceLabel !== undefined) {
    return usage(ctx, "Use either --from or --in-place, not both.")
  }
  if (fromLabel === undefined && inPlaceLabel === undefined) {
    return usage(
      ctx,
      "Usage: candle vault promote --from <vault-key-label> | --in-place <vault-key-label> --sweep-to <label> --rpc-url <url>",
    )
  }
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "vault promote")) return 1

  if (fromLabel !== undefined) {
    if (parsed.values["--sweep-to"] !== undefined) {
      return usage(ctx, "Fresh-key promote takes --from, not --sweep-to.")
    }
    return promoteFresh(ctx, parsed, fromLabel)
  }
  return promoteInPlace(ctx, parsed, inPlaceLabel as string)
}

async function promoteFresh(
  ctx: CommandContext,
  parsed: ReturnType<typeof parseArgs> & object,
  fromLabel: string,
): Promise<number> {
  if ("error" in parsed) return usage(ctx, parsed.error)
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const path = resolvedVault.path
  const acceptUnknown = parsed.booleans.has("--accept-unknown-exposure")

  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await requireVaultRaw(ctx, resolvedVault)
    const opened = await unlockInteractively(ctx, path, raw, {
      acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
    })
    let vault = hold(opened.vault)
    assertRecoverableFactorExists(vault.file.envelopes)

    if (vault.index.hd.discovery !== undefined) {
      throw new VaultError(
        "VAULT_ALLOCATION_BOUNDARY_UNKNOWN",
        "This vault was built by `vault restore --phrase`, so deriving a fresh TEE key is refused.",
        {
          suggestion:
            "Create a second vault with a fresh root (`candle vault init`) and move funds with `candle vault transfer`.",
        },
      )
    }

    const destination = assertColdVaultDestination(vault.index, fromLabel, {
      acceptUnknownExposure: acceptUnknown,
    })

    const teeIndex = nextAllocatableIndex(vault.index.hd.nextIndex.solanaTee, vault.index.hd.exposedIndexes.solanaTee)
    const derivationPath = solanaTeePath(teeIndex)
    const root = await decryptRoot(vault)
    let address: string
    let keyId: string
    let blob: Awaited<ReturnType<typeof sealKeyBlob>>
    let secret64: Uint8Array
    try {
      const derived = await deriveSolanaKey(root, derivationPath)
      try {
        address = derived.address
        keyId = freshKeyId()
        secret64 = Uint8Array.from(derived.secret64)
        blob = await sealKeyBlob(vault, keyId, derived.secret64)
      } finally {
        wipe(derived.secret64)
      }
    } finally {
      wipe(root)
    }

    const now = new Date(ctx.deps.now()).toISOString()
    const entry: KeyEntry = {
      id: keyId,
      chain: "solana",
      curve: "ed25519",
      address,
      label: parsed.values["--label"] ?? `tee-${teeIndex}`,
      createdAt: now,
      role: "tee-wallet",
      origin: "derived",
      derivation: { scheme: DERIVATION_SCHEME, path: derivationPath },
      exposure: { everRemoteExposed: true, everExported: false },
      tee: {
        network: "solana-mainnet",
        lifecycle: "import-pending",
        vaultDestination: destination.address,
        ...(acceptUnknown && destination.exposure?.exposureUnknown ? { destinationExposureAccepted: true } : {}),
      },
    }

    const exposedTee = [...vault.index.hd.exposedIndexes.solanaTee]
    if (!exposedTee.includes(teeIndex)) exposedTee.push(teeIndex)
    exposedTee.sort((a, b) => a - b)

    vault = hold(
      await commitVault(
        vault,
        {
          index: {
            hd: {
              ...vault.index.hd,
              nextIndex: { ...vault.index.hd.nextIndex, solanaTee: teeIndex + 1 },
              exposedIndexes: { ...vault.index.hd.exposedIndexes, solanaTee: exposedTee },
            },
            entries: [...vault.index.entries, entry],
          },
          addKeys: [blob],
        },
        ctx.deps,
      ),
    )

    await confirmLastSix(ctx, destination.address, "the sweep vault destination")

    const privateKey = base58.encode(secret64)
    wipe(secret64)
    const importCount = { n: 0 }
    const { exit: code } = await runTeeImport(ctx, {
      address,
      privateKey,
      label: entry.label,
      vaultDestination: destination.address,
      reopenForWrite: opened.reopen,
      resolvedVault,
      onImport: () => {
        importCount.n += 1
      },
    })
    if (code !== 0 && code !== 3) {
      // Pre-import write already left import-pending; operator can resume or demote.
      return code
    }

    vault = hold(await reopenFromDisk(path, opened.reopen, vault))
    const target = vault.index.entries.find((e) => e.id === keyId)
    if (target === undefined) {
      throw new VaultError("VAULT_INDEX_INVALID", `Entry ${keyId} missing after import.`)
    }
    // runTeeImport already committed success fields when ok; re-read for output.
    if (ctx.json) {
      writeJson(ctx.deps, {
        ok: true,
        mode: "fresh",
        address,
        label: entry.label,
        vaultDestination: destination.address,
        lifecycle: target.tee?.lifecycle,
        linkedWalletId: target.linkedWalletId ?? null,
        importCalls: importCount.n,
      })
    } else {
      ctx.deps.stdout.write(`Promoted fresh TEE wallet ${address} (sweep to ${destination.address}).\n`)
    }
    return code
  })
}

async function reopenFromDisk(
  path: string,
  reopen: OpenedVault["reopen"],
  previous: UnlockedVault,
): Promise<UnlockedVault> {
  closeVault(previous)
  const raw = await readVaultRaw(path)
  if (raw === null)
    throw new VaultError("VAULT_MISSING", `No vault at ${path}.`, {
      suggestion:
        "The vault was there when this run started. Check nothing moved or removed it, then: candle vault status",
    })
  return reopen(path, raw)
}

async function promoteInPlace(
  ctx: CommandContext,
  parsed: ReturnType<typeof parseArgs> & object,
  subjectLabel: string,
): Promise<number> {
  if ("error" in parsed) return usage(ctx, parsed.error)
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const path = resolvedVault.path
  const sweepTo = parsed.values["--sweep-to"]
  const rpcUrl = parsed.values["--rpc-url"]
  const acceptUnknown = parsed.booleans.has("--accept-unknown-exposure")

  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await requireVaultRaw(ctx, resolvedVault)
    const opened = await unlockInteractively(ctx, path, raw, {
      acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
    })
    let vault = hold(opened.vault)
    assertRecoverableFactorExists(vault.file.envelopes)

    const existing = findEntryByLabelOrAddress(vault.index, subjectLabel)
    if (existing === undefined) {
      throw new VaultError("PROMOTE_NOT_VAULT_KEY", `No entry matches ${subjectLabel}.`, {
        suggestion:
          "Nothing was written. Run: candle vault status (which lists every label and address this vault holds)",
      })
    }

    // Resume path: import-pending / local-candidate. Takes no --sweep-to.
    if (
      existing.role === "tee-wallet" &&
      (existing.tee?.lifecycle === "import-pending" || existing.tee?.lifecycle === "local-candidate")
    ) {
      if (sweepTo !== undefined) {
        return usage(ctx, "A resume of promote takes no --sweep-to (exit 2).")
      }
      const { exit } = await resumePromote(ctx, vault, existing, opened.reopen, path, hold, {
        confirmAccount: (account) => confirmLastSix(ctx, account, "that account"),
        confirmDestination: async (destination) => {
          try {
            await confirmLastSix(ctx, destination, "the server-reported vault destination")
            return true
          } catch {
            return false
          }
        },
      })
      return exit
    }

    if (sweepTo === undefined || rpcUrl === undefined) {
      return usage(
        ctx,
        "Usage: candle vault promote --in-place <label> --sweep-to <label> --rpc-url <url> [--label] [--accept-unknown-exposure]",
      )
    }

    // Preconditions 1-3 (first pass).
    const first = assertInPlacePreconditions(vault.index, subjectLabel, sweepTo, {
      acceptUnknownExposure: acceptUnknown,
    })
    if (first.resume) {
      return usage(ctx, "A resume of promote takes no --sweep-to (exit 2).")
    }

    // Holdings (step 4): display what the subject holds.
    await displayHoldings(ctx, rpcUrl, first.subject.address)

    // AD-8 warning BEFORE both typed confirmations (step 5 then 6).
    printAd8Warning(ctx)
    // Assert the normative block is the one CC-10 specifies (tests check substring coverage).
    if (!ctx.json) {
      // Already printed by printAd8Warning; keep AD8_WARNING referenced so it cannot drift unused.
      void AD8_WARNING
    }
    await confirmLastSix(ctx, first.subject.address, "the address being promoted")
    await confirmAd8Acknowledgement(ctx)

    // Re-open under the lock and re-run steps 1-3 before the write.
    vault = hold(await reopenFromDisk(path, opened.reopen, vault))
    const second = assertInPlacePreconditions(vault.index, subjectLabel, sweepTo, {
      acceptUnknownExposure: acceptUnknown,
    })
    if (second.resume) {
      throw new VaultError("PROMOTE_ALREADY_TEE_WALLET", "The entry changed under the lock; nothing was written.", {
        suggestion: "Run: candle vault status --unlock to see where the entry is now, then re-run promote to resume.",
      })
    }
    assertNotPinnedDestination(vault.index, second.subject.address)

    const now = new Date(ctx.deps.now()).toISOString()
    const subject = second.subject
    const destination = second.destination
    // The one mutation, shared with the batch preflight's projection (BE-285, D6): the entry moves
    // to `tee-wallet` / `import-pending` with its pin, and its vault-branch index is recorded as
    // exposed. `promotedEntry` in promote-support.ts is the only producer of that entry shape.
    vault = hold(
      await commitVault(
        vault,
        {
          index: applyPromotion(vault.index, subject, destination, {
            label: parsed.values["--label"],
            now,
            acceptUnknownExposure: acceptUnknown,
          }),
        },
        ctx.deps,
      ),
    )

    const secret = await decryptKey(vault, subject.id)
    let privateKey: string
    try {
      if (addressFromSecret64(secret) !== subject.address) {
        throw new VaultError("VAULT_VERIFY_FAILED", "Stored secret does not match the subject address.")
      }
      privateKey = base58.encode(secret)
    } finally {
      wipe(secret)
    }

    const { exit: code } = await runTeeImport(ctx, {
      address: subject.address,
      privateKey,
      label: parsed.values["--label"] ?? subject.label,
      vaultDestination: destination.address,
      reopenForWrite: opened.reopen,
      resolvedVault,
    })
    if (ctx.json) {
      const reopened = hold(await reopenFromDisk(path, opened.reopen, vault))
      const updated = reopened.index.entries.find((e) => e.id === subject.id)
      writeJson(ctx.deps, {
        ok: code === 0 || code === 3,
        mode: "in-place",
        address: subject.address,
        vaultDestination: destination.address,
        lifecycle: updated?.tee?.lifecycle ?? null,
        linkedWalletId: updated?.linkedWalletId ?? null,
      })
    } else if (code === 0 || code === 3) {
      ctx.deps.stdout.write(
        `Promoted ${subject.address} in place (sweep to ${destination.address}). This address never returns to cold.\n`,
      )
    }
    return code
  })
}

/**
 * A failure `runTeeImport` or `resumePromote` would have written, handed back instead when the
 * caller asked for `report: "return"` (BE-285, §4.7 item 3). The batch is the only writer of its
 * one `--json` document, so these functions must not write a second one on its path.
 */
export interface ReturnedFailure {
  code: string
  message: string
  suggestion?: string
}

export interface ResumeOutcome {
  exit: number
  /** Present only under `report: "return"`, when the resume did not complete. */
  failure?: ReturnedFailure
  /** What the adopted grant recorded, for a caller that reports it without re-reading the vault. */
  adopted?: { linkedWalletId?: string; remoteAuthority?: string }
  /** The vault as committed by a successful adoption, sharing the caller's DEK. */
  vault?: UnlockedVault
}

export interface ResumeConfirmations {
  /** Asserts the account a grant-less entry acts as; throws to refuse. `vault promote` types the last six. */
  confirmAccount: (account: string) => Promise<void>
  /** Confirms a server-reported destination (`adoptGrantedRow`'s callback); `false` declines. */
  confirmDestination: (destination: string) => Promise<boolean>
  /** Whether `adoptGrantedRow` writes its grant block and this function its account line. Default true. */
  announceGrant?: boolean
  /** Who writes the failure envelopes and the `--json` document. Default `"write"`: this function. */
  report?: "write" | "return"
}

export async function resumePromote(
  ctx: CommandContext,
  vault: UnlockedVault,
  entry: KeyEntry,
  reopen: OpenedVault["reopen"],
  path: string,
  hold: (v: UnlockedVault) => UnlockedVault,
  confirmations: ResumeConfirmations,
): Promise<ResumeOutcome> {
  const announceGrant = confirmations.announceGrant ?? true
  const report = confirmations.report ?? "write"
  const fail = (failure: ReturnedFailure, exit: number): ResumeOutcome => {
    if (report === "write") writeLocalFailure(ctx.deps, failure, ctx.json)
    return { exit, ...(report === "return" ? { failure } : {}) }
  }

  const apiKey = await resolveApiKey(ctx.deps, ctx.profile)
  if (!apiKey) {
    return fail(
      {
        code: "PROMOTE_RECONCILE_INCOMPLETE",
        message: "No API key is available; reconciliation cannot run.",
        suggestion: "Run: candle keys create",
      },
      1,
    )
  }

  let assertedAccount: string | undefined
  if (entry.tee?.grantIdentity === undefined) {
    const config = await ctx.deps.readConfig()
    const name = ctx.profile ?? config.activeProfile
    const cached = name !== undefined ? config.profiles?.[name]?.account : undefined
    if (cached === undefined || cached === "") {
      return fail(
        {
          code: "PROMOTE_RECONCILE_INCOMPLETE",
          message: "This entry has no grant identity, and this profile has no cached account to assert.",
        },
        1,
      )
    }
    if (announceGrant) ctx.deps.stdout.write(`This profile acts as account ${cached}.\n`)
    await confirmations.confirmAccount(cached)
    assertedAccount = cached
  }

  const verdict = await reconcileGrant(ctx, entry, { assertedAccount })
  if (verdict.kind === "unreadable") {
    return fail({ code: "PROMOTE_RECONCILE_INCOMPLETE", message: verdict.reason }, 1)
  }
  if (verdict.kind === "unresolved") {
    return fail(
      {
        code: "PROMOTE_OUTCOME_UNRESOLVED",
        message: `No authoritative grant or stranding record for ${entry.address}; the outcome is not established.`,
        suggestion: "Nothing was written. Demote under --emergency if funds must move, then promote a fresh key.",
      },
      3,
    )
  }
  if (verdict.kind === "strand-final") {
    const next = await commitVault(
      vault,
      {
        index: {
          hd: vault.index.hd,
          entries: vault.index.entries.map((e) =>
            e.id === entry.id
              ? {
                  ...e,
                  linkedWalletId: undefined,
                  tee: {
                    network: "solana-mainnet" as const,
                    lifecycle: "stranded" as const,
                    grantIdentity: {
                      account: verdict.account,
                      apiBaseUrl: ctx.apiUrl,
                      source: "recorded-at-operation" as const,
                    },
                    ...(e.tee?.vaultDestination ? { vaultDestination: e.tee.vaultDestination } : {}),
                  },
                }
              : e,
          ),
        },
      },
      ctx.deps,
    )
    hold(next)
    const stranded = `${entry.address} is stranded; it is never re-promotable.`
    if (report === "return") {
      return { exit: 1, failure: { code: "PROMOTE_ALREADY_TEE_WALLET", message: stranded }, vault: next }
    }
    if (ctx.json) writeJson(ctx.deps, { ok: false, lifecycle: "stranded", address: entry.address })
    else ctx.deps.stdout.write(`${stranded}\n`)
    return { exit: 1 }
  }

  // granted: adopt, import ZERO times.
  const adoption = await adoptGrantedRow(ctx, entry, verdict.row, verdict.account, {
    confirmDestination: confirmations.confirmDestination,
    announceGrant,
  })
  if (adoption.outcome === "declined") {
    return fail(
      {
        code: "GRANT_DESTINATION_UNRESOLVED",
        message: `Adoption of the server grant for ${entry.address} was declined; the entry was left unchanged.`,
      },
      1,
    )
  }
  const next = await commitVault(
    vault,
    {
      index: {
        hd: vault.index.hd,
        entries: vault.index.entries.map((e) => {
          if (e.id !== entry.id) return e
          return {
            ...e,
            ...(adoption.patch.linkedWalletId !== undefined ? { linkedWalletId: adoption.patch.linkedWalletId } : {}),
            tee: adoption.patch.tee ?? e.tee,
          }
        }),
      },
    },
    ctx.deps,
  )
  hold(next)
  const adopted = {
    linkedWalletId: adoption.patch.linkedWalletId ?? entry.linkedWalletId,
    remoteAuthority: adoption.patch.tee?.remoteAuthority ?? entry.tee?.remoteAuthority,
  }
  if (report === "return") {
    void reopen
    void path
    return { exit: 0, adopted, vault: next }
  }
  if (ctx.json) {
    writeJson(ctx.deps, {
      ok: true,
      mode: "resume",
      address: entry.address,
      lifecycle: "enabled",
      importCalls: 0,
    })
  } else {
    ctx.deps.stdout.write(`Resumed ${entry.address}: grant adopted; no re-import.\n`)
  }
  void reopen
  void path
  return { exit: 0, adopted }
}

async function displayHoldings(ctx: CommandContext, rpcUrl: string, address: string): Promise<void> {
  const rpc = createSolanaRpc(rpcUrl, ctx.deps.fetch)
  const observedAt = new Date(ctx.deps.now()).toISOString()
  const lamports = await rpc.getBalance(address)
  // Both programs (R5): a holdings read that showed only classic Token accounts would promote a
  // key while silently omitting whatever it holds under Token-2022.
  const tokens = [
    ...(await rpc.getTokenAccountsByOwner(address, TOKEN_PROGRAM_ID)),
    ...(await rpc.getTokenAccountsByOwner(address, TOKEN_2022_PROGRAM_ID)),
  ]
  ctx.deps.stdout.write(`Holdings at ${address} (observed ${observedAt}):\n`)
  ctx.deps.stdout.write(`  SOL   ${lamports} lamports\n`)
  for (const t of tokens) {
    const program = t.programId === TOKEN_PROGRAM_ID ? "token" : "token-2022"
    ctx.deps.stdout.write(`  token ${t.mint}  ${t.amountRaw} raw (${t.decimals} dp, ${program})\n`)
  }
  if (tokens.length === 0) ctx.deps.stdout.write(`  (no token accounts under either program)\n`)
}

export interface TeeImportOutcome {
  exit: number
  /** Present only under `report: "return"`, when the import did not complete. */
  failure?: ReturnedFailure
  /** The server's record of the import, when it completed. */
  submitted?: ImportSubmitResponse
  /**
   * The vault as committed after the import, when `closeReopened` is `false`: the caller owns the
   * DEK this object shares, and it needs the post-import bytes for its next write. Absent when the
   * re-opened vault was closed here.
   */
  vault?: UnlockedVault
}

export async function runTeeImport(
  ctx: CommandContext,
  opts: {
    address: string
    privateKey: string
    label?: string
    vaultDestination: string
    /**
     * Opens the vault's current bytes for the post-import commit. `vault promote` passes
     * `opened.reopen`, the factor path; the batch passes a held-key re-open that shares its DEK
     * (BE-285, D9), which is why `closeReopened` exists.
     */
    reopenForWrite: (path: string, raw: string) => Promise<UnlockedVault>
    /**
     * Whether the `finally` below closes what `reopenForWrite` returned. Default `true`: a vault
     * opened through the factor is this call's to wipe. The batch passes `false`, because its
     * re-open shares a DEK that `runVaultCommand` already owns and rows 2..n still need.
     */
    closeReopened?: boolean
    /** Who writes a failure. Default `"write"`: this function, as `vault promote` expects. */
    report?: "write" | "return"
    resolvedVault: ResolvedVaultPath
    onImport?: () => void
  },
): Promise<TeeImportOutcome> {
  const report = opts.report ?? "write"
  const closeReopened = opts.closeReopened ?? true
  const apiKey = await resolveApiKey(ctx.deps, ctx.profile)
  if (!apiKey) {
    const failure = { code: "NO_API_KEY", message: "No API key available.", suggestion: "Run: candle keys create" }
    if (report === "write") writeLocalFailure(ctx.deps, failure, ctx.json)
    return { exit: 1, ...(report === "return" ? { failure } : {}) }
  }
  opts.onImport?.()
  const flow = await runImportFlow({
    chain: "solana",
    address: opts.address,
    privateKey: opts.privateKey,
    label: opts.label,
    apiKey,
    apiUrl: ctx.apiUrl,
    deps: ctx.deps,
    profile: TEE_PROFILE,
    vaultDestination: opts.vaultDestination,
  })
  if (!flow.ok) {
    const failure = flow.failure
    if (failure.kind === "api") {
      const render = { apiUrl: ctx.apiUrl, authType: "key" as const }
      if (report === "write") {
        writeFailure(ctx.deps, failure.response, render, ctx.json)
        return { exit: 1 }
      }
      const suggestion = suggestionFor(failure.response, render)
      return {
        exit: 1,
        failure: {
          code: errorEnvelope(failure.response, render).code,
          message: renderError(failure.response, render),
          ...(suggestion ? { suggestion } : {}),
        },
      }
    }
    const local = {
      code: failure.kind === "signer-store" ? "SIGNER_STORE_FAILED" : "SIGNER_COMMIT_FAILED",
      message: `${opts.address}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`,
      suggestion: "The vault entry is import-pending. Fix the error and re-run promote to resume.",
    }
    if (report === "write") writeLocalFailure(ctx.deps, local, ctx.json)
    return { exit: 1, ...(report === "return" ? { failure: local } : {}) }
  }

  const submitted = flow.submitted
  const config = await ctx.deps.readConfig()
  const name = ctx.profile ?? config.activeProfile
  const account = name !== undefined ? (config.profiles?.[name]?.account ?? "") : ""
  const importedAt = new Date(ctx.deps.now()).toISOString()
  const raw = await requireVaultRaw(ctx, opts.resolvedVault)
  const vault = await opts.reopenForWrite(opts.resolvedVault.path, raw)
  let committed: UnlockedVault | undefined
  try {
    committed = await commitVault(
      vault,
      {
        index: {
          hd: vault.index.hd,
          entries: vault.index.entries.map((entry) => {
            if (entry.address !== opts.address) return entry
            return {
              ...entry,
              linkedWalletId: submitted.id,
              exposure: {
                everRemoteExposed: true,
                everExported: entry.exposure?.everExported === true,
                ...(entry.exposure?.exposureUnknown ? { exposureUnknown: true } : {}),
              },
              tee: {
                network: "solana-mainnet" as const,
                lifecycle: "enabled" as const,
                vaultDestination: opts.vaultDestination,
                ...(entry.tee?.promotedInPlaceAt ? { promotedInPlaceAt: entry.tee.promotedInPlaceAt } : {}),
                ...(entry.tee?.destinationExposureAccepted ? { destinationExposureAccepted: true } : {}),
                ...(submitted.boundKeyPrefix ? { boundKeyPrefix: submitted.boundKeyPrefix } : {}),
                remoteAuthority: submitted.remoteAuthority ?? "unknown",
                enabledAt: importedAt,
                grantIdentity: {
                  account,
                  apiBaseUrl: ctx.apiUrl,
                  source: "recorded-at-operation" as const,
                },
                remoteState: "enabled" as const,
                ...(entry.tee?.fundingReceipts ? { fundingReceipts: entry.tee.fundingReceipts } : {}),
                ...(entry.tee?.sweepPending ? { sweepPending: entry.tee.sweepPending } : {}),
                ...(entry.tee?.sweepReceipts ? { sweepReceipts: entry.tee.sweepReceipts } : {}),
              },
            }
          }),
        },
      },
      ctx.deps,
    )
  } finally {
    // The wipe stays in the `finally`, so a throw on the factor path still wipes; the flag is how
    // the batch says this DEK is not this call's to wipe (BE-285, §4.7 item 1).
    if (closeReopened) closeVault(vault)
  }

  return {
    exit: submitted.remoteAuthority === "verified-active" ? 0 : 3,
    submitted,
    ...(closeReopened ? {} : { vault: committed }),
  }
}
