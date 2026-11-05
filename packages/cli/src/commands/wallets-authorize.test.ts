/**
 * `candle wallets authorize` (BE-2698, R63), driven through `run()` against a routed fake API. The
 * grant itself happens in the member's browser; these pin what the terminal does around it: which
 * page it opens, when it opens none, how it confirms with an API key, and what it says without one.
 */
import { describe, expect, test } from "bun:test"
import { run } from "../index"
import {
  createCapture,
  createFakeConfigStore,
  createFakeStore,
  createRoutedFetch,
  createTestDeps,
  jsonResponse,
  type RouteHandler,
} from "../test-support"
import { AUTHORIZE_POLL_MS, allDelegated, authorizeUrl } from "./wallets-authorize"

const EMBEDDED = "/api/v1/agent/wallets/embedded"
const ACCOUNT = "FfU8M5xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx8pPD"
const PAGE = "https://staging.candle.tv/agents?authorize=1"

const wallets = (solana: boolean | null, evm: boolean | null = null) => ({
  success: true,
  wallets: {
    solana: solana === null ? null : { address: "SoLEmbedded111", delegated: solana },
    evm: evm === null ? null : { address: "0xEmbedded", delegated: evm },
  },
})

function depsFor(fetch: typeof globalThis.fetch, store: Record<string, string> = {}) {
  const stdout = createCapture()
  const stderr = createCapture()
  const opened: string[] = []
  const configStore = createFakeConfigStore({
    profiles: {
      staging: {
        account: ACCOUNT,
        apiUrl: "https://staging.api.candle.tv",
        portalOrigin: "https://staging.candle.tv",
      },
    },
    activeProfile: "staging",
  })
  const deps = createTestDeps({
    fetch,
    store: createFakeStore(store),
    stdout,
    stderr,
    readConfig: configStore.readConfig,
    writeConfig: configStore.writeConfig,
    clearConfig: configStore.clearConfig,
    updateProfile: configStore.updateProfile,
    openBrowser: (url: string) => {
      opened.push(url)
    },
  })
  return { deps, stdout, stderr, opened }
}

const WITH_KEY = { "profile:staging:api_key": "cndl_test_x" }
const answer =
  (body: unknown, status = 200): RouteHandler =>
  () =>
    jsonResponse(status, body)

describe("helpers", () => {
  test("the page is the console's grant step on the stored portal, else derived from the API host", () => {
    expect(authorizeUrl("https://staging.api.candle.tv", "https://staging.candle.tv")).toBe(PAGE)
    expect(authorizeUrl("https://api.alpha.candle.tv")).toBe("https://alpha.candle.tv/agents?authorize=1")
  })

  test("authorized means every embedded wallet the account has, and never an account with none", () => {
    expect(allDelegated(wallets(true, true))).toBe(true)
    expect(allDelegated(wallets(true))).toBe(true)
    expect(allDelegated(wallets(true, false))).toBe(false)
    expect(allDelegated(wallets(false))).toBe(false)
    expect(allDelegated(wallets(null))).toBe(false)
  })
})

describe("candle wallets authorize", () => {
  test("with a key: opens the page, waits, and reports the grant once every wallet is delegated", async () => {
    const { fetch, calls, unmatched } = createRoutedFetch({
      [EMBEDDED]: [answer(wallets(false, false)), answer(wallets(true, false)), answer(wallets(true, true))],
    })
    const { deps, stdout, opened } = depsFor(fetch, WITH_KEY)
    const started = deps.now()

    expect(await run(["wallets", "authorize", "--no-verify-account"], deps)).toBe(0)

    expect(opened).toEqual([PAGE])
    expect(calls).toHaveLength(3)
    expect(unmatched).toHaveLength(0)
    expect(new Headers(calls[0]?.init.headers).get("x-api-key")).toBe("cndl_test_x")
    // Two waits between the three reads, on the poll interval.
    expect(deps.now() - started).toBe(2 * AUTHORIZE_POLL_MS)
    expect(stdout.text).toContain(PAGE)
    expect(stdout.text).toContain("No API key is created")
    expect(stdout.text).toContain("Agent access is on.")
    expect(stdout.text).toContain("SoLEmbedded111")
    expect(stdout.text).toContain("0xEmbedded")
  })

  test("--json: the URL goes to stderr and stdout is one document", async () => {
    const { fetch } = createRoutedFetch({ [EMBEDDED]: [answer(wallets(false)), answer(wallets(true))] })
    const { deps, stdout, stderr } = depsFor(fetch, WITH_KEY)

    expect(await run(["wallets", "authorize", "--json", "--no-verify-account"], deps)).toBe(0)

    expect(stderr.text).toContain(PAGE)
    expect(JSON.parse(stdout.text)).toEqual({
      success: true,
      status: "authorized",
      url: PAGE,
      wallets: wallets(true).wallets,
    })
  })

  test("an account already delegated is told so, and no page opens", async () => {
    const { fetch, calls } = createRoutedFetch({ [EMBEDDED]: answer(wallets(true, true)) })
    const { deps, stdout, opened } = depsFor(fetch, WITH_KEY)

    expect(await run(["wallets", "authorize", "--json", "--no-verify-account"], deps)).toBe(0)

    expect(opened).toHaveLength(0)
    expect(calls).toHaveLength(1)
    expect(JSON.parse(stdout.text)).toMatchObject({ success: true, status: "already_authorized" })
  })

  test("without a key (a new account): opens the page, sends no request, and names candle auth login", async () => {
    const { fetch, calls } = createRoutedFetch({})
    const { deps, stdout, opened } = depsFor(fetch)

    expect(await run(["wallets", "authorize", "--no-verify-account"], deps)).toBe(0)

    expect(calls).toHaveLength(0)
    expect(opened).toEqual([PAGE])
    expect(stdout.text).toContain("run: candle auth login")
  })

  test("--no-browser prints the page and opens nothing; --no-wait stops after the first read", async () => {
    const { fetch, calls } = createRoutedFetch({ [EMBEDDED]: answer(wallets(false)) })
    const { deps, stdout, opened } = depsFor(fetch, WITH_KEY)

    expect(
      await run(["wallets", "authorize", "--no-browser", "--no-wait", "--json", "--no-verify-account"], deps),
    ).toBe(0)

    expect(opened).toHaveLength(0)
    expect(calls).toHaveLength(1)
    expect(JSON.parse(stdout.text)).toEqual({ success: true, status: "opened", url: PAGE, confirmed: false })
  })

  test("a grant that never lands times out with exit 1 and says where to finish", async () => {
    const { fetch } = createRoutedFetch({ [EMBEDDED]: answer(wallets(false)) })
    const { deps, stdout } = depsFor(fetch, WITH_KEY)

    expect(await run(["wallets", "authorize", "--timeout", "9", "--json", "--no-verify-account"], deps)).toBe(1)

    const body = JSON.parse(stdout.text) as { code: string; message: string; suggestion: string }
    expect(body.code).toBe("AUTHORIZE_TIMEOUT")
    expect(body.message).toContain("9 seconds")
    expect(body.suggestion).toContain(PAGE)
  })

  test("a failed read is the API's error, exit 1, with no page opened", async () => {
    const { fetch } = createRoutedFetch({
      [EMBEDDED]: answer({ success: false, error: { code: "UNAUTHORIZED", message: "Invalid API key" } }, 401),
    })
    const { deps, stdout, opened } = depsFor(fetch, WITH_KEY)

    expect(await run(["wallets", "authorize", "--json", "--no-verify-account"], deps)).toBe(1)

    expect(opened).toHaveLength(0)
    expect(stdout.text).toContain("UNAUTHORIZED")
  })

  test("usage errors exit 2 before any request", async () => {
    for (const argv of [
      ["wallets", "authorize", "extra"],
      ["wallets", "authorize", "--timeout", "0"],
      ["wallets", "authorize", "--timeout", "soon"],
      ["wallets", "authorize", "--bogus"],
    ]) {
      const { fetch, calls } = createRoutedFetch({})
      const { deps, opened } = depsFor(fetch, WITH_KEY)
      expect(await run([...argv, "--no-verify-account"], deps)).toBe(2)
      expect(calls).toHaveLength(0)
      expect(opened).toHaveLength(0)
    }
  })

  test("the singular alias routes too", async () => {
    const { fetch } = createRoutedFetch({ [EMBEDDED]: answer(wallets(true)) })
    const { deps } = depsFor(fetch, WITH_KEY)
    expect(await run(["wallet", "authorize", "--no-verify-account"], deps)).toBe(0)
  })
})
