/**
 * Trading on or off, the vault factor, and the timed unlock window (BE-1665, spec K-5, K-6, K-11,
 * S-9's "Turn trading on").
 *
 * On this build the Write key lives in the core-only slot sealed under the vault (`slot.ts`, see
 * that file and PR 1's note), so every use of it needs the vault open: an approval with a fresh
 * factor (K-5), or a window opened with one (K-6), during which the core keeps the slot's contents
 * in memory and approves with Enter alone. Closing the window, the view that opened it detaching,
 * the cap passing and a core restart all drop them; nothing here is ever written to disk.
 *
 * Factors (K-5). A passphrase arrives from the view and is checked by opening the vault with it;
 * it is never journaled or kept. Touch ID and a security key are driven by the core itself through
 * their helpers; this build refuses them with `FACTOR_NOT_IN_THIS_BUILD` until the helper can be
 * cancelled from the core (V-2). Five rejected factors within ten minutes lock approvals for five.
 *
 * The slot functions are passed in by `commands/core.ts`, the one file allowed to import
 * `slot.ts`; this module never reaches the slot loader itself.
 */

import { randomBytes } from "node:crypto"
import { readFile, rename, writeFile } from "node:fs/promises"
import { type CardKind, FRESH_FACTOR_KINDS } from "./classify"
import { refused } from "./rpc"

export type Factor = { type: "passphrase"; value: string } | { type: "touch-id" } | { type: "security-key" }

/** The slice of an unlocked vault the slot needs, and the caller's to close. */
export interface OpenVault {
  dek: Uint8Array
  file: { vaultId: string }
  close(): void
}

/** What the slot holds. Lives in memory only. */
export interface TradingCredentials {
  writeKey: string
  deviceToken: string
}

export interface TradingDeps {
  /** Opens the vault with a factor; throws `FactorRejectedError` for a wrong one. */
  unlockVault(factor: Factor): Promise<OpenVault>
  slotExists(): Promise<boolean>
  openSlot(vault: OpenVault): Promise<TradingCredentials>
  /** K-11's move, with the Read key the plain store will keep. */
  moveToSlot(vault: OpenVault, readKey: string): Promise<void>
  /** Mints the read-only key the plain store keeps once the Write key has moved. */
  mintReadKey(): Promise<string>
  settingsPath: string
  now: () => number
  /** Registered by the core so every value the window holds is redacted (K-10). */
  remember(credentials: TradingCredentials): void
}

export class FactorRejectedError extends Error {
  constructor() {
    super("The factor did not open the vault.")
    this.name = "FactorRejectedError"
  }
}

/** D1 default B: a window of up to 15 minutes, off unless the user opens one. */
export const MAX_WINDOW_MS = 15 * 60_000
const FAILURE_WINDOW_MS = 10 * 60_000
const FAILURE_LIMIT = 5
const LOCKOUT_MS = 5 * 60_000

interface Window {
  viewClientId: string
  openedAt: number
  closesAt: number
  credentials: TradingCredentials
  timer: ReturnType<typeof setTimeout>
}

export interface TradingSnapshot {
  tradingOn: boolean
  approvalPolicy: "ask"
  timedWindow: { open: false } | { open: true; viewClientId: string; closesAt: string }
  paperWindow: { open: false } | { open: true; viewClientId: string; closesAt: string }
  approvalsLockedUntil: string | null
}

export class TradingState {
  private on = false
  private window: Window | undefined
  /** A-5: the paper window. Same cap and rules as K-6; it never approves a live card. */
  private paperWindow: Window | undefined
  private failures: number[] = []
  private lockedUntil = 0
  private readonly listeners: (() => void)[] = []

  private constructor(private readonly deps: TradingDeps) {}

  /** Restores `tradingOn` from settings. A window never survives a restart (K-6, K-11). */
  static async open(deps: TradingDeps): Promise<TradingState> {
    const state = new TradingState(deps)
    try {
      const parsed = JSON.parse(await readFile(deps.settingsPath, "utf8")) as { tradingOn?: unknown }
      // Trading on with no slot is not on: the credentials it would use are not there.
      state.on = parsed.tradingOn === true && (await deps.slotExists())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    return state
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener)
  }

  tradingOn(): boolean {
    return this.on
  }

  snapshot(): TradingSnapshot {
    const window = this.activeWindow()
    const paper = this.activePaperWindow()
    return {
      tradingOn: this.on,
      approvalPolicy: "ask",
      timedWindow: window
        ? { open: true, viewClientId: window.viewClientId, closesAt: new Date(window.closesAt).toISOString() }
        : { open: false },
      paperWindow: paper
        ? { open: true, viewClientId: paper.viewClientId, closesAt: new Date(paper.closesAt).toISOString() }
        : { open: false },
      approvalsLockedUntil: this.lockedUntil > this.deps.now() ? new Date(this.lockedUntil).toISOString() : null,
    }
  }

  /** S-9: turns trading on with a fresh factor, moving the credentials into the slot the first time. */
  async turnOn(factor: Factor | undefined): Promise<void> {
    const vault = await this.verify(factor)
    try {
      if (!(await this.deps.slotExists())) {
        const readKey = await this.deps.mintReadKey()
        await this.deps.moveToSlot(vault, readKey)
      }
      // Proves the slot opens with this vault before the switch reads "on".
      this.deps.remember(await this.deps.openSlot(vault))
    } finally {
      vault.close()
    }
    this.on = true
    await this.persist()
    this.changed()
  }

  async turnOff(): Promise<void> {
    this.on = false
    this.closeWindow()
    this.closePaperWindow()
    await this.persist()
    this.changed()
  }

  /** K-6: opens a window bound to `viewClientId`, capped at {@link MAX_WINDOW_MS}. */
  async openWindow(viewClientId: string, minutes: number, factor: Factor | undefined): Promise<void> {
    if (!this.on) throw refused("TRADING_OFF", "Turn trading on before opening a window.")
    if (!Number.isFinite(minutes) || minutes <= 0)
      throw refused("INVALID_WINDOW", "A window lasts more than zero minutes.")
    const lengthMs = Math.min(minutes * 60_000, MAX_WINDOW_MS)
    const vault = await this.verify(factor)
    let credentials: TradingCredentials
    try {
      credentials = await this.deps.openSlot(vault)
    } finally {
      vault.close()
    }
    this.deps.remember(credentials)
    this.closeWindow()
    const openedAt = this.deps.now()
    const timer = setTimeout(() => this.closeWindow(), lengthMs)
    timer.unref?.()
    this.window = { viewClientId, openedAt, closesAt: openedAt + lengthMs, credentials, timer }
    this.changed()
  }

  closeWindow(): void {
    if (this.window === undefined) return
    clearTimeout(this.window.timer)
    this.window = undefined
    this.changed()
  }

  /** The view that opened the window detached: the window goes with it (K-6). */
  viewsAttached(viewClientIds: ReadonlySet<string>): void {
    if (this.window !== undefined && !viewClientIds.has(this.window.viewClientId)) this.closeWindow()
    if (this.paperWindow !== undefined && !viewClientIds.has(this.paperWindow.viewClientId)) this.closePaperWindow()
  }

  /**
   * A-5 on a backend whose Write key sits in the vault: paper needs the Write key, so the user opens
   * a paper window with the factor, once, and paper trades from any client run inside it. Same cap
   * and rules as K-6. It holds the key for paper only; no live card is ever approved through it.
   */
  async openPaperWindow(viewClientId: string, minutes: number, factor: Factor | undefined): Promise<void> {
    if (!this.on) throw refused("TRADING_OFF", "Turn trading on before opening a paper window.")
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw refused("INVALID_WINDOW", "A window lasts more than zero minutes.")
    }
    const lengthMs = Math.min(minutes * 60_000, MAX_WINDOW_MS)
    const vault = await this.verify(factor)
    let credentials: TradingCredentials
    try {
      credentials = await this.deps.openSlot(vault)
    } finally {
      vault.close()
    }
    this.deps.remember(credentials)
    this.closePaperWindow()
    const openedAt = this.deps.now()
    const timer = setTimeout(() => this.closePaperWindow(), lengthMs)
    timer.unref?.()
    this.paperWindow = { viewClientId, openedAt, closesAt: openedAt + lengthMs, credentials, timer }
    this.changed()
  }

  closePaperWindow(): void {
    if (this.paperWindow === undefined) return
    clearTimeout(this.paperWindow.timer)
    this.paperWindow = undefined
    this.changed()
  }

  /** Runs `use` with the Write key for a paper trade or a dry run: a paper window, or a live one. */
  async withPaperCredentials<T>(use: (credentials: TradingCredentials) => Promise<T>): Promise<T> {
    if (!this.on) throw refused("TRADING_OFF", "Paper needs trading on: the build route takes the Write key.")
    const window = this.activePaperWindow() ?? this.activeWindow()
    if (window === undefined) {
      throw refused(
        "PAPER_WINDOW_REQUIRED",
        "Open a paper window in the Candle TUI (Settings > Trading); it asks for your factor once.",
      )
    }
    return use(window.credentials)
  }

  /**
   * Runs `use` with the Write key for one approval of a `kind` card by `viewClientId`. A factor
   * opens the vault for this one use; without one, only an open window of that same view
   * may supply the key, and never for transfer, launch or keyaccess.
   */
  async withCredentials<T>(
    input: { kind: CardKind; viewClientId: string; factor: Factor | undefined },
    use: (credentials: TradingCredentials) => Promise<T>,
  ): Promise<T> {
    if (input.factor === undefined) {
      const window = this.activeWindow()
      if (FRESH_FACTOR_KINDS.has(input.kind)) {
        throw refused("FACTOR_REQUIRED", `A ${input.kind} card always needs a fresh factor, window or not.`)
      }
      if (window === undefined || window.viewClientId !== input.viewClientId) {
        throw refused("FACTOR_REQUIRED", "Approve with your vault factor, or open a timed window first.")
      }
      return use(window.credentials)
    }
    const vault = await this.verify(input.factor)
    let credentials: TradingCredentials
    try {
      credentials = await this.deps.openSlot(vault)
    } finally {
      vault.close()
    }
    this.deps.remember(credentials)
    return use(credentials)
  }

  private activePaperWindow(): Window | undefined {
    if (this.paperWindow !== undefined && this.paperWindow.closesAt <= this.deps.now()) this.closePaperWindow()
    return this.paperWindow
  }

  private activeWindow(): Window | undefined {
    if (this.window !== undefined && this.window.closesAt <= this.deps.now()) this.closeWindow()
    return this.window
  }

  /** Opens the vault with `factor`, counting rejections toward the lockout. */
  private async verify(factor: Factor | undefined): Promise<OpenVault> {
    const now = this.deps.now()
    if (this.lockedUntil > now) {
      throw refused("APPROVALS_LOCKED", "Too many rejected factors. Approvals are locked for a few minutes.", {
        lockedUntil: new Date(this.lockedUntil).toISOString(),
      })
    }
    if (factor === undefined) throw refused("FACTOR_REQUIRED", "This needs your vault factor.")
    if (factor.type !== "passphrase") {
      throw refused(
        "FACTOR_NOT_IN_THIS_BUILD",
        `${factor.type} approval from the core is not in this build; use the passphrase.`,
      )
    }
    if (typeof factor.value !== "string" || factor.value.length === 0)
      throw refused("FACTOR_REQUIRED", "The passphrase is empty.")
    try {
      return await this.deps.unlockVault(factor)
    } catch (error) {
      if (!(error instanceof FactorRejectedError)) throw error
      this.failures = [...this.failures.filter((at) => at > now - FAILURE_WINDOW_MS), now]
      if (this.failures.length >= FAILURE_LIMIT) {
        this.lockedUntil = now + LOCKOUT_MS
        this.failures = []
        this.changed()
      }
      throw refused("FACTOR_REJECTED", "That factor did not open the vault. The card is still open.")
    }
  }

  private async persist(): Promise<void> {
    const temp = `${this.deps.settingsPath}.tmp-${randomBytes(6).toString("base64url")}`
    await writeFile(temp, `${JSON.stringify({ tradingOn: this.on }, null, 2)}\n`, { mode: 0o600, flag: "wx" })
    await rename(temp, this.deps.settingsPath)
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }
}

/** Parses a factor from RPC params. The value is never logged; the redactor drops it from rows. */
export function parseFactor(value: unknown): Factor | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "object") throw refused("INVALID_FACTOR", "factor must be an object.")
  const { type, value: secret } = value as { type?: unknown; value?: unknown }
  if (type === "passphrase" && typeof secret === "string") return { type, value: secret }
  if (type === "touch-id" || type === "security-key") return { type }
  throw refused("INVALID_FACTOR", "factor.type must be passphrase, touch-id or security-key.")
}
