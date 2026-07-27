import { useEffect } from "react";

import { App } from "../renderer/src/app";
import { requestJson } from "../renderer/src/api-client";
import { BrandMark } from "../renderer/src/components/brand-mark";
import { MergeConfirmationDialog } from "../renderer/src/components/merge-confirmation-dialog";
import { ReviewSubmissionDialog } from "../renderer/src/components/review-submission-dialog";
import { Badge } from "../renderer/src/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../renderer/src/components/ui/card";
import { submissionFixtureData } from "../renderer/src/flows/app-fixtures";
import { scenarioFromLocation, scenarioUrl, designScenarios } from "./scenarios";

export function DesignApp(): React.JSX.Element {
  const scenario = scenarioFromLocation();
  useEffect(() => { document.title = scenario === undefined ? "Patchdesk Design" : `Patchdesk Design · ${scenario.title}`; }, [scenario]);
  if (scenario === undefined) return <DesignIndex />;
  if (scenario.id === "dialog-submit") return <DesignSubmissionScenario />;
  if (scenario.id === "dialog-merge") return <DesignMergeScenario />;
  return <App />;
}

function DesignSubmissionScenario(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <ReviewSubmissionDialog
        defaultOpen
        draft={submissionFixtureData.draft as never}
        findings={submissionFixtureData.findings as never}
        onCreatePending={async () => readReviewId(await requestJson("/v1/reviews/pending", { method: "POST", body: { profileId: "cfw", sessionId: "design-session" } }))}
        onSubmitPending={async (event, summaryBody) => readReviewId(await requestJson("/v1/reviews/submit", { method: "POST", body: { profileId: "cfw", sessionId: "design-session", event, summaryBody } }))}
      />
    </div>
  );
}

function DesignMergeScenario(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <MergeConfirmationDialog
        defaultOpen
        readiness={{ _tag: "NeedsAcknowledgement", blockers: [], warnings: ["request_changes", "high_severity_finding"] }}
        context={{ repo: "centraldigital/patchdesk", prNumber: 42, title: "Protect review writes", base: "sit", head: "feat/review", headSha: "abcdef1234567890" }}
        methods={["squash", "merge"]}
        onMerge={async (method, acknowledgedWarnings) => {
          const response = await requestJson("/v1/reviews/merge", { method: "POST", body: { profileId: "cfw", sessionId: "design-session", method, acknowledgedWarnings } });
          return isRecord(response) && typeof response.mergeCommitSha === "string" ? { mergeCommitSha: response.mergeCommitSha } : {};
        }}
      />
    </div>
  );
}

async function readReviewId(value: unknown): Promise<{ readonly reviewId: string }> {
  if (isRecord(value) && typeof value.reviewId === "string") return { reviewId: value.reviewId };
  throw new Error("Design mock did not return a review ID");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function DesignIndex(): React.JSX.Element {
  const groups = ["Inbox", "Review workbench", "Settings and dialogs"] as const;
  return (
    <main className="min-h-screen bg-background px-6 py-10 text-foreground sm:px-8 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <header className="flex items-start gap-3">
          <BrandMark size={36} />
          <div>
            <p className="text-sm font-medium text-primary">Patchdesk Design</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">Interactive visual prototype</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Open a stable design scenario to review the real Patchdesk renderer with deterministic mock data. Product surfaces do not connect to GitHub, the filesystem, or Electron.</p>
          </div>
        </header>
        <div className="mt-12 space-y-12">
          {groups.map((group) => (
            <section key={group} aria-labelledby={`design-group-${group}`}>
              <div className="mb-4 flex items-center gap-2 border-b border-border/60 pb-3"><h2 id={`design-group-${group}`} className="text-sm font-semibold">{group}</h2><Badge variant="outline">{designScenarios.filter((scenario) => scenario.group === group).length} scenarios</Badge></div>
              <div className="grid gap-4 lg:grid-cols-2">
                {designScenarios.filter((scenario) => scenario.group === group).map((item) => (
                  <a key={item.id} href={scenarioUrl(item.id)} className="group block h-full rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <Card className="flex flex-col gap-0 h-full min-h-36 border border-border/80 bg-card/80 p-0 transition-colors hover:border-primary/50">
                      <CardHeader className="grid grid-cols-1 gap-2 border-b border-border/60 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-3">
                        <CardTitle className="min-w-0 text-base font-semibold leading-6">{item.title}</CardTitle>
                        <CardDescription className="w-fit rounded-md bg-muted/60 px-2 py-1 font-mono text-[11px] leading-4 text-muted-foreground">{item.id}</CardDescription>
                      </CardHeader>
                      <CardContent className="px-5 py-4 text-sm leading-6 text-muted-foreground">{item.description}</CardContent>
                    </Card>
                  </a>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
