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
 */

import { base58 } from "@scure/base"
import { parseArgs } from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveApiKey } from "../deps"
import { renderTable, writeFailure, writeLocalFailure } from "../render"
import { walletSignerRef } from "../secret-store"
import { encryptWalletKeyForImport, generateSignerKeypair, parseSolanaSecret, type WalletChain } from "../wallet-import"

interface EmbeddedWalletsResponse {
  wallets: {
    solana: { address: string; delegated: boolean } | null
    evm: { address: string; delegated: boolean } | null
  }
}

interface LinkedWalletRow {
  address: string
  chain: string
  label?: string
  revokedAt?: number
}

interface LinkedWalletsResponse {
  page: LinkedWalletRow[]
}

export async function wallets(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, {})
  if ("error" in parsed) {
    deps.stderr.write(`${parsed.error}\n`)
    return 2
  }
  if (parsed.positionals.length > 0) {
    deps.stderr.write(`Unexpected argument: ${parsed.positionals[0]}\n`)
    return 2
  }

  const apiKey = await resolveApiKey(deps)
  if (!apiKey) {
    // Through the json-aware path, same as every API failure below: a `--json` caller gets an
    // object for this exit too, not a sentence it would have to parse.
    writeLocalFailure(
      deps.stderr,
      { code: "NO_API_KEY", message: "No API key available. Run: candle keys create" },
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
    writeFailure(deps.stderr, embedded, { apiUrl, authType: "key" }, json)
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
    writeFailure(deps.stderr, linked, { apiUrl, authType: "key" }, json)
    return 1
  }

  if (json) {
    deps.stdout.write(`${JSON.stringify({ embedded: embedded.body, linked: linked.body })}\n`)
    return 0
  }

  const embeddedBody = embedded.body as EmbeddedWalletsResponse
  const linkedBody = linked.body as LinkedWalletsResponse

  deps.stdout.write("Embedded (launch) wallets:\n")
  deps.stdout.write(
    `${renderTable(
      ["Chain", "Address", "Delegated"],
      [
        [
          "solana",
          embeddedBody.wallets.solana?.address ?? "none",
          embeddedBody.wallets.solana?.delegated ? "yes" : "no",
        ],
        ["evm", embeddedBody.wallets.evm?.address ?? "none", embeddedBody.wallets.evm?.delegated ? "yes" : "no"],
      ],
    )}\n`,
  )

  deps.stdout.write("\nLinked wallets:\n")
  if (linkedBody.page.length === 0) {
    deps.stdout.write("(none)\n")
  } else {
    deps.stdout.write(
      `${renderTable(
        ["Chain", "Address", "Label", "Revoked"],
        linkedBody.page.map((wallet) => [
          wallet.chain,
          wallet.address,
          wallet.label ?? "-",
          wallet.revokedAt ? "yes" : "no",
        ]),
      )}\n`,
    )
  }
  return 0
}

interface ImportInitResponse {
  encryptionPublicKey: string
}

interface ImportSubmitResponse {
  id: string
  address: string
  chain: WalletChain
  privyWalletId: string
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
    deps.stderr.write(`${parsed.error}\n`)
    return 2
  }
  if (parsed.positionals.length > 0) {
    deps.stderr.write(`Unexpected argument: ${parsed.positionals[0]}\n`)
    return 2
  }
  const chainFlag = parsed.values["--chain"]
  if (chainFlag !== "solana" && chainFlag !== "evm") {
    deps.stderr.write('--chain is required and must be "solana" or "evm"\n')
    return 2
  }
  const chain: WalletChain = chainFlag
  // Checked before the key prompt, not inside resolveImportAddress: a user missing a required
  // flag should learn that immediately, not after typing their private key into a prompt.
  if (chain === "evm" && parsed.values["--address"] === undefined) {
    deps.stderr.write("--address is required for --chain evm\n")
    return 2
  }

  // Everything local happens BEFORE any network call: key material, decode, address derivation.
  // A typo'd key or mismatched address must never cost an init round trip, and must never leave
  // this process in any form.
  const material = await resolveKeyMaterial(parsed.values["--key-file"], chain, ctx)
  if (!material.ok) {
    writeLocalFailure(deps.stderr, { code: "KEY_INPUT_FAILED", message: material.message }, json)
    return 1
  }
  const resolvedAddress = resolveImportAddress(chain, material.privateKey, parsed.values["--address"])
  if (!resolvedAddress.ok) {
    writeLocalFailure(deps.stderr, { code: "KEY_INPUT_FAILED", message: resolvedAddress.message }, json)
    return 1
  }
  const address = resolvedAddress.address

  const apiKey = await resolveApiKey(deps)
  if (!apiKey) {
    writeLocalFailure(
      deps.stderr,
      { code: "NO_API_KEY", message: "No API key available. Run: candle keys create" },
      json,
    )
    return 1
  }

  const init = await apiRequest("/api/v1/agent/wallets/import/init", {
    method: "POST",
    body: { chain, address },
    auth: "key",
    credentials: { apiKey },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
  })
  if (!init.ok) {
    writeFailure(deps.stderr, init, { apiUrl, authType: "key" }, json)
    return 1
  }
  const { encryptionPublicKey } = init.body as ImportInitResponse

  const { ciphertext, encapsulatedKey } = await encryptWalletKeyForImport({
    chain,
    privateKey: material.privateKey,
    encryptionPublicKey,
  })
  const signer = await generateSignerKeypair()

  const submit = await apiRequest("/api/v1/agent/wallets/import/submit", {
    method: "POST",
    body: {
      chain,
      address,
      ciphertext,
      encapsulatedKey,
      signerPublicKey: signer.publicKeyDerBase64,
      ...(parsed.values["--label"] !== undefined ? { label: parsed.values["--label"] } : {}),
    },
    auth: "key",
    credentials: { apiKey },
    apiUrl,
    fetch: deps.fetch,
    env: deps.env,
  })
  if (!submit.ok) {
    writeFailure(deps.stderr, submit, { apiUrl, authType: "key" }, json)
    return 1
  }
  const result = submit.body as ImportSubmitResponse

  // The signer's private half is the credential every later trade from this wallet signs with.
  // Keychain first (the point of doing this in the CLI); --signer-out additionally exports a
  // PEM for use on another machine, written 0600 by the real writeFile.
  await deps.store.set(walletSignerRef(result.id), signer.privateKeyPem)
  const signerOut = parsed.values["--signer-out"]
  if (signerOut !== undefined) {
    try {
      await deps.writeFile(signerOut, signer.privateKeyPem)
    } catch (error) {
      // The import itself succeeded and the keychain holds the signer; report the export
      // failure without failing the command, and say where the signer still lives.
      deps.stderr.write(
        `Warning: could not write --signer-out (${error instanceof Error ? error.message : error}); the signer is stored in the ${deps.backend} store\n`,
      )
    }
  }

  if (json) {
    deps.stdout.write(
      `${JSON.stringify({
        id: result.id,
        address: result.address,
        chain: result.chain,
        privyWalletId: result.privyWalletId,
        signerStore: deps.backend,
        ...(signerOut !== undefined ? { signerOut } : {}),
      })}\n`,
    )
    return 0
  }

  deps.stdout.write(`Imported ${result.chain} wallet ${result.address}\n`)
  deps.stdout.write(`  Wallet id:       ${result.id}\n`)
  deps.stdout.write(`  Privy wallet id: ${result.privyWalletId}\n`)
  deps.stdout.write(
    `  Signer key:      stored in the ${deps.backend} store${signerOut !== undefined ? ` and exported to ${signerOut}` : ""}\n`,
  )
  deps.stdout.write("Keep the signer key: trades from this wallet sign with it, and it cannot be re-downloaded.\n")
  return 0
}

export async function walletsRevoke(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, {})
  if ("error" in parsed) {
    deps.stderr.write(`${parsed.error}\n`)
    return 2
  }
  const [walletId, extra] = parsed.positionals
  if (!walletId || extra !== undefined) {
    deps.stderr.write("Usage: candle wallets revoke <wallet-id>\n")
    return 2
  }

  const apiKey = await resolveApiKey(deps)
  if (!apiKey) {
    writeLocalFailure(
      deps.stderr,
      { code: "NO_API_KEY", message: "No API key available. Run: candle keys create" },
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
    writeFailure(deps.stderr, result, { apiUrl, authType: "key" }, json)
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
