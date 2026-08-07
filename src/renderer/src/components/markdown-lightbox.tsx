import { useCallback, useEffect, useState } from "react";
import { Minus, Plus, Maximize2, X } from "lucide-react";
import { Button } from "./ui/button";

const MIN_SCALE = 0.25;
const MAX_SCALE = 4.0;
const SCALE_STEP = 0.25;

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

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setScale(1);
      setFitToScreen(true);
    }
  }, [open]);

  const zoomIn = useCallback(
    () => setScale((s) => Math.min(s + SCALE_STEP, MAX_SCALE)),
    [],
  );
  const zoomOut = useCallback(
    () => setScale((s) => Math.max(s - SCALE_STEP, MIN_SCALE)),
    [],
  );
  const toggleFit = useCallback(() => setFitToScreen((f) => !f), []);
  const reset = useCallback(() => {
    setScale(1);
    setFitToScreen(true);
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
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80"
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
        className="flex max-h-[90vh] max-w-[90vw] items-center justify-center overflow-auto"
        style={
          fitToScreen
            ? undefined
            : {
                transform: `scale(${scale})`,
                transformOrigin: "center center",
              }
        }
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Convenience hook: manages open/close state and the lightbox element.
 */
export function useLightbox(): {
  readonly lightbox: () => React.JSX.Element;
  readonly open: (content: React.ReactNode) => void;
  readonly close: () => void;
} {
  const [isOpen, setIsOpen] = useState(false);
  const [content, setContent] = useState<React.ReactNode>(null);

  const close = useCallback(() => setIsOpen(false), []);
  const open = useCallback((c: React.ReactNode) => {
    setContent(c);
    setIsOpen(true);
  }, []);

  const lightbox = useCallback(
    () => (
      <MarkdownLightbox open={isOpen} onClose={close}>
        {content}
      </MarkdownLightbox>
    ),
    [isOpen, close, content],
  );

  return { lightbox, open, close };
}
