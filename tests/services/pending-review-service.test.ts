import { describe, expect, it, vi } from "vitest";

import type { StorageFailure } from "../../src/adapters/storage/json-file";
import { err, ok, type Result } from "../../src/domain/result";
import type { ViewerPendingReview } from "../../src/domain/pending-review";
import type { ReviewSession } from "../../src/domain/review-session";
import {
  PendingReviewService,
  projectPendingReview,
} from "../../src/services/pending-review-service";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";

const profileId = "cfw" as never;
const reviewId =
  "github.com__centraldigital__patchdesk__pr-42__review-aaaaaaaaaaaa" as never;
const headSha = "a".repeat(40) as never;
const sessionId =
  "github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__b48f8e2e76ca" as never;
const now = "2026-08-09T11:35:00.000Z" as never;
const expected = { sessionId, headSha, patchHash: "b".repeat(64) as never };
const anchor = {
  path: "src/a.ts" as never,
  startLine: 1,
  line: 1,
  side: "new" as const,
};
const finding = {
  analysisRunId: "insight-analysis-1-aaaaaaaaaaaa-fixture" as never,
  findingId: "finding-1" as never,
  sessionId,
  headSha,
  patchHash: "b".repeat(64) as never,
};
const threadId = "PRRT_kwDORJzsQM0001" as never;

function pending(): ViewerPendingReview {
  return {
    restId: "9001" as never,
    nodeId: "PRR_kwDORJzsQM7e6QwJ" as never,
    author: "fixture" as never,
    pr: {
      host: "github.com" as never,
      owner: "centraldigital" as never,
      repo: "patchdesk" as never,
      number: 42 as never,
    },
    headSha,
    comments: [
      {
        reviewCommentId: "PRRC_kwDORJzsQM7fI2Rd" as never,
        threadId,
        body: "body",
        anchor,
        createdAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}
function session(
  state?: unknown,
  findingReviewReceipts?: ReviewSession["findingReviewReceipts"],
): ReviewSession {
  return {
    schemaVersion: 5,
    id: sessionId,
    key: {
      profileId,
      host: "github.com",
      owner: "centraldigital",
      repo: "patchdesk",
      prNumber: 42,
      headSha,
    },
    pr: { headSha, isDraft: false, isOpen: true },
    patchPath: "/tmp/patch" as never,
    worktree: { path: "/tmp/worktree" as never, headSha },
    createdAt: now,
    updatedAt: now,
    ...(state === undefined ? {} : { pendingReview: state }),
    ...(findingReviewReceipts === undefined ? {} : { findingReviewReceipts }),
  } as unknown as ReviewSession;
}
function fixture(
  state?: unknown,
  overrides: Record<string, unknown> = {},
  findingReviewReceipts?: ReviewSession["findingReviewReceipts"],
) {
  let stored = session(state, findingReviewReceipts);
  const saves: unknown[] = [];
  const store = {
    load: vi.fn(async () => ok(stored)),
    save: vi.fn(
      async (next: ReviewSession): Promise<Result<void, StorageFailure>> => {
        stored = next;
        saves.push(next);
        return ok(undefined);
      },
    ),
  };
  const gate = {
    requireFresh: vi.fn(async () =>
      ok({ profile: { ghAccount: "fixture" }, session: stored }),
    ),
    requireCurrentSession: vi.fn(async () =>
      ok({ profile: { ghAccount: "fixture" }, session: stored }),
    ),
  };
  const github = {
    resolveAuthenticatedAccount: vi.fn(async () => ok({ account: "fixture" })),
    getViewerPendingReview: vi.fn(async () => ok({ _tag: "None" })),
    getPullRequest: vi.fn(async () => ok({ headSha })),
    startPendingReviewWithThread: vi.fn(async () =>
      ok({ review: pending(), createdThreadId: threadId }),
    ),
    addPendingReviewThread: vi.fn(async () =>
      ok({ review: pending(), createdThreadId: threadId }),
    ),
    submitPendingReview: vi.fn(async () => ok(undefined)),
    discardPendingReview: vi.fn(async () => ok(undefined)),
    ...overrides,
  };
  const coordinator = new ReviewOperationCoordinator();
  return {
    service: new PendingReviewService(
      gate as never,
      store as never,
      github as never,
      () => now,
      coordinator,
    ),
    store,
    gate,
    github,
    coordinator,
    saves,
    current: () => stored,
  };
}

describe("PendingReviewService", () => {
  it("keeps an absent pending state unavailable until a complete read persists None", async () => {
    const value = fixture();
    await expect(
      value.service.start({
        profileId,
        reviewId,
        expected,
        anchor,
        body: "comment",
      }),
    ).resolves.toEqual({ _tag: "err", error: "unavailable" });
    await expect(
      value.service.addThread({
        profileId,
        reviewId,
        expected,
        pendingReviewNodeId: pending().nodeId,
        anchor,
        body: "comment",
      }),
    ).resolves.toEqual({ _tag: "err", error: "unavailable" });
    await expect(
      value.service.submit({
        profileId,
        reviewId,
        expected,
        event: "COMMENT",
        summaryBody: "summary",
      }),
    ).resolves.toEqual({ _tag: "err", error: "unavailable" });
    await expect(
      value.service.discard({
        profileId,
        reviewId,
        expected,
        confirmation: true,
      }),
    ).resolves.toEqual({ _tag: "err", error: "unavailable" });
    await expect(
      value.service.reconcile({ profileId, reviewId }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { state: { _tag: "None" }, unavailable: false },
    });
    expect(value.saves).toHaveLength(1);
    expect(value.current().pendingReview).toEqual({ _tag: "None" });
    const persisted = fixture({ _tag: "Pending", review: pending() });
    await expect(
      persisted.service.reconcile({ profileId, reviewId }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { state: { _tag: "None" }, unavailable: false },
    });
    expect(persisted.saves).toHaveLength(1);
  });

  it("keeps an absent pending state unavailable after an incomplete read", async () => {
    const value = fixture(undefined, {
      getViewerPendingReview: vi.fn(async () => ok({ _tag: "Unavailable" })),
    });

    await expect(
      value.service.reconcile({ profileId, reviewId }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { unavailable: true, state: { _tag: "None" } },
    });
    expect(value.saves).toHaveLength(0);
    expect(value.current().pendingReview).toBeUndefined();
  });

  it("keeps confirmed None unavailable when persistence fails", async () => {
    const value = fixture();
    value.store.save.mockImplementation(async () =>
      err({
        _tag: "StorageFailure" as const,
        operation: "write" as const,
        reason: "io" as const,
      }),
    );

    await expect(
      value.service.reconcile({ profileId, reviewId }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { unavailable: true, state: { _tag: "None" } },
    });
    expect(value.current().pendingReview).toBeUndefined();
  });

  it("does not turn a failed read into None", async () => {
    const value = fixture(
      { _tag: "Pending", review: pending() },
      {
        getViewerPendingReview: vi.fn(async () =>
          err({ _tag: "GitHubReadFailed" }),
        ),
      },
    );
    await expect(
      value.service.reconcile({ profileId, reviewId }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { unavailable: true, state: { _tag: "Pending" } },
    });
    expect(value.saves).toHaveLength(0);
  });

  it("persists start intent before the write and receipt before success", async () => {
    const value = fixture({ _tag: "None" });
    await expect(
      value.service.start({
        profileId,
        reviewId,
        expected,
        anchor,
        body: "comment",
        finding,
      }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { state: { _tag: "Pending" } },
    });
    expect(value.github.startPendingReviewWithThread).toHaveBeenCalledTimes(1);
    expect(value.saves).toHaveLength(2);
    expect(value.saves[0]).toMatchObject({
      pendingReview: { _tag: "WriteInFlight", operation: { _tag: "Start" } },
    });
    expect(value.saves[1]).toMatchObject({
      pendingReview: { _tag: "Pending" },
      findingReviewReceipts: [
        { findingId: finding.findingId, threadId, state: "pending" },
      ],
    });
  });

  it("does not replay an uncertain start and retains its shared lock", async () => {
    const value = fixture(
      { _tag: "None" },
      {
        startPendingReviewWithThread: vi.fn(async () =>
          err({ category: "unavailable" }),
        ),
      },
    );
    await expect(
      value.service.start({
        profileId,
        reviewId,
        expected,
        anchor,
        body: "comment",
      }),
    ).resolves.toEqual({ _tag: "err", error: "outcome_unknown" });
    expect(value.current()).toMatchObject({
      pendingReview: { _tag: "OutcomeUnknown" },
    });
    await expect(
      value.service.start({
        profileId,
        reviewId,
        expected,
        anchor,
        body: "comment",
      }),
    ).resolves.toEqual({ _tag: "err", error: "pending_review_locked" });
    expect(value.github.startPendingReviewWithThread).toHaveBeenCalledTimes(1);
  });

  it("adds only once for an exact Finding while its receipt owns the pending thread", async () => {
    const value = fixture({ _tag: "Pending", review: pending() });
    await expect(
      value.service.addThread({
        profileId,
        reviewId,
        expected,
        pendingReviewNodeId: pending().nodeId,
        anchor,
        body: "comment",
        finding,
      }),
    ).resolves.toMatchObject({ _tag: "ok" });
    await expect(
      value.service.addThread({
        profileId,
        reviewId,
        expected,
        pendingReviewNodeId: pending().nodeId,
        anchor,
        body: "comment",
        finding,
      }),
    ).resolves.toEqual({ _tag: "err", error: "pending_review_locked" });
    expect(value.github.addPendingReviewThread).toHaveBeenCalledTimes(1);
  });

  it.each(["published", "historical"] as const)(
    "rejects an exact Finding with a %s receipt before a remote write",
    async (state) => {
      const receipt = {
        ...finding,
        threadId,
        pendingReviewNodeId: pending().nodeId,
        state,
      };
      const start = fixture({ _tag: "None" }, {}, [receipt]);
      await expect(
        start.service.start({
          profileId,
          reviewId,
          expected,
          anchor,
          body: "comment",
          finding,
        }),
      ).resolves.toEqual({ _tag: "err", error: "pending_review_locked" });
      expect(start.github.startPendingReviewWithThread).not.toHaveBeenCalled();
      expect(start.saves).toHaveLength(0);

      const add = fixture({ _tag: "Pending", review: pending() }, {}, [
        receipt,
      ]);
      await expect(
        add.service.addThread({
          profileId,
          reviewId,
          expected,
          pendingReviewNodeId: pending().nodeId,
          anchor,
          body: "comment",
          finding,
        }),
      ).resolves.toEqual({ _tag: "err", error: "pending_review_locked" });
      expect(add.github.addPendingReviewThread).not.toHaveBeenCalled();
      expect(add.saves).toHaveLength(0);
    },
  );

  it("submits and discards only after intent and durable None receipts", async () => {
    for (const command of ["submit", "discard"] as const) {
      const value = fixture({ _tag: "Pending", review: pending() });
      const result =
        command === "submit"
          ? value.service.submit({
              profileId,
              reviewId,
              expected,
              event: "COMMENT",
              summaryBody: "summary",
            })
          : value.service.discard({
              profileId,
              reviewId,
              expected,
              confirmation: true,
            });
      await expect(result).resolves.toMatchObject({
        _tag: "ok",
        value: { state: { _tag: "None" } },
      });
      expect(value.saves[0]).toMatchObject({
        pendingReview: {
          _tag: "WriteInFlight",
          operation: { _tag: command === "submit" ? "Submit" : "Discard" },
        },
      });
      expect(value.saves[1]).toMatchObject({ pendingReview: { _tag: "None" } });
    }
  });

  it("rejects a command while another review operation owns the shared lock", async () => {
    const value = fixture({ _tag: "None" });
    const key = `${profileId}:${reviewId}`;
    expect(value.coordinator.acquire(key)).toBe(true);
    await expect(
      value.service.start({
        profileId,
        reviewId,
        expected,
        anchor,
        body: "comment",
      }),
    ).resolves.toEqual({ _tag: "err", error: "review_write_in_progress" });
    value.coordinator.release(key);
  });

  it("projects unavailable and every uncertain operation as non-editable", () => {
    expect(projectPendingReview({ _tag: "None" }, true)).toEqual({
      state: "unavailable",
      action: "refresh",
    });
    for (const operation of [
      "Start",
      "AddThread",
      "Submit",
      "Discard",
    ] as const) {
      expect(
        projectPendingReview(
          {
            _tag: "OutcomeUnknown",
            operation: { _tag: operation },
            startedAt: now,
          } as never,
          false,
        ),
      ).toMatchObject({ state: "recovery_required" });
    }
  });
});
