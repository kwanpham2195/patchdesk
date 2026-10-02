import { describe, expect, it } from "vitest";

import type { AppUpdateState } from "../../src/domain/app-update";
import {
  answerAppUpdateReads,
  readAppUpdate,
  sendAppUpdate,
  subscribeToAppUpdate,
} from "../../src/main/desktop-app-update-channel";

/** Both halves on one fake bus: main's `webContents.send`/`ipcMain.on` and preload's `ipcRenderer`. */
function fakeIpcBus(rendererId: number) {
  const pushHandlers = new Map<
    string,
    Array<(event: undefined, state: AppUpdateState) => void>
  >();
  const readHandlers = new Map<
    string,
    Array<
      (event: {
        returnValue: AppUpdateState;
        readonly sender: { readonly id: number };
      }) => void
    >
  >();
  return {
    on(
      channel: string,
      handler: (event: undefined, state: AppUpdateState) => void,
    ): void {
      pushHandlers.set(channel, [
        ...(pushHandlers.get(channel) ?? []),
        handler,
      ]);
    },
    off(
      channel: string,
      handler: (event: undefined, state: AppUpdateState) => void,
    ): void {
      pushHandlers.set(
        channel,
        (pushHandlers.get(channel) ?? []).filter((entry) => entry !== handler),
      );
    },
    send(channel: string, state: AppUpdateState): void {
      for (const handler of pushHandlers.get(channel) ?? [])
        handler(undefined, state);
    },
    host: {
      on(
        channel: string,
        handler: (event: {
          returnValue: AppUpdateState;
          readonly sender: { readonly id: number };
        }) => void,
      ): void {
        readHandlers.set(channel, [
          ...(readHandlers.get(channel) ?? []),
          handler,
        ]);
      },
      removeAllListeners(channel: string): void {
        readHandlers.delete(channel);
      },
    },
    sendSync(channel: string): AppUpdateState | undefined {
      const event = { returnValue: {}, sender: { id: rendererId } };
      for (const handler of readHandlers.get(channel) ?? []) handler(event);
      return event.returnValue;
    },
  };
}

const available: AppUpdateState = {
  available: {
    version: "0.0.18",
    releaseUrl:
      "https://github.com/kwanpham2195/patchdesk/releases/tag/v0.0.18",
    install: "homebrew",
    installing: false,
  },
};

describe("app update channel", () => {
  it("delivers pushed state to the preload subscriber until it unsubscribes", () => {
    const bus = fakeIpcBus(7);
    const received: AppUpdateState[] = [];

    const stop = subscribeToAppUpdate(bus, (state) => received.push(state));
    sendAppUpdate(bus, available);
    stop();
    sendAppUpdate(bus, {});

    expect(received).toEqual([available]);
  });

  it("answers the window's own preload read with the current state and any other frame with nothing", () => {
    const owner = fakeIpcBus(7);
    answerAppUpdateReads(owner.host, 7, () => available);
    const stranger = fakeIpcBus(9);
    answerAppUpdateReads(stranger.host, 7, () => available);

    expect(readAppUpdate(owner)).toEqual(available);
    expect(readAppUpdate(stranger)).toEqual({});
  });
});
