import { writeFile } from "node:fs/promises";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CommandRunner } from "../../src/adapters/github/command-runner";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { ReviewRemoteStore } from "../../src/adapters/storage/review-remote-store";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import { parseGitSha, parseReviewId } from "../../src/domain/ids";
import { err, ok } from "../../src/domain/result";
import { createReadOnlyGitExecutor } from "../../src/main/local-api-stores";
import { ReviewCommitService } from "../../src/services/review-commit-service";
import type { ReviewWorkbenchProjection } from "../../src/services/review-workbench-projection";
import {
  cleanupLocalApplyRoots,
  git,
  localApplyHarness,
  profileId,
  value,
  type LocalApplyHarness,
} from "./local-apply-fixture";
import { indexBytes, loadSession, shared } from "./local-review-shared-fixture";

afterEach(cleanupLocalApplyRoots);

async function commitFile(
  repositoryPath: string,
  file: string,
  content: string,
  message: string,
): Promise<void> {
  await writeFile(join(repositoryPath, file), content);
  git(repositoryPath, "add", file);
  git(repositoryPath, "commit", "-q", "-m", message);
}

/**
 * `feature` off `main` with "feature one", a merge of `helper` ("helper
 * one"), and "feature two"; `main` moved on past the fork; an uncommitted
 * edit on `feature`.
 */
async function featureMergingHelper(harness: LocalApplyHarness): Promise<void> {
  const { repositoryPath } = harness;
  git(repositoryPath, "checkout", "-q", "-b", "helper");
  await commitFile(repositoryPath, "helper.txt", "helper\n", "helper one");
  git(repositoryPath, "checkout", "-q", "main");
  git(repositoryPath, "checkout", "-q", "-b", "feature");
  await commitFile(repositoryPath, "feature.txt", "one\n", "feature one");
  git(repositoryPath, "merge", "-q", "--no-ff", "-m", "merge helper", "helper");
  await commitFile(repositoryPath, "feature.txt", "one\ntwo\n", "feature two");
  git(repositoryPath, "checkout", "-q", "main");
  await commitFile(repositoryPath, "main-only.txt", "main\n", "main moves on");
  git(repositoryPath, "checkout", "-q", "feature");
  await writeFile(join(repositoryPath, "tracked.txt"), "one\nedit\n");
}

/** The commit service over the harness stores, recording every git argv it runs. */
function commitService(harness: LocalApplyHarness) {
  const calls: string[][] = [];
  const realGit = createReadOnlyGitExecutor(new CommandRunner());
  const service = new ReviewCommitService(
    harness.reviews,
    new ReviewRemoteStore(harness.paths),
    new ReviewSessionStore(harness.paths),
    {
      run: (argv, environment) => {
        calls.push([...argv]);
        return realGit.run(argv, environment);
      },
    },
    new ProfileStore(harness.paths),
    PatchdeskPaths.forTest("/unused"),
  );
  return { service, calls };
}

function commitNamed(opened: ReviewWorkbenchProjection, message: string) {
  const commit = opened.commits.find((entry) => entry.message === message);
  if (commit === undefined) throw new Error(`No commit "${message}"`);
  return commit;
}

describe("a shared Review's commits (#557)", () => {
  it("lists every commit since the merge base, newest first, with the checkout HEAD flagged and the Local snapshot absent, reading only the session worktree", async () => {
    const listingCalls: string[][] = [];
    const harness = await localApplyHarness(undefined, {
      preparationGit: (argv, run) => {
        if (argv.some((arg) => arg.includes("..")))
          listingCalls.push([...argv]);
        return run();
      },
    });
    const { repositoryPath } = harness;
    await featureMergingHelper(harness);
    const checkoutHead = git(repositoryPath, "rev-parse", "HEAD").trim();

    const opened = await harness.open(shared());
    const session = await loadSession(harness, opened.session.id);

    expect(opened.commits.slice(0, 2).map((commit) => commit.message)).toEqual([
      "feature two",
      "merge helper",
    ]);
    expect(
      opened.commits
        .slice(2)
        .map((commit) => commit.message)
        .sort(),
    ).toEqual(["feature one", "helper one"]);
    expect(opened.commitTotal).toBe(4);
    expect(
      opened.commits.filter((commit) => commit.isHead).map((c) => c.sha),
    ).toEqual([checkoutHead]);
    expect(opened.commits.map((commit) => commit.sha)).not.toContain(
      opened.session.key.headSha,
    );
    expect(opened.commits[0]?.author).toBe("Fixture");
    expect(listingCalls.length).toBeGreaterThan(0);
    for (const argv of listingCalls)
      expect(argv.slice(0, 3)).toEqual(["git", "-C", session.worktree.path]);
  });

  it("shows a merge commit against its first parent in the session worktree without touching the checkout", async () => {
    const harness = await localApplyHarness();
    const { repositoryPath } = harness;
    await featureMergingHelper(harness);
    const opened = await harness.open(shared());
    const session = await loadSession(harness, opened.session.id);
    const merge = commitNamed(opened, "merge helper");
    const { service, calls } = commitService(harness);
    const statusBefore = git(repositoryPath, "status", "--porcelain");
    const indexBefore = await indexBytes(repositoryPath);

    const diffed = value(
      await service.diff({
        profileId,
        reviewId: value(parseReviewId(opened.review.id)),
        commitSha: merge.sha,
      }),
    );

    expect(diffed).toMatchObject({
      commit: { sha: merge.sha, isHead: false },
      position: 2,
      total: 4,
      fileCount: 1,
      additions: 1,
      deletions: 0,
    });
    expect(diffed.patch).toContain("+++ b/helper.txt");
    expect(diffed.patch).not.toContain("feature.txt");
    expect(calls.length).toBeGreaterThan(0);
    for (const argv of calls)
      expect(argv.slice(0, 3)).toEqual(["git", "-C", session.worktree.path]);
    expect(git(repositoryPath, "status", "--porcelain")).toBe(statusBefore);
    expect(await indexBytes(repositoryPath)).toEqual(indexBefore);
  });

  it("opens a listed empty commit as a zero-file slice without touching the checkout", async () => {
    const harness = await localApplyHarness();
    const { repositoryPath } = harness;
    git(repositoryPath, "checkout", "-q", "-b", "feature");
    await commitFile(repositoryPath, "feature.txt", "feature\n", "Add feature");
    git(repositoryPath, "commit", "--allow-empty", "-q", "-m", "Checkpoint");
    const opened = await harness.open(shared());
    const empty = commitNamed(opened, "Checkpoint");
    const session = await loadSession(harness, opened.session.id);
    const { service, calls } = commitService(harness);
    const statusBefore = git(repositoryPath, "status", "--porcelain");
    const indexBefore = await indexBytes(repositoryPath);

    const diffed = value(
      await service.diff({
        profileId,
        reviewId: value(parseReviewId(opened.review.id)),
        commitSha: empty.sha,
      }),
    );

    expect(diffed).toMatchObject({
      commit: { sha: empty.sha, isHead: true },
      position: 1,
      total: 2,
      patch: "",
      fileCount: 0,
      additions: 0,
      deletions: 0,
    });
    expect(calls.some((argv) => argv.includes("diff"))).toBe(true);
    for (const argv of calls)
      expect(argv.slice(0, 3)).toEqual(["git", "-C", session.worktree.path]);
    expect(git(repositoryPath, "status", "--porcelain")).toBe(statusBefore);
    expect(await indexBytes(repositoryPath)).toEqual(indexBefore);
  });

  it.each(["failure", "malformed"] as const)(
    "refuses a %s Git diff instead of showing an empty local commit",
    async (outcome) => {
      const harness = await localApplyHarness();
      const { repositoryPath } = harness;
      git(repositoryPath, "checkout", "-q", "-b", "feature");
      await commitFile(
        repositoryPath,
        "feature.txt",
        "feature\n",
        "Add feature",
      );
      const opened = await harness.open(shared());
      const commit = commitNamed(opened, "Add feature");
      const realGit = createReadOnlyGitExecutor(new CommandRunner());
      const service = new ReviewCommitService(
        harness.reviews,
        new ReviewRemoteStore(harness.paths),
        new ReviewSessionStore(harness.paths),
        {
          run: (argv, environment) =>
            argv.includes("diff")
              ? Promise.resolve(
                  outcome === "failure"
                    ? err({ _tag: "GitReadFailed" as const })
                    : ok({ stdout: "not a unified patch" }),
                )
              : realGit.run(argv, environment),
        },
        new ProfileStore(harness.paths),
        PatchdeskPaths.forTest("/unused"),
      );

      expect(
        await service.diff({
          profileId,
          reviewId: value(parseReviewId(opened.review.id)),
          commitSha: commit.sha,
        }),
      ).toEqual({ _tag: "err", error: { reason: "git_unavailable" } });
    },
  );

  it("lists the root of a merged unrelated history and shows it against the empty tree", async () => {
    const harness = await localApplyHarness();
    const { repositoryPath } = harness;
    git(repositoryPath, "checkout", "-q", "--orphan", "vendor");
    git(repositoryPath, "rm", "-q", "-r", "--cached", ".");
    await commitFile(repositoryPath, "vendor.txt", "a\nb\n", "vendor root");
    git(repositoryPath, "checkout", "-q", "-f", "main");
    git(repositoryPath, "checkout", "-q", "-b", "feature");
    git(
      repositoryPath,
      "merge",
      "-q",
      "--allow-unrelated-histories",
      "-m",
      "merge vendor",
      "vendor",
    );
    await writeFile(join(repositoryPath, "tracked.txt"), "one\nedit\n");
    const opened = await harness.open(shared());
    const root = commitNamed(opened, "vendor root");
    const { service } = commitService(harness);

    const diffed = value(
      await service.diff({
        profileId,
        reviewId: value(parseReviewId(opened.review.id)),
        commitSha: root.sha,
      }),
    );

    expect(opened.commits.map((commit) => commit.message)).toEqual([
      "merge vendor",
      "vendor root",
    ]);
    expect(diffed.patch).toContain("--- /dev/null");
    expect(diffed.patch).toContain("+a\n+b\n");
    expect(diffed).toMatchObject({ fileCount: 1, additions: 2, deletions: 0 });
  });

  it("refuses a commit of the base branch past the merge base without running a diff", async () => {
    const harness = await localApplyHarness();
    const { repositoryPath } = harness;
    await featureMergingHelper(harness);
    const opened = await harness.open(shared());
    const mainTip = value(
      parseGitSha(git(repositoryPath, "rev-parse", "main").trim()),
    );
    const { service, calls } = commitService(harness);

    const refused = await service.diff({
      profileId,
      reviewId: value(parseReviewId(opened.review.id)),
      commitSha: mainTip,
    });

    expect(refused).toEqual({
      _tag: "err",
      error: { reason: "foreign_commit" },
    });
    expect(calls).toEqual([]);
  });
});
