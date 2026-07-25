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
const baseSha = "1234567890abcdef1234567890abcdef12345678";

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
  readonly stdin: Array<string | undefined> = [];

  constructor(private readonly responses: ReadonlyArray<CommandExecution>) {}

  async execute(input: {
    readonly argv: ReadonlyArray<string>;
    readonly timeoutMs: number;
    readonly stdin?: string;
  }): Promise<CommandExecution> {
    this.requests.push(input.argv);
    this.stdin.push(input.stdin);
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
    requested_reviewers: [{ login: "pmquan2cfw" }],
    assignees: [{ login: "pmquan2cfw" }],
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
  it("returns parsed GraphQL inbox rows and marks a capped listing incomplete", async () => {
    const page = (hasNextPage: boolean, endCursor: string | null) => ({
      data: {
        repository: {
          pullRequests: {
            nodes: [{
              number: 42,
              title: "Add safe GitHub reads",
              isDraft: false,
              headRefName: "feat/github-read",
              headRefOid: headSha,
              baseRefName: "sit",
              author: { login: "reviewer" },
              updatedAt: "2026-07-16T12:00:00Z",
              mergeable: "MERGEABLE",
              reviewDecision: "REVIEW_REQUIRED",
              additions: 12,
              deletions: 3,
              changedFiles: 2,
              reviewRequests: {
                nodes: [{ requestedReviewer: { login: "pmquan2cfw" } }],
              },
              assignees: { nodes: [] },
              commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
            }],
            pageInfo: { hasNextPage, endCursor },
          },
        },
      },
    });
    const executor = new FakeProcessExecutor([0, 1, 2].map((index) => ({
      _tag: "Exited" as const,
      exitCode: 0,
      stdout: JSON.stringify(page(true, `cursor-${index}`)),
      stderr: "",
    })));
    const adapter = new GitHubAdapter(new CommandRunner(executor));

    const result = await adapter.listMaintainerPullRequests({ profile, repo: pr });

    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        complete: false,
        pullRequests: expect.arrayContaining([
          expect.objectContaining({
            summary: expect.objectContaining({ reviewState: "review_pending", mergeability: "mergeable" }),
            checks: { overall: "passing", checks: [] },
          }),
        ]),
      },
    });
    if (result._tag === "ok") expect(result.value.pullRequests).toHaveLength(3);
    expect(executor.requests).toHaveLength(3);
    expect(executor.requests[1]).toContain("cursor=cursor-0");
    expect(
      executor.requests[0]?.some((argument) =>
        argument.includes("reviewRequests(first: 50)"),
      ),
    ).toBe(true);
  });

  it("uses one verified GitHub comparison diff only when the file metadata is complete", async () => {
    const compare = {
      base_commit: { sha: baseSha },
      head_commit: { sha: headSha },
      created_at: "2026-07-18T00:00:00Z",
      status: "ahead",
      commits: [{ sha: headSha, commit: { message: "Fix guard\n\nDetails", author: { name: "Reviewer", date: "2026-07-18T00:00:00Z" } } }],
      files: [{ filename: "src/guard.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" }],
    };
    const executor = new FakeProcessExecutor([
      { _tag: "Exited", exitCode: 0, stdout: JSON.stringify(compare), stderr: "" },
      { _tag: "Exited", exitCode: 0, stdout: "diff --git a/src/guard.ts b/src/guard.ts\n", stderr: "" },
    ]);
    const adapter = new GitHubAdapter(new CommandRunner(executor));
    const result = await adapter.compareRevisions({ profile, pr, baseSha: mustParse(parseGitSha(baseSha)), headSha: mustParse(parseGitSha(headSha)), baseSessionId: "github.com__centraldigital__patchdesk__pr-42__sha-12345678__000000000000" as never });
    expect(result).toMatchObject({ _tag: "ok", value: { comparison: { source: "github", completeness: "complete", additions: 2, deletions: 1 }, patch: expect.stringContaining("src/guard.ts") } });
    expect(executor.requests).toHaveLength(2);
    expect(executor.requests[1]).toContain("Accept: application/vnd.github.v3.diff");
  });

  it("uses checked-in argv contracts for all GitHub read methods and auth", async () => {
    const [listOpenPrs, getPr, getComments, getChecks, getDiff] =
      await Promise.all([
        payload("list-open-prs.json"),
        payload("get-pr.json"),
        payload("get-comments.json"),
        payload("get-checks.json"),
        payload("get-diff.patch"),
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
        stdout: "pmquan2cfw\n",
        stderr: "",
      },
    ]);
    const adapter = new GitHubAdapter(new CommandRunner(executor));

    expect(
      await adapter.listOpenPullRequests({ profile, repo: pr }),
    ).toMatchObject({
      _tag: "ok",
      value: [
        {
          title: "Add safe GitHub reads",
          changedFileCount: 2,
          requestedReviewers: ["pmquan2cfw"],
          assignees: ["pmquan2cfw"],
        },
      ],
    });
    expect(await adapter.getPullRequest({ profile, pr })).toMatchObject({
      _tag: "ok",
      value: { headSha, baseBranch: "sit", author: "reviewer" },
    });
    expect(await adapter.getPullRequestComments({ profile, pr })).toEqual({
      _tag: "ok",
      value: {
        threads: [
          {
            id: "thread-1",
            state: "open",
            location: { path: "src/review.ts", line: 5, lineEnd: 7, diffSide: "new" },
            comments: [
              expect.objectContaining({
                id: "comment-1",
                location: { path: "src/review.ts", line: 5, lineEnd: 7, diffSide: "new" },
              }),
            ],
          },
        ],
      },
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

  it("uses the immutable managed refs when fetched-ref evidence is supplied", async () => {
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: `${baseSha}\n`,
        stderr: "",
      },
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: `${headSha}\n`,
        stderr: "",
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
            baseSha: mustParse(parseGitSha(baseSha)),
            headSha: mustParse(parseGitSha(headSha)),
          }),
        ),
      }),
    ).toEqual({
      _tag: "ok",
      value: "diff --git a/fallback.ts b/fallback.ts\n",
    });
    expect(executor.requests).toEqual([
      [
        "git",
        "-C",
        "/tmp/patchdesk-repo",
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        "refs/patchdesk/base^{commit}",
      ],
      [
        "git",
        "-C",
        "/tmp/patchdesk-repo",
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        "refs/patchdesk/head^{commit}",
      ],
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

  it("uses an immutable GitHub comparison when no managed checkout is available", async () => {
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 0,
        stdout: "diff --git a/exact.ts b/exact.ts\n",
        stderr: "",
      },
    ]);
    const adapter = new GitHubAdapter(new CommandRunner(executor));

    expect(
      await adapter.getPullRequestDiff({
        profile,
        pr,
        snapshot: {
          baseSha: mustParse(parseGitSha(baseSha)),
          headSha: mustParse(parseGitSha(headSha)),
        },
      }),
    ).toEqual({
      _tag: "ok",
      value: "diff --git a/exact.ts b/exact.ts\n",
    });
    expect(executor.requests).toEqual([
      [
        "gh",
        "api",
        "--hostname",
        profile.githubHost,
        "-H",
        "Accept: application/vnd.github.v3.diff",
        `repos/${pr.owner}/${pr.repo}/compare/${baseSha}...${headSha}`,
      ],
    ]);
  });

  it("rejects untrusted ref names before a git diff fallback can be requested", () => {
    expect(
      createFetchedDiffRefs({
        repositoryPath: mustParse(parseAbsolutePath("/tmp/patchdesk-repo")),
        baseRef: "--output=/tmp/unsafe",
        headRef: "refs/patchdesk/head",
        baseSha: mustParse(parseGitSha(baseSha)),
        headSha: mustParse(parseGitSha(headSha)),
      }),
    ).toEqual({ _tag: "err", error: { _tag: "InvalidFetchedDiffRefs" } });
  });

  it("does not run git diff when an expected fetched ref is absent", async () => {
    const executor = new FakeProcessExecutor([
      { _tag: "Exited", exitCode: 1, stdout: "", stderr: "unknown revision" },
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
            baseSha: mustParse(parseGitSha(baseSha)),
            headSha: mustParse(parseGitSha(headSha)),
          }),
        ),
      }),
    ).toEqual({
      _tag: "err",
      error: { _tag: "GitHubReadFailed", operation: "get_diff" },
    });
    expect(executor.requests).toEqual([
      [
        "git",
        "-C",
        "/tmp/patchdesk-repo",
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        "refs/patchdesk/base^{commit}",
      ],
    ]);
  });

  it("does not run git diff when a managed fetched ref resolves to the wrong commit", async () => {
    const executor = new FakeProcessExecutor([
      { _tag: "Exited", exitCode: 0, stdout: `${headSha}\n`, stderr: "" },
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
            baseSha: mustParse(parseGitSha(baseSha)),
            headSha: mustParse(parseGitSha(headSha)),
          }),
        ),
      }),
    ).toEqual({
      _tag: "err",
      error: { _tag: "GitHubReadFailed", operation: "get_diff" },
    });
    expect(executor.requests).toHaveLength(1);
  });

  it("classifies a successful status for a different gh account as github_auth", async () => {
    const adapter = new GitHubAdapter(
      new CommandRunner(
        new FakeProcessExecutor([
          {
            _tag: "Exited",
            exitCode: 0,
            stdout:
              "github.com\n  ✓ Logged in to github.com account another-user (keyring)\n",
            stderr: "",
          },
        ]),
      ),
    );

    expect(await adapter.resolveAuthenticatedAccount(profile)).toEqual({
      _tag: "err",
      error: { _tag: "GitHubAuthenticationFailed", operation: "auth_status" },
    });
  });

  it("classifies a configured account that is listed but inactive as github_auth", async () => {
    const adapter = new GitHubAdapter(
      new CommandRunner(
        new FakeProcessExecutor([
          {
            _tag: "Exited",
            exitCode: 0,
            stdout:
              "github.com\n  ✓ Logged in to github.com account pmquan2cfw (keyring)\n  - Active account: false\n  ✓ Logged in to github.com account another-user (keyring)\n  - Active account: true\n",
            stderr: "",
          },
        ]),
      ),
    );

    expect(await adapter.resolveAuthenticatedAccount(profile)).toEqual({
      _tag: "err",
      error: { _tag: "GitHubAuthenticationFailed", operation: "auth_status" },
    });
  });

  it("classifies malformed valid JSON GitHub responses without exposing payloads", async () => {
    const adapter = new GitHubAdapter(
      new CommandRunner(
        new FakeProcessExecutor([
          {
            _tag: "Exited",
            exitCode: 0,
            stdout: await payload("malformed-get-pr.json"),
            stderr: "",
          },
        ]),
      ),
    );

    expect(await adapter.getPullRequest({ profile, pr })).toEqual({
      _tag: "err",
      error: { _tag: "GitHubResponseInvalid", operation: "get_pr" },
    });
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

describe("GitHubAdapter review write boundary", () => {
  it("creates a pending review and submits its selected event through JSON stdin", async () => {
    const [createArgv, submitArgv, createPayload, submitPayload] = await Promise.all([golden("create-pending-review"), golden("submit-pending-review"), payload("create-pending-review.json"), payload("submit-pending-review.json")]);
    const executor = new FakeProcessExecutor([
      { _tag: "Exited", exitCode: 0, stdout: JSON.stringify({ id: 9001, state: "PENDING" }), stderr: "" },
      { _tag: "Exited", exitCode: 0, stdout: JSON.stringify({ id: 9001, state: "SUBMITTED" }), stderr: "" },
    ]);
    const adapter = new GitHubAdapter(new CommandRunner(executor));

    await expect(adapter.createPendingReview({ profile, pr, headSha: mustParse(parseGitSha(headSha)), summaryBody: "Keep the safety check.", comments: [{ body: "Comment body", path: "src/review.ts", line: 7, lineEnd: 9, diffSide: "new" }] })).resolves.toEqual({ _tag: "ok", value: { reviewId: "9001", state: "PENDING" } });
    await expect(adapter.submitPendingReview({ profile, pr, reviewId: "9001", event: "REQUEST_CHANGES", summaryBody: "Request changes before merge." })).resolves.toEqual({ _tag: "ok", value: { reviewId: "9001" } });

    expect(executor.requests).toEqual([createArgv, submitArgv]);
    expect(JSON.parse(executor.stdin[0] ?? "{}")).toEqual(JSON.parse(createPayload));
    expect(JSON.parse(executor.stdin[1] ?? "{}")).toEqual(JSON.parse(submitPayload));
  });

  it("rejects a create response unless GitHub confirms the review is pending", async () => {
    const adapter = new GitHubAdapter(new CommandRunner(new FakeProcessExecutor([{ _tag: "Exited", exitCode: 0, stdout: JSON.stringify({ id: 9001, state: "SUBMITTED" }), stderr: "" }])));
    await expect(adapter.createPendingReview({ profile, pr, headSha: mustParse(parseGitSha(headSha)), summaryBody: "summary", comments: [{ body: "Comment body", path: "src/review.ts", line: 7, diffSide: "new" }] })).resolves.toEqual({ _tag: "err", error: { _tag: "GitHubWriteFailure", category: "unavailable", message: "GitHub did not return a PENDING review." } });
  });

  it("uses the same explicit event endpoint for a summary-only submit", async () => {
    const [submitArgv, summaryPayload] = await Promise.all([golden("submit-pending-review"), payload("submit-summary-only-review.json")]);
    const executor = new FakeProcessExecutor([{ _tag: "Exited", exitCode: 0, stdout: JSON.stringify({ id: 9001, state: "SUBMITTED" }), stderr: "" }]);
    const adapter = new GitHubAdapter(new CommandRunner(executor));
    await expect(adapter.submitPendingReview({ profile, pr, reviewId: "9001", event: "COMMENT", summaryBody: "Summary-only review." })).resolves.toEqual({ _tag: "ok", value: { reviewId: "9001" } });
    expect(executor.requests).toEqual([submitArgv]);
    expect(JSON.parse(executor.stdin[0] ?? "{}")).toEqual(JSON.parse(summaryPayload));
  });

  it("merges only through the explicit SHA-pinned GitHub endpoint", async () => {
    const [mergeArgv, mergePayload] = await Promise.all([golden("merge-pull-request"), payload("merge-pull-request.json")]);
    const executor = new FakeProcessExecutor([{ _tag: "Exited", exitCode: 0, stdout: JSON.stringify({ merged: true, sha: headSha }), stderr: "" }]);
    const adapter = new GitHubAdapter(new CommandRunner(executor));
    await expect(adapter.mergePullRequest({ profile, pr, headSha: mustParse(parseGitSha(headSha)), method: "squash" })).resolves.toEqual({ _tag: "ok", value: { mergeCommitSha: mustParse(parseGitSha(headSha)) } });
    expect(executor.requests).toEqual([mergeArgv]);
    expect(JSON.parse(executor.stdin[0] ?? "{}")).toEqual(JSON.parse(mergePayload));
  });
});
