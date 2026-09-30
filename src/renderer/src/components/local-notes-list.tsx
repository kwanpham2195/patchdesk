import type { LocalDraftControls } from "../flows/use-local-drafts";
import { localDraftKey } from "../flows/use-local-drafts";
import type { LocalDraftEntry } from "../local-draft-contracts";
import {
  placeLocalDraft,
  type InlineLocalDraftPlacement,
  type LocalDraftPlacementContext,
  type LocalDraftPlacementReason,
} from "../local-draft-placement";
import { localPatchViewLabels } from "../review-source";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { CopyLoadedTextButton } from "./copy-loaded-text-button";
import {
  FeedbackHandoffButton,
  FeedbackHandoffStatus,
} from "./feedback-handoff-control";
import { GeneratedMarkdownInline } from "./generated-markdown";
import { LocalDraftAgentReply } from "./local-draft-agent-reply";
import { LocalDraftStateBadge } from "./local-draft-state-badge";
import { InlineError } from "./ui/inline-error";

/**
 * A local Review's Local draft list in the navigator's Notes section (ADR
 * 0050, ADR 0051): Findings and the maintainer's notes as feedback for the
 * coding agent. Each draft shows what the last Refresh decided for it, and one
 * that could not be placed keeps its earlier lines under Needs attention until
 * removed (#452). A draft inline in the shown diff is a button that reveals its
 * lines; any other says why it is not inline, and selecting it moves nothing
 * (#557 D6). Ready for agent shows even with no drafts, so a Looks good
 * verdict needs no note (#603). Each draft shows the coding agent's latest
 * reply as plain text, since the agent wrote it, and Resolve or Reopen; a
 * resolved draft leaves the agent prompt (#600).
 */
export function LocalNotesList({
  controls,
  placement,
  onReveal,
}: {
  readonly controls: LocalDraftControls;
  /** What the diff shows now; the diff places its note cards from the same context. */
  readonly placement: LocalDraftPlacementContext;
  readonly onReveal: (place: InlineLocalDraftPlacement) => void;
}): React.JSX.Element {
  const count = controls.entries.length;
  const resolved = controls.entries.filter(
    (entry) => entry.resolvedAt !== undefined,
  ).length;
  return (
    <div className="flex flex-col gap-2">
      {count === 0 ? (
        <p className="p-2 text-sm text-muted-foreground">
          Select diff lines to add a note, or add a finding to draft, to collect
          your feedback for the coding agent.
        </p>
      ) : null}
      <div className="flex flex-col items-start gap-2 px-2">
        {count === 0 ? null : (
          <p className="text-xs text-muted-foreground">
            {count} {count === 1 ? "draft" : "drafts"} for the coding agent
            {resolved === 0 ? null : ` · ${String(resolved)} resolved`}
          </p>
        )}
        <div className="flex flex-wrap items-start gap-2">
          {count === 0 ? null : (
            <CopyLoadedTextButton
              label="Copy as agent prompt"
              load={controls.loadAgentPrompt}
              failure="The drafts could not be copied."
            />
          )}
          <FeedbackHandoffButton controls={controls} />
        </div>
        <FeedbackHandoffStatus controls={controls} />
      </div>
      {controls.error === undefined ? null : (
        <InlineError>{controls.error}</InlineError>
      )}
      {count === 0 ? null : (
        <ul aria-label="Local drafts" className="flex flex-col gap-1">
          {controls.entries.map((entry) => {
            const location =
              entry.startLine === entry.line
                ? `${entry.path}:${String(entry.line)}`
                : `${entry.path}:${String(entry.startLine)}-${String(entry.line)}`;
            const place = placeLocalDraft(entry, placement);
            const reply = controls.replies.get(localDraftKey(entry));
            const isResolved = entry.resolvedAt !== undefined;
            const details = (
              <LocalDraftDetails
                entry={entry}
                location={location}
                showsView={placement.view !== undefined}
              />
            );
            return (
              <li
                key={localDraftKey(entry)}
                className="min-w-0 rounded-md bg-muted/40 p-1 text-sm"
              >
                {place.placement === "inline" ? (
                  <button
                    type="button"
                    aria-label={`Show ${entry.kind} at ${location} in the diff`}
                    className="flex w-full min-w-0 flex-col items-start gap-1 rounded-md px-1 py-1 text-left hover:bg-accent"
                    onClick={() => onReveal(place)}
                  >
                    {details}
                  </button>
                ) : (
                  <div className="flex w-full min-w-0 flex-col items-start gap-1 px-1 py-1">
                    {details}
                    <span
                      data-local-draft-reason={place.reason}
                      className="text-xs text-muted-foreground"
                    >
                      {notInlineReason(place.reason, placement.view)}
                    </span>
                  </div>
                )}
                {reply === undefined ? null : (
                  <LocalDraftAgentReply reply={reply} className="mx-1" />
                )}
                <div className="flex justify-end gap-1 px-1">
                  {controls.setResolved === undefined ? null : (
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`${isResolved ? "Reopen" : "Resolve"} ${entry.kind} at ${location}`}
                      disabled={controls.pending.has(localDraftKey(entry))}
                      onClick={() =>
                        void controls.setResolved?.(entry, !isResolved)
                      }
                    >
                      {isResolved ? "Reopen" : "Resolve"}
                    </Button>
                  )}
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={`Remove ${entry.kind} at ${location} from drafts`}
                    disabled={
                      !controls.canRemove ||
                      controls.pending.has(localDraftKey(entry))
                    }
                    onClick={() => void controls.remove(entry)}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function LocalDraftDetails({
  entry,
  location,
  showsView,
}: {
  readonly entry: LocalDraftEntry;
  readonly location: string;
  /** Only a shared Review has patch views to name. */
  readonly showsView: boolean;
}): React.JSX.Element {
  return (
    <>
      <span className="line-clamp-2 w-full min-w-0 break-words">
        {entry.kind === "note" ? (
          entry.text
        ) : (
          <GeneratedMarkdownInline markdown={entry.title} />
        )}
      </span>
      <span className="flex flex-wrap items-center gap-1">
        <Badge variant="outline">
          {entry.kind === "note" ? "Note" : "Finding"}
        </Badge>
        {entry.kind === "finding" && entry.suggests ? (
          <Badge variant="outline">Suggestion</Badge>
        ) : null}
        {showsView ? (
          <Badge variant="secondary">{localPatchViewLabels[entry.view]}</Badge>
        ) : null}
        <LocalDraftStateBadge state={entry.state} />
        {entry.resolvedAt === undefined ? null : (
          <Badge variant="secondary">Resolved</Badge>
        )}
      </span>
      <span className="block w-full min-w-0 truncate font-mono text-xs text-muted-foreground">
        {location}
      </span>
    </>
  );
}

/** Why a draft is not in the shown diff, naming the view where one applies. */
function notInlineReason(
  reason: LocalDraftPlacementReason,
  view: LocalDraftPlacementContext["view"],
): string {
  const shown = localPatchViewLabels[view ?? "combined"];
  switch (reason) {
    case "earlier_session":
      return "Its lines are from before the last Refresh, so the diff does not show it.";
    case "tree_not_in_view":
      return `The ${shown} view shows another version of this file.`;
    case "outside_hunk":
      return `The ${shown} view does not show these lines.`;
    case "finding_off_combined":
      return "Findings show in the Combined view only.";
    case "finding_not_current":
      return "The current Analysis does not show this Finding in the diff.";
  }
}
