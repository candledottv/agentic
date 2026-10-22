/**
 * `imagePath` on the two launch tools (BE-1346, spec
 * `2026-10-11-agent-launch-local-image-design.md`, 3.2).
 *
 *   POST /uploads/agent-image  -> { success: true, imageUrl }
 *
 * A launch takes its image as an https URL, and that does not change. A file on this machine is
 * uploaded first through the route Candle already has, and the launch is then made with the URL
 * that comes back: `imagePath` never reaches a launch route.
 *
 * Reading a file because a TOOL ARGUMENT names it is new for this server, which until now read
 * only the signer key file its own configuration names. Type and size checks do not bound that:
 * a recovery-phrase screenshot is still an image. So the capability exists only where the
 * operator set `CANDLE_IMAGE_DIR`, and only for files whose REAL path is inside that directory.
 * Everything outside it is refused in one sentence that says nothing about what is there.
 *
 * An upload is a publication. Candle pins the file to public storage, the URL cannot be taken
 * back, and a dry run uploads too, because the dry-run route fetches the image it validates.
 */
import { type BigIntStats, constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, sep } from "node:path"
import type { RequestConfig } from "./client"
import type { FetchLike } from "./orchestrate"
import { noteVersionHeaders } from "./update-notice"

/** The upload route's ceiling (`MAX_IMAGE_SIZE` in apps/api): a file of exactly this size is accepted. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** The one sentence every path outside the directory gets, whatever is or is not at it. */
export const OUTSIDE_IMAGE_DIR = "Image files must be inside the configured CANDLE_IMAGE_DIR."

const NOTHING_UPLOADED = "Nothing was uploaded."
const READ_CHUNK_BYTES = 256 * 1024

/** A refusal this server decided, before or instead of a request. `code` is what an agent branches on. */
export class ImageRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/**
 * The directory the operator granted, or undefined when they granted none. Only whether the
 * variable is SET is decided here, because that is what selects the launch schema at
 * registration; whether it names a usable directory is checked on every call (`realImageDir`),
 * and a value that does not is a refusal, never a fallback to reading anywhere.
 */
export function configuredImageDir(env: Record<string, string | undefined>): string | undefined {
  return env.CANDLE_IMAGE_DIR?.trim() || undefined
}

/** The file operations this module uses, injectable so a test can change a path between two of them. */
export interface ImageFileHandle {
  stat(options: { bigint: true }): Promise<BigIntStats>
  read(buffer: Uint8Array, offset: number, length: number, position: null): Promise<{ bytesRead: number }>
  close(): Promise<void>
}
export interface ImageFs {
  realpath(path: string): Promise<string>
  lstat(path: string, options: { bigint: true }): Promise<BigIntStats>
  open(path: string, flags: number): Promise<ImageFileHandle>
}
const nodeFs: ImageFs = { realpath, lstat, open }

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

/**
 * Strictly below `dir`, at a directory boundary. Both arguments are real paths. A string prefix
 * would let `/pics-private/x.png` pass for `/pics`; `relative` walks components, so that sibling
 * comes back as `../pics-private/x.png`. The directory itself is not inside itself.
 */
function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path)
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

/**
 * The real path of the configured directory. Refused unless it is an absolute path to an existing
 * directory, and refused when that directory is a filesystem root: a grant of the whole disk is
 * the unrestricted file access this variable exists to prevent.
 */
async function realImageDir(imageDir: string, fs: ImageFs): Promise<string> {
  const invalid = () =>
    new ImageRefusal(
      "IMAGE_DIR_INVALID",
      `CANDLE_IMAGE_DIR must be an absolute path to an existing directory, and not the filesystem root. ${NOTHING_UPLOADED}`,
    )
  if (!isAbsolute(imageDir)) throw invalid()
  try {
    const real = await fs.realpath(imageDir)
    if (dirname(real) === real || !(await fs.lstat(real, { bigint: true })).isDirectory()) throw invalid()
    return real
  } catch {
    throw invalid()
  }
}

/**
 * Whether a path that did not resolve is simply a name nobody has used yet inside the directory:
 * its nearest existing ancestor resolves inside, and nothing exists from there down. Anything
 * else is not shown to be inside, so it is not: a dangling link, a loop, a directory this user
 * may not enter. That keeps a link inside the directory from reporting on what it points at.
 */
async function missingInside(dirReal: string, path: string, fs: ImageFs): Promise<boolean> {
  const absent = (error: unknown) => errno(error) === "ENOENT" || errno(error) === "ENOTDIR"
  for (let current = path; ; ) {
    try {
      await fs.lstat(current, { bigint: true })
      return false
    } catch (error) {
      if (!absent(error)) return false
    }
    const parent = dirname(current)
    if (parent === current) return false
    try {
      const real = await fs.realpath(parent)
      return real === dirReal || isInside(dirReal, real)
    } catch (error) {
      if (!absent(error)) return false
      current = parent
    }
  }
}

export interface LocalImage {
  bytes: Uint8Array
  contentType: string
}

/**
 * Reads and checks an image file inside the configured directory, with no request made.
 *
 * The real path of the directory and of the file are resolved, and the file's must sit inside the
 * directory's. That real path is then opened ONCE, refusing a link in its last component, and the
 * rest is decided through the open handle: that it is a regular file, and how large it is, by
 * reading at most the ceiling plus one byte. No stat is trusted for the size and the file is
 * never reopened, so what is checked is what is uploaded.
 *
 * A path can be replaced between the resolution and the open. So after the open, the path must
 * still resolve to itself inside the directory and must still name the very file the handle
 * holds (same device and inode); otherwise the handle may be on a file outside, and the read is
 * refused. This is as far as path-based calls go: Node has no way to open relative to a directory
 * handle, so a writer who can swap the path several times between these calls is not excluded.
 */
export async function readImageInDir(
  imageDir: string,
  imagePath: string,
  fs: ImageFs = nodeFs,
  field: "imagePath" | "bannerPath" = "imagePath",
): Promise<LocalImage> {
  if (!isAbsolute(imagePath))
    throw new ImageRefusal(
      "MCP_VALIDATION",
      `${field} must be an absolute path inside CANDLE_IMAGE_DIR; this server's working directory is not something a caller can know. ${NOTHING_UPLOADED}`,
    )
  const dirReal = await realImageDir(imageDir, fs)
  const outside = () => new ImageRefusal("IMAGE_OUTSIDE_DIR", OUTSIDE_IMAGE_DIR)
  const unreadable = (why: string) =>
    new ImageRefusal("IMAGE_UNREADABLE", `Could not read the image at ${field}: ${why}. ${NOTHING_UPLOADED}`)
  const tooLarge = () =>
    new ImageRefusal(
      "IMAGE_TOO_LARGE",
      `The file at ${field} is over 10MB, the largest image Candle hosts. ${NOTHING_UPLOADED}`,
    )

  let fileReal: string
  try {
    fileReal = await fs.realpath(imagePath)
  } catch {
    throw (await missingInside(dirReal, imagePath, fs)) ? unreadable("there is no file at that path") : outside()
  }
  if (!isInside(dirReal, fileReal)) throw outside()

  let handle: ImageFileHandle
  try {
    // O_NOFOLLOW: `fileReal` held no link when it was resolved, so one there now was put there
    // since. O_NONBLOCK: opening a FIFO for reading would otherwise wait for a writer forever.
    // Both are absent on Windows, where the checks after the open still apply.
    handle = await fs.open(fileReal, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  } catch (error) {
    throw errno(error) === "ELOOP" ? outside() : unreadable("it could not be opened")
  }
  let bytes: Uint8Array
  try {
    const opened = await handle.stat({ bigint: true })
    let named: BigIntStats
    try {
      if ((await fs.realpath(fileReal)) !== fileReal || !isInside(await realImageDir(imageDir, fs), fileReal))
        throw outside()
      named = await fs.lstat(fileReal, { bigint: true })
    } catch {
      throw outside()
    }
    if (named.dev !== opened.dev || named.ino !== opened.ino) throw outside()
    if (!opened.isFile()) throw unreadable("it is not a regular file")

    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (total <= MAX_IMAGE_BYTES) {
        const want = Math.min(READ_CHUNK_BYTES, MAX_IMAGE_BYTES + 1 - total)
        const chunk = new Uint8Array(want)
        const { bytesRead } = await handle.read(chunk, 0, want, null)
        if (bytesRead === 0) break
        chunks.push(chunk.subarray(0, bytesRead))
        total += bytesRead
      }
    } catch {
      throw unreadable("the read failed")
    }
    // The count of what was read, not a stat taken earlier: a file that grew past the ceiling
    // while it was being read is refused here like one that was always too large.
    if (total > MAX_IMAGE_BYTES) throw tooLarge()
    bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
  } finally {
    await handle.close().catch(() => {})
  }

  const contentType = sniffImageType(bytes)
  if (!contentType)
    throw new ImageRefusal(
      "IMAGE_TYPE_UNSUPPORTED",
      `The file at ${field} is not a PNG, JPEG, GIF or WebP image. The type is read from the file's first bytes, not its name. ${NOTHING_UPLOADED}`,
    )
  return { bytes, contentType }
}

/** What a launch tool does about its image, decided before the launch request is built. */
export type LaunchImage =
  /**
   * The launch arguments to send: `imageUrl` (and `bannerUrl`) set, `imagePath` and `bannerPath` gone.
   * `uploaded` and `uploadedBanner` are the URLs an upload returned.
   */
  | { args: Record<string, unknown>; uploaded?: string; uploadedBanner?: string }
  /** Refused on this machine. No launch was attempted. */
  | { refused: { code: string; message: string } }
  /** The upload route refused. Its body, as sent. No launch was attempted. */
  | { uploadFailed: string }

type UploadKind = "image" | "banner"

/** POSTs one file to `/uploads/agent-image` (`?kind=banner` for a banner) and returns the https URL. */
async function uploadLocalImage(
  image: LocalImage,
  kind: UploadKind,
  cfg: RequestConfig,
  apiKey: string,
  doFetch: FetchLike,
): Promise<{ url: string } | { refused: { code: string; message: string } } | { uploadFailed: string }> {
  let res: Awaited<ReturnType<FetchLike>>
  try {
    res = await doFetch(
      `${cfg.apiUrl.replace(/\/$/, "")}/api/v1/uploads/agent-image${kind === "banner" ? "?kind=banner" : ""}`,
      {
        method: "POST",
        headers: { "Content-Type": image.contentType, "x-api-key": apiKey },
        body: image.bytes as BodyInit,
      },
    )
  } catch (error) {
    return {
      refused: {
        code: "MCP_TRANSPORT",
        message:
          `The ${kind} upload failed in transit (${error instanceof Error ? error.message : String(error)}). ` +
          "No launch was attempted. The upload may or may not have reached Candle; if it did, the file is public.",
      },
    }
  }
  noteVersionHeaders(res)
  const text = await res.text()
  if (!res.ok) return { uploadFailed: text }
  let uploaded: unknown
  try {
    uploaded = (JSON.parse(text) as { imageUrl?: unknown } | null)?.imageUrl
  } catch {
    uploaded = undefined
  }
  if (typeof uploaded !== "string" || !uploaded.startsWith("https://"))
    return {
      refused: {
        code: "MCP_TRANSPORT",
        message: `Candle did not return an https URL for the uploaded ${kind}. No launch was attempted.`,
      },
    }
  return { url: uploaded }
}

/**
 * Turns a launch call's image inputs into the `imageUrl` and `bannerUrl` the launch routes take.
 *
 * With no directory configured this is today's behaviour: the arguments pass through, and the URLs
 * are the API's to validate. `imagePath` and `bannerPath` are not in that schema, so the MCP SDK
 * drops them before a handler runs; a caller that reaches the handler another way is refused here
 * rather than served, and no file is read.
 *
 * With one configured, exactly one of `imageUrl` and `imagePath` is required, and both or neither
 * is refused before any file is read or any request made. `bannerPath` is optional and never
 * combined with `bannerUrl`. Every file is read and checked before the first upload, so a bad
 * banner file cannot cost a public image upload. The banner goes to the upload route with
 * `kind=banner`, which hosts it uncropped and checks it is wide.
 */
export async function resolveLaunchImage(
  args: Record<string, unknown>,
  imageDir: string | undefined,
  cfg: RequestConfig,
  doFetch: FetchLike,
  fs: ImageFs = nodeFs,
): Promise<LaunchImage> {
  const { imagePath, bannerPath, ...rest } = args
  const hasPath = typeof imagePath === "string" && imagePath.length > 0
  const hasUrl = typeof rest.imageUrl === "string" && rest.imageUrl.length > 0
  const hasBannerPath = typeof bannerPath === "string" && bannerPath.length > 0
  const hasBannerUrl = typeof rest.bannerUrl === "string" && rest.bannerUrl.length > 0
  const invalid = (message: string): LaunchImage => ({ refused: { code: "MCP_VALIDATION", message } })

  if (imageDir === undefined) {
    if (imagePath !== undefined)
      return invalid(
        `imagePath is not available on this server: no CANDLE_IMAGE_DIR is configured. Pass imageUrl, an https URL. ${NOTHING_UPLOADED}`,
      )
    if (bannerPath !== undefined)
      return invalid(
        `bannerPath is not available on this server: no CANDLE_IMAGE_DIR is configured. Pass bannerUrl, an https URL. ${NOTHING_UPLOADED}`,
      )
    return { args: rest }
  }
  if (hasPath && hasUrl) return invalid(`Pass exactly one of imageUrl or imagePath, not both. ${NOTHING_UPLOADED}`)
  if (hasBannerPath && hasBannerUrl)
    return invalid(`Pass at most one of bannerUrl or bannerPath, not both. ${NOTHING_UPLOADED}`)
  if (!hasPath && !hasUrl)
    return invalid(
      "Pass imageUrl (an https URL) or imagePath (an absolute path to an image file inside CANDLE_IMAGE_DIR).",
    )
  if (!hasPath && !hasBannerPath) return { args: rest }
  if (!cfg.apiKey)
    return invalid(
      `CANDLE_AGENT_API_KEY is required to upload an image; the key needs the launch:write scope. ${NOTHING_UPLOADED}`,
    )

  const read = async (path: string, field: "imagePath" | "bannerPath") => {
    try {
      return await readImageInDir(imageDir, path, fs, field)
    } catch (error) {
      if (error instanceof ImageRefusal) return { refused: { code: error.code, message: error.message } }
      throw error
    }
  }
  let image: LocalImage | undefined
  let banner: LocalImage | undefined
  if (hasPath) {
    const result = await read(imagePath, "imagePath")
    if ("refused" in result) return result
    image = result
  }
  if (hasBannerPath) {
    const result = await read(bannerPath, "bannerPath")
    if ("refused" in result) return result
    banner = result
  }

  const launchArgs: Record<string, unknown> = { ...rest }
  let uploaded: string | undefined
  let uploadedBanner: string | undefined
  if (image) {
    const result = await uploadLocalImage(image, "image", cfg, cfg.apiKey, doFetch)
    if (!("url" in result)) return result
    uploaded = result.url
    launchArgs.imageUrl = uploaded
  }
  if (banner) {
    const result = await uploadLocalImage(banner, "banner", cfg, cfg.apiKey, doFetch)
    if (!("url" in result)) {
      if (uploaded === undefined) return result
      // The image is already public: say where, so the retry passes imageUrl instead of the file.
      const why = "refused" in result ? result.refused.message : result.uploadFailed
      return invalid(
        `The banner upload failed: ${why} The image was already uploaded to ${uploaded}; pass that as imageUrl on the retry. No launch was attempted.`,
      )
    }
    uploadedBanner = result.url
    launchArgs.bannerUrl = uploadedBanner
  }
  return { args: launchArgs, ...(uploaded ? { uploaded } : {}), ...(uploadedBanner ? { uploadedBanner } : {}) }
}

/** The envelope the launch routes use for a refusal, so an agent branches on `error.code` either way. */
export function imageRefusalBody(refused: { code: string; message: string }, extra?: Record<string, unknown>): string {
  return JSON.stringify({ ...extra, success: false, error: { code: refused.code, message: refused.message } })
}

/** What a result says about an upload it made, whether or not the launch that followed succeeded. */
export const UPLOADED_IMAGE_NOTE =
  "imagePath was uploaded to imageUrl, which is public and permanent. To retry, or to launch after a dry run, pass this imageUrl instead of imagePath, so the file is not uploaded again."

/** The same note for a `bannerPath` upload; `bannerUrl` is the field to pass on a retry. */
export const UPLOADED_BANNER_NOTE =
  "bannerPath was uploaded to bannerUrl, which is public and permanent. To retry, or to launch after a dry run, pass this bannerUrl instead of bannerPath, so the file is not uploaded again."

/** The URLs and notes a result reports for the files this server uploaded, whether or not the launch succeeded. */
export function uploadedFields(image: { uploaded?: string; uploadedBanner?: string }): Record<string, string> {
  return {
    ...(image.uploaded !== undefined ? { imageUrl: image.uploaded, imageNote: UPLOADED_IMAGE_NOTE } : {}),
    ...(image.uploadedBanner !== undefined
      ? { bannerUrl: image.uploadedBanner, bannerNote: UPLOADED_BANNER_NOTE }
      : {}),
  }
}
