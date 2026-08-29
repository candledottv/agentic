/**
 * `candle wallets export`: recover one private key from the keystore.
 *
 * This exists because the spec chose independent random keys over a mnemonic, which makes the
 * keystore the only copy. A backup nobody can read without this CLI is not a backup, so there has
 * to be a way out. The format is also self-describing precisely so this command is a convenience
 * rather than the only route.
 *
 * Deliberately one wallet at a time, with no `--all`. A command that prints every private key in a
 * single call is the first thing an attacker with a shell would reach for, and copying a keystore
 * elsewhere is a file copy that already works.
 *
 * The confirmation is `--yes` rather than an interactive prompt. Deps has no non-secret prompt, and
 * a flag is the better gate regardless: it cannot be fat-fingered past the way a y/n can, and it
 * leaves a record in shell history that someone deliberately asked to print a key.
 */
import { parseArgs } from "../args"
import type { CommandContext } from "../deps"
import { writeLocalFailure, writeUsageFailure } from "../render"
import { defaultKeystorePath, readKeystore } from "../wallet-keystore"

export async function walletsExport(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, json } = ctx
  const parsed = parseArgs(args, { valueFlags: ["--index", "--keystore"], booleanFlags: ["--yes"] })
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}`, json)
    return 2
  }

  const indexFlag = parsed.values["--index"]
  if (indexFlag === undefined) {
    writeUsageFailure(deps, "--index <n> is required. Export prints one key at a time, by design.", json)
    return 2
  }
  const index = Number.parseInt(indexFlag, 10)
  if (!Number.isInteger(index) || index < 0) {
    writeUsageFailure(deps, "--index must be a whole number, zero or greater.", json)
    return 2
  }

  const keystorePath = parsed.values["--keystore"] ?? defaultKeystorePath(deps.env)
  let raw: string
  try {
    raw = await deps.readFile(keystorePath)
  } catch {
    writeLocalFailure(deps, { code: "KEYSTORE_MISSING", message: `No keystore at ${keystorePath}.` }, json)
    return 1
  }

  const fromEnv = deps.env.CANDLE_KEYSTORE_PASSPHRASE
  const passphrase =
    fromEnv !== undefined && fromEnv !== ""
      ? fromEnv
      : (await deps.promptSecret("Keystore passphrase (input hidden): ")).trim()
  if (passphrase === "") {
    writeLocalFailure(deps, { code: "KEYSTORE_PASSPHRASE", message: "A keystore passphrase is required." }, json)
    return 1
  }

  let entries: Awaited<ReturnType<typeof readKeystore>>["entries"]
  try {
    entries = (await readKeystore(raw, passphrase)).entries
  } catch (error) {
    writeLocalFailure(
      deps,
      { code: "KEYSTORE_UNREADABLE", message: error instanceof Error ? error.message : String(error) },
      json,
    )
    return 1
  }

  const entry = entries.find((e) => e.index === index)
  if (!entry) {
    writeLocalFailure(
      deps,
      {
        code: "NO_SUCH_WALLET",
        message: `This keystore has no wallet at index ${index}. It holds ${entries.length}.`,
      },
      json,
    )
    return 1
  }

  // Without --yes, name what WOULD be printed and stop. Two steps means an operator sees the
  // address before a key reaches their scrollback, and a mistyped index costs nothing.
  if (!parsed.booleans.has("--yes")) {
    deps.stdout.write(`Would export the private key for:\n`)
    deps.stdout.write(`  [${entry.index}] ${entry.address}  ${entry.label}  (${entry.chain})\n`)
    deps.stdout.write(`\nThis prints a private key to your terminal. Re-run with --yes to confirm.\n`)
    return 1
  }

  if (json) {
    deps.stdout.write(
      `${JSON.stringify({
        index: entry.index,
        chain: entry.chain,
        address: entry.address,
        label: entry.label,
        privateKey: entry.privateKey,
      })}\n`,
    )
    return 0
  }

  deps.stdout.write(`${entry.address}  (${entry.chain}, ${entry.label})\n`)
  deps.stdout.write(`${entry.privateKey}\n`)
  return 0
}
