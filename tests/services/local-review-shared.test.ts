import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import {
  parseAbsolutePath,
  parseIsoTimestamp,
  parseLocalBranchName,
  parseRepoRelativePath,
  parseReviewId,
  parseReviewSessionId,
  type IsoTimestamp,
} from "../../src/domain/ids";
import { markReviewTerminal } from "../../src/domain/review";
import { err } from "../../src/domain/result";
import type { LocalReviewSourceRequest } from "../../src/domain/review-source";
import {
  cleanupLocalApplyRoots,
  git,
  localApplyHarness,
  now,
  profileId,
  repository,
  value,
  type LocalApplyHarness,
} from "./local-apply-fixture";
import {
  featureWithCheckoutChanges,
  indexBytes,
  loadSession,
  main,
  readViewPatches,
  shared,
} from "./local-review-shared-fixture";

afterEach(cleanupLocalApplyRoots);

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
    const session = await loadSession(harness, opened.session.id);
    // The projection carries no base, so the stored session answers for the pair.
    expect(session.key.baseSha).toBe(
      git(repositoryPath, "merge-base", "main", "HEAD").trim(),
    );
    expect(session.checkoutHeadSha).toBe(head);
    const views = await readViewPatches(session);
    expect(views.combined.text).toBe(patch);
    expect(views.combined.paths).toEqual([
      "feature.txt",
      "tracked.txt",
      "untracked.txt",
    ]);
    // Committed runs merge base to `HEAD`: the commit, none of the checkout's changes.
    expect(views.committed.text).toContain("+committed");
    expect(views.committed.text).not.toContain("unstaged");
    expect(views.committed.paths).toEqual(["feature.txt"]);
    // Uncommitted runs `HEAD` to the snapshot: staged, unstaged, and untracked, not the commit.
    expect(views.uncommitted.text).toContain("+unstaged");
    expect(views.uncommitted.text).toContain("+staged");
    expect(views.uncommitted.text).not.toContain("+committed");
    expect(views.uncommitted.paths).toEqual([
      "feature.txt",
      "tracked.txt",
      "untracked.txt",
    ]);
    expect(
      git(repositoryPath, "rev-parse", `${opened.session.key.headSha}^`).trim(),
    ).toBe(head);
    expect(reopened.review.id).toBe(opened.review.id);
    expect(reopened.session.id).toBe(opened.session.id);
    expect(await indexBytes(repositoryPath)).toEqual(indexBefore);
    expect(git(repositoryPath, "status", "--porcelain")).toBe(statusBefore);
    expect(git(repositoryPath, "rev-parse", "HEAD").trim()).toBe(head);
  });

  it("stores a working-tree edit that undoes a commit as opposite Committed and Uncommitted patches under an empty Combined (#556)", async () => {
    const harness = await localApplyHarness();
    const { repositoryPath } = harness;
    git(repositoryPath, "checkout", "-q", "-b", "feature");
    await writeFile(join(repositoryPath, "tracked.txt"), "two\n");
    git(repositoryPath, "commit", "-q", "-am", "feature");
    await writeFile(join(repositoryPath, "tracked.txt"), "one\n");
    const statusBefore = git(repositoryPath, "status", "--porcelain");
    const indexBefore = await indexBytes(repositoryPath);

    const opened = await harness.open(shared());

    const views = await readViewPatches(
      await loadSession(harness, opened.session.id),
    );
    expect(views.combined).toEqual({ text: "", paths: [] });
    expect(views.committed.text).toContain("-one\n+two\n");
    expect(views.committed.paths).toEqual(["tracked.txt"]);
    expect(views.uncommitted.text).toContain("-two\n+one\n");
    expect(views.uncommitted.paths).toEqual(["tracked.txt"]);
    expect(await indexBytes(repositoryPath)).toEqual(indexBefore);
    expect(git(repositoryPath, "status", "--porcelain")).toBe(statusBefore);
  });

  it("refuses patch_too_large when only Committed is over the git output cap, leaving no session or patch file (#556 D2)", async () => {
    const harness = await localApplyHarness();
    const { repositoryPath } = harness;
    git(repositoryPath, "checkout", "-q", "-b", "feature");
    await mkdir(join(repositoryPath, "generated"));
    // Three MiB committed, then deleted in the working tree: Combined is empty.
    await writeFile(
      join(repositoryPath, "generated", "bundle.js"),
      "export const line = 0;\n".repeat(140_000),
    );
    git(repositoryPath, "add", "generated");
    git(repositoryPath, "commit", "-q", "-m", "generated");
    await rm(join(repositoryPath, "generated"), { recursive: true });

    const opened = await harness.opening.open({
      profileId,
      repository,
      request: shared(),
    });

    expect(opened).toEqual({
      _tag: "err",
      error: {
        reason: "patch_too_large",
        largestFiles: ["generated/bundle.js"],
      },
    });
    const written = await readdir(
      harness.paths.profileReviewsDirectory(profileId),
      { recursive: true },
    ).catch(() => []);
    expect(
      written.filter(
        (path) => path.endsWith("session.json") || path.endsWith(".diff"),
      ),
    ).toEqual([]);
    expect(value(await harness.reviews.list(profileId)).reviews).toEqual([]);
  });

  it("quarantines a shared Review session stored before view patches and prepares it again under the same ID, keeping its notes (#556 D7)", async () => {
    const harness = await localApplyHarness();
    const { repositoryPath } = harness;
    await featureWithCheckoutChanges(harness);
    const opened = await harness.open(shared());
    const reviewId = value(parseReviewId(opened.review.id));
    const sessionId = value(parseReviewSessionId(opened.session.id));
    await harness.drafts.addNote({
      view: "combined",
      profileId,
      reviewId,
      sessionId,
      anchor: {
        path: value(parseRepoRelativePath("feature.txt")),
        side: "new",
        startLine: 2,
        line: 2,
      },
      text: "Say why this line is here.",
    });
    const sessionFile = harness.paths.sessionFile(profileId, sessionId);
    const stored: { readonly viewPatches?: unknown } = JSON.parse(
      await readFile(sessionFile, "utf8"),
    );
    const { viewPatches: _views, ...older } = stored;
    await writeFile(sessionFile, JSON.stringify(older));
    const statusBefore = git(repositoryPath, "status", "--porcelain");

    const olderRead = await new ReviewSessionStore(harness.paths).load(
      profileId,
      sessionId,
    );
    const reopened = await harness.open(shared());

    expect(olderRead).toMatchObject({
      _tag: "err",
      error: { reason: "invalid_stored_value" },
    });
    expect(reopened.review.id).toBe(opened.review.id);
    expect(reopened.session.id).toBe(opened.session.id);
    const views = await readViewPatches(
      await loadSession(harness, reopened.session.id),
    );
    expect(views.committed.paths).toEqual(["feature.txt"]);
    expect(
      value(await harness.drafts.feedback(profileId, reviewId)).localDrafts,
    ).toEqual([
      expect.objectContaining({
        noteId: "note-fixture-1",
        text: "Say why this line is here.",
        state: "current",
      }),
    ]);
    expect(git(repositoryPath, "status", "--porcelain")).toBe(statusBefore);
  });

  it("carries Viewed marks only for identical file patches in their own view on Refresh", async () => {
    const harness = await localApplyHarness(undefined, {
      retainSupersededSessions: true,
    });
    const { repositoryPath } = harness;
    git(repositoryPath, "checkout", "-q", "-b", "feature");
    await writeFile(join(repositoryPath, "committed-only.txt"), "stable\n");
    await writeFile(join(repositoryPath, "changed-committed.txt"), "before\n");
    git(repositoryPath, "add", "committed-only.txt", "changed-committed.txt");
    git(repositoryPath, "commit", "-q", "-m", "initial feature");
    await writeFile(join(repositoryPath, "combined-only.txt"), "stable\n");
    await writeFile(join(repositoryPath, "uncommitted-only.txt"), "stable\n");
    await writeFile(
      join(repositoryPath, "changed-uncommitted.txt"),
      "before\n",
    );
    const opened = await harness.open(shared());
    const oldSessionId = value(parseReviewSessionId(opened.session.id));
    const oldMarks = {
      combined: [
        "combined-only.txt",
        "changed-committed.txt",
        "changed-uncommitted.txt",
      ],
      committed: ["committed-only.txt", "changed-committed.txt"],
      uncommitted: ["uncommitted-only.txt", "changed-uncommitted.txt"],
    } as const;
    for (const view of ["combined", "committed", "uncommitted"] as const)
      value(
        await harness.viewedFiles.save(
          profileId,
          oldSessionId,
          view,
          oldMarks[view].map((path) => value(parseRepoRelativePath(path))),
        ),
      );

    await writeFile(join(repositoryPath, "changed-committed.txt"), "after\n");
    git(repositoryPath, "commit", "-q", "-am", "change committed patch");
    await writeFile(join(repositoryPath, "changed-uncommitted.txt"), "after\n");
    const refreshed = value(
      await harness.opening.refresh(
        profileId,
        value(parseReviewId(opened.review.id)),
      ),
    );
    const newSessionId = value(parseReviewSessionId(refreshed.session.id));

    expect(newSessionId).not.toBe(oldSessionId);
    expect(refreshed.viewedPaths).toEqual(["combined-only.txt"]);
    for (const [view, kept] of [
      ["combined", ["combined-only.txt"]],
      ["committed", ["committed-only.txt"]],
      ["uncommitted", ["uncommitted-only.txt"]],
    ] as const) {
      expect(
        value(await harness.viewedFiles.load(profileId, newSessionId, view)),
      ).toEqual(kept);
      expect(
        value(await harness.viewedFiles.load(profileId, oldSessionId, view)),
      ).toEqual([...oldMarks[view]].sort());
    }
  });

  it("refuses a failed Viewed carry before moving the Review and clears partial marks on retry", async () => {
    let failCarry = true;
    const harness = await localApplyHarness(undefined, {
      viewedFilesCarry: (store) => ({
        load: store.load.bind(store),
        save: (profile, session, view, paths) =>
          failCarry && view === "committed"
            ? Promise.resolve(
                err({
                  _tag: "StorageFailure" as const,
                  operation: "write" as const,
                  reason: "io" as const,
                }),
              )
            : store.save(profile, session, view, paths),
      }),
    });
    const { repositoryPath } = harness;
    git(repositoryPath, "checkout", "-q", "-b", "feature");
    await writeFile(join(repositoryPath, "keep.txt"), "stable\n");
    git(repositoryPath, "add", "keep.txt");
    git(repositoryPath, "commit", "-q", "-m", "keep file");
    await writeFile(join(repositoryPath, "new.txt"), "before\n");
    const opened = await harness.open(shared());
    const reviewId = value(parseReviewId(opened.review.id));
    const oldSessionId = value(parseReviewSessionId(opened.session.id));
    const keep = value(parseRepoRelativePath("keep.txt"));
    for (const view of ["combined", "committed"] as const)
      value(
        await harness.viewedFiles.save(profileId, oldSessionId, view, [keep]),
      );
    await writeFile(join(repositoryPath, "new.txt"), "after\n");

    const refused = await harness.opening.refresh(profileId, reviewId);

    expect(refused).toEqual({ _tag: "err", error: { reason: "storage" } });
    expect(
      value(await harness.reviews.load(profileId, reviewId)).currentSessionId,
    ).toBe(oldSessionId);
    expect(
      value(
        await harness.viewedFiles.load(profileId, oldSessionId, "combined"),
      ),
    ).toEqual([keep]);
    value(
      await harness.viewedFiles.save(profileId, oldSessionId, "combined", []),
    );
    failCarry = false;

    const retried = value(await harness.opening.refresh(profileId, reviewId));
    const newSessionId = value(parseReviewSessionId(retried.session.id));
    expect(
      value(
        await harness.viewedFiles.load(profileId, newSessionId, "combined"),
      ),
    ).toEqual([]);
    expect(
      value(
        await harness.viewedFiles.load(profileId, newSessionId, "committed"),
      ),
    ).toEqual([keep]);
  });

  it("keeps a note on an uncommitted line inline after the agent commits it and the maintainer Refreshes (#491)", async () => {
    const harness = await localApplyHarness();
    const { repositoryPath } = harness;
    await featureWithCheckoutChanges(harness);
    const opened = await harness.open(shared());
    const reviewId = value(parseReviewId(opened.review.id));
    const noted = value(
      await harness.drafts.addNote({
        view: "combined",
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
        view: "combined",
        inline: true,
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

describe("an agent's open of the shared Review with no base (#555)", () => {
  const agentOpen = (harness: LocalApplyHarness) =>
    harness.opening.openForAgent({
      profileId,
      repository,
      request: { kind: "local_branch" },
    });

  it("reuses the base of the branch's shared Review the maintainer opened, unmoved", async () => {
    const harness = await localApplyHarness();
    const { repositoryPath } = harness;
    git(repositoryPath, "branch", "-q", "develop");
    git(repositoryPath, "checkout", "-q", "-b", "feature");
    await writeFile(join(repositoryPath, "untracked.txt"), "first\n");
    const maintainers = await harness.open(
      shared(value(parseLocalBranchName("develop"))),
    );
    await writeFile(join(repositoryPath, "untracked.txt"), "second\n");

    const opened = value(await agentOpen(harness));

    expect(opened.baseInferred).toBe(false);
    expect(opened.workbench.review.id).toBe(maintainers.review.id);
    expect(opened.workbench.session.id).toBe(maintainers.session.id);
    expect(opened.workbench.session.key.source).toMatchObject({
      baseBranch: "develop",
    });
  });

  it("opens a new shared Review against the inferred base and says it was inferred", async () => {
    const harness = await localApplyHarness();
    const { repositoryPath } = harness;
    git(repositoryPath, "checkout", "-q", "-b", "feature");
    await writeFile(join(repositoryPath, "feature.txt"), "feature\n");
    git(repositoryPath, "add", "feature.txt");
    git(repositoryPath, "commit", "-q", "-m", "feature");

    const opened = value(await agentOpen(harness));

    expect(opened.baseInferred).toBe(true);
    expect(opened.workbench.session.key.source).toEqual({
      kind: "local_branch",
      branch: "feature",
      baseBranch: "main",
    });
    expect(
      value(
        await harness.reviews.load(
          profileId,
          value(parseReviewId(opened.workbench.review.id)),
        ),
      ).lastOpenedAt,
    ).toBeUndefined();
  });

  it("names a deleted saved base without opening another Review", async () => {
    const harness = await localApplyHarness();
    const { repositoryPath } = harness;
    git(repositoryPath, "branch", "topic");
    git(repositoryPath, "checkout", "-q", "-b", "feature");
    await writeFile(join(repositoryPath, "feature.txt"), "feature\n");
    git(repositoryPath, "add", "feature.txt");
    git(repositoryPath, "commit", "-q", "-m", "feature");
    const maintainer = await harness.open(
      shared(value(parseLocalBranchName("topic"))),
    );
    const storedBefore = await readdir(
      harness.paths.profileReviewsDirectory(profileId),
      { recursive: true },
    );
    const refsBefore = git(repositoryPath, "for-each-ref", "refs/patchdesk");
    git(repositoryPath, "branch", "-D", "topic");

    const refused = await agentOpen(harness);

    expect(refused).toEqual({
      _tag: "err",
      error: { reason: "revision_not_found", savedBaseBranch: "topic" },
    });
    expect(
      value(await harness.reviews.list(profileId)).reviews.map(({ id }) => id),
    ).toEqual([maintainer.review.id]);
    expect(
      await readdir(harness.paths.profileReviewsDirectory(profileId), {
        recursive: true,
      }),
    ).toEqual(storedBefore);
    expect(git(repositoryPath, "for-each-ref", "refs/patchdesk")).toBe(
      refsBefore,
    );
  });

  it("refuses base_required on a lone branch, creating nothing", async () => {
    const harness = await localApplyHarness();
    await writeFile(join(harness.repositoryPath, "untracked.txt"), "new\n");

    const opened = await agentOpen(harness);

    expect(opened).toEqual({ _tag: "err", error: { reason: "base_required" } });
    expect(value(await harness.reviews.list(profileId)).reviews).toEqual([]);
  });
});

describe("the checkout's shared Reviews an agent looks up (#558)", () => {
  const listFrom = async (harness: LocalApplyHarness, directory: string) =>
    value(
      await harness.opening.listSharedReviews(
        profileId,
        value(parseAbsolutePath(directory)),
      ),
    );

  /** A clock one second later on each read, so each open stamps a later `lastOpenedAt`. */
  const tickingClock = (): (() => IsoTimestamp) => {
    let seconds = 0;
    return () =>
      value(
        parseIsoTimestamp(
          new Date(Date.parse(now) + ++seconds * 1000).toISOString(),
        ),
      );
  };

  it("lists the configured checkout's Review from a subfolder, on its current session", async () => {
    const harness = await localApplyHarness();
    const { repositoryPath } = harness;
    git(repositoryPath, "checkout", "-q", "-b", "feature");
    await writeFile(join(repositoryPath, "feature.txt"), "feature\n");
    const opened = await harness.open(shared());
    const subfolder = join(repositoryPath, "src", "deep");
    await mkdir(subfolder, { recursive: true });

    const listed = await listFrom(harness, subfolder);

    expect(listed.head).toEqual({ kind: "branch", branch: "feature" });
    expect(listed.reviews).toHaveLength(1);
    expect(listed.reviews[0]).toMatchObject({
      reviewId: opened.review.id,
      sessionId: opened.session.id,
      headSha: opened.session.key.headSha,
      patchHash: opened.revision.patchHash,
      branch: "feature",
      baseBranch: "main",
      lastOpenedAt: now,
    });
  });

  it("lists a linked worktree's Review for that worktree and not for the configured checkout", async () => {
    const harness = await localApplyHarness();
    const { repositoryPath } = harness;
    const linked = join(dirname(repositoryPath), "linked");
    git(repositoryPath, "worktree", "add", "-q", linked, "-b", "feat");
    await writeFile(join(linked, "probe.txt"), "linked\n");
    const opened = await harness.open({
      ...shared(),
      checkout: value(parseAbsolutePath(linked)),
    });

    const fromConfigured = await listFrom(harness, repositoryPath);
    const fromLinked = await listFrom(harness, linked);

    expect(fromConfigured).toEqual({
      head: { kind: "branch", branch: "main" },
      reviews: [],
    });
    expect(fromLinked.head).toEqual({ kind: "branch", branch: "feat" });
    expect(fromLinked.reviews.map((review) => review.reviewId)).toEqual([
      opened.review.id,
    ]);
  });

  it("lists every branch's Reviews, the one the maintainer opened last first", async () => {
    const harness = await localApplyHarness(undefined, {
      openingNow: tickingClock(),
    });
    const { repositoryPath } = harness;
    const develop = value(parseLocalBranchName("develop"));
    git(repositoryPath, "branch", "-q", "develop");
    git(repositoryPath, "checkout", "-q", "-b", "feature");
    await writeFile(join(repositoryPath, "untracked.txt"), "new\n");
    const againstDevelop = await harness.open(shared(develop));
    const againstMain = await harness.open(shared());
    git(repositoryPath, "checkout", "-q", "-b", "later");
    const later = await harness.open(shared());
    git(repositoryPath, "checkout", "-q", "feature");
    await harness.open(shared(develop));

    const listed = await listFrom(harness, repositoryPath);

    expect(listed.head).toEqual({ kind: "branch", branch: "feature" });
    expect(
      listed.reviews.map(({ reviewId, branch, baseBranch }) => ({
        reviewId,
        branch,
        baseBranch,
      })),
    ).toEqual([
      {
        reviewId: againstDevelop.review.id,
        branch: "feature",
        baseBranch: "develop",
      },
      { reviewId: later.review.id, branch: "later", baseBranch: "main" },
      {
        reviewId: againstMain.review.id,
        branch: "feature",
        baseBranch: "main",
      },
    ]);
  });

  it("leaves out a terminal Review", async () => {
    const harness = await localApplyHarness();
    git(harness.repositoryPath, "checkout", "-q", "-b", "feature");
    const opened = await harness.open(shared());
    const reviewId = value(parseReviewId(opened.review.id));
    const stored = value(await harness.reviews.load(profileId, reviewId));
    value(
      await harness.reviews.save(
        markReviewTerminal(stored, "closed", now),
        stored.updatedAt,
      ),
    );

    const listed = await listFrom(harness, harness.repositoryPath);

    expect(listed.reviews).toEqual([]);
  });
});
