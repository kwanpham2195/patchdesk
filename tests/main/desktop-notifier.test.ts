import { describe, expect, it, vi } from "vitest";

import {
  createDesktopNotifier,
  decideDesktopNotification,
  type NotificationDestination,
} from "../../src/main/desktop-notifier";
import type { DesktopNotificationClick } from "../../src/main/ipc-contract";
import type { NotificationSettings } from "../../src/domain/contracts";
import type { LogEntryInput } from "../../src/domain/log-entry";
import { ok } from "../../src/domain/result";
import type { DesktopNotificationEvent } from "../../src/services/desktop-notifier";
import {
  reviewId,
  sessionKey,
} from "../services/pull-request-metadata-fixtures";

const pullRequest = {
  host: sessionKey.host,
  owner: sessionKey.owner,
  repo: sessionKey.repo,
  number: sessionKey.source.prNumber,
};

const analysisFinished: DesktopNotificationEvent = {
  _tag: "InsightSettled",
  reviewId,
  pullRequest,
  insightType: "analysis",
  outcome: "completed",
};

const defaults: NotificationSettings = {
  enabled: true,
  preparationAndMerge: false,
  intervalMinutes: 3,
};

/** Wait for the notification decision rather than a timer turn. */
async function waitForNotificationDecision(
  logs: LogEntryInput[],
): Promise<void> {
  await vi.waitFor(() => expect(logs).toHaveLength(1));
}

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
  options: {
    readonly createNotification?: ReturnType<
      typeof fakeNotifications
    >["create"];
    readonly focused?: boolean;
    readonly destination?: NotificationDestination;
    readonly settings?: NotificationSettings;
  } = {},
) {
  const notifications = fakeNotifications();
  const logs: LogEntryInput[] = [];
  const clicks: DesktopNotificationClick[] = [];
  const notifier = createDesktopNotifier({
    windowFocused: () => options.focused ?? false,
    destination: () => options.destination ?? { kind: "dashboard" },
    settings: async () => ok(options.settings ?? defaults),
    createNotification: options.createNotification ?? notifications.create,
    onClick: (click) => clicks.push(click),
    logs: { write: (entry) => logs.push(entry) },
  });
  return { notifier, notifications, logs, clicks };
}

describe("createDesktopNotifier", () => {
  it("shows the pull request reference and logs the event tag and Review id only", async () => {
    const { notifier, notifications, logs } = harness();

    notifier.notify(analysisFinished);
    await waitForNotificationDecision(logs);

    expect(notifications.shown).toMatchObject([
      { title: "Analysis finished", body: "octo-org/patchdesk#42" },
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

  it("routes a click to the Insight reader of that Review", async () => {
    const { notifier, notifications, logs, clicks } = harness();

    notifier.notify(analysisFinished);
    await waitForNotificationDecision(logs);
    notifications.shown[0]?.click();

    expect(clicks).toEqual([
      { kind: "review", reviewId, insightType: "analysis" },
    ]);
    expect(logs.map((entry) => entry.message)).toEqual(["shown", "clicked"]);
  });

  it("names a watched pull request's change and routes its click to the pull request", async () => {
    const { notifier, notifications, clicks, logs } = harness();

    notifier.notify({
      _tag: "WatchedPullRequestChanged",
      reviewId,
      pullRequest,
      change: "pushed",
    });
    await waitForNotificationDecision(logs);
    notifications.shown[0]?.click();

    expect(notifications.shown).toMatchObject([
      { body: "octo-org/patchdesk#42" },
    ]);
    expect(clicks).toEqual([{ kind: "pullRequest", pullRequest }]);
  });

  it.each([
    [
      "focused on the event's Review",
      {
        focused: true,
        destination: { kind: "workbench", reviewId } as const,
      },
      "focused_on_review",
    ],
    [
      "with Notifications off",
      {
        settings: {
          enabled: false,
          preparationAndMerge: true,
          intervalMinutes: 3,
        },
      },
      "disabled",
    ],
  ] as const)(
    "stays silent and logs why %s",
    async (_label, options, reason) => {
      const { notifier, notifications, logs } = harness(options);

      notifier.notify(analysisFinished);
      await waitForNotificationDecision(logs);

      expect(notifications.shown).toEqual([]);
      expect(logs).toMatchObject([
        {
          level: "debug",
          message: "skipped",
          meta: { kind: "InsightSettled", reason },
        },
      ]);
    },
  );

  it("logs a notification the platform refused instead of throwing into the caller", async () => {
    const { notifier, logs } = harness({
      createNotification: () => {
        throw new Error("notification center unavailable");
      },
    });

    expect(() =>
      notifier.notify({ _tag: "WriteNeedsRecovery", reviewId, pullRequest }),
    ).not.toThrow();
    await waitForNotificationDecision(logs);
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
  it.each([
    { focused: false, on: "workbench", expected: "open_in_workbench" },
    { focused: true, on: "workbench", expected: "open_in_workbench" },
    { focused: true, on: "dashboard", expected: "show" },
  ] as const)(
    "a watched pull request change while focused=$focused on the $on: $expected",
    ({ focused, on, expected }) => {
      const decision = decideDesktopNotification({
        focused,
        destination:
          on === "workbench" ? { kind: "workbench", reviewId } : { kind: on },
        settings: defaults,
        event: {
          _tag: "WatchedPullRequestChanged",
          reviewId,
          pullRequest,
          change: "commented",
        },
      });

      expect(decision._tag === "show" ? "show" : decision.reason).toBe(
        expected,
      );
    },
  );

  const preparationFinished: DesktopNotificationEvent = {
    _tag: "PreparationFinished",
    reviewId,
    pullRequest,
  };
  const withPreparation = {
    enabled: true,
    preparationAndMerge: true,
    intervalMinutes: 3,
  } as const;
  it.each([
    { focused: true, destination: { kind: "dashboard" }, expected: "focused" },
    {
      focused: true,
      destination: { kind: "workbench", reviewId },
      expected: "focused_on_review",
    },
    { focused: false, destination: { kind: "dashboard" }, expected: "show" },
  ] as const)(
    "preparation finished while focused=$focused on $destination.kind: $expected",
    ({ focused, destination, expected }) => {
      const decision = decideDesktopNotification({
        focused,
        destination,
        settings: withPreparation,
        event: preparationFinished,
      });

      expect(decision._tag === "show" ? "show" : decision.reason).toBe(
        expected,
      );
    },
  );

  const otherReviewId = "acme__octo-org__patchdesk__pr-7__review-0123456789ab";
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
        settings: defaults,
        event: analysisFinished,
      });

      expect(decision._tag === "show" ? "show" : decision.reason).toBe(
        expected,
      );
    },
  );

  it.each([
    [
      { enabled: false, preparationAndMerge: true, intervalMinutes: 3 },
      "InsightSettled",
      "disabled",
    ],
    [
      { enabled: true, preparationAndMerge: false, intervalMinutes: 3 },
      "WriteNeedsRecovery",
      "show",
    ],
    [
      { enabled: true, preparationAndMerge: false, intervalMinutes: 3 },
      "PreparationFinished",
      "disabled",
    ],
    [
      { enabled: true, preparationAndMerge: false, intervalMinutes: 3 },
      "MergeCompleted",
      "disabled",
    ],
    [
      { enabled: true, preparationAndMerge: true, intervalMinutes: 3 },
      "MergeCompleted",
      "show",
    ],
    [
      { enabled: false, preparationAndMerge: true, intervalMinutes: 3 },
      "MergeCompleted",
      "disabled",
    ],
  ] as const)("settings %o for %s: %s", (settings, tag, expected) => {
    const event: DesktopNotificationEvent =
      tag === "InsightSettled"
        ? analysisFinished
        : { _tag: tag, reviewId, pullRequest };

    const decision = decideDesktopNotification({
      focused: false,
      destination: { kind: "dashboard" },
      settings,
      event,
    });

    expect(decision._tag === "show" ? "show" : decision.reason).toBe(expected);
  });
});
