import * as v from "valibot";

import type { CodexRpcMessage } from "./codex-app-server-rpc";

/** Closed projection of the first failed native command, never its text or output. */
export type CodexAnalysisCommandFailure = {
  readonly commandOrdinal: number;
  readonly exitCode: number | null;
  readonly targetClass: "evidence_tree" | "unknown";
  readonly failureClass:
    | "not_found"
    | "permission_denied"
    | "native_denied"
    | "unknown";
};

/** The entry comes from the validated bundle, not the prompt or display preview. */
export type CodexAnalysisCommandDiagnostic = {
  readonly entryPath: string;
  readonly onFirstFailure: (failure: CodexAnalysisCommandFailure) => void;
};

const commandNotificationSchema = v.object({
  item: v.object({
    type: v.literal("commandExecution"),
    id: v.string(),
    command: v.string(),
    status: v.string(),
    exitCode: v.optional(v.nullable(v.pipe(v.number(), v.safeInteger()))),
    aggregatedOutput: v.optional(v.nullable(v.string())),
  }),
});

/** Observes raw notifications once per turn; classification and sink failures cannot fail it. */
export function createCodexAnalysisCommandDiagnostic(
  diagnostic: CodexAnalysisCommandDiagnostic,
): (message: CodexRpcMessage) => void {
  const ordinals = new Map<string, number>();
  let commandCount = 0;
  let failed = false;
  return (message) => {
    if (failed) return;
    try {
      if (
        message.method !== "item/started" &&
        message.method !== "item/completed"
      )
        return;
      const parsed = v.safeParse(commandNotificationSchema, message.params);
      if (!parsed.success) return;
      const item = parsed.output.item;
      let ordinal = ordinals.get(item.id);
      if (ordinal === undefined) {
        ordinal = ++commandCount;
        ordinals.set(item.id, ordinal);
      }
      if (
        message.method !== "item/completed" ||
        (item.status !== "failed" &&
          item.status !== "declined" &&
          (item.exitCode === undefined ||
            item.exitCode === null ||
            item.exitCode === 0))
      )
        return;
      failed = true;
      ordinals.clear();
      const targetClass = item.command.includes(
        diagnostic.entryPath.slice(0, diagnostic.entryPath.lastIndexOf("/")) +
          "/",
      )
        ? "evidence_tree"
        : "unknown";
      const output = item.aggregatedOutput?.slice(0, 4096) ?? "";
      const failureClass =
        item.status === "declined"
          ? "native_denied"
          : /: No such file or directory\n/.test(output)
            ? "not_found"
            : /: Permission denied\n/.test(output)
              ? "permission_denied"
              : "unknown";
      diagnostic.onFirstFailure({
        commandOrdinal: ordinal,
        exitCode: item.exitCode ?? null,
        targetClass,
        failureClass,
      });
    } catch {
      // No raw notification or thrown value leaves this observer.
    }
  };
}
