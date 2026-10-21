/**
 * The agent profiles the core ships (BE-1737, spec S5 P-2): one entry, `quant`, so Quant shows in
 * the Agents tab beside the bundled agent and any harness.
 *
 *   { "id": "quant", "kind": "hosted-quant", "dataSources": ["signals", "focused-token"],
 *     "key": "core-read", "canPropose": false, "memory": "none", "on": true }
 *
 * - `key: "core-read"`: Quant uses the core's Read key (Q-1). It has no key of its own and cannot
 *   be given one: any other value is refused.
 * - `canPropose: false`: Quant has no card tools (section K). The loader refuses `canPropose: true`
 *   for `hosted-quant` with `QUANT_CANNOT_PROPOSE`.
 * - `memory: "none"`: S3 decides when Quant may read memory.
 * - `on`: the Agents tab's Off switch. Off hides Quant from the drawer and first run, and the core
 *   refuses `quant.send` with `QUANT_OFF`.
 *
 * Stored in `<state dir>/agents.json` (0600), written atomically. A file the loader refuses is not
 * used: the core runs on the defaults and reports the refusal's code in `settings.get`.
 */
import { randomBytes } from "node:crypto"
import { readFile, rename, writeFile } from "node:fs/promises"

export interface QuantProfile {
  id: "quant"
  kind: "hosted-quant"
  dataSources: ("signals" | "focused-token")[]
  key: "core-read"
  canPropose: false
  memory: "none"
  on: boolean
}

export type AgentProfileEntry = QuantProfile

export const DEFAULT_QUANT_PROFILE: QuantProfile = {
  id: "quant",
  kind: "hosted-quant",
  dataSources: ["signals", "focused-token"],
  key: "core-read",
  canPropose: false,
  memory: "none",
  on: true,
}

export const DEFAULT_AGENT_PROFILES: readonly AgentProfileEntry[] = [DEFAULT_QUANT_PROFILE]

export class AgentProfileError extends Error {
  constructor(
    readonly code: "QUANT_CANNOT_PROPOSE" | "AGENT_PROFILES_INVALID",
    message: string,
  ) {
    super(message)
    this.name = "AgentProfileError"
  }
}

/** Reads `agents.json`'s `profiles`. Throws {@link AgentProfileError} for a profile the core will not run. */
export function parseAgentProfiles(raw: unknown): AgentProfileEntry[] {
  const profiles = (raw as { profiles?: unknown } | null)?.profiles
  if (!Array.isArray(profiles)) throw new AgentProfileError("AGENT_PROFILES_INVALID", "profiles must be a list.")
  const out: AgentProfileEntry[] = []
  for (const entry of profiles) {
    const p = entry as Record<string, unknown> | null
    if (p === null || typeof p !== "object")
      throw new AgentProfileError("AGENT_PROFILES_INVALID", "A profile is an object.")
    if (p.kind !== "hosted-quant" || p.id !== "quant")
      throw new AgentProfileError("AGENT_PROFILES_INVALID", "This version knows one profile: quant, kind hosted-quant.")
    if (p.canPropose !== undefined && p.canPropose !== false) {
      throw new AgentProfileError(
        "QUANT_CANNOT_PROPOSE",
        "Quant cannot propose cards: it answers in text, and only you start a card. Set canPropose to false.",
      )
    }
    if (p.key !== undefined && p.key !== "core-read")
      throw new AgentProfileError("AGENT_PROFILES_INVALID", "Quant uses the core's Read key and cannot be given a key.")
    if (p.memory !== undefined && p.memory !== "none")
      throw new AgentProfileError("AGENT_PROFILES_INVALID", "Quant reads no memory in this version.")
    if (p.on !== undefined && typeof p.on !== "boolean")
      throw new AgentProfileError("AGENT_PROFILES_INVALID", "on is true or false.")
    out.push({ ...DEFAULT_QUANT_PROFILE, on: p.on !== false })
  }
  if (!out.some((profile) => profile.id === "quant")) out.push({ ...DEFAULT_QUANT_PROFILE })
  return out
}

export class AgentProfiles {
  private constructor(
    private readonly path: string,
    private profiles: AgentProfileEntry[],
    /** The code a refused file was refused with; the core runs on the defaults meanwhile. */
    readonly refusedWith: AgentProfileError["code"] | undefined,
  ) {}

  static async open(path: string): Promise<AgentProfiles> {
    let text: string
    try {
      text = await readFile(path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      return new AgentProfiles(
        path,
        DEFAULT_AGENT_PROFILES.map((p) => ({ ...p })),
        undefined,
      )
    }
    try {
      return new AgentProfiles(path, parseAgentProfiles(JSON.parse(text)), undefined)
    } catch (error) {
      const code = error instanceof AgentProfileError ? error.code : "AGENT_PROFILES_INVALID"
      return new AgentProfiles(
        path,
        DEFAULT_AGENT_PROFILES.map((p) => ({ ...p })),
        code,
      )
    }
  }

  list(): AgentProfileEntry[] {
    return this.profiles.map((profile) => ({ ...profile }))
  }

  quantOn(): boolean {
    return this.profiles.find((profile) => profile.id === "quant")?.on !== false
  }

  /** The Agents tab's Off switch. */
  async setQuantOn(on: boolean): Promise<void> {
    this.profiles = this.profiles.map((profile) => (profile.id === "quant" ? { ...profile, on } : profile))
    const temp = `${this.path}.tmp-${randomBytes(6).toString("base64url")}`
    await writeFile(temp, `${JSON.stringify({ profiles: this.profiles }, null, 2)}\n`, { mode: 0o600, flag: "wx" })
    await rename(temp, this.path)
  }
}
