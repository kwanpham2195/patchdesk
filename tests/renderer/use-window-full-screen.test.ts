// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useWindowFullScreen } from "../../src/renderer/src/hooks/use-window-full-screen";
import {
  installDesktopDouble,
  type DesktopDouble,
} from "./fake-desktop-response";

let bridge: DesktopDouble | undefined;

afterEach(() => {
  bridge?.restore();
  bridge = undefined;
});

describe("useWindowFullScreen", () => {
  it("starts from the state preload read as the renderer loaded", () => {
    bridge = installDesktopDouble({}, { windowFullScreenAtLoad: true });

    const { result } = renderHook(() => useWindowFullScreen());

    expect(result.current).toBe(true);
  });

  it("follows the transitions the main process pushes", () => {
    bridge = installDesktopDouble({}, { windowFullScreenAtLoad: false });
    const double = bridge;

    const { result } = renderHook(() => useWindowFullScreen());
    act(() => double.sendWindowFullScreen(true));

    expect(result.current).toBe(true);

    act(() => double.sendWindowFullScreen(false));

    expect(result.current).toBe(false);
  });

  it("releases the subscription when the component unmounts", () => {
    bridge = installDesktopDouble({});
    const double = bridge;

    const { unmount } = renderHook(() => useWindowFullScreen());

    expect(double.hasWindowFullScreenListener()).toBe(true);

    unmount();

    expect(double.hasWindowFullScreenListener()).toBe(false);
  });

  it("stays false where the bridge has no full-screen member", () => {
    const { result } = renderHook(() => useWindowFullScreen());

    expect(result.current).toBe(false);
  });
});
