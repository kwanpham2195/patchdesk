// PROTOTYPE — issue #119, throwaway. Do not build on this.
import { useEffect } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { isTextEntryTarget } from "../../text-entry-target";

export type PrototypeVariantEntry = {
  readonly id: string;
  readonly label: string;
};

export function SidebarPrototypeSwitcher({
  variants,
  activeId,
  onSelect,
}: {
  readonly variants: ReadonlyArray<PrototypeVariantEntry>;
  readonly activeId: string;
  readonly onSelect: (id: string) => void;
}): React.JSX.Element {
  const index = Math.max(
    0,
    variants.findIndex((variant) => variant.id === activeId),
  );
  const active = variants[index];
  const cycle = (delta: number): void => {
    const next = variants[(index + delta + variants.length) % variants.length];
    onSelect(next?.id ?? activeId);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (isTextEntryTarget(event.target)) return;
      // The sidebar tree binds the same two keys and calls preventDefault;
      // React attaches at the root container, so its handler already ran here.
      if (event.defaultPrevented) return;
      const delta = event.key === "ArrowLeft" ? -1 : 1;
      const next =
        variants[(index + delta + variants.length) % variants.length];
      if (next !== undefined) onSelect(next.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [index, onSelect, variants]);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-3 z-50 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border-2 border-yellow-400 bg-black px-1.5 py-1 font-mono text-[12px] text-yellow-300 shadow-lg">
        <button
          type="button"
          aria-label="Previous prototype variant"
          className="flex size-6 items-center justify-center rounded-full hover:bg-yellow-400 hover:text-black"
          onClick={() => cycle(-1)}
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="px-2 whitespace-nowrap">
          {active?.label ?? activeId}
        </span>
        <button
          type="button"
          aria-label="Next prototype variant"
          className="flex size-6 items-center justify-center rounded-full hover:bg-yellow-400 hover:text-black"
          onClick={() => cycle(1)}
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
    </div>
  );
}
