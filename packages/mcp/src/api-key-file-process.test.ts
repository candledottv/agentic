import { expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const root = resolve(import.meta.dir, "../../..")
const key = "process-fixture-opaque-sentinel"
function inspectProcess(pid: number) {
  if (process.platform !== "linux") return
  expect(readFileSync(`/proc/${pid}/environ`).includes(key)).toBe(false)
  expect(readFileSync(`/proc/${pid}/cmdline`).includes(key)).toBe(false)
}
const cases = [
  {
    name: "cli",
    command: process.execPath,
    args: [join(root, "packages/cli/src/index.ts"), "wallets", "--json"],
    mcp: false,
  },
  { name: "bundled", command: process.execPath, args: [join(root, "packages/cli/src/index.ts"), "mcp"], mcp: true },
  { name: "standalone", command: process.execPath, args: [join(root, "packages/mcp/src/index.ts")], mcp: true },
  ...(existsSync(join(root, "packages/cli/dist-bin/candle"))
    ? [
        {
          name: "compiled-cli",
          command: join(root, "packages/cli/dist-bin/candle"),
          args: ["wallets", "--json"],
          mcp: false,
        },
      ]
    : []),
  ...(existsSync(join(root, "packages/mcp/dist/index.js"))
    ? [{ name: "node-standalone", command: "node", args: [join(root, "packages/mcp/dist/index.js")], mcp: true }]
    : []),
]

test.skipIf(process.platform !== "linux")(
  "Linux proc checks are available for the entry-path subprocess matrix",
  () => {
    inspectProcess(process.pid)
  },
)

test("all entries sanitize a malicious missing path before HTTP or protocol startup", async () => {
  let requests = 0
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++
      return Response.json({})
    },
  })
  const dir = mkdtempSync(join(tmpdir(), "candle-entry-error-"))
  try {
    for (const entry of cases) {
      const child = Bun.spawn([entry.command, ...entry.args], {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: dir,
          CANDLE_CONFIG_DIR: join(dir, "config"),
          CANDLE_NO_UPDATE_NOTIFIER: "1",
          CANDLE_API_KEY_FILE: join(dir, key),
          CANDLE_API_URL: http.url.origin,
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      try {
        const [exit, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect(exit).toBe(1)
        expect((stdout + stderr).includes(key)).toBe(false)
        expect(stdout + stderr).toContain("CANDLE_API_KEY_FILE")
        if (entry.mcp) expect(stdout).toBe("")
        else expect(JSON.parse(stdout).code).toBe("API_KEY_FILE_UNREADABLE")
      } finally {
        if (child.exitCode === null) child.kill()
        await child.exited
      }
    }
    expect(requests).toBe(0)
  } finally {
    http.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
}, 10000)

for (const entry of cases)
  test(`${entry.name}: fixture authentication, protocol/output safety, Linux initial environ/argv`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "candle-entry-")),
      path = join(dir, "key")
    let notify: (() => void) | undefined, release: (() => void) | undefined
    let requests = 0,
      matching = 0
    const http = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests++
        if (request.headers.get("x-api-key") === key) matching++
        if (notify) {
          const signal = notify
          notify = undefined
          await new Promise<void>((r) => {
            release = r
            signal()
          })
        }
        return Response.json({ account: "fixture-B", wallets: {}, page: [], isDone: true, canEdit: true })
      },
    })
    try {
      for (let i = 0; i < 6; i++) {
        rmSync(path, { force: true })
        writeFileSync(path, key + ["", "\n", "\r\n"][i % 3], { mode: 0o600 })
        chmodSync(path, i % 2 ? 0o400 : 0o600)
        const env = {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: dir,
          CANDLE_CONFIG_DIR: join(dir, "config"),
          CANDLE_NO_UPDATE_NOTIFIER: "1",
          CANDLE_API_KEY_FILE: i % 2 ? relative(root, path) : path,
          CANDLE_API_URL: http.url.origin,
          CANDLE_MCP_TOOLS: "candle_get_agent_profile,candle_update_profile",
        }
        if (entry.mcp) {
          // Use the SDK transport so startup/stdout must speak the actual MCP protocol.
          const transport = new StdioClientTransport({
            command: entry.command,
            args: entry.args,
            env,
            cwd: root,
            stderr: "pipe",
          })
          let stderr = "",
            protocolSafe = true
          transport.stderr?.on("data", (chunk) => {
            stderr += String(chunk)
          })
          const client = new Client({ name: "file-process-fixture", version: "1" })
          try {
            await client.connect(transport)
            const pid = transport.pid
            if (pid === null) throw new Error("MCP process did not start")
            inspectProcess(pid)
            const dispatch = transport.onmessage
            transport.onmessage = (message) => {
              protocolSafe &&= !JSON.stringify(message).includes(key)
              dispatch?.(message)
            }
            // All later requests must use the startup snapshot, including automatic list refresh.
            rmSync(path)
            for (let n = 0; n < 2; n++) {
              await client.listTools()
              await client.callTool({ name: "candle_get_agent_profile", arguments: { idOrWallet: "fixture" } })
            }
            expect(protocolSafe).toBe(true)
            expect(stderr.includes(key)).toBe(false)
          } finally {
            await client.close()
            await transport.close()
          }
        } else {
          const firstRequest = new Promise<void>((r) => {
            notify = r
          })
          const child = Bun.spawn([entry.command, ...entry.args], { env, cwd: root, stdout: "pipe", stderr: "pipe" })
          try {
            await Promise.race([
              firstRequest,
              child.exited.then(() => {
                throw new Error("CLI exited before fixture request")
              }),
            ])
            inspectProcess(child.pid)
            release?.()
            release = undefined
            const [exit, stdout, stderr] = await Promise.all([
              child.exited,
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
            ])
            expect(exit).toBe(0)
            expect((stdout + stderr).includes(key)).toBe(false)
            expect(JSON.parse(stdout).embedded.account).toBe("fixture-B")
          } finally {
            release?.()
            release = undefined
            if (child.exitCode === null) child.kill()
            await child.exited
          }
        }
      }
      expect(requests > 0 && matching === requests).toBe(true)
      const config = join(dir, "config")
      for (const name of existsSync(config) ? readdirSync(config) : []) {
        expect(readFileSync(join(config, name)).includes(key)).toBe(false)
      }
    } finally {
      release?.()
      http.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)

test("in-process env and real helper/hook/browser/keychain children never receive file bytes; plugins omit the path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "candle-child-env-")),
    path = join(dir, "key")
  try {
    writeFileSync(path, key, { mode: 0o600 })
    const audit = join(dir, "audit.ts"),
      report = join(dir, "report.jsonl"),
      runner = join(dir, "runner.ts")
    writeFileSync(
      audit,
      `import {readFileSync,appendFileSync} from "node:fs";
const key=readFileSync(process.env.CANDLE_API_KEY_FILE,"utf8");
const row={name:process.argv[2]??"helper",secretFree:!JSON.stringify(process.env).includes(key),pathPresent:!!process.env.CANDLE_API_KEY_FILE};
appendFileSync(process.env.CANDLE_CHILD_REPORT,JSON.stringify(row)+"\\n");
console.log(JSON.stringify(row));`,
    )
    for (const name of ["xdg-open", "security"])
      writeFileSync(join(dir, name), `#!/bin/sh\nexec '${process.execPath}' '${audit}' ${name}\n`, { mode: 0o755 })
    writeFileSync(
      runner,
      `import {readFileSync} from "node:fs";
import {buildRealDeps} from ${JSON.stringify(join(root, "packages/cli/src/index.ts"))};
import {resolveApiKey} from ${JSON.stringify(join(root, "packages/cli/src/deps.ts"))};
import {KeychainSecretStore} from ${JSON.stringify(join(root, "packages/cli/src/keychain.ts"))};
import {pluginEnvironment} from ${JSON.stringify(join(root, "packages/cli/src/plugins.ts"))};
const deps=await buildRealDeps(); const key=await resolveApiKey(deps);
if(!key||JSON.stringify(process.env).includes(key)||JSON.stringify(deps.env).includes(key))throw new Error("in-process environment exposure");
await deps.spawnHelper(process.execPath,"",{timeoutMs:2000,args:[${JSON.stringify(audit)},"helper"]});
await deps.runHook(${JSON.stringify(`'${process.execPath}' '${audit}' hook`)},"",{},2000);
await new KeychainSecretStore(${JSON.stringify(join(dir, "security"))}).get("fixture");
deps.openBrowser("http://127.0.0.1:1234");
let rows=[]; for(let i=0;i<100;i++){try{rows=readFileSync(process.env.CANDLE_CHILD_REPORT,"utf8").trim().split("\\n").map(JSON.parse)}catch{} if(rows.some(r=>r.name==="xdg-open"))break; await new Promise(r=>setTimeout(r,10));}
const plugin=pluginEnvironment({parentEnv:deps.env,network:"solana",wallets:{},secrets:{}});
console.log(JSON.stringify({rows,pluginPathAbsent:!("CANDLE_API_KEY_FILE" in plugin),secretFree:!JSON.stringify(plugin).includes(key)}));`,
    )
    const child = Bun.spawn([process.execPath, runner], {
      cwd: root,
      env: {
        PATH: `${dir}:/usr/bin:/bin`,
        HOME: dir,
        CANDLE_CONFIG_DIR: join(dir, "config"),
        CANDLE_API_KEY_FILE: path,
        CANDLE_CHILD_REPORT: report,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(exit).toBe(0)
      expect((stdout + stderr).includes(key)).toBe(false)
      const result = JSON.parse(stdout)
      expect(result.rows.map((r: { name: string }) => r.name).sort()).toEqual([
        "helper",
        "hook",
        "security",
        "xdg-open",
      ])
      expect(
        result.rows.every((r: { secretFree: boolean; pathPresent: boolean }) => r.secretFree && r.pathPresent),
      ).toBe(true)
      expect(result.pluginPathAbsent && result.secretFree).toBe(true)
      expect(readFileSync(report).includes(key)).toBe(false)
    } finally {
      if (child.exitCode === null) child.kill()
      await child.exited
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 10000)
