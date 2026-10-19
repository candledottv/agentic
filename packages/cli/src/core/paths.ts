/**
 * Where a Candle core keeps its state (BE-1665, spec 2026-10-19-candle-tui-s1-core-design.md, C-2
 * and C-4): one directory per profile, `<config dir>/core/<profile>/`, mode 0700.
 *
 * Every file the core owns is named here, so the core, the ownership check the plain CLI runs
 * (`ownership.ts`) and the tests agree on one layout. The slot file's existence is what makes a
 * profile core-owned (K-11), which is why its path is resolvable without the core running.
 */
import { chmod, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { isValidProfileName } from "../profiles"
import { candleConfigDir } from "../vault/store"

export interface CorePaths {
  dir: string
  /** The single-instance lock (C-2). */
  lock: string
  /** The attach socket (A-1). Named here so `CORE_ALREADY_RUNNING` can point at it. */
  socket: string
  /** Append-only, one JSON row per line (K-10). */
  journal: string
  /** The core-only credential slot (K-11). Its existence alone makes the profile core-owned. */
  slot: string
  /** Harness token hashes (A-2). */
  tokens: string
}

export function corePaths(env: Record<string, string | undefined>, home: string, profile: string): CorePaths {
  // The profile name becomes a path segment. A name that is not a valid profile name could be
  // `..` or carry a separator; refusing it here keeps every core path inside `core/`.
  if (!isValidProfileName(profile)) throw new Error(`Invalid profile name for the core: ${profile}`)
  const dir = join(candleConfigDir(env, home), "core", profile)
  return {
    dir,
    lock: join(dir, "core.lock"),
    socket: join(dir, "core.sock"),
    journal: join(dir, "journal.jsonl"),
    slot: join(dir, "slot.enc"),
    tokens: join(dir, "tokens.json"),
  }
}

/** Creates the state directory with mode 0700, and tightens it if it already existed looser. */
export async function ensureCoreDir(paths: CorePaths): Promise<void> {
  await mkdir(paths.dir, { recursive: true, mode: 0o700 })
  await chmod(paths.dir, 0o700)
}
