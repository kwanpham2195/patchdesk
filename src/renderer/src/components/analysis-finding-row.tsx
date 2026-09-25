import { useMemo, useState } from "react";
import { ChevronDownIcon } from "lucide-react";

import { definedProps } from "../../../domain/defined-props";
import { mapFindingLocation, parseUnifiedPatch } from "../../../domain/patch";
import { resolveSuggestionTarget } from "../../../domain/finding-suggestion";
import {
  findingLocation,
  type AnalysisFindingStatus as FindingStatus,
  type AnalysisResult,
} from "../analysis-headline";
import { FindingEvidenceHunk } from "./finding-evidence-hunk";
import { FindingSuggestionPreview } from "./finding-suggestion-preview";
import { analysisFindingRowId } from "./review-workbench-finding-navigation";
import {
  GeneratedMarkdown,
  GeneratedMarkdownInline,
} from "./generated-markdown";
import { NeedsReplyBadge } from "./needs-reply-badge";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import { Input } from "./ui/input";
import { InlineError } from "./ui/inline-error";
import { Spinner } from "./ui/spinner";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "./ui/popover";

type AnalysisFinding = AnalysisResult["findings"][number];
export type FindingActionState = "adding" | "dismissing";

/** The maintainer's one explicit authorization for this Finding's GitHub write. */
function AddFindingButton({
  finding,
  adding,
  disabled,
  suggests,
  onAddFinding,
}: {
  readonly finding: AnalysisFinding;
  readonly adding: boolean;
  readonly disabled: boolean;
  /** Whether this write publishes a suggestion block rather than a comment. */
  readonly suggests: boolean;
  readonly onAddFinding: (finding: AnalysisFinding) => Promise<void>;
}): React.JSX.Element {
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={disabled}
      onClick={() => onAddFinding(finding)}
    >
      {adding ? (
        <>
          <Spinner data-icon="inline-start" />
          Adding…
        </>
      ) : suggests ? (
        "Add suggestion to review"
      ) : (
        "Add to review"
      )}
    </Button>
  );
}

export function AnalysisFindingRow({
  finding,
  status,
  needsReply,
  actionState,
  actionsDisabled,
  actionError,
  evidencePatch,
  onAddFinding,
  onDismissFinding,
  onOpenFindingInDiff,
}: {
  readonly finding: AnalysisFinding;
  readonly status?: FindingStatus | undefined;
  readonly needsReply: boolean;
  readonly actionState?: FindingActionState | undefined;
  /** A batch Add owns every Finding's actions while it runs. */
  readonly actionsDisabled: boolean;
  readonly actionError?: string | undefined;
  readonly evidencePatch?: string | undefined;
  readonly onOpenFindingInDiff?: (finding: AnalysisFinding) => void;
  readonly onAddFinding?: (finding: AnalysisFinding) => Promise<void>;
  readonly onDismissFinding?: (
    finding: AnalysisFinding,
    reason: string,
  ) => Promise<void>;
}): React.JSX.Element {
  const [reason, setReason] = useState("");
  const [dismissOpen, setDismissOpen] = useState(false);
  const suggestionCode = finding.suggestedReplacement?.code;
  // One resolution feeds both the preview and the add action's label, so the
  // row never offers a suggestion the represented patch cannot anchor.
  const suggestionTarget = useMemo(
    () =>
      evidencePatch === undefined || suggestionCode === undefined
        ? undefined
        : resolveSuggestionTarget(
            evidencePatch,
            definedProps({
              file: finding.file,
              lineStart: finding.lineStart,
              lineEnd: finding.lineEnd,
              diffSide: finding.diffSide,
            }),
          ),
    [
      evidencePatch,
      finding.diffSide,
      finding.file,
      finding.lineEnd,
      finding.lineStart,
      suggestionCode,
    ],
  );
  const disposition = finding.disposition ?? "open";
  const actionPending = actionState !== undefined || actionsDisabled;
  const reviewStatus =
    status ?? (disposition === "dismissed" ? "dismissed" : "unavailable");
  const evidenceAnchor =
    evidencePatch === undefined ||
    finding.file === undefined ||
    finding.lineStart === undefined
      ? undefined
      : (() => {
          const location = mapFindingLocation(
            parseUnifiedPatch(evidencePatch),
            {
              file: finding.file,
              lineStart: finding.lineStart,
              ...definedProps({
                lineEnd: finding.lineEnd,
                diffSide: finding.diffSide,
              }),
            },
          );
          return location.mappingStatus === "mapped" &&
            location.path !== undefined &&
            location.line !== undefined &&
            location.side !== undefined
            ? {
                path: location.path,
                startLine: location.startLine ?? location.line,
                line: location.line,
                side: location.side,
              }
            : undefined;
        })();
  const dismiss = async (): Promise<void> => {
    if (onDismissFinding === undefined || reason.trim().length === 0) return;
    try {
      await onDismissFinding(finding, reason.trim());
      setDismissOpen(false);
      setReason("");
    } catch {
      // The parent owns the row-local error; this row keeps the dismissal draft.
    }
  };

  const location = findingLocation(finding);
  const statusLabel = findingStatusLabel(reviewStatus);

  return (
    // Focusable so a Diff card's "Open in Analysis" can land keyboard focus here.
    <li
      id={analysisFindingRowId(finding.id)}
      tabIndex={-1}
      className="rounded-lg border bg-background p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={
                finding.severity === "P0" || finding.severity === "P1"
                  ? "destructive"
                  : "outline"
              }
            >
              {finding.severity}
            </Badge>
            <p className="font-medium">
              <GeneratedMarkdownInline markdown={finding.title} />
            </p>
          </div>
          <GeneratedMarkdown
            markdown={finding.explanation}
            className="mt-2 max-w-4xl text-muted-foreground"
          />
          {location === undefined ? null : onOpenFindingInDiff !== undefined &&
            finding.mappingStatus === "mapped" ? (
            <button
              type="button"
              aria-label={`Open in diff: ${location}`}
              className="mt-2 block max-w-full truncate text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onOpenFindingInDiff(finding)}
            >
              {location}
            </button>
          ) : (
            <p className="mt-2 truncate text-xs text-muted-foreground">
              {location}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {statusLabel === undefined ? null : (
            <Badge
              variant={
                reviewStatus === "published" ||
                reviewStatus === "pending_review"
                  ? "secondary"
                  : "outline"
              }
            >
              {statusLabel}
            </Badge>
          )}
          {needsReply ? <NeedsReplyBadge /> : null}
          {disposition === "open" &&
          reviewStatus === "actionable" &&
          finding.mappingStatus === "mapped" &&
          onAddFinding !== undefined ? (
            <AddFindingButton
              finding={finding}
              adding={actionState === "adding"}
              disabled={actionPending}
              suggests={suggestionTarget !== undefined}
              onAddFinding={onAddFinding}
            />
          ) : null}
          {disposition === "open" &&
          // Dismissing a Finding already commented on would contradict the comment.
          reviewStatus !== "pending_review" &&
          reviewStatus !== "published" &&
          onDismissFinding !== undefined ? (
            <Popover
              open={dismissOpen}
              onOpenChange={(open) => {
                if (!actionPending) setDismissOpen(open);
              }}
            >
              <PopoverTrigger
                render={
                  <Button size="xs" variant="ghost" disabled={actionPending} />
                }
              >
                Dismiss
              </PopoverTrigger>
              <PopoverContent align="end">
                <PopoverHeader>
                  <PopoverTitle>Dismiss finding</PopoverTitle>
                  <PopoverDescription>
                    Record why this finding does not need review action.
                  </PopoverDescription>
                </PopoverHeader>
                <Input
                  aria-label={`Dismiss reason for ${finding.title}`}
                  placeholder="Reason required"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
                <div className="flex justify-end gap-2">
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={actionPending}
                    onClick={() => setDismissOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="xs"
                    disabled={reason.trim().length === 0 || actionPending}
                    onClick={() => dismiss()}
                  >
                    {actionState === "dismissing" ? (
                      <>
                        <Spinner data-icon="inline-start" />
                        Dismissing…
                      </>
                    ) : (
                      "Confirm dismissal"
                    )}
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      </div>
      {suggestionTarget === undefined || suggestionCode === undefined ? null : (
        <FindingSuggestionPreview
          target={suggestionTarget}
          code={suggestionCode}
        />
      )}
      {reviewStatus === "locked" ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Locked: GitHub comment unconfirmed.
        </p>
      ) : null}
      {actionError === undefined ? null : (
        <InlineError className="mt-2">{actionError}</InlineError>
      )}
      {evidencePatch === undefined || evidenceAnchor === undefined ? null : (
        <Collapsible className="mt-2">
          <CollapsibleTrigger render={<Button size="xs" variant="ghost" />}>
            View evidence
            <ChevronDownIcon data-icon="inline-end" />
          </CollapsibleTrigger>
          <CollapsibleContent motion="disclosure">
            <FindingEvidenceHunk
              patch={evidencePatch}
              anchor={evidenceAnchor}
            />
          </CollapsibleContent>
        </Collapsible>
      )}
    </li>
  );
}

/** An actionable Finding needs no label: its Add and Dismiss buttons say it. */
function findingStatusLabel(
  status: FindingStatus | "dismissed" | "unavailable",
): string | undefined {
  switch (status) {
    case "actionable":
      return undefined;
    case "pending_review":
      return "Added";
    case "published":
      return "Published";
    case "locked":
      return "Locked";
    case "dismissed":
      return "Dismissed";
    case "unavailable":
      return "Unavailable";
  }
}
