import { expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

test("R6.4 guidance uses interactive tools and no CLI PIN flag exists", async () => {
  const fido = await readFile(join(import.meta.dir, "vault/fido2.ts"), "utf8")
  for (const text of ["ykman fido access change-pin", "chrome://settings/securityKeys", "fido2-token -S <device>"])
    expect(fido).toContain(text)
  async function check(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await check(path)
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
        expect(await readFile(path, "utf8")).not.toMatch(/--pin\b/)
    }
  }
  await check(import.meta.dir)
})
