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
import { ReviewChecks } from "./review-checks";
import { ReviewDiffView, type ReviewInlineAnnotation } from "./review-diff-view";
import { ReviewBatchPanel, type ReviewBatchPanelActions } from "./review-batch-panel";
import {
  MergeConfirmationDialog,
  type MergeMethod,
} from "./merge-confirmation-dialog";
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
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
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
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
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
  const mappedFindingCount = props.result.findings.filter(
    (finding) => finding.mappingStatus === "mapped",
  ).length;
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
  const updateWritePending = (pending: boolean): void => actions.reportNavigationState(pending ? "write_pending" : "clear");

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
      <div
        className={`grid min-h-0 min-w-0 flex-1 grid-cols-1 ${reviewRailOpen ? "min-[1280px]:grid-cols-[13rem_minmax(0,1fr)]" : "min-[1280px]:grid-cols-[minmax(0,1fr)]"} ${reviewRailOpen && inspectorOpen ? "min-[1280px]:grid-cols-[13rem_minmax(0,1fr)_21rem]" : inspectorOpen ? "min-[1280px]:grid-cols-[minmax(0,1fr)_21rem]" : ""}`}
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
              annotations={inlineFindingAnnotations}
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
            className="min-w-0 overflow-hidden border-t bg-card min-[1280px]:col-span-1 min-[1280px]:border-l min-[1280px]:border-t-0"
          >
            <ScrollArea className="h-auto min-[1280px]:h-[calc(100vh-8.5rem)]">
              <div className="min-w-0 space-y-5 p-4 [overflow-wrap:anywhere] [&_*]:min-w-0">
                <section>
                  <h2 className="font-semibold">Review result</h2>
                  <p className="mt-2 break-words text-sm text-muted-foreground">
                    {props.result.summary}
                  </p>
                  <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-md border p-2"><dt className="text-muted-foreground">Freshness</dt><dd className="mt-1 font-medium">{freshness === "fresh" ? "Current head confirmed" : freshness === "stale" ? "Head changed" : "Current head unavailable"}</dd></div>
                    <div className="rounded-md border p-2"><dt className="text-muted-foreground">Findings</dt><dd className="mt-1 font-medium">{props.result.findings.length} finding{props.result.findings.length === 1 ? "" : "s"} · {mappedFindingCount} mapped</dd></div>
                    <div className="rounded-md border p-2"><dt className="text-muted-foreground">Reviewed SHA</dt><dd className="mt-1 font-mono">{(props.reviewedHeadSha ?? "unavailable").slice(0, 12)}</dd></div>
                    <div className="rounded-md border p-2"><dt className="text-muted-foreground">Lifecycle</dt><dd className="mt-1 font-medium">Local only until you confirm a GitHub write</dd></div>
                  </dl>
                  {props.result.findings.length === 0 ? null : (
                    <div className="mt-3 border-t pt-3">
                      <h3 className="text-sm font-medium">Findings</h3>
                      <div className="mt-2 space-y-1">
                        {props.result.findings.map((finding) => (
                          <Button
                            key={finding.id}
                            variant="ghost"
                            size="sm"
                            className="h-auto w-full justify-start whitespace-normal px-1 py-1 text-left"
                            aria-pressed={selectedFinding?.id === finding.id}
                            onClick={() => selectFinding(finding)}
                          >
                            <span className="line-clamp-2">{finding.title}</span>
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}
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
                {props.batchActions === undefined ? null : (
                  <ReviewBatchPanel
                    {...(props.batch === undefined ? {} : { batch: props.batch })}
                    {...(selectedFinding === undefined ? {} : { selectedFinding })}
                    writeBlocked={writeBlocked}
                    actions={props.batchActions}
                  />
                )}
                {props.merge === undefined ? null : (
                  <>
                    <Separator />
                    <section>
                      <h2 className="mb-3 font-semibold">Merge</h2>
                      {writeBlocked ? (
                        <p className="text-sm text-muted-foreground">
                          Merge remains unavailable until the head is fresh.
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
                          {props.batchActions === undefined || props.batch?.state._tag !== "Local" ? null : (
                            <ThreadBatchActions
                              threadId={thread.id}
                              state={thread.state}
                              onReply={async (body) => { await props.batchActions?.addThreadReply(thread.id, body); }}
                              onState={async (action) => { await props.batchActions?.setThreadState(thread.id, action); }}
                            />
                          )}
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

function ThreadBatchActions({
  threadId,
  state,
  onReply,
  onState,
}: {
  readonly threadId: string;
  readonly state: "open" | "resolved" | "outdated" | "unknown";
  readonly onReply: (body: string) => Promise<void>;
  readonly onState: (action: "resolve" | "reopen") => Promise<void>;
}): React.JSX.Element {
  const [body, setBody] = useState("");
  return <div className="mt-2 border-t pt-2"><Textarea aria-label={`Reply to thread ${threadId}`} value={body} onChange={(event) => setBody(event.target.value)} placeholder="Reply in the local review batch" /><div className="mt-2 flex flex-wrap gap-2"><Button size="xs" variant="outline" disabled={body.trim().length === 0} onClick={() => { void onReply(body).then(() => setBody("")); }}>Add reply</Button><Button size="xs" variant="ghost" onClick={() => void onState(state === "resolved" ? "reopen" : "resolve")}>{state === "resolved" ? "Reopen thread" : "Resolve thread"}</Button></div></div>;
}

function severityLabel(severity: "P0" | "P1" | "P2" | "P3"): string {
  return `${severity} ${severity === "P0" ? "Critical" : severity === "P1" ? "High" : severity === "P2" ? "Medium" : "Low"}`;
}

function confidenceText(confidence: "high" | "medium" | "low"): string {
  return `${confidence} confidence`;
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
