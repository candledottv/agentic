/**
 * Ember Phase 2 (BE-136, AD-3): `wallets generate` and `wallets export`, removed.
 *
 * A check of production and staging on 2026-09-17 found no imported wallet that came from
 * `wallets generate`, so no `wallets.enc` sits behind any linked wallet. Draft 2 had recommended a
 * deprecation period on the assumption that scripts depended on these two; the check removed that
 * assumption, and keeping them would leave a plaintext export and a scriptable unlock beside a
 * vault that forbids both. So they are gone, with no migration command.
 *
 * They still ROUTE, deliberately. A word that stopped being a command would print the general help
 * and exit 1, which reads as "you typed it wrong". These exit 2 with `COMMAND_REMOVED`, name what
 * replaces them, and name the earlier release that still opens a `wallets.enc` -- which is the one
 * thing an operator holding such a file actually needs.
 *
 * The residual AD-3 states rather than hides: a key that a `generate` run sealed but never
 * imported is invisible server-side, so the check could not have seen it. Anyone holding such a
 * file opens it with an earlier CLI release's `wallets export` and moves the funds on chain to a
 * vault key. The vault never reads, writes or deletes `wallets.enc`, and `wallets import` and
 * `wallets revoke` are untouched.
 */
import type { CommandContext } from "../deps"
import { writeLocalFailure } from "../render"

/** The last release whose `wallets export` still opens a `wallets.enc`. */
const LAST_RELEASE_WITH_EXPORT = "0.9.2"

function removed(ctx: CommandContext, command: string, replacement: string, extra?: string): number {
  writeLocalFailure(
    ctx.deps,
    {
      code: "COMMAND_REMOVED",
      message: `\`candle ${command}\` was removed in CLI 0.10.0. ${replacement}`,
      suggestion:
        `${extra ? `${extra} ` : ""}A wallets.enc already on disk is left exactly as it is: no command in this release reads, writes or deletes it. ` +
        `To open one, use CLI ${LAST_RELEASE_WITH_EXPORT} (candle update --to cli-v${LAST_RELEASE_WITH_EXPORT}) and move the funds on chain to a vault key.`,
    },
    ctx.json,
  )
  return 2
}

export async function walletsGenerateRemoved(_args: string[], ctx: CommandContext): Promise<number> {
  return removed(
    ctx,
    "wallets generate",
    "Keys are now derived inside the vault, from one recovery phrase: candle vault new-key --chain solana.",
    "Create a vault first with `candle vault init`.",
  )
}

export async function walletsExportRemoved(_args: string[], ctx: CommandContext): Promise<number> {
  return removed(
    ctx,
    "wallets export",
    "No command in this release prints a private key to stdout or to --json.",
    "The vault's only plaintext routes are two interactive ceremonies: `candle vault phrase show` for the recovery phrase, and `candle vault export-key` for one key, which ships in the same 0.10.0 release (AD-10).",
  )
}
