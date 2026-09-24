import { useState } from "react";

import type { AddAllFindingsControls } from "../flows/use-add-all-findings";
import {
  findingLocation,
  type AnalysisFindingStatus,
  type AnalysisResult,
} from "../analysis-headline";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { GeneratedMarkdownInline } from "./generated-markdown";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

type AnalysisFinding = AnalysisResult["findings"][number];

/**
 * The one confirmation for a batch of Finding writes; it names every Finding
 * so the maintainer authorizes each comment, not a count.
 */
export function AnalysisAddAllFindings({
  findings: readingOrder,
  findingStatuses,
  controls,
  disabled,
  onClearError,
  onFailed,
}: {
  /** Every Finding in the order the reader lists them. */
  readonly findings: ReadonlyArray<AnalysisFinding>;
  readonly findingStatuses:
    | Readonly<Record<string, AnalysisFindingStatus>>
    | undefined;
  readonly controls: AddAllFindingsControls;
  readonly disabled: boolean;
  readonly onClearError: (findingId: string) => void;
  readonly onFailed: (findingId: string, message: string) => void;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const { progress } = controls;
  const findings = readingOrder.filter(
    (finding) =>
      (finding.disposition ?? "open") === "open" &&
      findingStatuses?.[finding.id] === "actionable" &&
      finding.mappingStatus === "mapped",
  );
  const addAll = async (): Promise<void> => {
    for (const finding of findings) onClearError(finding.id);
    const outcome = await controls.addAll(findings);
    if (outcome._tag === "failed") onFailed(outcome.findingId, outcome.message);
  };
  if (progress !== undefined)
    return (
      <div className="flex items-center gap-2">
        <p role="status" className="flex items-center gap-1.5 text-sm">
          <Spinner />
          Adding {Math.min(progress.done + 1, progress.total)} of{" "}
          {progress.total}…
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={progress.stopping}
          onClick={controls.stop}
        >
          {progress.stopping ? "Stopping…" : "Stop adding"}
        </Button>
      </div>
    );
  if (findings.length === 0) return null;
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        Add all to review
      </Button>
      <AlertDialogContent className="data-[size=default]:sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>
            Add {findings.length} finding{findings.length === 1 ? "" : "s"} to
            the review?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Each one becomes a comment on your pending review, in this order.
            Adding stops at the first failure; comments already added stay.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul
          aria-label="Findings to add"
          className="flex max-h-72 flex-col gap-2 overflow-y-auto text-sm"
        >
          {findings.map((finding) => (
            <li key={finding.id} className="flex min-w-0 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-2">
                <Badge
                  variant={
                    finding.severity === "P0" || finding.severity === "P1"
                      ? "destructive"
                      : "outline"
                  }
                >
                  {finding.severity}
                </Badge>
                <span className="truncate font-medium">
                  <GeneratedMarkdownInline markdown={finding.title} />
                </span>
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {findingLocation(finding)}
              </span>
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              setOpen(false);
              void addAll();
            }}
          >
            Add all
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
