import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CommandRunner,
  type CommandExecution,
  type CommandExecutor,
} from "../../src/adapters/github/command-runner";
import {
  createFetchedDiffRefs,
  FakeGitHubAdapter,
  GitHubAdapter,
  type GitHubReader,
} from "../../src/adapters/github/github-adapter";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseAbsolutePath,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
} from "../../src/domain/ids";
import { type PullRequestRef } from "../../src/domain/pull-request";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";

const fixtureRoot = join(
  import.meta.dirname,
  "..",
  "..",
  "fixtures",
  "github",
  "argv",
);
const payloadRoot = join(
  import.meta.dirname,
  "..",
  "..",
  "fixtures",
  "github",
  "payloads",
);
const headSha = "abcdef1234567890abcdef1234567890abcdef12";

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

class FakeProcessExecutor implements CommandExecutor {
  readonly requests: Array<ReadonlyArray<string>> = [];

  constructor(private readonly responses: ReadonlyArray<CommandExecution>) {}

  async execute(input: {
    readonly argv: ReadonlyArray<string>;
    readonly timeoutMs: number;
  }): Promise<CommandExecution> {
    this.requests.push(input.argv);
    const response = this.responses[this.requests.length - 1];
    if (response === undefined)
      throw new Error("Missing fake command response");
    return response;
  }
}

async function golden(name: string): Promise<ReadonlyArray<string>> {
  return JSON.parse(
    await readFile(join(fixtureRoot, `${name}.json`), "utf8"),
  ) as ReadonlyArray<string>;
}

async function payload(name: string): Promise<string> {
  return readFile(join(payloadRoot, name), "utf8");
}

function pullRequestPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number: 42,
    title: "Add safe GitHub reads",
    state: "open",
    draft: false,
    head: { ref: "feat/github-read", sha: headSha },
    base: { ref: "sit" },
    user: { login: "reviewer" },
    updated_at: "2026-07-16T12:00:00Z",
    mergeable_state: "clean",
    labels: [{ name: "review" }],
    additions: 12,
    deletions: 3,
    changed_files: 2,
    ...overrides,
  };
}

describe("CommandRunner", () => {
  it("captures JSON through explicit argv without exposing stderr", async () => {
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify({ status: "ok" }),
        stderr: "",
      },
    ]);
    const runner = new CommandRunner(executor);

    const result = await runner.runJson({
      argv: ["gh", "api", "user"],
      timeoutMs: 2_500,
    });

    expect(result).toEqual({ _tag: "ok", value: { status: "ok" } });
    expect(executor.requests).toEqual([["gh", "api", "user"]]);
  });

  it("classifies timeout, invalid JSON, and authentication without command output", async () => {
    const timeout = new CommandRunner(
      new FakeProcessExecutor([
        {
          _tag: "TimedOut",
          stdout: "",
          stderr: "",
        },
      ]),
    );
    const invalidJson = new CommandRunner(
      new FakeProcessExecutor([
        {
          _tag: "Exited",
          exitCode: 0,
          stdout: "not json",
          stderr: "",
        },
      ]),
    );
    const auth = new CommandRunner(
      new FakeProcessExecutor([
        {
          _tag: "Exited",
          exitCode: 1,
          stdout: "",
          stderr: "To get started with GitHub CLI, please run: gh auth login",
        },
      ]),
    );

    expect(
      await timeout.runJson({ argv: ["gh", "api", "user"], timeoutMs: 5 }),
    ).toEqual({
      _tag: "err",
      error: { _tag: "CommandTimedOut" },
    });
    expect(
      await invalidJson.runJson({ argv: ["gh", "api", "user"], timeoutMs: 5 }),
    ).toEqual({
      _tag: "err",
      error: { _tag: "CommandInvalidJson" },
    });
    expect(
      await auth.runJson({ argv: ["gh", "api", "user"], timeoutMs: 5 }),
    ).toEqual({
      _tag: "err",
      error: { _tag: "CommandAuthenticationRequired" },
    });
  });
});

describe("GitHubAdapter read boundary", () => {
  it("uses checked-in argv contracts for all GitHub read methods and auth", async () => {
    const [listOpenPrs, getPr, getComments, getChecks, getDiff, authStatus] =
      await Promise.all([
        payload("list-open-prs.json"),
        payload("get-pr.json"),
        payload("get-comments.json"),
        payload("get-checks.json"),
        payload("get-diff.patch"),
        payload("auth-status.txt"),
      ]);
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: listOpenPrs,
        stderr: "",
      },
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: getPr,
        stderr: "",
      },
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: getComments,
        stderr: "",
      },
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: getChecks,
        stderr: "",
      },
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: getDiff,
        stderr: "",
      },
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: authStatus,
        stderr: "",
      },
    ]);
    const adapter = new GitHubAdapter(new CommandRunner(executor));

    expect(
      await adapter.listOpenPullRequests({ profile, repo: pr }),
    ).toMatchObject({
      _tag: "ok",
      value: [{ title: "Add safe GitHub reads", changedFileCount: 2 }],
    });
    expect(await adapter.getPullRequest({ profile, pr })).toMatchObject({
      _tag: "ok",
      value: { headSha, baseBranch: "sit", author: "reviewer" },
    });
    expect(await adapter.getPullRequestComments({ profile, pr })).toEqual({
      _tag: "ok",
      value: { threads: [] },
    });
    expect(
      await adapter.getPullRequestChecks({
        profile,
        pr,
        headSha: mustParse(parseGitSha(headSha)),
      }),
    ).toEqual({
      _tag: "ok",
      value: {
        overall: "passing",
        checks: [
          {
            name: "test",
            required: "unknown",
            status: "completed",
            conclusion: "success",
            url: "https://example.test/check",
          },
        ],
      },
    });
    expect(await adapter.getPullRequestDiff({ profile, pr })).toEqual({
      _tag: "ok",
      value: getDiff,
    });
    expect(await adapter.resolveAuthenticatedAccount(profile)).toEqual({
      _tag: "ok",
      value: { host: "github.com", account: "pmquan2cfw" },
    });

    await expect(
      Promise.all([
        golden("list-open-prs"),
        golden("get-pr"),
        golden("get-comments"),
        golden("get-checks"),
        golden("get-diff"),
        golden("auth-status"),
      ]),
    ).resolves.toEqual(executor.requests);
  });

  it("returns a degraded summary when optional GitHub metadata is absent", async () => {
    const adapter = new GitHubAdapter(
      new CommandRunner(
        new FakeProcessExecutor([
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify([
              pullRequestPayload({
                labels: [],
                additions: undefined,
                deletions: undefined,
                changed_files: undefined,
                mergeable_state: undefined,
              }),
            ]),
            stderr: "",
          },
        ]),
      ),
    );

    const result = await adapter.listOpenPullRequests({ profile, repo: pr });
    expect(result).toMatchObject({
      _tag: "ok",
      value: [expect.objectContaining({ mergeability: "unknown", labels: [] })],
    });
    if (result._tag === "ok") {
      expect(result.value[0]).not.toHaveProperty("changedFileCount");
      expect(result.value[0]).not.toHaveProperty("additions");
      expect(result.value[0]).not.toHaveProperty("deletions");
    }
  });

  it("does not execute a git diff fallback without fetched-ref evidence", async () => {
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 1,
        stdout: "",
        stderr: "pull request diff unavailable",
      },
    ]);
    const adapter = new GitHubAdapter(new CommandRunner(executor));

    expect(await adapter.getPullRequestDiff({ profile, pr })).toEqual({
      _tag: "err",
      error: { _tag: "GitHubReadFailed", operation: "get_diff" },
    });
    expect(executor.requests).toEqual([await golden("get-diff")]);
  });

  it("uses git diff only after explicit fetched-ref evidence", async () => {
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 1,
        stdout: "",
        stderr: "pull request diff unavailable",
      },
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: "diff --git a/fallback.ts b/fallback.ts\n",
        stderr: "",
      },
    ]);
    const adapter = new GitHubAdapter(new CommandRunner(executor));

    expect(
      await adapter.getPullRequestDiff({
        profile,
        pr,
        fetchedRefs: mustParse(
          createFetchedDiffRefs({
            repositoryPath: mustParse(parseAbsolutePath("/tmp/patchdesk-repo")),
            baseRef: "refs/patchdesk/base",
            headRef: "refs/patchdesk/head",
          }),
        ),
      }),
    ).toEqual({
      _tag: "ok",
      value: "diff --git a/fallback.ts b/fallback.ts\n",
    });
    expect(executor.requests).toEqual([
      await golden("get-diff"),
      [
        "git",
        "-C",
        "/tmp/patchdesk-repo",
        "diff",
        "--no-ext-diff",
        "refs/patchdesk/base...refs/patchdesk/head",
      ],
    ]);
  });

  it("rejects untrusted ref names before a git diff fallback can be requested", () => {
    expect(
      createFetchedDiffRefs({
        repositoryPath: mustParse(parseAbsolutePath("/tmp/patchdesk-repo")),
        baseRef: "--output=/tmp/unsafe",
        headRef: "refs/patchdesk/head",
      }),
    ).toEqual({ _tag: "err", error: { _tag: "InvalidFetchedDiffRefs" } });
  });

  it("maps missing local GitHub auth to github_auth and provides a fixture fake", async () => {
    const adapter = new GitHubAdapter(
      new CommandRunner(
        new FakeProcessExecutor([
          {
            _tag: "Exited",
            exitCode: 1,
            stdout: "",
            stderr: "not logged into any GitHub hosts",
          },
        ]),
      ),
    );
    const fake: GitHubReader = new FakeGitHubAdapter({
      listOpenPullRequests: [
        {
          ref: pr,
          title: "Fixture PR",
          author: "fixture",
          headBranch: "feat/fixture",
          baseBranch: "sit",
          headSha: mustParse(parseGitSha(headSha)),
          isDraft: false,
          isOpen: true,
          reviewState: "unknown",
          mergeability: "unknown",
          labels: [],
          updatedAt: mustParse(parseIsoTimestamp("2026-07-16T12:00:00.000Z")),
        },
      ],
    });

    expect(await adapter.resolveAuthenticatedAccount(profile)).toEqual({
      _tag: "err",
      error: { _tag: "GitHubAuthenticationFailed", operation: "auth_status" },
    });
    expect(
      await fake.listOpenPullRequests({ profile, repo: pr }),
    ).toMatchObject({
      _tag: "ok",
      value: [{ title: "Fixture PR" }],
    });
  });
});
