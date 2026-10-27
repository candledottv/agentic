/**
 * Whether a profile is core-owned, and what the plain CLI may still do as one (BE-1665, spec K-11).
 *
 * A profile is core-owned when its slot file exists. The `coreOwned` marker in config.json is
 * informational: it can make a profile count as core-owned, never the reverse. Deleting or editing
 * it restores nothing, because the plain items were deleted when the slot was written and no plain
 * CLI path reaches the slot loader (`slot.ts`). This file only ever `stat`s the slot; it cannot
 * read what is in it.
 *
 * For a core-owned profile, dispatch runs only the invocations in {@link CORE_OWNED_INVOCATIONS}:
 * reads that work with the Read key, and the commands that act as no identity. Everything else,
 * including any command added later, is refused with `PROFILE_CORE_OWNED` until it is listed. That
 * is the same fail-closed rule as the card table's `TOOL_NOT_CLASSIFIED` (K-1): a new command is
 * never silently treated as a read. `resolveDeviceToken` refuses as well, as a second guard.
 */
import { stat } from "node:fs/promises"
import type { CliConfig } from "../config"
import type { Deps } from "../deps"
import { type CorePaths, corePaths } from "./paths"

export const PROFILE_CORE_OWNED = "PROFILE_CORE_OWNED"

export class ProfileCoreOwnedError extends Error {
  readonly code = PROFILE_CORE_OWNED
  constructor(readonly profile: string) {
    super(coreOwnedMessage(profile))
    this.name = "ProfileCoreOwnedError"
  }
}

export function coreOwnedMessage(profile: string): string {
  return `Profile "${profile}" is owned by the Candle core: its Write key and device token are in the core-only slot, and this command would need one of them.`
}

export const CORE_OWNED_SUGGESTION =
  "Do this from the Candle TUI, where the core asks for your vault factor, or act as another profile with --profile."

/** Whether the slot file exists. Never opens it. */
export async function slotExists(paths: Pick<CorePaths, "slot">): Promise<boolean> {
  try {
    await stat(paths.slot)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    // Unreadable is not absent: a slot we cannot stat may still be there.
    return true
  }
}

export async function isCoreOwned(
  deps: Pick<Deps, "env" | "homedir">,
  config: CliConfig,
  profile: string | undefined,
): Promise<boolean> {
  if (profile === undefined) return false
  if (config.profiles?.[profile]?.coreOwned === true) return true
  let paths: CorePaths
  try {
    paths = corePaths(deps.env, deps.homedir(), profile)
  } catch {
    // No resolvable config directory means no slot could have been written under it.
    return false
  }
  return slotExists(paths)
}

/**
 * The invocations a core-owned profile may still run. `"<command>"` is the bare form;
 * `"<command> <sub>"` one subcommand; `"<command> *"` every subcommand and the bare form.
 */
export const CORE_OWNED_INVOCATIONS: readonly string[] = [
  // The owner itself.
  "core *",
  // Reads, with the Read key the plain store keeps. `keys list` is not here: it is the owner's
  // read over the device token, which only the core holds. `auth status` and `doctor` report the
  // device token as held by the core instead of reading it.
  "auth status",
  "portfolio",
  "pnl",
  "plans",
  "token clusters",
  "wallets",
  "swap status",
  "fees",
  "lp pools",
  "lp positions",
  "tee status",
  "perps markets",
  "perps market",
  "perps book",
  "perps candles",
  "perps orders",
  "perps fills",
  "perps funding",
  "perps positions",
  "perps account",
  "perps risk",
  "perps watch",
  "vault status",
  "vault list",
  "external list",
  "secrets list",
  // No identity at all.
  "doctor",
  "verify",
  "update",
  "help *",
  "completion *",
  "plugins",
  // Starts the TUI, whose core is the owner (BE-1665).
  "tui",
  // Managing the map. `rename` and `remove` are checked against the profile they name, below.
  "profile *",
  // Only `--read-only`, which starts the server with no key: see `coreOwnedRefusal`.
  "mcp",
]

const ALLOWED = new Set(CORE_OWNED_INVOCATIONS)

/**
 * Whether `cmd sub` may run for a core-owned profile. `isSubcommand` says whether dispatch will
 * route `sub` as a subcommand of `cmd` (otherwise the bare form runs with `sub` as its first token).
 */
export function coreOwnedAllows(input: {
  cmd: string
  sub: string | undefined
  isSubcommand: boolean
  args: readonly string[]
}): boolean {
  const { cmd, sub, isSubcommand, args } = input
  if (ALLOWED.has(`${cmd} *`)) return true
  if (isSubcommand) return ALLOWED.has(`${cmd} ${sub}`)
  if (!ALLOWED.has(cmd)) return false
  if (cmd === "mcp") return args.includes("--read-only")
  return true
}

/**
 * The profile names a `profile rename` or `profile remove` invocation names, so dispatch can refuse
 * one that would orphan a slot. `profile` commands resolve no identity, so the gate reads the
 * positional arguments instead.
 */
export function profileNamesTouched(sub: string | undefined, args: readonly string[]): string[] {
  if (sub !== "rename" && sub !== "remove") return []
  return args.filter((arg) => !arg.startsWith("-"))
}
