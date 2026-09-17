import { describe, expect, it } from "vitest";

import { createDesktopNotifier } from "../../src/main/desktop-notifier";
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
) {
  const notifications = fakeNotifications();
  const logs: LogEntryInput[] = [];
  const clicks: DesktopNotificationClick[] = [];
  const notifier = createDesktopNotifier({
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
