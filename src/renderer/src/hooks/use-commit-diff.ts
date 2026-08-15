import { useEffect, useRef, useState } from "react";

import type { CommitDiffResponse } from "../renderer-contracts";
import { useLatestCommitted } from "./use-latest-committed";

export type CommitDiffState =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Loading"; readonly sha: string }
  | { readonly _tag: "Ready"; readonly projection: CommitDiffResponse }
  | { readonly _tag: "Failed"; readonly sha: string };

export type CommitDiffLoader = (sha: string) => Promise<CommitDiffResponse>;

/** Loads one commit diff while suppressing responses for old selections or revisions. */
export function useCommitDiff({
  selectedSha,
  revisionKey,
  loadCommitDiff,
}: {
  readonly selectedSha?: string;
  readonly revisionKey: string;
  readonly loadCommitDiff: CommitDiffLoader;
}): CommitDiffState {
  const loader = useLatestCommitted(loadCommitDiff);
  const token = useRef(0);
  const previousRevision = useRef(revisionKey);
  const [state, setState] = useState<CommitDiffState>({ _tag: "Idle" });
  useEffect(() => {
    const requestToken = token.current + 1;
    token.current = requestToken;
    const revisionChanged = previousRevision.current !== revisionKey;
    previousRevision.current = revisionKey;
    if (revisionChanged || selectedSha === undefined) {
      setState({ _tag: "Idle" });
      return () => {
        token.current += 1;
      };
    }

    const sha = selectedSha;
    setState({ _tag: "Loading", sha });
    void loader
      .current(sha)
      .then((projection) => {
        if (token.current !== requestToken) return;
        if (projection.commit.sha !== sha) {
          setState({ _tag: "Failed", sha });
          return;
        }
        setState({ _tag: "Ready", projection });
      })
      .catch(() => {
        if (token.current !== requestToken) return;
        setState({ _tag: "Failed", sha });
      });
    return () => {
      if (token.current === requestToken) token.current += 1;
    };
  }, [loader, revisionKey, selectedSha]);

  return state;
}
