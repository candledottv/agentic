/**
 * `render.ts`: the table helper, error-message mapping, scope-summary formatting, and the portal
 * URL helper. `renderError`'s three pinned mappings are the CLI's binding error-message contract
 * (task-3-brief.md Step 3); every human-mode error message routes through this function.
 */

import { describe, expect, test } from "bun:test"
import { DEFAULT_API_URL } from "./client"
import {
  DEFAULT_AGENT_SCOPES,
  formatScopesForSummary,
  portalDeviceUrl,
  renderError,
  renderTable,
  writeFailure,
  writeLocalFailure,
  writeUsageFailure,
} from "./render"

describe("renderTable", () => {
  test("renders a header row, a separator, and each data row, columns padded to the widest cell", () => {
    const out = renderTable(
      ["Prefix", "Scopes"],
      [
        ["abc123", "launch:write"],
        ["xy", "swap:write,launch:read"],
      ],
    )
    const lines = out.split("\n")
    expect(lines[0]).toBe("Prefix  Scopes")
    expect(lines[1]).toMatch(/^-+ +-+$/)
    expect(lines[2]).toBe("abc123  launch:write")
    expect(lines[3]).toBe("xy      swap:write,launch:read")
  })

  test("renders just the header and separator when there are no rows", () => {
    const out = renderTable(["A", "B"], [])
    expect(out.split("\n")).toEqual(["A  B", "-  -"])
  })
})

describe("renderError", () => {
  test("DEVICE_TOKEN_INVALID maps to the pinned message regardless of its status or message text", () => {
    const message = renderError(
      { status: 401, code: "DEVICE_TOKEN_INVALID", message: "Invalid or revoked device token" },
      { apiUrl: "https://api.candle.tv", authType: "device" },
    )
    expect(message).toBe("This device was revoked or its token is stale. Run: candle auth login")
  })

  test("a 401 on an agent-key call maps to the pinned message, regardless of its code", () => {
    const message = renderError(
      { status: 401, code: "UNAUTHORIZED", message: "Invalid API key" },
      { apiUrl: "https://api.candle.tv", authType: "key" },
    )
    expect(message).toBe("API key invalid or revoked. Run: candle keys create")
  })

  test("a 401 on a device-token call does NOT get the agent-key message", () => {
    const message = renderError(
      { status: 401, code: "SOME_OTHER_CODE", message: "raw message" },
      { apiUrl: "https://api.candle.tv", authType: "device" },
    )
    expect(message).toBe("raw message")
  })

  test("status:0 (network failure) maps to the pinned message naming the URL, ignoring the raw message", () => {
    const message = renderError(
      { status: 0, message: "Could not reach https://api.candle.tv/v1/x: ENOTFOUND (set CANDLE_API_URL...)" },
      { apiUrl: "https://api.candle.tv", authType: "none" },
    )
    expect(message).toBe("Could not reach https://api.candle.tv. Set CANDLE_API_URL to override the API endpoint.")
  })

  test("403 SCOPE_MISSING keeps the API's own scope-naming message and appends the two fix commands", () => {
    const message = renderError(
      { status: 403, code: "SCOPE_MISSING", message: "This key lacks the launch:write scope" },
      { apiUrl: "https://api.candle.tv", authType: "key" },
    )
    // The scope name can only come from the API's message -- a CLI-side constant could not know
    // which scope the route wanted -- so it must survive, with the fix appended, not replaced.
    expect(message).toContain("launch:write")
    expect(message).toContain("candle keys create --scopes")
    expect(message).toContain("candle keys list")
  })

  test("a 403 that is NOT SCOPE_MISSING is left as the API's own message", () => {
    const message = renderError(
      { status: 403, code: "FORBIDDEN", message: "Headless launches are disabled" },
      { apiUrl: "https://api.candle.tv", authType: "key" },
    )
    expect(message).toBe("Headless launches are disabled")
  })

  test("an unmapped error falls back to the API's own message", () => {
    const message = renderError(
      { status: 400, code: "VALIDATION_FAILED", message: "environment must be production or test" },
      { apiUrl: "https://api.candle.tv", authType: "device" },
    )
    expect(message).toBe("environment must be production or test")
  })
})

describe("writeFailure", () => {
  const ioPair = () => {
    const out: string[] = []
    const err: string[] = []
    return {
      deps: { stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) } },
      out,
      err,
    }
  }

  test("json mode writes the typed envelope to STDOUT with a suggestion, nothing to stderr", () => {
    const { deps, out, err } = ioPair()
    const result = { ok: false as const, status: 401, code: "DEVICE_TOKEN_INVALID", message: "x", raw: { error: "x" } }
    writeFailure(deps, result, { apiUrl: "https://api.candle.tv", authType: "device" }, true)
    expect(err.join("")).toBe("")
    expect(JSON.parse(out.join(""))).toEqual({
      ok: false,
      code: "DEVICE_TOKEN_INVALID",
      status: 401,
      message: "x",
      suggestion: "Run: candle auth login",
    })
  })

  test("json mode surfaces the API's uiHint/docsPath as suggestion/docsUrl", () => {
    const { deps, out } = ioPair()
    const result = {
      ok: false as const,
      status: 403,
      code: "TIER_REQUIRED",
      message: "Pro tier required",
      uiHint: "Stake CNDL to reach Pro.",
      docsPath: "developers/agent-access",
      raw: {},
    }
    writeFailure(deps, result, { apiUrl: "https://api.candle.tv", authType: "key" }, true)
    expect(JSON.parse(out.join(""))).toEqual({
      ok: false,
      code: "TIER_REQUIRED",
      status: 403,
      message: "Pro tier required",
      suggestion: "Stake CNDL to reach Pro.",
      docsUrl: "https://docs.candle.tv/developers/agent-access",
    })
  })

  test("json mode network failure: NETWORK_UNREACHABLE code, could-not-reach message, env-var suggestion", () => {
    const { deps, out } = ioPair()
    const result = { ok: false as const, status: 0, message: "fetch failed", raw: undefined }
    writeFailure(deps, result, { apiUrl: "https://api.candle.tv", authType: "device" }, true)
    const envelope = JSON.parse(out.join(""))
    expect(envelope.code).toBe("NETWORK_UNREACHABLE")
    expect(envelope.message).toBe("Could not reach https://api.candle.tv.")
    expect(envelope.suggestion).toContain("CANDLE_API_URL")
  })

  test("human mode writes the rendered message to STDERR, never the raw envelope", () => {
    const { deps, out, err } = ioPair()
    const result = { ok: false as const, status: 401, code: "DEVICE_TOKEN_INVALID", message: "x", raw: { error: "x" } }
    writeFailure(deps, result, { apiUrl: "https://api.candle.tv", authType: "device" }, false)
    const combined = err.join("")
    expect(out.join("")).toBe("")
    expect(combined).toContain("This device was revoked or its token is stale")
    expect(combined).not.toContain('"raw"')
    expect(combined).not.toContain("{")
  })
})

describe("writeLocalFailure", () => {
  const ioPair = () => {
    const out: string[] = []
    const err: string[] = []
    return {
      deps: { stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) } },
      out,
      err,
    }
  }

  test("json mode writes a parseable object (code + suggestion) to stdout; human mode joins them on stderr", () => {
    const failure = {
      code: "NO_DEVICE_TOKEN",
      message: "No device token available.",
      suggestion: "Run: candle auth login",
    }
    const jsonIo = ioPair()
    writeLocalFailure(jsonIo.deps, failure, true)
    expect(jsonIo.err.join("")).toBe("")
    expect(JSON.parse(jsonIo.out.join(""))).toEqual({ ok: false, ...failure })

    const humanIo = ioPair()
    writeLocalFailure(humanIo.deps, failure, false)
    expect(humanIo.out.join("")).toBe("")
    expect(humanIo.err.join("")).toBe("No device token available. Run: candle auth login\n")
  })

  // The reason this helper exists rather than reusing writeFailure with a synthetic status: 0
  // means "could not reach the server" to renderError, which would print THAT instead of the
  // message this failure carries.
  test("human mode never renders the network-failure message for a local precondition", () => {
    const { deps, err } = ioPair()
    writeLocalFailure(deps, { code: "NO_API_KEY", message: "No API key" }, false)
    expect(err.join("")).not.toContain("Could not reach")
  })
})

describe("writeUsageFailure", () => {
  test("json mode: a USAGE envelope on stdout; human mode: the sentence on stderr", () => {
    const out: string[] = []
    const err: string[] = []
    const deps = { stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) } }
    writeUsageFailure(deps, "Unknown flag: --frobnicate", true)
    expect(JSON.parse(out.join(""))).toEqual({ ok: false, code: "USAGE", message: "Unknown flag: --frobnicate" })
    writeUsageFailure(deps, "Unknown flag: --frobnicate", false)
    expect(err.join("")).toBe("Unknown flag: --frobnicate\n")
  })
})

describe("formatScopesForSummary", () => {
  test("calls out swap:write explicitly as fund-moving", () => {
    const summary = formatScopesForSummary(["launch:write", "swap:write"])
    expect(summary).toContain("swap:write")
    expect(summary.toLowerCase()).toContain("fund")
  })

  test("other scopes render as their plain names, with no fund-moving annotation", () => {
    const summary = formatScopesForSummary(["launch:write", "activity:write"])
    expect(summary).toContain("launch:write")
    expect(summary).toContain("activity:write")
    expect(summary.toLowerCase()).not.toContain("fund")
  })

  test("DEFAULT_AGENT_SCOPES excludes swap:write", () => {
    expect(DEFAULT_AGENT_SCOPES).not.toContain("swap:write")
    expect(DEFAULT_AGENT_SCOPES.length).toBe(3)
  })
})

describe("portalDeviceUrl", () => {
  test("the default API URL maps to the known portal domain", () => {
    expect(portalDeviceUrl(DEFAULT_API_URL)).toBe("https://alpha.candle.tv/dev/agent")
  })

  test("a non-default API URL gets 'api.' stripped and the portal path appended", () => {
    expect(portalDeviceUrl("https://api.staging.candle.tv")).toBe("https://staging.candle.tv/dev/agent")
  })

  // The staging host both halves of the fix exist for: `staging.api.candle.tv` is the ACTUAL
  // acceptance-test API host, and the old leading-label-only rule left it pointing at the API
  // host itself (a 404), not at the portal that can revoke the device.
  test("a stored portal origin is authoritative: it wins over any derivation from the API URL", () => {
    expect(portalDeviceUrl("https://staging.api.candle.tv", "https://staging.candle.tv")).toBe(
      "https://staging.candle.tv/dev/agent",
    )
    // Even where the derivation would disagree entirely -- the stored value came from the API's
    // own verificationUri, so it is right by construction and nothing overrides it.
    expect(portalDeviceUrl(DEFAULT_API_URL, "https://portal.example.com")).toBe("https://portal.example.com/dev/agent")
  })

  test("with no stored origin, the fallback removes the first 'api' LABEL anywhere in the host", () => {
    expect(portalDeviceUrl("https://staging.api.candle.tv")).toBe("https://staging.candle.tv/dev/agent")
    // A leading label still works, via the same rule rather than a separate branch (asserted on a
    // host that is NOT DEFAULT_API_URL, so this exercises the derivation and not the pinned case).
    expect(portalDeviceUrl("https://api.example.com")).toBe("https://example.com/dev/agent")
  })

  test("an unparseable stored origin falls through to the derivation instead of emitting garbage", () => {
    expect(portalDeviceUrl("https://staging.api.candle.tv", "not a url")).toBe("https://staging.candle.tv/dev/agent")
  })

  test("a stored origin's path is discarded -- only its origin plus the fixed portal path is used", () => {
    expect(portalDeviceUrl(DEFAULT_API_URL, "https://staging.candle.tv/dev/agent/device")).toBe(
      "https://staging.candle.tv/dev/agent",
    )
  })

  test("an API URL with no 'api.' segment just gets the portal path appended", () => {
    expect(portalDeviceUrl("http://localhost:3001")).toBe("http://localhost:3001/dev/agent")
  })

  test("a hostname that merely CONTAINS 'api.' but does not START with it is left alone", () => {
    expect(portalDeviceUrl("https://myapi.candle.tv")).toBe("https://myapi.candle.tv/dev/agent")
    expect(portalDeviceUrl("https://staging-api.candle.tv")).toBe("https://staging-api.candle.tv/dev/agent")
  })

  test("an 'api.' occurring inside a PATH segment is never mistaken for the host label", () => {
    expect(portalDeviceUrl("https://example.com/api.internal")).toBe("https://example.com/dev/agent")
  })

  test("stripping a leading api. host label never touches the port", () => {
    expect(portalDeviceUrl("https://api.example.com:8443")).toBe("https://example.com:8443/dev/agent")
  })
})
