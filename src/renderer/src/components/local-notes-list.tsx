import type { LocalDraftControls } from "../flows/use-local-drafts";
import { localDraftKey } from "../flows/use-local-drafts";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { CopyLoadedTextButton } from "./copy-loaded-text-button";
import { GeneratedMarkdownInline } from "./generated-markdown";
import { LocalDraftStateBadge } from "./local-draft-state-badge";
import { InlineError } from "./ui/inline-error";

/**
 * A local Review's Local draft list in the navigator's Notes section (ADR
 * 0050, ADR 0051): Findings and the maintainer's notes as feedback for the
 * coding agent. Each draft shows what the last Refresh decided for it, and one
 * that could not be placed keeps its earlier lines under Needs attention until
 * removed (#452).
 */
export function LocalNotesList({
  controls,
}: {
  readonly controls: LocalDraftControls;
}): React.JSX.Element {
  const count = controls.entries.length;
  return (
    <div className="flex flex-col gap-2">
      {count === 0 ? (
        <p className="p-2 text-sm text-muted-foreground">
          Select diff lines to add a note, or add a finding to draft, to collect
          your feedback for the coding agent.
        </p>
      ) : (
        <div className="flex items-center justify-between gap-2 px-2">
          <p className="text-xs text-muted-foreground">
            {count} {count === 1 ? "draft" : "drafts"} for the coding agent
          </p>
          <CopyLoadedTextButton
            label="Copy as agent prompt"
            load={controls.loadAgentPrompt}
            failure="The drafts could not be copied."
          />
        </div>
      )}
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
            return (
              <li
                key={localDraftKey(entry)}
                className="flex flex-col gap-1 rounded-md px-2 py-2 text-sm"
              >
                <span className="flex w-full min-w-0 items-start justify-between gap-2">
                  <span className="line-clamp-2 min-w-0 break-words">
                    {entry.kind === "note" ? (
                      entry.text
                    ) : (
                      <GeneratedMarkdownInline markdown={entry.title} />
                    )}
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    className="shrink-0"
                    aria-label={`Remove ${entry.kind} at ${location} from drafts`}
                    disabled={
                      !controls.canRemove ||
                      controls.pending.has(localDraftKey(entry))
                    }
                    onClick={() => void controls.remove(entry)}
                  >
                    Remove
                  </Button>
                </span>
                <span className="flex flex-wrap items-center gap-1">
                  {entry.kind === "note" ? (
                    <Badge variant="outline">Note</Badge>
                  ) : entry.suggests ? (
                    <Badge variant="outline">Suggestion</Badge>
                  ) : null}
                  <LocalDraftStateBadge state={entry.state} />
                </span>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {location}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
