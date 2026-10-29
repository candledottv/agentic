import { expect, test } from "bun:test"
import { mkdtemp, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeOwnerOnlyFile } from "./private-file"

test("an existing world-readable file is narrowed to 0600", async () => {
  const dir = await mkdtemp(join(tmpdir(), "candle-private-"))
  const path = join(dir, "signer.pem")
  await writeFile(path, "old", { mode: 0o644 })
  await writeOwnerOnlyFile(path, "new")
  expect((await stat(path)).mode & 0o777).toBe(0o600)
})
