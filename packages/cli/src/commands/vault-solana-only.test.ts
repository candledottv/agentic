/**
 * Ember Phase 4a (BE-350, spec `2026-09-24-ember-phase-4a-evm-vault-keys-design.md`, D3), E12: the
 * Solana-only filter. A vault with one Solana vault key and one EVM vault key: `vault fund` still
 * auto-selects the Solana key, and naming the EVM key with `--from`, `--to`, or a positional on
 * `fund`, `promote`, `demote`, `tee`, `external sweep` or `sign` exits 1 with
 * `SOLANA_COMMAND_EVM_KEY`, before anything is signed, written or broadcast.
 *
 * The fetch here is unreachable: every refusal below must fire before the first request, which is
 * what "does not sign or broadcast" means at the seam.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { FIXTURE_EVM_0 } from "../evm-lite.test"
import { run } from "../index"
import { createCapture, createFakeStore, createTestDeps } from "../test-support"
import { closeVault, commitVault } from "../vault/store"
import { makeVault, reopen, testClock, useCheapKdf } from "../vault/test-vault"

setDefaultTimeout(60_000)
useCheapKdf()

const RPC = "https://rpc.test/rpc"

async function fixture() {
  const made = await makeVault()
  closeVault(made.vault)
  const stdout = createCapture()
  const stderr = createCapture()
  const requests: string[] = []
  const deps = createTestDeps({
    fetch: (async (input: string | URL | Request) => {
      requests.push(String(input))
      throw new Error("no test in this file should reach the network")
    }) as unknown as typeof fetch,
    stdout,
    stderr,
    store: createFakeStore({ api_key: "cndl_test_key" }),
    env: { CANDLE_CONFIG_DIR: made.dir, HOME: made.dir },
    isTTY: { stdin: true, stdout: true, stderr: true },
    promptSecret: async () => made.passphrase,
    promptLine: async () => "confirm",
    readBytes: async () => new TextEncoder().encode("hello\n"),
    readStdin: async () => new TextEncoder().encode("hello\n"),
  })
  expect(await run(["vault", "new-key", "--chain", "solana", "--label", "cold"], deps)).toBe(0)
  expect(await run(["vault", "new-key", "--chain", "evm", "--label", "hood-cold"], deps)).toBe(0)
  // An external wallet for `external sweep` and `sign` to name as their source.
  expect(await run(["external", "new", "--label", "trader"], deps)).toBe(0)
  const opened = await reopen(made.path)
  const cold = opened.index.entries.find((entry) => entry.label === "cold")?.address as string
  const external = opened.index.entries.find((entry) => entry.label === "trader")?.address as string
  closeVault(opened)
  stdout.text = ""
  stderr.text = ""
  requests.length = 0
  return { deps, stdout, stderr, requests, cold, external, path: made.path }
}

function lastJson(text: string): Record<string, unknown> {
  return JSON.parse(text.trimEnd().split("\n").at(-1) ?? "")
}

describe("E12: Solana-only commands", () => {
  test("vault fund with one Solana vault key and one EVM vault key still auto-selects the Solana key", async () => {
    const fx = await fixture()
    // The Solana key is chosen without --from: the transfer plan is built and the first request
    // (the mint read / blockhash) is what the unreachable fetch stops. That is past selection.
    const code = await run(
      ["vault", "fund", "trader", "--amount", "0.1", "--asset", "SOL", "--rpc-url", RPC, "--json"],
      fx.deps,
    )
    expect(code).not.toBe(2)
    expect(fx.stderr.text + fx.stdout.text).not.toContain("name the source with --from")
    expect(fx.stdout.text).toContain(`from vault key cold`)
    expect(fx.stdout.text).not.toContain(FIXTURE_EVM_0)
  })

  const refusals: Array<{ name: string; argv: (fx: Awaited<ReturnType<typeof fixture>>) => string[] }> = [
    {
      name: "vault fund --from <evm>",
      argv: () => [
        "vault",
        "fund",
        "trader",
        "--amount",
        "0.1",
        "--asset",
        "SOL",
        "--rpc-url",
        RPC,
        "--from",
        "hood-cold",
      ],
    },
    {
      name: "vault promote --in-place <solana> --sweep-to <evm>",
      argv: () => ["vault", "promote", "--in-place", "cold", "--sweep-to", "hood-cold", "--rpc-url", RPC],
    },
    { name: "tee enable <evm address>", argv: (fx) => ["tee", "enable", FIXTURE_EVM_0, "--vault", fx.cold] },
    { name: "tee enable --vault-key <evm>", argv: (fx) => ["tee", "enable", fx.external, "--vault-key", "hood-cold"] },
    { name: "tee status <evm address>", argv: () => ["tee", "status", FIXTURE_EVM_0] },
    {
      name: "external sweep --to <evm>",
      argv: () => ["external", "sweep", "trader", "--to", "hood-cold", "--rpc-url", RPC],
    },
    {
      name: "external sweep <evm positional>",
      argv: () => ["external", "sweep", "hood-cold", "--to", "cold", "--rpc-url", RPC],
    },
    {
      name: "sign message --wallet <evm>",
      argv: () => ["sign", "message", "--wallet", "hood-cold", "--file", "msg.txt"],
    },
  ]
  for (const refusal of refusals) {
    test(`${refusal.name} exits 1 with SOLANA_COMMAND_EVM_KEY and makes no request`, async () => {
      const fx = await fixture()
      const code = await run([...refusal.argv(fx), "--json"], fx.deps)
      expect(code).toBe(1)
      const body = lastJson(fx.stdout.text)
      expect(body.ok).toBe(false)
      expect(`${body.code} ${body.message}`).toContain("SOLANA_COMMAND_EVM_KEY")
      expect(String(body.message)).toContain("EVM key")
      expect(fx.requests).toEqual([])
    })
  }

  // BE-391 (Phase 4b, D1): `vault fund`, `vault promote`, `vault demote`, `tee sweep` and `tee
  // disable` now take an EVM entry (a Hood TEE wallet). Naming an EVM VAULT key to them is refused
  // by the Hood path's own rule, still before any request, and never as SOLANA_COMMAND_EVM_KEY.
  const hoodRefusals: Array<{ name: string; argv: string[]; code: string }> = [
    {
      name: "vault fund <evm vault key>",
      argv: ["vault", "fund", FIXTURE_EVM_0, "--amount", "0.1", "--asset", "ETH"],
      code: "TEE_WALLET_UNKNOWN",
    },
    {
      name: "vault promote --in-place <evm> --sweep-to <solana>",
      argv: ["vault", "promote", "--in-place", "hood-cold", "--sweep-to", "cold"],
      code: "PROMOTE_DESTINATION_NOT_COLD",
    },
    { name: "vault demote <evm vault key>", argv: ["vault", "demote", FIXTURE_EVM_0], code: "TEE_WALLET_UNKNOWN" },
    { name: "tee sweep <evm vault key>", argv: ["tee", "sweep", FIXTURE_EVM_0], code: "TEE_WALLET_UNKNOWN" },
    { name: "tee disable <evm vault key>", argv: ["tee", "disable", FIXTURE_EVM_0], code: "TEE_WALLET_UNKNOWN" },
  ]
  for (const refusal of hoodRefusals) {
    test(`BE-391: ${refusal.name} takes the Hood path and refuses with ${refusal.code}, making no request`, async () => {
      const fx = await fixture()
      const code = await run([...refusal.argv, "--json"], fx.deps)
      expect(code).toBe(1)
      const body = lastJson(fx.stdout.text)
      expect(body.code).toBe(refusal.code)
      expect(fx.requests).toEqual([])
    })
  }

  test("the refusal names the EVM entry by address too, in either case, and the exit is `vault transfer`", async () => {
    const fx = await fixture()
    const code = await run(
      [
        "vault",
        "fund",
        "trader",
        "--amount",
        "0.1",
        "--asset",
        "SOL",
        "--rpc-url",
        RPC,
        "--from",
        FIXTURE_EVM_0.toLowerCase(),
        "--json",
      ],
      fx.deps,
    )
    expect(code).toBe(1)
    const body = lastJson(fx.stdout.text)
    expect(body.code).toBe("SOLANA_COMMAND_EVM_KEY")
    expect(String(body.suggestion)).toContain("candle vault transfer <0x address> --from hood-cold")
  })

  test("a promoted-in-place EVM entry cannot exist, but the sweep destination rule still refuses an EVM key that was hand-edited cold", async () => {
    // `assertColdVaultDestination` is the one producer of the destination rule; an EVM entry is
    // refused there by name, whatever its exposure flags say.
    const fx = await fixture()
    const vault = await reopen(fx.path)
    await commitVault(vault, { index: vault.index }, testClock)
    closeVault(vault)
    const { assertColdVaultDestination } = await import("../vault/promote-support")
    const again = await reopen(fx.path)
    try {
      expect(() => assertColdVaultDestination(again.index, "hood-cold", {})).toThrow(
        expect.objectContaining({ code: "SOLANA_COMMAND_EVM_KEY" }),
      )
      expect(() => assertColdVaultDestination(again.index, FIXTURE_EVM_0, {})).toThrow(
        expect.objectContaining({ code: "SOLANA_COMMAND_EVM_KEY" }),
      )
      expect(assertColdVaultDestination(again.index, "cold", {}).address).toBe(fx.cold)
    } finally {
      closeVault(again)
    }
  })
})
