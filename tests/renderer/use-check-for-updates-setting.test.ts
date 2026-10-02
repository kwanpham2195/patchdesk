// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useCheckForUpdatesSetting } from "../../src/renderer/src/hooks/use-check-for-updates-setting";
import { installDesktopDouble, success } from "./fake-desktop-response";

let restore: (() => void) | undefined;

afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

describe("useCheckForUpdatesSetting", () => {
  it("reads an unsaved setting as on and patches only the switch", async () => {
    const double = installDesktopDouble({
      "/v1/settings": (input) =>
        input.method === "PATCH"
          ? success({ checkForUpdates: false })
          : success({ appearance: "dark" }),
    });
    restore = double.restore;
    const { result } = renderHook(() => useCheckForUpdatesSetting());
    await waitFor(() =>
      expect(result.current.state).toEqual({ _tag: "ready", enabled: true }),
    );

    await act(() => result.current.update(false));

    expect(
      double.request.mock.calls.flatMap(([input]) =>
        "path" in input && input.method === "PATCH" ? [input.body] : [],
      ),
    ).toEqual([{ checkForUpdates: false }]);
    expect(result.current.state).toEqual({ _tag: "ready", enabled: false });
  });
});
