import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FakeGitHubAdapter } from "../../src/adapters/github/fake-github-adapter";
import type { GitHubReadFailure } from "../../src/adapters/github/github-adapter";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import { projectAnalysisReviewActions } from "../../src/domain/analysis-review-actions";
import type { GitHubComments } from "../../src/domain/github-context";
import {
  createPendingReviewRequestId,
  parseContentHash,
  parseFindingId,
  parseGitHubLogin,
  parseGitHubReviewCommentId,
  parseGitHubReviewNodeId,
  parseGitHubReviewRestId,
  parseGitHubThreadId,
  parseInsightRunId,
  parseIsoTimestamp,
  parseRepoRelativePath,
} from "../../src/domain/ids";
import type { LogEntryInput } from "../../src/domain/log-entry";
import type {
  FindingReviewReceipt,
  PendingReviewRead,
  PendingReviewState,
  ViewerPendingReview,
} from "../../src/domain/pending-review";
import { ok, type Result } from "../../src/domain/result";
import type { ReviewSession } from "../../src/domain/review-session";
import {
  PendingReviewService,
  projectPendingReview,
} from "../../src/services/pending-review-service";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import {
  createReviewRefreshFixture,
  createReviewRefreshFixtureValues,
} from "./review-refresh-fixture";
import { settle } from "./review-invariant-fixtures";
import { confirmedWriteJournal } from "./write-invariant-harness";

const must = <T>(result: Result<T, unknown>): T => {
  if (result._tag === "ok") return result.value;
  throw new Error("Invalid test fixture");
};

const values = createReviewRefreshFixtureValues();
const { profileId, profile, review, headSha } = values;
const now = must(parseIsoTimestamp("2026-08-01T00:10:00.000Z"));
const viewer = must(parseGitHubLogin("fixture"));
const patchHash = must(parseContentHash("a".repeat(64)));
const analysisRunId = must(
  parseInsightRunId("insight-analysis-1-aaaaaaaaaaaa-fixture"),
);
const findingId = must(parseFindingId("finding-1"));
const threadId = must(parseGitHubThreadId("PRRT_kwDORJzsQM0001"));
const recordedNodeId = must(parseGitHubReviewNodeId("PRR_kwDORJzsQM7e6QwJ"));
const otherNodeId = must(parseGitHubReviewNodeId("PRR_kwDORJzsQM7e6QwK"));

function viewerPendingReview(
  nodeId: ViewerPendingReview["nodeId"],
): ViewerPendingReview {
  return {
    restId: must(parseGitHubReviewRestId("9001")),
    nodeId,
    author: viewer,
    pr: {
      host: values.identity.host,
      owner: values.identity.owner,
      repo: values.identity.repo,
      number: values.identity.prNumber,
    },
    headSha,
    comments: [
      {
        reviewCommentId: must(parseGitHubReviewCommentId("PRRC_kwDORJzsQM01")),
        threadId,
        body: "Finding body",
        anchor: {
          path: must(parseRepoRelativePath("src/a.ts")),
          startLine: 1,
          line: 1,
          side: "new",
        },
        createdAt: values.at,
      },
    ],
    createdAt: values.at,
    updatedAt: values.at,
  };
}

const addedReceipt: FindingReviewReceipt = {
  analysisRunId,
  findingId,
  sessionId: values.session.id,
  headSha,
  patchHash,
  threadId,
  pendingReviewNodeId: recordedNodeId,
  state: "pending",
};

/** The Review after Add: a Finding receipt owned by the recorded pending review. */
const addedSession: ReviewSession = {
  ...values.session,
  pendingReview: {
    _tag: "Pending",
    review: viewerPendingReview(recordedNodeId),
  },
  findingReviewReceipts: [addedReceipt],
};

const noThreads: GitHubComments = { threads: [], complete: true };

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function pendingReviewFixture(
  viewerRead:
    | { readonly read: PendingReviewRead }
    | { readonly failure: GitHubReadFailure },
  coordinator = new ReviewOperationCoordinator(),
  initial: ReviewSession = addedSession,
) {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-receipt-release-"));
  roots.push(root);
  const sessions = new ReviewSessionStore(PatchdeskPaths.forTest(root));
  must(await sessions.save(initial));
  const github = new FakeGitHubAdapter({
    authenticatedAccount: { host: "github.com", account: "fixture" },
    viewerPendingReview:
      "read" in viewerRead
        ? { account: viewer, read: viewerRead.read }
        : viewerRead,
    pullRequest: values.snapshot.pullRequest,
    comments: noThreads,
    pendingReviewSubmission: { reviewId: "9002" },
  });
  const logs: LogEntryInput[] = [];
  const current = async () => ({
    profile,
    review,
    session: must(await sessions.load(profileId, initial.id)),
  });
  const service = new PendingReviewService(
    {
      // SAFETY: Finish reads only the profile and session of a fresh Review.
      requireFresh: async () => ok((await current()) as never),
      requireCurrentSession: async () => ok(await current()),
    },
    sessions,
    github,
    () => now,
    coordinator,
    confirmedWriteJournal(),
    undefined,
    { write: (entry) => logs.push(entry) },
  );
  const stored = async (): Promise<ReviewSession> =>
    must(await sessions.load(profileId, initial.id));
  return { service, stored, logs, github };
}

/** What the workbench shows for the Finding and the Analysis Finish review action. */
function workbench(session: ReviewSession, state: PendingReviewState) {
  const actions = projectAnalysisReviewActions({
    // SAFETY: only the fields the projection reads are supplied; the full
    // Insight projection shape is outside this seam.
    analysis: {
      status: "current",
      artifactStatus: "verified",
      retained: {
        runId: analysisRunId,
        sessionId: session.id,
        headSha,
        value: { findings: [{ id: findingId }] },
      },
    } as never,
    session,
    freshness: "fresh",
    patchHash,
    pendingReview: state,
    threads: [],
  });
  return {
    finding: actions.findings[findingId],
    analysisFinishReview: actions.canFinishWithAnalysisSummary,
    header: projectPendingReview(state, false).state,
  };
}

describe("Refresh releases Finding receipts of a pending review deleted on GitHub", () => {
  it.each([
    {
      name: "no pending review",
      read: { _tag: "None" } as const,
      header: "none",
    },
    {
      // The header then offers Finish review for the other review, which exists.
      name: "a pending review with a different id",
      read: {
        _tag: "Pending",
        review: viewerPendingReview(otherNodeId),
      } as const,
      header: "pending",
    },
  ])(
    "returns the Finding to actionable when GitHub reports $name",
    async ({ read, header }) => {
      const { service, stored, logs } = await pendingReviewFixture({ read });

      const result = must(
        await service.reconcileWithinReviewLock({
          profileId,
          reviewId: review.id,
          evidence: { comments: noThreads },
        }),
      );

      const session = await stored();
      expect(session.findingReviewReceipts).toBeUndefined();
      expect(workbench(session, result.state)).toEqual({
        finding: { state: "actionable" },
        analysisFinishReview: false,
        header,
      });
      expect(logs).toMatchObject([
        {
          topic: "pending-review",
          meta: { pendingReviewNodeIds: [recordedNodeId], cleared: 1 },
        },
      ]);
    },
  );

  it.each([
    {
      name: "a network or 5xx failure",
      viewerRead: {
        failure: {
          _tag: "GitHubReadFailed",
          operation: "get_pending_review",
        },
      } as const,
    },
    {
      name: "a rate limit",
      viewerRead: {
        failure: {
          _tag: "GitHubRateLimited",
          operation: "get_pending_review",
        },
      } as const,
    },
    {
      name: "an unparseable body",
      viewerRead: {
        failure: {
          _tag: "GitHubResponseInvalid",
          operation: "get_pending_review",
        },
      } as const,
    },
    {
      name: "an incomplete read",
      viewerRead: { read: { _tag: "Unavailable" } } as const,
    },
  ])("keeps the Finding Added after $name", async ({ viewerRead }) => {
    const { service, stored, logs } = await pendingReviewFixture(viewerRead);

    const result = must(
      await service.reconcileWithinReviewLock({
        profileId,
        reviewId: review.id,
        evidence: { comments: noThreads },
      }),
    );

    expect(result.unavailable).toBe(true);
    const session = await stored();
    expect(session.findingReviewReceipts).toEqual([addedReceipt]);
    expect(
      workbench(session, session.pendingReview ?? { _tag: "None" }),
    ).toEqual({
      finding: { state: "pending_review" },
      analysisFinishReview: true,
      header: "pending",
    });
    expect(logs).toEqual([]);
  });

  it("keeps the Finding Added while its pending review still exists", async () => {
    const { service, stored } = await pendingReviewFixture({
      read: { _tag: "Pending", review: viewerPendingReview(recordedNodeId) },
    });

    const result = must(
      await service.reconcileWithinReviewLock({
        profileId,
        reviewId: review.id,
        evidence: { comments: noThreads },
      }),
    );

    const session = await stored();
    expect(session.findingReviewReceipts).toEqual([addedReceipt]);
    expect(workbench(session, result.state)).toEqual({
      finding: { state: "pending_review" },
      analysisFinishReview: true,
      header: "pending",
    });
  });

  it("keeps the Finding non-actionable when the review was submitted on GitHub", async () => {
    const { service, stored } = await pendingReviewFixture({
      read: { _tag: "None" },
    });

    await service.reconcileWithinReviewLock({
      profileId,
      reviewId: review.id,
      evidence: {
        comments: {
          threads: [{ id: threadId, state: "open", comments: [] }],
          complete: true,
        },
      },
    });

    expect((await stored()).findingReviewReceipts).toMatchObject([
      { findingId, state: "historical" },
    ]);
  });

  it("keeps the Finding Added when the thread evidence is incomplete", async () => {
    const { service, stored } = await pendingReviewFixture({
      read: { _tag: "None" },
    });

    await service.reconcileWithinReviewLock({
      profileId,
      reviewId: review.id,
      evidence: { comments: { threads: [], complete: false } },
    });

    expect((await stored()).findingReviewReceipts).toEqual([addedReceipt]);
  });

  it("releases receipts on Refresh only after the Review lock is free", async () => {
    const coordinator = new ReviewOperationCoordinator();
    const { service, stored } = await pendingReviewFixture(
      { read: { _tag: "None" } },
      coordinator,
    );
    const refresh = createReviewRefreshFixture({
      session: addedSession,
      pendingReview: service,
      operationCoordinator: coordinator,
      projectionOutcome: "success",
    });
    // An Add in flight holds the lock the same way every review write does.
    const key = `${profileId}:${review.id}`;
    expect(coordinator.acquire(key)).toBe(true);

    const refreshed = refresh.service.refresh({
      profileId,
      reviewId: review.id,
    });
    await settle();
    expect((await stored()).findingReviewReceipts).toEqual([addedReceipt]);

    coordinator.release(key);
    await expect(refreshed).resolves.toMatchObject({ _tag: "ok" });
    expect((await stored()).findingReviewReceipts).toBeUndefined();
  });
});

describe("Refresh leaves receipts alone while a write is unsettled", () => {
  it.each(["WriteInFlight", "OutcomeUnknown"] as const)(
    "keeps the Finding Added while the stored state is %s",
    async (tag) => {
      const unsettled: ReviewSession = {
        ...addedSession,
        pendingReview: {
          _tag: tag,
          review: viewerPendingReview(recordedNodeId),
          operation: {
            _tag: "AddThread",
            requestId: createPendingReviewRequestId(now),
            reviewId: recordedNodeId,
            body: "Another comment",
            anchor: {
              path: must(parseRepoRelativePath("src/b.ts")),
              startLine: 2,
              line: 2,
              side: "new",
            },
          },
          startedAt: now,
        },
      };
      const { service, stored, logs } = await pendingReviewFixture(
        { read: { _tag: "None" } },
        new ReviewOperationCoordinator(),
        unsettled,
      );

      await service.reconcileWithinReviewLock({
        profileId,
        reviewId: review.id,
        evidence: { comments: noThreads },
      });

      expect((await stored()).findingReviewReceipts).toEqual([addedReceipt]);
      expect(logs).toEqual([]);
    },
  );
});

describe("Finish review on a pending review deleted on GitHub (#419)", () => {
  const finish = (service: PendingReviewService) =>
    service.submit({
      profileId,
      reviewId: review.id,
      expected: { sessionId: addedSession.id, headSha, patchHash },
      event: "COMMENT",
      summaryBody: "",
    });

  it("sends no write and releases the Finding when GitHub has no pending review", async () => {
    const { service, stored, logs, github } = await pendingReviewFixture({
      read: { _tag: "None" },
    });

    const result = await finish(service);

    expect(result).toEqual({ _tag: "err", error: "pending_review_gone" });
    expect(github.calls.submitPendingReview).toEqual([]);
    const session = await stored();
    expect(session.pendingReview).toEqual({ _tag: "None" });
    expect(workbench(session, { _tag: "None" })).toEqual({
      finding: { state: "actionable" },
      analysisFinishReview: false,
      header: "none",
    });
    expect(logs).toMatchObject([
      { meta: { pendingReviewNodeIds: [recordedNodeId], cleared: 1 } },
    ]);
  });

  it.each([
    {
      name: "the pending-review read fails",
      viewerRead: {
        failure: { _tag: "GitHubReadFailed", operation: "get_pending_review" },
      } as const,
    },
    {
      name: "the pending review still exists",
      viewerRead: {
        read: { _tag: "Pending", review: viewerPendingReview(recordedNodeId) },
      } as const,
    },
  ])("submits as before when $name", async ({ viewerRead }) => {
    const { service, stored, github } = await pendingReviewFixture(viewerRead);

    const result = await finish(service);

    expect(result).toMatchObject({ _tag: "ok" });
    expect(github.calls.submitPendingReview).toMatchObject([
      { reviewId: "9001", event: "COMMENT" },
    ]);
    expect((await stored()).pendingReview).toEqual({ _tag: "None" });
  });
});
