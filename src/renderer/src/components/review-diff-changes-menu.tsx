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

/** Switches the diff to a narrower comparison, such as the changes since the viewer's last submitted review. */
export type NarrowedDiffControl = {
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
  readonly sinceReview?: NarrowedDiffControl | undefined;
  readonly patchView?: LocalPatchViewChoice | undefined;
  /** Offered beside the Patch views, so it is drawn only with them. */
  readonly sinceLastRefresh?: NarrowedDiffControl | undefined;
};

const patchViewTrees = {
  combined: "Merge base to Local snapshot",
  committed: "Merge base to checkout HEAD",
  uncommitted: "Checkout HEAD to Local snapshot",
} as const satisfies Record<LocalPatchView, string>;

const ALL_CHANGES = "all-changes";
const SINCE_YOUR_REVIEW = "since-your-review";
const SINCE_LAST_REFRESH = "since-last-refresh";

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
  const { sinceReview, patchView, sinceLastRefresh } = changes;
  if (sinceReview === undefined && patchView === undefined) return null;
  const sinceReviewActive = sinceReview?.active === true;
  const sinceLastRefreshActive =
    patchView !== undefined && sinceLastRefresh?.active === true;
  const current = sinceLastRefreshActive
    ? "Since last Refresh"
    : patchView !== undefined
      ? localPatchViewLabels[patchView.selected]
      : sinceReviewActive
        ? "Since your review"
        : "All changes";
  const loading =
    sinceReview?.loading === true || sinceLastRefresh?.loading === true;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="xs" aria-label="Changes">
            {loading ? <Spinner /> : null}
            {current}
            <ChevronDown aria-hidden="true" />
          </Button>
        }
      />
      <DropdownMenuContent className="w-60">
        {patchView === undefined ? null : (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Patch view</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={
                sinceLastRefreshActive ? SINCE_LAST_REFRESH : patchView.selected
              }
            >
              {localPatchViews.map((view) => (
                <ChangesChoice
                  key={view}
                  value={view}
                  label={localPatchViewLabels[view]}
                  detail={patchViewTrees[view]}
                  onChoose={() => {
                    if (sinceLastRefreshActive)
                      sinceLastRefresh.onChange(false);
                    patchView.onSelect(view);
                  }}
                />
              ))}
              {sinceLastRefresh === undefined ? null : (
                <ChangesChoice
                  value={SINCE_LAST_REFRESH}
                  label="Since last Refresh"
                  detail={
                    sinceLastRefresh.disabledReason ??
                    "Previous Local snapshot to Local snapshot"
                  }
                  disabled={sinceLastRefresh.disabledReason !== undefined}
                  onChoose={() => {
                    if (!sinceLastRefreshActive)
                      sinceLastRefresh.onChange(true);
                  }}
                />
              )}
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
