/**
 * BE-1665: shared fixtures for the core tests. Not a `*.test.ts` file itself, and imported by
 * nothing that ships.
 */
import type { CliConfig } from "../config"
import { keySignerRef } from "../key-signers"
import { profileSecretRef } from "../profiles"
import type { SecretStore } from "../secret-store"

/** A Candle-shaped Write key (prefix `wwwwwwww`), Read key (prefix `rrrrrrrr`), device token and signer. */
export const WRITE_KEY = `cndl_test_${"w".repeat(43)}`
export const READ_KEY = `cndl_test_${"r".repeat(43)}`
export const DEVICE_TOKEN = `cndl_dt_${"d".repeat(40)}`
export const SIGNER_HALF = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgFIXTUREfixturefixture"
export const SPKI = "a".repeat(64)
export const WRITE_PREFIX = "wwwwwwww"
export const READ_PREFIX = "rrrrrrrr"

/** A secret store whose contents a test can inspect in full. */
export function inspectableStore(seed: Record<string, string> = {}): SecretStore & { entries(): [string, string][] } {
  const data = new Map(Object.entries(seed))
  return {
    async get(ref) {
      return data.get(ref) ?? null
    },
    async set(ref, value) {
      data.set(ref, value)
    },
    async delete(ref) {
      data.delete(ref)
    },
    entries() {
      return [...data.entries()]
    },
  }
}

/** The plain items a signed-in profile holds before trading moves them. */
export function plainSeed(profile: string): Record<string, string> {
  return {
    [profileSecretRef(profile, "apiKey")]: WRITE_KEY,
    [profileSecretRef(profile, "deviceToken")]: DEVICE_TOKEN,
    [keySignerRef(WRITE_PREFIX, SPKI)]: SIGNER_HALF,
  }
}

export function profileConfig(profile: string, apiUrl = "https://staging.api.candle.tv"): CliConfig {
  return {
    profiles: { [profile]: { apiUrl, account: "Acct111", keyPrefix: WRITE_PREFIX } },
    activeProfile: profile,
    keySigners: {
      entries: [
        {
          keyPrefix: WRITE_PREFIX,
          spkiSha256: SPKI,
          fingerprint: "CNDL-AAAA-AAAA-AAAA",
          publicKeyDer: "x",
          createdAt: 0,
        },
      ],
    },
  }
}

/** A line-reading client for the core socket, recording every frame the core sends. */
export interface TestClient {
  request(
    method: string,
    params?: unknown,
  ): Promise<{
    result?: unknown
    error?: { code: number; message: string; data?: { code: string } & Record<string, unknown> }
  }>
  /** Every raw line received, in order. */
  frames: string[]
  /** Every `event` notification's params, in order. */
  events: { topic: string; seq: number; data: unknown; snapshot?: boolean }[]
  closed: Promise<void>
  isClosed(): boolean
  writeRaw(text: string): void
  close(): void
}

export async function connectTestClient(socketPath: string): Promise<TestClient> {
  const { createConnection } = await import("node:net")
  const socket = createConnection(socketPath)
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve())
    socket.once("error", reject)
  })
  const frames: string[] = []
  const events: TestClient["events"] = []
  const pending = new Map<number, (message: Record<string, unknown>) => void>()
  let nextId = 1
  let buffer = ""
  let closed = false
  const closedPromise = new Promise<void>((resolve) =>
    socket.on("close", () => {
      closed = true
      for (const [, settle] of pending) settle({ error: { code: 0, message: "closed", data: { code: "CLOSED" } } })
      pending.clear()
      resolve()
    }),
  )
  socket.on("error", () => {})
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8")
    for (;;) {
      const newline = buffer.indexOf("\n")
      if (newline === -1) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      frames.push(line)
      const message = JSON.parse(line) as Record<string, unknown>
      if (message.method === "event") events.push(message.params as TestClient["events"][number])
      else if (typeof message.id === "number") {
        pending.get(message.id)?.(message)
        pending.delete(message.id)
      }
    }
  })
  return {
    frames,
    events,
    closed: closedPromise,
    isClosed: () => closed,
    writeRaw: (text) => socket.write(text),
    close: () => socket.end(),
    request(method, params) {
      const id = nextId++
      return new Promise((resolve) => {
        if (closed) return resolve({ error: { code: 0, message: "closed", data: { code: "CLOSED" } } })
        pending.set(id, (message) => resolve(message as never))
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`)
      })
    },
  }
}
