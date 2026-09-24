import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { RecentWriteJournalStore } from "../../src/adapters/storage/recent-write-journal-store";
import { ReviewObservationJournalStore } from "../../src/adapters/storage/review-observation-journal-store";
import { ReviewRemoteStore } from "../../src/adapters/storage/review-remote-store";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import { ReviewStore } from "../../src/adapters/storage/review-store";
import {
  parseAbsolutePath,
  parseGitHubLogin,
  parseGitHubReviewCommentId,
  parseGitHubReviewNodeId,
  parseGitHubReviewRestId,
  parseGitHubThreadId,
  parseIsoTimestamp,
  parseRepoRelativePath,
} from "../../src/domain/ids";
import type {
  PendingReviewRead,
  ViewerPendingReview,
} from "../../src/domain/pending-review";
import type { RecentReviewWrite } from "../../src/domain/recent-review-write";
import { createReview, moveReviewToSession } from "../../src/domain/review";
import { createReviewSession } from "../../src/domain/review-session";
import { ok } from "../../src/domain/result";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { ReviewObservationService } from "../../src/services/review-observation-service";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import {
  baseSha,
  fakeGitHub,
  headSha,
  identity,
  must,
  observedAt,
  patch,
  profileId,
  snapshot,
} from "./review-observation-fixture";

/**
 * A `PendingThread` receipt withholds the projection until the snapshot
 * carries its thread. These cases pin when GitHub's pending-review read may
 * settle it instead: only a confirmed read that the review holding the thread
 * is gone, never a failed read or read lag on the same review.
 */

const roots: string[] = [];
const at = must(parseIsoTimestamp("2026-08-12T00:00:00.000Z"));
/** The durable journal filters against the real clock's 24h ceiling. */
const justWrittenAt = () => must(parseIsoTimestamp(new Date().toISOString()));
const threadId = must(parseGitHubThreadId("PRRT_added"));
/** A receipt journaled before receipts named their pending review. */
const unnamedReceipt: RecentReviewWrite = { _tag: "PendingThread", threadId };
const receiptIn = (nodeId: string): RecentReviewWrite => ({
  _tag: "PendingThread",
  threadId,
  pendingReviewNodeId: must(parseGitHubReviewNodeId(nodeId)),
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function viewerReview(
  nodeId: string,
  threadIds: ReadonlyArray<string>,
): ViewerPendingReview {
  return {
    restId: must(parseGitHubReviewRestId(nodeId === "PRR_a" ? "1" : "2")),
    nodeId: must(parseGitHubReviewNodeId(nodeId)),
    author: must(parseGitHubLogin("fixture")),
    pr: {
      host: identity.host,
      owner: identity.owner,
      repo: identity.repo,
      number: identity.prNumber,
    },
    headSha,
    comments: threadIds.map((id, index) => ({
      reviewCommentId: must(parseGitHubReviewCommentId(`PRRC_${index + 1}`)),
      threadId: must(parseGitHubThreadId(id)),
      body: "Finding",
      anchor: {
        path: must(parseRepoRelativePath("a.ts")),
        startLine: 1,
        line: 1,
        side: "new" as const,
      },
      createdAt: at,
    })),
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * A Review whose session stored `stored` and whose receipt is both journaled
 * by main and sent by the renderer, as a confirmed AddThread does.
 */
async function observeAfterPendingRead({
  read,
  stored = viewerReview("PRR_a", [threadId]),
  receipt = unnamedReceipt,
}: {
  readonly read: PendingReviewRead;
  readonly stored?: ViewerPendingReview;
  readonly receipt?: RecentReviewWrite;
}) {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-pending-thread-"));
  roots.push(root);
  const paths = PatchdeskPaths.forTest(root);
  const profiles = new ProfileStore(paths);
  await profiles.save(
    must(
      parseWorkspaceProfileConfig({
        id: "acme",
        label: "ACME",
        githubHost: "github.com",
        ghAccount: "fixture",
        workspaceRoots: [],
        rulePaths: [],
        repos: [],
      }),
    ),
  );
  const sessions = new ReviewSessionStore(paths);
  const reviews = new ReviewStore(paths);
  const remote = new ReviewRemoteStore(paths);
  const created = createReviewSession({
    key: { ...identity, headSha, baseSha },
    pr: { headSha, baseSha, isDraft: false, isOpen: true },
    patchPath: must(
      // SAFETY: a stable path segment for the temp directory, never a real id.
      parseAbsolutePath(paths.patchFile(profileId, "session" as never)),
    ),
    worktree: {
      path: must(
        parseAbsolutePath(
          // SAFETY: as above.
          paths.worktreeDirectory(profileId, "session" as never),
        ),
      ),
      headSha,
    },
    createdAt: at,
  });
  const session = {
    ...created,
    pendingReview: {
      _tag: "Pending" as const,
      review: stored,
    },
  };
  await mkdir(join(session.patchPath, ".."), { recursive: true });
  await writeFile(session.patchPath, patch, "utf8");
  await sessions.save(session);
  const reviewShell = createReview({
    identity,
    currentSessionId: session.id,
    headSha,
    createdAt: at,
  });
  const old = await remote.saveCandidate({
    profileId,
    reviewId: reviewShell.id,
    snapshot: snapshot({ title: "old" }),
  });
  if (old._tag === "err") throw new Error("fixture");
  const review = must(
    moveReviewToSession(reviewShell, {
      sessionId: session.id,
      headSha,
      representedRemote: {
        headSha,
        snapshotHash: old.value.snapshotHash,
        pullRequestUpdatedAt: at,
        refreshedAt: at,
      },
      updatedAt: at,
    }),
  );
  await reviews.save(review);
  const recentWrites = new RecentWriteJournalStore(paths, {
    write: () => undefined,
  });
  await recentWrites.append(profileId, review.id, receipt, justWrittenAt());
  const observation = new ReviewObservationService({
    profiles,
    reviews,
    sessions,
    remote,
    journals: new ReviewObservationJournalStore(paths),
    recentWrites,
    github: {
      ...fakeGitHub({ terminal: false }),
      async getViewerPendingReview() {
        return ok(read);
      },
    },
    pendingReview: {
      adoptObservedState: (input) => ({
        pendingReview:
          input.observed._tag === "Pending"
            ? { _tag: "Pending", review: input.observed.review }
            : (input.session.pendingReview ?? { _tag: "None" }),
      }),
    },
    coordinator: new ReviewOperationCoordinator(),
    now: () => observedAt,
    // SAFETY: the projection body is opaque to the service; only its presence is asserted.
    project: async () => ok({ state: "review" } as never),
  });
  const observed = await observation.observe({
    profileId,
    reviewId: review.id,
    recentWrites: [receipt],
  });
  const journal = await recentWrites.load(profileId, review.id);
  return {
    projected:
      observed._tag === "ok" &&
      observed.value._tag === "Reconciled" &&
      observed.value.projection !== undefined,
    journal: journal._tag === "ok" ? journal.value : undefined,
  };
}

describe("ReviewObservationService pending-thread receipts", () => {
  it.each([
    { name: "GitHub reports no pending review", read: { _tag: "None" } },
    {
      name: "GitHub holds a different pending review without the thread",
      read: { _tag: "Pending", review: viewerReview("PRR_b", []) },
    },
  ] as const)("settles the receipt when $name", async ({ read }) => {
    const result = await observeAfterPendingRead({ read });

    expect(result.projected).toBe(true);
    expect(result.journal).toEqual([]);
  });

  it.each([
    {
      name: "the pending-review read is unavailable",
      read: { _tag: "Unavailable" },
    },
    {
      name: "the same pending review is read without the thread",
      read: { _tag: "Pending", review: viewerReview("PRR_a", []) },
    },
  ] as const)("keeps withholding when $name", async ({ read }) => {
    const result = await observeAfterPendingRead({ read });

    expect(result.projected).toBe(false);
    expect(result.journal).toEqual([unnamedReceipt]);
  });

  it("settles a receipt from a deleted pending review once a new one is stored and read without its thread", async () => {
    const result = await observeAfterPendingRead({
      read: { _tag: "Pending", review: viewerReview("PRR_b", []) },
      stored: viewerReview("PRR_b", []),
      receipt: receiptIn("PRR_a"),
    });

    expect(result.projected).toBe(true);
    expect(result.journal).toEqual([]);
  });

  it("keeps withholding when the pending review the receipt names is read without the thread", async () => {
    const result = await observeAfterPendingRead({
      read: { _tag: "Pending", review: viewerReview("PRR_b", []) },
      stored: viewerReview("PRR_a", []),
      receipt: receiptIn("PRR_b"),
    });

    expect(result.projected).toBe(false);
    expect(result.journal).toEqual([receiptIn("PRR_b")]);
  });
});
