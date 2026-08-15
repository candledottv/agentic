/**
 * Drift guard for the CLI's vendored copies of the SDK's wallet-import crypto.
 *
 * `src/wallet-import.ts` and `src/internal/encoding.ts` are byte-identical copies of the SDK's
 * modules of the same names, vendored rather than imported because the CLI has zero runtime
 * dependencies by design (spec decision 4; same reasoning as secret-store.ts's own deliberate
 * re-implementation note): a workspace import of `@candledottv/agent-sdk` would make the CLI's
 * typecheck and build depend on the SDK's dist existing, which a clean checkout does not have.
 * The three crypto libraries the copies import are declared as CLI devDependencies and BUNDLED
 * into dist at build time (`bun build` without `--packages=external`), so the published bin
 * still installs nothing.
 *
 * This test is what makes the vendoring safe: any change to the SDK's originals must be copied
 * here verbatim (`cp packages/sdk/src/wallet-import.ts packages/cli/src/wallet-import.ts`, same
 * for internal/encoding.ts), or this fails. Skipped when the SDK source is absent (the public
 * agentic mirror may ship packages independently); the monorepo, where edits happen, always has
 * both.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const PAIRS = [
  ["src/wallet-import.ts", "../sdk/src/wallet-import.ts"],
  ["src/internal/encoding.ts", "../sdk/src/internal/encoding.ts"],
] as const

const cliRoot = join(import.meta.dir, "..")

describe("vendored wallet-import crypto", () => {
  for (const [cliPath, sdkPath] of PAIRS) {
    test(`${cliPath} is byte-identical to the SDK original`, () => {
      const sdkFile = join(cliRoot, "..", sdkPath)
      if (!existsSync(sdkFile)) {
        // Standalone checkout without the SDK source: nothing to drift from.
        return
      }
      const cli = readFileSync(join(cliRoot, cliPath), "utf8")
      const sdk = readFileSync(sdkFile, "utf8")
      expect(cli).toBe(sdk)
    })
  }
})
