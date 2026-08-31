import { CheckCircle2, Clock3 } from "lucide-react";

import type { InboxRow } from "@/renderer-contracts";
import { recoveryActionLabel } from "@/review-copy";
import { Button } from "@/components/ui/button";
import {
  ReviewOpeningButtonContent,
  type ReviewOpeningState,
} from "@/components/review-opening-status";

/** The inspector's read-only Review entry points share one opening operation. */
export function InspectorActionButtons({
  row,
  freshness,
  onAction,
  onSecondaryAction,
  openingState,
}: {
  readonly row: InboxRow;
  readonly freshness: InboxRow["dataFreshness"];
  readonly onAction: () => void | undefined;
  readonly onSecondaryAction: () => void;
  readonly openingState?: Exclude<ReviewOpeningState, undefined>;
}): React.JSX.Element {
  return (
    <>
      <Button
        size="sm"
        className="h-8 w-full text-xs"
        onClick={onAction}
        disabled={
          openingState?.status === "opening" ||
          (freshness === "cached" &&
            row.recommendedAction.kind === "open_merge_readiness")
        }
      >
        <ReviewOpeningButtonContent state={openingState}>
          {actionIcon(row.recommendedAction.kind)}
          {inboxActionLabel(row.recommendedAction.kind)}
        </ReviewOpeningButtonContent>
      </Button>
      {row.secondaryAction === undefined ? null : (
        <Button
          size="sm"
          variant="outline"
          className="h-8 w-full text-xs"
          onClick={onSecondaryAction}
          disabled={
            openingState?.status === "opening" || freshness === "cached"
          }
        >
          <ReviewOpeningButtonContent state={openingState}>
            {actionIcon(row.secondaryAction.kind)}
            {inboxActionLabel(row.secondaryAction.kind)}
          </ReviewOpeningButtonContent>
        </Button>
      )}
    </>
  );
}

function inboxActionLabel(kind: InboxRow["recommendedAction"]["kind"]): string {
  switch (kind) {
    case "run_review":
      return recoveryActionLabel("run_review");
    case "open_merged_review":
      return "View merged pull request";
    case "open_saved_review":
      return "Open Review";
    case "open_merge_readiness":
      return "Open merge readiness";
  }
}

function actionIcon(
  kind: InboxRow["recommendedAction"]["kind"],
): React.JSX.Element {
  return kind === "run_review" ? <CheckCircle2 /> : <Clock3 />;
}
