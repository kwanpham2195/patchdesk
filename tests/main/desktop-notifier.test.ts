import { describe, expect, it } from "vitest";

import {
  createDesktopNotifier,
  decideDesktopNotification,
  type NotificationDestination,
} from "../../src/main/desktop-notifier";
import type { DesktopNotificationClick } from "../../src/main/ipc-contract";
import type { LogEntryInput } from "../../src/domain/log-entry";
import type { DesktopNotificationEvent } from "../../src/services/desktop-notifier";
import {
  reviewId,
  sessionKey,
} from "../services/pull-request-metadata-fixtures";

const pullRequest = {
  host: sessionKey.host,
  owner: sessionKey.owner,
  repo: sessionKey.repo,
  number: sessionKey.prNumber,
};

const analysisFinished: DesktopNotificationEvent = {
  _tag: "InsightSettled",
  reviewId,
  pullRequest,
  insightType: "analysis",
  outcome: "completed",
};

/** A stand-in for Electron's `Notification` that records what was shown. */
function fakeNotifications() {
  const shown: Array<{
    readonly title: string;
    readonly body: string;
    readonly click: () => void;
  }> = [];
  return {
    shown,
    create(options: { readonly title: string; readonly body: string }) {
      const listeners = new Map<string, () => void>();
      return {
        on(event: "click" | "close", listener: () => void) {
          listeners.set(event, listener);
        },
        show() {
          shown.push({
            ...options,
            click: () => listeners.get("click")?.(),
          });
        },
      };
    },
  };
}

function harness(
  createNotification?: ReturnType<typeof fakeNotifications>["create"],
  window: {
    readonly focused: boolean;
    readonly destination: NotificationDestination;
  } = { focused: false, destination: { kind: "dashboard" } },
) {
  const notifications = fakeNotifications();
  const logs: LogEntryInput[] = [];
  const clicks: DesktopNotificationClick[] = [];
  const notifier = createDesktopNotifier({
    windowFocused: () => window.focused,
    destination: () => window.destination,
    createNotification: createNotification ?? notifications.create,
    onClick: (click) => clicks.push(click),
    logs: { write: (entry) => logs.push(entry) },
  });
  return { notifier, notifications, logs, clicks };
}

describe("createDesktopNotifier", () => {
  it("shows the pull request reference and logs the event tag and Review id only", () => {
    const { notifier, notifications, logs } = harness();

    notifier.notify(analysisFinished);

    expect(notifications.shown).toMatchObject([
      { title: "Analysis finished", body: "centraldigital/patchdesk#42" },
    ]);
    expect(logs).toEqual([
      {
        process: "main",
        level: "debug",
        topic: "desktop-notification",
        message: "shown",
        meta: { kind: "InsightSettled", reviewId },
      },
    ]);
  });

  it("routes a click to the Insight reader of that Review", () => {
    const { notifier, notifications, logs, clicks } = harness();

    notifier.notify(analysisFinished);
    notifications.shown[0]?.click();

    expect(clicks).toEqual([{ reviewId, insightType: "analysis" }]);
    expect(logs.map((entry) => entry.message)).toEqual(["shown", "clicked"]);
  });

  it("stays silent and logs why while the window is focused on the event's Review", () => {
    const { notifier, notifications, logs } = harness(undefined, {
      focused: true,
      destination: { kind: "workbench", reviewId },
    });

    notifier.notify(analysisFinished);

    expect(notifications.shown).toEqual([]);
    expect(logs).toMatchObject([
      {
        level: "debug",
        message: "skipped",
        meta: { kind: "InsightSettled", reason: "focused_on_review" },
      },
    ]);
  });

  it("logs a notification the platform refused instead of throwing into the caller", () => {
    const { notifier, logs } = harness(() => {
      throw new Error("notification center unavailable");
    });

    expect(() =>
      notifier.notify({ _tag: "WriteNeedsRecovery", reviewId, pullRequest }),
    ).not.toThrow();
    expect(logs).toMatchObject([
      {
        level: "warn",
        message: "failed",
        meta: { kind: "WriteNeedsRecovery" },
      },
    ]);
  });
});

describe("decideDesktopNotification", () => {
  const otherReviewId =
    "cfw__centraldigital__patchdesk__pr-7__review-0123456789ab";
  it.each([
    { focused: false, on: "same Review", expected: "show" },
    { focused: false, on: "other Review", expected: "show" },
    { focused: false, on: "dashboard", expected: "show" },
    { focused: true, on: "same Review", expected: "focused_on_review" },
    { focused: true, on: "other Review", expected: "show" },
    { focused: true, on: "dashboard", expected: "show" },
  ] as const)(
    "focused=$focused on the $on: $expected",
    ({ focused, on, expected }) => {
      const destination: NotificationDestination =
        on === "dashboard"
          ? { kind: "dashboard" }
          : {
              kind: "workbench",
              // SAFETY: both literals match the Review id syntax the bridge parses before this rule runs.
              reviewId: (on === "same Review"
                ? reviewId
                : otherReviewId) as typeof reviewId,
            };

      const decision = decideDesktopNotification({
        focused,
        destination,
        event: analysisFinished,
      });

      expect(decision._tag === "show" ? "show" : decision.reason).toBe(
        expected,
      );
    },
  );
});
