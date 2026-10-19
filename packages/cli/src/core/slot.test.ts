/**
 * BE-1665 (spec K-11, T-18's slot half): moving a profile's credentials into the core-only slot,
 * opening it, and what a shell without the factor is left with.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { profileSecretRef } from "../profiles"
import { SECRET_REFS } from "../secret-store"
import { createFakeConfigStore } from "../test-support"
import { closeVault } from "../vault/store"
import { type MadeVault, makeVault, useCheapKdf } from "../vault/test-vault"
import { slotExists } from "./ownership"
import { type CorePaths, corePaths, ensureCoreDir } from "./paths"
import { CoreSlotError, finishCoreMove, moveProfileToCore, openCoreSlot, readCoreSlotHeader } from "./slot"
import {
  DEVICE_TOKEN,
  inspectableStore,
  plainSeed,
  profileConfig,
  READ_KEY,
  READ_PREFIX,
  SIGNER_HALF,
  WRITE_KEY,
  WRITE_PREFIX,
} from "./test-fixtures"

beforeAll(() => useCheapKdf())

const made: MadeVault[] = []
afterEach(async () => {
  for (const m of made.splice(0)) {
    closeVault(m.vault)
    await rm(m.dir, { recursive: true, force: true })
  }
})

async function setup(profile = "staging") {
  const m = await makeVault()
  made.push(m)
  const env = { CANDLE_CONFIG_DIR: m.dir }
  const paths = corePaths(env, m.dir, profile)
  await ensureCoreDir(paths)
  const store = inspectableStore(plainSeed(profile))
  const config = createFakeConfigStore(profileConfig(profile))
  const deps = { store, readConfig: config.readConfig, updateProfile: config.updateProfile }
  return { m, env, paths, store, config, deps, profile }
}

async function move(s: Awaited<ReturnType<typeof setup>>, readKey: string | null = READ_KEY) {
  return moveProfileToCore({
    deps: s.deps,
    paths: s.paths,
    profile: s.profile,
    environment: "staging",
    vault: s.m.vault,
    readKey: readKey ?? undefined,
    now: () => 0,
  })
}

describe("moveProfileToCore", () => {
  test("T-18: a migrated default profile leaves no legacy write credentials", async () => {
    const s = await setup("default")
    // migrateProfiles copies these into the namespaced refs and retains the originals.
    await s.store.set(SECRET_REFS.deviceToken, DEVICE_TOKEN)
    await s.store.set(SECRET_REFS.apiKey, WRITE_KEY)
    await move(s)
    expect(s.store.entries()).toEqual([[profileSecretRef("default", "apiKey"), READ_KEY]])
    expect(await finishCoreMove({ deps: s.deps, paths: s.paths, profile: "default" })).toEqual([])
  })

  test("legacy credentials belonging to another identity survive both cleanup paths", async () => {
    const s = await setup("default")
    const otherToken = "other-device-token"
    await s.store.set(SECRET_REFS.deviceToken, otherToken)
    await s.store.set(SECRET_REFS.apiKey, READ_KEY)
    await move(s)
    await finishCoreMove({ deps: s.deps, paths: s.paths, profile: "default" })
    expect(await s.store.get(SECRET_REFS.deviceToken)).toBe(otherToken)
    expect(await s.store.get(SECRET_REFS.apiKey)).toBe(READ_KEY)
  })

  test("moves the Write key, device token and signer half out of the plain store, keeping only the Read key", async () => {
    const s = await setup()
    const header = await move(s)
    expect(header).toMatchObject({ profile: "staging", environment: "staging", writeKeyPrefix: WRITE_PREFIX })

    // T-18: nothing a same-user shell can read from the plain store is a write credential.
    const values = s.store.entries().map(([, value]) => value)
    for (const secret of [WRITE_KEY, DEVICE_TOKEN, SIGNER_HALF]) expect(values).not.toContain(secret)
    expect(s.store.entries()).toEqual([[profileSecretRef("staging", "apiKey"), READ_KEY]])

    // Nor is anything in the slot file readable without the vault.
    const raw = await readFile(s.paths.slot, "utf8")
    for (const secret of [WRITE_KEY, DEVICE_TOKEN, SIGNER_HALF]) expect(raw).not.toContain(secret)
    expect((await stat(s.paths.slot)).mode & 0o777).toBe(0o600)

    const profile = (await s.config.readConfig()).profiles?.staging
    expect(profile?.coreOwned).toBe(true)
    expect(profile?.keyPrefix).toBe(READ_PREFIX)
  })

  test("the core's loader opens it with the unlocked vault", async () => {
    const s = await setup()
    await move(s)
    const contents = await openCoreSlot({
      paths: s.paths,
      vault: s.m.vault,
      profile: "staging",
      environment: "staging",
    })
    expect(contents.writeKey).toBe(WRITE_KEY)
    expect(contents.deviceToken).toBe(DEVICE_TOKEN)
    expect(contents.signers).toEqual([{ ref: `key_signer_${WRITE_PREFIX}_${"a".repeat(64)}`, value: SIGNER_HALF }])
  })

  test("without the factor there is no key: a wrong DEK fails the tag, another vault is refused", async () => {
    const s = await setup()
    await move(s)
    const noFactor = { file: s.m.vault.file, dek: crypto.getRandomValues(new Uint8Array(32)) }
    await expect(
      openCoreSlot({ paths: s.paths, vault: noFactor, profile: "staging", environment: "staging" }),
    ).rejects.toMatchObject({
      code: "VAULT_BLOB_TAMPERED",
    })
    const other = await makeVault()
    made.push(other)
    await expect(
      openCoreSlot({ paths: s.paths, vault: other.vault, profile: "staging", environment: "staging" }),
    ).rejects.toMatchObject({ code: "CORE_SLOT_MISMATCH" })
  })

  test("a slot copied to another profile, or relabelled in its clear header, does not open", async () => {
    const s = await setup()
    await move(s)
    const elsewhere: CorePaths = corePaths(s.env, s.m.dir, "other")
    await mkdir(elsewhere.dir, { recursive: true })
    await cp(s.paths.slot, elsewhere.slot)
    await expect(
      openCoreSlot({ paths: elsewhere, vault: s.m.vault, profile: "other", environment: "staging" }),
    ).rejects.toMatchObject({ code: "CORE_SLOT_MISMATCH" })

    const file = JSON.parse(await readFile(s.paths.slot, "utf8"))
    await writeFile(s.paths.slot, JSON.stringify({ ...file, writeKeyPrefix: "zzzzzzzz" }))
    await expect(
      openCoreSlot({ paths: s.paths, vault: s.m.vault, profile: "staging", environment: "staging" }),
    ).rejects.toMatchObject({
      code: "VAULT_BLOB_TAMPERED",
    })
  })

  test("refuses a second move, a profile with nothing stored, and a Read key that is the Write key", async () => {
    const s = await setup()
    await expect(move(s, WRITE_KEY)).rejects.toMatchObject({ code: "CORE_SLOT_READ_KEY_IS_WRITE_KEY" })
    expect(await slotExists(s.paths)).toBe(false)
    await move(s)
    await expect(move(s)).rejects.toMatchObject({ code: "CORE_SLOT_EXISTS" })

    const empty = await setup("empty")
    for (const [ref] of empty.store.entries()) await empty.store.delete(ref)
    await expect(move(empty)).rejects.toBeInstanceOf(CoreSlotError)
  })

  test("with no Read key given, the plain store ends up holding nothing for the profile", async () => {
    const s = await setup()
    await move(s, null)
    expect(s.store.entries()).toEqual([])
  })
})

describe("finishCoreMove", () => {
  test("T-18: recovery removes migrated copies after interruption at every deletion", async () => {
    // Includes the cut after the legacy token is deleted but before the legacy key is deleted.
    for (let cut = 0; cut < 5; cut++) {
      const s = await setup("default")
      await s.store.set(SECRET_REFS.deviceToken, DEVICE_TOKEN)
      await s.store.set(SECRET_REFS.apiKey, WRITE_KEY)
      const remove = s.store.delete.bind(s.store)
      let calls = 0
      s.store.delete = async (ref) => {
        if (calls++ === cut) throw new Error("crash during cleanup")
        await remove(ref)
      }
      await expect(move(s)).rejects.toThrow("crash during cleanup")
      s.store.delete = remove
      await finishCoreMove({ deps: s.deps, paths: s.paths, profile: "default" })
      expect(s.store.entries()).toEqual([])
      const contents = await openCoreSlot({
        paths: s.paths,
        vault: s.m.vault,
        profile: "default",
        environment: "staging",
      })
      expect(contents).toMatchObject({ writeKey: WRITE_KEY, deviceToken: DEVICE_TOKEN })
    }
  })

  test("recovery recognises a legacy Write key after the profile key was replaced by the Read key", async () => {
    const s = await setup("default")
    await move(s)
    await s.store.set(SECRET_REFS.apiKey, WRITE_KEY)
    expect(await finishCoreMove({ deps: s.deps, paths: s.paths, profile: "default" })).toEqual([SECRET_REFS.apiKey])
    expect(s.store.entries()).toEqual([[profileSecretRef("default", "apiKey"), READ_KEY]])
  })

  test("removes plain copies a crash left behind, by the clear header alone, and keeps the Read key", async () => {
    const s = await setup()
    await move(s)
    // As if the process died after writing the slot and before deleting the plain items.
    await s.store.set(profileSecretRef("staging", "deviceToken"), DEVICE_TOKEN)
    await s.store.set(`key_signer_${WRITE_PREFIX}_${"a".repeat(64)}`, SIGNER_HALF)
    const removed = await finishCoreMove({ deps: s.deps, paths: s.paths, profile: "staging" })
    expect(removed.sort()).toEqual(
      [profileSecretRef("staging", "deviceToken"), `key_signer_${WRITE_PREFIX}_${"a".repeat(64)}`].sort(),
    )
    expect(s.store.entries()).toEqual([[profileSecretRef("staging", "apiKey"), READ_KEY]])

    await s.store.set(profileSecretRef("staging", "apiKey"), WRITE_KEY)
    expect(await finishCoreMove({ deps: s.deps, paths: s.paths, profile: "staging" })).toEqual([
      profileSecretRef("staging", "apiKey"),
    ])
  })

  test("is a no-op without a slot", async () => {
    const s = await setup()
    expect(await finishCoreMove({ deps: s.deps, paths: s.paths, profile: "staging" })).toEqual([])
    expect(await readCoreSlotHeader(s.paths)).toBeUndefined()
  })
})
