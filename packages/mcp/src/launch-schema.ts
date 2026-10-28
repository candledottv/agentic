/**
 * Launch input built from the generated copy of LAUNCH_DEFINITION.
 *
 * M1 (BE-2137) exposes every MCP key except `wallet` and `buy`. Those two, and the
 * `candle_launch` name, wait for M2: adding them needs the held core approval card.
 * `buyAmount` and `devBuy` stay as the legacy buy inputs on the old tool names.
 */
import { z } from "zod"
import { LAUNCH_DEFINITION } from "./launch-definition"

const M2_TOP_KEYS = new Set(["wallet", "buy"])
const GROUPED_TOP_KEYS = new Set(["socials", "curve", "poolFee"])

type LaunchField = (typeof LAUNCH_DEFINITION.fields)[number]

function mcpKey(field: LaunchField): string | undefined {
  const surface = field.surfaces.mcp
  return "key" in surface ? surface.key : undefined
}

function topKey(key: string): string {
  return key.split(".")[0] ?? key
}

export function mcpLaunchFields(): LaunchField[] {
  return LAUNCH_DEFINITION.fields.filter((field) => {
    const key = mcpKey(field)
    return key !== undefined && !M2_TOP_KEYS.has(topKey(key))
  })
}

/** Top-level MCP keys this release registers. Excludes wallet and buy (M2). */
export function mcpLaunchTopKeys(): string[] {
  const keys: string[] = []
  for (const field of mcpLaunchFields()) {
    const key = mcpKey(field)
    if (!key) continue
    const top = topKey(key)
    if (!keys.includes(top)) keys.push(top)
  }
  return keys
}

export const TOKEN_LEGACY_KEYS = ["buyAmount"] as const
export const SEED_LEGACY_KEYS = ["devBuy"] as const
/** Present only when CANDLE_IMAGE_DIR is set. Not launch-definition fields. */
export const MCP_IMAGE_PATH_KEYS = ["imagePath", "bannerPath"] as const

export const LAUNCH_SHARED_SENTENCES = mcpLaunchFields()
  .map((field) => field.help)
  .join(" ")

function fieldByKey(key: string): LaunchField {
  const field = LAUNCH_DEFINITION.fields.find((item) => item.key === key)
  if (!field) throw new Error(`Missing launch field ${key}`)
  return field
}

export function launchFieldHelp(key: string): string {
  return fieldByKey(key).help
}

function stringValues(key: string): [string, ...string[]] {
  const field = fieldByKey(key)
  const values = "values" in field ? field.values : undefined
  if (!values || values.some((value) => typeof value !== "string")) {
    throw new Error(`Expected string values for ${key}`)
  }
  return [...values] as [string, ...string[]]
}

function numberValues(key: string): [number, number, ...number[]] {
  const field = fieldByKey(key)
  const values = "values" in field ? field.values : undefined
  if (!values || values.length < 2 || values.some((value) => typeof value !== "number")) {
    throw new Error(`Expected number values for ${key}`)
  }
  return [...values] as [number, number, ...number[]]
}

function rangeMax(key: string): number {
  const field = fieldByKey(key)
  if (!("range" in field) || field.range === undefined || !("max" in field.range)) {
    throw new Error(`Missing max for ${key}`)
  }
  return Number(field.range.max)
}

function numberEnum(key: string) {
  const [first, second, ...rest] = numberValues(key)
  return z.union([z.literal(first), z.literal(second), ...rest.map((value) => z.literal(value))])
}

function described(schema: z.ZodTypeAny, help: string, required: boolean) {
  return required ? schema.describe(help) : schema.optional().describe(help)
}

function isRequired(field: LaunchField): boolean {
  return ("required" in field && field.required === true) || field.key === "clientLaunchId"
}

export function launchSchemaField(shape: Record<string, z.ZodTypeAny>, key: string): z.ZodTypeAny {
  const field = shape[key]
  if (!field) throw new Error(`Missing launch schema field ${key}`)
  return field
}

export const SOCIAL_KEYS = mcpLaunchFields().flatMap((field) => {
  const key = mcpKey(field)
  return key?.startsWith("socials.") ? [key.slice("socials.".length)] : []
})

const SOCIALS_ONLY = `socials accepts only ${SOCIAL_KEYS.join(", ")}.`

/** Unknown or non-URL socials, refused before any upload or request. */
export function socialsRefusal(
  socials: unknown,
): { code: "VALIDATION_FAILED"; message: string; field: string } | undefined {
  if (socials === undefined) return undefined
  if (!socials || typeof socials !== "object" || Array.isArray(socials)) {
    return { code: "VALIDATION_FAILED", message: SOCIALS_ONLY, field: "socials" }
  }
  for (const [key, value] of Object.entries(socials)) {
    if (!SOCIAL_KEYS.includes(key)) return { code: "VALIDATION_FAILED", message: SOCIALS_ONLY, field: "socials" }
    if (value === undefined) continue
    try {
      if (typeof value !== "string") throw new Error("not a string")
      const url = new URL(value)
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("not http(s)")
    } catch {
      return { code: "VALIDATION_FAILED", message: `${key} must be an http(s) URL.`, field: `socials.${key}` }
    }
  }
  return undefined
}

function socialsSchema() {
  const shape: Record<string, z.ZodTypeAny> = {}
  const helps: string[] = []
  for (const field of mcpLaunchFields()) {
    const key = mcpKey(field)
    if (!key?.startsWith("socials.")) continue
    shape[key.slice("socials.".length)] = z.string().optional().describe(field.help)
    helps.push(field.help)
  }
  // Passthrough keeps an unknown key on the object so the handler can refuse it with
  // VALIDATION_FAILED. strict() would fail inside the MCP SDK before that envelope exists.
  return z.object(shape).passthrough().optional().describe(helps.join(" "))
}

function curveSchema() {
  const virtual = launchFieldHelp("curve.virtualQuote")
  const threshold = launchFieldHelp("curve.threshold")
  return z
    .object({
      virtualQuote: z.string().describe(virtual),
      threshold: z.string().describe(threshold),
    })
    .strict()
    .optional()
    .describe(`${virtual} ${threshold}`)
}

function poolFeeSchema() {
  const tierHelp = launchFieldHelp("poolFee.tier")
  const startHelp = launchFieldHelp("poolFee.startBps")
  const endHelp = launchFieldHelp("poolFee.endBps")
  const minutesHelp = launchFieldHelp("poolFee.minutes")
  return z
    .union([
      z.object({ tier: numberEnum("poolFee.tier").describe(tierHelp) }).strict(),
      z
        .object({
          startBps: z.number().int().max(rangeMax("poolFee.startBps")).describe(startHelp),
          endBps: numberEnum("poolFee.endBps").describe(endHelp),
          minutes: z.number().positive().max(rangeMax("poolFee.minutes")).describe(minutesHelp),
        })
        .strict(),
    ])
    .optional()
    .describe([tierHelp, startHelp, endHelp, minutesHelp].join(" "))
}

function scalarSchema(field: LaunchField): z.ZodTypeAny {
  const values = "values" in field ? field.values : undefined
  let schema: z.ZodTypeAny
  if (values?.every((value) => typeof value === "number")) schema = numberEnum(field.key)
  else if (values?.every((value) => typeof value === "string")) schema = z.enum(stringValues(field.key))
  else if (field.type === "boolean") schema = z.boolean()
  else if (field.type === "integer" || ("wireType" in field && field.wireType === "number")) schema = z.number()
  else schema = z.string()
  return described(schema, field.help, isRequired(field))
}

const BUY_AMOUNT_DESCRIPTION = "Initial buy, in quote base units (string or number)"
const DEV_BUY_DESCRIPTION =
  'Seed buy in DECIMAL units of the quote asset this launch selects (e.g. "0.25" SOL, or ' +
  "ETH on hood), paid from the account's embedded wallet; the tool's description says how " +
  "each chain sends it. Follows quoteAsset, which defaults to sol on solana and eth on hood. " +
  "Capped by the platform dev-buy ceiling; for a larger seed, launch then follow with candle_trade."

export function buildLaunchTokenShape(): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const field of mcpLaunchFields()) {
    const key = mcpKey(field)
    if (!key) continue
    const top = topKey(key)
    if (GROUPED_TOP_KEYS.has(top) || top in shape) continue
    shape[top] = scalarSchema(field)
  }
  shape.socials = socialsSchema()
  shape.curve = curveSchema()
  shape.poolFee = poolFeeSchema()
  shape.buyAmount = z.union([z.string(), z.number()]).optional().describe(BUY_AMOUNT_DESCRIPTION)
  return shape
}

export const launchTokenShape = buildLaunchTokenShape()

export const launchAndSeedShape: Record<string, z.ZodTypeAny> = (() => {
  const { buyAmount: _rawBuyAmount, ...seedable } = launchTokenShape
  return {
    ...seedable,
    clientLaunchId: z
      .string()
      .optional()
      .describe(`${launchFieldHelp("clientLaunchId")} Auto-generated when omitted and echoed in the result.`),
    devBuy: z.string().optional().describe(DEV_BUY_DESCRIPTION),
  }
})()
