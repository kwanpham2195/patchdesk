import { describe, expect, it } from "vitest";

import type { GitHubReviewWriter, PendingReviewComment } from "../../src/adapters/github/github-adapter";
import { editFailedDraftComment, type ReviewDraft } from "../../src/domain/review-draft";
import type { ReviewSession } from "../../src/domain/review-session";
import {
  createPendingReview,
  planBatchOperations,
  applyReviewBatch,
  submitSummaryOnlyPendingReview,
  submitPendingReview,
} from "../../src/services/review-submission-service";

const headSha = "abcdef1234567890abcdef1234567890abcdef12" as never;
const movedHeadSha = "fedcba9876543210fedcba9876543210fedcba98" as never;
const session = {
  id: "github.com__centraldigital__patchdesk__pr-1__sha-abcdef12__0123456789ab",
  key: { profileId: "cfw", host: "github.com", owner: "centraldigital", repo: "patchdesk", prNumber: 1, headSha },
  pr: { headSha, isDraft: false, isOpen: true },
  state: { _tag: "ReviewCompleted", attemptId: "001" },
  currentAttemptId: "001",
  createdAt: "2026-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T00:00:00.000Z",
} as unknown as ReviewSession;
const draft = {
  sessionId: session.id,
  attemptId: "001",
  state: { _tag: "LocalDraft" },
  summaryBody: "Review summary",
  suggestedEvent: "REQUEST_CHANGES",
  comments: [
    { findingId: "mapped", include: true, originalSuggestedBody: "Keep the guard.", body: "Keep the guard.", path: "src/write.ts", line: 8, diffSide: "new", postability: "postable" },
    { findingId: "excluded", include: false, originalSuggestedBody: "Ignore me.", body: "Ignore me.", path: "src/write.ts", line: 12, diffSide: "new", postability: "postable" },
    { findingId: "invalid", include: true, originalSuggestedBody: "Cannot post.", body: "Cannot post.", path: "src/write.ts", line: 18, diffSide: "new", postability: "invalid_line" },
  ],
  createdAt: "2026-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T00:00:00.000Z",
} as unknown as ReviewDraft;

function gateway(currentHead = headSha, writer: Partial<GitHubReviewWriter> = {}) {
  const writes: Array<string> = [];
  return {
    writes,
    gateway: {
      async getPullRequest() { return { _tag: "ok" as const, value: { headSha: currentHead } }; },
      async createPendingReview(input: Parameters<GitHubReviewWriter["createPendingReview"]>[0]) {
        writes.push(`create:${input.comments.length}`);
        return writer.createPendingReview === undefined ? { _tag: "ok" as const, value: { reviewId: "9001", state: "PENDING" as const } } : writer.createPendingReview(input);
      },
      async submitPendingReview(input: Parameters<GitHubReviewWriter["submitPendingReview"]>[0]) {
        writes.push(`submit:${input.event}`);
        return writer.submitPendingReview === undefined ? { _tag: "ok" as const, value: { reviewId: input.reviewId } } : writer.submitPendingReview(input);
      },
    },
  };
}

const profile = { githubHost: "github.com", ghAccount: "pmquan2cfw" } as never;
const now = "2026-07-16T00:01:00.000Z" as never;

describe("review submission service", () => {
  it("persists a partial failure after GitHub rejects a confirmed batch operation", async () => {
    const persisted: ReviewSession[] = [];
    const batch = {
      sessionId: session.id,
      attemptId: "001" as never,
      state: { _tag: "Local" as const },
      summaryBody: "Review summary",
      suggestedEvent: "COMMENT" as const,
      items: [{ _tag: "InlineComment" as const, id: "comment" as never, source: "manual" as const, anchor: { path: "a.ts" as never, startLine: 1, line: 1, side: "new" as const }, body: "Keep this.", include: true, postability: "postable" as const }],
      receipts: [],
      createdAt: now,
      updatedAt: now,
    };
    const result = await applyReviewBatch({
      profile,
      session,
      batch: batch as never,
      now,
      persist: async (next) => {
        persisted.push(next);
        return true;
      },
      gateway: {
        async getPullRequest() { return { _tag: "ok" as const, value: { headSha } }; },
        async createPendingReview() { return { _tag: "err" as const, error: { category: "rejected" as const, message: "Line is no longer in the diff." } }; },
        async submitPendingReview() { return { _tag: "ok" as const, value: { reviewId: "unused" } }; },
      } as never,
    });

    expect(result).toMatchObject({ _tag: "err", error: { _tag: "BatchWriteRejected", batch: { state: { _tag: "PartialFailure", failure: { category: "rejected" } } } } });
    expect(persisted).toHaveLength(2);
    expect(persisted.at(-1)).toMatchObject({ batchContent: { state: { _tag: "PartialFailure", failure: { message: "Line is no longer in the diff." } } } });
  });

  it("sends a manual inline range with its first and last lines in GitHub order", async () => {
    let sent: { readonly line: number; readonly lineEnd?: number } | undefined;
    const batch = {
      sessionId: session.id,
      attemptId: "001" as never,
      state: { _tag: "Local" as const },
      summaryBody: "Review summary",
      suggestedEvent: "COMMENT" as const,
      items: [{ _tag: "InlineComment" as const, id: "range" as never, source: "manual" as const, anchor: { path: "a.ts" as never, startLine: 4, line: 6, side: "new" as const }, body: "Keep the guard.", include: true, postability: "postable" as const }],
      receipts: [],
      createdAt: now,
      updatedAt: now,
    };
    await applyReviewBatch({
      profile,
      session,
      batch: batch as never,
      now,
      persist: async () => true,
      gateway: {
        async getPullRequest() { return { _tag: "ok" as const, value: { headSha } }; },
        async createPendingReview(input: { readonly comments: ReadonlyArray<PendingReviewComment> }) {
          sent = input.comments[0];
          return { _tag: "ok" as const, value: { reviewId: "9001", state: "PENDING" as const } };
        },
        async submitPendingReview() { return { _tag: "ok" as const, value: { reviewId: "unused" } }; },
      } as never,
    });
    expect(sent).toMatchObject({ line: 4, lineEnd: 6 });
  });

  it("completes a reply-only batch without creating a pending review", async () => {
    const writes: string[] = [];
    const batch = { sessionId: session.id, attemptId: "001" as never, state: { _tag: "Local" as const }, summaryBody: "", suggestedEvent: "COMMENT" as const, items: [{ _tag: "ThreadReply" as const, id: "reply" as never, threadId: "thread-1" as never, body: "Fixed.", include: true }], receipts: [], createdAt: now, updatedAt: now };
    const result = await applyReviewBatch({ profile, session, batch: batch as never, now, persist: async () => true, gateway: { async getPullRequest() { return { _tag: "ok" as const, value: { headSha } }; }, async createPendingReview() { writes.push("create"); return { _tag: "ok" as const, value: { reviewId: "9001", state: "PENDING" as const } }; }, async submitPendingReview() { return { _tag: "ok" as const, value: { reviewId: "9001" } }; }, async createThreadReply() { writes.push("reply"); return { _tag: "ok" as const, value: { commentId: "comment-1" } }; } } as never });
    expect(result).toMatchObject({ _tag: "ok", value: { batch: { state: { _tag: "Completed" }, receipts: [{ _tag: "ReplyCreated" }] } } });
    expect(writes).toEqual(["reply"]);
  });
  it("plans one pending review before saved replies and thread actions", () => {
    expect(planBatchOperations({
      sessionId: session.id,
      attemptId: "001" as never,
      state: { _tag: "Local" }, summaryBody: "Review summary", suggestedEvent: "COMMENT",
      items: [
        { _tag: "InlineComment", id: "one" as never, source: "manual", anchor: { path: "a.ts" as never, startLine: 1, line: 1, side: "new" }, body: "a", include: true, postability: "postable" },
        { _tag: "ThreadReply", id: "reply" as never, threadId: "thread-1" as never, body: "b", include: true },
        { _tag: "ThreadState", id: "state" as never, threadId: "thread-2" as never, action: "resolve", include: true },
      ], receipts: [], createdAt: now, updatedAt: now,
    })).toEqual([{ _tag: "CreatePendingReview", itemIds: ["one"] }, { _tag: "Reply", itemId: "reply" }, { _tag: "ThreadState", itemId: "state" }]);
  });
  it("rechecks the head immediately before create and blocks a stale write without invoking GitHub", async () => {
    const fake = gateway(movedHeadSha);
    const result = await createPendingReview({ profile, session, draft, gateway: fake.gateway as never, now });
    expect(result).toMatchObject({ _tag: "err", error: { _tag: "StaleHeadBlocksWrite", session: { state: { _tag: "Stale", reason: "head_changed" } } } });
    expect(fake.writes).toEqual([]);
  });

  it("creates one verified pending review with mapped postable comments only", async () => {
    const fake = gateway();
    const result = await createPendingReview({ profile, session, draft, gateway: fake.gateway as never, now });
    expect(result).toMatchObject({ _tag: "ok", value: { draft: { state: { _tag: "PendingGitHubReview", pendingReviewId: "9001", commentCount: 1 } }, session: { draft: { state: { _tag: "PendingGitHubReview" } } } } });
    expect(fake.writes).toEqual(["create:1"]);
  });

  it("retains a rejected batch locally and refuses a second create attempt", async () => {
    const fake = gateway(headSha, { async createPendingReview() { return { _tag: "err" as const, error: { _tag: "GitHubWriteFailure" as const, category: "rejected" as const, message: "GitHub rejected the batch." } }; } });
    const rejected = await createPendingReview({ profile, session, draft, gateway: fake.gateway as never, now });
    expect(rejected).toMatchObject({ _tag: "err", error: { _tag: "GitHubWriteRejected", draft: { state: { _tag: "DraftFailed" } } } });
    if (rejected._tag === "err" && rejected.error._tag === "GitHubWriteRejected") {
      expect(rejected.error.draft.comments.find((comment) => comment.findingId === "mapped")).toMatchObject({ postability: "api_rejected" });
      const retry = await createPendingReview({ profile, session: rejected.error.session, draft: rejected.error.draft, gateway: fake.gateway as never, now });
      expect(retry).toMatchObject({ _tag: "err", error: { _tag: "DraftNotCreatable" } });
    }
    expect(fake.writes).toEqual(["create:1"]);
  });

  it("permits a deliberate local edit to re-arm a failed draft without silently splitting its batch", () => {
    const failed = { ...draft, state: { _tag: "DraftFailed", error: { _tag: "GitHubWriteFailure", category: "rejected", message: "Rejected." } }, comments: draft.comments.map((comment) => comment.findingId === "mapped" ? { ...comment, postability: "api_rejected" as const } : comment) } as ReviewDraft;
    const edited = editFailedDraftComment(failed, "mapped" as never, "Use the guarded path.", now);
    expect(edited).toMatchObject({ _tag: "ok", value: { state: { _tag: "LocalDraft" } } });
    if (edited._tag === "ok") expect(edited.value.comments.find((comment) => comment.findingId === "mapped")).toMatchObject({ body: "Use the guarded path.", postability: "postable" });
  });

  it("submits the one pending review only after another current-head check", async () => {
    const fake = gateway();
    const pending = { ...draft, state: { _tag: "PendingGitHubReview", pendingReviewId: "9001", commentCount: 1 } } as ReviewDraft;
    const result = await submitPendingReview({ profile, session, draft: pending, event: "REQUEST_CHANGES", summaryBody: "Request changes before merge.", gateway: fake.gateway as never, now });
    expect(result).toMatchObject({ _tag: "ok", value: { draft: { state: { _tag: "SubmittedGitHubReview", reviewId: "9001", event: "REQUEST_CHANGES" } }, session: { submittedReview: { reviewId: "9001", event: "REQUEST_CHANGES" } } } });
    if (result._tag === "ok") {
      await expect(submitPendingReview({ profile, session: result.value.session, draft: result.value.draft, event: "REQUEST_CHANGES", summaryBody: "Request changes before merge.", gateway: fake.gateway as never, now })).resolves.toMatchObject({ _tag: "err", error: { _tag: "ReviewAlreadySubmitted" } });
    }
    expect(fake.writes).toEqual(["submit:REQUEST_CHANGES"]);
  });

  it("offers a distinct summary-only submit action without a second inline-comment batch", async () => {
    const fake = gateway();
    const pending = { ...draft, state: { _tag: "PendingGitHubReview", pendingReviewId: "9001", commentCount: 1 } } as ReviewDraft;
    await expect(submitSummaryOnlyPendingReview({ profile, session, draft: pending, summaryBody: "Summary-only review.", gateway: fake.gateway as never, now })).resolves.toMatchObject({ _tag: "ok", value: { draft: { state: { _tag: "SubmittedGitHubReview", event: "COMMENT" } } } });
    expect(fake.writes).toEqual(["submit:COMMENT"]);
  });

  it("rejects blank summaries and invalid events before reading the head or submitting", async () => {
    const fake = gateway();
    const pending = { ...draft, state: { _tag: "PendingGitHubReview", pendingReviewId: "9001", commentCount: 1 } } as ReviewDraft;
    await expect(submitPendingReview({ profile, session, draft: pending, event: "COMMENT", summaryBody: "   ", gateway: fake.gateway as never, now })).resolves.toMatchObject({ _tag: "err", error: { _tag: "InvalidSubmitReview" } });
    await expect(submitPendingReview({ profile, session, draft: pending, event: "PENDING" as never, summaryBody: "summary", gateway: fake.gateway as never, now })).resolves.toMatchObject({ _tag: "err", error: { _tag: "InvalidSubmitReview" } });
    expect(fake.writes).toEqual([]);
  });
});
