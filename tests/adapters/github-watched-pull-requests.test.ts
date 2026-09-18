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
  parseIsoTimestamp,
  parsePullRequestNumber,
} from "../../src/domain/ids";
import type { RawJsonValue } from "../../src/domain/json";
import { ok, type Result } from "../../src/domain/result";
import {
  parseWorkspaceProfileConfig,
  type WorkspaceProfileConfig,
} from "../../src/domain/workspace-profile";

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
const ref = (number: number) => ({
  host: mustParse(parseGitHubHost("github.com")),
  owner: mustParse(parseGitHubOwner("centraldigital")),
  repo: mustParse(parseGitHubRepoName("patchdesk")),
  number: mustParse(parsePullRequestNumber(number)),
});
const now = mustParse(parseIsoTimestamp("2026-09-17T10:00:00.000Z"));

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

function exited(value: RawJsonValue): CommandExecution {
  return {
    _tag: "Exited",
    exitCode: 0,
    stdout: JSON.stringify(value),
    stderr: "",
  };
}

describe("GitHub watched pull request reader", () => {
  it("reads every watched pull request in one aliased call", async () => {
    const executor = new FakeProcessExecutor([
      exited({
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
        new CommandRunner(executor),
        new StubCredentials(),
      ).readWatchedPullRequests({ profile, refs: [ref(7), ref(8)], now }),
    ).resolves.toEqual({
      _tag: "ok",
      value: [
        {
          ref: ref(7),
          snapshot: {
            updatedAt: "2026-09-17T09:00:00.000Z",
            headSha: "a".repeat(40),
            reviewState: "approved",
            checks: "passing",
            state: "merged",
          },
        },
        { ref: ref(8), snapshot: undefined },
      ],
    });
    expect(executor.requests).toHaveLength(1);
    const argv = executor.requests[0] ?? [];
    expect(argv[argv.indexOf("owner1=centraldigital") - 1]).toBe("-f");
    expect(argv[argv.indexOf("number1=8") - 1]).toBe("-F");
  });

  it("answers rate limited without a call while the host's spent limit has not reset", async () => {
    const executor = new FakeProcessExecutor([
      exited({
        data: {
          rateLimit: { remaining: 0, resetAt: "2026-09-17T11:00:00Z" },
          pr0: { pullRequest: null },
        },
      }),
    ]);
    const adapter = new GitHubAdapter(
      new CommandRunner(executor),
      new StubCredentials(),
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
    expect(executor.requests).toHaveLength(1);
  });
});
