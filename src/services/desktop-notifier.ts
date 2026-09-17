import type { ReviewId } from "../domain/ids";
import type { InsightType } from "../domain/insight-record";
import type { PullRequestRef } from "../domain/pull-request";

/** The Review and pull request every desktop notification names. */
type DesktopNotificationSubject = {
  readonly reviewId: ReviewId;
  readonly pullRequest: PullRequestRef;
};

/**
 * Something Patchdesk already knows that the maintainer may want to hear
 * about outside the window (ADR 0044). Each tag has exactly one hook point.
 */
export type DesktopNotificationEvent =
  | (DesktopNotificationSubject & {
      readonly _tag: "InsightSettled";
      readonly insightType: InsightType;
      readonly outcome: "completed" | "failed";
    })
  | (DesktopNotificationSubject & { readonly _tag: "WriteNeedsRecovery" })
  | (DesktopNotificationSubject & { readonly _tag: "PreparationFinished" })
  | (DesktopNotificationSubject & { readonly _tag: "MergeCompleted" });

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
