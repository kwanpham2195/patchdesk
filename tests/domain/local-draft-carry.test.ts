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
      carry: { state: "unchanged", sessionId: next },
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
      carry: { state: "changed", sessionId: next },
    });
  });

  it("drops the suggestion of a Finding draft whose lines changed and keeps the draft", () => {
    const rewritten = probe.map((line, index) =>
      index === 2 ? "  for (const value of values) {" : line,
    );

    const carried = carryLocalDraft(boundDraft, target(rewritten));

    expect(carried).toMatchObject({
      findingId: boundDraft.findingId,
      carry: { state: "changed", sessionId: next },
    });
    expect(carried).not.toHaveProperty("suggestion");
  });

  it("keeps a draft whose file is gone at its original anchor and session, under needs attention", () => {
    const carried = carryLocalDraft(boundDraft, target(undefined));

    const { suggestion: _dropped, ...withoutSuggestion } = boundDraft;
    expect(carried).toEqual({
      ...withoutSuggestion,
      carry: { state: "needs_attention", sessionId: next },
    });
  });

  it("needs attention when the draft's lines and context appear twice in the new file", () => {
    const twice = [...probe, "", ...probe];

    const carried = carryLocalDraft(loopNote, target(twice));

    expect(carried).toEqual({
      ...loopNote,
      carry: { state: "needs_attention", sessionId: next },
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

  it("leaves an applied Finding draft as it is", () => {
    const applied = { ...boundDraft, appliedAt: at };

    expect(carryLocalDraft(applied, target(undefined))).toBe(applied);
  });
});
