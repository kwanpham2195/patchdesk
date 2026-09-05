import { useCallback, useState } from "react";

import type { ReviewDiffSourceSession } from "./use-review-diff-hydration";

type MarkdownPreviewState = {
  readonly patch: string;
  readonly profileId: string | undefined;
  readonly sessionId: string | undefined;
  readonly paths: ReadonlySet<string>;
};

type MarkdownPreviewPaths = {
  readonly paths: ReadonlySet<string>;
  readonly setPreview: (path: string, active: boolean) => void;
};

const NO_MARKDOWN_PREVIEWS: ReadonlySet<string> = new Set();

/** Owns independent Markdown preview modes and invalidates them with the represented source. */
export function useMarkdownPreviewPaths(
  patch: string,
  sourceSession: ReviewDiffSourceSession | undefined,
): MarkdownPreviewPaths {
  const [state, setState] = useState<MarkdownPreviewState>(() => ({
    patch,
    profileId: sourceSession?.profileId,
    sessionId: sourceSession?.sessionId,
    paths: NO_MARKDOWN_PREVIEWS,
  }));
  const sameSource =
    state.patch === patch &&
    state.profileId === sourceSession?.profileId &&
    state.sessionId === sourceSession?.sessionId;
  const setPreview = useCallback(
    (path: string, active: boolean): void => {
      setState((current) => {
        const currentSource =
          current.patch === patch &&
          current.profileId === sourceSession?.profileId &&
          current.sessionId === sourceSession?.sessionId;
        const paths = new Set(currentSource ? current.paths : []);
        if (active) paths.add(path);
        else paths.delete(path);
        return {
          patch,
          profileId: sourceSession?.profileId,
          sessionId: sourceSession?.sessionId,
          paths,
        };
      });
    },
    [patch, sourceSession?.profileId, sourceSession?.sessionId],
  );
  return { paths: sameSource ? state.paths : NO_MARKDOWN_PREVIEWS, setPreview };
}
