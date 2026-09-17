// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useNotificationSettings } from "../../src/renderer/src/hooks/use-notification-settings";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";

let installed: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  installed?.restore();
  installed = undefined;
});

describe("useNotificationSettings", () => {
  it("shows the defaults for a config that never saved the toggles", async () => {
    installed = installDesktopDouble({
      "/v1/settings": () => success({ appearance: "dark" }),
    });

    const { result } = renderHook(() => useNotificationSettings());

    await waitFor(() =>
      expect(result.current.state).toEqual({
        _tag: "ready",
        settings: { enabled: true, preparationAndMerge: false },
      }),
    );
  });

  it("patches both toggles together and keeps what the API stored", async () => {
    const double = installDesktopDouble({
      "/v1/settings": (input) =>
        input.method === "PATCH"
          ? success({
              notifications: { enabled: false, preparationAndMerge: false },
            })
          : success({}),
    });
    installed = double;
    const { result } = renderHook(() => useNotificationSettings());
    await waitFor(() => expect(result.current.state._tag).toBe("ready"));

    await act(() =>
      result.current.update({ enabled: false, preparationAndMerge: false }),
    );

    expect(
      double.request.mock.calls.flatMap(([input]) =>
        "path" in input && input.method === "PATCH" ? [input.body] : [],
      ),
    ).toEqual([
      { notifications: { enabled: false, preparationAndMerge: false } },
    ]);
    expect(result.current.state).toEqual({
      _tag: "ready",
      settings: { enabled: false, preparationAndMerge: false },
    });
  });

  it("reverts a toggle the API refused to save", async () => {
    installed = installDesktopDouble({
      "/v1/settings": (input) =>
        input.method === "PATCH" ? failure({ error: "storage" }) : success({}),
    });
    const { result } = renderHook(() => useNotificationSettings());
    await waitFor(() => expect(result.current.state._tag).toBe("ready"));

    await act(() =>
      result.current.update({ enabled: true, preparationAndMerge: true }),
    );

    expect(result.current.saveFailed).toBe(true);
    expect(result.current.state).toEqual({
      _tag: "ready",
      settings: { enabled: true, preparationAndMerge: false },
    });
  });
});
