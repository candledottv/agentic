/**
 * The attach interface's wire format (BE-1665, spec A-1): JSON-RPC 2.0, one message per line
 * (newline-delimited JSON), UTF-8, at most 1 MiB per message.
 *
 * Error codes are JSON-RPC's own for transport and shape faults, plus `-32001` for a call outside
 * the caller's role (A-3) and `-32000` for every other refusal. Each carries a stable string in
 * `data.code` (`FORBIDDEN_FOR_ROLE`, `PROTOCOL_MISMATCH`, `NO_VIEW_ATTACHED`, ...), which is what a
 * client branches on; the number is for JSON-RPC libraries.
 */

export const PROTOCOL_VERSION = "1.0"
export const MAX_MESSAGE_BYTES = 1024 * 1024

export const RPC_PARSE_ERROR = -32700
export const RPC_INVALID_REQUEST = -32600
export const RPC_METHOD_NOT_FOUND = -32601
export const RPC_INVALID_PARAMS = -32602
export const RPC_INTERNAL_ERROR = -32603
export const RPC_REFUSED = -32000
export const RPC_FORBIDDEN_FOR_ROLE = -32001

export type RpcId = string | number | null

export interface RpcRequest {
  jsonrpc: "2.0"
  id?: RpcId
  method: string
  params?: unknown
}

export interface RpcErrorBody {
  code: number
  message: string
  data?: { code: string } & Record<string, unknown>
}

export type RpcResponse =
  | { jsonrpc: "2.0"; id: RpcId; result: unknown }
  | { jsonrpc: "2.0"; id: RpcId; error: RpcErrorBody }

export interface RpcNotification {
  jsonrpc: "2.0"
  method: string
  params: unknown
}

/** A refusal a handler throws; the server turns it into the error response. */
export class RpcError extends Error {
  /** Set on a refusal that also ends the connection (a failed `core.hello`). */
  closes = false

  constructor(
    readonly rpcCode: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = "RpcError"
  }

  body(): RpcErrorBody {
    return { code: this.rpcCode, message: this.message, data: { code: this.code, ...this.details } }
  }
}

export function refused(code: string, message: string, details: Record<string, unknown> = {}): RpcError {
  return new RpcError(RPC_REFUSED, code, message, details)
}

export function invalidParams(message: string): RpcError {
  return new RpcError(RPC_INVALID_PARAMS, "INVALID_PARAMS", message)
}

/** The major part of a `major.minor` protocol string, or undefined when it is not one. */
export function protocolMajor(version: unknown): number | undefined {
  if (typeof version !== "string") return undefined
  const match = /^(\d+)\.(\d+)$/.exec(version)
  return match ? Number(match[1]) : undefined
}

/**
 * Splits a byte stream into lines, refusing a line over {@link MAX_MESSAGE_BYTES}. A refused line
 * is reported once and then skipped to its newline, so one oversized message does not desync the
 * stream; the caller decides whether to drop the connection.
 */
export class LineDecoder {
  private buffer: Buffer = Buffer.alloc(0)
  private discarding = false

  constructor(private readonly maxBytes = MAX_MESSAGE_BYTES) {}

  push(chunk: Buffer): { lines: string[]; oversized: number } {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const lines: string[] = []
    let oversized = 0
    for (;;) {
      const newline = this.buffer.indexOf(0x0a)
      if (newline === -1) {
        if (this.buffer.length > this.maxBytes) {
          if (!this.discarding) oversized++
          this.discarding = true
          this.buffer = Buffer.alloc(0)
        }
        break
      }
      const line = this.buffer.subarray(0, newline)
      this.buffer = this.buffer.subarray(newline + 1)
      if (this.discarding) {
        this.discarding = false
        continue
      }
      if (line.length > this.maxBytes) {
        oversized++
        continue
      }
      const text = line.toString("utf8").trim()
      if (text.length > 0) lines.push(text)
    }
    return { lines, oversized }
  }
}

/** One message as a line. Throws for a message over the limit, which is a bug on the sender's side. */
export function encodeLine(message: unknown): string {
  const line = `${JSON.stringify(message)}\n`
  if (Buffer.byteLength(line, "utf8") > MAX_MESSAGE_BYTES) throw new Error("An attach-interface message exceeds 1 MiB.")
  return line
}
