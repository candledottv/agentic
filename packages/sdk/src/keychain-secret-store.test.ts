/**
 * KeychainSecretStore against injected exec fakes: what matters is the CONTRACT with the CLI's
 * storage (service, ref naming, single-line value format, stdin-only secret transport), not the
 * real keychain binaries, which CI does not have.
 */

import { describe, expect, test } from "bun:test"
import { type ExecResult, KeychainSecretStore } from "./keychain-secret-store"

const PEM = `-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg0123456789abcdef\n0123456789abcdefABCD\n-----END PRIVATE KEY-----\n`
const STORED = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg0123456789abcdef0123456789abcdefABCD"

interface ExecCall {
  binary: string
  args: string[]
  stdin?: string
}

function fakeExec(script: (call: ExecCall) => ExecResult) {
  const calls: ExecCall[] = []
  return {
    calls,
    exec: async (binary: string, args: string[], stdin?: string): Promise<ExecResult> => {
      const call = { binary, args, stdin }
      calls.push(call)
      return script(call)
    },
  }
}

describe("KeychainSecretStore (security backend)", () => {
  test("get reads the CLI's exact service/ref and re-armors the stored single-line value into PEM", async () => {
    const { calls, exec } = fakeExec(() => ({ status: 0, stdout: `${STORED}\n` }))
    const store = new KeychainSecretStore({ backend: "security", exec })

    const pem = await store.get("lw_abc123")
    expect(pem).toBe(PEM)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.binary).toBe("security")
    expect(calls[0]?.args).toEqual([
      "find-generic-password",
      "-s",
      "tv.candle.cli",
      "-a",
      "wallet_signer_lw_abc123",
      "-w",
    ])
  })

  test("get returns null on a nonzero exit (not stored, or keychain locked)", async () => {
    const { exec } = fakeExec(() => ({ status: 44, stdout: "" }))
    const store = new KeychainSecretStore({ backend: "security", exec })
    expect(await store.get("lw_abc123")).toBeNull()
  })

  test("a value already stored as PEM passes through unchanged (forward compatibility)", async () => {
    const { exec } = fakeExec(() => ({ status: 0, stdout: PEM }))
    const store = new KeychainSecretStore({ backend: "security", exec })
    expect(await store.get("lw_abc123")).toContain("BEGIN PRIVATE KEY")
  })

  test("set strips the PEM to its single-line form and writes via security -i stdin, never argv", async () => {
    const { calls, exec } = fakeExec(() => ({ status: 0, stdout: "" }))
    const store = new KeychainSecretStore({ backend: "security", exec })

    await store.set("lw_abc123", PEM)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual(["-i"])
    const stdin = calls[0]?.stdin ?? ""
    expect(stdin).toContain(`-a "wallet_signer_lw_abc123"`)
    expect(stdin).toContain(`-w "${STORED}"`)
    // The multiline PEM itself must never reach the command line or stdin verbatim.
    expect(stdin).not.toContain("BEGIN PRIVATE KEY")
  })

  test("round trip: set's stored form is exactly what get re-armors back to the original PEM", async () => {
    let storedValue = ""
    const { exec } = fakeExec((call) => {
      if (call.args[0] === "-i") {
        storedValue = /-w "([^"]+)"/.exec(call.stdin ?? "")?.[1] ?? ""
        return { status: 0, stdout: "" }
      }
      return { status: 0, stdout: `${storedValue}\n` }
    })
    const store = new KeychainSecretStore({ backend: "security", exec })
    await store.set("lw_abc123", PEM)
    expect(await store.get("lw_abc123")).toBe(PEM)
  })
})

describe("KeychainSecretStore (secret-tool backend)", () => {
  test("get/set use secret-tool's service/account form with the secret on stdin", async () => {
    const { calls, exec } = fakeExec((call) =>
      call.args[0] === "lookup" ? { status: 0, stdout: STORED } : { status: 0, stdout: "" },
    )
    const store = new KeychainSecretStore({ backend: "secret-tool", exec })

    await store.set("lw_abc123", PEM)
    expect(calls[0]?.args).toEqual([
      "store",
      "--label=Candle CLI",
      "service",
      "tv.candle.cli",
      "account",
      "wallet_signer_lw_abc123",
    ])
    expect(calls[0]?.stdin).toBe(STORED)

    const pem = await store.get("lw_abc123")
    expect(pem).toBe(PEM)
  })
})
