/**
 * The built-SDK regression for BE-1820 round 3 (Hyperliquid phase 3, P3-7): the SDK's README
 * promises Node 18+, and Node 18 and 20 ship no global WebSocket, so `client.perpsStream()`
 * must open through undici's (this package's runtime dependency). This builds the SDK entry
 * the way a consumer receives it and runs it under the machine's real Node against a loopback
 * Bun WebSocket server — no fake global anywhere: the child hides any global WebSocket so the
 * runtimes that have one still exercise the undici path Node 18/20 actually take. Verifies the
 * `x-api-key` header reaches the server, frames arrive parsed, and the server's close reaches
 * `onClose` with its code and reason. Skips only where no `node` binary exists at all.
 */

import { describe, expect, test } from "bun:test"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const nodeVersion = (() => {
  try {
    return execFileSync("node", ["--version"], { encoding: "utf8" }).trim()
  } catch {
    return null
  }
})()

describe("perpsStream on the built SDK under real Node (P3-7 round 3)", () => {
  test.skipIf(nodeVersion === null)(
    "Node without a global WebSocket opens through undici, key on the upgrade headers",
    async () => {
      // Build inside packages/sdk so the external `undici` import resolves from node_modules,
      // exactly as a consumer's installed package does.
      const dir = mkdtempSync(join(import.meta.dir, ".node-stream-"))
      const sdk = join(dir, "sdk.mjs")
      const child = join(dir, "child.mjs")
      try {
        const build = spawnSync(
          process.execPath,
          [
            "build",
            join(import.meta.dir, "../src/index.ts"),
            "--target=node",
            "--format=esm",
            "--packages=external",
            "--outfile",
            sdk,
          ],
          { encoding: "utf8" },
        )
        expect(build.stderr).toBe("")
        expect(existsSync(sdk)).toBe(true)

        const key = "cndl_live_testkey0000000000000000000000000000"
        const seenKeys: string[] = []
        const server = Bun.serve({
          port: 0,
          fetch(request, srv) {
            seenKeys.push(String(request.headers.get("x-api-key")))
            if (srv.upgrade(request)) return
            return new Response("upgrade only", { status: 426 })
          },
          websocket: {
            open(ws) {
              ws.send(
                JSON.stringify({ type: "snapshot", seq: 1, at: "2026-10-25T00:00:00.000Z", ordersSource: "push" }),
              )
              ws.send(JSON.stringify({ type: "heartbeat", seq: 2, at: "2026-10-25T00:00:30.000Z", level: "warn" }))
              setTimeout(() => ws.close(4401, "key revoked"), 50)
            },
            message() {},
          },
        })

        writeFileSync(
          child,
          [
            "// Force the path Node 18 and 20 take even on a runtime that ships a global WebSocket.",
            "delete globalThis.WebSocket; globalThis.WebSocket = undefined;",
            `const { CandleClient } = await import(${JSON.stringify(`file://${sdk}`)})`,
            "const client = new CandleClient({",
            `  apiUrl: "http://127.0.0.1:${server.port}",`,
            "  apiKey: process.env.STREAM_TEST_KEY,",
            "})",
            "const frames = []",
            "client.perpsStream({",
            '  walletId: "w-1",',
            "  onMessage: (frame) => frames.push(frame),",
            "  onClose: (close) => {",
            "    console.log(JSON.stringify({ frames: frames.map((f) => f.type), close }))",
            "    process.exit(0)",
            "  },",
            "})",
            "setTimeout(() => { console.error(`no close within the timeout; frames=${frames.length}`); process.exit(2) }, 10000)",
          ].join("\n"),
        )

        // Async on purpose: the loopback server lives in this process, and a synchronous spawn
        // would block its event loop so the child's upgrade never completes.
        const run = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
          const proc = spawn("node", [child], {
            env: { ...process.env, STREAM_TEST_KEY: key },
          })
          let stdout = ""
          let stderr = ""
          proc.stdout.on("data", (chunk) => (stdout += String(chunk)))
          proc.stderr.on("data", (chunk) => (stderr += String(chunk)))
          proc.on("close", (status) => resolve({ status, stdout, stderr }))
        })
        server.stop(true)
        expect(run.stderr).toBe("")
        expect(run.status).toBe(0)
        const outcome = JSON.parse(run.stdout.trim().split("\n").at(-1) as string) as {
          frames: string[]
          close: { code: number; reason: string }
        }
        expect(outcome.frames).toEqual(["snapshot", "heartbeat"])
        expect(outcome.close).toEqual({ code: 4401, reason: "key revoked" })
        expect(seenKeys).toEqual([key])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    60_000,
  )
})

test.skipIf(nodeVersion !== null)("node binary presence is reported for the built-SDK test", () => {
  console.warn("perps-stream built-SDK test skipped: no node binary on this machine")
})
