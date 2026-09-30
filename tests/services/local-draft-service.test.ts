import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseFindingId,
  parseLocalNoteId,
  parseRepoRelativePath,
} from "../../src/domain/ids";
import { dismissInsightFinding } from "../../src/domain/insight-record";
import { ok } from "../../src/domain/result";
import { isLocalReview } from "../../src/domain/review";
import { markLocalDraftsApplied } from "../../src/domain/review-local-drafts";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import { ReviewInsightReader } from "../../src/services/review-insight-reading";
import {
  cleanupLocalApplyRoots,
  git,
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
    expect(removed).toEqual({
      _tag: "ok",
      value: { localDrafts: [], localDraftReplies: [] },
    });
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
        view: "combined",
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
        view: "combined",
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
    const reader = new ReviewInsightReader(
      { load: async () => ok(shown) },
      new ReviewSessionStore(harness.paths),
      harness.reviews,
    );

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

    if (reading.result?.type !== "analysis")
      throw new Error("expected a retained Analysis");
    expect(
      reading.result.findings.map(({ id, dismissed, drafted, applied }) => ({
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
    expect(feedback.localDrafts).toMatchObject(shown.localDrafts ?? []);
    // Both drafted Findings were written on the current session, in Combined, on lines of its patch.
    expect(
      feedback.localDrafts.map(({ view, inline }) => ({ view, inline })),
    ).toEqual([
      { view: "combined", inline: true },
      { view: "combined", inline: true },
    ]);
    expect(feedback.markdown).toContain(boundFix.title);
    expect(feedback.markdown).not.toContain(appliedFix.title);
  });

  describe("maintainer notes", () => {
    const probePath = value(parseRepoRelativePath("probe.ts"));
    const noteId = value(parseLocalNoteId("note-fixture-1"));
    // Assembled at runtime so the source holds no token a secret scanner would flag.
    const leakedToken = `The agent printed ghp_${"a".repeat(36)} in the log.`;

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
        view: "combined",
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
      expect(removed).toEqual({
        _tag: "ok",
        value: { localDrafts: [], localDraftReplies: [] },
      });
    });

    it("fingerprints a note made on Committed against the Committed patch and stores its view (#556)", async () => {
      const harness = await localApplyHarness();
      const { repositoryPath } = harness;
      git(repositoryPath, "checkout", "-q", "-b", "feature");
      await writeFile(join(repositoryPath, "probe.ts"), probe);
      git(repositoryPath, "add", "probe.ts");
      git(repositoryPath, "commit", "-q", "-m", "probe");
      // Uncommitted lines above the function move every Combined line of it down by two.
      await writeFile(
        join(repositoryPath, "probe.ts"),
        `// one\n// two\n${probe}`,
      );
      const workbench = await harness.open();

      const added = await harness.drafts.addNote({
        profileId,
        reviewId: workbench.review.id,
        sessionId: workbench.session.id,
        view: "committed",
        anchor: { path: probePath, side: "new", startLine: 3, line: 3 },
        text: "Off by one.",
      });

      expect(added).toMatchObject({
        _tag: "ok",
        value: {
          localDrafts: [
            { kind: "note", view: "committed", startLine: 3, line: 3 },
          ],
        },
      });
      const stored = value(
        await harness.reviews.load(profileId, workbench.review.id),
      );
      expect(stored.localDrafts).toMatchObject([
        {
          view: "committed",
          anchor: {
            selectedLines: [
              "  for (let index = 0; index <= values.length; index += 1) {",
            ],
            before: [
              "export function sum(values: number[]): number {",
              "  let total = 0;",
            ],
          },
        },
      ]);
    });

    it("says in get_feedback which view each note was written in and whether its lines are in that view's diff now (#558)", async () => {
      const harness = await localApplyHarness();
      const { repositoryPath } = harness;
      await writeFile(join(repositoryPath, "probe.ts"), probe);
      git(repositoryPath, "add", "probe.ts");
      git(repositoryPath, "commit", "-q", "-m", "probe");
      git(repositoryPath, "checkout", "-q", "-b", "feature");
      await writeFile(join(repositoryPath, "other.ts"), "one\ntwo\nthree\n");
      git(repositoryPath, "add", "other.ts");
      git(repositoryPath, "commit", "-q", "-m", "other");
      // Combined adds other.ts whole, so only Uncommitted shows its old side.
      await writeFile(join(repositoryPath, "other.ts"), "one\nTWO\nthree\n");
      await writeFile(
        join(repositoryPath, "probe.ts"),
        probe.replace("index <= values", "index < values"),
      );
      await writeFile(join(repositoryPath, "gone.ts"), "a\nb\nc\n");
      const first = await harness.open();
      const noteOn = (
        path: string,
        side: "new" | "old",
        line: number,
        view: "combined" | "uncommitted",
      ) =>
        harness.drafts.addNote({
          profileId,
          reviewId: first.review.id,
          sessionId: first.session.id,
          view,
          anchor: {
            path: value(parseRepoRelativePath(path)),
            side,
            startLine: line,
            line,
          },
          text: `On ${path}.`,
        });
      value(await noteOn("gone.ts", "new", 2, "combined"));
      value(await noteOn("other.ts", "old", 2, "uncommitted"));
      value(await noteOn("probe.ts", "new", 3, "combined"));

      const before = value(
        await harness.drafts.feedback(profileId, first.review.id),
      );
      // The agent reverts the loop fix and deletes gone.ts.
      await writeFile(join(repositoryPath, "probe.ts"), probe);
      await rm(join(repositoryPath, "gone.ts"));
      const second = await harness.open();
      const after = value(
        await harness.drafts.feedback(profileId, first.review.id),
      );

      const described = (feedback: typeof before) =>
        feedback.localDrafts.map(({ path, view, state, inline }) => [
          path,
          view,
          state,
          inline,
        ]);
      expect(described(before)).toEqual([
        ["gone.ts", "combined", "current", true],
        ["other.ts", "uncommitted", "current", true],
        ["probe.ts", "combined", "current", true],
      ]);
      expect(second.session.id).not.toBe(first.session.id);
      // The reverted loop is found between its context, so the note moves to it though the line left the patch.
      expect(described(after)).toEqual([
        ["gone.ts", "combined", "needs_attention", false],
        ["other.ts", "uncommitted", "unchanged", true],
        ["probe.ts", "combined", "changed", false],
      ]);
      expect(after.localDrafts[2]).toMatchObject({
        sessionId: second.session.id,
        startLine: 3,
        line: 3,
      });
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
      [
        "a credential-shaped value",
        { path: probePath, side: "new" as const, startLine: 2, line: 2 },
        leakedToken,
        "draft_sensitive",
      ],
    ])(
      "refuses a note on %s and stores nothing",
      async (_case, anchor, text, reason) => {
        const { harness, key } = await notedReview();

        const refused = await harness.drafts.addNote({
          ...key,
          view: "combined",
          anchor,
          text,
        });

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
          view: "combined",
          ...key,
          anchor: { path: probePath, side: "new", startLine: 3, line: 3 },
          text: "Off by one.",
        }),
      );
      const lock = `${profileId}:${key.reviewId}`;
      expect(harness.coordinator.acquire(lock)).toBe(true);

      const add = await harness.drafts.addNote({
        view: "combined",
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

    it("refuses editing a note to hold a credential-shaped value and keeps the stored text", async () => {
      const { harness, key } = await notedReview();
      value(
        await harness.drafts.addNote({
          view: "combined",
          ...key,
          anchor: { path: probePath, side: "new", startLine: 3, line: 3 },
          text: "Off by one.",
        }),
      );

      const edit = await harness.drafts.editNote({
        ...key,
        noteId,
        text: leakedToken,
      });

      expect(edit).toEqual({
        _tag: "err",
        error: { reason: "draft_sensitive" },
      });
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

    it("stores Ready for agent, reports a note added after it as changedSinceHandoff, and clears the hand-off on a move (#603)", async () => {
      const { harness, key } = await notedReview();
      value(
        await harness.drafts.addNote({
          view: "combined",
          ...key,
          anchor: { path: probePath, side: "new", startLine: 3, line: 3 },
          text: "Off by one.",
        }),
      );

      const handedOff = await harness.drafts.handOff({
        ...key,
        verdict: "changes_requested",
      });
      const beforeLateNote = value(
        await harness.drafts.feedback(profileId, key.reviewId),
      );
      const lateNote = await harness.drafts.addNote({
        view: "combined",
        ...key,
        anchor: { path: probePath, side: "new", startLine: 2, line: 2 },
        text: "Start at zero.",
      });
      const afterLateNote = value(
        await harness.drafts.feedback(profileId, key.reviewId),
      );
      await writeFile(
        join(harness.repositoryPath, "probe.ts"),
        `${probe}export const more = 1;\n`,
      );
      const moved = await harness.open();
      const afterMove = value(
        await harness.drafts.feedback(profileId, key.reviewId),
      );

      const handoff = { at: now, verdict: "changes_requested" };
      expect(handedOff).toMatchObject({
        _tag: "ok",
        value: { feedbackHandoff: { handoff, changedSinceHandoff: false } },
      });
      expect(beforeLateNote).toMatchObject({
        handoff,
        changedSinceHandoff: false,
      });
      expect(lateNote).toMatchObject({
        _tag: "ok",
        value: { feedbackHandoff: { handoff, changedSinceHandoff: true } },
      });
      expect(afterLateNote).toMatchObject({
        handoff,
        changedSinceHandoff: true,
      });
      expect(moved.session.id).not.toBe(key.sessionId);
      expect(moved.feedbackHandoff).toBeNull();
      expect(afterMove).not.toHaveProperty("handoff");
      expect(afterMove).not.toHaveProperty("changedSinceHandoff");
      expect(afterMove.localDrafts).toHaveLength(2);
    });

    it("keeps the hand-off when the Review is reopened on unchanged content (#603)", async () => {
      const { harness, key } = await notedReview();
      value(await harness.drafts.handOff({ ...key, verdict: "looks_good" }));

      const reopened = await harness.open();

      expect(reopened.session.id).toBe(key.sessionId);
      expect(reopened.feedbackHandoff).toMatchObject({
        handoff: { at: now, verdict: "looks_good" },
        changedSinceHandoff: false,
      });
      const stored = value(await harness.reviews.load(profileId, key.reviewId));
      expect(stored.handoff).toEqual({ at: now, verdict: "looks_good" });
    });

    it("stamps a hand-off without a verdict on Copy as agent prompt, replacing Ready for agent's, and keeps the verdict out of the prompt (#603)", async () => {
      const { harness, key } = await notedReview();
      value(
        await harness.drafts.addNote({
          view: "combined",
          ...key,
          anchor: { path: probePath, side: "new", startLine: 3, line: 3 },
          text: "Off by one.",
        }),
      );
      value(await harness.drafts.handOff({ ...key, verdict: "looks_good" }));
      value(await harness.drafts.removeNote({ ...key, noteId }));

      const copied = value(
        await harness.drafts.agentPrompt(profileId, key.reviewId),
      );
      const feedback = value(
        await harness.drafts.feedback(profileId, key.reviewId),
      );

      expect(copied.feedbackHandoff).toEqual({
        handoff: { at: now },
        changedSinceHandoff: false,
      });
      expect(feedback).toMatchObject({
        handoff: { at: now },
        changedSinceHandoff: false,
      });
      expect(feedback.handoff).not.toHaveProperty("verdict");
      expect(copied.markdown).not.toMatch(/looks_good|looks good/i);
    });

    it("refuses Ready for agent on a session the Review has moved past, and Copy as agent prompt while the Review is held (#603)", async () => {
      const { harness, key } = await notedReview();
      await writeFile(
        join(harness.repositoryPath, "probe.ts"),
        `${probe}export const more = 1;\n`,
      );
      await harness.open();
      const lock = `${profileId}:${key.reviewId}`;

      const stale = await harness.drafts.handOff(key);
      expect(harness.coordinator.acquire(lock)).toBe(true);
      const held = await harness.drafts.agentPrompt(profileId, key.reviewId);
      harness.coordinator.release(lock);

      expect([stale, held]).toEqual([
        { _tag: "err", error: { reason: "not_applicable" } },
        { _tag: "err", error: { reason: "in_progress" } },
      ]);
      const stored = value(await harness.reviews.load(profileId, key.reviewId));
      expect(stored.handoff).toBeUndefined();
    });
  });
});
