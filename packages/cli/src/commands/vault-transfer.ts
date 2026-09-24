/**
 * Ember Phase 2 PR C (ED-10, CC-08): `candle vault transfer`.
 *
 * Vault keys build and sign only the two transfer shapes, decoded and displayed before the factor
 * prompt, with the destination confirmed by typing its last six characters.
 *
 * BE-326 (ED-10 amendment, 2026-09-24): `--from` may also name a promoted wallet
 * (`role: "tee-wallet"`), under every safeguard above. For that source only, a pending sweep
 * refuses before anything is signed, the wallet's server state is read and an enabled wallet is
 * warned about before the confirmation, and a finalized transfer is reported to Candle's activity
 * history. A vault key's transfer is unchanged.
 *
 * Phase 4a (BE-350, D3, D5, D6): `--from` may name an EVM `role: "vault"` key, and then the transfer
 * is the EVM flow in `vault/evm-transfer.ts`: the native asset or an ERC-20, signed locally through
 * `evm-lite`, on Hood by default (the built-in RPC) or on any EVM chain by `--rpc-url`. The chain
 * is chosen by the `--from` entry's `chain`, never by a flag: a Solana `--from` still requires
 * `--rpc-url` and still sends to a Solana address; an EVM `--from` makes `--rpc-url` optional (else
 * `CANDLE_EVM_RPC_URL`, else Hood) and sends to a 0x address. A destination of the other family
 * refuses with `TRANSFER_CHAIN_MISMATCH` before any read.
 */
import { parseArgs } from "../args"
import { type CommandContext, resolveApiKey } from "../deps"
import { createEvmRpc, EVM_RPC_URL_ENV, resolveEvmRpcUrl } from "../evm-lite"
import { VaultError } from "../vault/errors"
import { assertSolanaDestination, runEvmTransfer } from "../vault/evm-transfer"
import { reconcileFundingReceipts } from "../vault/funding-receipts"
import { wipe } from "../vault/hygiene"
import { findTransferSource } from "../vault/promote-support"
import { decryptKey } from "../vault/store"
import {
  type ActivityReportOutcome,
  assertNoPendingSweep,
  readTeeServerState,
  reportTransferActivity,
  serverStateNotice,
} from "../vault/tee-transfer"
import {
  assertTransferSigner,
  displayTransferPlan,
  planTransfer,
  quoteTransferFee,
  signAndBroadcastTransfer,
} from "../vault/vault-transfer-sign"
import {
  confirmLastSix,
  refuseEnvPassphrase,
  requireTty,
  requireVaultRaw,
  runVaultCommand,
  unlockInteractively,
  usage,
  vaultPathFor,
  writeJson,
} from "./vault-support"

export async function vaultTransfer(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--amount", "--asset", "--from", "--rpc-url", "--keystore"],
    booleanFlags: ["--accept-older-copy"],
    pathFlags: ["--keystore"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  const [to, extra] = parsed.positionals
  if (!to || extra !== undefined) {
    return usage(
      ctx,
      "Usage: candle vault transfer <to> --amount <n|max> --asset SOL|<mint>|ETH|USDG|<0x token> --from <label> [--rpc-url <url>]",
    )
  }
  const amount = parsed.values["--amount"]
  const asset = parsed.values["--asset"]
  const fromLabel = parsed.values["--from"]
  const rpcUrlFlag = parsed.values["--rpc-url"]
  if (!amount) return usage(ctx, "--amount <n> is required.")
  if (!asset) return usage(ctx, "--asset SOL|<mint>|ETH|USDG|<0x token> is required.")
  if (!fromLabel) return usage(ctx, "--from <label> is required.")
  // The flag is checked before unlock, as it always was. A blank `CANDLE_EVM_RPC_URL` is unset;
  // an env value that does not parse is a usage error here too, before the passphrase. The flag
  // itself may be a Solana endpoint, so the https rule is applied only once the key is EVM.
  if (rpcUrlFlag !== undefined) {
    try {
      new URL(rpcUrlFlag)
    } catch {
      return usage(ctx, `--rpc-url is not a valid URL: ${rpcUrlFlag}`)
    }
  } else {
    const evmFromEnv = resolveEvmRpcUrl(undefined, ctx.deps.env[EVM_RPC_URL_ENV], "--rpc-url")
    if ("error" in evmFromEnv) return usage(ctx, evmFromEnv.error)
  }
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "vault transfer")) return 1

  const resolvedVault = vaultPathFor(ctx, parsed)

  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)

  const path = resolvedVault.path
  return runVaultCommand(ctx, async ({ hold }) => {
    const raw = await requireVaultRaw(ctx, resolvedVault)
    const opened = await unlockInteractively(ctx, path, raw, {
      acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
      promptText: "Vault passphrase (input hidden): ",
    })
    const vault = hold(opened.vault)
    const fromEntry = findTransferSource(vault.index, fromLabel)
    if (fromEntry === undefined) {
      return usage(ctx, `No vault key or promoted wallet matches --from ${fromLabel}.`)
    }
    assertTransferSigner(fromEntry)

    if (fromEntry.chain === "evm") {
      // Phase 4a (D5): an EVM `role: "vault"` key. 4b widens this to a promoted EVM wallet.
      if (fromEntry.role !== "vault") {
        throw new VaultError(
          "PROMOTE_NOT_VAULT_KEY",
          `${fromEntry.label || fromEntry.address} is an EVM ${fromEntry.role} entry; this release signs EVM transfers from vault keys only.`,
          { suggestion: "Nothing was signed." },
        )
      }
      // D3: `--rpc-url`, else `CANDLE_EVM_RPC_URL`, else the built-in Hood RPC (Andrew's "Hood
      // built in"). The Solana endpoint variable is never consulted for an EVM key. `builtIn`
      // follows the URL actually used. A blank value was already treated as unset.
      const evmRpc = resolveEvmRpcUrl(rpcUrlFlag, ctx.deps.env[EVM_RPC_URL_ENV], "--rpc-url")
      if ("error" in evmRpc) return usage(ctx, evmRpc.error)
      const evmRpcUrl = evmRpc.url
      const secretRef = fromEntry
      return runEvmTransfer(
        {
          ctx,
          rpcUrl: evmRpcUrl,
          builtIn: evmRpc.builtIn,
          from: fromEntry,
          to,
          amount,
          asset,
          confirmLastSix: (address, what) => confirmLastSix(ctx, address, what),
          confirmFactor: (what) => opened.confirm(what),
          decryptSecret: () => decryptKey(vault, secretRef.id),
          usage: (line) => usage(ctx, line),
          writeJson: (value) => writeJson(ctx.deps, value),
        },
        createEvmRpc(evmRpcUrl, ctx.deps.fetch),
      )
    }

    // A Solana key: the endpoint is required, as it always was, and the destination must be Solana's.
    assertSolanaDestination(to, fromEntry)
    const rpcUrl = rpcUrlFlag
    if (!rpcUrl) return usage(ctx, "--rpc-url <url> is required for a transfer from a Solana key.")
    const promoted = fromEntry.role === "tee-wallet"
    if (promoted) assertNoPendingSweep(fromEntry)
    // These lines are diagnostics: stdout for a person, stderr under `--json`.
    const note = (line: string) => (ctx.json ? ctx.deps.stderr : ctx.deps.stdout).write(`${line}\n`)
    const apiKey = promoted ? await resolveApiKey(ctx.deps, ctx.profile) : undefined
    const reconciled = await reconcileFundingReceipts(vault, [fromEntry.address, to], rpcUrl, ctx)
    if (reconciled !== null) return reconciled

    const plan = await planTransfer({
      from: fromEntry.address,
      to,
      amount,
      asset,
      rpcUrl,
      fetch: ctx.deps.fetch,
    })
    const feeQuote = await quoteTransferFee(rpcUrl, ctx.deps.fetch, plan.from, plan.instructions)
    displayTransferPlan(ctx, plan, feeQuote)
    if (promoted) {
      const notice = serverStateNotice(await readTeeServerState(ctx, fromEntry, apiKey))
      if (notice !== undefined) note(notice)
    }
    await confirmLastSix(ctx, to, "the destination")

    // The factor a second time before anything is signed: the passphrase typed again, or the
    // security key touched again. A mismatch refuses without signing; the vault is already open.
    await opened.confirm(`sign transfer of ${plan.amount} ${plan.asset} to ${to}`)

    const secret = await decryptKey(vault, fromEntry.id)
    try {
      const result = await signAndBroadcastTransfer({ ctx, rpcUrl, secret64: secret, plan })
      // Only a finalized transfer is reported; the server verifies it on chain. A report failure
      // is a line of output, never an exit code.
      let activityReport: ActivityReportOutcome | "not-finalized" | undefined
      if (promoted && result.finalized) {
        const report = await reportTransferActivity(ctx, apiKey, result.signature)
        activityReport = report.outcome
        note(report.line)
      } else if (promoted) {
        activityReport = "not-finalized"
        note("Not reported to Candle's history: finality is not yet confirmed.")
      }
      if (ctx.json) {
        writeJson(ctx.deps, {
          ok: result.finalized,
          signature: result.signature,
          from: plan.from,
          to: plan.to,
          amount: plan.amount,
          asset: plan.asset,
          amountRaw: plan.amountRaw.toString(),
          finalized: result.finalized,
          ...(activityReport !== undefined ? { activityReport } : {}),
        })
      } else {
        ctx.deps.stdout.write(
          result.finalized
            ? `Transferred ${plan.amount} ${plan.asset} to ${to}: ${result.signature}\n`
            : `Submitted ${result.signature}; finality is not yet confirmed.\n`,
        )
      }
      return result.finalized ? 0 : 3
    } finally {
      wipe(secret)
    }
  })
}
