import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ReviewOpeningButtonContent,
  type ReviewOpeningState,
} from "@/components/review-opening-status";

/** The inspector's one read-only Review entry point; every row state opens the
 * same way, so the button says Open rather than naming a per-state action. */
export function InspectorActionButtons({
  onAction,
  openingState,
}: {
  readonly onAction: () => void | undefined;
  readonly openingState?: Exclude<ReviewOpeningState, undefined>;
}): React.JSX.Element {
  return (
    <Button
      size="sm"
      className="h-8 w-full text-xs"
      onClick={onAction}
      disabled={openingState?.status === "opening"}
    >
      <ReviewOpeningButtonContent state={openingState}>
        <ArrowRight />
        Open
      </ReviewOpeningButtonContent>
    </Button>
  );
}
