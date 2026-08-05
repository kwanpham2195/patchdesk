import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, PanelLeftOpen } from "lucide-react";

import { mapFindingLocation, parseUnifiedPatch } from "../../../domain/patch";
import { fingerprintPatchAnchor } from "../../../domain/review-anchor";
import { parseGitHubHost, parseGitHubOwner, parseGitHubRepoName, parsePullRequestNumber, parseRepoRelativePath } from "../../../domain/ids";
import type { PullRequestRef } from "../../../domain/pull-request";
import type { CommitDiffResponse, WorkbenchResponse } from "../renderer-contracts";
import { openPullRequestExternalUrl, pullRequestPageUrl } from "../external-links";
import { DiffWorkbench } from "./diff-workbench";
import type { LocalCommentAuthoring, LocalCommentLocation, ReviewInlineAnnotation } from "./review-diff-view";
import { CanonicalReviewOverviewSheet, type CanonicalReviewOverview, type PullRequestOverviewMerge } from "./pr-overview-sheet";
import { ReviewNavigator, type ReviewNavigatorSection } from "./review-navigator";
import { useCommitDiff } from "../hooks/use-commit-diff";
import { loadReviewViewPreferences, saveReviewViewPreferences, type ReviewViewPreferences } from "../review-view-preferences";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

type ReviewFinding = NonNullable<WorkbenchResponse["insights"]["analysis"]["retained"]>["value"]["findings"][number];

function pullRequestExternalRef(model: WorkbenchResponse): PullRequestRef | undefined {
  const source = model.pullRequest?.ref ?? { host: model.session.key.host, owner: model.session.key.owner, repo: model.session.key.repo, number: model.session.key.prNumber };
  const host = parseGitHubHost(source.host);
  const owner = parseGitHubOwner(source.owner);
  const repo = parseGitHubRepoName(source.repo);
  const number = parsePullRequestNumber(source.number);
  if (host._tag === "err" || owner._tag === "err" || repo._tag === "err" || number._tag === "err") return undefined;
  return { host: host.value, owner: owner.value, repo: repo.value, number: number.value };
}

function initialFindings(model: WorkbenchResponse): ReadonlyArray<ReviewFinding> {
  const retained = model.insights.analysis.retained;
  if (model.insights.analysis.status !== "current" || retained === undefined || retained.sessionId !== model.session.id || retained.headSha !== model.revision.reviewedHeadSha) return [];
  return retained.value.findings.filter((finding) => finding.mappingStatus === "mapped");
}

function createCommitCommentAuthoring(base: LocalCommentAuthoring | undefined, fullPatch: string): LocalCommentAuthoring | undefined {
  if (base?.enabled !== true) return undefined;
  const files = parseUnifiedPatch(fullPatch);
  const map = (location: LocalCommentLocation) => mapFindingLocation(files, { file: location.path, lineStart: location.startLine, lineEnd: location.line, diffSide: location.side });
  return {
    enabled: true,
    canAuthor: (location) => map(location).mappingStatus === "mapped",
    onSelectionChange: (location) => {
      const mapped = map(location);
      if (mapped.mappingStatus !== "mapped" || mapped.path === undefined || mapped.side === undefined || mapped.line === undefined) return;
      base.onSelectionChange?.({ path: mapped.path, startLine: mapped.startLine ?? mapped.line, line: mapped.line, side: mapped.side });
    },
    onSave: async (input) => {
      const mapped = map(input);
      if (mapped.mappingStatus !== "mapped" || mapped.path === undefined || mapped.side === undefined || mapped.line === undefined) return;
      const parsedPath = parseRepoRelativePath(mapped.path);
      if (parsedPath._tag === "err") return;
      const startLine = mapped.startLine ?? mapped.line;
      const anchor = { path: parsedPath.value, startLine, line: mapped.line, side: mapped.side };
      const fingerprint = fingerprintPatchAnchor(fullPatch, anchor);
      await base.onSave({ ...input, path: mapped.path, startLine, line: mapped.line, side: mapped.side, ...(fingerprint === undefined ? {} : { fingerprint }) });
    },
  };
}

export type ReviewWorkbenchActions = {
  readonly detectUpdates: () => Promise<void>;
  readonly merge?: PullRequestOverviewMerge;
  readonly refresh: () => Promise<void>;
  readonly loadCommitDiff: (sha: string) => Promise<CommitDiffResponse>;
  readonly addFinding?: (finding: ReviewFinding) => Promise<void>;
  readonly dismissFinding?: (finding: ReviewFinding, reason: string) => Promise<void>;
  readonly localCommentAuthoring?: LocalCommentAuthoring;
  readonly reportNavigationState: (
    state: "clear" | "dirty_draft" | "write_pending",
  ) => void;
};

export type ReviewWorkbenchSlots = {
  readonly insights: React.ReactNode;
  readonly draftDock: React.ReactNode;
  readonly publishedFeedback: React.ReactNode;
  readonly mergeAction: React.ReactNode;
};

export type ReviewWorkbenchInitialState = {
  readonly section?: ReviewNavigatorSection | "insights";
  readonly selectedPath?: string;
  readonly selectedFindingId?: string;
  readonly selectedCommitSha?: string;
  readonly overviewOpen?: boolean;
  readonly draftExpanded?: boolean;
  readonly insightDetail?: "analysis" | "walkthrough";
};

const ReviewWorkbenchNavigationContext = createContext<(() => void) | undefined>(undefined);
const PublishedFeedbackNavigationContext = createContext<(() => void) | undefined>(undefined);

/** Lets an Insight reader return to the primary Files surface without coupling it to Tabs. */
// eslint-disable-next-line react-refresh/only-export-components -- Hook intentionally shares the workbench navigation context.
export function useReviewWorkbenchNavigation(): (() => void) | undefined {
  return useContext(ReviewWorkbenchNavigationContext);
}

/** Focuses the actual Published feedback region from confirmation actions. */
// eslint-disable-next-line react-refresh/only-export-components -- Hook intentionally shares workbench focus navigation.
export function usePublishedFeedbackNavigation(): (() => void) | undefined {
  return useContext(PublishedFeedbackNavigationContext);
}

/** Renders the canonical Review projection. Optional work stays in typed slots. */
export function ReviewWorkbench({
  model,
  actions,
  slots,
  initialState,
}: {
  readonly model: WorkbenchResponse;
  readonly actions: ReviewWorkbenchActions;
  readonly slots: ReviewWorkbenchSlots;
  readonly initialState?: ReviewWorkbenchInitialState;
}): React.JSX.Element {
  const terminal = model.review.status !== "open";
  const hasUpdates = model.revision.freshness === "updates_available";
  const freshnessLabel = hasUpdates
    ? "Updates available"
    : model.revision.freshness === "unavailable"
      ? "Remote state unavailable"
      : model.revision.freshness === "not_refreshed"
        ? "Not refreshed"
        : "Current";
  const checksLabel =
    model.checks.overall === "passing"
      ? "Passing"
      : model.checks.overall === "failing"
        ? "Failing"
        : model.checks.overall === "pending"
          ? "In progress"
          : model.checks.overall === "skipped"
            ? "Skipped"
            : "Unknown";
  const repository = `${model.session.key.owner}/${model.session.key.repo}`;
  const title = model.pullRequest?.title ?? `Pull request #${model.session.key.prNumber}`;
  const [overviewOpen, setOverviewOpen] = useState(initialState?.overviewOpen ?? false);
  const [navigatorVisible, setNavigatorVisible] = useState(true);
  const [preferences, setPreferences] = useState<ReviewViewPreferences>(() => loadReviewViewPreferences(model.session.key.profileId));
  const [section, setSection] = useState<ReviewNavigatorSection>(initialState?.section === "insights" ? "files" : initialState?.section ?? "files");
  const [primarySurface, setPrimarySurface] = useState<"files" | "insights">(initialState?.section === "insights" ? "insights" : "files");
  const [selectedPath, setSelectedPath] = useState<string | undefined>(initialState?.selectedPath);
  const [activePath, setActivePath] = useState<string | undefined>(initialState?.selectedPath);
  const [selectedFinding, setSelectedFinding] = useState<ReviewFinding | undefined>(() => {
    if (initialState?.selectedFindingId === undefined) return undefined;
    return initialFindings(model).find((finding) => finding.id === initialState.selectedFindingId);
  });
  const [selectedCommitSha, setSelectedCommitSha] = useState<string | undefined>(initialState?.selectedCommitSha);
  const feedbackRegionRef = useRef<HTMLDivElement>(null);
  const initializedRevision = useRef(model.revision.reviewedHeadSha);
  const retainedAnalysis = model.insights.analysis.retained;
  const analysisIsCurrent = model.insights.analysis.status === "current" && retainedAnalysis?.sessionId === model.session.id && retainedAnalysis.headSha === model.revision.reviewedHeadSha;
  const findings = analysisIsCurrent ? retainedAnalysis.value.findings.filter((finding) => finding.mappingStatus === "mapped") : [];
  const selectedCommit = selectedCommitSha === undefined ? undefined : model.commits.find((commit) => commit.sha === selectedCommitSha);
  const loadCommit = useCallback((sha: string): void => {
    setSection("commits");
    setSelectedFinding(undefined);
    setSelectedCommitSha(sha);
  }, []);
  const selectSection = useCallback((next: ReviewNavigatorSection): void => {
    setPrimarySurface("files");
    setSection(next);
    setSelectedFinding(undefined);
    if (next !== "commits") {
      setSelectedCommitSha(undefined);
    }
    if (next === "commits" && selectedCommitSha === undefined && model.commits[0] !== undefined) loadCommit(model.commits[0].sha);
  }, [loadCommit, model.commits, selectedCommitSha]);
  const selectCommit = useCallback((sha: string): void => {
    loadCommit(sha);
  }, [loadCommit]);
  const selectFinding = useCallback((finding: typeof findings[number]): void => {
    setSection("findings");
    setSelectedCommitSha(undefined);
    setSelectedFinding(finding);
    if (finding.file !== undefined) { setSelectedPath(finding.file); setActivePath(finding.file); }
  }, []);
  useEffect(() => {
    if (initializedRevision.current === model.revision.reviewedHeadSha) return;
    initializedRevision.current = model.revision.reviewedHeadSha;
    setSelectedCommitSha(undefined);
    setSelectedFinding(undefined);
    setSelectedPath(undefined);
    setActivePath(undefined);
    setSection("files");
  }, [model.revision.reviewedHeadSha]);
  const updatePreferences = useCallback((update: Partial<ReviewViewPreferences>): void => {
    setPreferences((current) => {
      const next = { ...current, ...update };
      saveReviewViewPreferences(model.session.key.profileId, update);
      return next;
    });
  }, [model.session.key.profileId]);
  const commitDiffState = useCommitDiff({ ...(selectedCommitSha === undefined ? {} : { selectedSha: selectedCommitSha }), revisionKey: model.revision.reviewedHeadSha, loadCommitDiff: actions.loadCommitDiff });
  const commitCommentAuthoring = useMemo(() => selectedCommitSha === undefined || model.fullPatch === undefined ? undefined : createCommitCommentAuthoring(actions.localCommentAuthoring, model.fullPatch), [actions.localCommentAuthoring, model.fullPatch, selectedCommitSha]);
  const commitDiff = commitDiffState._tag === "Ready" ? commitDiffState.projection : undefined;
  const annotations: ReadonlyArray<ReviewInlineAnnotation> = findings.flatMap((finding) => finding.file === undefined || finding.lineStart === undefined || finding.diffSide === undefined ? [] : [{ id: finding.id, path: finding.file, start: finding.lineStart, end: finding.lineEnd ?? finding.lineStart, side: finding.diffSide, severity: finding.severity, title: finding.title, explanation: finding.explanation }]);
  const commitDiffError = commitDiffState._tag === "Failed";
  const displayedPatch = commitDiff?.patch ?? model.fullPatch;
  const selectedFindingLocation = selectedFinding === undefined ? undefined : {
    ...(selectedFinding.file === undefined ? {} : { file: selectedFinding.file }),
    ...(selectedFinding.lineStart === undefined ? {} : { lineStart: selectedFinding.lineStart }),
    ...(selectedFinding.lineEnd === undefined ? {} : { lineEnd: selectedFinding.lineEnd }),
    ...(selectedFinding.diffSide === undefined ? {} : { diffSide: selectedFinding.diffSide }),
  };
  const externalPullRequest = pullRequestExternalRef(model);
  const overview: CanonicalReviewOverview = {
    repository,
    prNumber: model.session.key.prNumber,
    title,
    ...(model.pullRequest?.description === undefined ? {} : { description: model.pullRequest.description }),
    summary: retainedAnalysis?.value.summary ?? "No retained Analysis is available for this snapshot.",
    checks: { overall: model.checks.overall, checks: model.checks.checks.map((check) => ({ name: check.name, status: check.status, ...(check.conclusion === undefined ? {} : { conclusion: check.conclusion }) })) },
    comments: { ...(model.comments.complete === undefined ? {} : { complete: model.comments.complete }), threads: model.comments.threads.map((thread) => ({ id: thread.id, state: thread.state, comments: thread.comments.map((comment) => ({ author: comment.author, body: comment.body })) })) },
    publishedFeedback: model.publishedFeedback,
    mergeReadiness: model.mergeReadiness,
    mergeReasons: model.mergeReasons ?? [],
    ...(externalPullRequest === undefined ? {} : { pullRequest: externalPullRequest }),
    revision: { reviewedHeadSha: model.revision.reviewedHeadSha, ...(model.revision.currentHeadSha === undefined ? {} : { currentHeadSha: model.revision.currentHeadSha }), freshness: model.revision.freshness, refreshedAt: model.revision.refreshedAt },
    analysisStatus: model.insights.analysis.status,
    walkthroughStatus: model.insights.walkthrough.status,
    ...(model.review.status === "open" ? {} : { terminalState: model.review.status }),
  };
  const commitHeader = selectedCommit === undefined || commitDiff === undefined ? undefined : {
    sha: selectedCommit.sha,
    title: selectedCommit.message.split("\n", 1)[0] ?? selectedCommit.sha.slice(0, 8),
    subtitle: `${selectedCommit.author} · ${selectedCommit.sha.slice(0, 8)} · ${formatRelativeTime(selectedCommit.authoredAt)} · ${commitDiff.position} of ${commitDiff.total} · ${commitDiff.fileCount} files · +${commitDiff.additions}/-${commitDiff.deletions}`,
  };

  const navigateToFiles = useCallback((): void => {
    setPrimarySurface("files");
    setSection("files");
    setSelectedFinding(undefined);
    setSelectedCommitSha(undefined);
  }, []);
  const focusPublishedFeedback = useCallback((): void => {
    const feedbackRegion = feedbackRegionRef.current;
    const region = feedbackRegion?.querySelector<HTMLElement>('[aria-label="Published feedback"]') ?? feedbackRegion;
    if (region === null || region === undefined) return;
    const trigger = region.querySelector<HTMLButtonElement>("[data-published-feedback-trigger]");
    if (trigger?.getAttribute("aria-expanded") === "false") trigger.click();
    region.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    region.focus({ preventScroll: true });
  }, []);

  return (
    <ReviewWorkbenchNavigationContext.Provider value={navigateToFiles}>
    <PublishedFeedbackNavigationContext.Provider value={focusPublishedFeedback}>
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Review workbench">
      <header data-review-workbench-toolbar className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold" aria-label={title} title={title}>#{model.session.key.prNumber} {title}</h1>
          <p className="mt-1 text-xs text-muted-foreground" title={`${repository} · ${model.pullRequest?.baseBranch ?? "unknown"} ← ${model.pullRequest?.headBranch ?? "unknown"}`}>
            {repository} · {model.pullRequest?.baseBranch ?? "unknown"} ← {model.pullRequest?.headBranch ?? "unknown"} · {model.revision.reviewedHeadSha.slice(0, 8)} · {freshnessLabel} · refreshed {model.revision.refreshedAt}
          </p>
          <p className="sr-only" aria-live="polite">
            {hasUpdates ? "Remote updates are available. Refresh before publishing or merging." : "Review state is current."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2" aria-label="Pull request actions">
          <Button
            variant="outline"
            size="sm"
            disabled={externalPullRequest === undefined}
            onClick={() => {
              if (externalPullRequest !== undefined) void openPullRequestExternalUrl(pullRequestPageUrl(externalPullRequest).toString(), externalPullRequest);
            }}
          >
            <ExternalLink /> Open on GitHub
          </Button>
          <Button variant="outline" size="sm" onClick={() => setOverviewOpen(true)}>PR overview</Button>
          {terminal ? null : (
            <Button
              variant={hasUpdates ? "default" : "outline"}
              size="sm"
              onClick={() => void actions.refresh()}
            >
              {hasUpdates ? "Refresh updates" : "Refresh GitHub state"}
            </Button>
          )}
          <span className="rounded-md border px-2.5 py-1 text-sm">Checks · {checksLabel}</span>
        </div>
      </header>

      <Tabs value={primarySurface} onValueChange={(value) => { if (value === "files" || value === "insights") setPrimarySurface(value); }} className="flex min-h-0 flex-1 flex-col" data-review-workbench-primary>
        <TabsList aria-label="Review surfaces" className="mx-4 mt-3 shrink-0">
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="insights">Insights</TabsTrigger>
        </TabsList>
        <TabsContent value="files" className="min-h-0 flex-1 overflow-hidden" keepMounted>
          {model.fullPatch === undefined ? (
            <div className="p-6 text-sm text-muted-foreground">No patch is available for this Review session.</div>
          ) : (
            <div data-review-diff-layout={navigatorVisible ? "with-navigator" : "collapsed-navigator"} className={`grid h-full min-h-0 flex-1 ${navigatorVisible ? "min-[1100px]:grid-cols-[18rem_minmax(0,1fr)]" : "grid-cols-[2.75rem_minmax(0,1fr)]"}`}>
              {navigatorVisible ? <ReviewNavigator
                patch={model.fullPatch}
                commits={model.commits}
                findings={findings}
                section={section}
                {...(selectedPath === undefined ? {} : { selectedPath })}
                {...(selectedFinding === undefined ? {} : { selectedFindingId: selectedFinding.id })}
                {...(activePath === undefined ? {} : { activePath })}
                {...(selectedCommitSha === undefined ? {} : { selectedCommitSha })}
                onSectionChange={selectSection}
                onFileSelect={(path) => { setSection("files"); setSelectedFinding(undefined); setSelectedPath(path); setActivePath(path); }}
                onFindingSelect={selectFinding}
                onCommitSelect={selectCommit}
                onCollapse={() => setNavigatorVisible(false)}
              /> : (
                <div className="flex items-start justify-center pt-2">
                  <Tooltip>
                    <TooltipTrigger
                      render={<Button size="icon-sm" variant="outline" onClick={() => setNavigatorVisible(true)} aria-label="Show review navigator" />}
                    >
                      <PanelLeftOpen />
                    </TooltipTrigger>
                    <TooltipContent>Show review navigator</TooltipContent>
                  </Tooltip>
                </div>
              )}
              <div className="min-h-0 min-w-0">
                {selectedCommitSha !== undefined && commitDiffState._tag === "Loading" ? (
                  <p className="p-6 text-sm text-muted-foreground" role="status">Loading commit diff…</p>
                ) : displayedPatch === undefined ? (
                  <p className="p-6 text-sm text-muted-foreground">No patch is available for this Review session.</p>
                ) : (
                  <>
                  {selectedFinding !== undefined && selectedCommitSha === undefined && analysisIsCurrent ? (
                    <FindingFocusHeader
                      finding={selectedFinding}
                      {...(actions.addFinding === undefined ? {} : { onAdd: actions.addFinding })}
                      {...(actions.dismissFinding === undefined ? {} : { onDismiss: actions.dismissFinding })}
                    />
                  ) : null}
                  <DiffWorkbench
                    key={selectedCommitSha ?? model.revision.reviewedHeadSha}
                    patch={displayedPatch}
                    {...(selectedCommitSha === undefined ? { sourceSession: { profileId: model.session.key.profileId, sessionId: model.session.id } } : {})}
                    {...(selectedFindingLocation === undefined || selectedCommitSha !== undefined ? {} : { finding: selectedFindingLocation })}
                    {...(selectedPath === undefined || selectedCommitSha !== undefined ? {} : { controlledSelectedPath: selectedPath, onSelectedPathChange: (path: string) => { setSelectedPath(path); setActivePath(path); } })}
                    {...(selectedCommitSha === undefined ? { onActiveFileChange: (path: string) => setActivePath(path) } : {})}
                    {...(selectedCommitSha === undefined ? { annotations } : {})}
                    {...(selectedCommitSha === undefined ? (actions.localCommentAuthoring === undefined ? {} : { localCommentAuthoring: actions.localCommentAuthoring }) : (commitCommentAuthoring === undefined ? {} : { localCommentAuthoring: commitCommentAuthoring }))}
                    hideFileNavigation
                    {...(commitHeader === undefined ? {} : { diffTitle: commitHeader.title, diffSubtitle: commitHeader.subtitle, copyValue: commitHeader.sha })}
                    className="min-h-0 h-full"
                    fillViewport={false}
                    preferences={preferences}
                    onPreferencesChange={updatePreferences}
                  />
                  </>
                )}
                {commitDiffError ? <p role="alert" className="border-t px-4 py-2 text-sm text-destructive">This commit diff could not be loaded.</p> : null}
              </div>
            </div>
          )}
        </TabsContent>
        <TabsContent value="insights" className="min-h-0 flex-1 overflow-auto p-6" keepMounted>
          {slots.insights}
        </TabsContent>
      </Tabs>

      <div ref={feedbackRegionRef} tabIndex={-1} className="min-h-0 max-h-[min(25vh,16rem)] shrink-0 overflow-y-auto outline-none" data-review-workbench-feedback>
        {slots.publishedFeedback}
        {slots.mergeAction}
      </div>
      <div className="flex min-h-0 shrink-0 flex-col" data-review-workbench-draft-dock>{slots.draftDock}</div>

      <CanonicalReviewOverviewSheet open={overviewOpen} onOpenChange={setOverviewOpen} overview={overview} {...(actions.merge === undefined ? {} : { merge: actions.merge })} onRefresh={actions.refresh} />

    </section>
    </PublishedFeedbackNavigationContext.Provider>
    </ReviewWorkbenchNavigationContext.Provider>
  );
}

function FindingFocusHeader({
  finding,
  onAdd,
  onDismiss,
}: {
  readonly finding: ReviewFinding;
  readonly onAdd?: (finding: ReviewFinding) => Promise<void>;
  readonly onDismiss?: (finding: ReviewFinding, reason: string) => Promise<void>;
}): React.JSX.Element {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const disposition = finding.disposition ?? "open";
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(false);
    try { await action(); } catch { setError(true); } finally { setBusy(false); }
  };
  return (
    <header aria-label="Finding focus" className="flex flex-wrap items-center gap-3 border-b bg-card px-4 py-3">
      <Badge variant={finding.severity === "P0" || finding.severity === "P1" ? "destructive" : "outline"}>{finding.severity}</Badge>
      <div className="min-w-0 flex-1">
        <h2 className="truncate font-medium">{finding.title}</h2>
        <p className="text-xs text-muted-foreground">{finding.file ?? "General finding"}{finding.lineStart === undefined ? "" : `:${finding.lineStart}`} · {disposition}</p>
      </div>
      {error ? <p role="alert" className="text-xs text-destructive">Finding action could not be saved.</p> : null}
      {disposition === "open" && onAdd !== undefined ? <Button size="xs" variant="outline" disabled={busy} onClick={() => void run(() => onAdd(finding))}>Add to review</Button> : null}
      {disposition === "open" && onDismiss !== undefined ? <>
        <input aria-label="Dismiss reason" className="h-7 w-36 rounded border px-2 text-xs" placeholder="Dismiss reason" value={reason} onChange={(event) => setReason(event.target.value)} />
        <Button size="xs" variant="ghost" disabled={busy || reason.trim().length === 0} onClick={() => void run(() => onDismiss(finding, reason.trim()))}>Dismiss</Button>
      </> : null}
    </header>
  );
}

function formatRelativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  const seconds = Math.round((timestamp - Date.now()) / 1_000);
  const units: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [["year", 31_536_000], ["month", 2_592_000], ["day", 86_400], ["hour", 3_600], ["minute", 60]];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, divisor] of units) if (Math.abs(seconds) >= divisor) return formatter.format(Math.round(seconds / divisor), unit);
  return formatter.format(seconds, "second");
}
