import { expect, test } from "bun:test"
import { buildManifest } from "./write-manifest.mjs"

test("buildManifest maps SHA256SUMS lines to the four platform assets with sizes", () => {
  const sums = [
    "aaaa  candle-darwin-arm64",
    "bbbb  candle-darwin-x64",
    "cccc  candle-linux-x64",
    "dddd  candle-linux-arm64",
    "eeee  candle-0.6.0-darwin-arm64.tar.gz",
  ].join("\n")
  const sizes = { "candle-darwin-arm64": 10, "candle-darwin-x64": 11, "candle-linux-x64": 12, "candle-linux-arm64": 13 }
  const m = buildManifest("0.6.0", sums, sizes)
  expect(m).toEqual({
    version: "0.6.0",
    tag: "cli-v0.6.0",
    assets: {
      "darwin-arm64": { name: "candle-darwin-arm64", sha256: "aaaa", size: 10 },
      "darwin-x64": { name: "candle-darwin-x64", sha256: "bbbb", size: 11 },
      "linux-x64": { name: "candle-linux-x64", sha256: "cccc", size: 12 },
      "linux-arm64": { name: "candle-linux-arm64", sha256: "dddd", size: 13 },
    },
  })
})

test("buildManifest refuses a SHA256SUMS missing a platform", () => {
  expect(() => buildManifest("0.6.0", "aaaa  candle-darwin-arm64\n", { "candle-darwin-arm64": 1 })).toThrow(
    "candle-darwin-x64",
  )
})
