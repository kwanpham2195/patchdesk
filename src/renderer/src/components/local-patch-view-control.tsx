import {
  localPatchViews,
  type LocalPatchView,
} from "../../../domain/local-patch-view";
import { localPatchViewLabels } from "../review-source";
import { PRESSED_SEGMENT_CLASS } from "./review-diff-toolbar";
import { Button } from "./ui/button";
import { ButtonGroup } from "./ui/button-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const patchViewTrees = {
  combined: "Merge base to Local snapshot",
  committed: "Merge base to checkout HEAD",
  uncommitted: "Checkout HEAD to Local snapshot",
} as const satisfies Record<LocalPatchView, string>;

/** Switches a shared local Review's diff between its three patch views. */
export function LocalPatchViewControl({
  selected,
  onSelect,
}: {
  readonly selected: LocalPatchView;
  readonly onSelect: (view: LocalPatchView) => void;
}): React.JSX.Element {
  return (
    <ButtonGroup aria-label="Patch view">
      {localPatchViews.map((view) => (
        <Tooltip key={view}>
          <TooltipTrigger
            render={
              <Button
                variant={selected === view ? "secondary" : "ghost"}
                size="xs"
                className={PRESSED_SEGMENT_CLASS}
                aria-pressed={selected === view}
                onClick={() => onSelect(view)}
              />
            }
          >
            {localPatchViewLabels[view]}
          </TooltipTrigger>
          <TooltipContent>{patchViewTrees[view]}</TooltipContent>
        </Tooltip>
      ))}
    </ButtonGroup>
  );
}
