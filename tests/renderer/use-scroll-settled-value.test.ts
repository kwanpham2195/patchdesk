// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useScrollSettledValue } from "../../src/renderer/src/hooks/use-scroll-settled-value";

const SETTLE_DELAY_MS = 200;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useScrollSettledValue", () => {
  it("passes the initial value through immediately at mount", () => {
    const { result } = renderHook(() => useScrollSettledValue(1));
    expect(result.current.settledValue).toBe(1);
  });

  it("updates immediately on a live value change with no scroll in flight", () => {
    const { result, rerender } = renderHook(
      ({ liveValue }) => useScrollSettledValue(liveValue),
      { initialProps: { liveValue: 1 } },
    );
    expect(result.current.settledValue).toBe(1);

    rerender({ liveValue: 2 });
    expect(result.current.settledValue).toBe(2);
  });

  it("holds back a live value change while a scroll is in flight", () => {
    const { result, rerender } = renderHook(
      ({ liveValue }) => useScrollSettledValue(liveValue),
      { initialProps: { liveValue: 1 } },
    );

    act(() => {
      result.current.notifyScroll();
    });
    rerender({ liveValue: 2 });

    expect(result.current.settledValue).toBe(1);
  });

  it("catches up to the latest live value after the settle delay, dropping no update", () => {
    const { result, rerender } = renderHook(
      ({ liveValue }) => useScrollSettledValue(liveValue),
      { initialProps: { liveValue: 1 } },
    );

    act(() => {
      result.current.notifyScroll();
    });
    rerender({ liveValue: 2 });
    rerender({ liveValue: 3 });
    expect(result.current.settledValue).toBe(1);

    act(() => {
      vi.advanceTimersByTime(SETTLE_DELAY_MS);
    });

    expect(result.current.settledValue).toBe(3);
  });

  it("resets the debounce on repeated notifyScroll calls instead of accumulating it", () => {
    const { result, rerender } = renderHook(
      ({ liveValue }) => useScrollSettledValue(liveValue),
      { initialProps: { liveValue: 1 } },
    );

    act(() => {
      result.current.notifyScroll();
    });
    rerender({ liveValue: 2 });

    // Advance partway, then notify again before the timer fires -- each
    // call should reset the debounce, not let it accumulate toward firing.
    act(() => {
      vi.advanceTimersByTime(150);
    });
    act(() => {
      result.current.notifyScroll();
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });

    // Total elapsed (300ms) exceeds the 200ms delay, but no single gap
    // between notifyScroll calls did -- the value must still be held back.
    expect(result.current.settledValue).toBe(1);

    act(() => {
      vi.advanceTimersByTime(SETTLE_DELAY_MS);
    });

    expect(result.current.settledValue).toBe(2);
  });

  it("clears its pending timer on unmount without throwing", () => {
    const { result, unmount } = renderHook(() => useScrollSettledValue(1));

    act(() => {
      result.current.notifyScroll();
    });

    expect(() => {
      unmount();
      vi.advanceTimersByTime(SETTLE_DELAY_MS * 2);
    }).not.toThrow();
  });
});
