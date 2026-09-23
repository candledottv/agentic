/**
 * BE-285 (spec `2026-09-22-cli-vault-promote-batch-design.md`): `candle vault promote-batch`.
 *
 * Many `vault promote --in-place` runs under ONE unlock and ONE reviewed acknowledgement for the
 * set (Andrew's ruling, option 1). The work is making that acknowledgement mean something, and it
 * lives in three places:
 *
 * - The whole-set preflight (D6, `vault/promote-batch.ts`). Every precondition single promote
 *   enforces runs for every row BEFORE the first `commitVault`, against the vault as it will be
 *   when the rows above have run, including the two checks that are not projections: the
 *   recoverable-factor gate once, and the stored-secret-matches-address compare per resolved row,
 *   which single promote runs only after its pre-import commit. A batch never promotes key 90
 *   and then refuses key 91.
 * - One unlock that is real (D9). The loop never calls `OpenedVault.reopen`; it carries the held
 *   payload key exactly as `verifyWrittenFromDisk` does, so a security key is touched twice for a
 *   146-row batch, not 292 to 438 times. `runTeeImport` takes `closeReopened: false` because the
 *   held-key re-open shares this command's DEK.
 * - The acknowledgement (D10). The acting count, then the last six of each destination in listed
 *   order. The destinations' last sixes cannot be produced from a CSV of labels; they can only
 *   come from reading the table. One attempt; a mismatch is `PROMOTE_NOT_ACKNOWLEDGED` with zero
 *   writes.
 *
 * `vault promote` is unchanged: it passes the defaults on every parameter §4.7 added.
 */
import { base58 } from "@scure/base"
import { parseArgs } from "../args"
import { type CommandContext, resolveApiKey } from "../deps"
import { renderTable } from "../render"
import { createSolanaRpc, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../solana-lite"
import { assertRecoverableFactorExists } from "../vault/domains"
import { addressFromSecret64 } from "../vault/ed25519"
import { isVaultError, VaultError } from "../vault/errors"
import { type KeyEntry, parseVaultFile } from "../vault/format"
import { wipe } from "../vault/hygiene"
import {
  actingDestinations,
  checkAcknowledgement,
  destinationCell,
  formatSol,
  formatUsd,
  type PairRow,
  type PlannedRow,
  parsePairsFile,
  parseValueUsdCell,
  preflightBatch,
  type RefusedRow,
  type ResumeReconciled,
  type ResumeRefused,
  renderPhaseAFindings,
  writeBatchRefusal,
} from "../vault/promote-batch"
import { applyPromotion, printAd8Warning } from "../vault/promote-support"
import { reconcileGrant } from "../vault/reconcile-grant"
import { commitVault, decryptKey, type UnlockedVault } from "../vault/store"
import { verifyWritten } from "./vault-new-key"
import { type ReturnedFailure, resumePromote, runTeeImport } from "./vault-promote"
import {
  refuseEnvPassphrase,
  requireTty,
  requireVaultRaw,
  rpcUrlFrom,
  runVaultCommand,
  unlockInteractively,
  usage,
  vaultPathFor,
  writeJson,
} from "./vault-support"

const USAGE_LINE =
  "Usage: candle vault promote-batch --pairs-from <file> --rpc-url <url> [--token-holdings] [--accept-unknown-exposure]"

/** The batch-only sentence under AD-8 (D8). Never part of `AD8_WARNING`. */
export const BATCH_AD8_SENTENCE = (n: number) =>
  `You are about to accept the warning above for all ${n} addresses below at once. Each exposure is permanent, and independent of the others.`

export const ACK_PROMPT =
  "Type the number of addresses this run will act on, then the last six of each destination in the order listed above: "

/**
 * TEST ONLY: sees the batch's vault object after each row's pre-import commit and again after its
 * import commit, so a test can assert the DEK it shares is still intact (T-U3) and that what the
 * loop wrote is what the preflight projected (T-P2). `null` clears it.
 */
let rowObserver:
  | ((event: {
      line: number
      stage: "pre-import" | "imported" | "resumed"
      vault: UnlockedVault
    }) => void | Promise<void>)
  | null = null
export function setPromoteBatchObserver(observer: typeof rowObserver): void {
  rowObserver = observer
}

/** One row's result, for the `--json` document and the summary. */
interface KeyResult {
  line: number
  label: string
  address: string
  destination: string
  state: "promoted" | "resumed" | "skipped"
  lifecycle: string
  linkedWalletId: string | null
  remoteAuthority: string | null
  importCalls: number
}

export async function vaultPromoteBatch(args: string[], ctx: CommandContext): Promise<number> {
  // `--from` is refused by name (D2), so someone who tries it learns the route instead of reading
  // "unknown flag": a fresh-key migration is `vault new-key --labels-from`, then n promotions.
  if (args.some((arg) => arg === "--from" || arg.startsWith("--from="))) {
    return usage(
      ctx,
      "promote-batch promotes existing vault keys in place and takes no --from. For fresh keys: candle vault new-key --chain solana --labels-from <file>, then candle vault promote --from <label> for each.",
    )
  }
  const parsed = parseArgs(args, {
    valueFlags: ["--pairs-from", "--rpc-url", "--keystore"],
    booleanFlags: ["--token-holdings", "--accept-unknown-exposure", "--accept-older-copy"],
    pathFlags: ["--keystore", "--pairs-from"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length > 0) return usage(ctx, `Unexpected argument: ${parsed.positionals[0]}`)
  const pairsFile = parsed.values["--pairs-from"]
  if (pairsFile === undefined) return usage(ctx, USAGE_LINE)
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "vault promote-batch")) return 1

  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const path = resolvedVault.path
  const rpcUrl = rpcUrlFrom(ctx, parsed)
  if (typeof rpcUrl !== "string") return usage(ctx, rpcUrl.error)
  const acceptUnknown = parsed.booleans.has("--accept-unknown-exposure")
  const readTokens = parsed.booleans.has("--token-holdings")
  const { deps } = ctx

  // Phase A, BEFORE the unlock (D7): nobody types a passphrase and only then learns the file is
  // missing, malformed, or has a label in it twice.
  let contents: string
  try {
    contents = await deps.readFile(pairsFile)
  } catch (error) {
    return usage(ctx, `Could not read --pairs-from: ${error instanceof Error ? error.message : error}`)
  }
  const parsedFile = parsePairsFile(contents, { file: pairsFile, rpcUrl })
  if (!parsedFile.ok) return usage(ctx, renderPhaseAFindings(pairsFile, parsedFile.findings))
  const { rows, hasValueUsd } = parsedFile

  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await requireVaultRaw(ctx, resolvedVault)
    const opened = await unlockInteractively(ctx, path, raw, {
      acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
    })
    let current = hold(opened.vault)
    // D6's first uncovered check, once, the call shape of `vault-promote.ts:262`: the shipped
    // `VAULT_NO_RECOVERABLE_FACTOR`, exit 1, zero writes, no table.
    assertRecoverableFactorExists(current.file.envelopes)
    deps.stderr.write(`✓ ${rows.length} rows read from ${pairsFile}\n`)

    // ── Phase B ────────────────────────────────────────────────────────────────────────────
    const preflight = await preflightBatch(current.index, rows, {
      acceptUnknownExposure: acceptUnknown,
      now: new Date(deps.now()).toISOString(),
      verifySubject: async (subject) => {
        const secret = await verifySubjectSecret(current, subject)
        wipe(secret)
      },
      reconcileResume: (row, subject, resolved) => reconcileForPreflight(ctx, row, subject, resolved),
    })
    if (preflight.failures.length > 0) {
      writeBatchRefusal(deps, ctx.json, { rows: preflight.failures, total: rows.length })
      return 1
    }
    const planned = preflight.planned
    const acting = planned.filter((item) => item.kind !== "skip")
    const destinations = actingDestinations(planned)
    deps.stderr.write(`✓ preflight: ${rows.length} rows, ${destinations.length} destinations, no conflicts\n`)

    // ── Holdings (D8): SOL for every address, always; tokens only on request ──────────────
    const addresses = planned.map((item) => item.subject.address)
    const rpc = createSolanaRpc(rpcUrl, deps.fetch)
    const host = new URL(rpcUrl).host
    const observedAt = new Date(deps.now()).toISOString()
    let lamports: Map<string, bigint> | undefined
    let readError: string | undefined
    try {
      const accounts = await rpc.getMultipleAccounts(addresses)
      lamports = new Map(addresses.map((address, at) => [address, accounts[at]?.lamports ?? 0n]))
      deps.stderr.write(
        `✓ SOL read for ${addresses.length} addresses (${Math.ceil(addresses.length / 100)} requests)\n`,
      )
    } catch (error) {
      readError = error instanceof Error ? error.message : String(error)
    }
    let tokenCounts: Map<string, number> | undefined
    if (readTokens && lamports !== undefined) {
      deps.stderr.write(
        `Reading token accounts for ${addresses.length} addresses: ${addresses.length * 2} requests over ${host}.\n`,
      )
      tokenCounts = new Map()
      for (const address of addresses) {
        const classic = await rpc.getTokenAccountsByOwner(address, TOKEN_PROGRAM_ID)
        const token2022 = await rpc.getTokenAccountsByOwner(address, TOKEN_2022_PROGRAM_ID)
        tokenCounts.set(address, classic.length + token2022.length)
      }
    }

    // ── The screen (D8): the warning, the table, the footer, the prompt ───────────────────
    const table = renderBatchTable(planned, { lamports, tokenCounts, hasValueUsd })
    const footer = renderFooter({
      file: pairsFile,
      planned,
      acting,
      destinations,
      observedAt,
      host,
      readError,
      tokensRead: tokenCounts !== undefined,
      hasValueUsd,
    })

    if (readError !== undefined) {
      // The table is not lost, and the batch refuses: a listing is a read, this is the last screen
      // before an irreversible write, so a missing column is a reason to stop (D8).
      deps.stderr.write(`\n${table}\n\n${footer}\n`)
      throw new VaultError("VAULT_UNREADABLE", `The SOL read over ${host} failed: ${readError}. Nothing was written.`, {
        suggestion: "Check --rpc-url (or CANDLE_SOLANA_RPC_URL) and run again; the table above is what would have run.",
      })
    }

    if (acting.length === 0) {
      // Nothing to decide, so nothing to acknowledge (D10).
      deps.stderr.write(`\n${table}\n\n${footer}\nNothing to do: every row already landed.\n`)
      return finish(ctx, {
        file: pairsFile,
        rows: rows.length,
        keys: planned.map((item) => skippedResult(item)),
        destinations,
        exit: 0,
      })
    }

    printAd8Warning(ctx)
    deps.stdout.write(`${BATCH_AD8_SENTENCE(acting.length)}\n\n`)
    deps.stderr.write(`${table}\n\n${footer}\n`)
    deps.stderr.write(
      `\nThis acknowledges permanent TEE exposure for ${acting.length} addresses; the full warning is printed above this table.\n`,
    )
    const typed = await deps.promptLine(ACK_PROMPT)
    const verdict = checkAcknowledgement(typed, acting.length, destinations)
    if (!verdict.ok) {
      throw new VaultError(
        "PROMOTE_NOT_ACKNOWLEDGED",
        `${verdict.reason} Nothing was promoted, and nothing was written.`,
        {
          suggestion: "Run the command again and read the destination roll-up in the footer above.",
        },
      )
    }

    // ── The loop (D9, D11, D12): one commit per key, no factor presentation, stop on failure ──
    const now = new Date(deps.now()).toISOString()
    const results: KeyResult[] = []
    let stopped: (ReturnedFailure & { exit: number; line: number }) | undefined
    let last: { address: string; keyId: string } | undefined
    let worst = 0
    const width = String(acting.length).length
    let done = 0
    // The held-key re-open (D9): the file's current bytes under the payload key this command
    // already holds, exactly `verifyWrittenFromDisk`'s shape. Shares the DEK; never closed here.
    const reopenHeld = async (_path: string, bytes: string): Promise<UnlockedVault> => ({
      ...current,
      raw: bytes,
      file: parseVaultFile(bytes),
    })

    try {
      for (const item of planned) {
        if (item.kind === "skip") {
          results.push(skippedResult(item))
          continue
        }
        if (item.kind === "promote") {
          const { subject, destination, row } = item
          current = hold(
            await commitVault(
              current,
              {
                index: applyPromotion(current.index, subject, destination, {
                  now,
                  acceptUnknownExposure: acceptUnknown,
                }),
              },
              deps,
            ),
          )
          await rowObserver?.({ line: row.line, stage: "pre-import", vault: current })
          const secret = await verifySubjectSecret(current, subject)
          let privateKey: string
          try {
            privateKey = base58.encode(secret)
          } finally {
            wipe(secret)
          }
          const imported = await runTeeImport(ctx, {
            address: subject.address,
            privateKey,
            label: subject.label,
            vaultDestination: destination.address,
            reopenForWrite: reopenHeld,
            closeReopened: false,
            report: "return",
            resolvedVault,
          })
          if (imported.failure !== undefined || imported.submitted === undefined) {
            stopped = {
              line: row.line,
              exit: imported.exit,
              ...(imported.failure ?? { code: "VAULT_WRITE_FAILED", message: "The import did not complete." }),
            }
            break
          }
          if (imported.vault !== undefined) current = hold(imported.vault)
          await rowObserver?.({ line: row.line, stage: "imported", vault: current })
          worst = Math.max(worst, imported.exit)
          done += 1
          last = { address: subject.address, keyId: subject.id }
          results.push({
            line: row.line,
            label: subject.label,
            address: subject.address,
            destination: destination.address,
            state: "promoted",
            lifecycle: "enabled",
            linkedWalletId: imported.submitted.id ?? null,
            remoteAuthority: imported.submitted.remoteAuthority ?? null,
            importCalls: 1,
          })
          deps.stderr.write(
            `✓ ${String(done).padStart(width)}/${acting.length}  ${subject.label}  ${shortAddress(subject.address)}  enabled\n`,
          )
          continue
        }
        // resume: the shipped path with the batch's confirmations, which accept only what the
        // footer printed and never prompt (D11). A second read that no longer matches is D12.
        const { subject, row, destinationAddress, account } = item
        const resumed = await resumePromote(ctx, current, subject, opened.reopen, path, hold, {
          confirmAccount: async (candidate) => {
            if (candidate !== account) {
              throw new VaultError(
                "GRANT_IDENTITY_MISMATCH",
                `This profile now acts as ${candidate}, not the ${account ?? "(none)"} the footer printed; the batch stopped.`,
                { suggestion: "Run the command again; the footer will print the account every resume row asserts." },
              )
            }
          },
          confirmDestination: async (candidate) => candidate === destinationAddress,
          announceGrant: false,
          report: "return",
        })
        if (resumed.failure !== undefined || resumed.exit !== 0) {
          stopped = {
            line: row.line,
            exit: resumed.exit,
            ...(resumed.failure ?? { code: "PROMOTE_OUTCOME_UNRESOLVED", message: "The resume did not complete." }),
          }
          break
        }
        if (resumed.vault !== undefined) current = hold(resumed.vault)
        await rowObserver?.({ line: row.line, stage: "resumed", vault: current })
        done += 1
        last = { address: subject.address, keyId: subject.id }
        results.push({
          line: row.line,
          label: subject.label,
          address: subject.address,
          destination: destinationAddress,
          state: "resumed",
          lifecycle: "enabled",
          linkedWalletId: resumed.adopted?.linkedWalletId ?? null,
          remoteAuthority: resumed.adopted?.remoteAuthority ?? null,
          importCalls: 0,
        })
        deps.stderr.write(
          `✓ ${String(done).padStart(width)}/${acting.length}  ${subject.label}  ${shortAddress(subject.address)}  resumed\n`,
        )
      }
    } catch (error) {
      // Reality disagreed with the preflight mid-run (VAULT_CHANGED, a dead network, a store that
      // could not write). Stop, report what landed, and never write a second `--json` document.
      stopped = {
        line: acting[done]?.row.line ?? 0,
        exit: isVaultError(error) ? error.exitCode : 1,
        code: isVaultError(error) ? error.code : "VAULT_UNREADABLE",
        message: error instanceof Error ? error.message : String(error),
        ...(isVaultError(error) && error.suggestion ? { suggestion: error.suggestion } : {}),
      }
    }

    if (stopped !== undefined) {
      reportPartial(ctx, { landed: done, acting: acting.length, failure: stopped })
      if (ctx.json) {
        writeJson(deps, {
          ok: false,
          complete: false,
          file: pairsFile,
          rows: rows.length,
          promoted: results.filter((r) => r.state === "promoted").length,
          resumed: results.filter((r) => r.state === "resumed").length,
          skipped: results.filter((r) => r.state === "skipped").length,
          destinations: destinations.map(({ label, address, keys }) => ({ label, address, keys })),
          keys: results,
          failedLine: stopped.line,
          code: stopped.code,
          message: stopped.message,
          ...(stopped.suggestion !== undefined ? { suggestion: stopped.suggestion } : {}),
        })
      } else {
        deps.stderr.write(`${stopped.message}${stopped.suggestion ? ` ${stopped.suggestion}` : ""}\n`)
      }
      return stopped.exit
    }

    // Once for the whole run, on the last row written: the vault is re-opened through the FACTOR,
    // which proves the envelopes still unwrap after every write above. The half a held-key check
    // cannot make, presented once, so a security key is touched twice for 146 keys (D9).
    if (last !== undefined) await verifyWritten(path, last.address, last.keyId, opened.reopen, ctx)

    return finish(ctx, { file: pairsFile, rows: rows.length, keys: results, destinations, exit: worst })
  })
}

/** The shipped compare (`vault-promote.ts:372-377`): the caller owns the plaintext and wipes it. */
async function verifySubjectSecret(vault: UnlockedVault, subject: KeyEntry): Promise<Uint8Array> {
  const secret = await decryptKey(vault, subject.id)
  try {
    if (addressFromSecret64(secret) !== subject.address) {
      throw new VaultError("VAULT_VERIFY_FAILED", "Stored secret does not match the subject address.")
    }
  } catch (error) {
    wipe(secret)
    throw error
  }
  return secret
}

/**
 * Phase B's reconcile of one `resume` row (D11): the shipped `reconcileGrant`, no write, no prompt.
 * Every outcome that is not `granted`-and-consistent is a row in the refusal report, with the
 * shipped code and message the single command would have written.
 */
async function reconcileForPreflight(
  ctx: CommandContext,
  row: PairRow,
  subject: KeyEntry,
  resolved: { onDisk?: string; destinationAddress: string },
): Promise<ResumeReconciled | ResumeRefused> {
  const { onDisk } = resolved
  const refuse = (failure: ResumeRefused["failure"]): ResumeRefused => ({ ok: false, failure })
  const apiKey = await resolveApiKey(ctx.deps, ctx.profile)
  if (!apiKey) {
    return refuse({
      code: "PROMOTE_RECONCILE_INCOMPLETE",
      message: "No API key is available; reconciliation cannot run.",
      suggestion: "Run: candle keys create",
    })
  }
  let assertedAccount: string | undefined
  if (subject.tee?.grantIdentity === undefined) {
    const config = await ctx.deps.readConfig()
    const name = ctx.profile ?? config.activeProfile
    const cached = name !== undefined ? config.profiles?.[name]?.account : undefined
    if (cached === undefined || cached === "") {
      return refuse({
        code: "PROMOTE_RECONCILE_INCOMPLETE",
        message: "This entry has no grant identity, and this profile has no cached account to assert.",
      })
    }
    assertedAccount = cached
  }
  let verdict: Awaited<ReturnType<typeof reconcileGrant>>
  try {
    verdict = await reconcileGrant(ctx, subject, { assertedAccount })
  } catch (error) {
    if (isVaultError(error)) {
      return refuse({
        code: error.code,
        message: error.message,
        ...(error.suggestion !== undefined ? { suggestion: error.suggestion } : {}),
      })
    }
    throw error
  }
  if (verdict.kind === "unreadable") {
    return refuse({ code: "PROMOTE_RECONCILE_INCOMPLETE", message: verdict.reason })
  }
  if (verdict.kind === "unresolved") {
    return refuse({
      code: "PROMOTE_OUTCOME_UNRESOLVED",
      message: `No authoritative grant or stranding record for ${subject.address}; the outcome is not established.`,
      suggestion: "Nothing was written. Demote under --emergency if funds must move, then promote a fresh key.",
    })
  }
  if (verdict.kind === "strand-final") {
    // The shipped path would commit a `stranded` lifecycle and Phase B writes nothing; the row has
    // to leave the file, because a stranded entry is a `conflict` on the next run.
    return refuse({
      code: "PROMOTE_ALREADY_TEE_WALLET",
      message: `${subject.address} is stranded; it is never re-promotable.`,
      suggestion: `Run: candle vault promote --in-place ${row.label} (which records the stranding), then remove this row from the file.`,
    })
  }
  const server = verdict.row.vaultDestination
  const account = assertedAccount ?? subject.tee?.grantIdentity?.account ?? verdict.account
  if (onDisk !== undefined) {
    // The interrupt shape: `adoptGrantedRow` does not prompt on this branch; the same comparison
    // it makes (`reconcile-grant.ts:141-145`), with its shipped code.
    if (server !== undefined && server !== onDisk) {
      return refuse({
        code: "GRANT_BINDING_MISMATCH",
        message: `The recorded vault destination ${onDisk} does not match the server's ${server}.`,
      })
    }
    return { ok: true, destinationAddress: onDisk, ...(assertedAccount !== undefined ? { account } : {}) }
  }
  // A local-candidate: the server's destination must be the address this row resolved, the one
  // the table will print. Phase B does not adopt it.
  if (server === undefined) {
    return refuse({
      code: "GRANT_DESTINATION_UNRESOLVED",
      message: `The server lists ${subject.address} but carries no vault destination to adopt.`,
      suggestion: "Choose a vault key with `vault demote --sweep-to`, or wait until the grant records a destination.",
    })
  }
  const fileDestination = resolved.destinationAddress
  if (server !== fileDestination) {
    return refuse({
      code: "GRANT_BINDING_MISMATCH",
      message: `The server-reported vault destination ${server} does not match this file's ${row.destination} (${fileDestination}).`,
      why: `Row ${row.line} names a different destination from the grant the server holds; the file and the server describe different migrations.`,
    })
  }
  return { ok: true, destinationAddress: server, ...(assertedAccount !== undefined ? { account } : {}) }
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function skippedResult(item: Extract<PlannedRow, { kind: "skip" }> | PlannedRow): KeyResult {
  const subject = item.subject
  return {
    line: item.row.line,
    label: subject.label,
    address: subject.address,
    destination: item.kind === "promote" ? item.destination.address : item.destinationAddress,
    state: "skipped",
    lifecycle: subject.tee?.lifecycle ?? "enabled",
    linkedWalletId: subject.linkedWalletId ?? null,
    remoteAuthority: subject.tee?.remoteAuthority ?? null,
    importCalls: 0,
  }
}

/** The table (D8): one row per file row, in file order, the `state` column first after the number. */
function renderBatchTable(
  planned: PlannedRow[],
  opts: { lamports?: Map<string, bigint>; tokenCounts?: Map<string, number>; hasValueUsd: boolean },
): string {
  const headers = ["#", "state", "label", "address", "destination"]
  headers.push(opts.tokenCounts !== undefined ? "SOL" : "SOL (tokens not read)")
  if (opts.tokenCounts !== undefined) headers.push("token accounts")
  if (opts.hasValueUsd) headers.push("value_usd (yours)")
  const rows = planned.map((item) => {
    const address = item.subject.address
    const state =
      item.kind === "promote"
        ? item.acceptedUnknown
          ? "promote*"
          : "promote"
        : item.kind === "resume"
          ? "resume"
          : "skip"
    const destination =
      item.kind === "promote"
        ? destinationCell(item.destination.label, item.destination.address)
        : destinationCell(item.row.destination, item.destinationAddress)
    const cells = [String(item.row.line), state, item.subject.label, address, destination]
    const lamports = opts.lamports?.get(address)
    cells.push(lamports === undefined ? "unread" : formatSol(lamports))
    if (opts.tokenCounts !== undefined) cells.push(String(opts.tokenCounts.get(address) ?? 0))
    if (opts.hasValueUsd) cells.push(item.row.valueUsd ?? "")
    return cells
  })
  return renderTable(headers, rows)
}

function renderFooter(opts: {
  file: string
  planned: PlannedRow[]
  acting: PlannedRow[]
  destinations: ReturnType<typeof actingDestinations>
  observedAt: string
  host: string
  readError?: string
  tokensRead: boolean
  hasValueUsd: boolean
}): string {
  const skipped = opts.planned.filter((item) => item.kind === "skip").length
  const resumes = opts.planned.filter((item) => item.kind === "resume").length
  const promotes = opts.planned.filter((item) => item.kind === "promote").length
  const lines = [
    `${opts.planned.length} rows from ${opts.file}: ${skipped} already promoted (skipped), ${resumes} to resume, ${promotes} to promote.`,
  ]
  if (opts.destinations.length > 0) {
    lines.push(
      `${opts.destinations.length} destination${opts.destinations.length === 1 ? "" : "s"}, in this order: ${opts.destinations
        .map((d) => `${destinationCell(d.label, d.address)} ${d.keys} key${d.keys === 1 ? "" : "s"}`)
        .join(" · ")}`,
    )
  }
  if (opts.readError !== undefined) {
    lines.push(`SOL read over ${opts.host} FAILED: ${opts.readError}. The batch is refused.`)
  } else {
    lines.push(
      `SOL read at ${opts.observedAt} over ${opts.host}. ${
        opts.tokensRead
          ? "Token accounts were read under both programs."
          : "Token accounts were not read (pass --token-holdings)."
      }`,
    )
  }
  if (opts.hasValueUsd) {
    let total = 0
    let excluded = 0
    for (const item of opts.acting) {
      const value = item.row.valueUsd === undefined ? undefined : parseValueUsdCell(item.row.valueUsd)
      if (value === undefined) excluded += 1
      else total += value
    }
    lines.push(
      `value_usd totals your file's own column; this CLI reads no price. Total for the ${opts.acting.length} rows this run will act on: ${formatUsd(total)}${
        excluded > 0 ? ` (${excluded} row${excluded === 1 ? "" : "s"} excluded: the cell did not parse)` : ""
      }`,
    )
  }
  const accepted = opts.acting.filter((item) => item.kind === "promote" && item.acceptedUnknown)
  if (accepted.length > 0) {
    lines.push(
      `${accepted.length} row${accepted.length === 1 ? "" : "s"} needed --accept-unknown-exposure (promote*): ${accepted
        .map((item) => item.row.label)
        .join(", ")}`,
    )
  }
  const asserted = opts.acting.find((item) => item.kind === "resume" && item.account !== undefined)
  if (asserted !== undefined && asserted.kind === "resume" && asserted.account !== undefined) {
    lines.push(
      `Resume rows with no grant identity assert this profile's account ${asserted.account} (…${asserted.account.slice(-6)}).`,
    )
  }
  return lines.join("\n")
}

/** D12's partial report, on stderr in both renderings, on the pattern of `new-key`'s. */
function reportPartial(
  ctx: CommandContext,
  opts: { landed: number; acting: number; failure: RefusedRow | ReturnedFailure },
): void {
  const remaining = opts.acting - opts.landed
  ctx.deps.stderr.write(
    `\n${opts.landed} of ${opts.acting} rows landed and ARE in the vault; the vault is intact. ${remaining} remain.\n` +
      `Re-run the same file: the rows that landed are skipped, an interrupted row resumes, and the rest are promoted.\n`,
  )
}

function finish(
  ctx: CommandContext,
  opts: {
    file: string
    rows: number
    keys: KeyResult[]
    destinations: ReturnType<typeof actingDestinations>
    exit: number
  },
): number {
  const promoted = opts.keys.filter((r) => r.state === "promoted").length
  const resumed = opts.keys.filter((r) => r.state === "resumed").length
  const skipped = opts.keys.filter((r) => r.state === "skipped").length
  const unverified = opts.keys.filter((r) => r.state !== "skipped" && r.remoteAuthority !== "verified-active")
  const complete = opts.exit === 0
  if (ctx.json) {
    writeJson(ctx.deps, {
      ok: true,
      complete,
      file: opts.file,
      rows: opts.rows,
      promoted,
      resumed,
      skipped,
      destinations: opts.destinations.map(({ label, address, keys }) => ({ label, address, keys })),
      keys: opts.keys,
    })
    return opts.exit
  }
  const parts: string[] = []
  if (promoted > 0)
    parts.push(`${promoted} address${promoted === 1 ? "" : "es"} promoted under one unlock, each committed on its own`)
  if (resumed > 0) parts.push(`${resumed} resumed`)
  if (skipped > 0) parts.push(`${skipped} already promoted (skipped)`)
  ctx.deps.stdout.write(`${parts.join("; ")}.\n`)
  if (!complete) {
    ctx.deps.stdout.write(
      `${unverified.length} import${unverified.length === 1 ? "" : "s"} did not report verified-active: ${unverified
        .map((r) => r.address)
        .join(", ")}\n`,
    )
  }
  return opts.exit
}
