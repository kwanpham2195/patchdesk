// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useReviewNavigationState } from "../../src/renderer/src/hooks/use-review-navigation-state";

afterEach(cleanup);

describe("useReviewNavigationState", () => {
  it("clears the leave guard when a Review with a kept summary unmounts", () => {
    const report = vi.fn();
    const { unmount } = renderHook(() =>
      useReviewNavigationState({
        writePending: false,
        draftKept: true,
        report,
      }),
    );
    expect(report).toHaveBeenLastCalledWith("dirty_draft");

    unmount();

    expect(report).toHaveBeenLastCalledWith("clear");
  });
});
