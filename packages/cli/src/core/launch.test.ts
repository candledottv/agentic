/**
 * BE-1680 (spec S4 L-1 to L-7): the launch flow on the core. T4-2 (the upload is view-only and
 * confirmed), T4-3 (the dry run binds to the card), T4-4 (no approval without a passing dry run),
 * T4-5 (a harness's launch gets the same rule) and T4-7 (launch refusals are `refused`, not
 * reconcile cards). Fixtures only: a fake API, a fixture vault, fake factor helpers.
 */
import { afterEach, describe, expect, test } from "bun:test"
import type { Card, ExecutionOutcome } from "./cards"
import { outcomeOf } from "./executor"
import { DRY_RUN_PASS, type KitOptions, RIGHT, startKit } from "./s4-test-kit"
import type { TestClient } from "./test-fixtures"

const kits: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const kit of kits.splice(0)) await kit.close()
})

async function kit(options: KitOptions = {}) {
  const k = await startKit(options)
  kits.push(k)
  return k
}

const LAUNCH = {
  name: "Candle Dog",
  symbol: "CDOG",
  imageUrl: "https://images.example/dog.png",
  chain: "solana",
  quoteAsset: "sol",
  mode: "open",
  stakerAllocationBps: 50,
  buyAmount: "100000000",
}

const result = <T>(response: { result?: unknown; error?: { data?: { code: string } } }) => {
  if (response.error) throw Object.assign(new Error(response.error.data?.code), { code: response.error.data?.code })
  return response.result as T
}

async function proposeFromView(view: TestClient, params: Record<string, unknown> = LAUNCH) {
  return result<Card>(await view.request("cards.propose", { tool: "candle_launch_token", params }))
}

describe("T4-2: the image upload is view-only and confirmed (L-3, invariant 16)", () => {
  test("a harness cannot call launch.uploadImage", async () => {
    const k = await kit()
    const view = await k.view()
    const harness = await k.harness(view)
    const response = await harness.request("launch.uploadImage", { path: "/tmp/dog.png", confirmPublic: true })
    expect(response.error?.data?.code).toBe("FORBIDDEN_FOR_ROLE")
    expect(k.uploads).toEqual([])
  })

  test("without the y/n answer nothing is sent; with it, one upload and one image.upload row", async () => {
    const k = await kit()
    const view = await k.view()
    await view.request("settings.set", { path: "paperWindow", value: { minutes: 5 }, factor: RIGHT })
    const unconfirmed = await view.request("launch.uploadImage", { path: "/tmp/dog.png" })
    expect(unconfirmed.error?.data?.code).toBe("UPLOAD_NOT_CONFIRMED")
    expect(k.uploads).toEqual([])
    const done = result<{ imageUrl: string }>(
      await view.request("launch.uploadImage", { path: "/tmp/dog.png", confirmPublic: true }),
    )
    expect(done.imageUrl).toBe("https://images.example/pinned.png")
    expect(k.uploads).toHaveLength(1)
    const rows = (await k.rows()).filter((row) => row.type === "image.upload")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      fileName: "dog.png",
      size: 4,
      contentType: "image/png",
      imageUrl: "https://images.example/pinned.png",
      mode: "live",
    })
  })

  test("with no window, the upload asks for the factor once and opens a paper window", async () => {
    const k = await kit()
    const view = await k.view()
    const refused = await view.request("launch.uploadImage", { path: "/tmp/dog.png", confirmPublic: true })
    expect(refused.error?.data?.code).toBe("PAPER_WINDOW_REQUIRED")
    result(await view.request("launch.uploadImage", { path: "/tmp/dog.png", confirmPublic: true, factor: RIGHT }))
    expect(k.uploads).toHaveLength(1)
    expect(k.trading.snapshot().paperWindow.open).toBe(true)
  })

  test("a file the core will not upload is refused before any request", async () => {
    const k = await kit()
    const view = await k.view()
    const response = await view.request("launch.uploadImage", {
      path: "/tmp/logo.svg",
      confirmPublic: true,
      factor: RIGHT,
    })
    expect(response.error?.data?.code).toBe("IMAGE_TYPE_UNSUPPORTED")
    expect(k.uploads).toEqual([])
  })
})

describe("T4-3: the dry run binds to the card (L-4, L-6)", () => {
  test("the API receives exactly params plus dryRun; approval sends the same params without dryRun under the same id", async () => {
    const k = await kit()
    const view = await k.view()
    await view.request("settings.set", { path: "paperWindow", value: { minutes: 5 }, factor: RIGHT })
    const card = await proposeFromView(view)
    expect(card.state).toBe("awaiting_approval")
    expect(card.display.checks).toMatchObject({
      dryRun: "passed",
      launchWallet: DRY_RUN_PASS.launchWallet,
      resolved: DRY_RUN_PASS.resolved,
      checks: { image: "ok" },
    })
    expect(k.apiCalls).toHaveLength(1)
    const [dry] = k.apiCalls
    expect(dry?.params).toEqual({ ...card.params, dryRun: true })
    expect(card.params.clientLaunchId).toBe(card.opId)
    expect(card.params).not.toHaveProperty("dryRun")
    const digests = (await k.rows()).filter((row) => row.type === "launch.dry_run")
    expect(digests).toEqual([
      expect.objectContaining({ outcome: "passed", digest: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    ])

    const approved = result<{ operation: { state: string } }>(
      await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, factor: RIGHT }),
    )
    expect(approved.operation.state).toBe("succeeded")
    expect(k.apiCalls).toHaveLength(2)
    expect(k.apiCalls[1]?.params).toEqual(card.params)
    expect(k.apiCalls[1]?.params.clientLaunchId).toBe(dry?.params.clientLaunchId)
  })

  test("a launch_and_seed dry run, wrapped under `api`, binds the same way (V-S4-1)", async () => {
    const k = await kit({
      api: (_tool, params): ExecutionOutcome =>
        params.dryRun === true
          ? { state: "succeeded", result: { clientLaunchId: params.clientLaunchId, dryRun: true, api: DRY_RUN_PASS } }
          : { state: "succeeded", result: { success: true } },
    })
    const view = await k.view()
    await view.request("settings.set", { path: "paperWindow", value: { minutes: 5 }, factor: RIGHT })
    const card = result<Card>(
      await view.request("cards.propose", { tool: "candle_launch_and_seed", params: { ...LAUNCH, devBuy: "0.1" } }),
    )
    expect(card.state).toBe("awaiting_approval")
    expect(card.display.checks).toMatchObject({ dryRun: "passed" })
  })
})

describe("T4-4: no approval without a passing dry run (L-4 step 5, invariant 15)", () => {
  test("with no window the card stays proposed, shows Dry run needed, and approve says DRY_RUN_REQUIRED", async () => {
    const k = await kit()
    const view = await k.view()
    const card = await proposeFromView(view)
    expect(card.state).toBe("proposed")
    expect(card.display.checks).toMatchObject({ dryRun: "needed" })
    expect(k.apiCalls).toEqual([])
    const response = await view.request("cards.approve", {
      cardId: card.cardId,
      cardHash: card.cardHash,
      factor: RIGHT,
    })
    expect(response.error?.data?.code).toBe("DRY_RUN_REQUIRED")
    expect(k.helper).toEqual([])
    // `d` with the factor opens a paper window and runs the dry run.
    const ran = result<Card>(await view.request("launch.dryRun", { cardId: card.cardId, factor: RIGHT }))
    expect(ran.state).toBe("awaiting_approval")
    expect(k.trading.snapshot().paperWindow.open).toBe(true)
  })

  test("a failed dry run withdraws the card by dry_run with the API's field, and approve is CARD_NOT_AWAITING", async () => {
    const k = await kit({
      api: () => ({
        state: "refused",
        error: { code: "VALIDATION_FAILED", message: "symbol exceeds 10 bytes" },
        result: {
          success: false,
          error: { code: "VALIDATION_FAILED", message: "symbol exceeds 10 bytes", field: "symbol" },
        },
      }),
    })
    const view = await k.view()
    await view.request("settings.set", { path: "paperWindow", value: { minutes: 5 }, factor: RIGHT })
    const card = await proposeFromView(view)
    expect(card.state).toBe("withdrawn")
    expect(card.display.checks).toMatchObject({
      dryRun: "failed",
      error: { code: "VALIDATION_FAILED", field: "symbol" },
    })
    const withdrawn = (await k.rows()).find((row) => row.type === "card.withdrawn")
    expect(withdrawn).toMatchObject({ by: "dry_run", code: "VALIDATION_FAILED" })
    const response = await view.request("cards.approve", {
      cardId: card.cardId,
      cardHash: card.cardHash,
      factor: RIGHT,
    })
    expect(response.error?.data?.code).toBe("CARD_NOT_AWAITING")
  })

  test("two dry runs of one card never overlap, and a late answer cannot rewrite a card that moved on", async () => {
    let release: (outcome: ExecutionOutcome) => void = () => {}
    let held = false
    let calls = 0
    const k = await kit({
      api: (_tool, params): Promise<ExecutionOutcome> | ExecutionOutcome => {
        if (params.dryRun !== true) return { state: "succeeded", result: { success: true } }
        calls++
        if (!held) return { state: "unknown", error: { code: "EXECUTOR_TRANSPORT", message: "x" }, transient: true }
        return new Promise((resolve) => {
          release = resolve
        })
      },
    })
    const view = await k.view()
    await view.request("settings.set", { path: "paperWindow", value: { minutes: 5 }, factor: RIGHT })
    const card = await proposeFromView(view)
    expect(card.state).toBe("proposed")
    held = true
    const first = view.request("launch.dryRun", { cardId: card.cardId })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const other = await k.view()
    const second = await other.request("launch.dryRun", { cardId: card.cardId })
    expect(second.error?.data?.code).toBe("DRY_RUN_IN_FLIGHT")
    expect(calls).toBe(2)
    // The card expires while the call is out; the failing answer that comes back late is dropped.
    k.clock.advance(60 * 60_000)
    await k.cards.expireDue()
    expect(k.cards.get(card.cardId, "", false).state).toBe("expired")
    release({
      state: "refused",
      error: { code: "VALIDATION_FAILED", message: "late" },
      result: { success: false, error: { code: "VALIDATION_FAILED", message: "late" } },
    })
    await first
    expect(k.cards.get(card.cardId, "", false).state).toBe("expired")
    expect((await k.rows()).filter((row) => row.type === "card.withdrawn")).toEqual([])
  })

  test("a lost dry-run answer leaves the card proposed for another try, never approvable", async () => {
    let lost = true
    const k = await kit({
      api: (_tool, params): ExecutionOutcome =>
        params.dryRun === true && lost
          ? { state: "unknown", error: { code: "EXECUTOR_TRANSPORT", message: "socket hang up" }, transient: true }
          : params.dryRun === true
            ? { state: "succeeded", result: DRY_RUN_PASS }
            : { state: "succeeded", result: { success: true } },
    })
    const view = await k.view()
    await view.request("settings.set", { path: "paperWindow", value: { minutes: 5 }, factor: RIGHT })
    const card = await proposeFromView(view)
    expect(card.state).toBe("proposed")
    expect(card.display.checks).toMatchObject({ dryRun: "error", error: { code: "EXECUTOR_TRANSPORT" } })
    lost = false
    const again = result<Card>(await view.request("launch.dryRun", { cardId: card.cardId }))
    expect(again.state).toBe("awaiting_approval")
  })

  test("a dry run is never reused: an edited launch is a new card that runs its own", async () => {
    const k = await kit()
    const view = await k.view()
    await view.request("settings.set", { path: "paperWindow", value: { minutes: 5 }, factor: RIGHT })
    const first = await proposeFromView(view)
    const second = await proposeFromView(view, { ...LAUNCH, symbol: "CDOG2" })
    expect(second.cardId).not.toBe(first.cardId)
    expect(second.opId).not.toBe(first.opId)
    expect(k.apiCalls.filter((call) => call.params.dryRun === true)).toHaveLength(2)
  })
})

describe("T4-5: a harness's launch gets the same rule (L-1, L-4)", () => {
  test("candle_launch_token without dryRun: the core runs the dry run before the card is drawn", async () => {
    const k = await kit()
    const view = await k.view()
    await view.request("subscribe", { topics: ["cards"] })
    await view.request("settings.set", { path: "paperWindow", value: { minutes: 5 }, factor: RIGHT })
    const harness = await k.harness(view)
    const answer = result<{ content: { text: string }[] }>(
      await harness.request("tools.call", { name: "candle_launch_token", args: { ...LAUNCH, clientLaunchId: "h-1" } }),
    )
    expect(JSON.parse(answer.content[0]?.text ?? "{}")).toMatchObject({
      error: { code: "APPROVAL_REQUIRED" },
      clientLaunchId: "h-1",
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    // The first card the view ever sees for it already carries the passing dry run.
    const drawn = view.events.filter((event) => event.topic === "cards" && !event.snapshot)
    expect(drawn).toHaveLength(1)
    expect((drawn[0]?.data as { card: Card }).card).toMatchObject({
      state: "awaiting_approval",
      display: { checks: { dryRun: "passed" } },
    })
  })

  test("with dryRun: true it passes straight through, and no card is made", async () => {
    const k = await kit()
    const view = await k.view()
    await view.request("settings.set", { path: "paperWindow", value: { minutes: 5 }, factor: RIGHT })
    const harness = await k.harness(view)
    await harness.request("tools.call", {
      name: "candle_launch_token",
      args: { ...LAUNCH, clientLaunchId: "h-2", dryRun: true },
    })
    expect(k.apiCalls).toHaveLength(1)
    expect(k.cards.list("", false)).toEqual([])
  })

  test("a harness reads a failed dry run as withdrawn with DRY_RUN_FAILED and the API's answer", async () => {
    const k = await kit({
      api: () => ({
        state: "refused",
        error: { code: "VALIDATION_FAILED", message: "name exceeds 32 bytes" },
        result: {
          success: false,
          error: { code: "VALIDATION_FAILED", message: "name exceeds 32 bytes", field: "name" },
        },
      }),
    })
    const view = await k.view()
    await view.request("settings.set", { path: "paperWindow", value: { minutes: 5 }, factor: RIGHT })
    const harness = await k.harness(view)
    await harness.request("tools.call", { name: "candle_launch_token", args: { ...LAUNCH, clientLaunchId: "h-3" } })
    const read = result<{ content: { text: string }[] }>(
      await harness.request("tools.call", { name: "candle_get_operation", args: { clientId: "h-3", kind: "launch" } }),
    )
    expect(JSON.parse(read.content[0]?.text ?? "{}")).toMatchObject({
      error: { code: "DRY_RUN_FAILED" },
      api: { error: { code: "VALIDATION_FAILED", field: "name" } },
      state: "withdrawn",
    })
  })
})

describe("T4-7: launch refusals are refused, never a reconcile card (L-7, V-S4-3)", () => {
  const body = (code: string) => ({
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ success: false, error: { code, message: code } }) }],
  })
  const ADDED = [
    "VALIDATION_FAILED",
    "DEV_BUY_TOO_HIGH",
    "DAILY_CAP_REACHED",
    "AGENT_WALLET_NOT_EMBEDDED",
    "QUOTE_PAIR_UNKNOWN",
    "EXCLUSIVE_NOT_ELIGIBLE",
    "TRANSACTION_TOO_LARGE",
    "INSUFFICIENT_OWNER_BALANCE",
  ]
  test("each added code, and the existing KEY_LIMIT_REACHED and INVALID_*, is refused from a launch tool", () => {
    for (const code of [...ADDED, "KEY_LIMIT_REACHED", "INVALID_SYMBOL", "INVALID_NAME_BYTES"]) {
      for (const tool of ["candle_launch_token", "candle_launch_and_seed"]) {
        expect(outcomeOf(body(code), undefined, tool)).toMatchObject({ state: "refused", error: { code } })
      }
    }
    // candle_launch_and_seed wraps the API body under `api`.
    const wrapped = {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            clientLaunchId: "x",
            api: { success: false, error: { code: "DAILY_CAP_REACHED", message: "cap" } },
          }),
        },
      ],
    }
    expect(outcomeOf(wrapped, undefined, "candle_launch_and_seed").state).toBe("refused")
  })

  test("an unlisted code, TIER_REQUIRED, an IMAGE_* code and a 5xx stay unknown (V-S4-3 found them unconfirmed)", () => {
    for (const code of ["LAUNCH_FAILED", "TIER_REQUIRED", "IMAGE_WRONG_SHAPE", "SOMETHING_NEW"]) {
      expect(outcomeOf(body(code), undefined, "candle_launch_token").state).toBe("unknown")
    }
    expect(outcomeOf(body("INSUFFICIENT_OWNER_BALANCE"), 500, "candle_launch_token").state).toBe("unknown")
  })

  test("the launch codes stay launch-only: the same code from a trade is unknown", () => {
    expect(outcomeOf(body("VALIDATION_FAILED"), undefined, "candle_trade").state).toBe("unknown")
  })

  test("INSUFFICIENT_OWNER_BALANCE from execution: operation refused, no reconcile card", async () => {
    const k = await kit({
      api: (_tool, params): ExecutionOutcome =>
        params.dryRun === true
          ? { state: "succeeded", result: DRY_RUN_PASS }
          : { state: "refused", error: { code: "INSUFFICIENT_OWNER_BALANCE", message: "fund the wallet" } },
    })
    const view = await k.view()
    await view.request("settings.set", { path: "paperWindow", value: { minutes: 5 }, factor: RIGHT })
    const card = await proposeFromView(view)
    const approved = result<{ operation: { state: string; reconcile?: unknown } }>(
      await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, factor: RIGHT }),
    )
    expect(approved.operation.state).toBe("refused")
    expect(approved.operation.reconcile).toBeUndefined()
  })

  test("an unknown launch's reconcile card says the dry run is not run again", async () => {
    const k = await kit({
      api: (_tool, params): ExecutionOutcome =>
        params.dryRun === true
          ? { state: "succeeded", result: DRY_RUN_PASS }
          : { state: "unknown", error: { code: "LAUNCH_FAILED", message: "unconfirmed" } },
    })
    const view = await k.view()
    await view.request("settings.set", { path: "paperWindow", value: { minutes: 5 }, factor: RIGHT })
    const card = await proposeFromView(view)
    const approved = result<{ operation: { state: string; reconcile?: { message: string } } }>(
      await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, factor: RIGHT }),
    )
    expect(approved.operation.state).toBe("unknown")
    expect(approved.operation.reconcile?.message).toContain("The dry run is not run again.")
  })
})
