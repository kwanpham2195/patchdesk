import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import { ViewedFilesStore } from "../../src/adapters/storage/viewed-files-store";
import {
  parseGitShaPrefix,
  parseRepoRelativePath,
  parseReviewId,
  parseReviewSessionId,
} from "../../src/domain/ids";
import type { LocalPatchView } from "../../src/domain/local-patch-view";
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

afterEach(cleanupLocalApplyRoots);

/** `feature` commits `committed` to tracked.txt, then leaves `uncommitted` unstaged after it. */
async function featureWithCommittedAndUncommittedLines(
  harness: LocalApplyHarness,
): Promise<void> {
  const { repositoryPath } = harness;
  git(repositoryPath, "checkout", "-q", "-b", "feature");
  await writeFile(join(repositoryPath, "tracked.txt"), "one\ncommitted\n");
  git(repositoryPath, "commit", "-q", "-am", "feature");
  await writeFile(
    join(repositoryPath, "tracked.txt"),
    "one\ncommitted\nuncommitted\n",
  );
}

function fixture(harness: LocalApplyHarness) {
  const viewedFiles = new ViewedFilesStore(harness.paths, {
    write: () => undefined,
  });
  const service = new LocalPatchViewService({
    reviews: harness.reviews,
    sessions: new ReviewSessionStore(harness.paths),
    viewedFiles,
  });
  const load = (opened: ReviewWorkbenchProjection, view: LocalPatchView) =>
    service.load({
      profileId,
      reviewId: value(parseReviewId(opened.review.id)),
      sessionId: value(parseReviewSessionId(opened.session.id)),
      view,
    });
  return { viewedFiles, load };
}

describe("LocalPatchViewService (#556)", () => {
  it("reads each view as captured at open, with its own Viewed marks, after the checkout changes", async () => {
    const harness = await localApplyHarness();
    await featureWithCommittedAndUncommittedLines(harness);
    const opened = await harness.open();
    const { viewedFiles, load } = fixture(harness);
    const tracked = value(parseRepoRelativePath("tracked.txt"));
    await viewedFiles.save(
      profileId,
      value(parseReviewSessionId(opened.session.id)),
      "uncommitted",
      [tracked],
    );
    await writeFile(
      join(harness.repositoryPath, "tracked.txt"),
      "edited after open\n",
    );

    const committed = value(await load(opened, "committed"));
    const uncommitted = value(await load(opened, "uncommitted"));

    expect(committed.patch).toContain("+committed");
    expect(committed.patch).not.toContain("uncommitted");
    expect(committed.viewedPaths).toEqual([]);
    expect(uncommitted.patch).toContain(" committed\n+uncommitted");
    expect(uncommitted.patch).not.toContain("edited after open");
    expect(uncommitted.viewedPaths).toEqual([tracked]);
    expect(uncommitted).toMatchObject({
      sessionId: opened.session.id,
      view: "uncommitted",
    });
    // The projection names each view's hash and paths off the session record, before any fetch.
    expect(opened.patchViews?.committed).toEqual({
      patchHash: committed.patchHash,
      paths: ["tracked.txt"],
    });
    expect(opened.patchViews?.uncommitted).toEqual({
      patchHash: uncommitted.patchHash,
      paths: ["tracked.txt"],
    });
    expect(opened.patchViews?.combined.patchHash).toBe(
      opened.revision.patchHash,
    );
  });

  it("refuses stale_head for a session the Review moved past", async () => {
    const harness = await localApplyHarness();
    await featureWithCommittedAndUncommittedLines(harness);
    const first = await harness.open();
    await writeFile(join(harness.repositoryPath, "tracked.txt"), "moved\n");
    const second = await harness.open();
    const { load } = fixture(harness);

    expect(second.session.id).not.toBe(first.session.id);
    expect(await load(first, "uncommitted")).toEqual({
      _tag: "err",
      error: { reason: "stale_head" },
    });
  });

  it("refuses not_local_branch on a commit Review, which has only Combined", async () => {
    const harness = await localApplyHarness();
    const head = git(harness.repositoryPath, "rev-parse", "HEAD").trim();
    const opened = await harness.open({
      kind: "commit",
      commit: value(parseGitShaPrefix(head)),
    });
    const { load } = fixture(harness);

    expect(opened.patchViews).toBeUndefined();
    expect(await load(opened, "committed")).toEqual({
      _tag: "err",
      error: { reason: "not_local_branch" },
    });
  });
});
