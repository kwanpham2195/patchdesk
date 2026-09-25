import { describe, expect, it } from "vitest";

import { definedProps } from "../../src/domain/defined-props";
import {
  parseFindingId,
  parseInsightRunId,
  parseIsoTimestamp,
  parseLocalNoteId,
  parseRepoRelativePath,
  parseReviewSessionId,
} from "../../src/domain/ids";
import type {
  FindingDraft,
  MaintainerNote,
} from "../../src/domain/local-draft";
import { renderLocalDraftsAsAgentPrompt } from "../../src/domain/local-draft-agent-prompt";
import type { Result } from "../../src/domain/result";

function value<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("test fixture failed");
  return result.value;
}

const sessionId = value(
  parseReviewSessionId(
    "github.com__octo-org__patchdesk__local-working_tree-main__sha-abcdef12__base-12345678__0123456789ab",
  ),
);
const at = value(parseIsoTimestamp("2026-09-25T00:00:00.000Z"));

function draft(
  overrides: Pick<FindingDraft, "title" | "comment"> & {
    readonly path: string;
    readonly startLine: number;
    readonly line: number;
    readonly side?: "new" | "old";
    readonly suggestion?: string;
  },
): FindingDraft {
  return {
    findingId: value(parseFindingId("finding-1")),
    analysisRunId: value(
      parseInsightRunId("insight-analysis-1-aaaaaaaaaaaa-run"),
    ),
    sessionId,
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
    addedAt: at,
  };
}

function note(path: string, line: number, text: string): MaintainerNote {
  return {
    author: "maintainer",
    noteId: value(parseLocalNoteId("note-1")),
    sessionId,
    anchor: {
      path: value(parseRepoRelativePath(path)),
      side: "new",
      startLine: line,
      line,
      selectedLines: [],
      before: [],
      after: [],
    },
    text,
    createdAt: at,
    updatedAt: at,
  };
}

describe("renderLocalDraftsAsAgentPrompt", () => {
  it("lists Finding drafts and maintainer notes in file then line order, a note without a suggestion", () => {
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
      note("src/items.ts", 1, "Keep the empty-list case explicit.\n"),
    ]);

    expect(prompt).toBe(
      [
        "# Address review comments",
        "",
        "Address each review comment below: read the cited lines, make the smallest correct change, and do not change unrelated code.",
        "",
        "## Comments",
        "",
        "### 1. Removed guard",
        "",
        "- File: `src/guard.ts:10-12` (line numbers before the change)",
        "",
        "The deleted check still protects callers.",
        "",
        "### 2. Note from the maintainer",
        "",
        "- File: `src/items.ts:1`",
        "",
        "Keep the empty-list case explicit.",
        "",
        "### 3. lastItem reads past the end",
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
      ].join("\n"),
    );
  });
});
