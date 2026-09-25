import type { LocalDraftControls } from "../flows/use-local-drafts";
import { localDraftKey } from "../flows/use-local-drafts";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { InlineError } from "./ui/inline-error";

/**
 * A local Review's Local draft list (ADR 0050): every Finding added to draft,
 * including drafts from an earlier session, which stay listed until removed.
 */
export function LocalDraftsCard({
  controls,
}: {
  readonly controls: LocalDraftControls;
}): React.JSX.Element {
  const count = controls.entries.length;
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Local drafts</CardTitle>
        <CardDescription>
          {count === 0
            ? "Add a finding to draft to keep it for the pull request."
            : `${String(count)} ${count === 1 ? "draft" : "drafts"} for the pull request`}
        </CardDescription>
      </CardHeader>
      {count === 0 && controls.error === undefined ? null : (
        <CardContent className="flex flex-col gap-2">
          {controls.error === undefined ? null : (
            <InlineError>{controls.error}</InlineError>
          )}
          <ul aria-label="Local drafts" className="flex flex-col gap-1.5">
            {controls.entries.map((entry) => {
              const location =
                entry.startLine === entry.line
                  ? `${entry.path}:${String(entry.line)}`
                  : `${entry.path}:${String(entry.startLine)}-${String(entry.line)}`;
              return (
                <li
                  key={localDraftKey(entry.analysisRunId, entry.findingId)}
                  className="flex items-center justify-between gap-3 rounded-md border px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{entry.title}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {location}
                    </p>
                  </div>
                  {entry.suggests ? (
                    <Badge variant="outline">Suggestion</Badge>
                  ) : null}
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={`Remove ${location} from drafts`}
                    disabled={
                      !controls.canRemove ||
                      controls.pending.has(
                        localDraftKey(entry.analysisRunId, entry.findingId),
                      )
                    }
                    onClick={() => void controls.remove(entry)}
                  >
                    Remove
                  </Button>
                </li>
              );
            })}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}
