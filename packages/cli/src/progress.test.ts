import { expect, test } from "bun:test"
import { commandSteps, stepReporter } from "./progress"
import { createCapture, createTestDeps } from "./test-support"

test("progress uses stderr capabilities and honors JSON/plain/CI/dumb/NO_COLOR", () => {
  for (const mode of ["pipe", "plain", "json", "CI", "dumb", "no-color"]) {
    const stderr = createCapture()
    const deps = createTestDeps({
      fetch,
      stderr,
      isTTY: { stdin: true, stdout: true, stderr: mode !== "pipe" },
      presentation: { plain: mode === "plain" },
      env: {
        TERM: mode === "dumb" ? "dumb" : "xterm",
        ...(mode === "CI" ? { CI: "1" } : {}),
        ...(mode === "no-color" ? { NO_COLOR: "1" } : {}),
      },
    })
    using steps = commandSteps({ deps, apiUrl: "https://api.test", json: mode === "json", verifyAccount: false })
    steps.start("downloading")
    steps.done("downloaded")
    steps.fail("verified")
    expect(stderr.text).not.toContain("\x1b")
    expect(stderr.text.includes("downloading...")).toBe(mode !== "json")
    if (mode === "json") expect(stderr.text).toBe("")
    if (mode !== "json" && mode !== "no-color") expect(stderr.text).toContain("OK downloaded\nFAIL verified\n")
  }
})

test("stage completion and scope disposal leave no animation timer or signal handler", async () => {
  let text = ""
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]
  const steps = stepReporter((chunk) => {
    text += chunk
  }, true)
  steps.start("first")
  steps.start("second")
  expect(process.listenerCount("SIGINT")).toBe((before[0] ?? 0) + 1)
  steps.done("second")
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before)
  const finished = text
  await Bun.sleep(100)
  expect(text).toBe(finished)

  const stderr = createCapture()
  const deps = createTestDeps({ fetch, stderr, env: { TERM: "xterm" } })
  expect(() => {
    using reporter = commandSteps({ deps, apiUrl: "https://api.test", json: false, verifyAccount: false })
    reporter.start("throwing stage")
    throw new Error("interrupted work")
  }).toThrow("interrupted work")
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before)
  expect(stderr.text).toEndWith("\r\x1b[2K")
})

test("cancellation handlers are installed before the first visible progress frame", () => {
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]
  let first: number[] | undefined
  const steps = stepReporter(() => {
    first ??= [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]
  }, true)
  try {
    steps.start("first frame")
    expect(first).toEqual(before.map((count) => count + 1))
  } finally {
    steps.stop()
  }
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before)
})

test.skipIf(process.platform === "win32")(
  "Ctrl+C clears real PTY progress, preserves terminal settings, and terminates",
  async () => {
    const script = `
import errno, os, pty, select, signal, subprocess, sys, termios, time
master, slave = pty.openpty()
before = termios.tcgetattr(slave)
code = 'import { stepReporter } from "./progress.ts"; stepReporter(s => process.stderr.write(s), true).start("downloading fixture"); setTimeout(() => {}, 10000)'
p = subprocess.Popen([sys.argv[1], '-e', code], stdin=slave, stdout=slave, stderr=slave, cwd=sys.argv[2])
output = b''
try:
    deadline = time.monotonic() + 5
    while b'downloading fixture' not in output and time.monotonic() < deadline:
        if select.select([master], [], [], .1)[0]: output += os.read(master, 65536)
    assert b'downloading fixture' in output, output
    os.kill(p.pid, signal.SIGINT)
    p.wait(timeout=3)
    while select.select([master], [], [], .1)[0]: output += os.read(master, 65536)
    assert p.returncode in (-signal.SIGINT, 130), p.returncode
    assert b'\\r\\x1b[2K' in output, output
    assert termios.tcgetattr(slave) == before
    print('Ctrl+C: terminal unchanged, spinner cleared, process terminated')
finally:
    if p.poll() is None: p.kill(); p.wait()
    os.close(master); os.close(slave)
`
    const child = Bun.spawn(["python3", "-c", script, process.execPath, import.meta.dir], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(stdout).toContain("spinner cleared, process terminated")
  },
  10000,
)
