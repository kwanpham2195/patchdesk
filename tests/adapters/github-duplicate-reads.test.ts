import { describe, expect, it } from "vitest";

import {
  jsonAnswer,
  noChildProcesses,
  routedTransport,
  type CannedAnswer,
  type HttpTransportDouble,
} from "./github-transport-doubles";
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
    id: "acme",
    label: "ACME",
    githubHost: "github.com",
    ghAccount: "octo-dev",
    workspaceRoots: [],
    rulePaths: [],
    repos: [],
  }),
);

const pr: PullRequestRef = {
  host: mustParse(parseGitHubHost("github.com")),
  owner: mustParse(parseGitHubOwner("octo-org")),
  repo: mustParse(parseGitHubRepoName("patchdesk")),
  number: mustParse(parsePullRequestNumber(42)),
};

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
 * requests one adapter call makes without also fixing their order.
 * `overrides` replaces one endpoint's answer, so a test can choose how that
 * read fails.
 */
function transportAnswering(
  overrides: {
    readonly protection?: CannedAnswer;
    readonly reviews?: CannedAnswer;
  } = {},
): HttpTransportDouble {
  return routedTransport((label) => {
    if (label.startsWith("api graphql")) return jsonAnswer(threadPayload);
    switch (label) {
      case "api GET repos/:owner/:repo/pulls/:n":
        return jsonAnswer(pullRequestPayload);
      case "api GET repos/:owner/:repo/pulls/:n/reviews":
        return overrides.reviews ?? jsonAnswer([]);
      case "api GET repos/:owner/:repo/pulls/:n/comments":
      case "api GET repos/:owner/:repo/issues/:n/comments":
        return jsonAnswer([]);
      case "api GET user":
        return jsonAnswer({ login: "octo-dev" });
      case "api GET repos/:owner/:repo/collaborators/:user/permission":
        return jsonAnswer({ role_name: "write" });
      case "api GET repos/:owner/:repo/branches/:branch/protection":
        return (
          overrides.protection ??
          jsonAnswer({ required_pull_request_reviews: null })
        );
      case "api GET repos/:owner/:repo/rules/branches/:branch":
        return jsonAnswer([]);
      case "api GET repos/:owner/:repo/pulls/:n/commits":
        return jsonAnswer([commitsPage]);
      default:
        throw new Error(`Unrouted GitHub request: ${label}`);
    }
  });
}

function adapterOver(transport: HttpTransportDouble): GitHubAdapter {
  return new GitHubAdapter(
    noChildProcesses(),
    new StubCredentials(),
    transport,
  );
}

describe("resolveAuthenticatedAccount request cost", () => {
  it("asks GitHub once per cached credential, not once per caller", async () => {
    const transport = transportAnswering();
    const credentials = new StubCredentials();
    const adapter = new GitHubAdapter(
      noChildProcesses(),
      credentials,
      transport,
    );

    const expected = { host: "github.com", account: "octo-dev" };
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
    expect(transport.labels).toEqual(["api GET user"]);

    // The proof belongs to the credential: dropping it re-reads GitHub.
    credentials.forget(profile);
    await expect(adapter.resolveAuthenticatedAccount(profile)).resolves.toEqual(
      { _tag: "ok", value: expected },
    );
    expect(transport.labels).toEqual(["api GET user", "api GET user"]);
  });
});

describe("getPullRequestCommits request cost", () => {
  it("reads the pull request only to mark isHead when the caller supplied no head", async () => {
    const transport = transportAnswering();
    const adapter = adapterOver(transport);

    await expect(
      adapter.getPullRequestCommits({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: [
        { sha: headSha, isHead: true },
        { sha: olderSha, isHead: false },
      ],
    });

    expect(transport.labels).toEqual([
      "api GET repos/:owner/:repo/pulls/:n",
      "api GET repos/:owner/:repo/pulls/:n/commits",
    ]);
  });

  it("spends one call, not two, when the caller already holds the head", async () => {
    const transport = transportAnswering();
    const adapter = adapterOver(transport);

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

    expect(transport.labels).toEqual([
      "api GET repos/:owner/:repo/pulls/:n/commits",
    ]);
  });
});

describe("getPullRequestPublishedFeedback request cost", () => {
  it("reads the pull request for its base branch when the caller supplied none", async () => {
    const transport = transportAnswering();
    const adapter = adapterOver(transport);

    await expect(
      adapter.getPullRequestPublishedFeedback({ profile, pr }),
    ).resolves.toMatchObject({ _tag: "ok" });

    expect(transport.labels).toContain("api GET repos/:owner/:repo/pulls/:n");
    expect(transport.labels).toContain(
      "api GET repos/:owner/:repo/branches/:branch/protection",
    );
  });

  it("spends no pull request read when the caller already holds the base branch", async () => {
    const transport = transportAnswering();
    const adapter = adapterOver(transport);

    await expect(
      adapter.getPullRequestPublishedFeedback({
        profile,
        pr,
        baseBranch: "sit",
      }),
    ).resolves.toMatchObject({ _tag: "ok" });

    expect(transport.labels).not.toContain(
      "api GET repos/:owner/:repo/pulls/:n",
    );
    expect(transport.labels).toContain(
      "api GET repos/:owner/:repo/branches/:branch/protection",
    );
  });
});

const protectionLabel =
  "api GET repos/:owner/:repo/branches/:branch/protection";

/** GitHub refusing the protection read, with no reason it names. */
const forbiddenProtection: CannedAnswer = {
  _tag: "CommandForbidden",
  reason: "unknown",
};

describe("branch protection request cost", () => {
  it("reads the protection endpoint twice when each consumer reads it itself", async () => {
    const transport = transportAnswering();
    const adapter = adapterOver(transport);

    await adapter.getPullRequestPublishedFeedback({
      profile,
      pr,
      baseBranch: "sit",
    });
    await adapter.getMergePolicyEvidence({ profile, pr, branch: "sit" });

    expect(
      transport.labels.filter((label) => label === protectionLabel),
    ).toHaveLength(2);
  });

  it("spends one protection read for both consumers of a cycle", async () => {
    const transport = transportAnswering();
    const adapter = adapterOver(transport);

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
      transport.labels.filter((label) => label === protectionLabel),
    ).toHaveLength(1);
  });

  it("keeps each consumer's reading of a forbidden protection response", async () => {
    const adapter = adapterOver(
      transportAnswering({ protection: forbiddenProtection }),
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

const account = mustParse(parseGitHubLogin("octo-dev"));

describe("pull request reviews request cost", () => {
  it("reads the reviews endpoint twice when each consumer reads it itself", async () => {
    const transport = transportAnswering();
    const adapter = adapterOver(transport);

    await adapter.getPullRequestPublishedFeedback({
      profile,
      pr,
      baseBranch: "sit",
    });
    await adapter.getViewerPendingReview({ profile, pr, account });

    expect(transport.labels.filter((label) => label === reviewsLabel)).toEqual([
      reviewsLabel,
      reviewsLabel,
    ]);
  });

  it("spends one reviews read for both consumers of a cycle", async () => {
    const transport = transportAnswering();
    const adapter = adapterOver(transport);

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

    expect(transport.labels.filter((label) => label === reviewsLabel)).toEqual([
      reviewsLabel,
    ]);
  });

  it("keeps each consumer's operation name when the shared reviews read failed", async () => {
    const adapter = adapterOver(
      transportAnswering({ reviews: { _tag: "CommandUnavailable" } }),
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
