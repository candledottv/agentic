import { describe, expect, test } from "bun:test"
import { checkLaunchSignature, LAUNCH_SIGNATURE_POLL_MS, LAUNCH_SIGNATURE_READS } from "./launch-landed"

type Status = { confirmationStatus: string | null; err: unknown; slot?: number } | null

function reader(answers: Array<Status | Error>) {
  let reads = 0
  const sleeps: number[] = []
  return {
    read: async () => {
      const answer = answers[Math.min(reads, answers.length - 1)] ?? null
      reads += 1
      if (answer instanceof Error) throw answer
      return answer
    },
    sleep: async (ms: number) => {
      sleeps.push(ms)
    },
    reads: () => reads,
    sleeps,
  }
}

describe("BE-3575: checkLaunchSignature", () => {
  test("a signature that finalizes late without an error landed, with its slot", async () => {
    const r = reader([
      null,
      { confirmationStatus: "confirmed", err: null },
      { confirmationStatus: "finalized", err: null, slot: 7 },
    ])
    expect(await checkLaunchSignature(r.read, r.sleep, "sig")).toEqual({ kind: "landed", slot: 7 })
    expect(r.reads()).toBe(3)
    expect(r.sleeps).toEqual([LAUNCH_SIGNATURE_POLL_MS, LAUNCH_SIGNATURE_POLL_MS])
  })

  test("finalized with an error reverted", async () => {
    const r = reader([{ confirmationStatus: "finalized", err: { InstructionError: [0, "x"] } }])
    expect(await checkLaunchSignature(r.read, r.sleep, "sig")).toEqual({
      kind: "reverted",
      err: { InstructionError: [0, "x"] },
    })
  })

  test("a nonfinal error is not conclusive", async () => {
    const r = reader([{ confirmationStatus: "confirmed", err: { x: 1 } }])
    expect((await checkLaunchSignature(r.read, r.sleep, "sig")).kind).toBe("unknown")
    expect(r.reads()).toBe(LAUNCH_SIGNATURE_READS)
  })

  test("a failed read is retried, and its message (which may carry an RPC key) is never repeated", async () => {
    const r = reader([new Error("https://rpc.example/?api-key=secret down")])
    const check = await checkLaunchSignature(r.read, r.sleep, "sig")
    expect(check).toEqual({ kind: "unknown", detail: "the RPC read failed" })
    expect(r.reads()).toBe(LAUNCH_SIGNATURE_READS)
  })

  test("a read that fails then lands is landed", async () => {
    const r = reader([new Error("down"), { confirmationStatus: "finalized", err: null }])
    expect(await checkLaunchSignature(r.read, r.sleep, "sig")).toEqual({ kind: "landed" })
  })
})
