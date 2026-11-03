/* oxlint-disable anti-slop/no-runtime-typeof -- ESTree literal values are untyped until narrowed. */
import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const ipcMainMethods = new Set(["handle", "on", "once"]);
const ipcRendererMethods = new Set(["invoke", "on", "once", "send"]);
/** Receivers that name a window's `webContents` or the `sender` of an IPC event. */
const webContentsNames = new Set(["webContents", "sender"]);

function memberName(
  expression: ESTree.Expression | ESTree.Super,
): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (
    expression.type === "MemberExpression" &&
    !expression.computed &&
    expression.property.type === "Identifier"
  ) {
    return expression.property.name;
  }
  return undefined;
}

function isChannelCall(callee: ESTree.CallExpression["callee"]): boolean {
  if (callee.type !== "MemberExpression" || callee.computed) return false;
  if (callee.property.type !== "Identifier") return false;
  const method = callee.property.name;
  const receiver = memberName(callee.object);
  if (receiver === "ipcMain") return ipcMainMethods.has(method);
  if (receiver === "ipcRenderer") return ipcRendererMethods.has(method);
  return method === "send" && webContentsNames.has(receiver ?? "");
}

/** Ban literal IPC channel names; main and preload are separate entry points, so a mismatched literal breaks the feature with every test green. */
export const noIpcChannelLiteralRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require IPC channel names to come from the shared channel module instead of string or template literals.",
    },
    messages: {
      channelLiteral:
        "Import the channel name from its src/main/*-channel.ts module instead of writing a literal; main and preload must share one constant.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (!isChannelCall(node.callee)) return;
        const channel = node.arguments[0];
        if (
          channel !== undefined &&
          (channel.type === "TemplateLiteral" ||
            (channel.type === "Literal" && typeof channel.value === "string"))
        ) {
          context.report({ node: channel, messageId: "channelLiteral" });
        }
      },
    };
  },
});
