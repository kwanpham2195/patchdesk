import { describe, expect, it, vi } from "vitest";

import {
  CommandRunner,
  normalizeCommandLabel,
  type CommandExecution,
  type CommandExecutor,
  type CommandFailure,
  type CommandRequest,
} from "../../src/adapters/github/command-runner";
import {
  GhRequestRunner,
  httpServedReadLabels,
  type GitHubServedTransport,
} from "../../src/adapters/github/gh-request-runner";
import { GitHubAdapter } from "../../src/adapters/github/github-adapter";
import {
  deleteThreadCommentMutation,
  maintainerInboxSearchQuery,
  mergePolicyQuery,
  repositoryLabelsQuery,
  threadQuery,
} from "../../src/adapters/github/github-graphql-queries";
import { fullJsonMediaType } from "../../src/adapters/github/github-pull-request-reviews";
import { ghInvocationFor } from "../../src/adapters/github/github-request";
import type {
  GitHubGraphQlRequest,
  GitHubRequest,
  GitHubRestRequest,
} from "../../src/adapters/github/github-request";
import { TransportShadow } from "../../src/adapters/github/transport-shadow";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
} from "../../src/domain/ids";
import type { LogEntryInput } from "../../src/domain/log-entry";
import type { PullRequestRef } from "../../src/domain/pull-request";
import { err, ok, type Result } from "../../src/domain/result";
import type { WorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { json, profile, useFixtureServer } from "./github-http-fixture-server";
import { StubCredentials } from "./stub-github-credentials";

/**
 * T1a moved a first set of REST reads off `gh api` onto the HTTP client, and
 * T2 widened the same routing to GraphQL (issue #276). What these tests pin is
 * the routing decision itself: which transport answers, that only one of them
 * runs, that a request the allowlist does not name is untouched, and that a
 * mutation stays on gh whatever its label.
 */

class RecordingGhExecutor implements CommandExecutor {
  /** `normalizeCommandLabel` of every gh invocation, in call order. */
  readonly labels: Array<string> = [];

  constructor(private readonly execution: CommandExecution) {}

  async execute(input: CommandRequest): Promise<CommandExecution> {
    this.labels.push(normalizeCommandLabel(input.argv));
    return this.execution;
  }
}

class RecordingHttpTransport implements GitHubServedTransport {
  readonly requests: Array<GitHubRequest> = [];

  constructor(
    private readonly answer: Result<unknown, CommandFailure> = ok({}),
  ) {}

  async rest(
    _profile: WorkspaceProfileConfig,
    request: GitHubRestRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    this.requests.push(request);
    return this.answer;
  }

  async graphql(
    _profile: WorkspaceProfileConfig,
    request: GitHubGraphQlRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    this.requests.push(request);
    return this.answer;
  }
}

class RecordingShadowTransport {
  readonly requests: Array<GitHubRequest> = [];

  constructor(private readonly answer: Result<unknown, CommandFailure>) {}

  async rest(
    _profile: WorkspaceProfileConfig,
    request: GitHubRestRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    this.requests.push(request);
    return this.answer;
  }

  async graphql(
    _profile: WorkspaceProfileConfig,
    request: GitHubRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    this.requests.push(request);
    return this.answer;
  }
}

const exited = (stdout: string): CommandExecution => ({
  _tag: "Exited",
  exitCode: 0,
  stdout,
  stderr: "",
});

/** Allowlisted reads, as their call sites write them. */
const issueComments: GitHubRestRequest = {
  kind: "rest",
  host: "github.com",
  path: "repos/centraldigital/patchdesk/issues/42/comments?per_page=100&page=1",
};
const pullRequest: GitHubRestRequest = {
  kind: "rest",
  host: "github.com",
  path: "repos/centraldigital/patchdesk/pulls/42",
};
const compare: GitHubRestRequest = {
  kind: "rest",
  host: "github.com",
  accept: "application/vnd.github.v3.diff",
  path: `repos/centraldigital/patchdesk/compare/${"b".repeat(40)}...${"c".repeat(40)}`,
};
/** The two media types the one review-list read is asked for, which share a label. */
const fullReviews: GitHubRestRequest = {
  kind: "rest",
  host: "github.com",
  accept: fullJsonMediaType,
  path: "repos/centraldigital/patchdesk/pulls/42/reviews?per_page=100&page=1",
};
const plainReviews: GitHubRestRequest = {
  kind: "rest",
  host: "github.com",
  path: "repos/centraldigital/patchdesk/pulls/42/reviews?per_page=100&page=1",
};
const reviewComments: GitHubRestRequest = {
  kind: "rest",
  host: "github.com",
  accept: fullJsonMediaType,
  path: "repos/centraldigital/patchdesk/pulls/42/comments?per_page=100&page=1",
};

/** The commits read, which no shadow window has compared, so it stays on gh. */
const commits: GitHubRestRequest = {
  kind: "rest",
  paginate: true,
  host: "github.com",
  path: "repos/centraldigital/patchdesk/pulls/42/commits?per_page=100",
};

/** The three GraphQL queries T2 cut over, as their call sites write them. */
const mergePolicy: GitHubGraphQlRequest = {
  kind: "graphql",
  host: "github.com",
  document: mergePolicyQuery,
  variables: [
    { kind: "typed", name: "owner", value: "centraldigital" },
    { kind: "typed", name: "name", value: "patchdesk" },
    { kind: "typed", name: "number", value: 42 },
  ],
};
const threads: GitHubGraphQlRequest = {
  kind: "graphql",
  host: "github.com",
  document: threadQuery,
  variables: [
    { kind: "typed", name: "owner", value: "centraldigital" },
    { kind: "typed", name: "name", value: "patchdesk" },
    { kind: "typed", name: "number", value: 42 },
  ],
};
const inboxSearch: GitHubGraphQlRequest = {
  kind: "graphql",
  host: "github.com",
  document: maintainerInboxSearchQuery,
  variables: [
    {
      kind: "typed",
      name: "search",
      value: "repo:centraldigital/patchdesk is:pr is:open",
    },
    { kind: "typed", name: "first", value: 25 },
  ],
};

/** A GraphQL read no shadow window has compared either, so it stays on gh too. */
const repositoryLabels: GitHubGraphQlRequest = {
  kind: "graphql",
  host: "github.com",
  document: repositoryLabelsQuery,
  variables: [
    { kind: "typed", name: "owner", value: "centraldigital" },
    { kind: "typed", name: "name", value: "patchdesk" },
  ],
};

function labelFor(request: GitHubRequest): string {
  return normalizeCommandLabel(ghInvocationFor(request).argv);
}

function mustParse<T, E>(result: Result<T, E>): T {
  if (result._tag === "err") throw new Error("Expected test value to parse");
  return result.value;
}

const pr: PullRequestRef = {
  host: mustParse(parseGitHubHost("github.com")),
  owner: mustParse(parseGitHubOwner("centraldigital")),
  repo: mustParse(parseGitHubRepoName("patchdesk")),
  number: mustParse(parsePullRequestNumber(42)),
};

function harness(options: {
  readonly execution?: CommandExecution;
  readonly answer?: Result<unknown, CommandFailure>;
  readonly http?: boolean;
}) {
  const executor = new RecordingGhExecutor(options.execution ?? exited("{}"));
  const http = new RecordingHttpTransport(options.answer ?? ok({}));
  const runner = new GhRequestRunner(
    new CommandRunner(executor),
    new StubCredentials(),
    undefined,
    options.http === false ? undefined : http,
  );
  return { executor, http, runner };
}

describe("httpServedReadLabels", () => {
  it("names labels normalizeCommandLabel actually prints", () => {
    const labels = [
      issueComments,
      pullRequest,
      compare,
      fullReviews,
      plainReviews,
      reviewComments,
    ].map(labelFor);

    expect(labels).toEqual([
      "api GET repos/:owner/:repo/issues/:n/comments",
      "api GET repos/:owner/:repo/pulls/:n",
      "api GET repos/:owner/:repo/compare/:range",
      "api GET repos/:owner/:repo/pulls/:n/reviews",
      "api GET repos/:owner/:repo/pulls/:n/reviews",
      "api GET repos/:owner/:repo/pulls/:n/comments",
    ]);
    for (const label of labels)
      expect(httpServedReadLabels.has(label)).toBe(true);
  });

  it("names the three GraphQL labels a shadow window compared", () => {
    const labels = [mergePolicy, threads, inboxSearch].map(labelFor);

    expect(labels).toEqual([
      "api graphql MergePolicy",
      "api graphql PullRequestThreads",
      "api graphql MaintainerInboxSearch",
    ]);
    for (const label of labels)
      expect(httpServedReadLabels.has(label)).toBe(true);
  });

  it("leaves the commits read, which no shadow window compared, off the list", () => {
    expect(labelFor(commits)).toBe(
      "api GET repos/:owner/:repo/pulls/:n/commits",
    );
    expect(httpServedReadLabels.has(labelFor(commits))).toBe(false);
  });

  it("leaves every other GraphQL query off the list", () => {
    expect(labelFor(repositoryLabels)).toBe("api graphql RepositoryLabels");
    expect(httpServedReadLabels.has(labelFor(repositoryLabels))).toBe(false);
  });
});

describe("routing a read to the HTTP transport", () => {
  it("serves an allowlisted read over HTTP and spawns no gh child", async () => {
    const { executor, http, runner } = harness({
      answer: ok([{ id: 9 }]),
    });

    await expect(runner.ghJson(profile, issueComments)).resolves.toEqual(
      ok([{ id: 9 }]),
    );
    expect(http.requests).toEqual([issueComments]);
    expect(executor.labels).toEqual([]);
  });

  it("leaves a read the allowlist does not name on gh, with no HTTP call", async () => {
    const { executor, http, runner } = harness({
      execution: exited("[[]]"),
    });

    await expect(runner.ghJson(profile, commits)).resolves.toEqual(ok([[]]));
    expect(executor.labels).toEqual([
      "api GET repos/:owner/:repo/pulls/:n/commits",
    ]);
    expect(http.requests).toEqual([]);
  });

  it("serves an allowlisted GraphQL query over HTTP and spawns no gh child", async () => {
    const { executor, http, runner } = harness({
      answer: ok({ data: { repository: null } }),
    });

    await expect(runner.ghJson(profile, mergePolicy)).resolves.toEqual(
      ok({ data: { repository: null } }),
    );
    expect(http.requests).toEqual([mergePolicy]);
    expect(executor.labels).toEqual([]);
  });

  it("keeps a mutation on gh although its label is allowlisted", async () => {
    const { executor, http, runner } = harness({ execution: exited("{}") });
    // A mutation named after an allowlisted query normalizes to that same
    // label, so only the document tells the two apart.
    const request: GitHubGraphQlRequest = {
      kind: "graphql",
      host: "github.com",
      document:
        "mutation MergePolicy($pullRequestId: ID!) { mergePullRequest(input: { pullRequestId: $pullRequestId }) { clientMutationId } }",
      variables: [{ kind: "typed", name: "pullRequestId", value: "PR_1" }],
    };
    expect(httpServedReadLabels.has(labelFor(request))).toBe(true);

    await runner.ghJson(profile, request);

    expect(executor.labels).toEqual(["api graphql MergePolicy"]);
    expect(http.requests).toEqual([]);
  });

  it("keeps a real mutation on gh", async () => {
    const { executor, http, runner } = harness({ execution: exited("{}") });

    await runner.ghJson(profile, {
      kind: "graphql",
      host: "github.com",
      document: deleteThreadCommentMutation,
      variables: [{ kind: "typed", name: "commentId", value: "PRRC_1" }],
    });

    expect(executor.labels).toEqual([
      "api graphql deletePullRequestReviewComment",
    ]);
    expect(http.requests).toEqual([]);
  });

  it("leaves a GraphQL query the allowlist does not name on gh", async () => {
    const { executor, http, runner } = harness({ execution: exited("{}") });

    await runner.ghJson(profile, repositoryLabels);

    expect(executor.labels).toEqual(["api graphql RepositoryLabels"]);
    expect(http.requests).toEqual([]);
  });

  it("leaves every read on gh when no HTTP transport was supplied", async () => {
    const { executor, http, runner } = harness({
      execution: exited("[]"),
      http: false,
    });

    await runner.ghJson(profile, issueComments);

    expect(executor.labels).toEqual([
      "api GET repos/:owner/:repo/issues/:n/comments",
    ]);
    expect(http.requests).toEqual([]);
  });

  it("keeps a write on gh even though its path is an allowlisted read", async () => {
    const { executor, http, runner } = harness({ execution: exited("{}") });

    await runner.ghJson(profile, {
      ...issueComments,
      method: "POST",
      jsonBody: '{"body":"hello"}',
    });

    expect(executor.labels).toEqual([
      "api POST repos/:owner/:repo/issues/:n/comments",
    ]);
    expect(http.requests).toEqual([]);
  });

  it("keeps a body-without-method request on gh although its label matches", async () => {
    const { executor, http, runner } = harness({ execution: exited("{}") });

    // `gh api --input` defaults to POST, so this normalizes to the allowlisted
    // GET label while still being a write.
    const request: GitHubRestRequest = {
      ...issueComments,
      jsonBody: '{"body":"hello"}',
    };
    expect(
      httpServedReadLabels.has(
        normalizeCommandLabel(ghInvocationFor(request).argv),
      ),
    ).toBe(true);

    await runner.ghJson(profile, request);

    expect(executor.labels).toEqual([
      "api GET repos/:owner/:repo/issues/:n/comments",
    ]);
    expect(http.requests).toEqual([]);
  });

  it("returns the HTTP failure without trying gh after it", async () => {
    const { executor, runner } = harness({
      answer: err({ _tag: "CommandUnavailable" }),
    });

    await expect(runner.ghJson(profile, issueComments)).resolves.toEqual(
      err({ _tag: "CommandUnavailable" }),
    );
    expect(executor.labels).toEqual([]);
  });

  it("shadows only the reads the allowlist leaves on gh", async () => {
    const entries: Array<LogEntryInput> = [];
    const shadowTransport = new RecordingShadowTransport(ok([[]]));
    const credentials = new StubCredentials();
    const runner = new GhRequestRunner(
      new CommandRunner(new RecordingGhExecutor(exited("[[]]"))),
      credentials,
      new TransportShadow(shadowTransport, credentials, (entry) =>
        entries.push(entry),
      ),
      new RecordingHttpTransport(ok([[]])),
    );

    await runner.ghJson(profile, issueComments);
    await runner.ghJson(profile, commits);

    // The comparison is detached, so wait for the one entry it writes.
    await vi.waitFor(() => expect(entries).toHaveLength(1));
    expect(entries[0]?.meta).toMatchObject({
      label: "api GET repos/:owner/:repo/pulls/:n/commits",
      outcome: "match",
    });
    expect(shadowTransport.requests).toEqual([commits]);
  });
});

describe("reads served over the real HTTP client", () => {
  const server = useFixtureServer();

  function adapter(): GitHubAdapter {
    const credentials = new StubCredentials();
    return new GitHubAdapter(
      new CommandRunner(
        new RecordingGhExecutor({
          _tag: "Exited",
          exitCode: 1,
          stdout: "",
          stderr: "no gh child may run for a served read",
        }),
      ),
      credentials,
      undefined,
      server.client(credentials),
    );
  }

  it("reads a 404 on branch protection as the unprotected-branch evidence", async () => {
    server.respondWith(json(404, { message: "Branch not protected" }));

    const read = await adapter().readBranchProtection({
      profile,
      pr,
      branch: "main",
    });

    expect(read.dismissal).toEqual(
      ok({ protected: false, allowedDismissers: [] }),
    );
    expect(server.requests()[0]?.url).toBe(
      "/repos/centraldigital/patchdesk/branches/main/protection",
    );
  });

  it("parses the authenticated login out of the whole user body", async () => {
    server.respondWith(json(200, { login: "pmquan2cfw", id: 1 }));

    await expect(
      adapter().resolveAuthenticatedAccount(profile),
    ).resolves.toEqual(ok({ host: "github.com", account: "pmquan2cfw" }));
    expect(server.requests()[0]?.url).toBe("/user");
  });

  /**
   * gh's `-F` inferred each variable's type from its text and `-f` always sent
   * a String. The client infers from the same text, so these three call sites
   * have to reach GitHub with the types they reached it with through gh.
   */
  it("sends the merge policy variables with the types gh sent", async () => {
    server.respondWith(json(200, { data: { repository: null } }));

    await adapter().getMergePolicy({
      profile,
      pr,
      expectedHeadSha: mustParse(parseGitSha("b".repeat(40))),
    });

    expect(server.requests()[0]?.url).toBe("/graphql");
    expect(JSON.parse(server.requests()[0]?.body ?? "")).toEqual({
      query: mergePolicyQuery,
      variables: { owner: "centraldigital", name: "patchdesk", number: 42 },
    });
  });

  it("sends the review thread variables with the types gh sent", async () => {
    server.respondWith(json(200, { data: { repository: null } }));

    await adapter().getPullRequestComments({ profile, pr });

    expect(JSON.parse(server.requests()[0]?.body ?? "")).toEqual({
      query: threadQuery,
      variables: { owner: "centraldigital", name: "patchdesk", number: 42 },
    });
  });

  it("sends the inbox search variables with the types gh sent", async () => {
    server.respondWith(json(200, { data: { search: null } }));

    await adapter().searchMaintainerPullRequests({
      profile,
      repo: pr,
      searchQuery: "repo:centraldigital/patchdesk is:pr is:open",
      state: "open",
      pageSize: 25,
      cursor: "Y3Vyc29yOnYyOpHOAAE",
    });

    expect(JSON.parse(server.requests()[0]?.body ?? "")).toEqual({
      query: maintainerInboxSearchQuery,
      variables: {
        search: "repo:centraldigital/patchdesk is:pr is:open",
        first: 25,
        cursor: "Y3Vyc29yOnYyOpHOAAE",
      },
    });
  });

  it("still learns the rate limit the inbox search carries (ADR 0023)", async () => {
    const resetAt = "2099-01-01T00:00:00Z";
    server.respondWith(
      json(200, {
        data: {
          rateLimit: { remaining: 0, resetAt },
          search: {
            issueCount: 0,
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    );
    const github = adapter();

    await github.searchMaintainerPullRequests({
      profile,
      repo: pr,
      searchQuery: "repo:centraldigital/patchdesk is:pr is:open",
      state: "open",
      pageSize: 25,
    });
    // A host whose whole budget is spent answers without asking GitHub again.
    const watched = await github.readWatchedPullRequests({
      profile,
      refs: [pr],
      now: mustParse(parseIsoTimestamp("2026-09-19T00:00:00.000Z")),
    });

    expect(watched).toEqual(
      err({
        _tag: "GitHubRateLimited",
        operation: "get_watched_prs",
        resumeAt: "2099-01-01T00:00:00.000Z",
      }),
    );
    expect(server.requests()).toHaveLength(1);
  });
});
