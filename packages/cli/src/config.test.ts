/**
 * `config.ts`: the CLI's non-secret settings file (`~/.config/candle/config.json`, or
 * `$CANDLE_CONFIG_DIR/config.json` in tests). Credentials never land here -- see the comment on
 * `CliConfig` in `config.ts` -- so these tests only exercise plain JSON read/merge/clear.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearConfig, readConfig, writeConfig } from "./config"

const ORIGINAL_CONFIG_DIR_ENV = process.env.CANDLE_CONFIG_DIR

describe("config", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "candle-cli-config-"))
    process.env.CANDLE_CONFIG_DIR = dir
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    if (ORIGINAL_CONFIG_DIR_ENV === undefined) delete process.env.CANDLE_CONFIG_DIR
    else process.env.CANDLE_CONFIG_DIR = ORIGINAL_CONFIG_DIR_ENV
  })

  test("readConfig returns {} when no config file exists", async () => {
    expect(await readConfig()).toEqual({})
  })

  test("writeConfig then readConfig round-trips the patch", async () => {
    await writeConfig({ apiUrl: "https://api.example.com", label: "my laptop" })
    expect(await readConfig()).toEqual({ apiUrl: "https://api.example.com", label: "my laptop" })
  })

  test("writeConfig merges with the existing file rather than replacing it", async () => {
    await writeConfig({ apiUrl: "https://api.example.com" })
    await writeConfig({ label: "my laptop" })
    expect(await readConfig()).toEqual({ apiUrl: "https://api.example.com", label: "my laptop" })
  })

  test("writeConfig overwrites a field that is patched again", async () => {
    await writeConfig({ label: "first" })
    await writeConfig({ label: "second" })
    expect(await readConfig()).toEqual({ label: "second" })
  })

  test("writeConfig persists scopes as a plain array", async () => {
    await writeConfig({ scopes: ["trade:read", "trade:write"] })
    expect(await readConfig()).toEqual({ scopes: ["trade:read", "trade:write"] })
  })

  test("clearConfig removes the file; readConfig then returns {}", async () => {
    await writeConfig({ apiUrl: "https://api.example.com" })
    await clearConfig()
    expect(await readConfig()).toEqual({})
  })

  test("clearConfig is a no-op when no config file exists", async () => {
    await expect(clearConfig()).resolves.toBeUndefined()
  })

  test("the config directory is created with mode 0700", async () => {
    await writeConfig({ apiUrl: "https://api.example.com" })
    const stats = await stat(dir)
    expect(stats.mode & 0o777).toBe(0o700)
  })

  test("the config file on disk is plain, readable JSON (no credential fields ever written to it)", async () => {
    await writeConfig({ apiUrl: "https://api.example.com", keyPrefix: "ck_live_", label: "my laptop" })
    const raw = await readFile(join(dir, "config.json"), "utf8")
    const parsed = JSON.parse(raw)
    expect(parsed).toEqual({ apiUrl: "https://api.example.com", keyPrefix: "ck_live_", label: "my laptop" })
  })
})
