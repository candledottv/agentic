import { describe, expect, test } from "bun:test"
import { Keypair } from "@solana/web3.js"
import type { CommandContext } from "../deps"
import { createCapture, createRoutedFetch, createTestDeps, jsonResponse } from "../test-support"
import { displayTransferPlan, planTransfer, signAndBroadcastTransfer } from "./vault-transfer-sign"

const fromKey = Keypair.generate()
const from = fromKey.publicKey.toBase58()
const to = Keypair.generate().publicKey.toBase58()
const rpcUrl = "https://rpc.test/rpc"
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"

describe("transfer account creation disclosure", () => {
  for (const exists of [false, true]) {
    test(`destination account ${exists ? "exists" : "needs creation"}`, async () => {
      const { fetch, calls } = createRoutedFetch({
        "/rpc": (req) => {
          const { method, params } = JSON.parse(String(req.init.body))
          if (method === "getAccountInfo") return jsonResponse(200, { result: { value: exists ? {} : null } })
          expect(method).toBe("getMinimumBalanceForRentExemption")
          expect(params).toEqual([165, { commitment: "finalized" }])
          return jsonResponse(200, { result: 2_123_456 })
        },
      })
      const plan = await planTransfer({ from, to, amount: "1", asset: "USDC", rpcUrl, fetch })
      const stdout = createCapture()
      const ctx: CommandContext = {
        deps: createTestDeps({ fetch, stdout }),
        json: false,
        apiUrl: "",
        verifyAccount: false,
      }
      displayTransferPlan(ctx, plan, 5000n)
      expect(plan.instructions).toHaveLength(exists ? 1 : 2)
      expect(calls).toHaveLength(exists ? 1 : 2)
      expect(stdout.text).toContain("fee quote  5000 lamports")
      if (exists) expect(stdout.text).not.toContain("account rent")
      else {
        expect(stdout.text).toContain("create associated token account")
        expect(stdout.text).toContain(`account owner ${to}`)
        expect(stdout.text).toContain(`account rent 2123456 lamports, paid by ${from} if created`)
      }
    })
  }

  test("an unavailable rent quote refuses before signing", async () => {
    const { fetch } = createRoutedFetch({
      "/rpc": (req) =>
        JSON.parse(String(req.init.body)).method === "getAccountInfo"
          ? jsonResponse(200, { result: { value: null } })
          : jsonResponse(503, {}),
    })
    await expect(planTransfer({ from, to, amount: "1", asset: "USDC", rpcUrl, fetch })).rejects.toThrow("HTTP 503")
  })
})

test("a failed pending write never reaches broadcast", async () => {
  const { fetch, calls } = createRoutedFetch({
    "/rpc": (req) => {
      expect(JSON.parse(String(req.init.body)).method).toBe("getLatestBlockhash")
      return jsonResponse(200, { result: { value: { blockhash: BLOCKHASH } } })
    },
  })
  const plan = await planTransfer({ from, to, amount: "1", asset: "SOL", rpcUrl, fetch })
  const ctx: CommandContext = { deps: createTestDeps({ fetch }), json: false, apiUrl: "", verifyAccount: false }
  await expect(
    signAndBroadcastTransfer({
      ctx,
      rpcUrl,
      secret64: fromKey.secretKey,
      plan,
      beforeBroadcast: async ({ signature, blockhash }) => {
        expect(signature.length).toBeGreaterThan(0)
        expect(blockhash).toBe(BLOCKHASH)
        throw new Error("disk write refused")
      },
    }),
  ).rejects.toThrow("disk write refused")
  expect(calls).toHaveLength(1)
})
