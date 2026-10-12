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
  readonly onFocusActions: () => boolean;
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
    <div className="group/guide-minimap hidden h-full min-h-0 flex-col items-center justify-center gap-2 @min-[48rem]:flex">
      <span className="sr-only">Groups</span>
      <span className="sr-only">
        {currentIndex + 1}/{groups.length}
      </span>
      <Button
        size="xs"
        variant="ghost"
        className={cn(
          "opacity-0 transition-opacity duration-150 group-hover/guide-minimap:opacity-100 group-focus-within/guide-minimap:opacity-100",
          activeIndex !== null && "opacity-100",
        )}
        aria-label="Previous Guide group"
        disabled={currentIndex === 0}
        onClick={() => onSelect(currentIndex - 1)}
      >
        <ChevronUp aria-hidden="true" />
      </Button>
      <div
        ref={scroller}
        className="min-h-0 overflow-y-auto overflow-x-hidden p-1"
        style={{ maxHeight: Math.max(64, height - 64) }}
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
                  if (activeIndex !== null && onFocusActions()) {
                    event.preventDefault();
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
                  className="pointer-events-none absolute left-1 h-0.5 w-6 -translate-y-1/2"
                  style={{
                    top: `${groups.length === 1 ? 0 : (index / (groups.length - 1)) * 100}%`,
                  }}
                >
                  <span
                    data-guide-minimap-strip={group.id}
                    className={cn(
                      "block h-full w-full origin-left rounded-full bg-muted-foreground/40 transition-transform duration-150 ease-out",
                      distance === 0
                        ? "scale-x-100"
                        : distance === 1
                          ? "scale-x-[0.667]"
                          : distance === 2
                            ? "scale-x-[0.417]"
                            : "scale-x-[0.333]",
                    )}
                  >
                    <span
                      className={cn(
                        "absolute inset-0 rounded-full transition-opacity duration-150",
                        index === currentIndex
                          ? "bg-foreground opacity-100"
                          : group.reviewed
                            ? "bg-status-success opacity-100"
                            : "bg-foreground opacity-0",
                      )}
                    />
                  </span>
                  {group.reviewed ? (
                    <Check className="absolute -left-1 -top-1 size-2.5 text-status-success" />
                  ) : null}
                  {index === currentIndex ? (
                    <span
                      className="absolute left-2.5 -top-0.5 size-1.5 rounded-full bg-foreground transition-transform duration-150 ease-out"
                      style={{
                        transform: `translateX(${distance === 0 ? 16 : distance === 1 ? 8 : distance === 2 ? 2 : 0}px)`,
                      }}
                    />
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
        className={cn(
          "opacity-0 transition-opacity duration-150 group-hover/guide-minimap:opacity-100 group-focus-within/guide-minimap:opacity-100",
          activeIndex !== null && "opacity-100",
        )}
        aria-label="Next Guide group"
        disabled={currentIndex >= groups.length - 1}
        onClick={() => onSelect(currentIndex + 1)}
      >
        <ChevronDown aria-hidden="true" />
      </Button>
    </div>
  );
}
