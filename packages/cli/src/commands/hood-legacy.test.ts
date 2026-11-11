import { expect, test } from "bun:test"
import type { CommandContext } from "../deps"
import { createCapture, createTestDeps } from "../test-support"
import { assertWalletLockFree, busyStatusHint, readHoodTeeServer } from "../vault/evm-tee"
import {
  assertWalletLockFree as publishedAssert,
  readHoodTeeServer as publishedRead,
} from "../vault/evm-tee.published.fixture"
import type { KeyEntry } from "../vault/format"
import { swapRecover, swapStatus } from "./swap"

const ID = "11111111-1111-4111-8111-111111111111"
const ADDRESS = `0x${"11".repeat(20)}`
const entry = { address: ADDRESS, linkedWalletId: "legacy-wallet", label: "fixture" } as KeyEntry
function fixture(body: unknown) {
  const stdout = createCapture(),
    stderr = createCapture(),
    calls: Array<{ url: string; init?: RequestInit }> = []
  const deps = createTestDeps({
    stdout,
    stderr,
    env: { CANDLE_API_KEY: "fixture-key" },
    fetch: (async (input, init) => {
      const url = String(input)
      if (!url.startsWith("https://api.fixture.test")) throw new Error("Unexpected outbound call")
      calls.push({ url, init })
      return Response.json(body)
    }) as typeof fetch,
  })
  const ctx: CommandContext = { deps, json: true, apiUrl: "https://api.fixture.test", verifyAccount: false }
  return { ctx, calls, stdout, stderr }
}
for (const status of ["failed", "expired"] as const)
  test(`T14: published parser refuses guarded ${status}, past expiry; new custody refuses WALLET_GUARDED`, async () => {
    const response = {
      address: ADDRESS,
      guard: {
        held: true,
        incomplete: false,
        operations: [{ operationId: ID, reason: "legacy_identity_missing", operationStatus: status }],
      },
      activeOperation: { operationId: ID, kind: "trade", expiresAt: 1 },
    }
    const { ctx } = fixture(response)
    const installed = await publishedRead(ctx, entry)
    expect(installed.lock.state).toBe("held")
    expect(() => publishedAssert(entry, installed.lock, Date.now())).toThrow(
      expect.objectContaining({ code: "WALLET_BUSY" }),
    )
    const updated = await readHoodTeeServer(ctx, entry)
    expect(() => assertWalletLockFree(entry, updated.lock, Date.now())).toThrow(
      expect.objectContaining({ code: "WALLET_GUARDED" }),
    )
  })

test("T14: incomplete without holder is unknown for installed parser, held+incomplete remains held, complete free stays free", async () => {
  for (const [body, state] of [
    [{ guard: { held: false, incomplete: true, operations: [] } }, "unknown"],
    [
      {
        guard: { held: true, incomplete: true, operations: [] },
        activeOperation: { operationId: ID, kind: "swap", expiresAt: 1 },
      },
      "held",
    ],
    [{ guard: { held: false, incomplete: false, operations: [] }, activeOperation: null }, "free"],
  ] as const) {
    const { ctx } = fixture({ address: ADDRESS, ...body })
    const installed = await publishedRead(ctx, entry)
    expect(installed.lock.state).toBe(state)
    if (state === "unknown")
      expect(() => publishedAssert(entry, installed.lock, Date.now())).toThrow(
        expect.objectContaining({ code: "WALLET_LOCK_UNKNOWN" }),
      )
    if (state === "free") expect(() => publishedAssert(entry, installed.lock, Date.now())).not.toThrow()
  }
})

test("T14: every busy hint uses explicit operation lookup, including transfer", () => {
  for (const kind of ["trade", "swap", "launch", "transfer"])
    expect(busyStatusHint(kind, ID)).toBe(`candle swap status --operation ${ID}`)
})

test("T14/T18: explicit status and recover preserve guard, exit 3, and make only one API read/write each", async () => {
  const body = {
    success: true,
    operation: {
      operationId: ID,
      guard: { reason: "pending", recoveryRequired: true, clearingCondition: "Read receipt" },
    },
  }
  const f = fixture(body)
  expect(await swapStatus(["--operation", ID], f.ctx)).toBe(3)
  expect(await swapRecover(["--operation", ID, "--hash", `0x${"22".repeat(32)}`], f.ctx)).toBe(3)
  expect(f.calls.map((c) => new URL(c.url).pathname)).toEqual([
    `/api/v1/agent/hood-tee/operations/${ID}`,
    `/api/v1/agent/hood-tee/operations/${ID}/recover`,
  ])
  expect(f.calls.map((c) => c.init?.method)).toEqual(["GET", "POST"])
  expect(JSON.parse(String(f.calls[1]?.init?.body))).toEqual({ candidateHash: `0x${"22".repeat(32)}` })
  expect(f.stdout.text).toContain('"guard"')
})
