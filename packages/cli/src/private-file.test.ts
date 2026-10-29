import { expect, test } from "bun:test"
import { stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { writeOwnerOnlyFile } from "./private-file"
import { tempDirs } from "./temp-dirs.test-support"

const tempDir = tempDirs()

test("an existing world-readable file is narrowed to 0600", async () => {
  const dir = tempDir("candle-private-")
  const path = join(dir, "signer.pem")
  await writeFile(path, "old", { mode: 0o644 })
  await writeOwnerOnlyFile(path, "new")
  expect((await stat(path)).mode & 0o777).toBe(0o600)
})
