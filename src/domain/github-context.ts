import type { GitSha, IsoTimestamp, RepoRelativePath } from "./ids";

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
  readonly conclusion?: "success" | "failure" | "cancelled" | "timed_out" | "skipped" | "neutral";
  readonly url?: string;
};

export type CheckSummary = {
  readonly overall: "passing" | "failing" | "pending" | "skipped" | "unknown";
  readonly checks: ReadonlyArray<CheckRunSummary>;
};

export type PullRequestSnapshot = {
  readonly headSha: GitSha;
  readonly isDraft: boolean;
  readonly isOpen: boolean;
};
