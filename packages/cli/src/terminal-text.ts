/** Escape untrusted text before measuring, wrapping or adding the CLI's own terminal styles.
 * Escaping ESC also neutralizes CSI/OSC/DCS sequences without swallowing their visible payload.
 * JSON and stored/request values must never pass through this display-only helper. */
export function escapeTerminalText(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: these are the terminal controls being escaped.
  return value.replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g, (char) => {
    if (char === "\n") return "\\n"
    if (char === "\r") return "\\r"
    return `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`
  })
}

/** Composed human blocks deliberately contain line breaks. Escape each line's content while
 * retaining that layout; use escapeTerminalText for individual values such as labels and names. */
export function terminalLines(value: string): string {
  return value.split("\n").map(escapeTerminalText).join("\n")
}
