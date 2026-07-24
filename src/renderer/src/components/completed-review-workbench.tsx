import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Copy,
  GitPullRequest,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  ShieldCheck,
} from "lucide-react";

import type {
  CheckSummary,
  GitHubComments,
  PullRequestSummary,
} from "../../../domain/github-context";
import type {
  GitHubReviewEvent,
  ReviewDraft,
} from "../../../domain/review-draft";
import type { ReviewResult } from "../../../domain/review-result";
import type { FindingLifecycleEntry } from "../../../domain/finding-lifecycle";
import type { RevisionComparison, ReviewScopeProjection } from "../../../domain/review-comparison";
import type { MergeReadiness } from "../../../domain/merge-readiness";
import { parseUnifiedPatch } from "../../../domain/patch";
import { ChangedFileTree } from "./changed-file-tree";
import { ReviewChecks } from "./review-checks";
import { ReviewDiffView } from "./review-diff-view";
import { ReviewDraftSheet, type DraftSaveState } from "./review-draft-sheet";
import { ReviewSubmissionDialog } from "./review-submission-dialog";
import {
  MergeConfirmationDialog,
  type MergeMethod,
} from "./merge-confirmation-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  loadReviewViewPreferences,
  saveReviewViewPreferences,
  type ReviewViewPreferences,
} from "@/review-view-preferences";
import { parseReviewDiff } from "@/review-diff-data";

export type ReviewHistoryItem = {
  readonly id: string;
  readonly state: string;
  readonly startedAt?: string;
};

type FixQueueStatus = "todo" | "investigating" | "resolved";
const FIX_QUEUE_STATUSES: ReadonlyArray<FixQueueStatus> = ["todo", "investigating", "resolved"];
type FindingFilter = {
  readonly severity: "all" | "P0" | "P1" | "P2" | "P3";
  readonly confidence: "all" | "high" | "medium" | "low";
  readonly mapping: "all" | "mapped" | "unmapped";
  readonly category: "all" | "bug" | "security" | "test" | "performance" | "maintainability" | "docs";
};
const DEFAULT_FINDING_FILTER: FindingFilter = { severity: "all", confidence: "all", mapping: "all", category: "all" };

export type CompletedReviewWorkbenchModel = {
  readonly source: { readonly profileId: string; readonly sessionId: string };
  readonly result: ReviewResult;
  readonly reviewScope: ReviewScopeProjection;
  readonly fullPatch?: string;
  readonly comparison?: RevisionComparison;
  readonly comparisonPatch?: string;
  readonly lifecycle?: ReadonlyArray<FindingLifecycleEntry>;
  readonly comparisonAvailability: "available" | "not_requested" | "incomplete" | "missing";
  readonly pullRequest?: PullRequestSummary;
  readonly reviewedHeadSha: string;
  readonly currentHeadSha?: string;
  readonly freshness: "fresh" | "stale" | "unavailable";
  readonly refreshedAt: string;
  readonly draft: ReviewDraft;
  readonly comments: GitHubComments;
  readonly checks: CheckSummary;
  readonly history: ReadonlyArray<ReviewHistoryItem>;
  readonly mergeReadiness?: MergeReadiness;
};

export type CompletedReviewWorkbenchActions = {
  readonly saveDraft: (input: {
    readonly expectedRevision: string;
    readonly summaryBody: string;
    readonly comments: ReadonlyArray<{
      readonly findingId: string;
      readonly include: boolean;
      readonly body: string;
    }>;
  }) => Promise<{ readonly draft: ReviewDraft; readonly revision: string }>;
  readonly createPendingReview: () => Promise<{ readonly reviewId: string }>;
  readonly submitPendingReview: (
    event: GitHubReviewEvent,
    summaryBody: string,
  ) => Promise<{ readonly reviewId: string }>;
  readonly merge?: (
    method: MergeMethod,
    acknowledgedWarnings: boolean,
  ) => Promise<{ readonly mergeCommitSha?: string }>;
  readonly reportNavigationState: (
    state: "clear" | "dirty_draft" | "write_pending",
  ) => void;
};

/** Owns completed-review-local selection, filtering, draft safety, and view state. */
export function CompletedReviewWorkbench({
  model,
  actions,
}: {
  readonly model: CompletedReviewWorkbenchModel;
  readonly actions: CompletedReviewWorkbenchActions;
}): React.JSX.Element {
  const props = {
    profileId: model.source.profileId,
    sourceSession: model.source,
    result: model.result,
    reviewScope: model.reviewScope,
    fullPatch: model.fullPatch,
    comparison: model.comparison,
    comparisonPatch: model.comparisonPatch,
    lifecycle: model.lifecycle,
    comparisonAvailability: model.comparisonAvailability,
    pullRequest: model.pullRequest,
    reviewedHeadSha: model.reviewedHeadSha,
    currentHeadSha: model.currentHeadSha,
    freshness: model.freshness,
    refreshedAt: model.refreshedAt,
    comments: model.comments,
    checks: model.checks,
    history: model.history,
    onNavigationStateChange: actions.reportNavigationState,
    draftEditor: { draft: model.draft, onSave: actions.saveDraft },
    submission: {
      draft: model.draft,
      onCreatePending: actions.createPendingReview,
      onSubmitPending: actions.submitPendingReview,
    },
    merge: model.mergeReadiness === undefined || model.pullRequest === undefined || actions.merge === undefined
      ? undefined
      : {
          readiness: model.mergeReadiness,
          context: {
            repo: `${model.pullRequest.ref.owner}/${model.pullRequest.ref.repo}`,
            prNumber: model.pullRequest.ref.number,
            title: model.pullRequest.title,
            base: model.pullRequest.baseBranch,
            head: model.pullRequest.headBranch,
            headSha: model.pullRequest.headSha,
          },
          methods: ["squash", "merge", "rebase"] as const,
          onMerge: actions.merge,
        },
  };
  const fixQueueKey = `patchdesk.fix-queue.v1.${props.profileId}.${props.reviewedHeadSha ?? props.result.summary}`;
  const [fixQueue, setFixQueue] = useState<Record<string, FixQueueStatus>>(() => loadFixQueue(fixQueueKey));
  useEffect(() => setFixQueue(loadFixQueue(fixQueueKey)), [fixQueueKey]);
  const updateFixQueue = (findingId: string, status: FixQueueStatus): void => {
    setFixQueue((current) => {
      const next = { ...current, [findingId]: status };
      saveFixQueue(fixQueueKey, next);
      return next;
    });
  };
  const [diffSurface, setDiffSurface] = useState<"updates" | "full">(
    props.reviewScope?.kind === "incremental" && props.comparisonPatch !== undefined
      ? "updates"
      : "full",
  );
  const activePatch = diffSurface === "updates" ? props.comparisonPatch : props.fullPatch;
  const files = useMemo(
    () => (activePatch === undefined ? [] : parseUnifiedPatch(activePatch)),
    [activePatch],
  );
  const parsedDiff = useMemo(
    () => parseReviewDiff(activePatch ?? ""),
    [activePatch],
  );
  const changedFiles = useMemo(
    () =>
      files.map((file) => ({
        path: file.newPath,
        stats: parsedDiff.statsByPath.get(file.newPath) ?? {
          path: file.newPath,
          additions: 0,
          deletions: 0,
        },
      })),
    [files, parsedDiff.statsByPath],
  );
  const [selectedPath, setSelectedPath] = useState<string | undefined>(
    files[0]?.newPath,
  );
  const [selectedFinding, setSelectedFinding] =
    useState<ReviewResult["findings"][number]>();
  const [findingFilter, setFindingFilter] = useState<FindingFilter>(DEFAULT_FINDING_FILTER);
  const [selectedAttempt, setSelectedAttempt] = useState<string>();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const [draftSaveState, setDraftSaveState] = useState<DraftSaveState>("saved");
  const [writePending, setWritePending] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const preferenceProfileId = props.profileId ?? "default";
  const [preferences, setPreferences] = useState<ReviewViewPreferences>(() =>
    loadReviewViewPreferences(preferenceProfileId),
  );
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const inspectorOpen = preferences.detailsRailOpen;
  const reviewRailOpen = preferences.reviewRailOpen;
  useEffect(() => {
    setPreferences(loadReviewViewPreferences(preferenceProfileId));
  }, [preferenceProfileId]);
  const freshness = props.freshness;
  const writeBlocked = freshness !== "fresh" || draftSaveState !== "saved";
  const selectFinding = (finding: ReviewResult["findings"][number]): void => {
    setSelectedFinding(finding);
    if (finding.mappingStatus === "mapped" && finding.file !== undefined) {
      const path = finding.file;
      setSelectedPath(path);
      setCollapsedPaths((current) => {
        if (!current.has(path)) return current;
        const next = new Set(current);
        next.delete(path);
        return next;
      });
    }
  };
  const selectFile = (path: string): void => {
    setSelectedFinding(undefined);
    setSelectedPath(path);
    setCollapsedPaths((current) => {
      if (!current.has(path)) return current;
      const next = new Set(current);
      next.delete(path);
      return next;
    });
  };
  const updatePreferences = (update: Partial<ReviewViewPreferences>): void => {
    setPreferences(saveReviewViewPreferences(preferenceProfileId, update));
  };
  const filteredFindings = useMemo(
    () => props.result.findings.filter((finding) =>
      (findingFilter.severity === "all" || finding.severity === findingFilter.severity) &&
      (findingFilter.confidence === "all" || finding.confidence === findingFilter.confidence) &&
      (findingFilter.mapping === "all" || (findingFilter.mapping === "mapped" ? finding.mappingStatus === "mapped" : finding.mappingStatus !== "mapped")) &&
      (findingFilter.category === "all" || finding.category === findingFilter.category),
    ),
    [findingFilter, props.result.findings],
  );
  const selectedFindingIndex =
    selectedFinding === undefined
      ? -1
      : filteredFindings.findIndex(
          (finding) => finding.id === selectedFinding.id,
        );
  const navigateFinding = (offset: -1 | 1): void => {
    const next = filteredFindings[selectedFindingIndex + offset];
    if (next !== undefined) selectFinding(next);
  };
  const selectedRange =
    selectedFinding?.mappingStatus === "mapped" &&
    selectedFinding.lineStart !== undefined &&
    selectedFinding.diffSide !== undefined
      ? {
          start: selectedFinding.lineStart,
          end: selectedFinding.lineEnd ?? selectedFinding.lineStart,
          side: selectedFinding.diffSide,
        }
      : undefined;
  const updateDraftSaveState = (state: DraftSaveState): void => {
    setDraftSaveState(state);
    props.onNavigationStateChange?.(
      writePending
        ? "write_pending"
        : state === "saved"
          ? "clear"
          : "dirty_draft",
    );
  };
  const updateWritePending = (pending: boolean): void => {
    setWritePending(pending);
    props.onNavigationStateChange?.(
      pending
        ? "write_pending"
        : draftSaveState === "saved"
          ? "clear"
          : "dirty_draft",
    );
  };

  const copyValidationPlan = async (): Promise<void> => {
    try {
      if (navigator.clipboard === undefined) throw new Error("unavailable");
      await navigator.clipboard.writeText(
        props.result.validationPlan.join("\n"),
      );
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <section
      aria-label="Completed review workbench"
      data-density={preferences.density}
      className="min-w-0 overflow-x-hidden"
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b bg-card px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>
              <CheckCircle2 />
              Review complete
            </Badge>
            <Badge variant="outline">{props.result.verdict}</Badge>
            <Badge
              variant={freshness === "fresh" ? "secondary" : "destructive"}
            >
              {freshness === "fresh"
                ? "GitHub: Current"
                : freshness === "stale"
                  ? "GitHub: Changed since review"
                  : "GitHub: Unavailable"}
            </Badge>
            {props.reviewScope?.kind === "incremental" ? (
              <Badge variant="outline">Incremental review</Badge>
            ) : null}
          </div>
          <h1
            className="mt-1.5 truncate text-lg font-semibold"
            title={props.pullRequest?.title ?? props.result.changeSummary}
          >
            {props.pullRequest?.title ?? props.result.changeSummary}
          </h1>
          <p className="mt-1 break-words text-sm text-muted-foreground">
            {props.pullRequest === undefined
              ? props.result.summary
              : `${props.pullRequest.ref.owner}/${props.pullRequest.ref.repo}#${props.pullRequest.ref.number} · ${props.pullRequest.baseBranch} ← ${props.pullRequest.headBranch}`}
          </p>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <p>Reviewed head</p>
          <code className="text-foreground">
            {(
              props.reviewedHeadSha ??
              props.pullRequest?.headSha ??
              "unavailable"
            ).slice(0, 12)}
          </code>
          {props.refreshedAt === undefined ? null : (
            <p className="mt-1">Refreshed {props.refreshedAt}</p>
          )}
        </div>
      </header>
      {freshness !== "fresh" ? (
        <Alert variant="destructive" className="m-4">
          <CircleAlert />
          <AlertTitle>
            {freshness === "stale"
              ? "GitHub posting is blocked because this review head is stale."
              : "GitHub state is unavailable."}
          </AlertTitle>
          <AlertDescription>
            The saved result remains readable, but submit and merge stay
            disabled until Patchdesk confirms the current head.
          </AlertDescription>
        </Alert>
      ) : null}
      <div
        className={`grid min-h-[calc(100vh-8.5rem)] min-w-0 grid-cols-1 min-[1100px]:h-[calc(100vh-8.5rem)] ${reviewRailOpen ? "min-[1100px]:grid-cols-[13rem_minmax(0,1fr)]" : "min-[1100px]:grid-cols-[minmax(0,1fr)]"} ${reviewRailOpen && inspectorOpen ? "min-[1200px]:grid-cols-[13rem_minmax(0,1fr)_20rem]" : inspectorOpen ? "min-[1200px]:grid-cols-[minmax(0,1fr)_20rem]" : ""}`}
      >
        {reviewRailOpen ? (
          <aside
            id="review-navigation"
            aria-label="Review navigation"
            className="min-w-0 overflow-auto border-r bg-card p-2 max-[1099px]:hidden"
          >
            <Tabs defaultValue="files">
              <div className="flex flex-wrap items-center gap-1.5">
                <TabsList className="w-full">
                  <TabsTrigger value="files">Files</TabsTrigger>
                  <TabsTrigger value="findings">
                    Findings
                    <Badge
                      variant="secondary"
                      className="ml-1 px-1.5 py-0 text-[10px]"
                    >
                      {props.result.findings.length}
                    </Badge>
                  </TabsTrigger>
                </TabsList>
                <SeverityCounts findings={props.result.findings} />
              </div>
              <TabsContent value="files" className="mt-3">
                <ChangedFileTree
                  files={changedFiles}
                  {...(selectedPath === undefined ? {} : { selectedPath })}
                  onSelect={selectFile}
                />
              </TabsContent>
              <TabsContent value="findings" className="mt-3">
                <FindingFilters value={findingFilter} onChange={setFindingFilter} />
                <FindingList
                  findings={filteredFindings}
                  selectedFinding={selectedFinding}
                  onSelect={selectFinding}
                />
              </TabsContent>
            </Tabs>
          </aside>
        ) : null}
        <div
          data-review-scroll-container
          className="flex min-h-0 min-w-0 flex-col overflow-hidden"
        >
          <div
            data-review-workbench-toolbar
            className="sticky top-0 z-30 flex min-h-10 flex-wrap items-center justify-between gap-2 border-b bg-background/95 px-2 py-1.5 backdrop-blur"
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <Button
                variant="ghost"
                size="icon-xs"
                className="max-[1099px]:hidden"
                aria-label={
                  reviewRailOpen
                    ? "Hide review navigator"
                    : "Show review navigator"
                }
                aria-expanded={reviewRailOpen}
                aria-controls="review-navigation"
                onClick={() =>
                  updatePreferences({ reviewRailOpen: !reviewRailOpen })
                }
              >
                {reviewRailOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
              </Button>
              <div className="min-w-0">
                <p className="break-all text-sm font-medium">
                  {selectedPath ?? "Stored result"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {selectedFinding === undefined
                    ? "Select a finding to navigate to its file"
                    : selectedRange === undefined
                      ? `Finding ${selectedFinding.id} · no mapped line`
                      : `Finding ${selectedFinding.id} · ${selectedRange.side === "new" ? "new" : "old"} lines ${selectedRange.start}–${selectedRange.end}`}
                </p>
              </div>
            </div>
            <div className="ml-auto flex items-center gap-1">
              {props.reviewScope?.kind === "incremental" ? (
                <Tabs value={diffSurface} onValueChange={(value) => setDiffSurface(value === "updates" ? "updates" : "full")}>
                  <TabsList>
                    <TabsTrigger value="updates" disabled={props.comparisonPatch === undefined}>Updates</TabsTrigger>
                    <TabsTrigger value="full">Full PR</TabsTrigger>
                  </TabsList>
                </Tabs>
              ) : null}
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Previous finding"
                disabled={selectedFindingIndex <= 0}
                onClick={() => navigateFinding(-1)}
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Next finding"
                disabled={
                  selectedFindingIndex < 0 ||
                  selectedFindingIndex >= filteredFindings.length - 1
                }
                onClick={() => navigateFinding(1)}
              >
                <ChevronRight />
              </Button>
              <Button
                variant="outline"
                size="sm"
                aria-expanded={inspectorOpen}
                aria-controls="review-inspector"
                onClick={() =>
                  updatePreferences({ detailsRailOpen: !inspectorOpen })
                }
              >
                {inspectorOpen ? <PanelRightClose /> : <PanelRightOpen />}
                {inspectorOpen ? "Hide details" : "Show details"}
              </Button>
              <Sheet open={navigationOpen} onOpenChange={setNavigationOpen}>
                <SheetTrigger
                  render={
                    <Button
                      variant="outline"
                      size="sm"
                      className="hidden max-[1099px]:inline-flex"
                    />
                  }
                >
                  Files and findings
                </SheetTrigger>
                <SheetContent side="left">
                  <SheetHeader>
                    <SheetTitle>Files and findings</SheetTitle>
                    <SheetDescription>
                      Navigate the stored patch and review findings.
                    </SheetDescription>
                  </SheetHeader>
                  <div className="min-h-0 overflow-auto p-4">
                    <Tabs defaultValue="files">
                      <TabsList className="w-full">
                        <TabsTrigger value="files">Files</TabsTrigger>
                        <TabsTrigger value="findings">Findings</TabsTrigger>
                      </TabsList>
                      <TabsContent value="files" className="mt-3">
                        <ChangedFileTree
                          files={changedFiles}
                          {...(selectedPath === undefined
                            ? {}
                            : { selectedPath })}
                          onSelect={(path) => {
                            selectFile(path);
                            setNavigationOpen(false);
                          }}
                        />
                      </TabsContent>
                      <TabsContent value="findings" className="mt-3">
                        <SeverityCounts findings={props.result.findings} />
                        <FindingFilters value={findingFilter} onChange={setFindingFilter} />
                        <FindingList
                          findings={filteredFindings}
                          selectedFinding={selectedFinding}
                          onSelect={(finding) => {
                            selectFinding(finding);
                            setNavigationOpen(false);
                          }}
                        />
                      </TabsContent>
                    </Tabs>
                  </div>
                </SheetContent>
              </Sheet>
            </div>
          </div>
          {activePatch === undefined ? (
            <Alert className="m-5">
              <AlertTitle>{diffSurface === "updates" ? "Comparison patch unavailable" : "Stored patch unavailable"}</AlertTitle>
              <AlertDescription>
                This older session can show its review result, but Patchdesk
                cannot reconstruct its diff.
              </AlertDescription>
            </Alert>
          ) : (
            <ReviewDiffView
              patch={activePatch}
              parsedFiles={parsedDiff.files}
              fileStatsByPath={parsedDiff.statsByPath}
              {...(selectedPath === undefined ? {} : { selectedPath })}
              {...(selectedRange === undefined ? {} : { selectedRange })}
              preferences={preferences}
              collapsedPaths={collapsedPaths}
              onPreferencesChange={updatePreferences}
              onCollapsedPathsChange={setCollapsedPaths}
              {...(props.sourceSession === undefined
                ? {}
                : { sourceSession: props.sourceSession })}
            />
          )}
        </div>
        {inspectorOpen ? (
          <aside
            id="review-inspector"
            aria-label="Review result and actions"
            className="min-w-0 overflow-hidden border-t bg-card min-[1100px]:col-span-2 min-[1200px]:col-span-1 min-[1200px]:border-l min-[1200px]:border-t-0"
          >
            <ScrollArea className="h-auto min-[1200px]:h-[calc(100vh-8.5rem)]">
              <div className="min-w-0 space-y-5 p-4 [overflow-wrap:anywhere] [&_*]:min-w-0">
                <section>
                  <h2 className="font-semibold">Review result</h2>
                  <p className="mt-2 break-words text-sm text-muted-foreground">
                    {props.result.summary}
                  </p>
                  <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-md border p-2"><dt className="text-muted-foreground">Freshness</dt><dd className="mt-1 font-medium">{freshness === "fresh" ? "Current head confirmed" : freshness === "stale" ? "Head changed" : "Current head unavailable"}</dd></div>
                    <div className="rounded-md border p-2"><dt className="text-muted-foreground">Evidence</dt><dd className="mt-1 font-medium">{props.result.findings.length} mapped finding{props.result.findings.length === 1 ? "" : "s"}</dd></div>
                    <div className="rounded-md border p-2"><dt className="text-muted-foreground">Reviewed SHA</dt><dd className="mt-1 font-mono">{(props.reviewedHeadSha ?? "unavailable").slice(0, 12)}</dd></div>
                    <div className="rounded-md border p-2"><dt className="text-muted-foreground">Lifecycle</dt><dd className="mt-1 font-medium">Local only until you confirm a GitHub write</dd></div>
                  </dl>
                </section>
                {selectedFinding === undefined ? null : (
                  <>
                    <Separator />
                    <section aria-label="Selected finding detail">
                      <div className="flex flex-wrap items-center gap-2"><SeverityBadge severity={selectedFinding.severity} /><h2 className="font-semibold">{selectedFinding.title}</h2></div>
                      <p className="mt-2 text-sm text-muted-foreground">{selectedFinding.explanation}</p>
                      <dl className="mt-3 grid gap-2 text-sm">
                        <div><dt className="text-xs text-muted-foreground">Evidence</dt><dd>{selectedFinding.mappingStatus === "mapped" && selectedFinding.file !== undefined && selectedFinding.lineStart !== undefined ? `${selectedFinding.file} · ${selectedFinding.diffSide === "old" ? "old" : "new"} lines ${selectedFinding.lineStart}–${selectedFinding.lineEnd ?? selectedFinding.lineStart}` : "Unmapped evidence — inspect before drafting a comment"}</dd></div>
                        <div><dt className="text-xs text-muted-foreground">Confidence</dt><dd>{confidenceText(selectedFinding.confidence)}</dd></div>
                        {selectedFinding.affectedScenario === undefined ? null : <div><dt className="text-xs text-muted-foreground">Affected scenario</dt><dd>{selectedFinding.affectedScenario}</dd></div>}
                        {selectedFinding.whyItMatters === undefined ? null : <div><dt className="text-xs text-muted-foreground">Why it matters</dt><dd>{selectedFinding.whyItMatters}</dd></div>}
                        {selectedFinding.suggestedChange === undefined ? null : <div><dt className="text-xs text-muted-foreground">Suggested change</dt><dd>{selectedFinding.suggestedChange}</dd></div>}
                      </dl>
                    </section>
                  </>
                )}
                <Separator />
                <section>
                  <h2 className="font-semibold">Fix queue</h2>
                  <p className="mt-1 text-xs text-muted-foreground">Local next steps only. Patchdesk never applies changes or writes to GitHub automatically.</p>
                  <ul className="mt-2 space-y-1.5">
                    {props.result.findings.map((finding) => {
                      const status = fixQueue[finding.id] ?? "todo";
                      return (
                        <li key={finding.id} className="rounded-md border p-2 text-sm">
                          <div className="flex items-start gap-2">
                            <SeverityBadge severity={finding.severity} />
                            <p className="min-w-0 font-medium">{finding.title}</p>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {finding.mappingStatus === "mapped"
                              ? `Mapped evidence · ${confidenceText(finding.confidence)}`
                              : "Unmapped evidence — inspect before drafting a comment"}
                          </p>
                          <div className="mt-2 flex items-center justify-between gap-2">
                            <span className="text-xs text-muted-foreground">Local status</span>
                            <Select
                              value={status}
                              onValueChange={(value) => {
                                if (FIX_QUEUE_STATUSES.includes(value as FixQueueStatus)) {
                                  updateFixQueue(finding.id, value as FixQueueStatus);
                                }
                              }}
                            >
                              <SelectTrigger
                                size="sm"
                                className="h-7 w-32 text-xs"
                                aria-label={`Fix queue status for ${finding.title}`}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {FIX_QUEUE_STATUSES.map((value) => (
                                  <SelectItem key={value} value={value} className="text-xs">
                                    {fixQueueStatusLabel(value)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
                {props.reviewScope?.kind !== "incremental" ? null : (
                  <>
                    <Separator />
                    <section>
                      <h2 className="font-semibold">Incremental review</h2>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {props.comparisonAvailability === "available"
                          ? `${props.comparison?.commits.length ?? 0} commits · +${props.comparison?.additions ?? 0} −${props.comparison?.deletions ?? 0}`
                          : "Comparison evidence is unavailable; use Full PR for complete context."}
                      </p>
                      {props.lifecycle === undefined ? null : (
                        <ul className="mt-3 space-y-1 text-sm">
                          {props.lifecycle.map((entry, index) => (
                            <li key={`${entry.status}-${entry.currentFindingId ?? entry.priorFindingId ?? index}`} className="flex items-center justify-between gap-2 rounded border px-2 py-1.5">
                              <span className="truncate">{entry.title}</span>
                              <Badge variant="outline">{entry.status.replace("_", " ")}</Badge>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  </>
                )}
                <Separator />
                <section>
                  <h2 className="font-semibold">Assumptions and unresolved items</h2>
                  <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                    {props.result.assumptions.length === 0 ? <li>Not provided by this review.</li> : props.result.assumptions.map((item) => <li key={item}>Assumption: {item}</li>)}
                    {props.result.unresolvedItems === undefined || props.result.unresolvedItems.length === 0 ? null : props.result.unresolvedItems.map((item) => <li key={item}>Unresolved: {item}</li>)}
                  </ul>
                </section>
                {props.result.callouts === undefined || props.result.callouts.length === 0 ? null : <>
                  <Separator />
                  <section>
                    <h2 className="font-semibold">Human callouts</h2>
                    <ul className="mt-2 space-y-2 text-sm">{props.result.callouts.map((callout) => <li key={`${callout.category}-${callout.title}`} className="rounded-md border p-2"><Badge variant="outline">{callout.category.replaceAll("_", " ")}</Badge><p className="mt-1 font-medium">{callout.title}</p><p className="mt-1 text-muted-foreground">{callout.detail}</p>{callout.path === undefined ? null : <p className="mt-1 font-mono text-xs text-muted-foreground">{callout.path}</p>}</li>)}</ul>
                  </section>
                </>}
                <Separator />
                <section>
                  <h2 className="font-semibold">Draft and GitHub writes</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Every write uses the exact saved local revision and requires
                    confirmation.
                  </p>
                  {props.draftEditor === undefined ? null : (
                    <div className="mt-3">
                      <ReviewDraftSheet
                        draft={props.draftEditor.draft}
                        onSave={props.draftEditor.onSave}
                        onSaveState={updateDraftSaveState}
                      />
                    </div>
                  )}
                  <div className="mt-3">
                    {props.submission === undefined ? (
                      <p className="text-sm text-muted-foreground">
                        GitHub submission is unavailable for this session. The
                        local draft remains editable.
                      </p>
                    ) : writeBlocked ? (
                      <Alert>
                        <ShieldCheck />
                        <AlertTitle>Writes blocked</AlertTitle>
                        <AlertDescription>
                          {freshness !== "fresh"
                            ? "Refresh GitHub state first."
                            : "Save the draft before continuing."}
                        </AlertDescription>
                      </Alert>
                    ) : (
                      <ReviewSubmissionDialog
                        draft={props.submission.draft}
                        findings={props.result.findings}
                        onCreatePending={props.submission.onCreatePending}
                        onSubmitPending={props.submission.onSubmitPending}
                        onPendingChange={updateWritePending}
                      />
                    )}
                  </div>
                </section>
                {props.merge === undefined ? null : (
                  <>
                    <Separator />
                    <section>
                      <h2 className="mb-3 font-semibold">Merge</h2>
                      {writeBlocked ? (
                        <p className="text-sm text-muted-foreground">
                          Merge remains unavailable until the head is fresh and
                          the draft is saved.
                        </p>
                      ) : (
                        <MergeConfirmationDialog
                          readiness={props.merge.readiness}
                          context={props.merge.context}
                          methods={props.merge.methods}
                          onMerge={props.merge.onMerge}
                          onPendingChange={updateWritePending}
                        />
                      )}
                    </section>
                  </>
                )}
                <Separator />
                <section>
                  <ReviewChecks checks={props.checks} freshness={freshness} {...(props.pullRequest === undefined ? {} : { pullRequest: props.pullRequest.ref })} />
                </section>
                <Separator />
                <section>
                  <h2 className="font-semibold">Existing review threads</h2>
                  {props.comments.threads.length === 0 ? (
                    <p className="mt-2 text-sm text-muted-foreground">
                      No existing review threads.
                    </p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {props.comments.threads.map((thread) => (
                        <li
                          key={thread.id}
                          className="rounded-md border p-2 text-sm"
                        >
                          {thread.comments.map((comment) => (
                            <div key={comment.id}>
                              <strong>{comment.author}</strong>
                              <p className="text-muted-foreground">
                                {comment.body}
                              </p>
                            </div>
                          ))}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <Separator />
                <section>
                  <h2 className="font-semibold">Validation plan</h2>
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                    {props.result.validationPlan.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => void copyValidationPlan()}
                  >
                    <Copy />
                    Copy validation plan
                  </Button>
                  {copyState === "copied" ? (
                    <p role="status" className="mt-2 text-sm text-primary">
                      Validation plan copied locally.
                    </p>
                  ) : copyState === "failed" ? (
                    <p role="alert" className="mt-2 text-sm text-destructive">
                      Clipboard access is unavailable.
                    </p>
                  ) : null}
                </section>
                <Separator />
                <section>
                  <h2 className="font-semibold">Review history</h2>
                  <div className="mt-2 space-y-1">
                    {props.history.map((item) => (
                      <Button
                        key={item.id}
                        variant="ghost"
                        size="sm"
                        className="w-full justify-start"
                        onClick={() => setSelectedAttempt(item.id)}
                      >
                        Attempt {item.id}: {item.state}
                      </Button>
                    ))}
                  </div>
                  {selectedAttempt === undefined ? null : (
                    <p role="status" className="mt-2 text-sm text-primary">
                      Viewing attempt {selectedAttempt} metadata.
                    </p>
                  )}
                </section>
                <div className="rounded-lg border bg-muted p-3 text-xs text-muted-foreground">
                  <div className="flex items-center gap-2 font-medium text-foreground">
                    <GitPullRequest className="size-4" />
                    Read-only workbench
                  </div>
                  <p className="mt-1">
                    No write runs without a dedicated confirmation dialog.
                  </p>
                </div>
              </div>
            </ScrollArea>
          </aside>
        ) : null}
      </div>
    </section>
  );
}

function SeverityCounts({
  findings,
}: {
  readonly findings: ReviewResult["findings"];
}): React.JSX.Element {
  return (
    <div aria-label="Finding severity counts" className="flex flex-wrap gap-1">
      {(["P0", "P1", "P2", "P3"] as const).map((severity) => (
        <Badge
          key={severity}
          variant="outline"
          className="px-1.5 py-0 text-[10px]"
        >
          {severityLabel(severity)} · {" "}
          {findings.filter((finding) => finding.severity === severity).length}
        </Badge>
      ))}
    </div>
  );
}

function FindingFilters({
  value,
  onChange,
}: {
  readonly value: FindingFilter;
  readonly onChange: (value: FindingFilter) => void;
}): React.JSX.Element {
  const update = <K extends keyof FindingFilter>(key: K, next: FindingFilter[K] | null): void => {
    if (next !== null) onChange({ ...value, [key]: next });
  };
  return (
    <div className="mt-2 grid gap-1" aria-label="Filter findings">
      <Select value={value.severity} onValueChange={(next) => update("severity", next as FindingFilter["severity"])}>
        <SelectTrigger size="sm" aria-label="Filter findings by severity"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="all">All severities</SelectItem><SelectItem value="P0">P0 Critical</SelectItem><SelectItem value="P1">P1 High</SelectItem><SelectItem value="P2">P2 Medium</SelectItem><SelectItem value="P3">P3 Low</SelectItem></SelectContent>
      </Select>
      <Select value={value.confidence} onValueChange={(next) => update("confidence", next as FindingFilter["confidence"])}>
        <SelectTrigger size="sm" aria-label="Filter findings by confidence"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="all">All confidence</SelectItem><SelectItem value="high">High confidence</SelectItem><SelectItem value="medium">Medium confidence</SelectItem><SelectItem value="low">Low confidence</SelectItem></SelectContent>
      </Select>
      <Select value={value.mapping} onValueChange={(next) => update("mapping", next as FindingFilter["mapping"])}>
        <SelectTrigger size="sm" aria-label="Filter findings by evidence mapping"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="all">All evidence</SelectItem><SelectItem value="mapped">Mapped evidence</SelectItem><SelectItem value="unmapped">Unmapped evidence</SelectItem></SelectContent>
      </Select>
      <Select value={value.category} onValueChange={(next) => update("category", next as FindingFilter["category"])}>
        <SelectTrigger size="sm" aria-label="Filter findings by category"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="all">All categories</SelectItem><SelectItem value="bug">Bug</SelectItem><SelectItem value="security">Security</SelectItem><SelectItem value="test">Test</SelectItem><SelectItem value="performance">Performance</SelectItem><SelectItem value="maintainability">Maintainability</SelectItem><SelectItem value="docs">Docs</SelectItem></SelectContent>
      </Select>
    </div>
  );
}

function severityLabel(severity: "P0" | "P1" | "P2" | "P3"): string {
  return `${severity} ${severity === "P0" ? "Critical" : severity === "P1" ? "High" : severity === "P2" ? "Medium" : "Low"}`;
}

function confidenceText(confidence: "high" | "medium" | "low"): string {
  return `${confidence} confidence`;
}

function SeverityBadge({ severity }: { readonly severity: "P0" | "P1" | "P2" | "P3" }): React.JSX.Element {
  return <Badge variant="outline" className={severity === "P0" || severity === "P1" ? "border-destructive text-foreground" : undefined} aria-label={severityLabel(severity)}>{severityLabel(severity)}</Badge>;
}

function fixQueueStatusLabel(status: FixQueueStatus): string {
  return status === "todo" ? "To do" : status === "investigating" ? "Investigating" : "Resolved";
}

function loadFixQueue(key: string): Record<string, FixQueueStatus> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? "{}");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, FixQueueStatus] => FIX_QUEUE_STATUSES.includes(entry[1] as FixQueueStatus)));
  } catch {
    return {};
  }
}

function saveFixQueue(key: string, statuses: Record<string, FixQueueStatus>): void {
  window.localStorage.setItem(key, JSON.stringify(statuses));
}

function FindingList({
  findings,
  selectedFinding,
  onSelect,
}: {
  readonly findings: ReviewResult["findings"];
  readonly selectedFinding: ReviewResult["findings"][number] | undefined;
  readonly onSelect: (finding: ReviewResult["findings"][number]) => void;
}): React.JSX.Element {
  return (
    <div className="mt-2 space-y-1">
      {findings.map((finding) => {
        const location =
          finding.mappingStatus === "mapped" &&
          finding.file !== undefined &&
          finding.lineStart !== undefined
            ? `${finding.file} · L${finding.lineStart}${finding.lineEnd === undefined ? "" : `–${finding.lineEnd}`}`
            : "Unmapped — not postable";
        return (
          <Button
            key={finding.id}
            variant="ghost"
            className="h-auto w-full items-start justify-start whitespace-normal px-2 py-2 text-left"
            aria-pressed={selectedFinding?.id === finding.id}
            onClick={() => onSelect(finding)}
          >
            <span className="flex min-w-0 flex-col items-start">
              <span className="flex min-w-0 items-start gap-1.5">
                <SeverityBadge severity={finding.severity} />
                <span className="min-w-0 line-clamp-2 leading-5">
                  {finding.title}
                </span>
              </span>
              <span
                className="mt-0.5 block truncate text-xs text-muted-foreground"
                title={location}
              >
                {location}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{confidenceText(finding.confidence)} · {finding.mappingStatus === "mapped" ? "mapped evidence" : "unmapped evidence"}</span>
            </span>
          </Button>
        );
      })}
    </div>
  );
}
