/**
 * The output kit (BE-2098; CLI legibility audit 2026-10-27, sections 3 and 5 step 1): headings,
 * fields, notices, success and failure lines, the width-aware table, short ids, short UTC times,
 * compact USD, the missing mark, and errors as message plus fix. No command uses these yet; the
 * tests pin each piece in plain mode (exact strings) and in color (escape codes only where meant).
 */

import { describe, expect, test } from "bun:test"
import { writeFields } from "./human-output"
import { run } from "./index"
import {
  bold,
  dim,
  estimateDisplayWidth,
  failure,
  fields,
  fullIds,
  heading,
  notice,
  PROSE_MAX,
  proseWidth,
  renderNotice,
  success,
  symbols,
  type TerminalStyle,
  terminalStyle,
} from "./presentation"
import {
  errorParts,
  formatAgo,
  formatTime,
  MISSING,
  renderError,
  renderErrorBlock,
  renderTable,
  shortId,
  suggestionFor,
} from "./render"
import { createCapture, createFakeStore, createRoutedFetch, createTestDeps, jsonResponse } from "./test-support"
import { formatUsd, shortAddress } from "./usd"

// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape codes are what is asserted.
const SGR = /\x1b\[[0-9;]*m/g
const clean = (text: string) => text.replace(SGR, "")

const plain = (width = 80): TerminalStyle => ({ width, styled: false, color: 0, theme: "light", motion: false })

/** `Bun.stringWidth`, without importing the `bun` package (the CLI declares no dependency on it). */
function terminalColumns(text: string): number {
  const measure = (globalThis as { Bun?: { stringWidth?: (value: string) => number } }).Bun?.stringWidth
  if (!measure) throw new Error("Bun.stringWidth is required for these width assertions")
  return measure(text)
}

function expectWithin(lines: readonly string[], width: number) {
  for (const line of lines) expect(terminalColumns(line)).toBeLessThanOrEqual(width)
}
const noColor = (width = 80): TerminalStyle => ({ width, styled: true, color: 0, theme: "dark", motion: false })
const color = (width = 80): TerminalStyle => ({ width, styled: true, color: 256, theme: "dark", motion: true })

const unusedFetch = (() => {
  throw new Error("the kit must not fetch")
}) as unknown as typeof fetch

describe("symbols and the missing mark", () => {
  test("Unicode on a terminal, ASCII in plain mode; --no-color keeps the Unicode set", () => {
    expect(symbols(color())).toEqual({ ok: "✓", warning: "!", danger: "✗", note: "·", ellipsis: "…", missing: "–" })
    expect(symbols(noColor())).toEqual(symbols(color()))
    expect(symbols(plain())).toEqual({ ok: "ok", warning: "!", danger: "x", note: "-", ellipsis: "...", missing: "-" })
    expect(MISSING).toBe("–")
  })

  test("prose is capped at 100 columns, and is never wider than the terminal", () => {
    expect(PROSE_MAX).toBe(100)
    expect(proseWidth(plain(240))).toBe(100)
    expect(proseWidth(plain(60))).toBe(60)
  })
})

describe("bold, dim and heading", () => {
  test("escape codes only with color", () => {
    expect(bold("Scopes", plain())).toBe("Scopes")
    expect(bold("Scopes", noColor())).toBe("Scopes")
    expect(bold("Scopes", color())).toBe("\x1b[1mScopes\x1b[0m")
    expect(dim("label", color())).toBe("\x1b[2mlabel\x1b[0m")
    expect(heading("By agent", plain())).toBe("By agent")
    expect(clean(heading("By agent", color()))).toBe("By agent")
  })

  test("a heading that fits is one line, byte for byte what it always was", () => {
    const title = "Message to sign (the exact bytes read; nothing was trimmed or normalized)"
    expect(heading("By agent", plain(40))).toBe("By agent")
    expect(heading(title, plain(200))).toBe(title)
    expect(clean(heading(title, color(200)))).toBe(title)
  })

  test("the converted screens' long headings wrap at the width, plain and styled, cap on a wide terminal", () => {
    const signTitle = "Message to sign (the exact bytes read; nothing was trimmed or normalized)"
    expect(heading(signTitle, plain(40)).split("\n")).toEqual([
      "Message to sign (the exact bytes read;",
      "nothing was trimmed or normalized)",
    ])
    // Styled: each wrapped line carries its own codes, so bolding survives wrapping.
    expect(heading(signTitle, color(40)).split("\n")).toEqual([
      "\x1b[1mMessage to sign (the exact bytes read;\x1b[0m",
      "\x1b[1mnothing was trimmed or normalized)\x1b[0m",
    ])
    const backupTitle = "Derivation counters to keep with your recovery phrase"
    const backupLines = heading(backupTitle, plain(40)).split("\n")
    expect(backupLines).toEqual(["Derivation counters to keep with your", "recovery phrase"])
    expectWithin(backupLines, 40)
    // However wide the terminal, a heading longer than the prose cap still wraps at the cap.
    const longTitle = `${backupTitle} and every phrase you re-enter when you restore the vault on a new machine`
    const capped = heading(longTitle, plain(240)).split("\n")
    expectWithin(capped, PROSE_MAX)
    expect(capped).toHaveLength(2)
  })
})

describe("fields", () => {
  test("a writeFields title wraps like a heading, and the blank line after it survives", () => {
    const stdout = createCapture()
    writeFields(
      createTestDeps({ fetch: unusedFetch, stdout, columns: { stdout: 40, stderr: 40 } }),
      "stdout",
      [["Address", "one"]],
      "Derivation counters to keep with your recovery phrase",
    )
    const lines = stdout.text.split("\n")
    expect(lines.slice(0, 4)).toEqual([
      "Derivation counters to keep with your",
      "recovery phrase",
      "",
      "  Address  one",
    ])
    expectWithin(lines, 40)
  })

  test("labels in one column padded to the widest plus two; a missing value is the mark", () => {
    expect(
      fields(
        [
          ["Label", "rebalancer"],
          ["Prefix", "Ab3dEf9h"],
          ["Embedded wallet", "allowed"],
          ["Stored", undefined],
          ["Note", ""],
          ["Count", 0],
        ],
        plain(),
      ),
    ).toEqual([
      "  Label            rebalancer",
      "  Prefix           Ab3dEf9h",
      "  Embedded wallet  allowed",
      "  Stored           -",
      "  Note             -",
      "  Count            0",
    ])
    expect(fields([["Stored", null]], color()).map(clean)).toEqual(["  Stored  –"])
  })

  test("a long value wraps under its own column, never under the labels; an id stays whole", () => {
    const id = "FfU8M5kc8chjj7BRMvTGLBpTJ54SmcUU6CTy2pQu8pPD"
    const lines = fields(
      [
        [
          "Embedded wallet",
          "allowed for trades with swap:write, launches with launch:write, and transfers with transfer:write",
        ],
        ["Address", id],
      ],
      plain(60),
    )
    expect(lines).toEqual([
      "  Embedded wallet  allowed for trades with swap:write,",
      "                   launches with launch:write, and transfers",
      "                   with transfer:write",
      `  Address          ${id}`,
    ])
    for (const line of lines.slice(0, 3)) expect(line.length).toBeLessThanOrEqual(60)
  })

  test("labels are dim in color, values untouched", () => {
    expect(fields([["Prefix", "Ab3dEf9h"]], color())).toEqual(["  \x1b[2mPrefix\x1b[0m  Ab3dEf9h"])
  })

  test("ordinary words use the columns left after the label, and a narrow terminal stacks the value", () => {
    const sideBySide = fields([["Embedded wallet", "allowed for trades and transfers"]], plain(30))
    expect(sideBySide).toEqual([
      "  Embedded wallet  allowed for",
      "                   trades and",
      "                   transfers",
    ])
    expectWithin(sideBySide, 30)

    const stacked = fields([["Embedded wallet", "allowed for trades and transfers"]], plain(20))
    expect(stacked).toEqual(["  Embedded wallet", "    allowed for", "    trades and", "    transfers"])
    expectWithin(stacked, 20)
  })
})

describe("notice", () => {
  const warning =
    "This machine holds a device token and a key signer, so it can approve its own signer request. Log out here after a move."

  test("one symbol per severity, wrapped with a hanging indent under the text", () => {
    expect(renderNotice("warning", warning, plain(60))).toEqual([
      "  ! This machine holds a device token and a key signer, so",
      "    it can approve its own signer request. Log out here",
      "    after a move.",
    ])
    expect(renderNotice("note", "Default scopes.", plain())).toEqual(["  - Default scopes."])
    expect(renderNotice("danger", "Funds move.", plain())).toEqual(["  x Funds move."])
    expect(renderNotice("note", "Default scopes.", noColor())).toEqual(["  · Default scopes."])
    expect(renderNotice("danger", "Funds move.", noColor())).toEqual(["  ✗ Funds move."])
  })

  test("a blank line inside the text is a paragraph break in the same notice", () => {
    expect(renderNotice("warning", "Shown once.\n\nStore it now.", plain())).toEqual([
      "  ! Shown once.",
      "",
      "    Store it now.",
    ])
  })

  test("colored by severity: warning yellow, danger red, note dim", () => {
    const dark = color()
    const [w] = renderNotice("warning", "Shown once.", dark)
    expect(w).toBe("  \x1b[38;5;214m!\x1b[0m \x1b[38;5;214mShown once.\x1b[0m")
    const [d] = renderNotice("danger", "Gone.", dark)
    expect(d).toContain("\x1b[38;5;204m")
    const [n] = renderNotice("note", "Default.", dark)
    expect(n).toBe("  \x1b[2m·\x1b[0m \x1b[2mDefault.\x1b[0m")
  })

  test("never wider than the prose width, even on a wide terminal", () => {
    for (const line of renderNotice("warning", warning.repeat(4), plain(200))) {
      expect(line.length).toBeLessThanOrEqual(100)
    }
  })

  test("ordinary words use the columns left after the symbol", () => {
    const fitted = renderNotice("warning", "This warning has short ordinary words only", plain(20))
    expect(fitted).toEqual(["  ! This warning has", "    short ordinary", "    words only"])
    expectWithin(fitted, 20)

    const stacked = renderNotice("warning", "This warning has short ordinary words only", plain(10))
    expect(stacked[0]).toBe("  !")
    expectWithin(stacked, 10)
  })

  test("writes to the stream it is given, set apart by blank lines, styled for that stream", () => {
    for (const stream of ["stdout", "stderr"] as const) {
      const stdout = createCapture()
      const stderr = createCapture()
      const deps = createTestDeps({
        fetch: unusedFetch,
        stdout,
        stderr,
        env: { TERM: "xterm-256color", COLORFGBG: "15;0" },
        // Only the stream written to is a terminal: its style, not the other one's, applies.
        isTTY: { stdin: false, stdout: stream === "stdout", stderr: stream === "stderr" },
      })
      notice(deps, stream, "warning", "Shown once.")
      const written = stream === "stdout" ? stdout.text : stderr.text
      const other = stream === "stdout" ? stderr.text : stdout.text
      expect(other).toBe("")
      expect(clean(written)).toBe("\n  ! Shown once.\n\n")
      expect(written).not.toBe(clean(written))
    }
  })

  test("a pipe gets no escape codes and ASCII symbols", () => {
    const stdout = createCapture()
    const deps = createTestDeps({
      fetch: unusedFetch,
      stdout,
      env: { TERM: "xterm-256color" },
      isTTY: { stdin: false, stdout: false, stderr: false },
    })
    notice(deps, "stdout", "note", "Covers the last 2,000 ledger rows.")
    expect(stdout.text).toBe("\n  - Covers the last 2,000 ledger rows.\n\n")
  })
})

describe("success and failure lines", () => {
  test("plain, no-color and color", () => {
    expect(success("API key created", plain())).toBe("ok API key created")
    expect(failure("Not created", plain())).toBe("x Not created")
    expect(success("API key created", noColor())).toBe("✓ API key created")
    expect(failure("Not created", noColor())).toBe("✗ Not created")
    expect(success("API key created", color())).toBe("\x1b[38;5;42m✓\x1b[0m API key created")
    expect(failure("Not created", color())).toBe("\x1b[38;5;204m✗ Not created\x1b[0m")
  })

  test("a long success sentence wraps under its mark at the width; the prose cap holds when wide", () => {
    // The actual `vault new-key --count` completion sentence (vault-new-key.ts), which rendered
    // one 118-column line at 40 columns before wrapping landed here.
    const sentence =
      "3 keys created under one unlock, each committed on its own and re-read from the vault and re-derived from its root."
    const plainNarrow = success(sentence, plain(40)).split("\n")
    expect(plainNarrow).toEqual([
      "ok 3 keys created under one unlock, each",
      "   committed on its own and re-read from",
      "   the vault and re-derived from its",
      "   root.",
    ])
    expectWithin(plainNarrow, 40)
    // Every word of the sentence survives, in order: wrapping never edits prose.
    expect(plainNarrow.join(" ").replace(/\s+/g, " ")).toBe(`ok ${sentence}`)

    // Styled: the mark keeps its positive color, continuation lines hang under the text column.
    const styledNarrow = success(sentence, color(40)).split("\n")
    expect(styledNarrow[0]).toBe("\x1b[38;5;42m✓\x1b[0m 3 keys created under one unlock, each")
    expectWithin(styledNarrow.map(clean), 40)
    for (const line of styledNarrow.slice(1)) expect(line.startsWith("  ")).toBe(true)

    // A terminal wide enough for one line still wraps at the prose cap, not the terminal width.
    const wide = success(sentence, plain(200)).split("\n")
    expectWithin(wide, PROSE_MAX)
    expect(wide).toHaveLength(2)
  })
})

describe("renderTable", () => {
  const headers = ["AGENT", "REALIZED", "UNREALIZED", "TOTAL", "OPEN"]
  const rows = [
    ["spiderman", "+$75.98", "-$22.92", "+$53.06", "11"],
    ["batman", "-$547.37", "+$1.00", "-$546.37", "3"],
    ["robin", "–", "$0.00", "$0.00", "0"],
  ]

  test("without options: the table every command prints today, byte for byte", () => {
    expect(renderTable(["A", "BB"], [["xyz", "1"]])).toBe("A    BB\n---  --\nxyz  1")
  })

  test("with options: numbers right-aligned, text left, no trailing space", () => {
    expect(renderTable(headers, rows, { rule: false, indent: 2 })).toBe(
      [
        "  AGENT      REALIZED  UNREALIZED     TOTAL  OPEN",
        "  spiderman   +$75.98     -$22.92   +$53.06    11",
        "  batman     -$547.37      +$1.00  -$546.37     3",
        "  robin             –       $0.00     $0.00     0",
      ].join("\n"),
    )
  })

  test("explicit alignment beats auto", () => {
    expect(renderTable(["N", "V"], [["a", "1"]], { columns: [undefined, { align: "left" }], rule: false })).toBe(
      "N  V\na  1",
    )
    expect(renderTable(["N", "V"], [["a", "x"]], { columns: [{ align: "right" }], rule: false })).toBe("N  V\na  x")
  })

  test("too wide: the lowest-priority column drops first, rightmost of equals first", () => {
    const columns = [undefined, { priority: 2 }, { priority: 1 }, undefined, { priority: 1 }]
    const fit = (width: number) => renderTable(headers, rows, { columns, width, rule: false }).split("\n")[0]
    expect(fit(80)).toBe("AGENT      REALIZED  UNREALIZED     TOTAL  OPEN")
    expect(fit(44)).toBe("AGENT      REALIZED  UNREALIZED     TOTAL")
    expect(fit(32)).toBe("AGENT      REALIZED     TOTAL")
    expect(fit(22)).toBe("AGENT         TOTAL")
  })

  test("then the widest non-id column is cut with an ellipsis; a header is never cut", () => {
    const table = renderTable(
      ["MINT", "NAME", "VALUE"],
      [["9EAqXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX9Hd7", "A very long token name indeed", "$1.00"]],
      { columns: [{ id: true }], width: 70, rule: false, style: plain() },
    )
    const [head, row] = table.split("\n")
    expect(row).toBe("9EAqXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX9Hd7  A very long to...  $1.00")
    expect(head?.startsWith("MINT")).toBe(true)
    for (const line of table.split("\n")) expect(line.length).toBeLessThanOrEqual(70)
    const styled = renderTable(["NAME"], [["A very long token name"]], { width: 10, style: color(), rule: false })
    expect(clean(styled).split("\n")[1]).toBe("A very lo…")
  })

  test("an id column overflows rather than being cut when nothing else can give", () => {
    const id = "FfU8M5kc8chjj7BRMvTGLBpTJ54SmcUU6CTy2pQu8pPD"
    expect(renderTable(["ADDRESS"], [[id]], { columns: [{ id: true }], width: 20, rule: false })).toBe(`ADDRESS\n${id}`)
  })

  test("color: dim header and rule, signed cells green and red after padding, the sign kept", () => {
    const table = renderTable(
      ["N", "PNL"],
      [
        ["a", "+$1.00"],
        ["b", "-$2.00"],
        ["c", "$0.00"],
      ],
      {
        columns: [undefined, { signed: true }],
        style: color(),
      },
    )
    const lines = table.split("\n")
    expect(lines[0]).toBe("\x1b[2mN\x1b[0m  \x1b[2m   PNL\x1b[0m")
    expect(lines[1]).toBe("\x1b[2m-  ------\x1b[0m")
    expect(lines[2]).toBe("a  \x1b[38;5;42m+$1.00\x1b[0m")
    expect(lines[3]).toBe("b  \x1b[38;5;204m-$2.00\x1b[0m")
    expect(lines[4]).toBe("c   $0.00")
    expect(
      renderTable(["N", "PNL"], [["a", "+$1.00"]], { columns: [undefined, { signed: true }], style: plain() }),
    ).toBe("N     PNL\n-  ------\na  +$1.00")
  })

  test("multi-byte cells (ellipsis, en dash) count as one column", () => {
    expect(
      renderTable(
        ["ID", "X"],
        [
          ["9EAq…9Hd7", "–"],
          ["abcdefghij", "1"],
        ],
        { rule: false },
      ),
    ).toBe("ID          X\n9EAq…9Hd7   –\nabcdefghij  1")
  })

  test("CJK and combining marks use display columns, and an id is still never cut", () => {
    const cjk = renderTable(["NAME"], [["日本語日本語"]], { width: 6, rule: false })
    expect(cjk).toBe("NAME\n日...")
    expectWithin(cjk.split("\n"), 6)

    const aligned = renderTable(
      ["NAME", "N"],
      [
        ["日本語", "1"],
        ["abcd", "2"],
        ["cafe\u0301", "3"],
      ],
      { rule: false },
    )
    expect(aligned).toBe(["NAME    N", "日本語  1", "abcd    2", "cafe\u0301    3"].join("\n"))
    const nameWidths = aligned.split("\n").map((line) => terminalColumns(line.slice(0, line.lastIndexOf("  "))))
    expect(nameWidths).toEqual([6, 6, 6, 6])

    const accented = "e\u0301".repeat(6)
    const clipped = renderTable(["N"], [[accented]], { width: 4, rule: false })
    expect(clipped).toBe(`N\ne\u0301...`)
    expectWithin(clipped.split("\n"), 4)
    expect(clipped).not.toContain("e...")

    const id = "日本語日本語"
    expect(renderTable(["NAME"], [[id]], { columns: [{ id: true }], width: 6, rule: false })).toBe(`NAME\n${id}`)
  })
})

describe("shortId and --full", () => {
  const id = "9EAqXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX9Hd7"

  test("first four, an ellipsis, last four; short values and --full print whole", () => {
    expect(shortId(id)).toBe("9EAq…9Hd7")
    expect(shortId(id, true)).toBe(id)
    expect(shortId("Ab3dEf9h")).toBe("Ab3dEf9h")
    expect(shortId("123456789012")).toBe("123456789012")
    expect(shortId("1234567890123")).toBe("1234…0123")
  })

  test("usd.ts's shortAddress is the same helper, so pnl and portfolio print what they did", () => {
    expect(shortAddress(id)).toBe(shortId(id))
    expect(shortAddress("short")).toBe("short")
  })

  test("--full is a global flag: read anywhere on the line, never passed to the command", async () => {
    expect(fullIds(createTestDeps({ fetch: unusedFetch }))).toBe(false)
    expect(fullIds({ presentation: { full: true } })).toBe(true)
    const keysList = async (flag: string) => {
      const { fetch } = createRoutedFetch({
        "/api/v1/agent/keys": () => jsonResponse(200, { success: true, tier: "free", keys: [] }),
      })
      const store = createFakeStore({ device_token: "cndl_dvc_x" })
      return run(
        ["keys", "list", flag, "--json"],
        createTestDeps({ fetch, store, stdout: createCapture(), stderr: createCapture() }),
      )
    }
    // The command refuses a flag it does not know; `--full` never reaches it.
    expect(await keysList("--not-a-flag")).toBe(2)
    expect(await keysList("--full")).toBe(0)
  })

  test("--full is listed with the global flags in help", async () => {
    const stdout = createCapture()
    expect(await run(["--help"], createTestDeps({ fetch: unusedFetch, stdout }))).toBe(0)
    const globals = stdout.text.slice(stdout.text.indexOf("Global flags"), stdout.text.indexOf("Environment"))
    expect(globals).toContain("--full")
  })
})

describe("formatTime and formatAgo", () => {
  const now = Date.parse("2026-10-27T23:00:00.000Z")

  test("short UTC: month, day, hours and minutes, a Z; no seconds or milliseconds", () => {
    expect(formatTime("2026-10-27T22:36:37.627Z", { now })).toBe("Oct 27 22:36Z")
    expect(formatTime(Date.parse("2026-01-05T03:04:59.999Z"), { now })).toBe("Jan 5 03:04Z")
    expect(formatTime(new Date("2026-09-23T00:00:00Z"), { now, date: true })).toBe("Sep 23")
  })

  test("the year only when it is not this year", () => {
    expect(formatTime("2025-10-27T22:36:00Z", { now })).toBe("Oct 27 2025 22:36Z")
    expect(formatTime("2025-12-31T23:59:00Z", { now, date: true })).toBe("Dec 31 2025")
  })

  test("UTC regardless of the machine's time zone", () => {
    const tz = process.env.TZ
    process.env.TZ = "America/Los_Angeles"
    try {
      expect(formatTime("2026-10-27T02:00:00Z", { now })).toBe("Oct 27 02:00Z")
    } finally {
      process.env.TZ = tz
    }
  })

  test("absent or unparseable is the missing mark, or the caller's", () => {
    expect(formatTime(undefined)).toBe("–")
    expect(formatTime(null)).toBe("–")
    expect(formatTime("")).toBe("–")
    expect(formatTime("not a date")).toBe("–")
    expect(formatTime(undefined, { missing: "never" })).toBe("never")
    expect(formatAgo(undefined, now)).toBe("–")
    expect(formatAgo(undefined, now, "never")).toBe("never")
  })

  test("relative: just now, minutes, hours to two days, days to ninety, then the date", () => {
    const ago = (ms: number) => formatAgo(now - ms, now)
    expect(ago(0)).toBe("just now")
    expect(ago(59_000)).toBe("just now")
    expect(ago(60_000)).toBe("1 min ago")
    expect(ago(59 * 60_000)).toBe("59 min ago")
    expect(ago(2 * 3_600_000)).toBe("2h ago")
    expect(ago(47 * 3_600_000)).toBe("47h ago")
    expect(ago(34 * 86_400_000)).toBe("34d ago")
    expect(ago(90 * 86_400_000)).toBe("90d ago")
    expect(ago(91 * 86_400_000)).toBe("Jul 28")
  })

  test("a few seconds of clock skew reads as now; a real future time is a date", () => {
    expect(formatAgo(now + 30_000, now)).toBe("just now")
    expect(formatAgo("2026-11-02T00:00:00Z", now)).toBe("Nov 2")
  })
})

describe("formatUsd", () => {
  test("the existing form is unchanged", () => {
    expect(formatUsd(1234.56)).toBe("$1,234.56")
    expect(formatUsd(-12.3)).toBe("-$12.30")
    expect(formatUsd(0.001)).toBe("<$0.01")
    expect(formatUsd(0)).toBe("$0.00")
    expect(formatUsd(3520633660.54)).toBe("$3,520,633,660.54")
    expect(formatUsd(Number.NaN)).toBe("?")
  })

  test("compact: a million and up as M, B, T; below that as usual", () => {
    expect(formatUsd(3520633660.54, { compact: true })).toBe("$3.52B")
    expect(formatUsd(731_470_000, { compact: true })).toBe("$731.47M")
    expect(formatUsd(1_770_000_000_000, { compact: true })).toBe("$1.77T")
    expect(formatUsd(1_000_000, { compact: true })).toBe("$1.00M")
    expect(formatUsd(999_995, { compact: true })).toBe("$1.00M")
    expect(formatUsd(994_999, { compact: true })).toBe("$994,999.00")
    expect(formatUsd(-2_500_000, { compact: true })).toBe("-$2.50M")
    expect(formatUsd(12_345.6, { compact: true })).toBe("$12,345.60")
  })

  test("signed: a + on gains, zero unsigned, dust keeps its sign", () => {
    expect(formatUsd(75.98, { signed: true })).toBe("+$75.98")
    expect(formatUsd(-49.65, { signed: true })).toBe("-$49.65")
    expect(formatUsd(0, { signed: true })).toBe("$0.00")
    expect(formatUsd(0.001, { signed: true })).toBe("+<$0.01")
    expect(formatUsd(3_520_000_000, { signed: true, compact: true })).toBe("+$3.52B")
  })
})

describe("errors as message plus fix", () => {
  const ctx = { apiUrl: "https://api.example.test", authType: "key" as const }
  const cases = [
    { status: 401, code: "DEVICE_TOKEN_INVALID", message: "stale" },
    { status: 403, code: "SCOPE_MISSING", message: "This key lacks the swap:write scope" },
    { status: 401, code: "UNAUTHORIZED", message: "nope" },
    { status: 0, message: "fetch failed" },
  ]

  test("the four mappings keep renderError's words and suggestionFor's commands", () => {
    for (const result of cases) {
      const parts = errorParts(result, ctx)
      const sentence = renderError(result, ctx)
      expect(sentence.startsWith(parts.message.replace(/\.$/, ""))).toBe(true)
      const suggestion = suggestionFor(result, ctx) ?? ""
      for (const fix of parts.fixes) {
        const command = fix.command?.replace("=<url>", "") ?? ""
        expect(sentence.includes(command) || suggestion.includes(command)).toBe(true)
      }
      expect(parts.fixes.length).toBeGreaterThan(0)
    }
  })

  test("anything else is the API's message, with its uiHint as the one fix", () => {
    expect(errorParts({ status: 409, message: "Name taken", uiHint: "Pick another name." }, ctx)).toEqual({
      message: "Name taken",
      fixes: [{ label: "Pick another name." }],
    })
    expect(errorParts({ status: 500, message: "Server error" }, ctx)).toEqual({ message: "Server error", fixes: [] })
  })

  test("rendered: the message, a blank line, then one fix per line with the commands aligned", () => {
    expect(renderErrorBlock(errorParts(cases[1] as (typeof cases)[number], ctx), plain())).toEqual([
      "x This key lacks the swap:write scope.",
      "",
      "  Mint a key that has it:           candle keys create --scopes <a,b,c>",
      "  Check an existing key's scopes:   candle keys list",
    ])
    expect(renderErrorBlock({ message: "Server error", fixes: [] }, plain())).toEqual(["x Server error"])
    expect(renderErrorBlock({ message: "Name taken", fixes: [{ label: "Pick another name." }] }, noColor())).toEqual([
      "✗ Name taken",
      "",
      "  Pick another name.",
    ])
  })

  test("a long message wraps at the prose width; color only on the message and labels", () => {
    const long =
      "The API refused this request because the key is outside its daily limit for this kind of action today."
    const lines = renderErrorBlock(
      { message: long, fixes: [{ label: "See limits", command: "candle spend" }] },
      color(60),
    )
    for (const line of lines.map(clean)) expect(line.length).toBeLessThanOrEqual(60)
    expect(clean(lines.at(-1) ?? "")).toBe("  See limits:   candle spend")
    expect(lines.at(-1)?.endsWith("candle spend")).toBe(true)
  })

  test("the message and the fix use the columns left after their prefixes", () => {
    const message = "This warning has short ordinary words only"
    const lines = renderErrorBlock(
      {
        message,
        fixes: [
          { label: "Retry the request soon" },
          { label: "Mint a key that has it", command: "candle keys create --scopes <a,b,c>" },
        ],
      },
      plain(20),
    )
    expectWithin(lines, 20)
    expect(lines[0]).toBe("x This warning has")

    const narrow = renderErrorBlock({ message: "warning text", fixes: [] }, plain(8))
    expect(narrow).toEqual(["x", "warning", "text"])
    expectWithin(narrow, 8)
  })
})

describe("display width", () => {
  test("the node fallback matches Bun for CJK, combining marks and the kit's symbols", () => {
    const samples = ["hello", "日本語日本語", "e\u0301", "cafe\u0301", "か\u3099", "ｱ", "ア", "Ａ", "…", "–", "✓", "⭐"]
    for (const sample of samples) expect(estimateDisplayWidth(sample)).toBe(terminalColumns(sample))
  })
})

describe("terminalStyle feeds the kit", () => {
  test("a terminal stream styles; a piped one is plain", () => {
    const deps = createTestDeps({
      fetch: unusedFetch,
      env: { TERM: "xterm-256color" },
      isTTY: { stdin: true, stdout: true, stderr: false },
      columns: { stdout: 90 },
    })
    expect(symbols(terminalStyle(deps, "stdout")).ok).toBe("✓")
    expect(symbols(terminalStyle(deps, "stderr")).ok).toBe("ok")
    expect(proseWidth(terminalStyle(deps, "stdout"))).toBe(90)
  })
})
