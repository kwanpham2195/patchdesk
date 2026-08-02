import type { GitHubThreadId, GitSha, IsoTimestamp, RepoRelativePath } from "./ids";
import type { PullRequestRef } from "./pull-request";

export type DiffLocation = {
  readonly path: RepoRelativePath;
  readonly line?: number;
  readonly lineEnd?: number;
  readonly diffSide?: "new" | "old";
};

export type GitHubComment = {
  readonly id: string;
  readonly author: string;
  readonly body: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt?: IsoTimestamp;
  readonly url?: string;
  readonly location?: DiffLocation;
};

export type GitHubConversationThread = {
  readonly id: GitHubThreadId;
  readonly state: "open" | "resolved" | "outdated" | "unknown";
  readonly comments: ReadonlyArray<GitHubComment>;
  /** False when a bounded GitHub page could not contain every reply. */
  readonly complete?: boolean;
  readonly location?: DiffLocation;
};

export type CheckRunSummary = {
  readonly name: string;
  readonly required: boolean | "unknown";
  readonly status: "queued" | "in_progress" | "completed" | "unknown";
  readonly conclusion?:
    "success" | "failure" | "cancelled" | "timed_out" | "skipped" | "neutral";
  readonly url?: string;
};

export type CheckSummary = {
  readonly overall: "passing" | "failing" | "pending" | "skipped" | "unknown";
  readonly checks: ReadonlyArray<CheckRunSummary>;
};

/** Fresh, exact-head policy evidence required before Patchdesk may request a merge. */
export type MergePolicySnapshot = {
  readonly pr: PullRequestRef;
  readonly headSha: GitSha;
  readonly isOpen: boolean;
  readonly isDraft: boolean;
  readonly mergeability: "mergeable" | "conflicting" | "blocked" | "unknown";
  readonly reviewDecision: "approved" | "changes_requested" | "review_required" | "unknown";
  readonly checks: CheckSummary;
  readonly complete: boolean;
  readonly incompleteReason?: "head_mismatch" | "pagination" | "permission" | "unavailable" | "mapping";
};

export type PullRequestCommit = {
  readonly sha: GitSha;
  readonly message: string;
  readonly author: string;
  readonly authoredAt: IsoTimestamp;
  readonly url?: string;
  readonly isHead: boolean;
};

export type PublishedReview = {
  readonly id: string;
  readonly author: string;
  readonly body: string;
  readonly event: "APPROVED" | "COMMENTED" | "CHANGES_REQUESTED" | "DISMISSED";
  readonly submittedAt: IsoTimestamp;
  readonly canDismiss: boolean;
};

export type PublishedReviewComment = GitHubComment & {
  readonly reviewId?: string;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
};

export type GitHubPublishedFeedback = {
  readonly reviews: ReadonlyArray<PublishedReview>;
  readonly comments: ReadonlyArray<PublishedReviewComment>;
  readonly complete?: boolean;
  readonly incompleteReason?: "pagination" | "unavailable";
};

export type PullRequestSnapshot = {
  readonly headSha: GitSha;
  /** Exact base SHA used to hydrate omitted diff context when it is available. */
  readonly baseSha?: GitSha;
  readonly isDraft: boolean;
  readonly isOpen: boolean;
};

export type PullRequestSummary = PullRequestSnapshot & {
  readonly ref: PullRequestRef;
  readonly title: string;
  /** Markdown source from GitHub. Renderers must treat it as untrusted text. */
  readonly description?: string;
  readonly author: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly reviewState:
    "none" | "review_pending" | "approved" | "changes_requested" | "unknown";
  readonly mergeability: "mergeable" | "conflicting" | "blocked" | "unknown";
  readonly labels: ReadonlyArray<string>;
  /** GitHub metadata used for dashboard priority; labels are never interpreted as assignment state. */
  readonly requestedReviewers?: ReadonlyArray<string>;
  readonly assignees?: ReadonlyArray<string>;
  readonly updatedAt: IsoTimestamp;
  readonly changedFileCount?: number;
  readonly additions?: number;
  readonly deletions?: number;
};

export type GitHubComments = {
  readonly threads: ReadonlyArray<GitHubConversationThread>;
  /** Omitted only for legacy persisted/test values; adapter reads always set it. */
  readonly complete?: boolean;
  readonly incompleteReason?: "thread_cap" | "comment_cap" | "pagination" | "unavailable";
};
