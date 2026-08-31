// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useInsightResultEntrance } from "../../src/renderer/src/hooks/use-insight-result-entrance";

type InputPatch = Omit<Partial<HookInput>, "retainedRunIds"> & {
  readonly retainedRunIds?: Partial<HookInput["retainedRunIds"]>;
};
type HookInput = Parameters<typeof useInsightResultEntrance>[0];

const initialInput: HookInput = {
  retainedRunIds: {
    analysis: "analysis-1",
    brief: "brief-1",
    walkthrough: "walkthrough-1",
  },
  selectedInsight: "analysis",
  selectedProjectionStatus: "current",
};

let nextFrame = 1;
let frames = new Map<number, FrameRequestCallback>();

function runFrame(frame: number): void {
  const callback = frames.get(frame);
  if (callback === undefined) throw new Error(`Unknown frame ${frame}`);
  frames.delete(frame);
  callback(0);
}

function nextInput(patch: InputPatch): HookInput {
  return {
    ...initialInput,
    ...patch,
    retainedRunIds: {
      ...initialInput.retainedRunIds,
      ...patch.retainedRunIds,
    },
  };
}

function attachResultWrapper(
  ref: ReturnType<typeof useInsightResultEntrance>,
): HTMLDivElement {
  const wrapper = document.createElement("div");
  ref.current = wrapper;
  return wrapper;
}

beforeEach(() => {
  nextFrame = 1;
  frames = new Map();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const frame = nextFrame;
    nextFrame += 1;
    frames.set(frame, callback);
    return frame;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frame) => {
    frames.delete(frame);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useInsightResultEntrance", () => {
  it("does not enter an initially retained result", () => {
    const { result } = renderHook(() => useInsightResultEntrance(initialInput));
    const wrapper = attachResultWrapper(result.current);

    expect(wrapper.hasAttribute("data-insight-result-entering")).toBe(false);
    expect(frames.size).toBe(0);
  });

  it("enters a selected replacement when its projection becomes current", () => {
    const { result, rerender } = renderHook(
      ({ input }) => useInsightResultEntrance(input),
      {
        initialProps: {
          input: nextInput({ selectedProjectionStatus: "running" }),
        },
      },
    );
    const wrapper = attachResultWrapper(result.current);

    rerender({
      input: nextInput({
        retainedRunIds: { analysis: "analysis-2" },
        selectedProjectionStatus: "current",
      }),
    });

    expect(wrapper.hasAttribute("data-insight-result-entering")).toBe(true);
    expect(frames.size).toBe(1);

    act(() => runFrame(1));

    expect(wrapper.hasAttribute("data-insight-result-entering")).toBe(false);
  });

  it("records background completions without replaying them after tab selection", () => {
    const { result, rerender } = renderHook(
      ({ input }) => useInsightResultEntrance(input),
      { initialProps: { input: initialInput } },
    );
    const wrapper = attachResultWrapper(result.current);

    rerender({
      input: nextInput({ retainedRunIds: { walkthrough: "walkthrough-2" } }),
    });
    expect(wrapper.hasAttribute("data-insight-result-entering")).toBe(false);
    expect(frames.size).toBe(0);

    rerender({
      input: nextInput({
        retainedRunIds: { walkthrough: "walkthrough-2" },
        selectedInsight: "walkthrough",
      }),
    });
    expect(wrapper.hasAttribute("data-insight-result-entering")).toBe(false);
    expect(frames.size).toBe(0);
  });

  it("does not replay on tab switches or unrelated rerenders", () => {
    const { result, rerender } = renderHook(
      ({ input }) => useInsightResultEntrance(input),
      { initialProps: { input: initialInput } },
    );
    const wrapper = attachResultWrapper(result.current);

    rerender({ input: nextInput({ selectedInsight: "brief" }) });
    rerender({ input: initialInput });
    rerender({ input: initialInput });

    expect(wrapper.hasAttribute("data-insight-result-entering")).toBe(false);
    expect(frames.size).toBe(0);
  });

  it("cancels an entrance frame when unmounted", () => {
    const { result, rerender, unmount } = renderHook(
      ({ input }) => useInsightResultEntrance(input),
      {
        initialProps: {
          input: nextInput({ selectedProjectionStatus: "running" }),
        },
      },
    );
    const wrapper = attachResultWrapper(result.current);

    rerender({
      input: nextInput({
        retainedRunIds: { analysis: "analysis-2" },
        selectedProjectionStatus: "current",
      }),
    });
    unmount();

    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(wrapper.hasAttribute("data-insight-result-entering")).toBe(false);
  });
});
