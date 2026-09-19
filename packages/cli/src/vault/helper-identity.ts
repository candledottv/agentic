/** Syntax shared by the vault reader and the codesign trust boundary. */
export function isHelperTeamId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z0-9]{10}$/.test(value)
}

export function isHelperBundleId(value: unknown): value is string {
  return (
    typeof value === "string" && /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?:\.[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)+$/.test(value)
  )
}
