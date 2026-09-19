import { describe, expect, it } from "vitest";

import {
  CommandRunner,
  normalizeCommandLabel,
  type CommandExecution,
  type CommandExecutor,
} from "../../src/adapters/github/command-runner";
import { GitHubAdapter } from "../../src/adapters/github/github-adapter";
import { StubCredentials } from "./stub-github-credentials";
import {
  parseGitHubHost,
  parseGitHubLogin,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parsePullRequestNumber,
} from "../../src/domain/ids";
import { type PullRequestRef } from "../../src/domain/pull-request";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";

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

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a fixture writer for whatever JSON one gh call is told to return; there is no narrower contract to parse it against.
function json(value: unknown): CommandExecution {
  return {
    _tag: "Exited",
    exitCode: 0,
    stdout: JSON.stringify(value),
    stderr: "",
  };
}

const pullRequestPayload = {
  number: 42,
  title: "Add safe GitHub reads",
  state: "open",
  draft: false,
  head: { ref: "feat/github-read", sha: headSha },
  base: { ref: "sit" },
  user: { login: "reviewer" },
  updated_at: "2026-07-16T12:00:00Z",
  mergeable_state: "clean",
};

const threadPayload = {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  },
};

const olderSha = "1111111111111111111111111111111111111111";

const commitsPage = [
  {
    sha: olderSha,
    commit: {
      message: "Older change",
      author: { name: "Older", date: "2026-07-16T11:00:00Z" },
    },
  },
  {
    sha: headSha,
    commit: {
      message: "Head change",
      author: { name: "Head", date: "2026-07-16T12:00:00Z" },
    },
  },
];

/**
 * Answers by endpoint rather than by position, so a test can count how many
 * gh invocations one adapter call makes without also fixing their order.
 */
class RoutingExecutor implements CommandExecutor {
  /** `normalizeCommandLabel` of every gh invocation, in call order. */
  readonly labels: Array<string> = [];

  /** Replaces one endpoint's answer, so a test can choose how that read fails. */
  constructor(
    private readonly overrides: {
      readonly protection?: CommandExecution;
      readonly reviews?: CommandExecution;
    } = {},
  ) {}

  async execute(input: {
    readonly argv: ReadonlyArray<string>;
  }): Promise<CommandExecution> {
    const label = normalizeCommandLabel(input.argv);
    this.labels.push(label);
    if (label.startsWith("api graphql")) return json(threadPayload);
    switch (label) {
      case "api GET repos/:owner/:repo/pulls/:n":
        return json(pullRequestPayload);
      case "api GET repos/:owner/:repo/pulls/:n/reviews":
        return this.overrides.reviews ?? json([]);
      case "api GET repos/:owner/:repo/pulls/:n/comments":
      case "api GET repos/:owner/:repo/issues/:n/comments":
        return json([]);
      case "api GET user":
        return {
          _tag: "Exited",
          exitCode: 0,
          stdout: "pmquan2cfw\n",
          stderr: "",
        };
      case "api GET repos/:owner/:repo/collaborators/:user/permission":
        return json({ role_name: "write" });
      case "api GET repos/:owner/:repo/branches/:branch/protection":
        return (
          this.overrides.protection ??
          json({ required_pull_request_reviews: null })
        );
      case "api GET repos/:owner/:repo/rules/branches/:branch":
        return json([]);
      case "api GET repos/:owner/:repo/pulls/:n/commits":
        return json([commitsPage]);
      default:
        throw new Error(`Unrouted gh call: ${label}`);
    }
  }
}

describe("resolveAuthenticatedAccount gh cost", () => {
  it("asks GitHub once per cached credential, not once per caller", async () => {
    const executor = new RoutingExecutor();
    const credentials = new StubCredentials();
    const adapter = new GitHubAdapter(new CommandRunner(executor), credentials);

    const expected = { host: "github.com", account: "pmquan2cfw" };
    await expect(adapter.resolveAuthenticatedAccount(profile)).resolves.toEqual(
      { _tag: "ok", value: expected },
    );
    await expect(adapter.resolveAuthenticatedAccount(profile)).resolves.toEqual(
      { _tag: "ok", value: expected },
    );
    await expect(adapter.resolveAuthenticatedAccount(profile)).resolves.toEqual(
      { _tag: "ok", value: expected },
    );

    // One `GET user` for the three an observation makes.
    expect(executor.labels).toEqual(["api GET user"]);

    // The proof belongs to the credential: dropping it re-reads GitHub.
    credentials.forget(profile);
    await expect(adapter.resolveAuthenticatedAccount(profile)).resolves.toEqual(
      { _tag: "ok", value: expected },
    );
    expect(executor.labels).toEqual(["api GET user", "api GET user"]);
  });
});

describe("getPullRequestCommits gh cost", () => {
  it("reads the pull request only to mark isHead when the caller supplied no head", async () => {
    const executor = new RoutingExecutor();
    const adapter = new GitHubAdapter(
      new CommandRunner(executor),
      new StubCredentials(),
    );

    await expect(
      adapter.getPullRequestCommits({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: [
        { sha: headSha, isHead: true },
        { sha: olderSha, isHead: false },
      ],
    });

    expect(executor.labels).toEqual([
      "api GET repos/:owner/:repo/pulls/:n",
      "api GET repos/:owner/:repo/pulls/:n/commits",
    ]);
  });

  it("spends one call, not two, when the caller already holds the head", async () => {
    const executor = new RoutingExecutor();
    const adapter = new GitHubAdapter(
      new CommandRunner(executor),
      new StubCredentials(),
    );

    await expect(
      adapter.getPullRequestCommits({
        profile,
        pr,
        headSha: mustParse(parseGitSha(headSha)),
      }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: [
        { sha: headSha, isHead: true },
        { sha: olderSha, isHead: false },
      ],
    });

    expect(executor.labels).toEqual([
      "api GET repos/:owner/:repo/pulls/:n/commits",
    ]);
  });
});

describe("getPullRequestPublishedFeedback gh cost", () => {
  it("reads the pull request for its base branch when the caller supplied none", async () => {
    const executor = new RoutingExecutor();
    const adapter = new GitHubAdapter(
      new CommandRunner(executor),
      new StubCredentials(),
    );

    await expect(
      adapter.getPullRequestPublishedFeedback({ profile, pr }),
    ).resolves.toMatchObject({ _tag: "ok" });

    expect(executor.labels).toContain("api GET repos/:owner/:repo/pulls/:n");
    expect(executor.labels).toContain(
      "api GET repos/:owner/:repo/branches/:branch/protection",
    );
  });

  it("spends no pull request read when the caller already holds the base branch", async () => {
    const executor = new RoutingExecutor();
    const adapter = new GitHubAdapter(
      new CommandRunner(executor),
      new StubCredentials(),
    );

    await expect(
      adapter.getPullRequestPublishedFeedback({
        profile,
        pr,
        baseBranch: "sit",
      }),
    ).resolves.toMatchObject({ _tag: "ok" });

    expect(executor.labels).not.toContain(
      "api GET repos/:owner/:repo/pulls/:n",
    );
    expect(executor.labels).toContain(
      "api GET repos/:owner/:repo/branches/:branch/protection",
    );
  });
});

const protectionLabel =
  "api GET repos/:owner/:repo/branches/:branch/protection";

const forbiddenProtection: CommandExecution = {
  _tag: "Exited",
  exitCode: 1,
  stdout: "",
  stderr: "HTTP 403: Resource not accessible by integration",
};

describe("branch protection gh cost", () => {
  it("reads the protection endpoint twice when each consumer reads it itself", async () => {
    const executor = new RoutingExecutor();
    const adapter = new GitHubAdapter(
      new CommandRunner(executor),
      new StubCredentials(),
    );

    await adapter.getPullRequestPublishedFeedback({
      profile,
      pr,
      baseBranch: "sit",
    });
    await adapter.getMergePolicyEvidence({ profile, pr, branch: "sit" });

    expect(
      executor.labels.filter((label) => label === protectionLabel),
    ).toHaveLength(2);
  });

  it("spends one protection read for both consumers of a cycle", async () => {
    const executor = new RoutingExecutor();
    const adapter = new GitHubAdapter(
      new CommandRunner(executor),
      new StubCredentials(),
    );

    const branchProtection = await adapter.readBranchProtection({
      profile,
      pr,
      branch: "sit",
    });
    await expect(
      adapter.getPullRequestPublishedFeedback({
        profile,
        pr,
        baseBranch: "sit",
        branchProtection,
      }),
    ).resolves.toMatchObject({ _tag: "ok" });
    await expect(
      adapter.getMergePolicyEvidence({
        profile,
        pr,
        branch: "sit",
        branchProtection,
      }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { branchProtection: { state: "available" } },
    });

    expect(
      executor.labels.filter((label) => label === protectionLabel),
    ).toHaveLength(1);
  });

  it("keeps each consumer's reading of a forbidden protection response", async () => {
    const executor = new RoutingExecutor({ protection: forbiddenProtection });
    const adapter = new GitHubAdapter(
      new CommandRunner(executor),
      new StubCredentials(),
    );

    // The same failure is fail-closed dismissal evidence and merely
    // unavailable display evidence, which is why one response carries two
    // Results rather than one.
    await expect(
      adapter.readBranchProtection({ profile, pr, branch: "sit" }),
    ).resolves.toMatchObject({
      dismissal: { _tag: "err" },
      evidence: {
        _tag: "ok",
        value: { state: "unavailable", reason: "forbidden" },
      },
    });
  });
});

const reviewsLabel = "api GET repos/:owner/:repo/pulls/:n/reviews";

const account = mustParse(parseGitHubLogin("pmquan2cfw"));

describe("pull request reviews gh cost", () => {
  it("reads the reviews endpoint twice when each consumer reads it itself", async () => {
    const executor = new RoutingExecutor();
    const adapter = new GitHubAdapter(
      new CommandRunner(executor),
      new StubCredentials(),
    );

    await adapter.getPullRequestPublishedFeedback({
      profile,
      pr,
      baseBranch: "sit",
    });
    await adapter.getViewerPendingReview({ profile, pr, account });

    expect(executor.labels.filter((label) => label === reviewsLabel)).toEqual([
      reviewsLabel,
      reviewsLabel,
    ]);
  });

  it("spends one reviews read for both consumers of a cycle", async () => {
    const executor = new RoutingExecutor();
    const adapter = new GitHubAdapter(
      new CommandRunner(executor),
      new StubCredentials(),
    );

    const reviews = await adapter.readPullRequestReviews({ profile, pr });
    await expect(
      adapter.getPullRequestPublishedFeedback({
        profile,
        pr,
        baseBranch: "sit",
        reviews,
      }),
    ).resolves.toMatchObject({ _tag: "ok" });
    await expect(
      adapter.getViewerPendingReview({ profile, pr, account, reviews }),
    ).resolves.toMatchObject({ _tag: "ok", value: { _tag: "None" } });

    expect(executor.labels.filter((label) => label === reviewsLabel)).toEqual([
      reviewsLabel,
    ]);
  });

  it("keeps each consumer's operation name when the shared reviews read failed", async () => {
    const executor = new RoutingExecutor({
      reviews: {
        _tag: "Exited",
        exitCode: 1,
        stdout: "",
        stderr: "HTTP 500: Internal Server Error",
      },
    });
    const adapter = new GitHubAdapter(
      new CommandRunner(executor),
      new StubCredentials(),
    );

    const reviews = await adapter.readPullRequestReviews({ profile, pr });
    await expect(
      adapter.getPullRequestPublishedFeedback({
        profile,
        pr,
        baseBranch: "sit",
        reviews,
      }),
    ).resolves.toMatchObject({
      _tag: "err",
      error: { operation: "get_reviews" },
    });
    await expect(
      adapter.getViewerPendingReview({ profile, pr, account, reviews }),
    ).resolves.toMatchObject({
      _tag: "err",
      error: { operation: "get_pending_review" },
    });
  });
});
