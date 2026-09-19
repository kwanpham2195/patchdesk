// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReviewNavigatorResizeHandle } from "../../src/renderer/src/components/review-navigator-resize-handle";

let nextFrame = 1;
let frames = new Map<number, FrameRequestCallback>();

function runFrames(): void {
  const pending = [...frames.entries()];
  frames = new Map();
  for (const [, callback] of pending) callback(0);
}

function renderHandle() {
  const onResize = vi.fn();
  const onResizeEnd = vi.fn();
  render(
    <ReviewNavigatorResizeHandle
      widthRem={18}
      onResize={onResize}
      onResizeEnd={onResizeEnd}
    />,
  );
  const handle = screen.getByRole("separator", {
    name: "Resize review navigator",
  });
  // jsdom implements neither capture method, and the handle takes the pointer
  // on pointerdown so a drag survives leaving the two-pixel hit area.
  handle.setPointerCapture = () => undefined;
  handle.releasePointerCapture = () => undefined;
  return { handle, onResize, onResizeEnd };
}

beforeEach(() => {
  nextFrame = 1;
  frames = new Map();
  // oxlint-disable-next-line patchdesk/no-method-spying -- the handle schedules through `window.requestAnimationFrame` with no frame-scheduler seam, so the spy holds each frame for the test to run by hand.
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const frame = nextFrame;
    nextFrame += 1;
    frames.set(frame, callback);
    return frame;
  });
  // oxlint-disable-next-line patchdesk/no-method-spying -- the handle cancels through `window.cancelAnimationFrame` with no frame-scheduler seam, so the spy drops the held frame the test would otherwise run.
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frame) => {
    frames.delete(frame);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ReviewNavigatorResizeHandle", () => {
  it("reports one width per frame, at the latest pointer position", () => {
    const { handle, onResize } = renderHandle();

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 116 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 132 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 148 });

    expect(onResize).not.toHaveBeenCalled();

    runFrames();

    expect(onResize.mock.calls).toEqual([[21]]);
  });

  it("settles on the width the drag ended at, without replaying the owed frame", () => {
    const { handle, onResize, onResizeEnd } = renderHandle();

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 116 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 164 });

    expect(onResizeEnd.mock.calls).toEqual([[22]]);

    runFrames();

    expect(onResize).not.toHaveBeenCalled();
    expect(onResizeEnd.mock.calls).toEqual([[22]]);
  });

  it("reports a keyboard step without waiting for a frame", () => {
    const { handle, onResize } = renderHandle();

    fireEvent.keyDown(handle, { key: "ArrowRight" });

    expect(onResize.mock.calls).toEqual([[19]]);
  });

  it("owes nothing once unmounted mid-drag", () => {
    const { handle, onResize } = renderHandle();

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 116 });
    cleanup();
    runFrames();

    expect(onResize).not.toHaveBeenCalled();
  });
});
