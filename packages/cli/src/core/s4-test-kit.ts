/**
 * BE-1680 (spec S4): a whole core on a real socket for the launch and transfer tests, built from
 * fixtures only: a fake API (the executor), a fake RPC (the transfer engine), a fake secret store
 * (the slot), a fixture vault and fake factor helpers. No staging write, no production call, no
 * real key and no real funds. Not a `*.test.ts` file itself, and imported by nothing that ships.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerCardHandlers } from "../commands/core"
import { toChecksumAddress } from "../evm-lite"
import { encodePubkey } from "../solana-lite"
import {
  CardBook,
  type ExecutionOutcome,
  type SignedTransfer,
  type TransferEngine,
  type TransferRef,
  type TransferStatus,
} from "./cards"
import type { CallAnswer, McpExecutor } from "./executor"
import { Journal, readJournal } from "./journal"
import { registerLaunchHandlers } from "./launch"
import { Redactor } from "./redact"
import { PROTOCOL_VERSION } from "./rpc"
import { CoreServer } from "./server"
import { connectTestClient, DEVICE_TOKEN, READ_KEY, type TestClient, WRITE_KEY } from "./test-fixtures"
import { TokenBook } from "./tokens"
import { registerToolFace } from "./tools-face"
import {
  type Factor,
  type FactorOption,
  FactorRejectedError,
  FactorUnavailableError,
  type OpenVault,
  TradingState,
  type VaultWallet,
} from "./trading"
import type { TransferChain, TransferParams } from "./transfer-params"
import { DestinationHistory, registerTransferHandlers, type ServerDestination } from "./transfers"

export const RIGHT = { type: "passphrase" as const, value: "the-right-passphrase-example" }
export const WRONG = { type: "passphrase" as const, value: "the-wrong-passphrase-example" }
export const PIN_OK = "246810"
export const PIN_WRONG = "000000"
/** A fake Withdraw key, Candle-shaped, so the redactor's shape rule would also catch it. */
export const WITHDRAW_KEY = `cndl_test_${"x".repeat(43)}`
export const WITHDRAW_PREFIX = "xxxxxxxx"

const pubkey = (fill: number) => encodePubkey(new Uint8Array(32).fill(fill))
export const VAULT_SOL = pubkey(11)
export const TEE_SOL = pubkey(12)
export const EMBEDDED_SOL = pubkey(13)
export const DEST_A = pubkey(21)
export const DEST_B = pubkey(22)
export const LINKED_SOL = pubkey(23)
export const VAULT_EVM = toChecksumAddress(`0x${"ab".repeat(20)}`)
export const EMBEDDED_EVM = toChecksumAddress(`0x${"cd".repeat(20)}`)
export const DEST_EVM = toChecksumAddress(`0x${"ef".repeat(20)}`)

export const WALLETS: VaultWallet[] = [
  { id: "k_vault", chain: "solana", address: VAULT_SOL, label: "main", role: "vault" },
  { id: "k_tee", chain: "solana", address: TEE_SOL, label: "promoted", role: "tee-wallet" },
  { id: "k_evm", chain: "evm", address: VAULT_EVM, label: "hood", role: "vault" },
]

export const DRY_RUN_PASS = {
  success: true,
  dryRun: true,
  launchWallet: EMBEDDED_SOL,
  feeWallet: pubkey(31),
  resolved: {
    chain: "solana",
    quoteAsset: "sol",
    mode: "open",
    stakerAllocationBps: 50,
    dexVersion: null,
    visibility: "production",
    buyAmount: "100000000",
  },
  checks: { image: "ok" },
  size: { bytes: 1100, limit: 1232 },
  matrixVersion: 3,
}

export interface KitOptions {
  /** The fake API's answer per tool call; the default passes a dry run and succeeds everything else. */
  api?: (tool: string, params: Record<string, unknown>) => ExecutionOutcome | Promise<ExecutionOutcome>
  factors?: FactorOption[]
  securityKeyAttached?: boolean
  serverDestinations?: ServerDestination[]
  /** Starts with the Withdraw key minted and sealed (transfers from the embedded wallet on). */
  embeddedOn?: boolean
  /** Sealing a Withdraw key throws (turning a key off still seals). */
  sealFails?: boolean
  /** Starts with the vault's wallets read (as after any unlock). */
  walletsListed?: boolean
}

export async function startKit(options: KitOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), "candle-s4-"))
  let now = Date.parse("2026-10-20T12:00:00Z")
  const clock = { now: () => now, advance: (ms: number) => (now += ms) }
  const redactor = new Redactor()
  for (const secret of [READ_KEY, WRITE_KEY, DEVICE_TOKEN]) redactor.add(secret)
  const journalPath = join(dir, "journal.jsonl")
  const journal = await Journal.open({
    path: journalPath,
    redactor,
    environment: "staging",
    profile: "staging",
    now: clock.now,
  })
  const tokens = await TokenBook.open(join(dir, "tokens.json"), clock.now)
  redactor.add(tokens.viewToken)

  // The fixture vault and the fake factor helpers.
  const helper: { type: string; reason?: string }[] = []
  const signingKeys: string[] = []
  const slot: { withdrawKey?: string; seals: (string | undefined)[] } = { seals: [] }
  /** Reads of the credentials a window or a paper window holds, once armed (T-W-1's spy). */
  const windowSpy = { armed: false, reads: 0 }
  const keyCalls: { op: string; deviceToken?: string; body?: unknown; prefix?: string }[] = []
  const vault = (): OpenVault => ({
    dek: new Uint8Array(32),
    file: { vaultId: "vault-fixture" },
    close() {},
    wallets: WALLETS.map((wallet) => ({ ...wallet })),
    async signingKey(walletId: string) {
      signingKeys.push(walletId)
      return new Uint8Array(64).fill(7)
    },
  })
  const trading = await TradingState.open({
    settingsPath: join(dir, "settings.json"),
    now: clock.now,
    slotExists: async () => true,
    async unlockVault(factor: Factor, reason?: string) {
      helper.push({ type: factor.type, ...(reason ? { reason } : {}) })
      if (factor.type === "passphrase") {
        if (factor.value !== RIGHT.value) throw new FactorRejectedError()
        return vault()
      }
      if (factor.type === "security-key") {
        if (options.securityKeyAttached === false) throw new FactorUnavailableError("no security key is attached.")
        if (factor.pin === PIN_WRONG) throw new FactorRejectedError()
        return vault()
      }
      throw new FactorUnavailableError("not in this build.")
    },
    listFactors: async () =>
      options.factors ?? [
        { type: "passphrase", usable: true },
        { type: "security-key", usable: true },
        { type: "touch-id", usable: false, reason: "not in this build" },
      ],
    openSlot: async () => {
      const credentials = { writeKey: WRITE_KEY, deviceToken: DEVICE_TOKEN }
      return new Proxy(credentials, {
        get(target, name) {
          if (windowSpy.armed && (name === "writeKey" || name === "deviceToken")) windowSpy.reads++
          return target[name as keyof typeof target]
        },
      })
    },
    openTransferSlot: async () => (slot.withdrawKey ? { withdrawKey: slot.withdrawKey } : {}),
    sealWithdrawKey: async (_vault, key) => {
      if (options.sealFails && key !== undefined) throw new Error("slot write failed")
      slot.withdrawKey = key
      slot.seals.push(key === undefined ? undefined : "sealed")
    },
    mintWithdrawKey: async (deviceToken, request) => {
      keyCalls.push({
        op: "mint",
        deviceToken,
        body: {
          scopes: "withdraw",
          txLimit: { usdMicros: request.limitUsdMicros, reset: request.reset },
          expiresInDays: request.expiresInDays,
        },
      })
      return {
        key: WITHDRAW_KEY,
        info: {
          prefix: WITHDRAW_PREFIX,
          limitUsdMicros: request.limitUsdMicros,
          reset: request.reset,
          expiresAt: new Date(clock.now() + request.expiresInDays * 86_400_000).toISOString(),
        },
      }
    },
    revokeWithdrawKey: async (deviceToken, prefix) => {
      keyCalls.push({ op: "revoke", deviceToken, prefix })
    },
    moveToSlot: async () => {},
    mintReadKey: async () => READ_KEY,
    remember: (credentials) => {
      for (const value of Object.values(credentials)) redactor.add(value as string)
    },
  })
  await trading.turnOn(RIGHT)
  if (options.walletsListed !== false) await trading.readVaultWallets(RIGHT)
  if (options.embeddedOn) await trading.turnOnEmbeddedTransfers({ limitUsdMicros: 100_000_000, reset: "daily" }, RIGHT)
  helper.length = 0
  keyCalls.length = 0

  // The fake API: every tool call, with the key it was sent under.
  const apiCalls: { tool: string; params: Record<string, unknown>; key: string }[] = []
  const answer = (tool: string, params: Record<string, unknown>): ExecutionOutcome | Promise<ExecutionOutcome> => {
    if (options.api) return options.api(tool, params)
    if ((tool === "candle_launch_token" || tool === "candle_launch_and_seed") && params.dryRun === true) {
      return { state: "succeeded", result: DRY_RUN_PASS }
    }
    return { state: "succeeded", result: { success: true } }
  }
  const executor: McpExecutor = {
    async execute(tool, params, key) {
      apiCalls.push({ tool, params, key })
      return answer(tool, params)
    },
    async call(tool, params, key): Promise<CallAnswer> {
      apiCalls.push({ tool, params, key })
      const outcome = await answer(tool, params)
      return {
        kind: "result",
        result: { content: [{ type: "text", text: JSON.stringify("result" in outcome ? outcome.result : outcome) }] },
      }
    },
  }

  // The fake RPC and the pending store, behind the engine interface.
  const history = new DestinationHistory({ path: join(dir, "destinations.json"), environment: "staging" })
  await history.rebuild(journal.rows())
  const chain = {
    signed: [] as SignedTransfer[],
    broadcasts: [] as { id: string; wire: string; journalAtSend: string }[],
    statuses: new Map<string, TransferStatus>(),
    pending: new Map<string, SignedTransfer>(),
    embedded: [] as { params: TransferParams; clientTransferId: string; key: string }[],
    embeddedOutcome: { state: "succeeded", result: { success: true, signature: "embsig" } } as ExecutionOutcome,
    broadcastAnswer: { ok: true } as Awaited<ReturnType<TransferEngine["broadcast"]>>,
    reports: [] as string[],
  }
  const engine: TransferEngine = {
    async signVault(params, opened) {
      const wallet = opened.wallets?.find((candidate) => candidate.id === params.source.walletId)
      if (!wallet || !opened.signingKey) throw Object.assign(new Error("no such wallet"), { code: "INVALID_SOURCE" })
      const secret = await opened.signingKey(wallet.id)
      secret.fill(0)
      const signed: SignedTransfer = {
        chain: params.chain,
        id: `sig${chain.signed.length + 1}`,
        wire: Buffer.from(`signed-bytes-${chain.signed.length + 1}`).toString("base64"),
        from: params.source.address,
        ...(params.chain === "solana" ? { blockhash: "blockhash-1" } : { nonce: "7" }),
        amountRaw: "max" in params.amount ? "999" : params.amount.raw,
      }
      chain.signed.push(signed)
      return signed
    },
    async keepPending(opId, signed) {
      chain.pending.set(opId, signed)
    },
    async readPending(opId) {
      return chain.pending.get(opId)
    },
    async dropPending(opId) {
      chain.pending.delete(opId)
    },
    async broadcast(signed) {
      chain.broadcasts.push({ id: signed.id, wire: signed.wire, journalAtSend: await readFile(journalPath, "utf8") })
      return chain.broadcastAnswer
    },
    async status(ref: TransferRef) {
      return chain.statuses.get(ref.id ?? "") ?? { state: "not_found", expired: false }
    },
    async sendEmbedded(params, clientTransferId, key) {
      chain.embedded.push({ params, clientTransferId, key })
      return chain.embeddedOutcome
    },
    async reportActivity(_params, ref) {
      chain.reports.push(ref.id ?? "")
    },
    async recordDestination(params) {
      await history.add(params.chain, params.to)
    },
  }

  const scheduled: { run: () => void; ms: number; cancelled: boolean }[] = []
  const server = new CoreServer({
    socketPath: join(dir, "core.sock"),
    layoutPath: join(dir, "config.json"),
    profile: "staging",
    environment: "staging",
    coreVersion: "0.0.0-test",
    journal,
    redactor,
    tokens,
    now: clock.now,
    tradingOn: () => trading.tradingOn(),
    proposalIsHeld: (params) => cards.holdsRequest(params),
  })
  const cards: CardBook = new CardBook({
    journal,
    events: server.events,
    trading,
    executor,
    environment: "staging",
    profile: "staging",
    now: clock.now,
    transfers: engine,
    schedule: (run, ms) => {
      const entry = { run, ms, cancelled: false }
      scheduled.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
  })
  registerCardHandlers(server, cards, trading, journal)
  registerToolFace(server, { cards, trading, executor, journal, readKey: () => READ_KEY })
  const uploads: { key: string; path: string }[] = []
  registerLaunchHandlers(server, {
    cards,
    trading,
    journal,
    readImage: async (path) => {
      if (path.endsWith(".svg")) throw Object.assign(new Error("not an image"), { code: "IMAGE_TYPE_UNSUPPORTED" })
      return { path, bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), contentType: "image/png" }
    },
    uploadImage: async (key, image) => {
      uploads.push({ key, path: image.path })
      return "https://images.example/pinned.png"
    },
  })
  registerTransferHandlers(server, {
    cards,
    trading,
    journal,
    history,
    reads: {
      embeddedWallets: async () => ({ solana: EMBEDDED_SOL, evm: EMBEDDED_EVM }),
      serverDestinations: async (on: TransferChain) =>
        (
          options.serverDestinations ?? [
            { chain: "solana", address: EMBEDDED_SOL, label: "Embedded wallet", serverClass: "own" },
            { chain: "solana", address: LINKED_SOL, label: "cold", serverClass: "linked" },
            { chain: "solana", address: DEST_A, label: "exchange", serverClass: "approved" },
          ]
        ).filter((row) => row.chain === on),
      balances: async (on) => [
        on === "solana"
          ? { asset: "SOL", contract: "So11111111111111111111111111111111111111112", raw: "2000000000", decimals: 9 }
          : { asset: "ETH", contract: "(native ETH)", raw: "1000000000000000000", decimals: 18 },
      ],
      decimals: async () => 6,
      previewVault: async (params) => ({
        lines: [`fee payer   ${params.source.address}`, `destination ${params.to}`],
        feeEstimate: "5000 lamports",
        ...("max" in params.amount ? { maxRaw: "1999995000" } : {}),
      }),
    },
  })
  await server.listen()
  cards.start()

  const clients: TestClient[] = []
  const hello = async (token: string, extra: Record<string, unknown> = {}) => {
    const client = await connectTestClient(join(dir, "core.sock"))
    clients.push(client)
    const response = await client.request("core.hello", {
      protocol: PROTOCOL_VERSION,
      token,
      clientName: "test",
      ...extra,
    })
    if (response.error) throw new Error(`hello failed: ${response.error.message}`)
    return client
  }
  const view = () => hello(tokens.viewToken)
  const harness = async (via: TestClient) => {
    const minted = (await via.request("harness.register", { name: "Claude Code" })).result as { token: string }
    return hello(minted.token, { harnessKind: "claude-code" })
  }
  const rows = async () => (await readJournal(journalPath)).rows
  const runScheduled = async () => {
    const due = scheduled.splice(0).filter((entry) => !entry.cancelled)
    for (const entry of due) entry.run()
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  return {
    dir,
    clock,
    journal,
    journalPath,
    rows,
    redactor,
    trading,
    cards,
    server,
    history,
    chain,
    apiCalls,
    helper,
    signingKeys,
    slot,
    windowSpy,
    keyCalls,
    uploads,
    scheduled,
    runScheduled,
    view,
    harness,
    async close() {
      for (const client of clients) client.close()
      cards.stop()
      await server.close()
      await journal.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

export type Kit = Awaited<ReturnType<typeof startKit>>

/** What a view sends to `transfer.prepare` for a plain SOL send from the vault key. */
export function vaultSend(to: string, extra: Partial<Record<string, unknown>> = {}) {
  return {
    params: {
      source: { kind: "vault", walletId: "k_vault", address: VAULT_SOL },
      chain: "solana",
      asset: { symbol: "SOL" },
      amount: { decimal: "1.5" },
      to,
      ...extra,
    },
  }
}

export function embeddedSend(to: string, extra: Partial<Record<string, unknown>> = {}) {
  return {
    params: {
      source: { kind: "embedded", address: EMBEDDED_SOL },
      chain: "solana",
      asset: { symbol: "SOL" },
      amount: { decimal: "0.25" },
      to,
      ...extra,
    },
  }
}
