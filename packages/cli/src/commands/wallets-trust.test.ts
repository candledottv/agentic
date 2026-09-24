/**
 * `candle wallets trust` and `candle wallets untrust` (BE-329), driven through `run()` against a
 * routed fake API. The device token is the only credential they take; the server resolves the
 * selectors in a preview, and the commit sends exactly the ids the preview showed.
 */
import { describe, expect, test } from "bun:test"
import { run } from "../index"
import {
  type CapturedRequest,
  createCapture,
  createFakeConfigStore,
  createFakeStore,
  createRoutedFetch,
  createTestDeps,
  jsonResponse,
  type RouteHandler,
} from "../test-support"
import { nothingToChangeLine } from "./wallets-trust"

const PATH = "/api/v1/agent/linked-wallets/trust"
const ACCOUNT = "FfU8M5xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx8pPD"

const row = (id: string, label: string, trustedAt: number | null = null) => ({
  id,
  chain: "solana" as const,
  address: `Addr${id}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
  label,
  trustedAt,
})

function previewBody(trusted = true, extra: Record<string, unknown> = {}) {
  return {
    success: true,
    dryRun: true,
    trusted,
    changed: [row("k1", "tr-01", trusted ? null : 5), row("k2", "tr-02", trusted ? null : 5)],
    unchanged: [row("k3", "tr-03", trusted ? 5 : null)],
    skipped: [],
    ...extra,
  }
}

function commitBody(trusted = true, extra: Record<string, unknown> = {}) {
  return {
    success: true,
    trusted,
    changed: [row("k1", "tr-01", trusted ? 9 : null), row("k2", "tr-02", trusted ? 9 : null)],
    unchanged: [],
    skipped: [],
    batchId: "batch-1",
    ...extra,
  }
}

const parse = (req: CapturedRequest) => JSON.parse(String(req.init.body ?? "{}")) as Record<string, unknown>

/** The trust route answering the preview, then the commit, recording both bodies. */
function trustApi(
  opts: { preview?: unknown; commit?: unknown; previewStatus?: number; commitStatus?: number; trusted?: boolean } = {},
) {
  const bodies: Record<string, unknown>[] = []
  const auth: (string | null)[] = []
  const handlers: RouteHandler[] = [
    (req) => {
      bodies.push(parse(req))
      auth.push(new Headers(req.init.headers).get("authorization"))
      return jsonResponse(opts.previewStatus ?? 200, opts.preview ?? previewBody(opts.trusted ?? true))
    },
    (req) => {
      bodies.push(parse(req))
      auth.push(new Headers(req.init.headers).get("authorization"))
      return jsonResponse(opts.commitStatus ?? 200, opts.commit ?? commitBody(opts.trusted ?? true))
    },
  ]
  return { handlers, bodies, auth }
}

function depsFor(
  fetch: typeof globalThis.fetch,
  overrides: { answers?: string[]; tty?: boolean; store?: Record<string, string> } = {},
) {
  const stdout = createCapture()
  const stderr = createCapture()
  const answers = [...(overrides.answers ?? ["confirm"])]
  let prompts = 0
  const configStore = createFakeConfigStore({
    profiles: { production: { account: ACCOUNT, username: "Quant-", apiUrl: "https://api.alpha.candle.tv" } },
    activeProfile: "production",
  })
  const deps = createTestDeps({
    fetch,
    store: createFakeStore(overrides.store ?? { "profile:production:device_token": "cndl_dvc_x" }),
    stdout,
    stderr,
    env: {},
    readConfig: configStore.readConfig,
    writeConfig: configStore.writeConfig,
    clearConfig: configStore.clearConfig,
    updateProfile: configStore.updateProfile,
    isTTY:
      overrides.tty === false
        ? { stdin: false, stdout: false, stderr: false }
        : { stdin: true, stdout: true, stderr: true },
    promptLine: async () => {
      prompts++
      const next = answers.shift()
      if (next === undefined) throw new Error("promptLine asked for more answers than the test scripted")
      return next
    },
    promptSecret: async () => {
      throw new Error("the vault must never be opened by wallets trust")
    },
  })
  return { deps, stdout, stderr, prompts: () => prompts }
}

describe("parsing and the device-token precondition", () => {
  test("no selector is a usage error, exit 2, before any request; trust has no --yes", async () => {
    for (const argv of [
      ["wallets", "trust"],
      ["wallets", "untrust"],
      ["wallets", "trust", "tr-01", "--yes"],
      ["wallets", "trust", "tr-01", "--bogus"],
    ]) {
      const { fetch, calls } = createRoutedFetch({})
      const { deps } = depsFor(fetch)
      expect(await run(argv, deps)).toBe(2)
      expect(calls).toHaveLength(0)
    }
  })

  test("a profile with only an API key is DEVICE_TOKEN_REQUIRED up front, with the login suggestion", async () => {
    for (const verb of ["trust", "untrust"]) {
      const { fetch, calls } = createRoutedFetch({})
      const { deps, stdout } = depsFor(fetch, { store: { "profile:production:api_key": "cndl_live_x" } })
      expect(await run(["wallets", verb, "tr-*", "--json", "--no-verify-account"], deps)).toBe(1)
      expect(calls).toHaveLength(0)
      expect(JSON.parse(stdout.text)).toEqual({
        ok: false,
        code: "DEVICE_TOKEN_REQUIRED",
        message: "Marking a wallet trusted needs the device token, the owner's credential; an API key cannot do it.",
        suggestion: "Run: candle auth login",
      })
    }
  })

  test("no TTY: trust is refused before the preview; untrust points at --yes", async () => {
    const api = trustApi()
    let routed = createRoutedFetch({ [PATH]: api.handlers })
    let d = depsFor(routed.fetch, { tty: false })
    expect(await run(["wallets", "trust", "tr-*", "--json"], d.deps)).toBe(1)
    expect(JSON.parse(d.stdout.text).code).toBe("TRUST_REQUIRES_TTY")
    expect(routed.calls).toHaveLength(0)

    routed = createRoutedFetch({ [PATH]: trustApi({ trusted: false }).handlers })
    d = depsFor(routed.fetch, { tty: false })
    expect(await run(["wallets", "untrust", "tr-*", "--json"], d.deps)).toBe(1)
    expect(JSON.parse(d.stdout.text).suggestion).toContain("--yes")
    expect(routed.calls).toHaveLength(0)
  })
})

describe("preview, confirm, commit", () => {
  test("labels and globs go to the server as selectors over the device token; the commit sends only the previewed ids", async () => {
    const api = trustApi()
    const { fetch } = createRoutedFetch({ [PATH]: api.handlers })
    const { deps, stdout, stderr } = depsFor(fetch)
    expect(await run(["wallets", "trust", "tr-*", "cn-01", "0xAbC"], deps)).toBe(0)
    expect(api.bodies[0]).toEqual({ dryRun: true, wallets: ["tr-*", "cn-01", "0xAbC"], trusted: true })
    expect(api.bodies[1]).toEqual({ walletIds: ["k1", "k2"], trusted: true })
    expect(api.auth.every((h) => h === "Bearer cndl_dvc_x")).toBe(true)
    // The screen lists what will change and what already is.
    expect(stderr.text).toContain("tr-01")
    expect(stderr.text).toContain("tr-02")
    expect(stderr.text).toContain("1 already trusted: tr-03")
    expect(stderr.text).toContain("These 2 wallets will be trusted")
    expect(stdout.text).toEndWith("Trusted 2 wallets.\n")
  })

  test("anything but confirm changes nothing; confirm, Confirm and ' CONFIRM ' proceed", async () => {
    for (const typed of ["yes", "", "confirm please"]) {
      const api = trustApi()
      const { fetch } = createRoutedFetch({ [PATH]: api.handlers })
      const { deps, stdout } = depsFor(fetch, { answers: [typed] })
      expect(await run(["wallets", "trust", "tr-*", "--json"], deps)).toBe(1)
      expect(JSON.parse(stdout.text).code).toBe("TRUST_NOT_ACKNOWLEDGED")
      expect(api.bodies).toHaveLength(1)
      expect(api.bodies[0]?.dryRun).toBe(true)
    }
    for (const typed of ["confirm", "Confirm", " CONFIRM "]) {
      const api = trustApi()
      const { fetch } = createRoutedFetch({ [PATH]: api.handlers })
      const { deps } = depsFor(fetch, { answers: [typed] })
      expect(await run(["wallets", "trust", "tr-*"], deps)).toBe(0)
      expect(api.bodies).toHaveLength(2)
    }
  })

  test("untrust asks for confirm too, and --yes skips it (no terminal needed)", async () => {
    let api = trustApi({ trusted: false })
    let routed = createRoutedFetch({ [PATH]: api.handlers })
    let d = depsFor(routed.fetch)
    expect(await run(["wallets", "untrust", "tr-*"], d.deps)).toBe(0)
    expect(d.prompts()).toBe(1)
    expect(api.bodies[1]).toEqual({ walletIds: ["k1", "k2"], trusted: false })

    api = trustApi({ trusted: false })
    routed = createRoutedFetch({ [PATH]: api.handlers })
    d = depsFor(routed.fetch, { tty: false, answers: [] })
    expect(await run(["wallets", "untrust", "tr-*", "--yes"], d.deps)).toBe(0)
    expect(d.prompts()).toBe(0)
    expect(api.bodies[1]).toEqual({ walletIds: ["k1", "k2"], trusted: false })
    expect(d.stdout.text).toEndWith("Untrusted 2 wallets.\n")
  })

  test("--json prints exactly one document on stdout, the screen stays on stderr", async () => {
    const api = trustApi()
    const { fetch } = createRoutedFetch({ [PATH]: api.handlers })
    const { deps, stdout, stderr } = depsFor(fetch)
    expect(await run(["wallets", "trust", "tr-*", "--json"], deps)).toBe(0)
    const lines = stdout.text.trim().split("\n")
    expect(lines).toHaveLength(1)
    const doc = JSON.parse(lines[0] as string)
    expect(doc).toMatchObject({ command: "wallets trust", trusted: true, batchId: "batch-1", skipped: [] })
    expect(doc.changed.map((r: { id: string }) => r.id)).toEqual(["k1", "k2"])
    expect(stderr.text).toContain("tr-01")
  })

  test("nothing to change: one line (or one document), no prompt, no commit", async () => {
    const preview = previewBody(true, { changed: [], unchanged: [row("k3", "tr-03", 5)] })
    let api = trustApi({ preview })
    let routed = createRoutedFetch({ [PATH]: api.handlers })
    let d = depsFor(routed.fetch, { answers: [] })
    expect(await run(["wallets", "trust", "tr-03"], d.deps)).toBe(0)
    expect(d.stdout.text).toEndWith("Nothing to change: that wallet is already trusted.\n")
    expect(nothingToChangeLine({ unchanged: [row("k3", "tr-03", 5)], sessionLinked: [] }, true)).toBe(
      "Nothing to change: that wallet is already trusted.\n",
    )
    expect(api.bodies).toHaveLength(1)

    api = trustApi({ preview })
    routed = createRoutedFetch({ [PATH]: api.handlers })
    d = depsFor(routed.fetch, { answers: [] })
    expect(await run(["wallets", "trust", "tr-03", "--json"], d.deps)).toBe(0)
    expect(JSON.parse(d.stdout.text)).toMatchObject({ command: "wallets trust", changed: [] })
  })

  test("untrust of a session-linked wallet says it stays yours, and does not commit", async () => {
    const sessionRow = row("kS", "signed-in", null)
    const preview = previewBody(false, { changed: [], unchanged: [], sessionLinked: [sessionRow] })
    const api = trustApi({ trusted: false, preview })
    const routed = createRoutedFetch({ [PATH]: api.handlers })
    const d = depsFor(routed.fetch, { answers: [] })
    expect(await run(["wallets", "untrust", "signed-in"], d.deps)).toBe(0)
    expect(d.stdout.text).toEndWith(
      "Nothing to change: that wallet is always yours while linked. Revoke it to remove it.\n",
    )
    expect(api.bodies).toHaveLength(1)
    expect(d.prompts()).toBe(0)
  })

  test("a session-linked row beside wallets that will change is named on the screen", async () => {
    const preview = previewBody(false, { sessionLinked: [row("kS", "signed-in", 4)] })
    const api = trustApi({ trusted: false, preview })
    const { fetch } = createRoutedFetch({ [PATH]: api.handlers })
    const { deps, stderr } = depsFor(fetch)
    expect(await run(["wallets", "untrust", "tr-*", "--yes"], deps)).toBe(0)
    expect(stderr.text).toContain(
      "1 linked while signed in (signed-in): always yours while linked. Revoke it to remove it.",
    )
    expect(api.bodies[1]).toEqual({ walletIds: ["k1", "k2"], trusted: false })
  })

  test("a wallet revoked between preview and commit is reported, exit 1", async () => {
    const commit = commitBody(true, {
      changed: [row("k1", "tr-01", 9)],
      skipped: [{ walletId: "k2", reason: "revoked" }],
    })
    const api = trustApi({ commit })
    const { fetch } = createRoutedFetch({ [PATH]: api.handlers })
    const { deps, stdout, stderr } = depsFor(fetch)
    expect(await run(["wallets", "trust", "tr-*"], deps)).toBe(1)
    expect(stdout.text).toEndWith("Trusted 1 wallet.\n")
    expect(stderr.text).toContain("Skipped k2: revoked.")
  })
})

describe("server refusals", () => {
  test("a selector that names nothing: the server's code, with a pointer to candle wallets", async () => {
    const api = trustApi({
      previewStatus: 400,
      preview: {
        success: false,
        error: {
          code: "VALIDATION_FAILED",
          message: "nope-* does not name an active linked wallet on this account",
          field: "wallets",
          reason: "not_found",
          retryable: false,
        },
      },
    })
    const { fetch } = createRoutedFetch({ [PATH]: api.handlers })
    const { deps, stdout } = depsFor(fetch, { answers: [] })
    expect(await run(["wallets", "trust", "nope-*", "--json"], deps)).toBe(1)
    const doc = JSON.parse(stdout.text)
    expect(doc.code).toBe("VALIDATION_FAILED")
    expect(doc.message).toContain("nope-*")
    expect(doc.suggestion).toContain("candle wallets")
    expect(api.bodies).toHaveLength(1)
  })

  test("an ambiguous label lists the matching ids", async () => {
    const api = trustApi({
      previewStatus: 400,
      preview: {
        success: false,
        error: {
          code: "VALIDATION_FAILED",
          message: "tr-01 names more than one wallet; use an id, an address, or a prefix*",
          reason: "ambiguous",
          matches: [
            { id: "k1", address: "A", label: "tr-01" },
            { id: "k9", address: "B", label: "tr-01" },
          ],
          retryable: false,
        },
      },
    })
    const { fetch } = createRoutedFetch({ [PATH]: api.handlers })
    const { deps, stderr } = depsFor(fetch, { answers: [] })
    expect(await run(["wallets", "trust", "tr-01"], deps)).toBe(1)
    expect(stderr.text).toContain("k1, k9")
  })

  test("an API without the route (404) is TRUST_UNSUPPORTED, nothing changed", async () => {
    const api = trustApi({
      previewStatus: 404,
      preview: { success: false, error: { code: "NOT_FOUND", message: "x" } },
    })
    const { fetch } = createRoutedFetch({ [PATH]: api.handlers })
    const { deps, stdout } = depsFor(fetch, { answers: [] })
    expect(await run(["wallets", "trust", "tr-*", "--json"], deps)).toBe(1)
    expect(JSON.parse(stdout.text).code).toBe("TRUST_UNSUPPORTED")
  })
})
