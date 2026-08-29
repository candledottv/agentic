/**
 * `candle wallets generate`: mint N wallets locally, seal them, then import each one.
 *
 * The ordering is the whole command. Every key is written to the encrypted keystore BEFORE any
 * import call is issued, and the command aborts if that write fails. Importing first would mean a
 * crash could leave a wallet inside Privy, owned by an agent key quorum, whose private key existed
 * only in this process: unrecoverable by the operator. Sealing first inverts the worst case to
 * "saved but not yet imported", which `--resume` repairs.
 *
 * Independent random keys rather than one mnemonic, decided in the spec: these wallets exist to
 * compartmentalise execution, and a shared derivation root re-couples them. The cost is that the
 * keystore is the only copy, which is why the write is atomic, the format is self-describing, and
 * `wallets export` exists.
 */
import { parseArgs } from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { resolveApiKey } from "../deps"
import { printIdentity } from "../profiles"
import { writeFailure, writeLocalFailure, writeUsageFailure } from "../render"
import type { WalletChain } from "../wallet-import"
import { runImportFlow } from "../wallet-import-flow"
import { generateWallet } from "../wallet-keygen"
import {
  createKeystore,
  defaultKeystorePath,
  type KeystoreEntry,
  type OpenKeystore,
  readKeystore,
  serializeKeystore,
  writeKeystoreFile,
} from "../wallet-keystore"

/** High enough that no real batch hits it, low enough that a typo cannot mint hundreds. */
const MAX_COUNT = 50

/** The CLI's user-facing chain words, mapped to Privy's wallet chain types at this boundary. */
const CHAIN_WORDS: Record<string, WalletChain> = { solana: "solana", hood: "evm", evm: "evm" }

interface LinkedWalletRow {
  _id: string
  address: string
}

/**
 * Resolves the keystore passphrase. The env var exists so a scripted run is possible at all; the
 * double prompt on creation exists because a mistyped passphrase on a file that is the only copy
 * of N private keys is unrecoverable, and the operator would not find out until they needed it.
 */
async function resolvePassphrase(
  ctx: CommandContext,
  creating: boolean,
): Promise<{ ok: true; passphrase: string } | { ok: false; message: string }> {
  const fromEnv = ctx.deps.env.CANDLE_KEYSTORE_PASSPHRASE
  if (fromEnv !== undefined && fromEnv !== "") return { ok: true, passphrase: fromEnv }
  const first = (await ctx.deps.promptSecret("Keystore passphrase (input hidden): ")).trim()
  if (first === "") return { ok: false, message: "A keystore passphrase is required." }
  if (!creating) return { ok: true, passphrase: first }
  const again = (await ctx.deps.promptSecret("Confirm keystore passphrase: ")).trim()
  if (again !== first) return { ok: false, message: "The passphrases did not match. Nothing was generated." }
  return { ok: true, passphrase: first }
}

export async function walletsGenerate(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, apiUrl, json } = ctx
  const parsed = parseArgs(args, {
    valueFlags: ["--count", "--chain", "--label", "--keystore"],
    booleanFlags: ["--resume"],
  })
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json)
    return 2
  }

  const resuming = parsed.booleans.has("--resume")
  const countFlag = parsed.values["--count"]
  if (resuming && countFlag !== undefined) {
    writeUsageFailure(deps, "--count cannot be combined with --resume: resume never generates new keys.", json)
    return 2
  }

  const keystorePath = parsed.values["--keystore"] ?? defaultKeystorePath(deps.env)

  // Read any existing keystore FIRST, so "would this overwrite keys?" is answered before a
  // passphrase is typed or a single key is generated.
  let existingRaw: string | null = null
  try {
    existingRaw = await deps.readFile(keystorePath)
  } catch {
    existingRaw = null
  }
  if (existingRaw !== null && !resuming) {
    writeLocalFailure(
      deps,
      {
        code: "KEYSTORE_EXISTS",
        message: `A keystore already exists at ${keystorePath}.`,
        suggestion:
          "Run with --resume to import the wallets it already holds, or pass --keystore <path> for a new one.",
      },
      json,
    )
    return 1
  }
  if (existingRaw === null && resuming) {
    writeLocalFailure(deps, { code: "KEYSTORE_MISSING", message: `No keystore at ${keystorePath} to resume.` }, json)
    return 1
  }

  let chain: WalletChain | undefined
  let count = 0
  if (!resuming) {
    const chainFlag = parsed.values["--chain"]
    const mapped = chainFlag === undefined ? undefined : CHAIN_WORDS[chainFlag]
    const missing: string[] = []
    if (mapped === undefined) missing.push("--chain <solana|hood|evm>")
    if (countFlag === undefined) missing.push("--count <n>")
    if (missing.length > 0) {
      deps.stderr.write(`Missing required: ${missing.join(", ")}\n`)
      deps.stderr.write(`Example: candle wallets generate --chain solana --count 5\n`)
      return 2
    }
    count = Number.parseInt(countFlag as string, 10)
    if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
      writeUsageFailure(deps, `--count must be a whole number between 1 and ${MAX_COUNT}.`, json)
      return 2
    }
    chain = mapped
  }

  await printIdentity(ctx)

  const passphrase = await resolvePassphrase(ctx, existingRaw === null)
  if (!passphrase.ok) {
    writeLocalFailure(deps, { code: "KEYSTORE_PASSPHRASE", message: passphrase.message }, json)
    return 1
  }

  let store: OpenKeystore
  if (existingRaw !== null) {
    try {
      store = await readKeystore(existingRaw, passphrase.passphrase)
    } catch (error) {
      writeLocalFailure(
        deps,
        { code: "KEYSTORE_UNREADABLE", message: error instanceof Error ? error.message : String(error) },
        json,
      )
      return 1
    }
  } else {
    const created = await createKeystore(passphrase.passphrase)
    const now = new Date().toISOString()
    const labelPrefix = parsed.values["--label"] ?? "wallet"
    const entries: KeystoreEntry[] = Array.from({ length: count }, (_, i) => {
      const w = generateWallet(chain as WalletChain)
      return {
        index: i,
        chain: chain as WalletChain,
        address: w.address,
        label: `${labelPrefix}-${i}`,
        createdAt: now,
        privateKey: w.privateKey,
        imported: false,
      }
    })
    store = { ...created, entries }

    // THE ORDERING INVARIANT. Nothing below this line may run if the seal did not land.
    try {
      await writeKeystoreFile(keystorePath, await serializeKeystore(entries, store.key, store.salt, store.iterations))
    } catch (error) {
      writeLocalFailure(
        deps,
        {
          code: "KEYSTORE_WRITE_FAILED",
          message: `Could not write the keystore: ${error instanceof Error ? error.message : error}`,
          suggestion: "Nothing was imported and no key left this process. Fix the error above and run again.",
        },
        json,
      )
      return 1
    }

    if (!json) {
      deps.stdout.write(`Generated ${entries.length} ${chain === "solana" ? "Solana" : "EVM"} wallet(s):\n`)
      for (const e of entries) deps.stdout.write(`  [${e.index}] ${e.address}  ${e.label}\n`)
      deps.stdout.write(`\nSealed to ${keystorePath}\n`)
      deps.stdout.write(`BACK UP THIS FILE. These keys are independent and it is the only copy of them.\n`)
      if (chain === "evm") {
        deps.stdout.write(`This is an ordinary EVM wallet: the same key works on Hood and every other EVM chain.\n`)
      }
      deps.stdout.write(`\n`)
    }
  }

  const apiKey = await resolveApiKey(deps, ctx.profile)
  if (!apiKey) {
    writeLocalFailure(
      deps,
      {
        code: "NO_API_KEY",
        message: "No API key available.",
        suggestion: `The keys are sealed at ${keystorePath}. Run: candle keys create, then: candle wallets generate --resume`,
      },
      json,
    )
    return 1
  }

  const pending = store.entries.filter((e) => !e.imported)
  let failures = 0
  for (const entry of pending) {
    const flow = await runImportFlow({
      chain: entry.chain,
      address: entry.address,
      privateKey: entry.privateKey,
      label: entry.label,
      apiKey,
      apiUrl,
      deps,
    })

    if (!flow.ok) {
      const failure = flow.failure
      // The crash-between-submit-and-rewrite case: the wallet reached Privy on an earlier run but
      // the keystore never recorded it, so init now refuses the address as already taken. That is
      // this entry being ALREADY DONE, not a failure, and treating it as one would leave the
      // keystore permanently stuck one entry short.
      const alreadyExists =
        failure.kind === "api" &&
        /already exists/i.test(`${failure.response.message} ${JSON.stringify(failure.response.raw ?? "")}`)
      if (alreadyExists) {
        const found = await lookupByAddress(entry.address, apiKey, ctx)
        if (found) {
          entry.imported = true
          entry.privyWalletId = found._id
          entry.importedAt = new Date().toISOString()
          await persist(store, keystorePath)
          if (!json) deps.stdout.write(`  [${entry.index}] ${entry.address} already imported, reconciled\n`)
          continue
        }
      }
      failures++
      if (failure.kind === "api") {
        writeFailure(deps, failure.response, { apiUrl, authType: "key" }, json)
      } else {
        writeLocalFailure(
          deps,
          {
            code: failure.kind === "signer-store" ? "SIGNER_STORE_FAILED" : "SIGNER_COMMIT_FAILED",
            message: `Wallet ${entry.address}: ${failure.error instanceof Error ? failure.error.message : failure.error}`,
            suggestion: `The keys are sealed at ${keystorePath}. Fix the error above and run: candle wallets generate --resume`,
          },
          json,
        )
      }
      // Stop at the first failure rather than grinding through N of the same error.
      break
    }

    entry.imported = true
    entry.privyWalletId = flow.submitted.privyWalletId
    entry.importedAt = new Date().toISOString()
    await persist(store, keystorePath)
    if (!json) deps.stdout.write(`  [${entry.index}] ${entry.address} imported as ${flow.submitted.id}\n`)
  }

  const imported = store.entries.filter((e) => e.imported).length
  if (json) {
    deps.stdout.write(
      `${JSON.stringify({
        keystore: keystorePath,
        total: store.entries.length,
        imported,
        wallets: store.entries.map((e) => ({
          index: e.index,
          chain: e.chain,
          address: e.address,
          label: e.label,
          imported: e.imported,
          ...(e.privyWalletId !== undefined ? { privyWalletId: e.privyWalletId } : {}),
        })),
      })}\n`,
    )
    return failures > 0 ? 1 : 0
  }

  deps.stdout.write(`\n${imported}/${store.entries.length} imported.\n`)
  if (failures > 0) {
    deps.stdout.write(`Run again with --resume to continue. Every key is still sealed at ${keystorePath}.\n`)
    return 1
  }
  deps.stdout.write(
    `Each wallet is owned by its own agent key quorum with the spend policy on the wallet, and no\n` +
      `user identity was sent to Privy, so none of these is a way to sign in to your account.\n`,
  )
  return 0
}

async function persist(store: OpenKeystore, path: string): Promise<void> {
  await writeKeystoreFile(path, await serializeKeystore(store.entries, store.key, store.salt, store.iterations))
}

/** Finds an already-imported wallet by address, for the reconcile path above. */
async function lookupByAddress(
  address: string,
  apiKey: string,
  ctx: CommandContext,
): Promise<LinkedWalletRow | undefined> {
  const res = await apiRequest("/api/v1/agent/wallets", {
    auth: "key",
    credentials: { apiKey },
    apiUrl: ctx.apiUrl,
    fetch: ctx.deps.fetch,
    env: ctx.deps.env,
  })
  if (!res.ok) return undefined
  const rows = (res.body as { page?: LinkedWalletRow[] }).page ?? []
  return rows.find((r) => r.address?.toLowerCase() === address.toLowerCase())
}
