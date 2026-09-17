import type { ReviewId } from "../domain/ids";
import type { LogEntryInput } from "../domain/log-entry";
import { loggableMetaValue } from "../domain/log-entry";
import { casesHandled } from "../domain/result";
import type {
  DesktopNotificationEvent,
  DesktopNotifier,
} from "../services/desktop-notifier";
import type { DesktopNotificationClick } from "./ipc-contract";

/** Electron's `Notification`, structurally, so the notifier runs under Vitest. */
type ShownNotification = {
  on(event: "click" | "close", listener: () => void): void;
  show(): void;
};

/** What a notification says; never pull request text beyond its reference. */
type DesktopNotificationText = {
  readonly title: string;
  readonly body: string;
};

/** The screen the renderer last reported, with its Review id already parsed. */
export type NotificationDestination =
  | { readonly kind: "dashboard" }
  | { readonly kind: "workbench"; readonly reviewId: ReviewId };

type DesktopNotificationDecision =
  | { readonly _tag: "show" }
  | { readonly _tag: "skip"; readonly reason: "focused_on_review" };

/**
 * The one silence rule (ADR 0044): an event about the Review the focused
 * window is showing needs no notification. Anything else is shown.
 */
export function decideDesktopNotification(input: {
  readonly focused: boolean;
  readonly destination: NotificationDestination;
  readonly event: DesktopNotificationEvent;
}): DesktopNotificationDecision {
  return input.focused &&
    input.destination.kind === "workbench" &&
    input.destination.reviewId === input.event.reviewId
    ? { _tag: "skip", reason: "focused_on_review" }
    : { _tag: "show" };
}

type DesktopNotifierDependencies = {
  readonly windowFocused: () => boolean;
  readonly destination: () => NotificationDestination;
  readonly createNotification: (
    options: DesktopNotificationText,
  ) => ShownNotification;
  readonly onClick: (click: DesktopNotificationClick) => void;
  readonly logs: { write(input: LogEntryInput): void };
};

/**
 * The main-process `DesktopNotifier` (ADR 0044). Titles and bodies name the
 * pull request by reference only, and the log lines carry the event tag and
 * Review id, so no pull request text leaves GitHub's own surfaces.
 */
export function createDesktopNotifier(
  dependencies: DesktopNotifierDependencies,
): DesktopNotifier {
  // Electron drops a notification's click listener once the object is collected.
  const live = new Set<ShownNotification>();
  return {
    notify(event) {
      try {
        const decision = decideDesktopNotification({
          focused: dependencies.windowFocused(),
          destination: dependencies.destination(),
          event,
        });
        if (decision._tag === "skip") {
          log(dependencies, "skipped", {
            kind: event._tag,
            reason: decision.reason,
          });
          return;
        }
        const notification = dependencies.createNotification(
          desktopNotificationText(event),
        );
        live.add(notification);
        notification.on("close", () => live.delete(notification));
        notification.on("click", () => {
          live.delete(notification);
          log(dependencies, "clicked", {
            kind: event._tag,
            reviewId: event.reviewId,
          });
          dependencies.onClick(desktopNotificationClick(event));
        });
        notification.show();
        log(dependencies, "shown", {
          kind: event._tag,
          reviewId: event.reviewId,
        });
      } catch (cause: unknown) {
        dependencies.logs.write({
          process: "main",
          level: "warn",
          topic: "desktop-notification",
          message: "failed",
          meta: { kind: event._tag, error: loggableMetaValue(cause) },
        });
      }
    },
  };
}

function log(
  dependencies: DesktopNotifierDependencies,
  message: "shown" | "clicked" | "skipped",
  meta: { readonly kind: string } & (
    | { readonly reviewId: string }
    | { readonly reason: string }
  ),
): void {
  dependencies.logs.write({
    process: "main",
    level: "debug",
    topic: "desktop-notification",
    message,
    meta,
  });
}

function desktopNotificationClick(
  event: DesktopNotificationEvent,
): DesktopNotificationClick {
  return event._tag === "InsightSettled"
    ? { reviewId: event.reviewId, insightType: event.insightType }
    : { reviewId: event.reviewId };
}

const insightLabels = {
  analysis: "Analysis",
  walkthrough: "Walkthrough",
  brief: "Brief",
} as const;

function desktopNotificationText(
  event: DesktopNotificationEvent,
): DesktopNotificationText {
  const { owner, repo, number } = event.pullRequest;
  const reference = `${owner}/${repo}#${number}`;
  switch (event._tag) {
    case "InsightSettled":
      return {
        title: `${insightLabels[event.insightType]} ${event.outcome === "completed" ? "finished" : "failed"}`,
        body: reference,
      };
    case "WriteNeedsRecovery":
      return {
        title: "GitHub writes are paused",
        body: `${reference}: check GitHub before making another change.`,
      };
    case "PreparationFinished":
      return { title: "Review ready", body: reference };
    case "MergeCompleted":
      return { title: "Pull request merged", body: reference };
    default:
      return casesHandled(event);
  }
}
