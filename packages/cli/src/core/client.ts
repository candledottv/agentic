/**
 * A client of the core's attach interface (BE-1665, spec A-1): one connection, newline-delimited
 * JSON-RPC 2.0. `candle core mcp` uses it to attach as a harness; the views will too.
 */
import { createConnection, type Socket } from "node:net"
import { encodeLine, LineDecoder, PROTOCOL_VERSION, type RpcErrorBody } from "./rpc"

export class CoreClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = "CoreClientError"
  }
}

export interface CoreConnection {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  onEvent(listener: (params: { topic: string; seq: number; data: unknown; snapshot?: boolean }) => void): void
  onClose(listener: () => void): void
  close(): void
}

/** Connects and says hello. Refusals (`PROTOCOL_MISMATCH`, `UNAUTHENTICATED`) reject with their code. */
export async function connectCore(input: {
  socketPath: string
  token: string
  clientName: string
  harnessKind?: string
}): Promise<{ connection: CoreConnection; hello: Record<string, unknown> }> {
  const socket: Socket = await new Promise((resolve, reject) => {
    const s = createConnection(input.socketPath)
    s.once("connect", () => resolve(s))
    s.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT" || error.code === "ECONNREFUSED"
          ? new CoreClientError(
              "CORE_NOT_RUNNING",
              `No Candle core is listening at ${input.socketPath}. Start it with candle tui.`,
            )
          : error,
      )
    })
  })
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const eventListeners: ((params: { topic: string; seq: number; data: unknown; snapshot?: boolean }) => void)[] = []
  const closeListeners: (() => void)[] = []
  const decoder = new LineDecoder()
  let nextId = 1
  let closed = false
  socket.on("error", () => {})
  socket.on("data", (chunk: Buffer) => {
    for (const line of decoder.push(chunk).lines) {
      let message: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: RpcErrorBody }
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.method === "event") {
        for (const listener of eventListeners) listener(message.params as never)
        continue
      }
      if (typeof message.id !== "number") continue
      const waiter = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) {
        const { code, ...details } = message.error.data ?? { code: "CORE_ERROR" }
        waiter?.reject(new CoreClientError(code, message.error.message, details))
      } else waiter?.resolve(message.result)
    }
  })
  socket.on("close", () => {
    closed = true
    for (const waiter of pending.values())
      waiter.reject(new CoreClientError("CORE_DISCONNECTED", "The Candle core closed the connection."))
    pending.clear()
    for (const listener of closeListeners) listener()
  })
  const connection: CoreConnection = {
    request(method, params) {
      if (closed)
        return Promise.reject(new CoreClientError("CORE_DISCONNECTED", "The Candle core closed the connection."))
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
        socket.write(encodeLine({ jsonrpc: "2.0", id, method, params: params ?? {} }))
      })
    },
    onEvent: (listener) => eventListeners.push(listener),
    onClose: (listener) => closeListeners.push(listener),
    close: () => socket.end(),
  }
  try {
    const hello = await connection.request<Record<string, unknown>>("core.hello", {
      protocol: PROTOCOL_VERSION,
      token: input.token,
      clientName: input.clientName,
      ...(input.harnessKind ? { harnessKind: input.harnessKind } : {}),
    })
    return { connection, hello }
  } catch (error) {
    connection.close()
    throw error
  }
}
