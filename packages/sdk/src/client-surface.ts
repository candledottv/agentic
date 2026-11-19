/**
 * BE-3919: every request this client makes to the Candle API carries `X-Candle-Client: sdk/<version>`,
 * so the API can tell SDK traffic from the CLI, MCP, web and raw callers when it measures trade latency
 * by surface. A label, not a credential: the API records it and decides nothing on it.
 *
 * Only requests to the client's own API origin carry it; a Hyperliquid or RPC request never does.
 */
export const CLIENT_SURFACE_HEADER = "x-candle-client"

type HeadersShape = RequestInit["headers"]

/** `headers` with `name: value` added unless already set, in the shape it came in. */
export function withHeader(headers: HeadersShape, name: string, value: string): HeadersShape {
  if (headers === undefined || headers === null) return { [name]: value }
  if (headers instanceof Headers) {
    const copy = new Headers(headers)
    if (!copy.has(name)) copy.set(name, value)
    return copy
  }
  if (Array.isArray(headers)) {
    if (headers.some(([key]) => key.toLowerCase() === name)) return headers
    return [...headers, [name, value]]
  }
  const record = headers as Record<string, string>
  if (Object.keys(record).some((key) => key.toLowerCase() === name)) return record
  return { ...record, [name]: value }
}

/** Wraps `doFetch` so a request to `apiUrl`'s origin carries the client header. Anything else passes through. */
export function withClientSurface(doFetch: typeof fetch, apiUrl: string, value: string): typeof fetch {
  let apiOrigin: string | null = null
  try {
    apiOrigin = new URL(apiUrl).origin
  } catch {
    apiOrigin = null
  }
  const labelled = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (apiOrigin === null || input instanceof Request) return doFetch(input, init)
    let origin: string
    try {
      origin = new URL(input.toString()).origin
    } catch {
      return doFetch(input, init)
    }
    if (origin !== apiOrigin) return doFetch(input, init)
    return doFetch(input, { ...init, headers: withHeader(init?.headers, CLIENT_SURFACE_HEADER, value) })
  }
  return labelled as typeof fetch
}
