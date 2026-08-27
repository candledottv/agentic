/**
 * `KeychainSecretStore` / `SecretToolSecretStore` / `resolveSecretStore`.
 *
 * These drive real (stub) executables via `child_process.spawn`, never the real macOS Keychain or
 * libsecret -- the stubs live at `$STUB_DIR/security` and `$STUB_DIR/secret-tool`, found only
 * because each test prepends `$STUB_DIR` to `PATH`. Each stub appends its argv to `$ARGV_CAPTURE`
 * and (for stdin-bearing invocations) the full stdin to `$STDIN_CAPTURE`, and backs a tiny
 * per-account file store under `$STUB_STATE_DIR` so store/lookup/clear round-trip like the real
 * thing. The load-bearing assertion throughout: the secret shows up in the stdin capture and NEVER
 * in the argv capture, which is what keeps it out of a `ps` listing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KeychainSecretStore, resolveSecretStore, SecretToolSecretStore } from "./keychain"
import { EncryptedFileSecretStore } from "./secret-store"

const SECURITY_STUB = `#!/bin/bash
# Test stub for macOS's security CLI. Captures argv to $ARGV_CAPTURE and, for -i (command-on-
# stdin) invocations, the full stdin to $STDIN_CAPTURE. Backs a tiny generic-password store with
# one file per account under $STUB_STATE_DIR.
set -u
printf '%s\\n' "$*" >> "$ARGV_CAPTURE"

account_after_flag() {
  local flag="$1"
  shift
  local prev=""
  for arg in "$@"; do
    if [ "$prev" = "$flag" ]; then
      printf '%s' "$arg"
      return 0
    fi
    prev="$arg"
  done
}

if [ "\${1:-}" = "-i" ]; then
  line="$(cat)"
  printf '%s' "$line" >> "$STDIN_CAPTURE"
  account=$(printf '%s' "$line" | sed -n 's/.*-a "\\([^"]*\\)".*/\\1/p')
  if printf '%s' "$line" | grep -q '^add-generic-password'; then
    secret=$(printf '%s' "$line" | sed -n 's/.*-w "\\([^"]*\\)".*/\\1/p')
    exit_code="\${STUB_STORE_EXIT:-0}"
    if [ "$exit_code" = "0" ]; then
      printf '%s' "$secret" > "$STUB_STATE_DIR/$account"
    fi
    exit "$exit_code"
  elif printf '%s' "$line" | grep -q '^delete-generic-password'; then
    rm -f "$STUB_STATE_DIR/$account"
    exit "\${STUB_DELETE_EXIT:-0}"
  fi
  exit 1
fi

if [ "\${1:-}" = "find-generic-password" ]; then
  shift
  account=$(account_after_flag -a "$@")
  if [ -f "$STUB_STATE_DIR/$account" ]; then
    cat "$STUB_STATE_DIR/$account"
    exit 0
  fi
  exit 44
fi

exit 1
`

const SECRET_TOOL_STUB = `#!/bin/bash
# Test stub for libsecret's secret-tool CLI. Same capture + per-account file store as the
# security stub, adapted to store/lookup/clear and secret-tool's "service <svc> account <acct>"
# attribute-pair syntax.
set -u
printf '%s\\n' "$*" >> "$ARGV_CAPTURE"

value_after() {
  local key="$1"
  shift
  local prev=""
  for arg in "$@"; do
    if [ "$prev" = "$key" ]; then
      printf '%s' "$arg"
      return 0
    fi
    prev="$arg"
  done
}

cmd="\${1:-}"
shift || true
account=$(value_after account "$@")

case "$cmd" in
  store)
    secret="$(cat)"
    printf '%s' "$secret" >> "$STDIN_CAPTURE"
    exit_code="\${STUB_STORE_EXIT:-0}"
    if [ "$exit_code" = "0" ]; then
      printf '%s' "$secret" > "$STUB_STATE_DIR/$account"
    fi
    exit "$exit_code"
    ;;
  lookup)
    if [ -f "$STUB_STATE_DIR/$account" ]; then
      cat "$STUB_STATE_DIR/$account"
      exit 0
    fi
    exit 1
    ;;
  clear)
    rm -f "$STUB_STATE_DIR/$account"
    exit "\${STUB_DELETE_EXIT:-0}"
    ;;
  *)
    exit 1
    ;;
esac
`

const WHICH_STUB = `#!/bin/bash
# A minimal real \`which\`: searches each directory in $PATH (in order) for an executable file
# named $1, exiting 0 with its path if found, 1 with no output otherwise -- the same contract the
# real tool has, so binaryResolvable() behaves identically to it. Used by the "binary genuinely
# absent" tests below, so they exercise "which resolves and correctly reports not-found" rather
# than "which itself cannot be found" (a different, also-safe, but different code path).
IFS=':' read -ra dirs <<< "$PATH"
for dir in "\${dirs[@]}"; do
  candidate="$dir/$1"
  if [ -f "$candidate" ] && [ -x "$candidate" ]; then
    printf '%s\\n' "$candidate"
    exit 0
  fi
done
exit 1
`

const ORIGINAL_PATH = process.env.PATH

interface StubEnv {
  dir: string
  argvCapture: string
  stdinCapture: string
  stateDir: string
}

/** Writes the given stub script(s) into a fresh temp dir, prepends that dir to PATH, and wires up
 * the capture-file / state-dir env vars the stubs read. Returns the dir for cleanup. */
async function setUpStubs(scripts: Record<string, string>): Promise<StubEnv> {
  const dir = await mkdtemp(join(tmpdir(), "candle-cli-keychain-"))
  const stateDir = join(dir, "state")
  await mkdir(stateDir, { recursive: true })
  const argvCapture = join(dir, "argv.log")
  const stdinCapture = join(dir, "stdin.log")
  await writeFile(argvCapture, "")
  await writeFile(stdinCapture, "")

  for (const [name, script] of Object.entries(scripts)) {
    const binPath = join(dir, name)
    await writeFile(binPath, script)
    await chmod(binPath, 0o755)
  }

  process.env.PATH = `${dir}:${ORIGINAL_PATH}`
  process.env.ARGV_CAPTURE = argvCapture
  process.env.STDIN_CAPTURE = stdinCapture
  process.env.STUB_STATE_DIR = stateDir

  return { dir, argvCapture, stdinCapture, stateDir }
}

async function tearDownStubs(env: StubEnv): Promise<void> {
  process.env.PATH = ORIGINAL_PATH
  delete process.env.ARGV_CAPTURE
  delete process.env.STDIN_CAPTURE
  delete process.env.STUB_STATE_DIR
  delete process.env.STUB_STORE_EXIT
  delete process.env.STUB_DELETE_EXIT
  await rm(env.dir, { recursive: true, force: true })
}

describe("KeychainSecretStore (macOS `security`)", () => {
  let env: StubEnv

  beforeEach(async () => {
    env = await setUpStubs({ security: SECURITY_STUB })
  })

  afterEach(async () => {
    await tearDownStubs(env)
  })

  test("set writes the secret via stdin and never via argv", async () => {
    const store = new KeychainSecretStore()
    await store.set("device_token", "dtok_super_secret_value")

    const argv = await readFile(env.argvCapture, "utf8")
    const stdin = await readFile(env.stdinCapture, "utf8")
    expect(stdin).toContain("dtok_super_secret_value")
    expect(argv).not.toContain("dtok_super_secret_value")
  })

  test("get returns the value written by set", async () => {
    const store = new KeychainSecretStore()
    await store.set("device_token", "dtok_super_secret_value")
    expect(await store.get("device_token")).toBe("dtok_super_secret_value")
  })

  test("get of an unset ref returns null", async () => {
    const store = new KeychainSecretStore()
    expect(await store.get("never_set")).toBeNull()
  })

  test("delete invokes delete-generic-password (via stdin, -i mode) and removes the entry", async () => {
    const store = new KeychainSecretStore()
    await store.set("device_token", "dtok_super_secret_value")
    await store.delete("device_token")

    const stdin = await readFile(env.stdinCapture, "utf8")
    expect(stdin).toContain("delete-generic-password")
    expect(await store.get("device_token")).toBeNull()
  })

  test("set rejects a value containing a quote, backslash, or newline before spawning anything", async () => {
    const store = new KeychainSecretStore()
    await expect(store.set("device_token", 'has a " quote in it')).rejects.toThrow()
    await expect(store.set("device_token", "has a \\ backslash in it")).rejects.toThrow()
    await expect(store.set("device_token", "has a\nnewline in it")).rejects.toThrow()

    // Nothing was ever spawned: both capture files are still exactly as setUpStubs left them.
    const argv = await readFile(env.argvCapture, "utf8")
    const stdin = await readFile(env.stdinCapture, "utf8")
    expect(argv).toBe("")
    expect(stdin).toBe("")
  })

  test("set and delete reject an unsafe REF, not just an unsafe value, before spawning anything", async () => {
    const store = new KeychainSecretStore()
    // The ref is interpolated into the same quoted command line as the value, so it is the same
    // injection: close the -a token, newline, and the rest of the line is a second command.
    const hostile = `device_token"\ndelete-generic-password -s "tv.candle.cli" -a "api_key`
    await expect(store.set(hostile, "dtok_value")).rejects.toThrow(/quote, backslash, or newline/)
    await expect(store.delete(hostile)).rejects.toThrow(/quote, backslash, or newline/)

    const argv = await readFile(env.argvCapture, "utf8")
    const stdin = await readFile(env.stdinCapture, "utf8")
    expect(argv).toBe("")
    expect(stdin).toBe("")
  })
})

describe("SecretToolSecretStore (linux `secret-tool`)", () => {
  let env: StubEnv

  beforeEach(async () => {
    env = await setUpStubs({ "secret-tool": SECRET_TOOL_STUB })
  })

  afterEach(async () => {
    await tearDownStubs(env)
  })

  test("set writes the secret via stdin and never via argv", async () => {
    const store = new SecretToolSecretStore()
    await store.set("api_key", "ck_live_super_secret_value")

    const argv = await readFile(env.argvCapture, "utf8")
    const stdin = await readFile(env.stdinCapture, "utf8")
    expect(stdin).toContain("ck_live_super_secret_value")
    expect(argv).not.toContain("ck_live_super_secret_value")
  })

  test("get returns the value written by set", async () => {
    const store = new SecretToolSecretStore()
    await store.set("api_key", "ck_live_super_secret_value")
    expect(await store.get("api_key")).toBe("ck_live_super_secret_value")
  })

  test("get of an unset ref returns null", async () => {
    const store = new SecretToolSecretStore()
    expect(await store.get("never_set")).toBeNull()
  })

  test("delete invokes the clear subcommand and removes the entry", async () => {
    const store = new SecretToolSecretStore()
    await store.set("api_key", "ck_live_super_secret_value")
    await store.delete("api_key")

    const argv = await readFile(env.argvCapture, "utf8")
    expect(argv).toContain("clear")
    expect(await store.get("api_key")).toBeNull()
  })
})

describe("resolveSecretStore", () => {
  let env: StubEnv

  afterEach(async () => {
    if (env) await tearDownStubs(env)
  })

  test("darwin + a resolvable `security` binary -> keychain", async () => {
    env = await setUpStubs({ security: SECURITY_STUB })
    const result = await resolveSecretStore("darwin")
    expect(result.backend).toBe("keychain")
    expect(result.store).toBeInstanceOf(KeychainSecretStore)
  })

  test("linux + a resolvable `secret-tool` binary + a successful probe round-trip -> secret-tool", async () => {
    env = await setUpStubs({ "secret-tool": SECRET_TOOL_STUB })
    const result = await resolveSecretStore("linux")
    expect(result.backend).toBe("secret-tool")
    expect(result.store).toBeInstanceOf(SecretToolSecretStore)
  })

  test("linux + `secret-tool` present but the probe fails (store exits 1) -> encrypted-file", async () => {
    env = await setUpStubs({ "secret-tool": SECRET_TOOL_STUB })
    process.env.STUB_STORE_EXIT = "1"
    const result = await resolveSecretStore("linux")
    expect(result.backend).toBe("encrypted-file")
    expect(result.store).toBeInstanceOf(EncryptedFileSecretStore)
  })

  test("darwin with `security` genuinely absent (a real, working `which` reports not-found) -> encrypted-file", async () => {
    // Only `which` is on the stub PATH, not `security` -- this exercises `which` correctly resolving
    // and reporting "not found", as distinct from `which` itself being unresolvable (see the
    // WHICH_STUB comment above and the null-status branch documented on binaryResolvable).
    env = await setUpStubs({ which: WHICH_STUB })
    process.env.PATH = env.dir
    const result = await resolveSecretStore("darwin")
    expect(result.backend).toBe("encrypted-file")
    expect(result.store).toBeInstanceOf(EncryptedFileSecretStore)
  })

  test("linux with `secret-tool` genuinely absent (a real, working `which` reports not-found) -> encrypted-file", async () => {
    env = await setUpStubs({ which: WHICH_STUB })
    process.env.PATH = env.dir
    const result = await resolveSecretStore("linux")
    expect(result.backend).toBe("encrypted-file")
  })

  test("darwin with `which` itself unresolvable on PATH -> encrypted-file (the other, also-safe null-status branch)", async () => {
    env = await setUpStubs({})
    process.env.PATH = env.dir
    const result = await resolveSecretStore("darwin")
    expect(result.backend).toBe("encrypted-file")
    expect(result.store).toBeInstanceOf(EncryptedFileSecretStore)
  })

  test("an unsupported platform (e.g. win32) -> encrypted-file regardless of binaries present", async () => {
    env = await setUpStubs({ security: SECURITY_STUB, "secret-tool": SECRET_TOOL_STUB })
    const result = await resolveSecretStore("win32")
    expect(result.backend).toBe("encrypted-file")
  })
})
