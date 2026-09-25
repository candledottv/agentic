/**
 * T19 (BE-241): the `--json` freeze.
 *
 * `--json` is a contract that agents and the in-process MCP server read, and 0.11.1 touches the
 * failure path of nearly every vault command. The rule, from the spec's section 1.1:
 *
 * - Frozen: every existing key and its type in every payload and failure envelope; every `code`;
 *   every exit code; stdout carries exactly one JSON value and stderr carries only diagnostics.
 * - Allowed: adding an optional key; changing the prose inside `message` or `suggestion`.
 * - Forbidden: a command that answers under `--json` today stops answering; anything becomes
 *   TTY-only.
 *
 * Two halves, one per clause that can actually break. `FROZEN_CODES` is the snapshot taken on this
 * PR's baseline (`staging` at `297bab71`), asserted one-directionally: a code may be added, and none
 * may disappear, because an agent switching on one would silently stop matching. The run fixture is
 * the cheapest universal one -- every command word that answers under `--json`, with no credentials,
 * no vault, no network and no terminal on either end -- and it is what would catch a refusal raised
 * before the mode is known, which is the shape of mistake this PR could have made in `vaultPathFor`.
 */
import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Deps } from "./deps"
import { run } from "./index"
import { createCapture, createTestDeps } from "./test-support"
import { VAULT_ERROR_CODES } from "./vault/errors"

/**
 * Every failure `code` the CLI could put in a `--json` envelope on the baseline. `COMMAND_REMOVED`
 * is deliberately absent: BE-238 removed the 0.10.0 tombstone that threw it (D6) before this PR
 * branched, and nobody ran the releases in between, so no script outside Candle can switch on it.
 */
const FROZEN_CODES: readonly string[] = [
  "ACCOUNT_MISMATCH",
  "BAD_REQUEST",
  "BUNDLE_UNREADABLE",
  "CHAIN_NOT_OFFERED",
  "DESTINATION_NOT_CONFIRMED",
  "DEVICE_NOT_READABLE",
  "DEVICE_TOKEN_INVALID",
  "ENV_PASSPHRASE_REFUSED",
  "EXPORT_TARGET_EXISTS",
  "EXPORT_TARGET_SYMLINK",
  "EXPOSURE_ACCOUNT_MISMATCH",
  "FILE_UNREADABLE",
  "GRANT_BINDING_MISMATCH",
  "GRANT_DESTINATION_UNRESOLVED",
  "GRANT_IDENTITY_MISMATCH",
  "IMPORT_NOT_VISIBLE",
  "INSECURE_API_URL",
  "JOB_NOT_FOUND",
  "KEY_INPUT_FAILED",
  "LEGACY_INCOMPLETE",
  "LEGACY_UNVERIFIED_BACKUP",
  "LIBRARY_MISSING",
  "MANIFEST_INVALID",
  "MCP_SERVER_FAILED",
  "NO_API_KEY",
  "NO_DEVICE_TOKEN",
  "NO_SUCH_PROFILE",
  "PHRASE_INVALID",
  "PHRASE_NOT_CONFIRMED",
  "PHRASE_REQUIRES_TTY",
  "PLUGIN_NOT_FOUND",
  "PLUGIN_WALLET_NOT_EXTERNAL",
  "PROFILE_EXISTS",
  "PROFILE_UNRESOLVED",
  "PROMOTE_ALREADY_TEE_WALLET",
  "PROMOTE_DESTINATION_NOT_COLD",
  "PROMOTE_KEY_IS_PINNED_DESTINATION",
  "PROMOTE_NOT_ACKNOWLEDGED",
  "PROMOTE_NOT_VAULT_KEY",
  "PROMOTE_OUTCOME_UNRESOLVED",
  "PROMOTE_RECONCILE_INCOMPLETE",
  "PROMOTE_SAME_KEY_DESTINATION",
  "PROMOTE_SUBJECT_EXPOSURE_UNKNOWN",
  "RPC_RATE_LIMITED",
  "SCOPE_MISSING",
  "SECRET_MISSING",
  "SECRET_REQUIRES_TTY",
  "SECRET_STORE_FAILED",
  "SIGNATURE_INVALID",
  "SIGNER_COMMIT_FAILED",
  "SIGNER_STORE_FAILED",
  "SIGN_BROADCAST_FAILED",
  "SIGN_LOOKUP_TABLE_UNRESOLVED",
  "SIGN_SIGNER_NOT_EXTERNAL",
  "SIGN_SIGNER_NOT_PROVIDED",
  "SIGN_SIMULATION_FAILED",
  "SIGN_TRANSACTION_UNDECODABLE",
  "STOP_UNCONFIRMED",
  "TEE_KEY_MISMATCH",
  "TEE_STORE_CHANGED",
  "TEE_STORE_LOCKED",
  "TEE_STORE_MISSING",
  "TEE_STORE_PASSPHRASE",
  "TEE_STORE_UNREADABLE",
  "TEE_STORE_WRITE_FAILED",
  "TEE_WALLET_ALREADY_ENABLED",
  "TEE_WALLET_DISABLE_PENDING",
  "TEE_WALLET_NOT_ENABLED",
  "TEE_WALLET_NOT_VERIFIED",
  "TEE_WALLET_NO_VAULT",
  "TEE_WALLET_STATE_UNKNOWN",
  "TEE_WALLET_STATE_UNREAD",
  "TEE_WALLET_STILL_ENABLED",
  "TEE_WALLET_STOPPED",
  "TEE_WALLET_UNKNOWN",
  "UPDATE_NOT_WRITABLE",
  "UPDATE_UNREACHABLE",
  "UPDATE_UNSUPPORTED_PLATFORM",
  "UPDATE_VERIFY_FAILED",
  "USAGE",
  "VAULT_ALLOCATION_BOUNDARY_UNKNOWN",
  "VAULT_AUTHENTICATOR_AMBIGUOUS",
  "VAULT_AUTHENTICATOR_BLOCKED",
  "VAULT_AUTHENTICATOR_CANCELLED",
  "VAULT_AUTHENTICATOR_CHANGED",
  "VAULT_AUTHENTICATOR_NOT_READABLE",
  "VAULT_BACKUP_INSIDE_CONFIG",
  "VAULT_BLOB_TAMPERED",
  "VAULT_CHANGED",
  "VAULT_CREDENTIAL_NOT_PRESENT",
  "VAULT_EXISTS",
  "VAULT_FACTOR_UNAVAILABLE",
  "VAULT_FACTOR_UNSUPPORTED_ON_PLATFORM",
  "VAULT_FIELD_UNKNOWN",
  "VAULT_FORMAT_UNKNOWN",
  "VAULT_HELPER_MISSING",
  "VAULT_HELPER_UNTRUSTED",
  "VAULT_INDEX_INVALID",
  "VAULT_KDF_OUT_OF_BOUNDS",
  "VAULT_LAST_PASSPHRASE",
  "VAULT_LOCKED",
  "VAULT_MISSING",
  "VAULT_NOT_CONFIRMED",
  "VAULT_NO_RECOVERABLE_FACTOR",
  "VAULT_OLDER_COPY",
  "VAULT_PIN_INVALID",
  "VAULT_PIN_REQUIRED",
  "VAULT_PRF_UNSUPPORTED",
  "VAULT_SHARED_DOMAIN",
  "VAULT_UNLOCK_FAILED",
  "VAULT_UNREADABLE",
  "VAULT_UV_UNSUPPORTED",
  "VAULT_VERIFY_FAILED",
  "VAULT_VERSION_UNSUPPORTED",
  "VAULT_WRITE_FAILED",
]

/** Every `code: "X"` literal the shipped source can write, plus every declared `VaultError` code. */
async function codesInSource(): Promise<Set<string>> {
  const root = resolve(import.meta.dir)
  const found = new Set<string>(VAULT_ERROR_CODES)
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!entry.name.endsWith(".ts")) continue
      if (entry.name.endsWith(".test.ts") || entry.name === "test-support.ts") continue
      const src = await readFile(path, "utf8")
      // Both shapes count. A `code: "X"` literal is a code the CLI MINTS; a `code === "X"` or
      // `"X":` comparison is one it recognises off an API error body and passes straight through
      // (`renderError`'s mapping), which is just as much a code an agent switches on.
      for (const match of src.matchAll(/code: "([A-Z0-9_]+)"/g)) found.add(match[1] as string)
      for (const match of src.matchAll(/code === "([A-Z0-9_]+)"/g)) found.add(match[1] as string)
      for (const match of src.matchAll(/^\s{2}([A-Z][A-Z0-9_]{3,}):/gm)) found.add(match[1] as string)
    }
  }
  await walk(root)
  return found
}

describe("T19: no failure code from the baseline has disappeared", () => {
  test("every frozen code is still one the source can write", async () => {
    const found = await codesInSource()
    const gone = FROZEN_CODES.filter((code) => !found.has(code) && code !== "USAGE")
    expect(gone).toEqual([])
  })

  test("the snapshot is a snapshot: no duplicates, and big enough to be the real list", () => {
    expect(new Set(FROZEN_CODES).size).toBe(FROZEN_CODES.length)
    expect(FROZEN_CODES.length).toBeGreaterThan(100)
  })
})

/**
 * Every command word that answers under `--json`. Two are absent, each for a reason that predates
 * this PR and is not its to change:
 *
 * - `tee new` collects the TEE store's own passphrase from a hidden prompt before it can answer at
 *   all, so it is TTY-only today and there is nothing here to freeze.
 * - `wallet import`'s missing-flag report goes to stderr with exit 2 even under `--json`
 *   (`wallets.ts`'s "every missing requirement at once" branch). A real gap, worth its own card;
 *   asserting the current shape here would only pin the gap in place.
 */
const JSON_ANSWERING: { name: string; argv: string[] }[] = [
  { name: "auth status", argv: ["auth", "status"] },
  { name: "doctor", argv: ["doctor"] },
  { name: "keys list", argv: ["keys", "list"] },
  { name: "keys create", argv: ["keys", "create"] },
  { name: "keys wallets list", argv: ["keys", "wallets", "list"] },
  { name: "wallet", argv: ["wallet"] },
  { name: "profile list", argv: ["profile", "list"] },
  { name: "swap", argv: ["swap"] },
  { name: "swap status", argv: ["swap", "status"] },
  // BE-332 PR C: with no flags it is a usage error, like `swap` with no pair.
  { name: "transfer", argv: ["transfer"] },
  { name: "launch", argv: ["launch"] },
  // BE-316: read-only. With no credentials both answer NO_API_KEY before any request.
  { name: "pnl", argv: ["pnl"] },
  { name: "portfolio", argv: ["portfolio"] },
  // BE-315: the LP writes answer usage without a terminal or a key; `lp positions` needs a key
  // before it can answer at all, like `swap` with a full argument list, and is not frozen here.
  { name: "lp pools", argv: ["lp", "pools"] },
  { name: "lp add", argv: ["lp", "add"] },
  { name: "lp remove", argv: ["lp", "remove", "Pos1111"] },
  { name: "lp claim", argv: ["lp", "claim"] },
  { name: "vault status", argv: ["vault", "status"] },
  // BE-274: new surface. Without a terminal it is D7's unlock refusal, exactly as every other
  // command that prompts is.
  { name: "vault list", argv: ["vault", "list"] },
  { name: "vault factor list", argv: ["vault", "factor", "list"] },
  { name: "vault init", argv: ["vault", "init"] },
  { name: "vault new-key", argv: ["vault", "new-key", "--chain", "solana"] },
  // BE-259: new surface. Without a terminal it is the unlock refusal, like every other writer.
  { name: "vault rename", argv: ["vault", "rename", "treasury", "treasury-cold"] },
  { name: "vault phrase show", argv: ["vault", "phrase", "show"] },
  { name: "vault restore", argv: ["vault", "restore", "--phrase"] },
  { name: "vault enroll", argv: ["vault", "enroll", "passphrase"] },
  { name: "vault factor add", argv: ["vault", "factor", "add", "passphrase"] },
  { name: "vault backup", argv: ["vault", "backup", "--to", "/tmp/candle-json-copy.enc"] },
  { name: "vault verify-backup", argv: ["vault", "verify-backup", "/tmp/candle-json-copy.enc"] },
  { name: "vault export-key", argv: ["vault", "export-key", "treasury", "--to", "/tmp/candle-json-key.json"] },
  { name: "vault import-legacy", argv: ["vault", "import-legacy", "--tee"] },
  { name: "vault retire-legacy", argv: ["vault", "retire-legacy"] },
  { name: "vault reconcile-exposure", argv: ["vault", "reconcile-exposure"] },
  { name: "vault transfer", argv: ["vault", "transfer", "Dest1111", "--amount", "1", "--asset", "SOL"] },
  { name: "vault promote", argv: ["vault", "promote", "--in-place", "treasury"] },
  { name: "vault demote", argv: ["vault", "demote", "Addr1111"] },
  { name: "vault fund", argv: ["vault", "fund", "Addr1111", "--amount", "1", "--asset", "SOL"] },
  { name: "tee status", argv: ["tee", "status", "SomeAddress1111"] },
  { name: "tee enable", argv: ["tee", "enable", "Addr1111", "--vault", "Addr2222"] },
  { name: "tee disable", argv: ["tee", "disable", "Addr1111"] },
  { name: "external list", argv: ["external", "list"] },
  { name: "external new", argv: ["external", "new"] },
  { name: "sign", argv: ["sign", "--wallet", "w"] },
  { name: "sign message", argv: ["sign", "message", "--wallet", "w"] },
  { name: "secrets list", argv: ["secrets", "list"] },
  { name: "plugins", argv: ["plugins"] },
  { name: "verify", argv: ["verify"] },
  { name: "update --check", argv: ["update", "--check"] },
]

const offlineFetch = (async () => {
  throw Object.assign(new Error("offline"), { name: "TypeError" })
}) as unknown as typeof fetch

async function jsonRun(argv: string[]): Promise<{ code: number; stdout: string }> {
  const dir = await mkdtemp(join(tmpdir(), "candle-json-"))
  const stdout = createCapture()
  const stderr = createCapture()
  const deps: Deps = createTestDeps({
    fetch: offlineFetch,
    stdout,
    stderr,
    env: { CANDLE_CONFIG_DIR: dir },
    isTTY: { stdin: false, stdout: false, stderr: false },
    promptSecret: async (text: string) => {
      throw new Error(`--json must never prompt: ${text}`)
    },
    promptLine: async (text: string) => {
      throw new Error(`--json must never prompt: ${text}`)
    },
  })
  const code = await run([...argv, "--json"], deps)
  return { code, stdout: stdout.text }
}

describe("T19: every command that answers under --json still answers", () => {
  for (const { name, argv } of JSON_ANSWERING) {
    test(name, async () => {
      const out = await jsonRun(argv)
      const lines = out.stdout.trimEnd().split("\n").filter(Boolean)
      expect(lines, `${name} wrote ${lines.length} lines to stdout`).toHaveLength(1)
      const body = JSON.parse(lines[0] as string) as Record<string, unknown>
      expect(typeof body, `${name} answered with something that is not a JSON object`).toBe("object")
      if (body.ok === false) {
        expect(typeof body.code, `${name} failed without a code`).toBe("string")
        expect(FROZEN_CODES, `${name} answered with a code the baseline never had`).toContain(body.code as string)
      }
      // Exit codes stay the Phase 1 convention: 0 success, 1 failure, 2 usage, 3 pending.
      expect([0, 1, 2, 3]).toContain(out.code)
    })
  }

  /**
   * T12 (BE-274, §4.5): `vault list` mints no error code.
   *
   * Every refusal it can reach is one the vault surface already throws, from a shared helper, and
   * the partial-balance state (D11) is not a refusal at all: it is a success-shaped document plus
   * exit 3, with `balances.complete: false` carrying the machine-readable fact. So `VAULT_ERROR_CODES`
   * is unchanged by this slice, and this is the assertion that says so rather than the diff.
   */
  test("T12: vault list adds no code, and every code it can answer with is already declared", async () => {
    const declared = new Set<string>(VAULT_ERROR_CODES)
    const source = await readFile(resolve(import.meta.dir, "commands", "vault-list.ts"), "utf8")
    expect(source).not.toContain("new VaultError(")
    for (const code of [
      "ENV_PASSPHRASE_REFUSED",
      "VAULT_UNLOCK_FAILED",
      "VAULT_MISSING",
      "VAULT_UNREADABLE",
      "VAULT_FORMAT_UNKNOWN",
      "VAULT_VERSION_UNSUPPORTED",
      "VAULT_FIELD_UNKNOWN",
      "VAULT_KDF_OUT_OF_BOUNDS",
      "VAULT_INDEX_INVALID",
      "VAULT_OLDER_COPY",
      "VAULT_FACTOR_UNAVAILABLE",
    ]) {
      expect(declared.has(code), `${code} is not in VAULT_ERROR_CODES`).toBe(true)
    }
  })

  test("details is the only key this release adds, and it is present only where there is one", async () => {
    const missing = await jsonRun(["vault", "status"])
    expect(Object.keys(JSON.parse(missing.stdout)).sort()).toEqual(["code", "details", "message", "ok", "suggestion"])
    // A usage refusal carries no path facts, so it carries no details.
    const usage = await jsonRun(["vault", "status", "--bogus-flag"])
    expect(Object.keys(JSON.parse(usage.stdout)).sort()).toEqual(["code", "message", "ok"])
  })
})

/**
 * BE-288 (spec `2026-09-23-linked-wallet-cap-before-import-design.md`, §6.4): the three codes the
 * room read adds are declared, and `FROZEN_CODES` above is untouched (additions are allowed; a
 * disappearance is what T19 catches).
 */
describe("BE-288: the linked-wallet room codes are declared", () => {
  test("WALLET_LIMIT_REACHED, TIER_REQUIRED and LINKED_WALLET_ROOM_UNREADABLE are vault codes", () => {
    const declared = new Set<string>(VAULT_ERROR_CODES)
    for (const code of ["WALLET_LIMIT_REACHED", "TIER_REQUIRED", "LINKED_WALLET_ROOM_UNREADABLE"]) {
      expect(declared.has(code), `${code} is not in VAULT_ERROR_CODES`).toBe(true)
    }
  })
})

/**
 * BE-296 (spec `2026-09-23-cli-vault-promote-confirm-design.md`, D5, T16): the one code the live
 * controlled-by read adds is declared, and `FROZEN_CODES` above is untouched.
 */
/**
 * BE-337 (spec `2026-09-24-cli-security-key-authorizes-factor-add-design.md`, D3, D6; T18): the one
 * code `factor add security-key` adds is declared, and `FROZEN_CODES` above is untouched. The three
 * `factor add` payloads gain `openedWith` and nothing else; that is asserted where the commands
 * run, in their own suites.
 */
describe("BE-337: the already-enrolled code is declared", () => {
  test("T18: VAULT_KEY_ALREADY_ENROLLED is a vault code", () => {
    const declared = new Set<string>(VAULT_ERROR_CODES)
    expect(declared.has("VAULT_KEY_ALREADY_ENROLLED")).toBe(true)
  })
})

describe("BE-296: the promote account code is declared", () => {
  test("T16: PROMOTE_ACCOUNT_UNRESOLVED is a vault code, and PROMOTE_NOT_ACKNOWLEDGED still is", () => {
    const declared = new Set<string>(VAULT_ERROR_CODES)
    for (const code of ["PROMOTE_ACCOUNT_UNRESOLVED", "PROMOTE_NOT_ACKNOWLEDGED"]) {
      expect(declared.has(code), `${code} is not in VAULT_ERROR_CODES`).toBe(true)
    }
  })
})
