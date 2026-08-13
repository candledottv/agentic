/**
 * Release-safety guards for the two constants that only fail on someone else's machine.
 *
 * `SERVER_VERSION` is what `index.ts` hands to `new McpServer({ version })`, so it is what
 * clients see on connect and what anyone debugging a bad release quotes back at us. Nothing at
 * runtime forces it to agree with `package.json`, so a release that bumps one and forgets the
 * other ships a server that lies about its own version.
 *
 * `DEFAULT_API_URL` is worse: this package is installed by strangers via `npx`, and it defaulted
 * to `http://localhost:3001` for as long as a monorepo checkout was the only way to run it. A
 * localhost default in a published package points every fresh install at a dev server that is
 * not running, and the install looks broken rather than misconfigured.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { DEFAULT_API_URL, resolveConfig } from "./client"
import { SERVER_VERSION } from "./version"

describe("SERVER_VERSION", () => {
  test("matches the version in package.json", async () => {
    const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
      version: string
    }
    expect(SERVER_VERSION).toBe(pkg.version)
  })
})

describe("resolveConfig", () => {
  const originalUrl = process.env.CANDLE_API_URL

  beforeEach(() => {
    delete process.env.CANDLE_API_URL
  })

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.CANDLE_API_URL
    else process.env.CANDLE_API_URL = originalUrl
  })

  test("defaults to the production API, not localhost", () => {
    expect(DEFAULT_API_URL).toBe("https://api.candle.tv")
    expect(resolveConfig().apiUrl).toBe("https://api.candle.tv")
  })

  test("CANDLE_API_URL overrides the default for local development", () => {
    process.env.CANDLE_API_URL = "http://localhost:3001"
    expect(resolveConfig().apiUrl).toBe("http://localhost:3001")
  })

  test("trims whitespace and falls back when the override is blank", () => {
    process.env.CANDLE_API_URL = "   "
    expect(resolveConfig().apiUrl).toBe("https://api.candle.tv")
  })
})
