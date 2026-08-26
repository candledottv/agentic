/**
 * `wallets`, driven through `run()`: fetches embedded (launch) wallets and linked wallets with
 * the agent key. Not in task-3-brief.md's required coverage list, but covered here for the same
 * reason every other command is: it is a real, user-facing command surface.
 */

import { describe, expect, test } from "bun:test"
import { run } from "../index"
import type { SecretStore } from "../secret-store"
import {
  createCapture,
  createFakeConfigStore,
  createFakeStore,
  createRoutedFetch,
  createTestDeps,
  jsonResponse,
} from "../test-support"

describe("wallets", () => {
  test("prints embedded and linked wallets using the agent key", async () => {
    const { fetch, calls } = createRoutedFetch({
      "/api/v1/agent/wallets/embedded": () =>
        jsonResponse(200, {
          success: true,
          wallets: { solana: { address: "So1anaAddr", delegated: true }, evm: null },
        }),
      "/api/v1/agent/wallets": () =>
        jsonResponse(200, {
          success: true,
          page: [{ _id: "lw_listed01", address: "0xLinked", chain: "evm", label: "my wallet" }],
          isDone: true,
          continueCursor: null,
        }),
    })
    const store = createFakeStore({ api_key: "ck_live_x" })
    const stdout = createCapture()
    const code = await run(["wallets"], createTestDeps({ fetch, store, stdout }))

    expect(code).toBe(0)
    for (const call of calls) {
      const headers = call.init.headers as Record<string, string>
      expect(headers["x-api-key"]).toBe("ck_live_x")
    }
    expect(stdout.text).toContain("So1anaAddr")
    expect(stdout.text).toContain("0xLinked")
    // The row id renders: it is the handle wallets revoke and the trade API's linkedWalletId take.
    expect(stdout.text).toContain("lw_listed01")
  })

  test("requires an API key; without one it fails without making a request", async () => {
    const { fetch, calls } = createRoutedFetch({})
    const stderr = createCapture()
    const code = await run(["wallets"], createTestDeps({ fetch, stderr }))
    expect(code).toBe(1)
    expect(calls).toHaveLength(0)
    expect(stderr.text.toLowerCase()).toContain("keys create")
  })

  test("the missing-API-key exit honors --json: STDOUT parses (the machine contract), and carries the code", async () => {
    const { fetch, calls } = createRoutedFetch({})
    const stdout = createCapture()
    const stderr = createCapture()
    const code = await run(["wallets", "--json"], createTestDeps({ fetch, stdout, stderr }))
    expect(code).toBe(1)
    expect(calls).toHaveLength(0)
    expect(stderr.text).toBe("")
    expect(JSON.parse(stdout.text)).toEqual({
      ok: false,
      code: "NO_API_KEY",
      message: "No API key available.",
      suggestion: "Run: candle keys create",
    })
  })

  // GET /wallets sits behind requireAgentKey("launch:write"), so an activity-only key gets a 403
  // here. Without the SCOPE_MISSING mapping that printed a statement of fact with no next step.
  test("a 403 SCOPE_MISSING on the linked-wallets call keeps the scope name and adds the fix commands", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/embedded": () =>
        jsonResponse(200, { success: true, wallets: { solana: { address: "So1", delegated: true }, evm: null } }),
      "/api/v1/agent/wallets": () =>
        jsonResponse(403, {
          success: false,
          error: { code: "SCOPE_MISSING", message: "This key lacks the launch:write scope" },
        }),
    })
    const store = createFakeStore({ api_key: "ck_live_x" })
    const stderr = createCapture()

    const code = await run(["wallets"], createTestDeps({ fetch, store, stderr }))

    expect(code).toBe(1)
    expect(stderr.text).toContain("launch:write")
    expect(stderr.text).toContain("candle keys create --scopes")
    expect(stderr.text).toContain("candle keys list")
  })
})

/**
 * The `Signer` column (CLI profiles Phase 3). A linked wallet has two halves in two places: the
 * row lives on the Candle account, the signer private key lives in THIS machine's store under
 * `wallet_signer_<id>`. Before this column the three states looked identical on screen, so a
 * wallet whose signer was imported on another machine read exactly like one that can trade from
 * here, and the difference only showed up as a signing failure.
 */
describe("wallets signer column", () => {
  const noEmbeddedWallets = () => jsonResponse(200, { success: true, wallets: { solana: null, evm: null } })

  /** `GET /wallets`' own envelope around `rows`, so the fixtures stay row-shaped. */
  function linkedPage(rows: Array<Record<string, unknown>>) {
    return () => jsonResponse(200, { success: true, page: rows, isDone: true, continueCursor: null })
  }

  /** The rendered linked-wallets line for `id`, split into cells. `renderTable` pads every column
   * except the last and joins with two spaces, so the Signer value is always the final cell. */
  function cellsFor(text: string, id: string): string[] {
    const line = text.split("\n").find((candidate) => candidate.startsWith(`${id} `))
    if (line === undefined) throw new Error(`no rendered row for ${id} in:\n${text}`)
    return line.split(/\s{2,}/)
  }

  function signerCell(text: string, id: string): string | undefined {
    return cellsFor(text, id).at(-1)
  }

  /** A store that answers for the API key but refuses every signer probe, the shape of a locked
   * keychain or a missing `secret-tool`. */
  function storeThatCannotReadSigners(seed: Record<string, string>, message: string): SecretStore {
    const base = createFakeStore(seed)
    return {
      get: async (ref: string) => {
        if (ref.startsWith("wallet_signer_")) throw new Error(message)
        return base.get(ref)
      },
      set: (ref: string, value: string) => base.set(ref, value),
      delete: (ref: string) => base.delete(ref),
    }
  }

  const NONE_HINT_FIRST_LINE =
    "A wallet marked none has no signer on this machine, so a trade from here cannot sign with it."
  const NONE_HINT_SECOND_LINE =
    "Import it here (candle wallets import), or run the trade from the machine that imported it."
  const STALE_HINT =
    "A wallet marked stale is revoked but its signer is still stored here. Run: candle wallets revoke <id>"

  test("marks the row whose signer this machine holds stored, the other none, and prints the none hint", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/embedded": noEmbeddedWallets,
      "/api/v1/agent/wallets": linkedPage([
        { _id: "lw_here", address: "So1Here", chain: "solana", label: "here" },
        { _id: "lw_elsewhere", address: "So1Elsewhere", chain: "solana", label: "elsewhere" },
      ]),
    })
    const store = createFakeStore({ api_key: "ck_live_x", wallet_signer_lw_here: "c2lnbmVyLWJvZHk=" })
    const stdout = createCapture()
    const stderr = createCapture()

    const code = await run(["wallets"], createTestDeps({ fetch, store, stdout, stderr }))

    expect(code).toBe(0)
    // Reverting the column drops both of these cells and leaves the two rows indistinguishable.
    expect(signerCell(stdout.text, "lw_here")).toBe("stored")
    expect(signerCell(stdout.text, "lw_elsewhere")).toBe("none")
    expect(stdout.text).toContain(NONE_HINT_FIRST_LINE)
    expect(stdout.text).toContain(NONE_HINT_SECOND_LINE)
    // The hint is about the signer, not an error: nothing failed here.
    expect(stderr.text).toBe("")
  })

  test("a revoked row whose signer is still stored reads stale, and the hint names candle wallets revoke", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/embedded": noEmbeddedWallets,
      "/api/v1/agent/wallets": linkedPage([
        { _id: "lw_stale", address: "So1Stale", chain: "solana", revokedAt: 1_724_500_000_000 },
      ]),
    })
    const store = createFakeStore({ api_key: "ck_live_x", wallet_signer_lw_stale: "c2lnbmVyLWJvZHk=" })
    const stdout = createCapture()

    const code = await run(["wallets"], createTestDeps({ fetch, store, stdout }))

    expect(code).toBe(0)
    // On revert this reads "no" in the Revoked column and says nothing about the leftover secret.
    expect(signerCell(stdout.text, "lw_stale")).toBe("stale")
    expect(stdout.text).toContain(STALE_HINT)
    // Only the state a row is actually in gets a hint.
    expect(stdout.text).not.toContain(NONE_HINT_FIRST_LINE)
  })

  test("a revoked row with no signer here reads - and prints no hint at all", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/embedded": noEmbeddedWallets,
      "/api/v1/agent/wallets": linkedPage([
        { _id: "lw_gone", address: "So1Gone", chain: "solana", revokedAt: 1_724_500_000_000 },
      ]),
    })
    const store = createFakeStore({ api_key: "ck_live_x" })
    const stdout = createCapture()

    const code = await run(["wallets"], createTestDeps({ fetch, store, stdout }))

    expect(code).toBe(0)
    // There is nothing to say about a revoked wallet with no local secret, so it says nothing.
    expect(signerCell(stdout.text, "lw_gone")).toBe("-")
    expect(stdout.text).not.toContain(NONE_HINT_FIRST_LINE)
    expect(stdout.text).not.toContain(STALE_HINT)
  })

  test("--json carries a signers map for every row and leaves both API bodies verbatim", async () => {
    const embeddedBody = {
      success: true,
      wallets: { solana: { address: "So1anaAddr", delegated: true }, evm: null },
    }
    const linkedBody = {
      success: true,
      page: [
        { _id: "lw_here", address: "So1Here", chain: "solana", label: "here" },
        { _id: "lw_elsewhere", address: "So1Elsewhere", chain: "solana" },
        { _id: "lw_stale", address: "So1Stale", chain: "solana", revokedAt: 1_724_500_000_000 },
        { _id: "lw_gone", address: "So1Gone", chain: "solana", revokedAt: 1_724_500_000_000 },
      ],
      isDone: true,
      continueCursor: null,
    }
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/embedded": () => jsonResponse(200, embeddedBody),
      "/api/v1/agent/wallets": () => jsonResponse(200, linkedBody),
    })
    const store = createFakeStore({
      api_key: "ck_live_x",
      wallet_signer_lw_here: "c2lnbmVyLWJvZHk=",
      wallet_signer_lw_stale: "c2lnbmVyLWJvZHk=",
    })
    const stdout = createCapture()
    const stderr = createCapture()

    const code = await run(["wallets", "--json"], createTestDeps({ fetch, store, stdout, stderr }))

    expect(code).toBe(0)
    // The machine contract: stdout is exactly one JSON document, hints and all excluded.
    expect(stdout.text.trimEnd().split("\n")).toHaveLength(1)
    const parsed = JSON.parse(stdout.text) as {
      embedded: unknown
      linked: unknown
      signers: Record<string, string>
    }
    // The API bodies are what the API sent, byte for byte: the CLI's own answer is a sibling.
    expect(parsed.embedded).toEqual(embeddedBody)
    expect(parsed.linked).toEqual(linkedBody)
    // Every row has an entry; the human table's "-" is "none" here, since the row carries revokedAt.
    expect(parsed.signers).toEqual({
      lw_here: "stored",
      lw_elsewhere: "none",
      lw_stale: "stale",
      lw_gone: "none",
    })
    expect(stdout.text).not.toContain(NONE_HINT_FIRST_LINE)
    expect(stdout.text).not.toContain(STALE_HINT)
    expect(stderr.text).toBe("")
  })

  test("a store that cannot be read marks every row none, warns ONCE on stderr, and still exits 0", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/embedded": noEmbeddedWallets,
      "/api/v1/agent/wallets": linkedPage([
        { _id: "lw_one", address: "So1One", chain: "solana" },
        { _id: "lw_two", address: "So1Two", chain: "solana" },
      ]),
    })
    const store = storeThatCannotReadSigners({ api_key: "ck_live_x" }, "keychain is locked")
    const stdout = createCapture()
    const stderr = createCapture()

    const code = await run(["wallets"], createTestDeps({ fetch, store, stdout, stderr }))

    // An unreadable keychain is not a failed listing: the rows are still worth printing.
    expect(code).toBe(0)
    expect(signerCell(stdout.text, "lw_one")).toBe("none")
    expect(signerCell(stdout.text, "lw_two")).toBe("none")
    // One warning for the whole listing, not one per row.
    expect(stderr.text.split("Could not read the signer store:")).toHaveLength(2)
    expect(stderr.text).toContain("keychain is locked")
  })

  test("the same unreadable store under --json keeps stdout parseable and puts the warning on stderr", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/embedded": noEmbeddedWallets,
      "/api/v1/agent/wallets": linkedPage([{ _id: "lw_one", address: "So1One", chain: "solana" }]),
    })
    const store = storeThatCannotReadSigners({ api_key: "ck_live_x" }, "keychain is locked")
    const stdout = createCapture()
    const stderr = createCapture()

    const code = await run(["wallets", "--json"], createTestDeps({ fetch, store, stdout, stderr }))

    expect(code).toBe(0)
    expect(stdout.text.trimEnd().split("\n")).toHaveLength(1)
    expect((JSON.parse(stdout.text) as { signers: Record<string, string> }).signers).toEqual({ lw_one: "none" })
    expect(stderr.text).toContain("Could not read the signer store: keychain is locked")
  })

  test("the column is additive: the existing columns keep their values and Signer is appended last", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/embedded": noEmbeddedWallets,
      "/api/v1/agent/wallets": linkedPage([
        { _id: "lw_listed01", address: "0xLinked", chain: "evm", label: "my wallet" },
      ]),
    })
    const store = createFakeStore({ api_key: "ck_live_x" })
    const stdout = createCapture()

    const code = await run(["wallets"], createTestDeps({ fetch, store, stdout }))

    expect(code).toBe(0)
    const header = stdout.text.split("\n").find((line) => line.startsWith("Id "))
    expect(header?.split(/\s{2,}/)).toEqual(["Id", "Wallet", "Address", "Label", "Revoked", "Signer"])
    expect(cellsFor(stdout.text, "lw_listed01")).toEqual(["lw_listed01", "evm", "0xLinked", "my wallet", "no", "none"])
  })

  test("a row without an _id is printed as - and never probed for, in either mode", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/embedded": noEmbeddedWallets,
      // The second row is the shape the type says cannot happen. If it ever does, the probe must
      // not run under the ref `wallet_signer_undefined`, which on a real keychain would be a
      // read for a credential nobody ever stored.
      "/api/v1/agent/wallets": linkedPage([
        { _id: "lw_here", address: "So1Here", chain: "solana", label: "here" },
        { address: "So1NoId", chain: "solana", label: "orphan" },
      ]),
    })
    const probed: string[] = []
    const backing = createFakeStore({ api_key: "ck_live_x", wallet_signer_lw_here: "c2lnbmVyLWJvZHk=" })
    const store: SecretStore = {
      get: async (ref: string) => {
        probed.push(ref)
        return backing.get(ref)
      },
      set: (ref: string, value: string) => backing.set(ref, value),
      delete: (ref: string) => backing.delete(ref),
    }
    const stdout = createCapture()

    const code = await run(["wallets"], createTestDeps({ fetch, store, stdout }))

    expect(code).toBe(0)
    expect(signerCell(stdout.text, "lw_here")).toBe("stored")
    // The id cell is empty, so this row is found by its address rather than by `startsWith`.
    const orphan = stdout.text.split("\n").find((line) => line.includes("So1NoId"))
    expect(orphan?.split(/\s{2,}/).at(-1)).toBe("-")
    // Exactly one signer ref was asked for: the row with an id.
    expect(probed.filter((ref) => ref.startsWith("wallet_signer_"))).toEqual(["wallet_signer_lw_here"])

    const jsonStdout = createCapture()
    const jsonCode = await run(["wallets", "--json"], createTestDeps({ fetch, store, stdout: jsonStdout }))

    expect(jsonCode).toBe(0)
    // Omitted from the map entirely, rather than keyed under "undefined".
    expect((JSON.parse(jsonStdout.text) as { signers: Record<string, string> }).signers).toEqual({
      lw_here: "stored",
    })
  })
})

/**
 * `wallets revoke` is unchanged by Phase 3, but the `stale` hint sends operators straight at it,
 * so what it does with the local signer is pinned here. `linkedWallets.revoke` is idempotent for
 * this account's own rows (an already-revoked row comes back unchanged, 2xx), and answers 404
 * only for a wallet that does not exist or belongs to someone else.
 */
describe("wallets revoke and the stored signer", () => {
  test("a 2xx revoke deletes the local signer, which is what makes the stale hint true", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_stale": () => jsonResponse(200, { success: true }),
    })
    const store = createFakeStore({ api_key: "ck_live_x", wallet_signer_lw_stale: "c2lnbmVyLWJvZHk=" })
    const stdout = createCapture()

    const code = await run(["wallets", "revoke", "lw_stale"], createTestDeps({ fetch, store, stdout }))

    expect(code).toBe(0)
    // The dead end the hint would otherwise point into: a stale row nothing can clear.
    expect(await store.get("wallet_signer_lw_stale")).toBeNull()
  })

  test("a 404 revoke leaves the signer alone and exits 1: that wallet may be another profile's", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/lw_other": () =>
        jsonResponse(404, { success: false, error: { code: "NOT_FOUND", message: "Wallet not found" } }),
    })
    const store = createFakeStore({ api_key: "ck_live_x", wallet_signer_lw_other: "c2lnbmVyLWJvZHk=" })
    const stderr = createCapture()

    const code = await run(["wallets", "revoke", "lw_other"], createTestDeps({ fetch, store, stderr }))

    expect(code).toBe(1)
    expect(await store.get("wallet_signer_lw_other")).toBe("c2lnbmVyLWJvZHk=")
  })
})

describe("profiles", () => {
  test("prints the identity line first, using the profile's cached account", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/wallets/embedded": () =>
        jsonResponse(200, { success: true, wallets: { solana: null, evm: null } }),
      "/api/v1/agent/wallets": () => jsonResponse(200, { success: true, page: [], isDone: true, continueCursor: null }),
    })
    const store = createFakeStore({ "profile:staging:api_key": "ck_live_x" })
    const config = createFakeConfigStore({ profiles: { staging: { account: "A" } }, activeProfile: "staging" })
    const stdout = createCapture()
    const code = await run(["wallets"], createTestDeps({ fetch, store, stdout, ...config }))
    expect(code).toBe(0)
    expect(stdout.text.startsWith("Profile: staging   Account: A at ")).toBe(true)
  })
})
