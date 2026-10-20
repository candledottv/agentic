/**
 * Who may attach, and as what (BE-1665, spec A-2). The role is a property of the token, never
 * something a client claims.
 *
 *   - `view`: one random token per core start, held in memory only. The launcher receives it once
 *     through an inherited file descriptor (`candle core serve --view-token-fd <n>`); it is never
 *     written to disk, so a core a harness started for itself has no view anyone can attach as.
 *   - `harness`: minted per registration from a view (`harness.register`), shown to the user once,
 *     stored by the core only as a SHA-256 hash in `tokens.json` (0600). Revocable.
 *   - `observer`: reserved, never issued in S1.
 *
 * A harness token is `cht_<tokenId>_<secret>`. The id is public (it names the token in the Agents
 * tab and in `harness.revoke`); the secret is 32 random bytes.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { chmod, readFile, rename, writeFile } from "node:fs/promises"
import { terminalText } from "../render"

export type Role = "view" | "harness"

export interface HarnessTokenRecord {
  tokenId: string
  name: string
  /** Lowercase hex SHA-256 of the whole token. */
  hash: string
  createdAt: string
  revokedAt?: string
}

/** What `clients.list` and the Agents tab may see of a token: never its hash. */
export type HarnessTokenInfo = Omit<HarnessTokenRecord, "hash">

export type Authenticated = { role: "view" } | { role: "harness"; tokenId: string; name: string }

const HARNESS_PREFIX = "cht_"
const TOKEN_ID = /^[A-Za-z0-9]{12}$/

function b64u(bytes: Buffer): string {
  return bytes.toString("base64url")
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex")
  const right = Buffer.from(b, "hex")
  return left.length === right.length && timingSafeEqual(left, right)
}

function freshTokenId(): string {
  // 12 alphanumerics: a base64url draw with the two symbols filtered out.
  for (;;) {
    const id = b64u(randomBytes(16)).replace(/[-_]/g, "").slice(0, 12)
    if (TOKEN_ID.test(id)) return id
  }
}

/** A harness name as the Agents tab will draw it: control characters stripped, 1 to 64 characters. */
export function cleanHarnessName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined
  const clean = terminalText(name).trim()
  return clean.length >= 1 && clean.length <= 64 ? clean : undefined
}

export class TokenBook {
  /** The view token for this core's life. Never persisted. */
  readonly viewToken: string

  private constructor(
    private readonly path: string,
    private records: HarnessTokenRecord[],
    private readonly now: () => number,
  ) {
    this.viewToken = `chv_${b64u(randomBytes(32))}`
  }

  static async open(path: string, now: () => number): Promise<TokenBook> {
    let records: HarnessTokenRecord[] = []
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as { harness?: unknown }
      if (Array.isArray(parsed.harness)) {
        records = parsed.harness.filter(
          (r): r is HarnessTokenRecord =>
            r !== null &&
            typeof r === "object" &&
            typeof (r as HarnessTokenRecord).tokenId === "string" &&
            typeof (r as HarnessTokenRecord).hash === "string" &&
            typeof (r as HarnessTokenRecord).name === "string",
        )
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    return new TokenBook(path, records, now)
  }

  authenticate(token: unknown): Authenticated | undefined {
    if (typeof token !== "string" || token.length === 0 || token.length > 256) return undefined
    if (token.startsWith("chv_")) {
      const presented = sha256Hex(token)
      return sameHex(presented, sha256Hex(this.viewToken)) ? { role: "view" } : undefined
    }
    if (!token.startsWith(HARNESS_PREFIX)) return undefined
    const tokenId = token.slice(HARNESS_PREFIX.length, HARNESS_PREFIX.length + 12)
    const record = this.records.find((r) => r.tokenId === tokenId && r.revokedAt === undefined)
    if (record === undefined || !sameHex(sha256Hex(token), record.hash)) return undefined
    return { role: "harness", tokenId: record.tokenId, name: record.name }
  }

  /** Mints a harness token. The returned `token` exists nowhere else: the book keeps its hash. */
  async mintHarness(name: string): Promise<{ token: string; info: HarnessTokenInfo }> {
    const tokenId = freshTokenId()
    const token = `${HARNESS_PREFIX}${tokenId}_${b64u(randomBytes(32))}`
    const record: HarnessTokenRecord = {
      tokenId,
      name,
      hash: sha256Hex(token),
      createdAt: new Date(this.now()).toISOString(),
    }
    await this.persist([...this.records, record])
    return { token, info: infoOf(record) }
  }

  /** Revokes a token. Returns false for an id that is unknown or already revoked. */
  async revoke(tokenId: string): Promise<boolean> {
    const index = this.records.findIndex((r) => r.tokenId === tokenId && r.revokedAt === undefined)
    if (index === -1) return false
    const next = [...this.records]
    next[index] = { ...(next[index] as HarnessTokenRecord), revokedAt: new Date(this.now()).toISOString() }
    await this.persist(next)
    return true
  }

  list(): HarnessTokenInfo[] {
    return this.records.map(infoOf)
  }

  private async persist(records: HarnessTokenRecord[]): Promise<void> {
    const temp = `${this.path}.tmp-${b64u(randomBytes(6))}`
    await writeFile(temp, `${JSON.stringify({ version: 1, harness: records }, null, 2)}\n`, { mode: 0o600, flag: "wx" })
    await chmod(temp, 0o600)
    await rename(temp, this.path)
    this.records = records
  }
}

function infoOf(record: HarnessTokenRecord): HarnessTokenInfo {
  const { hash: _hash, ...info } = record
  return info
}
