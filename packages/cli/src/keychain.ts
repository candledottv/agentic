/**
 * keychain: OS-keychain-backed `SecretStore`s (macOS Keychain via `security`, the Secret Service
 * via `secret-tool` on Linux), plus `resolveSecretStore`, which picks the best available backend
 * for the current machine and falls back to `EncryptedFileSecretStore` (secret-store.ts) when
 * neither is usable.
 *
 * Both stores write secrets exclusively via a spawned process's STDIN, never argv, so a credential
 * never shows up in a `ps` listing. macOS's `security` only accepts secrets as a `-w` command-line
 * flag in its normal invocation, so writes instead go through `security -i` (its command-on-stdin
 * mode): the whole `add-generic-password ... -w "<secret>"` command line is written to stdin as
 * text and `security` executes it as if typed interactively. `secret-tool store` reads the secret
 * from stdin natively, no such trick needed.
 */

import { spawn, spawnSync } from "node:child_process"
import { EncryptedFileSecretStore, type SecretStore } from "./secret-store"

const SERVICE = "tv.candle.cli"
const PROBE_ACCOUNT = "tv.candle.cli.probe"

// `KeychainSecretStore.set` interpolates the secret into a quoted `-w "<value>"` token on a command
// line handed to `security -i`'s own tokenizer (no shell involved, but `security` parses its own
// command lines). A `"` in the value would close that token early and inject further arguments; a
// `\` would escape the closing quote; a newline would start a whole new `security` command, since
// `-i` mode treats each line of stdin as one command -- including, for instance,
// `delete-generic-password` against an arbitrary account. Candle-issued device tokens and API keys
// are base64url and never contain any of these, so this should never trigger in practice; it exists
// to make that assumption true by construction rather than merely documented.
const UNSAFE_FOR_SECURITY_COMMAND_LINE = /["\\\n\r]/

interface RunResult {
  status: number
  stdout: string
  stderr: string
}

/**
 * Kills a spawned keychain tool if it hangs, rather than hanging the whole CLI forever. This repo
 * has a history of unbounded external calls wedging user-facing flows (see the RPC-hang and
 * stalled-mutation fixes elsewhere in the monorepo); a keychain/secret-tool call is exactly that
 * kind of external call.
 */
const RUN_TIMEOUT_MS = 10_000

/** Spawns `bin args`, optionally writing `stdin` to the child before closing its input, and
 * collects stdout/stderr/exit status. Never touches argv with `stdin`'s contents. */
function run(bin: string, args: string[], stdin?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // `env` is passed explicitly (rather than omitted, which would also default to inheriting
    // `process.env`) so a `PATH` mutated after this module was first loaded -- as every test here
    // does, prepending a stub directory -- is honored. Confirmed empirically: Bun's `spawn`/
    // `spawnSync` snapshot `process.env` at some point rather than re-reading it per call when the
    // `env` option is left out.
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env })
    let stdout = ""
    let stderr = ""
    let settled = false

    const timeout = setTimeout(() => {
      if (settled) return
      child.kill("SIGKILL")
    }, RUN_TIMEOUT_MS)

    // A child that exits (or is killed, e.g. by the timeout above) before draining stdin raises
    // EPIPE on the write end. Without a listener here, an unhandled "error" event on the stdin
    // stream crashes the whole CLI process instead of surfacing as the child's normal nonzero exit
    // via the "close" event below.
    child.stdin.on("error", () => {})

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.on("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(err)
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({ status: code ?? -1, stdout, stderr })
    })
    if (stdin !== undefined) child.stdin.write(stdin)
    child.stdin.end()
  })
}

function binaryResolvable(bin: string): boolean {
  // See the comment in `run()`: `env` must be passed explicitly for a test-mutated `PATH` to be seen.
  // `status` is `null` (not `0`) in the rarer case where `which` itself cannot be found on `PATH`
  // (e.g. a minimal container image), as distinct from `which` resolving fine and reporting `bin`
  // as not found (a nonzero, non-null status). Both degrade safely here: `status === 0` is false
  // either way, so this correctly falls through to the encrypted-file store rather than throwing.
  return spawnSync("which", [bin], { env: process.env }).status === 0
}

/**
 * A `SecretStore` backed by the macOS Keychain via the `security` CLI. `binary` defaults to
 * `"security"`, resolved through `PATH`; the override exists for callers that want to pin an exact
 * path, but tests exercise the real `PATH`-resolution code path by prepending a stub directory to
 * `PATH` instead of using it.
 */
export class KeychainSecretStore implements SecretStore {
  constructor(private readonly binary: string = "security") {}

  async get(ref: string): Promise<string | null> {
    const result = await run(this.binary, ["find-generic-password", "-s", SERVICE, "-a", ref, "-w"])
    if (result.status !== 0) return null
    return result.stdout.replace(/\n$/, "")
  }

  async set(ref: string, value: string): Promise<void> {
    if (UNSAFE_FOR_SECURITY_COMMAND_LINE.test(value)) {
      throw new Error(
        "Refusing to store this secret in the macOS Keychain: it contains a quote, backslash, or " +
          "newline, which could break out of the quoted argument on security's command-on-stdin line",
      )
    }
    // The secret is base64url (SDK-issued device tokens and API keys never contain spaces or
    // quotes), so embedding it in a quoted `-w` argument is safe -- the guard above makes that
    // invariant true by construction rather than merely documented.
    const command = `add-generic-password -U -s "${SERVICE}" -a "${ref}" -w "${value}"\n`
    const result = await run(this.binary, ["-i"], command)
    if (result.status !== 0) {
      throw new Error(`Failed to store credential in the macOS Keychain (security exited ${result.status})`)
    }
  }

  async delete(ref: string): Promise<void> {
    const command = `delete-generic-password -s "${SERVICE}" -a "${ref}"\n`
    // Best-effort: deleting an entry that was never stored is a no-op, matching SecretStore's
    // contract, so a nonzero exit here (e.g. "could not be found") is not treated as failure.
    await run(this.binary, ["-i"], command)
  }
}

/**
 * A `SecretStore` backed by the Linux Secret Service via the `secret-tool` CLI (libsecret).
 * `binary` defaults to `"secret-tool"`, resolved through `PATH`; see `KeychainSecretStore` for why
 * tests prefer the `PATH` seam over this override.
 */
export class SecretToolSecretStore implements SecretStore {
  constructor(private readonly binary: string = "secret-tool") {}

  async get(ref: string): Promise<string | null> {
    const result = await run(this.binary, ["lookup", "service", SERVICE, "account", ref])
    if (result.status !== 0) return null
    const value = result.stdout.replace(/\n$/, "")
    return value.length > 0 ? value : null
  }

  async set(ref: string, value: string): Promise<void> {
    const result = await run(this.binary, ["store", "--label=Candle CLI", "service", SERVICE, "account", ref], value)
    if (result.status !== 0) {
      throw new Error(`Failed to store credential via secret-tool (exited ${result.status})`)
    }
  }

  async delete(ref: string): Promise<void> {
    // Best-effort, same rationale as KeychainSecretStore.delete.
    await run(this.binary, ["clear", "service", SERVICE, "account", ref])
  }
}

/**
 * Round-trips a random value through `store` under {@link PROBE_ACCOUNT}: `secret-tool` can be
 * installed but still fail (no Secret Service running -- common on headless boxes) even though the
 * binary itself resolves, so `resolveSecretStore` treats a successful round trip, not just binary
 * presence, as the signal that this backend actually works here.
 */
async function probeSecretTool(store: SecretToolSecretStore): Promise<boolean> {
  const probeValue = crypto.randomUUID()
  try {
    await store.set(PROBE_ACCOUNT, probeValue)
    const got = await store.get(PROBE_ACCOUNT)
    return got === probeValue
  } catch {
    return false
  } finally {
    try {
      await store.delete(PROBE_ACCOUNT)
    } catch {
      // Best-effort cleanup only; the probe's result was already decided above.
    }
  }
}

/**
 * Picks the best available `SecretStore` for this machine: the OS keychain if usable, otherwise
 * the encrypted file store. `platform` defaults to `process.platform` but is injectable so tests
 * can exercise every branch (darwin / linux / anything else) on a single host.
 *
 * Falling back to `encrypted-file` is silent here by design -- printing a notice about it is a UX
 * concern for the command that calls this, not this resolution logic, and keeping this function
 * silent keeps it safe to call from tests without stray console output.
 */
export async function resolveSecretStore(
  platform: NodeJS.Platform = process.platform,
): Promise<{ store: SecretStore; backend: "keychain" | "secret-tool" | "encrypted-file" }> {
  if (platform === "darwin" && binaryResolvable("security")) {
    return { store: new KeychainSecretStore(), backend: "keychain" }
  }

  if (platform === "linux" && binaryResolvable("secret-tool")) {
    const candidate = new SecretToolSecretStore()
    if (await probeSecretTool(candidate)) {
      return { store: candidate, backend: "secret-tool" }
    }
  }

  return { store: new EncryptedFileSecretStore(), backend: "encrypted-file" }
}
