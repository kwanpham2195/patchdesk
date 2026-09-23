import { orderedTransport } from "./github-transport-doubles";
import { parseGitHubThreadId, parseGitSha } from "../../src/domain/ids";
import { describe, expect, it, vi } from "vitest";
import {
  created,
  headSha,
  mustParse,
  profile,
  pr,
  testAdapter,
  sent,
  sentArgv,
  golden,
  payload,
  confirmThreadResponse,
} from "./github-adapter-test-support";

describe("GitHubAdapter review creation and read-back writes", () => {
  it("creates a pending review and submits its selected event through JSON stdin", async () => {
    const [createArgv, submitArgv, createPayload, submitPayload] =
      await Promise.all([
        golden("create-pending-review"),
        golden("submit-pending-review"),
        payload("create-pending-review.json"),
        payload("submit-pending-review.json"),
      ]);
    const transport = orderedTransport([
      JSON.stringify({ id: 9001, state: "PENDING" }),
      JSON.stringify({ id: 9001, state: "SUBMITTED" }),
    ]);
    const adapter = testAdapter(transport);

    await expect(
      adapter.createPendingReview({
        profile,
        pr,
        headSha: mustParse(parseGitSha(headSha)),
        summaryBody: "Keep the safety check.",
        comments: [
          {
            body: "Comment body",
            path: "src/review.ts",
            line: 7,
            lineEnd: 9,
            diffSide: "new",
          },
        ],
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { reviewId: "9001", state: "PENDING" },
    });
    await expect(
      adapter.submitPendingReview({
        profile,
        pr,
        reviewId: "9001",
        event: "REQUEST_CHANGES",
        summaryBody: "Request changes before merge.",
      }),
    ).resolves.toEqual({ _tag: "ok", value: { reviewId: "9001" } });

    expect(sentArgv(transport)).toEqual([createArgv, submitArgv]);
    expect(JSON.parse(sent(transport, 0).stdin ?? "{}")).toEqual(
      JSON.parse(createPayload),
    );
    expect(JSON.parse(sent(transport, 1).stdin ?? "{}")).toEqual(
      JSON.parse(submitPayload),
    );
  });

  it("rejects a create response unless GitHub confirms the review is pending", async () => {
    const adapter = testAdapter(
      orderedTransport([JSON.stringify({ id: 9001, state: "SUBMITTED" })]),
    );
    await expect(
      adapter.createPendingReview({
        profile,
        pr,
        headSha: mustParse(parseGitSha(headSha)),
        summaryBody: "summary",
        comments: [
          {
            body: "Comment body",
            path: "src/review.ts",
            line: 7,
            diffSide: "new",
          },
        ],
      }),
    ).resolves.toEqual({
      _tag: "err",
      error: {
        _tag: "GitHubWriteFailure",
        category: "unavailable",
        message: "GitHub did not return a PENDING review.",
      },
    });
  });

  it("uses the same explicit event endpoint for a summary-only submit", async () => {
    const [submitArgv, summaryPayload] = await Promise.all([
      golden("submit-pending-review"),
      payload("submit-summary-only-review.json"),
    ]);
    const transport = orderedTransport([
      JSON.stringify({ id: 9001, state: "SUBMITTED" }),
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.submitPendingReview({
        profile,
        pr,
        reviewId: "9001",
        event: "COMMENT",
        summaryBody: "Summary-only review.",
      }),
    ).resolves.toEqual({ _tag: "ok", value: { reviewId: "9001" } });
    expect(sentArgv(transport)).toEqual([submitArgv]);
    expect(JSON.parse(sent(transport, 0).stdin ?? "{}")).toEqual(
      JSON.parse(summaryPayload),
    );
  });

  it("deletes a review comment through GitHub's id argument", async () => {
    const transport = orderedTransport([
      JSON.stringify({
        data: { deletePullRequestReviewComment: { clientMutationId: "1" } },
      }),
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.deleteThreadComment({ profile, commentId: "PRRC_abc" }),
    ).resolves.toEqual({ _tag: "ok", value: undefined });
    // GitHub rejects DeletePullRequestReviewCommentInput with a
    // pullRequestReviewCommentId argument; the mutation must pass id.
    const request = sent(transport, 0).argv.join(" ");
    expect(request).toContain("deletePullRequestReviewComment(input:{id:$");
    expect(request).not.toContain("pullRequestReviewCommentId");
  });

  it("exposes the review a reply submits so the write journal can exclude it", async () => {
    const transport = orderedTransport([
      JSON.stringify({
        data: {
          addPullRequestReviewThreadReply: {
            comment: {
              id: "PRRC_reply",
              pullRequestReview: { id: "PRR_review" },
            },
          },
        },
      }),
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.createThreadReply({
        profile,
        threadId: mustParse(parseGitHubThreadId("PRRT_thread")),
        body: "A reply",
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { commentId: "PRRC_reply", reviewId: "PRR_review" },
    });
    const request = sent(transport, 0).argv.join(" ");
    expect(request).toContain("pullRequestReview{id}");
  });

  it("retries the read-back with backoff before confirming a thread", async () => {
    vi.useFakeTimers();
    try {
      const restResponse = JSON.stringify({ node_id: "PRRC_comment" });
      const noMatchYet = confirmThreadResponse([]);
      const nowConfirmed = confirmThreadResponse([
        {
          id: "PRRT_thread",
          comments: [{ id: "PRRC_comment", body: "Body" }],
        },
      ]);
      const transport = orderedTransport([
        restResponse,
        noMatchYet,
        nowConfirmed,
      ]);
      const adapter = testAdapter(transport);
      const pending = adapter.createInlineComment({
        profile,
        pr,
        headSha: mustParse(parseGitSha(headSha)),
        coordinates: { path: "src/a.ts", line: 5, side: "RIGHT" },
        body: "Body",
      });
      await vi.advanceTimersByTimeAsync(500);
      await expect(pending).resolves.toEqual({
        _tag: "ok",
        value: { ...created, threadId: "PRRT_thread" },
      });
      expect(transport.requests).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not upgrade when a matching comment id has a different body, and exhausts all attempts", async () => {
    vi.useFakeTimers();
    try {
      const restResponse = JSON.stringify({ node_id: "PRRC_comment" });
      const idMatchWrongBody = confirmThreadResponse([
        {
          id: "PRRT_thread",
          comments: [{ id: "PRRC_comment", body: "A different body" }],
        },
      ]);
      const transport = orderedTransport([
        restResponse,
        idMatchWrongBody,
        idMatchWrongBody,
        idMatchWrongBody,
      ]);
      const adapter = testAdapter(transport);
      const pending = adapter.createInlineComment({
        profile,
        pr,
        headSha: mustParse(parseGitSha(headSha)),
        coordinates: { path: "src/a.ts", line: 5, side: "RIGHT" },
        body: "Body",
      });
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(1500);
      await expect(pending).resolves.toEqual({ _tag: "ok", value: created });
      expect(transport.requests).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("degrades the create receipt without upgrading when all read-back attempts are exhausted", async () => {
    vi.useFakeTimers();
    try {
      const restResponse = JSON.stringify({ node_id: "PRRC_comment" });
      const noMatch = confirmThreadResponse([]);
      const transport = orderedTransport([
        restResponse,
        noMatch,
        noMatch,
        noMatch,
      ]);
      const adapter = testAdapter(transport);
      const pending = adapter.createInlineComment({
        profile,
        pr,
        headSha: mustParse(parseGitSha(headSha)),
        coordinates: { path: "src/a.ts", line: 5, side: "RIGHT" },
        body: "Body",
      });
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(1500);
      await expect(pending).resolves.toEqual({ _tag: "ok", value: created });
      expect(transport.requests).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
