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
 * Factors (K-5, S4 F-1 to F-3). The core accepts every factor the vault accepts that is usable on
 * this machine: a passphrase arrives from the view and is checked by opening the vault with it; a
 * security key is driven by the core through the `candle-fido2` helper, with the PIN (when the key
 * needs one) typed in the view and sent once like a passphrase. Touch ID and the synced passkey
 * are listed as not usable until S1's V-2 passes (D-E default A). None is ever journaled or kept.
 * Five REJECTED factors within ten minutes lock approvals for five; a factor that is unavailable
 * (no key attached, the helper missing, a dialog cancelled) returns the user to the picker and
 * does not count (F-2).
 *
 * Transfers (S4 W-3, T-6). A transfer never reads a window: {@link TradingState.withTransferCredentials}
 * opens the slot with a factor verified in that one call and is the only path that returns the
 * Withdraw key; {@link TradingState.withVaultSigner} opens the vault for a `vault` transfer, which
 * signs with a vault key and holds no API key at all.
 *
 * The slot functions are passed in by `commands/core.ts`, the one file allowed to import
 * `slot.ts`; this module never reaches the slot loader itself.
 */

import { randomBytes } from "node:crypto"
import { readFile, rename, writeFile } from "node:fs/promises"
import { type CardKind, FRESH_FACTOR_KINDS } from "./classify"
import { refused } from "./rpc"

export type FactorType = "passphrase" | "security-key" | "touch-id" | "passkey"

export type Factor =
  | { type: "passphrase"; value: string }
  /** The PIN, when the key needs one, typed in the view and sent once; the touch is on the key. */
  | { type: "security-key"; pin?: string }
  | { type: "touch-id" }
  | { type: "passkey" }

/** One factor as the view's picker lists it (F-1): usable first, then the rest with the CLI's reason. */
export interface FactorOption {
  type: FactorType
  usable: boolean
  /** Why it is not usable here ("Touch ID: not in this build", "no security key enrolled"). */
  reason?: string
}

/** A vault wallet a transfer can send from (S4 T-2): a vault key or a promoted TEE wallet. Public facts only. */
export interface VaultWallet {
  id: string
  chain: "solana" | "evm"
  address: string
  label: string
  role: "vault" | "tee-wallet"
}

/** The slice of an unlocked vault the slot needs, and the caller's to close. */
export interface OpenVault {
  dek: Uint8Array
  file: { vaultId: string }
  close(): void
  /** The vault's transfer sources, read from its index while it is open. Addresses only. */
  wallets?: VaultWallet[]
  /** Decrypts one wallet's signing key for a `vault` transfer. The caller wipes it. */
  signingKey?(walletId: string): Promise<Uint8Array>
}

/**
 * What the slot holds for trading, windows, paper and every kind but a transfer. Lives in memory
 * only. It never carries the Withdraw key (W-3): that comes only from
 * {@link TradingState.withTransferCredentials}.
 */
export interface TradingCredentials {
  writeKey: string
  deviceToken: string
}

/** What one `embedded` transfer gets (W-3): the Withdraw key, for that call only. */
export interface TransferCredentials {
  withdrawKey: string
}

/** A Withdraw key the core minted (W-2): the public facts kept in settings, never the key. */
export interface WithdrawKeyInfo {
  prefix: string
  limitUsdMicros: number
  reset: "daily" | "weekly" | "monthly" | "never"
  expiresAt: string | null
}

/**
 * The embedded source's switch (W-2), as settings and `transfer.sources` show it. An `off` that
 * followed a key keeps its prefix, so turning off can still revoke it by prefix without reading it.
 */
export type WithdrawState = { status: "off"; reason?: string; prefix?: string } | ({ status: "on" } & WithdrawKeyInfo)

/** W-2's request: the USD limit per window is required; the expiry is D-B's default A. */
export interface WithdrawRequest {
  limitUsdMicros: number
  reset: "daily" | "weekly" | "monthly" | "never"
}

/** D-B default A: a Withdraw key lapses after 30 days and is renewed in Settings with a factor. */
export const WITHDRAW_KEY_DAYS = 30

export interface TradingDeps {
  /**
   * Opens the vault with a factor; throws `FactorRejectedError` for a wrong one and
   * `FactorUnavailableError` for one this machine cannot use right now. `reason` names the
   * operation, so a security-key or Touch ID dialog says what it is for (the CLI's `describeSend`).
   */
  unlockVault(factor: Factor, reason?: string): Promise<OpenVault>
  /** F-1: every factor the vault has, usable or not, with the CLI's availability logic. */
  listFactors?(): Promise<FactorOption[]>
  slotExists(): Promise<boolean>
  /**
   * The non-transfer slot open (W-3): the slot's contents minus the Withdraw key, which the loader
   * drops and whose buffers it wipes before this returns.
   */
  openSlot(vault: OpenVault): Promise<TradingCredentials>
  /** The transfer slot open (W-3): the Withdraw key, or undefined when the slot holds none. */
  openTransferSlot?(vault: OpenVault): Promise<{ withdrawKey?: string }>
  /** Re-seals the slot with `withdrawKey`, or without one when it is undefined (W-2). */
  sealWithdrawKey?(vault: OpenVault, withdrawKey: string | undefined): Promise<void>
  /** W-2: mints the Withdraw key with the device token from the slot. Returns the key and its facts. */
  mintWithdrawKey?(
    deviceToken: string,
    request: WithdrawRequest & { expiresInDays: number },
  ): Promise<{ key: string; info: WithdrawKeyInfo }>
  /** W-2: revokes the Withdraw key by its prefix with the device token. */
  revokeWithdrawKey?(deviceToken: string, prefix: string): Promise<void>
  /** K-11's move, with the Read key the plain store will keep. */
  moveToSlot(vault: OpenVault, readKey: string): Promise<void>
  /** Mints the read-only key the plain store keeps once the Write key has moved. */
  mintReadKey(): Promise<string>
  settingsPath: string
  now: () => number
  /** Registered by the core so every value the window holds is redacted (K-10). */
  remember(credentials: TradingCredentials | TransferCredentials): void
  /** K-5: reads the Write key's USD limit and this window's use, with the credentials in hand. */
  readKeyLimit?: (credentials: TradingCredentials) => Promise<KeyLimit | undefined>
}

/** The Write key's limit as last read (`--tx-limit`, `--reset`), and what the window has used. */
export interface KeyLimit {
  usdMicros: number
  reset: "daily" | "weekly" | "monthly" | "never"
  usedUsdMicros: number
  readAt: number
}

/** `$50.00 daily, $38.00 left`, for the card's `display.keyLimitUsd`. */
export function formatKeyLimit(limit: KeyLimit | undefined): string | undefined {
  if (limit === undefined) return undefined
  const usd = (micros: number) => `$${(Math.max(0, micros) / 1_000_000).toFixed(2)}`
  return `${usd(limit.usdMicros)} ${limit.reset === "never" ? "in total" : limit.reset}, ${usd(limit.usdMicros - limit.usedUsdMicros)} left`
}

export class FactorRejectedError extends Error {
  constructor() {
    super("The factor did not open the vault.")
    this.name = "FactorRejectedError"
  }
}

/** F-2: the factor could not be used just now. Not a wrong answer, so it never counts toward the lockout. */
export class FactorUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = "FactorUnavailableError"
  }
}

const FACTOR_WORDS: Record<FactorType, string> = {
  passphrase: "Passphrase",
  "security-key": "Security key",
  "touch-id": "Touch ID",
  passkey: "Passkey",
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
  /** W-2: transfers from the embedded wallet. */
  withdraw: WithdrawState
}

export class TradingState {
  private on = false
  private window: Window | undefined
  /** A-5: the paper window. Same cap and rules as K-6; it never approves a live card. */
  private paperWindow: Window | undefined
  private failures: number[] = []
  private lockedUntil = 0
  private readonly listeners: (() => void)[] = []
  private keyLimit: KeyLimit | undefined
  private withdraw: WithdrawState = { status: "off" }
  /** T-2: the vault's wallets as last read from its index. Public addresses; display only. */
  private wallets: VaultWallet[] | undefined

  private constructor(private readonly deps: TradingDeps) {}

  /** Restores `tradingOn` from settings. A window never survives a restart (K-6, K-11). */
  static async open(deps: TradingDeps): Promise<TradingState> {
    const state = new TradingState(deps)
    try {
      const parsed = JSON.parse(await readFile(deps.settingsPath, "utf8")) as {
        tradingOn?: unknown
        withdraw?: unknown
      }
      const slot = await deps.slotExists()
      // Trading on with no slot is not on: the credentials it would use are not there.
      state.on = parsed.tradingOn === true && slot
      state.withdraw = slot ? parseWithdraw(parsed.withdraw) : { status: "off" }
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
      withdraw: this.withdrawState(),
    }
  }

  /** W-2's switch, with an expiry that has passed read as off. */
  withdrawState(): WithdrawState {
    const withdraw = this.withdraw
    if (withdraw.status === "on" && withdraw.expiresAt !== null && Date.parse(withdraw.expiresAt) <= this.deps.now()) {
      return {
        status: "off",
        prefix: withdraw.prefix,
        reason: "The Withdraw key expired. Turn transfers from the embedded wallet on again.",
      }
    }
    return withdraw
  }

  /** F-1: the factors for the view's picker, usable first. Without a lister, the passphrase only. */
  async factors(): Promise<FactorOption[]> {
    const listed = this.deps.listFactors
      ? await this.deps.listFactors().catch(() => [] as FactorOption[])
      : [{ type: "passphrase" as const, usable: true }]
    const seen = new Set<FactorType>()
    const unique = listed.filter((option) => !seen.has(option.type) && seen.add(option.type))
    if (!seen.has("passphrase")) unique.unshift({ type: "passphrase", usable: true })
    return [...unique.filter((o) => o.usable), ...unique.filter((o) => !o.usable)]
  }

  /** T-2: the vault's wallets as last read, or undefined when no unlock has read them yet. */
  vaultWallets(): VaultWallet[] | undefined {
    return this.wallets?.map((wallet) => ({ ...wallet }))
  }

  /** T-2: reads the vault's wallets with a factor, for a view that has none listed yet. */
  async readVaultWallets(factor: Factor | undefined): Promise<VaultWallet[]> {
    const vault = await this.verify(factor, "list your vault wallets")
    vault.close()
    return this.vaultWallets() ?? []
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
      const credentials = await this.deps.openSlot(vault)
      this.deps.remember(credentials)
      await this.refreshKeyLimit(credentials)
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

  /**
   * K-5: a fresh read of the key limit. A read that fails leaves the limit unknown rather than
   * stale, so an approval is never checked against an old figure; the server's limit
   * (`KEY_LIMIT_REACHED`) is the backstop either way.
   */
  async refreshKeyLimit(credentials: TradingCredentials): Promise<KeyLimit | undefined> {
    if (!this.deps.readKeyLimit) return this.keyLimit
    try {
      this.keyLimit = await this.deps.readKeyLimit(credentials)
    } catch {
      this.keyLimit = undefined
    }
    return this.keyLimit
  }

  /** The limit as last read, for the card display. */
  lastKeyLimit(): KeyLimit | undefined {
    return this.keyLimit
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

  /**
   * W-3 and T-6: runs `use` with the Withdraw key for one approved `embedded` transfer. The factor
   * is verified here, in this call, and is never a window, a paper window or a factor cached from
   * an earlier approval; this method never reads either window. It is the only credential path
   * that returns the Withdraw key, and the key is dropped when `use` returns.
   */
  async withTransferCredentials<T>(
    input: { cardId: string; viewClientId: string; factor: Factor | undefined; reason: string },
    use: (credentials: TransferCredentials) => Promise<T>,
  ): Promise<T> {
    if (input.factor === undefined) throw refused("FACTOR_REQUIRED", "A transfer always needs a fresh factor.")
    const withdraw = this.withdrawState()
    if (withdraw.status !== "on" || this.deps.openTransferSlot === undefined) {
      throw refused(
        "EMBEDDED_TRANSFERS_OFF",
        withdraw.status === "off" && withdraw.reason
          ? withdraw.reason
          : "Transfers from the embedded wallet are off. Turn them on in Settings > Transfers.",
      )
    }
    const vault = await this.verify(input.factor, input.reason)
    let credentials: TransferCredentials | undefined
    try {
      const opened = await this.deps.openTransferSlot(vault)
      if (typeof opened.withdrawKey !== "string" || opened.withdrawKey.length === 0) {
        throw refused(
          "WITHDRAW_KEY_MISSING",
          "The vault holds no Withdraw key. Turn transfers from the embedded wallet on again.",
        )
      }
      credentials = { withdrawKey: opened.withdrawKey }
    } finally {
      vault.close()
    }
    this.deps.remember(credentials)
    try {
      return await use(credentials)
    } finally {
      // Released here: nothing in the core keeps a reference once the transfer call returns.
      credentials.withdrawKey = ""
      credentials = undefined
    }
  }

  /**
   * T-7's `vault` source: runs `use` with the vault opened by a factor verified in this call. The
   * vault unlock is what releases the signing key; no API key, window or Withdraw key is involved.
   */
  async withVaultSigner<T>(
    input: { viewClientId: string; factor: Factor | undefined; reason: string },
    use: (vault: OpenVault) => Promise<T>,
  ): Promise<T> {
    if (input.factor === undefined) throw refused("FACTOR_REQUIRED", "A transfer always needs a fresh factor.")
    const vault = await this.verify(input.factor, input.reason)
    try {
      return await use(vault)
    } finally {
      vault.close()
    }
  }

  /**
   * W-2: turns transfers from the embedded wallet on. A fresh factor opens the slot; the core mints
   * the Withdraw key with the slot's device token, re-seals the slot with it, and records only its
   * public facts. First run never calls this (design 5).
   */
  async turnOnEmbeddedTransfers(request: WithdrawRequest, factor: Factor | undefined): Promise<WithdrawKeyInfo> {
    const { mintWithdrawKey, sealWithdrawKey, revokeWithdrawKey } = this.deps
    if (!mintWithdrawKey || !sealWithdrawKey) {
      throw refused("NOT_IN_THIS_BUILD", "Transfers from the embedded wallet are not in this build.")
    }
    if (!Number.isInteger(request.limitUsdMicros) || request.limitUsdMicros <= 0) {
      throw refused("INVALID_SETTING", "A USD limit per window is required, and it is more than zero.")
    }
    if (!(await this.deps.slotExists())) {
      throw refused("TRADING_OFF", "Turn trading on first: the Withdraw key is kept in the same sealed slot.")
    }
    const vault = await this.verify(factor, "turn on transfers from the embedded wallet")
    try {
      const credentials = await this.deps.openSlot(vault)
      this.deps.remember(credentials)
      // The key this one replaces, by the prefix kept in settings: the slot is never read for it.
      const previous = this.withdraw.prefix
      let minted: { key: string; info: WithdrawKeyInfo } | undefined = await mintWithdrawKey(credentials.deviceToken, {
        ...request,
        expiresInDays: WITHDRAW_KEY_DAYS,
      })
      this.deps.remember({ withdrawKey: minted.key })
      try {
        await sealWithdrawKey(vault, minted.key)
      } catch (error) {
        // Minted but never sealed: its prefix would reach no setting, so nothing could revoke it
        // later and it would keep `transfer:write` on the server. Revoke it now, best effort.
        if (revokeWithdrawKey) await revokeWithdrawKey(credentials.deviceToken, minted.info.prefix).catch(() => {})
        throw error
      }
      const info = minted.info
      minted = undefined
      // A key it replaces is revoked too, best effort: the new one is already sealed.
      if (previous && previous !== info.prefix && revokeWithdrawKey) {
        await revokeWithdrawKey(credentials.deviceToken, previous).catch(() => {})
      }
      this.withdraw = { status: "on", ...info }
    } finally {
      vault.close()
    }
    await this.persist()
    this.changed()
    return { ...(this.withdraw as WithdrawKeyInfo & { status: "on" }) }
  }

  /** W-2: turns them off: revokes the key through the API and re-seals the slot without it. */
  async turnOffEmbeddedTransfers(factor: Factor | undefined): Promise<{ revokedPrefix?: string }> {
    const { sealWithdrawKey, revokeWithdrawKey } = this.deps
    if (!sealWithdrawKey || !revokeWithdrawKey) {
      throw refused("NOT_IN_THIS_BUILD", "Transfers from the embedded wallet are not in this build.")
    }
    const vault = await this.verify(factor, "turn off transfers from the embedded wallet")
    const revokedPrefix = this.withdraw.prefix
    try {
      const credentials = await this.deps.openSlot(vault)
      this.deps.remember(credentials)
      // Revoked by its prefix (W-2): the key itself is never read to turn it off.
      if (revokedPrefix) await revokeWithdrawKey(credentials.deviceToken, revokedPrefix)
      await sealWithdrawKey(vault, undefined)
      this.withdraw = { status: "off" }
    } finally {
      vault.close()
    }
    await this.persist()
    this.changed()
    return revokedPrefix ? { revokedPrefix } : {}
  }

  /** W-2: the server said the Withdraw key is revoked or expired. The embedded source turns off. */
  async withdrawKeyRefused(code: string): Promise<void> {
    if (this.withdraw.status !== "on") return
    this.withdraw = {
      status: "off",
      prefix: this.withdraw.prefix,
      reason:
        code === "KEY_EXPIRED"
          ? "The Withdraw key expired on Candle's server. Turn transfers from the embedded wallet on again."
          : "Candle's server no longer accepts the Withdraw key (revoked or replaced). Turn transfers from the embedded wallet on again.",
    }
    await this.persist()
    this.changed()
  }

  private activePaperWindow(): Window | undefined {
    if (this.paperWindow !== undefined && this.paperWindow.closesAt <= this.deps.now()) this.closePaperWindow()
    return this.paperWindow
  }

  private activeWindow(): Window | undefined {
    if (this.window !== undefined && this.window.closesAt <= this.deps.now()) this.closeWindow()
    return this.window
  }

  /**
   * Opens the vault with `factor`, counting rejections toward the lockout. A factor this machine
   * cannot use is `VAULT_FACTOR_UNAVAILABLE` and counts nothing (F-2). `reason` names the
   * operation for a helper's dialog.
   */
  private async verify(factor: Factor | undefined, reason?: string): Promise<OpenVault> {
    const now = this.deps.now()
    if (this.lockedUntil > now) {
      throw refused("APPROVALS_LOCKED", "Too many rejected factors. Approvals are locked for a few minutes.", {
        lockedUntil: new Date(this.lockedUntil).toISOString(),
      })
    }
    if (factor === undefined) throw refused("FACTOR_REQUIRED", "This needs your vault factor.")
    if (factor.type === "passphrase") {
      if (typeof factor.value !== "string" || factor.value.length === 0)
        throw refused("FACTOR_REQUIRED", "The passphrase is empty.")
    } else {
      const option = (await this.factors()).find((candidate) => candidate.type === factor.type)
      if (option === undefined || !option.usable) {
        throw unavailable(
          `${FACTOR_WORDS[factor.type]}: ${option?.reason ?? "not usable on this machine"}. Choose another factor; the card is still open.`,
        )
      }
    }
    try {
      const vault = await this.deps.unlockVault(factor, reason)
      if (vault.wallets !== undefined) this.wallets = vault.wallets.map((wallet) => ({ ...wallet }))
      return vault
    } catch (error) {
      if (error instanceof FactorUnavailableError) {
        throw unavailable(
          `${FACTOR_WORDS[factor.type]}: ${error.reason} Choose another factor; the card is still open.`,
        )
      }
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
    // The Withdraw key's public facts only (W-2); the key itself lives in the sealed slot.
    const quiet = this.withdraw.status === "off" && !this.withdraw.reason && !this.withdraw.prefix
    const body = { tradingOn: this.on, ...(quiet ? {} : { withdraw: this.withdraw }) }
    await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, flag: "wx" })
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
  const { type, value: secret, pin } = value as { type?: unknown; value?: unknown; pin?: unknown }
  if (type === "passphrase" && typeof secret === "string") return { type, value: secret }
  if (type === "security-key") return typeof pin === "string" && pin.length > 0 ? { type, pin } : { type }
  if (type === "touch-id" || type === "passkey") return { type }
  throw refused("INVALID_FACTOR", "factor.type must be passphrase, security-key, touch-id or passkey.")
}

function unavailable(message: string) {
  return refused("VAULT_FACTOR_UNAVAILABLE", message)
}

function parseWithdraw(value: unknown): WithdrawState {
  const v = value as Partial<WithdrawKeyInfo> & { status?: unknown; reason?: unknown }
  if (v === null || typeof v !== "object") return { status: "off" }
  if (
    v.status === "on" &&
    typeof v.prefix === "string" &&
    typeof v.limitUsdMicros === "number" &&
    (v.reset === "daily" || v.reset === "weekly" || v.reset === "monthly" || v.reset === "never") &&
    (typeof v.expiresAt === "string" || v.expiresAt === null)
  ) {
    return { status: "on", prefix: v.prefix, limitUsdMicros: v.limitUsdMicros, reset: v.reset, expiresAt: v.expiresAt }
  }
  return {
    status: "off",
    ...(typeof v.reason === "string" ? { reason: v.reason } : {}),
    ...(typeof v.prefix === "string" ? { prefix: v.prefix } : {}),
  }
}
