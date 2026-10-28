/**
 * `candle launch --check` (BE-2139, surfaces item B): the preflight that must answer, in one call,
 * the three refusals a desk used to meet serially and only after the image was published -- the
 * embedded allowance, the TEE tier/allowLaunch gates, and the TEE first-buy switch -- while no
 * upload, build, reservation or id claim happens.
 */
import { describe, expect, test } from "bun:test"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"

const EMBEDDED = "11111111111111111111111111111111"
const SPIDER = "SpiderWa11etAddressXXXXXXXXXXXXXXXXXXXXXX"
const json = (text: string) => JSON.parse(text.trim())

/** The facts GET /launch/preflight answers, exactly as the route serves them. */
function preflightBody(opts: {
  tier?: string
  selfLaunch?: boolean
  embeddedPermission?: "allowed" | "denied"
  embeddedSolana?: { address: string; delegated?: boolean } | null
  embeddedEvm?: { address: string; delegated?: boolean } | null
  headlessLaunch?: boolean
  agentTrading?: boolean
  teeLaunchBuys?: boolean
  wallets?: Array<{
    id: string
    address: string
    chain: string
    label: string | null
    allowLaunch: boolean
    active: boolean
  }>
  scopes?: string[]
}) {
  return {
    success: true,
    key: {
      keyPrefix: "cndl_live_check",
      environment: "production",
      scopes: opts.scopes ?? ["launch:write"],
      tier: opts.tier ?? "max",
      selfLaunch: opts.selfLaunch ?? true,
      embeddedWalletPermission: opts.embeddedPermission ?? "denied",
    },
    switches: {
      headlessLaunch: opts.headlessLaunch ?? true,
      agentTrading: opts.agentTrading ?? true,
      teeLaunchBuys: opts.teeLaunchBuys ?? false,
    },
    embedded: {
      solana:
        opts.embeddedSolana === undefined
          ? opts.embeddedPermission === "allowed"
            ? { address: EMBEDDED, delegated: true }
            : null
          : opts.embeddedSolana,
      evm: opts.embeddedEvm ?? null,
    },
    wallets: opts.wallets ?? [
      { id: "lw_spider", address: SPIDER, chain: "solana", label: "spider-01", allowLaunch: true, active: true },
    ],
  }
}

async function fixture(body: Record<string, unknown>) {
  const calls: string[] = []
  const stdout = createCapture()
  const stderr = createCapture()
  const deps = createTestDeps({
    env: { CANDLE_CONFIG_DIR: "/tmp/candle-launch-check-test", CANDLE_API_KEY: "key" },
    stdout,
    stderr,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET")
      const path = new URL(String(input)).pathname
      calls.push(path)
      if (path === "/api/v1/launch/preflight") return Response.json(body)
      throw new Error(`Unexpected ${path}: --check must make no other request`)
    }) as typeof fetch,
  })
  return { deps, calls, stdout, stderr }
}

describe("candle launch --check", () => {
  test("the card's screen: one call answers the three refusals that used to be serial", async () => {
    // The desk report's exact situation: spider-01 can launch with no buy, a first buy from
    // spider-01 is off on this server, and the embedded wallet is denied on this key.
    const f = await fixture(preflightBody({}))
    expect(await run(["launch", "--check", "--json"], f.deps)).toBe(0)
    expect(f.calls).toEqual(["/api/v1/launch/preflight"])
    const out = json(f.stdout.text)
    expect(out).toMatchObject({ success: true, check: true, works: true })
    expect(out.key.embeddedWalletPermission).toBe("denied")
    expect(out.switches.teeLaunchBuys).toBe(false)
    expect(out.wallets[0]).toMatchObject({ id: "lw_spider", canLaunch: true, canBuy: false })
  })

  test("the plain screen speaks the card's three sentences", async () => {
    const f = await fixture(preflightBody({}))
    expect(await run(["launch", "--check"], f.deps)).toBe(0)
    const screen = f.stdout.text
    expect(screen).toContain("This key can launch from spider-01 with no first buy.")
    expect(screen).toContain("A first buy from spider-01 is off on this server")
    expect(screen).toContain("The embedded wallet is denied on this key.")
    expect(screen).toContain("Nothing was uploaded, built or sent")
  })

  test("no name, symbol, image or wallet is required, and a nonexistent --image is never read", async () => {
    const f = await fixture(preflightBody({}))
    expect(await run(["launch", "--check", "--image", "./no-such-file.png"], f.deps)).toBe(0)
    expect(f.calls).toEqual(["/api/v1/launch/preflight"])
  })

  test("a working first-buy path says so when the server switches are on", async () => {
    const f = await fixture(
      preflightBody({ tier: "max", selfLaunch: true, embeddedPermission: "allowed", teeLaunchBuys: true }),
    )
    expect(await run(["launch", "--check"], f.deps)).toBe(0)
    expect(f.stdout.text).toContain("A first buy from spider-01 rides the launch (TEE_LAUNCH_BUYS_ENABLED is on).")
    expect(f.stdout.text).toContain("This key can launch from the Solana embedded wallet with no first buy.")
  })

  test("a Hood check never counts a Solana TEE wallet, with or without the build-only dex option", async () => {
    for (const dexFlags of [[], ["--dex-version", "v3"]]) {
      const f = await fixture(preflightBody({ tier: "pro" }))
      expect(await run(["launch", "--check", "--quote-asset", "eth", ...dexFlags, "--json"], f.deps)).toBe(1)
      expect(f.calls).toEqual(["/api/v1/launch/preflight"])
      expect(json(f.stdout.text)).toMatchObject({
        requestedChain: "hood",
        works: false,
        embeddedCanLaunch: false,
        wallets: [{ id: "lw_spider", canLaunch: false, canBuy: false }],
      })
    }
  })

  test("an incompatible named wallet is clearly refused after one GET", async () => {
    const f = await fixture(preflightBody({}))
    expect(await run(["launch", "--check", "--quote-asset", "eth", "--wallet", "spider-01"], f.deps)).toBe(1)
    expect(f.calls).toEqual(["/api/v1/launch/preflight"])
    expect(f.stdout.text).toContain("spider-01 (Solana) cannot launch on Hood: choose a Hood wallet.")
    expect(f.stdout.text).not.toContain("This key can launch from spider-01")
  })

  test("a Hood check discovers a Hood TEE path without dex, image or banner reads", async () => {
    const f = await fixture(
      preflightBody({
        wallets: [
          {
            id: "lw_hood",
            address: "0x1234567890123456789012345678901234567890",
            chain: "evm",
            label: "hood",
            allowLaunch: true,
            active: true,
          },
        ],
      }),
    )
    expect(
      await run(
        [
          "launch",
          "--check",
          "--quote-asset",
          "eth",
          "--image",
          "./missing.png",
          "--banner",
          "./missing-banner.png",
          "--json",
        ],
        f.deps,
      ),
    ).toBe(0)
    expect(f.calls).toEqual(["/api/v1/launch/preflight"])
    expect(json(f.stdout.text)).toMatchObject({ requestedChain: "hood", works: true, wallets: [{ canLaunch: true }] })
  })

  test("a Solana check never counts a Hood TEE path", async () => {
    const f = await fixture(
      preflightBody({
        wallets: [
          {
            id: "lw_hood",
            address: "0x1234567890123456789012345678901234567890",
            chain: "evm",
            label: "hood",
            allowLaunch: true,
            active: true,
          },
        ],
      }),
    )
    expect(await run(["launch", "--check", "--quote-asset", "sol", "--json"], f.deps)).toBe(1)
    expect(json(f.stdout.text)).toMatchObject({
      requestedChain: "solana",
      works: false,
      wallets: [{ canLaunch: false }],
    })
  })

  test("embedded availability and delegation are evaluated only on the requested chain", async () => {
    for (const quote of ["eth", "sol"]) {
      for (const otherWallet of [null, { address: "other", delegated: false }, { address: "other", delegated: true }]) {
        for (const delegation of [null, false, true]) {
          const selected = delegation === null ? null : { address: "selected", delegated: delegation }
          const available = delegation === true
          const f = await fixture(
            preflightBody({
              embeddedPermission: "allowed",
              wallets: [],
              embeddedSolana: quote === "sol" ? selected : otherWallet,
              embeddedEvm: quote === "eth" ? selected : otherWallet,
            }),
          )
          expect(
            await run(["launch", "--check", "--quote-asset", quote, "--wallet", "embedded", "--json"], f.deps),
          ).toBe(available ? 0 : 1)
          expect(f.calls).toEqual(["/api/v1/launch/preflight"])
          expect(json(f.stdout.text)).toMatchObject({ works: available, embeddedCanLaunch: available })
        }
      }
    }
  })

  test("an available embedded wallet on another chain cannot satisfy the request", async () => {
    const f = await fixture(preflightBody({ embeddedPermission: "allowed", wallets: [] }))
    expect(await run(["launch", "--check", "--quote-asset", "eth"], f.deps)).toBe(1)
    expect(f.stdout.text).toContain("This account has no Hood embedded wallet.")
    expect(f.stdout.text).not.toContain("This key can launch")
  })

  test("without a chain hint, either delegated embedded chain works independently", async () => {
    for (const usableChain of ["solana", "hood"]) {
      const f = await fixture(
        preflightBody({
          embeddedPermission: "allowed",
          wallets: [],
          embeddedSolana: { address: EMBEDDED, delegated: usableChain === "solana" },
          embeddedEvm: { address: "0x1234", delegated: usableChain === "hood" },
        }),
      )
      expect(await run(["launch", "--check"], f.deps)).toBe(0)
      expect(f.stdout.text).toContain(
        `This key can launch from the ${usableChain === "hood" ? "Hood" : "Solana"} embedded wallet`,
      )
      expect(f.stdout.text).toContain("is not delegated for agent access.")
    }
  })

  test("a Free tier names the TEE refusal the server would give serially", async () => {
    const f = await fixture(
      preflightBody({
        tier: "free",
        selfLaunch: false,
        embeddedPermission: "allowed",
        embeddedSolana: null,
        wallets: [],
      }),
    )
    expect(await run(["launch", "--check"], f.deps)).toBe(1)
    expect(f.stdout.text).toContain("No launch path works for this key.")
  })

  test("a wallet that has allowLaunch off is named with its fix", async () => {
    const f = await fixture(
      preflightBody({
        tier: "pro",
        selfLaunch: true,
        embeddedPermission: "allowed",
        wallets: [
          { id: "lw_off", address: SPIDER, chain: "solana", label: "spider-01", allowLaunch: false, active: true },
        ],
      }),
    )
    expect(await run(["launch", "--check"], f.deps)).toBe(0)
    expect(f.stdout.text).toContain("the account owner has allowLaunch off for it")
    expect(f.stdout.text).toContain("candle wallets allow-launch lw_off")
  })

  test("--wallet narrows the answer to that wallet only", async () => {
    const f = await fixture(preflightBody({}))
    expect(await run(["launch", "--check", "--wallet", "spider-01"], f.deps)).toBe(0)
    const screen = f.stdout.text
    expect(screen).toContain("This key can launch from spider-01 with no first buy.")
    expect(screen).not.toContain("embedded wallet")
  })

  test("--wallet embedded answers only the embedded path", async () => {
    const f = await fixture(preflightBody({}))
    expect(await run(["launch", "--check", "--wallet", "embedded"], f.deps)).toBe(1)
    expect(f.stdout.text).toContain("The embedded wallet is denied on this key.")
    expect(f.stdout.text).not.toContain("spider-01")
  })

  test("an unknown --wallet is refused with the bound wallets listed", async () => {
    const f = await fixture(preflightBody({}))
    expect(await run(["launch", "--check", "--wallet", "nope"], f.deps)).toBe(1)
    expect(f.stderr.text).toContain("No TEE wallet on this key is called")
    expect(f.stderr.text).toContain("spider-01")
  })

  test("launches off on the server is the first line, and no path works", async () => {
    const f = await fixture(
      preflightBody({ headlessLaunch: false, tier: "max", selfLaunch: true, embeddedPermission: "allowed" }),
    )
    expect(await run(["launch", "--check"], f.deps)).toBe(1)
    expect(f.stdout.text).toContain("launches are off on this server (HEADLESS_LAUNCH_ENABLED off).")
  })

  test("a key without launch:write is told so before anything else", async () => {
    const f = await fixture(
      preflightBody({ scopes: ["swap:write"], tier: "max", selfLaunch: true, embeddedPermission: "allowed" }),
    )
    expect(await run(["launch", "--check"], f.deps)).toBe(1)
    expect(f.stdout.text).toContain("this key lacks launch:write")
  })

  test("--check with --dry-run is a usage error", async () => {
    const f = await fixture(preflightBody({}))
    expect(await run(["launch", "--check", "--dry-run"], f.deps)).toBe(2)
    expect(f.calls).toEqual([])
  })
})
