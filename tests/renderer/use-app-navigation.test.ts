// @vitest-environment jsdom

import {
  act,
  cleanup,
  renderHook,
  type RenderHookResult,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  useAppNavigation,
  type AppNavigation,
} from "../../src/renderer/src/hooks/use-app-navigation";
import type { WorkbenchPayload } from "../../src/renderer/src/renderer-models";
import { projection } from "./review-workbench-fixtures";

type NavigationHook = RenderHookResult<AppNavigation, unknown>["result"];

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

/** Mirrors `openWorkbench` in `app.tsx`: hold the payload, then route to it. */
function openWorkbench(
  result: NavigationHook,
  payload: WorkbenchPayload,
): void {
  act(() => {
    result.current.setWorkbench(payload);
    result.current.performNavigation({
      kind: "workbench",
      reviewId: payload.review.id,
    });
  });
}

describe("useAppNavigation", () => {
  it("drops the held Review when routing from one workbench to another", () => {
    const { result } = renderHook(() => useAppNavigation());
    openWorkbench(result, projection({ review: { id: "a", status: "open" } }));

    act(() => {
      result.current.performNavigation({ kind: "workbench", reviewId: "b" });
    });

    expect(result.current.workbench).toBeUndefined();
    expect(result.current.destination).toEqual({
      kind: "workbench",
      reviewId: "b",
    });
  });

  it("keeps the held Review when routing to the workbench already open", () => {
    const { result } = renderHook(() => useAppNavigation());
    const payload = projection({ review: { id: "a", status: "open" } });
    openWorkbench(result, payload);

    act(() => {
      result.current.performNavigation({ kind: "workbench", reviewId: "a" });
    });

    expect(result.current.workbench).toBe(payload);
  });

  it("drops the held Review when leaving the workbench", () => {
    const { result } = renderHook(() => useAppNavigation());
    openWorkbench(result, projection({ review: { id: "a", status: "open" } }));

    act(() => {
      result.current.performNavigation({ kind: "dashboard" });
    });

    expect(result.current.workbench).toBeUndefined();
  });

  it("treats the destination restored at mount as the boot restore until the first navigation", () => {
    window.localStorage.setItem("patchdesk.destination", "workbench:a");
    const { result } = renderHook(() => useAppNavigation());
    expect(result.current.destination).toEqual({
      kind: "workbench",
      reviewId: "a",
    });
    expect(result.current.bootRestoredDestination).toBe(true);

    act(() => {
      result.current.performNavigation({ kind: "dashboard" });
    });

    expect(result.current.bootRestoredDestination).toBe(false);
  });

  it("drops the held Review when the leave-confirmation is discarded", () => {
    const { result } = renderHook(() => useAppNavigation());
    openWorkbench(result, projection({ review: { id: "a", status: "open" } }));

    act(() => {
      result.current.setNavigationState("dirty_draft");
    });
    act(() => {
      result.current.navigate({ kind: "workbench", reviewId: "b" });
    });
    expect(result.current.workbench).not.toBeUndefined();

    // The discard button in `app.tsx` performs the parked destination itself.
    act(() => {
      const pending = result.current.pendingDestination;
      if (pending !== undefined) result.current.performNavigation(pending);
      result.current.setNavigationState("clear");
      result.current.setPendingDestination(undefined);
    });

    expect(result.current.workbench).toBeUndefined();
    expect(result.current.destination).toEqual({
      kind: "workbench",
      reviewId: "b",
    });
  });
});
