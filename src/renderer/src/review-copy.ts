/**
 * Shared renderer copy map for recovery, cleanup, and walkthrough surfaces.
 *
 * The Design app and the production renderer both render from these keys.
 * Persisted action labels and internal state names never reach the UI; this
 * module maps stable action and notice keys to friendly copy that satisfies
 * the plan's "no storage, quarantine, session, attempt, worktree, runtime, or
 * raw error terms" rule.
 */

export type RecoveryTone = "neutral" | "positive" | "warning" | "destructive";

export type RecoveryActionKey =
  | "run_review"
  | "reconnect"
  | "start_again"
  | "try_again"
  | "prepare_again";

export type RecoveryNoticeKey =
  | "preparing"
  | "ready_to_review"
  | "review_in_progress"
  | "review_interrupted"
  | "review_failed"
  | "needs_preparation";

export type RecoveryCopy = {
  readonly notice: string;
  readonly tone: RecoveryTone;
  readonly actionLabel?: string;
  readonly actionKey?: RecoveryActionKey;
  readonly reassurance: string;
};

const RECOVERY_COPY: Readonly<Record<RecoveryNoticeKey, RecoveryCopy>> = {
  preparing: {
    notice: "Preparing review",
    tone: "neutral",
    reassurance:
      "Patchdesk is preparing this pull request. You can wait or come back to this view later.",
  },
  ready_to_review: {
    notice: "Ready to review",
    tone: "positive",
    actionLabel: "Run Analysis",
    actionKey: "run_review",
    reassurance:
      "The saved snapshot is ready. Starting analysis is read-only and never writes to GitHub.",
  },
  review_in_progress: {
    notice: "Review in progress",
    tone: "positive",
    actionLabel: "Reconnect",
    actionKey: "reconnect",
    reassurance:
      "Reconnect to follow the run in this window without restarting analysis.",
  },
  review_interrupted: {
    notice: "Review was interrupted",
    tone: "warning",
    actionLabel: "Start again",
    actionKey: "start_again",
    reassurance:
      "The previous run did not finish on this Mac. Restart it with the exact same snapshot.",
  },
  review_failed: {
    notice: "Review couldn't finish",
    tone: "warning",
    actionLabel: "Try again",
    actionKey: "try_again",
    reassurance:
      "Patchdesk stopped the last run before it completed. Try again when you're ready.",
  },
  needs_preparation: {
    notice: "Review needs preparation",
    tone: "warning",
    actionLabel: "Prepare again",
    actionKey: "prepare_again",
    reassurance:
      "This pull request's local copy is not ready. Prepare it again without blocking other reviews.",
  },
};

/** Return the display-safe copy for a stable recovery notice key. */
export function recoveryCopy(key: RecoveryNoticeKey): RecoveryCopy {
  return RECOVERY_COPY[key];
}

/** Return copy for an action key when the UI only knows the next action. */
export function recoveryActionLabel(key: RecoveryActionKey): string {
  const entry = Object.values(RECOVERY_COPY).find((copy) => copy.actionKey === key);
  if (entry?.actionLabel !== undefined) return entry.actionLabel;
  switch (key) {
    case "run_review": return "Run review";
    case "reconnect": return "Reconnect";
    case "start_again": return "Start again";
    case "try_again": return "Try again";
    case "prepare_again": return "Prepare again";
  }
}

export type WalkthroughLifecycleKey =
  | "idle"
  | "generating"
  | "ready"
  | "failed"
  | "stale";

const WALKTHROUGH_COPY: Readonly<Record<WalkthroughLifecycleKey, { readonly headline: string; readonly reassurance: string }>> = {
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
};

/** Return the friendly walkthrough copy for a stable lifecycle key. */
export function walkthroughCopy(key: WalkthroughLifecycleKey): { readonly headline: string; readonly reassurance: string } {
  return WALKTHROUGH_COPY[key];
}

export type CleanupActionKey = "clear_cache" | "clear_local_review_data";

const CLEANUP_COPY: Readonly<
  Record<CleanupActionKey, { readonly title: string; readonly body: string; readonly confirmLabel: string }>
> = {
  clear_cache: {
    title: "Clear cache?",
    body:
      "This removes rebuildable local files. Your saved reviews and diagnostic reports stay.",
    confirmLabel: "Clear cache",
  },
  clear_local_review_data: {
    title: "Clear local review data?",
    body:
      "This removes completed and failed local reviews. An active review and diagnostic reports stay.",
    confirmLabel: "Clear local data",
  },
};

/** Return the friendly cleanup confirmation copy for a stable action key. */
export function cleanupCopy(key: CleanupActionKey): { readonly title: string; readonly body: string; readonly confirmLabel: string } {
  return CLEANUP_COPY[key];
}

/** Combined list of lifecycle keys exposed for type guards. */
export const WALKTHROUGH_LIFECYCLE_KEYS: ReadonlyArray<WalkthroughLifecycleKey> = [
  "idle",
  "generating",
  "ready",
  "failed",
  "stale",
];

/** Combined list of recovery notice keys exposed for type guards. */
export const RECOVERY_NOTICE_KEYS: ReadonlyArray<RecoveryNoticeKey> = [
  "preparing",
  "ready_to_review",
  "review_in_progress",
  "review_interrupted",
  "review_failed",
  "needs_preparation",
];

/** Combined list of recovery action keys exposed for type guards. */
export const RECOVERY_ACTION_KEYS: ReadonlyArray<RecoveryActionKey> = [
  "run_review",
  "reconnect",
  "start_again",
  "try_again",
  "prepare_again",
];
