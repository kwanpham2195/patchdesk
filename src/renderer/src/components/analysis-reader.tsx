import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import type { WorkbenchResponse } from "../renderer-contracts";

type AnalysisResult = NonNullable<WorkbenchResponse["insights"]["analysis"]["retained"]>["value"];
type AnalysisFinding = AnalysisResult["findings"][number];

export type AnalysisReaderProps = {
  readonly result: AnalysisResult;
  readonly onBack: () => void;
  readonly onAddFinding?: (finding: AnalysisFinding) => Promise<void>;
};

/** Persistent read-side view of one retained Analysis result. */
export function AnalysisReader({ result, onBack, onAddFinding }: AnalysisReaderProps): React.JSX.Element {
  return (
    <section aria-label="Analysis reader" className="flex w-full max-w-4xl flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Analysis reader</p>
          <h2 className="text-xl font-semibold">{result.changeSummary}</h2>
        </div>
        <Button variant="outline" size="sm" onClick={onBack}>Back to Insights</Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
          <CardDescription>Patchdesk-owned analysis for this retained Review snapshot.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p>{result.summary}</p>
          <p><span className="font-medium">Verdict:</span> {result.verdict.replace("_", " ")}</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Findings</CardTitle>
          <CardDescription>{result.findings.length} finding{result.findings.length === 1 ? "" : "s"} retained with this Analysis.</CardDescription>
        </CardHeader>
        <CardContent>
          {result.findings.length === 0 ? <p className="text-sm text-muted-foreground">No Findings were reported.</p> : (
            <ul className="flex flex-col gap-3">
              {result.findings.map((finding) => <AnalysisFindingRow key={finding.id} finding={finding} {...(onAddFinding === undefined ? {} : { onAddFinding })} />)}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Validation plan</CardTitle></CardHeader>
        <CardContent>
          {result.validationPlan.length === 0 ? <p className="text-sm text-muted-foreground">No validation steps were provided.</p> : <ol className="list-decimal space-y-1 pl-5 text-sm">{result.validationPlan.map((step) => <li key={step}>{step}</li>)}</ol>}
        </CardContent>
      </Card>
    </section>
  );
}

function AnalysisFindingRow({ finding, onAddFinding }: { readonly finding: AnalysisFinding; readonly onAddFinding?: (finding: AnalysisFinding) => Promise<void> }): React.JSX.Element {
  const disposition = finding.disposition ?? "open";
  return (
    <li className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{finding.title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{finding.explanation}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={disposition === "dismissed" ? "outline" : disposition === "added" ? "secondary" : "default"}>{disposition}</Badge>
          {disposition === "open" && onAddFinding !== undefined ? <Button size="xs" variant="outline" onClick={() => void onAddFinding(finding)}>Add</Button> : null}
        </div>
      </div>
      {finding.file !== undefined ? <p className="mt-2 text-xs text-muted-foreground">{finding.file}{finding.lineStart === undefined ? "" : `:${finding.lineStart}`}</p> : null}
    </li>
  );
}
