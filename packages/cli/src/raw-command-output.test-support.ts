import ts from "typescript"

/** Literal human prose only: formatter calls and serialized data already own their layout.
 * Inspect syntax so concatenation and templates cannot hide a new paragraph. Alternatives
 * are inspected separately: two single-sentence conditional outcomes are not a paragraph. */
export function rawProseWrites(source: string): string[] {
  const file = ts.createSourceFile("command.ts", source, ts.ScriptTarget.Latest, true)
  const writes: string[] = []
  function machineOnly(node: ts.Node): boolean {
    for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
      if (ts.isIfStatement(parent) && /^(?:ctx\.)?json$/.test(parent.expression.getText(file))) {
        if (child === parent.thenStatement) return true
      }
    }
    return false
  }
  function literals(node: ts.Node): string[][] {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [[node.text]]
    if (ts.isParenthesizedExpression(node)) return literals(node.expression)
    if (ts.isConditionalExpression(node)) return [...literals(node.whenTrue), ...literals(node.whenFalse)]
    if (ts.isTemplateExpression(node)) {
      let parts = [[node.head.text]]
      for (const span of node.templateSpans) {
        const embedded = literals(span.expression)
        parts = parts.flatMap((part) =>
          (embedded.length ? embedded : [[]]).map((value) => [...part, ...value, span.literal.text]),
        )
      }
      return parts
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = literals(node.left),
        right = literals(node.right)
      return (left.length ? left : [[]]).flatMap((a) => (right.length ? right : [[]]).map((b) => [...a, ...b]))
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "join" &&
      ts.isArrayLiteralExpression(node.expression.expression)
    ) {
      return [node.expression.expression.elements.flatMap((element) => literals(element).flat())]
    }
    return []
  }
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "write" &&
      !machineOnly(node)
    ) {
      const argument = node.arguments[0]
      for (const parts of argument ? literals(argument) : []) {
        const prose = parts.join(" ").replace(/\s+/g, " ").trim()
        if (/[.!?]\s+\p{L}/u.test(prose)) writes.push(prose)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return writes
}
