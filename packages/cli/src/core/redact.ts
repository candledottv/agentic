/**
 * The core's redactor (BE-1665, spec K-10). Every journal row, every event a view receives and
 * every text a model sees passes through it first. Nothing equivalent existed before this: the CLI
 * only scrubbed keychain refs from its own errors, and a key once reached Discord inside an error
 * string (trading feedback 4).
 *
 * It removes three things:
 *   - the exact values the core holds (the Read key, the Write key, the device token, signer
 *     halves), registered as they are loaded, so a secret is caught whatever shape it is in;
 *   - an `api-key=` / `api_key=` / `apikey=` / `key=` URL parameter's value, and a Bearer token;
 *   - anything shaped like a Candle API key (`cndl_live_` / `cndl_test_`), held or not.
 *
 * Redaction is by replacement with {@link REDACTED}, never by dropping the field, so a reader can
 * see that something was there.
 */

export const REDACTED = "[redacted]"

/** A Candle API key, by the server's prefix rule (profiles.ts `apiKeyPrefix`). */
const API_KEY_SHAPE = /cndl_(?:live|test)_[A-Za-z0-9_-]+/g
/** `?api-key=...`, `&api_key=...`, `apikey=...`, `key=...` in a URL or query string. */
const KEY_PARAM = /([?&;](?:api[-_]?key|key|token|access_token)=)[^&\s"'#]+/gi
const BEARER = /(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi

/** Below this length a value is not registered: redacting a 3-character string would shred text. */
const MIN_SECRET_LENGTH = 8

/** Field names whose value is never written, whatever it holds (K-10: no passphrase, key or factor value). */
const FORBIDDEN_FIELDS = new Set([
  "passphrase",
  "password",
  "apikey",
  "api_key",
  "devicetoken",
  "device_token",
  "secret",
])

export class Redactor {
  private readonly secrets = new Set<string>()

  /** Registers a value the core holds. Blank and very short values are ignored. */
  add(value: string | undefined | null): void {
    if (typeof value !== "string") return
    const trimmed = value.trim()
    if (trimmed.length >= MIN_SECRET_LENGTH) this.secrets.add(trimmed)
  }

  /** Forgets a value, for a credential the core no longer holds. */
  remove(value: string): void {
    this.secrets.delete(value.trim())
  }

  text(input: string): string {
    let out = input
    // Longest first, so a secret that contains another is replaced whole.
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED)
    }
    return out.replace(API_KEY_SHAPE, REDACTED).replace(KEY_PARAM, `$1${REDACTED}`).replace(BEARER, `$1${REDACTED}`)
  }

  /** A deep copy of `value` with every string redacted and every forbidden field's value replaced. */
  value<T>(value: T): T {
    return this.walk(value, 0) as T
  }

  private walk(value: unknown, depth: number): unknown {
    if (depth > 32) return REDACTED
    if (typeof value === "string") return this.text(value)
    if (Array.isArray(value)) return value.map((item) => this.walk(item, depth + 1))
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {}
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        const lower = key.toLowerCase()
        if (FORBIDDEN_FIELDS.has(lower)) out[key] = REDACTED
        // A factor keeps its type and loses its value: that is how a typed passphrase travels in
        // `cards.approve` (K-5), and the journal records which factor was used, never what it was.
        else if (lower === "factor") out[key] = this.walk(withoutFactorValue(inner), depth + 1)
        else out[key] = this.walk(inner, depth + 1)
      }
      return out
    }
    return value
  }
}

/** Replaces a factor's value, keeping its type: `{type: "passphrase", value}` -> `{type: "passphrase"}`. */
export function withoutFactorValue(factor: unknown): unknown {
  if (factor === null || typeof factor !== "object") return factor
  const { value: _dropped, ...rest } = factor as Record<string, unknown>
  return rest
}
