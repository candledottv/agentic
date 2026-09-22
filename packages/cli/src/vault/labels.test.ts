/**
 * BE-259 (D11): the pure parts of key naming, asserted without a vault. The command tests in
 * `commands/vault-rename.test.ts` drive the same functions through `run()`; these pin the rules
 * themselves, so a wording or ordering change is caught at its definition.
 */
import { describe, expect, test } from "bun:test"
import type { IndexPlaintext, KeyEntry } from "./format"
import { duplicateLabels, entriesWithLabel, resolveRenameTarget, validateLabel } from "./labels"

function entry(id: string, label: string, address: string, role: KeyEntry["role"] = "vault"): KeyEntry {
  return {
    id,
    chain: "solana",
    curve: "ed25519",
    address,
    label,
    createdAt: "2026-09-22T00:00:00.000Z",
    role,
    origin: "derived",
    exposure: { everRemoteExposed: false, everExported: false },
  }
}

function indexOf(entries: KeyEntry[]): IndexPlaintext {
  return {
    hd: {
      scheme: "bip39-24/slip10",
      nextIndex: { solanaVault: entries.length, solanaTee: 0, solanaExternal: 0, evm: 0 },
      rootExported: false,
      exposedIndexes: { solanaVault: [], solanaTee: [], solanaExternal: [], evm: [] },
    },
    entries,
  }
}

describe("validateLabel: the argument-shape rules for <new>", () => {
  test("empty or whitespace only is refused", () => {
    expect(validateLabel("")).toBe("A key's label cannot be empty.")
    expect(validateLabel("   ")).toBe("A key's label cannot be empty.")
    expect(validateLabel("\t")).toBe("A key's label cannot be empty.")
  })

  test("a newline, a tab or any C0 control character is refused", () => {
    const line = "A key's label cannot contain a newline, a tab or a control character."
    expect(validateLabel("a\nb")).toBe(line)
    expect(validateLabel("a\tb")).toBe(line)
    expect(validateLabel(`a${String.fromCharCode(0)}b`)).toBe(line)
    expect(validateLabel(`a${String.fromCharCode(0x1b)}b`)).toBe(line)
    expect(validateLabel(`a${String.fromCharCode(0x7f)}b`)).toBe(line)
  })

  test("a leading dash is refused, because it reads as a flag everywhere a label is typed", () => {
    expect(validateLabel("-treasury")).toBe(
      'A key\'s label cannot begin with "-": it would be read as a flag everywhere a label is typed.',
    )
    // A dash INSIDE a name is fine: `treasury-cold` is the spec's own example.
    expect(validateLabel("treasury-cold")).toBeUndefined()
  })

  test("no length cap, and non-ASCII is fine", () => {
    expect(validateLabel("x".repeat(500))).toBeUndefined()
    expect(validateLabel("trésorerie")).toBeUndefined()
    expect(validateLabel("treasury cold")).toBeUndefined()
  })
})

describe("duplicateLabels and entriesWithLabel", () => {
  test("every label more than one entry carries, in first-created order, with every holder", () => {
    const index = indexOf([
      entry("i1", "treasury", "A1"),
      entry("i2", "ops", "A2"),
      entry("i3", "treasury", "A3"),
      entry("i4", "fees", "A4"),
      entry("i5", "ops", "A5"),
      entry("i6", "treasury", "A6"),
    ])
    const found = duplicateLabels(index)
    expect(found.map((duplicate) => duplicate.label)).toEqual(["treasury", "ops"])
    expect(found[0]?.entries.map((holder) => holder.id)).toEqual(["i1", "i3", "i6"])
    expect(found[1]?.entries.map((holder) => holder.id)).toEqual(["i2", "i5"])
    expect(entriesWithLabel(index, "treasury").map((holder) => holder.address)).toEqual(["A1", "A3", "A6"])
    expect(entriesWithLabel(index, "nobody")).toEqual([])
  })

  test("a vault with unique labels has none", () => {
    expect(duplicateLabels(indexOf([entry("i1", "a", "A1"), entry("i2", "b", "A2")]))).toEqual([])
    expect(duplicateLabels(indexOf([]))).toEqual([])
  })
})

describe("resolveRenameTarget: label first, then address, --id first of all", () => {
  const i1 = entry("i1", "treasury", "Addr1")
  const i2 = entry("i2", "Addr1", "Addr2")
  const i3 = entry("i3", "dup", "Addr3")
  const i4 = entry("i4", "dup", "Addr4")
  const i5 = entry("i5", "twice", "Same")
  const i6 = entry("i6", "twice-again", "Same")
  const index = indexOf([i1, i2, i3, i4, i5, i6])

  test("an exact label wins", () => {
    expect(resolveRenameTarget(index, "treasury")).toEqual({ kind: "found", entry: i1, by: "label" })
  })

  test("a label that spells an address wins over the address, as every other resolver does", () => {
    // `Addr1` is entry i1's ADDRESS and entry i2's LABEL. Label first: i2.
    expect(resolveRenameTarget(index, "Addr1")).toEqual({ kind: "found", entry: i2, by: "label" })
  })

  test("an address matches when no label does", () => {
    expect(resolveRenameTarget(index, "Addr2")).toEqual({ kind: "found", entry: i2, by: "address" })
  })

  test("more than one match by label lists every candidate, in index order", () => {
    expect(resolveRenameTarget(index, "dup")).toEqual({
      kind: "ambiguous",
      by: "label",
      candidates: [i3, i4],
    })
  })

  test("more than one match by address lists every candidate, in index order", () => {
    expect(resolveRenameTarget(index, "Same")).toEqual({
      kind: "ambiguous",
      by: "address",
      candidates: [i5, i6],
    })
  })

  test("--id is matched first and alone: the positional's other meanings are not consulted", () => {
    expect(resolveRenameTarget(index, "dup", "i4")).toEqual({ kind: "found", entry: i4, by: "id" })
    expect(resolveRenameTarget(index, "Same", "i6")).toEqual({ kind: "found", entry: i6, by: "id" })
    // A real label with a wrong id is "none", not the label's match.
    expect(resolveRenameTarget(index, "treasury", "nope")).toEqual({ kind: "none" })
  })

  test("nothing matches", () => {
    expect(resolveRenameTarget(index, "ghost")).toEqual({ kind: "none" })
  })
})
