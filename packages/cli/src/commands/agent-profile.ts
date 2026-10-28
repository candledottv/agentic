import { parseArgs } from "../args"
import { apiRequest } from "../client"
import type { CommandContext } from "../deps"
import { notice } from "../presentation"
import { terminalText, writeFailure, writeUsageFailure } from "../render"
import { TradingError, tradingKey } from "../trading"
import { type LocalImage, readLocalImage } from "./image"
import { tradingFailure } from "./swap"

const FLAGS = {
  "--bio": "publicThesis",
  "--strategy": "publicStrategy",
  "--strategy-note": "publicStrategyNote",
  "--avatar": "publicAvatar",
  "--banner": "publicBanner",
  "--models": "publicModels",
  "--links": "publicLinks",
} as const
const USAGE =
  "Usage: candle agent profile show | set [--bio <text>] [--strategy <tag>] [--strategy-note <text>] [--models <comma-separated>] [--links <JSON>] [--avatar <URL> | --avatar-file <path>] [--banner <URL> | --banner-file <path>]"
const FILE_FLAGS = ["--avatar-file", "--banner-file"]

export async function agentProfile(args: string[], ctx: CommandContext): Promise<number> {
  const action = args[0]
  const parsed = parseArgs(args.slice(1), { valueFlags: [...Object.keys(FLAGS), ...FILE_FLAGS], pathFlags: FILE_FLAGS })
  if (
    "error" in parsed ||
    (action !== "show" && action !== "set") ||
    parsed.positionals.length ||
    (action === "show" && Object.keys(parsed.values).length) ||
    (action === "set" && !Object.keys(parsed.values).length)
  ) {
    writeUsageFailure(ctx.deps, "error" in parsed ? `${parsed.error}\n${USAGE}` : USAGE, ctx.json)
    return 2
  }
  const patch: Record<string, unknown> = {}
  for (const kind of ["avatar", "banner"]) {
    if (parsed.values[`--${kind}`] !== undefined && parsed.values[`--${kind}-file`] !== undefined) {
      writeUsageFailure(ctx.deps, `Pass --${kind} or --${kind}-file, never both.`, ctx.json)
      return 2
    }
  }
  for (const [flag, value] of Object.entries(parsed.values)) {
    if (FILE_FLAGS.includes(flag)) continue
    const field = FLAGS[flag as keyof typeof FLAGS]
    if (field === "publicModels") patch[field] = value === "" ? null : value?.split(",").map((item) => item.trim())
    else if (field === "publicLinks") {
      try {
        patch[field] = JSON.parse(value ?? "")
      } catch {
        writeUsageFailure(ctx.deps, "--links must be JSON (website and x, or null)", ctx.json)
        return 2
      }
    } else patch[field] = value
  }
  try {
    // Check every file before making any write, including a text PATCH.
    const images: { kind: "avatar" | "banner"; image: LocalImage }[] = []
    for (const kind of ["avatar", "banner"] as const) {
      const path = parsed.values[`--${kind}-file`]
      if (path !== undefined) images.push({ kind, image: await readLocalImage(path) })
    }
    const key = await tradingKey(ctx)
    const options = {
      apiUrl: ctx.apiUrl,
      credentials: { apiKey: key },
      auth: "key" as const,
      fetch: ctx.deps.fetch,
      env: ctx.deps.env,
    }
    let body: unknown
    if (action === "show" || Object.keys(patch).length) {
      const result = await apiRequest("/api/v1/agent/keys/self/public-profile", {
        ...options,
        method: action === "show" ? "GET" : "PATCH",
        ...(action === "set" ? { body: patch } : {}),
      })
      if (!result.ok) {
        writeFailure(ctx.deps, result, { apiUrl: ctx.apiUrl, authType: "key" }, ctx.json)
        return 1
      }
      body = result.body
    }
    const uploaded: Record<string, string> = {}
    for (const { kind, image } of images) {
      notice(
        ctx.deps,
        "stderr",
        ctx.json ? "note" : "warning",
        `Publishing profile ${kind}: the image and its metadata become public on uploads.candle.tv. Upload only artwork meant to be public.`,
      )
      const form = new FormData()
      form.set("kind", kind)
      form.set("image", new Blob([image.bytes as BlobPart], { type: image.contentType }), "profile.image")
      const result = await apiRequest("/api/v1/uploads/agent-profile-image", { ...options, method: "POST", form })
      if (!result.ok) {
        writeFailure(ctx.deps, result, { apiUrl: ctx.apiUrl, authType: "key" }, ctx.json)
        return 1
      }
      body = result.body
      const imageUrl = (body as { imageUrl?: unknown } | null)?.imageUrl
      if (typeof imageUrl !== "string" || !imageUrl.startsWith("https://uploads.candle.tv/"))
        throw new TradingError(
          "INVALID_RESPONSE",
          "Candle did not return an uploads.candle.tv URL for the profile image.",
        )
      uploaded[kind] = imageUrl
    }
    if (images.length) body = { ...(body as object), images: uploaded }
    const output = JSON.stringify(body, null, ctx.json ? undefined : 2)
    ctx.deps.stdout.write(`${ctx.json ? output : terminalText(output)}\n`)
    return 0
  } catch (err) {
    return tradingFailure(ctx, err)
  }
}
