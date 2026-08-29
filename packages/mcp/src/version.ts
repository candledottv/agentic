/**
 * Server version reported in the MCP handshake.
 *
 * This is a literal rather than a `package.json` import because the published artifact is a
 * bundle: a JSON import would either get inlined at build time anyway or fail at runtime, since
 * `package.json` sits outside `dist/`. It lives in its own module so `version.test.ts` can assert
 * it matches `package.json` -- `index.ts` starts a stdio transport the moment it is imported, so
 * a test can never read the constant from there. Bump both together when releasing.
 */
export const SERVER_VERSION = "0.6.0"
