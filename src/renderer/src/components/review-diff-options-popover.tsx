import { useState } from "react";
import {
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

/** The diff view preferences the View options popover owns. */
export type ReviewDiffViewOptions = Pick<
  ReviewViewPreferences,
  "diffStyle" | "overflow" | "lineNumbers" | "backgrounds"
>;

function ReviewDiffOptionRow({
  icon,
  label,
  checked,
  onCheckedChange,
}: {
  readonly icon: React.JSX.Element;
  readonly label: string;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <Item size="xs">
      <ItemMedia variant="icon">{icon}</ItemMedia>
      <ItemContent>
        <ItemTitle>{label}</ItemTitle>
      </ItemContent>
      <ItemActions>
        {/* The label names the option, so the switch carries it as its accessible name rather than repeating a "switch to X" phrasing. */}
        <Switch
          aria-label={label}
          checked={checked}
          onCheckedChange={onCheckedChange}
        />
      </ItemActions>
    </Item>
  );
}

/** One popover on the diff toolbar for every way the diff is drawn; each toggle saves through `onPreferencesChange` so it persists per profile and applies at once. */
export function ReviewDiffOptionsPopover({
  preferences,
  onPreferencesChange,
}: {
  readonly preferences: ReviewDiffViewOptions;
  readonly onPreferencesChange: (
    update: Partial<ReviewViewPreferences>,
  ) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" aria-label="View options">
            <SlidersHorizontal aria-hidden="true" />
            View
          </Button>
        }
      />
      <PopoverContent className="w-64" align="end">
        <PopoverHeader>
          <PopoverTitle>View options</PopoverTitle>
        </PopoverHeader>
        <div className="grid gap-1">
          <ReviewDiffOptionRow
            icon={
              preferences.diffStyle === "split" ? (
                <Columns2 aria-hidden="true" />
              ) : (
                <Rows3 aria-hidden="true" />
              )
            }
            label="Split view"
            checked={preferences.diffStyle === "split"}
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
