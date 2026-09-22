import { StubCredentials } from "./stub-github-credentials";
import { describe, expect, it } from "vitest";

import {
  jsonAnswer,
  noChildProcesses,
  orderedTransport,
} from "./github-transport-doubles";
import { GitHubAdapter } from "../../src/adapters/github/github-adapter";
import type {
  GitHubGraphQlRequest,
  GitHubRequest,
} from "../../src/adapters/github/github-request";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseIsoTimestamp,
  parsePullRequestNumber,
} from "../../src/domain/ids";
import { type Result } from "../../src/domain/result";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";

function mustParse<T, E>(result: Result<T, E>): T {
  if (result._tag === "err") throw new Error("Expected test value to parse");
  return result.value;
}

const profile = mustParse(
  parseWorkspaceProfileConfig({
    id: "acme",
    label: "ACME",
    githubHost: "github.com",
    ghAccount: "octo-dev",
    workspaceRoots: [],
    rulePaths: [],
    repos: [],
  }),
);
const ref = (number: number) => ({
  host: mustParse(parseGitHubHost("github.com")),
  owner: mustParse(parseGitHubOwner("octo-org")),
  repo: mustParse(parseGitHubRepoName("patchdesk")),
  number: mustParse(parsePullRequestNumber(number)),
});
const now = mustParse(parseIsoTimestamp("2026-09-17T10:00:00.000Z"));

/** The recorded request, narrowed to the GraphQL shape this read sends. */
function graphQlRequest(
  request: GitHubRequest | undefined,
): GitHubGraphQlRequest {
  if (request?.kind !== "graphql")
    throw new Error("Expected a GraphQL request");
  return request;
}

describe("GitHub watched pull request reader", () => {
  it("reads every watched pull request in one aliased call", async () => {
    const transport = orderedTransport([
      jsonAnswer({
        data: {
          rateLimit: { remaining: 4000, resetAt: "2026-09-17T11:00:00Z" },
          pr0: {
            pullRequest: {
              state: "MERGED",
              updatedAt: "2026-09-17T09:00:00Z",
              headRefOid: "a".repeat(40),
              reviewDecision: "APPROVED",
              commits: {
                nodes: [
                  { commit: { statusCheckRollup: { state: "SUCCESS" } } },
                ],
              },
            },
          },
          pr1: { pullRequest: null },
        },
      }),
    ]);

    await expect(
      new GitHubAdapter(
        noChildProcesses(),
        new StubCredentials(),
        transport,
      ).readWatchedPullRequests({ profile, refs: [ref(7), ref(8)], now }),
    ).resolves.toEqual({
      _tag: "ok",
      value: [
        {
          ref: ref(7),
          outcome: "readable",
          snapshot: {
            updatedAt: "2026-09-17T09:00:00.000Z",
            headSha: "a".repeat(40),
            reviewState: "approved",
            checks: "passing",
            state: "merged",
          },
        },
        { ref: ref(8), outcome: "absent" },
      ],
    });
    expect(transport.requests).toHaveLength(1);
    const request = graphQlRequest(transport.requests[0]);
    // A string owner and a typed number, per alias, are what the query declares.
    expect(request.variables).toContainEqual({
      kind: "string",
      name: "owner1",
      value: "octo-org",
    });
    expect(request.variables).toContainEqual({
      kind: "typed",
      name: "number1",
      value: 8,
    });
  });

  it("settles readable, absent, and inaccessible aliases independently", async () => {
    const transport = orderedTransport([
      jsonAnswer({
        data: {
          rateLimit: { remaining: 3999, resetAt: "2026-09-17T11:00:00Z" },
          pr0: {
            pullRequest: {
              state: "OPEN",
              updatedAt: "2026-09-17T09:00:00Z",
              headRefOid: "b".repeat(40),
              reviewDecision: null,
              commits: { nodes: [] },
            },
          },
          pr1: { pullRequest: null },
          pr2: null,
        },
        errors: [
          {
            type: "NOT_FOUND",
            path: ["pr2", "pullRequest"],
            message: "Could not resolve to a Repository",
          },
        ],
      }),
    ]);

    await expect(
      new GitHubAdapter(
        noChildProcesses(),
        new StubCredentials(),
        transport,
      ).readWatchedPullRequests({
        profile,
        refs: [ref(7), ref(8), ref(9)],
        now,
      }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: [
        { ref: ref(7), outcome: "readable" },
        { ref: ref(8), outcome: "absent" },
        { ref: ref(9), outcome: "inaccessible" },
      ],
    });
    expect(transport.requests).toHaveLength(1);
  });

  it("answers rate limited without a call while the host's spent limit has not reset", async () => {
    const transport = orderedTransport([
      jsonAnswer({
        data: {
          rateLimit: { remaining: 0, resetAt: "2026-09-17T11:00:00Z" },
          pr0: { pullRequest: null },
        },
      }),
    ]);
    const adapter = new GitHubAdapter(
      noChildProcesses(),
      new StubCredentials(),
      transport,
    );

    await adapter.readWatchedPullRequests({ profile, refs: [ref(7)], now });
    await expect(
      adapter.readWatchedPullRequests({ profile, refs: [ref(7)], now }),
    ).resolves.toEqual({
      _tag: "err",
      error: {
        _tag: "GitHubRateLimited",
        operation: "get_watched_prs",
        resumeAt: "2026-09-17T11:00:00.000Z",
      },
    });
    expect(transport.requests).toHaveLength(1);
  });
});
