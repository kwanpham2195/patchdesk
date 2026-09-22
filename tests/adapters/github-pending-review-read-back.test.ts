import { describe, expect, it } from "vitest";

import { StubCredentials } from "./stub-github-credentials";
import {
  noChildProcesses,
  orderedTransport,
  type HttpTransportDouble,
} from "./github-transport-doubles";
import { GitHubAdapter } from "../../src/adapters/github/github-adapter";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitHubReviewNodeId,
  parsePullRequestNumber,
  parseRepoRelativePath,
} from "../../src/domain/ids";
import type { PullRequestRef } from "../../src/domain/pull-request";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";

/**
 * What a pending-review write accepts as proof that the comment it asked for
 * exists. Identity alone is not proof: a thread whose read-back body or anchor
 * is another comment's leaves the write unreconciled, which is the whole point
 * for a suggestion, whose body and multi-line range are the write (issue #316).
 */

function mustParse<T, E>(
  result:
    | { readonly _tag: "ok"; readonly value: T }
    | { readonly _tag: "err"; readonly error: E },
): T {
  if (result._tag === "err") throw new Error("Expected test value to parse");
  return result.value;
}

const account = "octo-dev";
const headSha = "a".repeat(40);
const reviewNodeId = "PRR_kwDORJzsQM7e6QwJ";
const threadId = "PRRT_kwDORJzsQM0001";
const commentId = "PRRC_kwDORJzsQM7fI2Rd";

const profile = mustParse(
  parseWorkspaceProfileConfig({
    id: "acme",
    label: "ACME",
    githubHost: "github.com",
    ghAccount: account,
    workspaceRoots: [],
    rulePaths: [],
    repos: [],
  }),
);
const pr: PullRequestRef = {
  host: mustParse(parseGitHubHost("github.com")),
  owner: mustParse(parseGitHubOwner("octo-org")),
  repo: mustParse(parseGitHubRepoName("patchdesk")),
  number: mustParse(parsePullRequestNumber(42)),
};

function testAdapter(transport: HttpTransportDouble): GitHubAdapter {
  return new GitHubAdapter(
    noChildProcesses(),
    new StubCredentials(),
    transport,
  );
}

/** The mutation receipt GitHub answers an append with: thread identity only. */
function appendReceipt(): string {
  return JSON.stringify({
    data: {
      addPullRequestReviewThread: {
        thread: {
          id: threadId,
          comments: {
            nodes: [{ id: commentId, body: "Replace these lines." }],
          },
        },
      },
    },
  });
}

function reviewsPayload(): string {
  return JSON.stringify([
    {
      id: 9001,
      node_id: reviewNodeId,
      user: { login: account },
      state: "PENDING",
      commit_id: headSha,
    },
  ]);
}

/** The viewer's pending review as the bounded read-back reports it. */
function threadsPayload(thread: {
  readonly line: number;
  readonly startLine: number;
  readonly body: string;
}): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: threadId,
                isOutdated: false,
                path: "src/review.ts",
                line: thread.line,
                startLine: thread.startLine,
                diffSide: "RIGHT",
                startDiffSide: "RIGHT",
                comments: {
                  nodes: [
                    {
                      id: commentId,
                      body: thread.body,
                      createdAt: "2026-08-09T11:34:50Z",
                      author: { login: account },
                      pullRequestReview: {
                        id: reviewNodeId,
                        state: "PENDING",
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  });
}

const suggestionBody = "Replace these lines.\n\n```suggestion\nguarded();\n```";

async function appendSuggestion(
  transport: HttpTransportDouble,
): ReturnType<GitHubAdapter["addPendingReviewThread"]> {
  return testAdapter(transport).addPendingReviewThread({
    profile,
    pr,
    reviewId: mustParse(parseGitHubReviewNodeId(reviewNodeId)),
    anchor: {
      path: mustParse(parseRepoRelativePath("src/review.ts")),
      startLine: 5,
      line: 9,
      side: "new",
    },
    body: suggestionBody,
  });
}

describe("appending a pending-review thread", () => {
  it("confirms the append against the body and range it wrote", async () => {
    const result = await appendSuggestion(
      orderedTransport([
        appendReceipt(),
        reviewsPayload(),
        threadsPayload({ startLine: 5, line: 9, body: suggestionBody }),
      ]),
    );

    expect(result).toMatchObject({
      _tag: "ok",
      value: { createdThreadId: threadId },
    });
  });

  it("refuses an appended thread whose read-back carries another body and range", async () => {
    const result = await appendSuggestion(
      orderedTransport([
        appendReceipt(),
        reviewsPayload(),
        threadsPayload({ startLine: 7, line: 7, body: "Comment body" }),
      ]),
    );

    expect(result).toMatchObject({
      _tag: "err",
      error: { category: "unavailable" },
    });
  });
});
