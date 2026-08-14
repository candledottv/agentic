import { describe, expect, test } from "bun:test"
import pkg from "../package.json"
import { CLI_VERSION } from "./version"

describe("CLI_VERSION", () => {
  test("matches package.json's version field", () => {
    expect(CLI_VERSION).toBe(pkg.version)
  })
})
