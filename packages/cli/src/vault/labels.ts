/**
 * BE-259 (spec `2026-09-22-cli-vault-key-naming-design.md`, D11): the pure parts of key naming.
 *
 * The label is the vault's addressing surface -- `--from`, `--wallet`, `export-key <label>` and
 * `external sweep` all resolve a key by it -- and until this card nothing in the CLI could change
 * one or say when two keys shared one. These four functions are the single definition of
 * "duplicate", "valid" and "which entry did you mean" that `vault rename` (D3 to D8), `vault
 * status --unlock`'s duplicate block (D5) and `vault new-key`'s pre-derivation check (D9) share.
 * Pure functions over `IndexPlaintext`, in the shape `promote-support.ts` and `hygiene.ts`
 * already use, so the tests need no vault fixture.
 */
import type { IndexPlaintext, KeyEntry } from "./format"

/** Every entry carrying exactly `label`, in index order. */
export function entriesWithLabel(index: IndexPlaintext, label: string): KeyEntry[] {
  return index.entries.filter((entry) => entry.label === label)
}

/** One duplicate set: a label and every entry that carries it, in index order. */
export interface DuplicateLabel {
  label: string
  entries: KeyEntry[]
}

/**
 * Every label more than one entry carries, in the order the first of each was created. The
 * finding `vault status --unlock` prints and `--json` carries, so an operator learns a duplicate
 * exists; `rename` is the repair (D4).
 */
export function duplicateLabels(index: IndexPlaintext): DuplicateLabel[] {
  const byLabel = new Map<string, KeyEntry[]>()
  for (const entry of index.entries) {
    const holders = byLabel.get(entry.label)
    if (holders === undefined) byLabel.set(entry.label, [entry])
    else holders.push(entry)
  }
  const out: DuplicateLabel[] = []
  for (const [label, entries] of byLabel) {
    if (entries.length > 1) out.push({ label, entries })
  }
  return out
}

/** Whether `label` holds a C0 control character (U+0000 to U+001F, so a newline or a tab among
 * them) or DEL: the characters a line-oriented output cannot carry. */
function hasControlCharacter(label: string): boolean {
  for (const char of label) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * The argument-shape rules for a label `rename` writes (D11), each answered as the usage line the
 * command prints, or `undefined` when the label is acceptable. Argument shape only: nothing here
 * looks at the vault, so every refusal is decided before the unlock.
 *
 * - empty or whitespace only: `vault status` would render it `(none)`.
 * - a newline, a tab or any C0 control character: every output here is line-oriented, and a
 *   `--labels-from` round trip splits on `\n`.
 * - beginning with `-`: it would parse as a flag everywhere a label is typed. Unreachable through
 *   argv and stated anyway, because `--labels-from` can already write one.
 *
 * No length cap: `new-key --label` enforces none today, and a cap only `rename` applied would make
 * some names creatable and not reachable-by-rename (§7 item 4).
 */
export function validateLabel(label: string): string | undefined {
  if (label.trim().length === 0) return "A key's label cannot be empty."
  if (hasControlCharacter(label)) {
    return "A key's label cannot contain a newline, a tab or a control character."
  }
  if (label.startsWith("-")) {
    return `A key's label cannot begin with "-": it would be read as a flag everywhere a label is typed.`
  }
  return undefined
}

/** How `<old>` was matched, so the refusal that follows can say what it was. */
export type RenameTargetMatch =
  | { kind: "found"; entry: KeyEntry; by: "id" | "label" | "address" }
  | { kind: "none" }
  | { kind: "ambiguous"; by: "label" | "address"; candidates: KeyEntry[] }

/**
 * Resolves the entry `rename` will write, in the order `findEntryByLabelOrAddress` already uses
 * (`promote-support.ts`): exact label first, then exact address. Label wins over address when a
 * label happens to spell one, which is the existing house behaviour. `--id` is exclusive with
 * the positional's other meanings and is matched first when given: the entry id is the one handle
 * unique by construction (`freshKeyId` and `assertKeyIdsAgree`), so it is the floor under the
 * address for a legacy store that held one address twice (D4).
 *
 * More than one match by label, or by address, is `ambiguous` with every candidate in index
 * order: the refusal lists them all, using the real count (D11, T9).
 */
export function resolveRenameTarget(index: IndexPlaintext, old: string, id?: string): RenameTargetMatch {
  if (id !== undefined) {
    const entry = index.entries.find((candidate) => candidate.id === id)
    return entry === undefined ? { kind: "none" } : { kind: "found", entry, by: "id" }
  }
  const byLabel = entriesWithLabel(index, old)
  if (byLabel.length === 1) return { kind: "found", entry: byLabel[0] as KeyEntry, by: "label" }
  if (byLabel.length > 1) return { kind: "ambiguous", by: "label", candidates: byLabel }
  const byAddress = index.entries.filter((entry) => entry.address === old)
  if (byAddress.length === 1) return { kind: "found", entry: byAddress[0] as KeyEntry, by: "address" }
  if (byAddress.length > 1) return { kind: "ambiguous", by: "address", candidates: byAddress }
  return { kind: "none" }
}
