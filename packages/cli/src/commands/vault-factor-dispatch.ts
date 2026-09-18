/**
 * `candle vault factor <list|add|remove>` (Ember Phase 2, BE-136).
 *
 * The CLI's dispatch table is one level deep, so a command with a second word of its own routes it
 * here. Kept as its own module rather than inside `vault-factor.ts` so that file holds the three
 * operations and nothing about routing.
 */
import type { CommandContext } from "../deps"
import { vaultFactorAdd, vaultFactorList, vaultFactorRemove } from "./vault-factor"
import { usage } from "./vault-support"

export async function vaultFactor(args: string[], ctx: CommandContext): Promise<number> {
  const [word, ...rest] = args
  switch (word) {
    case "list":
      return vaultFactorList(rest, ctx)
    case "add":
      return vaultFactorAdd(rest, ctx)
    case "remove":
      return vaultFactorRemove(rest, ctx)
    case undefined:
      return usage(
        ctx,
        "Usage: candle vault factor <list | add passphrase | add security-key | add touch-id | remove <id>>",
      )
    default:
      return usage(ctx, `Unknown subcommand: vault factor ${word}. Try: list, add, remove`)
  }
}
