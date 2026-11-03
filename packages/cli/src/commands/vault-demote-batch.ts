/**
 * BE-2597 (WAIFULAB W10): `candle vault demote <a> <b> ...` and `candle vault demote --all --empty`.
 *
 * Many single demotes, one after another, under ONE unlock and ONE confirmation for the set:
 *
 * - The vault is unlocked once. Each wallet then runs the unchanged single demote
 *   (`vaultDemote`), whose own unlock is answered from the held key (`HeldUnlock`,
 *   `reopenWithHeldDek`) with a fresh copy of the DEK it may close. Nothing signs in parallel.
 * - Every wallet is listed with the destination its sweep goes to before anything runs, and the
 *   operator types `confirm` once (`--yes` skips it). That confirmation stands in for each sweep's
 *   own `Type confirm to sweep everything to <destination>` prompt, and only for the destination
 *   listed for that wallet; any other prompt a wallet raises (adopting a server pin, acting as a
 *   cached account) still goes to the operator.
 * - A wallet that fails does not stop the batch. Each wallet gets a result line, and the summary
 *   counts done / incomplete / failed / skipped with their reasons. Exit 0 only when every wallet
 *   acted on finished (single demote's 0); 1 when any failed; otherwise 3 when any is incomplete
 *   (single demote's 3: the disable is not verified, so remote authority may still be open).
 * - `--json` writes ONE document on stdout, `{ ok, wallets: [...], summary }`, and nothing else:
 *   each wallet's own output is captured and parsed into its `results`, and any line of it that is
 *   not JSON goes to stderr.
 */
import { parseArgs } from "../args"
import type { CommandContext, Deps, Writer } from "../deps"
import { writeTable } from "../human-output"
import { notice } from "../presentation"
import { openSolanaClient, type SolanaClient } from "../solana-endpoint"
import { isVaultError, VaultError } from "../vault/errors"
import type { KeyEntry } from "../vault/format"
import { assertColdVaultDestination } from "../vault/promote-support"
import { reopenWithHeldDek, type UnlockedVault } from "../vault/store"
import { nothingLeftToSweep } from "./tee"
import { vaultDemote } from "./vault-demote"
import {
  type HeldUnlock,
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

export const BATCH_USAGE =
  "Usage: candle vault demote <tee-address> <tee-address>... | --all --empty [--rpc-url <url>] [--emergency] [--sweep-to <label>] [--yes]"

/** Flags that take a value, so their value is not counted as an address. */
const VALUE_FLAGS = new Set(["--rpc-url", "--keystore", "-k", "--sweep-to", "--from-block", "--token"])
/** Flags only a batch takes; any of them makes a one-address demote a batch of one. */
const BATCH_FLAGS = new Set(["--all", "--empty", "--yes"])
/** Hood-only sweep flags, which name one wallet's tokens and scan start, not a set's. */
const SINGLE_ONLY_FLAGS = ["--token", "--from-block", "--accept-unknown-exposure"]

/** True when `vault demote` was given more than one address or a batch flag. */
export function isBatchDemote(args: string[]): boolean {
  let addresses = 0
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (VALUE_FLAGS.has(arg)) {
      i += 1
      continue
    }
    if (BATCH_FLAGS.has(arg)) return true
    if (!arg.startsWith("-")) addresses += 1
  }
  return addresses > 1
}

type Chain = "solana" | "evm"
type Status = "done" | "incomplete" | "failed" | "skipped"

/** One wallet's line in the `--json` document and the summary. */
export interface WalletOutcome {
  address: string
  label: string | null
  chain: Chain | null
  status: Status
  /** The single demote's exit code; absent for a wallet that was not run. */
  exitCode?: number
  /** The failure code, from the wallet's own failure envelope when it wrote one. */
  code?: string
  reason?: string
  /** `--json`: every document the wallet's demote wrote, in order. */
  results?: unknown[]
}

interface Planned {
  address: string
  label: string
  chain: Chain
  /** Where its sweep goes: the pin, else what `--sweep-to` resolves to here, else null. */
  destination: string | null
  destinationNote?: string
}

const isEvmAddress = (value: string) => /^0x[0-9a-fA-F]{40}$/.test(value)
const sameAddress = (chain: Chain, a: string, b: string) =>
  chain === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b

export async function vaultDemoteBatch(args: string[], ctx: CommandContext): Promise<number> {
  const single = SINGLE_ONLY_FLAGS.find((flag) => args.includes(flag))
  if (single !== undefined) {
    return usage(
      ctx,
      `${single} names one Hood wallet's sweep; pass it to a single demote: candle vault demote <0x address> ${single} ...`,
    )
  }
  const parsed = parseArgs(args, {
    valueFlags: ["--rpc-url", "--sweep-to", "--keystore"],
    booleanFlags: ["--emergency", "--accept-older-copy", "--all", "--empty", "--yes"],
    pathFlags: ["--keystore"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const all = parsed.booleans.has("--all")
  const empty = parsed.booleans.has("--empty")
  const yes = parsed.booleans.has("--yes")
  if (all && parsed.positionals.length > 0) return usage(ctx, `--all takes no addresses. ${BATCH_USAGE}`)
  if (all && !empty) {
    return usage(ctx, `--all needs a filter: --empty (wallets with nothing left to sweep). ${BATCH_USAGE}`)
  }
  if (empty && !all) return usage(ctx, `--empty filters --all. ${BATCH_USAGE}`)
  if (!all && parsed.positionals.length === 0) return usage(ctx, BATCH_USAGE)
  const rpcUrl = parsed.values["--rpc-url"]
  const sweepTo = parsed.values["--sweep-to"]
  const named = parsed.positionals
  if (rpcUrl !== undefined && named.some(isEvmAddress) && named.some((a) => !isEvmAddress(a))) {
    return usage(ctx, "--rpc-url names one chain's node; demote Solana and Hood wallets in separate batches.")
  }
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "vault demote")) return 1
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  // `--empty` reads Solana balances before anything runs. Building the client makes no request.
  let solana: SolanaClient | undefined
  if (empty) {
    const opened = await openSolanaClient(ctx, rpcUrl)
    if ("error" in opened) return usage(ctx, opened.error)
    solana = opened
  }

  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await requireVaultRaw(ctx, resolvedVault)
    const opened = await unlockInteractively(ctx, resolvedVault.path, raw, {
      acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
    })
    const held = hold(opened.vault)

    // ── Selection: who is acted on, who is skipped and why ──
    const outcomes: WalletOutcome[] = []
    const planned: Planned[] = []
    const plan = (entry: KeyEntry) => {
      const chain: Chain = entry.chain === "evm" ? "evm" : "solana"
      const row: Planned = { address: entry.address, label: entry.label, chain, destination: null }
      const pinned = entry.tee?.vaultDestination
      if (pinned !== undefined) row.destination = pinned
      else if (sweepTo === undefined) row.destinationNote = "no pinned destination; pass --sweep-to"
      else {
        try {
          row.destination = assertColdVaultDestination(held.index, sweepTo, {
            chain,
            subjectAddress: entry.address,
          }).address
        } catch (error) {
          if (!isVaultError(error)) throw error
          row.destinationNote = `--sweep-to ${sweepTo}: ${error.message}`
        }
      }
      planned.push(row)
    }
    const tees = held.index.entries.filter((entry) => entry.role === "tee-wallet")
    if (all) {
      for (const entry of tees) {
        if (entry.tee?.lifecycle === "retired") continue
        const base = {
          address: entry.address,
          label: entry.label,
          chain: entry.chain === "evm" ? "evm" : "solana",
        } as const
        if (entry.chain === "evm") {
          outcomes.push({
            ...base,
            status: "skipped",
            reason: "--empty reads Solana balances only; demote a Hood wallet by its address",
          })
          continue
        }
        if (!(await nothingLeftToSweep(solana as SolanaClient, entry))) {
          outcomes.push({
            ...base,
            status: "skipped",
            reason: "not empty: it holds SOL or token accounts, or an earlier sweep is unsettled",
          })
          continue
        }
        plan(entry)
      }
    } else {
      const seen: string[] = []
      for (const address of named) {
        const chain: Chain = isEvmAddress(address) ? "evm" : "solana"
        if (seen.some((other) => sameAddress(chain, other, address))) {
          outcomes.push({ address, label: null, chain, status: "skipped", reason: "listed more than once" })
          continue
        }
        seen.push(address)
        const entry = tees.find((candidate) => sameAddress(chain, candidate.address, address))
        if (entry === undefined) {
          outcomes.push({
            address,
            label: null,
            chain,
            status: "failed",
            code: "TEE_WALLET_UNKNOWN",
            reason: `${address} is not a TEE wallet in the vault`,
          })
          continue
        }
        if (entry.tee?.lifecycle === "retired") {
          outcomes.push({
            address,
            label: entry.label,
            chain,
            status: "skipped",
            reason: "already retired (demoted and swept)",
          })
          continue
        }
        plan(entry)
      }
    }
    if (rpcUrl !== undefined && new Set(planned.map((row) => row.chain)).size > 1) {
      return usage(ctx, "--rpc-url names one chain's node; demote Solana and Hood wallets in separate batches.")
    }

    // ── The one confirmation ──
    if (planned.length > 0) {
      const display: "stdout" | "stderr" = ctx.json ? "stderr" : "stdout"
      ctx.deps[display].write(
        `Demote ${planned.length} TEE wallet${planned.length === 1 ? "" : "s"}, one at a time: disable, then sweep to the destination shown.\n`,
      )
      writeTable(
        ctx.deps,
        display,
        ["#", "TEE wallet", "Label", "Sweeps to"],
        planned.map((row, i) => [
          String(i + 1),
          row.address,
          row.label,
          row.destination ?? `none (${row.destinationNote})`,
        ]),
        [],
      )
      for (const skipped of outcomes) {
        ctx.deps[display].write(`Not demoted: ${skipped.address}: ${skipped.reason}\n`)
      }
      if (!yes) {
        const typed = await ctx.deps.promptLine(`Type confirm to demote these ${planned.length} wallets: `)
        if (typed.trim().toLowerCase() !== "confirm") {
          throw new VaultError("DESTINATION_NOT_CONFIRMED", "The batch was not confirmed; nothing was done.", {
            suggestion: "Nothing was disabled or swept. Run it again and type confirm at the prompt.",
          })
        }
      }
    }

    // ── The loop: one wallet at a time, continue on error ──
    const session: HeldUnlock = { path: held.path, open: (bytes) => openHeld(opened, held, bytes) }
    const width = String(planned.length).length
    for (const [i, row] of planned.entries()) {
      if (!ctx.json) {
        notice(
          ctx.deps,
          "stdout",
          "note",
          `[${String(i + 1).padStart(width)}/${planned.length}] Demoting ${row.address} (${row.label})`,
        )
      }
      const outcome = await demoteOne(ctx, session, row, parsed.values, parsed.booleans)
      outcomes.push(outcome)
      if (!ctx.json) writeResultLine(ctx.deps, outcome)
    }

    // ── The summary ──
    const count = (status: Status) => outcomes.filter((o) => o.status === status).length
    const summary = {
      total: outcomes.length,
      done: count("done"),
      incomplete: count("incomplete"),
      failed: count("failed"),
      skipped: count("skipped"),
    }
    const exit = summary.failed > 0 ? 1 : summary.incomplete > 0 ? 3 : 0
    if (ctx.json) {
      writeJson(ctx.deps, { ok: exit === 0, wallets: outcomes, summary })
      return exit
    }
    ctx.deps.stdout.write(
      `\nSummary: ${summary.done} done, ${summary.incomplete} incomplete, ${summary.failed} failed, ${summary.skipped} skipped (of ${summary.total}).\n`,
    )
    for (const outcome of outcomes) {
      if (outcome.status === "done") continue
      ctx.deps.stdout.write(
        `  ${outcome.status.padEnd(10)} ${outcome.address}${outcome.reason ? `: ${outcome.reason}` : ""}\n`,
      )
    }
    return exit
  })
}

/**
 * Answers a wallet's unlock from the batch's held key: the file's current bytes, a DEK copy the
 * wallet's demote closes itself, and the opener's factor for anything that asks which one it was.
 */
async function openHeld(opened: OpenedVault, held: UnlockedVault, raw: string): Promise<OpenedVault> {
  const vault = await reopenWithHeldDek(held.path, raw, held)
  return {
    vault,
    factor: opened.factor,
    reopen: (path, bytes) => reopenWithHeldDek(path, bytes, held),
    confirm: opened.confirm,
  }
}

/** Runs the single demote for one wallet, capturing what it needs to report the outcome. */
async function demoteOne(
  ctx: CommandContext,
  session: HeldUnlock,
  row: Planned,
  values: Record<string, string>,
  booleans: Set<string>,
): Promise<WalletOutcome> {
  const base = { address: row.address, label: row.label, chain: row.chain }
  const args = [row.address]
  for (const flag of ["--rpc-url", "--sweep-to", "--keystore"]) {
    const value = values[flag]
    if (value !== undefined) args.push(flag, value)
  }
  for (const flag of ["--emergency", "--accept-older-copy"]) if (booleans.has(flag)) args.push(flag)

  // The batch's confirmation covers this wallet's sweep to the destination listed, and only that.
  const covered = row.destination === null ? null : `Type confirm to sweep everything to ${row.destination}: `
  const promptLine = async (text: string) => (text === covered ? "confirm" : ctx.deps.promptLine(text))
  const captured: string[] = []
  const errLines: string[] = []
  const stdout: Writer = ctx.json ? { write: (chunk) => void captured.push(chunk) } : ctx.deps.stdout
  const stderr: Writer = {
    write: (chunk) => {
      errLines.push(chunk)
      ctx.deps.stderr.write(chunk)
    },
  }
  const deps: Deps = { ...ctx.deps, stdout, stderr, promptLine }
  const step: CommandContext = { ...ctx, deps, heldUnlock: session }

  let exitCode: number
  let thrown: string | undefined
  try {
    exitCode = await vaultDemote(args, step)
  } catch (error) {
    // A throw out of one wallet is that wallet's failure; the batch goes on to the next.
    exitCode = 1
    thrown = error instanceof Error ? error.message : String(error)
  }

  const outcome: WalletOutcome = {
    ...base,
    status: exitCode === 0 ? "done" : exitCode === 3 ? "incomplete" : "failed",
    exitCode,
  }
  if (ctx.json) {
    const results: unknown[] = []
    for (const line of captured.join("").split("\n")) {
      if (line.trim() === "") continue
      try {
        results.push(JSON.parse(line))
      } catch {
        // Human text a wallet's demote wrote to stdout under --json: kept, but off stdout.
        ctx.deps.stderr.write(`${line}\n`)
      }
    }
    outcome.results = results
    const failure = [...results]
      .reverse()
      .find(
        (doc): doc is { ok: false; code?: string; message?: string } =>
          typeof doc === "object" && doc !== null && (doc as { ok?: unknown }).ok === false,
      )
    if (failure !== undefined && exitCode !== 0) {
      if (typeof failure.code === "string") outcome.code = failure.code
      if (typeof failure.message === "string") outcome.reason = failure.message
    }
  }
  if (thrown !== undefined) outcome.reason = thrown
  if (outcome.reason === undefined && exitCode === 3) {
    outcome.reason = "the disable is not verified or funds remain; remote authority may still be open"
  } else if (outcome.reason === undefined && exitCode !== 0) {
    // Human mode, best effort: the first sentence of the first thing the wallet's demote wrote to
    // stderr, which on every refusal path is the failure itself. `--json` carries the exact code.
    const first = errLines.find((chunk) => chunk.trim() !== "" && !chunk.includes("vault.state.json"))
    outcome.reason = firstSentence(first ?? "") ?? `exit ${exitCode}`
  }
  return outcome
}

/** `\n  ! The stop request failed: x.\n    Stop intent ...` → `The stop request failed: x.` */
function firstSentence(chunk: string): string | undefined {
  const text = chunk
    .replace(/\s+/g, " ")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim()
  if (text === "") return undefined
  const end = text.search(/\.(\s|$)/)
  return end < 0 ? text : text.slice(0, end + 1)
}

function writeResultLine(deps: Deps, outcome: WalletOutcome): void {
  const word = { done: "done", incomplete: "incomplete", failed: "FAILED", skipped: "skipped" }[outcome.status]
  deps.stdout.write(
    `Result ${outcome.address}: ${word} (exit ${outcome.exitCode})${outcome.reason && outcome.status !== "done" ? `: ${outcome.reason}` : ""}\n`,
  )
}
