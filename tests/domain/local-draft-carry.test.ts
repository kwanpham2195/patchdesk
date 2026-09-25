import { describe, expect, it } from "vitest";

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
import { carryLocalDraft } from "../../src/domain/local-draft-carry";
import type { Result } from "../../src/domain/result";

function value<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("test fixture failed");
  return result.value;
}

function session(sha: string) {
  return value(
    parseReviewSessionId(
      `github.com__octo-org__patchdesk__local-working_tree-main__sha-${sha}__base-12345678__0123456789ab`,
    ),
  );
}

const earlier = session("aaaaaaaa");
const next = session("bbbbbbbb");
const at = value(parseIsoTimestamp("2026-09-25T00:00:00.000Z"));
const path = value(parseRepoRelativePath("probe.ts"));

const probe = [
  "export function sum(values) {",
  "  let total = 0;",
  "  for (let i = 0; i <= values.length; i += 1) {",
  "    total += values[i] ?? 0;",
  "  }",
  "  return total;",
  "}",
];

/** The anchor Add to draft records for line 3 of `probe`. */
const loopAnchor = {
  path,
  side: "new" as const,
  startLine: 3,
  line: 3,
  selectedLines: ["  for (let i = 0; i <= values.length; i += 1) {"],
  before: ["export function sum(values) {", "  let total = 0;"],
  after: ["    total += values[i] ?? 0;", "  }"],
};

const boundDraft: FindingDraft = {
  findingId: value(parseFindingId("finding-bound")),
  analysisRunId: value(
    parseInsightRunId("insight-analysis-1-aaaaaaaaaaaa-run"),
  ),
  sessionId: earlier,
  anchor: loopAnchor,
  title: "Off-by-one bound",
  comment: "The loop reads one element past the end.",
  suggestion: { code: "  for (let i = 0; i < values.length; i += 1) {" },
  addedAt: at,
};

const loopNote: MaintainerNote = {
  author: "maintainer",
  noteId: value(parseLocalNoteId("note-1")),
  sessionId: earlier,
  anchor: loopAnchor,
  text: "Stop before values.length.",
  createdAt: at,
  updatedAt: at,
};

/** A `git diff` of `path` as an untracked file holding `lines`. */
function newFilePatch(lines: ReadonlyArray<string>): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${String(lines.length)} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function target(lines: ReadonlyArray<string> | undefined) {
  return {
    sessionId: next,
    patch: lines === undefined ? "" : newFilePatch(lines),
    files: new Map(
      lines === undefined ? [] : [[path, `${lines.join("\n")}\n`]],
    ),
  };
}

describe("carryLocalDraft", () => {
  it("moves a draft whose lines and context appear once in the new patch, keeping its suggestion", () => {
    const shifted = ["// Sums the values.", ...probe];

    const carried = carryLocalDraft(boundDraft, target(shifted));

    expect(carried).toEqual({
      ...boundDraft,
      sessionId: next,
      anchor: { ...loopAnchor, startLine: 4, line: 4 },
      carry: {
        state: "unchanged",
        sessionId: next,
        notedLines: loopAnchor.selectedLines,
      },
    });
  });

  it("moves a note to the lines between its unchanged context and marks it changed since the note", () => {
    const fixed = probe.map((line, index) =>
      index === 2 ? "  for (let i = 0; i < values.length; i += 1) {" : line,
    );

    const carried = carryLocalDraft(loopNote, target(fixed));

    expect(carried).toEqual({
      ...loopNote,
      sessionId: next,
      anchor: {
        ...loopAnchor,
        selectedLines: ["  for (let i = 0; i < values.length; i += 1) {"],
      },
      carry: {
        state: "changed",
        sessionId: next,
        notedLines: loopAnchor.selectedLines,
      },
    });
  });

  it("drops the suggestion of a Finding draft whose lines changed and keeps the draft", () => {
    const rewritten = probe.map((line, index) =>
      index === 2 ? "  for (const value of values) {" : line,
    );

    const carried = carryLocalDraft(boundDraft, target(rewritten));

    expect(carried).toMatchObject({
      findingId: boundDraft.findingId,
      carry: {
        state: "changed",
        sessionId: next,
        notedLines: loopAnchor.selectedLines,
      },
    });
    expect(carried).not.toHaveProperty("suggestion");
  });

  it("keeps a draft whose file is gone at its original anchor and session, under needs attention", () => {
    const carried = carryLocalDraft(boundDraft, target(undefined));

    const { suggestion: _dropped, ...withoutSuggestion } = boundDraft;
    expect(carried).toEqual({
      ...withoutSuggestion,
      carry: {
        state: "needs_attention",
        sessionId: next,
        notedLines: loopAnchor.selectedLines,
      },
    });
  });

  it("needs attention when the draft's lines and context appear twice in the new file", () => {
    const twice = [...probe, "", ...probe];

    const carried = carryLocalDraft(loopNote, target(twice));

    expect(carried).toEqual({
      ...loopNote,
      carry: {
        state: "needs_attention",
        sessionId: next,
        notedLines: loopAnchor.selectedLines,
      },
    });
  });

  it("needs attention when the lines between the context were deleted", () => {
    const deleted = probe.filter((_line, index) => index !== 2);

    const carried = carryLocalDraft(loopNote, target(deleted));

    expect(carried).toMatchObject({
      anchor: loopAnchor,
      sessionId: earlier,
      carry: { state: "needs_attention" },
    });
  });

  it("keeps a draft that changed since the note marked changed once its lines stop moving", () => {
    const fixed = probe.map((line, index) =>
      index === 2 ? "  for (let i = 0; i < values.length; i += 1) {" : line,
    );
    const changed = carryLocalDraft(loopNote, target(fixed));

    const again = carryLocalDraft(changed, {
      ...target(fixed),
      sessionId: session("cccccccc"),
    });

    expect(again).toMatchObject({
      anchor: { startLine: 3, line: 3 },
      carry: { state: "changed", sessionId: session("cccccccc") },
    });
  });

  it("drops a suggestion that holds a fence line even when its lines are unchanged", () => {
    const fenced = {
      ...boundDraft,
      suggestion: {
        code: "```\n  for (let i = 0; i < values.length; i += 1) {",
      },
    };

    const carried = carryLocalDraft(fenced, target(probe));

    expect(carried).toMatchObject({ carry: { state: "unchanged" } });
    expect(carried).not.toHaveProperty("suggestion");
  });

  it("keeps a note whose line was reverted marked changed and placed when an unrelated edit refreshes again", () => {
    const letters = value(parseRepoRelativePath("letters.txt"));
    // Line 4 of `a`..`g` changed to `D` when the note was written.
    const note: MaintainerNote = {
      ...loopNote,
      anchor: {
        path: letters,
        side: "new",
        startLine: 4,
        line: 4,
        selectedLines: ["D"],
        before: ["b", "c"],
        after: ["e", "f"],
      },
    };
    const reverted = new Map([[letters, "a\nb\nc\nd\ne\nf\ng\n"]]);
    // The agent reverted line 4, so letters.txt left the patch; the second Refresh follows an edit to another file.
    const unrelatedPatch = [
      "diff --git a/other.txt b/other.txt",
      "--- a/other.txt",
      "+++ b/other.txt",
      "@@ -1 +1 @@",
      "-one",
      "+two",
      "",
    ].join("\n");
    const third = session("cccccccc");

    const first = carryLocalDraft(note, {
      sessionId: next,
      patch: "",
      files: reverted,
    });
    const second = carryLocalDraft(first, {
      sessionId: third,
      patch: unrelatedPatch,
      files: reverted,
    });

    expect(first).toMatchObject({ carry: { state: "changed" } });
    expect(second).toMatchObject({
      sessionId: third,
      anchor: { startLine: 4, line: 4, selectedLines: ["d"] },
      carry: { state: "changed", sessionId: third },
    });
  });

  it("moves an untouched line whose hunk merged with a nearby edit as unchanged", () => {
    const lines = value(parseRepoRelativePath("lines.txt"));
    const base = Array.from(
      { length: 20 },
      (_, index) => `l${String(index + 1)}`,
    );
    // Written when only line 5 had changed: line 7 was the hunk's second-last context line.
    const note: MaintainerNote = {
      ...loopNote,
      anchor: {
        path: lines,
        side: "new",
        startLine: 7,
        line: 7,
        selectedLines: ["l7"],
        before: ["L5", "l6"],
        after: ["l8"],
      },
    };
    const edited = base.map((line) =>
      line === "l5" ? "L5" : line === "l11" ? "L11" : line,
    );
    // Line 11 changed too, so the two hunks merged and line 7's context gained `l9`.
    const merged = [
      "diff --git a/lines.txt b/lines.txt",
      "--- a/lines.txt",
      "+++ b/lines.txt",
      "@@ -2,13 +2,13 @@",
      " l2",
      " l3",
      " l4",
      "-l5",
      "+L5",
      " l6",
      " l7",
      " l8",
      " l9",
      " l10",
      "-l11",
      "+L11",
      " l12",
      " l13",
      " l14",
      "",
    ].join("\n");

    const carried = carryLocalDraft(note, {
      sessionId: next,
      patch: merged,
      files: new Map([[lines, `${edited.join("\n")}\n`]]),
    });

    expect(carried).toMatchObject({
      sessionId: next,
      anchor: { startLine: 7, line: 7, selectedLines: ["l7"] },
      carry: {
        state: "unchanged",
        sessionId: next,
        notedLines: ["l7"],
      },
    });
  });

  it("leaves an applied Finding draft as it is", () => {
    const applied = { ...boundDraft, appliedAt: at };

    expect(carryLocalDraft(applied, target(undefined))).toBe(applied);
  });
});
