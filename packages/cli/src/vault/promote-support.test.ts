/**
 * BE-296 (spec `2026-09-23-cli-vault-promote-confirm-design.md`, §6): the sentence (T1, T2), the
 * controlled-by rendering (D4), and the grep that says the old warning is gone (T17).
 */
import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { Keypair } from "@solana/web3.js"
import type { CommandContext } from "../deps"
import type { SolanaRpc } from "../solana-lite"
import {
  type ControlledBy,
  confirmPrompt,
  controlledByJson,
  promoteSentence,
  renderControlledBy,
  runRoleCheck,
  SENTENCE_PREFIX,
  shortAddress,
  subjectPhrase,
} from "./promote-support"
import { ROLE_GROUP_IDS, type SignerRolesResult, sentenceForm } from "./signer-roles"

describe("T1: the three forms, singular and plural, byte-exact against §3 D1", () => {
  const head = (subject: string) =>
    `You are about to accept a permanent copy of ${subject} in Privy's TEE: demoting will not remove it,`

  test("Form U", () => {
    expect(promoteSentence({ n: 146, form: "U", where: "below" })).toBe(
      `${head("these 146 keys")} and anything a key signs for (a multisig, a token mint, a program upgrade authority) is then only as safe as Privy.`,
    )
    expect(promoteSentence({ n: 1, form: "U", where: "above" })).toBe(
      `${head("this key")} and anything it signs for (a multisig, a token mint, a program upgrade authority) is then only as safe as Privy.`,
    )
  })

  test("Form N", () => {
    expect(promoteSentence({ n: 2, form: "N", where: "below" })).toBe(
      `${head("these 2 keys")} none of them is a token mint, freeze, program upgrade or stake authority, and any multisig they sign for (not checked) is then only as safe as Privy.`,
    )
    expect(promoteSentence({ n: 1, form: "N", where: "above" })).toBe(
      `${head("this key")} it is not a token mint, freeze, program upgrade or stake authority, and any multisig it signs for (not checked) is then only as safe as Privy.`,
    )
  })

  test("Form F: `named below` in the batch, `named above` in single promote; k agrees with its verb", () => {
    expect(promoteSentence({ n: 146, form: "F", k: 2, where: "below" })).toBe(
      `${head("these 146 keys")} and 2 of them hold a mint, freeze, upgrade or stake authority, named below, which is then only as safe as Privy.`,
    )
    expect(promoteSentence({ n: 2, form: "F", k: 1, where: "below" })).toBe(
      `${head("these 2 keys")} and 1 of them holds a mint, freeze, upgrade or stake authority, named below, which is then only as safe as Privy.`,
    )
    expect(promoteSentence({ n: 1, form: "F", k: 1, where: "above" })).toBe(
      `${head("this key")} and it holds a mint, freeze, upgrade or stake authority, named above, which is then only as safe as Privy.`,
    )
  })

  test("every form starts with the prefix and states permanence and the demote limit; the prompt and subject agree", () => {
    for (const form of ["U", "N", "F"] as const) {
      for (const n of [1, 2, 146]) {
        const sentence = promoteSentence({ n, form, k: 1, where: "below" })
        expect(sentence.startsWith(SENTENCE_PREFIX)).toBe(true)
        expect(sentence).toContain("permanent")
        expect(sentence).toContain("demoting will not remove it")
        expect(sentence.split("\n")).toHaveLength(1)
      }
    }
    expect(subjectPhrase(1)).toBe("this key")
    expect(subjectPhrase(2)).toBe("these 2 keys")
    expect(confirmPrompt(1)).toBe("Type confirm to accept this for this key: ")
    expect(confirmPrompt(146)).toBe("Type confirm to accept this for these 146 keys: ")
  })
})

describe("T2: which form", () => {
  const base: SignerRolesResult = {
    checked: [...ROLE_GROUP_IDS],
    notChecked: [],
    found: [],
    requests: 18,
    planned: 18,
    rateLimited: 0,
    elapsedMs: 0,
  }
  test("N only when all seven groups read; one failed group with no hits is U; one hit with failed groups is F", () => {
    expect(sentenceForm(base)).toBe("N")
    const oneFailed = {
      ...base,
      checked: base.checked.filter((id) => id !== "token-mint"),
      notChecked: [{ group: "token-mint" as const, reason: "HTTP 403" }],
    }
    expect(sentenceForm(oneFailed)).toBe("U")
    expect(
      sentenceForm({
        ...oneFailed,
        found: [{ address: "A", role: "staker", program: "stake", target: "S" }],
      }),
    ).toBe("F")
    expect(sentenceForm({ ...base, found: [{ address: "A", role: "mint", program: "token", target: "M" }] })).toBe("F")
  })
})

describe("D4: the controlled-by block", () => {
  const account = "FfU8M5xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx8pPD"
  const base: ControlledBy = {
    account,
    username: "Quant-",
    keyPrefix: "B6P-TSRs",
    keyLabel: "vault-promote",
    keySource: "profile",
    profileName: "production",
    apiUrl: "https://api.alpha.candle.tv",
    environment: "production",
  }

  test("the §3 D4 screen, the same key without a label, and single promote's heading", () => {
    expect(shortAddress(account)).toBe("FfU8M5…8pPD")
    expect(renderControlledBy(base, 2)).toBe(
      [
        "These 2 keys will be controlled by:",
        "  Candle account  Quant-  (FfU8M5…8pPD)",
        "  API key         B6P-TSRs…  (vault-promote)  profile production",
        "  API             https://api.alpha.candle.tv  (production)",
      ].join("\n"),
    )
    expect(renderControlledBy({ ...base, keyLabel: null }, 1)).toBe(
      [
        "This key will be controlled by:",
        "  Candle account  Quant-  (FfU8M5…8pPD)",
        "  API key         B6P-TSRs…  profile production",
        "  API             https://api.alpha.candle.tv  (production)",
      ].join("\n"),
    )
  })

  test("(no username), CANDLE_API_KEY and default credentials as sources, and a non-Candle host from an override", () => {
    const lines = renderControlledBy(
      {
        ...base,
        username: null,
        keyLabel: null,
        keySource: "env",
        profileName: undefined,
        apiUrl: "http://localhost:3005",
        environment: null,
        apiUrlFrom: "CANDLE_API_URL",
      },
      3,
    ).split("\n")
    expect(lines[1]).toBe("  Candle account  (no username)  (FfU8M5…8pPD)")
    expect(lines[2]).toBe("  API key         B6P-TSRs…  CANDLE_API_KEY")
    expect(lines[3]).toBe("  API             http://localhost:3005  (not a Candle host, from CANDLE_API_URL)")
    expect(
      renderControlledBy(
        {
          ...base,
          keySource: "default",
          profileName: undefined,
          apiUrl: "https://staging.api.candle.tv",
          environment: "staging",
          apiUrlFrom: "--api-url",
        },
        1,
      ).split("\n")[2],
    ).toBe("  API key         B6P-TSRs…  (vault-promote)  default credentials")
    expect(
      renderControlledBy(
        { ...base, apiUrl: "https://staging.api.candle.tv", environment: "staging", apiUrlFrom: "--api-url" },
        1,
      ).split("\n")[3],
    ).toBe("  API             https://staging.api.candle.tv  (staging, from --api-url)")
  })

  test("the --json shape carries exactly D9's seven keys, never the profile name", () => {
    expect(controlledByJson(base)).toEqual({
      account,
      username: "Quant-",
      keyPrefix: "B6P-TSRs",
      keyLabel: "vault-promote",
      keySource: "profile",
      apiUrl: "https://api.alpha.candle.tv",
      environment: "production",
    })
    expect(controlledByJson({ ...base, keyLabel: null, username: null, environment: null }).keyLabel).toBeNull()
  })

  test("a newline and a bidi override in the label stay on the API-key line, and --json keeps the stored value", () => {
    const keyLabel = "vault-promote\n  Candle account  attacker  (FakeAc…count)\u202e"
    const block = renderControlledBy({ ...base, keyLabel }, 2)
    const lines = block.split("\n")
    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe("These 2 keys will be controlled by:")
    expect(lines[1]).toBe("  Candle account  Quant-  (FfU8M5…8pPD)")
    expect(lines[2]).toBe(
      "  API key         B6P-TSRs…  (vault-promote Candle account attacker (FakeAc…count))  profile production",
    )
    expect(lines[3]).toBe("  API             https://api.alpha.candle.tv  (production)")
    expect(controlledByJson({ ...base, keyLabel }).keyLabel).toBe(keyLabel)
  })
})

/**
 * T17: the five-sentence warning, the batch sentence, the old prompt and the old word no longer
 * appear anywhere in the shipped source (tests excluded), so a stale copy cannot survive in a help
 * string or a comment.
 */
describe("T17: the old warning is gone from packages/cli/src", () => {
  test("no AD8_WARNING, BATCH_AD8_SENTENCE, ACK_PROMPT or EXPOSE in a non-test source file", async () => {
    const root = resolve(import.meta.dir, "..")
    const offenders: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(path)
          continue
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts") || entry.name === "test-support.ts") continue
        const src = await readFile(path, "utf8")
        for (const needle of [/AD8_WARNING/, /BATCH_AD8_SENTENCE/, /\bACK_PROMPT\b/, /\bEXPOSE\b/]) {
          if (needle.test(src)) offenders.push(`${path}: ${needle}`)
        }
      }
    }
    await walk(root)
    expect(offenders).toEqual([])
  })
})

describe("the progress ticker recomputes elapsed", () => {
  test("a second passing with nothing settled moves elapsed and left", async () => {
    const originalSetInterval = globalThis.setInterval
    const originalClearInterval = globalThis.clearInterval
    let tick: (() => void) | undefined
    globalThis.setInterval = ((fn: () => void) => {
      tick = fn
      return { unref() {} } as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval
    globalThis.clearInterval = (() => {}) as typeof clearInterval

    let now = 0
    const chunks: string[] = []
    const waiting: Array<() => void> = []
    let calls = 0
    const rpc: Pick<SolanaRpc, "getProgramAccounts"> = {
      async getProgramAccounts() {
        calls += 1
        if (calls > 1) await new Promise<void>((resolve) => waiting.push(resolve))
        return []
      },
    }
    const ctx = {
      deps: {
        now: () => now,
        sleep: async () => {},
        stderr: { write: (chunk: string) => chunks.push(chunk) },
      },
    } as unknown as CommandContext
    const pending = runRoleCheck(ctx, rpc, [Keypair.generate().publicKey.toBase58()])
    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(chunks.join("")).toContain("Checking authorities: 1 of 9 requests, 0 s elapsed")
      now = 10_000
      tick?.()
      const drawn = chunks.join("")
      expect(drawn).toContain("Checking authorities: 1 of 9 requests, 10 s elapsed, about 80 s left")
    } finally {
      for (const release of waiting.splice(0)) release()
      await pending.catch(() => {})
      globalThis.setInterval = originalSetInterval
      globalThis.clearInterval = originalClearInterval
    }
  })
})
