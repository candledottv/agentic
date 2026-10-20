/**
 * BE-1680 (spec S4 W-2, W-3, T4-11, T4-12): `candle core serve` end to end, with a real vault and
 * a real slot, a fake API and no chain. Transfers from the embedded wallet are turned on (the
 * Withdraw key minted with the device token, with V-S4-5's body), one is sent, and they are turned
 * off (the key revoked by its prefix). Every socket frame, event and journal line along the way is
 * read for the Withdraw key, which must never appear.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { openSync } from "node:fs"
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { scopesForPreset } from "../agent-key-access"
import { corePaths } from "../core/paths"
import { PROTOCOL_VERSION } from "../core/rpc"
import { openCoreSlot } from "../core/slot"
import {
  connectTestClient,
  DEVICE_TOKEN,
  inspectableStore,
  profileConfig,
  READ_KEY,
  WRITE_KEY,
} from "../core/test-fixtures"
import type { CommandContext, Deps } from "../deps"
import { profileSecretRef } from "../profiles"
import { encodePubkey } from "../solana-lite"
import { createCapture, createFakeConfigStore, createTestDeps } from "../test-support"
import { closeVault, readVaultRaw, unlockWithPassphrase } from "../vault/store"
import { makeVault, useCheapKdf } from "../vault/test-vault"
import { coreServe } from "./core"

const WITHDRAW_KEY = `cndl_test_${"x".repeat(43)}`
const EMBEDDED = encodePubkey(new Uint8Array(32).fill(13))
const LINKED = encodePubkey(new Uint8Array(32).fill(23))

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe("candle core serve: the Withdraw key, end to end (S4 W-2, W-3)", () => {
  beforeAll(() => useCheapKdf())

  test("T4-12 and T4-11: mint with a factor, send with the key, revoke; the key never leaves the core", async () => {
    const m = await makeVault()
    dirs.push(m.dir)
    closeVault(m.vault)
    const env = { CANDLE_CONFIG_DIR: m.dir }
    const store = inspectableStore({
      [profileSecretRef("staging", "apiKey")]: WRITE_KEY,
      [profileSecretRef("staging", "deviceToken")]: DEVICE_TOKEN,
    })
    const api: { method: string; url: string; key: string | null; auth: string | null; body: unknown }[] = []
    let terminate: (() => void) | undefined
    const deps: Deps = createTestDeps({
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        const headers = new Headers(init?.headers)
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
        const method = init?.method ?? "GET"
        api.push({ method, url, key: headers.get("x-api-key"), auth: headers.get("authorization"), body })
        const path = new URL(url).pathname
        if (path === "/api/v1/agent/keys" && method === "POST") {
          const withdraw = (body as { scopes?: string[] }).scopes?.includes("transfer:write")
          return Response.json(
            withdraw
              ? {
                  success: true,
                  key: WITHDRAW_KEY,
                  keyPrefix: "xxxxxxxx",
                  expiresAt: Date.parse("2026-11-19T12:00:00Z"),
                }
              : { success: true, key: READ_KEY, keyPrefix: "rrrrrrrr", scopes: ["account:read"] },
          )
        }
        if (path === "/api/v1/agent/keys" && method === "GET") return Response.json({ success: true, keys: [] })
        if (path === "/api/v1/agent/keys/xxxxxxxx" && method === "DELETE") return Response.json({ success: true })
        if (path === "/api/v1/agent/wallets/embedded")
          return Response.json({
            success: true,
            wallets: { solana: { address: EMBEDDED, delegated: true }, evm: null },
          })
        if (path === "/api/v1/agent/wallets")
          return Response.json({
            success: true,
            page: [{ chain: "solana", address: LINKED, label: "cold", addedVia: "session" }],
            isDone: true,
          })
        if (path === "/api/v1/agent/withdrawal-addresses") return Response.json({ success: true, addresses: [] })
        if (path === "/api/v1/agent/transfer")
          return Response.json({ success: true, signature: "embsig", status: "confirmed" })
        return new Response("{}", { status: 404 })
      }) as unknown as typeof fetch,
      store,
      ...createFakeConfigStore(profileConfig("staging")),
      env,
      homedir: () => m.dir,
      stdout: createCapture(),
      stderr: createCapture(),
      onTerminate: (handler) => {
        terminate = handler
        return () => {}
      },
    })
    const paths = corePaths(env, m.dir, "staging")
    const ctx: CommandContext = {
      deps,
      json: true,
      apiUrl: "https://staging.api.candle.tv",
      profile: "staging",
      verifyAccount: true,
    }
    const handoff = join(m.dir, "handoff")
    const running = coreServe(["--view-token-fd", String(openSync(handoff, "w"))], ctx)
    let token = ""
    for (let i = 0; i < 200 && token === ""; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      token = (await readFile(handoff, "utf8").catch(() => "")).trim()
    }
    const view = await connectTestClient(paths.socket)
    await view.request("core.hello", { protocol: PROTOCOL_VERSION, token, clientName: "tui" })
    await view.request("subscribe", { topics: ["cards", "operations", "status"] })
    const factor = { type: "passphrase", value: m.passphrase }
    await view.request("settings.set", { path: "trading", value: true, factor })

    // T4-12: turning transfers on without a factor is refused, and nothing is minted.
    const keysBefore = api.filter((call) => call.url.endsWith("/agent/keys") && call.method === "POST").length
    const without = await view.request("settings.set", { path: "withdraw", value: { limitUsd: 100 } })
    expect(without.error?.data?.code).toBe("FACTOR_REQUIRED")
    expect(api.filter((call) => call.url.endsWith("/agent/keys") && call.method === "POST")).toHaveLength(keysBefore)

    // With one: one POST /agent/keys over the device token, V-S4-5's body.
    const on = await view.request("settings.set", { path: "withdraw", value: { limitUsd: 100 }, factor })
    expect(on.result).toMatchObject({
      withdraw: { status: "on", prefix: "xxxxxxxx", limitUsdMicros: 100_000_000, reset: "daily" },
    })
    const mints = api.filter((call) => call.url.endsWith("/agent/keys") && call.method === "POST")
    expect(mints).toHaveLength(keysBefore + 1)
    expect(mints.at(-1)).toMatchObject({
      auth: `Bearer ${DEVICE_TOKEN}`,
      body: {
        scopes: scopesForPreset("readwritetransfer"),
        label: "Candle TUI (withdraw)",
        expiresInDays: 30,
        txLimit: { usdMicros: 100_000_000, reset: "daily" },
        embeddedWallet: "allowed",
      },
    })
    // The slot was re-sealed with it; only the transfer purpose reads it back.
    const vault = await unlockWithPassphrase(m.path, (await readVaultRaw(m.path)) as string, m.passphrase)
    try {
      expect(
        (await openCoreSlot({ paths, vault, profile: "staging", environment: "staging", purpose: "transfer" }))
          .withdrawKey,
      ).toBe(WITHDRAW_KEY)
      expect(await openCoreSlot({ paths, vault, profile: "staging", environment: "staging" })).not.toHaveProperty(
        "withdrawKey",
      )
    } finally {
      closeVault(vault)
    }

    // A paper window (a non-transfer slot open) works as before, and the transfer runs with the key.
    await view.request("settings.set", { path: "paperWindow", value: { minutes: 5 }, factor })
    const prepared = await view.request("transfer.prepare", {
      params: {
        source: { kind: "embedded", address: EMBEDDED },
        chain: "solana",
        asset: { symbol: "SOL" },
        amount: { decimal: "0.25" },
        to: LINKED,
      },
    })
    const card = prepared.result as { cardId: string; cardHash: string; opId: string }
    expect(prepared.error).toBeUndefined()
    const approved = await view.request("cards.approve", {
      cardId: card.cardId,
      cardHash: card.cardHash,
      confirm: { typed: "confirm" },
      factor,
    })
    expect(approved.result).toMatchObject({ operation: { state: "succeeded" } })
    const sent = api.filter((call) => call.url.endsWith("/api/v1/agent/transfer"))
    expect(sent).toHaveLength(1)
    expect(sent[0]?.key).toBe(WITHDRAW_KEY)
    expect(sent[0]?.body).toMatchObject({
      chain: "solana",
      asset: "SOL",
      amountRaw: "250000000",
      to: LINKED,
      clientTransferId: card.opId,
    })

    // Off: the key is revoked by its prefix over the device token, and the slot is re-sealed without it.
    const off = await view.request("settings.set", { path: "withdraw", value: false, factor })
    expect(off.result).toMatchObject({ withdraw: { status: "off" } })
    expect(api.filter((call) => call.method === "DELETE")).toEqual([
      expect.objectContaining({
        url: "https://staging.api.candle.tv/api/v1/agent/keys/xxxxxxxx",
        auth: `Bearer ${DEVICE_TOKEN}`,
      }),
    ])
    const after = await unlockWithPassphrase(m.path, (await readVaultRaw(m.path)) as string, m.passphrase)
    try {
      expect(
        await openCoreSlot({ paths, vault: after, profile: "staging", environment: "staging", purpose: "transfer" }),
      ).not.toHaveProperty("withdrawKey")
    } finally {
      closeVault(after)
    }

    // T4-11: no frame, event or journal line ever carried the Withdraw key (or another secret).
    await new Promise((resolve) => setTimeout(resolve, 30))
    const frames = view.frames.join("\n")
    const journal = await readFile(paths.journal, "utf8")
    const settings = await readFile(join(paths.dir, "settings.json"), "utf8")
    for (const text of [frames, journal, settings]) {
      for (const secret of [WITHDRAW_KEY, WRITE_KEY, DEVICE_TOKEN, m.passphrase, token])
        expect(text.includes(secret)).toBe(false)
    }
    expect(journal).toContain('"type":"withdraw_key.minted"')
    expect(journal).toContain('"type":"withdraw_key.revoked"')
    expect(view.events.some((event) => event.topic === "operations")).toBe(true)

    view.close()
    expect(await running).toBe(0)
    expect(terminate).toBeDefined()
  })
})
