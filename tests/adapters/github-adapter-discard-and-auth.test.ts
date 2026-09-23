import {
  CommandRunner,
  type CommandExecution,
  type CommandExecutor,
} from "../../src/adapters/github/command-runner";
import { orderedTransport } from "./github-transport-doubles";
import {
  FakeGitHubAdapter,
  GitHubAdapter,
} from "../../src/adapters/github/github-adapter";
import { GitHubCliCredentials } from "../../src/adapters/github/github-credentials";
import { GitHubHttpClient } from "../../src/adapters/github/github-http-client";
import {
  parseGitHubLogin,
  parseGitHubReviewRestId,
} from "../../src/domain/ids";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { describe, expect, it } from "vitest";
import {
  headSha,
  mustParse,
  profile,
  pr,
  FakeProcessExecutor,
  testAdapter,
  sent,
  pullRequestPayload,
} from "./github-adapter-test-support";

describe("GitHubAdapter pending-review discard", () => {
  it("deletes the pending review through the dbacd62-proven REST endpoint and accepts the empty 204 body", async () => {
    const transport = orderedTransport([""]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.discardPendingReview({
        profile,
        pr,
        reviewId: mustParse(parseGitHubReviewRestId("9001")),
      }),
    ).resolves.toEqual({ _tag: "ok", value: undefined });
    expect(sent(transport, 0).argv).toEqual([
      "gh",
      "api",
      "--hostname",
      "github.com",
      "--method",
      "DELETE",
      "repos/octo-org/patchdesk/pulls/42/reviews/9001",
    ]);
  });

  it("classifies a not-found discard as unavailable (conservative, never a confirmed absence)", async () => {
    const transport = orderedTransport([{ _tag: "CommandNotFound" }]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.discardPendingReview({
        profile,
        pr,
        reviewId: mustParse(parseGitHubReviewRestId("9001")),
      }),
    ).resolves.toMatchObject({
      _tag: "err",
      error: { _tag: "GitHubWriteFailure", category: "unavailable" },
    });
  });

  it("classifies a forbidden discard as forbidden with its specific reason, not the generic unavailable category", async () => {
    const transport = orderedTransport([
      { _tag: "CommandForbidden", reason: "unknown" },
    ]);
    const adapter = testAdapter(transport);
    await expect(
      adapter.discardPendingReview({
        profile,
        pr,
        reviewId: mustParse(parseGitHubReviewRestId("9001")),
      }),
    ).resolves.toMatchObject({
      _tag: "err",
      error: {
        _tag: "GitHubWriteFailure",
        category: "forbidden",
        reason: "unknown",
      },
    });
  });

  it("keeps the fake discard seam unimplemented until a fixture is supplied", async () => {
    const adapter = new FakeGitHubAdapter({
      authenticatedAccount: { host: "github.com", account: "octo-dev" },
    });
    await expect(
      adapter.discardPendingReview({
        profile,
        pr,
        reviewId: mustParse(parseGitHubReviewRestId("9001")),
      }),
    ).resolves.toMatchObject({
      _tag: "err",
      error: { category: "unavailable" },
    });
  });
});

describe("GitHubAdapter direct summary reads", () => {
  it("ignores dismissed reviews while retaining submitted direct summaries", async () => {
    const adapter = testAdapter(
      orderedTransport([
        JSON.stringify([
          {
            id: 100,
            user: { login: "octo-dev" },
            state: "DISMISSED",
            commit_id: headSha,
            submitted_at: "2026-08-01T00:00:00Z",
            body: "Dismissed",
          },
          {
            id: 101,
            user: { login: "octo-dev" },
            state: "COMMENTED",
            commit_id: headSha,
            submitted_at: "2026-08-01T00:01:00Z",
            body: "Summary",
          },
        ]),
      ]),
    );

    await expect(
      adapter.getViewerDirectSummaryReviews({
        profile,
        pr,
        account: mustParse(parseGitHubLogin("octo-dev")),
      }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: {
        complete: true,
        reviews: [{ reviewId: "101", event: "COMMENT", headSha }],
      },
    });
  });
});

describe("GitHubAdapter workspace-profile GitHub account", () => {
  const enterpriseProfile = mustParse(
    parseWorkspaceProfileConfig({
      id: "opn",
      label: "OPN",
      githubHost: "github.opn.example",
      ghAccount: "matthew-opn",
      workspaceRoots: [],
      rulePaths: [],
      repos: [],
    }),
  );

  /** One canned HTTP answer, as the account's credential earned it. */
  type ServedAnswer = { readonly status: number; readonly body: string };

  /**
   * The adapter as production composes it: one `GitHubCliCredentials` shared
   * with the HTTP client, so the profile's own `gh auth token` child is what
   * authenticates every call (ADR 0046). The `Authorization` header each call
   * carried is recorded, because that is where the account now reaches GitHub.
   */
  function servedAdapter(
    executor: CommandExecutor,
    answers: ReadonlyArray<ServedAnswer>,
  ) {
    const authorizations: Array<string | null> = [];
    const commands = new CommandRunner(executor);
    const credentials = new GitHubCliCredentials(commands);
    const http = new GitHubHttpClient(
      credentials,
      undefined,
      undefined,
      async (_url, init) => {
        authorizations.push(new Headers(init.headers).get("authorization"));
        const answer = answers[authorizations.length - 1];
        if (answer === undefined) throw new Error("Missing fake GitHub answer");
        return new Response(answer.body, {
          status: answer.status,
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    return {
      adapter: new GitHubAdapter(commands, credentials, http),
      authorizations,
    };
  }

  function exited(stdout: string): CommandExecution {
    return { _tag: "Exited", exitCode: 0, stdout, stderr: "" };
  }

  const servedPullRequest: ServedAnswer = {
    status: 200,
    body: JSON.stringify(pullRequestPayload()),
  };

  it("authenticates gh as the profile's account, not the machine-wide active account", async () => {
    const executor = new FakeProcessExecutor([exited("profile-token\n")]);
    const served = servedAdapter(executor, [servedPullRequest]);

    await expect(
      served.adapter.getPullRequest({ profile, pr }),
    ).resolves.toMatchObject({ _tag: "ok" });

    expect(executor.requests).toEqual([
      ["gh", "auth", "token", "--hostname", "github.com", "--user", "octo-dev"],
    ]);
    expect(served.authorizations).toEqual(["Bearer profile-token"]);
  });

  it("reads an Enterprise Server host's credential under that host's own account", async () => {
    const executor = new FakeProcessExecutor([exited("enterprise-token\n")]);
    const served = servedAdapter(executor, [servedPullRequest]);

    await served.adapter.getPullRequest({ profile: enterpriseProfile, pr });

    expect(executor.requests[0]).toEqual([
      "gh",
      "auth",
      "token",
      "--hostname",
      "github.opn.example",
      "--user",
      "matthew-opn",
    ]);
    expect(served.authorizations).toEqual(["Bearer enterprise-token"]);
  });

  it("reports authentication failure without dispatching the call when the account has no stored credential", async () => {
    const executor = new FakeProcessExecutor([
      {
        _tag: "Exited",
        exitCode: 1,
        stdout: "",
        stderr: "no oauth token found for github.com account octo-dev",
      },
    ]);
    const served = servedAdapter(executor, []);

    await expect(
      served.adapter.getPullRequest({ profile, pr }),
    ).resolves.toEqual({
      _tag: "err",
      error: { _tag: "GitHubAuthenticationFailed", operation: "get_pr" },
    });
    expect(executor.requests).toHaveLength(1);
    expect(served.authorizations).toEqual([]);
  });

  it("reuses a resolved token and re-reads it after GitHub rejects the credential", async () => {
    const executor = new FakeProcessExecutor([
      exited("token-1\n"),
      exited("token-2\n"),
    ]);
    const served = servedAdapter(executor, [
      servedPullRequest,
      { status: 401, body: JSON.stringify({ message: "Bad credentials" }) },
      servedPullRequest,
    ]);

    await served.adapter.getPullRequest({ profile, pr });
    await served.adapter.getPullRequest({ profile, pr });
    await served.adapter.getPullRequest({ profile, pr });

    expect(executor.requests.map((request) => request.slice(0, 3))).toEqual([
      ["gh", "auth", "token"],
      ["gh", "auth", "token"],
    ]);
    expect(served.authorizations).toEqual([
      "Bearer token-1",
      "Bearer token-1",
      "Bearer token-2",
    ]);
  });

  it("resolves the authenticated account against the profile's own credential", async () => {
    const executor = new FakeProcessExecutor([exited("profile-token\n")]);
    const served = servedAdapter(executor, [
      { status: 200, body: '{"login":"octo-dev"}' },
    ]);

    await expect(
      served.adapter.resolveAuthenticatedAccount(profile),
    ).resolves.toEqual({
      _tag: "ok",
      value: { host: "github.com", account: "octo-dev" },
    });
    expect(served.authorizations).toEqual(["Bearer profile-token"]);
  });
});
