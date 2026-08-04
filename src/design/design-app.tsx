import { useEffect, useState } from "react";

import { App } from "../renderer/src/app";
import { BrandMark } from "../renderer/src/components/brand-mark";
import { Badge } from "../renderer/src/components/ui/badge";
import { Button } from "../renderer/src/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../renderer/src/components/ui/card";
import { scenarioFromLocation, scenarioUrl, designScenarios } from "./scenarios";
import { DesignRecoveryChip } from "./design-recovery";
import { designRecoveryTargetFor } from "./design-recovery-targets";
import { designInboxRecoveryFixtureFor, designRecoveryFixtureFor } from "./mock-bridge";
import { DesignPublishConfirmationScenario } from "./design-publish-confirmation-scenario";
import { DesignSettingsOverlay } from "./design-settings-overlay";
import { DesignWalkthroughScenario } from "./design-walkthrough-scenario";
import { createUnifiedReviewFixture, unifiedReviewInitialState } from "../renderer/src/flows/app-fixtures";
import { ReviewWorkbenchFlow } from "../renderer/src/flows/review-workbench-flow";

export function DesignApp(): React.JSX.Element {
  const scenario = scenarioFromLocation();
  useEffect(() => { document.title = scenario === undefined ? "Patchdesk Design" : `Patchdesk Design · ${scenario.title}`; }, [scenario]);
  if (scenario === undefined) return <DesignIndex />;
  if (scenario.id === "dialog-submit") return <DesignPublishConfirmationScenario variant="submit" />;
  if (scenario.id === "dialog-merge") return <DesignPublishConfirmationScenario variant="merge" />;
  if (scenario.group === "Review workbench") return <UnifiedReviewScenario />;
  if (scenario.id === "settings-recovery") return <DesignSettingsScenario />;
  if (scenario.id === "dialog-clear-local-data") return <DesignCleanupDialogScenario />;
  if (scenario.id === "inbox-recovery-states") return <DesignInboxRecoveryScenario />;
  if (scenario.id === "workbench-reconnect" || scenario.id === "workbench-start-again" || scenario.id === "workbench-try-again" || scenario.id === "workbench-prepare-again") return <DesignWorkbenchRecoveryScenario />;
  if (scenario.id === "walkthrough-generate-dialog") return <DesignWalkthroughScenario variant="walkthrough-generate-dialog" />;
  if (scenario.id === "walkthrough-generating") return <DesignWalkthroughScenario variant="walkthrough-generating" />;
  if (scenario.id === "walkthrough-ready") return <DesignWalkthroughScenario variant="walkthrough-ready" />;
  if (scenario.id === "walkthrough-failed") return <DesignWalkthroughScenario variant="walkthrough-failed" />;
  if (scenario.id === "walkthrough-stale") return <DesignWalkthroughScenario variant="walkthrough-stale" />;
  return <App />;
}

function UnifiedReviewScenario(): React.JSX.Element {
  const scenario = scenarioFromLocation();
  const state = scenario?.id.replace(/^review-/, "") as Parameters<typeof createUnifiedReviewFixture>[0] | undefined;
  const workbench = createUnifiedReviewFixture(state);
  return <div className="flex min-h-screen min-w-0 flex-col bg-background"><ReviewWorkbenchFlow workbench={workbench} initialUiState={unifiedReviewInitialState(state ?? "files-default")} onWorkbenchReplace={() => undefined} onWorkbenchPatch={() => undefined} onNavigationStateChange={() => undefined} onNavigate={() => undefined} /></div>;
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
  const target = designRecoveryTargetFor(scenario.id);
  if (target === undefined) return <></>;
  return (
    <div className="mx-auto max-w-3xl p-6" data-testid={scenario.id}>
      <header className="mb-4">
        <p className="text-sm text-muted-foreground">Workbench recovery — single primary action.</p>
        <h1 className="text-2xl font-semibold">Protect review writes</h1>
      </header>
      <DesignRecoveryChip
        noticeKey={fixture.noticeKey}
        tone={fixture.tone}
        {...(fixture.actionKey === undefined ? {} : { actionKey: fixture.actionKey })}
        primaryLabel={target.primaryLabel}
        snapshotReadable={target.snapshotReadable}
      />
    </div>
  );
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
