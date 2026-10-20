/**
 * The Launch tab's two core methods (BE-1680, spec S4 L-3 and L-4), both view only.
 *
 * `launch.uploadImage {path, confirmPublic, factor?}` uploads a local image with the Write key. The
 * upload is public and permanent even if no launch follows, so the view asks y/n first and the core
 * refuses (`UPLOAD_NOT_CONFIRMED`, no request) unless the answer came with the call. It runs under
 * an open paper or live window; with a factor and no window, the factor opens a paper window
 * first (A-5). A harness never uploads (invariant 16): it has no such method, and the core's tools
 * carry no `imagePath` (`executor.ts` registers them with `env: {}`).
 *
 * `launch.dryRun {cardId, factor?}` runs a `proposed` launch card's dry run (L-4 step 2).
 */
import { basename } from "node:path"
import type { CardBook } from "./cards"
import type { Journal } from "./journal"
import { refused } from "./rpc"
import type { CoreServer } from "./server"
import { parseFactor, type TradingState } from "./trading"

export interface LocalImageFile {
  path: string
  bytes: Uint8Array
  contentType: string
}

export interface LaunchHandlerDeps {
  cards: CardBook
  trading: TradingState
  journal: Journal
  /** Reads and checks the file (at most 10 MB; PNG, JPEG, GIF or WebP by its bytes). Throws a coded error. */
  readImage(path: string): Promise<LocalImageFile>
  /** `POST /api/v1/uploads/agent-image` with the Write key; returns the https URL. Throws a coded error. */
  uploadImage(writeKey: string, image: LocalImageFile): Promise<string>
}

export function registerLaunchHandlers(server: CoreServer, deps: LaunchHandlerDeps): void {
  server.handle("launch.uploadImage", async (params, { client }) => {
    if (params.confirmPublic !== true) {
      throw refused(
        "UPLOAD_NOT_CONFIRMED",
        "The image becomes public and permanent, even if you never launch. Confirm the upload first; nothing was sent.",
      )
    }
    const path = params.path
    if (typeof path !== "string" || path.length === 0 || path.length > 4096) {
      throw refused("INVALID_PARAMS", "path names the image file.")
    }
    const factor = parseFactor(params.factor)
    let image: LocalImageFile
    try {
      image = await deps.readImage(path)
    } catch (error) {
      throw coded(error, "IMAGE_UNREADABLE")
    }
    if (
      factor !== undefined &&
      !deps.trading.snapshot().paperWindow.open &&
      !deps.trading.snapshot().timedWindow.open
    ) {
      await deps.trading.openPaperWindow(client.clientId, 15, factor)
    }
    let imageUrl: string
    try {
      imageUrl = await deps.trading.withPaperCredentials((credentials) => deps.uploadImage(credentials.writeKey, image))
    } catch (error) {
      throw coded(error, "UPLOAD_FAILED")
    }
    await deps.journal.append({
      type: "image.upload",
      clientId: client.clientId,
      fileName: basename(image.path),
      size: image.bytes.length,
      contentType: image.contentType,
      imageUrl,
    })
    return { imageUrl, contentType: image.contentType, size: image.bytes.length }
  })

  server.handle("launch.dryRun", async (params, { client }) =>
    deps.cards.dryRun({ cardId: params.cardId, factor: parseFactor(params.factor) }, client.clientId),
  )
}

/** An error with a code becomes a refusal with that code; anything else gets `fallback`. */
function coded(error: unknown, fallback: string) {
  const failure = error as { code?: unknown; message?: unknown }
  if (failure !== null && typeof failure === "object" && "rpcCode" in failure) return error
  return refused(
    typeof failure?.code === "string" ? failure.code : fallback,
    typeof failure?.message === "string" ? failure.message : String(error),
  )
}
