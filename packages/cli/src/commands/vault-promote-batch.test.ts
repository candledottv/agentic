/**
 * BE-285 (spec `2026-09-22-cli-vault-promote-batch-design.md`, §6): `candle vault promote-batch`.
 *
 * Fake API and fake RPC; real vault format, real unlock, real commits. The five tests the spec says
 * must exist before the rest -- T-P1, T-P8, T-U1, T-U3, T-R7 -- are the first five describes.
 * T-R1 (`vault promote` unchanged) is `vault-promote.test.ts` itself, passing untouched.
 *
 * The suite is split in two so that neither file sets the floor of a CI test shard: this one holds
 * T-P, T-U, T-R, T-I, T-A, T-C and T-H; `vault-promote-batch-checks.test.ts` holds --json and the
 * BE-288 and BE-296 checks. The harness they share is `__fixtures__/promote-batch.ts`.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmod, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { sha256 } from "@noble/hashes/sha256"
import { base64 } from "@scure/base"
import { Keypair } from "@solana/web3.js"
import type { Deps } from "../deps"
import { AUTHDATA_FLAG_UP, AUTHDATA_FLAG_UV, handleLine, RP_ID } from "../fido2-helper/protocol"
import { type BackendLogEntry, type HelperScript, scriptedBackend } from "../fido2-helper/test-backend"
import { run } from "../index"
import { createCapture, createTestDeps, jsonResponse } from "../test-support"
import { HELPER_ENV } from "../vault/fido2"
import type { KeyEntry } from "../vault/format"
import { formatSol, formatUsd, parsePairsFile, parseValueUsdCell, preflightBatch } from "../vault/promote-batch"
import { confirmPrompt, promoteSentence, SENTENCE_PREFIX } from "../vault/promote-support"
import { REQUESTS_PER_KEY, ROLE_GROUP_IDS } from "../vault/signer-roles"
import { closeVault, commitVault, unlockWithPassphrase } from "../vault/store"
import { generatedPassphraseFrom, makeVault, tempDir, useCheapKdf } from "../vault/test-vault"
import {
  ACCOUNT,
  API,
  batchRefusal,
  CLOCK,
  controlledByBlock,
  type Fixture,
  fixture,
  grantedWallets,
  jsonDocuments,
  newKeys,
  type Outcome,
  openVault,
  pairsFile,
  RPC,
  readEntries,
  runBatch,
  seed,
  teeSeed,
  unreachable,
} from "./__fixtures__/promote-batch"
import { setPromoteBatchObserver } from "./vault-promote-batch"

setDefaultTimeout(180_000)
useCheapKdf()

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The five that must exist first.
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("T-P1: the named failure, a destination this file promotes", () => {
  test("row 3 sweeps to the key row 2 promotes: refused before any commit, row 2 is not a failure line", async () => {
    const f = await fixture(["a", "q1", "b", "d1"])
    const before = await readEntries(f)
    const file = await pairsFile(f.dir, "a d1\nq1 d1\nb q1\n")
    const o = await runBatch(f, { file, json: true })
    expect(o.code).toBe(1)
    const body = batchRefusal(o)
    expect(body.message).toBe("1 of 3 rows cannot run; nothing was written.")
    expect(body.rows).toEqual([
      {
        line: 3,
        label: "b",
        destination: "q1",
        code: "PROMOTE_DESTINATION_NOT_COLD",
        message: "No vault key matches q1.",
        why: "q1 is promoted by row 2 of this file.",
      },
    ])
    // Zero writes: same generation, nothing moved to tee-wallet.
    const after = await readEntries(f)
    expect(after.generation).toBe(before.generation)
    expect(after.entries.every((e) => e.role === "vault" && e.tee === undefined)).toBe(true)
    expect(o.submits.n).toBe(0)
    expect(o.linePrompts).toEqual([])
  })

  test("the human rendering is the same report: a table on stderr and the continuation sentence", async () => {
    const f = await fixture(["a", "q1", "b", "d1"])
    const file = await pairsFile(f.dir, "a d1\nq1 d1\nb q1\n")
    const o = await runBatch(f, { file })
    expect(o.code).toBe(1)
    expect(o.err).toContain("This batch was refused and NOTHING was written. 1 of 3 rows cannot run:")
    expect(o.err).toContain("PROMOTE_DESTINATION_NOT_COLD")
    expect(o.err).toContain("No vault key matches q1. q1 is promoted by row 2 of this file.")
    expect(o.err).toContain("Each row was checked against the vault as it will be when the rows above it have run")
    expect(o.err).toContain("the next run re-checks all 3")
    // No sentence and no table on a refusal: nothing to acknowledge (D8, point 1).
    expect(o.out).not.toContain(SENTENCE_PREFIX)
    expect(o.err).not.toContain("value_usd")
  })
})

describe("T-P8: the check that today runs after the commit", () => {
  test("a stored secret that does not match its address is refused before any commitVault", async () => {
    const f = await fixture(["a", "b", "d1"])
    // A blob that decrypts to a different key than the index claims: the index says `b` is at a
    // fresh keypair's address, the blob under its id is still the derived secret.
    const impostor = Keypair.generate().publicKey.toBase58()
    await seed(f, (e) => (e.label === "b" ? { ...e, address: impostor } : e))
    const before = await readEntries(f)
    const file = await pairsFile(f.dir, `a d1\nb d1\n`)
    const o = await runBatch(f, { file, json: true })
    expect(o.code).toBe(1)
    const body = batchRefusal(o)
    expect(body.rows).toEqual([
      {
        line: 2,
        label: "b",
        destination: "d1",
        code: "VAULT_VERIFY_FAILED",
        message: "Stored secret does not match the subject address.",
      },
    ])
    const after = await readEntries(f)
    expect(after.generation).toBe(before.generation)
    expect(after.entries.some((e) => e.tee?.lifecycle === "import-pending")).toBe(false)
    expect(o.submits.n).toBe(0)
  })
})

/** The scripted security key, as `vault-security-key.test.ts` drives it, in process. */
const PIN = "482913"
const HMAC_SECRET = base64.encode(new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff))
const CRED = base64.encode(new Uint8Array(48).map((_, i) => (i * 7 + 3) & 0xff))
const AAGUID = "2fc0579f811347eab116bb5a8db9202a"
function authDataFor(rpId: string, flags: number): string {
  const out = new Uint8Array(37)
  out.set(sha256(new TextEncoder().encode(rpId)), 0)
  out[32] = flags
  return base64.encode(out)
}
function keyScript(): HelperScript {
  return {
    devices: [
      {
        path: "/dev/hidraw3",
        product: "YubiKey 5 NFC",
        manufacturer: "Yubico",
        aaguid: AAGUID,
        extensions: ["hmac-secret", "credProtect"],
        options: { rk: true, clientPin: true, uv: false },
      },
    ],
    register: { credentialId: CRED, aaguid: AAGUID, authData: authDataFor(RP_ID, AUTHDATA_FLAG_UP | AUTHDATA_FLAG_UV) },
    assert: { hmacSecret: HMAC_SECRET, authData: authDataFor(RP_ID, AUTHDATA_FLAG_UP | AUTHDATA_FLAG_UV) },
  }
}

/** A vault whose passphrase factor has a scripted security key beside it. */
async function keyFixture(
  labels: string[],
): Promise<Fixture & { calls: BackendLogEntry[]; keyDeps: (opts: { secrets: string[] }) => Partial<Deps> }> {
  const dir = await tempDir("candle-pb-key-")
  const helper = join(dir, "candle-fido2")
  await writeFile(helper, "#!/bin/sh\nexit 1\n")
  await chmod(helper, 0o755)
  const calls: BackendLogEntry[] = []
  const script = keyScript()
  const spawnHelper: Deps["spawnHelper"] = async (_path, line) => {
    const response = handleLine(line, () => scriptedBackend(script, (entry) => calls.push(entry)))
    return { stdout: `${JSON.stringify(response)}\n`, stderr: "", exitCode: response.ok ? 0 : 1, signal: null }
  }
  const env = { CANDLE_CONFIG_DIR: dir, HOME: dir, [HELPER_ENV]: helper }
  const keyDeps = (opts: { secrets: string[] }): Partial<Deps> => {
    const secrets = [...opts.secrets]
    return {
      env: { ...env, CANDLE_API_URL: API },
      platform: "linux",
      arch: "x64",
      spawnHelper,
      promptSecret: async () => {
        const next = secrets.shift()
        if (next === undefined) throw new Error("promptSecret asked for more than the test scripted")
        return next
      },
    }
  }
  // init: Enter at the passphrase choice, Enter to acknowledge the words, "no" at the phrase ceremony.
  const init = createTestDeps({
    fetch: unreachable as unknown as typeof fetch,
    env,
    platform: "linux",
    arch: "x64",
    spawnHelper,
    promptLine: (() => {
      const lines = ["", "", "no"]
      return async () => lines.shift() ?? ""
    })(),
    promptSecret: async () => {
      throw new Error("init asks for no secret")
    },
  })
  const initOut = init.stdout as ReturnType<typeof createCapture>
  const initCode = await run(["vault", "init"], init)
  if (initCode !== 0) throw new Error(`init failed: ${(init.stderr as ReturnType<typeof createCapture>).text}`)
  const passphrase = generatedPassphraseFrom(initOut.text)
  const add = createTestDeps({
    fetch: unreachable as unknown as typeof fetch,
    ...keyDeps({ secrets: [PIN, passphrase] }),
    promptLine: async () => "",
  })
  const addCode = await run(["vault", "factor", "add", "security-key", "--label", "desk key"], add)
  if (addCode !== 0) throw new Error(`factor add failed: ${(add.stderr as ReturnType<typeof createCapture>).text}`)
  calls.length = 0
  const addresses: Record<string, string> = {}
  for (const label of labels) {
    const out = createCapture()
    const deps = createTestDeps({
      fetch: unreachable as unknown as typeof fetch,
      stdout: out,
      env,
      promptSecret: async () => passphrase,
      promptLine: async () => "",
    })
    const code = await run(["vault", "new-key", "--chain", "solana", "--label", label, "--factor", "passphrase"], deps)
    if (code !== 0) throw new Error(`new-key ${label} failed`)
    addresses[label] = out.text.trim().split("\n")[0] as string
  }
  return { dir, path: join(dir, "vault.enc"), passphrase, addresses, calls, keyDeps }
}

describe("T-U1: one unlock is real", () => {
  test("a 5-row batch against the scripted security key receives exactly two assertions", async () => {
    const f = await keyFixture(["a", "b", "c", "d", "e", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\nc cold\nd cold\ne cold\n")
    const o = await runBatch(f, {
      file,
      ack: "correct",
      args: ["--factor", "security-key"],
      deps: f.keyDeps({ secrets: [PIN] }),
    })
    expect(o.err + o.out).not.toContain("Error")
    expect(o.code).toBe(0)
    expect(o.submits.n).toBe(5)
    // The unlock, and the single end-of-run factor re-open. Not 2 to 3 per key.
    expect(f.calls.map((call) => call.op)).toEqual(["assert", "assert"])
    const after = await readEntries(f)
    expect(after.entries.filter((e) => e.tee?.lifecycle === "enabled")).toHaveLength(5)
  })
})

describe("T-U3: the shared DEK survives row 1", () => {
  test("after row 1's import commit the batch's DEK is not zeroed, and row 2 commits", async () => {
    const f = await fixture(["a", "b", "c", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\nc cold\n")
    const seen: Array<{ line: number; stage: string; dekIntact: boolean }> = []
    setPromoteBatchObserver(({ line, stage, vault }) => {
      seen.push({ line, stage, dekIntact: vault.dek.some((byte) => byte !== 0) })
    })
    try {
      const o = await runBatch(f, { file, ack: "correct" })
      expect(o.code).toBe(0)
    } finally {
      setPromoteBatchObserver(null)
    }
    // `closeVault` at `vault-promote.ts`'s `finally` wipes `dek`; a decrypt-only check would miss
    // it because `payloadKey` survives. The bytes are the assertion.
    expect(seen.filter((s) => s.stage === "imported").map((s) => [s.line, s.dekIntact])).toEqual([
      [1, true],
      [2, true],
      [3, true],
    ])
    const after = await readEntries(f)
    expect(
      after.entries
        .filter((e) => e.tee?.lifecycle === "enabled")
        .map((e) => e.label)
        .sort(),
    ).toEqual(["a", "b", "c"])
  })
})

describe("T-R7: resume rows are reconciled in Phase B, and never prompt in the loop", () => {
  test("a local-candidate whose server destination differs from the file is refused with zero writes", async () => {
    const f = await fixture(["a", "lc", "d1", "d2"])
    await seed(f, (e) => (e.label === "lc" ? { ...e, ...teeSeed("local-candidate", undefined) } : e))
    const before = await readEntries(f)
    const file = await pairsFile(f.dir, "a d1\nlc d1\n")
    const o = await runBatch(f, {
      file,
      json: true,
      api: { wallets: grantedWallets([{ address: f.addresses.lc as string, vaultDestination: f.addresses.d2 }]) },
    })
    expect(o.code).toBe(1)
    const body = batchRefusal(o)
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0]).toMatchObject({ line: 2, label: "lc", code: "GRANT_BINDING_MISMATCH" })
    expect(String(body.rows[0]?.message)).toContain(f.addresses.d2 as string)
    expect(String(body.rows[0]?.message)).toContain(f.addresses.d1 as string)
    expect((await readEntries(f)).generation).toBe(before.generation)
    expect(o.linePrompts).toEqual([])
  })

  test("a matching resume with no grantIdentity prints the account once in the footer and does not prompt for it", async () => {
    const f = await fixture(["a", "ip", "d1"])
    await seed(f, (e) => (e.label === "ip" ? { ...e, ...teeSeed("import-pending", f.addresses.d1) } : e))
    const file = await pairsFile(f.dir, "a d1\nip d1\n")
    const o = await runBatch(f, {
      file,
      ack: "correct",
      api: { wallets: grantedWallets([{ address: f.addresses.ip as string, vaultDestination: f.addresses.d1 }]) },
    })
    expect(o.code).toBe(0)
    const footerLine = `Resume rows with no grant identity assert this profile's account ${ACCOUNT} (…${ACCOUNT.slice(-6)}).`
    expect(o.err.split(footerLine)).toHaveLength(2)
    // One visible prompt for the whole run: the acknowledgement. No `confirmLastSix` for the
    // account, none for the destination, and no grant block on stdout.
    expect(o.linePrompts).toEqual([confirmPrompt(2)])
    expect(o.out).not.toContain("Server grant for")
    expect(o.out).not.toContain("This profile acts as account")
    expect(o.submits.n).toBe(1)
    const after = await readEntries(f)
    const ip = after.entries.find((e) => e.label === "ip")
    expect(ip?.tee?.lifecycle).toBe("enabled")
    expect(ip?.tee?.grantIdentity?.account).toBe(ACCOUNT)
    expect(ip?.linkedWalletId).toBe(`lw_g_${(f.addresses.ip as string).slice(0, 6)}`)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The rest of the matrix.
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("T-P2: the projection and the loop agree", () => {
  test("each promote row's pre-import write is byte-equal to the projected entry, and hd matches at the end", async () => {
    const f = await fixture(["a", "b", "c", "cold"])
    const v = await openVault(f)
    let projected: Awaited<ReturnType<typeof preflightBatch>>
    try {
      projected = await preflightBatch(
        v.index,
        [
          { line: 1, label: "a", destination: "cold" },
          { line: 2, label: "b", destination: "cold" },
          { line: 3, label: "c", destination: "cold" },
        ],
        {
          acceptUnknownExposure: false,
          now: new Date(0).toISOString(),
          verifySubject: async () => {},
          reconcileResume: async () => {
            throw new Error("no resume row here")
          },
        },
      )
    } finally {
      closeVault(v)
    }
    expect(projected.failures).toEqual([])
    const file = await pairsFile(f.dir, "a cold\nb cold\nc cold\n")
    const written: Array<{ line: number; entry: KeyEntry | undefined }> = []
    setPromoteBatchObserver(async ({ line, stage }) => {
      if (stage !== "pre-import") return
      // Read the DISK, not the object: the guarantee is about the file.
      const onDisk = await openVault(f)
      try {
        const label = ["a", "b", "c"][line - 1] as string
        written.push({ line, entry: onDisk.index.entries.find((e) => e.label === label) })
      } finally {
        closeVault(onDisk)
      }
    })
    let o: Outcome
    try {
      // The fake clock starts at 0 and nothing sleeps, so `now` is the same instant the projection used.
      o = await runBatch(f, { file, ack: "correct" })
    } finally {
      setPromoteBatchObserver(null)
    }
    expect(o.code).toBe(0)
    expect(written).toHaveLength(3)
    for (const { line, entry } of written) {
      const label = ["a", "b", "c"][line - 1] as string
      const projectedEntry = projected.projection.entries.find((e) => e.label === label)
      expect(JSON.stringify(entry)).toBe(JSON.stringify(projectedEntry))
      expect(entry?.tee?.lifecycle).toBe("import-pending")
    }
    const after = await readEntries(f)
    const v2 = await openVault(f)
    try {
      expect(v2.index.hd.exposedIndexes).toEqual(projected.projection.hd.exposedIndexes)
    } finally {
      closeVault(v2)
    }
    expect(after.entries.filter((e) => e.tee?.lifecycle === "enabled")).toHaveLength(3)
  })
})

describe("T-P3, T-P4: pins and the continuation rule", () => {
  test("T-P3: a subject an earlier row sweeps to is refused as pinned, before any commit; the earlier row is not a failure line", async () => {
    const f = await fixture(["a", "p3", "d1"])
    const before = await readEntries(f)
    const file = await pairsFile(f.dir, "a p3\np3 d1\n")
    const o = await runBatch(f, { file, json: true })
    expect(o.code).toBe(1)
    const body = batchRefusal(o)
    expect(body.rows).toEqual([
      {
        line: 2,
        label: "p3",
        destination: "d1",
        code: "PROMOTE_KEY_IS_PINNED_DESTINATION",
        message: `${f.addresses.p3} is the pinned sweep destination for: a.`,
        why: "Row 1 of this file sweeps to p3.",
      },
    ])
    expect((await readEntries(f)).generation).toBe(before.generation)
  })

  test("T-P4: a refused row is not projected, so a later row that sweeps to its subject passes and is not reported", async () => {
    const f = await fixture(["q1", "b", "d1"])
    const file = await pairsFile(f.dir, "q1 nowhere\nb q1\n")
    const o = await runBatch(f, { file, json: true })
    expect(o.code).toBe(1)
    const body = batchRefusal(o)
    expect(body.rows.map((row) => row.line)).toEqual([1])
    expect(body.rows[0]).toMatchObject({
      code: "PROMOTE_DESTINATION_NOT_COLD",
      message: "No vault key matches nowhere.",
    })
    expect(body.rows[0]?.why).toBeUndefined()
    const human = await runBatch(f, { file })
    expect(human.err).toContain("every row that fails on that basis")
  })
})

describe("T-P9: no recoverable factor", () => {
  test("refused with the shipped VAULT_NO_RECOVERABLE_FACTOR before the table, zero writes", async () => {
    const f = await keyFixture(["a", "b", "cold"])
    // Leave only the hardware envelope, through the real write path.
    const v = await unlockWithPassphrase(f.path, await readFile(f.path, "utf8"), f.passphrase)
    try {
      await commitVault(
        v,
        { index: v.index, envelopes: v.file.envelopes.filter((e) => e.factor !== "passphrase") },
        CLOCK,
      )
    } finally {
      closeVault(v)
    }
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, {
      file,
      json: true,
      args: ["--factor", "security-key"],
      deps: f.keyDeps({ secrets: [PIN] }),
    })
    expect(o.code).toBe(1)
    const docs = jsonDocuments(o.out)
    expect(docs).toHaveLength(1)
    expect(JSON.parse(docs[0] as string)).toMatchObject({ ok: false, code: "VAULT_NO_RECOVERABLE_FACTOR" })
    expect(o.err).not.toContain("state")
    expect(o.submits.n).toBe(0)
    expect(o.linePrompts).toEqual([])
  })
})

describe("T-P5, T-P6, T-P7: Phase A, before the unlock", () => {
  test("T-P5: a malformed file refuses with exit 2 and promptSecret was never called", async () => {
    const f = await fixture(["a", "cold"])
    const file = await pairsFile(f.dir, "a\ncold\n")
    const o = await runBatch(f, { file, json: true })
    expect(o.code).toBe(2)
    expect(o.secretPrompts).toBe(0)
    expect(JSON.parse(o.out)).toMatchObject({ ok: false, code: "USAGE" })
    expect(String(JSON.parse(o.out).message)).toContain("nothing was unlocked")
  })

  test("T-P6: every malformed line is named together, not the first", async () => {
    const f = await fixture(["a", "cold"])
    const file = await pairsFile(f.dir, "a cold\nlonely\nb cold extra\n\n# comment\nc\n")
    const o = await runBatch(f, { file })
    expect(o.code).toBe(2)
    expect(o.err).toContain(`${file}: 3 lines cannot be used, and nothing was unlocked.`)
    expect(o.err).toContain(`line 2   only one field; a row is "<label> <destination>"`)
    expect(o.err).toContain(`line 3   3 fields; a row is "<label> <destination>"`)
    expect(o.err).toContain(`line 6   only one field`)
    expect(o.secretPrompts).toBe(0)
  })

  test("T-P7: duplicate label, order out of sequence, 257 rows, and a single row are each refused before the unlock", async () => {
    const f = await fixture(["a", "cold"])
    const dup = await runBatch(f, { file: await pairsFile(f.dir, "a cold\nb cold\na cold\n", "dup.txt") })
    expect(dup.code).toBe(2)
    expect(dup.err).toContain("line 1   label a appears again on line 3")

    const order = await runBatch(f, {
      file: await pairsFile(f.dir, "order,label,sweep_to\n51,a,cold\n44,b,cold\n", "order.csv"),
    })
    expect(order.code).toBe(2)
    expect(order.err).toContain(
      "line 3   order 44 is not greater than the previous row's 51; the file's line order is what runs",
    )

    const many = Array.from({ length: 257 }, (_, i) => `k${i} cold`).join("\n")
    const cap = await runBatch(f, { file: await pairsFile(f.dir, `${many}\n`, "cap.txt") })
    expect(cap.code).toBe(2)
    expect(cap.err).toContain("holds 257 rows; a batch is capped at 256")

    const one = await runBatch(f, { file: await pairsFile(f.dir, "a cold\n", "one.txt") })
    expect(one.code).toBe(2)
    expect(one.err).toContain(`Run: candle vault promote --in-place a --sweep-to cold --rpc-url ${RPC}`)
    for (const o of [dup, order, cap, one]) expect(o.secretPrompts).toBe(0)
  })

  test("--from is refused by name, naming the route; a bare address in sweep_to and a --label are not accepted", async () => {
    const f = await fixture(["a", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const from = await runBatch(f, { file, args: ["--from", "x"] })
    expect(from.code).toBe(2)
    expect(from.err).toContain("takes no --from")
    expect(from.err).toContain("vault new-key --chain solana --labels-from")
    const label = await runBatch(f, { file, args: ["--label", "x"] })
    expect(label.code).toBe(2)
    expect(label.err).toContain("Unknown flag: --label")
    const tilde = await runBatch(f, { file: "~/plan.txt" })
    expect(tilde.code).toBe(2)
    expect(tilde.err).toContain('literal "~"')
    expect(from.secretPrompts + label.secretPrompts + tilde.secretPrompts).toBe(0)
  })
})

describe("T-I1, T-I2, T-I3: the input file", () => {
  test("T-I1: the operator's real header is accepted, and reordered columns map identically, by name", () => {
    const real = parsePairsFile(
      "order,label,family,sweep_to,value_usd\n1,tr-1,tr,p-2,2140.00\n2,tr-2,tr,p-2,880.50\n",
      {
        file: "plan.csv",
        rpcUrl: RPC,
      },
    )
    const reordered = parsePairsFile(
      "sweep_to,value_usd,label,family,order\np-2,2140.00,tr-1,tr,1\np-2,880.50,tr-2,tr,2\n",
      {
        file: "plan.csv",
        rpcUrl: RPC,
      },
    )
    expect(real.ok && reordered.ok).toBe(true)
    if (!real.ok || !reordered.ok) return
    expect(real.rows).toEqual(reordered.rows)
    expect(real.rows).toEqual([
      { line: 2, label: "tr-1", destination: "p-2", order: "1", valueUsd: "2140.00" },
      { line: 3, label: "tr-2", destination: "p-2", order: "2", valueUsd: "880.50" },
    ])
    expect(real.format).toBe("csv")
    expect(real.hasValueUsd).toBe(true)
  })

  test("T-I1: the same file through the command: family is carried, not used, and value_usd is echoed as yours", async () => {
    const f = await fixture(["tr-1", "tr-2", "p-2"])
    const file = await pairsFile(
      f.dir,
      "order,label,family,sweep_to,value_usd\n1,tr-1,tr,p-2,2140.00\n2,tr-2,tr,p-2,880.50\n",
      "plan.csv",
    )
    const o = await runBatch(f, { file, lines: ["nope"] })
    expect(o.code).toBe(1)
    expect(o.err).toContain("value_usd (yours)")
    // Echoed verbatim: the cell as the file spells it, not a reformatting of it (D4).
    expect(o.err).toMatch(/^2\s+promote\s+tr-1\s+\S+\s+p-2 \(…\w+\)\s+none\s+0\.021400\s+2140\.00$/m)
    expect(o.err).toContain(
      "value_usd totals your file's own column; this CLI reads no price. Total for the 2 rows this run will act on: $3,020.50",
    )
    expect(o.err).not.toContain("tr  ")
  })

  test("T-I2: a CSV missing sweep_to lists the columns it found; a 3-field whitespace line names its line", async () => {
    const missing = parsePairsFile("order,label,family\n1,a,x\n", { file: "plan.csv", rpcUrl: RPC })
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.findings).toEqual([
      { line: 1, problem: "a CSV needs both a label and a sweep_to column; found: order, label, family" },
    ])
    const three = parsePairsFile("a cold\nb cold extra\n", { file: "plan.txt", rpcUrl: RPC })
    expect(three.ok).toBe(false)
    if (three.ok) return
    expect(three.findings).toEqual([{ line: 2, problem: `3 fields; a row is "<label> <destination>"` }])
  })

  test("T-I3: an unparseable value_usd cell is shown verbatim, excluded from the total, counted, and does not refuse", async () => {
    const f = await fixture(["a", "b", "cold"])
    // A quote-free CSV is the operator's real shape, so a `$1,500` cell would split on its own
    // comma; the lenient parse is exercised on the helper below and the run uses `$1500`.
    const file = await pairsFile(f.dir, "label,sweep_to,value_usd\na,cold,$1500\nb,cold,n/a\n", "plan.csv")
    const o = await runBatch(f, { file, ack: "correct" })
    expect(o.code).toBe(0)
    expect(o.err).toContain("n/a")
    expect(o.err).toContain(
      "Total for the 2 rows this run will act on: $1,500.00 (1 row excluded: the cell did not parse)",
    )
    expect(parseValueUsdCell("$1,500")).toBe(1500)
    expect(parseValueUsdCell("n/a")).toBeUndefined()
    expect(formatUsd(310749)).toBe("$310,749.00")
    expect(formatSol(21_400_000n)).toBe("0.021400")
  })
})

describe("T-U2: a passphrase batch asks for the passphrase once", () => {
  test("five rows, one promptSecret", async () => {
    const f = await fixture(["a", "b", "c", "d", "e", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\nc cold\nd cold\ne cold\n")
    const o = await runBatch(f, { file, ack: "correct" })
    expect(o.code).toBe(0)
    expect(o.secretPrompts).toBe(1)
    expect(o.submits.n).toBe(5)
    expect(o.out).toContain("5 addresses promoted under one unlock, each committed on its own.")
    // Streamed as they land, one line per row, on stderr.
    expect(o.err).toContain("✓ 1/5  a  ")
    expect(o.err).toContain("✓ 5/5  e  ")
  })
})

describe("T-A1 to T-A4: the sentence and the acknowledgement (BE-296)", () => {
  test("T-A1: one sentence, exactly once, on stdout, before the prompt; the table and the block are on stderr", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, { file, ack: "correct" })
    expect(o.code).toBe(0)
    // Every group answered (the fake returns no accounts), so the sentence is Form N, plural.
    const sentence = promoteSentence({ n: 2, form: "N", where: "below" })
    expect(o.out.split(`\n${sentence}\n\n`)).toHaveLength(2)
    expect(o.out).toContain(SENTENCE_PREFIX)
    expect(o.err).not.toContain(SENTENCE_PREFIX)
    // At the moment the prompt was asked, the sentence was already on stdout.
    expect(o.stdoutAtPrompt[0]).toContain(sentence)
    // The table is on stderr, `line` first, `authority` after `destination` (D10, D8).
    expect(o.err).toMatch(/line\s+state\s+label\s+address\s+destination\s+authority\s+SOL \(tokens not read\)/)
    expect(o.err).not.toContain("This acknowledges permanent TEE exposure")
    // The controlled-by block is the last thing on stderr before the prompt (D4).
    expect(o.stderrAtPrompt[0]?.endsWith(`\n${controlledByBlock(2)}\n`)).toBe(true)
    expect(o.linePrompts).toEqual([confirmPrompt(2)])
  })

  test("T3: confirm, Confirm and padded CONFIRM proceed; EXPOSE, yes, the old token and empty each refuse with zero writes", async () => {
    for (const accepted of ["confirm", "Confirm", "  CONFIRM  "]) {
      const f = await fixture(["a", "b", "cold"])
      const file = await pairsFile(f.dir, "a cold\nb cold\n")
      const o = await runBatch(f, { file, lines: [accepted] })
      expect([accepted, o.code]).toEqual([accepted, 0])
      expect(o.submits.n).toBe(2)
    }
    for (const refused of ["EXPOSE", "yes", "y", `2 ${"CwTwwC"}`, ""]) {
      const f = await fixture(["a", "b", "cold"])
      const before = await readEntries(f)
      const file = await pairsFile(f.dir, "a cold\nb cold\n")
      const o = await runBatch(f, { file, lines: [refused, "should not be asked"] })
      expect([refused, o.code]).toEqual([refused, 1])
      expect(o.err).toContain("The acknowledgement is the word confirm; nothing was promoted, and nothing was written.")
      expect(o.linePrompts).toEqual([confirmPrompt(2)])
      expect((await readEntries(f)).generation).toBe(before.generation)
      expect(o.submits.n).toBe(0)
      expect(o.inits.n).toBe(0)
    }
  })

  test("T-A3, T-A4: a wrong answer writes nothing, exits 1, never echoes what was typed, and is not re-asked", async () => {
    const f = await fixture(["a", "b", "cold"])
    const before = await readEntries(f)
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, { file, lines: ["zzzzzz-typed", "should not be asked"], json: true })
    expect(o.code).toBe(1)
    const docs = jsonDocuments(o.out)
    expect(docs).toHaveLength(1)
    const body = JSON.parse(docs[0] as string)
    expect(body).toMatchObject({ ok: false, code: "PROMOTE_NOT_ACKNOWLEDGED" })
    expect(body.message).toBe("The acknowledgement is the word confirm; nothing was promoted, and nothing was written.")
    expect(body.suggestion).toBe("Run the command again and type confirm at the prompt.")
    expect(o.out + o.err).not.toContain("zzzzzz-typed")
    expect(o.linePrompts).toEqual([confirmPrompt(2)])
    expect((await readEntries(f)).generation).toBe(before.generation)
    expect(o.submits.n).toBe(0)
  })
})

describe("T-R2 to T-R6: re-runs", () => {
  test("T-R2: three of five already landed: skip on those, an acting count of 2, and the acknowledgement expects 2", async () => {
    const f = await fixture(["a", "b", "c", "d", "e", "cold"])
    const cold = f.addresses.cold as string
    await seed(f, (e) =>
      ["a", "b", "c"].includes(e.label) ? { ...e, ...teeSeed("enabled", cold, { grant: true, linked: true }) } : e,
    )
    const file = await pairsFile(f.dir, "a cold\nb cold\nc cold\nd cold\ne cold\n")
    // The acting count (2), not the file's row count (5), is what the prompt, the sentence and
    // the block name.
    const wrong = await runBatch(f, { file, lines: ["no"] })
    expect(wrong.code).toBe(1)
    expect(wrong.err).toContain("The acknowledgement is the word confirm")
    expect(wrong.err).toContain("5 rows from")
    expect(wrong.err).toContain("3 already promoted (skipped), 0 to resume, 2 to promote.")
    expect(wrong.err).toMatch(/^1\s+skip\s+a\s/m)
    expect(wrong.err).toMatch(/^4\s+promote\s+d\s/m)
    expect(wrong.out).toContain("a permanent copy of these 2 keys")
    expect(wrong.err).toContain("These 2 keys will be controlled by:")
    expect(wrong.linePrompts).toEqual([confirmPrompt(2)])
    // Skip rows get no role requests: two acting keys, nine each (D7).
    expect(wrong.rpc.getProgramAccounts).toBe(2 * REQUESTS_PER_KEY)

    const right = await runBatch(f, { file, ack: "correct" })
    void cold
    expect(right.code).toBe(0)
    expect(right.submits.addresses).toEqual([f.addresses.d as string, f.addresses.e as string])
    expect(right.out).toContain(
      "2 addresses promoted under one unlock, each committed on its own; 3 already promoted (skipped).",
    )
  })

  test("T-R3: an import-pending row resumes through resumePromote with zero import calls and zero confirmLastSix calls", async () => {
    const f = await fixture(["a", "ip", "cold"])
    const cold = f.addresses.cold as string
    await seed(f, (e) => (e.label === "ip" ? { ...e, ...teeSeed("import-pending", cold, { grant: true }) } : e))
    const file = await pairsFile(f.dir, "a cold\nip cold\n")
    const o = await runBatch(f, {
      file,
      ack: "correct",
      json: true,
      api: { wallets: grantedWallets([{ address: f.addresses.ip as string, vaultDestination: cold }]) },
    })
    expect(o.code).toBe(0)
    // The one import is row 1's. Row 2 adopted the grant.
    expect(o.submits.addresses).toEqual([f.addresses.a as string])
    expect(o.linePrompts).toEqual([confirmPrompt(2)])
    const docs = jsonDocuments(o.out)
    expect(docs).toHaveLength(1)
    const body = JSON.parse(docs[0] as string)
    expect(body).toMatchObject({ ok: true, complete: true, rows: 2, promoted: 1, resumed: 1, skipped: 0 })
    expect(body.keys[1]).toMatchObject({ line: 2, label: "ip", state: "resumed", lifecycle: "enabled", importCalls: 0 })
    expect(body.destinations).toEqual([{ label: "cold", address: cold, keys: 2 }])
  })

  test("T-R4: an on-disk destination that differs from the file's refuses the whole batch, naming both", async () => {
    const f = await fixture(["a", "done", "d1", "d2"])
    await seed(f, (e) =>
      e.label === "done" ? { ...e, ...teeSeed("enabled", f.addresses.d1, { grant: true, linked: true }) } : e,
    )
    const before = await readEntries(f)
    const file = await pairsFile(f.dir, "a d2\ndone d2\n")
    const o = await runBatch(f, { file, json: true })
    expect(o.code).toBe(1)
    const body = batchRefusal(o)
    expect(body.rows).toEqual([
      {
        line: 2,
        label: "done",
        destination: "d2",
        code: "PROMOTE_ALREADY_TEE_WALLET",
        message: "done is already a TEE wallet (enabled).",
        why: `On disk it sweeps to ${f.addresses.d1}; this file says d2 (${f.addresses.d2}).`,
      },
    ])
    expect((await readEntries(f)).generation).toBe(before.generation)
  })

  test("T-R5: a skip row whose destination is now everRemoteExposed does not refuse", async () => {
    const f = await fixture(["a", "done", "cold"])
    const cold = f.addresses.cold as string
    // `done` landed in an earlier run; a LATER row of that run then promoted `cold` itself, so the
    // destination is exposed now. Re-checking `done` against the cold rule would refuse a correct,
    // completed promotion.
    await seed(f, (e) =>
      e.label === "done"
        ? { ...e, ...teeSeed("enabled", cold, { grant: true, linked: true }) }
        : e.label === "cold"
          ? { ...e, exposure: { everRemoteExposed: true, everExported: false } }
          : e,
    )
    const file = await pairsFile(f.dir, "done cold\na cold\n")
    const o = await runBatch(f, { file, json: true })
    // Row 2 is a fresh promote to an exposed destination, so IT refuses, on the shipped rule; the
    // skip row is not a failure line.
    expect(o.code).toBe(1)
    const body = batchRefusal(o)
    expect(body.rows.map((row) => row.line)).toEqual([2])
    expect(body.rows[0]?.code).toBe("PROMOTE_DESTINATION_NOT_COLD")
  })

  test("T-R6: acting count 0 prints the table, prompts for nothing, exits 0", async () => {
    const f = await fixture(["a", "b", "cold"])
    const cold = f.addresses.cold as string
    await seed(f, (e) =>
      ["a", "b"].includes(e.label) ? { ...e, ...teeSeed("enabled", cold, { grant: true, linked: true }) } : e,
    )
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, { file })
    expect(o.code).toBe(0)
    expect(o.linePrompts).toEqual([])
    expect(o.err).toContain("2 already promoted (skipped), 0 to resume, 0 to promote.")
    expect(o.err).toContain("Nothing to do: every row already landed.")
    expect(o.out).not.toContain(SENTENCE_PREFIX)
    // No acting rows, so the role check does not run: no requests, no opening line, no done line.
    expect(o.rpc.getProgramAccounts).toBe(0)
    expect(o.err).not.toContain("Checking token mint")
    expect(o.err).not.toContain("✓ authorities")
    const json = await runBatch(f, { file, json: true })
    expect(json.code).toBe(0)
    expect(JSON.parse(json.out)).toMatchObject({
      ok: true,
      complete: true,
      rows: 2,
      promoted: 0,
      resumed: 0,
      skipped: 2,
      authorities: { checked: [...ROLE_GROUP_IDS], notChecked: [], found: [] },
    })
  })
})

describe("T-C1, T-C2: one commit per key, a mid-run failure stops the batch", () => {
  test("a submit that fails on the fourth row leaves three promoted, the fourth import-pending, the fifth untouched; re-running the same file resumes", async () => {
    const f = await fixture(["a", "b", "c", "d", "e", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\nc cold\nd cold\ne cold\n")
    const o = await runBatch(f, {
      file,
      ack: "correct",
      api: { submit: (n) => (n === 4 ? jsonResponse(500, { success: false, error: "privy down" }) : undefined) },
    })
    expect(o.code).toBe(1)
    expect(o.submits.n).toBe(4)
    expect(o.err).toContain("3 of 5 rows landed and ARE in the vault; the vault is intact. 2 remain.")
    expect(o.err).toContain(
      "Re-run the same file: the rows that landed are skipped, an interrupted row resumes, and the rest are promoted.",
    )
    const after = await readEntries(f)
    const by = (label: string) => after.entries.find((e) => e.label === label)
    expect(["a", "b", "c"].map((l) => by(l)?.tee?.lifecycle)).toEqual(["enabled", "enabled", "enabled"])
    expect(by("d")?.tee?.lifecycle).toBe("import-pending")
    expect(by("e")?.role).toBe("vault")

    // The re-run: 3 skip, 1 resume (the server holds d's grant now), 1 promote.
    const again = await runBatch(f, {
      file,
      ack: "correct",
      api: { wallets: grantedWallets([{ address: f.addresses.d as string, vaultDestination: f.addresses.cold }]) },
    })
    expect(again.code).toBe(0)
    expect(again.err).toContain("3 already promoted (skipped), 1 to resume, 1 to promote.")
    expect(again.submits.addresses).toEqual([f.addresses.e as string])
    const done = await readEntries(f)
    expect(done.entries.filter((e) => e.tee?.lifecycle === "enabled")).toHaveLength(5)
  })
})

describe("T-H1, T-H2, T-H3: the bounded holdings read", () => {
  test("T-H1: 146 addresses are two getMultipleAccounts requests; token accounts only under --token-holdings", async () => {
    const made = await makeVault()
    closeVault(made.vault)
    const f: Fixture = { dir: made.dir, path: made.path, passphrase: made.passphrase, addresses: {} }
    const keys = await newKeys(f.dir, f.passphrase, 147)
    const labels = Object.keys(keys)
    const dest = labels[146] as string
    const file = await pairsFile(
      f.dir,
      `${labels
        .slice(0, 146)
        .map((label) => `${label} ${dest}`)
        .join("\n")}\n`,
    )
    const o = await runBatch(f, { file, lines: ["no"] })
    expect(o.code).toBe(1)
    expect(o.rpc.getMultipleAccounts).toBe(2)
    expect(o.rpc.getTokenAccountsByOwner).toBe(0)
    expect(o.err).toContain("✓ SOL read for 146 addresses (2 requests)")
    expect(o.err).toContain("146 rows from")
    // BE-296 (D7): the opening line names the request count before the first one is sent, and
    // the acting rows get nine requests each.
    expect(o.err).toContain(
      "Checking token mint, freeze, program upgrade and stake authorities for 146 addresses: 1,314 requests over rpc.pb.test.",
    )
    expect(o.rpc.getProgramAccounts).toBe(1314)
    expect(o.err).toContain("✓ authorities read for 146 addresses (1,314 requests, 7 of 7 groups read) in 0s")
    expect(o.out).toContain("a permanent copy of these 146 keys")
    expect(o.linePrompts).toEqual([confirmPrompt(146)])

    const tokens = await runBatch(f, { file, lines: ["no"], args: ["--token-holdings"] })
    expect(tokens.rpc.getMultipleAccounts).toBe(2)
    expect(tokens.rpc.getTokenAccountsByOwner).toBe(292)
    expect(tokens.err).toContain("Reading token accounts for 146 addresses: 292 requests over rpc.pb.test.")
    expect(tokens.err).toContain("Token accounts were read under both programs.")
  })

  test("T-H2: without --token-holdings the header and the footer both say token accounts were not read", async () => {
    const f = await fixture(["a", "b", "cold"])
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, { file, lines: ["no"] })
    expect(o.err).toContain("SOL (tokens not read)")
    expect(o.err).toContain("Token accounts were not read (pass --token-holdings).")
    expect(o.err).toContain("SOL read at 1970-01-01T00:00:00.000Z over rpc.pb.test.")
  })

  test("T-H3: a failed SOL read keeps the table, shows unread, and refuses rather than degrading", async () => {
    const f = await fixture(["a", "b", "cold"])
    const before = await readEntries(f)
    const file = await pairsFile(f.dir, "a cold\nb cold\n")
    const o = await runBatch(f, { file, rpc: { failMultiple: true } })
    expect(o.code).toBe(1)
    expect(o.linePrompts).toEqual([])
    expect(o.err).toMatch(/^1\s+promote\s+a\s+\S+\s+cold \(…\w+\)\s+\?\s+unread$/m)
    expect(o.err).toContain(
      "SOL read over rpc.pb.test FAILED: RPC getMultipleAccounts failed: HTTP 500. The batch is refused.",
    )
    expect(o.err).toContain("The SOL read over rpc.pb.test failed")
    expect(o.out).not.toContain(SENTENCE_PREFIX)
    // The batch refuses right here, so the role read is not made and the column reads `?`.
    expect(o.rpc.getProgramAccounts).toBe(0)
    expect((await readEntries(f)).generation).toBe(before.generation)
  })
})
