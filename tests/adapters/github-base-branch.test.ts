import { StubCredentials } from "./stub-github-credentials";
import { describe, expect, it } from "vitest";

import {
  CommandRunner,
  type CommandExecution,
  type CommandExecutor,
} from "../../src/adapters/github/command-runner";
import { GitHubAdapter } from "../../src/adapters/github/github-adapter";
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

function exited(stdout: string): CommandExecution {
  return { _tag: "Exited", exitCode: 0, stdout, stderr: "" };
}

describe("GitHub base-branch adapter", () => {
  it("lists branch names with the search passed as a raw string", async () => {
    const executor = new FakeProcessExecutor([
      exited(
        JSON.stringify({
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
      ),
    ]);

    await expect(
      new GitHubAdapter(
        new CommandRunner(executor),
        new StubCredentials(),
      ).listRepositoryBranches({ profile, repo, query: "1" }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { branches: ["release/1.2", "release/1.3"], totalCount: 140 },
    });
    const argv = executor.requests[0] ?? [];
    expect(argv.slice(0, 5)).toEqual([
      "gh",
      "api",
      "graphql",
      "--hostname",
      "github.com",
    ]);
    expect(argv).toContain("owner=centraldigital");
    expect(argv).toContain("name=patchdesk");
    expect(argv[argv.indexOf("search=1") - 1]).toBe("-f");
  });

  it("omits the search variable when the query is empty", async () => {
    const executor = new FakeProcessExecutor([
      exited(
        JSON.stringify({
          data: { repository: { refs: { totalCount: 0, nodes: [] } } },
        }),
      ),
    ]);

    await new GitHubAdapter(
      new CommandRunner(executor),
      new StubCredentials(),
    ).listRepositoryBranches({ profile, repo, query: "" });
    expect(
      (executor.requests[0] ?? []).some((arg) => arg.startsWith("search=")),
    ).toBe(false);
  });

  it("sends updatePullRequest with the branch as a raw string", async () => {
    const executor = new FakeProcessExecutor([
      exited(
        JSON.stringify({
          data: { updatePullRequest: { clientMutationId: null } },
        }),
      ),
    ]);

    await expect(
      new GitHubAdapter(
        new CommandRunner(executor),
        new StubCredentials(),
      ).setPullRequestBaseBranch({
        profile,
        pullRequestId: "PR_node",
        branch: "2026",
      }),
    ).resolves.toEqual({ _tag: "ok", value: undefined });
    const argv = executor.requests[0] ?? [];
    expect(argv.find((arg) => arg.startsWith("query="))).toContain(
      "updatePullRequest(input: { pullRequestId: $pullRequestId, baseRefName: $baseRefName })",
    );
    expect(argv[argv.indexOf("pullRequestId=PR_node") - 1]).toBe("-F");
    expect(argv[argv.indexOf("baseRefName=2026") - 1]).toBe("-f");
  });
});
