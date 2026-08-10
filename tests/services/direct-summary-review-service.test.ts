import { describe, expect, it, vi } from "vitest";

import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parsePullRequestNumber,
  parseReviewId,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import type {
  DirectSummaryReviewState,
} from "../../src/domain/direct-summary-review";
import type { ReviewSession } from "../../src/domain/review-session";
import { ok, type Result } from "../../src/domain/result";
import { DirectSummaryReviewService } from "../../src/services/direct-summary-review-service";
import { ReviewWriteCoordinator } from "../../src/services/review-write-coordinator";
import type { ReviewWriteGate } from "../../src/services/review-write-gate";

const must = <T>(result: Result<T, unknown>): T => {
  if (result._tag === "ok") return result.value;
  throw new Error("fixture");
};
const profileId = must(parseWorkspaceProfileId("cfw"));
const reviewId = must(parseReviewId("cfw__centraldigital__patchdesk__pr-42__review-abcdef123456"));
const headSha = must(parseGitSha("1".repeat(40)));
const sessionKey = {
  profileId,
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("centraldigital")),
  repo: must(parseGitHubRepoName("patchdesk")),
  prNumber: must(parsePullRequestNumber(42)),
  headSha,
};
const expected = { sessionId: "session-a", headSha, patchHash: "patch-hash" };

function session(directSummaryReview?: DirectSummaryReviewState): ReviewSession {
  return {
    schemaVersion: 4,
    id: "session-a" as never,
    key: sessionKey,
    state: { _tag: "Created" },
    pr: { headSha, isDraft: false, isOpen: true },
    patchPath: "/tmp/patch.diff" as never,
    scope: { kind: "full" },
    worktree: { path: "/tmp/worktree" as never, headSha },
    createdAt: "2026-08-09T00:00:00.000Z" as never,
    updatedAt: "2026-08-09T00:00:00.000Z" as never,
    ...(directSummaryReview === undefined ? {} : { directSummaryReview }),
  };
}

function makeStore(initial: ReviewSession) {
  let stored = initial;
  return {
    store: {
      load: vi.fn(async () => ok(stored)),
      save: vi.fn(async (next: ReviewSession) => {
        stored = next;
        return ok(undefined);
      }),
    },
    current: () => stored,
    replace: (next: ReviewSession) => { stored = next; },
  };
}

function makeGate(sessionValue: ReviewSession): Pick<ReviewWriteGate, "requireFresh" | "requireCurrentSession"> {
  return {
    requireFresh: vi.fn(async () => ok({ profile: { ghAccount: "pmquan2cfw" } as never, session: sessionValue }) as never),
    requireCurrentSession: vi.fn(async () => ok({ profile: { ghAccount: "pmquan2cfw" } as never, session: sessionValue }) as never),
  };
}

function makeGateway(overrides: Record<string, unknown> = {}) {
  return {
    resolveAuthenticatedAccount: vi.fn(async () => ok({ host: "github.com", account: "pmquan2cfw" })),
    getViewerPendingReview: vi.fn(async () => ok({ _tag: "None" })),
    getPullRequest: vi.fn(async () => ok({ headSha } as never)),
    getViewerDirectSummaryReviews: vi.fn(async () => ok({ reviews: [], complete: true })),
    createDirectSummaryReview: vi.fn(async () => ok({ reviewId: "9002" as never, event: "COMMENT" as const, headSha, submittedAt: "2026-08-09T11:35:01.000Z" as never })),
    ...overrides,
  };
}

function service(sessionValue: ReviewSession, gateway: ReturnType<typeof makeGateway>, store: ReturnType<typeof makeStore>["store"], coordinator?: ReviewWriteCoordinator) {
  return new DirectSummaryReviewService(
    makeGate(sessionValue),
    store,
    gateway as never,
    () => "2026-08-09T11:35:00.900Z" as never,
    coordinator,
  );
}

describe("DirectSummaryReviewService.submit", () => {
  it("does not create another review after a confirmed direct summary", async () => {
    const confirmed: DirectSummaryReviewState = {
      _tag: "Confirmed",
      receipt: { reviewId: "9001" as never, event: "COMMENT", headSha, submittedAt: "2026-08-09T11:35:00.000Z" as never },
    };
    const fixture = makeStore(session(confirmed));
    const gateway = makeGateway();

    const result = await service(fixture.current(), gateway, fixture.store).submit({
      profileId,
      reviewId,
      expected: expected as never,
      event: "COMMENT",
      body: "A second summary",
    });

    expect(result).toEqual({ _tag: "err", error: "review_already_submitted" });
    expect(gateway.createDirectSummaryReview).not.toHaveBeenCalled();
  });

  it("blocks when GitHub reports an existing pending review", async () => {
    const fixture = makeStore(session());
    const gateway = makeGateway({
      getViewerPendingReview: vi.fn(async () => ok({
        _tag: "Pending" as const,
        review: { nodeId: "pending-node", restId: "9000" as never, headSha, comments: [] },
      })),
    });

    const result = await service(fixture.current(), gateway, fixture.store).submit({
      profileId,
      reviewId,
      expected: expected as never,
      event: "COMMENT",
      body: "A summary while pending",
    });

    expect(result).toEqual({ _tag: "err", error: "pending_review_exists" });
    expect(gateway.getViewerDirectSummaryReviews).not.toHaveBeenCalled();
    expect(gateway.createDirectSummaryReview).not.toHaveBeenCalled();
  });

  it("requires reconciliation rather than replaying an uncertain write", async () => {
    const unknown: DirectSummaryReviewState = {
      _tag: "OutcomeUnknown",
      operation: {
        requestId: "direct-summary-1",
        event: "COMMENT",
        bodyDigest: "a".repeat(64),
        headSha,
        baselineReviewIds: [],
        startedAt: "2026-08-09T11:35:00.900Z" as never,
      },
    };
    const fixture = makeStore(session(unknown));
    const gateway = makeGateway();

    const result = await service(fixture.current(), gateway, fixture.store).submit({
      profileId,
      reviewId,
      expected: expected as never,
      event: "COMMENT",
      body: "A second summary",
    });

    expect(result).toEqual({ _tag: "err", error: "outcome_unknown" });
    expect(gateway.createDirectSummaryReview).not.toHaveBeenCalled();
  });
});

describe("DirectSummaryReviewService coordination", () => {
  it("preserves a session mutation that lands before a direct-summary state transition", async () => {
    const fixture = makeStore(session());
    const batchContent = { state: { _tag: "Local" as const }, items: [], sessionId: "session-a", updatedAt: "2026-08-09T11:35:00.000Z" as never } as never;
    const gateway = makeGateway({
      createDirectSummaryReview: vi.fn(async () => {
        fixture.replace({ ...fixture.current(), batchContent });
        return ok({ reviewId: "9002" as never, event: "COMMENT" as const, headSha, submittedAt: "2026-08-09T11:35:01.000Z" as never });
      }),
    });

    const result = await service(fixture.current(), gateway, fixture.store).submit({ profileId, reviewId, expected: expected as never, event: "COMMENT", body: "Preserve" });

    expect(result._tag).toBe("ok");
    expect(fixture.current().batchContent).toBe(batchContent);
    expect(fixture.current().directSummaryReview).toMatchObject({ _tag: "Confirmed", receipt: { reviewId: "9002" } });
  });
  it("locks a concurrent submission through the shared review coordinator", async () => {
    const gateway = makeGateway({
      createDirectSummaryReview: vi.fn(() => new Promise(() => undefined)),
    });
    const fixture = makeStore(session());
    const coordinator = new ReviewWriteCoordinator();
    void service(fixture.current(), gateway, fixture.store, coordinator).submit({ profileId, reviewId, expected: expected as never, event: "COMMENT", body: "First" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await service(fixture.current(), gateway, fixture.store, coordinator).submit({ profileId, reviewId, expected: expected as never, event: "COMMENT", body: "Second" });
    expect(second).toEqual({ _tag: "err", error: "review_write_in_progress" });
  });

  it("persists recovery evidence when the direct write outcome is unavailable", async () => {
    const fixture = makeStore(session());
    const gateway = makeGateway({
      createDirectSummaryReview: vi.fn(async () => ({ _tag: "err" as const, error: { category: "unavailable" as const, message: "timeout" } })),
    });
    const result = await service(fixture.current(), gateway, fixture.store).submit({ profileId, reviewId, expected: expected as never, event: "COMMENT", body: "Uncertain" });
    expect(result).toEqual({ _tag: "err", error: "outcome_unknown" });
    expect(fixture.current().directSummaryReview?._tag).toBe("OutcomeUnknown");
  });

});

describe("DirectSummaryReviewService.reconcile", () => {
  it("recognizes a lost response submitted in the same GitHub timestamp second", async () => {
    const unknown: DirectSummaryReviewState = {
      _tag: "OutcomeUnknown",
      operation: {
        requestId: "direct-summary-1",
        event: "COMMENT",
        bodyDigest: "a".repeat(64),
        headSha,
        baselineReviewIds: [],
        startedAt: "2026-08-09T11:35:00.900Z" as never,
      },
    };
    const fixture = makeStore(session(unknown));
    const gateway = makeGateway({
      getViewerDirectSummaryReviews: vi.fn(async () => ok({
        complete: true,
        reviews: [{
          reviewId: "9002" as never,
          event: "COMMENT" as const,
          headSha,
          bodyDigest: "a".repeat(64),
          submittedAt: "2026-08-09T11:35:00.000Z" as never,
        }],
      })),
    });

    const result = await service(fixture.current(), gateway, fixture.store).reconcile({ profileId, reviewId });

    expect(result).toMatchObject({ _tag: "ok", value: { _tag: "Confirmed", receipt: { reviewId: "9002" } } });
    expect(fixture.current().directSummaryReview).toMatchObject({ _tag: "Confirmed", receipt: { reviewId: "9002" } });
  });

  it("keeps an unknown operation locked when the only match is outside the recovery window", async () => {
    const unknown: DirectSummaryReviewState = {
      _tag: "OutcomeUnknown",
      operation: {
        requestId: "direct-summary-2",
        event: "COMMENT",
        bodyDigest: "a".repeat(64),
        headSha,
        baselineReviewIds: [],
        startedAt: "2026-08-09T11:35:00.900Z" as never,
      },
    };
    const fixture = makeStore(session(unknown));
    const gateway = makeGateway({
      getViewerDirectSummaryReviews: vi.fn(async () => ok({
        complete: true,
        reviews: [{
          reviewId: "9003" as never,
          event: "COMMENT" as const,
          headSha,
          bodyDigest: "a".repeat(64),
          submittedAt: "2026-08-09T17:35:01.000Z" as never,
        }],
      })),
    });

    const result = await service(fixture.current(), gateway, fixture.store).reconcile({ profileId, reviewId });

    expect(result).toMatchObject({ _tag: "ok", value: { _tag: "OutcomeUnknown" } });
    expect(fixture.current().directSummaryReview).toMatchObject({ _tag: "OutcomeUnknown" });
    expect(fixture.store.save).not.toHaveBeenCalled();
  });
});
