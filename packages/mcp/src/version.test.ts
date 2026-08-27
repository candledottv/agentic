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
    expect(DEFAULT_API_URL).toBe("https://api.alpha.candle.tv")
    expect(resolveConfig().apiUrl).toBe("https://api.alpha.candle.tv")
  })

  test("CANDLE_API_URL overrides the default for local development", () => {
    process.env.CANDLE_API_URL = "http://localhost:3001"
    expect(resolveConfig().apiUrl).toBe("http://localhost:3001")
  })

  test("trims whitespace and falls back when the override is blank", () => {
    process.env.CANDLE_API_URL = "   "
    expect(resolveConfig().apiUrl).toBe("https://api.alpha.candle.tv")
  })

  test("a cleartext CANDLE_API_URL to a real host is refused at startup", () => {
    // Every write tool sends x-api-key, so an http:// base URL hands the agent key to the path.
    process.env.CANDLE_API_URL = "http://api.candle.tv"
    expect(() => resolveConfig()).toThrow(/refusing to send credentials in the clear/i)
  })

  test("CANDLE_ALLOW_INSECURE_HTTP opts a non-loopback host back in", () => {
    process.env.CANDLE_API_URL = "http://host.docker.internal:3000"
    process.env.CANDLE_ALLOW_INSECURE_HTTP = "1"
    try {
      expect(resolveConfig().apiUrl).toBe("http://host.docker.internal:3000")
    } finally {
      delete process.env.CANDLE_ALLOW_INSECURE_HTTP
    }
  })

  test("every loopback spelling stays allowed without an opt-in", () => {
    for (const url of ["http://localhost:3001", "http://127.0.0.1:3001", "http://[::1]:3001"]) {
      process.env.CANDLE_API_URL = url
      expect(resolveConfig().apiUrl).toBe(url)
    }
  })
})

describe("resolveConfig API key alias", () => {
  const originalAgentKey = process.env.CANDLE_AGENT_API_KEY
  const originalAliasKey = process.env.CANDLE_API_KEY

  beforeEach(() => {
    delete process.env.CANDLE_AGENT_API_KEY
    delete process.env.CANDLE_API_KEY
  })

  afterEach(() => {
    if (originalAgentKey === undefined) delete process.env.CANDLE_AGENT_API_KEY
    else process.env.CANDLE_AGENT_API_KEY = originalAgentKey
    if (originalAliasKey === undefined) delete process.env.CANDLE_API_KEY
    else process.env.CANDLE_API_KEY = originalAliasKey
  })

  test("CANDLE_API_KEY is used when CANDLE_AGENT_API_KEY is unset", () => {
    process.env.CANDLE_API_KEY = "cndl_live_alias"
    expect(resolveConfig().apiKey).toBe("cndl_live_alias")
  })

  test("CANDLE_AGENT_API_KEY takes precedence when both are set", () => {
    process.env.CANDLE_AGENT_API_KEY = "cndl_live_agent"
    process.env.CANDLE_API_KEY = "cndl_live_alias"
    expect(resolveConfig().apiKey).toBe("cndl_live_agent")
  })

  test("neither set yields no key", () => {
    expect(resolveConfig().apiKey).toBeUndefined()
  })
})
