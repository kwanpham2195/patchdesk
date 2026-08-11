import { createHash } from "node:crypto";
import * as v from "valibot";

import type { CommandFailure, CommandRunner } from "./command-runner";
import type {
  CheckRunSummary,
  CheckSummary,
  Conversation,
  GitHubComment,
  GitHubComments,
  GitHubConversationThread,
  GitHubPublishedFeedback,
  PublishedReviewComment,
  GitHubMergeStateStatus,
  GitHubMergePolicyEvidence,
  GitHubClassicBranchProtectionEvidence,
  GitHubAppliedRulesetEvidence,
  PublishedReview,
  PullRequestCommit,
  PullRequestSummary,
  MergePolicySnapshot,
} from "../../domain/github-context";
import {
  parseGitSha,
  parseGitHubLogin,
  parseGitHubReviewCommentId,
  parseGitHubReviewNodeId,
  parseGitHubReviewRestId,
  parseGitHubThreadId,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseRepoRelativePath,
  type AbsolutePath,
  type GitSha,
  type IsoTimestamp,
  type GitHubLogin,
  type GitHubReviewNodeId,
  type GitHubReviewRestId,
  type GitHubThreadId,
  type GitHubHost,
  type GitHubOwner,
  type GitHubRepoName,
  type ReviewSessionId,
  type RepoRelativePath,
} from "../../domain/ids";
import type { PullRequestRef } from "../../domain/pull-request";
import { err, ok, type Result } from "../../domain/result";
import type { WorkspaceProfileConfig } from "../../domain/workspace-profile";
import {
  type PendingReviewAnchor,
  type PendingReviewRead,
  type PendingReviewThreadWrite,
  type ViewerPendingReview,
} from "../../domain/pending-review";
import type { DirectSummaryReviewReceipt } from "../../domain/direct-summary-review";
import type { GitHubReviewEvent, GitHubWriteFailure } from "../../domain/review-batch";
import type { RevisionComparison } from "../../domain/review-comparison";
import type { GitHubReviewCoordinates } from "../../domain/patch";

const commandTimeoutMs = 15_000;
// Two source blobs travel through the 2 MiB Electron bridge, so each stays
// below 512 KiB after allowing for JSON framing and multibyte text.
const maxHydratedFileBytes = 512 * 1024;
const threadQuery =
  "query PullRequestThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100, after: $cursor) { nodes { id isResolved isOutdated path line startLine diffSide startDiffSide originalLine comments(first: 100) { nodes { id body createdAt updatedAt url viewerDidAuthor author { login } path } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } } } } }";
// Spike-proven (2026-08-09): every thread comment exposes its owning review
// and state, which lets the bounded reader prove which threads belong to the
// viewer's PENDING review without scanning other reviewers' data.
const pendingReviewThreadsQuery =
  "query PendingReviewThreads($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { id isOutdated path line startLine diffSide startDiffSide comments(first: 100) { nodes { id body createdAt author { login } pullRequestReview { id state } } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } } } } }";
const maxReviewThreadPages = 10;
const maxReviewThreads = 1_000;
const threadCommentsQuery =
  "query ReviewThreadComments($id: ID!, $cursor: String) { node(id: $id) { ... on PullRequestReviewThread { comments(first: 100, after: $cursor) { nodes { id body createdAt updatedAt url viewerDidAuthor author { login } path } pageInfo { hasNextPage endCursor } } } } }";
// Single-node ownership proofs: one `$id` variable, no conversation content.
// PR identity comes from the node's pull request (threads derive it from
// their first comment), and any owner/repository/number mismatch is resolved
// inside the adapter as `found: false`, never disclosed to the renderer.
const reviewThreadTargetQuery =
  "query ReviewThreadTarget($id: ID!) { node(id: $id) { ... on PullRequestReviewThread { id comments(first: 1) { nodes { id pullRequest { repository { owner { login } name } number } } } } } }";
const reviewCommentTargetQuery =
  "query ReviewCommentTarget($id: ID!) { node(id: $id) { ... on PullRequestReviewComment { id viewerDidAuthor pullRequest { repository { owner { login } name } number } } } }";
const maxReviewCommentPages = 10;
const maxReviewComments = 5_000;
const maintainerInboxQuery =
  "query MaintainerInbox($owner: String!, $name: String!, $cursor: String) { repository(owner: $owner, name: $name) { pullRequests(first: 100, after: $cursor, states: OPEN, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number title isDraft headRefName headRefOid baseRefName baseRefOid author { login } updatedAt mergeable reviewDecision additions deletions changedFiles reviewRequests(first: 50) { nodes { requestedReviewer { ... on User { login } } } } assignees(first: 50) { nodes { login } } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } pageInfo { hasNextPage endCursor } } } }";
const mergePolicyQuery =
  "query MergePolicy($owner: String!, $name: String!, $number: Int!, $cursor: String) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { state isDraft headRefOid baseRefName mergeable mergeStateStatus reviewDecision commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100, after: $cursor) { nodes { __typename ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state targetUrl } } pageInfo { hasNextPage endCursor } } } } } } } } }";
const maxMergePolicyPages = 3;
const maxPullRequestCommits = 250;
const publishedReviewSchema = v.array(v.looseObject({
  id: v.union([v.string(), v.number()]),
  node_id: v.optional(v.string()),
  user: v.nullish(v.looseObject({ login: v.string() })),
  body: v.nullish(v.string()),
  state: v.string(),
  commit_id: v.nullish(v.string()),
  // GitHub omits submitted_at on PENDING reviews (started but not submitted);
  // they are skipped as feedback below, never failures.
  submitted_at: v.nullish(v.string()),
}));
const publishedCommentSchema = v.array(v.looseObject({
  id: v.union([v.string(), v.number()]),
  node_id: v.optional(v.string()),
  user: v.nullish(v.looseObject({ login: v.string() })),
  body: v.string(),
  created_at: v.string(),
  updated_at: v.optional(v.nullable(v.string())),
  html_url: v.optional(v.string()),
  path: v.optional(v.nullable(v.string())),
  line: v.optional(v.nullable(v.number())),
  start_line: v.optional(v.nullable(v.number())),
  side: v.optional(v.nullable(v.string())),
  pull_request_review_id: v.optional(v.nullable(v.union([v.string(), v.number()]))),
}));

const repositoryPermissionSchema = v.looseObject({ permission: v.picklist(["admin", "maintain", "push", "triage", "pull", "none"]) });
const branchProtectionSchema = v.looseObject({
  required_pull_request_reviews: v.optional(v.nullable(v.looseObject({
    dismissal_restrictions: v.optional(v.nullable(v.looseObject({
      users: v.optional(v.array(v.looseObject({ login: v.string() }))),
      teams: v.optional(v.array(v.looseObject({ slug: v.string() }))),
      apps: v.optional(v.array(v.looseObject({ slug: v.string() }))),
    }))),
  }))),
});
const mergeEvidenceBranchProtectionSchema = v.looseObject({
  required_pull_request_reviews: v.nullable(v.looseObject({
    required_approving_review_count: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100)),
    dismiss_stale_reviews: v.boolean(),
    require_code_owner_reviews: v.boolean(),
  })),
});
const appliedRulesetSchema = v.pipe(v.array(v.looseObject({
  type: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  name: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
})), v.maxLength(50));

const pullRequestCommitSchema = v.looseObject({
  sha: v.string(),
  html_url: v.optional(v.string()),
  commit: v.looseObject({
    message: v.string(),
    author: v.nullable(v.looseObject({ name: v.string(), date: v.string() })),
  }),
});

const pullRequestSchema = v.looseObject({
  number: v.pipe(v.number(), v.integer(), v.minValue(1)),
  title: v.string(),
  body: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(65_536)))),
  state: v.picklist(["open", "closed"]),
  draft: v.boolean(),
  head: v.looseObject({ ref: v.string(), sha: v.string() }),
  base: v.looseObject({ ref: v.string(), sha: v.optional(v.string()) }),
  user: v.looseObject({ login: v.string() }),
  updated_at: v.string(),
  mergeable_state: v.optional(v.string()),
  labels: v.optional(v.array(v.looseObject({ name: v.string() }))),
  requested_reviewers: v.optional(
    v.array(v.looseObject({ login: v.string() })),
  ),
  assignees: v.optional(v.array(v.looseObject({ login: v.string() }))),
  additions: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  deletions: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  changed_files: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

const checkRunsSchema = v.looseObject({
  check_runs: v.array(
    v.looseObject({
      name: v.string(),
      status: v.string(),
      conclusion: v.optional(v.nullable(v.string())),
      details_url: v.optional(v.nullable(v.string())),
    }),
  ),
});

const commitStatusesSchema = v.looseObject({
  state: v.string(),
  statuses: v.array(
    v.looseObject({
      context: v.string(),
      state: v.string(),
      target_url: v.optional(v.nullable(v.string())),
    }),
  ),
});

const repositoryFileSchema = v.looseObject({
  type: v.string(),
  encoding: v.optional(v.string()),
  content: v.optional(v.string()),
  size: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

const threadResponseSchema = v.looseObject({
  data: v.looseObject({
    repository: v.looseObject({
      pullRequest: v.looseObject({
        reviewThreads: v.looseObject({
          nodes: v.array(
            v.looseObject({
              id: v.string(),
              isResolved: v.boolean(),
              isOutdated: v.boolean(),
              path: v.optional(v.nullable(v.string())),
              line: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1)))),
              originalLine: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1)))),
              startLine: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1)))),
              diffSide: v.optional(v.nullable(v.string())),
              startDiffSide: v.optional(v.nullable(v.string())),
              comments: v.looseObject({
                nodes: v.array(
                  v.looseObject({
                    id: v.string(),
                    body: v.string(),
                    createdAt: v.string(),
                    updatedAt: v.optional(v.nullable(v.string())),
                    url: v.optional(v.nullable(v.string())),
                    viewerDidAuthor: v.optional(v.boolean()),
                    author: v.nullish(v.looseObject({ login: v.string() })),
                    path: v.optional(v.nullable(v.string())),
                  }),
                ),
                pageInfo: v.optional(v.looseObject({ hasNextPage: v.boolean(), endCursor: v.nullish(v.string()) })),
              }),
            }),
          ),
          pageInfo: v.optional(v.looseObject({ hasNextPage: v.boolean(), endCursor: v.nullish(v.string()) })),
        }),
      }),
    }),
  }),
});

const pendingReviewThreadsResponseSchema = v.looseObject({
  data: v.looseObject({
    repository: v.looseObject({
      pullRequest: v.looseObject({
        reviewThreads: v.looseObject({
          nodes: v.array(
            v.looseObject({
              id: v.string(),
              isOutdated: v.boolean(),
              path: v.optional(v.nullable(v.string())),
              line: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1)))),
              startLine: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1)))),
              diffSide: v.optional(v.nullable(v.string())),
              startDiffSide: v.optional(v.nullable(v.string())),
              comments: v.looseObject({
                nodes: v.array(
                  v.looseObject({
                    id: v.string(),
                    body: v.string(),
                    createdAt: v.string(),
                    author: v.nullish(v.looseObject({ login: v.string() })),
                    pullRequestReview: v.optional(
                      v.looseObject({ id: v.string(), state: v.string() }),
                    ),
                  }),
                ),
                pageInfo: v.optional(v.looseObject({ hasNextPage: v.boolean(), endCursor: v.nullish(v.string()) })),
              }),
            }),
          ),
          pageInfo: v.optional(v.looseObject({ hasNextPage: v.boolean(), endCursor: v.nullish(v.string()) })),
        }),
      }),
    }),
  }),
});

const threadCommentsResponseSchema = v.looseObject({
  data: v.looseObject({
    node: v.looseObject({
      comments: v.looseObject({
        nodes: v.array(v.looseObject({
          id: v.string(), body: v.string(), createdAt: v.string(), updatedAt: v.optional(v.nullable(v.string())), url: v.optional(v.nullable(v.string())), viewerDidAuthor: v.optional(v.boolean()), author: v.nullish(v.looseObject({ login: v.string() })), path: v.optional(v.nullable(v.string())),
        })),
        pageInfo: v.looseObject({ hasNextPage: v.boolean(), endCursor: v.nullish(v.string()) }),
      }),
    }),
  }),
});

const maintainerInboxResponseSchema = v.looseObject({
  data: v.looseObject({
    repository: v.looseObject({
      pullRequests: v.looseObject({
        nodes: v.array(v.looseObject({
          number: v.pipe(v.number(), v.integer(), v.minValue(1)),
          title: v.string(),
          isDraft: v.boolean(),
          headRefName: v.string(),
          headRefOid: v.string(),
          baseRefName: v.string(),
          baseRefOid: v.optional(v.string()),
          author: v.nullish(v.looseObject({ login: v.string() })),
          updatedAt: v.string(),
          mergeable: v.string(),
          reviewDecision: v.nullish(v.string()),
          additions: v.pipe(v.number(), v.integer(), v.minValue(0)),
          deletions: v.pipe(v.number(), v.integer(), v.minValue(0)),
          changedFiles: v.pipe(v.number(), v.integer(), v.minValue(0)),
          reviewRequests: v.looseObject({
            nodes: v.array(v.looseObject({
              requestedReviewer: v.nullish(
                v.looseObject({ login: v.optional(v.string()) }),
              ),
            })),
          }),
          assignees: v.looseObject({ nodes: v.array(v.looseObject({ login: v.string() })) }),
          commits: v.looseObject({
            nodes: v.array(v.looseObject({
              commit: v.looseObject({
                statusCheckRollup: v.nullish(v.looseObject({ state: v.string() })),
              }),
            })),
          }),
        })),
        pageInfo: v.looseObject({ hasNextPage: v.boolean(), endCursor: v.nullish(v.string()) }),
      }),
    }),
  }),
});

const mergePolicyResponseSchema = v.looseObject({
  data: v.looseObject({
    repository: v.looseObject({
      pullRequest: v.looseObject({
        state: v.string(),
        isDraft: v.boolean(),
        headRefOid: v.string(),
        baseRefName: v.string(),
        mergeable: v.string(),
        reviewDecision: v.nullish(v.string()),
        commits: v.looseObject({
          nodes: v.array(v.looseObject({
            commit: v.looseObject({
              statusCheckRollup: v.nullish(v.looseObject({
                contexts: v.looseObject({
                  nodes: v.array(v.looseObject({
                    __typename: v.string(),
                    name: v.optional(v.string()),
                    status: v.optional(v.string()),
                    conclusion: v.optional(v.nullish(v.string())),
                    detailsUrl: v.optional(v.nullish(v.string())),
                    context: v.optional(v.string()),
                    state: v.optional(v.string()),
                    targetUrl: v.optional(v.nullish(v.string())),
                  })),
                  pageInfo: v.looseObject({ hasNextPage: v.boolean(), endCursor: v.nullish(v.string()) }),
                }),
              })),
            }),
          })),
        }),
      }),
    }),
  }),
});

const requiredStatusChecksSchema = v.looseObject({
  contexts: v.optional(v.array(v.string())),
  checks: v.optional(v.array(v.looseObject({ context: v.string() }))),
});

/** The typed read-only operations product code may request from GitHub. */
export interface GitHubReader {
  listOpenPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: PullRequestRef;
  }): Promise<Result<ReadonlyArray<PullRequestSummary>, GitHubReadFailure>>;
  listMaintainerPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: PullRequestRef;
  }): Promise<Result<MaintainerPullRequestListing, GitHubReadFailure>>;
  getPullRequest(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<PullRequestSummary, GitHubReadFailure>>;
  getMergePolicy(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly expectedHeadSha: GitSha;
  }): Promise<Result<MergePolicySnapshot, GitHubReadFailure>>;
  /** Reads bounded, optional branch policy configuration for display-only merge evidence. */
  getMergePolicyEvidence(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly branch: string;
  }): Promise<Result<GitHubMergePolicyEvidence, GitHubReadFailure>>;
  getMergeOutcome(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<MergeOutcome, GitHubReadFailure>>;
  getPullRequestComments(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<GitHubComments, GitHubReadFailure>>;
  /** Bounded proof that a thread node belongs to the active pull request; a missing, foreign, or typeless node is a completed read with `found: false`. */
  getReviewThreadTarget(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly threadId: GitHubThreadId;
  }): Promise<Result<GitHubThreadTarget, GitHubReadFailure>>;
  /** Bounded proof that a comment node belongs to the active pull request, plus viewer authorship. */
  getReviewCommentTarget(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly commentId: string;
  }): Promise<Result<GitHubCommentTarget, GitHubReadFailure>>;
  getPullRequestPublishedFeedback?(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<GitHubPublishedFeedback, GitHubReadFailure>>;
  loadConversation(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<Conversation, GitHubReadFailure>>;
  /** Bounded authenticated repository permission evidence used for record capabilities. */
  getRepositoryPermission?(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly account: string;
  }): Promise<Result<RepositoryPermissionEvidence, GitHubReadFailure>>;
  /** Bounded branch protection evidence; a missing endpoint response means unprotected. */
  getBranchProtection?(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly branch: string;
  }): Promise<Result<BranchProtectionEvidence, GitHubReadFailure>>;
  getPullRequestCommits(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<ReadonlyArray<PullRequestCommit>, GitHubReadFailure>>;
  getPullRequestChecks(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
  }): Promise<Result<CheckSummary, GitHubReadFailure>>;
  getPullRequestDiff(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly fetchedRefs?: FetchedDiffRefs;
    /** Immutable remote comparison used only when no managed checkout exists. */
    readonly snapshot?: { readonly baseSha: GitSha; readonly headSha: GitSha };
  }): Promise<Result<string, GitHubReadFailure>>;
  /** Fetch one bounded text blob at an immutable revision for local diff hydration. */
  getFileContents(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly sha: GitSha;
    readonly path: RepoRelativePath;
  }): Promise<Result<GitHubFileContents, GitHubReadFailure>>;
  compareRevisions(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly baseSha: GitSha;
    readonly headSha: GitSha;
    readonly baseSessionId: ReviewSessionId;
  }): Promise<Result<GitHubRevisionComparison, GitHubReadFailure>>;
  resolveAuthenticatedAccount(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<AuthenticatedGitHubAccount, GitHubReadFailure>>;
}

export type MergeOutcome =
  | { readonly state: "open" | "closed_unmerged" }
  | { readonly state: "merged"; readonly mergedAt: IsoTimestamp; readonly mergeCommitSha?: GitSha };

/** Whether a thread node is a member of the active pull request. */
export type GitHubThreadTarget = { readonly found: true } | { readonly found: false };

/** Whether a comment node is a member of the active pull request, and who authored it. */
export type GitHubCommentTarget =
  | { readonly found: true; readonly viewerDidAuthor: boolean }
  | { readonly found: false };

type MergePolicyPage = {
  readonly headSha: GitSha;
  readonly baseBranch: string;
  readonly isOpen: boolean;
  readonly isDraft: boolean;
  readonly mergeability: MergePolicySnapshot["mergeability"];
  readonly mergeStateStatus: GitHubMergeStateStatus;
  readonly reviewDecision: MergePolicySnapshot["reviewDecision"];
  readonly contexts: ReadonlyArray<CheckRunSummary>;
  readonly hasNextPage: boolean;
  readonly endCursor?: string;
};

export type MaintainerPullRequest = {
  readonly summary: PullRequestSummary;
  readonly checks: CheckSummary;
};

export type MaintainerPullRequestListing = {
  readonly pullRequests: ReadonlyArray<MaintainerPullRequest>;
  /** False means GitHub reported more than Patchdesk's deliberate 300-PR cap. */
  readonly complete: boolean;
};

/** GitHub comparison is usable only when both metadata and one complete unified diff are verified. */
export type GitHubRevisionComparison = {
  readonly comparison: RevisionComparison;
  readonly patch?: string;
};

/** Safe projection for one source file; binary and oversized blobs never enter the renderer. */
export type GitHubFileContents =
  | { readonly state: "available"; readonly contents: string }
  | { readonly state: "binary" | "too_large" };

export type PendingReviewComment = {
  readonly body: string;
  readonly path: string;
  readonly line: number;
  readonly lineEnd?: number;
  readonly diffSide: "new" | "old";
};

/** Explicit write boundary. Product services must recheck the PR head immediately before calling it. */
export interface GitHubReviewWriter {
  createPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly summaryBody: string;
    readonly comments: ReadonlyArray<PendingReviewComment>;
  }): Promise<Result<{ readonly reviewId: string; readonly state: "PENDING" }, GitHubWriteFailure>>;
  submitPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: string;
    readonly event: GitHubReviewEvent;
    readonly summaryBody: string;
  }): Promise<Result<{ readonly reviewId: string }, GitHubWriteFailure>>;
  createInlineComment?(input: { readonly profile: WorkspaceProfileConfig; readonly pr: PullRequestRef; readonly headSha: GitSha; readonly coordinates: GitHubReviewCoordinates; readonly body: string }): Promise<Result<{ readonly commentId: string; readonly reviewId?: string }, GitHubWriteFailure>>;
  createThreadReply?(input: { readonly profile: WorkspaceProfileConfig; readonly threadId: GitHubThreadId; readonly body: string }): Promise<Result<{ readonly commentId: string; readonly reviewId?: string }, GitHubWriteFailure>>;
  setReviewThreadState?(input: { readonly profile: WorkspaceProfileConfig; readonly threadId: GitHubThreadId; readonly state: "resolved" | "open" }): Promise<Result<void, GitHubWriteFailure>>;
  updateThreadComment?(input: { readonly profile: WorkspaceProfileConfig; readonly commentId: string; readonly body: string }): Promise<Result<void, GitHubWriteFailure>>;
  deleteThreadComment?(input: { readonly profile: WorkspaceProfileConfig; readonly commentId: string }): Promise<Result<void, GitHubWriteFailure>>;
  updateReviewComment?(input: { readonly profile: WorkspaceProfileConfig; readonly pr: PullRequestRef; readonly commentId: string; readonly body: string }): Promise<Result<void, GitHubWriteFailure>>;
  deleteReviewComment?(input: { readonly profile: WorkspaceProfileConfig; readonly pr: PullRequestRef; readonly commentId: string }): Promise<Result<void, GitHubWriteFailure>>;
  dismissReview?(input: { readonly profile: WorkspaceProfileConfig; readonly pr: PullRequestRef; readonly reviewId: string; readonly message: string }): Promise<Result<void, GitHubWriteFailure>>;
}

export type DirectSummaryPublishedReview = DirectSummaryReviewReceipt & {
  readonly bodyDigest: string;
};

export interface GitHubDirectSummaryGateway {
  getViewerDirectSummaryReviews(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly account: GitHubLogin;
  }): Promise<Result<{ readonly reviews: ReadonlyArray<DirectSummaryPublishedReview>; readonly complete: boolean }, GitHubReadFailure>>;
  createDirectSummaryReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly event: GitHubReviewEvent;
    readonly body: string;
  }): Promise<Result<DirectSummaryReviewReceipt, GitHubWriteFailure>>;
}

export interface GitHubMergeWriter {
  mergePullRequest(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly method: "merge" | "squash" | "rebase";
  }): Promise<Result<{ readonly mergeCommitSha?: GitSha }, GitHubWriteFailure>>;
}

/**
 * Spike-proven pending-review operations (2026-08-09). Discard, empty-review,
 * reply, and thread-state behavior are unproven and deliberately absent.
 */
export interface GitHubPendingReviewGateway {
  /**
   * Bounded authenticated read of the viewer's one pending review. Returns
   * None only with a complete result proving no viewer-owned pending review;
   * pagination, missing identity, foreign data, or incomplete comments are
   * Unavailable. The account argument must come from the authenticated-account
   * reader, never from renderer input.
   */
  getViewerPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly account: GitHubLogin;
  }): Promise<Result<PendingReviewRead, GitHubReadFailure>>;

  /** Create the viewer's pending review with its first inline thread. */
  startPendingReviewWithThread(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly anchor: PendingReviewAnchor;
    readonly body: string;
  }): Promise<Result<PendingReviewThreadWrite, GitHubWriteFailure>>;

  /** Append one inline thread to the known pending review. */
  addPendingReviewThread(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: GitHubReviewNodeId;
    readonly anchor: PendingReviewAnchor;
    readonly body: string;
  }): Promise<Result<PendingReviewThreadWrite, GitHubWriteFailure>>;

  /**
   * Delete the viewer's pending review (dbacd62-proven REST DELETE contract,
   * normal confirmed response). Timeout or lost response is an unavailable
   * outcome; the caller must never retry automatically.
   */
  discardPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: GitHubReviewRestId;
  }): Promise<Result<void, GitHubWriteFailure>>;
}

/** Explicit evidence created by a future fetched-ref owner before Git diff fallback is allowed. */
export type FetchedDiffRefs = {
  readonly repositoryPath: AbsolutePath;
  readonly baseRef: string;
  readonly headRef: string;
  readonly baseSha: GitSha;
  readonly headSha: GitSha;
} & { readonly [fetchedDiffRefsBrand]: "FetchedDiffRefs" };

declare const fetchedDiffRefsBrand: unique symbol;

/** Safe parser for the managed refs that permit the adapter's Git diff fallback. */
export function createFetchedDiffRefs(input: {
  readonly repositoryPath: AbsolutePath;
  readonly baseRef: string;
  readonly headRef: string;
  readonly baseSha: GitSha;
  readonly headSha: GitSha;
}): Result<FetchedDiffRefs, InvalidFetchedDiffRefs> {
  if (
    !isManagedFetchedRef(input.baseRef) ||
    !isManagedFetchedRef(input.headRef)
  ) {
    return err({ _tag: "InvalidFetchedDiffRefs" });
  }

  // SAFETY: the parser above establishes that both ref arguments name Patchdesk-managed refs,
  // and the branded path and expected commit IDs have already passed their boundary parsers.
  return ok(input as FetchedDiffRefs);
}

/** Expected failure for invalid fetched-ref fallback evidence. */
export type InvalidFetchedDiffRefs = {
  readonly _tag: "InvalidFetchedDiffRefs";
};

/** Safe identity projection from a successful local gh auth-status check. */
export type AuthenticatedGitHubAccount = {
  readonly host: string;
  readonly account: string;
};

export type RepositoryPermissionEvidence = {
  readonly account: string;
  readonly permission: "admin" | "maintain" | "push" | "triage" | "pull" | "none";
  readonly pullRequestsWrite: boolean;
};

export type BranchProtectionEvidence = {
  readonly protected: boolean;
  readonly allowedDismissers: ReadonlyArray<string>;
};

/** Safe expected failures emitted by the GitHub read boundary. */
export type GitHubReadFailure =
  | {
      readonly _tag: "GitHubAuthenticationFailed";
      readonly operation: GitHubReadOperation;
    }
  | {
      readonly _tag: "GitHubReadFailed";
      readonly operation: GitHubReadOperation;
    }
  | {
      readonly _tag: "GitHubResponseInvalid";
      readonly operation: GitHubReadOperation;
    };

type GitHubReadOperation =
  | "list_open_prs"
  | "list_maintainer_prs"
  | "get_pr"
  | "get_merge_policy"
  | "get_merge_policy_evidence"
  | "get_comments"
  | "get_reviews"
  | "get_pending_review"
  | "get_direct_summary_reviews"
  | "load_conversation"
  | "get_repository_permission"
  | "get_branch_protection"
  | "get_pr_commits"
  | "get_checks"
  | "get_diff"
  | "get_file"
  | "compare_revisions"
  | "get_thread_target"
  | "get_comment_target"
  | "auth_status";

/**
 * GitHub CLI external adapter. It owns all gh execution and returns parsed, safe projections.
 * Read operations and explicit review writes live in the main process; renderer code never reaches this adapter.
 */
export class GitHubAdapter implements GitHubReader, GitHubReviewWriter, GitHubMergeWriter {
  constructor(private readonly commands: CommandRunner) {}

  async listOpenPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: PullRequestRef;
  }): Promise<Result<ReadonlyArray<PullRequestSummary>, GitHubReadFailure>> {
    const response = await this.commands.runJson({
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        `repos/${input.repo.owner}/${input.repo.repo}/pulls?state=open&per_page=100`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err")
      return commandFailure("list_open_prs", response.error);
    if (!Array.isArray(response.value)) return invalid("list_open_prs");

    const summaries: Array<PullRequestSummary> = [];
    for (const value of response.value) {
      const summary = parsePullRequest(
        value,
        input.profile.githubHost,
        input.repo.owner,
        input.repo.repo,
      );
      if (summary._tag === "err") return invalid("list_open_prs");
      summaries.push(summary.value);
    }
    return ok(summaries);
  }

  /** Lists up to 300 open PRs with the inbox metadata in three bounded GraphQL pages. */
  async listMaintainerPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: PullRequestRef;
  }): Promise<Result<MaintainerPullRequestListing, GitHubReadFailure>> {
    const pullRequests: Array<MaintainerPullRequest> = [];
    let cursor: string | undefined;
    let hasNextPage = true;
    for (let page = 0; page < 3 && hasNextPage; page += 1) {
      const response = await this.commands.runJson({
        argv: [
          "gh", "api", "graphql", "--hostname", input.profile.githubHost,
          "-f", `query=${maintainerInboxQuery}`,
          "-F", `owner=${input.repo.owner}`,
          "-F", `name=${input.repo.repo}`,
          ...(cursor === undefined ? [] : ["-f", `cursor=${cursor}`]),
        ],
        timeoutMs: commandTimeoutMs,
      });
      if (response._tag === "err")
        return commandFailure("list_maintainer_prs", response.error);
      const parsed = v.safeParse(maintainerInboxResponseSchema, response.value);
      if (!parsed.success) return invalid("list_maintainer_prs");
      const connection = parsed.output.data.repository.pullRequests;
      for (const node of connection.nodes) {
        const projected = parseMaintainerPullRequest(
          node,
          input.profile.githubHost,
          input.repo.owner,
          input.repo.repo,
        );
        if (projected._tag === "err") return invalid("list_maintainer_prs");
        pullRequests.push(projected.value);
      }
      hasNextPage = connection.pageInfo.hasNextPage;
      cursor = connection.pageInfo.endCursor ?? undefined;
      if (hasNextPage && cursor === undefined) return invalid("list_maintainer_prs");
    }
    return ok({ pullRequests, complete: !hasNextPage });
  }

  async getPullRequest(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<PullRequestSummary, GitHubReadFailure>> {
    const response = await this.commands.runJson({
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") {
      return commandFailure("get_pr", response.error);
    }
    const parsed = parsePullRequest(
      response.value,
      input.profile.githubHost,
      input.pr.owner,
      input.pr.repo,
    );
    return parsed._tag === "ok" ? parsed : invalid("get_pr");
  }

  async getMergePolicy(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly expectedHeadSha: GitSha;
  }): Promise<Result<MergePolicySnapshot, GitHubReadFailure>> {
    const contexts: Array<CheckRunSummary> = [];
    let cursor: string | undefined;
    let policyPage: MergePolicyPage | undefined;
    for (let page = 0; page < maxMergePolicyPages; page += 1) {
      const response = await this.commands.runJson({
        argv: ["gh", "api", "graphql", "--hostname", input.profile.githubHost, "-f", `query=${mergePolicyQuery}`, "-F", `owner=${input.pr.owner}`, "-F", `name=${input.pr.repo}`, "-F", `number=${input.pr.number}`, ...(cursor === undefined ? [] : ["-F", `cursor=${cursor}`])],
        timeoutMs: commandTimeoutMs,
      });
      if (response._tag === "err") return commandFailure("get_merge_policy", response.error);
      const parsed = parseMergePolicyPage(response.value);
      if (parsed === undefined) return invalid("get_merge_policy");
      if (policyPage !== undefined && parsed.headSha !== policyPage.headSha) return ok(incompleteMergePolicy(input.pr, parsed, contexts, "mapping"));
      policyPage = parsed;
      contexts.push(...parsed.contexts);
      if (!parsed.hasNextPage) break;
      cursor = parsed.endCursor;
      if (cursor === undefined) return ok(incompleteMergePolicy(input.pr, parsed, contexts, "pagination"));
    }
    if (policyPage === undefined) return invalid("get_merge_policy");
    if (policyPage.hasNextPage) return ok(incompleteMergePolicy(input.pr, policyPage, contexts, "pagination"));
    if (policyPage.headSha !== input.expectedHeadSha) return ok(incompleteMergePolicy(input.pr, policyPage, contexts, "head_mismatch"));

    const required = await this.commands.runJson({
      argv: ["gh", "api", "--hostname", input.profile.githubHost, `repos/${input.pr.owner}/${input.pr.repo}/branches/${encodeURIComponent(policyPage.baseBranch)}/protection/required_status_checks`],
      timeoutMs: commandTimeoutMs,
    });
    if (required._tag === "err") return ok(incompleteMergePolicy(input.pr, policyPage, contexts, "permission"));
    const requiredContexts = parseRequiredContexts(required.value);
    if (requiredContexts === undefined) return ok(incompleteMergePolicy(input.pr, policyPage, contexts, "mapping"));
    return ok(completeMergePolicy(input.pr, policyPage, contexts, requiredContexts));
  }

  async getMergeOutcome(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<MergeOutcome, GitHubReadFailure>> {
    const response = await this.commands.runJson({ argv: ["gh", "api", "--hostname", input.profile.githubHost, `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}`], timeoutMs: commandTimeoutMs });
    if (response._tag === "err") return commandFailure("get_pr", response.error);
    return parseMergeOutcome(response.value);
  }

  async getPullRequestCommits(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<ReadonlyArray<PullRequestCommit>, GitHubReadFailure>> {
    const current = await this.getPullRequest(input);
    if (current._tag === "err") return current;
    const response = await this.commands.runJson({
      argv: [
        "gh",
        "api",
        "--paginate",
        "--slurp",
        "--hostname",
        input.profile.githubHost,
        `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/commits?per_page=100`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") return commandFailure("get_pr_commits", response.error);
    const parsed = v.safeParse(v.array(v.array(pullRequestCommitSchema)), response.value);
    if (!parsed.success) return invalid("get_pr_commits");
    const rawCommits = parsed.output.flat();
    // GitHub caps this endpoint at 250 entries; without continuation metadata,
    // accepting exactly 250 could persist a truncated list as complete.
    if (rawCommits.length === 0 || rawCommits.length >= maxPullRequestCommits) return invalid("get_pr_commits");
    const commits: PullRequestCommit[] = [];
    for (const raw of rawCommits) {
      const sha = parseGitSha(raw.sha);
      const authoredAt = raw.commit.author === null ? err({ _tag: "Invalid" as const }) : parseGitHubTimestamp(raw.commit.author.date);
      if (sha._tag === "err" || authoredAt._tag === "err") return invalid("get_pr_commits");
      commits.push({
        sha: sha.value,
        message: raw.commit.message,
        author: raw.commit.author?.name ?? "ghost",
        authoredAt: authoredAt.value,
        ...(raw.html_url === undefined ? {} : { url: raw.html_url }),
        isHead: sha.value === current.value.headSha,
      });
    }
    commits.sort((left, right) => right.authoredAt.localeCompare(left.authoredAt));
    return ok(commits);
  }

  async getPullRequestComments(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<GitHubComments, GitHubReadFailure>> {
    const threads: Array<GitHubConversationThread> = [];
    let totalComments = 0;
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; page < maxReviewThreadPages && threads.length < maxReviewThreads; page += 1) {
    const response = await this.commands.runJson({
      argv: [
        "gh",
        "api",
        "graphql",
        "--hostname",
        input.profile.githubHost,
        "-f",
        `query=${threadQuery}`,
        "-F",
        `owner=${input.pr.owner}`,
        "-F",
        `name=${input.pr.repo}`,
        "-F",
        `number=${input.pr.number}`,
        ...(cursor === undefined ? [] : ["-F", `cursor=${cursor}`]),
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") {
      return commandFailure("get_comments", response.error);
    }
    const parsed = v.safeParse(threadResponseSchema, response.value);
    if (!parsed.success) return invalid("get_comments");

    for (const rawThread of parsed.output.data.repository.pullRequest
      .reviewThreads.nodes) {
      const comments: Array<GitHubComment> = [];
      for (const rawComment of rawThread.comments.nodes) {
        if (totalComments >= maxReviewComments) {
          return ok({ threads, complete: false, incompleteReason: "comment_cap" });
        }
        const comment = parseComment(rawComment);
        if (comment._tag === "err") return invalid("get_comments");
        comments.push(comment.value);
        totalComments += 1;
      }
      const replyPage = rawThread.comments.pageInfo;
      const replies = replyPage !== undefined && replyPage.hasNextPage
        ? await this.loadThreadReplies(input.profile, rawThread.id, comments, replyPage.endCursor ?? null, maxReviewComments - totalComments)
        : { comments, complete: true };
      totalComments += replies.comments.length - comments.length;
      const threadId = parseGitHubThreadId(rawThread.id);
      if (threadId._tag === "err") return invalid("get_comments");
      const location = parseLocation(
        rawThread.path,
        rawThread.line,
        rawThread.originalLine,
        rawThread.startLine,
        rawThread.diffSide,
        rawThread.startDiffSide,
      );
      if (location !== undefined && comments[0] !== undefined) {
        comments[0] = { ...comments[0], location };
      }
      threads.push({
        id: threadId.value,
        state: rawThread.isResolved
          ? "resolved"
          : rawThread.isOutdated
            ? "outdated"
            : "open",
        comments: replies.comments,
        complete: replies.complete,
        ...(location === undefined ? {} : { location }),
      });
    }
    const pageInfo = parsed.output.data.repository.pullRequest.reviewThreads.pageInfo;
    if (pageInfo === undefined) return ok({ threads, complete: false, incompleteReason: "pagination" });
    if (!pageInfo.hasNextPage) {
      const complete = threads.every((thread) => thread.complete !== false);
      return ok({ threads, complete, ...(complete ? {} : { incompleteReason: "comment_cap" as const }) });
    }
    const nextCursor = pageInfo.endCursor;
    if (nextCursor === null || nextCursor === undefined) return ok({ threads, complete: false, incompleteReason: "pagination" });
    if (threads.length >= maxReviewThreads) return ok({ threads, complete: false, incompleteReason: "thread_cap" });
    if (cursors.has(nextCursor)) return ok({ threads, complete: false, incompleteReason: "pagination" });
    cursors.add(nextCursor);
    cursor = nextCursor;
    }
    return ok({ threads, complete: false, incompleteReason: "thread_cap" });
  }

  async getReviewThreadTarget(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly threadId: GitHubThreadId;
  }): Promise<Result<GitHubThreadTarget, GitHubReadFailure>> {
    const response = await this.commands.runJson({
      argv: ["gh", "api", "graphql", "--hostname", input.profile.githubHost, "-f", `query=${reviewThreadTargetQuery}`, "-F", `id=${input.threadId}`],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") return missing("get_thread_target");
    const node = readNode(response.value);
    // A missing node, an unexpected node type, or a thread with no first
    // comment is a completed read whose target is simply not a member.
    if (node === undefined) return ok({ found: false });
    const threadId = nestedString(node, ["id"]);
    const commentNodes = nestedArray(node, ["comments", "nodes"]);
    const comment = commentNodes?.[0];
    if (threadId !== input.threadId || !isObject(comment)) return ok({ found: false });
    return matchesPullRequest(comment, input.pr) ? ok({ found: true }) : ok({ found: false });
  }

  async getReviewCommentTarget(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly commentId: string;
  }): Promise<Result<GitHubCommentTarget, GitHubReadFailure>> {
    const response = await this.commands.runJson({
      argv: ["gh", "api", "graphql", "--hostname", input.profile.githubHost, "-f", `query=${reviewCommentTargetQuery}`, "-F", `id=${input.commentId}`],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") return missing("get_comment_target");
    const node = readNode(response.value);
    if (node === undefined) return ok({ found: false });
    const commentId = nestedString(node, ["id"]);
    const viewerDidAuthor = nestedBoolean(node, ["viewerDidAuthor"]);
    if (commentId !== input.commentId || viewerDidAuthor === undefined) return ok({ found: false });
    return matchesPullRequest(node, input.pr)
      ? ok({ found: true, viewerDidAuthor })
      : ok({ found: false });
  }

  async getPullRequestPublishedFeedback(input: { readonly profile: WorkspaceProfileConfig; readonly pr: PullRequestRef }): Promise<Result<GitHubPublishedFeedback, GitHubReadFailure>> {
    const [reviews, comments, account] = await Promise.all([
      this.commands.runJson({ argv: ["gh", "api", "--hostname", input.profile.githubHost, `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/reviews?per_page=100&page=1`], timeoutMs: commandTimeoutMs }),
      this.commands.runJson({ argv: ["gh", "api", "--hostname", input.profile.githubHost, `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/comments?per_page=100&page=1`], timeoutMs: commandTimeoutMs }),
      this.resolveAuthenticatedAccount(input.profile),
    ]);
    if (reviews._tag === "err") return commandFailure("get_reviews", reviews.error);
    if (comments._tag === "err") return commandFailure("get_comments", comments.error);
    const permission = account._tag === "ok" && account.value.account === input.profile.ghAccount
      ? await this.getRepositoryPermission({ profile: input.profile, pr: input.pr, account: account.value.account })
      : undefined;
    const pullRequest = await this.getPullRequest({ profile: input.profile, pr: input.pr });
    const protection = permission?._tag === "ok" && pullRequest._tag === "ok"
      ? await this.getBranchProtection({ profile: input.profile, pr: input.pr, branch: pullRequest.value.baseBranch })
      : undefined;
    const canWrite = permission?._tag === "ok" && permission.value.account === input.profile.ghAccount && permission.value.pullRequestsWrite;
    const isAdmin = permission?._tag === "ok" && permission.value.permission === "admin";
    const canDismiss = canWrite === true && (isAdmin === true || (protection?._tag === "ok" && (protection.value.protected === false || protection.value.allowedDismissers.includes(input.profile.ghAccount))));
    const parsedReviews = v.safeParse(publishedReviewSchema, reviews.value);
    const parsedComments = v.safeParse(publishedCommentSchema, comments.value);
    if (!parsedReviews.success || !parsedComments.success) return invalid("get_reviews");
    const publishedReviews: PublishedReview[] = [];
    for (const review of parsedReviews.output) {
      // PENDING reviews are started but not submitted; they carry no
      // submitted_at and are not published feedback.
      if (review.submitted_at === undefined || review.submitted_at === null) continue;
      const submittedAt = parseGitHubTimestamp(review.submitted_at);
      if (submittedAt._tag === "err") return invalid("get_reviews");
      const event = review.state.toUpperCase();
      if (event !== "APPROVED" && event !== "COMMENTED" && event !== "CHANGES_REQUESTED" && event !== "DISMISSED") continue;
      publishedReviews.push({ id: String(review.id), ...(review.node_id === undefined ? {} : { nodeId: review.node_id }), author: review.user?.login ?? "ghost", body: review.body ?? "", event, submittedAt: submittedAt.value, canDismiss: canDismiss && event !== "DISMISSED" });
    }
    const publishedComments: PublishedReviewComment[] = [];
    for (const comment of parsedComments.output) {
      const createdAt = parseGitHubTimestamp(comment.created_at);
      const updatedAt = comment.updated_at === undefined || comment.updated_at === null ? undefined : parseGitHubTimestamp(comment.updated_at);
      if (createdAt._tag === "err" || (updatedAt !== undefined && updatedAt._tag === "err")) return invalid("get_comments");
      const location = parseLocation(comment.path, comment.line, undefined, comment.start_line, comment.side, undefined);
      const author = comment.user?.login ?? "ghost";
      const owned = account._tag === "ok" && account.value.account === input.profile.ghAccount && author === account.value.account;
      publishedComments.push({ id: String(comment.id), ...(comment.node_id === undefined ? {} : { nodeId: comment.node_id }), author, body: comment.body, createdAt: createdAt.value, ...(updatedAt === undefined ? {} : { updatedAt: updatedAt.value }), ...(comment.html_url === undefined ? {} : { url: comment.html_url }), ...(location === undefined ? {} : { location }), ...(comment.pull_request_review_id === undefined || comment.pull_request_review_id === null ? {} : { reviewId: String(comment.pull_request_review_id) }), canEdit: owned && canWrite === true, canDelete: owned && canWrite === true });
    }
    const complete = parsedReviews.output.length < 100 && parsedComments.output.length < 100;
    return ok({ reviews: publishedReviews, comments: publishedComments, complete, ...(complete ? {} : { incompleteReason: "pagination" as const }) });
  }

  async getRepositoryPermission(input: { readonly profile: WorkspaceProfileConfig; readonly pr: PullRequestRef; readonly account: string }): Promise<Result<RepositoryPermissionEvidence, GitHubReadFailure>> {
    const response = await this.commands.runJson({ argv: ["gh", "api", "--hostname", input.profile.githubHost, `repos/${input.pr.owner}/${input.pr.repo}/collaborators/${encodeURIComponent(input.account)}/permission`], timeoutMs: commandTimeoutMs });
    if (response._tag === "err") return commandFailure("get_repository_permission", response.error);
    const parsed = v.safeParse(repositoryPermissionSchema, response.value);
    if (!parsed.success) return invalid("get_repository_permission");
    const permission = parsed.output.permission;
    return ok({ account: input.account, permission, pullRequestsWrite: permission === "admin" || permission === "maintain" || permission === "push" });
  }

  async getBranchProtection(input: { readonly profile: WorkspaceProfileConfig; readonly pr: PullRequestRef; readonly branch: string }): Promise<Result<BranchProtectionEvidence, GitHubReadFailure>> {
    const response = await this.commands.runJson({ argv: ["gh", "api", "--hostname", input.profile.githubHost, `repos/${input.pr.owner}/${input.pr.repo}/branches/${encodeURIComponent(input.branch)}/protection`], timeoutMs: commandTimeoutMs });
    // GitHub returns 404 for an unprotected branch (rather than an empty policy).
    // Treat that absence as affirmative unprotected evidence; other failures remain
    // fail-closed so malformed or unavailable permission evidence cannot grant writes.
    if (response._tag === "err" && response.error._tag === "CommandNotFound") {
      return ok({ protected: false, allowedDismissers: [] });
    }
    if (response._tag === "err") return commandFailure("get_branch_protection", response.error);
    const parsed = v.safeParse(branchProtectionSchema, response.value);
    if (!parsed.success) return invalid("get_branch_protection");
    const rules = parsed.output.required_pull_request_reviews;
    const restrictions = rules?.dismissal_restrictions;
    return ok({ protected: rules !== undefined && rules !== null, allowedDismissers: restrictions?.users?.map((user) => user.login) ?? [] });
  }

  async getMergePolicyEvidence(input: { readonly profile: WorkspaceProfileConfig; readonly pr: PullRequestRef; readonly branch: string }): Promise<Result<GitHubMergePolicyEvidence, GitHubReadFailure>> {
    const [branchProtection, appliedRuleset] = await Promise.all([
      this.commands.runJson({ argv: ["gh", "api", "--hostname", input.profile.githubHost, `repos/${input.pr.owner}/${input.pr.repo}/branches/${encodeURIComponent(input.branch)}/protection`], timeoutMs: commandTimeoutMs }),
      this.commands.runJson({ argv: ["gh", "api", "--hostname", input.profile.githubHost, `repos/${input.pr.owner}/${input.pr.repo}/rules/branches/${encodeURIComponent(input.branch)}`], timeoutMs: commandTimeoutMs }),
    ]);
    const branch = parseOptionalPolicyResponse(branchProtection, "branchProtection");
    if (branch._tag === "err") return branch;
    const rules = parseOptionalPolicyResponse(appliedRuleset, "appliedRuleset");
    if (rules._tag === "err") return rules;
    return ok({ branchProtection: branch.value, appliedRuleset: rules.value });
  }

  private async loadThreadReplies(profile: WorkspaceProfileConfig, threadId: string, initial: ReadonlyArray<GitHubComment>, initialCursor: string | null, remainingComments: number): Promise<{ readonly comments: ReadonlyArray<GitHubComment>; readonly complete: boolean }> {
    const comments = [...initial];
    let cursor = initialCursor;
    for (let page = 0; page < maxReviewCommentPages && comments.length - initial.length < remainingComments; page += 1) {
      if (cursor === null) return { comments, complete: false };
      const response = await this.commands.runJson({ argv: ["gh", "api", "graphql", "--hostname", profile.githubHost, "-f", `query=${threadCommentsQuery}`, "-F", `id=${threadId}`, "-F", `cursor=${cursor}`], timeoutMs: commandTimeoutMs });
      if (response._tag === "err") return { comments, complete: false };
      const parsed = v.safeParse(threadCommentsResponseSchema, response.value);
      if (!parsed.success) return { comments, complete: false };
      for (const rawComment of parsed.output.data.node.comments.nodes) {
        const comment = parseComment(rawComment);
        if (comment._tag === "err") return { comments, complete: false };
        comments.push(comment.value);
      }
      const pageInfo = parsed.output.data.node.comments.pageInfo;
      if (!pageInfo.hasNextPage) return { comments, complete: true };
      cursor = pageInfo.endCursor ?? null;
    }
    return { comments, complete: false };
  }

  async getPullRequestChecks(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
  }): Promise<Result<CheckSummary, GitHubReadFailure>> {
    const [checkRunsResponse, statusesResponse] = await Promise.all([
      this.commands.runJson({
        argv: [
          "gh",
          "api",
          "--hostname",
          input.profile.githubHost,
          `repos/${input.pr.owner}/${input.pr.repo}/commits/${input.headSha}/check-runs`,
        ],
        timeoutMs: commandTimeoutMs,
      }),
      this.commands.runJson({
        argv: [
          "gh",
          "api",
          "--hostname",
          input.profile.githubHost,
          `repos/${input.pr.owner}/${input.pr.repo}/commits/${input.headSha}/status`,
        ],
        timeoutMs: commandTimeoutMs,
      }),
    ]);
    if (checkRunsResponse._tag === "err" && statusesResponse._tag === "err")
      return commandFailure("get_checks", checkRunsResponse.error);
    const checks =
      checkRunsResponse._tag === "ok"
        ? v.safeParse(checkRunsSchema, checkRunsResponse.value)
        : undefined;
    const statuses =
      statusesResponse._tag === "ok"
        ? v.safeParse(commitStatusesSchema, statusesResponse.value)
        : undefined;
    if (checks?.success !== true && statuses?.success !== true)
      return invalid("get_checks");

    const summaries = [
      ...(checks?.success === true
        ? checks.output.check_runs.map(toCheckRunSummary)
        : []),
      ...(statuses?.success === true
        ? statuses.output.statuses.map(toCommitStatusSummary)
        : []),
    ];
    return ok({ overall: overallCheckStatus(summaries), checks: summaries });
  }

  async getPullRequestDiff(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly fetchedRefs?: FetchedDiffRefs;
    /** Immutable remote comparison used only when no managed checkout exists. */
    readonly snapshot?: { readonly baseSha: GitSha; readonly headSha: GitSha };
  }): Promise<Result<string, GitHubReadFailure>> {
    if (input.fetchedRefs !== undefined) {
      const fetchedRefs = await this.verifyFetchedRefs(input.fetchedRefs);
      if (fetchedRefs._tag === "err") return fetchedRefs;

      const exact = await this.commands.runText({
        argv: [
          "git",
          "-C",
          input.fetchedRefs.repositoryPath,
          "diff",
          "--no-ext-diff",
          `${input.fetchedRefs.baseRef}...${input.fetchedRefs.headRef}`,
        ],
        timeoutMs: commandTimeoutMs,
      });
      return exact._tag === "ok"
        ? exact
        : commandFailure("get_diff", exact.error);
    }

    if (input.snapshot !== undefined) {
      const exact = await this.commands.runText({
        argv: [
          "gh",
          "api",
          "--hostname",
          input.profile.githubHost,
          "-H",
          "Accept: application/vnd.github.v3.diff",
          `repos/${input.pr.owner}/${input.pr.repo}/compare/${input.snapshot.baseSha}...${input.snapshot.headSha}`,
        ],
        timeoutMs: commandTimeoutMs,
      });
      return exact._tag === "ok"
        ? exact
        : commandFailure("get_diff", exact.error);
    }

    const response = await this.commands.runText({
      argv: [
        "gh",
        "pr",
        "diff",
        String(input.pr.number),
        "--repo",
        `${input.profile.githubHost}/${input.pr.owner}/${input.pr.repo}`,
        "--patch",
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "ok" && response.value.length > 0) return response;
    if (
      response._tag === "err" &&
      response.error._tag === "CommandAuthenticationRequired"
    ) {
      return commandFailure("get_diff", response.error);
    }
    return err({ _tag: "GitHubReadFailed", operation: "get_diff" });
  }

  async getFileContents(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly sha: GitSha;
    readonly path: RepoRelativePath;
  }): Promise<Result<GitHubFileContents, GitHubReadFailure>> {
    const encodedPath = input.path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const response = await this.commands.runJson({
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        `repos/${input.pr.owner}/${input.pr.repo}/contents/${encodedPath}?ref=${input.sha}`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") return commandFailure("get_file", response.error);
    const parsed = v.safeParse(repositoryFileSchema, response.value);
    if (!parsed.success || parsed.output.type !== "file") return invalid("get_file");
    if ((parsed.output.size ?? 0) > maxHydratedFileBytes) {
      return ok({ state: "too_large" });
    }
    if (parsed.output.encoding !== "base64" || parsed.output.content === undefined) {
      return err({ _tag: "GitHubReadFailed", operation: "get_file" });
    }
    const contents = Buffer.from(
      parsed.output.content.replaceAll("\n", ""),
      "base64",
    );
    if (contents.byteLength > maxHydratedFileBytes) {
      return ok({ state: "too_large" });
    }
    if (contents.includes(0)) return ok({ state: "binary" });
    return ok({ state: "available", contents: contents.toString("utf8") });
  }

  async compareRevisions(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly baseSha: GitSha;
    readonly headSha: GitSha;
    readonly baseSessionId: ReviewSessionId;
  }): Promise<Result<GitHubRevisionComparison, GitHubReadFailure>> {
    const endpoint = `repos/${input.pr.owner}/${input.pr.repo}/compare/${input.baseSha}...${input.headSha}`;
    const metadata = await this.commands.runJson({
      argv: ["gh", "api", "--hostname", input.profile.githubHost, endpoint],
      timeoutMs: commandTimeoutMs,
    });
    if (metadata._tag === "err") return commandFailure("compare_revisions", metadata.error);
    const comparison = parseGitHubComparison(metadata.value, input);
    if (comparison === undefined) return invalid("compare_revisions");
    if (comparison.completeness === "incomplete") return ok({ comparison });
    const patch = await this.commands.runText({
      argv: ["gh", "api", "--hostname", input.profile.githubHost, "-H", "Accept: application/vnd.github.v3.diff", endpoint],
      timeoutMs: commandTimeoutMs,
    });
    if (patch._tag === "err") return commandFailure("compare_revisions", patch.error);
    return patch.value.length === 0
      ? ok({ comparison: { ...comparison, completeness: "incomplete" } })
      : ok({ comparison, patch: patch.value });
  }

  async resolveAuthenticatedAccount(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<AuthenticatedGitHubAccount, GitHubReadFailure>> {
    const response = await this.commands.runText({
      // `gh auth status` exits nonzero if any stale, inactive account is
      // invalid, even when the configured active account can make API calls.
      // Ask GitHub who this invocation can actually authenticate as instead.
      argv: [
        "gh",
        "api",
        "--hostname",
        profile.githubHost,
        "user",
        "--jq",
        ".login",
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (
      response._tag === "err" ||
      response.value.trim() !== profile.ghAccount
    ) {
      return err({
        _tag: "GitHubAuthenticationFailed",
        operation: "auth_status",
      });
    }
    return ok({ host: profile.githubHost, account: profile.ghAccount });
  }

  async createPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly summaryBody: string;
    readonly comments: ReadonlyArray<PendingReviewComment>;
  }): Promise<Result<{ readonly reviewId: string; readonly state: "PENDING" }, GitHubWriteFailure>> {
    if (input.comments.length === 0 && input.summaryBody.trim().length === 0)
      return err({ _tag: "GitHubWriteFailure", category: "rejected", message: "No review content is selected." });
    const response = await this.commands.runJson({
      argv: ["gh", "api", "--hostname", input.profile.githubHost, "--method", "POST", `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/reviews`, "--input", "-"],
      stdin: JSON.stringify({
        commit_id: input.headSha,
        body: input.summaryBody,
        comments: input.comments.map(toGitHubReviewComment),
      }),
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") return err(writeFailure(response.error));
    const pending = parsePendingReview(response.value);
    return pending === undefined
      ? err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "GitHub did not return a PENDING review." })
      : ok(pending);
  }

  async submitPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: string;
    readonly event: GitHubReviewEvent;
    readonly summaryBody: string;
  }): Promise<Result<{ readonly reviewId: string }, GitHubWriteFailure>> {
    const response = await this.commands.runJson({
      argv: ["gh", "api", "--hostname", input.profile.githubHost, "--method", "POST", `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/reviews/${input.reviewId}/events`, "--input", "-"],
      stdin: JSON.stringify({ event: input.event, body: input.summaryBody }),
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") return err(writeFailure(response.error));
    const reviewId = parseReviewId(response.value);
    return reviewId === undefined
      ? err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "GitHub did not return a submitted review ID." })
      : ok({ reviewId });
  }

  async createDirectSummaryReview(input: { readonly profile: WorkspaceProfileConfig; readonly pr: PullRequestRef; readonly headSha: GitSha; readonly event: GitHubReviewEvent; readonly body: string }): Promise<Result<DirectSummaryReviewReceipt, GitHubWriteFailure>> {
    const response = await this.commands.runJson({
      argv: ["gh", "api", "--hostname", input.profile.githubHost, "--method", "POST", `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/reviews`, "--input", "-"],
      stdin: JSON.stringify({ commit_id: input.headSha, event: input.event, body: input.body }),
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") return err(directSummaryWriteFailure(response.error));
    const receipt = parseDirectSummaryReceipt(response.value, input.event);
    return receipt === undefined
      ? err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "GitHub did not return a submitted summary review receipt." })
      : ok(receipt);
  }

  async getViewerDirectSummaryReviews(input: { readonly profile: WorkspaceProfileConfig; readonly pr: PullRequestRef; readonly account: GitHubLogin }): Promise<Result<{ readonly reviews: ReadonlyArray<DirectSummaryPublishedReview>; readonly complete: boolean }, GitHubReadFailure>> {
    const response = await this.commands.runJson({ argv: ["gh", "api", "--hostname", input.profile.githubHost, `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/reviews?per_page=100&page=1`], timeoutMs: commandTimeoutMs });
    if (response._tag === "err") return commandFailure("get_direct_summary_reviews", response.error);
    const parsed = v.safeParse(publishedReviewSchema, response.value);
    if (!parsed.success) return invalid("get_direct_summary_reviews");
    const reviews: DirectSummaryPublishedReview[] = [];
    for (const raw of parsed.output) {
      if (raw.user?.login !== input.account || raw.submitted_at === undefined || raw.submitted_at === null) continue;
      if (raw.state === "DISMISSED") continue;
      const event = directSummaryEvent(raw.state);
      const reviewId = parseGitHubReviewRestId(String(raw.id));
      const headSha = raw.commit_id === undefined || raw.commit_id === null ? undefined : parseGitSha(raw.commit_id);
      const submittedAt = parseGitHubTimestamp(raw.submitted_at);
      if (event === undefined || reviewId._tag === "err" || headSha === undefined || headSha._tag === "err" || submittedAt._tag === "err") return invalid("get_direct_summary_reviews");
      reviews.push({ reviewId: reviewId.value, event, headSha: headSha.value, submittedAt: submittedAt.value, bodyDigest: digestReviewBody(raw.body ?? "") });
    }
    return ok({ reviews, complete: parsed.output.length < 100 });
  }

  async getViewerPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly account: GitHubLogin;
  }): Promise<Result<PendingReviewRead, GitHubReadFailure>> {
    const reviews = await this.commands.runJson({
      argv: ["gh", "api", "--hostname", input.profile.githubHost, `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/reviews?per_page=100&page=1`],
      timeoutMs: commandTimeoutMs,
    });
    if (reviews._tag === "err") return commandFailure("get_pending_review", reviews.error);
    const parsed = v.safeParse(publishedReviewSchema, reviews.value);
    if (!parsed.success) return invalid("get_pending_review");
    const pending = parsed.output.filter(
      (review) => review.state === "PENDING" && review.user?.login === input.account,
    );
    if (pending.length === 0) {
      // None is provable only with a complete bounded result; an incomplete
      // page is Unavailable, never proof that no pending review exists.
      return parsed.output.length < 100
        ? ok({ _tag: "None" })
        : invalid("get_pending_review");
    }
    if (pending.length > 1) return invalid("get_pending_review");
    const rawReview = pending[0];
    if (rawReview === undefined) return invalid("get_pending_review");
    const restId = parseReviewId(rawReview);
    const nodeId = rawReview.node_id;
    const commitId = rawReview.commit_id;
    const parsedRestId = restId === undefined ? err({ _tag: "InvalidDomainValue" as const, field: "reviewRestId" }) : parseGitHubReviewRestId(restId);
    const parsedNodeId = nodeId === undefined ? err({ _tag: "InvalidDomainValue" as const, field: "reviewNodeId" }) : parseGitHubReviewNodeId(nodeId);
    const parsedCommit = commitId === undefined || commitId === null ? err({ _tag: "InvalidDomainValue" as const, field: "reviewCommitId" }) : parseGitSha(commitId);
    if (parsedRestId._tag === "err" || parsedNodeId._tag === "err" || parsedCommit._tag === "err") {
      return invalid("get_pending_review");
    }

    const response = await this.commands.runJson({
      argv: [
        "gh", "api", "graphql", "--hostname", input.profile.githubHost,
        "-f", `query=${pendingReviewThreadsQuery}`,
        "-F", `owner=${input.pr.owner}`,
        "-F", `name=${input.pr.repo}`,
        "-F", `number=${input.pr.number}`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") return commandFailure("get_pending_review", response.error);
    const threads = v.safeParse(pendingReviewThreadsResponseSchema, response.value);
    if (!threads.success) return invalid("get_pending_review");
    const connection = threads.output.data.repository.pullRequest.reviewThreads;
    if (connection.pageInfo?.hasNextPage === true) return invalid("get_pending_review");

    const comments: Array<ViewerPendingReview["comments"][number]> = [];
    for (const thread of connection.nodes) {
      if (thread.comments.pageInfo?.hasNextPage === true) return invalid("get_pending_review");
      for (const comment of thread.comments.nodes) {
        // Only comments owned by a PENDING review of the authenticated viewer
        // are actionable. The single-pending-review-per-PR rule plus the
        // owning-review state prove the thread belongs to this review without
        // matching node IDs across the REST/GraphQL boundaries.
        if (comment.pullRequestReview === undefined || comment.pullRequestReview.state !== "PENDING") continue;
        if (comment.author?.login !== input.account) continue;
        const reviewCommentId = parseGitHubReviewCommentId(comment.id);
        const threadId = parseGitHubThreadId(thread.id);
        const createdAt = parseGitHubTimestamp(comment.createdAt);
        const anchor = pendingReviewAnchor(thread);
        if (reviewCommentId._tag === "err" || threadId._tag === "err" || createdAt._tag === "err" || anchor === undefined) {
          return invalid("get_pending_review");
        }
        comments.push({
          reviewCommentId: reviewCommentId.value,
          threadId: threadId.value,
          body: comment.body,
          anchor,
          createdAt: createdAt.value,
        });
      }
    }
    // A pending review with no actionable comments is the unproven empty-review
    // case; it must not look like an importable owner.
    if (comments.length === 0) return invalid("get_pending_review");
    const sortedCreatedAt = comments.map((comment) => comment.createdAt).sort();
    const createdAt = sortedCreatedAt[0];
    const updatedAt = sortedCreatedAt[sortedCreatedAt.length - 1];
    if (createdAt === undefined || updatedAt === undefined) return invalid("get_pending_review");
    return ok({
      _tag: "Pending",
      review: {
        restId: parsedRestId.value,
        nodeId: parsedNodeId.value,
        author: input.account,
        pr: input.pr,
        headSha: parsedCommit.value,
        comments,
        createdAt,
        updatedAt,
      },
    });
  }

  async startPendingReviewWithThread(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly anchor: PendingReviewAnchor;
    readonly body: string;
  }): Promise<Result<PendingReviewThreadWrite, GitHubWriteFailure>> {
    const created = await this.commands.runJson({
      argv: ["gh", "api", "--hostname", input.profile.githubHost, "--method", "POST", `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/reviews`, "--input", "-"],
      stdin: JSON.stringify({
        commit_id: input.headSha,
        body: input.body,
        comments: [pendingReviewComment(input.anchor, input.body)],
      }),
      timeoutMs: commandTimeoutMs,
    });
    if (created._tag === "err") return err(writeFailure(created.error));
    const pending = parsePendingReview(created.value);
    const nodeId = nestedString(created.value, ["node_id"]);
    const createdCommentId = nestedString(created.value, ["comments", "0", "node_id"]);
    if (pending === undefined || nodeId === undefined || createdCommentId === undefined) {
      return err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "GitHub did not return a PENDING review identity." });
    }
    // The create receipt is not a full owner: thread and comment identity come
    // only from the proven bounded read-back. A failed read-back leaves the
    // confirmed remote create unreconciled rather than inventing identities.
    return this.pendingReviewAfterWrite(input.profile, input.pr, { restId: pending.reviewId, nodeId, createdCommentId });
  }

  async addPendingReviewThread(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: GitHubReviewNodeId;
    readonly anchor: PendingReviewAnchor;
    readonly body: string;
  }): Promise<Result<PendingReviewThreadWrite, GitHubWriteFailure>> {
    const side = input.anchor.side === "new" ? "RIGHT" : "LEFT";
    // pageInfo belongs inside the comments connection: PullRequestReviewThread
    // has no pageInfo field, and GitHub rejects the mutation at schema
    // validation before executing it. The read-back never runs in that case.
    const appendQuery = `mutation($reviewId:ID!,$path:String!,$line:Int!,$body:String!){addPullRequestReviewThread(input:{pullRequestReviewId:$reviewId,path:$path,line:$line,side:${side},body:$body}){thread{id path line startLine diffSide comments(first:100){nodes{id body} pageInfo{hasNextPage}}}}}`;
    const appended = await this.commands.runJson({
      argv: ["gh", "api", "graphql", "--hostname", input.profile.githubHost, "-f", `query=${appendQuery}`, "-F", `reviewId=${input.reviewId}`, "-F", `path=${input.anchor.path}`, "-F", `line=${input.anchor.line}`, "-f", `body=${input.body}`],
      timeoutMs: commandTimeoutMs,
    });
    if (appended._tag === "err") return err(writeFailure(appended.error));
    const threadId = nestedString(appended.value, ["data", "addPullRequestReviewThread", "thread", "id"]);
    const commentId = nestedString(appended.value, ["data", "addPullRequestReviewThread", "thread", "comments", "nodes", "0", "id"]);
    if (threadId === undefined || commentId === undefined) {
      return err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "GitHub did not return a thread identity." });
    }
    return this.pendingReviewAfterWrite(input.profile, input.pr, { nodeId: input.reviewId, createdThreadId: threadId });
  }

  /** Read back the confirmed owner after a write; an unreconciled write is unavailable. */
  private async pendingReviewAfterWrite(
    profile: WorkspaceProfileConfig,
    pr: PullRequestRef,
    expected: { readonly restId?: string; readonly nodeId?: string; readonly createdThreadId?: string; readonly createdCommentId?: string },
  ): Promise<Result<PendingReviewThreadWrite, GitHubWriteFailure>> {
    const account = parseGitHubLogin(profile.ghAccount);
    if (account._tag === "err") {
      return err({ _tag: "GitHubWriteFailure", category: "auth", message: "GitHub authentication is required." });
    }
    const read = await this.getViewerPendingReview({ profile, pr, account: account.value });
    const matches =
      read._tag === "ok" &&
      read.value._tag === "Pending" &&
      (expected.restId === undefined || read.value.review.restId === expected.restId) &&
      (expected.nodeId === undefined || read.value.review.nodeId === expected.nodeId);
    if (!matches) {
      return err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "The pending review could not be confirmed after the write." });
    }
    const parsedCreatedThread = expected.createdThreadId === undefined ? undefined : parseGitHubThreadId(expected.createdThreadId);
    const createdThread = expected.createdThreadId === undefined
      ? read.value.review.comments.find((comment) => comment.reviewCommentId === expected.createdCommentId)?.threadId
      : parsedCreatedThread?._tag === "ok"
        ? parsedCreatedThread.value
        : undefined;
    if (createdThread === undefined || !read.value.review.comments.some((comment) => comment.threadId === createdThread)) {
      return err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "GitHub did not confirm the created review thread." });
    }
    return ok({ review: read.value.review, createdThreadId: createdThread });
  }

  async discardPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: GitHubReviewRestId;
  }): Promise<Result<void, GitHubWriteFailure>> {
    // The DELETE endpoint answers 204 with an empty body, so this boundary
    // uses runText: any exit-0 response is the confirmed absence receipt, and
    // GitHub's HTTP error exits classify as typed failures. Never retried by
    // the caller; a timeout is an unavailable outcome.
    const response = await this.commands.runText({
      argv: ["gh", "api", "--hostname", input.profile.githubHost, "--method", "DELETE", `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/reviews/${input.reviewId}`],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") return err(writeFailure(response.error));
    return ok(undefined);
  }

  async createInlineComment(input: { readonly profile: WorkspaceProfileConfig; readonly pr: PullRequestRef; readonly headSha: GitSha; readonly coordinates: GitHubReviewCoordinates; readonly body: string }): Promise<Result<{ readonly commentId: string; readonly reviewId?: string }, GitHubWriteFailure>> {
    const response = await this.commands.runJson({
      argv: ["gh", "api", "--hostname", input.profile.githubHost, "--method", "POST", `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/comments`, "--input", "-"],
      stdin: JSON.stringify({ body: input.body, commit_id: input.headSha, ...input.coordinates }),
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") return err(writeFailure(response.error));
    const id = nestedString(response.value, ["node_id"]);
    if (id === undefined) return err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "GitHub did not return an inline comment ID." });
    // A create submits a COMMENTED review of its own; its numeric id lets the
    // write journal exclude that review from update detection.
    const rawReviewId = (response.value as Record<string, unknown>)["pull_request_review_id"];
    const reviewId = typeof rawReviewId === "number" || typeof rawReviewId === "string" ? String(rawReviewId) : undefined;
    // The REST create receipt has no thread id, and a partial thread scan
    // would be slow and incomplete; Reply and Resolve stay disabled until an
    // explicit refresh represents the real thread. The comment itself remains
    // editable and deletable by its authoritative node id.
    return ok({ commentId: id, ...(typeof reviewId === "string" && reviewId.length > 0 ? { reviewId } : {}) });
  }

  async createThreadReply(input: { readonly profile: WorkspaceProfileConfig; readonly threadId: GitHubThreadId; readonly body: string }): Promise<Result<{ readonly commentId: string; readonly reviewId?: string }, GitHubWriteFailure>> {
    const response = await this.commands.runJson({ argv: ["gh", "api", "graphql", "--hostname", input.profile.githubHost, "-f", "query=mutation($threadId:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id pullRequestReview{id}}}}", "-F", `threadId=${input.threadId}`, "-f", `body=${input.body}`], timeoutMs: commandTimeoutMs });
    if (response._tag === "err") return err(writeFailure(response.error));
    const commentId = nestedString(response.value, ["data", "addPullRequestReviewThreadReply", "comment", "id"]);
    if (typeof commentId !== "string" || commentId.length === 0) return err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "GitHub did not return a reply ID." });
    // A reply also submits its own COMMENTED review; expose it so the write
    // journal can exclude it from update detection.
    const reviewId = nestedString(response.value, ["data", "addPullRequestReviewThreadReply", "comment", "pullRequestReview", "id"]);
    return ok({ commentId, ...(typeof reviewId === "string" && reviewId.length > 0 ? { reviewId } : {}) });
  }

  async setReviewThreadState(input: { readonly profile: WorkspaceProfileConfig; readonly threadId: GitHubThreadId; readonly state: "resolved" | "open" }): Promise<Result<void, GitHubWriteFailure>> {
    const mutation = input.state === "resolved" ? "resolveReviewThread" : "unresolveReviewThread";
    const response = await this.commands.runJson({ argv: ["gh", "api", "graphql", "--hostname", input.profile.githubHost, "-f", `query=mutation($threadId:ID!){${mutation}(input:{threadId:$threadId}){thread{id}}}`, "-F", `threadId=${input.threadId}`], timeoutMs: commandTimeoutMs });
    return response._tag === "err" ? err(writeFailure(response.error)) : ok(undefined);
  }

  async updateThreadComment(input: { readonly profile: WorkspaceProfileConfig; readonly commentId: string; readonly body: string }): Promise<Result<void, GitHubWriteFailure>> {
    const response = await this.commands.runJson({ argv: ["gh", "api", "graphql", "--hostname", input.profile.githubHost, "-f", "query=mutation($commentId:ID!,$body:String!){updatePullRequestReviewComment(input:{pullRequestReviewCommentId:$commentId,body:$body}){pullRequestReviewComment{id}}}", "-F", `commentId=${input.commentId}`, "-f", `body=${input.body}`], timeoutMs: commandTimeoutMs });
    return response._tag === "err" ? err(writeFailure(response.error)) : ok(undefined);
  }

  async deleteThreadComment(input: { readonly profile: WorkspaceProfileConfig; readonly commentId: string }): Promise<Result<void, GitHubWriteFailure>> {
    const response = await this.commands.runJson({ argv: ["gh", "api", "graphql", "--hostname", input.profile.githubHost, "-f", "query=mutation($commentId:ID!){deletePullRequestReviewComment(input:{id:$commentId}){clientMutationId}}", "-F", `commentId=${input.commentId}`], timeoutMs: commandTimeoutMs });
    return response._tag === "err" ? err(writeFailure(response.error)) : ok(undefined);
  }

  async updateReviewComment(input: { readonly profile: WorkspaceProfileConfig; readonly pr: PullRequestRef; readonly commentId: string; readonly body: string }): Promise<Result<void, GitHubWriteFailure>> {
    const response = await this.commands.runJson({ argv: ["gh", "api", "--hostname", input.profile.githubHost, "--method", "PATCH", `repos/${input.pr.owner}/${input.pr.repo}/pulls/comments/${input.commentId}`, "--input", "-"], stdin: JSON.stringify({ body: input.body }), timeoutMs: commandTimeoutMs });
    return response._tag === "err" ? err(writeFailure(response.error)) : ok(undefined);
  }

  async deleteReviewComment(input: { readonly profile: WorkspaceProfileConfig; readonly pr: PullRequestRef; readonly commentId: string }): Promise<Result<void, GitHubWriteFailure>> {
    const response = await this.commands.runJson({ argv: ["gh", "api", "--hostname", input.profile.githubHost, "--method", "DELETE", `repos/${input.pr.owner}/${input.pr.repo}/pulls/comments/${input.commentId}`], timeoutMs: commandTimeoutMs });
    return response._tag === "err" ? err(writeFailure(response.error)) : ok(undefined);
  }

  async dismissReview(input: { readonly profile: WorkspaceProfileConfig; readonly pr: PullRequestRef; readonly reviewId: string; readonly message: string }): Promise<Result<void, GitHubWriteFailure>> {
    const response = await this.commands.runJson({ argv: ["gh", "api", "--hostname", input.profile.githubHost, "--method", "PUT", `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/reviews/${input.reviewId}/dismissals`, "--input", "-"], stdin: JSON.stringify({ message: input.message }), timeoutMs: commandTimeoutMs });
    return response._tag === "err" ? err(writeFailure(response.error)) : ok(undefined);
  }

  async mergePullRequest(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly method: "merge" | "squash" | "rebase";
  }): Promise<Result<{ readonly mergeCommitSha?: GitSha }, GitHubWriteFailure>> {
    const response = await this.commands.runJson({
      argv: ["gh", "api", "--hostname", input.profile.githubHost, "--method", "PUT", `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/merge`, "--input", "-"],
      stdin: JSON.stringify({ sha: input.headSha, merge_method: input.method }),
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") return err(writeFailure(response.error));
    if (typeof response.value !== "object" || response.value === null || (response.value as { readonly merged?: unknown }).merged !== true)
      return err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "GitHub did not confirm the merge." });
    const rawSha = (response.value as { readonly sha?: unknown }).sha;
    const sha = rawSha === undefined ? undefined : parseGitSha(rawSha);
    return sha !== undefined && sha._tag === "err"
      ? err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "GitHub returned an invalid merge commit." })
      : ok(sha === undefined ? {} : { mergeCommitSha: sha.value });
  }

  private async verifyFetchedRefs(
    refs: FetchedDiffRefs,
  ): Promise<Result<void, GitHubReadFailure>> {
    const base = await this.resolveFetchedRef(
      refs.repositoryPath,
      refs.baseRef,
    );
    if (base._tag === "err" || base.value !== refs.baseSha) {
      return err({ _tag: "GitHubReadFailed", operation: "get_diff" });
    }
    const head = await this.resolveFetchedRef(
      refs.repositoryPath,
      refs.headRef,
    );
    if (head._tag === "err" || head.value !== refs.headSha) {
      return err({ _tag: "GitHubReadFailed", operation: "get_diff" });
    }
    return ok(undefined);
  }

  private async resolveFetchedRef(
    repositoryPath: AbsolutePath,
    ref: string,
  ): Promise<Result<GitSha, GitHubReadFailure>> {
    const response = await this.commands.runText({
      argv: [
        "git",
        "-C",
        repositoryPath,
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `${ref}^{commit}`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") {
      return err({ _tag: "GitHubReadFailed", operation: "get_diff" });
    }
    const sha = parseGitSha(response.value.trim());
    return sha._tag === "ok"
      ? sha
      : err({ _tag: "GitHubReadFailed", operation: "get_diff" });
  }

  async loadConversation(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<Conversation, GitHubReadFailure>> {
    const [prResult, commentsResult, feedbackResult] = await Promise.all([
      this.getPullRequest(input),
      this.getPullRequestComments(input),
      this.getPullRequestPublishedFeedback?.(input) ?? Promise.resolve(ok({ reviews: [], comments: [] })),
    ]);
    if (commentsResult._tag === "err") return commentsResult;
    if (feedbackResult._tag === "err") return feedbackResult;
    const prDescription = prResult._tag === "ok" ? (prResult.value.description ?? "") : "";
    return ok(this.assembleConversation(prDescription, feedbackResult.value, commentsResult.value));
  }

  private assembleConversation(
    prDescription: string,
    feedback: GitHubPublishedFeedback,
    comments: GitHubComments,
  ): Conversation {
    const entries: Conversation["entries"][number][] = [];
    for (const review of feedback.reviews) {
      entries.push({ _tag: "ReviewSummary" as const, review });
    }
    for (const comment of feedback.comments) {
      entries.push({ _tag: "IssueComment" as const, comment });
    }
    for (const thread of comments.threads) {
      if (thread.location !== undefined) continue;
      entries.push({ _tag: "GeneralThread" as const, thread });
    }
    entries.sort((a, b) => {
      const at = a._tag === "ReviewSummary" ? a.review.submittedAt : a._tag === "IssueComment" ? a.comment.createdAt : a._tag === "GeneralThread" ? (a.thread.comments[0]?.createdAt ?? "") : "";
      const bt = b._tag === "ReviewSummary" ? b.review.submittedAt : b._tag === "IssueComment" ? b.comment.createdAt : b._tag === "GeneralThread" ? (b.thread.comments[0]?.createdAt ?? "") : "";
      return at.localeCompare(bt);
    });
    return {
      prDescription,
      entries,
      inline: {
        threads: comments.threads.filter((thread) => thread.location !== undefined),
        ...(comments.complete === undefined ? {} : { complete: comments.complete }),
        ...(comments.incompleteReason === undefined
          ? {}
          : { incompleteReason: comments.incompleteReason }),
      },
      complete: feedback.complete !== false && comments.complete !== false,
    };
  }
}

/** A fixture-oriented GitHubReader with no process, filesystem, or network behavior. */
export class FakeGitHubAdapter implements GitHubReader, GitHubReviewWriter, GitHubMergeWriter {
  constructor(private readonly values: Partial<FakeGitHubAdapterValues>) {}

  async listOpenPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: PullRequestRef;
  }): Promise<Result<ReadonlyArray<PullRequestSummary>, GitHubReadFailure>> {
    void input;
    return this.values.listOpenPullRequests === undefined
      ? missing("list_open_prs")
      : ok(this.values.listOpenPullRequests);
  }

  async listMaintainerPullRequests(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly repo: PullRequestRef;
  }): Promise<Result<MaintainerPullRequestListing, GitHubReadFailure>> {
    void input;
    if (this.values.maintainerPullRequests !== undefined)
      return ok(this.values.maintainerPullRequests);
    if (this.values.listOpenPullRequests === undefined)
      return missing("list_maintainer_prs");
    return ok({
      pullRequests: this.values.listOpenPullRequests.map((summary) => ({
        summary,
        checks: this.values.checks ?? { overall: "unknown", checks: [] },
      })),
      complete: true,
    });
  }

  async getPullRequest(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<PullRequestSummary, GitHubReadFailure>> {
    void input;
    return this.values.pullRequest === undefined
      ? missing("get_pr")
      : ok(this.values.pullRequest);
  }

  async getMergePolicy(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly expectedHeadSha: GitSha;
  }): Promise<Result<MergePolicySnapshot, GitHubReadFailure>> {
    if (this.values.mergePolicy !== undefined) return ok(this.values.mergePolicy);
    const current = await this.getPullRequest(input);
    if (current._tag === "err") return current;
    return ok({ pr: input.pr, headSha: current.value.headSha, isOpen: current.value.isOpen, isDraft: current.value.isDraft, mergeability: current.value.mergeability, reviewDecision: current.value.reviewState === "approved" ? "approved" : current.value.reviewState === "changes_requested" ? "changes_requested" : current.value.reviewState === "review_pending" ? "review_required" : "unknown", checks: this.values.checks ?? { overall: "unknown", checks: [] }, complete: current.value.headSha === input.expectedHeadSha && current.value.reviewState !== "none" && current.value.reviewState !== "unknown" && this.values.checks !== undefined, ...(current.value.headSha === input.expectedHeadSha ? {} : { incompleteReason: "head_mismatch" }) });
  }

  async getMergePolicyEvidence(input: { readonly profile: WorkspaceProfileConfig; readonly pr: PullRequestRef; readonly branch: string }): Promise<Result<GitHubMergePolicyEvidence, GitHubReadFailure>> {
    void input;
    return this.values.mergePolicyEvidence === undefined
      ? missing("get_merge_policy_evidence")
      : ok(this.values.mergePolicyEvidence);
  }

  async getMergeOutcome(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<MergeOutcome, GitHubReadFailure>> {
    void input;
    return this.values.mergeOutcome === undefined ? missing("get_pr") : ok(this.values.mergeOutcome);
  }

  async getPullRequestCommits(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<ReadonlyArray<PullRequestCommit>, GitHubReadFailure>> {
    void input;
    return ok(this.values.commits ?? []);
  }

  async getPullRequestPublishedFeedback(input: { readonly profile: WorkspaceProfileConfig; readonly pr: PullRequestRef }): Promise<Result<GitHubPublishedFeedback, GitHubReadFailure>> {
    void input;
    return this.values.publishedFeedback === undefined
      ? ok({ reviews: [], comments: [], complete: true })
      : ok(this.values.publishedFeedback);
  }

  async getRepositoryPermission(input: { readonly profile: WorkspaceProfileConfig; readonly pr: PullRequestRef; readonly account: string }): Promise<Result<RepositoryPermissionEvidence, GitHubReadFailure>> {
    void input;
    return this.values.repositoryPermission === undefined
      ? missing("get_repository_permission")
      : ok(this.values.repositoryPermission);
  }

  async getBranchProtection(input: { readonly profile: WorkspaceProfileConfig; readonly pr: PullRequestRef; readonly branch: string }): Promise<Result<BranchProtectionEvidence, GitHubReadFailure>> {
    void input;
    return this.values.branchProtection === undefined
      ? missing("get_branch_protection")
      : ok(this.values.branchProtection);
  }

  async getPullRequestComments(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<GitHubComments, GitHubReadFailure>> {
    void input;
    return this.values.comments === undefined
      ? missing("get_comments")
      : ok(this.values.comments);
  }

  async getReviewThreadTarget(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly threadId: GitHubThreadId;
  }): Promise<Result<GitHubThreadTarget, GitHubReadFailure>> {
    if (this.values.threadTargets === undefined) return missing("get_thread_target");
    const target = this.values.threadTargets.find(
      (entry) => entry.threadId === input.threadId && samePullRequest(entry.pr, input.pr),
    );
    if (target === undefined) return ok({ found: false });
    return ok({ found: true });
  }

  async getReviewCommentTarget(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly commentId: string;
  }): Promise<Result<GitHubCommentTarget, GitHubReadFailure>> {
    if (this.values.commentTargets === undefined) return missing("get_comment_target");
    const target = this.values.commentTargets.find(
      (entry) => entry.commentId === input.commentId && samePullRequest(entry.pr, input.pr),
    );
    return target === undefined
      ? ok({ found: false })
      : ok({ found: true, viewerDidAuthor: target.viewerDidAuthor });
  }

  async getPullRequestChecks(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
  }): Promise<Result<CheckSummary, GitHubReadFailure>> {
    void input;
    return this.values.checks === undefined
      ? missing("get_checks")
      : ok(this.values.checks);
  }

  async createInlineComment(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly coordinates: GitHubReviewCoordinates;
    readonly body: string;
  }): Promise<Result<{ readonly commentId: string; readonly reviewId?: string }, GitHubWriteFailure>> {
    void input;
    return this.values.createInlineComment === undefined
      ? err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "create_inline_comment" })
      : ok(this.values.createInlineComment);
  }

  async createThreadReply(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly threadId: GitHubThreadId;
    readonly body: string;
  }): Promise<Result<{ readonly commentId: string; readonly reviewId?: string }, GitHubWriteFailure>> {
    void input;
    return this.values.createThreadReply === undefined
      ? err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "create_thread_reply" })
      : ok(this.values.createThreadReply);
  }

  async setReviewThreadState(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly threadId: GitHubThreadId;
    readonly state: "resolved" | "open";
  }): Promise<Result<void, GitHubWriteFailure>> {
    void input;
    return this.values.setReviewThreadState === undefined
      ? err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "set_thread_state" })
      : ok(undefined);
  }

  async updateThreadComment(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly commentId: string;
    readonly body: string;
  }): Promise<Result<void, GitHubWriteFailure>> {
    void input;
    return this.values.updateThreadComment === undefined
      ? err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "update_comment" })
      : ok(undefined);
  }

  async deleteThreadComment(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly commentId: string;
  }): Promise<Result<void, GitHubWriteFailure>> {
    void input;
    return this.values.deleteThreadComment === undefined
      ? err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "delete_comment" })
      : ok(undefined);
  }

  async getPullRequestDiff(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly fetchedRefs?: FetchedDiffRefs;
    readonly snapshot?: { readonly baseSha: GitSha; readonly headSha: GitSha };
  }): Promise<Result<string, GitHubReadFailure>> {
    void input;
    return this.values.diff === undefined
      ? missing("get_diff")
      : ok(this.values.diff);
  }

  async getFileContents(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly sha: GitSha;
    readonly path: RepoRelativePath;
  }): Promise<Result<GitHubFileContents, GitHubReadFailure>> {
    void input;
    return this.values.fileContents === undefined
      ? missing("get_file")
      : ok(this.values.fileContents);
  }

  async compareRevisions(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly baseSha: GitSha;
    readonly headSha: GitSha;
    readonly baseSessionId: ReviewSessionId;
  }): Promise<Result<GitHubRevisionComparison, GitHubReadFailure>> {
    void input;
    return this.values.comparison === undefined
      ? missing("compare_revisions")
      : ok(this.values.comparison);
  }

  async resolveAuthenticatedAccount(
    profile: WorkspaceProfileConfig,
  ): Promise<Result<AuthenticatedGitHubAccount, GitHubReadFailure>> {
    void profile;
    return this.values.authenticatedAccount === undefined
      ? missing("auth_status")
      : ok(this.values.authenticatedAccount);
  }

  async createPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly summaryBody: string;
    readonly comments: ReadonlyArray<PendingReviewComment>;
  }): Promise<Result<{ readonly reviewId: string; readonly state: "PENDING" }, GitHubWriteFailure>> {
    void input;
    return this.values.pendingReview === undefined
      ? err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "Missing pending review fixture." })
      : ok(this.values.pendingReview);
  }

  async submitPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: string;
    readonly event: GitHubReviewEvent;
    readonly summaryBody: string;
  }): Promise<Result<{ readonly reviewId: string }, GitHubWriteFailure>> {
    void input;
    return this.values.submittedReview === undefined
      ? err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "Missing submitted review fixture." })
      : ok(this.values.submittedReview);
  }

  async getViewerPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly account: GitHubLogin;
  }): Promise<Result<PendingReviewRead, GitHubReadFailure>> {
    void input;
    const value = this.values.viewerPendingReview;
    if (value === undefined) return missing("get_pending_review");
    // Import isolation: a foreign account never sees the viewer's pending review.
    return value.account === input.account ? ok(value.read) : ok({ _tag: "None" });
  }

  async startPendingReviewWithThread(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly anchor: PendingReviewAnchor;
    readonly body: string;
  }): Promise<Result<PendingReviewThreadWrite, GitHubWriteFailure>> {
    void input;
    const value = this.values.pendingReviewStart;
    if (value === undefined) {
      return err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "Missing pending-review start fixture." });
    }
    return value.failure === undefined ? ok(value.write) : err(value.failure);
  }

  async addPendingReviewThread(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: GitHubReviewNodeId;
    readonly anchor: PendingReviewAnchor;
    readonly body: string;
  }): Promise<Result<PendingReviewThreadWrite, GitHubWriteFailure>> {
    void input;
    const value = this.values.pendingReviewAddThread;
    if (value === undefined) {
      return err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "Missing pending-review append fixture." });
    }
    return value.failure === undefined ? ok(value.write) : err(value.failure);
  }

  async discardPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: GitHubReviewRestId;
  }): Promise<Result<void, GitHubWriteFailure>> {
    void input;
    const value = this.values.pendingReviewDiscard;
    if (value === undefined) {
      return err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "Missing pending-review discard fixture." });
    }
    return value.failure === undefined ? ok(undefined) : err(value.failure);
  }

  async mergePullRequest(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly method: "merge" | "squash" | "rebase";
  }): Promise<Result<{ readonly mergeCommitSha?: GitSha }, GitHubWriteFailure>> {
    void input;
    return this.values.mergeResult === undefined
      ? err({ _tag: "GitHubWriteFailure", category: "unavailable", message: "Missing merge fixture." })
      : ok(this.values.mergeResult);
  }

  async loadConversation(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
  }): Promise<Result<Conversation, GitHubReadFailure>> {
    void input;
    const pr = this.values.pullRequest;
    const prDescription = pr?.description ?? "";
    const threads = this.values.comments ?? { threads: [], complete: true };
    const feedback: GitHubPublishedFeedback = this.values.publishedFeedback ?? { reviews: [], comments: [] };
    const entries: Conversation["entries"][number][] = [];
    for (const review of feedback.reviews) {
      entries.push({ _tag: "ReviewSummary" as const, review });
    }
    for (const comment of feedback.comments) {
      entries.push({ _tag: "IssueComment" as const, comment });
    }
    for (const thread of threads.threads) {
      if (thread.location !== undefined) continue;
      entries.push({ _tag: "GeneralThread" as const, thread });
    }
    entries.sort((a, b) => {
      const at = a._tag === "ReviewSummary" ? a.review.submittedAt : a._tag === "IssueComment" ? a.comment.createdAt : a._tag === "GeneralThread" ? (a.thread.comments[0]?.createdAt ?? "") : "";
      const bt = b._tag === "ReviewSummary" ? b.review.submittedAt : b._tag === "IssueComment" ? b.comment.createdAt : b._tag === "GeneralThread" ? (b.thread.comments[0]?.createdAt ?? "") : "";
      return at.localeCompare(bt);
    });
    return ok({ prDescription, entries, complete: feedback.complete !== false && threads.complete !== false });
  }
}

/** Fixture values accepted by FakeGitHubAdapter. */
export type FakeGitHubAdapterValues = {
  readonly listOpenPullRequests: ReadonlyArray<PullRequestSummary>;
  readonly maintainerPullRequests: MaintainerPullRequestListing;
  readonly pullRequest: PullRequestSummary;
  readonly mergePolicy: MergePolicySnapshot;
  readonly mergePolicyEvidence: GitHubMergePolicyEvidence;
  readonly mergeOutcome: MergeOutcome;
  readonly comments: GitHubComments;
  readonly publishedFeedback: GitHubPublishedFeedback;
  readonly repositoryPermission: RepositoryPermissionEvidence;
  readonly branchProtection: BranchProtectionEvidence;
  readonly commits: ReadonlyArray<PullRequestCommit>;
  readonly checks: CheckSummary;
  readonly diff: string;
  readonly fileContents: GitHubFileContents;
  readonly comparison: GitHubRevisionComparison;
  readonly authenticatedAccount: AuthenticatedGitHubAccount;
  readonly pendingReview: { readonly reviewId: string; readonly state: "PENDING" };
  readonly submittedReview: { readonly reviewId: string };
  /** Spike-proven pending-review gateway fixtures; an absent reader is unimplemented. */
  readonly viewerPendingReview?: { readonly account: GitHubLogin; readonly read: PendingReviewRead };
  readonly pendingReviewStart?: { readonly write: PendingReviewThreadWrite; readonly failure?: GitHubWriteFailure };
  readonly pendingReviewAddThread?: { readonly write: PendingReviewThreadWrite; readonly failure?: GitHubWriteFailure };
  readonly pendingReviewDiscard?: { readonly failure?: GitHubWriteFailure };
  readonly mergeResult: { readonly mergeCommitSha?: GitSha };
  /** Thread ids proven to belong to the fixture pull request (owner/repo/number). */
  readonly threadTargets: ReadonlyArray<{ readonly threadId: GitHubThreadId; readonly pr: PullRequestRef }>;
  /** Comment ids proven to belong to the fixture pull request, with authorship. */
  readonly commentTargets: ReadonlyArray<{ readonly commentId: string; readonly viewerDidAuthor: boolean; readonly pr: PullRequestRef }>;
  /** Confirmed writer receipts; an absent writer keeps the fake unimplemented. */
  readonly createInlineComment?: { readonly commentId: string; readonly reviewId?: string };
  readonly createThreadReply?: { readonly commentId: string; readonly reviewId?: string };
  readonly setReviewThreadState?: Record<string, never>;
  readonly updateThreadComment?: Record<string, never>;
  readonly deleteThreadComment?: Record<string, never>;
};

function parseMaintainerPullRequest(
  input: v.InferOutput<typeof maintainerInboxResponseSchema>["data"]["repository"]["pullRequests"]["nodes"][number],
  host: GitHubHost,
  owner: GitHubOwner,
  repo: GitHubRepoName,
): Result<MaintainerPullRequest, { readonly _tag: "Invalid" }> {
  const number = parsePullRequestNumber(input.number);
  const headSha = parseGitSha(input.headRefOid);
  const baseSha =
    input.baseRefOid === undefined
      ? undefined
      : parseGitSha(input.baseRefOid);
  const updatedAt = parseGitHubTimestamp(input.updatedAt);
  if (
    number._tag === "err" ||
    headSha._tag === "err" ||
    (baseSha !== undefined && baseSha._tag === "err") ||
    updatedAt._tag === "err"
  )
    return err({ _tag: "Invalid" });
  const summary: PullRequestSummary = {
    ref: { host, owner, repo, number: number.value },
    title: input.title,
    author: input.author?.login ?? "ghost",
    headBranch: input.headRefName,
    baseBranch: input.baseRefName,
    headSha: headSha.value,
    ...(baseSha === undefined ? {} : { baseSha: baseSha.value }),
    isDraft: input.isDraft,
    isOpen: true,
    reviewState: mapReviewDecision(input.reviewDecision),
    mergeability: mapMergeability(input.mergeable),
    labels: [],
    requestedReviewers: input.reviewRequests.nodes.flatMap((request) =>
      request.requestedReviewer?.login === undefined
        ? []
        : [request.requestedReviewer.login],
    ),
    assignees: input.assignees.nodes.map((assignee) => assignee.login),
    updatedAt: updatedAt.value,
    additions: input.additions,
    deletions: input.deletions,
    changedFileCount: input.changedFiles,
  };
  const rollup = input.commits.nodes[0]?.commit.statusCheckRollup?.state;
  return ok({ summary, checks: rollupCheckSummary(rollup) });
}

function parseMergeOutcome(input: unknown): Result<MergeOutcome, GitHubReadFailure> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return invalid("get_pr");
  const state = "state" in input ? input.state : undefined;
  if (state === "open") return ok({ state: "open" });
  if (state !== "closed") return invalid("get_pr");
  const mergedAt = "merged_at" in input ? input.merged_at : undefined;
  if (mergedAt === null || mergedAt === undefined) return ok({ state: "closed_unmerged" });
  const parsedMergedAt = typeof mergedAt === "string" ? parseGitHubTimestamp(mergedAt) : parseIsoTimestamp(mergedAt);
  const mergeCommitSha = "merge_commit_sha" in input ? input.merge_commit_sha : undefined;
  const parsedCommit = mergeCommitSha === null || mergeCommitSha === undefined ? undefined : parseGitSha(mergeCommitSha);
  if (parsedMergedAt._tag === "err" || (parsedCommit !== undefined && parsedCommit._tag === "err")) return invalid("get_pr");
  return ok({ state: "merged", mergedAt: parsedMergedAt.value, ...(parsedCommit === undefined ? {} : { mergeCommitSha: parsedCommit.value }) });
}

function parseGitHubComparison(
  input: unknown,
  expected: {
    readonly baseSessionId: ReviewSessionId;
    readonly baseSha: GitSha;
    readonly headSha: GitSha;
  },
): RevisionComparison | undefined {
  if (!isObject(input)) return undefined;
  const baseSha = readSha(input.base_commit);
  const headSha = readSha(input.head_commit);
  const createdAt = typeof input.created_at === "string" ? parseGitHubTimestamp(input.created_at) : undefined;
  if (baseSha !== expected.baseSha || headSha !== expected.headSha || createdAt === undefined || createdAt._tag === "err" || !Array.isArray(input.files) || !Array.isArray(input.commits)) return undefined;
  const files = input.files.map(parseComparedFile);
  const commits = input.commits.map(parseComparedCommit);
  if (files.some((file) => file === undefined) || commits.some((commit) => commit === undefined)) return undefined;
  const safeFiles = files.filter((file): file is NonNullable<typeof file> => file !== undefined);
  const safeCommits = commits.filter((commit): commit is NonNullable<typeof commit> => commit !== undefined);
  const additions = safeFiles.reduce((total, file) => total + file.additions, 0);
  const deletions = safeFiles.reduce((total, file) => total + file.deletions, 0);
  return {
    schemaVersion: 1,
    baseSessionId: expected.baseSessionId,
    baseHeadSha: expected.baseSha,
    headSha: expected.headSha,
    ancestry: input.status === "ahead" ? "fast_forward" : "rewritten",
    source: "github",
    // GitHub's comparison file list is capped. Refuse to call a cap-sized list complete.
    completeness: safeFiles.length >= 300 ? "incomplete" : "complete",
    commits: safeCommits,
    files: safeFiles,
    additions,
    deletions,
    createdAt: createdAt.value,
  };
}

function parseComparedFile(input: unknown): RevisionComparison["files"][number] | undefined {
  if (!isObject(input) || typeof input.filename !== "string" || typeof input.status !== "string" || !isNonNegativeInteger(input.additions) || !isNonNegativeInteger(input.deletions)) return undefined;
  const status = input.status === "added" || input.status === "modified" || input.status === "deleted" || input.status === "renamed" || input.status === "copied" ? input.status : "unknown";
  const oldPath = typeof input.previous_filename === "string" ? input.previous_filename : undefined;
  const textPatchAvailable = typeof input.patch === "string";
  return { path: input.filename, ...(oldPath === undefined ? {} : { oldPath }), status, additions: input.additions, deletions: input.deletions, binary: !textPatchAvailable, textPatchAvailable };
}

function parseComparedCommit(input: unknown): RevisionComparison["commits"][number] | undefined {
  if (!isObject(input) || typeof input.sha !== "string" || !isObject(input.commit) || typeof input.commit.message !== "string" || !isObject(input.commit.author) || typeof input.commit.author.name !== "string" || typeof input.commit.author.date !== "string") return undefined;
  const sha = parseGitSha(input.sha);
  const authoredAt = parseGitHubTimestamp(input.commit.author.date);
  if (sha._tag === "err" || authoredAt._tag === "err") return undefined;
  return { sha: sha.value, subject: input.commit.message.split("\n", 1)[0] ?? "", author: input.commit.author.name, authoredAt: authoredAt.value };
}

function readSha(input: unknown): GitSha | undefined {
  if (!isObject(input)) return undefined;
  const sha = parseGitSha(input.sha);
  return sha._tag === "ok" ? sha.value : undefined;
}

function isObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function nestedString(input: unknown, keys: ReadonlyArray<string>): string | undefined {
  let value: unknown = input;
  for (const key of keys) {
    if (!isObject(value)) return undefined;
    value = value[key];
  }
  return typeof value === "string" ? value : undefined;
}

function nestedArray(input: unknown, keys: ReadonlyArray<string>): ReadonlyArray<unknown> | undefined {
  let value: unknown = input;
  for (const key of keys) {
    if (!isObject(value)) return undefined;
    value = value[key];
  }
  return Array.isArray(value) ? value : undefined;
}

function nestedObject(input: unknown, keys: ReadonlyArray<string>): Record<string, unknown> | undefined {
  let value: unknown = input;
  for (const key of keys) {
    if (!isObject(value)) return undefined;
    value = value[key];
  }
  return isObject(value) ? value : undefined;
}

function nestedBoolean(input: unknown, keys: ReadonlyArray<string>): boolean | undefined {
  let value: unknown = input;
  for (const key of keys) {
    if (!isObject(value)) return undefined;
    value = value[key];
  }
  return typeof value === "boolean" ? value : undefined;
}

/** The `data.node` payload of a single-node query; undefined when GitHub returned a null or missing node. */
function readNode(input: unknown): Record<string, unknown> | undefined {
  const node = nestedObject(input, ["data", "node"]);
  return node === undefined ? undefined : node;
}

/**
 * Compares a node's pull-request identity with the active Review's pull
 * request. Thread nodes expose PR identity through their first comment; the
 * adapter resolves the comparison so a foreign target is never disclosed.
 */
function matchesPullRequest(node: Record<string, unknown>, pr: PullRequestRef): boolean {
  const owner = nestedString(node, ["pullRequest", "repository", "owner", "login"]);
  const name = nestedString(node, ["pullRequest", "repository", "name"]);
  const number = nestedNumber(node, ["pullRequest", "number"]);
  return owner === pr.owner && name === pr.repo && number === pr.number;
}

/** Fixture counterpart of `matchesPullRequest`: identical membership semantics. */
function samePullRequest(a: PullRequestRef, b: PullRequestRef): boolean {
  return a.owner === b.owner && a.repo === b.repo && a.number === b.number;
}

function nestedNumber(input: unknown, keys: ReadonlyArray<string>): number | undefined {
  let value: unknown = input;
  for (const key of keys) {
    if (!isObject(value)) return undefined;
    value = value[key];
  }
  return typeof value === "number" ? value : undefined;
}

function isNonNegativeInteger(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0;
}

function mapReviewDecision(value: string | null | undefined): PullRequestSummary["reviewState"] {
  switch (value) {
    case "APPROVED": return "approved";
    case "CHANGES_REQUESTED": return "changes_requested";
    case "REVIEW_REQUIRED": return "review_pending";
    case null:
    case undefined: return "none";
    default: return "unknown";
  }
}

function rollupCheckSummary(value: string | undefined): CheckSummary {
  switch (value) {
    case "SUCCESS": return { overall: "passing", checks: [] };
    case "FAILURE":
    case "ERROR":
    case "EXPECTED": return { overall: "failing", checks: [] };
    case "PENDING": return { overall: "pending", checks: [] };
    default: return { overall: "unknown", checks: [] };
  }
}

function parseMergePolicyPage(input: unknown): MergePolicyPage | undefined {
  const parsed = v.safeParse(mergePolicyResponseSchema, input);
  if (!parsed.success) return undefined;
  const pullRequest = parsed.output.data.repository.pullRequest;
  const headSha = parseGitSha(pullRequest.headRefOid);
  const rollup = pullRequest.commits.nodes[0]?.commit.statusCheckRollup;
  if (headSha._tag === "err" || rollup === null || rollup === undefined) return undefined;
  const contexts: Array<CheckRunSummary> = [];
  for (const context of rollup.contexts.nodes) {
    const summary = parsePolicyContext(context);
    if (summary === undefined) return undefined;
    contexts.push(summary);
  }
  return {
    headSha: headSha.value,
    baseBranch: pullRequest.baseRefName,
    isOpen: pullRequest.state === "OPEN",
    isDraft: pullRequest.isDraft,
    mergeability: mapMergeability(pullRequest.mergeable),
    mergeStateStatus: mapMergeStateStatus(pullRequest.mergeStateStatus),
    reviewDecision: mapMergePolicyReviewDecision(pullRequest.reviewDecision),
    contexts,
    hasNextPage: rollup.contexts.pageInfo.hasNextPage,
    ...(typeof rollup.contexts.pageInfo.endCursor === "string" ? { endCursor: rollup.contexts.pageInfo.endCursor } : {}),
  };
}

function parsePolicyContext(input: unknown): CheckRunSummary | undefined {
  if (!isObject(input) || typeof input.__typename !== "string") return undefined;
  const name = typeof input.name === "string" ? input.name : undefined;
  const status = typeof input.status === "string" ? input.status : undefined;
  if (input.__typename === "CheckRun" && name !== undefined && status !== undefined) {
    const conclusion = mapCheckConclusion(typeof input.conclusion === "string" ? input.conclusion.toLowerCase() : undefined);
    const url = typeof input.detailsUrl === "string" ? input.detailsUrl : undefined;
    return {
      name,
      required: "unknown",
      status: mapCheckStatus(status.toLowerCase()),
      ...(conclusion === undefined ? {} : { conclusion }),
      ...(url === undefined ? {} : { url }),
    };
  }
  const context = typeof input.context === "string" ? input.context : undefined;
  const stateValue = typeof input.state === "string" ? input.state : undefined;
  if (input.__typename === "StatusContext" && context !== undefined && stateValue !== undefined) {
    const state = stateValue.toLowerCase();
    const url = typeof input.targetUrl === "string" ? input.targetUrl : undefined;
    return {
      name: context,
      required: "unknown",
      status: state === "pending" || state === "expected" ? "in_progress" : "completed",
      ...(state === "success" ? { conclusion: "success" as const } : state === "failure" || state === "error" ? { conclusion: "failure" as const } : {}),
      ...(url === undefined ? {} : { url }),
    };
  }
  return undefined;
}

function parseRequiredContexts(input: unknown): ReadonlySet<string> | undefined {
  const parsed = v.safeParse(requiredStatusChecksSchema, input);
  if (!parsed.success) return undefined;
  const values = [...(parsed.output.contexts ?? []), ...(parsed.output.checks ?? []).map((check) => check.context)];
  return new Set(values);
}

function completeMergePolicy(pr: PullRequestRef, page: MergePolicyPage, contexts: ReadonlyArray<CheckRunSummary>, requiredContexts: ReadonlySet<string>): MergePolicySnapshot {
  const matched = contexts.map((check) => ({ ...check, required: requiredContexts.has(check.name) }));
  const seen = new Set(matched.map((check) => check.name));
  for (const name of requiredContexts) {
    if (!seen.has(name)) matched.push({ name, required: true, status: "unknown" });
  }
  return { pr, headSha: page.headSha, isOpen: page.isOpen, isDraft: page.isDraft, mergeability: page.mergeability, mergeStateStatus: page.mergeStateStatus, reviewDecision: page.reviewDecision, checks: { overall: overallCheckStatus(matched), checks: matched }, complete: true };
}

function incompleteMergePolicy(pr: PullRequestRef, page: MergePolicyPage, contexts: ReadonlyArray<CheckRunSummary>, incompleteReason: Exclude<MergePolicySnapshot["incompleteReason"], undefined>): MergePolicySnapshot {
  return { pr, headSha: page.headSha, isOpen: page.isOpen, isDraft: page.isDraft, mergeability: page.mergeability, mergeStateStatus: page.mergeStateStatus, reviewDecision: page.reviewDecision, checks: { overall: overallCheckStatus(contexts), checks: contexts.map((check) => ({ ...check, required: "unknown" })) }, complete: false, incompleteReason };
}

function mapMergePolicyReviewDecision(value: string | null | undefined): MergePolicySnapshot["reviewDecision"] {
  if (value === "APPROVED") return "approved";
  if (value === "CHANGES_REQUESTED") return "changes_requested";
  if (value === "REVIEW_REQUIRED") return "review_required";
  return "unknown";
}

function mapMergeStateStatus(value: unknown): GitHubMergeStateStatus {
  switch (value) {
    case "BLOCKED": return "blocked";
    case "BEHIND": return "behind";
    case "DIRTY": return "dirty";
    case "DRAFT": return "draft";
    case "HAS_HOOKS": return "has_hooks";
    case "UNSTABLE": return "unstable";
    case "CLEAN": return "clean";
    case undefined:
    case null: return "unavailable";
    default: return "unknown";
  }
}

function parsePullRequest(
  input: unknown,
  host: GitHubHost,
  owner: GitHubOwner,
  repo: GitHubRepoName,
):
  | Result<PullRequestSummary, never>
  | Result<never, { readonly _tag: "Invalid" }> {
  const parsed = v.safeParse(pullRequestSchema, input);
  if (!parsed.success) return err({ _tag: "Invalid" });
  const number = parsePullRequestNumber(parsed.output.number);
  const headSha = parseGitSha(parsed.output.head.sha);
  const baseSha =
    parsed.output.base.sha === undefined
      ? undefined
      : parseGitSha(parsed.output.base.sha);
  const updatedAt = parseGitHubTimestamp(parsed.output.updated_at);
  if (
    number._tag === "err" ||
    headSha._tag === "err" ||
    (baseSha !== undefined && baseSha._tag === "err") ||
    updatedAt._tag === "err"
  )
    return err({ _tag: "Invalid" });

  const summary: PullRequestSummary = {
    ref: { host, owner, repo, number: number.value },
    title: parsed.output.title,
    ...(parsed.output.body === undefined || parsed.output.body === null
      ? {}
      : { description: parsed.output.body }),
    author: parsed.output.user.login,
    headBranch: parsed.output.head.ref,
    baseBranch: parsed.output.base.ref,
    headSha: headSha.value,
    ...(baseSha === undefined ? {} : { baseSha: baseSha.value }),
    isDraft: parsed.output.draft,
    isOpen: parsed.output.state === "open",
    reviewState: "unknown",
    mergeability: mapMergeability(parsed.output.mergeable_state),
    labels: (parsed.output.labels ?? []).map((label) => label.name),
    ...(parsed.output.requested_reviewers === undefined
      ? {}
      : {
          requestedReviewers: parsed.output.requested_reviewers.map(
            (reviewer) => reviewer.login,
          ),
        }),
    ...(parsed.output.assignees === undefined
      ? {}
      : {
          assignees: parsed.output.assignees.map((assignee) => assignee.login),
        }),
    updatedAt: updatedAt.value,
    ...(parsed.output.changed_files === undefined
      ? {}
      : { changedFileCount: parsed.output.changed_files }),
    ...(parsed.output.additions === undefined
      ? {}
      : { additions: parsed.output.additions }),
    ...(parsed.output.deletions === undefined
      ? {}
      : { deletions: parsed.output.deletions }),
  };
  return ok(summary);
}

function parseComment(
  input: v.InferOutput<
    typeof threadResponseSchema
  >["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"][number]["comments"]["nodes"][number],
): Result<GitHubComment, { readonly _tag: "Invalid" }> {
  const createdAt = parseGitHubTimestamp(input.createdAt);
  const updatedAt =
    input.updatedAt === null || input.updatedAt === undefined
      ? undefined
      : parseGitHubTimestamp(input.updatedAt);
  if (
    createdAt._tag === "err" ||
    (updatedAt !== undefined && updatedAt._tag === "err")
  )
    return err({ _tag: "Invalid" });

  const location = parseLocation(
    input.path,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  );
  const comment: GitHubComment = {
    id: input.id,
    author: input.author?.login ?? "ghost",
    body: input.body,
    createdAt: createdAt.value,
    ...(updatedAt === undefined ? {} : { updatedAt: updatedAt.value }),
    ...(input.url === null || input.url === undefined
      ? {}
      : { url: input.url }),
    ...(location === undefined ? {} : { location }),
    ...(input.viewerDidAuthor === undefined
      ? {}
      : { viewerDidAuthor: input.viewerDidAuthor }),
  };
  return ok(comment);
}

function parseLocation(
  path: string | null | undefined,
  line: number | null | undefined,
  originalLine: number | null | undefined,
  startLine: number | null | undefined,
  diffSide: string | null | undefined,
  startSide: string | null | undefined,
): GitHubComment["location"] {
  if (path === null || path === undefined) return undefined;
  const parsedPath = parseRepoRelativePath(path);
  if (parsedPath._tag === "err") return undefined;
  const selectedLine =
    line === null || line === undefined
      ? originalLine === null || originalLine === undefined
        ? undefined
        : originalLine
      : line;
  // GitHub reports single-line LEFT-side threads with a phantom startLine of
  // line + 1 (the range is degenerate, not inverted); normalizing it keeps the
  // thread anchored to the single old-side line it was created on.
  return {
    path: parsedPath.value,
    ...(selectedLine === undefined
      ? {}
      : startLine === null || startLine === undefined
        ? { line: selectedLine }
        : startLine > selectedLine
          ? { line: selectedLine }
          : { line: startLine, lineEnd: selectedLine }),
    ...(diffSide === "RIGHT"
      ? { diffSide: "new" as const }
      : diffSide === "LEFT" || startSide === "LEFT"
        ? { diffSide: "old" as const }
        : startSide === "RIGHT"
          ? { diffSide: "new" as const }
          : {}),
  };
}

function toCheckRunSummary(
  input: v.InferOutput<typeof checkRunsSchema>["check_runs"][number],
): CheckRunSummary {
  const conclusion = mapCheckConclusion(input.conclusion);
  return {
    name: input.name,
    required: "unknown",
    status: mapCheckStatus(input.status),
    ...(conclusion === undefined ? {} : { conclusion }),
    ...(input.details_url === null || input.details_url === undefined
      ? {}
      : { url: input.details_url }),
  };
}

function toCommitStatusSummary(
  input: v.InferOutput<typeof commitStatusesSchema>["statuses"][number],
): CheckRunSummary {
  const state = input.state.toLowerCase();
  return {
    name: input.context,
    required: "unknown",
    status: state === "pending" || state === "expected" ? "in_progress" : "completed",
    ...(state === "success"
      ? { conclusion: "success" as const }
      : state === "failure" || state === "error"
        ? { conclusion: "failure" as const }
        : {}),
    ...(input.target_url === null || input.target_url === undefined
      ? {}
      : { url: input.target_url }),
  };
}

function mapMergeability(
  value: string | undefined,
): PullRequestSummary["mergeability"] {
  if (value === "clean" || value === "MERGEABLE") return "mergeable";
  if (value === "dirty" || value === "CONFLICTING") return "conflicting";
  if (value === "blocked" || value === "BLOCKED") return "blocked";
  return "unknown";
}

function mapCheckStatus(value: string): CheckRunSummary["status"] {
  if (value === "queued" || value === "in_progress" || value === "completed")
    return value;
  return "unknown";
}

function mapCheckConclusion(
  value: string | null | undefined,
): CheckRunSummary["conclusion"] {
  if (
    value === "success" ||
    value === "failure" ||
    value === "cancelled" ||
    value === "timed_out" ||
    value === "skipped" ||
    value === "neutral"
  )
    return value;
  return undefined;
}

function overallCheckStatus(
  checks: ReadonlyArray<CheckRunSummary>,
): CheckSummary["overall"] {
  if (checks.length === 0) return "unknown";
  if (checks.some((check) => check.status !== "completed")) return "pending";
  if (
    checks.some(
      (check) =>
        check.conclusion === "failure" ||
        check.conclusion === "cancelled" ||
        check.conclusion === "timed_out",
    )
  )
    return "failing";
  if (checks.every((check) => check.conclusion === "skipped")) return "skipped";
  if (
    checks.every(
      (check) =>
        check.conclusion === "success" ||
        check.conclusion === "neutral" ||
        check.conclusion === "skipped",
    )
  )
    return "passing";
  return "unknown";
}

function parseGitHubTimestamp(
  input: string,
): ReturnType<typeof parseIsoTimestamp> {
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(input)
    ? `${input.slice(0, -1)}.000Z`
    : input;
  return parseIsoTimestamp(normalized);
}

function parseOptionalPolicyResponse(
  response: Result<unknown, CommandFailure>,
  kind: "branchProtection",
): Result<GitHubMergePolicyEvidence["branchProtection"], GitHubReadFailure>;
function parseOptionalPolicyResponse(
  response: Result<unknown, CommandFailure>,
  kind: "appliedRuleset",
): Result<GitHubMergePolicyEvidence["appliedRuleset"], GitHubReadFailure>;
function parseOptionalPolicyResponse(
  response: Result<unknown, CommandFailure>,
  kind: "branchProtection" | "appliedRuleset",
): Result<GitHubMergePolicyEvidence["branchProtection"] | GitHubMergePolicyEvidence["appliedRuleset"], GitHubReadFailure> {
  if (response._tag === "err") {
    const reason = optionalPolicyUnavailableReason(response.error);
    return reason === undefined
      ? commandFailure("get_merge_policy_evidence", response.error)
      : ok({ state: "unavailable", reason });
  }
  if (kind === "branchProtection") {
    const parsed = v.safeParse(mergeEvidenceBranchProtectionSchema, response.value);
    if (!parsed.success) return invalid("get_merge_policy_evidence");
    const reviews = parsed.output.required_pull_request_reviews;
    const value: GitHubClassicBranchProtectionEvidence = reviews === null
      ? {}
      : {
          // GitHub reports zero when no approval policy is configured. It is
          // not usable evidence for an approval requirement.
          ...(reviews.required_approving_review_count > 0
            ? { requiredApprovingReviewCount: reviews.required_approving_review_count }
            : {}),
          dismissStaleReviews: reviews.dismiss_stale_reviews,
          requireCodeOwnerReviews: reviews.require_code_owner_reviews,
        };
    return ok({ state: "available", value });
  }
  const parsed = v.safeParse(appliedRulesetSchema, response.value);
  if (!parsed.success) return invalid("get_merge_policy_evidence");
  const value: GitHubAppliedRulesetEvidence = {
    rules: parsed.output.map((rule) => ({ type: rule.type, ...(rule.name === undefined ? {} : { name: rule.name }) })),
  };
  return ok({ state: "available", value });
}

function optionalPolicyUnavailableReason(
  failure: CommandFailure,
): "forbidden" | "not_found" | "unsupported" | undefined {
  if (failure._tag === "CommandForbidden") return "forbidden";
  if (failure._tag === "CommandNotFound") return "not_found";
  if (failure._tag === "CommandUnsupported") return "unsupported";
  return undefined;
}

function commandFailure(
  operation: GitHubReadOperation,
  failure: CommandFailure,
): Result<never, GitHubReadFailure> {
  return failure._tag === "CommandAuthenticationRequired"
    ? err({ _tag: "GitHubAuthenticationFailed", operation })
    : err({ _tag: "GitHubReadFailed", operation });
}

function toGitHubReviewComment(comment: PendingReviewComment): Record<string, unknown> {
  const side = comment.diffSide === "new" ? "RIGHT" : "LEFT";
  return {
    path: comment.path,
    line: comment.lineEnd ?? comment.line,
    side,
    body: comment.body,
    ...(comment.lineEnd === undefined
      ? {}
      : { start_line: comment.line, start_side: side }),
  };
}

/** REST create-review comment shape for one pending-review start. */
function pendingReviewComment(anchor: PendingReviewAnchor, body: string): Record<string, unknown> {
  const side = anchor.side === "new" ? "RIGHT" : "LEFT";
  return {
    path: anchor.path,
    line: anchor.line,
    side,
    body,
    ...(anchor.startLine === anchor.line
      ? {}
      : { start_line: anchor.startLine, start_side: side }),
  };
}

/** Domain anchor from a spike-proven thread shape, normalizing the LEFT single-line quirk. */
function pendingReviewAnchor(thread: {
  readonly path?: string | null | undefined;
  readonly line?: number | null | undefined;
  readonly startLine?: number | null | undefined;
  readonly diffSide?: string | null | undefined;
}): PendingReviewAnchor | undefined {
  const path = thread.path === undefined || thread.path === null
    ? err({ _tag: "InvalidDomainValue" as const, field: "threadPath" })
    : parseRepoRelativePath(thread.path);
  if (path._tag === "err" || thread.line === undefined || thread.line === null) return undefined;
  const side = thread.diffSide === "LEFT" ? "old" : thread.diffSide === "RIGHT" ? "new" : undefined;
  if (side === undefined) return undefined;
  // GitHub reports LEFT single-line threads as an inverted range; the adapter
  // normalizes startLine > line to a single-line anchor.
  const startLine = thread.startLine === undefined || thread.startLine === null || thread.startLine > thread.line
    ? thread.line
    : thread.startLine;
  return { path: path.value, startLine, line: thread.line, side };
}

function parseReviewId(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("id" in input)) return undefined;
  const value = (input as { readonly id: unknown }).id;
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value))
    ? String(value)
    : undefined;
}

function parsePendingReview(input: unknown): { readonly reviewId: string; readonly state: "PENDING" } | undefined {
  const reviewId = parseReviewId(input);
  if (reviewId === undefined || typeof input !== "object" || input === null) return undefined;
  return (input as { readonly state?: unknown }).state === "PENDING"
    ? { reviewId, state: "PENDING" }
    : undefined;
}

function writeFailure(failure: CommandFailure): GitHubWriteFailure {
  if (failure._tag === "CommandAuthenticationRequired")
    return { _tag: "GitHubWriteFailure", category: "auth", message: "GitHub authentication is required." };
  if (failure._tag === "CommandPendingReview")
    return { _tag: "GitHubWriteFailure", category: "pending_review", message: "You have an unfinished review on this pull request on GitHub; submit or discard it before commenting." };
  if (failure._tag === "CommandFailed")
    return { _tag: "GitHubWriteFailure", category: "rejected", message: "GitHub rejected the review request." };
  return { _tag: "GitHubWriteFailure", category: "unavailable", message: "GitHub review request could not be confirmed." };
}

function directSummaryWriteFailure(failure: CommandFailure): GitHubWriteFailure {
  if (failure._tag === "CommandFailed") {
    return { _tag: "GitHubWriteFailure", category: "unavailable", message: "GitHub review request could not be confirmed." };
  }
  return writeFailure(failure);
}

function invalid(
  operation: GitHubReadOperation,
): Result<never, GitHubReadFailure> {
  return err({ _tag: "GitHubResponseInvalid", operation });
}

function missing(
  operation: GitHubReadOperation,
): Result<never, GitHubReadFailure> {
  return err({ _tag: "GitHubReadFailed", operation });
}

function isManagedFetchedRef(value: string): boolean {
  return (
    /^refs\/patchdesk\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
    !value.includes("..") &&
    !value.includes("//")
  );
}

function directSummaryEvent(state: string): GitHubReviewEvent | undefined {
  if (state === "COMMENTED") return "COMMENT";
  if (state === "APPROVED") return "APPROVE";
  if (state === "CHANGES_REQUESTED") return "REQUEST_CHANGES";
  return undefined;
}

function digestReviewBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function parseDirectSummaryReceipt(value: unknown, expectedEvent: GitHubReviewEvent): DirectSummaryReviewReceipt | undefined {
  const raw = v.safeParse(v.looseObject({ id: v.union([v.string(), v.number()]), state: v.string(), commit_id: v.nullish(v.string()), submitted_at: v.nullish(v.string()) }), value);
  if (!raw.success || raw.output.commit_id === undefined || raw.output.commit_id === null || raw.output.submitted_at === undefined || raw.output.submitted_at === null || directSummaryEvent(raw.output.state) !== expectedEvent) return undefined;
  const reviewId = parseGitHubReviewRestId(String(raw.output.id));
  const headSha = parseGitSha(raw.output.commit_id);
  const submittedAt = parseGitHubTimestamp(raw.output.submitted_at);
  return reviewId._tag === "err" || headSha._tag === "err" || submittedAt._tag === "err"
    ? undefined
    : { reviewId: reviewId.value, event: expectedEvent, headSha: headSha.value, submittedAt: submittedAt.value };
}
