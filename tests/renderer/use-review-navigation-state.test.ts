// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useReviewNavigationState } from "#src/renderer/src/hooks/use-review-navigation-state";
import { useUnsentReviewTextFields } from "#src/renderer/src/hooks/use-unsent-review-text";
import { GuideReadingFlushProvider } from "#src/renderer/src/hooks/use-guide-reading-flush";
import type { GuideReadingAdmission } from "#src/main/guide-reading-flush-channel";
import { installDesktopDouble } from "./fake-desktop-response";

afterEach(cleanup);

describe("useReviewNavigationState", () => {
  it("inspects actual reported text before the dirty-state render commits without sending its body", async () => {
    const desktop = installDesktopDouble({});
    const { result } = renderHook(
      () => {
        const fields = useUnsentReviewTextFields();
        useReviewNavigationState({
          writePending: false,
          unsentText: fields.holdsUnsentText,
          draftIdentity: fields.getDraftIdentity,
          report: () => undefined,
        });
        return fields;
      },
      { wrapper: GuideReadingFlushProvider },
    );
    let inspecting: Promise<GuideReadingAdmission | undefined> | undefined;
    act(() => {
      result.current.report("field", "new nonempty body");
      inspecting = desktop.guideAdmission({
        requestId: "before-render",
        phase: "inspect",
      });
    });
    const receipt = await inspecting;
    expect(receipt?.state).toBe("dirty_draft");
    expect(JSON.stringify(receipt)).not.toContain("new nonempty body");
    desktop.restore();
  });

  it("clears the leave guard when a Review with a kept summary unmounts", () => {
    const report = vi.fn();
    const { unmount } = renderHook(() =>
      useReviewNavigationState({
        writePending: false,
        unsentText: true,
        draftIdentity: () => "kept summary",
        report,
      }),
    );
    expect(report).toHaveBeenLastCalledWith("dirty_draft");

    unmount();

    expect(report).toHaveBeenLastCalledWith("clear");
  });
});
