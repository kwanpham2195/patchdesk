import { useEffect, useState } from "react";

import { parsePullRequestInput, type PullRequestRef } from "../../../domain/pull-request";
import { DiffWorkbench } from "../components/diff-workbench";
import { ReviewChecks } from "../components/review-checks";
import { SafeRunPanel } from "../components/safe-run-panel";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { PatchdeskApiError, requestJson } from "../api-client";
import { parseWorkbenchResponse } from "../renderer-contracts";
import {
  loadReviewExecutionPreference,
  saveReviewExecutionPreference,
  type ReviewReasoningPreference,
} from "../review-execution-preferences";

export type PreparedReviewFlowWorkbench = {
  readonly state: "review_started";
  readonly session: {
    readonly id: string;
    readonly key: {
      readonly profileId: string;
      readonly host: string;
      readonly owner: string;
      readonly repo: string;
      readonly prNumber: number;
      readonly headSha: string;
    };
    readonly currentAttemptId?: string;
  };
  readonly pullRequest?: {
    readonly title: string;
    readonly description?: string;
  };
  readonly reviewedHeadSha?: string;
  readonly fullPatch?: string;
  readonly checks?: unknown;
  readonly freshness?: "fresh" | "stale" | "unavailable";
  readonly runId?: string;
};

export type PreparedReviewFlowProps = {
  readonly workbench: PreparedReviewFlowWorkbench;
  readonly initialSection?: "diff" | "checks";
  readonly onNavigate: (section: "diff" | "checks") => void;
  readonly onWorkbenchPatch: (patch: {
    readonly runId?: string;
    readonly session?: PreparedReviewFlowWorkbench["session"];
  }) => void;
  readonly onWorkbenchReplace: (workbench: unknown) => void;
};

/** Owns prepared-review model selection, run dialog state, and review API sequencing. */
export function PreparedReviewFlow({
  workbench,
  initialSection,
  onNavigate,
  onWorkbenchPatch,
  onWorkbenchReplace,
}: PreparedReviewFlowProps): React.JSX.Element {
  const [reviewModels, setReviewModels] = useState<ReadonlyArray<{ readonly id: string; readonly label: string }>>([]);
  const [reviewModel, setReviewModel] = useState<string>();
  const [reviewReasoning, setReviewReasoning] = useState<ReviewReasoningPreference>("medium");
  const [reviewCatalogUnavailable, setReviewCatalogUnavailable] = useState(false);
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [runError, setRunError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const profileId = workbench.session.key.profileId;

  useEffect(() => {
    let active = true;
    void requestJson("/v1/reviews/models")
      .then((value) => {
        if (!active || !isModelCatalog(value)) {
          setReviewModels([]);
          setReviewModel(undefined);
          setReviewCatalogUnavailable(true);
          return;
        }
        const saved = loadReviewExecutionPreference(profileId);
        const selected = saved?.model !== undefined && value.models.some((model) => model.id === saved.model)
          ? saved.model
          : value.defaultModel !== undefined && value.models.some((model) => model.id === value.defaultModel)
            ? value.defaultModel
            : value.models[0]?.id;
        setReviewModels(value.models);
        setReviewModel(selected);
        setReviewReasoning(saved?.reasoning ?? "medium");
        setReviewCatalogUnavailable(false);
      })
      .catch(() => {
        if (!active) return;
        setReviewModels([]);
        setReviewModel(undefined);
        setReviewCatalogUnavailable(true);
      });
    return () => {
      active = false;
    };
  }, [profileId]);

  const startRun = async (): Promise<{ readonly runId: string; readonly attemptId: string } | undefined> => {
    if (reviewModel === undefined) {
      setRunError("No enabled Pi review model is available. Update the active Pi runtime settings, then try again.");
      return undefined;
    }
    try {
      setRunError(undefined);
      saveReviewExecutionPreference(profileId, { model: reviewModel, reasoning: reviewReasoning });
      const value = await requestJson("/v1/reviews/run", {
        method: "POST",
        body: { profileId, sessionId: workbench.session.id, model: reviewModel, reasoning: reviewReasoning },
      });
      if (isRunStart(value)) return { runId: value.runId, attemptId: value.attemptId };
      setRunError("Patchdesk could not start this read-only review.");
      return undefined;
    } catch (cause: unknown) {
      setRunError(cause instanceof PatchdeskApiError && cause.status === 409
        ? "GitHub changed after this snapshot was prepared. Refresh and reopen before running a review."
        : "Patchdesk could not start this read-only review.");
      return undefined;
    }
  };

  const resumePreparedRun = async (): Promise<{ readonly runId: string; readonly attemptId: string } | undefined> => {
    const attemptId = workbench.session.currentAttemptId;
    if (attemptId === undefined) return undefined;
    try {
      const value = await requestJson("/v1/runs/review-pr", {
        method: "POST",
        body: { profileId, sessionId: workbench.session.id, attemptId },
      });
      return isRunStart(value) ? { runId: value.runId, attemptId } : undefined;
    } catch {
      return undefined;
    }
  };

  const startOwnedRun = async (): Promise<boolean> => {
    const started = workbench.session.currentAttemptId === undefined
      ? await startRun()
      : await resumePreparedRun();
    if (started === undefined) return false;
    onWorkbenchPatch({
      runId: started.runId,
      session: { ...workbench.session, currentAttemptId: started.attemptId },
    });
    return true;
  };

  const confirmStart = async (): Promise<void> => {
    setStarting(true);
    try {
      const started = await startOwnedRun();
      if (started) setRunDialogOpen(false);
    } finally {
      setStarting(false);
    }
  };

  const refreshPrepared = async (): Promise<void> => {
    try {
      const value = await requestJson("/v1/reviews/open", {
        method: "POST",
        body: {
          profileId,
          host: workbench.session.key.host,
          owner: workbench.session.key.owner,
          repo: workbench.session.key.repo,
          number: workbench.session.key.prNumber,
          mode: "full",
        },
      });
      const parsed = parseWorkbenchResponse(value);
      if (parsed !== undefined) onWorkbenchReplace(parsed);
    } catch {
      setRunError("Patchdesk could not refresh this prepared review.");
    }
  };

  const loadCompleted = async (): Promise<void> => {
    const value = await requestJson("/v1/reviews/load", {
      method: "POST",
      body: { profileId, sessionId: workbench.session.id },
    });
    const parsed = parseWorkbenchResponse(value);
    if (parsed !== undefined) onWorkbenchReplace(parsed);
  };

  const showingDiff = initialSection === "diff";
  const showingChecks = initialSection === "checks";
  const prLabel = `${workbench.session.key.owner}/${workbench.session.key.repo}#${workbench.session.key.prNumber}`;
  const snapshotLabel = workbench.reviewedHeadSha ?? workbench.session.key.headSha;
  const pullRequest = pullRequestRef(workbench);

  return (
    <section
      className={showingDiff ? "flex min-h-0 flex-1 flex-col" : "mx-auto w-full max-w-3xl p-6"}
      aria-label="Review workbench"
    >
      <div className={showingDiff ? "flex min-h-0 flex-1 flex-col bg-card" : "rounded-xl border bg-card p-6 shadow-sm"}>
        <header className={showingDiff ? "flex shrink-0 flex-wrap items-start justify-between gap-3 border-b px-4 py-3" : undefined}>
          <div className="min-w-0">
            <h1 className="mt-2 text-2xl font-semibold">{workbench.pullRequest?.title ?? `Pull request ${prLabel}`}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{prLabel} · snapshot {snapshotLabel.slice(0, 12)} · read-only</p>
          </div>
          <div className="flex flex-wrap gap-2" aria-label="Read-only inspection actions">
            <Button variant={showingDiff ? "secondary" : "outline"} size="sm" onClick={() => onNavigate("diff")}>View diff</Button>
            <Button variant={showingChecks ? "secondary" : "outline"} size="sm" onClick={() => onNavigate("checks")}>Inspect failing checks</Button>
            {workbench.session.currentAttemptId === undefined ? <Button size="sm" onClick={() => setRunDialogOpen(true)}>Run review</Button> : null}
          </div>
        </header>
        {showingChecks ? <PreparedChecks checks={workbench.checks} {...(pullRequest === undefined ? {} : { pullRequest })} {...(workbench.freshness === undefined ? {} : { freshness: workbench.freshness })} /> : null}
        {showingDiff && workbench.fullPatch !== undefined ? <DiffWorkbench patch={workbench.fullPatch} sourceSession={{ profileId, sessionId: workbench.session.id }} className="min-h-0 flex-1" fillViewport={false} /> : null}
        {workbench.session.currentAttemptId === undefined ? (
          showingDiff || showingChecks ? null : (
            <div className="mt-4 rounded-lg border bg-muted/20 p-4">
              <h2 className="font-semibold">Ready to review</h2>
              <p className="mt-1 text-sm text-muted-foreground">The saved snapshot is ready. Starting analysis is read-only and never writes to GitHub.</p>
              {runError === undefined ? null : (
                <Alert variant="destructive">
                  <AlertTitle>Review was not started</AlertTitle>
                  <AlertDescription className="mt-1 flex flex-wrap items-center gap-2">
                    {runError}
                    <Button variant="outline" size="sm" onClick={() => void refreshPrepared()}>Refresh and reopen review</Button>
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )
        ) : showingDiff || showingChecks ? null : (
          <SafeRunPanel
            profileId={profileId}
            sessionId={workbench.session.id}
            attemptId={workbench.session.currentAttemptId}
            {...(workbench.runId === undefined ? {} : { runId: workbench.runId })}
            onStart={async () => { await startOwnedRun(); }}
            onCompleted={loadCompleted}
          />
        )}
        {workbench.session.currentAttemptId === undefined ? (
          <Dialog open={runDialogOpen} onOpenChange={setRunDialogOpen}>
            <DialogContent aria-describedby="run-review-description">
              <DialogHeader>
                <DialogTitle>Run local review</DialogTitle>
                <DialogDescription id="run-review-description">Patchdesk will inspect the prepared snapshot read-only. It will not write to GitHub.</DialogDescription>
              </DialogHeader>
              <div className="grid gap-3 py-2">
                <Label className="grid gap-1.5">Model
                  <Select value={reviewModel} onValueChange={(value) => { if (value !== null) setReviewModel(value); }} disabled={reviewModels.length === 0}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{reviewModels.map((model) => <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>)}</SelectContent>
                  </Select>
                </Label>
                <Label className="grid gap-1.5">Reasoning
                  <Select value={reviewReasoning} onValueChange={(value) => { if (value === "low" || value === "medium" || value === "high") setReviewReasoning(value); }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="low">Low</SelectItem><SelectItem value="medium">Medium</SelectItem><SelectItem value="high">High</SelectItem></SelectContent>
                  </Select>
                </Label>
                {reviewCatalogUnavailable ? <p className="text-sm text-muted-foreground">No enabled Pi model is currently available. Patchdesk will not start a review until the runtime configuration is available.</p> : null}
              </div>
              {runError === undefined ? null : (
                <Alert variant="destructive">
                  <AlertTitle>Review was not started</AlertTitle>
                  <AlertDescription className="mt-1 flex flex-wrap items-center gap-2">
                    {runError}
                    <Button variant="outline" size="sm" onClick={() => void refreshPrepared()}>Refresh and reopen review</Button>
                  </AlertDescription>
                </Alert>
              )}
              <DialogFooter><Button variant="outline" onClick={() => setRunDialogOpen(false)}>Cancel</Button><Button disabled={reviewModel === undefined || starting} onClick={() => void confirmStart()}>{starting ? "Starting…" : "Start read-only review"}</Button></DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}
      </div>
    </section>
  );
}

function isModelCatalog(value: unknown): value is {
  readonly models: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly defaultModel?: string;
} {
  if (typeof value !== "object" || value === null || !("models" in value) || !Array.isArray(value.models)) return false;
  return value.models.every((model) => typeof model === "object" && model !== null && "id" in model && typeof model.id === "string" && "label" in model && typeof model.label === "string")
    && (!("defaultModel" in value) || value.defaultModel === undefined || typeof value.defaultModel === "string");
}

function isRunStart(value: unknown): value is { readonly runId: string; readonly attemptId: string } {
  return typeof value === "object" && value !== null
    && "runId" in value && typeof value.runId === "string"
    && "attemptId" in value && typeof value.attemptId === "string";
}

function pullRequestRef(workbench: PreparedReviewFlowWorkbench): PullRequestRef | undefined {
  const { host, owner, repo, prNumber } = workbench.session.key;
  const parsed = parsePullRequestInput(`https://${host}/${owner}/${repo}/pull/${prNumber}`);
  return parsed._tag === "ok" ? parsed.value : undefined;
}

function PreparedChecks({ checks, freshness, pullRequest }: { readonly checks: unknown; readonly freshness?: "fresh" | "stale" | "unavailable"; readonly pullRequest?: PullRequestRef }): React.JSX.Element {
  const value = typeof checks === "object" && checks !== null ? checks as Record<string, unknown> : {};
  const overall = value.overall === "passing" || value.overall === "failing" || value.overall === "pending" || value.overall === "skipped" ? value.overall : "unknown";
  const entries = Array.isArray(value.checks) ? value.checks.filter((check): check is { readonly name: string; readonly required: boolean | "unknown"; readonly status: "queued" | "in_progress" | "completed" | "unknown"; readonly conclusion?: "success" | "failure" | "cancelled" | "timed_out" | "skipped" | "neutral"; readonly url?: string } => typeof check === "object" && check !== null && typeof (check as Record<string, unknown>).name === "string") : [];
  return <section className="mt-4 px-1" aria-label="Pull request checks"><ReviewChecks checks={{ overall, checks: entries }} {...(pullRequest === undefined ? {} : { pullRequest })} {...(freshness === undefined ? {} : { freshness })} /></section>;
}
