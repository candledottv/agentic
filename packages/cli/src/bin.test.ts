/**
 * Bundle-level tests of the bin entry itself: build dist/index.js and execute it the ways a real
 * installation does. The symlink case is the load-bearing one. Package managers run a bin through
 * node_modules/.bin/candle, a SYMLINK to the bundle, and node keeps the symlink path in argv[1]
 * while import.meta.url resolves to the real file. The original isMainModule guard compared the
 * two unrealpath'd, so every bunx/npx invocation silently exited 0 having done nothing -- caught
 * live by the P4b-3 acceptance test after three review rounds of direct-path-only testing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import pkg from "../package.json"
import { fakeWalletsApi, pipeEnv, runPipeline, shellQuote } from "./test-support"

const pkgDir = resolve(import.meta.dir, "..")
const bundle = join(pkgDir, "dist", "index.js")

beforeAll(() => {
  const built = spawnSync("bun", ["run", "build"], { cwd: pkgDir, encoding: "utf8" })
  if (built.status !== 0) throw new Error(`build failed: ${built.stderr}`)
})

function runNode(entry: string, args: string[]) {
  return spawnSync("node", [entry, ...args], { encoding: "utf8" })
}

describe("the built bin entry", () => {
  test("runs when invoked by its direct path", () => {
    const res = runNode(bundle, ["--version"])
    expect(res.status).toBe(0)
    expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test("runs when invoked through a symlink, the way bunx and npx execute a bin", () => {
    const dir = mkdtempSync(join(tmpdir(), "candle-bin-"))
    const link = join(dir, "candle")
    symlinkSync(bundle, link)
    const res = runNode(link, ["--version"])
    // The unfixed guard exits 0 with EMPTY output here, so assert on stdout, not just the code.
    expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
    expect(res.status).toBe(0)
  })

  test("carries the Sigstore verifier inside the bundle, with no runtime dependency to install", () => {
    // The three @sigstore packages are devDependencies. `bun build` inlines them into
    // dist/index.js, so the published package still declares no runtime dependencies at all
    // (README.md's opening paragraph) and `engines: node >=18` stays true -- as runtime
    // dependencies they would be installed on their own terms, and @sigstore/verify's own engines
    // floor refuses Node 18 and 20.
    //
    // What makes that move safe is not the manifest but this: the bundle alone, run by plain node
    // with nothing installed beside it, verifies a real Sigstore bundle.
    expect((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}).toEqual({})
    expect(readFileSync(bundle, "utf8")).toContain("sigstore")

    const fx = join(pkgDir, "test-fixtures", "sigstore")
    const res = runNode(bundle, [
      "verify",
      join(fx, "fixture.bin"),
      "--bundle",
      join(fx, "fixture.sigstore.json"),
      "--identity",
      readFileSync(join(fx, "identity.txt"), "utf8").trim(),
      "--issuer",
      readFileSync(join(fx, "issuer.txt"), "utf8").trim(),
    ])
    expect(res.stdout).toContain("verified:")
    expect(res.status).toBe(0)
  })

  test("through a symlink, a real command still dispatches (bunx passthrough token included)", () => {
    const dir = mkdtempSync(join(tmpdir(), "candle-bin-"))
    const link = join(dir, "candle")
    symlinkSync(bundle, link)
    // `candle` as the first token mirrors bunx passing the bin name through; the dispatcher
    // strips one leading `candle`. `--help` proves main() ran and dispatch executed.
    const res = runNode(link, ["candle", "--help"])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain("Usage:")
  })
})

// BE-299, T5: T1 and T2 of stdout-drain.compiled.test.ts, through the npm shape. An agent running
// `npx @candledottv/cli` gets this bundle under node, where the unfixed exit cut piped output at
// 65,536 bytes and, once the write outlived the command, an early reader surfaced an unhandled EPIPE.
// Spawned asynchronously (the fake API is served from this process), and through a pipe(2) that
// bash makes, never the spawner's own socket. `node` is resolved here, before `pipeEnv` replaces
// PATH with one that does not hold it, and invoked by that absolute path.
describe("the built bin entry, through a real pipe", () => {
  const ROWS = 1_200
  let api: { url: string; stop(): void }
  let node: string

  beforeAll(() => {
    const found = Bun.which("node")
    if (!found) throw new Error("the pipe test needs node on PATH, and Bun.which could not find it")
    node = found
    api = fakeWalletsApi(ROWS)
  })

  afterAll(() => api?.stop())

  function candle(args: string): string {
    return `${shellQuote(node)} ${shellQuote(bundle)} --api-url ${shellQuote(api.url)} --no-verify-account ${args}`
  }

  test("wallets --json arrives whole to a slow reader", async () => {
    const res = await runPipeline(`${candle("wallets --json")} | (sleep 0.5; cat)`, pipeEnv())
    expect(res.err).toBe("")
    expect(res.status).toBe(0)
    expect(res.out.length).toBeGreaterThan(4 * 65_536)
    expect(res.out.at(-1)).toBe(0x0a)
    const doc = JSON.parse(res.out.toString("utf8"))
    expect(doc.walletCount).toBe(ROWS)
    expect(doc.linked.page.length).toBe(ROWS)
    expect(doc.truncated).toBe(false)
  }, 60_000)

  test("a reader that closes early (| head) ends the output quietly with status 0", async () => {
    const res = await runPipeline(`${candle("wallets --json")} 2>&1 | head -c 10; exit "\${PIPESTATUS[0]}"`, pipeEnv())
    expect(res.err).toBe("")
    expect(res.out.toString("utf8")).toBe('{"embedded')
    expect(res.status).toBe(0)
  }, 60_000)
})
