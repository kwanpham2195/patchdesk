// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useInsightSelection } from "../../src/renderer/src/hooks/use-insight-selection";

afterEach(() => {
  cleanup();
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
});
