/**
 * Update discovery for the MCP server, riding the same header the API stamps on every response
 * (x-candle-mcp-latest; apps/api/src/lib/client-versions.ts). The server is long-running and
 * agent-facing, so the notice has two audiences with two channels:
 *
 *   - the AGENT reads `updateAvailable` off the execution-status context (orchestrate.ts),
 *     structured, with the exact command -- an agent can relay it to its operator or run it;
 *   - the OPERATOR tailing the server's stderr gets one line, once per process, not one per
 *     request.
 */
import { SERVER_VERSION } from "./version"

const PLAIN_VERSION = /^\d+\.\d+\.\d+$/

let latestSeen: string | null = null
let warned = false

function newer(a: string, b: string): boolean {
  const [a1 = 0, a2 = 0, a3 = 0] = a.split(".").map(Number)
  const [b1 = 0, b2 = 0, b3 = 0] = b.split(".").map(Number)
  return a1 !== b1 ? a1 > b1 : a2 !== b2 ? a2 > b2 : a3 > b3
}

/**
 * Called wherever a response is in hand. Typed as `unknown` on purpose: the callers hold two
 * different response shapes (a real fetch Response and orchestrate's minimal FetchLike result,
 * which has no headers at all), and an update notice must never constrain what a fetch seam is
 * allowed to return. Anything without readable headers is simply a response that taught nothing.
 */
export function noteVersionHeaders(res: unknown): void {
  const headers = (res as { headers?: { get?: (name: string) => string | null } } | null)?.headers
  const value = typeof headers?.get === "function" ? headers.get("x-candle-mcp-latest") : null
  if (!value || !PLAIN_VERSION.test(value)) return
  if (latestSeen !== null && !newer(value, latestSeen)) return
  latestSeen = value
  if (!warned && newer(value, SERVER_VERSION) && !process.env.CANDLE_NO_UPDATE_NOTIFIER) {
    warned = true
    console.error(
      `@candledottv/mcp ${value} is available (running ${SERVER_VERSION}). Update: npm install -g @candledottv/mcp@latest`,
    )
  }
}

/** The structured form the execution-status context carries, or null while up to date. */
export function updateAvailable(): { current: string; latest: string; command: string } | null {
  if (latestSeen === null || !newer(latestSeen, SERVER_VERSION)) return null
  return {
    current: SERVER_VERSION,
    latest: latestSeen,
    command: "npm install -g @candledottv/mcp@latest",
  }
}

export function __resetUpdateNoticeForTest(): void {
  latestSeen = null
  warned = false
}
