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
} from "../../src/domain/ids";
import { type Result } from "../../src/domain/result";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";

function mustParse<T, E>(result: Result<T, E>): T {
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
const repo = {
  host: mustParse(parseGitHubHost("github.com")),
  owner: mustParse(parseGitHubOwner("centraldigital")),
  repo: mustParse(parseGitHubRepoName("patchdesk")),
};

/** The recorded request, narrowed to the GraphQL shape these reads send. */
function graphQlRequest(
  request: GitHubRequest | undefined,
): GitHubGraphQlRequest {
  if (request?.kind !== "graphql")
    throw new Error("Expected a GraphQL request");
  return request;
}

describe("GitHub base-branch adapter", () => {
  it("lists branch names with the search passed as a raw string", async () => {
    const transport = orderedTransport([
      jsonAnswer({
        data: {
          rateLimit: { remaining: 4000, resetAt: "2026-09-17T10:00:00Z" },
          repository: {
            refs: {
              totalCount: 140,
              nodes: [{ name: "release/1.2" }, { name: "release/1.3" }],
            },
          },
        },
      }),
    ]);

    await expect(
      new GitHubAdapter(
        noChildProcesses(),
        new StubCredentials(),
        transport,
      ).listRepositoryBranches({ profile, repo, query: "1" }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { branches: ["release/1.2", "release/1.3"], totalCount: 140 },
    });
    const request = graphQlRequest(transport.requests[0]);
    expect(request.host).toBe("github.com");
    expect(request.variables).toContainEqual({
      kind: "typed",
      name: "owner",
      value: "centraldigital",
    });
    expect(request.variables).toContainEqual({
      kind: "typed",
      name: "name",
      value: "patchdesk",
    });
    // A string variable is what keeps a numeric-looking search a GraphQL String.
    expect(request.variables).toContainEqual({
      kind: "string",
      name: "search",
      value: "1",
    });
  });

  it("omits the search variable when the query is empty", async () => {
    const transport = orderedTransport([
      jsonAnswer({
        data: { repository: { refs: { totalCount: 0, nodes: [] } } },
      }),
    ]);

    await new GitHubAdapter(
      noChildProcesses(),
      new StubCredentials(),
      transport,
    ).listRepositoryBranches({ profile, repo, query: "" });
    expect(
      graphQlRequest(transport.requests[0]).variables.some(
        (variable) => variable.name === "search",
      ),
    ).toBe(false);
  });

  it("sends updatePullRequest with the branch as a raw string", async () => {
    const transport = orderedTransport([
      jsonAnswer({ data: { updatePullRequest: { clientMutationId: null } } }),
    ]);

    await expect(
      new GitHubAdapter(
        noChildProcesses(),
        new StubCredentials(),
        transport,
      ).setPullRequestBaseBranch({
        profile,
        pullRequestId: "PR_node",
        branch: "2026",
      }),
    ).resolves.toEqual({ _tag: "ok", value: undefined });
    const request = graphQlRequest(transport.requests[0]);
    expect(request.document).toContain(
      "updatePullRequest(input: { pullRequestId: $pullRequestId, baseRefName: $baseRefName })",
    );
    expect(request.variables).toContainEqual({
      kind: "typed",
      name: "pullRequestId",
      value: "PR_node",
    });
    expect(request.variables).toContainEqual({
      kind: "string",
      name: "baseRefName",
      value: "2026",
    });
  });
});
