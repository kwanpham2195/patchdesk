import { useContext, useEffect, useRef, useState } from "react";
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
import type { ReviewVerdictState } from "../../../domain/review-verdicts";
import {
  analysisVerdictLabel,
  checkStatusLabel,
  findingLocation,
  unhandledAnalysisFindings,
  type AnalysisFindingStatus as FindingStatus,
  type AnalysisResult,
  type CheckStatus,
} from "../analysis-headline";
import type { AddAllFindingsControls } from "../flows/use-add-all-findings";
import type { LocalApplyControls } from "../flows/use-local-apply";
import { AnalysisAddAllFindings } from "./analysis-add-all-findings";
import { AnalysisDismissedFindingRow } from "./analysis-dismissed-finding-row";
import {
  AnalysisFindingRow,
  type FindingActionState,
} from "./analysis-finding-row";
import { LocalApplyBar } from "./local-apply-bar";
import { ReviewWorkbenchFindingNavigationContext } from "./review-workbench-finding-navigation";
import { GeneratedMarkdown } from "./generated-markdown";
import { ReviewVerdictIcon } from "./review-verdict-icon";
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
import { InlineError } from "./ui/inline-error";

type AnalysisFinding = AnalysisResult["findings"][number];
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
  /** Absent when the CI result is not worth a badge, such as unknown checks on a merged pull request. */
  readonly checkStatus?: CheckStatus;
  readonly canFinishWithAnalysisSummary?: boolean;
  readonly onFinishWithAnalysisSummary?: () => void;
  /** Opens the Diff tab at a mapped finding's lines. */
  readonly onOpenFindingInDiff?: (finding: AnalysisFinding) => void;
  /** Names the repository and branches in the copied fix prompt. */
  readonly fixPromptContext?: AnalysisFixPromptContext | undefined;
  /** Saved Verification ticks; without it the checklist is read-only. */
  readonly verification?: AnalysisVerificationControls;
  /** Batch Add; offered only alongside `onAddFinding`. */
  readonly addAllFindings?: AddAllFindingsControls;
  /** Apply suggestion on a working-tree local Review (ADR 0050). */
  readonly localApply?: LocalApplyControls;
};

/** Decision-first read-side view of one retained Analysis result. */
export function AnalysisReader({
  result,
  onAddFinding,
  onDismissFinding,
  findingStatuses,
  needsReplyFindingIds,
  evidencePatch,
  checkStatus,
  canFinishWithAnalysisSummary = false,
  onFinishWithAnalysisSummary,
  onOpenFindingInDiff,
  fixPromptContext,
  verification,
  addAllFindings,
  localApply,
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
  const batchProgress = addAllFindings?.progress;
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
        actionState={
          batchProgress?.currentFindingId === finding.id
            ? "adding"
            : findingActions.get(finding.id)
        }
        actionsDisabled={batchProgress !== undefined}
        actionError={findingErrors.get(finding.id)}
        {...definedProps({
          applySelection: applySelectionFor(localApply, finding.id),
        })}
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
      <AnalysisVerdictCard
        result={result}
        badge={hasNoGeneratedFindings ? "No findings" : handledProgress}
        {...definedProps({
          checkStatus,
          onFinishWithAnalysisSummary: canFinishWithAnalysisSummary
            ? onFinishWithAnalysisSummary
            : undefined,
        })}
      />

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
          <CardAction className="flex flex-wrap items-center justify-end gap-2">
            {addAllFindings === undefined ||
            onAddFinding === undefined ? null : (
              <AnalysisAddAllFindings
                findings={[...highSeverityFindings, ...lowerSeverityFindings]}
                findingStatuses={findingStatuses}
                controls={addAllFindings}
                disabled={findingActions.size > 0}
                onClearError={clearFindingError}
                onFailed={(findingId, message) => {
                  recordFindingError(findingId, message);
                  // The failed row must be visible to show its error.
                  if (lowerSeverityFindings.some(({ id }) => id === findingId))
                    setLowerSeverityOpen(true);
                }}
              />
            )}
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
            {localApply === undefined ? null : (
              <LocalApplyBar controls={localApply} findings={result.findings} />
            )}
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

/** A row's Apply checkbox; absent outside a working-tree Review. */
function applySelectionFor(
  localApply: LocalApplyControls | undefined,
  findingId: string,
) {
  if (localApply === undefined) return undefined;
  return {
    selected: localApply.selectedIds.has(findingId),
    disabled:
      localApply.pending || localApply.blocked || localApply.lock !== undefined,
    onChange: (selected: boolean) =>
      localApply.setSelected(findingId, selected),
  };
}

function AnalysisVerdictCard({
  result,
  badge,
  checkStatus,
  onFinishWithAnalysisSummary,
}: {
  readonly result: AnalysisResult;
  readonly badge: string;
  readonly checkStatus?: CheckStatus;
  readonly onFinishWithAnalysisSummary?: () => void;
}): React.JSX.Element {
  const recommendation = recommendationFor(result.verdict);
  return (
    <Card size="sm">
      <CardHeader>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge variant={recommendation.variant}>
            <ReviewVerdictIcon verdict={recommendation.reviewVerdict} />
            {analysisVerdictLabel(result.verdict)}
          </Badge>
          <Badge variant="outline">{badge}</Badge>
          {checkStatus === undefined ? null : (
            <Badge
              variant={checkStatus === "failing" ? "destructive" : "outline"}
            >
              CI · {checkStatusLabel(checkStatus)}
            </Badge>
          )}
        </div>
        <h2 className="text-lg font-semibold">{recommendation.heading}</h2>
        <CardDescription className="max-w-4xl">
          <GeneratedMarkdown markdown={result.summary} />
        </CardDescription>
        {onFinishWithAnalysisSummary !== undefined ? (
          <CardAction>
            <Button size="sm" onClick={onFinishWithAnalysisSummary}>
              Finish review
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
    </Card>
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

function isHighSeverity(finding: AnalysisFinding): boolean {
  return finding.severity === "P0" || finding.severity === "P1";
}

type VerdictPresentation = {
  readonly heading: string;
  readonly reviewVerdict: ReviewVerdictState;
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
        reviewVerdict: "approved",
      };
    case "request_changes":
      return {
        heading: "Resolve the blocking findings before approval.",
        variant: "destructive",
        reviewVerdict: "changes_requested",
      };
    case "comment":
      return {
        heading: "Review the highlighted concern before you finish.",
        variant: "default",
        reviewVerdict: "commented",
      };
  }
}
