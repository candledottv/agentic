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
 * - The acknowledgement. Since BE-296 (spec `2026-09-23-cli-vault-promote-confirm-design.md`) it
 *   is the word `confirm`, shared with single promote (`confirmPromotion`), typed under a
 *   one-sentence warning, above which the table names every address and destination and directly
 *   above which the live controlled-by block names the Candle account, API key and API the keys
 *   will be registered to. One attempt; anything else is `PROMOTE_NOT_ACKNOWLEDGED` with zero
 *   writes. The role read (D6, D7) always runs for the acting rows and fills the `authority`
 *   column; it warns and never refuses.
 *
 * `vault promote` passes the defaults on every parameter §4.7 added.
 *
 * `--to-key <label|prefix>` (BE-322): the target is checked before the unlock (`preflightToKey`),
 * the block names it, and once every row has landed the promoted wallets are moved to it in
 * chunks of at most 200 through the rebind route. A batch that stopped, or whose rebind failed,
 * names the wallets still on the calling key and the command that finishes; a re-run of the same
 * file skips the rows that landed and rebinds them, the moved ones reported `unchanged`.
 */
import { base58 } from "@scure/base"
import { parseArgs } from "../args"
import { type CommandContext, resolveApiKey } from "../deps"
import {
  bytesToHex,
  evmAddressFromSecret,
  formatUnits,
  HOOD_USDG_DECIMALS,
  NATIVE_DECIMALS,
  sameEvmAddress,
} from "../evm-lite"
import { renderTable } from "../render"
import { describeRpcFailure, openSolanaClient, rpcRateLimitedError, type SolanaClient } from "../solana-endpoint"
import { isRateLimited, type SolanaRpcError, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../solana-lite"
import {
  type AccountRoom,
  batchRoomRefusal,
  RESTORED_SENTENCE,
  readAccountRoom,
  restoreRefusedFailure,
  restoresPreImportEntry,
  tierName,
  unreadableRoomRefusal,
} from "../vault/account-room"
import { assertRecoverableFactorExists } from "../vault/domains"
import { addressFromSecret64 } from "../vault/ed25519"
import { isVaultError, VaultError } from "../vault/errors"
import {
  appendScanStart,
  assertHoodChain,
  type EvmHoldings,
  hoodHostLine,
  readEvmHoldings,
  resolveHoodClient,
} from "../vault/evm-tee"
import { type KeyEntry, parseVaultFile } from "../vault/format"
import { wipe } from "../vault/hygiene"
import {
  actingDestinations,
  batchChain,
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
import {
  applyPromotion,
  CONFIRM_WORD,
  type ControlledBy,
  confirmPromotion,
  controlledByJson,
  printPromoteSentence,
  promoteSentence,
  readControlledBy,
  renderControlledBy,
  runRoleCheck,
  shortAddress,
  withToKey,
} from "../vault/promote-support"
import {
  finalBoundKey,
  type NotRebindable,
  preflightToKey,
  type RebindableWallet,
  type RebindReportInput,
  type RebindRun,
  rebindJson,
  rebindPromoted,
  renderRebindReport,
  type ToKeyTarget,
  targetWarnings,
  walletRebindJson,
} from "../vault/promote-to-key"
import { reconcileGrant } from "../vault/reconcile-grant"
import {
  authoritiesCountLine,
  authoritiesJson,
  authorityCell,
  checkOpeningLine,
  keysWithFindings,
  ROLE_GROUP_IDS,
  readSummaryLine,
  type SignerRolesResult,
  sentenceForm,
} from "../vault/signer-roles"
import { commitVault, decryptKey, type UnlockedVault } from "../vault/store"
import { verifyWritten } from "./vault-new-key"
import { type ReturnedFailure, resumePromote, runTeeImport } from "./vault-promote"
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

const USAGE_LINE =
  "Usage: candle vault promote-batch --pairs-from <file> [--rpc-url <url>] [--to-key <label|prefix>] [--token-holdings] [--accept-unknown-exposure]"

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

/** BE-322: the resolved `--to-key` target and the device token the rebind sends. */
interface ToKeyContext {
  target: ToKeyTarget
  deviceToken: string
}

/**
 * BE-322: what the rebind phase needs from the rows that landed. `importedTo` is the key the
 * import (or an earlier run) bound the wallet to, by address; it is not part of `KeyResult`, so
 * the document without `--to-key` is unchanged.
 */
interface RebindPhase {
  toKey: ToKeyContext
  callingKeyPrefix: string
  importedTo: Map<string, string | null>
}

/** The wallets a run can move (`verified-active`, with a server id) and the ones it cannot yet. */
function splitRebindable(results: KeyResult[]): { wallets: RebindableWallet[]; notRebindable: NotRebindable[] } {
  const wallets: RebindableWallet[] = []
  const notRebindable: NotRebindable[] = []
  for (const row of results) {
    if (row.linkedWalletId !== null && row.remoteAuthority === "verified-active") {
      wallets.push({ id: row.linkedWalletId, address: row.address, label: row.label })
    } else {
      notRebindable.push({
        address: row.address,
        label: row.label,
        reason:
          row.linkedWalletId === null
            ? `no linked wallet id (${row.lifecycle})`
            : `remote authority is ${row.remoteAuthority ?? "unknown"}, not verified-active`,
      })
    }
  }
  return { wallets, notRebindable }
}

/** The rows with their final binding and rebind outcome, for the `--json` document (BE-322). */
function keysWithRebind(
  results: KeyResult[],
  phase: RebindPhase,
  run: RebindRun | undefined,
): Array<KeyResult & { boundKeyPrefix: string | null; rebind: ReturnType<typeof walletRebindJson> }> {
  return results.map((row) => ({
    ...row,
    boundKeyPrefix: finalBoundKey(
      { id: row.linkedWalletId, importedTo: phase.importedTo.get(row.address) ?? null },
      run,
      phase.toKey.target.keyPrefix,
    ),
    rebind: walletRebindJson({ id: row.linkedWalletId, remoteAuthority: row.remoteAuthority }, run),
  }))
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
    valueFlags: ["--pairs-from", "--rpc-url", "--keystore", "--to-key"],
    booleanFlags: ["--token-holdings", "--accept-unknown-exposure", "--accept-older-copy"],
    pathFlags: ["--keystore", "--pairs-from"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length > 0) return usage(ctx, `Unexpected argument: ${parsed.positionals[0]}`)
  const pairsFile = parsed.values["--pairs-from"]
  if (pairsFile === undefined) return usage(ctx, USAGE_LINE)
  const toKeyRaw = parsed.values["--to-key"]
  if (toKeyRaw !== undefined && toKeyRaw.trim().length === 0) return usage(ctx, "--to-key needs a label or a prefix.")
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "vault promote-batch")) return 1

  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const path = resolvedVault.path
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
  const parsedFile = parsePairsFile(contents, {
    file: pairsFile,
    rpcUrlGiven: parsed.values["--rpc-url"] !== undefined,
  })
  if (!parsedFile.ok) return usage(ctx, renderPhaseAFindings(pairsFile, parsedFile.findings))
  const { rows, hasValueUsd } = parsedFile

  // BE-322: the target, still before the unlock and before any write. It resolves, it is on this
  // account and can take TEE wallets, a selected-scope key has room for the file, and there is a
  // device token to rebind with. A refusal here has written nothing.
  let toKey: ToKeyContext | undefined
  if (toKeyRaw !== undefined) {
    const preflight = await preflightToKey(ctx, toKeyRaw, { labels: rows.map((row) => row.label) })
    if (!preflight.ok) return preflight.exit
    toKey = { target: preflight.target, deviceToken: preflight.deviceToken }
  }

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

    // Phase 4b (BE-391): a batch is one chain. An EVM batch promotes 4a EVM vault keys to Hood TEE
    // wallets: the Hood preconditions, ETH holdings over the Hood RPC, and no signer-role read.
    const chain = batchChain(current.index, rows)
    if (chain === "mixed") {
      throw new VaultError(
        "SOLANA_COMMAND_EVM_KEY",
        `${pairsFile} names both Solana and EVM keys; a promote-batch run is one chain.`,
        { suggestion: "Nothing was written. Split the file into a Solana file and an EVM file and run each." },
      )
    }
    const hood = chain === "evm" ? resolveHoodClient(ctx, parsed.values["--rpc-url"]) : undefined
    if (hood !== undefined && "error" in hood) return usage(ctx, hood.error)
    if (chain === "evm" && readTokens) {
      return usage(ctx, "--token-holdings reads Solana token accounts; a Hood batch shows each key's ETH.")
    }
    // Solana only. Resolved after the chain is known, so a bad Solana endpoint does not refuse
    // an EVM batch (BE-391).
    const solana = chain === "evm" ? undefined : await openSolanaClient(ctx, parsed.values["--rpc-url"])
    if (solana !== undefined && "error" in solana) return usage(ctx, solana.error)

    // ── Phase B ────────────────────────────────────────────────────────────────────────────
    const preflight = await preflightBatch(current.index, rows, {
      chain,
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

    // ── The room (BE-288, D7): after the unlock (the number of `promote` rows is only known once
    // the index is classified), before the SOL read, the table, the warning and any commitVault.
    // Only `promote` rows take a slot; a `resume` row that passed Phase B is already linked.
    // Unreadable refuses, on the same reasoning as the failed SOL read below: the batch never
    // starts a run it already knows it cannot finish.
    const promotes = planned.filter((item) => item.kind === "promote").length
    const roomRead = await readAccountRoom(ctx)
    if (!roomRead.ok) throw unreadableRoomRefusal(roomRead.reason)
    const roomRefusal = batchRoomRefusal(roomRead.room, promotes)
    if (roomRefusal !== null) throw roomRefusal
    const room = roomRead.room

    // ── Which account, key and API will control these keys (BE-296, D5): live, after the room,
    // before the SOL read, so a refusal comes before the operator reads anything and before any
    // write. Never a cached value. With `--to-key` (BE-322) the block names the target.
    const live = await readControlledBy(ctx)
    const controlledBy =
      toKey === undefined
        ? live
        : withToKey(live, {
            keyPrefix: toKey.target.keyPrefix,
            label: toKey.target.label,
            warnings: targetWarnings(toKey.target),
          })
    const rebindPhase: RebindPhase | undefined =
      toKey === undefined ? undefined : { toKey, callingKeyPrefix: live.keyPrefix, importedTo: new Map() }
    for (const item of planned) {
      if (item.kind === "skip")
        rebindPhase?.importedTo.set(item.subject.address, item.subject.tee?.boundKeyPrefix ?? null)
    }

    // ── Holdings (D8): SOL for every address, always; tokens only on request ──────────────
    // Phase 4b: ETH over the Hood RPC for an EVM batch, and the Hood height every row's scanStart
    // records, read once before any write.
    const addresses = planned.map((item) => item.subject.address)
    const observedAt = new Date(deps.now()).toISOString()
    let lamports: Map<string, bigint> | undefined
    let readError: string | undefined
    let rateLimited: SolanaRpcError | undefined
    let hoodHeight: bigint | undefined
    let evmHoldings: Map<string, EvmHoldings> | undefined
    let rpc: SolanaClient["rpc"] | undefined
    let host: string
    if (hood !== undefined) {
      host = hood.host
      deps.stderr.write(`${hoodHostLine(hood, "the chain id, the Hood height and each key's ETH")}\n`)
      await assertHoodChain(hood)
      try {
        hoodHeight = await hood.rpc.blockNumber()
        const balances = new Map<string, bigint>()
        evmHoldings = new Map()
        for (const address of addresses) {
          const held = await readEvmHoldings(hood.rpc, address)
          evmHoldings.set(address, held)
          balances.set(address, held.eth)
        }
        lamports = balances
        deps.stderr.write(
          `✓ ETH, USDG and WETH read for ${addresses.length} addresses (${addresses.length * 3} requests)\n`,
        )
      } catch (error) {
        readError = error instanceof Error ? error.message : String(error)
      }
    } else {
      if (solana === undefined || "error" in solana) {
        return usage(ctx, "No Solana endpoint for this batch.")
      }
      rpc = solana.rpc
      host = solana.endpoint.host
      try {
        const accounts = await rpc.getMultipleAccounts(addresses)
        lamports = new Map(addresses.map((address, at) => [address, accounts[at]?.lamports ?? 0n]))
        deps.stderr.write(
          `✓ SOL read for ${addresses.length} addresses (${Math.ceil(addresses.length / 100)} requests)\n`,
        )
      } catch (error) {
        if (isRateLimited(error)) rateLimited = error
        readError = describeRpcFailure(error)
      }
    }
    let tokenCounts: Map<string, number> | undefined
    if (readTokens && lamports !== undefined && rpc !== undefined) {
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

    // ── The role read (BE-296, D6, D7): always, no flag, for the acting rows only, after the
    // SOL read and any token counts and before the screen. Group-major, up to 8 in flight, one
    // after the first 429, per-group stop; the progress line is replaced by the `✓` line. It
    // warns and never refuses. Not run when the SOL read already failed (the batch refuses
    // just below) or when every row is a skip: there is no acting key, and the done line
    // would say "0 addresses".
    const actingAddresses = acting.map((item) => item.subject.address)
    let roles: SignerRolesResult | undefined
    if (hood !== undefined) {
      // The role read is Solana's (mint, freeze, upgrade, stake). Nothing is read on Hood, so every
      // group is `not checked` and the sentence takes that form.
      roles = {
        checked: [],
        notChecked: ROLE_GROUP_IDS.map((group) => ({ group, reason: "not read on Hood" })),
        found: [],
        requests: 0,
        planned: 0,
        rateLimited: 0,
        elapsedMs: 0,
      }
    } else if (lamports !== undefined && actingAddresses.length > 0 && rpc !== undefined) {
      deps.stderr.write(`${checkOpeningLine(actingAddresses.length, host)}\n`)
      roles = await runRoleCheck(ctx, rpc, actingAddresses)
    }

    // ── The screen (D8): the sentence, the table, the footer, the block, the prompt ───────
    const table = renderBatchTable(planned, { lamports, tokenCounts, hasValueUsd, roles, evmHoldings })
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
      room,
      promotes,
      roles,
      evm: hood !== undefined,
    })

    if (readError !== undefined) {
      // The table is not lost, and the batch refuses: a listing is a read, this is the last screen
      // before an irreversible write, so a missing column is a reason to stop (D8).
      deps.stderr.write(`\n${table}\n\n${footer}\n`)
      // BE-355 (D3): a rate limit that survived the retry is named, with the fix, and nothing was written.
      if (rateLimited !== undefined) throw rpcRateLimitedError(ctx, host, rateLimited)
      throw new VaultError(
        "VAULT_UNREADABLE",
        `The ${hood !== undefined ? "ETH" : "SOL"} read over ${host} failed: ${readError}. Nothing was written.`,
        {
          suggestion: `Check --rpc-url (or ${hood !== undefined ? "CANDLE_EVM_RPC_URL" : "CANDLE_SOLANA_RPC_URL"}) and run again; the table above is what would have run.`,
        },
      )
    }

    if (acting.length === 0) {
      // Nothing to promote, so nothing to acknowledge for the promotion (D10). Nothing was asked
      // of the role read: `checked` is every group so `--json` still carries `authorities` (D9),
      // the same shape an empty read returns, without printing a done line.
      const roles = {
        checked: [...ROLE_GROUP_IDS],
        notChecked: [],
        found: [],
        requests: 0,
        planned: 0,
        rateLimited: 0,
        elapsedMs: 0,
      }
      const skipped = planned.map((item) => skippedResult(item))
      const rebindable = rebindPhase === undefined ? undefined : splitRebindable(skipped)
      if (rebindPhase === undefined || rebindable === undefined || rebindable.wallets.length === 0) {
        deps.stderr.write(`\n${table}\n\n${footer}\nNothing to do: every row already landed.\n`)
        return finish(ctx, {
          file: pairsFile,
          rows: rows.length,
          keys: skipped,
          destinations,
          exit: 0,
          controlledBy,
          roles,
        })
      }
      // BE-322: every row landed on an earlier run and the rebind is what remains (the re-run after
      // a rebind that failed or was not reached). A rebind moves control of funded wallets, so it
      // is acknowledged: the block names the target, then `confirm`, the rule `tee rebind` applies.
      const n = rebindable.wallets.length
      deps.stderr.write(
        `\n${table}\n\n${footer}\nEvery row already landed; ${n} wallet${n === 1 ? "" : "s"} to rebind.\n`,
      )
      deps.stderr.write(`\n${renderControlledBy(controlledBy, n)}\n`)
      const typed = await deps.promptLine(
        `Type ${CONFIRM_WORD} to move ${n === 1 ? "this wallet" : `these ${n} wallets`} to ${rebindPhase.toKey.target.keyPrefix}: `,
      )
      if (typed.trim().toLowerCase() !== CONFIRM_WORD) {
        throw new VaultError(
          "PROMOTE_NOT_ACKNOWLEDGED",
          `The acknowledgement is the word ${CONFIRM_WORD}; nothing was moved, and nothing was written.`,
          { suggestion: `Run the command again and type ${CONFIRM_WORD} at the prompt.` },
        )
      }
      const rebound = await runRebindPhase(ctx, rebindPhase, skipped)
      return finish(ctx, {
        file: pairsFile,
        rows: rows.length,
        keys: skipped,
        destinations,
        exit: 0,
        controlledBy,
        roles,
        rebound,
      })
    }

    // The sentence (D1) on stdout where the five-sentence warning used to be; the table and
    // footer on stderr; the controlled-by block directly above the prompt (D4); `confirm` (D3).
    const checked = roles as SignerRolesResult
    printPromoteSentence(
      ctx,
      promoteSentence({
        n: acting.length,
        form: sentenceForm(checked),
        k: keysWithFindings(checked),
        where: "below",
      }),
    )
    deps.stderr.write(`${table}\n\n${footer}\n`)
    deps.stderr.write(`\n${renderControlledBy(controlledBy, acting.length)}\n`)
    await confirmPromotion(ctx, acting.length)

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
          // The index immediately before this key's pre-import commit (BE-288, D9): what a
          // definite init answer restores, because nothing has left this machine at init.
          const preImportIndex = current.index
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
          // Phase 4b (D1): every EVM TEE promote appends its own wallet's scanStart, after the
          // write that created the record key (the batch's first EVM row).
          if (hoodHeight !== undefined) await appendScanStart(ctx, path, subject.address, hoodHeight)
          const secret = await verifySubjectSecret(current, subject)
          let privateKey: string
          try {
            privateKey = subject.chain === "evm" ? bytesToHex(secret) : base58.encode(secret)
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
            chain: subject.chain,
          })
          if (imported.failure !== undefined || imported.submitted === undefined) {
            let failure: ReturnedFailure = imported.failure ?? {
              code: "VAULT_WRITE_FAILED",
              message: "The import did not complete.",
            }
            if (restoresPreImportEntry(failure)) {
              // D9: put the entry back, then say so inside the stopped message. A refused restore
              // is caught HERE, not by the generic catch below, which would drop the init reason.
              try {
                current = hold(await commitVault(current, { index: preImportIndex }, deps))
                failure = { ...failure, message: `${failure.message} ${RESTORED_SENTENCE}` }
              } catch (error) {
                failure = restoreRefusedFailure(failure, error)
              }
            }
            stopped = {
              line: row.line,
              exit: imported.exit,
              code: failure.code,
              message: failure.message,
              ...(failure.suggestion !== undefined ? { suggestion: failure.suggestion } : {}),
            }
            break
          }
          if (imported.vault !== undefined) current = hold(imported.vault)
          await rowObserver?.({ line: row.line, stage: "imported", vault: current })
          worst = Math.max(worst, imported.exit)
          done += 1
          last = { address: subject.address, keyId: subject.id }
          rebindPhase?.importedTo.set(subject.address, imported.submitted.boundKeyPrefix ?? null)
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
        rebindPhase?.importedTo.set(subject.address, subject.tee?.boundKeyPrefix ?? null)
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
      // BE-322: the rebind is not reached when the batch stops. The rows that landed are on the
      // calling key; say so, with the finishing command, and let the re-run rebind them.
      let notReached: RebindReportInput | undefined
      if (rebindPhase !== undefined) {
        const { wallets, notRebindable } = splitRebindable(results)
        notReached = {
          target: rebindPhase.toKey.target,
          callingKeyPrefix: rebindPhase.callingKeyPrefix,
          wallets,
          notRebindable,
        }
        const report = renderRebindReport(notReached)
        if (report.length > 0) deps.stderr.write(`${report}\n`)
      }
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
          keys: rebindPhase === undefined ? results : keysWithRebind(results, rebindPhase, undefined),
          failedLine: stopped.line,
          code: stopped.code,
          message: stopped.message,
          ...(stopped.suggestion !== undefined ? { suggestion: stopped.suggestion } : {}),
          // BE-296 (D9): the stopped document carries the same two optional keys as success.
          controlledBy: controlledByJson(controlledBy),
          authorities: authoritiesJson(checked),
          ...(notReached !== undefined ? rebindJson(notReached) : {}),
        })
      } else {
        deps.stderr.write(`${stopped.message}${stopped.suggestion ? ` ${stopped.suggestion}` : ""}\n`)
      }
      return stopped.exit
    }

    // Once for the whole run, on the last row written: the vault is re-opened through the FACTOR,
    // which proves the envelopes still unwrap after every write above. The half a held-key check
    // cannot make, presented once, so a security key is touched twice for 146 keys (D9).
    if (last !== undefined) await verifyWritten(path, last.address, last.keyId, opened.reopen, ctx, chain)

    // BE-322: every row landed; now the rebind, in chunks of at most 200, then the one report.
    const rebound = rebindPhase === undefined ? undefined : await runRebindPhase(ctx, rebindPhase, results)

    return finish(ctx, {
      file: pairsFile,
      rows: rows.length,
      keys: results,
      destinations,
      exit: worst,
      controlledBy,
      roles: checked,
      ...(rebound !== undefined ? { rebound } : {}),
    })
  })
}

/** BE-322: the rebind phase over the rows that landed, and its stderr report. */
async function runRebindPhase(
  ctx: CommandContext,
  phase: RebindPhase,
  results: KeyResult[],
): Promise<{ phase: RebindPhase; run: RebindRun | undefined; input: RebindReportInput }> {
  const { wallets, notRebindable } = splitRebindable(results)
  const run =
    wallets.length > 0
      ? await rebindPromoted(ctx, phase.toKey.deviceToken, phase.toKey.target.keyPrefix, wallets)
      : undefined
  const input: RebindReportInput = {
    target: phase.toKey.target,
    callingKeyPrefix: phase.callingKeyPrefix,
    wallets,
    run,
    notRebindable,
  }
  const report = renderRebindReport(input)
  if (report.length > 0) ctx.deps.stderr.write(`${report}\n`)
  return { phase, run, input }
}

/** The shipped compare (`vault-promote.ts:372-377`): the caller owns the plaintext and wipes it. */
async function verifySubjectSecret(vault: UnlockedVault, subject: KeyEntry): Promise<Uint8Array> {
  const secret = await decryptKey(vault, subject.id)
  try {
    const matches =
      subject.chain === "evm"
        ? sameEvmAddress(evmAddressFromSecret(secret), subject.address)
        : addressFromSecret64(secret) === subject.address
    if (!matches) {
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

/**
 * The table (D8): one row per file row, in file order, the `state` column first after the line.
 * `line` is the file line (BE-296, D10), and `authority` (BE-296, D8) holds every finding for an
 * acting key in full, `none` when every group was read and nothing was found, `?` when some group
 * was not read for it, and nothing for a skip row.
 */
function renderBatchTable(
  planned: PlannedRow[],
  opts: {
    lamports?: Map<string, bigint>
    tokenCounts?: Map<string, number>
    hasValueUsd: boolean
    roles?: SignerRolesResult
    /** Phase 4b: an EVM batch's holdings (ETH, USDG, WETH), shown in place of SOL. */
    evmHoldings?: Map<string, EvmHoldings>
  },
): string {
  const evm = opts.evmHoldings !== undefined
  const headers = ["line", "state", "label", "address", "destination", "authority"]
  headers.push(evm ? "ETH" : opts.tokenCounts !== undefined ? "SOL" : "SOL (tokens not read)")
  if (evm) headers.push("USDG", "WETH")
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
    const authority = item.kind === "skip" ? "" : opts.roles === undefined ? "?" : authorityCell(address, opts.roles)
    const cells = [String(item.row.line), state, item.subject.label, address, destination, authority]
    const lamports = opts.lamports?.get(address)
    cells.push(lamports === undefined ? "unread" : evm ? formatUnits(lamports, NATIVE_DECIMALS) : formatSol(lamports))
    if (evm) {
      const held = opts.evmHoldings?.get(address)
      cells.push(held === undefined ? "unread" : formatUnits(held.usdg, HOOD_USDG_DECIMALS))
      cells.push(held === undefined ? "unread" : formatUnits(held.weth, NATIVE_DECIMALS))
    }
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
  /** BE-288 (§4.3): the room this run was checked against, and the `promote` rows that take a slot. */
  room: AccountRoom
  promotes: number
  /** BE-296 (D8): the role read, when it ran (it does not when the SOL read failed). */
  roles?: SignerRolesResult
  /** Phase 4b: an EVM batch reads ETH over the Hood RPC and no authority. */
  evm?: boolean
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
  lines.push(
    `Linked wallets: ${opts.room.active} of ${opts.room.cap} active on the ${tierName(opts.room.tier)} tier; this run links ${opts.promotes}, leaving ${opts.room.room - opts.promotes}.`,
  )
  if (opts.evm) {
    lines.push(
      opts.readError !== undefined
        ? `ETH read over ${opts.host} FAILED: ${opts.readError}. The batch is refused.`
        : `ETH read at ${opts.observedAt} over ${opts.host} (Hood). The signer-role read is Solana's; no authority is read on Hood.`,
    )
  } else if (opts.readError !== undefined) {
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
  // BE-296 (D8): the count, then what was and was not read, after the SOL line; the destination
  // roll-up above does not move. Only when there was something to check.
  if (opts.roles !== undefined && opts.acting.length > 0) {
    lines.push(authoritiesCountLine(opts.acting.length, opts.roles))
    lines.push(readSummaryLine(opts.host, opts.roles))
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
    controlledBy: ControlledBy
    roles: SignerRolesResult
    /** BE-322: the rebind phase, when `--to-key` was given. */
    rebound?: { phase: RebindPhase; run: RebindRun | undefined; input: RebindReportInput }
  },
): number {
  const promoted = opts.keys.filter((r) => r.state === "promoted").length
  const resumed = opts.keys.filter((r) => r.state === "resumed").length
  const skipped = opts.keys.filter((r) => r.state === "skipped").length
  const unverified = opts.keys.filter((r) => r.state !== "skipped" && r.remoteAuthority !== "verified-active")
  // BE-322: a rebind that failed is not done. A wallet that cannot move yet does not change the
  // exit on its own: it is already the exit-3 case the import reported.
  const rebindFailed = opts.rebound?.run !== undefined && !opts.rebound.run.ok
  const exit = rebindFailed ? Math.max(opts.exit, 1) : opts.exit
  const complete = exit === 0
  if (ctx.json) {
    writeJson(ctx.deps, {
      ok: !rebindFailed,
      complete,
      file: opts.file,
      rows: opts.rows,
      promoted,
      resumed,
      skipped,
      destinations: opts.destinations.map(({ label, address, keys }) => ({ label, address, keys })),
      keys: opts.rebound === undefined ? opts.keys : keysWithRebind(opts.keys, opts.rebound.phase, opts.rebound.run),
      // BE-296 (D9): optional keys only; every key above is unchanged.
      controlledBy: controlledByJson(opts.controlledBy),
      authorities: authoritiesJson(opts.roles),
      ...(opts.rebound !== undefined ? rebindJson(opts.rebound.input) : {}),
    })
    return exit
  }
  const parts: string[] = []
  if (promoted > 0)
    parts.push(`${promoted} address${promoted === 1 ? "" : "es"} promoted under one unlock, each committed on its own`)
  if (resumed > 0) parts.push(`${resumed} resumed`)
  if (skipped > 0) parts.push(`${skipped} already promoted (skipped)`)
  ctx.deps.stdout.write(`${parts.join("; ")}.\n`)
  if (unverified.length > 0) {
    ctx.deps.stdout.write(
      `${unverified.length} import${unverified.length === 1 ? "" : "s"} did not report verified-active: ${unverified
        .map((r) => r.address)
        .join(", ")}\n`,
    )
  }
  if (opts.rebound !== undefined) {
    const { input, run } = opts.rebound
    const moved = input.wallets.filter((w) => run?.outcomes.get(w.id)?.state === "rebound").length
    const already = input.wallets.filter((w) => run?.outcomes.get(w.id)?.state === "unchanged").length
    const pending = input.wallets.length - moved - already
    ctx.deps.stdout.write(
      `${moved + already} of ${input.wallets.length + input.notRebindable.length} wallets bound to ${input.target.keyPrefix}${
        pending > 0 ? `; ${pending} still on ${input.callingKeyPrefix}` : ""
      }${input.notRebindable.length > 0 ? `; ${input.notRebindable.length} not yet rebindable` : ""}.\n`,
    )
  }
  return exit
}
