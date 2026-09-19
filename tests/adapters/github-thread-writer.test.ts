import { StubCredentials } from "./stub-github-credentials";
import { describe, expect, it } from "vitest";

import {
  jsonAnswer,
  noChildProcesses,
  orderedTransport,
  type HttpTransportDouble,
} from "./github-transport-doubles";
import { GitHubAdapter } from "../../src/adapters/github/github-adapter";
import type {
  GitHubRequest,
  GitHubRestRequest,
} from "../../src/adapters/github/github-request";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parsePullRequestNumber,
} from "../../src/domain/ids";
import type { PullRequestRef } from "../../src/domain/pull-request";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";

function mustParse<T, E>(
  result:
    | { readonly _tag: "ok"; readonly value: T }
    | { readonly _tag: "err"; readonly error: E },
): T {
  if (result._tag === "err") throw new Error("Expected test value to parse");
  return result.value;
}

const profile = mustParse(
  parseWorkspaceProfileConfig({
    id: "cfw",
    label: "CFW",
    githubHost: "github.com",
    ghAccount: "pmquan2cfw",
    workspaceRoots: [],
    rulePaths: [],
    repos: [],
  }),
);
const pr: PullRequestRef = {
  host: mustParse(parseGitHubHost("github.com")),
  owner: mustParse(parseGitHubOwner("centraldigital")),
  repo: mustParse(parseGitHubRepoName("patchdesk")),
  number: mustParse(parsePullRequestNumber(42)),
};
const headSha = mustParse(
  parseGitSha("abcdef1234567890abcdef1234567890abcdef12"),
);

function testAdapter(transport: HttpTransportDouble): GitHubAdapter {
  return new GitHubAdapter(
    noChildProcesses(),
    new StubCredentials(),
    transport,
  );
}

/** The recorded request, narrowed to the REST shape these writes send. */
function restRequest(request: GitHubRequest | undefined): GitHubRestRequest {
  if (request?.kind !== "rest") throw new Error("Expected a REST request");
  return request;
}

function confirmThreadResponse(): string {
  return jsonAnswer({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: "PRRT_thread",
                isResolved: false,
                isOutdated: false,
                comments: {
                  nodes: [
                    {
                      id: "PRRC_comment",
                      body: "Body",
                      createdAt: "2026-08-17T00:00:00Z",
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  });
}

describe("GitHubThreadWriter REST receipts", () => {
  it("returns the REST comment id while using the node id to confirm its thread", async () => {
    const transport = orderedTransport([
      jsonAnswer({
        id: 201,
        node_id: "PRRC_comment",
        pull_request_review_id: 42,
      }),
      confirmThreadResponse(),
    ]);

    await expect(
      testAdapter(transport).createInlineComment({
        profile,
        pr,
        headSha,
        coordinates: { path: "src/a.ts", line: 5, side: "RIGHT" },
        body: "Body",
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: {
        commentId: "201",
        reviewId: "42",
        threadId: "PRRT_thread",
      },
    });
  });

  it("accepts GitHub's empty 204 response when deleting a published comment", async () => {
    const transport = orderedTransport([""]);

    await expect(
      testAdapter(transport).deleteReviewComment({
        profile,
        pr,
        commentId: "3888149868",
      }),
    ).resolves.toEqual({ _tag: "ok", value: undefined });
    const request = restRequest(transport.requests[0]);
    expect(request.method).toBe("DELETE");
    expect(request.path).toBe(
      "repos/centraldigital/patchdesk/pulls/comments/3888149868",
    );
  });
});
