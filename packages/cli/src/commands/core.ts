/**
 * `candle core serve` (BE-1665, spec 2026-10-19-candle-tui-s1-core-design.md, C-1 to C-4): the
 * local core, one process per profile, the only thing on this machine that holds the profile's
 * trading credentials once trading is on in the Candle TUI.
 *
 * The process and its state: the 0700 state directory, the single-instance lock
 * (`CORE_ALREADY_RUNNING`), the append-only journal with its redactor, completing a slot move a
 * crash interrupted, and the attach interface (`core/server.ts`, spec A) on `core.sock`. Cards,
 * reconciliation and the harness face arrive in the PRs stacked on this one.
 *
 * `--view-token-fd <n>` (A-2): the launcher (`candle tui`) passes an inherited descriptor; the core
 * writes this start's view token to it once and closes it. The token is never written to disk, so
 * a core started without that descriptor, by a harness for instance, has no view anyone can attach
 * as, and refuses every card with `NO_VIEW_ATTACHED` (C-3, K-11).
 * A-2 residual risk: the descriptor's caller is not authenticated. Any same-user process can
 * start the core with its own pipe, receive the token and attach as a view. `NO_VIEW_ATTACHED`
 * without the TUI therefore holds only by convention. That process can register harnesses and
 * disrupt view state, but approval and opening a timed window still require the vault factor.
 *
 * Cards (spec K) are wired here: `cards.*`, `operations.*` and `settings.set` (trading on and off,
 * the timed window) are registered on the server, with the slot functions passed in from this
 * file, the only one allowed to import `core/slot.ts`.
 *
 * Lifetime (C-3): the core exits on SIGINT or SIGTERM, and when the last attached view detaches:
 * open cards expire at once, and the exit waits for in-flight operations, at most ten minutes.
 *
 * This is the ONE file allowed to import `core/slot.ts`, the core-only credential loader (K-11).
 * It must not re-export anything from it; `core-slot-imports.test.ts` checks both.
 *
 * S4 (BE-1680) wires the launch flow (`launch.*`), transfers out (`transfer.*`, the transfer card
 * path in `cards.approve`, the chain engine), every vault factor this machine can use (the
 * passphrase, and a security key through `candle-fido2` with the PIN from the view), and the
 * Withdraw key: minted with the slot's device token, sealed in the slot, and returned only on the
 * transfer path (`openTransferSlot`); every other slot open drops it (`purpose: "trading"`).
 *
 * S5 (BE-1737) wires Quant (`quant.*`, view only, over the Read key alone), the one socket to the
 * public signal tape with its `signals` topic and the core-local `candle_get_signals`, and the
 * `quant` agent profile with its Off switch (`settings.set {path: "quant"}`).
 */
import { closeSync, writeSync } from "node:fs"
import { join } from "node:path"
import { scopesForPreset } from "../agent-key-access"
import { parseArgs } from "../args"
import { apiRequest } from "../client"
import { AgentProfiles } from "../core/agent-profiles"
import { type Card, CardBook } from "../core/cards"
import { coreLocalTools } from "../core/core-local-tools"
import { mcpExecutor } from "../core/executor"
import { CORE_HELPER_REASON, factorFailureKind, factorOptions } from "../core/factors"
import { acquireInstanceLock, CoreAlreadyRunningError } from "../core/instance-lock"
import { Journal, JournalIdentityError } from "../core/journal"
import { registerLaunchHandlers } from "../core/launch"
import { corePaths, ensureCoreDir } from "../core/paths"
import { QuantService, registerQuantHandlers } from "../core/quant"
import { Redactor } from "../core/redact"
import { refused } from "../core/rpc"
import { CoreServer, CoreSocketError } from "../core/server"
import { SignalService, tapeUrl, watchlistFrom, webSocketOpener } from "../core/signals"
import { finishCoreMove, moveProfileToCore, openCoreSlot, resealCoreSlot } from "../core/slot"
import { TokenBook } from "../core/tokens"
import { registerToolFace } from "../core/tools-face"
import {
  type Factor,
  FactorRejectedError,
  FactorUnavailableError,
  type KeyLimit,
  type OpenVault,
  parseFactor,
  TradingState,
  type VaultWallet,
  type WithdrawKeyInfo,
} from "../core/trading"
import { createTransferChain } from "../core/transfer-chain"
import type { TransferChain } from "../core/transfer-params"
import { DestinationHistory, registerTransferHandlers, type ServerDestination } from "../core/transfers"
import type { CommandContext } from "../deps"
import { createEvmRpc, DEFAULT_HOOD_RPC_URL, EVM_RPC_URL_ENV, resolveEvmRpcUrl } from "../evm-lite"
import { apiKeyPrefix, candleEnvironment, profileSecretRef } from "../profiles"
import { createQuantKeyClient } from "../quant"
import { writeLocalFailure, writeUsageFailure } from "../render"
import { resolveSolanaEndpoint, solanaClientFor } from "../solana-endpoint"
import { VaultError } from "../vault/errors"
import { assertHoodChain, assertWalletLockFree, readHoodTeeServer } from "../vault/evm-tee"
import { assertPrf, currentPlatformFacts, openSecurityKeySession } from "../vault/fido2"
import { isCtap2Envelope, type KeyEntry, parseVaultFile } from "../vault/format"
import { wipe } from "../vault/hygiene"
import {
  closeVault,
  decryptKey,
  defaultVaultPath,
  readVaultRaw,
  type UnlockedVault,
  unlockVault,
  unlockWithPassphrase,
} from "../vault/store"
import { assertNoPendingSweep, reportTransferActivity } from "../vault/tee-transfer"
import { CLI_VERSION } from "../version"
import { readLocalImage, uploadImage } from "./image"

const USAGE = "Usage: candle core serve [--view-token-fd <n>]"

export async function coreServe(args: string[], ctx: CommandContext): Promise<number> {
  const { deps, json } = ctx
  const parsed = parseArgs(args, { valueFlags: ["--view-token-fd"] })
  if ("error" in parsed) {
    writeUsageFailure(deps, parsed.error, json)
    return 2
  }
  if (parsed.positionals.length > 0) {
    writeUsageFailure(deps, `Unexpected argument: ${parsed.positionals[0]}\n${USAGE}`, json)
    return 2
  }
  const fdFlag = parsed.values["--view-token-fd"]
  const viewTokenFd = fdFlag === undefined ? undefined : Number(fdFlag)
  if (viewTokenFd !== undefined && (!Number.isInteger(viewTokenFd) || viewTokenFd < 3)) {
    writeUsageFailure(deps, `--view-token-fd takes a descriptor number of 3 or more, not ${fdFlag}\n${USAGE}`, json)
    return 2
  }
  const profile = ctx.profile
  if (profile === undefined) {
    writeLocalFailure(
      deps,
      {
        code: "CORE_PROFILE_REQUIRED",
        message: "The Candle core runs for one profile, and none is in play.",
        suggestion: "Sign in with candle auth login, or name one with --profile.",
      },
      json,
    )
    return 1
  }
  // C-2: the core is bound to one environment for its life, shown on every screen and stored on
  // every journal row. A host that is neither is refused rather than labelled with a guess.
  const environment = candleEnvironment(ctx.apiUrl)
  if (environment === undefined) {
    writeLocalFailure(
      deps,
      {
        code: "CORE_ENVIRONMENT_UNKNOWN",
        message: `The Candle core runs against staging or production, and ${ctx.apiUrl} is neither.`,
        suggestion: "Use a profile whose API URL is https://staging.api.candle.tv or https://api.candle.tv.",
      },
      json,
    )
    return 1
  }

  const paths = corePaths(deps.env, deps.homedir(), profile)
  await ensureCoreDir(paths)
  let lock: Awaited<ReturnType<typeof acquireInstanceLock>>
  try {
    lock = await acquireInstanceLock({ lockPath: paths.lock, socketPath: paths.socket, now: deps.now })
  } catch (error) {
    if (!(error instanceof CoreAlreadyRunningError)) throw error
    writeLocalFailure(
      deps,
      {
        code: error.code,
        message: error.message,
        details: { socketPath: error.socketPath, ...(error.pid !== undefined ? { pid: error.pid } : {}) },
      },
      json,
    )
    return 1
  }

  let journal: Journal | undefined
  let server: CoreServer | undefined
  let cardBook: CardBook | undefined
  let quant: QuantService | undefined
  let signals: SignalService | undefined
  let stopReason = "start_failed"
  try {
    const redactor = new Redactor()
    // C-4: the Read key is loaded at start and used for every read. Registered with the redactor
    // first, so no row this core writes can carry it.
    // A store that cannot be opened here (no keychain, no CANDLE_KEYRING_PASSPHRASE) leaves the
    // core without a Read key, not without a start: keyless reads and the first-run screen still work.
    const readPlainKey = () => deps.store.get(profileSecretRef(profile, "apiKey")).catch(() => null)
    let readKey = (await readPlainKey()) ?? undefined
    redactor.add(readKey)
    try {
      journal = await Journal.open({ path: paths.journal, redactor, environment, profile, now: deps.now })
    } catch (error) {
      if (!(error instanceof JournalIdentityError)) throw error
      writeLocalFailure(deps, { code: error.code, message: error.message }, json)
      return 1
    }
    const removed = await finishCoreMove({ deps, paths, profile }).catch(() => [] as string[])
    if (removed.length > 0) await journal.append({ type: "slot.move_finished", refs: removed })
    const tokens = await TokenBook.open(paths.tokens, deps.now)
    redactor.add(tokens.viewToken)
    const vaultPath = defaultVaultPath(deps.env, deps.homedir())
    const requireVault = async () => {
      const raw = await readVaultRaw(vaultPath)
      if (raw === null)
        throw refused("VAULT_REQUIRED", "Trading from the TUI needs a vault on this machine. Run candle vault init.")
      return raw
    }
    /** S4 F-1: a security key through `candle-fido2`, the PIN from the view; the touch is on the key. */
    const unlockWithSecurityKey = async (raw: string, pin: string | undefined, reason: string) => {
      const file = parseVaultFile(raw)
      const envelope = file.envelopes.find(isCtap2Envelope)
      if (envelope === undefined) throw new FactorUnavailableError("no security key is enrolled in this vault.")
      const sessionDeps = { ...deps, promptSecret: async () => pin ?? "" }
      try {
        const session = await openSecurityKeySession(sessionDeps, {
          vaultId: file.vaultId,
          envelopeId: envelope.id,
          requireFeatures: false,
        })
        const prfOutput = await assertPrf(sessionDeps, session, envelope, file.vaultId, reason)
        try {
          return await unlockVault(vaultPath, raw, { factor: "passkey-prf", envelopeId: envelope.id, prfOutput })
        } finally {
          wipe(prfOutput)
        }
      } catch (error) {
        if (error instanceof VaultError) {
          const kind = factorFailureKind(error.code)
          if (kind === "rejected") throw new FactorRejectedError()
          if (kind === "unavailable") throw new FactorUnavailableError(error.message)
        }
        throw error
      }
    }
    /** What the trading state may see of an unlocked vault: the DEK, the wallets' public facts, and a decrypter. */
    const openVaultOf = (vault: UnlockedVault): OpenVault & { entry(id: string): KeyEntry | undefined } => ({
      dek: vault.dek,
      file: vault.file,
      close: () => closeVault(vault),
      wallets: vault.index.entries
        .filter((entry) => entry.role === "vault" || entry.role === "tee-wallet")
        .map(
          (entry): VaultWallet => ({
            id: entry.id,
            chain: entry.chain,
            address: entry.address,
            label: entry.label,
            role: entry.role as VaultWallet["role"],
          }),
        ),
      signingKey: (walletId) => decryptKey(vault, walletId),
      entry: (walletId) => vault.index.entries.find((entry) => entry.id === walletId),
    })
    const withdrawScopes = scopesForPreset("readwritetransfer")
    const trading = await TradingState.open({
      settingsPath: join(paths.dir, "settings.json"),
      now: deps.now,
      slotExists: async () => (await import("../core/ownership")).slotExists(paths),
      async unlockVault(factor: Factor, reason?: string) {
        const raw = await requireVault()
        if (factor.type === "security-key") {
          return openVaultOf(await unlockWithSecurityKey(raw, factor.pin, reason ?? "unlock the vault"))
        }
        // F-3 and D-E default A: Touch ID and the synced passkey wait on S1's V-2.
        if (factor.type !== "passphrase") throw new FactorUnavailableError(CORE_HELPER_REASON)
        try {
          return openVaultOf(await unlockWithPassphrase(vaultPath, raw, factor.value))
        } catch (error) {
          if (error instanceof VaultError && error.code === "VAULT_UNLOCK_FAILED") throw new FactorRejectedError()
          throw error
        }
      },
      async listFactors() {
        const raw = await readVaultRaw(vaultPath)
        if (raw === null) return [{ type: "passphrase" as const, usable: true }]
        return factorOptions(parseVaultFile(raw).envelopes, await currentPlatformFacts(deps))
      },
      // W-3: every non-transfer open drops the Withdraw key inside the loader.
      openSlot: async (vault) => {
        const contents = await openCoreSlot({ paths, vault, profile, environment, purpose: "trading" })
        for (const signer of contents.signers) redactor.add(signer.value)
        return { writeKey: contents.writeKey, deviceToken: contents.deviceToken }
      },
      openTransferSlot: async (vault) => {
        const contents = await openCoreSlot({ paths, vault, profile, environment, purpose: "transfer" })
        for (const signer of contents.signers) redactor.add(signer.value)
        redactor.add(contents.deviceToken)
        redactor.add(contents.writeKey)
        redactor.add(contents.withdrawKey)
        return contents.withdrawKey !== undefined ? { withdrawKey: contents.withdrawKey } : {}
      },
      sealWithdrawKey: async (vault, withdrawKey) => {
        await resealCoreSlot({ paths, vault, profile, environment, withdrawKey, now: deps.now })
      },
      // W-2 with V-S4-5's body: the Withdraw preset, the limit, an expiry in days, the embedded wallet allowed.
      mintWithdrawKey: async (deviceToken, request) => {
        redactor.add(deviceToken)
        const result = await apiRequest("/api/v1/agent/keys", {
          method: "POST",
          auth: "device",
          credentials: { deviceToken },
          apiUrl: ctx.apiUrl,
          fetch: deps.fetch,
          env: deps.env,
          body: {
            scopes: withdrawScopes,
            label: "Candle TUI (withdraw)",
            expiresInDays: request.expiresInDays,
            txLimit: { usdMicros: request.limitUsdMicros, reset: request.reset },
            embeddedWallet: "allowed",
          },
        })
        const body = (result.ok ? result.body : {}) as { key?: unknown; keyPrefix?: unknown; expiresAt?: unknown }
        if (typeof body.key !== "string") {
          throw refused(
            "WITHDRAW_KEY_NOT_MINTED",
            `The Withdraw key could not be created${result.ok ? "" : `: ${result.message}`}. Nothing changed.`,
          )
        }
        redactor.add(body.key)
        const info: WithdrawKeyInfo = {
          prefix: typeof body.keyPrefix === "string" ? body.keyPrefix : (apiKeyPrefix(body.key) ?? ""),
          limitUsdMicros: request.limitUsdMicros,
          reset: request.reset,
          expiresAt: typeof body.expiresAt === "number" ? new Date(body.expiresAt).toISOString() : null,
        }
        return { key: body.key, info }
      },
      revokeWithdrawKey: async (deviceToken, prefix) => {
        const result = await apiRequest(`/api/v1/agent/keys/${encodeURIComponent(prefix)}`, {
          method: "DELETE",
          auth: "device",
          credentials: { deviceToken },
          apiUrl: ctx.apiUrl,
          fetch: deps.fetch,
          env: deps.env,
        })
        // A key the server no longer knows is already gone; anything else keeps the slot as it is.
        if (!result.ok && result.code !== "VALIDATION_FAILED") {
          throw refused("WITHDRAW_KEY_NOT_REVOKED", `The Withdraw key could not be revoked: ${result.message}`)
        }
      },
      moveToSlot: async (vault, readKey) => {
        await moveProfileToCore({ deps, paths, profile, environment, vault, readKey, now: deps.now })
      },
      mintReadKey: async () => {
        const deviceToken = await deps.store.get(profileSecretRef(profile, "deviceToken"))
        if (!deviceToken)
          throw refused("NO_DEVICE_TOKEN", "This profile has no device token. Sign in with candle auth login.")
        redactor.add(deviceToken)
        const result = await apiRequest("/api/v1/agent/keys", {
          method: "POST",
          auth: "device",
          credentials: { deviceToken },
          apiUrl: ctx.apiUrl,
          fetch: deps.fetch,
          env: deps.env,
          body: { scopes: ["account:read"], label: "Candle TUI (read)", embeddedWallet: "denied" },
        })
        const key = result.ok ? (result.body as { key?: unknown }).key : undefined
        if (typeof key !== "string") {
          throw refused(
            "READ_KEY_NOT_MINTED",
            `The Read key for the TUI could not be created${result.ok ? "" : `: ${result.message}`}. Nothing moved.`,
          )
        }
        redactor.add(key)
        return key
      },
      remember: (credentials) => {
        if ("withdrawKey" in credentials) redactor.add(credentials.withdrawKey)
        else {
          redactor.add(credentials.writeKey)
          redactor.add(credentials.deviceToken)
        }
      },
      // K-5: the Write key's limit and this window's use, from the owner's key list.
      readKeyLimit: async (credentials) => {
        const result = await apiRequest("/api/v1/agent/keys", {
          method: "GET",
          auth: "device",
          credentials: { deviceToken: credentials.deviceToken },
          apiUrl: ctx.apiUrl,
          fetch: deps.fetch,
          env: deps.env,
        })
        if (!result.ok) return undefined
        return keyLimitOf((result.body as { keys?: unknown }).keys, apiKeyPrefix(credentials.writeKey), deps.now())
      },
    })
    server = new CoreServer({
      socketPath: paths.socket,
      layoutPath: join(paths.dir, "config.json"),
      profile,
      environment,
      coreVersion: CLI_VERSION,
      journal,
      redactor,
      tokens,
      now: deps.now,
      tradingOn: () => trading.tradingOn(),
      proposalIsHeld: (params) => cardBook?.holdsRequest(params) ?? false,
    })
    const attached = server
    const executor = mcpExecutor({ apiUrl: ctx.apiUrl, fetch: deps.fetch })
    // S4 T-3: the display-only history, rebuilt from the journal before anyone attaches.
    const history = new DestinationHistory({ path: join(paths.dir, "destinations.json"), environment })
    await history.rebuild(journal.rows())
    const chain = await transferChainFor(ctx, paths.dir, executor, history, () => readKey)
    const cards = new CardBook({
      journal,
      events: server.events,
      trading,
      executor,
      environment,
      profile,
      now: deps.now,
      transfers: chain,
    })
    cardBook = cards
    const agentProfiles = await AgentProfiles.open(join(paths.dir, "agents.json"))
    if (agentProfiles.refusedWith !== undefined)
      await journal.append({ type: "agents.refused", code: agentProfiles.refusedWith })
    registerCardHandlers(server, cards, trading, journal, agentProfiles)
    const read = async (path: string) => {
      const key = readKey
      if (key === undefined) return undefined
      const result = await apiRequest(path, {
        method: "GET",
        auth: "key",
        credentials: { apiKey: key },
        apiUrl: ctx.apiUrl,
        fetch: deps.fetch,
        env: deps.env,
      })
      return result.ok ? (result.body as Record<string, unknown>) : undefined
    }
    // S5 G-1: one socket to the public tape, opened on demand; the watchlist through the Read key.
    const tape = new SignalService({
      open: deps.openTape ?? webSocketOpener(),
      url: tapeUrl(ctx.apiUrl),
      events: server.events,
      readWatchlist: async () => watchlistFrom(await read("/api/v1/agent/tracked-wallets")),
    })
    signals = tape
    server.events.provideSnapshot("signals", () => tape.snapshotAll())
    server.events.provideSnapshot("signals:mine", () => tape.snapshotMine())
    const events = server.events
    events.onSubscriptionsChanged(() =>
      tape.setSubscribers(events.subscriberCount("signals"), events.subscriberCount("signals:mine")),
    )
    // S5 Q-1: Quant over the Read key alone. No path here reaches the Write key, the slot or the vault.
    quant = new QuantService({
      client: () =>
        readKey === undefined
          ? undefined
          : createQuantKeyClient({ apiUrl: ctx.apiUrl, apiKey: readKey, fetch: deps.fetch }),
      redact: (text) => redactor.text(text),
      events: server.events,
      now: deps.now,
      quantOn: () => agentProfiles.quantOn(),
    })
    registerQuantHandlers(server, quant)
    registerToolFace(server, {
      cards,
      trading,
      executor,
      journal,
      readKey: () => readKey,
      coreLocal: coreLocalTools(tape),
    })
    registerLaunchHandlers(server, {
      cards,
      trading,
      journal,
      readImage: (path) => readLocalImage(path),
      uploadImage: (writeKey, image) => uploadImage(ctx, writeKey, image),
    })
    registerTransferHandlers(server, {
      cards,
      trading,
      journal,
      history,
      reads: {
        embeddedWallets: async () => {
          const body = await read("/api/v1/agent/wallets/embedded")
          const wallets = body?.wallets as { solana?: { address?: unknown } | null; evm?: { address?: unknown } | null }
          const address = (wallet: { address?: unknown } | null | undefined) =>
            typeof wallet?.address === "string" ? wallet.address : undefined
          const solana = address(wallets?.solana)
          const evm = address(wallets?.evm)
          return body ? { ...(solana ? { solana } : {}), ...(evm ? { evm } : {}) } : undefined
        },
        serverDestinations: (on) => serverDestinations(on, read),
        balances: (on, address) => chain.balances(on, address),
        decimals: (on, asset) => chain.decimals(on, asset),
        previewVault: (params, wallet) => chain.preview(params, wallet),
      },
    })
    // Turning trading on replaces the plain key with the minted Read key (K-11).
    trading.onChange(() => {
      void readPlainKey().then((key) => {
        readKey = key ?? undefined
        redactor.add(readKey)
      })
    })
    trading.onChange(() => attached.events.publish("status", { ...attached.status(), ...trading.snapshot() }))
    server.onClientKilled((client) => void cards.withdrawAllFor(client.clientId))
    server.onViewCount((count) => {
      trading.viewsAttached(
        new Set(
          attached
            .clients()
            .filter((c) => c.role === "view")
            .map((c) => c.clientId),
        ),
      )
      if (count === 0) void cards.expireAllOpen("last_view_detached")
    })
    // R-2: reconciliation runs before the socket accepts anyone. Copied first, because rebuilding
    // appends rows of its own.
    const rebuilt = await cards.rebuild([...journal.rows()])
    cards.start()
    try {
      await server.listen()
    } catch (error) {
      if (!(error instanceof CoreSocketError)) throw error
      writeLocalFailure(deps, { code: error.code, message: error.message }, json)
      return 1
    }
    if (viewTokenFd !== undefined) {
      try {
        writeSync(viewTokenFd, `${tokens.viewToken}\n`)
        closeSync(viewTokenFd)
      } catch {
        writeLocalFailure(
          deps,
          { code: "CORE_VIEW_TOKEN_FD", message: `Could not write the view token to descriptor ${viewTokenFd}.` },
          json,
        )
        return 1
      }
    }
    // Q-4 and T-20: a turn already active (a web tab's, or one from before a restart) is followed.
    void quant.start()
    const started = await journal.append({
      type: "core.started",
      readKey: readKey !== undefined,
      coreVersion: CLI_VERSION,
      pid: process.pid,
      viewTokenHandedOff: viewTokenFd !== undefined,
      rebuilt,
    })

    if (json) {
      deps.stdout.write(
        `${JSON.stringify({ ok: true, profile, environment, stateDir: paths.dir, socket: paths.socket, journalSeq: started.seq })}\n`,
      )
    } else {
      deps.stdout.write(
        `Candle core (preview) for profile ${profile} on ${environment === "production" ? "PRODUCTION: real funds" : "staging"}\nState: ${paths.dir}\nSocket: ${paths.socket}\n`,
      )
    }

    // Runs until SIGINT or SIGTERM, or until the last view that attached detaches (C-3). Without a
    // terminate seam (a test that omits it) only the second ends it.
    const running = server
    await new Promise<void>((resolve) => {
      let unsubscribe: (() => void) | undefined
      let done = false
      const finish = (reason: string) => {
        if (done) return
        done = true
        stopReason = reason
        unsubscribe?.()
        resolve()
      }
      running.onViewCount((count) => {
        if (count !== 0 || !running.hadView()) return
        // C-3: wait for operations still in flight, bounded at ten minutes, then exit.
        const deadline = deps.now() + 10 * 60_000
        const poll = () => {
          if (running.viewCount() > 0) return
          if (!cards.inFlight() || deps.now() >= deadline) finish("last_view_detached")
          else setTimeout(poll, 1000).unref?.()
        }
        poll()
      })
      unsubscribe = deps.onTerminate?.(() => finish("terminated"))
      if (done) unsubscribe?.()
    })
    return 0
  } finally {
    quant?.stop()
    signals?.stop()
    cardBook?.stop()
    await server?.close()
    if (journal) {
      await journal.append({ type: "core.stopped", reason: stopReason }).catch(() => {})
      await journal.close()
    }
    await lock.release()
  }
}

/** Registers spec K's methods on the attach interface. The role table has already run. */
export function registerCardHandlers(
  server: CoreServer,
  cards: CardBook,
  trading: TradingState,
  journal: Journal,
  agents?: AgentProfiles,
): void {
  const own = (access: string) => access === "own"
  server.handle("cards.propose", async (params, { client }) =>
    cards.propose(params, {
      clientId: client.clientId,
      role: client.role,
      clientName: client.clientName,
      ...(client.harnessKind !== undefined ? { harnessKind: client.harnessKind } : {}),
    }),
  )
  server.handle("cards.list", async (_params, { client, access }) => ({
    cards: cards.list(client.clientId, own(access)),
  }))
  server.handle("cards.get", async (params, { client, access }) =>
    cards.get(params.cardId, client.clientId, own(access)),
  )
  server.handle("cards.approve", async (params, { client }) =>
    cards.approve(
      {
        cardId: params.cardId,
        cardHash: params.cardHash,
        factor: parseFactor(params.factor),
        // S4 T-5: a transfer's typed `confirm`, checked before the factor.
        confirm: params.confirm,
      },
      client.clientId,
    ),
  )
  server.handle(
    "cards.reject",
    async (params, { client }): Promise<Card> => cards.reject(params.cardId, client.clientId),
  )
  server.handle("cards.withdraw", async (params, { client }) => cards.withdraw(params.cardId, client.clientId))
  server.handle("operations.list", async (_params, { client, access }) => ({
    operations: cards.operationsFor(client.clientId, own(access)),
  }))
  server.handle("operations.get", async (params, { client, access }) =>
    cards.operation(params.opId, client.clientId, own(access)),
  )
  // R-3: the user resolves an operation the core could not confirm. A view only (the role table).
  server.handle("operations.resolve", async (params, { client }) =>
    cards.resolve({ opId: params.opId, action: params.action, factor: parseFactor(params.factor) }, client.clientId),
  )
  // S4 F-1: the factor picker's list rides with the settings, usable first.
  // S5 P-2: the agent profiles (Quant's Off switch) ride with the settings too.
  const agentSettings = () =>
    agents ? { agents: agents.list(), ...(agents.refusedWith ? { agentsRefused: agents.refusedWith } : {}) } : {}
  server.handle("settings.get", async () => ({
    ...trading.snapshot(),
    factors: await trading.factors(),
    ...agentSettings(),
  }))
  // S-9 and K-6. The approval policy is "Ask me" and not settable in S1 (K-9).
  server.handle("settings.set", async (params, { client }) => {
    const factor = parseFactor(params.factor)
    if (params.path === "trading") {
      if (params.value === true) await trading.turnOn(factor)
      else if (params.value === false) await trading.turnOff()
      else throw refused("INVALID_SETTING", "trading takes true or false.")
    } else if (params.path === "window") {
      if (params.value === false) trading.closeWindow()
      else {
        const minutes = (params.value as { minutes?: unknown } | null)?.minutes
        if (typeof minutes !== "number") throw refused("INVALID_SETTING", "window takes {minutes} or false.")
        await trading.openWindow(client.clientId, minutes, factor)
      }
    } else if (params.path === "paperWindow") {
      if (params.value === false) trading.closePaperWindow()
      else {
        const minutes = (params.value as { minutes?: unknown } | null)?.minutes
        if (typeof minutes !== "number") throw refused("INVALID_SETTING", "paperWindow takes {minutes} or false.")
        await trading.openPaperWindow(client.clientId, minutes, factor)
      }
    } else if (params.path === "withdraw") {
      // S4 W-2: transfers from the embedded wallet. Both directions take a fresh factor.
      if (params.value === false) {
        const off = await trading.turnOffEmbeddedTransfers(factor)
        await journal.append({
          type: "withdraw_key.revoked",
          clientId: client.clientId,
          prefix: off.revokedPrefix ?? null,
        })
      } else {
        const value = params.value as { limitUsd?: unknown; reset?: unknown } | null
        const usd = typeof value?.limitUsd === "number" ? value.limitUsd : Number.NaN
        const reset = value?.reset ?? "daily"
        if (!Number.isFinite(usd) || usd <= 0)
          throw refused("INVALID_SETTING", "withdraw takes {limitUsd} above zero, or false.")
        if (reset !== "daily" && reset !== "weekly" && reset !== "monthly" && reset !== "never")
          throw refused("INVALID_SETTING", "reset is daily, weekly, monthly or never.")
        const info = await trading.turnOnEmbeddedTransfers(
          { limitUsdMicros: Math.round(usd * 1_000_000), reset },
          factor,
        )
        await journal.append({
          type: "withdraw_key.minted",
          clientId: client.clientId,
          prefix: info.prefix,
          limitUsdMicros: info.limitUsdMicros,
          reset: info.reset,
          expiresAt: info.expiresAt,
        })
      }
    } else if (params.path === "quant") {
      // S5 P-2: the Agents tab's Off switch. Needs no factor: it only hides Quant.
      if (typeof params.value !== "boolean" || agents === undefined)
        throw refused("INVALID_SETTING", "quant takes true or false.")
      await agents.setQuantOn(params.value)
      await journal.append({ type: "agents.quant", clientId: client.clientId, on: params.value })
    } else if (params.path === "approvalPolicy") {
      throw refused("POLICY_FIXED", "The approval policy is Ask me (every live action) in this version.")
    } else {
      throw refused("INVALID_SETTING", "Settable paths: trading, window, paperWindow, withdraw, quant.")
    }
    return { ...trading.snapshot(), factors: await trading.factors(), ...agentSettings() }
  })
}

/**
 * S4 T-3: what the server accepts from the embedded wallet on `chain`, from the three lists a key
 * can read (V-S4-5): the account's own embedded wallets, its linked wallets that were added in a
 * session or marked trusted, and the withdrawal allowlist. Privy-verified EVM addresses also count
 * as own on the server but are in none of these, which is why an unlisted Hood address is shown as
 * `unlisted` rather than refused.
 */
async function serverDestinations(
  chain: TransferChain,
  read: (path: string) => Promise<Record<string, unknown> | undefined>,
): Promise<ServerDestination[]> {
  const out: ServerDestination[] = []
  const own = (await read("/api/v1/agent/wallets/embedded"))?.wallets as Record<string, { address?: unknown } | null>
  const ownAddress = own?.[chain === "hood" ? "evm" : "solana"]?.address
  if (typeof ownAddress === "string")
    out.push({ chain, address: ownAddress, label: "Embedded wallet", serverClass: "own" })
  let cursor: string | undefined
  for (let page = 0; page < 10; page++) {
    const body = await read(`/api/v1/agent/wallets?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
    const rows = Array.isArray(body?.page) ? (body.page as Record<string, unknown>[]) : []
    for (const row of rows) {
      if (row.revokedAt || typeof row.address !== "string") continue
      if ((row.chain === "evm" ? "hood" : row.chain) !== chain) continue
      const trusted = row.addedVia === "session" || typeof row.trustedAt === "number"
      if (!trusted) continue
      out.push({
        chain,
        address: row.address,
        ...(typeof row.label === "string" ? { label: row.label } : {}),
        serverClass: "linked",
      })
    }
    if (body?.isDone !== false || typeof body.continueCursor !== "string") break
    cursor = body.continueCursor
  }
  const allow = (await read("/api/v1/agent/withdrawal-addresses"))?.addresses
  for (const row of Array.isArray(allow) ? (allow as Record<string, unknown>[]) : []) {
    if (row.revokedAt || row.chain !== chain || typeof row.address !== "string") continue
    out.push({
      chain,
      address: row.address,
      ...(typeof row.label === "string" ? { label: row.label } : {}),
      serverClass: "approved",
    })
  }
  return out
}

/** S4 T-7: the chain engine over this profile's Solana endpoint and the Hood RPC, as `vault transfer` resolves them. */
async function transferChainFor(
  ctx: CommandContext,
  stateDir: string,
  executor: ReturnType<typeof mcpExecutor>,
  history: DestinationHistory,
  readKey: () => string | undefined,
) {
  const config = await ctx.deps.readConfig()
  const evm = resolveEvmRpcUrl(undefined, ctx.deps.env[EVM_RPC_URL_ENV], "--rpc-url")
  const evmUrl = "error" in evm ? DEFAULT_HOOD_RPC_URL : evm.url
  const hood = { rpc: createEvmRpc(evmUrl, ctx.deps.fetch), builtIn: "error" in evm ? true : evm.builtIn }
  return createTransferChain({
    solana: () => {
      const endpoint = resolveSolanaEndpoint(ctx, undefined, config)
      if ("error" in endpoint) throw refused("RPC_URL_INVALID", endpoint.error)
      return solanaClientFor(ctx, endpoint)
    },
    hood,
    executor,
    pendingDir: join(stateDir, "pending"),
    // A promoted wallet's checks, as `vault transfer` runs them before signing.
    teeChecks: async (entry) => {
      assertNoPendingSweep(entry)
      if (entry.chain === "evm") {
        await assertHoodChain({ rpc: hood.rpc, url: evmUrl, host: new URL(evmUrl).host, builtIn: hood.builtIn })
        assertWalletLockFree(entry, (await readHoodTeeServer(ctx, entry)).lock, ctx.deps.now())
      }
    },
    // As the CLI does, with this profile's plain key, best effort; on a core-owned profile that is
    // the Read key, which the server may refuse for want of `activity:write`.
    reportActivity: async (on, id) => {
      await reportTransferActivity(ctx, readKey(), id, on)
    },
    recordDestination: (on, address) => history.add(on, address),
  })
}

/**
 * The limit and window use of the key whose prefix is given, from `GET /agent/keys`'s rows.
 *
 * `used` is the row's Ember window reservation when it has one (BE-1749 item 5): that is the same
 * figure every cap check admits against, while `usage.todayUsdMicros` and siblings count only
 * booked swap, launch and transfer volume — a perps order reserves the window and never writes a
 * usage row, so the two can disagree, and only the window is the cap. The `usage` fields stay the
 * fallback for an API whose rows carry no `emberWindow` (BE-422) or a key with no window open.
 */
export function keyLimitOf(keys: unknown, prefix: string | undefined, now: number): KeyLimit | undefined {
  if (!Array.isArray(keys) || prefix === undefined) return undefined
  const row = keys.find((key) => (key as { keyPrefix?: unknown })?.keyPrefix === prefix) as
    | {
        txLimit?: { usdMicros?: unknown; reset?: unknown } | null
        usage?: Record<string, unknown>
        emberWindow?: { reservedUsdMicros?: unknown } | null
      }
    | undefined
  const limit = row?.txLimit
  if (!limit || typeof limit.usdMicros !== "number") return undefined
  const reset = limit.reset === "weekly" || limit.reset === "monthly" || limit.reset === "never" ? limit.reset : "daily"
  const reserved = row?.emberWindow?.reservedUsdMicros
  if (typeof reserved === "number") return { usdMicros: limit.usdMicros, reset, usedUsdMicros: reserved, readAt: now }
  const field = {
    daily: "todayUsdMicros",
    weekly: "weekUsdMicros",
    monthly: "monthUsdMicros",
    never: "lifetimeUsdMicros",
  }[reset]
  const used = row?.usage?.[field]
  return { usdMicros: limit.usdMicros, reset, usedUsdMicros: typeof used === "number" ? used : 0, readAt: now }
}
