/**
 * `candle image upload <path>`, and the image half of `candle launch --image <path>` (BE-1283, spec
 * `2026-10-11-agent-launch-local-image-design.md`, 3.1).
 *
 *   POST /uploads/agent-image  -> { success: true, imageUrl }
 *
 * A launch takes its image as an https URL, and that does not change. A file on this machine is
 * uploaded first through the route Candle already has, and the URL that comes back is what the
 * launch is made with. The file is checked here before any request: it must be a regular file of at
 * most 10MB whose first bytes are a PNG, JPEG, GIF or WebP. The server trusts the content type it is
 * sent, so the type comes from the bytes and never from the file's name.
 *
 * An upload is a publication. Candle pins the file to public storage and the URL cannot be taken
 * back, so both callers say so on stderr before the request. It spends no funds and does not count
 * against the daily launch cap; the key's own uploads-per-minute limit applies.
 */

import { open } from "node:fs/promises"
import { parseArgs } from "../args"
import { apiRequest } from "../client"
import { type CommandContext, resolveApiKey } from "../deps"
import { notice } from "../presentation"
import { safeText, TradingError } from "../trading"
import {
  writeScreenLocalFailure as writeLocalFailure,
  writeScreenUsageFailure as writeUsageFailure,
} from "./key-output"
import { tradingFailure } from "./swap"

const UPLOAD_USAGE = "Usage: candle image upload <path> [--banner] [--json]"

/** The upload route's ceiling (`MAX_IMAGE_SIZE` in apps/api): a file of exactly this size is accepted. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

const IMAGE_TYPES = "PNG, JPEG, GIF or WebP"
const NOTHING_UPLOADED = "Nothing was uploaded."

export interface LocalImage {
  path: string
  bytes: Uint8Array
  contentType: string
}

/** The image type a file's first bytes declare, or undefined for anything but the four Candle hosts. */
export function sniffImageType(bytes: Uint8Array): string | undefined {
  const at = (offset: number, signature: number[]) => signature.every((byte, i) => bytes[offset + i] === byte)
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg"
  // "GIF87a" or "GIF89a".
  if (at(0, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61)
    return "image/gif"
  // A RIFF container whose form type is "WEBP".
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp"
  return undefined
}

function unreadable(path: string, error: unknown): TradingError {
  const code = (error as NodeJS.ErrnoException).code
  const why =
    code === "ENOENT" || code === "ENOTDIR"
      ? "there is no file at that path"
      : code === "EACCES" || code === "EPERM"
        ? "this user may not read it"
        : code === "EISDIR"
          ? "it is not a file"
          : `the read failed${code ? ` (${code})` : ""}`
  return new TradingError("IMAGE_UNREADABLE", `Could not read ${safeText(path)}: ${why}. ${NOTHING_UPLOADED}`)
}

/**
 * Reads and checks an image file, with no request made. The read stops one byte past the ceiling,
 * so a file of any size costs at most that much memory before it is refused.
 */
export async function readLocalImage(path: string): Promise<LocalImage> {
  const tooLarge = () =>
    new TradingError(
      "IMAGE_TOO_LARGE",
      `${safeText(path)} is over 10MB, the largest image Candle hosts. ${NOTHING_UPLOADED}`,
    )
  let bytes: Uint8Array
  try {
    const file = await open(path, "r")
    try {
      const stat = await file.stat()
      if (!stat.isFile()) throw Object.assign(new Error("not a regular file"), { code: "EISDIR" })
      if (stat.size > MAX_IMAGE_BYTES) throw tooLarge()
      const buffer = new Uint8Array(MAX_IMAGE_BYTES + 1)
      let total = 0
      while (total < buffer.length) {
        const { bytesRead } = await file.read(buffer, total, buffer.length - total, null)
        if (bytesRead === 0) break
        total += bytesRead
      }
      bytes = buffer.slice(0, total)
    } finally {
      await file.close()
    }
  } catch (error) {
    throw error instanceof TradingError ? error : unreadable(path, error)
  }
  // The file grew past the ceiling between the stat and the read.
  if (bytes.length > MAX_IMAGE_BYTES) throw tooLarge()
  const contentType = sniffImageType(bytes)
  if (!contentType)
    throw new TradingError(
      "IMAGE_TYPE_UNSUPPORTED",
      `${safeText(path)} is not a ${IMAGE_TYPES} image. The type is read from the file's first bytes, not its name. ${NOTHING_UPLOADED}`,
    )
  return { path, bytes, contentType }
}

/** What both callers print before the request: the upload cannot be taken back. */
export function uploadNotice(image: LocalImage): string {
  return `Uploading ${safeText(image.path)} (${image.contentType}, ${image.bytes.length} bytes). The file becomes public and permanent: Candle pins it, and the URL cannot be withdrawn.\n`
}

/**
 * Posts the bytes under the key and returns the hosted URL. A refusal is the server's own code and
 * message (`RATE_LIMITED`, `UPLOAD_INVALID`, a missing `launch:write`), passed through as sent.
 */
export async function uploadImage(
  ctx: CommandContext,
  key: string,
  image: LocalImage,
  kind: "image" | "banner" = "image",
): Promise<string> {
  const result = await apiRequest(`/api/v1/uploads/agent-image${kind === "banner" ? "?kind=banner" : ""}`, {
    apiUrl: ctx.apiUrl,
    credentials: { apiKey: key },
    auth: "key",
    method: "POST",
    raw: { bytes: image.bytes, contentType: image.contentType },
    fetch: ctx.deps.fetch,
    env: ctx.deps.env,
  })
  if (!result.ok) throw new TradingError(result.code ?? "REQUEST_FAILED", result.message)
  const imageUrl = (result.body as { imageUrl?: unknown } | null | undefined)?.imageUrl
  if (typeof imageUrl !== "string" || !imageUrl.startsWith("https://"))
    throw new TradingError("INVALID_RESPONSE", "Candle did not return an https URL for the uploaded image.")
  return imageUrl
}

export async function imageUpload(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseArgs(args, { pathPositionals: ["<path>"], booleanFlags: ["--banner"] })
  if ("error" in parsed) {
    writeUsageFailure(ctx.deps, parsed.error, ctx.json)
    return 2
  }
  const [path, ...rest] = parsed.positionals
  if (path === undefined || rest.length !== 0) {
    writeUsageFailure(ctx.deps, UPLOAD_USAGE, ctx.json)
    return 2
  }
  try {
    const image = await readLocalImage(path)
    const key = await resolveApiKey(ctx.deps, ctx.profile)
    if (!key) {
      writeLocalFailure(
        ctx.deps,
        {
          code: "NO_API_KEY",
          message: `No API key available. ${NOTHING_UPLOADED}`,
          suggestion: "Run: candle auth login, or set CANDLE_API_KEY. The key needs the launch:write scope.",
        },
        ctx.json,
      )
      return 1
    }
    if (ctx.json) notice(ctx.deps, "stderr", "note", uploadNotice(image).trim())
    else notice(ctx.deps, "stderr", "warning", uploadNotice(image).trimEnd())
    const banner = parsed.booleans.has("--banner")
    const imageUrl = safeText(await uploadImage(ctx, key, image, banner ? "banner" : "image"))
    ctx.deps.stdout.write(
      ctx.json
        ? `${JSON.stringify({ success: true, imageUrl, contentType: image.contentType, bytes: image.bytes.length })}\n`
        : `${imageUrl}\n`,
    )
    return 0
  } catch (error) {
    return tradingFailure(ctx, error)
  }
}
