import type { ReviewId } from "../domain/ids";
import type { InsightType } from "../domain/insight-record";
import type { PullRequestRef } from "../domain/pull-request";
import type { WatchedPullRequestChange } from "../domain/watched-pull-request";

/** The Review and pull request every desktop notification names. */
type DesktopNotificationSubject = {
  readonly reviewId: ReviewId;
  readonly pullRequest: PullRequestRef;
};

/**
 * Something Patchdesk already knows that the maintainer may want to hear
 * about outside the window (ADR 0044). Each tag has exactly one hook point.
 */
/** How a notification names a local Review (ADR 0052). */
export type LocalReviewNotificationSubject = {
  /** The local Review's source title with its checkout folder, such as "Working tree on feat/x in patchdesk". */
  readonly localTitle: string;
  /** Set when more than one workspace profile is configured (ADR 0052 "Profile switch"). */
  readonly profileLabel?: string;
};

export type DesktopNotificationEvent =
  | ({
      readonly _tag: "InsightSettled";
      readonly reviewId: ReviewId;
      readonly insightType: InsightType;
      readonly outcome: "completed" | "failed";
    } & (
      | { readonly pullRequest: PullRequestRef }
      | (LocalReviewNotificationSubject & {
          /** The run started from an approved agent run request (#496). */
          readonly requestedByAgent: boolean;
        })
    ))
  | (DesktopNotificationSubject & { readonly _tag: "WriteNeedsRecovery" })
  | (DesktopNotificationSubject & { readonly _tag: "PreparationFinished" })
  | (DesktopNotificationSubject & { readonly _tag: "MergeCompleted" })
  | (DesktopNotificationSubject & {
      readonly _tag: "WatchedPullRequestChanged";
      readonly change: WatchedPullRequestChange;
    })
  | (LocalReviewNotificationSubject & {
      readonly _tag: "AgentRunRequested";
      readonly reviewId: ReviewId;
      readonly insightType: InsightType;
    });

/**
 * Posts one desktop notification. Synchronous and total by contract: the
 * implementation owns any asynchronous work and reports its own failures, so
 * a caller never awaits it and never sees it throw.
 */
export type DesktopNotifier = {
  notify(event: DesktopNotificationEvent): void;
};

/**
 * Hands one event to an optional notifier from inside a write or run path,
 * so a notifier defect can never change the `Result` that path returns.
 */
export function postDesktopNotification(
  notifier: DesktopNotifier | undefined,
  event: DesktopNotificationEvent,
): void {
  try {
    notifier?.notify(event);
  } catch {
    // The notifier logs its own failures; a notification never fails the work that raised it.
  }
}
