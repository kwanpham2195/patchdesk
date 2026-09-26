import type { NotificationSettings } from "../domain/contracts";
import type { ReviewId } from "../domain/ids";
import type { WatchedPullRequestChange } from "../domain/watched-pull-request";
import type { LogEntryInput } from "../domain/log-entry";
import { loggableMetaValue } from "../domain/log-entry";
import { casesHandled, type Result } from "../domain/result";
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
  | {
      readonly _tag: "skip";
      readonly reason:
        | "disabled"
        | "focused_on_review"
        | "focused"
        | "open_in_workbench";
    };

/**
 * Whether one event is shown (ADR 0044): the toggles decide first, then the
 * focused window silences events about the Review it shows, and every
 * preparation event. A watched pull request open in the workbench stays
 * silent whether or not the window is focused, because the workbench's own
 * freshness check reports the change there (ADR 0045).
 */
export function decideDesktopNotification(input: {
  readonly focused: boolean;
  readonly destination: NotificationDestination;
  readonly settings: NotificationSettings;
  readonly event: DesktopNotificationEvent;
}): DesktopNotificationDecision {
  const lowerValue =
    input.event._tag === "PreparationFinished" ||
    input.event._tag === "MergeCompleted";
  if (
    !input.settings.enabled ||
    (lowerValue && !input.settings.preparationAndMerge)
  )
    return { _tag: "skip", reason: "disabled" };
  if (
    input.event._tag === "WatchedPullRequestChanged" &&
    input.destination.kind === "workbench" &&
    input.destination.reviewId === input.event.reviewId
  )
    return { _tag: "skip", reason: "open_in_workbench" };
  if (
    input.focused &&
    input.destination.kind === "workbench" &&
    input.destination.reviewId === input.event.reviewId
  )
    return { _tag: "skip", reason: "focused_on_review" };
  // Preparation runs while the maintainer is opening or refreshing a Review in the window, so a focused window already shows it.
  return input.focused && input.event._tag === "PreparationFinished"
    ? { _tag: "skip", reason: "focused" }
    : { _tag: "show" };
}

type DesktopNotifierDependencies = {
  readonly windowFocused: () => boolean;
  readonly destination: () => NotificationDestination;
  /** Read per event, so a toggle changed in Settings applies to the next one. */
  readonly settings: () => Promise<
    Result<NotificationSettings, "config_unreadable">
  >;
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
      void dependencies
        .settings()
        .then((settings) => {
          if (settings._tag === "ok") show(event, settings.value);
          else fail(event, settings.error);
        })
        .catch((cause: unknown) => fail(event, loggableMetaValue(cause)));
    },
  };

  function fail(
    event: DesktopNotificationEvent,
    error: ReturnType<typeof loggableMetaValue>,
  ): void {
    dependencies.logs.write({
      process: "main",
      level: "warn",
      topic: "desktop-notification",
      message: "failed",
      meta: { kind: event._tag, error },
    });
  }

  function show(
    event: DesktopNotificationEvent,
    settings: NotificationSettings,
  ): void {
    const decision = decideDesktopNotification({
      focused: dependencies.windowFocused(),
      destination: dependencies.destination(),
      settings,
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
    log(dependencies, "shown", { kind: event._tag, reviewId: event.reviewId });
  }
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
  switch (event._tag) {
    case "InsightSettled":
    case "AgentRunRequested":
      return {
        kind: "review",
        reviewId: event.reviewId,
        insightType: event.insightType,
      };
    case "WatchedPullRequestChanged":
      return { kind: "pullRequest", pullRequest: event.pullRequest };
    case "WriteNeedsRecovery":
    case "PreparationFinished":
    case "MergeCompleted":
      return { kind: "review", reviewId: event.reviewId };
    default:
      return casesHandled(event);
  }
}

const insightLabels = {
  analysis: "Analysis",
  walkthrough: "Walkthrough",
  brief: "Brief",
} as const;

const watchedChangeTitles = {
  commented: "New comment or review",
  decision: "Review decision changed",
  checks: "Checks changed",
  pushed: "New commits pushed",
  merged: "Pull request merged",
  closed: "Pull request closed",
} as const satisfies Record<WatchedPullRequestChange, string>;

function desktopNotificationText(
  event: DesktopNotificationEvent,
): DesktopNotificationText {
  if (event._tag === "AgentRunRequested")
    return {
      title: `Agent asks for ${insightLabels[event.insightType]}`,
      body:
        event.profileLabel === undefined
          ? event.localTitle
          : `${event.localTitle} · ${event.profileLabel} profile`,
    };
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
    case "WatchedPullRequestChanged":
      return { title: watchedChangeTitles[event.change], body: reference };
    default:
      return casesHandled(event);
  }
}
