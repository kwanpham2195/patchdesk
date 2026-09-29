import { describe, expect, it } from "vitest";

import { parseReviewId } from "../../src/domain/ids";
import type { DesktopNavigationState } from "../../src/main/desktop-close-guard";
import { createReviewWindow } from "../../src/main/desktop-review-window";
import {
  DESKTOP_NOTIFICATION_CLICK_CHANNEL,
  type DesktopNotificationClick,
} from "../../src/main/ipc-contract";

const shownId = (() => {
  const parsed = parseReviewId(
    "acme__octo-org__patchdesk__pr-42__review-abcdef123456",
  );
  if (parsed._tag === "err") throw new Error("Invalid review id fixture");
  return parsed.value;
})();

/** A renderer that records what the main process sends it. */
function recordingRenderer() {
  const sent: Array<{ channel: string; click: DesktopNotificationClick }> = [];
  return {
    sent,
    send(channel: string, click: DesktopNotificationClick): void {
      sent.push({ channel, click });
    },
  };
}

describe("show_review window", () => {
  it("sends the Review down the notification-click channel when nothing guards the screen", async () => {
    const renderer = recordingRenderer();
    const window = createReviewWindow({
      navigationState: () => "clear",
      listeningRenderer: async () => renderer,
    });

    const outcome = await window.show(shownId);

    expect(outcome).toBe("shown");
    expect(renderer.sent).toEqual([
      {
        channel: DESKTOP_NOTIFICATION_CLICK_CHANNEL,
        click: {
          kind: "review",
          reviewId: shownId,
        },
      },
    ]);
  });

  it.each<DesktopNavigationState>(["dirty_draft", "write_pending"])(
    "holds the screen under %s and sends the renderer nothing",
    async (state) => {
      const renderer = recordingRenderer();
      const window = createReviewWindow({
        navigationState: () => state,
        listeningRenderer: async () => renderer,
      });

      const outcome = await window.show(shownId);

      expect(outcome).toBe("held");
      expect(renderer.sent).toEqual([]);
    },
  );

  it("answers undefined when no window could be opened", async () => {
    const window = createReviewWindow({
      navigationState: () => "clear",
      listeningRenderer: async () => undefined,
    });

    expect(await window.show(shownId)).toBeUndefined();
  });
});
