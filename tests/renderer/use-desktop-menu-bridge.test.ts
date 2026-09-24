// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useDesktopMenuBridge } from "../../src/renderer/src/hooks/use-desktop-menu-bridge";
import type { AppDestination } from "../../src/renderer/src/routes";
import {
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

describe("useDesktopMenuBridge destination", () => {
  it("reports the destination at mount and again after each navigation", () => {
    const double = installDesktopDouble(
      {},
      {
        operations: {
          setNavigationState: () => success({}),
          setNavigationDestination: () => success({}),
        },
      },
    );
    installed = double;
    const { rerender } = renderHook(
      ({ destination }: { readonly destination: AppDestination }) =>
        useDesktopMenuBridge({
          fixtureMode: false,
          destination,
          navigationState: "clear",
          openSettings: () => undefined,
          openDiagnostics: () => undefined,
          refreshDashboard: async () => undefined,
        }),
      { initialProps: { destination: { kind: "workbench", reviewId: "a" } } },
    );

    rerender({ destination: { kind: "dashboard" } });

    const destinations = double.request.mock.calls.flatMap(([input]) =>
      "operation" in input && input.operation === "setNavigationDestination"
        ? [input.destination]
        : [],
    );
    expect(destinations).toEqual([
      { kind: "workbench", reviewId: "a" },
      { kind: "dashboard" },
    ]);
  });
});
