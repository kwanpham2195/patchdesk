import { useEffect, useState } from "react";

import { App } from "../renderer/src/app";
import { requestJson } from "../renderer/src/api-client";
import { BrandMark } from "../renderer/src/components/brand-mark";
import { MergeConfirmationDialog } from "../renderer/src/components/merge-confirmation-dialog";
import { ReviewSubmissionDialog } from "../renderer/src/components/review-submission-dialog";
import { Badge } from "../renderer/src/components/ui/badge";
import { Button } from "../renderer/src/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../renderer/src/components/ui/card";
import { submissionFixtureData } from "../renderer/src/flows/app-fixtures";
import { scenarioFromLocation, scenarioUrl, designScenarios } from "./scenarios";
import { DesignRecoveryChip } from "./design-recovery";
import { designInboxRecoveryFixtureFor, designRecoveryFixtureFor } from "./mock-bridge";
import { DesignSettingsOverlay } from "./design-settings-overlay";
import { DesignWalkthroughScenario } from "./design-walkthrough-scenario";

export function DesignApp(): React.JSX.Element {
  const scenario = scenarioFromLocation();
  useEffect(() => { document.title = scenario === undefined ? "Patchdesk Design" : `Patchdesk Design · ${scenario.title}`; }, [scenario]);
  if (scenario === undefined) return <DesignIndex />;
  if (scenario.id === "dialog-submit") return <DesignSubmissionScenario />;
  if (scenario.id === "dialog-merge") return <DesignMergeScenario />;
  if (scenario.id === "settings-recovery") return <DesignSettingsScenario />;
  if (scenario.id === "dialog-clear-local-data") return <DesignCleanupDialogScenario />;
  if (scenario.id === "inbox-recovery-states") return <DesignInboxRecoveryScenario />;
  if (scenario.id === "workbench-reconnect" || scenario.id === "workbench-start-again" || scenario.id === "workbench-try-again" || scenario.id === "workbench-prepare-again") return <DesignWorkbenchRecoveryScenario />;
  if (scenario.id === "walkthrough-generate-dialog") return <DesignWalkthroughScenario variant="walkthrough-generate-dialog" layout="rail" />;
  if (scenario.id === "walkthrough-generating") return <DesignWalkthroughScenario variant="walkthrough-generating" layout="rail" />;
  if (scenario.id === "walkthrough-ready") return <DesignWalkthroughScenario variant="walkthrough-ready" layout="rail" />;
  if (scenario.id === "walkthrough-failed") return <DesignWalkthroughScenario variant="walkthrough-failed" layout="rail" />;
  if (scenario.id === "walkthrough-stale") return <DesignWalkthroughScenario variant="walkthrough-stale" layout="rail" />;
  if (scenario.id === "walkthrough-ready-rail") return <DesignWalkthroughScenario variant="walkthrough-ready" layout="rail" />;
  if (scenario.id === "walkthrough-ready-linear") return <DesignWalkthroughScenario variant="walkthrough-ready" layout="linear" />;
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

function DesignSettingsScenario(): React.JSX.Element {
  return <DesignSettingsScenarioContent />;
}

function DesignSettingsScenarioContent(): React.JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <div className="min-h-screen bg-background p-6" data-testid="settings-recovery-stage">
      <p className="mb-4 text-sm text-muted-foreground">Settings is rendered as a centered overlay on top of any scenario route.</p>
      <Button onClick={() => setOpen(true)}>Reopen Settings</Button>
      {open ? <DesignSettingsOverlay onClose={() => setOpen(false)} initialSection="general" /> : null}
    </div>
  );
}

function DesignCleanupDialogScenario(): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const [pendingCleanup, setPendingCleanup] = useState<"clear_cache" | "clear_local_review_data" | undefined>("clear_local_review_data");
  return (
    <div className="min-h-screen bg-background p-6" data-testid="settings-cleanup-stage">
      <p className="mb-4 text-sm text-muted-foreground">The destructive cleanup confirmation shows what stays and what goes. Settings always opens on General.</p>
      <Button onClick={() => { setOpen(true); setPendingCleanup("clear_local_review_data"); }}>Reopen dialog</Button>
      {open ? (
        <DesignSettingsOverlay
          onClose={() => setOpen(false)}
          initialSection="general"
          autoOpenCleanup={pendingCleanup}
          onCleanupDialogChange={setPendingCleanup}
        />
      ) : null}
    </div>
  );
}

function DesignInboxRecoveryScenario(): React.JSX.Element {
  const prNumbers: ReadonlyArray<number> = [42, 118, 77, 31, 19, 8];
  return (
    <div className="mx-auto max-w-3xl p-6" data-testid="inbox-recovery-stage">
      <p className="mb-4 text-sm text-muted-foreground">Every row exposes exactly one friendly action and a short reassurance. No lifecycle or storage terms.</p>
      <div className="grid gap-3">
        {prNumbers.map((prNumber) => {
          const fixture = designInboxRecoveryFixtureFor(prNumber);
          return (
            <div key={`#${prNumber}`} className="rounded-md border p-3" data-testid={`inbox-recovery-row-${prNumber}`}>
              <p className="text-sm font-medium">Pull request #{prNumber}</p>
              <DesignRecoveryChip noticeKey={fixture.noticeKey} tone={fixture.tone} {...(fixture.actionKey === undefined ? {} : { actionKey: fixture.actionKey })} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DesignWorkbenchRecoveryScenario(): React.JSX.Element {
  const scenario = scenarioFromLocation();
  if (scenario === undefined) return <></>;
  const fixture = designRecoveryFixtureFor(scenario.id);
  return (
    <div className="mx-auto max-w-3xl p-6" data-testid={scenario.id}>
      <header className="mb-4">
        <p className="text-sm text-muted-foreground">Workbench recovery — single primary action.</p>
        <h1 className="text-2xl font-semibold">Protect review writes</h1>
      </header>
      <DesignRecoveryChip noticeKey={fixture.noticeKey} tone={fixture.tone} {...(fixture.actionKey === undefined ? {} : { actionKey: fixture.actionKey })} />
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
  const groups: ReadonlyArray<"Inbox" | "Review workbench" | "Settings and dialogs" | "Walkthrough"> = ["Inbox", "Review workbench", "Settings and dialogs", "Walkthrough"];
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
              <div className="mb-4 flex items-center gap-2 border-b border-border/60 pb-3">
                <h2 id={`design-group-${group}`} className="text-sm font-semibold">{group}</h2>
                <Badge variant="outline">{designScenarios.filter((scenario) => scenario.group === group).length} scenarios</Badge>
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                {designScenarios.filter((scenario) => scenario.group === group).map((item) => (
                  <a key={item.id} href={scenarioUrl(item.id)} className="group block h-full rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <Card className="flex h-full min-h-36 flex-col gap-0 border border-border/80 bg-card/80 p-0 transition-colors hover:border-primary/50">
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
