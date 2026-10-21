/**
 * BE-1737 (spec S5 P-2, T-15's core half): the shipped `quant` profile, the loader's refusal of
 * `canPropose: true`, and the Off switch.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentProfiles, DEFAULT_AGENT_PROFILES, parseAgentProfiles } from "./agent-profiles"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function dir() {
  const made = await mkdtemp(join(tmpdir(), "candle-agents-"))
  dirs.push(made)
  return made
}

describe("the quant profile (P-2)", () => {
  test("T-15: the default config lists quant, hosted, on the core's Read key, with canPropose false", async () => {
    expect(DEFAULT_AGENT_PROFILES).toEqual([
      {
        id: "quant",
        kind: "hosted-quant",
        dataSources: ["signals", "focused-token"],
        key: "core-read",
        canPropose: false,
        memory: "none",
        on: true,
      },
    ])
    const profiles = await AgentProfiles.open(join(await dir(), "agents.json"))
    expect(profiles.list()).toEqual([...DEFAULT_AGENT_PROFILES])
    expect(profiles.quantOn()).toBe(true)
    expect(profiles.refusedWith).toBeUndefined()
  })

  test("T-15: canPropose true for hosted-quant is refused QUANT_CANNOT_PROPOSE; a key of its own is refused too", async () => {
    expect(() => parseAgentProfiles({ profiles: [{ id: "quant", kind: "hosted-quant", canPropose: true }] })).toThrow(
      expect.objectContaining({ code: "QUANT_CANNOT_PROPOSE" }),
    )
    expect(() => parseAgentProfiles({ profiles: [{ id: "quant", kind: "hosted-quant", key: "cndl_live_x" }] })).toThrow(
      expect.objectContaining({ code: "AGENT_PROFILES_INVALID" }),
    )
    // A refused file is not used: the core runs on the defaults and reports the code.
    const d = await dir()
    await writeFile(
      join(d, "agents.json"),
      JSON.stringify({ profiles: [{ id: "quant", kind: "hosted-quant", canPropose: true, on: false }] }),
    )
    const profiles = await AgentProfiles.open(join(d, "agents.json"))
    expect(profiles.refusedWith).toBe("QUANT_CANNOT_PROPOSE")
    expect(profiles.list()[0]?.canPropose).toBe(false)
  })

  test("T-15: Off is stored (0600) and survives a restart; on again restores it", async () => {
    const d = await dir()
    const path = join(d, "agents.json")
    const profiles = await AgentProfiles.open(path)
    await profiles.setQuantOn(false)
    expect(profiles.quantOn()).toBe(false)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(path, "utf8")).profiles[0]).toMatchObject({
      id: "quant",
      on: false,
      canPropose: false,
    })
    const reopened = await AgentProfiles.open(path)
    expect(reopened.quantOn()).toBe(false)
    await reopened.setQuantOn(true)
    expect((await AgentProfiles.open(path)).quantOn()).toBe(true)
  })
})
