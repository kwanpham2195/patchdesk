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
  "run_review" | "reconnect" | "start_again" | "try_again" | "prepare_again";

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
  "idle" | "generating" | "ready" | "failed" | "stale";

const WALKTHROUGH_COPY: Readonly<
  Record<
    WalkthroughLifecycleKey,
    { readonly headline: string; readonly reassurance: string }
  >
> = {
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
export function walkthroughCopy(key: WalkthroughLifecycleKey): {
  readonly headline: string;
  readonly reassurance: string;
} {
  return WALKTHROUGH_COPY[key];
}

export type CleanupActionKey = "clear_cache" | "clear_local_review_data";

const CLEANUP_COPY: Readonly<
  Record<
    CleanupActionKey,
    {
      readonly title: string;
      readonly body: string;
      readonly confirmLabel: string;
    }
  >
> = {
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
};

/** Return the friendly cleanup confirmation copy for a stable action key. */
export function cleanupCopy(key: CleanupActionKey): {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
} {
  return CLEANUP_COPY[key];
}

/** Combined list of lifecycle keys exposed for type guards. */
export const WALKTHROUGH_LIFECYCLE_KEYS: ReadonlyArray<WalkthroughLifecycleKey> =
  ["idle", "generating", "ready", "failed", "stale"];

/** Combined list of recovery action keys exposed for type guards. */
export const RECOVERY_ACTION_KEYS: ReadonlyArray<RecoveryActionKey> = [
  "run_review",
  "reconnect",
  "start_again",
  "try_again",
  "prepare_again",
];
