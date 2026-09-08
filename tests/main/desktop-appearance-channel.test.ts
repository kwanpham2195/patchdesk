import { describe, expect, it } from "vitest";

import type { Appearance } from "../../src/domain/contracts";
import {
  readWindowAppearance,
  sendWindowAppearance,
  serveWindowAppearance,
} from "../../src/main/desktop-appearance-channel";
import { DESKTOP_WINDOW_APPEARANCE_CHANNEL } from "../../src/main/ipc-contract";

/**
 * The channel name is a runtime string and carries both directions, so two
 * halves naming different literals would still compile: preload would read
 * "system" forever and the window would keep the appearance the user left.
 * These tests drive every half across one fake IPC bus.
 */
type AppearanceEvent = {
  returnValue: Appearance;
  sender: { id: number };
};

function fakeAppearanceBus(rendererId: number) {
  const handlers = new Map<
    string,
    Array<(event: AppearanceEvent, appearance: Appearance | undefined) => void>
  >();
  return {
    on(
      channel: string,
      handler: (
        event: AppearanceEvent,
        appearance: Appearance | undefined,
      ) => void,
    ): void {
      handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
    },
    removeAllListeners(channel: string): void {
      handlers.delete(channel);
    },
    listenerCount(channel: string): number {
      return (handlers.get(channel) ?? []).length;
    },
    sendSync(channel: string): Appearance {
      const event: AppearanceEvent = {
        returnValue: "system",
        sender: { id: rendererId },
      };
      for (const handler of handlers.get(channel) ?? [])
        handler(event, undefined);
      return event.returnValue;
    },
    send(channel: string, appearance: Appearance): void {
      const event: AppearanceEvent = {
        returnValue: "system",
        sender: { id: rendererId },
      };
      for (const handler of handlers.get(channel) ?? [])
        handler(event, appearance);
    },
  };
}

describe("window appearance channel", () => {
  it("answers the preload read with the appearance the window was created for", () => {
    const bus = fakeAppearanceBus(7);
    let current: Appearance = "dark";
    serveWindowAppearance(bus, 7, {
      current: () => current,
      update: (next) => {
        current = next;
      },
    });

    expect(readWindowAppearance(bus)).toBe("dark");
    current = "light";
    expect(readWindowAppearance(bus)).toBe("light");
  });

  it("applies the appearance the renderer reports", () => {
    const bus = fakeAppearanceBus(7);
    const applied: Appearance[] = [];
    serveWindowAppearance(bus, 7, {
      current: () => "system",
      update: (next) => applied.push(next),
    });

    sendWindowAppearance(bus, "light");
    sendWindowAppearance(bus, "system");

    expect(applied).toEqual(["light", "system"]);
  });

  it("ignores a renderer that does not own the window", () => {
    const bus = fakeAppearanceBus(9);
    const applied: Appearance[] = [];
    serveWindowAppearance(bus, 7, {
      current: () => "dark",
      update: (next) => applied.push(next),
    });

    sendWindowAppearance(bus, "light");

    expect(applied).toEqual([]);
    expect(readWindowAppearance(bus)).toBe("system");
  });

  it("drops the previous window's listener when a window is recreated", () => {
    const bus = fakeAppearanceBus(7);
    serveWindowAppearance(bus, 7, {
      current: () => {
        throw new Error("the destroyed window's listener still ran");
      },
      update: () => undefined,
    });
    serveWindowAppearance(bus, 7, {
      current: () => "light",
      update: () => undefined,
    });

    expect(bus.listenerCount(DESKTOP_WINDOW_APPEARANCE_CHANNEL)).toBe(1);
    expect(readWindowAppearance(bus)).toBe("light");
  });

  it("falls back to system when nothing on the main side answered", () => {
    expect(readWindowAppearance({ sendSync: () => undefined })).toBe("system");
  });
});
