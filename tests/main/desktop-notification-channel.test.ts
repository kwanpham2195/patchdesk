import { describe, expect, it } from "vitest";

import {
  sendNotificationClick,
  subscribeToNotificationClicks,
} from "../../src/main/desktop-notification-channel";
import type { DesktopNotificationClick } from "../../src/main/ipc-contract";

type ClickHandler = (event: undefined, click: DesktopNotificationClick) => void;

function fakeIpcBus() {
  const handlers = new Map<string, Array<ClickHandler>>();
  return {
    on(channel: string, handler: ClickHandler): void {
      handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
    },
    off(channel: string, handler: ClickHandler): void {
      handlers.set(
        channel,
        (handlers.get(channel) ?? []).filter((entry) => entry !== handler),
      );
    },
    send(channel: string, click: DesktopNotificationClick): void {
      for (const handler of handlers.get(channel) ?? [])
        handler(undefined, click);
    },
  };
}

describe("desktop notification-click channel", () => {
  it("delivers a click from the main-process sender to the preload subscriber until released", () => {
    const bus = fakeIpcBus();
    const received: DesktopNotificationClick[] = [];

    const stop = subscribeToNotificationClicks(bus, (click) =>
      received.push(click),
    );
    sendNotificationClick(bus, {
      kind: "review",
      reviewId: "r1",
      insightType: "analysis",
    });
    stop();
    sendNotificationClick(bus, { kind: "review", reviewId: "r2" });

    expect(received).toEqual([
      { kind: "review", reviewId: "r1", insightType: "analysis" },
    ]);
  });
});
