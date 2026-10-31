import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const pathFunctions = new Set(["join", "resolve", "normalize", "relative"]);
const pathModules = new Set([
  "node:path",
  "path",
  "node:path/posix",
  "node:path/win32",
]);
const pathNamePattern = /(Root|Dir)$/;

type Expression = ESTree.Expression | ESTree.Super | ESTree.SpreadElement;

function propertyName(node: ESTree.MemberExpression): string | undefined {
  return !node.computed && node.property.type === "Identifier"
    ? node.property.name
    : undefined;
}

/** Flag `.startsWith` on filesystem paths in files that import `node:path`; `isPathContained` is the containment check. */
export const noStringPathContainmentRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow String#startsWith on filesystem paths; containment goes through isPathContained.",
    },
    messages: {
      stringContainment:
        "startsWith is not a path containment check: it accepts siblings such as /root-other and mishandles separators. Use isPathContained from src/adapters/storage/path-containment.ts.",
    },
  },
  createOnce(context) {
    let pathFunctionNames = new Set<string>();
    let pathNamespaces = new Set<string>();
    let candidates: ESTree.CallExpression[] = [];
    let importsPath = false;

    function isPathValue(expression: Expression): boolean {
      switch (expression.type) {
        case "Identifier":
          return pathNamePattern.test(expression.name);
        case "MemberExpression": {
          const name = propertyName(expression);
          return name !== undefined && pathNamePattern.test(name);
        }
        case "CallExpression": {
          const callee = expression.callee;
          if (callee.type === "Identifier") {
            return pathFunctionNames.has(callee.name);
          }
          if (callee.type !== "MemberExpression") return false;
          const name = propertyName(callee);
          return (
            name !== undefined &&
            pathFunctions.has(name) &&
            callee.object.type === "Identifier" &&
            pathNamespaces.has(callee.object.name)
          );
        }
        case "TemplateLiteral":
          return expression.expressions.some(isPathValue);
        default:
          return false;
      }
    }

    return {
      before() {
        pathFunctionNames = new Set();
        pathNamespaces = new Set();
        candidates = [];
        importsPath = false;
      },
      ImportDeclaration(node) {
        if (!pathModules.has(node.source.value)) return;
        importsPath = true;
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") {
            pathNamespaces.add(specifier.local.name);
            continue;
          }
          const imported =
            specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : specifier.imported.value;
          if (pathFunctions.has(imported)) {
            pathFunctionNames.add(specifier.local.name);
          } else if (imported === "posix" || imported === "win32") {
            pathNamespaces.add(specifier.local.name);
          }
        }
      },
      CallExpression(node) {
        if (
          node.callee.type === "MemberExpression" &&
          propertyName(node.callee) === "startsWith"
        ) {
          candidates.push(node);
        }
      },
      "Program:exit"() {
        if (!importsPath) return;
        for (const call of candidates) {
          if (call.callee.type !== "MemberExpression") continue;
          const [argument] = call.arguments;
          if (
            isPathValue(call.callee.object) ||
            (argument !== undefined && isPathValue(argument))
          ) {
            context.report({ node: call, messageId: "stringContainment" });
          }
        }
      },
    };
  },
});
