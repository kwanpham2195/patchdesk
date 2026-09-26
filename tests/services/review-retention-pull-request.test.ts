import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CommandRunner } from "../../src/adapters/github/command-runner";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { RefreshOperationStore } from "../../src/adapters/storage/refresh-operation-store";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import { ReviewWriteOperationStore } from "../../src/adapters/storage/review-write-operation-store";
import {
  createReviewSessionId,
  parseAbsolutePath,
  parseContentHash,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parsePendingReviewRequestId,
  parsePullRequestNumber,
} from "../../src/domain/ids";
import { definedProps } from "../../src/domain/defined-props";
import { ok } from "../../src/domain/result";
import {
  createReview,
  markReviewTerminal,
  type PullRequestReview,
  type PullRequestReviewIdentity,
} from "../../src/domain/review";
import {
  createReviewSession,
  type PullRequestReviewSession,
} from "../../src/domain/review-session";
import { createReadOnlyGitExecutor } from "../../src/main/local-api-stores";
import { ReviewWorktreeService } from "../../src/services/review-worktree-service";
import {
  beginRun,
  cleanupLocalApplyRoots,
  git,
  localApplyHarness,
  now,
  profileId,
  retainAnalysis,
  value,
  type InsightRunTarget,
  type LocalApplyHarness,
} from "./local-apply-fixture";

afterEach(cleanupLocalApplyRoots);

const identity = {
  profileId,
  host: value(parseGitHubHost("github.com")),
  owner: value(parseGitHubOwner("octo-org")),
  repo: value(parseGitHubRepoName("patchdesk")),
  source: {
    kind: "pull_request",
    prNumber: value(parsePullRequestNumber(42)),
  },
} satisfies PullRequestReviewIdentity;

const patchHash = value(parseContentHash("a".repeat(64)));

type PushedPullRequest = {
  readonly review: PullRequestReview;
  /** Oldest first; the last is the Review's current session. */
  readonly sessions: ReadonlyArray<PullRequestReviewSession>;
  readonly sessionStore: ReviewSessionStore;
};

/**
 * An Open pull request Review of the harness repository, opened and then
 * pushed to `pushes` times. Each session is prepared as an open prepares it:
 * `origin` is the repository itself, so the managed fetch, its refs, and the
 * worktree all run through real Git. Without `checkout`, the profile names no
 * local path and every session is metadata-only, with no worktree.
 */
async function pushedPullRequest(
  harness: LocalApplyHarness,
  pushes: number,
  checkout = true,
): Promise<PushedPullRequest> {
  const repositoryPath = harness.repositoryPath;
  git(repositoryPath, "remote", "add", "origin", repositoryPath);
  const profiles = new ProfileStore(harness.paths);
  if (!checkout) {
    const configured = value(await profiles.load(profileId));
    value(
      await profiles.save({
        ...configured,
        repos: configured.repos.map(
          ({ localPath: _localPath, ...repository }) => repository,
        ),
      }),
    );
  }
  const worktrees = new ReviewWorktreeService(
    harness.paths,
    createReadOnlyGitExecutor(new CommandRunner()),
    { environmentFor: async () => ok({}) },
    // Git never calls the credential helper for a local origin.
    async () => "/usr/bin/false",
  );
  const sessionStore = new ReviewSessionStore(harness.paths);
  const profile = value(await profiles.load(profileId));
  const baseSha = value(
    parseGitSha(git(repositoryPath, "rev-parse", "HEAD").trim()),
  );
  const sessions: PullRequestReviewSession[] = [];
  for (let push = 0; push <= pushes; push += 1) {
    await writeFile(join(repositoryPath, "pushed.txt"), `push ${push}\n`);
    git(repositoryPath, "add", "pushed.txt");
    git(repositoryPath, "commit", "-q", "-m", `push ${String(push)}`);
    const headSha = value(
      parseGitSha(git(repositoryPath, "rev-parse", "HEAD").trim()),
    );
    const key = { ...identity, headSha, baseSha };
    const sessionId = createReviewSessionId(key);
    const worktree = value(
      await worktrees.prepare({
        profileId,
        profile,
        host: identity.host,
        owner: identity.owner,
        repo: identity.repo,
        number: identity.source.prNumber,
        baseSha,
        sha: headSha,
        sessionId,
        ...definedProps({ localPath: checkout ? repositoryPath : undefined }),
      }),
    );
    if ((worktree.mode === "worktree") !== checkout)
      throw new Error("fixture worktree");
    const worktreePath =
      worktree.mode === "worktree"
        ? worktree.path
        : harness.paths.worktreeDirectory(profileId, sessionId);
    const session = createReviewSession({
      key,
      pr: { headSha, baseSha, isDraft: false, isOpen: true },
      patchPath: value(
        parseAbsolutePath(harness.paths.patchFile(profileId, sessionId)),
      ),
      canonicalPatchHash: patchHash,
      worktree: { path: value(parseAbsolutePath(worktreePath)), headSha },
      createdAt: now,
    });
    value(await sessionStore.save(session));
    await writeFile(harness.paths.patchFile(profileId, sessionId), "diff\n");
    sessions.push(session);
  }
  const current = sessions.at(-1);
  if (current === undefined) throw new Error("fixture sessions");
  const review = createReview({
    identity,
    currentSessionId: current.id,
    headSha: current.key.headSha,
    createdAt: now,
  });
  value(await harness.reviews.save(review));
  return { review, sessions, sessionStore };
}

/** The parts of a stored session an Insight run is bound to. */
function insightTarget(
  review: PullRequestReview,
  session: PullRequestReviewSession,
): InsightRunTarget {
  return { review, session, revision: { patchHash } };
}

function pullRequestRefs(repositoryPath: string): ReadonlyArray<string> {
  const listed = git(
    repositoryPath,
    "for-each-ref",
    "--format=%(refname)",
    "refs/patchdesk/reviews/",
  ).trim();
  return listed === "" ? [] : listed.split("\n");
}

/** The worktrees Git lists besides the maintainer's own checkout. */
function sessionWorktrees(repositoryPath: string): ReadonlyArray<string> {
  return git(repositoryPath, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .slice(1);
}

function present(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

describe("ReviewRetention of pull request Reviews", () => {
  it("leaves only the current session after two pushes and keeps the patch a retained Insight reads", async () => {
    const harness = await localApplyHarness();
    const pushed = await pushedPullRequest(harness, 2);
    const [opened, firstPush, current] = pushed.sessions;
    if (
      opened === undefined ||
      firstPush === undefined ||
      current === undefined
    )
      throw new Error("fixture sessions");
    await retainAnalysis(
      harness.insights,
      insightTarget(pushed.review, opened),
      [],
    );

    value(await harness.retention.sweepProfile(profileId));

    const stored = value(await pushed.sessionStore.listSessions(profileId));
    expect(stored.map((session) => session.id).sort()).toEqual(
      [opened.id, current.id].sort(),
    );
    expect(await present(harness.paths.patchFile(profileId, opened.id))).toBe(
      true,
    );
    expect(
      await present(harness.paths.worktreeDirectory(profileId, opened.id)),
    ).toBe(false);
    expect(
      await present(harness.paths.patchFile(profileId, firstPush.id)),
    ).toBe(false);
    expect(pullRequestRefs(harness.repositoryPath)).toEqual([
      `refs/patchdesk/reviews/${profileId}/${current.id}/base`,
      `refs/patchdesk/reviews/${profileId}/${current.id}/head`,
    ]);
    expect(sessionWorktrees(harness.repositoryPath)).toEqual([
      expect.stringContaining(current.id),
    ]);
  });

  it("removes the superseded metadata-only sessions of a Review whose profile names no checkout", async () => {
    const harness = await localApplyHarness();
    const pushed = await pushedPullRequest(harness, 1, false);
    const [opened, current] = pushed.sessions;
    if (opened === undefined || current === undefined)
      throw new Error("fixture sessions");

    value(await harness.retention.sweepProfile(profileId));

    expect(await present(harness.paths.patchFile(profileId, opened.id))).toBe(
      false,
    );
    expect(await present(harness.paths.patchFile(profileId, current.id))).toBe(
      true,
    );
  });

  it("keeps the current session of a Review that became Terminal after a push", async () => {
    const harness = await localApplyHarness();
    const pushed = await pushedPullRequest(harness, 1);
    const current = pushed.sessions.at(-1);
    if (current === undefined) throw new Error("fixture sessions");
    // As a Refresh after a push leaves it when the pull request was merged meanwhile.
    value(
      await harness.reviews.save(
        markReviewTerminal(pushed.review, "merged", now),
        pushed.review.updatedAt,
      ),
    );

    value(await harness.retention.pruneSuperseded(profileId, pushed.review.id));

    expect(await present(harness.paths.patchFile(profileId, current.id))).toBe(
      true,
    );
    expect(
      await present(harness.paths.worktreeDirectory(profileId, current.id)),
    ).toBe(true);
  });

  it("keeps the superseded session a Prepared Refresh names", async () => {
    const harness = await localApplyHarness();
    const pushed = await pushedPullRequest(harness, 1);
    const [opened] = pushed.sessions;
    if (opened === undefined) throw new Error("fixture sessions");
    value(
      await new RefreshOperationStore(harness.paths).save({
        operationId: "refresh-fixture",
        profileId,
        reviewId: pushed.review.id,
        expectedUpdatedAt: pushed.review.updatedAt,
        startedAt: now,
        state: {
          _tag: "Prepared",
          nextReview: { ...pushed.review, currentSessionId: opened.id },
          sessionId: opened.id,
          snapshotHash: patchHash,
        },
      }),
    );

    value(await harness.retention.sweepProfile(profileId));

    expect(await present(harness.paths.patchFile(profileId, opened.id))).toBe(
      true,
    );
    expect(
      await present(harness.paths.worktreeDirectory(profileId, opened.id)),
    ).toBe(true);
  });

  it("keeps a superseded session while its Analysis run is active", async () => {
    const harness = await localApplyHarness();
    const pushed = await pushedPullRequest(harness, 1);
    const [opened] = pushed.sessions;
    if (opened === undefined) throw new Error("fixture sessions");
    await beginRun(
      harness.insights,
      insightTarget(pushed.review, opened),
      "analysis",
    );

    value(await harness.retention.sweepProfile(profileId));

    expect(await present(harness.paths.patchFile(profileId, opened.id))).toBe(
      true,
    );
    expect(
      await present(harness.paths.worktreeDirectory(profileId, opened.id)),
    ).toBe(true);
    expect(pullRequestRefs(harness.repositoryPath)).toHaveLength(4);
  });

  it.each([
    [
      "an outcome-unknown GitHub write operation",
      async (harness: LocalApplyHarness, pushed: PushedPullRequest) => {
        value(
          await new ReviewWriteOperationStore(harness.paths).begin({
            schemaVersion: 1,
            profileId,
            reviewId: pushed.review.id,
            sessionId: pushed.review.currentSessionId,
            intent: { _tag: "SetDraftState", draft: true },
            state: { _tag: "OutcomeUnknown", resolution: "check_required" },
            startedAt: now,
          }),
        );
      },
    ],
    [
      "an outcome-unknown pending-review write on its current session",
      async (_harness: LocalApplyHarness, pushed: PushedPullRequest) => {
        const current = pushed.sessions.at(-1);
        if (current === undefined) throw new Error("fixture sessions");
        value(
          await pushed.sessionStore.save({
            ...current,
            pendingReview: {
              _tag: "OutcomeUnknown",
              operation: {
                _tag: "Start",
                requestId: value(
                  parsePendingReviewRequestId("pending-review-fixture"),
                ),
              },
              startedAt: now,
            },
          }),
        );
      },
    ],
  ] as const)(
    "keeps every session of a Review with %s",
    async (_label, arrange) => {
      const harness = await localApplyHarness();
      const pushed = await pushedPullRequest(harness, 1);
      await arrange(harness, pushed);

      value(await harness.retention.sweepProfile(profileId));

      for (const session of pushed.sessions) {
        expect(
          await present(harness.paths.patchFile(profileId, session.id)),
        ).toBe(true);
        expect(
          await present(harness.paths.worktreeDirectory(profileId, session.id)),
        ).toBe(true);
      }
      expect(pullRequestRefs(harness.repositoryPath)).toHaveLength(4);
    },
  );
});
