import { StubCredentials } from "./stub-github-credentials";
import { describe, expect, it } from "vitest";

import {
  jsonAnswer,
  noChildProcesses,
  orderedTransport,
  type CannedAnswer,
  type HttpTransportDouble,
} from "./github-transport-doubles";
import { GitHubAdapter } from "../../src/adapters/github/github-adapter";
import { assembleConversationEntries } from "../../src/adapters/github/github-conversation-assembly";
import type {
  GitHubRequest,
  GitHubRestRequest,
} from "../../src/adapters/github/github-request";
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

function testAdapter(transport: HttpTransportDouble): GitHubAdapter {
  return new GitHubAdapter(
    noChildProcesses(),
    new StubCredentials(),
    transport,
  );
}

/** The recorded request, narrowed to the REST shape these reads send. */
function restRequest(request: GitHubRequest | undefined): GitHubRestRequest {
  if (request?.kind !== "rest") throw new Error("Expected a REST request");
  return request;
}

const account = jsonAnswer({ login: "pmquan2cfw" });

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
 * The requests `getPullRequestPublishedFeedback` makes, in order: reviews,
 * review comments, issue comments, the authenticated account, pull request,
 * then the sequential permission and branch-protection reads. The transport
 * double answers positionally, so every fixture below is written in that order.
 */
function feedbackAnswers(input: {
  readonly reviews: ReadonlyArray<unknown>;
  readonly comments: ReadonlyArray<unknown>;
  readonly issueComments: ReadonlyArray<unknown>;
  readonly permission: CannedAnswer;
  readonly protection?: CannedAnswer;
}): ReadonlyArray<CannedAnswer> {
  const answers = [
    jsonAnswer(input.reviews),
    jsonAnswer(input.comments),
    jsonAnswer(input.issueComments),
    account,
    jsonAnswer(pullRequestPayload()),
    input.permission,
  ];
  return input.protection === undefined
    ? answers
    : [...answers, input.protection];
}

describe("GitHubAdapter Published feedback capabilities", () => {
  it("requires authenticated owner and repository/branch evidence", async () => {
    const transport = orderedTransport(
      feedbackAnswers({
        reviews: [approvedReview],
        comments: [reviewComment],
        issueComments: [],
        permission: jsonAnswer({ role_name: "write" }),
        protection: jsonAnswer({ required_pull_request_reviews: null }),
      }),
    );
    const result = await testAdapter(transport).getPullRequestPublishedFeedback(
      { profile, pr },
    );
    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        comments: [{ id: "8", canEdit: true, canDelete: true }],
        reviews: [{ id: "7", canDismiss: true }],
      },
    });
  });

  it("projects dismissal capability when GitHub reports an unprotected base branch as 404", async () => {
    const transport = orderedTransport(
      feedbackAnswers({
        reviews: [approvedReview],
        comments: [],
        issueComments: [],
        permission: jsonAnswer({ role_name: "write" }),
        protection: { _tag: "CommandNotFound" },
      }),
    );
    await expect(
      testAdapter(transport).getPullRequestPublishedFeedback({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { reviews: [{ id: "7", canDismiss: true }] },
    });
  });

  it("fails closed when permission evidence is malformed while retaining records", async () => {
    const transport = orderedTransport(
      feedbackAnswers({
        reviews: [],
        comments: [reviewComment],
        issueComments: [],
        permission: jsonAnswer({ permission: "owner" }),
      }),
    );
    await expect(
      testAdapter(transport).getPullRequestPublishedFeedback({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { comments: [{ id: "8", canEdit: false, canDelete: false }] },
    });
  });

  it("skips PENDING reviews that GitHub omits submitted_at for instead of failing the read", async () => {
    // A started-but-unsubmitted review has no submitted_at key at all; the
    // feedback read must tolerate it (and later detect/refresh passes) rather
    // than reporting GitHubResponseInvalid.
    const transport = orderedTransport(
      feedbackAnswers({
        reviews: [
          { id: 6, user: { login: "pmquan2cfw" }, body: "", state: "PENDING" },
          approvedReview,
        ],
        comments: [],
        issueComments: [],
        permission: jsonAnswer({ role_name: "write" }),
        protection: jsonAnswer({ required_pull_request_reviews: null }),
      }),
    );
    await expect(
      testAdapter(transport).getPullRequestPublishedFeedback({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { reviews: [{ id: "7", canDismiss: true }] },
    });
  });
});

describe("GitHubAdapter issue comments", () => {
  it("reads the issues endpoint and projects a plain conversation comment", async () => {
    const transport = orderedTransport(
      feedbackAnswers({
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
        permission: jsonAnswer({ role_name: "write" }),
        protection: jsonAnswer({ required_pull_request_reviews: null }),
      }),
    );
    const result = await testAdapter(transport).getPullRequestPublishedFeedback(
      { profile, pr },
    );
    expect(restRequest(transport.requests[2]).path).toBe(
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

  it("asks for body_html and carries GitHub's camo substitutions onto the comment", async () => {
    const transport = orderedTransport(
      feedbackAnswers({
        reviews: [],
        comments: [],
        issueComments: [
          {
            id: 11,
            user: { login: "sonarqubecloud" },
            body: "![Passed](https://sonarcloud.io/images/passed.svg)",
            body_html:
              '<p><img src="https://camo.githubusercontent.com/digest/hex" alt="Passed" data-canonical-src="https://sonarcloud.io/images/passed.svg" style="max-width: 100%;"></p>',
            created_at: "2026-08-02T00:00:00Z",
          },
        ],
        permission: jsonAnswer({ role_name: "write" }),
        protection: jsonAnswer({ required_pull_request_reviews: null }),
      }),
    );
    const result = await testAdapter(transport).getPullRequestPublishedFeedback(
      { profile, pr },
    );
    // The media type has to reach GitHub, and each read has to address a
    // repository path of its own.
    for (const index of [0, 1, 2]) {
      const request = restRequest(transport.requests[index]);
      expect(request.accept).toBe("application/vnd.github.full+json");
      expect(request.path).toMatch(/^repos\//);
    }
    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        issueComments: [
          {
            id: "11",
            imageRewrites: {
              "https://sonarcloud.io/images/passed.svg":
                "https://camo.githubusercontent.com/digest/hex",
            },
          },
        ],
      },
    });
  });

  it("omits imageRewrites when GitHub proxied nothing", async () => {
    const transport = orderedTransport(
      feedbackAnswers({
        reviews: [],
        comments: [],
        issueComments: [
          {
            id: 12,
            user: { login: "reviewer" },
            body: "plain",
            body_html: "<p>plain</p>",
            created_at: "2026-08-02T00:00:00Z",
          },
        ],
        permission: jsonAnswer({ role_name: "write" }),
        protection: jsonAnswer({ required_pull_request_reviews: null }),
      }),
    );
    const result = await testAdapter(transport).getPullRequestPublishedFeedback(
      { profile, pr },
    );
    if (result._tag === "err") throw new Error("Expected a successful read");
    expect(result.value.issueComments[0]).not.toHaveProperty("imageRewrites");
  });

  it("accepts a comment with no user and a body at the schema's size limit", async () => {
    const body = "a".repeat(65_536);
    const transport = orderedTransport(
      feedbackAnswers({
        reviews: [],
        comments: [],
        issueComments: [
          { id: 10, user: null, body, created_at: "2026-08-02T00:00:00Z" },
        ],
        permission: jsonAnswer({ role_name: "write" }),
        protection: jsonAnswer({ required_pull_request_reviews: null }),
      }),
    );
    const result = await testAdapter(transport).getPullRequestPublishedFeedback(
      { profile, pr },
    );
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
    const transport = orderedTransport(
      feedbackAnswers({
        reviews: [],
        comments: [],
        issueComments: Array.from({ length: 100 }, (_, index) => ({
          id: index,
          user: { login: "reviewer" },
          body: "comment",
          created_at: "2026-08-02T00:00:00Z",
        })),
        permission: jsonAnswer({ role_name: "write" }),
        protection: jsonAnswer({ required_pull_request_reviews: null }),
      }),
    );
    await expect(
      testAdapter(transport).getPullRequestPublishedFeedback({ profile, pr }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { complete: false, incompleteReason: "pagination" },
    });
  });

  it("fails the read when GitHub cannot serve the issue comments", async () => {
    const transport = orderedTransport([
      jsonAnswer([]),
      jsonAnswer([]),
      { _tag: "CommandFailed", stderr: "HTTP 500" },
      account,
      jsonAnswer(pullRequestPayload()),
    ]);
    await expect(
      testAdapter(transport).getPullRequestPublishedFeedback({ profile, pr }),
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
