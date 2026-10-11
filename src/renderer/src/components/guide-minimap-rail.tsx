import type { RefObject } from "react";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { PopoverTrigger } from "./ui/popover";

/** Ordinal targets stay equally spaced regardless of expanded file height. */
export function GuideMinimapRail({
  groups,
  currentIndex,
  activeIndex,
  label,
  triggerId,
  height,
  railHeight,
  rail,
  scroller,
  onPreview,
  onSelect,
  onFocus,
  onFocusActions,
}: {
  readonly groups: ReadonlyArray<{
    readonly id: string;
    readonly reviewed?: boolean;
  }>;
  readonly currentIndex: number;
  readonly activeIndex: number | null;
  readonly label: string;
  readonly triggerId: string;
  readonly height: number;
  readonly railHeight: number;
  readonly rail: RefObject<HTMLButtonElement | null>;
  readonly scroller: RefObject<HTMLDivElement | null>;
  readonly onPreview: (index: number, keyboard?: boolean) => void;
  readonly onSelect: (index: number) => void;
  readonly onFocus: () => void;
  readonly onFocusActions: () => void;
}): React.JSX.Element {
  const pointerIndex = (pointerY: number, element: HTMLElement): number => {
    const bounds = element.getBoundingClientRect();
    const progress =
      bounds.height <= 0
        ? 0
        : Math.max(0, Math.min(1, (pointerY - bounds.top) / bounds.height));
    return Math.round(progress * (groups.length - 1));
  };
  return (
    <div className="hidden h-full min-h-0 flex-col items-center gap-2 @min-[48rem]:flex">
      <span className="text-[10px] font-medium text-muted-foreground">
        Groups
      </span>
      <span className="font-mono text-xs tabular-nums">
        {currentIndex + 1}/{groups.length}
      </span>
      <Button
        size="xs"
        variant="ghost"
        aria-label="Previous Guide group"
        disabled={currentIndex === 0}
        onClick={() => onSelect(currentIndex - 1)}
      >
        <ChevronUp aria-hidden="true" />
      </Button>
      <div
        ref={scroller}
        className="min-h-0 overflow-y-auto overflow-x-hidden p-1"
        style={{ maxHeight: Math.max(64, height - 140) }}
      >
        <div className="relative w-10" style={{ height: railHeight }}>
          <PopoverTrigger
            id={triggerId}
            openOnHover
            delay={0}
            closeDelay={100}
            render={<button ref={rail} type="button" />}
            aria-label={label}
            className="absolute inset-0 cursor-pointer rounded focus-visible:outline focus-visible:outline-ring"
            onFocus={onFocus}
            onMouseMove={(event) =>
              onPreview(pointerIndex(event.clientY, event.currentTarget))
            }
            onClick={(event) =>
              onSelect(pointerIndex(event.clientY, event.currentTarget))
            }
            onKeyDown={(event) => {
              if (
                event.altKey ||
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey
              )
                return;
              const index = activeIndex ?? currentIndex;
              switch (event.key) {
                case "Tab":
                  if (activeIndex !== null) {
                    event.preventDefault();
                    onFocusActions();
                  }
                  break;
                case "ArrowDown":
                  event.preventDefault();
                  onPreview(Math.min(groups.length - 1, index + 1), true);
                  break;
                case "ArrowUp":
                  event.preventDefault();
                  onPreview(Math.max(0, index - 1), true);
                  break;
                case "Home":
                  event.preventDefault();
                  onPreview(0, true);
                  break;
                case "End":
                  event.preventDefault();
                  onPreview(groups.length - 1, true);
                  break;
                case "Enter":
                case " ":
                  event.preventDefault();
                  onSelect(index);
                  break;
              }
            }}
          >
            {groups.map((group, index) => {
              const distance =
                activeIndex === null ? Infinity : Math.abs(index - activeIndex);
              return (
                <span
                  key={group.id}
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none absolute left-1 h-0.5 w-6 origin-left rounded-full transition-transform",
                    index === currentIndex
                      ? "bg-foreground"
                      : group.reviewed
                        ? "bg-status-success"
                        : "bg-muted-foreground/40",
                  )}
                  style={{
                    top: `${groups.length === 1 ? 0 : (index / (groups.length - 1)) * 100}%`,
                    transform: "translateY(-50%)",
                    width:
                      distance === 0
                        ? 24
                        : distance === 1
                          ? 16
                          : distance === 2
                            ? 10
                            : 8,
                  }}
                >
                  {group.reviewed ? (
                    <Check className="absolute -left-1 -top-1 size-2.5 text-status-success" />
                  ) : null}
                  {index === currentIndex ? (
                    <span className="absolute -right-2 -top-0.5 size-1.5 rounded-full bg-foreground" />
                  ) : null}
                </span>
              );
            })}
          </PopoverTrigger>
        </div>
      </div>
      <Button
        size="xs"
        variant="ghost"
        aria-label="Next Guide group"
        disabled={currentIndex >= groups.length - 1}
        onClick={() => onSelect(currentIndex + 1)}
      >
        <ChevronDown aria-hidden="true" />
      </Button>
    </div>
  );
}
