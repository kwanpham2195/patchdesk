import {
  useCallback,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import {
  DEFAULT_NAVIGATOR_WIDTH_REM,
  MAX_NAVIGATOR_WIDTH_REM,
  MIN_NAVIGATOR_WIDTH_REM,
} from "../navigator-width-preferences";

const KEYBOARD_STEP_REM = 1;

type DragStart = {
  readonly pointerId: number;
  readonly clientX: number;
  readonly widthRem: number;
};

type ReviewNavigatorResizeHandleProps = {
  readonly widthRem: number;
  /** Fired continuously while dragging or on every keyboard step; not persisted. */
  readonly onResize: (widthRem: number) => void;
  /** Fired once the width settles (pointer up, keyboard step, or double-click reset); persist here. */
  readonly onResizeEnd: (widthRem: number) => void;
};

function clampWidth(widthRem: number): number {
  return Math.min(
    MAX_NAVIGATOR_WIDTH_REM,
    Math.max(MIN_NAVIGATOR_WIDTH_REM, widthRem),
  );
}

function rootFontSizePx(): number {
  if (globalThis.window === undefined) return 16;
  const parsed = Number.parseFloat(
    window.getComputedStyle(document.documentElement).fontSize,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 16;
}

// `aria-valuenow` alone announces a bare number ("18"), which is
// meaningless to a screen reader user: rem is a developer unit, not one a
// person can act on. `aria-valuetext` overrides that announcement with the
// pane's position within its allowed range instead.
function widthValueText(widthRem: number): string {
  const percent = Math.round(
    ((widthRem - MIN_NAVIGATOR_WIDTH_REM) /
      (MAX_NAVIGATOR_WIDTH_REM - MIN_NAVIGATOR_WIDTH_REM)) *
      100,
  );
  return `${percent}% of the allowed width`;
}

/**
 * Drag or keyboard handle for the review navigator pane's right edge. The
 * navigator's own row label truncation (`@pierre/trees`, hardcoded to
 * `split: "extension"`) can't distinguish files that share an extension, so
 * this lets the user widen the pane instead of fighting the truncation.
 */
export function ReviewNavigatorResizeHandle({
  widthRem,
  onResize,
  onResizeEnd,
}: ReviewNavigatorResizeHandleProps): React.JSX.Element {
  const dragStart = useRef<DragStart | null>(null);

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      dragStart.current = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        widthRem,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [widthRem],
  );

  const widthFromDrag = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const start = dragStart.current;
    if (start === null || start.pointerId !== event.pointerId) return undefined;
    const deltaRem = (event.clientX - start.clientX) / rootFontSizePx();
    return clampWidth(start.widthRem + deltaRem);
  }, []);

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const next = widthFromDrag(event);
      if (next !== undefined) onResize(next);
    },
    [onResize, widthFromDrag],
  );

  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const next = widthFromDrag(event);
      dragStart.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      if (next !== undefined) onResizeEnd(next);
    },
    [onResizeEnd, widthFromDrag],
  );

  // The browser can steal pointer capture mid-drag (a system gesture, an
  // alt-tab, a touch interaction interrupted by scrolling) without ever
  // firing pointerup. Without this, dragStart stays populated forever: the
  // next unrelated pointermove over the handle would silently resume
  // resizing from a stale start position.
  const handlePointerCancel = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const next = widthFromDrag(event);
      dragStart.current = null;
      if (next !== undefined) onResizeEnd(next);
    },
    [onResizeEnd, widthFromDrag],
  );

  // Arrow keys repeat at roughly 30/sec while held, so persisting on every
  // keydown would fire that many synchronous localStorage writes a second.
  // Arrow keys only update the live width here; handleKeyUp persists once
  // the key is released. Home/End are single jumps, not repeatable holds,
  // so they persist immediately.
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onResize(clampWidth(widthRem - KEYBOARD_STEP_REM));
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        onResize(clampWidth(widthRem + KEYBOARD_STEP_REM));
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        onResize(MIN_NAVIGATOR_WIDTH_REM);
        onResizeEnd(MIN_NAVIGATOR_WIDTH_REM);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        onResize(MAX_NAVIGATOR_WIDTH_REM);
        onResizeEnd(MAX_NAVIGATOR_WIDTH_REM);
      }
    },
    [onResize, onResizeEnd, widthRem],
  );

  const handleKeyUp = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      onResizeEnd(widthRem);
    },
    [onResizeEnd, widthRem],
  );

  const handleDoubleClick = useCallback(() => {
    onResize(DEFAULT_NAVIGATOR_WIDTH_REM);
    onResizeEnd(DEFAULT_NAVIGATOR_WIDTH_REM);
  }, [onResize, onResizeEnd]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize review navigator"
      aria-valuenow={Math.round(widthRem)}
      aria-valuemin={MIN_NAVIGATOR_WIDTH_REM}
      aria-valuemax={MAX_NAVIGATOR_WIDTH_REM}
      aria-valuetext={widthValueText(widthRem)}
      tabIndex={0}
      data-review-navigator-resize-handle
      className="group relative hidden h-full w-3 shrink-0 cursor-col-resize touch-none items-center justify-center outline-none select-none min-[1100px]:flex"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onDoubleClick={handleDoubleClick}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-ring group-focus-visible:bg-ring"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full opacity-0 ring-2 ring-ring/60 transition-opacity group-focus-visible:opacity-100"
      />
    </div>
  );
}
