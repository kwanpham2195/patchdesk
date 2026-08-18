import type {
  GitHubThreadId,
  GitSha,
  IsoTimestamp,
  RepoRelativePath,
} from "./ids";
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
  /** GitHub identifies this comment as authored by the authenticated viewer. */
  readonly viewerDidAuthor?: boolean;
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
    | "success"
    | "failure"
    | "cancelled"
    | "timed_out"
    | "skipped"
    | "neutral";
  readonly url?: string;
};

export type CheckSummary = {
  readonly overall: "passing" | "failing" | "pending" | "skipped" | "unknown";
  readonly checks: ReadonlyArray<CheckRunSummary>;
};

export type GitHubMergeStateStatus =
  | "blocked"
  | "behind"
  | "dirty"
  | "draft"
  | "has_hooks"
  | "unstable"
  | "clean"
  | "unknown"
  /** GitHub did not provide this field in the response. */
  | "unavailable";

/** Aggregate merge evidence reported by GitHub for a pull request. */
export type GitHubMergeEvidence = {
  readonly mergeable: "mergeable" | "conflicting" | "blocked" | "unknown";
  readonly mergeStateStatus: GitHubMergeStateStatus;
  readonly reviewDecision:
    | "approved"
    | "changes_requested"
    | "review_required"
    | "unknown";
  /** Optional policy configuration; absence is not a merge authorization signal. */
  readonly policy?: GitHubMergePolicyEvidence;
};

export type MergeDisplayReason = {
  readonly code:
    | "review_required"
    | "changes_requested"
    | "behind"
    | "conflicts"
    | "checks"
    | "blocked";
  readonly message: string;
  readonly source:
    | "github_pr_state"
    | "branch_protection"
    | "ruleset_configuration"
    | "checks";
  readonly availability: "available" | "partial" | "unavailable";
  readonly openOnGitHub: boolean;
};

/** Why an optional policy endpoint did not disclose configuration. */
export type GitHubOptionalEvidenceUnavailable = {
  readonly state: "unavailable";
  readonly reason: "forbidden" | "not_found" | "unsupported";
};

/** Bounded review-policy fields from classic branch protection. */
export type GitHubClassicBranchProtectionEvidence = {
  readonly requiredApprovingReviewCount?: number;
  readonly dismissStaleReviews?: boolean;
  readonly requireCodeOwnerReviews?: boolean;
};

/** Bounded rule names/types returned by the applied branch-rules endpoint. */
export type GitHubAppliedRulesetEvidence = {
  readonly rules: ReadonlyArray<{
    readonly type: string;
    readonly name?: string;
  }>;
};

export type GitHubMergePolicyEvidence = {
  readonly branchProtection:
    | {
        readonly state: "available";
        readonly value: GitHubClassicBranchProtectionEvidence;
      }
    | GitHubOptionalEvidenceUnavailable;
  readonly appliedRuleset:
    | {
        readonly state: "available";
        readonly value: GitHubAppliedRulesetEvidence;
      }
    | GitHubOptionalEvidenceUnavailable;
};

/** Fresh, exact-head policy evidence required before Patchdesk may request a merge. */
export type MergePolicySnapshot = {
  readonly pr: PullRequestRef;
  readonly headSha: GitSha;
  /** Exact base SHA for final merge identity proof; production adapter reads always include it. */
  readonly baseSha?: GitSha;
  readonly isOpen: boolean;
  readonly isDraft: boolean;
  readonly mergeability: "mergeable" | "conflicting" | "blocked" | "unknown";
  /** Optional for bounded readers that cannot provide aggregate merge state. */
  readonly mergeStateStatus?: GitHubMergeStateStatus;
  readonly reviewDecision:
    | "approved"
    | "changes_requested"
    | "review_required"
    | "unknown";
  readonly checks: CheckSummary;
  readonly complete: boolean;
  readonly incompleteReason?:
    | "head_mismatch"
    | "pagination"
    | "permission"
    | "unavailable"
    | "mapping";
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
  readonly nodeId?: string;
  readonly author: string;
  readonly body: string;
  readonly event: "APPROVED" | "COMMENTED" | "CHANGES_REQUESTED" | "DISMISSED";
  readonly submittedAt: IsoTimestamp;
  readonly canDismiss: boolean;
};

/** One entry in the Conversation timeline, in chronological order. */
export type ConversationEntry =
  | { readonly _tag: "PrDescription"; readonly body: string }
  | {
      readonly _tag: "IssueComment";
      readonly comment: ConversationIssueComment;
    }
  | { readonly _tag: "ReviewSummary"; readonly review: PublishedReview }
  | {
      readonly _tag: "GeneralThread";
      readonly thread: GitHubConversationThread;
    };

/** Timeline issue comment; review-attached comments also expose their review, node, and editability. */
export type ConversationIssueComment = GitHubComment & {
  readonly reviewId?: string;
  readonly nodeId?: string;
  readonly canEdit?: boolean;
  readonly canDelete?: boolean;
};

/** Unified Conversation payload replacing separate review-feedback and thread queries. */
export type Conversation = {
  readonly prDescription: string;
  readonly entries: ReadonlyArray<ConversationEntry>;
  /** Inline threads remain out of the timeline and are rendered in the Diff. */
  readonly inline?: GitHubComments;
  readonly complete?: boolean;
  readonly incompleteReason?:
    | "thread_cap"
    | "comment_cap"
    | "pagination"
    | "unavailable";
};

/** Published inline feedback returned by GitHub for explicit edit and delete actions. */
export type PublishedReviewComment = GitHubComment & {
  readonly reviewId?: string;
  readonly nodeId?: string;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
};

export type GitHubPublishedFeedback = {
  readonly reviews: ReadonlyArray<PublishedReview>;
  readonly comments: ReadonlyArray<PublishedReviewComment>;
  readonly complete?: boolean;
  readonly incompleteReason?: "pagination" | "unavailable";
};

/** Internal adapter type: review-comment threads loaded from GraphQL. */
export type GitHubComments = {
  readonly threads: ReadonlyArray<GitHubConversationThread>;
  readonly complete?: boolean;
  readonly incompleteReason?:
    | "thread_cap"
    | "comment_cap"
    | "pagination"
    | "unavailable";
};
export type PullRequestSnapshot = {
  readonly headSha: GitSha;
  /** Exact base SHA used to hydrate omitted diff context when it is available. */
  readonly baseSha?: GitSha;
  readonly isDraft: boolean;
  readonly isOpen: boolean;
};

export type GitHubLabel = {
  readonly name: string;
  /** GitHub's hex color, six characters, no leading `#`. */
  readonly color: string;
};

/** A label available in a repository, for populating a label picker. */
export type RepositoryLabel = GitHubLabel & {
  /** GitHub GraphQL node ID, e.g. for the future `addLabelsToLabelable` mutation. */
  readonly id: string;
};

export type RepositoryLabelListing = {
  readonly labels: ReadonlyArray<RepositoryLabel>;
  /** GitHub's exact total label count; compare against `labels.length` to detect truncation, mirroring `PullRequestSummary.labelCount`. */
  readonly totalCount: number;
};

export type PullRequestSummary = PullRequestSnapshot & {
  readonly ref: PullRequestRef;
  readonly title: string;
  /** GitHub GraphQL node ID (REST's `node_id`), e.g. for `labelableId` in label mutations. */
  readonly nodeId?: string;
  /** Markdown source from GitHub. Renderers must treat it as untrusted text. */
  readonly description?: string;
  readonly author: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly reviewState:
    | "none"
    | "review_pending"
    | "approved"
    | "changes_requested"
    | "unknown";
  readonly mergeability: "mergeable" | "conflicting" | "blocked" | "unknown";
  readonly labels: ReadonlyArray<GitHubLabel>;
  /** Total labels on the pull request when the read source reports it; undefined when not applicable (e.g. the REST reader, which never truncates). Compare against `labels.length` to detect truncation. */
  readonly labelCount?: number;
  /** GitHub metadata used for dashboard priority; labels are never interpreted as assignment state. */
  readonly requestedReviewers?: ReadonlyArray<string>;
  readonly assignees?: ReadonlyArray<string>;
  readonly updatedAt: IsoTimestamp;
  readonly changedFileCount?: number;
  readonly additions?: number;
  readonly deletions?: number;
};
