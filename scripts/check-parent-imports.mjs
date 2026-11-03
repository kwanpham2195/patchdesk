import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import * as ts from "typescript/unstable/ast";

/**
 * Reject module specifiers that climb outside their importer's directory, not path data.
 * @param {string} path
 * @param {string} source
 * @returns {string[]}
 */
export function findParentImports(path, source) {
  return findParentImportsInFiles([{ path, source }]);
}

/**
 * Parse the tracked files in one native session, including JavaScript and JSDoc.
 * @param {ReadonlyArray<{readonly path: string; readonly source: string}>} files
 * @returns {string[]}
 */
function findParentImportsInFiles(files) {
  if (files.length === 0) return [];
  const root = "/__patchdesk_import_check__";
  const configPath = `${root}/tsconfig.json`;
  const fs = createVirtualFileSystem(
    Object.fromEntries([
      [
        configPath,
        JSON.stringify({
          compilerOptions: {
            allowJs: true,
            noLib: true,
            noResolve: true,
            types: [],
          },
          files: files.map(({ path }) => `./${path}`),
        }),
      ],
      ...files.map(({ path, source }) => [`${root}/${path}`, source]),
    ]),
  );
  const api = new API({ cwd: root, fs });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [configPath] });
    try {
      const project = snapshot.getProject(configPath);
      return files.flatMap(({ path }) => {
        const file = project?.program.getSourceFile(`${root}/${path}`);
        if (file === undefined)
          throw new Error(`Import checker could not parse ${path}`);
        return findParentImportsInSourceFile(path, file);
      });
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

/**
 * @param {string} path
 * @param {import("typescript/unstable/ast").SourceFile} file
 * @returns {string[]}
 */
function findParentImportsInSourceFile(path, file) {
  /** @type {string[]} */
  const violations = [];
  const visited = new WeakSet();
  const reportedPositions = new Set();
  /** @param {import("typescript/unstable/ast").Node} node */
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
      const position = specifier.getStart(file);
      // JavaScript JSDoc can also appear as a synthesized type at the same position.
      if (!reportedPositions.has(position)) {
        reportedPositions.add(position);
        violations.push(
          `${path}:${file.getLineAndCharacterOfPosition(position).line + 1}: ${specifier.text}`,
        );
      }
    }
    node.forEachChild(visit);
    // Attached JSDoc nodes are not visited by forEachChild.
    for (const doc of node.jsDoc ?? []) visit(doc);
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
  const violations = findParentImportsInFiles(
    files.map((path) => ({
      path,
      source: readFileSync(resolve(root, path), "utf8"),
    })),
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
