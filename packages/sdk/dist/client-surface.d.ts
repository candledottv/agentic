/**
 * BE-3919: every request this client makes to the Candle API carries `X-Candle-Client: sdk/<version>`,
 * so the API can tell SDK traffic from the CLI, MCP, web and raw callers when it measures trade latency
 * by surface. A label, not a credential: the API records it and decides nothing on it.
 *
 * Only requests to the client's own API origin carry it; a Hyperliquid or RPC request never does.
 */
export declare const CLIENT_SURFACE_HEADER = "x-candle-client";
type HeadersShape = RequestInit["headers"];
/** `headers` with `name: value` added unless already set, in the shape it came in. */
export declare function withHeader(headers: HeadersShape, name: string, value: string): HeadersShape;
/** Wraps `doFetch` so a request to `apiUrl`'s origin carries the client header. Anything else passes through. */
export declare function withClientSurface(doFetch: typeof fetch, apiUrl: string, value: string): typeof fetch;
export {};
//# sourceMappingURL=client-surface.d.ts.map