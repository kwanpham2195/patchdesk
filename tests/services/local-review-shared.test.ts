import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import {
  parseLocalBranchName,
  parseRepoRelativePath,
  parseReviewId,
  parseReviewSessionId,
  type LocalBranchName,
} from "../../src/domain/ids";
import type { LocalReviewSourceRequest } from "../../src/domain/review-source";
import {
  cleanupLocalApplyRoots,
  git,
  localApplyHarness,
  profileId,
  repository,
  value,
  type LocalApplyHarness,
} from "./local-apply-fixture";

afterEach(cleanupLocalApplyRoots);

const main = value(parseLocalBranchName("main"));

function shared(baseBranch: LocalBranchName = main): LocalReviewSourceRequest {
  return { kind: "local_branch", baseBranch };
}

/** The reopen of a shared Review the maintainer opened on `branch`. */
function reopenOn(branch: string): LocalReviewSourceRequest {
  return {
    kind: "local_branch",
    baseBranch: main,
    expectedHead: {
      kind: "branch",
      branch: value(parseLocalBranchName(branch)),
    },
  };
}

function indexBytes(repositoryPath: string): Promise<Buffer> {
  return readFile(join(repositoryPath, ".git", "index"));
}

/**
 * Branch `feature` off `main` with one commit, `main` moved on past the fork,
 * and on `feature` a staged edit, an unstaged edit, and an untracked file.
 */
async function featureWithCheckoutChanges(
  harness: LocalApplyHarness,
): Promise<void> {
  const { repositoryPath } = harness;
  git(repositoryPath, "checkout", "-q", "-b", "feature");
  await writeFile(join(repositoryPath, "feature.txt"), "committed\n");
  git(repositoryPath, "add", "feature.txt");
  git(repositoryPath, "commit", "-q", "-m", "feature");
  git(repositoryPath, "checkout", "-q", "main");
  await writeFile(join(repositoryPath, "main-only.txt"), "main\n");
  git(repositoryPath, "add", "main-only.txt");
  git(repositoryPath, "commit", "-q", "-m", "main moves on");
  git(repositoryPath, "checkout", "-q", "feature");
  await writeFile(join(repositoryPath, "tracked.txt"), "staged\n");
  git(repositoryPath, "add", "tracked.txt");
  await writeFile(join(repositoryPath, "feature.txt"), "committed\nunstaged\n");
  await writeFile(join(repositoryPath, "untracked.txt"), "untracked\n");
}

describe("the shared local Review (#555)", () => {
  it("shows every change since the merge base, committed or not, and reopens unchanged content on the same session without touching the checkout", async () => {
    const harness = await localApplyHarness();
    const { repositoryPath } = harness;
    await featureWithCheckoutChanges(harness);
    // `git status` refreshes the index, so it runs before the bytes are read.
    const statusBefore = git(repositoryPath, "status", "--porcelain");
    const indexBefore = await indexBytes(repositoryPath);
    const head = git(repositoryPath, "rev-parse", "HEAD").trim();

    const opened = await harness.open(shared());
    const reopened = await harness.open(shared());

    expect(opened.session.key.source).toEqual({
      kind: "local_branch",
      branch: "feature",
      baseBranch: "main",
    });
    const patch = opened.fullPatch ?? "";
    expect(patch).toContain("+++ b/feature.txt");
    expect(patch).toContain("+unstaged");
    expect(patch).toContain("+staged");
    expect(patch).toContain("+++ b/untracked.txt");
    expect(patch).not.toContain("main-only.txt");
    const session = value(
      await new ReviewSessionStore(harness.paths).load(
        profileId,
        value(parseReviewSessionId(opened.session.id)),
      ),
    );
    // The projection carries no base, so the stored session answers for the pair.
    expect(session.key.baseSha).toBe(
      git(repositoryPath, "merge-base", "main", "HEAD").trim(),
    );
    expect("checkoutHeadSha" in session && session.checkoutHeadSha).toBe(head);
    expect(
      git(repositoryPath, "rev-parse", `${opened.session.key.headSha}^`).trim(),
    ).toBe(head);
    expect(reopened.review.id).toBe(opened.review.id);
    expect(reopened.session.id).toBe(opened.session.id);
    expect(await indexBytes(repositoryPath)).toEqual(indexBefore);
    expect(git(repositoryPath, "status", "--porcelain")).toBe(statusBefore);
    expect(git(repositoryPath, "rev-parse", "HEAD").trim()).toBe(head);
  });

  it("keeps a note on an uncommitted line inline after the agent commits it and the maintainer Refreshes (#491)", async () => {
    const harness = await localApplyHarness();
    const { repositoryPath } = harness;
    await featureWithCheckoutChanges(harness);
    const opened = await harness.open(shared());
    const reviewId = value(parseReviewId(opened.review.id));
    const noted = value(
      await harness.drafts.addNote({
        profileId,
        reviewId,
        sessionId: value(parseReviewSessionId(opened.session.id)),
        anchor: {
          path: value(parseRepoRelativePath("feature.txt")),
          side: "new",
          startLine: 2,
          line: 2,
        },
        text: "Say why this line is here.",
      }),
    );
    const [note] = noted.localDrafts;

    git(repositoryPath, "add", "-A");
    git(repositoryPath, "commit", "-q", "-m", "agent commits");
    const refreshed = value(await harness.opening.refresh(profileId, reviewId));
    const feedback = value(await harness.drafts.feedback(profileId, reviewId));

    expect(refreshed.review.id).toBe(opened.review.id);
    expect(refreshed.session.id).not.toBe(opened.session.id);

    expect(refreshed.fullPatch).toContain("+unstaged");
    expect(feedback.localDrafts).toEqual([
      expect.objectContaining({
        kind: "note",
        noteId: note?.kind === "note" ? note.noteId : "missing",
        text: "Say why this line is here.",
        path: "feature.txt",
        side: "new",
        line: 2,
        state: "unchanged",
      }),
    ]);
  });

  it("refuses a base branch that does not exist, writing no snapshot", async () => {
    const harness = await localApplyHarness();
    const { repositoryPath } = harness;
    await writeFile(join(repositoryPath, "untracked.txt"), "new\n");
    const objectsBefore = git(repositoryPath, "count-objects").trim();

    const opened = await harness.opening.open({
      profileId,
      repository,
      request: shared(value(parseLocalBranchName("gone"))),
    });

    expect(opened).toEqual({
      _tag: "err",
      error: { reason: "revision_not_found" },
    });
    expect(git(repositoryPath, "count-objects").trim()).toBe(objectsBefore);
  });

  it("refuses a Refresh once the base branch is deleted, leaving the Review on its session", async () => {
    const harness = await localApplyHarness();
    const { repositoryPath } = harness;
    git(repositoryPath, "branch", "-q", "develop");
    git(repositoryPath, "checkout", "-q", "-b", "feature");
    await writeFile(join(repositoryPath, "untracked.txt"), "new\n");
    const opened = await harness.open(
      shared(value(parseLocalBranchName("develop"))),
    );
    git(repositoryPath, "branch", "-q", "-D", "develop");

    const refreshed = await harness.opening.refresh(
      profileId,
      value(parseReviewId(opened.review.id)),
    );

    expect(refreshed).toEqual({
      _tag: "err",
      error: { reason: "revision_not_found" },
    });
    expect(
      value(
        await harness.reviews.load(
          profileId,
          value(parseReviewId(opened.review.id)),
        ),
      ).currentSessionId,
    ).toBe(opened.session.id);
  });

  it("refuses to reopen a branch's shared Review after a branch switch, creating nothing", async () => {
    const harness = await localApplyHarness();
    const { repositoryPath } = harness;
    git(repositoryPath, "checkout", "-q", "-b", "feature");
    const opened = await harness.open(shared());
    git(repositoryPath, "checkout", "-q", "-b", "other");

    const reopened = await harness.opening.open({
      profileId,
      repository,
      request: reopenOn("feature"),
    });
    const refreshed = await harness.opening.refresh(
      profileId,
      value(parseReviewId(opened.review.id)),
    );

    const branchMismatch = {
      _tag: "err",
      error: { reason: "branch_mismatch", currentBranch: "other" },
    };
    expect(reopened).toEqual(branchMismatch);
    expect(refreshed).toEqual(branchMismatch);
    expect(value(await harness.reviews.list(profileId)).reviews).toHaveLength(
      1,
    );
  });

  it("names a detached HEAD `detached` and reopens it while HEAD stays detached", async () => {
    const harness = await localApplyHarness();
    const { repositoryPath } = harness;
    git(repositoryPath, "checkout", "-q", "-b", "feature");
    await writeFile(join(repositoryPath, "feature.txt"), "feature\n");
    git(repositoryPath, "add", "feature.txt");
    git(repositoryPath, "commit", "-q", "-m", "feature");
    git(repositoryPath, "checkout", "-q", "--detach");

    const opened = await harness.open(shared());
    const refreshed = value(
      await harness.opening.refresh(
        profileId,
        value(parseReviewId(opened.review.id)),
      ),
    );

    expect(opened.session.key.source).toEqual({
      kind: "local_branch",
      branch: "detached",
      baseBranch: "main",
    });
    expect(opened.fullPatch).toContain("+++ b/feature.txt");
    expect(refreshed.session.id).toBe(opened.session.id);
  });
});
