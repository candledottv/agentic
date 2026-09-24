/**
 * `keys wallets set`'s refused widening points at `tee rebind` (2026-09-24). An agent asked to make
 * a key use a set of TEE wallets reached for `keys wallets set`, got LOOSEN_REQUIRES_SESSION, and
 * had nothing in the output to lead it to the owner's move. The API's message is still relayed
 * as-is; the suggestion names the rebind for exactly the wallets and key the call named.
 */

import { describe, expect, test } from "bun:test"
import { run } from "../index"
import { createCapture, createRoutedFetch, createTestDeps, jsonResponse } from "../test-support"
import { widenRefusedHint } from "./keys-wallets"

const LOOSEN = () =>
  jsonResponse(403, {
    error: {
      code: "LOOSEN_REQUIRES_SESSION",
      message: "Widening a profile's wallet set requires a signed-in session.",
      uiHint: "Sign in to the agent console to grant wallets.",
    },
  })

describe("keys wallets set: a refused widening", () => {
  test("keeps the API's message and suggests the tee rebind for the named wallets and key", async () => {
    const { fetch } = createRoutedFetch({ "/api/v1/agent/keys/B6P-TSRs/wallets": LOOSEN })
    const stderr = createCapture()
    const code = await run(
      ["keys", "wallets", "set", "B6P-TSRs", "--wallets", "wal_1,wal_2"],
      createTestDeps({ fetch, stderr, env: { CANDLE_API_KEY: "ck_live_test" } }),
    )
    expect(code).toBe(1)
    expect(stderr.text).toContain("Widening a profile's wallet set requires a signed-in session.")
    expect(stderr.text).toContain("candle tee rebind wal_1 wal_2 --to-key B6P-TSRs")
    expect(stderr.text).toContain("--label-prefix")
  })

  test("--json carries the rebind suggestion in the envelope", async () => {
    const { fetch } = createRoutedFetch({ "/api/v1/agent/keys/B6P-TSRs/wallets": LOOSEN })
    const stdout = createCapture()
    const code = await run(
      ["keys", "wallets", "set", "B6P-TSRs", "--wallets", "wal_1", "--json"],
      createTestDeps({ fetch, stdout, env: { CANDLE_API_KEY: "ck_live_test" } }),
    )
    expect(code).toBe(1)
    const envelope = JSON.parse(stdout.text.trim().split("\n").at(-1) as string)
    expect(envelope.code).toBe("LOOSEN_REQUIRES_SESSION")
    expect(envelope.suggestion).toContain("candle tee rebind wal_1 --to-key B6P-TSRs")
  })

  test("any other refusal keeps the API's own suggestion", async () => {
    const { fetch } = createRoutedFetch({
      "/api/v1/agent/keys/B6P-TSRs/wallets": () =>
        jsonResponse(404, { error: { code: "KEY_NOT_FOUND", message: "No such key.", uiHint: "Check the prefix." } }),
    })
    const stdout = createCapture()
    await run(
      ["keys", "wallets", "set", "B6P-TSRs", "--wallets", "wal_1", "--json"],
      createTestDeps({ fetch, stdout, env: { CANDLE_API_KEY: "ck_live_test" } }),
    )
    const envelope = JSON.parse(stdout.text.trim().split("\n").at(-1) as string)
    expect(envelope.suggestion).toBe("Check the prefix.")
  })

  test("with no wallets named, the hint shows the placeholder rather than an empty list", () => {
    expect(widenRefusedHint("abc", [])).toContain("candle tee rebind <wallet...> --to-key abc")
  })
})
