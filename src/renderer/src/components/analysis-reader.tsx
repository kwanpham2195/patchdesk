import { useState } from "react";
import { ChevronDownIcon } from "lucide-react";

import { mapFindingLocation, parseUnifiedPatch } from "../../../domain/patch";
import type { WorkbenchResponse } from "../renderer-contracts";
import { FindingEvidenceHunk } from "./finding-evidence-hunk";
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
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "./ui/popover";

type AnalysisResult = NonNullable<
  WorkbenchResponse["insights"]["analysis"]["retained"]
>["value"];
type AnalysisFinding = AnalysisResult["findings"][number];
type FindingStatus = "actionable" | "pending_review" | "published" | "locked";
type CheckStatus = WorkbenchResponse["checks"]["overall"];

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
  readonly evidencePatch?: string;
  readonly checkStatus?: CheckStatus;
  readonly canFinishWithAnalysisSummary?: boolean;
  readonly onFinishWithAnalysisSummary?: () => void;
};

/** Decision-first read-side view of one retained Analysis result. */
export function AnalysisReader({
  result,
  onAddFinding,
  onDismissFinding,
  findingStatuses,
  evidencePatch,
  checkStatus = "unknown",
  canFinishWithAnalysisSummary = false,
  onFinishWithAnalysisSummary,
}: AnalysisReaderProps): React.JSX.Element {
  const [actionError, setActionError] = useState<string | undefined>();
  const [verifiedSteps, setVerifiedSteps] = useState<ReadonlySet<number>>(
    new Set(),
  );
  const openFindings = result.findings.filter(
    (finding) => (finding.disposition ?? "open") === "open",
  );
  const supportingDetailGroups = supportingDetailsFor(result);
  const supportingDetailCount = supportingDetailGroups.reduce(
    (count, group) => count + group.details.length,
    0,
  );
  const recommendation = recommendationFor(result.verdict);
  const runAction = async (action: () => Promise<void>): Promise<void> => {
    setActionError(undefined);
    try {
      await action();
    } catch {
      setActionError("The Finding action could not be saved. Try again.");
    }
  };
  const setStepChecked = (index: number, checked: boolean): void => {
    setVerifiedSteps((current) => {
      const next = new Set(current);
      if (checked) next.add(index);
      else next.delete(index);
      return next;
    });
  };

  return (
    <section
      aria-label="Analysis reader"
      className="flex w-full flex-col gap-3 pb-4"
    >
      {actionError === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}

      <Card size="sm">
        <CardHeader>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge variant={recommendation.variant}>
              {recommendation.label}
            </Badge>
            <Badge variant="outline">
              {openFindings.length === 0
                ? "No findings need attention"
                : `${openFindings.length} ${openFindings.length === 1 ? "item needs" : "items need"} attention`}
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
            {openFindings.length === 0 ? "No findings" : "Needs attention"}
          </CardTitle>
          <CardDescription>
            {openFindings.length === 0
              ? "Analysis did not identify an item that needs review action."
              : "Resolve or add each item before you finish the review."}
          </CardDescription>
        </CardHeader>
        {result.findings.length === 0 ? null : (
          <CardContent>
            <ul className="flex flex-col gap-2">
              {result.findings.map((finding) => (
                <AnalysisFindingRow
                  key={finding.id}
                  finding={finding}
                  status={findingStatuses?.[finding.id]}
                  {...(evidencePatch === undefined ? {} : { evidencePatch })}
                  {...(onAddFinding === undefined
                    ? {}
                    : {
                        onAddFinding: (value) =>
                          runAction(() => onAddFinding(value)),
                      })}
                  {...(onDismissFinding === undefined
                    ? {}
                    : {
                        onDismissFinding: (value, reason) =>
                          runAction(() => onDismissFinding(value, reason)),
                      })}
                />
              ))}
            </ul>
          </CardContent>
        )}
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>What changed</CardTitle>
          <CardDescription>
            The implementation in this retained Review snapshot.
          </CardDescription>
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
              {verifiedSteps.size} of {result.validationPlan.length} checked in
              this view
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-3">
              {result.validationPlan.map((step, index) => {
                const id = `analysis-verification-${index}`;
                return (
                  <Field key={step} orientation="horizontal">
                    <Checkbox
                      id={id}
                      checked={verifiedSteps.has(index)}
                      onCheckedChange={(checked) =>
                        setStepChecked(index, checked)
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

function AnalysisFindingRow({
  finding,
  status,
  evidencePatch,
  onAddFinding,
  onDismissFinding,
}: {
  readonly finding: AnalysisFinding;
  readonly status?: FindingStatus | undefined;
  readonly evidencePatch?: string | undefined;
  readonly onAddFinding?: (finding: AnalysisFinding) => Promise<void>;
  readonly onDismissFinding?: (
    finding: AnalysisFinding,
    reason: string,
  ) => Promise<void>;
}): React.JSX.Element {
  const [reason, setReason] = useState("");
  const [dismissOpen, setDismissOpen] = useState(false);
  const disposition = finding.disposition ?? "open";
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
              ...(finding.lineEnd === undefined
                ? {}
                : { lineEnd: finding.lineEnd }),
              ...(finding.diffSide === undefined
                ? {}
                : { diffSide: finding.diffSide }),
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
    await onDismissFinding(finding, reason.trim());
    setDismissOpen(false);
    setReason("");
  };

  return (
    <li className="rounded-lg border bg-background p-3">
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
          {finding.file === undefined ? null : (
            <p className="mt-2 truncate text-xs text-muted-foreground">
              {finding.file}
              {finding.lineStart === undefined ? "" : `:${finding.lineStart}`}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Badge
            variant={
              reviewStatus === "published" || reviewStatus === "pending_review"
                ? "secondary"
                : "outline"
            }
          >
            {reviewStatus.replaceAll("_", " ")}
          </Badge>
          {disposition === "open" &&
          reviewStatus === "actionable" &&
          finding.mappingStatus === "mapped" &&
          onAddFinding !== undefined ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => onAddFinding(finding)}
            >
              Add to review
            </Button>
          ) : null}
          {disposition === "open" && onDismissFinding !== undefined ? (
            <Popover open={dismissOpen} onOpenChange={setDismissOpen}>
              <PopoverTrigger render={<Button size="xs" variant="ghost" />}>
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
                    onClick={() => setDismissOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="xs"
                    disabled={reason.trim().length === 0}
                    onClick={() => dismiss()}
                  >
                    Confirm dismissal
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      </div>
      {reviewStatus === "locked" ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Patchdesk cannot safely change this Finding because its exact GitHub
          comment is not confirmed.
        </p>
      ) : null}
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

function recommendationFor(verdict: AnalysisResult["verdict"]): {
  readonly label: string;
  readonly heading: string;
  readonly variant: "secondary" | "default" | "destructive";
} {
  switch (verdict) {
    case "approve":
      return {
        label: "Ready to approve",
        heading: "The change is ready for your final review.",
        variant: "secondary",
      };
    case "request_changes":
      return {
        label: "Changes requested",
        heading: "Resolve the blocking findings before approval.",
        variant: "destructive",
      };
    case "comment":
      return {
        label: "Comment recommended",
        heading: "Review the highlighted concern before you finish.",
        variant: "default",
      };
  }
}

function checkStatusLabel(status: CheckStatus): string {
  switch (status) {
    case "passing":
      return "Passing";
    case "failing":
      return "Failing";
    case "pending":
      return "Pending";
    case "skipped":
      return "Skipped";
    case "unknown":
      return "Unknown";
  }
}
