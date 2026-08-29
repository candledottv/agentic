/**
 * `wallets`: `GET /wallets/embedded` (the account's launch wallets, per chain, with delegation
 * state) and `GET /wallets` (linked wallets), both with the agent key -- these routes reject a
 * device token, so unlike the `keys` commands this one needs `CANDLE_API_KEY` or a stored key.
 *
 * `wallets import` is the CLI's safe path for linking a wallet you already own: the private key
 * comes from a file or a hidden prompt (never argv, never shell history), is HPKE-sealed locally
 * (the vendored ../wallet-import module, the SDK's exact crypto), and only ciphertext travels.
 * The generated signer's private key lands in the OS keychain via the SecretStore rather than a
 * loose PEM on disk -- which is the whole reason this exists in the CLI and not as an MCP tool
 * (MCP hosts log tool arguments; see packages/mcp/src/tools.ts's exclusion note).
 *
 * `wallets revoke` completes the lifecycle: `DELETE /wallets/:id`, plus removal of any stored
 * signer for that wallet id.
 *
 * The listing's `Signer` column is the view from the wallet side: a linked wallet's row lives on
 * a Candle account while its signer lives on ONE machine, and a trade from that wallet needs
 * both halves. See `probeSignerStates`.
 */

import { base58 } from "@scure/base"
import { parseArgs } from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveApiKey } from "../deps"
import { printIdentity } from "../profiles"
import { renderTable, writeFailure, writeLocalFailure, writeUsageFailure } from "../render"
import { importPendingSignerRef, pemToStoredSigner, type SecretStore, walletSignerRef } from "../secret-store"
import { parseSolanaSecret, type WalletChain } from "../wallet-import"
import { runImportFlow } from "../wallet-import-flow"

interface EmbeddedWalletsResponse {
  wallets: {
    solana: { address: string; delegated: boolean } | null
    evm: { address: string; delegated: boolean } | null
  }
}

interface LinkedWalletRow {
  /** The Convex row id GET /wallets returns verbatim: the handle `wallets revoke`, the trade
   * API's `from.linkedWalletId`, and the SDK's secretStore keying all take. */
  _id: string
  address: string
  chain: string
  label?: string
  revokedAt?: number
}

interface LinkedWalletsResponse {
  page: LinkedWalletRow[]
}

/**
 * What THIS MACHINE can do with a linked wallet's signing key:
 *
 *   stored -- the signer for this wallet id is in this machine's store and the wallet is live;
 *   none   -- it is not here, so a trade run from here cannot sign for this wallet;
 *   stale  -- the wallet is revoked but its signer is still stored here.
 *
 * The human table prints `-` rather than `none` for a revoked row, where there is nothing to
 * say; the `--json` map carries `none` for it, since that row already carries `revokedAt`.
 */
type SignerState = "stored" | "none" | "stale"

/** The two lines printed under the table when any row reads `none`. */
const NONE_HINT =
  "A wallet marked none has no signer on this machine, so a trade from here cannot sign with it.\n" +
  "Import it here (candle wallets import), or run the trade from the machine that imported it.\n"

/** The line printed under the table when any row reads `stale`. */
const STALE_HINT =
  "A wallet marked stale is revoked but its signer is still stored here. Run: candle wallets revoke <id>\n"

/**
 * Probes the local secret store once per linked row, keyed by wallet id.
 *
 * Deliberately a probe of exactly the ids the API returned, never an enumeration of the store:
 * `SecretStore` is get/set/delete only and the macOS backend shells out per ref, so listing
 * every `wallet_signer_*` would mean a new capability on three backends for one column. The
 * consequence is stated in the docs: a signer for a wallet on ANOTHER account is not shown here,
 * it shows as `stored` when you list under that account's profile.
 *
 * A store that throws (a locked keychain, a missing `secret-tool`) is not a failed listing: the
 * row falls back to `none` and the caller prints ONE warning for the whole listing rather than
 * one per row, keeping the exit code at 0. The rows themselves are still worth printing.
 */
async function probeSignerStates(
  rows: LinkedWalletRow[],
  store: SecretStore,
): Promise<{ states: Map<string, SignerState>; storeError?: string }> {
  const states = new Map<string, SignerState>()
  let storeError: string | undefined
  for (const row of rows) {
    // The type says `_id` is always present. A row without one is skipped rather than probed
    // under `wallet_signer_undefined`, and is left out of the map.
    if (typeof row._id !== "string" || row._id.length === 0) continue
    let stored = false
    try {
      stored = (await store.get(walletSignerRef(row._id))) !== null
    } catch (error) {
      storeError ??= error instanceof Error ? error.message : String(error)
    }
    states.set(row._id, stored ? (row.revokedAt ? "stale" : "stored") : "none")
  }
  return { states, ...(storeError !== undefined ? { storeError } : {}) }
}

/** The `Signer` cell for a row: `none` on a revoked wallet has nothing to say, so it prints `-`. */
function signerCell(state: SignerState | undefined, row: LinkedWalletRow): string {
  if (state === undefined || (state === "none" && row.revokedAt)) return "-"
  return state
}

export async function wallets(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, {})
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json)
    return 2
  }

  await printIdentity(ctx)

  const apiKey = await resolveApiKey(deps, ctx.profile)
  if (!apiKey) {
    // Through the json-aware path, same as every API failure below: a `--json` caller gets an
    // object for this exit too, not a sentence it would have to parse.
    writeLocalFailure(
      deps,
      { code: "NO_API_KEY", message: "No API key available.", suggestion: "Run: candle keys create" },
      json,
    )
    return 1
  }

  const embedded = await apiRequest("/api/v1/agent/wallets/embedded", {
    auth: "key",
    credentials: { apiKey },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
  })
  if (!embedded.ok) {
    writeFailure(deps, embedded, { apiUrl, authType: "key" }, json)
    return 1
  }

  const linked = await apiRequest("/api/v1/agent/wallets", {
    auth: "key",
    credentials: { apiKey },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
  })
  if (!linked.ok) {
    writeFailure(deps, linked, { apiUrl, authType: "key" }, json)
    return 1
  }

  const linkedBody = linked.body as LinkedWalletsResponse
  // Guarded rather than trusted: `body` is `unknown` until this cast, and the JSON branch below
  // now reads the rows where before it only echoed the body.
  const linkedRows = Array.isArray(linkedBody.page) ? linkedBody.page : []
  const { states: signerStates, storeError } = await probeSignerStates(linkedRows, deps.store)
  // On STDERR in both modes: a warning must never land in the middle of the JSON document
  // stdout is contracted to carry, and it is not a failure of the listing either way.
  if (storeError !== undefined) deps.stderr.write(`Could not read the signer store: ${storeError}\n`)

  if (json) {
    // Both API bodies stay verbatim and `signers` sits beside them, so a consumer can still tell
    // what the API said from what the CLI worked out about this machine.
    deps.stdout.write(
      `${JSON.stringify({
        embedded: embedded.body,
        linked: linked.body,
        signers: Object.fromEntries(signerStates),
      })}\n`,
    )
    return 0
  }

  const embeddedBody = embedded.body as EmbeddedWalletsResponse

  // Two vocabularies meet in this table: the rows are WALLETS ("solana" | "evm", an address and
  // signing family) while the value a caller passes to launch/trade is a LAUNCH CHAIN
  // ("solana" | "hood"). Heading the column "Chain" made them look like one axis and left
  // nothing on screen to say that a Hood launch spends from the `evm` row, so the mapping is
  // stated outright. See docs/reference/chain-vocabulary.md.
  deps.stdout.write("Embedded (launch) wallets:\n")
  deps.stdout.write(
    `${renderTable(
      ["Wallet", "Address", "Delegated", "Launches on"],
      [
        [
          "solana",
          embeddedBody.wallets.solana?.address ?? "none",
          embeddedBody.wallets.solana?.delegated ? "yes" : "no",
          "solana",
        ],
        [
          "evm",
          embeddedBody.wallets.evm?.address ?? "none",
          embeddedBody.wallets.evm?.delegated ? "yes" : "no",
          "hood",
        ],
      ],
    )}\n`,
  )

  deps.stdout.write("\nLinked wallets:\n")
  if (linkedRows.length === 0) {
    deps.stdout.write("(none)\n")
  } else {
    // Rendered once, then read back for the hints, so what the hint says about "a wallet marked
    // none" is the same value the table actually printed and cannot drift from it.
    const cells = linkedRows.map((wallet) => signerCell(signerStates.get(wallet._id), wallet))
    deps.stdout.write(
      `${renderTable(
        ["Id", "Wallet", "Address", "Label", "Revoked", "Signer"],
        linkedRows.map((wallet, index) => [
          wallet._id,
          wallet.chain,
          wallet.address,
          wallet.label ?? "-",
          wallet.revokedAt ? "yes" : "no",
          cells[index] ?? "-",
        ]),
      )}\n`,
    )
    // Only for a state some row is actually in: a listing where every signer is present says
    // nothing extra.
    const anyNone = cells.includes("none")
    const anyStale = cells.includes("stale")
    if (anyNone || anyStale) deps.stdout.write("\n")
    if (anyNone) deps.stdout.write(NONE_HINT)
    if (anyStale) deps.stdout.write(STALE_HINT)
  }
  return 0
}

/**
 * Resolves the raw private-key string for `wallets import`: `--key-file`'s contents when given,
 * else a hidden interactive prompt. Returned to the caller for immediate sealing; nothing here
 * stores or logs it.
 */
async function resolveKeyMaterial(
  keyFile: string | undefined,
  chain: WalletChain,
  ctx: CommandContext,
): Promise<{ ok: true; privateKey: string } | { ok: false; message: string }> {
  if (keyFile !== undefined) {
    try {
      return { ok: true, privateKey: (await ctx.deps.readFile(keyFile)).trim() }
    } catch (error) {
      return { ok: false, message: `Could not read --key-file: ${error instanceof Error ? error.message : error}` }
    }
  }
  try {
    const promptText =
      chain === "solana"
        ? "Solana private key (base58 or id.json contents; input hidden): "
        : "EVM private key (hex; input hidden): "
    const entered = (await ctx.deps.promptSecret(promptText)).trim()
    if (entered.length === 0) return { ok: false, message: "No private key entered" }
    return { ok: true, privateKey: entered }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The address the import will be registered under. For Solana the decoded 64-byte secret embeds
 * its own public key (bytes 32..64), so the address is DERIVED and any `--address` given is
 * verified against it -- a mismatch means the key and the address belong to different wallets,
 * which sealed-and-submitted would provision a wallet whose key cannot actually sign (the
 * "garbage-keyed wallet" failure the SDK's module doc warns about). For EVM the address cannot
 * be derived without keccak (not in node:crypto), so `--address` is required and the server's
 * own validation is the guard.
 */
function resolveImportAddress(
  chain: WalletChain,
  privateKey: string,
  addressFlag: string | undefined,
): { ok: true; address: string } | { ok: false; message: string } {
  if (chain === "evm") {
    if (!addressFlag) return { ok: false, message: "--address is required for --chain evm" }
    return { ok: true, address: addressFlag }
  }
  let secret: Uint8Array
  try {
    secret = parseSolanaSecret(privateKey)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  if (secret.length !== 64) {
    return { ok: false, message: `Invalid Solana private key: expected 64 bytes, got ${secret.length}` }
  }
  const derived = base58.encode(secret.slice(32))
  if (addressFlag !== undefined && addressFlag !== derived) {
    return {
      ok: false,
      message: `--address does not match this private key (the key derives ${derived}). Refusing to import a mismatched pair.`,
    }
  }
  return { ok: true, address: derived }
}

export async function walletsImport(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, {
    valueFlags: ["--chain", "--address", "--label", "--key-file", "--signer-out"],
  })
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json)
    return 2
  }
  // Every missing requirement at once. Reporting them one per invocation makes the caller
  // rediscover the command by trial: the 2026-08-19 import took three runs to learn --chain and
  // then --address. An agent relaying this to a human pays that cost twice over.
  const chainFlag = parsed.values["--chain"]
  const chainValid = chainFlag === "solana" || chainFlag === "evm"
  const missing: string[] = []
  if (!chainValid) missing.push("--chain <solana|evm>")
  // Required for EVM only: a Solana secret embeds its own public key, so the address is derived.
  // Checked before the key prompt so nobody types a private key and then learns a flag is absent.
  if (chainFlag === "evm" && parsed.values["--address"] === undefined) missing.push("--address <0x...>")
  if (missing.length > 0) {
    deps.stderr.write(`Missing required: ${missing.join(", ")}\n`)
    deps.stderr.write(`Example: candle wallets import --chain evm --address 0xYourWallet --api-url ${apiUrl}\n`)
    return 2
  }
  const chain: WalletChain = chainFlag as WalletChain

  await printIdentity(ctx)

  // Everything local happens BEFORE any network call: key material, decode, address derivation.
  // A typo'd key or mismatched address must never cost an init round trip, and must never leave
  // this process in any form.
  const material = await resolveKeyMaterial(parsed.values["--key-file"], chain, ctx)
  if (!material.ok) {
    writeLocalFailure(deps, { code: "KEY_INPUT_FAILED", message: material.message }, json)
    return 1
  }
  const resolvedAddress = resolveImportAddress(chain, material.privateKey, parsed.values["--address"])
  if (!resolvedAddress.ok) {
    writeLocalFailure(deps, { code: "KEY_INPUT_FAILED", message: resolvedAddress.message }, json)
    return 1
  }
  const address = resolvedAddress.address

  const apiKey = await resolveApiKey(deps, ctx.profile)
  if (!apiKey) {
    writeLocalFailure(
      deps,
      { code: "NO_API_KEY", message: "No API key available.", suggestion: "Run: candle keys create" },
      json,
    )
    return 1
  }

  const flow = await runImportFlow({
    chain,
    address,
    privateKey: material.privateKey,
    ...(parsed.values["--label"] !== undefined ? { label: parsed.values["--label"] } : {}),
    apiKey,
    apiUrl,
    deps,
  })
  if (!flow.ok) {
    const failure = flow.failure
    if (failure.kind === "api") {
      writeFailure(deps, failure.response, { apiUrl, authType: "key" }, json)
      return 1
    }
    if (failure.kind === "signer-store") {
      writeLocalFailure(
        deps,
        {
          code: "SIGNER_STORE_FAILED",
          message: `Could not store the new signer in the ${deps.backend} store: ${failure.error instanceof Error ? failure.error.message : failure.error}`,
          suggestion: "Nothing was imported. Unlock the store (or fix the error above) and run the command again.",
        },
        json,
      )
      return 1
    }
    writeLocalFailure(
      deps,
      {
        code: "SIGNER_COMMIT_FAILED",
        message:
          `Wallet ${failure.walletId} was imported, but its signer could not be stored under the wallet's own ` +
          `ref: ${failure.error instanceof Error ? failure.error.message : failure.error}`,
        suggestion:
          `The signer is not lost: it is in the ${deps.backend} store under "${failure.pendingRef}". Copy it to ` +
          `"${walletSignerRef(failure.walletId)}", or revoke the wallet with: candle wallets revoke ${failure.walletId}`,
      },
      json,
    )
    return 1
  }
  const result = flow.submitted

  const signerOut = parsed.values["--signer-out"]
  if (signerOut !== undefined) {
    try {
      await deps.writeFile(signerOut, flow.signerPrivateKeyPem)
    } catch (error) {
      // The import itself succeeded and the keychain holds the signer; report the export
      // failure without failing the command, and say where the signer still lives.
      deps.stderr.write(
        `Warning: could not write --signer-out (${error instanceof Error ? error.message : error}); the signer is stored in the ${deps.backend} store\n`,
      )
    }
  }

  // Read the wallet back from the account it was supposed to land on, BEFORE reporting success.
  //
  // On 2026-08-19 this command printed a wallet id and a stored signer for an EVM import that
  // never appeared on the agent's account: the credentials in the keychain belonged to a
  // different Candle login, so the row was created under someone else. Nothing in the output
  // named an account, so a wrong-account import was indistinguishable from a right one, and it
  // took a database query to find out. Trusting our own POST is what made that invisible.
  const verification = await verifyImportLanded({ id: result.id, apiKey, apiUrl, ctx })
  if (verification.status === "missing") {
    writeLocalFailure(
      deps,
      {
        code: "IMPORT_NOT_VISIBLE",
        message:
          `The server accepted the import (wallet id ${result.id}) but it is not on the account these ` +
          `credentials belong to${verification.account !== undefined ? ` (${verification.account})` : ""}. ` +
          `That usually means the CLI is logged in as a different Candle account than you expect. ` +
          `Run: candle doctor --api-url ${apiUrl}`,
      },
      json,
    )
    return 1
  }

  if (json) {
    deps.stdout.write(
      `${JSON.stringify({
        id: result.id,
        address: result.address,
        chain: result.chain,
        privyWalletId: result.privyWalletId,
        account: verification.account,
        apiUrl,
        signerStore: deps.backend,
        verified: verification.status === "verified",
        ...(signerOut !== undefined ? { signerOut } : {}),
      })}\n`,
    )
    return 0
  }

  deps.stdout.write(`Imported ${result.chain} wallet ${result.address}\n`)
  // The account and host lead, because they are the two facts that were missing when this went
  // wrong, and the only two the caller cannot check from the rest of this output.
  deps.stdout.write(`  Account:         ${verification.account ?? "unknown"} at ${apiUrl}\n`)
  deps.stdout.write(`  Wallet id:       ${result.id}\n`)
  deps.stdout.write(`  Privy wallet id: ${result.privyWalletId}\n`)
  if (signerOut !== undefined) {
    deps.stdout.write(`  Signer key:      exported to ${signerOut} (and in the ${deps.backend} store)\n`)
    deps.stdout.write(`Back up ${signerOut}: trades from this wallet sign with it, and it cannot be re-downloaded.\n`)
  } else {
    // Previously this said "stored in the keychain" and then "keep the signer key", which asks
    // for an action against something the caller was never handed.
    deps.stdout.write(`  Signer key:      stored in your ${deps.backend} store; nothing to save by hand\n`)
  }
  if (verification.status === "unchecked") {
    deps.stdout.write(
      `Note: could not read the wallet back to confirm which account it landed on. Run: candle wallets --api-url ${apiUrl}\n`,
    )
  }
  return 0
}

/**
 * Confirm an imported wallet is visible on the account the calling credentials belong to.
 *
 * Three outcomes, deliberately distinct: "verified" (the row is there), "missing" (the account
 * answered and the wallet is NOT in it, which is a real failure and the case this exists for),
 * and "unchecked" (the read itself failed, which is not evidence of anything and must never fail
 * an import that already succeeded).
 */
async function verifyImportLanded(args: {
  id: string
  apiKey: string
  apiUrl: string
  ctx: CommandContext
}): Promise<{ status: "verified" | "missing" | "unchecked"; account?: string }> {
  const { deps } = args.ctx
  const listed = await apiRequest("/api/v1/agent/wallets", {
    method: "GET",
    auth: "key",
    credentials: { apiKey: args.apiKey },
    apiUrl: args.apiUrl,
    fetch: deps.fetch,
    env: deps.env,
  })
  if (!listed.ok) return { status: "unchecked" }
  const page = (listed.body as { page?: Array<{ _id?: string; userAddress?: string }> }).page
  if (!Array.isArray(page)) return { status: "unchecked" }
  const account = page.find((row) => typeof row.userAddress === "string")?.userAddress
  const found = page.some((row) => row._id === args.id)
  return { status: found ? "verified" : "missing", ...(account !== undefined ? { account } : {}) }
}

export async function walletsRevoke(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, {})
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  const [walletId, extra] = parsed.positionals
  if (!walletId || extra !== undefined) {
    deps.stderr.write("Usage: candle wallets revoke <wallet-id>\n")
    return 2
  }

  await printIdentity(ctx)

  const apiKey = await resolveApiKey(deps, ctx.profile)
  if (!apiKey) {
    writeLocalFailure(
      deps,
      { code: "NO_API_KEY", message: "No API key available.", suggestion: "Run: candle keys create" },
      json,
    )
    return 1
  }

  const result = await apiRequest(`/api/v1/agent/wallets/${encodeURIComponent(walletId)}`, {
    method: "DELETE",
    auth: "key",
    credentials: { apiKey },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
  })
  if (!result.ok) {
    writeFailure(deps, result, { apiUrl, authType: "key" }, json)
    return 1
  }

  // Best-effort cleanup of the stored signer: the wallet is gone either way, and a store
  // without keychain access should not turn a successful revoke into a failure.
  try {
    await deps.store.delete(walletSignerRef(walletId))
  } catch {
    // The revoke succeeded; a stale signer entry is harmless.
  }

  if (json) {
    deps.stdout.write(`${JSON.stringify({ revoked: walletId, ...(result.body as object) })}\n`)
    return 0
  }
  deps.stdout.write(`Revoked linked wallet ${walletId}\n`)
  return 0
}
