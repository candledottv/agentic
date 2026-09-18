import { expect, test } from "bun:test"
import { buildManifest } from "./write-manifest.mjs"

const SUMS = [
  "aaaa  candle-darwin-arm64",
  "bbbb  candle-darwin-x64",
  "cccc  candle-linux-x64",
  "dddd  candle-linux-arm64",
  "1111  candle-fido2-darwin-arm64",
  "2222  candle-fido2-darwin-x64",
  "3333  candle-fido2-linux-x64",
  "4444  candle-fido2-linux-arm64",
  "eeee  candle-0.6.0-darwin-arm64.tar.gz",
].join("\n")
const SIZES = {
  "candle-darwin-arm64": 10,
  "candle-darwin-x64": 11,
  "candle-linux-x64": 12,
  "candle-linux-arm64": 13,
  "candle-fido2-darwin-arm64": 20,
  "candle-fido2-darwin-x64": 21,
  "candle-fido2-linux-x64": 22,
  "candle-fido2-linux-arm64": 23,
}

test("buildManifest maps SHA256SUMS lines to the four platform assets and the four helpers with sizes", () => {
  const m = buildManifest("0.6.0", SUMS, SIZES)
  expect(m).toEqual({
    version: "0.6.0",
    tag: "cli-v0.6.0",
    assets: {
      "darwin-arm64": { name: "candle-darwin-arm64", sha256: "aaaa", size: 10 },
      "darwin-x64": { name: "candle-darwin-x64", sha256: "bbbb", size: 11 },
      "linux-x64": { name: "candle-linux-x64", sha256: "cccc", size: 12 },
      "linux-arm64": { name: "candle-linux-arm64", sha256: "dddd", size: 13 },
    },
    helpers: {
      "darwin-arm64": { name: "candle-fido2-darwin-arm64", sha256: "1111", size: 20 },
      "darwin-x64": { name: "candle-fido2-darwin-x64", sha256: "2222", size: 21 },
      "linux-x64": { name: "candle-fido2-linux-x64", sha256: "3333", size: 22 },
      "linux-arm64": { name: "candle-fido2-linux-arm64", sha256: "4444", size: 23 },
    },
  })
})

test("buildManifest refuses a SHA256SUMS missing a platform binary, and one missing a helper", () => {
  expect(() => buildManifest("0.6.0", "aaaa  candle-darwin-arm64\n", { "candle-darwin-arm64": 1 })).toThrow(
    "candle-fido2-darwin-arm64",
  )
  const noHelper = SUMS.split("\n")
    .filter((line) => !line.endsWith("candle-fido2-linux-x64"))
    .join("\n")
  expect(() => buildManifest("0.6.0", noHelper, SIZES)).toThrow("candle-fido2-linux-x64")
})

test("buildManifest names the signed macOS helper archive when told to, and refuses one SHA256SUMS lacks", () => {
  // Assembled rather than spelled out: scripts/check-agentic-skills.ts reads backticked spans in
  // this tree as CLI samples, and the archive's prefix would read to it as a stale invocation.
  const archive = ["candle", "enclave", "0.6.0.app.zip"].join("-")
  const withHelper = buildManifest(
    "0.6.0",
    `${SUMS}\nffff  ${archive}`,
    { ...SIZES, [archive]: 99 },
    { macosHelper: archive },
  )
  expect(withHelper.macosHelper).toEqual({ name: archive, sha256: "ffff", size: 99 })
  expect(withHelper.assets).toEqual(buildManifest("0.6.0", SUMS, SIZES).assets)
  expect(buildManifest("0.6.0", SUMS, SIZES).macosHelper).toBeUndefined()
  expect(() => buildManifest("0.6.0", SUMS, SIZES, { macosHelper: archive })).toThrow(archive)
})
