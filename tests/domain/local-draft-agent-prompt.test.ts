import { describe, expect, it } from "vitest";

import { definedProps } from "../../src/domain/defined-props";
import {
  parseFindingId,
  parseInsightRunId,
  parseIsoTimestamp,
  parseRepoRelativePath,
  parseReviewSessionId,
} from "../../src/domain/ids";
import type { LocalDraft } from "../../src/domain/local-draft";
import { renderLocalDraftsAsAgentPrompt } from "../../src/domain/local-draft-agent-prompt";
import type { Result } from "../../src/domain/result";

function value<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("test fixture failed");
  return result.value;
}

function draft(
  overrides: Pick<LocalDraft, "title" | "comment"> & {
    readonly path: string;
    readonly startLine: number;
    readonly line: number;
    readonly side?: "new" | "old";
    readonly suggestion?: string;
  },
): LocalDraft {
  return {
    findingId: value(parseFindingId("finding-1")),
    analysisRunId: value(
      parseInsightRunId("insight-analysis-1-aaaaaaaaaaaa-run"),
    ),
    sessionId: value(
      parseReviewSessionId(
        "github.com__octo-org__patchdesk__local-working_tree-main__sha-abcdef12__base-12345678__0123456789ab",
      ),
    ),
    anchor: {
      path: value(parseRepoRelativePath(overrides.path)),
      side: overrides.side ?? "new",
      startLine: overrides.startLine,
      line: overrides.line,
      selectedLines: [],
      before: [],
      after: [],
    },
    title: overrides.title,
    comment: overrides.comment,
    ...definedProps({
      suggestion:
        overrides.suggestion === undefined
          ? undefined
          : { code: overrides.suggestion },
    }),
    addedAt: value(parseIsoTimestamp("2026-09-25T00:00:00.000Z")),
  };
}

describe("renderLocalDraftsAsAgentPrompt", () => {
  it("lists each draft's lines, comment, and suggestion in the order drafted", () => {
    const prompt = renderLocalDraftsAsAgentPrompt([
      draft({
        title: "lastItem reads past the end",
        comment: "Use the last valid index.",
        path: "src/items.ts",
        startLine: 2,
        line: 2,
        suggestion: "  return items[items.length - 1];",
      }),
      draft({
        title: "Removed guard",
        comment: "The deleted check still protects callers.",
        path: "src/guard.ts",
        startLine: 10,
        line: 12,
        side: "old",
      }),
    ]);

    expect(prompt).toBe(
      [
        "# Address review comments",
        "",
        "Address each review comment below: read the cited lines, make the smallest correct change, and do not change unrelated code.",
        "",
        "## Comments",
        "",
        "### 1. lastItem reads past the end",
        "",
        "- File: `src/items.ts:2`",
        "",
        "Use the last valid index.",
        "",
        "Suggested replacement for src/items.ts:2:",
        "",
        "```",
        "  return items[items.length - 1];",
        "```",
        "",
        "### 2. Removed guard",
        "",
        "- File: `src/guard.ts:10-12` (line numbers before the change)",
        "",
        "The deleted check still protects callers.",
      ].join("\n"),
    );
  });
});
