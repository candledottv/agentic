import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

/** An actual stdio initialize + tool call, with stdout attached to a PTY as well as a pipe.
 * Only a loopback fixture API is reachable; no credentials or live market calls. */
test.skipIf(process.platform === "win32")(
  "standalone and CLI-bundled MCP keep exact JSON framing on a TTY and a pipe",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "candle-presentation-mcp-"))
    const seen: string[] = []
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        seen.push(new URL(request.url).pathname)
        expect(request.headers.get("x-api-key")).toBeNull()
        return Response.json({ success: true, tokens: [], fixture: "terminal-presentation" })
      },
    })
    const script = `
import json, os, pty, select, subprocess, sys, time
args = json.loads(sys.argv[1])
for tty in (False, True):
    master, slave = pty.openpty() if tty else (None, None)
    p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=slave if tty else subprocess.PIPE, stderr=subprocess.PIPE)
    if slave is not None: os.close(slave)
    fd = master if tty else p.stdout.fileno()
    pending = b''
    def send(message):
        p.stdin.write(json.dumps(message).encode() + b'\\n'); p.stdin.flush()
    def response(wanted):
        global pending
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if b'\\n' not in pending:
                if not select.select([fd], [], [], .1)[0]: continue
                chunk = os.read(fd, 65536)
                assert chunk, 'server closed protocol output'
                pending += chunk
            while b'\\n' in pending:
                line, pending = pending.split(b'\\n', 1)
                assert b'\\x1b' not in line, line
                message = json.loads(line)
                assert message.get('jsonrpc') == '2.0', message
                if message.get('id') == wanted: return message
        raise AssertionError('timed out waiting for protocol response')
    try:
        send({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'presentation-fixture','version':'1'}}})
        assert 'serverInfo' in response(1)['result']
        send({'jsonrpc':'2.0','method':'notifications/initialized'})
        send({'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'candle_get_feed','arguments':{'bucket':'new'}}})
        answer = response(2)
        assert 'terminal-presentation' in json.dumps(answer), answer
        assert not answer['result'].get('isError'), answer
        print(('TTY' if tty else 'pipe') + ': initialize + candle_get_feed; protocol stdout clean')
    finally:
        p.terminate()
        try: p.wait(timeout=3)
        except subprocess.TimeoutExpired: p.kill(); p.wait()
        diagnostics = p.stderr.read()
        assert b'\\x1b' not in diagnostics and b'Update available' not in diagnostics, diagnostics
        if master is not None: os.close(master)
`
    try {
      const root = resolve(import.meta.dir, "../..")
      for (const args of [
        [process.execPath, join(root, "mcp/src/index.ts")],
        [process.execPath, join(root, "cli/src/index.ts"), "mcp", "--read-only", "--no-color"],
      ]) {
        const child = Bun.spawn(["python3", "-c", script, JSON.stringify(args)], {
          env: {
            PATH: process.env.PATH,
            HOME: dir,
            CANDLE_CONFIG_DIR: dir,
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
            CANDLE_API_URL: `http://127.0.0.1:${server.port}`,
            CANDLE_ALLOW_INSECURE_HTTP: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        })
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
        expect(stdout).toContain("TTY: initialize + candle_get_feed")
        expect(stdout).toContain("pipe: initialize + candle_get_feed")
      }
      expect(seen).toEqual(Array(4).fill("/api/v1/markets/feed"))
    } finally {
      server.stop(true)
      await rm(dir, { recursive: true, force: true })
    }
  },
  30000,
)
