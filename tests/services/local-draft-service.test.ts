import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseFindingId,
  parseLocalNoteId,
  parseRepoRelativePath,
} from "../../src/domain/ids";
import { dismissInsightFinding } from "../../src/domain/insight-record";
import { ok } from "../../src/domain/result";
import { isLocalReview, markLocalDraftsApplied } from "../../src/domain/review";
import { ReviewInsightReader } from "../../src/services/review-insight-reading";
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
    sessionId: workbench.session.id,
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

  it("carries a draft whose lines did not change to the next session and refuses drafting from the outdated Analysis", async () => {
    const { harness, workbench, request } = await draftedReview();
    value(await harness.drafts.add(request));
    await writeFile(
      join(harness.repositoryPath, "probe.ts"),
      `${probe}export const more = 1;\n`,
    );

    const next = await harness.open();
    const refused = await harness.drafts.add({
      ...request,
      sessionId: next.session.id,
    });

    expect(next.session.id).not.toBe(workbench.session.id);
    expect(next.localDrafts).toMatchObject([
      {
        findingId: "finding-bound",
        sessionId: next.session.id,
        startLine: 3,
        state: "unchanged",
      },
    ]);
    expect(refused).toEqual({
      _tag: "err",
      error: { reason: "not_applicable" },
    });
  });

  it("refuses every draft write that names a session the Review has moved past, and stores nothing", async () => {
    const { harness, workbench, request } = await draftedReview();
    value(await harness.drafts.add(request));
    value(
      await harness.drafts.addNote({
        ...request,
        anchor: {
          path: value(parseRepoRelativePath("probe.ts")),
          side: "new",
          startLine: 2,
          line: 2,
        },
        text: "Start from zero.",
      }),
    );
    await writeFile(
      join(harness.repositoryPath, "probe.ts"),
      `${probe}export const more = 1;\n`,
    );
    const next = await harness.open();
    const before = value(
      await harness.reviews.load(profileId, request.reviewId),
    );
    const noteId = value(parseLocalNoteId("note-fixture-1"));
    const stale = { profileId, reviewId: request.reviewId };
    const staleSession = { ...stale, sessionId: workbench.session.id };

    const refusals = [
      await harness.drafts.add(request),
      await harness.drafts.remove(request),
      await harness.drafts.addNote({
        ...staleSession,
        anchor: {
          path: value(parseRepoRelativePath("probe.ts")),
          side: "new",
          startLine: 4,
          line: 4,
        },
        text: "Another note.",
      }),
      await harness.drafts.editNote({
        ...staleSession,
        noteId,
        text: "Edited on the old view.",
      }),
      await harness.drafts.removeNote({ ...staleSession, noteId }),
    ];

    expect(next.session.id).not.toBe(workbench.session.id);
    expect(refusals).toEqual(
      refusals.map(() => ({
        _tag: "err",
        error: { reason: "not_applicable" },
      })),
    );
    expect(
      value(await harness.reviews.load(profileId, request.reviewId)),
    ).toEqual(before);
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

  it("reads each Finding's state, the drafts, and the agent prompt as the workbench shows them", async () => {
    const { harness, workbench, request } = await draftedReview();
    const appliedFix = suggestionFinding(
      "finding-applied",
      "probe.ts",
      { start: 4, end: 4 },
      "    total += values[index];",
    );
    const dismissedFix = suggestionFinding(
      "finding-dismissed",
      "probe.ts",
      { start: 6, end: 6 },
      "  return total || 0;",
    );
    const openFix = suggestionFinding(
      "finding-open",
      "probe.ts",
      { start: 1, end: 1 },
      "export function sum(values: readonly number[]): number {",
    );
    const runId = await retainAnalysis(harness.insights, workbench, [
      boundFix,
      appliedFix,
      dismissedFix,
      openFix,
    ]);
    value(await harness.drafts.add({ ...request, runId }));
    value(
      await harness.drafts.add({ ...request, runId, findingId: appliedFix.id }),
    );
    const drafted = value(
      await harness.reviews.load(profileId, request.reviewId),
    );
    if (!isLocalReview(drafted)) throw new Error("expected a local Review");
    value(
      await harness.reviews.save(
        markLocalDraftsApplied(drafted, {
          runId,
          findingIds: [appliedFix.id],
          appliedAt: now,
        }),
        drafted.updatedAt,
      ),
    );
    value(
      await harness.insights.mutate({
        profileId,
        reviewId: request.reviewId,
        type: "analysis",
        now,
        operation: (record) =>
          dismissInsightFinding(record, dismissedFix.id, "Accepted risk", now),
      }),
    );
    const shown = await harness.open();
    const reader = new ReviewInsightReader({ load: async () => ok(shown) });

    const reading = value(
      await reader.read({
        profileId,
        reviewId: request.reviewId,
        type: "analysis",
      }),
    );
    const feedback = value(
      await harness.drafts.feedback(profileId, request.reviewId),
    );

    expect(
      reading.findings?.map(({ id, dismissed, drafted, applied }) => ({
        id,
        dismissed,
        drafted,
        applied,
      })),
    ).toEqual([
      { id: "finding-bound", dismissed: false, drafted: true, applied: false },
      { id: "finding-applied", dismissed: false, drafted: true, applied: true },
      {
        id: "finding-dismissed",
        dismissed: true,
        drafted: false,
        applied: false,
      },
      { id: "finding-open", dismissed: false, drafted: false, applied: false },
    ]);
    expect(feedback.localDrafts).toEqual(shown.localDrafts);
    expect(feedback.markdown).toContain(boundFix.title);
    expect(feedback.markdown).not.toContain(appliedFix.title);
  });

  describe("maintainer notes", () => {
    const probePath = value(parseRepoRelativePath("probe.ts"));
    const noteId = value(parseLocalNoteId("note-fixture-1"));

    async function notedReview() {
      const harness = await localApplyHarness();
      await writeFile(join(harness.repositoryPath, "probe.ts"), probe);
      const workbench = await harness.open();
      const key = {
        profileId,
        reviewId: workbench.review.id,
        sessionId: workbench.session.id,
      };
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
