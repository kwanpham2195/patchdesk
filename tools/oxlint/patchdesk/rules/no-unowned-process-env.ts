/* oxlint-disable anti-slop/no-runtime-typeof -- Rule options arrive as untyped JSON from .oxlintrc.json. */
import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

function isOwner(filename: string, owners: readonly string[]): boolean {
  const normalized = filename.replaceAll("\\", "/");
  return owners.some(
    (owner) => normalized === owner || normalized.endsWith(`/${owner}`),
  );
}

function ownersFromOptions(options: readonly unknown[]): readonly string[] {
  const first = options[0];
  if (typeof first !== "object" || first === null || !("owners" in first)) {
    return [];
  }
  const { owners } = first;
  return Array.isArray(owners)
    ? owners.filter((owner): owner is string => typeof owner === "string")
    : [];
}

function isProcessEnv(node: ESTree.MemberExpression): boolean {
  return (
    node.object.type === "Identifier" &&
    node.object.name === "process" &&
    !node.computed &&
    node.property.type === "Identifier" &&
    node.property.name === "env"
  );
}

/** Keep `process.env` reads in the modules that own them, so a reader cannot race the login-shell import (ADR 0038). */
export const noUnownedProcessEnvRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Allow process.env only in the owner modules listed in the rule options.",
    },
    schema: [
      {
        type: "object",
        properties: {
          owners: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      unownedEnv:
        "Read process.env only in an owner module listed in .oxlintrc.json, and pass the value on. Main-process reads must await the login-shell import (ADR 0038).",
    },
  },
  createOnce(context) {
    let owned = false;
    return {
      before() {
        owned = isOwner(context.filename, ownersFromOptions(context.options));
        return !owned;
      },
      MemberExpression(node) {
        if (isProcessEnv(node)) {
          context.report({ node, messageId: "unownedEnv" });
        }
      },
    };
  },
});
