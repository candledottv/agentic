/**
 * T46 (CC-07 export ceremony, BE-139 / PR D): `vault export-key`.
 *
 * The ceremony is the feature: typed confirmation, refusals on an existing file / symlink /
 * unwritable or missing directory, mode 0600 on what it writes, `everExported` recorded before
 * the file appears, and nothing secret in stdout or `--json`.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Deps } from "../deps"
import { run } from "../index"
import { createCapture, createTestDeps } from "../test-support"
import { closeVault, unlockWithPassphrase } from "../vault/store"
import { generatedPassphraseFrom, useCheapKdf } from "../vault/test-vault"
import { parseSolanaSecret } from "../wallet-import"
import { nativeKeyFileContents } from "./vault-export-key"

setDefaultTimeout(30_000)
useCheapKdf()

const unreachableFetch = (async () => {
  throw new Error("no test in this file should make a network call")
}) as unknown as typeof fetch

async function harness(
  opts: { secrets?: string[]; lines?: string[]; env?: Record<string, string>; json?: boolean } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "candle-vault-export-"))
  const stdout = createCapture()
  const stderr = createCapture()
  const secrets = [...(opts.secrets ?? [])]
  const lines = [...(opts.lines ?? [])]
  const deps: Deps = createTestDeps({
    fetch: unreachableFetch,
    stdout,
    stderr,
    env: { CANDLE_CONFIG_DIR: dir, HOME: dir, ...(opts.env ?? {}) },
    isTTY: { stdin: true, stdout: true },
    promptSecret: async () => {
      const next = secrets.shift()
      if (next === undefined) throw new Error("promptSecret asked for more than the test scripted")
      return next
    },
    promptLine: async () => {
      const next = lines.shift()
      if (next !== undefined) return next
      return "no"
    },
  })
  return { deps, stdout, stderr, dir, vaultPath: join(dir, "vault.enc") }
}

async function vaultWithLabeledKey(label = "cold") {
  const h = await harness()
  h.deps.promptSecret = async () => generatedPassphraseFrom(h.stdout.text)
  if ((await run(["vault", "init", "--keystore", h.vaultPath], h.deps)) !== 0) {
    throw new Error(`init failed: ${h.stderr.text}`)
  }
  const passphrase = generatedPassphraseFrom(h.stdout.text)

  const k = await harness({
    env: { CANDLE_CONFIG_DIR: h.dir },
    secrets: [passphrase],
  })
  const code = await run(
    ["vault", "new-key", "--chain", "solana", "--label", label, "--json", "--keystore", h.vaultPath],
    k.deps,
  )
  if (code !== 0) throw new Error(`new-key failed: ${k.stderr.text}\n${k.stdout.text}`)
  const created = JSON.parse(k.stdout.text) as { address: string; label: string }
  return { ...h, passphrase, address: created.address, label: created.label }
}

describe("T46: vault export-key ceremony", () => {
  test("exports one Solana key as a solana-keygen JSON array, mode 0600, with everExported set", async () => {
    const h = await vaultWithLabeledKey("export-me")
    const outDir = join(h.dir, "out")
    await mkdir(outDir, { mode: 0o700 })
    const destination = join(outDir, "id.json")

    const e = await harness({
      env: { CANDLE_CONFIG_DIR: h.dir },
      secrets: [h.passphrase],
      lines: [h.address.slice(-6)],
    })
    expect(
      await run(["vault", "export-key", "export-me", "--to", destination, "--keystore", h.vaultPath], e.deps),
    ).toBe(0)

    const stats = await lstat(destination)
    expect(stats.isFile()).toBe(true)
    expect(stats.mode & 0o777).toBe(0o600)

    const body = await readFile(destination, "utf8")
    const secret = parseSolanaSecret(body.trim())
    expect(secret).toHaveLength(64)

    // The vault records the exposure, and neither stdout nor stderr carry the secret bytes.
    const opened = await unlockWithPassphrase(h.vaultPath, await readFile(h.vaultPath, "utf8"), h.passphrase)
    try {
      const entry = opened.index.entries.find((candidate) => candidate.label === "export-me")
      expect(entry?.exposure.everExported).toBe(true)
    } finally {
      closeVault(opened)
    }
    expect(e.stdout.text).not.toContain(body.trim())
    expect(e.stderr.text).not.toContain(body.trim())
    // A few leading secret bytes as decimal: the JSON array form would put them on stdout if
    // anyone printed the file contents.
    expect(e.stdout.text).not.toContain(`[${secret[0]},${secret[1]},${secret[2]}`)
    expect(e.stdout.text).toContain("mode 0600")
    expect(e.stdout.text).toContain("outside every vault guarantee")
  })

  test("--json carries path and address, never the key", async () => {
    const h = await vaultWithLabeledKey("json-key")
    const outDir = join(h.dir, "out")
    await mkdir(outDir, { mode: 0o700 })
    const destination = join(outDir, "key.json")

    const e = await harness({
      env: { CANDLE_CONFIG_DIR: h.dir },
      secrets: [h.passphrase],
      lines: [h.address.slice(-6)],
    })
    expect(
      await run(["vault", "export-key", "json-key", "--to", destination, "--json", "--keystore", h.vaultPath], e.deps),
    ).toBe(0)

    const payload = JSON.parse(e.stdout.text) as {
      ok: boolean
      path: string
      address: string
      label: string
      everExported: boolean
    }
    expect(payload).toEqual({
      ok: true,
      path: destination,
      address: h.address,
      label: "json-key",
      everExported: true,
    })
    const body = (await readFile(destination, "utf8")).trim()
    expect(e.stdout.text).not.toContain(body)
    expect(JSON.stringify(payload)).not.toMatch(/\[\s*\d+\s*,/)
  })

  test("everExported is written before the file appears", async () => {
    const h = await vaultWithLabeledKey("order")
    const outDir = join(h.dir, "out")
    await mkdir(outDir, { mode: 0o700 })
    const destination = join(outDir, "id.json")

    const e = await harness({
      env: { CANDLE_CONFIG_DIR: h.dir },
      secrets: [h.passphrase],
    })
    // After the typed confirmation, flip the parent to read-only so the vault write can land and
    // the file write cannot: that is the crash window the ordering rule exists for.
    e.deps.promptLine = async (text: string) => {
      if (text.includes("last six characters")) {
        await chmod(outDir, 0o500)
        return h.address.slice(-6)
      }
      return "no"
    }

    try {
      expect(await run(["vault", "export-key", "order", "--to", destination, "--keystore", h.vaultPath], e.deps)).toBe(
        1,
      )
      expect(e.stderr.text).toMatch(/VAULT_WRITE_FAILED|permission denied|not writable/i)

      let sawFile = false
      try {
        await lstat(destination)
        sawFile = true
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe("ENOENT")
      }
      expect(sawFile).toBe(false)

      const opened = await unlockWithPassphrase(h.vaultPath, await readFile(h.vaultPath, "utf8"), h.passphrase)
      try {
        expect(opened.index.entries.find((candidate) => candidate.label === "order")?.exposure.everExported).toBe(true)
      } finally {
        closeVault(opened)
      }
    } finally {
      await chmod(outDir, 0o700)
    }
  })

  test("an existing file is refused and the vault is untouched", async () => {
    const h = await vaultWithLabeledKey("exists")
    const outDir = join(h.dir, "out")
    await mkdir(outDir, { mode: 0o700 })
    const destination = join(outDir, "id.json")
    await writeFile(destination, "already here\n", { mode: 0o600 })

    const before = await readFile(h.vaultPath, "utf8")
    const e = await harness({ env: { CANDLE_CONFIG_DIR: h.dir }, secrets: [h.passphrase] })
    expect(await run(["vault", "export-key", "exists", "--to", destination, "--keystore", h.vaultPath], e.deps)).toBe(1)
    expect(e.stderr.text).toContain("already exists")
    expect(await readFile(h.vaultPath, "utf8")).toBe(before)
    expect(await readFile(destination, "utf8")).toBe("already here\n")

    const j = await harness({ env: { CANDLE_CONFIG_DIR: h.dir } })
    expect(
      await run(["vault", "export-key", "exists", "--to", destination, "--json", "--keystore", h.vaultPath], j.deps),
    ).toBe(1)
    expect(JSON.parse(j.stdout.text)).toMatchObject({ ok: false, code: "EXPORT_TARGET_EXISTS" })
  })

  test("a symlink target is refused", async () => {
    const h = await vaultWithLabeledKey("link")
    const outDir = join(h.dir, "out")
    await mkdir(outDir, { mode: 0o700 })
    const real = join(outDir, "real.json")
    const destination = join(outDir, "link.json")
    await writeFile(real, "[]\n", { mode: 0o600 })
    await symlink(real, destination)

    const before = await readFile(h.vaultPath, "utf8")
    const e = await harness({ env: { CANDLE_CONFIG_DIR: h.dir } })
    expect(await run(["vault", "export-key", "link", "--to", destination, "--keystore", h.vaultPath], e.deps)).toBe(1)
    expect(e.stderr.text).toContain("symlink")
    expect(await readFile(h.vaultPath, "utf8")).toBe(before)

    const j = await harness({ env: { CANDLE_CONFIG_DIR: h.dir } })
    expect(
      await run(["vault", "export-key", "link", "--to", destination, "--json", "--keystore", h.vaultPath], j.deps),
    ).toBe(1)
    expect(JSON.parse(j.stdout.text)).toMatchObject({ ok: false, code: "EXPORT_TARGET_SYMLINK" })
  })

  test("a missing parent directory is refused without creating it", async () => {
    const h = await vaultWithLabeledKey("missing-dir")
    const destination = join(h.dir, "no-such-dir", "id.json")

    const e = await harness({ env: { CANDLE_CONFIG_DIR: h.dir } })
    expect(
      await run(["vault", "export-key", "missing-dir", "--to", destination, "--keystore", h.vaultPath], e.deps),
    ).toBe(1)
    expect(e.stderr.text).toContain("does not create the directory")

    const j = await harness({ env: { CANDLE_CONFIG_DIR: h.dir } })
    expect(
      await run(
        ["vault", "export-key", "missing-dir", "--to", destination, "--json", "--keystore", h.vaultPath],
        j.deps,
      ),
    ).toBe(1)
    expect(JSON.parse(j.stdout.text)).toMatchObject({ ok: false, code: "VAULT_WRITE_FAILED" })
  })

  test("an unwritable directory is refused", async () => {
    const h = await vaultWithLabeledKey("ro-dir")
    const outDir = join(h.dir, "readonly")
    await mkdir(outDir, { mode: 0o700 })
    await chmod(outDir, 0o500)
    const destination = join(outDir, "id.json")

    try {
      const e = await harness({ env: { CANDLE_CONFIG_DIR: h.dir } })
      expect(await run(["vault", "export-key", "ro-dir", "--to", destination, "--keystore", h.vaultPath], e.deps)).toBe(
        1,
      )
      expect(e.stderr.text).toMatch(/not writable/i)

      const j = await harness({ env: { CANDLE_CONFIG_DIR: h.dir } })
      expect(
        await run(["vault", "export-key", "ro-dir", "--to", destination, "--json", "--keystore", h.vaultPath], j.deps),
      ).toBe(1)
      expect(JSON.parse(j.stdout.text)).toMatchObject({ ok: false, code: "VAULT_WRITE_FAILED" })
    } finally {
      await chmod(outDir, 0o700)
    }
  })

  test("a wrong last-six confirmation writes nothing and leaves everExported false", async () => {
    const h = await vaultWithLabeledKey("typo")
    const outDir = join(h.dir, "out")
    await mkdir(outDir, { mode: 0o700 })
    const destination = join(outDir, "id.json")

    const e = await harness({
      env: { CANDLE_CONFIG_DIR: h.dir },
      secrets: [h.passphrase],
      lines: ["xxxxxx"],
    })
    expect(await run(["vault", "export-key", "typo", "--to", destination, "--keystore", h.vaultPath], e.deps)).toBe(1)
    expect(e.stderr.text).toContain("last six characters")
    expect(e.stderr.text).toContain("nothing was done")

    let sawFile = false
    try {
      await lstat(destination)
      sawFile = true
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT")
    }
    expect(sawFile).toBe(false)

    const opened = await unlockWithPassphrase(h.vaultPath, await readFile(h.vaultPath, "utf8"), h.passphrase)
    try {
      expect(opened.index.entries.find((candidate) => candidate.label === "typo")?.exposure.everExported).toBe(false)
    } finally {
      closeVault(opened)
    }
  })

  test("nativeKeyFileContents matches solana-keygen's JSON array shape", () => {
    const secret = Uint8Array.from({ length: 64 }, (_, i) => i)
    const body = nativeKeyFileContents(
      {
        id: "k1",
        chain: "solana",
        curve: "ed25519",
        address: "addr",
        label: "unit",
        createdAt: "",
        role: "vault",
        origin: "derived",
        derivation: { scheme: "slip10-ed25519", path: "m/44'/501'/0'/0'" },
        exposure: { everRemoteExposed: false, everExported: false },
      },
      secret,
    )
    expect(JSON.parse(body)).toEqual([...secret])
    expect(parseSolanaSecret(body.trim())).toEqual(secret)
  })
})
