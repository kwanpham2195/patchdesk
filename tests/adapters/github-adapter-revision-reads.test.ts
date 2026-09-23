import { CommandRunner } from "../../src/adapters/github/command-runner";
import { orderedTransport } from "./github-transport-doubles";
import { createFetchedDiffRefs } from "../../src/adapters/github/github-adapter";
import { parseAbsolutePath, parseGitSha } from "../../src/domain/ids";
import { describe, expect, it } from "vitest";
import {
  headSha,
  baseSha,
  mustParse,
  profile,
  pr,
  FakeProcessExecutor,
  testAdapter,
  sent,
  sentArgv,
  payload,
  pullRequestPayload,
} from "./github-adapter-test-support";

describe("GitHubAdapter revision and commit reads", () => {
  it("returns a degraded summary when optional GitHub metadata is absent", async () => {
    const adapter = testAdapter(
      orderedTransport([
        JSON.stringify([
          pullRequestPayload({
            labels: [],
            additions: undefined,
            deletions: undefined,
            changed_files: undefined,
            mergeable_state: undefined,
          }),
        ]),
      ]),
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
    const adapter = testAdapter(
      orderedTransport([]),
      new CommandRunner(executor),
    );

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
    const transport = orderedTransport(["diff --git a/exact.ts b/exact.ts\n"]);
    const adapter = testAdapter(transport);

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
    expect(sentArgv(transport)).toEqual([
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
    const adapter = testAdapter(
      orderedTransport([]),
      new CommandRunner(executor),
    );

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
    const adapter = testAdapter(
      orderedTransport([]),
      new CommandRunner(executor),
    );

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

  it("classifies a credential that authenticates as another account as github_auth", async () => {
    const adapter = testAdapter(
      orderedTransport([JSON.stringify({ login: "another-user", id: 5 })]),
    );

    expect(await adapter.resolveAuthenticatedAccount(profile)).toEqual({
      _tag: "err",
      error: { _tag: "GitHubAuthenticationFailed", operation: "auth_status" },
    });
  });

  it("classifies malformed valid JSON GitHub responses without exposing payloads", async () => {
    const adapter = testAdapter(
      orderedTransport([await payload("malformed-get-pr.json")]),
    );

    expect(await adapter.getPullRequest({ profile, pr })).toEqual({
      _tag: "err",
      error: { _tag: "GitHubResponseInvalid", operation: "get_pr" },
    });
  });

  it("maps missing local GitHub auth to github_auth", async () => {
    const adapter = testAdapter(
      orderedTransport([{ _tag: "CommandAuthenticationRequired" }]),
    );
    expect(await adapter.resolveAuthenticatedAccount(profile)).toEqual({
      _tag: "err",
      error: { _tag: "GitHubAuthenticationFailed", operation: "auth_status" },
    });
  });
  it("lists pull request commits with immutable parsing and head marking", async () => {
    const olderSha = "1111111111111111111111111111111111111111";
    const transport = orderedTransport([
      JSON.stringify(pullRequestPayload()),
      JSON.stringify([
        [
          {
            sha: olderSha,
            html_url: "https://github.com/octo-org/patchdesk/commit/111",
            commit: {
              message: "Older change",
              author: { name: "Older", date: "2026-07-16T11:00:00Z" },
            },
          },
        ],
        [
          {
            sha: headSha,
            html_url: "https://github.com/octo-org/patchdesk/commit/head",
            commit: {
              message: "Head change",
              author: { name: "Head", date: "2026-07-16T12:00:00Z" },
            },
          },
        ],
      ]),
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.getPullRequestCommits({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: [
        { sha: headSha, message: "Head change", isHead: true },
        { sha: olderSha, message: "Older change", isHead: false },
      ],
    });
    expect(sent(transport, 1).argv).toEqual([
      "gh",
      "api",
      "--paginate",
      "--slurp",
      "--hostname",
      "github.com",
      "repos/octo-org/patchdesk/pulls/42/commits?per_page=100",
    ]);
  });

  it("rejects a commit listing that reaches the deliberate cap", async () => {
    const commits = Array.from({ length: 251 }, (_, index) => ({
      sha: `${"a".repeat(39)}${(index % 16).toString(16)}`,
      commit: {
        message: `Commit ${index}`,
        author: { name: "Author", date: "2026-07-16T12:00:00Z" },
      },
    }));
    const transport = orderedTransport([
      JSON.stringify(pullRequestPayload()),
      JSON.stringify([commits]),
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.getPullRequestCommits({ profile, pr }),
    ).resolves.toEqual({
      _tag: "err",
      error: { _tag: "GitHubResponseInvalid", operation: "get_pr_commits" },
    });
  });
});
