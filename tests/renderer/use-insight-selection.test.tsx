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
import {
  briefInsight,
  projection,
  withAnalysis,
} from "./review-workbench-fixtures";

afterEach(() => {
  cleanup();
  document.getElementById(analysisFindingRowId("first"))?.remove();
  document.getElementById(analysisFindingRowId("second"))?.remove();
});

describe("useInsightSelection", () => {
  const analysisOnly = withAnalysis("actionable").insights;
  it.each([
    {
      name: "lands on Brief when no Insight has a result",
      initialDetail: undefined,
      insights: projection().insights,
      expected: "brief",
    },
    {
      name: "lands on Analysis when it is the only Insight with a result",
      initialDetail: undefined,
      insights: analysisOnly,
      expected: "analysis",
    },
    {
      name: "lands on Brief when Brief and Analysis both have results",
      initialDetail: undefined,
      insights: { ...analysisOnly, brief: briefInsight() },
      expected: "brief",
    },
    {
      name: "lets a restored detail win over an Insight with a result",
      initialDetail: "walkthrough",
      insights: analysisOnly,
      expected: "walkthrough",
    },
  ] as const)("$name", ({ initialDetail, insights, expected }) => {
    const { result } = renderHook(() =>
      useInsightSelection(initialDetail, insights),
    );

    expect(result.current.selectedInsight).toBe(expected);
  });

  it("returns from the Diff to the reader the reviewer left, over a restored detail, and records each new choice", () => {
    const remembered: Array<string> = [];
    const wrapper = ({ children }: PropsWithChildren) => (
      <ReviewWorkbenchFindingNavigationContext.Provider
        value={{
          openFindingInDiff: () => undefined,
          openFileInDiff: () => undefined,
          findingFocusRequest: undefined,
          lastInsight: "brief",
          rememberInsight: (insight) => remembered.push(insight),
        }}
      >
        {children}
      </ReviewWorkbenchFindingNavigationContext.Provider>
    );
    const { result } = renderHook(
      () => useInsightSelection("walkthrough", analysisOnly),
      { wrapper },
    );

    expect(result.current.selectedInsight).toBe("brief");

    act(() => result.current.setSelectedInsight("analysis"));

    expect(remembered.at(-1)).toBe("analysis");
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
          openFileInDiff: () => undefined,
          findingFocusRequest: request,
          lastInsight: undefined,
          rememberInsight: () => undefined,
        }}
      >
        {children}
      </ReviewWorkbenchFindingNavigationContext.Provider>
    );
    const { result, rerender } = renderHook(
      () => useInsightSelection(undefined, projection().insights),
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
