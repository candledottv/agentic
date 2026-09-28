/** R1.2: real compiled CLI, encrypted profile slot, hostile CWD, loopback HTTP only.
 * CANDLE_TEST_UNSAFE_COMPILE=1 deliberately omits the flags for the negative-control run.
 */
import { expect, test } from "bun:test"
import { webcrypto } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const key = `cndl_test_${"StoredAb"}${"s".repeat(35)}`
const dotenvKey = `cndl_test_${"DotenvAb"}${"d".repeat(35)}`
const passphrase = "throwaway-test-passphrase"

async function profileStore(path: string) {
  const salt = new Uint8Array(16),
    iv = new Uint8Array(12)
  const material = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ])
  const derived = await webcrypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 1000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  )
  const ciphertext = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, derived, new TextEncoder().encode(key))
  const b64 = (bytes: Uint8Array | ArrayBuffer) =>
    Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).toString("base64")
  await writeFile(
    path,
    JSON.stringify({
      "profile:bot:api_key": { salt: b64(salt), iv: b64(iv), ciphertext: b64(ciphertext), iterations: 1000 },
    }),
  )
}

test("R1.2 compiled doctor ignores project dotenv/bunfig; explicit environment still wins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "candle-dotenv-"))
  const requests: { path: string; key: string | null }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      requests.push({ path, key: req.headers.get("x-api-key") })
      if (path.endsWith("latest.json")) return Response.json({ version: "0.11.10", tag: "cli-v0.11.10", assets: {} })
      if (path.endsWith("/wallets/trading")) return Response.json({ scopes: ["account:read"], page: [], isDone: true })
      if (path.endsWith("/wallets/embedded")) return Response.json({ wallets: { solana: null, evm: null } })
      return Response.json({ success: true })
    },
  })
  try {
    const base = `http://127.0.0.1:${server.port}`
    const bin = join(dir, "candle")
    const flags =
      process.env.CANDLE_TEST_UNSAFE_COMPILE === "1"
        ? []
        : ["--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig"]
    const build = Bun.spawn(
      [process.execPath, "build", "--compile", ...flags, "--minify", "src/index.ts", "--outfile", bin],
      { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
    )
    const [code, err] = await Promise.all([
      build.exited,
      new Response(build.stderr).text(),
      new Response(build.stdout).text(),
    ])
    expect({ code, err }).toMatchObject({ code: 0 })
    const configDir = join(dir, "config")
    await mkdir(configDir)
    await writeFile(
      join(configDir, "config.json"),
      JSON.stringify({ profiles: { bot: { apiUrl: `${base}/configured` } }, activeProfile: "bot" }),
    )
    await profileStore(join(configDir, "credentials.enc"))
    await writeFile(join(dir, ".env"), `CANDLE_API_URL=${base}/dotenv\nCANDLE_API_KEY=${dotenvKey}\n`)
    const marker = join(dir, "preload-ran")
    await writeFile(
      join(dir, "preload.ts"),
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unexpected preload")`,
    )
    await writeFile(join(dir, "bunfig.toml"), 'preload = ["./preload.ts"]\n')
    // No inherited credentials, proxies, BUN_OPTIONS, or production endpoints. Empty PATH also
    // forces the encrypted file backend on macOS and Linux without touching either OS keychain.
    const env = {
      PATH: "",
      HOME: dir,
      CANDLE_CONFIG_DIR: configDir,
      CANDLE_KEYRING_PASSPHRASE: passphrase,
      CANDLE_RELEASE_BASE_URL: base,
    }
    for (const exported of [false, true]) {
      requests.length = 0
      const proc = Bun.spawn([bin, "doctor", "--json"], {
        cwd: dir,
        env: { ...env, ...(exported ? { CANDLE_API_URL: `${base}/exported` } : {}) },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exitCode, out, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      expect(stderr).toBe("")
      expect(exitCode).toBe(0)
      expect(JSON.parse(out).role).toBe("bot")
      expect(requests.some((r) => r.path.startsWith("/dotenv"))).toBe(false)
      expect(requests.some((r) => r.key === dotenvKey)).toBe(false)
      expect(requests.some((r) => r.path.startsWith(exported ? "/exported/" : "/configured/") && r.key === key)).toBe(
        true,
      )
      expect(existsSync(marker)).toBe(false)
    }
  } finally {
    server.stop(true)
    await rm(dir, { recursive: true, force: true })
  }
}, 120_000)
