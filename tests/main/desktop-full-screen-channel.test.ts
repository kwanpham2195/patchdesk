import { describe, expect, it } from "vitest";

import {
  answerWindowFullScreenReads,
  readWindowFullScreen,
  sendWindowFullScreen,
  subscribeToWindowFullScreen,
} from "../../src/main/desktop-full-screen-channel";
import { DESKTOP_WINDOW_FULL_SCREEN_CHANNEL } from "../../src/main/ipc-contract";

/**
 * The channel name is a runtime string, and this channel has three halves —
 * main's push, main's answer to the synchronous read, and preload's
 * subscription. If any two named different channels, TypeScript would still
 * compile and the header would silently keep its full-screen inset. These
 * tests drive every half across one fake IPC bus.
 */
type FullScreenIpcHandler = (event: undefined, fullScreen: boolean) => void;

function fakePushBus() {
  const handlers = new Map<string, Array<FullScreenIpcHandler>>();
  return {
    on(channel: string, handler: FullScreenIpcHandler): void {
      handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
    },
    off(channel: string, handler: FullScreenIpcHandler): void {
      handlers.set(
        channel,
        (handlers.get(channel) ?? []).filter((entry) => entry !== handler),
      );
    },
    send(channel: string, fullScreen: boolean): void {
      for (const handler of handlers.get(channel) ?? [])
        handler(undefined, fullScreen);
    },
  };
}

type FullScreenReadEvent = {
  returnValue: boolean;
  sender: { id: number };
};

/**
 * The synchronous half: `ipcMain.on` answering `ipcRenderer.sendSync`. Like
 * Electron's, it runs every registered listener and returns whatever the last
 * one wrote, so a leaked listener from a previous window would not change the
 * answer — only `listenerCount` catches that.
 */
function fakeReadBus(rendererId: number) {
  const answers = new Map<
    string,
    Array<(event: FullScreenReadEvent) => void>
  >();
  return {
    on(channel: string, handler: (event: FullScreenReadEvent) => void): void {
      answers.set(channel, [...(answers.get(channel) ?? []), handler]);
    },
    removeAllListeners(channel: string): void {
      answers.delete(channel);
    },
    listenerCount(channel: string): number {
      return (answers.get(channel) ?? []).length;
    },
    sendSync(channel: string): boolean {
      const event: FullScreenReadEvent = {
        returnValue: false,
        sender: { id: rendererId },
      };
      for (const handler of answers.get(channel) ?? []) handler(event);
      return event.returnValue;
    },
  };
}

describe("window full-screen channel", () => {
  it("delivers every transition from the main-process sender to the preload subscriber", () => {
    const bus = fakePushBus();
    const received: boolean[] = [];

    const stop = subscribeToWindowFullScreen(bus, (fullScreen) =>
      received.push(fullScreen),
    );
    sendWindowFullScreen(bus, true);
    sendWindowFullScreen(bus, false);

    expect(received).toEqual([true, false]);
    stop();
  });

  it("stops delivering after the subscription is released", () => {
    const bus = fakePushBus();
    const received: boolean[] = [];

    const stop = subscribeToWindowFullScreen(bus, (fullScreen) =>
      received.push(fullScreen),
    );
    sendWindowFullScreen(bus, true);
    stop();
    sendWindowFullScreen(bus, false);

    expect(received).toEqual([true]);
  });

  it("pushes on the one exported channel name rather than a second literal", () => {
    const bus = fakePushBus();
    const channels: string[] = [];

    subscribeToWindowFullScreen(bus, () => undefined);
    sendWindowFullScreen(
      {
        send(channel: string, fullScreen: boolean) {
          channels.push(channel);
          bus.send(channel, fullScreen);
        },
      },
      true,
    );

    expect(channels).toEqual([DESKTOP_WINDOW_FULL_SCREEN_CHANNEL]);
  });

  it("answers the preload read with the window's current state", () => {
    const bus = fakeReadBus(7);
    let fullScreen = false;
    answerWindowFullScreenReads(bus, 7, () => fullScreen);

    expect(readWindowFullScreen(bus)).toBe(false);
    fullScreen = true;
    expect(readWindowFullScreen(bus)).toBe(true);
  });

  it("answers a renderer that does not own the window with false", () => {
    const bus = fakeReadBus(9);
    answerWindowFullScreenReads(bus, 7, () => true);

    expect(readWindowFullScreen(bus)).toBe(false);
  });

  it("drops the previous window's answer when a window is recreated", () => {
    const bus = fakeReadBus(7);
    answerWindowFullScreenReads(bus, 7, () => {
      throw new Error("the destroyed window's listener still ran");
    });
    answerWindowFullScreenReads(bus, 7, () => false);

    expect(bus.listenerCount(DESKTOP_WINDOW_FULL_SCREEN_CHANNEL)).toBe(1);
    expect(readWindowFullScreen(bus)).toBe(false);
  });
});
