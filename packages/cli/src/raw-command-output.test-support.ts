import ts from "typescript"

/** Find literal multi-sentence prose written directly by a command. Inspect syntax rather
 * than lines so concatenation, templates and multiline calls cannot hide a new paragraph.
 * Dynamic server data and JSON serialization are not literal human prose. */
export function rawProseWrites(source: string): string[] {
  const file = ts.createSourceFile("command.ts", source, ts.ScriptTarget.Latest, true)
  const writes: string[] = []
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "write"
    ) {
      const argument = node.arguments[0]
      if (argument && !argument.getText(file).includes("JSON.stringify")) {
        const literals: string[] = []
        function collect(child: ts.Node): void {
          if (
            ts.isStringLiteral(child) ||
            ts.isNoSubstitutionTemplateLiteral(child) ||
            ts.isTemplateHead(child) ||
            ts.isTemplateMiddle(child) ||
            ts.isTemplateTail(child)
          )
            literals.push(child.text)
          else ts.forEachChild(child, collect)
        }
        collect(argument)
        const prose = literals.join(" ").replace(/\s+/g, " ").trim()
        if (/[.!?]\s+[A-Z]/.test(prose)) writes.push(prose)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return writes
}
