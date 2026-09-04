import { describe, expect, it } from "vitest";

import {
  CommandRunner,
  type CommandExecution,
  type CommandExecutor,
  type CommandFailure,
} from "../../src/adapters/github/command-runner";
import { GitHubAdapter } from "../../src/adapters/github/github-adapter";
import { type GitHubCredentials } from "../../src/adapters/github/github-credentials";
import { assembleConversationEntries } from "../../src/adapters/github/github-wire-projections";
import type {
  GitHubComments,
  GitHubPublishedFeedback,
} from "../../src/domain/github-context";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parsePullRequestNumber,
} from "../../src/domain/ids";
import { type PullRequestRef } from "../../src/domain/pull-request";
import { ok, type Result } from "../../src/domain/result";
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

class FakeProcessExecutor implements CommandExecutor {
  readonly requests: Array<ReadonlyArray<string>> = [];

  constructor(private readonly responses: ReadonlyArray<CommandExecution>) {}

  async execute(input: {
    readonly argv: ReadonlyArray<string>;
    readonly timeoutMs: number;
    readonly stdin?: string;
    readonly environment?: Readonly<Record<string, string>>;
  }): Promise<CommandExecution> {
    this.requests.push(input.argv);
    const response = this.responses[this.requests.length - 1];
    if (response === undefined)
      throw new Error("Missing fake command response");
    return response;
  }
}

/** Resolves a fixed credential so command expectations stay about gh argv. */
class StubCredentials implements GitHubCredentials {
  async environmentFor(): Promise<
    Result<Readonly<Record<string, string>>, CommandFailure>
  > {
    return ok({ GH_TOKEN: "profile-token" });
  }

  forget(): void {}
}

function testAdapter(executor: CommandExecutor): GitHubAdapter {
  return new GitHubAdapter(new CommandRunner(executor), new StubCredentials());
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a fixture writer for whatever JSON one gh call is told to return; there is no narrower contract to parse it against.
function json(value: unknown): CommandExecution {
  return {
    _tag: "Exited",
    exitCode: 0,
    stdout: JSON.stringify(value),
    stderr: "",
  };
}

const account: CommandExecution = {
  _tag: "Exited",
  exitCode: 0,
  stdout: "pmquan2cfw\n",
  stderr: "",
};

function pullRequestPayload() {
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
  };
}

const approvedReview = {
  id: 7,
  user: { login: "pmquan2cfw" },
  body: "ok",
  state: "APPROVED",
  submitted_at: "2026-08-01T00:00:00Z",
};

const reviewComment = {
  id: 8,
  user: { login: "pmquan2cfw" },
  body: "comment",
  created_at: "2026-08-01T00:00:00Z",
};

/**
 * The gh calls `getPullRequestPublishedFeedback` makes, in order: reviews,
 * review comments, issue comments, `auth status`, pull request, then the
 * sequential permission and branch-protection reads. `FakeProcessExecutor`
 * answers positionally, so every fixture below is written in that order.
 */
function feedbackResponses(input: {
  readonly reviews: ReadonlyArray<unknown>;
  readonly comments: ReadonlyArray<unknown>;
  readonly issueComments: ReadonlyArray<unknown>;
  readonly permission: CommandExecution;
  readonly protection?: CommandExecution;
}): ReadonlyArray<CommandExecution> {
  const responses = [
    json(input.reviews),
    json(input.comments),
    json(input.issueComments),
    account,
    json(pullRequestPayload()),
    input.permission,
  ];
  return input.protection === undefined
    ? responses
    : [...responses, input.protection];
}

describe("GitHubAdapter Published feedback capabilities", () => {
  it("requires authenticated owner and repository/branch evidence", async () => {
    const executor = new FakeProcessExecutor(
      feedbackResponses({
        reviews: [approvedReview],
        comments: [reviewComment],
        issueComments: [],
        permission: json({ role_name: "write" }),
        protection: json({ required_pull_request_reviews: null }),
      }),
    );
    const result = await testAdapter(executor).getPullRequestPublishedFeedback({
      profile,
      pr,
    });
    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        comments: [{ id: "8", canEdit: true, canDelete: true }],
        reviews: [{ id: "7", canDismiss: true }],
      },
    });
  });

  it("projects dismissal capability when GitHub reports an unprotected base branch as 404", async () => {
    const executor = new FakeProcessExecutor(
      feedbackResponses({
        reviews: [approvedReview],
        comments: [],
        issueComments: [],
        permission: json({ role_name: "write" }),
        protection: {
          _tag: "Exited",
          exitCode: 1,
          stdout: "",
          stderr: "HTTP 404: Branch not protected",
        },
      }),
    );
    await expect(
      testAdapter(executor).getPullRequestPublishedFeedback({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { reviews: [{ id: "7", canDismiss: true }] },
    });
  });

  it("fails closed when permission evidence is malformed while retaining records", async () => {
    const executor = new FakeProcessExecutor(
      feedbackResponses({
        reviews: [],
        comments: [reviewComment],
        issueComments: [],
        permission: json({ permission: "owner" }),
      }),
    );
    await expect(
      testAdapter(executor).getPullRequestPublishedFeedback({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { comments: [{ id: "8", canEdit: false, canDelete: false }] },
    });
  });

  it("skips PENDING reviews that GitHub omits submitted_at for instead of failing the read", async () => {
    // A started-but-unsubmitted review has no submitted_at key at all; the
    // feedback read must tolerate it (and later detect/refresh passes) rather
    // than reporting GitHubResponseInvalid.
    const executor = new FakeProcessExecutor(
      feedbackResponses({
        reviews: [
          { id: 6, user: { login: "pmquan2cfw" }, body: "", state: "PENDING" },
          approvedReview,
        ],
        comments: [],
        issueComments: [],
        permission: json({ role_name: "write" }),
        protection: json({ required_pull_request_reviews: null }),
      }),
    );
    await expect(
      testAdapter(executor).getPullRequestPublishedFeedback({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { reviews: [{ id: "7", canDismiss: true }] },
    });
  });
});

describe("GitHubAdapter issue comments", () => {
  it("reads the issues endpoint and projects a plain conversation comment", async () => {
    const executor = new FakeProcessExecutor(
      feedbackResponses({
        reviews: [],
        comments: [],
        issueComments: [
          {
            id: 9,
            node_id: "IC_9",
            user: {
              login: "pmquan2cfw",
              avatar_url: "https://avatars.example/pmquan2cfw",
            },
            body: "![shot](https://github.com/user-attachments/assets/1)",
            created_at: "2026-08-02T00:00:00Z",
            updated_at: "2026-08-03T00:00:00Z",
            html_url: "https://github.com/centraldigital/patchdesk/pull/42",
          },
        ],
        permission: json({ role_name: "write" }),
        protection: json({ required_pull_request_reviews: null }),
      }),
    );
    const result = await testAdapter(executor).getPullRequestPublishedFeedback({
      profile,
      pr,
    });
    expect(executor.requests[2]?.at(-1)).toBe(
      "repos/centraldigital/patchdesk/issues/42/comments?per_page=100&page=1",
    );
    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        comments: [],
        issueComments: [
          {
            id: "9",
            nodeId: "IC_9",
            author: "pmquan2cfw",
            authorAvatarUrl: "https://avatars.example/pmquan2cfw",
            body: "![shot](https://github.com/user-attachments/assets/1)",
            createdAt: "2026-08-02T00:00:00.000Z",
            updatedAt: "2026-08-03T00:00:00.000Z",
            url: "https://github.com/centraldigital/patchdesk/pull/42",
            canEdit: true,
            canDelete: true,
          },
        ],
        complete: true,
      },
    });
  });

  it("accepts a comment with no user and a body at the schema's size limit", async () => {
    const body = "a".repeat(65_536);
    const executor = new FakeProcessExecutor(
      feedbackResponses({
        reviews: [],
        comments: [],
        issueComments: [
          { id: 10, user: null, body, created_at: "2026-08-02T00:00:00Z" },
        ],
        permission: json({ role_name: "write" }),
        protection: json({ required_pull_request_reviews: null }),
      }),
    );
    const result = await testAdapter(executor).getPullRequestPublishedFeedback({
      profile,
      pr,
    });
    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        issueComments: [
          { id: "10", author: "ghost", canEdit: false, canDelete: false },
        ],
      },
    });
    // A deleted account owns nothing, and GitHub anchors no issue comment to
    // a diff line, so neither editability nor a location may be invented.
    if (result._tag === "err") return;
    expect(result.value.issueComments[0]).not.toHaveProperty("location");
    expect(result.value.issueComments[0]?.body).toHaveLength(65_536);
  });

  it("reports the read as incomplete when the issue comment page is full", async () => {
    const executor = new FakeProcessExecutor(
      feedbackResponses({
        reviews: [],
        comments: [],
        issueComments: Array.from({ length: 100 }, (_, index) => ({
          id: index,
          user: { login: "reviewer" },
          body: "comment",
          created_at: "2026-08-02T00:00:00Z",
        })),
        permission: json({ role_name: "write" }),
        protection: json({ required_pull_request_reviews: null }),
      }),
    );
    await expect(
      testAdapter(executor).getPullRequestPublishedFeedback({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { complete: false, incompleteReason: "pagination" },
    });
  });

  it("fails the read when GitHub cannot serve the issue comments", async () => {
    const executor = new FakeProcessExecutor([
      json([]),
      json([]),
      { _tag: "Exited", exitCode: 1, stdout: "", stderr: "HTTP 500" },
      account,
      json(pullRequestPayload()),
    ]);
    await expect(
      testAdapter(executor).getPullRequestPublishedFeedback({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "err",
      error: { operation: "get_issue_comments" },
    });
  });
});

describe("assembleConversationEntries", () => {
  it("orders every entry kind by its own timestamp", () => {
    const comment = (id: string, createdAt: string) => ({
      id,
      author: "reviewer",
      body: id,
      // SAFETY: a plain ISO-8601 string already satisfies IsoTimestamp's runtime shape; the brand only exists for compile-time cross-boundary safety, so these fixture literals may bypass it directly.
      createdAt: createdAt as never,
      canEdit: false,
      canDelete: false,
    });
    const feedback: GitHubPublishedFeedback = {
      reviews: [
        {
          id: "review",
          author: "reviewer",
          body: "",
          event: "APPROVED",
          submittedAt: "2026-08-01T03:00:00.000Z" as never,
          canDismiss: false,
        },
      ],
      comments: [comment("review-comment", "2026-08-01T02:00:00.000Z")],
      issueComments: [comment("issue-comment", "2026-08-01T04:00:00.000Z")],
    };
    const threads: GitHubComments = {
      threads: [
        {
          id: "thread" as never,
          state: "open",
          comments: [comment("thread-comment", "2026-08-01T01:00:00.000Z")],
        },
        // An anchored thread belongs to the diff, never the timeline (ADR 0028).
        {
          id: "anchored" as never,
          state: "open",
          comments: [comment("anchored-comment", "2026-08-01T00:00:00.000Z")],
          location: { path: "src/a.ts" as never, line: 4 },
        },
      ],
    };
    expect(
      assembleConversationEntries(feedback, threads).map((entry) => entry._tag),
    ).toEqual([
      "GeneralThread",
      "ReviewComment",
      "ReviewSummary",
      "IssueComment",
    ]);
  });
});
