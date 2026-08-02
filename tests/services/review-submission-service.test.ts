import { describe, expect, it } from "vitest";

import type { GitHubReviewWriter, PendingReviewComment } from "../../src/adapters/github/github-adapter";
import type { ReviewSession } from "../../src/domain/review-session";
import {
  planBatchOperations,
  applyReviewBatch,
  submitReviewBatch,
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
      items: [{ _tag: "InlineComment" as const, id: "comment" as never, provenance: { _tag: "human" as const }, source: "manual" as const, anchor: { path: "a.ts" as never, startLine: 1, line: 1, side: "new" as const }, body: "Keep this.", include: true, postability: "postable" as const }],
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
      items: [{ _tag: "InlineComment" as const, id: "range" as never, provenance: { _tag: "human" as const }, source: "manual" as const, anchor: { path: "a.ts" as never, startLine: 4, line: 6, side: "new" as const }, body: "Keep the guard.", include: true, postability: "postable" as const }],
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
    const batch = { sessionId: session.id, attemptId: "001" as never, state: { _tag: "Local" as const }, summaryBody: "", suggestedEvent: "COMMENT" as const, items: [{ _tag: "ThreadReply" as const, id: "reply" as never, provenance: { _tag: "human" as const }, threadId: "thread-1" as never, body: "Fixed.", include: true }], receipts: [], createdAt: now, updatedAt: now };
    const result = await applyReviewBatch({ profile, session, batch: batch as never, now, persist: async () => true, gateway: { async getPullRequest() { return { _tag: "ok" as const, value: { headSha } }; }, async createPendingReview() { writes.push("create"); return { _tag: "ok" as const, value: { reviewId: "9001", state: "PENDING" as const } }; }, async submitPendingReview() { return { _tag: "ok" as const, value: { reviewId: "9001" } }; }, async createThreadReply() { writes.push("reply"); return { _tag: "ok" as const, value: { commentId: "comment-1" } }; } } as never });
    expect(result).toMatchObject({ _tag: "ok", value: { batch: { state: { _tag: "Completed" }, receipts: [{ _tag: "ReplyCreated" }] } } });
    expect(writes).toEqual(["reply"]);
  });

  it("applies stable thread actions from a stale batch and leaves inline drafts pending", async () => {
    const writes: string[] = [];
    const persisted: ReviewSession[] = [];
    const batch = {
      sessionId: session.id,
      state: { _tag: "Local" as const },
      summaryBody: "",
      suggestedEvent: "COMMENT" as const,
      items: [
        { _tag: "InlineComment" as const, id: "inline" as never, provenance: { _tag: "human" as const }, source: "manual" as const, anchor: { path: "a.ts" as never, startLine: 1, line: 1, side: "new" as const }, body: "Check this.", include: true, postability: "postable" as const },
        { _tag: "ThreadReply" as const, id: "reply" as never, provenance: { _tag: "human" as const }, threadId: "thread-1" as never, body: "Fixed in the latest commit.", include: true },
      ],
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
        async getPullRequest() { return { _tag: "ok" as const, value: { headSha: movedHeadSha } }; },
        async createPendingReview() { writes.push("inline"); return { _tag: "ok" as const, value: { reviewId: "unexpected", state: "PENDING" as const } }; },
        async submitPendingReview() { return { _tag: "ok" as const, value: { reviewId: "unused" } }; },
        async createThreadReply() { writes.push("reply"); return { _tag: "ok" as const, value: { commentId: "comment-1" } as const }; },
      } as never,
    });

    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        session: { state: { _tag: "Stale", currentHeadSha: movedHeadSha } },
        batch: {
          state: { _tag: "Local" },
          items: [{ postability: "stale_sha" }, { _tag: "ThreadReply" }],
          receipts: [{ _tag: "ReplyCreated", itemId: "reply" }],
        },
      },
    });
    expect(writes).toEqual(["reply"]);
    expect(persisted.at(-1)).toMatchObject({ batchContent: { state: { _tag: "Local" } } });
  });

  it("rejects included needs-attention drafts before any writer operation", async () => {
    const writes: string[] = [];
    const batch = {
      sessionId: session.id,
      state: { _tag: "Local" as const },
      summaryBody: "Review summary",
      suggestedEvent: "COMMENT" as const,
      items: [
        {
          _tag: "InlineComment" as const,
          id: "unsafe" as never,
          provenance: { _tag: "human" as const },
          source: "manual" as const,
          anchor: { path: "a.ts" as never, startLine: 1, line: 1, side: "new" as const },
          body: "Unsafe draft",
          include: true,
          postability: "needs_attention" as const,
          attention: {
            reason: "missing" as const,
            originalAnchor: { path: "a.ts" as never, startLine: 1, line: 1, side: "new" as const },
          },
        },
        {
          _tag: "ThreadReply" as const,
          id: "reply" as never,
          provenance: { _tag: "human" as const },
          threadId: "thread-1" as never,
          body: "Reply",
          include: true,
        },
      ],
      receipts: [],
      createdAt: now,
      updatedAt: now,
    };
    expect(() => planBatchOperations(batch as never)).toThrow("need attention");
    const result = await applyReviewBatch({
      profile,
      session,
      batch: batch as never,
      now,
      persist: async () => true,
      gateway: {
        async getPullRequest() { return { _tag: "ok" as const, value: { headSha } }; },
        async createPendingReview() { writes.push("inline"); return { _tag: "ok" as const, value: { reviewId: "unused", state: "PENDING" as const } }; },
        async submitPendingReview() { writes.push("submit"); return { _tag: "ok" as const, value: { reviewId: "unused" } }; },
        async createThreadReply() { writes.push("reply"); return { _tag: "ok" as const, value: { commentId: "unused" } }; },
      } as never,
    });
    expect(result).toMatchObject({ _tag: "err", error: { _tag: "NeedsAttentionBlocksWrite" } });
    expect(writes).toEqual([]);
  });

  it("plans one pending review before saved replies and thread actions", () => {
    expect(planBatchOperations({
      sessionId: session.id,
      attemptId: "001" as never,
      state: { _tag: "Local" }, summaryBody: "Review summary", suggestedEvent: "COMMENT",
      items: [
        { _tag: "InlineComment", id: "one" as never, provenance: { _tag: "human" }, source: "manual", anchor: { path: "a.ts" as never, startLine: 1, line: 1, side: "new" }, body: "a", include: true, postability: "postable" },
        { _tag: "ThreadReply", id: "reply" as never, provenance: { _tag: "human" }, threadId: "thread-1" as never, body: "b", include: true },
        { _tag: "ThreadState", id: "state" as never, provenance: { _tag: "human" }, threadId: "thread-2" as never, action: "resolve", include: true },
      ], receipts: [], createdAt: now, updatedAt: now,
    })).toEqual([{ _tag: "CreatePendingReview", itemIds: ["one"] }, { _tag: "Reply", itemId: "reply" }, { _tag: "ThreadState", itemId: "state" }]);
  });
  it("submits the batch's one pending review only after another current-head check", async () => {
    const fake = gateway();
    const batch = {
      sessionId: session.id,
      state: { _tag: "PendingReview" as const, reviewId: "9001" },
      summaryBody: "Request changes before merge.",
      suggestedEvent: "REQUEST_CHANGES" as const,
      items: [],
      receipts: [],
      createdAt: now,
      updatedAt: now,
    };
    const result = await submitReviewBatch({ profile, session, batch: batch as never, event: "REQUEST_CHANGES", gateway: fake.gateway as never, now });
    expect(result).toMatchObject({ _tag: "ok", value: { batch: { state: { _tag: "Submitted", reviewId: "9001", event: "REQUEST_CHANGES" } }, session: { submittedReview: { reviewId: "9001", event: "REQUEST_CHANGES" } } } });
    expect(fake.writes).toEqual(["submit:REQUEST_CHANGES"]);
  });

  it("blocks a stale batch submission before invoking GitHub", async () => {
    const fake = gateway(movedHeadSha);
    const batch = { sessionId: session.id, state: { _tag: "PendingReview" as const, reviewId: "9001" }, summaryBody: "Summary", suggestedEvent: "COMMENT" as const, items: [], receipts: [], createdAt: now, updatedAt: now };
    await expect(submitReviewBatch({ profile, session, batch: batch as never, event: "COMMENT", gateway: fake.gateway as never, now })).resolves.toMatchObject({ _tag: "err", error: { _tag: "StaleHeadBlocksWrite", session: { state: { _tag: "Stale" } } } });
    expect(fake.writes).toEqual([]);
  });

  it("blocks submitting a pending review that includes needs-attention drafts", async () => {
    const fake = gateway();
    const batch = {
      sessionId: session.id,
      state: { _tag: "PendingReview" as const, reviewId: "9001" },
      summaryBody: "Summary",
      suggestedEvent: "COMMENT" as const,
      items: [{
        _tag: "InlineComment" as const,
        id: "unsafe" as never,
        provenance: { _tag: "human" as const },
        source: "manual" as const,
        anchor: { path: "a.ts" as never, startLine: 1, line: 1, side: "new" as const },
        body: "Unsafe draft",
        include: true,
        postability: "needs_attention" as const,
        attention: {
          reason: "missing" as const,
          originalAnchor: { path: "a.ts" as never, startLine: 1, line: 1, side: "new" as const },
        },
      }],
      receipts: [],
      createdAt: now,
      updatedAt: now,
    };

    await expect(submitReviewBatch({
      profile,
      session,
      batch: batch as never,
      event: "COMMENT",
      gateway: fake.gateway as never,
      now,
    })).resolves.toMatchObject({ _tag: "err", error: { _tag: "NeedsAttentionBlocksWrite" } });
    expect(fake.writes).toEqual([]);
  });
});
