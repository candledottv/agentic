/**
 * BE-178, findings 2 and 3: what `nextSidecar` carries from the previous sidecar and what it never
 * does. A sidecar left behind by a DIFFERENT vault at the same path contributes nothing, so a new
 * vault cannot inherit the old one's verified-backup stamp; and `lastGeneration` never decreases
 * for the same vault, so a write committed onto an accepted older copy cannot lower ED-6's anchor.
 * The command-level consequences (retire-legacy's refusal, status still reporting an older copy)
 * are in `vault.test.ts`.
 */
import { describe, expect, test } from "bun:test"
import { nextSidecar, type VaultSidecar } from "./sidecar"

function file(vaultId: string, generation: number, ids: string[]) {
  return { vaultId, generation, envelopes: ids.map((id) => ({ id })) }
}

describe("BE-178 findings 2 and 3: nextSidecar", () => {
  test("a previous sidecar that belongs to a different vault contributes nothing", () => {
    const previous: VaultSidecar = {
      vaultId: "old-vault",
      lastGeneration: 7,
      envelopeIds: ["e1"],
      removedEnvelopeIds: ["e0"],
      lastVerifiedBackupAt: "2026-09-01T00:00:00.000Z",
      lastBackupDomain: "local",
      lastBackupSharedDomainAccepted: true,
      migratedFrom: [{ path: "tee-wallets.enc", at: "2026-09-01T00:00:00.000Z", sourceDigest: "digest" }],
    }
    const next = nextSidecar(previous, file("new-vault", 1, ["p1"]))
    expect(next).toEqual({ vaultId: "new-vault", lastGeneration: 1, envelopeIds: ["p1"], removedEnvelopeIds: [] })
  })

  test("for the same vault the bookkeeping is carried, and removed ids only grow", () => {
    const previous: VaultSidecar = {
      vaultId: "v",
      lastGeneration: 2,
      envelopeIds: ["a", "b"],
      removedEnvelopeIds: ["z"],
      lastVerifiedBackupAt: "2026-09-01T00:00:00.000Z",
    }
    const next = nextSidecar(previous, file("v", 3, ["a", "c"]))
    expect(next.lastVerifiedBackupAt).toBe("2026-09-01T00:00:00.000Z")
    expect(next.envelopeIds).toEqual(["a", "c"])
    expect(next.removedEnvelopeIds).toEqual(["b", "z"])
    expect(next.lastGeneration).toBe(3)
  })

  test("lastGeneration never decreases for the same vault, not even through a patch", () => {
    const previous: VaultSidecar = { vaultId: "v", lastGeneration: 5, envelopeIds: ["a", "b"], removedEnvelopeIds: [] }
    // A write committed onto an older copy (generation 2 written over generation 5's anchor).
    const onto = nextSidecar(previous, file("v", 3, ["a"]))
    expect(onto.lastGeneration).toBe(5)
    expect(onto.removedEnvelopeIds).toEqual(["b"])
    // A normal write still moves it forward.
    expect(nextSidecar(previous, file("v", 6, ["a", "b"])).lastGeneration).toBe(6)
    // And a patch cannot pull it back either.
    expect(nextSidecar(previous, file("v", 6, ["a"]), { lastGeneration: 2 }).lastGeneration).toBe(6)
  })
})
