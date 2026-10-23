/**
 * BE-1665 (spec C-1): `candle tui`, the thin entry to the Candle TUI.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CommandContext } from "../deps"
import { createCapture, createTestDeps } from "../test-support"
import { tui } from "./tui"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function setup(installed: boolean) {
  const bin = await mkdtemp(join(tmpdir(), "candle-tui-bin-"))
  dirs.push(bin)
  if (installed) {
    await writeFile(join(bin, "candle-tui"), "#!/bin/sh\nexit 0\n")
    await chmod(join(bin, "candle-tui"), 0o755)
  }
  const runs: { path: string; args: string[]; env: Record<string, string> }[] = []
  const deps = createTestDeps({
    fetch: (async () => new Response("{}")) as unknown as typeof fetch,
    env: {
      PATH: bin,
      HOME: "/home/x",
      CANDLE_CONFIG_DIR: "/cfg",
      CANDLE_API_KEY: "cndl_test_example",
      CANDLE_DEVICE_TOKEN: "dt_example",
    },
    execPath: "/opt/candle/bin/candle",
    stderr: createCapture(),
    runPlugin: async (path, args, env) => {
      runs.push({ path, args, env })
      return 0
    },
  })
  const ctx: CommandContext = {
    deps,
    json: false,
    apiUrl: "https://staging.api.candle.tv",
    profile: "staging",
    verifyAccount: true,
  }
  return { bin, deps, ctx, runs }
}

describe("candle tui", () => {
  test("runs candle-tui from PATH with the profile and this candle, and no credential variable", async () => {
    const s = await setup(true)
    expect(await tui([], s.ctx)).toBe(0)
    expect(s.runs).toEqual([
      {
        path: join(s.bin, "candle-tui"),
        args: ["--profile", "staging", "--candle", "/opt/candle/bin/candle"],
        env: { PATH: s.bin, HOME: "/home/x", CANDLE_CONFIG_DIR: "/cfg" },
      },
    ])
  })

  test("says so when the TUI is not installed", async () => {
    const s = await setup(false)
    expect(await tui([], s.ctx)).toBe(1)
    expect((s.deps.stderr as unknown as { text: string }).text).toContain("candle-tui")
    expect(await tui(["extra"], s.ctx)).toBe(2)
  })
  test("non-TTY, plain and JSON invocations refuse before starting a screen", async () => {
    for (const mode of ["pipe", "plain", "json", "dumb"]) {
      const s = await setup(true)
      if (mode === "pipe") s.deps.isTTY.stdout = false
      if (mode === "plain") s.deps.presentation = { plain: true }
      if (mode === "json") s.ctx.json = true
      if (mode === "dumb") s.deps.env.TERM = "dumb"
      expect(await tui([], s.ctx)).toBe(1)
      expect(s.runs).toHaveLength(0)
      const output = (s.deps.stderr as ReturnType<typeof createCapture>).text
      if (mode !== "json") expect(output).toContain("candle portfolio")
    }
  })
  test("--no-color reaches the TUI as NO_COLOR", async () => {
    const s = await setup(true)
    s.deps.presentation = { noColor: true }
    expect(await tui([], s.ctx)).toBe(0)
    expect(s.runs[0]?.env.NO_COLOR).toBe("1")
  })
})
