import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon } from "lucide-react";

import { definedProps } from "../../../domain/defined-props";
import { contextualMessage } from "../api-client";
import { FINDING_ACTION_MESSAGES } from "../review-copy";
import { useFindingErrors } from "../hooks/use-finding-errors";
import type { AnalysisVerificationControls } from "../hooks/use-analysis-verification";
import {
  renderAnalysisFixPrompt,
  type AnalysisFixPromptContext,
} from "../analysis-fix-prompt";
import { mapFindingLocation, parseUnifiedPatch } from "../../../domain/patch";
import { resolveSuggestionTarget } from "../../../domain/finding-suggestion";
import {
  analysisVerdictLabel,
  checkStatusLabel,
  unhandledAnalysisFindings,
  type AnalysisFindingStatus as FindingStatus,
  type AnalysisResult,
  type CheckStatus,
} from "../analysis-headline";
import { AnalysisDismissedFindingRow } from "./analysis-dismissed-finding-row";
import { FindingEvidenceHunk } from "./finding-evidence-hunk";
import { FindingSuggestionPreview } from "./finding-suggestion-preview";
import {
  analysisFindingRowId,
  ReviewWorkbenchFindingNavigationContext,
} from "./review-workbench-finding-navigation";
import { GeneratedMarkdown } from "./generated-markdown";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import { Field, FieldLabel } from "./ui/field";
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
type FindingActionState = "adding" | "dismissing";
type SupportingDetail = {
  readonly key: string;
  readonly heading?: string;
  readonly markdown: string;
  readonly comparisonTexts: ReadonlyArray<string>;
};

type SupportingDetailGroup = {
  readonly key: string;
  readonly title: string;
  readonly details: ReadonlyArray<SupportingDetail>;
};

export type AnalysisReaderProps = {
  readonly result: AnalysisResult;
  readonly onAddFinding?: (finding: AnalysisFinding) => Promise<void>;
  readonly onDismissFinding?: (
    finding: AnalysisFinding,
    reason: string,
  ) => Promise<void>;
  readonly findingStatuses?: Readonly<Record<string, FindingStatus>>;
  /** Findings whose published thread waits on the viewer's reply. */
  readonly needsReplyFindingIds?: ReadonlySet<string>;
  readonly evidencePatch?: string;
  readonly checkStatus?: CheckStatus;
  readonly canFinishWithAnalysisSummary?: boolean;
  readonly onFinishWithAnalysisSummary?: () => void;
  /** Opens the Diff tab at a mapped finding's lines. */
  readonly onOpenFindingInDiff?: (finding: AnalysisFinding) => void;
  /** Names the repository and branches in the copied fix prompt. */
  readonly fixPromptContext?: AnalysisFixPromptContext | undefined;
  /** Saved Verification ticks; without it the checklist is read-only. */
  readonly verification?: AnalysisVerificationControls;
};

/** Decision-first read-side view of one retained Analysis result. */
export function AnalysisReader({
  result,
  onAddFinding,
  onDismissFinding,
  findingStatuses,
  needsReplyFindingIds,
  evidencePatch,
  checkStatus = "unknown",
  canFinishWithAnalysisSummary = false,
  onFinishWithAnalysisSummary,
  onOpenFindingInDiff,
  fixPromptContext,
  verification,
}: AnalysisReaderProps): React.JSX.Element {
  const admittedFindingIds = useRef<Set<string>>(new Set());
  const [findingActions, setFindingActions] = useState<
    ReadonlyMap<string, FindingActionState>
  >(new Map());
  const {
    errors: findingErrors,
    clear: clearFindingError,
    record: recordFindingError,
  } = useFindingErrors(result, findingStatuses);
  const verifiedSteps = verification?.checkedSteps ?? new Set<number>();
  const unhandledFindings = unhandledAnalysisFindings(result, findingStatuses);
  const handledProgress = `${result.findings.length - unhandledFindings.length} of ${result.findings.length} handled`;
  const highSeverityFindings = result.findings.filter(isHighSeverity);
  const lowerSeverityFindings = result.findings.filter(
    (finding) => !isHighSeverity(finding),
  );
  const [lowerSeverityOpen, setLowerSeverityOpen] = useState(false);
  // A Diff card pointing at a P2 or P3 finding must find its row mounted, so
  // the disclosure opens in the same render the focus request arrives.
  const findingFocusRequest = useContext(
    ReviewWorkbenchFindingNavigationContext,
  )?.findingFocusRequest;
  const lowerSeverityFocused =
    findingFocusRequest !== undefined &&
    lowerSeverityFindings.some(
      (finding) => finding.id === findingFocusRequest.findingId,
    );
  const hasNoGeneratedFindings = result.findings.length === 0;
  const supportingDetailGroups = supportingDetailsFor(result);
  const supportingDetailCount = supportingDetailGroups.reduce(
    (count, group) => count + group.details.length,
    0,
  );
  const recommendation = recommendationFor(result.verdict);
  const runFindingAction = async (
    findingId: string,
    state: FindingActionState,
    action: () => Promise<void>,
  ): Promise<boolean> => {
    if (admittedFindingIds.current.has(findingId)) return false;
    admittedFindingIds.current.add(findingId);
    setFindingActions((current) => {
      const next = new Map(current);
      next.set(findingId, state);
      return next;
    });
    clearFindingError(findingId);
    try {
      await action();
      return true;
    } catch (cause) {
      recordFindingError(
        findingId,
        contextualMessage(cause, FINDING_ACTION_MESSAGES),
      );
      return false;
    } finally {
      admittedFindingIds.current.delete(findingId);
      setFindingActions((current) => {
        const next = new Map(current);
        next.delete(findingId);
        return next;
      });
    }
  };
  const renderFindingRow = (finding: AnalysisFinding): React.JSX.Element =>
    finding.disposition === "dismissed" ? (
      <AnalysisDismissedFindingRow
        key={finding.id}
        finding={finding}
        location={findingLocation(finding)}
      />
    ) : (
      <AnalysisFindingRow
        key={finding.id}
        finding={finding}
        status={findingStatuses?.[finding.id]}
        needsReply={needsReplyFindingIds?.has(finding.id) ?? false}
        actionState={findingActions.get(finding.id)}
        actionError={findingErrors.get(finding.id)}
        {...(evidencePatch === undefined ? {} : { evidencePatch })}
        {...(onOpenFindingInDiff === undefined ? {} : { onOpenFindingInDiff })}
        {...(onAddFinding === undefined
          ? {}
          : {
              onAddFinding: async (value: AnalysisFinding) => {
                await runFindingAction(value.id, "adding", () =>
                  onAddFinding(value),
                );
              },
            })}
        {...(onDismissFinding === undefined
          ? {}
          : {
              onDismissFinding: async (
                value: AnalysisFinding,
                reason: string,
              ) => {
                const succeeded = await runFindingAction(
                  value.id,
                  "dismissing",
                  () => onDismissFinding(value, reason),
                );
                if (!succeeded) throw new Error("Finding dismissal failed");
              },
            })}
      />
    );

  return (
    <section
      aria-label="Analysis reader"
      className="flex w-full flex-col gap-3 pb-4"
    >
      <Card size="sm">
        <CardHeader>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge variant={recommendation.variant}>
              {analysisVerdictLabel(result.verdict)}
            </Badge>
            <Badge variant="outline">
              {hasNoGeneratedFindings ? "No findings" : handledProgress}
            </Badge>
            <Badge
              variant={checkStatus === "failing" ? "destructive" : "outline"}
            >
              CI · {checkStatusLabel(checkStatus)}
            </Badge>
          </div>
          <h2 className="text-lg font-semibold">{recommendation.heading}</h2>
          <CardDescription className="max-w-4xl">
            <GeneratedMarkdown markdown={result.summary} />
          </CardDescription>
          {canFinishWithAnalysisSummary &&
          onFinishWithAnalysisSummary !== undefined ? (
            <CardAction>
              <Button size="sm" onClick={onFinishWithAnalysisSummary}>
                Finish review
              </Button>
            </CardAction>
          ) : null}
        </CardHeader>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>
            {hasNoGeneratedFindings
              ? "No findings"
              : unhandledFindings.length === 0
                ? "No findings need attention"
                : "Needs attention"}
          </CardTitle>
          {hasNoGeneratedFindings ? null : (
            <CardDescription>{handledProgress}</CardDescription>
          )}
          <CardAction>
            <CopyFixPromptButton
              disabled={
                !result.findings.some(
                  (finding) => finding.disposition !== "dismissed",
                )
              }
              buildPrompt={() =>
                renderAnalysisFixPrompt({ context: fixPromptContext, result })
              }
            />
          </CardAction>
        </CardHeader>
        {hasNoGeneratedFindings ? (
          <CardContent>
            <p role="status" aria-label="No findings">
              Nothing to add or dismiss.
            </p>
          </CardContent>
        ) : (
          <CardContent className="flex flex-col gap-2">
            <ul className="flex flex-col gap-2">
              {(lowerSeverityFindings.length === 0 ||
              highSeverityFindings.length === 0
                ? result.findings
                : highSeverityFindings
              ).map(renderFindingRow)}
            </ul>
            {lowerSeverityFindings.length === 0 ||
            highSeverityFindings.length === 0 ? null : (
              <Collapsible
                open={lowerSeverityOpen || lowerSeverityFocused}
                onOpenChange={setLowerSeverityOpen}
              >
                <CollapsibleTrigger
                  render={<Button size="xs" variant="ghost" />}
                >
                  Lower severity ({lowerSeverityFindings.length})
                  <ChevronDownIcon data-icon="inline-end" />
                </CollapsibleTrigger>
                <CollapsibleContent motion="disclosure">
                  <ul className="flex flex-col gap-2 pt-2">
                    {lowerSeverityFindings.map(renderFindingRow)}
                  </ul>
                </CollapsibleContent>
              </Collapsible>
            )}
          </CardContent>
        )}
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>What changed</CardTitle>
        </CardHeader>
        <CardContent className="max-w-4xl">
          <GeneratedMarkdown markdown={result.changeSummary} />
        </CardContent>
      </Card>

      {result.validationPlan.length === 0 ? null : (
        <Card size="sm">
          <CardHeader>
            <CardTitle>Verification</CardTitle>
            <CardDescription>
              {verifiedSteps.size} of {result.validationPlan.length} checked.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {verification?.saveFailed === true ? (
              <InlineError className="pb-2">
                Verification ticks could not be saved.
              </InlineError>
            ) : null}
            <div className="flex flex-col gap-3">
              {result.validationPlan.map((step, index) => {
                const id = `analysis-verification-${index}`;
                return (
                  <Field key={step} orientation="horizontal">
                    <Checkbox
                      id={id}
                      checked={verifiedSteps.has(index)}
                      disabled={verification === undefined}
                      onCheckedChange={(checked) =>
                        verification?.setStepChecked(index, checked)
                      }
                    />
                    <FieldLabel
                      htmlFor={id}
                      className="text-sm leading-relaxed font-normal"
                    >
                      <GeneratedMarkdown markdown={step} />
                    </FieldLabel>
                  </Field>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {supportingDetailCount === 0 ? null : (
        <SupportingDetails
          groups={supportingDetailGroups}
          count={supportingDetailCount}
        />
      )}
    </section>
  );
}

/**
 * Copies the open findings as a markdown prompt. The label only flips to
 * "Copied" once the clipboard write resolves, so a rejection never claims
 * success.
 */
function CopyFixPromptButton({
  disabled,
  buildPrompt,
}: {
  readonly disabled: boolean;
  readonly buildPrompt: () => string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(
    () => () => {
      clearTimeout(copiedTimer.current);
    },
    [],
  );
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={disabled}
      title="For Codex or Claude Code"
      onClick={() => {
        navigator.clipboard
          .writeText(buildPrompt())
          .then(() => {
            setCopied(true);
            clearTimeout(copiedTimer.current);
            copiedTimer.current = setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => undefined);
      }}
    >
      {copied ? "Copied" : "Copy as markdown prompt"}
    </Button>
  );
}

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

function AnalysisFindingRow({
  finding,
  status,
  needsReply,
  actionState,
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
  const actionPending = actionState !== undefined;
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
            <p className="font-medium">{finding.title}</p>
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
          {needsReply ? (
            <Badge variant="warning">Needs your reply</Badge>
          ) : null}
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

function SupportingDetails({
  groups,
  count,
}: {
  readonly groups: ReadonlyArray<SupportingDetailGroup>;
  readonly count: number;
}): React.JSX.Element {
  return (
    <Collapsible>
      <Card size="sm">
        <CardHeader>
          <CardTitle>Supporting details</CardTitle>
          <CardDescription>
            {count} supporting detail{count === 1 ? "" : "s"} in {groups.length}{" "}
            group{groups.length === 1 ? "" : "s"}
          </CardDescription>
          <CardAction>
            <CollapsibleTrigger render={<Button size="xs" variant="outline" />}>
              Show details
              <ChevronDownIcon data-icon="inline-end" />
            </CollapsibleTrigger>
          </CardAction>
        </CardHeader>
        <CollapsibleContent motion="disclosure">
          <CardContent className="border-t pt-3">
            <div className="grid gap-4 lg:grid-cols-2">
              {groups.map((group) => (
                <section
                  key={group.key}
                  aria-labelledby={`supporting-${group.key}`}
                >
                  <h3
                    id={`supporting-${group.key}`}
                    className="mb-2 text-sm font-medium"
                  >
                    {group.title}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      {group.details.length}
                    </span>
                  </h3>
                  <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-muted-foreground">
                    {group.details.map((detail) => (
                      <li key={detail.key}>
                        {detail.heading === undefined ? null : (
                          <strong className="text-foreground">
                            {detail.heading}:{" "}
                          </strong>
                        )}
                        <GeneratedMarkdown
                          markdown={detail.markdown}
                          className="inline"
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

function supportingDetailsFor(
  result: AnalysisResult,
): ReadonlyArray<SupportingDetailGroup> {
  const callouts: SupportingDetail[] = [];
  const unresolved: SupportingDetail[] = [];
  const assumptions: SupportingDetail[] = [];
  const accepted: SupportingDetail[] = [];
  for (const callout of result.callouts ?? []) {
    const detail = {
      key: `callout-${callout.category}-${callout.title}`,
      heading: callout.title,
      markdown: callout.detail,
      comparisonTexts: [callout.title, `${callout.title} ${callout.detail}`],
    };
    if (addSupportingDetail(accepted, detail)) callouts.push(detail);
  }
  for (const item of result.unresolvedItems ?? []) {
    const detail = {
      key: `unresolved-${item}`,
      markdown: item,
      comparisonTexts: [item],
    };
    if (addSupportingDetail(accepted, detail)) unresolved.push(detail);
  }
  for (const item of result.assumptions) {
    const detail = {
      key: `assumption-${item}`,
      markdown: item,
      comparisonTexts: [item],
    };
    if (addSupportingDetail(accepted, detail)) assumptions.push(detail);
  }
  return [
    { key: "callouts", title: "Reviewer callouts", details: callouts },
    { key: "questions", title: "Open questions", details: unresolved },
    { key: "assumptions", title: "Assumptions", details: assumptions },
  ].filter((group) => group.details.length > 0);
}

function addSupportingDetail(
  details: SupportingDetail[],
  candidate: SupportingDetail,
): boolean {
  const duplicatesExistingDetail = details.some((detail) =>
    candidate.comparisonTexts.some((candidateText) =>
      detail.comparisonTexts.some((existingText) =>
        describesSameTopic(candidateText, existingText),
      ),
    ),
  );
  if (duplicatesExistingDetail) return false;
  details.push(candidate);
  return true;
}

function describesSameTopic(left: string, right: string): boolean {
  const leftTokens = significantTokens(left);
  const rightTokens = significantTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return false;
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared += 1;
  }
  return (
    shared >= 3 && shared / Math.min(leftTokens.size, rightTokens.size) >= 0.55
  );
}

function significantTokens(value: string): ReadonlySet<string> {
  return new Set(
    value
      .toLowerCase()
      .replaceAll("_", " ")
      .match(/[a-z0-9]+/g)
      ?.filter((token) => token.length > 2 || /^\d+$/.test(token)) ?? [],
  );
}

function findingLocation(finding: AnalysisFinding): string | undefined {
  return finding.file === undefined
    ? undefined
    : `${finding.file}${finding.lineStart === undefined ? "" : `:${finding.lineStart}`}`;
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

function isHighSeverity(finding: AnalysisFinding): boolean {
  return finding.severity === "P0" || finding.severity === "P1";
}

type VerdictPresentation = {
  readonly heading: string;
  readonly variant: "secondary" | "default" | "destructive";
};

function recommendationFor(
  verdict: AnalysisResult["verdict"],
): VerdictPresentation {
  switch (verdict) {
    case "approve":
      return {
        heading: "The change is ready for your final review.",
        variant: "secondary",
      };
    case "request_changes":
      return {
        heading: "Resolve the blocking findings before approval.",
        variant: "destructive",
      };
    case "comment":
      return {
        heading: "Review the highlighted concern before you finish.",
        variant: "default",
      };
  }
}
