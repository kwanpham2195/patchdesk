// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it } from "vitest";

import {
  analysisFindingRowId,
  ReviewWorkbenchFindingNavigationContext,
  type FindingFocusRequest,
} from "../../src/renderer/src/components/review-workbench-finding-navigation";
import { useInsightSelection } from "../../src/renderer/src/hooks/use-insight-selection";

afterEach(() => {
  cleanup();
  document.getElementById(analysisFindingRowId("first"))?.remove();
  document.getElementById(analysisFindingRowId("second"))?.remove();
});

describe("useInsightSelection", () => {
  it("lands on Brief when no saved detail is restored", () => {
    const { result } = renderHook(() => useInsightSelection(undefined));

    expect(result.current.selectedInsight).toBe("brief");
  });

  it("lets a saved detail win over the Brief default", () => {
    const { result } = renderHook(() => useInsightSelection("analysis"));

    expect(result.current.selectedInsight).toBe("analysis");
  });

  it("focuses each new finding request once and leaves the same request dismissed", () => {
    function addFindingRow(findingId: string) {
      const row = document.createElement("div");
      row.id = analysisFindingRowId(findingId);
      row.tabIndex = -1;
      const scrollOptions: Array<ScrollIntoViewOptions | undefined> = [];
      Object.defineProperty(row, "scrollIntoView", {
        value: (options?: ScrollIntoViewOptions) => scrollOptions.push(options),
      });
      document.body.append(row);
      return { row, scrollOptions };
    }

    let request: FindingFocusRequest | undefined;
    const wrapper = ({ children }: PropsWithChildren) => (
      <ReviewWorkbenchFindingNavigationContext.Provider
        value={{
          openFindingInDiff: () => undefined,
          findingFocusRequest: request,
        }}
      >
        {children}
      </ReviewWorkbenchFindingNavigationContext.Provider>
    );
    const { result, rerender } = renderHook(
      () => useInsightSelection(undefined),
      { wrapper },
    );
    const first = addFindingRow("first");
    const second = addFindingRow("second");

    request = { findingId: "first", token: 1 };
    rerender();

    expect(result.current.selectedInsight).toBe("analysis");
    expect(document.activeElement).toBe(first.row);
    expect(first.scrollOptions).toEqual([{ block: "center" }]);

    act(() => result.current.setSelectedInsight("brief"));
    expect(result.current.selectedInsight).toBe("brief");
    expect(first.scrollOptions).toHaveLength(1);

    request = { findingId: "second", token: 2 };
    rerender();

    expect(result.current.selectedInsight).toBe("analysis");
    expect(document.activeElement).toBe(second.row);
    expect(second.scrollOptions).toEqual([{ block: "center" }]);
  });
});
