/**
 * Key signers K3 (spec docs/superpowers/specs/2026-09-25-key-signers-design.md): the commands, end
 * to end through `run()`, against `SignerSim`, which verifies every owner change against the
 * wallet's current owner. T1 (`tee signer new`), T7 (trading picks the owner's signer), T9
 * (`keys signer move`), T10 (same-machine rotation), T11's CLI half (`tee rebind`) and T12
 * (`doctor`'s rows and the device-token warning).
 */
import { describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import type { CliConfig } from "../config"
import type { Deps } from "../deps"
import { run } from "../index"
import {
  keySignerFingerprint,
  keySignerRef,
  localKeySigners,
  localSignerFor,
  readPin,
  saveKeySignerEntry,
  spkiSha256Of,
} from "../key-signers"
import { pemToStoredSigner, walletSignerRef } from "../secret-store"
import {
  createCapture,
  createFakeClock,
  createFakeConfigStore,
  createFakeStore,
  createRoutedFetch,
  createTestDeps,
} from "../test-support"
import { completeTradingWallet, TradingError } from "../trading"
import { SignerSim, type SimWallet } from "./__fixtures__/key-signer-sim"
import { DEVICE_TOKEN_BESIDE_SIGNER_LINE, keySignerDoctorRows } from "./key-signer"
import { RELAY_SIGNER_LINE } from "./tee-rebind"

const PREFIX = "Tr2KeyAb"
const API_KEY = `cndl_live_${PREFIX}${"x".repeat(35)}`
const FROM = "FromKey1"
const TO = "ToKey123"
const DEVICE_TOKEN = "cndl_dvc_owner"

function pair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  return {
    pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyDer: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  }
}

function wallet(id: string, over: Partial<SimWallet> & { recorded: string }): SimWallet {
  return {
    id,
    address: `Addr${id}`,
    label: id.toLowerCase(),
    privyWalletId: `pw-${id}`,
    boundKeyPrefix: PREFIX,
    owner: over.recorded,
    ...over,
  }
}

interface Harness {
  deps: Deps
  sim: SignerSim
  stdout: ReturnType<typeof createCapture>
  stderr: ReturnType<typeof createCapture>
  store: ReturnType<typeof createFakeStore>
  secretPrompts: string[]
  linePrompts: string[]
  calls: Array<{ url: string; init: RequestInit }>
}

/** One machine: an in-memory store and config, a fake clock, and the simulator's routes. */
function machine(
  sim: SignerSim,
  opts: {
    apiKey?: boolean
    deviceToken?: boolean
    secrets?: string[]
    lines?: string[]
    store?: Record<string, string>
    config?: CliConfig
    clock?: ReturnType<typeof createFakeClock>
  } = {},
): Harness {
  const { fetch, calls } = createRoutedFetch(sim.routes())
  const stdout = createCapture()
  const stderr = createCapture()
  const store = createFakeStore({
    ...(opts.deviceToken ? { device_token: DEVICE_TOKEN } : {}),
    ...(opts.store ?? {}),
  })
  const config = createFakeConfigStore(opts.config ?? {})
  const clock = opts.clock ?? createFakeClock(1_000)
  const secrets = [...(opts.secrets ?? [])]
  const lines = [...(opts.lines ?? [])]
  const secretPrompts: string[] = []
  const linePrompts: string[] = []
  const deps = createTestDeps({
    fetch,
    store,
    stdout,
    stderr,
    now: clock.now,
    sleep: clock.sleep,
    env: opts.apiKey ? { CANDLE_API_KEY: API_KEY } : {},
    readConfig: config.readConfig,
    writeConfig: config.writeConfig,
    clearConfig: config.clearConfig,
    updateProfile: config.updateProfile,
    promptSecret: async (text) => {
      secretPrompts.push(text)
      const next = secrets.shift()
      if (next === undefined) throw new Error(`unscripted secret prompt: ${text}`)
      return next
    },
    promptLine: async (text) => {
      linePrompts.push(text)
      return lines.shift() ?? ""
    },
    writeFile: async () => {},
  })
  return { deps, sim, stdout, stderr, store, secretPrompts, linePrompts, calls }
}

/** Puts a key signer on a machine: the private half in the store, the facts in the index. */
async function holdSigner(h: Harness, keyPrefix: string, p: { pem: string; publicKeyDer: string }, quorum?: string) {
  const spkiSha256 = spkiSha256Of(p.publicKeyDer)
  await h.deps.store.set(keySignerRef(keyPrefix, spkiSha256), pemToStoredSigner(p.pem))
  await saveKeySignerEntry(h.deps, {
    keyPrefix,
    spkiSha256,
    fingerprint: keySignerFingerprint(spkiSha256),
    publicKeyDer: p.publicKeyDer,
    ...(quorum !== undefined ? { signerQuorumId: quorum } : {}),
    createdAt: 1,
  })
  return spkiSha256
}

const requestCalls = (h: Harness) => h.calls.filter((c) => c.url.endsWith("/signer/request"))

// ── T1: tee signer new ─────────────────────────────────────────────────────────────────────────

describe("T1: candle tee signer new", () => {
  test("stores the pair at key_signer_<prefix>_<spkiSha256>, prints the fingerprint the request returned, and records the quorum on approval", async () => {
    const clock = createFakeClock(1_000)
    const sim = new SignerSim(clock.now)
    sim.addKey({ keyPrefix: PREFIX, label: "tr-2", apiKey: API_KEY })
    sim.approveOnRead = 2
    const h = machine(sim, { apiKey: true, clock })
    expect(await run(["tee", "signer", "new", "--key", "tr-2"], h.deps)).toBe(0)

    expect(sim.requests).toHaveLength(1)
    const sent = sim.requests[0]?.publicKeyDer as string
    const sha = spkiSha256Of(sent)
    const [entry] = await localKeySigners(h.deps, PREFIX)
    expect(entry?.spkiSha256).toBe(sha)
    expect(await h.store.get(keySignerRef(PREFIX, sha))).not.toBeNull()
    // The fingerprint printed is the server's for what was sent, and the code is the request's.
    expect(h.stderr.text).toContain(keySignerFingerprint(sha))
    expect(h.stderr.text).toContain(`candle keys signer approve ${sim.requests[0]?.userCode} --key ${PREFIX}`)
    expect(entry?.signerQuorumId).toBe(sim.keys.get(PREFIX)?.active?.quorum as string)
    expect(h.stdout.text).toContain(`Approved: key ${PREFIX}'s signer is ${keySignerFingerprint(sha)}`)
    // No device token here: no D2 warning.
    expect(h.stderr.text).not.toContain(DEVICE_TOKEN_BESIDE_SIGNER_LINE)
  })

  test("the code expires: the pair stays pending; the next run re-requests the SAME public key with a new code, and generates nothing", async () => {
    const clock = createFakeClock(1_000)
    const sim = new SignerSim(clock.now)
    sim.addKey({ keyPrefix: PREFIX, label: "tr-2", apiKey: API_KEY })
    const h = machine(sim, { apiKey: true, clock })
    expect(await run(["tee", "signer", "new", "--key", PREFIX, "--json"], h.deps)).toBe(1)
    expect(JSON.parse(h.stdout.text).code).toBe("KEY_SIGNER_NOT_APPROVED")
    const [pending] = await localKeySigners(h.deps, PREFIX)
    expect(pending?.signerQuorumId).toBeUndefined()
    // The server row expired (the simulator drops it past expiresAt); it is not revived.
    expect(sim.keys.get(PREFIX)?.pending).toBeNull()

    sim.approveOnRead = 1
    expect(await run(["tee", "signer", "new", "--key", PREFIX], h.deps)).toBe(0)
    expect(sim.requests).toHaveLength(2)
    expect(sim.requests[1]?.publicKeyDer).toBe(sim.requests[0]?.publicKeyDer as string)
    expect(sim.requests[1]?.userCode).not.toBe(sim.requests[0]?.userCode)
    const entries = await localKeySigners(h.deps, PREFIX)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.signerQuorumId).toBe(sim.keys.get(PREFIX)?.active?.quorum as string)
  })

  test("a lost approval: GET first; the active spkiSha256 is the local pair, so the quorum is written from it and nothing is requested", async () => {
    const clock = createFakeClock(1_000)
    const sim = new SignerSim(clock.now)
    const p = pair()
    sim.addKey({ keyPrefix: PREFIX, apiKey: API_KEY, active: sim.signer(p.publicKeyDer, "q-approved") })
    const h = machine(sim, { apiKey: true, clock })
    await holdSigner(h, PREFIX, p) // pending locally: approval happened, the response was lost
    expect(await run(["tee", "signer", "new", "--key", PREFIX], h.deps)).toBe(0)
    expect(requestCalls(h)).toHaveLength(0)
    expect((await localKeySigners(h.deps, PREFIX))[0]?.signerQuorumId).toBe("q-approved")
  })

  test("--key naming a key other than this machine's API key refuses; nothing is generated or sent", async () => {
    const sim = new SignerSim(() => 0)
    sim.addKey({ keyPrefix: PREFIX, label: "tr-2", apiKey: API_KEY })
    const h = machine(sim, { apiKey: true })
    expect(await run(["tee", "signer", "new", "--key", "OtherKey", "--json"], h.deps)).toBe(1)
    expect(JSON.parse(h.stdout.text).code).toBe("KEY_SIGNER_KEY_MISMATCH")
    expect(await localKeySigners(h.deps)).toHaveLength(0)
    expect(requestCalls(h)).toHaveLength(0)
  })

  test("T12: warns when a device token shares the context", async () => {
    const clock = createFakeClock(1_000)
    const sim = new SignerSim(clock.now)
    sim.addKey({ keyPrefix: PREFIX, apiKey: API_KEY })
    sim.approveOnRead = 1
    const h = machine(sim, { apiKey: true, deviceToken: true, clock })
    expect(await run(["tee", "signer", "new", "--key", PREFIX], h.deps)).toBe(0)
    expect(h.stderr.text).toContain(DEVICE_TOKEN_BESIDE_SIGNER_LINE)
  })
})

// ── T10: same-machine rotation ────────────────────────────────────────────────────────────────

describe("T10: same-machine rotation", () => {
  test("refuses while this machine's signer for the key still owns wallets, naming the count; --force adds a slot and keeps the old one trading", async () => {
    const clock = createFakeClock(1_000)
    const sim = new SignerSim(clock.now)
    const old = pair()
    sim.addKey({ keyPrefix: PREFIX, apiKey: API_KEY, active: sim.signer(old.publicKeyDer, "q-old") })
    sim.wallets.push(wallet("W1", { recorded: "q-old" }), wallet("W2", { recorded: "q-old" }))
    const h = machine(sim, { apiKey: true, clock })
    const oldSha = await holdSigner(h, PREFIX, old, "q-old")

    expect(await run(["tee", "signer", "new", "--key", PREFIX, "--json"], h.deps)).toBe(1)
    const refused = JSON.parse(h.stdout.text)
    expect(refused.code).toBe("KEY_SIGNER_ROTATION_REFUSED")
    expect(refused.message).toContain("2 wallets")
    expect(requestCalls(h)).toHaveLength(0)
    expect(await h.store.get(keySignerRef(PREFIX, oldSha))).not.toBeNull()

    sim.approveOnRead = 1
    expect(await run(["tee", "signer", "new", "--key", PREFIX, "--force"], h.deps)).toBe(0)
    const entries = await localKeySigners(h.deps, PREFIX)
    expect(entries).toHaveLength(2)
    expect(await h.store.get(keySignerRef(PREFIX, oldSha))).not.toBeNull()
    // The two wallets are now moving, and still signed here by the old slot.
    expect((await localSignerFor(h.deps, "W1", "q-old"))?.pem).toBe(old.pem)
  })
})

// ── T7: trading selects the owner's signer ────────────────────────────────────────────────────

describe("T7: trading selects the local signer whose quorum is the wallet's owner", () => {
  const row = (id: string, signerQuorumId?: string) => ({
    id,
    address: `Addr${id}`,
    label: id,
    chain: "solana",
    active: true,
    allowLaunch: false,
    privyWalletId: `pw-${id}`,
    ...(signerQuorumId !== undefined ? { signerQuorumId } : {}),
  })

  test("the key signer, a moving wallet's previous signer, the legacy slot; elsewhere, SIGNER_UNAVAILABLE names the key", async () => {
    const sim = new SignerSim(() => 0)
    const active = pair()
    const previous = pair()
    const legacy = pair()
    sim.addKey({
      keyPrefix: PREFIX,
      apiKey: API_KEY,
      active: sim.signer(active.publicKeyDer, "q-active"),
      previous: ["q-old"],
    })
    sim.wallets.push(wallet("W-moving", { recorded: "q-old" }))
    const h = machine(sim, { apiKey: true, store: { [walletSignerRef("W-legacy")]: pemToStoredSigner(legacy.pem) } })
    await holdSigner(h, PREFIX, active, "q-active")
    await holdSigner(h, PREFIX, previous, "q-old")
    const ctx = { deps: h.deps, json: false, apiUrl: "https://api.test", verifyAccount: false }
    const key = { apiKey: API_KEY, keyPrefix: PREFIX }

    expect((await completeTradingWallet(ctx, row("W1", "q-active"), "app", "swap:write", "solana", key)).signer).toBe(
      active.pem,
    )
    expect(
      (await completeTradingWallet(ctx, row("W-moving", "q-old"), "app", "swap:write", "solana", key)).signer,
    ).toBe(previous.pem)
    expect(
      (await completeTradingWallet(ctx, row("W-legacy", "q-leg"), "app", "swap:write", "solana", key)).signer,
    ).toBe(legacy.pem)
    // An older API that sends no signerQuorumId: the legacy slot, as before.
    expect((await completeTradingWallet(ctx, row("W-legacy"), "app", "swap:write", "solana", key)).signer).toBe(
      legacy.pem,
    )

    // Another machine: holds nothing.
    const other = machine(sim, { apiKey: true })
    const otherCtx = { deps: other.deps, json: false, apiUrl: "https://api.test", verifyAccount: false }
    const onActive = await completeTradingWallet(
      otherCtx,
      row("W1", "q-active"),
      "app",
      "swap:write",
      "solana",
      key,
    ).catch((e) => e)
    expect(onActive).toBeInstanceOf(TradingError)
    expect((onActive as TradingError).code).toBe("SIGNER_UNAVAILABLE")
    expect((onActive as TradingError).message).toContain(
      `owned by key ${PREFIX}'s signer (${sim.keys.get(PREFIX)?.active?.fingerprint}), which is on another machine`,
    )
    const moving = await completeTradingWallet(
      otherCtx,
      row("W-moving", "q-old"),
      "app",
      "swap:write",
      "solana",
      key,
    ).catch((e) => e)
    expect((moving as TradingError).message).toContain(`run candle keys signer move ${PREFIX} on the machine that does`)
  })
})

// ── T9: keys signer move ─────────────────────────────────────────────────────────────────────

describe("T9: candle keys signer move", () => {
  function setup() {
    const sim = new SignerSim(() => 0)
    const active = pair()
    const old = pair()
    const legacy1 = pair()
    const legacy4 = pair()
    sim.addKey({
      keyPrefix: PREFIX,
      apiKey: API_KEY,
      active: sim.signer(active.publicKeyDer, "q-new"),
      previous: ["q-old"],
    })
    sim.quorumFor(old.publicKeyDer, "q-old")
    sim.quorumFor(legacy1.publicKeyDer, "q-leg-1")
    sim.quorumFor(legacy4.publicKeyDer, "q-leg-4")
    sim.wallets.push(
      wallet("W1", { recorded: "q-leg-1" }), // legacy, its per-wallet signer is here
      wallet("W2", { recorded: "q-old" }), // moving, the previous signer is here
      wallet("W3", { recorded: "q-old", owner: "q-new" }), // moving, the owner change landed and the record did not
      wallet("W4", { recorded: "q-leg-4" }), // legacy, its signer is on another machine
    )
    return { sim, active, old, legacy1 }
  }

  test("moves the wallets whose owner is here, completes a landed one from the GET, skips one that is not, and deletes only drained slots", async () => {
    const { sim, active, old, legacy1 } = setup()
    const h = machine(sim, { apiKey: true, store: { [walletSignerRef("W1")]: pemToStoredSigner(legacy1.pem) } })
    const activeSha = await holdSigner(h, PREFIX, active, "q-new")
    const oldSha = await holdSigner(h, PREFIX, old, "q-old")

    expect(await run(["keys", "signer", "move", PREFIX, "--json"], h.deps)).toBe(0)
    const doc = JSON.parse(h.stdout.text)
    expect(doc.moved.sort()).toEqual(["W1", "W2"])
    expect(doc.notOnThisMachine).toEqual(["W4"])
    // Only W1 and W2 were signed; W3 completed from the GET with no signature at all.
    expect(sim.relays.map((r) => r.walletId).sort()).toEqual(["W1", "W2"])
    for (const relay of sim.relays) {
      expect(Object.keys(relay.body).sort()).toEqual(["authorizationSignature", "body"])
      expect(relay.body.body).toEqual({ owner_id: "q-new" })
      expect(relay.headers["x-api-key"]).toBe(API_KEY)
      expect(relay.headers.authorization).toBeUndefined()
    }
    expect(
      sim.wallets
        .filter((w) => w.owner === "q-new")
        .map((w) => w.id)
        .sort(),
    ).toEqual(["W1", "W2", "W3"])
    // The previous signer's slot is gone (no wallet left on q-old), the legacy slot too; the active stays.
    expect(await h.store.get(keySignerRef(PREFIX, oldSha))).toBeNull()
    expect(await h.store.get(walletSignerRef("W1"))).toBeNull()
    expect(await h.store.get(keySignerRef(PREFIX, activeSha))).not.toBeNull()
    expect((await localKeySigners(h.deps, PREFIX)).map((e) => e.spkiSha256)).toEqual([activeSha])

    // Resumable: run again, nothing is left to sign here.
    sim.relays = []
    expect(await run(["keys", "signer", "move", PREFIX], h.deps)).toBe(0)
    expect(sim.relays).toHaveLength(0)
  })

  test("keeps the previous signer's slot while a wallet is still on it", async () => {
    const { sim, active, old, legacy1 } = setup()
    sim.failRelay.add("W2")
    const h = machine(sim, { apiKey: true, store: { [walletSignerRef("W1")]: pemToStoredSigner(legacy1.pem) } })
    await holdSigner(h, PREFIX, active, "q-new")
    const oldSha = await holdSigner(h, PREFIX, old, "q-old")
    expect(await run(["keys", "signer", "move", PREFIX], h.deps)).toBe(1)
    expect(await h.store.get(keySignerRef(PREFIX, oldSha))).not.toBeNull()
    expect(h.stdout.text).toContain(`Kept ${keySignerRef(PREFIX, oldSha)}: 1 wallet still on it.`)
  })

  test("a key with no active signer: KEY_SIGNER_MISSING, nothing signed", async () => {
    const sim = new SignerSim(() => 0)
    sim.addKey({ keyPrefix: PREFIX, apiKey: API_KEY })
    sim.wallets.push(wallet("W1", { recorded: "q-leg-1" }))
    const h = machine(sim, { apiKey: true })
    expect(await run(["keys", "signer", "move", PREFIX, "--json"], h.deps)).toBe(1)
    expect(JSON.parse(h.stdout.text).code).toBe("KEY_SIGNER_MISSING")
    expect(sim.relays).toHaveLength(0)
  })

  function revokedToLive() {
    const sim = new SignerSim(() => 0)
    const old = pair()
    const live = pair()
    sim.addKey({ keyPrefix: PREFIX, revoked: true, previous: ["q-old"] })
    sim.addKey({ keyPrefix: TO, label: "live", active: sim.signer(live.publicKeyDer, "q-live") })
    sim.quorumFor(old.publicKeyDer, "q-old")
    sim.wallets.push(wallet("W2", { recorded: "q-old" }))
    const liveFp = sim.keys.get(TO)?.active?.fingerprint as string
    return { sim, old, live, liveFp }
  }

  test("T16: a revoked key's wallets move to a live key with --to-key and the device token, owner and binding together, after the live key's full fingerprint is typed", async () => {
    const { sim, old, live, liveFp } = revokedToLive()
    const h = machine(sim, { deviceToken: true, secrets: [liveFp] })
    const oldSha = await holdSigner(h, PREFIX, old, "q-old")

    expect(await run(["keys", "signer", "move", PREFIX, "--to-key", TO], h.deps)).toBe(0)
    // D3: the same pin `tee rebind` asks for, before the first owner change is signed.
    expect(h.secretPrompts).toEqual([`Type the full fingerprint of key ${TO}'s signer, all three groups: `])
    expect(h.stderr.text).toContain(`Key ${TO}'s signer is ${liveFp}. This machine has not pinned it yet`)
    expect((await readPin(h.deps, TO))?.spkiSha256).toBe(spkiSha256Of(live.publicKeyDer))
    const commits = sim.rebinds.filter((b) => b.dryRun !== true)
    expect(commits).toHaveLength(2)
    expect(commits[0]?.owner).toBeUndefined()
    expect(Object.keys(commits[1]?.owner as object)).toEqual(["W2"])
    const moved = sim.wallets[0] as SimWallet
    expect([moved.boundKeyPrefix, moved.owner]).toEqual([TO, "q-live"])
    expect(await h.store.get(keySignerRef(PREFIX, oldSha))).toBeNull()

    // A pin of the same full hash asks nothing the next time.
    sim.wallets.push(wallet("W5", { recorded: "q-old" }))
    await holdSigner(h, PREFIX, old, "q-old")
    h.secretPrompts.length = 0
    expect(await run(["keys", "signer", "move", PREFIX, "--to-key", TO], h.deps)).toBe(0)
    expect(h.secretPrompts).toHaveLength(0)
    expect((sim.wallets[1] as SimWallet).owner).toBe("q-live")
  })

  test("T16: a wrong or one-group fingerprint for the live key refuses before any commit; nothing is signed, moved or pinned", async () => {
    for (const oneGroup of [false, true]) {
      const { sim, old, liveFp } = revokedToLive()
      const typed = oneGroup ? (liveFp.split("-")[3] as string) : "CNDL-0000-0000-0000"
      const h = machine(sim, { deviceToken: true, secrets: [typed] })
      await holdSigner(h, PREFIX, old, "q-old")
      expect(await run(["keys", "signer", "move", PREFIX, "--to-key", TO, "--json"], h.deps)).toBe(1)
      const doc = JSON.parse(h.stdout.text)
      expect(doc.code).toBe("KEY_SIGNER_FINGERPRINT_MISMATCH")
      expect(doc.message).toContain("Nothing was signed, nothing moved and nothing was pinned.")
      expect(sim.rebinds.filter((b) => b.dryRun !== true)).toHaveLength(0)
      expect(sim.wallets[0]).toMatchObject({ boundKeyPrefix: PREFIX, owner: "q-old" })
      expect(await readPin(h.deps, TO)).toBeUndefined()
    }
  })

  test("T16: with no terminal, an unpinned live signer refuses before any commit instead of prompting", async () => {
    const { sim, old } = revokedToLive()
    const h = machine(sim, { deviceToken: true })
    h.deps.isTTY = { stdin: false, stdout: false, stderr: false }
    await holdSigner(h, PREFIX, old, "q-old")
    expect(await run(["keys", "signer", "move", PREFIX, "--to-key", TO, "--json"], h.deps)).toBe(1)
    expect(JSON.parse(h.stdout.text).code).toBe("KEY_SIGNER_FINGERPRINT_MISMATCH")
    expect(h.secretPrompts).toHaveLength(0)
    expect(sim.rebinds.filter((b) => b.dryRun !== true)).toHaveLength(0)
  })

  test("T16: a signer approved on the live key after the pin is not signed to: KEY_SIGNER_CHANGED, no owner sent", async () => {
    const { sim, old, liveFp } = revokedToLive()
    const other = pair()
    const h = machine(sim, { deviceToken: true })
    // The operator types the fingerprint the preview showed; the live key's signer changes before the commit.
    h.deps.promptSecret = async (text) => {
      h.secretPrompts.push(text)
      const key = sim.keys.get(TO)
      if (key) key.active = sim.signer(other.publicKeyDer, "q-other")
      return liveFp
    }
    await holdSigner(h, PREFIX, old, "q-old")
    expect(await run(["keys", "signer", "move", PREFIX, "--to-key", TO, "--json"], h.deps)).toBe(1)
    const doc = JSON.parse(h.stdout.text)
    expect(doc.code).toBe("KEY_SIGNER_CHANGED")
    expect(doc.message).toContain(`the server now names ${sim.keys.get(TO)?.active?.fingerprint}`)
    expect(sim.rebinds.filter((b) => b.dryRun !== true).map((b) => b.owner)).toEqual([undefined])
    expect(sim.wallets[0]).toMatchObject({ boundKeyPrefix: PREFIX, owner: "q-old" })
  })
})

// ── T11 (CLI half): tee rebind ───────────────────────────────────────────────────────────────

describe("T11: candle tee rebind onto a key", () => {
  test("with an active signer: the owner changes with the binding, signed here by the current owner, in one commit; the legacy slot goes after", async () => {
    const sim = new SignerSim(() => 0)
    const legacy = pair()
    const target = pair()
    sim.addKey({ keyPrefix: FROM })
    sim.addKey({ keyPrefix: TO, label: "tr-2", active: sim.signer(target.publicKeyDer, "q-to") })
    sim.quorumFor(legacy.publicKeyDer, "q-leg")
    sim.wallets.push(wallet("W1", { recorded: "q-leg", boundKeyPrefix: FROM }))
    const fingerprint = sim.keys.get(TO)?.active?.fingerprint as string
    const h = machine(sim, {
      deviceToken: true,
      secrets: [fingerprint],
      lines: ["confirm"],
      store: { [walletSignerRef("W1")]: pemToStoredSigner(legacy.pem) },
    })
    expect(await run(["tee", "rebind", "W1", "--to-key", TO], h.deps)).toBe(0)
    const commits = sim.rebinds.filter((b) => b.dryRun !== true)
    expect(commits.map((c) => Object.keys((c.owner as object) ?? {}))).toEqual([[], ["W1"]])
    expect(sim.wallets[0]).toMatchObject({ boundKeyPrefix: TO, owner: "q-to", recorded: "q-to" })
    expect((await readPin(h.deps, TO))?.spkiSha256).toBe(spkiSha256Of(target.publicKeyDer))
    expect(await h.store.get(walletSignerRef("W1"))).toBeNull()
    expect(h.stderr.text).toContain(`moves to key ${TO}'s signer ${fingerprint}`)
    expect(h.stderr.text).not.toContain(RELAY_SIGNER_LINE)
  })

  test("owner landed, bind failed: the re-run completes from the GET without a new signature", async () => {
    const sim = new SignerSim(() => 0)
    const target = pair()
    sim.addKey({ keyPrefix: FROM })
    sim.addKey({ keyPrefix: TO, active: sim.signer(target.publicKeyDer, "q-to") })
    sim.wallets.push(wallet("W1", { recorded: "q-leg", owner: "q-to", boundKeyPrefix: FROM }))
    const legacy = pair()
    const fingerprint = sim.keys.get(TO)?.active?.fingerprint as string
    const h = machine(sim, {
      deviceToken: true,
      secrets: [fingerprint],
      lines: ["confirm"],
      store: { [walletSignerRef("W1")]: pemToStoredSigner(legacy.pem) },
    })
    expect(await run(["tee", "rebind", "W1", "--to-key", TO], h.deps)).toBe(0)
    const commits = sim.rebinds.filter((b) => b.dryRun !== true)
    expect(commits).toHaveLength(1)
    expect(commits[0]?.owner).toBeUndefined()
    expect(sim.wallets[0]).toMatchObject({ boundKeyPrefix: TO, recorded: "q-to" })
  })

  test("onto a key with no signer: binding only, no owner signed; a key-signer wallet names its signer's machine, a legacy one keeps RELAY_SIGNER_LINE", async () => {
    const sim = new SignerSim(() => 0)
    const fromSigner = pair()
    sim.addKey({ keyPrefix: FROM, active: sim.signer(fromSigner.publicKeyDer, "q-from") })
    sim.addKey({ keyPrefix: TO })
    sim.wallets.push(
      wallet("W1", { recorded: "q-from", boundKeyPrefix: FROM }),
      wallet("W2", { recorded: "q-leg", boundKeyPrefix: FROM }),
    )
    const h = machine(sim, { deviceToken: true, lines: ["confirm"] })
    expect(await run(["tee", "rebind", "W1", "W2", "--to-key", TO], h.deps)).toBe(0)
    const commits = sim.rebinds.filter((b) => b.dryRun !== true)
    expect(commits).toHaveLength(1)
    expect(commits[0]?.owner).toBeUndefined()
    expect(sim.wallets.map((w) => w.owner)).toEqual(["q-from", "q-leg"])
    const fp = sim.keys.get(FROM)?.active?.fingerprint as string
    expect(h.stderr.text).toContain(
      `w1 stays owned by key ${FROM}'s signer ${fp}: trade it from the machine that holds that signer.`,
    )
    expect(h.stderr.text).not.toContain("w1 stays owned by key FromKey1's signer, which")
    expect(h.stderr.text).toContain(RELAY_SIGNER_LINE)
  })

  test("a signer approved on the target after the pin is not signed to: the commit's keySigner.spkiSha256 differs, KEY_SIGNER_CHANGED, nothing signed", async () => {
    const sim = new SignerSim(() => 0)
    const legacy = pair()
    const target = pair()
    const other = pair()
    sim.addKey({ keyPrefix: FROM })
    sim.addKey({ keyPrefix: TO, label: "tr-2", active: sim.signer(target.publicKeyDer, "q-to") })
    sim.quorumFor(legacy.publicKeyDer, "q-leg")
    sim.wallets.push(wallet("W1", { recorded: "q-leg", boundKeyPrefix: FROM }))
    const fingerprint = sim.keys.get(TO)?.active?.fingerprint as string
    const h = machine(sim, {
      deviceToken: true,
      secrets: [fingerprint],
      store: { [walletSignerRef("W1")]: pemToStoredSigner(legacy.pem) },
    })
    // Between the pin (at the preview) and the commit, another signer is approved on the target.
    h.deps.promptLine = async (text) => {
      h.linePrompts.push(text)
      const key = sim.keys.get(TO)
      if (key) key.active = sim.signer(other.publicKeyDer, "q-other")
      return "confirm"
    }
    expect(await run(["tee", "rebind", "W1", "--to-key", TO, "--json"], h.deps)).toBe(1)
    const doc = JSON.parse(h.stdout.text)
    expect(doc.code).toBe("KEY_SIGNER_CHANGED")
    expect(doc.message).toContain(`the server now names ${sim.keys.get(TO)?.active?.fingerprint}`)
    // One commit with no owner (the server's refusal named the new signer); no owner was ever signed or sent.
    expect(sim.rebinds.filter((b) => b.dryRun !== true).map((b) => b.owner)).toEqual([undefined])
    expect(sim.wallets[0]).toMatchObject({ boundKeyPrefix: FROM, owner: "q-leg", recorded: "q-leg" })
    // The pin is still the signer the operator confirmed, and the legacy slot is untouched.
    expect((await readPin(h.deps, TO))?.spkiSha256).toBe(spkiSha256Of(target.publicKeyDer))
    expect(await h.store.get(walletSignerRef("W1"))).not.toBeNull()
  })

  test("a target with no signer at the preview that has one at the commit: KEY_SIGNER_CHANGED, nothing signed", async () => {
    const sim = new SignerSim(() => 0)
    const legacy = pair()
    const other = pair()
    sim.addKey({ keyPrefix: FROM })
    sim.addKey({ keyPrefix: TO })
    sim.quorumFor(legacy.publicKeyDer, "q-leg")
    sim.wallets.push(wallet("W1", { recorded: "q-leg", boundKeyPrefix: FROM }))
    const h = machine(sim, { deviceToken: true, store: { [walletSignerRef("W1")]: pemToStoredSigner(legacy.pem) } })
    h.deps.promptLine = async () => {
      const key = sim.keys.get(TO)
      if (key) key.active = sim.signer(other.publicKeyDer, "q-other")
      return "confirm"
    }
    expect(await run(["tee", "rebind", "W1", "--to-key", TO, "--json"], h.deps)).toBe(1)
    expect(JSON.parse(h.stdout.text).code).toBe("KEY_SIGNER_CHANGED")
    expect(sim.rebinds.filter((b) => b.dryRun !== true).map((b) => b.owner)).toEqual([undefined])
    expect(sim.wallets[0]).toMatchObject({ boundKeyPrefix: FROM, owner: "q-leg" })
  })

  test("refuses before confirm when this machine does not hold a wallet's current owner, and names the machine that does", async () => {
    const sim = new SignerSim(() => 0)
    const fromSigner = pair()
    const target = pair()
    sim.addKey({ keyPrefix: FROM, active: sim.signer(fromSigner.publicKeyDer, "q-from") })
    sim.addKey({ keyPrefix: TO, active: sim.signer(target.publicKeyDer, "q-to") })
    sim.wallets.push(wallet("W1", { recorded: "q-from", boundKeyPrefix: FROM }))
    const h = machine(sim, { deviceToken: true, lines: ["confirm"] })
    expect(await run(["tee", "rebind", "W1", "--to-key", TO, "--json"], h.deps)).toBe(1)
    const doc = JSON.parse(h.stdout.text)
    expect(doc.code).toBe("KEY_SIGNER_SIGNATURE_REQUIRED")
    expect(doc.message).toContain(
      `the machine that holds key ${FROM}'s signer ${sim.keys.get(FROM)?.active?.fingerprint}`,
    )
    expect(h.linePrompts).toHaveLength(0)
    expect(sim.rebinds.filter((b) => b.dryRun !== true)).toHaveLength(0)
  })
})

// ── keys signer approve (4.3) ─────────────────────────────────────────────────────────────────

describe("candle keys signer approve", () => {
  test("takes the full group string, without echo; one group is refused before anything is sent", async () => {
    const clock = createFakeClock(1_000)
    const sim = new SignerSim(clock.now)
    const p = pair()
    const sha = spkiSha256Of(p.publicKeyDer)
    const fingerprint = keySignerFingerprint(sha)
    sim.addKey({
      keyPrefix: PREFIX,
      label: "tr-2",
      pending: { publicKeyDer: p.publicKeyDer, spkiSha256: sha, fingerprint, userCode: "ABCD-EFGH", expiresAt: 1e12 },
    })
    const one = machine(sim, { deviceToken: true, secrets: [fingerprint.split("-")[3] as string] })
    expect(await run(["keys", "signer", "approve", "ABCD-EFGH", "--key", PREFIX, "--json"], one.deps)).toBe(1)
    expect(JSON.parse(one.stdout.text).code).toBe("KEY_SIGNER_FINGERPRINT_MISMATCH")
    expect(one.calls.some((c) => c.url.endsWith("/approve"))).toBe(false)

    const full = machine(sim, { deviceToken: true, secrets: [fingerprint] })
    expect(await run(["keys", "signer", "approve", "ABCD-EFGH", "--key", PREFIX], full.deps)).toBe(0)
    expect(full.secretPrompts).toHaveLength(1)
    expect(sim.keys.get(PREFIX)?.active?.spkiSha256).toBe(sha)
    expect(full.stderr.text).toContain(fingerprint)
  })
})

// ── T12: doctor ──────────────────────────────────────────────────────────────────────────────

describe("T12: doctor's key-signer rows", () => {
  test("an unreadable slot is FAIL, an active signer this machine lacks is WARN, and a device token beside a signer is WARN", async () => {
    const sim = new SignerSim(() => 0)
    const elsewhere = pair()
    sim.addKey({ keyPrefix: PREFIX, apiKey: API_KEY, active: sim.signer(elsewhere.publicKeyDer, "q-elsewhere") })
    const h = machine(sim, { apiKey: true, deviceToken: true })
    const good = pair()
    await holdSigner(h, PREFIX, good, "q-mine")
    const broken = pair()
    const brokenSha = await holdSigner(h, PREFIX, broken, "q-broken")
    await h.store.set(keySignerRef(PREFIX, brokenSha), "not-a-key")
    const ctx = { deps: h.deps, json: false, apiUrl: "https://api.test", verifyAccount: false }
    const rows = await keySignerDoctorRows(ctx, { apiKey: API_KEY, deviceToken: DEVICE_TOKEN })
    expect(rows.filter((r) => r.state === "FAIL").map((r) => r.detail)).toEqual([
      `${keySignerRef(PREFIX, brokenSha)} (${keySignerFingerprint(brokenSha)}): cannot be parsed as a private key`,
    ])
    expect(rows.find((r) => r.check === "Key signer")?.state).toBe("WARN")
    expect(rows.find((r) => r.check === "Key signer")?.detail).toContain("is not on this machine")
    expect(rows.find((r) => r.check === "Device token beside signer")?.state).toBe("WARN")
  })

  test("a machine with no key signer gets no rows and makes no request", async () => {
    const sim = new SignerSim(() => 0)
    sim.addKey({ keyPrefix: PREFIX, apiKey: API_KEY })
    const h = machine(sim, { apiKey: true, deviceToken: true })
    const ctx = { deps: h.deps, json: false, apiUrl: "https://api.test", verifyAccount: false }
    expect(await keySignerDoctorRows(ctx, { apiKey: API_KEY, deviceToken: DEVICE_TOKEN })).toEqual([])
    expect(h.calls).toHaveLength(0)
  })
})
