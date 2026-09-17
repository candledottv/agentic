/**
 * Ember Phase 2 (BE-136, CC-01, ED-1): canonical JSON, one of the four primitives the appendix
 * promises a third party needs to open a vault without this CLI.
 *
 * The rules are the spec's, and each one exists because the output is ASSOCIATED DATA, not a
 * document: two encoders that disagree by a space produce two different AEAD tags, and the
 * difference surfaces as "this vault is corrupt" rather than as a formatting nit.
 *
 *   - Keys sorted, so property order in the file cannot change the tag.
 *   - No whitespace, so a pretty-printer run over the file cannot change it either.
 *   - Integers only. A float has no single shortest representation every language agrees on, so
 *     admitting one would make the construction un-reimplementable, which is the whole point of
 *     the appendix. `generation` and the KDF parameters are the only numbers the header carries
 *     and all of them are counts.
 *   - No nulls. A null is an absent field spelled a second way, and two spellings of absent are
 *     two canonical forms of the same header.
 *
 * `undefined` is skipped exactly as `JSON.stringify` skips it, so an optional field a caller left
 * unset is absent rather than an error; an explicit `null` reaching here is a file that was
 * written by something other than this CLI, and it is refused.
 */

export type CanonicalValue = string | number | boolean | CanonicalValue[] | { [key: string]: CanonicalValue }

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CanonicalJsonError"
  }
}

/**
 * The canonical form of `value`, as a string. Throws `CanonicalJsonError` on anything the rules
 * above exclude, naming the path so a refusal points at the offending field rather than the file.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, "$")
}

/** The canonical form as UTF-8 bytes, which is what every AEAD call actually passes. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value))
}

function encode(value: unknown, path: string): string {
  if (value === null) throw new CanonicalJsonError(`null at ${path}: canonical JSON has no nulls`)
  switch (typeof value) {
    case "string":
      // JSON.stringify's string escaping is fully determined by the input, so there is nothing to
      // canonicalize: the same string always produces the same bytes.
      return JSON.stringify(value)
    case "boolean":
      return value ? "true" : "false"
    case "number":
      if (!Number.isInteger(value)) {
        throw new CanonicalJsonError(`non-integer number at ${path}: canonical JSON carries integers only`)
      }
      // Integer-valued but outside the exactly-representable range is still a float in disguise.
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalJsonError(`integer at ${path} is outside the safe range`)
      }
      // `Object.is` distinguishes -0 from 0, which stringify renders as "0" either way; refusing it
      // keeps "the same canonical string means the same value" true in both directions.
      if (Object.is(value, -0)) throw new CanonicalJsonError(`negative zero at ${path}`)
      return String(value)
    case "object":
      break
    default:
      throw new CanonicalJsonError(`${typeof value} at ${path} cannot appear in canonical JSON`)
  }

  if (Array.isArray(value)) {
    // Array order is meaningful and is preserved; it is the ONE ordering the caller owns.
    return `[${value.map((item, i) => encode(item, `${path}[${i}]`)).join(",")}]`
  }

  const record = value as Record<string, unknown>
  const parts: string[] = []
  // Sorted by UTF-16 code unit, which is what `Array.prototype.sort` does by default and what
  // every other implementation of "sort the keys" will land on for the ASCII field names this
  // format uses.
  for (const key of Object.keys(record).sort()) {
    const child = record[key]
    if (child === undefined) continue
    parts.push(`${JSON.stringify(key)}:${encode(child, `${path}.${key}`)}`)
  }
  return `{${parts.join(",")}}`
}
