/**
 * Ember Phase 2 PR C (CC-06, CC-10, AD-4, AD-8): `candle vault promote`.
 *
 * Two modes: `--from` derives a fresh key on the TEE branch; `--in-place` imports one named vault
 * key at its own address after the AD-8 warning and typed confirmations.
 */
import { base58 } from "@scure/base"
import { parseArgs } from "../args"
import { type CommandContext, resolveApiKey } from "../deps"
import { writeFailure, writeLocalFailure } from "../render"
import { createSolanaRpc, TOKEN_PROGRAM_ID } from "../solana-lite"
import { assertRecoverableFactorExists } from "../vault/domains"
import { addressFromSecret64 } from "../vault/ed25519"
import { VaultError } from "../vault/errors"
import type { KeyEntry } from "../vault/format"
import { DERIVATION_SCHEME, deriveSolanaKey, solanaTeePath } from "../vault/hd"
import { wipe } from "../vault/hygiene"
import {
  AD8_WARNING,
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
  unlockWithPassphrase,
} from "../vault/store"
import { runImportFlow, TEE_PROFILE } from "../wallet-import-flow"
import { nextAllocatableIndex } from "./vault-new-key"
import {
  confirmLastSix,
  type OpenedVault,
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
  const path = vaultPathFor(ctx, parsed)
  const acceptUnknown = parsed.booleans.has("--accept-unknown-exposure")

  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await requireVaultRaw(path)
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
    const code = await runTeeImport(ctx, {
      address,
      privateKey,
      label: entry.label,
      vaultDestination: destination.address,
      reopen: opened.reopen,
      vaultPath: path,
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
  if (raw === null) throw new VaultError("VAULT_MISSING", `No vault at ${path}.`)
  return reopen(path, raw)
}

async function promoteInPlace(
  ctx: CommandContext,
  parsed: ReturnType<typeof parseArgs> & object,
  subjectLabel: string,
): Promise<number> {
  if ("error" in parsed) return usage(ctx, parsed.error)
  const path = vaultPathFor(ctx, parsed)
  const sweepTo = parsed.values["--sweep-to"]
  const rpcUrl = parsed.values["--rpc-url"]
  const acceptUnknown = parsed.booleans.has("--accept-unknown-exposure")

  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await requireVaultRaw(path)
    const opened = await unlockInteractively(ctx, path, raw, {
      acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
    })
    let vault = hold(opened.vault)
    assertRecoverableFactorExists(vault.file.envelopes)

    const existing = findEntryByLabelOrAddress(vault.index, subjectLabel)
    if (existing === undefined) {
      throw new VaultError("PROMOTE_NOT_VAULT_KEY", `No entry matches ${subjectLabel}.`)
    }

    // Resume path: import-pending / local-candidate. Takes no --sweep-to.
    if (
      existing.role === "tee-wallet" &&
      (existing.tee?.lifecycle === "import-pending" || existing.tee?.lifecycle === "local-candidate")
    ) {
      if (sweepTo !== undefined) {
        return usage(ctx, "A resume of promote takes no --sweep-to (exit 2).")
      }
      return resumePromote(ctx, vault, existing, opened.reopen, path, hold)
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
      throw new VaultError("PROMOTE_ALREADY_TEE_WALLET", "The entry changed under the lock; nothing was written.")
    }
    assertNotPinnedDestination(vault.index, second.subject.address)

    const now = new Date(ctx.deps.now()).toISOString()
    const subject = second.subject
    const destination = second.destination
    const entries = vault.index.entries.map((entry) => {
      if (entry.id !== subject.id) return entry
      const next: KeyEntry = {
        ...entry,
        role: "tee-wallet",
        label: parsed.values["--label"] ?? entry.label,
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
      return next
    })
    // Exposure index: record this vault-branch index as exposed.
    const exposedVault = [...vault.index.hd.exposedIndexes.solanaVault]
    const derivedIndex = subject.derivation?.path.match(/m\/44'\/501'\/(\d+)'\/0'/)
    if (derivedIndex?.[1] !== undefined) {
      const idx = Number(derivedIndex[1])
      if (!exposedVault.includes(idx)) exposedVault.push(idx)
      exposedVault.sort((a, b) => a - b)
    }

    vault = hold(
      await commitVault(
        vault,
        {
          index: {
            hd: {
              ...vault.index.hd,
              exposedIndexes: { ...vault.index.hd.exposedIndexes, solanaVault: exposedVault },
            },
            entries,
          },
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

    const code = await runTeeImport(ctx, {
      address: subject.address,
      privateKey,
      label: parsed.values["--label"] ?? subject.label,
      vaultDestination: destination.address,
      reopen: opened.reopen,
      vaultPath: path,
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

async function resumePromote(
  ctx: CommandContext,
  vault: UnlockedVault,
  entry: KeyEntry,
  reopen: OpenedVault["reopen"],
  path: string,
  hold: (v: UnlockedVault) => UnlockedVault,
): Promise<number> {
  const apiKey = await resolveApiKey(ctx.deps, ctx.profile)
  if (!apiKey) {
    writeLocalFailure(
      ctx.deps,
      {
        code: "PROMOTE_RECONCILE_INCOMPLETE",
        message: "No API key is available; reconciliation cannot run.",
        suggestion: "Run: candle keys create",
      },
      ctx.json,
    )
    return 1
  }

  let assertedAccount: string | undefined
  if (entry.tee?.grantIdentity === undefined) {
    const config = await ctx.deps.readConfig()
    const name = ctx.profile ?? config.activeProfile
    const cached = name !== undefined ? config.profiles?.[name]?.account : undefined
    if (cached === undefined || cached === "") {
      writeLocalFailure(
        ctx.deps,
        {
          code: "PROMOTE_RECONCILE_INCOMPLETE",
          message: "This entry has no grant identity, and this profile has no cached account to assert.",
        },
        ctx.json,
      )
      return 1
    }
    ctx.deps.stdout.write(`This profile acts as account ${cached}.\n`)
    await confirmLastSix(ctx, cached, "that account")
    assertedAccount = cached
  }

  const verdict = await reconcileGrant(ctx, entry, { assertedAccount })
  if (verdict.kind === "unreadable") {
    writeLocalFailure(ctx.deps, { code: "PROMOTE_RECONCILE_INCOMPLETE", message: verdict.reason }, ctx.json)
    return 1
  }
  if (verdict.kind === "unresolved") {
    writeLocalFailure(
      ctx.deps,
      {
        code: "PROMOTE_OUTCOME_UNRESOLVED",
        message: `No authoritative grant or stranding record for ${entry.address}; the outcome is not established.`,
        suggestion: "Nothing was written. Demote under --emergency if funds must move, then promote a fresh key.",
      },
      ctx.json,
    )
    return 3
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
    if (ctx.json) writeJson(ctx.deps, { ok: false, lifecycle: "stranded", address: entry.address })
    else ctx.deps.stdout.write(`${entry.address} is stranded; it is never re-promotable.\n`)
    return 1
  }

  // granted: adopt, import ZERO times.
  const adoption = await adoptGrantedRow(ctx, entry, verdict.row, verdict.account, {
    confirmDestination: async (destination) => {
      try {
        await confirmLastSix(ctx, destination, "the server-reported vault destination")
        return true
      } catch {
        return false
      }
    },
  })
  if (adoption.outcome === "declined") {
    writeLocalFailure(
      ctx.deps,
      {
        code: "GRANT_DESTINATION_UNRESOLVED",
        message: `Adoption of the server grant for ${entry.address} was declined; the entry was left unchanged.`,
      },
      ctx.json,
    )
    return 1
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
  return 0
}

async function displayHoldings(ctx: CommandContext, rpcUrl: string, address: string): Promise<void> {
  const rpc = createSolanaRpc(rpcUrl, ctx.deps.fetch)
  const observedAt = new Date(ctx.deps.now()).toISOString()
  const lamports = await rpc.getBalance(address)
  const tokens = await rpc.getTokenAccountsByOwner(address, TOKEN_PROGRAM_ID)
  ctx.deps.stdout.write(`Holdings at ${address} (observed ${observedAt}):\n`)
  ctx.deps.stdout.write(`  SOL   ${lamports} lamports\n`)
  for (const t of tokens) {
    ctx.deps.stdout.write(`  token ${t.mint}  ${t.amountRaw} raw (${t.decimals} dp)\n`)
  }
  if (tokens.length === 0) ctx.deps.stdout.write(`  (no classic Token accounts)\n`)
}

async function runTeeImport(
  ctx: CommandContext,
  opts: {
    address: string
    privateKey: string
    label?: string
    vaultDestination: string
    reopen: OpenedVault["reopen"]
    vaultPath: string
    onImport?: () => void
  },
): Promise<number> {
  const apiKey = await resolveApiKey(ctx.deps, ctx.profile)
  if (!apiKey) {
    writeLocalFailure(
      ctx.deps,
      { code: "NO_API_KEY", message: "No API key available.", suggestion: "Run: candle keys create" },
      ctx.json,
    )
    return 1
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
    if (failure.kind === "api")
      writeFailure(ctx.deps, failure.response, { apiUrl: ctx.apiUrl, authType: "key" }, ctx.json)
    else {
      writeLocalFailure(
        ctx.deps,
        {
          code: failure.kind === "signer-store" ? "SIGNER_STORE_FAILED" : "SIGNER_COMMIT_FAILED",
          message: `${opts.address}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`,
          suggestion: "The vault entry is import-pending. Fix the error and re-run promote to resume.",
        },
        ctx.json,
      )
    }
    return 1
  }

  const submitted = flow.submitted
  const config = await ctx.deps.readConfig()
  const name = ctx.profile ?? config.activeProfile
  const account = name !== undefined ? (config.profiles?.[name]?.account ?? "") : ""
  const importedAt = new Date(ctx.deps.now()).toISOString()
  const raw = await requireVaultRaw(opts.vaultPath)
  const vault = await opts.reopen(opts.vaultPath, raw)
  try {
    await commitVault(
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
    closeVault(vault)
  }

  return submitted.remoteAuthority === "verified-active" ? 0 : 3
}
