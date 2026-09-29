import { useId } from "react";
import { ChevronDown } from "lucide-react";

import {
  localPatchViews,
  type LocalPatchView,
} from "../../../domain/local-patch-view";
import { localPatchViewLabels } from "../review-source";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";

/** Switches the diff to the changes since the viewer's last submitted review. */
export type SinceReviewControl = {
  readonly active: boolean;
  /** Set when the option cannot be used; drawn beside the disabled choice. */
  readonly disabledReason: string | undefined;
  readonly loading: boolean;
  readonly onChange: (active: boolean) => void;
};

/** The Patch view a shared local Review's diff shows, and the way to switch it. */
type LocalPatchViewChoice = {
  readonly selected: LocalPatchView;
  readonly onSelect: (view: LocalPatchView) => void;
};

/** What the Changes menu can compare the diff against; each field is absent where that comparison does not apply. */
export type DiffChangesControl = {
  readonly sinceReview?: SinceReviewControl | undefined;
  readonly patchView?: LocalPatchViewChoice | undefined;
};

const patchViewTrees = {
  combined: "Merge base to Local snapshot",
  committed: "Merge base to checkout HEAD",
  uncommitted: "Checkout HEAD to Local snapshot",
} as const satisfies Record<LocalPatchView, string>;

const ALL_CHANGES = "all-changes";
const SINCE_YOUR_REVIEW = "since-your-review";

/** A radio choice whose accessible name is its label alone, with its detail read as a description. */
function ChangesChoice({
  value,
  label,
  detail,
  disabled = false,
  onChoose,
}: {
  readonly value: string;
  readonly label: string;
  readonly detail?: string | undefined;
  readonly disabled?: boolean;
  readonly onChoose: () => void;
}): React.JSX.Element {
  const labelId = useId();
  const detailId = useId();
  return (
    <DropdownMenuRadioItem
      value={value}
      disabled={disabled}
      closeOnClick
      onClick={onChoose}
      aria-labelledby={labelId}
      aria-describedby={detail === undefined ? undefined : detailId}
    >
      <span className="flex min-w-0 flex-col">
        <span id={labelId}>{label}</span>
        {detail === undefined ? null : (
          <span id={detailId} className="text-xs text-muted-foreground">
            {detail}
          </span>
        )}
      </span>
    </DropdownMenuRadioItem>
  );
}

/** The diff toolbar menu that chooses what the diff compares; its trigger names the current choice. Renders nothing when there is only the full diff to show. */
export function ReviewDiffChangesMenu({
  changes,
}: {
  readonly changes: DiffChangesControl;
}): React.JSX.Element | null {
  const { sinceReview, patchView } = changes;
  if (sinceReview === undefined && patchView === undefined) return null;
  const sinceReviewActive = sinceReview?.active === true;
  const current =
    patchView !== undefined
      ? localPatchViewLabels[patchView.selected]
      : sinceReviewActive
        ? "Since your review"
        : "All changes";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="xs" aria-label="Changes">
            {sinceReview?.loading === true ? <Spinner /> : null}
            {current}
            <ChevronDown aria-hidden="true" />
          </Button>
        }
      />
      <DropdownMenuContent className="w-60">
        {patchView === undefined ? null : (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Patch view</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={patchView.selected}>
              {localPatchViews.map((view) => (
                <ChangesChoice
                  key={view}
                  value={view}
                  label={localPatchViewLabels[view]}
                  detail={patchViewTrees[view]}
                  onChoose={() => patchView.onSelect(view)}
                />
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        )}
        {sinceReview === undefined ? null : (
          <DropdownMenuRadioGroup
            value={sinceReviewActive ? SINCE_YOUR_REVIEW : ALL_CHANGES}
          >
            <ChangesChoice
              value={ALL_CHANGES}
              label="All changes"
              onChoose={() => {
                if (sinceReviewActive) sinceReview.onChange(false);
              }}
            />
            <ChangesChoice
              value={SINCE_YOUR_REVIEW}
              label="Since your review"
              detail={sinceReview.disabledReason}
              disabled={sinceReview.disabledReason !== undefined}
              onChoose={() => {
                if (!sinceReviewActive) sinceReview.onChange(true);
              }}
            />
          </DropdownMenuRadioGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
