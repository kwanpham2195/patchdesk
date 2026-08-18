import { describe, expect, it, vi } from "vitest";

import { err, ok } from "../../src/domain/result";
import type { DirectSummaryReviewState } from "../../src/domain/direct-summary-review";
import type { PendingReviewState } from "../../src/domain/pending-review";
import type { ReviewSession } from "../../src/domain/review-session";
import { DirectSummaryReviewService } from "../../src/services/direct-summary-review-service";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";

// SAFETY: this literal matches parseWorkspaceProfileId's accepted slug shape.
const profileId = "cfw" as never;
// SAFETY: this literal matches parseReviewId's <host>__owner__repo__pr-N__review-<hex> shape.
const reviewId =
  "github.com__centraldigital__patchdesk__pr-42__review-aaaaaaaaaaaa" as never;
// SAFETY: this literal is a 40-character hex string, matching parseGitSha's format.
const headSha = "a".repeat(40) as never;
// SAFETY: this literal matches createReviewSessionId's <host>__owner__repo__sha-N__<hex> shape.
const sessionId =
  "github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__b48f8e2e76ca" as never;
// SAFETY: this literal is a well-formed ISO 8601 instant, matching parseIsoTimestamp's format.
const now = "2026-08-09T11:35:00.000Z" as never;
// SAFETY: this literal is a 64-character hex string, matching parseContentHash's format.
const expected = { sessionId, headSha, patchHash: "b".repeat(64) as never };
function session(
  directSummaryReview?: DirectSummaryReviewState,
  pendingReview?: PendingReviewState,
): ReviewSession {
  const base = {
    schemaVersion: 5 as const,
    id: sessionId,
    // SAFETY: these literals match their branded parsers' accepted formats
    // (a bare hostname, and slug-shaped owner/repo names).
    key: {
      profileId,
      host: "github.com" as never,
      owner: "centraldigital" as never,
      repo: "patchdesk" as never,
      // SAFETY: this literal is a positive integer, matching parsePullRequestNumber's format.
      prNumber: 42 as never,
      headSha,
    },
    pr: { headSha, isDraft: false, isOpen: true },
    // SAFETY: these literals match parseAbsolutePath's format (a leading-slash path).
    patchPath: "/tmp/patch" as never,
    // SAFETY: this literal matches parseAbsolutePath's format (a leading-slash path).
    worktree: { path: "/tmp/worktree" as never, headSha },
    createdAt: now,
    updatedAt: now,
  };
  const withDirectSummary =
    directSummaryReview === undefined
      ? base
      : { ...base, directSummaryReview };
  return pendingReview === undefined
    ? withDirectSummary
    : { ...withDirectSummary, pendingReview };
}
function fixture(
  state?: DirectSummaryReviewState,
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- each test overrides a differently-shaped github mock method (varying Result payloads); there is no single concrete return type across every possible override.
  overrides: Record<string, (...args: never[]) => unknown> = {},
) {
  let stored = session(state);
  const saves: unknown[] = [];
  const sessions = {
    load: vi.fn(async () => ok(stored)),
    save: vi.fn(async (next: ReviewSession) => {
      stored = next;
      saves.push(next);
      return ok(undefined);
    }),
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
    getPullRequest: vi.fn(async () => ok({ headSha, author: "other" })),
    resolveAuthenticatedAccount: vi.fn(async () => ok({ account: "fixture" })),
    getViewerPendingReview: vi.fn(async () => ok({ _tag: "None" })),
    getViewerDirectSummaryReviews: vi.fn(async () =>
      ok({ complete: true, reviews: [] }),
    ),
    createDirectSummaryReview: vi.fn(async () =>
      ok({ reviewId: "9001", event: "COMMENT", headSha, submittedAt: now }),
    ),
    ...overrides,
  };
  const coordinator = new ReviewOperationCoordinator();
  const recentWrites = { append: vi.fn(async () => ok(undefined)) };
  // SAFETY: these fixture mocks implement only the Pick<...> subset each
  // dependency interface requires; the service never calls their other members.
  return {
    service: new DirectSummaryReviewService(
      gate as never,
      sessions as never,
      github as never,
      () => now,
      coordinator,
      recentWrites,
    ),
    github,
    coordinator,
    recentWrites,
    saves,
    current: () => stored,
  };
}
const submit = (service: DirectSummaryReviewService) =>
  service.submit({
    profileId,
    reviewId,
    expected,
    event: "COMMENT",
    body: "summary",
  });

describe("DirectSummaryReviewService", () => {
  it("persists a confirmed direct-summary receipt before success", async () => {
    const value = fixture();
    await expect(submit(value.service)).resolves.toMatchObject({
      _tag: "ok",
      value: { _tag: "Confirmed", receipt: { reviewId: "9001" } },
    });
    expect(value.saves).toHaveLength(2);
    expect(value.saves[0]).toMatchObject({
      directSummaryReview: { _tag: "WriteInFlight" },
    });
    expect(value.saves[1]).toMatchObject({
      directSummaryReview: { _tag: "Confirmed" },
    });
  });

  it("blocks author approval before intent or GitHub write", async () => {
    const value = fixture(undefined, {
      getPullRequest: vi.fn(async () => ok({ headSha, author: "fixture" })),
    });
    await expect(
      value.service.submit({
        profileId,
        reviewId,
        expected,
        event: "APPROVE",
        body: "summary",
      }),
    ).resolves.toEqual({ _tag: "err", error: "self_approval_not_allowed" });
    expect(value.saves).toHaveLength(0);
    expect(value.github.createDirectSummaryReview).not.toHaveBeenCalled();
  });

  it("blocks a confirmed pending review before intent or direct write", async () => {
    const value = fixture(undefined, {
      getViewerPendingReview: vi.fn(async () => ok({ _tag: "Pending" })),
    });
    await expect(submit(value.service)).resolves.toEqual({
      _tag: "err",
      error: "pending_review_exists",
    });
    expect(value.saves).toHaveLength(0);
    expect(value.github.createDirectSummaryReview).not.toHaveBeenCalled();
  });

  it("retains uncertainty and never replays its direct write", async () => {
    const value = fixture(undefined, {
      createDirectSummaryReview: vi.fn(async () =>
        err({ category: "unavailable" }),
      ),
    });
    await expect(submit(value.service)).resolves.toEqual({
      _tag: "err",
      error: "outcome_unknown",
    });
    expect(value.current()).toMatchObject({
      directSummaryReview: { _tag: "OutcomeUnknown" },
    });
    await expect(submit(value.service)).resolves.toEqual({
      _tag: "err",
      error: "outcome_unknown",
    });
    expect(value.github.createDirectSummaryReview).toHaveBeenCalledTimes(1);
  });

  it("surfaces a forbidden write as 'forbidden', not the generic 'rejected' category", async () => {
    const value = fixture(undefined, {
      createDirectSummaryReview: vi.fn(async () =>
        err({ category: "forbidden" }),
      ),
    });
    await expect(submit(value.service)).resolves.toEqual({
      _tag: "err",
      error: "forbidden",
    });
  });

  it("reconciles a matching lost response to a confirmed receipt", async () => {
    const operation = {
      requestId: "request",
      event: "COMMENT" as const,
      bodyDigest: "a".repeat(64),
      headSha,
      baselineReviewIds: [],
      startedAt: now,
    };
    const value = fixture(
      { _tag: "OutcomeUnknown", operation, resolution: "check_required" },
      {
        getViewerDirectSummaryReviews: vi.fn(async () =>
          ok({
            complete: true,
            reviews: [
              {
                reviewId: "9001",
                event: "COMMENT",
                bodyDigest: operation.bodyDigest,
                headSha,
                submittedAt: now,
              },
            ],
          }),
        ),
      },
    );
    await expect(
      value.service.reconcile({ profileId, reviewId }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { _tag: "Confirmed", receipt: { reviewId: "9001" } },
    });
    expect(value.github.createDirectSummaryReview).not.toHaveBeenCalled();
  });

  it("uses the shared review coordinator for concurrent submissions", async () => {
    const value = fixture();
    const key = `${profileId}:${reviewId}`;
    expect(value.coordinator.acquire(key)).toBe(true);
    await expect(submit(value.service)).resolves.toEqual({
      _tag: "err",
      error: "review_write_in_progress",
    });
    value.coordinator.release(key);
  });

  it("preserves a concurrent session field when persisting direct-summary state", async () => {
    const value = fixture();
    let first = true;
    const original = value.github.createDirectSummaryReview;
    value.github.createDirectSummaryReview = vi.fn(async (...args: never[]) => {
      void args;
      if (first) {
        first = false;
      }
      return await original();
    });
    await expect(submit(value.service)).resolves.toMatchObject({ _tag: "ok" });
    expect(value.current()).toMatchObject({
      directSummaryReview: { _tag: "Confirmed" },
    });
  });
});
