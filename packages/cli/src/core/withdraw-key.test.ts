/**
 * BE-1680 (spec S4 W-1 to W-3, T4-11's slot and call-site halves): the Withdraw key in the core
 * slot. Only the transfer path receives it; every other open of the slot drops it, wipes the
 * plaintext and keeps no reference; and in the shipped source exactly one credential path returns
 * it. The end-to-end half (every frame, event and journal line through mint, transfer and revoke)
 * is in `commands/core-s4.test.ts`.
 */
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { readFileSync } from "node:fs"
import { readFile, rm } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { sourceFiles, withoutComments } from "../import-scan"
import { createFakeConfigStore } from "../test-support"
import * as hygiene from "../vault/hygiene"
import { closeVault } from "../vault/store"
import { type MadeVault, makeVault, useCheapKdf } from "../vault/test-vault"
import { corePaths, ensureCoreDir } from "./paths"
import { moveProfileToCore, openCoreSlot, resealCoreSlot } from "./slot"
import { inspectableStore, plainSeed, profileConfig, READ_KEY, WRITE_KEY } from "./test-fixtures"
import type { TradingCredentials } from "./trading"

const WITHDRAW_KEY = `cndl_test_${"x".repeat(43)}`

beforeAll(() => useCheapKdf())

const made: MadeVault[] = []
afterEach(async () => {
  for (const m of made.splice(0)) {
    closeVault(m.vault)
    await rm(m.dir, { recursive: true, force: true })
  }
})

async function slotWithWithdrawKey() {
  const m = await makeVault()
  made.push(m)
  const env = { CANDLE_CONFIG_DIR: m.dir }
  const paths = corePaths(env, m.dir, "staging")
  await ensureCoreDir(paths)
  const config = createFakeConfigStore(profileConfig("staging"))
  const deps = {
    store: inspectableStore(plainSeed("staging")),
    readConfig: config.readConfig,
    updateProfile: config.updateProfile,
  }
  await moveProfileToCore({
    deps,
    paths,
    profile: "staging",
    environment: "staging",
    vault: m.vault,
    readKey: READ_KEY,
    now: () => 0,
  })
  await resealCoreSlot({
    paths,
    vault: m.vault,
    profile: "staging",
    environment: "staging",
    withdrawKey: WITHDRAW_KEY,
    now: () => 1,
  })
  return { m, paths }
}

describe("W-1 and W-3: the Withdraw key in the slot", () => {
  test("re-sealing adds it under the vault: the file never holds it in clear", async () => {
    const { paths } = await slotWithWithdrawKey()
    const raw = await readFile(paths.slot, "utf8")
    expect(raw).not.toContain(WITHDRAW_KEY)
    expect(raw).not.toContain(WRITE_KEY)
  })

  test("only the transfer purpose returns it; the trading open drops it and wipes the plaintext", async () => {
    const { m, paths } = await slotWithWithdrawKey()
    const transfer = await openCoreSlot({
      paths,
      vault: m.vault,
      profile: "staging",
      environment: "staging",
      purpose: "transfer",
    })
    expect(transfer.withdrawKey).toBe(WITHDRAW_KEY)
    const wipe = spyOn(hygiene, "wipe")
    try {
      const trading = await openCoreSlot({
        paths,
        vault: m.vault,
        profile: "staging",
        environment: "staging",
        purpose: "trading",
      })
      expect(Object.keys(trading).sort()).toEqual(["deviceToken", "signers", "writeKey"])
      expect(JSON.stringify(trading)).not.toContain(WITHDRAW_KEY)
      // The decrypted plaintext held the key; it is zeroed before the open returns.
      expect(wipe).toHaveBeenCalled()
      const wiped = wipe.mock.calls.at(-1)?.[0] as Uint8Array
      expect(wiped.every((byte) => byte === 0)).toBe(true)
    } finally {
      wipe.mockRestore()
    }
    // The default purpose is trading.
    const unspecified = await openCoreSlot({ paths, vault: m.vault, profile: "staging", environment: "staging" })
    expect(unspecified).not.toHaveProperty("withdrawKey")
  })

  test("turning off re-seals without it, and everything else in the slot is unchanged", async () => {
    const { m, paths } = await slotWithWithdrawKey()
    await resealCoreSlot({
      paths,
      vault: m.vault,
      profile: "staging",
      environment: "staging",
      withdrawKey: undefined,
      now: () => 2,
    })
    const transfer = await openCoreSlot({
      paths,
      vault: m.vault,
      profile: "staging",
      environment: "staging",
      purpose: "transfer",
    })
    expect(transfer).not.toHaveProperty("withdrawKey")
    expect(transfer.writeKey).toBe(WRITE_KEY)
  })
})

describe("T4-11's call-site half: one credential path returns the Withdraw key", () => {
  const srcDir = resolve(import.meta.dir, "..")
  const shipped = sourceFiles(srcDir).filter(
    (file) => !file.endsWith(".test.ts") && !file.endsWith("test-kit.ts") && !file.endsWith("test-fixtures.ts"),
  )
  const read = (file: string) => withoutComments(readFileSync(file, "utf8"))

  test("TradingCredentials, what windows, paper and every other kind get, has no withdrawKey", () => {
    const noWithdrawKey: "withdrawKey" extends keyof TradingCredentials ? false : true = true
    expect(noWithdrawKey).toBe(true)
  })

  test("openTransferSlot is called only inside TradingState.withTransferCredentials", () => {
    const calls = shipped.flatMap((file) =>
      [...read(file).matchAll(/\.openTransferSlot\(/g)].map(() => relative(srcDir, file)),
    )
    expect(calls).toEqual(["core/trading.ts"])
    const trading = read(resolve(srcDir, "core/trading.ts"))
    const start = trading.indexOf("async withTransferCredentials")
    const end = trading.indexOf("async withVaultSigner")
    const call = trading.indexOf(".openTransferSlot(")
    expect(start).toBeGreaterThan(-1)
    expect(call > start && call < end).toBe(true)
  })

  test("the slot's transfer purpose is asked for only by the transfer slot open and the re-seal", () => {
    const users = shipped.flatMap((file) =>
      [...read(file).matchAll(/purpose: "transfer"/g)].map(() => relative(srcDir, file)),
    )
    expect(users.sort()).toEqual(["commands/core.ts", "core/slot.ts"])
  })
})
