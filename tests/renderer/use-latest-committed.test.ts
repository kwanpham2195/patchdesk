// @vitest-environment jsdom
import { StrictMode } from "react";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useLatestCommitted } from "../../src/renderer/src/hooks/use-latest-committed";

describe("useLatestCommitted", () => {
  it("keeps one ref identity and updates it after committed rerenders", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useLatestCommitted(value),
      {
        initialProps: { value: "first" },
        wrapper: StrictMode,
      },
    );
    const initialRef = result.current;

    expect(initialRef.current).toBe("first");
    rerender({ value: "second" });

    expect(result.current).toBe(initialRef);
    expect(result.current.current).toBe("second");
  });

  it("does not expose a value from a render that never commits", () => {
    let committedRef: { current: string } | undefined;
    let failRender = false;
    const { rerender } = renderHook(
      ({ value }) => {
        committedRef = useLatestCommitted(value);
        if (failRender) throw new Error("aborted render");
        return committedRef;
      },
      {
        initialProps: { value: "committed" },
        wrapper: StrictMode,
      },
    );

    failRender = true;
    expect(() => rerender({ value: "aborted" })).toThrow("aborted render");
    expect(committedRef?.current).toBe("committed");
  });
});
