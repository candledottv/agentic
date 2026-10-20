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
 */
import { closeSync, writeSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "../args"
import { apiRequest } from "../client"
import { type Card, CardBook } from "../core/cards"
import { mcpExecutor } from "../core/executor"
import { acquireInstanceLock, CoreAlreadyRunningError } from "../core/instance-lock"
import { Journal, JournalIdentityError } from "../core/journal"
import { corePaths, ensureCoreDir } from "../core/paths"
import { Redactor } from "../core/redact"
import { refused } from "../core/rpc"
import { CoreServer, CoreSocketError } from "../core/server"
import { finishCoreMove, moveProfileToCore, openCoreSlot } from "../core/slot"
import { TokenBook } from "../core/tokens"
import { registerToolFace } from "../core/tools-face"
import { FactorRejectedError, type OpenVault, parseFactor, TradingState } from "../core/trading"
import type { CommandContext } from "../deps"
import { candleEnvironment, profileSecretRef } from "../profiles"
import { writeLocalFailure, writeUsageFailure } from "../render"
import { VaultError } from "../vault/errors"
import { closeVault, defaultVaultPath, readVaultRaw, unlockWithPassphrase } from "../vault/store"
import { CLI_VERSION } from "../version"

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
  let stopReason = "start_failed"
  try {
    const redactor = new Redactor()
    // C-4: the Read key is loaded at start and used for every read. Registered with the redactor
    // first, so no row this core writes can carry it.
    let readKey = (await deps.store.get(profileSecretRef(profile, "apiKey"))) ?? undefined
    redactor.add(readKey)
    try {
      journal = await Journal.open({ path: paths.journal, redactor, environment, profile, now: deps.now })
    } catch (error) {
      if (!(error instanceof JournalIdentityError)) throw error
      writeLocalFailure(deps, { code: error.code, message: error.message }, json)
      return 1
    }
    const removed = await finishCoreMove({ deps, paths, profile })
    if (removed.length > 0) await journal.append({ type: "slot.move_finished", refs: removed })
    const tokens = await TokenBook.open(paths.tokens, deps.now)
    redactor.add(tokens.viewToken)
    const trading = await TradingState.open({
      settingsPath: join(paths.dir, "settings.json"),
      now: deps.now,
      slotExists: async () => (await import("../core/ownership")).slotExists(paths),
      async unlockVault(factor) {
        if (factor.type !== "passphrase") throw refused("FACTOR_NOT_IN_THIS_BUILD", "Use the passphrase.")
        const path = defaultVaultPath(deps.env, deps.homedir())
        const raw = await readVaultRaw(path)
        if (raw === null)
          throw refused("VAULT_REQUIRED", "Trading from the TUI needs a vault on this machine. Run candle vault init.")
        try {
          const vault = await unlockWithPassphrase(path, raw, factor.value)
          return { dek: vault.dek, file: vault.file, close: () => closeVault(vault) } satisfies OpenVault
        } catch (error) {
          if (error instanceof VaultError && error.code === "VAULT_UNLOCK_FAILED") throw new FactorRejectedError()
          throw error
        }
      },
      openSlot: async (vault) => {
        const contents = await openCoreSlot({ paths, vault, profile, environment })
        for (const signer of contents.signers) redactor.add(signer.value)
        return { writeKey: contents.writeKey, deviceToken: contents.deviceToken }
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
        redactor.add(credentials.writeKey)
        redactor.add(credentials.deviceToken)
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
    const cards = new CardBook({
      journal,
      events: server.events,
      trading,
      executor,
      environment,
      profile,
      now: deps.now,
    })
    cardBook = cards
    registerCardHandlers(server, cards, trading)
    registerToolFace(server, { cards, trading, executor, journal, readKey: () => readKey })
    // Turning trading on replaces the plain key with the minted Read key (K-11).
    trading.onChange(() => {
      void deps.store.get(profileSecretRef(profile, "apiKey")).then((key) => {
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
    const started = await journal.append({
      type: "core.started",
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
function registerCardHandlers(server: CoreServer, cards: CardBook, trading: TradingState): void {
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
      { cardId: params.cardId, cardHash: params.cardHash, factor: parseFactor(params.factor) },
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
  server.handle("settings.get", async () => trading.snapshot())
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
    } else if (params.path === "approvalPolicy") {
      throw refused("POLICY_FIXED", "The approval policy is Ask me (every live action) in this version.")
    } else {
      throw refused("INVALID_SETTING", "Settable paths: trading, window, paperWindow.")
    }
    return trading.snapshot()
  })
}
