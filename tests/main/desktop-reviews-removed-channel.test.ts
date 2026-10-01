import { describe, expect, it } from "vitest";

import {
  sendReviewsRemoved,
  subscribeToReviewsRemoved,
} from "../../src/main/desktop-reviews-removed-channel";

type SettledHandler = (event: undefined) => void;

function fakeIpcBus() {
  const handlers = new Map<string, Array<SettledHandler>>();
  return {
    on(channel: string, handler: SettledHandler): void {
      handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
    },
    off(channel: string, handler: SettledHandler): void {
      handlers.set(
        channel,
        (handlers.get(channel) ?? []).filter((entry) => entry !== handler),
      );
    },
    send(channel: string): void {
      for (const handler of handlers.get(channel) ?? []) handler(undefined);
    },
  };
}

describe("desktop reviews-removed channel", () => {
  it("delivers a sweep that removed Reviews from the main-process sender to the preload subscriber until released", () => {
    const bus = fakeIpcBus();
    let received = 0;

    const stop = subscribeToReviewsRemoved(bus, () => (received += 1));
    sendReviewsRemoved(bus);
    stop();
    sendReviewsRemoved(bus);

    expect(received).toBe(1);
  });
});
