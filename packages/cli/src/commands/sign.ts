/**
 * Ember Phase 3 PR F (BE-226, R6, P3-AD-10, P3-AD-13): `candle sign` and `candle sign message`.
 *
 * The generic signer, like a wallet's approval screen: a transaction built by any tool (a plug-in,
 * the user's own script, a service's API called with the user's key) is decoded, simulated and
 * displayed, and then signed with an EXTERNAL key and nothing else. It is a signing oracle for one
 * key, so every step is a build requirement, not a description:
 *
 * 1. **Decode, including lookup tables, before anything is displayed.** The input is strict
 *    base64 of exactly one legacy or v0 transaction (`SIGN_TRANSACTION_UNDECODABLE` otherwise). A
 *    v0 message commits only to lookup-table pubkeys and indexes, so its account list is
 *    reconstructed in compiled order from the fetched tables first (`solana-alt.ts`); a table that
 *    cannot be fetched or an index past its end is `SIGN_LOOKUP_TABLE_UNRESOLVED`, raised only
 *    after a supported v0 transaction decoded. A partially decoded transaction is never displayed.
 * 2. **Refusals, before any prompt and unaffected by `--yes`.** Every account the transaction
 *    requires as a signer, the fee payer included, must be a `role: "external"` entry of this
 *    vault: a vault key, a TEE wallet, or an address this vault does not hold is
 *    `SIGN_SIGNER_NOT_EXTERNAL`, naming it and what it is; a required external signer the
 *    operator did not name is `SIGN_SIGNER_NOT_PROVIDED`. This command reaches no vault or TEE key
 *    on any path, so these are not checks a flag can skip.
 * 3. **Simulate, and refuse when it fails.** `simulateTransaction` over the user's RPC with
 *    signature verification off. An error, or an RPC that cannot be reached, is
 *    `SIGN_SIMULATION_FAILED` with the program error and the logs. There is no "sign anyway".
 * 4. **Display** the fee payer, every program called, the signing wallet's own before -> after
 *    deltas in lamports and per token account, every other account taking a positive delta, and
 *    R5's warnings for every mint involved (warn, never refuse). The display says that a
 *    simulation is evidence and not a guarantee.
 * 5. **Confirm, then sign.** The factor is presented a second time (the passphrase typed again,
 *    or the key touched again), as every other ceremony that moves value does; `--yes` skips
 *    that and nothing else. `--broadcast` sends over the user's RPC (`SIGN_BROADCAST_FAILED`).
 *
 * What bounds the damage of `--yes` is the wallet's balance, which `vault fund` sets: vault-signed,
 * decoded, last-six-confirmed and with no `--yes` of its own.
 *
 * `sign message` signs an off-chain message (a sign-in, say) from the same byte stream contract:
 * `--file` or stdin, the bytes exactly as read. The display is never lossy: always the byte length
 * and the SHA-256; the text only when it is valid UTF-8 with no C0 or C1 control other than
 * newline, hex otherwise. No rendering that dropped or altered a byte is ever signed.
 */
import { sha256 } from "@noble/hashes/sha256"
import { base58 } from "@scure/base"
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import {
  attachSignatures,
  type CompiledKeys,
  computeDeltas,
  type DecodedTransaction,
  decodeStrictBase64,
  decodeTransaction,
  LookupTableError,
  programNameOf,
  resolveCompiledKeys,
  type SimulationSnapshot,
  simulateWithSnapshots,
  TransactionDecodeError,
} from "../solana-alt"
import { describeRpcFailure, notePostSignatureRateLimit, openSolanaClient } from "../solana-endpoint"
import { isRateLimited, type SolanaRpc, signMessage as signBytes, toBase64 } from "../solana-lite"
import { type MintProfile, parseMintAccount } from "../token-2022"
import { VaultError } from "../vault/errors"
import type { KeyEntry, UnlockedVaultIndex } from "../vault/format"
import { wipe } from "../vault/hygiene"
import { assertNotEvmEntry } from "../vault/promote-support"
import { decryptKey } from "../vault/store"
import {
  describeRole,
  findExternalEntry,
  refuseEnvPassphrase,
  requireTty,
  requireVaultRaw,
  runVaultCommand,
  takeRepeatedFlag,
  unlockInteractively,
  usage,
  vaultPathFor,
  writeJson,
} from "./vault-support"

type Index = UnlockedVaultIndex

async function readInput(ctx: CommandContext, file: string | undefined): Promise<Uint8Array> {
  if (file !== undefined) return ctx.deps.readBytes(file)
  return ctx.deps.readStdin()
}

/** The refusals a signer set earns (step 2). Evaluated in full before any prompt. */
export function assertExternalSigners(
  index: Index,
  compiled: CompiledKeys,
  numRequiredSignatures: number,
  named: KeyEntry[],
): KeyEntry[] {
  const required = compiled.keys.slice(0, numRequiredSignatures)
  const signers: KeyEntry[] = []
  for (const [i, address] of required.entries()) {
    const entry = index.entries.find((candidate) => candidate.address === address)
    const role = i === 0 ? "the fee payer" : `signer ${i}`
    if (entry === undefined) {
      throw new VaultError(
        "SIGN_SIGNER_NOT_EXTERNAL",
        `${address} (${role}) is not an address this vault holds. candle sign signs only with this vault's external wallets.`,
        {
          suggestion:
            "Nothing was signed. Only an external wallet signs here: candle external new, or candle external list for the ones you have.",
        },
      )
    }
    if (entry.role !== "external") {
      throw new VaultError(
        "SIGN_SIGNER_NOT_EXTERNAL",
        `${address} (${role}) is ${describeRole(entry)}${entry.label ? ` "${entry.label}"` : ""}, which never signs for an outside tool. Only an external wallet does (candle external new).`,
        {
          suggestion:
            "Nothing was signed. Only an external wallet signs here: candle external new, or candle external list for the ones you have.",
        },
      )
    }
    const provided = named.find((candidate) => candidate.id === entry.id)
    if (provided === undefined) {
      throw new VaultError(
        "SIGN_SIGNER_NOT_PROVIDED",
        `${address} (${role}) is external wallet "${entry.label}", and this invocation did not name it. Nothing was signed rather than returning a half-signed transaction.`,
        { suggestion: `Add: --wallet ${entry.label}` },
      )
    }
    signers.push(entry)
  }
  return signers
}

interface MintInfo {
  decimals?: number
  risks: string[]
}

async function readMints(rpc: SolanaRpc, mints: string[]): Promise<Map<string, MintInfo>> {
  const out = new Map<string, MintInfo>()
  if (mints.length === 0) return out
  let accounts: Awaited<ReturnType<SolanaRpc["getMultipleAccounts"]>>
  try {
    accounts = await rpc.getMultipleAccounts(mints)
  } catch {
    for (const mint of mints)
      out.set(mint, { risks: ["the mint could not be read, so its decimals and warnings are unknown"] })
    return out
  }
  for (const [i, mint] of mints.entries()) {
    const account = accounts[i]
    if (!account) {
      out.set(mint, { risks: ["the mint does not exist, so its decimals and warnings are unknown"] })
      continue
    }
    try {
      const profile: MintProfile = parseMintAccount(mint, account.owner, account.data)
      out.set(mint, { decimals: profile.decimals, risks: profile.risks.map((risk) => risk.message) })
    } catch (error) {
      out.set(mint, { risks: [`the mint could not be parsed (${error instanceof Error ? error.message : error})`] })
    }
  }
  return out
}

function formatAmount(raw: bigint, decimals: number | undefined): string {
  if (decimals === undefined) return `${raw} raw`
  const negative = raw < 0n
  const abs = negative ? -raw : raw
  const whole = abs / 10n ** BigInt(decimals)
  const frac = (abs % 10n ** BigInt(decimals)).toString().padStart(decimals, "0").replace(/0+$/, "")
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`
}

function formatSol(lamports: bigint): string {
  return `${formatAmount(lamports, 9)} SOL`
}

/** The lines the operator reads before the prompt (step 4). Pure, so a test can pin them. */
export function displayLines(input: {
  tx: DecodedTransaction
  compiled: CompiledKeys
  signers: KeyEntry[]
  simulation: SimulationSnapshot
  mints: Map<string, MintInfo>
}): string[] {
  const { tx, compiled, signers, simulation, mints } = input
  const lines: string[] = []
  const feePayer = compiled.keys[0] ?? "(none)"
  const signerAddresses = new Set(signers.map((entry) => entry.address))
  lines.push(
    `message     ${tx.message.version === "legacy" ? "legacy" : "v0"}, ${tx.message.instructions.length} instruction(s), ${compiled.keys.length} account(s)${tx.message.lookups.length > 0 ? ` (${tx.message.lookups.length} lookup table(s) resolved)` : ""}`,
  )
  lines.push(`fee payer   ${feePayer}${signerAddresses.has(feePayer) ? "" : "  (NOT this vault's external wallet)"}`)
  lines.push(`signers     ${signers.map((entry) => `${entry.label} (${entry.address})`).join(", ")}`)
  const programs = [...new Set(tx.message.instructions.map((ix) => compiled.keys[ix.programIdIndex] ?? "?"))]
  for (const program of programs) lines.push(`program     ${programNameOf(program)}`)

  const deltas = computeDeltas(simulation.snapshots)
  for (const entry of signers) {
    const sol = deltas.sol.find((delta) => delta.address === entry.address)
    if (sol) {
      lines.push(
        `${entry.label.padEnd(11)} ${formatSol(sol.before)} -> ${formatSol(sol.after)} (${sol.after >= sol.before ? "+" : ""}${formatSol(sol.after - sol.before)})`,
      )
    } else {
      lines.push(`${entry.label.padEnd(11)} SOL unchanged (not a writable account of this transaction)`)
    }
    for (const token of deltas.tokens.filter((delta) => delta.owner === entry.address)) {
      const info = mints.get(token.mint)
      lines.push(
        `            ${token.mint}: ${formatAmount(token.before, info?.decimals)} -> ${formatAmount(token.after, info?.decimals)} (${token.after >= token.before ? "+" : ""}${formatAmount(token.after - token.before, info?.decimals)}${info?.decimals === undefined ? "" : `, ${info.decimals} dp`}) in ${token.account}`,
      )
    }
  }
  const others: string[] = []
  for (const sol of deltas.sol) {
    if (signerAddresses.has(sol.address) || sol.after <= sol.before) continue
    // A token account's lamports are rent, and its owner's line already names the token move.
    if (deltas.tokens.some((token) => token.account === sol.address)) continue
    others.push(`${sol.address} receives +${formatSol(sol.after - sol.before)}`)
  }
  for (const token of deltas.tokens) {
    if (signerAddresses.has(token.owner) || token.after <= token.before) continue
    const info = mints.get(token.mint)
    others.push(
      `${token.owner} receives +${formatAmount(token.after - token.before, info?.decimals)} of ${token.mint} (account ${token.account})`,
    )
  }
  if (others.length === 0) lines.push("others      no other account gains a balance in the simulation")
  for (const line of others) lines.push(`receives    ${line}`)
  for (const [mint, info] of mints) for (const risk of info.risks) lines.push(`warning     ${mint}: ${risk}`)
  if (simulation.result.unitsConsumed !== undefined)
    lines.push(`compute     ${simulation.result.unitsConsumed} units in simulation`)
  lines.push("note        the simulation is evidence, not a guarantee: a program can behave differently once signed")
  return lines
}

export async function sign(args: string[], ctx: CommandContext): Promise<number> {
  const lifted = takeRepeatedFlag(args, "--wallet")
  if ("error" in lifted) return usage(ctx, lifted.error)
  const parsed = parseArgs(lifted.rest, {
    valueFlags: ["--file", "--rpc-url", "--keystore"],
    booleanFlags: ["--broadcast", "--yes", "--accept-older-copy"],
    pathFlags: ["--keystore", "--file"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length > 0) {
    return usage(
      ctx,
      `Unexpected argument: ${parsed.positionals[0]}. The transaction comes from --file <path> or stdin.`,
    )
  }
  if (lifted.values.length === 0)
    return usage(ctx, "--wallet <external> is required (repeat it for a multi-signer transaction).")
  // BE-355 (D1): the resolved endpoint, for the lookup tables, the simulation and --broadcast.
  const solana = await openSolanaClient(ctx, parsed.values["--rpc-url"])
  if ("error" in solana) return usage(ctx, solana.error)
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "candle sign")) return 1

  const { deps } = ctx
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const path = resolvedVault.path
  const yes = parsed.booleans.has("--yes")

  return runVaultCommand(ctx, async ({ hold }) => {
    // Step 1: decode strictly. Nothing is displayed until the whole transaction and, for v0, its
    // every lookup table have been read.
    let tx: DecodedTransaction
    try {
      const raw = await readInput(ctx, parsed.values["--file"])
      tx = decodeTransaction(decodeStrictBase64(new TextDecoder().decode(raw)))
    } catch (error) {
      if (error instanceof TransactionDecodeError) {
        throw new VaultError(
          "SIGN_TRANSACTION_UNDECODABLE",
          `The input is not one base64 legacy or v0 transaction: ${error.message}.`,
          { suggestion: "Nothing was signed. Pass one base64 transaction through --file <path> or stdin." },
        )
      }
      throw new VaultError(
        "SIGN_TRANSACTION_UNDECODABLE",
        `The input could not be read: ${error instanceof Error ? error.message : error}.`,
        { suggestion: "Nothing was signed. Check --file <path>, or pipe the transaction on stdin." },
      )
    }
    const rpc = solana.rpc
    let compiled: CompiledKeys
    try {
      compiled = await solana.read(() => resolveCompiledKeys(tx.message, rpc))
    } catch (error) {
      if (error instanceof LookupTableError)
        throw new VaultError("SIGN_LOOKUP_TABLE_UNRESOLVED", `${error.message}. Nothing was displayed or signed.`, {
          suggestion: "Point --rpc-url at an endpoint that has the lookup table, then run it again.",
        })
      throw error
    }

    // Step 2: the vault, and the signer refusals.
    const raw = await requireVaultRaw(ctx, resolvedVault)
    const opened = await unlockInteractively(ctx, path, raw, {
      acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
    })
    const vault = hold(opened.vault)
    const named: KeyEntry[] = []
    for (const requested of lifted.values) {
      // Phase 4a (D3): an EVM entry is refused by name before the role check.
      assertNotEvmEntry(vault.index, requested, "candle sign")
      const entry = findExternalEntry(vault.index, requested)
      if (entry === undefined) {
        const other = vault.index.entries.find(
          (candidate) => candidate.label === requested || candidate.address === requested,
        )
        if (other !== undefined) {
          throw new VaultError(
            "SIGN_SIGNER_NOT_EXTERNAL",
            `--wallet ${requested} is ${describeRole(other)}, which never signs for an outside tool.`,
            {
              suggestion:
                "Nothing was signed. Only an external wallet signs here: candle external new, or candle external list for the ones you have.",
            },
          )
        }
        return usage(ctx, `No external wallet in this vault matches --wallet ${requested}.`)
      }
      if (!named.some((candidate) => candidate.id === entry.id)) named.push(entry)
    }
    const signers = assertExternalSigners(vault.index, compiled, tx.message.numRequiredSignatures, named)
    const unused = named.filter((entry) => !signers.some((signer) => signer.id === entry.id))
    if (unused.length > 0) {
      return usage(
        ctx,
        `--wallet ${unused.map((entry) => entry.label).join(", ")}: not a required signer of this transaction.`,
      )
    }

    // Step 3: simulate, or refuse.
    const unsignedBase64 = toBase64(attachSignatures(tx, new Map()))
    let simulation: SimulationSnapshot
    try {
      simulation = await solana.read(() => simulateWithSnapshots(rpc, unsignedBase64, compiled))
    } catch (error) {
      // A rate limit that survived the retry is RPC_RATE_LIMITED (D3), already named by `read`.
      if (error instanceof VaultError) throw error
      throw new VaultError(
        "SIGN_SIMULATION_FAILED",
        `The simulation could not be run over ${solana.endpoint.host}: ${describeRpcFailure(error)}. Nothing was signed.`,
        {
          suggestion:
            "Point --rpc-url at a reachable endpoint and run it again; there is no way to skip the simulation.",
        },
      )
    }
    if (simulation.result.err !== null && simulation.result.err !== undefined) {
      const logs =
        simulation.result.logs.length > 0 ? `\n${simulation.result.logs.map((line) => `  ${line}`).join("\n")}` : ""
      throw new VaultError(
        "SIGN_SIMULATION_FAILED",
        `The simulation failed: ${JSON.stringify(simulation.result.err)}. Nothing was signed; there is no override.${logs}`,
        { suggestion: "Fix what the transaction does, then sign the corrected one." },
      )
    }

    // Step 4: display. On stderr in human mode, so stdout stays the signed transaction for a pipe.
    const mints = await readMints(rpc, [
      ...new Set(computeDeltas(simulation.snapshots).tokens.map((token) => token.mint)),
    ])
    const lines = displayLines({ tx, compiled, signers, simulation, mints })
    if (!ctx.json) {
      deps.stderr.write("Decoded transaction (simulated, unsigned):\n")
      for (const line of lines) deps.stderr.write(`  ${line}\n`)
    }

    // Step 5: confirm (unless --yes), sign, and hand the transaction back or broadcast it.
    if (!yes) await opened.confirm(`sign with ${signers.map((entry) => entry.label).join(", ")}`)
    const signed = new Map<number, Uint8Array>()
    const signatures: Array<{ wallet: string; address: string; signature: string }> = []
    for (const [i, entry] of signers.entries()) {
      const secret = await decryptKey(vault, entry.id)
      try {
        const signature = signBytes(tx.message.bytes, secret)
        signed.set(i, signature)
        signatures.push({ wallet: entry.label, address: entry.address, signature: base58.encode(signature) })
      } finally {
        wipe(secret)
      }
    }
    const wire = attachSignatures(tx, signed)
    const signedBase64 = toBase64(wire)
    const txSignature = signatures[0]?.signature ?? ""

    let broadcast: { ok: boolean; signature?: string; error?: string; uncertain?: true } | undefined
    if (parsed.booleans.has("--broadcast")) {
      try {
        await rpc.sendTransaction(signedBase64)
        broadcast = { ok: true, signature: txSignature }
      } catch (error) {
        // BE-355 (D4): a rate limit on the send is the uncertain outcome. The client never
        // re-sends; the transaction may still land under `txSignature`. Exit 3, not 1.
        if (isRateLimited(error)) {
          notePostSignatureRateLimit(ctx, txSignature)
          broadcast = { ok: false, uncertain: true, error: error.message }
        } else broadcast = { ok: false, error: describeRpcFailure(error) }
      }
    }
    const rateLimited = broadcast?.uncertain === true
    if (ctx.json) {
      writeJson(deps, {
        ok: broadcast === undefined ? true : broadcast.ok,
        ...(broadcast?.ok === false
          ? { code: rateLimited ? "RPC_RATE_LIMITED" : "SIGN_BROADCAST_FAILED", message: broadcast.error }
          : {}),
        signedTransaction: signedBase64,
        signature: txSignature,
        signers: signatures,
        display: lines,
        ...(broadcast ? { broadcast } : {}),
      })
      return broadcast?.ok === false ? (rateLimited ? 3 : 1) : 0
    }
    deps.stdout.write(`${signedBase64}\n`)
    for (const s of signatures) deps.stderr.write(`signed by ${s.wallet}: ${s.signature}\n`)
    if (broadcast?.ok) deps.stderr.write(`broadcast: ${broadcast.signature}\n`)
    if (rateLimited) return 3
    if (broadcast?.ok === false) {
      throw new VaultError(
        "SIGN_BROADCAST_FAILED",
        `The signed transaction was printed above but could not be sent: ${broadcast.error}.`,
        {
          suggestion: "Send it yourself, or run again with a fresh transaction if its blockhash expired.",
        },
      )
    }
    return 0
  })
}

// ── sign message ──────────────────────────────────────────────────────────────────────────────

/** Whether bytes render as text losslessly: valid UTF-8 with no C0 or C1 control other than newline. */
export function renderableAsText(bytes: Uint8Array): string | undefined {
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return undefined
  }
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code === 0x0a) continue
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return undefined
  }
  return text
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

export async function signMessage(args: string[], ctx: CommandContext): Promise<number> {
  const lifted = takeRepeatedFlag(args, "--wallet")
  if ("error" in lifted) return usage(ctx, lifted.error)
  const parsed = parseArgs(lifted.rest, {
    valueFlags: ["--file", "--keystore"],
    booleanFlags: ["--yes", "--accept-older-copy"],
    pathFlags: ["--keystore", "--file"],
  })
  if ("error" in parsed) return usage(ctx, parsed.error)
  if (parsed.positionals.length > 0) {
    // No argv message form (R6): the bytes come from a file or stdin, exactly as read.
    return usage(
      ctx,
      `Unexpected argument: ${parsed.positionals[0]}. The message comes from --file <path> or stdin, never an argument.`,
    )
  }
  if (lifted.values.length !== 1) return usage(ctx, "--wallet <external> is required, exactly once.")
  const requested = lifted.values[0] as string
  if (!refuseEnvPassphrase(ctx)) return 1
  if (!requireTty(ctx, "candle sign message")) return 1

  const { deps } = ctx
  const resolvedVault = vaultPathFor(ctx, parsed)
  if ("error" in resolvedVault) return usage(ctx, resolvedVault.error)
  const path = resolvedVault.path
  return runVaultCommand(ctx, async ({ hold }) => {
    let bytes: Uint8Array
    try {
      bytes = await readInput(ctx, parsed.values["--file"])
    } catch (error) {
      throw new VaultError(
        "VAULT_UNREADABLE",
        `The message could not be read: ${error instanceof Error ? error.message : error}.`,
      )
    }
    const raw = await requireVaultRaw(ctx, resolvedVault)
    const opened = await unlockInteractively(ctx, path, raw, {
      acceptOlderCopy: parsed.booleans.has("--accept-older-copy"),
    })
    const vault = hold(opened.vault)
    // Phase 4a (D3): an EVM entry is refused by name before the role check.
    assertNotEvmEntry(vault.index, requested, "candle sign message")
    const entry = findExternalEntry(vault.index, requested)
    if (entry === undefined) {
      const other = vault.index.entries.find(
        (candidate) => candidate.label === requested || candidate.address === requested,
      )
      if (other !== undefined) {
        throw new VaultError(
          "SIGN_SIGNER_NOT_EXTERNAL",
          `--wallet ${requested} is ${describeRole(other)}, which never signs a message for an outside tool.`,
          {
            suggestion:
              "Nothing was signed. Only an external wallet signs here: candle external new, or candle external list for the ones you have.",
          },
        )
      }
      return usage(ctx, `No external wallet in this vault matches --wallet ${requested}.`)
    }

    const digest = hex(sha256(bytes))
    const text = renderableAsText(bytes)
    const lines = [
      `wallet      ${entry.label} (${entry.address})`,
      `bytes       ${bytes.length}`,
      `sha256      ${digest}`,
      text === undefined
        ? `form        not renderable as text (not UTF-8, or a control character other than newline); shown as hex`
        : `form        UTF-8 text with no control characters other than newline`,
      text === undefined ? `hex         ${hex(bytes)}` : `text        ${text.split("\n").join("\n            ")}`,
    ]
    if (!ctx.json) {
      deps.stderr.write("Message to sign (the exact bytes read; nothing was trimmed or normalized):\n")
      for (const line of lines) deps.stderr.write(`  ${line}\n`)
    }
    if (!parsed.booleans.has("--yes")) await opened.confirm(`sign this message with ${entry.label}`)

    const secret = await decryptKey(vault, entry.id)
    let signature: Uint8Array
    try {
      signature = signBytes(bytes, secret)
    } finally {
      wipe(secret)
    }
    const signatureBase58 = base58.encode(signature)
    if (ctx.json) {
      writeJson(deps, {
        ok: true,
        wallet: entry.label,
        publicKey: entry.address,
        byteLength: bytes.length,
        sha256: digest,
        renderedAs: text === undefined ? "hex" : "text",
        signature: signatureBase58,
        signatureBase64: toBase64(signature),
      })
      return 0
    }
    deps.stdout.write(`${signatureBase58}\n`)
    return 0
  })
}
