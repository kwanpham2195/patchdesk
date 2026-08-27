// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  useKeyboardJump,
  type KeyboardJump,
} from "../../src/renderer/src/hooks/use-keyboard-jump";

function press(key: string): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key }));
  });
}

/**
 * Watches this test's `keydown` listener traffic on `window`.
 *
 * `count()` is the live listener total, for "nothing is left behind".
 * `adds()` and `removes()` are the raw call censuses, and only they can see a
 * listener that is removed and re-added: that cycle leaves the live total at
 * 1, so a `count()` assertion is identically true whether the listener is
 * attached once or re-attached on every render.
 */
function trackKeydownListeners() {
  const keydown = new Set<EventListenerOrEventListenerObject>();
  let added = 0;
  let removed = 0;
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation(
    (type, listener, options) => {
      if (type === "keydown" && listener !== null) {
        keydown.add(listener);
        added += 1;
      }
      add(type, listener, options);
    },
  );
  vi.spyOn(window, "removeEventListener").mockImplementation(
    (type, listener, options) => {
      if (type === "keydown" && listener !== null) {
        keydown.delete(listener);
        removed += 1;
      }
      remove(type, listener, options);
    },
  );
  return {
    count: () => keydown.size,
    adds: () => added,
    removes: () => removed,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useKeyboardJump", () => {
  it("listens only while enabled", () => {
    const onKeyDown = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }) => useKeyboardJump(enabled, onKeyDown),
      { initialProps: { enabled: true } },
    );

    press("]");
    expect(onKeyDown).toHaveBeenCalledTimes(1);

    rerender({ enabled: false });
    press("]");
    expect(onKeyDown).toHaveBeenCalledTimes(1);

    rerender({ enabled: true });
    press("]");
    expect(onKeyDown).toHaveBeenCalledTimes(2);
  });

  it("leaves no listener behind on unmount", () => {
    const listeners = trackKeydownListeners();
    const onKeyDown = vi.fn();
    const { unmount } = renderHook(() => useKeyboardJump(true, onKeyDown));

    expect(listeners.count()).toBe(1);
    unmount();
    expect(listeners.count()).toBe(0);

    press("]");
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it("leaves no listener behind when it stops being enabled", () => {
    const listeners = trackKeydownListeners();
    const { rerender } = renderHook(
      ({ enabled }) => useKeyboardJump(enabled, () => undefined),
      { initialProps: { enabled: true } },
    );

    expect(listeners.count()).toBe(1);
    rerender({ enabled: false });
    expect(listeners.count()).toBe(0);
  });

  it("uses the newest handler without re-attaching the listener", () => {
    const listeners = trackKeydownListeners();
    const first = vi.fn();
    const second = vi.fn();
    const third = vi.fn();
    const fourth = vi.fn();
    const { rerender } = renderHook(
      ({ onKeyDown }) => useKeyboardJump(true, onKeyDown),
      { initialProps: { onKeyDown: first } },
    );

    // One attach for the mount, and none of the four handler identities that
    // follow may cost another. The assertion is on the `addEventListener`
    // census rather than the live listener total, because a remove-then-add
    // cycle leaves that total at 1 and would pass either way.
    for (const onKeyDown of [second, third, fourth, second])
      rerender({ onKeyDown });
    expect(listeners.adds()).toBe(1);
    expect(listeners.removes()).toBe(0);

    press("]");
    expect(first).not.toHaveBeenCalled();
    expect(third).not.toHaveBeenCalled();
    expect(fourth).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(listeners.count()).toBe(1);
  });

  it("cancels the jump in flight when a newer one starts, and makes it stale", () => {
    const cancelFirst = vi.fn();
    const cancelSecond = vi.fn();
    const staleChecks: Array<() => boolean> = [];
    const cancels = [cancelFirst, cancelSecond];
    const onKeyDown = (_event: KeyboardEvent, jump: KeyboardJump): void => {
      jump.start((isStale) => {
        staleChecks.push(isStale);
        return cancels[staleChecks.length - 1] ?? (() => undefined);
      });
    };
    renderHook(() => useKeyboardJump(true, onKeyDown));

    press("]");
    const [firstStale] = staleChecks;
    expect(firstStale?.()).toBe(false);
    expect(cancelFirst).not.toHaveBeenCalled();

    press("]");
    expect(cancelFirst).toHaveBeenCalledTimes(1);
    expect(firstStale?.()).toBe(true);
    const secondStale = staleChecks[1];
    expect(secondStale?.()).toBe(false);
    expect(cancelSecond).not.toHaveBeenCalled();
  });

  it("cancels the jump in flight on unmount, and makes it stale", () => {
    const cancel = vi.fn();
    let isStale: (() => boolean) | undefined;
    const onKeyDown = (_event: KeyboardEvent, jump: KeyboardJump): void => {
      jump.start((stale) => {
        isStale = stale;
        return cancel;
      });
    };
    const { unmount } = renderHook(() => useKeyboardJump(true, onKeyDown));

    press("]");
    // Control: while the surface is alive the jump is neither cancelled nor
    // stale, so the assertions below are not true of every jump.
    expect(cancel).not.toHaveBeenCalled();
    expect(isStale?.()).toBe(false);

    unmount();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(isStale?.()).toBe(true);
  });
});
