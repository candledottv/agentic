/**
 * `candle vault phrase show` (Ember Phase 2, BE-136).
 *
 * `show` is the only word, and it is spelled out rather than made the bare form on purpose: a bare
 * `candle vault phrase` that rendered a recovery phrase would be one typo away from an operator
 * who meant `candle vault status`.
 */
import type { CommandContext } from "../deps"
import { vaultPhraseShow } from "./vault-phrase"
import { usage } from "./vault-support"

export async function vaultPhrase(args: string[], ctx: CommandContext): Promise<number> {
  const [word, ...rest] = args
  if (word === "show") return vaultPhraseShow(rest, ctx)
  if (word === undefined) return usage(ctx, "Usage: candle vault phrase show")
  return usage(ctx, `Unknown subcommand: vault phrase ${word}. The only one is: show`)
}
