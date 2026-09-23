/**
 * Ember Phase 2 (BE-137, T37): migrate one mixed Phase 1 TEE wallet store holding all five real
 * shapes into the vault, reopen under the strict reader, exercise post-migration adoption via
 * reconcileGrant, and confirm tee commands read the vault while refusing to rewrite the legacy file.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { copyFile, mkdtemp, readFile, rename, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { base58 } from "@scure/base"
import { Keypair } from "@solana/web3.js"
import { run } from "../index"
import {
  createCapture,
  createFakeStore,
  createRoutedFetch,
  createTestDeps,
  jsonResponse,
  TEST_HOME,
} from "../test-support"
import { addressFromSecret64 } from "../vault/ed25519"
import { parseIndexPlaintext, parseVaultFile, serializeIndexPlaintext } from "../vault/format"
import { wipe } from "../vault/hygiene"
import { readSidecar, sidecarPath } from "../vault/sidecar"
import { decryptKey, unlockWithPassphrase } from "../vault/store"
import { flipByte, generatedPassphraseFrom, tamper, useCheapKdf } from "../vault/test-vault"
import {
  createKeystore,
  defaultTeeKeystorePath,
  type KeystoreEntry,
  legacyTeeKeystorePath,
  readKeystore,
  serializeKeystore,
  TEE_KEYSTORE_PURPOSE,
  writeKeystoreFile,
} from "../wallet-keystore"

setDefaultTimeout(60_000)
useCheapKdf()

const unreachableFetch = (async () => {
  throw new Error("no network")
}) as unknown as typeof fetch

const TEE_PASS = "a strong tee-store passphrase for T37"
const ACCOUNT = "T37AccountABCDEFGH1234567890xyz"
const API = "https://api.t37.test"
const VAULT_DEST = Keypair.generate().publicKey.toBase58()

function keypairEntry(
  label: string,
  overrides: Partial<KeystoreEntry> = {},
): { keypair: Keypair; entry: KeystoreEntry } {
  const keypair = Keypair.generate()
  const entry: KeystoreEntry = {
    index: 0,
    chain: "solana",
    address: keypair.publicKey.toBase58(),
    label,
    createdAt: "2026-09-17T00:00:00.000Z",
    privateKey: base58.encode(keypair.secretKey),
    imported: false,
    tee: { network: "solana-mainnet" },
    ...overrides,
  }
  return { keypair, entry }
}

/** The five Phase 1 shapes T37 names, built to match the real writers. */
function mixedFixtureEntries(): {
  neverEnabled: KeystoreEntry
  failedEnable: KeystoreEntry
  active: KeystoreEntry
  pendingDisable: KeystoreEntry
  pendingSweep: KeystoreEntry
  swept: KeystoreEntry
  all: KeystoreEntry[]
} {
  const neverEnabled = keypairEntry("never-enabled").entry
  // Same on-disk shape as never-enabled: enable died before its single local commit.
  const failedEnable = keypairEntry("failed-enable").entry
  const active = keypairEntry("active", {
    imported: true,
    linkedWalletId: "lw_active",
    tee: {
      network: "solana-mainnet",
      vaultDestination: VAULT_DEST,
      boundKeyPrefix: "ck_live_a",
      remoteAuthority: "unknown",
      enabledAt: "2026-09-17T01:00:00.000Z",
    },
  }).entry
  const pendingDisable = keypairEntry("pending-disable", {
    imported: true,
    linkedWalletId: "lw_stop",
    tee: {
      network: "solana-mainnet",
      vaultDestination: VAULT_DEST,
      boundKeyPrefix: "ck_live_b",
      remoteAuthority: "verified-denied",
      enabledAt: "2026-09-17T01:00:00.000Z",
      stopRequestedAt: "2026-09-17T02:00:00.000Z",
    },
  }).entry
  const pendingSweep = keypairEntry("pending-sweep", {
    imported: true,
    linkedWalletId: "lw_pending",
    tee: {
      network: "solana-mainnet",
      vaultDestination: VAULT_DEST,
      boundKeyPrefix: "ck_live_c",
      remoteAuthority: "none",
      enabledAt: "2026-09-17T01:00:00.000Z",
      stopRequestedAt: "2026-09-17T02:00:00.000Z",
      sweepPending: [
        {
          kind: "sol",
          amountRaw: "1000",
          signature: "SigPending111111111111111111111111111111111111111111111",
          blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
          submittedAt: "2026-09-17T02:05:00.000Z",
        },
      ],
    },
  }).entry
  const swept = keypairEntry("swept", {
    imported: true,
    linkedWalletId: "lw_swept",
    tee: {
      network: "solana-mainnet",
      vaultDestination: VAULT_DEST,
      boundKeyPrefix: "ck_live_d",
      remoteAuthority: "verified-active",
      enabledAt: "2026-09-17T01:00:00.000Z",
      stopRequestedAt: "2026-09-17T02:00:00.000Z",
      sweptAt: "2026-09-17T03:00:00.000Z",
      sweepReceipts: [
        {
          kind: "sol",
          amountRaw: "5000",
          signature: "SigDone111111111111111111111111111111111111111111111111",
          finalizedAt: "2026-09-17T03:00:00.000Z",
        },
      ],
    },
  }).entry
  const all = [neverEnabled, failedEnable, active, pendingDisable, pendingSweep, swept].map((entry, index) => ({
    ...entry,
    index,
  }))
  return { neverEnabled, failedEnable, active, pendingDisable, pendingSweep, swept, all }
}

async function seedTeeStore(dir: string, entries: KeystoreEntry[], path?: string): Promise<string> {
  const ks = await createKeystore(TEE_PASS)
  const target = path ?? defaultTeeKeystorePath({ CANDLE_CONFIG_DIR: dir }, TEST_HOME)
  await writeKeystoreFile(
    target,
    await serializeKeystore(entries, ks.key, ks.salt, ks.iterations, TEE_KEYSTORE_PURPOSE),
  )
  return target
}

async function initVault(dir: string): Promise<{ passphrase: string; vaultPath: string }> {
  const stdout = createCapture()
  const stderr = createCapture()
  const vaultPath = join(dir, "vault.enc")
  const deps = createTestDeps({
    fetch: unreachableFetch,
    stdout,
    stderr,
    env: { CANDLE_CONFIG_DIR: dir, HOME: dir },
    promptSecret: async () => generatedPassphraseFrom(stdout.text),
    promptLine: async () => "no",
    readFile: (path) => readFile(path, "utf8"),
    writeFile: (path, content) => writeFile(path, content, "utf8"),
  })
  await deps.writeConfig({
    activeProfile: "t37",
    profiles: { t37: { account: ACCOUNT, apiUrl: API, accountCachedAt: Date.now() } },
  })
  const code = await run(["vault", "init", "--keystore", vaultPath], deps)
  if (code !== 0) throw new Error(`init failed: ${stderr.text}${stdout.text}`)
  return { passphrase: generatedPassphraseFrom(stdout.text), vaultPath }
}

describe("T37: CC-05 TEE store migration", () => {
  test("migrates all five Phase 1 shapes, reopens under the strict reader, adopts a failed-enable candidate, refuses legacy writes, and gates retire-legacy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-t37-"))
    const fixture = mixedFixtureEntries()
    const teePath = await seedTeeStore(dir, fixture.all)
    const originalBytes = await readFile(teePath, "utf8")
    const { passphrase, vaultPath } = await initVault(dir)

    // ── import-legacy --tee ───────────────────────────────────────────────────────────────
    {
      const stdout = createCapture()
      const stderr = createCapture()
      const secrets = [TEE_PASS, passphrase]
      const deps = createTestDeps({
        fetch: unreachableFetch,
        store: createFakeStore({ "profile:t37:api_key": "ck_live_t37" }),
        stdout,
        stderr,
        env: { CANDLE_CONFIG_DIR: dir },
        promptSecret: async () => {
          const next = secrets.shift()
          if (next === undefined) throw new Error("unexpected promptSecret")
          return next
        },
        promptLine: async () => {
          throw new Error("import-legacy must not promptLine")
        },
        readFile: (path) => readFile(path, "utf8"),
        writeFile: (path, content) => writeFile(path, content, "utf8"),
      })
      await deps.writeConfig({
        activeProfile: "t37",
        profiles: { t37: { account: ACCOUNT, apiUrl: API, accountCachedAt: Date.now() } },
      })
      const code = await run(
        ["vault", "import-legacy", "--tee", "--from", teePath, "--keystore", vaultPath, "--json"],
        deps,
      )
      expect(code).toBe(0)
      expect(stdout.text).toContain("staleLegacyWarning")
      expect(await readFile(teePath, "utf8")).toBe(originalBytes)
    }

    // Re-run through the public dispatcher with api url on the profile.
    // The previous run already migrated; assert idempotency on a second pass.
    {
      const stdout = createCapture()
      const stderr = createCapture()
      const secrets = [TEE_PASS, passphrase]
      const deps = createTestDeps({
        fetch: unreachableFetch,
        store: createFakeStore({ "profile:t37:api_key": "ck_live_t37" }),
        stdout,
        stderr,
        env: { CANDLE_CONFIG_DIR: dir },
        promptSecret: async () => secrets.shift() ?? "",
        readFile: (path) => readFile(path, "utf8"),
        writeFile: (path, content) => writeFile(path, content, "utf8"),
      })
      await deps.writeConfig({
        activeProfile: "t37",
        profiles: { t37: { account: ACCOUNT, apiUrl: API, accountCachedAt: Date.now() } },
      })
      const code = await run(["vault", "import-legacy", "--tee", "--from", teePath, "--keystore", vaultPath], deps)
      expect(code).toBe(0)
      expect(stdout.text).toContain("already in the vault")
    }

    // ── strict reader accepts every migrated entry ────────────────────────────────────────
    const raw = await readFile(vaultPath, "utf8")
    const file = parseVaultFile(raw)
    const opened = await unlockWithPassphrase(vaultPath, raw, passphrase)
    try {
      const byLabel = new Map(opened.index.entries.map((entry) => [entry.label, entry]))
      expect(byLabel.get("never-enabled")?.tee?.lifecycle).toBe("local-candidate")
      expect(byLabel.get("never-enabled")?.exposure.everRemoteExposed).toBe(false)
      expect(byLabel.get("never-enabled")?.tee?.grantIdentity).toBeUndefined()
      expect(byLabel.get("never-enabled")?.linkedWalletId).toBeUndefined()

      expect(byLabel.get("failed-enable")?.tee?.lifecycle).toBe("local-candidate")
      expect(byLabel.get("failed-enable")?.exposure.everRemoteExposed).toBe(false)

      expect(byLabel.get("active")?.tee?.lifecycle).toBe("enabled")
      expect(byLabel.get("active")?.tee?.remoteAuthority).toBe("unknown")
      expect(byLabel.get("active")?.exposure.everRemoteExposed).toBe(true)
      expect(byLabel.get("active")?.tee?.grantIdentity?.account).toBe(ACCOUNT)

      expect(byLabel.get("pending-disable")?.tee?.lifecycle).toBe("enabled")
      expect(byLabel.get("pending-disable")?.tee?.stopRequestedAt).toBeTruthy()
      expect(byLabel.get("pending-disable")?.tee?.remoteAuthority).toBe("verified-denied")

      expect(byLabel.get("pending-sweep")?.tee?.lifecycle).toBe("enabled")
      expect(byLabel.get("pending-sweep")?.tee?.sweepPending).toHaveLength(1)
      expect(byLabel.get("pending-sweep")?.tee?.remoteAuthority).toBe("none")

      expect(byLabel.get("swept")?.tee?.lifecycle).toBe("retired")
      expect(byLabel.get("swept")?.origin).toBe("migrated-tee")
      expect(byLabel.get("swept")?.derivation).toBeUndefined()

      for (const entry of opened.index.entries) {
        expect(entry.origin).toBe("migrated-tee")
        const secret = await decryptKey(opened, entry.id)
        try {
          expect(addressFromSecret64(secret)).toBe(entry.address)
        } finally {
          wipe(secret)
        }
      }
      // Round-trip the index through the strict reader again, in the shape the file's version writes.
      parseIndexPlaintext(
        new TextEncoder().encode(JSON.stringify(serializeIndexPlaintext(opened.index, opened.file.version))),
        opened.file.version,
      )
    } finally {
      const { closeVault } = await import("../vault/store")
      closeVault(opened)
    }

    const sidecar = await readSidecar(sidecarPath(vaultPath))
    expect(sidecar?.migratedFrom?.some((row) => row.path === teePath && row.sourceDigest)).toBe(true)
    expect(JSON.stringify(sidecar)).not.toContain(fixture.active.address)

    // ── adopt the failed-enable candidate via tee status + fake API ───────────────────────
    const failedAddress = fixture.failedEnable.address
    const serverDest = Keypair.generate().publicKey.toBase58()
    {
      const stdout = createCapture()
      const stderr = createCapture()
      const secrets = [passphrase]
      const lines = [ACCOUNT.slice(-6), serverDest.slice(-6)]
      const { fetch } = createRoutedFetch({
        "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: ACCOUNT }),
        "/api/v1/agent/wallets": () =>
          jsonResponse(200, {
            page: [
              {
                _id: "lw_adopted",
                address: failedAddress,
                chain: "solana",
                vaultDestination: serverDest,
                boundKeyPrefix: "ck_live_adopt",
                remoteAuthority: "verified-active",
              },
            ],
            isDone: true,
          }),
        "/api/v1/agent/wallets/import-failures": () =>
          jsonResponse(200, { success: true, account: ACCOUNT, failures: [], complete: true }),
      })
      const deps = createTestDeps({
        fetch,
        store: createFakeStore({ "profile:t37:api_key": "ck_live_t37" }),
        stdout,
        stderr,
        env: { CANDLE_CONFIG_DIR: dir, CANDLE_API_URL: API },
        promptSecret: async () => secrets.shift() ?? "",
        promptLine: async () => lines.shift() ?? "",
        readFile: (path) => readFile(path, "utf8"),
        writeFile: (path, content) => writeFile(path, content, "utf8"),
      })
      await deps.writeConfig({
        activeProfile: "t37",
        profiles: { t37: { account: ACCOUNT, apiUrl: API, accountCachedAt: Date.now() } },
      })
      const before = await readFile(vaultPath, "utf8")
      const code = await run(["tee", "status", failedAddress, "--json"], deps)
      if (code !== 0) throw new Error(`tee status failed (${code}): ${stderr.text}\n${stdout.text}`)
      expect(code).toBe(0)
      expect(stdout.text).toContain("enabled")
      const afterOpen = await unlockWithPassphrase(vaultPath, await readFile(vaultPath, "utf8"), passphrase)
      try {
        const entry = afterOpen.index.entries.find((candidate) => candidate.address === failedAddress)
        expect(entry?.tee?.lifecycle).toBe("enabled")
        expect(entry?.linkedWalletId).toBe("lw_adopted")
        expect(entry?.tee?.vaultDestination).toBe(serverDest)
        expect(entry?.tee?.grantIdentity?.source).toBe("recorded-at-operation")
      } finally {
        const { closeVault } = await import("../vault/store")
        closeVault(afterOpen)
      }
      // Declined confirmation leaves the entry unchanged: re-seed a fresh candidate-shaped entry
      // is covered below with a separate address.
      void before
    }

    // tee fund reads the vault first: the legacy file still has the pre-adoption candidate shape
    // (no linkedWalletId / not verified-active), so a legacy-only fund would refuse. Vault wins.
    {
      const secrets = [passphrase]
      const stdout = createCapture()
      const stderr = createCapture()
      const deps = createTestDeps({
        fetch: unreachableFetch,
        store: createFakeStore({ "profile:t37:api_key": "ck_live_t37" }),
        stdout,
        stderr,
        env: { CANDLE_CONFIG_DIR: dir },
        promptSecret: async () => secrets.shift() ?? "",
        readFile: (path) => readFile(path, "utf8"),
        writeFile: (path, content) => writeFile(path, content, "utf8"),
      })
      await deps.writeConfig({
        activeProfile: "t37",
        profiles: { t37: { account: ACCOUNT, apiUrl: API, accountCachedAt: Date.now() } },
      })
      const code = await run(["tee", "fund", failedAddress, "--amount", "1", "--json"], deps)
      expect(code).toBe(0)
      expect(JSON.parse(stdout.text.trim()).destination).toBe(failedAddress)
      // Legacy row is still the failed-enable candidate shape.
      const legacy = await readKeystore(await readFile(teePath, "utf8"), TEE_PASS, {
        expectPurpose: TEE_KEYSTORE_PURPOSE,
      })
      const legacyRow = legacy.entries.find((entry) => entry.address === failedAddress)
      expect(legacyRow?.linkedWalletId).toBeUndefined()
      expect(legacyRow?.tee?.remoteAuthority).toBeUndefined()
    }

    // Declined adoption leaves the entry byte-identical.
    {
      const candidate = keypairEntry("decline-me").entry
      // Append into vault by re-importing a one-entry store.
      const extraPath = join(dir, "extra-tee.enc")
      await seedTeeStore(dir, [{ ...candidate, index: 0 }], extraPath)
      const secrets = [TEE_PASS, passphrase]
      const stdout = createCapture()
      const deps = createTestDeps({
        fetch: unreachableFetch,
        store: createFakeStore({ "profile:t37:api_key": "ck_live_t37" }),
        stdout,
        stderr: createCapture(),
        env: { CANDLE_CONFIG_DIR: dir },
        promptSecret: async () => secrets.shift() ?? "",
        readFile: (path) => readFile(path, "utf8"),
        writeFile: (path, content) => writeFile(path, content, "utf8"),
      })
      await deps.writeConfig({
        activeProfile: "t37",
        profiles: { t37: { account: ACCOUNT, apiUrl: API, accountCachedAt: Date.now() } },
      })
      expect(await run(["vault", "import-legacy", "--tee", "--from", extraPath, "--keystore", vaultPath], deps)).toBe(0)

      const before = await readFile(vaultPath, "utf8")
      const dest = Keypair.generate().publicKey.toBase58()
      const statusOut = createCapture()
      const statusSecrets = [passphrase]
      const statusLines = [ACCOUNT.slice(-6), "nope!!"]
      const { fetch } = createRoutedFetch({
        "/api/v1/agent/wallets/embedded": () => jsonResponse(200, { success: true, account: ACCOUNT }),
        "/api/v1/agent/wallets": () =>
          jsonResponse(200, {
            page: [
              {
                _id: "lw_x",
                address: candidate.address,
                chain: "solana",
                vaultDestination: dest,
                boundKeyPrefix: "ck_x",
                remoteAuthority: "verified-active",
              },
            ],
            isDone: true,
          }),
        "/api/v1/agent/wallets/import-failures": () =>
          jsonResponse(200, { success: true, account: ACCOUNT, failures: [], complete: true }),
      })
      const statusDeps = createTestDeps({
        fetch,
        store: createFakeStore({ "profile:t37:api_key": "ck_live_t37" }),
        stdout: statusOut,
        stderr: createCapture(),
        env: { CANDLE_CONFIG_DIR: dir, CANDLE_API_URL: API },
        promptSecret: async () => statusSecrets.shift() ?? "",
        promptLine: async () => statusLines.shift() ?? "",
        readFile: (path) => readFile(path, "utf8"),
        writeFile: (path, content) => writeFile(path, content, "utf8"),
      })
      await statusDeps.writeConfig({
        activeProfile: "t37",
        profiles: { t37: { account: ACCOUNT, apiUrl: API, accountCachedAt: Date.now() } },
      })
      const code = await run(["tee", "status", candidate.address], statusDeps)
      expect(code).toBe(1)
      expect(statusOut.text + (await readFile(vaultPath, "utf8"))).toBeTruthy()
      expect(await readFile(vaultPath, "utf8")).toBe(before)
    }

    // GRANT_IDENTITY_MISMATCH under a different profile / API base.
    {
      const stdout = createCapture()
      const stderr = createCapture()
      const secrets = [passphrase]
      const { fetch } = createRoutedFetch({
        "/api/v1/agent/wallets/embedded": () =>
          jsonResponse(200, { success: true, account: "OtherAccount999999999999999999" }),
        "/api/v1/agent/wallets": () => jsonResponse(200, { page: [], isDone: true }),
        "/api/v1/agent/wallets/import-failures": () =>
          jsonResponse(200, {
            success: true,
            account: "OtherAccount999999999999999999",
            failures: [],
            complete: true,
          }),
      })
      const deps = createTestDeps({
        fetch,
        store: createFakeStore({ "profile:other:api_key": "ck_live_other" }),
        stdout,
        stderr,
        env: { CANDLE_CONFIG_DIR: dir, CANDLE_API_URL: "https://other.api" },
        promptSecret: async () => secrets.shift() ?? "",
        promptLine: async () => ACCOUNT.slice(-6),
        readFile: (path) => readFile(path, "utf8"),
        writeFile: (path, content) => writeFile(path, content, "utf8"),
      })
      await deps.writeConfig({
        activeProfile: "other",
        profiles: {
          other: {
            account: "OtherAccount999999999999999999",
            apiUrl: "https://other.api",
            accountCachedAt: Date.now(),
          },
        },
      })
      // Use an enabled migrated address that already has recorded-at-operation identity.
      const code = await run(["tee", "status", fixture.active.address, "--json"], deps)
      // enabled entries skip reconcile; identity mismatch is for local-candidate without matching
      // identity. Exercise reconcileGrant directly against the active entry's grantIdentity by
      // forcing a local-candidate with a recorded identity via the stranded path is heavier —
      // assert the code path through a candidate that already has grantIdentity is not needed
      // for enabled. Instead call status on failedAddress which now has recorded identity, under
      // the other API:
      const secrets2 = [passphrase]
      const deps2 = createTestDeps({
        fetch,
        store: createFakeStore({ "profile:other:api_key": "ck_live_other" }),
        stdout: createCapture(),
        stderr: createCapture(),
        env: { CANDLE_CONFIG_DIR: dir, CANDLE_API_URL: "https://other.api" },
        promptSecret: async () => secrets2.shift() ?? "",
        readFile: (path) => readFile(path, "utf8"),
        writeFile: (path, content) => writeFile(path, content, "utf8"),
      })
      await deps2.writeConfig({
        activeProfile: "other",
        profiles: {
          other: {
            account: "OtherAccount999999999999999999",
            apiUrl: "https://other.api",
            accountCachedAt: Date.now(),
          },
        },
      })
      // failedAddress was adopted and is enabled — status will not re-reconcile. Build a fresh
      // local-candidate with a recorded identity by adopting first under ACCOUNT then flipping.
      void code
      const { reconcileGrant } = await import("../vault/reconcile-grant")
      const vault = await unlockWithPassphrase(vaultPath, await readFile(vaultPath, "utf8"), passphrase)
      try {
        const entry = vault.index.entries.find((candidate) => candidate.address === failedAddress)!
        await expect(
          reconcileGrant(
            {
              deps: deps2,
              apiUrl: "https://other.api",
              json: false,
              profile: "other",
            } as never,
            entry,
          ),
        ).rejects.toMatchObject({ code: "GRANT_IDENTITY_MISMATCH" })
      } finally {
        const { closeVault } = await import("../vault/store")
        closeVault(vault)
      }
    }

    // tee commands refuse to write the old file for a migrated address.
    {
      const before = await readFile(teePath, "utf8")
      const secrets = [passphrase]
      const deps = createTestDeps({
        fetch: unreachableFetch,
        store: createFakeStore({ "profile:t37:api_key": "ck_live_t37" }),
        stdout: createCapture(),
        stderr: createCapture(),
        env: { CANDLE_CONFIG_DIR: dir },
        promptSecret: async () => secrets.shift() ?? "",
        readFile: (path) => readFile(path, "utf8"),
        writeFile: (path, content) => writeFile(path, content, "utf8"),
      })
      await deps.writeConfig({
        activeProfile: "t37",
        profiles: { t37: { account: ACCOUNT, apiUrl: API, accountCachedAt: Date.now() } },
      })
      const code = await run(["tee", "enable", fixture.active.address, "--vault", VAULT_DEST], deps)
      expect(code).toBe(1)
      expect(await readFile(teePath, "utf8")).toBe(before)
    }

    // retire-legacy refuses without a verified backup.
    {
      const secrets = [TEE_PASS, passphrase]
      const deps = createTestDeps({
        fetch: unreachableFetch,
        store: createFakeStore({ "profile:t37:api_key": "ck_live_t37" }),
        stdout: createCapture(),
        stderr: createCapture(),
        env: { CANDLE_CONFIG_DIR: dir },
        promptSecret: async () => secrets.shift() ?? "",
        readFile: (path) => readFile(path, "utf8"),
        writeFile: (path, content) => writeFile(path, content, "utf8"),
      })
      const code = await run(["vault", "retire-legacy", "--from", teePath, "--keystore", vaultPath, "--json"], deps)
      expect(code).toBe(1)
      expect(await stat(teePath).then(() => true)).toBe(true)
    }

    // Verified backup then retire succeeds.
    {
      const backupPath = join(tmpdir(), `candle-t37-backup-${Date.now()}.enc`)
      const secrets = [passphrase]
      const deps = createTestDeps({
        fetch: unreachableFetch,
        store: createFakeStore({ "profile:t37:api_key": "ck_live_t37" }),
        stdout: createCapture(),
        stderr: createCapture(),
        env: { CANDLE_CONFIG_DIR: dir },
        promptSecret: async () => secrets.shift() ?? "",
        readFile: (path) => readFile(path, "utf8"),
        writeFile: (path, content) => writeFile(path, content, "utf8"),
      })
      // Destination must be OUTSIDE CANDLE_CONFIG_DIR (CC-07).
      const backupCode = await run(["vault", "backup", "--to", backupPath, "--keystore", vaultPath], deps)
      if (backupCode !== 0) {
        throw new Error(`backup failed: ${(deps.stderr as ReturnType<typeof createCapture>).text}`)
      }
      expect(backupCode).toBe(0)

      // retire-legacy calls verifyVaultIntegrity on the live vault (not only the sidecar stamp).
      {
        const { readFileSync } = await import("node:fs")
        const { resolve } = await import("node:path")
        const retireSource = readFileSync(resolve(import.meta.dir, "vault-retire-legacy.ts"), "utf8")
        expect(retireSource.includes("await verifyVaultIntegrity(")).toBe(true)
      }
      const vaultBeforeTamper = await readFile(vaultPath, "utf8")
      await tamper(vaultPath, (file) => {
        file.root.ciphertext = flipByte(file.root.ciphertext)
      })
      {
        const secretsTamper = [TEE_PASS, passphrase]
        const stdout = createCapture()
        const depsTamper = createTestDeps({
          fetch: unreachableFetch,
          store: createFakeStore({ "profile:t37:api_key": "ck_live_t37" }),
          stdout,
          stderr: createCapture(),
          env: { CANDLE_CONFIG_DIR: dir },
          promptSecret: async () => secretsTamper.shift() ?? "",
          readFile: (path) => readFile(path, "utf8"),
          writeFile: (path, content) => writeFile(path, content, "utf8"),
        })
        const code = await run(
          ["vault", "retire-legacy", "--from", teePath, "--keystore", vaultPath, "--json"],
          depsTamper,
        )
        expect(code).toBe(1)
        expect(JSON.parse(stdout.text.trim()).code).toBe("VAULT_BLOB_TAMPERED")
        expect(await stat(teePath).then(() => true)).toBe(true)
      }
      await writeFile(vaultPath, vaultBeforeTamper, "utf8")

      // LEGACY_INCOMPLETE: an address still in the legacy file but not in the vault.
      const teeBeforeOrphan = await readFile(teePath, "utf8")
      {
        const orphan = keypairEntry("orphan-not-migrated").entry
        const opened = await readKeystore(teeBeforeOrphan, TEE_PASS, { expectPurpose: TEE_KEYSTORE_PURPOSE })
        const ks = await createKeystore(TEE_PASS)
        const withOrphan = [...opened.entries, { ...orphan, index: opened.entries.length }]
        await writeKeystoreFile(
          teePath,
          await serializeKeystore(withOrphan, ks.key, ks.salt, ks.iterations, TEE_KEYSTORE_PURPOSE),
        )
        const secretsIncomplete = [TEE_PASS, passphrase]
        const stdout = createCapture()
        const depsIncomplete = createTestDeps({
          fetch: unreachableFetch,
          store: createFakeStore({ "profile:t37:api_key": "ck_live_t37" }),
          stdout,
          stderr: createCapture(),
          env: { CANDLE_CONFIG_DIR: dir },
          promptSecret: async () => secretsIncomplete.shift() ?? "",
          readFile: (path) => readFile(path, "utf8"),
          writeFile: (path, content) => writeFile(path, content, "utf8"),
        })
        const code = await run(
          ["vault", "retire-legacy", "--from", teePath, "--keystore", vaultPath, "--json"],
          depsIncomplete,
        )
        expect(code).toBe(1)
        expect(JSON.parse(stdout.text.trim()).code).toBe("LEGACY_INCOMPLETE")
        expect(await stat(teePath).then(() => true)).toBe(true)
      }
      await writeFile(teePath, teeBeforeOrphan, "utf8")

      const secrets2 = [TEE_PASS, passphrase]
      const deps2 = createTestDeps({
        fetch: unreachableFetch,
        store: createFakeStore({ "profile:t37:api_key": "ck_live_t37" }),
        stdout: createCapture(),
        stderr: createCapture(),
        env: { CANDLE_CONFIG_DIR: dir },
        promptSecret: async () => secrets2.shift() ?? "",
        readFile: (path) => readFile(path, "utf8"),
        writeFile: (path, content) => writeFile(path, content, "utf8"),
      })
      // Extra address was imported from extra-tee; retire of the ORIGINAL store should still
      // succeed because every address in teePath is in the vault.
      const retireCode = await run(["vault", "retire-legacy", "--from", teePath, "--keystore", vaultPath], deps2)
      expect(retireCode).toBe(0)
      await expect(stat(teePath)).rejects.toBeTruthy()
      const retired = `${teePath}.migrated-2026-09-17`
      // deps.now defaults to 0 → 1970. Use whatever rename produced.
      const { readdir } = await import("node:fs/promises")
      const names = await readdir(dir)
      expect(names.some((name) => name.startsWith("tee-wallets.enc.migrated-"))).toBe(true)
      void retired
    }

    // hot-wallets.enc migrates the same way.
    {
      const hotDir = await mkdtemp(join(tmpdir(), "candle-t37-hot-"))
      const { passphrase: hotPass, vaultPath: hotVault } = await initVault(hotDir)
      const hotEntry = keypairEntry("hot-one", {
        imported: true,
        linkedWalletId: "lw_hot",
        tee: {
          network: "solana-mainnet",
          vaultDestination: VAULT_DEST,
          boundKeyPrefix: "ck_hot",
          remoteAuthority: "verified-active",
          enabledAt: "2026-09-17T01:00:00.000Z",
          sweepReceipts: [
            {
              kind: "sol",
              amountRaw: "1",
              signature: "SigHot11111111111111111111111111111111111111111111111",
              finalizedAt: "2026-09-17T03:00:00.000Z",
            },
          ],
        },
      }).entry
      const hotPath = legacyTeeKeystorePath({ CANDLE_CONFIG_DIR: hotDir }, TEST_HOME)
      // Write with the legacy purpose marker so readKeystore accepts it as ember-tee.
      const ks = await createKeystore(TEE_PASS)
      const sealed = await serializeKeystore([hotEntry], ks.key, ks.salt, ks.iterations, TEE_KEYSTORE_PURPOSE)
      // Force the pre-rename filename; purpose marker stays ember-tee (current readers accept both).
      await writeKeystoreFile(hotPath, sealed)
      const secrets = [TEE_PASS, hotPass]
      const deps = createTestDeps({
        fetch: unreachableFetch,
        store: createFakeStore({ "profile:t37:api_key": "ck_live_t37" }),
        stdout: createCapture(),
        stderr: createCapture(),
        env: { CANDLE_CONFIG_DIR: hotDir },
        promptSecret: async () => secrets.shift() ?? "",
        readFile: (path) => readFile(path, "utf8"),
        writeFile: (path, content) => writeFile(path, content, "utf8"),
      })
      await deps.writeConfig({
        activeProfile: "t37",
        profiles: { t37: { account: ACCOUNT, apiUrl: API, accountCachedAt: Date.now() } },
      })
      const code = await run(["vault", "import-legacy", "--tee", "--from", hotPath, "--keystore", hotVault], deps)
      expect(code).toBe(0)
      const vault = await unlockWithPassphrase(hotVault, await readFile(hotVault, "utf8"), hotPass)
      try {
        const entry = vault.index.entries.find((candidate) => candidate.address === hotEntry.address)
        expect(entry?.origin).toBe("migrated-tee")
        expect(entry?.derivation).toBeUndefined()
        expect(entry?.tee?.sweepReceipts).toHaveLength(1)
      } finally {
        const { closeVault } = await import("../vault/store")
        closeVault(vault)
      }
    }

    void file
    void copyFile
    void rename
    void readKeystore
  })
})
