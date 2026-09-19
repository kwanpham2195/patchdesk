import type { ContextualMessages } from "./api-client";

/**
 * Shared renderer copy map for recovery, cleanup, and walkthrough surfaces.
 *
 * The Design app and the production renderer both render from these keys.
 * Persisted action labels and internal state names never reach the UI; this
 * module maps stable action and notice keys to friendly copy that satisfies
 * the plan's "no storage, quarantine, session, attempt, worktree, runtime, or
 * raw error terms" rule.
 */

export type WalkthroughLifecycleKey =
  | "idle"
  | "generating"
  | "ready"
  | "failed"
  | "stale";

/** The two strings every walkthrough lifecycle state shows. */
type WalkthroughCopy = {
  readonly headline: string;
  readonly reassurance: string;
};

const WALKTHROUGH_COPY = {
  idle: {
    headline: "Generate Walkthrough",
    reassurance:
      "Patchdesk reads the stored patch, never writes to GitHub, and never restarts the run.",
  },
  generating: {
    headline: "Generating walkthrough…",
    reassurance:
      "Patchdesk is reading the stored patch. This view will keep its place.",
  },
  ready: {
    headline: "Walkthrough ready",
    reassurance:
      "Each section maps to one part of the patch. Use Back to files when you're done.",
  },
  failed: {
    headline: "Walkthrough didn't finish",
    reassurance:
      "The patch is still readable in Files mode. Try again or stay with the Review.",
  },
  stale: {
    headline: "Walkthrough is no longer current",
    reassurance:
      "The stored patch changed. Generate a new walkthrough for the current snapshot.",
  },
} satisfies Record<WalkthroughLifecycleKey, WalkthroughCopy>;

/** Return the friendly walkthrough copy for a stable lifecycle key. */
export function walkthroughCopy(key: WalkthroughLifecycleKey): WalkthroughCopy {
  return WALKTHROUGH_COPY[key];
}

export type CleanupActionKey = "clear_cache" | "clear_local_review_data";

/** The three strings every cleanup confirmation shows. */
type CleanupCopy = {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
};

const CLEANUP_COPY = {
  clear_cache: {
    title: "Clear cache?",
    body: "This removes rebuildable local files. Your saved reviews and diagnostic reports stay.",
    confirmLabel: "Clear cache",
  },
  clear_local_review_data: {
    title: "Clear local review data?",
    body: "This removes completed and failed local reviews. An active review and diagnostic reports stay.",
    confirmLabel: "Clear local data",
  },
} satisfies Record<CleanupActionKey, CleanupCopy>;

/** Return the friendly cleanup confirmation copy for a stable action key. */
export function cleanupCopy(key: CleanupActionKey): CleanupCopy {
  return CLEANUP_COPY[key];
}

// The review-write failure copy. Each table names only the failure kinds its
// screen words better than the API does; `contextualMessage` falls back to
// the API's own bounded copy for every other kind, and to `fallback` for a
// cause that is not an API failure at all.

/**
 * What a review write says when GitHub never confirmed it. Both write
 * surfaces show this same sentence for the same three failure kinds
 * (`isOutcomeUnknownRetry` in `api-client.ts`), because the situation and the
 * next step are the same on both: the write may or may not have landed, so
 * check GitHub rather than submitting again.
 */
const UNCONFIRMED_SUBMISSION =
  "GitHub could not confirm the submission. Check GitHub again before trying again.";

/**
 * What both write surfaces say when GitHub already holds an unfinished
 * pending review. Only one review can be in flight per pull request, so the
 * instruction is the same wherever the collision is reported.
 */
const PENDING_REVIEW_EXISTS =
  "A pending review already exists. Refresh, then finish or discard that review before submitting a summary.";

const PENDING_REVIEW_CHANGED =
  "The pending review changed. Check GitHub again or refresh.";

const CHECK_GITHUB_UNAVAILABLE =
  "Patchdesk could not check GitHub right now. Try again.";

/**
 * What both write surfaces say when the request itself was refused before
 * GitHub was asked. `safeMessage` names the problem accurately but stops
 * there; on a surface where the user has just pressed Submit, the next step
 * is the point, so each write surface keeps its own.
 */
const INVALID_WRITE_REQUEST =
  "The request contains invalid information. Check GitHub again or refresh.";

/** The same, for a service that answered nothing usable at all. */
const WRITE_SERVICE_UNAVAILABLE =
  "The requested service is currently unavailable. Check GitHub again or refresh.";

/** Submitting or discarding a pending review from the Finish review dialog. */
export const FINISH_REVIEW_MESSAGES: ContextualMessages = {
  fallback:
    "Patchdesk could not finish this review. Check GitHub again or refresh.",
  invalid_input: INVALID_WRITE_REQUEST,
  unavailable: WRITE_SERVICE_UNAVAILABLE,
  outcome_unknown: UNCONFIRMED_SUBMISSION,
  ambiguous_write: UNCONFIRMED_SUBMISSION,
  timeout: UNCONFIRMED_SUBMISSION,
  pending_review: PENDING_REVIEW_EXISTS,
  stale_head: "The pull request changed. Refresh, then finish the review.",
  github_rejected:
    "The submission was refused. Refresh to see this review's current state, then finish it again.",
  no_pending_review: PENDING_REVIEW_CHANGED,
  pending_review_locked: PENDING_REVIEW_CHANGED,
  forbidden:
    "GitHub blocked this submission: the repository or organization restricts access here. Retrying will not help — check GitHub's access settings for this organization.",
};

/**
 * The "Check GitHub again" recovery beside an unconfirmed pending review.
 *
 * `github_rejected` names one exact local cause here rather than the generic
 * refusal `safeMessage` falls back to. The
 * button calls `POST /v1/reviews/pending-review/recover`, whose only failure
 * is `mapGateFailure` in `pending-review-service.ts`; the single reason it
 * turns into `permission_denied` (409, and so into this kind) is the write
 * gate's own `requireCurrentSession` answering `terminal` or `stale`. That
 * gate reads local stores only — the Review is closed, or the stored session
 * no longer represents it — so GitHub is never asked, and refreshing is what
 * clears it.
 */
export const PENDING_REVIEW_RECOVERY_MESSAGES: ContextualMessages = {
  fallback:
    "Patchdesk could not reconcile this pending review. Try again or refresh.",
  review_write_in_progress:
    "Another action is still finishing. Wait a moment, then check GitHub again.",
  timeout: CHECK_GITHUB_UNAVAILABLE,
  unavailable: CHECK_GITHUB_UNAVAILABLE,
  outcome_unknown: CHECK_GITHUB_UNAVAILABLE,
  github_rejected:
    "Patchdesk did not check GitHub: this review is closed, or Patchdesk's copy of it is out of date. Refresh, then check again.",
  invalid_input:
    "Patchdesk could not check this pending review. Try again or refresh.",
  storage:
    "Patchdesk could not read this review's local data. Try again or refresh.",
};

/** Submitting or recovering a direct review summary. */
export const DIRECT_SUMMARY_MESSAGES: ContextualMessages = {
  fallback:
    "Patchdesk could not submit this review summary. Check GitHub again or refresh.",
  invalid_input: INVALID_WRITE_REQUEST,
  unavailable: WRITE_SERVICE_UNAVAILABLE,
  outcome_unknown: UNCONFIRMED_SUBMISSION,
  ambiguous_write: UNCONFIRMED_SUBMISSION,
  timeout: UNCONFIRMED_SUBMISSION,
  pending_review: PENDING_REVIEW_EXISTS,
  stale_head:
    "The pull request changed. Refresh before submitting a review summary.",
  github_rejected:
    "The review summary was refused. Refresh to see this review's current state, then submit it again.",
  forbidden:
    "GitHub blocked this review summary: the repository or organization restricts access here. Retrying will not help — check GitHub's access settings for this organization.",
};

// Conversation and Finding write failures. The unconfirmed-write sentences
// never say "try again": GitHub may already have applied the write.

const UNCONFIRMED_COMMENT_EDIT =
  "GitHub could not confirm the edit. Check GitHub again before editing again.";

/** Saving an edit to a published comment from its row controls. */
export const COMMENT_EDIT_MESSAGES: ContextualMessages = {
  fallback: "Patchdesk could not edit this comment.",
  outcome_unknown: UNCONFIRMED_COMMENT_EDIT,
  ambiguous_write: UNCONFIRMED_COMMENT_EDIT,
  timeout: UNCONFIRMED_COMMENT_EDIT,
  rate_limited:
    "GitHub rate-limited this edit. Wait a moment, then save again.",
  forbidden:
    "GitHub blocked this edit: the repository or organization restricts access here. Retrying will not help — check GitHub's access settings for this organization.",
};

const UNCONFIRMED_COMMENT_DELETE =
  "GitHub could not confirm the deletion. Check GitHub again before deleting again.";

/** Deleting a published comment from its row controls. */
export const COMMENT_DELETE_MESSAGES: ContextualMessages = {
  fallback: "Patchdesk could not delete this comment.",
  outcome_unknown: UNCONFIRMED_COMMENT_DELETE,
  ambiguous_write: UNCONFIRMED_COMMENT_DELETE,
  timeout: UNCONFIRMED_COMMENT_DELETE,
  rate_limited:
    "GitHub rate-limited this deletion. Wait a moment, then delete again.",
  forbidden:
    "GitHub blocked this deletion: the repository or organization restricts access here. Retrying will not help — check GitHub's access settings for this organization.",
};

const UNCONFIRMED_THREAD_REPLY =
  "GitHub could not confirm the reply. Check GitHub again before replying again.";

/** Publishing a reply from a conversation thread card. */
export const THREAD_REPLY_MESSAGES: ContextualMessages = {
  fallback: "Patchdesk could not publish this reply.",
  outcome_unknown: UNCONFIRMED_THREAD_REPLY,
  ambiguous_write: UNCONFIRMED_THREAD_REPLY,
  timeout: UNCONFIRMED_THREAD_REPLY,
  rate_limited:
    "GitHub rate-limited this reply. Wait a moment, then reply again.",
  forbidden:
    "GitHub blocked this reply: the repository or organization restricts access here. Retrying will not help — check GitHub's access settings for this organization.",
};

const UNCONFIRMED_DRAFT_STATE =
  "GitHub could not confirm the draft change. Check GitHub again before changing it again.";

/** The author's draft toggle in the PR overview sheet. */
export const DRAFT_STATE_MESSAGES: ContextualMessages = {
  fallback: "Patchdesk could not change this pull request's draft state.",
  outcome_unknown: UNCONFIRMED_DRAFT_STATE,
  ambiguous_write: UNCONFIRMED_DRAFT_STATE,
  timeout: UNCONFIRMED_DRAFT_STATE,
  github_rejected:
    "The draft change was refused. Refresh to see this pull request's current state, then try again.",
  rate_limited:
    "GitHub rate-limited this draft change. Wait a moment, then try again.",
  forbidden:
    "GitHub blocked this draft change: the repository or organization restricts access here. Retrying will not help — check GitHub's access settings for this organization.",
};

const UNCONFIRMED_BASE_BRANCH =
  "GitHub could not confirm the base branch change. Check GitHub again before changing it again.";

/** The base-branch change in the PR overview sheet. */
export const BASE_BRANCH_MESSAGES: ContextualMessages = {
  fallback: "Patchdesk could not change this pull request's base branch.",
  outcome_unknown: UNCONFIRMED_BASE_BRANCH,
  ambiguous_write: UNCONFIRMED_BASE_BRANCH,
  timeout: UNCONFIRMED_BASE_BRANCH,
  invalid_input:
    "This pull request already targets that branch, or the branch name is not valid.",
  github_rejected:
    "The base branch change was refused: this account may lack write access to this repository.",
  rate_limited:
    "GitHub rate-limited this base branch change. Wait a moment, then try again.",
  forbidden:
    "GitHub blocked this base branch change: the repository or organization restricts access here. Retrying will not help — check GitHub's access settings for this organization.",
};

const UNCONFIRMED_REVIEW_REQUEST =
  "GitHub could not confirm the review request. Check GitHub again before requesting it again.";

/** Re-requesting a review from the metadata rail's Reviewers section. */
export const RE_REQUEST_REVIEW_MESSAGES: ContextualMessages = {
  fallback: "Patchdesk could not request this review again.",
  outcome_unknown: UNCONFIRMED_REVIEW_REQUEST,
  ambiguous_write: UNCONFIRMED_REVIEW_REQUEST,
  timeout: UNCONFIRMED_REVIEW_REQUEST,
  github_rejected:
    "The review request was refused. Refresh to see the current reviewers, then try again.",
  rate_limited:
    "GitHub rate-limited this review request. Wait a moment, then try again.",
  forbidden:
    "GitHub blocked this review request: the repository or organization restricts access here. Retrying will not help — check GitHub's access settings for this organization.",
};

const UNCONFIRMED_FINDING_ACTION =
  "GitHub could not confirm the Finding action. Check GitHub again before repeating it.";

/** Adding a Finding to the review, or dismissing it, from the Analysis reader. */
export const FINDING_ACTION_MESSAGES: ContextualMessages = {
  fallback: "The Finding action could not be saved. Try again.",
  outcome_unknown: UNCONFIRMED_FINDING_ACTION,
  ambiguous_write: UNCONFIRMED_FINDING_ACTION,
  timeout: UNCONFIRMED_FINDING_ACTION,
  rate_limited:
    "GitHub rate-limited this Finding action. Wait a moment, then try again.",
  forbidden:
    "GitHub blocked this Finding action: the repository or organization restricts access here. Retrying will not help — check GitHub's access settings for this organization.",
};
