import type { ReviewId } from "../domain/ids";
import type { DesktopNavigationState } from "./desktop-close-guard";
import {
  sendNotificationClick,
  type NotificationClickSender,
} from "./desktop-notification-channel";

/** What `show_review` did to the screen; `held` moved nothing. */
export type ReviewShowOutcome = "shown" | "held";

/**
 * The window port `show_review` calls (ADR 0052). `show` resolves undefined
 * when no window was open and none could be opened.
 */
export type ReviewWindow = {
  show(reviewId: ReviewId): Promise<ReviewShowOutcome | undefined>;
};

/** The parts of the Electron main process `show_review` reaches. */
export type ReviewWindowShell = {
  /** The renderer's reported leave guard, the state the close guard reads. */
  readonly navigationState: () => DesktopNavigationState;
  /**
   * The window's renderer once it listens for clicks, opening a window
   * without activating it when none is open; undefined when that fails.
   */
  readonly listeningRenderer: () => Promise<
    NotificationClickSender | undefined
  >;
};

/**
 * Sends the Review down the notification-click channel, so the renderer opens
 * it through the same `navigate` a clicked notification uses, but never
 * raises or focuses the window: the agent picks the moment, not the
 * maintainer. A leave guard holds the screen without parking the Review
 * behind the leave dialog, which would pop up under the maintainer's typing.
 */
export function createReviewWindow(shell: ReviewWindowShell): ReviewWindow {
  return {
    async show(reviewId) {
      const renderer = await shell.listeningRenderer();
      if (renderer === undefined) return undefined;
      if (shell.navigationState() !== "clear") return "held";
      sendNotificationClick(renderer, { kind: "review", reviewId });
      return "shown";
    },
  };
}
