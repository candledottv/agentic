/**
 * The attach interface (BE-1665, spec A-1 to A-4): the core's local socket and the methods views
 * and harnesses call on it.
 *
 * Transport. A Unix domain socket at `<state dir>/core.sock`, mode 0600, in the 0700 state
 * directory. Node exposes no peer-credential call, so the "refuse another user" rule of A-1 is
 * the filesystem's: another user cannot traverse the directory or open the socket.
 *
 * Authentication. The first message must be `core.hello {protocol, token, clientName,
 * harnessKind?}`. The token decides the role (`tokens.ts`). A different protocol major is refused
 * with `PROTOCOL_MISMATCH` and both versions; an unknown token with `UNAUTHENTICATED`. Either
 * closes the connection.
 *
 * Roles. {@link METHOD_ROLES} is A-3's table, the single copy. A call outside the caller's column
 * returns `-32001 FORBIDDEN_FOR_ROLE` and is journaled. No method returns a key, a stored token,
 * a passphrase or a vault secret, and every outgoing message passes the redactor first (K-10).
 *
 * Handlers for the methods later sections own (tools, cards, operations, settings writes) are
 * registered by those sections through {@link CoreServer.handle}; until then a permitted call
 * answers `METHOD_NOT_AVAILABLE`. The role check runs first either way, so the table is enforced
 * for every method from this PR on.
 */
import { randomBytes } from "node:crypto"
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { terminalText } from "../render"
import { EventHub, type Subscriber, topicAllowed } from "./events"
import type { CoreEnvironment, Journal } from "./journal"
import type { Redactor } from "./redact"
import {
  encodeLine,
  invalidParams,
  LineDecoder,
  PROTOCOL_VERSION,
  protocolMajor,
  RPC_FORBIDDEN_FOR_ROLE,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
  RpcError,
  type RpcErrorBody,
  type RpcId,
  refused,
} from "./rpc"
import { cleanHarnessName, type Role, type TokenBook } from "./tokens"

/** `yes`: may call. `own`: may call, scoped to its own cards, operations or topics. `no`: refused. */
export type Access = "yes" | "own" | "no"

/** A-3, as written. Methods not listed here do not exist. */
export const METHOD_ROLES: Readonly<Record<string, { view: Access; harness: Access }>> = {
  "core.hello": { view: "yes", harness: "yes" },
  "core.status": { view: "yes", harness: "yes" },
  "tools.list": { view: "yes", harness: "yes" },
  "tools.call": { view: "yes", harness: "yes" },
  "cards.propose": { view: "yes", harness: "yes" },
  "cards.list": { view: "yes", harness: "own" },
  "cards.get": { view: "yes", harness: "own" },
  "cards.approve": { view: "yes", harness: "no" },
  "cards.reject": { view: "yes", harness: "no" },
  "cards.withdraw": { view: "own", harness: "own" },
  "operations.list": { view: "yes", harness: "own" },
  "operations.get": { view: "yes", harness: "own" },
  "operations.resolve": { view: "yes", harness: "no" },
  "clients.list": { view: "yes", harness: "no" },
  "clients.kill": { view: "yes", harness: "no" },
  "harness.register": { view: "yes", harness: "no" },
  "harness.revoke": { view: "yes", harness: "no" },
  "settings.get": { view: "yes", harness: "no" },
  "settings.set": { view: "yes", harness: "no" },
  "layout.get": { view: "yes", harness: "no" },
  "layout.set": { view: "yes", harness: "no" },
  subscribe: { view: "yes", harness: "own" },
  unsubscribe: { view: "yes", harness: "own" },
  // S4 (BE-1680), the Architecture delta: view only, every one. A harness cannot upload an image
  // (invariant 16), run a launch's dry run for the user, or read the user's transfer sources and
  // destinations, let alone prepare a transfer (K-3, invariant 11).
  "launch.uploadImage": { view: "yes", harness: "no" },
  "launch.dryRun": { view: "yes", harness: "no" },
  "transfer.sources": { view: "yes", harness: "no" },
  "transfer.destinations": { view: "yes", harness: "no" },
  "transfer.prepare": { view: "yes", harness: "no" },
  // S5 (BE-1737), Q-3 and Q-I2: Quant is a view-only agent. A harness reaches no `quant.*` method
  // (D-1 default A), so it cannot spend the user's Quant messages or feed Quant's text to a model.
  "quant.status": { view: "yes", harness: "no" },
  "quant.send": { view: "yes", harness: "no" },
  "quant.cancel": { view: "yes", harness: "no" },
  "quant.history": { view: "yes", harness: "no" },
}

/** Longest socket path every supported platform accepts (macOS `sun_path` is 104 bytes with the NUL). */
export const MAX_SOCKET_PATH_BYTES = 103
const HELLO_TIMEOUT_MS = 10_000
const MAX_LAYOUT_BYTES = 64 * 1024

export interface ClientInfo {
  clientId: string
  role: Role
  clientName: string
  harnessKind?: string
  tokenId?: string
  connectedAt: string
  lastCall?: string
  lastCallAt?: string
}

export interface CallContext {
  client: ClientInfo
  /** `own` when the caller's column says so: the handler must scope to `client.clientId`. */
  access: Access
  server: CoreServer
}

export type Handler = (params: Record<string, unknown>, call: CallContext) => Promise<unknown>

export interface CoreStatus {
  profile: string
  environment: CoreEnvironment
  tradingOn: boolean
  approvalPolicy: "ask"
  viewCount: number
  clientCount: number
}

interface Connection {
  socket: Socket
  client?: ClientInfo
  helloTimer?: ReturnType<typeof setTimeout>
}

export class CoreServer {
  readonly events = new EventHub()
  private readonly handlers = new Map<string, Handler>()
  private readonly connections = new Map<string, Connection>()
  private server: Server | undefined
  private viewHighWater = 0
  private readonly viewListeners: ((count: number) => void)[] = []
  private readonly killListeners: ((client: ClientInfo) => void)[] = []

  constructor(
    private readonly options: {
      socketPath: string
      layoutPath: string
      profile: string
      environment: CoreEnvironment
      coreVersion: string
      journal: Journal
      redactor: Redactor
      tokens: TokenBook
      now: () => number
      tradingOn?: () => boolean
      /** A `cards.propose` naming an id the core holds is a read and needs no view (A-5, R-4). */
      proposalIsHeld?: (params: Record<string, unknown>) => boolean
    },
  ) {
    this.registerBuiltins()
    this.events.provideSnapshot("status", () => this.status())
    this.events.provideSnapshot("clients", () => this.clients())
  }

  /** Registers the handler for a method of {@link METHOD_ROLES}. Unknown methods are a bug. */
  handle(method: string, handler: Handler): void {
    if (!Object.hasOwn(METHOD_ROLES, method) || method === "core.hello") {
      throw new Error(`Not an attach-interface method: ${method}`)
    }
    this.handlers.set(method, handler)
  }

  /** Called with the new count whenever the number of attached views changes. */
  onViewCount(listener: (count: number) => void): void {
    this.viewListeners.push(listener)
  }

  /** Called when `clients.kill` or a revoke disconnects a client (K withdraws its open cards). */
  onClientKilled(listener: (client: ClientInfo) => void): void {
    this.killListeners.push(listener)
  }

  viewCount(): number {
    return this.clients().filter((client) => client.role === "view").length
  }

  /** Whether a view has ever attached to this core. C-3's "last view detached" needs it. */
  hadView(): boolean {
    return this.viewHighWater > 0
  }

  clients(): ClientInfo[] {
    return [...this.connections.values()].flatMap((connection) => (connection.client ? [{ ...connection.client }] : []))
  }

  status(): CoreStatus {
    const clients = this.clients()
    return {
      profile: this.options.profile,
      environment: this.options.environment,
      tradingOn: this.options.tradingOn?.() ?? false,
      approvalPolicy: "ask",
      viewCount: clients.filter((client) => client.role === "view").length,
      clientCount: clients.length,
    }
  }

  async listen(): Promise<void> {
    const path = this.options.socketPath
    if (Buffer.byteLength(path, "utf8") > MAX_SOCKET_PATH_BYTES) {
      throw new CoreSocketError(
        "CORE_SOCKET_PATH_TOO_LONG",
        `The core socket path is ${Buffer.byteLength(path, "utf8")} bytes; the limit is ${MAX_SOCKET_PATH_BYTES}. Use a shorter CANDLE_CONFIG_DIR.`,
      )
    }
    // The instance lock is held, so a socket file here is a dead core's.
    await rm(path, { force: true })
    const server = createServer((socket) => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(path, () => {
        server.off("error", reject)
        resolve()
      })
    })
    await chmod(path, 0o600)
    this.server = server
  }

  async close(): Promise<void> {
    for (const connection of this.connections.values()) connection.socket.destroy()
    this.connections.clear()
    const server = this.server
    this.server = undefined
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(this.options.socketPath, { force: true })
  }

  /** Disconnects a client. `revoke` also revokes the harness token it attached with. */
  async disconnect(clientId: string, reason: "killed" | "revoked"): Promise<ClientInfo | undefined> {
    const connection = this.connections.get(clientId)
    const client = connection?.client
    if (connection === undefined || client === undefined) return undefined
    connection.socket.destroy()
    await this.detach(clientId, reason)
    for (const listener of this.killListeners) listener(client)
    return client
  }

  private accept(socket: Socket): void {
    const connectionId = `c_${randomBytes(9).toString("base64url")}`
    const connection: Connection = { socket }
    this.connections.set(connectionId, connection)
    const decoder = new LineDecoder()
    connection.helloTimer = setTimeout(() => {
      if (connection.client === undefined) socket.destroy()
    }, HELLO_TIMEOUT_MS)
    connection.helloTimer.unref?.()
    let queue = Promise.resolve()
    socket.on("data", (chunk: Buffer) => {
      const { lines, oversized } = decoder.push(chunk)
      for (let i = 0; i < oversized; i++) {
        this.send(socket, {
          jsonrpc: "2.0",
          id: null,
          error: errorBody(RPC_INVALID_REQUEST, "MESSAGE_TOO_LARGE", "A message exceeded 1 MiB."),
        })
      }
      for (const line of lines) queue = queue.then(() => this.onLine(connectionId, connection, line))
    })
    socket.on("error", () => {})
    socket.on("close", () => {
      if (connection.helloTimer) clearTimeout(connection.helloTimer)
      void queue.then(() => this.detach(connectionId, "detached"))
    })
  }

  private async onLine(connectionId: string, connection: Connection, line: string): Promise<void> {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.send(connection.socket, {
        jsonrpc: "2.0",
        id: null,
        error: errorBody(RPC_PARSE_ERROR, "PARSE_ERROR", "Not valid JSON."),
      })
      return
    }
    const request = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
    const id: RpcId = typeof request?.id === "string" || typeof request?.id === "number" ? request.id : null
    if (
      request === null ||
      typeof request !== "object" ||
      request.jsonrpc !== "2.0" ||
      typeof request.method !== "string"
    ) {
      this.send(connection.socket, {
        jsonrpc: "2.0",
        id,
        error: errorBody(RPC_INVALID_REQUEST, "INVALID_REQUEST", "Not a JSON-RPC 2.0 request."),
      })
      return
    }
    // A notification from a client asks for nothing back, and nothing in A-3 is one.
    if (request.id === undefined) return
    const params = request.params === undefined ? {} : request.params
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      this.send(connection.socket, { jsonrpc: "2.0", id, error: invalidParams("params must be an object.").body() })
      return
    }
    try {
      const result =
        connection.client === undefined
          ? await this.hello(connectionId, connection, request.method, params as Record<string, unknown>)
          : await this.call(connection.client, request.method, params as Record<string, unknown>)
      this.send(connection.socket, { jsonrpc: "2.0", id, result })
    } catch (error) {
      const body =
        error instanceof RpcError
          ? error.body()
          : errorBody(
              RPC_INTERNAL_ERROR,
              "INTERNAL",
              `The core failed: ${error instanceof Error ? error.message : String(error)}`,
            )
      this.send(connection.socket, { jsonrpc: "2.0", id, error: body })
      if (error instanceof RpcError && error.closes) connection.socket.end()
    }
  }

  private async hello(
    connectionId: string,
    connection: Connection,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (method !== "core.hello") throw closing(refused("UNAUTHENTICATED", "Send core.hello first."))
    const major = protocolMajor(params.protocol)
    if (major !== protocolMajor(PROTOCOL_VERSION)) {
      throw closing(
        refused("PROTOCOL_MISMATCH", `This core speaks protocol ${PROTOCOL_VERSION}.`, {
          core: PROTOCOL_VERSION,
          client: typeof params.protocol === "string" ? params.protocol : null,
        }),
      )
    }
    const who = this.options.tokens.authenticate(params.token)
    if (who === undefined) {
      await this.options.journal.append({ type: "client.refused", reason: "UNAUTHENTICATED" })
      throw closing(refused("UNAUTHENTICATED", "The token is not one this core issued, or it was revoked."))
    }
    const clientName = cleanHarnessName(params.clientName) ?? (who.role === "view" ? "view" : who.name)
    const harnessKind = who.role === "harness" ? cleanHarnessName(params.harnessKind) : undefined
    const client: ClientInfo = {
      clientId: connectionId,
      role: who.role,
      clientName,
      ...(harnessKind !== undefined ? { harnessKind } : {}),
      ...(who.role === "harness" ? { tokenId: who.tokenId } : {}),
      connectedAt: new Date(this.options.now()).toISOString(),
    }
    if (connection.helloTimer) clearTimeout(connection.helloTimer)
    connection.client = client
    await this.options.journal.append({ type: "client.attached", client })
    this.events.publish("clients", { change: "attached", client })
    if (client.role === "view") this.viewsChanged()
    return {
      protocol: PROTOCOL_VERSION,
      coreVersion: this.options.coreVersion,
      profile: this.options.profile,
      environment: this.options.environment,
      tradingOn: this.options.tradingOn?.() ?? false,
      approvalPolicy: "ask",
      clientId: client.clientId,
      role: client.role,
    }
  }

  private async call(client: ClientInfo, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "core.hello") throw refused("ALREADY_AUTHENTICATED", "This connection already said hello.")
    const roles = Object.hasOwn(METHOD_ROLES, method) ? METHOD_ROLES[method] : undefined
    if (roles === undefined)
      throw new RpcError(RPC_METHOD_NOT_FOUND, "METHOD_NOT_FOUND", `No method ${terminalText(method).slice(0, 64)}.`)
    const access = roles[client.role]
    client.lastCall = method
    client.lastCallAt = new Date(this.options.now()).toISOString()
    if (access === "no") {
      await this.options.journal.append({
        type: "call.forbidden",
        clientId: client.clientId,
        role: client.role,
        method,
      })
      throw new RpcError(RPC_FORBIDDEN_FOR_ROLE, "FORBIDDEN_FOR_ROLE", `A ${client.role} may not call ${method}.`)
    }
    // C-3: with no view attached, nobody could see a card, so none may be created.
    if (method === "cards.propose" && this.viewCount() === 0 && !this.options.proposalIsHeld?.(params)) {
      await this.options.journal.append({
        type: "call.refused",
        clientId: client.clientId,
        method,
        code: "NO_VIEW_ATTACHED",
      })
      throw refused("NO_VIEW_ATTACHED", "No Candle TUI view is attached, so no card can be shown. Nothing was queued.")
    }
    const handler = this.handlers.get(method)
    if (handler === undefined) throw refused("METHOD_NOT_AVAILABLE", `${method} is not in this build of the core yet.`)
    return handler(params, { client, access, server: this })
  }

  private async detach(clientId: string, reason: "detached" | "killed" | "revoked"): Promise<void> {
    const connection = this.connections.get(clientId)
    if (connection === undefined) return
    this.connections.delete(clientId)
    const client = connection.client
    if (client === undefined) return
    this.events.unsubscribe(clientId)
    await this.options.journal.append({ type: `client.${reason}`, clientId, role: client.role })
    this.events.publish("clients", { change: reason, clientId })
    if (client.role === "view") this.viewsChanged()
  }

  private viewsChanged(): void {
    const count = this.viewCount()
    this.viewHighWater = Math.max(this.viewHighWater, count)
    this.events.publish("status", this.status())
    for (const listener of this.viewListeners) listener(count)
  }

  private send(socket: Socket, message: unknown): void {
    if (socket.destroyed) return
    socket.write(encodeLine(this.options.redactor.value(message)))
  }

  private subscriberFor(client: ClientInfo): Subscriber {
    const connection = this.connections.get(client.clientId)
    return {
      clientId: client.clientId,
      role: client.role,
      send: (notification) => {
        if (connection) this.send(connection.socket, notification)
      },
    }
  }

  private registerBuiltins(): void {
    this.handle("core.status", async () => this.status())
    this.handle("clients.list", async () => ({ clients: this.clients(), harnessTokens: this.options.tokens.list() }))
    this.handle("clients.kill", async (params, call) => {
      const target = requireString(params, "clientId")
      if (target === call.client.clientId) throw invalidParams("A client cannot kill itself; detach instead.")
      const connection = this.connections.get(target)
      if (connection?.client === undefined) throw refused("CLIENT_NOT_FOUND", "No attached client has that id.")
      const tokenId = connection.client.tokenId
      if (tokenId !== undefined) await this.options.tokens.revoke(tokenId)
      await this.options.journal.append({ type: "client.kill", by: call.client.clientId, clientId: target, tokenId })
      await this.disconnect(target, "killed")
      return { killed: target, revokedTokenId: tokenId ?? null }
    })
    this.handle("harness.register", async (params, call) => {
      const name = cleanHarnessName(params.name)
      if (name === undefined) throw invalidParams("name must be 1 to 64 printable characters.")
      const { token, info } = await this.options.tokens.mintHarness(name)
      await this.options.journal.append({
        type: "harness.registered",
        by: call.client.clientId,
        tokenId: info.tokenId,
        name,
      })
      // The token itself is returned exactly once, here, to the view that asked for it.
      return { ...info, token }
    })
    this.handle("harness.revoke", async (params, call) => {
      const tokenId = requireString(params, "tokenId")
      if (!(await this.options.tokens.revoke(tokenId)))
        throw refused("TOKEN_NOT_FOUND", "No live harness token has that id.")
      await this.options.journal.append({ type: "harness.revoked", by: call.client.clientId, tokenId })
      const attached = this.clients().filter((client) => client.tokenId === tokenId)
      for (const client of attached) await this.disconnect(client.clientId, "revoked")
      return { revoked: tokenId, disconnected: attached.map((client) => client.clientId) }
    })
    this.handle("settings.get", async () => ({
      tradingOn: this.options.tradingOn?.() ?? false,
      approvalPolicy: "ask",
      timedWindow: { open: false },
    }))
    this.handle("layout.get", async () => ({ layout: await this.readLayout() }))
    this.handle("layout.set", async (params) => {
      const layout = params.layout
      if (layout === null || typeof layout !== "object" || Array.isArray(layout))
        throw invalidParams("layout must be an object.")
      const text = JSON.stringify(layout)
      if (Buffer.byteLength(text, "utf8") > MAX_LAYOUT_BYTES) throw invalidParams("layout is over 64 KiB.")
      const temp = `${this.options.layoutPath}.tmp-${randomBytes(6).toString("base64url")}`
      await writeFile(temp, `${JSON.stringify({ layout }, null, 2)}\n`, { mode: 0o600, flag: "wx" })
      await rename(temp, this.options.layoutPath)
      return { layout }
    })
    this.handle("subscribe", async (params, call) => {
      const asked = params.topics
      if (!Array.isArray(asked) || asked.length === 0 || !asked.every((topic) => typeof topic === "string")) {
        throw invalidParams("topics must be a non-empty array of strings.")
      }
      // S5 G-2, Q-I10: `scope: "mine"` narrows `signals` to the watchlist, for a view only. A harness
      // asking for it is refused as invalid input, like a `mine` argument to candle_get_signals.
      const scope = params.scope
      if (scope !== undefined && scope !== "all" && scope !== "mine")
        throw refused("VALIDATION_FAILED", 'scope is "all" or "mine".')
      if (scope === "mine" && call.client.role !== "view") {
        await this.options.journal.append({
          type: "call.refused",
          clientId: call.client.clientId,
          method: "subscribe",
          code: "VALIDATION_FAILED",
        })
        throw refused("VALIDATION_FAILED", 'A harness reads the "All" signals only; scope "mine" is for a view.')
      }
      const topics = (asked as string[]).map((topic) =>
        topic === "signals" && scope === "mine" ? "signals:mine" : topic,
      )
      for (const topic of topics) {
        const verdict = topicAllowed(topic, call.client.role)
        if (!verdict.known) throw invalidParams(`Unknown topic: ${terminalText(topic).slice(0, 80)}`)
        if (!verdict.allowed) {
          await this.options.journal.append({
            type: "call.forbidden",
            clientId: call.client.clientId,
            role: call.client.role,
            method: "subscribe",
            topic,
          })
          throw new RpcError(
            RPC_FORBIDDEN_FOR_ROLE,
            "FORBIDDEN_FOR_ROLE",
            `A ${call.client.role} may not subscribe to ${topic}.`,
          )
        }
      }
      const sinceSeq = params.sinceSeq
      const since: Record<string, number> = {}
      if (sinceSeq !== undefined) {
        if (sinceSeq === null || typeof sinceSeq !== "object" || Array.isArray(sinceSeq))
          throw invalidParams("sinceSeq must be an object of topic to seq.")
        for (const [topic, seq] of Object.entries(sinceSeq))
          if (typeof seq === "number" && Number.isInteger(seq) && seq >= 0) since[topic] = seq
      }
      // The response goes out before the replay or snapshot it triggers.
      queueMicrotask(() => this.events.subscribe(this.subscriberFor(call.client), topics, since))
      return { topics: [...new Set([...this.events.topicsOf(call.client.clientId), ...topics])] }
    })
    this.handle("unsubscribe", async (params, call) => {
      const topics = params.topics
      if (topics !== undefined && (!Array.isArray(topics) || !topics.every((topic) => typeof topic === "string"))) {
        throw invalidParams("topics must be an array of strings.")
      }
      this.events.unsubscribe(call.client.clientId, topics as string[] | undefined)
      return { topics: this.events.topicsOf(call.client.clientId) }
    })
  }

  private async readLayout(): Promise<unknown> {
    try {
      const parsed = JSON.parse(await readFile(this.options.layoutPath, "utf8")) as { layout?: unknown }
      if (parsed.layout && typeof parsed.layout === "object") return parsed.layout
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    return { preset: "C" }
  }
}

export class CoreSocketError extends Error {
  constructor(
    readonly code: "CORE_SOCKET_PATH_TOO_LONG",
    message: string,
  ) {
    super(message)
    this.name = "CoreSocketError"
  }
}

function closing(error: RpcError): RpcError {
  error.closes = true
  return error
}

function errorBody(rpcCode: number, code: string, message: string): RpcErrorBody {
  return { code: rpcCode, message, data: { code } }
}

function requireString(params: Record<string, unknown>, field: string): string {
  const value = params[field]
  if (typeof value !== "string" || value.length === 0 || value.length > 128)
    throw invalidParams(`${field} must be a string.`)
  return value
}
