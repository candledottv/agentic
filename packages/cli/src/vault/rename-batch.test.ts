import { describe, expect, test } from "bun:test"
import type { IndexPlaintext, KeyEntry } from "./format"
import { MAX_RENAME_BATCH, parseRenamePairs, planBatchRename } from "./rename-batch"

describe("rename pairs file", () => {
  test("1 and 256 rows work; an empty file or 257 rows refuse", () => {
    for (const count of [1, MAX_RENAME_BATCH, MAX_RENAME_BATCH + 1]) {
      const text = Array.from({ length: count }, (_, at) => `key-${at} cold-${at}`).join("\n")
      const parsed = parseRenamePairs(text)
      expect(parsed.rows).toHaveLength(count)
      expect(parsed.findings.length === 0).toBe(count <= MAX_RENAME_BATCH)
    }
    expect(parseRenamePairs("\n# comment\n").findings).toHaveLength(1)
    expect(parseRenamePairs("from,to\n# comment").findings).toHaveLength(1)
  })

  test("CSV picks columns by name and preserves quoted values and physical line numbers", () => {
    expect(parseRenamePairs('# comment\r\n\r\nother,to,from\r\nignored,"cold, two","old ""one"""\r\n')).toEqual({
      rows: [{ line: 4, from: 'old "one"', to: "cold, two" }],
      findings: [],
    })
  })

  test("missing or repeated required columns refuse", () => {
    for (const text of ["from,other\na,b", "to,other\na,b", "from,to,from\na,b,c", "from,to,to\na,b,c"]) {
      expect(parseRenamePairs(text).findings[0]?.problem).toContain("exactly one from and one to")
    }
  })

  test("malformed rows and duplicate names are all reported without trimming labels", () => {
    const parsed = parseRenamePairs(
      'from,to\na," cold"\nb,cold \nc,"unclosed\nd,bad"quote\ne,\nf,same\ng,same\na,-dash\n',
    )
    expect(parsed.findings).toHaveLength(8)
    expect(parsed.rows[0]?.to).toBe(" cold")
    expect(parsed.rows[1]?.to).toBe("cold ")
    expect(parseRenamePairs("a b c\nlone\na cold \n").findings).toHaveLength(3)
  })
})

function key(id: string, label: string, address: string): KeyEntry {
  return {
    id,
    label,
    address,
    role: "vault",
    chain: "solana",
    curve: "ed25519",
    origin: "derived",
    createdAt: "2026-10-10T00:00:00Z",
    exposure: { everRemoteExposed: false, everExported: false },
  }
}
function index(entries: KeyEntry[]): IndexPlaintext {
  return {
    entries,
    hd: {
      scheme: "bip39-24/slip10",
      nextIndex: { solanaVault: entries.length, solanaTee: 0, solanaExternal: 0, evm: 0 },
      rootExported: false,
      exposedIndexes: { solanaVault: [], solanaTee: [], solanaExternal: [], evm: [] },
    },
  }
}

describe("whole-index rename plan", () => {
  test("ambiguous labels and addresses list every candidate; unique ids repair them", () => {
    const entries = [key("id1", "duplicate", "address"), key("id2", "duplicate", "address")]
    const refused = planBatchRename(index(entries), [
      { line: 1, from: "duplicate", to: "one" },
      { line: 2, from: "address", to: "two" },
    ])
    expect(refused.findings).toHaveLength(2)
    for (const finding of refused.findings) {
      expect(finding.problem).toContain("id1")
      expect(finding.problem).toContain("id2")
    }
    expect(
      planBatchRename(index(entries), [
        { line: 1, from: "id1", to: "one" },
        { line: 2, from: "id2", to: "two" },
      ]).findings,
    ).toEqual([])
  })

  test("an unchanged label and an occupied name refuse together; a swap keeps the input index untouched", () => {
    const original = index([key("id1", "a", "A"), key("id2", "b", "B"), key("id3", "outside", "C")])
    expect(
      planBatchRename(original, [
        { line: 1, from: "a", to: "a" },
        { line: 2, from: "b", to: "outside" },
      ]).findings,
    ).toHaveLength(2)
    expect(
      planBatchRename(original, [
        { line: 1, from: "a", to: "b" },
        { line: 2, from: "b", to: "a" },
      ]).findings,
    ).toEqual([])
    expect(original.entries.map((entry) => entry.label)).toEqual(["a", "b", "outside"])
  })
})
