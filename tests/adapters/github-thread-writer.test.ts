import { describe, expect, it } from "vitest";

import {
  CommandRunner,
  type CommandExecution,
  type CommandExecutor,
  type CommandFailure,
} from "../../src/adapters/github/command-runner";
import { GitHubAdapter } from "../../src/adapters/github/github-adapter";
import type { GitHubCredentials } from "../../src/adapters/github/github-credentials";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parsePullRequestNumber,
} from "../../src/domain/ids";
import type { PullRequestRef } from "../../src/domain/pull-request";
import { ok, type Result } from "../../src/domain/result";
import {
  parseWorkspaceProfileConfig,
  type WorkspaceProfileConfig,
} from "../../src/domain/workspace-profile";

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
    ownerFilters: ["centraldigital"],
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

class FakeProcessExecutor implements CommandExecutor {
  readonly requests: Array<ReadonlyArray<string>> = [];

  constructor(private readonly responses: ReadonlyArray<CommandExecution>) {}

  async execute(input: {
    readonly argv: ReadonlyArray<string>;
  }): Promise<CommandExecution> {
    this.requests.push(input.argv);
    const response = this.responses[this.requests.length - 1];
    if (response === undefined)
      throw new Error("Missing fake command response");
    return response;
  }
}

class StubCredentials implements GitHubCredentials {
  async environmentFor(): Promise<
    Result<Readonly<Record<string, string>>, CommandFailure>
  > {
    return ok({ GH_TOKEN: "profile-token" });
  }

  forget(_profile: WorkspaceProfileConfig): void {}
}

function testAdapter(executor: FakeProcessExecutor): GitHubAdapter {
  return new GitHubAdapter(new CommandRunner(executor), new StubCredentials());
}

function confirmThreadResponse(): string {
  return JSON.stringify({
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
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify({
          id: 201,
          node_id: "PRRC_comment",
          pull_request_review_id: 42,
        }),
        stderr: "",
      },
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: confirmThreadResponse(),
        stderr: "",
      },
    ]);

    await expect(
      testAdapter(executor).createInlineComment({
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
    const executor = new FakeProcessExecutor([
      { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" },
    ]);

    await expect(
      testAdapter(executor).deleteReviewComment({
        profile,
        pr,
        commentId: "3888149868",
      }),
    ).resolves.toEqual({ _tag: "ok", value: undefined });
    const request = executor.requests[0]?.join(" ") ?? "";
    expect(request).toContain("--method DELETE");
    expect(request).toContain("pulls/comments/3888149868");
  });
});
