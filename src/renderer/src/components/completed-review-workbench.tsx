import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";

import type {
  CheckSummary,
  GitHubComments,
  PullRequestSummary,
} from "../../../domain/github-context";
import type { ReviewBatch } from "../../../domain/review-batch";
import type { ReviewResult } from "../../../domain/review-result";
import type { FindingLifecycleEntry } from "../../../domain/finding-lifecycle";
import type { RevisionComparison, ReviewScopeProjection } from "../../../domain/review-comparison";
import type { MergeReadiness } from "../../../domain/merge-readiness";
import { parseUnifiedPatch } from "../../../domain/patch";
import { PierreFileTree } from "./pierre-file-tree";
import { ReviewDiffView, type ReviewInlineAnnotation } from "./review-diff-view";
import { type ReviewBatchPanelActions } from "./review-batch-panel";
import { PullRequestOverviewSheet } from "./pr-overview-sheet";
import { type MergeMethod } from "./merge-confirmation-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  loadReviewViewPreferences,
  saveReviewViewPreferences,
  type ReviewViewPreferences,
} from "@/review-view-preferences";
import { parseReviewDiff } from "@/review-diff-data";
import { walkthroughCopy } from "@/review-copy";
import type { WalkthroughProjection } from "../renderer-contracts";
import { NarrativeWalkthrough } from "./narrative-walkthrough";

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
  readonly freshness: "fresh" | "stale" | "unavailable" | "not_refreshed";
  readonly refreshedAt: string;
  readonly batch?: ReviewBatch;
  readonly comments: GitHubComments;
  readonly checks: CheckSummary;
  readonly mergeReadiness?: MergeReadiness;
};

export type CompletedReviewWorkbenchActions = {
  readonly batchActions?: ReviewBatchPanelActions;
  readonly merge?: (
    method: MergeMethod,
    acknowledgedWarnings: boolean,
  ) => Promise<{ readonly mergeCommitSha?: string }>;
  readonly refreshRemote?: () => Promise<void>;
  readonly reportNavigationState: (
    state: "clear" | "dirty_draft" | "write_pending",
  ) => void;
  readonly walkthrough?: CompletedReviewWalkthroughActions;
};

export type CompletedReviewWalkthroughActions = {
  readonly dialogOpen: boolean;
  readonly projection: WalkthroughProjection;
  readonly models: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly model: string | undefined;
  readonly reasoning: "low" | "medium" | "high";
  readonly catalogUnavailable: boolean;
  readonly onOpenDialog: () => void;
  readonly onCloseDialog: () => void;
  readonly onModelChange: (model: string) => void;
  readonly onReasoningChange: (reasoning: "low" | "medium" | "high") => void;
  readonly onConfirm: () => void;
  readonly onRetry: () => void;
  readonly onRegenerate: () => void;
  readonly busy: boolean;
  readonly onOpenTakeover?: () => void;
  readonly onCloseTakeover?: () => void;
  readonly onSelectSection?: (sectionId: string) => void;
  readonly onMarkSectionReviewed?: (sectionId: string) => void;
  readonly onMarkSupportReviewed?: () => void;
  readonly reviewedSectionIds?: ReadonlyArray<string>;
  readonly supportReviewed?: boolean;
};

/** Owns completed-review-local selection, filtering, draft safety, and view state. */
export function CompletedReviewWorkbench({
  model,
  actions,
}: {
  readonly model: CompletedReviewWorkbenchModel;
  readonly actions: CompletedReviewWorkbenchActions;
}): React.JSX.Element {
  const refreshRemote = actions.refreshRemote;
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
    batch: model.batch,
    batchActions: actions.batchActions,
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
        gitStatus: parsedDiff.gitStatusByPath.get(file.newPath),
      })),
    [files, parsedDiff.gitStatusByPath, parsedDiff.statsByPath],
  );
  const [selectedPath, setSelectedPath] = useState<string | undefined>(
    files[0]?.newPath,
  );
  const [activePath, setActivePath] = useState<string | undefined>(
    files[0]?.newPath,
  );
  const [selectedFinding, setSelectedFinding] =
    useState<ReviewResult["findings"][number]>();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [findingsOpen, setFindingsOpen] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [overviewFocus, setOverviewFocus] = useState<"checks">();
  const [walkthroughOpen, setWalkthroughOpen] = useState(false);
  const [walkthroughCurrentSectionId, setWalkthroughCurrentSectionId] = useState<string>();
  const [walkthroughReviewedSectionIds, setWalkthroughReviewedSectionIds] = useState<ReadonlyArray<string>>([]);
  const [walkthroughSupportReviewed, setWalkthroughSupportReviewed] = useState(false);
  const openWalkthroughButtonRef = useRef<HTMLButtonElement>(null);
  const preferenceProfileId = props.profileId ?? "default";
  const [preferences, setPreferences] = useState<ReviewViewPreferences>(() =>
    loadReviewViewPreferences(preferenceProfileId),
  );
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const reviewRailOpen = preferences.reviewRailOpen;
  useEffect(() => {
    setPreferences(loadReviewViewPreferences(preferenceProfileId));
  }, [preferenceProfileId]);
  const walkthroughWasOpenRef = useRef(false);
  useEffect(() => {
    if (walkthroughWasOpenRef.current && !walkthroughOpen) {
      openWalkthroughButtonRef.current?.focus();
    }
    walkthroughWasOpenRef.current = walkthroughOpen;
  }, [walkthroughOpen]);
  const freshness = props.freshness;
  const writeBlocked = freshness !== "fresh";
  const selectFinding = (finding: ReviewResult["findings"][number]): void => {
    setSelectedFinding(finding);
    if (finding.mappingStatus === "mapped" && finding.file !== undefined) {
      const path = finding.file;
      setSelectedPath(path);
      setActivePath(path);
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
    setActivePath(path);
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
  const readyWalkthrough =
    actions.walkthrough?.projection.lifecycle === "ready"
      ? actions.walkthrough.projection.walkthrough
      : undefined;
  useEffect(() => {
    if (readyWalkthrough === undefined) return;
    const firstSectionId = readyWalkthrough.chapters[0]?.sections[0]?.id;
    if (firstSectionId === undefined) return;
    setWalkthroughCurrentSectionId((current) => {
      if (current !== undefined && readyWalkthrough.chapters.some((chapter) => chapter.sections.some((section) => section.id === current))) {
        return current;
      }
      return firstSectionId;
    });
  }, [readyWalkthrough]);
  const selectedFindingIndex =
    selectedFinding === undefined
      ? -1
      : props.result.findings.findIndex(
          (finding) => finding.id === selectedFinding.id,
        );
  const navigateFinding = (offset: -1 | 1): void => {
    const next = props.result.findings[selectedFindingIndex + offset];
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
  const inlineFindingAnnotations = useMemo(
    () =>
      props.result.findings.flatMap((finding): ReadonlyArray<ReviewInlineAnnotation> =>
        finding.mappingStatus === "mapped" &&
        finding.file !== undefined &&
        finding.lineStart !== undefined &&
        finding.diffSide !== undefined
          ? [{
              id: finding.id,
              path: finding.file,
              start: finding.lineStart,
              end: finding.lineEnd ?? finding.lineStart,
              side: finding.diffSide,
              severity: finding.severity,
              title: finding.title,
              explanation: finding.explanation,
            }]
          : [],
      ),
    [props.result.findings],
  );
  const reviewAnnotations = useMemo(
    () => [
      ...inlineFindingAnnotations,
      ...(props.batch?.items.flatMap((item): ReadonlyArray<ReviewInlineAnnotation> =>
        item._tag === "InlineComment"
          ? [{ id: item.id, path: item.anchor.path, start: item.anchor.startLine, end: item.anchor.line, side: item.anchor.side, severity: "info", title: "Local draft", explanation: item.body }]
          : [],
      ) ?? []),
    ],
    [inlineFindingAnnotations, props.batch?.items],
  );
  const walkthroughAnnotations = useMemo(
    () => [
      ...inlineFindingAnnotations,
      ...(props.batch?.items.flatMap((item): ReadonlyArray<ReviewInlineAnnotation> =>
        item._tag === "InlineComment"
          ? [{
              id: item.id,
              path: item.anchor.path,
              start: item.anchor.startLine,
              end: item.anchor.line,
              side: item.anchor.side,
              severity: "info",
              title: "Draft inline comment",
              explanation: item.body,
            }]
          : [],
      ) ?? []),
    ],
    [inlineFindingAnnotations, props.batch?.items],
  );
  return (
    <section
      aria-label="Completed review workbench"
      data-density={preferences.density}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden"
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
        <div className="flex items-start gap-2 text-right text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center gap-2">
            {!overviewOpen ? <Button variant="outline" size="sm" onClick={() => { setOverviewFocus("checks"); setOverviewOpen(true); }}>Checks · {props.checks.overall} · {props.checks.checks.length}</Button> : null}
            <Button variant="outline" size="sm" onClick={() => { setOverviewFocus(undefined); setOverviewOpen(true); }}>PR overview</Button>
            <PullRequestOverviewSheet
              open={overviewOpen}
              onOpenChange={setOverviewOpen}
              {...(overviewFocus === undefined ? {} : { focus: overviewFocus })}
              {...(props.pullRequest === undefined ? {} : { pullRequest: props.pullRequest })}
              {...(activePatch === undefined ? {} : { patch: activePatch })}
              freshness={freshness}
              checks={props.checks}
              comments={props.comments}
              {...(props.batch === undefined ? {} : { batch: props.batch })}
              {...(selectedFinding === undefined ? {} : { selectedFinding })}
              actions={{ ...(props.batchActions === undefined ? {} : { batch: props.batchActions }), ...(props.merge === undefined ? {} : { merge: props.merge }) }}
            />
          </div>
          {refreshRemote === undefined ? null : (
            <Button variant="outline" size="sm" onClick={() => void refreshRemote()}>
              Refresh
            </Button>
          )}
          <div>
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
      {!walkthroughOpen ? <>
      {actions.walkthrough === undefined ? null : (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-4 py-3" data-testid="walkthrough-banner">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Protect review writes · read-only walkthrough</p>
            <p className="text-sm font-medium">{walkthroughCopy(actions.walkthrough.projection.lifecycle).headline}</p>
            <p className="text-xs text-muted-foreground">{walkthroughCopy(actions.walkthrough.projection.lifecycle).reassurance}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {actions.walkthrough.projection.lifecycle === "idle" || actions.walkthrough.projection.lifecycle === "ready" ? (
              <Button
                size="sm"
                variant="outline"
                data-testid="walkthrough-open"
                onClick={actions.walkthrough.onOpenDialog}
              >
                {actions.walkthrough.projection.lifecycle === "idle" ? "Generate walkthrough" : "Generate another walkthrough"}
              </Button>
            ) : null}
            {actions.walkthrough.projection.lifecycle === "ready" && actions.walkthrough.projection.walkthrough !== undefined ? (
              <Button
                ref={openWalkthroughButtonRef}
                size="sm"
                variant="default"
                data-testid="open-walkthrough-takeover"
                onClick={() => {
                  const firstSectionId = readyWalkthrough?.chapters[0]?.sections[0]?.id;
                  if (firstSectionId !== undefined) setWalkthroughCurrentSectionId((current) => current ?? firstSectionId);
                  setWalkthroughOpen(true);
                  actions.walkthrough?.onOpenTakeover?.();
                }}
              >
                Open walkthrough
              </Button>
            ) : null}
            {actions.walkthrough.projection.lifecycle === "failed" ? (
              <Button size="sm" variant="outline" data-testid="walkthrough-retry" onClick={actions.walkthrough.onRetry}>Retry generation</Button>
            ) : null}
            {actions.walkthrough.projection.lifecycle === "stale" ? (
              <Button size="sm" variant="outline" data-testid="walkthrough-regenerate" onClick={actions.walkthrough.onRegenerate}>Generate walkthrough</Button>
            ) : null}
          </div>
        </div>
      )}
      {actions.walkthrough === undefined ? null : (
        <Dialog open={actions.walkthrough.dialogOpen} onOpenChange={(open) => { if (!open) actions.walkthrough?.onCloseDialog(); }}>
          <DialogContent data-testid="walkthrough-generate-dialog">
            <DialogHeader>
              <DialogTitle>Generate a read-only walkthrough</DialogTitle>
              <DialogDescription>Patchdesk reads the stored patch, never writes to GitHub, and never restarts the run.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 py-2">
              <Label className="grid gap-1.5">Model
                <Select
                  value={actions.walkthrough.model}
                  onValueChange={(value) => { if (value !== null) actions.walkthrough?.onModelChange(value); }}
                  disabled={actions.walkthrough.models.length === 0}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {actions.walkthrough.models.map((model) => (
                      <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Label>
              <Label className="grid gap-1.5">Reasoning
                <Select
                  value={actions.walkthrough.reasoning}
                  onValueChange={(value) => {
                    if (value === "low" || value === "medium" || value === "high") actions.walkthrough?.onReasoningChange(value);
                  }}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
              </Label>
              <p className="text-xs text-muted-foreground">The dialog requires a model and reasoning before any generation request can be made.</p>
              {actions.walkthrough.catalogUnavailable ? (
                <p role="status" className="text-sm text-muted-foreground">No enabled review model is currently available. Try again after review models are available.</p>
              ) : null}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={actions.walkthrough.onCloseDialog}>Cancel</Button>
              <Button
                disabled={actions.walkthrough.model === undefined || actions.walkthrough.catalogUnavailable || actions.walkthrough.busy}
                onClick={actions.walkthrough.onConfirm}
                data-testid="walkthrough-confirm"
              >
                {actions.walkthrough.busy ? "Generating…" : "Generate read-only walkthrough"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      </> : null}
      {walkthroughOpen && readyWalkthrough !== undefined ? (
        <NarrativeWalkthrough
          walkthrough={readyWalkthrough}
          {...(walkthroughCurrentSectionId === undefined ? {} : { currentSectionId: walkthroughCurrentSectionId })}
          reviewedSectionIds={walkthroughReviewedSectionIds}
          supportReviewed={walkthroughSupportReviewed}
          {...(props.fullPatch === undefined ? {} : { rawPatch: props.fullPatch })}
          {...(props.sourceSession === undefined ? {} : { sourceSession: props.sourceSession })}
          annotations={walkthroughAnnotations}
          preferences={preferences}
          actions={{
            onBackToFiles: () => {
              setWalkthroughOpen(false);
              actions.walkthrough?.onCloseTakeover?.();
              openWalkthroughButtonRef.current?.focus();
            },
            onMarkSectionReviewed: (sectionId) => {
              setWalkthroughReviewedSectionIds((current) => current.includes(sectionId) ? current : [...current, sectionId]);
              actions.walkthrough?.onMarkSectionReviewed?.(sectionId);
            },
            onMarkSupportReviewed: () => {
              setWalkthroughSupportReviewed(true);
              actions.walkthrough?.onMarkSupportReviewed?.();
            },
            onSelectSection: (sectionId) => {
              setWalkthroughCurrentSectionId(sectionId);
              actions.walkthrough?.onSelectSection?.(sectionId);
            },
          }}
        />
      ) : null}
      <div
        hidden={walkthroughOpen}
        className={`grid min-h-0 min-w-0 flex-1 grid-cols-1 ${reviewRailOpen ? "min-[1280px]:grid-cols-[13rem_minmax(0,1fr)]" : "min-[1280px]:grid-cols-[minmax(0,1fr)]"}`}
      >
        {reviewRailOpen ? (
          <aside
            id="review-navigation"
            aria-label="Review navigation"
            className="min-w-0 overflow-auto border-r bg-card p-2 max-[1279px]:hidden"
          >
            <h2 className="px-1 text-sm font-semibold">Changed files</h2>
            <div className="mt-3 h-[calc(100%-2rem)]">
              <PierreFileTree
                files={changedFiles}
                {...(selectedPath === undefined ? {} : { selectedPath })}
                {...(activePath === undefined ? {} : { activePath })}
                onSelect={selectFile}
              />
            </div>
          </aside>
        ) : null}
        <div
          data-review-scroll-container
          className="flex min-h-0 min-w-0 flex-col overflow-hidden"
        >
          <div
            data-review-workbench-toolbar
            className="sticky top-0 z-30 flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-background/95 px-2 py-1.5 backdrop-blur"
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <Button
                variant="ghost"
                size="icon-xs"
                className="max-[1279px]:hidden"
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
                <Tabs value={diffSurface} onValueChange={(value) => {
                  const nextSurface = value === "updates" ? "updates" : "full";
                  const nextPatch = nextSurface === "updates" ? props.comparisonPatch : props.fullPatch;
                  setDiffSurface(nextSurface);
                  const nextPath = nextPatch === undefined ? undefined : parseUnifiedPatch(nextPatch)[0]?.newPath;
                  setSelectedPath(nextPath);
                  setActivePath(nextPath);
                }}>
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
                  selectedFindingIndex >= props.result.findings.length - 1
                }
                onClick={() => navigateFinding(1)}
              >
                <ChevronRight />
              </Button>
              <Button variant="outline" size="sm" onClick={() => setFindingsOpen(true)}>
                Findings · {props.result.findings.length}
              </Button>
              <Dialog open={findingsOpen} onOpenChange={setFindingsOpen}>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Review findings</DialogTitle>
                    <DialogDescription>{props.result.summary}</DialogDescription>
                  </DialogHeader>
                  <div className="max-h-96 space-y-1 overflow-y-auto">
                    {props.result.findings.length === 0 ? <p className="text-sm text-muted-foreground">This review has no findings.</p> : props.result.findings.map((finding) => (
                      <Button
                        key={finding.id}
                        variant="ghost"
                        size="sm"
                        className="h-auto w-full justify-start whitespace-normal px-1 py-1 text-left"
                        aria-pressed={selectedFinding?.id === finding.id}
                        onClick={() => { selectFinding(finding); setFindingsOpen(false); }}
                      >
                        <span className="line-clamp-2">{finding.title}</span>
                      </Button>
                    ))}
                  </div>
                  <DialogFooter><Button variant="outline" onClick={() => setFindingsOpen(false)}>Close</Button></DialogFooter>
                </DialogContent>
              </Dialog>
              <Sheet open={navigationOpen} onOpenChange={setNavigationOpen}>
                <SheetTrigger
                  render={
                    <Button
                      variant="outline"
                      size="sm"
                      className="hidden max-[1279px]:inline-flex"
                    />
                  }
                >
                  Files
                </SheetTrigger>
                <SheetContent side="left">
                  <SheetHeader>
                    <SheetTitle>Files</SheetTitle>
                    <SheetDescription>
                      Navigate the stored patch.
                    </SheetDescription>
                  </SheetHeader>
                  <div className="min-h-0 overflow-auto p-4">
                    <PierreFileTree
                      files={changedFiles}
                      {...(selectedPath === undefined ? {} : { selectedPath })}
                      {...(activePath === undefined ? {} : { activePath })}
                      onSelect={(path) => {
                        selectFile(path);
                        setNavigationOpen(false);
                      }}
                    />
                  </div>
                </SheetContent>
              </Sheet>
            </div>
          </div>
          {selectedFinding === undefined ? null : (
            <div className="border-b bg-muted/20 px-3 py-2 text-sm" aria-label="Selected finding detail">
              <div className="flex flex-wrap items-center gap-2"><SeverityBadge severity={selectedFinding.severity} /><p className="font-medium">{selectedFinding.title}</p></div>
              <p className="mt-1 text-muted-foreground">{selectedFinding.explanation}</p>
              <p className="mt-1 text-xs text-muted-foreground">{selectedFinding.mappingStatus === "mapped" && selectedFinding.file !== undefined && selectedFinding.lineStart !== undefined ? `${selectedFinding.file} · ${selectedFinding.diffSide === "old" ? "old" : "new"} lines ${selectedFinding.lineStart}–${selectedFinding.lineEnd ?? selectedFinding.lineStart}` : "Unmapped evidence — inspect before drafting a comment"}</p>
            </div>
          )}
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
              onActiveFileChange={setActivePath}
              {...(selectedRange === undefined ? {} : { selectedRange })}
              annotations={reviewAnnotations}
              preferences={preferences}
              collapsedPaths={collapsedPaths}
              onPreferencesChange={updatePreferences}
              onCollapsedPathsChange={setCollapsedPaths}
              {...(props.sourceSession === undefined
                ? {}
                : { sourceSession: props.sourceSession })}
              {...(props.batch?.state._tag === "Local" && !writeBlocked && props.batchActions !== undefined ? { localCommentAuthoring: { enabled: true, onSave: props.batchActions.addInlineComment } } : {})}
            />
          )}
        </div>
      </div>
    </section>
  );
}

function severityLabel(severity: "P0" | "P1" | "P2" | "P3"): string {
  return `${severity} ${severity === "P0" ? "Critical" : severity === "P1" ? "High" : severity === "P2" ? "Medium" : "Low"}`;
}

function SeverityBadge({
  severity,
  className,
}: {
  readonly severity: "P0" | "P1" | "P2" | "P3";
  readonly className?: string;
}): React.JSX.Element {
  const severityClass = severity === "P0" || severity === "P1" ? "border-destructive text-foreground" : undefined;
  return <Badge variant="outline" className={[severityClass, className].filter((value) => value !== undefined).join(" ")} aria-label={severityLabel(severity)}>{severityLabel(severity)}</Badge>;
}
