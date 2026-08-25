/**
 * The strict account guard (docs/superpowers/specs/2026-08-19-cli-profiles-design.md, "The
 * mismatch guard", settled strict on 2026-08-19). Before an authenticated command acts, the
 * profile's stored key is asked which account it belongs to; a different answer from the
 * account the profile recorded is a refusal that names both. The check needs a network call,
 * so a failed call degrades to a warning: an unreachable API says nothing about which account a
 * credential belongs to. It is skipped where there is nothing to compare, and under an env
 * credential override, which the identity line already names as acting.
 *
 * SCOPE: what this verifies is the stored API KEY, and only that. `keys` authenticates with the
 * device token instead, and is guarded on the key as a proxy for it: `auth login` writes the two
 * together under one profile's refs and `auth logout` deletes them together, so a key belonging to
 * another account is evidence about the token filed beside it. It is a proxy, not a proof. Anyone
 * who separates the two refs (importing one credential by hand, say) breaks the inference, and
 * `keys` would then be guarded on something that says nothing about the credential it uses.
 *
 * The `account` field this reads is pinned on the API side by
 * apps/api/src/routes/agent.wallets-embedded.test.ts:133, which asserts the response names the
 * account the key belongs to. Renaming or dropping it therefore fails CI in this repo, before a
 * CLI user ever meets a guard that silently stopped comparing anything.
 */
import { fetchAccount } from "./account"
import type { CliConfig } from "./config"
import type { CommandContext } from "./deps"
import { credentialEnvOverrides, effectiveProfileFields, profileSecretRef } from "./profiles"

/** A refusal carries its wording already split the way `writeLocalFailure` renders a local
 * failure: `message` is the finding (the sentence naming both accounts), `suggestion` the fix
 * (the repairs, one per line). Split HERE so guard.ts stays the single owner of the words, and so
 * a `--json` caller gets the two as separate fields rather than one string to cut apart. */
export type GuardVerdict =
  | { ok: true; skipped?: string; warning?: string }
  | { ok: false; message: string; suggestion: string }

/** `config` is passed in rather than read again: `run` has already read it, resolved `ctx.profile`
 * from it, and migrated it if needed, and the guard must judge that same value. */
export async function verifyProfileAccount(ctx: CommandContext, config: CliConfig): Promise<GuardVerdict> {
  const { deps, profile } = ctx
  if (!ctx.verifyAccount) return { ok: true, skipped: "--no-verify-account" }
  if (!profile) return { ok: true, skipped: "no profile" }
  if (credentialEnvOverrides(deps.env).length > 0) return { ok: true, skipped: "env override" }
  const cached = effectiveProfileFields(config, profile).account
  if (!cached) return { ok: true, skipped: "no cached account" }
  const apiKey = await deps.store.get(profileSecretRef(profile, "apiKey"))
  if (!apiKey) return { ok: true, skipped: "no stored key" }

  // Its own request, not the body `wallets` is about to fetch for itself: see account.ts.
  const { account: live, failure } = await fetchAccount(deps, ctx.apiUrl, apiKey)
  if (!live) {
    return {
      ok: true,
      warning: `Could not verify the account for ${profile} (${failure}); proceeding on the cached value ${cached}.`,
    }
  }
  if (live !== cached) {
    // The three repairs, cheapest first. A key that was legitimately re-issued needs only a
    // re-cache, so `profile use` leads; re-authentication mints a new key, and the flag skips the
    // check without fixing anything, so it comes last. Naming only the last two (as this message
    // first did) offers a refusal whose cheapest listed way out is more expensive than the real
    // one, which is how an operator ends up minting a key they did not need.
    return {
      ok: false,
      message: `Refusing: profile ${profile} expects account ${cached} but its stored key belongs to ${live}.`,
      suggestion: [
        `If that key was legitimately re-issued: candle profile use ${profile}`,
        `To re-authenticate: candle auth login --profile ${profile}`,
        "To proceed once without the check: --no-verify-account",
      ].join("\n"),
    }
  }
  return { ok: true }
}
