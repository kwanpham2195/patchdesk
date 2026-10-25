import * as v from "valibot";

import type { CodexRpcMessage } from "./codex-app-server-rpc";

/** Closed projection of the first failed native command, never its text or output. */
export type CodexAnalysisCommandFailure = {
  readonly commandOrdinal: number;
  readonly exitCode: number | null;
  readonly targetClass: "absolute_entry" | "literal_tilde" | "unknown";
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
      // Only the observed literal zsh wrapper is unwrapped; no shell syntax is interpreted.
      const wrapper = /^\/bin\/zsh -lc '([^'\r\n]+)'$/.exec(item.command);
      let command = item.command;
      if (wrapper?.[0] === item.command && wrapper[1] !== undefined)
        command = wrapper[1];
      // Only a single cat operand is recognized; expansions and compound syntax stay unknown.
      const operand =
        /^cat (?:-- )?(?:'([^'\n]+)'|"([^"$`\\\n]+)"|([A-Za-z0-9_./~-]+))$/.exec(
          command,
        );
      const target =
        operand?.[0] === command
          ? (operand[1] ?? operand[2] ?? operand[3])
          : undefined;
      const targetClass =
        target === diagnostic.entryPath
          ? "absolute_entry"
          : target?.startsWith("~/") &&
              (operand?.[1] !== undefined || operand?.[2] !== undefined)
            ? "literal_tilde"
            : "unknown";
      const output = item.aggregatedOutput;
      const failureClass =
        item.status === "declined"
          ? "native_denied"
          : target !== undefined &&
              (output === `cat: ${target}: No such file or directory\n` ||
                output === `cat: '${target}': No such file or directory\n`)
            ? "not_found"
            : target !== undefined &&
                (output === `cat: ${target}: Permission denied\n` ||
                  output === `cat: '${target}': Permission denied\n`)
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
