import { ChevronDown } from "lucide-react";

import type { FeedbackHandoffVerdict } from "../../../domain/feedback-handoff";
import type { LocalDraftControls } from "../flows/use-local-drafts";
import { RelativeTime } from "./relative-time";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

const verdictLabels = {
  looks_good: "Looks good",
  changes_requested: "Changes requested",
} as const satisfies Record<FeedbackHandoffVerdict, string>;

/**
 * Ready for agent (#603): the maintainer marks the Local drafts ready for the
 * coding agent, with an optional verdict, which `get_feedback` and
 * `get_review_status` return with whether the drafts changed since.
 */
export function FeedbackHandoffButton({
  controls,
}: {
  readonly controls: LocalDraftControls;
}): React.JSX.Element | null {
  const { handOff } = controls;
  if (handOff === undefined) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button size="sm" variant="outline" disabled={controls.handingOff}>
            Ready for agent
            <ChevronDown aria-hidden="true" />
          </Button>
        }
      />
      <DropdownMenuContent className="w-48">
        <DropdownMenuItem onClick={() => void handOff()}>
          Without a verdict
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void handOff("looks_good")}>
          {verdictLabels.looks_good}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void handOff("changes_requested")}>
          {verdictLabels.changes_requested}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** When the drafts were last marked ready, the verdict, and whether they changed since. */
export function FeedbackHandoffStatus({
  controls,
}: {
  readonly controls: LocalDraftControls;
}): React.JSX.Element | null {
  const reading = controls.feedbackHandoff;
  if (reading === undefined) return null;
  const { verdict } = reading.handoff;
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      <p>
        <RelativeTime iso={reading.handoff.at} prefix="Marked ready " />
        {verdict === undefined ? null : ` · ${verdictLabels[verdict]}`}
      </p>
      {reading.changedSinceHandoff ? (
        <p>Drafts changed after you marked them ready.</p>
      ) : null}
    </div>
  );
}
