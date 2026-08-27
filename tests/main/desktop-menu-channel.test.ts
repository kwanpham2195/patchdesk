import { describe, expect, it } from "vitest";

import {
  sendMenuAction,
  subscribeToMenuActions,
} from "../../src/main/desktop-menu-channel";
import {
  DESKTOP_MENU_ACTION_CHANNEL,
  type DesktopMenuAction,
} from "../../src/main/ipc-contract";

/**
 * The channel name is a runtime string. If `sendMenuAction` and
 * `subscribeToMenuActions` ever named different channels, TypeScript would
 * still compile, every renderer test would still pass against its own
 * `window.patchdesk` stub, and the native menu would silently do nothing.
 * These tests drive a real send into a real subscription across one fake IPC
 * bus, so a disagreement between the two halves fails here.
 */
type MenuActionIpcHandler = (
  event: undefined,
  action: DesktopMenuAction,
) => void;

function fakeIpcBus() {
  const handlers = new Map<string, Array<MenuActionIpcHandler>>();
  return {
    on(channel: string, handler: MenuActionIpcHandler): void {
      handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
    },
    off(channel: string, handler: MenuActionIpcHandler): void {
      handlers.set(
        channel,
        (handlers.get(channel) ?? []).filter((entry) => entry !== handler),
      );
    },
    send(channel: string, action: DesktopMenuAction): void {
      for (const handler of handlers.get(channel) ?? [])
        handler(undefined, action);
    },
  };
}

describe("desktop menu-action channel", () => {
  it("delivers every menu action from the main-process sender to the preload subscriber", () => {
    const bus = fakeIpcBus();
    const received: DesktopMenuAction[] = [];

    const stop = subscribeToMenuActions(bus, (action) => received.push(action));
    sendMenuAction(bus, "openSettings");
    sendMenuAction(bus, "refresh");

    expect(received).toEqual(["openSettings", "refresh"]);
    stop();
  });

  it("stops delivering after the subscription is released", () => {
    const bus = fakeIpcBus();
    const received: DesktopMenuAction[] = [];

    const stop = subscribeToMenuActions(bus, (action) => received.push(action));
    sendMenuAction(bus, "openSettings");
    stop();
    sendMenuAction(bus, "refresh");

    expect(received).toEqual(["openSettings"]);
  });

  it("sends on the one exported channel name rather than a second literal", () => {
    const bus = fakeIpcBus();
    const channels: string[] = [];
    const recordingBus = {
      ...bus,
      send(channel: string, action: DesktopMenuAction) {
        channels.push(channel);
        bus.send(channel, action);
      },
    };

    subscribeToMenuActions(bus, () => undefined);
    sendMenuAction(recordingBus, "refresh");

    expect(channels).toEqual([DESKTOP_MENU_ACTION_CHANNEL]);
  });
});
