import { orderedTransport } from "./github-transport-doubles";
import { describe, expect, it } from "vitest";
import {
  profile,
  pr,
  testAdapter,
  sent,
  payload,
} from "./github-adapter-test-support";

describe("GitHubAdapter review-thread reads", () => {
  it("normalizes GitHub's degenerate single-line LEFT thread anchor", async () => {
    // GitHub reports single-line LEFT-side threads with startLine = line + 1;
    // the adapter must anchor them to the one old-side line instead of an
    // inverted range that the Diff mapping would reject.
    const fixture = JSON.parse(await payload("get-comments.json"));
    fixture.data.repository.pullRequest.reviewThreads.nodes[0] = {
      id: "thread-left",
      isResolved: false,
      isOutdated: false,
      path: "src/review.ts",
      line: 43,
      startLine: 44,
      diffSide: "LEFT",
      startDiffSide: null,
      originalLine: 43,
      comments: {
        nodes: [
          {
            id: "comment-left",
            body: "Old side single line.",
            createdAt: "2026-07-16T12:00:00Z",
            updatedAt: null,
            url: "https://example.test/comment/left",
            author: { login: "reviewer" },
            path: "src/review.ts",
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
    const transport = orderedTransport([JSON.stringify(fixture)]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.getPullRequestComments({ profile, pr }),
    ).resolves.toEqual({
      _tag: "ok",
      value: {
        complete: true,
        threads: [
          {
            complete: true,
            id: "thread-left",
            state: "open",
            location: { path: "src/review.ts", line: 43, diffSide: "old" },
            comments: [
              expect.objectContaining({
                id: "comment-left",
                location: { path: "src/review.ts", line: 43, diffSide: "old" },
              }),
            ],
          },
        ],
      },
    });
  });

  it("paginates review threads and retains their server ordering", async () => {
    const first = JSON.parse(await payload("get-comments.json"));
    const second = structuredClone(first);
    first.data.repository.pullRequest.reviewThreads.pageInfo = {
      hasNextPage: true,
      endCursor: "threads-page-2",
    };
    second.data.repository.pullRequest.reviewThreads.nodes[0].id = "thread-2";
    second.data.repository.pullRequest.reviewThreads.nodes[0].comments.nodes[0].id =
      "comment-2";
    second.data.repository.pullRequest.reviewThreads.pageInfo = {
      hasNextPage: false,
      endCursor: null,
    };
    const transport = orderedTransport([
      JSON.stringify(first),
      JSON.stringify(second),
    ]);
    const adapter = testAdapter(transport);

    await expect(
      adapter.getPullRequestComments({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: {
        complete: true,
        threads: [{ id: "thread-1" }, { id: "thread-2" }],
      },
    });
    expect(sent(transport, 1).argv).toContain("cursor=threads-page-2");
  });

  it("marks a repeated review-thread cursor incomplete", async () => {
    const first = JSON.parse(await payload("get-comments.json"));
    const second = structuredClone(first);
    first.data.repository.pullRequest.reviewThreads.pageInfo = {
      hasNextPage: true,
      endCursor: "repeat",
    };
    second.data.repository.pullRequest.reviewThreads.pageInfo = {
      hasNextPage: true,
      endCursor: "repeat",
    };
    const adapter = testAdapter(
      orderedTransport([JSON.stringify(first), JSON.stringify(second)]),
    );

    await expect(
      adapter.getPullRequestComments({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { complete: false, incompleteReason: "pagination" },
    });
  });

  it("loads a second reply page and preserves earlier replies", async () => {
    const outer = JSON.parse(await payload("get-comments.json"));
    outer.data.repository.pullRequest.reviewThreads.nodes[0].comments.pageInfo =
      { hasNextPage: true, endCursor: "replies-page-2" };
    const replies = {
      data: {
        node: {
          comments: {
            nodes: [
              {
                id: "comment-2",
                body: "A later reply.",
                createdAt: "2026-07-16T12:01:00Z",
                updatedAt: null,
                url: "https://example.test/comment/2",
                author: { login: "reviewer" },
                path: "src/review.ts",
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    };
    const transport = orderedTransport([
      JSON.stringify(outer),
      JSON.stringify(replies),
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.getPullRequestComments({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: {
        complete: true,
        threads: [
          {
            complete: true,
            comments: [{ id: "comment-1" }, { id: "comment-2" }],
          },
        ],
      },
    });
    expect(sent(transport, 1).argv).toContain("cursor=replies-page-2");
  });

  it("marks a failed reply page incomplete and preserves earlier replies", async () => {
    const outer = JSON.parse(await payload("get-comments.json"));
    outer.data.repository.pullRequest.reviewThreads.nodes[0].comments.pageInfo =
      { hasNextPage: true, endCursor: "replies-page-2" };
    const transport = orderedTransport([
      JSON.stringify(outer),
      { _tag: "CommandFailed" },
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.getPullRequestComments({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: {
        complete: false,
        incompleteReason: "comment_cap",
        threads: [{ complete: false, comments: [{ id: "comment-1" }] }],
      },
    });
  });

  it("stops after the bounded review-thread page cap", async () => {
    const fixture = JSON.parse(await payload("get-comments.json"));
    const responses = Array.from({ length: 10 }, (_, index) => {
      const page = structuredClone(fixture);
      page.data.repository.pullRequest.reviewThreads.pageInfo = {
        hasNextPage: true,
        endCursor: `page-${index}`,
      };
      return JSON.stringify(page);
    });
    const adapter = testAdapter(orderedTransport(responses));

    await expect(
      adapter.getPullRequestComments({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { complete: false, incompleteReason: "thread_cap" },
    });
  });
});
