/**
 * The pending-sweep transitions (BE-94, HW-07) as pure decisions: missing, nonfinal (with and
 * without an error), finalized success, finalized failure, validated expiry, the status/expiry
 * race, and every RPC failure or malformed answer staying uncertain.
 */
import { describe, expect, test } from "bun:test"
import { classifyStatus, type PendingReads, resolvePending, type SignatureStatus } from "./sweep-pending"

const P = { signature: "sig-a", blockhash: "hash-a" }

function reads(
  statuses: Array<SignatureStatus | null | Error>,
  validity: boolean | Error | "malformed",
): PendingReads & {
  statusReads: number
  validityReads: number
} {
  const queue = [...statuses]
  const r = {
    statusReads: 0,
    validityReads: 0,
    async status() {
      r.statusReads += 1
      const next = queue.shift()
      if (next === undefined) throw new Error("no more scripted statuses")
      if (next instanceof Error) throw next
      return next
    },
    async blockhashValid() {
      r.validityReads += 1
      if (validity instanceof Error) throw validity
      if (validity === "malformed") throw new Error("isBlockhashValid answered with a non-boolean value")
      return validity
    },
  }
  return r
}

describe("classifyStatus", () => {
  test("missing, nonfinal, finalized success, finalized failure", () => {
    expect(classifyStatus(null)).toEqual({ kind: "missing" })
    expect(classifyStatus(undefined)).toEqual({ kind: "missing" })
    expect(classifyStatus({ confirmationStatus: "processed", err: null })).toEqual({
      kind: "nonfinal",
      confirmationStatus: "processed",
      err: null,
    })
    expect(classifyStatus({ confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } })).toMatchObject(
      {
        kind: "nonfinal",
        confirmationStatus: "confirmed",
      },
    )
    expect(classifyStatus({ confirmationStatus: "finalized", err: null })).toEqual({ kind: "finalized" })
    expect(classifyStatus({ confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] } })).toEqual({
      kind: "failed",
      err: { InstructionError: [0, "Custom"] },
    })
  })
})

describe("resolvePending", () => {
  test("finalized success is a receipt; validity is never consulted", async () => {
    const r = reads([{ confirmationStatus: "finalized", err: null }], false)
    expect(await resolvePending(r, P)).toEqual({ kind: "finalized" })
    expect(r.validityReads).toBe(0)
  })
  test("finalized failure is conclusive: dropped so the balance is swept again", async () => {
    const r = reads([{ confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] } }], true)
    expect(await resolvePending(r, P)).toMatchObject({ kind: "failed" })
  })
  test("a confirmed observation stays pending even when the admission blockhash has expired", async () => {
    const r = reads([{ confirmationStatus: "confirmed", err: null }], false)
    const res = await resolvePending(r, P)
    expect(res.kind).toBe("uncertain")
    expect(r.validityReads).toBe(0)
  })
  test("a NONFINAL error is not a failure: it can roll back with its fork, so it stays pending", async () => {
    const r = reads([{ confirmationStatus: "processed", err: { InstructionError: [0, "Custom"] } }], false)
    const res = await resolvePending(r, P)
    expect(res.kind).toBe("uncertain")
    expect(res.kind === "uncertain" && res.detail).toContain("with error")
  })
  test("missing with a valid blockhash stays pending", async () => {
    const r = reads([null], true)
    expect((await resolvePending(r, P)).kind).toBe("uncertain")
    expect(r.validityReads).toBe(1)
  })
  test("missing, expired blockhash, and STILL missing on the re-read: validated expiry", async () => {
    const r = reads([null, null], false)
    const res = await resolvePending(r, P)
    expect(res.kind).toBe("expired")
    expect(r.statusReads).toBe(2)
  })
  test("the status/expiry race: missing, then expired, then finalized on the re-read is a receipt", async () => {
    const r = reads([null, { confirmationStatus: "finalized", err: null }], false)
    expect(await resolvePending(r, P)).toEqual({ kind: "finalized" })
  })
  test("the race with a nonfinal re-read stays pending", async () => {
    const r = reads([null, { confirmationStatus: "confirmed", err: null }], false)
    expect((await resolvePending(r, P)).kind).toBe("uncertain")
  })
  test("a malformed or failing validity answer is unknown, never expiry", async () => {
    expect((await resolvePending(reads([null], "malformed"), P)).kind).toBe("uncertain")
    expect((await resolvePending(reads([null], new Error("RPC down")), P)).kind).toBe("uncertain")
  })
  test("a failing status read stays pending, on the first read and on the confirming re-read", async () => {
    expect((await resolvePending(reads([new Error("RPC down")], false), P)).kind).toBe("uncertain")
    expect((await resolvePending(reads([null, new Error("RPC down")], false), P)).kind).toBe("uncertain")
  })
})
