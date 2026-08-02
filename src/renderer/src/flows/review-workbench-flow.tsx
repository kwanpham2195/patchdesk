import { useCallback, useEffect, useState } from "react";

import { mapFindingLocation, parseUnifiedPatch } from "../../../domain/patch";
import { parseRepoRelativePath } from "../../../domain/ids";
import { fingerprintPatchAnchor } from "../../../domain/review-anchor";
import { parseReviewBatch } from "../../../domain/review-batch";
import { requestJson } from "../api-client";
import { ReviewWorkbench } from "../components/review-workbench";
import type { LocalCommentAuthoring } from "../components/review-diff-view";
import { ReviewBatchPanel, type ReviewBatchPanelActions } from "../components/review-batch-panel";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Spinner } from "../components/ui/spinner";
import type { WorkbenchResponse } from "../renderer-contracts";
import { parseCommitDiffResponse, parseModelCatalog, parseReviewBatchProjection, parseWorkbenchResponse, type CommitDiffResponse } from "../renderer-contracts";
import { useInsightRun } from "../hooks/use-insight-run";

export type ReviewWorkbenchPatch = Omit<Partial<WorkbenchResponse>, "insights"> & {
  readonly insights?: Partial<WorkbenchResponse["insights"]>;
};

export type ReviewWorkbenchFlowProps = {
  readonly workbench: WorkbenchResponse;
  readonly initialSection?: "diff" | "checks";
  readonly onWorkbenchReplace: (workbench: WorkbenchResponse) => void;
  readonly onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void;
  readonly onNavigationStateChange: (state: "clear" | "dirty_draft" | "write_pending") => void;
  readonly onNavigate: (section: "diff" | "checks") => void;
};

/** Owns loopback calls and replacement of the one canonical Review projection. */
export function ReviewWorkbenchFlow({
  workbench,
  initialSection,
  onWorkbenchReplace,
  onWorkbenchPatch,
  onNavigationStateChange,
  onNavigate,
}: ReviewWorkbenchFlowProps): React.JSX.Element {
  void initialSection;
  void onNavigate;
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const detectUpdates = useCallback(async (): Promise<void> => {
    if (workbench.review.status !== "open") return;
    try {
      const value = await requestJson("/v1/reviews/detect-updates", {
        method: "POST",
        body: { profileId: workbench.session.key.profileId, reviewId: workbench.review.id },
      });
      if (isDetection(value) && value.updatesAvailable)
        onWorkbenchPatch({ revision: { ...workbench.revision, freshness: "updates_available" } });
    } catch {
      // Detection is advisory and never replaces the represented snapshot.
    }
  }, [onWorkbenchPatch, workbench]);

  useEffect(() => {
    void detectUpdates();
    if (workbench.review.status !== "open") return undefined;
    const timer = window.setInterval(() => void detectUpdates(), 30_000);
    return () => window.clearInterval(timer);
  }, [detectUpdates, workbench.review.status]);

  const refresh = useCallback(async (): Promise<void> => {
    if (workbench.review.status !== "open" || refreshing) return;
    setRefreshing(true);
    setRefreshError(false);
    try {
      const value = await requestJson("/v1/reviews/refresh", {
        method: "POST",
        body: { profileId: workbench.session.key.profileId, reviewId: workbench.review.id },
      });
      const parsed = parseWorkbenchResponse(value);
      if (parsed === undefined) throw new Error("Invalid Review refresh response");
      onWorkbenchReplace(parsed);
    } catch {
      setRefreshError(true);
    } finally {
      setRefreshing(false);
    }
  }, [onWorkbenchReplace, refreshing, workbench]);

  const saveInlineComment = useCallback(async (input: Parameters<NonNullable<LocalCommentAuthoring["onSave"]>>[0]): Promise<void> => {
    const batch = workbench.draft;
    if (batch === undefined) throw new Error("The saved Review draft is unavailable");
    const value = await requestJson("/v1/reviews/batch", {
      method: "POST",
      body: {
        profileId: workbench.session.key.profileId,
        sessionId: workbench.session.id,
        expectedRevision: batch.updatedAt,
        command: {
          _tag: "AddInlineComment",
          anchor: { path: input.path, startLine: input.startLine, line: input.line, side: input.side },
          ...(input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint }),
          body: input.body,
        },
      },
    });
    const next = parseBatchResponse(value);
    if (next === undefined) throw new Error("Invalid Review batch response");
    onWorkbenchPatch({ draft: next });
  }, [onWorkbenchPatch, workbench]);

  const localCommentAuthoring: LocalCommentAuthoring | undefined =
    workbench.review.status === "open" && workbench.revision.freshness === "fresh" && workbench.draft !== undefined
      ? { enabled: true, onSave: saveInlineComment }
      : undefined;

  return (
    <>
      <ReviewWorkbench
        model={workbench}
        actions={{
          detectUpdates,
          refresh,
          loadCommitDiff: async (commitSha: string): Promise<CommitDiffResponse> => {
            const value = await requestJson("/v1/reviews/commit-diff", {
              method: "POST",
              body: { profileId: workbench.session.key.profileId, reviewId: workbench.review.id, commitSha },
            });
            const parsed = parseCommitDiffResponse(value);
            if (parsed === undefined) throw new Error("Invalid commit diff response");
            return parsed;
          },
          ...(localCommentAuthoring === undefined ? {} : { localCommentAuthoring }),
          reportNavigationState: onNavigationStateChange,
        }}
        slots={{
          insights: <InsightsSlot workbench={workbench} onWorkbenchReplace={onWorkbenchReplace} onWorkbenchPatch={onWorkbenchPatch} />,
          publishedFeedback: <PublishedFeedbackSlot workbench={workbench} />,
          mergeAction: null,
          draftDock: <DraftSlot workbench={workbench} onWorkbenchPatch={onWorkbenchPatch} />,
        }}
      />
      {refreshError ? (
        <p role="alert" className="border-t px-4 py-2 text-sm text-destructive">
          GitHub state could not be refreshed. The represented Review remains readable.
        </p>
      ) : null}
      {refreshing ? <span className="sr-only" role="status">Refreshing Review state</span> : null}
    </>
  );
}

type AnalysisFinding = NonNullable<WorkbenchResponse["insights"]["analysis"]["retained"]>["value"]["findings"][number];

function InsightsSlot({
  workbench,
  onWorkbenchReplace,
  onWorkbenchPatch,
}: {
  readonly workbench: WorkbenchResponse;
  readonly onWorkbenchReplace: (workbench: WorkbenchResponse) => void;
  readonly onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void;
}): React.JSX.Element {
  const [models, setModels] = useState<ReadonlyArray<{ readonly id: string; readonly label: string }>>([]);
  const [model, setModel] = useState<string | null>(null);
  const [reasoning, setReasoning] = useState<"low" | "medium" | "high">("medium");
  const [catalogError, setCatalogError] = useState(false);
  const profileId = workbench.session.key.profileId;
  const reviewId = workbench.review.id;
  const onInsightPatch = useCallback((type: "analysis" | "walkthrough", projection: WorkbenchResponse["insights"]["analysis"] | WorkbenchResponse["insights"]["walkthrough"]): void => {
    onWorkbenchPatch({ insights: { [type]: projection } });
  }, [onWorkbenchPatch]);
  const analysisRun = useInsightRun({ profileId, reviewId, type: "analysis", onWorkbenchReplace, onInsightPatch });
  const walkthroughRun = useInsightRun({ profileId, reviewId, type: "walkthrough", onWorkbenchReplace, onInsightPatch });

  useEffect(() => {
    let active = true;
    void requestJson("/v1/reviews/models").then((value) => {
      if (!active) return;
      const catalog = parseModelCatalog(value);
      if (catalog === undefined) {
        setModels([]);
        setModel(null);
        setCatalogError(true);
        return;
      }
      setModels(catalog.models);
      setModel(catalog.defaultModel ?? catalog.models[0]?.id ?? null);
      setCatalogError(false);
    }).catch(() => {
      if (!active) return;
      setModels([]);
      setModel(null);
      setCatalogError(true);
    });
    return () => { active = false; };
  }, [profileId]);

  const runEnabled = !catalogError && model !== null && workbench.review.status === "open";
  const analysisFindings = workbench.insights.analysis.status === "current" ? workbench.insights.analysis.retained?.value.findings : undefined;
  const addFinding = async (finding: AnalysisFinding): Promise<void> => {
    const batch = workbench.draft;
    const runId = workbench.insights.analysis.retained?.runId;
    if (batch === undefined || runId === undefined) return;
    const body = finding.suggestedComment ?? finding.explanation;
    let command:
      | { readonly _tag: "AddFindingInlineComment"; readonly reviewId: string; readonly findingId: string; readonly runId: string; readonly anchor: { readonly path: string; readonly startLine: number; readonly line: number; readonly side: "new" | "old" }; readonly fingerprint: NonNullable<ReturnType<typeof fingerprintPatchAnchor>>; readonly body: string }
      | { readonly _tag: "AddFindingGeneralComment"; readonly reviewId: string; readonly findingId: string; readonly runId: string; readonly body: string };
    if (finding.mappingStatus === "mapped" && finding.file !== undefined && finding.lineStart !== undefined && workbench.fullPatch !== undefined) {
      const mapped = mapFindingLocation(parseUnifiedPatch(workbench.fullPatch), {
        file: finding.file,
        lineStart: finding.lineStart,
        ...(finding.lineEnd === undefined ? {} : { lineEnd: finding.lineEnd }),
        ...(finding.diffSide === undefined ? {} : { diffSide: finding.diffSide }),
      });
      const path = mapped.path === undefined ? undefined : parseRepoRelativePath(mapped.path);
      const line = mapped.line;
      const side = mapped.side;
      if (path !== undefined && path._tag === "ok" && line !== undefined && side !== undefined) {
        const startLine = mapped.startLine ?? line;
        const anchor = { path: path.value, startLine, line, side };
        const fingerprint = fingerprintPatchAnchor(workbench.fullPatch, anchor);
        if (fingerprint !== undefined) {
          command = { _tag: "AddFindingInlineComment", reviewId, findingId: finding.id, runId, anchor, fingerprint, body };
        } else {
          command = { _tag: "AddFindingGeneralComment", reviewId, findingId: finding.id, runId, body };
        }
      } else {
        command = { _tag: "AddFindingGeneralComment", reviewId, findingId: finding.id, runId, body };
      }
    } else {
      command = { _tag: "AddFindingGeneralComment", reviewId, findingId: finding.id, runId, body };
    }
    const value = await requestJson("/v1/reviews/batch", { method: "POST", body: { profileId, sessionId: workbench.session.id, expectedRevision: batch.updatedAt, command } });
    const next = parseBatchResponse(value);
    if (next === undefined) throw new Error("Invalid Review batch response");
    onWorkbenchPatch({ draft: next });
  };
  return (
    <section aria-label="Review insights" className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Insights</h2>
          <p className="text-sm text-muted-foreground">Run independent explanations for this Review snapshot.</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={model} onValueChange={(value) => setModel(value ?? null)}>
            <SelectTrigger size="sm" aria-label="Insight model"><SelectValue placeholder="Model" /></SelectTrigger>
            <SelectContent><SelectContentGroup models={models} /></SelectContent>
          </Select>
          <Select value={reasoning} onValueChange={(value) => setReasoning(value as "low" | "medium" | "high")}>
            <SelectTrigger size="sm" aria-label="Insight reasoning"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="high">High</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {catalogError ? <p role="alert" className="text-sm text-destructive">Insight models are unavailable.</p> : null}
      <div className="grid gap-4 md:grid-cols-2">
        <InsightCard
          title="Analysis"
          description="Findings, verdict, validation plan, and bounded evidence."
          projection={workbench.insights.analysis}
          runStatus={analysisRun.status}
          busy={analysisRun.busy}
          onRun={() => { if (model !== null) analysisRun.run(model, reasoning); }}
          onCancel={analysisRun.cancel}
          disabled={!runEnabled}
          {...(analysisFindings === undefined ? {} : { findings: analysisFindings })}
          onAddFinding={addFinding}
        >
          {workbench.insights.analysis.retained?.value.summary}
        </InsightCard>
        <InsightCard
          title="Walkthrough"
          description="A narrative guide through the changed code and supporting hunks."
          projection={workbench.insights.walkthrough}
          runStatus={walkthroughRun.status}
          busy={walkthroughRun.busy}
          onRun={() => { if (model !== null) walkthroughRun.run(model, reasoning); }}
          onCancel={walkthroughRun.cancel}
          disabled={!runEnabled}
        >
          {workbench.insights.walkthrough.retained?.value.focus}
        </InsightCard>
      </div>
      <p className="sr-only" aria-live="polite">{insightLiveStatus(analysisRun.status, walkthroughRun.status)}</p>
    </section>
  );
}

function SelectContentGroup({ models }: { readonly models: ReadonlyArray<{ readonly id: string; readonly label: string }> }): React.JSX.Element {
  return <SelectGroup>{models.map((candidate) => <SelectItem key={candidate.id} value={candidate.id}>{candidate.label}</SelectItem>)}</SelectGroup>;
}

type InsightProjection = WorkbenchResponse["insights"]["analysis"] | WorkbenchResponse["insights"]["walkthrough"];
function InsightCard({
  title,
  description,
  projection,
  runStatus,
  busy,
  onRun,
  onCancel,
  disabled,
  findings,
  onAddFinding,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly projection: InsightProjection;
  readonly runStatus: string;
  readonly busy: boolean;
  readonly onRun: () => void;
  readonly onCancel: () => void;
  readonly disabled: boolean;
  readonly findings?: ReadonlyArray<AnalysisFinding>;
  readonly onAddFinding?: (finding: AnalysisFinding) => Promise<void>;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const status = busy && runStatus !== "idle" ? runStatus : projection.status;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{title}</CardTitle>
          <Badge variant={status === "failed" || status === "error" ? "destructive" : "secondary"}>{insightStatusLabel(status)}</Badge>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-20 flex-col gap-2">
        {busy ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /> Generating a bounded result…</div> : null}
        {children !== undefined ? <p className="line-clamp-4 text-sm text-muted-foreground">{children}</p> : <p className="text-sm text-muted-foreground">No retained result for this revision.</p>}
        {findings === undefined || findings.length === 0 || onAddFinding === undefined ? null : <ul className="flex flex-col gap-2 border-t pt-2">{findings.slice(0, 5).map((finding) => <li key={finding.id} className="flex items-start justify-between gap-2 text-xs"><span className="min-w-0 truncate">{finding.title}</span><Button size="xs" variant="outline" onClick={() => void onAddFinding(finding)}>Add</Button></li>)}</ul>}
      </CardContent>
      <CardFooter className="flex gap-2">
        {busy ? <Button variant="outline" onClick={onCancel}>Cancel</Button> : <Button onClick={onRun} disabled={disabled}>{projection.retained === undefined ? "Run" : "Regenerate"}</Button>}

      </CardFooter>
    </Card>
  );
}

function insightLiveStatus(analysis: string, walkthrough: string): string {
  const active = [analysis, walkthrough].filter((status) => status !== "idle");
  return active.length === 0 ? "" : `Analysis ${analysis}; Walkthrough ${walkthrough}`;
}

function PublishedFeedbackSlot({ workbench }: { readonly workbench: WorkbenchResponse }): React.JSX.Element | null {
  const count = workbench.publishedFeedback.reviews.length + workbench.publishedFeedback.comments.length;
  return count === 0 ? null : <p className="border-t px-4 py-2 text-sm text-muted-foreground">Published feedback · {count}</p>;
}

function DraftSlot({
  workbench,
  onWorkbenchPatch,
}: {
  readonly workbench: WorkbenchResponse;
  readonly onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void;
}): React.JSX.Element | null {
  if (workbench.draft === undefined) return null;
  const batch = parseReviewBatch(workbench.draft);
  if (batch._tag === "err") return null;
  const postCommand = async (command: unknown): Promise<void> => {
    const value = await requestJson("/v1/reviews/batch", {
      method: "POST",
      body: {
        profileId: workbench.session.key.profileId,
        sessionId: workbench.session.id,
        expectedRevision: workbench.draft?.updatedAt,
        command,
      },
    });
    const next = parseBatchResponse(value);
    if (next === undefined) throw new Error("Invalid Review batch response");
    onWorkbenchPatch({ draft: next });
  };
  const actions: ReviewBatchPanelActions = {
    addInlineComment: async (input) => postCommand({
      _tag: "AddInlineComment",
      anchor: { path: input.path, startLine: input.startLine, line: input.line, side: input.side },
      ...(input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint }),
      body: input.body,
    }),
    removeItem: async (itemId) => postCommand({ _tag: "RemoveItem", itemId }),
    addThreadReply: async (threadId, body) => postCommand({ _tag: "AddThreadReply", threadId, body }),
    setThreadState: async (threadId, action) => postCommand({ _tag: "SetThreadState", threadId, action }),
    apply: async () => {
      const value = await requestJson("/v1/reviews/apply-batch", { method: "POST", body: { profileId: workbench.session.key.profileId, sessionId: workbench.session.id, expectedRevision: workbench.draft?.updatedAt, acknowledgement: true } });
      const next = parseBatchResponse(value);
      if (next !== undefined) onWorkbenchPatch({ draft: next });
    },
    submit: async (event) => {
      const value = await requestJson("/v1/reviews/submit-batch", { method: "POST", body: { profileId: workbench.session.key.profileId, sessionId: workbench.session.id, expectedRevision: workbench.draft?.updatedAt, acknowledgement: true, event } });
      const next = parseBatchResponse(value);
      if (next !== undefined) onWorkbenchPatch({ draft: next });
    },
  };
  return <div className="border-t px-4 py-4"><ReviewBatchPanel batch={batch.value} {...(workbench.fullPatch === undefined ? {} : { patch: workbench.fullPatch })} writeBlocked={workbench.revision.freshness !== "fresh"} actions={actions} /></div>;
}

function parseBatchResponse(value: unknown): WorkbenchResponse["draft"] | undefined {
  if (typeof value !== "object" || value === null || !("batch" in value)) return undefined;
  return parseReviewBatchProjection(value.batch);
}

function insightStatusLabel(status: string): string {
  switch (status) {
    case "not_generated": return "Not generated";
    case "running": return "Running";
    case "current": return "Current";
    case "outdated": return "Outdated";
    case "failed": return "Failed";
    case "error": return "Error";
    case "idle": return "Idle";
    default: return status;
  }
}

function isDetection(value: unknown): value is { readonly updatesAvailable: boolean } {
  return typeof value === "object" && value !== null && "updatesAvailable" in value && typeof value.updatesAvailable === "boolean";
}
