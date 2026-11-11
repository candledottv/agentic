import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs"
import { resolve } from "node:path"

export type ApiKeyFileCode =
  | "API_KEY_SOURCE_CONFLICT"
  | "API_KEY_FILE_UNSUPPORTED"
  | "API_KEY_FILE_UNREADABLE"
  | "API_KEY_FILE_INVALID"

/** Only fixed, local messages cross this boundary; filesystem errors and paths never do. */
export class ApiKeyFileError extends Error {
  constructor(
    readonly code: ApiKeyFileCode,
    message: string,
  ) {
    super(message)
    this.name = "ApiKeyFileError"
  }
}

export function hasApiKeyFile(env: Record<string, string | undefined>): boolean {
  return Boolean(env.CANDLE_API_KEY_FILE?.trim())
}

export function assertApiKeySources(env: Record<string, string | undefined>): void {
  if (hasApiKeyFile(env) && (env.CANDLE_API_KEY?.trim() || env.CANDLE_AGENT_API_KEY?.trim())) {
    throw new ApiKeyFileError(
      "API_KEY_SOURCE_CONFLICT",
      "CANDLE_API_KEY_FILE conflicts with CANDLE_API_KEY or CANDLE_AGENT_API_KEY. Unset the raw sources or unset CANDLE_API_KEY_FILE.",
    )
  }
}

export const apiKeyFileIo = {
  platform: process.platform as string,
  effectiveUid: () => process.geteuid?.(),
  constants,
  open: openSync,
  stat: (fd: number) => fstatSync(fd, { bigint: true }),
  read: (fd: number, buffer: Buffer, offset: number, length: number) => readSync(fd, buffer, offset, length, null),
  close: closeSync,
}
export type ApiKeyFileIo = typeof apiKeyFileIo

function requireDescriptorMetadata(stat: ReturnType<ApiKeyFileIo["stat"]>): void {
  if ([stat.uid, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].some((value) => typeof value !== "bigint")) {
    throw new ApiKeyFileError(
      "API_KEY_FILE_UNSUPPORTED",
      "CANDLE_API_KEY_FILE requires POSIX descriptor metadata. Use an existing credential source or a supported host.",
    )
  }
}

function invalid(rule: string): never {
  throw new ApiKeyFileError("API_KEY_FILE_INVALID", `CANDLE_API_KEY_FILE ${rule}. Fix the file locally.`)
}

/** Synchronous and bounded (4 KiB) so existing synchronous MCP construction stays compatible.
 * Node/libuv opens descriptors close-on-exec. Never reopen the path after descriptor validation. */
export function readApiKeyFile(path: string, io: ApiKeyFileIo = apiKeyFileIo): string {
  let fd: number | undefined
  let key = ""
  let failure: ApiKeyFileError | undefined
  try {
    const uid = io.effectiveUid()
    if (
      !["linux", "darwin"].includes(io.platform) ||
      uid === undefined ||
      !io.constants.O_NOFOLLOW ||
      !io.constants.O_NONBLOCK ||
      !io.open ||
      !io.stat ||
      !io.read ||
      !io.close
    ) {
      throw new ApiKeyFileError(
        "API_KEY_FILE_UNSUPPORTED",
        "CANDLE_API_KEY_FILE requires Linux or macOS with POSIX descriptor checks. Use an existing credential source or a supported host.",
      )
    }
    fd = io.open(path, io.constants.O_RDONLY | io.constants.O_NOFOLLOW | io.constants.O_NONBLOCK)
    const before = io.stat(fd)
    requireDescriptorMetadata(before)
    const mode = Number(before.mode & 0o7777n)
    if (!before.isFile() || before.uid !== BigInt(uid) || (mode !== 0o400 && mode !== 0o600)) {
      invalid("must be a regular file owned by the effective user with mode 0400 or 0600")
    }
    if (before.size > 4096n) invalid("must be at most 4096 bytes")
    const bytes = Buffer.alloc(4097)
    let count = 0
    while (count < bytes.length) {
      const read = io.read(fd, bytes, count, bytes.length - count)
      if (read === 0) break
      count += read
    }
    const after = io.stat(fd)
    requireDescriptorMetadata(after)
    if (
      !after.isFile() ||
      count > 4096 ||
      BigInt(count) !== before.size ||
      before.uid !== after.uid ||
      before.mode !== after.mode ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      invalid("must remain unchanged while being read")
    let end = count
    if (bytes[end - 1] === 10) {
      end--
      if (bytes[end - 1] === 13) end--
    }
    if (end === 0) invalid("must contain one nonempty printable ASCII token, optionally followed by LF or CRLF")
    for (let i = 0; i < end; i++) {
      const byte = bytes[i] ?? 0
      if (byte < 0x21 || byte > 0x7e)
        invalid("must contain one nonempty printable ASCII token, optionally followed by LF or CRLF")
    }
    key = bytes.subarray(0, end).toString("ascii")
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    failure =
      error instanceof ApiKeyFileError
        ? error
        : code === "ELOOP"
          ? new ApiKeyFileError(
              "API_KEY_FILE_INVALID",
              "CANDLE_API_KEY_FILE must not be a final-component symlink. Fix the file locally.",
            )
          : ["ENOSYS", "ENOTSUP"].includes(String(code))
            ? new ApiKeyFileError(
                "API_KEY_FILE_UNSUPPORTED",
                "CANDLE_API_KEY_FILE requires POSIX descriptor checks. Use an existing credential source or a supported host.",
              )
            : new ApiKeyFileError(
                "API_KEY_FILE_UNREADABLE",
                "Cannot read CANDLE_API_KEY_FILE. Check the configured path and access.",
              )
  } finally {
    if (fd !== undefined) {
      try {
        io.close(fd)
      } catch {
        failure ??= new ApiKeyFileError(
          "API_KEY_FILE_UNREADABLE",
          "Cannot close CANDLE_API_KEY_FILE. Check local file access.",
        )
      }
    }
  }
  if (failure) throw failure
  return key
}

/** Captures the original path/cwd and memoizes both success and failure in private memory. */
export function apiKeyFileSnapshot(
  env: Record<string, string | undefined>,
  load: (path: string) => string | Promise<string> = readApiKeyFile,
  cwd = process.cwd(),
): () => Promise<string | undefined> {
  env = { ...env }
  const selected = hasApiKeyFile(env)
  const path = selected ? resolve(cwd, env.CANDLE_API_KEY_FILE ?? "") : undefined
  let result: Promise<string | undefined> | undefined
  return () => {
    result ??= Promise.resolve().then(async () => {
      assertApiKeySources(env)
      if (path === undefined) return undefined
      try {
        return await load(path)
      } catch (error) {
        if (error instanceof ApiKeyFileError) throw error
        throw new ApiKeyFileError(
          "API_KEY_FILE_UNREADABLE",
          "Cannot read CANDLE_API_KEY_FILE. Check the configured path and access.",
        )
      }
    })
    return result
  }
}
