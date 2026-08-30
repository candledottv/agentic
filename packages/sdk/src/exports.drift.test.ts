/**
 * Every public type in client.ts is reachable from the package root.
 *
 * These are the SIGNATURE types of public methods: what `listWallets`, `submitAtomicLaunch`,
 * `linkedSwap` and friends take and return. A consumer who cannot name them cannot write a typed
 * wrapper, hold a result in a variable, or narrow one, and their only recourse is to deep-import
 * `@candledottv/agent-sdk/dist/client`, which is not a supported path and can move under them.
 *
 * Eighteen had drifted out of the root by 2026-08-30, found by an external audit. Nothing checked
 * it, because adding a method and its types to client.ts is a complete-looking change on its own:
 * it compiles, it is tested, and the omission is invisible until someone outside tries to use it.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("SDK public exports", () => {
  test("every type exported from client.ts is re-exported from the package root", () => {
    const dir = import.meta.dir
    const client = readFileSync(join(dir, "client.ts"), "utf8")
    const index = readFileSync(join(dir, "index.ts"), "utf8")
    const declared = [...client.matchAll(/^export (?:interface|type) (\w+)/gm)].map((m) => m[1] as string)
    const missing = declared.filter((name) => !new RegExp(`\\b${name}\\b`).test(index)).sort()
    expect(missing).toEqual([])
  })
})
