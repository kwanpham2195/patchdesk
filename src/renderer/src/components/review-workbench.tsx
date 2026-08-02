import { useCallback, useEffect, useMemo, useState } from "react";

import { mapFindingLocation, parseUnifiedPatch } from "../../../domain/patch";
import { fingerprintPatchAnchor } from "../../../domain/review-anchor";
import { parseRepoRelativePath } from "../../../domain/ids";
import type { CommitDiffResponse, WorkbenchResponse } from "../renderer-contracts";
import { DiffWorkbench } from "./diff-workbench";
import type { LocalCommentAuthoring, LocalCommentLocation } from "./review-diff-view";
import { ReviewNavigator, type ReviewNavigatorSection } from "./review-navigator";
import { useCommitDiff } from "../hooks/use-commit-diff";
import { Button } from "./ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

function createCommitCommentAuthoring(base: LocalCommentAuthoring | undefined, fullPatch: string): LocalCommentAuthoring | undefined {
  if (base?.enabled !== true) return undefined;
  const files = parseUnifiedPatch(fullPatch);
  const map = (location: LocalCommentLocation) => mapFindingLocation(files, { file: location.path, lineStart: location.startLine, lineEnd: location.line, diffSide: location.side });
  return {
    enabled: true,
    canAuthor: (location) => map(location).mappingStatus === "mapped",
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
  readonly refresh: () => Promise<void>;
  readonly loadCommitDiff: (sha: string) => Promise<CommitDiffResponse>;
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

/** Renders the canonical Review projection. Optional work stays in typed slots. */
export function ReviewWorkbench({
  model,
  actions,
  slots,
}: {
  readonly model: WorkbenchResponse;
  readonly actions: ReviewWorkbenchActions;
  readonly slots: ReviewWorkbenchSlots;
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
  const [section, setSection] = useState<ReviewNavigatorSection>("files");
  const [selectedPath, setSelectedPath] = useState<string>();
  const [selectedFinding, setSelectedFinding] = useState<WorkbenchResponse["insights"]["analysis"]["retained"] extends infer Retained ? Retained extends { value: { findings: infer Findings } } ? Findings extends ReadonlyArray<infer Finding> ? Finding : never : never : never>();
  const [selectedCommitSha, setSelectedCommitSha] = useState<string>();
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
    if (finding.file !== undefined) setSelectedPath(finding.file);
  }, []);
  useEffect(() => {
    setSelectedCommitSha(undefined);
    setSelectedFinding(undefined);
    setSelectedPath(undefined);
    setSection("files");
  }, [model.revision.reviewedHeadSha]);
  const commitDiffState = useCommitDiff({ ...(selectedCommitSha === undefined ? {} : { selectedSha: selectedCommitSha }), revisionKey: model.revision.reviewedHeadSha, loadCommitDiff: actions.loadCommitDiff });
  const commitCommentAuthoring = useMemo(() => selectedCommitSha === undefined || model.fullPatch === undefined ? undefined : createCommitCommentAuthoring(actions.localCommentAuthoring, model.fullPatch), [actions.localCommentAuthoring, model.fullPatch, selectedCommitSha]);
  const commitDiff = commitDiffState._tag === "Ready" ? commitDiffState.projection : undefined;
  const commitDiffError = commitDiffState._tag === "Failed";
  const displayedPatch = commitDiff?.patch ?? model.fullPatch;
  const selectedFindingLocation = selectedFinding === undefined ? undefined : {
    ...(selectedFinding.file === undefined ? {} : { file: selectedFinding.file }),
    ...(selectedFinding.lineStart === undefined ? {} : { lineStart: selectedFinding.lineStart }),
    ...(selectedFinding.lineEnd === undefined ? {} : { lineEnd: selectedFinding.lineEnd }),
    ...(selectedFinding.diffSide === undefined ? {} : { diffSide: selectedFinding.diffSide }),
  };
  const commitHeader = selectedCommit === undefined || commitDiff === undefined ? undefined : {
    sha: selectedCommit.sha,
    title: selectedCommit.message.split("\n", 1)[0] ?? selectedCommit.sha.slice(0, 8),
    subtitle: `${selectedCommit.author} · ${selectedCommit.sha} · ${selectedCommit.authoredAt} · ${commitDiff.position} of ${commitDiff.total}`,
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Review workbench">
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {repository}#{model.session.key.prNumber} · {freshnessLabel} · snapshot {model.revision.reviewedHeadSha.slice(0, 12)}
          </p>
          <p className="sr-only" aria-live="polite">
            {hasUpdates ? "Remote updates are available. Refresh before publishing or merging." : "Review state is current."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2" aria-label="Pull request actions">
          <Button
            variant={hasUpdates ? "default" : "outline"}
            size="sm"
            disabled={terminal}
            onClick={() => void actions.refresh()}
          >
            {hasUpdates ? "Refresh updates" : "Refresh GitHub state"}
          </Button>
          <span className="rounded-md border px-2.5 py-1 text-sm">Checks · {checksLabel}</span>
        </div>
      </header>

      <Tabs defaultValue="files" className="flex min-h-0 flex-1">
        <TabsList aria-label="Review surfaces" className="mx-4 mt-3">
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="insights">Insights</TabsTrigger>
        </TabsList>
        <TabsContent value="files" className="min-h-0 flex-1" keepMounted>
          {model.fullPatch === undefined ? (
            <div className="p-6 text-sm text-muted-foreground">No patch is available for this Review session.</div>
          ) : (
            <div className="grid min-h-0 flex-1 min-[1100px]:grid-cols-[18rem_minmax(0,1fr)]">
              <ReviewNavigator
                patch={model.fullPatch}
                commits={model.commits}
                findings={findings}
                section={section}
                {...(selectedPath === undefined ? {} : { selectedPath })}
                {...(selectedCommitSha === undefined ? {} : { selectedCommitSha })}
                onSectionChange={selectSection}
                onFileSelect={(path) => { setSection("files"); setSelectedFinding(undefined); setSelectedPath(path); }}
                onFindingSelect={selectFinding}
                onCommitSelect={selectCommit}
              />
              <div className="min-h-0 min-w-0">
                {selectedCommitSha !== undefined && commitDiffState._tag === "Loading" ? (
                  <p className="p-6 text-sm text-muted-foreground" role="status">Loading commit diff…</p>
                ) : displayedPatch === undefined ? (
                  <p className="p-6 text-sm text-muted-foreground">No patch is available for this Review session.</p>
                ) : (
                  <DiffWorkbench
                    key={selectedCommitSha ?? model.revision.reviewedHeadSha}
                    patch={displayedPatch}
                    {...(selectedCommitSha === undefined ? { sourceSession: { profileId: model.session.key.profileId, sessionId: model.session.id } } : {})}
                    {...(selectedFindingLocation === undefined || selectedCommitSha !== undefined ? {} : { finding: selectedFindingLocation })}
                    {...(selectedPath === undefined || selectedCommitSha !== undefined ? {} : { controlledSelectedPath: selectedPath, onSelectedPathChange: setSelectedPath })}
                    {...(selectedCommitSha === undefined ? (actions.localCommentAuthoring === undefined ? {} : { localCommentAuthoring: actions.localCommentAuthoring }) : (commitCommentAuthoring === undefined ? {} : { localCommentAuthoring: commitCommentAuthoring }))}
                    hideFileNavigation
                    {...(commitHeader === undefined ? {} : { diffTitle: commitHeader.title, diffSubtitle: commitHeader.subtitle, copyValue: commitHeader.sha })}
                    className="min-h-0 h-full"
                    fillViewport={false}
                  />
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

      {slots.publishedFeedback}
      {slots.mergeAction}
      {slots.draftDock}

    </section>
  );
}
