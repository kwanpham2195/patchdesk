import { useEffect, useRef, useState } from "react";

import type { BaseBranchListResponse } from "../base-branch-contracts";
import {
  projectReadState,
  type GithubListReadState,
} from "../github-read-failure-copy";
import { SEARCH_DEBOUNCE_MS } from "./use-github-item-picker";

/** What a ready base-branch read carries on top of the shared permission. */
export type BaseBranchCandidates = {
  readonly current: string | undefined;
  readonly branches: ReadonlyArray<string>;
  readonly totalCount: number;
};

/** The picker's read: loading, a candidate list, or a named GitHub failure. */
export type BaseBranchReadState = GithubListReadState<BaseBranchCandidates>;

/** The search box's raw value, its setter, and the read for the settled search. */
type BaseBranchCandidateSearch = {
  readonly query: string;
  readonly setQuery: (query: string) => void;
  readonly readState: BaseBranchReadState;
};

const projectCandidates = (
  response: BaseBranchListResponse,
): BaseBranchCandidates => {
  const branches = response.branches ?? [];
  return {
    current: response.current,
    branches,
    totalCount: response.branchesTotalCount ?? branches.length,
  };
};

/**
 * Debounced, out-of-order-safe branch search for the base-branch dialog.
 * `useGithubItemPicker` does not fit: it owns optimistic membership toggles
 * over an attached set, and a base branch is one value confirmed through a dialog.
 */
export function useBaseBranchCandidates({
  open,
  fetchBaseBranches,
}: {
  /** Whether the dialog is open; each opening re-reads the list. */
  readonly open: boolean;
  readonly fetchBaseBranches: (
    query?: string,
  ) => Promise<BaseBranchListResponse | undefined>;
}): BaseBranchCandidateSearch {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [readState, setReadState] = useState<BaseBranchReadState>({
    _tag: "loading",
  });

  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedQuery(query),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [query]);

  // A later request always carries a higher id, so an earlier keystroke's response is dropped.
  const requestIdRef = useRef(0);
  useEffect(() => {
    if (!open) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setReadState({ _tag: "loading" });
    fetchBaseBranches(debouncedQuery === "" ? undefined : debouncedQuery)
      .then((response) => {
        if (requestIdRef.current !== requestId) return;
        setReadState(projectReadState(response, projectCandidates));
      })
      .catch(() => {
        if (requestIdRef.current === requestId)
          setReadState({ _tag: "github_read" });
      });
  }, [open, fetchBaseBranches, debouncedQuery]);

  return { query, setQuery, readState };
}
