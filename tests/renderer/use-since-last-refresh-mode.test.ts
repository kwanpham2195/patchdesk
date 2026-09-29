// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useSinceLastRefreshMode } from "../../src/renderer/src/hooks/use-since-last-refresh-mode";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import type { SinceLastRefreshDiffResponse } from "../../src/renderer/src/review-diff-contracts";
import { projection } from "./review-workbench-fixtures";

function model(
  sinceLastRefresh: WorkbenchResponse["sinceLastRefresh"],
): Pick<WorkbenchResponse, "session" | "sinceLastRefresh"> {
  const { session } = projection();
  return sinceLastRefresh === undefined
    ? { session }
    : { session, sinceLastRefresh };
}

describe("useSinceLastRefreshMode", () => {
  it.each([
    { availability: undefined, offered: false, disabled: false },
    { availability: "none", offered: true, disabled: true },
    { availability: "base_moved", offered: true, disabled: true },
    { availability: "available", offered: true, disabled: false },
  ] as const)(
    "offers the option when the session's round is $availability",
    ({ availability, offered, disabled }) => {
      const { result } = renderHook(() =>
        useSinceLastRefreshMode({
          model: model(availability),
          commitSliceActive: false,
          loadSinceLastRefreshDiff: vi.fn(),
          selectPatchView: vi.fn(),
        }),
      );

      expect(result.current.control !== undefined).toBe(offered);
      expect(result.current.control?.disabledReason !== undefined).toBe(
        disabled,
      );
    },
  );

  it("shows Combined and loads the patch of the session on screen when turned on", async () => {
    const load = vi.fn(
      async (sessionId: string): Promise<SinceLastRefreshDiffResponse> => ({
        sessionId,
        patch: "round",
      }),
    );
    const selectPatchView = vi.fn();
    const { result } = renderHook(() =>
      useSinceLastRefreshMode({
        model: model("available"),
        commitSliceActive: false,
        loadSinceLastRefreshDiff: load,
        selectPatchView,
      }),
    );

    act(() => result.current.control?.onChange(true));

    await waitFor(() =>
      expect(result.current.state).toEqual({ _tag: "Ready", patch: "round" }),
    );
    expect(selectPatchView).toHaveBeenCalledWith("combined");
    expect(load).toHaveBeenCalledWith("session-a");
  });

  it("fails a response for another session", async () => {
    const { result } = renderHook(() =>
      useSinceLastRefreshMode({
        model: model("available"),
        commitSliceActive: false,
        loadSinceLastRefreshDiff: async () => ({
          sessionId: "session-b",
          patch: "stale",
        }),
        selectPatchView: vi.fn(),
      }),
    );

    act(() => result.current.control?.onChange(true));

    await waitFor(() =>
      expect(result.current.state).toEqual({ _tag: "Failed" }),
    );
  });
});
