/**
 * The laptop side of `candle accounts create` (spec docs/superpowers/specs/2026-10-28-cli-account-create-design.md,
 * sections 5 and 6): the fleet runner lock, the owner-controlled files the command reads (the signer
 * receipt, the API-key sibling pin, `activation.json`), the reviewed sibling it starts as its child,
 * and the keychain reads it is allowed to make.
 *
 * Every path here is owner-controlled and fixed: `/Users/a/.claude/ops/fleet` and
 * `/Users/a/.claude/ops/owner-scripts`. No environment variable moves them. Tests inject a whole
 * `AccountsHost` (`Deps.accountsHost`) with temp directories instead, which is the only seam.
 *
 * Nothing here reads the signer `S`'s private half: the signer item is checked for existence only,
 * without `-w`.
 */
import { spawn } from "node:child_process"
import { createHash, createPublicKey } from "node:crypto"
import { readFile } from "node:fs/promises"
import { isAbsolute, normalize } from "node:path"
import { keychainItemExists, readKeychainItem } from "./keychain"

export const FLEET_OPS_DIR = "/Users/a/.claude/ops/fleet"
export const OWNER_SCRIPTS_DIR = "/Users/a/.claude/ops/owner-scripts"
/** The account every fleet keychain item is stored under (fleet R6.6). */
export const FLEET_KEYCHAIN_ACCOUNT = "candle"
/** The owner script that makes `K` (fleet R6.1), named when the identity item is missing. */
export const FLEET_ACCOUNT_SCRIPT = "fleet-account.sh"

export type FleetEnv = "staging" | "local"

export const fleetItem = (env: FleetEnv, name: string, kind: "sol" | "signer" | "apikey") =>
  `candle-fleet-${env}-${name}-${kind}`

/** A held lock. `release` ends the holder and resolves once the OS has dropped the lock. */
export interface RunnerLock {
  release(): Promise<void>
}

export type LockResult = { ok: true; lock: RunnerLock } | { ok: false; reason: "held" | "unavailable"; detail?: string }

export type SiblingResult = { ok: true } | { ok: false; exitCode: number | null; detail: string }

/**
 * Everything `accounts create` touches outside the API. The live host reads the fixed owner paths and
 * the real `security`; a test passes its own.
 */
export interface AccountsHost {
  /** `/Users/a/.claude/ops/fleet`: `runner.lock`, `activation.json`, the pin, `signer-receipts/`. */
  opsDir: string
  /** `/Users/a/.claude/ops/owner-scripts`: the only directory a pinned sibling may live in. */
  ownerScriptsDir: string
  /** fleet R9.3: one OS-enforced exclusive lock, taken without waiting. */
  acquireLock(path: string): Promise<LockResult>
  /** `security find-generic-password -s <item> -a candle` (no `-w`). */
  itemExists(item: string): Promise<boolean>
  /** `security find-generic-password -s <item> -a candle -w`: the identity item `K` only. */
  readItem(item: string): Promise<string | null>
  readFile(path: string): Promise<Uint8Array | null>
  /** Starts the pinned sibling as this process's child, the API key on its stdin and nowhere else. */
  runSibling(path: string, args: string[], secret: Uint8Array): Promise<SiblingResult>
}

// ---- the runner lock (fleet R9.3) -------------------------------------------------------------

/**
 * `flock(2)` on `runner.lock`, held by a `/usr/bin/perl` child for as long as its stdin is open.
 * Node has no `flock`, and an `O_EXCL` file is not an OS lock: a crashed holder leaves it behind.
 * A `flock` dies with its holder, and the holder dies when this process does (its stdin closes), so
 * a killed CLI never wedges the fleet. Exit 75 is "held by someone else".
 */
const LOCK_SCRIPT = [
  "use Fcntl qw(:flock O_RDWR O_CREAT);",
  "sysopen(my $fh, $ARGV[0], O_RDWR | O_CREAT, 0600) or exit 3;",
  "flock($fh, LOCK_EX | LOCK_NB) or exit 75;",
  '$| = 1; print "locked\\n";',
  "1 while sysread(STDIN, my $b, 1);",
  "exit 0;",
].join(" ")

export function flockRunnerLock(path: string, perl = "/usr/bin/perl"): Promise<LockResult> {
  return new Promise((resolve) => {
    let settled = false
    const done = (result: LockResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const child = spawn(perl, ["-e", LOCK_SCRIPT, path], { stdio: ["pipe", "pipe", "ignore"] })
    child.stdin.on("error", () => {})
    const closed = new Promise<void>((r) => child.on("close", () => r()))
    child.on("error", (error) => done({ ok: false, reason: "unavailable", detail: error.message }))
    child.on("close", (code) => {
      if (code === 75) done({ ok: false, reason: "held" })
      else done({ ok: false, reason: "unavailable", detail: `the lock holder exited ${code}` })
    })
    child.stdout.on("data", (chunk: Buffer) => {
      if (!chunk.toString("utf8").includes("locked")) return
      done({
        ok: true,
        lock: {
          release: async () => {
            child.stdin.end()
            await closed
          },
        },
      })
    })
  })
}

// ---- owner-controlled files -------------------------------------------------------------------

export interface SignerReceipt {
  item: string
  spkiDerBase64: string
  spkiSha256: string
  sealedFile: string
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string }

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    return undefined
  }
}

export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** Section 6, "Signer receipt": every field present, version 1, this item, two recipients, a P-256 SPKI. */
export function parseSignerReceipt(
  bytes: Uint8Array | null,
  expected: { env: FleetEnv; name: string; item: string },
): Parsed<SignerReceipt> {
  if (bytes === null) return { ok: false, reason: "the receipt is missing" }
  const receipt = parseJson(bytes)
  if (!isObject(receipt)) return { ok: false, reason: "the receipt is not a JSON object" }
  for (const field of [
    "env",
    "name",
    "item",
    "spkiDerBase64",
    "spkiSha256",
    "sealedFile",
    "scriptSha256",
    "createdAt",
  ]) {
    if (typeof receipt[field] !== "string" || receipt[field] === "") {
      return { ok: false, reason: `the receipt has no ${field}` }
    }
  }
  if (receipt.version !== 1) return { ok: false, reason: "the receipt's version is not 1" }
  if (receipt.env !== expected.env || receipt.name !== expected.name) {
    return { ok: false, reason: "the receipt names another env or fleet name" }
  }
  if (receipt.item !== expected.item) return { ok: false, reason: `the receipt names ${receipt.item}, not this item` }
  if (receipt.recipients !== 2) return { ok: false, reason: "the receipt does not record exactly 2 recipients" }
  const spki = receipt.spkiDerBase64 as string
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(spki)) return { ok: false, reason: "the receipt's SPKI is not base64" }
  const der = Buffer.from(spki, "base64")
  let p256 = false
  try {
    const key = createPublicKey({ key: der, format: "der", type: "spki" })
    p256 = key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1"
  } catch {
    p256 = false
  }
  if (!p256) return { ok: false, reason: "the receipt's SPKI is not a P-256 public key" }
  if (sha256Hex(der) !== receipt.spkiSha256)
    return { ok: false, reason: "the receipt's SPKI does not hash to spkiSha256" }
  return {
    ok: true,
    value: {
      item: receipt.item as string,
      spkiDerBase64: spki,
      spkiSha256: receipt.spkiSha256 as string,
      sealedFile: receipt.sealedFile as string,
    },
  }
}

export interface SiblingPin {
  path: string
  sha256: string
}

/** Section 6, "Sibling pin": version 1, an absolute path inside the owner-scripts directory, a sha256. */
export function parseSiblingPin(bytes: Uint8Array | null, ownerScriptsDir: string): Parsed<SiblingPin> {
  if (bytes === null) return { ok: false, reason: "the sibling pin is missing" }
  const pin = parseJson(bytes)
  if (!isObject(pin)) return { ok: false, reason: "the sibling pin is not a JSON object" }
  if (pin.version !== 1) return { ok: false, reason: "the sibling pin's version is not 1" }
  const { path, sha256, approvedRef } = pin
  if (typeof approvedRef !== "string" || approvedRef === "") return { ok: false, reason: "the pin has no approvedRef" }
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
    return { ok: false, reason: "the pin's sha256 is not 64 lowercase hex characters" }
  }
  const dir = `${normalize(ownerScriptsDir).replace(/\/+$/, "")}/`
  if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path || !path.startsWith(dir)) {
    return { ok: false, reason: `the pin's path is not a file under ${dir}` }
  }
  return { ok: true, value: { path, sha256 } }
}

/**
 * D10: whether `activation.json` approves unattended invocation. Only the exact value `true` of
 * `accountsCreateUnattended` does. Absent, unreadable or anything else is off.
 */
export function unattendedApproved(bytes: Uint8Array | null): boolean {
  if (bytes === null) return false
  const activation = parseJson(bytes)
  return isObject(activation) && activation.accountsCreateUnattended === true
}

// ---- the live host ----------------------------------------------------------------------------

async function readOrNull(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path))
  } catch {
    return null
  }
}

/** The sibling's own output is diagnostics for the owner; only its first line is kept, as a reason. */
function runSiblingChild(path: string, args: string[], secret: Uint8Array): Promise<SiblingResult> {
  return new Promise((resolve) => {
    const child = spawn(path, args, { stdio: ["pipe", "ignore", "pipe"], env: process.env })
    let stderr = ""
    child.stdin.on("error", () => {})
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 2_000) stderr += chunk.toString("utf8")
    })
    child.on("error", (error) => resolve({ ok: false, exitCode: null, detail: error.message }))
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true })
      else resolve({ ok: false, exitCode: code, detail: stderr.split(/\r?\n/, 1)[0] ?? "" })
    })
    child.stdin.write(secret)
    child.stdin.end()
  })
}

export function liveAccountsHost(): AccountsHost {
  return {
    opsDir: FLEET_OPS_DIR,
    ownerScriptsDir: OWNER_SCRIPTS_DIR,
    acquireLock: (path) => flockRunnerLock(path),
    itemExists: (item) => keychainItemExists(item, FLEET_KEYCHAIN_ACCOUNT),
    readItem: (item) => readKeychainItem(item, FLEET_KEYCHAIN_ACCOUNT),
    readFile: readOrNull,
    runSibling: runSiblingChild,
  }
}
