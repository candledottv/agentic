/**
 * BE-259 (D9, D10): `vault new-key` checks every name it is about to write before it derives
 * anything -- the one `--label`, the defaulted `key-<index>` names, and (as before) the
 * `--labels-from` file. T14 (`--label X` taken), T15 (the computed default taken), T16 (a batch's
 * third computed name taken leaves nothing committed), plus the pure helpers the check is built on.
 *
 * The rest of `new-key`'s behaviour -- allocation, the batch, `--labels-from`'s own refusal (T17)
 * -- is pinned in `vault.test.ts` and is unchanged.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"
import { closeVault } from "../vault/store"
import { makeVault, readVaultJson, reopen, useCheapKdf } from "../vault/test-vault"
import { labelClash, plannedLabels } from "./vault-new-key"

setDefaultTimeout(60_000)
useCheapKdf()

const unreachableFetch = (async () => {
  throw new Error("no test in this file should make a network call")
}) as unknown as typeof fetch

async function fixture() {
  const made = await makeVault()
  closeVault(made.vault)
  return { dir: made.dir, path: made.path, passphrase: made.passphrase }
}

async function newKey(fx: Awaited<ReturnType<typeof fixture>>, args: string[]) {
  const stdout = createCapture()
  const stderr = createCapture()
  let prompted = 0
  const deps = createTestDeps({
    fetch: unreachableFetch,
    stdout,
    stderr,
    env: { CANDLE_CONFIG_DIR: fx.dir, HOME: fx.dir },
    isTTY: { stdin: true, stdout: true },
    promptSecret: async () => {
      prompted++
      return fx.passphrase
    },
    promptLine: async () => "no",
  })
  const code = await run(["vault", "new-key", "--chain", "solana", ...args], deps)
  return { code, stdout: stdout.text, stderr: stderr.text, prompted }
}

/** What is on disk: the entry labels in order, the counter, and the generation. */
async function state(fx: Awaited<ReturnType<typeof fixture>>) {
  const vault = await reopen(fx.path, fx.passphrase)
  try {
    return {
      labels: vault.index.entries.map((entry) => entry.label),
      counter: vault.index.hd.nextIndex.solanaVault,
      generation: (await readVaultJson(fx.path)).generation,
      blobs: vault.file.keys.length,
    }
  } finally {
    closeVault(vault)
  }
}

describe("T14: --label X refuses when X is taken, before deriving", () => {
  test("the counter, the entry list, the blob set and the generation are unchanged", async () => {
    const fx = await fixture()
    expect((await newKey(fx, ["--label", "treasury"])).code).toBe(0)
    const before = await state(fx)
    expect(before).toMatchObject({ labels: ["treasury"], counter: 1, blobs: 1 })

    const out = await newKey(fx, ["--label", "treasury"])
    expect(out.code).toBe(2)
    // The check runs against the OPENED vault, so the unlock's Argon2id line precedes it; the
    // refusal is the last thing said, and nothing after it was derived.
    expect(out.stderr).toEndWith("A key labelled treasury already exists in this vault; choose another --label.\n")
    expect(out.stdout).toBe("")
    expect(await state(fx)).toEqual(before)

    // Under --json the same refusal is the USAGE envelope, unchanged from the two shipped sites.
    const asJson = await newKey(fx, ["--label", "treasury", "--json"])
    expect(asJson.code).toBe(2)
    expect(JSON.parse(asJson.stdout)).toEqual({
      ok: false,
      code: "USAGE",
      message: "A key labelled treasury already exists in this vault; choose another --label.",
    })
    expect(await state(fx)).toEqual(before)
  })
})

describe("T15: no label refuses when the computed key-<index> is taken, before deriving", () => {
  test("a key named key-1 by hand at index 0 collides with the default name of index 1", async () => {
    const fx = await fixture()
    expect((await newKey(fx, ["--label", "key-1"])).code).toBe(0)
    const before = await state(fx)
    expect(before).toMatchObject({ labels: ["key-1"], counter: 1 })

    const out = await newKey(fx, [])
    expect(out.code).toBe(2)
    expect(out.stderr).toEndWith(
      "A key labelled key-1 already exists in this vault; pass --label <name> to choose a different name for this key.\n",
    )
    expect(await state(fx)).toEqual(before)

    // The next step the refusal names works, and the counter then moves past the collision.
    expect((await newKey(fx, ["--label", "ops"])).code).toBe(0)
    expect(await state(fx)).toMatchObject({ labels: ["key-1", "ops"], counter: 2 })
    expect((await newKey(fx, [])).code).toBe(0)
    expect(await state(fx)).toMatchObject({ labels: ["key-1", "ops", "key-2"], counter: 3 })
  })
})

describe("T16: --count checks every computed name up front", () => {
  test("a collision on the third of three leaves nothing committed", async () => {
    const fx = await fixture()
    // Index 0 is labelled by hand with the default name index 2 will get.
    expect((await newKey(fx, ["--label", "key-3"])).code).toBe(0)
    const before = await state(fx)
    expect(before).toMatchObject({ labels: ["key-3"], counter: 1, blobs: 1 })

    // The batch would be key-1, key-2, key-3: the third is taken, so none is derived.
    const out = await newKey(fx, ["--count", "3"])
    expect(out.code).toBe(2)
    expect(out.stderr).toEndWith(
      "A key labelled key-3 already exists in this vault; pass --label <name> to choose a different name for this key.\n",
    )
    // No partial-batch report either: nothing landed, so there is nothing to re-run for.
    expect(out.stderr).not.toContain("were created")
    expect(await state(fx)).toEqual(before)
  })

  test("with no collision the batch still derives every key it planned", async () => {
    const fx = await fixture()
    expect((await newKey(fx, ["--label", "treasury"])).code).toBe(0)
    expect((await newKey(fx, ["--count", "2", "--json"])).code).toBe(0)
    expect(await state(fx)).toMatchObject({ labels: ["treasury", "key-1", "key-2"], counter: 3 })
  })
})

describe("the pure helpers the check is built on", () => {
  const hd = (counter: number, exposed: number[] = []) => ({
    nextIndex: { solanaVault: counter, solanaTee: 0, solanaExternal: 0, evm: 0 },
    exposedIndexes: { solanaVault: exposed, solanaTee: [], solanaExternal: [], evm: [] },
  })

  test("plannedLabels: defaults follow the indexes the loop will claim, exposed ones skipped", () => {
    expect(plannedLabels(hd(0), { count: 3 }, undefined)).toEqual(["key-0", "key-1", "key-2"])
    // An exposed index inside the batch is skipped exactly as the loop skips it.
    expect(plannedLabels(hd(1, [2]), { count: 3 }, undefined)).toEqual(["key-1", "key-3", "key-4"])
    expect(plannedLabels(hd(5), { count: 1 }, "treasury")).toEqual(["treasury"])
    expect(plannedLabels(hd(0), { count: 2, labels: ["a", "b"] }, undefined)).toEqual(["a", "b"])
  })

  test("labelClash: the first name already in the vault, or repeated within the run", () => {
    const index = { entries: [{ label: "treasury" }, { label: "key-7" }] } as Parameters<typeof labelClash>[0]
    expect(labelClash(index, ["ops", "fees"])).toBeUndefined()
    expect(labelClash(index, ["ops", "key-7", "treasury"])).toBe("key-7")
    expect(labelClash(index, ["ops", "ops"])).toBe("ops")
    expect(labelClash({ entries: [] } as Parameters<typeof labelClash>[0], [])).toBeUndefined()
  })
})
