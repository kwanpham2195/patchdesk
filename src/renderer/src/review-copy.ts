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

export type RecoveryActionKey =
  | "run_review"
  | "reconnect"
  | "start_again"
  | "try_again"
  | "prepare_again";

/** Return copy for an action key when the UI only knows the next action. */
export function recoveryActionLabel(key: RecoveryActionKey): string {
  switch (key) {
    case "run_review":
      return "Run Analysis";
    case "reconnect":
      return "Reconnect";
    case "start_again":
      return "Start again";
    case "try_again":
      return "Try again";
    case "prepare_again":
      return "Prepare again";
  }
}

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

/** Combined list of recovery action keys exposed for type guards. */
export const RECOVERY_ACTION_KEYS: ReadonlyArray<RecoveryActionKey> = [
  "run_review",
  "reconnect",
  "start_again",
  "try_again",
  "prepare_again",
];

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
  rejected: "GitHub rejected the submission.",
  github_rejected: "GitHub rejected the submission.",
  no_pending_review: PENDING_REVIEW_CHANGED,
  pending_review_locked: PENDING_REVIEW_CHANGED,
  forbidden:
    "GitHub blocked this submission: the repository or organization restricts access here. Retrying will not help — check GitHub's access settings for this organization.",
};

/**
 * The "Check GitHub again" recovery beside an unconfirmed pending review.
 *
 * `github_rejected` is the one kind here that GitHub does not produce. The
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
  rejected: "GitHub rejected the review summary.",
  github_rejected: "GitHub rejected the review summary.",
  forbidden:
    "GitHub blocked this review summary: the repository or organization restricts access here. Retrying will not help — check GitHub's access settings for this organization.",
};
