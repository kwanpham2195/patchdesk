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
import { requestJson } from "../api-client";
import { parseWorkbenchResponse } from "../renderer-contracts";
import { recoveryActionLabel, recoveryCopy } from "../review-copy";
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
  };
  readonly recoveryView?: {
    readonly noticeKey: "preparing" | "ready_to_review" | "review_in_progress" | "review_interrupted" | "review_failed" | "needs_preparation";
    readonly tone: "neutral" | "positive" | "warning" | "destructive";
    readonly actionKey?: "run_review" | "reconnect" | "start_again" | "try_again" | "prepare_again";
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
  const [runError, setRunError] = useState<string>();  const [starting, setStarting] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [activeAttemptId, setActiveAttemptId] = useState<string>();
  const profileId = workbench.session.key.profileId;
  const recoveryAction = workbench.recoveryView?.actionKey;

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
      setRunError("No enabled review model is available. Try again after review models are available.");
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
    } catch {
      setRunError("Patchdesk could not start this read-only review.");
      return undefined;
    }
  };

  const reconnectOwnedRun = async (): Promise<{ readonly runId: string; readonly attemptId: string } | undefined> => {
    try {
      const value = await requestJson("/v1/runs/reconnect", {
        method: "POST",
        body: { profileId, sessionId: workbench.session.id },
      });
      return isReconnectStart(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };

  const startOwnedRun = async (): Promise<boolean> => {
    const started = recoveryAction === "reconnect"
      ? await reconnectOwnedRun()
      : await startRun();
    if (started === undefined) return false;
    setActiveAttemptId(started.attemptId);
    onWorkbenchPatch({ runId: started.runId });
    return true;
  };

  const prepareAgain = async (): Promise<void> => {
    setPreparing(true);
    setRunError(undefined);
    await refreshPrepared();
    setPreparing(false);
  };

  const handleRecoveryAction = async (): Promise<void> => {
    switch (recoveryAction) {
      case "reconnect":
        await startOwnedRun();
        return;
      case "prepare_again":
        await prepareAgain();
        return;
      case "run_review":
      case "start_again":
      case "try_again":
        setRunDialogOpen(true);
        return;
      case undefined:
        return;
    }
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

  const reloadAfterSettle = async (): Promise<void> => {
    const value = await requestJson("/v1/reviews/load", {
      method: "POST",
      body: { profileId, sessionId: workbench.session.id },
    });
    const parsed = parseWorkbenchResponse(value);
    if (parsed !== undefined) onWorkbenchReplace(parsed);
  };

  const recoveryCopyValue = workbench.recoveryView === undefined ? undefined : recoveryCopy(workbench.recoveryView.noticeKey);
  const recoveryButtonVariant = recoveryAction === "run_review" || recoveryAction === "reconnect" ? "default" : "outline";
  const recoveryButtonClass = recoveryAction === "prepare_again" ? "border-amber-500/60 text-amber-700 hover:bg-amber-500/10 dark:text-amber-300" : undefined;
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
            {recoveryAction === undefined ? null : <Button size="sm" variant={recoveryButtonVariant} className={recoveryButtonClass} disabled={preparing} onClick={() => void handleRecoveryAction()}>{preparing ? "Preparing…" : recoveryActionLabel(recoveryAction)}</Button>}
          </div>
        </header>
        {showingChecks ? <PreparedChecks checks={workbench.checks} {...(pullRequest === undefined ? {} : { pullRequest })} {...(workbench.freshness === undefined ? {} : { freshness: workbench.freshness })} /> : null}
        {showingDiff && workbench.fullPatch !== undefined ? <DiffWorkbench patch={workbench.fullPatch} sourceSession={{ profileId, sessionId: workbench.session.id }} className="min-h-0 flex-1" fillViewport={false} /> : null}
        {activeAttemptId === undefined ? (
          showingDiff || showingChecks ? null : (
            <div className="mt-4 rounded-lg border bg-muted/20 p-4">
              {workbench.recoveryView === undefined ? null : (
                <Alert variant={workbench.recoveryView.tone === "destructive" ? "destructive" : "default"} className="mb-3">
                  <AlertTitle>{recoveryCopy(workbench.recoveryView.noticeKey).notice}</AlertTitle>
                  <AlertDescription className="mt-1 flex flex-wrap items-center gap-2">
                    {recoveryCopy(workbench.recoveryView.noticeKey).reassurance}
                  </AlertDescription>
                </Alert>
              )}
              {workbench.recoveryView === undefined ? (
                <>
                  <h2 className="font-semibold">{recoveryCopyValue?.notice ?? "Review unavailable"}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{recoveryCopyValue?.reassurance ?? "This review is not available in this window."}</p>
                </>
              ) : null}
              {runError ? (
                <Alert variant="destructive">
                  <AlertTitle>Review couldn't finish</AlertTitle>
                  <AlertDescription className="mt-1 flex flex-wrap items-center gap-2">
                    {recoveryCopy("review_failed").reassurance}
                    <Button variant="outline" size="sm" onClick={() => void refreshPrepared()}>Refresh and reopen review</Button>
                  </AlertDescription>
                </Alert>
              ) : null}
            </div>
          )
        ) : showingDiff || showingChecks ? null : (
          <SafeRunPanel
            profileId={profileId}
            sessionId={workbench.session.id}
            {...(activeAttemptId === undefined ? {} : { attemptId: activeAttemptId })}
            {...(workbench.runId === undefined ? {} : { runId: workbench.runId })}
            {...(workbench.recoveryView === undefined ? {} : { recoveryView: workbench.recoveryView })}
            onStart={async () => {
              const started = await startOwnedRun();
              if (!started) setRunError("Patchdesk could not start this read-only review.");
            }}
            onSettled={reloadAfterSettle}
          />
        )}
        {activeAttemptId === undefined && (recoveryAction === "run_review" || recoveryAction === "start_again" || recoveryAction === "try_again") ? (
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
                {reviewCatalogUnavailable ? <p className="text-sm text-muted-foreground">No enabled review model is currently available. Try again after review models are available.</p> : null}
              </div>
              {runError ? (
                <Alert variant="destructive">
                  <AlertTitle>Review couldn't finish</AlertTitle>
                  <AlertDescription className="mt-1 flex flex-wrap items-center gap-2">
                    {recoveryCopy("review_failed").reassurance}
                    <Button variant="outline" size="sm" onClick={() => void refreshPrepared()}>Refresh and reopen review</Button>
                  </AlertDescription>
                </Alert>
              ) : null}
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

function isReconnectStart(value: unknown): value is { readonly runId: string; readonly attemptId: string } {
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
