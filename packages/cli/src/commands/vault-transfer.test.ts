/**
 * BE-355 (spec `docs/superpowers/specs/2026-09-24-cli-default-solana-rpc-design.md`, T10 to T12):
 * `candle vault transfer` from a Solana vault key when the RPC rate-limits.
 *
 * Before any signature (the blockhash read), a rate limit that survives the client's one retry is
 * `RPC_RATE_LIMITED`, exit 1, and nothing is sent. After the signature (the send, or a status read
 * after it), the outcome is the existing uncertain one: exit 3 with the local signature, exactly
 * one send, and D4's fix line on stderr. Each case runs with an acting profile `work` and in
 * pre-profile mode, because the fix text differs (D2).
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { run } from "../index"
import { publicRpcNoticeLines, rpcFixLines } from "../solana-endpoint"
import { createCapture, createFakeConfigStore, createRoutedFetch, createTestDeps, jsonResponse } from "../test-support"
import { closeVault } from "../vault/store"
import { makeVault, useCheapKdf } from "../vault/test-vault"

setDefaultTimeout(60_000)
useCheapKdf()

const RPC = "https://rpc.test/rpc"
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"
const DESTINATION = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
const PRE_PROFILE_FIX = [
  "--rpc-url https://<your-rpc> on this command, or CANDLE_SOLANA_RPC_URL for every command",
  "or sign in (candle auth login) to store one per profile",
]

function lastJson(text: string): Record<string, unknown> {
  return JSON.parse(text.trimEnd().split("\n").at(-1) ?? "")
}

async function fixture(opts: { rateLimit?: Record<string, number>; profile?: boolean } = {}) {
  const made = await makeVault()
  closeVault(made.vault)
  const stdout = createCapture()
  const stderr = createCapture()
  const methods: string[] = []
  const limited = new Map<string, number>()
  const { fetch } = createRoutedFetch({
    "/rpc": async (req) => {
      const { method, params, id } = JSON.parse(String(req.init.body))
      methods.push(method)
      const remaining = opts.rateLimit?.[method] ?? 0
      const seen = limited.get(method) ?? 0
      if (seen < remaining) {
        limited.set(method, seen + 1)
        return new Response("rate limited", { status: 429 })
      }
      const reply = (result: unknown) => jsonResponse(200, { id, jsonrpc: "2.0", result })
      switch (method) {
        case "getLatestBlockhash":
          return reply({ value: { blockhash: BLOCKHASH } })
        case "getFeeForMessage":
          return reply({ value: 5000 })
        case "sendTransaction":
          return reply(String(params[0]).slice(0, 8))
        case "getSignatureStatuses":
          return reply({ value: [{ confirmationStatus: "finalized", err: null }] })
        default:
          throw new Error(`unexpected RPC method ${method}`)
      }
    },
  })
  const deps = createTestDeps({
    fetch,
    stdout,
    stderr,
    env: { CANDLE_CONFIG_DIR: made.dir, HOME: made.dir, CANDLE_SOLANA_RPC_URL: RPC },
    promptSecret: async () => made.passphrase,
    promptLine: async () => DESTINATION.slice(-6),
    ...(opts.profile ? createFakeConfigStore({ profiles: { work: {} }, activeProfile: "work" }) : {}),
  })
  expect(await run(["vault", "new-key", "--chain", "solana", "--label", "cold"], deps)).toBe(0)
  stdout.text = ""
  stderr.text = ""
  methods.length = 0
  const transfer = () =>
    run(["vault", "transfer", DESTINATION, "--from", "cold", "--amount", "0.1", "--asset", "SOL", "--json"], deps)
  return { deps, stdout, stderr, methods, transfer }
}

describe("T10: RPC_RATE_LIMITED before any signature", () => {
  test("with acting profile work: exit 1, nothing signed or sent, the suggestion names profile set", async () => {
    const f = await fixture({ rateLimit: { getLatestBlockhash: Number.POSITIVE_INFINITY }, profile: true })
    expect(await f.transfer()).toBe(1)
    const body = lastJson(f.stdout.text)
    expect(body.code).toBe("RPC_RATE_LIMITED")
    expect(body.message).toBe(
      "The Solana RPC at rpc.test is rate-limiting this CLI (HTTP 429, retried once). Nothing was signed or sent.",
    )
    expect(body.suggestion).toBe(
      "candle profile set work --rpc-url https://<your-rpc>\nor, for one command, --rpc-url https://<your-rpc> or CANDLE_SOLANA_RPC_URL",
    )
    // One retry, then the refusal: two blockhash reads and no send.
    expect(f.methods).toEqual(["getLatestBlockhash", "getLatestBlockhash"])
    // The env source: a host line, and no notice.
    expect(f.stderr.text).toContain("Solana RPC: rpc.test (CANDLE_SOLANA_RPC_URL)")
    expect(f.stderr.text).not.toContain(publicRpcNoticeLines({ profile: "work" } as never)[0] as string)
  })

  test("pre-profile: the suggestion is D3's pre-profile text byte for byte", async () => {
    const f = await fixture({ rateLimit: { getLatestBlockhash: Number.POSITIVE_INFINITY } })
    expect(await f.transfer()).toBe(1)
    const body = lastJson(f.stdout.text)
    expect(body.code).toBe("RPC_RATE_LIMITED")
    expect(body.suggestion).toBe(PRE_PROFILE_FIX.join("\n"))
    expect(String(body.suggestion)).not.toContain("profile set")
    expect(String(body.suggestion)).not.toContain("<name>")
    expect(f.methods).not.toContain("sendTransaction")
  })

  test("human mode: the message, then Fix: with the lines aligned under it", async () => {
    const f = await fixture({ rateLimit: { getLatestBlockhash: Number.POSITIVE_INFINITY }, profile: true })
    expect(
      await run(["vault", "transfer", DESTINATION, "--from", "cold", "--amount", "0.1", "--asset", "SOL"], f.deps),
    ).toBe(1)
    expect(f.stderr.text).toContain(
      "Nothing was signed or sent.\nFix: candle profile set work --rpc-url https://<your-rpc>\n     or, for one command, --rpc-url https://<your-rpc> or CANDLE_SOLANA_RPC_URL\n",
    )
  })
})

describe("T11: a post-signature rate limit exits 3 with the signature and never re-sends", () => {
  test("with acting profile work: one send, finalized false, the signature, and Fix: profile set", async () => {
    const f = await fixture({ rateLimit: { sendTransaction: Number.POSITIVE_INFINITY }, profile: true })
    expect(await f.transfer()).toBe(3)
    const body = lastJson(f.stdout.text)
    expect(body.ok).toBe(false)
    expect(body.finalized).toBe(false)
    expect(typeof body.signature).toBe("string")
    expect(f.methods.filter((m) => m === "sendTransaction")).toHaveLength(1)
    expect(f.stderr.text).toContain(
      `The RPC rate-limited this CLI after the transaction was signed. It may still land: check ${body.signature} before anything else.\nFix: candle profile set work --rpc-url https://<your-rpc>\n`,
    )
  })

  test("pre-profile: the fix is D3's two pre-profile lines; exit code and signature are unchanged", async () => {
    const f = await fixture({ rateLimit: { sendTransaction: Number.POSITIVE_INFINITY } })
    expect(await f.transfer()).toBe(3)
    const body = lastJson(f.stdout.text)
    expect(typeof body.signature).toBe("string")
    expect(f.methods.filter((m) => m === "sendTransaction")).toHaveLength(1)
    expect(f.stderr.text).toContain(
      `check ${body.signature} before anything else.\nFix: ${PRE_PROFILE_FIX[0]}\n     ${PRE_PROFILE_FIX[1]}\n`,
    )
    expect(f.stderr.text).not.toContain("profile set")
    expect(f.stderr.text).not.toContain("<name>")
  })
})

describe("T12: a rate-limited status read after the send retries once, then exits 3", () => {
  test("two status requests, one send, exit 3 with the signature", async () => {
    const f = await fixture({ rateLimit: { getSignatureStatuses: Number.POSITIVE_INFINITY }, profile: true })
    expect(await f.transfer()).toBe(3)
    const body = lastJson(f.stdout.text)
    expect(typeof body.signature).toBe("string")
    expect(f.methods.filter((m) => m === "sendTransaction")).toHaveLength(1)
    expect(f.methods.filter((m) => m === "getSignatureStatuses")).toHaveLength(2)
    expect(f.stderr.text).toContain(`check ${body.signature} before anything else.`)
    expect(rpcFixLines({ profile: "work" } as never)[0]).toBe("candle profile set work --rpc-url https://<your-rpc>")
  })
})
