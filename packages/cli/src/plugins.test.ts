/**
 * Ember Phase 3 PR F (BE-226, R6): plug-ins and the allowlist environment.
 *
 * The load-bearing assertion is made against a REAL child: a `candle-envdump` script on a temp
 * `PATH` writes its environment and its argv to files, and the test compares that environment to
 * the allowlist exactly, with the parent process exporting `CANDLE_API_KEY`, `CANDLE_DEVICE_TOKEN`,
 * `CANDLE_KEYSTORE_PASSPHRASE` and `CANDLE_SOLANA_RPC_URL`, none of which may appear. Then the
 * per-invocation rules: only the secrets named appear, only the wallets named appear (two external
 * wallets exist, one is named, the other's address is absent from the whole environment), and
 * `--secret` / `--wallet` are stripped from the argv while every other argument survives verbatim.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { run } from "./index"
import { findPlugin, isPluginName, listPlugins, pluginEnvironment, splitPluginArgs } from "./plugins"
import { createCapture, createFakeConfigStore, createFakeStore, createTestDeps } from "./test-support"
import { deriveSolanaKey, solanaExternalPath } from "./vault/hd"
import { closeVault } from "./vault/store"
import { FIXTURE_ENTROPY, makeVault, useCheapKdf } from "./vault/test-vault"

setDefaultTimeout(90_000)
useCheapKdf()

/** Writes `candle-envdump` into a fresh directory and returns a PATH that finds it first. */
async function pluginDir(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "candle-plugins-"))
  const script = join(dir, "candle-envdump")
  await writeFile(
    script,
    `#!/bin/sh
# $1 receives the environment (one NAME=value per line), $2 the argv after it, one per line.
env > "$1"
shift
out="$1"
shift
: > "$out"
for arg in "$@"; do printf '%s\\n' "$arg" >> "$out"; done
exit 7
`,
    "utf8",
  )
  await chmod(script, 0o755)
  await writeFile(join(dir, "candle-fido2"), "#!/bin/sh\nexit 0\n", "utf8")
  await chmod(join(dir, "candle-fido2"), 0o755)
  await writeFile(join(dir, "candle-not-executable"), "#!/bin/sh\nexit 0\n", "utf8")
  await chmod(join(dir, "candle-not-executable"), 0o644)
  return { dir, path: `${dir}:/usr/bin:/bin` }
}

/** The environment a child reports, minus what the shell itself adds on the way. */
async function envOf(file: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    const at = line.indexOf("=")
    if (at <= 0) continue
    const name = line.slice(0, at)
    if (name === "PWD" || name === "SHLVL" || name === "_" || name === "OLDPWD") continue
    out[name] = line.slice(at + 1)
  }
  return out
}

describe("the allowlist, as a pure function", () => {
  test("is built from empty: only the named passthrough, the plug-in variables, and the named secrets and wallets", () => {
    const env = pluginEnvironment({
      parentEnv: {
        PATH: "/p",
        HOME: "/h",
        TMPDIR: "/t",
        TERM: "xterm",
        TZ: "UTC",
        LANG: "en_US.UTF-8",
        LC_ALL: "C",
        HTTPS_PROXY: "http://proxy",
        no_proxy: "localhost",
        CANDLE_API_KEY: "cndl_live_secret",
        CANDLE_DEVICE_TOKEN: "cndl_dvc_secret",
        CANDLE_KEYSTORE_PASSPHRASE: "hunter2",
        CANDLE_SOLANA_RPC_URL: "https://rpc.parent",
        CANDLE_PLUGIN_WALLET_PARENT: "leaked-if-present",
        CANDLE_SECRET_PARENT: "leaked-if-present",
        SSH_AUTH_SOCK: "/sock",
        AWS_SECRET_ACCESS_KEY: "aws",
      },
      rpcUrl: "https://rpc.profile",
      network: "solana-mainnet",
      wallets: { "my-wallet": "Addr1" },
      secrets: { EXCHANGE_KEY: "k" },
    })
    expect(env).toEqual({
      PATH: "/p",
      HOME: "/h",
      TMPDIR: "/t",
      TERM: "xterm",
      TZ: "UTC",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      HTTPS_PROXY: "http://proxy",
      no_proxy: "localhost",
      CANDLE_PLUGIN_RPC_URL: "https://rpc.profile",
      CANDLE_PLUGIN_NETWORK: "solana-mainnet",
      CANDLE_PLUGIN_WALLET_MY_WALLET: "Addr1",
      CANDLE_SECRET_EXCHANGE_KEY: "k",
    })
  })

  test("--secret and --wallet are consumed, in both spellings, and everything else passes through verbatim", () => {
    expect(
      splitPluginArgs([
        "--json",
        "--secret",
        "A",
        "buy",
        "--wallet=w1",
        "--amount",
        "1",
        "--secret=B",
        "--wallet",
        "w2",
        "-v",
      ]),
    ).toEqual({ secrets: ["A", "B"], wallets: ["w1", "w2"], passthrough: ["--json", "buy", "--amount", "1", "-v"] })
    expect(splitPluginArgs(["--secret"])).toEqual({ error: "--secret requires a value" })
    expect(splitPluginArgs(["--wallet", "--json"])).toEqual({ error: "--wallet requires a value" })
  })

  test("a plug-in name is one plain path segment; the shipped helpers are not plug-ins", () => {
    expect(isPluginName("envdump")).toBe(true)
    expect(isPluginName("my-tool2")).toBe(true)
    for (const bad of ["../x", "a/b", ".hidden", "UPPER", "fido2", "enclave", "", "-x"])
      expect(isPluginName(bad)).toBe(false)
  })
})

describe("a real child receives exactly the allowlist", () => {
  test("no parent CANDLE_* variable, only the named secret, and the argv stripped of the grants", async () => {
    const { dir, path } = await pluginDir()
    const envFile = join(dir, "env.txt")
    const argvFile = join(dir, "argv.txt")
    const stderr = createCapture()
    const deps = createTestDeps({
      fetch: (async () => {
        throw new Error("a plug-in run makes no Candle request")
      }) as unknown as typeof fetch,
      stderr,
      env: {
        PATH: path,
        HOME: "/home/tester",
        TERM: "dumb",
        CANDLE_API_KEY: "cndl_live_parent",
        CANDLE_DEVICE_TOKEN: "cndl_dvc_parent",
        CANDLE_KEYSTORE_PASSPHRASE: "parent-passphrase",
        CANDLE_SOLANA_RPC_URL: "https://rpc.parent",
        CANDLE_CONFIG_DIR: dir,
        UNRELATED: "value",
      },
      secretsStore: createFakeStore({ "secret:EXCHANGE_KEY": "ex-key-value", "secret:OTHER": "never-named" }),
    })
    const code = await run(
      ["envdump", envFile, "--secret", "exchange_key", argvFile, "--json", "buy", "--amount", "1"],
      deps,
    )
    // The plug-in's own exit code, passed through.
    expect(code).toBe(7)
    expect(await envOf(envFile)).toEqual({
      PATH: path,
      HOME: "/home/tester",
      TERM: "dumb",
      CANDLE_PLUGIN_RPC_URL: "https://rpc.parent",
      CANDLE_PLUGIN_NETWORK: "solana-mainnet",
      CANDLE_SECRET_EXCHANGE_KEY: "ex-key-value",
    })
    const raw = await readFile(envFile, "utf8")
    for (const leaked of ["cndl_live_parent", "cndl_dvc_parent", "parent-passphrase", "never-named", "UNRELATED"]) {
      expect(raw).not.toContain(leaked)
    }
    // `--json` after the plug-in name belongs to the plug-in, verbatim; `--secret exchange_key` is gone.
    expect((await readFile(argvFile, "utf8")).split("\n").filter(Boolean)).toEqual(["--json", "buy", "--amount", "1"])
    expect(stderr.text).toBe("")
  })

  test("a named external wallet reaches the child by label; an unnamed one's address is absent from the whole environment", async () => {
    const { dir, path } = await pluginDir()
    const made = await makeVault()
    closeVault(made.vault)
    const envFile = join(dir, "env.txt")
    const argvFile = join(dir, "argv.txt")
    const deps = createTestDeps({
      fetch: (async () => {
        throw new Error("no network")
      }) as unknown as typeof fetch,
      env: { PATH: path, HOME: "/home/tester", CANDLE_CONFIG_DIR: made.dir },
      promptSecret: async () => made.passphrase,
    })
    expect(await run(["external", "new", "--label", "hot-desk"], deps)).toBe(0)
    expect(await run(["external", "new", "--label", "quiet"], deps)).toBe(0)
    const named = (await deriveSolanaKey(Uint8Array.from(FIXTURE_ENTROPY), solanaExternalPath(0))).address
    const unnamed = (await deriveSolanaKey(Uint8Array.from(FIXTURE_ENTROPY), solanaExternalPath(1))).address
    expect(await run(["envdump", envFile, argvFile, "--wallet", "hot-desk"], deps)).toBe(7)
    const env = await envOf(envFile)
    expect(env.CANDLE_PLUGIN_WALLET_HOT_DESK).toBe(named)
    expect(Object.values(env)).not.toContain(unnamed)
    expect(await readFile(envFile, "utf8")).not.toContain(unnamed)
    // Sorted: `env` prints variables in whatever order the platform keeps them.
    expect(
      Object.keys(env)
        .filter((name) => name.startsWith("CANDLE_"))
        .sort(),
    ).toEqual(["CANDLE_PLUGIN_NETWORK", "CANDLE_PLUGIN_WALLET_HOT_DESK"])
  })

  test("a vault key named with --wallet is refused: only an external wallet's address is passed", async () => {
    const { dir, path } = await pluginDir()
    const made = await makeVault()
    closeVault(made.vault)
    const stdout = createCapture()
    const deps = createTestDeps({
      fetch: (async () => {
        throw new Error("no network")
      }) as unknown as typeof fetch,
      stdout,
      env: { PATH: path, HOME: "/home/tester", CANDLE_CONFIG_DIR: made.dir },
      promptSecret: async () => made.passphrase,
    })
    expect(await run(["vault", "new-key", "--chain", "solana", "--label", "cold"], deps)).toBe(0)
    stdout.text = ""
    expect(await run(["--json", "envdump", join(dir, "e"), join(dir, "a"), "--wallet", "cold"], deps)).toBe(1)
    expect(JSON.parse(stdout.text.trim())).toMatchObject({ ok: false, code: "PLUGIN_WALLET_NOT_EXTERNAL" })
  })

  test("a secret that is not stored refuses before the plug-in runs", async () => {
    const { dir, path } = await pluginDir()
    const stdout = createCapture()
    const deps = createTestDeps({
      fetch: (async () => {
        throw new Error("no network")
      }) as unknown as typeof fetch,
      stdout,
      env: { PATH: path, CANDLE_CONFIG_DIR: dir },
    })
    expect(await run(["--json", "envdump", join(dir, "e"), join(dir, "a"), "--secret", "missing"], deps)).toBe(1)
    expect(JSON.parse(stdout.text.trim())).toMatchObject({ ok: false, code: "SECRET_MISSING" })
  })
})

describe("candle plugins, and dispatch", () => {
  test("lists the executables on PATH, skipping the shipped helpers and non-executables", async () => {
    const { dir, path } = await pluginDir()
    expect(listPlugins(path).map((plugin) => plugin.name)).toEqual(["envdump"])
    expect(findPlugin("envdump", path)).toBe(join(dir, "candle-envdump"))
    expect(findPlugin("fido2", path)).toBeUndefined()
    expect(findPlugin("not-executable", path)).toBeUndefined()
    const stdout = createCapture()
    const deps = createTestDeps({
      fetch: (async () => {
        throw new Error("no network")
      }) as unknown as typeof fetch,
      stdout,
      env: { PATH: path, CANDLE_CONFIG_DIR: dir },
    })
    expect(await run(["plugins", "--json"], deps)).toBe(0)
    expect(JSON.parse(stdout.text.trim())).toEqual({
      ok: true,
      plugins: [{ name: "envdump", path: join(dir, "candle-envdump") }],
    })
  })

  test("a word that is neither a built-in nor a plug-in on PATH is still an unknown command", async () => {
    const { dir, path } = await pluginDir()
    const stderr = createCapture()
    const deps = createTestDeps({
      fetch: (async () => {
        throw new Error("no network")
      }) as unknown as typeof fetch,
      stderr,
      env: { PATH: path, CANDLE_CONFIG_DIR: dir },
    })
    expect(await run(["frobnicate"], deps)).toBe(1)
    expect(stderr.text).toContain("Unknown command: frobnicate")
  })
})

/**
 * BE-355 (D6, T17): a plug-in's `CANDLE_PLUGIN_RPC_URL` comes from `CANDLE_SOLANA_RPC_URL`, then the
 * profile's `rpcUrl` (decision 5's order, the reverse of before), and never from the public default.
 */
describe("BE-355 T17: a plug-in's RPC comes from env, then the profile, never the default", () => {
  test("env and profile both set: the env value wins", async () => {
    const { dir, path } = await pluginDir()
    const envFile = join(dir, "env.txt")
    const argvFile = join(dir, "argv.txt")
    const deps = createTestDeps({
      fetch: (async () => {
        throw new Error("a plug-in run makes no Candle request")
      }) as unknown as typeof fetch,
      env: { PATH: path, HOME: "/home/tester", CANDLE_SOLANA_RPC_URL: "https://rpc.parent", CANDLE_CONFIG_DIR: dir },
      ...createFakeConfigStore({ profiles: { work: { rpcUrl: "https://rpc.profile" } }, activeProfile: "work" }),
    })
    expect(await run(["envdump", envFile, argvFile], deps)).toBe(7)
    expect((await envOf(envFile)).CANDLE_PLUGIN_RPC_URL).toBe("https://rpc.parent")
  })

  test("only the profile set: the profile's value; neither set: the variable is absent, and no public default is injected", async () => {
    const { dir, path } = await pluginDir()
    const envFile = join(dir, "env.txt")
    const argvFile = join(dir, "argv.txt")
    const fromProfile = createTestDeps({
      fetch: (async () => {
        throw new Error("a plug-in run makes no Candle request")
      }) as unknown as typeof fetch,
      env: { PATH: path, HOME: "/home/tester", CANDLE_CONFIG_DIR: dir },
      ...createFakeConfigStore({ profiles: { work: { rpcUrl: "https://rpc.profile" } }, activeProfile: "work" }),
    })
    expect(await run(["envdump", envFile, argvFile], fromProfile)).toBe(7)
    expect((await envOf(envFile)).CANDLE_PLUGIN_RPC_URL).toBe("https://rpc.profile")

    const neither = createTestDeps({
      fetch: (async () => {
        throw new Error("a plug-in run makes no Candle request")
      }) as unknown as typeof fetch,
      env: { PATH: path, HOME: "/home/tester", CANDLE_CONFIG_DIR: dir },
    })
    expect(await run(["envdump", envFile, argvFile], neither)).toBe(7)
    const env = await envOf(envFile)
    expect(env.CANDLE_PLUGIN_RPC_URL).toBeUndefined()
    expect(JSON.stringify(env)).not.toContain("mainnet-beta")
  })
})
