import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseRepoRelativePath,
  parseReviewId,
  parseReviewSessionId,
} from "../../src/domain/ids";
import type { LocalDraftEntry } from "../../src/domain/local-draft";
import { err } from "../../src/domain/result";
import {
  indexPatchHunks,
  placeInView,
  type LocalPatchView,
} from "../../src/domain/local-patch-view";
import {
  cleanupLocalApplyRoots,
  git,
  localApplyHarness,
  profileId,
  value,
  type LocalApplyHarness,
} from "./local-apply-fixture";
import {
  featureWithCheckoutChanges,
  loadSession,
  readViewPatches,
  shared,
} from "./local-review-shared-fixture";

afterEach(cleanupLocalApplyRoots);

/** Where `note` renders in `view` of the stored session `sessionId`, from its stored view patches. */
async function placementIn(
  harness: LocalApplyHarness,
  sessionId: string,
  note: LocalDraftEntry,
  view: LocalPatchView,
) {
  const views = await readViewPatches(await loadSession(harness, sessionId));
  return placeInView(note, view, {
    paths: {
      combined: views.combined.paths,
      committed: views.committed.paths,
      uncommitted: views.uncommitted.paths,
    },
    shownHunks: indexPatchHunks(views[view].text),
  });
}

describe("Local drafts across the shared Review's patch views (#556)", () => {
  it("keeps a note made on Uncommitted inline in Combined and Committed after the agent commits its line and the maintainer Refreshes (D1, D6)", async () => {
    const harness = await localApplyHarness();
    const { repositoryPath } = harness;
    await featureWithCheckoutChanges(harness);
    const opened = await harness.open(shared());
    const reviewId = value(parseReviewId(opened.review.id));
    const [note] = value(
      await harness.drafts.addNote({
        profileId,
        reviewId,
        sessionId: value(parseReviewSessionId(opened.session.id)),
        view: "uncommitted",
        anchor: {
          path: value(parseRepoRelativePath("feature.txt")),
          side: "new",
          startLine: 2,
          line: 2,
        },
        text: "Say why this line is here.",
      }),
    ).localDrafts;
    if (note === undefined) throw new Error("Expected the added note");
    const committedBefore = await placementIn(
      harness,
      opened.session.id,
      note,
      "committed",
    );

    git(repositoryPath, "add", "-A");
    git(repositoryPath, "commit", "-q", "-m", "agent commits");
    const refreshed = value(await harness.opening.refresh(profileId, reviewId));

    expect(committedBefore).toEqual({
      placement: "not_inline",
      reason: "tree_not_in_view",
    });
    expect(refreshed.session.id).not.toBe(opened.session.id);
    const [carried] = refreshed.localDrafts ?? [];
    expect(carried).toMatchObject({
      kind: "note",
      noteId: note.kind === "note" ? note.noteId : "missing",
      text: "Say why this line is here.",
      sessionId: refreshed.session.id,
      view: "uncommitted",
      path: "feature.txt",
      side: "new",
      startLine: 2,
      line: 2,
      state: "unchanged",
    });
    if (carried === undefined) throw new Error("Expected the carried note");
    const inline = {
      placement: "inline",
      side: "new",
      startLine: 2,
      line: 2,
    };
    expect(
      await placementIn(harness, refreshed.session.id, carried, "combined"),
    ).toEqual(inline);
    expect(
      await placementIn(harness, refreshed.session.id, carried, "committed"),
    ).toEqual(inline);
  });

  it.each(["GitReadFailed", "GitReadOutputExceeded"] as const)(
    "refuses Refresh on %s while reading a Committed note without changing its state",
    async (failure) => {
      let failRead = false;
      const harness = await localApplyHarness(undefined, {
        preparationGit: (argv, run) =>
          failRead &&
          argv.includes("show") &&
          argv.at(-1)?.endsWith(":notes.txt")
            ? Promise.resolve(err({ _tag: failure }))
            : run(),
      });
      const { repositoryPath } = harness;
      git(repositoryPath, "checkout", "-q", "-b", "feature");
      await writeFile(join(repositoryPath, "notes.txt"), "a\nb\nc\nd\ne\n");
      git(repositoryPath, "add", "notes.txt");
      git(repositoryPath, "commit", "-q", "-m", "notes");
      const opened = await harness.open(shared());
      const reviewId = value(parseReviewId(opened.review.id));
      value(
        await harness.drafts.addNote({
          profileId,
          reviewId,
          sessionId: value(parseReviewSessionId(opened.session.id)),
          view: "committed",
          anchor: {
            path: value(parseRepoRelativePath("notes.txt")),
            side: "new",
            startLine: 3,
            line: 3,
          },
          text: "Explain c.",
        }),
      );
      const before = value(await harness.reviews.load(profileId, reviewId));
      git(repositoryPath, "branch", "-f", "main", "HEAD");
      failRead = true;

      const refused = await harness.opening.refresh(profileId, reviewId);

      expect(refused).toEqual({ _tag: "err", error: { reason: "storage" } });
      const stored = value(await harness.reviews.load(profileId, reviewId));
      expect(stored.currentSessionId).toBe(opened.session.id);
      expect(stored.localDrafts).toEqual(before.localDrafts);
      expect(
        value(await harness.drafts.feedback(profileId, reviewId)).localDrafts,
      ).toMatchObject([{ state: "current", text: "Explain c." }]);
    },
  );

  it("keeps the existing carry rule when a Committed note's file is absent at HEAD", async () => {
    const harness = await localApplyHarness();
    const { repositoryPath } = harness;
    git(repositoryPath, "checkout", "-q", "-b", "feature");
    await writeFile(join(repositoryPath, "notes.txt"), "a\nb\nc\nd\ne\n");
    git(repositoryPath, "add", "notes.txt");
    git(repositoryPath, "commit", "-q", "-m", "notes");
    const opened = await harness.open(shared());
    const reviewId = value(parseReviewId(opened.review.id));
    value(
      await harness.drafts.addNote({
        profileId,
        reviewId,
        sessionId: value(parseReviewSessionId(opened.session.id)),
        view: "committed",
        anchor: {
          path: value(parseRepoRelativePath("notes.txt")),
          side: "new",
          startLine: 3,
          line: 3,
        },
        text: "Explain c.",
      }),
    );
    git(repositoryPath, "rm", "-q", "notes.txt");
    git(repositoryPath, "commit", "-q", "-m", "remove notes");

    const refreshed = value(await harness.opening.refresh(profileId, reviewId));

    expect(refreshed.localDrafts).toMatchObject([
      {
        kind: "note",
        text: "Explain c.",
        view: "committed",
        state: "needs_attention",
      },
    ]);
  });

  it("carries a note made on Committed against the checkout HEAD's file, not the Local snapshot's, once its lines leave the Committed patch", async () => {
    const harness = await localApplyHarness();
    const { repositoryPath } = harness;
    git(repositoryPath, "checkout", "-q", "-b", "feature");
    await writeFile(join(repositoryPath, "notes.txt"), "a\nb\nc\nd\ne\n");
    git(repositoryPath, "add", "notes.txt");
    git(repositoryPath, "commit", "-q", "-m", "notes");
    // The snapshot changes the noted line, so a carry that read it would call the note changed.
    await writeFile(join(repositoryPath, "notes.txt"), "a\nb\nC\nd\ne\n");
    const opened = await harness.open(shared());
    const reviewId = value(parseReviewId(opened.review.id));
    value(
      await harness.drafts.addNote({
        profileId,
        reviewId,
        sessionId: value(parseReviewSessionId(opened.session.id)),
        view: "committed",
        anchor: {
          path: value(parseRepoRelativePath("notes.txt")),
          side: "new",
          startLine: 3,
          line: 3,
        },
        text: "Explain c.",
      }),
    );
    const statusBefore = git(repositoryPath, "status", "--porcelain");

    // `main` catching up with the branch empties Committed.
    git(repositoryPath, "branch", "-f", "main", "HEAD");
    const refreshed = value(await harness.opening.refresh(profileId, reviewId));

    const views = await readViewPatches(
      await loadSession(harness, refreshed.session.id),
    );
    expect(views.committed.text).toBe("");
    expect(refreshed.localDrafts).toEqual([
      expect.objectContaining({
        kind: "note",
        noteId: "note-fixture-1",
        sessionId: refreshed.session.id,
        view: "committed",
        startLine: 3,
        line: 3,
        state: "unchanged",
      }),
    ]);
    const stored = value(await harness.reviews.load(profileId, reviewId));
    expect(stored.localDrafts).toMatchObject([
      { view: "committed", anchor: { selectedLines: ["c"] } },
    ]);
    expect(git(repositoryPath, "status", "--porcelain")).toBe(statusBefore);
  });
});
