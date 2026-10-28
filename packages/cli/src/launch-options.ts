import { LAUNCH_DEFINITION } from "./launch-definition"

/** Local file input is an alternative source for imageUrl, rather than another wire field. */
export const LAUNCH_IMAGE_FLAG = "--image"
export const LAUNCH_CLI_CONTROLS = ["--check", "--yes", "--rpc-url", "--json"] as const
export const launchFlagFields = LAUNCH_DEFINITION.fields.flatMap((field) =>
  "flag" in field.surfaces.cli ? [{ ...field, cli: field.surfaces.cli }] : [],
)
export const launchFlagRows = launchFlagFields.map((field) => ({
  invocation: `${field.cli.flag}${"value" in field.cli ? ` ${field.cli.value}` : ""}`,
  description: field.help,
  ...("more" in field ? { more: field.more } : {}),
}))
export const LAUNCH_USAGE = `candle launch ${launchFlagFields
  .map((field) => {
    const invocation = `${field.cli.flag}${"value" in field.cli ? ` ${field.cli.value}` : ""}`
    if (field.key === "imageUrl") return `--image <path>|${invocation}`
    return "required" in field && field.required ? invocation : `[${invocation}]`
  })
  .join(" ")} [--check] [--yes] [--rpc-url <url>] [--json]`

/** Generic local checks use the same field ranges and enums as the help. The server remains authoritative. */
export function launchFieldProblem(flags: Record<string, string>): string | undefined {
  for (const field of launchFlagFields) {
    const value = flags[field.cli.flag]
    if (value === undefined) continue
    if ("values" in field && !field.values.some((option) => String(option) === value))
      return `${field.cli.flag} takes ${field.values.join(", ")}.`
    if (field.type === "url" && field.key.startsWith("socials.")) {
      try {
        const url = new URL(value)
        if (!["http:", "https:"].includes(url.protocol) || !url.hostname) throw new Error()
      } catch {
        return `${field.cli.flag} takes an absolute http(s) URL.`
      }
    }
    if (field.type === "decimal" && value.trim() !== "" && !/^\d+(\.\d+)?$/.test(value))
      return `${field.cli.flag} takes a whole-unit decimal amount.`
    if (field.type === "integer" && !/^\d+$/.test(value)) return `${field.cli.flag} takes a whole number.`
    if ("range" in field) {
      const range = field.range
      const byQuote = "byQuote" in range ? range.byQuote : undefined
      const quote = flags["--quote-asset"] ?? "sol"
      const bounds = byQuote ? byQuote[quote as keyof typeof byQuote] : range
      if (field.type === "integer" || field.type === "decimal") {
        const number = Number(value)
        if (
          !Number.isFinite(number) ||
          (bounds &&
            (("min" in bounds && number < Number(bounds.min)) || ("max" in bounds && number > Number(bounds.max))))
        )
          return `${field.cli.flag} is outside the allowed range. ${field.help}`
      } else if (
        range.unit === "UTF-8 bytes" &&
        "max" in range &&
        new TextEncoder().encode(value.trim()).length > Number(range.max)
      )
        return `${field.cli.flag} is too long. ${field.help}`
    }
  }
  return undefined
}
