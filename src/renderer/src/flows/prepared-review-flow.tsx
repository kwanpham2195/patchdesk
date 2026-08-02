import { useEffect, useState } from "react";

import {
  parsePullRequestInput,
  type PullRequestRef,
} from "../../../domain/pull-request";
import type {
  CheckSummary,
  GitHubComments,
  PullRequestSummary,
} from "../../../domain/github-context";
import type { ReviewAnchorFingerprint, ReviewBatch } from "../../../domain/review-batch";
import type { MergeReadiness } from "../../../domain/merge-readiness";
import { DiffWorkbench } from "../components/diff-workbench";
import { PullRequestOverviewSheet } from "../components/pr-overview-sheet";
import { ReviewChecks } from "../components/review-checks";
import { NarrativeWalkthrough } from "../components/narrative-walkthrough";
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
import { reviewIdForSession } from "../review-identity";
import { useWalkthroughController } from "../hooks/use-walkthrough-controller";
import { recoveryActionLabel, recoveryCopy, walkthroughCopy } from "../review-copy";
import {
  loadReviewExecutionPreference,
  saveReviewExecutionPreference,
  type ReviewReasoningPreference,
} from "../review-execution-preferences";

export type PreparedReviewFlowWorkbench = {
  readonly state: "review_started";
  readonly review?: { readonly id: string; readonly status: "open" | "merged" | "closed" };
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
    readonly noticeKey:
      | "preparing"
      | "ready_to_review"
      | "review_in_progress"
      | "review_interrupted"
      | "review_failed"
      | "needs_preparation";
    readonly tone: "neutral" | "positive" | "warning" | "destructive";
    readonly actionKey?:
      | "run_review"
      | "reconnect"
      | "start_again"
      | "try_again"
      | "prepare_again";
  };
  readonly pullRequest?: PullRequestSummary;
  readonly reviewedHeadSha?: string;
  readonly fullPatch?: string;
  readonly checks?: CheckSummary;
  readonly comments?: GitHubComments;
  readonly batch?: ReviewBatch;
  readonly mergeReadiness?: MergeReadiness;
  readonly freshness?: "fresh" | "stale" | "unavailable" | "not_refreshed";
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
  void onNavigate;
  const [reviewModels, setReviewModels] = useState<
    ReadonlyArray<{ readonly id: string; readonly label: string }>
  >([]);
  const [reviewModel, setReviewModel] = useState<string>();
  const [reviewReasoning, setReviewReasoning] =
    useState<ReviewReasoningPreference>("medium");
  const [reviewCatalogUnavailable, setReviewCatalogUnavailable] =
    useState(false);
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [runError, setRunError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [refreshingRemote, setRefreshingRemote] = useState(false);
  const [remoteRefreshError, setRemoteRefreshError] = useState(false);
  const [activeAttemptId, setActiveAttemptId] = useState<string>();
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [overviewFocus, setOverviewFocus] = useState<"checks">();
  const [walkthroughOpen, setWalkthroughOpen] = useState(false);
  const [walkthroughSectionId, setWalkthroughSectionId] = useState<string>();
  const profileId = workbench.session.key.profileId;
  const reviewId = workbench.review?.id ?? reviewIdForSession(workbench.session.key);
  const recoveryAction = workbench.recoveryView?.actionKey;
  const walkthrough = useWalkthroughController({
    profileId,
    sessionId: workbench.session.id,
    headSha: workbench.reviewedHeadSha ?? workbench.session.key.headSha,
  });

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
        const selected =
          saved?.model !== undefined &&
          value.models.some((model) => model.id === saved.model)
            ? saved.model
            : value.defaultModel !== undefined &&
                value.models.some((model) => model.id === value.defaultModel)
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

  const refreshRemote = async (): Promise<void> => {
    setRefreshingRemote(true);
    setRemoteRefreshError(false);
    try {
      if (reviewId === undefined) throw new Error("Stable review identity is unavailable");
      const value = await requestJson("/v1/reviews/refresh", {
        method: "POST",
        body: { profileId, reviewId },
      });
      const refreshed = parseWorkbenchResponse(value);
      if (refreshed === undefined) throw new Error("Invalid refresh response");
      onWorkbenchReplace(refreshed);
    } catch {
      setRemoteRefreshError(true);
    }
    setRefreshingRemote(false);
  };

  useEffect(() => {
    let active = true;
    const timer = window.setInterval(() => {
      if (reviewId === undefined) return;
      void requestJson("/v1/reviews/detect-updates", {
        method: "POST",
        body: { profileId, reviewId },
      })
        .then((value) => {
          const detected = parseDetectionResult(value);
          if (active && detected?.updatesAvailable === true) setRemoteRefreshError(false);
        })
        .catch(() => undefined);
    }, 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [onWorkbenchReplace, profileId, workbench]);

  const startRun = async (): Promise<
    { readonly runId: string; readonly attemptId: string } | undefined
  > => {
    if (reviewModel === undefined) {
      setRunError(
        "No enabled review model is available. Try again after review models are available.",
      );
      return undefined;
    }
    try {
      setRunError(undefined);
      saveReviewExecutionPreference(profileId, {
        model: reviewModel,
        reasoning: reviewReasoning,
      });
      const value = await requestJson("/v1/reviews/run", {
        method: "POST",
        body: {
          profileId,
          sessionId: workbench.session.id,
          model: reviewModel,
          reasoning: reviewReasoning,
        },
      });
      if (isRunStart(value))
        return { runId: value.runId, attemptId: value.attemptId };
      setRunError("Patchdesk could not start this read-only review.");
      return undefined;
    } catch {
      setRunError("Patchdesk could not start this read-only review.");
      return undefined;
    }
  };

  const reconnectOwnedRun = async (): Promise<
    { readonly runId: string; readonly attemptId: string } | undefined
  > => {
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
    const started =
      recoveryAction === "reconnect"
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

  const refreshPrepared = async (): Promise<boolean> => {
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
          previousSessionId: workbench.session.id,
        },
      });
      const parsed = parseWorkbenchResponse(value);
      if (parsed === undefined) return false;
      onWorkbenchReplace(parsed);
      return true;
    } catch {
      setRunError("Patchdesk could not refresh this prepared review.");
      return false;
    }
  };

  const reloadAfterSettle = async (): Promise<void> => {
    if (reviewId === undefined) throw new Error("Stable review identity is unavailable");
    const value = await requestJson("/v1/reviews/load", {
      method: "POST",
      body: { profileId, reviewId },
    });
    const parsed = parseWorkbenchResponse(value);
    if (parsed !== undefined) onWorkbenchReplace(parsed);
  };

  const recoveryCopyValue =
    workbench.recoveryView === undefined
      ? undefined
      : recoveryCopy(workbench.recoveryView.noticeKey);
  const recoveryButtonVariant =
    recoveryAction === "run_review" || recoveryAction === "reconnect"
      ? "default"
      : "outline";
  const recoveryButtonClass =
    recoveryAction === "prepare_again"
      ? "border-amber-500/60 text-amber-700 hover:bg-amber-500/10 dark:text-amber-300"
      : undefined;
  // A prepared snapshot opens where the maintainer can inspect evidence. The
  // compact summary remains available through explicit navigation to Checks.
  const showingDiff =
    initialSection !== "checks" && workbench.fullPatch !== undefined;
  const showingChecks = initialSection === "checks";
  const prLabel = `${workbench.session.key.owner}/${workbench.session.key.repo}#${workbench.session.key.prNumber}`;
  const snapshotLabel =
    workbench.reviewedHeadSha ?? workbench.session.key.headSha;
  const pullRequest = pullRequestRef(workbench);
  const batch = workbench.batch;
  const updateBatch = async (
    command: Record<string, unknown>,
  ): Promise<void> => {
    if (batch === undefined)
      throw new Error("The saved review batch is unavailable");
    const value = await requestJson("/v1/reviews/batch", {
      method: "POST",
      body: {
        profileId,
        sessionId: workbench.session.id,
        expectedRevision: batch.updatedAt,
        command,
      },
    });
    if (typeof value !== "object" || value === null || !("session" in value))
      throw new Error("Review batch update was rejected");
    onWorkbenchReplace({ ...workbench, ...(value as Record<string, unknown>) });
  };
  const merge = async (
    method: "merge" | "squash" | "rebase",
    acknowledgedWarnings: boolean,
  ): Promise<{ readonly mergeCommitSha?: string }> => {
    const value = await requestJson("/v1/reviews/merge", {
      method: "POST",
      body: {
        profileId,
        sessionId: workbench.session.id,
        method,
        acknowledgedWarnings,
      },
    });
    if (typeof value !== "object" || value === null || !("session" in value))
      throw new Error("Merge was rejected");
    onWorkbenchReplace({ ...workbench, ...(value as Record<string, unknown>) });
    return {};
  };
  const batchActions =
    batch === undefined
      ? undefined
      : {
          addInlineComment: async (input: {
            readonly path: string;
            readonly startLine: number;
          readonly line: number;
          readonly side: "new" | "old";
          readonly fingerprint?: ReviewAnchorFingerprint;
          readonly body: string;
          }) =>
            updateBatch({
              _tag: "AddInlineComment",
              anchor: {
                path: input.path,
                startLine: input.startLine,
                line: input.line,
                side: input.side,
              },
              ...(input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint }),
              body: input.body,
            }),
          removeItem: async (itemId: string) =>
            updateBatch({ _tag: "RemoveItem", itemId }),
          addThreadReply: async (threadId: string, body: string) =>
            updateBatch({ _tag: "AddThreadReply", threadId, body }),
          setThreadState: async (
            threadId: string,
            action: "resolve" | "reopen",
          ) => updateBatch({ _tag: "SetThreadState", threadId, action }),
          apply: async () => {
            const value = await requestJson("/v1/reviews/apply-batch", {
              method: "POST",
              body: {
                profileId,
                sessionId: workbench.session.id,
                expectedRevision: batch.updatedAt,
                acknowledgement: true,
              },
            });
            onWorkbenchReplace({
              ...workbench,
              ...(value as Record<string, unknown>),
            });
          },
          submit: async (event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES") => {
            const value = await requestJson("/v1/reviews/submit-batch", {
              method: "POST",
              body: {
                profileId,
                sessionId: workbench.session.id,
                expectedRevision: batch.updatedAt,
                acknowledgement: true,
                event,
              },
            });
            onWorkbenchReplace({
              ...workbench,
              ...(value as Record<string, unknown>),
            });
          },
        };
  const overviewMerge =
    workbench.mergeReadiness === undefined ||
    workbench.pullRequest === undefined
      ? undefined
      : {
          readiness: workbench.mergeReadiness,
          context: {
            repo: `${workbench.pullRequest.ref.owner}/${workbench.pullRequest.ref.repo}`,
            prNumber: workbench.pullRequest.ref.number,
            title: workbench.pullRequest.title,
            base: workbench.pullRequest.baseBranch,
            head: workbench.pullRequest.headBranch,
            headSha: workbench.pullRequest.headSha,
          },
          methods: ["squash", "merge", "rebase"] as const,
          onMerge: merge,
        };
  const readyWalkthrough =
    walkthrough.projection.lifecycle === "ready"
      ? walkthrough.projection.walkthrough
      : undefined;
  if (walkthroughOpen && readyWalkthrough !== undefined) {
    return (
      <NarrativeWalkthrough
        walkthrough={readyWalkthrough}
        reviewedSectionIds={[]}
        supportReviewed={false}
        {...(walkthroughSectionId === undefined
          ? {}
          : { currentSectionId: walkthroughSectionId })}
        {...(workbench.fullPatch === undefined
          ? {}
          : { rawPatch: workbench.fullPatch })}
        sourceSession={{ profileId, sessionId: workbench.session.id }}
        {...(batch?.state._tag === "Local" &&
        workbench.freshness === "fresh" &&
        batchActions !== undefined
          ? {
              localCommentAuthoring: {
                enabled: true,
                onSave: batchActions.addInlineComment,
              },
            }
          : {})}
        actions={{
          onBackToFiles: () => setWalkthroughOpen(false),
          onMarkSectionReviewed: () => undefined,
          onMarkSupportReviewed: () => undefined,
          onSelectSection: setWalkthroughSectionId,
        }}
      />
    );
  }

  return (
    <section
      className={
        showingDiff
          ? "flex min-h-0 flex-1 flex-col"
          : "mx-auto w-full max-w-3xl p-6"
      }
      aria-label="Review workbench"
    >
      <div
        className={
          showingDiff
            ? "flex min-h-0 flex-1 flex-col bg-card"
            : "rounded-xl border bg-card p-6 shadow-sm"
        }
      >
        <header
          className={
            showingDiff
              ? "flex shrink-0 flex-wrap items-start justify-between gap-3 border-b px-4 py-3"
              : undefined
          }
        >
          <div className="min-w-0">
            <h1 className="mt-2 text-2xl font-semibold">
              {workbench.pullRequest?.title ?? `Pull request ${prLabel}`}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {prLabel} · snapshot {snapshotLabel.slice(0, 12)} · read-only
            </p>
          </div>
          <div
            className="flex flex-wrap gap-2"
            aria-label="Pull request actions"
          >
            {!overviewOpen ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setOverviewFocus("checks");
                  setOverviewOpen(true);
                }}
              >
                Checks · {checksButtonLabel(workbench.checks?.overall, workbench.freshness)}
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              disabled={refreshingRemote}
              onClick={() => void refreshRemote()}
            >
              {refreshingRemote ? "Refreshing…" : "Refresh GitHub state"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setOverviewFocus(undefined);
                setOverviewOpen(true);
              }}
            >
              PR overview
            </Button>
            <PullRequestOverviewSheet
              open={overviewOpen}
              onOpenChange={setOverviewOpen}
              {...(overviewFocus === undefined ? {} : { focus: overviewFocus })}
              {...(workbench.pullRequest === undefined
                ? {}
                : { pullRequest: workbench.pullRequest })}
              {...(workbench.fullPatch === undefined ? {} : { patch: workbench.fullPatch })}
              freshness={workbench.freshness ?? "unavailable"}
              checks={workbench.checks ?? { overall: "unknown", checks: [] }}
              comments={workbench.comments ?? { threads: [] }}
              {...(batch === undefined ? {} : { batch })}
              actions={{
                ...(batchActions === undefined ? {} : { batch: batchActions }),
                ...(overviewMerge === undefined
                  ? {}
                  : { merge: overviewMerge }),
              }}
              noLocalReview={workbench.runId === undefined}
            />
            {readyWalkthrough === undefined ? (
              <Button
                variant="outline"
                size="sm"
                onClick={walkthrough.onOpenDialog}
              >
                Generate walkthrough
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setWalkthroughOpen(true)}
              >
                Open walkthrough
              </Button>
            )}
            {recoveryAction === undefined ? null : (
              <Button
                size="sm"
                variant={recoveryButtonVariant}
                className={recoveryButtonClass}
                disabled={preparing}
                onClick={() => void handleRecoveryAction()}
              >
                {preparing ? "Preparing…" : recoveryActionLabel(recoveryAction)}
              </Button>
            )}
          </div>
        </header>
        {remoteRefreshError ? (
          <Alert variant="destructive" className="m-4 mb-0">
            <AlertTitle>GitHub state could not be refreshed</AlertTitle>
            <AlertDescription>
              The saved review remains readable. Try refreshing again to load
              the latest checks and pull request status.
            </AlertDescription>
          </Alert>
        ) : null}
        {walkthrough.projection.lifecycle === "idle" ? null : (
          <div
            className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-4 py-3"
            aria-live="polite"
            data-testid="prepared-walkthrough-status"
          >
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">
                Read-only walkthrough
              </p>
              <p className="text-sm font-medium">
                {walkthroughCopy(walkthrough.projection.lifecycle).headline}
              </p>
              <p className="text-xs text-muted-foreground">
                {walkthroughCopy(walkthrough.projection.lifecycle).reassurance}
              </p>
            </div>
            {walkthrough.projection.lifecycle === "failed" ? (
              <Button
                size="sm"
                variant="outline"
                onClick={walkthrough.onRetry}
              >
                Retry generation
              </Button>
            ) : null}
            {walkthrough.projection.lifecycle === "stale" ? (
              <Button
                size="sm"
                variant="outline"
                onClick={walkthrough.onRegenerate}
              >
                Generate walkthrough
              </Button>
            ) : null}
          </div>
        )}
        {showingChecks ? (
          <PreparedChecks
            checks={workbench.checks}
            {...(pullRequest === undefined ? {} : { pullRequest })}
            {...(workbench.freshness === undefined
              ? {}
              : { freshness: workbench.freshness })}
          />
        ) : null}
        {showingDiff && workbench.fullPatch !== undefined ? (
          <DiffWorkbench
            patch={workbench.fullPatch}
            sourceSession={{ profileId, sessionId: workbench.session.id }}
            className="min-h-0 flex-1"
            fillViewport={false}
            {...(batch?.state._tag === "Local" &&
            workbench.freshness === "fresh" &&
            batchActions !== undefined
              ? {
                  localCommentAuthoring: {
                    enabled: true,
                    onSave: batchActions.addInlineComment,
                  },
                }
              : {})}
          />
        ) : null}
        {activeAttemptId === undefined ? (
          showingDiff || showingChecks ? null : (
            <div className="mt-4 rounded-lg border bg-muted/20 p-4">
              {workbench.recoveryView === undefined ? null : (
                <Alert
                  variant={
                    workbench.recoveryView.tone === "destructive"
                      ? "destructive"
                      : "default"
                  }
                  className="mb-3"
                >
                  <AlertTitle>
                    {recoveryCopy(workbench.recoveryView.noticeKey).notice}
                  </AlertTitle>
                  <AlertDescription className="mt-1 flex flex-wrap items-center gap-2">
                    {recoveryCopy(workbench.recoveryView.noticeKey).reassurance}
                  </AlertDescription>
                </Alert>
              )}
              {workbench.recoveryView === undefined ? (
                <>
                  <h2 className="font-semibold">
                    {recoveryCopyValue?.notice ?? "Review unavailable"}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {recoveryCopyValue?.reassurance ??
                      "This review is not available in this window."}
                  </p>
                </>
              ) : null}
              {runError ? (
                <Alert variant="destructive">
                  <AlertTitle>Review couldn't finish</AlertTitle>
                  <AlertDescription className="mt-1 flex flex-wrap items-center gap-2">
                    {recoveryCopy("review_failed").reassurance}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void refreshPrepared()}
                    >
                      Refresh and reopen review
                    </Button>
                  </AlertDescription>
                </Alert>
              ) : null}
            </div>
          )
        ) : showingDiff || showingChecks ? null : (
          <SafeRunPanel
            profileId={profileId}
            sessionId={workbench.session.id}
            {...(activeAttemptId === undefined
              ? {}
              : { attemptId: activeAttemptId })}
            {...(workbench.runId === undefined
              ? {}
              : { runId: workbench.runId })}
            {...(workbench.recoveryView === undefined
              ? {}
              : { recoveryView: workbench.recoveryView })}
            onStart={async () => {
              const started = await startOwnedRun();
              if (!started)
                setRunError("Patchdesk could not start this read-only review.");
            }}
            onSettled={reloadAfterSettle}
          />
        )}
        {activeAttemptId === undefined &&
        (recoveryAction === "run_review" ||
          recoveryAction === "start_again" ||
          recoveryAction === "try_again") ? (
          <Dialog open={runDialogOpen} onOpenChange={setRunDialogOpen}>
            <DialogContent aria-describedby="run-review-description">
              <DialogHeader>
                <DialogTitle>Run local review</DialogTitle>
                <DialogDescription id="run-review-description">
                  Patchdesk will inspect the prepared snapshot read-only. It
                  will not write to GitHub.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-3 py-2">
                <Label className="grid gap-1.5">
                  Model
                  <Select
                    value={reviewModel}
                    onValueChange={(value) => {
                      if (value !== null) setReviewModel(value);
                    }}
                    disabled={reviewModels.length === 0}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {reviewModels.map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          {model.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Label>
                <Label className="grid gap-1.5">
                  Reasoning
                  <Select
                    value={reviewReasoning}
                    onValueChange={(value) => {
                      if (
                        value === "low" ||
                        value === "medium" ||
                        value === "high"
                      )
                        setReviewReasoning(value);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">Low</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                    </SelectContent>
                  </Select>
                </Label>
                {reviewCatalogUnavailable ? (
                  <p className="text-sm text-muted-foreground">
                    No enabled review model is currently available. Try again
                    after review models are available.
                  </p>
                ) : null}
              </div>
              {runError ? (
                <Alert variant="destructive">
                  <AlertTitle>Review couldn't finish</AlertTitle>
                  <AlertDescription className="mt-1 flex flex-wrap items-center gap-2">
                    {recoveryCopy("review_failed").reassurance}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void refreshPrepared()}
                    >
                      Refresh and reopen review
                    </Button>
                  </AlertDescription>
                </Alert>
              ) : null}
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setRunDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  disabled={reviewModel === undefined || starting}
                  onClick={() => void confirmStart()}
                >
                  {starting ? "Starting…" : "Start read-only review"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}
        <Dialog
          open={walkthrough.dialogOpen}
          onOpenChange={(open) => {
            if (!open) walkthrough.onCloseDialog();
          }}
        >
          <DialogContent aria-describedby="walkthrough-description">
            <DialogHeader>
              <DialogTitle>Generate a read-only walkthrough</DialogTitle>
              <DialogDescription id="walkthrough-description">
                Patchdesk reads this stored snapshot and never starts or posts a
                review.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 py-2">
              <Label className="grid gap-1.5">
                Model
                <Select
                  value={walkthrough.model}
                  onValueChange={(value) => {
                    if (value !== null) walkthrough.onModelChange(value);
                  }}
                  disabled={walkthrough.models.length === 0}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {walkthrough.models.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Label>
              <Label className="grid gap-1.5">
                Reasoning
                <Select
                  value={walkthrough.reasoning}
                  onValueChange={(value) => {
                    if (
                      value === "low" ||
                      value === "medium" ||
                      value === "high"
                    )
                      walkthrough.onReasoningChange(value);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
              </Label>
              {walkthrough.catalogUnavailable ? (
                <p className="text-sm text-muted-foreground">
                  No enabled review model is currently available.
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={walkthrough.onCloseDialog}>
                Cancel
              </Button>
              <Button
                disabled={
                  walkthrough.model === undefined ||
                  walkthrough.catalogUnavailable ||
                  walkthrough.busy
                }
                onClick={walkthrough.onConfirm}
              >
                {walkthrough.busy
                  ? "Generating…"
                  : "Generate read-only walkthrough"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </section>
  );
}

function parseDetectionResult(value: unknown): { readonly updatesAvailable: boolean } | undefined {
  return typeof value === "object" && value !== null && "updatesAvailable" in value && typeof value.updatesAvailable === "boolean"
    ? { updatesAvailable: value.updatesAvailable }
    : undefined;
}

function isModelCatalog(value: unknown): value is {
  readonly models: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
  }>;
  readonly defaultModel?: string;
} {
  if (
    typeof value !== "object" ||
    value === null ||
    !("models" in value) ||
    !Array.isArray(value.models)
  )
    return false;
  return (
    value.models.every(
      (model) =>
        typeof model === "object" &&
        model !== null &&
        "id" in model &&
        typeof model.id === "string" &&
        "label" in model &&
        typeof model.label === "string",
    ) &&
    (!("defaultModel" in value) ||
      value.defaultModel === undefined ||
      typeof value.defaultModel === "string")
  );
}

function isRunStart(
  value: unknown,
): value is { readonly runId: string; readonly attemptId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "runId" in value &&
    typeof value.runId === "string" &&
    "attemptId" in value &&
    typeof value.attemptId === "string"
  );
}

function isReconnectStart(
  value: unknown,
): value is { readonly runId: string; readonly attemptId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "runId" in value &&
    typeof value.runId === "string" &&
    "attemptId" in value &&
    typeof value.attemptId === "string"
  );
}

function pullRequestRef(
  workbench: PreparedReviewFlowWorkbench,
): PullRequestRef | undefined {
  const { host, owner, repo, prNumber } = workbench.session.key;
  const parsed = parsePullRequestInput(
    `https://${host}/${owner}/${repo}/pull/${prNumber}`,
  );
  return parsed._tag === "ok" ? parsed.value : undefined;
}

function checksButtonLabel(
  overall: CheckSummary["overall"] | undefined,
  freshness: PreparedReviewFlowWorkbench["freshness"],
): string {
  if (freshness === "not_refreshed") return "Not refreshed";
  if (freshness === "unavailable") return "Unavailable";
  return overall === "passing"
    ? "Passing"
    : overall === "failing"
      ? "Failing"
      : overall === "pending"
        ? "In progress"
        : overall === "skipped"
          ? "Skipped"
          : "Unknown";
}

function PreparedChecks({
  checks,
  freshness,
  pullRequest,
}: {
  readonly checks: unknown;
  readonly freshness?: "fresh" | "stale" | "unavailable" | "not_refreshed";
  readonly pullRequest?: PullRequestRef;
}): React.JSX.Element {
  const value =
    typeof checks === "object" && checks !== null
      ? (checks as Record<string, unknown>)
      : {};
  const overall =
    value.overall === "passing" ||
    value.overall === "failing" ||
    value.overall === "pending" ||
    value.overall === "skipped"
      ? value.overall
      : "unknown";
  const entries = Array.isArray(value.checks)
    ? value.checks.filter(
        (
          check,
        ): check is {
          readonly name: string;
          readonly required: boolean | "unknown";
          readonly status: "queued" | "in_progress" | "completed" | "unknown";
          readonly conclusion?:
            | "success"
            | "failure"
            | "cancelled"
            | "timed_out"
            | "skipped"
            | "neutral";
          readonly url?: string;
        } =>
          typeof check === "object" &&
          check !== null &&
          typeof (check as Record<string, unknown>).name === "string",
      )
    : [];
  return (
    <section className="mt-4 px-1" aria-label="Pull request checks">
      <ReviewChecks
        checks={{ overall, checks: entries }}
        {...(pullRequest === undefined ? {} : { pullRequest })}
        {...(freshness === undefined ? {} : { freshness })}
      />
    </section>
  );
}
