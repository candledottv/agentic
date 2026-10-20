/**
 * BE-1680 (spec S4 T-1 to T-9): transfers out of a user wallet on the core. T4-8 (only the user
 * starts one), T4-9 (the history is display only), T4-10 (the confirm on every transfer, then
 * the factor; BE-1710 removed the last six), T-W-1 (a fresh factor, never a window), T4-13 (each source executes
 * its own way), T4-14 (unknown outcomes), T4-15 (what is recorded). Fixtures only: a fake API, a
 * fake RPC, a fake secret store, a fixture vault and fake factor helpers.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Card, Operation } from "./cards"
import {
  DEST_A,
  DEST_B,
  DEST_EVM,
  embeddedSend,
  type KitOptions,
  LINKED_SOL,
  PIN_OK,
  RIGHT,
  startKit,
  TEE_SOL,
  VAULT_EVM,
  vaultSend,
  WITHDRAW_KEY,
  WITHDRAW_PREFIX,
  WRONG,
} from "./s4-test-kit"
import { METHOD_ROLES } from "./server"
import type { TestClient } from "./test-fixtures"
import { WRITE_KEY } from "./test-fixtures"
import { DestinationHistory } from "./transfers"

const kits: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const kit of kits.splice(0)) await kit.close()
})

async function kit(options: KitOptions = {}) {
  const k = await startKit(options)
  kits.push(k)
  return k
}

type Response = { result?: unknown; error?: { data?: { code: string } & Record<string, unknown> } }
const ok = <T>(response: Response): T => {
  if (response.error) throw Object.assign(new Error(`${response.error.data?.code}`), { data: response.error.data })
  return response.result as T
}

async function prepare(view: TestClient, body: Record<string, unknown>): Promise<Card> {
  return ok<Card>(await view.request("transfer.prepare", body))
}

const approve = (view: TestClient, card: Card, extra: Record<string, unknown> = {}) =>
  view.request("cards.approve", {
    cardId: card.cardId,
    cardHash: card.cardHash,
    confirm: { typed: "confirm" },
    factor: RIGHT,
    ...extra,
  })

describe("T4-8: only the user starts a transfer (T-1, K-3, invariant 11)", () => {
  test("a harness gets FORBIDDEN_FOR_ROLE on every transfer method, and TRANSFER_USER_ONLY from cards.propose", async () => {
    const k = await kit()
    const view = await k.view()
    const harness = await k.harness(view)
    for (const method of ["transfer.sources", "transfer.destinations", "transfer.prepare"]) {
      expect(METHOD_ROLES[method]).toEqual({ view: "yes", harness: "no" })
      const response = await harness.request(method, vaultSend(DEST_A))
      expect(response.error?.data?.code).toBe("FORBIDDEN_FOR_ROLE")
    }
    const proposed = await harness.request("cards.propose", {
      tool: "candle_transfer",
      kind: "transfer",
      params: { chain: "solana", asset: "SOL", amountRaw: "1", to: DEST_A },
    })
    expect(proposed.error?.data?.code).toBe("TRANSFER_USER_ONLY")
    const viaTools = ok<{ content: { text: string }[] }>(
      await harness.request("tools.call", {
        name: "candle_transfer",
        args: { chain: "solana", to: DEST_A, amountRaw: "1" },
      }),
    )
    expect(JSON.parse(viaTools.content[0]?.text ?? "{}").error.code).toBe("TRANSFER_USER_ONLY")
    expect(k.cards.list("", false)).toEqual([])
    expect(k.chain.signed).toEqual([])
  })

  test("a view's cards.propose of a transfer is refused too: the form is the only way in", async () => {
    const k = await kit()
    const view = await k.view()
    const response = await view.request("cards.propose", {
      tool: "candle_transfer",
      params: { chain: "solana", asset: "SOL", amountRaw: "1", to: DEST_A },
    })
    expect(response.error?.data?.code).toBe("TRANSFER_FORM_ONLY")
  })
})

describe("T4-9: the history is a display hint and nothing more (T-3)", () => {
  test("only A in this environment shows sent-before; A, B, and a forged hint all still need confirm", async () => {
    const k = await kit()
    const view = await k.view()
    const first = await prepare(view, vaultSend(DEST_A))
    expect(first.display.transfer?.newDestination).toBe(true)
    k.chain.statuses.set("sig1", { state: "finalized" })
    ok(await approve(view, first))
    await k.runScheduled()
    expect(k.history.has("solana", DEST_A)).toBe(true)
    expect(k.history.has("solana", DEST_B)).toBe(false)

    const again = await prepare(view, vaultSend(DEST_A))
    const other = await prepare(view, vaultSend(DEST_B))
    expect(again.display.transfer?.newDestination).toBe(false)
    expect(other.display.transfer?.newDestination).toBe(true)
    for (const card of [again, other]) {
      const missing = await view.request("cards.approve", {
        cardId: card.cardId,
        cardHash: card.cardHash,
        confirm: {},
        factor: RIGHT,
      })
      expect(missing.error?.data).toMatchObject({ code: "DESTINATION_NOT_CONFIRMED", step: "confirm" })
    }
    expect(k.helper).toEqual([{ type: "passphrase", reason: `send 1.5 SOL to ${DEST_A}` }])
  })

  test("A in another environment is not sent-before here; deleting the journal removes the hint", async () => {
    const k = await kit()
    const rows = [
      {
        seq: 1,
        at: "x",
        type: "operation.submitting",
        environment: "production",
        profile: "staging",
        mode: "live",
        opId: "op_a",
        transfer: { chain: "solana", to: DEST_A },
      },
      {
        seq: 2,
        at: "x",
        type: "operation.succeeded",
        environment: "production",
        profile: "staging",
        mode: "live",
        opId: "op_a",
      },
    ] as never
    const history = new DestinationHistory({ path: join(k.dir, "hint.json"), environment: "staging" })
    await history.rebuild(rows)
    expect(history.has("solana", DEST_A)).toBe(false)
    const empty = new DestinationHistory({ path: join(k.dir, "hint2.json"), environment: "staging" })
    await empty.rebuild([])
    expect(empty.has("solana", DEST_A)).toBe(false)
  })

  test("a forged succeeded row or an edited destinations.json skips no step", async () => {
    const k = await kit()
    // Forge both: a journal row the history trusts for display, and the file itself.
    await k.journal.append({
      type: "operation.submitting",
      opId: "op_forged",
      transfer: { chain: "solana", to: DEST_B },
    })
    await k.journal.append({ type: "operation.succeeded", opId: "op_forged" })
    await k.history.rebuild(k.journal.rows())
    await writeFile(join(k.dir, "destinations.json"), JSON.stringify({ destinations: [`staging:solana:${DEST_B}`] }))
    const view = await k.view()
    const card = await prepare(view, vaultSend(DEST_B))
    expect(card.display.transfer?.newDestination).toBe(false)
    const response = await approve(view, card, { confirm: { typed: "AAAAAA" } })
    expect(response.error?.data).toMatchObject({ code: "DESTINATION_NOT_CONFIRMED", step: "confirm" })
    expect(k.helper).toEqual([])
    expect(k.chain.signed).toEqual([])
  })
})

describe("T4-10: the confirm on every transfer, then the factor (T-5, invariant 12)", () => {
  test("a wrong typed word refuses with the factor helper never invoked", async () => {
    const k = await kit()
    const view = await k.view()
    const card = await prepare(view, vaultSend(DEST_A))
    const response = await approve(view, card, { confirm: { typed: "yes" } })
    expect(response.error?.data).toMatchObject({ code: "DESTINATION_NOT_CONFIRMED", step: "confirm" })
    expect(k.helper).toEqual([])
    expect(k.cards.get(card.cardId, "", false).state).toBe("awaiting_approval")
  })

  test("BE-1710: the old last six, typed as the word, refuses every time and never withdraws the card", async () => {
    const k = await kit()
    const view = await k.view()
    const card = await prepare(view, vaultSend(DEST_A))
    for (let i = 0; i < 4; i++) {
      const response = await approve(view, card, { confirm: { typed: DEST_A.slice(-6) } })
      expect(response.error?.data).toMatchObject({ code: "DESTINATION_NOT_CONFIRMED", step: "confirm" })
    }
    expect(k.cards.get(card.cardId, "", false).state).toBe("awaiting_approval")
    expect(k.helper).toEqual([])
    expect(k.chain.signed).toEqual([])
    // The word, after all that, still sends: there is no last-six step left to fail.
    ok(await approve(view, card))
  })

  test("the word right: the factor helper is invoked once, with the send as its reason", async () => {
    const k = await kit()
    const view = await k.view()
    const card = await prepare(view, vaultSend(DEST_A))
    // Trimmed and without case, as the CLI compares it.
    ok(await approve(view, card, { confirm: { typed: "  CONFIRM " } }))
    expect(k.helper).toEqual([{ type: "passphrase", reason: `send 1.5 SOL to ${DEST_A}` }])
  })

  test("a view still sending a lastSix field is not refused for it: the field is ignored", async () => {
    const k = await kit()
    const view = await k.view()
    const card = await prepare(view, vaultSend(DEST_A))
    ok(await approve(view, card, { confirm: { typed: "confirm", lastSix: "nonsense" } }))
  })

  test("an EVM destination needs only the word", async () => {
    const k = await kit()
    const view = await k.view()
    const card = await prepare(view, {
      params: {
        source: { kind: "vault", walletId: "k_evm", address: VAULT_EVM },
        chain: "hood",
        asset: { symbol: "ETH" },
        amount: { decimal: "0.01" },
        to: DEST_EVM.toLowerCase(),
      },
    })
    expect(card.display.transfer?.to).toBe(DEST_EVM)
    ok(await approve(view, card, { confirm: { typed: "Confirm" } }))
  })

  test("two views: the first valid approval wins and the second gets CARD_NOT_AWAITING", async () => {
    const k = await kit()
    const view = await k.view()
    const other = await k.view()
    const card = await prepare(view, vaultSend(DEST_A))
    ok(await approve(view, card))
    expect((await approve(other, card)).error?.data?.code).toBe("CARD_NOT_AWAITING")
  })
})

describe("one card, one send", () => {
  test("two approvals racing from two views: exactly one is signed and sent", async () => {
    for (const body of [vaultSend(DEST_A)]) {
      const k = await kit()
      const view = await k.view()
      const other = await k.view()
      const card = await prepare(view, body)
      const answers = await Promise.all([approve(view, card), approve(other, card), approve(view, card)])
      expect(answers.filter((answer) => answer.result !== undefined)).toHaveLength(1)
      expect(answers.filter((answer) => answer.error?.data?.code === "CARD_NOT_AWAITING")).toHaveLength(2)
      expect(k.chain.signed).toHaveLength(1)
      expect(k.chain.broadcasts).toHaveLength(1)
    }
  })

  test("embedded: racing approvals call candle_transfer once", async () => {
    const k = await kit({ embeddedOn: true })
    const view = await k.view()
    const other = await k.view()
    const card = await prepare(view, embeddedSend(LINKED_SOL))
    await Promise.all([approve(view, card), approve(other, card)])
    expect(k.chain.embedded).toHaveLength(1)
  })
})

describe("T-W-1: a fresh factor, never a window (T-6)", () => {
  test("with a timed and a paper window open, a transfer without a factor is FACTOR_REQUIRED; with one, no window is read", async () => {
    const k = await kit({ embeddedOn: true })
    const view = await k.view()
    ok(await view.request("settings.set", { path: "window", value: { minutes: 5 }, factor: RIGHT }))
    ok(await view.request("settings.set", { path: "paperWindow", value: { minutes: 5 }, factor: RIGHT }))
    for (const body of [vaultSend(DEST_A), embeddedSend(LINKED_SOL)]) {
      const card = await prepare(view, body)
      const response = await approve(view, card, { factor: undefined })
      expect(response.error?.data?.code).toBe("FACTOR_REQUIRED")
      k.windowSpy.armed = true
      ok(await approve(view, card))
      k.windowSpy.armed = false
      expect(k.windowSpy.reads).toBe(0)
    }
  })

  test("a rejected factor counts toward the lockout; an unavailable one does not (F-2)", async () => {
    const k = await kit({ securityKeyAttached: false })
    const view = await k.view()
    const card = await prepare(view, vaultSend(DEST_A))
    const unavailable = await approve(view, card, { factor: { type: "security-key", pin: PIN_OK } })
    expect(unavailable.error?.data?.code).toBe("VAULT_FACTOR_UNAVAILABLE")
    for (let i = 0; i < 4; i++)
      expect((await approve(view, card, { factor: WRONG })).error?.data?.code).toBe("FACTOR_REJECTED")
    // Four rejections and any number of unavailable factors: not locked yet.
    expect(k.trading.snapshot().approvalsLockedUntil).toBeNull()
    expect((await approve(view, card, { factor: WRONG })).error?.data?.code).toBe("FACTOR_REJECTED")
    expect(k.trading.snapshot().approvalsLockedUntil).not.toBeNull()
  })
})

describe("T4-13: each source executes its own way (T-7)", () => {
  test("vault: no API key is used, and the signature is in the submitting row before the broadcast", async () => {
    const k = await kit()
    const view = await k.view()
    const card = await prepare(view, vaultSend(DEST_A))
    const { operation } = ok<{ operation: Operation }>(await approve(view, card))
    expect(operation.state).toBe("pending")
    expect(k.apiCalls).toEqual([])
    expect(k.signingKeys).toEqual(["k_vault"])
    expect(k.chain.broadcasts).toHaveLength(1)
    const submitting = k.chain.broadcasts[0]?.journalAtSend
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((row) => row.type === "operation.submitting")
    expect(submitting.transfer).toMatchObject({ source: "vault", id: "sig1", blockhash: "blockhash-1", to: DEST_A })
    expect(k.chain.pending.get(card.opId)?.id).toBe("sig1")
    k.chain.statuses.set("sig1", { state: "finalized" })
    await k.runScheduled()
    expect(k.cards.operation(card.opId, "", false)).toMatchObject({
      state: "succeeded",
      result: { id: "sig1", finalized: true },
    })
    expect(k.chain.pending.has(card.opId)).toBe(false)
  })

  test("a promoted TEE wallet sends through vault, with no API key and no TEE build or relay path; it is reported once final", async () => {
    const k = await kit()
    const view = await k.view()
    const card = await prepare(
      view,
      vaultSend(DEST_A, { source: { kind: "vault", walletId: "k_tee", address: TEE_SOL } }),
    )
    expect(card.tool).toBe("core_vault_transfer")
    ok(await approve(view, card))
    expect(k.signingKeys).toEqual(["k_tee"])
    expect(k.apiCalls).toEqual([])
    k.chain.statuses.set("sig1", { state: "finalized" })
    await k.runScheduled()
    expect(k.chain.reports).toEqual(["sig1"])
    // No source kind names a TEE wallet bound to the Write key (D-A, R1).
    const bad = await view.request("transfer.prepare", vaultSend(DEST_A, { source: { kind: "tee", address: TEE_SOL } }))
    expect(bad.error?.data?.code).toBe("INVALID_SOURCE")
  })

  test("embedded: candle_transfer with clientTransferId = opId and the Withdraw key, never the Write key", async () => {
    const k = await kit({ embeddedOn: true })
    const view = await k.view()
    const card = await prepare(view, embeddedSend(LINKED_SOL))
    expect(card.tool).toBe("candle_transfer")
    expect(card.display.transfer?.serverClass).toBe("linked")
    const { operation } = ok<{ operation: Operation }>(await approve(view, card))
    expect(operation.state).toBe("succeeded")
    expect(k.chain.embedded).toEqual([
      { params: expect.objectContaining({ to: LINKED_SOL }), clientTransferId: card.opId, key: WITHDRAW_KEY },
    ])
    expect(k.chain.embedded[0]?.key).not.toBe(WRITE_KEY)
    expect(k.signingKeys).toEqual([])
  })

  test("embedded: an address the server will refuse is shown before any card, with the rule", async () => {
    const k = await kit({ embeddedOn: true })
    const view = await k.view()
    const response = await view.request("transfer.prepare", embeddedSend(DEST_B))
    expect(response.error?.data).toMatchObject({
      code: "TRANSFER_DESTINATION_NOT_APPROVED",
      serverRule: "own_linked_or_allowlist",
    })
    expect(k.cards.list("", false)).toEqual([])
    expect((await k.rows()).find((row) => row.type === "transfer.refused")).toMatchObject({
      code: "TRANSFER_DESTINATION_NOT_APPROVED",
    })
  })

  test("embedded is off until Settings turns it on; vault is unaffected", async () => {
    const k = await kit()
    const view = await k.view()
    expect((await view.request("transfer.prepare", embeddedSend(LINKED_SOL))).error?.data?.code).toBe(
      "EMBEDDED_TRANSFERS_OFF",
    )
    await prepare(view, vaultSend(DEST_A))
  })

  test("the server refusing the Withdraw key turns the embedded source off, with the reason", async () => {
    const k = await kit({ embeddedOn: true })
    k.chain.embeddedOutcome = { state: "refused", error: { code: "KEY_EXPIRED", message: "This API key has expired" } }
    const view = await k.view()
    const card = await prepare(view, embeddedSend(LINKED_SOL))
    const { operation } = ok<{ operation: Operation }>(await approve(view, card))
    expect(operation).toMatchObject({ state: "refused", error: { code: "KEY_EXPIRED" } })
    expect(k.trading.withdrawState()).toMatchObject({ status: "off", reason: expect.stringContaining("expired") })
  })
})

describe("T4-14: unknown outcomes (T-8, invariant 14)", () => {
  test("Solana: not found with the blockhash expired is failed; still valid rebroadcasts the same bytes", async () => {
    const k = await kit()
    const view = await k.view()
    const card = await prepare(view, vaultSend(DEST_A))
    ok(await approve(view, card))
    // Simulate the kill after `submitting`: a fresh core rebuilds from this journal.
    const rebuilt = await startKit()
    kits.push(rebuilt)
    await rebuilt.cards.rebuild(k.journal.rows().map((row) => ({ ...row })))
    const unknown = rebuilt.cards.operation(card.opId, "", false)
    expect(unknown.state).toBe("unknown")
    expect(unknown.reconcile?.actions).toEqual(["check", "rebroadcast", "abandon"])
    rebuilt.chain.pending.set(card.opId, k.chain.pending.get(card.opId) as never)
    const rview = await rebuilt.view()
    // Still valid: the same signed bytes go out again; never a fresh build.
    const resent = ok<Operation>(
      await rview.request("operations.resolve", { opId: card.opId, action: "rebroadcast", factor: RIGHT }),
    )
    expect(resent.state).toBe("pending")
    const original = k.chain.signed[0] as { id: string; wire: string }
    expect(rebuilt.chain.broadcasts.map((b) => [b.id, b.wire])).toEqual([[original.id, original.wire]])
    expect(rebuilt.chain.signed).toEqual([])
    // Then the blockhash passes with no record: failed, definitely.
    rebuilt.chain.statuses.set("sig1", { state: "not_found", expired: true })
    const checked = ok<Operation>(await rview.request("operations.resolve", { opId: card.opId, action: "check" }))
    expect(checked).toMatchObject({ state: "failed", error: { code: "TRANSFER_EXPIRED" } })
  })

  test("a re-send of a transfer is never a fresh signature, and resend under the same op is refused", async () => {
    const k = await kit()
    const view = await k.view()
    const card = await prepare(view, vaultSend(DEST_A))
    ok(await approve(view, card))
    for (let i = 0; i < 25; i++) await k.runScheduled()
    k.clock.advance(11 * 60_000)
    await k.runScheduled()
    await k.runScheduled()
    const unknown = k.cards.operation(card.opId, "", false)
    expect(unknown.state).toBe("unknown")
    const resend = await view.request("operations.resolve", { opId: card.opId, action: "resend", factor: RIGHT })
    expect(resend.error?.data?.code).toBe("TRANSFER_NEVER_RESENT")
    expect(k.chain.signed).toHaveLength(1)
  })

  test("embedded: only the two attestation choices, and /transfer is never called again", async () => {
    const k = await kit({ embeddedOn: true })
    k.chain.embeddedOutcome = {
      state: "unknown",
      error: { code: "EXECUTOR_TRANSPORT", message: "socket hang up" },
      transient: true,
    }
    const view = await k.view()
    const card = await prepare(view, embeddedSend(LINKED_SOL))
    const { operation } = ok<{ operation: Operation }>(await approve(view, card))
    expect(operation.state).toBe("unknown")
    expect(operation.reconcile?.actions).toEqual(["attest_sent", "attest_not_sent"])
    for (const action of ["resend", "rebroadcast", "check"]) {
      const response = await view.request("operations.resolve", { opId: card.opId, action, factor: RIGHT })
      expect(response.error?.data?.code).toBe("TRANSFER_NEVER_RESENT")
    }
    const attested = ok<Operation>(
      await view.request("operations.resolve", { opId: card.opId, action: "attest_not_sent" }),
    )
    expect(attested.state).toBe("attested_not_sent")
    expect(k.chain.embedded).toHaveLength(1)
    expect((await k.rows()).find((row) => row.type === "operation.attested_not_sent")).toMatchObject({
      statement: "user",
    })
  })
})

describe("T4-15: what is recorded (T-9)", () => {
  test("every row has environment, profile and mode; approvals carry the factor type and confirmation booleans; no secret appears", async () => {
    const k = await kit({ embeddedOn: true })
    const view = await k.view()
    const vault = await prepare(view, vaultSend(DEST_A))
    ok(await approve(view, vault))
    k.chain.statuses.set("sig1", { state: "finalized" })
    await k.runScheduled()
    const embedded = await prepare(view, embeddedSend(LINKED_SOL))
    ok(await approve(view, embedded, { factor: { type: "security-key", pin: PIN_OK } }))
    await view.request("transfer.prepare", embeddedSend(DEST_B))

    const rows = await k.rows()
    for (const row of rows) {
      expect(row.environment).toBe("staging")
      expect(row.profile).toBe("staging")
      expect(row.mode === "live" || row.mode === "paper").toBe(true)
    }
    const approvals = rows.filter(
      (row) => row.type === "card.approved" && (row.cardId === vault.cardId || row.cardId === embedded.cardId),
    )
    expect(approvals.map((row) => [row.factorType, row.confirm])).toEqual([
      ["passphrase", { typed: true }],
      ["security-key", { typed: true }],
    ])
    expect(rows.filter((row) => row.type === "transfer.prepared")).toHaveLength(2)
    expect(rows.find((row) => row.type === "operation.succeeded" && row.opId === vault.opId)).toBeDefined()
    const text = await readFile(k.journalPath, "utf8")
    for (const secret of [RIGHT.value, PIN_OK, WITHDRAW_KEY, WRITE_KEY, k.chain.signed[0]?.wire as string]) {
      expect(text).not.toContain(secret)
    }
    expect(text).not.toContain('"lastSix":"')
  })
})

describe("W-2: a Withdraw key minted but never sealed is revoked", () => {
  test("when the seal throws, the new prefix is revoked and settings never record it", async () => {
    const k = await kit({ sealFails: true })
    await expect(
      k.trading.turnOnEmbeddedTransfers({ limitUsdMicros: 100_000_000, reset: "daily" }, RIGHT),
    ).rejects.toThrow("slot write failed")
    expect(k.keyCalls.map((call) => call.op)).toEqual(["mint", "revoke"])
    expect(k.keyCalls[1]).toMatchObject({ op: "revoke", prefix: WITHDRAW_PREFIX })
    expect(k.trading.withdrawState()).toMatchObject({ status: "off" })
    expect(k.trading.withdrawState()).not.toHaveProperty("prefix")
  })
})
