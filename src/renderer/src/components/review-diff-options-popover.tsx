import { useContext, useRef, useState } from "react";
import {
  ChevronDown,
  Columns2,
  Hash,
  Palette,
  Rows3,
  SlidersHorizontal,
  WrapText,
} from "lucide-react";

import type { ReviewViewPreferences } from "@/review-view-preferences";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { SplitViewFallbackContext } from "@/hooks/use-split-view-fallback";

/** The diff view preferences the View options popover owns. */
export type ReviewDiffViewOptions = Pick<
  ReviewViewPreferences,
  "diffStyle" | "overflow" | "lineNumbers" | "backgrounds"
>;

/** One labelled switch row of the View options popover. */
export function ReviewDiffOptionRow({
  icon,
  label,
  checked,
  onCheckedChange,
  disabledReason,
}: {
  readonly icon: React.JSX.Element;
  readonly label: string;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  /** Disables the switch and says why beside it. */
  readonly disabledReason?: string | undefined;
}): React.JSX.Element {
  return (
    <Item size="xs">
      <ItemMedia variant="icon">{icon}</ItemMedia>
      <ItemContent>
        <ItemTitle>{label}</ItemTitle>
        {disabledReason === undefined ? null : (
          <ItemDescription>{disabledReason}</ItemDescription>
        )}
      </ItemContent>
      <ItemActions>
        {/* The label names the option, so the switch carries it as its accessible name rather than repeating a "switch to X" phrasing. */}
        <Switch
          aria-label={label}
          checked={checked}
          disabled={disabledReason !== undefined}
          onCheckedChange={onCheckedChange}
        />
      </ItemActions>
    </Item>
  );
}

/** One popover on the diff toolbar for every way the diff is drawn; each toggle saves through `onPreferencesChange` so it persists and applies at once. */
export function ReviewDiffOptionsPopover({
  preferences,
  onPreferencesChange,
  triggerLabel = "View",
  children,
}: {
  readonly preferences: ReviewDiffViewOptions;
  readonly onPreferencesChange: (
    update: Partial<ReviewViewPreferences>,
  ) => void;
  /** The trigger's visible text; the diff toolbar shows its file display mode here. */
  readonly triggerLabel?: string | undefined;
  /** Controls the caller owns, drawn above the drawing options. */
  readonly children?: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  // While the pane is too narrow, the switch shows the saved style rather than the unified fallback on screen.
  const savedStyleWhileNarrow = useContext(SplitViewFallbackContext);
  const split = (savedStyleWhileNarrow ?? preferences.diffStyle) === "split";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="outline" size="xs" aria-label="View options">
            <SlidersHorizontal aria-hidden="true" />
            {triggerLabel}
            <ChevronDown aria-hidden="true" />
          </Button>
        }
      />
      <PopoverContent
        // Scroll inside rather than overflow the window when neither side has room.
        className="max-h-(--available-height) w-64 overflow-y-auto"
        align="start"
        ref={popupRef}
        // Focus the popup itself: the first button is All files, whose focus would open its keys tooltip over the heading and take the first Escape.
        initialFocus={popupRef}
        hideWhenAnchorHidden
        // Flip above the button when needed so every option stays visible.
        collisionAvoidance={{
          side: "flip",
          align: "shift",
          fallbackAxisSide: "none",
        }}
      >
        <PopoverHeader>
          <PopoverTitle>View options</PopoverTitle>
        </PopoverHeader>
        {children === undefined ? null : (
          <div className="grid gap-1 border-b pb-2">{children}</div>
        )}
        <div className="grid gap-1">
          <ReviewDiffOptionRow
            icon={
              split ? (
                <Columns2 aria-hidden="true" />
              ) : (
                <Rows3 aria-hidden="true" />
              )
            }
            label="Split view"
            checked={split}
            disabledReason={
              savedStyleWhileNarrow === undefined
                ? undefined
                : "Pane too narrow"
            }
            onCheckedChange={(checked) =>
              onPreferencesChange({ diffStyle: checked ? "split" : "unified" })
            }
          />
          <ReviewDiffOptionRow
            icon={<WrapText aria-hidden="true" />}
            label="Wrap lines"
            checked={preferences.overflow === "wrap"}
            onCheckedChange={(checked) =>
              onPreferencesChange({ overflow: checked ? "wrap" : "scroll" })
            }
          />
          <ReviewDiffOptionRow
            icon={<Hash aria-hidden="true" />}
            label="Line numbers"
            checked={preferences.lineNumbers}
            onCheckedChange={(checked) =>
              onPreferencesChange({ lineNumbers: checked })
            }
          />
          <ReviewDiffOptionRow
            icon={<Palette aria-hidden="true" />}
            label="Backgrounds"
            checked={preferences.backgrounds}
            onCheckedChange={(checked) =>
              onPreferencesChange({ backgrounds: checked })
            }
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
