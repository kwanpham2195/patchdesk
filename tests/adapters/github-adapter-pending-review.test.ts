import { orderedTransport } from "./github-transport-doubles";
import {
  parseGitHubLogin,
  parseGitHubReviewNodeId,
  parseGitSha,
  parseRepoRelativePath,
} from "../../src/domain/ids";
import { describe, expect, it } from "vitest";
import {
  headSha,
  mustParse,
  profile,
  pr,
  testAdapter,
  sent,
} from "./github-adapter-test-support";

import {
  account,
  commentId,
  reviewId,
  reviewListUrl,
  reviewNodeId,
  reviewsPayload,
  threadId,
  threadNode,
  threadsPayload,
} from "./github-adapter-pending-review-test-support";

describe("GitHubAdapter pending-review gateway", () => {
  it("returns None only for a complete result with no viewer pending review", async () => {
    const transport = orderedTransport([
      JSON.stringify([
        {
          id: 1,
          state: "COMMENTED",
          user: { login: "other" },
          submitted_at: "2026-08-08T00:00:00Z",
        },
      ]),
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.getViewerPendingReview({
        profile,
        pr,
        account: mustParse(parseGitHubLogin(account)),
      }),
    ).resolves.toEqual({ _tag: "ok", value: { _tag: "None" } });
    expect(sent(transport, 0).argv).toContain(reviewListUrl);
  });

  it("imports the viewer's pending review with complete bounded thread/comment identity", async () => {
    const transport = orderedTransport([reviewsPayload(), threadsPayload()]);
    const adapter = testAdapter(transport);
    const result = await adapter.getViewerPendingReview({
      profile,
      pr,
      account: mustParse(parseGitHubLogin(account)),
    });
    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    expect(result.value).toMatchObject({
      _tag: "Pending",
      review: {
        restId: "9001",
        nodeId: reviewNodeId,
        author: account,
        headSha,
        comments: [
          { reviewCommentId: commentId, threadId, body: "Comment body" },
        ],
      },
    });
    // The GraphQL probe selects the owning review so the adapter can prove
    // which threads belong to the PENDING review.
    expect(sent(transport, 1).argv.join(" ")).toContain(
      "pullRequestReview { id state }",
    );
  });

  it("normalizes GitHub's inverted LEFT single-line range", async () => {
    const threads = threadsPayload({
      node: threadNode({
        startLine: 8,
        diffSide: "LEFT",
        startDiffSide: undefined,
      }),
    });
    const transport = orderedTransport([reviewsPayload(), threads]);
    const adapter = testAdapter(transport);
    const result = await adapter.getViewerPendingReview({
      profile,
      pr,
      account: mustParse(parseGitHubLogin(account)),
    });
    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    expect(result.value._tag).toBe("Pending");
    if (result.value._tag !== "Pending") return;
    expect(result.value.review.comments[0]?.anchor).toEqual({
      path: "src/review.ts",
      startLine: 7,
      line: 7,
      side: "old",
    });
  });

  it("treats a foreign-author thread as non-actionable", async () => {
    const threads = threadsPayload({
      node: threadNode({
        startDiffSide: undefined,
        comments: {
          nodes: [
            {
              id: commentId,
              body: "Comment body",
              createdAt: "2026-08-09T11:34:50Z",
              author: { login: "other" },
              pullRequestReview: { id: reviewNodeId, state: "PENDING" },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
    });
    const transport = orderedTransport([reviewsPayload(), threads]);
    const adapter = testAdapter(transport);
    // No actionable comments: an empty pending review is the unproven case.
    await expect(
      adapter.getViewerPendingReview({
        profile,
        pr,
        account: mustParse(parseGitHubLogin(account)),
      }),
    ).resolves.toMatchObject({ _tag: "err" });
  });

  it("treats a thread from a non-pending review as non-actionable", async () => {
    const transport = orderedTransport([
      reviewsPayload(),
      threadsPayload({
        node: threadNode({
          comments: {
            nodes: [
              {
                id: commentId,
                body: "Comment body",
                createdAt: "2026-08-09T11:34:50Z",
                author: { login: account },
                pullRequestReview: { id: reviewNodeId, state: "COMMENTED" },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }),
      }),
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.getViewerPendingReview({
        profile,
        pr,
        account: mustParse(parseGitHubLogin(account)),
      }),
    ).resolves.toMatchObject({ _tag: "err" });
  });

  it("fails closed when the review list reaches the full-page boundary", async () => {
    const fullReviews = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      state: "COMMENTED",
      user: { login: "other" },
      submitted_at: "2026-08-08T00:00:00Z",
    }));
    const adapter = testAdapter(
      orderedTransport([JSON.stringify(fullReviews)]),
    );
    await expect(
      adapter.getViewerPendingReview({
        profile,
        pr,
        account: mustParse(parseGitHubLogin(account)),
      }),
    ).resolves.toMatchObject({ _tag: "err" });
  });

  it("fails closed when review-thread pagination is incomplete", async () => {
    const adapter = testAdapter(
      orderedTransport([
        reviewsPayload(),
        threadsPayload({
          pageInfo: { hasNextPage: true, endCursor: "cursor" },
        }),
      ]),
    );
    await expect(
      adapter.getViewerPendingReview({
        profile,
        pr,
        account: mustParse(parseGitHubLogin(account)),
      }),
    ).resolves.toMatchObject({ _tag: "err" });
  });

  it("fails closed when the review-list response is malformed JSON", async () => {
    const adapter = testAdapter(
      orderedTransport(["{not-json", threadsPayload()]),
    );
    await expect(
      adapter.getViewerPendingReview({
        profile,
        pr,
        account: mustParse(parseGitHubLogin(account)),
      }),
    ).resolves.toMatchObject({ _tag: "err" });
  });

  it("starts a review with its first thread and reads the full owner back", async () => {
    const transport = orderedTransport([
      // GitHub's live create-review response does not include the created
      // inline comment. Exact thread identity must come from read-back.
      JSON.stringify({
        id: reviewId,
        node_id: reviewNodeId,
        state: "PENDING",
        commit_id: headSha,
      }),
      reviewsPayload(),
      threadsPayload(),
    ]);
    const adapter = testAdapter(transport);
    const result = await adapter.startPendingReviewWithThread({
      profile,
      pr,
      headSha: mustParse(parseGitSha(headSha)),
      anchor: {
        path: mustParse(parseRepoRelativePath("src/review.ts")),
        startLine: 7,
        line: 7,
        side: "new",
      },
      body: "Comment body",
    });
    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    expect(result.value.review.restId).toBe("9001");
    expect(result.value.createdThreadId).toBe(threadId);
    // REST Start owns the inline comment; Finish owns general feedback.
    expect(JSON.parse(sent(transport, 0).stdin ?? "{}")).toEqual({
      commit_id: headSha,
      comments: [
        { path: "src/review.ts", line: 7, side: "RIGHT", body: "Comment body" },
      ],
    });
    expect(JSON.parse(sent(transport, 0).stdin ?? "{}")).not.toHaveProperty(
      "body",
    );
  });

  it("never fabricates a pending owner when the create read-back cannot be proven", async () => {
    const missingRead = testAdapter(
      orderedTransport([
        JSON.stringify({
          id: reviewId,
          node_id: reviewNodeId,
          state: "PENDING",
          commit_id: headSha,
          comments: [{ node_id: commentId }],
        }),
        "[]",
      ]),
    );
    const result = await missingRead.startPendingReviewWithThread({
      profile,
      pr,
      headSha: mustParse(parseGitSha(headSha)),
      anchor: {
        path: mustParse(parseRepoRelativePath("src/review.ts")),
        startLine: 7,
        line: 7,
        side: "new",
      },
      body: "Comment body",
    });
    expect(result).toMatchObject({
      _tag: "err",
      error: { category: "unavailable" },
    });
  });

  it("appends a thread through the spike-proven GraphQL mutation and reads back", async () => {
    const transport = orderedTransport([
      JSON.stringify({
        data: {
          addPullRequestReviewThread: {
            thread: {
              id: threadId,
              path: "src/review.ts",
              line: 7,
              startLine: 7,
              diffSide: "RIGHT",
              comments: {
                nodes: [{ id: commentId, body: "Comment body" }],
              },
            },
          },
        },
      }),
      reviewsPayload(),
      threadsPayload(),
    ]);
    const adapter = testAdapter(transport);
    const result = await adapter.addPendingReviewThread({
      profile,
      pr,
      reviewId: mustParse(parseGitHubReviewNodeId(reviewNodeId)),
      anchor: {
        path: mustParse(parseRepoRelativePath("src/review.ts")),
        startLine: 7,
        line: 7,
        side: "new",
      },
      body: "Comment body",
    });
    expect(result._tag).toBe("ok");
    const request = sent(transport, 0).argv.join(" ");
    expect(request).toContain("addPullRequestReviewThread");
    expect(request).toContain("pullRequestReviewId:$reviewId");
  });

  it("keeps pageInfo inside the comments connection in the AddThread selection", async () => {
    // PullRequestReviewThread has no pageInfo field; the old
    // `comments(first:100){nodes{id body}} pageInfo{hasNextPage}` shape made
    // GitHub reject the mutation at schema validation (409 github_rejected)
    // before any execution. The query must nest pageInfo under comments.
    const transport = orderedTransport([
      JSON.stringify({
        data: {
          addPullRequestReviewThread: {
            thread: {
              id: threadId,
              path: "src/review.ts",
              line: 7,
              startLine: 7,
              diffSide: "RIGHT",
              comments: {
                nodes: [{ id: commentId, body: "Comment body" }],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      }),
      reviewsPayload(),
      threadsPayload(),
    ]);
    const adapter = testAdapter(transport);
    const result = await adapter.addPendingReviewThread({
      profile,
      pr,
      reviewId: mustParse(parseGitHubReviewNodeId(reviewNodeId)),
      anchor: {
        path: mustParse(parseRepoRelativePath("src/review.ts")),
        startLine: 7,
        line: 7,
        side: "new",
      },
      body: "Comment body",
    });
    expect(result._tag).toBe("ok");
    const request = sent(transport, 0).argv.join(" ");
    expect(request).toContain(
      "comments(first:100){nodes{id body} pageInfo{hasNextPage}}",
    );
    expect(request).not.toMatch(/nodes\{id body\}\} pageInfo/);
    expect(request).toContain("diffSide");
  });

  it("rejects an append whose mutation response lacks thread identity", async () => {
    const adapter = testAdapter(
      orderedTransport([
        JSON.stringify({
          data: {
            addPullRequestReviewThread: {
              thread: { id: "PRRT_ok", comments: { nodes: [] } },
            },
          },
        }),
      ]),
    );
    const result = await adapter.addPendingReviewThread({
      profile,
      pr,
      reviewId: mustParse(parseGitHubReviewNodeId(reviewNodeId)),
      anchor: {
        path: mustParse(parseRepoRelativePath("src/review.ts")),
        startLine: 9,
        line: 9,
        side: "new",
      },
      body: "More",
    });
    expect(result).toMatchObject({
      _tag: "err",
      error: { category: "unavailable" },
    });
  });

  it("isolates the viewer's pending review from a foreign account", async () => {
    const transport = orderedTransport([reviewsPayload()]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.getViewerPendingReview({
        profile,
        pr,
        account: mustParse(parseGitHubLogin("other")),
      }),
    ).resolves.toEqual({ _tag: "ok", value: { _tag: "None" } });
  });
});
