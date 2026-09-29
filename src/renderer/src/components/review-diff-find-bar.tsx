import { ChevronDown, ChevronUp, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ReviewDiffFindControl } from "@/hooks/use-review-diff-find";

function findCountLabel(
  query: string,
  total: number,
  position: number | undefined,
): string {
  if (query === "") return "";
  if (total === 0) return "No matches";
  if (position !== undefined) return `${position} of ${total}`;
  return total === 1 ? "1 match" : `${total} matches`;
}

function FindBarButton({
  label,
  shortcut,
  disabled = false,
  onClick,
  children,
}: {
  readonly label: string;
  readonly shortcut: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label} <Kbd>{shortcut}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

/** The ⌘F bar under the diff toolbar: Enter and Shift+Enter step, Escape closes. */
export function ReviewDiffFindBar({
  find,
}: {
  readonly find: ReviewDiffFindControl | undefined;
}): React.JSX.Element | null {
  if (find === undefined) return null;
  const { inputRef, query, onQueryChange, total, position, onStep, onClose } =
    find;
  return (
    <search
      aria-label="Find in diff"
      className="z-20 flex shrink-0 items-center gap-1 border-b bg-card/95 px-2 py-1 backdrop-blur"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
      }}
    >
      <Input
        ref={inputRef}
        aria-label="Find in diff"
        placeholder="Find in diff"
        className="h-7 max-w-72"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          onStep(event.shiftKey ? "previous" : "next");
        }}
      />
      <span
        aria-live="polite"
        className="min-w-20 px-1 text-xs text-muted-foreground tabular-nums"
      >
        {findCountLabel(query, total, position)}
      </span>
      <FindBarButton
        label="Previous match"
        shortcut="⇧↩"
        disabled={total === 0}
        onClick={() => onStep("previous")}
      >
        <ChevronUp aria-hidden="true" />
      </FindBarButton>
      <FindBarButton
        label="Next match"
        shortcut="↩"
        disabled={total === 0}
        onClick={() => onStep("next")}
      >
        <ChevronDown aria-hidden="true" />
      </FindBarButton>
      <FindBarButton label="Close find" shortcut="Esc" onClick={onClose}>
        <X aria-hidden="true" />
      </FindBarButton>
    </search>
  );
}
