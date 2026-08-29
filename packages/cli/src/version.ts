/**
 * The CLI's own version string, reported by `candle --version` and embedded in `auth login`'s
 * default `clientName` (`candle-cli/<version>@<hostname>`), which is what the device-approval
 * screen and the portal's device list show. It is NOT sent as a user-agent header; the CLI sets no
 * user-agent of its own (see client.ts's `buildHeaders`). Kept as a hand-maintained constant (not
 * read from package.json at runtime) because the published bundle is a single self-contained
 * `dist/index.js` with no `package.json` read back out of it at run time; bump this alongside
 * `package.json`'s `version` field on release.
 */
export const CLI_VERSION = "0.8.0"
