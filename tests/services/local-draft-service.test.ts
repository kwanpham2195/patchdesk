import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseFindingId,
  parseLocalNoteId,
  parseRepoRelativePath,
} from "../../src/domain/ids";
import { dismissInsightFinding } from "../../src/domain/insight-record";
import {
  cleanupLocalApplyRoots,
  localApplyHarness,
  now,
  profileId,
  retainAnalysis,
  suggestionFinding,
  value,
} from "./local-apply-fixture";

afterEach(cleanupLocalApplyRoots);

const probe = [
  "export function sum(values: number[]): number {",
  "  let total = 0;",
  "  for (let index = 0; index <= values.length; index += 1) {",
  "    total += values[index] ?? 0;",
  "  }",
  "  return total;",
  "}",
  "",
].join("\n");
const boundFix = suggestionFinding(
  "finding-bound",
  "probe.ts",
  { start: 3, end: 3 },
  "  for (let index = 0; index < values.length; index += 1) {",
);
const findingId = value(parseFindingId("finding-bound"));

async function draftedReview() {
  const harness = await localApplyHarness();
  await writeFile(join(harness.repositoryPath, "probe.ts"), probe);
  const workbench = await harness.open();
  const runId = await retainAnalysis(harness.insights, workbench, [boundFix]);
  const request = {
    profileId,
    reviewId: workbench.review.id,
    runId,
    findingId,
  };
  return { harness, workbench, runId, request };
}

describe("LocalDraftService", () => {
  it("stores one draft per Finding with its anchor fingerprint, comment, suggestion, and provenance", async () => {
    const { harness, workbench, runId, request } = await draftedReview();

    const first = await harness.drafts.add(request);
    const second = await harness.drafts.add(request);

    expect(first).toEqual(second);
    expect(second).toMatchObject({
      _tag: "ok",
      value: {
        localDrafts: [
          {
            findingId: "finding-bound",
            path: "probe.ts",
            startLine: 3,
            line: 3,
            suggests: true,
          },
        ],
      },
    });
    const stored = value(
      await harness.reviews.load(profileId, request.reviewId),
    );
    expect(stored.localDrafts).toEqual([
      {
        findingId: "finding-bound",
        analysisRunId: runId,
        sessionId: workbench.session.id,
        anchor: {
          path: "probe.ts",
          side: "new",
          startLine: 3,
          line: 3,
          selectedLines: [
            "  for (let index = 0; index <= values.length; index += 1) {",
          ],
          before: [
            "export function sum(values: number[]): number {",
            "  let total = 0;",
          ],
          after: ["    total += values[index] ?? 0;", "  }"],
        },
        title: boundFix.title,
        comment: boundFix.explanation,
        suggestion: boundFix.suggestedReplacement,
        addedAt: now,
      },
    ]);
  });

  it("lists drafts after the Review is opened again, and Remove deletes one", async () => {
    const { harness, request } = await draftedReview();
    value(await harness.drafts.add(request));

    const reopened = await harness.open();
    const removed = await harness.drafts.remove(request);

    expect(reopened.localDrafts).toMatchObject([
      { kind: "finding", findingId: "finding-bound" },
    ]);
    expect(removed).toEqual({ _tag: "ok", value: { localDrafts: [] } });
    const stored = value(
      await harness.reviews.load(profileId, request.reviewId),
    );
    expect(stored).not.toHaveProperty("localDrafts");
  });

  it("keeps a draft from an earlier session listed and refuses drafting from the outdated Analysis", async () => {
    const { harness, workbench, request } = await draftedReview();
    value(await harness.drafts.add(request));
    await writeFile(
      join(harness.repositoryPath, "probe.ts"),
      `${probe}export const more = 1;\n`,
    );

    const next = await harness.open();
    const refused = await harness.drafts.add(request);

    expect(next.session.id).not.toBe(workbench.session.id);
    expect(next.localDrafts).toMatchObject([
      { findingId: "finding-bound", sessionId: workbench.session.id },
    ]);
    expect(refused).toEqual({
      _tag: "err",
      error: { reason: "not_applicable" },
    });
  });

  it("refuses a draft change while another operation holds the Review and stores nothing", async () => {
    const { harness, request } = await draftedReview();
    const key = `${profileId}:${request.reviewId}`;
    expect(harness.coordinator.acquire(key)).toBe(true);

    const refused = await harness.drafts.add(request);
    harness.coordinator.release(key);

    expect(refused).toEqual({ _tag: "err", error: { reason: "in_progress" } });
    const stored = value(
      await harness.reviews.load(profileId, request.reviewId),
    );
    expect(stored.localDrafts).toBeUndefined();
  });

  it("refuses a dismissed Finding", async () => {
    const { harness, request } = await draftedReview();
    value(
      await harness.insights.mutate({
        profileId,
        reviewId: request.reviewId,
        type: "analysis",
        now,
        operation: (record) =>
          dismissInsightFinding(record, findingId, "Accepted risk", now),
      }),
    );

    expect(await harness.drafts.add(request)).toEqual({
      _tag: "err",
      error: { reason: "not_applicable" },
    });
  });

  describe("maintainer notes", () => {
    const probePath = value(parseRepoRelativePath("probe.ts"));
    const noteId = value(parseLocalNoteId("note-fixture-1"));

    async function notedReview() {
      const harness = await localApplyHarness();
      await writeFile(join(harness.repositoryPath, "probe.ts"), probe);
      const workbench = await harness.open();
      const key = { profileId, reviewId: workbench.review.id };
      return { harness, workbench, key };
    }

    it("adds a note on lines of the current patch, edits its text, lists it after reopening, and removes it", async () => {
      const { harness, workbench, key } = await notedReview();

      const added = await harness.drafts.addNote({
        ...key,
        anchor: { path: probePath, side: "new", startLine: 2, line: 3 },
        text: "Start from the first index.",
      });
      const edited = await harness.drafts.editNote({
        ...key,
        noteId,
        text: "Stop before values.length.",
      });
      const stored = value(await harness.reviews.load(profileId, key.reviewId));
      const reopened = await harness.open();
      const removed = await harness.drafts.removeNote({ ...key, noteId });

      expect(added).toMatchObject({
        _tag: "ok",
        value: {
          localDrafts: [
            {
              kind: "note",
              noteId,
              path: "probe.ts",
              startLine: 2,
              line: 3,
              text: "Start from the first index.",
            },
          ],
        },
      });
      expect(edited).toMatchObject({
        _tag: "ok",
        value: { localDrafts: [{ text: "Stop before values.length." }] },
      });
      expect(stored.localDrafts).toEqual([
        {
          author: "maintainer",
          noteId,
          sessionId: workbench.session.id,
          anchor: {
            path: "probe.ts",
            side: "new",
            startLine: 2,
            line: 3,
            selectedLines: [
              "  let total = 0;",
              "  for (let index = 0; index <= values.length; index += 1) {",
            ],
            before: ["export function sum(values: number[]): number {"],
            after: ["    total += values[index] ?? 0;", "  }"],
          },
          text: "Stop before values.length.",
          createdAt: now,
          updatedAt: stored.updatedAt,
        },
      ]);
      expect(reopened.localDrafts).toMatchObject([
        { kind: "note", text: "Stop before values.length." },
      ]);
      expect(removed).toEqual({ _tag: "ok", value: { localDrafts: [] } });
    });

    it.each([
      [
        "lines the current patch does not show",
        { path: probePath, side: "new" as const, startLine: 12, line: 12 },
        "Look here.",
        "not_applicable",
      ],
      [
        "a range that runs past the file's hunk",
        { path: probePath, side: "new" as const, startLine: 7, line: 9 },
        "Look here.",
        "not_applicable",
      ],
      [
        "blank text",
        { path: probePath, side: "new" as const, startLine: 2, line: 2 },
        " \n ",
        "invalid_input",
      ],
    ])(
      "refuses a note on %s and stores nothing",
      async (_case, anchor, text, reason) => {
        const { harness, key } = await notedReview();

        const refused = await harness.drafts.addNote({ ...key, anchor, text });

        expect(refused).toEqual({ _tag: "err", error: { reason } });
        const stored = value(
          await harness.reviews.load(profileId, key.reviewId),
        );
        expect(stored.localDrafts).toBeUndefined();
      },
    );

    it("refuses adding and editing a note while another operation holds the Review", async () => {
      const { harness, key } = await notedReview();
      value(
        await harness.drafts.addNote({
          ...key,
          anchor: { path: probePath, side: "new", startLine: 3, line: 3 },
          text: "Off by one.",
        }),
      );
      const lock = `${profileId}:${key.reviewId}`;
      expect(harness.coordinator.acquire(lock)).toBe(true);

      const add = await harness.drafts.addNote({
        ...key,
        anchor: { path: probePath, side: "new", startLine: 2, line: 2 },
        text: "Second note.",
      });
      const edit = await harness.drafts.editNote({
        ...key,
        noteId,
        text: "Edited while held.",
      });
      harness.coordinator.release(lock);

      expect([add, edit]).toEqual([
        { _tag: "err", error: { reason: "in_progress" } },
        { _tag: "err", error: { reason: "in_progress" } },
      ]);
      const stored = value(await harness.reviews.load(profileId, key.reviewId));
      expect(stored.localDrafts).toMatchObject([
        { noteId, text: "Off by one." },
      ]);
    });

    it("refuses editing a note that was removed", async () => {
      const { harness, key } = await notedReview();

      expect(
        await harness.drafts.editNote({ ...key, noteId, text: "Gone." }),
      ).toEqual({ _tag: "err", error: { reason: "not_found" } });
    });
  });
});
