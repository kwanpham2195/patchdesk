import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
import {
  isPullRequestReviewSession,
  type LocalReviewSession,
} from "../../src/domain/review-session";
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

async function loadSession(
  harness: LocalApplyHarness,
  sessionId: string,
): Promise<LocalReviewSession> {
  const session = value(
    await new ReviewSessionStore(harness.paths).load(
      profileId,
      value(parseReviewSessionId(sessionId)),
    ),
  );
  if (isPullRequestReviewSession(session))
    throw new Error("Expected a local session");
  return session;
}

/** Each stored view patch's text and touched paths, read as a view switch would: from the session's files. */
async function readViewPatches(session: LocalReviewSession) {
  const views = session.viewPatches;
  if (views === undefined) throw new Error("Expected view patches");
  const read = async (view: keyof typeof views) => ({
    text: await readFile(views[view].patchPath, "utf8"),
    paths: views[view].paths,
  });
  return {
    combined: await read("combined"),
    committed: await read("committed"),
    uncommitted: await read("uncommitted"),
  };
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

  it("refuses base_required on a lone branch, creating nothing", async () => {
    const harness = await localApplyHarness();
    await writeFile(join(harness.repositoryPath, "untracked.txt"), "new\n");

    const opened = await agentOpen(harness);

    expect(opened).toEqual({ _tag: "err", error: { reason: "base_required" } });
    expect(value(await harness.reviews.list(profileId)).reviews).toEqual([]);
  });
});
