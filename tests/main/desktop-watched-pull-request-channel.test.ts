import { describe, expect, it } from "vitest";

import {
  sendWatchedPullRequestChange,
  subscribeToWatchedPullRequestChanges,
} from "../../src/main/desktop-watched-pull-request-channel";

type ChangeHandler = (event: undefined, profileId: string) => void;

function fakeIpcBus() {
  const handlers = new Map<string, Array<ChangeHandler>>();
  return {
    on(channel: string, handler: ChangeHandler): void {
      handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
    },
    off(channel: string, handler: ChangeHandler): void {
      handlers.set(
        channel,
        (handlers.get(channel) ?? []).filter((entry) => entry !== handler),
      );
    },
    send(channel: string, profileId: string): void {
      for (const handler of handlers.get(channel) ?? [])
        handler(undefined, profileId);
    },
  };
}

describe("desktop watched-pull-request change channel", () => {
  it("delivers a change from the main-process sender to the preload subscriber until released", () => {
    const bus = fakeIpcBus();
    const received: string[] = [];

    const stop = subscribeToWatchedPullRequestChanges(bus, (profileId) =>
      received.push(profileId),
    );
    sendWatchedPullRequestChange(bus, "acme");
    stop();
    sendWatchedPullRequestChange(bus, "opn");

    expect(received).toEqual(["acme"]);
  });
});
