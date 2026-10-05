import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Reject module specifiers that climb outside their importer's directory, not path data.
 * @param {string} path
 * @param {string} source
 * @returns {string[]}
 */
export function findParentImports(path, source) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  /** @type {string[]} */
  const violations = [];
  const visited = new WeakSet();
  /** @param {import("typescript").Node} node */
  function visit(node) {
    if (visited.has(node)) return;
    visited.add(node);
    let specifier;
    if (
      (ts.isImportDeclaration(node) ||
        ts.isExportDeclaration(node) ||
        ts.isJSDocImportTag(node)) &&
      node.moduleSpecifier
    ) {
      specifier = node.moduleSpecifier;
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      specifier = node.moduleReference.expression;
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument)
    ) {
      specifier = node.argument.literal;
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      specifier = node.arguments[0];
    }
    if (
      specifier &&
      (ts.isStringLiteral(specifier) ||
        ts.isNoSubstitutionTemplateLiteral(specifier)) &&
      specifier.text.startsWith("../")
    ) {
      violations.push(
        `${path}:${file.getLineAndCharacterOfPosition(specifier.getStart(file)).line + 1}: ${specifier.text}`,
      );
    }
    ts.forEachChild(node, visit);
    // Attached JSDoc nodes are not visited by forEachChild.
    for (const doc of ts.getJSDocCommentsAndTags(node)) {
      if (ts.isJSDoc(doc)) visit(doc);
    }
  }
  visit(file);
  return violations;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root })
    .toString()
    .split("\0")
    .filter((path) => /\.[cm]?[jt]sx?$/.test(path));
  const violations = files.flatMap((path) =>
    findParentImports(path, readFileSync(resolve(root, path), "utf8")),
  );
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(
      `No parent-climbing module imports in ${files.length} tracked source files.`,
    );
  }
}
