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
  /** GitHub's avatar image URL for the comment author; absent for a deleted account. */
  readonly authorAvatarUrl?: string;
  /**
   * `data:` URI resolved from the on-disk avatar cache for `authorAvatarUrl`.
   * Only the Workbench projection populates this (never the storage or
   * GitHub-adapter layers): it is undefined whenever there is no
   * `authorAvatarUrl`, the avatar was never synced, or the sync failed. The
   * renderer's `img-src 'self' data:` CSP cannot load `authorAvatarUrl`
   * directly, so this is the only form an `<img>` may point at.
   */
  readonly authorAvatarDataUri?: string;
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

/** Bounded `pull_request` rule parameters read from the applied branch-rules endpoint. */
export type GitHubAppliedRulesetPullRequestParameters = {
  readonly requiredApprovingReviewCount?: number;
  readonly requireLastPushApproval?: boolean;
  readonly requiredReviewThreadResolution?: boolean;
  readonly dismissStaleReviewsOnPush?: boolean;
  readonly requireCodeOwnerReview?: boolean;
};

/** Bounded rule names/types/parameters returned by the applied branch-rules endpoint. */
export type GitHubAppliedRulesetEvidence = {
  readonly rules: ReadonlyArray<{
    readonly type: string;
    readonly name?: string;
    /** Present only for a `type: "pull_request"` rule with at least one configured field. */
    readonly pullRequestParameters?: GitHubAppliedRulesetPullRequestParameters;
    /** Present only for a `type: "required_status_checks"` rule; the required check contexts. */
    readonly requiredStatusCheckContexts?: ReadonlyArray<string>;
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

/** Derive aggregate merge evidence from a policy read, folding in optional policy evidence when present. */
export function toMergeEvidence(
  policy: MergePolicySnapshot,
  policyEvidence?: GitHubMergePolicyEvidence,
): GitHubMergeEvidence {
  const evidenceBase = {
    mergeable: policy.mergeability,
    mergeStateStatus: policy.mergeStateStatus ?? "unavailable",
    reviewDecision: policy.reviewDecision,
  };
  return policyEvidence === undefined
    ? evidenceBase
    : { ...evidenceBase, policy: policyEvidence };
}

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

/**
 * Whether the authenticated account may manage labels on a repository.
 * `unknown` covers permission evidence that was never fetched or came back
 * unavailable; it must never be treated as either `permitted` or `denied`.
 */
export type RepositoryLabelPermission = "permitted" | "denied" | "unknown";

export type GitHubLabel = {
  readonly name: string;
  /** GitHub's hex color, six characters, no leading `#`. */
  readonly color: string;
};

/** A label available in a repository, for populating a label picker. */
export type RepositoryLabel = GitHubLabel & {
  /** GitHub GraphQL node ID, e.g. for the future `addLabelsToLabelable` mutation. */
  readonly id: string;
  /**
   * `| undefined` (not just `?:`) so this structurally accepts the renderer
   * contract's parsed wire shape directly under `exactOptionalPropertyTypes`
   * — see `contracts.ts`'s optional fields for the same reasoning. Producers
   * still omit the key entirely rather than setting it to `undefined`
   * (`parseRepositoryLabel` in `github-wire-projections.ts`).
   */
  readonly description?: string | undefined;
};

export type RepositoryLabelListing = {
  readonly labels: ReadonlyArray<RepositoryLabel>;
  /** GitHub's exact total label count; compare against `labels.length` to detect truncation, mirroring `PullRequestSummary.labelCount`. */
  readonly totalCount: number;
};

/** A repository collaborator eligible to be assigned to a pull request, for populating an assignee picker. */
export type AssignableUser = {
  /** GraphQL node ID — required by `addAssigneesToAssignable`/`removeAssigneesFromAssignable`; the logins already on `PullRequestSummary.assignees` are not sufficient. */
  readonly id: string;
  readonly login: string;
  readonly name?: string;
  readonly avatarUrl?: string;
  /**
   * `data:` URI resolved from the on-disk avatar cache for `avatarUrl`.
   * Only `AssigneeService.list`/`ReviewerService.list` populate this (never
   * the storage or GitHub-adapter layers), mirroring `GitHubComment
   * .authorAvatarDataUri` — it is undefined whenever there is no
   * `avatarUrl`, the avatar was never synced, or the sync failed. The
   * renderer's `img-src 'self' data:` CSP cannot load `avatarUrl` directly,
   * so this is the only form an `<img>` may point at.
   */
  readonly avatarDataUri?: string;
};

export type AssignableUserListing = {
  readonly users: ReadonlyArray<AssignableUser>;
  /** GitHub's exact total; compare against `users.length` to detect truncation, mirroring `RepositoryLabelListing.totalCount`. */
  readonly totalCount: number;
};

/**
 * Whether the authenticated account may assign people to, or request/remove
 * reviewers on, this pull request. Both writes need the same GitHub
 * capability (pull-request write), unlike labeling, which `triage` can also
 * do — see ADR "The conversation rail owns pull request metadata writes" —
 * so this one type now serves both `AssigneeService` and `ReviewerService`,
 * not only assignees; the underlying adapter function that produces it is
 * named for the shared capability (`pullRequestWritePermission` in
 * `github-adapter.ts`). The type itself keeps its original name here: it is
 * also imported directly by renderer components outside this change's
 * scope, and a rename would break those imports without fixing anything a
 * reader could not already infer from this comment. A plain alias, not a
 * duplicated union — the state names and fail-closed semantics are
 * identical to `RepositoryLabelPermission`.
 */
export type PullRequestAssigneePermission = RepositoryLabelPermission;

/**
 * One of the states GitHub reports for a pull request review. `PENDING` is
 * an unfinished draft — see ADR "Use GitHub pending reviews for Review
 * drafting" (0014) — and is dropped before a Revision-bound review verdict
 * is derived; see `deriveReviewVerdicts` in `src/domain/review-verdicts.ts`.
 */
export type GitHubReviewState =
  | "PENDING"
  | "COMMENTED"
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "DISMISSED";

/**
 * One GitHub-reported review event for one pull request, submitted or still
 * open. Read from both `latestReviews` and `reviews` — see
 * `PullRequestReviewerListing` — and unioned by `deriveReviewVerdicts`.
 */
export type PullRequestReviewEntry = {
  readonly login: string;
  readonly avatarUrl?: string;
  readonly state: GitHubReviewState;
  /** Absent for a still-open `PENDING` review; present for every submitted state. */
  readonly submittedAt?: IsoTimestamp;
  /** The commit this review was submitted against. Absent when GitHub could not report one (e.g. a still-pending review, or a rare data anomaly); an absent oid is treated as outdated, never assumed current — see `deriveReviewVerdicts`. */
  readonly commitOid?: GitSha;
};

/** A person GitHub has requested review from, whether or not they have submitted anything yet. */
export type RequestedReviewer = {
  readonly login: string;
  readonly name?: string;
  readonly avatarUrl?: string;
  /** `data:` URI resolved from the on-disk avatar cache for `avatarUrl`; see `AssignableUser.avatarDataUri` for the full contract. Only populated on `ReviewerService.list`'s output (`suggested[].reviewer`), never on the raw GitHub-adapter read this type also serves. */
  readonly avatarDataUri?: string;
};

/**
 * One of GitHub's own suggested reviewers for the pull request (recent
 * committers and commenters on the changed files). GitHub's schema carries
 * no human-readable reason string for a suggestion — `isAuthor`/`isCommenter`
 * are the only signal; any explanatory copy is Patchdesk's own.
 */
export type SuggestedPullRequestReviewer = {
  readonly isAuthor: boolean;
  readonly isCommenter: boolean;
  readonly reviewer: RequestedReviewer;
};

/**
 * Everything read in one bounded, unpaginated request for populating the
 * reviewer rail: who is requested, every submitted-or-pending review from
 * both of GitHub's overlapping views, and GitHub's own suggestions. See
 * `pullRequestReviewersQuery` in `github-graphql-queries.ts`.
 */
export type PullRequestReviewerListing = {
  readonly requested: ReadonlyArray<RequestedReviewer>;
  readonly latestReviews: ReadonlyArray<PullRequestReviewEntry>;
  readonly reviews: ReadonlyArray<PullRequestReviewEntry>;
  readonly suggested: ReadonlyArray<SuggestedPullRequestReviewer>;
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

/** One pull request plus the check summary returned by a bounded inbox GraphQL page. */
export type MaintainerPullRequest = {
  readonly summary: PullRequestSummary;
  readonly checks: CheckSummary;
};

/** One repository page preserves every GitHub edge cursor needed for global inbox pagination. */
export type MaintainerPullRequestPage = {
  readonly entries: ReadonlyArray<{
    readonly cursor: string;
    readonly pullRequest: MaintainerPullRequest;
  }>;
  readonly hasNextPage: boolean;
  /** The next GraphQL connection cursor when a non-final page contains no edges. */
  readonly endCursor?: string;
};

/** One repository-wide `search(type: ISSUE)` page: everything `MaintainerPullRequestPage` carries, plus `issueCount`, GitHub's true repository-wide match count rather than the loaded page's entry count. */
export type MaintainerPullRequestSearchPage = MaintainerPullRequestPage & {
  readonly issueCount: number;
};
