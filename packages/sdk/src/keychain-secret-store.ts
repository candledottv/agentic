/**
 * keychain-secret-store: the OS-keychain `SecretStore` secret-store.ts's module doc deferred to
 * "Phase 4", closing the loop with the Candle CLI's wallet import.
 *
 * `candle wallets import` stores each imported wallet's signer private key in the OS keychain:
 * service `tv.candle.cli`, account `wallet_signer_<linkedWalletId>`, value = the PEM's base64
 * body on a single line (the CLI's `pemToStoredSigner` form; a raw PEM contains newlines, which
 * the CLI's macOS write path refuses by design). This store reads that exact contract, so an SDK
 * agent on the same machine picks up CLI-imported wallets with zero manual key handling:
 *
 *   const store = KeychainSecretStore.detect()
 *   const candle = new CandleClient({ apiKey, privyAppId, secretStore: store ?? undefined })
 *   await candle.trade({ ..., from: { linkedWalletId, privyWalletId } })
 *
 * `get()` re-armors the stored single-line value into standard PEM, which is what the signing
 * path (`buildPrivyAuthorizationSignature`) consumes. `set()` accepts a PEM and stores the
 * single-line form, so writes from either side stay format-compatible. Node-only (spawns
 * `security` on macOS, `secret-tool` on Linux), like `EncryptedFileSecretStore`; browser and
 * ephemeral runs keep using `InMemorySecretStore`.
 *
 * Secrets travel exclusively via the child's STDIN or its stdout, never argv, mirroring the
 * CLI's own stores: macOS `security` only takes secrets as a `-w` argv flag in its normal form,
 * so writes go through `security -i` (command-on-stdin mode) instead. BOTH interpolated halves of
 * that command line are checked rather than assumed: `assertStorable` for the `-w "<value>"` token
 * and `assertSafeRef` for the `-a "<ref>"` one. The value check alone is not enough, and saying so
 * here is the point: this doc previously reasoned only about the value, and the unchecked ref was
 * a command-injection path through `security -i` for anything that could influence a wallet id.
 */

import { spawn, spawnSync } from "node:child_process"
import type { SecretStore } from "./secret-store"

const SERVICE = "tv.candle.cli"

function walletSignerRef(walletRef: string): string {
  return `wallet_signer_${walletRef}`
}

/** The CLI's `pemToStoredSigner`: armor and whitespace stripped to a single base64 line. */
function pemToStoredSigner(pem: string): string {
  return pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "")
}

/** The CLI's `storedSignerToPem`: re-armor a stored single-line value as 64-column PEM. */
function storedSignerToPem(stored: string): string {
  const lines = stored.match(/.{1,64}/g) ?? [stored]
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`
}

function assertStorable(value: string): void {
  if (!/^[A-Za-z0-9+/]+=*$/.test(value)) {
    throw new Error("Refusing to store a signer value that is not single-line base64")
  }
}

/**
 * The account/reference half of the same quoting problem `assertStorable` closes for the value.
 *
 * `security -i` executes each LINE of its stdin as one command, and `set` and `delete` both build
 * that line by interpolating the ref into a quoted `-a "<ref>"` token. A `"` closes the token
 * early, a `\` escapes the closing quote, and a CR or LF ends the command outright and starts a
 * second one, for instance a `delete-generic-password` against an account the caller chose. Mirrors
 * `UNSAFE_FOR_SECURITY_COMMAND_LINE` in the CLI's keychain.ts, which has carried this guard on the
 * VALUE from the start; the ref was unchecked in both copies.
 *
 * A ref is a server-issued linked-wallet id, so this should never fire in practice. That is exactly
 * why it is a check rather than a comment: nothing else stops a hostile or malfunctioning API
 * response from running `security` batch commands as the local user.
 */
const UNSAFE_FOR_SECURITY_COMMAND_LINE = /["\\\n\r]/

function assertSafeRef(ref: string): void {
  if (UNSAFE_FOR_SECURITY_COMMAND_LINE.test(ref)) {
    throw new Error(
      "Refusing to use this wallet reference against the macOS Keychain: it contains a quote, " +
        "backslash, or newline, which could break out of the quoted argument on security's " +
        "command-on-stdin line",
    )
  }
}

export interface ExecResult {
  status: number
  stdout: string
}

export type ExecFn = (binary: string, args: string[], stdin?: string) => Promise<ExecResult>

/** Kills a hung keychain tool rather than hanging the caller; same bound the CLI uses. */
const RUN_TIMEOUT_MS = 10_000

const realExec: ExecFn = (binary, args, stdin) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "ignore"], env: process.env })
    let stdout = ""
    let settled = false
    const timeout = setTimeout(() => {
      if (!settled) child.kill("SIGKILL")
    }, RUN_TIMEOUT_MS)
    child.stdin.on("error", () => {})
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.on("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(err)
    })
    child.on("close", (status) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolvePromise({ status: status ?? 1, stdout })
    })
    if (stdin !== undefined) child.stdin.write(stdin)
    child.stdin.end()
  })

export class KeychainSecretStore implements SecretStore {
  private readonly backend: "security" | "secret-tool"
  private readonly exec: ExecFn

  constructor(opts: { backend?: "security" | "secret-tool"; exec?: ExecFn } = {}) {
    this.backend = opts.backend ?? (process.platform === "darwin" ? "security" : "secret-tool")
    this.exec = opts.exec ?? realExec
  }

  /**
   * The store for this machine, or `null` when no OS keychain tool is on `PATH` (fall back to
   * `EncryptedFileSecretStore` or `InMemorySecretStore` then). Presence-only: a resolvable
   * binary whose daemon is down surfaces later as `get() === null`, which every caller already
   * handles as "no signer stored".
   */
  static detect(): KeychainSecretStore | null {
    const backend = process.platform === "darwin" ? "security" : "secret-tool"
    const found = spawnSync("which", [backend], { env: process.env }).status === 0
    return found ? new KeychainSecretStore({ backend }) : null
  }

  async get(walletRef: string): Promise<string | null> {
    const ref = walletSignerRef(walletRef)
    const result =
      this.backend === "security"
        ? await this.exec("security", ["find-generic-password", "-s", SERVICE, "-a", ref, "-w"])
        : await this.exec("secret-tool", ["lookup", "service", SERVICE, "account", ref])
    if (result.status !== 0) return null
    const value = result.stdout.replace(/\n$/, "")
    if (value.length === 0) return null
    // Forward-compatible: a value that is already PEM passes through untouched.
    return value.includes("BEGIN PRIVATE KEY") ? value : storedSignerToPem(value)
  }

  async set(walletRef: string, privateKeyPem: string): Promise<void> {
    const ref = walletSignerRef(walletRef)
    const value = pemToStoredSigner(privateKeyPem)
    assertStorable(value)
    if (this.backend === "security") {
      assertSafeRef(ref)
      const command = `add-generic-password -U -s "${SERVICE}" -a "${ref}" -w "${value}"\n`
      const result = await this.exec("security", ["-i"], command)
      if (result.status !== 0) throw new Error(`Failed to store signer in the macOS Keychain (${result.status})`)
      return
    }
    const result = await this.exec(
      "secret-tool",
      ["store", "--label=Candle CLI", "service", SERVICE, "account", ref],
      value,
    )
    if (result.status !== 0) throw new Error(`Failed to store signer via secret-tool (${result.status})`)
  }

  async delete(walletRef: string): Promise<void> {
    const ref = walletSignerRef(walletRef)
    // Best-effort, matching the SecretStore contract: deleting a never-stored ref is a no-op.
    // The ref check is NOT best-effort: an unsafe ref here would inject a second command just as
    // it would on the write path, so it throws rather than silently doing something else.
    if (this.backend === "security") {
      assertSafeRef(ref)
      await this.exec("security", ["-i"], `delete-generic-password -s "${SERVICE}" -a "${ref}"\n`)
      return
    }
    await this.exec("secret-tool", ["clear", "service", SERVICE, "account", ref])
  }
}
