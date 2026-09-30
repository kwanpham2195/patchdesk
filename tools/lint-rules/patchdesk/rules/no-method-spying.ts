import { defineRule } from "@oxlint/plugins";

import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

function resolveVariable(
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference,
): Variable | null {
  let scope: Scope | null = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

/** True for the `vi` or `jest` global, or a binding imported as `vi` from vitest or `jest` from @jest/globals. */
function isTestFrameworkObject(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
): expression is ESTree.IdentifierReference {
  if (expression.type !== "Identifier") return false;
  const frameworkName = expression.name === "vi" || expression.name === "jest";
  if (frameworkName && sourceCode.isGlobalReference(expression)) return true;

  const variable = resolveVariable(sourceCode, expression);
  if (variable === null || variable.defs.length === 0) return frameworkName;
  return variable.defs.some((definition) => {
    if (
      definition.type !== "ImportBinding" ||
      definition.parent?.type !== "ImportDeclaration" ||
      definition.node.type !== "ImportSpecifier"
    ) {
      return false;
    }
    const source = definition.parent.source.value;
    const imported = definition.node.imported;
    const name =
      imported.type === "Identifier" ? imported.name : imported.value;
    return (
      (source === "vitest" && name === "vi") ||
      (source === "@jest/globals" && name === "jest")
    );
  });
}

function isSpyOnCall(
  sourceCode: SourceCode,
  callee: ESTree.CallExpression["callee"],
): boolean {
  if (callee.type !== "MemberExpression") return false;
  if (!isTestFrameworkObject(sourceCode, callee.object)) return false;
  const property = callee.property;
  return callee.computed
    ? property.type === "Literal" && property.value === "spyOn"
    : property.type === "Identifier" && property.name === "spyOn";
}

/** Ban `vi.spyOn`/`jest.spyOn`; a recording fake supplied through a real seam owns the record instead. */
export const noMethodSpyingRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Vitest and Jest method spies; tests must replace behaviour through a recording fake supplied through a real seam.",
    },
    messages: {
      methodSpy:
        "Replace vi.spyOn/jest.spyOn with a recording fake supplied through a real seam.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (isSpyOnCall(context.sourceCode, node.callee)) {
          context.report({ node, messageId: "methodSpy" });
        }
      },
    };
  },
});
