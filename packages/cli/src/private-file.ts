import { chmod, writeFile } from "node:fs/promises"

/** Writes `content` readable by the owner only. `mode` applies at creation, so an existing file is chmod-ed too. */
export async function writeOwnerOnlyFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o600 })
  await chmod(path, 0o600)
}
