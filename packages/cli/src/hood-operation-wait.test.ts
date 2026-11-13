import { expect, test } from "bun:test"
import type { CommandContext } from "./deps"
import { waitForHoodOperation } from "./hood-operation-wait"
import { createCapture, createTestDeps } from "./test-support"

test("a stalled HTTP read is aborted at the wait deadline with an unresolved outcome", async () => {
  let clockReads = 0
  let requests = 0
  const stdout = createCapture()
  const ctx: CommandContext = {
    apiUrl: "https://api.fixture.test",
    json: true,
    verifyAccount: false,
    deps: createTestDeps({
      stdout,
      // The deadline starts at zero; the first read has only 10ms left.
      now: () => (clockReads++ === 0 ? 0 : 599_990),
      fetch: (async (_input, init) => {
        requests++
        expect(init?.method).toBe("GET")
        const signal = init?.signal
        expect(signal).toBeInstanceOf(AbortSignal)
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
      }) as typeof fetch,
    }),
  }
  await expect(waitForHoodOperation(ctx, "fixture-key", "op-1")).rejects.toMatchObject({
    code: "HOOD_WAIT_UNAVAILABLE",
    exitCode: 3,
    details: { operationId: "op-1" },
  })
  expect(requests).toBe(1)
  expect(stdout.text).toBe("")
})
