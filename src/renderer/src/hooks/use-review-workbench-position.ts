import { useCallback, useState } from "react";

import type { ReviewWorkbenchInitialState } from "../components/review-workbench";
import type { ReviewNavigatorSection } from "../components/review-navigator";
import type { SelectedDiffRange } from "../components/review-diff-view";
import type { WorkbenchResponse } from "../renderer-contracts";
import type {
  WorkbenchActiveTab,
  WorkbenchPosition,
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
};

/** Owns the workbench position and resets it when the reviewed revision moves. */
export function useReviewWorkbenchPosition({
  model,
  initialState,
  onPositionCommitted,
}: {
  readonly model: Pick<WorkbenchResponse, "commits" | "revision">;
  readonly initialState?: ReviewWorkbenchInitialState;
  readonly onPositionCommitted?: (state: WorkbenchPosition) => void;
}): ReviewWorkbenchPositionState {
  const [section, setSection] = useState<ReviewNavigatorSection>(
    initialState?.section === "insights"
      ? "files"
      : (initialState?.section ?? "files"),
  );
  const [activeTab, setActiveTab] = useState<WorkbenchActiveTab>(
    initialState?.activeTab ??
      (initialState?.section === "insights" ? "insights" : "diff"),
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
  const loadCommit = useCallback(
    (sha: string): void => {
      commitWorkbenchPosition({ activeTab: "diff", section: "commits" });
      setSelectedCommitSha(sha);
      setSelectedThreadId(undefined);
      setSelectedRange(undefined);
    },
    [commitWorkbenchPosition],
  );
  const selectSection = useCallback(
    (next: ReviewNavigatorSection): void => {
      commitWorkbenchPosition({ activeTab: "diff", section: next });
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
    [commitWorkbenchPosition, loadCommit, model.commits, selectedCommitSha],
  );
  const selectCommit = useCallback(
    (sha: string): void => {
      loadCommit(sha);
    },
    [loadCommit],
  );
  if (previousRevision !== model.revision.reviewedHeadSha) {
    setPreviousRevision(model.revision.reviewedHeadSha);
    setSelectedCommitSha(undefined);
    setSelectedPath(undefined);
    setActivePath(undefined);
    setSection("files");
    setActiveTab("conversation");
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
  };
}
