import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import { ViewedFilesStore } from "../../src/adapters/storage/viewed-files-store";
import { parseReviewId, parseReviewSessionId } from "../../src/domain/ids";
import { LocalPatchViewService } from "../../src/services/local-patch-view-service";
import type { ReviewWorkbenchProjection } from "../../src/services/review-workbench-projection";
import {
  cleanupLocalApplyRoots,
  git,
  localApplyHarness,
  profileId,
  value,
  type LocalApplyHarness,
} from "./local-apply-fixture";
import { loadSession } from "./local-review-shared-fixture";

afterEach(cleanupLocalApplyRoots);

/** `feature` commits a line to tracked.txt and leaves a second one uncommitted. */
async function featureWithChanges(harness: LocalApplyHarness): Promise<void> {
  const { repositoryPath } = harness;
  git(repositoryPath, "checkout", "-q", "-b", "feature");
  await writeFile(join(repositoryPath, "tracked.txt"), "one\ncommitted\n");
  git(repositoryPath, "commit", "-q", "-am", "feature");
  await writeFile(
    join(repositoryPath, "tracked.txt"),
    "one\ncommitted\nuncommitted\n",
  );
}

function loadRound(
  harness: LocalApplyHarness,
  workbench: ReviewWorkbenchProjection,
) {
  return new LocalPatchViewService({
    reviews: harness.reviews,
    sessions: new ReviewSessionStore(harness.paths),
    viewedFiles: new ViewedFilesStore(harness.paths, {
      write: () => undefined,
    }),
  }).loadRound({
    profileId,
    reviewId: value(parseReviewId(workbench.review.id)),
    sessionId: value(parseReviewSessionId(workbench.session.id)),
  });
}

function changedLines(patch: string): ReadonlyArray<string> {
  return patch
    .split("\n")
    .filter(
      (line) =>
        (line.startsWith("+") && !line.startsWith("+++")) ||
        (line.startsWith("-") && !line.startsWith("---")),
    );
}

describe("Since last Refresh (#604)", () => {
  it("holds only the change the Refresh moved the Review across", async () => {
    const harness = await localApplyHarness();
    await featureWithChanges(harness);
    const first = await harness.open();
    const beforeRefresh = await loadRound(harness, first);
    await writeFile(
      join(harness.repositoryPath, "tracked.txt"),
      "one\ncommitted\nuncommitted\nsecond round\n",
    );

    const refreshed = value(
      await harness.opening.refresh(profileId, first.review.id),
    );

    expect(first.sinceLastRefresh).toBe("none");
    expect(beforeRefresh).toEqual({
      _tag: "err",
      error: { reason: "not_found" },
    });
    expect(refreshed.session.id).not.toBe(first.session.id);
    expect(refreshed.sinceLastRefresh).toBe("available");
    const round = value(await loadRound(harness, refreshed));
    expect(round.sessionId).toBe(refreshed.session.id);
    expect(changedLines(round.patch)).toEqual(["+second round"]);
    expect(
      (await loadSession(harness, refreshed.session.id)).round,
    ).toMatchObject({ _tag: "Patch", fromSessionId: first.session.id });
  });

  it("writes no patch when the merge base moved, since it would hold the base branch's commits", async () => {
    const harness = await localApplyHarness();
    const { repositoryPath } = harness;
    await featureWithChanges(harness);
    const first = await harness.open();
    git(repositoryPath, "commit", "-q", "-am", "commit the rest");
    git(repositoryPath, "checkout", "-q", "main");
    await writeFile(join(repositoryPath, "main-only.txt"), "main\n");
    git(repositoryPath, "add", "main-only.txt");
    git(repositoryPath, "commit", "-q", "-m", "main moves on");
    git(repositoryPath, "checkout", "-q", "feature");
    git(repositoryPath, "merge", "-q", "--no-edit", "main");

    const refreshed = value(
      await harness.opening.refresh(profileId, first.review.id),
    );

    expect(refreshed.session.id).not.toBe(first.session.id);
    expect(refreshed.sinceLastRefresh).toBe("base_moved");
    expect(await loadRound(harness, refreshed)).toEqual({
      _tag: "err",
      error: { reason: "not_found" },
    });
    const roundFile = harness.paths.roundPatchFile(
      profileId,
      value(parseReviewSessionId(refreshed.session.id)),
    );
    await expect(access(roundFile)).rejects.toThrow();
  });
});
