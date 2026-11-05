import { describe, expect, test } from "bun:test"
import { run } from "../index"
import { type CapturedRequest, createCapture, createRoutedFetch, createTestDeps, jsonResponse } from "../test-support"
import { encodeHeader } from "../x402/codec"

const BASE = "/api/v1/agent/quant"
const TURNS = `${BASE}/turns`
const EVENTS = `${BASE}/turns/t_1/events`
const CANCEL = `${BASE}/turns/t_1/cancel`

type Handler = (req: CapturedRequest) => Response | Promise<Response>

function setup(
  routes: Record<string, Handler | Handler[]>,
  env: Record<string, string> = { CANDLE_API_KEY: "cndl_live_k" },
) {
  const stdout = createCapture()
  const stderr = createCapture()
  const routed = createRoutedFetch(routes)
  let terminate: (() => void) | undefined
  const deps = createTestDeps({
    fetch: routed.fetch,
    stdout,
    stderr,
    env: { CANDLE_API_URL: "https://api.test", ...env },
    onTerminate: (handler) => {
      terminate = handler
      return () => {
        terminate = undefined
      }
    },
  })
  return { deps, stdout, stderr, routed, interrupt: () => terminate?.() }
}

const accepted = () => jsonResponse(202, { turnId: "t_1", cursor: 0 })
const page = (events: { seq: number; kind: string; data: Record<string, unknown> }[], status: string) =>
  jsonResponse(200, { events, next: events.at(-1)?.seq ?? 0, status })

/** Resolves when the request's signal aborts, as a held poll does when the CLI gives up on it. */
function held(req: CapturedRequest): Promise<Response> {
  return new Promise((_, reject) => {
    const signal = req.init.signal
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
  })
}

const pathsOf = (calls: CapturedRequest[]) => calls.map((c) => new URL(c.url).pathname)

describe("candle quant ask (BE-2790)", () => {
  test("sends the question over the key route, follows the turn, prints the answer", async () => {
    const f = setup({
      [TURNS]: accepted,
      [EVENTS]: [
        () =>
          page(
            [
              { seq: 1, kind: "turn_started", data: { turnId: "t_1" } },
              { seq: 2, kind: "text", data: { text: "First." } },
            ],
            "running",
          ),
        () =>
          page(
            [
              { seq: 3, kind: "text", data: { text: "Second." } },
              { seq: 4, kind: "done", data: { messagesLeft: 7 } },
            ],
            "done",
          ),
      ],
    })
    expect(await run(["quant", "ask", "What moved SOL?"], f.deps)).toBe(0)
    expect(f.stdout.text).toBe("First.\n\nSecond.\n")
    expect(f.stderr.text).toContain("7 Quant answers left today.")
    const send = f.routed.calls[0]
    expect(send?.init.method).toBe("POST")
    const body = JSON.parse(String(send?.init.body))
    expect(body.text).toBe("What moved SOL?")
    expect(body.clientTurnId).toMatch(/^[0-9a-f-]{36}$/)
    expect((send?.init.headers as Record<string, string>)["x-api-key"]).toBe("cndl_live_k")
    expect(f.routed.calls.map((c) => new URL(c.url).search)).toEqual(["", "?after=0", "?after=2"])
  })

  test("--json prints {turnId, answer, remaining, resetsAt} from the route", async () => {
    const f = setup({
      [TURNS]: accepted,
      [EVENTS]: () =>
        page(
          [
            { seq: 1, kind: "text", data: { text: "Answer." } },
            { seq: 2, kind: "done", data: { messagesLeft: 0, resetsAt: "2026-11-06T00:00:00Z" } },
          ],
          "done",
        ),
    })
    expect(await run(["quant", "ask", "hi", "--json"], f.deps)).toBe(0)
    expect(JSON.parse(f.stdout.text)).toEqual({
      turnId: "t_1",
      answer: "Answer.",
      remaining: 0,
      resetsAt: "2026-11-06T00:00:00Z",
    })
  })

  test("a lost answer to POST /turns is resent with the same clientTurnId", async () => {
    const f = setup({
      [TURNS]: [
        () => {
          throw new TypeError("fetch failed")
        },
        accepted,
      ],
      [EVENTS]: () =>
        page(
          [
            { seq: 1, kind: "text", data: { text: "ok" } },
            { seq: 2, kind: "done", data: {} },
          ],
          "done",
        ),
    })
    expect(await run(["quant", "ask", "hi", "--json"], f.deps)).toBe(0)
    const [first, second] = f.routed.calls.map((c) => (c.init.body ? JSON.parse(String(c.init.body)) : null))
    expect(first.clientTurnId).toBe(second.clientTurnId)
  })

  const refusals: [string, number, Record<string, unknown>, Record<string, unknown>, string][] = [
    [
      "limit_reached",
      429,
      { code: "limit_reached", resetsAt: "2026-11-06T00:00:00Z" },
      { resetsAt: "2026-11-06T00:00:00Z" },
      "They reset at 2026-11-06T00:00:00Z.",
    ],
    [
      "turn_in_progress",
      409,
      { code: "turn_in_progress", turnId: "t_9" },
      { turnId: "t_9" },
      "already answering another question",
    ],
    ["text_too_long", 413, { code: "text_too_long", limit: 4000, unit: "codepoints" }, { limit: 4000 }, "up to 4000"],
    ["RATE_LIMITED", 429, { code: "RATE_LIMITED", retryable: true }, { retryable: true }, "Too many requests"],
    ["VALIDATION_FAILED", 400, { code: "VALIDATION_FAILED" }, {}, "malformed"],
    ["NO_IDENTITY_WALLET", 403, { code: "NO_IDENTITY_WALLET" }, {}, "no identity wallet"],
    ["TERMS_REQUIRED", 403, { code: "TERMS_REQUIRED", retryable: false }, {}, "candle quant terms"],
  ]
  for (const [code, status, body, details, sentence] of refusals) {
    test(`${code} is a plain sentence, exit 1, and the code under --json`, async () => {
      let f = setup({ [TURNS]: () => jsonResponse(status, body) })
      expect(await run(["quant", "ask", "hi", "--json"], f.deps)).toBe(1)
      const out = JSON.parse(f.stdout.text)
      expect(out).toMatchObject({ ok: false, code, details: { status, ...details } })
      expect(pathsOf(f.routed.calls)).toEqual([TURNS])

      f = setup({ [TURNS]: () => jsonResponse(status, body) })
      expect(await run(["quant", "ask", "hi"], f.deps)).toBe(1)
      expect(f.stdout.text).toBe("")
      expect(f.stderr.text).toContain(sentence)
    })
  }

  test("the key middleware's envelope-shaped RATE_LIMITED reads the same", async () => {
    const f = setup({
      [TURNS]: () => jsonResponse(429, { success: false, error: { code: "RATE_LIMITED", message: "slow down" } }),
    })
    expect(await run(["quant", "ask", "hi", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: false, code: "RATE_LIMITED" })
  })

  test("a 404 is Quant for agent keys being off on this API", async () => {
    const f = setup({ [TURNS]: () => jsonResponse(404, { error: "Not found" }) })
    expect(await run(["quant", "ask", "hi", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({
      ok: false,
      code: "QUANT_AGENT_OFF",
      message: "Quant for agent keys is off on this API.",
    })
    const human = setup({ [TURNS]: () => jsonResponse(404, { error: "Not found" }) })
    expect(await run(["quant", "ask", "hi"], human.deps)).toBe(1)
    expect(human.stderr.text).toContain("Quant for agent keys is off on this API.")
  })

  test("a 402 offer is printed with its price, and nothing is paid or retried", async () => {
    const required = {
      x402Version: 2,
      resource: {
        url: "https://api.test/api/v1/agent/quant/turns",
        description: "Quant answer past the daily limit, 0.05 USDC",
      },
      accepts: [
        {
          scheme: "exact",
          network: "solana:devnet",
          amount: "50000",
          asset: "USDC",
          payTo: "PayToAddress",
          maxTimeoutSeconds: 60,
        },
      ],
    }
    const offer = () =>
      jsonResponse(
        402,
        { success: false, error: { code: "PAYMENT_REQUIRED", message: "This call costs 0.05 USDC." }, x402: required },
        { "PAYMENT-REQUIRED": encodeHeader(required) },
      )
    let f = setup({ [TURNS]: offer })
    expect(await run(["quant", "ask", "hi", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({
      ok: false,
      code: "PAYMENT_REQUIRED",
      details: { status: 402, priceUsdc: "0.05", network: "solana:devnet", payTo: "PayToAddress" },
    })
    expect(f.routed.calls).toHaveLength(1)
    for (const call of f.routed.calls) {
      const headers = call.init.headers as Record<string, string>
      expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain("payment-signature")
    }
    f = setup({ [TURNS]: offer })
    expect(await run(["quant", "ask", "hi"], f.deps)).toBe(1)
    expect(f.stderr.text).toContain("This Quant answer costs 0.05 USDC.")
    expect(f.stderr.text).toContain("pays nothing")
  })

  test("Ctrl-C while Quant is answering posts /turns/:id/cancel and exits 130", async () => {
    let f!: ReturnType<typeof setup>
    f = setup({
      [TURNS]: accepted,
      [EVENTS]: [
        () => page([{ seq: 1, kind: "turn_started", data: {} }], "running"),
        (req) => {
          queueMicrotask(() => f.interrupt())
          return held(req)
        },
      ],
      [CANCEL]: () => jsonResponse(200, { ok: true }),
    })
    expect(await run(["quant", "ask", "hi", "--json"], f.deps)).toBe(130)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: false, code: "INTERRUPTED", details: { turnId: "t_1" } })
    expect(JSON.parse(f.stdout.text).message).toContain("Quant's turn was cancelled.")
    expect(pathsOf(f.routed.calls)).toEqual([TURNS, EVENTS, EVENTS, CANCEL])
    expect(f.routed.calls.at(-1)?.init.method).toBe("POST")
  })

  test("--timeout passing cancels the turn", async () => {
    const f = setup({
      [TURNS]: accepted,
      [EVENTS]: held,
      [CANCEL]: () => jsonResponse(200, { ok: true }),
    })
    expect(await run(["quant", "ask", "hi", "--timeout", "1", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: false, code: "QUANT_TIMEOUT", details: { turnId: "t_1" } })
    expect(JSON.parse(f.stdout.text).message).toContain("Quant's turn was cancelled.")
    expect(JSON.parse(f.stdout.text).suggestion).toContain("Ask again")
    expect(pathsOf(f.routed.calls)).toEqual([TURNS, EVENTS, CANCEL])
  })

  const cancelFailures: [string, Handler, Record<string, unknown>][] = [
    [
      "HTTP failure",
      () => jsonResponse(503, { code: "UPSTREAM_UNAVAILABLE", retryable: true }),
      { code: "UPSTREAM_UNAVAILABLE", status: 503, shape: "relay", retryable: true },
    ],
    [
      "transport failure",
      () => {
        throw new TypeError("fetch failed")
      },
      { code: "NETWORK_ERROR", status: 0, shape: "transport", retryable: true },
    ],
  ]
  for (const [failure, cancel, refusal] of cancelFailures) {
    for (const trigger of ["timeout", "Ctrl-C"] as const) {
      for (const json of [true, false]) {
        test(`${trigger} with cancellation ${failure} reports uncertainty (${json ? "JSON" : "plain"})`, async () => {
          let f!: ReturnType<typeof setup>
          f = setup({
            [TURNS]: accepted,
            [EVENTS]: (req) => {
              if (trigger === "Ctrl-C") queueMicrotask(() => f.interrupt())
              return held(req)
            },
            [CANCEL]: cancel,
          })
          const args = ["quant", "ask", "hi", "--timeout", "1", ...(json ? ["--json"] : [])]
          expect(await run(args, f.deps)).toBe(trigger === "Ctrl-C" ? 130 : 1)
          const output = json ? JSON.parse(f.stdout.text).message : f.stderr.text
          expect(output).toContain("cancellation could not be confirmed")
          expect(output).toContain("Quant's turn may still run")
          expect(output).not.toContain("was cancelled")
          expect(f.stdout.text + f.stderr.text).not.toContain("Ask again")
          if (json) {
            expect(JSON.parse(f.stdout.text)).toMatchObject({
              ok: false,
              code: trigger === "Ctrl-C" ? "INTERRUPTED" : "QUANT_TIMEOUT",
              details: { turnId: "t_1", cancelRefusal: refusal },
            })
            expect(f.stderr.text).toBe("")
          } else {
            expect(f.stdout.text).toBe("")
          }
          expect(pathsOf(f.routed.calls)).toEqual([TURNS, EVENTS, CANCEL])
          expect(f.routed.calls.at(-1)?.init.method).toBe("POST")
        })
      }
    }

    test(`Ctrl-C before polling preserves cancellation ${failure}`, async () => {
      let f!: ReturnType<typeof setup>
      f = setup({
        [TURNS]: () => {
          f.interrupt()
          return accepted()
        },
        [CANCEL]: cancel,
      })
      expect(await run(["quant", "ask", "hi", "--json"], f.deps)).toBe(130)
      expect(JSON.parse(f.stdout.text)).toMatchObject({
        code: "INTERRUPTED",
        details: { turnId: "t_1", cancelRefusal: refusal },
      })
      expect(JSON.parse(f.stdout.text).message).toContain("cancellation could not be confirmed")
      expect(pathsOf(f.routed.calls)).toEqual([TURNS, CANCEL])
    })
  }

  test("an error event ends the turn with its code", async () => {
    const f = setup({
      [TURNS]: accepted,
      [EVENTS]: () => page([{ seq: 1, kind: "error", data: { code: "busy", retryable: true } }], "error"),
    })
    expect(await run(["quant", "ask", "hi", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({
      ok: false,
      code: "busy",
      details: { turnId: "t_1", retryable: true },
    })
  })

  test("too_many_polls waits and polls again from the same cursor", async () => {
    const f = setup({
      [TURNS]: accepted,
      [EVENTS]: [
        () => jsonResponse(429, { code: "too_many_polls", retryable: true }),
        () =>
          page(
            [
              { seq: 1, kind: "text", data: { text: "ok" } },
              { seq: 2, kind: "done", data: {} },
            ],
            "done",
          ),
      ],
    })
    expect(await run(["quant", "ask", "hi"], f.deps)).toBe(0)
    expect(f.stdout.text).toBe("ok\n")
    expect(f.routed.calls.map((c) => new URL(c.url).search)).toEqual(["", "?after=0", "?after=0"])
  })

  test("a turn that ends with no text is not an answer", async () => {
    const f = setup({ [TURNS]: accepted, [EVENTS]: () => page([{ seq: 1, kind: "done", data: {} }], "done") })
    expect(await run(["quant", "ask", "hi", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: false, code: "QUANT_EMPTY_ANSWER" })
  })

  test("no key, no text, and a bad --timeout make no request", async () => {
    let f = setup({}, {})
    expect(await run(["quant", "ask", "hi", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: false, code: "NO_API_KEY" })
    f = setup({})
    expect(await run(["quant", "ask"], f.deps)).toBe(2)
    expect(await run(["quant", "ask", "  "], f.deps)).toBe(2)
    expect(await run(["quant", "ask", "a", "b"], f.deps)).toBe(2)
    expect(await run(["quant", "ask", "hi", "--timeout", "0"], f.deps)).toBe(2)
    expect(await run(["quant", "ask", "hi", "--timeout", "soon"], f.deps)).toBe(2)
    expect(f.routed.calls).toHaveLength(0)
  })

  test("an http API URL other than this machine's is refused before the key is sent", async () => {
    const f = setup({}, { CANDLE_API_KEY: "cndl_live_k", CANDLE_API_URL: "http://api.test" })
    expect(await run(["quant", "ask", "hi", "--json"], f.deps)).toBe(1)
    expect(JSON.parse(f.stdout.text)).toMatchObject({ ok: false })
    expect(f.routed.calls).toHaveLength(0)
  })
})
