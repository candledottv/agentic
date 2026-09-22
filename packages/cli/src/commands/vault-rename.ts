/**
 * BE-259 (spec `2026-09-22-cli-vault-key-naming-design.md`, D3 to D8, D11):
 * `candle vault rename <label|address> <new-label> [--id <entry-id>]`.
 *
 * A key's label is the vault's addressing surface and, until this command, permanent. Rename
 * changes one entry's `label` and nothing else: the address, the derivation record, the exposure
 * record, the `tee` block, the id, the root blob, every key blob and every envelope are untouched
 * (D7). What does change is what any index write costs -- `generation`, `updatedAt` and the
 * index blob re-sealed under the new canonical header -- and `commitVault` makes most of that
 * structural: with no `addKeys` the blobs are copied through by reference.
 *
 * It is also the REPAIR for duplicate labels that already exist (D4). A vault can hold two keys
 * called `X` by six routes, and every resolver is first-wins, so the second is unreachable by its
 * name. There is no separate reconciliation: `vault status --unlock` reports the duplicate, the
 * `VAULT_LABEL_AMBIGUOUS` refusal here hands over every candidate's address and id, and this
 * command takes either as `<old>`, plus `--id` as the floor under an address a legacy store held
 * twice.
 *
 * Two kinds of refusal, on two sides of the unlock (D11). Argument shape -- an unusable `<new>`,
 * or the two arguments being the same string -- is `usage()`, exit 2, decided before the vault is
 * opened. Everything about the vault's state -- nothing matched, more than one matched, the name
 * is taken, the resolved label already equals `<new>`, the entry is a TEE wallet -- is exit 1
 * with a typed code, after the unlock, and writes nothing.
 *
 * No new locking (D8). The name check runs against the index this command unlocked; the only way
 * another command could take `<new>` afterwards is by writing the file, and `commitVault` re-reads
 * the file under the lock and refuses `VAULT_CHANGED` if the bytes moved. Not an allocation: it
 * claims no derivation index, so it works in a vault built by `vault restore --phrase`, which is
 * exactly where wrong names arrive.
 */
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { VaultError } from "../vault/errors"
import type { KeyEntry } from "../vault/format"
import { entriesWithLabel, resolveRenameTarget, validateLabel } from "../vault/labels"
import { commitVault } from "../vault/store"
import {
  refuseEnvPassphrase,
  requireTty,
  requireVaultRaw,
  runVaultCommand,
  unlockInteractively,
  usage,
  vaultPathFor,
  writeJson,
} from "./vault-support"

export const RENAME_USAGE = "Usage: candle vault rename <label|address> <new-label> [--id <entry-id>]"

/** The pre-unlock refusal for `rename X X`: the raw positionals, compared as strings (D11). */
export const SAME_STRING_LINE = "The two arguments are the same string; nothing to do."

export async function vaultRename(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--keystore", "--id"],
    booleanFlags: ["--accept-older-copy"],
    pathFlags: ["--keystore"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [old, next, extra] = parsed.positionals
  if (old === undefined || next === undefined || extra !== undefined) return usage(ctx, RENAME_USAGE)

  // Argument shape, decided before the unlock (D11). None of these resolves `<old>`: the vault is
  // not opened, so nothing is written and `generation` is not bumped.
  const invalid = validateLabel(next)
  if (invalid !== undefined) return usage(ctx, invalid)
  if (old === next) return usage(ctx, SAME_STRING_LINE)
  const id = parsed.values["--id"]

  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "vault rename")) return 1

  const { deps } = ctx
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const path = resolvedVault.path

  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await requireVaultRaw(ctx, resolvedVault)
    const opened = await unlockInteractively(ctx, path, raw, {
      acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
    })
    const vault = hold(opened.vault)

    const entry = resolveTarget(vault.index, old, id)

    // D6: a TEE wallet's label also lives on the linked wallet Candle holds, and no route updates
    // that copy, so renaming the local half would give one wallet two names.
    if (entry.role === "tee-wallet") {
      throw new VaultError(
        "VAULT_RENAME_ROLE_REFUSED",
        `${entry.label} is a TEE wallet. Its label was sent to Candle when it was enabled and \`candle wallets\` lists that copy, so renaming it here would give one wallet two names and nothing reconciles them.`,
        {
          suggestion:
            "A vault key or an external wallet renames here. For a TEE wallet, nothing in this release changes the name on either side.",
        },
      )
    }

    // The second half of the same-name rule (D11): `rename <address> <current-label>` is only
    // knowable now, after the resolution. Checked before "taken", because the one entry whose
    // label equals `<new>` may be this one.
    if (entry.label === next) {
      throw new VaultError("VAULT_LABEL_UNCHANGED", `${next} is already this key's label. Nothing was written.`, {
        suggestion: "Nothing to rename. `candle vault status --unlock` lists every label.",
      })
    }

    if (entriesWithLabel(vault.index, next).length > 0) {
      throw new VaultError(
        "VAULT_LABEL_TAKEN",
        `A key labelled ${next} already exists in this vault. Nothing was written.`,
        {
          suggestion: "Choose a name no key has, or rename that key first: `candle vault status --unlock` lists them.",
        },
      )
    }

    // D7: the same `hd` record and the same `entries` array with one entry's `label` replaced, and
    // nothing else on the plan. No `addKeys`, no `envelopes`, no `sidecar`: `commitVault` then
    // copies `root` and every key blob through by reference and rewrites only the index.
    const from = entry.label
    await commitVault(
      vault,
      {
        index: {
          hd: vault.index.hd,
          entries: vault.index.entries.map((candidate) =>
            candidate.id === entry.id ? { ...candidate, label: next } : candidate,
          ),
        },
      },
      deps,
    )

    if (ctx.json) {
      writeJson(deps, { ok: true, id: entry.id, address: entry.address, role: entry.role, from, to: next })
      return 0
    }
    deps.stdout.write(`Renamed ${from} to ${next}.\n`)
    deps.stdout.write(`  address     ${entry.address}\n`)
    deps.stdout.write(`  id          ${entry.id}\n`)
    deps.stdout.write(`  role        ${entry.role}\n`)
    deps.stdout.write(`  unchanged   address, derivation path, key blob, every envelope\n`)
    return 0
  })
}

/**
 * `<old>` to one entry, or the typed refusal that says why not (D11). The candidate list on the
 * ambiguous refusal carries every match's address and id, in index order, comma-separated, so the
 * next command is a copy and a paste rather than a second lookup: that is the whole of D4's repair
 * loop. The count is the real count; nothing here says "Two".
 */
function resolveTarget(
  index: Parameters<typeof resolveRenameTarget>[0],
  old: string,
  id: string | undefined,
): KeyEntry {
  const match = resolveRenameTarget(index, old, id)
  if (match.kind === "found") return match.entry
  if (match.kind === "none") {
    throw new VaultError(
      "VAULT_LABEL_NOT_FOUND",
      id === undefined
        ? `No key in this vault is called ${old}, and no key has that address or id.`
        : `No key in this vault has the id ${id}.`,
      { suggestion: "List them with their labels: `candle vault status --unlock`" },
    )
  }
  const candidates = match.candidates.map((entry) => `${entry.address} (${entry.id})`).join(", ")
  const count = match.candidates.length
  const first = match.candidates[0] as KeyEntry
  throw new VaultError(
    "VAULT_LABEL_AMBIGUOUS",
    match.by === "label"
      ? `${count} keys in this vault are called ${old}, so this rename would not say which one it meant. Nothing was written.`
      : `${count} keys in this vault have the address ${old}, so this rename would not say which one it meant. Nothing was written.`,
    {
      suggestion:
        match.by === "label"
          ? `Name one by address or id. The candidates are ${candidates}.`
          : `Name one by id. The candidates are ${candidates}. Re-run: \`candle vault rename ${old} <new-label> --id ${first.id}\`.`,
    },
  )
}
