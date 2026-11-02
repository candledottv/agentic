/**
 * The update notice must be discovered for free (a header on a response the command already
 * made), shown at most once a day, suppressed where it would be noise, and incapable of
 * changing a command's outcome. `wallets list` is the vehicle: an ordinary command whose one
 * API call carries -- or does not carry -- the x-candle-cli-latest header.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { run } from "./index"
import { createCapture, createFakeStore, createRoutedFetch, createTestDeps, jsonResponse } from "./test-support"
import { __resetUpdateNoticeForTest } from "./update-notice"
import { CLI_VERSION } from "./version"

const NEWER = "99.0.0"

function walletRoutes(headers: Record<string, string>) {
  return createRoutedFetch({
    "/api/v1/agent/wallets/embedded": () =>
      jsonResponse(200, { success: true, wallets: { solana: null, evm: null } }, headers),
    "/api/v1/agent/wallets": () =>
      jsonResponse(200, { success: true, page: [], isDone: true, continueCursor: null }, headers),
  })
}

function depsWith(fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) {
  return createTestDeps({
    fetch,
    store: createFakeStore({ api_key: "ck_live_x" }),
    stdout: createCapture(),
    stderr: createCapture(),
    ...extra,
  } as Parameters<typeof createTestDeps>[0])
}

afterEach(() => {
  __resetUpdateNoticeForTest()
})

beforeEach(() => {
  __resetUpdateNoticeForTest()
})

describe("update notice", () => {
  test("a newer version on a response header prints one stderr line with the exact command", async () => {
    const stderr = createCapture()
    const deps = depsWith(walletRoutes({ "x-candle-cli-latest": NEWER }).fetch, { stderr })
    const code = await run(["wallets"], deps)
    expect(code).toBe(0)
    expect(stderr.text).toContain(
      `Update available: candle ${CLI_VERSION} -> ${NEWER}. Run: npm i -g @candledottv/cli@latest`,
    )
  })

  test("shown once per day, not once per command", async () => {
    const stderr = createCapture()
    const deps = depsWith(walletRoutes({ "x-candle-cli-latest": NEWER }).fetch, { stderr })
    await run(["wallets"], deps)
    __resetUpdateNoticeForTest()
    await run(["wallets"], deps)
    const occurrences = stderr.text.split("Update available").length - 1
    expect(occurrences).toBe(1)
  })

  test("stays on stderr under --json, so agents see it and parsers never do", async () => {
    const stdout = createCapture()
    const stderr = createCapture()
    const deps = depsWith(walletRoutes({ "x-candle-cli-latest": NEWER }).fetch, { stdout, stderr })
    await run(["wallets", "--json"], deps)
    expect(stderr.text).toContain("Update available")
    expect(stdout.text).not.toContain("Update available")
    // stdout must still parse line-by-line as JSON.
    for (const line of stdout.text.trim().split("\n")) JSON.parse(line)
  })

  test("an up-to-date or older header prints nothing", async () => {
    for (const version of [CLI_VERSION, "0.0.1"]) {
      __resetUpdateNoticeForTest()
      const stderr = createCapture()
      await run(["wallets"], depsWith(walletRoutes({ "x-candle-cli-latest": version }).fetch, { stderr }))
      expect(stderr.text).not.toContain("Update available")
    }
  })

  test("a header of 0, 0.0.0, or a partial version is not an update", async () => {
    for (const version of ["0", "0.0.0", "0.13", "0.13.0.1"]) {
      __resetUpdateNoticeForTest()
      const stderr = createCapture()
      await run(["wallets"], depsWith(walletRoutes({ "x-candle-cli-latest": version }).fetch, { stderr }))
      expect(stderr.text).not.toContain("Update available")
    }
  })

  test("a garbage header is ignored, not trusted", async () => {
    const stderr = createCapture()
    await run(
      ["wallets", "list"],
      depsWith(walletRoutes({ "x-candle-cli-latest": "99.0.0-evil|.*" }).fetch, { stderr }),
    )
    expect(stderr.text).not.toContain("Update available")
  })

  test("CANDLE_NO_UPDATE_NOTIFIER opts out", async () => {
    const stderr = createCapture()
    const deps = depsWith(walletRoutes({ "x-candle-cli-latest": NEWER }).fetch, {
      stderr,
      env: { CANDLE_NO_UPDATE_NOTIFIER: "1" },
    })
    await run(["wallets"], deps)
    expect(stderr.text).not.toContain("Update available")
  })

  test("a response without the header changes nothing", async () => {
    const stderr = createCapture()
    await run(["wallets"], depsWith(walletRoutes({}).fetch, { stderr }))
    expect(stderr.text).not.toContain("Update available")
  })

  describe("install path (BE-2518)", () => {
    const FEED = "/candledottv/cli/releases/latest/download/latest.json"
    function binaryDeps(feedVersion: string | null, execPath = "/usr/local/bin/candle", stderr = createCapture()) {
      const routes = createRoutedFetch({
        "/api/v1/agent/wallets/embedded": () =>
          jsonResponse(200, { success: true, wallets: { solana: null, evm: null } }, { "x-candle-cli-latest": NEWER }),
        "/api/v1/agent/wallets": () =>
          jsonResponse(
            200,
            { success: true, page: [], isDone: true, continueCursor: null },
            { "x-candle-cli-latest": NEWER },
          ),
        [FEED]: () =>
          feedVersion === null
            ? jsonResponse(404, {})
            : jsonResponse(200, { version: feedVersion, tag: `cli-v${feedVersion}`, assets: {} }),
      })
      return { deps: depsWith(routes.fetch, { stderr, execPath }), stderr }
    }

    test("a binary install is not told to update to a version the feed lacks", async () => {
      const { deps, stderr } = binaryDeps(CLI_VERSION)
      await run(["wallets"], deps)
      expect(stderr.text).not.toContain("Update available")
    })

    test("a binary install with the feed unreachable prints nothing", async () => {
      const { deps, stderr } = binaryDeps(null)
      expect(await run(["wallets"], deps)).toBe(0)
      expect(stderr.text).not.toContain("Update available")
    })

    test("a binary install is told the feed's version, not npm's", async () => {
      const { deps, stderr } = binaryDeps("99.0.1")
      await run(["wallets"], deps)
      expect(stderr.text).toContain(`candle ${CLI_VERSION} -> 99.0.1. Run: candle update`)
      expect(stderr.text).not.toContain(NEWER)
    })

    test("a Homebrew install is pointed at brew", async () => {
      const { deps, stderr } = binaryDeps("99.0.1", "/opt/homebrew/Cellar/candle/1/bin/candle")
      await run(["wallets"], deps)
      expect(stderr.text).toContain("Run: brew upgrade candle")
    })

    test("an npm install gets the npm command without asking the feed", async () => {
      const stderr = createCapture()
      await run(["wallets"], depsWith(walletRoutes({ "x-candle-cli-latest": NEWER }).fetch, { stderr }))
      expect(stderr.text).toContain(`-> ${NEWER}. Run: npm i -g @candledottv/cli@latest`)
      expect(stderr.text).not.toContain("Run: candle update")
    })
  })
})
