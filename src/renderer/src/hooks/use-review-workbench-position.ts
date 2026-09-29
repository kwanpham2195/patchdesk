import { useCallback, useState } from "react";

import type { ReviewWorkbenchInitialState } from "../components/review-workbench";
import type { ReviewNavigatorSection } from "../components/review-navigator";
import type { SelectedDiffRange } from "../components/review-diff-view";
import type { WorkbenchResponse } from "../renderer-contracts";
import {
  sourceListsCommits,
  type WorkbenchReviewSource,
} from "../review-source";
import type {
  WorkbenchActiveTab,
  WorkbenchPosition,
  WorkbenchSection,
} from "../lib/screen-restore";

/** Where the workbench is pointed: tab, navigator section, file, commit, thread. */
export type ReviewWorkbenchPositionState = {
  readonly section: ReviewNavigatorSection;
  readonly activeTab: WorkbenchActiveTab;
  readonly selectedPath: string | undefined;
  readonly activePath: string | undefined;
  readonly setActivePath: (path: string | undefined) => void;
  readonly selectedCommitSha: string | undefined;
  readonly selectedThreadId: string | undefined;
  readonly setSelectedThreadId: (threadId: string | undefined) => void;
  readonly selectedRange: SelectedDiffRange | undefined;
  readonly setSelectedRange: (range: SelectedDiffRange | undefined) => void;
  /** Applies a visible navigation command and reports it for reload restore. */
  readonly commitWorkbenchPosition: (next: WorkbenchPosition) => void;
  readonly selectSection: (next: ReviewNavigatorSection) => void;
  readonly selectCommit: (sha: string) => void;
  /** A Browse row click: opens the file in the Diff and drops any thread or range mark. */
  readonly chooseFile: (path: string) => void;
  /** Counts `chooseFile` calls, so a click on the file already selected still scrolls to it (#660). */
  readonly fileChoiceCount: number;
};

/** A restored section the source has no tab for opens Browse (#557). */
function restoredSection(
  saved: WorkbenchSection | undefined,
  source: WorkbenchReviewSource,
): ReviewNavigatorSection {
  switch (saved) {
    case "commits":
      return sourceListsCommits(source) ? saved : "files";
    case "threads":
      return source.kind === "pull_request" ? saved : "files";
    case "notes":
      return source.kind === "pull_request" ? "files" : saved;
    case "files":
    case "insights":
    case undefined:
      return "files";
  }
}

/** Owns the workbench position and resets it when the reviewed revision moves. */
export function useReviewWorkbenchPosition({
  model,
  initialState,
  onPositionCommitted,
}: {
  readonly model: Pick<WorkbenchResponse, "commits" | "revision" | "session">;
  readonly initialState?: ReviewWorkbenchInitialState;
  readonly onPositionCommitted?: (state: WorkbenchPosition) => void;
}): ReviewWorkbenchPositionState {
  const [section, setSection] = useState<ReviewNavigatorSection>(() =>
    restoredSection(initialState?.section, model.session.key.source),
  );
  // A Review with no saved position opens on Conversation: the description and
  // the discussion are what a reviewer reads before any code. A Review that
  // carries a position reopens exactly where it was left, so this fallback
  // only decides the very first visit. A local Review has no Conversation.
  const openingTab: WorkbenchActiveTab =
    model.session.key.source.kind === "pull_request" ? "conversation" : "diff";
  const [activeTab, setActiveTab] = useState<WorkbenchActiveTab>(
    initialState?.activeTab ??
      (initialState?.section === "insights" ? "insights" : openingTab),
  );
  const [selectedPath, setSelectedPath] = useState<string | undefined>(
    initialState?.selectedPath,
  );
  const [activePath, setActivePath] = useState<string | undefined>(
    initialState?.selectedPath,
  );
  const [selectedCommitSha, setSelectedCommitSha] = useState<
    string | undefined
  >(initialState?.selectedCommitSha);
  // Session-local: the last thread row chosen in the Threads section, and the
  // diff range it anchors to. Not part of restored position (screen-restore's
  // schema stays as widened in slice B) — a stale mark on reopen would be
  // worse than none.
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>(
    undefined,
  );
  const [selectedRange, setSelectedRange] = useState<
    SelectedDiffRange | undefined
  >(undefined);
  const commitWorkbenchPosition = useCallback(
    (next: WorkbenchPosition): void => {
      setActiveTab(next.activeTab);
      setSection(next.section);
      setSelectedPath(next.selectedPath);
      const position = { activeTab: next.activeTab, section: next.section };
      onPositionCommitted?.(
        next.selectedPath === undefined || next.selectedPath.endsWith("/")
          ? position
          : { ...position, selectedPath: next.selectedPath },
      );
    },
    [onPositionCommitted],
  );
  const [previousRevision, setPreviousRevision] = useState(
    model.revision.reviewedHeadSha,
  );
  // A section, a commit slice included, is a way into the diff, not a file
  // choice. Dropping the path hands the selection back to DiffWorkbench's
  // uncontrolled fallback, and the header, the tree and the pane stop naming
  // one file (#535).
  const commitSection = useCallback(
    (next: ReviewNavigatorSection): void => {
      const position: WorkbenchPosition = { activeTab: "diff", section: next };
      commitWorkbenchPosition(
        selectedPath === undefined ? position : { ...position, selectedPath },
      );
    },
    [commitWorkbenchPosition, selectedPath],
  );
  const loadCommit = useCallback(
    (sha: string): void => {
      commitSection("commits");
      setSelectedCommitSha(sha);
      setSelectedThreadId(undefined);
      setSelectedRange(undefined);
    },
    [commitSection],
  );
  const selectSection = useCallback(
    (next: ReviewNavigatorSection): void => {
      commitSection(next);
      if (next !== "commits") {
        setSelectedCommitSha(undefined);
      }
      if (
        next === "commits" &&
        selectedCommitSha === undefined &&
        model.commits[0] !== undefined
      )
        loadCommit(model.commits[0].sha);
    },
    [commitSection, loadCommit, model.commits, selectedCommitSha],
  );
  const selectCommit = useCallback(
    (sha: string): void => {
      loadCommit(sha);
    },
    [loadCommit],
  );
  const [fileChoiceCount, setFileChoiceCount] = useState(0);
  const chooseFile = useCallback(
    (path: string): void => {
      commitWorkbenchPosition({
        activeTab: "diff",
        section: "files",
        selectedPath: path,
      });
      setActivePath(path);
      setSelectedThreadId(undefined);
      setSelectedRange(undefined);
      setFileChoiceCount((count) => count + 1);
    },
    [commitWorkbenchPosition],
  );
  if (previousRevision !== model.revision.reviewedHeadSha) {
    setPreviousRevision(model.revision.reviewedHeadSha);
    setSelectedCommitSha(undefined);
    setSelectedPath(undefined);
    setActivePath(undefined);
    setSection("files");
    setActiveTab(openingTab);
  }
  return {
    section,
    activeTab,
    selectedPath,
    activePath,
    setActivePath,
    selectedCommitSha,
    selectedThreadId,
    setSelectedThreadId,
    selectedRange,
    setSelectedRange,
    commitWorkbenchPosition,
    selectSection,
    selectCommit,
    chooseFile,
    fileChoiceCount,
  };
}
