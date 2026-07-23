import type { GitSha, IsoTimestamp, RepoRelativePath } from "./ids";
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
  readonly id: string;
  readonly state: "open" | "resolved" | "outdated" | "unknown";
  readonly comments: ReadonlyArray<GitHubComment>;
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
};
