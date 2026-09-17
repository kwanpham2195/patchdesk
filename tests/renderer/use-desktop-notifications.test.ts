// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReviewWorkbenchInitialState } from "../../src/renderer/src/components/review-workbench-contracts";
import { useDesktopNotificationClicks } from "../../src/renderer/src/hooks/use-desktop-notifications";
import type { AppDestination } from "../../src/renderer/src/routes";
import {
  installDesktopDouble,
  type DesktopDouble,
} from "./fake-desktop-response";

let installed: DesktopDouble | undefined;

/** The ref shape `useReviewWorkbenchRoute` hands the app. */
type RestoredWorkbenchUi = {
  current:
    | { readonly reviewId: string; readonly state: ReviewWorkbenchInitialState }
    | undefined;
};

afterEach(() => {
  cleanup();
  installed?.restore();
  installed = undefined;
});

function render() {
  const double = installDesktopDouble({});
  installed = double;
  const navigate = vi.fn<(next: AppDestination) => void>();
  const restoredWorkbenchUi: RestoredWorkbenchUi = { current: undefined };
  renderHook(() =>
    useDesktopNotificationClicks({
      enabled: true,
      navigate,
      restoredWorkbenchUi,
    }),
  );
  return { double, navigate, restoredWorkbenchUi };
}

describe("useDesktopNotificationClicks", () => {
  it("opens an Insight notification's Review on that Insight's reader, through the guarded navigate", () => {
    const { double, navigate, restoredWorkbenchUi } = render();

    act(() =>
      double.sendNotificationClick({ reviewId: "r1", insightType: "analysis" }),
    );

    expect(restoredWorkbenchUi.current).toEqual({
      reviewId: "r1",
      state: { activeTab: "insights", insightDetail: "analysis" },
    });
    expect(navigate).toHaveBeenCalledWith({
      kind: "workbench",
      reviewId: "r1",
    });
  });

  it("opens a write-recovery notification's Review where it was left", () => {
    const { double, navigate, restoredWorkbenchUi } = render();

    act(() => double.sendNotificationClick({ reviewId: "r2" }));

    expect(restoredWorkbenchUi.current).toBeUndefined();
    expect(navigate).toHaveBeenCalledWith({
      kind: "workbench",
      reviewId: "r2",
    });
  });
});
