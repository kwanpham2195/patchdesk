import { useState } from "react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import type { WorkbenchResponse } from "../renderer-contracts";
import { mapFindingLocation, parseUnifiedPatch } from "../../../domain/patch";
import { FindingEvidenceHunk } from "./finding-evidence-hunk";

type AnalysisResult = NonNullable<WorkbenchResponse["insights"]["analysis"]["retained"]>["value"];
type AnalysisFinding = AnalysisResult["findings"][number];

export type AnalysisReaderProps = {
  readonly result: AnalysisResult;
  readonly onBack: () => void;
  readonly onAddFinding?: (finding: AnalysisFinding) => Promise<void>;
  readonly onDismissFinding?: (finding: AnalysisFinding, reason: string) => Promise<void>;
  readonly findingStatuses?: Readonly<Record<string, "actionable" | "pending_review" | "published" | "locked">>;
  readonly evidencePatch?: string;
  readonly canFinishWithAnalysisSummary?: boolean;
  readonly onFinishWithAnalysisSummary?: () => void;
  readonly scope: {
    readonly baseShort: string;
    readonly headShort: string;
    readonly commitCount: number;
    readonly fileCount: number;
    readonly additions: number;
    readonly deletions: number;
    readonly changedFiles: ReadonlyArray<{ readonly path: string; readonly additions: number; readonly deletions: number }>;
  };
};

/** Persistent read-side view of one retained Analysis result. */
export function AnalysisReader({ result, onBack, onAddFinding, onDismissFinding, findingStatuses, evidencePatch, canFinishWithAnalysisSummary = false, onFinishWithAnalysisSummary, scope }: AnalysisReaderProps): React.JSX.Element {
  const [actionError, setActionError] = useState<string | undefined>();
  const runAction = async (action: () => Promise<void>): Promise<void> => {
    setActionError(undefined);
    try { await action(); } catch { setActionError("The Finding action could not be saved. Try again."); }
  };
  return (
    <section aria-label="Analysis reader" className="flex w-full max-w-4xl flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Analysis reader</p>
          <h2 className="text-xl font-semibold">{result.changeSummary}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canFinishWithAnalysisSummary && onFinishWithAnalysisSummary !== undefined ? <Button size="sm" onClick={onFinishWithAnalysisSummary}>Finish review with Analysis summary</Button> : null}
          <Button variant="outline" size="sm" onClick={onBack}>Back to Insights</Button>
        </div>
      </div>
      {actionError !== undefined ? <p role="alert" className="text-sm text-destructive">{actionError}</p> : null}
      <Card>
        <CardHeader>
          <CardTitle>Review Scope</CardTitle>
          <CardDescription>{scope.commitCount} commits, {scope.fileCount} files, +{scope.additions}/-{scope.deletions}</CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          <p>Diff: <code>{scope.baseShort}...{scope.headShort}</code></p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Pull Request Overview</CardTitle>
          <CardDescription>Patchdesk-owned analysis for this retained Review snapshot.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p>{result.changeSummary}</p>
          <p>{result.summary}</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Reviewed Changes</CardTitle></CardHeader>
        <CardContent className="text-sm">
          {scope.changedFiles.length > 0 ? <ul className="list-disc pl-5">{scope.changedFiles.map((file) => <li key={file.path}><code>{file.path}</code> (+{file.additions}/-{file.deletions})</li>)}</ul> : <p className="text-muted-foreground">No changed files were reported.</p>}
        </CardContent>
      </Card>
      {result.validationPlan.length > 0 ? <Card>
        <CardHeader><CardTitle>Verification</CardTitle></CardHeader>
        <CardContent><ol className="list-decimal space-y-1 pl-5 text-sm">{result.validationPlan.map((step) => <li key={step}>{step}</li>)}</ol></CardContent>
      </Card> : null}
      <Card>
        <CardHeader>
          <CardTitle>Findings</CardTitle>
          <CardDescription>{result.findings.length} finding{result.findings.length === 1 ? "" : "s"} retained with this Analysis.</CardDescription>
        </CardHeader>
        <CardContent>
          {result.findings.length === 0 ? <p className="text-sm text-muted-foreground">No Findings were reported.</p> : (
            <ul className="flex flex-col gap-3">
              {result.findings.map((finding) => <AnalysisFindingRow key={finding.id} finding={finding} status={findingStatuses?.[finding.id]} {...(evidencePatch === undefined ? {} : { evidencePatch })} {...(onAddFinding === undefined ? {} : { onAddFinding: (value) => runAction(() => onAddFinding(value)) })} {...(onDismissFinding === undefined ? {} : { onDismissFinding: (value, reason) => runAction(() => onDismissFinding(value, reason)) })} />)}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Verdict</CardTitle></CardHeader>
        <CardContent className="text-sm"><p>{result.verdict.replace("_", " ")}</p></CardContent>
      </Card>
      {result.callouts?.length || result.unresolvedItems?.length || result.assumptions.length ? <Card>
        <CardHeader><CardTitle>Human Reviewer Callouts</CardTitle></CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm">{result.callouts?.map((callout) => <li key={`${callout.category}-${callout.title}`}><strong>{callout.title}:</strong> {callout.detail}</li>)}{result.unresolvedItems?.map((item) => <li key={`unresolved-${item}`}>Unresolved: {item}</li>)}{result.assumptions.map((item) => <li key={`assumption-${item}`}>Assumption: {item}</li>)}</ul>
        </CardContent>
      </Card> : null}
    </section>
  );
}

function AnalysisFindingRow({ finding, status, evidencePatch, onAddFinding, onDismissFinding }: { readonly finding: AnalysisFinding; readonly status?: "actionable" | "pending_review" | "published" | "locked" | undefined; readonly evidencePatch?: string | undefined; readonly onAddFinding?: (finding: AnalysisFinding) => Promise<void>; readonly onDismissFinding?: (finding: AnalysisFinding, reason: string) => Promise<void> }): React.JSX.Element {
  const [reason, setReason] = useState("");
  const disposition = finding.disposition ?? "open";
  const reviewStatus = status ?? (disposition === "dismissed" ? "dismissed" : "unavailable");
  const evidenceAnchor = evidencePatch === undefined || finding.file === undefined || finding.lineStart === undefined
    ? undefined
    : (() => {
        const location = mapFindingLocation(parseUnifiedPatch(evidencePatch), { file: finding.file, lineStart: finding.lineStart, ...(finding.lineEnd === undefined ? {} : { lineEnd: finding.lineEnd }), ...(finding.diffSide === undefined ? {} : { diffSide: finding.diffSide }) });
        return location.mappingStatus === "mapped" && location.path !== undefined && location.line !== undefined && location.side !== undefined
          ? { path: location.path, startLine: location.startLine ?? location.line, line: location.line, side: location.side }
          : undefined;
      })();
  return (
    <li className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{finding.title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{finding.explanation}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={reviewStatus === "published" || reviewStatus === "pending_review" ? "secondary" : reviewStatus === "locked" || disposition === "dismissed" ? "outline" : "default"}>{reviewStatus.replaceAll("_", " ")}</Badge>
          {disposition === "open" && reviewStatus === "actionable" && onAddFinding !== undefined ? <Button size="xs" variant="outline" onClick={() => onAddFinding(finding)}>Add to review</Button> : null}
          {disposition === "open" && onDismissFinding !== undefined ? <Button size="xs" variant="ghost" onClick={() => onDismissFinding(finding, reason)} disabled={reason.trim().length === 0}>Dismiss</Button> : null}
        </div>
      </div>
      {finding.file !== undefined ? <p className="mt-2 text-xs text-muted-foreground">{finding.file}{finding.lineStart === undefined ? "" : `:${finding.lineStart}`}</p> : null}
      {evidencePatch === undefined || evidenceAnchor === undefined ? null : <FindingEvidenceHunk patch={evidencePatch} anchor={evidenceAnchor} />}
      {reviewStatus === "locked" ? <p className="mt-2 text-sm text-muted-foreground">Check GitHub again before changing this Finding.</p> : null}
      {disposition === "open" && onDismissFinding !== undefined ? <input aria-label={`Dismiss reason for ${finding.title}`} className="mt-2 w-full rounded border px-2 py-1 text-sm" placeholder="Dismissal reason" value={reason} onChange={(event) => setReason(event.target.value)} /> : null}
    </li>
  );
}
