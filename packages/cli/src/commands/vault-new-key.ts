/**
 * Ember Phase 2 (BE-136, CC-11, AD-5): `candle vault new-key`.
 *
 * This is the one command in PR A that ALLOCATES, and CC-11's central distinction is what shapes
 * it. Recovery derives an index to reproduce an address that already exists, and is always safe.
 * Allocation claims an index as new and unused, and that claim is only true if the highest
 * previously allocated index is known. A restored vault cannot know it -- the phrase is the whole
 * input to derivation, and the same phrase may have been restored under another account, under
 * another deployment, or into a wallet that never touched Candle -- so allocation FAILS CLOSED
 * there, with no override flag, because there is no fact an operator could assert that would make
 * an unknown boundary known. The exit is a fresh root, and the refusal names it.
 *
 * `hd.exposedIndexes` is the second guard and it applies even when the boundary IS known: an index
 * positively known to have been exposed is never allocated, in any vault built from this root.
 *
 * BE-242 adds `--count` and `--labels-from`: n keys under ONE unlock, for a migration that needs a
 * fresh key per wallet (160 of them, in the case that asked for this). It is a convenience for one
 * interactive unlock and nothing more. Every refusal above the loop still runs exactly once and
 * still fails the whole batch -- `requireTty`, `refuseEnvPassphrase`, `assertRecoverableFactorExists`
 * and CC-11's `VAULT_ALLOCATION_BOUNDARY_UNKNOWN` -- and the allocation guard below runs per INDEX
 * rather than once for the batch, because `hd.exposedIndexes` has to be honoured for indexes 2..n
 * exactly as it is for the first. There is no unattended derivation here and no flag that makes
 * one: a batch still costs a terminal and a typed passphrase. (`assertHighValueSatisfied` was a
 * fourth refusal above the loop until BE-245 removed `--high-value` outright.)
 */
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { assertRecoverableFactorExists } from "../vault/domains"
import { addressFromSecret64 } from "../vault/ed25519"
import { VaultError } from "../vault/errors"
import { type KeyEntry, parseVaultFile } from "../vault/format"
import { DERIVATION_SCHEME, deriveSolanaKey, solanaVaultPath } from "../vault/hd"
import { wipe } from "../vault/hygiene"
import {
  commitVault,
  decryptKey,
  decryptRoot,
  freshKeyId,
  readVaultRaw,
  sealKeyBlob,
  type UnlockedVault,
} from "../vault/store"
import {
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

/**
 * The upper bound on `--count`. A batch is one unlock, not an open-ended derivation loop, so the
 * flag takes a bound rather than any integer a caller can type: a mistyped `--count 100000` is
 * hours of Argon2-backed commits and 100,000 claimed indexes, and nothing recovers the counter.
 * 256 sits comfortably above the 160-key migration that asked for this and well below anything
 * that could be a typo for a small number.
 */
export const MAX_NEW_KEY_COUNT = 256

/** One key's worth of the batch's result, in allocation order. */
interface DerivedKey {
  address: string
  label: string
  path: string
  index: number
  keyId: string
}

/**
 * Resolves how many keys to derive and what to call them, from `--count`, `--labels-from` and
 * `--label`.
 *
 * `--label` names ONE key, so it is refused with a batch rather than quietly applied to the first
 * or turned into a prefix. Sequential names (`p-1..p-n`) were the obvious batch spelling and the
 * wrong one for the job this is for: a 1:1 wallet migration reuses the OLD wallets' names, which
 * are not sequential and are not derivable from anything. `--labels-from <file>` takes them one
 * per line, and the count falls out of the file's length.
 */
export function resolveBatch(
  countFlag: string | undefined,
  labelFlag: string | undefined,
  labelsFileContents: string | undefined,
): { count: number; labels?: string[] } | { error: string } {
  let count: number | undefined
  if (countFlag !== undefined) {
    const value = Number(countFlag)
    if (!Number.isInteger(value) || value < 1) return { error: `--count must be a whole number, 1 or greater.` }
    if (value > MAX_NEW_KEY_COUNT) {
      return { error: `--count is capped at ${MAX_NEW_KEY_COUNT}; run the command again for more.` }
    }
    count = value
  }

  if (labelsFileContents === undefined) {
    // No file: `--label` is the single-key spelling and only makes sense for a single key.
    if (labelFlag !== undefined && (count ?? 1) > 1) {
      return { error: "--label names one key. For a batch use --labels-from <file>, one name per line." }
    }
    return { count: count ?? 1 }
  }

  if (labelFlag !== undefined) return { error: "--labels-from and --label cannot both be given." }
  const labels = labelsFileContents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (labels.length === 0) return { error: "--labels-from names an empty file; there is nothing to derive." }
  if (labels.length > MAX_NEW_KEY_COUNT) {
    return { error: `--labels-from holds ${labels.length} names; --count is capped at ${MAX_NEW_KEY_COUNT}.` }
  }
  // Checked before anything is derived: two keys under one name in a 1:1 migration is a mapping
  // nobody can reconstruct afterwards.
  const duplicate = labels.find((label, at) => labels.indexOf(label) !== at)
  if (duplicate !== undefined) return { error: `--labels-from lists ${duplicate} more than once.` }
  if (count !== undefined && count !== labels.length) {
    return { error: `--count ${count} disagrees with --labels-from, which holds ${labels.length} names.` }
  }
  return { count: labels.length, labels }
}

export async function vaultNewKey(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--keystore", "--chain", "--label", "--count", "--labels-from"],
    booleanFlags: ["--accept-older-copy"],
    // `--labels-from` is a filesystem path, so BE-241's tilde refusal applies to it by that
    // rule's own logic: it follows the value's MEANING, not the flag's name.
    pathFlags: ["--keystore", "--labels-from"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length > 0) return usage(ctx, `Unexpected argument: ${parsed.positionals[0]}`)

  const chain = parsed.values["--chain"]
  if (chain === undefined) return usage(ctx, "--chain solana is required.")
  if (chain === "evm") {
    // Exit 2 rather than 1: the format accepts a secp256k1 entry and the path is already fixed
    // (`m/44'/60'/n'/0/0`), so this is a command that does not exist yet, not an operation refused.
    return usage(ctx, "CHAIN_NOT_OFFERED: EVM keys arrive in Phase 4. This release derives Solana keys only.")
  }
  if (chain !== "solana") return usage(ctx, `Unknown chain: ${chain}. This release derives Solana keys only.`)
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "vault new-key")) return 1

  const { deps } = ctx
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const path = resolvedVault.path

  // The labels file is read and validated BEFORE the unlock, for the reason `wallets import`
  // checks its flags before prompting for a private key: nobody should type a passphrase and only
  // then learn the file is missing, empty, or has a name in it twice. (`--labels-from` is a
  // `pathFlag` above, so an unexpanded tilde in it is already refused at parse time, earlier
  // still.)
  const labelsFile = parsed.values["--labels-from"]
  let labelsFileContents: string | undefined
  if (labelsFile !== undefined) {
    try {
      labelsFileContents = await deps.readFile(labelsFile)
    } catch (error) {
      return usage(ctx, `Could not read --labels-from: ${error instanceof Error ? error.message : error}`)
    }
  }
  const batch = resolveBatch(parsed.values["--count"], parsed.values["--label"], labelsFileContents)
  if ("error" in batch) return usage(ctx, batch.error)
  // A batch document is what the BATCH FLAGS select, not what the count happens to be: `--count 1`
  // answers in the same shape as `--count 160`, so a script never has to branch on n.
  const batchRequested = parsed.values["--count"] !== undefined || labelsFile !== undefined

  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await requireVaultRaw(ctx, resolvedVault)
    const opened = await unlockInteractively(ctx, path, raw, {
      acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
    })
    const vault = hold(opened.vault)

    // Invariant 1, checked against the OPENED vault: a key created in a vault with no recoverable
    // factor is a key nobody can recover.
    assertRecoverableFactorExists(vault.file.envelopes)

    // CC-11: a restored vault is a recovery vault. It opens, lists, signs, backs up and exports by
    // ceremony; it does not mint new addresses from a root whose history it cannot bound.
    if (vault.index.hd.discovery !== undefined) {
      throw new VaultError(
        "VAULT_ALLOCATION_BOUNDARY_UNKNOWN",
        "This vault was built by `vault restore --phrase`, so the highest index its root ever allocated was never established and claiming a new one could re-derive an address that is already in use elsewhere.",
        {
          suggestion:
            "Create a second vault with a fresh root (`candle vault init`) and move the funds across with `candle vault transfer`. There is no flag for this: no fact you could assert would make the old boundary known.",
        },
      )
    }

    // Every requested name checked against the vault BEFORE a single derivation. A collision
    // found at key 90 would leave 89 keys committed and the mapping this batch exists to produce
    // half made; found here it costs nothing.
    if (batch.labels !== undefined) {
      const taken = new Set(vault.index.entries.map((entry) => entry.label))
      const clash = batch.labels.find((label) => taken.has(label))
      if (clash !== undefined) {
        return usage(ctx, `A key labelled ${clash} already exists in this vault; every --labels-from name must be new.`)
      }
    }

    const derived: DerivedKey[] = []
    let last: { address: string; keyId: string } | undefined
    // ONE unlock, one root decryption, n derivations. `current` is reassigned from each commit
    // because `commitVault` returns the vault as it now is on disk: reusing the pre-commit object
    // would make the next write see a changed file and raise VAULT_CHANGED. The DEK is the same
    // buffer throughout (the returned object is a spread), so the `hold` above still closes it.
    let current = vault
    const root = await decryptRoot(vault)
    try {
      for (let made = 0; made < batch.count; made++) {
        // Per INDEX, never once for the batch: `exposedIndexes` must be honoured for keys 2..n
        // exactly as it is for the first, and the counter moves under us on every commit.
        const index = nextAllocatableIndex(
          current.index.hd.nextIndex.solanaVault,
          current.index.hd.exposedIndexes.solanaVault,
        )
        const derivationPath = solanaVaultPath(index)
        const label = batch.labels?.[made] ?? parsed.values["--label"] ?? `key-${index}`

        let address: string
        let keyId: string
        let blob: Awaited<ReturnType<typeof sealKeyBlob>>
        const key = await deriveSolanaKey(root, derivationPath)
        try {
          address = key.address
          keyId = freshKeyId()
          blob = await sealKeyBlob(current, keyId, key.secret64)
        } finally {
          wipe(key.secret64)
        }

        const entry: KeyEntry = {
          id: keyId,
          chain: "solana",
          curve: "ed25519",
          address,
          label,
          createdAt: new Date(deps.now()).toISOString(),
          role: "vault",
          origin: "derived",
          derivation: { scheme: DERIVATION_SCHEME, path: derivationPath },
          exposure: { everRemoteExposed: false, everExported: false },
        }

        // ONE COMMIT PER KEY, deliberately, and the help says so. A single commit for the batch
        // would be atomic but all-or-nothing: an interrupt at key 90 of 160 would throw away 90
        // Argon2-backed derivations and leave the operator with nothing to resume from. Per key,
        // an interrupt leaves 89 keys on disk with the counter already past them, so the vault is
        // consistent at every point and the job resumes by asking for the remainder.
        current = await commitVault(
          current,
          {
            index: {
              hd: { ...current.index.hd, nextIndex: { ...current.index.hd.nextIndex, solanaVault: index + 1 } },
              entries: [...current.index.entries, entry],
            },
            addKeys: [blob],
          },
          deps,
        )

        // Recorded as soon as the commit returns, BEFORE the verify: at this point the key is on
        // disk and the counter is past it, so a verify that then fails must still report the key
        // as created. Counting it only after a successful verify would tell the operator 89 keys
        // landed when 90 did, and the 90th would be the one they re-derive under a name that is
        // already taken.
        derived.push({ address, label, path: derivationPath, index, keyId })

        // Every key is checked against the bytes that reached the disk, for the same reason
        // `init` re-reads itself: the guarantee is about the file, not about the object this
        // process just built. Through the held payload key rather than the factor -- see
        // `verifyWrittenFromDisk` for why that distinction is what makes a batch possible at all.
        await verifyWrittenFromDisk(current, address, keyId)
        last = { address, keyId }

        // Streamed rather than buffered in the human rendering: on a 160-key run the addresses
        // are the operator's record, and a batch that dies at key 90 must not take the 89 that
        // landed off the screen with it.
        if (!ctx.json && batchRequested) deps.stdout.write(`${address}  ${label}  ${derivationPath}\n`)
      }
    } catch (error) {
      reportPartialBatch(ctx, derived, batch.count)
      throw error
    } finally {
      wipe(root)
    }

    const only = derived[0]
    if (only === undefined || last === undefined) throw new VaultError("VAULT_WRITE_FAILED", "No key was derived.")

    // Once for the whole run, on the last key: the vault is re-opened through the FACTOR, which
    // proves the envelopes still unwrap after every write above. That is the half a held-key check
    // cannot make, and it is why it is still here -- but it is presented once, so a security key
    // is touched twice for a batch of 160 rather than 160 times.
    await verifyWritten(path, last.address, last.keyId, opened.reopen, ctx)

    if (ctx.json) {
      // The single-key document is unchanged, so every existing `--json` caller keeps parsing what
      // it parsed before. A batch flag -- and only a batch flag -- selects the `keys` array.
      if (batchRequested) writeJson(deps, { ok: true, count: derived.length, keys: derived })
      else
        writeJson(deps, {
          ok: true,
          address: only.address,
          label: only.label,
          path: only.path,
          index: only.index,
          keyId: only.keyId,
        })
      return 0
    }
    if (batchRequested) {
      deps.stdout.write(
        `${derived.length} key${derived.length === 1 ? "" : "s"} created under one unlock, each committed on its own and re-read from the vault and re-derived from its root.\n`,
      )
      return 0
    }
    deps.stdout.write(`${only.address}\n`)
    deps.stdout.write(`  label       ${only.label}\n`)
    deps.stdout.write(`  derivation  ${only.path}\n`)
    deps.stdout.write(`  verified    re-read from the vault and re-derived from its root\n`)
    return 0
  })
}

/**
 * What landed, on stderr, when a batch fails partway.
 *
 * On stderr in both renderings because stdout under `--json` is contracted to carry exactly one
 * document and the failure itself is about to take that slot. Without this an interrupted 160-key
 * run says only that it failed, and the operator cannot tell whether to re-run for 160 or for 70.
 */
function reportPartialBatch(ctx: CommandContext, derived: DerivedKey[], requested: number): void {
  if (requested <= 1 || derived.length === 0) return
  ctx.deps.stderr.write(
    `\n${derived.length} of ${requested} keys were created and ARE in the vault; the vault is intact and its counter is past them.\n` +
      `Re-run for the remaining ${requested - derived.length}${
        derived.length > 0 ? " (with a --labels-from file holding the names that did not land)" : ""
      }.\n`,
  )
}

/**
 * The next index this vault may CLAIM: the counter, advanced past anything in `exposedIndexes`.
 * The list only ever grows and survives every later restore that rediscovers it, so this skip is
 * permanent rather than a one-time correction.
 */
export function nextAllocatableIndex(counter: number, exposed: readonly number[]): number {
  let index = counter
  while (exposed.includes(index)) index++
  return index
}

/**
 * Checks the bytes ON DISK decrypt to the address just derived, using the payload key this process
 * already holds.
 *
 * The difference from `verifyWritten` below is what it costs, and in a batch that cost is the
 * whole point. `verifyWritten` re-opens the file through the FACTOR: for a passphrase that is
 * another Argon2id derivation, and for a security key it is another physical touch. Per key over
 * 160 keys that is 160 touches -- precisely the thing `--count` exists to remove, reintroduced
 * one layer down. The claim being made per key is "the blob that reached the disk decrypts to the
 * address just reported", and the held payload key settles that without presenting a factor at
 * all. The factor-based check still runs once at the end of every run, so "the vault still opens
 * with your factor after these writes" is proved too.
 */
export async function verifyWrittenFromDisk(vault: UnlockedVault, address: string, keyId: string): Promise<void> {
  const raw = await readVaultRaw(vault.path)
  if (raw === null) {
    throw new VaultError("VAULT_WRITE_FAILED", `The vault at ${vault.path} could not be read back after the write.`)
  }
  // Parsed fresh from what the disk actually holds; only the payload key is carried over. Not
  // closed afterwards: it shares this vault's DEK, which `runVaultCommand` already owns.
  const onDisk: UnlockedVault = { ...vault, raw, file: parseVaultFile(raw) }
  const secret = await decryptKey(onDisk, keyId)
  try {
    if (addressFromSecret64(secret) !== address) {
      throw new VaultError(
        "VAULT_VERIFY_FAILED",
        "The key written to the vault does not produce the address just derived.",
      )
    }
  } finally {
    wipe(secret)
  }
}

/** Re-opens the written file THROUGH THE FACTOR and checks the new blob decrypts to the address
 * just reported. The stronger, more expensive half of the pair above. */
export async function verifyWritten(
  path: string,
  address: string,
  keyId: string,
  reopen: OpenedVault["reopen"],
  _ctx: CommandContext,
): Promise<void> {
  const raw = await readVaultRaw(path)
  if (raw === null)
    throw new VaultError("VAULT_WRITE_FAILED", `The vault at ${path} could not be read back after the write.`)
  const reopened = await reopen(path, raw)
  try {
    const secret = await decryptKey(reopened, keyId)
    try {
      if (addressFromSecret64(secret) !== address) {
        throw new VaultError(
          "VAULT_VERIFY_FAILED",
          "The key written to the vault does not produce the address just derived.",
        )
      }
    } finally {
      wipe(secret)
    }
  } finally {
    const { closeVault } = await import("../vault/store")
    closeVault(reopened)
  }
}
