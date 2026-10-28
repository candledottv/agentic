// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal SGR sequences in captured output.
const SGR = /\x1b\[[0-9;]*m/g

/** Compare the words of a safety notice independently of wrapping and terminal color.
 * Use exact assertions for layout, machine output, copyable values and confirmation prompts. */
export function humanText(text: string): string {
  return text.replace(SGR, "").replace(/\s+/g, " ").trim()
}
