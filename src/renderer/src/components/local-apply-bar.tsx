import { useMemo, useState } from "react";

import { definedProps } from "../../../domain/defined-props";
import { resolveSuggestionTarget } from "../../../domain/finding-suggestion";

import type { LocalApplyControls } from "../flows/use-local-apply";
import { findingLocation, type AnalysisResult } from "../analysis-headline";
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
import { Button } from "./ui/button";
import { InlineError } from "./ui/inline-error";
import { Spinner } from "./ui/spinner";

type AnalysisFinding = AnalysisResult["findings"][number];

/**
 * The Apply control of a working-tree Review's Analysis: one confirmation
 * names every selected suggestion, and a refusal reads beside the button.
 * With nothing to apply and nothing to check or report, it renders nothing.
 */
export function LocalApplyBar({
  controls,
  findings,
  evidencePatch,
}: {
  readonly controls: LocalApplyControls;
  /** Every Finding the reader lists, in reading order. */
  readonly findings: ReadonlyArray<AnalysisFinding>;
  /** The session's patch, against which a row decides whether to offer Apply. */
  readonly evidencePatch: string | undefined;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const applicable = useMemo(
    () => offersApply(findings, evidencePatch),
    [evidencePatch, findings],
  );
  if (!applicable && !hasApplyOutcome(controls)) return null;
  const selected = findings.filter((finding) =>
    controls.selectedIds.has(finding.id),
  );
  const count = `${selected.length} suggestion${selected.length === 1 ? "" : "s"}`;
  return (
    <div
      aria-label="Apply suggestions"
      role="group"
      className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-2"
    >
      {controls.lock === undefined ? (
        <AlertDialog open={open} onOpenChange={setOpen}>
          <Button
            size="sm"
            disabled={
              selected.length === 0 || controls.pending || controls.blocked
            }
            onClick={() => setOpen(true)}
          >
            {controls.pending ? (
              <>
                <Spinner data-icon="inline-start" />
                Applying…
              </>
            ) : selected.length === 0 ? (
              "Apply suggestions"
            ) : (
              `Apply ${count}`
            )}
          </Button>
          <AlertDialogContent className="data-[size=default]:sm:max-w-lg">
            <AlertDialogHeader>
              <AlertDialogTitle>
                Apply {count} to the working tree?
              </AlertDialogTitle>
              <AlertDialogDescription>
                Patchdesk runs git apply on your checkout. It changes only the
                lines each suggestion replaces and stages nothing.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <ul
              aria-label="Suggestions to apply"
              className="flex max-h-72 flex-col gap-2 overflow-y-auto text-sm"
            >
              {selected.map((finding) => (
                <li key={finding.id} className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate font-medium">
                    <GeneratedMarkdownInline markdown={finding.title} />
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
                  void controls.apply();
                }}
              >
                Apply to working tree
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : (
        <>
          <p role="status" className="text-sm">
            {controls.lock === "check_required"
              ? "An Apply left the files in an unexpected state."
              : "An Apply may have changed files. Check them before applying more."}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={controls.pending}
            onClick={() => void controls.check()}
          >
            {controls.pending ? <Spinner data-icon="inline-start" /> : null}
            {controls.pending ? "Checking…" : "Check files"}
          </Button>
        </>
      )}
      {controls.refusal === undefined ? (
        selected.length > 0 || controls.lock !== undefined ? null : (
          <p className="text-sm text-muted-foreground">
            Select the suggestions to apply.
          </p>
        )
      ) : (
        <InlineError>{controls.refusal}</InlineError>
      )}
      {controls.notice === undefined ? null : (
        <p role="status" className="text-sm text-muted-foreground">
          {controls.notice}
        </p>
      )}
    </div>
  );
}

/** The rule that gives a Finding row its Apply checkbox: open, with a suggestion that resolves in the patch. */
function offersApply(
  findings: ReadonlyArray<AnalysisFinding>,
  evidencePatch: string | undefined,
): boolean {
  if (evidencePatch === undefined) return false;
  return findings.some(
    (finding) =>
      (finding.disposition ?? "open") === "open" &&
      finding.suggestedReplacement !== undefined &&
      resolveSuggestionTarget(
        evidencePatch,
        definedProps({
          file: finding.file,
          lineStart: finding.lineStart,
          lineEnd: finding.lineEnd,
          diffSide: finding.diffSide,
        }),
      ) !== undefined,
  );
}

/** An unsettled Apply to check, or a message from the last one, keeps the bar on screen. */
function hasApplyOutcome(controls: LocalApplyControls): boolean {
  return (
    controls.lock !== undefined ||
    controls.refusal !== undefined ||
    controls.notice !== undefined
  );
}
