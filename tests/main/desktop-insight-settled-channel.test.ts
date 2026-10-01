import { describe, expect, it } from "vitest";

import {
  sendInsightSettled,
  subscribeToInsightSettled,
} from "../../src/main/desktop-insight-settled-channel";

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

describe("desktop Insight-settled channel", () => {
  it("delivers a settled run from the main-process sender to the preload subscriber until released", () => {
    const bus = fakeIpcBus();
    let received = 0;

    const stop = subscribeToInsightSettled(bus, () => (received += 1));
    sendInsightSettled(bus);
    stop();
    sendInsightSettled(bus);

    expect(received).toBe(1);
  });
});
