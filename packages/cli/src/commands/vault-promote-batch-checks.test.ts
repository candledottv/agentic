/**
 * `candle vault promote-batch`, second half: --json (BE-285 T-J), --accept-unknown-exposure, the
 * projection helper, the linked-wallet room (BE-288), and the controlled-by block, live account read
 * and role check (BE-296).
 *
 * Split from `vault-promote-batch.test.ts` so that neither file sets the floor of a CI test shard.
 * Fake API and fake RPC; real vault format, real unlock, real commits, through the shared harness in
 * `__fixtures__/promote-batch.ts`.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { base58, base64 } from "@scure/base"
import { jsonResponse, type RouteHandler } from "../test-support"
import type { KeyEntry } from "../vault/format"
import { wipe } from "../vault/hygiene"
import { applyPromotion, confirmPrompt, promoteSentence, SENTENCE_PREFIX } from "../vault/promote-support"
import { REQUESTS_PER_KEY, ROLE_GROUP_IDS, STAKE_PROGRAM_ID } from "../vault/signer-roles"
import { closeVault, decryptKey } from "../vault/store"
import { makeVault, useCheapKdf } from "../vault/test-vault"
import {
  ACCOUNT,
  API,
  API_KEY,
  batchRefusal,
  controlledByBlock,
  DEVICE_TOKEN,
  type Fixture,
  fixture,
  grantedWallets,
  jsonDocuments,
  KEY_LABEL,
  KEY_PREFIX,
  newKeys,
  openVault,
  type ProgramAccountsCall,
  pairsFile,
  readEntries,
  runBatch,
  seed,
  teeSeed,
  USERNAME,
} from "./__fixtures__/promote-batch"

setDefaultTimeout(180_000)
useCheapKdf()

describe("T-J1, T-J2, T-J3: --json", () => {
  test("T-J1: exactly one document; complete false and exit 3 when an import is not verified-active; no secret anywhere", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, {
      file,
      ack: "correct",
      json: true,
      api: { remoteAuthority: (address) => (address === f.addresses.b ? "unknown" : "verified-active") },
    })
    expect(o.code).toBe(3)
    const docs = jsonDocuments(o.out)
    expect(docs).toHaveLength(1)
    const body = JSON.parse(docs[0] as string)
    expect(body).toMatchObject({ ok: true, complete: false, file, rows: 2, promoted: 2, resumed: 0, skipped: 0 })
    expect(body.keys.map((k: { remoteAuthority: string }) => k.remoteAuthority)).toEqual(["verified-active", "unknown"])
    expect(body.keys[0]).toEqual({
      line: 1,
      label: "a",
      address: f.addresses.a,
      destination: f.addresses.cold,
      state: "promoted",
      lifecycle: "enabled",
      linkedWalletId: `lw_${(f.addresses.a as string).slice(0, 6)}`,
      remoteAuthority: "verified-active",
      importCalls: 1,
    })
    // No secret: neither key's base58 private key appears on either stream.
    const v = await openVault(f)
    try {
      for (const label of ["a", "b"]) {
        const entry = v.index.entries.find((e) => e.label === label) as KeyEntry
        const secret = await decryptKey(v, entry.id)
        try {
          const encoded = base58.encode(secret)
          expect(o.out).not.toContain(encoded)
          expect(o.err).not.toContain(encoded)
        } finally {
          wipe(secret)
        }
      }
    } finally {
      closeVault(v)
    }
  })

  test("T-J3: a runTeeImport failure and a resumePromote failure under --json each leave exactly one document, the batch's", async () => {
    // runTeeImport: the second submit fails.
    const f = await fixture(["a", "b", "c", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\nc cold\n")
    const o = await runBatch(f, {
      file,
      ack: "correct",
      json: true,
      api: {
        submit: (n) =>
          n === 2
            ? jsonResponse(503, { success: false, error: { code: "PRIVY_DOWN", message: "privy down" } })
            : undefined,
      },
    })
    expect(o.code).toBe(1)
    const docs = jsonDocuments(o.out)
    expect(docs).toHaveLength(1)
    const body = JSON.parse(docs[0] as string)
    expect(body).toMatchObject({
      ok: false,
      complete: false,
      promoted: 1,
      failedLine: 2,
      code: "PRIVY_DOWN",
      message: "privy down",
    })
    expect(body.keys).toHaveLength(1)
    expect(o.err).toContain("1 of 3 rows landed and ARE in the vault")

    // resumePromote: Phase B reads a grant, the loop's second read finds nothing (unresolved, exit 3).
    const g = await fixture(["x", "ip", "cold"])
    const cold = g.addresses.cold as string
    await seed(g, (e) => (e.label === "ip" ? { ...e, ...teeSeed("import-pending", cold, { grant: true }) } : e))
    const file2 = await pairsFile(g.dir, "ip cold\nx cold\n")
    const r = await runBatch(g, {
      file: file2,
      ack: "correct",
      json: true,
      api: {
        wallets: [
          grantedWallets([{ address: g.addresses.ip as string, vaultDestination: cold }]),
          () => jsonResponse(200, { page: [], isDone: true }),
        ],
      },
    })
    expect(r.code).toBe(3)
    const rdocs = jsonDocuments(r.out)
    expect(rdocs).toHaveLength(1)
    expect(JSON.parse(rdocs[0] as string)).toMatchObject({
      ok: false,
      complete: false,
      failedLine: 1,
      code: "PROMOTE_OUTCOME_UNRESOLVED",
      promoted: 0,
      resumed: 0,
    })
    // Row 2 was not attempted (D12).
    expect(r.submits.n).toBe(0)
  })

  test("T-J2: no TTY refuses with the shipped VAULT_UNLOCK_FAILED; CANDLE_KEYSTORE_PASSPHRASE is refused first", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const pipe = await runBatch(f, { file, json: true, tty: false })
    expect(pipe.code).toBe(1)
    expect(JSON.parse(pipe.out)).toMatchObject({ ok: false, code: "VAULT_UNLOCK_FAILED" })
    expect(String(JSON.parse(pipe.out).message)).toContain("vault promote-batch needs a terminal")
    const env = await runBatch(f, { file, json: true, env: { CANDLE_KEYSTORE_PASSPHRASE: "x" } })
    expect(env.code).toBe(1)
    expect(JSON.parse(env.out)).toMatchObject({ ok: false, code: "ENV_PASSPHRASE_REFUSED" })
    expect(pipe.secretPrompts + env.secretPrompts).toBe(0)
  })
})

describe("--accept-unknown-exposure applies to every row and is visible per row", () => {
  test("rows admitted by the flag are promote* in the table and listed in the footer; without it they refuse", async () => {
    const f = await fixture(["a", "b", "cold"])
    await seed(f, (e) =>
      e.label === "cold"
        ? { ...e, exposure: { everRemoteExposed: false, everExported: false, exposureUnknown: true } }
        : e,
    )
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const refused = await runBatch(f, { file, json: true })
    expect(refused.code).toBe(1)
    expect(batchRefusal(refused).rows.map((row) => row.code)).toEqual([
      "PROMOTE_DESTINATION_NOT_COLD",
      "PROMOTE_DESTINATION_NOT_COLD",
    ])
    const admitted = await runBatch(f, { file, ack: "correct", args: ["--accept-unknown-exposure"] })
    expect(admitted.code).toBe(0)
    expect(admitted.err).toMatch(/^1\s+promote\*\s+a\s/m)
    expect(admitted.err).toContain("2 rows needed --accept-unknown-exposure (promote*): a, b")
    const after = await readEntries(f)
    expect(after.entries.find((e) => e.label === "a")?.tee?.destinationExposureAccepted).toBe(true)
  })
})

describe("the projection helper the loop and the preflight share", () => {
  test("applyPromotion moves the subject to tee-wallet / import-pending with its pin and records the exposed index", async () => {
    const f = await fixture(["a", "cold"])
    const v = await openVault(f)
    try {
      const subject = v.index.entries.find((e) => e.label === "a") as KeyEntry
      const destination = v.index.entries.find((e) => e.label === "cold") as KeyEntry
      const next = applyPromotion(v.index, subject, destination, {
        now: "2026-09-22T22:41:07.000Z",
        acceptUnknownExposure: false,
      })
      const moved = next.entries.find((e) => e.id === subject.id) as KeyEntry
      expect(moved.role).toBe("tee-wallet")
      expect(moved.tee).toEqual({
        network: "solana-mainnet",
        lifecycle: "import-pending",
        vaultDestination: destination.address,
        promotedInPlaceAt: "2026-09-22T22:41:07.000Z",
      })
      expect(moved.exposure).toEqual({ everRemoteExposed: true, everExported: false })
      expect(next.hd.exposedIndexes.solanaVault).toEqual([0])
      // The original is untouched: a projection is a copy.
      expect(v.index.entries.find((e) => e.id === subject.id)?.role).toBe("vault")
    } finally {
      closeVault(v)
    }
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
// BE-288 (spec `2026-09-23-linked-wallet-cap-before-import-design.md`, §6.2): the room is read
// before the table, the whole batch is refused when its `promote` rows exceed it, and a definite
// init answer puts the row's pre-import entry back.
// ══════════════════════════════════════════════════════════════════════════════════════════════

const roomOf =
  (room: { tier: string; active: number; cap: number }): RouteHandler =>
  () =>
    jsonResponse(200, { success: true, ...room, room: Math.max(0, room.cap - room.active) })

const RESTORED = "The vault entry is back as it was: nothing left this machine."
const LIMIT_MESSAGE =
  "Active linked-wallet limit reached for this tier: 10 of 10 active. Nothing was sent to the wallet provider."
const LIMIT_HINT = "You have reached your trading-wallet limit for this tier. Revoke one or upgrade."
const limitRefusal = () =>
  jsonResponse(400, {
    success: false,
    error: {
      code: "WALLET_LIMIT_REACHED",
      message: LIMIT_MESSAGE,
      retryable: false,
      uiHint: LIMIT_HINT,
      linkedWallets: { active: 10, cap: 10 },
      keyImported: false,
    },
  })
const IMPORT_FAILED_MESSAGE = "Wallet import could not be started. Please try again."
const importFailed = () =>
  jsonResponse(400, {
    success: false,
    error: { code: "WALLET_IMPORT_FAILED", message: IMPORT_FAILED_MESSAGE, retryable: true },
  })

describe("BE-288 C1, C2: a Pro account with 146 promote rows is refused at preflight, zero writes", () => {
  test("C1: the §4.1 stderr text exactly, exit 1, vault bytes identical, no import request, no RPC, no prompt; C2: the --json document is the only thing on stdout", async () => {
    const made = await makeVault()
    closeVault(made.vault)
    const f: Fixture = { dir: made.dir, path: made.path, passphrase: made.passphrase, addresses: {} }
    const keys = await newKeys(f.dir, f.passphrase, 151)
    const labels = Object.keys(keys)
    const dests = labels.slice(146, 151)
    const file = await pairsFile(
      f.dir,
      `${labels
        .slice(0, 146)
        .map((label, i) => `${label} ${dests[i % 5]}`)
        .join("\n")}\n`,
    )
    const before = await readFile(f.path, "utf8")
    const message =
      "This batch would link 146 wallets to this Candle account, and it has room for 10: 0 of 10 linked wallets are active on the Pro tier. Nothing was written."
    const suggestion =
      "Upgrade to Max, revoke linked wallets you no longer use, or split the file so this run acts on at most 10 rows. Promotion is irreversible, so no row runs until every row can link."

    const o = await runBatch(f, { file, api: { room: roomOf({ tier: "pro", active: 0, cap: 10 }) } })
    expect(o.code).toBe(1)
    // §4.1's transcript starts after the unlock: everything from the first progress line on.
    expect(o.err.slice(o.err.indexOf("✓"))).toBe(
      `✓ 146 rows read from ${file}\n✓ preflight: 146 rows, 5 destinations, no conflicts\n${message} ${suggestion}\n`,
    )
    expect(o.out).toBe("")
    expect(await readFile(f.path, "utf8")).toBe(before)
    expect(o.inits.n).toBe(0)
    expect(o.submits.n).toBe(0)
    expect(o.rpc.getMultipleAccounts).toBe(0)
    expect(o.rpc.getTokenAccountsByOwner).toBe(0)
    expect(o.linePrompts).toEqual([])

    const j = await runBatch(f, { file, json: true, api: { room: roomOf({ tier: "pro", active: 0, cap: 10 }) } })
    expect(j.code).toBe(1)
    expect(j.out).toBe(
      `${JSON.stringify({
        ok: false,
        code: "WALLET_LIMIT_REACHED",
        message,
        suggestion,
        details: { acting: "146", active: "0", cap: "10", room: "10", tier: "pro" },
      })}\n`,
    )
    expect(await readFile(f.path, "utf8")).toBe(before)
    expect(j.inits.n).toBe(0)
    expect(j.linePrompts).toEqual([])
  })
})

describe("BE-288 C3: only promote rows take room", () => {
  test("140 skip rows and 6 promote rows pass with room 6, and the footer carries the §4.3 line", async () => {
    const made = await makeVault()
    closeVault(made.vault)
    const f: Fixture = { dir: made.dir, path: made.path, passphrase: made.passphrase, addresses: {} }
    const keys = await newKeys(f.dir, f.passphrase, 147)
    const labels = Object.keys(keys)
    const destLabel = labels[146] as string
    const dest = keys[destLabel] as string
    const skipped = new Set(labels.slice(0, 140))
    await seed(f, (e) =>
      skipped.has(e.label) ? { ...e, ...teeSeed("enabled", dest, { linked: true, grant: true }) } : e,
    )
    const file = await pairsFile(
      f.dir,
      `${labels
        .slice(0, 146)
        .map((label) => `${label} ${destLabel}`)
        .join("\n")}\n`,
    )
    const o = await runBatch(f, { file, lines: ["no"], api: { room: roomOf({ tier: "pro", active: 4, cap: 10 }) } })
    // The acknowledgement was refused, so nothing ran; the point is that the room check passed
    // 146 rows against a room of 6, and said so in the footer.
    expect(o.code).toBe(1)
    expect(o.err).toContain("140 already promoted (skipped), 0 to resume, 6 to promote.")
    expect(o.err).toContain("Linked wallets: 4 of 10 active on the Pro tier; this run links 6, leaving 0.")
    expect(o.err).not.toContain("This batch would link")
    expect(o.linePrompts).toEqual([confirmPrompt(6)])
    expect(o.inits.n).toBe(0)
  })
})

describe("BE-288 C4, C5: an unreadable room refuses, and so does a tier with no cap", () => {
  test("C4: a 404, a thrown fetch, and a body without numbers each refuse with LINKED_WALLET_ROOM_UNREADABLE and zero writes", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const before = await readFile(f.path, "utf8")
    const rooms: Array<[string, RouteHandler]> = [
      ["HTTP 404", () => jsonResponse(404, { success: false, error: { code: "NOT_FOUND", message: "Not Found" } })],
      [
        "Could not reach",
        () => {
          throw new Error("connection refused")
        },
      ],
      ["the response carried no numeric active and cap", () => jsonResponse(200, { success: true })],
    ]
    for (const [reason, room] of rooms) {
      const o = await runBatch(f, { file, json: true, api: { room } })
      expect(o.code).toBe(1)
      const docs = jsonDocuments(o.out)
      expect(docs).toHaveLength(1)
      const body = JSON.parse(docs[0] as string)
      expect(body.code).toBe("LINKED_WALLET_ROOM_UNREADABLE")
      expect(body.message).toContain("Could not read how many linked wallets this account has room for (")
      expect(body.message).toContain(reason)
      expect(body.message).toContain("Nothing was written.")
      expect(body.suggestion).toContain("an API older than this CLI answers 404 here until it is updated")
      expect(await readFile(f.path, "utf8")).toBe(before)
      expect(o.inits.n).toBe(0)
      expect(o.rpc.getMultipleAccounts).toBe(0)
      expect(o.linePrompts).toEqual([])
    }
  })

  test("C5: a Free account (cap 0) refuses with TIER_REQUIRED before any write", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const before = await readFile(f.path, "utf8")
    const o = await runBatch(f, { file, api: { room: roomOf({ tier: "free", active: 0, cap: 0 }) } })
    expect(o.code).toBe(1)
    expect(o.err).toContain(
      "Linked wallets need the Pro or Max tier, and this account is on Free. Nothing was written.",
    )
    expect(await readFile(f.path, "utf8")).toBe(before)
    expect(o.inits.n).toBe(0)
    expect(o.linePrompts).toEqual([])
  })
})

describe("BE-288 C6, C7, C12: a mid-run refusal at init restores the row; at submit it does not", () => {
  test("C6: row 3's init answers WALLET_LIMIT_REACHED: rows 1-2 enabled, row 3's entry back field for field, no submit for it, the restore sentence in the stopped message", async () => {
    const f = await fixture(["a", "b", "c", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\nc cold\n")
    const before = await readEntries(f)
    const o = await runBatch(f, {
      file,
      ack: "correct",
      api: { room: roomOf({ tier: "pro", active: 0, cap: 10 }), init: (n) => (n === 3 ? limitRefusal() : undefined) },
    })
    expect(o.code).toBe(1)
    expect(o.inits.n).toBe(3)
    expect(o.submits.addresses).toEqual([f.addresses.a as string, f.addresses.b as string])
    expect(o.err).toContain("2 of 3 rows landed and ARE in the vault; the vault is intact. 1 remain.")
    expect(o.err).toContain(`${LIMIT_MESSAGE} ${RESTORED} ${LIMIT_HINT}\n`)
    const after = await readEntries(f)
    const by = (entries: KeyEntry[], label: string) => entries.find((e) => e.label === label)
    expect(["a", "b"].map((l) => by(after.entries, l)?.tee?.lifecycle)).toEqual(["enabled", "enabled"])
    expect(by(after.entries, "c")).toEqual(by(before.entries, "c"))
    expect(by(after.entries, "c")?.role).toBe("vault")
    expect(by(after.entries, "c")?.tee).toBeUndefined()
    expect(by(after.entries, "c")?.exposure).toEqual(by(before.entries, "c")?.exposure)
  })

  test("C7: row 3's submit answers WALLET_LIMIT_REACHED with keyImported false: the row stays import-pending, everRemoteExposed, and no restore sentence", async () => {
    const f = await fixture(["a", "b", "c", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\nc cold\n")
    const o = await runBatch(f, {
      file,
      ack: "correct",
      api: { room: roomOf({ tier: "pro", active: 0, cap: 10 }), submit: (n) => (n === 3 ? limitRefusal() : undefined) },
    })
    expect(o.code).toBe(1)
    expect(o.submits.n).toBe(3)
    expect(o.err).toContain(LIMIT_MESSAGE)
    expect(o.err).not.toContain(RESTORED)
    const after = await readEntries(f)
    const c = after.entries.find((e) => e.label === "c")
    expect(c?.role).toBe("tee-wallet")
    expect(c?.tee?.lifecycle).toBe("import-pending")
    expect(c?.exposure?.everRemoteExposed).toBe(true)
  })

  test("C12: row 3's init answers WALLET_IMPORT_FAILED (D3): the row is back, the stopped line is the D9 sentence pair, no submit for it", async () => {
    const f = await fixture(["a", "b", "c", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\nc cold\n")
    const before = await readEntries(f)
    const o = await runBatch(f, {
      file,
      ack: "correct",
      api: { room: roomOf({ tier: "pro", active: 0, cap: 10 }), init: (n) => (n === 3 ? importFailed() : undefined) },
    })
    expect(o.code).toBe(1)
    expect(o.submits.addresses).toEqual([f.addresses.a as string, f.addresses.b as string])
    expect(o.err).toContain(`\n${IMPORT_FAILED_MESSAGE} ${RESTORED}\n`)
    const after = await readEntries(f)
    expect(after.entries.find((e) => e.label === "c")).toEqual(before.entries.find((e) => e.label === "c"))

    // Under --json the stopped document carries the same message, and stage/status are not in it.
    const g = await fixture(["x", "y", "cold"])
    const file2 = await pairsFile(g.dir, "x cold\ny cold\n")
    const j = await runBatch(g, {
      file: file2,
      ack: "correct",
      json: true,
      api: { room: roomOf({ tier: "pro", active: 0, cap: 10 }), init: (n) => (n === 1 ? importFailed() : undefined) },
    })
    expect(j.code).toBe(1)
    const docs = jsonDocuments(j.out)
    expect(docs).toHaveLength(1)
    const body = JSON.parse(docs[0] as string)
    expect(body).toMatchObject({
      ok: false,
      complete: false,
      promoted: 0,
      failedLine: 1,
      code: "WALLET_IMPORT_FAILED",
      message: `${IMPORT_FAILED_MESSAGE} ${RESTORED}`,
    })
    expect(body.stage).toBeUndefined()
    expect(body.status).toBeUndefined()
    expect(body.suggestion).toBeUndefined()
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
// BE-296 (spec `2026-09-23-cli-vault-promote-confirm-design.md`, §6): the controlled-by block, the
// live account read, the always-on role check, the `authority` column, the `line` header, --json.

/** The D6 group a `getProgramAccounts` belongs to, from its program and filter shape. */
function groupOfCall(call: ProgramAccountsCall): string {
  const dataSize = call.filters.find((f) => f.dataSize !== undefined)?.dataSize
  const offsets = call.filters.map((f) => f.memcmp?.offset).filter((o): o is number => o !== undefined)
  if (call.programId === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
    return offsets.includes(46) ? "token-freeze" : "token-mint"
  if (call.programId === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")
    return offsets.includes(46) ? "token2022-freeze" : "token2022-mint"
  if (call.programId === "BPFLoaderUpgradeab1e11111111111111111111111")
    return offsets.includes(12) ? "program-upgrade" : "program-resolve"
  if (call.programId === STAKE_PROGRAM_ID && dataSize === 200)
    return offsets.includes(44) ? "stake-withdrawer" : "stake-staker"
  throw new Error(`unrecognised getProgramAccounts ${call.programId} ${JSON.stringify(call.filters)}`)
}

/** Whether the request's key bytes are this address (the key sits at the end of the memcmp bytes). */
function isFor(call: ProgramAccountsCall, address: string): boolean {
  const key = Buffer.from(base58.decode(address))
  return call.filters.some((f) => {
    if (f.memcmp === undefined) return false
    const bytes = Buffer.from(f.memcmp.bytes, "base64")
    return bytes.length >= key.length && bytes.subarray(bytes.length - key.length).equals(key)
  })
}

describe("BE-296 T5, T5a: the controlled-by block", () => {
  test("T5: username, shortened account, 8-character prefix, label in parentheses with a device token, profile source, full URL and environment; the secret appears nowhere", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, { file, ack: "correct", deviceToken: true })
    expect(o.code).toBe(0)
    const block = controlledByBlock(2, { label: KEY_LABEL })
    expect(o.err).toContain(block)
    // Directly above the prompt: the block is the last stderr output before `confirm` is asked.
    expect(o.stderrAtPrompt[0]?.endsWith(`\n${block}\n`)).toBe(true)
    expect(o.err).not.toContain(API_KEY)
    expect(o.out).not.toContain(API_KEY)
    expect(o.err).not.toContain(DEVICE_TOKEN)
    expect(o.err).not.toContain(KEY_PREFIX.padEnd(43, "x"))
    // The label read used the device token, never the API key.
    const keysCall = o.calls.find((call) => call.url.endsWith("/api/v1/agent/keys"))
    expect(keysCall).toBeDefined()
    const headers = (keysCall?.init.headers ?? {}) as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${DEVICE_TOKEN}`)
    expect(headers["x-api-key"]).toBeUndefined()
  })

  test("T5: CANDLE_API_KEY as the source when the env var supplies the key; (no username) when the account has none", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const env = await runBatch(f, {
      file,
      lines: ["no"],
      noApiKey: true,
      env: { CANDLE_API_KEY: API_KEY },
      json: true,
      api: { embedded: () => jsonResponse(200, { success: true, account: ACCOUNT }) },
    })
    expect(env.code).toBe(1)
    expect(env.err).toContain(`  API key         ${KEY_PREFIX}…  CANDLE_API_KEY`)
    expect(env.err).toContain(`  Candle account  (no username)  (${ACCOUNT.slice(0, 6)}…${ACCOUNT.slice(-4)})`)
    // No profile key, no device token: nothing reads the label, and the run still reaches the prompt.
    expect(env.calls.some((call) => call.url.endsWith("/api/v1/agent/keys"))).toBe(false)
    expect(env.linePrompts).toEqual([confirmPrompt(2)])
  })

  test("T5a: no parenthesis, no extra line, and the run still reaches the prompt when the label cannot be read", async () => {
    const cases: Array<{ name: string; deviceToken: boolean; keys?: RouteHandler }> = [
      { name: "no device token", deviceToken: false },
      {
        name: "401",
        deviceToken: true,
        keys: () => jsonResponse(401, { success: false, error: { code: "UNAUTHORIZED", message: "no" } }),
      },
      { name: "500", deviceToken: true, keys: () => jsonResponse(500, { success: false }) },
      {
        name: "network error",
        deviceToken: true,
        keys: () => {
          throw new Error("ECONNRESET")
        },
      },
      {
        name: "no row with the prefix",
        deviceToken: true,
        keys: () =>
          jsonResponse(200, {
            keys: [{ keyPrefix: "someone", label: "theirs", scopes: [], environment: "production", createdAt: 1 }],
          }),
      },
      {
        name: "empty label",
        deviceToken: true,
        keys: () =>
          jsonResponse(200, {
            keys: [{ keyPrefix: KEY_PREFIX, label: "", scopes: [], environment: "production", createdAt: 1 }],
          }),
      },
      {
        name: "absent label",
        deviceToken: true,
        keys: () =>
          jsonResponse(200, { keys: [{ keyPrefix: KEY_PREFIX, scopes: [], environment: "production", createdAt: 1 }] }),
      },
    ]
    for (const c of cases) {
      const f = await fixture(["a", "b", "cold"])
      const file = await pairsFile(f.dir, "a cold\nb cold\n")
      const o = await runBatch(f, {
        file,
        lines: ["no"],
        deviceToken: c.deviceToken,
        api: c.keys ? { keys: c.keys } : {},
      })
      expect([c.name, o.code]).toEqual([c.name, 1])
      expect([c.name, o.err.includes(`  API key         ${KEY_PREFIX}…  profile pb\n`)]).toEqual([c.name, true])
      expect([c.name, o.err.includes(`(${KEY_LABEL})`)]).toEqual([c.name, false])
      expect([c.name, o.stderrAtPrompt[0]?.endsWith(`\n${controlledByBlock(2)}\n`)]).toEqual([c.name, true])
      expect([c.name, o.linePrompts]).toEqual([c.name, [confirmPrompt(2)]])
      expect([c.name, o.calls.some((call) => call.url.endsWith("/api/v1/agent/keys"))]).toEqual([c.name, c.deviceToken])
    }
  })

  test("T5a: GET /keys is not called when the account read has already refused", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, {
      file,
      deviceToken: true,
      api: { embedded: () => jsonResponse(500, { success: false }) },
    })
    expect(o.code).toBe(1)
    expect(o.err).toContain(
      "Could not confirm which Candle account this API key acts for (HTTP 500); nothing was written.",
    )
    expect(o.calls.some((call) => call.url.endsWith("/api/v1/agent/keys"))).toBe(false)
  })
})

describe("BE-296 T6: the account read is live or the batch refuses", () => {
  test("a network error, a 401, a 500 and a body without account each refuse with PROMOTE_ACCOUNT_UNRESOLVED, before any RPC, prompt or write, despite the cached account", async () => {
    const cases: Array<{ name: string; embedded: RouteHandler; reason: string }> = [
      {
        name: "network",
        embedded: () => {
          throw new Error("ECONNREFUSED")
        },
        reason: "Could not confirm which Candle account this API key acts for (",
      },
      {
        name: "401",
        embedded: () =>
          jsonResponse(401, { success: false, error: { code: "UNAUTHORIZED", message: "Invalid API key" } }),
        reason: "Could not confirm which Candle account this API key acts for (HTTP 401); nothing was written.",
      },
      {
        name: "500",
        embedded: () => jsonResponse(500, { success: false }),
        reason: "Could not confirm which Candle account this API key acts for (HTTP 500); nothing was written.",
      },
      {
        name: "no account",
        embedded: () => jsonResponse(200, { success: true, wallets: {} }),
        reason:
          "Could not confirm which Candle account this API key acts for (the response carried no account); nothing was written.",
      },
    ]
    for (const c of cases) {
      const f = await fixture(["a", "b", "cold"])
      const before = await readEntries(f)
      const file = await pairsFile(f.dir, "a cold\nb cold\n")
      const o = await runBatch(f, { file, api: { embedded: c.embedded } })
      expect([c.name, o.code]).toEqual([c.name, 1])
      expect([c.name, o.err.includes(c.reason)]).toEqual([c.name, true])
      expect(o.err).toContain(
        "Check the key with: candle doctor. Promotion registers the keys to that account, so it does not proceed on a cached value.",
      )
      // The cached profile account is never printed as the answer.
      expect([c.name, o.err.includes("will be controlled by")]).toEqual([c.name, false])
      expect([c.name, o.linePrompts]).toEqual([c.name, []])
      expect([c.name, o.rpc]).toEqual([
        c.name,
        { getMultipleAccounts: 0, getTokenAccountsByOwner: 0, getProgramAccounts: 0 },
      ])
      expect([c.name, o.inits.n]).toEqual([c.name, 0])
      expect([c.name, (await readEntries(f)).generation]).toEqual([c.name, before.generation])
      expect(o.out).not.toContain(SENTENCE_PREFIX)
    }
    // Under --json: the failure envelope with the new code, and nothing else on stdout.
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const j = await runBatch(f, { file, json: true, api: { embedded: () => jsonResponse(500, { success: false }) } })
    expect(j.code).toBe(1)
    const docs = jsonDocuments(j.out)
    expect(docs).toHaveLength(1)
    expect(JSON.parse(docs[0] as string)).toMatchObject({ ok: false, code: "PROMOTE_ACCOUNT_UNRESOLVED" })
  })

  test("no API key at all: the room read (BE-288, D7), which comes first in the batch, refuses before the account read can", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, { file, noApiKey: true })
    expect(o.code).toBe(1)
    expect(o.err).toContain(
      "Could not read how many linked wallets this account has room for (no API key is available). Nothing was written.",
    )
    expect(o.err).not.toContain("will be controlled by")
    expect(o.linePrompts).toEqual([])
    expect(o.rpc.getProgramAccounts).toBe(0)
  })
})

describe("BE-296 T10 to T13: the role check always runs", () => {
  test("T10: nine requests per acting key, no flag; --check-authorities is an unknown-flag usage error; the opening line comes before the first request", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const order: string[] = []
    const o = await runBatch(f, {
      file,
      lines: ["no"],
      rpc: {
        programAccounts: () => {
          order.push("request")
          return []
        },
      },
      deps: {},
    })
    expect(o.code).toBe(1)
    expect(o.rpc.getProgramAccounts).toBe(2 * REQUESTS_PER_KEY)
    const opening =
      "Checking token mint, freeze, program upgrade and stake authorities for 2 addresses: 18 requests over rpc.pb.test."
    expect(o.err.indexOf(opening)).toBeGreaterThan(-1)
    expect(o.err.indexOf(opening)).toBeLessThan(o.err.indexOf("Checking authorities:"))
    expect(o.err.indexOf(opening)).toBeLessThan(o.err.indexOf("✓ authorities read"))

    const flagged = await runBatch(f, { file, args: ["--check-authorities"] })
    expect(flagged.code).toBe(2)
    expect(flagged.err).toContain("--check-authorities")
    expect(flagged.secretPrompts).toBe(0)
    expect(flagged.rpc.getProgramAccounts).toBe(0)
  })

  test("T11: a 403 on the SPL-mint scan names the group not read in the footer and in --json, the sentence is Form U, the column says ?, and the run reaches the prompt", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const programAccounts = (call: ProgramAccountsCall) =>
      groupOfCall(call) === "token-mint" ? jsonResponse(403, { error: "Your IP or provider is blocked" }) : []
    const o = await runBatch(f, { file, lines: ["no"], rpc: { programAccounts } })
    expect(o.code).toBe(1)
    expect(o.linePrompts).toEqual([confirmPrompt(2)])
    expect(o.out).toContain(promoteSentence({ n: 2, form: "U", where: "below" }))
    expect(o.err).toMatch(/^1\s+promote\s+a\s+\S+\s+cold \(…\w+\)\s+\?\s+0\.021400$/m)
    expect(o.err).toContain("Authorities: none found; 1 of 7 groups were not read (see below).")
    expect(o.err).toContain(
      "Authorities read over rpc.pb.test: token freeze, Token-2022 mint, Token-2022 freeze, program upgrade, stake staker, stake withdrawer. Not read: token mint (HTTP 403). Not checked: multisig membership, Token-2022 extension authorities, metadata update authority.",
    )
    expect(o.err).toMatch(/✓ authorities read for 2 addresses \(\d+ requests, 6 of 7 groups read, 1 refused\) in 0s/)

    const j = await runBatch(f, { file, ack: "correct", json: true, rpc: { programAccounts } })
    expect(j.code).toBe(0)
    const body = JSON.parse(jsonDocuments(j.out)[0] as string)
    expect(body.authorities.notChecked).toEqual([{ group: "token-mint", reason: "HTTP 403" }])
    expect(body.authorities.checked).toEqual(ROLE_GROUP_IDS.filter((id) => id !== "token-mint"))
    expect(body.authorities.found).toEqual([])
  })

  test("T12: a request that is aborted (timeout) behaves as a refusal of its group", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, {
      file,
      lines: ["no"],
      rpc: {
        programAccounts: (call) => {
          if (groupOfCall(call) !== "stake-staker") return []
          throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" })
        },
      },
    })
    expect(o.code).toBe(1)
    expect(o.err).toContain("Not read: stake staker (timed out after 20 s).")
    expect(o.out).toContain(promoteSentence({ n: 2, form: "U", where: "below" }))
    expect(o.linePrompts).toEqual([confirmPrompt(2)])
  })

  test("T12b: the progress line is written to stderr with \\r and replaced by the ✓ line; under --json none of it reaches stdout", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, { file, ack: "correct", json: true })
    expect(o.code).toBe(0)
    expect(o.err).toContain("\rChecking authorities: 1 of 18 requests, 0 s elapsed")
    expect(o.err).toContain("\rChecking authorities: 18 of 18 requests, 0 s elapsed")
    expect(o.err).toContain("\r✓ authorities read for 2 addresses (18 requests, 7 of 7 groups read) in 0s\n")
    expect(o.out).not.toContain("Checking authorities")
    expect(o.out).not.toContain("✓ authorities")
    expect(jsonDocuments(o.out)).toHaveLength(1)
  })

  test("T12c: a found stake withdrawer and a found mint on one key: the row, the footer count (keys, not findings), the sentence's k, and --json", async () => {
    const f = await fixture(["a", "b", "cold"])
    const a = f.addresses.a as string
    const mint = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"
    const stake = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const programAccounts = (call: ProgramAccountsCall) => {
      if (!isFor(call, a)) return []
      if (groupOfCall(call) === "stake-withdrawer") return [stake]
      if (groupOfCall(call) === "token-mint") return [mint]
      return []
    }
    const o = await runBatch(f, { file, lines: ["no"], rpc: { programAccounts } })
    expect(o.code).toBe(1)
    expect(o.err).toContain(`  mint authority of ${mint}; withdrawer authority of ${stake}  `)
    expect(o.err).toMatch(/^2\s+promote\s+b\s+\S+\s+cold \(…\w+\)\s+none\s+0\.021400$/m)
    expect(o.err).toContain("Authorities: 1 of 2 keys holds one (2 findings, in the authority column).")
    expect(o.out).toContain(promoteSentence({ n: 2, form: "F", k: 1, where: "below" }))
    expect(o.out).toContain("1 of them holds a mint, freeze, upgrade or stake authority, named below")

    const j = await runBatch(f, { file, ack: "correct", json: true, rpc: { programAccounts } })
    const body = JSON.parse(jsonDocuments(j.out)[0] as string)
    expect(body.authorities.found).toEqual([
      { address: a, role: "mint", target: mint, program: "token" },
      { address: a, role: "withdrawer", target: stake, program: "stake" },
    ])
  })

  test("T13: an upgrade hit resolves its program id with one more request; one that does not resolve prints the ProgramData address and says so", async () => {
    const f = await fixture(["a", "b", "cold"])
    const b = f.addresses.b as string
    const programData = "9BVcYqEQxyccuwznvxXqDkSJFavvTyheiTYk231T1A8S"
    const programId = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
    const orphan = "So11111111111111111111111111111111111111112"
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, {
      file,
      lines: ["no"],
      rpc: {
        programAccounts: (call) => {
          const group = groupOfCall(call)
          if (group === "program-upgrade") return isFor(call, b) ? [programData, orphan] : []
          if (group === "program-resolve") {
            const which = call.filters[1]?.memcmp?.bytes
            return which === base64.encode(base58.decode(programData)) ? [programId] : []
          }
          return []
        },
      },
    })
    expect(o.code).toBe(1)
    // 18 scans plus 2 resolves.
    expect(o.rpc.getProgramAccounts).toBe(20)
    expect(o.err).toContain(
      `upgrade authority of ${programId}; upgrade authority of ${orphan} (ProgramData account; the program id could not be resolved)`,
    )
    expect(o.err).toContain("✓ authorities read for 2 addresses (20 requests, 7 of 7 groups read) in 0s")
  })
})

describe("BE-296 T14, T15: the line header and --json", () => {
  test("T14: the batch table and the refusal table are headed `line`, and the values are the file lines the document carries", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "# plan\n\na cold\n\nb cold\n")
    const o = await runBatch(f, { file, lines: ["no"] })
    expect(o.err).toMatch(/^line\s+state\s+label\s+address\s+destination\s+authority\s+SOL \(tokens not read\)$/m)
    expect(o.err).not.toMatch(/^#\s+state/m)
    expect(o.err).toMatch(/^3\s+promote\s+a\s/m)
    expect(o.err).toMatch(/^5\s+promote\s+b\s/m)
    const j = await runBatch(f, { file, ack: "correct", json: true })
    const body = JSON.parse(jsonDocuments(j.out)[0] as string)
    expect(body.keys.map((k: { line: number }) => k.line)).toEqual([3, 5])

    // The refusal table (row 2 sweeps to a key row 1 promotes).
    const g = await fixture(["p", "q", "cold"])
    const refused = await pairsFile(g.dir, "p cold\nq p\n")
    const r = await runBatch(g, { file: refused })
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/^line\s+label\s+destination\s+code\s+why$/m)
    expect(r.err).not.toMatch(/^#\s+label/m)
  })

  test("T15: success and stopped documents carry controlledBy and authorities; every pre-existing key is unchanged; one JSON value on stdout", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, { file, ack: "correct", json: true, deviceToken: true })
    expect(o.code).toBe(0)
    const docs = jsonDocuments(o.out)
    expect(docs).toHaveLength(1)
    const body = JSON.parse(docs[0] as string)
    expect(Object.keys(body).sort()).toEqual([
      "authorities",
      "complete",
      "controlledBy",
      "destinations",
      "file",
      "keys",
      "ok",
      "promoted",
      "resumed",
      "rows",
      "skipped",
    ])
    expect(body.controlledBy).toEqual({
      account: ACCOUNT,
      username: USERNAME,
      keyPrefix: KEY_PREFIX,
      keyLabel: KEY_LABEL,
      keySource: "profile",
      apiUrl: API,
      environment: null,
    })
    expect(body.authorities).toEqual({ checked: [...ROLE_GROUP_IDS], notChecked: [], found: [] })
    const inOne = [
      ...body.authorities.checked,
      ...body.authorities.notChecked.map((n: { group: string }) => n.group),
    ].sort()
    expect(inOne).toEqual([...ROLE_GROUP_IDS].sort())

    // Stopped mid-run (row 2's submit fails): the same two keys, `keyLabel` null without a device token.
    const g = await fixture(["a", "b", "cold"])
    const gfile = await pairsFile(g.dir, "a cold\nb cold\n")
    const s = await runBatch(g, {
      file: gfile,
      ack: "correct",
      json: true,
      api: {
        submit: (n) =>
          n === 2 ? jsonResponse(500, { success: false, error: { code: "INTERNAL", message: "boom" } }) : undefined,
      },
    })
    expect(s.code).toBe(1)
    const sdocs = jsonDocuments(s.out)
    expect(sdocs).toHaveLength(1)
    const stopped = JSON.parse(sdocs[0] as string)
    expect(stopped).toMatchObject({ ok: false, complete: false, failedLine: 2 })
    expect(stopped.controlledBy).toMatchObject({
      account: ACCOUNT,
      keyPrefix: KEY_PREFIX,
      keyLabel: null,
      keySource: "profile",
    })
    expect(stopped.authorities).toEqual({ checked: [...ROLE_GROUP_IDS], notChecked: [], found: [] })
  })
})
