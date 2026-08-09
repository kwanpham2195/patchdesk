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
import {
  parseViewerPendingReview,
  type PendingReviewState,
  type ViewerPendingReview,
} from "../../src/domain/pending-review";
import type { ReviewSession } from "../../src/domain/review-session";
import { err, ok, type Result } from "../../src/domain/result";
import {
  PendingReviewService,
  projectPendingReview,
} from "../../src/services/pending-review-service";

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

const reviewRaw = {
  restId: "9001",
  nodeId: "PRR_kwDORJzsQM7e6QwJ",
  author: "pmquan2cfw",
  pr: { host: "github.com", owner: "centraldigital", repo: "patchdesk", number: 42 },
  headSha: "1111111111111111111111111111111111111111",
  comments: [
    {
      reviewCommentId: "PRRC_kwDORJzsQM7fI2Rd",
      threadId: "PRRT_kwDORJzsQM0001",
      body: "Comment body",
      anchor: { path: "docs/docs.go", startLine: 2908, line: 2908, side: "new" },
      createdAt: "2026-08-09T11:34:50.000Z",
    },
  ],
  createdAt: "2026-08-09T11:34:50.000Z",
  updatedAt: "2026-08-09T11:34:50.000Z",
};

const review = (): ViewerPendingReview => {
  const parsed = parseViewerPendingReview(reviewRaw);
  if (parsed._tag === "err") throw new Error("fixture");
  return parsed.value;
};

function session(pendingReview?: PendingReviewState): ReviewSession {
  return {
    id: "session-a" as never,
    key: sessionKey,
    state: { _tag: "Created" },
    pr: { headSha, isDraft: false, isOpen: true },
    patchPath: "/tmp/patch.diff" as never,
    scope: { kind: "full" },
    worktree: { path: "/tmp/worktree" as never, headSha },
    createdAt: "2026-08-09T00:00:00.000Z" as never,
    updatedAt: "2026-08-09T00:00:00.000Z" as never,
    ...(pendingReview === undefined ? {} : { pendingReview }),
  };
}

function makeStore(initial: ReviewSession) {
  let stored = initial;
  const saves: Array<ReviewSession> = [];
  return {
    store: {
      load: vi.fn(async () => ok(stored)),
      save: vi.fn(async (next: ReviewSession) => {
        stored = next;
        saves.push(next);
        return ok(undefined);
      }),
    },
    saves,
    current: () => stored,
  };
}

function makeGate(sessionValue: ReviewSession) {
  return {
    requireFresh: vi.fn(async () => ok({ profile: { ghAccount: "pmquan2cfw" } as never, session: sessionValue })),
    requireCurrentSession: vi.fn(async () => ok({ profile: { ghAccount: "pmquan2cfw" } as never, session: sessionValue })),
  };
}

function makeGateway(overrides: Record<string, unknown> = {}) {
  return {
    resolveAuthenticatedAccount: vi.fn(async () => ok({ host: "github.com", account: "pmquan2cfw" })),
    getViewerPendingReview: vi.fn(async () => ok({ _tag: "None" })),
    startPendingReviewWithThread: vi.fn(async () => ok(review())),
    addPendingReviewThread: vi.fn(async () => ok(review())),
    submitPendingReview: vi.fn(async () => ok({ reviewId: "9001" })),
    getPullRequest: vi.fn(async () => ok({ headSha } as never)),
    ...overrides,
  };
}

const service = (sessionValue: ReviewSession, gateway: ReturnType<typeof makeGateway>, store: ReturnType<typeof makeStore>["store"]) =>
  new PendingReviewService(
    makeGate(sessionValue),
    store,
    gateway as never,
    () => "2026-08-09T11:35:00.000Z" as never,
  );

describe("PendingReviewService.reconcile", () => {
  it("imports an externally started viewer pending review at open/refresh", async () => {
    const fixture = makeStore(session());
    const gateway = makeGateway({ getViewerPendingReview: vi.fn(async () => ok({ _tag: "Pending", review: review() })) });
    const result = await service(fixture.current(), gateway, fixture.store).reconcile({ profileId, reviewId });
    expect(result).toMatchObject({ _tag: "ok", value: { unavailable: false, state: { _tag: "Pending" } } });
    expect(fixture.current().pendingReview).toMatchObject({ _tag: "Pending", review: { restId: "9001" } });
  });

  it("persists None only when the complete read proves absence", async () => {
    const fixture = makeStore(session());
    const result = await service(fixture.current(), makeGateway(), fixture.store).reconcile({ profileId, reviewId });
    expect(result).toMatchObject({ _tag: "ok", value: { state: { _tag: "None" } } });
    // An absent field already means None; an explicit None record is not written.
    expect(fixture.saves).toHaveLength(0);
  });

  it("reports unavailable without replacing the stored state when the read fails", async () => {
    const fixture = makeStore(session({ _tag: "Pending", review: review() }));
    const gateway = makeGateway({ getViewerPendingReview: vi.fn(async () => err({ _tag: "GitHubReadFailed" as const, operation: "get_pending_review" as const })) });
    const result = await service(fixture.current(), gateway, fixture.store).reconcile({ profileId, reviewId });
    expect(result).toMatchObject({ _tag: "ok", value: { unavailable: true, state: { _tag: "Pending" } } });
    expect(fixture.saves).toHaveLength(0);
  });

  it("keeps a locked operation locked until explicit recovery", async () => {
    const locked: PendingReviewState = {
      _tag: "OutcomeUnknown",
      operation: { _tag: "Start", requestId: "pending-review-20260809" as never },
      startedAt: "2026-08-09T11:35:00.000Z" as never,
    };
    const fixture = makeStore(session(locked));
    const gateway = makeGateway({ getViewerPendingReview: vi.fn(async () => ok({ _tag: "Pending", review: review() })) });
    const withoutRecover = await service(fixture.current(), gateway, fixture.store).reconcile({ profileId, reviewId });
    expect(withoutRecover).toMatchObject({ _tag: "ok", value: { state: { _tag: "OutcomeUnknown" } } });
    expect(fixture.saves).toHaveLength(0);
    const recovered = await service(fixture.current(), gateway, fixture.store).reconcile({ profileId, reviewId, recover: true });
    expect(recovered).toMatchObject({ _tag: "ok", value: { state: { _tag: "Pending", review: { restId: "9001" } } } });
    expect(fixture.current().pendingReview).toMatchObject({ _tag: "Pending" });
  });
});

describe("PendingReviewService.start", () => {
  it("persists the operation intent before the write and the receipt before success", async () => {
    const fixture = makeStore(session());
    const gateway = makeGateway();
    const result = await service(fixture.current(), gateway, fixture.store).start({
      profileId,
      reviewId,
      expected: expected as never,
      anchor: { path: "docs/docs.go" as never, startLine: 2908, line: 2908, side: "new" },
      body: "Comment body",
    });
    expect(result).toMatchObject({ _tag: "ok", value: { state: { _tag: "Pending", review: { restId: "9001" } } } });
    // Intent (WriteInFlight) was persisted before the write; the confirmed
    // receipt was persisted after it.
    const writes = fixture.saves.map((saved) => saved.pendingReview?._tag);
    expect(writes).toEqual(["WriteInFlight", "Pending"]);
    const savedIntent = fixture.saves[0]?.pendingReview;
    expect(savedIntent).toMatchObject({ _tag: "WriteInFlight", operation: { _tag: "Start" } });
    expect(gateway.startPendingReviewWithThread).toHaveBeenCalledTimes(1);
    expect(fixture.current().pendingReview).toMatchObject({ _tag: "Pending" });
  });

  it("a lost response becomes OutcomeUnknown and is never retried", async () => {
    const fixture = makeStore(session());
    const gateway = makeGateway({
      startPendingReviewWithThread: vi.fn(async () => err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "timeout" })),
    });
    const result = await service(fixture.current(), gateway, fixture.store).start({
      profileId,
      reviewId,
      expected: expected as never,
      anchor: { path: "docs/docs.go" as never, startLine: 2908, line: 2908, side: "new" },
      body: "Comment body",
    });
    expect(result).toEqual({ _tag: "err", error: "outcome_unknown" });
    expect(fixture.current().pendingReview).toMatchObject({ _tag: "OutcomeUnknown", operation: { _tag: "Start" } });
    expect(gateway.startPendingReviewWithThread).toHaveBeenCalledTimes(1);
  });

  it("a rejected write restores the prior confirmed state", async () => {
    const fixture = makeStore(session());
    const gateway = makeGateway({
      startPendingReviewWithThread: vi.fn(async () => err({ _tag: "GitHubWriteFailure", category: "rejected", message: "rejected" })),
    });
    const result = await service(fixture.current(), gateway, fixture.store).start({
      profileId,
      reviewId,
      expected: expected as never,
      anchor: { path: "docs/docs.go" as never, startLine: 2908, line: 2908, side: "new" },
      body: "Comment body",
    });
    expect(result).toEqual({ _tag: "err", error: "rejected" });
    expect(fixture.current().pendingReview).toEqual({ _tag: "None" });
  });

  it("cannot start while a pending review exists", async () => {
    const fixture = makeStore(session({ _tag: "Pending", review: review() }));
    const result = await service(fixture.current(), makeGateway(), fixture.store).start({
      profileId,
      reviewId,
      expected: expected as never,
      anchor: { path: "docs/docs.go" as never, startLine: 2908, line: 2908, side: "new" },
      body: "Comment body",
    });
    expect(result).toEqual({ _tag: "err", error: "no_pending_review" });
  });

  it("blocks writes after a live head change", async () => {
    const fixture = makeStore(session());
    const gateway = makeGateway({ getPullRequest: vi.fn(async () => ok({ headSha: "2".repeat(40) } as never)) });
    const result = await service(fixture.current(), gateway, fixture.store).start({
      profileId,
      reviewId,
      expected: expected as never,
      anchor: { path: "docs/docs.go" as never, startLine: 2908, line: 2908, side: "new" },
      body: "Comment body",
    });
    expect(result).toEqual({ _tag: "err", error: "stale_head" });
    expect(gateway.startPendingReviewWithThread).not.toHaveBeenCalled();
  });

  it("serializes one pending-review owner per Review", async () => {
    const fixture = makeStore(session());
    let release: (value: Result<ViewerPendingReview, never>) => void = () => undefined;
    const gate = makeGate(fixture.current());
    const gateway = makeGateway({
      startPendingReviewWithThread: vi.fn(() => new Promise<Result<ViewerPendingReview, never>>((resolve) => { release = resolve as never; })),
    });
    const svc = new PendingReviewService(gate, fixture.store, gateway as never, () => "2026-08-09T11:35:00.000Z" as never);
    const first = svc.start({ profileId, reviewId, expected: expected as never, anchor: { path: "docs/docs.go" as never, startLine: 2908, line: 2908, side: "new" }, body: "Comment body" });
    const second = await svc.start({ profileId, reviewId, expected: expected as never, anchor: { path: "docs/docs.go" as never, startLine: 2908, line: 2908, side: "new" }, body: "Comment body" });
    expect(second).toEqual({ _tag: "err", error: "review_write_in_progress" });
    // Wait until the first write has crossed the remote boundary before
    // resolving it, so the deferred receipt resolves the pending write.
    await vi.waitFor(() => { expect(gateway.startPendingReviewWithThread).toHaveBeenCalled(); });
    release(ok(review()));
    await expect(first).resolves.toMatchObject({ _tag: "ok", value: { state: { _tag: "Pending" } } });
    expect(gateway.startPendingReviewWithThread).toHaveBeenCalledTimes(1);
  });
});

describe("PendingReviewService.addThread and submit", () => {
  it("appends only to the represented pending review", async () => {
    const fixture = makeStore(session({ _tag: "Pending", review: review() }));
    const gateway = makeGateway();
    const result = await service(fixture.current(), gateway, fixture.store).addThread({
      profileId,
      reviewId,
      expected: expected as never,
      pendingReviewNodeId: "PRR_kwDORJzsQM7e6QwJ" as never,
      anchor: { path: "docs/docs.go" as never, startLine: 2912, line: 2912, side: "new" },
      body: "More",
    });
    expect(result._tag).toBe("ok");
    expect(gateway.addPendingReviewThread).toHaveBeenCalledWith(expect.objectContaining({ reviewId: "PRR_kwDORJzsQM7e6QwJ" }));
  });

  it("rejects an append for a different review identity", async () => {
    const fixture = makeStore(session({ _tag: "Pending", review: review() }));
    const gateway = makeGateway();
    const result = await service(fixture.current(), gateway, fixture.store).addThread({
      profileId,
      reviewId,
      expected: expected as never,
      pendingReviewNodeId: "PRR_other0000000000" as never,
      anchor: { path: "docs/docs.go" as never, startLine: 2912, line: 2912, side: "new" },
      body: "More",
    });
    expect(result).toEqual({ _tag: "err", error: "no_pending_review" });
    expect(gateway.addPendingReviewThread).not.toHaveBeenCalled();
  });

  it("submit confirms None only after a durable receipt", async () => {
    const fixture = makeStore(session({ _tag: "Pending", review: review() }));
    const gateway = makeGateway();
    const result = await service(fixture.current(), gateway, fixture.store).submit({
      profileId,
      reviewId,
      expected: expected as never,
      event: "COMMENT",
      summaryBody: "Final summary",
    });
    expect(result).toMatchObject({ _tag: "ok", value: { state: { _tag: "None" } } });
    expect(gateway.submitPendingReview).toHaveBeenCalledWith(expect.objectContaining({ reviewId: "9001", event: "COMMENT", summaryBody: "Final summary" }));
    expect(fixture.current().pendingReview).toEqual({ _tag: "None" });
  });

  it("submit cannot run without a pending review", async () => {
    const fixture = makeStore(session());
    const gateway = makeGateway();
    const result = await service(fixture.current(), gateway, fixture.store).submit({
      profileId,
      reviewId,
      expected: expected as never,
      event: "COMMENT",
      summaryBody: "Final summary",
    });
    expect(result).toEqual({ _tag: "err", error: "no_pending_review" });
    expect(gateway.submitPendingReview).not.toHaveBeenCalled();
  });
});

describe("projectPendingReview", () => {
  it("never projects unavailable as none and maps every durable state", () => {
    expect(projectPendingReview({ _tag: "None" }, false)).toEqual({ state: "none" });
    expect(projectPendingReview({ _tag: "None" }, true)).toEqual({ state: "unavailable", action: "refresh" });
    expect(projectPendingReview({ _tag: "Pending", review: review() }, false)).toMatchObject({
      state: "pending",
      count: 1,
      review: { nodeId: "PRR_kwDORJzsQM7e6QwJ", headSha: "1111111111111111111111111111111111111111" },
    });
    expect(projectPendingReview({
      _tag: "OutcomeUnknown",
      operation: { _tag: "Submit", requestId: "pending-review-1" as never, reviewId: "9001" as never, event: "COMMENT" },
      startedAt: "2026-08-09T11:35:00.000Z" as never,
    }, false)).toEqual({ state: "recovery_required", action: "submit" });
  });
});
