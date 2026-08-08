import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { Minus, Plus, Maximize2, X } from "lucide-react";
import { Button } from "./ui/button";

const MIN_SCALE = 0.25;
const MAX_SCALE = 4.0;
const SCALE_STEP = 0.25;

type PanStart = {
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly scrollLeft: number;
  readonly scrollTop: number;
};

export function MarkdownLightbox({
  open,
  onClose,
  children,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
}): React.JSX.Element | null {
  const [scale, setScale] = useState(1);
  const [fitToScreen, setFitToScreen] = useState(true);
  const viewportRef = useRef<HTMLDivElement>(null);
  const panStartRef = useRef<PanStart | undefined>(undefined);

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setScale(1);
      setFitToScreen(true);
    }
  }, [open]);

  const zoomIn = useCallback(() => {
    setFitToScreen(false);
    setScale((s) => Math.min(s + SCALE_STEP, MAX_SCALE));
  }, []);
  const zoomOut = useCallback(() => {
    setFitToScreen(false);
    setScale((s) => Math.max(s - SCALE_STEP, MIN_SCALE));
  }, []);
  const toggleFit = useCallback(() => setFitToScreen((f) => !f), []);
  const reset = useCallback(() => {
    setScale(1);
    setFitToScreen(true);
  }, []);
  const startPan = useCallback((event: PointerEvent<HTMLDivElement>): void => {
    if (fitToScreen || scale <= 1) return;
    const viewport = viewportRef.current;
    if (viewport === null) return;
    panStartRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
    };
    viewport.setPointerCapture?.(event.pointerId);
  }, [fitToScreen, scale]);
  const pan = useCallback((event: PointerEvent<HTMLDivElement>): void => {
    const start = panStartRef.current;
    const viewport = viewportRef.current;
    if (start === undefined || viewport === null || start.pointerId !== event.pointerId) return;
    viewport.scrollLeft = start.scrollLeft - (event.clientX - start.clientX);
    viewport.scrollTop = start.scrollTop - (event.clientY - start.clientY);
  }, []);
  const stopPan = useCallback((event: PointerEvent<HTMLDivElement>): void => {
    const start = panStartRef.current;
    if (start?.pointerId !== event.pointerId) return;
    panStartRef.current = undefined;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key === "+" || event.key === "=") {
        zoomIn();
        return;
      }
      if (event.key === "-") {
        zoomOut();
        return;
      }
      if (event.key === "0") {
        reset();
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose, zoomIn, zoomOut, reset]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="Image viewer"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/98 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {/* Toolbar */}
      <div className="absolute top-3 right-3 z-10 flex items-center gap-1">
        <Button
          size="icon-sm"
          variant="ghost"
          className="text-white hover:bg-white/10"
          onClick={zoomOut}
          aria-label="Zoom out"
          disabled={scale <= MIN_SCALE}
        >
          <Minus />
        </Button>
        <span className="min-w-[3.5rem] text-center text-xs text-white tabular-nums">
          {Math.round(scale * 100)}%
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          className="text-white hover:bg-white/10"
          onClick={zoomIn}
          aria-label="Zoom in"
          disabled={scale >= MAX_SCALE}
        >
          <Plus />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          className="text-white hover:bg-white/10"
          onClick={toggleFit}
          aria-label={fitToScreen ? "Actual size" : "Fit to screen"}
        >
          <Maximize2 className={fitToScreen ? "opacity-100" : "opacity-50"} />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          className="text-white hover:bg-white/10"
          onClick={onClose}
          aria-label="Close"
        >
          <X />
        </Button>
      </div>

      {/* Content */}
      <div
        ref={viewportRef}
        role="region"
        aria-label="Zoomable content"
        className={
          fitToScreen
            ? "flex max-h-[90vh] max-w-[90vw] items-center justify-center overflow-auto"
            : "h-[90vh] w-[90vw] cursor-grab overflow-auto touch-none active:cursor-grabbing"
        }
        onPointerDown={startPan}
        onPointerMove={pan}
        onPointerUp={stopPan}
        onPointerCancel={stopPan}
      >
        <div className={fitToScreen ? undefined : "w-max"} style={fitToScreen ? undefined : { zoom: scale }}>
          {children}
        </div>
      </div>
    </div>
  );
}
