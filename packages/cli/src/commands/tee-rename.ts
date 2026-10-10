/**
 * `candle tee rename` (BE-1146, spec
 * `2026-10-09-cli-transfer-confirm-and-batch-rename-design.md`, 2.3): rename TEE wallets, one or a
 * pairs file of them.
 *
 * A TEE wallet's name lives in two places: the linked wallet Candle holds, and, for a wallet whose
 * key is in the vault, the vault entry. Both change here, which is what `vault rename` could not
 * do and why it refuses the role.
 *
 * The order is fixed. Argument and file shape are checked first. The server then resolves every
 * `<wallet>` (an id, an address or an exact label) in a preview that writes nothing: the device
 * token cannot read `GET /wallets`, so this is how the command learns the ids, the addresses and
 * which rows are TEE wallets. The vault is unlocked once, and only when a named wallet is a TEE
 * wallet and a vault exists on this machine; the vault's own name check runs then, before
 * anything is written anywhere. One server call renames every row, all or nothing, and one
 * `commitVault` renames every vault entry.
 *
 * That server-then-vault step is the only boundary. If the vault write fails after the server
 * accepted, the old label no longer resolves on the server, so the command prints the rows that
 * finish the job keyed by address. On that re-run the server label already equals the new one
 * and is left alone, and the vault entry is renamed.
 *
 * It takes the device token, the owner's credential (`keysAuth` on the API side); an API key
 * cannot rename a wallet. No second factor and no typed confirmation, as `vault rename` has none:
 * a label is display only.
 */
import { parseArgs } from "../args"
import { type ApiResult, apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveDeviceToken } from "../deps"
import { printIdentity } from "../profiles"
import { writeFailure, writeLocalFailure } from "../render"
import { isVaultError } from "../vault/errors"
import type { KeyEntry } from "../vault/format"
import { validateLabel } from "../vault/labels"
import { parseRenamePairs, type RenameFinding, type RenamePair } from "../vault/rename-batch"
import { commitVault, readVaultRaw } from "../vault/store"
import { refuseEnvPassphrase } from "./tee"
import { SAME_STRING_LINE } from "./vault-rename"
import { requireTty, runVaultCommand, unlockInteractively, usage, vaultPathFor, writeJson } from "./vault-support"

const RENAME_PATH = "/api/v1/agent/linked-wallets/rename"

export const TEE_RENAME_USAGE =
  "Usage: candle tee rename <label|address|id> <new-label> | --pairs-from <file> [--dry-run]"

const DEVICE_TOKEN_REQUIRED = {
  code: "DEVICE_TOKEN_REQUIRED",
  message: "Renaming a TEE wallet needs the device token, the owner's credential; an API key cannot do it.",
  suggestion: "Run: candle auth login",
}

/** One wallet as the rename route's preview reports it. */
interface PreviewRow {
  /** The row's position in the request. */
  row: number
  id: string
  chain: "solana" | "evm"
  address: string
  /** The label the server holds now. */
  from: string | null
  label: string
  tee: boolean
}

/** One wallet on the receipt. `vault` is `none` when this machine's vault holds no entry for it. */
export interface TeeRenamedRow {
  id: string
  chain: "solana" | "evm"
  address: string
  from: string | null
  to: string
  server: "renamed" | "unchanged"
  vault: "renamed" | "unchanged" | "none"
}

/** A wallet whose vault entry still has to change: the handle is the address, the one that still resolves. */
export interface RerunRow {
  from: string
  to: string
}

/**
 * The rows that finish a half-done rename, as a pairs file. Plain `<address> <new-label>` lines
 * when every label survives that form; a `from,to` CSV with each name quoted when one holds
 * whitespace, a comma or a quote.
 */
export function rerunFile(rows: RerunRow[]): string[] {
  if (rows.every((row) => !/[\s,"]/.test(row.to))) return rows.map((row) => `${row.from} ${row.to}`)
  return ["from,to", ...rows.map((row) => `${row.from},"${row.to.replaceAll('"', '""')}"`)]
}

function refusal(ctx: CommandContext, findings: RenameFinding[], exit: 1 | 2): number {
  const message = "TEE rename refused. Nothing was changed."
  if (ctx.json) writeJson(ctx.deps, { ok: false, code: "TEE_RENAME_BATCH_REFUSED", message, findings })
  else {
    ctx.deps.stderr.write(`${message}\n`)
    for (const finding of findings)
      ctx.deps.stderr.write(`  ${finding.line === 0 ? "file" : `line ${finding.line}`}: ${finding.problem}\n`)
  }
  return exit
}

/** The server's refusal: its findings against the lines that named them, or the envelope. */
function serverFailure(
  ctx: CommandContext,
  result: Extract<ApiResult, { ok: false }>,
  pairs: RenamePair[],
  batch: boolean,
): number {
  const { deps, apiUrl, json } = ctx
  if (result.status === 404) {
    writeLocalFailure(
      deps,
      {
        code: "TEE_RENAME_UNSUPPORTED",
        message: "This Candle API does not support renaming TEE wallets yet; nothing changed.",
      },
      json,
    )
    return 1
  }
  const raw = (result.raw as { error?: { findings?: unknown } } | null)?.error?.findings
  if (Array.isArray(raw) && raw.length > 0) {
    const findings = (raw as Array<{ row?: unknown; problem?: unknown; matches?: unknown }>).map((finding) => {
      const ids = Array.isArray(finding.matches)
        ? ` Candidates: ${(finding.matches as Array<{ id?: unknown }>).map((m) => String(m.id)).join(", ")}.`
        : ""
      return {
        // A single rename has no file, so its one finding is not given a line.
        line: batch ? (pairs[Number(finding.row)]?.line ?? 0) : 0,
        problem: `${String(finding.problem)}${ids}`,
      }
    })
    if (batch) return refusal(ctx, findings, 1)
    writeLocalFailure(
      deps,
      {
        code: "TEE_RENAME_REFUSED",
        message: `${findings.map((finding) => finding.problem).join(" ")} Nothing was changed.`,
        suggestion: "Run: candle wallets, to see this account's linked wallets and their labels.",
      },
      json,
    )
    return 1
  }
  writeFailure(deps, result, { apiUrl, authType: "device" }, json)
  return 1
}

/** The vault entries that are this wallet: the TEE entry with its linked wallet id, or its address. */
function vaultEntriesFor(entries: KeyEntry[], row: PreviewRow): KeyEntry[] {
  const lower = row.address.toLowerCase()
  return entries.filter(
    (entry) =>
      entry.role === "tee-wallet" &&
      (entry.linkedWalletId === row.id ||
        entry.address === row.address ||
        (entry.chain === "evm" && row.chain === "evm" && entry.address.toLowerCase() === lower)),
  )
}

/** A commit whose answer was lost: the server state is unknown, so print the address-keyed rows that finish it. */
function unknownCommit(
  ctx: CommandContext,
  rows: PreviewRow[],
  onServer: PreviewRow[],
  inVault: Array<{ row: PreviewRow; entry: KeyEntry }>,
): number {
  const { deps, json } = ctx
  const changing = new Set([...onServer.map((row) => row.id), ...inVault.map(({ row }) => row.id)])
  const rerun: RerunRow[] = rows
    .filter((row) => changing.has(row.id))
    .map((row) => ({ from: row.address, to: row.label }))
  const message = `The rename request got no answer, so whether the server applied it is unknown. Nothing was written to the vault. ${rerun.length} wallet${rerun.length === 1 ? "" : "s"} may or may not carry the new name on the server.`
  if (json) writeJson(deps, { ok: false, code: "TEE_RENAME_SERVER_UNKNOWN", message, rerun })
  else {
    deps.stderr.write(`${message}\n`)
    deps.stderr.write("Re-run it with these rows, saved to a file (the old labels may no longer resolve):\n")
    for (const line of rerunFile(rerun)) deps.stderr.write(`  ${line}\n`)
    deps.stderr.write("Then run: candle tee rename --pairs-from <file>\n")
  }
  return 1
}

export async function teeRename(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  if (!refuseEnvPassphrase(ctx)) return 1
  const parsed = parseArgs(args, {
    valueFlags: ["--pairs-from"],
    booleanFlags: ["--dry-run", "--accept-older-copy"],
    pathFlags: ["--pairs-from"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [old, next, extra] = parsed.positionals
  const pairsFile = parsed.values["--pairs-from"]
  const batch = pairsFile !== undefined
  const dryRun = parsed.booleans.has("--dry-run")
  if (
    batch ? parsed.positionals.length > 0 : old === undefined || next === undefined || extra !== undefined || dryRun
  ) {
    return usage(ctx, TEE_RENAME_USAGE)
  }

  // Argument and file shape, decided before any request and before the vault is opened.
  let pairs: RenamePair[]
  if (pairsFile !== undefined) {
    let contents: string
    try {
      contents = await deps.readFile(pairsFile)
    } catch (error) {
      return usage(ctx, `Could not read --pairs-from: ${error instanceof Error ? error.message : error}`)
    }
    const parsedFile = parseRenamePairs(contents)
    if (parsedFile.findings.length > 0) return refusal(ctx, parsedFile.findings, 2)
    pairs = parsedFile.rows
  } else {
    const invalid = validateLabel(next as string)
    if (invalid !== undefined) return usage(ctx, invalid)
    if (old === next) return usage(ctx, SAME_STRING_LINE)
    pairs = [{ line: 0, from: old as string, to: next as string }]
  }

  await printIdentity(ctx)
  const deviceToken = await resolveDeviceToken(deps, ctx.profile)
  if (!deviceToken) {
    writeLocalFailure(deps, DEVICE_TOKEN_REQUIRED, json)
    return 1
  }
  const call = (body: Record<string, unknown>) =>
    apiRequest(RENAME_PATH, {
      method: "POST",
      body,
      auth: "device",
      credentials: { deviceToken },
      apiUrl,
      fetch: deps.fetch,
      env: deps.env,
    })

  // Preview: the server resolves every handle against this account's active wallets; nothing is written.
  const preview = await call({
    dryRun: true,
    renames: pairs.map((pair) => ({ wallet: pair.from, label: pair.to })),
  })
  if (!preview.ok) return serverFailure(ctx, preview, pairs, batch)
  const shown = preview.body as { renamed?: PreviewRow[]; unchanged?: PreviewRow[] }
  const rows = [...(shown.renamed ?? []), ...(shown.unchanged ?? [])].sort((a, b) => a.row - b.row)
  // The commit sends the ids this preview named, so a preview that does not answer row for row is
  // not one to commit from.
  if (rows.length !== pairs.length || rows.some((row, at) => row.row !== at || row.label !== pairs[at]?.to)) {
    writeLocalFailure(
      deps,
      {
        code: "TEE_RENAME_PREVIEW_INVALID",
        message: "The API's preview did not answer every row; nothing was changed.",
      },
      json,
    )
    return 1
  }

  const vaultPath = vaultPathFor(ctx, { values: {}, booleans: new Set(), positionals: [] })
  if ("error" in vaultPath) return usage(ctx, vaultPath.error)
  // Which keys a vault holds is inside the encrypted index, so a TEE wallet named beside a vault
  // on this machine is what an unlock is for. No TEE wallet, or no vault: no unlock.
  const raw = rows.some((row) => row.tee) ? await readVaultRaw(vaultPath.path) : null
  if (raw !== null && !requireTty(ctx, "tee rename")) return 1

  return runVaultCommand(ctx, async ({ hold }) => {
    const vault =
      raw === null
        ? null
        : hold(
            (
              await unlockInteractively(ctx, vaultPath.path, raw, {
                acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
              })
            ).vault,
          )

    // The vault half of the plan, and its name check, before anything is written anywhere.
    const local: Array<{ row: PreviewRow; entry: KeyEntry }> = []
    const findings: RenameFinding[] = []
    let twice = false
    if (vault !== null) {
      for (const row of rows) {
        const line = pairs[row.row]?.line ?? 0
        const entries = vaultEntriesFor(vault.index.entries, row)
        if (entries.length > 1) {
          twice = true
          findings.push({
            line,
            problem: `The vault holds ${entries.length} TEE entries for ${row.address}; a rename would give them one name.`,
          })
        } else if (entries[0] !== undefined) local.push({ row, entry: entries[0] })
      }
      const targets = new Set(local.map(({ entry }) => entry.id))
      for (const { row, entry } of local) {
        if (entry.label === row.label) continue
        if (vault.index.entries.some((other) => other.label === row.label && !targets.has(other.id))) {
          findings.push({
            line: pairs[row.row]?.line ?? 0,
            problem: `New name ${row.label} is taken by a vault key outside this rename.`,
          })
        }
      }
    }
    if (findings.length > 0) {
      if (batch) return refusal(ctx, findings, 1)
      writeLocalFailure(
        deps,
        {
          code: twice ? "VAULT_LABEL_AMBIGUOUS" : "VAULT_LABEL_TAKEN",
          message: `${findings.map((finding) => finding.problem).join(" ")} Nothing was changed.`,
          suggestion: twice
            ? "`candle vault list` shows both entries."
            : "Choose a name no vault key has: `candle vault list` shows them.",
        },
        json,
      )
      return 1
    }

    const localById = new Map(local.map(({ row, entry }) => [row.id, entry]))
    const receipt: TeeRenamedRow[] = rows.map((row) => {
      const entry = localById.get(row.id)
      return {
        id: row.id,
        chain: row.chain,
        address: row.address,
        from: row.from,
        to: row.label,
        server: row.from === row.label ? "unchanged" : "renamed",
        vault: entry === undefined ? "none" : entry.label === row.label ? "unchanged" : "renamed",
      }
    })
    const onServer = rows.filter((row) => row.from !== row.label)
    const inVault = local.filter(({ row, entry }) => entry.label !== row.label)

    const print = (headline: string) => {
      if (json) return writeJson(deps, { ok: true, renamed: receipt, ...(dryRun ? { dryRun: true } : {}) })
      deps.stdout.write(`${headline}\n`)
      for (const row of receipt) {
        const sides =
          row.server === "renamed" && row.vault === "renamed"
            ? "server and vault"
            : row.server === "renamed"
              ? "server"
              : row.vault === "renamed"
                ? "vault; the server already had this name"
                : "already named"
        const was = row.server === "renamed" ? row.from : (localById.get(row.id)?.label ?? row.from)
        deps.stdout.write(`  ${was ?? "(none)"} -> ${row.to}  ${row.address} (${sides})\n`)
      }
    }

    if (dryRun) {
      print("Dry run: nothing was changed.")
      return 0
    }
    if (onServer.length === 0 && inVault.length === 0) {
      print("Nothing to change: every wallet already has its new name.")
      return 0
    }

    // The one server call: every row whose label changes, all or nothing.
    if (onServer.length > 0) {
      const committed = await call({ renames: onServer.map((row) => ({ id: row.id, label: row.label })) })
      if (!committed.ok) {
        // No HTTP answer: the server may have applied it, so the old labels may no longer resolve.
        if (committed.status === 0) return unknownCommit(ctx, rows, onServer, inVault)
        return serverFailure(
          ctx,
          committed,
          onServer.map((row) => pairs[row.row] as RenamePair),
          batch,
        )
      }
    }

    if (vault !== null && inVault.length > 0) {
      const names = new Map(inVault.map(({ row, entry }) => [entry.id, row.label]))
      try {
        await commitVault(
          vault,
          {
            index: {
              hd: vault.index.hd,
              entries: vault.index.entries.map((entry) =>
                names.has(entry.id) ? { ...entry, label: names.get(entry.id) as string } : entry,
              ),
            },
          },
          deps,
        )
      } catch (error) {
        // The boundary: the server holds the new names and the vault does not. The old labels no
        // longer resolve on the server, so the rows that finish this are keyed by address.
        const rerun: RerunRow[] = inVault.map(({ row }) => ({ from: row.address, to: row.label }))
        const cause = isVaultError(error) ? error.code : "VAULT_UNREADABLE"
        const why = error instanceof Error ? error.message : String(error)
        const message = `The server renamed ${onServer.length} wallet${onServer.length === 1 ? "" : "s"}, but the vault write failed (${cause}: ${why}). ${rerun.length} vault ${rerun.length === 1 ? "entry still has its" : "entries still have their"} old name.`
        if (json) {
          writeJson(deps, { ok: false, code: "TEE_RENAME_VAULT_INCOMPLETE", message, cause, rerun, renamed: receipt })
        } else {
          deps.stderr.write(`${message}\n`)
          deps.stderr.write("Finish it with these rows, saved to a file (the old labels no longer resolve):\n")
          for (const line of rerunFile(rerun)) deps.stderr.write(`  ${line}\n`)
          deps.stderr.write("Then run: candle tee rename --pairs-from <file>\n")
        }
        return 1
      }
    }

    const changed = receipt.filter((row) => row.server === "renamed" || row.vault === "renamed").length
    print(`Renamed ${changed} wallet${changed === 1 ? "" : "s"}.`)
    return 0
  })
}
