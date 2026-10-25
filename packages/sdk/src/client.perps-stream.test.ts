/**
 * The SDK's private perps stream client (BE-1820, Hyperliquid phase 3 spec, P3-7):
 * `client.perpsStream()` opens the Candle WebSocket with the key on the upgrade headers, parses
 * every frame into `onMessage`, reports the close once through `onClose`, and closes cleanly on
 * `close()` or an aborted signal. The WebSocket global is faked here, so nothing reaches the
 * network; the built-SDK loopback under real Node is `client.perps-stream.node.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { CandleClient, type PerpsStreamSocketOptions, type PerpsStreamWebSocket } from "./client"

const KEY = "cndl_live_testkey0000000000000000000000000000"

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static instances: FakeWebSocket[] = []
  static get last(): FakeWebSocket | undefined {
    return FakeWebSocket.instances.at(-1)
  }
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readyState = 1
  url: string
  options: unknown
  sent: string[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  constructor(url: string | URL, options?: unknown) {
    this.url = url.toString()
    this.options = options
    FakeWebSocket.instances.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close(code = 1000, reason = "") {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
  emit(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

const realWebSocket = globalThis.WebSocket
afterEach(() => {
  globalThis.WebSocket = realWebSocket
  FakeWebSocket.instances = []
})

/** The socket opens through a promise chain, so a test must let that microtask run first. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

function client() {
  return new CandleClient({
    apiUrl: "https://api.test",
    apiKey: KEY,
    fetch: (async () => {
      throw new Error("the stream opens a WebSocket, not HTTP")
    }) as unknown as typeof fetch,
  })
}

describe("perpsStream (P3-7)", () => {
  test("opens the stream URL with the key on the upgrade headers and parses frames", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const frames: unknown[] = []
    const handle = client().perpsStream({ walletId: "w-1", onMessage: (frame) => frames.push(frame) })
    await settled()
    const socket = FakeWebSocket.last
    expect(socket?.url).toBe("wss://api.test/api/v1/agent/perps/stream?walletId=w-1")
    expect(socket?.options).toEqual({ headers: { "x-api-key": KEY } })
    socket?.emit({ type: "snapshot", seq: 1, at: "2026-10-25T00:00:00.000Z", ordersSource: "push" })
    socket?.emit({ type: "heartbeat", seq: 2, at: "2026-10-25T00:00:30.000Z", level: "warn" })
    socket?.emit("not json")
    expect(frames).toEqual([
      { type: "snapshot", seq: 1, at: "2026-10-25T00:00:00.000Z", ordersSource: "push" },
      { type: "heartbeat", seq: 2, at: "2026-10-25T00:00:30.000Z", level: "warn" },
    ])
    handle.close()
    expect(socket?.readyState).toBe(3)
  })

  test("a refused upgrade surfaces as one onClose with the server's code and reason", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const closed: { code: number; reason: string }[] = []
    client().perpsStream({ walletId: "w-1", onMessage: () => {}, onClose: (close) => closed.push(close) })
    await settled()
    FakeWebSocket.last?.onerror?.()
    FakeWebSocket.last?.close(4401, "key revoked")
    FakeWebSocket.last?.onclose?.({ code: 4401, reason: "key revoked" })
    expect(closed).toEqual([{ code: 4401, reason: "key revoked" }])
  })

  test("an aborted signal closes the open socket; a close before it opens applies on open", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const controller = new AbortController()
    client().perpsStream({ walletId: "w-1", onMessage: () => {}, signal: controller.signal })
    await settled()
    controller.abort()
    expect(FakeWebSocket.last?.readyState).toBe(3)

    // close() before the promise chain attaches its handlers is still one clean close: the
    // socket exists (the global path constructs synchronously), and the pending client close is
    // applied the moment the handlers arrive.
    const closed: { code: number; reason: string }[] = []
    const handle = client().perpsStream({ walletId: "w-1", onMessage: () => {}, onClose: (c) => closed.push(c) })
    handle.close()
    await settled()
    expect(FakeWebSocket.last?.readyState).toBe(3)
    expect(closed).toEqual([{ code: 1000, reason: "client closed" }])
  })

  test("an injected constructor wins over the global and receives the headers", async () => {
    const opened: { url: string; options: PerpsStreamSocketOptions }[] = []
    class Injected {
      readonly CONNECTING = 0
      readonly OPEN = 1
      readonly CLOSING = 2
      readonly CLOSED = 3
      readyState = 1
      onmessage: ((event: { data: unknown }) => void) | null = null
      onclose: ((event: { code: number; reason: string }) => void) | null = null
      onerror: ((event: unknown) => void) | null = null
      constructor(
        readonly url: string,
        readonly options: PerpsStreamSocketOptions,
      ) {
        opened.push({ url, options })
      }
      send() {}
      close(code = 1000, reason = "") {
        this.readyState = 3
        this.onclose?.({ code, reason })
      }
    }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const closed: { code: number; reason: string }[] = []
    const injected = new CandleClient({
      apiUrl: "https://api.test",
      apiKey: KEY,
      fetch: (async () => null) as unknown as typeof fetch,
      perpsStreamWebSocket: Injected,
    })
    const handle = injected.perpsStream({ walletId: "w-2", onMessage: () => {}, onClose: (c) => closed.push(c) })
    await settled()
    expect(opened).toEqual([
      { url: "wss://api.test/api/v1/agent/perps/stream?walletId=w-2", options: { headers: { "x-api-key": KEY } } },
    ])
    expect(FakeWebSocket.instances).toEqual([])
    handle.close()
    expect(closed).toEqual([{ code: 1000, reason: "client closed" }])
  })

  test("an http apiUrl opens a ws stream; trailing slashes are trimmed", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const local = new CandleClient({
      apiUrl: "http://127.0.0.1:3001/",
      apiKey: KEY,
      allowInsecureHttp: true,
      fetch: (async () => null) as unknown as typeof fetch,
    })
    local.perpsStream({ walletId: "w-2", onMessage: () => {} })
    await settled()
    expect(FakeWebSocket.last?.url).toBe("ws://127.0.0.1:3001/api/v1/agent/perps/stream?walletId=w-2")
  })

  test("a client without a key is refused", () => {
    expect(() =>
      new CandleClient({
        apiUrl: "https://api.test",
        fetch: (async () => null) as unknown as typeof fetch,
      }).perpsStream({ walletId: "w-1", onMessage: () => {} }),
    ).toThrow("perpsStream()")
  })
})
